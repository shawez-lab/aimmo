/**
 * La réservation en ligne (M05, V08) : ce que le site, l'assistant et l'espace client appellent, en mode essai.
 *
 * Les créneaux rendus ne portent que leur début et leur fin : rien de l'agenda de l'agent au-delà (ni événement, ni
 * rendez-vous, ni motif). Une réservation enregistre d'abord l'accord « rendez-vous » de la personne, avec sa date et
 * sa preuve, au moment où elle réserve [R03] ; si la réservation ne passe pas, cet accord est retiré aussitôt (jamais
 * effacé). La confirmation est rendue tout de suite ; elle passe par le contrôle central avec les seuls canaux du mode
 * essai : rien ne part [R26]. La réponse ne dit jamais si la personne était déjà connue [R16].
 *
 * Décidé : seuls l'estimation, la visite et l'appel se réservent en ligne ; la signature reste à l'agent. La personne
 * est retrouvée par son mail ou son téléphone ; sinon une fiche est créée, suivie par l'agent du rendez-vous. Seul un
 * créneau proposé se réserve en ligne : il est vérifié avant toute fiche nouvelle.
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { Channel, IdentifierKind, Person } from '../db/types.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { normalizeIdentifier } from '../fiche/normalize.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { AppointmentKind, BusySource, SlotSettings } from './creneaux.ts';
import { APPOINTMENT_PURPOSE, RendezVous, type AppointmentSource } from './reservation.ts';

export const ONLINE_KINDS: readonly AppointmentKind[] = ['estimation', 'visite', 'appel'];
export const ONLINE_SOURCES: readonly AppointmentSource[] = ['site', 'assistant', 'espace'];
/** Jours de créneaux rendus au plus par demande. */
export const MAX_SLOT_DAYS = 14;
const DAY_MS = 86_400_000;
const NAME = /^[\p{L}][\p{L}' -]{0,59}$/u;
const MAX_PROOF = 300;

export interface OnlineSlot {
  start: string;
  end: string;
}

export type SlotsResult = { ok: true; slots: OnlineSlot[] } | { ok: false; code: 'unknown_agent' | 'bad_kind' | 'bad_range' };

export interface OnlineBooking {
  networkId: string;
  agentId: string;
  kind: AppointmentKind;
  start: Date;
  source: AppointmentSource;
  firstName?: string | null;
  email?: string | null;
  phone?: string | null;
  /** Ce que la personne a accepté, et où : la preuve de l'accord [R03]. */
  consentProof: string;
  propertyId?: string | null;
}

export type OnlineBookingResult =
  | {
      ok: true;
      appointment: { kind: AppointmentKind; start: string; end: string };
      token: string;
      /** Le rendez-vous est pris, mais son écriture au journal a échoué : à signaler par l'appelant. */
      warning?: 'journal_failed';
      confirmation: { status: 'sent' | 'refused' | 'failed'; rule: string | null } | null;
    }
  | { ok: false; code: string; rule: 'R32' | 'R33' | null };

export interface EnLigneOptions {
  now?: () => Date;
  settings?: SlotSettings;
  agenda?: BusySource;
  linkBase?: string | null;
}

export class ReservationEnLigne {
  private readonly now: () => Date;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly rdv: RendezVous;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: EnLigneOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    this.rdv = new RendezVous(db, journal, {
      now: this.now,
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.agenda ? { agenda: options.agenda } : {}),
      ...(options.linkBase ? { linkBase: options.linkBase } : {}),
    });
  }

  private async agentIn(networkId: string, agentId: string): Promise<boolean> {
    return !!(await this.db.first<{ id: string }>("SELECT id FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [agentId, networkId]));
  }

  /** Les créneaux libres d'un agent : début et fin seulement, rien d'autre de son agenda. */
  async slots(input: { networkId: string; agentId: string; kind: AppointmentKind; from: Date; to: Date; propertyId?: string | null }): Promise<SlotsResult> {
    if (!ONLINE_KINDS.includes(input.kind)) return { ok: false, code: 'bad_kind' };
    if (Number.isNaN(input.from.getTime()) || Number.isNaN(input.to.getTime()) || input.to <= input.from || input.to.getTime() - input.from.getTime() > MAX_SLOT_DAYS * DAY_MS) {
      return { ok: false, code: 'bad_range' };
    }
    if (!(await this.agentIn(input.networkId, input.agentId))) return { ok: false, code: 'unknown_agent' };
    // AU055 : la marge du même lieu ne s'ouvre que pour un bien de ce réseau ; un autre bien, ou inconnu, rend les
    // créneaux sans elle, comme sans bien : rien n'est dit de lui.
    const propertyId = input.propertyId ? ((await this.db.first<{ id: string }>('SELECT id FROM properties WHERE id = ? AND network_id = ?', [input.propertyId, input.networkId]))?.id ?? null) : null;
    const free = await this.rdv.freeSlotsFor(input.agentId, input.kind, input.from, input.to, undefined, propertyId);
    return { ok: true, slots: free.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })) };
  }

  /** Réserve pour une personne qui le demande elle-même ; son accord est enregistré avec sa preuve [R03]. */
  async book(input: OnlineBooking): Promise<OnlineBookingResult> {
    if (!ONLINE_KINDS.includes(input.kind)) return { ok: false, code: 'bad_kind', rule: null };
    if (!ONLINE_SOURCES.includes(input.source)) return { ok: false, code: 'bad_source', rule: null };
    const proof = typeof input.consentProof === 'string' ? input.consentProof.trim() : '';
    if (proof === '' || proof.length > MAX_PROOF) return { ok: false, code: 'bad_consent', rule: null };
    const firstName = input.firstName?.trim() || null;
    if (firstName !== null && !NAME.test(firstName)) return { ok: false, code: 'bad_name', rule: null };
    // Tous les contacts donnés servent à retrouver la personne ; la confirmation part par le mail d'abord, sinon par
    // le téléphone (SMS).
    const given: { kind: IdentifierKind; value: string }[] = [];
    for (const [kind, raw] of [['email', input.email], ['phone', input.phone]] as const) {
      if (!raw) continue;
      const value = normalizeIdentifier(kind, raw);
      if (value === null) return { ok: false, code: 'bad_contact', rule: null };
      given.push({ kind, value });
    }
    if (given.length === 0) return { ok: false, code: 'no_contact', rule: null };
    const channel: Channel = given[0]!.kind === 'email' ? 'email' : 'sms';
    if (!(await this.agentIn(input.networkId, input.agentId))) return { ok: false, code: 'unknown_agent', rule: null };

    // En ligne, seul un créneau proposé se réserve : vérifié avant de créer une fiche, la base tranchera ensuite [R32].
    if (Number.isNaN(input.start.getTime())) return { ok: false, code: 'bad_time', rule: null };
    // Le créneau se revérifie avec le bien demandé : au même bien, la marge du même lieu (AU055).
    const around = await this.rdv.freeSlotsFor(input.agentId, input.kind, new Date(input.start.getTime() - DAY_MS), new Date(input.start.getTime() + DAY_MS), undefined, input.propertyId ?? null);
    if (!around.some((s) => s.start.getTime() === input.start.getTime())) return { ok: false, code: 'not_free', rule: null };

    const at = this.now();
    // Les fiches gardées de chaque contact donné, téléphone et WhatsApp confondus, fusions comprises : une exclusion
    // ou un arrêt notés sur l'une ne se contournent pas en réservant avec un autre contact [R02, R04].
    const byId = new Map<string, Person>();
    for (const g of given) for (const p of await this.fiche.findByIdentifier(input.networkId, g.kind, g.value)) byId.set(p.id, p);
    const known = [...byId.values()];
    // Plusieurs fiches distinctes : le rendez-vous va à la plus ancienne, sans confirmation par message, pour ne pas
    // écrire à quelqu'un dont les exclusions sont sur une autre fiche ; l'agent tranchera.
    const ambiguous = known.length > 1;
    let personId: string;
    let created = false;
    if (known.length > 0) {
      personId = [...known].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0]!.id;
      // Les contacts donnés servent la confirmation : un numéro connu en WhatsApp est aussi rangé comme téléphone (SMS).
      if (!ambiguous) for (const g of given) await this.fiche.addIdentifier({ networkId: input.networkId, personId, kind: g.kind, value: g.value });
    } else {
      const person = await this.store.createPerson({ networkId: input.networkId, agentId: input.agentId, firstName });
      for (const g of given) await this.store.addIdentifier({ networkId: input.networkId, personId: person.id, kind: g.kind, value: g.value });
      personId = person.id;
      created = true;
    }
    // L'accord, au moment où la personne réserve, avec sa preuve [R03].
    const consent = await this.store.addConsent({
      networkId: input.networkId,
      personId,
      purpose: APPOINTMENT_PURPOSE,
      channel,
      proof: `réservation en ligne (${input.source}) le ${at.toISOString()} : ${proof}`,
      givenAt: at,
    });
    let booked: Awaited<ReturnType<RendezVous['book']>>;
    try {
      booked = await this.rdv.book({
        networkId: input.networkId,
        agentId: input.agentId,
        personId,
        propertyId: input.propertyId ?? null,
        kind: input.kind,
        start: input.start,
        source: input.source,
        channel: ambiguous ? null : channel,
        // La confirmation et les rappels visent la coordonnée donnée, pas une plus ancienne de la fiche (V09).
        to: ambiguous ? null : given[0]!.value,
      });
    } catch (error) {
      await this.store.withdrawConsent(consent.id, at);
      throw error;
    }
    if (!booked.ok) {
      // Pas de rendez-vous : l'accord donné pour lui est annulé, la ligne reste. Fermé à sa propre date, il n'a jamais valu :
      // ce n'est pas un refus de la personne, et un rendez-vous déjà pris garde ses rappels [R03].
      await this.store.withdrawConsent(consent.id, at);
      await this.log(input, created, false, booked.code, ambiguous);
      return { ok: false, code: booked.code, rule: booked.rule };
    }
    // Le rendez-vous est pris : une panne du journal à ce moment ne doit pas faire perdre son jeton. Elle est rendue
    // à l'appelant (`warning`), comme pour un décalage [R13].
    const logged = await this.log(input, created, true, null, ambiguous).then(
      () => true,
      () => false,
    );
    const confirmation = booked.confirmation ? { status: booked.confirmation.status, rule: booked.confirmation.rule } : null;
    return {
      ok: true,
      appointment: { kind: booked.appointment.kind, start: booked.appointment.start_at, end: booked.appointment.end_at },
      token: booked.token,
      confirmation,
      ...(logged && !booked.warning ? {} : { warning: 'journal_failed' as const }),
    };
  }

  private async log(input: OnlineBooking, created: boolean, ok: boolean, code: string | null, ambiguous: boolean): Promise<void> {
    await appendEvent(
      this.journal,
      { type: 'rdv.en_ligne', actor: `intake:${input.source}`, subject: `agent:${input.agentId}`, data: { mode: 'essai', kind: input.kind, ok, code, newPerson: created, ambiguous } },
      this.now,
    );
  }
}
