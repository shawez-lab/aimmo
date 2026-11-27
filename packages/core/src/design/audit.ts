/**
 * Le contrôle automatique des écrans (Z03) [R201] : contraste des couleurs du système, accessibilité de chaque page,
 * appartenance au système de design et budget de performance. Sans dépendance : des règles écrites, lues dans le
 * HTML et le CSS tels que le navigateur les reçoit. Chaque fonction rend la liste des problèmes, vide si tout va.
 */
import { gzipSync } from 'node:zlib';
import { DESIGN_CSS, ETIQUETTES_CSS, PRINT_DESIGN_CSS } from './systeme.ts';

/* ---------- Contraste ---------- */

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`couleur illisible : ${hex}`);
  const n = parseInt(m[1]!, 16);
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Le rapport de contraste WCAG 2 entre deux couleurs `#rrggbb`, de 1 à 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------- Appartenance au système ---------- */

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
/** Les propriétés qui posent une couleur. */
const COLOR_PROPERTY =
  /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-start|-end)?)?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|accent-color|caret-color|text-decoration(?:-color)?|column-rule(?:-color)?|scrollbar-color|text-emphasis(?:-color)?)$/;
/** Les mots permis dans une valeur de couleur : aucun ne pose une teinte. */
const COLOR_WORDS_OK: ReadonlySet<string> = new Set(['inherit', 'initial', 'unset', 'revert', 'transparent', 'currentcolor', 'none', 'solid', 'dashed', 'dotted', 'double', 'inset', 'outset', 'groove', 'ridge', 'auto', 'thin', 'medium', 'thick', 'underline', 'overline', 'line-through', 'calc']);
/** Les mots permis dans `font` en plus des jetons : jamais un nom de police. */
const FONT_WORDS_OK: ReadonlySet<string> = new Set(['normal', 'italic', 'oblique', 'bold', 'bolder', 'lighter', 'small-caps', 'inherit', 'clamp', 'min', 'max', 'calc']);

const withoutTokens = (value: string): string => value.replace(/var\(--[a-z0-9-]+\)/gi, ' ');

/** Les mots qui restent dans une valeur, jetons, nombres et mots permis retirés. Un nom entre guillemets reste. */
const leftoverWords = (value: string, allowed: ReadonlySet<string>): string[] =>
  (
    withoutTokens(value)
      .replace(/"[^"]*"|'[^']*'/g, ' nom-cite ')
      .replace(/-?\d*\.?\d+[a-z%]*/gi, ' ')
      .match(/[a-z][a-z-]*/gi) ?? []
  ).filter((w) => !allowed.has(w.toLowerCase()));

/** Chaque déclaration `propriété: valeur` d'une feuille. */
function declarations(css: string): { property: string; value: string }[] {
  const out: { property: string; value: string }[] = [];
  for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
    for (const part of block[1]!.split(';')) {
      const i = part.indexOf(':');
      if (i > 0) out.push({ property: part.slice(0, i).trim().toLowerCase(), value: part.slice(i + 1).trim() });
    }
  }
  return out;
}

/**
 * Les règles propres à un écran, ajoutées après la base du système : elles ne posent ni couleur ni police à elles,
 * ne chargent rien, ne bougent pas et ne forcent rien. Seuls les jetons (`var(--…)`) et des mots sans teinte
 * (`inherit`, `transparent`, `currentColor`, `none`, styles de trait) sont permis dans une couleur.
 */
export function localCssProblems(css: string): string[] {
  const problems: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const color = COLOR_LITERAL.exec(text);
  if (color) problems.push(`couleur hors système : ${color[0]}`);
  for (const d of declarations(text)) {
    if (COLOR_PROPERTY.test(d.property) && !COLOR_LITERAL.test(d.value) && leftoverWords(d.value, COLOR_WORDS_OK).length > 0) problems.push(`couleur nommée hors système : ${d.property}: ${d.value}`);
    if (d.property === 'font-family' && !/^(?:var\(--police-[a-z]+\)|inherit)$/.test(d.value)) problems.push(`police hors système : ${d.value}`);
    if (d.property === 'font' && (!(/var\(--police-[a-z]+\)/.test(d.value) || d.value === 'inherit') || leftoverWords(d.value, FONT_WORDS_OK).length > 0)) {
      problems.push(`police hors système : ${d.value}`);
    }
    if (/^(?:transition|animation)(?:-[a-z-]+)?$/.test(d.property)) problems.push(`mouvement hors système : ${d.property}, seuls ceux de la base respectent « réduire les animations »`);
  }
  if (/!important/.test(text)) problems.push('« !important » hors système');
  if (/@import|@font-face/i.test(text)) problems.push('chargement hors système (@import ou @font-face)');
  if (/@keyframes/i.test(text)) problems.push('mouvement hors système : @keyframes');
  if (/url\(\s*['"]?(?:https?:)?\/\//i.test(text)) problems.push('ressource extérieure dans le CSS');
  return problems;
}

/** Les règles locales d'une feuille d'écran, ou `null` si elle ne commence pas par la base du système. */
export function localPart(css: string): string | null {
  const base = css.startsWith(DESIGN_CSS) ? DESIGN_CSS : css.startsWith(PRINT_DESIGN_CSS) ? PRINT_DESIGN_CSS : null;
  if (base === null) return null;
  const rest = css.slice(base.length);
  // Les étiquettes du DPE (AU006) font partie du système : placées juste après la base, elles ne sont pas locales.
  return rest.startsWith(ETIQUETTES_CSS) ? rest.slice(ETIQUETTES_CSS.length) : rest;
}

/** Une feuille d'écran : la base du système, puis des règles locales sans couleur ni police à elles. */
export function screenCssProblems(css: string): string[] {
  const local = localPart(css);
  if (local === null) return ['la feuille ne commence pas par la base du système de design'];
  return localCssProblems(local);
}

/* ---------- Accessibilité ---------- */

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};
const hasAttr = (tag: string, name: string): boolean => new RegExp(`\\s${name}(?:\\s*=|[\\s>/])`, 'i').test(tag);
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, 'x').trim();

export interface HtmlAuditOptions {
  /** Une feuille à imprimer : pas de fenêtre d'appareil à régler. */
  print?: boolean;
}

/**
 * Le contrôle d'accessibilité d'une page, tel que le navigateur la reçoit : langue, titre, zoom permis, chaque champ
 * nommé, chaque bouton et lien avec un nom, chaque image avec un texte, des titres sans saut, des identifiants
 * uniques, aucun ordre de tabulation forcé, aucun style en ligne, et ses feuilles dans le système de design.
 */
export function htmlProblems(html: string, options: HtmlAuditOptions = {}): string[] {
  const problems: string[] = [];
  const page = html.replace(/<!--[\s\S]*?-->/g, '');
  const body = page.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  if (!/^<!doctype html>/i.test(page.trim())) problems.push('pas de « <!doctype html> »');
  if (!/<html\s[^>]*lang="fr"/i.test(page)) problems.push('langue de la page absente');
  const title = /<title>([\s\S]*?)<\/title>/i.exec(page);
  if (!title || !textOf(title[1]!)) problems.push('titre de la page absent');
  if (!/<meta\s+charset="utf-8"/i.test(page)) problems.push('jeu de caractères absent');
  if (!options.print) {
    const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/i.exec(page);
    if (!viewport) problems.push('fenêtre d’appareil absente');
    else if (/user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:\.0)?\b/i.test(viewport[1]!)) problems.push('le zoom est bloqué');
  }

  // Les champs : un nom par une étiquette, ou parce qu'ils sont dans leur étiquette.
  const labelled = new Set([...body.matchAll(/<label\b[^>]*>/gi)].map((m) => attr(m[0], 'for')).filter((v): v is string => !!v));
  const outsideLabels = body.replace(/<label\b[\s\S]*?<\/label>/gi, '');
  for (const m of outsideLabels.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = m[0];
    const type = (attr(tag, 'type') ?? '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;
    const id = attr(tag, 'id');
    if ((id && labelled.has(id)) || attr(tag, 'aria-label') || attr(tag, 'aria-labelledby')) continue;
    problems.push(`champ sans étiquette : ${tag}`);
  }
  for (const m of body.matchAll(/<label\b[^>]*>/gi)) {
    const target = attr(m[0], 'for');
    if (target && !new RegExp(`\\sid="${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(body)) problems.push(`étiquette sans champ : ${target}`);
  }

  // Boutons et liens : un nom. Un bouton rempli par le script porte un identifiant.
  for (const m of body.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    if (!textOf(m[2]!) && !attr(`<b ${m[1]}>`, 'aria-label')) problems.push(`bouton sans nom : ${m[0].slice(0, 80)}`);
  }
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!textOf(m[2]!) && !attr(`<a ${m[1]}>`, 'aria-label')) problems.push(`lien sans nom : ${m[0].slice(0, 80)}`);
  }
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    if (attr(m[0], 'alt') === null) problems.push(`image sans texte : ${m[0].slice(0, 80)}`);
  }

  // Les titres : un seul niveau à la fois en descendant ; un titre vide est rempli par le script (identifiant).
  let previous = 0;
  for (const m of body.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)) {
    const level = Number(m[1]);
    if (previous === 0 && level !== 1 && !/<h1\b/i.test(body)) problems.push(`premier titre de niveau ${level}, sans titre de niveau 1`);
    if (previous > 0 && level > previous + 1) problems.push(`titre qui saute un niveau : h${previous} puis h${level}`);
    if (!textOf(m[3]!) && !attr(`<h ${m[2]}>`, 'id')) problems.push(`titre vide : ${m[0].slice(0, 80)}`);
    previous = level;
  }

  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`identifiant en double : ${id}`);
  for (const m of body.matchAll(/\stabindex="(\d+)"/gi)) if (Number(m[1]) > 0) problems.push('ordre de tabulation forcé');
  if (/<[a-z][^>]*\sstyle\s*=/i.test(body)) problems.push('style en ligne, hors système de design');
  for (const m of page.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) problems.push(...screenCssProblems(m[1]!));
  if (hasAttr(page, 'autofocus')) problems.push('focus forcé à l’ouverture');
  return problems;
}

/* ---------- Une action qui domine, une hauteur bornée (DS087) ---------- */

/** Les classes qui rendent un bouton filaire ou texte : tout autre `<button>`, et tout lien `.appel`, est plein. */
const NOT_FILLED = /^(?:secondaire|second|retour|discret)$/;
const classesOf = (tag: string): string[] => (attr(tag, 'class') ?? '').split(/\s+/).filter(Boolean);
const isFilled = (tag: string): boolean => {
  const classes = classesOf(tag);
  if (/^<a\b/i.test(tag) && !classes.includes('appel')) return false;
  return !classes.some((c) => NOT_FILLED.test(c));
};

/** Les libellés des boutons pleins d’un morceau de page, dans l’ordre : un `<button>` ou un lien `.appel`, sans classe filaire. */
export function filledButtons(fragment: string): string[] {
  const out: string[] = [];
  for (const m of fragment.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const tag = `<${m[1]} ${m[2]}>`;
    if (isFilled(tag)) out.push(textOf(m[3]!) || attr(tag, 'aria-label') || attr(tag, 'id') || m[1]!.toLowerCase());
  }
  return out;
}

/** Les écrans de premier rang d'une application : chaque `<section>` enfant direct de `<main>`, avec son identifiant. */
export function appScreens(html: string): { id: string; html: string }[] {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(body)?.[1] ?? '';
  const out: { id: string; html: string }[] = [];
  const tags = /<(\/?)section\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  let open = '';
  for (const m of main.matchAll(tags)) {
    if (m[1] === '') {
      if (depth === 0) {
        start = m.index!;
        open = m[0];
      }
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push({ id: attr(open, 'id') ?? `section ${out.length + 1}`, html: main.slice(start, m.index! + m[0].length) });
        start = -1;
      }
    }
  }
  return out;
}

export interface FilledButtonOptions {
  /** `sections` : une application dont chaque `<section>` de premier rang est un écran ; sinon toute la page en est un. */
  screens?: 'page' | 'sections';
  /** Le plus de boutons pleins par écran : un seul, l'action principale. */
  max?: number;
}

/**
 * Un écran, une action principale (DS022, DS087) : au plus un bouton plein par écran ; les autres sont filaires
 * (`secondaire`), texte (`retour`, `discret`) ou de simples liens. Un bouton caché que le script montre compte aussi :
 * le jour où il s'affiche, il partage l'écran.
 */
export function filledButtonProblems(html: string, options: FilledButtonOptions = {}): string[] {
  const max = options.max ?? 1;
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const units = options.screens === 'sections' ? appScreens(html) : [{ id: 'page', html: body }];
  const problems: string[] = [];
  for (const u of units) {
    const filled = filledButtons(u.html);
    if (filled.length > max) problems.push(`${u.id} : ${filled.length} boutons pleins pour ${max} (${filled.join(' · ')})`);
  }
  return problems;
}

/** La hauteur d'un écran rendu, mesurée dans un navigateur sur le portefeuille chargé. */
export interface ScreenHeight {
  name: string;
  /** La hauteur du document, `document.documentElement.scrollHeight`, en pixels CSS. */
  heightPx: number;
  /** La hauteur de la fenêtre, en pixels CSS. */
  viewportPx: number;
}

/**
 * La hauteur bornée d'un écran : six fenêtres de téléphone au plus, quel que soit le portefeuille. L'accueil vide de
 * l'audit fait 5,4 écrans ; chargé de 1 000 clients et 400 biens, 288 (DS002). Au-delà de six, une liste n'est plus
 * bornée : elle doit montrer cinq lignes et « Tout voir ».
 */
export const HAUTEUR_MAX = Object.freeze({ ecrans: 6 });

/** Les écrans plus hauts que la borne, en nombre de fenêtres ; une mesure impossible est un problème, jamais un succès. */
export function screenHeightProblems(measures: readonly ScreenHeight[], maxScreens: number = HAUTEUR_MAX.ecrans): string[] {
  const problems: string[] = [];
  if (measures.length === 0) problems.push('aucune hauteur mesurée');
  for (const m of measures) {
    if (!(m.viewportPx > 0) || !(m.heightPx > 0) || !Number.isFinite(m.heightPx)) {
      problems.push(`${m.name} : hauteur illisible`);
      continue;
    }
    const screens = m.heightPx / m.viewportPx;
    if (screens > maxScreens) problems.push(`${m.name} : ${screens.toFixed(1).replace('.', ',')} écrans de haut pour ${maxScreens}`);
  }
  return problems;
}

/* ---------- Budget de performance ---------- */

export interface Screen {
  html: string;
  /** Les feuilles et scripts servis à côté, s'il y en a. */
  css?: string;
  js?: string;
}

export interface Budget {
  /** Le poids compressé de tout l'écran, en octets. */
  gzipBytes: number;
}

/** 14 Ko compressés : une page publique arrive au premier aller-retour. L'application de l'agent a sa coquille. */
export const BUDGETS = Object.freeze({
  page: Object.freeze({ gzipBytes: 14 * 1024 }),
  application: Object.freeze({ gzipBytes: 48 * 1024 }),
});

export const gzipSize = (text: string): number => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).length;

/**
 * Le budget d'un écran : son poids compressé, et rien qui vienne d'ailleurs (ni police, ni script, ni image, ni
 * feuille extérieure) qui ralentirait ou suivrait la personne.
 */
export function budgetProblems(screen: Screen, budget: Budget): string[] {
  const problems: string[] = [];
  const total = gzipSize(screen.html) + gzipSize(screen.css ?? '') + gzipSize(screen.js ?? '');
  if (total > budget.gzipBytes) problems.push(`trop lourd : ${total} octets compressés pour ${budget.gzipBytes}`);
  for (const m of screen.html.matchAll(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*\s(?:src|href)="([^"]*)"/gi)) {
    if (/^(?:[a-z]+:)?\/\//i.test(m[1]!)) problems.push(`ressource extérieure : ${m[1]}`);
  }
  for (const css of [screen.css ?? '', ...[...screen.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!)]) {
    if (/@import|@font-face|url\(\s*['"]?(?:https?:)?\/\//i.test(css)) problems.push('la feuille charge une ressource extérieure');
  }
  if (/<script\b(?![^>]*\s(?:defer|async|type="module"))[^>]*\ssrc=/i.test(screen.html)) problems.push('script qui bloque l’affichage');
  return problems;
}
