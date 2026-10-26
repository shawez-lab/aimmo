/**
 * Les canaux de sortie. Seul le contrôle central des envois (controle.ts) appelle `deliver` :
 * un test parcourt le code et refuse tout autre appel.
 * Aucun vrai canal n'est branché dans le socle : les tests et le mode essai utilisent `FakeChannel`.
 */
import type { Channel } from '../db/types.ts';

export interface OutboundMessage {
  channel: Channel;
  /** Identifiant de la personne sur ce canal : adresse, numéro ou compte. */
  to: string;
  body: string;
  /** Identifiant interne du message rangé, pour relier l'accusé du canal. */
  messageId: string;
  /**
   * Instagram et Facebook : `to` est la conversation reçue, un message privé (compte propre au canal) ou un
   * commentaire (réponse privée au commentaire).
   */
  thread?: 'direct' | 'comment';
}

export interface DeliveryReceipt {
  /** Identifiant rendu par le canal, s'il en rend un. */
  externalId: string | null;
}

export interface OutboundChannel {
  readonly channel: Channel;
  deliver(message: OutboundMessage): Promise<DeliveryReceipt>;
}

/** Faux canal : garde les messages en mémoire, n'envoie rien. Peut simuler une panne. */
export class FakeChannel implements OutboundChannel {
  readonly sent: OutboundMessage[] = [];
  failWith: Error | null = null;

  constructor(readonly channel: Channel) {}

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { externalId: `fake-${this.sent.length}` };
  }
}
