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

/** Vrai si le point est sur un bord du contour, sommets compris. */
function onBoundary(p: LatLon, ring: readonly LatLon[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const cross = (b[1] - a[1]) * (p[0] - a[0]) - (b[0] - a[0]) * (p[1] - a[1]);
    const scale = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1e-12);
    if (Math.abs(cross) > 1e-12 * scale) continue;
    if (p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) return true;
  }
  return false;
}

/**
 * Des points tout près de l'intérieur du contour : le milieu de chaque bord, poussé d'un rien vers l'intérieur. Ils
 * trouvent un recouvrement que les sommets ne montrent pas (deux contours identiques, par exemple), même concave.
 */
function innerPoints(ring: readonly LatLon[]): LatLon[] {
  const out: LatLon[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const eps = len * 1e-6;
    const mid: LatLon = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const n: LatLon = [(-(b[1] - a[1]) / len) * eps, ((b[0] - a[0]) / len) * eps];
    const left: LatLon = [mid[0] + n[0], mid[1] + n[1]];
    const right: LatLon = [mid[0] - n[0], mid[1] - n[1]];
    if (insideRing(left, ring)) out.push(left);
    else if (insideRing(right, ring)) out.push(right);
  }
  return out;
}

function properCross(a: LatLon, b: LatLon, c: LatLon, d: LatLon): boolean {
  const o = (p: LatLon, q: LatLon, r: LatLon) => Math.sign((q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Écart en dessous duquel deux morceaux d'un contour se touchent : les arrondis ne cachent jamais un contact [R150]. */
export const RING_TOUCH_METERS = 0.1;

/** Le contour en mètres, projeté autour de son premier point (assez juste à l'échelle d'une commune). */
function ringInMeters(points: readonly LatLon[]): Array<[number, number]> {
  const [lat0, lon0] = points[0]!;
  const east = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return points.map(([lat, lon]) => [(lat - lat0) * 110_574, (lon - lon0) * east]);
}

/** La distance du point au segment, et où tombe le point le plus proche (0 en `a`, 1 en `b`). */
function nearestOnSegment(p: [number, number], a: [number, number], b: [number, number]): { distance: number; t: number } {
  const dy = b[0] - a[0], dx = b[1] - a[1];
  const len2 = dy * dy + dx * dx;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dy + (p[1] - a[1]) * dx) / len2));
  return { distance: Math.hypot(p[0] - (a[0] + t * dy), p[1] - (a[1] + t * dx)), t };
}

/**
 * Vrai si, en mètres, le contour n'a pas de vrai intérieur (RC59) : largeur moyenne (2 × surface / périmètre) sous
 * 10 cm ; une pointe dont le retour passe à moins de 10 cm de son aller ; ou un sommet à moins de 10 cm d'un bord qui
 * n'est ni le sien ni celui d'à côté. Un petit bord qui tourne normalement n'en est pas un.
 */
function ringNearlyTouches(points: readonly LatLon[]): boolean {
  const p = ringInMeters(points);
  const n = p.length;
  let twiceArea = 0;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = p[i]!, b = p[(i + 1) % n]!;
    twiceArea += a[1] * b[0] - b[1] * a[0];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (Math.abs(twiceArea) / perimeter < RING_TOUCH_METERS) return true;
  for (let i = 0; i < n; i++) {
    const v = p[(i + n - 1) % n]!, w = p[i]!, x = p[(i + 1) % n]!;
    // Le point le plus proche ailleurs qu'au sommet commun : le bord revient en arrière sur l'autre.
    const back = nearestOnSegment(x, v, w);
    if (back.t < 1 && back.distance < RING_TOUCH_METERS) return true;
    const forth = nearestOnSegment(v, w, x);
    if (forth.t > 0 && forth.distance < RING_TOUCH_METERS) return true;
  }
  if (n < 5) return false;
  for (let k = 0; k < n; k++) {
    for (let e = 0; e < n; e++) {
      // Les bords du sommet et ceux qui les suivent sont lus ci-dessus : un petit bord y serait pris pour un contact.
      const gap = (e - k + n) % n;
      if (gap === 0 || gap === n - 1 || gap === 1 || gap === n - 2) continue;
      if (nearestOnSegment(p[k]!, p[e]!, p[(e + 1) % n]!).distance < RING_TOUCH_METERS) return true;
    }
  }
  return false;
}

/**
 * Vrai si un contour se croise, se touche ou repasse sur lui-même : l'intérieur n'en est plus défini, donc ni les ventes
 * qui lui appartiennent, ni le prix publié [R150]. Un point répété à la suite ne compte pas, un contour concave non plus.
 * Un contact à moins de 10 cm compte, pour que les arrondis ne cachent jamais un contour sans surface (RC59).
 */
export function ringSelfCrosses(ring: readonly LatLon[]): boolean {
  const same = (p: LatLon, q: LatLon) => p[0] === q[0] && p[1] === q[1];
  const points = ring.filter((p, i) => !same(p, ring[(i + ring.length - 1) % ring.length]!));
  const n = points.length;
  if (n < 3) return true;
  const turn = (p: LatLon, q: LatLon, r: LatLon) => Math.sign((q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]));
  const within = (p: LatLon, q: LatLon, r: LatLon) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const touches = (a: LatLon, b: LatLon, c: LatLon, d: LatLon) => {
    const o1 = turn(a, b, c), o2 = turn(a, b, d), o3 = turn(c, d, a), o4 = turn(c, d, b);
    if (o1 !== o2 && o3 !== o4) return true;
    return (o1 === 0 && within(a, b, c)) || (o2 === 0 && within(a, b, d)) || (o3 === 0 && within(c, d, a)) || (o4 === 0 && within(c, d, b));
  };
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    // Deux bords qui se suivent ne partagent que leur sommet ; s'ils repartent en arrière, ils se recouvrent.
    const c = points[(i + 2) % n]!;
    if (turn(a, b, c) === 0 && ((c[0] - b[0]) * (a[0] - b[0]) + (c[1] - b[1]) * (a[1] - b[1])) > 0) return true;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (touches(a, b, points[j]!, points[(j + 1) % n]!)) return true;
    }
  }
  return ringNearlyTouches(points);
}

/**
 * Vrai si deux contours se recouvrent. Deux zones voisines qui partagent un bord ne se recouvrent pas, même quand
 * l'une y a des sommets que l'autre n'a pas ; un sommet de l'une à l'intérieur de l'autre, un point juste à l'intérieur de l'une dans l'autre, ou deux bords qui se croisent, si.
 */
export function ringsOverlap(a: readonly LatLon[], b: readonly LatLon[]): boolean {
  if (a.some((p) => !onBoundary(p, b) && insideRing(p, b))) return true;
  if (b.some((p) => !onBoundary(p, a) && insideRing(p, a))) return true;
  if (innerPoints(a).some((p) => insideRing(p, b)) || innerPoints(b).some((p) => insideRing(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (properCross(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
    }
  }
  return false;
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
  /**
   * Les autres cases montrées par la version précédente, ailleurs dans le réseau, qui partagent au moins une vente avec
   * ce bloc (une zone retirée puis retracée, par exemple) : comparées aussi, jamais reprises.
   */
  related?: readonly ShownCell[];
}

/**
 * Vrai si deux ensembles de ventes, l'un ancien et l'autre nouveau, laisseraient lire de 1 à `k - 1` ventes par
 * différence. Prudent : une vente dont l'empreinte a changé d'une publication à l'autre (position corrigée) compte des
 * deux côtés ; tant qu'un côté est révélateur et l'autre plus petit que `k`, la différence est tenue pour lisible.
 */
export function pairRevealing(a: SaleSet, b: SaleSet, k: number): boolean {
  const ab = minus(a, b);
  const ba = minus(b, a);
  return (revealing(ab, k) && ba < k) || (revealing(ba, k) && ab < k);
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
 * 3. Contre la version précédente, partout dans le réseau, deux cases presque emboîtées ne doivent pas différer d'un
 *    reste révélateur (`pairRevealing`) ; un quartier fautif est retenu (`version`) ; si la commune elle-même l'est, toute la commune garde les
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
  const against = [...input.previous, ...(input.related ?? [])];
  if (against.length > 0) {
    for (;;) {
      const shown = [...(held.has(commune.zoneId) ? [] : [commune]), ...shownQuarters()];
      let fault: string | null = null;
      for (const cell of shown) {
        for (const p of against) {
          if (pairRevealing(cell.set, p.set, k)) {
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
