import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Entrainement, checkRecruitingText, OBJECTION_GUIDE, TRAINING_CASES, TRAINING_COUNTS_MANDATORY, TRAINING_FALLBACK_NOTICE, citesClientData, type ObjectionCoach } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Agents et cas inventés.
let clock = Date.parse('2027-07-13T09:00:00.000Z');

async function setup(coach?: ObjectionCoach, aiTimeoutMs = 50) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const e = new Entrainement(db, journal, { now, aiTimeoutMs, ...(coach ? { coach } : {}) });
  const a = (await store.createAgent({ networkId: network.id, firstName: 'Ana', lastName: 'Test' })).id;
  const b = (await store.createAgent({ networkId: network.id, firstName: 'Bob', lastName: 'Test' })).id;
  const as = (id: string) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  const dir = { role: 'direction' as const, userId: 'dir', networkId: network.id };
  return { db, journal, e, network, a, b, as, dir };
}

it('[R15] [R80] la bibliothèque du code : des cas inventés, sans donnée de client ni promesse de revenus', () => {
  expect(TRAINING_CASES.length).toBeGreaterThanOrEqual(5);
  expect(new Set(TRAINING_CASES.map((c) => c.objection))).toEqual(new Set(['honoraires', 'exclusivite', 'prix']));
  for (const c of TRAINING_CASES) {
    for (const t of [c.title, c.situation, c.opening, ...c.replies]) {
      expect(citesClientData(t)).toBe(false);
      expect(checkRecruitingText(t).ok).toBe(true);
    }
  }
  for (const g of Object.values(OBJECTION_GUIDE)) for (const r of g.rules) expect(checkRecruitingText(r).ok).toBe(true);
  expect(citesClientData('Appelez-le au 06 10 00 00 01')).toBe(true);
  expect(citesClientData('client@example.org')).toBe(true);
  expect(citesClientData('voir la fiche person:abc')).toBe(true);
  expect(citesClientData('00000000-0000-4000-8000-000000000001')).toBe(true);
  expect(citesClientData('Il veut vendre au-dessus du marché.')).toBe(false);
  expect(TRAINING_COUNTS_MANDATORY).toBe(false);
});

describeWithSqlite('entraînement aux objections', () => {
  it('[R15] un cas qui cite une coordonnée ou une fiche est refusé ; [R80] une promesse de revenus aussi', async () => {
    const w = await setup();
    const base = { role: 'vendeur', objection: 'prix', title: 'Prix trop haut', situation: 'Un vendeur inventé, sa maison est au-dessus du marché.', opening: 'Votre prix est trop bas.', replies: ['Je veux plus.'] };
    expect((await w.e.addCase(w.dir, base)).ok).toBe(true);
    expect(await w.e.addCase(w.dir, { ...base, situation: 'Le client Jean, joignable au 06 10 00 00 01, veut vendre.' })).toEqual({ ok: false, rule: 'R15', code: 'client_data' });
    expect(await w.e.addCase(w.dir, { ...base, replies: ['Écrivez-moi à vendeur@example.org'] })).toEqual({ ok: false, rule: 'R15', code: 'client_data' });
    expect(await w.e.addCase(w.dir, { ...base, situation: 'Reprendre la fiche person:1234 du réseau, telle quelle.' })).toEqual({ ok: false, rule: 'R15', code: 'client_data' });
    expect(await w.e.addCase(w.dir, { ...base, opening: 'Avec nous, revenus garantis dès le premier mois.' })).toEqual({ ok: false, rule: 'R80', code: 'income_promise' });
    expect(await w.e.addCase(w.as(w.a), base)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const list = await w.e.cases(w.as(w.a));
    expect(list.ok && list.value.length).toBe(TRAINING_CASES.length + 1);
  });

  it('[R12] sans IA, la réplique écrite du cas répond, un texte le dit, et rien ne casse', async () => {
    const w = await setup();
    const s = await w.e.start(w.as(w.a), 'honoraires-vendeur');
    if (!s.ok) throw new Error(s.code);
    expect(s.opening).toBe(TRAINING_CASES[0]!.opening);
    const r1 = await w.e.turn(w.as(w.a), s.sessionId, 'Je comprends. Mes honoraires paient la diffusion, les visites et la négociation.');
    expect(r1).toEqual({ ok: true, reply: TRAINING_CASES[0]!.replies[0], byAi: false, notice: TRAINING_FALLBACK_NOTICE });
    const r2 = await w.e.turn(w.as(w.a), s.sessionId, 'Regardons ensemble le prix net vendeur.');
    expect(r2.ok && r2.reply).toBe(TRAINING_CASES[0]!.replies[1]);
    for (let i = 0; i < 4; i += 1) expect((await w.e.turn(w.as(w.a), s.sessionId, 'Et si on se voit jeudi ?')).ok).toBe(true);
    clock += 12 * 60_000;
    const end = await w.e.end(w.as(w.a), s.sessionId);
    if (!end.ok) throw new Error(end.code);
    expect(end.minutes).toBe(12);
    expect(end.feedback.rules).toEqual(OBJECTION_GUIDE.honoraires.rules);
    expect(end.feedback.points.map((p) => p.touched)).toEqual([true, true, true]);
    expect(await w.e.turn(w.as(w.a), s.sessionId, 'encore')).toEqual({ ok: false, rule: null, code: 'ended' });
  });

  it('[R12] [R80] [R15] une IA en panne, trop lente, hors des règles ou qui cite une coordonnée est remplacée par le secours', async () => {
    const replies: (() => Promise<string>)[] = [
      async () => {
        throw new Error('panne');
      },
      () => new Promise((resolve) => setTimeout(() => resolve('trop tard'), 500)),
      async () => 'Rejoignez-nous, revenus garantis !',
      async () => 'Rappelez-moi au 06 10 00 00 02.',
      async () => 'Concrètement, qu’est-ce que vous faites pour moi ?',
    ];
    let i = 0;
    const seen: unknown[] = [];
    const w = await setup({ reply: async (input) => (seen.push(input), replies[i++]!()) });
    const s = await w.e.start(w.as(w.a), 'exclusivite-vendeur');
    if (!s.ok) throw new Error(s.code);
    const out = [];
    for (let k = 0; k < 5; k += 1) out.push(await w.e.turn(w.as(w.a), s.sessionId, 'Avec une exclusivité, vous avez un seul interlocuteur et un plan écrit.'));
    expect(out.map((o) => o.ok && o.byAi)).toEqual([false, false, false, false, true]);
    expect(out[4]!.ok && out[4]!.reply).toBe('Concrètement, qu’est-ce que vous faites pour moi ?');
    const causes = (await w.journal.all()).filter((e) => e.type === 'entrainement.ia_refusee').map((e) => e.data.cause);
    expect(causes).toEqual(['error', 'timeout', 'income_promise', 'client_data']);
    // L'IA ne reçoit que le cas inventé et l'échange : aucune fiche, aucun nom d'agent.
    expect(JSON.stringify(seen)).not.toMatch(/Ana|Test|person|agent:/);
  });

  it('[R15] ce que l\'agent écrit ne doit citer aucune donnée de client : refusé, rien ne va à l\'IA', async () => {
    let calls = 0;
    const w = await setup({ reply: async () => (calls++, 'Ah bon ?') });
    const s = await w.e.start(w.as(w.a), 'prix-vendeur');
    if (!s.ok) throw new Error(s.code);
    expect(await w.e.turn(w.as(w.a), s.sessionId, 'Comme pour Mme Martin, 06 10 00 00 03, on a vendu vite.')).toEqual({ ok: false, rule: 'R15', code: 'client_data' });
    expect(calls).toBe(0);
    expect(JSON.stringify(await w.db.all('SELECT * FROM training_turns'))).not.toContain('06 10');
    expect(JSON.stringify(await w.journal.all())).not.toMatch(/Martin|06 10/);
  });

  it('[R14] aucune note de l\'agent n\'est rangée ni montrée à la direction : elle ne lit que le temps', async () => {
    const w = await setup();
    const s = await w.e.start(w.as(w.a), 'prix-acquereur');
    if (!s.ok) throw new Error(s.code);
    await w.e.turn(w.as(w.a), s.sessionId, 'Je comprends, regardons les ventes du quartier.');
    clock += 5 * 60_000;
    await w.e.end(w.as(w.a), s.sessionId);
    for (const table of ['training_cases', 'training_sessions', 'training_turns']) {
      const cols = (await w.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((c) => c.name);
      expect(cols.some((c) => /score|note|grade|rank|rang|level|niveau|result|touched/.test(c))).toBe(false);
    }
    expect(await w.e.academyMinutes(w.dir, w.a)).toEqual({ ok: true, minutes: 5, sessions: 1 });
    // La direction ne lit ni l'échange ni le retour ; un autre agent non plus.
    expect(await w.e.turn(w.dir, s.sessionId, 'lecture')).toEqual({ ok: false, rule: 'R16', code: 'not_owner' });
    expect(await w.e.end(w.as(w.b), s.sessionId)).toEqual({ ok: false, rule: 'R16', code: 'not_owner' });
    expect(await w.e.academyMinutes(w.as(w.b), w.a)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const journal = JSON.stringify(await w.journal.all());
    expect(journal).not.toMatch(/touched|quartier/);
  });

  it('[R16] un agent parti ou un partenaire ne s\'entraînent pas ; un cas inconnu est refusé', async () => {
    const w = await setup();
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.b]);
    expect(await w.e.start(w.as(w.b), 'prix-vendeur')).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await w.e.start({ role: 'partner', userId: 'p', networkId: w.network.id }, 'prix-vendeur')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.e.cases({ role: 'partner', userId: 'p', networkId: w.network.id })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.e.start(w.as(w.a), 'inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_case' });
    expect(await w.e.start(w.as(w.a), 'reseau:inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_case' });
  });
});
