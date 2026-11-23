/**
 * L'avis motivé par les références de l'agent, quand le calcul ne peut pas donner de fourchette (audit A046, R690).
 *
 * En secteur pauvre en ventes publiées, hors des départements couverts par DVF ou sans données chargées, le calcul
 * refuse de donner une fourchette [R27]. L'agent qui suit le bien peut alors ouvrir un avis motivé avec ses propres
 * ventes réelles, qu'il déclare avoir vérifiées : chacune avec son mois, sa surface, son prix et la nature de sa preuve
 * (acte consulté, vente de l'agence, référence notariale, vente d'un confrère prouvée). La fourchette est la sienne,
 * jamais celle du code : l'avis le dit en toutes lettres, avec la raison de l'absence de fourchette automatique. Le code
 * ne fait que vérifier les références, calculer leur prix médian au m² et refuser une fourchette trop loin de ce
 * qu'elles disent. Une vente citée n'a ni nom ni numéro de voie [R29]. L'avis reste un brouillon jusqu'à la validation
 * de l'agent [R30].
 */
import type { NoRangeReason } from './fourchette.ts';

/** La preuve d'une référence : une liste fermée, jamais un texte libre qui pourrait porter un nom [R29]. */
export type ReferenceProof = 'acte' | 'agence' | 'notaire' | 'confrere';

export const REFERENCE_PROOFS: Readonly<Record<ReferenceProof, string>> = {
  acte: 'Acte de vente consulté',
  agence: 'Vente conclue par l’agence',
  notaire: 'Référence notariale',
  confrere: 'Vente d’un confrère, preuve vue',
};

/** Une vente réelle apportée et vérifiée par l'agent, telle que l'avis la cite. */
export interface AgentReference {
  /** `AAAA-MM`. */
  month: string;
  surface: number;
  price: number;
  pricePerM2: number;
  proof: ReferenceProof;
  street?: string;
  town?: string;
}

/** Les raisons du calcul pour lesquelles l'avis motivé est ouvert : le bien est un logement, l'adresse est trouvée. */
export const MANUAL_REASONS: readonly NoRangeReason[] = ['peu_de_ventes', 'dvf_non_couvert', 'donnees_absentes', 'hors_zone'];

/** Pourquoi il n'y a pas de fourchette automatique, dit au client. */
export const MANUAL_REASON_TEXT: Readonly<Record<string, string>> = {
  type: 'le calcul automatique ne traite que les appartements et les maisons, à partir des ventes publiées',
  peu_de_ventes: 'les ventes publiées de biens comparables près de chez vous sont trop peu nombreuses pour un calcul fiable',
  dvf_non_couvert: 'les ventes publiées par l’État ne couvrent pas ce département',
  donnees_absentes: 'les données de ventes publiées ne sont pas disponibles pour ce secteur',
  hors_zone: 'les données de ventes publiées dont nous disposons ne couvrent pas ce département',
};

export interface ManualSettings {
  minReferences: number;
  maxReferences: number;
  /** Une vente plus ancienne n'est pas une référence. */
  maxAgeMonths: number;
  /** La fourchette de l'agent ne s'écarte pas plus que cela, de part et d'autre, de la valeur des références. */
  maxGapFromReferences: number;
  /** L'écart de la fourchette : la borne haute au plus tant de fois la basse. */
  maxSpread: number;
}

export const DEFAULT_MANUAL_SETTINGS: ManualSettings = { minReferences: 3, maxReferences: 20, maxAgeMonths: 60, maxGapFromReferences: 0.25, maxSpread: 1.3 };

export interface ManualInput {
  low: number;
  high: number;
  references: AgentReference[];
}

export type ManualRefusal = 'invalid_references' | 'invalid_range' | 'not_verified';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthIndex = (yyyyMm: string): number => Number(yyyyMm.slice(0, 4)) * 12 + Number(yyyyMm.slice(5, 7)) - 1;

/** Un lieu cité : court, sans chiffre, donc sans numéro de voie [R29]. */
function place(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/\s+/g, ' ');
  if (v === '') return undefined;
  if (v.length > 80 || /\d/.test(v) || /[<>]/.test(v)) return null;
  return v;
}

/** Lit l'avis motivé saisi par l'agent ; ce qui n'a pas la bonne forme est refusé en entier. */
export function readManual(value: unknown, now: Date, settings: ManualSettings = DEFAULT_MANUAL_SETTINGS): { ok: true; value: ManualInput } | { ok: false; code: ManualRefusal } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'invalid_references' };
  const m = value as { low?: unknown; high?: unknown; references?: unknown; verified?: unknown };
  // L'agent déclare avoir vérifié chaque vente qu'il apporte : sans cette déclaration, rien n'est ouvert.
  if (m.verified !== true) return { ok: false, code: 'not_verified' };
  const { low, high } = m;
  if (typeof low !== 'number' || typeof high !== 'number' || !Number.isInteger(low) || !Number.isInteger(high) || low <= 0 || high <= low || high > low * settings.maxSpread) {
    return { ok: false, code: 'invalid_range' };
  }
  if (!Array.isArray(m.references) || m.references.length < settings.minReferences || m.references.length > settings.maxReferences) return { ok: false, code: 'invalid_references' };
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const references: AgentReference[] = [];
  for (const raw of m.references as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid_references' };
    const r = raw as { month?: unknown; surface?: unknown; price?: unknown; proof?: unknown; street?: unknown; town?: unknown };
    if (typeof r.month !== 'string' || !MONTH.test(r.month)) return { ok: false, code: 'invalid_references' };
    const age = current - monthIndex(r.month);
    if (age < 0 || age > settings.maxAgeMonths) return { ok: false, code: 'invalid_references' };
    if (typeof r.surface !== 'number' || !Number.isFinite(r.surface) || r.surface <= 0 || r.surface > 5_000) return { ok: false, code: 'invalid_references' };
    if (typeof r.price !== 'number' || !Number.isInteger(r.price) || r.price < 1_000 || r.price > 100_000_000) return { ok: false, code: 'invalid_references' };
    if (typeof r.proof !== 'string' || !Object.hasOwn(REFERENCE_PROOFS, r.proof)) return { ok: false, code: 'invalid_references' };
    const street = place(r.street);
    const town = place(r.town);
    if (street === null || town === null) return { ok: false, code: 'invalid_references' };
    const surface = Math.round(r.surface * 10) / 10;
    references.push({ month: r.month, surface, price: r.price, pricePerM2: Math.round((r.price / surface) * 100) / 100, proof: r.proof as ReferenceProof, ...(street ? { street } : {}), ...(town ? { town } : {}) });
  }
  references.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  return { ok: true, value: { low, high, references } };
}

/** Le prix médian au m² des références, au centime : un terrain peut valoir moins d'un euro le m². */
export function referencesMedian(references: readonly AgentReference[]): number {
  const v = references.map((r) => r.pricePerM2).sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return Math.round((v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2) * 100) / 100;
}

/** Le prix au m² tel qu'il est écrit : à l'euro dès 100 €, sinon au centime, sans zéro inutile. */
export function perM2Shown(n: number): number {
  return n >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
}

export function perM2Text(n: number): string {
  const shown = perM2Shown(n);
  return shown >= 100 ? `${String(shown).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €` : `${String(shown).replace('.', ',')} €`;
}

/**
 * La fourchette de l'agent dit à peu près ce que disent ses références : au plus `maxSpread` entre ses bornes, et la
 * valeur des références (leur médiane au m² fois la surface du bien) ne tombe pas à plus de `maxGapFromReferences` hors
 * de la fourchette. Plus loin, ce n'est plus un avis motivé par ces ventes [R27, R690]. Vérifié à l'ouverture, à
 * chaque ajustement et à la validation.
 */
export function manualRangeAllowed(low: number, high: number, medianPerM2: number, surface: number, limits: Pick<ManualSettings, 'maxSpread' | 'maxGapFromReferences'>): boolean {
  if (!Number.isInteger(low) || !Number.isInteger(high) || low <= 0 || high <= low || high > low * limits.maxSpread) return false;
  const value = medianPerM2 * surface;
  return value >= low * (1 - limits.maxGapFromReferences) && value <= high * (1 + limits.maxGapFromReferences);
}

export function rangeFollowsReferences(input: ManualInput, surface: number, settings: ManualSettings = DEFAULT_MANUAL_SETTINGS): boolean {
  return manualRangeAllowed(input.low, input.high, referencesMedian(input.references), surface, settings);
}
