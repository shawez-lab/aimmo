/**
 * L'API de l'assistant du site (C08), appelée par le serveur du site avec une clé de dépôt `site_chat` :
 *
 * - POST `/v1/assistant/sessions` `{ visitorId }` : ouvre une conversation, rend son jeton `sessionId`.
 * - POST `/v1/assistant/sessions/<sessionId>/messages` `{ visitorId, messageId, text, page?, propertyRef? }` :
 *   le message va de bout en bout, comme sur les autres canaux (C01 à C05), jusqu'à la réponse, qui passe par le
 *   contrôle central des envois (S06) : arrêt, exclusions, relais à l'agent, mention de l'assistant, chiffres,
 *   discrétion du bien [R02, R04, R06, R10, R19, R21].
 *
 * En mode essai, la réponse est prête, rangée dans la boîte d'essai et écrite au journal, jamais rendue au
 * visiteur : `reply` vaut `null`. Ce module n'appelle aucune adresse extérieure.
 *
 * Données minimales [R15] : ni adresse IP, ni navigateur, ni en-tête du visiteur ne sont lus ni rangés. `visitorId`
 * est un identifiant opaque tiré au hasard par le site, jamais une adresse ou un numéro ; seule son empreinte est
 * gardée, pour les limites d'appels. Ce que la personne écrit vit dans sa fiche, comme sur les autres canaux.
 */
import { SqlJournalStore, createCaptation, type ChainStatus, type ReplyWriter, type SqlDatabase } from '@aimmo/core';
import { intakeFromRequest, parseIntakeKeys, sha256Hex } from './auth.ts';

export const ASSISTANT_PATH = '/assistant/sessions';

/** Les limites d'appels, par heure pleine. Des réglages, pas des règles : la conversation passe à l'agent avant. */
export interface AssistantLimits {
  /** Conversations ouvertes par un même visiteur. */
  sessionsPerVisitor: number;
  /** Messages d'un même visiteur, toutes conversations comprises. */
  messagesPerVisitor: number;
  /** Messages dans une même conversation. */
  messagesPerSession: number;
}

export const DEFAULT_ASSISTANT_LIMITS: AssistantLimits = Object.freeze({
  sessionsPerVisitor: 5,
  messagesPerVisitor: 30,
  messagesPerSession: 15,
});

/** Au-delà, le message est refusé : un message de chat est court. */
export const MAX_CHAT_CHARS = 2000;

export interface AssistantConfig {
  db: SqlDatabase;
  /** Secret `INTAKE_KEYS` : seules les clés `site_chat` ouvrent l'assistant. */
  intakeKeys: string | undefined;
  limits?: AssistantLimits;
  /** L'IA qui rédige, une fois branchée (H13) ; absente : texte de secours, et l'agent prend vite le relais [R12]. */
  writer?: ReplyWriter;
  now: () => Date;
}

/** Ce que le visiteur apprend du sort de son message : jamais si la personne est exclue ou connue [R02, R16]. */
export type AssistantStatus = 'ready' | 'with_agent' | 'none';

const VISITOR = /^[A-Za-z0-9_-]{16,128}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 10_000;

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

const failure = (status: number, code: string, message: string): Response => reply(status, { ok: false, code, message });

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
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

function optionalRef(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : undefined;
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** L'heure pleine, en UTC : la fenêtre des limites. */
const bucketOf = (at: Date): string => at.toISOString().slice(0, 13);

/**
 * Prend une place dans la limite, en une seule instruction : deux appels simultanés ne la dépassent pas.
 * Rend faux si la limite est atteinte.
 */
async function takeSlot(db: SqlDatabase, networkId: string, scope: string, cap: number, at: Date): Promise<boolean> {
  const bucket = bucketOf(at);
  const { changes } = await db.run(
    `INSERT INTO assistant_calls (id, network_id, scope, bucket, created_at)
     SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM assistant_calls WHERE network_id = ? AND scope = ? AND bucket = ?) < ?`,
    [crypto.randomUUID(), networkId, scope, bucket, at.toISOString(), networkId, scope, bucket, cap],
  );
  return changes === 1;
}

const STATUS_FOR: Partial<Record<ChainStatus, AssistantStatus>> = {
  replied: 'ready',
  handed_over: 'with_agent',
  silent: 'with_agent',
  not_sent: 'with_agent',
};

export async function handleAssistant(request: Request, path: string, config: AssistantConfig): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Assistant fermé : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys, 'site_chat');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readBody(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { visitorId } = body;
  if (typeof visitorId !== 'string' || !VISITOR.test(visitorId)) {
    return failure(400, 'invalid_visitor', 'visitorId : identifiant opaque de 16 à 128 caractères, lettres, chiffres, - ou _.');
  }
  const limits = config.limits ?? DEFAULT_ASSISTANT_LIMITS;
  const networkId = intake.networkId;
  const visitor = await sha256Hex(`${networkId}:${visitorId}`);
  const at = config.now();

  if (path === ASSISTANT_PATH) {
    if (!(await takeSlot(config.db, networkId, `ouverture:${visitor}`, limits.sessionsPerVisitor, at))) {
      return failure(429, 'too_many_requests', 'Trop de conversations ouvertes : réessayez plus tard.');
    }
    const sessionId = randomToken();
    await config.db.run('INSERT INTO assistant_sessions (id, network_id, visitor_sha256, created_at) VALUES (?, ?, ?, ?)', [
      sessionId,
      networkId,
      visitor,
      at.toISOString(),
    ]);
    return reply(201, { ok: true, mode: 'essai', sessionId });
  }

  const match = new RegExp(`^${ASSISTANT_PATH}/([^/]+)/messages$`).exec(path);
  const sessionId = match?.[1];
  if (sessionId === undefined) return failure(404, 'not_found', 'Adresse inconnue.');
  const { messageId, text } = body;
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) return failure(400, 'invalid_message_id', 'messageId manquant ou mal formé.');
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_CHAT_CHARS) {
    return failure(400, 'invalid_text', `text : de 1 à ${MAX_CHAT_CHARS} caractères.`);
  }
  const page = optionalRef(body.page);
  const propertyRef = optionalRef(body.propertyRef);
  if (page === undefined || propertyRef === undefined) return failure(400, 'invalid_ref', 'page ou propertyRef mal formé.');

  // Une session d'un autre réseau ou d'un autre visiteur est inconnue : même réponse, rien n'en est dit.
  const session = SESSION.test(sessionId)
    ? await config.db.first<{ visitor_sha256: string }>('SELECT visitor_sha256 FROM assistant_sessions WHERE id = ? AND network_id = ?', [sessionId, networkId])
    : null;
  if (!session || session.visitor_sha256 !== visitor) return failure(404, 'unknown_session', 'Conversation inconnue.');

  if (
    !(await takeSlot(config.db, networkId, `visiteur:${visitor}`, limits.messagesPerVisitor, at)) ||
    !(await takeSlot(config.db, networkId, `session:${sessionId}`, limits.messagesPerSession, at))
  ) {
    return failure(429, 'too_many_requests', 'Trop de messages : réessayez plus tard.');
  }

  const journal = new SqlJournalStore(config.db);
  const { chaine } = createCaptation(config.db, journal, { now: config.now, ...(config.writer ? { writer: config.writer } : {}) });
  const results = await chaine.receive(networkId, 'site_chat', {
    sessionId,
    messageId,
    text,
    sentAt: at.toISOString(),
    page,
    propertyRef,
  });
  const status = results.map((r) => STATUS_FOR[r.status]).find((s) => s !== undefined) ?? 'none';
  // En mode essai, rien ne part : la réponse prête n'est pas rendue au visiteur.
  return reply(200, { ok: true, mode: 'essai', sent: false, status, reply: null });
}
