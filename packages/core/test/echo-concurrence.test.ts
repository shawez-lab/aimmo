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
const MINUTE = 60_000;

/**
 * Une base vue par un seul Worker. Chaque accès peut l'arrêter : `pauseAt` lance l'autre Worker à cet endroit,
 * `freezeAt` le fige jusqu'à `release`, `failAt` simule une coupure. Deux notifications qui se croisent avancent ainsi
 * une instruction à la fois, sans verrou commun.
 */
function worker(db: SqlDatabase) {
  const state = {
    count: 0,
    pauseAt: 0,
    during: null as null | (() => Promise<void>),
    freezeAt: 0,
    reached: null as null | (() => void),
    gate: null as null | Promise<void>,
    failAt: 0,
    sql: [] as string[],
  };
  const step = async (sql: string): Promise<void> => {
    state.count += 1;
    state.sql.push(sql);
    if (state.count === state.failAt) throw new Error('coupure simulée');
    if (state.count === state.pauseAt && state.during) await state.during();
    if (state.count === state.freezeAt) {
      state.reached?.();
      await state.gate;
    }
  };
  const view: SqlDatabase = {
    exec: (sql) => db.exec(sql),
    run: async (sql, params) => (await step(sql), db.run(sql, params)),
    all: async (sql, params) => (await step(sql), db.all(sql, params)),
    first: async (sql, params) => (await step(sql), db.first(sql, params)),
  };
  return { view, state };
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = AT.getTime();
  const now = (): Date => new Date(clock);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const home = await store.createProperty({ networkId: network.id, agentId: agent.id, reference: '501', kind: 'home', city: 'Dijon', surfaceM2: 64, priceEur: 189000, status: 'available' });
  await new ReconnaissanceBien(db).link({ networkId: network.id, propertyId: home.id, kind: 'post', value: 'video-501', at: now() });
  let seq = 0;

  /** Les deux Workers d'une même conversation, comme `processMetaNotification` : l'écho d'un côté, le message de l'autre. */
  const crossing = (over: { writer?: ReplyWriter } = {}) => {
    seq += 1;
    const n = seq;
    const client = `17843000${String(n).padStart(6, '0')}`;
    const e = worker(db);
    const m = worker(db);
    const options = { now, withQualification: false, withOrigin: false };
    const echoSide = createCaptation(e.view, new SqlJournalStore(e.view), options);
    const messageSide = createCaptation(m.view, new SqlJournalStore(m.view), { ...options, ...(over.writer ? { writer: over.writer } : {}) });
    const reply: HumanReply = { channel: 'instagram', conversationRef: client, externalId: `ig-echo-${n}`, text: `Je vous réponds tout de suite, n° ${n}.`, sentAt: AT };
    const echo = () => echoSide.relais.noteOrKeepHumanReply(network.id, reply);
    const message = () =>
      messageSide.chaine.receive(
        network.id,
        'instagram',
        { object: 'instagram', entry: [{ id: IG_ID, time: AT.getTime(), messaging: [{ sender: { id: client }, recipient: { id: IG_ID }, timestamp: AT.getTime(), message: { mid: `ig-mid-${n}`, text: 'Bonjour, le bien réf 501 est-il disponible ?' } }] }] },
        { ownIds: [IG_ID] },
        { beforeReply: async () => void (await messageSide.relais.applyPendingHumanReplies(network.id)) },
      );
    const conversation = `instagram:${client}`;
    const outbox = async () =>
      (await db.all<{ id: string }>('SELECT m.id FROM trial_outbox t JOIN messages m ON m.id = t.message_id WHERE m.conversation_id = ?', [conversation])).length;
    const handover = () => db.first<{ reason: string }>('SELECT reason FROM conversation_handovers WHERE conversation_id = ?', [conversation]);
    const pending = () => db.all<{ applied_at: string | null; body: string }>('SELECT applied_at, body FROM pending_human_replies WHERE conversation_ref = ?', [client]);
    const onFiche = () => db.all<{ body: string }>("SELECT body FROM messages WHERE conversation_id = ? AND direction = 'out' AND author_kind = 'agent'", [conversation]);
    /** Quel que soit l'ordre : la conversation est à l'agent, l'écho est traité, une seule fois sur la fiche ; rien n'est effacé [R17, R21]. */
    const finalState = async (label: string) => {
      expect((await handover())?.reason, label).toBe('human_reply');
      const rows = await pending();
      expect(rows, label).toHaveLength(1);
      expect(rows[0]!.applied_at, label).not.toBeNull();
      expect(rows[0]!.body, label).toBe(reply.text);
      expect((await onFiche()).map((r) => r.body), label).toEqual([reply.text]);
    };
    return { e, m, echo, message, outbox, handover, pending, onFiche, finalState, reply, conversation, freshEcho: () => createCaptation(db, new SqlJournalStore(db), options).relais.noteOrKeepHumanReply(network.id, reply) };
  };
  return { db, network, crossing, advance: (ms: number) => (clock += ms) };
}

const INSERT_ECHO = 'INSERT INTO pending_human_replies';
/** Le rang du dernier accès qui peut encore arrêter la réponse : la lecture du passage à l'agent, avant la réservation de l'envoi. */
const lastCheckOf = (sql: readonly string[]): number => {
  const reservation = sql.findIndex((s) => s.includes('INSERT INTO send_reservations'));
  return sql.slice(0, reservation).reduce((at, s, i) => (s.includes('FROM conversation_handovers') ? i + 1 : at), 0);
};

describeWithSqlite('C09a · Écho humain et premier message traités en même temps', () => {
  it('[R21] sur toute la grille, écho figé à chaque accès et message à chaque accès : rien ne part si l’écho est écrit avant le dernier contrôle', async () => {
    const t = await setup();
    const reference = t.crossing();
    expect((await reference.message())[0]!.status).toBe('replied');
    const mSql = reference.m.state.sql;
    const lastCheck = lastCheckOf(mSql);
    // Le dernier contrôle est bien celui qui précède la réservation de l'envoi, pas la lecture de `beforeReply`.
    const reservation = mSql.findIndex((s) => s.includes('INSERT INTO send_reservations')) + 1;
    expect(lastCheck).toBeGreaterThan(0);
    expect(reservation).toBeGreaterThan(lastCheck);
    expect(mSql[lastCheck - 2]).toContain('pending_human_replies');

    const shape = t.crossing();
    await shape.message();
    await shape.echo();
    const known = shape.e.state.sql;
    const inserted = known.findIndex((s) => s.includes(INSERT_ECHO)) + 1;
    expect(inserted).toBeGreaterThan(0);
    // La voie de l'écho quand la conversation n'est pas encore connue, plus longue ou plus courte selon l'arrêt.
    const unknown = t.crossing();
    await unknown.echo();
    const echoSteps = Math.max(known.length, unknown.e.state.sql.length);

    // Un point sur cinq, plus la lecture de `beforeReply` et tous les points qui précèdent la dernière lecture.
    const firstRead = mSql.findIndex((s) => s.includes('pending_human_replies')) + 1;
    // Dernière lecture des échos gardés : un écho écrit avant elle arrête la réponse, où qu'il en soit.
    const lastRead = lastCheck - 1;
    const points = [...Array(lastRead).keys()].map((i) => i + 1).filter((p) => p >= lastRead - 6 || p === firstRead || p % 5 === 0);
    for (const pauseAt of points) {
      for (let freezeAt = inserted + 1; freezeAt <= echoSteps + 1; freezeAt += 1) {
        const c = t.crossing();
        const label = `message arrêté au ${pauseAt}e accès, écho figé au ${freezeAt}e`;
        let echoDone: Promise<unknown> = Promise.resolve();
        let release = (): void => undefined;
        c.e.state.freezeAt = freezeAt;
        c.e.state.gate = new Promise<void>((r) => (release = r));
        c.m.state.pauseAt = pauseAt;
        c.m.state.during = async () => {
          await new Promise<void>((reached) => {
            c.e.state.reached = reached;
            // L'écho finit parfois avant d'atteindre l'arrêt : c'est aussi un ordre à éprouver.
            echoDone = c.echo().finally(reached);
          });
        };
        await c.message();
        expect(await c.outbox(), label).toBe(0);
        release();
        await echoDone;
        await c.finalState(label);
      }
    }

    // Un écho complètement traité juste après cette lecture : le passage à l'agent, lu en dernier, arrête la réponse.
    const c = t.crossing();
    c.m.state.pauseAt = lastCheck;
    c.m.state.during = async () => void (await c.echo());
    await c.message();
    expect(await c.outbox()).toBe(0);
    await c.finalState('écho fini entre les deux lectures');
  }, 120_000);

  it('[R21] l’écho arrêté à chaque accès pendant que le message passe : la réponse ne part que si l’écho n’est pas encore écrit', async () => {
    const t = await setup();
    const reference = t.crossing();
    await reference.echo();
    const steps = reference.e.state.count;
    const inserted = reference.e.state.sql.findIndex((s) => s.includes(INSERT_ECHO)) + 1;
    expect(inserted).toBeGreaterThan(0);
    for (let n = 1; n <= steps; n += 1) {
      const c = t.crossing();
      c.e.state.pauseAt = n;
      c.e.state.during = async () => void (await c.message());
      await c.echo();
      expect(await c.outbox(), `arrêt au ${n}e accès`).toBe(n <= inserted ? 1 : 0);
      await c.finalState(`arrêt au ${n}e accès`);
    }
  });

  it('[R21] après le dernier contrôle, l’écho arrive trop tard pour le message, mais la conversation passe quand même à l’agent', async () => {
    const t = await setup();
    const reference = t.crossing();
    await reference.message();
    const sql = reference.m.state.sql;
    const lastCheck = lastCheckOf(sql);
    for (let n = lastCheck + 1; n <= sql.length; n += 1) {
      const c = t.crossing();
      c.m.state.pauseAt = n;
      c.m.state.during = async () => void (await c.echo());
      await c.message();
      expect(await c.outbox(), `arrêt au ${n}e accès`).toBeLessThanOrEqual(1);
      await c.finalState(`arrêt au ${n}e accès`);
    }
  });

  it('[R21] un écho reçu pendant la rédaction de la réponse : rien ne part, l’agent garde la main', async () => {
    const t = await setup();
    let during: () => Promise<void> = async () => undefined;
    let wrote = 0;
    const writer: ReplyWriter = {
      async write() {
        wrote += 1;
        await during();
        return 'Bonjour, le bien est toujours disponible.';
      },
    };
    const c = t.crossing({ writer });
    during = async () => void (await c.echo());
    const [result] = await c.message();
    expect(wrote).toBe(1);
    expect(result!.status).not.toBe('replied');
    expect(await c.outbox()).toBe(0);
    await c.finalState('rédaction');
  });

  it('[R21] un écho écrit puis coupé pendant la rédaction : le dernier contrôle l’applique, rien ne part', async () => {
    const t = await setup();
    let during: () => Promise<void> = async () => undefined;
    const writer: ReplyWriter = {
      async write() {
        await during();
        return 'Bonjour, le bien est toujours disponible.';
      },
    };
    const reference = t.crossing();
    await reference.echo();
    const inserted = reference.e.state.sql.findIndex((s) => s.includes(INSERT_ECHO)) + 1;
    const c = t.crossing({ writer });
    c.e.state.failAt = inserted + 1;
    during = async () => {
      await expect(c.echo()).rejects.toThrow('coupure simulée');
    };
    await c.message();
    expect(await c.outbox()).toBe(0);
    await c.finalState('coupure de l’écho');
  });

  it('[R21] coupure à chaque accès de l’écho, puis renvoi par Meta : l’agent garde la main, son message une seule fois sur la fiche', async () => {
    const t = await setup();
    const reference = t.crossing();
    await reference.message();
    await reference.echo();
    const steps = reference.e.state.count;
    expect(steps).toBeGreaterThan(5);
    for (let n = 1; n <= steps; n += 1) {
      const c = t.crossing();
      await c.message();
      c.e.state.failAt = n;
      await expect(c.echo(), `coupure au ${n}e accès`).rejects.toThrow('coupure simulée');
      // Le renvoi arrive après le délai où le premier Worker pourrait encore travailler.
      t.advance(3 * MINUTE);
      await c.freshEcho();
      await c.finalState(`coupure au ${n}e accès`);
    }
  });

  it('[R21] pendant qu’un autre Worker range l’écho, un renvoi ne le range pas une seconde fois et ne le marque pas traité', async () => {
    const t = await setup();
    const reference = t.crossing();
    await reference.message();
    await reference.echo();
    const reserve = reference.e.state.sql.findIndex((s) => s.includes('INSERT INTO human_replies')) + 1;
    expect(reserve).toBeGreaterThan(0);
    const c = t.crossing();
    await c.message();
    let release = (): void => undefined;
    c.e.state.gate = new Promise<void>((r) => (release = r));
    c.e.state.freezeAt = reserve + 1;
    const first = c.echo();
    await new Promise<void>((reached) => (c.e.state.reached = reached));
    expect(await c.freshEcho()).toBe('duplicate');
    expect((await c.pending())[0]!.applied_at).toBeNull();
    expect(await c.onFiche()).toHaveLength(0);
    release();
    await first;
    await c.finalState('deux Workers');
  });

  it('[R21] l’écho de notre propre message, reconnu à son identifiant, ne fait pas taire l’assistant et n’entre pas dans la table', async () => {
    const t = await setup();
    const c = t.crossing();
    await c.message();
    const sent = await t.db.first<{ id: string }>("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'out'", [c.conversation]);
    await t.db.run('INSERT INTO outbound_refs (network_id, channel, external_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)', [t.network.id, 'instagram', c.reply.externalId, sent!.id, AT.toISOString()]);
    expect(await c.echo()).toBe('own');
    expect(await c.handover()).toBeNull();
    expect(await c.pending()).toHaveLength(0);
  });

  it('[R21] un écho gardé qui se révèle être le nôtre au dernier contrôle laisse partir la réponse', async () => {
    const t = await setup();
    const c = t.crossing();
    // L'écho est écrit, puis l'identifiant de notre envoi arrive pendant que le message se traite.
    await t.db.run(
      'INSERT INTO pending_human_replies (network_id, channel, external_id, conversation_ref, body, sent_at, created_at, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      [t.network.id, 'instagram', c.reply.externalId, c.reply.conversationRef, c.reply.text, AT.toISOString(), AT.toISOString()],
    );
    const seed = t.crossing();
    await seed.message();
    const ours = await t.db.first<{ id: string }>("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'out'", [seed.conversation]);
    await t.db.run('INSERT INTO outbound_refs (network_id, channel, external_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)', [t.network.id, 'instagram', c.reply.externalId, ours!.id, AT.toISOString()]);
    expect((await c.message())[0]!.status).toBe('replied');
    expect(await c.handover()).toBeNull();
    expect((await c.pending())[0]!.applied_at).not.toBeNull();
  });

  it('[R17] le même écho renvoyé par Meta ne compte qu’une fois, et rien de la table n’est effacé', async () => {
    const t = await setup();
    const c = t.crossing();
    await c.message();
    expect(await c.echo()).toBe('noted');
    const first = (await c.pending())[0]!.applied_at;
    t.advance(MINUTE);
    expect(await c.echo()).toBe('duplicate');
    const rows = await c.pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe(c.reply.text);
    expect(rows[0]!.applied_at).toBe(first);
    await c.finalState('renvoi');
  });

  it('[R21] un écho sans conversation connue reste gardé, puis s’applique avant la réponse', async () => {
    const t = await setup();
    const c = t.crossing();
    expect(await c.echo()).toBe('pending');
    expect((await c.pending())[0]!.applied_at).toBeNull();
    await c.message();
    expect(await c.outbox()).toBe(0);
    await c.finalState('écho d’abord');
  });
});
