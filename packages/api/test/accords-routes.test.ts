import { expect, it } from 'vitest';
import { Acces, FicheAgent, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { MAX_ACCORD_BODY_BYTES, accordsRoutes, type AccordsServices } from '../src/accords.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé.
const START = Date.parse('2027-06-08T08:00:00.000Z');
const NOTE = 'Accord donné de vive voix au rendez-vous, pour suivre sa vente par mail.';
const BODY = { purpose: 'suivi_vente', channel: 'email', proof: NOTE, givenAt: new Date(START - 3600_000).toISOString() };

async function setup() {
  let clock = START;
  const now = (): Date => new Date((clock += 1000));
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau Essai');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  const alex: Viewer = { role: 'agent', userId: alexAgent.id, networkId: network.id };
  const sam: Viewer = { role: 'agent', userId: samAgent.id, networkId: network.id };
  const person = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: 'Client', lastName: 'Inventé' });
  const s: AccordsServices = { store, acces, journal, now };
  const call = async (viewer: Viewer, path: string, body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
    for (const route of accordsRoutes()) {
      const match = route.pattern.exec(path);
      if (!match) continue;
      const request = new Request(`https://api.example.test/v1${path}`, { method: 'POST', headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
      const response = await route.handle(s, viewer, match.slice(1), request);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    }
    throw new Error(`route absente : ${path}`);
  };
  return { db, store, acces, network, person, alex, sam, call, fiche: new FicheAgent(db, acces, { now }) };
}

describeWithSqlite('AC01 · routes des accords', () => {
  it('[R03] [R202] l’agent note puis retire l’accord ; la fiche donne son identifiant pour le retirer', async () => {
    const t = await setup();
    const noted = await t.call(t.alex, `/fiches/${t.person.id}/accords`, BODY);
    expect(noted.status).toBe(200);
    expect(noted.body).toMatchObject({ ok: true, sent: false, data: { already: false } });
    const read = await t.fiche.read(t.alex, t.person.id);
    expect(read.ok && read.value.consents[0]).toMatchObject({ id: noted.body.data.consentId, purpose: 'suivi_vente', channel: 'email', withdrawnAt: null });
    expect(JSON.stringify(read)).not.toContain('vive voix');

    const taken = await t.call(t.alex, `/fiches/${t.person.id}/accords/${noted.body.data.consentId}/retrait`);
    expect(taken.status).toBe(200);
    expect(taken.body.data.withdrawnAt).toBeTruthy();
  });

  it('[R16] un rôle refusé l’est avant la lecture du corps, et va au journal ; un autre agent reçoit 403', async () => {
    const t = await setup();
    const compliance: Viewer = { role: 'compliance', userId: 'c-1', networkId: t.network.id };
    expect((await t.call(compliance, `/fiches/${t.person.id}/accords`, 'pas du json')).status).toBe(403);
    const refused = await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE type = 'acces.refuse' AND data LIKE '%R16%'");
    expect(Number(refused!.n)).toBeGreaterThan(0);
    expect((await t.call(t.sam, `/fiches/${t.person.id}/accords`, BODY)).status).toBe(403);
    expect((await t.call(t.sam, `/fiches/${t.person.id}/accords/abc/retrait`)).status).toBe(403);
    expect((await t.call(t.alex, '/fiches/inconnue/accords', BODY)).status).toBe(404);
  });

  it('[R04] [R202] les refus portent leur règle et leur code', async () => {
    const t = await setup();
    expect((await t.call(t.alex, `/fiches/${t.person.id}/accords/inconnu/retrait`)).status).toBe(404);
    expect(await t.call(t.alex, `/fiches/${t.person.id}/accords`, { ...BODY, purpose: 'appointment' })).toMatchObject({ status: 400, body: { rule: 'R202', code: 'bad_purpose' } });
    await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'stop', notedAt: new Date(START) });
    expect(await t.call(t.alex, `/fiches/${t.person.id}/accords`, BODY)).toMatchObject({ status: 409, body: { rule: 'R04', code: 'stopped' } });
  });

  it('corps illisible, trop gros ou avec un champ de plus : refusé, rien de rangé', async () => {
    const t = await setup();
    const path = `/fiches/${t.person.id}/accords`;
    expect((await t.call(t.alex, path, 'pas du json')).body.code).toBe('invalid_body');
    expect((await t.call(t.alex, path, '[1]')).body.code).toBe('invalid_body');
    expect((await t.call(t.alex, path, BODY, { 'content-type': 'text/plain' })).body.code).toBe('invalid_body');
    expect((await t.call(t.alex, path, { ...BODY, proof: 'x'.repeat(MAX_ACCORD_BODY_BYTES) })).body.code).toBe('invalid_body');
    expect((await t.call(t.alex, path, { ...BODY, personId: 'autre' })).body.code).toBe('unexpected_field');
    expect(await t.store.listConsents(t.person.id)).toHaveLength(0);
  });
});
