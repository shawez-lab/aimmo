import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, location, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agent, propriétaire et clés inventés. Le 11 janvier 2027 est un lundi ; hiver : Paris = UTC + 1.
const BASE = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-w10-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', conformite: 'test-cle-w10-conf-bbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
type Who = keyof typeof KEYS;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-01-11T09:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const owner = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: 'Exemple' })).id;
  await store.addIdentifier({ networkId: network, personId: owner, kind: 'email', value: 'lea.exemple@example.test' });
  await store.addConsent({ networkId: network, personId: owner, purpose: location.RENTAL_UPDATE_PURPOSE, channel: 'email', proof: 'mandat de location test', givenAt: new Date('2027-01-01T00:00:00.000Z') });
  const home = (await store.createProperty({ networkId: network, agentId: alex, reference: 'L-1', kind: 'home', postalCode: '21000' })).id;
  const refs = new Set<string>();
  const pieces = { has: async (r: string) => refs.has(r) };
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex }, conformite: { role: 'compliance', userId: 'conf-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const config = (withPieces: boolean): ApiConfig => ({ db, apiKeys, mode: 'essai', now, ...(withPieces ? { pieces } : {}) });
  const call = async (who: Who, method: string, path: string, body?: unknown, withPieces = true) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config(withPieces));
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string } };
  };
  return { db, journal, network, alex, owner, home, call, now };
}

describeWithSqlite('W10 · M15 branché dans le socle', () => {
  it('[R16] [R100] les routes de M15 sont servies par le socle, le rôle contrôlé avant le corps, fermées sans stockage des pièces', async () => {
    const t = await setup();
    const created = await t.call('alex', 'POST', '/location', { propertyId: t.home, ownerPersonId: t.owner });
    expect(created).toMatchObject({ status: 200, body: { ok: true } });
    const id = created.body.data.listingId as string;
    const facts = { furnished: false, rentCents: 65_000, chargesCents: 5_000, livingAreaHundredths: 4_250, energyClass: 'G', finalEnergyKwh: 430, buildYear: 1985, electricityOver15: false, mainRoomHundredths: 1_800, ceilingHeightCm: 250, localRules: { reference: 'Règlement sanitaire départemental, art. 40', checkedOn: '2027-01-04', compliant: true }, firstLetting: true, gas: 'aucune', leaseStart: '2027-09-01' };
    expect((await t.call('alex', 'POST', `/location/${id}/faits`, facts)).status).toBe(200);
    expect(await t.call('alex', 'POST', `/location/${id}/controle`)).toMatchObject({ status: 200, body: { ok: true, data: { decision: 'bloque' } } });
    // La conformité lit, n'écrit pas : refusée avant la lecture du corps, et le refus au journal [R16].
    expect(await t.call('conformite', 'POST', `/location/${id}/faits`, 'pas du json')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect((await t.journal.all()).some((e) => e.type === 'acces.refuse' && e.data['kind'] === 'location.faits')).toBe(true);
    expect((await t.call('conformite', 'GET', `/location/${id}/echeances`)).status).toBe(200);
    // Sans stockage des pièces, la location est fermée ; une adresse inconnue reste inconnue.
    expect(await t.call('alex', 'GET', `/location/${id}`, undefined, false)).toMatchObject({ status: 503, body: { code: 'pieces_not_configured' } });
    expect((await t.call('alex', 'GET', '/location-inconnue')).status).toBe(404);

    // Le planificateur passe l'échéance préparée par le contrôle central, en essai, une seule fois.
    await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    const box = await t.db.all<{ person_id: string; body: string }>('SELECT m.person_id, m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id');
    expect(box).toEqual([{ person_id: t.owner, body: expect.stringContaining('Bonjour Léa, votre logement est classé G') }]);
    expect(await t.db.all('SELECT kind, status FROM rental_sends')).toEqual([{ kind: 'echeance', status: 'sent' }]);
  });
});
