/**
 * Les vraies boîtes Gmail et Outlook des agents (AU043), derrière l'interface `MailboxProvider` de HX26.
 *
 * Elles ne sont faites que par le Worker, et seulement quand tout est rangé (H55) : le mode `reel`, le client OAuth de
 * Google ou de Microsoft (identifiant et secret) et, pour chaque agent qui a donné son accord, le jeton de
 * rafraîchissement de sa boîte. Sinon aucune boîte n'est lue [R683].
 *
 * - le jeton d'accès est tiré du jeton de rafraîchissement, gardé en mémoire jusqu'à une minute avant sa fin ; seule la
 *   lecture est demandée (`gmail.readonly`, `Mail.Read`) : aucune adresse ici n'envoie, ne déplace ni n'efface un mail ;
 * - Gmail : la liste des mails de la boîte (reçus et envoyés, ni brouillons, ni indésirables, ni corbeille), du plus
 *   récent au plus ancien, puis les plus anciens d'abord, 50 au plus par lecture ; un mail porte son fil (`threadId`) ;
 * - Outlook : la boîte de réception et les éléments envoyés, chacun du plus ancien au plus récent, mêlés par date, 50 au
 *   plus en tout ; quand l'un des deux est coupé, rien de plus récent que son dernier mail lu n'est rendu, pour que le
 *   curseur du tri ne passe jamais au-delà d'un mail pas encore lu [R18] ; le fil est la conversation (`conversationId`) ;
 *   la taille des pièces est lue d'abord, et seul le contenu des pièces assez petites est demandé ;
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

/** Le texte lisible d'un HTML : sans balises, sans styles ni scripts, entités courantes rendues. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
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

const utf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

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
    walk(payload, (p) => {
      const type = (p.mimeType ?? '').toLowerCase();
      const name = typeof p.filename === 'string' ? p.filename : '';
      if (name !== '' || p.body?.attachmentId) {
        pending.push({ part: p, name, type });
        return;
      }
      const data = p.body?.data ? base64Bytes(p.body.data) : null;
      if (!data) return;
      if (type === 'text/plain' && textPlain === null) textPlain = utf8(data);
      else if (type === 'text/html' && textHtml === null) textHtml = htmlText(utf8(data));
    });
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
    const to = [...headerAddresses(header('to')), ...headerAddresses(header('cc'))];
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

const OUTLOOK_FOLDERS = [
  { folder: 'inbox', direction: 'in' as const },
  { folder: 'sentitems', direction: 'out' as const },
];

const graphAddress = (v: unknown): string | null => {
  const e = isObj(v) && isObj(v.emailAddress) ? str(v.emailAddress.address) : null;
  return e ? e.toLowerCase() : null;
};

export class OutlookMailbox implements MailboxProvider {
  readonly provider: MailProvider = 'outlook';
  private readonly tokens: AccessTokens;

  constructor(private readonly cfg: RealMailboxConfig) {
    this.tokens = new AccessTokens(cfg, msToken(cfg.client.tenant ?? 'common'), 'offline_access https://graph.microsoft.com/Mail.Read');
  }

  connected(agentId: string): boolean {
    return this.tokens.has(agentId);
  }

  private async get(agentId: string, url: string): Promise<unknown> {
    return call(this.cfg, url, { headers: { authorization: `Bearer ${await this.tokens.of(agentId)}`, accept: 'application/json', prefer: 'outlook.body-content-type="text"' } });
  }

  async receivedSince(agentId: string, since: Date | null, skip: ReadonlySet<string> = new Set()): Promise<MailIn[]> {
    const now = (this.cfg.now ?? (() => new Date()))();
    const from = firstSince(since, now).toISOString();
    const found: { mail: Json; at: number; direction: 'in' | 'out' }[] = [];
    let cut: number | null = null;
    for (const { folder, direction } of OUTLOOK_FOLDERS) {
      const params = new URLSearchParams({
        $select: 'id,conversationId,receivedDateTime,from,toRecipients,ccRecipients,body,hasAttachments,isDraft',
        $filter: `receivedDateTime ge ${from}`,
        $orderby: 'receivedDateTime asc',
        $top: String(MAILBOX_BATCH),
      });
      let url: string | null = `${GRAPH}/mailFolders/${folder}/messages?${params.toString()}`;
      let kept = 0;
      let last: number | null = null;
      // Les pages suivent tant que le lot n'est pas plein des mails pas encore triés ; 10 pages au plus.
      for (let page = 0; url && kept < MAILBOX_BATCH; page += 1) {
        if (page >= OUTLOOK_MAX_PAGES) throw new MailboxError('trop');
        const body = await this.get(agentId, url);
        const list = isObj(body) && Array.isArray(body.value) ? body.value.filter(isObj) : [];
        for (const m of list) {
          const at = Date.parse(String(m.receivedDateTime));
          const id = str(m.id);
          if (!id || !str(m.conversationId) || !Number.isFinite(at)) throw new MailboxError('panne');
          last = at;
          if (skip.has(id) || m.isDraft === true) continue;
          found.push({ mail: m, at, direction });
          kept += 1;
        }
        const next = isObj(body) ? str(body['@odata.nextLink']) : null;
        // Seule une page suivante chez Graph lui-même est suivie.
        url = next && next.startsWith(`${GRAPH}/`) ? next : null;
      }
      // Coupé : rien de plus récent que son dernier mail lu n'est rendu dans cette lecture [R18].
      if (url && last !== null) cut = cut === null ? last : Math.min(cut, last);
    }
    // Les deux dossiers mêlés par date, 50 au plus en tout, avant de lire une seule pièce jointe.
    const chosen = found
      .filter((f) => cut === null || f.at <= cut)
      .sort((x, y) => x.at - y.at)
      .slice(0, MAILBOX_BATCH);
    const out: MailIn[] = [];
    for (const { mail, at, direction } of chosen) {
      const externalId = str(mail.id)!;
      const threadId = str(mail.conversationId)!;
      const attachments = mail.hasAttachments === true ? await this.attachments(agentId, externalId) : [];
      const to = [...(Array.isArray(mail.toRecipients) ? mail.toRecipients : []), ...(Array.isArray(mail.ccRecipients) ? mail.ccRecipients : [])].map(graphAddress).filter((a): a is string => a !== null);
      const bodyObj = isObj(mail.body) ? mail.body : {};
      const content = typeof bodyObj.content === 'string' ? bodyObj.content : '';
      const text = String(bodyObj.contentType).toLowerCase() === 'html' ? htmlText(content) : content;
      out.push({
        provider: 'outlook',
        externalId,
        threadId,
        from: graphAddress(mail.from) ?? '',
        ...(direction === 'out' ? { direction: 'out' as const, to: [...new Set(to)] } : {}),
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
