/**
 * Le calcul du viager (HX48, M17) : bouquet et rente calculés par le code seul, par des formules écrites ici, en
 * centimes et en entiers, sans IA [R530]. Chaque entrée et chaque ligne du résultat porte sa valeur, sa source, sa date
 * et l'hypothèse qui l'a faite ; une entrée manquante rend « incomplet » avec la liste de ce qui manque, jamais un
 * chiffre [R10]. Chaque calcul est rangé avec ses entrées et se rejoue à l'identique.
 *
 * L'espérance de vie n'est jamais saisie ni écrite dans le code : elle est lue dans une table importée par la direction,
 * avec sa source et son millésime, pour l'ensemble des deux sexes [R531]. Le calcul n'est ni une offre ni un conseil :
 * il le dit, et l'expert du viager de M18 est proposé par la mise en relation de M18, sur l'accord du client [R532].
 *
 * Formules, version 1 (montants en centimes ; divisions arrondies au plus proche, la moitié vers le haut) :
 * - espérance retenue = la plus longue des espérances des têtes (rente réversible), lue dans la table ;
 * - viager occupé : valeur du droit d'usage et d'habitation = valeur libre × usufruit de l'art. 669 du CGI à l'âge de la
 *   tête la plus jeune × 60 % (art. 762 bis du CGI) ; valeur occupée = valeur libre − droit d'usage ;
 *   viager libre : valeur occupée = valeur libre ;
 * - capital converti en rente = valeur occupée − bouquet (le bouquet ne dépasse jamais la valeur occupée) ;
 * - nombre de mois = espérance retenue (dixièmes d'année) × 12 / 10 ;
 * - taux mensuel = taux technique annuel / 12 ;
 * - rente mensuelle = capital × t / (1 − (1 + t)^−n), calculée en virgule fixe à 10^18 ; à taux nul, capital / n ;
 * - total des rentes sur l'espérance = rente mensuelle × n, sans indexation.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const VIAGER_FORMULA_VERSION = 1;

/** Ce que chaque calcul de viager dit, toujours [R532]. */
export const VIAGER_NOTICE =
  'Estimation calculée par AIMMO, ni offre ni conseil : le bouquet et la rente se fixent avec l’expert du viager et le notaire.';

export interface Sourced<T> {
  value: T;
  source: string;
  asOf: string;
  hypothesis: string;
}

export interface ViagerInputs {
  /** Valeur libre du bien, en centimes. */
  marketValue: Sourced<number> | null;
  /** Viager occupé (le vendeur garde l'usage) ou libre. */
  occupied: Sourced<boolean> | null;
  /** Âge de chaque tête, en années entières, une ou deux. */
  headAges: Sourced<number[]> | null;
  /** Bouquet convenu, en centimes. */
  bouquet: Sourced<number> | null;
  /** Taux technique annuel, en points de base. */
  annualRateBp: Sourced<number> | null;
  /** Espérance de vie de chaque tête, en dixièmes d'année, lue dans la table de la direction : jamais saisie [R531]. */
  expectancies: Sourced<number[]> | null;
}
export type ViagerInputKey = keyof ViagerInputs;
export const VIAGER_INPUT_KEYS: readonly ViagerInputKey[] = ['marketValue', 'occupied', 'headAges', 'bouquet', 'annualRateBp', 'expectancies'];
/** Ce que l'agent peut saisir ; l'espérance de vie n'en fait pas partie [R531]. */
const TYPED_KEYS: readonly ViagerInputKey[] = ['marketValue', 'occupied', 'headAges', 'bouquet', 'annualRateBp'];

export interface ViagerLine {
  key: string;
  value: number;
  unit: 'cents' | 'bp' | 'mois' | 'annees' | 'dixiemes_annee' | 'oui_non';
  source: string;
  asOf: string;
  hypothesis: string;
}

export type ViagerResult =
  | { status: 'incomplet'; formulaVersion: number; missing: ViagerInputKey[]; notice: string }
  | {
      status: 'complet';
      formulaVersion: number;
      lines: ViagerLine[];
      bouquetCents: number;
      monthlyRentCents: number;
      months: number;
      notice: string;
    };

/** Usufruit de l'art. 669 du CGI selon l'âge, en pour cent de la pleine propriété. */
export function usufructPercent(age: number): number {
  const bands: readonly [number, number][] = [[21, 90], [31, 80], [41, 70], [51, 60], [61, 50], [71, 40], [81, 30], [91, 20]];
  for (const [below, pct] of bands) if (age < below) return pct;
  return 10;
}

const big = (n: number): bigint => BigInt(n);
/** a / b arrondi au plus proche, la moitié vers le haut, pour a ≥ 0 et b > 0. */
const divRound = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);
const SCALE = 10n ** 18n;

/** Rente mensuelle, en centimes, d'un capital sur n mois à un taux annuel en points de base, en entiers. */
export function monthlyRent(capitalCents: number, months: number, annualRateBp: number): number {
  if (capitalCents === 0) return 0;
  const c = big(capitalCents);
  const n = big(months);
  if (annualRateBp === 0) return Number(divRound(c, n));
  const t = divRound(big(annualRateBp) * SCALE, 120_000n);
  let p = SCALE;
  for (let i = 0; i < months; i++) p = divRound(p * (SCALE + t), SCALE);
  // c × t / (1 − 1/p) = c × t × p / (p − 1), tout à l'échelle.
  return Number(divRound(c * t * p, (p - SCALE) * SCALE));
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Le calcul lui-même, sans base ni IA : les mêmes entrées donnent le même résultat, au caractère près [R530]. */
export function computeViager(inputs: ViagerInputs, at: string): ViagerResult {
  const asOf = at.slice(0, 10);
  const missing = VIAGER_INPUT_KEYS.filter((k) => inputs[k] === null);
  if (missing.length > 0) return { status: 'incomplet', formulaVersion: VIAGER_FORMULA_VERSION, missing, notice: VIAGER_NOTICE };
  const value = inputs.marketValue!.value;
  const occupied = inputs.occupied!.value;
  const ages = inputs.headAges!.value;
  const bouquet = inputs.bouquet!.value;
  const rate = inputs.annualRateBp!.value;
  const exp = inputs.expectancies!.value;
  const line = (key: string, v: number, unit: ViagerLine['unit'], hypothesis: string, source = `calcul:viager:v${VIAGER_FORMULA_VERSION}`): ViagerLine => ({
    key,
    value: v,
    unit,
    source,
    asOf,
    hypothesis,
  });
  const lines: ViagerLine[] = [];
  for (const k of VIAGER_INPUT_KEYS) {
    const s = inputs[k]!;
    const v = s.value;
    if (k === 'headAges' || k === 'expectancies') {
      (v as number[]).forEach((x, i) => lines.push(line(`${k}.${i + 1}`, x, k === 'expectancies' ? 'dixiemes_annee' : 'annees', s.hypothesis, s.source)));
      continue;
    }
    lines.push(line(k, typeof v === 'boolean' ? (v ? 1 : 0) : (v as number), k === 'annualRateBp' ? 'bp' : k === 'occupied' ? 'oui_non' : 'cents', s.hypothesis, s.source));
  }
  const longest = Math.max(...exp);
  lines.push(line('expectancyRetained', longest, 'dixiemes_annee', 'rente réversible : la plus longue des espérances des têtes, approchée ; l’expert du viager l’affine'));
  const youngest = Math.min(...ages);
  const usageRight = occupied ? Number(divRound(big(value) * big(usufructPercent(youngest)) * 60n, 10_000n)) : 0;
  lines.push(
    line(
      'usageRight',
      usageRight,
      'cents',
      occupied
        ? `viager occupé : usufruit de ${usufructPercent(youngest)} % à ${youngest} ans (CGI art. 669) × 60 % (CGI art. 762 bis)`
        : 'viager libre : aucun droit d’usage retenu',
    ),
  );
  const occupiedValue = value - usageRight;
  lines.push(line('occupiedValue', occupiedValue, 'cents', 'valeur libre − droit d’usage et d’habitation'));
  const bouquetShare = occupiedValue === 0 ? 0 : Number(divRound(big(bouquet) * 10_000n, big(occupiedValue)));
  lines.push(line('bouquetShareBp', bouquetShare, 'bp', 'bouquet × 10 000 / valeur occupée'));
  const capital = occupiedValue - bouquet;
  lines.push(line('capital', capital, 'cents', 'valeur occupée − bouquet, converti en rente'));
  const months = Number(divRound(big(longest) * 12n, 10n));
  lines.push(line('months', months, 'mois', 'espérance retenue × 12 / 10'));
  const rent = monthlyRent(capital, months, rate);
  lines.push(line('monthlyRent', rent, 'cents', `rente constante sur ${months} mois au taux technique de ${rate} points de base par an, divisé par 12`));
  lines.push(line('rentTotal', rent * months, 'cents', 'rente mensuelle × nombre de mois, sans indexation ni actualisation'));
  return { status: 'complet', formulaVersion: VIAGER_FORMULA_VERSION, lines, bouquetCents: bouquet, monthlyRentCents: rent, months, notice: VIAGER_NOTICE };
}

type Check = { ok: true; value: ViagerInputs } | { ok: false; code: string; field: ViagerInputKey };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const sourced = (v: unknown): v is { value: unknown; source: unknown; asOf: unknown; hypothesis: unknown } =>
  typeof v === 'object' && v !== null && 'value' in v;

/** Contrôle ce que l'agent saisit : listes fermées et nombres bornés ; l'espérance de vie saisie est refusée [R531]. */
export function checkViagerInputs(raw: unknown): Check {
  if (typeof raw !== 'object' || raw === null) return { ok: false, code: 'valeur', field: 'marketValue' };
  const r = raw as Record<string, unknown>;
  if (r.expectancies !== undefined && r.expectancies !== null) return { ok: false, code: 'esperance_saisie', field: 'expectancies' };
  for (const k of Object.keys(r)) if (!(VIAGER_INPUT_KEYS as readonly string[]).includes(k)) return { ok: false, code: 'champ', field: 'marketValue' };
  const out: ViagerInputs = { marketValue: null, occupied: null, headAges: null, bouquet: null, annualRateBp: null, expectancies: null };
  for (const k of TYPED_KEYS) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    if (!sourced(v) || typeof v.hypothesis !== 'string' || v.hypothesis.length < 3 || v.hypothesis.length > 200) return { ok: false, code: 'valeur', field: k };
    const x = v.value;
    const okValue =
      k === 'occupied'
        ? typeof x === 'boolean'
        : k === 'headAges'
          ? Array.isArray(x) && x.length >= 1 && x.length <= 2 && x.every((a) => isInt(a, 40, 110))
          : k === 'annualRateBp'
            ? isInt(x, 0, 1500)
            : isInt(x, 0, 10_000_000_000);
    if (!okValue) return { ok: false, code: 'valeur', field: k };
    if (k === 'marketValue' && (x as number) < 1_000_000) return { ok: false, code: 'valeur', field: k };
    (out as unknown as Record<string, unknown>)[k] = { value: k === 'headAges' ? [...(x as number[])] : x, source: '', asOf: '', hypothesis: v.hypothesis };
  }
  return { ok: true, value: out };
}

export interface LifeTableRow {
  age: number;
  expectancyTenths: number;
}

export interface StoredViager {
  id: string;
  propertyId: string | null;
  projectId: string | null;
  inputs: ViagerInputs;
  result: ViagerResult;
  createdBy: string;
  createdAt: string;
}

export type ViagerRefusal = { ok: false; rule: 'R16' | 'R530' | 'R531' | 'R532'; code: string; field?: ViagerInputKey };
export type ViagerOutcome<T> = { ok: true; value: T } | ViagerRefusal;

/** La mise en relation de M18, telle que le viager s'en sert : l'expert du viager, sur l'accord du client [R532]. */
export interface ExpertViagerRelation {
  propose(
    viewer: Viewer,
    input: { projectId: unknown; trade: unknown; propertyId?: unknown; postcode?: unknown },
  ): Promise<{ ok: true; value: { referralId: string; shown: unknown[] } } | { ok: false; code: string }>;
}

interface ViagerRow {
  id: string;
  property_id: string | null;
  project_id: string | null;
  inputs: string;
  result: string;
  created_by: string;
  created_at: string;
}

const toStored = (row: ViagerRow): StoredViager => ({
  id: row.id,
  propertyId: row.property_id,
  projectId: row.project_id,
  inputs: JSON.parse(row.inputs) as ViagerInputs,
  result: JSON.parse(row.result) as ViagerResult,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export interface ViagerOptions {
  now?: () => Date;
  newId?: () => string;
  relation?: ExpertViagerRelation;
}

export class Viager {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly relation: ExpertViagerRelation | undefined;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ViagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.relation = options.relation;
  }

  private async refuse(viewer: Viewer, rule: ViagerRefusal['rule'], code: string, field?: ViagerInputKey): Promise<ViagerRefusal> {
    await appendEvent(
      this.journal,
      {
        type: rule === 'R16' ? 'acces.refuse' : 'viager.refuse',
        actor: `${String(viewer.role)}:${viewer.userId}`,
        subject: `network:${viewer.networkId}`,
        data: { rule, code, kind: 'viager_calculation', role: String(viewer.role), ...(field ? { field } : {}) },
      },
      this.now,
    );
    return field ? { ok: false, rule, code, field } : { ok: false, rule, code };
  }

  /**
   * La direction importe une table d'espérance de vie, avec sa source et son millésime, pour l'ensemble des deux
   * sexes : une ligne par âge, sans colonne de sexe. Elle ne change plus [R531].
   */
  async importLifeTable(viewer: Viewer, input: { vintage: unknown; source: unknown; rows: unknown }): Promise<ViagerOutcome<{ tableId: string }>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    const { vintage, source, rows } = input;
    if (typeof vintage !== 'string' || !/^[0-9]{4}(?:-[0-9]{4})?$/.test(vintage)) return this.refuse(viewer, 'R531', 'millesime');
    if (typeof source !== 'string' || source.trim().length < 5 || source.length > 300) return this.refuse(viewer, 'R531', 'source');
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 121) return this.refuse(viewer, 'R531', 'lignes');
    const seen = new Set<number>();
    for (const row of rows as unknown[]) {
      if (typeof row !== 'object' || row === null) return this.refuse(viewer, 'R531', 'lignes');
      const keys = Object.keys(row).sort().join(',');
      // Aucune autre colonne que l'âge et l'espérance : ni sexe, ni rien d'autre [R531].
      if (keys !== 'age,expectancyTenths') return this.refuse(viewer, 'R531', 'colonnes');
      const { age, expectancyTenths } = row as LifeTableRow;
      if (!isInt(age, 0, 120) || !isInt(expectancyTenths, 1, 1200) || seen.has(age)) return this.refuse(viewer, 'R531', 'lignes');
      seen.add(age);
    }
    const exists = await this.db.first<{ id: string }>('SELECT id FROM life_tables WHERE network_id = ? AND vintage = ?', [viewer.networkId, vintage]);
    if (exists) return this.refuse(viewer, 'R531', 'deja_importee');
    const id = this.newId();
    const at = this.now().toISOString();
    const statements = [
      {
        sql: 'INSERT INTO life_tables (id, network_id, vintage, source, imported_by, imported_at) VALUES (?, ?, ?, ?, ?, ?)',
        params: [id, viewer.networkId, vintage, source.trim(), `direction:${viewer.userId}`, at],
      },
      ...(rows as LifeTableRow[]).map((r) => ({
        sql: 'INSERT INTO life_table_rows (table_id, age, expectancy_tenths) VALUES (?, ?, ?)',
        params: [id, r.age, r.expectancyTenths],
      })),
    ];
    if (this.db.batch) await this.db.batch(statements);
    else for (const s of statements) await this.db.run(s.sql, s.params);
    await appendEvent(
      this.journal,
      { type: 'viager.table_importee', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { table: id, vintage, rows: rows.length } },
      this.now,
    );
    return { ok: true, value: { tableId: id } };
  }

  /** La table la plus récemment importée du réseau, et l'espérance à chaque âge demandé ; `null` si un âge y manque. */
  private async expectancies(networkId: string, ages: number[]): Promise<Sourced<number[]> | null> {
    const table = await this.db.first<{ id: string; vintage: string; source: string; imported_at: string }>(
      'SELECT id, vintage, source, imported_at FROM life_tables WHERE network_id = ? ORDER BY imported_at DESC, vintage DESC LIMIT 1',
      [networkId],
    );
    if (!table) return null;
    const out: number[] = [];
    for (const age of ages) {
      const row = await this.db.first<{ expectancy_tenths: number }>('SELECT expectancy_tenths FROM life_table_rows WHERE table_id = ? AND age = ?', [table.id, age]);
      if (!row) return null;
      out.push(row.expectancy_tenths);
    }
    return {
      value: out,
      source: `table:${table.id} · ${table.source} · millésime ${table.vintage}`,
      asOf: table.imported_at.slice(0, 10),
      hypothesis: 'espérance de vie à l’âge de chaque tête, ensemble des deux sexes',
    };
  }

  /**
   * L'agent ou la direction calcule un viager pour un bien qu'il voit, ou un projet de sa fiche, ou sans rien rattacher.
   * Ce qu'il saisit porte son nom comme source ; l'espérance de vie vient de la table [R531]. Le calcul est rangé,
   * complet ou incomplet ; un bouquet plus grand que la valeur occupée est refusé [R532].
   */
  async compute(acces: Acces, viewer: Viewer, input: { propertyId?: unknown; projectId?: unknown; inputs: unknown }): Promise<ViagerOutcome<StoredViager>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const propertyId = input.propertyId ?? null;
    const projectId = input.projectId ?? null;
    if (propertyId !== null && typeof propertyId !== 'string') return this.refuse(viewer, 'R16', 'unknown');
    if (projectId !== null && typeof projectId !== 'string') return this.refuse(viewer, 'R16', 'unknown');
    if (propertyId !== null) {
      const read = await acces.readProperty(viewer, propertyId);
      if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
      if (read.value.network_id !== viewer.networkId) return this.refuse(viewer, 'R16', 'unknown');
    }
    if (projectId !== null) {
      const project = await this.db.first<{ person_id: string }>('SELECT person_id FROM projects WHERE id = ? AND network_id = ?', [projectId, viewer.networkId]);
      if (!project) return this.refuse(viewer, 'R16', 'unknown');
      const read = await acces.readFiche(viewer, project.person_id);
      if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
      if (read.view !== 'full') return this.refuse(viewer, 'R16', 'not_assigned');
    }
    const checked = checkViagerInputs(input.inputs);
    if (!checked.ok) return this.refuse(viewer, checked.code === 'esperance_saisie' ? 'R531' : 'R530', checked.code, checked.field);
    const createdAt = this.now().toISOString();
    const inputs: ViagerInputs = { ...checked.value };
    for (const k of TYPED_KEYS) {
      const v = inputs[k];
      if (v !== null) (inputs as unknown as Record<string, unknown>)[k] = { ...v, source: `saisi:${actor}`, asOf: createdAt.slice(0, 10) };
    }
    if (inputs.headAges !== null) inputs.expectancies = await this.expectancies(viewer.networkId, inputs.headAges.value);
    const result = computeViager(inputs, createdAt);
    if (result.status === 'complet' && result.lines.find((l) => l.key === 'capital')!.value < 0) return this.refuse(viewer, 'R532', 'bouquet_trop_haut', 'bouquet');
    const id = this.newId();
    await this.db.run(
      `INSERT INTO viager_calculations (id, network_id, property_id, project_id, inputs, status, result, formula_version, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, propertyId, projectId, JSON.stringify(inputs), result.status, JSON.stringify(result), VIAGER_FORMULA_VERSION, actor, createdAt],
    );
    // Le journal ne garde ni montant ni âge : seulement le calcul et son état.
    await appendEvent(
      this.journal,
      { type: 'viager.calcul', actor, subject: projectId ? `project:${projectId}` : `network:${viewer.networkId}`, data: { calculation: id, status: result.status } },
      this.now,
    );
    return { ok: true, value: { id, propertyId, projectId, inputs, result, createdBy: actor, createdAt } };
  }

  /** Un calcul rangé, relu sous les mêmes droits que son rangement [R16]. */
  async read(acces: Acces, viewer: Viewer, id: unknown): Promise<ViagerOutcome<StoredViager>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    if (typeof id !== 'string') return this.refuse(viewer, 'R16', 'unknown');
    const row = await this.db.first<ViagerRow>('SELECT * FROM viager_calculations WHERE id = ? AND network_id = ?', [id, viewer.networkId]);
    if (!row) return this.refuse(viewer, 'R16', 'unknown');
    const calc = toStored(row);
    if (calc.projectId !== null) {
      const project = await this.db.first<{ person_id: string }>('SELECT person_id FROM projects WHERE id = ? AND network_id = ?', [calc.projectId, viewer.networkId]);
      if (!project) return this.refuse(viewer, 'R16', 'unknown');
      const read = await acces.readFiche(viewer, project.person_id);
      if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
      if (read.view !== 'full') return this.refuse(viewer, 'R16', 'not_assigned');
    }
    if (calc.propertyId !== null) {
      const read = await acces.readProperty(viewer, calc.propertyId);
      if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    }
    if (calc.projectId === null && calc.propertyId === null && viewer.role !== 'direction' && calc.createdBy !== `${String(viewer.role)}:${viewer.userId}`) {
      return this.refuse(viewer, 'R16', 'not_assigned');
    }
    return { ok: true, value: calc };
  }

  /**
   * Rejoue un calcul rangé depuis ses entrées, et relit la table d'espérance citée : le résultat doit être identique au
   * caractère près, et la table la même [R530, R531].
   */
  async replay(networkId: string, id: string): Promise<{ same: boolean; result: ViagerResult } | null> {
    const row = await this.db.first<ViagerRow>('SELECT * FROM viager_calculations WHERE id = ? AND network_id = ?', [id, networkId]);
    if (!row) return null;
    const inputs = JSON.parse(row.inputs) as ViagerInputs;
    const result = computeViager(inputs, row.created_at);
    let tableSame = true;
    if (inputs.expectancies !== null && inputs.headAges !== null) {
      const tableId = /^table:([^ ]+) /.exec(inputs.expectancies.source)?.[1] ?? '';
      for (const [i, age] of inputs.headAges.value.entries()) {
        const r = await this.db.first<{ expectancy_tenths: number }>('SELECT expectancy_tenths FROM life_table_rows WHERE table_id = ? AND age = ?', [tableId, age]);
        if (!r || r.expectancy_tenths !== inputs.expectancies.value[i]) tableSame = false;
      }
    }
    return { same: tableSame && JSON.stringify(result) === row.result, result };
  }

  /**
   * Propose l'expert du viager de M18 pour le projet du calcul, par la mise en relation de M18 : le client choisit, son
   * accord est rangé là, rien ne part d'ici [R532].
   */
  async proposeExpert(acces: Acces, viewer: Viewer, id: unknown, postcode?: unknown): Promise<ViagerOutcome<{ referralId: string }>> {
    const calc = await this.read(acces, viewer, id);
    if (!calc.ok) return calc;
    if (!this.relation) return this.refuse(viewer, 'R532', 'relation_absente');
    if (calc.value.projectId === null) return this.refuse(viewer, 'R532', 'sans_projet');
    const r = await this.relation.propose(viewer, {
      projectId: calc.value.projectId,
      trade: 'expert_viager',
      ...(calc.value.propertyId ? { propertyId: calc.value.propertyId } : {}),
      ...(postcode !== undefined ? { postcode } : {}),
    });
    if (!r.ok) return this.refuse(viewer, 'R532', r.code);
    return { ok: true, value: { referralId: r.value.referralId } };
  }
}
