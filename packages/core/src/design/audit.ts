/**
 * Le contrôle automatique des écrans (Z03) [R201] : contraste des couleurs du système, accessibilité de chaque page,
 * appartenance au système de design et budget de performance. Sans dépendance : des règles écrites, lues dans le
 * HTML et le CSS tels que le navigateur les reçoit. Chaque fonction rend la liste des problèmes, vide si tout va.
 */
import { gzipSync } from 'node:zlib';
import { DESIGN_CSS, PRINT_DESIGN_CSS } from './systeme.ts';

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

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const COLOR_WORD = /:\s*[^;{}]*\b(?:white|black|red|blue|green|gr[ae]y|yellow|orange|purple|pink|brown|navy|silver|maroon|teal|olive|aqua|fuchsia|lime)\b/i;
const FAMILY_NAME = /\b(?:serif|sans-serif|monospace|system-ui|cursive|fantasy|Georgia|Arial|Helvetica|Charter|Roboto|Inter|Times)\b|"[^"]+"|'[^']+'/;

/**
 * Les règles propres à un écran, ajoutées après la base du système : elles ne posent ni couleur ni police à elles,
 * ne chargent rien et ne forcent rien. Seuls les jetons (`var(--…)`) et les mots `inherit`, `transparent`,
 * `currentColor` sont permis.
 */
export function localCssProblems(css: string): string[] {
  const problems: string[] = [];
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const color = COLOR_LITERAL.exec(declarations);
  if (color) problems.push(`couleur hors système : ${color[0]}`);
  const word = COLOR_WORD.exec(declarations);
  if (word) problems.push(`couleur nommée hors système : ${word[0].trim()}`);
  for (const m of declarations.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    if (!/^\s*(?:var\(--police-[a-z]+\)|inherit)\s*$/.test(m[1]!)) problems.push(`police hors système : ${m[1]!.trim()}`);
  }
  for (const m of declarations.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]+)/gi)) {
    const value = m[1]!.replace(/var\(--[a-z-]+\)/g, '');
    if (!/var\(--police-[a-z]+\)|^\s*inherit\s*$/.test(m[1]!) || FAMILY_NAME.test(value)) problems.push(`police hors système : ${m[1]!.trim()}`);
  }
  if (/!important/.test(declarations)) problems.push('« !important » hors système');
  if (/@import|@font-face/i.test(declarations)) problems.push('chargement hors système (@import ou @font-face)');
  if (/url\(\s*['"]?(?:https?:)?\/\//i.test(declarations)) problems.push('ressource extérieure dans le CSS');
  if (/(?:^|[;{\s])(?:transition|animation)\s*:/i.test(declarations)) problems.push('mouvement hors système : seuls ceux de la base respectent « réduire les animations »');
  return problems;
}

/** Les règles locales d'une feuille d'écran, ou `null` si elle ne commence pas par la base du système. */
export function localPart(css: string): string | null {
  if (css.startsWith(DESIGN_CSS)) return css.slice(DESIGN_CSS.length);
  if (css.startsWith(PRINT_DESIGN_CSS)) return css.slice(PRINT_DESIGN_CSS.length);
  return null;
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
  for (const m of page.matchAll(/<style>([\s\S]*?)<\/style>/gi)) problems.push(...screenCssProblems(m[1]!));
  if (hasAttr(page, 'autofocus')) problems.push('focus forcé à l’ouverture');
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
  application: Object.freeze({ gzipBytes: 70 * 1024 }),
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
  for (const css of [screen.css ?? '', ...[...screen.html.matchAll(/<style>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!)]) {
    if (/@import|@font-face|url\(\s*['"]?(?:https?:)?\/\//i.test(css)) problems.push('la feuille charge une ressource extérieure');
  }
  if (/<script\b(?![^>]*\s(?:defer|async|type="module"))[^>]*\ssrc=/i.test(screen.html)) problems.push('script qui bloque l’affichage');
  return problems;
}
