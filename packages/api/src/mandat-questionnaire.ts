/**
 * Les routes du mandat par questionnaire (HX33), sous `/v1/questionnaire-mandat` (BR115).
 *
 * Chaque route dit les rôles qu'elle admet, contrôlés avant toute lecture du corps ; un refus est écrit au journal [R16].
 * La direction écrit le texte de chaque clause (une nouvelle version à chaque fois) et règle l'écart toléré ; la
 * conformité lit les versions et en valide une, jamais un texte qu'elle a écrit [R442] ; l'agent ou la direction
 * prépare le mandat depuis les réponses, chaque clause disant la réponse qui l'a déclenchée et son texte de loi [R440] ;
 * l'agent du bien dit avoir montré l'écart de prix au vendeur ; l'agent du bien, la direction et la conformité lisent
 * ce qui empêche encore de signer [R441]. Tout s'ajoute [R443]. Rien n'est envoyé : le mandat se signe par D03 et D08.
 * Un champ non prévu : 400 `unknown_field`. Le préfixe est à part pour ne croiser aucune route `/mandats/<id>`.
 */
import type { JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { Modeles, type Acces } from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';
import { CLAUSES, CLAUSE_CODES, DEFAULT_MAX_GAP_BPS, MandatQuestionnaire, QUESTIONS, QUESTION_CODES } from '../../core/src/mandat-questionnaire/questionnaire.ts';

export const TRIAL_MODE = 'essai';
/** Un texte de clause tient en 5 000 caractères ; en UTF-8, quatre octets au plus chacun, plus l'enveloppe. */
const CLAUSE_BODY_BYTES = 21_000;
const MAX_BODY_BYTES = 4_000;
const ID = '([A-Za-z0-9_-]{1,64})';
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface QuestionnaireServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface QuestionnaireRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: QuestionnaireServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule?: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits (404 pour un questionnaire inconnu) ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { ok: _ok, rule = null, ...rest } = result;
  if (result.code === 'unknown' || /^unknown_/.test(result.code)) return json(404, { ok: false, rule, ...rest });
  if (rule === 'R16') return json(403, { ok: false, rule, ...rest });
  if (rule === 'R442' || rule === 'R441') return json(409, { ok: false, rule, ...rest });
  return json(400, { ok: false, rule, ...rest });
}

async function readJson(request: Request, limit: number): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });

/** Le refus d'un rôle, écrit au journal comme ceux de la couche métier, avant que le corps soit lu [R16]. */
async function refuseRole(s: QuestionnaireServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'mandat_questionnaire', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

const questionnaire = (s: QuestionnaireServices): MandatQuestionnaire => new MandatQuestionnaire(s.db, s.acces, new Modeles(s.db, s.acces, s.journal, { now: s.now }), s.journal, { now: s.now });

type Role = 'agent' | 'direction' | 'compliance';

/** Les questions et les clauses, en liste fermée, avec le texte de loi de chaque clause [R440]. Aucune donnée du réseau. */
function catalogue(): unknown {
  return {
    questions: QUESTION_CODES.map((code) => ({
      code,
      label: QUESTIONS[code].label,
      answers: Object.entries(QUESTIONS[code].answers).map(([value, label]) => ({ value, label })),
    })),
    clauses: CLAUSE_CODES.map((code) => ({
      code,
      title: CLAUSES[code].title,
      basis: CLAUSES[code].basis,
      when: CLAUSES[code].when.map(([question, answer]) => ({ question, answer })),
    })),
    defaultMaxGapBps: DEFAULT_MAX_GAP_BPS,
  };
}

/** Les routes de `/v1/questionnaire-mandat`, à ajouter à celles de `app.ts`. */
export function questionnaireRoutes(): QuestionnaireRoute[] {
  /** Le rôle d'abord ; puis seulement le corps, avec ses champs prévus. */
  const withBody =
    (roles: readonly Role[], fields: readonly string[], limit: number, fn: (s: QuestionnaireServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Outcome | Response>): QuestionnaireRoute['handle'] =>
    async (s, v, params, request) => {
      if (!(roles as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      const body = await readJson(request, limit);
      if (!body) return badBody();
      const extra = Object.keys(body).find((k) => !fields.includes(k));
      if (extra !== undefined) return json(400, { ok: false, rule: null, code: 'unknown_field', field: extra });
      const out = await fn(s, v, params, body);
      return out instanceof Response ? out : reply(out);
    };
  /** Le rôle d'abord ; aucun paramètre de requête n'est admis. */
  const reading =
    (roles: readonly Role[], fn: (s: QuestionnaireServices, v: Viewer, params: string[]) => Promise<Outcome>): QuestionnaireRoute['handle'] =>
    async (s, v, params, request) => {
      if (!(roles as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      const extra = [...new URL(request.url).searchParams.keys()][0];
      if (extra !== undefined) return json(400, { ok: false, rule: null, code: 'unknown_field', field: extra });
      return reply(await fn(s, v, params));
    };
  const ALL: readonly Role[] = ['agent', 'direction', 'compliance'];
  const DIRECTION: readonly Role[] = ['direction'];
  const COMPLIANCE: readonly Role[] = ['compliance'];
  const WRITERS: readonly Role[] = ['direction', 'compliance'];
  const PREPARERS: readonly Role[] = ['agent', 'direction'];
  const AGENT: readonly Role[] = ['agent'];

  return [
    {
      method: 'GET',
      pattern: /^\/questionnaire-mandat$/,
      name: 'questionnaire_mandat.catalogue',
      handle: reading(ALL, async () => ({ ok: true, value: catalogue() })),
    },
    {
      method: 'GET',
      pattern: /^\/questionnaire-mandat\/clauses$/,
      name: 'questionnaire_mandat.clauses',
      handle: reading(WRITERS, async (s, v) => {
        const r = await questionnaire(s).clauseVersions(v);
        return r.ok ? { ok: true, value: r.versions } : r;
      }),
    },
    {
      method: 'POST',
      pattern: /^\/questionnaire-mandat\/clauses$/,
      name: 'questionnaire_mandat.clause_ecrire',
      handle: withBody(DIRECTION, ['code', 'body'], CLAUSE_BODY_BYTES, async (s, v, _p, b) => {
        if (typeof b.code !== 'string' || typeof b.body !== 'string') return { ok: false, rule: null, code: 'invalid_body' };
        const r = await questionnaire(s).writeClause(v, b.code, b.body);
        // Un code hors de la liste fermée est une faute de la demande, pas une ressource absente [R440].
        if (!r.ok && r.code === 'unknown_clause') return json(400, { ok: false, rule: 'R440', code: 'unknown_clause' });
        return r.ok ? { ok: true, value: { id: r.id, version: r.version } } : r;
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/questionnaire-mandat/clauses/${ID}/validation$`),
      name: 'questionnaire_mandat.clause_valider',
      handle: withBody(COMPLIANCE, [], MAX_BODY_BYTES, async (s, v, [clauseId]) => {
        const r = await questionnaire(s).validateClause(v, clauseId!);
        return r.ok ? { ok: true, value: null } : r;
      }),
    },
    {
      method: 'POST',
      pattern: /^\/questionnaire-mandat\/reglage$/,
      name: 'questionnaire_mandat.reglage',
      handle: withBody(DIRECTION, ['maxGapBps'], MAX_BODY_BYTES, async (s, v, _p, b) => {
        if (typeof b.maxGapBps !== 'number') return { ok: false, rule: 'R441', code: 'bad_setting' };
        const r = await questionnaire(s).setMaxGap(v, b.maxGapBps);
        if (!r.ok && r.code === 'bad_setting') return json(400, { ok: false, rule: 'R441', code: 'bad_setting' });
        return r.ok ? { ok: true, value: null } : r;
      }),
    },
    {
      method: 'POST',
      pattern: /^\/questionnaire-mandat\/mandats$/,
      name: 'questionnaire_mandat.preparer',
      handle: withBody(PREPARERS, ['personId', 'propertyId', 'answers', 'inputs'], MAX_BODY_BYTES, async (s, v, _p, b) => {
        if (typeof b.personId !== 'string' || !SAFE_ID.test(b.personId) || typeof b.propertyId !== 'string' || !SAFE_ID.test(b.propertyId)) {
          return json(400, { ok: false, rule: null, code: 'invalid_ids', message: 'personId et propertyId attendus.' });
        }
        if (b.inputs !== undefined && (b.inputs === null || typeof b.inputs !== 'object' || Array.isArray(b.inputs))) return { ok: false, rule: null, code: 'bad_input' };
        const r = await questionnaire(s).prepare(v, { personId: b.personId, propertyId: b.propertyId, answers: b.answers, ...(b.inputs === undefined ? {} : { inputs: b.inputs as never }) });
        if (r.ok) return { ok: true, value: r.mandate };
        // Des réponses hors liste ou un modèle absent ne sont pas des refus de droits : 400 et 409, rien de rangé.
        if (r.code === 'bad_answers') return json(400, { ok: false, rule: 'R440', code: 'bad_answers' });
        if (r.code === 'no_template') return json(409, { ok: false, rule: r.rule ?? null, code: 'no_template' });
        return r as Outcome;
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/questionnaire-mandat/mandats/${ID}/ecart-montre$`),
      name: 'questionnaire_mandat.ecart_montre',
      handle: withBody(AGENT, [], MAX_BODY_BYTES, async (s, v, [id]) => {
        const r = await questionnaire(s).acknowledgeGap(v, id!);
        return r.ok ? { ok: true, value: null } : r;
      }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/questionnaire-mandat/mandats/${ID}/avant-signature$`),
      name: 'questionnaire_mandat.avant_signature',
      handle: reading(ALL, async (s, v, [id]) => {
        const r = await questionnaire(s).beforeSignature(v, id!);
        return r.ok ? { ok: true, value: { ready: r.ready, blockers: r.blockers } } : r;
      }),
    },
  ];
}

