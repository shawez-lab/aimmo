/**
 * Les envois aux professionnels (U12) : un partenaire de l'annuaire, ou l'adresse professionnelle d'un futur partenaire.
 * Ni l'un ni l'autre n'est une personne de la fiche client, et aucune fiche n'est jamais créée pour eux. Leurs envois
 * passent pourtant par le seul chemin de sortie, le contrôle central des envois (`ControleEnvois.sendToProfessional`),
 * qui redécide au moment même de l'envoi : opposition [R04, R02], heures [R01], plafond du jour [R11, R79], accord
 * [R03], une seule fois [R05], texte sans mention de l'IA [R06].
 *
 * Mode essai : le seul port admis est la boîte d'essai (`ProTrialMailbox`), qui range l'envoi et ne l'envoie jamais.
 * Aucun vrai canal ne peut être branché ici tant qu'une tâche du plan ne l'a pas mis en service.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { DeliveryReceipt, OutboundChannel, OutboundMessage } from './canaux.ts';

/** Les deux sortes d'envoi à un professionnel : message à un partenaire [R11], prospection [R79]. */
export type ProSendKind = 'partner' | 'prospecting';

/** Finalité de l'accord d'un partenaire : recevoir par mail le suivi des demandes qui lui sont confiées [R03]. */
export const PARTNER_FOLLOW_UP_PURPOSE = 'suivi_partenaire';
/** Finalité de la prospection [R03] ; la même que celle des brouillons de U08. */
export const PRO_PROSPECTING_PURPOSE = 'prospection_partenaire';
/** Premiers mails de prospection au plus par jour ouvré, au moment de l'envoi aussi [R79]. */
export const PRO_PROSPECTING_PER_WORKING_DAY = 5;
/** La seule page qui sait lire le jeton d'opposition : tout mail de prospection porte ce lien [R79]. */
export const PRO_OPT_OUT_PATH = '/partenaires/opposition/';

export const PRO_TRIAL_JOURNAL_TYPE = 'envoi.essai.professionnel';

export interface ProSendOrder {
  networkId: string;
  kind: ProSendKind;
  /** Le destinataire, par son identifiant : l'adresse est lue par le contrôle, jamais donnée par l'appelant. */
  recipient: { partnerId: string } | { prospectId: string };
  /** Sujet de l'envoi, une seule fois [R05] : `relance:<mise en relation>`, `prospection:<adresse rangée>`. */
  subject: string;
  /** Le texte écrit par le code. */
  text: string;
  /** Chiffres permis dans le texte [R10]. */
  figures?: readonly (string | number)[];
  /** Une condition propre à l'envoi, revérifiée juste avant de partir (le partenaire n'a pas encore répondu…). */
  stillAllowed?: () => Promise<{ allowed: boolean; rule: string | null; reason: string }>;
}

/**
 * `sent` : rangé dans la boîte d'essai. `refused` : ne partira jamais tel quel (opposition, accord, doublon, texte).
 * `waiting` : pas maintenant (heure, plafond, jour, adresse) ; le passage suivant redécide. `failed` : panne.
 */
export type ProSendStatus = 'sent' | 'refused' | 'waiting' | 'failed';

export interface ProSendResult {
  status: ProSendStatus;
  rule: string | null;
  reason: string;
  sendId: string | null;
}

/** La boîte d'essai des professionnels : elle range ce qui aurait pu partir, sans texte ni adresse au journal [R13]. */
export class ProTrialMailbox implements OutboundChannel {
  readonly channel = 'email' as const;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    await this.db.run('INSERT INTO pro_trial_outbox (send_id, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [message.messageId, this.now().toISOString()]);
    await appendEvent(
      this.journal,
      { type: PRO_TRIAL_JOURNAL_TYPE, actor: 'system:essai', subject: `pro_send:${message.messageId}`, data: { mode: 'essai', sent: false, channel: 'email' } },
      this.now,
    );
    return { externalId: null };
  }
}

/** La dernière décision rangée pour un sujet : sert à ne pas redécider un envoi parti ou refusé pour de bon. */
export async function lastProDecision(db: SqlDatabase, networkId: string, subject: string): Promise<{ outcome: ProSendStatus; rule: string | null } | null> {
  return db.first<{ outcome: ProSendStatus; rule: string | null }>('SELECT outcome, rule FROM pro_send_log WHERE network_id = ? AND subject = ? ORDER BY id DESC LIMIT 1', [networkId, subject]);
}
