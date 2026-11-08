/**
 * Visite à 360 degrés avec contact (M07, M19, HX43) [R46, R499, R500, R501].
 *
 * Comme Hektor, Immofacile, Apimo et Optimhome : une visite 360 faite au téléphone, avec un formulaire de contact dedans.
 * Les images sont prises et assemblées sur l'appareil (R130) ; ici, seulement leur référence, leur empreinte, et la pièce.
 *
 * Jamais vu :
 * - chaque vue est reliée à sa pièce du plan du logement (X04), dans la version du plan qu'elle cite : son nom vient du
 *   plan, écrit par le code (« Chambre 2 »), jamais d'un texte libre ; une vue sans pièce, ou un plan refait depuis,
 *   et elle n'est pas publiée [R499] ;
 * - aucune vue ne montre la rue ni le numéro : seules les pièces intérieures du plan prennent une vue (ni balcon, ni
 *   terrasse, ni garage, ni cave, d'où la rue se voit), et l'agent atteste, vue par vue, ce qu'il ne faut jamais
 *   filmer (P06) [R500] ;
 * - le contact pris dans la visite arrive dans la réception unifiée (C01) comme un formulaire du site, rattaché au bien
 *   par sa référence, rangé une seule fois (R18), et son origine (visite, version, vue) est rangée à côté [R501].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { PublishedMedia } from '../annonces/medias.ts';
import { NEVER_FILM } from '../annonces/medias.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { IngestResult } from '../reception/reception.ts';
import { ROOM_KINDS, type PlanRoom } from '../studio/plan.ts';

/** L'attestation de l'agent, vue par vue : rien de ce qu'il ne faut jamais filmer (P06) n'y est [R500]. */
export const VIEW_ATTESTATION = 'ni_rue_ni_numero' as const;
export const VIEW_ATTESTATION_TEXT = `Sur cette vue, on ne voit ni ${NEVER_FILM.join(', ni ')}.`;
export const MAX_TOUR_VIEWS = 60;
/** L'origine d'un contact pris dans une visite, telle que la fiche du contact la dit. */
export const TOUR_CONTACT_ORIGIN = 'visite_360' as const;

export interface TourView {
  viewRef: string;
  sha256: string;
  /** La pièce du plan cité, par sa place dans le plan ; null tant qu'elle n'est pas rattachée : la vue n'est pas publiée. */
  roomIndex: number | null;
  attestation: typeof VIEW_ATTESTATION;
}

export type TourViewsCheck =
  | { ok: true; value: TourView[] }
  | { ok: false; rule: 'R10' | 'R500'; code: 'vues_invalides' | 'vue_invalide' | 'reference_invalide' | 'empreinte_invalide' | 'vue_en_double' | 'piece_inconnue' | 'piece_exterieure_ou_annexe' | 'sans_attestation'; index: number | null };

const SHA = /^[0-9a-f]{64}$/;
const VIEW_KEYS = new Set(['viewRef', 'sha256', 'roomIndex', 'attestation']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Une image de vue rangée sous le bien lui-même : `biens/<bien>/360/<nom>.jpg`, sans détour ni autre bien. */
export function isViewRef(propertyId: string, ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length > 200) return false;
  const prefix = `biens/${propertyId}/360/`;
  if (!ref.startsWith(prefix)) return false;
  return /^[A-Za-z0-9_-]{1,100}\.(jpg|jpeg|webp)$/.test(ref.slice(prefix.length));
}

/**
 * Contrôle les vues d'une visite contre le plan qu'elles citent : référence sous le bien, empreinte, chacune une fois ;
 * la pièce existe dans le plan [R499] et c'est une pièce intérieure ; l'attestation est donnée pour chaque vue [R500].
 */
export function checkTourViews(propertyId: string, input: unknown, rooms: readonly PlanRoom[]): TourViewsCheck {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TOUR_VIEWS) return { ok: false, rule: 'R10', code: 'vues_invalides', index: null };
  const refs = new Set<string>();
  const shas = new Set<string>();
  const out: TourView[] = [];
  for (const [i, raw] of input.entries()) {
    if (!isRecord(raw) || Object.keys(raw).some((k) => !VIEW_KEYS.has(k))) return { ok: false, rule: 'R10', code: 'vue_invalide', index: i };
    if (!isViewRef(propertyId, raw.viewRef)) return { ok: false, rule: 'R10', code: 'reference_invalide', index: i };
    if (typeof raw.sha256 !== 'string' || !SHA.test(raw.sha256)) return { ok: false, rule: 'R10', code: 'empreinte_invalide', index: i };
    if (refs.has(raw.viewRef) || shas.has(raw.sha256)) return { ok: false, rule: 'R10', code: 'vue_en_double', index: i };
    refs.add(raw.viewRef);
    shas.add(raw.sha256);
    const roomIndex = raw.roomIndex ?? null;
    if (roomIndex !== null) {
      if (typeof roomIndex !== 'number' || !Number.isInteger(roomIndex) || roomIndex < 0 || roomIndex >= rooms.length) return { ok: false, rule: 'R10', code: 'piece_inconnue', index: i };
      if (!ROOM_KINDS[rooms[roomIndex]!.kind].inside) return { ok: false, rule: 'R500', code: 'piece_exterieure_ou_annexe', index: i };
    }
    if (raw.attestation !== VIEW_ATTESTATION) return { ok: false, rule: 'R500', code: 'sans_attestation', index: i };
    out.push({ viewRef: raw.viewRef, sha256: raw.sha256, roomIndex, attestation: VIEW_ATTESTATION });
  }
  return { ok: true, value: out };
}

/** Le nom de chaque pièce du plan, écrit par le code : « Chambre 1 », « Chambre 2 » quand il y en a plusieurs. */
export function roomNames(rooms: readonly PlanRoom[]): string[] {
  const total = new Map<string, number>();
  for (const r of rooms) total.set(r.kind, (total.get(r.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  return rooms.map((r) => {
    const n = (seen.get(r.kind) ?? 0) + 1;
    seen.set(r.kind, n);
    const label = ROOM_KINDS[r.kind].label;
    return (total.get(r.kind) ?? 0) > 1 ? `${label} ${n}` : label;
  });
}

export type ViewStatus = 'publiee' | 'sans_piece' | 'plan_refait';

export interface TourViewOut {
  viewRef: string;
  roomIndex: number | null;
  /** Le nom de la pièce dans le plan cité, ou null. */
  room: string | null;
  status: ViewStatus;
}

/** Les vues d'une visite et ce qui se publie : seules les vues rattachées à une pièce du plan du moment [R499]. */
export function tourViewsOut(views: readonly TourView[], rooms: readonly PlanRoom[], planVersion: number, currentPlanVersion: number | null): TourViewOut[] {
  const names = roomNames(rooms);
  return views.map((v) => {
    const room = v.roomIndex === null ? null : (names[v.roomIndex] ?? null);
    const status: ViewStatus = v.roomIndex === null ? 'sans_piece' : planVersion !== currentPlanVersion ? 'plan_refait' : 'publiee';
    return { viewRef: v.viewRef, roomIndex: v.roomIndex, room, status };
  });
}

export interface VirtualTour {
  propertyId: string;
  tourRef: string;
  version: number;
  planVersion: number;
  views: TourViewOut[];
  /** Combien de vues se publient ; la visite elle-même ne se publie pas sans au moins une. */
  publishedViews: number;
  createdAt: string;
}

/** Ce qu'un visiteur voit : les vues publiées, nommées par leur pièce ; rien qui situe le bien, ni l'agent, ni le prix. */
export interface PublicTour {
  tourRef: string;
  version: number;
  views: { viewRef: string; room: string }[];
  contact: { fields: readonly ['firstName', 'email', 'phone', 'message'] };
}

/** Les médias publiés du bien à cet instant (P06, `MediasBien.publishable` sur la version publiée). */
export interface PublishedMediaSource {
  current(propertyId: string): Promise<PublishedMedia[]>;
}

/** La réception unifiée (C01) : le contact y entre comme un formulaire du site. */
export interface InboundIntake {
  ingest(networkId: string, source: 'site_form', raw: unknown): Promise<IngestResult>;
}

export type TourResult<T> = { ok: true; value: T } | { ok: false; rule: 'R16' | 'R10' | 'R499' | 'R500' | 'R501'; code: string; index?: number | null };

export interface ContactOrigin {
  origin: typeof TOUR_CONTACT_ORIGIN;
  propertyId: string;
  tourRef: string;
  tourVersion: number;
  viewRef: string;
  room: string | null;
  receivedAt: string;
}

interface TourRow {
  id: string;
  network_id: string;
  property_id: string;
  tour_ref: string;
  version: number;
  plan_version: number;
  views: string;
  created_at: string;
}

const SUBMISSION = /^[A-Za-z0-9_-]{8,100}$/;
const CONTACT_KEYS = new Set(['tourRef', 'viewRef', 'submissionId', 'firstName', 'email', 'phone', 'message', 'submittedAt']);
const MAX_MESSAGE = 2000;

export interface VisitesVirtuellesOptions {
  now?: () => Date;
  newId?: () => string;
}

export class VisitesVirtuelles {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly published: PublishedMediaSource,
    private readonly reception: InboundIntake,
    options: VisitesVirtuellesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * L'agent du bien, ou la direction, range les vues d'une visite : elles citent le dernier plan du logement (X04), et
   * la visite doit être un média « visite virtuelle » de la fiche du bien. Chaque saisie fait une nouvelle version.
   */
  async save(viewer: Viewer, propertyId: string, input: { tourRef: unknown; views: unknown }): Promise<TourResult<VirtualTour>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    const actor = `${viewer.role}:${viewer.userId}`;
    const bad = async (rule: 'R10' | 'R499' | 'R500', code: string, index: number | null = null): Promise<TourResult<VirtualTour>> => {
      await appendEvent(this.journal, { type: 'medias.visite360.refuse', actor, subject: `property:${propertyId}`, data: { rule, code } }, this.now);
      return { ok: false, rule, code, index };
    };
    if (typeof input.tourRef !== 'string' || !(await this.sheetTours(propertyId)).has(input.tourRef)) return bad('R10', 'visite_inconnue');
    const plan = await this.db.first<{ version: number; rooms: string }>('SELECT version, rooms FROM floor_plans WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    // Sans plan du logement, aucune vue ne peut être reliée à sa pièce [R499].
    if (!plan) return bad('R499', 'sans_plan');
    const rooms = JSON.parse(plan.rooms) as PlanRoom[];
    const checked = checkTourViews(propertyId, input.views, rooms);
    if (!checked.ok) return bad(checked.rule, checked.code, checked.index);
    const views = JSON.stringify(checked.value);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM virtual_tours WHERE property_id = ? AND tour_ref = ?', [propertyId, input.tourRef]);
      const version = (last?.v ?? 0) + 1;
      const at = this.now().toISOString();
      const { changes } = await this.db.run(
        `INSERT INTO virtual_tours (id, network_id, property_id, tour_ref, version, plan_version, views, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [this.newId(), read.value.network_id, propertyId, input.tourRef, version, plan.version, views, actor, at],
      );
      if (changes === 1) {
        const out = this.build({ id: '', network_id: read.value.network_id, property_id: propertyId, tour_ref: input.tourRef, version, plan_version: plan.version, views, created_at: at }, rooms, plan.version);
        await appendEvent(this.journal, { type: 'medias.visite360.version', actor, subject: `property:${propertyId}`, data: { rule: 'R499', version, views: out.views.length, published: out.publishedViews } }, this.now);
        return { ok: true, value: out };
      }
    }
    return bad('R10', 'conflit_de_version');
  }

  /** La dernière version d'une visite, vue par vue, avec ce qui se publie et pourquoi, pour qui voit le bien en entier. */
  async current(viewer: Viewer, propertyId: string, tourRef: string): Promise<TourResult<VirtualTour | null>> {
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    const row = await this.lastTour(propertyId, tourRef);
    if (!row) return { ok: true, value: null };
    return { ok: true, value: await this.withPlan(row) };
  }

  /**
   * La visite telle qu'un visiteur la voit : seulement si la fiche publiée du bien la porte à cet instant (P06), et
   * seulement ses vues rattachées à une pièce du plan du moment [R499]. Sinon, rien.
   */
  async publicTour(propertyId: string, tourRef: string): Promise<PublicTour | null> {
    const found = await this.publishedTour(propertyId, tourRef);
    if (!found) return null;
    return {
      tourRef,
      version: found.tour.version,
      views: found.views.map((v) => ({ viewRef: v.viewRef, room: v.room! })),
      contact: { fields: ['firstName', 'email', 'phone', 'message'] as const },
    };
  }

  /**
   * Un visiteur écrit depuis une vue de la visite publiée : le message entre dans la réception unifiée (C01) comme un
   * formulaire du site, rattaché au bien par sa référence, rangé une seule fois même envoyé deux fois (R18) ; son
   * origine, la visite, sa version et la vue, est rangée à côté [R501]. Un e-mail ou un téléphone est exigé.
   */
  async contact(propertyId: string, input: unknown): Promise<TourResult<{ inboundId: string; duplicate: boolean }>> {
    const refuse = async (rule: 'R10' | 'R499' | 'R501', code: string): Promise<TourResult<{ inboundId: string; duplicate: boolean }>> => {
      await appendEvent(this.journal, { type: 'medias.visite360.contact_refuse', actor: 'visiteur', subject: `property:${propertyId}`, data: { rule, code } }, this.now);
      return { ok: false, rule, code };
    };
    if (!isRecord(input) || Object.keys(input).some((k) => !CONTACT_KEYS.has(k))) return refuse('R10', 'contact_invalide');
    if (typeof input.tourRef !== 'string' || typeof input.viewRef !== 'string') return refuse('R10', 'contact_invalide');
    if (typeof input.submissionId !== 'string' || !SUBMISSION.test(input.submissionId)) return refuse('R10', 'contact_invalide');
    for (const k of ['firstName', 'email', 'phone', 'message', 'submittedAt'] as const) {
      if (input[k] !== undefined && input[k] !== null && typeof input[k] !== 'string') return refuse('R10', 'contact_invalide');
    }
    if (typeof input.message === 'string' && input.message.length > MAX_MESSAGE) return refuse('R10', 'message_trop_long');
    const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
    if (!filled(input.email) && !filled(input.phone)) return refuse('R501', 'sans_coordonnees');
    const found = await this.publishedTour(propertyId, input.tourRef);
    if (!found) return refuse('R499', 'visite_non_publiee');
    // Le contact part d'une vue publiée de cette visite, jamais d'une vue retirée ou d'une autre visite [R499].
    if (!found.views.some((v) => v.viewRef === input.viewRef)) return refuse('R499', 'vue_non_publiee');
    const property = await this.db.first<{ network_id: string; reference: string }>('SELECT network_id, reference FROM properties WHERE id = ?', [propertyId]);
    if (!property) return refuse('R10', 'bien_inconnu');
    const result = await this.reception.ingest(property.network_id, 'site_form', {
      submissionId: `visite360-${input.submissionId}`,
      firstName: input.firstName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      message: input.message ?? '',
      propertyRef: property.reference,
      submittedAt: input.submittedAt ?? this.now().toISOString(),
    });
    const received = result.received[0];
    if (!received || received.outcome === 'unreadable') return refuse('R501', 'contact_illisible');
    await this.db.run(
      'INSERT INTO virtual_tour_contacts (inbound_id, network_id, property_id, tour_id, view_ref, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [received.inboundId, property.network_id, propertyId, found.tour.id, input.viewRef, this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'medias.visite360.contact', actor: 'visiteur', subject: `property:${propertyId}`, data: { rule: 'R501', outcome: received.outcome, version: found.tour.version } },
      this.now,
    );
    return { ok: true, value: { inboundId: received.inboundId, duplicate: received.outcome === 'duplicate' } };
  }

  /** L'origine d'un message reçu, quand il a été pris dans une visite : pour qui voit le bien en entier [R16, R501]. */
  async origin(viewer: Viewer, inboundId: string): Promise<TourResult<ContactOrigin | null>> {
    const row = await this.db.first<{ property_id: string; view_ref: string; created_at: string; tour_ref: string; version: number; plan_version: number; views: string; received_at: string }>(
      `SELECT c.property_id, c.view_ref, c.created_at, t.tour_ref, t.version, t.plan_version, t.views, m.received_at
       FROM virtual_tour_contacts c JOIN virtual_tours t ON t.id = c.tour_id JOIN inbound_messages m ON m.id = c.inbound_id
       WHERE c.inbound_id = ? AND c.network_id = ?`,
      [inboundId, viewer.networkId],
    );
    if (!row) return { ok: true, value: null };
    const read = await this.acces.readProperty(viewer, row.property_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, row.property_id, 'not_assigned');
    const plan = await this.db.first<{ rooms: string }>('SELECT rooms FROM floor_plans WHERE property_id = ? AND version = ?', [row.property_id, row.plan_version]);
    const rooms = plan ? (JSON.parse(plan.rooms) as PlanRoom[]) : [];
    const view = (JSON.parse(row.views) as TourView[]).find((v) => v.viewRef === row.view_ref);
    const room = view && view.roomIndex !== null ? (roomNames(rooms)[view.roomIndex] ?? null) : null;
    return { ok: true, value: { origin: TOUR_CONTACT_ORIGIN, propertyId: row.property_id, tourRef: row.tour_ref, tourVersion: row.version, viewRef: row.view_ref, room, receivedAt: row.received_at } };
  }

  private async publishedTour(propertyId: string, tourRef: string): Promise<{ tour: TourRow; views: TourViewOut[] } | null> {
    const media = await this.published.current(propertyId);
    if (!media.some((m) => m.kind === 'visite_virtuelle' && m.ref === tourRef)) return null;
    const row = await this.lastTour(propertyId, tourRef);
    if (!row) return null;
    const views = (await this.withPlan(row)).views.filter((v) => v.status === 'publiee');
    return views.length === 0 ? null : { tour: row, views };
  }

  private async lastTour(propertyId: string, tourRef: string): Promise<TourRow | null> {
    return this.db.first<TourRow>('SELECT id, network_id, property_id, tour_ref, version, plan_version, views, created_at FROM virtual_tours WHERE property_id = ? AND tour_ref = ? ORDER BY version DESC LIMIT 1', [propertyId, tourRef]);
  }

  private async withPlan(row: TourRow): Promise<VirtualTour> {
    const plan = await this.db.first<{ rooms: string }>('SELECT rooms FROM floor_plans WHERE property_id = ? AND version = ?', [row.property_id, row.plan_version]);
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM floor_plans WHERE property_id = ?', [row.property_id]);
    return this.build(row, plan ? (JSON.parse(plan.rooms) as PlanRoom[]) : [], last?.v ?? null);
  }

  private build(row: TourRow, rooms: readonly PlanRoom[], currentPlanVersion: number | null): VirtualTour {
    const views = tourViewsOut(JSON.parse(row.views) as TourView[], rooms, row.plan_version, currentPlanVersion);
    return {
      propertyId: row.property_id,
      tourRef: row.tour_ref,
      version: row.version,
      planVersion: row.plan_version,
      views,
      publishedViews: views.filter((v) => v.status === 'publiee').length,
      createdAt: row.created_at,
    };
  }

  /** Les visites virtuelles que porte la dernière fiche du bien. */
  private async sheetTours(propertyId: string): Promise<Set<string>> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    const out = new Set<string>();
    if (!row) return out;
    let media: unknown;
    try {
      const data = JSON.parse(row.data) as unknown;
      media = isRecord(data) ? data.media : null;
    } catch {
      media = null;
    }
    if (!Array.isArray(media)) return out;
    for (const m of media) if (isRecord(m) && m.kind === 'visite_virtuelle' && typeof m.ref === 'string') out.add(m.ref);
    return out;
  }

  private async refused<T>(viewer: Viewer, propertyId: string, code: string): Promise<TourResult<T>> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'virtual_tour', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
