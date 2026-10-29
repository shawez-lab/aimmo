/**
 * Le calcul d'investissement (M17, Y03) : rendement brut et net avant impôt d'un bien, calculé par le code seul, par
 * des formules écrites ici, en centimes et en points de base [R120]. Aucun appel à l'IA [R121], aucun impôt ni régime
 * fiscal [R125]. Chaque entrée et chaque ligne du résultat porte sa valeur, sa source, sa date et l'hypothèse qui l'a
 * faite [R121]. Une entrée manquante rend « incomplet » avec la liste de ce qui manque, jamais un rendement [R10].
 * Chaque calcul est rangé avec ses entrées, et se rejoue à l'identique.
 *
 * Formules, version 1 (montants en centimes, entiers ; divisions arrondies au plus proche, la moitié en s'éloignant
 * de zéro) :
 * - frais d'acquisition = prix × taux du barème / 10 000 ;
 * - coût total = prix + frais d'acquisition + travaux ;
 * - loyer mensuel = loyer de marché au m² × surface (en centièmes de m²) / 100 ;
 * - loyer annuel = loyer mensuel × 12 ;
 * - rendement brut (points de base) = loyer annuel × 10 000 / coût total ;
 * - loyer perçu = loyer mensuel × (12 − mois de vacance) ;
 * - revenu net avant impôt = loyer perçu − charges non récupérables − taxe foncière ;
 * - rendement net avant impôt (points de base) = revenu net × 10 000 / coût total ;
 * - fourchette : les mêmes rendements avec les bornes basse et haute de l'intervalle du loyer de marché.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { MARKET_RENT_KINDS, type LoyersMarche, type MarketRentKind } from './loyers.ts';

export const FORMULA_VERSION = 1;

/** Une entrée du calcul : sa valeur, d'où elle vient, de quand, et ce qu'elle suppose. */
export interface Sourced<T> {
  value: T;
  source: string;
  asOf: string;
  hypothesis: string;
}

export interface MarketRentValue {
  /** Loyer au m², charges comprises, en centimes par mois. */
  centralM2Cents: number;
  lowerM2Cents: number;
  upperM2Cents: number;
}

export interface YieldInputs {
  /** Prix d'achat, en centimes. */
  price: Sourced<number> | null;
  /** Taux du barème des frais d'acquisition (ancien ou neuf), en points de base du prix. */
  acquisitionFeesRateBp: Sourced<number> | null;
  /** Travaux estimés, en centimes ; 0 quand il n'y en a pas, dit avec sa source. */
  works: Sourced<number> | null;
  /** Surface habitable, en centièmes de m². */
  livingArea: Sourced<number> | null;
  /** Loyer de marché au m² (Y02), avec les bornes de son intervalle. */
  marketRent: Sourced<MarketRentValue> | null;
  /** Charges non récupérables déclarées, en centimes par an. */
  nonRecoverableCharges: Sourced<number> | null;
  /** Taxe foncière déclarée, en centimes par an. */
  propertyTax: Sourced<number> | null;
  /** Vacance réglée, en mois entiers par an. */
  vacancyMonths: Sourced<number> | null;
}
export type InputKey = keyof YieldInputs;

export const INPUT_KEYS: readonly InputKey[] = [
  'price',
  'acquisitionFeesRateBp',
  'works',
  'livingArea',
  'marketRent',
  'nonRecoverableCharges',
  'propertyTax',
  'vacancyMonths',
];

/** Une ligne du résultat : chaque chiffre avec sa source, sa date et son hypothèse [R121]. */
export interface YieldLine {
  key: string;
  value: number;
  unit: 'cents' | 'cents_per_m2' | 'm2_hundredths' | 'bp' | 'months';
  source: string;
  asOf: string;
  hypothesis: string;
}

export interface YieldRange {
  low: number;
  central: number;
  high: number;
}

export type YieldResult =
  | {
      status: 'complet';
      formulaVersion: number;
      lines: YieldLine[];
      grossYieldBp: YieldRange;
      netYieldBp: YieldRange;
    }
  | { status: 'incomplet'; formulaVersion: number; missing: InputKey[] };

const LIMITS: Record<Exclude<InputKey, 'marketRent'>, [number, number]> = {
  price: [100, 100_000_000_000],
  acquisitionFeesRateBp: [0, 3_000],
  works: [0, 100_000_000_000],
  livingArea: [100, 10_000_000],
  nonRecoverableCharges: [0, 10_000_000_000],
  propertyTax: [0, 10_000_000_000],
  vacancyMonths: [0, 12],
};
const RENT_M2_MAX = 100_000;

export type InputCheck = { ok: true; value: YieldInputs } | { ok: false; code: 'valeur' | 'champ_inconnu'; field?: InputKey };

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(v) && !Number.isNaN(Date.parse(v));
const isInt = (v: unknown, [min, max]: [number, number]): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** Contrôle des entrées : seulement les champs prévus ; chacun absent, `null`, ou complet et borné. */
export function checkYieldInputs(input: unknown): InputCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, code: 'valeur' };
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!(INPUT_KEYS as readonly string[]).includes(key)) return { ok: false, code: 'champ_inconnu' };
  const out: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null) {
      out[key] = null;
      continue;
    }
    if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: 'valeur', field: key };
    const s = v as Record<string, unknown>;
    if (Object.keys(s).some((k) => !['value', 'source', 'asOf', 'hypothesis'].includes(k))) return { ok: false, code: 'valeur', field: key };
    if (!isText(s.source, 200) || !isDate(s.asOf) || !isText(s.hypothesis, 300)) return { ok: false, code: 'valeur', field: key };
    if (key === 'marketRent') {
      const m = s.value as Record<string, unknown> | null;
      if (typeof m !== 'object' || m === null || Array.isArray(m) || Object.keys(m).length !== 3) return { ok: false, code: 'valeur', field: key };
      const { centralM2Cents: c, lowerM2Cents: l, upperM2Cents: u } = m;
      if (!isInt(c, [1, RENT_M2_MAX]) || !isInt(l, [1, RENT_M2_MAX]) || !isInt(u, [1, RENT_M2_MAX]) || l > c || u < c) return { ok: false, code: 'valeur', field: key };
      out[key] = { value: { centralM2Cents: c, lowerM2Cents: l, upperM2Cents: u }, source: s.source, asOf: s.asOf, hypothesis: s.hypothesis };
      continue;
    }
    if (!isInt(s.value, LIMITS[key])) return { ok: false, code: 'valeur', field: key };
    out[key] = { value: s.value, source: s.source, asOf: s.asOf, hypothesis: s.hypothesis };
  }
  return { ok: true, value: out as unknown as YieldInputs };
}

/** a / b arrondi au plus proche, la moitié en s'éloignant de zéro ; b > 0. Calcul exact sur des entiers. */
export function roundDiv(a: number, b: number): number {
  const A = BigInt(a);
  const B = BigInt(b);
  const neg = A < 0n;
  const abs = neg ? -A : A;
  const q = (abs * 2n + B) / (B * 2n);
  return Number(neg ? -q : q);
}

/** Le calcul, à partir des entrées seules : la même entrée donne toujours le même résultat. */
export function computeYield(inputs: YieldInputs, computedAt: string): YieldResult {
  const missing = INPUT_KEYS.filter((k) => inputs[k] === null);
  if (missing.length > 0) return { status: 'incomplet', formulaVersion: FORMULA_VERSION, missing };
  const price = inputs.price!;
  const rate = inputs.acquisitionFeesRateBp!;
  const works = inputs.works!;
  const area = inputs.livingArea!;
  const rent = inputs.marketRent!;
  const charges = inputs.nonRecoverableCharges!;
  const tax = inputs.propertyTax!;
  const vacancy = inputs.vacancyMonths!;

  const fees = roundDiv(price.value * rate.value, 10_000);
  const totalCost = price.value + fees + works.value;
  const monthly = (m2: number): number => roundDiv(m2 * area.value, 100);
  const gross = (m2: number): number => roundDiv(monthly(m2) * 12 * 10_000, totalCost);
  const netIncome = (m2: number): number => monthly(m2) * (12 - vacancy.value) - charges.value - tax.value;
  const net = (m2: number): number => roundDiv(netIncome(m2) * 10_000, totalCost);
  const m = rent.value;

  const given = (key: string, s: Sourced<number>, unit: YieldLine['unit']): YieldLine => ({ key, value: s.value, unit, source: s.source, asOf: s.asOf, hypothesis: s.hypothesis });
  const calc = (key: string, value: number, unit: YieldLine['unit'], hypothesis: string): YieldLine => ({ key, value, unit, source: 'calcul', asOf: computedAt, hypothesis });
  const lines: YieldLine[] = [
    given('price', price, 'cents'),
    given('acquisitionFeesRateBp', rate, 'bp'),
    calc('acquisitionFees', fees, 'cents', 'prix × taux du barème / 10 000'),
    given('works', works, 'cents'),
    calc('totalCost', totalCost, 'cents', 'prix + frais d’acquisition + travaux'),
    given('livingArea', area, 'm2_hundredths'),
    { key: 'marketRentM2', value: m.centralM2Cents, unit: 'cents_per_m2', source: rent.source, asOf: rent.asOf, hypothesis: rent.hypothesis },
    { key: 'marketRentM2Low', value: m.lowerM2Cents, unit: 'cents_per_m2', source: rent.source, asOf: rent.asOf, hypothesis: 'borne basse de l’intervalle du loyer de marché' },
    { key: 'marketRentM2High', value: m.upperM2Cents, unit: 'cents_per_m2', source: rent.source, asOf: rent.asOf, hypothesis: 'borne haute de l’intervalle du loyer de marché' },
    calc('monthlyRent', monthly(m.centralM2Cents), 'cents', 'loyer de marché au m² × surface'),
    calc('annualRent', monthly(m.centralM2Cents) * 12, 'cents', 'loyer mensuel × 12'),
    given('vacancyMonths', vacancy, 'months'),
    calc('collectedRent', monthly(m.centralM2Cents) * (12 - vacancy.value), 'cents', 'loyer mensuel × (12 − mois de vacance)'),
    given('nonRecoverableCharges', charges, 'cents'),
    given('propertyTax', tax, 'cents'),
    calc('netIncome', netIncome(m.centralM2Cents), 'cents', 'loyer perçu − charges non récupérables − taxe foncière, avant impôt'),
    calc('grossYieldBp', gross(m.centralM2Cents), 'bp', 'loyer annuel × 10 000 / coût total'),
    calc('netYieldBp', net(m.centralM2Cents), 'bp', 'revenu net avant impôt × 10 000 / coût total'),
    calc('grossYieldBpLow', gross(m.lowerM2Cents), 'bp', 'rendement brut avec la borne basse du loyer de marché'),
    calc('grossYieldBpHigh', gross(m.upperM2Cents), 'bp', 'rendement brut avec la borne haute du loyer de marché'),
    calc('netYieldBpLow', net(m.lowerM2Cents), 'bp', 'rendement net avant impôt avec la borne basse du loyer de marché'),
    calc('netYieldBpHigh', net(m.upperM2Cents), 'bp', 'rendement net avant impôt avec la borne haute du loyer de marché'),
  ];
  return {
    status: 'complet',
    formulaVersion: FORMULA_VERSION,
    lines,
    grossYieldBp: { low: gross(m.lowerM2Cents), central: gross(m.centralM2Cents), high: gross(m.upperM2Cents) },
    netYieldBp: { low: net(m.lowerM2Cents), central: net(m.centralM2Cents), high: net(m.upperM2Cents) },
  };
}

export interface StoredCalculation {
  id: string;
  propertyId: string | null;
  projectId: string | null;
  inputs: YieldInputs;
  result: YieldResult;
  createdBy: string;
  createdAt: string;
}

export type CalculationResult = { ok: true; value: StoredCalculation } | { ok: false; rule: 'R16' | 'R120' | 'R122'; code: string; field?: InputKey };

export interface CalculInvestissementOptions {
  /** Les loyers de marché de Y02 : le calcul y lit le loyer d'une commune. */
  loyers?: LoyersMarche;
  now?: () => Date;
  newId?: () => string;
}

interface CalculationRow {
  id: string;
  network_id: string;
  property_id: string | null;
  project_id: string | null;
  inputs: string;
  status: string;
  result: string;
  formula_version: number;
  created_by: string;
  created_at: string;
}

const toStored = (row: CalculationRow): StoredCalculation => ({
  id: row.id,
  propertyId: row.property_id,
  projectId: row.project_id,
  inputs: JSON.parse(row.inputs) as YieldInputs,
  result: JSON.parse(row.result) as YieldResult,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export class CalculInvestissement {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly loyers: LoyersMarche | undefined;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: CalculInvestissementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.loyers = options.loyers;
  }

  /**
   * L'agent ou la direction calcule un bien qu'il voit (le sien ou le fichier commun), pour un projet d'investissement
   * de sa fiche ou sans projet. Le prix et la surface viennent du bien, le loyer de marché de la base (Y02) ; ce que
   * l'agent saisit en plus ou à la place porte son nom comme source. Le calcul est rangé, complet ou incomplet ; un
   * refus va au journal sans aucun chiffre [R13, R16].
   */
  async compute(
    acces: Acces,
    viewer: Viewer,
    input: { propertyId?: unknown; projectId?: unknown; inputs: unknown; marketRentQuery?: unknown },
  ): Promise<CalculationResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const refused = async (code: string, rule: 'R16' | 'R120' | 'R122' = 'R16', field?: InputKey): Promise<CalculationResult> => {
      await appendEvent(
        this.journal,
        {
          type: rule === 'R16' ? 'acces.refuse' : 'investir.calcul.refuse',
          actor,
          subject: `network:${viewer.networkId}`,
          data: { rule, code, kind: 'investment_calculation', role: String(viewer.role), ...(field ? { field } : {}) },
        },
        this.now,
      );
      return field ? { ok: false, rule, code, field } : { ok: false, rule, code };
    };
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return refused('role');
    const propertyId = input.propertyId ?? null;
    const projectId = input.projectId ?? null;
    if (propertyId !== null && typeof propertyId !== 'string') return refused('unknown');
    if (projectId !== null && typeof projectId !== 'string') return refused('unknown');
    let property: { price_eur: number | null; surface_m2: number | null } | null = null;
    if (propertyId !== null) {
      // Le bien sous R16 : celui de l'agent, ou du fichier commun du réseau ; la lecture et le refus vont au journal.
      const read = await acces.readProperty(viewer, propertyId);
      if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
      if (read.value.network_id !== viewer.networkId) return refused('unknown');
      property = { price_eur: read.value.price_eur, surface_m2: read.value.surface_m2 };
    }
    if (projectId !== null) {
      const project = await this.db.first<{ person_id: string }>("SELECT person_id FROM projects WHERE id = ? AND network_id = ? AND kind = 'invest'", [
        projectId,
        viewer.networkId,
      ]);
      if (!project) return refused('unknown');
      const read = await acces.readFiche(viewer, project.person_id);
      if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
      if (read.view !== 'full') return refused('not_assigned');
    }
    const checked = checkYieldInputs(input.inputs);
    if (!checked.ok) return refused(checked.code, 'R120', checked.field);
    const createdAt = this.now().toISOString();
    // Le loyer de marché n'est jamais saisi : il est lu dans la base (Y02), ou le calcul reste incomplet [R122].
    if (checked.value.marketRent !== null) return refused('loyer_saisi', 'R122', 'marketRent');
    // Ce que l'agent saisit porte son nom comme source, quoi qu'il écrive : seul le code dit « bien » ou « ANIL ».
    const inputs: YieldInputs = { ...checked.value };
    for (const key of INPUT_KEYS) {
      const v = inputs[key];
      if (v !== null) (inputs as unknown as Record<string, unknown>)[key] = { ...v, source: `saisi:${actor}`, asOf: createdAt.slice(0, 10) };
    }
    // Le prix et la surface du bien viennent de sa fiche quand elle les porte.
    if (property !== null) {
      if (property.price_eur !== null && property.price_eur > 0 && inputs.price === null) {
        inputs.price = { value: property.price_eur * 100, source: `bien:${String(propertyId)}`, asOf: createdAt.slice(0, 10), hypothesis: 'prix affiché du bien' };
      }
      if (property.surface_m2 !== null && property.surface_m2 > 0 && inputs.livingArea === null) {
        inputs.livingArea = { value: Math.round(property.surface_m2 * 100), source: `bien:${String(propertyId)}`, asOf: createdAt.slice(0, 10), hypothesis: 'surface du bien' };
      }
    }
    // Le loyer de marché vient de la base (Y02), jamais d'un chiffre saisi présenté comme celui de l'ANIL.
    const query = input.marketRentQuery;
    if (query !== undefined && query !== null) {
      const q = query as { inseeCode?: unknown; kind?: unknown };
      if (!this.loyers || typeof q.inseeCode !== 'string' || typeof q.kind !== 'string' || !(MARKET_RENT_KINDS as readonly string[]).includes(q.kind)) {
        return refused('valeur', 'R120', 'marketRent');
      }
      const rent = await this.loyers.marketRent(viewer.networkId, q.inseeCode, q.kind as MarketRentKind);
      if (rent.status === 'connu') {
        inputs.marketRent = {
          value: { centralM2Cents: rent.rentM2Cents, lowerM2Cents: rent.lowerM2Cents, upperM2Cents: rent.upperM2Cents },
          source: rent.citation,
          asOf: rent.asOf.slice(0, 10),
          hypothesis:
            rent.reliability === 'fiable'
              ? `loyer central, ${rent.observations} observations`
              : `loyer central, peu d’observations (${rent.observations})`,
        };
      }
    }
    const result = computeYield(inputs, createdAt);
    const id = this.newId();
    await this.db.run(
      `INSERT INTO investment_calculations (id, network_id, property_id, project_id, inputs, status, result, formula_version, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, propertyId, projectId, JSON.stringify(inputs), result.status, JSON.stringify(result), FORMULA_VERSION, actor, createdAt],
    );
    await appendEvent(
      this.journal,
      {
        type: 'investir.calcul',
        actor,
        subject: projectId ? `project:${projectId}` : `network:${viewer.networkId}`,
        data: { calculation: id, status: result.status, ...(propertyId ? { property: propertyId } : {}) },
      },
      this.now,
    );
    return { ok: true, value: { id, propertyId, projectId, inputs, result, createdBy: actor, createdAt } };
  }

  /** Un calcul rangé, sans contrôle d'accès : pour le code du système (note, alertes, routes qui contrôlent avant). */
  async get(networkId: string, id: string): Promise<StoredCalculation | null> {
    const row = await this.db.first<CalculationRow>('SELECT * FROM investment_calculations WHERE id = ? AND network_id = ?', [id, networkId]);
    return row ? toStored(row) : null;
  }

  /** Rejoue un calcul rangé depuis ses entrées : le résultat doit être identique au caractère près [R120]. */
  async replay(networkId: string, id: string): Promise<{ same: boolean; result: YieldResult } | null> {
    const row = await this.db.first<CalculationRow>('SELECT * FROM investment_calculations WHERE id = ? AND network_id = ?', [id, networkId]);
    if (!row) return null;
    const result = computeYield(JSON.parse(row.inputs) as YieldInputs, row.created_at);
    return { same: JSON.stringify(result) === row.result, result };
  }
}
