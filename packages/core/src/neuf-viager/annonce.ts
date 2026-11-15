/**
 * La grille d'un programme neuf écrite pour les annonces des portails (RC56) [R543, R544, R10].
 *
 * Le texte vient de la seule grille publiée (`ProgrammesNeufs.publishedGrid`) : les lots disponibles confirmés depuis 14
 * jours au plus, sans aucune donnée personnelle. Texte brut, sans HTML : 160 signes au plus pour le titre, 4000 pour le
 * corps, comme les autres textes des portails. Un lot n'est jamais coupé : ceux qui ne tiennent pas sont comptés.
 *
 * Jamais vu : l'annonce dit jusqu'à quel jour elle tient (`validUntil`, la plus ancienne confirmation plus 14 jours), et
 * `listingStillHolds` dit, lot par lot, ce qui ne tient plus face à la grille du jour (lot vendu ou retiré, prix changé,
 * confirmation passée). Une annonce qui ne tient plus est à retirer.
 */
import { LOT_CONFIRMATION_DAYS, type LotTypology, type NeufOutcome, type PublishedGrid, type PublishedLot } from './neuf.ts';
import { areaOf, dayOf, eurosOf, floorOf, sourceText } from './page-publique.ts';

export const LISTING_MAX_TITLE = 160;
export const LISTING_MAX_BODY = 4000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TYPOLOGY: Record<LotTypology, string> = { studio: 'Studio', t1: 'T1', t2: 'T2', t3: 'T3', t4: 'T4', t5: 'T5', t6: 'T6', maison: 'Maison', local: 'Local' };

/**
 * Un texte venu de la base, rendu sur une ligne et sans balise : un retour à la ligne ne fabrique jamais une ligne de
 * l'annonce, et un `<` ou un `>` ne devient jamais une balise chez un portail qui lirait du HTML.
 */
export function listingPlainText(t: string): string {
  return t
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ce que l'annonce a écrit de chaque lot, pour la relire contre la grille du jour. */
export interface ListedLot {
  lotRef: string;
  priceCents: number;
  confirmedOn: string;
}

export interface NewBuildListing {
  programId: string;
  title: string;
  body: string;
  /** Le jour de la grille lue. */
  day: string;
  /** Le dernier jour où chaque lot écrit est encore confirmé : le lendemain, l'annonce ne tient plus [R543]. */
  validUntil: string;
  lots: ListedLot[];
  /** Les lots publiés qui ne tiennent pas dans les 4000 signes : comptés dans le texte, jamais coupés. */
  omitted: number;
}

const byPrice = (a: PublishedLot, b: PublishedLot): number => a.priceCents - b.priceCents || (a.lotRef < b.lotRef ? -1 : a.lotRef > b.lotRef ? 1 : 0);

function lotLine(l: PublishedLot): string {
  const head = `• Lot ${listingPlainText(l.lotRef)} · ${TYPOLOGY[l.typology]}, ${areaOf(l.livingAreaHundredths)}, ${floorOf(l.floor).toLowerCase()} · ${eurosOf(l.priceCents)}`;
  // Chaque frais est celui calculé par le code depuis le barème rangé ; sans barème, aucun chiffre [R544].
  const fees = l.fees
    ? ` · frais d’acquisition ${eurosOf(l.fees.newFees.value)}, contre ${eurosOf(l.fees.oldFees.value)} dans l’ancien au même prix, soit ${eurosOf(l.fees.saving.value)} d’économie`
    : ' · frais non calculés, barème absent';
  return `${head}${fees} · confirmé le ${dayOf(l.confirmedOn)}`;
}

/** Les barèmes et leurs hypothèses, cités une seule fois chacun sous les lots [R544]. */
function sourcesText(lots: readonly PublishedLot[]): string {
  const seen = new Map<string, string>();
  for (const l of lots) {
    if (!l.fees) continue;
    for (const [label, f] of [['du neuf', l.fees.newFees], ['de l’ancien', l.fees.oldFees]] as const) {
      const key = `${label}|${f.source}|${f.asOf}|${f.hypothesis}`;
      if (!seen.has(key)) seen.set(key, `Barème ${label} : ${listingPlainText(sourceText(f.source))}, en vigueur depuis le ${dayOf(f.asOf)} (${listingPlainText(f.hypothesis)}).`);
    }
  }
  if (seen.size === 0) return '';
  return `D’où viennent les frais : ${[...seen.values()].join(' ')}`;
}

/**
 * Le titre et le texte brut de l'annonce d'un programme neuf, depuis sa grille publiée. Refusé en mots, sans aucun
 * texte, quand la grille n'a aucun lot, qu'un lot n'est pas confirmé depuis 14 jours au plus, ou que le nom du
 * programme ne tient pas dans le titre (un nom n'est jamais coupé).
 */
export function newBuildListing(grid: PublishedGrid): NeufOutcome<NewBuildListing> {
  if (!DAY.test(grid.day)) return { ok: false, rule: null, code: 'day_invalid' };
  if (grid.lots.length === 0) return { ok: false, rule: 'R543', code: 'no_lot_published' };
  const oldest = addDays(grid.day, -LOT_CONFIRMATION_DAYS);
  // La grille publiée filtre déjà ; une grille venue d'ailleurs est relue : aucun lot hors confirmation n'est écrit.
  for (const l of grid.lots) {
    if (!DAY.test(l.confirmedOn) || l.confirmedOn < oldest || l.confirmedOn > grid.day) return { ok: false, rule: 'R543', code: 'lot_not_confirmed' };
    if (!Number.isInteger(l.priceCents) || l.priceCents <= 0) return { ok: false, rule: null, code: 'price_invalid' };
  }
  const refs = new Set(grid.lots.map((l) => l.lotRef));
  if (refs.size !== grid.lots.length) return { ok: false, rule: 'R543', code: 'lot_listed_twice' };

  const name = listingPlainText(grid.name);
  const city = listingPlainText(grid.city);
  const sorted = [...grid.lots].sort(byPrice);
  const from = eurosOf(sorted[0]!.priceCents);
  const count = sorted.length === 1 ? '1 lot' : `${sorted.length} lots`;
  const title = `${name}, programme neuf à ${city} : ${count} dès ${from}`;
  if (name.length === 0 || city.length === 0) return { ok: false, rule: null, code: 'name_missing' };
  if (title.length > LISTING_MAX_TITLE) return { ok: false, rule: null, code: 'name_too_long' };

  const intro =
    `Programme neuf ${name}, ${listingPlainText(grid.postalCode)} ${city}, promoteur ${listingPlainText(grid.promoter)}. ` +
    `Lots disponibles et confirmés par le promoteur depuis 14 jours au plus, grille lue le ${dayOf(grid.day)} :`;
  const sources = sourcesText(sorted);
  const noScale = sorted.every((l) => !l.fees) ? 'Les frais ne sont pas calculés : le barème n’est pas encore rangé.' : '';
  const notice = 'Prix et disponibilités donnés par le promoteur, sous réserve de la vente des lots. Les frais sont une estimation, pas une offre.';
  const rest = (n: number) => (n === 0 ? '' : n === 1 ? 'Et 1 autre lot disponible, à demander à l’agent du programme.' : `Et ${n} autres lots disponibles, à demander à l’agent du programme.`);
  const compose = (lines: string[], omitted: number, src: string) => [intro, ...lines, rest(omitted), noScale, src, notice].filter((p) => p !== '').join('\n');

  // Les lots du moins cher au plus cher, tant qu'ils tiennent entiers ; ceux qui suivent sont comptés.
  const lines: string[] = [];
  const kept: PublishedLot[] = [];
  for (const l of sorted) {
    const next = [...lines, lotLine(l)];
    const nextKept = [...kept, l];
    if (compose(next, sorted.length - nextKept.length, sourcesText(nextKept)).length > LISTING_MAX_BODY) break;
    lines.push(lotLine(l));
    kept.push(l);
  }
  if (kept.length === 0) return { ok: false, rule: null, code: 'too_long' };
  const body = compose(lines, sorted.length - kept.length, kept.length === sorted.length ? sources : sourcesText(kept));
  const validUntil = addDays(kept.map((l) => l.confirmedOn).sort()[0]!, LOT_CONFIRMATION_DAYS);
  return {
    ok: true,
    value: {
      programId: grid.programId,
      title,
      body,
      day: grid.day,
      validUntil,
      lots: kept.map((l) => ({ lotRef: l.lotRef, priceCents: l.priceCents, confirmedOn: l.confirmedOn })),
      omitted: sorted.length - kept.length,
    },
  };
}

export interface ListingCheck {
  /** Vrai seulement quand chaque lot écrit est encore publié, au même prix, et que l'annonce n'a pas passé son jour. */
  holds: boolean;
  /** Les lots écrits qui ne sont plus dans la grille publiée : vendus, réservés, sous option ou à reconfirmer. */
  gone: string[];
  /** Les lots écrits dont le prix a changé depuis. */
  priceChanged: string[];
  /** Vrai quand le jour de la grille dépasse `validUntil`. */
  expired: boolean;
  /** Vrai quand la grille du jour n'est pas celle du même programme. */
  otherProgram: boolean;
}

/**
 * L'annonce tient-elle encore face à la grille publiée du jour ? Dit lot par lot ce qui ne tient plus [R543, R10].
 * Un lot de plus dans la grille ne rend pas l'annonce fausse : il n'y est simplement pas encore.
 */
export function listingStillHolds(listing: Pick<NewBuildListing, 'programId' | 'validUntil' | 'lots'>, today: PublishedGrid): ListingCheck {
  const otherProgram = listing.programId !== today.programId;
  const now = new Map(today.lots.map((l) => [l.lotRef, l] as const));
  const gone: string[] = [];
  const priceChanged: string[] = [];
  for (const l of listing.lots) {
    const cur = otherProgram ? undefined : now.get(l.lotRef);
    if (!cur) gone.push(l.lotRef);
    else if (cur.priceCents !== l.priceCents) priceChanged.push(l.lotRef);
  }
  const expired = !DAY.test(today.day) || today.day > listing.validUntil;
  return { holds: !otherProgram && !expired && gone.length === 0 && priceChanged.length === 0, gone, priceChanged, expired, otherProgram };
}
