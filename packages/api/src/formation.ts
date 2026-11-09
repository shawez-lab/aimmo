/**
 * Les routes du quiz et des attestations de formation (HX63), sous `/v1/formation` (BR07), et la page publique de
 * vérification d'une attestation, `/attestation`.
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps soit lu
 * [R16]. La couche métier refait ses contrôles derrière : la direction seule range ou retire une question, liée à un
 * module de l'académie et, s'il y en a une, à une règle en service [R570] ; l'agent en activité seul tire un quiz et y
 * répond, une fois. Aucune note, aucun nombre de bonnes réponses, aucune bonne réponse n'est rendu : chaque réponse est
 * juste ou à revoir, avec son module [R570, R14]. Un quiz sans faute sur des modules tous faits donne une attestation,
 * vérifiable au caractère près par son empreinte [R571].
 *
 * La vérification est publique et ne lit rien d'autre que l'attestation rangée sous ce numéro : elle ne dit que
 * « valide » ou non, et le jour de délivrance [R571, R13].
 */
import { appendEvent, renderPublicPage, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { FormationQuiz, verifyAttestation, type QuizScope } from '../../core/src/formation/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
/** Une attestation tient en quelques ko ; la vérification admet un peu plus, jamais un gros fichier. */
const MAX_VERIFY_BYTES = 32_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface FormationServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

type Role = Viewer['role'];
const DIRECTION: readonly Role[] = ['direction'];
const AGENT: readonly Role[] = ['agent'];
const AGENT_OR_DIRECTION: readonly Role[] = ['agent', 'direction'];

export interface FormationRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: FormationServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 404 introuvable ; 409 pour une règle ou un état ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, ...data } = result as Record<string, unknown>;
    return json(200, { ok: true, mode: TRIAL_MODE, data });
  }
  const { rule, code } = result;
  if (rule === 'R16') return json(403, { ok: false, rule, code });
  if (code === 'not_found') return json(404, { ok: false, rule, code });
  if (rule || code === 'already_submitted' || code === 'not_enough_questions') return json(409, { ok: false, rule, code });
  return json(400, { ok: false, rule, code });
}

async function readJson(request: Request, max = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const unknownField = (): Response => json(400, { ok: false, rule: null, code: 'unknown_field' });

type Handler = (s: FormationServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>;
/** Un corps JSON qui ne porte que les clés prévues ; une autre est refusée sans rien ranger. */
const withBody =
  (keys: readonly string[], fn: Handler): FormationRoute['handle'] =>
  async (s, v, params, request) => {
    const body = await readJson(request);
    if (!body) return badBody();
    if (Object.keys(body).some((k) => !keys.includes(k))) return unknownField();
    return fn(s, v, params, body);
  };

const quiz = (s: FormationServices) => new FormationQuiz(s.db, s.journal, { now: s.now });

/** Les routes de `/v1/formation`, à ajouter à celles de `app.ts`. */
export function formationRoutes(): FormationRoute[] {
  const P = '^/formation';
  const routes: FormationRoute[] = [
    // La direction range une question, liée à un module et, s'il y en a une, à une règle en service [R570].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/questions$`),
      name: 'formation.question',
      roles: DIRECTION,
      handle: withBody(['moduleId', 'ruleId', 'prompt', 'choices', 'correctIndex'], async (s, v, _p, b) =>
        reply(await quiz(s).addQuestion(v, { moduleId: b.moduleId, ruleId: b.ruleId, prompt: b.prompt, choices: b.choices, correctIndex: b.correctIndex })),
      ),
    },
    // Retirée, jamais effacée : elle ne sort plus aux nouveaux quiz [R17].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/questions/${ID}/retrait$`),
      name: 'formation.question.retrait',
      roles: DIRECTION,
      handle: async (s, v, [id]) => reply(await quiz(s).retireQuestion(v, id!)),
    },
    // L'agent tire un quiz sur un parcours ou un module : les questions sans la bonne réponse [R570].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/quiz$`),
      name: 'formation.quiz',
      roles: AGENT,
      handle: withBody(['track', 'moduleId'], async (s, v, _p, b) => {
        const hasTrack = b.track !== undefined;
        const hasModule = b.moduleId !== undefined;
        if (hasTrack === hasModule) return json(400, { ok: false, rule: null, code: 'invalid_scope', message: 'Un parcours ou un module, un seul.' });
        const scope = (hasTrack ? { track: b.track } : { moduleId: b.moduleId }) as QuizScope;
        return reply(await quiz(s).start(v, scope));
      }),
    },
    // Ses réponses, une fois : juste ou à revoir, avec le module à revoir ; aucune note ni bonne réponse [R570, R14].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/quiz/${ID}/reponses$`),
      name: 'formation.reponses',
      roles: AGENT,
      handle: withBody(['answers'], async (s, v, [id], b) => reply(await quiz(s).submit(v, id!, b.answers))),
    },
    // Les attestations d'un agent : à lui-même, ou à la direction de son réseau [R16, R571].
    {
      method: 'GET',
      pattern: new RegExp(`${P}/agents/${ID}/attestations$`),
      name: 'formation.attestations',
      roles: AGENT_OR_DIRECTION,
      handle: async (s, v, [id]) => {
        const result = await quiz(s).attestations(v, id!);
        if (!result.ok) return reply(result);
        return json(200, { ok: true, mode: TRIAL_MODE, data: { attestations: result.value } });
      },
    },
  ];
  return routes.map((route) => ({
    ...route,
    handle: async (s, v, params, request) => {
      if (!route.roles.includes(v.role)) {
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R16', role: String(v.role), kind: route.name, code: 'role' } }, s.now);
        return json(403, { ok: false, rule: 'R16', code: 'role' });
      }
      return route.handle(s, v, params, request);
    },
  }));
}

// ---------------------------------------------------------------- vérification publique

export const ATTESTATION_VERIFY_PATH = '/v1/formation/verification';
export const ATTESTATION_PAGE_PATH = '/attestation';

/** Ce qu'un tiers apprend : valide ou non, et le jour de délivrance. Jamais pourquoi, jamais qui [R571, R13]. */
type PublicVerdict = { valid: true; issuedOn: string } | { valid: false };

async function verdict(db: SqlDatabase, document: unknown, fingerprint: unknown): Promise<PublicVerdict> {
  const v = await verifyAttestation(db, document, typeof fingerprint === 'string' ? fingerprint.trim().toLowerCase() : fingerprint);
  return v.valid ? { valid: true, issuedOn: v.issuedOn } : { valid: false };
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function frenchDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${Number(m[3])}${Number(m[3]) === 1 ? 'er' : ''} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1]}`;
}

const PAGE_TITLE = 'Vérifier une attestation de formation';

/** La page entière, pour la servir et pour le contrôle du système de design [R201]. */
export function renderAttestationPage(o: { document?: string; fingerprint?: string; result?: PublicVerdict | 'unreadable' } = {}): string {
  let outcome = '';
  if (o.result === 'unreadable') {
    outcome = '<p role="status"><strong>Lecture impossible.</strong> Collez le document de l’attestation tel qu’il vous a été remis, et son empreinte.</p>';
  } else if (o.result?.valid) {
    outcome = `<p role="status"><strong>Attestation valide.</strong> Elle a été délivrée par le réseau le ${escape(frenchDate(o.result.issuedOn))}, et le document est exactement celui qu’il a rangé.</p>`;
  } else if (o.result) {
    outcome = '<p role="status"><strong>Attestation non reconnue.</strong> Le document a été changé, l’empreinte ne correspond pas, ou le réseau n’a jamais délivré cette attestation.</p>';
  }
  const body =
    `${outcome}<p>Collez le document de l’attestation et son empreinte. Un seul caractère changé suffit à la rendre non reconnue.</p>` +
    `<form method="post" action="${ATTESTATION_PAGE_PATH}">` +
    `<label for="document">Document de l’attestation</label><textarea id="document" name="document" required spellcheck="false" autocomplete="off">${escape(o.document ?? '')}</textarea>` +
    `<label for="empreinte">Empreinte (64 caractères)</label><input id="empreinte" name="empreinte" required inputmode="text" autocomplete="off" spellcheck="false" maxlength="80" value="${escape(o.fingerprint ?? '')}">` +
    '<button type="submit">Vérifier</button></form>' +
    '<p class="doux">Rien de ce que vous collez n’est gardé.</p>';
  return renderPublicPage({ title: PAGE_TITLE, body, kicker: 'Attestation de formation' });
}

function html(status: number, page: string): Response {
  return new Response(page, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
  });
}

/**
 * La vérification publique : la route JSON `POST /v1/formation/verification` (`{document, fingerprint}`) et la page
 * `/attestation`. Sans clé, sans rien ranger. `null` si l'adresse n'en est pas une.
 */
export async function handleAttestationPublic(request: Request, s: { db: SqlDatabase }): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === ATTESTATION_VERIFY_PATH) {
    if (request.method !== 'POST') return json(405, { ok: false, rule: null, code: 'method_not_allowed' });
    const body = await readJson(request, MAX_VERIFY_BYTES);
    if (!body) return badBody();
    if (Object.keys(body).some((k) => k !== 'document' && k !== 'fingerprint')) return unknownField();
    return json(200, { ok: true, data: await verdict(s.db, body.document, body.fingerprint) });
  }
  if (path !== ATTESTATION_PAGE_PATH) return null;
  if (request.method === 'GET') return html(200, renderAttestationPage());
  if (request.method !== 'POST') return html(405, renderAttestationPage());
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return html(400, renderAttestationPage({ result: 'unreadable' }));
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_VERIFY_BYTES) return html(413, renderAttestationPage({ result: 'unreadable' }));
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_VERIFY_BYTES) return html(413, renderAttestationPage({ result: 'unreadable' }));
  const form = new URLSearchParams(raw);
  const text = form.get('document') ?? '';
  const fingerprint = (form.get('empreinte') ?? '').trim();
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return html(200, renderAttestationPage({ document: text, fingerprint, result: 'unreadable' }));
  }
  return html(200, renderAttestationPage({ document: text, fingerprint, result: await verdict(s.db, document, fingerprint) }));
}
