/**
 * La fiche du commerce (M16, CE01) : la fiche d'un bien de sorte `business` (fonds de commerce ou droit au bail),
 * `business_walls` (murs) ou `commercial` (local professionnel), versionnée. Une modification ajoute une version,
 * l'ancienne reste lisible et ne change plus [R17].
 *
 * Chaque colonne est classée « public » ou « confidentiel » par une seule table, `SHEET_VISIBILITY` ; une colonne qui
 * n'y figure pas est confidentielle [R110]. Seules l'activité (liste fermée) et, sur le bien, la sorte, la commune, le
 * code postal et la surface sont publiques. L'enseigne, les exercices, le bail, les salariés, le matériel et les
 * autorisations sont confidentiels : la vue publique (`publicView`) ne les lit jamais, quoi que porte la fiche
 * [R110, R09]. Le prix du bien n'y est pas non plus : la fourchette publique viendra de l'estimation validée (CE02).
 *
 * Seuls l'agent du bien et la direction écrivent la fiche ; elle se lit en entier quand le bien se voit en entier
 * (son agent, la direction, la conformité) [R16]. Un champ inconnu ou une valeur hors liste est refusé, jamais
 * ignoré. Le journal ne porte que les noms des champs changés, jamais leur valeur [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Property, PropertyKind } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Les sortes de biens que M16 traite. */
export const BUSINESS_KINDS: readonly PropertyKind[] = ['business', 'business_walls', 'commercial'];

/** L'activité, liste fermée : la seule donnée publique propre au commerce. */
export const ACTIVITIES = [
  'boulangerie_patisserie',
  'boucherie_charcuterie',
  'alimentation',
  'restaurant',
  'bar_cafe',
  'tabac_presse',
  'hotel',
  'coiffure_esthetique',
  'pharmacie',
  'habillement',
  'fleuriste',
  'automobile',
  'commerce_de_detail',
  'services',
  'artisanat',
  'bureaux',
  'local_activite',
  'entrepot',
  'autre',
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** La destination du bail commercial. */
export const LEASE_USES = ['all_trades', 'named_activity', 'named_and_related'] as const;
export type LeaseUse = (typeof LEASE_USES)[number];

/** La clause de cession du bail. */
/** L'indice de révision du loyer du bail (AU101) : loyers commerciaux, activités tertiaires, coût de la construction, aucun. */
export const LEASE_INDEXES = ['ilc', 'ilat', 'icc', 'aucun'] as const;
export type LeaseIndex = (typeof LEASE_INDEXES)[number];

export const LEASE_ASSIGNMENTS = ['free', 'landlord_approval', 'with_business_only'] as const;
export type LeaseAssignment = (typeof LEASE_ASSIGNMENTS)[number];

/** Les autorisations propres à l'activité, liste fermée. */
export const LICENSES = [
  'licence_restaurant',
  'petite_licence_restaurant',
  'licence_3',
  'licence_4',
  'licence_a_emporter',
  'debit_de_tabac',
  'terrasse',
  'agrement_sanitaire',
  'officine',
  'autre',
] as const;
export type License = (typeof LICENSES)[number];

/** Un exercice : année de clôture, chiffre d'affaires, résultat et, s'il est saisi, excédent brut d'exploitation, en centimes. */
export interface FiscalYear {
  year: number;
  revenueCents: number;
  resultCents: number;
  ebitdaCents?: number;
}

/** La fiche, et seulement ces champs. */
export interface BusinessSheet {
  activity: Activity | null;
  signName: string | null;
  /** Les 3 derniers exercices au plus, du plus récent au plus ancien. */
  fiscalYears: FiscalYear[];
  leaseStart: string | null;
  leaseYears: number | null;
  leaseAnnualRentCents: number | null;
  /** Local ou murs libres (AU102) : la valeur locative annuelle de marché, en centimes, et ce qui la fonde. */
  marketAnnualRentCents: number | null;
  marketRentBasis: string | null;
  leaseUse: LeaseUse | null;
  leaseAssignment: LeaseAssignment | null;
  leaseIndex: LeaseIndex | null;
  employees: number | null;
  equipment: string[];
  licenses: License[];
}
export type SheetField = keyof BusinessSheet;

export const SHEET_FIELDS: readonly SheetField[] = [
  'activity',
  'signName',
  'fiscalYears',
  'leaseStart',
  'leaseYears',
  'leaseAnnualRentCents',
  'marketAnnualRentCents',
  'marketRentBasis',
  'leaseUse',
  'leaseAssignment',
  'leaseIndex',
  'employees',
  'equipment',
  'licenses',
];

export type Visibility = 'public' | 'confidential';

/**
 * Le classement de chaque colonne de `business_sheets`, seul endroit où il se décide [R110]. Les colonnes techniques
 * (identifiants, version, sources, auteur, date) ne sont jamais publiées non plus.
 */
export const SHEET_VISIBILITY: Readonly<Record<string, Visibility>> = Object.freeze({
  id: 'confidential',
  network_id: 'confidential',
  property_id: 'confidential',
  version: 'confidential',
  activity: 'public',
  sign_name: 'confidential',
  fiscal_years: 'confidential',
  lease_start: 'confidential',
  lease_years: 'confidential',
  lease_annual_rent_cents: 'confidential',
  market_annual_rent_cents: 'confidential',
  market_rent_basis: 'confidential',
  lease_use: 'confidential',
  lease_assignment: 'confidential',
  lease_index: 'confidential',
  employees: 'confidential',
  equipment: 'confidential',
  licenses: 'confidential',
  sources: 'confidential',
  author: 'confidential',
  created_at: 'confidential',
});

/** Les colonnes du bien lui-même qui sont publiques ; toutes les autres (référence, agent, prix…) ne le sont pas. */
export const PUBLIC_PROPERTY_COLUMNS: readonly string[] = ['kind', 'city', 'postal_code', 'surface_m2'];

/** Le classement d'une colonne : confidentielle si elle n'est pas classée [R110]. */
export function visibilityOf(column: string): Visibility {
  return Object.prototype.hasOwnProperty.call(SHEET_VISIBILITY, column) ? SHEET_VISIBILITY[column]! : 'confidential';
}

/** Ce qui peut sortir en public d'un commerce, et rien d'autre [R110]. */
export interface BusinessPublicView {
  kind: PropertyKind;
  activity: Activity | null;
  city: string | null;
  postalCode: string | null;
  surfaceM2: number | null;
}

export type SheetRefusal = {
  ok: false;
  rule: 'R110' | 'R16' | null;
  /** `champ_inconnu`, `hors_liste`, `valeur`, `sorte`, ou un code d'accès. */
  code: string;
  field?: SheetField;
};
export type SheetCheck = { ok: true; value: Partial<BusinessSheet> } | SheetRefusal;

const refuse = (code: string, field?: SheetField, rule: SheetRefusal['rule'] = null): SheetRefusal =>
  field === undefined ? { ok: false, rule, code } : { ok: false, rule, code, field };

const MAX_CENTS = 10_000_000_000_000;
const INT_LIMITS: Partial<Record<SheetField, [number, number]>> = {
  leaseYears: [1, 99],
  leaseAnnualRentCents: [0, 100_000_000_000],
  marketAnnualRentCents: [1, 100_000_000_000],
  employees: [0, 100_000],
};
const LISTS: Partial<Record<SheetField, readonly string[]>> = {
  activity: ACTIVITIES,
  leaseUse: LEASE_USES,
  leaseAssignment: LEASE_ASSIGNMENTS,
  leaseIndex: LEASE_INDEXES,
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const isDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};

function checkFiscalYears(value: unknown): FiscalYear[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const out: FiscalYear[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const keys = Object.keys(item);
    if (!['year', 'revenueCents', 'resultCents'].every((k) => keys.includes(k))) return null;
    if (keys.some((k) => !['year', 'revenueCents', 'resultCents', 'ebitdaCents'].includes(k))) return null;
    const { year, revenueCents, resultCents, ebitdaCents } = item as Record<string, unknown>;
    if (!isInt(year, 2000, 2100) || !isInt(revenueCents, 0, MAX_CENTS) || !isInt(resultCents, -MAX_CENTS, MAX_CENTS)) return null;
    if (ebitdaCents !== undefined && !isInt(ebitdaCents, -MAX_CENTS, MAX_CENTS)) return null;
    if (out.some((y) => y.year === year)) return null;
    out.push(ebitdaCents === undefined ? { year, revenueCents, resultCents } : { year, revenueCents, resultCents, ebitdaCents });
  }
  return out.sort((a, b) => b.year - a.year);
}

/**
 * Contrôle d'une modification de la fiche : seulement des champs prévus, des valeurs prises dans leur liste fermée,
 * des entiers bornés. `null` retire un champ ; une liste vide aussi. Un champ inconnu est refusé, jamais ignoré : il
 * ne pourrait pas être classé [R110].
 */
export function checkSheetChanges(input: unknown): SheetCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuse('valeur');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return refuse('valeur');
  for (const [key] of entries) if (!(SHEET_FIELDS as readonly string[]).includes(key)) return refuse('champ_inconnu', undefined, 'R110');
  const out: Partial<Record<SheetField, unknown>> = {};
  for (const [key, value] of entries) {
    const field = key as SheetField;
    if (field === 'fiscalYears' || field === 'equipment' || field === 'licenses') {
      if (value === null) {
        out[field] = [];
        continue;
      }
      if (field === 'fiscalYears') {
        const years = checkFiscalYears(value);
        if (!years) return refuse('valeur', field);
        out[field] = years;
        continue;
      }
      if (!Array.isArray(value) || value.length > 30) return refuse('valeur', field);
      const kept: string[] = [];
      for (const v of value) {
        if (typeof v !== 'string') return refuse('valeur', field);
        const item = v.trim();
        if (field === 'licenses' && !(LICENSES as readonly string[]).includes(item)) return refuse('hors_liste', field);
        if (field === 'equipment' && (item.length === 0 || item.length > 80)) return refuse('valeur', field);
        if (!kept.includes(item)) kept.push(item);
      }
      out[field] = kept;
      continue;
    }
    if (value === null) {
      out[field] = null;
      continue;
    }
    const limits = INT_LIMITS[field];
    if (limits) {
      if (!isInt(value, limits[0], limits[1])) return refuse('valeur', field);
      out[field] = value;
      continue;
    }
    const list = LISTS[field];
    if (list) {
      if (typeof value !== 'string' || !list.includes(value)) return refuse('hors_liste', field);
      out[field] = value;
      continue;
    }
    if (field === 'leaseStart') {
      if (!isDay(value)) return refuse('valeur', field);
      out[field] = value;
      continue;
    }
    // signName, marketRentBasis : la base d'une valeur locative dit ses comparables, 5 à 300 caractères.
    const max = field === 'marketRentBasis' ? 300 : 120;
    const min = field === 'marketRentBasis' ? 5 : 1;
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) return refuse('valeur', field);
    out[field] = value.trim();
  }
  return { ok: true, value: out as Partial<BusinessSheet> };
}

export interface BusinessSheetRow {
  id: string;
  network_id: string;
  property_id: string;
  version: number;
  activity: Activity | null;
  sign_name: string | null;
  fiscal_years: string;
  lease_start: string | null;
  lease_years: number | null;
  lease_annual_rent_cents: number | null;
  market_annual_rent_cents: number | null;
  market_rent_basis: string | null;
  lease_use: LeaseUse | null;
  lease_assignment: LeaseAssignment | null;
  lease_index: LeaseIndex | null;
  employees: number | null;
  equipment: string;
  licenses: string;
  sources: string;
  author: string;
  created_at: string;
}

export interface BusinessSheetVersion {
  id: string;
  propertyId: string;
  version: number;
  sheet: BusinessSheet;
  /** Champ → `agent:<id>` ou `direction:<id>`. */
  sources: Partial<Record<SheetField, string>>;
  author: string;
  createdAt: string;
}

export const EMPTY_SHEET: Readonly<BusinessSheet> = Object.freeze({
  activity: null,
  signName: null,
  fiscalYears: [],
  leaseStart: null,
  leaseYears: null,
  leaseAnnualRentCents: null,
  marketAnnualRentCents: null,
  marketRentBasis: null,
  leaseUse: null,
  leaseAssignment: null,
  leaseIndex: null,
  employees: null,
  equipment: [],
  licenses: [],
});

/**
 * Une colonne JSON rangée par ce module. Illisible, elle n'est jamais remplacée par une liste vide : la version
 * suivante l'écraserait et la donnée serait perdue [R17]. L'erreur remonte.
 */
function parseJson<T>(json: string, column: string, keep: (v: unknown) => boolean): T {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`fiche du commerce : colonne ${column} illisible`);
  }
  if (!keep(value)) throw new Error(`fiche du commerce : colonne ${column} illisible`);
  return value as T;
}

export function toSheetVersion(row: BusinessSheetRow): BusinessSheetVersion {
  return {
    id: row.id,
    propertyId: row.property_id,
    version: row.version,
    sheet: {
      activity: row.activity,
      signName: row.sign_name,
      fiscalYears: parseJson<FiscalYear[]>(row.fiscal_years, 'fiscal_years', Array.isArray),
      leaseStart: row.lease_start,
      leaseYears: row.lease_years,
      leaseAnnualRentCents: row.lease_annual_rent_cents,
      marketAnnualRentCents: row.market_annual_rent_cents ?? null,
      marketRentBasis: row.market_rent_basis ?? null,
      leaseUse: row.lease_use,
      leaseAssignment: row.lease_assignment,
      leaseIndex: row.lease_index ?? null,
      employees: row.employees,
      equipment: parseJson<string[]>(row.equipment, 'equipment', Array.isArray),
      licenses: parseJson<License[]>(row.licenses, 'licenses', Array.isArray),
    },
    sources: parseJson<Partial<Record<SheetField, string>>>(row.sources, 'sources', (v) => typeof v === 'object' && v !== null && !Array.isArray(v)),
    author: row.author,
    createdAt: row.created_at,
  };
}

export type SheetResult = { ok: true; created: boolean; value: BusinessSheetVersion | null } | SheetRefusal;

export interface FicheCommerceOptions {
  now?: () => Date;
  newId?: () => string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class FicheCommerce {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: FicheCommerceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** La dernière version, sans contrôle d'accès : pour le code du système (estimation, porte de confidentialité). */
  async current(propertyId: string): Promise<BusinessSheetVersion | null> {
    const row = await this.db.first<BusinessSheetRow>('SELECT * FROM business_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    return row ? toSheetVersion(row) : null;
  }

  /**
   * La vue publique d'un commerce : la sorte, la commune, le code postal, la surface et l'activité, rien d'autre
   * [R110]. Elle est construite colonne par colonne depuis les seules colonnes publiques, jamais en retirant des
   * champs d'une fiche complète. `null` pour un bien qui n'est pas un commerce.
   */
  async publicView(propertyId: string): Promise<BusinessPublicView | null> {
    const property = await this.db.first<Pick<Property, 'kind' | 'city' | 'postal_code' | 'surface_m2'>>(
      'SELECT kind, city, postal_code, surface_m2 FROM properties WHERE id = ?',
      [propertyId],
    );
    if (!property || !BUSINESS_KINDS.includes(property.kind)) return null;
    const sheet = await this.db.first<{ activity: Activity | null }>(
      'SELECT activity FROM business_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1',
      [propertyId],
    );
    const activity = sheet?.activity ?? null;
    return {
      kind: property.kind,
      activity: activity !== null && (ACTIVITIES as readonly string[]).includes(activity) ? activity : null,
      city: property.city,
      postalCode: property.postal_code,
      surfaceM2: property.surface_m2,
    };
  }

  /**
   * Les commerces de l'écran : pour un agent, les siens ; pour la direction et la conformité, ceux du réseau. Rien de
   * confidentiel : la référence, la sorte, la commune [R16, R110].
   */
  async list(viewer: Viewer): Promise<{ ok: true; value: { propertyId: string; reference: string; kind: PropertyKind; city: string | null }[] } | SheetRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction' && viewer.role !== 'compliance') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'business_sheet', code: 'role' } }, this.now);
      return refuse('role', undefined, 'R16');
    }
    const own = viewer.role === 'agent';
    const rows = await this.db.all<{ id: string; reference: string; kind: PropertyKind; city: string | null }>(
      `SELECT id, reference, kind, city FROM properties WHERE network_id = ? AND kind IN (${BUSINESS_KINDS.map(() => '?').join(', ')}) ${own ? 'AND agent_id = ?' : ''} ORDER BY reference, id LIMIT 200`,
      [viewer.networkId, ...BUSINESS_KINDS, ...(own ? [viewer.userId] : [])],
    );
    return { ok: true, value: rows.map((r) => ({ propertyId: r.id, reference: r.reference, kind: r.kind, city: r.city })) };
  }

  /** La fiche et toutes ses versions, pour qui voit le bien en entier [R16]. */
  async read(
    acces: Acces,
    viewer: Viewer,
    propertyId: string,
  ): Promise<{ ok: true; value: { current: BusinessSheetVersion | null; history: BusinessSheetVersion[] } } | SheetRefusal> {
    const property = await this.allowed(acces, viewer, propertyId);
    if (!('id' in property)) return property;
    const rows = await this.db.all<BusinessSheetRow>('SELECT * FROM business_sheets WHERE property_id = ? ORDER BY version', [propertyId]);
    const history = rows.map(toSheetVersion);
    return { ok: true, value: { current: history.at(-1) ?? null, history } };
  }

  /**
   * L'agent du bien ou la direction modifie la fiche : une nouvelle version, l'ancienne gardée [R17]. Un champ
   * inconnu ou hors liste est refusé, le refus va au journal sans la valeur [R13].
   */
  async update(acces: Acces, viewer: Viewer, propertyId: string, input: unknown): Promise<SheetResult> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      // La conformité lit, elle n'écrit pas la fiche ; la lecture permise ou refusée va au journal.
      await acces.readProperty(viewer, propertyId);
      return this.refused(viewer, propertyId, 'role');
    }
    const property = await this.allowed(acces, viewer, propertyId);
    if (!('id' in property)) return property;
    const author = `${viewer.role}:${viewer.userId}`;
    const checked = checkSheetChanges(input);
    if (!checked.ok) {
      await appendEvent(
        this.journal,
        {
          type: 'commerces.fiche.refuse',
          actor: author,
          subject: `property:${propertyId}`,
          data: { rule: checked.rule, code: checked.code, ...(checked.field ? { field: checked.field } : {}) },
        },
        this.now,
      );
      return checked;
    }
    return this.addVersion(property, author, checked.value);
  }

  /** Ajoute une version si quelque chose change ; deux écritures simultanées ne prennent jamais le même numéro. */
  private async addVersion(property: Property, author: string, changes: Partial<BusinessSheet>): Promise<SheetResult> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.current(property.id);
      const previous: BusinessSheet = last ? last.sheet : { ...EMPTY_SHEET, fiscalYears: [], equipment: [], licenses: [] };
      const sources: Partial<Record<SheetField, string>> = last ? { ...last.sources } : {};
      const next: BusinessSheet = { ...previous };
      const changed: SheetField[] = [];
      for (const field of SHEET_FIELDS) {
        if (!(field in changes)) continue;
        const value = changes[field];
        if (same(value, previous[field])) continue;
        (next as unknown as Record<string, unknown>)[field] = value;
        changed.push(field);
        sources[field] = author;
      }
      if (changed.length === 0) return { ok: true, created: false, value: last };
      const version = (last?.version ?? 0) + 1;
      const id = this.newId();
      const { changes: inserted } = await this.db.run(
        `INSERT INTO business_sheets (id, network_id, property_id, version, activity, sign_name, fiscal_years, lease_start,
           lease_years, lease_annual_rent_cents, market_annual_rent_cents, market_rent_basis, lease_use, lease_assignment, lease_index, employees, equipment, licenses, sources, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [
          id,
          property.network_id,
          property.id,
          version,
          next.activity,
          next.signName,
          JSON.stringify(next.fiscalYears),
          next.leaseStart,
          next.leaseYears,
          next.leaseAnnualRentCents,
          next.marketAnnualRentCents,
          next.marketRentBasis,
          next.leaseUse,
          next.leaseAssignment,
          next.leaseIndex,
          next.employees,
          JSON.stringify(next.equipment),
          JSON.stringify(next.licenses),
          JSON.stringify(sources),
          author,
          this.now().toISOString(),
        ],
      );
      if (inserted !== 1) continue;
      await appendEvent(
        this.journal,
        { type: 'commerces.fiche', actor: author, subject: `property:${property.id}`, data: { version, fields: changed } },
        this.now,
      );
      const row = await this.db.first<BusinessSheetRow>('SELECT * FROM business_sheets WHERE id = ?', [id]);
      return { ok: true, created: true, value: row ? toSheetVersion(row) : null };
    }
    throw new Error('fiche du commerce : trop d’écritures simultanées');
  }

  /** Le bien, s'il est un commerce et se voit en entier ; sinon le refus, au journal [R16]. */
  private async allowed(acces: Acces, viewer: Viewer, propertyId: string): Promise<Property | SheetRefusal> {
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return refuse(read.code, undefined, 'R16');
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    if (!BUSINESS_KINDS.includes(read.value.kind)) return refuse('sorte');
    return read.value;
  }

  private async refused(viewer: Viewer, propertyId: string, code: string): Promise<SheetRefusal> {
    await appendEvent(
      this.journal,
      {
        type: 'acces.refuse',
        actor: `${String(viewer.role)}:${viewer.userId}`,
        subject: `property:${propertyId}`,
        data: { rule: 'R16', role: String(viewer.role), kind: 'business_sheet', code },
      },
      this.now,
    );
    return refuse(code, undefined, 'R16');
  }
}

/** Le même jour, `years` années plus tard ; un 29 février sans équivalent devient le 28. */
export function addYears(day: string, years: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${String(y + years).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Le même jour, `months` mois plus tôt ; un jour sans équivalent devient le dernier du mois. */
export function minusMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** La veille d'un jour. */
function dayBefore(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface LeaseMilestones {
  /** La prochaine échéance triennale à venir avant la fin du bail, ou `null` : le dernier jour de la période de 3 ans. */
  nextTriennial: string | null;
  /** Le dernier jour pour donner congé à cette échéance : six mois avant (code de commerce, art. L145-4 et L145-9). */
  triennialNoticeBy: string | null;
  leaseEnd: string;
  endNoticeBy: string;
  /** Le bail est arrivé à son terme : il se prolonge tacitement tant qu'aucun congé n'est donné. */
  ended: boolean;
}

/**
 * Les dates utiles d'un bail commercial (AU101), par le code seul depuis son début et sa durée : échéances triennales,
 * fin, et le jour limite de chaque congé. `null` sans début ou sans durée : rien n'est deviné [R10].
 */
export function leaseMilestones(sheet: Pick<BusinessSheet, 'leaseStart' | 'leaseYears'>, today: string): LeaseMilestones | null {
  if (!sheet.leaseStart || sheet.leaseYears === null) return null;
  // Le bail couvre ses années jour pour jour : il expire la veille de l'anniversaire (2014-07-01 sur 9 ans : 2023-06-30).
  const leaseEnd = dayBefore(addYears(sheet.leaseStart, sheet.leaseYears));
  let nextTriennial: string | null = null;
  for (let k = 3; k < sheet.leaseYears; k += 3) {
    const at = dayBefore(addYears(sheet.leaseStart, k));
    if (at >= today) {
      nextTriennial = at;
      break;
    }
  }
  return {
    nextTriennial,
    triennialNoticeBy: nextTriennial ? minusMonths(nextTriennial, 6) : null,
    leaseEnd,
    endNoticeBy: minusMonths(leaseEnd, 6),
    ended: leaseEnd < today,
  };
}
