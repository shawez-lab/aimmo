import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { FormationQuiz, RULE_CATALOG, verifyAttestation, type AttestationDocument } from '../src/formation/index.ts';
import { canonicalJson, fingerprintOf } from '../src/rapports/index.ts';
import { Academie } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, vidéos et questions inventés. Horloge simulée, 10 h à Paris.
let clock = Date.parse('2027-03-01T09:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function setup(options: { random?: () => number } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const academie = new Academie(db, journal, { now, newId: uuid });
  const quiz = new FormationQuiz(db, journal, { now, newId: uuid, random: options.random ?? (() => 0.5) });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const newAgent = async (first: string) => (await store.createAgent({ networkId: network.id, firstName: first, lastName: 'Test' })).id;
  const as = (agentId: string) => ({ role: 'agent' as const, userId: agentId, networkId: network.id });
  let pos = 0;
  const module = async (track: 'entree' | 'vente' = 'entree') => {
    pos += 1;
    const r = await academie.addModule(dir, { title: `Module ${pos}`, track, position: pos, videoId: `vid${String(pos).padStart(8, '0')}`, durationMinutes: 30 });
    if (!r.ok) throw new Error(r.code);
    return r.moduleId;
  };
  // La bonne réponse est toujours le choix 1 dans ces jeux.
  let k = 0;
  const question = async (moduleId: string, ruleId: string | null = 'R13') => {
    const r = await quiz.addQuestion(dir, { moduleId, ruleId, prompt: `Question inventée numéro ${++k} ?`, choices: ['Faux', 'Vrai', 'Peut-être'], correctIndex: 1 });
    if (!r.ok) throw new Error(r.code);
    return r.questionId;
  };
  return { db, journal, academie, quiz, network, other, dir, newAgent, as, module, question };
}

const allRight = (count: number): number[] => Array.from({ length: count }, () => 1);

describeWithSqlite('HX63 · quiz et attestations de formation', () => {
  it('[R570] chaque question renvoie à son module, et à une règle en service quand elle en cite une', async () => {
    const w = await setup();
    const m = await w.module();
    const base = { prompt: 'Une question inventée ?', choices: ['Oui', 'Non'], correctIndex: 0 };
    expect(await w.quiz.addQuestion(w.dir, { ...base, moduleId: undefined })).toEqual({ ok: false, rule: 'R570', code: 'module_required' });
    expect(await w.quiz.addQuestion(w.dir, { ...base, moduleId: 'module-inconnu' })).toEqual({ ok: false, rule: 'R570', code: 'module_required' });
    expect(await w.quiz.addQuestion(w.dir, { ...base, moduleId: m, ruleId: 'R9999' })).toEqual({ ok: false, rule: 'R570', code: 'rule_not_in_service' });
    expect(await w.quiz.addQuestion(w.dir, { ...base, moduleId: m, ruleId: 14 })).toEqual({ ok: false, rule: 'R570', code: 'rule_not_in_service' });
    // Un module d'un autre réseau ne compte pas.
    const otherDir = { role: 'direction' as const, userId: 'dir-2', networkId: w.other.id };
    expect(await w.quiz.addQuestion(otherDir, { ...base, moduleId: m })).toEqual({ ok: false, rule: 'R570', code: 'module_required' });
    expect((await w.quiz.addQuestion(w.dir, { ...base, moduleId: m, ruleId: 'R03' })).ok).toBe(true);
    expect((await w.quiz.addQuestion(w.dir, { ...base, moduleId: m })).ok).toBe(true);
    // La base refuse aussi une question sans module.
    await expect(
      w.db.run("INSERT INTO quiz_questions (id, network_id, module_id, prompt, choices, correct_index, created_by, created_at) VALUES ('q-x', ?, NULL, 'Une question ?', '[\"a\",\"b\"]', 0, 'x', 'x')", [w.network.id]),
    ).rejects.toThrow();
    // Ni sur le module d'un autre réseau.
    await expect(
      w.db.run("INSERT INTO quiz_questions (id, network_id, module_id, prompt, choices, correct_index, created_by, created_at) VALUES ('q-y', ?, ?, 'Une question inventée ?', '[\"a\",\"b\"]', 0, 'x', 'x')", [w.other.id, m]),
    ).rejects.toThrow(/autre réseau/);
  });

  it('[R570] le catalogue des règles ne cite que des règles en service de docs/REGLES.md, sous leur titre', () => {
    const lines = readFileSync('docs/REGLES.md', 'utf8').split('\n');
    expect(RULE_CATALOG.size).toBeGreaterThan(100);
    for (const [id, title] of RULE_CATALOG) {
      const line = lines.find((l) => l.startsWith(`| ${id} | `));
      expect(line, id).toBeDefined();
      expect(line?.startsWith(`| ${id} | ${title}. `), id).toBe(true);
      expect(line?.includes('| oui |'), id).toBe(true);
    }
  });

  it('[R570] une erreur renvoie au module à revoir et à sa règle, sans donner la bonne réponse', async () => {
    const w = await setup();
    const m1 = await w.module();
    const m2 = await w.module();
    const a = await w.newAgent('Ana');
    const q1 = await w.question(m1, 'R13');
    const q2 = await w.question(m2, null);
    await w.question(m2, 'R03');
    const s = await w.quiz.start(w.as(a), { track: 'entree' });
    if (!s.ok) throw new Error(s.code);
    expect(s.questions).toHaveLength(3);
    // Le tirage ne livre ni la bonne réponse ni sa place.
    for (const q of s.questions) expect(Object.keys(q).sort()).toEqual(['choices', 'prompt', 'questionId']);
    expect(JSON.stringify(s)).not.toContain('correct');
    const answers = s.questions.map((q) => (q.questionId === q1 || q.questionId === q2 ? 0 : 1));
    const r = await w.quiz.submit(w.as(a), s.attemptId, answers);
    if (!r.ok) throw new Error(r.code);
    expect(r.allRight).toBe(false);
    expect(r.attestation).toBeNull();
    const by = new Map(r.results.map((x) => [x.questionId, x]));
    expect(by.get(q1)?.review).toEqual({ moduleId: m1, moduleTitle: 'Module 1', videoId: 'vid00000001', ruleId: 'R13', ruleTitle: RULE_CATALOG.get('R13') });
    expect(by.get(q2)?.review).toEqual({ moduleId: m2, moduleTitle: 'Module 2', videoId: 'vid00000002', ruleId: null, ruleTitle: null });
    for (const x of r.results) if (x.right) expect(x.review).toBeNull();
    // Aucune bonne réponse rendue après coup non plus.
    expect(JSON.stringify(r)).not.toContain('Vrai');
  });

  it('[R14] aucune note, aucun nombre de bonnes réponses, rendu, gardé ou écrit au journal', async () => {
    const w = await setup();
    const m = await w.module();
    const a = await w.newAgent('Bob');
    for (let i = 0; i < 4; i += 1) await w.question(m);
    const s = await w.quiz.start(w.as(a), { moduleId: m });
    if (!s.ok) throw new Error(s.code);
    const r = await w.quiz.submit(w.as(a), s.attemptId, [1, 0, 1, 1]);
    if (!r.ok) throw new Error(r.code);
    expect(Object.keys(r).sort()).toEqual(['allRight', 'attestation', 'modulesToDo', 'ok', 'results']);
    const columns = (await w.db.all<{ name: string }>("SELECT name FROM pragma_table_info('quiz_attempts') UNION ALL SELECT name FROM pragma_table_info('quiz_attestations') UNION ALL SELECT name FROM pragma_table_info('quiz_questions')")).map((c) => c.name);
    for (const c of columns) expect(c).not.toMatch(/score|note|rank|grade|percent|points/);
    const events = await w.journal.all();
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/right|score|correct/);
    expect(text).not.toContain('Question inventée');
  });

  it('[R16] seules les réponses de l\'agent lui-même : ni la direction, ni un autre agent, ni un agent parti', async () => {
    const w = await setup();
    const m = await w.module();
    const a = await w.newAgent('Chloé');
    const b = await w.newAgent('David');
    for (let i = 0; i < 3; i += 1) await w.question(m);
    expect(await w.quiz.start(w.dir, { moduleId: m })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const s = await w.quiz.start(w.as(a), { moduleId: m });
    if (!s.ok) throw new Error(s.code);
    expect(await w.quiz.submit(w.as(b), s.attemptId, allRight(3))).toEqual({ ok: false, rule: 'R16', code: 'not_owner' });
    expect(await w.quiz.submit(w.dir, s.attemptId, allRight(3))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.quiz.submit({ ...w.as(a), networkId: w.other.id }, s.attemptId, allRight(3))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.quiz.addQuestion(w.as(a), { moduleId: m, prompt: 'Une question inventée ?', choices: ['a', 'b'], correctIndex: 0 })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [a]);
    expect(await w.quiz.submit(w.as(a), s.attemptId, allRight(3))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.quiz.start(w.as(a), { moduleId: m })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // La direction lit les attestations, jamais un autre agent.
    expect((await w.quiz.attestations(w.dir, a)).ok).toBe(true);
    expect(await w.quiz.attestations(w.as(b), a)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const refus = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refus.length).toBeGreaterThanOrEqual(6);
  });

  it('les réponses se rangent une seule fois, même envoyées deux fois en même temps, et une seule attestation', async () => {
    const w = await setup();
    const m = await w.module();
    const a = await w.newAgent('Emma');
    for (let i = 0; i < 3; i += 1) await w.question(m);
    await w.academie.complete(w.as(a), m);
    const s = await w.quiz.start(w.as(a), { moduleId: m });
    if (!s.ok) throw new Error(s.code);
    expect(await w.quiz.submit(w.as(a), s.attemptId, [1, 1])).toEqual({ ok: false, rule: null, code: 'invalid_answers' });
    expect(await w.quiz.submit(w.as(a), s.attemptId, [1, 1, 7])).toEqual({ ok: false, rule: null, code: 'invalid_answers' });
    expect(await w.quiz.submit(w.as(a), s.attemptId, [1, 1, 1.5])).toEqual({ ok: false, rule: null, code: 'invalid_answers' });
    const [x, y] = await Promise.all([w.quiz.submit(w.as(a), s.attemptId, allRight(3)), w.quiz.submit(w.as(a), s.attemptId, allRight(3))]);
    const oks = [x, y].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect([x, y].filter((r) => !r.ok)).toEqual([{ ok: false, rule: null, code: 'already_submitted' }]);
    expect(await w.quiz.submit(w.as(a), s.attemptId, allRight(3))).toEqual({ ok: false, rule: null, code: 'already_submitted' });
    expect((await w.db.first<{ c: number }>('SELECT COUNT(*) AS c FROM quiz_attestations'))?.c).toBe(1);
    // La base refuse de changer des réponses rangées.
    await expect(w.db.run("UPDATE quiz_attempts SET answers = '[0,0,0]' WHERE id = ?", [s.attemptId])).rejects.toThrow(/ne changent plus/);
  });

  it('[R571] un quiz sans faute sur des modules tous faits donne une attestation, qui se vérifie par son empreinte', async () => {
    clock = Date.parse('2027-03-01T22:30:00.000Z'); // 23 h 30 à Paris : le jour de Paris est le 1er mars
    const w = await setup();
    const m1 = await w.module('vente');
    const m2 = await w.module('vente');
    await w.module('entree');
    const a = await w.newAgent('Farid');
    await w.question(m1, 'R13');
    await w.question(m1, 'R03');
    await w.question(m2, null);
    await w.academie.complete(w.as(a), m1);
    // Un module du parcours n'est pas fait : sans faute, mais pas d'attestation, et le module à faire est dit.
    const s1 = await w.quiz.start(w.as(a), { track: 'vente' });
    if (!s1.ok) throw new Error(s1.code);
    const r1 = await w.quiz.submit(w.as(a), s1.attemptId, allRight(3));
    if (!r1.ok) throw new Error(r1.code);
    expect(r1.allRight).toBe(true);
    expect(r1.attestation).toBeNull();
    expect(r1.modulesToDo).toEqual([{ moduleId: m2, title: 'Module 2' }]);
    await w.academie.complete(w.as(a), m2);
    const s2 = await w.quiz.start(w.as(a), { track: 'vente' });
    if (!s2.ok) throw new Error(s2.code);
    const r2 = await w.quiz.submit(w.as(a), s2.attemptId, allRight(3));
    if (!r2.ok || !r2.attestation) throw new Error('attestation');
    const { document, fingerprint, attestationId } = r2.attestation;
    expect(document).toEqual({
      kind: 'aimmo.attestation-formation',
      version: 1,
      attestationId,
      networkId: w.network.id,
      agentId: a,
      scope: { kind: 'track', ref: 'vente' },
      modules: [
        { moduleId: m1, title: 'Module 1', durationMinutes: 30 },
        { moduleId: m2, title: 'Module 2', durationMinutes: 30 },
      ],
      ruleIds: ['R03', 'R13'],
      questionCount: 3,
      issuedOn: '2027-03-01',
    });
    expect(fingerprint).toBe(await fingerprintOf(document));
    expect(await verifyAttestation(w.db, document, fingerprint)).toEqual({ valid: true, attestationId, issuedOn: '2027-03-01' });
    // Le document relu depuis le réseau se vérifie aussi.
    const listed = await w.quiz.attestations(w.as(a), a);
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.value).toEqual([r2.attestation]);
    expect(await verifyAttestation(w.db, JSON.parse(JSON.stringify(listed.value[0]?.document)), fingerprint)).toMatchObject({ valid: true });
    clock = Date.parse('2027-03-01T09:00:00.000Z');
  });

  it('[R571] une attestation modifiée échoue à la vérification, même avec une empreinte recalculée', async () => {
    const w = await setup();
    const m = await w.module();
    const a = await w.newAgent('Gina');
    for (let i = 0; i < 3; i += 1) await w.question(m);
    await w.academie.complete(w.as(a), m);
    const s = await w.quiz.start(w.as(a), { moduleId: m });
    if (!s.ok) throw new Error(s.code);
    const r = await w.quiz.submit(w.as(a), s.attemptId, allRight(3));
    if (!r.ok || !r.attestation) throw new Error('attestation');
    const { document, fingerprint } = r.attestation;
    const changed: AttestationDocument[] = [
      { ...document, issuedOn: '2027-02-28' },
      { ...document, agentId: 'un-autre-agent' },
      { ...document, questionCount: document.questionCount + 1 },
      { ...document, modules: document.modules.map((x) => ({ ...x, durationMinutes: 480 })) },
      { ...document, modules: document.modules.map((x) => ({ ...x, title: `${x.title} ` })) },
    ];
    for (const d of changed) {
      expect(await verifyAttestation(w.db, d, fingerprint)).toEqual({ valid: false, reason: 'fingerprint_mismatch' });
      // Un faussaire qui recalcule l'empreinte ne trouve pas son document au réseau.
      expect(await verifyAttestation(w.db, d, await fingerprintOf(d))).toEqual({ valid: false, reason: 'not_issued_by_network' });
    }
    const flipped = fingerprint.slice(0, 63) + (fingerprint.endsWith('0') ? '1' : '0');
    expect(await verifyAttestation(w.db, document, flipped)).toEqual({ valid: false, reason: 'fingerprint_mismatch' });
    const invented = { ...document, attestationId: 'attestation-inventee' };
    expect(await verifyAttestation(w.db, invented, await fingerprintOf(invented))).toEqual({ valid: false, reason: 'unknown' });
    expect(await verifyAttestation(w.db, 'texte', fingerprint)).toEqual({ valid: false, reason: 'malformed' });
    expect(await verifyAttestation(w.db, document, 'pas-une-empreinte')).toEqual({ valid: false, reason: 'malformed' });
    expect(await verifyAttestation(w.db, { ...document, kind: 'autre' }, fingerprint)).toEqual({ valid: false, reason: 'malformed' });
    // Le document rangé est l'écriture canonique, et la base refuse de le changer.
    expect((await w.db.first<{ document: string }>('SELECT document FROM quiz_attestations'))?.document).toBe(canonicalJson(document));
    await expect(w.db.run("UPDATE quiz_attestations SET issued_on = '2027-01-01'")).rejects.toThrow(/ne change plus/);
    // La base refuse une attestation au nom d'un autre agent, ou sur un quiz raté.
    const b = await w.newAgent('Hector');
    const ins = 'INSERT INTO quiz_attestations (id, network_id, agent_id, attempt_id, issued_on, document, fingerprint, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    await expect(w.db.run(ins, ['att-faux', w.network.id, b, s.attemptId, '2027-03-01', '{}', '0'.repeat(64), 'x'])).rejects.toThrow(/pas de quiz rendu sans faute/);
    const s2 = await w.quiz.start(w.as(a), { moduleId: m });
    if (!s2.ok) throw new Error(s2.code);
    await w.quiz.submit(w.as(a), s2.attemptId, [0, 0, 0]);
    await expect(w.db.run(ins, ['att-faux-2', w.network.id, a, s2.attemptId, '2027-03-01', '{}', '0'.repeat(64), 'x'])).rejects.toThrow(/pas de quiz rendu sans faute/);
  });

  it('[R17] rien ne s\'efface ; une question rangée ne change plus, retirée elle ne sort plus aux nouveaux quiz', async () => {
    const w = await setup({ random: () => 0 });
    const m = await w.module();
    const a = await w.newAgent('Hugo');
    const q = [await w.question(m), await w.question(m), await w.question(m), await w.question(m)];
    const s1 = await w.quiz.start(w.as(a), { moduleId: m });
    if (!s1.ok) throw new Error(s1.code);
    expect(s1.questions.map((x) => x.questionId).sort()).toEqual([...q].sort());
    expect(await w.quiz.retireQuestion(w.as(a), q[0] as string)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.quiz.retireQuestion(w.dir, q[0] as string)).toEqual({ ok: true, already: false });
    expect(await w.quiz.retireQuestion(w.dir, q[0] as string)).toEqual({ ok: true, already: true });
    const s2 = await w.quiz.start(w.as(a), { moduleId: m });
    if (!s2.ok) throw new Error(s2.code);
    expect(s2.questions.map((x) => x.questionId)).not.toContain(q[0]);
    // Le quiz tiré avant le retrait se corrige toujours sur la question telle qu'elle était.
    expect((await w.quiz.submit(w.as(a), s1.attemptId, allRight(4))).ok).toBe(true);
    await w.quiz.retireQuestion(w.dir, q[1] as string);
    expect(await w.quiz.start(w.as(a), { moduleId: m })).toEqual({ ok: false, rule: null, code: 'not_enough_questions' });
    await expect(w.db.run('UPDATE quiz_questions SET correct_index = 0 WHERE id = ?', [q[2] as string])).rejects.toThrow(/ne change plus/);
    await expect(w.db.run("UPDATE quiz_questions SET prompt = 'Autre question inventée ?' WHERE id = ?", [q[2] as string])).rejects.toThrow(/ne change plus/);
    await expect(w.db.run("UPDATE quiz_questions SET retired_at = NULL, retired_by = NULL WHERE id = ?", [q[0] as string])).rejects.toThrow(/ne change plus/);
    await w.academie.complete(w.as(a), m);
    await w.question(m);
    const s3 = await w.quiz.start(w.as(a), { track: 'entree' });
    if (!s3.ok) throw new Error(s3.code);
    expect((await w.quiz.submit(w.as(a), s3.attemptId, allRight(3)))).toMatchObject({ ok: true, allRight: true });
    expect((await w.db.first<{ c: number }>('SELECT COUNT(*) AS c FROM quiz_attestations'))?.c).toBe(1);
    for (const t of ['quiz_attestations', 'quiz_attempts', 'quiz_questions']) {
      await expect(w.db.run(`DELETE FROM ${t}`)).rejects.toThrow(/rien ne s'efface/);
    }
  });

  it('le tirage : parcours ou module du réseau seulement, assez de questions, jamais deux fois la même, au plus le réglage', async () => {
    let seed = 7;
    const w = await setup({ random: () => ((seed = (seed * 9301 + 49297) % 233280) / 233280) });
    const m = await w.module();
    const a = await w.newAgent('Inès');
    expect(await w.quiz.start(w.as(a), { track: 'inconnu' })).toEqual({ ok: false, rule: null, code: 'invalid_scope' });
    expect(await w.quiz.start(w.as(a), { track: 'location' })).toEqual({ ok: false, rule: null, code: 'invalid_scope' });
    expect(await w.quiz.start(w.as(a), { moduleId: 'inconnu' })).toEqual({ ok: false, rule: null, code: 'invalid_scope' });
    await w.question(m);
    await w.question(m);
    expect(await w.quiz.start(w.as(a), { moduleId: m })).toEqual({ ok: false, rule: null, code: 'not_enough_questions' });
    for (let i = 0; i < 12; i += 1) await w.question(m);
    const s = await w.quiz.start(w.as(a), { track: 'entree' });
    if (!s.ok) throw new Error(s.code);
    expect(s.questions).toHaveLength(10);
    expect(new Set(s.questions.map((x) => x.questionId)).size).toBe(10);
    // Un agent d'un autre réseau ne tire pas les questions de celui-ci.
    const store = new FicheClient(w.db, {});
    const outsider = (await store.createAgent({ networkId: w.other.id, firstName: 'Jules', lastName: 'Test' })).id;
    expect(await w.quiz.start({ role: 'agent', userId: outsider, networkId: w.other.id }, { moduleId: m })).toEqual({ ok: false, rule: null, code: 'invalid_scope' });
  });

  it('les textes d\'une question sont vérifiés : énoncé, choix distincts, bonne réponse parmi les choix', async () => {
    const w = await setup();
    const m = await w.module();
    const ok = { moduleId: m, prompt: 'Une question inventée ?', choices: ['Oui', 'Non'], correctIndex: 0 };
    expect(await w.quiz.addQuestion(w.dir, { ...ok, prompt: 'Court ?' })).toEqual({ ok: false, rule: null, code: 'invalid_prompt' });
    expect(await w.quiz.addQuestion(w.dir, { ...ok, choices: ['Oui'] })).toEqual({ ok: false, rule: null, code: 'invalid_choices' });
    expect(await w.quiz.addQuestion(w.dir, { ...ok, choices: ['a', 'b', 'c', 'd', 'e', 'f'] })).toEqual({ ok: false, rule: null, code: 'invalid_choices' });
    expect(await w.quiz.addQuestion(w.dir, { ...ok, choices: ['Oui', ' '] })).toEqual({ ok: false, rule: null, code: 'invalid_choices' });
    expect(await w.quiz.addQuestion(w.dir, { ...ok, choices: ['Oui', 'oui'] })).toEqual({ ok: false, rule: null, code: 'duplicate_choices' });
    expect(await w.quiz.addQuestion(w.dir, { ...ok, correctIndex: 2 })).toEqual({ ok: false, rule: null, code: 'invalid_correct_index' });
    expect(await w.quiz.addQuestion(w.dir, { ...ok, correctIndex: '0' })).toEqual({ ok: false, rule: null, code: 'invalid_correct_index' });
  });
});
