import { expect, it } from 'vitest';
import { Acces, FicheAgent, FicheClient, FicheUnique, Rappels, SqlJournalStore, applyMigrations, fromSyncSqlite, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé.
const NOW = new Date('2026-11-10T09:00:00.000Z');

async function world() {
  const now = () => NOW;
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const journal = new SqlJournalStore(db);
  const acces = new Acces(db, store, unique, journal, { now });
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  const asLise: Viewer = { role: 'agent', userId: lise.id, networkId: net.id };
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: net.id, personId: lea.id, kind: 'phone', value: '06 00 00 00 01' });
  await store.addSource({ networkId: net.id, agentId: paul.id, personId: lea.id, channel: 'site', detail: 'formulaire test', occurredAt: new Date('2026-10-01T10:00:00Z') });
  await store.createProject({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'sell', budgetMinEur: 200000, budgetMaxEur: 230000 });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'case cochée test', givenAt: new Date('2026-10-01T10:00:00Z') });
  for (let i = 1; i <= 12; i++) {
    await store.recordMessage({ networkId: net.id, personId: lea.id, channel: 'email', conversationId: 'c1', direction: i % 2 ? 'in' : 'out', authorKind: i % 2 ? 'person' : 'agent', body: `Message test ${i}`, occurredAt: new Date(Date.parse('2026-10-02T09:00:00Z') + i * 3_600_000) });
  }
  await db.run(`INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, body, status, person_id, received_at, created_at) VALUES ('in-1', ?, 'k1', 'email', 'email', 'x', 'processed', ?, ?, ?)`, [net.id, lea.id, NOW.toISOString(), NOW.toISOString()]);
  await db.run(`INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, deadline, financing, criteria, source, created_at) VALUES ('q-1', ?, 'in-1', ?, 'seller', 'within_3_months', NULL, '[]', 'rules', ?)`, [net.id, lea.id, NOW.toISOString()]);
  await db.run(`INSERT INTO callback_tasks (id, network_id, person_id, project_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES ('t-1', ?, ?, NULL, 'q-1', 'k-t1', 'Vendeur sous 3 mois', ?, ?, NULL)`, [net.id, lea.id, NOW.toISOString(), NOW.toISOString()]);
  const fiche = new FicheAgent(db, acces, { now });
  const rappels = new Rappels(db, unique, journal, { now });
  return { db, store, net, paul, lise, asPaul, asLise, lea, acces, fiche, rappels, journal };
}

describeWithSqlite('A03 · fiche du client dans l’application', () => {
  it('projets, origines, accords, derniers messages, rappels et numéro à appeler, pour l’agent de la fiche', async () => {
    const w = await world();
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.value;
    expect(f).toMatchObject({ personId: w.lea.id, firstName: 'Léa', lastName: 'Exemple', contact: { allowed: true, reasons: [] }, call: 'tel:+33600000001' });
    expect(f.projects).toEqual([{ kind: 'sell', stage: 'new', deadline: null, budgetMinEur: 200000, budgetMaxEur: 230000 }]);
    expect(f.sources).toEqual([{ channel: 'site', detail: 'formulaire test', occurredAt: '2026-10-01T10:00:00.000Z' }]);
    expect(f.consents).toEqual([{ id: expect.any(String), purpose: 'valuation_follow_up', channel: 'email', givenAt: '2026-10-01T10:00:00.000Z', withdrawnAt: null }]);
    expect(f.messages).toHaveLength(10);
    expect(f.messages[0]!.body).toBe('Message test 12');
    expect(f.callbacks).toEqual([{ taskId: 't-1', reason: 'Vendeur sous 3 mois', dueAt: NOW.toISOString(), doneAt: null }]);
    const entries = await w.journal.all();
    expect(entries.filter((e) => e.type === 'fiche.lue').map((e) => e.subject)).toEqual([`person:${w.lea.id}`]);
  });

  it('[R16] la fiche d’un autre agent est refusée, et le refus est au journal', async () => {
    const w = await world();
    expect(await w.fiche.read(w.asLise, w.lea.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await w.fiche.read(w.asLise, 'inconnue')).toMatchObject({ ok: false, rule: 'R16' });
    const refused = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused).toHaveLength(2);
    expect(JSON.stringify(refused)).not.toMatch(/Léa|Exemple|\+336/);
  });

  it('[R02, R04] une personne exclue ou arrêtée est signalée et n’a pas de numéro à appeler ; une exclusion levée le rend', async () => {
    for (const reason of ['stop', 'network_list', 'refused', 'sold', 'followed_elsewhere'] as const) {
      const w = await world();
      await w.store.addExclusion({ networkId: w.net.id, personId: w.lea.id, reason, channel: reason === 'stop' ? 'sms' : null, notedAt: new Date('2026-11-01T00:00:00Z') });
      const r = await w.fiche.read(w.asPaul, w.lea.id);
      expect(r.ok && r.value.contact, reason).toEqual({ allowed: false, reasons: [reason] });
      expect(r.ok && r.value.call, reason).toBeNull();
    }
    const w = await world();
    const ex = await w.store.addExclusion({ networkId: w.net.id, personId: w.lea.id, reason: 'stop', notedAt: new Date('2026-11-01T00:00:00Z') });
    await w.db.run('UPDATE exclusions SET lifted_at = ? WHERE id = ?', ['2026-11-05T00:00:00.000Z', ex.id]);
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.call).toBe('tel:+33600000001');
  });

  it('[R17, R16] « rappel fait » garde la ligne, une seule fois au journal ; refusé à un autre agent et pour une tâche inconnue', async () => {
    const w = await world();
    expect(await w.rappels.done(w.acces, w.asLise, 't-1')).toBe(false);
    expect(await w.rappels.done(w.acces, w.asPaul, 'inconnue')).toBe(false);
    expect(await w.rappels.done(w.acces, w.asPaul, 't-1')).toBe(true);
    expect(await w.rappels.done(w.acces, w.asPaul, 't-1')).toBe(true);
    const row = await w.db.first<{ done_at: string | null }>(`SELECT done_at FROM callback_tasks WHERE id = 't-1'`);
    expect(row?.done_at).toBe(NOW.toISOString());
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.callbacks).toEqual([{ taskId: 't-1', reason: 'Vendeur sous 3 mois', dueAt: NOW.toISOString(), doneAt: NOW.toISOString() }]);
    const entries = await w.journal.all();
    expect(entries.filter((e) => e.type === 'rappel.fait').map((e) => [e.subject, e.data])).toEqual([[`person:${w.lea.id}`, { task: 't-1' }]]);
    expect(entries.filter((e) => e.type === 'acces.refuse')).toHaveLength(2);
  });
});
