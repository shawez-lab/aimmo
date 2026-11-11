/**
 * Les rappels des rendez-vous (M05, V04).
 *
 * Par le planificateur (B02), chaque rendez-vous tenu dont la personne a choisi un canal reçoit un rappel la veille et
 * un le jour même, avec un lien pour décaler ou annuler, par le contrôle central des envois (S06) : heures d'envoi
 * [R01], exclusions [R02], accord « rendez-vous » [R03], arrêt [R04], anti-doublon [R05]. Une ligne au plus par
 * rendez-vous et par sorte : un rappel de chaque sorte au plus. Une confirmation refusée pour l'heure à la réservation
 * (`confirmation_status = 'waiting'`) part ici, au premier passage dans les heures d'envoi. Rien pour un rendez-vous
 * annulé. Seuls les canaux du mode essai sont branchés : rien ne part [R26]. Le journal ne porte ni texte ni
 * coordonnée [R13].
 *
 * Décidé : la veille et le jour même s'entendent en dates de Paris. Un rappel qui ne peut pas partir ce jour-là (un
 * dimanche, un jour férié) n'est pas reporté au lendemain : il n'aurait plus de sens. Un rappel n'est pas fait le jour
 * où un autre message du même rendez-vous est déjà parti (confirmation du jour, rappel de la veille) : deux messages le
 * même jour pour le même rendez-vous seraient de trop.
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { OutboundChannelName } from '../db/types.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { localTime } from '../envoi/horaires.ts';
import { trialChannels } from '../captation/essai.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { AGENDA_TIME_ZONE, type AppointmentKind } from './creneaux.ts';
import { APPOINTMENT_PURPOSE, appointmentWhen, confirmationText, newBookingToken, tokenHash } from './reservation.ts';

export type ReminderKind = 'confirmation' | 'veille' | 'jour';
export type ReminderStatus = 'waiting' | 'sent' | 'refused' | 'failed' | 'skipped';

export interface ReminderOutcome {
  appointmentId: string;
  kind: ReminderKind;
  status: ReminderStatus;
  rule: string | null;
  /** Toujours faux : en mode essai, rien ne part [R26]. */
  delivered: false;
}

export interface RappelsOptions {
  now?: () => Date;
  /** Début du lien pour décaler ou annuler, terminé par `/`, sans chiffre ; absent, le rappel part sans lien. */
  linkBase?: string | null;
  /** Rendez-vous lus au plus par passage : les confirmations en attente, puis le double pour la veille et le jour. */
  batch?: number;
  newToken?: () => string;
}

export const REMINDER_JOB = 'rdv.rappels';
/** Les heures où la tâche passe : dans les heures d'envoi [R01], que le contrôle vérifie de toute façon. */
export const REMINDER_HOURS: readonly number[] = Object.freeze([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
export const REMINDER_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6]);

const LINK_BASE = /^https:\/\/[^\s\d]+\/$/;
const DAY_MS = 86_400_000;

const KIND_LABEL: Record<AppointmentKind, string> = {
  estimation: 'votre rendez-vous d’estimation est prévu',
  visite: 'votre visite est prévue',
  signature: 'votre rendez-vous de signature est prévu',
  appel: 'votre rendez-vous téléphonique est prévu',
};

/** Le texte du rappel, sans IA, sans adresse ; vouvoiement, prénom s'il est connu [R08]. */
export function reminderText(
  which: 'veille' | 'jour',
  kind: AppointmentKind,
  start: Date,
  firstName: string | null,
  link: string | null,
): { text: string; figures: number[] } {
  const when = appointmentWhen(start);
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const day = which === 'veille' ? 'demain' : 'aujourd’hui';
  const text = `${hello} petit rappel : ${KIND_LABEL[kind]} ${day}, ${when.text}.${link ? ` Pour le décaler ou l’annuler : ${link}` : ''}`;
  return { text, figures: when.figures };
}

/** La date de Paris d'un instant, `AAAA-MM-JJ`. */
const parisDate = (at: Date): string => localTime(at, AGENDA_TIME_ZONE).date;

interface Row {
  id: string;
  network_id: string;
  agent_id: string;
  person_id: string;
  kind: AppointmentKind;
  start_at: string;
  created_at: string;
  confirmation_status: string | null;
  confirmation_channel: OutboundChannelName;
  confirmation_to: string | null;
}

const COLUMNS = 'id, network_id, agent_id, person_id, kind, start_at, created_at, confirmation_status, confirmation_channel, confirmation_to';

export class RappelsRendezVous {
  private readonly fiche: FicheUnique;
  private readonly now: () => Date;
  private readonly linkBase: string | null;
  private readonly batch: number;
  private readonly newToken: () => string;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: RappelsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.linkBase = options.linkBase ?? null;
    this.batch = options.batch ?? 500;
    this.newToken = options.newToken ?? newBookingToken;
    if (this.linkBase && !LINK_BASE.test(this.linkBase)) throw new Error('Début de lien non valable : https, sans chiffre, terminé par /.');
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

  /** Un passage : d'abord les confirmations en attente, puis les rappels de la veille et du jour même. */
  async run(): Promise<ReminderOutcome[]> {
    const at = this.now();
    const stamp = at.toISOString();
    const today = parisDate(at);
    const tomorrow = parisDate(new Date(at.getTime() + DAY_MS));
    const waiting = await this.db.all<Row>(
      `SELECT ${COLUMNS} FROM appointments
       WHERE status = 'booked' AND confirmation_status = 'waiting' AND confirmation_channel IS NOT NULL AND start_at > ?
       ORDER BY start_at, id LIMIT ?`,
      [stamp, this.batch],
    );
    // Assez loin pour couvrir le lendemain entier, changement d'heure compris ; la date de Paris tranche ensuite.
    const upcoming = await this.db.all<Row>(
      `SELECT ${COLUMNS} FROM appointments
       WHERE status = 'booked' AND confirmation_channel IS NOT NULL AND start_at > ? AND start_at < ?
       AND NOT EXISTS (SELECT 1 FROM appointment_reminders r WHERE r.appointment_id = appointments.id AND r.kind = 'jour' AND r.status <> 'waiting')
       ORDER BY start_at, id LIMIT ?`,
      [stamp, new Date(at.getTime() + 2 * DAY_MS + 3_600_000).toISOString(), this.batch * 2],
    );
    const work: [Row, ReminderKind][] = waiting.map((r) => [r, 'confirmation']);
    for (const row of upcoming) {
      const date = parisDate(new Date(row.start_at));
      if (date === tomorrow) work.push([row, 'veille']);
      else if (date === today) work.push([row, 'jour']);
    }
    const outcomes: ReminderOutcome[] = [];
    let failure: unknown = null;
    for (const [row, kind] of work) {
      // Une panne sur un rendez-vous n'arrête pas les autres ; elle remonte ensuite au planificateur [R13].
      try {
        const outcome = await this.remind(row, kind);
        if (outcome) outcomes.push(outcome);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return outcomes;
  }

  private async remind(row: Row, kind: ReminderKind): Promise<ReminderOutcome | null> {
    const stamp = this.now().toISOString();
    // Réserver la ligne avant tout envoi : deux passages en même temps ne font qu'un message [R05].
    const inserted = await this.db.run(
      `INSERT INTO appointment_reminders (appointment_id, kind, status, mode, updated_at) VALUES (?, ?, 'pending', 'essai', ?) ON CONFLICT DO NOTHING`,
      [row.id, kind, stamp],
    );
    const claimed =
      inserted.changes === 1 ||
      (await this.db.run(`UPDATE appointment_reminders SET status = 'pending', updated_at = ? WHERE appointment_id = ? AND kind = ? AND status = 'waiting'`, [stamp, row.id, kind]))
        .changes === 1;
    if (!claimed) return null;
    try {
      return await this.afterClaim(row, kind);
    } catch (error) {
      // Une panne après la réservation ne perd pas le message : il repart au passage suivant ; le sujet de l'envoi
      // garde l'anti-doublon du contrôle central, un message déjà rangé n'est jamais refait [R05].
      await this.db.run(`UPDATE appointment_reminders SET status = 'waiting', updated_at = ? WHERE appointment_id = ? AND kind = ? AND status = 'pending'`, [
        this.now().toISOString(),
        row.id,
        kind,
      ]);
      throw error;
    }
  }

  /** Un autre message de ce rendez-vous est-il déjà parti ce jour-là (date de Paris) ? */
  private async alreadyToday(row: Row, kind: ReminderKind, today: string): Promise<boolean> {
    const sent = await this.db.all<{ kind: ReminderKind; updated_at: string }>(
      `SELECT kind, updated_at FROM appointment_reminders WHERE appointment_id = ? AND kind <> ? AND status = 'sent'`,
      [row.id, kind],
    );
    if (sent.some((s) => parisDate(new Date(s.updated_at)) === today)) return true;
    // La confirmation partie à la réservation, sans reprise par le planificateur.
    return row.confirmation_status === 'sent' && !sent.some((s) => s.kind === 'confirmation') && parisDate(new Date(row.created_at)) === today;
  }

  private async afterClaim(row: Row, kind: ReminderKind): Promise<ReminderOutcome> {
    const at = this.now();
    // Le rendez-vous a pu être annulé ou décalé depuis la lecture : rien pour un rendez-vous qui n'est plus tenu.
    const current = await this.db.first<{ status: string; confirmation_status: string | null }>('SELECT status, confirmation_status FROM appointments WHERE id = ?', [row.id]);
    let status: ReminderStatus;
    let rule: string | null = null;
    let messageId: string | null = null;
    if (!current || current.status !== 'booked' || (kind === 'confirmation' && current.confirmation_status !== 'waiting')) {
      status = 'skipped';
    } else if (kind !== 'confirmation' && (await this.alreadyToday(row, kind, parisDate(at)))) {
      status = 'skipped';
    } else {
      const firstName = await ficheFirstName(this.db, await this.fiche.membersOf(row.person_id));
      const link = await this.newLink(row.id);
      const start = new Date(row.start_at);
      const { text, figures } =
        kind === 'confirmation' ? confirmationText(row.kind, start, firstName, link) : reminderText(kind, row.kind, start, firstName, link);
      const result = await this.controle.send({
        networkId: row.network_id,
        agentId: row.agent_id,
        personId: row.person_id,
        channel: row.confirmation_channel,
        to: row.confirmation_to,
        kind: 'reminder',
        purpose: APPOINTMENT_PURPOSE,
        // Le sujet de la confirmation est celui de la réservation : le contrôle ne la fait jamais deux fois [R05].
        subject: kind === 'confirmation' ? `rdv_confirmation:${row.id}` : `rdv_rappel_${kind}:${row.id}`,
        fallbackTexts: [text],
        figures,
        // Le lien décale ou annule ce rendez-vous : remis au canal, jamais rangé en clair [HX61, RC16].
        ...(link ? { secrets: [{ kind: 'lien' as const, value: link }] } : {}),
      });
      messageId = result.messageId;
      // Refusé pour l'heure seulement [R01] : repris au passage suivant. Tout autre refus est définitif.
      status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' ? 'waiting' : 'refused';
      rule = result.status === 'sent' ? null : result.rule;
      if (kind === 'confirmation') {
        await this.db.run(`UPDATE appointments SET confirmation_status = ? WHERE id = ? AND confirmation_status = 'waiting'`, [status, row.id]);
      }
    }
    await this.db.run(`UPDATE appointment_reminders SET status = ?, rule = ?, message_id = ?, updated_at = ? WHERE appointment_id = ? AND kind = ?`, [
      status,
      rule,
      messageId,
      this.now().toISOString(),
      row.id,
      kind,
    ]);
    await appendEvent(
      this.journal,
      {
        type: 'rdv.rappel.essai',
        actor: 'system:planificateur',
        subject: `appointment:${row.id}`,
        data: { mode: 'essai', sent: false, kind, status, rule },
      },
      this.now,
    );
    return { appointmentId: row.id, kind, status, rule, delivered: false };
  }

  /** Un lien neuf pour décaler ou annuler, qui ne sert qu'à ce rendez-vous ; seule l'empreinte du jeton est gardée. */
  private async newLink(appointmentId: string): Promise<string | null> {
    if (!this.linkBase) return null;
    const token = this.newToken();
    await this.db.run('INSERT INTO appointment_links (token_hash, appointment_id, created_at) VALUES (?, ?, ?)', [await tokenHash(token), appointmentId, this.now().toISOString()]);
    return `${this.linkBase}${token}`;
  }
}

/** La tâche du planificateur : les rappels des rendez-vous, en mode essai. */
export function appointmentReminderJob(db: SqlDatabase, journal: JournalStore, options: RappelsOptions = {}): ScheduledJob {
  return {
    name: REMINDER_JOB,
    hours: REMINDER_HOURS,
    weekdays: REMINDER_WEEKDAYS,
    run: async () => {
      await new RappelsRendezVous(db, journal, options).run();
    },
  };
}
