/**
 * Les obligations locales du dossier de vente (M10, AU011) [R60, R16, R17, R13].
 *
 * Trois pièces du dossier de diagnostic technique dépendent du lieu ou de l'installation du bien (art. L271-4 du code
 * de la construction et de l'habitation) :
 * - l'état relatif à la présence de termites, pour un bâtiment situé dans une zone délimitée par arrêté préfectoral,
 *   valable 6 mois ;
 * - l'information sur la présence d'un risque de mérule, pour un bâtiment situé dans une zone délimitée par arrêté
 *   préfectoral ;
 * - le document du contrôle de l'installation d'assainissement non collectif (art. L1331-11-1 du code de la santé
 *   publique), pour un logement non raccordé au réseau public, valable 3 ans.
 *
 * Le logiciel ne devine jamais une zone : la direction range, commune par commune (code postal et nom), ce que dit
 * l'arrêté local, avec sa source datée (intitulé, lien, date de l'arrêté, jour de la lecture). L'agent du bien, ou la
 * direction, déclare le raccordement du bien aux eaux usées. Décidé, lecture prudente :
 * - une commune inconnue, une commune sans lecture rangée, ou une lecture de plus d'un an (un arrêté se modifie) laisse
 *   la situation « inconnue » : le dossier n'est pas dit complet tant qu'elle ne l'est pas ;
 * - la commune est celle de la désignation du bien (AU002) quand il en a une, sinon celle de sa fiche courte ;
 * - le nom de la commune est comparé sans accents, casse, traits d'union ni apostrophes ;
 * - termites et mérule visent tout bâtiment (logement, immeuble, local, murs) ; l'assainissement, les logements seuls ;
 * - au journal : des identifiants et des codes, jamais une adresse [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { latestDesignation } from '../documents/designation.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';

export const LOCAL_HAZARDS = ['termites', 'merule'] as const;
export type LocalHazard = (typeof LOCAL_HAZARDS)[number];
export const SANITATION_MODES = ['collectif', 'non_collectif'] as const;
export type SanitationMode = (typeof SANITATION_MODES)[number];

/** Une lecture d'arrêté plus vieille que cela ne vaut plus : la direction la relit (un arrêté se modifie). */
export const LOCAL_SOURCE_MAX_AGE_DAYS = 365;

export interface LocalSource {
  title: string;
  url: string;
  /** La date de l'arrêté, `AAAA-MM-JJ`. */
  datedOn: string;
  /** Le jour où la direction l'a lu, `AAAA-MM-JJ`. */
  readOn: string;
}

export interface LocalZone {
  inZone: boolean;
  source: LocalSource;
}

/**
 * Ce que l'on sait du lieu et de l'installation d'un bien : null partout où l'on ne sait pas. `commune` null : le bien
 * n'a ni désignation ni code postal et commune ; une zone null : aucune lecture à jour pour la commune.
 */
export interface LocalFacts {
  commune: { postalCode: string; city: string } | null;
  termites: LocalZone | null;
  merule: LocalZone | null;
  sanitation: SanitationMode | null;
}

/** Rien n'est connu : ce que les règles retiennent quand on ne leur dit rien. */
export const UNKNOWN_LOCAL: LocalFacts = { commune: null, termites: null, merule: null, sanitation: null };

/** La clé d'une commune : sans accents, casse, traits d'union, apostrophes ni espaces en trop. */
export function cityKey(city: string): string {
  return city
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-'’\s]+/g, ' ')
    .trim();
}

/** Une lecture vaut si elle a au plus `LOCAL_SOURCE_MAX_AGE_DAYS` jours au jour donné, `AAAA-MM-JJ`. */
export function freshZone(zone: LocalZone | null, today: string): LocalZone | null {
  if (!zone) return null;
  const age = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${zone.source.readOn}T12:00:00Z`)) / 86_400_000;
  return age >= 0 && age <= LOCAL_SOURCE_MAX_AGE_DAYS ? zone : null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_commune' | 'bad_hazard' | 'bad_source' | 'bad_date' | 'bad_mode' | 'unknown_property' | 'busy' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function validDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const CLEAN = /^[^\u0000-\u001f\u007f<>{}]+$/u;
function text(raw: unknown, min: number, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/\s+/g, ' ');
  return v.length >= min && v.length <= max && CLEAN.test(v) ? v : null;
}
function httpsUrl(raw: unknown): string | null {
  const v = text(raw, 12, 500);
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname.includes('.') ? v : null;
  } catch {
    return null;
  }
}

export class ObligationsLocales {
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

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', code, resource: 'obligations_locales' } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /**
   * La direction range ce que dit l'arrêté local d'une commune pour un risque, avec sa source datée. Une nouvelle
   * lecture s'ajoute, la plus récente vaut ; rien ne se réécrit [R17]. Ni l'arrêté ni la lecture ne sont dans le futur.
   */
  async recordZone(
    viewer: Viewer,
    input: { postalCode: unknown; city: unknown; hazard: unknown; inZone: unknown; title: unknown; url: unknown; datedOn: unknown; readOn: unknown },
  ): Promise<{ ok: true; value: LocalZone } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const postalCode = typeof input.postalCode === 'string' && /^\d{5}$/.test(input.postalCode) ? input.postalCode : null;
    const city = text(input.city, 1, 100);
    if (!postalCode || !city || !cityKey(city)) return { ok: false, rule: null, code: 'bad_commune' };
    if (!(LOCAL_HAZARDS as readonly unknown[]).includes(input.hazard)) return { ok: false, rule: null, code: 'bad_hazard' };
    const title = text(input.title, 3, 200);
    const url = httpsUrl(input.url);
    if (!title || !url || typeof input.inZone !== 'boolean') return { ok: false, rule: null, code: 'bad_source' };
    const today = localTime(this.now(), TIME_ZONE).date;
    if (!validDay(input.datedOn) || !validDay(input.readOn) || input.readOn > today || input.datedOn > input.readOn) return { ok: false, rule: null, code: 'bad_date' };
    const hazard = input.hazard as LocalHazard;
    const key = cityKey(city);
    try {
      await this.db.run(
        `INSERT INTO local_hazard_orders (id, network_id, postal_code, city_key, hazard, version, in_zone, source_title, source_url, dated_on, read_on, set_by, set_at)
         SELECT ?, ?, ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?, ?, ? FROM local_hazard_orders WHERE network_id = ? AND postal_code = ? AND city_key = ? AND hazard = ?`,
        [this.newId(), viewer.networkId, postalCode, key, hazard, input.inZone ? 1 : 0, title, url, input.datedOn, input.readOn, this.actor(viewer), this.now().toISOString(), viewer.networkId, postalCode, key, hazard],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'obligations.zone_rangee', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R60', hazard, inZone: input.inZone } }, this.now);
    return { ok: true, value: { inZone: input.inZone, source: { title, url, datedOn: input.datedOn, readOn: input.readOn } } };
  }

  /** L'agent du bien ou la direction, qui le voient en entier, déclare son raccordement aux eaux usées [R16]. */
  async recordSanitation(viewer: Viewer, propertyId: string, mode: unknown): Promise<{ ok: true; value: SanitationMode } | Refusal | Problem> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full') return this.refuse(viewer, `property:${propertyId}`, 'not_assigned');
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, `property:${propertyId}`, 'role');
    if (!(SANITATION_MODES as readonly unknown[]).includes(mode)) return { ok: false, rule: null, code: 'bad_mode' };
    try {
      await this.db.run(
        `INSERT INTO property_sanitation (id, network_id, property_id, version, mode, set_by, set_at)
         SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM property_sanitation WHERE property_id = ?`,
        [this.newId(), p.value.network_id, propertyId, mode as string, this.actor(viewer), this.now().toISOString(), propertyId],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'obligations.assainissement_range', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R60', mode: mode as SanitationMode } }, this.now);
    return { ok: true, value: mode as SanitationMode };
  }
}

/**
 * Ce que l'on sait du lieu et de l'installation d'un bien, au jour donné (`AAAA-MM-JJ`, à Paris). Sans contrôle des
 * droits : à l'appelant de les avoir vérifiés.
 */
export async function localFactsOf(db: SqlDatabase, networkId: string, propertyId: string, today: string): Promise<LocalFacts> {
  const designation = await latestDesignation(db, networkId, propertyId);
  let commune: LocalFacts['commune'] = designation ? { postalCode: designation.address.postalCode, city: designation.address.city } : null;
  if (!commune) {
    const row = await db.first<{ postal_code: string | null; city: string | null }>('SELECT postal_code, city FROM properties WHERE id = ? AND network_id = ?', [propertyId, networkId]);
    if (row?.postal_code && /^\d{5}$/.test(row.postal_code) && row.city && cityKey(row.city)) commune = { postalCode: row.postal_code, city: row.city };
  }
  const zone = async (hazard: LocalHazard): Promise<LocalZone | null> => {
    if (!commune) return null;
    const r = await db.first<{ in_zone: number; source_title: string; source_url: string; dated_on: string; read_on: string }>(
      `SELECT in_zone, source_title, source_url, dated_on, read_on FROM local_hazard_orders
       WHERE network_id = ? AND postal_code = ? AND city_key = ? AND hazard = ? ORDER BY version DESC LIMIT 1`,
      [networkId, commune.postalCode, cityKey(commune.city), hazard],
    );
    if (!r) return null;
    return freshZone({ inZone: Number(r.in_zone) === 1, source: { title: r.source_title, url: r.source_url, datedOn: r.dated_on, readOn: r.read_on } }, today);
  };
  const s = await db.first<{ mode: SanitationMode }>('SELECT mode FROM property_sanitation WHERE property_id = ? AND network_id = ? ORDER BY version DESC LIMIT 1', [propertyId, networkId]);
  return { commune, termites: await zone('termites'), merule: await zone('merule'), sanitation: s?.mode ?? null };
}
