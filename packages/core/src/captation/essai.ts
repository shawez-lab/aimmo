/**
 * Le canal du mode essai (C06) : il prend la place du vrai canal derrière le contrôle central (S06). La réponse
 * a passé toutes les règles ; elle est rangée et écrite au journal, jamais envoyée. Aucun texte ni aucune
 * coordonnée au journal [R13] : seulement l'identifiant interne du message et son canal.
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { Channel } from '../db/types.ts';
import type { DeliveryReceipt, OutboundChannel, OutboundMessage } from '../envoi/canaux.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const TRIAL_JOURNAL_TYPE = 'envoi.essai';

export class TrialOutbox implements OutboundChannel {
  constructor(
    readonly channel: Channel,
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
  return (['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'phone'] as Channel[]).map((c) => new TrialOutbox(c, db, journal, now));
}
