/**
 * Les pages de prix publiques (M01, AT02) [R150, R151, R07, R201].
 *
 * La page d'une commune, et celle de chacun de ses quartiers, rendues depuis une version des prix regroupés de AT01
 * (`PrixRegroupes.communePrices`) : seulement des cases montrables, chacune suivie de sa source et de sa date ; une case
 * retenue ne montre aucun chiffre, seulement sa raison. La méthode est expliquée, l'estimation en ligne proposée (E05),
 * et les données structurées décrivent le jeu de chiffres (jamais une vente).
 *
 * Tout est pur ici : la page ne lit que ce que la version lui donne, et revérifie qu'aucune case affichée n'est
 * retenue ni incomplète.
 */
import type { EstimatedKind } from '../estimation/fourchette.ts';
import { euros } from '../annonces/mentions.ts';
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import type { CommunePrices, HeldCell, PublicCell } from './prix-versions.ts';
import type { HoldReason } from './prix.ts';

export interface PricePageOptions {
  communeSlug: string;
  /** Le quartier montré, ou `null` pour la page de la commune. */
  quarterSlug?: string | null;
  /** L'adresse de l'estimation en ligne du site (E05). */
  estimateHref: string;
  /** L'adresse du site, pour la page de référence et les données structurées. */
  siteUrl: string;
}

export type PricePage = { ok: true; html: string } | { ok: false; code: 'zone_inconnue' | 'adresse_invalide' };

const KIND_LABEL: Record<EstimatedKind, string> = { apartment: 'Appartements', house: 'Maisons' };
const KIND_ONE: Record<EstimatedKind, string> = { apartment: 'Appartement', house: 'Maison' };
const HOLD_TEXT: Record<HoldReason, string> = {
  seuil: 'Pas assez de ventes pour publier un chiffre fiable.',
  difference: 'Chiffre retenu : publié, il laisserait retrouver une vente par différence avec un autre.',
  version: 'Chiffre retenu : publié, il laisserait retrouver une vente par différence avec la publication précédente.',
};
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SITE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;
const SAFE_HREF = /^(?:\/[^\s"'<>]*|https:\/\/[^\s"'<>]+)$/;

/** « 30 juin 2026 », depuis une date `AAAA-MM-JJ` (ou un instant ISO). */
export function frenchDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])}${Number(m[3]) === 1 ? 'er' : ''} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** « juillet 2024 », depuis une date `AAAA-MM…`. */
export function frenchMonth(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

const perM2 = (v: number): string => `${euros(v)}/m²`;

/** Une case montrable : publiée ou reprise, avec tous ses chiffres et sa source [R150, R151]. */
function showable(c: PublicCell): boolean {
  return (
    (c.status === 'publiee' || c.status === 'reprise') &&
    [c.sales, c.median, c.q1, c.q3].every((v) => Number.isFinite(v) && v > 0) &&
    c.q1 <= c.median &&
    c.median <= c.q3 &&
    typeof c.source === 'string' &&
    c.source.trim() !== '' &&
    /^\d{4}-\d{2}-\d{2}/.test(c.dvfLastSale) &&
    /^\d{4}-\d{2}/.test(c.period.from) &&
    /^\d{4}-\d{2}/.test(c.period.to)
  );
}

/** La phrase de source et de date, après chaque chiffre [R151]. */
export function sourceLine(c: PublicCell): string {
  const base = `Source : ${c.source}, ventes publiées jusqu’au ${frenchDate(c.dvfLastSale)}.`;
  return c.status === 'reprise' ? `${base} Chiffres de la publication précédente, gardés pour qu’aucune vente ne puisse être retrouvée.` : base;
}

const CSS =
  DESIGN_CSS +
  '.tete{display:flex;justify-content:space-between;align-items:center;gap:var(--e-4);padding:var(--e-4)}' +
  'main{max-width:48rem;margin:0 auto;padding:0 var(--e-4) var(--e-8)}' +
  '.intro{margin:var(--e-6) 0 var(--e-5)}.intro h1{font-size:clamp(2rem,8vw,2.9rem);line-height:1.05;letter-spacing:-.02em}' +
  '.fil{margin:0 0 var(--e-2);font-size:var(--t-s)}' +
  '.metier{margin:0 0 var(--e-2);font-weight:700;color:var(--accent);letter-spacing:.08em;text-transform:uppercase;font-size:var(--t-xs)}' +
  '.cases{display:grid;gap:var(--e-4);grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))}' +
  '.case{margin:0;padding:var(--e-5) var(--e-4);background:var(--surface);border-radius:var(--r-l);box-shadow:inset 0 4px 0 var(--accent)}' +
  '.case h3{margin:0 0 var(--e-2)}.case .grand{display:block;font:600 clamp(2rem,9vw,2.6rem)/1.05 var(--police-titre);color:var(--accent);margin:0 0 var(--e-2)}' +
  '.case .ecart{margin:0 0 var(--e-2);font-weight:600}.case .source{margin:var(--e-3) 0 0;font-size:var(--t-xs);color:var(--doux)}' +
  '.case.retenue{box-shadow:inset 0 4px 0 var(--trait)}' +
  '.quartiers{width:100%;border-collapse:collapse;margin:var(--e-3) 0 0}.quartiers th,.quartiers td{text-align:left;padding:var(--e-3) var(--e-2);border-top:1px solid var(--trait);vertical-align:top}' +
  '.quartiers td+td,.quartiers th+th{text-align:right}.quartiers .doux{font-size:var(--t-xs)}' +
  '.methode{margin:var(--e-6) 0 0;padding:var(--e-4);border-radius:var(--r-m);box-shadow:inset 4px 0 0 var(--moutarde);background:var(--surface)}' +
  '.estimer{margin:var(--e-6) 0 0}';

function cellBlock(kind: EstimatedKind, cell: PublicCell | undefined, held: HeldCell | undefined): string {
  if (cell && showable(cell)) {
    return (
      `<section class="case" aria-labelledby="k-${kind}"><h3 id="k-${kind}">${KIND_LABEL[kind]}</h3>` +
      `<span class="grand chiffres">${escapeHtml(perM2(cell.median))}</span>` +
      `<p class="ecart chiffres">La moitié des ventes entre ${escapeHtml(perM2(cell.q1))} et ${escapeHtml(perM2(cell.q3))}</p>` +
      `<p class="doux">Prix médian au mètre carré, sur ${cell.sales} ventes, de ${escapeHtml(frenchMonth(cell.period.from))} à ${escapeHtml(frenchMonth(cell.period.to))}.</p>` +
      `<p class="source">${escapeHtml(sourceLine(cell))}</p></section>`
    );
  }
  const reason = held ? HOLD_TEXT[held.reason] : HOLD_TEXT.seuil;
  return `<section class="case retenue" aria-labelledby="k-${kind}"><h3 id="k-${kind}">${KIND_LABEL[kind]}</h3><p>${escapeHtml(reason)}</p></section>`;
}

/** La case d'un quartier dans le tableau de la commune : la médiane suivie de sa source, ou la raison. */
function quarterCell(cell: PublicCell | undefined, held: HeldCell | undefined): string {
  if (cell && showable(cell)) return `<td><span class="chiffres">${escapeHtml(perM2(cell.median))}</span><br><span class="doux">${cell.sales} ventes · ${escapeHtml(cell.source)}, ${escapeHtml(frenchDate(cell.dvfLastSale))}</span></td>`;
  return `<td><span class="doux">${escapeHtml(held ? (held.reason === 'seuil' ? 'Pas assez de ventes' : 'Chiffre retenu') : 'Pas assez de ventes')}</span></td>`;
}

/** Les données structurées : un jeu de chiffres regroupés, jamais une vente ; `<` échappé pour rester dans la balise. */
function structuredData(name: string, url: string, cells: readonly PublicCell[]): string {
  const shown = cells.filter(showable);
  const sources = [...new Set(shown.map((c) => c.source))];
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `Prix de l’immobilier à ${name}`,
    description: `Prix médians au mètre carré des appartements et des maisons à ${name}, calculés sur les ventes publiques, en chiffres regroupés.`,
    url,
    isAccessibleForFree: true,
    spatialCoverage: { '@type': 'Place', name },
    ...(shown.length > 0
      ? {
          temporalCoverage: `${shown.map((c) => c.period.from.slice(0, 7)).sort()[0]}/${shown.map((c) => c.period.to.slice(0, 7)).sort().at(-1)}`,
          isBasedOn: sources,
          dateModified: shown.map((c) => c.dvfLastSale.slice(0, 10)).sort().at(-1),
          variableMeasured: shown.map((c) => ({ '@type': 'PropertyValue', name: `${KIND_ONE[c.kind]}, prix médian au m²`, value: c.median, unitText: 'EUR/m²' })),
        }
      : {}),
  };
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/** La page de prix d'une commune, ou d'un de ses quartiers. */
export function renderPricePage(prices: CommunePrices, options: PricePageOptions): PricePage {
  if (!SLUG.test(options.communeSlug) || (options.quarterSlug != null && !SLUG.test(options.quarterSlug))) return { ok: false, code: 'zone_inconnue' };
  if (!SITE.test(options.siteUrl) || !SAFE_HREF.test(options.estimateHref)) return { ok: false, code: 'adresse_invalide' };
  // Une commune et l'un de ses quartiers peuvent porter le même nom court : chaque zone se reconnaît à son niveau aussi.
  type Level = 'commune' | 'quartier';
  const key = (level: Level, slug: string) => `${level}:${slug}`;
  const zones = new Map<string, { slug: string; name: string; level: Level }>();
  for (const c of [...prices.cells, ...prices.held]) zones.set(key(c.zone.level, c.zone.slug), { slug: c.zone.slug, name: c.zone.name, level: c.zone.level });
  const commune = zones.get(key('commune', options.communeSlug));
  if (!commune) return { ok: false, code: 'zone_inconnue' };
  const targetLevel: Level = options.quarterSlug != null ? 'quartier' : 'commune';
  const targetSlug = options.quarterSlug ?? options.communeSlug;
  const target = zones.get(key(targetLevel, targetSlug));
  if (!target) return { ok: false, code: 'zone_inconnue' };
  const cellOf = (level: Level, slug: string, kind: EstimatedKind) => prices.cells.find((c) => c.zone.level === level && c.zone.slug === slug && c.kind === kind);
  const heldOf = (level: Level, slug: string, kind: EstimatedKind) => prices.held.find((c) => c.zone.level === level && c.zone.slug === slug && c.kind === kind);
  const kinds: EstimatedKind[] = ['apartment', 'house'];

  const isQuarter = options.quarterSlug != null;
  const path = isQuarter ? `/prix/${options.communeSlug}/${options.quarterSlug}` : `/prix/${options.communeSlug}`;
  const url = `${options.siteUrl}${path}`;
  const place = isQuarter ? `${target.name}, ${commune.name}` : commune.name;
  const title = `Prix de l’immobilier à ${place}`;
  const blocks = kinds.map((k) => cellBlock(k, cellOf(targetLevel, targetSlug, k), heldOf(targetLevel, targetSlug, k))).join('');

  const quarters = [...zones.values()].filter((z) => z.level === 'quartier').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const quarterTable =
    !isQuarter && quarters.length > 0
      ? `<h2>Par quartier</h2><table class="quartiers"><caption class="visuellement-cache">Prix médian au mètre carré par quartier de ${escapeHtml(commune.name)}</caption><thead><tr><th scope="col">Quartier</th><th scope="col">Appartements</th><th scope="col">Maisons</th></tr></thead><tbody>` +
        quarters
          .map((z) => `<tr><th scope="row"><a href="/prix/${options.communeSlug}/${z.slug}">${escapeHtml(z.name)}</a></th>${kinds.map((k) => quarterCell(cellOf('quartier', z.slug, k), heldOf('quartier', z.slug, k))).join('')}</tr>`)
          .join('') +
        '</tbody></table>'
      : '';
  const crumbs = isQuarter ? `<p class="fil"><a href="/prix/${options.communeSlug}">Prix à ${escapeHtml(commune.name)}</a></p>` : '';
  const shownForData = prices.cells.filter((c) => c.zone.level === targetLevel && c.zone.slug === targetSlug);

  const html =
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}">` +
    `<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(`Prix médian au mètre carré des appartements et des maisons à ${place}, sur les ventes réelles, avec leur source et leur date.`)}"><style>${CSS}</style>` +
    `<script type="application/ld+json">${structuredData(place, url, shownForData)}</script></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p></header><div class="frise" aria-hidden="true"></div><main>` +
    `<section class="intro" aria-labelledby="titre">${crumbs}<p class="metier">Ventes réelles · votre agent immobilier</p><h1 id="titre">${escapeHtml(title)}</h1>` +
    `<p>Ce que les logements se sont vraiment vendus, au mètre carré : la moitié des ventes au-dessous du prix médian, la moitié au-dessus.</p></section>` +
    `<h2>Prix au mètre carré</h2><div class="cases">${blocks}</div>` +
    quarterTable +
    `<section class="methode" aria-labelledby="t-methode"><h2 id="t-methode">Comment ces prix sont calculés</h2>` +
    `<p>À partir des ventes publiées par l’État (demandes de valeurs foncières), recalculés à chaque nouvelle publication. Pour chaque zone et chaque type de logement : le prix médian au mètre carré, et l’écart où se trouve la moitié des ventes.</p>` +
    `<p>Un chiffre n’est publié que s’il regroupe assez de ventes, et jamais s’il laisserait retrouver une vente, par différence avec un autre chiffre ou avec la publication précédente. Aucune adresse, aucune date ni aucun prix de vente isolé n’est montré.</p></section>` +
    `<section class="estimer" aria-labelledby="t-estimer"><h2 id="t-estimer">Et votre logement ?</h2><p>Chaque bien est différent : étage, état, vue, extérieur. L’estimation en ligne vous donne une fourchette, et un agent immobilier peut venir voir le vôtre. C’est offert.</p>` +
    `<a class="appel" href="${escapeHtml(options.estimateHref)}">Estimer mon logement</a></section>` +
    `</main></body></html>`;
  return { ok: true, html };
}
