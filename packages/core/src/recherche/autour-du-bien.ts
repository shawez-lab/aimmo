/**
 * Ce qu'il y a autour du bien (HX29) : écoles, commerces, transports, et les temps de trajet. Comme Apimo, avec en plus,
 * jamais vu :
 * - chaque point d'intérêt et chaque temps de trajet cite sa source et sa date ; une donnée sans source sûre (adresse
 *   https), sans date, datée du futur ou trop vieille n'est jamais montrée [R425] ;
 * - les temps à pied, en transport et en voiture vers ce qui compte pour cet acquéreur : ses propres destinations (son
 *   travail, l'école de ses enfants) et les sortes de lieux qu'il a choisies, dans une vue à lui seul [R427, R428] ;
 * - l'adresse exacte du bien n'apparaît nulle part : la page publique ne donne qu'une zone d'environ 500 m, des temps
 *   arrondis à 5 minutes au-dessus, aucune distance en mètres, et le nom d'un lieu qui reprend la rue du bien est
 *   remplacé par sa sorte [R426].
 *
 * Décidé, lecture prudente : un temps à pied ou en voiture peut être estimé par le code à vol d'oiseau (détour compté),
 * et il est alors marqué « estimation » ; un temps en transport n'est jamais estimé : sans calcul sourcé (horaires du
 * réseau), il est dit « non calculé ». Une donnée de plus de deux ans est écartée. Rien n'est rangé en base : le calcul se
 * refait à chaque page, et les destinations de l'acquéreur ne sont jamais gardées.
 */

export const POI_CATEGORIES = [
  'creche',
  'ecole',
  'college',
  'lycee',
  'commerce_alimentaire',
  'pharmacie',
  'medecin',
  'gare',
  'tram',
  'bus',
  'parc',
  'sport',
] as const;
export type PoiCategory = (typeof POI_CATEGORIES)[number];

export const POI_LABELS: Record<PoiCategory, string> = {
  creche: 'Crèche',
  ecole: 'École',
  college: 'Collège',
  lycee: 'Lycée',
  commerce_alimentaire: 'Commerce alimentaire',
  pharmacie: 'Pharmacie',
  medecin: 'Médecin',
  gare: 'Gare',
  tram: 'Arrêt de tram',
  bus: 'Arrêt de bus',
  parc: 'Parc',
  sport: 'Équipement sportif',
};

export const TRAVEL_MODES = ['pied', 'transport', 'voiture'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

export const MODE_LABELS: Record<TravelMode, string> = { pied: 'à pied', transport: 'en transport', voiture: 'en voiture' };

/** Une donnée vient toujours d'une source nommée, à une adresse https, relevée à une date. */
export interface DataSource {
  name: string;
  url: string;
  /** Date du relevé, `AAAA-MM-JJ`. */
  date: string;
}

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface PointOfInterest extends Coordinates {
  id: string;
  category: PoiCategory;
  name: string;
  source: DataSource;
}

/** Où est le bien : jamais publié, seulement lu par le calcul. */
export interface PrivateLocation extends Coordinates {
  number?: string;
  street: string;
  postalCode: string;
  commune: string;
}

export interface Trip {
  mode: TravelMode;
  minutes: number;
  /** `calcul` : un service de trajets sourcé ; `estimation` : le code, à vol d'oiseau. */
  kind: 'calcul' | 'estimation';
  source: { name: string; url?: string; date: string };
}

/** Un service de trajets (horaires du réseau, carte routière), appelé côté serveur avec la position exacte. */
export type TripProvider = (from: Coordinates, to: Coordinates, mode: TravelMode) => Trip | null;

export interface TripShown {
  mode: TravelMode;
  /** Arrondi à 5 minutes au-dessus, jamais moins de 5 [R426]. */
  atMostMinutes: number;
  text: string;
  kind: 'calcul' | 'estimation';
  source: { name: string; url?: string; date: string };
}

export interface ModeAbsent {
  mode: TravelMode;
  text: string;
}

export interface PoiShown {
  category: PoiCategory;
  label: string;
  /** `null` quand le nom reprend la rue du bien [R426]. */
  name: string | null;
  source: DataSource;
  trips: TripShown[];
  absent: ModeAbsent[];
}

export type RejectionReason = 'source' | 'date' | 'future' | 'perimee' | 'categorie' | 'position';

export interface PublicSurroundings {
  commune: string;
  /** Le centre d'une case d'environ 500 m, jamais la position du bien. */
  area: Coordinates & { radiusM: number };
  points: PoiShown[];
  sources: DataSource[];
}

export interface SurroundingsResult {
  page: PublicSurroundings;
  /** Pour l'agent seulement : ce qui a été écarté, et pourquoi. */
  rejected: Array<{ id: string; reason: RejectionReason }>;
}

export interface BuyerDestination extends Coordinates {
  /** Le nom que l'acquéreur lui donne : « Mon travail », « École de Léa ». */
  label: string;
}

export interface BuyerTripsView {
  destinations: Array<{ label: string; trips: TripShown[]; absent: ModeAbsent[] }>;
  /** Le lieu le plus proche de chaque sorte choisie par l'acquéreur. */
  nearest: PoiShown[];
  missingCategories: PoiCategory[];
}

export const MAX_AGE_DAYS = 730;
export const RADIUS_M = 1500;
export const PER_CATEGORY = 3;
/** Une case de 0,005° : environ 550 m du nord au sud et 380 m d'est en ouest à Dijon. */
export const GRID_DEG = 0.005;
export const AREA_RADIUS_M = 500;

const DAY_MS = 86_400_000;
const EARTH_RADIUS_M = 6_371_000;

export function distanceM(a: Coordinates, b: Coordinates): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function validCoordinates(c: Coordinates): boolean {
  return Number.isFinite(c.lat) && Number.isFinite(c.lon) && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180;
}

function parseDay(date: unknown): number | null {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== date) return null;
  return t;
}

/** Une position écrite dans un chemin (« 47.32173 ») : jamais publiée [R426]. */
const COORDINATE_IN_PATH = /\d{1,3}[.,]\d{3,}/;

function validHttps(url: unknown): boolean {
  return publicUrl(url) !== null;
}

/**
 * L'adresse publiée d'une source : son site et son chemin seulement, sans paramètres ni ancre, qui pourraient porter le
 * départ du trajet ; un chemin qui contient une position est refusé [R426].
 */
export function publicUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 500) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username !== '' || u.password !== '') return null;
  if (COORDINATE_IN_PATH.test(decodeURIComponent(u.pathname))) return null;
  return `${u.origin}${u.pathname}`;
}

/** Pourquoi une source ne peut pas être montrée, ou `null` si elle le peut [R425]. */
export function checkSource(source: unknown, now: number, requireUrl = true): RejectionReason | null {
  if (!source || typeof source !== 'object') return 'source';
  const s = source as Partial<DataSource>;
  if (typeof s.name !== 'string' || s.name.trim() === '') return 'source';
  if (requireUrl || s.url !== undefined) {
    if (!validHttps(s.url)) return 'source';
  }
  const day = parseDay(s.date);
  if (day === null) return 'date';
  if (day > now) return 'future';
  if (now - day > MAX_AGE_DAYS * DAY_MS) return 'perimee';
  return null;
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Estimation à vol d'oiseau, à pied et en voiture seulement ; jamais en transport. */
export function estimateTrip(from: Coordinates, to: Coordinates, mode: TravelMode, now: number): Trip | null {
  const d = distanceM(from, to);
  const source = { name: "Estimation AIMMO à vol d'oiseau, détour compté", date: today(now) };
  if (mode === 'pied') return { mode, minutes: (d * 1.3) / (4500 / 60), kind: 'estimation', source };
  if (mode === 'voiture') return { mode, minutes: (d * 1.4) / (30_000 / 60) + 2, kind: 'estimation', source };
  return null;
}

export function bucketMinutes(minutes: number): number {
  return Math.max(5, Math.ceil(minutes / 5) * 5);
}

function tripText(mode: TravelMode, atMost: number, kind: Trip['kind']): string {
  const time = atMost <= 60 ? `moins de ${atMost} min` : `environ ${Math.round(atMost / 60 * 2) / 2} h`.replace('.', ',');
  return `${time} ${MODE_LABELS[mode]}${kind === 'estimation' ? ' (estimation)' : ''}`;
}

const ABSENT_TEXT: Record<TravelMode, string> = {
  pied: 'à pied : non calculé',
  transport: 'en transport : non calculé, horaires du réseau non relevés',
  voiture: 'en voiture : non calculé',
};

/**
 * Les trajets d'un point à un autre, mode par mode : le service sourcé d'abord, puis l'estimation pour la marche et la
 * voiture. Un trajet sans source sûre ou sans durée valable n'est jamais montré [R425, R427].
 */
export function tripsBetween(
  from: Coordinates,
  to: Coordinates,
  now: number,
  provider?: TripProvider,
  modes: readonly TravelMode[] = TRAVEL_MODES,
): { trips: TripShown[]; absent: ModeAbsent[] } {
  const trips: TripShown[] = [];
  const absent: ModeAbsent[] = [];
  for (const mode of modes) {
    let trip: Trip | null = null;
    if (provider) {
      let candidate: Trip | null = null;
      try {
        candidate = provider(from, to, mode);
      } catch {
        candidate = null;
      }
      if (candidate && acceptableTrip(candidate, mode, now)) trip = candidate;
    }
    if (!trip) trip = estimateTrip(from, to, mode, now);
    if (!trip) {
      absent.push({ mode, text: ABSENT_TEXT[mode] });
      continue;
    }
    const atMostMinutes = bucketMinutes(trip.minutes);
    trips.push({
      mode,
      atMostMinutes,
      text: tripText(mode, atMostMinutes, trip.kind),
      kind: trip.kind,
      source: trip.kind === 'estimation'
        ? { name: trip.source.name, date: trip.source.date }
        : { name: trip.source.name, url: publicUrl(trip.source.url)!, date: trip.source.date },
    });
  }
  return { trips, absent };
}

function acceptableTrip(trip: Trip, mode: TravelMode, now: number): boolean {
  if (!trip || trip.mode !== mode || trip.kind !== 'calcul') return false;
  if (!Number.isFinite(trip.minutes) || trip.minutes < 0 || trip.minutes > 24 * 60) return false;
  return checkSource(trip.source, now, true) === null;
}

/** Le centre de la case de la grille : la seule position publiée [R426]. */
export function areaOf(location: Coordinates): Coordinates & { radiusM: number } {
  const snap = (v: number) => Number(((Math.floor(v / GRID_DEG) + 0.5) * GRID_DEG).toFixed(4));
  return { lat: snap(location.lat), lon: snap(location.lon), radiusM: AREA_RADIUS_M };
}

const STREET_PREFIX = /^(?:rue|avenue|av|boulevard|bd|place|pl|chemin|allee|impasse|quai|route|cours|square|passage|sentier|rond point|esplanade|promenade)\s+(?:(?:de|du|des|d)\s+|(?:la|le|les|l)\s+)*/;

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`-]/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Le cœur du nom de rue, sans « rue de la » : ce qu'un nom de lieu ne doit pas répéter [R426]. */
export function streetCore(street: string): string {
  return normalizeText(street).replace(STREET_PREFIX, '').trim();
}

function revealsStreet(name: string, core: string): boolean {
  if (core.length < 3) return false;
  return ` ${normalizeText(name)} `.includes(` ${core} `);
}

function showPoi(
  poi: PointOfInterest,
  location: PrivateLocation,
  core: string,
  now: number,
  provider?: TripProvider,
): PoiShown {
  const { trips, absent } = tripsBetween(location, poi, now, provider);
  return {
    category: poi.category,
    label: POI_LABELS[poi.category],
    name: revealsStreet(poi.name, core) || poi.name.trim() === '' ? null : poi.name.trim().slice(0, 120),
    source: { name: poi.source.name, url: publicUrl(poi.source.url)!, date: poi.source.date },
    trips,
    absent,
  };
}

function screen(pois: readonly PointOfInterest[], now: number): {
  kept: PointOfInterest[];
  rejected: Array<{ id: string; reason: RejectionReason }>;
} {
  const kept: PointOfInterest[] = [];
  const rejected: Array<{ id: string; reason: RejectionReason }> = [];
  for (const poi of pois) {
    const id = String(poi?.id ?? '');
    if (!(POI_CATEGORIES as readonly string[]).includes(poi?.category)) {
      rejected.push({ id, reason: 'categorie' });
      continue;
    }
    if (!validCoordinates(poi)) {
      rejected.push({ id, reason: 'position' });
      continue;
    }
    const reason = checkSource(poi.source, now, true);
    if (reason) {
      rejected.push({ id, reason });
      continue;
    }
    if (typeof poi.name !== 'string') {
      rejected.push({ id, reason: 'source' });
      continue;
    }
    kept.push(poi);
  }
  return { kept, rejected };
}

function nearestByCategory(location: Coordinates, pois: PointOfInterest[], perCategory: number): PointOfInterest[] {
  const out: PointOfInterest[] = [];
  for (const category of POI_CATEGORIES) {
    const near = pois
      .filter((p) => p.category === category)
      .map((p) => ({ p, d: distanceM(location, p) }))
      .filter((x) => x.d <= RADIUS_M)
      .sort((a, b) => a.d - b.d || a.p.id.localeCompare(b.p.id))
      .slice(0, perCategory);
    out.push(...near.map((x) => x.p));
  }
  return out;
}

function uniqueSources(points: PoiShown[]): DataSource[] {
  const seen = new Map<string, DataSource>();
  for (const p of points) seen.set(`${p.source.name}|${p.source.url}|${p.source.date}`, p.source);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date));
}

/**
 * La page publique : les lieux autour du bien, au plus trois de chaque sorte dans 1,5 km, chacun avec sa source, sa
 * date et ses temps de trajet arrondis ; jamais l'adresse, la rue, le numéro, le code postal ni la position [R425, R426].
 */
export function publicSurroundings(
  location: PrivateLocation,
  pois: readonly PointOfInterest[],
  now: number,
  provider?: TripProvider,
): SurroundingsResult {
  if (!validCoordinates(location)) throw new Error('Position du bien invalide.');
  const { kept, rejected } = screen(pois, now);
  const core = streetCore(location.street);
  const points = nearestByCategory(location, kept, PER_CATEGORY).map((p) => showPoi(p, location, core, now, provider));
  return {
    page: { commune: location.commune, area: areaOf(location), points, sources: uniqueSources(points) },
    rejected,
  };
}

/**
 * La vue de l'acquéreur, à lui seul : ses destinations et les sortes de lieux qu'il a choisies. Elle n'entre jamais
 * dans la page publique, et ses destinations ne sont pas gardées [R427, R428].
 */
export function buyerTrips(
  location: PrivateLocation,
  pois: readonly PointOfInterest[],
  wants: { destinations: readonly BuyerDestination[]; categories: readonly PoiCategory[] },
  now: number,
  provider?: TripProvider,
): BuyerTripsView {
  if (!validCoordinates(location)) throw new Error('Position du bien invalide.');
  const destinations = wants.destinations.slice(0, 10).map((d) => {
    if (!validCoordinates(d) || typeof d.label !== 'string' || d.label.trim() === '') {
      return { label: typeof d.label === 'string' && d.label.trim() !== '' ? d.label.trim().slice(0, 80) : 'Destination', trips: [], absent: TRAVEL_MODES.map((mode) => ({ mode, text: ABSENT_TEXT[mode] })) };
    }
    return { label: d.label.trim().slice(0, 80), ...tripsBetween(location, d, now, provider) };
  });
  const { kept } = screen(pois, now);
  const core = streetCore(location.street);
  const nearest: PoiShown[] = [];
  const missingCategories: PoiCategory[] = [];
  for (const category of [...new Set(wants.categories)]) {
    const [best] = nearestByCategory(location, kept.filter((p) => p.category === category), 1);
    if (best) nearest.push(showPoi(best, location, core, now, provider));
    else missingCategories.push(category);
  }
  return { destinations, nearest, missingCategories };
}

/** Le texte de la page publique, ligne par ligne, avec la source et la date de chaque lieu [R425]. */
export function renderSurroundings(page: PublicSurroundings): string {
  const lines = [`Autour du bien, à ${page.commune} (zone d'environ ${page.area.radiusM} m)`];
  if (page.points.length === 0) lines.push('Aucun lieu relevé à moins de 1,5 km avec une source datée.');
  for (const p of page.points) {
    const trips = [...p.trips.map((t) => t.text), ...p.absent.map((a) => a.text)].join(' · ');
    const calculs = p.trips
      .filter((t) => t.kind === 'calcul')
      .map((t) => ` Temps ${MODE_LABELS[t.mode]} : ${t.source.name} (${t.source.url}), relevé du ${frDate(t.source.date)}.`)
      .join('');
    lines.push(
      `${p.label}${p.name ? ` · ${p.name}` : ''} : ${trips}. Source : ${p.source.name} (${p.source.url}), relevé du ${frDate(p.source.date)}.${calculs}`,
    );
  }
  const estimation = page.points.flatMap((p) => p.trips).find((t) => t.kind === 'estimation');
  if (estimation) lines.push(`Les estimations sont calculées à vol d'oiseau, détour compté, le ${frDate(estimation.source.date)}.`);
  return lines.join('\n');
}

function frDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}
