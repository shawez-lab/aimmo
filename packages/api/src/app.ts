import {
  AIMMO_VERSION,
  Acces,
  CHANNELS,
  DecisionEnvoi,
  FicheClient,
  FicheUnique,
  SEND_KINDS,
  SqlJournalStore,
  appendEvent,
  createCaptation,
  decideAccess,
  personSubject,
  verifyChain,
  type AccessResult,
  type Channel,
  type JournalStore,
  type SendKind,
  type SendRequest,
  type SqlDatabase,
  type Viewer,
} from '@aimmo/core';
import { intakeFromRequest, parseApiKeys, parseIntakeKeys, viewerFromRequest } from './auth.ts';

/** Préfixe de version : une API versionnée unique (cahier, Architecture technique). */
export const API_PREFIX = '/v1';

/**
 * Seul mode admis tant qu'aucune tâche du plan n'a mis d'envoi réel en service : l'API décide, elle n'envoie rien.
 */
export const TRIAL_MODE = 'essai';

export interface ApiConfig {
  db: SqlDatabase;
  /** Secret `API_KEYS` : empreintes des clés et identité de chacune (voir auth.ts). */
  apiKeys: string | undefined;
  /** Variable `MODE` : doit valoir « essai ». */
  mode: string | undefined;
  /** Secret `INTAKE_KEYS` : clés qui ne peuvent que déposer un formulaire du site (voir auth.ts). */
  intakeKeys?: string | undefined;
  now?: () => Date;
}

const MAX_BODY_BYTES = 10_000;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const failure = (status: number, code: string, message: string): Response =>
  json(status, { ok: false, code, message });

const refusal = (result: { rule: 'R16'; code: string }): Response =>
  json(result.code === 'unknown' ? 404 : 403, { ok: false, rule: result.rule, code: result.code });

const answer = <T>(result: AccessResult<T>): Response =>
  result.ok ? json(200, { ok: true, mode: TRIAL_MODE, view: result.view, data: result.value }) : refusal(result);

interface Services {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  decision: DecisionEnvoi;
  now: () => Date;
}

function services(db: SqlDatabase, now: () => Date): Services {
  const fiches = new FicheClient(db, { now });
  const unique = new FicheUnique(db, fiches, { now });
  const journal = new SqlJournalStore(db);
  return {
    db,
    journal,
    acces: new Acces(db, fiches, unique, journal, { now }),
    decision: new DecisionEnvoi(db, fiches, unique, { now }),
    now,
  };
}

type Route = (s: Services, viewer: Viewer, params: string[], request: Request) => Promise<Response>;

interface RouteDef {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: Route;
}

const ID = '([A-Za-z0-9_-]{1,64})';

const ROUTES: RouteDef[] = [
  {
    method: 'GET',
    pattern: /^\/fiches$/,
    name: 'fiches',
    handle: async (s, viewer) => answer(await s.acces.listPersons(viewer)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/fiches/${ID}$`),
    name: 'fiche',
    handle: async (s, viewer, [id]) => answer(await s.acces.readFiche(viewer, id!)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/fiches/${ID}/journal$`),
    name: 'fiche.journal',
    handle: async (s, viewer, [id]) => answer(await s.acces.readJournalOf(viewer, id!)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/biens/${ID}$`),
    name: 'bien',
    handle: async (s, viewer, [id]) => answer(await s.acces.readProperty(viewer, id!)),
  },
  {
    method: 'POST',
    pattern: /^\/envois\/decision$/,
    name: 'envois.decision',
    handle: sendDecision,
  },
  {
    method: 'GET',
    pattern: /^\/journal\/verification$/,
    name: 'journal.verification',
    handle: verifyJournal,
  },
];

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * La décision d'envoi, en mode essai : elle dit si un message pourrait partir et quelle règle a décidé.
 * Elle n'envoie rien et ne range aucun message. La fiche est lue sous droits d'accès [R16] et la décision
 * est écrite au journal avec sa règle [R13].
 */
async function sendDecision(s: Services, viewer: Viewer, _params: string[], request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { personId, channel, kind, purpose, conversationId, at } = body;
  if (typeof personId !== 'string' || !new RegExp(`^${ID}$`).test(personId)) {
    return failure(400, 'invalid_person', 'personId manquant ou mal formé.');
  }
  if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) {
    return failure(400, 'invalid_channel', `channel attendu parmi : ${CHANNELS.join(', ')}.`);
  }
  if (typeof kind !== 'string' || !(SEND_KINDS as readonly string[]).includes(kind)) {
    return failure(400, 'invalid_kind', `kind attendu parmi : ${SEND_KINDS.join(', ')}.`);
  }
  if (purpose !== undefined && (typeof purpose !== 'string' || !/^[a-z_]{1,40}$/.test(purpose))) {
    return failure(400, 'invalid_purpose', 'purpose mal formé.');
  }
  if (conversationId !== undefined && conversationId !== null && (typeof conversationId !== 'string' || conversationId.length > 200)) {
    return failure(400, 'invalid_conversation', 'conversationId mal formé.');
  }
  const when = at === undefined ? s.now() : typeof at === 'string' ? new Date(at) : new Date(Number.NaN);
  if (Number.isNaN(when.getTime())) return failure(400, 'invalid_at', 'at doit être une date ISO.');

  const fiche = await s.acces.readFiche(viewer, personId);
  if (!fiche.ok) return refusal(fiche);

  const sendRequest: SendRequest = {
    channel: channel as Channel,
    kind: kind as SendKind,
    at: when,
    ...(purpose === undefined ? {} : { purpose }),
    ...(conversationId === undefined ? {} : { conversationId }),
  };
  const decision = await s.decision.decide(fiche.value.person.id, sendRequest);
  await appendEvent(
    s.journal,
    {
      type: 'envoi.decision.essai',
      actor: `${viewer.role}:${viewer.userId}`,
      subject: personSubject(fiche.value.person.id),
      data: {
        mode: TRIAL_MODE,
        allowed: decision.allowed,
        rule: decision.rule,
        checked: decision.checked,
        reason: decision.reason,
        channel,
        kind,
        at: when.toISOString(),
      },
    },
    s.now,
  );
  return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data: decision });
}

/** Vérifie toute la chaîne du journal. Direction et conformité seulement [R16]. */
async function verifyJournal(s: Services, viewer: Viewer): Promise<Response> {
  const decision = decideAccess(viewer, { kind: 'journal', networkId: viewer.networkId });
  const actor = `${viewer.role}:${viewer.userId}`;
  if (!decision.allowed) {
    await appendEvent(s.journal, { type: 'acces.refuse', actor, subject: null, data: { rule: 'R16', role: viewer.role, kind: 'journal', code: decision.code } }, s.now);
    return refusal(decision);
  }
  const entries = await s.journal.all();
  const result = await verifyChain(entries);
  await appendEvent(s.journal, { type: 'journal.verifie', actor, subject: null, data: { rule: 'R16', ok: result.ok, lines: entries.length } }, s.now);
  return json(200, { ok: true, mode: TRIAL_MODE, data: { ...result, lines: entries.length } });
}

/**
 * Le formulaire « Être rappelé » du site, de bout en bout jusqu'à la réponse, en mode essai : la réponse est
 * prête et écrite au journal, jamais envoyée. Une clé de dépôt ne lit rien : elle ne rend que des statuts.
 */
async function intakeForm(request: Request, config: ApiConfig, now: () => Date): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Dépôt fermé : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys);
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const journal = new SqlJournalStore(config.db);
  try {
    const { chaine } = createCaptation(config.db, journal, { now });
    const results = await chaine.receive(intake.networkId, 'site_form', body);
    return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data: results.map((r) => ({ inboundId: r.inboundId, status: r.status })) });
  } catch (error) {
    await journalError(journal, 'intake:site_form', 'captation.formulaire', error, now);
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}

/** Jamais d'erreur avalée : une ligne au journal, sans le détail qui pourrait porter une donnée [R13]. */
export async function journalError(journal: JournalStore, actor: string, route: string, error: unknown, now: () => Date): Promise<void> {
  try {
    await appendEvent(journal, { type: 'api.erreur', actor, subject: null, data: { route, error: error instanceof Error ? error.name : 'unknown' } }, now);
  } catch {
    console.error('aimmo-api : erreur sans journal', route);
  }
}

/**
 * Le point d'entrée de l'API du socle. Tout passe ici : clé, droits, journal.
 * Lecture prudente : sans clé valable, sans configuration ou hors mode essai, rien n'est lu.
 */
export async function handleRequest(request: Request, config: ApiConfig): Promise<Response> {
  const now = config.now ?? (() => new Date());
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) return failure(404, 'not_found', 'Adresse inconnue.');
  const path = url.pathname.slice(API_PREFIX.length);

  if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');

  if (path === '/sante') {
    if (request.method !== 'GET') return failure(405, 'method_not_allowed', 'Méthode non admise.');
    return json(200, { ok: true, version: AIMMO_VERSION, mode: TRIAL_MODE });
  }

  if (path === '/captation/formulaire') return intakeForm(request, config, now);

  const keys = parseApiKeys(config.apiKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'API fermée : aucune clé configurée.');
  const viewer = await viewerFromRequest(request, keys);
  if (viewer === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');

  const route = ROUTES.find((candidate) => candidate.pattern.test(path));
  if (!route) return failure(404, 'not_found', 'Adresse inconnue.');
  if (route.method !== request.method) return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const params = (route.pattern.exec(path) ?? []).slice(1);

  const s = services(config.db, now);
  try {
    return await route.handle(s, viewer, params, request);
  } catch (error) {
    // Jamais d'erreur avalée : une ligne au journal, sans le détail qui pourrait porter une donnée [R13].
    try {
      await appendEvent(
        s.journal,
        { type: 'api.erreur', actor: `${viewer.role}:${viewer.userId}`, subject: null, data: { route: route.name, error: error instanceof Error ? error.name : 'unknown' } },
        now,
      );
    } catch {
      console.error('aimmo-api : erreur sans journal', route.name);
    }
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}
