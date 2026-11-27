/**
 * La recherche en langage courant sur le site public (BR44) [R420, R421, R423, R50].
 *
 * Le visiteur écrit ce qu'il cherche avec ses mots, sans compte ni connexion. La phrase est lue par le code seul, sur le
 * serveur, et n'est jamais gardée : ni en base, ni au journal, ni dans un compteur. La page ne montre que des biens
 * déjà publiés sur ce site, revérifiés à l'instant par la porte de diffusion, avec ce qu'une annonce dit, jamais
 * l'adresse [R421] ; chaque bien dit pourquoi il correspond [R420] ; une commune voisine n'entre que par un lien que
 * le visiteur suit lui-même [R423] ; les mots écartés sont dits [R50].
 *
 * Contre le moissonnage, sans rien garder du visiteur : au plus `PUBLIC_SEARCH_LIMIT` biens par liste et aucune page
 * suivante, une phrase de `PHRASE_MAX_LENGTH` signes au plus, des paramètres en liste fermée, aucune mise en cache,
 * jamais indexée, et un robot annoncé ne reçoit que le formulaire, sans aucun bien.
 */
import { euros } from '../annonces/mentions.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { DESIGN_CSS, LIEN_CSS, PUBLIC_PAGE_CSS, THEME_COLOR } from '../design/systeme.ts';
import { PHRASE_MAX_LENGTH, type PhraseResult, type PhraseResults, type SearchStep } from './langage-courant.ts';

export const PUBLIC_SEARCH_PATH = '/chercher';
/** Le plus de biens montrés dans chaque liste de la page publique : aucune page suivante. */
export const PUBLIC_SEARCH_LIMIT = 12;
/** Le plus de communes voisines acceptées dans une même adresse. */
export const PUBLIC_NEIGHBOURS_MAX = 5;
const NEIGHBOUR = /^[\p{L}][\p{L}' -]{0,79}$/u;

export type PublicSearchQuery = { phrase: null; neighbours: [] } | { phrase: string; neighbours: string[] } | { tooLong: true; phrase: string };

/**
 * La phrase et les communes voisines acceptées, depuis l'adresse ; `null` pour tout paramètre non prévu, une phrase
 * répétée ou vide, une voisine mal formée ou répétée, ou plus de `PUBLIC_NEIGHBOURS_MAX` voisines. Une phrase trop
 * longue n'est jamais tronquée en silence : elle se dit.
 */
export function parsePublicSearchQuery(params: URLSearchParams): PublicSearchQuery | null {
  const keys = [...params.keys()];
  if (keys.some((k) => k !== 'q' && k !== 'voisine')) return null;
  const phrases = params.getAll('q');
  const neighbours = params.getAll('voisine');
  if (phrases.length > 1) return null;
  if (phrases.length === 0) return neighbours.length === 0 ? { phrase: null, neighbours: [] } : null;
  const phrase = phrases[0]!;
  if (phrase.trim().length === 0) return neighbours.length === 0 ? { phrase: null, neighbours: [] } : null;
  if (phrase.length > PHRASE_MAX_LENGTH) return { tooLong: true, phrase: phrase.slice(0, PHRASE_MAX_LENGTH) };
  if (neighbours.length > PUBLIC_NEIGHBOURS_MAX || new Set(neighbours).size !== neighbours.length || neighbours.some((n) => !NEIGHBOUR.test(n))) return null;
  return { phrase, neighbours };
}

/** Les gestes du visiteur : seulement des communes voisines acceptées, que la lecture du serveur contrôle [R423]. */
export function publicSearchSteps(query: { neighbours: readonly string[] }): SearchStep[] {
  return query.neighbours.map((n) => ({ acceptNeighbour: n }));
}

/** Ce que la page publique peut dire d'un bien : son annonce publiée sur ce site. */
export interface PublicSearchListing {
  propertyId: string;
  title: string;
  priceEur: number;
  city: string | null;
}

/**
 * Seuls les biens publiés sur ce site restent, au plus `PUBLIC_SEARCH_LIMIT` par liste, dans l'ordre de la recherche ;
 * le titre et le prix sont ceux de l'annonce publiée [R421, R44].
 */
export function keepPublished(results: PhraseResults, published: readonly PublicSearchListing[]): { results: PublicSearchHit[]; neighbours: PublicSearchHit[] } {
  const byId = new Map(published.map((l) => [l.propertyId, l]));
  const keep = (list: readonly PhraseResult[]): PublicSearchHit[] => {
    const out: PublicSearchHit[] = [];
    for (const r of list) {
      const l = byId.get(r.propertyId);
      if (!l) continue;
      out.push({ propertyId: r.propertyId, title: l.title, priceEur: l.priceEur, city: l.city, status: r.status, reasons: r.reasons.map((x) => ({ text: x.text, from: x.from })), neighbourOf: r.neighbourOf });
      if (out.length === PUBLIC_SEARCH_LIMIT) break;
    }
    return out;
  };
  return { results: keep(results.results), neighbours: keep(results.neighbours) };
}

export interface PublicSearchHit {
  propertyId: string;
  title: string;
  priceEur: number;
  city: string | null;
  status: 'match' | 'tolerated';
  /** Pourquoi il correspond, et d'après quels mots de la phrase [R420]. */
  reasons: { text: string; from: string }[];
  neighbourOf: string | null;
}

export type PublicSearchPageInput =
  | { state: 'form' }
  | { state: 'robot'; phrase: string }
  | { state: 'too_long'; phrase: string }
  | {
      state: 'results';
      phrase: string;
      neighbours: readonly string[];
      results: PublicSearchHit[];
      near: PublicSearchHit[];
      proposedNeighbours: readonly { commune: string; of: string }[];
      ignored: readonly { words: string; reason: string }[];
      understood: number;
      checkedAt: Date;
    };

const CSS =
  DESIGN_CSS +
  PUBLIC_PAGE_CSS +
  LIEN_CSS +
  '.biens{list-style:none;padding:0;display:grid;gap:var(--e-4)}.biens li{display:grid;gap:var(--e-1)}' +
  '.biens a{display:flex;justify-content:space-between;gap:var(--e-3);flex-wrap:wrap}.prix{font-weight:700;white-space:nowrap}' +
  '.raisons{margin:0;padding-left:1.2rem}.voisines{display:flex;flex-wrap:wrap;gap:var(--e-2) var(--e-4);padding:0;list-style:none}' +
  'textarea{width:100%;min-height:6rem;font:inherit}';

function hrefOf(phrase: string, neighbours: readonly string[]): string {
  const p = new URLSearchParams();
  p.append('q', phrase);
  for (const n of neighbours) p.append('voisine', n);
  return `${PUBLIC_SEARCH_PATH}?${p.toString()}`;
}

const when = (d: Date): string =>
  new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d);

function form(phrase: string): string {
  return (
    `<form method="get" action="${PUBLIC_SEARCH_PATH}" role="search"><label for="q">Décrivez le bien que vous cherchez, avec vos mots</label>` +
    `<textarea id="q" name="q" maxlength="${PHRASE_MAX_LENGTH}" required placeholder="Un appartement de trois pièces à Dijon avec balcon, jusqu'à 250 000 euros">${escapeHtml(phrase)}</textarea>` +
    `<button type="submit">Chercher</button></form>` +
    `<p class="doux">Votre phrase n'est ni gardée ni transmise : elle sert à cette recherche, puis s'efface.</p>`
  );
}

/**
 * L'entrée de la recherche sur l'accueil et la liste des biens du site (BR45) : un formulaire sans script vers la page,
 * même champ, même longueur. La page n'entre jamais dans le plan du site ni dans ses chemins : elle n'est pas indexée.
 */
export function publicSearchEntry(): string {
  return (
    `<form class="chercher" method="get" action="${PUBLIC_SEARCH_PATH}" role="search"><label for="chercher-q">Cherchez avec vos mots</label>` +
    `<input id="chercher-q" name="q" type="search" maxlength="${PHRASE_MAX_LENGTH}" required placeholder="Trois pièces à Dijon avec balcon, jusqu'à 250 000 euros">` +
    `<button type="submit">Chercher</button></form>`
  );
}

/** Le style de l'entrée, ajouté par les pages qui la portent. */
export const PUBLIC_SEARCH_ENTRY_CSS =
  '.chercher{display:flex;flex-wrap:wrap;gap:var(--e-2);align-items:end;margin:var(--e-4) 0}' +
  '.chercher label{flex-basis:100%;font-weight:700}.chercher input{flex:1 1 14rem;min-height:44px;font:inherit}.chercher button{min-height:44px}';

function card(h: PublicSearchHit): string {
  const label = h.status === 'tolerated' ? '<span class="doux">Proche de ce que vous cherchez</span>' : '';
  const reasons = h.reasons.length > 0 ? `<ul class="raisons">${h.reasons.map((r) => `<li>${escapeHtml(r.text)}${r.from ? ` <span class="doux">D'après ${escapeHtml(r.from)}.</span>` : ''}</li>`).join('')}</ul>` : '';
  return `<li><a href="/biens/${encodeURIComponent(h.propertyId)}"><strong>${escapeHtml(h.title)}</strong><span class="prix">${escapeHtml(euros(h.priceEur))}</span></a>${h.city ? `<span class="doux">${escapeHtml(h.city)}</span>` : ''}${label}${reasons}</li>`;
}

const IGNORED_REASON: Record<string, string> = {
  negation: 'une exclusion, que la recherche ne retient pas',
  R50: 'un critère sur les personnes, que nous ne prenons jamais en compte',
};

function body(input: PublicSearchPageInput): string {
  if (input.state === 'form') return form('');
  if (input.state === 'robot') return `${form(input.phrase)}<p class="doux">La recherche se fait dans un navigateur. La liste des biens reste ouverte à tous sur <a href="/biens">Biens en vente</a>.</p>`;
  if (input.state === 'too_long') return `<p role="alert">Votre phrase dépasse ${PHRASE_MAX_LENGTH} signes : raccourcissez-la, rien n'a été cherché.</p>${form(input.phrase)}`;
  const ignored =
    input.ignored.length > 0
      ? `<p>Mots écartés : ${input.ignored.map((i) => `« ${escapeHtml(i.words)} » (${escapeHtml(IGNORED_REASON[i.reason] ?? 'non lu')})`).join(', ')}.</p>`
      : '';
  const understood = input.understood === 0 ? '<p>Nous n\'avons reconnu aucun critère dans votre phrase : précisez la commune, le type de bien, la surface ou le budget.</p>' : '';
  const results =
    input.results.length > 0
      ? `<h2>Les biens qui vous correspondent</h2><ul class="biens">${input.results.map(card).join('')}</ul>`
      : `<p>Aucun bien en vente ne correspond en ce moment.</p>`;
  const accepted = new Set(input.neighbours);
  const proposals = input.proposedNeighbours.filter((p) => !accepted.has(p.commune));
  const offer =
    proposals.length > 0 && input.neighbours.length < PUBLIC_NEIGHBOURS_MAX
      ? `<h2>Élargir à une commune voisine</h2><p class="doux">Rien n'est ajouté sans votre choix.</p><ul class="voisines">${proposals
          .map((p) => `<li><a rel="nofollow" href="${escapeHtml(hrefOf(input.phrase, [...input.neighbours, p.commune]))}">Ajouter ${escapeHtml(p.commune)}, voisine de ${escapeHtml(p.of)}</a></li>`)
          .join('')}</ul>`
      : '';
  const near =
    input.near.length > 0 ? `<h2>Dans les communes voisines</h2><p class="doux">Ces communes ne sont pas dans votre recherche.</p><ul class="biens">${input.near.map(card).join('')}</ul>` : '';
  return (
    `${form(input.phrase)}${ignored}${understood}${results}${near}${offer}` +
    `<p class="doux">Mandats vérifiés le ${when(input.checkedAt)}. Au plus ${PUBLIC_SEARCH_LIMIT} biens par liste. Les adresses exactes ne sont jamais publiées.</p>`
  );
}

/** La page de la recherche ; jamais indexée. */
export function renderPublicSearchPage(input: PublicSearchPageInput): string {
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="${THEME_COLOR}"><title>Chercher un bien avec vos mots</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p><a class="lien" href="/">Accueil</a></header><div class="frise" aria-hidden="true"></div><main><div class="carte"><h1>Chercher un bien avec vos mots</h1>${body(input)}</div></main></body></html>`
  );
}
