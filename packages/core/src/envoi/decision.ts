/**
 * La décision unique : peut-on écrire à cette personne, sur ce canal, pour ce type de message, maintenant ?
 * Fonction pure : elle reçoit les faits de la fiche et rend la règle qui a décidé. Elle n'envoie rien.
 * Le contrôle central des envois (S06) l'appelle avant toute sortie.
 *
 * Ordre d'examen, du plus fort au plus faible :
 *   R04, R02  une exclusion active ferme tous les canaux, réponses comprises ;
 *   R01       réponse à un message reçu il y a moins de 60 minutes : part tout de suite ;
 *             sinon, du lundi au samedi, de 8 h à 20 h ;
 *   R11       demandes d'avis et messages aux partenaires : plafonds et heures ;
 *   R03       tout message d'initiative par téléphone, SMS, WhatsApp ou mail demande un accord en cours
 *             sur ce canal et pour cette finalité, sauf la réponse à un message resté sans réponse.
 */
import type { Channel, Consent, Exclusion, Message } from '../db/types.ts';
import { isWorkingDay, localTime } from './horaires.ts';

export const SEND_KINDS = [
  'reply',
  'follow_up',
  'alert',
  'reminder',
  'review_request',
  'partner',
  'prospecting',
] as const;
/** Réponse, relance, alerte, rappel, demande d'avis, message à un partenaire, prospection. */
export type SendKind = (typeof SEND_KINDS)[number];

export type SendRule = 'R01' | 'R02' | 'R03' | 'R04' | 'R11';
export type PersonRelation = 'colleague' | 'associate' | 'relative';

/** Canaux où un premier contact non demandé exige un accord préalable [R03]. */
export const CONSENT_CHANNELS: readonly Channel[] = ['phone', 'sms', 'whatsapp', 'email'];

/** Les nombres des règles sont des réglages, pas du code. */
export interface SendSettings {
  timeZone: string;
  /** R01 : heures d'envoi d'initiative, en minutes depuis minuit, début inclus, fin exclue. */
  initiativeFrom: number;
  initiativeUntil: number;
  /** R01 : 1 = lundi … 7 = dimanche. */
  initiativeDays: readonly number[];
  /** R01 : une réponse part à toute heure si le message reçu a moins de ce nombre de minutes. */
  replyWindowMinutes: number;
  /** R11 : demandes d'avis. */
  reviewRequestsPerDay: number;
  reviewFrom: number;
  reviewUntil: number;
  /** R11 : messages aux partenaires par jour ouvré. */
  partnerMessagesPerWorkingDay: number;
}

export const DEFAULT_SEND_SETTINGS: SendSettings = Object.freeze({
  timeZone: 'Europe/Paris',
  initiativeFrom: 8 * 60,
  initiativeUntil: 20 * 60,
  initiativeDays: Object.freeze([1, 2, 3, 4, 5, 6]),
  replyWindowMinutes: 60,
  reviewRequestsPerDay: 2,
  reviewFrom: 9 * 60,
  reviewUntil: 19 * 60,
  partnerMessagesPerWorkingDay: 5,
});

export interface SendRequest {
  channel: Channel;
  kind: SendKind;
  /** Finalité de l'accord demandé [R03]. Par défaut, le type du message. */
  purpose?: string;
  /** Conversation à laquelle on répond. Obligatoire pour une réponse. */
  conversationId?: string | null;
  at: Date;
}

/** Ce que la décision doit savoir de la fiche, toutes fiches fusionnées comprises. */
export interface SendFacts {
  exclusions: readonly Pick<Exclusion, 'reason' | 'channel' | 'noted_at' | 'lifted_at'>[];
  consents: readonly Pick<Consent, 'purpose' | 'channel' | 'given_at' | 'withdrawn_at'>[];
  messages: readonly Pick<Message, 'conversation_id' | 'channel' | 'direction' | 'occurred_at'>[];
  relations: readonly { relation: PersonRelation; noted_at: string; ended_at: string | null }[];
  /** Messages déjà partis le même jour local, dans le réseau, par type [R11]. */
  sentToday: { review_request: number; partner: number };
}

export interface SendDecision {
  allowed: boolean;
  /** La règle qui a refusé, ou R01 quand une réponse part hors des heures grâce à son exception. */
  rule: SendRule | null;
  /** Raison en français, sans aucune donnée personnelle : elle va au journal [R13]. */
  reason: string;
  /** Les règles examinées, dans l'ordre. */
  checked: SendRule[];
}

/** Vrai si la période [début, fin) contient l'instant. */
function activeAt(start: string, end: string | null, at: number): boolean {
  return Date.parse(start) <= at && (end === null || Date.parse(end) > at);
}

function hhmm(minutes: number): string {
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

export function decideSend(
  request: SendRequest,
  facts: SendFacts,
  settings: SendSettings = DEFAULT_SEND_SETTINGS,
): SendDecision {
  const at = request.at.getTime();
  if (Number.isNaN(at)) throw new Error('Date non valable.');
  if (!(SEND_KINDS as readonly string[]).includes(request.kind)) throw new Error(`Type de message inconnu : ${request.kind}`);
  const checked: SendRule[] = [];
  const refuse = (rule: SendRule, reason: string): SendDecision => ({ allowed: false, rule, reason, checked });

  // R04 puis R02 : une exclusion active ferme tous les canaux, quel que soit le canal où elle a été notée.
  checked.push('R04', 'R02');
  const active = facts.exclusions.filter((e) => activeAt(e.noted_at, e.lifted_at, at));
  if (active.some((e) => e.reason === 'stop')) {
    return refuse('R04', 'La personne a demandé l’arrêt : plus aucun message, sur aucun canal.');
  }
  const exclusion = active[0];
  if (exclusion) return refuse('R02', `Personne exclue (${exclusion.reason}) : aucun message automatique, sur aucun canal.`);

  // R01 : la réponse à un message reçu il y a moins de 60 minutes part tout de suite, à toute heure.
  checked.push('R01');
  let answersPending = false;
  if (request.kind === 'reply') {
    if (!request.conversationId) throw new Error('Une réponse doit citer sa conversation.');
    const sameConversation = facts.messages.filter(
      // Un formulaire du site reçoit sa réponse par mail ou par téléphone : sa conversation est celle du site.
      (m) =>
        m.conversation_id === request.conversationId &&
        (m.channel === request.channel || m.channel === 'site') &&
        Date.parse(m.occurred_at) <= at,
    );
    const lastIn = Math.max(
      -Infinity,
      ...sameConversation.filter((m) => m.direction === 'in').map((m) => Date.parse(m.occurred_at)),
    );
    const lastOut = Math.max(
      -Infinity,
      ...sameConversation.filter((m) => m.direction === 'out').map((m) => Date.parse(m.occurred_at)),
    );
    if (lastIn > -Infinity && at - lastIn < settings.replyWindowMinutes * 60_000) {
      return {
        allowed: true,
        rule: 'R01',
        reason: `Réponse à un message reçu il y a moins de ${settings.replyWindowMinutes} minutes : elle part tout de suite.`,
        checked,
      };
    }
    // Plus tard, une réponse est un envoi d'initiative pour les heures ; elle reste une réponse pour R03
    // tant que le dernier message reçu de la conversation n'a pas eu de réponse.
    answersPending = lastIn > -Infinity && lastIn > lastOut;
  }

  const local = localTime(request.at, settings.timeZone);
  if (
    !settings.initiativeDays.includes(local.weekday) ||
    local.minutes < settings.initiativeFrom ||
    local.minutes >= settings.initiativeUntil
  ) {
    return refuse(
      'R01',
      `Hors des heures d’envoi : du lundi au samedi, de ${hhmm(settings.initiativeFrom)} à ${hhmm(settings.initiativeUntil)}.`,
    );
  }

  // R11 : plafonds.
  if (request.kind === 'review_request') {
    checked.push('R11');
    if (facts.relations.some((r) => activeAt(r.noted_at, r.ended_at, at))) {
      return refuse('R11', 'Jamais de demande d’avis à un collègue, un associé ou un proche.');
    }
    if (local.minutes < settings.reviewFrom || local.minutes >= settings.reviewUntil) {
      return refuse('R11', `Demande d’avis seulement de ${hhmm(settings.reviewFrom)} à ${hhmm(settings.reviewUntil)}.`);
    }
    if (facts.sentToday.review_request >= settings.reviewRequestsPerDay) {
      return refuse('R11', `Déjà ${settings.reviewRequestsPerDay} demandes d’avis aujourd’hui.`);
    }
  }
  if (request.kind === 'partner') {
    checked.push('R11');
    if (!isWorkingDay(local)) return refuse('R11', 'Messages aux partenaires seulement les jours ouvrés.');
    if (facts.sentToday.partner >= settings.partnerMessagesPerWorkingDay) {
      return refuse('R11', `Déjà ${settings.partnerMessagesPerWorkingDay} messages aux partenaires aujourd’hui.`);
    }
  }

  // R03 : accord préalable, en cours, sur ce canal et pour cette finalité.
  if (CONSENT_CHANNELS.includes(request.channel) && !answersPending) {
    checked.push('R03');
    const purpose = request.purpose ?? request.kind;
    const consent = facts.consents.find(
      (c) => c.channel === request.channel && c.purpose === purpose && activeAt(c.given_at, c.withdrawn_at, at),
    );
    if (!consent) {
      return refuse('R03', `Aucun accord préalable en cours pour ce canal (${request.channel}) et cette finalité.`);
    }
  }

  return { allowed: true, rule: null, reason: 'Envoi permis.', checked };
}
