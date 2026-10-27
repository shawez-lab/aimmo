/**
 * La réservation des rendez-vous (M05, V02).
 *
 * Un rendez-vous se réserve sur un créneau libre (V01) : dans les disponibilités de l'agent et hors de ses événements
 * occupés [R33], sans chevaucher un autre rendez-vous, trajet compris [R32]. La garantie contre la double réservation
 * tient dans la base : chaque rendez-vous tient ses tranches de 5 minutes, en une seule instruction qui passe entière
 * ou pas du tout ; deux réservations du même créneau en même temps, une seule passe.
 * La confirmation part tout de suite par le contrôle central, avec les seuls canaux du mode essai : rangée, jamais
 * envoyée [R26]. Le lien pour décaler ou annuler porte un jeton fait de lettres seules, sans nom ni coordonnée ; seule
 * son empreinte est gardée. Une annulation libère le créneau aussitôt. Le journal ne porte ni nom ni texte [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { OutboundChannelName } from '../db/types.ts';
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { ControleEnvois, type SendResult } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { localTime } from '../envoi/horaires.ts';
import { trialChannels } from '../captation/essai.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import {
  AGENDA_TIME_ZONE,
  APPOINTMENT_KINDS,
  DEFAULT_SLOT_SETTINGS,
  checkAvailability,
  conflictOf,
  freeSlots,
  isOnSite,
  withinAvailability,
  type AppointmentKind,
  type Availability,
  type BookedInterval,
  type BusySource,
  type Slot,
  type SlotSettings,
} from './creneaux.ts';

export const APPOINTMENT_PURPOSE = 'appointment';
export const APPOINTMENT_SOURCES = ['site', 'assistant', 'espace', 'agent'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];
export type AppointmentStatus = 'booked' | 'cancelled' | 'honored' | 'absent';

export interface Appointment {
  id: string;
  network_id: string;
  agent_id: string;
  person_id: string;
  property_id: string | null;
  kind: AppointmentKind;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  replaces_id: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
}

export type BookingRefusal =
  | 'unknown_agent'
  | 'unknown_person'
  | 'unknown_property'
  | 'bad_kind'
  | 'bad_time'
  | 'too_soon'
  | 'no_availability'
  | 'outside_availability'
  | 'agenda_busy'
  | 'taken';

export type BookingResult =
  | { ok: true; appointment: Appointment; token: string; confirmation: Pick<SendResult, 'status' | 'rule'> | null }
  | { ok: false; rule: 'R32' | 'R33' | null; code: BookingRefusal };

export interface BookingRequest {
  networkId: string;
  agentId: string;
  personId: string;
  propertyId?: string | null;
  kind: AppointmentKind;
  start: Date;
  source: AppointmentSource;
  /** Le canal de la confirmation ; absent, pas de message (la confirmation est rendue à l'appelant). */
  channel?: OutboundChannelName | null;
}

export interface RendezVousOptions {
  now?: () => Date;
  settings?: SlotSettings;
  /** Les événements occupés de l'agenda de l'agent (V03) ; absent, l'agenda est vide. */
  agenda?: BusySource;
  /** Début du lien pour décaler ou annuler, terminé par `/`, sans chiffre : le jeton s'y ajoute. */
  linkBase?: string | null;
  newId?: () => string;
  newToken?: () => string;
}

const UNIT_MS = 5 * 60_000;
const MINUTE = 60_000;

/** Un jeton de 32 lettres minuscules (environ 150 bits) : sans chiffre, il ne se confond pas avec un chiffre du texte [R10]. */
export function newBookingToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  let out = '';
  for (const b of bytes) {
    // 234 = 9 × 26 : on écarte le reste pour garder des lettres également probables.
    if (b < 234) out += String.fromCharCode(97 + (b % 26));
    if (out.length === 32) return out;
  }
  return out + newBookingToken().slice(0, 32 - out.length);
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const KIND_LABEL: Record<AppointmentKind, string> = {
  estimation: 'votre rendez-vous d’estimation',
  visite: 'votre visite',
  signature: 'votre rendez-vous de signature',
  appel: 'votre rendez-vous téléphonique',
};
const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** La date et l'heure en clair, heure de Paris, et les chiffres qu'elles portent [R10]. */
export function appointmentWhen(start: Date, timeZone = AGENDA_TIME_ZONE): { text: string; figures: number[] } {
  const l = localTime(start, timeZone);
  const day = Number(l.date.slice(8, 10));
  const month = Number(l.date.slice(5, 7));
  const hour = Math.floor(l.minutes / 60);
  const minute = l.minutes % 60;
  const time = minute === 0 ? `${hour} h` : `${hour} h ${String(minute).padStart(2, '0')}`;
  return { text: `le ${DAYS[l.weekday - 1]} ${day} ${MONTHS[month - 1]} à ${time}`, figures: [day, hour, minute] };
}

/** Le texte de confirmation, sans IA, sans adresse ; vouvoiement, prénom s'il est connu [R08]. */
export function confirmationText(kind: AppointmentKind, start: Date, firstName: string | null, link: string | null): { text: string; figures: number[] } {
  const when = appointmentWhen(start);
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const label = KIND_LABEL[kind];
  const text = `${hello} ${label} est confirmé ${when.text}.${link ? ` Pour le décaler ou l’annuler : ${link}` : ''}`;
  return { text: kind === 'visite' ? text.replace('est confirmé', 'est confirmée') : text, figures: when.figures };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE|constraint/i.test(error.message);
}

export class RendezVous {
  private readonly now: () => Date;
  private readonly settings: SlotSettings;
  private readonly newId: () => string;
  private readonly newToken: () => string;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly options: RendezVousOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.settings = options.settings ?? DEFAULT_SLOT_SETTINGS;
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newToken = options.newToken ?? newBookingToken;
    if (options.linkBase && !/^https:\/\/[^\s\d]+\/$/.test(options.linkBase)) throw new Error('Début de lien non valable : https, sans chiffre, terminé par /.');
    const store = new FicheClient(db, { now: this.now });
    const fiche = new FicheUnique(db, store, { now: this.now });
    const decisions = new DecisionEnvoi(db, store, fiche, { now: this.now });
    // Seuls les canaux du mode essai : aucun vrai canal ne peut être passé de l'extérieur [R26].
    this.controle = new ControleEnvois(db, fiche, decisions, {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  /** L'agent fixe ses disponibilités, lui seul [R33]. */
  async setAvailability(viewer: Viewer, availability: Availability): Promise<{ ok: true } | { ok: false; code: 'not_agent' | 'invalid' }> {
    if (viewer.role !== 'agent') return { ok: false, code: 'not_agent' };
    const agent = await this.db.first<{ id: string }>("SELECT id FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [viewer.userId, viewer.networkId]);
    if (!agent) return { ok: false, code: 'not_agent' };
    try {
      checkAvailability(availability);
    } catch {
      return { ok: false, code: 'invalid' };
    }
    const at = this.now().toISOString();
    const json = JSON.stringify({ weekly: availability.weekly, exceptions: availability.exceptions ?? [] });
    await this.db.run(
      `INSERT INTO agent_availabilities (agent_id, network_id, availability, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET availability = excluded.availability, updated_at = excluded.updated_at`,
      [viewer.userId, viewer.networkId, json, at],
    );
    await appendEvent(this.journal, { type: 'rdv.disponibilites', actor: `agent:${viewer.userId}`, subject: `agent:${viewer.userId}`, data: {} }, this.now);
    return { ok: true };
  }

  async availabilityOf(agentId: string): Promise<Availability | null> {
    const row = await this.db.first<{ availability: string }>('SELECT availability FROM agent_availabilities WHERE agent_id = ?', [agentId]);
    return row ? (JSON.parse(row.availability) as Availability) : null;
  }

  private async bookedAround(agentId: string, from: Date, to: Date, exceptId: string | null = null): Promise<BookedInterval[]> {
    const rows = await this.db.all<{ kind: AppointmentKind; start_at: string; end_at: string }>(
      `SELECT kind, start_at, end_at FROM appointments WHERE agent_id = ? AND status = 'booked' AND start_at < ? AND end_at > ? AND id IS NOT ?`,
      [agentId, to.toISOString(), from.toISOString(), exceptId],
    );
    return rows.map((r) => ({ kind: r.kind, start: new Date(r.start_at), end: new Date(r.end_at) }));
  }

  private async busyAround(agentId: string, from: Date, to: Date) {
    const travel = this.settings.travelMinutes * MINUTE;
    return this.options.agenda ? this.options.agenda.busy(agentId, new Date(from.getTime() - travel), new Date(to.getTime() + travel)) : [];
  }

  /** Les créneaux libres d'un agent pour un type, entre deux instants (V01, avec la base et l'agenda). */
  async freeSlotsFor(agentId: string, kind: AppointmentKind, from: Date, to: Date): Promise<Slot[]> {
    const availability = await this.availabilityOf(agentId);
    if (!availability) return [];
    const travel = this.settings.travelMinutes * MINUTE;
    const booked = await this.bookedAround(agentId, new Date(from.getTime() - travel - 86_400_000), new Date(to.getTime() + travel + 86_400_000));
    const busy = await this.busyAround(agentId, from, to);
    return freeSlots({ availability, kind, from, to, now: this.now(), booked, busy, settings: this.settings });
  }

  /** Les tranches que tient un rendez-vous : le sien, et, sur place, élargi de la moitié du trajet de chaque côté. */
  private holdsOf(kind: AppointmentKind, start: Date, end: Date): { layer: 'own' | 'site'; unit: number }[] {
    const units: { layer: 'own' | 'site'; unit: number }[] = [];
    for (let u = Math.floor(start.getTime() / UNIT_MS); u < Math.ceil(end.getTime() / UNIT_MS); u++) units.push({ layer: 'own', unit: u });
    if (isOnSite(kind)) {
      const pad = Math.ceil((this.settings.travelMinutes * MINUTE) / 2 / UNIT_MS);
      for (let u = Math.floor(start.getTime() / UNIT_MS) - pad; u < Math.ceil(end.getTime() / UNIT_MS) + pad; u++) units.push({ layer: 'site', unit: u });
    }
    return units;
  }

  /** Tient les tranches en une seule instruction : tout ou rien. `false` si une tranche est déjà tenue [R32]. */
  private async hold(agentId: string, appointmentId: string, kind: AppointmentKind, start: Date, end: Date): Promise<boolean> {
    const units = this.holdsOf(kind, start, end);
    const values = units.map(() => '(?, ?, ?, ?)').join(', ');
    try {
      await this.db.run(
        `INSERT INTO appointment_holds (agent_id, layer, unit, appointment_id) VALUES ${values}`,
        units.flatMap((h) => [agentId, h.layer, h.unit, appointmentId]),
      );
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  private async release(appointmentId: string): Promise<void> {
    await this.db.run('UPDATE appointment_holds SET released_at = ? WHERE appointment_id = ? AND released_at IS NULL', [this.now().toISOString(), appointmentId]);
  }

  async get(id: string): Promise<Appointment | null> {
    return this.db.first<Appointment>('SELECT id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, source, replaces_id, created_at, updated_at, cancelled_at FROM appointments WHERE id = ?', [id]);
  }

  async byToken(token: string): Promise<Appointment | null> {
    if (!/^[a-z]{32}$/.test(token)) return null;
    const row = await this.db.first<{ id: string }>('SELECT id FROM appointments WHERE token_hash = ?', [await tokenHash(token)]);
    return row ? this.get(row.id) : null;
  }

  /** Réserve un créneau ; la confirmation part par le contrôle central, en mode essai. */
  async book(req: BookingRequest, replacesId: string | null = null): Promise<BookingResult> {
    if (!APPOINTMENT_KINDS.includes(req.kind)) return { ok: false, rule: null, code: 'bad_kind' };
    if (!APPOINTMENT_SOURCES.includes(req.source)) throw new Error('Source de réservation inconnue.');
    const start = req.start;
    if (Number.isNaN(start.getTime()) || start.getTime() % UNIT_MS !== 0) return { ok: false, rule: null, code: 'bad_time' };
    const agent = await this.db.first<{ id: string }>("SELECT id FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [req.agentId, req.networkId]);
    if (!agent) return { ok: false, rule: null, code: 'unknown_agent' };
    const person = await this.db.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ? AND network_id = ?', [req.personId, req.networkId]);
    if (!person) return { ok: false, rule: null, code: 'unknown_person' };
    if (req.propertyId) {
      const property = await this.db.first<{ id: string }>('SELECT id FROM properties WHERE id = ? AND network_id = ?', [req.propertyId, req.networkId]);
      if (!property) return { ok: false, rule: null, code: 'unknown_property' };
    }
    const now = this.now();
    if (start.getTime() < now.getTime() + this.settings.minNoticeMinutes * MINUTE) return { ok: false, rule: null, code: 'too_soon' };
    const end = new Date(start.getTime() + this.settings.durations[req.kind] * MINUTE);
    const slot: Slot = { kind: req.kind, start, end };
    const availability = await this.availabilityOf(req.agentId);
    if (!availability) return { ok: false, rule: 'R33', code: 'no_availability' };
    if (!withinAvailability(slot, availability)) return { ok: false, rule: 'R33', code: 'outside_availability' };
    const travel = this.settings.travelMinutes * MINUTE;
    const booked = await this.bookedAround(req.agentId, new Date(start.getTime() - travel), new Date(end.getTime() + travel), replacesId);
    const conflict = conflictOf(slot, booked, await this.busyAround(req.agentId, start, end), this.settings);
    if (conflict) return { ok: false, rule: conflict, code: conflict === 'R32' ? 'taken' : 'agenda_busy' };

    const id = this.newId();
    const token = this.newToken();
    // La base tranche : si un autre rendez-vous a pris une tranche entre-temps, rien n'est tenu [R32].
    if (!(await this.hold(req.agentId, id, req.kind, start, end))) return { ok: false, rule: 'R32', code: 'taken' };
    const at = now.toISOString();
    try {
      await this.db.run(
        `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?)`,
        [id, req.networkId, req.agentId, req.personId, req.propertyId ?? null, req.kind, start.toISOString(), end.toISOString(), await tokenHash(token), req.source, replacesId, at, at],
      );
    } catch (error) {
      await this.release(id);
      throw error;
    }
    const appointment = (await this.get(id))!;
    await this.log('rdv.reserve', `${req.source}`, appointment, {});
    let confirmation: Pick<SendResult, 'status' | 'rule'> | null = null;
    if (req.channel) {
      const link = this.options.linkBase ? `${this.options.linkBase}${token}` : null;
      const { text, figures } = confirmationText(req.kind, start, person.first_name, link);
      const sent = await this.controle.send({
        networkId: req.networkId,
        agentId: req.agentId,
        personId: req.personId,
        channel: req.channel,
        kind: 'reminder',
        purpose: APPOINTMENT_PURPOSE,
        subject: `rdv_confirmation:${id}`,
        fallbackTexts: [text],
        figures,
      });
      confirmation = { status: sent.status, rule: sent.rule };
      await this.log('rdv.confirmation.essai', 'system:rdv', appointment, { mode: 'essai', sent: false, status: sent.status, rule: sent.rule });
    }
    return { ok: true, appointment, token, confirmation };
  }

  private async cancelAppointment(appointment: Appointment, actor: string): Promise<Appointment | null> {
    const at = this.now().toISOString();
    const done = await this.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'booked'", [at, at, appointment.id]);
    if (done.changes !== 1) return null;
    // Le créneau redevient libre aussitôt.
    await this.release(appointment.id);
    const cancelled = (await this.get(appointment.id))!;
    await this.log('rdv.annule', actor, cancelled, {});
    return cancelled;
  }

  /** Annulation par le lien du client. */
  async cancel(token: string): Promise<{ ok: true; appointment: Appointment } | { ok: false; code: 'unknown' | 'not_booked' }> {
    const appointment = await this.byToken(token);
    if (!appointment) return { ok: false, code: 'unknown' };
    const cancelled = await this.cancelAppointment(appointment, 'client:lien');
    return cancelled ? { ok: true, appointment: cancelled } : { ok: false, code: 'not_booked' };
  }

  /** Annulation par l'agent du rendez-vous, lui seul. */
  async cancelAsAgent(viewer: Viewer, id: string): Promise<{ ok: true; appointment: Appointment } | { ok: false; code: 'unknown' | 'not_agent' | 'not_booked' }> {
    const appointment = await this.get(id);
    if (!appointment || appointment.network_id !== viewer.networkId) return { ok: false, code: 'unknown' };
    if (viewer.role !== 'agent' || appointment.agent_id !== viewer.userId) return { ok: false, code: 'not_agent' };
    const cancelled = await this.cancelAppointment(appointment, `agent:${viewer.userId}`);
    return cancelled ? { ok: true, appointment: cancelled } : { ok: false, code: 'not_booked' };
  }

  /**
   * Décaler par le lien du client : un nouveau rendez-vous remplace l'ancien, avec un nouveau lien. L'ancien créneau
   * est libéré le temps de réserver le nouveau, qui peut le chevaucher ; si le nouveau ne passe pas, l'ancien est repris.
   */
  async reschedule(token: string, start: Date, channel: OutboundChannelName | null = null): Promise<BookingResult | { ok: false; rule: null; code: 'unknown' | 'not_booked' }> {
    const old = await this.byToken(token);
    if (!old) return { ok: false, rule: null, code: 'unknown' };
    if (old.status !== 'booked') return { ok: false, rule: null, code: 'not_booked' };
    await this.release(old.id);
    const result = await this.book(
      { networkId: old.network_id, agentId: old.agent_id, personId: old.person_id, propertyId: old.property_id, kind: old.kind, start, source: old.source, channel },
      old.id,
    );
    if (!result.ok) {
      // L'ancien rendez-vous reprend ses tranches. Si un autre les a prises entre-temps, il est annulé, et c'est noté.
      if (!(await this.hold(old.agent_id, old.id, old.kind, new Date(old.start_at), new Date(old.end_at)))) {
        await this.cancelAppointment(old, 'system:rdv');
        await this.log('rdv.perdu', 'system:rdv', old, {});
      }
      return result;
    }
    const at = this.now().toISOString();
    await this.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'booked'", [at, at, old.id]);
    await this.log('rdv.decale', 'client:lien', old, { replaced_by: result.appointment.id });
    return result;
  }

  /** Les rendez-vous tenus d'un agent, pour vérifier qu'aucun ne se chevauche. */
  async bookedOf(agentId: string): Promise<Appointment[]> {
    const ids = await this.db.all<{ id: string }>("SELECT id FROM appointments WHERE agent_id = ? AND status = 'booked' ORDER BY start_at", [agentId]);
    const out: Appointment[] = [];
    for (const { id } of ids) out.push((await this.get(id))!);
    return out;
  }

  private async log(type: string, actor: string, a: Appointment, data: Record<string, string | boolean | null>): Promise<void> {
    await appendEvent(
      this.journal,
      { type, actor, subject: `appointment:${a.id}`, data: { agent: a.agent_id, kind: a.kind, status: a.status, ...data } },
      this.now,
    );
  }
}

