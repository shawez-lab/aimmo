/**
 * Les deux listes du site du réseau (RS03) [R14, R150, R152, R201].
 *
 * `GET /agents` : les agents dont la page est publiable, par ordre alphabétique, chacun avec ses mentions à côté de son
 * nom. Aucun chiffre sur leur activité, aucune note, aucun classement. `GET /prix` : les communes dont la page de prix a
 * au moins une case publiable. Le site d'un agent n'a ni l'une ni l'autre [R153]. Chacune va par pages : le budget d'une
 * page tient quel que soit le nombre d'agents ou de communes [R201]. Une longue liste se feuillette par lettre : l'index,
 * en haut de chaque page, mène à la page où la lettre commence, sans script (DS075).
 */
import { THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { SITE_CSS } from './liste-biens.ts';
import { mentionsLine, type PublicAgent } from './page-agent.ts';
import type { PublicCommune } from './referencement.ts';

/** Une page se parcourt du pouce en quelques écrans ; l'index par lettre mène d'une page à l'autre (DS075). */
export const AGENTS_PER_PAGE = 40;
export const COMMUNES_PER_PAGE = 200;

/** La page demandée d'une liste ; `null` pour tout autre paramètre. */
export function parseDirectoryPage(params: URLSearchParams): number | null {
  const keys = [...params.keys()];
  if (keys.length === 0) return 1;
  if (keys.length !== 1 || keys[0] !== 'page') return null;
  const page = params.get('page')!;
  return /^[1-9]\d{0,3}$/.test(page) ? Number(page) : null;
}

/** En dessous de ce nombre, la liste se lit d'un regard : ni index ni titres de lettre (DS075). */
export const AGENTS_INDEX_FROM = 20;
export const COMMUNES_INDEX_FROM = 60;

const CSS =
  SITE_CSS +
  // L'index reste en haut de l'écran : une lettre touchée y mène, où qu'on soit dans la liste.
  'html{scroll-padding-top:calc(var(--cible) + var(--e-4))}' +
  '.lettres{position:sticky;top:0;display:flex;overflow-x:auto;margin:var(--e-4) calc(-1 * var(--e-4)) 0;background:var(--papier);border-bottom:1px solid var(--trait)}' +
  '.lettres a{flex:1 0 2.75rem;display:grid;place-items:center;min-height:var(--cible);padding:0 var(--e-2);font:400 var(--t-l)/1 var(--police-titre);text-decoration:none}' +
  'main h2{margin:var(--e-6) 0 0;padding-bottom:var(--e-2);border-bottom:1px solid var(--trait)}' +
  '.suite{display:flex;justify-content:space-between;gap:var(--e-4)}.suite a{display:inline-flex;align-items:center;min-height:var(--cible);min-width:var(--cible)}' +
  '.annuaire{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(19rem,100%),1fr));gap:var(--e-4) var(--e-6);margin:var(--e-3) 0 var(--e-5);padding:0;list-style:none}' +
  '.annuaire a{display:inline-block;min-width:var(--cible);padding:var(--e-3) 0;text-decoration:none}.annuaire a:hover{text-decoration:underline}.annuaire strong{font-weight:700}' +
  '.annuaire p{margin:0}.annuaire .doux{margin-top:var(--e-1);font-size:var(--t-xs)}' +
  // Les communes : autant de colonnes que la largeur en porte, et l'alphabet se lit de gauche à droite, sans remonter.
  // Une colonne ne demande jamais plus que la largeur offerte : sur un écran très étroit, la grille rétrécit au lieu de déborder.
  '.communes{grid-template-columns:repeat(auto-fill,minmax(min(9.5rem,100%),1fr));gap:0 var(--e-5)}.communes a{display:block}';

function page(title: string, intro: string, body: string): string {
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p><a class="lien" href="/">Accueil</a></header><div class="frise" aria-hidden="true"></div><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p>${body}</main></body></html>`
  );
}

/** Les éléments d'une page et ses liens ; `null` pour une page au-delà de la fin. */
function slice<T>(items: readonly T[], page: number, size: number, path: string): { shown: readonly T[]; pages: string } | null {
  const start = (page - 1) * size;
  if (page > 1 && items.length <= start) return null;
  const hasNext = items.length > start + size;
  const previous = page > 1 ? `<a rel="prev" href="${path}${page > 2 ? `?page=${page - 1}` : ''}">Page précédente</a>` : '<span></span>';
  const next = hasNext ? `<a rel="next" href="${path}?page=${page + 1}">Page suivante</a>` : '';
  return { shown: items.slice(start, start + size), pages: page > 1 || hasNext ? `<nav class="suite" aria-label="Pages">${previous}${next}</nav>` : '' };
}

/** La lettre sous laquelle un nom se range : sans accent, en capitale ; « Autres » pour ce qui ne commence pas par une lettre. */
export function letterOf(name: string): string {
  const c = name.trim().replace(/^œ/i, 'O').replace(/^æ/i, 'A').normalize('NFD').charAt(0).toUpperCase();
  return /^[A-Z]$/.test(c) ? c : 'Autres';
}

interface Lettered<T> {
  /** L'index de toute la liste : chaque lettre mène à la page où elle commence. */
  index: string;
  /** Les éléments de la page, lettre par lettre. */
  groups: { title: string; items: T[] }[];
}

/**
 * La page rangée par lettre (DS075). La liste arrive triée : une lettre se suit d'un seul tenant. L'index se calcule sur
 * toute la liste, pas sur la page : la lettre M mène à la page où le premier M se trouve. Une lettre qui continue d'une
 * page à l'autre le dit, et seul son début porte l'ancre.
 */
function byLetter<T>(all: readonly T[], shown: readonly T[], page: number, size: number, path: string, key: (item: T) => string): Lettered<T> {
  const first = new Map<string, number>();
  all.forEach((item, i) => {
    const letter = letterOf(key(item));
    if (!first.has(letter)) first.set(letter, i);
  });
  const anchor = (letter: string): string => `lettre-${letter.toLowerCase()}`;
  const index = [...first]
    .map(([letter, i]) => {
      const at = Math.floor(i / size) + 1;
      return `<a href="${at === page ? '' : path + (at > 1 ? `?page=${at}` : '')}#${anchor(letter)}">${letter}</a>`;
    })
    .join('');
  const start = (page - 1) * size;
  const groups: { letter: string; title: string; items: T[] }[] = [];
  shown.forEach((item, i) => {
    const letter = letterOf(key(item));
    const last = groups[groups.length - 1];
    if (last && last.letter === letter) last.items.push(item);
    else groups.push({ letter, title: first.get(letter) === start + i ? `<h2 id="${anchor(letter)}">${letter}</h2>` : `<h2>${letter}, suite</h2>`, items: [item] });
  });
  return { index: `<nav class="lettres" aria-label="Aller à une lettre">${index}</nav>`, groups };
}

/** Le prénom, puis le nom de famille en gras : c'est par lui que la liste se range. */
function agentName(a: PublicAgent): string {
  const family = a.lastName.trim();
  return family && a.name.endsWith(` ${family}`) ? `${escapeHtml(a.name.slice(0, -family.length))}<strong>${escapeHtml(family)}</strong>` : escapeHtml(a.name);
}

export function renderAgentsList(agents: readonly PublicAgent[], pageNumber = 1): string | null {
  const part = slice(agents, pageNumber, AGENTS_PER_PAGE, '/agents');
  if (!part) return null;
  const list = (items: readonly PublicAgent[]): string =>
    `<ul class="annuaire">${items
      .map((a) => `<li><a href="/agents/${encodeURIComponent(a.agentId)}">${agentName(a)}</a>${a.zone ? `<p>${escapeHtml(a.zone)}</p>` : ''}<p class="doux">${escapeHtml(mentionsLine(a.mentions))}</p></li>`)
      .join('')}</ul>`;
  let body = '<p class="doux">Aucun agent à présenter pour le moment.</p>';
  if (agents.length >= AGENTS_INDEX_FROM) {
    const lettered = byLetter(agents, part.shown, pageNumber, AGENTS_PER_PAGE, '/agents', (a) => a.lastName || a.name);
    body = lettered.index + lettered.groups.map((g) => g.title + list(g.items)).join('') + part.pages;
  } else if (agents.length > 0) body = list(part.shown) + part.pages;
  return page('Les agents immobiliers du réseau', 'Par ordre alphabétique.', body);
}

export function renderPricesList(communes: readonly PublicCommune[], pageNumber = 1): string | null {
  const part = slice(communes, pageNumber, COMMUNES_PER_PAGE, '/prix');
  if (!part) return null;
  const list = (items: readonly PublicCommune[]): string =>
    `<ul class="annuaire communes">${items.map((c) => `<li><a href="/prix/${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a></li>`).join('')}</ul>`;
  let body = '<p class="doux">Aucun prix à publier pour le moment.</p>';
  if (communes.length >= COMMUNES_INDEX_FROM) {
    const lettered = byLetter(communes, part.shown, pageNumber, COMMUNES_PER_PAGE, '/prix', (c) => c.name);
    body = lettered.index + lettered.groups.map((g) => g.title + list(g.items)).join('') + part.pages;
  } else if (communes.length > 0) body = list(part.shown) + part.pages;
  return page('Les prix de l’immobilier par commune', 'Sur les ventes réelles, en chiffres regroupés. Une commune n’apparaît ici que si ses ventes sont assez nombreuses pour qu’aucune ne puisse être retrouvée.', body);
}
