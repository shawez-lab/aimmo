import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, RegistreMandats, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : registre d'essai, préfixe « T- ».
const NOW = Date.parse('2027-02-10T10:00:00.000Z');

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = NOW;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const mandats = new Mandats(db, fiche, journal, { now });
  const registre = new RegistreMandats(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1');
  const mandate = async (agentId = alex.id): Promise<string> => {
    const p = await store.createPerson({ networkId: network.id, agentId, firstName: 'Léa' });
    const r = await mandats.record(acces, as('agent', agentId), { personId: p.id, signedAt: new Date(clock), source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    clock += 60_000;
    return r.id;
  };
  return { raw, db, journal, registre, network, other, alex, sam, as, direction, mandate };
}

describeWithSqlite('D01 · registre des mandats', () => {
  it('[R39] chaque mandat reçoit le numéro suivant, au format du réseau, sans trou, une seule fois', async () => {
    const t = await setup();
    const m1 = await t.mandate();
    expect(await t.registre.inscribe(t.as('agent', t.alex.id), m1)).toEqual({ ok: false, rule: null, code: 'not_configured' });
    expect(await t.registre.configure(t.as('agent', t.alex.id), { prefix: 'T-', firstNumber: 41, width: 5 })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 41, width: 5 })).toEqual({ ok: true });
    expect(await t.registre.configure(t.direction, { prefix: 'X-', firstNumber: 1, width: 3 })).toEqual({ ok: false, rule: null, code: 'already_configured' });
    expect(await t.registre.configure(t.as('direction', 'd', t.other.id), { prefix: '<b>', firstNumber: 1, width: 3 })).toEqual({ ok: false, rule: null, code: 'bad_settings' });

    const ids = [m1, await t.mandate(), await t.mandate(t.sam.id)];
    const numbers: string[] = [];
    for (const id of ids) {
      const viewer = id === ids[2] ? t.as('agent', t.sam.id) : t.as('agent', t.alex.id);
      const r = await t.registre.inscribe(viewer, id);
      if (!r.ok) throw new Error(r.code);
      numbers.push(r.line.number);
    }
    expect(numbers).toEqual(['T-00041', 'T-00042', 'T-00043']);
    expect(await t.registre.inscribe(t.as('agent', t.alex.id), m1)).toEqual({ ok: false, rule: 'R39', code: 'already_inscribed' });
    // Le format ne change plus une fois le registre ouvert, même directement en base.
    await expect(t.db.run(`UPDATE mandate_register_settings SET first_number = 1 WHERE network_id = ?`, [t.network.id])).rejects.toThrow(/format figé/);
  });

  it('[R39] des inscriptions simultanées n’ont jamais le même numéro ni de trou', async () => {
    const t = await setup();
    await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await t.mandate());
    const results = await Promise.all(ids.map((id) => t.registre.inscribe(t.direction, id)));
    const numbers = results.map((r) => (r.ok ? r.line.numberValue : -1)).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Une autre inscription qui prend le rang entre la lecture et l'écriture : la suivante recommence et prend le rang d'après.
    const late = await t.mandate();
    const sneaky = await t.mandate();
    let injected = false;
    const racing: SqlDatabase = {
      ...t.db,
      first: async <T>(sql: string, params?: readonly (string | number | null)[]) => {
        const row = await t.db.first<T>(sql, params);
        if (!injected && sql.includes('COUNT(*)')) {
          injected = true;
          await new RegistreMandats(t.db, t.journal, { now: () => new Date(NOW) }).inscribe(t.direction, sneaky);
        }
        return row;
      },
    };
    const r = await new RegistreMandats(racing, t.journal, { now: () => new Date(NOW) }).inscribe(t.direction, late);
    expect(r.ok && r.line.number).toBe('T-010');
    expect(await t.registre.check(t.network.id)).toEqual({ ok: true, lines: 10 });
  });

  it('[R39, R17] une modification après coup est détectée ; rien ne s’efface ; une erreur se corrige par une annulation', async () => {
    const t = await setup();
    await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const ids = [await t.mandate(), await t.mandate(), await t.mandate()];
    for (const id of ids) await t.registre.inscribe(t.direction, id);
    expect(await t.registre.check(t.network.id)).toEqual({ ok: true, lines: 3 });

    await expect(t.db.run('UPDATE mandate_register SET number = ? WHERE seq = 2', ['T-999'])).rejects.toThrow(/ajout seul/);
    await expect(t.db.run('DELETE FROM mandate_register WHERE seq = 3')).rejects.toThrow(/ajout seul/);

    // Annulation : une ligne de plus, le numéro reste donné, le suivant ne le reprend pas.
    expect(await t.registre.cancel(t.direction, ids[1]!, 'bad' as never)).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    const c = await t.registre.cancel(t.direction, ids[1]!, 'error');
    expect(c.ok && [c.line.kind, c.line.number, c.line.cancelsSeq]).toEqual(['annulation', 'T-002', 2]);
    expect(await t.registre.cancel(t.direction, ids[1]!, 'error')).toEqual({ ok: false, rule: null, code: 'already_cancelled' });
    const next = await t.mandate();
    const n = await t.registre.inscribe(t.direction, next);
    expect(n.ok && n.line.number).toBe('T-004');
    expect(await t.registre.check(t.network.id)).toEqual({ ok: true, lines: 5 });

    // Quelqu'un qui a la main sur la base retire les gardes et réécrit une ligne : le contrôle le voit.
    t.raw.exec('DROP TRIGGER mandate_register_sans_modification');
    await t.db.run(`UPDATE mandate_register SET signed_at = '2027-01-01T00:00:00.000Z' WHERE network_id = ? AND seq = 2`, [t.network.id]);
    expect(await t.registre.check(t.network.id)).toEqual({ ok: false, lines: 5, brokenAt: 2, problem: 'hash' });
  });

  it('[R39] une ligne réécrite avec une empreinte recalculée perd son ancre ; un mandat changé après inscription se voit', async () => {
    const t = await setup();
    await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const ids = [await t.mandate(), await t.mandate()];
    for (const id of ids) await t.registre.inscribe(t.direction, id);
    t.raw.exec('DROP TRIGGER mandate_register_sans_modification');
    const { hashRegisterLine } = await import('../src/index.ts');
    const row = (await t.db.first<Record<string, unknown>>('SELECT * FROM mandate_register WHERE network_id = ? AND seq = 1', [t.network.id]))!;
    const forged = { ...row, property_id: null, at: '2027-02-01T00:00:00.000Z' } as never as Parameters<typeof hashRegisterLine>[0];
    const hash = await hashRegisterLine(forged);
    await t.db.run('UPDATE mandate_register SET at = ?, hash = ? WHERE network_id = ? AND seq = 1', ['2027-02-01T00:00:00.000Z', hash, t.network.id]);
    // L'empreinte réécrite ne retrouve plus son ancre au journal.
    expect(await t.registre.check(t.network.id)).toMatchObject({ ok: false, brokenAt: 1, problem: 'anchor' });

    const u = await setup();
    await u.registre.configure(u.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const m = await u.mandate();
    await u.registre.inscribe(u.direction, m);
    // Le mandat rangé est figé en base ; quelqu'un retire la garde et le réécrit.
    u.raw.exec('DROP TRIGGER mandates_fige');
    await u.db.run('UPDATE mandates SET signed_at = ? WHERE id = ?', ['2026-12-31T00:00:00.000Z', m]);
    expect(await u.registre.check(u.network.id)).toEqual({ ok: false, lines: 1, brokenAt: 1, problem: 'mandate' });
    // Le contrôle par la direction le dit, et l'écrit au journal sans donnée personnelle.
    const v = await u.registre.verify(u.direction);
    expect(v).toEqual({ ok: true, value: { ok: false, lines: 1, brokenAt: 1, problem: 'mandate' } });
    expect(JSON.stringify(await u.journal.all())).not.toMatch(/Léa/);
  });

  it('[R16] seuls l’agent du mandat, la direction et la conformité lisent une ligne ; la conformité n’inscrit pas ; refus au journal', async () => {
    const t = await setup();
    await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const m = await t.mandate();
    expect(await t.registre.inscribe(t.as('agent', t.sam.id), m)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.registre.inscribe(t.as('compliance', 'c-1'), m)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.registre.inscribe(t.as('direction', 'd', t.other.id), m)).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    await t.registre.inscribe(t.as('agent', t.alex.id), m);
    for (const viewer of [t.as('agent', t.alex.id), t.direction, t.as('compliance', 'c-1')]) {
      const r = await t.registre.linesOf(viewer, m);
      expect(r.ok && r.lines.map((l) => l.number)).toEqual(['T-001']);
    }
    for (const viewer of [t.as('agent', t.sam.id), t.as('partner', 'p-1')]) expect(await t.registre.linesOf(viewer, m)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.registre.verify(t.as('agent', t.alex.id))).toMatchObject({ ok: false, rule: 'R16' });
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused).toHaveLength(6);
  });

  it('[R39, R17] des lignes effacées en fin de registre, ou une ligne réécrite avec toute la suite recalculée, sont détectées', async () => {
    const t = await setup();
    await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const ids = [await t.mandate(), await t.mandate(), await t.mandate()];
    for (const id of ids) await t.registre.inscribe(t.direction, id);
    t.raw.exec('DROP TRIGGER mandate_register_sans_effacement');
    await t.db.run('DELETE FROM mandate_register WHERE network_id = ? AND seq = 3', [t.network.id]);
    expect(await t.registre.check(t.network.id)).toEqual({ ok: false, lines: 2, brokenAt: 3, problem: 'missing' });

    const u = await setup();
    await u.registre.configure(u.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const m = [await u.mandate(), await u.mandate(), await u.mandate()];
    for (const id of m) await u.registre.inscribe(u.direction, id);
    await u.registre.cancel(u.direction, m[0]!, 'error');
    u.raw.exec('DROP TRIGGER mandate_register_sans_modification');
    const { hashRegisterLine } = await import('../src/index.ts');
    // Réécrit la raison de l'annulation, puis recalcule l'empreinte de cette ligne et de toute la suite.
    const rows = await u.db.all<Record<string, unknown>>('SELECT * FROM mandate_register WHERE network_id = ? ORDER BY seq', [u.network.id]);
    let prev = rows[2]!.hash as string;
    for (const row of rows.slice(3)) {
      const changed = { ...row, reason: 'withdrawal', actor: 'direction:autre', prev_hash: prev } as Record<string, unknown>;
      delete changed.hash;
      const hash = await hashRegisterLine(changed as never);
      await u.db.run('UPDATE mandate_register SET reason = ?, actor = ?, prev_hash = ?, hash = ? WHERE network_id = ? AND seq = ?', ['withdrawal', 'direction:autre', prev, hash, u.network.id, row.seq as number]);
      prev = hash;
    }
    expect(await u.registre.check(u.network.id)).toEqual({ ok: false, lines: 4, brokenAt: 4, problem: 'anchor' });
  });

  it('[R39, R13] l’ancre écrite au journal n’a jamais l’air d’un numéro ; un contrôle pendant une inscription ne crie pas à tort', async () => {
    const { registerAnchor } = await import('../src/index.ts');
    // Une empreinte qui contient une suite de chiffres comme un numéro de téléphone.
    const hash = '0504538642' + 'a'.repeat(54);
    expect(registerAnchor(hash)).toMatch(/^[a-p]{64}$/);
    const t = await setup();
    await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const a = await t.mandate();
    const b = await t.mandate();
    await t.registre.inscribe(t.direction, a);
    // Une inscription se termine entre la lecture du registre et celle du journal.
    let once = false;
    const racing: SqlDatabase = {
      ...t.db,
      all: async <T>(sql: string, params?: readonly (string | number | null)[]) => {
        const rows = await t.db.all<T>(sql, params);
        if (!once && sql.includes('FROM mandate_register WHERE network_id = ? ORDER BY seq')) {
          once = true;
          await t.registre.inscribe(t.direction, b);
        }
        return rows;
      },
    };
    expect(await new RegistreMandats(racing, t.journal).check(t.network.id)).toEqual({ ok: true, lines: 2 });
  });

  it('[R39] après un effacement en fin de registre, aucun rang ni numéro n’est redonné, et l’effacement reste visible', async () => {
    const t = await setup();
    await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const ids = [await t.mandate(), await t.mandate()];
    for (const id of ids) await t.registre.inscribe(t.direction, id);
    t.raw.exec('DROP TRIGGER mandate_register_sans_effacement');
    await t.db.run('DELETE FROM mandate_register WHERE network_id = ? AND seq = 2', [t.network.id]);
    const next = await t.mandate();
    expect(await t.registre.inscribe(t.direction, next)).toEqual({ ok: false, rule: 'R39', code: 'register_broken' });
    expect(await t.registre.cancel(t.direction, ids[0]!, 'error')).toEqual({ ok: false, rule: 'R39', code: 'register_broken' });
    expect((await t.journal.all()).filter((e) => e.type === 'registre.alerte').map((e) => e.data)).toEqual([
      { network: t.network.id, lines: 1, brokenAt: 2, problem: 'missing' },
      { network: t.network.id, lines: 1, brokenAt: 2, problem: 'missing' },
    ]);
    // Même en forçant une ligne de remplacement au rang effacé, l'ancre d'origine la contredit.
    const { hashRegisterLine, registerAnchor, appendEvent } = await import('../src/index.ts');
    const first = (await t.db.first<Record<string, unknown>>('SELECT * FROM mandate_register WHERE network_id = ? AND seq = 1', [t.network.id]))!;
    const fake = { ...first, seq: 2, mandate_id: next, number_value: 2, number: 'T-002', prev_hash: first.hash } as Record<string, unknown>;
    delete fake.hash;
    const hash = await hashRegisterLine(fake as never);
    await t.db.run(
      `INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, cancels_seq, reason, at, actor, prev_hash, hash) VALUES (?, 2, 'inscription', ?, 2, 'T-002', ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      [t.network.id, next, fake.agent_id as string, (fake.property_id as string | null) ?? null, fake.signed_at as string, fake.at as string, fake.actor as string, fake.prev_hash as string, hash],
    );
    await appendEvent(t.journal, { type: 'registre.inscrit', actor: 'direction:x', subject: null, data: { network: t.network.id, seq: 2, number: 'T-002', anchor: registerAnchor(hash) } }, () => new Date(NOW));
    expect(await t.registre.check(t.network.id)).toMatchObject({ ok: false, brokenAt: 2, problem: 'anchor' });
  });

  it('[R39, R13] un numéro long n’arrête pas le journal ; une inscription dont l’ancre a manqué la reprend à la redemande', async () => {
    const t = await setup();
    await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 1, width: 10 });
    const a = await t.mandate();
    const r = await t.registre.inscribe(t.direction, a);
    expect(r.ok && r.line.number).toBe('T-0000000001');
    expect(JSON.stringify(await t.journal.all())).not.toContain('T-0000000001');

    // Le journal tombe juste après l'écriture de la ligne.
    const b = await t.mandate();
    let fail = true;
    const flaky = { ...t.journal, append: async (entry: Parameters<typeof t.journal.append>[0]) => {
      if (fail && entry.type === 'registre.inscrit') {
        fail = false;
        throw new Error('journal en panne');
      }
      return t.journal.append(entry);
    }, last: () => t.journal.last(), all: () => t.journal.all() } as typeof t.journal;
    await expect(new RegistreMandats(t.db, flaky, { now: () => new Date(NOW) }).inscribe(t.direction, b)).rejects.toThrow(/journal en panne/);
    expect(await t.registre.check(t.network.id)).toMatchObject({ ok: false, brokenAt: 2, problem: 'anchor' });
    expect(await t.registre.inscribe(t.direction, b)).toEqual({ ok: false, rule: 'R39', code: 'already_inscribed' });
    expect(await t.registre.check(t.network.id)).toEqual({ ok: true, lines: 2 });
  });

  it('[R39] l’ancre d’une annulation reprise garde la raison rangée au registre', async () => {
    const t = await setup();
    await t.registre.configure(t.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
    const a = await t.mandate();
    await t.registre.inscribe(t.direction, a);
    let fail = true;
    const flaky = { ...t.journal, append: async (entry: Parameters<typeof t.journal.append>[0]) => {
      if (fail && entry.type === 'registre.annule') {
        fail = false;
        throw new Error('journal en panne');
      }
      return t.journal.append(entry);
    }, last: () => t.journal.last(), all: () => t.journal.all() } as typeof t.journal;
    await expect(new RegistreMandats(t.db, flaky, { now: () => new Date(NOW) }).cancel(t.direction, a, 'error')).rejects.toThrow(/journal en panne/);
    expect(await t.registre.cancel(t.direction, a, 'termination')).toEqual({ ok: false, rule: null, code: 'already_cancelled' });
    const resumed = (await t.journal.all()).filter((e) => e.type === 'registre.annule');
    expect(resumed.map((e) => (e.data as { reason: string }).reason)).toEqual(['error']);
    expect(await t.registre.check(t.network.id)).toEqual({ ok: true, lines: 2 });
  });
});
