import {
  AIMMO_VERSION,
  ATTRIBUTION_RULES,
  ControleBaseLegale,
  AUTOMATION_NAMES,
  Acces,
  Automatisations,
  REF_PATTERN,
  DEFAULT_ATTRIBUTION_SETTINGS,
  CHANNELS,
  DecisionEnvoi,
  FicheClient,
  CATEGORIES,
  FicheUnique,
  Qualification,
  ROUTES as NEXT_MODULES,
  PlansDuJour,
  Rappels,
  Reception,
  ReconnaissanceBien,
  SEND_KINDS,
  SqlJournalStore,
  appendEvent,
  createCaptation,
  decideAccess,
  personSubject,
  verifyChain,
  type AccessResult,
  type Automation,
  type Channel,
  type JournalStore,
  type SendKind,
  type SendRequest,
  type SqlDatabase,
  type Viewer,
} from '@aimmo/core';
import { intakeFromRequest, parseApiKeys, parseIntakeKeys, viewerFromRequest } from './auth.ts';
import { ASSISTANT_PATH, handleAssistant, type AssistantLimits } from './assistant.ts';
import type { ReplyWriter } from '@aimmo/core';
import { META_PATH, handleMeta, type MetaConfig } from './meta.ts';
import { ESTIMATION_PATH, handleEstimation, type EstimationLimits } from './estimation.ts';
import { BOOKING_PATH, BOOKING_SLOTS_PATH, handleBooking, type BookingLimits } from './rendezvous.ts';
import type { DetailedSales, Geocoder } from '@aimmo/core';

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
  /** Notifications de Meta (C07) : secrets et variables `META_*`, voir meta.ts. */
  meta?: Omit<MetaConfig, 'db' | 'now'>;
  /** Limites d'appels de l'assistant du site (C08) ; absentes : les réglages par défaut. */
  assistantLimits?: AssistantLimits;
  /** L'IA qui rédige les réponses de l'assistant du site, une fois branchée (H13). */
  writer?: ReplyWriter;
  /** Estimation en ligne du site (E05) : Base adresse nationale et ventes DVF ; absents, le service est fermé. */
  estimation?: { geocoder: Geocoder; sales: DetailedSales };
  estimationLimits?: EstimationLimits;
  /** Réservation des rendez-vous (V08) : limites d'appels, et début du lien pour décaler ou annuler (`RDV_LINK_BASE`). */
  bookingLimits?: BookingLimits;
  appointmentLinkBase?: string | undefined;
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
  rappels: Rappels;
  qualification: Qualification;
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
    rappels: new Rappels(db, unique, journal, { now }),
    qualification: new Qualification(db, fiches, unique, new Reception(db, undefined, now), new ReconnaissanceBien(db), journal, { now }),
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
    method: 'POST',
    pattern: new RegExp(`^/qualifications/${ID}/correction$`),
    name: 'qualification.correction',
    handle: correctQualification,
  },
  {
    method: 'GET',
    pattern: /^\/contacts-chauds$/,
    name: 'contacts.chauds',
    // Les contacts chauds à rappeler : un agent ne voit que les siens [R16], jamais une personne exclue [R25].
    handle: async (s, viewer) => {
      const list = await s.rappels.hotList(s.acces, viewer);
      return list.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: list.value }) : refusal({ rule: list.rule, code: list.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/plan-du-jour$/,
    name: 'plan_du_jour',
    // Le plan du jour figé à 7 h 30 : l'agent seul lit le sien [R16] ; `null` tant qu'il n'est pas encore figé.
    handle: async (s, viewer) => {
      const plan = await new PlansDuJour(s.db, s.journal, { now: s.now }).read(viewer);
      return plan.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: plan.value }) : refusal({ rule: plan.rule, code: plan.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/plan-du-jour\/controle$/,
    name: 'plan_du_jour.controle',
    // Les écarts du contrôle de la base légale sur 30 jours : des nombres seulement ; direction et conformité [R16].
    handle: async (s, viewer) => {
      const alerts = await new ControleBaseLegale(s.db, s.journal, { now: s.now }).alerts(viewer);
      return alerts.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: alerts.value }) : refusal({ rule: alerts.rule, code: alerts.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/attribution\/regles$/,
    name: 'attribution.regles',
    // Les règles d'attribution, publiées, les mêmes pour tous [R25] : rien de personnel.
    handle: async () =>
      json(200, {
        ok: true,
        mode: TRIAL_MODE,
        data: {
          rules: ATTRIBUTION_RULES,
          callbackHours: { hot: DEFAULT_ATTRIBUTION_SETTINGS.hotCallbackHours, other: DEFAULT_ATTRIBUTION_SETTINGS.otherCallbackHours },
          communes: DEFAULT_ATTRIBUTION_SETTINGS.communes,
        },
      }),
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

/**
 * La correction du classement par l'agent : gardée telle quelle, elle rejoint les cas de mesure. Seul celui qui voit
 * la fiche en entier corrige [R16] ; la qualification d'origine reste [R17].
 */
async function correctQualification(s: Services, viewer: Viewer, [id]: string[], request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { category, route } = body;
  if (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category)) {
    return failure(400, 'invalid_category', `category attendue parmi : ${CATEGORIES.join(', ')}.`);
  }
  if (route !== undefined && route !== null && (typeof route !== 'string' || !(NEXT_MODULES as readonly string[]).includes(route))) {
    return failure(400, 'invalid_route', `route attendue parmi : ${NEXT_MODULES.join(', ')}, ou null.`);
  }
  const row = await s.db.first<{ network_id: string }>('SELECT network_id FROM qualifications WHERE id = ?', [id!]);
  if (!row || row.network_id !== viewer.networkId) return json(404, { ok: false, rule: 'R16', code: 'unknown' });
  const done = await s.qualification.correct(s.acces, viewer, id!, category as (typeof CATEGORIES)[number], (route ?? null) as (typeof NEXT_MODULES)[number] | null);
  return done ? json(200, { ok: true, mode: TRIAL_MODE }) : json(403, { ok: false, rule: 'R16', code: 'not_assigned' });
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
  const intake = await intakeFromRequest(request, keys, 'site_form');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const journal = new SqlJournalStore(config.db);
  try {
    const { chaine } = createCaptation(config.db, journal, { now });
    await chaine.receive(intake.networkId, 'site_form', body);
    // Rien de plus : le sort du formulaire (personne exclue, déjà connue…) ne regarde pas le déposant [R02, R16].
    return json(200, { ok: true, mode: TRIAL_MODE, sent: false, received: true });
  } catch (error) {
    await journalError(journal, 'intake:site_form', 'captation.formulaire', error, now);
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}

/** Une adresse plausible, sans la normaliser ici : la fiche le fait, et une adresse inconnue est simplement refusée. */
const MAX_EMAIL_LENGTH = 254;
const MAX_TEXT_LENGTH = 4_000;
const MAX_FIGURES = 30;

/**
 * Une automatisation du site demande si son envoi peut partir (B01), en mode essai : le socle décide par le contrôle
 * central et n'envoie rien [R26]. La clé `site_auto` ne lit aucune fiche : seule la décision et sa règle reviennent.
 */
async function automationSend(request: Request, config: ApiConfig, now: () => Date): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Demandes fermées : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys, 'site_auto');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { automation, email, ref, text, figures } = body;
  if (typeof automation !== 'string' || !(AUTOMATION_NAMES as readonly string[]).includes(automation)) {
    return failure(400, 'invalid_automation', `automation attendue parmi : ${AUTOMATION_NAMES.join(', ')}.`);
  }
  if (typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH || !email.includes('@')) return failure(400, 'invalid_email', 'email manquant ou mal formé.');
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return failure(400, 'invalid_ref', 'ref manquante ou mal formée.');
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT_LENGTH) return failure(400, 'invalid_text', 'text manquant ou trop long.');
  if (
    figures !== undefined &&
    (!Array.isArray(figures) ||
      figures.length > MAX_FIGURES ||
      !figures.every((f) => (typeof f === 'string' && f.length <= 40) || (typeof f === 'number' && Number.isFinite(f))))
  ) {
    return failure(400, 'invalid_figures', 'figures doit être une courte liste de nombres ou de textes courts.');
  }
  const journal = new SqlJournalStore(config.db);
  try {
    const decision = await new Automatisations(config.db, journal, { now }).request({
      networkId: intake.networkId,
      automation: automation as Automation,
      email,
      ref,
      text,
      ...(figures === undefined ? {} : { figures: figures as (string | number)[] }),
    });
    return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data: { status: decision.status, rule: decision.rule, code: decision.code, reason: decision.reason } });
  } catch (error) {
    await journalError(journal, 'intake:site_auto', 'automatisations.envoi', error, now);
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

  if (path === '/automatisations/envoi') return automationSend(request, config, now);

  if (path === ESTIMATION_PATH) {
    try {
      return await handleEstimation(request, {
        db: config.db,
        intakeKeys: config.intakeKeys,
        ...(config.estimation ? { services: config.estimation } : {}),
        ...(config.estimationLimits ? { limits: config.estimationLimits } : {}),
        now,
      });
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'intake:site_estimate', 'estimation.commune', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  if (path === ASSISTANT_PATH || path.startsWith(`${ASSISTANT_PATH}/`)) {
    try {
      return await handleAssistant(request, path, {
        db: config.db,
        intakeKeys: config.intakeKeys,
        ...(config.assistantLimits ? { limits: config.assistantLimits } : {}),
        ...(config.writer ? { writer: config.writer } : {}),
        now,
      });
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'intake:site_chat', 'assistant', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  if (path === BOOKING_SLOTS_PATH || path === BOOKING_PATH) {
    try {
      return await handleBooking(request, path, {
        db: config.db,
        intakeKeys: config.intakeKeys,
        ...(config.bookingLimits ? { limits: config.bookingLimits } : {}),
        linkBase: config.appointmentLinkBase ?? null,
        now,
      });
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'intake:site_booking', 'rendez-vous', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  if (path === META_PATH) {
    const meta = config.meta ?? { appSecret: undefined, verifyTokenSha256: undefined, networkId: undefined, ownIds: undefined, appIds: undefined };
    return handleMeta(request, { ...meta, db: config.db, now });
  }

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
