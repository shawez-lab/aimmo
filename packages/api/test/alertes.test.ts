import { expect, it } from 'vitest';
import { ALERT_PURPOSE, Alertes, FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const BASE = 'https://aimmo.example.test/alertes/desinscription/';

async function world() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(TUESDAY_10H);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const person = await store.createPerson({ networkId: network.id, firstName: 'Inès' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: 'ines@example.test' });
  await store.addConsent({ networkId: network.id, personId: person.id, purpose: ALERT_PURPOSE, channel: 'email', proof: 'test', givenAt: new Date(TUESDAY_10H - 86_400_000) });
  // Un jeton rangé comme le fait une alerte : on le tire de l'alerte d'un bien.
  const project = await store.createProject({ networkId: network.id, personId: person.id, kind: 'buy' });
  await db.run(
    "INSERT INTO buyer_searches (id, network_id, project_id, person_id, version, communes, sources, origin, created_at) VALUES ('s1', ?, ?, ?, 1, '[\"Talant\"]', '{}', 'agent:x', ?)",
    [network.id, project.id, person.id, new Date(TUESDAY_10H).toISOString()],
  );
  const prop = await store.createProperty({ networkId: network.id, reference: 'B1', kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  const alertes = new Alertes(db, journal, { now, unsubscribeBase: BASE, diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) } });
  await alertes.forProperty(network.id, prop.id);
  const body = (await db.first<{ body: string }>("SELECT body FROM messages WHERE direction = 'out'"))!.body;
  const token = /desinscription\/([a-z]{32})$/.exec(body)![1]!;
  const call = (method: string, path: string, mode = 'essai') => handleRequest(new Request(`https://aimmo.example.test${path}`, { method }), { db, apiKeys: undefined, intakeKeys: undefined, mode, now });
  const active = async () => (await store.listConsents(person.id)).filter((c) => c.withdrawn_at === null).length;
  return { call, token, active, journal };
}

describeWithSqlite('T03 · page de désinscription des alertes', () => {
  it('[R49] le lien de l’alerte mène à une page ; le GET ne change rien, le bouton retire l’accord', async () => {
    const w = await world();
    const get = await w.call('GET', `/alertes/desinscription/${w.token}`);
    expect(get.status).toBe(200);
    const html = await get.text();
    expect(html).toContain('Me désinscrire');
    expect(html).not.toContain('Inès');
    expect(await w.active()).toBe(1);
    const post = await w.call('POST', `/alertes/desinscription/${w.token}`);
    expect(post.status).toBe(200);
    expect(await post.text()).toContain('Vous ne recevrez plus d’alertes de biens');
    expect(await w.active()).toBe(0);
    expect((await w.journal.all()).some((e) => e.type === 'alerte.desinscription')).toBe(true);
  });

  it('un jeton inconnu ou mal formé rend 404 ; hors mode essai, la page est fermée', async () => {
    const w = await world();
    expect((await w.call('POST', `/alertes/desinscription/${'a'.repeat(32)}`)).status).toBe(404);
    expect((await w.call('GET', '/alertes/desinscription/123')).status).toBe(404);
    expect((await w.call('POST', `/alertes/desinscription/${w.token}`, 'production')).status).toBe(503);
    expect(await w.active()).toBe(1);
  });
});
