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
import type { IdentifierKind, Message, OutboundChannelName } from '../db/types.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import type { OutboundChannel } from './canaux.ts';
import type { SendKind } from './decision.ts';
import type { DecisionEnvoi } from './service.ts';
import { localTime } from './horaires.ts';
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
  channel: OutboundChannelName;
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
  /** Noms des vendeurs du bien cité, interdits dans le texte [R19]. */
  sellerNames?: readonly string[];
  /** Nombre de questions permis dans le texte. */
  maxQuestions?: number;
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
    // L'heure est toujours celle du contrôle, jamais celle de l'appelant : l'envoi part maintenant [R01].
    const at = this.now();
    const subjects = [...(order.subject ? [order.subject] : []), ...(order.propertyIds ?? []).map((id) => `bien:${id}`)];
    if (order.kind !== 'reply' && subjects.length === 0) {
      throw new Error('Un envoi d’initiative cite son sujet ou ses biens [R05].');
    }
    const agentId = order.agentId ?? null;
    const log = async (
      outcome: SendStatus,
      rule: string | null,
      reason: string,
      extra: Partial<Pick<SendResult, 'messageId' | 'body' | 'aiText' | 'fallbackText' | 'withMention' | 'needsHuman'>> = {},
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

    const view = await this.fiche.view(order.personId);
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
    const decide = (when: Date) =>
      this.decisions.decide(
        order.personId,
        {
          channel: order.channel,
          kind: order.kind,
          ...(order.purpose === undefined ? {} : { purpose: order.purpose }),
          conversationId: order.conversationId ?? null,
          at: when,
        },
        failed,
      );

    // 1. Décision d'envoi [R01 à R04, R11].
    const decision = await decide(at);
    if (!decision.allowed) return log('refused', decision.rule, decision.reason);

    const port = this.channels.get(order.channel);
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
    const inConversation = (m: Message): boolean =>
      order.conversationId ? m.conversation_id === order.conversationId : m.conversation_id === null && m.channel === order.channel;
    const conversation = sentBefore.filter(inConversation);
    const firstOfConversation = conversation.length === 0;
    const withMention = !conversation.some((m) => AUTOMATIC.has(m.author_kind));

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

    // 5. Mention de l'assistant [R06].
    const body = withMentionText(chosen.text);

    // La rédaction a pu durer : un arrêt ou une exclusion arrivés entre-temps l'emportent [R02, R04].
    const last = await decide(this.now());
    if (!last.allowed) return log('refused', last.rule, last.reason);

    // Réservation atomique des sujets, du texte et de la mention : de deux envois simultanés, un seul passe [R05, R06].
    const reservationId = crypto.randomUUID();
    const conversationKey = order.conversationId ? `conversation:${order.conversationId}` : `canal:${order.channel}`;
    const keys = [
      ...new Set([
        ...subjects.map((k) => `sujet:${k}`),
        `texte:${sameText(chosen.text)}`,
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
    await this.db.run('UPDATE send_reservations SET message_id = ? WHERE reservation_id = ?', [message.id, reservationId]);
    const flags = { messageId: message.id, body, aiText: chosen.ai, fallbackText: !chosen.ai, withMention };
    const sent = await log('sent', aiNote ? 'R12' : decision.rule, aiNote ?? decision.reason, flags);
    let receipt: { externalId: string | null };
    try {
      receipt = await port.deliver({ channel: order.channel, to, body, messageId: message.id, ...(thread ? { thread: thread.kind } : {}) });
    } catch {
      // Le détail de l'erreur peut contenir l'adresse : il ne va pas au journal.
      // Les réservations sont libérées pour un nouvel essai, sans effacer leur ligne.
      await release('panne');
      return log('failed', null, 'Le canal a refusé le message ou n’a pas répondu.', flags);
    }
    // L'identifiant du canal : l'écho de ce message ne sera jamais pris pour la réponse d'un humain [R21].
    if (receipt.externalId) {
      await this.db.run(
        'INSERT INTO outbound_refs (network_id, channel, external_id, message_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [order.networkId, order.channel, receipt.externalId, message.id, this.now().toISOString()],
      );
    }
    return sent;
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
