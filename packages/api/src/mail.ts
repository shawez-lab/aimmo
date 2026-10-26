/**
 * Lecture d'un mail brut (MIME), tel que le routage mail de Cloudflare le remet au Worker, vers la forme que lit
 * l'adaptateur mail de la réception (C01). Sans dépendance : en-têtes, mots encodés, parties multiples, base64,
 * quoted-printable, utf-8 et latin-1. Ce qui ne se lit pas reste vide : la réception range alors le mail comme
 * illisible et le signale à l'agent, jamais il n'est jeté.
 */

export interface ParsedMail {
  from: string | null;
  replyTo: string | null;
  subject: string | null;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  date: string | null;
  /** Nombre de pièces jointes : elles ne sont ni ouvertes ni gardées. */
  attachments: number;
}

/** Au-delà, le corps n'est pas lu : un mail géant porte des pièces jointes, pas une demande. */
export const MAX_MAIL_BYTES = 1_000_000;
const MAX_DEPTH = 5;

type Headers = Map<string, string>;

/** Octets → texte où chaque octet est un caractère, pour découper sans rien perdre. */
function binary(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function decodeCharset(bytes: Uint8Array, charset: string | null): string {
  const cs = (charset ?? 'utf-8').trim().toLowerCase();
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'us-ascii' || cs === 'ascii') return binary(bytes);
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch {
    // Jeu inconnu de l'environnement : lecture en utf-8, au plus près.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function split(raw: string): { head: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return { head: raw, body: '' };
  return { head: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

function parseHeaders(head: string): Headers {
  const headers: Headers = new Map();
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    // Le premier en-tête l'emporte : c'est celui que pose le dernier serveur, pour les champs qui comptent ici.
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

function base64Bytes(text: string): Uint8Array {
  let clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  try {
    return bytesOf(atob(clean + '='.repeat((4 - (clean.length % 4)) % 4)));
  } catch {
    return new Uint8Array();
  }
}

function quotedPrintableBytes(text: string, header = false): Uint8Array {
  const source = (header ? text.replace(/_/g, ' ') : text).replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]!;
    const hex = source.slice(i + 1, i + 3);
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(source.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Mots encodés des en-têtes : `=?utf-8?B?...?=` et `=?utf-8?Q?...?=`. */
export function decodeWords(value: string): string {
  const bytesText = value.replace(/\?=\s+=\?/g, '?==?');
  const decoded = bytesText.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) => {
    const bytes = enc.toUpperCase() === 'B' ? base64Bytes(data) : quotedPrintableBytes(data, true);
    return decodeCharset(bytes, charset.split('*')[0] ?? charset);
  });
  // Un en-tête en 8 bits sans encodage : lu comme de l'utf-8.
  return /[\x80-\xff]/.test(decoded) && decoded === bytesText ? decodeCharset(bytesOf(decoded), 'utf-8') : decoded;
}

function param(value: string | undefined, name: string): string | null {
  if (!value) return null;
  const match = new RegExp(`;\\s*${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(value);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function bodyText(headers: Headers, body: string): string {
  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  const bytes = encoding === 'base64' ? base64Bytes(body) : encoding === 'quoted-printable' ? quotedPrintableBytes(body) : bytesOf(body);
  return decodeCharset(bytes, param(headers.get('content-type'), 'charset'));
}

/** Entités nommées courantes en français ; les autres restent telles quelles. */
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä',
  ccedil: 'ç', icirc: 'î', iuml: 'ï', iacute: 'í', ocirc: 'ô', ouml: 'ö', oacute: 'ó', ugrave: 'ù',
  ucirc: 'û', uuml: 'ü', uacute: 'ú', yuml: 'ÿ', oelig: 'œ', aelig: 'æ', ntilde: 'ñ',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë', Agrave: 'À', Acirc: 'Â', Ccedil: 'Ç', Icirc: 'Î',
  Iuml: 'Ï', Ocirc: 'Ô', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', OElig: 'Œ', AElig: 'Æ',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', euro: '€',
  ndash: '–', mdash: '—', deg: '°', middot: '·', bull: '•', copy: '©', reg: '®', shy: '',
});

/** Entités nommées et numériques, décimales ou hexadécimales : le texte lu par les règles est le texte vu [R04]. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

function fromHtml(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

interface Content {
  plain: string | null;
  html: string | null;
  attachments: number;
}

function walk(headers: Headers, body: string, depth: number, out: Content): void {
  const type = (headers.get('content-type') ?? 'text/plain').split(';')[0]!.trim().toLowerCase();
  const disposition = (headers.get('content-disposition') ?? '').toLowerCase();
  if (disposition.startsWith('attachment') || (param(headers.get('content-disposition'), 'filename') && !type.startsWith('text/'))) {
    out.attachments += 1;
    return;
  }
  if (type.startsWith('multipart/')) {
    const boundary = param(headers.get('content-type'), 'boundary');
    if (!boundary || depth >= MAX_DEPTH) return;
    const parts = body.split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    for (const part of parts.slice(1)) {
      if (part.trim() === '') continue;
      const { head, body: partBody } = split(part);
      walk(parseHeaders(head), partBody, depth + 1, out);
    }
    return;
  }
  if (type === 'text/plain') {
    if (out.plain === null) out.plain = bodyText(headers, body);
  } else if (type === 'text/html') {
    if (out.html === null) out.html = fromHtml(bodyText(headers, body));
  } else if (type !== 'message/delivery-status') {
    out.attachments += 1;
  }
}

/** `totalBytes` : taille réelle du mail, quand seul son début a été lu. */
export function parseRawMail(input: Uint8Array, totalBytes = input.length): ParsedMail {
  const tooBig = totalBytes > MAX_MAIL_BYTES;
  const raw = binary(tooBig ? input.subarray(0, 64_000) : input);
  const { head, body } = split(raw);
  const headers = parseHeaders(head);
  const content: Content = { plain: null, html: null, attachments: 0 };
  if (tooBig) content.attachments = 1;
  else walk(headers, body, 0, content);
  const header = (name: string): string | null => {
    const value = headers.get(name);
    return value === undefined || value.trim() === '' ? null : decodeWords(value).trim();
  };
  return {
    from: header('from'),
    replyTo: header('reply-to'),
    subject: header('subject'),
    text: (content.plain ?? content.html ?? '').replace(/\r\n/g, '\n').trim(),
    messageId: header('message-id'),
    inReplyTo: header('in-reply-to'),
    references: header('references'),
    date: header('date'),
    attachments: content.attachments,
  };
}
