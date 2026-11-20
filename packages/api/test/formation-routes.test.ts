import { expect, it } from 'vitest';
import { FicheClient } from '@aimmo/core';
import { htmlProblems } from '../../core/src/design/audit.ts';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { renderAttestationPage } from '../src/formation.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseaux, agents, modules, vidéos, questions et clés inventés.
const KEYS = {
  alex: 'test-cle-br07-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br07-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br07-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br07-conformite-ddddddddddddddddddddd',
  partenaire: 'test-cle-br07-partenaire-eeeeeeeeeeeeeeeeeeeee',
  autre: 'test-cle-br07-autre-reseau-fffffffffffffffffffff',
};
type Who = keyof typeof KEYS;
type Body = { ok: boolean; data?: any; rule?: string | null; code?: string };

async function setup() {
  const t = await setupAnnonce();
  const other = (await new FicheClient(t.db).createNetwork('Autre réseau')).id;
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    sam: { role: 'agent', userId: t.sam.userId, networkId: t.network.id },
    direction: { role: 'direction', userId: t.direction.userId, networkId: t.network.id },
    conformite: { role: 'compliance', userId: 'conformite-1', networkId: t.network.id },
    partenaire: { role: 'partner', userId: 'partenaire-1', networkId: t.network.id },
    autre: { role: 'direction', userId: 'dir-9', networkId: other },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const raw = (path: string, init: RequestInit = {}) => handleRequest(new Request(`https://aimmo-api.example.test${path}`, init), config);
  const http = async (who: Who, method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await raw(`/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as Body };
  };
  let pos = 0;
  /** Un module de l'académie, rangé par la direction, avec trois questions dont la bonne réponse est le choix 1. */
  const module = async (track = 'entree') => {
    pos += 1;
    const m = await http('direction', 'POST', '/reseau/academie/modules', { title: `Module inventé ${pos}`, track, position: pos, videoId: `vid${String(pos).padStart(8, '0')}`, durationMinutes: 30 });
    if (m.status !== 200) throw new Error(`module ${m.body.code}`);
    const moduleId = (m.body as unknown as { moduleId: string }).moduleId;
    const questions: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const q = await http('direction', 'POST', '/formation/questions', { moduleId, ruleId: 'R13', prompt: `Question inventée ${pos}-${i} ?`, choices: ['Faux', 'Vrai', 'Peut-être'], correctIndex: 1 });
      if (q.status !== 200) throw new Error(`question ${q.body.code}`);
      questions.push(q.body.data.questionId as string);
    }
    return { moduleId, questions };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async (table: string) => Number((await t.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n);
  return { ...t, other, raw, http, module, refusals, count };
}

describeWithSqlite('BR07 · routes du quiz et des attestations de formation', () => {
  it('[R16] chaque route refuse le mauvais rôle, avant le corps : 403 et refus au journal, rien rangé', async () => {
    const t = await setup();
    const routes: [Who[], string, string, unknown?][] = [
      [['alex', 'conformite', 'partenaire'], 'POST', '/formation/questions', { moduleId: 'm' }],
      [['alex', 'conformite', 'partenaire'], 'POST', '/formation/questions/q-1/retrait'],
      [['direction', 'conformite', 'partenaire'], 'POST', '/formation/quiz', 'pas un objet'],
      [['direction', 'conformite', 'partenaire'], 'POST', '/formation/quiz/a-1/reponses', { answers: [1] }],
      [['conformite', 'partenaire'], 'GET', `/formation/agents/${t.alexId}/attestations`],
    ];
    for (const [whos, method, path, body] of routes) {
      for (const who of whos) {
        const before = (await t.refusals()).length;
        const r = await t.http(who, method, path, body);
        expect(r.status, `${who} ${method} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
        expect((await t.refusals()).length, `${who} ${method} ${path}`).toBe(before + 1);
      }
    }
    // Un agent ne lit pas les attestations d'un autre ; la couche métier le refuse et l'écrit.
    expect(await t.http('sam', 'GET', `/formation/agents/${t.alexId}/attestations`)).toMatchObject({ status: 403, body: { rule: 'R16' } });
    for (const table of ['quiz_questions', 'quiz_attempts', 'quiz_attestations']) expect(await t.count(table), table).toBe(0);
  });

  it('[R570] une question sans module ou citant une règle hors service est refusée ; une question se retire sans s’effacer', async () => {
    const t = await setup();
    const { moduleId, questions } = await t.module();
    const base = { prompt: 'Une question inventée ?', choices: ['Oui', 'Non'], correctIndex: 0 };
    expect(await t.http('direction', 'POST', '/formation/questions', { ...base, moduleId: 'module-inconnu' })).toMatchObject({ status: 409, body: { rule: 'R570', code: 'module_required' } });
    expect(await t.http('direction', 'POST', '/formation/questions', { ...base, moduleId, ruleId: 'R9999' })).toMatchObject({ status: 409, body: { rule: 'R570', code: 'rule_not_in_service' } });
    expect(await t.http('autre', 'POST', '/formation/questions', { ...base, moduleId })).toMatchObject({ status: 409, body: { code: 'module_required' } });
    expect(await t.http('direction', 'POST', '/formation/questions', { ...base, moduleId, note: 3 })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.http('direction', 'POST', `/formation/questions/${questions[0]}/retrait`)).toMatchObject({ status: 200, body: { data: { already: false } } });
    expect(await t.http('direction', 'POST', `/formation/questions/${questions[0]}/retrait`)).toMatchObject({ status: 200, body: { data: { already: true } } });
    expect(await t.http('autre', 'POST', `/formation/questions/${questions[1]}/retrait`)).toMatchObject({ status: 404 });
    expect(await t.count('quiz_questions')).toBe(3);
    // Avec deux questions en service, le quiz n'est pas tiré.
    expect(await t.http('alex', 'POST', '/formation/quiz', { moduleId })).toMatchObject({ status: 409, body: { code: 'not_enough_questions' } });
  });

  it('[R570] [R14] le quiz ne rend ni la bonne réponse, ni note, ni nombre de bonnes réponses : juste ou à revoir, avec le module', async () => {
    const t = await setup();
    const { moduleId } = await t.module();
    expect(await t.http('alex', 'POST', '/formation/quiz', { moduleId, track: 'entree' })).toMatchObject({ status: 400, body: { code: 'invalid_scope' } });
    expect(await t.http('alex', 'POST', '/formation/quiz', {})).toMatchObject({ status: 400, body: { code: 'invalid_scope' } });
    const q = await t.http('alex', 'POST', '/formation/quiz', { moduleId });
    expect(q.status).toBe(200);
    expect(q.body.data.questions).toHaveLength(3);
    expect(JSON.stringify(q.body)).not.toMatch(/correct|bonne|right/i);
    const attemptId = q.body.data.attemptId as string;
    // Un autre agent ne répond pas à ce quiz.
    expect(await t.http('sam', 'POST', `/formation/quiz/${attemptId}/reponses`, { answers: [1, 1, 1] })).toMatchObject({ status: 403, body: { rule: 'R16', code: 'not_owner' } });
    expect(await t.http('alex', 'POST', `/formation/quiz/${attemptId}/reponses`, { answers: [1] })).toMatchObject({ status: 400, body: { code: 'invalid_answers' } });
    const r = await t.http('alex', 'POST', `/formation/quiz/${attemptId}/reponses`, { answers: [0, 1, 1] });
    expect(r).toMatchObject({ status: 200, body: { data: { allRight: false, attestation: null } } });
    const wrong = (r.body.data.results as { right: boolean; review: any }[]).filter((x) => !x.right);
    expect(wrong).toHaveLength(1);
    expect(wrong[0]?.review).toMatchObject({ moduleId, ruleId: 'R13' });
    // Aucun nombre, aucune note, aucune bonne réponse dans ce qui est rendu.
    expect(JSON.stringify(r.body)).not.toMatch(/score|note|correct|count|percent|rang/i);
    // Une seule fois.
    expect(await t.http('alex', 'POST', `/formation/quiz/${attemptId}/reponses`, { answers: [1, 1, 1] })).toMatchObject({ status: 409, body: { code: 'already_submitted' } });
  });

  it('[R571] l’attestation ne sort que d’un quiz sans faute sur des modules tous faits ; la direction la lit, la page publique la vérifie au caractère près', async () => {
    const t = await setup();
    const { moduleId } = await t.module();
    // Module pas encore fait : sans faute, mais pas d'attestation.
    let q = await t.http('alex', 'POST', '/formation/quiz', { moduleId });
    let r = await t.http('alex', 'POST', `/formation/quiz/${q.body.data.attemptId}/reponses`, { answers: [1, 1, 1] });
    expect(r.body.data).toMatchObject({ allRight: true, attestation: null, modulesToDo: [{ moduleId }] });
    expect((await t.http('alex', 'POST', `/reseau/academie/modules/${moduleId}/fait`)).status).toBe(200);
    q = await t.http('alex', 'POST', '/formation/quiz', { moduleId });
    r = await t.http('alex', 'POST', `/formation/quiz/${q.body.data.attemptId}/reponses`, { answers: [1, 1, 1] });
    const attestation = r.body.data.attestation as { attestationId: string; fingerprint: string; document: Record<string, unknown> };
    expect(attestation.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // La direction et l'agent la lisent ; un autre réseau ne lit rien.
    expect((await t.http('direction', 'GET', `/formation/agents/${t.alexId}/attestations`)).body.data.attestations).toHaveLength(1);
    expect((await t.http('alex', 'GET', `/formation/agents/${t.alexId}/attestations`)).body.data.attestations).toHaveLength(1);
    expect((await t.http('autre', 'GET', `/formation/agents/${t.alexId}/attestations`)).body.data.attestations).toHaveLength(0);

    // La route publique, sans clé : valide, puis un seul caractère changé, ou une empreinte d'un faussaire, échouent.
    const verify = async (document: unknown, fingerprint: unknown) => {
      const res = await t.raw('/v1/formation/verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document, fingerprint }) });
      return { status: res.status, body: (await res.json()) as Body };
    };
    expect(await verify(attestation.document, attestation.fingerprint)).toMatchObject({ status: 200, body: { data: { valid: true } } });
    const changed = { ...attestation.document, questionCount: (attestation.document.questionCount as number) + 1 };
    expect((await verify(changed, attestation.fingerprint)).body.data).toEqual({ valid: false });
    const forger = await sha256Hex(JSON.stringify(changed));
    expect((await verify(changed, forger)).body.data).toEqual({ valid: false });
    expect((await verify('pas un document', 'x')).body.data).toEqual({ valid: false });
    // L'empreinte au caractère près : en capitales ou avec un espace, elle n'est plus la même.
    expect((await verify(attestation.document, attestation.fingerprint.toUpperCase())).body.data).toEqual({ valid: false });
    expect((await verify(attestation.document, ` ${attestation.fingerprint}`)).body.data).toEqual({ valid: false });
    // Aucune raison ni aucun nom rendu au public.
    expect(JSON.stringify((await verify(attestation.document, attestation.fingerprint)).body)).not.toContain(t.alexId);

    // La page publique : le formulaire, puis le verdict.
    const get = await t.raw('/attestation');
    expect(get.status).toBe(200);
    expect(get.headers.get('content-security-policy')).toContain("form-action 'self'");
    const post = async (document: string, empreinte: string) => (await t.raw('/attestation', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ document, empreinte }).toString() })).text();
    expect(await post(JSON.stringify(attestation.document), attestation.fingerprint)).toContain('Attestation valide.');
    const tampered = JSON.stringify(attestation.document).replace('Module inventé 1', 'Module inventé 2');
    expect(await post(tampered, attestation.fingerprint)).toContain('Attestation non reconnue.');
    expect(await post('{pas du json', attestation.fingerprint)).toContain('Lecture impossible.');
    expect(await post(JSON.stringify(attestation.document), attestation.fingerprint.toUpperCase())).toContain('Attestation non reconnue.');
    // Rien de ce qui est collé n'est rangé.
    expect(await t.count('quiz_attestations')).toBe(1);
  });

  it('[R201] la page de vérification suit le système de design : rien d’extérieur, aucun script, une étiquette par champ', () => {
    for (const page of [renderAttestationPage(), renderAttestationPage({ document: '<script>x</script>', fingerprint: '"><b>', result: { valid: false } }), renderAttestationPage({ result: { valid: true, issuedOn: '2027-03-01' } })]) {
      expect(htmlProblems(page)).toEqual([]);
      expect(page).not.toContain('<script>x');
      expect(page).not.toContain('"><b>');
    }
    expect(renderAttestationPage({ result: { valid: true, issuedOn: '2027-03-01' } })).toContain('1er mars 2027');
  });

  it('[R82] un agent au dossier incomplet garde le quiz de sa formation et ses attestations', async () => {
    const { OPEN_WITHOUT_AGENT_FILE } = await import('../src/app.ts');
    for (const name of ['formation.quiz', 'formation.reponses', 'formation.attestations']) expect(OPEN_WITHOUT_AGENT_FILE.has(name), name).toBe(true);
    for (const name of ['formation.question', 'formation.question.retrait']) expect(OPEN_WITHOUT_AGENT_FILE.has(name), name).toBe(false);
  });

  it('[R85] [R16] AU028 la direction reprend le cycle d’avant l’arrivée par l’API ; l’agent lit son compteur qui le continue', async () => {
    const t = await setup();
    const base = `/reseau/agents/${t.alexId}/formation`;
    const periode = { cycleStart: '2015-01-01', proofRef: 'pieces/cycle-invente.pdf', recorderName: 'Direction inventée' };
    expect((await t.http('alex', 'POST', `${base}/periode-anterieure`, periode)).status).toBe(403);
    expect((await t.http('alex', 'POST', `${base}/anterieures`, { heldOn: '2015-03-01', durationMinutes: 60, proofRef: 'p', recorderName: 'Moi' })).status).toBe(403);
    expect(await t.count('academy_prior_entries')).toBe(0);
    expect((await t.http('direction', 'POST', `${base}/periode-anterieure`, { ...periode, extra: 1 })).status).toBe(400);
    expect((await t.http('direction', 'POST', `${base}/periode-anterieure`, periode)).status).toBe(200);
    const r = await t.http('direction', 'POST', `${base}/anterieures`, { heldOn: '2015-03-01', durationMinutes: 60, topic: 'deontologie', proofRef: 'pieces/formation-inventee.pdf', recorderName: 'Direction inventée' });
    expect(r.status).toBe(200);
    expect(await t.count('academy_prior_entries')).toBe(2);
    const c = await t.http('alex', 'GET', '/reseau/ma-formation');
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({ startedOn: '2015-01-01', periodSource: 'cycle_anterieur' });
  });
});
