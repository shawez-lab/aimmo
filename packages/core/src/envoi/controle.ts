/**
 * Le contrôle central des envois : le seul chemin de sortie de tout message. Aucun autre code n'appelle un canal.
 *
 * Dans l'ordre, d'après le cahier (Architecture technique, « Le contrôle central des envois ») :
 *   1. décision d'envoi de S05 : arrêt, exclusions, horaires, plafonds, accord [R01 à R04, R11] ;
 *   2. anti-doublon par sujet : un bien, une relance ou une alerte, une seule fois par personne [R05] ;
 *   3. texte : celui de l'IA si son budget le permet et qu'elle répond à temps, sinon un texte de secours [R12] ;
 *   4. contrôle du texte [R06 à R10, longueur] et anti-doublon du texte [R05] ; un texte refusé passe au secours ;
 *   5. mention de l'assistant au premier message automatique de la conversation [R06] ;
 *   6. enregistrement du message et du journal, puis envoi [R13].
 * Chaque refus est écrit au journal avec sa règle. Une panne du canal aussi : aucune erreur n'est avalée.
 */
import type { Channel, IdentifierKind, Message } from '../db/types.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import type { OutboundChannel } from './canaux.ts';
import type { SendKind } from './decision.ts';
import type { DecisionEnvoi } from './service.ts';
import type { SendJournal } from './journal-envois.ts';
import { DEFAULT_TEXT_SETTINGS, checkText, plain, type TextSettings } from './texte.ts';

/** Plafond du coût de l'IA [R12]. */
export interface AiBudget {
  allows(networkId: string, at: Date): Promise<boolean>;
}

export interface SendOrder {
  networkId: string;
  agentId?: string | null;
  personId: string;
  projectId?: string | null;
  conversationId?: string | null;
  channel: Channel;
  kind: SendKind;
  /** Finalité de l'accord [R03] ; par défaut, le type. */
  purpose?: string;
  /** Sujet d'un envoi d'initiative, par exemple `relance:projet-12` [R05]. Obligatoire hors réponse, sauf biens. */
  subject?: string | undefined;
  /** Biens proposés : chacun ne part qu'une fois à la personne [R05]. */
  propertyIds?: readonly string[];
  /** Rédaction par l'IA. Absente : texte de secours. */
  compose?: () => Promise<string>;
  /** Textes de secours écrits sans IA, essayés dans l'ordre [R12]. */
  fallbackTexts: readonly string[];
  /** Chiffres permis dans le texte : ceux de la base ou d'une source publique citée [R10]. */
  figures?: readonly (string | number)[];
  /** Par défaut, maintenant. */
  at?: Date;
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
}

const IDENTIFIER_FOR: Record<Channel, readonly IdentifierKind[]> = {
  email: ['email'],
  phone: ['phone'],
  sms: ['phone'],
  whatsapp: ['whatsapp', 'phone'],
  instagram: ['instagram'],
  facebook: ['facebook'],
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
  private readonly channels: ReadonlyMap<Channel, OutboundChannel>;
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

  async send(order: SendOrder): Promise<SendResult> {
    const at = order.at ?? this.now();
    const subjects = [...(order.subject ? [order.subject] : []), ...(order.propertyIds ?? []).map((id) => `bien:${id}`)];
    if (order.kind !== 'reply' && subjects.length === 0) {
      throw new Error('Un envoi d’initiative cite son sujet ou ses biens [R05].');
    }
    const agentId = order.agentId ?? null;
    const log = async (
      outcome: SendStatus,
      rule: string | null,
      reason: string,
      extra: Partial<Pick<SendResult, 'messageId' | 'body' | 'aiText' | 'fallbackText' | 'withMention'>> = {},
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

    // 1. Décision d'envoi [R01 à R04, R11].
    const decision = await this.decisions.decide(order.personId, {
      channel: order.channel,
      kind: order.kind,
      ...(order.purpose === undefined ? {} : { purpose: order.purpose }),
      conversationId: order.conversationId ?? null,
      at,
    });
    if (!decision.allowed) return log('refused', decision.rule, decision.reason);

    const port = this.channels.get(order.channel);
    if (!port) return log('refused', null, 'Canal non branché.');
    const view = await this.fiche.view(order.personId);
    const ids = view.members.map((p) => p.id);
    const to = IDENTIFIER_FOR[order.channel]
      .map((kind) => view.identifiers.find((i) => i.kind === kind))
      .find((i) => i !== undefined)?.value;
    if (!to) return log('refused', null, 'Aucun identifiant de la personne pour ce canal.');

    // Les messages dont l'envoi a échoué ne comptent ni pour l'anti-doublon ni pour la mention.
    const failed = new Set(
      (
        await this.db.all<{ message_id: string }>(
          `SELECT message_id FROM send_log WHERE outcome = 'failed' AND message_id IS NOT NULL AND person_id IN (${placeholders(ids.length)})`,
          ids,
        )
      ).map((r) => r.message_id),
    );
    const sentBefore = view.messages.filter((m) => m.direction === 'out' && !failed.has(m.id) && Date.parse(m.occurred_at) <= at.getTime());

    // 2. Anti-doublon par sujet, sur tous les canaux, toutes fiches fusionnées comprises [R05].
    if (subjects.length > 0) {
      const dup = await this.db.first<{ subject: string }>(
        `SELECT s.subject FROM message_subjects s
         WHERE s.person_id IN (${placeholders(ids.length)}) AND s.subject IN (${placeholders(subjects.length)})
           AND NOT EXISTS (SELECT 1 FROM send_log l WHERE l.message_id = s.message_id AND l.outcome = 'failed')
         LIMIT 1`,
        [...ids, ...subjects],
      );
      if (dup) {
        return log('refused', 'R05', dup.subject.startsWith('bien:') ? 'Ce bien a déjà été envoyé à la personne.' : 'Ce sujet a déjà été envoyé à la personne.');
      }
    }

    // 3. Le texte : IA si possible, sinon secours [R12].
    const inConversation = (m: Message): boolean =>
      order.conversationId ? m.conversation_id === order.conversationId : m.conversation_id === null && m.channel === order.channel;
    const conversation = sentBefore.filter(inConversation);
    const firstOfConversation = conversation.length === 0;
    const withMention = !conversation.some((m) => AUTOMATIC.has(m.author_kind));

    let aiNote: string | null = null;
    const candidates: { text: string; ai: boolean }[] = [];
    if (order.compose) {
      if (this.options.budget && !(await this.options.budget.allows(order.networkId, at))) {
        aiNote = 'Plafond du coût de l’IA atteint : texte de secours.';
      } else {
        try {
          candidates.push({ text: await timeout(order.compose(), this.settings.aiTimeoutMs), ai: true });
        } catch {
          aiNote = 'L’IA n’a pas répondu : texte de secours.';
        }
      }
    }
    candidates.push(...order.fallbackTexts.map((text) => ({ text, ai: false })));
    if (candidates.length === 0) return log('refused', 'R12', 'Aucun texte de secours fourni : rien ne peut partir.');

    // 4. Contrôle du texte et anti-doublon du texte [R05 à R10].
    const already = new Set(sentBefore.map((m) => sameText(this.withoutMention(m.body))));
    const firstName = view.members.map((p) => p.first_name).find((n) => n) ?? null;
    let chosen: { text: string; ai: boolean } | null = null;
    const problems: { rule: string; reason: string; ai: boolean }[] = [];
    for (const candidate of candidates) {
      const found = checkText(
        candidate.text,
        { audience: 'client', channel: order.channel, firstOfConversation, firstName, figures: order.figures ?? [] },
        this.settings.text,
      );
      const issues: { rule: string; reason: string }[] = found;
      if (issues.length === 0 && already.has(sameText(candidate.text))) {
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
      return log('refused', worst?.rule ?? 'R12', `Aucun texte ne passe le contrôle : ${worst?.reason ?? 'aucun texte.'}`);
    }
    const aiRefused = problems.find((p) => p.ai);
    if (!chosen.ai && aiRefused) aiNote = `Texte de l’IA refusé, ${aiRefused.rule} : texte de secours.`;

    // 5. Mention de l'assistant [R06].
    let body = chosen.text.trim();
    if (withMention) {
      let mention = this.settings.mentionWithoutAgent;
      if (order.channel === 'instagram') mention = this.settings.mentionInstagram;
      else if (agentId) {
        const agent = await this.db.first<{ first_name: string }>('SELECT first_name FROM agents WHERE id = ? AND network_id = ?', [agentId, order.networkId]);
        if (agent?.first_name) mention = this.settings.mentionWithAgent.replace('{prenom}', agent.first_name);
      }
      body = `${mention}\n\n${body}`;
    }

    // 6. Enregistrement, journal, puis envoi [R13].
    const message = await this.decisions.recordSent(
      {
        networkId: order.networkId,
        agentId,
        personId: order.personId,
        projectId: order.projectId ?? null,
        conversationId: order.conversationId ?? null,
        channel: order.channel,
        authorKind: chosen.ai ? 'ai' : 'system',
        body,
        occurredAt: at,
      },
      order.kind,
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
    const flags = { messageId: message.id, body, aiText: chosen.ai, fallbackText: !chosen.ai, withMention };
    const sent = await log('sent', aiNote ? 'R12' : decision.rule, aiNote ?? decision.reason, flags);
    try {
      await port.deliver({ channel: order.channel, to, body, messageId: message.id });
    } catch {
      // Le détail de l'erreur peut contenir l'adresse : il ne va pas au journal.
      return log('failed', null, 'Le canal a refusé le message ou n’a pas répondu.', flags);
    }
    return sent;
  }
}
