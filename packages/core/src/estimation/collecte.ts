/**
 * La collecte des données publiques d'un bien (M04, E03) : coordonnées et commune (Base adresse nationale), parcelle
 * (cadastre), diagnostic énergétique (ADEME) et risques (Géorisques).
 *
 * Chaque service est derrière une interface ; les vrais branchements passent par une fonction `fetch` donnée, et
 * les tests par de faux services. Chaque donnée porte sa source et l'heure de la collecte ; une source en panne ne
 * bloque pas les autres, et ce qui manque est dit avec sa raison. Seule l'adresse du bien est envoyée aux services,
 * jamais le nom ni les coordonnées de quelqu'un.
 */
import type { EnergyClass } from './fourchette.ts';

export interface Geocoded {
  /** Adresse normalisée par la Base adresse nationale. */
  label: string;
  lat: number;
  lon: number;
  postalCode: string;
  inseeCode: string;
  town: string;
  /** Identifiant de l'adresse dans la Base adresse nationale. */
  banId: string | null;
  /** Confiance du géocodage, de 0 à 1. */
  score: number;
}

export interface Parcel {
  /** Identifiant unique de la parcelle (IDU). */
  id: string;
  section: string;
  number: string;
  /** Contenance en m², si publiée. */
  area: number | null;
}

export interface EnergyDiagnosis {
  energyClass: EnergyClass;
  ghgClass: EnergyClass | null;
  /** Date d'établissement, `AAAA-MM-JJ`. */
  date: string;
  diagnosisNumber: string | null;
}

export interface Risk {
  code: string;
  label: string;
}

export interface Geocoder {
  geocode(address: string): Promise<Geocoded | null>;
}
export interface CadastreService {
  parcelAt(lat: number, lon: number): Promise<Parcel | null>;
}
export interface EnergyService {
  /** Le diagnostic le plus récent connu pour cette adresse. */
  latestFor(place: Geocoded): Promise<EnergyDiagnosis | null>;
}
export interface RiskService {
  risksAt(lat: number, lon: number): Promise<Risk[] | null>;
}

export type Collected<T> =
  | { ok: true; value: T; source: string; collectedAt: string }
  | { ok: false; source: string; collectedAt: string; reason: 'introuvable' | 'panne' | 'adresse_introuvable' | 'adresse_incertaine' };

export interface PublicFacts {
  address: Collected<Geocoded>;
  parcel: Collected<Parcel>;
  energy: Collected<EnergyDiagnosis>;
  risks: Collected<Risk[]>;
  /** Les données qui manquent, pour le dire clairement dans l'avis. */
  missing: ('address' | 'parcel' | 'energy' | 'risks')[];
}

export const SOURCES = {
  address: 'Base adresse nationale (IGN)',
  parcel: 'Cadastre (IGN, API Carto)',
  energy: 'Diagnostics de performance énergétique (ADEME)',
  risks: 'Géorisques (ministère de la Transition écologique)',
} as const;

export interface CollecteServices {
  geocoder: Geocoder;
  cadastre: CadastreService;
  energy: EnergyService;
  risks: RiskService;
}

export interface CollecteOptions {
  now?: () => Date;
  /** En dessous, l'adresse est jugée incertaine et rien d'autre n'est cherché. */
  minScore?: number;
  /** Au-delà, une source qui ne répond pas est en panne : elle ne retient pas les autres. */
  timeoutMs?: number;
}

export class CollecteBien {
  private readonly now: () => Date;
  private readonly minScore: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly services: CollecteServices,
    options: CollecteOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.minScore = options.minScore ?? 0.6;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async attempt<T>(source: string, run: () => Promise<T | null>): Promise<Collected<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('délai dépassé')), this.timeoutMs);
      });
      const value = await Promise.race([run(), late]);
      const collectedAt = this.now().toISOString();
      return value === null ? { ok: false, source, collectedAt, reason: 'introuvable' } : { ok: true, value, source, collectedAt };
    } catch {
      return { ok: false, source, collectedAt: this.now().toISOString(), reason: 'panne' };
    } finally {
      clearTimeout(timer);
    }
  }

  async collect(address: string): Promise<PublicFacts> {
    const clean = address.replace(/\s+/g, ' ').trim().slice(0, 200);
    let place = clean === '' ? ({ ok: false, source: SOURCES.address, collectedAt: this.now().toISOString(), reason: 'introuvable' } as Collected<Geocoded>) : await this.attempt(SOURCES.address, () => this.services.geocoder.geocode(clean));
    if (place.ok && !(place.value.score >= this.minScore)) {
      place = { ok: false, source: SOURCES.address, collectedAt: place.collectedAt, reason: 'adresse_incertaine' };
    }
    if (!place.ok) {
      const at = this.now().toISOString();
      const without = <T>(source: string): Collected<T> => ({ ok: false, source, collectedAt: at, reason: 'adresse_introuvable' });
      return { address: place, parcel: without(SOURCES.parcel), energy: without(SOURCES.energy), risks: without(SOURCES.risks), missing: ['address', 'parcel', 'energy', 'risks'] };
    }
    const g = place.value;
    const [parcel, energy, risks] = await Promise.all([
      this.attempt(SOURCES.parcel, () => this.services.cadastre.parcelAt(g.lat, g.lon)),
      this.attempt(SOURCES.energy, () => this.services.energy.latestFor(g)),
      this.attempt(SOURCES.risks, () => this.services.risks.risksAt(g.lat, g.lon)),
    ]);
    const facts = { address: place, parcel, energy, risks };
    return { ...facts, missing: (Object.keys(facts) as (keyof typeof facts)[]).filter((k) => !facts[k].ok) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Les vrais branchements, par `fetch`. Les adresses de base sont des réglages.

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const PUBLIC_DATA_URLS = {
  geocoder: 'https://data.geopf.fr/geocodage/search',
  cadastre: 'https://apicarto.ign.fr/api/cadastre/parcelle',
  energy: 'https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines',
  risks: 'https://georisques.gouv.fr/api/v1/gaspar/risques',
};

const CLASSES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
const asClass = (v: unknown): EnergyClass | null => (typeof v === 'string' && CLASSES.has(v.trim().toUpperCase()) ? (v.trim().toUpperCase() as EnergyClass) : null);
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const res = await fetcher(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export class BanGeocoder implements Geocoder {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly base = PUBLIC_DATA_URLS.geocoder,
  ) {}
  async geocode(address: string): Promise<Geocoded | null> {
    const body = obj(await getJson(this.fetcher, `${this.base}?q=${encodeURIComponent(address)}&limit=1`));
    const feature = obj(Array.isArray(body['features']) ? body['features'][0] : null);
    const coords = obj(feature['geometry'])['coordinates'];
    const p = obj(feature['properties']);
    if (!Array.isArray(coords)) return null;
    const lon = num(coords[0]);
    const lat = num(coords[1]);
    const label = str(p['label']);
    const postalCode = str(p['postcode']);
    const inseeCode = str(p['citycode']);
    const town = str(p['city']);
    const score = num(p['score']);
    if (lat === null || lon === null || !label || !postalCode || !inseeCode || !town || score === null) return null;
    return { label, lat, lon, postalCode, inseeCode, town, banId: str(p['id']), score };
  }
}

export class IgnCadastre implements CadastreService {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly base = PUBLIC_DATA_URLS.cadastre,
  ) {}
  async parcelAt(lat: number, lon: number): Promise<Parcel | null> {
    const geom = JSON.stringify({ type: 'Point', coordinates: [lon, lat] });
    const body = obj(await getJson(this.fetcher, `${this.base}?geom=${encodeURIComponent(geom)}`));
    const p = obj(obj(Array.isArray(body['features']) ? body['features'][0] : null)['properties']);
    const id = str(p['idu']);
    const section = str(p['section']);
    const number = str(p['numero']);
    if (!id || !section || !number) return null;
    return { id, section, number, area: num(p['contenance']) };
  }
}

export class AdemeEnergy implements EnergyService {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly base = PUBLIC_DATA_URLS.energy,
  ) {}
  async latestFor(place: Geocoded): Promise<EnergyDiagnosis | null> {
    // Seul l'identifiant de l'adresse est envoyé ; sans lui, on ne devine pas.
    if (!place.banId || !/^[A-Za-z0-9_-]{1,64}$/.test(place.banId)) return null;
    const qs = `identifiant_ban:"${place.banId}"`;
    const url = `${this.base}?qs=${encodeURIComponent(qs)}&sort=-date_etablissement_dpe&size=1&select=etiquette_dpe,etiquette_ges,date_etablissement_dpe,numero_dpe`;
    const body = obj(await getJson(this.fetcher, url));
    const row = obj(Array.isArray(body['results']) ? body['results'][0] : null);
    const energyClass = asClass(row['etiquette_dpe']);
    const date = str(row['date_etablissement_dpe']);
    if (!energyClass || !date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
    return { energyClass, ghgClass: asClass(row['etiquette_ges']), date: date.slice(0, 10), diagnosisNumber: str(row['numero_dpe']) };
  }
}

export class GeorisquesRisks implements RiskService {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly base = PUBLIC_DATA_URLS.risks,
  ) {}
  async risksAt(lat: number, lon: number): Promise<Risk[] | null> {
    const body = obj(await getJson(this.fetcher, `${this.base}?latlon=${lon},${lat}`));
    const data = Array.isArray(body['data']) ? body['data'] : null;
    if (!data || data.length === 0) return null;
    const details = obj(data[0])['risques_detail'];
    if (!Array.isArray(details)) return null;
    const risks: Risk[] = [];
    for (const d of details) {
      const code = str(obj(d)['num_risque']);
      const label = str(obj(d)['libelle_risque_long']);
      if (code && label && !risks.some((r) => r.code === code)) risks.push({ code, label });
    }
    return risks;
  }
}

/** Les vrais services publics, par un `fetch` donné. */
export function publicDataServices(fetcher: Fetcher): CollecteServices {
  return { geocoder: new BanGeocoder(fetcher), cadastre: new IgnCadastre(fetcher), energy: new AdemeEnergy(fetcher), risks: new GeorisquesRisks(fetcher) };
}
