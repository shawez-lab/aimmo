import { afterEach, expect, it, vi } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, type SqlDatabase } from '@aimmo/core';
import { Notifications } from '../../core/src/automatismes/notifications.ts';
import { runNotificationsPass } from '../src/notifications.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// BR65 : le passage des notifications aux agents, à chaque minute. Un mardi d'octobre, 10 h à Paris (8 h UTC).
// Réseau, agents, personnes et coordonnées inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const TUE_22H = Date.parse('2027-10-12T20:00:00.000Z');
const WED_08H = Date.parse('2027-10-13T06:00:00.000Z');
const MIN = 60_000;

async function world() {
  const raw = openMemoryDatabase();
  const d1 = fakeD1(raw);
  const db: SqlDatabase = fromD1(d1);
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now: () => new Date(TUE_10H - 60 * MIN) });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const noa = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Noa' });
  await store.addIdentifier({ networkId: network.id, personId: noa.id, kind: 'email', value: 'noa@example.test' });
  let k = 0;
  // La tâche « rappeler » d'un contact chaud (Q04), posée sans sa qualification : seule sa fiche compte ici.
  const callback = async (createdAt: number) => {
    const id = `cb-${++k}`;
    raw.exec('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO callback_tasks (id, network_id, person_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES (?, ?, ?, 'q', ?, 'r', ?, ?, NULL)", [
      id,
      network.id,
      noa.id,
      id,
      new Date(createdAt + 60 * MIN).toISOString(),
      new Date(createdAt).toISOString(),
    ]);
    raw.exec('PRAGMA foreign_keys = ON');
    return id;
  };
  // Le déclencheur du Worker, à la minute dite, comme Cloudflare l'appelle.
  const tick = async (at: number, mode = 'essai') => {
    vi.useFakeTimers({ now: at, toFake: ['Date'] });
    try {
      await worker.scheduled({ scheduledTime: at }, { DB: d1, MODE: mode } as Env);
    } finally {
      vi.useRealTimers();
    }
  };
  const count = async (sql: string): Promise<number> => Number((await db.first<{ n: number }>(sql))?.n ?? 0);
  const outbox = () => count('SELECT count(*) AS n FROM agent_push_trial_outbox');
  const notifications = () => db.all<{ kind: string; status: string }>('SELECT kind, status FROM agent_notifications ORDER BY created_at, id');
  const passages = async () => (await journal.all()).filter((e) => e.type === 'planificateur.passage');
  return { db, journal, alex, callback, tick, count, outbox, notifications, passages };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describeWithSqlite('BR65 · les notifications aux agents passent chaque minute', () => {
  it('[R412] un contact chaud rangé part au passage de la minute suivante, une seule fois', async () => {
    const w = await world();
    await w.callback(TUE_10H + 20_000);
    await w.tick(TUE_10H + MIN);
    expect(await w.notifications()).toEqual([{ kind: 'contact_chaud', status: 'envoyee' }]);
    expect(await w.outbox()).toBe(1);
    // Les minutes suivantes ne le redisent pas.
    for (let i = 2; i <= 6; i++) await w.tick(TUE_10H + i * MIN);
    expect(await w.notifications()).toHaveLength(1);
    expect(await w.outbox()).toBe(1);
  });

  it('[R225] [R26] seule la boîte d’essai reçoit : rien ne part vers un téléphone ni vers une personne', async () => {
    const w = await world();
    await w.callback(TUE_10H);
    await w.tick(TUE_10H + MIN);
    expect(await w.count("SELECT count(*) AS n FROM agent_push_sends WHERE mode = 'essai'")).toBe(1);
    expect(await w.count("SELECT count(*) AS n FROM agent_push_sends WHERE mode <> 'essai'")).toBe(0);
    expect(await w.count("SELECT count(*) AS n FROM agent_push_log WHERE mode <> 'essai'")).toBe(0);
    expect(await w.count("SELECT count(*) AS n FROM agent_push_log WHERE outcome = 'refuse'")).toBe(0);
    // Le contrôle central du passage n'a aucun canal vers une personne : aucun message n'est écrit.
    expect(await w.count("SELECT count(*) AS n FROM messages WHERE direction = 'out'")).toBe(0);
    const events = (await w.journal.all()).filter((e) => e.type.startsWith('notifications') || e.subject?.startsWith('agent_push:'));
    // Le journal de la boîte d'essai ne garde ni texte ni agent [R13].
    for (const e of events) expect(JSON.stringify(e.data)).not.toMatch(/Noa|Alex|contact chaud/i);
  });

  it('[R413] heures calmes tenues par le passage : le contact chaud du soir attend le matin', async () => {
    const w = await world();
    await w.callback(TUE_22H);
    await w.tick(TUE_22H + MIN);
    expect(await w.notifications()).toEqual([{ kind: 'contact_chaud', status: 'a_envoyer' }]);
    expect(await w.outbox()).toBe(0);
    await w.tick(WED_08H);
    expect(await w.notifications()).toEqual([{ kind: 'contact_chaud', status: 'envoyee' }]);
    expect(await w.outbox()).toBe(1);
  });

  it('hors mode essai, rien ne passe', async () => {
    const w = await world();
    await w.callback(TUE_10H);
    await w.tick(TUE_10H + MIN, 'reel');
    expect(await runNotificationsPass({ db: w.db, mode: undefined, now: () => new Date(TUE_10H + MIN) })).toBeNull();
    expect(await w.notifications()).toHaveLength(0);
    expect(await w.outbox()).toBe(0);
    expect(await w.passages()).toHaveLength(0);
  });

  it('le planificateur et la publication ne passent qu’aux quarts d’heure ; les notifications à chaque minute', async () => {
    const w = await world();
    await w.callback(TUE_10H + 30_000);
    await w.tick(TUE_10H + MIN);
    expect(await w.outbox()).toBe(1);
    expect(await w.passages()).toHaveLength(0);
    expect(await w.count('SELECT count(*) AS n FROM scheduled_runs')).toBe(0);
    await w.tick(TUE_10H + 15 * MIN);
    expect((await w.passages()).length).toBeGreaterThan(0);
    const slots = await w.db.all<{ slot: string }>("SELECT slot FROM scheduled_runs WHERE job = 'annonces.publication'");
    expect(slots.map((s) => s.slot)).toEqual(['2027-10-12T08:15Z']);
    // 10 h 16 : ni planificateur ni publication de plus.
    const before = await w.count('SELECT count(*) AS n FROM scheduled_runs');
    await w.tick(TUE_10H + 16 * MIN);
    expect(await w.count('SELECT count(*) AS n FROM scheduled_runs')).toBe(before);
  });

  it('[R13] une panne du passage est au journal, et le planificateur passe quand même', async () => {
    const w = await world();
    vi.spyOn(Notifications.prototype, 'catchUp').mockRejectedValue(new TypeError('panne'));
    await w.tick(TUE_10H);
    const errors = (await w.journal.all()).filter((e) => e.type === 'api.erreur');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ actor: 'system:notifications', data: { route: 'notifications.passage', error: 'TypeError' } });
    expect((await w.passages()).length).toBeGreaterThan(0);
  });
});
