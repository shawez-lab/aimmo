import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { CATCH_UP_WINDOW_MS, Notifications, type AgentPushGate, type PushPayload } from '../src/automatismes/notifications.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// RC33 : le passage de chaque minute rattrape les contacts chauds et les messages reçus que personne n'a notifiés.
// Un mardi d'octobre, 10 h à Paris. Réseaux, agents, personnes et coordonnées inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const MIN = 60_000;

async function setup(options: { catchUpWindowMs?: number } = {}) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const lea = await store.createAgent({ networkId: network.id, firstName: 'Léa', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: other.id, firstName: 'Sam', lastName: 'Agent' });
  const asAgent = (id: string, networkId: string = network.id) => ({ role: 'agent' as const, userId: id, networkId });
  const person = async (firstName: string, agentId: string = alex.id, networkId: string = network.id) => {
    const p = await store.createPerson({ networkId, agentId, firstName });
    await store.addIdentifier({ networkId, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    return p.id;
  };
  const sent: { agentId: string; payload: PushPayload }[] = [];
  const gate: AgentPushGate = { sendToAgent: async ({ agentId, payload }) => (sent.push({ agentId, payload }), 'ok') };
  let k = 0;
  // La tâche « rappeler » d'un contact chaud (Q04), posée sans sa qualification : seule sa fiche compte ici.
  const callback = async (personId: string, networkId: string = network.id, createdAt: number = clock) => {
    const id = `cb-${++k}`;
    raw.exec('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO callback_tasks (id, network_id, person_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES (?, ?, ?, 'q', ?, 'r', ?, ?, NULL)", [
      id,
      networkId,
      personId,
      id,
      new Date(createdAt + 60 * MIN).toISOString(),
      new Date(createdAt).toISOString(),
    ]);
    raw.exec('PRAGMA foreign_keys = ON');
    return id;
  };
  const message = async (personId: string, opts: { at?: number; agentId?: string | null; networkId?: string; direction?: 'in' | 'out'; author?: 'person' | 'agent' } = {}) => {
    const id = `msg-${++k}`;
    const at = new Date(opts.at ?? clock).toISOString();
    await db.run('INSERT INTO messages (id, network_id, agent_id, person_id, channel, direction, author_kind, body, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      opts.networkId ?? network.id,
      opts.agentId ?? null,
      personId,
      'whatsapp',
      opts.direction ?? 'in',
      opts.author ?? 'person',
      'Bonjour, je vends, rappelez-moi',
      at,
      new Date(clock).toISOString(),
    ]);
    return id;
  };
  const notifications = new Notifications(db, journal, gate, { now, newId, ...(options.catchUpWindowMs !== undefined ? { catchUpWindowMs: options.catchUpWindowMs } : {}) });
  const reads = async () => (await journal.all()).filter((e) => e.type === 'fiche.lue' || e.type === 'acces.refuse').length;
  const rows = () => db.all<{ agent_id: string; kind: string; dedup_key: string; person_id: string }>('SELECT agent_id, kind, dedup_key, person_id FROM agent_notifications ORDER BY created_at, id');
  return { db, journal, store, network, other, alex, lea, sam, asAgent, person, sent, callback, message, notifications, reads, rows, setClock: (t: number) => (clock = t), clock: () => clock };
}

describeWithSqlite('RC33 · le passage des notifications rattrape contacts chauds et messages reçus', () => {
  it('[R412] une tâche « rappeler » ouverte et récente : contact chaud notifié une fois, aussitôt, sans doublon aux passages suivants', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    await t.callback(noa);
    t.setClock(t.clock() + 30_000);
    expect(await t.notifications.catchUp()).toEqual({ hotContacts: 1, inbound: 0, notified: 1 });
    expect(await t.rows()).toMatchObject([{ agent_id: t.alex.id, kind: 'contact_chaud' }]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.payload).toMatchObject({ urgency: 'immediate', body: 'Un contact chaud à rappeler maintenant' });
    const readsAfterFirst = await t.reads();
    for (let i = 0; i < 5; i++) {
      t.setClock(t.clock() + MIN);
      expect(await t.notifications.catchUp()).toEqual({ hotContacts: 1, inbound: 0, notified: 0 });
    }
    expect(await t.rows()).toHaveLength(1);
    expect(t.sent).toHaveLength(1);
    // Rien de plus au journal : un fait déjà notifié est écarté avant toute lecture de la fiche [R13].
    expect(await t.reads()).toBe(readsAfterFirst);
  });

  it('un message reçu récent : notifié à son agent, ou à ceux qui suivent la fiche ; il part au passage, groupé', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    const sacha = await t.person('Sacha', t.lea.id);
    const mine = await t.message(noa, { agentId: t.alex.id });
    const free = await t.message(sacha);
    // Le message d'un agent qui ne suit plus la fiche va à celui qui la suit.
    const moved = await t.message(sacha, { agentId: t.alex.id });
    expect(await t.notifications.catchUp()).toEqual({ hotContacts: 0, inbound: 3, notified: 3 });
    const rows = await t.rows();
    expect(rows.map((r) => [r.agent_id, r.dedup_key])).toEqual([
      [t.alex.id, `${t.alex.id}:client_ecrit:message:${mine}`],
      [t.lea.id, `${t.lea.id}:client_ecrit:message:${free}`],
      [t.lea.id, `${t.lea.id}:client_ecrit:message:${moved}`],
    ]);
    // La même clé que `inbound` : appelé ensuite, il ne range rien de plus.
    await t.notifications.inbound(mine);
    expect(await t.rows()).toHaveLength(3);
    const pushes = await t.notifications.flush();
    expect(pushes.map((p) => [p.agent_id, p.count]).sort()).toEqual([
      [t.alex.id, 1],
      [t.lea.id, 2],
    ].sort());
  });

  it('tâche faite, fait plus vieux que la fenêtre, message envoyé par l’agent, message daté dans le futur : rien', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    const done = await t.callback(noa);
    await t.db.run('UPDATE callback_tasks SET done_at = ? WHERE id = ?', [new Date(t.clock()).toISOString(), done]);
    await t.callback(noa, t.network.id, t.clock() - CATCH_UP_WINDOW_MS - MIN);
    await t.message(noa, { at: t.clock() - CATCH_UP_WINDOW_MS - MIN });
    await t.message(noa, { direction: 'out', author: 'agent', agentId: t.alex.id });
    const future = await t.message(noa, { at: t.clock() + 5 * MIN });
    expect(await t.notifications.catchUp()).toEqual({ hotContacts: 0, inbound: 0, notified: 0 });
    expect(await t.rows()).toHaveLength(0);
    // Le message daté dans le futur attend son heure, puis il est notifié.
    t.setClock(t.clock() + 5 * MIN);
    expect(await t.notifications.catchUp()).toMatchObject({ inbound: 1, notified: 1 });
    expect((await t.rows())[0]?.dedup_key).toBe(`${t.alex.id}:client_ecrit:message:${future}`);
  });

  it('[R412] un fait déjà notifié par `hotContact` ne notifie rien de plus ; un message dit par le contact chaud n’est pas redit', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    const task = await t.callback(noa);
    await t.notifications.hotContact(task);
    expect(t.sent).toHaveLength(1);
    const before = await t.reads();
    await t.message(noa);
    t.setClock(t.clock() + MIN);
    expect(await t.notifications.catchUp()).toEqual({ hotContacts: 1, inbound: 1, notified: 0 });
    expect(await t.rows()).toHaveLength(1);
    expect(await t.reads()).toBe(before);
  });

  it('[R16] sorte coupée, personne exclue, agent parti : rien, et aucune lecture de fiche au journal à chaque passage', async () => {
    const t = await setup();
    expect(await t.notifications.setSettings(t.asAgent(t.alex.id), { quietStart: 21 * 60, quietEnd: 8 * 60, levels: { client_ecrit: 'coupee' } })).toMatchObject({ ok: true });
    const noa = await t.person('Noa');
    await t.message(noa);
    const remi = await t.person('Rémi');
    await t.db.run("INSERT INTO exclusions (id, network_id, person_id, reason, noted_at, created_at) VALUES ('e1', ?, ?, 'stop', ?, ?)", [t.network.id, remi, new Date(t.clock() - MIN).toISOString(), new Date(t.clock()).toISOString()]);
    await t.callback(remi);
    await t.message(remi);
    const sacha = await t.person('Sacha', t.lea.id);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.lea.id]);
    await t.callback(sacha);
    await t.message(sacha);
    const before = await t.reads();
    for (let i = 0; i < 3; i++) {
      expect(await t.notifications.catchUp()).toEqual({ hotContacts: 2, inbound: 3, notified: 0 });
      t.setClock(t.clock() + MIN);
    }
    expect(await t.rows()).toHaveLength(0);
    expect(t.sent).toHaveLength(0);
    expect(await t.reads()).toBe(before);
  });

  it('deux réseaux : chaque fait va aux agents de son réseau, jamais à un autre [R16]', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    const zoe = await t.person('Zoé', t.sam.id, t.other.id);
    await t.callback(noa);
    await t.callback(zoe, t.other.id);
    await t.message(zoe, { networkId: t.other.id });
    expect(await t.notifications.catchUp()).toEqual({ hotContacts: 2, inbound: 1, notified: 2 });
    const rows = await t.rows();
    expect(rows.map((r) => [r.agent_id, r.kind, r.person_id]).sort()).toEqual(
      [
        [t.alex.id, 'contact_chaud', noa],
        [t.sam.id, 'contact_chaud', zoe],
      ].sort(),
    );
    // Le message de Zoé est dit par son contact chaud, à Sam seul.
    expect(t.sent.map((s) => s.agentId).sort()).toEqual([t.alex.id, t.sam.id].sort());
  });

  it('la fenêtre se règle', async () => {
    const t = await setup({ catchUpWindowMs: 60 * MIN });
    const noa = await t.person('Noa');
    await t.callback(noa, t.network.id, t.clock() - 45 * MIN);
    expect(await t.notifications.catchUp()).toEqual({ hotContacts: 1, inbound: 0, notified: 1 });
    const short = await setup({ catchUpWindowMs: 30 * MIN });
    const zoe = await short.person('Zoé');
    await short.callback(zoe, short.network.id, short.clock() - 45 * MIN);
    expect(await short.notifications.catchUp()).toEqual({ hotContacts: 0, inbound: 0, notified: 0 });
  });
});
