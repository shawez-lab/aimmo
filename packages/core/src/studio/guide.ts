/**
 * Le guide de prise de vue (M19, X01) : à partir du bien et de sa fiche de M07, la liste des vues à faire, pièce par
 * pièce, chacune avec sa consigne écrite dans le code (où se placer, à quelle hauteur, avec quelle lumière), et les vues
 * à ne pas oublier. Rien n'est inventé sur le bien [R10] : une pièce que la fiche ne dit pas n'a pas de vue.
 *
 * L'agent du bien range la photo retenue pour chaque vue, par sa référence dans la fiche ; le bien est « prêt » quand
 * toutes les vues obligatoires ont leur photo. La direction valide un bien photographié avec le guide, une fois [R17].
 * Lecture et écriture sous R16, chaque geste au journal, sans aucune donnée de personne [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PropertyKind } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Une consigne de prise de vue : écrite une fois ici, la même pour tous les agents. */
export interface ShotAdvice {
  /** La sorte de vue, sans numéro (`chambre`). */
  kind: string;
  label: string;
  place: string;
  height: string;
  light: string;
}

/** Les consignes, liste fermée. Hauteur de l'appareil : à mi-hauteur de mur, appareil droit, sauf indication. */
export const SHOT_ADVICE: Readonly<Record<string, ShotAdvice>> = Object.freeze({
  entree: { kind: 'entree', label: 'Entrée', place: 'Dos à la porte d’entrée, la vue vers l’intérieur du logement.', height: 'À hauteur de poitrine, environ 1,20 m, appareil droit.', light: 'Toutes les lampes allumées, portes intérieures ouvertes.' },
  sejour: { kind: 'sejour', label: 'Séjour', place: 'Dans l’angle le plus éloigné des fenêtres, pour montrer la pièce entière et la lumière.', height: 'Environ 1,20 m, appareil droit, sans pencher.', light: 'En journée, rideaux ouverts, lampes allumées pour équilibrer.' },
  cuisine: { kind: 'cuisine', label: 'Cuisine', place: 'Depuis la porte ou l’angle, plan de travail et équipements dans le cadre.', height: 'Environ 1,10 m, à hauteur du plan de travail.', light: 'Plan de travail dégagé, éclairage sous les meubles allumé.' },
  chambre: { kind: 'chambre', label: 'Chambre', place: 'Depuis l’angle de la porte, le lit de trois quarts, la fenêtre dans le cadre.', height: 'Environ 1,10 m, appareil droit.', light: 'Volets ouverts, lit fait, lampes de chevet allumées.' },
  salle_d_eau: { kind: 'salle_d_eau', label: 'Salle de bains ou d’eau', place: 'Depuis la porte, sans se voir dans le miroir.', height: 'Environ 1,20 m, appareil droit.', light: 'Toutes les lampes allumées, abattant baissé, serviettes rangées.' },
  exterieur: { kind: 'exterieur', label: 'Extérieur', place: 'Depuis le seuil, puis du fond de l’extérieur vers le logement.', height: 'Environ 1,50 m.', light: 'Soleil derrière soi, en milieu de matinée ou en fin d’après-midi.' },
  vue: { kind: 'vue', label: 'Vue depuis le logement', place: 'Depuis la plus belle fenêtre, sans plaque de rue ni numéro dans le cadre.', height: 'À hauteur des yeux.', light: 'Par temps clair, exposition sur l’extérieur.' },
  stationnement: { kind: 'stationnement', label: 'Stationnement', place: 'L’emplacement ou le garage en entier, sans plaque d’immatriculation lisible.', height: 'Environ 1,50 m.', light: 'Porte ouverte, lumière allumée.' },
  facade: { kind: 'facade', label: 'Façade', place: 'De trois quarts, sans numéro, plaque de rue ni enseigne voisine lisibles.', height: 'Environ 1,60 m, appareil droit, verticales droites.', light: 'Façade au soleil, ciel dégagé.' },
  terrain: { kind: 'terrain', label: 'Terrain', place: 'Depuis l’accès, puis depuis le point le plus haut du terrain.', height: 'Environ 1,60 m.', light: 'Soleil derrière soi.' },
  local: { kind: 'local', label: 'Local', place: 'Depuis l’entrée, le local en entier, puis depuis le fond.', height: 'Environ 1,30 m.', light: 'Toutes les lampes allumées, vitrine nettoyée.' },
  plateau: { kind: 'plateau', label: 'Plateau ou pièce de travail', place: 'Depuis l’angle le plus éloigné des fenêtres.', height: 'Environ 1,30 m.', light: 'Lampes allumées, stores ouverts.' },
});

/** Les vues à ne pas oublier, rappelées à la fin du guide. */
export const DO_NOT_FORGET: readonly string[] = Object.freeze([
  'Chaque pièce sous deux angles, en commençant par la porte.',
  'Le tableau électrique, la chaudière ou la pompe à chaleur.',
  'Les rangements : placards, cave, grenier quand il y en a.',
  'Aucune personne, aucune photo de famille, aucun papier lisible dans le cadre.',
  'Aucun numéro de rue, aucune plaque de rue ni d’immatriculation lisible.',
]);

export interface GuideView extends ShotAdvice {
  /** La vue, unique dans le guide du bien : `chambre_2`. */
  key: string;
  mandatory: boolean;
}

/** Ce que le guide lit du bien : seulement ce que le bien et sa fiche disent. */
export interface GuideFacts {
  kind: PropertyKind;
  rooms: number | null;
  bedrooms: number | null;
  outdoor: readonly string[];
  parkingSpaces: number | null;
}

const view = (kind: string, key: string, mandatory: boolean, suffix = ''): GuideView => ({ ...SHOT_ADVICE[kind]!, label: SHOT_ADVICE[kind]!.label + suffix, key, mandatory });

/**
 * Les vues du bien, par des règles écrites : un logement a son entrée, son séjour, sa cuisine, sa salle d'eau, une vue
 * par chambre que la fiche compte, une par extérieur qu'elle porte, le stationnement quand il y en a ; la façade et la
 * vue sont facultatives. Un terrain, un local ou un immeuble ont leurs vues propres.
 */
/** Autant de chambres que la fiche du bien en accepte (M07) : aucune n'est laissée sans sa vue. */
const MAX_BEDROOMS = 50;

export function guideViews(f: GuideFacts): GuideView[] {
  const out: GuideView[] = [];
  if (f.kind === 'land') {
    out.push(view('terrain', 'terrain', true));
    return out;
  }
  if (f.kind === 'commercial' || f.kind === 'business_walls' || f.kind === 'business') {
    out.push(view('local', 'local', true), view('facade', 'facade', false));
    if (f.parkingSpaces !== null && f.parkingSpaces > 0) out.push(view('stationnement', 'stationnement', false));
    return out;
  }
  if (f.kind === 'building') out.push(view('facade', 'facade', true));
  out.push(view('entree', 'entree', true), view('sejour', 'sejour', true), view('cuisine', 'cuisine', true));
  const bedrooms = f.bedrooms ?? 0;
  for (let i = 1; i <= Math.min(bedrooms, MAX_BEDROOMS); i += 1) out.push(view('chambre', `chambre_${i}`, true, bedrooms > 1 ? ` ${i}` : ''));
  out.push(view('salle_d_eau', 'salle_d_eau', true));
  const outdoor = [...new Set(f.outdoor)].filter((o) => ['balcon', 'terrasse', 'jardin', 'cour'].includes(o));
  for (const o of outdoor) out.push(view('exterieur', `exterieur_${o}`, true, ` : ${o}`));
  if (f.parkingSpaces !== null && f.parkingSpaces > 0) out.push(view('stationnement', 'stationnement', true));
  if (f.kind !== 'building') out.push(view('facade', 'facade', false));
  out.push(view('vue', 'vue', false));
  return out;
}

export interface GuideProgress {
  propertyId: string;
  views: (GuideView & { mediaRef: string | null })[];
  missing: string[];
  ready: boolean;
  validated: { by: string; at: string } | null;
  doNotForget: readonly string[];
  /** L'empreinte des vues et des photos retenues, à laquelle une validation est attachée. */
  shotsSha256: string;
}

export type GuideResult<T> = { ok: true; value: T } | { ok: false; rule: 'R16' | 'R10' | null; code: string };

interface PropertyRow {
  id: string;
  network_id: string;
  kind: PropertyKind;
  rooms: number | null;
}

interface SheetData {
  characteristics?: { bedrooms?: unknown; outdoor?: unknown; parkingSpaces?: unknown };
  media?: { ref?: unknown; kind?: unknown; edit?: unknown }[];
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Un guide prêt à valider, tel que la direction le lit : le bien et les vues photographiées, rien d'autre. */
export interface GuideToValidate {
  propertyId: string;
  reference: string;
  city: string | null;
  views: string[];
}
const TO_VALIDATE_SCAN = 200;
const TO_VALIDATE_SHOWN = 50;

export interface GuidePriseDeVueOptions {
  now?: () => Date;
  newId?: () => string;
}

export class GuidePriseDeVue {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: GuidePriseDeVueOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Le guide du bien et son avancement, pour qui voit le bien en entier [R16]. */
  async progress(viewer: Viewer, propertyId: string): Promise<GuideResult<GuideProgress>> {
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    return { ok: true, value: await this.state(seen.value) };
  }

  /** L'agent du bien, ou la direction, retient une photo de la fiche pour une vue du guide. */
  async recordShot(viewer: Viewer, propertyId: string, input: { viewKey: unknown; mediaRef: unknown }): Promise<GuideResult<GuideProgress>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    const state = await this.state(seen.value);
    const actor = `${viewer.role}:${viewer.userId}`;
    const bad = async (code: string): Promise<GuideResult<GuideProgress>> => {
      await appendEvent(this.journal, { type: 'studio.guide.refuse', actor, subject: `property:${propertyId}`, data: { rule: 'R10', code } }, this.now);
      return { ok: false, rule: 'R10', code };
    };
    if (state.validated) return bad('deja_valide');
    if (typeof input.viewKey !== 'string' || !state.views.some((v) => v.key === input.viewKey)) return bad('vue_inconnue');
    const photos = await this.photoRefs(propertyId);
    if (typeof input.mediaRef !== 'string' || !photos.includes(input.mediaRef)) return bad('photo_inconnue');
    await this.db.run('INSERT INTO photo_guide_shots (id, property_id, network_id, view_key, media_ref, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      this.newId(),
      propertyId,
      seen.value.network_id,
      input.viewKey,
      input.mediaRef,
      actor,
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'studio.guide.vue', actor, subject: `property:${propertyId}`, data: { view: input.viewKey } }, this.now);
    return { ok: true, value: await this.state(seen.value) };
  }

  /** La direction valide un bien photographié avec le guide : seulement prêt, une seule fois [R17]. */
  async validate(viewer: Viewer, propertyId: string): Promise<GuideResult<GuideProgress>> {
    if (viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    const state = await this.state(seen.value);
    if (state.validated) return { ok: true, value: state };
    if (!state.ready) return { ok: false, rule: 'R10', code: 'pas_pret' };
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      'INSERT INTO photo_guide_validations (id, property_id, network_id, shots_sha256, validated_by, validated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [this.newId(), propertyId, seen.value.network_id, state.shotsSha256, `direction:${viewer.userId}`, at],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'studio.guide.valide', actor: `direction:${viewer.userId}`, subject: `property:${propertyId}`, data: {} }, this.now);
    return { ok: true, value: await this.state(seen.value) };
  }

  /**
   * Les guides prêts et pas encore validés, le plus ancien d'abord, pour la direction de ce réseau [R16]. Un guide validé
   * garde sa place dans le parcours, et le prêt ne se lit qu'en le recalculant : une validation dont les photos ou les vues
   * ont changé ne vaut plus. La lecture regarde donc un nombre borné de biens et rend `next`, d'où reprendre, tant qu'il en
   * reste à regarder : aucun bien n'est hors d'atteinte. La lecture de chaque bien montré va au journal.
   */
  async toValidate(viewer: Viewer, after: string | null = null): Promise<GuideResult<{ items: GuideToValidate[]; next: string | null }>> {
    if (viewer.role !== 'direction') return this.refused(viewer, '*', 'role');
    let from: [string, string] | null = null;
    if (after !== null) {
      const cut = after.indexOf('|');
      if (cut < 1 || after.length > 120) return { ok: false, rule: 'R10', code: 'bad_cursor' };
      from = [after.slice(0, cut), after.slice(cut + 1)];
    }
    const rows = await this.db.all<PropertyRow & { reference: string; city: string | null; last_shot: string }>(
      `SELECT p.id, p.network_id, p.kind, p.rooms, p.reference, p.city, MAX(s.recorded_at) AS last_shot
       FROM photo_guide_shots s JOIN properties p ON p.id = s.property_id AND p.network_id = s.network_id
       WHERE s.network_id = ? AND p.status IN ('draft', 'available', 'under_offer')
       GROUP BY p.id, p.network_id, p.kind, p.rooms, p.reference, p.city
       ${from ? 'HAVING MAX(s.recorded_at) > ? OR (MAX(s.recorded_at) = ? AND p.id > ?)' : ''}
       ORDER BY last_shot, p.id LIMIT ?`,
      [viewer.networkId, ...(from ? [from[0], from[0], from[1]] : []), TO_VALIDATE_SCAN + 1],
    );
    const items: GuideToValidate[] = [];
    let looked = 0;
    for (const row of rows.slice(0, TO_VALIDATE_SCAN)) {
      if (items.length === TO_VALIDATE_SHOWN) break;
      looked += 1;
      const state = await this.state(row);
      if (!state.ready || state.validated) continue;
      const seen = await this.full(viewer, row.id);
      if (seen.ok) items.push({ propertyId: row.id, reference: row.reference, city: row.city, views: state.views.filter((v) => v.mediaRef !== null).map((v) => v.label) });
    }
    const last = rows[looked - 1];
    return { ok: true, value: { items, next: looked < rows.length && last ? `${last.last_shot}|${last.id}` : null } };
  }

  private async state(p: PropertyRow): Promise<GuideProgress> {
    const sheet = await this.sheet(p.id);
    const c = sheet?.characteristics ?? {};
    const facts: GuideFacts = {
      kind: p.kind,
      rooms: p.rooms,
      bedrooms: typeof c.bedrooms === 'number' && Number.isInteger(c.bedrooms) && c.bedrooms >= 0 ? c.bedrooms : null,
      outdoor: Array.isArray(c.outdoor) ? c.outdoor.filter((o): o is string => typeof o === 'string') : [],
      parkingSpaces: typeof c.parkingSpaces === 'number' && Number.isInteger(c.parkingSpaces) ? c.parkingSpaces : null,
    };
    const views = guideViews(facts);
    const photos = new Set(this.refsOf(sheet));
    const rows = await this.db.all<{ view_key: string; media_ref: string }>('SELECT view_key, media_ref FROM photo_guide_shots WHERE property_id = ? ORDER BY recorded_at, rowid', [p.id]);
    const chosen = new Map<string, string>();
    for (const r of rows) chosen.set(r.view_key, r.media_ref);
    // Une photo retirée de la fiche depuis ne compte plus : la vue redevient à faire.
    const withShots = views.map((v) => {
      const ref = chosen.get(v.key) ?? null;
      return { ...v, mediaRef: ref !== null && photos.has(ref) ? ref : null };
    });
    const missing = withShots.filter((v) => v.mandatory && v.mediaRef === null).map((v) => v.key);
    // La validation vaut pour ces vues et ces photos-là : la fiche ou une photo changée depuis la rend caduque.
    const shotsSha256 = await sha256Hex(withShots.map((v) => `${v.key}${v.mandatory ? '!' : ''}=${v.mediaRef ?? ''}`).join('\n'));
    const ready = missing.length === 0;
    const val = ready
      ? await this.db.first<{ validated_by: string; validated_at: string }>('SELECT validated_by, validated_at FROM photo_guide_validations WHERE property_id = ? AND shots_sha256 = ?', [p.id, shotsSha256])
      : null;
    return { propertyId: p.id, views: withShots, missing, ready, validated: val ? { by: val.validated_by, at: val.validated_at } : null, doNotForget: DO_NOT_FORGET, shotsSha256 };
  }

  private async sheet(propertyId: string): Promise<SheetData | null> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    if (!row) return null;
    try {
      return JSON.parse(row.data) as SheetData;
    } catch {
      return null;
    }
  }

  private refsOf(sheet: SheetData | null): string[] {
    // Une image d'aménagement virtuel ne remplit jamais une vue : le guide compte des prises de vue réelles [R10].
    return (sheet?.media ?? []).filter((m) => m && m.kind === 'photo' && m.edit !== 'amenagement_virtuel' && typeof m.ref === 'string').map((m) => m.ref as string);
  }

  private async photoRefs(propertyId: string): Promise<string[]> {
    return this.refsOf(await this.sheet(propertyId));
  }

  private async full(viewer: Viewer, propertyId: string): Promise<GuideResult<PropertyRow>> {
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    return { ok: true, value: { id: read.value.id, network_id: read.value.network_id, kind: read.value.kind, rooms: read.value.rooms } };
  }

  private async refused<T>(viewer: Viewer, propertyId: string, code: string): Promise<GuideResult<T>> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'photo_guide', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
