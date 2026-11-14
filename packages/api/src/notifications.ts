/**
 * Le passage des notifications aux agents, à chaque minute (BR65, HX27, RC33, SV15).
 *
 * Le déclencheur du Worker passe chaque minute. À chaque passage, en mode essai seulement : le rattrapage relit les
 * contacts chauds et les messages reçus que personne n'a encore notifiés (`catchUp`), puis l'envoi fait partir ce qui
 * est dû, urgence par urgence, heures calmes tenues (`flush`) [R412, R413, R414]. Rien ne part que par le contrôle
 * central des envois, construit ici sans aucun canal vers une personne et avec la seule boîte d'essai des
 * notifications : rien ne part vers un téléphone tant que le vrai service n'est pas en service (H57) [R225, R26].
 * Une erreur du passage est écrite au journal, jamais avalée, et n'empêche pas le reste du déclencheur [R13].
 *
 * Les routes des notifications (BR66), sous `/v1/notifications`, réservées à l'agent en activité, pour lui seul [R16] :
 *
 *   GET  /v1/notifications/reglages        ses réglages en vigueur : heures calmes et niveau de chaque sorte
 *   POST /v1/notifications/reglages        { quietStart, quietEnd, levels? } : les range ; le contact chaud ne se règle pas [R412]
 *   GET  /v1/notifications                 ses notifications, sur les seules fiches qu'il voit en entier
 *   GET  /v1/notifications/envois/<id>     le détail d'un envoi, où mène le lien de la notification [R415]
 *
 * Le rôle est contrôlé avant de lire le corps, et son refus va au journal [R16]. Rien n'est envoyé d'une route.
 */
import { AgentPushTrialBox, ControleEnvois, DecisionEnvoi, FicheClient, FicheUnique, SqlJournalStore, SqlSendJournal, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { Notifications, type CatchUpResult, type NotificationRow } from '../../core/src/automatismes/notifications.ts';
import { TRIAL_MODE, journalError } from './app.ts';

export interface NotificationsPassConfig {
  db: SqlDatabase;
  /** Variable `MODE` : hors essai, rien ne passe. */
  mode: string | undefined;
  now?: () => Date;
}

/** Ce qu'un passage a fait : le rattrapage, et le nombre d'envois faits. */
export interface NotificationsPassResult {
  caughtUp: CatchUpResult;
  pushes: number;
}

/** Le contrôle central du passage : aucun canal vers une personne, la seule boîte d'essai des notifications [R26]. */
function trialGate(db: SqlDatabase, journal: JournalStore, now: () => Date): ControleEnvois {
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  return new ControleEnvois(db, unique, new DecisionEnvoi(db, store, unique, { now }), {
    channels: [],
    journal: new SqlSendJournal(db, undefined, now),
    agentPush: new AgentPushTrialBox(db, journal, now),
    now,
  });
}

/** Le passage de chaque minute. Hors mode essai, ou en panne (écrite au journal), rend `null`. */
export async function runNotificationsPass(config: NotificationsPassConfig): Promise<NotificationsPassResult | null> {
  if (config.mode !== TRIAL_MODE) return null;
  const now = config.now ?? (() => new Date());
  const journal = new SqlJournalStore(config.db);
  try {
    const notifications = new Notifications(config.db, journal, trialGate(config.db, journal, now), { now });
    const caughtUp = await notifications.catchUp();
    const pushes = await notifications.flush();
    return { caughtUp, pushes: pushes.length };
  } catch (error) {
    await journalError(journal, 'system:notifications', 'notifications.passage', error, now);
    return null;
  }
}

/** Le planificateur et la publication ne passent qu'aux quarts d'heure, comme avant BR65. */
export const isQuarterMinute = (at: Date): boolean => at.getUTCMinutes() % 15 === 0;

export const MAX_NOTIFICATIONS_BODY_BYTES = 1024;
const ID = '([A-Za-z0-9_-]{1,64})';
const SETTINGS_FIELDS: readonly string[] = ['quietStart', 'quietEnd', 'levels'];

export interface NotificationsServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

export interface NotificationsRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: NotificationsServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

/** Chaque refus dit en mots, pour l'écran comme pour un humain qui lit la réponse [R16]. */
export const NOTIFICATIONS_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Les notifications se règlent et se relisent par l’agent lui-même.',
  not_self: 'Seul un agent en activité dans ce réseau règle et relit ses notifications.',
  invalid_body: 'Les réglages attendus sont un objet : début et fin des heures calmes, et le niveau de chaque sorte.',
  unexpected_field: 'Un champ n’est pas prévu ici.',
  invalid_quiet: 'Le début et la fin des heures calmes se disent en minutes du jour, de 0 à 1439.',
  invalid_level: 'Cette sorte ou ce niveau n’existe pas : haute, normale, basse ou coupée, pour les messages, rendez-vous, pièces, tâches et informations.',
  hot_fixed: 'Le contact chaud ne se règle pas : il part toujours tout de suite.',
  unknown: 'Cet envoi n’existe pas parmi les vôtres.',
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

const refuse = (status: number, rule: string | null, code: string): Response =>
  json(status, { ok: false, rule, code, message: NOTIFICATIONS_REFUSALS[code] ?? 'Les notifications ne se lisent pas.' });

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  if (Number(request.headers.get('content-length') ?? '0') > MAX_NOTIFICATIONS_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_NOTIFICATIONS_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Le refus d'un rôle ou d'un agent qui n'est plus en activité, écrit au journal sans donnée [R16, R13]. */
async function refuseViewer(s: NotificationsServices, viewer: Viewer, code: 'role' | 'not_self'): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'notifications', code } },
    s.now,
  );
  return refuse(403, 'R16', code);
}

/** L'agent qui appelle, encore en activité dans son réseau ; sinon le code du refus. */
async function activeAgent(s: NotificationsServices, viewer: Viewer): Promise<'role' | 'not_self' | null> {
  if (viewer.role !== 'agent') return 'role';
  const agent = await s.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
  return agent?.status === 'active' ? null : 'not_self';
}

const hasQuery = (request: Request): boolean => [...new URL(request.url).searchParams.keys()].length > 0;

const notificationsOf = (s: NotificationsServices): Notifications => new Notifications(s.db, s.journal, trialGate(s.db, s.journal, s.now), { now: s.now });

/** Ce que la route rend d'une notification : jamais sa clé interne ni le réseau. */
export interface NotificationView {
  id: string;
  personId: string;
  kind: NotificationRow['kind'];
  urgency: NotificationRow['urgency'];
  status: NotificationRow['status'];
  pushId: string | null;
  createdAt: string;
  sentAt: string | null;
}

const view = (r: NotificationRow): NotificationView => ({
  id: r.id,
  personId: r.person_id,
  kind: r.kind,
  urgency: r.urgency,
  status: r.status,
  pushId: r.push_id,
  createdAt: r.created_at,
  sentAt: r.sent_at,
});

/** Les routes de `/v1/notifications`, à ajouter à celles de `app.ts` (BR66). Aucune n'envoie rien. */
export function notificationsRoutes(): NotificationsRoute[] {
  return [
    {
      method: 'GET',
      pattern: /^\/notifications\/reglages$/,
      name: 'notifications.reglages.lire',
      handle: async (s, viewer, _params, request) => {
        const denied = await activeAgent(s, viewer);
        if (denied) return refuseViewer(s, viewer, denied);
        if (hasQuery(request)) return refuse(400, null, 'unexpected_field');
        return json(200, { ok: true, data: await notificationsOf(s).settings(viewer.userId) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/notifications\/reglages$/,
      name: 'notifications.reglages.ranger',
      handle: async (s, viewer, _params, request) => {
        const denied = await activeAgent(s, viewer);
        if (denied) return refuseViewer(s, viewer, denied);
        const body = await readJson(request);
        if (!body) return refuse(400, null, 'invalid_body');
        if (Object.keys(body).some((k) => !SETTINGS_FIELDS.includes(k))) return refuse(400, null, 'unexpected_field');
        const levels = body['levels'];
        if (levels !== undefined && (levels === null || typeof levels !== 'object' || Array.isArray(levels))) return refuse(400, null, 'invalid_level');
        const r = await notificationsOf(s).setSettings(viewer, {
          quietStart: body['quietStart'] as number,
          quietEnd: body['quietEnd'] as number,
          ...(levels !== undefined ? { levels: levels as Partial<Record<string, string>> } : {}),
        });
        if (r.ok) return json(200, { ok: true, data: r.value });
        if (r.code === 'not_self') return refuseViewer(s, viewer, 'not_self');
        return refuse(400, r.code === 'hot_fixed' ? 'R412' : r.code === 'invalid_quiet' ? 'R413' : null, r.code);
      },
    },
    {
      method: 'GET',
      pattern: /^\/notifications$/,
      name: 'notifications.lire',
      handle: async (s, viewer, _params, request) => {
        const denied = await activeAgent(s, viewer);
        if (denied) return refuseViewer(s, viewer, denied);
        if (hasQuery(request)) return refuse(400, null, 'unexpected_field');
        return json(200, { ok: true, data: (await notificationsOf(s).listFor(viewer)).map(view) });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/notifications/envois/${ID}$`),
      name: 'notifications.envoi.lire',
      handle: async (s, viewer, [pushId], request) => {
        const denied = await activeAgent(s, viewer);
        if (denied) return refuseViewer(s, viewer, denied);
        if (hasQuery(request)) return refuse(400, null, 'unexpected_field');
        const rows = (await notificationsOf(s).listFor(viewer)).filter((r) => r.push_id === pushId);
        if (rows.length === 0) return refuse(404, null, 'unknown');
        return json(200, { ok: true, data: rows.map(view) });
      },
    },
  ];
}
