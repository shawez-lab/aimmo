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
import type { Acces } from '../acces/acces.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
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
  validDuration,
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
  confirmation_status: 'sent' | 'waiting' | 'refused' | 'failed' | null;
  /** Le canal de la confirmation, que les rappels reprennent (V04) ; NULL : aucun message. */
  confirmation_channel: OutboundChannelName | null;
  /** La coordonnée choisie à la réservation, que la confirmation et les rappels visent (V09). */
  confirmation_to: string | null;
}

export type BookingRefusal =
  | 'unknown_agent'
  | 'unknown_person'
  | 'unknown_property'
  | 'bad_kind'
  | 'bad_time'
  | 'bad_duration'
  | 'too_soon'
  | 'no_availability'
  | 'outside_availability'
  | 'agenda_busy'
  | 'taken';

export type BookingResult =
  | {
      ok: true;
      appointment: Appointment;
      token: string;
      confirmation: Pick<SendResult, 'status' | 'rule'> | null;
      /** La réservation est faite, mais son écriture au journal a échoué : à signaler par l'appelant. */
      warning?: 'journal_failed';
    }
  | { ok: false; rule: 'R32' | 'R33' | null; code: BookingRefusal };

export interface BookingRequest {
  networkId: string;
  agentId: string;
  personId: string;
  propertyId?: string | null;
  kind: AppointmentKind;
  start: Date;
  source: AppointmentSource;
  /**
   * La durée propre de ce rendez-vous, en minutes (AU056) : l'agent seul la choisit (`source: 'agent'`), le conflit se
   * contrôle sur elle. Absente, celle du type dans les réglages.
   */
  durationMinutes?: number;
  /** Le canal de la confirmation ; absent, pas de message (la confirmation est rendue à l'appelant). */
  channel?: OutboundChannelName | null;
  /** La coordonnée choisie par la personne pour ce canal, normalisée (V09) ; absente : la première de la fiche. */
  to?: string | null;
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

/**
 * Le jeton suit « / » dans le texte : sa première lettre n'est jamais a, c, g, i ni r, pour qu'il ne commence jamais
 * comme un mot que le contrôle du texte lit comme une mention de l'IA, « gpt », « robot », « assistant »… [R06].
 */
export const TOKEN_FIRST_LETTERS = 'bdefhjklmnopqstuvwxyz';

/** Un jeton de 32 lettres minuscules (environ 150 bits) : sans chiffre, il ne se confond pas avec un chiffre du texte [R10]. */
export function newBookingToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  let out = '';
  for (const b of bytes) {
    if (out.length === 0) {
      // 231 = 11 × 21 : on écarte le reste pour garder des premières lettres également probables.
      if (b < 231) out += TOKEN_FIRST_LETTERS[b % TOKEN_FIRST_LETTERS.length];
    } else if (b < 234) {
      // 234 = 9 × 26 : on écarte le reste pour garder des lettres également probables.
      out += String.fromCharCode(97 + (b % 26));
    }
    if (out.length === 32) return out;
  }
  return out.length === 0 ? newBookingToken() : out + newBookingToken().slice(1, 33 - out.length);
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
  // Une visite n'est confirmée qu'une fois le téléphone et l'identité du visiteur confirmés (T05) : la réservation le dit [R54].
  if (kind === 'visite') {
    return {
      text: `${hello} ${label} est réservée ${when.text}. Votre agent immobilier la confirmera avec vous avant la visite.${link ? ` Pour la décaler ou l’annuler : ${link}` : ''}`,
      figures: when.figures,
    };
  }
  return { text, figures: when.figures };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE|constraint/i.test(error.message);
}

export class RendezVous {
  private readonly fiche: FicheUnique;
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
    if (!Number.isInteger(this.settings.travelMinutes / 5) || this.settings.travelMinutes < 0) throw new Error('Temps de trajet non valable : un multiple de 5 minutes.');
    if (options.linkBase && !/^https:\/\/[^\s\d]+\/$/.test(options.linkBase)) throw new Error('Début de lien non valable : https, sans chiffre, terminé par /.');
    const store = new FicheClient(db, { now: this.now });
    const fiche = new FicheUnique(db, store, { now: this.now });
    this.fiche = fiche;
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
  async freeSlotsFor(agentId: string, kind: AppointmentKind, from: Date, to: Date, durationMinutes?: number): Promise<Slot[]> {
    const availability = await this.availabilityOf(agentId);
    if (!availability) return [];
    const travel = this.settings.travelMinutes * MINUTE;
    const booked = await this.bookedAround(agentId, new Date(from.getTime() - travel - 86_400_000), new Date(to.getTime() + travel + 86_400_000));
    const busy = await this.busyAround(agentId, from, to);
    return freeSlots({ availability, kind, from, to, now: this.now(), booked, busy, settings: this.settings, ...(durationMinutes !== undefined ? { durationMinutes } : {}) });
  }

  /**
   * Tient les tranches en une seule instruction, tout ou rien : la sienne pour tous les types, et, sur place, élargie de
   * la moitié du trajet de chaque côté. Les tranches sont produites par la base, en peu de paramètres (D1 en limite le
   * nombre). `false` si une tranche est déjà tenue [R32].
   */
  private async hold(agentId: string, appointmentId: string, kind: AppointmentKind, start: Date, end: Date): Promise<boolean> {
    const first = Math.floor(start.getTime() / UNIT_MS);
    const last = Math.ceil(end.getTime() / UNIT_MS);
    // Le trajet est partagé entre l'avant et l'après, l'avant arrondi en bas, l'après en haut : entre deux rendez-vous
    // sur place, l'après de l'un et l'avant de l'autre font exactement le trajet réglé, comme dans conflictOf [R32].
    const travelUnits = (this.settings.travelMinutes * MINUTE) / UNIT_MS;
    const before = Math.floor(travelUnits / 2);
    const after = travelUnits - before;
    try {
      await this.db.run(
        `INSERT INTO appointment_holds (agent_id, layer, unit, appointment_id)
         WITH RECURSIVE own(u) AS (SELECT ? UNION ALL SELECT u + 1 FROM own WHERE u + 1 < ?),
                        site(u) AS (SELECT ? UNION ALL SELECT u + 1 FROM site WHERE u + 1 < ?)
         SELECT ?, 'own', u, ? FROM own
         UNION ALL SELECT ?, 'site', u, ? FROM site WHERE ? = 1`,
        [first, last, first - before, last + after, agentId, appointmentId, agentId, appointmentId, isOnSite(kind) ? 1 : 0],
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
    return this.db.first<Appointment>('SELECT id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, source, replaces_id, created_at, updated_at, cancelled_at, confirmation_status, confirmation_channel, confirmation_to FROM appointments WHERE id = ?', [id]);
  }

  async byToken(token: string): Promise<Appointment | null> {
    if (!/^[a-z]{32}$/.test(token)) return null;
    const hash = await tokenHash(token);
    // Le lien de la confirmation, ou celui d'un rappel (V04) : chacun ne sert qu'à son rendez-vous.
    const row =
      (await this.db.first<{ id: string }>('SELECT id FROM appointments WHERE token_hash = ?', [hash])) ??
      (await this.db.first<{ id: string }>('SELECT appointment_id AS id FROM appointment_links WHERE token_hash = ?', [hash]));
    return row ? this.get(row.id) : null;
  }

  /** Réserve un créneau ; la confirmation part par le contrôle central, en mode essai. */
  async book(req: BookingRequest, replacesId: string | null = null): Promise<BookingResult> {
    if (!APPOINTMENT_KINDS.includes(req.kind)) return { ok: false, rule: null, code: 'bad_kind' };
    if (!APPOINTMENT_SOURCES.includes(req.source)) throw new Error('Source de réservation inconnue.');
    const start = req.start;
    if (Number.isNaN(start.getTime()) || start.getTime() % UNIT_MS !== 0) return { ok: false, rule: null, code: 'bad_time' };
    // Une durée propre vient de l'agent, ou d'un rendez-vous décalé qui garde la sienne (AU056) ; jamais du site.
    if (req.durationMinutes !== undefined && (!validDuration(req.durationMinutes) || (req.source !== 'agent' && replacesId === null))) {
      return { ok: false, rule: null, code: 'bad_duration' };
    }
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
    const end = new Date(start.getTime() + (req.durationMinutes ?? this.settings.durations[req.kind]) * MINUTE);
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
        `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at, confirmation_channel, confirmation_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.networkId, req.agentId, req.personId, req.propertyId ?? null, req.kind, start.toISOString(), end.toISOString(), await tokenHash(token), req.source, replacesId, at, at, req.channel ?? null, req.channel ? (req.to ?? null) : null],
      );
    } catch (error) {
      await this.release(id);
      throw error;
    }
    const appointment = (await this.get(id))!;
    try {
      await this.log('rdv.reserve', `${req.source}`, appointment, {});
    } catch (error) {
      // Le journal en panne : la réservation est défaite, le créneau libéré, l'appelant peut réessayer [R13].
      await this.cancelQuietly(id);
      throw error;
    }
    let confirmation: Pick<SendResult, 'status' | 'rule'> | null = null;
    if (req.channel) {
      try {
        const link = this.options.linkBase ? `${this.options.linkBase}${token}` : null;
        const { text, figures } = confirmationText(req.kind, start, await ficheFirstName(this.db, await this.fiche.membersOf(req.personId)), link);
        const sent = await this.controle.send({
          networkId: req.networkId,
          agentId: req.agentId,
          personId: req.personId,
          channel: req.channel,
          to: req.to ?? null,
          kind: 'reminder',
          purpose: APPOINTMENT_PURPOSE,
          subject: `rdv_confirmation:${id}`,
          fallbackTexts: [text],
          figures,
          // Le lien décale ou annule ce rendez-vous : remis au canal, jamais rangé en clair [HX61, RC16].
          ...(link ? { secrets: [{ kind: 'lien' as const, value: link }] } : {}),
        });
        confirmation = { status: sent.status, rule: sent.rule };
        // Refusée pour l'heure [R01] : la confirmation attend, les rappels (V04) l'enverront dans les heures d'envoi.
        const status = sent.status === 'sent' ? 'sent' : sent.status === 'failed' ? 'failed' : sent.rule === 'R01' ? 'waiting' : 'refused';
        await this.db.run('UPDATE appointments SET confirmation_status = ? WHERE id = ?', [status, id]);
        await this.log('rdv.confirmation.essai', 'system:rdv', appointment, { mode: 'essai', sent: false, status: sent.status, rule: sent.rule });
      } catch (error) {
        // La réservation tient et son lien est rendu ; la panne de la confirmation reste écrite sur le rendez-vous.
        confirmation = { status: 'failed', rule: null };
        await this.db.run("UPDATE appointments SET confirmation_status = 'failed' WHERE id = ?", [id]).catch(() => undefined);
        await this.log('rdv.confirmation.panne', 'system:rdv', appointment, { error: error instanceof Error ? error.name : 'unknown' }).catch(() => undefined);
      }
    }
    return { ok: true, appointment: (await this.get(id))!, token, confirmation };
  }

  /**
   * Un rendez-vous pris par l'agent pour l'un de ses clients, avec sa durée propre s'il la choisit (AU056) : la
   * signature chez le notaire de 90 minutes, l'appel de 10 minutes. Une visite (la contre-visite de 20 minutes comprise)
   * passe par `Visites.schedule`, qui prend la même durée. Le conflit se contrôle sur cette durée
   * [R32, R33]. Aucune confirmation ne part. La direction n'a pas d'agenda ; une fiche hors du portefeuille de l'agent,
   * ou un bien qu'il ne peut pas lire, est refusé et le refus écrit au journal [R16].
   */
  async bookAsAgent(
    viewer: Viewer,
    acces: Acces,
    input: { personId: string; propertyId?: string | null; kind: AppointmentKind; start: Date; durationMinutes?: number },
  ): Promise<BookingResult | { ok: false; rule: 'R16' | 'R40'; code: string }> {
    // Une visite passe par la sienne (`Visites.schedule`) : bien diffusable, bon de visite et fiche de visite [R40, R42].
    if (input.kind === 'visite') return { ok: false, rule: 'R40', code: 'visit_route' };
    if (viewer.role !== 'agent') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${viewer.role}:${viewer.userId}`, subject: `person:${input.personId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'appointment', code: 'not_agent' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_agent' };
    }
    const fiche = await acces.readFiche(viewer, input.personId);
    if (!fiche.ok) return fiche;
    if (fiche.view !== 'full') return { ok: false, rule: 'R16', code: 'not_assigned' };
    if (input.propertyId) {
      const property = await acces.readProperty(viewer, input.propertyId);
      if (!property.ok) return property;
    }
    return this.book({
      networkId: viewer.networkId,
      agentId: viewer.userId,
      personId: fiche.value.person.id,
      propertyId: input.propertyId ?? null,
      kind: input.kind,
      start: input.start,
      source: 'agent',
      channel: null,
      ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
    });
  }

  /** Défait une réservation qui n'a pas pu être menée au bout : annulée, créneau libéré, sans journal. */
  private async cancelQuietly(id: string): Promise<void> {
    const at = this.now().toISOString();
    await this.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'booked'", [at, at, id]);
    await this.release(id);
  }

  private async cancelAppointment(appointment: Appointment, actor: string): Promise<Appointment | null> {
    const at = this.now().toISOString();
    const done = await this.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'booked'", [at, at, appointment.id]);
    if (done.changes !== 1) {
      // Déjà annulé : une libération restée en panne se termine ici, à la nouvelle demande.
      const current = await this.get(appointment.id);
      if (current?.status === 'cancelled') await this.release(appointment.id);
      return null;
    }
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
    return this.moveAppointment(old, start, channel, 'client:lien');
  }

  /** Un rendez-vous déplacé par l'agent dans son agenda (V03) : mêmes règles qu'un décalage [R32, R33]. */
  async moveFromAgenda(id: string, start: Date): Promise<BookingResult | { ok: false; rule: null; code: 'unknown' | 'not_booked' }> {
    const old = await this.get(id);
    if (!old) return { ok: false, rule: null, code: 'unknown' };
    return this.moveAppointment(old, start, null, 'system:agenda');
  }

  /** Un rendez-vous supprimé par l'agent dans son agenda (V03) : annulé, créneau libéré. */
  async cancelFromAgenda(id: string): Promise<Appointment | null> {
    const appointment = await this.get(id);
    return appointment ? this.cancelAppointment(appointment, 'system:agenda') : null;
  }

  private async moveAppointment(
    old: Appointment,
    start: Date,
    channel: OutboundChannelName | null,
    actor: string,
  ): Promise<BookingResult | { ok: false; rule: null; code: 'unknown' | 'not_booked' }> {
    const at = this.now().toISOString();
    // L'ancien rendez-vous est pris d'abord, par une seule instruction : un lien ne décale qu'une fois, même en double clic.
    const claimed = await this.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'booked'", [at, at, old.id]);
    if (claimed.changes !== 1) return { ok: false, rule: null, code: 'not_booked' };
    await this.release(old.id);
    // L'ancien rendez-vous revient, avec ses tranches. Si un autre les a prises entre-temps, il reste annulé, et c'est noté.
    const restore = async (): Promise<void> => {
      if (await this.hold(old.agent_id, old.id, old.kind, new Date(old.start_at), new Date(old.end_at))) {
        await this.db.run("UPDATE appointments SET status = 'booked', cancelled_at = NULL, updated_at = ? WHERE id = ? AND status = 'cancelled'", [this.now().toISOString(), old.id]);
      } else {
        await this.log('rdv.perdu', 'system:rdv', (await this.get(old.id))!, {});
      }
    };
    let result: BookingResult;
    try {
      result = await this.book(
        { networkId: old.network_id, agentId: old.agent_id, personId: old.person_id, propertyId: old.property_id, kind: old.kind, start, source: old.source, channel, to: channel === old.confirmation_channel ? old.confirmation_to : null, ...this.keptDuration(old) },
        old.id,
      );
    } catch (error) {
      // Une panne (agenda, base) avant la nouvelle réservation ne fait pas perdre l'ancienne.
      const created = await this.db.first<{ id: string }>("SELECT id FROM appointments WHERE replaces_id = ? AND status = 'booked'", [old.id]);
      if (!created) await restore();
      throw error;
    }
    if (!result.ok) {
      await restore();
      return result;
    }
    // Le décalage est fait : une panne du journal à ce moment ne doit pas faire perdre le nouveau lien. Elle est rendue
    // à l'appelant (`warning`), et le nouveau rendez-vous garde `replaces_id` dans la base [R13].
    const logged = await this.log('rdv.decale', actor, (await this.get(old.id))!, { replaced_by: result.appointment.id }).then(
      () => true,
      () => false,
    );
    return logged ? result : { ...result, warning: 'journal_failed' };
  }

  /**
   * Un rendez-vous décalé garde sa durée quand elle n'est pas celle du type (AU056) : la contre-visite de 20 minutes
   * reste de 20 minutes. Une durée hors des bornes revient à celle du type.
   */
  private keptDuration(old: Appointment): { durationMinutes?: number } {
    const minutes = (Date.parse(old.end_at) - Date.parse(old.start_at)) / MINUTE;
    return minutes !== this.settings.durations[old.kind] && validDuration(minutes) ? { durationMinutes: minutes } : {};
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

