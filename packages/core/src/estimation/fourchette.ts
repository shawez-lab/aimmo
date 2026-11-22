/**
 * La fourchette de prix d'un bien, calculée par le code (M04, E01). L'IA n'y touche pas.
 *
 * Méthode reprise du site (`functions/_lib/estimation.js` de shawez-immo), qui tourne déjà :
 *   1. comparables : même type, surface proche, vendus dans la fenêtre de temps (36 mois avant l'estimation, réglage),
 *      les plus proches du bien ; le rayon s'élargit tant qu'il y a moins de 12 ventes. Une vente plus ancienne n'est
 *      jamais retenue, ni corrigée : la fenêtre, sa raison et le nombre de ventes écartées sont rendus (audit A048,
 *      R691) ;
 *   2. prix au m² de référence : la médiane des comparables (40 au plus, les plus proches) ;
 *   3. ajustements écrits et bornés : état, époque, étage et ascenseur, extérieur, stationnement, et le diagnostic
 *      énergétique, que le cahier demande en plus ;
 *   4. fourchette : plus ou moins la moitié de l'écart interquartile, entre 5 et 10 %, jusqu'à 12 % avec peu de ventes
 *      ou des ventes cherchées loin ; arrondie.
 * Moins de 5 comparables : pas de fourchette, avec sa raison [R27]. La date des dernières ventes est toujours rendue,
 * avec l'avertissement quand les plus récentes manquent encore, et DVF ne couvre pas l'Alsace, la Moselle ni Mayotte
 * [R28].
 */

export type EstimatedKind = 'apartment' | 'house';

/** Une vente réelle de la source. `month` : `AAAA-MM`. */
export interface Sale {
  id: string;
  kind: EstimatedKind;
  lat: number;
  lon: number;
  surface: number;
  pricePerM2: number;
  month: string;
  rooms?: number | null;
  land?: number | null;
}

export interface SalesCoverage {
  /** Département couvert, par exemple `21`. */
  department: string;
  /** Date de la dernière vente des données, `AAAA-MM-JJ`. */
  lastSale: string;
  years: readonly number[];
  /** Source citée, licence comprise. */
  source: string;
}

/** La source des ventes (E02 : les fichiers DVF préparés par le site). */
export interface SalesSource {
  coverage(): Promise<SalesCoverage | null>;
  /** Les ventes de ce type dans le cercle, en mètres, de n'importe quelle surface. */
  within(kind: EstimatedKind, lat: number, lon: number, radius: number): Promise<Sale[]>;
}

export type Condition = 'travaux' | 'rafraichir' | 'bon' | 'neuf';
export type Era = 'avant1948' | '1948-1974' | '1975-2000' | '2001-2012' | 'apres2012';
export type EnergyClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface EstimatedProperty {
  /** Autre chose qu'un logement : pas de fourchette ici (M16 pour les commerces). */
  kind: EstimatedKind | 'land' | 'building' | 'commercial' | 'business_walls' | 'business';
  surface: number | null;
  lat: number | null;
  lon: number | null;
  postalCode: string | null;
  condition?: Condition | null;
  era?: Era | null;
  energyClass?: EnergyClass | null;
  // Appartement
  floor?: number | null;
  elevator?: boolean;
  buildingFloors?: number | null;
  balcony?: boolean;
  parking?: boolean;
  garageBox?: boolean;
  cellar?: boolean;
  caretaker?: boolean;
  // Maison
  pool?: boolean;
  garage?: boolean;
  singleStorey?: boolean;
  land?: number | null;
  // Les deux
  terrace?: boolean;
}

export interface Adjustment {
  label: string;
  /** En pour cent, arrondi. */
  pct: number;
  /** Un coefficient retenu par l'agent, avec son motif ; sans `source`, celui du barème du réseau [R693]. */
  source?: 'agent';
  motive?: AgentAdjustmentMotive;
}

/** Les caractéristiques qu'un ajustement peut viser : celles du barème, et rien d'autre [R693]. */
export const ADJUSTMENT_LABELS = [
  'État général',
  'Époque de construction',
  'Rez-de-chaussée',
  'Étage élevé sans ascenseur',
  'Étage élevé avec ascenseur',
  'Dernier étage',
  'Terrasse',
  'Balcon',
  'Garage ou box',
  'Place de parking',
  'Cave',
  'Gardien',
  'Piscine',
  'Garage',
  'Plain-pied',
  'Grand terrain',
  'Petit terrain',
  'Diagnostic énergétique',
] as const;

/** Pourquoi l'agent retient un autre coefficient que le barème : une liste fermée [R693]. */
export const AGENT_ADJUSTMENT_MOTIVES = {
  visite: 'constaté à la visite',
  devis: 'travaux chiffrés par devis',
  marche_local: 'ventes du secteur connues de l’agent',
  diagnostic: 'diagnostic reçu',
} as const;
export type AgentAdjustmentMotive = keyof typeof AGENT_ADJUSTMENT_MOTIVES;

/** Un ajustement retenu par l'agent : il remplace celui du barème pour la même caractéristique, ou s'y ajoute. */
export interface AgentAdjustment {
  label: (typeof ADJUSTMENT_LABELS)[number];
  /** En pour cent entier, de -15 à +15. */
  pct: number;
  motive: AgentAdjustmentMotive;
}

/**
 * La méthode des coefficients du barème et son périmètre, dits avec chaque ajustement [R693]. Les ventes publiées ne
 * disent ni l'état, ni l'étage, ni les annexes des biens vendus : aucun coefficient ne peut être calibré sur elles.
 */
export const ADJUSTMENT_METHOD =
  'Les ajustements suivent le barème écrit du réseau, le même pour tous les logements : les ventes publiées ne disent ni l’état, ni l’étage, ni les annexes des biens vendus, ce qui empêche de le calibrer sur votre secteur.';

export interface DataInfo {
  /** Dernière vente publiée dans les données, toutes ventes confondues ; celle des comparables est `latestUsedSale`. */
  lastSale: string | null;
  years: readonly number[];
  source: string | null;
  /** Les ventes des derniers mois ne sont pas encore publiées [R28]. */
  recentMissing: boolean;
  /** Mois écoulés depuis la dernière vente des données. */
  monthsSinceLastSale: number | null;
  /** Le département n'est pas couvert par DVF : l'avis repose sur les annonces et les ventes connues de l'agent. */
  dvfNotCovered: boolean;
}

export interface Comparable extends Sale {
  /** Distance au bien, en mètres. */
  distance: number;
}

export type NoRangeReason = 'type' | 'adresse' | 'hors_zone' | 'dvf_non_couvert' | 'donnees_absentes' | 'peu_de_ventes';

export type RangeResult =
  | {
      ok: true;
      low: number;
      high: number;
      /** Prix au m² retenu, ajustements compris. */
      pricePerM2: number;
      /** Médiane du prix au m² des comparables. */
      medianPerM2: number;
      margin: number;
      /** Mois de la vente la plus récente parmi les comparables retenus, `AAAA-MM` [R28]. */
      latestUsedSale: string;
      comparables: Comparable[];
      /** Distance de la vente retenue la plus éloignée, arrondie aux 50 m supérieurs. */
      radius: number;
      adjustments: Adjustment[];
      data: DataInfo;
      /** La fenêtre de temps des ventes retenues, et pourquoi [R691]. */
      window: SalesWindow;
    }
  | { ok: false; reason: NoRangeReason; comparablesFound: number; data: DataInfo };

/** La fenêtre de temps des comparables : rien d'avant `from` n'est retenu [R691]. */
export interface SalesWindow {
  months: number;
  /** Premier mois retenu, `AAAA-MM`. */
  from: string;
  /** Ventes de même sorte et de surface proche, dans le rayon retenu, écartées parce que trop anciennes. */
  excludedOld: number;
  justification: string;
}

/** Pourquoi une vente trop ancienne n'est pas retenue : écrit une fois, rendu avec chaque fourchette [R691]. */
export const WINDOW_JUSTIFICATION =
  'Au-delà de cette fenêtre, les prix ont trop changé pour comparer une vente sans la corriger ; elle n’est donc pas retenue.';

export interface RangeSettings {
  /** Une vente plus ancienne que ce nombre de mois, avant le mois de l'estimation, n'est pas retenue [R691]. */
  maxSaleAgeMonths: number;
  radii: Record<EstimatedKind, readonly number[]>;
  /** Nombre de ventes visé avant d'arrêter d'élargir. */
  target: number;
  /** En dessous, pas de fourchette [R27]. */
  minimum: number;
  /** Au plus ce nombre de comparables, les plus proches. */
  maxComparables: number;
  /** Rapport de surface admis : [min, max]. */
  surfaceRatio: Record<EstimatedKind, readonly [number, number]>;
  /** Au-delà, les ventes les plus récentes sont réputées manquer [R28]. */
  recentMissingAfterMonths: number;
  /** Départements que DVF ne couvre pas [R28]. */
  dvfNotCovered: readonly string[];
  energy: Record<EnergyClass, number>;
}

export const DEFAULT_RANGE_SETTINGS: RangeSettings = Object.freeze<RangeSettings>({
  maxSaleAgeMonths: 36,
  radii: { apartment: [300, 500, 800, 1200, 2000, 3000, 5000], house: [500, 1000, 2000, 3000, 5000, 8000, 12000] },
  target: 12,
  minimum: 5,
  maxComparables: 40,
  surfaceRatio: { apartment: [0.6, 1.6], house: [0.6, 1.7] },
  recentMissingAfterMonths: 3,
  dvfNotCovered: ['57', '67', '68', '976'],
  // Diagnostic énergétique : réglages écrits, bornés avec les autres ajustements.
  energy: { A: 0.03, B: 0.02, C: 0, D: 0, E: -0.02, F: -0.05, G: -0.08 },
});

/** Département d'un code postal : trois chiffres outre-mer, sinon deux ; la Corse reste « 20 » comme DVF. */
export function departmentOf(postalCode: string): string | null {
  const code = postalCode.trim();
  if (!/^\d{5}$/.test(code)) return null;
  return code.startsWith('97') ? code.slice(0, 3) : code.slice(0, 2);
}

export function distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
}

function quantile(sorted: readonly number[], q: number): number {
  const p = (sorted.length - 1) * q;
  const b = Math.floor(p);
  const lo = sorted[b]!;
  const hi = sorted[Math.min(b + 1, sorted.length - 1)]!;
  return lo + (hi - lo) * (p - b);
}

function round(value: number): number {
  const step = value >= 500_000 ? 5000 : 1000;
  return Math.round(value / step) * step;
}

/** Les ajustements écrits, bornés de -25 % à +18 % au total. */
export function adjustmentsFor(p: EstimatedProperty, settings: RangeSettings = DEFAULT_RANGE_SETTINGS): { total: number; lines: [string, number][] } {
  const lines: [string, number][] = [];
  const add = (label: string, v: number): void => {
    if (v) lines.push([label, v]);
  };
  add('État général', { travaux: -0.12, rafraichir: -0.05, bon: 0, neuf: 0.06 }[p.condition ?? 'bon'] ?? 0);
  add('Époque de construction', { avant1948: 0, '1948-1974': -0.03, '1975-2000': 0, '2001-2012': 0.02, apres2012: 0.04 }[p.era ?? '1975-2000'] ?? 0);
  if (p.kind === 'apartment') {
    // Un étage ou un ascenseur inconnus ne font rien : ils ne valent ni rez-de-chaussée, ni « sans ascenseur » [R10].
    const floor = p.floor ?? null;
    if (floor === 0) add('Rez-de-chaussée', -0.05);
    if (floor !== null && floor >= 3 && p.elevator === false) add('Étage élevé sans ascenseur', -Math.min(0.08, 0.03 * (floor - 2)));
    if (floor !== null && floor >= 4 && p.elevator === true) add('Étage élevé avec ascenseur', 0.02);
    if (floor !== null && floor > 0 && p.buildingFloors && floor >= p.buildingFloors) add('Dernier étage', 0.02);
    if (p.terrace) add('Terrasse', 0.05);
    else if (p.balcony) add('Balcon', 0.02);
    if (p.garageBox) add('Garage ou box', 0.03);
    else if (p.parking) add('Place de parking', 0.02);
    if (p.cellar) add('Cave', 0.01);
    if (p.caretaker) add('Gardien', 0.01);
  } else {
    if (p.pool) add('Piscine', 0.04);
    if (p.garage) add('Garage', 0.03);
    if (p.singleStorey) add('Plain-pied', 0.02);
    if (p.terrace) add('Terrasse', 0.02);
    if ((p.land ?? 0) >= 1500) add('Grand terrain', 0.03);
    else if (p.land !== null && p.land !== undefined && p.land < 150) add('Petit terrain', -0.03);
  }
  if (p.energyClass) add('Diagnostic énergétique', settings.energy[p.energyClass] ?? 0);
  const sum = lines.reduce((s, [, v]) => s + v, 0);
  return { total: Math.max(-0.25, Math.min(0.18, sum)), lines };
}

function monthsBetween(fromDay: string, to: Date): number {
  const y = Number(fromDay.slice(0, 4));
  const m = Number(fromDay.slice(5, 7));
  return (to.getUTCFullYear() - y) * 12 + (to.getUTCMonth() + 1 - m);
}

export class Fourchette {
  constructor(
    private readonly source: SalesSource,
    private readonly settings: RangeSettings = DEFAULT_RANGE_SETTINGS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `exclude` : les ventes que l'agent a écartées, avec un motif, d'une version précédente de l'avis [R692]. */
  /** `agent` : les ajustements que l'agent retient à la place du barème, chacun avec son motif [R693]. */
  async estimate(p: EstimatedProperty, exclude: ReadonlySet<string> = new Set(), agent: readonly AgentAdjustment[] = []): Promise<RangeResult> {
    const coverage = await this.source.coverage();
    const department = p.postalCode ? departmentOf(p.postalCode) : null;
    const dvfNotCovered = department !== null && this.settings.dvfNotCovered.includes(department);
    const months = coverage ? monthsBetween(coverage.lastSale, this.now()) : null;
    const data: DataInfo = {
      lastSale: coverage?.lastSale ?? null,
      years: coverage?.years ?? [],
      source: coverage?.source ?? null,
      recentMissing: months !== null && months > this.settings.recentMissingAfterMonths,
      monthsSinceLastSale: months,
      dvfNotCovered,
    };
    const none = (reason: NoRangeReason, comparablesFound = 0): RangeResult => ({ ok: false, reason, comparablesFound, data });

    if (p.kind !== 'apartment' && p.kind !== 'house') return none('type');
    if (dvfNotCovered) return none('dvf_non_couvert');
    if (p.lat === null || p.lon === null || !p.surface || p.surface <= 0 || department === null) return none('adresse');
    if (!coverage) return none('donnees_absentes');
    if (department !== coverage.department) return none('hors_zone');

    const kind = p.kind;
    const now = this.now();
    const start = now.getUTCFullYear() * 12 + now.getUTCMonth() - this.settings.maxSaleAgeMonths;
    const from = `${String(Math.floor(start / 12)).padStart(4, '0')}-${String((start % 12) + 1).padStart(2, '0')}`;
    let excludedOld = 0;
    const [minRatio, maxRatio] = this.settings.surfaceRatio[kind];
    const radii = this.settings.radii[kind];
    let found: Comparable[] = [];
    let searched = 0;
    for (const radius of radii) {
      searched = radius;
      const sales = await this.source.within(kind, p.lat, p.lon, radius);
      found = [];
      excludedOld = 0;
      for (const s of sales) {
        if (s.kind !== kind || exclude.has(s.id)) continue;
        const ratio = s.surface / p.surface;
        if (ratio < minRatio || ratio > maxRatio) continue;
        const d = distance(p.lat, p.lon, s.lat, s.lon);
        if (d > radius) continue;
        // Trop ancienne : écartée, et comptée [R691].
        if (s.month < from) excludedOld += 1;
        else found.push({ ...s, distance: d });
      }
      if (found.length >= this.settings.target) break;
    }
    found.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
    if (found.length < this.settings.minimum) return none('peu_de_ventes', found.length);

    const comparables = found.slice(0, this.settings.maxComparables);
    const last = comparables[comparables.length - 1]!;
    const radius = Math.min(searched, Math.max(50, Math.ceil(last.distance / 50) * 50));
    const perM2 = comparables.map((c) => c.pricePerM2).sort((a, b) => a - b);
    const median = quantile(perM2, 0.5);
    const iqr = quantile(perM2, 0.75) - quantile(perM2, 0.25);
    let margin = Math.max(0.05, Math.min(0.1, iqr / 2 / median));
    const far = searched >= (radii[4] ?? Infinity);
    if (comparables.length < 10 || far) margin = Math.min(0.12, margin + 0.02);
    const bareme = adjustmentsFor(p, this.settings);
    // L'ajustement de l'agent remplace celui du barème pour la même caractéristique ; le total reste borné.
    const lines: { label: string; v: number; source: 'bareme' | 'agent'; motive?: AgentAdjustmentMotive }[] = [
      ...bareme.lines.filter(([label]) => !agent.some((a) => a.label === label)).map(([label, v]) => ({ label, v, source: 'bareme' as const })),
      ...agent.map((a) => ({ label: a.label, v: a.pct / 100, source: 'agent' as const, motive: a.motive })),
    ];
    const adj = { total: Math.max(-0.25, Math.min(0.18, lines.reduce((sum, l) => sum + l.v, 0))), lines };
    const m2 = median * (1 + adj.total);
    const centre = m2 * p.surface;
    return {
      ok: true,
      low: round(centre * (1 - margin)),
      high: round(centre * (1 + margin)),
      pricePerM2: Math.round(m2),
      medianPerM2: Math.round(median),
      margin,
      latestUsedSale: comparables.reduce((latest, c) => (c.month > latest ? c.month : latest), comparables[0]!.month),
      comparables,
      radius,
      adjustments: adj.lines.filter((l) => l.v !== 0 || l.source === 'agent').map((l) => ({ label: l.label, pct: Math.round(l.v * 100), ...(l.source === 'agent' ? { source: 'agent' as const, ...(l.motive ? { motive: l.motive } : {}) } : {}) })),
      data,
      window: { months: this.settings.maxSaleAgeMonths, from, excludedOld, justification: WINDOW_JUSTIFICATION },
    };
  }
}
