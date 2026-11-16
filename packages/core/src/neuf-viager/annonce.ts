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
 *
 * Jamais vu (RC64) : l'annonce est relue mot pour mot contre la grille du jour. Chaque lot écrit garde sa ligne sans sa
 * date de confirmation (`line`), l'annonce garde son en-tête (`heading` : nom, code postal, ville, promoteur et barèmes
 * cités) : une surface, une typologie, un étage, des frais ou un nom qui ne sont plus ceux de la grille la font retirer.
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

/** Chaque lot que l'annonce annonce, écrit sur sa ligne ou seulement compté, pour la relire contre la grille du jour. */
export interface ListedLot {
  lotRef: string;
  priceCents: number;
  confirmedOn: string;
  /** Faux pour un lot compté dans « et N autres lots » sans ligne à lui : il est annoncé disponible tout de même. */
  written: boolean;
  /** La ligne écrite du lot, sans sa date de confirmation, pour la relire contre la grille du jour ; `null` pour un lot compté. */
  line: string | null;
}

export interface NewBuildListing {
  programId: string;
  title: string;
  body: string;
  /** Le jour de la grille lue. */
  day: string;
  /** Le dernier jour où chaque lot annoncé, écrit ou compté, est encore confirmé : le lendemain, l'annonce ne tient plus [R543]. */
  validUntil: string;
  lots: ListedLot[];
  /** Tous les lots annoncés, du moins cher au plus cher : ceux qui ne tiennent pas dans les 4000 signes sont comptés, jamais coupés. */
  omitted: number;
  /** Ce que le texte dit du programme hors des lots : nom, code postal, ville, promoteur et barèmes cités, pour le relire. */
  heading: string;
}

const byPrice = (a: PublishedLot, b: PublishedLot): number => a.priceCents - b.priceCents || (a.lotRef < b.lotRef ? -1 : a.lotRef > b.lotRef ? 1 : 0);

/** La ligne d'un lot sans sa date de confirmation : ce qu'une reconfirmation seule ne change pas. */
function lotDetails(l: PublishedLot): string {
  const head = `• Lot ${listingPlainText(l.lotRef)} · ${TYPOLOGY[l.typology]}, ${areaOf(l.livingAreaHundredths)}, ${floorOf(l.floor).toLowerCase()} · ${eurosOf(l.priceCents)}`;
  // Chaque frais est celui calculé par le code depuis le barème rangé ; sans barème, aucun chiffre [R544].
  const fees = l.fees
    ? ` · frais d’acquisition ${eurosOf(l.fees.newFees.value)}, contre ${eurosOf(l.fees.oldFees.value)} dans l’ancien au même prix, soit ${eurosOf(l.fees.saving.value)} d’économie`
    : ' · frais non calculés, barème absent';
  return `${head}${fees}`;
}

function lotLine(l: PublishedLot): string {
  return `${lotDetails(l)} · confirmé le ${dayOf(l.confirmedOn)}`;
}

/** L'en-tête relu : le programme tel que le texte le nomme, et les barèmes cités pour les lots écrits [R544]. */
function headingOf(grid: Pick<PublishedGrid, 'name' | 'postalCode' | 'city' | 'promoter'>, written: readonly PublishedLot[]): string {
  return [grid.name, grid.postalCode, grid.city, grid.promoter].map(listingPlainText).join(' · ') + '\n' + sourcesText(written);
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
  // Un lot compté sans ligne est annoncé disponible lui aussi : sa confirmation borne l'annonce comme les autres [R543].
  const validUntil = addDays(sorted.map((l) => l.confirmedOn).sort()[0]!, LOT_CONFIRMATION_DAYS);
  return {
    ok: true,
    value: {
      programId: grid.programId,
      title,
      body,
      day: grid.day,
      validUntil,
      lots: sorted.map((l, i) => ({ lotRef: l.lotRef, priceCents: l.priceCents, confirmedOn: l.confirmedOn, written: i < kept.length, line: i < kept.length ? lotDetails(l) : null })),
      omitted: sorted.length - kept.length,
      heading: headingOf(grid, kept),
    },
  };
}

export interface ListingCheck {
  /** Vrai seulement quand chaque lot annoncé, écrit ou compté, est encore publié, au même prix, et que l'annonce n'a pas passé son jour. */
  holds: boolean;
  /** Les lots annoncés qui ne sont plus dans la grille publiée : vendus, réservés, sous option ou à reconfirmer. */
  gone: string[];
  /** Les lots annoncés dont le prix a changé depuis (un lot compté aussi : il peut devenir le prix « dès » du titre). */
  priceChanged: string[];
  /** Vrai quand le jour de la grille dépasse `validUntil`. */
  expired: boolean;
  /** Vrai quand la grille du jour n'est pas celle du même programme. */
  otherProgram: boolean;
  /**
   * Les lots écrits, encore publiés au même prix, dont la ligne ne tient plus : surface, typologie, étage ou frais changés
   * (RC64). Une reconfirmation seule n'y met jamais un lot.
   */
  detailsChanged: string[];
  /** Vrai quand le nom, le code postal, la ville, le promoteur ou un barème cité ne sont plus ceux de la grille du jour (RC64). */
  headingChanged: boolean;
}

/**
 * L'annonce tient-elle encore face à la grille publiée du jour ? Dit lot par lot ce qui ne tient plus [R543, R10].
 * Un lot de plus dans la grille ne rend pas l'annonce fausse : il n'y est simplement pas encore.
 */
export function listingStillHolds(listing: Pick<NewBuildListing, 'programId' | 'validUntil' | 'lots' | 'heading'>, today: PublishedGrid): ListingCheck {
  const otherProgram = listing.programId !== today.programId;
  const now = new Map(today.lots.map((l) => [l.lotRef, l] as const));
  const gone: string[] = [];
  const priceChanged: string[] = [];
  const detailsChanged: string[] = [];
  const written: PublishedLot[] = [];
  for (const l of listing.lots) {
    const cur = otherProgram ? undefined : now.get(l.lotRef);
    if (!cur) gone.push(l.lotRef);
    else if (cur.priceCents !== l.priceCents) priceChanged.push(l.lotRef);
    // Un lot écrit se relit mot pour mot ; une ligne absente ou abîmée ne tient jamais [R10].
    else if (l.written && (typeof l.line !== 'string' || l.line !== lotDetails(cur))) detailsChanged.push(l.lotRef);
    if (cur && l.written) written.push(cur);
  }
  // Le programme se relit toujours ; les barèmes cités, seulement quand chaque lot écrit est encore publié : un lot parti
  // emporte ses barèmes, et il est déjà dit dans `gone`.
  const headingChanged =
    !otherProgram &&
    (typeof listing.heading !== 'string' ||
      (() => {
        const [who, ...src] = listing.heading.split('\n');
        const [nowWho, ...nowSrc] = headingOf(today, [...written].sort(byPrice)).split('\n');
        const allWritten = written.length === listing.lots.filter((l) => l.written).length;
        return who !== nowWho || (allWritten && src.join('\n') !== nowSrc.join('\n'));
      })());
  const expired = !DAY.test(today.day) || today.day > listing.validUntil;
  return {
    holds: !otherProgram && !expired && gone.length === 0 && priceChanged.length === 0 && detailsChanged.length === 0 && !headingChanged,
    gone,
    priceChanged,
    expired,
    otherProgram,
    detailsChanged,
    headingChanged,
  };
}
