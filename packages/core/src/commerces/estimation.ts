/**
 * L'estimation d'un commerce (M16, CE02) : une fourchette calculée par le code seul, depuis les comptes saisis par
 * l'agent dans la fiche (CE01) et un barème par activité rangé par la direction avec sa source citée, jamais écrit dans
 * le code [R111, R10]. Aucun appel à l'IA : les comptes ne lui sont jamais envoyés [R112].
 *
 * Formules, version 1 (montants en centimes, entiers ; divisions arrondies au plus proche, la moitié en s'éloignant de
 * zéro, calcul exact sur des entiers) :
 * - fonds, `revenue_pct` : base = moyenne des chiffres d'affaires des exercices saisis ; basse = base × borne basse
 *   (points de base) / 10 000 ; haute = base × borne haute / 10 000 ;
 * - fonds, `ebitda_multiple` : base = moyenne des excédents bruts d'exploitation, saisis pour chaque exercice ; elle
 *   doit être positive ; basse = base × borne basse (centièmes) / 100 ; haute = base × borne haute / 100 ;
 * - murs ou local, `rent_yield` : base = loyer annuel du bail ; basse = base × 10 000 / taux haut (points de base) ;
 *   haute = base × 10 000 / taux bas. Un local ou des murs libres, sans bail (AU102) : base = la valeur locative de
 *   marché saisie avec ce qui la fonde (comparables, source), jamais un loyer inventé ; le bail, s'il existe, l'emporte.
 *
 * Chaque ligne du résultat porte sa valeur, sa source et son hypothèse [R111]. Sans fiche, activité, barème, exercice
 * ou loyer, la réponse est « incomplet » avec ce qui manque, jamais un chiffre [R10]. L'estimation est rangée, liée à
 * la version de la fiche et du barème qui l'ont faite ; l'agent du bien la valide. Tant qu'elle n'est pas validée,
 * seul l'agent du bien la voit ; validée, elle se lit comme la fiche [R16]. Le journal ne porte aucun chiffre [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Property, PropertyKind } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ACTIVITIES, BUSINESS_KINDS, type Activity, type BusinessSheetVersion, type FicheCommerce } from './fiche.ts';

export const VALUATION_FORMULA_VERSION = 1;

export const VALUATION_METHODS = ['revenue_pct', 'ebitda_multiple', 'rent_yield'] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];

/** Les méthodes permises pour chaque sorte de bien. */
export const METHODS_BY_KIND: Readonly<Partial<Record<PropertyKind, readonly ValuationMethod[]>>> = Object.freeze({
  business: ['revenue_pct', 'ebitda_multiple'],
  business_walls: ['rent_yield'],
  commercial: ['rent_yield'],
});

/** Les bornes permises d'un barème, selon sa méthode. */
export const SCALE_LIMITS: Readonly<Record<ValuationMethod, [number, number]>> = Object.freeze({
  revenue_pct: [1, 50_000],
  ebitda_multiple: [1, 10_000],
  rent_yield: [1, 5_000],
});

/** Un barème : sa méthode, ses bornes, sa source et sa date. */
export interface ValuationScale {
  id: string;
  activity: Activity;
  method: ValuationMethod;
  low: number;
  high: number;
  source: string;
  sourceDate: string;
  version: number;
}

/** Une ligne du calcul : sa valeur, d'où elle vient, ce qu'elle suppose. */
export interface ValuationLine {
  label: string;
  value: number;
  source: string;
  hypothesis: string;
}

export type ValuationComputation =
  | { status: 'ok'; formulaVersion: number; lowCents: number; highCents: number; lines: ValuationLine[] }
  | { status: 'incomplet'; formulaVersion: number; missing: string[] };

/** a × b / d arrondi au plus proche, la moitié en s'éloignant de zéro ; d > 0. Exact sur des entiers. */
export function mulDiv(a: number, b: number, d: number): number {
  const n = BigInt(a) * BigInt(b);
  const D = BigInt(d);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const q = (abs * 2n + D) / (D * 2n);
  return Number(neg ? -q : q);
}

const METHOD_WORDS: Record<ValuationMethod, string> = {
  revenue_pct: 'pourcentage du chiffre d’affaires moyen',
  ebitda_multiple: 'multiple de l’excédent brut d’exploitation moyen',
  rent_yield: 'loyer annuel divisé par un taux de rendement',
};

/**
 * Le calcul, depuis la fiche et le barème seuls : la même entrée donne toujours le même résultat. Aucun appel à l'IA
 * [R112].
 */
export function computeBusinessValuation(
  kind: PropertyKind,
  sheet: BusinessSheetVersion | null,
  method: ValuationMethod,
  scale: ValuationScale | null,
): ValuationComputation {
  const missing: string[] = [];
  if (!sheet) missing.push('fiche');
  if (sheet && sheet.sheet.activity === null) missing.push('activite');
  if (!scale) missing.push('bareme');
  const years = sheet?.sheet.fiscalYears ?? [];
  if (method !== 'rent_yield' && sheet && years.length === 0) missing.push('exercices');
  const market = sheet && sheet.sheet.leaseAnnualRentCents === null && sheet.sheet.marketAnnualRentCents !== null && sheet.sheet.marketRentBasis !== null;
  if (method === 'rent_yield' && sheet && sheet.sheet.leaseAnnualRentCents === null && !market) missing.push('loyer');
  if (missing.length > 0 || !sheet || !scale) return { status: 'incomplet', formulaVersion: VALUATION_FORMULA_VERSION, missing };

  const from = `fiche du commerce, version ${sheet.version}`;
  const scaleSource = `${scale.source} (${scale.sourceDate}), barème ${scale.activity} version ${scale.version}`;
  const lines: ValuationLine[] = [];
  let low: number;
  let high: number;
  if (method === 'rent_yield') {
    const rent = market ? sheet.sheet.marketAnnualRentCents! : sheet.sheet.leaseAnnualRentCents!;
    if (market) lines.push({ label: 'valeur_locative', value: rent, source: from, hypothesis: `local libre, sans bail : valeur locative de marché saisie par l’agent, fondée sur ${sheet.sheet.marketRentBasis}` });
    else lines.push({ label: 'loyer_annuel', value: rent, source: from, hypothesis: 'loyer annuel du bail commercial saisi par l’agent' });
    lines.push({ label: 'taux_bas_pb', value: scale.low, source: scaleSource, hypothesis: METHOD_WORDS[method] });
    lines.push({ label: 'taux_haut_pb', value: scale.high, source: scaleSource, hypothesis: METHOD_WORDS[method] });
    low = mulDiv(rent, 10_000, scale.high);
    high = mulDiv(rent, 10_000, scale.low);
    const base = market ? 'valeur locative' : 'loyer annuel';
    lines.push({ label: 'fourchette_basse', value: low, source: 'calcul', hypothesis: `${base} × 10 000 / taux haut` });
    lines.push({ label: 'fourchette_haute', value: high, source: 'calcul', hypothesis: `${base} × 10 000 / taux bas` });
  } else {
    const revenue = method === 'revenue_pct';
    // Chaque exercice doit porter l'excédent brut : un exercice sans lui ne compte pas pour zéro [R10].
    if (!revenue && years.some((y) => y.ebitdaCents === undefined)) return { status: 'incomplet', formulaVersion: VALUATION_FORMULA_VERSION, missing: ['excedent_brut'] };
    const sum = years.reduce((s, y) => s + (revenue ? y.revenueCents : y.ebitdaCents!), 0);
    const base = mulDiv(sum, 1, years.length);
    const yearsText = years.map((y) => y.year).join(', ');
    const what = revenue ? 'chiffre d’affaires' : 'excédent brut d’exploitation';
    if (base <= 0) return { status: 'incomplet', formulaVersion: VALUATION_FORMULA_VERSION, missing: [revenue ? 'chiffre_affaires_positif' : 'excedent_brut_positif'] };
    lines.push({ label: revenue ? 'chiffre_affaires_moyen' : 'excedent_brut_moyen', value: base, source: from, hypothesis: `moyenne du ${what} des exercices ${yearsText} saisis par l’agent` });
    const unit = method === 'revenue_pct' ? 10_000 : 100;
    const unitWord = method === 'revenue_pct' ? 'points de base' : 'centièmes';
    lines.push({ label: 'bareme_bas', value: scale.low, source: scaleSource, hypothesis: `${METHOD_WORDS[method]}, en ${unitWord}` });
    lines.push({ label: 'bareme_haut', value: scale.high, source: scaleSource, hypothesis: `${METHOD_WORDS[method]}, en ${unitWord}` });
    low = mulDiv(base, scale.low, unit);
    high = mulDiv(base, scale.high, unit);
    lines.push({ label: 'fourchette_basse', value: low, source: 'calcul', hypothesis: `base × barème bas / ${unit === 10_000 ? '10 000' : '100'}` });
    lines.push({ label: 'fourchette_haute', value: high, source: 'calcul', hypothesis: `base × barème haut / ${unit === 10_000 ? '10 000' : '100'}` });
  }
  return { status: 'ok', formulaVersion: VALUATION_FORMULA_VERSION, lowCents: low, highCents: high, lines };
}

export type ValuationRefusal = { ok: false; rule: 'R16' | 'R111' | null; code: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};

/** Contrôle d'un barème saisi par la direction : une source est exigée [R111]. */
export function checkScale(
  input: unknown,
): { ok: true; value: Omit<ValuationScale, 'id' | 'version'> } | ValuationRefusal {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, rule: null, code: 'valeur' };
  const keys = ['activity', 'method', 'low', 'high', 'source', 'sourceDate'];
  for (const k of Object.keys(input)) if (!keys.includes(k)) return { ok: false, rule: null, code: 'champ_inconnu' };
  const { activity, method, low, high, source, sourceDate } = input as Record<string, unknown>;
  if (typeof source !== 'string' || source.trim().length < 3 || source.trim().length > 300) return { ok: false, rule: 'R111', code: 'source' };
  if (!isDay(sourceDate)) return { ok: false, rule: 'R111', code: 'date_source' };
  if (typeof activity !== 'string' || !(ACTIVITIES as readonly string[]).includes(activity)) return { ok: false, rule: null, code: 'activite' };
  if (typeof method !== 'string' || !(VALUATION_METHODS as readonly string[]).includes(method)) return { ok: false, rule: null, code: 'methode' };
  const [min, max] = SCALE_LIMITS[method as ValuationMethod];
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
  if (!ok(low) || !ok(high) || low > high) return { ok: false, rule: null, code: 'bornes' };
  return { ok: true, value: { activity: activity as Activity, method: method as ValuationMethod, low, high, source: source.trim(), sourceDate } };
}

interface ScaleRow {
  id: string;
  network_id: string;
  activity: Activity;
  method: ValuationMethod;
  low: number;
  high: number;
  source: string;
  source_date: string;
  version: number;
}

interface ValuationRow {
  id: string;
  network_id: string;
  property_id: string;
  sheet_version: number;
  scale_id: string;
  method: ValuationMethod;
  low_cents: number;
  high_cents: number;
  lines: string;
  created_by: string;
  created_at: string;
  validated_by: string | null;
  validated_at: string | null;
}

const toScale = (r: ScaleRow): ValuationScale => ({
  id: r.id,
  activity: r.activity,
  method: r.method,
  low: r.low,
  high: r.high,
  source: r.source,
  sourceDate: r.source_date,
  version: r.version,
});

export interface BusinessValuation {
  id: string;
  propertyId: string;
  sheetVersion: number;
  scaleId: string;
  method: ValuationMethod;
  lowCents: number;
  highCents: number;
  lines: ValuationLine[];
  createdBy: string;
  createdAt: string;
  validated: { by: string; at: string } | null;
}

const toValuation = (r: ValuationRow): BusinessValuation => {
  // Des lignes illisibles ne sont jamais montrées comme vides : une estimation sans ses sources n'existe pas [R111].
  let lines: ValuationLine[];
  try {
    const parsed: unknown = JSON.parse(r.lines);
    if (!Array.isArray(parsed)) throw new Error('lignes');
    lines = parsed as ValuationLine[];
  } catch {
    throw new Error('estimation du commerce : lignes illisibles');
  }
  return {
    id: r.id,
    propertyId: r.property_id,
    sheetVersion: r.sheet_version,
    scaleId: r.scale_id,
    method: r.method,
    lowCents: r.low_cents,
    highCents: r.high_cents,
    lines,
    createdBy: r.created_by,
    createdAt: r.created_at,
    validated: r.validated_by !== null && r.validated_at !== null ? { by: r.validated_by, at: r.validated_at } : null,
  };
};

const VALUATION_SELECT = `SELECT v.*, val.validated_by, val.validated_at FROM business_valuations v
  LEFT JOIN business_valuation_validations val ON val.valuation_id = v.id`;

export type EstimateResult =
  | { ok: true; status: 'ok'; value: BusinessValuation }
  | { ok: true; status: 'incomplet'; missing: string[] }
  | ValuationRefusal;

export interface EstimationCommerceOptions {
  now?: () => Date;
  newId?: () => string;
}

export class EstimationCommerce {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiches: FicheCommerce,
    options: EstimationCommerceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Les barèmes en vigueur du réseau, chacun à sa dernière version, pour la direction seule [R16, R111]. */
  async scales(viewer: Viewer): Promise<{ ok: true; value: ValuationScale[] } | ValuationRefusal> {
    if (viewer.role !== 'direction') return this.refused(viewer, `network:${viewer.networkId}`, 'role');
    const rows = await this.db.all<ScaleRow>(
      `SELECT s.* FROM business_valuation_scales s WHERE s.network_id = ?
       AND s.version = (SELECT MAX(version) FROM business_valuation_scales o WHERE o.network_id = s.network_id AND o.activity = s.activity AND o.method = s.method)
       ORDER BY s.activity, s.method`,
      [viewer.networkId],
    );
    return { ok: true, value: rows.map(toScale) };
  }

  /** La direction range un barème, avec sa source et sa date ; un barème corrigé est une nouvelle version [R111, R17]. */
  async recordScale(viewer: Viewer, input: unknown): Promise<{ ok: true; value: ValuationScale } | ValuationRefusal> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction') return this.refused(viewer, `network:${viewer.networkId}`, 'role');
    const checked = checkScale(input);
    if (!checked.ok) {
      await appendEvent(this.journal, { type: 'commerces.bareme.refuse', actor, subject: `network:${viewer.networkId}`, data: { rule: checked.rule, code: checked.code } }, this.now);
      return checked;
    }
    const s = checked.value;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.currentScale(viewer.networkId, s.activity, s.method);
      const version = (last?.version ?? 0) + 1;
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO business_valuation_scales (id, network_id, activity, method, low, high, source, source_date, version, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [id, viewer.networkId, s.activity, s.method, s.low, s.high, s.source, s.sourceDate, version, actor, this.now().toISOString()],
      );
      if (changes !== 1) continue;
      await appendEvent(
        this.journal,
        { type: 'commerces.bareme', actor, subject: `network:${viewer.networkId}`, data: { activity: s.activity, method: s.method, version } },
        this.now,
      );
      return { ok: true, value: { ...s, id, version } };
    }
    throw new Error('barème de commerce : trop d’écritures simultanées');
  }

  /** Le barème en vigueur d'une activité pour une méthode : sa dernière version. */
  async currentScale(networkId: string, activity: Activity, method: ValuationMethod): Promise<ValuationScale | null> {
    const row = await this.db.first<ScaleRow>(
      'SELECT * FROM business_valuation_scales WHERE network_id = ? AND activity = ? AND method = ? ORDER BY version DESC LIMIT 1',
      [networkId, activity, method],
    );
    return row ? toScale(row) : null;
  }

  /**
   * L'agent du bien demande l'estimation par une méthode permise pour sa sorte. Incomplète, rien n'est rangé et la
   * réponse dit ce qui manque [R10] ; complète, elle est rangée avec ses lignes, non validée.
   */
  async estimate(acces: Acces, viewer: Viewer, propertyId: string, method: unknown): Promise<EstimateResult> {
    const property = await this.ownAgent(acces, viewer, propertyId);
    if (!('id' in property)) return property;
    const allowed = METHODS_BY_KIND[property.kind] ?? [];
    if (typeof method !== 'string' || !(allowed as readonly string[]).includes(method)) return { ok: false, rule: null, code: 'methode' };
    const sheet = await this.fiches.current(property.id);
    const scale = sheet?.sheet.activity ? await this.currentScale(property.network_id, sheet.sheet.activity, method as ValuationMethod) : null;
    const computed = computeBusinessValuation(property.kind, sheet, method as ValuationMethod, scale);
    const actor = `agent:${viewer.userId}`;
    if (computed.status === 'incomplet') {
      await appendEvent(
        this.journal,
        { type: 'commerces.estimation.incomplete', actor, subject: `property:${property.id}`, data: { rule: 'R10', method, missing: computed.missing } },
        this.now,
      );
      return { ok: true, status: 'incomplet', missing: computed.missing };
    }
    const id = this.newId();
    await this.db.run(
      `INSERT INTO business_valuations (id, network_id, property_id, sheet_version, scale_id, method, low_cents, high_cents, lines, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, property.network_id, property.id, sheet!.version, scale!.id, method, computed.lowCents, computed.highCents, JSON.stringify(computed.lines), actor, this.now().toISOString()],
    );
    // Le journal dit qu'une estimation existe, jamais ses chiffres [R13].
    await appendEvent(
      this.journal,
      { type: 'commerces.estimation', actor, subject: `property:${property.id}`, data: { valuation: id, method, sheetVersion: sheet!.version, scaleVersion: scale!.version } },
      this.now,
    );
    const row = await this.db.first<ValuationRow>(`${VALUATION_SELECT} WHERE v.id = ?`, [id]);
    return { ok: true, status: 'ok', value: toValuation(row!) };
  }

  /**
   * L'agent du bien valide une estimation : seulement la plus récente, et seulement si la fiche n'a pas changé depuis
   * le calcul. Une validation est définitive [R17].
   */
  async validate(acces: Acces, viewer: Viewer, valuationId: string): Promise<{ ok: true; value: BusinessValuation } | ValuationRefusal> {
    const row = await this.db.first<ValuationRow>(`${VALUATION_SELECT} WHERE v.id = ? AND v.network_id = ?`, [valuationId, viewer.networkId]);
    if (!row) return this.refused(viewer, `network:${viewer.networkId}`, 'unknown');
    const property = await this.ownAgent(acces, viewer, row.property_id);
    if (!('id' in property)) return property;
    if (row.validated_by !== null) return { ok: true, value: toValuation(row) };
    const latest = await this.db.first<{ id: string }>('SELECT id FROM business_valuations WHERE property_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [row.property_id]);
    if (latest?.id !== row.id) return { ok: false, rule: 'R111', code: 'estimation_remplacee' };
    const sheet = await this.fiches.current(row.property_id);
    if (sheet?.version !== row.sheet_version) return { ok: false, rule: 'R111', code: 'fiche_changee' };
    if (!(await this.scaleStillCurrent(row))) return { ok: false, rule: 'R111', code: 'bareme_change' };
    const actor = `agent:${viewer.userId}`;
    const { changes } = await this.db.run(
      'INSERT INTO business_valuation_validations (valuation_id, network_id, validated_by, validated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [row.id, row.network_id, actor, this.now().toISOString()],
    );
    if (changes === 1) {
      await appendEvent(this.journal, { type: 'commerces.estimation.validee', actor, subject: `property:${row.property_id}`, data: { valuation: row.id } }, this.now);
    }
    const done = await this.db.first<ValuationRow>(`${VALUATION_SELECT} WHERE v.id = ?`, [row.id]);
    return { ok: true, value: toValuation(done!) };
  }

  /**
   * Les estimations d'un bien : toutes pour son agent ; les seules validées pour la direction et la conformité, qui
   * voient le bien en entier [R16].
   */
  async read(acces: Acces, viewer: Viewer, propertyId: string): Promise<{ ok: true; value: BusinessValuation[] } | ValuationRefusal> {
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, `property:${propertyId}`, 'not_assigned');
    if (!BUSINESS_KINDS.includes(read.value.kind)) return { ok: false, rule: null, code: 'sorte' };
    const own = viewer.role === 'agent' && read.value.agent_id === viewer.userId;
    const rows = await this.db.all<ValuationRow>(
      `${VALUATION_SELECT} WHERE v.property_id = ? ${own ? '' : 'AND val.valuation_id IS NOT NULL'} ORDER BY v.created_at, v.rowid`,
      [propertyId],
    );
    return { ok: true, value: rows.map(toValuation) };
  }

  /**
   * La dernière fourchette validée d'un bien, si la fiche n'a pas changé depuis : pour le code du système (la
   * présentation anonyme de CE03). `null` sinon.
   */
  async validatedRange(propertyId: string): Promise<{ lowCents: number; highCents: number; valuationId: string } | null> {
    const row = await this.db.first<ValuationRow>(
      `${VALUATION_SELECT} WHERE v.property_id = ? AND val.valuation_id IS NOT NULL ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1`,
      [propertyId],
    );
    if (!row) return null;
    const sheet = await this.fiches.current(propertyId);
    if (sheet?.version !== row.sheet_version) return null;
    if (!(await this.scaleStillCurrent(row))) return null;
    return { lowCents: row.low_cents, highCents: row.high_cents, valuationId: row.id };
  }

  /** Le barème qui a fait l'estimation est-il toujours la dernière version de son activité et de sa méthode ? */
  private async scaleStillCurrent(row: ValuationRow): Promise<boolean> {
    const used = await this.db.first<ScaleRow>('SELECT * FROM business_valuation_scales WHERE id = ?', [row.scale_id]);
    if (!used) return false;
    const current = await this.currentScale(used.network_id, used.activity, used.method);
    return current?.id === used.id;
  }

  /** Le bien, s'il est un commerce et que le lecteur en est l'agent ; sinon le refus, au journal [R16]. */
  private async ownAgent(acces: Acces, viewer: Viewer, propertyId: string): Promise<Property | ValuationRefusal> {
    if (viewer.role !== 'agent') {
      await acces.readProperty(viewer, propertyId);
      return this.refused(viewer, `property:${propertyId}`, 'role');
    }
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full' || read.value.agent_id !== viewer.userId) return this.refused(viewer, `property:${propertyId}`, 'not_assigned');
    if (!BUSINESS_KINDS.includes(read.value.kind)) return { ok: false, rule: null, code: 'sorte' };
    return read.value;
  }

  private async refused(viewer: Viewer, subject: string, code: string): Promise<ValuationRefusal> {
    await appendEvent(
      this.journal,
      {
        type: 'acces.refuse',
        actor: `${String(viewer.role)}:${viewer.userId}`,
        subject,
        data: { rule: 'R16', role: String(viewer.role), kind: 'business_valuation', code },
      },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
