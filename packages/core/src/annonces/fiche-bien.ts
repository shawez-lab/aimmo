/**
 * Fiche du bien complète (M07, P01).
 *
 * Ce qu'il faut savoir d'un bien pour le mettre en vente, en plus de sa fiche de base (type, surface, pièces, ville) :
 * caractéristiques, diagnostic énergétique, copropriété, risques, photos et vidéos. Chaque enregistrement crée une
 * version complète ; les versions d'avant restent lisibles et rien ne s'efface [R17].
 *
 * Décidé, lecture prudente : la fiche ne porte aucun texte libre. Que des nombres, des classes et des listes fermées,
 * pour qu'aucune adresse exacte ni aucun nom n'y entre [R19, R46] et que l'annonce de P03 ne puisse citer que des
 * faits contrôlés [R47]. Les photos et vidéos sont rangées par leur référence de stockage, avec leur état de retouche.
 * Un champ inconnu est refusé, jamais ignoré. Seuls l'agent du bien et la direction écrivent ; l'agent du bien, la
 * direction et la conformité lisent [R16].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';

export const ENERGY_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type EnergyClass = (typeof ENERGY_CLASSES)[number];

export const HEATING_KINDS = ['individuel_gaz', 'individuel_electrique', 'collectif', 'pompe_a_chaleur', 'bois', 'fioul', 'autre'] as const;
export type HeatingKind = (typeof HEATING_KINDS)[number];

export const OUTDOOR_KINDS = ['balcon', 'terrasse', 'jardin', 'cour'] as const;
export type OutdoorKind = (typeof OUTDOOR_KINDS)[number];

export const MEDIA_KINDS = ['photo', 'video', 'visite_virtuelle'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** `aucune` : image brute ; `lumiere_cadrage` : seules la lumière et le cadrage corrigés ; `amenagement_virtuel` : modifiée. */
export const MEDIA_EDITS = ['aucune', 'lumiere_cadrage', 'amenagement_virtuel'] as const;
export type MediaEdit = (typeof MEDIA_EDITS)[number];

export interface Characteristics {
  bedrooms: number | null;
  /** 0 pour le rez-de-chaussée. */
  floor: number | null;
  floorsTotal: number | null;
  buildYear: number | null;
  heating: HeatingKind | null;
  outdoor: OutdoorKind[];
  landM2: number | null;
  parkingSpaces: number | null;
  elevator: boolean | null;
}

/**
 * La période des prix de l'énergie, dans les mots du diagnostic : « au 1er janvier 2021 » pour une année, « sur les
 * années 2021, 2022 et 2023 » quand il en cite plusieurs (modèle de DPE du 1er juillet 2024) (AU065).
 */
export function energyPriceText(e: { costReferenceYear: number; costReferenceYears?: number[] | null }): string {
  const ys = e.costReferenceYears ?? [];
  const when = ys.length > 1 ? `sur les années ${ys.slice(0, -1).join(', ')} et ${ys.at(-1)}` : `au 1er janvier ${e.costReferenceYear}`;
  return `Prix moyens des énergies indexés ${when} (abonnements compris).`;
}

export interface EnergyDiagnosis {
  energyClass: EnergyClass;
  climateClass: EnergyClass;
  annualCostMinEur: number;
  annualCostMaxEur: number;
  /** L'année des prix de l'énergie utilisés par le diagnostic ; s'il en cite plusieurs, la dernière. */
  costReferenceYear: number;
  /**
   * Les années des prix quand le diagnostic en cite plusieurs, telles qu'il les écrit (« indexés sur les années 2021,
   * 2022 et 2023 ») : de 2 à 5 années qui se suivent, la dernière étant `costReferenceYear` (AU065).
   */
  costReferenceYears?: number[];
  /** `AAAA-MM-JJ`. */
  diagnosedOn: string;
}

export type Coownership =
  | { isCoownership: false }
  | { isCoownership: true; lots: number; annualChargesEur: number; proceedings: boolean };

export interface Media {
  /** Référence de stockage : `biens/<id du bien>/<identifiant tiré au hasard>.<jpg|png|webp|mp4>`. */
  ref: string;
  kind: MediaKind;
  edit: MediaEdit;
}

export interface PropertySheet {
  characteristics: Characteristics;
  /** null tant que le diagnostic n'est pas fait : aucune publication possible [R45]. */
  energy: EnergyDiagnosis | null;
  /** null tant qu'on ne sait pas. */
  coownership: Coownership | null;
  /** null tant qu'on ne sait pas ; true : le bien est en zone concernée par un risque. */
  risks: { inRiskZone: boolean } | null;
  media: Media[];
}

export interface SheetVersion {
  propertyId: string;
  version: number;
  sheet: PropertySheet;
  createdBy: string;
  createdAt: string;
}

export type SheetProblem = { ok: false; rule: null; code: 'invalid'; field: string } | { ok: false; rule: null; code: 'unknown_property' | 'no_sheet' | 'unknown_version' | 'busy' | 'stale' };
type Refusal = { ok: false; rule: 'R16'; code: string };

const MAX_MEDIA = 80;
// La référence est donnée par le stockage, jamais écrite à la main : le dossier du bien, puis un identifiant tiré au
// hasard. Aucun nom de fichier libre, qui pourrait porter une adresse [R46], ni la photo d'un autre bien.
const MEDIA_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp|mp4)$/;
const MEDIA_EXT: Record<MediaKind, readonly string[]> = { photo: ['jpg', 'png', 'webp'], video: ['mp4'], visite_virtuelle: ['mp4'] };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(v: Record<string, unknown>, keys: readonly string[], path: string): string | null {
  for (const k of Object.keys(v)) if (!keys.includes(k)) return path ? `${path}.${k}` : k;
  return null;
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function intOrNull(v: unknown, min: number, max: number): { ok: boolean; value: number | null } {
  if (v === null || v === undefined) return { ok: true, value: null };
  return isInt(v, min, max) ? { ok: true, value: v } : { ok: false, value: null };
}

function validDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Contrôle une fiche saisie, champ par champ. Le premier champ fautif est nommé. */
export function parseSheet(input: unknown, today: Date, propertyId: string): Parsed<PropertySheet> {
  const bad = (field: string): Parsed<PropertySheet> => ({ ok: false, field });
  if (!isRecord(input)) return bad('fiche');
  const extra = onlyKeys(input, ['characteristics', 'energy', 'coownership', 'risks', 'media'], '');
  if (extra) return bad(extra);
  const year = Number(localTime(today, TIME_ZONE).date.slice(0, 4));
  const todayDay = localTime(today, TIME_ZONE).date;

  // Caractéristiques.
  const c = input.characteristics ?? {};
  if (!isRecord(c)) return bad('characteristics');
  const cExtra = onlyKeys(c, ['bedrooms', 'floor', 'floorsTotal', 'buildYear', 'heating', 'outdoor', 'landM2', 'parkingSpaces', 'elevator'], 'characteristics');
  if (cExtra) return bad(cExtra);
  const bedrooms = intOrNull(c.bedrooms, 0, 50);
  if (!bedrooms.ok) return bad('characteristics.bedrooms');
  const floor = intOrNull(c.floor, -5, 100);
  if (!floor.ok) return bad('characteristics.floor');
  const floorsTotal = intOrNull(c.floorsTotal, 0, 100);
  if (!floorsTotal.ok) return bad('characteristics.floorsTotal');
  if (floor.value !== null && floorsTotal.value !== null && floor.value > floorsTotal.value) return bad('characteristics.floor');
  const buildYear = intOrNull(c.buildYear, 1000, year);
  if (!buildYear.ok) return bad('characteristics.buildYear');
  const heating = c.heating ?? null;
  if (heating !== null && !(HEATING_KINDS as readonly unknown[]).includes(heating)) return bad('characteristics.heating');
  const outdoorRaw = c.outdoor ?? [];
  if (!Array.isArray(outdoorRaw) || outdoorRaw.some((o) => !(OUTDOOR_KINDS as readonly unknown[]).includes(o)) || new Set(outdoorRaw).size !== outdoorRaw.length) return bad('characteristics.outdoor');
  const landM2 = intOrNull(c.landM2, 1, 10_000_000);
  if (!landM2.ok) return bad('characteristics.landM2');
  const parking = intOrNull(c.parkingSpaces, 0, 500);
  if (!parking.ok) return bad('characteristics.parkingSpaces');
  const elevator = c.elevator ?? null;
  if (elevator !== null && typeof elevator !== 'boolean') return bad('characteristics.elevator');
  const characteristics: Characteristics = {
    bedrooms: bedrooms.value,
    floor: floor.value,
    floorsTotal: floorsTotal.value,
    buildYear: buildYear.value,
    heating: heating as HeatingKind | null,
    // Rangés dans l'ordre de la liste fermée : deux saisies équivalentes donnent la même fiche.
    outdoor: OUTDOOR_KINDS.filter((o) => (outdoorRaw as unknown[]).includes(o)),
    landM2: landM2.value,
    parkingSpaces: parking.value,
    elevator: elevator as boolean | null,
  };

  // Diagnostic énergétique.
  let energy: EnergyDiagnosis | null = null;
  if (input.energy !== null && input.energy !== undefined) {
    const e = input.energy;
    if (!isRecord(e)) return bad('energy');
    const eExtra = onlyKeys(e, ['energyClass', 'climateClass', 'annualCostMinEur', 'annualCostMaxEur', 'costReferenceYear', 'costReferenceYears', 'diagnosedOn'], 'energy');
    if (eExtra) return bad(eExtra);
    if (!(ENERGY_CLASSES as readonly unknown[]).includes(e.energyClass)) return bad('energy.energyClass');
    if (!(ENERGY_CLASSES as readonly unknown[]).includes(e.climateClass)) return bad('energy.climateClass');
    if (!isInt(e.annualCostMinEur, 1, 1_000_000)) return bad('energy.annualCostMinEur');
    if (!isInt(e.annualCostMaxEur, 1, 1_000_000)) return bad('energy.annualCostMaxEur');
    if (e.annualCostMinEur > e.annualCostMaxEur) return bad('energy.annualCostMinEur');
    if (!isInt(e.costReferenceYear, 2000, year)) return bad('energy.costReferenceYear');
    // Plusieurs années : celles du diagnostic, qui se suivent, la dernière étant l'année des prix (AU065).
    const years = e.costReferenceYears;
    if (years !== undefined && years !== null) {
      if (!Array.isArray(years) || years.length < 2 || years.length > 5 || !years.every((y, i) => isInt(y, 2000, year) && (i === 0 || y === years[i - 1] + 1)) || years.at(-1) !== e.costReferenceYear) {
        return bad('energy.costReferenceYears');
      }
    }
    if (!validDay(e.diagnosedOn) || e.diagnosedOn > todayDay) return bad('energy.diagnosedOn');
    energy = {
      energyClass: e.energyClass as EnergyClass,
      climateClass: e.climateClass as EnergyClass,
      annualCostMinEur: e.annualCostMinEur,
      annualCostMaxEur: e.annualCostMaxEur,
      costReferenceYear: e.costReferenceYear,
      ...(Array.isArray(years) ? { costReferenceYears: [...(years as number[])] } : {}),
      diagnosedOn: e.diagnosedOn,
    };
  }

  // Copropriété.
  let coownership: Coownership | null = null;
  if (input.coownership !== null && input.coownership !== undefined) {
    const k = input.coownership;
    if (!isRecord(k) || typeof k.isCoownership !== 'boolean') return bad('coownership.isCoownership');
    if (k.isCoownership) {
      const kExtra = onlyKeys(k, ['isCoownership', 'lots', 'annualChargesEur', 'proceedings'], 'coownership');
      if (kExtra) return bad(kExtra);
      if (!isInt(k.lots, 1, 100_000)) return bad('coownership.lots');
      if (!isInt(k.annualChargesEur, 0, 1_000_000)) return bad('coownership.annualChargesEur');
      if (typeof k.proceedings !== 'boolean') return bad('coownership.proceedings');
      coownership = { isCoownership: true, lots: k.lots, annualChargesEur: k.annualChargesEur, proceedings: k.proceedings };
    } else {
      const kExtra = onlyKeys(k, ['isCoownership'], 'coownership');
      if (kExtra) return bad(kExtra);
      coownership = { isCoownership: false };
    }
  }

  // Risques.
  let risks: { inRiskZone: boolean } | null = null;
  if (input.risks !== null && input.risks !== undefined) {
    const r = input.risks;
    if (!isRecord(r) || typeof r.inRiskZone !== 'boolean') return bad('risks.inRiskZone');
    const rExtra = onlyKeys(r, ['inRiskZone'], 'risks');
    if (rExtra) return bad(rExtra);
    risks = { inRiskZone: r.inRiskZone };
  }

  // Photos et vidéos.
  const mediaRaw = input.media ?? [];
  if (!Array.isArray(mediaRaw) || mediaRaw.length > MAX_MEDIA) return bad('media');
  const media: Media[] = [];
  const refs = new Set<string>();
  for (const [i, m] of mediaRaw.entries()) {
    if (!isRecord(m)) return bad(`media.${i}`);
    const mExtra = onlyKeys(m, ['ref', 'kind', 'edit'], `media.${i}`);
    if (mExtra) return bad(mExtra);
    if (!(MEDIA_KINDS as readonly unknown[]).includes(m.kind)) return bad(`media.${i}.kind`);
    const prefix = `biens/${propertyId}/`;
    const file = typeof m.ref === 'string' && m.ref.startsWith(prefix) ? m.ref.slice(prefix.length) : '';
    if (!MEDIA_FILE.test(file) || !MEDIA_EXT[m.kind as MediaKind].includes(file.split('.')[1]!) || refs.has(m.ref as string)) return bad(`media.${i}.ref`);
    if (!(MEDIA_EDITS as readonly unknown[]).includes(m.edit)) return bad(`media.${i}.edit`);
    if (typeof m.ref !== 'string') return bad(`media.${i}.ref`);
    // Une vidéo ou une visite virtuelle ne se « meuble » pas ici : l'aménagement virtuel est une photo (P06).
    if (m.kind !== 'photo' && m.edit === 'amenagement_virtuel') return bad(`media.${i}.edit`);
    refs.add(m.ref);
    media.push({ ref: m.ref, kind: m.kind as MediaKind, edit: m.edit as MediaEdit });
  }

  return { ok: true, value: { characteristics, energy, coownership, risks, media } };
}

interface SheetRow {
  property_id: string;
  version: number;
  data: string;
  created_by: string;
  created_at: string;
}

const toVersion = (row: SheetRow): SheetVersion => ({
  propertyId: row.property_id,
  version: Number(row.version),
  sheet: JSON.parse(row.data) as PropertySheet,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

export class FicheBien {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, propertyId: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'property_sheet', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Lire la fiche : quiconque voit le bien en entier, c'est-à-dire l'agent du bien, la direction, la conformité. */
  private async canRead(viewer: Viewer, propertyId: string): Promise<{ ok: true; networkId: string; agentId: string | null } | Refusal | SheetProblem> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full') return this.refuse(viewer, propertyId, 'not_assigned');
    return { ok: true, networkId: p.value.network_id, agentId: p.value.agent_id };
  }

  /**
   * Enregistre une nouvelle version complète de la fiche. Seuls l'agent du bien et la direction écrivent [R16].
   * Une saisie fautive est refusée avec le champ en cause, sans rien ranger.
   *
   * Avec `ifVersion`, la version n'est écrite que si la dernière version rangée est encore celle-là (0 : aucune) ;
   * sinon `stale`, sans rien ranger : un ajout calculé sur une version lue ne perd jamais un ajout fait entre-temps (X12).
   */
  async save(viewer: Viewer, propertyId: string, input: unknown, options: { ifVersion?: number } = {}): Promise<{ ok: true; value: SheetVersion } | Refusal | SheetProblem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      // Le rôle d'abord : la conformité lit, mais n'écrit pas la fiche d'un bien.
      const read = await this.canRead(viewer, propertyId);
      if (!read.ok) return read;
      return this.refuse(viewer, propertyId, 'role');
    }
    const read = await this.canRead(viewer, propertyId);
    if (!read.ok) return read;
    const parsed = parseSheet(input, this.now(), propertyId);
    if (!parsed.ok) return { ok: false, rule: null, code: 'invalid', field: parsed.field };
    const data = JSON.stringify(parsed.value);
    const createdAt = this.now().toISOString();
    // Le numéro de version est pris dans la même instruction que l'écriture : deux enregistrements simultanés
    // n'ont jamais le même numéro (contrainte d'unicité), le perdant réessaie.
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.newId();
      try {
        const guarded = options.ifVersion !== undefined;
        const { changes } = await this.db.run(
          `INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at)
           SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM property_sheets WHERE property_id = ?${guarded ? ' HAVING COALESCE(MAX(version), 0) = ?' : ''}`,
          [id, propertyId, read.networkId, data, this.actor(viewer), createdAt, propertyId, ...(guarded ? [options.ifVersion as number] : [])],
        );
        if (guarded && changes === 0) return { ok: false, rule: null, code: 'stale' };
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      const row = await this.db.first<SheetRow>('SELECT property_id, version, data, created_by, created_at FROM property_sheets WHERE id = ?', [id]);
      if (!row) continue;
      const saved = toVersion(row);
      // Au journal : le bien et le numéro de version, aucune donnée personnelle [R13].
      await appendEvent(this.journal, { type: 'bien.fiche_version', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R17', version: saved.version } }, this.now);
      return { ok: true, value: saved };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  /** La dernière version de la fiche, ou une version donnée. */
  async read(viewer: Viewer, propertyId: string, version?: number): Promise<{ ok: true; value: SheetVersion } | Refusal | SheetProblem> {
    const read = await this.canRead(viewer, propertyId);
    if (!read.ok) return read;
    if (version !== undefined) {
      if (!Number.isInteger(version) || version < 1) return { ok: false, rule: null, code: 'unknown_version' };
      const row = await this.db.first<SheetRow>('SELECT property_id, version, data, created_by, created_at FROM property_sheets WHERE property_id = ? AND version = ?', [propertyId, version]);
      return row ? { ok: true, value: toVersion(row) } : { ok: false, rule: null, code: 'unknown_version' };
    }
    const row = await this.latestRow(propertyId);
    return row ? { ok: true, value: toVersion(row) } : { ok: false, rule: null, code: 'no_sheet' };
  }

  /** Toutes les versions, de la plus ancienne à la plus récente. */
  async history(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: SheetVersion[] } | Refusal | SheetProblem> {
    const read = await this.canRead(viewer, propertyId);
    if (!read.ok) return read;
    const rows = await this.db.all<SheetRow>('SELECT property_id, version, data, created_by, created_at FROM property_sheets WHERE property_id = ? ORDER BY version', [propertyId]);
    return { ok: true, value: rows.map(toVersion) };
  }

  private latestRow(propertyId: string): Promise<SheetRow | null> {
    return this.db.first<SheetRow>('SELECT property_id, version, data, created_by, created_at FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
  }
}
