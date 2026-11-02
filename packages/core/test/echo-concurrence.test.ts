import { expect, it } from 'vitest';
import {
  FicheClient,
  ReconnaissanceBien,
  SqlJournalStore,
  applyMigrations,
  createCaptation,
  fromSyncSqlite,
  type HumanReply,
  type ReplyWriter,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi à 10 h, heure de Paris. Tout est inventé.
const AT = new Date('2026-12-08T09:00:00.000Z');
const IG_ID = '178400000000001';

/**
 * Une base vue par un seul Worker. `pauseAt` : juste avant son n-ième accès, l'autre Worker fait tout son travail.
 * C'est le croisement réel de deux notifications : chacune avance d'une instruction à la fois, sans verrou commun.
 */
function worker(db: SqlDatabase) {
  const state = { count: 0, pauseAt: 0, during: null as null | (() => Promise<void>), sql: [] as string[] };
  const step = async (sql: string): Promise<void> => {
    state.count += 1;
    state.sql.push(sql);
    if (state.count === state.pauseAt && state.during) await state.during();
  };
  const view: SqlDatabase = {
    exec: (sql) => db.exec(sql),
    run: async (sql, params) => (await step(sql), db.run(sql, params)),
    all: async (sql, params) => (await step(sql), db.all(sql, params)),
    first: async (sql, params) => (await step(sql), db.first(sql, params)),
  };
  return { view, state };
}

async function setup(writer?: ReplyWriter) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => AT;
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const home = await store.createProperty({ networkId: network.id, agentId: agent.id, reference: '501', kind: 'home', city: 'Dijon', surfaceM2: 64, priceEur: 189000, status: 'available' });
  await new ReconnaissanceBien(db).link({ networkId: network.id, propertyId: home.id, kind: 'post', value: 'video-501', at: now() });
  let seq = 0;

  /** Les deux Workers d'une même conversation, comme `processMetaNotification` : l'écho d'un côté, le message de l'autre. */
  const crossing = (over: { writer?: ReplyWriter } = {}) => {
    seq += 1;
    const client = `17843000${String(seq).padStart(6, '0')}`;
    const e = worker(db);
    const m = worker(db);
    const options = { now, withQualification: false, withOrigin: false };
    const echoSide = createCaptation(e.view, new SqlJournalStore(e.view), options);
    const messageSide = createCaptation(m.view, new SqlJournalStore(m.view), { ...options, ...(over.writer ?? writer ? { writer: (over.writer ?? writer)! } : {}) });
    const reply: HumanReply = { channel: 'instagram', conversationRef: client, externalId: `ig-echo-${seq}`, text: 'Je vous réponds tout de suite.', sentAt: AT };
    const echo = () => echoSide.relais.noteOrKeepHumanReply(network.id, reply);
    const message = () =>
      messageSide.chaine.receive(
        network.id,
        'instagram',
        { object: 'instagram', entry: [{ id: IG_ID, time: AT.getTime(), messaging: [{ sender: { id: client }, recipient: { id: IG_ID }, timestamp: AT.getTime(), message: { mid: `ig-mid-${seq}`, text: 'Bonjour, le bien réf 501 est-il disponible ?' } }] }] },
        { ownIds: [IG_ID] },
        { beforeReply: async () => void (await messageSide.relais.applyPendingHumanReplies(network.id)) },
      );
    const conversation = `instagram:${client}`;
    const outbox = async () =>
      (await db.all<{ id: string }>(`SELECT m.id FROM trial_outbox t JOIN messages m ON m.id = t.message_id WHERE m.conversation_id = ?`, [conversation])).length;
    const handover = () => db.first<{ reason: string }>('SELECT reason FROM conversation_handovers WHERE conversation_id = ?', [conversation]);
    const pending = () => db.all<{ applied_at: string | null; body: string }>('SELECT applied_at, body FROM pending_human_replies WHERE conversation_ref = ?', [client]);
    const finalState = async () => {
      // Quel que soit l'ordre : la conversation est à l'agent, l'écho est traité, son texte n'est plus gardé ici [R13, R21].
      expect((await handover())?.reason).toBe('human_reply');
      const rows = await pending();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.applied_at).not.toBeNull();
      expect(rows[0]!.body).toBe('');
      expect(await db.all('SELECT message_id FROM human_replies WHERE dedup_key = ?', [`instagram:${reply.externalId}`])).toHaveLength(1);
    };
    return { e, m, echo, message, outbox, handover, pending, finalState, reply, echoSide, conversation };
  };
  return { db, network, crossing };
}

describeWithSqlite('C09a · Écho humain et premier message traités en même temps', () => {
  it('[R21] l’écho s’arrête à chaque accès à la base pendant que le message passe : une fois écrit, plus aucune réponse', async () => {
    const t = await setup();
    const reference = t.crossing();
    await reference.echo();
    const steps = reference.e.state.count;
    expect(steps).toBeGreaterThan(3);
    // Le premier accès de l'écho est son écriture : le message passé avant elle ne pouvait pas le savoir.
    expect(reference.e.state.sql[0]).toContain('INSERT INTO pending_human_replies');
    for (let n = 1; n <= steps; n += 1) {
      const c = t.crossing();
      c.e.state.pauseAt = n;
      c.e.state.during = async () => void (await c.message());
      await c.echo();
      expect(await c.outbox(), `arrêt au ${n}e accès`).toBe(n === 1 ? 1 : 0);
      await c.finalState();
    }
  });

  it('[R21] le message s’arrête à chaque accès à la base pendant que l’écho passe : rien ne part si l’écho précède le dernier contrôle', async () => {
    const t = await setup();
    const reference = t.crossing();
    expect((await reference.message())[0]!.status).toBe('replied');
    const sql = reference.m.state.sql;
    const lastCheck = sql.reduce((at, s, i) => (s.includes('conversation_handovers') && /^\s*SELECT/i.test(s) ? i + 1 : at), 0);
    expect(lastCheck).toBeGreaterThan(0);
    for (let n = 1; n <= sql.length; n += 1) {
      const c = t.crossing();
      c.m.state.pauseAt = n;
      c.m.state.during = async () => void (await c.echo());
      await c.message();
      if (n <= lastCheck) expect(await c.outbox(), `arrêt au ${n}e accès`).toBe(0);
      await c.finalState();
    }
  });

  it('[R21] un écho reçu pendant la rédaction de la réponse : rien ne part, l’agent garde la main', async () => {
    const t = await setup();
    let during: () => Promise<void> = async () => undefined;
    const writer: ReplyWriter = {
      async write() {
        await during();
        return 'Bonjour, la maison est toujours disponible.';
      },
    };
    const c = t.crossing({ writer });
    during = async () => void (await c.echo());
    const [result] = await c.message();
    expect(result!.status).not.toBe('replied');
    expect(await c.outbox()).toBe(0);
    await c.finalState();
  });

  it('[R21] l’écho de notre propre message, reconnu à son identifiant, ne fait pas taire l’assistant et ne reste pas en attente', async () => {
    const t = await setup();
    const c = t.crossing();
    await c.message();
    const sent = await t.db.first<{ id: string }>(`SELECT id FROM messages WHERE conversation_id = ? AND direction = 'out'`, [c.conversation]);
    await t.db.run('INSERT INTO outbound_refs (network_id, channel, external_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)', [t.network.id, 'instagram', c.reply.externalId, sent!.id, AT.toISOString()]);
    expect(await c.echo()).toBe('own');
    expect(await c.handover()).toBeNull();
    const rows = await c.pending();
    expect(rows[0]!.applied_at).not.toBeNull();
    expect(rows[0]!.body).toBe('');
  });

  it('[R13] le même écho renvoyé par Meta ne recopie pas son texte et ne compte qu’une fois', async () => {
    const t = await setup();
    const c = t.crossing();
    await c.message();
    expect(await c.echo()).toBe('noted');
    const first = (await c.pending())[0]!.applied_at;
    expect(await c.echo()).toBe('duplicate');
    const rows = await c.pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('');
    expect(rows[0]!.applied_at).toBe(first);
    await c.finalState();
  });

  it('[R21] un écho sans conversation connue reste gardé avec son texte, puis s’applique avant la réponse', async () => {
    const t = await setup();
    const c = t.crossing();
    expect(await c.echo()).toBe('pending');
    const kept = await c.pending();
    expect(kept[0]!.applied_at).toBeNull();
    expect(kept[0]!.body).toBe(c.reply.text);
    await c.message();
    expect(await c.outbox()).toBe(0);
    await c.finalState();
  });
});
