/**
 * Les notifications en temps réel de Meta (C07) : Instagram, Facebook (Messenger et commentaires de la page) et
 * WhatsApp Business, sur une seule adresse, `/v1/meta/notifications`. En mode essai : chaque message va de bout en
 * bout jusqu'à la réponse prête, rangée dans la boîte d'essai et écrite au journal, jamais envoyée. ManyChat reste
 * seul à répondre aux clients tant que la mise en service (C09) ne dit pas autre chose.
 *
 * - GET : la vérification de l'abonnement par Meta (`hub.mode`, `hub.verify_token`, `hub.challenge`). Le jeton
 *   n'est écrit nulle part : le secret `META_VERIFY_TOKEN_SHA256` ne garde que son empreinte.
 * - POST : la notification n'est lue que si sa signature `X-Hub-Signature-256` (HMAC-SHA256 du corps brut avec le
 *   secret de l'application, `META_APP_SECRET`) est juste. Sinon : 401, rien n'est lu ni rangé, une ligne au journal.
 *
 * Ce module n'envoie rien. Seul le transcripteur des notes vocales (AU044), quand il est réglé, lit l'audio chez Meta
 * et le fait transcrire [R696].
 */
import {
  SqlJournalStore,
  appendEvent,
  createCaptation,
  humanRepliesFromMeta,
  humanRepliesFromWhatsApp,
  type ChainResult,
  type HumanReply,
  type InboundSource,
  type JournalData,
  type SqlDatabase,
} from '@aimmo/core';
import { ChaineVocale, NotesVocales, type Transcriber } from '../../core/src/voix/notes-vocales.ts';
import { MIN_KEY_LENGTH, sha256Hex } from './auth.ts';

export const META_PATH = '/meta/notifications';

/** Au-delà, la notification est refusée : Meta en envoie de bien plus petites. */
export const MAX_META_BYTES = 512 * 1024;

/** Le champ `object` d'une notification de Meta, et la source qu'il désigne. */
export const META_OBJECTS: Readonly<Record<string, InboundSource>> = Object.freeze({
  instagram: 'instagram',
  page: 'facebook',
  whatsapp_business_account: 'whatsapp',
});

export interface MetaConfig {
  db: SqlDatabase;
  /** Secret `META_APP_SECRET` : le secret de l'application Meta ; plusieurs, séparés par des virgules, pendant un changement. */
  appSecret: string | undefined;
  /** Secret `META_VERIFY_TOKEN_SHA256` : empreinte SHA-256 du jeton de vérification de l'abonnement. */
  verifyTokenSha256: string | undefined;
  /** Variable `META_NETWORK_ID` : le réseau auquel appartiennent nos comptes Meta. */
  networkId: string | undefined;
  /** Variable `META_OWN_IDS` : nos page, compte Instagram et numéros WhatsApp, séparés par des virgules. */
  ownIds: string | undefined;
  /** Variable `META_APP_IDS` : nos propres applications Meta ; un écho d'une autre application est réputé humain [R21]. */
  appIds: string | undefined;
  /**
   * AU044 : le vrai transcripteur des notes vocales (H52) ; absent, chaque note vocale est rangée illisible et sa reprise
   * ouverte pour l'agent, sans réponse [R241, R696].
   */
  transcriber?: Transcriber | null;
  now: () => Date;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const CHALLENGE = /^[A-Za-z0-9_-]{1,128}$/;

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

const fail = (status: number, code: string): Response => reply(status, { ok: false, code });

const csv = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');

/** Compare deux textes de même longueur sans s'arrêter au premier écart. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256 du corps brut, en hexadécimal. */
export async function metaSignature(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, body));
}

/** Vrai seulement si l'en-tête porte la signature du corps avec l'un de nos secrets. */
export async function verifyMetaSignature(header: string | null, body: Uint8Array, secrets: readonly string[]): Promise<boolean> {
  const given = SIGNATURE.exec((header ?? '').trim().toLowerCase())?.[1];
  if (given === undefined || secrets.length === 0) return false;
  let ok = false;
  for (const secret of secrets) if (same(await metaSignature(secret, body), given)) ok = true;
  return ok;
}

async function note(journal: SqlJournalStore, type: string, data: JournalData, now: () => Date): Promise<void> {
  try {
    await appendEvent(journal, { type, actor: 'meta:notifications', subject: null, data }, now);
  } catch {
    console.error('aimmo-api : notification Meta sans journal', type);
  }
}

/** Lit le corps brut, sans jamais dépasser la limite. `null` : trop gros. */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_META_BYTES) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_META_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** La vérification de l'abonnement : le défi n'est rendu qu'avec le bon jeton. */
async function verifySubscription(url: URL, config: MetaConfig): Promise<Response> {
  const expected = (config.verifyTokenSha256 ?? '').trim().toLowerCase();
  if (!HEX64.test(expected)) return fail(503, 'not_configured');
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token') ?? '';
  const challenge = url.searchParams.get('hub.challenge') ?? '';
  if (mode !== 'subscribe' || token.length < MIN_KEY_LENGTH || !same(await sha256Hex(token), expected) || !CHALLENGE.test(challenge)) {
    return fail(403, 'forbidden');
  }
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

export interface MetaOutcome {
  source: InboundSource;
  humanReplies: number;
  results: ChainResult[];
}

/**
 * Une notification signée : d'abord les réponses écrites par un humain, pour que l'assistant se taise avant de
 * lire le message suivant [R21], puis chaque message, de bout en bout, rangé une seule fois [R18].
 */
export async function processMetaNotification(config: MetaConfig, networkId: string, source: InboundSource, body: unknown): Promise<MetaOutcome> {
  const journal = new SqlJournalStore(config.db);
  const { chaine: textes, relais, reception } = createCaptation(config.db, journal, { now: config.now });
  // Chaque note vocale passe d'abord par le transcripteur : transcrite, elle suit la chaîne comme un texte [R240] ;
  // sinon, elle est rangée illisible et sa reprise ouverte, sans réponse [R241, R696].
  const notes = new NotesVocales(config.db, journal, config.transcriber ?? null, { now: config.now, timeoutMs: 15_000 });
  const chaine = new ChaineVocale(notes, textes, reception, config.now);
  const echoes: HumanReply[] =
    source === 'whatsapp' ? humanRepliesFromWhatsApp(body) : humanRepliesFromMeta(source as 'instagram' | 'facebook', body, csv(config.appIds));
  let humanReplies = 0;
  // Un écho dont la conversation n'est pas encore connue (même lot que le premier message, ou l'agent a écrit le
  // premier) est gardé, puis appliqué dès que le message de la personne est rangé, avant toute réponse [R21].
  for (const echo of echoes) if ((await relais.noteOrKeepHumanReply(networkId, echo)) === 'noted') humanReplies += 1;
  const beforeReply = async (): Promise<void> => {
    humanReplies += await relais.applyPendingHumanReplies(networkId);
  };
  const results = await chaine.receive(networkId, source, body, { ownIds: csv(config.ownIds) }, { beforeReply });
  return { source, humanReplies, results };
}

/** L'adresse des notifications de Meta. Le mode essai est déjà vérifié par l'appelant. */
export async function handleMeta(request: Request, config: MetaConfig): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET') return verifySubscription(url, config);
  if (request.method !== 'POST') return fail(405, 'method_not_allowed');

  const journal = new SqlJournalStore(config.db);
  const secrets = csv(config.appSecret);
  if (secrets.length === 0 || !config.networkId) {
    await note(journal, 'meta.non_traite', { reason: 'configuration' }, config.now);
    return fail(503, 'not_configured');
  }
  const bytes = await readBody(request);
  if (bytes === null) {
    await note(journal, 'meta.refuse', { reason: 'taille' }, config.now);
    return fail(413, 'too_large');
  }
  // Une signature absente ou fausse : rien n'est lu ni rangé.
  if (!(await verifyMetaSignature(request.headers.get('x-hub-signature-256'), bytes, secrets))) {
    await note(journal, 'meta.refuse', { reason: 'signature' }, config.now);
    return fail(401, 'bad_signature');
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    await note(journal, 'meta.non_traite', { reason: 'json' }, config.now);
    return reply(200, { ok: true, received: false });
  }
  const object = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)['object'] : undefined;
  const source = typeof object === 'string' ? META_OBJECTS[object] : undefined;
  if (source === undefined) {
    const known = typeof object === 'string' && /^[a-z_]{1,40}$/.test(object) ? object : 'inconnu';
    await note(journal, 'meta.non_traite', { reason: 'objet', object: known }, config.now);
    return reply(200, { ok: true, received: false });
  }
  try {
    await processMetaNotification(config, config.networkId, source, body);
    // Rien de plus : Meta n'a besoin que du 200, et le sort de chaque message ne le regarde pas.
    return reply(200, { ok: true, received: true });
  } catch (error) {
    // Meta renverra la notification : chaque message n'est rangé et traité qu'une fois [R18].
    await note(journal, 'api.erreur', { route: 'meta.notifications', error: error instanceof Error ? error.name : 'unknown' }, config.now);
    return fail(500, 'internal_error');
  }
}
