/**
 * Le banc de mesure de M04 (E07) : la fourchette AIMMO comparée à l'estimation de l'agent, bien par bien.
 *
 * Critère du cahier : sur 20 biens, écart médian de moins de 10 % entre la fourchette AIMMO et l'estimation de
 * l'agent, chaque écart expliqué. Les biens réels restent hors du dépôt : le fichier n'a ni adresse, ni nom, ni
 * numéro, et des coordonnées arrondies à trois décimales (une centaine de mètres) au plus. Le résultat ne recopie
 * jamais les coordonnées : chaque bien est désigné par son numéro de ligne.
 */
import { parseCsv } from '../reprise/csv.ts';
import type { Condition, EnergyClass, Era, EstimatedProperty, Fourchette, NoRangeReason } from './fourchette.ts';

export interface ValuationCase {
  /** Numéro de ligne dans le fichier, en-tête compté. */
  line: number;
  property: EstimatedProperty;
  /** L'estimation de l'agent, en euros. */
  agentValue: number;
}

export type GapPosition = 'dans' | 'au-dessus' | 'en-dessous';

export interface ValuationGap {
  line: number;
  /** Écart signé du milieu de la fourchette à l'estimation de l'agent, en pour cent de celle-ci ; null sans fourchette. */
  gapPct: number | null;
  /** Où tombe l'estimation de l'agent par rapport à la fourchette. */
  position: GapPosition | null;
  /** Ce qui explique l'écart, en clair, sans coordonnée. */
  explanation: string;
}

export interface ValuationMeasure {
  total: number;
  /** Biens qui ont reçu une fourchette. */
  measured: number;
  /** Écart médian, en valeur absolue, en pour cent ; null si aucun bien n'a de fourchette. */
  medianGapPct: number | null;
  /** Estimations de l'agent tombées dans la fourchette. */
  inside: number;
  gaps: ValuationGap[];
}

/** Le seuil du cahier : écart médian de moins de 10 %, sur 20 biens. */
export const MEASURE_TARGET = Object.freeze({ cases: 20, medianGapPct: 10 });

const NO_RANGE_LABELS: Record<NoRangeReason, string> = {
  type: 'pas un logement',
  adresse: 'coordonnées ou surface manquantes',
  hors_zone: 'hors de la zone couverte par les ventes',
  dvf_non_couvert: 'département sans ventes DVF',
  donnees_absentes: 'données de ventes illisibles',
  peu_de_ventes: 'moins de ventes comparables que le minimum',
};

const plain = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const KINDS: Record<string, 'apartment' | 'house'> = { appartement: 'apartment', maison: 'house' };
const CONDITIONS: Record<string, Condition> = { travaux: 'travaux', 'a rafraichir': 'rafraichir', rafraichir: 'rafraichir', bon: 'bon', neuf: 'neuf' };
const ERAS: readonly Era[] = ['avant1948', '1948-1974', '1975-2000', '2001-2012', 'apres2012'];
const REQUIRED = ['type', 'surface', 'lat', 'lon', 'code_postal', 'estimation_agent'] as const;
const BOOLEANS = { ascenseur: 'elevator', balcon: 'balcony', terrasse: 'terrace', parking: 'parking', cave: 'cellar', piscine: 'pool', garage: 'garage', plain_pied: 'singleStorey' } as const;

function num(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim().replace(/\s/g, '').replace(',', '.').replace(/€$/, ''));
  return Number.isFinite(n) ? n : NaN;
}

function yes(raw: string | undefined, line: number, column: string): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const w = plain(raw);
  if (w === 'oui') return true;
  if (w === 'non') return false;
  throw new Error(`Ligne ${line} : ${column} doit valoir oui ou non.`);
}

/** Trois décimales au plus : au-delà, la coordonnée désigne la maison, pas le quartier. */
function coordinate(raw: string | undefined, line: number, column: string): number {
  const text = (raw ?? '').trim().replace(',', '.');
  if (!/^-?\d{1,3}(\.\d{1,3})?$/.test(text)) {
    throw new Error(`Ligne ${line} : ${column} manquante ou trop précise ; l'arrondir à trois décimales.`);
  }
  return Number(text);
}

/**
 * Lit le fichier des biens (CSV, points-virgules, UTF-8, en-tête). Colonnes obligatoires : type (appartement ou
 * maison), surface, lat, lon, code_postal, estimation_agent. Facultatives : etage, ascenseur, balcon, terrasse,
 * parking, cave, piscine, garage, plain_pied (oui ou non), terrain (m²), etat, epoque, dpe.
 * Un message d'erreur cite la ligne et la colonne, jamais la valeur lue.
 */
export function parseValuationCases(csv: string): ValuationCase[] {
  const rows = parseCsv(csv.replace(/^﻿/, '')).filter((r) => r.some((cell) => cell.trim() !== ''));
  const header = (rows[0] ?? []).map(plain);
  for (const column of REQUIRED) {
    if (!header.includes(column)) throw new Error(`Colonne manquante : ${column}.`);
  }
  const cases: ValuationCase[] = [];
  for (const [i, row] of rows.slice(1).entries()) {
    const line = i + 2;
    const cell = (column: string): string | undefined => {
      const at = header.indexOf(column);
      return at < 0 ? undefined : row[at];
    };
    const kind = KINDS[plain(cell('type') ?? '')];
    if (!kind) throw new Error(`Ligne ${line} : type doit valoir appartement ou maison.`);
    const surface = num(cell('surface'));
    const agentValue = num(cell('estimation_agent'));
    if (surface === null || !(surface > 0)) throw new Error(`Ligne ${line} : surface manquante ou illisible.`);
    if (agentValue === null || !(agentValue > 0)) throw new Error(`Ligne ${line} : estimation_agent manquante ou illisible.`);
    const postalCode = (cell('code_postal') ?? '').trim();
    if (!/^\d{5}$/.test(postalCode)) throw new Error(`Ligne ${line} : code_postal illisible.`);
    const property: EstimatedProperty = {
      kind,
      surface,
      lat: coordinate(cell('lat'), line, 'lat'),
      lon: coordinate(cell('lon'), line, 'lon'),
      postalCode,
    };
    const floor = num(cell('etage'));
    if (floor !== null) {
      if (!Number.isInteger(floor)) throw new Error(`Ligne ${line} : etage illisible.`);
      property.floor = floor;
    }
    const land = num(cell('terrain'));
    if (land !== null) {
      if (!(land >= 0)) throw new Error(`Ligne ${line} : terrain illisible.`);
      property.land = land;
    }
    for (const [column, key] of Object.entries(BOOLEANS)) {
      const v = yes(cell(column), line, column);
      if (v !== undefined) property[key] = v;
    }
    const state = cell('etat');
    if (state !== undefined && state.trim() !== '') {
      const c = CONDITIONS[plain(state)];
      if (!c) throw new Error(`Ligne ${line} : etat doit valoir travaux, à rafraîchir, bon ou neuf.`);
      property.condition = c;
    }
    const era = cell('epoque');
    if (era !== undefined && era.trim() !== '') {
      const e = ERAS.find((x) => x === plain(era).replace(/\s/g, ''));
      if (!e) throw new Error(`Ligne ${line} : epoque doit valoir ${ERAS.join(', ')}.`);
      property.era = e;
    }
    const dpe = cell('dpe');
    if (dpe !== undefined && dpe.trim() !== '') {
      const d = dpe.trim().toUpperCase();
      if (!/^[A-G]$/.test(d)) throw new Error(`Ligne ${line} : dpe doit valoir une lettre de A à G.`);
      property.energyClass = d as EnergyClass;
    }
    cases.push({ line, property, agentValue });
  }
  return cases;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Compare chaque bien : fourchette AIMMO contre estimation de l'agent, et l'explication de l'écart. */
export async function measureValuations(cases: readonly ValuationCase[], fourchette: Pick<Fourchette, 'estimate'>): Promise<ValuationMeasure> {
  const gaps: ValuationGap[] = [];
  for (const c of cases) {
    const r = await fourchette.estimate(c.property);
    if (!r.ok) {
      gaps.push({ line: c.line, gapPct: null, position: null, explanation: `Pas de fourchette : ${NO_RANGE_LABELS[r.reason]} (${r.comparablesFound} ventes trouvées).` });
      continue;
    }
    const mid = (r.low + r.high) / 2;
    const gapPct = round1(((mid - c.agentValue) / c.agentValue) * 100);
    const position: GapPosition = c.agentValue > r.high ? 'au-dessus' : c.agentValue < r.low ? 'en-dessous' : 'dans';
    const parts = [
      `${r.comparables.length} ventes comparables jusqu'à ${r.radius} m, médiane ${Math.round(r.medianPerM2)} €/m², la plus récente en ${r.latestUsedSale}`,
      r.adjustments.length > 0 ? `ajustements : ${r.adjustments.map((a) => `${a.label} ${a.pct > 0 ? '+' : ''}${a.pct} %`).join(', ')}` : 'sans ajustement',
      `marge ±${Math.round(r.margin * 100)} %`,
      position === 'dans' ? "l'estimation de l'agent est dans la fourchette" : `l'estimation de l'agent est ${position === 'au-dessus' ? 'au-dessus' : 'en dessous'} de la fourchette`,
    ];
    if (r.data.recentMissing) parts.push('les ventes des derniers mois ne sont pas encore publiées');
    gaps.push({ line: c.line, gapPct, position, explanation: `${parts.join(' ; ')}.` });
  }
  const measured = gaps.filter((g) => g.gapPct !== null);
  const m = median(measured.map((g) => Math.abs(g.gapPct!)));
  return {
    total: cases.length,
    measured: measured.length,
    medianGapPct: m === null ? null : round1(m),
    inside: measured.filter((g) => g.position === 'dans').length,
    gaps,
  };
}

/** Le critère du cahier est-il tenu : 20 biens mesurés au moins, écart médian de moins de 10 %. */
export function meetsTarget(result: ValuationMeasure): boolean {
  return result.measured >= MEASURE_TARGET.cases && result.medianGapPct !== null && result.medianGapPct < MEASURE_TARGET.medianGapPct;
}
