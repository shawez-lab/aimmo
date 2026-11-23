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
import { DWELLINGS, type Dwelling } from '../db/types.ts';
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

/** AU061 · équipements courants, dits sur la fiche : seuls ceux-là peuvent être nommés dans l'annonce. */
// `garage` et `plain_pied` (AU051) : le calcul de l'avis de valeur les prend en compte, il faut donc pouvoir les dire.
export const AMENITIES = ['piscine', 'cave', 'cheminee', 'grenier', 'veranda', 'climatisation', 'garage', 'plain_pied'] as const;
export type Amenity = (typeof AMENITIES)[number];
/** AU061 · l'état du bien, dit sur la fiche : « travaux à prévoir » ou « refait à neuf » se disent depuis lui seul. */
export const CONDITIONS = ['neuf', 'refait_a_neuf', 'bon_etat', 'travaux_a_prevoir', 'a_renover'] as const;
export type Condition = (typeof CONDITIONS)[number];

/**
 * AU063 · Les surfaces d'un bien, chacune avec son unité (le m², au centième) et sa source : la surface habitable (celle
 * du bien), la surface Carrez (lot de copropriété, loi du 18 décembre 1996) et la surface utile (commerce, bureau).
 */
export const SURFACE_KINDS = ['habitable', 'carrez', 'utile'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];
/** D'où vient la surface : un mesurage d'un professionnel, l'acte ou le titre, ou le dire du vendeur. */
export const SURFACE_SOURCES = ['mesurage', 'acte', 'vendeur'] as const;
export type SurfaceSource = (typeof SURFACE_SOURCES)[number];
export const SURFACE_LABEL: Readonly<Record<SurfaceKind, string>> = { habitable: 'surface habitable', carrez: 'surface Carrez', utile: 'surface utile' };
export const SURFACE_SOURCE_LABEL: Readonly<Record<SurfaceSource, string>> = { mesurage: 'mesurage d’un professionnel', acte: 'acte de propriété', vendeur: 'déclarée par le vendeur' };
/**
 * La surface que chaque support affiche, dite une fois pour toutes (AU063) : un support ne choisit jamais seul. L'annonce
 * et le site disent l'habitable, et la Carrez quand la fiche la porte ; un commerce dit sa surface utile ; les portails et
 * la fiche commerciale reçoivent chacune, à sa place.
 */
export const SURFACE_DISPLAY: Readonly<Record<'annonce' | 'site' | 'portails' | 'fiche_commerciale', readonly SurfaceKind[]>> = {
  annonce: ['habitable', 'carrez'],
  site: ['habitable', 'carrez'],
  portails: ['habitable', 'carrez', 'utile'],
  fiche_commerciale: ['habitable', 'carrez', 'utile'],
};
export type SurfaceSupport = keyof typeof SURFACE_DISPLAY;

/** Les surfaces qu'un support affiche, dans son ordre, avec leur libellé et leur source ; jamais une surface absente. */
export function surfacesFor(
  support: SurfaceSupport,
  f: { kind?: string; surfaceM2: number | null; carrezM2?: number | null; usableM2?: number | null; surfaceSources?: Partial<Record<SurfaceKind, SurfaceSource>> },
): { kind: SurfaceKind; m2: number; label: string; source: SurfaceSource | null }[] {
  const value: Record<SurfaceKind, number | null> = { habitable: f.surfaceM2, carrez: f.carrezM2 ?? null, utile: f.usableM2 ?? null };
  // Un local, des murs ou un fonds se disent d'abord par leur surface utile, partout où elle est rangée.
  const kinds = f.kind === 'commercial' || f.kind === 'business_walls' || f.kind === 'business' ? (['utile', ...SURFACE_DISPLAY[support].filter((k) => k !== 'utile')] as SurfaceKind[]) : SURFACE_DISPLAY[support];
  return kinds
    .filter((k) => value[k] !== null)
    .map((k) => ({ kind: k, m2: value[k]!, label: SURFACE_LABEL[k], source: f.surfaceSources?.[k] ?? null }));
}

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
  /** Maison ou appartement, dit sur la fiche ; absent tant qu'on ne l'a pas dit (AU070). */
  dwelling?: Dwelling;
  /** Les équipements courants du bien (AU061) ; absent tant qu'on n'en a dit aucun. */
  amenities?: Amenity[];
  /** L'état du bien (AU061) ; absent tant qu'on ne l'a pas dit. */
  condition?: Condition;
  /** La surface Carrez et la surface utile, en m² au centième (AU063) ; absentes tant qu'on ne les a pas dites. */
  carrezM2?: number;
  usableM2?: number;
  /** La source de chaque surface dite (AU063). */
  surfaceSources?: Partial<Record<SurfaceKind, SurfaceSource>>;
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
  /**
   * AU064 · ce qui permet de reprendre le diagnostic sans le ressaisir : son numéro d'enregistrement à l'ADEME (13
   * caractères, vérifiable à l'observatoire des DPE), la consommation d'énergie primaire (kWh/m²/an) et les émissions
   * (kg CO₂/m²/an) qu'il écrit, et le document lui-même (`biens/<bien>/<uuid>.pdf`).
   */
  ademeNumber?: string;
  primaryEnergyKwhM2?: number;
  ghgKgM2?: number;
  documentRef?: string;
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
/** Le numéro d'enregistrement d'un DPE à l'ADEME : 13 caractères, chiffres et lettres capitales (AU064). */
export const ADEME_NUMBER = /^[0-9A-Z]{13}$/;
/** Le diagnostic lui-même, rangé comme une photo du bien, en PDF. */
const DPE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
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
  const cExtra = onlyKeys(c, ['bedrooms', 'floor', 'floorsTotal', 'buildYear', 'heating', 'outdoor', 'landM2', 'parkingSpaces', 'elevator', 'dwelling', 'amenities', 'condition', 'carrezM2', 'usableM2', 'surfaceSources'], 'characteristics');
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
  const dwelling = c.dwelling ?? null;
  if (dwelling !== null && !(DWELLINGS as readonly unknown[]).includes(dwelling)) return bad('characteristics.dwelling');
  const amenitiesRaw = c.amenities ?? [];
  if (!Array.isArray(amenitiesRaw) || amenitiesRaw.some((a) => !(AMENITIES as readonly unknown[]).includes(a)) || new Set(amenitiesRaw).size !== amenitiesRaw.length) return bad('characteristics.amenities');
  const condition = c.condition ?? null;
  if (condition !== null && !(CONDITIONS as readonly unknown[]).includes(condition)) return bad('characteristics.condition');
  // AU063 · surfaces au centième de m², comme la surface du bien (AU062) ; chaque source dite d'une liste fermée.
  const hundredths = (v: unknown): { ok: boolean; value: number | null } => {
    if (v === undefined || v === null) return { ok: true, value: null };
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100_000 || Number(v.toFixed(2)) !== v) return { ok: false, value: null };
    return { ok: true, value: v };
  };
  const carrez = hundredths(c.carrezM2);
  if (!carrez.ok) return bad('characteristics.carrezM2');
  const usable = hundredths(c.usableM2);
  if (!usable.ok) return bad('characteristics.usableM2');
  const sourcesRaw = c.surfaceSources ?? {};
  if (!isRecord(sourcesRaw) || Object.entries(sourcesRaw).some(([k, v]) => !(SURFACE_KINDS as readonly string[]).includes(k) || !(SURFACE_SOURCES as readonly unknown[]).includes(v))) return bad('characteristics.surfaceSources');
  // Une source se dit pour une surface rangée, jamais seule.
  if ((sourcesRaw.carrez !== undefined && carrez.value === null) || (sourcesRaw.utile !== undefined && usable.value === null)) return bad('characteristics.surfaceSources');
  const surfaceSources = Object.fromEntries(SURFACE_KINDS.filter((k) => sourcesRaw[k] !== undefined).map((k) => [k, sourcesRaw[k]])) as Partial<Record<SurfaceKind, SurfaceSource>>;
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
    ...(dwelling !== null ? { dwelling: dwelling as Dwelling } : {}),
    ...(amenitiesRaw.length > 0 ? { amenities: AMENITIES.filter((a) => (amenitiesRaw as unknown[]).includes(a)) } : {}),
    ...(condition !== null ? { condition: condition as Condition } : {}),
    ...(carrez.value !== null ? { carrezM2: carrez.value } : {}),
    ...(usable.value !== null ? { usableM2: usable.value } : {}),
    ...(Object.keys(surfaceSources).length > 0 ? { surfaceSources } : {}),
  };

  // Diagnostic énergétique.
  let energy: EnergyDiagnosis | null = null;
  if (input.energy !== null && input.energy !== undefined) {
    const e = input.energy;
    if (!isRecord(e)) return bad('energy');
    const eExtra = onlyKeys(e, ['energyClass', 'climateClass', 'annualCostMinEur', 'annualCostMaxEur', 'costReferenceYear', 'costReferenceYears', 'diagnosedOn', 'ademeNumber', 'primaryEnergyKwhM2', 'ghgKgM2', 'documentRef'], 'energy');
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
    // AU064 · numéro, valeurs et document du diagnostic : chacun contrôlé, facultatif, jamais deviné.
    const given = (v: unknown) => v !== undefined && v !== null;
    if (given(e.ademeNumber) && (typeof e.ademeNumber !== 'string' || !ADEME_NUMBER.test(e.ademeNumber))) return bad('energy.ademeNumber');
    if (given(e.primaryEnergyKwhM2) && !isInt(e.primaryEnergyKwhM2, 0, 2000)) return bad('energy.primaryEnergyKwhM2');
    if (given(e.ghgKgM2) && !isInt(e.ghgKgM2, 0, 500)) return bad('energy.ghgKgM2');
    if (given(e.documentRef) && (typeof e.documentRef !== 'string' || !e.documentRef.startsWith(`biens/${propertyId}/`) || !DPE_FILE.test(e.documentRef.slice(`biens/${propertyId}/`.length)))) return bad('energy.documentRef');
    energy = {
      energyClass: e.energyClass as EnergyClass,
      climateClass: e.climateClass as EnergyClass,
      annualCostMinEur: e.annualCostMinEur,
      annualCostMaxEur: e.annualCostMaxEur,
      costReferenceYear: e.costReferenceYear,
      ...(Array.isArray(years) ? { costReferenceYears: [...(years as number[])] } : {}),
      diagnosedOn: e.diagnosedOn,
      ...(given(e.ademeNumber) ? { ademeNumber: e.ademeNumber as string } : {}),
      ...(given(e.primaryEnergyKwhM2) ? { primaryEnergyKwhM2: e.primaryEnergyKwhM2 as number } : {}),
      ...(given(e.ghgKgM2) ? { ghgKgM2: e.ghgKgM2 as number } : {}),
      ...(given(e.documentRef) ? { documentRef: e.documentRef as string } : {}),
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
