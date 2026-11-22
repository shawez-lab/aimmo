/**
 * De faux Gmail et Outlook, qui répondent comme les vrais services aux seules adresses que lisent les adaptateurs
 * d'AU043. Tout est inventé : clients, jetons, adresses, mails.
 */

export const ACCESS = 'jeton-acces-invente-0123456789';
export const REFRESH = 'jeton-rafraichissement-invente-0123456789';
export const SECRET = 'secret-client-invente-0123456789';

export type Call = { method: string; url: string; auth: string | null; body: string | null };

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface FakeMail {
  id: string;
  threadId: string;
  at: Date;
  from: string;
  to?: string[];
  sent?: boolean;
  draft?: boolean;
  text?: string;
  html?: string;
  attachments?: { name: string; type: string; bytes: Uint8Array }[];
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Faults {
  /** Le statut et le corps rendus par l'adresse du jeton. */
  token?: { status: number; body: unknown };
  /** Le statut et le corps rendus par la liste des mails. */
  list?: { status: number; body: unknown };
  /** Une coupure du réseau sur la liste. */
  cut?: boolean;
}

/** Un faux Gmail : `GET users/me/messages`, `…/messages/{id}?format=full`, `…/attachments/{id}`. */
export function fakeGmail(mails: FakeMail[], faults: Faults = {}) {
  const calls: Call[] = [];
  let tokens = 0;
  const http = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, auth: init.headers?.authorization ?? null, body: init.body ?? null });
    if (url === 'https://oauth2.googleapis.com/token') {
      tokens += 1;
      if (faults.token) return json(faults.token.status, faults.token.body);
      const form = new URLSearchParams(init.body ?? '');
      if (form.get('refresh_token') !== REFRESH || form.get('client_secret') !== SECRET || form.get('grant_type') !== 'refresh_token') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: ACCESS, expires_in: 3600 });
    }
    if (init.headers?.authorization !== `Bearer ${ACCESS}`) return json(401, { error: { status: 'UNAUTHENTICATED', message: `adresse ${mails[0]?.from ?? ''}` } });
    const u = new URL(url);
    const base = '/gmail/v1/users/me/messages';
    if (u.pathname === base) {
      if (faults.cut) throw new TypeError('connexion coupée');
      if (faults.list) return json(faults.list.status, faults.list.body);
      const after = Number(/after:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? '0');
      const all = mails.filter((m) => !m.draft && m.at.getTime() / 1000 > after).sort((a, b) => b.at.getTime() - a.at.getTime());
      const size = Number(u.searchParams.get('maxResults') ?? '100');
      const start = Number(u.searchParams.get('pageToken') ?? '0');
      const page = all.slice(start, start + size);
      return json(200, { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}), resultSizeEstimate: all.length });
    }
    const att = new RegExp(`^${base}/([^/]+)/attachments/([^/]+)$`).exec(u.pathname);
    if (att) {
      const m = mails.find((x) => x.id === decodeURIComponent(att[1]!));
      const a = m?.attachments?.[Number(decodeURIComponent(att[2]!).replace('piece-', ''))];
      return a ? json(200, { size: a.bytes.length, data: b64url(a.bytes) }) : json(404, { error: { status: 'NOT_FOUND' } });
    }
    const one = new RegExp(`^${base}/([^/]+)$`).exec(u.pathname);
    if (one) {
      const m = mails.find((x) => x.id === decodeURIComponent(one[1]!));
      if (!m) return json(404, { error: { status: 'NOT_FOUND' } });
      const headers = [
        { name: 'From', value: `"Client, Inventé" <${m.from}>` },
        { name: 'To', value: (m.to ?? ['agent@exemple.test']).map((t, i) => (i === 0 ? `Quelqu'un <${t}>` : t)).join(', ') },
        { name: 'Subject', value: 'Objet inventé' },
      ];
      const parts = [
        ...(m.text !== undefined ? [{ mimeType: 'text/plain', filename: '', body: { size: m.text.length, data: b64url(enc(m.text)) } }] : []),
        ...(m.html !== undefined ? [{ mimeType: 'text/html', filename: '', body: { size: m.html.length, data: b64url(enc(m.html)) } }] : []),
        ...(m.attachments ?? []).map((a, i) => ({ mimeType: a.type, filename: a.name, body: { size: a.bytes.length, attachmentId: `piece-${i}` } })),
      ];
      return json(200, {
        id: m.id,
        threadId: m.threadId,
        labelIds: m.sent ? ['SENT'] : ['INBOX', 'UNREAD'],
        internalDate: String(m.at.getTime()),
        payload: { mimeType: 'multipart/mixed', headers, parts: [{ mimeType: 'multipart/alternative', parts: parts.filter((p) => p.filename === '') }, ...parts.filter((p) => p.filename !== '')] },
      });
    }
    return json(404, { error: { status: 'NOT_FOUND' } });
  };
  return { http, calls, tokens: () => tokens };
}

/** Un faux Outlook (Microsoft Graph) : boîte de réception, éléments envoyés, pièces jointes. */
export function fakeOutlook(mails: FakeMail[], faults: Faults = {}) {
  const calls: Call[] = [];
  const http = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, auth: init.headers?.authorization ?? null, body: init.body ?? null });
    if (url.startsWith('https://login.microsoftonline.com/')) {
      if (faults.token) return json(faults.token.status, faults.token.body);
      const form = new URLSearchParams(init.body ?? '');
      if (form.get('refresh_token') !== REFRESH || form.get('client_secret') !== SECRET) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: ACCESS, expires_in: 3600, refresh_token: 'nouveau-jeton-invente' });
    }
    if (init.headers?.authorization !== `Bearer ${ACCESS}`) return json(401, { error: { code: 'InvalidAuthenticationToken' } });
    const u = new URL(url);
    const folder = /^\/v1\.0\/me\/mailFolders\/([a-z]+)\/messages$/.exec(u.pathname);
    if (folder) {
      if (faults.cut) throw new TypeError('connexion coupée');
      if (faults.list) return json(faults.list.status, faults.list.body);
      const sent = folder[1] === 'sentitems';
      const ge = Date.parse(/receivedDateTime ge (\S+)/.exec(u.searchParams.get('$filter') ?? '')?.[1] ?? '1970-01-01T00:00:00Z');
      const top = Number(u.searchParams.get('$top') ?? '10');
      const all = mails.filter((m) => !!m.sent === sent && m.at.getTime() >= ge).sort((a, b) => a.at.getTime() - b.at.getTime());
      const page = all.slice(0, top);
      return json(200, {
        value: page.map((m) => ({
          id: m.id,
          conversationId: m.threadId,
          receivedDateTime: m.at.toISOString().replace('.000Z', 'Z'),
          isDraft: !!m.draft,
          hasAttachments: (m.attachments ?? []).length > 0,
          from: { emailAddress: { name: 'Client Inventé', address: m.from } },
          toRecipients: (m.to ?? ['agent@exemple.test']).map((a) => ({ emailAddress: { name: 'X', address: a } })),
          ccRecipients: [],
          body: m.html !== undefined ? { contentType: 'html', content: m.html } : { contentType: 'text', content: m.text ?? '' },
        })),
        ...(all.length > top ? { '@odata.nextLink': `${url}&$skip=${top}` } : {}),
      });
    }
    const att = /^\/v1\.0\/me\/messages\/([^/]+)\/attachments$/.exec(u.pathname);
    if (att) {
      const m = mails.find((x) => x.id === decodeURIComponent(att[1]!));
      return json(200, {
        value: (m?.attachments ?? []).map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.type, size: a.bytes.length, contentBytes: b64(a.bytes) })),
      });
    }
    return json(404, { error: { code: 'ErrorItemNotFound' } });
  };
  return { http, calls };
}
