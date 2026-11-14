/**
 * La zone du plan d'urbanisme lue au Géoportail de l'urbanisme, pour le résumé de HX35 (RC43).
 *
 * `CoproprieteUrbanisme.prepare` reçoit une donnée publique d'urbanisme déjà datée [R449] ; ce lecteur la collecte, à
 * l'API Carto de l'IGN, au point du bien. Seuls la position et le code INSEE de la commune partent : jamais l'adresse,
 * jamais un nom [R15].
 *
 * Décidé, lecture prudente :
 * - la date de la donnée est le jour d'approbation du document d'urbanisme (`datappro`), celui du règlement en vigueur ;
 * - jamais deviné, toujours « introuvable » [R450] : deux zones différentes au même point (une limite de zone), un
 *   document qui n'est pas celui de la commune du bien, un type de document hors de la liste admise (POS, PSMV…), une
 *   date mal formée ou postérieure à la collecte, une zone mal formée ;
 * - les zones d'un PLU ou d'un PLUi se lisent à `zone-urba`, les secteurs d'une carte communale à `secteur-cc` (avec
 *   `typesect`) : un document lu à la mauvaise couche n'est pas cru ;
 * - une commune au règlement national d'urbanisme n'a pas de zone : « RNU », daté du jour de la collecte, car c'est
 *   l'état lu ce jour-là ;
 * - une réponse en erreur, illisible ou trop lente : « panne », jamais une erreur pour l'agent [R12].
 */
import type { Fetcher } from '../estimation/collecte.ts';
import { localTime } from '../envoi/horaires.ts';
import { PUBLIC_SOURCES, type PublicFact, type UrbanismValue } from './copropriete-urbanisme.ts';

export const GPU_URLS = {
  zones: 'https://apicarto.ign.fr/api/gpu/zone-urba',
  sectors: 'https://apicarto.ign.fr/api/gpu/secteur-cc',
  municipality: 'https://apicarto.ign.fr/api/gpu/municipality',
} as const;

/** Le point du bien : sa position et sa commune, rien d'autre. */
export interface UrbanismPoint {
  lat: number;
  lon: number;
  inseeCode: string;
}

export interface GpuOptions {
  now?: () => Date;
  timeoutMs?: number;
  urls?: { zones: string; sectors: string; municipality: string };
}

const TIME_ZONE = 'Europe/Paris';
const INSEE = /^(?:\d{2}|2[AB])\d{3}$/;
const ZONE = /^[\p{L}\p{N}][\p{L}\p{N} ._()/+-]{0,19}$/u;

/** Le libellé d'un type de zone, quand le document n'en donne pas. */
const ZONE_TYPES: Record<string, string> = {
  U: 'Zone urbaine',
  AUC: 'Zone à urbaniser',
  AUS: 'Zone à urbaniser',
  A: 'Zone agricole',
  N: 'Zone naturelle et forestière',
};

/** Le libellé d'un type de secteur de carte communale (`typesect`), quand le document n'en donne pas. */
const SECTOR_TYPES: Record<string, string> = {
  '01': 'Secteur ouvert à la construction',
  '02': 'Secteur réservé aux activités',
  '03': 'Secteur non constructible',
  ZC: 'Secteur ouvert à la construction',
  ZCA: 'Secteur réservé aux activités',
  ZNC: 'Secteur non constructible',
};

class Unreadable extends Error {}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.replace(/\s+/g, ' ').trim() : null);

/** Un jour réel du calendrier, en AAAA-MM-JJ. */
function realDay(y: string, m: string, d: string): string | null {
  const day = `${y}-${m}-${d}`;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day ? null : day;
}

/** La date d'approbation : `AAAAMMJJ` ou `AAAA-MM-JJ`, un jour réel, sinon null. */
export function approvalDay(v: unknown): string | null {
  const s = str(v);
  const m = s ? /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s) : null;
  return m ? realDay(m[1]!, m[2]!, m[3]!) : null;
}

/** Le type de document et la collectivité qui l'a fait, lus dans `idurba` (ex. `21231_PLU_20190101`). */
export function documentOf(idurba: unknown): { documentType: Exclude<UrbanismValue['documentType'], 'RNU'>; owner: string } | null {
  const s = str(idurba);
  const m = s ? /^((?:\d{2}|2[AB])\d{3}|\d{9})_(PLUI|PLU|CC)_/i.exec(s) : null;
  if (!m) return null;
  const kind = m[2]!.toUpperCase();
  return { documentType: kind === 'PLUI' ? 'PLUi' : kind === 'PLU' ? 'PLU' : 'carte_communale', owner: m[1]!.toUpperCase() };
}

type Layer = 'zones' | 'sectors';

/** Une zone (PLU, PLUi) ou un secteur (carte communale) lu dans une entité de la réponse, ou null s'il n'est pas recevable. */
function zoneOf(feature: unknown, inseeCode: string, layer: Layer): { value: UrbanismValue; dataDate: string } | null {
  const p = obj(obj(feature)['properties']);
  const doc = documentOf(p['idurba']);
  if (!doc) return null;
  // Les zones viennent d'un PLU ou d'un PLUi, les secteurs d'une carte communale : rien d'autre n'est cru.
  if ((layer === 'sectors') !== (doc.documentType === 'carte_communale')) return null;
  // Un PLU ou une carte communale porte le code de sa commune : celui d'une autre commune n'est pas celui du bien.
  // Un PLUi porte le SIREN de l'intercommunalité, qu'on ne peut pas recouper ici : le point suffit.
  if (doc.owner.length === 5 && doc.owner !== inseeCode) return null;
  if (doc.documentType === 'PLUi' ? doc.owner.length !== 9 : doc.owner.length !== 5) return null;
  const zone = str(p['libelle']);
  if (!zone || !ZONE.test(zone)) return null;
  const dataDate = approvalDay(p['datappro']);
  if (!dataDate) return null;
  const long = str(p['libelong']);
  const fallback = layer === 'zones' ? (ZONE_TYPES[(str(p['typezone']) ?? '').toUpperCase()] ?? null) : (SECTOR_TYPES[(str(p['typesect']) ?? '').toUpperCase()] ?? null);
  const label = long && long.length <= 200 && ![...long].some((c) => c.charCodeAt(0) < 32) ? long : fallback;
  if (!label) return null;
  return { value: { documentType: doc.documentType, zone, label }, dataDate };
}

/** Le lecteur du Géoportail de l'urbanisme, par l'API Carto de l'IGN. */
export class GpuUrbanism {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly urls: { zones: string; sectors: string; municipality: string };

  constructor(
    private readonly fetcher: Fetcher,
    options: GpuOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.urls = options.urls ?? GPU_URLS;
  }

  private async json(url: string): Promise<unknown> {
    const res = await this.fetcher(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  private features(body: unknown): unknown[] {
    const f = obj(body)['features'];
    if (body !== null && !Array.isArray(f)) throw new Unreadable();
    return Array.isArray(f) ? f : [];
  }

  /** La zone d'une couche au point : undefined si la couche n'a rien, null si ce qu'elle a n'est pas recevable. */
  private async layer(layer: Layer, geom: string, point: UrbanismPoint, collectedOn: string): Promise<{ value: UrbanismValue; dataDate: string } | null | undefined> {
    const features = this.features(await this.json(`${this.urls[layer]}?geom=${encodeURIComponent(geom)}`));
    if (features.length === 0) return undefined;
    const zones = features.map((f) => zoneOf(f, point.inseeCode, layer));
    if (zones.some((z) => z === null)) return null;
    const first = zones[0]!;
    // Une limite de zone : deux zones différentes au même point, aucune n'est choisie.
    const same = zones.every((z) => z!.value.zone === first.value.zone && z!.value.documentType === first.value.documentType && z!.dataDate === first.dataDate);
    if (!same || first.dataDate > collectedOn) return null;
    return first;
  }

  private async read(point: UrbanismPoint, collectedOn: string): Promise<{ value: UrbanismValue; dataDate: string } | null> {
    const geom = JSON.stringify({ type: 'Point', coordinates: [point.lon, point.lat] });
    // Un PLU ou un PLUi d'abord ; sans zone, le secteur d'une carte communale ; sans secteur, le RNU.
    const zone = await this.layer('zones', geom, point, collectedOn);
    if (zone !== undefined) return zone;
    const sector = await this.layer('sectors', geom, point, collectedOn);
    if (sector !== undefined) return sector;
    const town = this.features(await this.json(`${this.urls.municipality}?insee=${encodeURIComponent(point.inseeCode)}`));
    const rnu = town.length === 1 && obj(obj(town[0])['properties'])['is_rnu'] === true && obj(obj(town[0])['properties'])['insee'] === point.inseeCode;
    return rnu ? { value: { documentType: 'RNU', zone: 'RNU', label: "Règlement national d'urbanisme" }, dataDate: collectedOn } : null;
  }

  /** La zone au point du bien, avec sa source, l'heure de collecte et la date de la donnée [R449, R450]. */
  async collect(point: UrbanismPoint): Promise<PublicFact<UrbanismValue>> {
    const source = PUBLIC_SOURCES.urbanism;
    const stamp = () => this.now().toISOString();
    const valid =
      point && Number.isFinite(point.lat) && Number.isFinite(point.lon) && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180 && typeof point.inseeCode === 'string' && INSEE.test(point.inseeCode);
    if (!valid) return { ok: false, source, collectedAt: stamp(), reason: 'introuvable' };
    const start = stamp();
    const collectedOn = localTime(new Date(start), TIME_ZONE).date;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('délai dépassé')), this.timeoutMs);
      });
      const found = await Promise.race([this.read(point, collectedOn), late]);
      return found ? { ok: true, source, collectedAt: start, dataDate: found.dataDate, value: found.value } : { ok: false, source, collectedAt: start, reason: 'introuvable' };
    } catch {
      return { ok: false, source, collectedAt: start, reason: 'panne' };
    } finally {
      clearTimeout(timer);
    }
  }
}
