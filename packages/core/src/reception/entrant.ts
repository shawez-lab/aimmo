/**
 * Format commun d'un message reçu, quel que soit le canal [C01].
 * Les adaptateurs de `adaptateurs.ts` y ramènent chaque notification ; rien n'est inventé ni deviné.
 */
import type { IdentifierKind } from '../db/types.ts';

export const INBOUND_CHANNELS = ['instagram', 'facebook', 'whatsapp', 'email', 'site'] as const;
export type InboundChannel = (typeof INBOUND_CHANNELS)[number];

/** `direct` : message privé ; `comment` : commentaire sous une publication ; `site_chat` : assistant du site. */
export const INBOUND_KINDS = ['direct', 'comment', 'email', 'portal_email', 'form', 'site_chat'] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];

/** Un identifiant de l'expéditeur, déjà normalisé comme dans la fiche (S04). */
export interface SenderIdentifier {
  kind: IdentifierKind;
  value: string;
}

export interface InboundSender {
  /**
   * Identifiant de la personne chez le canal quand ce n'est pas un identifiant de fiche :
   * numéro propre à la page chez Meta, session du site. Null quand le canal n'en donne pas.
   */
  channelId: string | null;
  /** Nom ou prénom tel que la personne l'a donné ou que le canal l'affiche. */
  name: string | null;
  /** Mail, téléphone ou compte normalisés, prêts pour la recherche de fiche de C02. */
  identifiers: SenderIdentifier[];
}

export interface InboundMessage {
  channel: InboundChannel;
  kind: InboundKind;
  /** Identifiant du message chez le canal : la clé de la réception unique [R18]. */
  externalId: string;
  /**
   * Les autres identifiants sous lesquels ce même message a pu être déjà rangé : l'identifiant du mail d'une demande de
   * portail rangée sous sa référence de demande (AU032). Un message déjà rangé sous l'un d'eux est un doublon [R18].
   */
  previousExternalIds?: readonly string[];
  /** Fil de la conversation chez le canal : conversation Meta, numéro WhatsApp, fil de mails, session du site. */
  conversationRef: string | null;
  sender: InboundSender;
  subject: string | null;
  text: string;
  receivedAt: Date;
  /** Publication ou vidéo commentée. */
  postRef: string | null;
  /** Bien cité par le canal lui-même : page d'annonce du site, référence du formulaire. */
  propertyRef: string | null;
  /** Portail d'où vient la demande, pour un mail de portail. */
  portal: string | null;
  /** Une pièce jointe est signalée ; elle n'est ni ouverte ni gardée ici. */
  hasAttachment: boolean;
}

/** Ce qu'un adaptateur n'a pas su lire : rangé tel quel et signalé à l'agent, jamais jeté. */
export interface UnreadableInbound {
  channel: InboundChannel;
  /** Raison en français, sans aucune donnée du message. */
  reason: string;
  /** Contenu brut, gardé dans la base pour que l'agent le lise ; jamais écrit au journal. */
  raw: string;
}

export interface AdaptResult {
  messages: InboundMessage[];
  unreadable: UnreadableInbound[];
  /** Événements qui ne sont pas des messages reçus : accusés de lecture, statuts, nos propres messages. */
  ignored: number;
}

export interface AdaptContext {
  /** Heure de réception, quand le canal ne donne pas de date lisible. */
  now: Date;
  /** Nos propres comptes chez le canal : ce qu'ils écrivent n'est pas un message reçu. */
  ownIds?: readonly string[];
}
