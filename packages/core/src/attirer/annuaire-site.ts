/**
 * Les deux listes du site du réseau (RS03) [R14, R150, R152, R201].
 *
 * `GET /agents` : les agents dont la page est publiable, par ordre alphabétique, chacun avec ses mentions à côté de son
 * nom. Aucun chiffre sur leur activité, aucune note, aucun classement. `GET /prix` : les communes dont la page de prix a
 * au moins une case publiable. Le site d'un agent n'a ni l'une ni l'autre [R153]. Chacune va par pages : le budget d'une
 * page tient quel que soit le nombre d'agents ou de communes [R201].
 */
import { THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { SITE_CSS } from './liste-biens.ts';
import { mentionsLine, type PublicAgent } from './page-agent.ts';
import type { PublicCommune } from './referencement.ts';

export const AGENTS_PER_PAGE = 100;
export const COMMUNES_PER_PAGE = 500;

/** La page demandée d'une liste ; `null` pour tout autre paramètre. */
export function parseDirectoryPage(params: URLSearchParams): number | null {
  const keys = [...params.keys()];
  if (keys.length === 0) return 1;
  if (keys.length !== 1 || keys[0] !== 'page') return null;
  const page = params.get('page')!;
  return /^[1-9]\d{0,3}$/.test(page) ? Number(page) : null;
}

const CSS = SITE_CSS + '.suite{display:flex;justify-content:space-between;gap:var(--e-4)}.annuaire{display:grid;gap:var(--e-4);margin:var(--e-5) 0;padding:0;list-style:none;max-width:46rem}.annuaire a,.suite a{display:inline-flex;align-items:center;min-height:var(--cible);min-width:var(--cible)}.annuaire a{font-weight:700}.annuaire p{margin:var(--e-1) 0 0}';

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

export function renderAgentsList(agents: readonly PublicAgent[], pageNumber = 1): string | null {
  const part = slice(agents, pageNumber, AGENTS_PER_PAGE, '/agents');
  if (!part) return null;
  const body =
    agents.length > 0
      ? `<ul class="annuaire">${part.shown
          .map((a) => `<li><a href="/agents/${encodeURIComponent(a.agentId)}">${escapeHtml(a.name)}</a>${a.zone ? `<p>${escapeHtml(a.zone)}</p>` : ''}<p class="doux">${escapeHtml(mentionsLine(a.mentions))}</p></li>`)
          .join('')}</ul>${part.pages}`
      : '<p class="doux">Aucun agent à présenter pour le moment.</p>';
  return page('Les agents immobiliers du réseau', 'Par ordre alphabétique.', body);
}

export function renderPricesList(communes: readonly PublicCommune[], pageNumber = 1): string | null {
  const part = slice(communes, pageNumber, COMMUNES_PER_PAGE, '/prix');
  if (!part) return null;
  const body =
    communes.length > 0
      ? `<ul class="annuaire">${part.shown.map((c) => `<li><a href="/prix/${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a></li>`).join('')}</ul>${part.pages}`
      : '<p class="doux">Aucun prix à publier pour le moment.</p>';
  return page('Les prix de l’immobilier par commune', 'Sur les ventes réelles, en chiffres regroupés. Une commune n’apparaît ici que si ses ventes sont assez nombreuses pour qu’aucune ne puisse être retrouvée.', body);
}
