/**
 * Le système de design d'AIMMO (Z03) [R201]. Un seul endroit pour les couleurs, la typographie, les espacements,
 * les rayons, les ombres et les mouvements : tout écran, de l'application de l'agent aux pages publiques, commence par
 * `DESIGN_CSS` et n'ajoute que des règles de mise en page qui lisent ces jetons (`var(--…)`), jamais une couleur ni
 * une police à lui. Le contrôle est dans `audit.ts`, et chaque écran y passe dans les tests.
 *
 * L'identité : les toits vernissés de Bourgogne. Un papier chaud, une encre presque noire, un bordeaux « lie de vin »
 * pour agir, un jaune moutarde de Dijon pour souligner, et le losange des tuiles comme seul motif : devant les titres,
 * dans la marque et en frise sous l'en-tête. Titres en romain de livre (polices du système, rien à télécharger),
 * texte en police du système, chiffres alignés. Téléphone d'abord : cibles de 48 px, une colonne, rien de caché.
 */

/** Les couleurs, en clair et en sombre. Les paires texte/fond sont contrôlées au contraste dans les tests. */
export const PALETTE = Object.freeze({
  clair: Object.freeze({
    papier: '#f6f1e7',
    surface: '#fffcf5',
    encre: '#1d1915',
    doux: '#5e5549',
    trait: '#e4dac8',
    accent: '#7c1f32',
    surAccent: '#fffcf5',
    accentDoux: '#f4e4e2',
    moutarde: '#d6a019',
    surMoutarde: '#1d1915',
    tuile: '#2f5d47',
    succes: '#24613f',
    danger: '#a3231b',
    surDanger: '#ffffff',
    dangerDoux: '#fbe6e2',
    anneau: '#7c1f32',
  }),
  sombre: Object.freeze({
    papier: '#15120f',
    surface: '#1f1b17',
    encre: '#f3ece1',
    doux: '#b9ae9e',
    trait: '#3a332c',
    accent: '#f0a6b0',
    surAccent: '#2a0c13',
    accentDoux: '#3b1f24',
    moutarde: '#e8b43c',
    surMoutarde: '#1d1915',
    tuile: '#7fbf9e',
    succes: '#8ad3a8',
    danger: '#ff9d90',
    surDanger: '#2b0905',
    dangerDoux: '#3d1b16',
    anneau: '#e8b43c',
  }),
});

export type Teinte = keyof typeof PALETTE.clair;

/** Les paires qu'un écran a le droit d'utiliser pour du texte : [texte, fond]. Toutes à 4,5 au moins. */
export const PAIRES_TEXTE: readonly (readonly [Teinte, Teinte])[] = Object.freeze([
  ['encre', 'papier'],
  ['encre', 'surface'],
  ['encre', 'accentDoux'],
  ['encre', 'dangerDoux'],
  ['doux', 'papier'],
  ['doux', 'surface'],
  ['accent', 'papier'],
  ['accent', 'surface'],
  ['accent', 'accentDoux'],
  ['surAccent', 'accent'],
  ['surMoutarde', 'moutarde'],
  ['succes', 'papier'],
  ['succes', 'surface'],
  ['danger', 'papier'],
  ['danger', 'surface'],
  ['danger', 'dangerDoux'],
  ['surDanger', 'danger'],
  ['tuile', 'surface'],
]);

/** Les traits qui doivent se voir (anneau de focus, bord d'un champ) : 3 au moins contre le papier et la surface. */
export const PAIRES_TRAIT: readonly (readonly [Teinte, Teinte])[] = Object.freeze([
  ['anneau', 'papier'],
  ['anneau', 'surface'],
  ['doux', 'surface'],
  ['accent', 'papier'],
]);

const VARS: Readonly<Record<Teinte, string>> = Object.freeze({
  papier: '--papier',
  surface: '--surface',
  encre: '--encre',
  doux: '--doux',
  trait: '--trait',
  accent: '--accent',
  surAccent: '--sur-accent',
  accentDoux: '--accent-doux',
  moutarde: '--moutarde',
  surMoutarde: '--sur-moutarde',
  tuile: '--tuile',
  succes: '--succes',
  danger: '--danger',
  surDanger: '--sur-danger',
  dangerDoux: '--danger-doux',
  anneau: '--anneau',
});

const colors = (t: Readonly<Record<Teinte, string>>): string =>
  (Object.keys(VARS) as Teinte[]).map((k) => `${VARS[k]}:${t[k]}`).join(';');

/** Polices : celles du système, rien à télécharger. */
export const POLICES = Object.freeze({
  titre: '"Iowan Old Style","Charter","Palatino Linotype","Book Antiqua",Georgia,serif',
  texte: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
});

/** Les jetons hors couleurs : typographie, espacements, rayons, ombres, mouvements. */
const JETONS = [
  `--police-titre:${POLICES.titre}`,
  `--police-texte:${POLICES.texte}`,
  '--t-xs:.8125rem;--t-s:.9375rem;--t-m:1.0625rem;--t-l:1.25rem;--t-xl:1.625rem;--t-xxl:clamp(2rem,8vw,2.75rem)',
  '--e-1:4px;--e-2:8px;--e-3:12px;--e-4:16px;--e-5:24px;--e-6:32px;--e-7:48px;--e-8:72px',
  '--r-s:6px;--r-m:12px;--r-l:20px;--r-rond:999px',
  '--cible:48px;--colonne:38rem',
  '--ombre:0 1px 0 var(--trait),0 12px 28px -20px rgba(29,25,21,.45)',
  '--m-vite:120ms;--m-normal:220ms;--m-courbe:cubic-bezier(.2,.7,.2,1)',
  // Le losange des tuiles vernissées : la frise sous l'en-tête.
  '--frise:repeating-linear-gradient(135deg,var(--accent) 0 6px,var(--moutarde) 6px 12px,var(--tuile) 12px 18px,var(--encre) 18px 24px)',
].join(';');

/**
 * La base commune de tout écran. Les classes partagées : `.marque` (le nom AIMMO et son losange), `.bloc` (une carte),
 * `.liste`, `.lien` (un lien seul sur sa ligne, à la taille du doigt), `.doux`, `.etat`, `.pastille`, `.secondaire`, `.retour`, `.danger`, `.case`, `.alerte`, `.notes` (une
 * échelle de choix), `.carte` (le cadre d'une page publique courte).
 */
export const DESIGN_CSS =
  `:root{color-scheme:light dark;${colors(PALETTE.clair)};${JETONS}}` +
  `@media (prefers-color-scheme:dark){:root{${colors(PALETTE.sombre)};--ombre:0 1px 0 var(--trait)}}` +
  '*,*::before,*::after{box-sizing:border-box}' +
  'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}' +
  'body{margin:0;background:var(--papier);color:var(--encre);font:400 var(--t-m)/1.55 var(--police-texte);-webkit-font-smoothing:antialiased;font-feature-settings:"kern"}' +
  'h1,h2,h3,h4{font-family:var(--police-titre);font-weight:600;line-height:1.15;letter-spacing:-.01em;margin:0 0 var(--e-3);text-wrap:balance}' +
  'h1{font-size:var(--t-xxl)}h2{font-size:var(--t-xl)}h3{font-size:var(--t-l)}h4{font-size:var(--t-m);font-family:var(--police-texte);letter-spacing:0}' +
  'p{margin:0 0 var(--e-3)}' +
  'a{color:var(--accent);text-underline-offset:.2em;text-decoration-thickness:1px}a:hover{text-decoration-thickness:2px}' +
  // Un lien seul sur sa ligne se touche du doigt : la cible fait la hauteur d'un bouton [DS077].
  '.lien{display:inline-flex;align-items:center;min-height:var(--cible);min-width:var(--cible)}' +
  'strong{font-weight:650}' +
  'img{max-width:100%;height:auto;display:block}' +
  '.doux,.etat{color:var(--doux);font-size:var(--t-s)}' +
  '.etat:empty{display:none}' +
  // La marque : le nom en capitales espacées, précédé du losange moutarde.
  '.marque{display:flex;align-items:center;gap:var(--e-2);margin:0;font:700 var(--t-s)/1 var(--police-texte);letter-spacing:.18em;text-transform:uppercase;color:var(--encre)}' +
  '.marque::before{content:"";width:12px;height:12px;flex:none;background:var(--moutarde);transform:rotate(45deg);border-radius:2px}' +
  '.frise{height:6px;background:var(--frise);border:0;margin:0}' +
  // Les boutons : bordeaux plein pour l'action, filaire pour la seconde, texte pour revenir.
  'button,.appel{display:inline-flex;align-items:center;justify-content:center;gap:var(--e-2);min-height:var(--cible);padding:var(--e-3) var(--e-5);margin:var(--e-3) 0 0;border:0;border-radius:var(--r-m);background:var(--accent);color:var(--sur-accent);font:600 var(--t-m)/1.2 var(--police-texte);text-align:center;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
  'button:disabled{opacity:.55;cursor:not-allowed}' +
  'button.secondaire,button.second{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 1.5px var(--accent)}' +
  'button.retour,button.discret{background:transparent;color:var(--accent);padding-left:0;padding-right:0;font-weight:600}' +
  'button.retour::before{content:"←";font-weight:400}' +
  'button.danger,.danger{width:100%;background:var(--danger);color:var(--sur-danger);font-weight:700}' +
  // Les champs.
  'label{display:block;font-weight:600;margin:var(--e-4) 0 var(--e-2)}' +
  'input,select,textarea{display:block;width:100%;min-height:var(--cible);padding:var(--e-3) var(--e-4);font:inherit;color:var(--encre);background:var(--surface);border:1.5px solid var(--doux);border-radius:var(--r-m)}' +
  'textarea{min-height:7rem;resize:vertical}' +
  'input[type=checkbox],input[type=radio]{width:24px;height:24px;min-height:0;padding:0;accent-color:var(--accent);flex:none}' +
  'input[type=file]{padding:var(--e-2)}' +
  'fieldset{border:0;margin:0 0 var(--e-4);padding:0}legend{font-weight:600;margin-bottom:var(--e-2);padding:0}' +
  '.case{display:flex;align-items:center;gap:var(--e-3);min-height:var(--cible);margin:var(--e-2) 0;font-weight:400}' +
  // Le focus se voit toujours, au clavier.
  ':focus-visible{outline:3px solid var(--anneau);outline-offset:3px;border-radius:var(--r-s)}' +
  // Les cartes, listes et pastilles.
  '.bloc,.carte{background:var(--surface);border:1px solid var(--trait);border-radius:var(--r-l);padding:var(--e-5) var(--e-4);margin:var(--e-4) 0 0;box-shadow:var(--ombre)}' +
  '.bloc>h3::before,.titre-losange::before{content:"";display:inline-block;width:.5em;height:.5em;margin:0 .5em .12em 0;background:var(--moutarde);transform:rotate(45deg);border-radius:1px}' +
  '.liste{list-style:none;margin:0;padding:0}' +
  '.liste>li{padding:var(--e-4) 0;border-top:1px solid var(--trait);overflow-wrap:anywhere}' +
  '.liste>li:first-child{border-top:0;padding-top:var(--e-2)}' +
  '.liste p{margin:var(--e-1) 0 0}' +
  '.pastille{display:inline-flex;align-items:center;min-height:28px;padding:var(--e-1) var(--e-3);border-radius:var(--r-rond);background:var(--accent-doux);color:var(--accent);font-weight:650;font-size:var(--t-s)}' +
  '.alerte{padding:var(--e-3) var(--e-4);border-radius:var(--r-m);background:var(--danger-doux);color:var(--encre);box-shadow:inset 4px 0 0 var(--danger)}' +
  '.retard{color:var(--danger);font-weight:600}' +
  '.fait{color:var(--succes);font-weight:650}' +
  // Une échelle de choix (une note de 1 à 5) : de grandes cases, la choisie en bordeaux.
  '.notes{display:flex;gap:var(--e-2)}' +
  '.notes label{flex:1;display:flex;align-items:center;justify-content:center;min-height:56px;margin:0;border:1.5px solid var(--doux);border-radius:var(--r-m);background:var(--surface);font:600 var(--t-l)/1 var(--police-titre);cursor:pointer}' +
  '.notes input{position:absolute;opacity:0;width:1px;height:1px}' +
  '.notes label:has(input:checked){background:var(--accent);border-color:var(--accent);color:var(--sur-accent)}' +
  '.notes label:has(input:focus-visible){outline:3px solid var(--anneau);outline-offset:3px}' +
  // Repli pour les navigateurs sans `:has` : le chiffre choisi et le focus se voient quand même.
  '.notes input:checked+span{color:var(--accent);text-decoration:underline;text-decoration-thickness:3px;text-underline-offset:.25em}' +
  '.notes input:focus-visible+span{outline:3px solid var(--anneau);outline-offset:6px}' +
  '.notes label:has(input:checked) span{color:var(--sur-accent)}' +
  '.chiffres,.valeur,.prix{font-variant-numeric:tabular-nums lining-nums}' +
  // Les mouvements : courts, et aucun pour qui les a coupés.
  '@media (prefers-reduced-motion:no-preference){button,.appel,summary,.notes label{transition:transform var(--m-vite) var(--m-courbe),background-color var(--m-normal) var(--m-courbe),box-shadow var(--m-normal) var(--m-courbe)}button:active,.appel:active{transform:scale(.97)}main>section:not([hidden]){animation:entree var(--m-normal) var(--m-courbe)}}' +
  '@keyframes entree{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
  '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important;scroll-behavior:auto!important}}' +
  '[hidden]{display:none!important}' +
  '.visuellement-cache{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}';

/** La couleur de la barre du navigateur, celle du papier clair. */
export const THEME_COLOR = PALETTE.clair.papier;

/** L'icône d'AIMMO : le losange moutarde sur bordeaux, et la maison en papier. */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${PALETTE.clair.accent}"/><path d="M14 33 32 17l18 16v17H38V39H26v11H14z" fill="${PALETTE.clair.surface}"/><path d="m32 6 5 5-5 5-5-5z" fill="${PALETTE.clair.moutarde}"/></svg>`;

/**
 * Les jetons pour le papier imprimé (fiche du bien, documents) : noir sur blanc, l'encre et le bordeaux du système,
 * les mêmes polices. Une feuille imprimée n'a pas de mode sombre.
 */
export const PRINT_DESIGN_CSS =
  `:root{${colors(PALETTE.clair)};--papier:#ffffff;--surface:#ffffff;--police-titre:${POLICES.titre};--police-texte:${POLICES.texte}}` +
  '*,*::before,*::after{box-sizing:border-box}' +
  'body{margin:0;background:var(--papier);color:var(--encre);font-family:var(--police-titre)}';

const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface PublicPageOptions {
  /** Le titre, en texte : il est échappé ici. */
  title: string;
  /** Le corps, déjà en HTML sûr. */
  body: string;
  /** `noindex` par défaut : une page de lien personnel ne se retrouve pas par un moteur. */
  robots?: 'index' | 'noindex';
  /** Une petite ligne sous la marque (par exemple « Après la vente »). */
  kicker?: string;
}

/**
 * Le cadre des pages publiques courtes (désinscription, opposition, avis) : la marque, la frise, une carte, le titre
 * et le corps. Rien d'extérieur : ni police, ni image, ni script.
 */
export function renderPublicPage(o: PublicPageOptions): string {
  const kicker = o.kicker ? `<span class="doux">${escape(o.kicker)}</span>` : '';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="${o.robots ?? 'noindex'}">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="${THEME_COLOR}">
<title>${escape(o.title)}</title>
<style>${DESIGN_CSS}${PUBLIC_PAGE_CSS}</style>
</head>
<body><header class="tete"><p class="marque">AIMMO</p>${kicker}</header><div class="frise" aria-hidden="true"></div><main><div class="carte"><h1>${escape(o.title)}</h1>${o.body}</div></main></body>
</html>`;
}

/** La mise en page des pages publiques courtes, en jetons seulement. */
export const PUBLIC_PAGE_CSS =
  '.tete{display:flex;align-items:center;justify-content:space-between;gap:var(--e-4);padding:var(--e-4)}' +
  'main{max-width:var(--colonne);margin:0 auto;padding:var(--e-6) var(--e-4) var(--e-8)}' +
  '.carte{padding:var(--e-6) var(--e-5)}.carte h1{font-size:var(--t-xl)}' +
  '.carte form button[type=submit]{width:100%;margin-top:var(--e-4)}' +
  'ul{padding-left:1.2rem}';

/**
 * Les deux étiquettes du diagnostic de performance énergétique (AU006) [R43, R201] : l'échelle « énergie » de A à G,
 * du vert au rouge, et l'échelle « climat » de A à G, du bleu clair au violet sombre, aux couleurs du modèle officiel
 * du DPE de 2021. Ce sont les seules couleurs hors palette du système : elles ne suivent pas le mode sombre, parce que
 * l'étiquette est un dessin réglementaire, et chaque barre porte le texte (noir ou blanc) qui lui donne un contraste
 * de 4,5 au moins, vérifié dans les tests. Aucun seuil chiffré sur les barres : ils changent avec la surface (moins
 * de 40 m²) et la classe énergie tient aussi aux émissions ; seules la lettre et la couleur sont sûres.
 */
export const ETIQUETTES_DPE = Object.freeze({
  energie: Object.freeze([
    ['#009c6d', '#000000'],
    ['#52b153', '#000000'],
    ['#78bd76', '#000000'],
    ['#f4e70f', '#000000'],
    ['#f0b40f', '#000000'],
    ['#eb8235', '#000000'],
    ['#d7221f', '#ffffff'],
  ] as const),
  climat: Object.freeze([
    ['#a4dbf8', '#000000'],
    ['#8cb4d3', '#000000'],
    ['#7792b1', '#000000'],
    ['#5f6e8c', '#ffffff'],
    ['#4d5271', '#ffffff'],
    ['#393551', '#ffffff'],
    ['#281b35', '#ffffff'],
  ] as const),
});

// Les couleurs sont écrites dans les seules barres, jamais en jetons : aucun écran ne peut les reprendre pour son
// texte sans passer par le contrôle de contraste [R201].
const etiquetteBars = (['energie', 'climat'] as const)
  .flatMap((k) => ETIQUETTES_DPE[k].map(([fond, texte], i) => `.${k} li:nth-child(${i + 1}) b{background:${fond};color:${texte};width:${40 + i * 10}%}`))
  .join('');

/**
 * Le dessin des deux étiquettes, à placer juste après la base (écran ou papier) : il fait partie du système, le
 * contrôle des écrans le reconnaît. Barres en flèche de largeur croissante, la classe du bien plus haute, cerclée
 * d'encre et dite en mots ; les couleurs sont imprimées telles quelles.
 */
export const ETIQUETTES_CSS =
  '.etiquettes{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:var(--e-5);margin:var(--e-6) 0}' +
  '.etiquette{margin:0}.etiquette figcaption{font-weight:700;margin-bottom:var(--e-2)}' +
  '.echelle{list-style:none;margin:0;padding:0;display:grid;gap:3px}.echelle li{display:flex;align-items:center;gap:var(--e-2)}' +
  '.echelle b{display:flex;justify-content:flex-end;align-items:center;min-height:1.7em;padding:0 1.1em 0 .5em;font-size:.85em;clip-path:polygon(0 0,calc(100% - .8em) 0,100% 50%,calc(100% - .8em) 100%,0 100%);-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
  '.echelle b i{font-style:normal;font-size:1.35em}' +
  '.echelle .ce-bien b{min-height:2.4em;font-size:1em;box-shadow:inset 0 0 0 3px var(--encre)}.echelle .ce-bien strong{white-space:nowrap}' +
  etiquetteBars;
