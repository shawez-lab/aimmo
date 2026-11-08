/**
 * Quiz et attestations de formation (M14, HX63) [R570, R571, R14, R16, R17].
 *
 * La direction range des questions courtes. Chacune renvoie au module de l'académie (J06) qui l'enseigne, et souvent à
 * une règle en service du réseau, prise dans le catalogue tiré de `docs/REGLES.md` : une question sans module, ou qui
 * cite une règle hors service, est refusée. Une question rangée ne change plus ; elle peut être retirée, jamais effacée.
 *
 * L'agent tire un quiz sur un parcours ou un module : les questions viennent des seules questions en service de ce
 * parcours, sans la bonne réponse. Il répond une fois. Chaque réponse est juste ou à revoir ; une réponse à revoir
 * renvoie au module à revoir (sa vidéo) et à sa règle, sans donner la bonne réponse, pour que le quiz suivant compte.
 * Aucune note, aucun pourcentage, aucun rang : l'académie forme, elle ne note pas [R14]. Les réponses ne se lisent que
 * par l'agent lui-même, jamais par la direction [R16].
 *
 * Jamais vu : un quiz réussi sans faute, sur des modules tous faits, donne une attestation conservée, dont le document
 * en écriture canonique porte son empreinte SHA-256. N'importe qui qui détient le document le vérifie : un seul
 * caractère changé, ou une attestation que le réseau n'a pas rangée, échoue [R571]. Au journal, des identifiants et des
 * nombres seulement [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import { localTime } from '../envoi/horaires.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { runBatch } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { canonicalJson, fingerprintOf } from '../rapports/export-agent.ts';
import { ACADEMY_TRACKS, type AcademyTrack } from '../reseau/academie.ts';
import { RULE_CATALOG } from './catalogue-regles.ts';

const TIME_ZONE = 'Europe/Paris';

export const ATTESTATION_KIND = 'aimmo.attestation-formation';
export const ATTESTATION_VERSION = 1;

export interface QuizSettings {
  /** Nombre de questions tirées au plus par quiz. */
  questionsPerQuiz: number;
  /** En dessous, le quiz n'est pas tiré : trop peu de questions pour former. */
  minQuestions: number;
}

export const QUIZ_SETTINGS: Readonly<QuizSettings> = Object.freeze({ questionsPerQuiz: 10, minQuestions: 3 });

export type QuizRefusal = { ok: false; rule: 'R16' | 'R570' | null; code: string };

export type QuizScope = { track: string } | { moduleId: string };

export interface DrawnQuestion {
  questionId: string;
  prompt: string;
  choices: string[];
}

/** Ce qu'il faut revoir après une réponse à revoir : le module, sa vidéo, et la règle quand la question en cite une. */
export interface ToReview {
  moduleId: string;
  moduleTitle: string;
  videoId: string;
  ruleId: string | null;
  /** Titre de la règle, ou `null` si elle n'est plus en service. */
  ruleTitle: string | null;
}

export interface AnswerResult {
  questionId: string;
  right: boolean;
  review: ToReview | null;
}

export interface AttestationDocument {
  kind: typeof ATTESTATION_KIND;
  version: typeof ATTESTATION_VERSION;
  attestationId: string;
  networkId: string;
  agentId: string;
  scope: { kind: 'track' | 'module'; ref: string };
  modules: { moduleId: string; title: string; durationMinutes: number }[];
  ruleIds: string[];
  questionCount: number;
  issuedOn: string;
}

export interface Attestation {
  attestationId: string;
  fingerprint: string;
  document: AttestationDocument;
}

export interface SubmitResult {
  ok: true;
  /** Vrai seulement si chaque réponse est juste ; aucun nombre de bonnes réponses n'est rendu ni gardé [R14]. */
  allRight: boolean;
  results: AnswerResult[];
  /** Modules du quiz pas encore marqués faits : sans eux, pas d'attestation. */
  modulesToDo: { moduleId: string; title: string }[];
  attestation: Attestation | null;
}

export type Verification =
  | { valid: true; attestationId: string; issuedOn: string }
  | { valid: false; reason: 'malformed' | 'fingerprint_mismatch' | 'unknown' | 'not_issued_by_network' };

export interface FormationQuizOptions {
  now?: () => Date;
  newId?: () => string;
  /** Tirage, dans [0, 1). */
  random?: () => number;
  settings?: QuizSettings;
  /** Règles en service auxquelles une question peut renvoyer : le numéro et le titre. */
  rules?: ReadonlyMap<string, string>;
}

interface ModuleRow {
  id: string;
  title: string;
  video_id: string;
  duration_minutes: number;
  position: number;
}

interface QuestionRow {
  id: string;
  module_id: string;
  rule_id: string | null;
  prompt: string;
  choices: string;
  correct_index: number;
}

interface AttemptRow {
  id: string;
  network_id: string;
  agent_id: string;
  scope_kind: 'track' | 'module';
  scope_ref: string;
  question_ids: string;
  submitted_at: string | null;
}

const text = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length >= min && t.length <= max ? t : null;
};

const HEX64 = /^[0-9a-f]{64}$/;

export class FormationQuiz {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly random: () => number;
  private readonly settings: QuizSettings;
  private readonly rules: ReadonlyMap<string, string>;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: FormationQuizOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.random = options.random ?? Math.random;
    this.settings = options.settings ?? QUIZ_SETTINGS;
    this.rules = options.rules ?? RULE_CATALOG;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string | null, kind: string, code: string): Promise<QuizRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async activeAgent(viewer: Viewer): Promise<boolean> {
    if (viewer.role !== 'agent') return false;
    const row = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    return row?.status === 'active';
  }

  /** La direction range une question : son module à revoir, sa règle s'il y en a une, ses choix et la bonne réponse [R570]. */
  async addQuestion(
    viewer: Viewer,
    input: { moduleId: unknown; ruleId?: unknown; prompt: unknown; choices: unknown; correctIndex: unknown },
  ): Promise<{ ok: true; questionId: string } | QuizRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'quiz_question', 'role');
    if (typeof input.moduleId !== 'string') return { ok: false, rule: 'R570', code: 'module_required' };
    const module = await this.db.first<{ id: string }>('SELECT id FROM academy_modules WHERE id = ? AND network_id = ?', [input.moduleId, viewer.networkId]);
    if (!module) return { ok: false, rule: 'R570', code: 'module_required' };
    const ruleId = input.ruleId === undefined || input.ruleId === null ? null : input.ruleId;
    if (ruleId !== null && (typeof ruleId !== 'string' || !this.rules.has(ruleId))) return { ok: false, rule: 'R570', code: 'rule_not_in_service' };
    const prompt = text(input.prompt, 10, 300);
    if (!prompt) return { ok: false, rule: null, code: 'invalid_prompt' };
    if (!Array.isArray(input.choices) || input.choices.length < 2 || input.choices.length > 5) return { ok: false, rule: null, code: 'invalid_choices' };
    const choices = input.choices.map((c) => text(c, 1, 120));
    if (choices.some((c) => c === null)) return { ok: false, rule: null, code: 'invalid_choices' };
    if (new Set(choices.map((c) => (c as string).toLowerCase())).size !== choices.length) return { ok: false, rule: null, code: 'duplicate_choices' };
    const correct = input.correctIndex;
    if (!Number.isInteger(correct) || (correct as number) < 0 || (correct as number) >= choices.length) return { ok: false, rule: null, code: 'invalid_correct_index' };
    const id = this.newId();
    await this.db.run(
      'INSERT INTO quiz_questions (id, network_id, module_id, rule_id, prompt, choices, correct_index, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, module.id, ruleId as string | null, prompt, JSON.stringify(choices), correct as number, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'formation.question', actor: this.actor(viewer), subject: `quiz_question:${id}`, data: { module: module.id, rule: ruleId as string | null } }, this.now);
    return { ok: true, questionId: id };
  }

  /** La direction retire une question : elle ne sort plus aux nouveaux quiz, et reste lue par les quiz déjà tirés. */
  async retireQuestion(viewer: Viewer, questionId: string): Promise<{ ok: true; already: boolean } | QuizRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `quiz_question:${questionId}`, 'quiz_question', 'role');
    const row = await this.db.first<{ retired_at: string | null }>('SELECT retired_at FROM quiz_questions WHERE id = ? AND network_id = ?', [questionId, viewer.networkId]);
    if (!row) return { ok: false, rule: null, code: 'not_found' };
    if (row.retired_at !== null) return { ok: true, already: true };
    const { changes } = await this.db.run('UPDATE quiz_questions SET retired_at = ?, retired_by = ? WHERE id = ? AND network_id = ? AND retired_at IS NULL', [
      this.now().toISOString(),
      this.actor(viewer),
      questionId,
      viewer.networkId,
    ]);
    if (changes === 1) await appendEvent(this.journal, { type: 'formation.question_retiree', actor: this.actor(viewer), subject: `quiz_question:${questionId}`, data: {} }, this.now);
    return { ok: true, already: changes !== 1 };
  }

  private async scopeModules(networkId: string, scope: QuizScope): Promise<{ kind: 'track' | 'module'; ref: string; modules: ModuleRow[] } | null> {
    if ('track' in scope) {
      if (typeof scope.track !== 'string' || !(ACADEMY_TRACKS as readonly string[]).includes(scope.track)) return null;
      const modules = await this.db.all<ModuleRow>(
        'SELECT id, title, video_id, duration_minutes, position FROM academy_modules WHERE network_id = ? AND track = ? ORDER BY position, id',
        [networkId, scope.track as AcademyTrack],
      );
      return { kind: 'track', ref: scope.track, modules };
    }
    if (typeof scope.moduleId !== 'string') return null;
    const module = await this.db.first<ModuleRow>('SELECT id, title, video_id, duration_minutes, position FROM academy_modules WHERE id = ? AND network_id = ?', [
      scope.moduleId,
      networkId,
    ]);
    return module ? { kind: 'module', ref: module.id, modules: [module] } : null;
  }

  /** L'agent en activité tire un quiz sur un parcours ou un module : les questions en service, sans la bonne réponse. */
  async start(viewer: Viewer, scope: QuizScope): Promise<{ ok: true; attemptId: string; questions: DrawnQuestion[] } | QuizRefusal> {
    if (!(await this.activeAgent(viewer))) return this.refuse(viewer, null, 'quiz_attempt', 'role');
    const resolved = await this.scopeModules(viewer.networkId, scope);
    if (!resolved || resolved.modules.length === 0) return { ok: false, rule: null, code: 'invalid_scope' };
    const ids = resolved.modules.map((m) => m.id);
    const pool = await this.db.all<QuestionRow>(
      `SELECT id, module_id, rule_id, prompt, choices, correct_index FROM quiz_questions
       WHERE network_id = ? AND retired_at IS NULL AND module_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`,
      [viewer.networkId, ...ids],
    );
    if (pool.length < this.settings.minQuestions) return { ok: false, rule: null, code: 'not_enough_questions' };
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.min(i, Math.floor(this.random() * (i + 1)));
      [pool[i], pool[j]] = [pool[j] as QuestionRow, pool[i] as QuestionRow];
    }
    const drawn = pool.slice(0, this.settings.questionsPerQuiz);
    const id = this.newId();
    await this.db.run('INSERT INTO quiz_attempts (id, network_id, agent_id, scope_kind, scope_ref, question_ids, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      viewer.userId,
      resolved.kind,
      resolved.ref,
      JSON.stringify(drawn.map((q) => q.id)),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'formation.quiz', actor: this.actor(viewer), subject: `quiz_attempt:${id}`, data: { questions: drawn.length } }, this.now);
    return { ok: true, attemptId: id, questions: drawn.map((q) => ({ questionId: q.id, prompt: q.prompt, choices: JSON.parse(q.choices) as string[] })) };
  }

  /**
   * L'agent range ses réponses, une seule fois. Chaque réponse à revoir renvoie à son module et à sa règle. Sans faute,
   * et si chaque module du quiz est fait, l'attestation est rangée avec son empreinte, dans la même écriture [R571].
   */
  async submit(viewer: Viewer, attemptId: string, answers: unknown): Promise<SubmitResult | QuizRefusal> {
    if (!(await this.activeAgent(viewer))) return this.refuse(viewer, `quiz_attempt:${attemptId}`, 'quiz_attempt', 'role');
    const attempt = await this.db.first<AttemptRow>(
      'SELECT id, network_id, agent_id, scope_kind, scope_ref, question_ids, submitted_at FROM quiz_attempts WHERE id = ? AND network_id = ?',
      [attemptId, viewer.networkId],
    );
    if (!attempt) return { ok: false, rule: null, code: 'not_found' };
    if (attempt.agent_id !== viewer.userId) return this.refuse(viewer, `quiz_attempt:${attemptId}`, 'quiz_attempt', 'not_owner');
    if (attempt.submitted_at !== null) return { ok: false, rule: null, code: 'already_submitted' };
    const questionIds = JSON.parse(attempt.question_ids) as string[];
    if (!Array.isArray(answers) || answers.length !== questionIds.length) return { ok: false, rule: null, code: 'invalid_answers' };
    const rows = await this.db.all<QuestionRow & { title: string; video_id: string }>(
      `SELECT q.id, q.module_id, q.rule_id, q.prompt, q.choices, q.correct_index, m.title, m.video_id
       FROM quiz_questions q JOIN academy_modules m ON m.id = q.module_id
       WHERE q.network_id = ? AND q.id IN (${questionIds.map(() => '?').join(', ')})`,
      [viewer.networkId, ...questionIds],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const results: AnswerResult[] = [];
    for (let i = 0; i < questionIds.length; i += 1) {
      const q = byId.get(questionIds[i] as string);
      if (!q) throw new Error('Question du quiz introuvable.');
      const a = answers[i];
      const count = (JSON.parse(q.choices) as string[]).length;
      if (!Number.isInteger(a) || (a as number) < 0 || (a as number) >= count) return { ok: false, rule: null, code: 'invalid_answers' };
      const right = a === q.correct_index;
      results.push({
        questionId: q.id,
        right,
        review: right ? null : { moduleId: q.module_id, moduleTitle: q.title, videoId: q.video_id, ruleId: q.rule_id, ruleTitle: q.rule_id === null ? null : (this.rules.get(q.rule_id) ?? null) },
      });
    }
    const allRight = results.every((r) => r.right);
    const resolved =
      attempt.scope_kind === 'track' ? await this.scopeModules(viewer.networkId, { track: attempt.scope_ref }) : await this.scopeModules(viewer.networkId, { moduleId: attempt.scope_ref });
    const modules = resolved?.modules ?? [];
    const done = new Set(
      (await this.db.all<{ module_id: string }>('SELECT module_id FROM academy_completions WHERE agent_id = ? AND network_id = ?', [viewer.userId, viewer.networkId])).map((r) => r.module_id),
    );
    const modulesToDo = modules.filter((m) => !done.has(m.id)).map((m) => ({ moduleId: m.id, title: m.title }));

    const at = this.now();
    const submittedAt = at.toISOString();
    const answersJson = JSON.stringify(answers);
    const statements = [
      {
        sql: 'UPDATE quiz_attempts SET answers = ?, all_right = ?, submitted_at = ? WHERE id = ? AND network_id = ? AND agent_id = ? AND submitted_at IS NULL',
        params: [answersJson, allRight ? 1 : 0, submittedAt, attempt.id, viewer.networkId, viewer.userId],
      },
    ];
    let attestation: Attestation | null = null;
    if (allRight && modules.length > 0 && modulesToDo.length === 0) {
      const attestationId = this.newId();
      const document: AttestationDocument = {
        kind: ATTESTATION_KIND,
        version: ATTESTATION_VERSION,
        attestationId,
        networkId: viewer.networkId,
        agentId: viewer.userId,
        scope: { kind: attempt.scope_kind, ref: attempt.scope_ref },
        modules: modules.map((m) => ({ moduleId: m.id, title: m.title, durationMinutes: m.duration_minutes })),
        ruleIds: [...new Set(rows.map((r) => r.rule_id).filter((r): r is string => r !== null))].sort(),
        questionCount: questionIds.length,
        issuedOn: localTime(at, TIME_ZONE).date,
      };
      const fingerprint = await fingerprintOf(document);
      // Rangée seulement si ces réponses-là viennent d'être rangées, dans la même écriture : jamais deux, jamais sans quiz.
      statements.push({
        sql: `INSERT INTO quiz_attestations (id, network_id, agent_id, attempt_id, issued_on, document, fingerprint, issued_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
                SELECT 1 FROM quiz_attempts WHERE id = ? AND agent_id = ? AND submitted_at = ? AND answers = ? AND all_right = 1)
              ON CONFLICT (attempt_id) DO NOTHING`,
        params: [attestationId, viewer.networkId, viewer.userId, attempt.id, document.issuedOn, canonicalJson(document), fingerprint, submittedAt, attempt.id, viewer.userId, submittedAt, answersJson],
      });
      attestation = { attestationId, fingerprint, document };
    }
    const [updated] = await runBatch(this.db, statements);
    if (updated?.changes !== 1) return { ok: false, rule: null, code: 'already_submitted' };
    if (attestation) {
      const stored = await this.db.first<{ id: string }>('SELECT id FROM quiz_attestations WHERE attempt_id = ?', [attempt.id]);
      if (stored?.id !== attestation.attestationId) attestation = null;
    }
    await appendEvent(this.journal, { type: 'formation.reponses', actor: this.actor(viewer), subject: `quiz_attempt:${attempt.id}`, data: { questions: questionIds.length } }, this.now);
    if (attestation) {
      await appendEvent(this.journal, { type: 'formation.attestation', actor: this.actor(viewer), subject: `quiz_attestation:${attestation.attestationId}`, data: { modules: modules.length } }, this.now);
    }
    return { ok: true, allRight, results, modulesToDo, attestation };
  }

  /** Les attestations d'un agent : à lui-même, ou à la direction de son réseau [R16]. Aucune réponse ni aucun quiz raté. */
  async attestations(viewer: Viewer, agentId: string): Promise<{ ok: true; value: Attestation[] } | QuizRefusal> {
    const self = viewer.role === 'agent' && viewer.userId === agentId;
    if (!self && viewer.role !== 'direction') return this.refuse(viewer, `agent:${agentId}`, 'quiz_attestation', 'role');
    const rows = await this.db.all<{ id: string; document: string; fingerprint: string }>(
      'SELECT id, document, fingerprint FROM quiz_attestations WHERE network_id = ? AND agent_id = ? ORDER BY issued_at, id',
      [viewer.networkId, agentId],
    );
    return { ok: true, value: rows.map((r) => ({ attestationId: r.id, fingerprint: r.fingerprint, document: JSON.parse(r.document) as AttestationDocument })) };
  }
}

/**
 * Vérifie une attestation présentée : son empreinte recalculée sur son écriture canonique, puis l'attestation rangée par
 * le réseau sous le même numéro, la même empreinte et le même document. Ne rend rien d'autre que valide ou non, et le
 * jour de délivrance [R571].
 */
export async function verifyAttestation(db: SqlDatabase, document: unknown, fingerprint: unknown): Promise<Verification> {
  if (typeof fingerprint !== 'string' || !HEX64.test(fingerprint)) return { valid: false, reason: 'malformed' };
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return { valid: false, reason: 'malformed' };
  const doc = document as Partial<AttestationDocument>;
  if (doc.kind !== ATTESTATION_KIND || typeof doc.attestationId !== 'string') return { valid: false, reason: 'malformed' };
  let computed: string;
  try {
    computed = await fingerprintOf(document);
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (computed !== fingerprint) return { valid: false, reason: 'fingerprint_mismatch' };
  const row = await db.first<{ fingerprint: string; document: string; issued_on: string }>('SELECT fingerprint, document, issued_on FROM quiz_attestations WHERE id = ?', [doc.attestationId]);
  if (!row) return { valid: false, reason: 'unknown' };
  if (row.fingerprint !== fingerprint || row.document !== canonicalJson(document)) return { valid: false, reason: 'not_issued_by_network' };
  return { valid: true, attestationId: doc.attestationId, issuedOn: row.issued_on };
}
