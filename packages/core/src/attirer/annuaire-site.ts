/**
 * Les deux listes du site du réseau (RS03) [R14, R150, R152, R201].
 *
 * `GET /agents` : les agents dont la page est publiable, par ordre alphabétique, chacun avec ses mentions à côté de son
 * nom. Aucun chiffre sur leur activité, aucune note, aucun classement. `GET /prix` : les communes dont la page de prix a
 * au moins une case publiable. Le site d'un agent n'a ni l'une ni l'autre [R153].
 */
import { THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { SITE_CSS } from './liste-biens.ts';
import { mentionsLine, type PublicAgent } from './page-agent.ts';
import type { PublicCommune } from './referencement.ts';

const CSS = SITE_CSS + '.annuaire{display:grid;gap:var(--e-4);margin:var(--e-5) 0;padding:0;list-style:none;max-width:46rem}.annuaire a{font-weight:700}.annuaire p{margin:var(--e-1) 0 0}';

function page(title: string, intro: string, body: string): string {
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p><a href="/">Accueil</a></header><div class="frise" aria-hidden="true"></div><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p>${body}</main></body></html>`
  );
}

export function renderAgentsList(agents: readonly PublicAgent[]): string {
  const body =
    agents.length > 0
      ? `<ul class="annuaire">${agents
          .map((a) => `<li><a href="/agents/${encodeURIComponent(a.agentId)}">${escapeHtml(a.name)}</a>${a.zone ? `<p>${escapeHtml(a.zone)}</p>` : ''}<p class="doux">${escapeHtml(mentionsLine(a.mentions))}</p></li>`)
          .join('')}</ul>`
      : '<p class="doux">Aucun agent à présenter pour le moment.</p>';
  return page('Les agents immobiliers du réseau', 'Par ordre alphabétique.', body);
}

export function renderPricesList(communes: readonly PublicCommune[]): string {
  const body =
    communes.length > 0
      ? `<ul class="annuaire">${communes.map((c) => `<li><a href="/prix/${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a></li>`).join('')}</ul>`
      : '<p class="doux">Aucun prix à publier pour le moment.</p>';
  return page('Les prix de l’immobilier par commune', 'Sur les ventes réelles, en chiffres regroupés. Une commune n’apparaît ici que si ses ventes sont assez nombreuses pour qu’aucune ne puisse être retrouvée.', body);
}
