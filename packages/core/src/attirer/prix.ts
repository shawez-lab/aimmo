/**
 * Les cases de prix publiques de M01 (AT01) : prix au mètre carré par commune et par quartier, appartement et maison,
 * calculés par le code à partir des ventes publiques DVF, et publiés seulement en chiffres regroupés [R150, R29].
 *
 * Une case publiée :
 * - porte au moins `minSales` ventes (5 par défaut, réglage) ;
 * - ne porte ni adresse, ni numéro de voie, ni date, ni prix d'une vente isolée : seulement le nombre de ventes, la
 *   médiane et les quartiles arrondis, et la période commune à toute la version ;
 * - **Jamais vu** : ne laisse retrouver aucune vente par différence. Dans une même version, la commune moins
 *   n'importe quel groupe de ses quartiers publiés ne laisse jamais un reste de 1 à `minSales - 1` ventes ; entre deux
 *   versions qui se suivent, deux cases dont l'une contient l'autre ne diffèrent jamais de 1 à `minSales - 1` ventes.
 *   Une case qui le permettrait est retenue (quartier) ou la commune garde les chiffres de la version précédente
 *   (reprise), et la raison est dite.
 *
 * Tout est pur ici : la base et la source des ventes sont dans `prix-versions.ts`.
 */
import type { EstimatedKind } from '../estimation/fourchette.ts';

export const PRICE_KINDS: readonly EstimatedKind[] = Object.freeze(['apartment', 'house'] as const);

export interface PriceSettings {
  /** Nombre de ventes au moins dans une case publiée, et taille au moins d'un reste par différence [R150]. */
  minSales: number;
  /** Nombre de mois de ventes d'une version, jusqu'au mois de la dernière vente publiée. */
  windowMonths: number;
  /** Arrondi des prix publiés, en euros. */
  roundTo: number;
}

export const DEFAULT_PRICE_SETTINGS: Readonly<PriceSettings> = Object.freeze({ minSales: 5, windowMonths: 24, roundTo: 10 });

/** Un point `[latitude, longitude]`. */
export type LatLon = readonly [number, number];

/** Une vente placée dans une case : son empreinte (stable d'une publication DVF à l'autre) et son prix au m². */
export interface CellSale {
  fingerprint: string;
  pricePerM2: number;
}

export interface CellFigures {
  sales: number;
  median: number;
  q1: number;
  q3: number;
}

/** Pourquoi une case n'est pas publiée avec les chiffres de cette version. */
export type HoldReason = 'seuil' | 'difference' | 'version';

/**
 * - `publiee` : chiffres de cette version ;
 * - `reprise` : chiffres de la version précédente, gardés parce que les nouveaux laisseraient retrouver une vente ;
 * - `retenue` : rien n'est publié.
 */
export type CellStatus = 'publiee' | 'reprise' | 'retenue';

/** Une multiensemble d'empreintes : empreinte → nombre de ventes identiques. */
export type SaleSet = ReadonlyMap<string, number>;

export function saleSet(sales: readonly CellSale[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sales) m.set(s.fingerprint, (m.get(s.fingerprint) ?? 0) + 1);
  return m;
}

export function setSize(s: SaleSet): number {
  let n = 0;
  for (const v of s.values()) n += v;
  return n;
}

/** Les ventes de `a` absentes de `b`, en comptant les doublons. */
export function minus(a: SaleSet, b: SaleSet): number {
  let n = 0;
  for (const [k, v] of a) n += Math.max(0, v - (b.get(k) ?? 0));
  return n;
}

/** Vrai si un reste de cette taille laisserait voir de 1 à `minSales - 1` ventes. */
export function revealing(rest: number, minSales: number): boolean {
  return rest >= 1 && rest < minSales;
}

/** Arrondi à `step` euros près, le demi vers le haut. */
export function roundPrice(value: number, step: number): number {
  return Math.floor(value / step + 0.5) * step;
}

/** Médiane d'une liste triée. */
function medianOfSorted(v: readonly number[]): number {
  const n = v.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * Médiane et quartiles : le premier quartile est la médiane de la moitié basse, le troisième celle de la moitié haute,
 * la valeur du milieu laissée de côté quand le nombre est impair. Arrondis à `roundTo` euros.
 */
export function figuresOf(prices: readonly number[], roundTo: number): CellFigures {
  if (prices.length === 0) throw new Error('figuresOf : aucune vente');
  const v = [...prices].sort((a, b) => a - b);
  const half = Math.floor(v.length / 2);
  const low = v.slice(0, half);
  const high = v.slice(v.length - half);
  const q1 = low.length > 0 ? medianOfSorted(low) : v[0]!;
  const q3 = high.length > 0 ? medianOfSorted(high) : v[0]!;
  return { sales: v.length, median: roundPrice(medianOfSorted(v), roundTo), q1: roundPrice(q1, roundTo), q3: roundPrice(q3, roundTo) };
}

/** Vrai si le point est dans le polygone (contour fermé ou non), par la règle pair-impair. */
export function insideRing(point: LatLon, ring: readonly LatLon[]): boolean {
  const [y, x] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i]!;
    const [yj, xj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Vrai si un groupe de quartiers (pris parmi `sizes`) laisse, retiré de la commune de `total` ventes, un reste de 1 à
 * `minSales - 1` ventes. Les quartiers d'une commune ne se recouvrent pas : la somme des tailles est exacte.
 */
export function subsetRevealing(total: number, sizes: readonly number[], minSales: number): boolean {
  const reachable = new Uint8Array(total + 1);
  reachable[0] = 1;
  for (const s of sizes) {
    for (let t = total; t >= s; t--) if (reachable[t - s]) reachable[t] = 1;
  }
  for (let t = 0; t <= total; t++) if (reachable[t] && revealing(total - t, minSales)) return true;
  return false;
}

/** Une case montrée dans la version précédente : son ensemble de ventes et ses chiffres. */
export interface ShownCell {
  zoneId: string;
  set: SaleSet;
  figures: CellFigures;
  /** La version dont viennent les chiffres. */
  fromVersion: string;
}

export interface QuarterInput {
  zoneId: string;
  sales: readonly CellSale[];
}

export interface BlockInput {
  communeId: string;
  communeSales: readonly CellSale[];
  quarters: readonly QuarterInput[];
  /** Les cases de cette commune et de ce type montrées par la version précédente (publiées ou reprises). */
  previous: readonly ShownCell[];
}

export interface CellDecision {
  zoneId: string;
  status: CellStatus;
  reason: HoldReason | null;
  /** Chiffres montrés (`publiee` ou `reprise`), `null` si la case est retenue. */
  figures: CellFigures | null;
  /** Ensemble montré, pour la version suivante. */
  set: SaleSet | null;
  fromVersion: string | null;
}

/**
 * Décide, pour une commune et un type de logement, ce qui est publié par la version `versionId`.
 *
 * 1. Une case de moins de `minSales` ventes est retenue (`seuil`).
 * 2. Tant qu'un groupe de quartiers publiés laisse un reste révélateur dans la commune, le plus petit quartier publié
 *    est retenu (`difference`).
 * 3. Contre la version précédente, deux cases dont l'une contient l'autre ne doivent pas différer d'un reste
 *    révélateur ; un quartier fautif est retenu (`version`) ; si la commune elle-même l'est, toute la commune garde les
 *    chiffres de la version précédente (`reprise`).
 */
export function decideBlock(input: BlockInput, versionId: string, settings: PriceSettings = DEFAULT_PRICE_SETTINGS): CellDecision[] {
  const k = settings.minSales;
  const commune = { zoneId: input.communeId, set: saleSet(input.communeSales), prices: input.communeSales.map((s) => s.pricePerM2) };
  const quarters = input.quarters.map((q) => ({ zoneId: q.zoneId, set: saleSet(q.sales), prices: q.sales.map((s) => s.pricePerM2) }));
  const held = new Map<string, HoldReason>();

  if (commune.prices.length < k) held.set(commune.zoneId, 'seuil');
  for (const q of quarters) if (q.prices.length < k) held.set(q.zoneId, 'seuil');

  const shownQuarters = () => quarters.filter((q) => !held.has(q.zoneId));
  const reprise = (): CellDecision[] => {
    const prev = new Map(input.previous.map((p) => [p.zoneId, p]));
    const ids = [commune.zoneId, ...quarters.map((q) => q.zoneId), ...input.previous.map((p) => p.zoneId)];
    return [...new Set(ids)].map((zoneId): CellDecision => {
      const p = prev.get(zoneId);
      return p
        ? { zoneId, status: 'reprise', reason: 'version', figures: p.figures, set: p.set, fromVersion: p.fromVersion }
        : { zoneId, status: 'retenue', reason: 'version', figures: null, set: null, fromVersion: null };
    });
  };

  if (!held.has(commune.zoneId)) {
    // 2. Différences dans la version.
    for (;;) {
      const shown = shownQuarters();
      if (!subsetRevealing(setSize(commune.set), shown.map((q) => setSize(q.set)), k)) break;
      const smallest = [...shown].sort((a, b) => setSize(a.set) - setSize(b.set) || a.zoneId.localeCompare(b.zoneId))[0]!;
      held.set(smallest.zoneId, 'difference');
    }
  } else {
    // Sans commune publiée, un quartier publié serait une commune plus petite : retenu aussi.
    for (const q of shownQuarters()) held.set(q.zoneId, 'seuil');
  }

  // 3. Différences avec la version précédente.
  if (input.previous.length > 0) {
    for (;;) {
      const shown = [...(held.has(commune.zoneId) ? [] : [commune]), ...shownQuarters()];
      let fault: string | null = null;
      for (const cell of shown) {
        for (const p of input.previous) {
          const ab = minus(cell.set, p.set);
          const ba = minus(p.set, cell.set);
          // Une case contient l'autre quand l'un des restes est nul : l'autre reste est alors exact.
          if ((ba === 0 && revealing(ab, k)) || (ab === 0 && revealing(ba, k))) {
            fault = cell.zoneId;
            break;
          }
        }
        if (fault) break;
      }
      if (!fault) break;
      if (fault === commune.zoneId) return reprise();
      held.set(fault, 'version');
    }
  }

  const decide = (cell: { zoneId: string; set: SaleSet; prices: number[] }): CellDecision => {
    const reason = held.get(cell.zoneId);
    return reason
      ? { zoneId: cell.zoneId, status: 'retenue', reason, figures: null, set: null, fromVersion: null }
      : { zoneId: cell.zoneId, status: 'publiee', reason: null, figures: figuresOf(cell.prices, settings.roundTo), set: cell.set, fromVersion: versionId };
  };
  return [decide(commune), ...quarters.map(decide)];
}

/** Le premier et le dernier mois (`AAAA-MM`) d'une version, à partir de la date de la dernière vente publiée. */
export function windowOf(lastSale: string, months: number): { from: string; to: string } {
  const y = Number(lastSale.slice(0, 4));
  const m = Number(lastSale.slice(5, 7));
  const start = y * 12 + (m - 1) - (months - 1);
  const fy = Math.floor(start / 12);
  const fm = (start % 12) + 1;
  return { from: `${fy}-${String(fm).padStart(2, '0')}`, to: lastSale.slice(0, 7) };
}
