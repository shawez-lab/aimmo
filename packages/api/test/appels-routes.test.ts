import { expect, it } from 'vitest';
import { Acces, FicheAgent, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { MAX_APPEL_BODY_BYTES, appelsRoutes, type AppelsServices } from '../src/appels.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Un mardi, 11 h à Paris. Tout est inventé.
const START = Date.parse('2027-06-08T09:00:00.000Z');

async function setup() {
  const now = (): Date => new Date(START);
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau Essai');
  const a = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const b = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  const alex: Viewer = { role: 'agent', userId: a.id, networkId: network.id };
  const sam: Viewer = { role: 'agent', userId: b.id, networkId: network.id };
  const person = await store.createPerson({ networkId: network.id, agentId: a.id, firstName: 'Client' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: '06 00 00 00 02' });
  await store.addConsent({ networkId: network.id, personId: person.id, purpose: 'prospecting', channel: 'phone', proof: 'accord de test', givenAt: new Date(START - 86_400_000) });
  const s: AppelsServices = { db, acces, journal, now };
  const call = async (viewer: Viewer, path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
    const route = appelsRoutes()[0]!;
    const match = route.pattern.exec(path);
    if (!match) throw new Error(`route absente : ${path}`);
    const request = new Request(`https://api.example.test/v1${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const response = await route.handle(s, viewer, match.slice(1), request);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { db, journal, network, person, alex, sam, call, fiche: new FicheAgent(db, acces, { now }), path: `/fiches/${person.id}/appels` };
}

describeWithSqlite('AC09 · route des appels notés', () => {
  it('[R204] l’agent note un refus, la fiche ferme l’appel ; rien n’est envoyé', async () => {
    const t = await setup();
    const noted = await t.call(t.alex, t.path, { outcome: 'refused' });
    expect(noted).toMatchObject({ status: 200, body: { ok: true, sent: false, data: { already: false } } });
    const read = await t.fiche.read(t.alex, t.person.id);
    expect(read.ok && read.value).toMatchObject({ call: null, callRefusal: 'refused_recently' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox')).toEqual({ n: 0 });
  });

  it('[R16] seul l’agent de la fiche ou la direction ; le refus de rôle va au journal, avant de lire le corps', async () => {
    const t = await setup();
    expect((await t.call(t.sam, t.path, { outcome: 'called' })).status).toBe(403);
    expect((await t.call({ role: 'compliance', userId: 'c', networkId: t.network.id }, t.path, 'pas du json')).body).toMatchObject({ rule: 'R16', code: 'role' });
    expect(JSON.stringify(await t.journal.all())).toContain('acces.refuse');
    expect((await t.call(t.alex, '/fiches/inconnue/appels', { outcome: 'called' })).status).toBe(404);
  });

  it('corps illisible, trop gros ou avec un champ de plus : refusé, rien de rangé', async () => {
    const t = await setup();
    expect((await t.call(t.alex, t.path, 'pas du json')).body.code).toBe('invalid_body');
    expect((await t.call(t.alex, t.path, { outcome: 'called' }, { 'content-type': 'text/plain' })).body.code).toBe('invalid_body');
    expect((await t.call(t.alex, t.path, { outcome: 'x'.repeat(MAX_APPEL_BODY_BYTES) })).body.code).toBe('invalid_body');
    expect((await t.call(t.alex, t.path, { outcome: 'called', at: '2020' })).body.code).toBe('unexpected_field');
    expect((await t.call(t.alex, t.path, { outcome: 'autre' })).body.code).toBe('bad_outcome');
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM call_notes')).toEqual({ n: 0 });
  });
});
