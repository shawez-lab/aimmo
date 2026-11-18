/**
 * Les canaux de sortie. Seul le contrôle central des envois (controle.ts) appelle `deliver` :
 * un test parcourt le code et refuse tout autre appel.
 * Aucun vrai canal n'est branché dans le socle : les tests et le mode essai utilisent `FakeChannel`.
 */
import type { OutboundChannelName } from '../db/types.ts';

export interface OutboundMessage {
  channel: OutboundChannelName;
  /** Identifiant de la personne sur ce canal : adresse, numéro ou compte. */
  to: string;
  body: string;
  /** Identifiant interne du message rangé, pour relier l'accusé du canal. */
  messageId: string;
  /**
   * Instagram et Facebook : `to` est la conversation reçue, un message privé (compte propre au canal) ou un
   * commentaire (réponse privée au commentaire). Assistant du site : `to` est la session du visiteur.
   */
  thread?: 'direct' | 'comment';
  /** Les pièces jointes d'un mail, produites par le code (AU003). */
  attachments?: readonly OutboundAttachment[];
}

/** Une pièce jointe : son nom, son type et son contenu en texte. */
export interface OutboundAttachment {
  name: string;
  contentType: 'text/html';
  content: string;
}

export interface DeliveryReceipt {
  /** Identifiant rendu par le canal, s'il en rend un. */
  externalId: string | null;
}

export interface OutboundChannel {
  readonly channel: OutboundChannelName;
  deliver(message: OutboundMessage): Promise<DeliveryReceipt>;
}

/** Faux canal : garde les messages en mémoire, n'envoie rien. Peut simuler une panne. */
export class FakeChannel implements OutboundChannel {
  readonly sent: OutboundMessage[] = [];
  failWith: Error | null = null;

  constructor(readonly channel: OutboundChannelName) {}

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { externalId: `fake-${this.sent.length}` };
  }
}

/**
 * Le port de l'agent (T09) : il ne remet rien, il prépare le lien `wa.me` que l'agent ouvrira de son propre téléphone.
 * C'est le seul port admis pour un message de l'agent : aucun vrai canal ne peut y passer.
 */
export class AgentWhatsAppLink implements OutboundChannel {
  readonly channel = 'whatsapp' as const;
  link: string | null = null;

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    const digits = message.to.replace(/\D/g, '');
    if (digits.length < 8) throw new Error('numéro WhatsApp non valable');
    this.link = `https://wa.me/${digits}?text=${encodeURIComponent(message.body)}`;
    return { externalId: null };
  }
}
