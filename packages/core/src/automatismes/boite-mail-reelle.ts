/**
 * Les vraies boîtes Gmail et Outlook des agents (AU043), derrière l'interface `MailboxProvider` de HX26.
 *
 * Elles ne sont faites que par le Worker, et seulement quand tout est rangé (H55) : le mode `reel`, le client OAuth de
 * Google ou de Microsoft (identifiant et secret) et, pour chaque agent qui a donné son accord, le jeton de
 * rafraîchissement de sa boîte. Sinon aucune boîte n'est lue [R683].
 *
 * - le jeton d'accès est tiré du jeton de rafraîchissement, gardé en mémoire jusqu'à une minute avant sa fin ; seule la
 *   lecture est demandée (`gmail.readonly` ; `Mail.Read`, et `User.Read` pour les adresses de la boîte) : aucune adresse ici n'envoie, ne déplace ni n'efface un mail ;
 * - Gmail : la liste des mails de la boîte (reçus et envoyés, ni brouillons, ni indésirables, ni corbeille), du plus
 *   récent au plus ancien, puis les plus anciens d'abord, 50 au plus par lecture ; un mail porte son fil (`threadId`) ;
 * - Outlook : toute la boîte, quel que soit le dossier où un mail a été rangé ou archivé, sauf brouillons, éléments
 *   supprimés et courrier indésirable, du plus ancien au plus récent, 50 au plus ; un mail du dossier des éléments
 *   envoyés est un mail de l'agent ; le fil est la conversation (`conversationId`) ;
 *   la taille des pièces est lue d'abord, images du texte comprises, et seul le contenu des pièces assez petites est
 *   demandé ; les clés demandées sont celles qui ne changent pas quand le mail change de dossier (`ImmutableId`) ;
 * - les mails déjà triés autour du curseur (`skip`) ne prennent pas de place dans le lot : un lot plein de mails de la
 *   même heure avance toujours [R18] ;
 * - la première lecture d'une boîte remonte à 30 jours ;
 * - une pièce jointe trop grosse n'est pas téléchargée : elle arrive vide, et le tri la refuse [R410].
 *
 * Chaque échec devient une `MailboxError` au code fermé : `connexion` (accord retiré ou jeton refusé : reconnecter la
 * boîte), `droits` (le droit de lecture n'a pas été accordé), `limite` (quota : réessayer plus tard), `trop` (trop de
 * mails à lire d'un coup), `panne` (service indisponible ou réponse illisible). Ni le jeton, ni une adresse, ni un objet,
 * ni la réponse du service ne sortent d'ici : seul le code [R13].
 */
import { MAIL_ATTACHMENT_MAX_BYTES, type MailAttachmentIn, type MailIn, type MailProvider, type MailboxProvider } from './boite-mail.ts';

export const MAILBOX_ERROR_CODES = ['connexion', 'droits', 'limite', 'trop', 'panne'] as const;
export type MailboxErrorCode = (typeof MAILBOX_ERROR_CODES)[number];

/** Une panne de la vraie boîte : le code seul, jamais le message du service [R13]. */
export class MailboxError extends Error {
  override readonly name = 'MailboxError';
  constructor(readonly code: MailboxErrorCode) {
    super(`Boîte mail : ${code}.`);
  }
}

export type HttpFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface MailboxClient {
  /** L'identifiant du client OAuth et son secret (un secret du Worker, jamais écrit ailleurs). */
  clientId: string;
  clientSecret: string;
  /** Microsoft seulement : l'annuaire de l'application (`common`, `organizations` ou son identifiant). */
  tenant?: string;
}

export interface RealMailboxConfig {
  client: MailboxClient;
  /** Le jeton de rafraîchissement de la boîte de chaque agent qui a donné son accord, par identifiant d'agent. */
  refreshTokens: ReadonlyMap<string, string>;
  http: HttpFn;
  now?: () => Date;
  timeoutMs?: number;
}

/** Le nombre de mails rendus au plus par lecture : le reste vient à la lecture suivante, dans l'ordre. */
export const MAILBOX_BATCH = 50;
/** La première lecture d'une boîte remonte à 30 jours. */
export const MAILBOX_FIRST_DAYS = 30;
/** Gmail : au plus 20 pages de 500 clés lues pour trouver les plus anciens ; au-delà, `trop`. */
const GMAIL_MAX_PAGES = 20;
const MAX_ATTACHMENTS_READ = 21;
/** Outlook : au plus 10 pages par dossier pour remplir le lot ; au-delà, `trop`. */
const OUTLOOK_MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const msToken = (tenant: string): string => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Le code fermé d'une réponse en erreur, sans jamais garder son corps. */
export function mailboxError(status: number, body: unknown): MailboxError {
  const err = isObj(body) ? body.error : undefined;
  const reason = typeof err === 'string' ? err : isObj(err) ? (str(err.status) ?? str(err.code) ?? '') : '';
  if (status === 401 || reason === 'invalid_grant' || reason === 'invalid_client' || reason === 'unauthorized_client' || reason === 'UNAUTHENTICATED' || reason === 'InvalidAuthenticationToken') return new MailboxError('connexion');
  if (status === 429 || reason === 'RESOURCE_EXHAUSTED') return new MailboxError('limite');
  if (status === 403 || reason === 'PERMISSION_DENIED' || reason === 'ErrorAccessDenied' || reason === 'invalid_scope') return new MailboxError('droits');
  return new MailboxError('panne');
}

/** Un appel au service : coupure, délai dépassé ou réponse illisible valent `panne`. */
async function call(cfg: RealMailboxConfig, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<unknown> {
  const timeout = cfg.timeoutMs ?? 20_000;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  let r: Response;
  try {
    r = await cfg.http(url, { ...init, ...(ctrl ? { signal: ctrl.signal } : {}) });
  } catch {
    throw new MailboxError('panne');
  } finally {
    if (timer) clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    const text = await r.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    if (r.ok) throw new MailboxError('panne');
  }
  if (!r.ok) throw mailboxError(r.status, body);
  return body;
}

/** Les jetons d'accès, un par agent, tirés de son jeton de rafraîchissement et gardés jusqu'à une minute avant leur fin. */
class AccessTokens {
  private readonly cache = new Map<string, { token: string; until: number }>();
  constructor(
    private readonly cfg: RealMailboxConfig,
    private readonly url: string,
    private readonly scope: string | null,
  ) {}

  has(agentId: string): boolean {
    return this.cfg.refreshTokens.has(agentId);
  }

  async of(agentId: string): Promise<string> {
    const now = (this.cfg.now ?? (() => new Date()))().getTime();
    const hit = this.cache.get(agentId);
    if (hit && hit.until > now) return hit.token;
    const refresh = this.cfg.refreshTokens.get(agentId);
    if (!refresh) throw new MailboxError('connexion');
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: this.cfg.client.clientId, client_secret: this.cfg.client.clientSecret, refresh_token: refresh });
    if (this.scope) form.set('scope', this.scope);
    const body = await call(this.cfg, this.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const token = isObj(body) ? str(body.access_token) : null;
    if (!token) throw new MailboxError('panne');
    const life = isObj(body) && typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    this.cache.set(agentId, { token, until: now + Math.max(0, life - 60) * 1000 });
    return token;
  }
}

/** Les adresses d'un en-tête (`Nom <a@b.fr>, c@d.fr`), en minuscules, sans nom. */
export function headerAddresses(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const m of value.replace(/"[^"]*"/g, ' ').matchAll(/<?([^\s<>,;:"()]+@[^\s<>,;:"()]+\.[^\s<>,;:"()]+)>?/g)) {
    out.push(m[1]!.toLowerCase());
  }
  return [...new Set(out)];
}

/** Les entités nommées des mails en français, et les plus courantes ; les autres restent telles quelles. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', ouml: 'ö', oelig: 'œ',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yuml: 'ÿ',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Auml: 'Ä', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Icirc: 'Î', Iuml: 'Ï', Ocirc: 'Ô', Ouml: 'Ö', OElig: 'Œ', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', Yuml: 'Ÿ',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', hellip: '…', ndash: '–', mdash: '—',
  euro: '€', deg: '°', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', sup2: '²', times: '×', shy: '', zwnj: '', zwj: '', thinsp: ' ', ensp: ' ', emsp: ' ',
};

/** Le texte lisible d'un HTML : sans balises, sans styles ni scripts, entités courantes rendues. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, ref: string) => {
      if (ref[0] === '#') {
        const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
      }
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, ref) ? HTML_ENTITIES[ref]! : whole;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Base64 ou base64url en octets ; illisible : `null`. */
export function base64Bytes(data: string): Uint8Array | null {
  const clean = data.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  try {
    const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Le texte d'une partie, lu dans le jeu de caractères qu'elle déclare ; inconnu ou absent : UTF-8. */
export function decodeText(bytes: Uint8Array, contentType: string | null | undefined): string {
  const charset = /charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(contentType ?? '')?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
    } catch {
      // Un jeu de caractères que l'environnement ne connaît pas : UTF-8.
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function firstSince(since: Date | null, now: Date): Date {
  return since ?? new Date(now.getTime() - MAILBOX_FIRST_DAYS * DAY_MS);
}

// ---------------------------------------------------------------------------------------------------------------------
// Gmail (API Gmail v1)

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

function walk(part: GmailPart | undefined, visit: (p: GmailPart) => void): void {
  if (!part) return;
  visit(part);
  for (const child of Array.isArray(part.parts) ? part.parts : []) walk(child, visit);
}

export class GmailMailbox implements MailboxProvider {
  readonly provider: MailProvider = 'gmail';
  private readonly tokens: AccessTokens;

  constructor(private readonly cfg: RealMailboxConfig) {
    this.tokens = new AccessTokens(cfg, GOOGLE_TOKEN, null);
  }

  /** Cet agent a-t-il relié sa boîte Gmail ? */
  connected(agentId: string): boolean {
    return this.tokens.has(agentId);
  }

  private async get(agentId: string, url: string): Promise<unknown> {
    return call(this.cfg, url, { headers: { authorization: `Bearer ${await this.tokens.of(agentId)}`, accept: 'application/json' } });
  }

  async receivedSince(agentId: string, since: Date | null, skip: ReadonlySet<string> = new Set()): Promise<MailIn[]> {
    const now = (this.cfg.now ?? (() => new Date()))();
    // Une seconde plus tôt : `after:` compte en secondes ; un mail relu n'est trié qu'une fois [R18].
    const after = Math.max(0, Math.floor(firstSince(since, now).getTime() / 1000) - 1);
    const q = `after:${after} -in:chats -in:spam -in:trash -in:drafts`;
    const ids: string[] = [];
    let pageToken: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= GMAIL_MAX_PAGES) throw new MailboxError('trop');
      const params = new URLSearchParams({ q, maxResults: '500', includeSpamTrash: 'false' });
      if (pageToken) params.set('pageToken', pageToken);
      const body = await this.get(agentId, `${GMAIL}/messages?${params.toString()}`);
      const list = isObj(body) && Array.isArray(body.messages) ? body.messages : [];
      for (const m of list) {
        const id = isObj(m) ? str(m.id) : null;
        if (id) ids.push(id);
      }
      pageToken = isObj(body) ? str(body.nextPageToken) : null;
      if (!pageToken) break;
    }
    // Gmail rend les plus récents d'abord : les plus anciens sont à la fin.
    // Les mails déjà triés autour du curseur ne prennent pas de place dans le lot : il avance toujours [R18].
    const oldest = [...new Set(ids)].filter((id) => !skip.has(id)).slice(-MAILBOX_BATCH);
    const out: MailIn[] = [];
    for (const id of oldest) {
      const mail = await this.read(agentId, id);
      if (mail) out.push(mail);
    }
    return out.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  private async read(agentId: string, id: string): Promise<MailIn | null> {
    const body = await this.get(agentId, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
    if (!isObj(body)) throw new MailboxError('panne');
    const externalId = str(body.id);
    const threadId = str(body.threadId);
    const at = Number(body.internalDate);
    if (!externalId || !threadId || !Number.isFinite(at) || at <= 0) throw new MailboxError('panne');
    const labels = Array.isArray(body.labelIds) ? body.labelIds.filter((l): l is string => typeof l === 'string') : [];
    if (labels.includes('DRAFT') || labels.includes('SPAM') || labels.includes('TRASH') || labels.includes('CHAT')) return null;
    const payload = isObj(body.payload) ? (body.payload as GmailPart) : undefined;
    const header = (name: string): string | null => {
      const h = (payload?.headers ?? []).find((x) => typeof x?.name === 'string' && x.name.toLowerCase() === name);
      return typeof h?.value === 'string' ? h.value : null;
    };
    let textPlain: string | null = null;
    let textHtml: string | null = null;
    const pending: { part: GmailPart; name: string; type: string }[] = [];
    const texts: { part: GmailPart; type: 'text/plain' | 'text/html' }[] = [];
    walk(payload, (p) => {
      const type = (p.mimeType ?? '').toLowerCase();
      const name = typeof p.filename === 'string' ? p.filename : '';
      // Une partie de texte sans nom est le texte du mail, même quand Gmail la range à part (`attachmentId`).
      if (name === '' && (type === 'text/plain' || type === 'text/html')) {
        if (p.body?.data || p.body?.attachmentId) texts.push({ part: p, type });
        return;
      }
      if (name !== '' || p.body?.attachmentId) pending.push({ part: p, name, type });
    });
    for (const { part, type } of texts) {
      if ((type === 'text/plain' && textPlain !== null) || (type === 'text/html' && textHtml !== null)) continue;
      let data = part.body?.data ? base64Bytes(part.body.data) : null;
      if (!data && part.body?.attachmentId) {
        const a = await this.get(agentId, `${GMAIL}/messages/${encodeURIComponent(externalId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`);
        data = isObj(a) && typeof a.data === 'string' ? base64Bytes(a.data) : null;
        // Un texte annoncé et illisible : le mail n'est pas rendu à moitié, la lecture reprendra [R18].
        if (!data) throw new MailboxError('panne');
      }
      if (!data) continue;
      const declared = (part.headers ?? []).find((x) => typeof x?.name === 'string' && x.name.toLowerCase() === 'content-type')?.value ?? null;
      if (type === 'text/plain') textPlain = decodeText(data, declared);
      else textHtml = htmlText(decodeText(data, declared));
    }
    const attachments: MailAttachmentIn[] = [];
    for (const { part, name, type } of pending.slice(0, MAX_ATTACHMENTS_READ)) {
      const size = typeof part.body?.size === 'number' ? part.body.size : 0;
      let bytes: Uint8Array = new Uint8Array(0);
      if (size <= MAIL_ATTACHMENT_MAX_BYTES) {
        const inline = part.body?.data ? base64Bytes(part.body.data) : null;
        if (inline) bytes = inline;
        else if (part.body?.attachmentId) {
          const a = await this.get(agentId, `${GMAIL}/messages/${encodeURIComponent(externalId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`);
          bytes = (isObj(a) && typeof a.data === 'string' ? base64Bytes(a.data) : null) ?? new Uint8Array(0);
        }
      }
      attachments.push({ fileName: name, contentType: type || 'application/octet-stream', bytes });
    }
    const sent = labels.includes('SENT');
    const to = [...headerAddresses(header('to')), ...headerAddresses(header('cc')), ...headerAddresses(header('bcc'))];
    const from = headerAddresses(header('from'))[0] ?? '';
    return {
      provider: 'gmail',
      externalId,
      threadId,
      from,
      ...(sent ? { direction: 'out' as const, to: [...new Set(to)] } : {}),
      body: (textPlain ?? textHtml ?? '').trim(),
      receivedAt: new Date(at),
      attachments,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Outlook (Microsoft Graph)

/** Les dossiers d'Outlook jamais lus : brouillons, éléments supprimés, courrier indésirable. */
const OUTLOOK_EXCLUDED = ['drafts', 'deleteditems', 'junkemail'] as const;

const graphAddress = (v: unknown): string | null => {
  const e = isObj(v) && isObj(v.emailAddress) ? str(v.emailAddress.address) : null;
  return e ? e.toLowerCase() : null;
};

export class OutlookMailbox implements MailboxProvider {
  readonly provider: MailProvider = 'outlook';
  private readonly tokens: AccessTokens;

  constructor(private readonly cfg: RealMailboxConfig) {
    this.tokens = new AccessTokens(cfg, msToken(cfg.client.tenant ?? 'common'), 'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read');
  }

  connected(agentId: string): boolean {
    return this.tokens.has(agentId);
  }

  private async get(agentId: string, url: string): Promise<unknown> {
    return call(this.cfg, url, { headers: { authorization: `Bearer ${await this.tokens.of(agentId)}`, accept: 'application/json', prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' } });
  }

  /** Les identifiants des dossiers connus de la boîte (envoyés, et ceux jamais lus), gardés en mémoire. */
  private readonly folders = new Map<string, { sent: string; excluded: Set<string>; own: Set<string> }>();

  private async folderIds(agentId: string): Promise<{ sent: string; excluded: Set<string>; own: Set<string> }> {
    const hit = this.folders.get(agentId);
    if (hit) return hit;
    const idOf = async (name: string): Promise<string> => {
      const body = await this.get(agentId, `${GRAPH}/mailFolders/${name}?$select=id`);
      const id = isObj(body) ? str(body.id) : null;
      if (!id) throw new MailboxError('panne');
      return id;
    };
    const sent = await idOf('sentitems');
    const excluded = new Set<string>();
    for (const name of OUTLOOK_EXCLUDED) excluded.add(await idOf(name));
    // Les adresses de la boîte elle-même : un mail qu'elles ont envoyé reste un mail de l'agent, même rangé ailleurs.
    const me = await this.get(agentId, `${GRAPH}?$select=mail,userPrincipalName,proxyAddresses`);
    const own = new Set<string>();
    if (isObj(me)) {
      for (const v of [me.mail, me.userPrincipalName]) if (typeof v === 'string' && v.includes('@')) own.add(v.toLowerCase());
      for (const v of Array.isArray(me.proxyAddresses) ? me.proxyAddresses : []) if (typeof v === 'string' && /^smtp:/i.test(v)) own.add(v.slice(5).toLowerCase());
    }
    if (own.size === 0) throw new MailboxError('panne');
    const ids = { sent, excluded, own };
    this.folders.set(agentId, ids);
    return ids;
  }

  async receivedSince(agentId: string, since: Date | null, skip: ReadonlySet<string> = new Set()): Promise<MailIn[]> {
    const now = (this.cfg.now ?? (() => new Date()))();
    const from = firstSince(since, now).toISOString();
    const { sent, excluded, own } = await this.folderIds(agentId);
    // Toute la boîte, quel que soit le dossier où le mail a été rangé ou archivé, du plus ancien au plus récent.
    const params = new URLSearchParams({
      $select: 'id,conversationId,receivedDateTime,parentFolderId,from,toRecipients,ccRecipients,bccRecipients,body,hasAttachments,isDraft',
      // Les dossiers jamais lus et les brouillons sont écartés par Graph lui-même : ils ne prennent aucune page.
      $filter: [`receivedDateTime ge ${from}`, 'isDraft eq false', ...[...excluded].map((id) => `parentFolderId ne '${id.replace(/'/g, "''")}'`)].join(' and '),
      $orderby: 'receivedDateTime asc',
      $top: String(MAILBOX_BATCH),
    });
    let url: string | null = `${GRAPH}/messages?${params.toString()}`;
    const chosen: { mail: Json; at: number; out: boolean }[] = [];
    // Les pages suivent tant que le lot n'est pas plein des mails pas encore triés ; 10 pages au plus.
    for (let page = 0; url && chosen.length < MAILBOX_BATCH; page += 1) {
      // Au-delà : ce qui est trouvé est rendu, et la lecture suivante repart de son dernier mail.
      if (page >= OUTLOOK_MAX_PAGES) break;
      const body = await this.get(agentId, url);
      const list = isObj(body) && Array.isArray(body.value) ? body.value.filter(isObj) : [];
      for (const m of list) {
        if (chosen.length >= MAILBOX_BATCH) break;
        const at = Date.parse(String(m.receivedDateTime));
        const id = str(m.id);
        if (!id || !str(m.conversationId) || !Number.isFinite(at)) throw new MailboxError('panne');
        const folder = str(m.parentFolderId);
        if (skip.has(id) || m.isDraft === true || (folder !== null && excluded.has(folder))) continue;
        chosen.push({ mail: m, at, out: folder === sent || own.has(graphAddress(m.from) ?? '') });
      }
      const next = isObj(body) ? str(body['@odata.nextLink']) : null;
      // Seule une page suivante chez Graph lui-même est suivie.
      url = next && next.startsWith(`${GRAPH}/`) ? next : null;
    }
    const out: MailIn[] = [];
    for (const { mail, at, out: isOut } of chosen) {
      const externalId = str(mail.id)!;
      const threadId = str(mail.conversationId)!;
      // Toujours lues : Graph dit `hasAttachments: false` pour un mail qui n'a que des images dans son texte.
      const attachments = await this.attachments(agentId, externalId);
      const to = (['toRecipients', 'ccRecipients', 'bccRecipients'] as const)
        .flatMap((k) => (Array.isArray(mail[k]) ? (mail[k] as unknown[]) : []))
        .map(graphAddress)
        .filter((a): a is string => a !== null);
      const bodyObj = isObj(mail.body) ? mail.body : {};
      const content = typeof bodyObj.content === 'string' ? bodyObj.content : '';
      const text = String(bodyObj.contentType).toLowerCase() === 'html' ? htmlText(content) : content;
      out.push({
        provider: 'outlook',
        externalId,
        threadId,
        from: graphAddress(mail.from) ?? '',
        ...(isOut ? { direction: 'out' as const, to: [...new Set(to)] } : {}),
        body: text.trim(),
        receivedAt: new Date(at),
        attachments,
      });
    }
    return out;
  }

  /** Les pièces d'un mail : d'abord leur taille seule, puis le contenu des seules pièces assez petites. */
  private async attachments(agentId: string, id: string): Promise<MailAttachmentIn[]> {
    const base = `${GRAPH}/messages/${encodeURIComponent(id)}/attachments`;
    const body = await this.get(agentId, `${base}?$select=id,name,contentType,size&$top=${MAX_ATTACHMENTS_READ}`);
    const list = isObj(body) && Array.isArray(body.value) ? body.value.filter(isObj) : [];
    const out: MailAttachmentIn[] = [];
    for (const a of list.slice(0, MAX_ATTACHMENTS_READ)) {
      if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
      const size = typeof a.size === 'number' ? a.size : Number.POSITIVE_INFINITY;
      const attId = str(a.id);
      let bytes: Uint8Array = new Uint8Array(0);
      if (attId && size <= MAIL_ATTACHMENT_MAX_BYTES) {
        const full = await this.get(agentId, `${base}/${encodeURIComponent(attId)}`);
        bytes = (isObj(full) && typeof full.contentBytes === 'string' ? base64Bytes(full.contentBytes) : null) ?? new Uint8Array(0);
      }
      out.push({ fileName: typeof a.name === 'string' ? a.name : '', contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream', bytes });
    }
    return out;
  }
}
