/**
 * Le contrôle central des envois : le seul chemin de sortie de tout message. Aucun autre code n'appelle un canal.
 *
 * Dans l'ordre, d'après le cahier (Architecture technique, « Le contrôle central des envois ») :
 *   0. rien ne part au nom d'un agent parti ni de ce qu'il a préparé, dès le jour de son départ ; un suivi passe à
 *      celui qui suit la fiche après la reprise [R86] ;
 *   1. décision d'envoi de S05 : arrêt, exclusions, horaires, plafonds, accord [R01 à R04, R11] ;
 *   2. anti-doublon par sujet : un bien, une relance ou une alerte, une seule fois par personne [R05] ;
 *   3. texte : celui de l'IA si son budget le permet et qu'elle répond à temps, sinon un texte de secours [R12] ;
 *   4. contrôle du texte, secrets masqués [R06 à R10], longueur, et anti-doublon du texte [R05] ; un texte refusé passe au secours ;
 *   5. mention de l'assistant au premier message automatique de la conversation [R06] ;
 *   6. enregistrement du message et du journal, puis envoi [R13].
 * Chaque refus est écrit au journal avec sa règle. Une panne du canal aussi : aucune erreur n'est avalée.
 */
import type { IdentifierKind, Message, OutboundChannelName } from '../db/types.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { AgentWhatsAppLink, type OutboundAttachment, type OutboundChannel } from './canaux.ts';
import { decideSend, type SendKind } from './decision.ts';
import type { DecisionEnvoi } from './service.ts';
import { isWorkingDay, localTime } from './horaires.ts';
import {
  PARTNER_FOLLOW_UP_PURPOSE,
  PRO_OPT_OUT_PATH,
  PRO_PROSPECTING_PER_WORKING_DAY,
  PRO_PROSPECTING_PURPOSE,
  ProTrialMailbox,
  type ProSendOrder,
  type ProSendResult,
  type ProSendStatus,
} from './professionnels.ts';
import type { SendJournal } from './journal-envois.ts';
import { AgentPushTrialBox, agentPushUrl, type AgentPushOrder, type AgentPushOutcome, type AgentPushService } from './notifications-agents.ts';
import { DEFAULT_TEXT_SETTINGS, checkText, plain, type TextSettings } from './texte.ts';
import { agentGone } from '../reseau/depart.ts';

/**
 * Le palier d'un canal (C09b) [R26] : pour chaque message, le vrai canal s'il part vraiment, sinon `null` et la boîte
 * d'essai. Avec un palier, un message de la boîte d'essai ne compte jamais comme parti [R05, R06, R11].
 */
export interface ChannelStaging {
  route(networkId: string, channel: OutboundChannelName, ref: string | null): Promise<{ real: OutboundChannel | null; confirm: () => Promise<void> }>;
  /** Le vrai canal est tombé : ce canal revient en essai, les autres ne bougent pas. */
  failed(networkId: string, channel: OutboundChannelName): Promise<void>;
}

/** Plafond du coût de l'IA [R12]. */
export interface AiBudget {
  allows(networkId: string, at: Date): Promise<boolean>;
}

/**
 * Un secret porté par le message : code à usage unique ou lien personnel de signature ou d'ouverture (D08, W12, T05,
 * HX44). Il est remis au canal tel quel, mais rangé masqué : l'agent qui lit la fiche ne peut pas agir à la place du
 * client [R16, HX61].
 */
export interface SendSecret {
  kind: 'code' | 'lien';
  value: string;
}

export const MASKED_SECRET: Record<SendSecret['kind'], string> = { code: '[code masqué]', lien: '[lien masqué]' };

/** Le texte à ranger : chaque secret remplacé, partout où il paraît, les plus longs d'abord. */
export function maskSecrets(body: string, secrets: readonly SendSecret[]): string {
  let out = body;
  for (const s of [...secrets].sort((a, b) => b.value.length - a.value.length)) out = out.split(s.value).join(MASKED_SECRET[s.kind]);
  return out;
}

export interface SendOrder {
  networkId: string;
  agentId?: string | null;
  /** L'agent qui a préparé ou validé l'envoi, s'il n'est pas l'agent du message : il part, l'envoi ne part plus [R86]. */
  preparedBy?: string | null;
  personId: string;
  projectId?: string | null;
  conversationId?: string | null;
  channel: OutboundChannelName;
  kind: SendKind;
  /** Finalité de l'accord [R03] ; par défaut, le type. */
  purpose?: string;
  /** L'accord est exigé sur tout canal, et revérifié après la rédaction (alertes de biens, R49). */
  consentOnEveryChannel?: boolean;
  /**
   * Une condition propre à l'envoi, revérifiée juste avant l'enregistrement, après la rédaction : par exemple qu'un
   * bien proposé puisse encore être diffusé [R42]. Refusée : rien ne part, le refus va au journal avec sa règle.
   */
  stillAllowed?: () => Promise<{ allowed: boolean; rule: string; reason: string }>;
  /**
   * Message de l'agent, envoyé de son propre téléphone (T09) : la décision ne retient ni R21 ni R22, aucune mention
   * de l'assistant n'est ajoutée [R06], le message est rangé comme écrit par l'agent, et il est remis à ce port (qui
   * prépare le lien pour l'agent) au lieu du canal du réseau. Pas d'IA : le texte est celui du code.
   */
  byAgent?: { port: AgentWhatsAppLink };
  /**
   * Message qu'un autre système envoie lui-même (le site, B04b) : le contrôle le range exactement tel quel, n'y ajoute
   * aucune mention, et ne la tient pour donnée que si le texte la porte, en un paragraphe exact [R06]. Un seul texte, sans
   * IA. Sans mention due : rangé et signalé, ou refusé avec R06 si `refuseWithoutMention` (quand la décision vaut).
   * `thread` : le fil où il est rangé, à lui seul. La mention n'y est tenue pour donnée que par ce que ce système a
   * vraiment envoyé, et ce fil ne dispense aucun autre appelant de la sienne. Il n'entre pas dans la décision : ce n'est
   * pas une conversation avec la personne.
   */
  asWritten?: { refuseWithoutMention: boolean; thread: string };
  /** Sujet d'un envoi d'initiative, par exemple `relance:projet-12` [R05]. Obligatoire hors réponse, sauf biens. */
  subject?: string | undefined;
  /** Biens proposés : chacun ne part qu'une fois à la personne [R05]. */
  propertyIds?: readonly string[];
  /** Rédaction par l'IA. Absente : texte de secours. */
  compose?: () => Promise<string>;
  /** Textes de secours écrits sans IA, essayés dans l'ordre [R12]. */
  fallbackTexts: readonly string[];
  /** Le message, tiré une fois pour toutes pour son palier [R26]. Sans lui, avec un palier : la boîte d'essai. */
  rolloutRef?: string;
  /** Chiffres permis dans le texte : ceux de la base ou d'une source publique citée [R10]. */
  figures?: readonly (string | number)[];
  /** Noms des vendeurs du bien cité, interdits dans le texte [R19]. */
  sellerNames?: readonly string[];
  /** Nombre de questions permis dans le texte. */
  maxQuestions?: number;
  /** Les secrets du texte : remis au canal, jamais rangés en clair, ni dans les messages, ni dans le résultat [HX61]. */
  secrets?: readonly SendSecret[];
  /**
   * Les pièces jointes d'un mail (AU003 : l'exemplaire signé et son dossier de preuve) : produites par le code, jamais
   * par l'IA ; remises au canal réel seulement, jamais rangées avec le message ni mises dans la boîte d'essai.
   */
  attachments?: readonly OutboundAttachment[];
  /**
   * La coordonnée à viser, normalisée, quand la personne l'a choisie (réservation en ligne, V09) : elle doit être une
   * coordonnée de la fiche pour ce canal, fiches réunies comprises ; sinon l'envoi est refusé. Absente : la première.
   */
  to?: string | null;
}

export type SendStatus = 'sent' | 'refused' | 'failed';

export interface SendResult {
  status: SendStatus;
  rule: string | null;
  reason: string;
  messageId: string | null;
  body: string | null;
  aiText: boolean;
  fallbackText: boolean;
  withMention: boolean;
  /** Une réponse que le contrôle n'a pas pu laisser partir : l'agent doit répondre lui-même [R12]. */
  needsHuman: boolean;
  /** Texte tel quel (`asWritten`) seulement : la mention était due et le texte ne la porte pas [R06]. */
  mentionMissing?: boolean;
  /** Avec un palier seulement : rangé dans la boîte d'essai, rien n'est parti, et il ne compte pas comme parti. */
  trial?: boolean;
}

export interface ControleSettings {
  text: TextSettings;
  /** Au-delà, l'IA est réputée ne pas répondre [R12]. */
  aiTimeoutMs: number;
  /** Mention légale [R06]. `{prenom}` : prénom de l'agent. */
  mentionInstagram: string;
  mentionWithAgent: string;
  mentionWithoutAgent: string;
}

export const DEFAULT_CONTROLE_SETTINGS: ControleSettings = Object.freeze({
  text: DEFAULT_TEXT_SETTINGS,
  aiTimeoutMs: 20_000,
  mentionInstagram: 'Réponse rapide de mon assistant IA, je prends le relais moi-même.',
  mentionWithAgent: 'Réponse immédiate de l’assistant IA de {prenom}, qui vous recontacte personnellement.',
  mentionWithoutAgent: 'Réponse immédiate de l’assistant IA de votre agent immobilier, qui vous recontacte personnellement.',
});

export interface ControleEnvoisOptions {
  channels: readonly OutboundChannel[];
  journal: SendJournal;
  budget?: AiBudget;
  settings?: ControleSettings;
  now?: () => Date;
  /** Les paliers des canaux (C09b) ; `channels` est alors la boîte d'essai. Absents : `channels` reçoit tout. */
  staging?: ChannelStaging;
  /** La boîte d'essai des envois aux professionnels (U12) ; absente, rien ne leur part. */
  proMailbox?: ProTrialMailbox;
  /** La boîte d'essai des notifications aux agents (SV15) ; absente, rien ne part vers un téléphone. */
  agentPush?: AgentPushTrialBox;
}

const IDENTIFIER_FOR: Record<OutboundChannelName, readonly IdentifierKind[]> = {
  email: ['email'],
  phone: ['phone'],
  sms: ['phone'],
  whatsapp: ['whatsapp', 'phone'],
  instagram: ['instagram'],
  facebook: ['facebook'],
  // L'assistant du site ne répond qu'à la session du visiteur, jamais à une coordonnée de la fiche.
  site: [],
};

const AUTOMATIC = new Set(['ai', 'system']);
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const sameText = (text: string): string => plain(text).replace(/[^a-z0-9]+/g, ' ').trim();

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('délai dépassé')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export class ControleEnvois {
  private readonly channels: ReadonlyMap<OutboundChannelName, OutboundChannel>;
  private readonly settings: ControleSettings;
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly fiche: FicheUnique,
    private readonly decisions: DecisionEnvoi,
    private readonly options: ControleEnvoisOptions,
  ) {
    this.channels = new Map(options.channels.map((c) => [c.channel, c]));
    this.settings = options.settings ?? DEFAULT_CONTROLE_SETTINGS;
    this.now = options.now ?? (() => new Date());
  }

  /** Avec un palier, un message de la boîte d'essai ne compte pas comme parti : la lecture des appelants doit suivre. */
  get trialNotCounted(): boolean {
    return this.options.staging !== undefined;
  }

  /** Les mentions possibles, pour reconnaître un message qui en porte une. */
  private isMention(paragraph: string): boolean {
    const p = sameText(paragraph);
    return [this.settings.mentionInstagram, this.settings.mentionWithAgent, this.settings.mentionWithoutAgent].some((m) => {
      const [head = ''] = sameText(m).split(' prenom');
      return p.startsWith(head);
    });
  }

  private withoutMention(body: string): string {
    const [first = '', ...rest] = body.split('\n\n');
    return rest.length > 0 && this.isMention(first) ? rest.join('\n\n') : body;
  }

  /** Un texte tel quel peut porter sa mention après son sujet : tout paragraphe de mention est retiré. */
  private withoutAnyMention(body: string): string {
    return body
      .split('\n\n')
      .filter((p) => !this.isMention(p))
      .join('\n\n');
  }

  /** Le texte tel quel, sans le seul paragraphe de mention exacte qu'il peut porter ; `null` s'il n'en porte pas [R06]. */
  private exactMentionRemoved(text: string, agentFirstName: string | null): string | null {
    // Comparée à la lettre : ce paragraphe n'est plus contrôlé ensuite, rien ne doit s'y glisser.
    const exact = (paragraph: string): string => paragraph.trim().replace(/’/g, "'");
    const accepted = [this.settings.mentionWithoutAgent, ...(agentFirstName ? [this.settings.mentionWithAgent.replace('{prenom}', agentFirstName)] : [])].map(exact);
    const paragraphs = text.split('\n\n');
    const at = paragraphs.findIndex((p) => accepted.includes(exact(p)));
    return at < 0 ? null : paragraphs.filter((_, i) => i !== at).join('\n\n');
  }

  async send(order: SendOrder): Promise<SendResult> {
    // L'heure est toujours celle du contrôle, jamais celle de l'appelant : l'envoi part maintenant [R01].
    const at = this.now();
    const subjects = [...(order.subject ? [order.subject] : []), ...(order.propertyIds ?? []).map((id) => `bien:${id}`)];
    if (order.kind !== 'reply' && subjects.length === 0) {
      throw new Error('Un envoi d’initiative cite son sujet ou ses biens [R05].');
    }
    const secrets = order.secrets ?? [];
    // Un secret trop court masquerait n'importe quoi : c'est une erreur de l'appelant.
    if (secrets.some((x) => typeof x.value !== 'string' || x.value.trim().length < 4 || !(x.kind in MASKED_SECRET))) {
      throw new Error('Un secret à masquer a au moins 4 caractères [HX61].');
    }
    // Sans clé de texte, le sujet seul garde l'anti-doublon d'un message à secret : il en faut un [R05].
    if (secrets.length > 0 && subjects.length === 0) throw new Error('Un message à secret cite son sujet [R05, HX61].');
    let agentId = order.agentId ?? null;
    const log = async (
      outcome: SendStatus,
      rule: string | null,
      reason: string,
      extra: Partial<Pick<SendResult, 'messageId' | 'body' | 'aiText' | 'fallbackText' | 'withMention' | 'needsHuman' | 'mentionMissing' | 'trial'>> = {},
    ): Promise<SendResult> => {
      const result: SendResult = {
        status: outcome,
        rule,
        reason,
        messageId: extra.messageId ?? null,
        body: extra.body ?? null,
        aiText: extra.aiText ?? false,
        fallbackText: extra.fallbackText ?? false,
        withMention: extra.withMention ?? false,
        needsHuman: extra.needsHuman ?? false,
        ...(extra.mentionMissing === undefined ? {} : { mentionMissing: extra.mentionMissing }),
        ...(extra.trial === undefined ? {} : { trial: extra.trial }),
      };
      await this.options.journal.record({
        networkId: order.networkId,
        agentId,
        personId: order.personId,
        messageId: result.messageId,
        channel: order.channel,
        kind: order.kind,
        outcome,
        rule,
        reason,
        aiText: result.aiText,
        fallbackText: result.fallbackText,
        withMention: result.withMention,
        occurredAt: at,
      });
      return result;
    };

    // 0. Un envoi au nom d'un agent parti, ou préparé par lui, ne part plus, dès minuit le jour du départ [R86].
    // Un envoi préparé ou validé par lui : jamais. Un suivi du système (relance, alerte) rangé à son nom : il ne part plus
    // en son nom ; une fois la fiche passée à son successeur ou à la direction, il part au nom de celui qui la suit, pour
    // qu'aucun suivi ne s'arrête [R86].
    const preparedBy = order.preparedBy ?? null;
    if (preparedBy !== null && preparedBy !== '' && (await agentGone(this.db, order.networkId, preparedBy, at))) return log('refused', 'R86', 'L’agent qui a préparé cet envoi a quitté le réseau.');

    const view = await this.fiche.view(order.personId);
    if (agentId !== null && agentId !== '' && (await agentGone(this.db, order.networkId, agentId, at))) {
      const current = view.person.agent_id;
      // Un message écrit par l'agent lui-même, de son téléphone, ne passe jamais à un autre.
      if (order.byAgent) return log('refused', 'R86', 'L’agent de cet envoi a quitté le réseau.');
      if (current === null || current === '') agentId = null;
      else if (current !== agentId && !(await agentGone(this.db, order.networkId, current, at))) agentId = current;
      else return log('refused', 'R86', 'L’agent de cet envoi a quitté le réseau.');
    }
    const ids = view.members.map((p) => p.id);
    // Les messages dont l'envoi a échoué ne comptent ni pour la décision, ni pour l'anti-doublon, ni pour la mention.
    const failed = new Set(
      (
        await this.db.all<{ message_id: string }>(
          `SELECT message_id FROM send_log WHERE outcome = 'failed' AND message_id IS NOT NULL AND person_id IN (${placeholders(ids.length)})`,
          ids,
        )
      ).map((r) => r.message_id),
    );
    // Avec un palier, ce qui est resté dans la boîte d'essai n'est pas parti : il ne compte pour rien.
    const staging = order.byAgent ? null : (this.options.staging ?? null);
    if (staging) {
      const boxed = await this.db.all<{ message_id: string }>(
        `SELECT t.message_id FROM trial_outbox t JOIN messages m ON m.id = t.message_id WHERE m.person_id IN (${placeholders(ids.length)})`,
        ids,
      );
      for (const r of boxed) failed.add(r.message_id);
    }
    const decide = (when: Date) =>
      this.decisions.decide(
        order.personId,
        {
          channel: order.channel,
          kind: order.kind,
          ...(order.purpose === undefined ? {} : { purpose: order.purpose }),
          ...(order.consentOnEveryChannel ? { consentOnEveryChannel: true } : {}),
          ...(order.byAgent ? { byAgent: true } : {}),
          conversationId: order.conversationId ?? null,
          at: when,
        },
        failed,
      );

    // 1. Décision d'envoi [R01 à R04, R11].
    const decision = await decide(at);
    if (!decision.allowed) return log('refused', decision.rule, decision.reason);

    const asWritten = order.asWritten ?? null;
    if (asWritten && (order.compose || order.byAgent || order.fallbackTexts.length !== 1)) {
      return log('refused', null, 'Un texte tel quel est un seul texte, sans IA et sans agent.');
    }
    if (order.byAgent && (!(order.byAgent.port instanceof AgentWhatsAppLink) || order.byAgent.port.channel !== order.channel || !agentId || order.compose)) {
      return log('refused', null, 'Un message de l’agent cite son agent et son canal, sans IA.');
    }
    const port = order.byAgent ? order.byAgent.port : this.channels.get(order.channel);
    if (!port) return log('refused', null, 'Canal non branché.');
    // Sur Instagram et Facebook, on répond dans la conversation reçue : le compte propre au canal (message privé)
    // ou le commentaire (réponse privée) ; un nom de compte ne sert pas d'adresse chez Meta (C07). La conversation
    // doit être celle de la personne : un message reçu d'elle, fiches réunies comprises, y est rangé.
    const thread = await this.metaThread(order.channel, order.conversationId ?? null, view.person.network_id, ids);
    // Assistant du site : la réponse va à la session d'où la personne a écrit, et nulle part ailleurs (C08).
    const session = await this.siteSession(order.channel, order.conversationId ?? null, view.person.network_id, ids);
    const to =
      thread?.ref ??
      session ??
      (order.to
        ? view.identifiers.find((i) => i.value === order.to && IDENTIFIER_FOR[order.channel].includes(i.kind))?.value
        : IDENTIFIER_FOR[order.channel].map((kind) => view.identifiers.find((i) => i.kind === kind)).find((i) => i !== undefined)?.value);
    if (!to && order.to) return log('refused', null, 'La coordonnée demandée n’est pas à la fiche pour ce canal.');
    if (!to) return log('refused', null, 'Aucun identifiant de la personne pour ce canal.');
    const sentBefore = view.messages.filter((m) => m.direction === 'out' && !failed.has(m.id) && Date.parse(m.occurred_at) <= at.getTime());

    // 2. Anti-doublon par sujet, sur tous les canaux, toutes fiches fusionnées comprises [R05].
    if (subjects.length > 0) {
      const dup = await this.db.first<{ subject: string }>(
        `SELECT s.subject FROM message_subjects s
         WHERE s.person_id IN (${placeholders(ids.length)}) AND s.subject IN (${placeholders(subjects.length)})
           AND NOT EXISTS (SELECT 1 FROM send_log l WHERE l.message_id = s.message_id AND l.outcome = 'failed')
           ${staging ? 'AND NOT EXISTS (SELECT 1 FROM trial_outbox t WHERE t.message_id = s.message_id)' : ''}
         LIMIT 1`,
        [...ids, ...subjects],
      );
      if (dup) {
        return log('refused', 'R05', dup.subject.startsWith('bien:') ? 'Ce bien a déjà été envoyé à la personne.' : 'Ce sujet a déjà été envoyé à la personne.', {
          // Une réponse qui ne peut pas partir n'est jamais un silence : l'agent est prévenu [R12].
          needsHuman: order.kind === 'reply',
        });
      }
    }

    // 3. Le texte : IA si possible, sinon secours [R12].
    const threadId = asWritten?.thread ?? order.conversationId ?? null;
    const inConversation = (m: Message): boolean =>
      threadId ? m.conversation_id === threadId : m.conversation_id === null && m.channel === order.channel;
    const conversation = sentBefore.filter(inConversation);
    const firstOfConversation = conversation.length === 0;
    // L'agent qui écrit lui-même n'a pas de mention d'assistant à porter [R06].
    let withMention = !order.byAgent && !asWritten && !conversation.some((m) => AUTOMATIC.has(m.author_kind));
    // Un texte tel quel : la mention reste due tant qu'aucun message automatique ne l'a vraiment portée [R06].
    const mentionDue = asWritten !== null && !conversation.some((m) => AUTOMATIC.has(m.author_kind) && m.body.split('\n\n').some((p) => this.isMention(p)));
    const agentFirstName = mentionDue && agentId ? ((await this.db.first<{ first_name: string }>('SELECT first_name FROM agents WHERE id = ? AND network_id = ?', [agentId, order.networkId]))?.first_name ?? null) : null;

    let mention = '';
    if (withMention) {
      mention = this.settings.mentionWithoutAgent;
      if (order.channel === 'instagram') mention = this.settings.mentionInstagram;
      else if (agentId) {
        const agent = await this.db.first<{ first_name: string }>('SELECT first_name FROM agents WHERE id = ? AND network_id = ?', [agentId, order.networkId]);
        if (agent?.first_name) mention = this.settings.mentionWithAgent.replace('{prenom}', agent.first_name);
      }
    }
    const withMentionText = (text: string): string => (mention ? `${mention}\n\n${text.trim()}` : text.trim());
    const maxLength = this.settings.text.maxLength[order.channel];

    let aiNote: string | null = null;
    // `core` : ce qui est contrôlé et comparé. Le texte lui-même, hors la mention exacte que porte un texte tel quel.
    const candidates: { text: string; core: string; ai: boolean }[] = [];
    if (order.compose) {
      if (this.options.budget && !(await this.options.budget.allows(order.networkId, at))) {
        aiNote = 'Plafond du coût de l’IA atteint : texte de secours.';
      } else {
        try {
          const text = await timeout(order.compose(), this.settings.aiTimeoutMs);
          candidates.push({ text, core: text, ai: true });
        } catch {
          aiNote = 'L’IA n’a pas répondu : texte de secours.';
        }
      }
    }
    candidates.push(...order.fallbackTexts.map((text) => ({ text, core: (mentionDue ? this.exactMentionRemoved(text, agentFirstName) : null) ?? text, ai: false })));
    if (candidates.length === 0) return log('refused', 'R12', 'Aucun texte de secours fourni : rien ne peut partir.');

    // 4. Contrôle du texte et anti-doublon du texte [R05 à R10].
    const already = new Set(sentBefore.map((m) => sameText(asWritten ? this.withoutAnyMention(m.body) : this.withoutMention(m.body))));
    const firstName = view.members.map((p) => p.first_name).find((n) => n) ?? null;
    let chosen: { text: string; core: string; ai: boolean } | null = null;
    const problems: { rule: string; reason: string; ai: boolean }[] = [];
    for (const candidate of candidates) {
      // Le texte est relu secrets masqués : les lettres tirées au hasard d'un lien ou les chiffres d'un code ne sont
      // pas des mots ni des chiffres écrits [R06, R10, RC08]. Le reste du texte est relu entier.
      const found = checkText(
        maskSecrets(candidate.core, secrets),
        {
          audience: 'client',
          channel: order.channel,
          firstOfConversation,
          firstName,
          figures: order.figures ?? [],
          sellerNames: order.sellerNames ?? [],
          ...(order.maxQuestions === undefined ? {} : { maxQuestions: order.maxQuestions }),
        },
        this.settings.text,
      );
      const issues: { rule: string; reason: string }[] = found;
      if (issues.length === 0 && withMentionText(candidate.text).length > maxLength) {
        issues.push({ rule: 'length', reason: `Texte trop long pour ce canal, mention comprise : ${maxLength} caractères au plus.` });
      }
      if (issues.length === 0 && already.has(sameText(candidate.core))) {
        issues.push({ rule: 'R05', reason: 'Ce message a déjà été envoyé à la personne.' });
      }
      if (issues.length === 0) {
        chosen = candidate;
        break;
      }
      problems.push(...issues.map((p) => ({ ...p, ai: candidate.ai })));
    }
    if (!chosen) {
      const worst = problems.find((p) => !p.ai) ?? problems[0];
      // Une réponse qui ne peut pas partir n'est pas un silence voulu : elle est signalée à l'agent [R12].
      const needsHuman = order.kind === 'reply';
      return log(
        'refused',
        worst?.rule ?? 'R12',
        `Aucun texte ne passe le contrôle : ${worst?.reason ?? 'aucun texte.'}${needsHuman ? ' L’agent doit répondre lui-même.' : ''}`,
        { needsHuman },
      );
    }
    const aiRefused = problems.find((p) => p.ai);
    if (!chosen.ai && aiRefused) aiNote = `Texte de l’IA refusé, ${aiRefused.rule} : texte de secours.`;

    // 5. Mention de l'assistant [R06]. Un texte tel quel la porte lui-même, ou elle lui manque.
    const mentionMissing = mentionDue && chosen.core === chosen.text;
    if (asWritten) {
      withMention = mentionDue && !mentionMissing;
      if (mentionMissing && asWritten.refuseWithoutMention) {
        return log('refused', 'R06', 'Le premier message automatique doit porter la mention de l’assistant : ce texte ne la porte pas.', { mentionMissing });
      }
    }
    const body = asWritten ? chosen.text : withMentionText(chosen.text);
    // Remis au canal tel quel ; rangé, rendu et relu avec chaque secret masqué [HX61].
    const stored = maskSecrets(body, secrets);

    // La rédaction a pu durer : un arrêt ou une exclusion arrivés entre-temps l'emportent [R02, R04].
    const last = await decide(this.now());
    if (!last.allowed) return log('refused', last.rule, last.reason);
    if (order.stillAllowed) {
      const still = await order.stillAllowed();
      if (!still.allowed) return log('refused', still.rule, still.reason);
    }

    // Réservation atomique des sujets, du texte et de la mention : de deux envois simultanés, un seul passe [R05, R06].
    const reservationId = crypto.randomUUID();
    const conversationKey = threadId ? `conversation:${threadId}` : `canal:${order.channel}`;
    const keys = [
      ...new Set([
        ...subjects.map((k) => `sujet:${k}`),
        // Un texte à secret n'a pas de clé de texte : elle garderait le secret en clair, et son empreinte se
        // retrouverait en essayant chaque code. Son sujet, propre à la session, garde l'anti-doublon [R05, HX61].
        ...(secrets.length === 0 ? [`texte:${sameText(chosen.core)}`] : []),
        ...(withMention ? [`mention:${conversationKey}`] : []),
      ]),
    ];
    const root = view.person.id;
    const release = (reason: string) =>
      Promise.all([
        this.db.run(`UPDATE send_reservations SET key = key || '#${reason}:' || reservation_id WHERE reservation_id = ?`, [reservationId]),
        this.db.run(`UPDATE send_quota_slots SET slot = slot || '#${reason}:' || reservation_id WHERE reservation_id = ?`, [reservationId]),
      ]);
    try {
      await this.db.run(
        `INSERT INTO send_reservations (person_id, key, reservation_id, network_id, message_id, created_at) VALUES ${keys
          .map(() => '(?, ?, ?, ?, NULL, ?)')
          .join(', ')}`,
        keys.flatMap((key) => [root, key, reservationId, view.person.network_id, at.toISOString()]),
      );
    } catch (error) {
      const takenKeys = await this.db.all<{ key: string }>(
        `SELECT key FROM send_reservations WHERE person_id = ? AND key IN (${placeholders(keys.length)})`,
        [root, ...keys],
      );
      // Le doublon prime sur la mention : c'est lui qui dit pourquoi ce message ne partira jamais.
      const taken = takenKeys.find((t) => !t.key.startsWith('mention:')) ?? takenKeys[0];
      if (!taken) throw error;
      if (taken.key.startsWith('mention:')) {
        return log('refused', 'R06', 'Un premier message automatique part déjà dans cette conversation.');
      }
      return log('refused', 'R05', taken.key.startsWith('texte:') ? 'Ce message part déjà à la personne.' : 'Ce sujet part déjà à la personne.', {
        needsHuman: order.kind === 'reply',
      });
    }

    // Place dans le plafond du jour, prise une à une : deux envois simultanés ne la partagent pas [R11].
    const cap =
      order.kind === 'review_request'
        ? this.decisions.settings.reviewRequestsPerDay
        : order.kind === 'partner'
          ? this.decisions.settings.partnerMessagesPerWorkingDay
          : 0;
    if (cap > 0) {
      const day = localTime(at, this.decisions.settings.timeZone).date;
      // Les places font foi : celles d'un envoi en panne ont été rendues.
      let placed = false;
      for (let slot = 1; slot <= cap && !placed; slot++) {
        const { changes } = await this.db.run(
          `INSERT OR IGNORE INTO send_quota_slots (network_id, kind, day, slot, reservation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [order.networkId, order.kind, day, String(slot), reservationId, at.toISOString()],
        );
        placed = changes === 1;
      }
      if (!placed) {
        await release('plafond');
        return log('refused', 'R11', `Plafond du jour atteint : ${cap} au plus.`);
      }
    }

    // Le palier, avant de ranger : ce qui reste dans la boîte d'essai ne compte pas pour les plafonds [R11].
    let real: OutboundChannel | null = null;
    let confirm: (() => Promise<void>) | null = null;
    if (staging) {
      try {
        ({ real, confirm } = await staging.route(order.networkId, order.channel, order.rolloutRef ?? null));
      } catch {
        await release('panne');
        return log('failed', null, 'Le palier du canal n’a pas pu être lu.', { needsHuman: order.kind === 'reply' });
      }
    }

    // 6. Enregistrement, journal, puis envoi [R13].
    const message = await this.decisions.recordSent(
      {
        networkId: order.networkId,
        agentId,
        personId: order.personId,
        projectId: order.projectId ?? null,
        conversationId: threadId,
        channel: order.channel,
        authorKind: order.byAgent ? 'agent' : chosen.ai ? 'ai' : 'system',
        body: stored,
        occurredAt: at,
      },
      order.kind,
      { countsForCaps: !staging || real !== null },
    );
    for (const subject of subjects) {
      await this.db.run('INSERT INTO message_subjects (message_id, network_id, person_id, subject, created_at) VALUES (?, ?, ?, ?, ?)', [
        message.id,
        order.networkId,
        order.personId,
        subject,
        this.now().toISOString(),
      ]);
    }
    await this.db.run('UPDATE send_reservations SET message_id = ? WHERE reservation_id = ?', [message.id, reservationId]);
    const flags = { messageId: message.id, body: stored, aiText: chosen.ai, fallbackText: !chosen.ai, withMention, ...(asWritten ? { mentionMissing } : {}) };
    const sent = await log('sent', aiNote ? 'R12' : decision.rule, aiNote ?? decision.reason, flags);
    let receipt: { externalId: string | null };
    try {
      receipt = await (real ?? port).deliver({ channel: order.channel, to, body, messageId: message.id, ...(thread ? { thread: thread.kind } : {}), ...(order.attachments && order.channel === 'email' ? { attachments: order.attachments } : {}) });
    } catch {
      // Le détail de l'erreur peut contenir l'adresse : il ne va pas au journal.
      // Les réservations sont libérées pour un nouvel essai, sans effacer leur ligne.
      await release('panne');
      if (real && staging) {
        try {
          await staging.failed(order.networkId, order.channel);
        } catch (error) {
          // La base elle-même : le prochain échec ramènera le canal en essai. Trace sans donnée [R13].
          console.error('aimmo : retour en essai non écrit', error instanceof Error ? error.name : 'unknown');
        }
      }
      // Avec un palier, une réponse tombée n'est jamais un silence : l'agent est prévenu [R12].
      return log('failed', null, 'Le canal a refusé le message ou n’a pas répondu.', { ...flags, needsHuman: staging !== null && order.kind === 'reply' });
    }
    if (staging && !real) {
      // Resté dans la boîte d'essai : ni sujet, ni texte, ni mention, ni plafond ne restent pris [R05, R06, R11].
      await release('essai');
    }
    if (confirm) await confirm();
    if (staging) sent.trial = !real;
    // L'identifiant du canal : l'écho de ce message ne sera jamais pris pour la réponse d'un humain [R21].
    if (receipt.externalId) {
      await this.db.run(
        'INSERT INTO outbound_refs (network_id, channel, external_id, message_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [order.networkId, order.channel, receipt.externalId, message.id, this.now().toISOString()],
      );
    }
    return sent;
  }

  /**
   * Un envoi à un professionnel (U12) : un partenaire de l'annuaire ou un futur partenaire, jamais une fiche client.
   * Même chemin, mêmes règles, redécidées maintenant : opposition [R04, R02], heures [R01], jour ouvré et plafond
   * [R11, R79], accord [R03], une seule fois [R05], texte sans l'IA [R06]. Seule la boîte d'essai reçoit l'envoi.
   * Chaque décision va au journal des envois aux professionnels, sans adresse ni texte [R13] ; une attente n'y est
   * écrite qu'une fois tant que sa raison ne change pas.
   */
  async sendToProfessional(order: ProSendOrder): Promise<ProSendResult> {
    const at = this.now();
    const settings = this.decisions.settings;
    const log = async (status: ProSendStatus, rule: string | null, reason: string, sendId: string | null = null): Promise<ProSendResult> => {
      const last = await this.db.first<{ outcome: string; rule: string | null; reason: string }>(
        'SELECT outcome, rule, reason FROM pro_send_log WHERE network_id = ? AND subject = ? ORDER BY id DESC LIMIT 1',
        [order.networkId, order.subject],
      );
      if (!(status === 'waiting' && last && last.outcome === 'waiting' && last.rule === rule && last.reason === reason)) {
        await this.db.run('INSERT INTO pro_send_log (network_id, subject, kind, outcome, rule, reason, mode, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
          order.networkId,
          order.subject,
          order.kind,
          status,
          rule,
          reason,
          'essai',
          at.toISOString(),
        ]);
      }
      return { status, rule, reason, sendId };
    };
    if (!order.subject) throw new Error('Un envoi à un professionnel cite son sujet [R05].');
    const mailbox = this.options.proMailbox;
    // Mode essai : aucun vrai canal n'est admis pour les professionnels.
    if (!(mailbox instanceof ProTrialMailbox)) return log('refused', null, 'Aucun envoi réel aux professionnels tant que le plan ne l’a pas mis en service.');

    // L'adresse et l'accord, lus ici : l'appelant ne les donne jamais.
    let email: string | null = null;
    let recipient: string;
    const consents: { purpose: string; channel: 'email'; given_at: string; withdrawn_at: null }[] = [];
    if ('partnerId' in order.recipient) {
      if (order.kind !== 'partner') throw new Error('Un partenaire de l’annuaire reçoit un message de partenaire.');
      recipient = `partner:${order.recipient.partnerId}`;
      const address = await this.db.first<{ email: string; recorded_at: string }>(
        'SELECT email, recorded_at FROM partner_addresses WHERE network_id = ? AND partner_id = ? AND recorded_at <= ? ORDER BY version DESC LIMIT 1',
        [order.networkId, order.recipient.partnerId, at.toISOString()],
      );
      if (address) {
        email = address.email;
        // L'accord rangé avec l'adresse, avec sa date et sa preuve [R03].
        consents.push({ purpose: PARTNER_FOLLOW_UP_PURPOSE, channel: 'email', given_at: address.recorded_at, withdrawn_at: null });
      }
    } else {
      if (order.kind !== 'prospecting') throw new Error('Un futur partenaire ne reçoit qu’un mail de prospection.');
      recipient = `prospect:${order.recipient.prospectId}`;
      email = (await this.db.first<{ email: string }>('SELECT email FROM partner_prospects WHERE network_id = ? AND id = ?', [order.networkId, order.recipient.prospectId]))?.email ?? null;
      // Aucun accord n'est fabriqué pour la prospection : sans l'exception écrite dans R03 (H32), R03 refuse.
    }
    if (!email) return log('waiting', null, 'Aucune adresse professionnelle rangée pour ce destinataire.');

    const local = localTime(at, settings.timeZone);
    const used = async (): Promise<number> =>
      Number(
        (
          await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM send_quota_slots WHERE network_id = ? AND kind = ? AND day = ? AND slot NOT LIKE '%#%'", [
            order.networkId,
            order.kind,
            local.date,
          ])
        )?.n ?? 0,
      );
    const decide = async (when: Date) => {
      // Une opposition, par le lien ou rangée par la direction, arrête tout pour cette adresse [R04, R02].
      // Pour un partenaire, l'opposition d'une seule de ses adresses rangées, d'hier ou d'aujourd'hui, vaut pour lui.
      const optOut =
        'partnerId' in order.recipient
          ? await this.db.first<{ at: string }>(
              `SELECT MIN(at) AS at FROM (
                 SELECT at FROM partner_optouts WHERE network_id = ? AND partner_id = ?
                 UNION ALL
                 SELECT o.at FROM partner_prospect_optouts o
                 WHERE o.network_id = ? AND (o.email = ? OR o.email IN (SELECT a.email FROM partner_addresses a WHERE a.network_id = ? AND a.partner_id = ?))
               ) HAVING COUNT(*) > 0`,
              [order.networkId, order.recipient.partnerId, order.networkId, email, order.networkId, order.recipient.partnerId],
            )
          : await this.db.first<{ at: string }>('SELECT at FROM partner_prospect_optouts WHERE network_id = ? AND email = ?', [order.networkId, email]);
      return decideSend(
        { channel: 'email', kind: order.kind, purpose: order.kind === 'partner' ? PARTNER_FOLLOW_UP_PURPOSE : PRO_PROSPECTING_PURPOSE, at: when },
        {
          exclusions: optOut ? [{ reason: 'stop', channel: null, noted_at: optOut.at, lifted_at: null }] : [],
          consents,
          messages: [],
          relations: [],
          sentToday: { review_request: 0, partner: order.kind === 'partner' ? await used() : 0 },
        },
        settings,
      );
    };
    const WAIT = new Set(['R01', 'R11']);
    const decision = await decide(at);
    if (!decision.allowed) return log(WAIT.has(decision.rule ?? '') ? 'waiting' : 'refused', decision.rule, decision.reason);
    if (order.kind === 'prospecting') {
      if (!isWorkingDay(local)) return log('waiting', 'R79', 'Prospection seulement les jours ouvrés.');
      if ((await used()) >= PRO_PROSPECTING_PER_WORKING_DAY) return log('waiting', 'R79', `Déjà ${PRO_PROSPECTING_PER_WORKING_DAY} mails de prospection aujourd’hui.`);
      if (!order.text.includes(PRO_OPT_OUT_PATH)) return log('refused', 'R79', 'Un mail de prospection porte son lien d’opposition.');
    }

    // Le texte, contrôlé comme un texte à une personne : aucune mention de l'IA [R06], chiffres permis [R10]. R08
    // (vouvoiement avec le prénom) ne s'applique pas : un professionnel n'a pas de prénom rangé.
    const problems = checkText(order.text, { audience: 'client', channel: 'email', figures: order.figures ?? [] }, this.settings.text).filter((p) => p.rule !== 'R08');
    const problem = problems[0];
    if (problem) return log('refused', problem.rule, `Texte refusé : ${problem.reason}`);
    if (order.text.length > this.settings.text.maxLength.email) return log('refused', 'length', `Texte trop long : ${this.settings.text.maxLength.email} caractères au plus.`);

    // Une opposition arrivée entre la préparation et maintenant l'emporte ; puis la condition propre à l'envoi [R04].
    const last = await decide(this.now());
    if (!last.allowed) return log(WAIT.has(last.rule ?? '') ? 'waiting' : 'refused', last.rule, last.reason);
    if (order.stillAllowed) {
      const still = await order.stillAllowed();
      if (!still.allowed) return log('refused', still.rule, still.reason);
    }

    // Une seule fois par sujet, réservé dans la base : de deux passages simultanés, un seul envoie [R05].
    const sendId = crypto.randomUUID();
    try {
      await this.db.run('INSERT INTO pro_sends (id, network_id, subject, kind, recipient, day, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        sendId,
        order.networkId,
        order.subject,
        order.kind,
        recipient,
        local.date,
        at.toISOString(),
      ]);
    } catch (error) {
      if (!/UNIQUE/i.test(String(error))) throw error;
      return log('refused', 'R05', 'Ce sujet est déjà parti à ce destinataire.');
    }
    const release = async (reason: string): Promise<void> => {
      await this.db.run(`UPDATE pro_sends SET subject = subject || '#panne:' || id WHERE id = ?`, [sendId]);
      await this.db.run(`UPDATE send_quota_slots SET slot = slot || '#${reason}:' || reservation_id WHERE reservation_id = ?`, [sendId]);
    };
    // Place dans le plafond du jour, prise une à une [R11, R79].
    const cap = order.kind === 'partner' ? settings.partnerMessagesPerWorkingDay : PRO_PROSPECTING_PER_WORKING_DAY;
    let placed = false;
    for (let slot = 1; slot <= cap && !placed; slot++) {
      const { changes } = await this.db.run('INSERT OR IGNORE INTO send_quota_slots (network_id, kind, day, slot, reservation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        order.networkId,
        order.kind,
        local.date,
        String(slot),
        sendId,
        at.toISOString(),
      ]);
      placed = changes === 1;
    }
    if (!placed) {
      await release('plafond');
      return log('waiting', order.kind === 'partner' ? 'R11' : 'R79', `Plafond du jour atteint : ${cap} au plus.`);
    }
    try {
      await mailbox.deliver({ channel: 'email', to: email, body: order.text, messageId: sendId });
    } catch {
      // Le détail peut contenir l'adresse : il ne va pas au journal.
      await release('panne');
      return log('failed', null, 'La boîte d’essai n’a pas rangé l’envoi.');
    }
    return log('sent', null, 'Rangé dans la boîte d’essai : rien n’est parti réellement.', sendId);
  }

  /**
   * Une notification au téléphone d'un agent (SV15) : le seul chemin vers le service de notification [R26, R225].
   * L'agent doit être en activité dans ce réseau [R86] ; l'envoi est réservé par son identifiant avant l'appel, et ne
   * part jamais deux fois, même rejoué ou demandé par deux passages en même temps [R05] ; le lien ne mène qu'au détail
   * de cet envoi [R415]. Chaque décision va au journal des notifications, sans texte ni donnée [R13]. En mode essai,
   * seule la boîte d'essai reçoit l'envoi : rien ne part vers un téléphone.
   */
  async sendToAgent(order: AgentPushOrder): Promise<AgentPushOutcome> {
    const at = this.now();
    const pushId = order.payload.pushId;
    const log = async (outcome: AgentPushOutcome | 'refuse', rule: string | null, reason: string): Promise<void> => {
      await this.db.run('INSERT INTO agent_push_log (network_id, agent_id, push_id, outcome, rule, reason, mode, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        order.networkId,
        order.agentId,
        pushId,
        outcome,
        rule,
        reason,
        'essai',
        this.now().toISOString(),
      ]);
    };
    if (typeof pushId !== 'string' || pushId === '') throw new Error('Une notification porte son identifiant [R05].');
    const box = this.options.agentPush;
    // Mode essai : aucun vrai service n'est admis tant que le plan ne l'a pas mis en service (H57).
    // La boîte d'essai elle-même, jamais une classe qui en hériterait : une sous-classe pourrait envoyer vraiment.
    // Refusé, l'envoi n'est pas dit fini : ses notifications restent à envoyer et à lire dans l'application [R18].
    if (box === undefined || Object.getPrototypeOf(box) !== AgentPushTrialBox.prototype) {
      await log('refuse', 'R26', 'Aucune boîte d’essai des notifications : rien ne part vers un téléphone.');
      return 'echec';
    }
    if (order.payload.url !== agentPushUrl(pushId)) {
      await log('refuse', 'R415', 'Le lien d’une notification ne mène qu’au détail de son envoi.');
      return 'echec';
    }
    if (await agentGone(this.db, order.networkId, order.agentId, at)) {
      await log('refuse', 'R86', 'L’agent n’est plus en activité dans ce réseau.');
      return 'aucun_appareil';
    }
    // Réservé dans la base avant l'appel : de deux demandes du même envoi, une seule part [R05].
    const reserved = await this.db.run(
      'INSERT INTO agent_push_sends (push_id, network_id, agent_id, mode, outcome, reserved_at, done_at) VALUES (?, ?, ?, ?, NULL, ?, NULL) ON CONFLICT (push_id) DO NOTHING',
      [pushId, order.networkId, order.agentId, 'essai', at.toISOString()],
    );
    if (reserved.changes !== 1) {
      const first = await this.db.first<{ outcome: AgentPushOutcome | null; network_id: string; agent_id: string }>(
        'SELECT outcome, network_id, agent_id FROM agent_push_sends WHERE push_id = ?',
        [pushId],
      );
      await log('refuse', 'R05', 'Cet envoi est déjà parti ou en cours : il ne repart pas.');
      // La réponse du premier envoi, s'il est le même et qu'elle est connue ; sinon rien n'est dit parti.
      const same = first !== null && first.network_id === order.networkId && first.agent_id === order.agentId;
      return same && first.outcome !== null && first.outcome !== 'echec' ? first.outcome : 'echec';
    }
    const service: AgentPushService = box;
    let outcome: AgentPushOutcome;
    try {
      outcome = await service.pushToDevices(order);
    } catch {
      outcome = 'echec';
    }
    if (outcome !== 'ok' && outcome !== 'aucun_appareil') outcome = 'echec';
    await this.db.run('UPDATE agent_push_sends SET outcome = ?, done_at = ? WHERE push_id = ? AND outcome IS NULL', [outcome, this.now().toISOString(), pushId]);
    await log(outcome, null, outcome === 'ok' ? 'Rangé dans la boîte d’essai : rien n’est parti vers un téléphone.' : outcome === 'aucun_appareil' ? 'Aucun téléphone relié.' : 'La boîte d’essai n’a pas rangé l’envoi.');
    return outcome;
  }

  /** La session de l'assistant du site où répondre, si un message de la personne y est rangé. */
  private async siteSession(
    channel: OutboundChannelName,
    conversationId: string | null,
    networkId: string,
    personIds: readonly string[],
  ): Promise<string | null> {
    if (channel !== 'site' || conversationId === null || personIds.length === 0) return null;
    const prefix = 'site:';
    if (!conversationId.startsWith(prefix) || conversationId.length === prefix.length) return null;
    const ref = conversationId.slice(prefix.length);
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM inbound_messages
       WHERE network_id = ? AND channel = 'site' AND kind = 'site_chat' AND conversation_ref = ?
         AND person_id IN (${placeholders(personIds.length)})`,
      [networkId, ref, ...personIds],
    );
    return Number(row?.n ?? 0) > 0 ? ref : null;
  }

  /** La conversation Instagram ou Facebook où répondre, si elle est bien celle de la personne. */
  private async metaThread(
    channel: OutboundChannelName,
    conversationId: string | null,
    networkId: string,
    personIds: readonly string[],
  ): Promise<{ ref: string; kind: 'direct' | 'comment' } | null> {
    if ((channel !== 'instagram' && channel !== 'facebook') || conversationId === null || personIds.length === 0) return null;
    const prefix = `${channel}:`;
    if (!conversationId.startsWith(prefix) || conversationId.length === prefix.length) return null;
    const ref = conversationId.slice(prefix.length);
    const row = await this.db.first<{ kind: 'direct' | 'comment' }>(
      `SELECT kind FROM inbound_messages
       WHERE network_id = ? AND channel = ? AND conversation_ref = ? AND kind IN ('direct', 'comment')
         AND person_id IN (${placeholders(personIds.length)})
       ORDER BY received_at DESC LIMIT 1`,
      [networkId, channel, ref, ...personIds],
    );
    return row ? { ref, kind: row.kind } : null;
  }
}
