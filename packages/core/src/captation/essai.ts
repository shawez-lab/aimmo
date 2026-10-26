/**
 * Le canal du mode essai (C06) : il prend la place du vrai canal derrière le contrôle central (S06). La réponse
 * a passé toutes les règles ; elle est rangée et écrite au journal, jamais envoyée. Aucun texte ni aucune
 * coordonnée au journal [R13] : seulement l'identifiant interne du message et son canal.
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { OutboundChannelName } from '../db/types.ts';
import { OUTBOUND_CHANNELS } from '../db/types.ts';
import type { DeliveryReceipt, OutboundChannel, OutboundMessage } from '../envoi/canaux.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const TRIAL_JOURNAL_TYPE = 'envoi.essai';

export class TrialOutbox implements OutboundChannel {
  constructor(
    readonly channel: OutboundChannelName,
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO trial_outbox (message_id, channel, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [
      message.messageId,
      this.channel,
      at,
    ]);
    await appendEvent(
      this.journal,
      {
        type: TRIAL_JOURNAL_TYPE,
        actor: 'system:essai',
        subject: `message:${message.messageId}`,
        data: { mode: 'essai', sent: false, channel: this.channel },
      },
      this.now,
    );
    return { externalId: null };
  }
}

/** Les canaux du mode essai, un par canal de sortie. */
export function trialChannels(db: SqlDatabase, journal: JournalStore, now?: () => Date): TrialOutbox[] {
  return OUTBOUND_CHANNELS.map((c) => new TrialOutbox(c, db, journal, now));
}

/**
 * La session de l'assistant du site, hors essai : la réponse passée par le contrôle central est remise au visiteur
 * dans la réponse même de son appel, et nulle part ailleurs. Rien n'est gardé ici au-delà de l'appel (C08).
 */
export class SiteSessionChannel implements OutboundChannel {
  readonly channel = 'site' as const;
  private readonly delivered = new Map<string, string[]>();

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    this.delivered.set(message.to, [...(this.delivered.get(message.to) ?? []), message.body]);
    return { externalId: null };
  }

  /** Les réponses remises à cette session pendant l'appel, puis oubliées. */
  take(session: string): string[] {
    const bodies = this.delivered.get(session) ?? [];
    this.delivered.delete(session);
    return bodies;
  }
}
