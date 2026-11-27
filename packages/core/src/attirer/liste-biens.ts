/**
 * La liste publique des biens d'un site (RS01) [R220, R153, R44, R46, R48, R14, R201].
 *
 * Elle ne lit que les annonces publiées. **Jamais vu** : aucune annonce fantôme. Chaque bien repasse la porte de diffusion
 * à l'instant où la page est préparée, sans attendre le passage de publication, et la page écrit l'heure de ce contrôle.
 * Un mandat échu, rétracté ou annulé retire donc le bien, quelle que soit la version publiée.
 *
 * Un bien vendu ou retiré dans le socle sort lui aussi aussitôt, même si son mandat court encore.
 *
 * Du plus récent au plus ancien, le même ordre pour tous : aucun agent n'est mis en avant [R14]. Chaque lecture ne
 * contrôle que les biens de sa page : une adresse profonde coûte autant que la première, et les pages restent stables.
 */
import { euros } from '../annonces/mentions.ts';
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import type { PublishedListing } from './referencement.ts';
import { PUBLIC_SEARCH_ENTRY_CSS, publicSearchEntry } from '../recherche/page-publique.ts';

export const LISTINGS_PER_PAGE = 24;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PAGE = /^[1-9]\d{0,3}$/;
const STATE_LABEL: Record<PublishedListing['state'], string> = { en_vente: 'En vente', sous_offre: 'Sous offre' };

/** La porte de diffusion, seule à dire si un bien peut être montré maintenant [R42]. */
export interface ListingGate {
  canDiffuse(networkId: string, propertyId: string, at?: Date): Promise<{ allowed: boolean }>;
}

/** Les états du bien où une annonce peut encore se dire disponible, comme le passage de publication les lit. */
export const LISTABLE_STATUSES: readonly string[] = ['draft', 'available', 'under_offer'];

export interface ListingsQuery {
  commune: string | null;
  page: number;
}

/** Le nom d'une commune dans une adresse : « Saint-Apollinaire » donne `saint-apollinaire`. */
export function communeSlug(city: string): string {
  return city
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** La commune et la page demandées ; `null` pour tout paramètre inattendu ou répété. */
export function parseListingsQuery(params: URLSearchParams): ListingsQuery | null {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some((k) => k !== 'commune' && k !== 'page')) return null;
  const commune = params.get('commune');
  const page = params.get('page');
  if (commune !== null && !SLUG.test(commune)) return null;
  if (page !== null && !PAGE.test(page)) return null;
  return { commune, page: page === null ? 1 : Number(page) };
}

export interface ListingsSelection {
  items: PublishedListing[];
  hasNext: boolean;
  /** Les communes qu'on peut choisir, par ordre alphabétique. */
  communes: { slug: string; name: string }[];
}

/**
 * Les biens de la page demandée, chacun accepté par la porte à cet instant [R220]. `null` : page ou commune inconnue.
 * `published` est déjà réduit au site qui répond [R153].
 */
export async function selectListings(published: readonly PublishedListing[], gate: ListingGate, networkId: string, at: Date, query: ListingsQuery): Promise<ListingsSelection | null> {
  const names = new Map<string, string>();
  for (const l of published) {
    const slug = l.city ? communeSlug(l.city) : '';
    if (slug && !names.has(slug)) names.set(slug, l.city!);
  }
  if (query.commune !== null && !names.has(query.commune)) return null;
  const candidates = listable(published).filter((l) => query.commune === null || (l.city !== null && communeSlug(l.city) === query.commune));
  const start = (query.page - 1) * LISTINGS_PER_PAGE;
  if (query.page > 1 && candidates.length <= start) return null;
  const items: PublishedListing[] = [];
  for (const l of candidates.slice(start, start + LISTINGS_PER_PAGE)) {
    if ((await gate.canDiffuse(networkId, l.propertyId, at)).allowed) items.push(l);
  }
  return {
    items,
    hasNext: candidates.length > start + LISTINGS_PER_PAGE,
    communes: [...names].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
  };
}

/** Les biens encore disponibles dans le socle, du plus récent au plus ancien : le même ordre pour tous [R14]. */
function listable(published: readonly PublishedListing[]): PublishedListing[] {
  return published
    .filter((l) => LISTABLE_STATUSES.includes(l.propertyStatus))
    .sort((a, b) => (b.day ?? '').localeCompare(a.day ?? '') || a.propertyId.localeCompare(b.propertyId));
}

/**
 * Les derniers biens d'un site, pour son accueil (RS02), chacun accepté par la porte à cet instant [R220]. Pas plus de
 * contrôles que pour une page de la liste, quel que soit le nombre de biens refusés.
 */
export async function latestListings(published: readonly PublishedListing[], gate: ListingGate, networkId: string, at: Date, count: number): Promise<PublishedListing[]> {
  const items: PublishedListing[] = [];
  for (const l of listable(published).slice(0, LISTINGS_PER_PAGE)) {
    if (items.length >= count) break;
    if ((await gate.canDiffuse(networkId, l.propertyId, at)).allowed) items.push(l);
  }
  return items;
}

/** Le cadre d'une page du site et ses cartes de biens, communs à la liste et à l'accueil [R201]. */
export const SITE_CSS =
  DESIGN_CSS +
  '.tete{display:flex;align-items:center;justify-content:space-between;gap:var(--e-4);padding:var(--e-4)}' +
  'main{max-width:72rem;margin:0 auto;padding:var(--e-5) var(--e-4) var(--e-8)}' +
  '.controle{border-left:.25rem solid var(--accent);padding-left:var(--e-3)}' +
  '.biens{display:grid;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));gap:var(--e-5);margin:var(--e-5) 0;padding:0;list-style:none}' +
  '.biens li{position:relative}.biens a{display:block}.biens img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:var(--trait);border-radius:var(--r-m)}' +
  '.biens strong{display:block;margin-top:var(--e-2)}.biens .prix{display:block;font-weight:700}.biens small{display:block;margin-top:var(--e-1)}' +
  '.virtuel{position:absolute;left:var(--e-2);top:var(--e-2);background:var(--encre);color:var(--papier);font-size:var(--t-s);padding:0 var(--e-2)}';

const CSS =
  SITE_CSS +
  PUBLIC_SEARCH_ENTRY_CSS +
  '.communes{display:flex;flex-wrap:wrap;gap:var(--e-2) var(--e-4);padding:0;list-style:none}.communes [aria-current]{font-weight:700}' +
  '.suite{display:flex;justify-content:space-between;gap:var(--e-4)}';

/** La date et l'heure d'un contrôle, à Paris. */
export const when = (at: Date): string => {
  const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).format(at).replace(':', ' h ');
  return `${date} à ${time}`;
};

const mediaUrl = (ref: string): string => `/medias/${ref.split('/').map(encodeURIComponent).join('/')}`;

function hrefOf(query: { commune: string | null; page: number }): string {
  const params = [...(query.commune ? [`commune=${query.commune}`] : []), ...(query.page > 1 ? [`page=${query.page}`] : [])];
  return `/biens${params.length > 0 ? `?${params.join('&amp;')}` : ''}`;
}

export function listingCard(l: PublishedListing): string {
  // Une photo d'aménagement virtuel porte sa mention sur l'image [R48].
  const photo = l.photo
    ? `<img src="${escapeHtml(mediaUrl(l.photo.ref))}" alt="${l.photo.overlay ? 'Photo du bien, aménagement virtuel' : 'Photo du bien'}" loading="lazy" decoding="async">${l.photo.overlay ? `<span class="virtuel">${escapeHtml(l.photo.overlay)}</span>` : ''}`
    : '';
  return `<li><a href="/biens/${encodeURIComponent(l.propertyId)}">${photo}<strong>${escapeHtml(l.title)}</strong><span class="prix">${escapeHtml(euros(l.priceEur))}</span></a><span class="doux">${l.city ? `${escapeHtml(l.city)} · ` : ''}${STATE_LABEL[l.state]}</span><small class="doux">${escapeHtml(l.mentions)}</small></li>`;
}

export interface ListingsPageInput extends ListingsSelection {
  query: ListingsQuery;
  checkedAt: Date;
}

export function renderListingsPage(input: ListingsPageInput): string {
  const { query, communes, items } = input;
  const current = communes.find((c) => c.slug === query.commune);
  const title = current ? `Biens en vente à ${current.name}` : 'Biens en vente';
  const pageTitle = query.page > 1 ? `${title}, page ${query.page}` : title;
  const filters =
    communes.length > 1
      ? `<nav aria-label="Communes"><ul class="communes"><li><a href="/biens"${query.commune === null ? ' aria-current="page"' : ''}>Toutes les communes</a></li>${communes
          .map((c) => `<li><a href="${hrefOf({ commune: c.slug, page: 1 })}"${c.slug === query.commune ? ' aria-current="page"' : ''}>${escapeHtml(c.name)}</a></li>`)
          .join('')}</ul></nav>`
      : '';
  const list = items.length > 0 ? `<ul class="biens">${items.map(listingCard).join('')}</ul>` : `<p class="doux">${input.hasNext || query.page > 1 ? 'Aucun bien à montrer sur cette page.' : `Aucun bien en vente en ce moment${current ? ` à ${escapeHtml(current.name)}` : ''}.`}</p>`;
  const previous = query.page > 1 ? `<a rel="prev" href="${hrefOf({ commune: query.commune, page: query.page - 1 })}">Page précédente</a>` : '<span></span>';
  const next = input.hasNext ? `<a rel="next" href="${hrefOf({ commune: query.commune, page: query.page + 1 })}">Page suivante</a>` : '';
  const pages = query.page > 1 || input.hasNext ? `<nav class="suite" aria-label="Pages">${previous}${next}</nav>` : '';
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}"><title>${escapeHtml(pageTitle)}</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p><a href="/">Accueil</a></header><div class="frise" aria-hidden="true"></div><main><h1>${escapeHtml(pageTitle)}</h1>${publicSearchEntry()}` +
    `${filters}${list}<p class="controle">Mandats vérifiés le ${when(input.checkedAt)} : seuls les biens sous mandat en vigueur sont montrés.</p>${pages}<p class="doux">Annonces des agents immobiliers du réseau AIMMO. Les adresses exactes ne sont jamais publiées.</p></main></body></html>`
  );
}
