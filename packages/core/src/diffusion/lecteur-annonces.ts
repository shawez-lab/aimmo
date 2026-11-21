/**
 * AU068 · Le lecteur réel des annonces en ligne (M07) [R473].
 *
 * Il relit la page publique de l'annonce, à l'adresse que le portail a rendue en acceptant la version (une adresse
 * `https` sur le domaine du portail, vérifiée à l'acceptation), et en tire ce que la relecture compare : le prix, les
 * classes énergie et climat, le texte. Il lit les données structurées que les portails publient pour les moteurs de
 * recherche (`application/ld+json`, schema.org), puis le texte visible.
 *
 * - 404 ou 410 : l'annonce n'est plus en ligne (`found: false`) ;
 * - une offre dite épuisée ou retirée (`availability` SoldOut, Discontinued, OutOfStock) : plus en ligne non plus ;
 * - toute autre réponse, une redirection, une page trop lourde ou sans prix lisible : erreur, la relecture est
 *   « illisible » et la suivante dira. Jamais une redirection suivie : la page lue est celle que le portail a donnée.
 *
 * Aucun cookie, aucune clé : la page publique, comme la lit un acquéreur.
 */
import type { OnlineListing, OnlineListingReader } from './surveillance.ts';

export type FetchLike = (url: string, init: { method: 'GET'; redirect: 'manual'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Le plus lourd qu'une page peut peser pour être lue. */
export const READER_MAX_BYTES = 3_000_000;
/** Le plus long qu'une lecture peut attendre. */
export const READER_TIMEOUT_MS = 20_000;

const GONE = /(?:SoldOut|Discontinued|OutOfStock)$/i;
const CLASS = /^[A-G]$/;

/** Un nombre d'euros lu dans une donnée structurée ou un texte : « 210 000 », 210000, "210000.00". */
export function eurosOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value !== 'string') return null;
  let v = value.replace(/[\s\u00a0\u202f]/g, '').replace(/€|EUR/gi, '');
  // « 210.000 » : des milliers séparés par des points ; « 210000,00 » ou « 210000.00 » : des centimes.
  if (/^\d{1,3}(?:\.\d{3})+$/.test(v)) v = v.replace(/\./g, '');
  else v = v.replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? Math.round(n) : null;
}

/** Les objets schema.org d'une page, à plat (y compris sous `@graph`). */
export function structuredData(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      out.push(v as Record<string, unknown>);
      const o = v as Record<string, unknown>;
      if (o['@graph'] !== undefined) walk(o['@graph']);
      for (const k of ['offers', 'mainEntity', 'itemOffered', 'about']) if (o[k] !== undefined) walk(o[k]);
    }
  };
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]!.trim()));
    } catch {
      // Un bloc illisible ne fait pas tomber les autres.
    }
  }
  return out;
}

/** Le texte visible de la page, sans balises, scripts ni styles. */
const NAMED: Record<string, string> = {
  nbsp: '\u00a0', ensp: ' ', emsp: ' ', thinsp: '\u2009', euro: '€', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—', middot: '·',
  deg: '°', sup2: '²', sup3: '³', times: '×', oelig: 'œ', OElig: 'Œ', aelig: 'æ', AElig: 'Æ', szlig: 'ß',
};
const MARKS: Record<string, string> = { '\u0300': 'grave', '\u0301': 'acute', '\u0302': 'circ', '\u0303': 'tilde', '\u0308': 'uml', '\u030a': 'ring', '\u0327': 'cedil' };
for (const ch of 'àáâãäåèéêëìíîïòóôõöùúûüýÿçñ') {
  const [letter, mark] = [...ch.normalize('NFD')] as [string, string];
  NAMED[`${letter}${MARKS[mark]}`] = ch;
  if (ch !== 'ÿ') NAMED[`${letter.toUpperCase()}${MARKS[mark]}`] = ch.toUpperCase();
}

/** Les références de caractères HTML décodées : numériques (`&#8239;`, `&#x202F;`) et nommées courantes (`&eacute;`). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,10});/gi, (all, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all;
    }
    return NAMED[ref] ?? all;
  });
}

/** Le texte visible de la page, sans balises, scripts ni styles, références de caractères décodées. */
export function visibleText(html: string): string {
  const bare = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(bare).replace(/\s+/g, ' ').trim();
}

const classIn = (text: string, words: RegExp): string | null => {
  const m = text.match(new RegExp(`${words.source}[^A-Za-z]{0,20}\\b([A-G])\\b`, 'i'));
  return m && CLASS.test(m[1]!.toUpperCase()) ? m[1]!.toUpperCase() : null;
};

/** Ce qu'une page d'annonce dit, ou une erreur quand elle ne dit pas assez pour être comparée. */
export function parseListingPage(html: string): OnlineListing {
  const data = structuredData(html);
  if (data.some((d) => typeof d.availability === 'string' && GONE.test(d.availability))) return { found: false };
  const text = visibleText(html);
  // Le premier prix lisible des données structurées ; un prix vide ou illisible laisse la place au texte.
  let priceEur: number | null = null;
  for (const d of data) {
    const spec = d.priceSpecification && typeof d.priceSpecification === 'object' && !Array.isArray(d.priceSpecification) ? (d.priceSpecification as Record<string, unknown>) : null;
    priceEur = eurosOf(typeof d.price === 'string' ? decodeEntities(d.price) : d.price) ?? eurosOf(spec?.price);
    if (priceEur !== null) break;
  }
  if (priceEur === null) {
    // Sans donnée structurée : le premier prix écrit en euros dans la page.
    const m = text.match(/(\d{1,3}(?:[\s  .]\d{3})+|\d{4,9})\s*(?:€|euros?\b)/i);
    priceEur = m ? eurosOf(m[1]!) : null;
  }
  if (priceEur === null) throw new Error('prix_illisible');
  return {
    found: true,
    priceEur,
    energyClass: classIn(text, /(?:classe\s+(?:é|e)nergie|DPE|consommation\s+(?:é|e)nerg(?:é|e)tique)/),
    climateClass: classIn(text, /(?:classe\s+climat|GES|(?:é|e)missions?\s+de\s+gaz)/),
    text,
  };
}

/** Le lecteur réel : une lecture `GET` de la page publique, sans suivre de redirection. */
export class HttpListingReader implements OnlineListingReader {
  constructor(
    private readonly fetcher: FetchLike,
    private readonly options: { timeoutMs?: number; maxBytes?: number } = {},
  ) {}

  async read(_portal: string, url: string): Promise<OnlineListing> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('adresse_refusee');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.options.timeoutMs ?? READER_TIMEOUT_MS) : null;
    try {
      const res = await this.fetcher(u.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html', 'accept-language': 'fr-FR,fr;q=0.9' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (res.status === 404 || res.status === 410) return { found: false };
      if (res.status !== 200) throw new Error('reponse_inattendue');
      const type = res.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml/i.test(type)) throw new Error('page_non_html');
      const length = Number(res.headers.get('content-length') ?? '0');
      const max = this.options.maxBytes ?? READER_MAX_BYTES;
      if (length > max) throw new Error('page_trop_lourde');
      const html = await res.text();
      if (html.length > max) throw new Error('page_trop_lourde');
      return parseListingPage(html);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
