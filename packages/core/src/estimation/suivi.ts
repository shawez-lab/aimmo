/**
 * Le suivi du vendeur après l'envoi de son avis de valeur (M04, E06).
 *
 * L'envoi d'un avis validé est noté [R30]. Si le vendeur n'a pas répondu après le délai réglé, le planificateur (B02)
 * lui fait une relance, une seule par avis, par le contrôle central des envois (S06) : heures d'envoi [R01],
 * exclusions [R02], accord [R03], arrêt [R04], anti-doublon [R05]. Seuls les canaux du mode essai sont branchés ici :
 * la relance est rangée, rien ne part [R26]. Le journal ne porte ni texte ni coordonnée [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { trialChannels } from '../captation/essai.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { VALUATION_PURPOSE } from '../reprise/reprise.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { AvisDeValeur, type AvisRefusal } from './avis.ts';

export type DeliveryChannel = 'email' | 'sms' | 'whatsapp';
export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['email', 'sms', 'whatsapp'];

export interface SuiviSettings {
  /** Jours sans réponse du vendeur avant la relance. Le cahier ne le chiffre pas : réglage de départ. */
  delayDays: number;
  /** Avis traités au plus par passage. */
  batch: number;
}

export const DEFAULT_SUIVI_SETTINGS: SuiviSettings = Object.freeze({ delayDays: 3, batch: 50 });

export const FOLLOW_UP_JOB = 'estimation.relance_vendeur';
/** Les heures où la tâche passe : dans les heures d'envoi [R01], que le contrôle vérifie de toute façon. */
export const FOLLOW_UP_HOURS: readonly number[] = Object.freeze([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
export const FOLLOW_UP_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6]);

export type FollowUpStatus = 'waiting' | 'answered' | 'sent' | 'refused' | 'failed';

export interface FollowUpOutcome {
  reportId: string;
  status: FollowUpStatus;
  rule: string | null;
  /** Toujours faux : en mode essai, rien ne part [R26]. */
  delivered: false;
}

export type DeliveryResult =
  | { ok: true; already: boolean }
  | { ok: false; rule: 'R30'; code: AvisRefusal }
  | { ok: false; rule: null; code: 'unknown_person' | 'other_network' | 'bad_channel' };

export interface SuiviOptions {
  now?: () => Date;
  settings?: SuiviSettings;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Le texte de la relance, sans IA, sans chiffre ni adresse ; vouvoiement, prénom s'il est connu [R08]. */
export function followUpText(firstName: string | null): string {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  return `${hello} avez-vous pu lire l’avis de valeur que je vous ai envoyé ? Je reste disponible pour en parler et pour préparer la suite avec vous.`;
}

export class SuiviVendeur {
  private readonly now: () => Date;
  private readonly settings: SuiviSettings;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly avis: AvisDeValeur;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: SuiviOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.settings = options.settings ?? DEFAULT_SUIVI_SETTINGS;
    const store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, store, { now: this.now });
    const decisions = new DecisionEnvoi(db, store, this.fiche, { now: this.now });
    // Seuls les canaux du mode essai : aucun vrai canal ne peut être passé de l'extérieur [R26].
    this.controle = new ControleEnvois(db, this.fiche, decisions, {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
    this.avis = new AvisDeValeur(db, journal, { now: this.now });
  }

  /** Note qu'un avis validé a été envoyé au vendeur ; un brouillon est refusé [R30]. Un avis n'est noté qu'une fois. */
  async noteSent(input: { reportId: string; personId: string; channel: DeliveryChannel; conversationId?: string | null; by: string }): Promise<DeliveryResult> {
    if (!DELIVERY_CHANNELS.includes(input.channel)) return { ok: false, rule: null, code: 'bad_channel' };
    const released = await this.avis.releasable(input.reportId);
    if (!released.ok) return released;
    const report = released.value.report;
    const person = await this.db.first<{ network_id: string }>('SELECT network_id FROM persons WHERE id = ?', [input.personId]);
    if (!person) return { ok: false, rule: null, code: 'unknown_person' };
    if (person.network_id !== report.network_id) return { ok: false, rule: null, code: 'other_network' };
    const at = this.now().toISOString();
    const done = await this.db.run(
      `INSERT INTO valuation_deliveries (report_id, network_id, person_id, channel, conversation_id, sent_at, noted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [report.id, report.network_id, input.personId, input.channel, input.conversationId ?? null, at, input.by],
    );
    if (done.changes === 1) {
      await appendEvent(
        this.journal,
        { type: 'avis.envoi_note', actor: input.by, subject: `property:${report.property_id}`, data: { report: report.id, channel: input.channel } },
        this.now,
      );
    }
    return { ok: true, already: done.changes !== 1 };
  }

  /** Un passage : chaque avis envoyé depuis plus que le délai, sans réponse ni relance, reçoit sa relance. */
  async run(): Promise<FollowUpOutcome[]> {
    const at = this.now();
    const due = new Date(at.getTime() - this.settings.delayDays * 86_400_000).toISOString();
    const rows = await this.db.all<{ report_id: string; network_id: string; person_id: string; channel: DeliveryChannel; conversation_id: string | null; sent_at: string; agent_id: string | null }>(
      `SELECT d.report_id, d.network_id, d.person_id, d.channel, d.conversation_id, d.sent_at, p.agent_id
       FROM valuation_deliveries d
       JOIN valuation_reports r ON r.id = d.report_id
       JOIN properties p ON p.id = r.property_id AND p.network_id = r.network_id
       LEFT JOIN valuation_follow_ups f ON f.report_id = d.report_id
       WHERE d.sent_at <= ? AND (f.report_id IS NULL OR f.status = 'waiting')
       ORDER BY d.sent_at, d.report_id LIMIT ?`,
      [due, this.settings.batch],
    );
    const outcomes: FollowUpOutcome[] = [];
    let failure: unknown = null;
    for (const row of rows) {
      // Une panne sur un avis n'arrête pas les autres ; elle remonte ensuite au planificateur, jamais avalée [R13].
      try {
        const outcome = await this.followUp(row, at);
        if (outcome) outcomes.push(outcome);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return outcomes;
  }

  private async followUp(
    row: { report_id: string; network_id: string; person_id: string; channel: DeliveryChannel; conversation_id: string | null; sent_at: string; agent_id: string | null },
    at: Date,
  ): Promise<FollowUpOutcome | null> {
    const stamp = at.toISOString();
    // Réserver l'avis avant tout envoi : deux passages en même temps ne font qu'une relance.
    const inserted = await this.db.run(
      `INSERT INTO valuation_follow_ups (report_id, status, mode, updated_at) VALUES (?, 'pending', 'essai', ?) ON CONFLICT DO NOTHING`,
      [row.report_id, stamp],
    );
    const claimed =
      inserted.changes === 1 ||
      (await this.db.run(`UPDATE valuation_follow_ups SET status = 'pending', updated_at = ? WHERE report_id = ? AND status = 'waiting'`, [stamp, row.report_id])).changes === 1;
    if (!claimed) return null;
    try {
      return await this.afterClaim(row, at);
    } catch (error) {
      // Une panne après la réservation ne perd pas la relance : elle repart au créneau suivant. Le sujet de l'envoi
      // garde l'anti-doublon du contrôle central, une relance déjà rangée n'est jamais refaite [R05].
      await this.db.run(`UPDATE valuation_follow_ups SET status = 'waiting', updated_at = ? WHERE report_id = ? AND status = 'pending'`, [
        this.now().toISOString(),
        row.report_id,
      ]);
      throw error;
    }
  }

  private async afterClaim(
    row: { report_id: string; network_id: string; person_id: string; channel: DeliveryChannel; conversation_id: string | null; sent_at: string; agent_id: string | null },
    at: Date,
  ): Promise<FollowUpOutcome> {
    // Le vendeur a répondu, ou son agent lui a écrit, depuis l'envoi : pas de relance, jamais.
    const ids = await this.fiche.membersOf(row.person_id);
    const answered = await this.db.first<{ id: string }>(
      `SELECT id FROM messages WHERE person_id IN (${placeholders(ids.length)}) AND occurred_at > ?
       AND (direction = 'in' OR author_kind = 'agent') LIMIT 1`,
      [...ids, row.sent_at],
    );
    let status: FollowUpStatus;
    let rule: string | null = null;
    let messageId: string | null = null;
    if (answered) {
      status = 'answered';
    } else {
      const firstName = await ficheFirstName(this.db, ids);
      const result = await this.controle.send({
        networkId: row.network_id,
        agentId: row.agent_id,
        personId: row.person_id,
        conversationId: row.conversation_id,
        channel: row.channel,
        kind: 'follow_up',
        purpose: VALUATION_PURPOSE,
        subject: `relance_avis:${row.report_id}`,
        fallbackTexts: [followUpText(firstName)],
        figures: [],
      });
      rule = result.rule;
      messageId = result.messageId;
      // Refusée pour l'heure seulement [R01] : reprise au créneau suivant. Tout autre refus est définitif.
      status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' ? 'waiting' : 'refused';
      if (result.status === 'sent') rule = null;
    }
    await this.db.run(`UPDATE valuation_follow_ups SET status = ?, rule = ?, message_id = ?, updated_at = ? WHERE report_id = ?`, [
      status,
      rule,
      messageId,
      this.now().toISOString(),
      row.report_id,
    ]);
    await appendEvent(
      this.journal,
      {
        type: 'avis.relance.essai',
        actor: 'system:planificateur',
        subject: `person:${row.person_id}`,
        data: { mode: 'essai', sent: false, report: row.report_id, status, rule },
      },
      this.now,
    );
    return { reportId: row.report_id, status, rule, delivered: false };
  }
}

/** La tâche du planificateur : la relance des vendeurs, en mode essai. */
export function vendorFollowUpJob(db: SqlDatabase, journal: JournalStore, options: SuiviOptions = {}): ScheduledJob {
  return {
    name: FOLLOW_UP_JOB,
    hours: FOLLOW_UP_HOURS,
    weekdays: FOLLOW_UP_WEEKDAYS,
    run: async () => {
      await new SuiviVendeur(db, journal, options).run();
    },
  };
}
