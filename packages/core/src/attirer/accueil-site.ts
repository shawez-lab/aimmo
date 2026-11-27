/**
 * L'accueil d'un site du réseau (RS02) [R220, R153, R152, R07, R201].
 *
 * Il montre les derniers biens du site, chacun revérifié à la lecture, et les chemins vers les autres pages. Une page
 * n'entre dans `sitePaths` que lorsqu'elle existe : l'accueil et le plan du site lisent cette seule liste, et un test suit
 * chaque lien. Le recrutement et la preuve ne vivent que sur le site du réseau ; le recrutement seulement quand les
 * candidatures vont bien à ce réseau, car `/rejoindre` répond 503 sinon.
 *
 * L'entrée de la recherche avec ses mots (BR45) est en tête ; `/chercher` n'est pas dans `sitePaths`, qui fait le plan du site.
 *
 * Le site d'un agent ne dit le nom de son agent qu'avec ses mentions, et ne mène à sa page que si elle est publiable [R152].
 */
import { DEFAULT_PROFESSIONAL_TITLE, type ProfessionalTitle } from './qualite.ts';
import { THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { SITE_CSS, listingCard, when } from './liste-biens.ts';
import { mentionsLine, type AgentMentions } from './page-agent.ts';
import type { PublishedListing } from './referencement.ts';
import { PUBLIC_SEARCH_ENTRY_CSS, publicSearchEntry } from '../recherche/page-publique.ts';

/** Le nombre de biens montrés sur l'accueil : la liste montre les autres. */
export const HOME_LISTINGS = 6;

export interface SitePath {
  path: string;
  label: string;
  text: string;
}

/** Les pages qui existent sur ce type de site, hors l'accueil et la page de l'agent, qui dépend de ses mentions. */
export function sitePaths(kind: 'reseau' | 'agent', recruiting: boolean): SitePath[] {
  const common: SitePath[] = [
    { path: '/biens', label: 'Tous les biens', text: 'Chaque bien en vente, avec son mandat vérifié à la lecture.' },
  ];
  const tools: SitePath[] = [
    { path: '/estimation', label: 'Estimer mon logement', text: 'La fourchette des prix de votre commune, puis un agent immobilier pour le vôtre.' },
    { path: '/simulateur', label: 'Simuler un prêt', text: 'Une mensualité en quelques chiffres. Rien n’est gardé.' },
  ];
  if (kind === 'agent') return [...common, ...tools];
  return [
    ...common,
    { path: '/agents', label: 'Les agents immobiliers', text: 'Chaque agent du réseau, par ordre alphabétique, avec ses mentions.' },
    { path: '/prix', label: 'Les prix par commune', text: 'Ce que les logements se sont vraiment vendus, au mètre carré.' },
    ...tools,
    { path: '/preuve', label: 'La preuve à Dijon', text: 'Le compte public du réseau, mois par mois, vérifiable par chacun.' },
    ...(recruiting ? [{ path: '/rejoindre', label: 'Rejoindre le réseau', text: 'Devenir agent immobilier AIMMO : ce que vous trouvez, ce que vous payez, ce qui vous engage.' }] : []),
  ];
}

/**
 * DS071 · l'accueil n'est plus une liste de liens : une ouverture (le titre, ce que le site prouve, la recherche en grand,
 * l'estimation), les derniers biens en photo, puis les pages du site en rangées entières à toucher.
 */
const CSS =
  SITE_CSS +
  PUBLIC_SEARCH_ENTRY_CSS +
  '.ouverture{padding:var(--e-5) 0 var(--e-6)}.ouverture h1{max-width:18ch}.statut{max-width:38rem}' +
  '.accroche{max-width:34rem;font-size:var(--t-l);line-height:1.45}' +
  '.ouverture .chercher{max-width:46rem;margin:var(--e-5) 0 var(--e-3)}.ouverture .chercher input,.ouverture .chercher button{min-height:56px}.ouverture .chercher button{margin:0}' +
  '.ouverture .second{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}' +
  'h2{margin-top:var(--e-7)}' +
  '.chemins{display:grid;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));gap:0 var(--e-6);margin:var(--e-4) 0 var(--e-6);padding:0;list-style:none}' +
  '.chemins a{display:block;min-height:44px;padding:var(--e-4) 0;border-top:1px solid var(--trait);text-decoration:none}' +
  '.chemins strong{display:block;font:400 var(--t-l)/1.25 var(--police-titre)}.chemins a:hover strong{text-decoration:underline}' +
  '.chemins span{display:block;margin-top:var(--e-1);font-size:var(--t-s);color:var(--doux)}' +
  // Sur téléphone, la phrase a toute la largeur : le champ sur sa ligne, le bouton dessous.
  '@media (max-width:40rem){.ouverture .chercher input{flex-basis:100%}.ouverture .chercher button{flex:1 1 0}}';

/**
 * Ce que le site prouve, en une phrase sous le titre. Chaque mot renvoie à une page du site qui le montre : le contrôle
 * des mandats à la lecture [R220], les prix des ventes conclues (`/prix`), le compte public (`/preuve`). Le site d'un agent
 * n'a ni l'un ni l'autre : sa phrase ne les dit pas.
 */
export const HOME_LEDE: Readonly<Record<'reseau' | 'agent', string>> = {
  reseau: 'Des biens sous mandat vérifié, des prix tirés des ventes réellement conclues, un compte public mois par mois.',
  agent: 'Des biens sous mandat vérifié à chaque lecture. Les adresses exactes ne sont jamais publiées.',
};

export interface SiteHomeInput {
  kind: 'reseau' | 'agent';
  /** Les candidatures de `/rejoindre` vont à ce réseau. */
  recruiting: boolean;
  /** L'agent du site, seulement si sa page est publiable : son nom ne va jamais sans ses mentions [R152]. */
  agent: { agentId: string; name: string; mentions: AgentMentions; title?: ProfessionalTitle | undefined } | null;
  listings: readonly PublishedListing[];
  checkedAt: Date;
}

export function renderSiteHome(input: SiteHomeInput): string {
  const { agent, listings } = input;
  const title = input.kind === 'reseau' ? 'AIMMO, le réseau d’agents immobiliers' : agent ? `${agent.name}, ${agent.title ?? DEFAULT_PROFESSIONAL_TITLE}` : 'Votre agent immobilier AIMMO';
  const who = agent ? `<p class="statut doux">${escapeHtml(mentionsLine(agent.mentions))}</p>` : '';
  const paths = [
    ...(agent ? [{ path: `/agents/${encodeURIComponent(agent.agentId)}`, label: 'Son activité et ses avis', text: 'Sa page, pour le contacter et lire les avis de ses clients.' }] : []),
    ...sitePaths(input.kind, input.recruiting),
  ];
  const list = listings.length > 0 ? `<ul class="biens">${listings.map(listingCard).join('')}</ul>` : '<p class="doux">Aucun bien en vente en ce moment.</p>';
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p></header><div class="frise" aria-hidden="true"></div><main>` +
    `<section class="ouverture" aria-labelledby="titre"><h1 id="titre">${escapeHtml(title)}</h1>${who}<p class="accroche">${escapeHtml(HOME_LEDE[input.kind])}</p>${publicSearchEntry()}` +
    `<p><a class="appel second" href="/estimation">Estimer mon logement</a></p></section>` +
    `<h2>Les derniers biens</h2>${list}<p class="controle">Mandats vérifiés le ${when(input.checkedAt)} : seuls les biens sous mandat en vigueur sont montrés.</p>` +
    `<p><a class="lien" href="/biens">Voir tous les biens</a></p>` +
    `<h2>Sur ce site</h2><ul class="chemins">${paths.map((p) => `<li><a href="${escapeHtml(p.path)}"><strong>${escapeHtml(p.label)}</strong><span>${escapeHtml(p.text)}</span></a></li>`).join('')}</ul>` +
    `<p class="doux">Annonces des agents immobiliers du réseau AIMMO. Les adresses exactes ne sont jamais publiées.</p></main></body></html>`
  );
}
