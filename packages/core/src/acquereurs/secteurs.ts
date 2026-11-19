/**
 * Le secteur d'une recherche (AU073) : un rayon autour d'un lieu précis, ou un secteur dessiné point par point. Il
 * reste privé à la recherche de l'acquéreur, se range en versions sans rien effacer [R17], et filtre les biens par
 * leur position au rapprochement, donc aussi dans les alertes, la lettre et l'alerte WhatsApp, qui le lisent [R51].
 *
 * La position d'un bien vient de son adresse désignée (AU002), géocodée par la Base adresse nationale ; elle est rangée
 * avec sa source. Un bien sans position ne remplit jamais un secteur : il n'est pas proposé à qui en a un.
 *
 * Seuls l'agent qui suit la fiche de l'acquéreur et la direction rangent un secteur ; seuls l'agent du bien et la
 * direction situent un bien [R16]. Le journal ne garde ni lieu ni coordonnée [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Geocoder } from '../estimation/collecte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type SearchArea =
  | { shape: 'cercle'; center: GeoPoint; radiusM: number; label: string }
  | { shape: 'polygone'; points: GeoPoint[]; label: string };

/** Au plus 50 km de rayon, au moins 100 m ; au plus 40 points pour un secteur dessiné, au moins 3. */
export const AREA_LIMITS = Object.freeze({ minRadiusM: 100, maxRadiusM: 50_000, minPoints: 3, maxPoints: 40 });

const EARTH_RADIUS_M = 6_371_000;
const rad = (d: number): number => (d * Math.PI) / 180;

/** La distance entre deux points, en mètres (haversine). */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Le point est-il dans le secteur ? Le bord du cercle compte ; un secteur dessiné se lit par le tracé d'un rayon. */
export function insideArea(area: SearchArea, p: GeoPoint): boolean {
  if (area.shape === 'cercle') return distanceMetres(area.center, p) <= area.radiusM;
  let inside = false;
  const pts = area.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

const isPoint = (v: unknown): v is GeoPoint =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as GeoPoint).lat === 'number' &&
  typeof (v as GeoPoint).lon === 'number' &&
  Math.abs((v as GeoPoint).lat) <= 90 &&
  Math.abs((v as GeoPoint).lon) <= 180;

/** Le nom privé du secteur : quelques mots, sans chiffre de voie ni adresse. */
const LABEL = /^[\p{L} '’,.-]{2,60}$/u;

export type SecteurRefusal = { ok: false; rule: 'R16' | 'R51' | null; code: string };
type Project = { id: string; network_id: string; person_id: string };

interface AreaRow {
  shape: 'cercle' | 'polygone' | 'aucun';
  center_lat: number | null;
  center_lon: number | null;
  radius_m: number | null;
  points: string | null;
  label: string | null;
}

export function areaOfRow(r: AreaRow | null): SearchArea | null {
  if (!r || r.shape === 'aucun') return null;
  if (r.shape === 'cercle') return { shape: 'cercle', center: { lat: Number(r.center_lat), lon: Number(r.center_lon) }, radiusM: Number(r.radius_m), label: r.label ?? '' };
  return { shape: 'polygone', points: JSON.parse(r.points ?? '[]') as GeoPoint[], label: r.label ?? '' };
}

/** Le dernier secteur de chaque projet d'achat du réseau, pour le rapprochement. */
export async function areasOfNetwork(db: SqlDatabase, networkId: string): Promise<Map<string, SearchArea>> {
  const rows = await db.all<AreaRow & { project_id: string }>(
    `SELECT a.project_id, a.shape, a.center_lat, a.center_lon, a.radius_m, a.points, a.label FROM buyer_search_areas a
     WHERE a.network_id = ? AND a.version = (SELECT MAX(b.version) FROM buyer_search_areas b WHERE b.project_id = a.project_id)`,
    [networkId],
  );
  const out = new Map<string, SearchArea>();
  for (const r of rows) {
    const area = areaOfRow(r);
    if (area) out.set(r.project_id, area);
  }
  return out;
}

/** Le dernier secteur d'un projet, ou null. */
export async function areaOfProject(db: SqlDatabase, projectId: string): Promise<SearchArea | null> {
  return areaOfRow(await db.first<AreaRow>('SELECT shape, center_lat, center_lon, radius_m, points, label FROM buyer_search_areas WHERE project_id = ? ORDER BY version DESC LIMIT 1', [projectId]));
}

/** La dernière position d'un bien, si elle vient de son adresse désignée en vigueur ; sinon null (adresse corrigée depuis). */
export async function positionOf(db: SqlDatabase, propertyId: string): Promise<GeoPoint | null> {
  const r = await db.first<{ lat: number; lon: number }>(
    `SELECT lat, lon FROM property_positions WHERE property_id = ?
       AND designation_version = (SELECT MAX(d.version) FROM property_designations d WHERE d.property_id = ?)
     ORDER BY version DESC LIMIT 1`,
    [propertyId, propertyId],
  );
  return r ? { lat: Number(r.lat), lon: Number(r.lon) } : null;
}

export class Secteurs {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly geocoder: Geocoder | null,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refused(viewer: Viewer, subject: string, code: string): Promise<SecteurRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'secteur', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Le projet d'achat, lisible en entier par ce lecteur : l'agent qui suit la fiche, ou la direction [R16]. */
  private async project(viewer: Viewer, projectId: string): Promise<Project | SecteurRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, `project:${projectId}`, 'role');
    const p = await this.db.first<Project>("SELECT id, network_id, person_id FROM projects WHERE id = ? AND network_id = ? AND kind = 'buy'", [projectId, viewer.networkId]);
    if (!p) return { ok: false, rule: null, code: 'unknown' };
    const read = await this.acces.readFiche(viewer, p.person_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, `project:${projectId}`, 'not_assigned');
    return p;
  }

  /** Le secteur en vigueur d'une recherche, pour son agent ou la direction. */
  async read(viewer: Viewer, projectId: string): Promise<{ ok: true; value: SearchArea | null } | SecteurRefusal> {
    const p = await this.project(viewer, projectId);
    if ('ok' in p) return p;
    const r = await this.db.first<AreaRow>('SELECT shape, center_lat, center_lon, radius_m, points, label FROM buyer_search_areas WHERE project_id = ? ORDER BY version DESC LIMIT 1', [p.id]);
    return { ok: true, value: areaOfRow(r) };
  }

  /**
   * Range le secteur d'une recherche, en nouvelle version : un rayon autour d'un point ou d'un lieu dit (géocodé), un
   * secteur dessiné, ou « aucun » pour le retirer. Rien de libre au-delà du nom privé du secteur.
   */
  async set(viewer: Viewer, projectId: string, input: unknown): Promise<{ ok: true; value: SearchArea | null } | SecteurRefusal> {
    const p = await this.project(viewer, projectId);
    if ('ok' in p) return p;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, rule: null, code: 'valeur' };
    const v = input as Record<string, unknown>;
    let area: SearchArea | null;
    if (v.shape === 'aucun') {
      if (Object.keys(v).some((k) => k !== 'shape')) return { ok: false, rule: null, code: 'valeur' };
      area = null;
    } else {
      if (typeof v.label !== 'string' || !LABEL.test(v.label.trim())) return { ok: false, rule: null, code: 'nom' };
      const label = v.label.trim();
      if (v.shape === 'cercle') {
        if (Object.keys(v).some((k) => !['shape', 'center', 'place', 'radiusM', 'label'].includes(k))) return { ok: false, rule: null, code: 'valeur' };
        const r = v.radiusM;
        if (typeof r !== 'number' || !Number.isInteger(r) || r < AREA_LIMITS.minRadiusM || r > AREA_LIMITS.maxRadiusM) return { ok: false, rule: null, code: 'rayon' };
        let center: GeoPoint | null = null;
        if (v.center !== undefined) {
          if (!isPoint(v.center) || v.place !== undefined) return { ok: false, rule: null, code: 'centre' };
          center = { lat: v.center.lat, lon: v.center.lon };
        } else {
          // Un lieu précis dit en mots : géocodé par la Base adresse nationale, jamais deviné.
          if (typeof v.place !== 'string' || v.place.trim().length < 3 || v.place.length > 200) return { ok: false, rule: null, code: 'centre' };
          if (!this.geocoder) return { ok: false, rule: null, code: 'geocodage_absent' };
          const g = await this.geocoder.geocode(v.place.trim());
          if (!g) return { ok: false, rule: null, code: 'lieu_introuvable' };
          center = { lat: g.lat, lon: g.lon };
        }
        area = { shape: 'cercle', center, radiusM: r, label };
      } else if (v.shape === 'polygone') {
        if (Object.keys(v).some((k) => !['shape', 'points', 'label'].includes(k))) return { ok: false, rule: null, code: 'valeur' };
        const pts = v.points;
        if (!Array.isArray(pts) || pts.length < AREA_LIMITS.minPoints || pts.length > AREA_LIMITS.maxPoints || !pts.every(isPoint)) return { ok: false, rule: null, code: 'points' };
        area = { shape: 'polygone', points: (pts as GeoPoint[]).map((q) => ({ lat: q.lat, lon: q.lon })), label };
      } else return { ok: false, rule: null, code: 'valeur' };
    }
    const at = this.now().toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM buyer_search_areas WHERE project_id = ?', [p.id]);
      try {
        await this.db.run(
          'INSERT INTO buyer_search_areas (id, network_id, project_id, version, shape, center_lat, center_lon, radius_m, points, label, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            this.newId(),
            p.network_id,
            p.id,
            Number(last?.v ?? 0) + 1,
            area ? area.shape : 'aucun',
            area?.shape === 'cercle' ? area.center.lat : null,
            area?.shape === 'cercle' ? area.center.lon : null,
            area?.shape === 'cercle' ? area.radiusM : null,
            area?.shape === 'polygone' ? JSON.stringify(area.points) : null,
            area ? area.label : null,
            this.actor(viewer),
            at,
          ],
        );
        break;
      } catch (error) {
        if (!/UNIQUE/i.test(String(error)) || attempt === 4) throw error;
      }
    }
    await appendEvent(this.journal, { type: 'acquereur.secteur', actor: this.actor(viewer), subject: `person:${p.person_id}`, data: { project: p.id, shape: area ? area.shape : 'aucun' } }, this.now);
    return { ok: true, value: area };
  }

  /** Un bien qu'on n'a pas pu situer : le journal le garde, sans l'adresse [R13], et il n'entre dans aucun secteur. */
  private async notLocated(viewer: Viewer, propertyId: string, code: string): Promise<SecteurRefusal> {
    await appendEvent(this.journal, { type: 'bien.non_situe', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { code } }, this.now);
    return { ok: false, rule: null, code };
  }

  /**
   * Situe un bien par son adresse désignée (AU002), géocodée par la Base adresse nationale : son agent ou la direction.
   * Sans adresse désignée ou sans géocodage, rien n'est rangé et le bien ne remplit aucun secteur.
   */
  async locate(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: GeoPoint } | SecteurRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, `property:${propertyId}`, 'role');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.value.network_id !== viewer.networkId) return this.refused(viewer, `property:${propertyId}`, 'network');
    if (viewer.role === 'agent' && read.value.agent_id !== viewer.userId) return this.refused(viewer, `property:${propertyId}`, 'pas_son_bien');
    const d = await this.db.first<{ version: number; street: string; postal_code: string; city: string }>('SELECT version, street, postal_code, city FROM property_designations WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    if (!d) return this.notLocated(viewer, propertyId, 'sans_adresse');
    if (!this.geocoder) return this.notLocated(viewer, propertyId, 'geocodage_absent');
    const g = await this.geocoder.geocode(`${d.street} ${d.postal_code} ${d.city}`);
    if (!g) return this.notLocated(viewer, propertyId, 'lieu_introuvable');
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM property_positions WHERE property_id = ?', [propertyId]);
      try {
        await this.db.run('INSERT INTO property_positions (id, network_id, property_id, version, lat, lon, source, designation_version, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          this.newId(),
          viewer.networkId,
          propertyId,
          Number(last?.v ?? 0) + 1,
          g.lat,
          g.lon,
          'ban',
          Number(d.version),
          this.actor(viewer),
          this.now().toISOString(),
        ]);
        break;
      } catch (error) {
        if (!/UNIQUE/i.test(String(error)) || attempt === 4) throw error;
      }
    }
    await appendEvent(this.journal, { type: 'bien.situe', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { source: 'ban' } }, this.now);
    return { ok: true, value: { lat: g.lat, lon: g.lon } };
  }
}
