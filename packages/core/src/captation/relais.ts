/**
 * Conversation et relais à l'agent (C05). L'assistant converse jusqu'au rendez-vous ou au plus 5 échanges, puis
 * passe la main ; il se tait pour de bon dès qu'un humain répond [R21]. Sur Instagram, Facebook et WhatsApp, rien
 * ne part hors de la fenêtre de 24 heures [R22]. Ces deux règles sont tenues par la décision d'envoi (S05), donc
 * par le contrôle central (S06), pour tout message automatique ; ce module tient l'état de la conversation,
 * prévient l'agent et lui montre la conversation sous ses droits [R16].
 */
import { keyLookupForms } from '../fiche/empreinte.ts';
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Message } from '../db/types.ts';
import { DEFAULT_SEND_SETTINGS, type SendSettings } from '../envoi/decision.ts';
import { maskIban, plain } from '../envoi/texte.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import type { InboundRow, Reception } from '../reception/reception.ts';
import type { FirstReplyOutcome, PremiereReponse, SkipCode } from './premiere-reponse.ts';

/** Un écho au texte identique à notre envoi, arrivé dans ce délai, est le nôtre. */
const OWN_ECHO_WINDOW_MS = 10 * 60_000;
const sameText = (text: string): string => plain(text).replace(/[^a-z0-9]+/g, ' ').trim();
/** Une réponse humaine réservée mais pas rangée depuis ce délai : son Worker s'est coupé, elle peut être reprise. */
const STALE_HUMAN_REPLY_MS = 2 * 60_000;

export type HandoverReason = 'human_reply' | 'exchanges' | 'appointment' | 'agent_takeover';
export type AlertReason = 'exchanges' | 'needs_reply';

/** La conversation d'un message reçu : la même clé que celle du rattachement (C02) et de la réponse (C04). */
export function conversationIdOf(row: Pick<InboundRow, 'channel' | 'conversation_ref' | 'kind' | 'external_id'>): string {
  return `${row.channel}:${row.conversation_ref ?? `${row.kind}:${row.external_id}`}`;
}

export interface HandoverRow {
  id: string;
  network_id: string;
  agent_id: string | null;
  person_id: string;
  conversation_id: string;
  reason: HandoverReason;
  handed_at: string;
  created_at: string;
}

export interface AgentAlertRow {
  id: string;
  network_id: string;
  agent_id: string | null;
  person_id: string;
  conversation_id: string;
  reason: AlertReason;
  created_at: string;
  seen_at: string | null;
}

export interface ConversationState {
  conversationId: string;
  /** `assistant` : l'assistant peut encore répondre ; `agent` : il se tait pour de bon [R21]. */
  holder: 'assistant' | 'agent';
  handover: HandoverRow | null;
  /** Messages reçus du client dans la conversation. */
  received: number;
  humanReplied: boolean;
}

export type RelayOutcome =
  | { status: 'replied' | 'not_sent'; conversationId: string; reply: FirstReplyOutcome }
  | { status: 'skipped'; conversationId: string | null; reason: string; code?: SkipCode }
  | { status: 'handed_over' | 'silent'; conversationId: string; reason: string };

/** Une réponse écrite par un humain dans l'application du canal, reçue en écho. */
export interface HumanReply {
  channel: 'instagram' | 'facebook' | 'whatsapp';
  /** Identifiant du client chez le canal : la clé de sa conversation privée. */
  conversationRef: string;
  externalId: string;
  text: string;
  sentAt: Date;
}

export interface RelaisOptions {
  settings?: SendSettings;
  now?: () => Date;
  newId?: () => string;
}

export class ConversationRelais {
  private readonly settings: SendSettings;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    private readonly fiche: FicheUnique,
    private readonly reception: Reception,
    private readonly premiere: PremiereReponse,
    private readonly acces: Acces,
    options: RelaisOptions = {},
  ) {
    this.settings = options.settings ?? DEFAULT_SEND_SETTINGS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    // Le dernier contrôle de chaque réponse relit les échos gardés de sa conversation [R21].
    this.premiere.checkBeforeSend((networkId, conversationId) => this.echoesAllowReply(networkId, conversationId));
  }

  /**
   * Un message reçu, rattaché à sa fiche (C02) : l'assistant répond s'il a encore la main ; au message du client
   * qui dépasse les échanges permis, la conversation passe à l'agent, qui est prévenu, et l'assistant se tait [R21].
   */
  async process(inboundId: string): Promise<RelayOutcome> {
    const row = await this.reception.get(inboundId);
    if (!row || row.kind === 'unreadable' || row.person_id === null) {
      return { status: 'skipped', conversationId: null, reason: 'Message non rattaché à une fiche.' };
    }
    const conversationId = conversationIdOf(row);
    const state = await this.state(row.person_id, conversationId);
    if (state.holder === 'agent') {
      // Le client réécrit et personne ne lui a encore répondu : une alerte déjà vue redevient à reprendre [R12].
      if (!state.humanReplied) await this.reopenAlerts(row.network_id, conversationId, row.received_at);
      return { status: 'silent', conversationId, reason: 'Conversation passée à l’agent : l’assistant se tait.' };
    }
    if (state.received > this.settings.assistantMaxExchanges) {
      const view = await this.fiche.view(row.person_id);
      await this.handOver(view.person.id, conversationId, 'exchanges');
      await this.alert(row.person_id, conversationId, 'exchanges', row.received_at);
      return {
        status: 'handed_over',
        conversationId,
        reason: `Plus de ${this.settings.assistantMaxExchanges} échanges : l’agent est prévenu et prend le relais.`,
      };
    }
    const reply = await this.premiere.reply(inboundId);
    if (reply.skipped !== null) {
      // Un formulaire sans mail : personne ne peut lui répondre par écrit, l'agent doit rappeler [R12].
      if (row.kind === 'form' && reply.skipCode === 'no_channel') {
        await this.alert(row.person_id, conversationId, 'needs_reply', row.received_at);
      }
      return { status: 'skipped', conversationId, reason: reply.skipped, ...(reply.skipCode ? { code: reply.skipCode } : {}) };
    }
    if (reply.result?.status === 'sent') return { status: 'replied', conversationId, reply };
    // Une réponse qui n'a pas pu partir n'est jamais un silence : l'agent est prévenu [R12].
    // La demande d'un portail sans réponse partie (aucune coordonnée lisible, refus) revient toujours à l'agent [R669].
    if (reply.result?.needsHuman || reply.result?.rule === 'R21' || reply.result?.rule === 'R22' || row.kind === 'portal_email') {
      await this.alert(row.person_id, conversationId, 'needs_reply', row.received_at);
    }
    return { status: 'not_sent', conversationId, reply };
  }

  /** Rendez-vous pris : l'agent prend le relais, l'assistant se tait [R21]. */
  appointmentBooked(personId: string, conversationId: string): Promise<HandoverRow> {
    return this.handOver(personId, conversationId, 'appointment');
  }

  /** L'agent reprend la conversation, à tout moment [R21]. */
  async takeOver(viewer: Viewer, personId: string, conversationId: string): Promise<HandoverRow | null> {
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok || read.view !== 'full') return null;
    return this.handOver(read.value.person.id, conversationId, 'agent_takeover');
  }

  /**
   * Une réponse écrite par un humain dans l'application du canal : rangée dans la fiche, une seule fois, et la
   * conversation passe à l'agent pour de bon [R21]. Rien n'est envoyé : le message est déjà parti.
   */
  async noteHumanReply(networkId: string, reply: HumanReply): Promise<'noted' | 'duplicate' | 'unfinished' | 'own' | 'unknown_conversation'> {
    const conversationId = `${reply.channel}:${reply.conversationRef}`;
    // L'écho d'un message parti d'AIMMO n'est pas la réponse d'un humain.
    if (await this.isOwnEcho(networkId, reply)) return 'own';
    const last =
      (await this.db.first<{ person_id: string }>(
        `SELECT person_id FROM messages WHERE network_id = ? AND conversation_id = ? AND direction = 'in'
         ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
        [networkId, conversationId],
      )) ??
      // L'agent a écrit le premier : la personne est retrouvée par son identifiant chez le canal (C02).
      (await this.db.first<{ person_id: string }>('SELECT person_id FROM contact_keys WHERE network_id = ? AND key IN (?, ?) LIMIT 1', [
        networkId,
        ...(await keyLookupForms(networkId, [`${reply.channel}:direct:${reply.conversationRef}`])),
      ]));
    if (!last) return 'unknown_conversation';
    const view = await this.fiche.view(last.person_id);
    // L'écho Meta arrivé avant que le canal ait rendu l'identifiant de notre envoi : reconnu à son texte, mot pour
    // mot, parmi nos messages automatiques des dernières minutes dont l'identifiant n'est pas encore connu. Un
    // message dont l'identifiant est déjà rangé ne peut plus revenir sous un autre : ce texte-là est d'un humain.
    // Jamais sur WhatsApp : ses échos viennent toujours de l'application de l'agent.
    if (reply.channel !== 'whatsapp' && (await this.inFlightSameText(networkId, conversationId, reply))) return 'own';
    const { changes } = await this.db.run(
      'INSERT INTO human_replies (dedup_key, network_id, message_id, created_at) VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING',
      [`${reply.channel}:${reply.externalId}`, networkId, this.now().toISOString()],
    );
    if (changes !== 1) {
      // Une coupure après la réservation ne doit pas laisser l'assistant parler : la conversation passe à l'agent.
      await this.handOver(view.person.id, conversationId, 'human_reply', reply.sentAt);
      return this.resumeHumanReply(networkId, conversationId, view.person.id, view.person.agent_id, reply);
    }
    // L'assistant se tait d'abord : même si le rangement du message échoue ensuite, plus rien d'automatique ne part.
    await this.handOver(view.person.id, conversationId, 'human_reply', reply.sentAt);
    await this.storeHumanReply(networkId, conversationId, view.person.id, view.person.agent_id, reply);
    return 'noted';
  }

  private async storeHumanReply(networkId: string, conversationId: string, personId: string, agentId: string | null, reply: HumanReply): Promise<void> {
    const message = await this.store.recordMessage({
      networkId,
      agentId,
      personId,
      conversationId,
      channel: reply.channel,
      direction: 'out',
      authorKind: 'agent',
      // Comme à la réception, aucun IBAN ni RIB ne se range en clair, même écrit par l'agent [R15].
      body: maskIban(reply.text),
      occurredAt: reply.sentAt,
    });
    await this.linkHumanReply(networkId, reply, message.id);
  }

  private async linkHumanReply(networkId: string, reply: HumanReply, messageId: string): Promise<void> {
    await this.db.run('UPDATE human_replies SET message_id = ? WHERE network_id = ? AND dedup_key = ?', [messageId, networkId, `${reply.channel}:${reply.externalId}`]);
  }

  /**
   * L'écho déjà réservé. Rangé : un simple doublon. Pas encore rangé : un autre Worker y travaille, sauf si la
   * réservation date (coupure) ; alors un seul Worker prend la reprise, par un bail, et le message de l'agent n'est
   * rangé qu'une fois, même si la coupure a eu lieu juste après son rangement.
   */
  private async resumeHumanReply(
    networkId: string,
    conversationId: string,
    personId: string,
    agentId: string | null,
    reply: HumanReply,
  ): Promise<'duplicate' | 'unfinished'> {
    const key = `${reply.channel}:${reply.externalId}`;
    const reserved = await this.db.first<{ message_id: string | null; created_at: string }>(
      'SELECT message_id, created_at FROM human_replies WHERE network_id = ? AND dedup_key = ?',
      [networkId, key],
    );
    if (!reserved || reserved.message_id !== null) return 'duplicate';
    if (this.now().getTime() - Date.parse(reserved.created_at) < STALE_HUMAN_REPLY_MS) return 'unfinished';
    const lease = await this.db.run('UPDATE human_replies SET created_at = ? WHERE network_id = ? AND dedup_key = ? AND created_at = ? AND message_id IS NULL', [
      this.now().toISOString(),
      networkId,
      key,
      reserved.created_at,
    ]);
    if (lease.changes !== 1) return 'unfinished';
    const stored = await this.db.first<{ id: string }>(
      `SELECT id FROM messages WHERE network_id = ? AND conversation_id = ? AND direction = 'out' AND author_kind = 'agent' AND occurred_at = ? AND body = ? LIMIT 1`,
      [networkId, conversationId, reply.sentAt.toISOString(), reply.text],
    );
    if (stored) await this.linkHumanReply(networkId, reply, stored.id);
    else await this.storeHumanReply(networkId, conversationId, personId, agentId, reply);
    return 'duplicate';
  }

  /**
   * Note une réponse humaine reçue en écho ; si sa conversation n'est pas encore connue, elle reste gardée et sera
   * appliquée dès que la conversation existe, avant toute réponse automatique [R21].
   *
   * L'écho d'un humain est écrit AVANT de chercher sa conversation, sans verrou : tant qu'une réponse n'a pas passé
   * son dernier contrôle, elle le verra (`echoesAllowReply`). L'écho de notre propre message, reconnu à son
   * identifiant, n'a rien à faire dans cette table.
   */
  async noteOrKeepHumanReply(networkId: string, reply: HumanReply): Promise<'noted' | 'duplicate' | 'own' | 'pending'> {
    if (await this.isOwnEcho(networkId, reply)) return 'own';
    await this.db.run(
      `INSERT INTO pending_human_replies (network_id, channel, external_id, conversation_ref, body, sent_at, created_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT DO NOTHING`,
      [networkId, reply.channel, reply.externalId, reply.conversationRef, maskIban(reply.text), reply.sentAt.toISOString(), this.now().toISOString()],
    );
    const outcome = await this.noteHumanReply(networkId, reply);
    if (outcome === 'unknown_conversation') {
      // Le premier message du client a pu être rangé pendant ce temps : l'écho est appliqué tout de suite s'il le peut.
      await this.applyPendingHumanReplies(networkId);
      return 'pending';
    }
    // Pas encore rangé : l'écho reste gardé, avec son texte, pour la reprise.
    if (outcome === 'unfinished') return 'duplicate';
    await this.markApplied(networkId, reply.channel, reply.externalId);
    return outcome;
  }

  /**
   * Le dernier contrôle d'une réponse : un écho encore gardé pour cette conversation est appliqué ici. S'il vient d'un
   * humain, même à moitié traité par un autre Worker, rien ne part [R21]. S'il est le nôtre, la réponse continue.
   */
  async echoesAllowReply(networkId: string, conversationId: string): Promise<{ allowed: boolean; rule: string; reason: string }> {
    const rows = await this.db.all<PendingEcho>(
      `SELECT channel, external_id, conversation_ref, body, sent_at FROM pending_human_replies
       WHERE network_id = ? AND applied_at IS NULL AND channel || ':' || conversation_ref = ?`,
      [networkId, conversationId],
    );
    let allowed = true;
    for (const row of rows) {
      const outcome = await this.noteHumanReply(networkId, echoOf(row));
      if (outcome === 'own') {
        await this.markApplied(networkId, row.channel, row.external_id);
        continue;
      }
      allowed = false;
      if (outcome === 'noted' || outcome === 'duplicate') await this.markApplied(networkId, row.channel, row.external_id);
    }
    // Lu après les échos : un écho déjà appliqué par un autre Worker a écrit son passage à l'agent avant sa marque.
    if (allowed) {
      const handed = await this.db.first<{ id: string }>('SELECT id FROM conversation_handovers WHERE network_id = ? AND conversation_id = ?', [networkId, conversationId]);
      allowed = handed === null;
    }
    return { allowed, rule: 'R21', reason: allowed ? '' : 'Un humain a répondu pendant que la réponse se préparait : l’assistant se tait.' };
  }

  /** Applique les réponses humaines en attente dont la conversation est désormais connue. */
  async applyPendingHumanReplies(networkId: string): Promise<number> {
    const rows = await this.db.all<PendingEcho>(
      `SELECT p.channel, p.external_id, p.conversation_ref, p.body, p.sent_at FROM pending_human_replies p
       WHERE p.network_id = ? AND p.applied_at IS NULL
         AND (EXISTS (SELECT 1 FROM messages m WHERE m.network_id = p.network_id AND m.conversation_id = p.channel || ':' || p.conversation_ref)
              OR EXISTS (SELECT 1 FROM contact_keys k WHERE k.network_id = p.network_id AND k.key = p.channel || ':direct:' || p.conversation_ref))`,
      [networkId],
    );
    let applied = 0;
    for (const row of rows) {
      const outcome = await this.noteHumanReply(networkId, echoOf(row));
      if (outcome === 'unknown_conversation' || outcome === 'unfinished') continue;
      if (outcome === 'noted') applied += 1;
      await this.markApplied(networkId, row.channel, row.external_id);
    }
    return applied;
  }

  private async markApplied(networkId: string, channel: HumanReply['channel'], externalId: string): Promise<void> {
    await this.db.run('UPDATE pending_human_replies SET applied_at = COALESCE(applied_at, ?) WHERE network_id = ? AND channel = ? AND external_id = ?', [
      this.now().toISOString(),
      networkId,
      channel,
      externalId,
    ]);
  }

  private async isOwnEcho(networkId: string, reply: HumanReply): Promise<boolean> {
    return (
      (await this.db.first<{ message_id: string }>('SELECT message_id FROM outbound_refs WHERE network_id = ? AND channel = ? AND external_id = ?', [
        networkId,
        reply.channel,
        reply.externalId,
      ])) !== null
    );
  }

  private async inFlightSameText(networkId: string, conversationId: string, reply: HumanReply): Promise<boolean> {
    const echoed = sameText(reply.text);
    if (echoed === '') return false;
    const candidates = await this.db.all<{ body: string }>(
      `SELECT m.body FROM messages m
       WHERE m.network_id = ? AND m.conversation_id = ? AND m.direction = 'out' AND m.author_kind IN ('ai', 'system')
         AND m.occurred_at >= ? AND m.occurred_at <= ?
         AND NOT EXISTS (SELECT 1 FROM outbound_refs r WHERE r.message_id = m.id)
         ${this.premiere.trialNotCounted ? 'AND NOT EXISTS (SELECT 1 FROM trial_outbox t WHERE t.message_id = m.id)' : ''}`,
      [
        networkId,
        conversationId,
        new Date(reply.sentAt.getTime() - OWN_ECHO_WINDOW_MS).toISOString(),
        new Date(reply.sentAt.getTime() + OWN_ECHO_WINDOW_MS).toISOString(),
      ],
    );
    return candidates.some((m) => sameText(m.body) === echoed);
  }

  /** La conversation telle que l'agent la voit, sous ses droits, chaque lecture écrite au journal [R16]. */
  async view(
    viewer: Viewer,
    personId: string,
    conversationId: string,
  ): Promise<{ ok: true; state: ConversationState; messages: Message[] } | { ok: false }> {
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok || read.view !== 'full') return { ok: false };
    const messages = read.value.messages
      .filter((m) => m.conversation_id === conversationId)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    return { ok: true, state: await this.state(read.value.person.id, conversationId), messages };
  }

  /** L'état de la conversation, toutes fiches fusionnées comprises. */
  async state(personId: string, conversationId: string): Promise<ConversationState> {
    const view = await this.fiche.view(personId);
    const ids = view.members.map((p) => p.id);
    const handover = await this.db.first<HandoverRow>(
      `SELECT * FROM conversation_handovers WHERE network_id = ? AND conversation_id = ?`,
      [view.person.network_id, conversationId],
    );
    const at = this.now().getTime();
    const conversation = view.messages.filter((m) => m.conversation_id === conversationId && ids.includes(m.person_id));
    const humanReplied = conversation.some((m) => m.direction === 'out' && m.author_kind === 'agent');
    const handed = handover !== null && Date.parse(handover.handed_at) <= at;
    return {
      conversationId,
      holder: handed || humanReplied ? 'agent' : 'assistant',
      handover,
      received: conversation.filter((m) => m.direction === 'in' && Date.parse(m.occurred_at) <= at).length,
      humanReplied,
    };
  }

  /** Ce que l'agent doit regarder : conversations à reprendre, réponses qui n'ont pas pu partir. */
  alertsFor(networkId: string, agentId: string): Promise<AgentAlertRow[]> {
    return this.db.all<AgentAlertRow>(
      // Une fiche sans agent à l'heure de l'alerte (nouveau contact, attribué ensuite) : l'alerte suit la fiche.
      `SELECT a.* FROM agent_alerts a LEFT JOIN persons p ON p.id = a.person_id
       WHERE a.network_id = ? AND (a.agent_id = ? OR (a.agent_id IS NULL AND p.agent_id = ?)) AND a.seen_at IS NULL
       ORDER BY a.created_at, a.rowid`,
      [networkId, agentId, agentId],
    );
  }

  /** Passe la conversation à l'agent, une seule fois : la première raison l'emporte, rien ne se rouvre. */
  private async handOver(personId: string, conversationId: string, reason: HandoverReason, at: Date = this.now()): Promise<HandoverRow> {
    const view = await this.fiche.view(personId);
    const person = view.person;
    // Jamais dans le futur : l'assistant se tait dès maintenant.
    const handedAt = new Date(Math.min(at.getTime(), this.now().getTime())).toISOString();
    await this.db.run(
      `INSERT INTO conversation_handovers (id, network_id, agent_id, person_id, conversation_id, reason, handed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (network_id, conversation_id) DO NOTHING`,
      [this.newId(), person.network_id, person.agent_id, person.id, conversationId, reason, handedAt, this.now().toISOString()],
    );
    const row = await this.db.first<HandoverRow>('SELECT * FROM conversation_handovers WHERE network_id = ? AND conversation_id = ?', [
      person.network_id,
      conversationId,
    ]);
    if (!row) throw new Error('Relais : conversation passée à l’agent introuvable.');
    return row;
  }

  /**
   * Une seule ligne par conversation et par raison, rangée sur la fiche du message et non sur la fiche gardée : si la
   * fusion est défaite, l'alerte suit la bonne personne [R16]. Une alerte vue avant ce message se rouvre : une nouvelle
   * réponse tombée ne reste pas invisible [R12] ; le même message rejoué ne la rouvre pas. La date où elle avait été vue
   * reste au journal (`alerte_agent.vue`) [R17].
   */
  private async alert(personId: string, conversationId: string, reason: AlertReason, receivedAt: string): Promise<void> {
    const person = (await this.fiche.view(personId)).person;
    await this.db.run(
      `INSERT INTO agent_alerts (id, network_id, agent_id, person_id, conversation_id, reason, created_at, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (network_id, conversation_id, reason) DO UPDATE SET seen_at = NULL, created_at = excluded.created_at, agent_id = excluded.agent_id, person_id = excluded.person_id
       WHERE agent_alerts.seen_at IS NOT NULL AND agent_alerts.seen_at < ?`,
      [this.newId(), person.network_id, person.agent_id, personId, conversationId, reason, this.now().toISOString(), receivedAt],
    );
  }

  /** Rouvre les alertes de la conversation vues avant ce message. */
  private async reopenAlerts(networkId: string, conversationId: string, receivedAt: string): Promise<void> {
    await this.db.run(`UPDATE agent_alerts SET seen_at = NULL, created_at = ? WHERE network_id = ? AND conversation_id = ? AND seen_at IS NOT NULL AND seen_at < ?`, [
      this.now().toISOString(),
      networkId,
      conversationId,
      receivedAt,
    ]);
  }
}

interface PendingEcho {
  channel: HumanReply['channel'];
  external_id: string;
  conversation_ref: string;
  body: string;
  sent_at: string;
}

const echoOf = (row: PendingEcho): HumanReply => ({
  channel: row.channel,
  conversationRef: row.conversation_ref,
  externalId: row.external_id,
  text: row.body,
  sentAt: new Date(row.sent_at),
});

/**
 * Les réponses écrites par un humain dans une notification de Meta : les échos de nos propres messages qui ne
 * viennent pas de l'application AIMMO. Lecture prudente : un écho sans application connue est réputé humain,
 * car laisser parler l'assistant à tort coûte plus que le faire taire à tort [R21].
 */
export function humanRepliesFromMeta(
  channel: 'instagram' | 'facebook',
  raw: unknown,
  ownAppIds: readonly string[],
): HumanReply[] {
  const own = new Set(ownAppIds.map(String));
  const out: HumanReply[] = [];
  const entries = isObj(raw) && Array.isArray(raw['entry']) ? raw['entry'] : [];
  for (const entry of entries) {
    if (!isObj(entry)) continue;
    for (const key of ['messaging', 'standby']) {
      const items = entry[key];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!isObj(item) || !isObj(item['message']) || !isObj(item['recipient'])) continue;
        const message = item['message'];
        if (message['is_echo'] !== true) continue;
        const appId = message['app_id'];
        if (appId !== undefined && appId !== null && own.has(String(appId))) continue;
        const recipient = item['recipient']['id'];
        const mid = message['mid'];
        const timestamp = item['timestamp'];
        if (typeof recipient !== 'string' && typeof recipient !== 'number') continue;
        if (typeof mid !== 'string' || mid === '') continue;
        const sentAt = typeof timestamp === 'number' ? new Date(timestamp) : new Date(NaN);
        out.push({
          channel,
          conversationRef: String(recipient),
          externalId: mid,
          text: typeof message['text'] === 'string' ? message['text'] : '',
          // Une date illisible : l'écho compte dès maintenant, l'assistant se tait quand même.
          sentAt: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
        });
      }
    }
  }
  return out;
}

/**
 * Les réponses écrites par un humain depuis l'application WhatsApp Business, reçues en écho
 * (`smb_message_echoes`). Tout écho de ce type vient de l'application, jamais de l'API d'AIMMO [R21].
 */
export function humanRepliesFromWhatsApp(raw: unknown): HumanReply[] {
  const out: HumanReply[] = [];
  const entries = isObj(raw) && Array.isArray(raw['entry']) ? raw['entry'] : [];
  for (const entry of entries) {
    if (!isObj(entry) || !Array.isArray(entry['changes'])) continue;
    for (const change of entry['changes']) {
      if (!isObj(change) || change['field'] !== 'smb_message_echoes' || !isObj(change['value'])) continue;
      const echoes = change['value']['message_echoes'];
      if (!Array.isArray(echoes)) continue;
      for (const echo of echoes) {
        if (!isObj(echo)) continue;
        const to = echo['to'];
        const id = echo['id'];
        if (typeof to !== 'string' || to === '' || typeof id !== 'string' || id === '') continue;
        const seconds = Number(echo['timestamp']);
        const body = isObj(echo['text']) && typeof echo['text']['body'] === 'string' ? echo['text']['body'] : '';
        out.push({
          channel: 'whatsapp',
          conversationRef: to,
          externalId: id,
          text: body,
          sentAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(),
        });
      }
    }
  }
  return out;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
