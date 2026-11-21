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
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
  else v = v.replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? Math.round(n) : null;
}

/** Les objets de premier niveau des données schema.org d'une page, dans l'ordre (un tableau ou un `@graph` déplié). */
export function structuredData(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(push);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o['@graph'] !== undefined) push(o['@graph']);
      else out.push(o);
    }
  };
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      push(JSON.parse(m[1]!.trim()));
    } catch {
      // Un bloc illisible ne fait pas tomber les autres.
    }
  }
  return out;
}

const LISTING_TYPES = new Set(['RealEstateListing', 'Offer', 'Product', 'Residence', 'House', 'Apartment', 'SingleFamilyResidence', 'Accommodation']);
const typesOf = (o: Record<string, unknown>): string[] => (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).filter((t): t is string => typeof t === 'string');
/** Les paramètres de suivi d'une adresse, qui ne désignent jamais l'annonce. */
const TRACKING = /^(?:utm_.*|xtor|gclid|fbclid|msclkid|at_.*|cmp|origin|from)$/i;

/** La clé d'une adresse d'annonce : hôte, chemin et paramètres qui la désignent, triés ; le suivi et l'ancre ôtés. */
export function listingKey(url: string, base?: string): string | null {
  try {
    const u = new URL(url, base);
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}?${new URLSearchParams(params).toString()}`;
  } catch {
    return null;
  }
}

const sameUrl = (a: unknown, b: string): boolean => typeof a === 'string' && listingKey(a, b) !== null && listingKey(a, b) === listingKey(b);

/**
 * L'annonce relue parmi les données de la page : celle dont l'adresse est la page lue, sinon la première annonce de la
 * page. Une annonce recommandée plus bas, vendue ou non, ne dit rien de celle-ci.
 */
export function mainListing(data: readonly Record<string, unknown>[], pageUrl?: string): Record<string, unknown> | null {
  const candidates = data.filter((o) => typesOf(o).some((t) => LISTING_TYPES.has(t)) || o.offers !== undefined || o.price !== undefined);
  if (pageUrl) {
    const own = candidates.find((o) => sameUrl(o.url, pageUrl) || sameUrl(o['@id'], pageUrl));
    if (own) return own;
  }
  return candidates[0] ?? null;
}

/** Les offres d'une annonce : elle-même, ses `offers`, et le prix de chacune. */
const offersOf = (o: Record<string, unknown>, data: readonly Record<string, unknown>[] = []): Record<string, unknown>[] => {
  const raw = o.offers;
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap((x): Record<string, unknown>[] => {
    // Une offre désignée par son `@id` (« { "@id": "#offre" } » ou la chaîne seule) se lit dans le nœud qu'elle désigne.
    const id = typeof x === 'string' ? x : x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>)['@id'] : undefined;
    const node = typeof id === 'string' ? data.find((d) => d !== o && d['@id'] === id) : undefined;
    if (node) return [{ ...node, ...(typeof x === 'object' ? (x as Record<string, unknown>) : {}) }];
    return x && typeof x === 'object' && !Array.isArray(x) ? [x as Record<string, unknown>] : [];
  });
  return [...list, o];
};

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
  // Une balise de mise en forme (« <strong>D</strong> ») ne coupe pas le texte ; une balise de bloc le sépare.
  const bare = html
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|font|i|ins|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(bare).replace(/\s+/g, ' ').trim();
}

const classIn = (text: string, words: RegExp): string | null => {
  const m = text.match(new RegExp(`${words.source}[^A-Za-z]{0,20}\\b([A-G])\\b`, 'i'));
  return m && CLASS.test(m[1]!.toUpperCase()) ? m[1]!.toUpperCase() : null;
};

/** Ce qu'une page d'annonce dit, ou une erreur quand elle ne dit pas assez pour être comparée. */
export function parseListingPage(html: string, pageUrl?: string): OnlineListing {
  const data = structuredData(html);
  const main = mainListing(data, pageUrl);
  const offers = main ? offersOf(main, data) : [];
  if (offers.some((d) => typeof d.availability === 'string' && GONE.test(d.availability))) return { found: false };
  const text = visibleText(html);
  // Le premier prix lisible de l'annonce relue ; un prix vide ou illisible laisse la place au texte.
  let priceEur: number | null = null;
  for (const d of offers) {
    const spec = d.priceSpecification && typeof d.priceSpecification === 'object' && !Array.isArray(d.priceSpecification) ? (d.priceSpecification as Record<string, unknown>) : null;
    priceEur = eurosOf(typeof d.price === 'string' ? decodeEntities(d.price) : d.price) ?? eurosOf(spec?.price);
    if (priceEur !== null) break;
  }
  if (priceEur === null) {
    // Sans donnée structurée : le premier prix écrit en euros dans la page.
    const m = text.match(/(\d{1,3}(?:[\s\u00a0\u202f.]\d{3})+(?:[.,]\d{1,2})?|\d{4,9}(?:[.,]\d{1,2})?)\s*(?:€|euros?\b)/i);
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
      return parseListingPage(html, u.href);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
