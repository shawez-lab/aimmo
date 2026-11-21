/**
 * L'appli sans réseau, côté serveur (HX12) [R276, R277, R278].
 *
 * - Le paquet du jour : avant de partir, le téléphone garde les visites et estimations du jour de l'agent, chacune avec
 *   la fiche du bien (référence, sorte, commune, surface, pièces) et sa liste de photos. Jamais le nom, le numéro, le mail
 *   ni l'adresse d'un client : un téléphone perdu ne livre personne. Le paquet ne vaut que jusqu'à la fin du jour de
 *   Paris [R278].
 * - La réception : au retour du réseau, les saisies arrivent avec l'identifiant tiré par le téléphone. Chacune est
 *   reçue une seule fois ; rejouée, elle rend la même réponse sans rien refaire ; un autre contenu sous le même
 *   identifiant est refusé, jamais écrit par-dessus [R276]. Une photo est jugée de nouveau ici, sur les prises réduites
 *   envoyées : le verdict du téléphone ne compte pas [R277].
 * - Le départ : la liste de cadrage du bien dit ce qui manque encore ; l'agent ne repart pas tant qu'une photo n'est ni
 *   acceptée ni dite sans objet [R277].
 * - Rien n'est envoyé à personne.
 */
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { sha256Of } from '../conformite/demandes-personnes.ts';
import type { SqlDatabase, SqlStatement, SqlValue } from '../db/sql.ts';
import { runBatch } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { parisDayStart } from '../pilotage/tableau-agent.ts';
import { parisDay } from '../studio/bibliotheque.ts';
import { OP_KINDS, type OpKind, type OpResult } from './boite.ts';
import { SKIP_REASONS, departureCheck, shotPlan, type DepartureCheck, type Shot } from './cadrage.ts';
import { checkKeptImage, fileShowsKept, IMAGE_TYPE, matchesKept } from './image.ts';
import { decodeLuma, encodeLuma, hdrPhoto, PHOTO_THRESHOLDS, type Luma, type PhotoThresholds } from './photo.ts';
import { privateVisits, type PrivatePack } from './prive.ts';

export const MAX_OPS_PER_BATCH = 50;
export const MAX_NOTE_LENGTH = 2000;
/** Une saisie plus vieille que tant de jours n'est plus reçue. */
export const MAX_OP_AGE_DAYS = 30;
/** L'horloge du téléphone peut avancer de tant de minutes, pas plus. */
export const MAX_CLOCK_SKEW_MINUTES = 5;
const DAY = 86_400_000;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const VISIT_KINDS: ReadonlySet<string> = new Set(['visite', 'estimation']);

type Refusal = { ok: false; rule: 'R16'; code: string };

/** Ce que le téléphone garde pour une visite ou une estimation : rien d'un client [R278]. */
export interface PackedAppointment {
  appointmentId: string;
  kind: 'visite' | 'estimation';
  start: string;
  end: string;
  property: { reference: string; kind: string; city: string | null; postalCode: string | null; surfaceM2: number | null; rooms: number | null } | null;
  shots: Shot[];
  accepted: string[];
  skipped: string[];
}

export interface OfflinePack {
  day: string;
  /** Après cette heure, le téléphone efface le paquet. */
  validUntil: string;
  appointments: PackedAppointment[];
}

interface AppointmentRow {
  id: string;
  agent_id: string;
  property_id: string | null;
  kind: string;
  status: string;
  start_at: string;
  end_at: string;
}

interface PropertyRow {
  reference: string;
  kind: string;
  city: string | null;
  postal_code: string | null;
  surface_m2: number | null;
  rooms: number | null;
}

interface StoredOp {
  content_hash: string;
  outcome: 'applique' | 'refuse';
  rule: string | null;
  code: string | null;
}

export interface HorsLigneOptions {
  now?: () => Date;
  thresholds?: PhotoThresholds;
}

/** Ce que la saisie range, si elle est reçue : une ligne d'une table, écrite seulement par l'envoi qui a gagné la saisie. */
interface EntityRow {
  table: 'visit_field_notes' | 'visit_shot_skips' | 'visit_photos';
  columns: readonly string[];
  values: SqlValue[];
}

type Verdict = { ok: true; row: EntityRow } | { ok: false; rule: string | null; code: string };

/** Le rangement des images entières des visites (R2) : à part des médias publiés, rien n'y est servi au public. */
export interface VisitImageStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** L'image réduite gardée à la réception (taille dans le texte : largeur, hauteur, points) et le fichier qui la montre. */
function keptShown(bytes: Uint8Array, stored: string | null): boolean {
  if (stored === null) return false;
  const [w, h, data] = stored.split(':');
  const kept = decodeLuma({ width: Number(w), height: Number(h), data });
  return kept !== null && fileShowsKept(bytes, kept);
}

export type DepositResult = { ok: true; again: boolean } | Refusal | { ok: false; rule: 'R677' | null; code: string };

export class HorsLigne {
  private readonly now: () => Date;
  private readonly thresholds: PhotoThresholds;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: HorsLigneOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.thresholds = options.thresholds ?? PHOTO_THRESHOLDS;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'hors_ligne', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Un agent du réseau, en activité : seul lui saisit hors ligne. */
  private async activeAgent(viewer: Viewer, subject: string): Promise<Refusal | null> {
    if (viewer.role !== 'agent') return this.refuse(viewer, subject, 'role');
    const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!a || (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'actif') return this.refuse(viewer, subject, 'agent_inactive');
    return null;
  }

  private async appointment(networkId: string, id: string): Promise<AppointmentRow | null> {
    return this.db.first<AppointmentRow>('SELECT id, agent_id, property_id, kind, status, start_at, end_at FROM appointments WHERE id = ? AND network_id = ?', [id, networkId]);
  }

  /** La fiche du bien, réduite à ce qui sert au cadrage : jamais l'adresse ni le vendeur [R278]. */
  private async property(networkId: string, id: string | null): Promise<PropertyRow | null> {
    if (!id) return null;
    return this.db.first<PropertyRow>('SELECT reference, kind, city, postal_code, surface_m2, rooms FROM properties WHERE id = ? AND network_id = ?', [id, networkId]);
  }

  private async shotsDone(networkId: string, appointmentId: string): Promise<{ accepted: string[]; skipped: string[] }> {
    const accepted = await this.db.all<{ shot: string }>('SELECT DISTINCT shot FROM visit_photos WHERE network_id = ? AND appointment_id = ? ORDER BY shot', [networkId, appointmentId]);
    const skipped = await this.db.all<{ shot: string }>('SELECT DISTINCT shot FROM visit_shot_skips WHERE network_id = ? AND appointment_id = ? ORDER BY shot', [networkId, appointmentId]);
    return { accepted: accepted.map((r) => r.shot), skipped: skipped.map((r) => r.shot) };
  }

  /** Le paquet du jour de Paris, pour le téléphone de l'agent : ses visites et estimations prévues, sans client [R278]. */
  async pack(viewer: Viewer, dayInput?: unknown): Promise<{ ok: true; pack: OfflinePack } | Refusal | { ok: false; rule: null; code: string }> {
    const refused = await this.activeAgent(viewer, `agent:${viewer.userId}`);
    if (refused) return refused;
    const today = parisDay(this.now());
    const day = dayInput === undefined ? today : dayInput;
    // Seulement aujourd'hui ou demain : un paquet ne traîne pas sur un téléphone.
    const tomorrow = parisDay(new Date(parisDayStart(today).getTime() + DAY + 3 * 3_600_000));
    if (day !== today && day !== tomorrow) return { ok: false, rule: null, code: 'bad_day' };
    const from = parisDayStart(day as string);
    const next = parisDayStart(parisDay(new Date(from.getTime() + DAY + 3 * 3_600_000)));
    const rows = await this.db.all<AppointmentRow>(
      `SELECT id, agent_id, property_id, kind, status, start_at, end_at FROM appointments
        WHERE network_id = ? AND agent_id = ? AND status = 'booked' AND kind IN ('visite', 'estimation') AND start_at >= ? AND start_at < ?
        ORDER BY start_at, id`,
      [viewer.networkId, viewer.userId, from.toISOString(), next.toISOString()],
    );
    const appointments: PackedAppointment[] = [];
    for (const a of rows) {
      const p = await this.property(viewer.networkId, a.property_id);
      const done = await this.shotsDone(viewer.networkId, a.id);
      appointments.push({
        appointmentId: a.id,
        kind: a.kind as 'visite' | 'estimation',
        start: a.start_at,
        end: a.end_at,
        property: p ? { reference: p.reference, kind: p.kind, city: p.city, postalCode: p.postal_code, surfaceM2: p.surface_m2, rooms: p.rooms } : null,
        shots: p ? shotPlan(p.kind, p.rooms) : [],
        accepted: done.accepted,
        skipped: done.skipped,
      });
    }
    await appendEvent(this.journal, { type: 'hors_ligne.paquet', actor: this.actor(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R278', day, count: appointments.length } }, this.now);
    return { ok: true, pack: { day: day as string, validUntil: next.toISOString(), appointments } };
  }

  /**
   * Le mode privé du jour, sur le geste de l'agent : pour ses visites et estimations d'aujourd'hui encore à venir ou en
   * cours, l'adresse du bien et le nom et un numéro de la personne rencontrée, rien d'autre. Aujourd'hui seulement, jamais
   * demain : rien d'un client ne passe la nuit sur un téléphone. La lecture est au journal avant d'être rendue, sans
   * aucune donnée : les rendez-vous et le nombre d'adresses et de numéros [R676, R16, R13].
   */
  async privatePack(viewer: Viewer): Promise<{ ok: true; pack: PrivatePack } | Refusal> {
    const refused = await this.activeAgent(viewer, `agent:${viewer.userId}`);
    if (refused) return refused;
    const now = this.now();
    const day = parisDay(now);
    const from = parisDayStart(day);
    const next = parisDayStart(parisDay(new Date(from.getTime() + DAY + 3 * 3_600_000)));
    const visits = await privateVisits(this.db, viewer.networkId, viewer.userId, from, next, now);
    await appendEvent(
      this.journal,
      {
        type: 'hors_ligne.prive',
        actor: this.actor(viewer),
        subject: `agent:${viewer.userId}`,
        data: {
          rule: 'R676',
          day,
          appointments: visits.map((v) => v.appointmentId),
          addresses: visits.filter((v) => v.address).length,
          phones: visits.filter((v) => v.contact.phone).length,
        },
      },
      this.now,
    );
    const validUntil = visits.length ? visits.map((v) => v.wipeAt).sort().at(-1)! : now.toISOString();
    return { ok: true, pack: { day, validUntil, visits } };
  }

  /** Ce qui manque avant de repartir, pour une visite ou une estimation de l'agent [R277]. */
  async departure(viewer: Viewer, appointmentId: string): Promise<{ ok: true; check: DepartureCheck } | Refusal | { ok: false; rule: null; code: string }> {
    const subject = `appointment:${appointmentId}`;
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, subject, 'role');
    const a = await this.appointment(viewer.networkId, appointmentId);
    if (!a) return { ok: false, rule: null, code: 'unknown_appointment' };
    if (viewer.role === 'agent' && a.agent_id !== viewer.userId) return this.refuse(viewer, subject, 'pas_son_rendez_vous');
    const p = await this.property(viewer.networkId, a.property_id);
    if (!p || !VISIT_KINDS.has(a.kind)) return { ok: false, rule: null, code: 'sans_bien' };
    const done = await this.shotsDone(viewer.networkId, a.id);
    return { ok: true, check: departureCheck(shotPlan(p.kind, p.rooms), done.accepted, done.skipped) };
  }

  /**
   * Recevoir les saisies d'un téléphone, dans leur ordre. Chaque saisie a sa réponse ; une coupure en plein envoi ne
   * perd rien, puisque le téléphone ne retire que ce qui a une réponse, et le même envoi rejoué ne fait aucun doublon
   * [R276].
   */
  async receive(viewer: Viewer, input: { deviceId?: unknown; ops?: unknown }): Promise<{ ok: true; results: OpResult[] } | Refusal | { ok: false; rule: null; code: string }> {
    const refused = await this.activeAgent(viewer, `agent:${viewer.userId}`);
    if (refused) return refused;
    if (typeof input.deviceId !== 'string' || !ID.test(input.deviceId)) return { ok: false, rule: null, code: 'bad_device' };
    if (!Array.isArray(input.ops) || input.ops.length > MAX_OPS_PER_BATCH) return { ok: false, rule: null, code: 'bad_batch' };
    const deviceId = input.deviceId;
    const raw = input.ops as unknown[];
    const ordered = raw
      .map((op, i) => ({ op, i, seq: typeof op === 'object' && op !== null && Number.isInteger((op as { seq?: unknown }).seq) ? ((op as { seq: number }).seq) : Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.seq - b.seq || a.i - b.i);
    const results: OpResult[] = [];
    for (const { op } of ordered) results.push(await this.receiveOne(viewer, deviceId, op));
    return { ok: true, results };
  }

  private async stored(viewer: Viewer, deviceId: string, opId: string): Promise<StoredOp | null> {
    return this.db.first<StoredOp>(
      'SELECT content_hash, outcome, rule, code FROM offline_ops WHERE network_id = ? AND agent_id = ? AND device_id = ? AND op_id = ?',
      [viewer.networkId, viewer.userId, deviceId, opId],
    );
  }

  private async receiveOne(viewer: Viewer, deviceId: string, input: unknown): Promise<OpResult> {
    const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const opId = typeof o.opId === 'string' ? o.opId : '';
    const bad: OpResult = { opId, outcome: 'refuse', again: false, code: 'saisie_invalide', rule: 'R276' };
    if (!ID.test(opId) || !Number.isInteger(o.seq) || (o.seq as number) < 1) return bad;
    if (typeof o.kind !== 'string' || !(OP_KINDS as readonly string[]).includes(o.kind)) return bad;
    if (typeof o.appointmentId !== 'string' || !ID.test(o.appointmentId)) return bad;
    if (typeof o.writtenAt !== 'string' || Number.isNaN(Date.parse(o.writtenAt))) return bad;
    if (typeof o.payload !== 'object' || o.payload === null || Array.isArray(o.payload)) return bad;
    const kind = o.kind as OpKind;
    const appointmentId = o.appointmentId;
    const writtenAt = new Date(Date.parse(o.writtenAt)).toISOString();
    const payload = o.payload as Record<string, unknown>;
    const hash = await sha256Of({ kind, appointmentId, seq: o.seq, writtenAt, payload });

    const answer = (s: StoredOp): OpResult =>
      s.content_hash === hash
        ? { opId, outcome: s.outcome, again: true, code: s.code, rule: s.rule }
        : { opId, outcome: 'refuse', again: false, code: 'conflit', rule: 'R276' };
    const before = await this.stored(viewer, deviceId, opId);
    if (before) return answer(before);

    const now = this.now();
    const entityId = await sha256Of({ n: viewer.networkId, a: viewer.userId, d: deviceId, o: opId });
    const verdict = await this.evaluate(viewer, entityId, kind, appointmentId, writtenAt, payload, now);
    const outcome = verdict.ok ? 'applique' : 'refuse';
    const rule = verdict.ok ? 'R276' : verdict.rule;
    const code = verdict.ok ? null : verdict.code;
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO offline_ops (network_id, agent_id, device_id, op_id, seq, kind, appointment_id, content_hash, outcome, rule, code, written_at, received_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        params: [viewer.networkId, viewer.userId, deviceId, opId, o.seq as number, kind, appointmentId, hash, outcome, rule, code, writtenAt, now.toISOString()],
      },
    ];
    if (verdict.ok) {
      // L'écriture n'a lieu que si cette saisie, avec ce contenu, vient d'être gagnée : un envoi concurrent sous le même
      // identifiant, d'un autre contenu, n'écrit rien [R276].
      const { table, columns, values } = verdict.row;
      statements.push({
        sql: `INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')}
               WHERE EXISTS (SELECT 1 FROM offline_ops WHERE network_id = ? AND agent_id = ? AND device_id = ? AND op_id = ? AND content_hash = ? AND outcome = 'applique' AND received_at = ?)
               ON CONFLICT (id) DO NOTHING`,
        params: [...values, viewer.networkId, viewer.userId, deviceId, opId, hash, now.toISOString()],
      });
    }
    // Une panne de la base fait échouer tout l'envoi : aucune réponse, donc le téléphone garde la saisie et la renverra.
    // Ce qui a été reçu avant dans le même envoi sera reconnu au renvoi, sans doublon [R276].
    const [first] = await runBatch(this.db, statements);
    if (!first || first.changes === 0) {
      // Le même identifiant reçu au même moment par un autre envoi : on rend sa réponse à lui.
      const again = await this.stored(viewer, deviceId, opId);
      if (again) return answer(again);
    }
    await appendEvent(this.journal, { type: verdict.ok ? 'hors_ligne.recu' : 'hors_ligne.refuse', actor: this.actor(viewer), subject: `appointment:${appointmentId}`, data: { rule: rule ?? 'R276', kind, code } }, this.now);
    return { opId, outcome, again: false, code, rule };
  }

  private async evaluate(viewer: Viewer, entityId: string, kind: OpKind, appointmentId: string, writtenAt: string, payload: Record<string, unknown>, now: Date): Promise<Verdict> {
    const at = Date.parse(writtenAt);
    if (at > now.getTime() + MAX_CLOCK_SKEW_MINUTES * 60_000 || at < now.getTime() - MAX_OP_AGE_DAYS * DAY) return { ok: false, rule: 'R276', code: 'heure_invalide' };
    const a = await this.appointment(viewer.networkId, appointmentId);
    if (!a || a.agent_id !== viewer.userId) return { ok: false, rule: 'R16', code: 'pas_son_rendez_vous' };
    if (!VISIT_KINDS.has(a.kind)) return { ok: false, rule: null, code: 'mauvais_rendez_vous' };
    if (a.status === 'cancelled') return { ok: false, rule: null, code: 'rendez_vous_annule' };
    const p = await this.property(viewer.networkId, a.property_id);
    const plan = p ? shotPlan(p.kind, p.rooms) : [];
    const inPlan = (v: unknown): v is string => typeof v === 'string' && plan.some((s) => s.key === v);
    const received = now.toISOString();
    if (kind === 'visite.note') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (text.length === 0 || [...text].length > MAX_NOTE_LENGTH) return { ok: false, rule: null, code: 'bad_note' };
      if (payload.shot !== undefined && payload.shot !== null && !inPlan(payload.shot)) return { ok: false, rule: null, code: 'bad_shot' };
      const shot = inPlan(payload.shot) ? payload.shot : null;
      return {
        ok: true,
        row: { table: 'visit_field_notes', columns: ['id', 'network_id', 'appointment_id', 'agent_id', 'shot', 'body', 'written_at', 'received_at'], values: [entityId, viewer.networkId, appointmentId, viewer.userId, shot, text, writtenAt, received] },
      };
    }
    if (!p) return { ok: false, rule: null, code: 'sans_bien' };
    if (!inPlan(payload.shot)) return { ok: false, rule: 'R277', code: 'bad_shot' };
    const shot = payload.shot;
    if (kind === 'visite.sans_objet') {
      if (typeof payload.reason !== 'string' || !(SKIP_REASONS as readonly string[]).includes(payload.reason)) return { ok: false, rule: 'R277', code: 'bad_reason' };
      return {
        ok: true,
        row: { table: 'visit_shot_skips', columns: ['id', 'network_id', 'appointment_id', 'agent_id', 'shot', 'reason', 'written_at', 'received_at'], values: [entityId, viewer.networkId, appointmentId, viewer.userId, shot, payload.reason, writtenAt, received] },
      };
    }
    // La photo : les prises réduites, décodées puis fondues et jugées ici, comme sur le téléphone [R277].
    const exposures = Array.isArray(payload.exposures) ? payload.exposures.map(decodeLuma) : null;
    if (!exposures || exposures.some((e) => e === null)) return { ok: false, rule: 'R277', code: 'prises_invalides' };
    const r = hdrPhoto(exposures, this.thresholds);
    if (!r.ok) return { ok: false, rule: 'R277', code: r.code === 'photo_refusee' ? (r.verdict?.problems[0] ?? 'photo_refusee') : r.code };
    // L'image gardée, celle qui ira à l'annonce : jugée de nouveau ici sur sa version réduite, et reconnue comme la
    // fusion des prises [R677].
    const kept = checkKeptImage(payload.image, exposures as Luma[], this.thresholds);
    if (!kept.ok) return kept;
    const i = kept.image;
    return {
      ok: true,
      row: {
        table: 'visit_photos',
        columns: ['id', 'network_id', 'appointment_id', 'agent_id', 'shot', 'exposures', 'brightness', 'clipped', 'sharpness', 'taken_at', 'received_at', 'image_sha256', 'image_width', 'image_height', 'image_bytes', 'kept_brightness', 'kept_clipped', 'kept_sharpness', 'kept_luma'],
        values: [entityId, viewer.networkId, appointmentId, viewer.userId, shot, r.exposures, r.verdict.figures.brightness, r.verdict.figures.clipped, r.verdict.figures.sharpness, writtenAt, received, i.sha256, i.width, i.height, i.bytes, kept.figures.brightness, kept.figures.clipped, kept.figures.sharpness, `${i.kept.width}:${i.kept.height}:${encodeLuma(i.kept).data}`],
      },
    };
  }

  /**
   * Le fichier de l'image gardée, envoyé par le téléphone après sa saisie [R677]. Il n'est rangé que pour une photo
   * reçue de cet agent et de cet appareil, et seulement s'il est le fichier annoncé (poids, empreinte, vrai JPEG de la
   * taille dite). Rangé une fois : le même envoi rejoué rend la même réponse. Sans rangement possible, rien n'est
   * écrit et le téléphone garde le fichier.
   */
  async depositImage(viewer: Viewer, deviceId: unknown, opId: unknown, bytes: Uint8Array | null, store: VisitImageStore | null): Promise<DepositResult> {
    const refused = await this.activeAgent(viewer, `agent:${viewer.userId}`);
    if (refused) return refused;
    if (typeof deviceId !== 'string' || !ID.test(deviceId) || typeof opId !== 'string' || !ID.test(opId)) return { ok: false, rule: null, code: 'bad_photo' };
    const op = await this.db.first<{ appointment_id: string }>(
      "SELECT appointment_id FROM offline_ops WHERE network_id = ? AND agent_id = ? AND device_id = ? AND op_id = ? AND kind = 'visite.photo' AND outcome = 'applique'",
      [viewer.networkId, viewer.userId, deviceId, opId],
    );
    const photoId = await sha256Of({ n: viewer.networkId, a: viewer.userId, d: deviceId, o: opId });
    const photo = op
      ? await this.db.first<{ id: string; appointment_id: string; image_sha256: string | null; image_width: number | null; image_height: number | null; image_bytes: number | null; kept_luma: string | null }>(
          'SELECT id, appointment_id, image_sha256, image_width, image_height, image_bytes, kept_luma FROM visit_photos WHERE id = ? AND network_id = ? AND agent_id = ?',
          [photoId, viewer.networkId, viewer.userId],
        )
      : null;
    if (!photo || photo.image_sha256 === null || photo.image_width === null || photo.image_height === null || photo.image_bytes === null) return { ok: false, rule: null, code: 'photo_inconnue' };
    const done = await this.db.first<{ sha256: string }>('SELECT sha256 FROM visit_photo_files WHERE photo_id = ?', [photo.id]);
    if (done) return { ok: true, again: true };
    const expected = { sha256: photo.image_sha256, width: photo.image_width, height: photo.image_height, bytes: photo.image_bytes };
    // Le fichier est celui annoncé, et il montre bien l'image jugée à sa réception : ses propres blocs, réduits, la
    // retrouvent [R677].
    if (!bytes || !(await matchesKept(bytes, expected)) || !keptShown(bytes, photo.kept_luma)) {
      await appendEvent(this.journal, { type: 'hors_ligne.image_refusee', actor: this.actor(viewer), subject: `appointment:${photo.appointment_id}`, data: { rule: 'R677', code: 'image_differente' } }, this.now);
      return { ok: false, rule: 'R677', code: 'image_differente' };
    }
    if (!store) return { ok: false, rule: null, code: 'depot_indisponible' };
    const key = `visites/${viewer.networkId}/${photo.appointment_id}/${photo.id}.jpg`;
    // Une panne du rangement remonte : rien n'est écrit, le téléphone garde le fichier et le renverra.
    await store.put(key, bytes, IMAGE_TYPE);
    await this.db.run(
      'INSERT INTO visit_photo_files (photo_id, network_id, agent_id, media_key, sha256, bytes, deposited_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (photo_id) DO NOTHING',
      [photo.id, viewer.networkId, viewer.userId, key, expected.sha256, expected.bytes, this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'hors_ligne.image_rangee', actor: this.actor(viewer), subject: `appointment:${photo.appointment_id}`, data: { rule: 'R677', bytes: expected.bytes } }, this.now);
    return { ok: true, again: false };
  }
}
