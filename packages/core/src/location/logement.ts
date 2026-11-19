/**
 * Mise en location et contrôle du logement avant toute annonce (M15, W01) [R100, R101].
 *
 * AIMMO met un logement en location, jamais en gestion. Avant toute annonce, le code contrôle le logement par des règles
 * écrites, sans IA :
 * - sa classe énergie et sa consommation, à la date de début du bail : au-delà de 450 kWh/m²/an en énergie finale,
 *   interdit pour un bail commençant à partir du 1er janvier 2023 ; classe G à partir du 1er janvier 2025 ; F à partir
 *   du 1er janvier 2028 ; E à partir du 1er janvier 2034 (loi Climat et résilience) [R100] ;
 * - sa surface habitable, d'au moins 9 m² (décret décence) [R101] ;
 * - ses annexes obligatoires, présentes et valides au début du bail : diagnostic de performance énergétique, état des
 *   risques, surface habitable toujours ; constat plomb pour un immeuble d'avant 1949 ; diagnostics électricité et gaz
 *   pour une installation de plus de 15 ans [R101].
 * Un logement refusé reste bloqué, avec ses raisons dites à l'agent. Le propriétaire d'un logement classé E, F ou G
 * reçoit, préparée une seule fois et jamais envoyée d'ici, la date à partir de laquelle il ne pourra plus le louer :
 * son passage par le contrôle central des envois revient à W10.
 *
 * Décidé, lecture prudente : la fin de validité de chaque annexe est calculée par le code depuis la date du diagnostic
 * (diagnostic énergétique 10 ans, ceux faits de 2013 à 2017 valables jusqu'au 31 décembre 2022 et ceux du 1er janvier
 * 2018 au 30 juin 2021 jusqu'au 31 décembre 2024 ; état des risques 6 mois ; constat plomb, électricité et gaz 6 ans,
 * même quand un constat plomb négatif vaudrait sans limite). L'agent du bien et la direction écrivent et contrôlent ;
 * la conformité lit [R16]. Rien ne s'efface : faits et annexes ont des versions, la dernière compte [R17]. Chaque
 * contrôle est rangé avec ce qu'il a vu et écrit au journal, sans nom ni montant [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { checkText } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';

export const RENTAL_ENERGY_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type RentalEnergyClass = (typeof RENTAL_ENERGY_CLASSES)[number];

/** Les dates d'interdiction par classe, pour un bail commençant ce jour-là ou après (loi Climat et résilience). */
export const ENERGY_BANS: Readonly<Partial<Record<RentalEnergyClass, string>>> = Object.freeze({ G: '2025-01-01', F: '2028-01-01', E: '2034-01-01' });
/**
 * Guadeloupe, Martinique, Guyane, La Réunion et Mayotte (AU098) : G à partir du 1er janvier 2028, F du 1er janvier 2031,
 * aucune date pour E (loi Climat et résilience, art. 160 ; service-public.fr, A17975). Le seuil de 450 kWh en énergie
 * finale ne vaut qu'en métropole (décret n° 2021-19).
 */
export const OVERSEAS_ENERGY_BANS: Readonly<Partial<Record<RentalEnergyClass, string>>> = Object.freeze({ G: '2028-01-01', F: '2031-01-01' });
export const TERRITORIES = ['metropole', 'outre_mer'] as const;
export type Territory = (typeof TERRITORIES)[number];

/** Le territoire d'un code postal ou d'un code commune : 971 à 976, outre-mer ; le reste, métropole (Corse comprise). */
export function territoryOf(code: string | null | undefined): Territory {
  return typeof code === 'string' && /^97[1-6]/.test(code) ? 'outre_mer' : 'metropole';
}
/** Au-delà de cette consommation en énergie finale, interdit pour un bail commençant à partir du 1er janvier 2023. */
export const MAX_FINAL_ENERGY_KWH = 450;
export const FINAL_ENERGY_BAN_FROM = '2023-01-01';
/**
 * Décence (décret n° 2002-120 du 30 janvier 2002, art. 4) : une pièce principale d'au moins 9 m² avec une hauteur sous
 * plafond d'au moins 2,20 m, ou un volume habitable d'au moins 20 m³. Sans ces dimensions, le logement n'est jamais dit
 * louable (AU017). La règle locale plus stricte (règlement sanitaire) est lue et datée par l'agent, sinon pas « louable ».
 */
export const MIN_LIVING_AREA_HUNDREDTHS = 900;
/** Hauteur sous plafond minimale de la pièce principale, en centimètres. */
export const MIN_CEILING_HEIGHT_CM = 220;
/** Volume habitable minimal, en centièmes de m³. */
export const MIN_HABITABLE_VOLUME_HUNDREDTHS = 2_000;

export const ANNEX_KINDS = [
  { kind: 'dpe', label: 'Diagnostic de performance énergétique' },
  { kind: 'erp', label: 'État des risques' },
  { kind: 'crep', label: 'Constat de risque d’exposition au plomb' },
  { kind: 'electricite', label: 'État de l’installation intérieure d’électricité' },
  { kind: 'gaz', label: 'État de l’installation intérieure de gaz' },
  { kind: 'surface_habitable', label: 'Surface habitable' },
] as const;
export type AnnexKind = (typeof ANNEX_KINDS)[number]['kind'];

export const GAS_STATES = ['aucune', 'moins_de_15_ans', 'plus_de_15_ans'] as const;
export type GasState = (typeof GAS_STATES)[number];

export interface RentalFacts {
  furnished: boolean;
  rentCents: number;
  chargesCents: number;
  livingAreaHundredths: number;
  energyClass: RentalEnergyClass;
  finalEnergyKwh: number;
  buildYear: number;
  electricityOver15: boolean;
  gas: GasState;
  /** `AAAA-MM-JJ` : début du bail envisagé. */
  leaseStart: string;
  /** Provision avec régularisation annuelle, ou forfait (meublé seulement) ; absent des faits rangés avant W03. */
  chargesMode?: ChargesMode | null;
  /** Surface de la pièce principale, en centièmes de m² (AU017). */
  mainRoomHundredths?: number | null;
  /** Hauteur sous plafond de la pièce principale, en centimètres (AU017). */
  ceilingHeightCm?: number | null;
  /** Volume habitable du logement, en centièmes de m³ (AU017). */
  habitableVolumeHundredths?: number | null;
  /**
   * Le règlement sanitaire de la commune, lu par l'agent (AU017) : sa référence et le jour de la lecture, et si le
   * logement le respecte. Le décret fixe un minimum ; une règle locale plus stricte l'emporte.
   */
  localRules?: { reference: string; checkedOn: string; compliant: boolean } | null;
  /**
   * Gel des loyers des logements F et G (AU016 ; loi de 1989, art. 17 et 17-1, depuis le 24 août 2022 en métropole et
   * le 1er juillet 2024 outre-mer) : le dernier loyer hors charges du locataire précédent, en centimes, ou `firstLetting`
   * quand le logement n'a jamais été loué. Sans l'un ou l'autre, un F ou un G n'est jamais dit louable.
   */
  previousRentCents?: number | null;
  firstLetting?: boolean | null;
}

export const CHARGES_MODES = ['provision', 'forfait'] as const;
export type ChargesMode = (typeof CHARGES_MODES)[number];

export type CheckReason =
  | { code: 'energy_class'; energyClass: RentalEnergyClass; bannedFrom: string }
  | { code: 'final_energy'; finalEnergyKwh: number; bannedFrom: string }
  | { code: 'living_area'; livingAreaHundredths: number; mainRoomHundredths: number | null; ceilingHeightCm: number | null; habitableVolumeHundredths: number | null }
  | { code: 'dimensions_missing' }
  | { code: 'local_rules_unchecked' }
  | { code: 'previous_rent_missing' }
  | { code: 'rent_freeze'; previousRentCents: number }
  | { code: 'local_rules_failed'; reference: string }
  | { code: 'annex_missing'; kind: AnnexKind }
  | { code: 'annex_expired'; kind: AnnexKind; validUntil: string }
  | { code: 'annex_future'; kind: AnnexKind };

export interface RentalCheck {
  checkId: string;
  listingId: string;
  factsVersion: number;
  decision: 'louable' | 'bloque';
  reasons: CheckReason[];
  /** La date à partir de laquelle ce logement ne pourra plus être loué selon sa classe, ou `null`. */
  bannedFrom: string | null;
  checkedAt: string;
}

export interface OwnerNotice {
  listingId: string;
  energyClass: 'E' | 'F' | 'G';
  bannedFrom: string;
  text: string;
}

export type LocationRefusal = { ok: false; rule: 'R16' | 'R100' | 'R101' | 'R102' | null; code: string; field?: string };
export type LocationResult<T> = { ok: true; value: T } | LocationRefusal;

/**
 * Le stockage des annexes : seule l'existence d'une référence est lue, jamais son contenu. `upload`, quand le stockage le
 * permet, range un fichier déposé depuis le téléphone (W14) ; sans lui, le dépôt est fermé.
 */
export interface RentalFileStore {
  has(ref: string): Promise<boolean>;
  upload?(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REF_FILE = new RegExp(`^${UUID}\\.(?:pdf|jpg|png)$`);
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function validDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** `AAAA-MM-JJ` plus des mois, au dernier jour du mois quand le jour n'existe pas ; moins un jour. */
function addMonthsMinusDay(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(ty, tm, Math.min(d, last)));
  target.setUTCDate(target.getUTCDate() - 1);
  return target.toISOString().slice(0, 10);
}

/** La fin de validité d'une annexe, calculée par le code ; `null` : sans limite. */
export function annexValidUntil(kind: AnnexKind, diagnosedOn: string): string | null {
  switch (kind) {
    case 'dpe':
      if (diagnosedOn < '2013-01-01') return '2017-12-31';
      if (diagnosedOn < '2018-01-01') return '2022-12-31';
      if (diagnosedOn < '2021-07-01') return '2024-12-31';
      return addMonthsMinusDay(diagnosedOn, 120);
    case 'erp':
      return addMonthsMinusDay(diagnosedOn, 6);
    case 'crep':
    case 'electricite':
    case 'gaz':
      return addMonthsMinusDay(diagnosedOn, 72);
    case 'surface_habitable':
      return null;
  }
}

/** Les annexes exigées pour ces faits [R101]. */
export function requiredAnnexes(facts: Pick<RentalFacts, 'buildYear' | 'electricityOver15' | 'gas'>): AnnexKind[] {
  const out: AnnexKind[] = ['dpe', 'erp', 'surface_habitable'];
  if (facts.buildYear < 1949) out.push('crep');
  if (facts.electricityOver15) out.push('electricite');
  if (facts.gas === 'plus_de_15_ans') out.push('gaz');
  return out;
}

/** La date à partir de laquelle un logement de cette classe ne peut plus être loué, ou `null` [R100]. */
export function banDate(energyClass: RentalEnergyClass, territory: Territory = 'metropole'): string | null {
  return (territory === 'outre_mer' ? OVERSEAS_ENERGY_BANS : ENERGY_BANS)[energyClass] ?? null;
}

/**
 * Le contrôle du logement pour un bail commençant `facts.leaseStart`, par les seules règles écrites : rejouable,
 * sans écriture [R100, R101]. `annexes` : la dernière version de chaque annexe rangée ; `today` : le jour du contrôle.
 */
/**
 * Le critère de surface et de volume de la décence : « oui » si l'une des deux voies du décret est remplie, « non » si
 * aucune ne l'est alors qu'au moins une est mesurée, « inconnue » sans aucune mesure. Une pièce principale plus grande que
 * le logement est une saisie impossible : « inconnue ».
 */
export function decencyOf(facts: RentalFacts): 'oui' | 'non' | 'inconnue' {
  const room = facts.mainRoomHundredths ?? null;
  const height = facts.ceilingHeightCm ?? null;
  const volume = facts.habitableVolumeHundredths ?? null;
  const roomKnown = room !== null && height !== null && room <= facts.livingAreaHundredths;
  const volumeKnown = volume !== null;
  if (roomKnown && room >= MIN_LIVING_AREA_HUNDREDTHS && height >= MIN_CEILING_HEIGHT_CM) return 'oui';
  if (volumeKnown && volume >= MIN_HABITABLE_VOLUME_HUNDREDTHS) return 'oui';
  return roomKnown || volumeKnown ? 'non' : 'inconnue';
}

export function checkDwelling(facts: RentalFacts, annexes: readonly { kind: AnnexKind; diagnosedOn: string; validUntil: string | null }[], today: string, territory: Territory = 'metropole'): CheckReason[] {
  const reasons: CheckReason[] = [];
  // La classe est jugée au plus tard du début du bail et du jour du contrôle : une date de bail passée ne rouvre rien.
  const on = facts.leaseStart > today ? facts.leaseStart : today;
  const ban = banDate(facts.energyClass, territory);
  if (ban !== null && on >= ban) reasons.push({ code: 'energy_class', energyClass: facts.energyClass, bannedFrom: ban });
  if (territory === 'metropole' && facts.finalEnergyKwh > MAX_FINAL_ENERGY_KWH && on >= FINAL_ENERGY_BAN_FROM) reasons.push({ code: 'final_energy', finalEnergyKwh: facts.finalEnergyKwh, bannedFrom: FINAL_ENERGY_BAN_FROM });
  const decency = decencyOf(facts);
  if (decency === 'inconnue') reasons.push({ code: 'dimensions_missing' });
  else if (decency === 'non')
    reasons.push({
      code: 'living_area',
      livingAreaHundredths: facts.livingAreaHundredths,
      mainRoomHundredths: facts.mainRoomHundredths ?? null,
      ceilingHeightCm: facts.ceilingHeightCm ?? null,
      habitableVolumeHundredths: facts.habitableVolumeHundredths ?? null,
    });
  // Un F ou un G ne se reloue pas plus cher que le dernier loyer du locataire précédent.
  if (facts.energyClass === 'F' || facts.energyClass === 'G') {
    const previous = facts.previousRentCents ?? null;
    if (previous === null && facts.firstLetting !== true) reasons.push({ code: 'previous_rent_missing' });
    else if (previous !== null && facts.rentCents > previous) reasons.push({ code: 'rent_freeze', previousRentCents: previous });
  }
  // Le seuil national ne suffit jamais seul : la règle locale lue et datée, sinon pas « louable ».
  const local = facts.localRules ?? null;
  if (local === null) reasons.push({ code: 'local_rules_unchecked' });
  else if (!local.compliant) reasons.push({ code: 'local_rules_failed', reference: local.reference });
  for (const kind of requiredAnnexes(facts)) {
    const a = annexes.find((x) => x.kind === kind);
    if (!a) reasons.push({ code: 'annex_missing', kind });
    else if (a.diagnosedOn > today) reasons.push({ code: 'annex_future', kind });
    else if (a.validUntil !== null && (a.validUntil < facts.leaseStart || a.validUntil < today)) reasons.push({ code: 'annex_expired', kind, validUntil: a.validUntil });
  }
  return reasons;
}

/** « 1er janvier 2028 ». */
export function dayInFrench(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d === 1 ? '1er' : String(d)} ${MONTHS_FR[m - 1]} ${y}`;
}

/** Le texte de l'échéance au propriétaire, écrit par le code : la classe, la date, rien d'autre. */
export function ownerNoticeText(energyClass: 'E' | 'F' | 'G', bannedFrom: string, today: string): string {
  const when = dayInFrench(bannedFrom);
  const head = `Bonjour, votre logement est classé ${energyClass} au diagnostic de performance énergétique.`;
  const body =
    bannedFrom <= today
      ? ` Depuis le ${when}, la loi ne permet plus de le louer, ni pour un nouveau bail ni pour une reconduction, tant que des travaux ne l'ont pas fait changer de classe.`
      : ` À partir du ${when}, la loi ne permettra plus de le louer, ni pour un nouveau bail ni pour une reconduction, sauf travaux qui le font changer de classe.`;
  return `${head}${body} Votre agent immobilier peut vous expliquer les étapes possibles.`;
}

interface FactsRow {
  version: number;
  furnished: number;
  rent_cents: number;
  charges_cents: number;
  living_area_hundredths: number;
  energy_class: RentalEnergyClass;
  final_energy_kwh: number;
  build_year: number;
  electricity_over_15: number;
  gas: GasState;
  lease_start: string;
  charges_mode: ChargesMode | null;
  main_room_hundredths: number | null;
  ceiling_height_cm: number | null;
  habitable_volume_hundredths: number | null;
  local_rules: string | null;
  previous_rent_cents: number | null;
  first_letting: number | null;
}

const toFacts = (r: FactsRow): RentalFacts => ({
  furnished: Number(r.furnished) === 1,
  rentCents: Number(r.rent_cents),
  chargesCents: Number(r.charges_cents),
  livingAreaHundredths: Number(r.living_area_hundredths),
  energyClass: r.energy_class,
  finalEnergyKwh: Number(r.final_energy_kwh),
  buildYear: Number(r.build_year),
  electricityOver15: Number(r.electricity_over_15) === 1,
  gas: r.gas,
  leaseStart: r.lease_start,
  chargesMode: r.charges_mode ?? null,
  ...(r.main_room_hundredths != null ? { mainRoomHundredths: Number(r.main_room_hundredths) } : {}),
  ...(r.ceiling_height_cm != null ? { ceilingHeightCm: Number(r.ceiling_height_cm) } : {}),
  ...(r.habitable_volume_hundredths != null ? { habitableVolumeHundredths: Number(r.habitable_volume_hundredths) } : {}),
  ...(r.previous_rent_cents != null ? { previousRentCents: Number(r.previous_rent_cents) } : {}),
  ...(r.first_letting != null ? { firstLetting: Number(r.first_letting) === 1 } : {}),
  ...(r.local_rules ? { localRules: JSON.parse(r.local_rules) as { reference: string; checkedOn: string; compliant: boolean } } : {}),
});

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** Contrôle les faits saisis, champ par champ ; un champ inconnu est refusé, jamais ignoré. */
export function parseFacts(input: unknown): { ok: true; value: RentalFacts } | { ok: false; field: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, field: '' };
  const v = input as Record<string, unknown>;
  const keys = ['furnished', 'rentCents', 'chargesCents', 'livingAreaHundredths', 'energyClass', 'finalEnergyKwh', 'buildYear', 'electricityOver15', 'gas', 'leaseStart', 'chargesMode', 'mainRoomHundredths', 'ceilingHeightCm', 'habitableVolumeHundredths', 'localRules', 'previousRentCents', 'firstLetting'];
  for (const k of Object.keys(v)) if (!keys.includes(k)) return { ok: false, field: k };
  if (typeof v.furnished !== 'boolean') return { ok: false, field: 'furnished' };
  if (!isInt(v.rentCents, 1, 100_000_000)) return { ok: false, field: 'rentCents' };
  if (!isInt(v.chargesCents, 0, 100_000_000)) return { ok: false, field: 'chargesCents' };
  if (!isInt(v.livingAreaHundredths, 1, 10_000_000)) return { ok: false, field: 'livingAreaHundredths' };
  if (typeof v.energyClass !== 'string' || !(RENTAL_ENERGY_CLASSES as readonly string[]).includes(v.energyClass)) return { ok: false, field: 'energyClass' };
  if (!isInt(v.finalEnergyKwh, 0, 10_000)) return { ok: false, field: 'finalEnergyKwh' };
  if (!isInt(v.buildYear, 1000, 2100)) return { ok: false, field: 'buildYear' };
  if (typeof v.electricityOver15 !== 'boolean') return { ok: false, field: 'electricityOver15' };
  if (typeof v.gas !== 'string' || !(GAS_STATES as readonly string[]).includes(v.gas)) return { ok: false, field: 'gas' };
  if (!validDay(v.leaseStart)) return { ok: false, field: 'leaseStart' };
  const mode = v.chargesMode ?? null;
  if (mode !== null && (typeof mode !== 'string' || !(CHARGES_MODES as readonly string[]).includes(mode))) return { ok: false, field: 'chargesMode' };
  // Un logement vide se loue avec une provision régularisée chaque année, jamais au forfait (loi de 1989, art. 23).
  if (mode === 'forfait' && v.furnished === false) return { ok: false, field: 'chargesMode' };
  const room = v.mainRoomHundredths ?? null;
  if (room !== null && (!isInt(room, 1, 10_000_000) || room > (v.livingAreaHundredths as number))) return { ok: false, field: 'mainRoomHundredths' };
  const height = v.ceilingHeightCm ?? null;
  if (height !== null && !isInt(height, 100, 1_500)) return { ok: false, field: 'ceilingHeightCm' };
  const volume = v.habitableVolumeHundredths ?? null;
  if (volume !== null && !isInt(volume, 1, 1_000_000_000)) return { ok: false, field: 'habitableVolumeHundredths' };
  const previous = v.previousRentCents ?? null;
  if (previous !== null && !isInt(previous, 1, 100_000_000)) return { ok: false, field: 'previousRentCents' };
  const first = v.firstLetting ?? null;
  if (first !== null && typeof first !== 'boolean') return { ok: false, field: 'firstLetting' };
  // Un premier loyer n'a pas de loyer précédent : les deux ensemble se contredisent.
  if (first === true && previous !== null) return { ok: false, field: 'firstLetting' };
  const local = v.localRules ?? null;
  if (local !== null) {
    if (typeof local !== 'object' || Array.isArray(local)) return { ok: false, field: 'localRules' };
    const l = local as Record<string, unknown>;
    if (Object.keys(l).some((k) => !['reference', 'checkedOn', 'compliant'].includes(k))) return { ok: false, field: 'localRules' };
    if (typeof l.reference !== 'string' || l.reference.trim().length < 3 || l.reference.length > 200 || !validDay(l.checkedOn) || typeof l.compliant !== 'boolean') return { ok: false, field: 'localRules' };
  }
  return {
    ok: true,
    value: {
      furnished: v.furnished,
      rentCents: v.rentCents,
      chargesCents: v.chargesCents,
      livingAreaHundredths: v.livingAreaHundredths,
      energyClass: v.energyClass as RentalEnergyClass,
      finalEnergyKwh: v.finalEnergyKwh,
      buildYear: v.buildYear,
      electricityOver15: v.electricityOver15,
      gas: v.gas as GasState,
      leaseStart: v.leaseStart,
      ...(mode !== null ? { chargesMode: mode as ChargesMode } : {}),
      ...(room !== null ? { mainRoomHundredths: room } : {}),
      ...(height !== null ? { ceilingHeightCm: height } : {}),
      ...(volume !== null ? { habitableVolumeHundredths: volume } : {}),
      ...(previous !== null ? { previousRentCents: previous } : {}),
      ...(first !== null ? { firstLetting: first } : {}),
      ...(local !== null ? { localRules: { reference: String((local as Record<string, unknown>).reference).trim(), checkedOn: (local as Record<string, unknown>).checkedOn as string, compliant: (local as Record<string, unknown>).compliant as boolean } } : {}),
    },
  };
}

export interface MisesEnLocationOptions {
  now?: () => Date;
  newId?: () => string;
}

interface ListingRow {
  id: string;
  network_id: string;
  property_id: string;
  owner_person_id: string;
}

export class MisesEnLocation {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly files: RentalFileStore,
    private readonly journal: JournalStore,
    options: MisesEnLocationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<LocationRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'rental', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** L'agent actif du bien et la direction écrivent ; la conformité lit en plus ; tout autre rôle est refusé [R16]. */
  private async gateProperty(viewer: Viewer, propertyId: unknown, write: boolean, subject: string): Promise<LocationRefusal | null> {
    if (typeof propertyId !== 'string') return this.refuse(viewer, subject, 'unknown');
    const p = await this.db.first<{ agent_id: string | null; kind: string }>('SELECT agent_id, kind FROM properties WHERE id = ? AND network_id = ?', [propertyId, viewer.networkId]);
    if (!p) return this.refuse(viewer, subject, 'unknown');
    if (viewer.role === 'direction') return null;
    if (viewer.role === 'compliance') return write ? this.refuse(viewer, subject, 'role') : null;
    if (viewer.role !== 'agent') return this.refuse(viewer, subject, 'role');
    if (p.agent_id !== viewer.userId) return this.refuse(viewer, subject, 'not_assigned');
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    return agent?.status === 'active' ? null : this.refuse(viewer, subject, 'agent_inactive');
  }

  /** Le territoire du logement, par le code postal de son bien : outre-mer ou métropole (AU098). */
  private async territoryOfListing(row: Pick<ListingRow, 'property_id' | 'network_id'>): Promise<Territory> {
    const p = await this.db.first<{ postal_code: string | null }>('SELECT postal_code FROM properties WHERE id = ? AND network_id = ?', [row.property_id, row.network_id]);
    return territoryOf(p?.postal_code ?? null);
  }

  private async load(viewer: Viewer, listingId: unknown, write: boolean): Promise<LocationRefusal | ListingRow> {
    const subject = `rental:${String(listingId)}`;
    if (typeof listingId !== 'string') return this.refuse(viewer, subject, 'unknown');
    const row = await this.db.first<ListingRow>('SELECT id, network_id, property_id, owner_person_id FROM rental_listings WHERE id = ? AND network_id = ?', [listingId, viewer.networkId]);
    if (!row) return this.refuse(viewer, subject, 'unknown');
    const denied = await this.gateProperty(viewer, row.property_id, write, subject);
    return denied ?? row;
  }

  /** Chaque lecture est écrite au journal avant que la donnée soit rendue [R16, R13]. */
  private async logRead(viewer: Viewer, listingId: string, what: 'status' | 'notices'): Promise<void> {
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental:${listingId}`, data: { rule: 'R16', what } }, this.now);
  }

  /** Ouvre la mise en location d'un logement de la fiche, pour son propriétaire, personne de la fiche client. */
  async create(viewer: Viewer, input: { propertyId: unknown; ownerPersonId: unknown }): Promise<LocationResult<{ listingId: string }>> {
    const denied = await this.gateProperty(viewer, input.propertyId, true, `property:${String(input.propertyId)}`);
    if (denied) return denied;
    const property = (await this.db.first<{ kind: string }>('SELECT kind FROM properties WHERE id = ?', [input.propertyId as string]))!;
    if (property.kind !== 'home') return { ok: false, rule: null, code: 'not_a_home' };
    if (typeof input.ownerPersonId !== 'string' || !(await this.db.first('SELECT 1 FROM persons WHERE id = ? AND network_id = ?', [input.ownerPersonId, viewer.networkId]))) {
      return { ok: false, rule: null, code: 'unknown_owner' };
    }
    const id = this.newId();
    await this.db.run('INSERT INTO rental_listings (id, network_id, property_id, owner_person_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      input.propertyId as string,
      input.ownerPersonId,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'location.ouverte', actor: this.actor(viewer), subject: `rental:${id}`, data: {} }, this.now);
    return { ok: true, value: { listingId: id } };
  }

  /**
   * Les mises en location qu'une personne peut lire, par pages de 50, dans leur ordre d'ouverture et lui seul (W11) :
   * pour un agent actif, celles des biens dont il est l'agent ; pour la direction et la conformité, celles du réseau.
   * Seuls la référence du bien, sa commune et la dernière décision du contrôle sont rendus ; la lecture est au journal [R16].
   */
  async mine(viewer: Viewer, page: unknown = 0): Promise<LocationResult<{ listings: { listingId: string; reference: string; city: string | null; openedAt: string; decision: 'louable' | 'bloque' | null }[]; page: number; more: boolean }>> {
    const subject = `network:${viewer.networkId}`;
    const p = typeof page === 'number' ? page : typeof page === 'string' && /^\d{1,4}$/.test(page) ? Number(page) : NaN;
    if (!Number.isSafeInteger(p) || p < 0 || p > 9999) return { ok: false, rule: null, code: 'bad_page' };
    if (viewer.role !== 'agent' && viewer.role !== 'direction' && viewer.role !== 'compliance') return this.refuse(viewer, subject, 'role');
    if (viewer.role === 'agent') {
      const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
      if (agent?.status !== 'active') return this.refuse(viewer, subject, 'agent_inactive');
    }
    const mineOnly = viewer.role === 'agent';
    const rows = await this.db.all<{ id: string; reference: string; city: string | null; created_at: string; decision: 'louable' | 'bloque' | null }>(
      `SELECT l.id, p.reference, p.city, l.created_at,
        (SELECT c.decision FROM rental_checks c WHERE c.listing_id = l.id ORDER BY c.checked_at DESC, c.rowid DESC LIMIT 1) AS decision
       FROM rental_listings l JOIN properties p ON p.id = l.property_id AND p.network_id = l.network_id
       WHERE l.network_id = ?${mineOnly ? ' AND p.agent_id = ?' : ''}
       ORDER BY l.created_at, l.rowid LIMIT 51 OFFSET ?`,
      mineOnly ? [viewer.networkId, viewer.userId, p * 50] : [viewer.networkId, p * 50],
    );
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject, data: { rule: 'R16', what: 'listings', count: Math.min(rows.length, 50) } }, this.now);
    return {
      ok: true,
      value: {
        listings: rows.slice(0, 50).map((r) => ({ listingId: r.id, reference: r.reference, city: r.city, openedAt: r.created_at, decision: r.decision ?? null })),
        page: p,
        more: rows.length > 50,
      },
    };
  }

  /** Range une nouvelle version des faits du logement ; la précédente reste [R17]. */
  async recordFacts(viewer: Viewer, listingId: unknown, input: unknown): Promise<LocationResult<{ version: number }>> {
    const row = await this.load(viewer, listingId, true);
    if ('ok' in row) return row;
    const parsed = parseFacts(input);
    if (!parsed.ok) return { ok: false, rule: null, code: 'invalid', field: parsed.field };
    const f = parsed.value;
    // Un bail ne commence pas dans le passé : la date du bail ne sert jamais à juger un logement d'hier [R100].
    if (f.leaseStart < this.today()) return { ok: false, rule: 'R100', code: 'invalid', field: 'leaseStart' };
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM rental_facts WHERE listing_id = ?', [row.id]);
    const version = Number(last?.v ?? 0) + 1;
    try {
      await this.db.run(
        `INSERT INTO rental_facts (listing_id, version, furnished, rent_cents, charges_cents, living_area_hundredths, energy_class, final_energy_kwh, build_year, electricity_over_15, gas, lease_start, charges_mode, main_room_hundredths, ceiling_height_cm, habitable_volume_hundredths, local_rules, previous_rent_cents, first_letting, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, version, f.furnished ? 1 : 0, f.rentCents, f.chargesCents, f.livingAreaHundredths, f.energyClass, f.finalEnergyKwh, f.buildYear, f.electricityOver15 ? 1 : 0, f.gas, f.leaseStart, f.chargesMode ?? null, f.mainRoomHundredths ?? null, f.ceilingHeightCm ?? null, f.habitableVolumeHundredths ?? null, f.localRules ? JSON.stringify(f.localRules) : null, f.previousRentCents ?? null, f.firstLetting == null ? null : f.firstLetting ? 1 : 0, this.actor(viewer), this.now().toISOString()],
      );
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'location.faits', actor: this.actor(viewer), subject: `rental:${row.id}`, data: { version } }, this.now);
    return { ok: true, value: { version } };
  }

  /** Range une annexe par sa référence de stockage ; sa fin de validité est calculée par le code [R101]. */
  async addAnnex(viewer: Viewer, listingId: unknown, input: { kind: unknown; ref: unknown; diagnosedOn: unknown }): Promise<LocationResult<{ kind: AnnexKind; version: number; validUntil: string | null }>> {
    const row = await this.load(viewer, listingId, true);
    if ('ok' in row) return row;
    if (typeof input.kind !== 'string' || !ANNEX_KINDS.some((k) => k.kind === input.kind)) return { ok: false, rule: null, code: 'bad_kind' };
    const kind = input.kind as AnnexKind;
    const prefix = `location/${row.id}/`;
    if (typeof input.ref !== 'string' || !input.ref.startsWith(prefix) || !REF_FILE.test(input.ref.slice(prefix.length))) return { ok: false, rule: null, code: 'bad_ref' };
    if (!validDay(input.diagnosedOn) || input.diagnosedOn > this.today()) return { ok: false, rule: null, code: 'bad_date' };
    if (await this.db.first('SELECT 1 FROM rental_annexes WHERE ref = ?', [input.ref])) return { ok: false, rule: null, code: 'ref_used' };
    if (!(await this.files.has(input.ref))) return { ok: false, rule: null, code: 'not_stored' };
    const validUntil = annexValidUntil(kind, input.diagnosedOn);
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM rental_annexes WHERE listing_id = ? AND kind = ?', [row.id, kind]);
    const version = Number(last?.v ?? 0) + 1;
    try {
      await this.db.run('INSERT INTO rental_annexes (id, listing_id, kind, version, ref, diagnosed_on, valid_until, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        this.newId(),
        row.id,
        kind,
        version,
        input.ref,
        input.diagnosedOn,
        validUntil,
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: /\.ref/.test(String(error)) ? 'ref_used' : 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'location.annexe', actor: this.actor(viewer), subject: `rental:${row.id}`, data: { kind, version, validUntil } }, this.now);
    return { ok: true, value: { kind, version, validUntil } };
  }

  /** Pour les autres parties de M15 : la mise en location sous les mêmes droits [R16]. */
  async listing(viewer: Viewer, listingId: unknown, write: boolean): Promise<LocationRefusal | { id: string; networkId: string; propertyId: string; ownerPersonId: string }> {
    const row = await this.load(viewer, listingId, write);
    if ('ok' in row) return row;
    return { id: row.id, networkId: row.network_id, propertyId: row.property_id, ownerPersonId: row.owner_person_id };
  }

  /** La dernière version de chaque annexe, par sa sorte et sa référence : pour les joindre au bail (W06). */
  async annexRefs(listingId: string): Promise<{ kind: AnnexKind; ref: string }[]> {
    return this.db.all<{ kind: AnnexKind; ref: string }>(
      `SELECT a.kind, a.ref FROM rental_annexes a
       WHERE a.listing_id = ? AND a.version = (SELECT MAX(b.version) FROM rental_annexes b WHERE b.listing_id = a.listing_id AND b.kind = a.kind)
       ORDER BY a.kind`,
      [listingId],
    );
  }

  /** Les derniers faits rangés, ou `null`. */
  async currentFacts(listingId: string): Promise<(RentalFacts & { version: number }) | null> {
    return this.latestFacts(listingId);
  }

  private async latestFacts(listingId: string): Promise<(RentalFacts & { version: number }) | null> {
    const r = await this.db.first<FactsRow>(
      'SELECT version, furnished, rent_cents, charges_cents, living_area_hundredths, energy_class, final_energy_kwh, build_year, electricity_over_15, gas, lease_start, charges_mode, main_room_hundredths, ceiling_height_cm, habitable_volume_hundredths, local_rules, previous_rent_cents, first_letting FROM rental_facts WHERE listing_id = ? ORDER BY version DESC LIMIT 1',
      [listingId],
    );
    return r ? { ...toFacts(r), version: Number(r.version) } : null;
  }

  private async latestAnnexes(listingId: string): Promise<{ kind: AnnexKind; version: number; diagnosedOn: string; validUntil: string | null }[]> {
    const rows = await this.db.all<{ kind: AnnexKind; version: number; diagnosed_on: string; valid_until: string | null }>(
      `SELECT a.kind, a.version, a.diagnosed_on, a.valid_until FROM rental_annexes a
       WHERE a.listing_id = ? AND a.version = (SELECT MAX(b.version) FROM rental_annexes b WHERE b.listing_id = a.listing_id AND b.kind = a.kind)
       ORDER BY a.kind`,
      [listingId],
    );
    return rows.map((r) => ({ kind: r.kind, version: Number(r.version), diagnosedOn: r.diagnosed_on, validUntil: r.valid_until }));
  }

  private static annexesKey(annexes: readonly { kind: string; version: number }[]): string {
    return annexes.map((a) => `${a.kind}:${a.version}`).join(',');
  }

  /**
   * Contrôle le logement sur ses derniers faits et ses dernières annexes, range la décision et ses raisons, et prépare
   * une seule fois l'échéance du propriétaire d'un logement classé E, F ou G [R100, R101].
   */
  async check(viewer: Viewer, listingId: unknown): Promise<LocationResult<RentalCheck>> {
    const row = await this.load(viewer, listingId, true);
    if ('ok' in row) return row;
    const facts = await this.latestFacts(row.id);
    if (!facts) return { ok: false, rule: null, code: 'no_facts' };
    const annexes = await this.latestAnnexes(row.id);
    const today = this.today();
    const territory = await this.territoryOfListing(row);
    const reasons = checkDwelling(facts, annexes, today, territory);
    const decision = reasons.length === 0 ? 'louable' : 'bloque';
    const id = this.newId();
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO rental_checks (id, listing_id, facts_version, annexes_key, decision, reasons, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      row.id,
      facts.version,
      MisesEnLocation.annexesKey(annexes),
      decision,
      JSON.stringify(reasons),
      this.actor(viewer),
      at,
    ]);
    const rule = reasons.some((r) => r.code === 'energy_class' || r.code === 'final_energy') ? 'R100' : reasons.length > 0 ? 'R101' : null;
    await appendEvent(this.journal, { type: 'location.controle', actor: this.actor(viewer), subject: `rental:${row.id}`, data: { rule, decision, reasons: reasons.map((r) => r.code), factsVersion: facts.version } }, this.now);
    const bannedFrom = banDate(facts.energyClass, territory);
    if (bannedFrom !== null) await this.prepareNotice(row, facts.energyClass as 'E' | 'F' | 'G', bannedFrom, today);
    return { ok: true, value: { checkId: id, listingId: row.id, factsVersion: facts.version, decision, reasons, bannedFrom, checkedAt: at } };
  }

  private async prepareNotice(row: ListingRow, energyClass: 'E' | 'F' | 'G', bannedFrom: string, today: string): Promise<void> {
    const text = ownerNoticeText(energyClass, bannedFrom, today);
    const [y, m, d] = bannedFrom.split('-').map(Number) as [number, number, number];
    // Le texte ne cite que la classe et la date d'interdiction, issues de la règle écrite [R10, R06].
    const problems = checkText(text, { audience: 'client', channel: 'email', figures: [y, m, d, 1] }).filter((p) => p.rule !== 'R08');
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'location.echeance_refusee', actor: 'system:location', subject: `rental:${row.id}`, data: { rules: problems.map((p) => p.rule) } }, this.now);
      return;
    }
    const written = await this.db.run(
      'INSERT INTO rental_owner_notices (id, listing_id, owner_person_id, energy_class, banned_from, text, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [this.newId(), row.id, row.owner_person_id, energyClass, bannedFrom, text, this.now().toISOString()],
    );
    if (written.changes > 0) {
      await appendEvent(this.journal, { type: 'location.echeance_preparee', actor: 'system:location', subject: `rental:${row.id}`, data: { rule: 'R100', mode: 'essai', energyClass, bannedFrom } }, this.now);
    }
  }

  /** Le dernier contrôle, s'il vaut encore pour les derniers faits et les dernières annexes ; sinon `stale`. */
  async status(viewer: Viewer, listingId: unknown): Promise<LocationResult<{ check: RentalCheck | null; stale: boolean; required: AnnexKind[] }>> {
    const row = await this.load(viewer, listingId, false);
    if ('ok' in row) return row;
    await this.logRead(viewer, row.id, 'status');
    const c = await this.lastCheck(row.id);
    const facts = await this.latestFacts(row.id);
    const required = facts ? requiredAnnexes(facts) : ['dpe', 'erp', 'surface_habitable'] as AnnexKind[];
    // Un contrôle ne vaut plus quand les faits ou les annexes ont changé, ni quand le temps a rendu le logement
    // non louable depuis (annexe échue, date d'interdiction passée) : la même réponse qu'`advertisable`.
    let stale = false;
    if (c) {
      stale = !(await this.current(row.id, c.facts_version, c.annexes_key));
      if (!stale && c.check.decision === 'louable' && facts) stale = checkDwelling(facts, await this.latestAnnexes(row.id), this.today(), await this.territoryOfListing(row)).length > 0;
    }
    return { ok: true, value: { check: c?.check ?? null, stale, required } };
  }

  private async lastCheck(listingId: string): Promise<{ check: RentalCheck; facts_version: number; annexes_key: string } | null> {
    const c = await this.db.first<{ id: string; facts_version: number; annexes_key: string; decision: 'louable' | 'bloque'; reasons: string; checked_at: string }>(
      'SELECT id, facts_version, annexes_key, decision, reasons, checked_at FROM rental_checks WHERE listing_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1',
      [listingId],
    );
    if (!c) return null;
    const f = await this.db.first<{ energy_class: RentalEnergyClass }>('SELECT energy_class FROM rental_facts WHERE listing_id = ? AND version = ?', [listingId, c.facts_version]);
    const listing = await this.db.first<{ property_id: string; network_id: string }>('SELECT property_id, network_id FROM rental_listings WHERE id = ?', [listingId]);
    const territory = listing ? await this.territoryOfListing(listing) : 'metropole';
    return {
      check: { checkId: c.id, listingId, factsVersion: Number(c.facts_version), decision: c.decision, reasons: JSON.parse(c.reasons) as CheckReason[], bannedFrom: f ? banDate(f.energy_class, territory) : null, checkedAt: c.checked_at },
      facts_version: Number(c.facts_version),
      annexes_key: c.annexes_key,
    };
  }

  private async current(listingId: string, factsVersion: number, annexesKey: string): Promise<boolean> {
    const facts = await this.latestFacts(listingId);
    if (!facts || facts.version !== factsVersion) return false;
    return MisesEnLocation.annexesKey(await this.latestAnnexes(listingId)) === annexesKey;
  }

  /**
   * Le logement peut-il être annoncé aujourd'hui ? Seulement si le dernier contrôle l'a dit louable, sur les derniers faits
   * et les dernières annexes, et que ce contrôle refait aujourd'hui le dirait encore [R100, R101]. Pour W03 et W06.
   */
  async advertisable(networkId: string, listingId: string): Promise<boolean> {
    const row = await this.db.first<ListingRow>('SELECT id, network_id, property_id FROM rental_listings WHERE id = ? AND network_id = ?', [listingId, networkId]);
    if (!row) return false;
    const c = await this.lastCheck(listingId);
    if (!c || c.check.decision !== 'louable' || !(await this.current(listingId, c.facts_version, c.annexes_key))) return false;
    const facts = (await this.latestFacts(listingId))!;
    return checkDwelling(facts, await this.latestAnnexes(listingId), this.today(), await this.territoryOfListing(row)).length === 0;
  }

  /** Les échéances préparées pour ce logement, pour l'agent ; elles attendent leur passage par le contrôle central (W10). */
  async notices(viewer: Viewer, listingId: unknown): Promise<LocationResult<OwnerNotice[]>> {
    const row = await this.load(viewer, listingId, false);
    if ('ok' in row) return row;
    await this.logRead(viewer, row.id, 'notices');
    const rows = await this.db.all<{ energy_class: 'E' | 'F' | 'G'; banned_from: string; text: string }>('SELECT energy_class, banned_from, text FROM rental_owner_notices WHERE listing_id = ? ORDER BY prepared_at', [row.id]);
    return { ok: true, value: rows.map((r) => ({ listingId: row.id, energyClass: r.energy_class, bannedFrom: r.banned_from, text: r.text })) };
  }
}
