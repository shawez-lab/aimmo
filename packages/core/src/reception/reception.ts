/**
 * Rangement des messages reçus [C01] : chaque message une seule fois [R18], les illisibles signalés à l'agent,
 * chaque réception écrite au journal sans donnée personnelle [R13]. Rien n'est jamais effacé [R17].
 */
import { maskIban } from '../envoi/texte.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { adaptInbound, type InboundSource } from './adaptateurs.ts';
import type {
  AdaptContext,
  AdaptResult,
  InboundChannel,
  InboundKind,
  InboundMessage,
  SenderIdentifier,
  UnreadableInbound,
} from './entrant.ts';

export type InboundStatus = 'received' | 'processing' | 'processed' | 'unreadable';
export type ReceptionOutcome = 'stored' | 'duplicate' | 'unreadable';

export interface InboundRow {
  id: string;
  network_id: string;
  agent_id: string | null;
  dedup_key: string;
  channel: InboundChannel;
  kind: InboundKind | 'unreadable';
  external_id: string | null;
  conversation_ref: string | null;
  sender_channel_id: string | null;
  sender_name: string | null;
  sender_identifiers: string;
  subject: string | null;
  body: string;
  post_ref: string | null;
  property_ref: string | null;
  portal: string | null;
  has_attachment: number;
  raw_payload: string | null;
  status: InboundStatus;
  person_id: string | null;
  message_id: string | null;
  received_at: string;
  created_at: string;
}

export interface ReceptionLogRow {
  id: string;
  network_id: string;
  agent_id: string | null;
  inbound_id: string;
  channel: InboundChannel;
  kind: string;
  outcome: ReceptionOutcome;
  reason: string;
  occurred_at: string;
  created_at: string;
}

export interface Received {
  inboundId: string;
  outcome: ReceptionOutcome;
  /**
   * Vrai tant que le message lisible n'a pas encore été pris pour traitement. Le traitement commence toujours par
   * `claim`, qui ne réussit qu'une fois : c'est lui qui garantit un seul traitement [R18].
   */
  toProcess: boolean;
}

export interface IngestResult {
  received: Received[];
  ignored: number;
}

/** Clé de la réception unique : canal, type et identifiant chez le canal [R18]. */
export function dedupKey(message: Pick<InboundMessage, 'channel' | 'kind' | 'externalId'>): string {
  return `${message.channel}:${message.kind}:${message.externalId}`;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Le contenu illisible, rangé sans IBAN [R15] : un JSON est relu et chaque texte qu'il porte est masqué avant d'être
 * réécrit, pour que les retours à la ligne échappés ne cachent pas un IBAN ; sinon le texte brut est masqué.
 */
export function maskPayload(raw: string): string {
  const walk = (v: unknown): unknown =>
    typeof v === 'string' ? maskIban(v) : Array.isArray(v) ? v.map(walk) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [maskIban(k), walk(x)])) : v;
  try {
    return JSON.stringify(walk(JSON.parse(raw)));
  } catch {
    return maskIban(raw);
  }
}

export class Reception {
  constructor(
    private readonly db: SqlDatabase,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Lit une notification brute d'une source et range ce qu'elle contient. */
  async ingest(networkId: string, source: InboundSource, raw: unknown, ctx?: Partial<AdaptContext>): Promise<IngestResult> {
    const adapted = adaptInbound(source, raw, { now: ctx?.now ?? this.now(), ...(ctx?.ownIds ? { ownIds: ctx.ownIds } : {}) });
    return this.store(networkId, adapted);
  }

  /** Range des messages déjà au format commun, et les illisibles. */
  async store(networkId: string, adapted: AdaptResult): Promise<IngestResult> {
    const received: Received[] = [];
    for (const message of adapted.messages) received.push(await this.receive(networkId, message));
    for (const item of adapted.unreadable) received.push(await this.receiveUnreadable(networkId, item));
    return { received, ignored: adapted.ignored };
  }

  /**
   * Range un message une seule fois. L'unicité tient à une seule instruction : deux réceptions simultanées
   * du même message ne rangent qu'une ligne, et une seule des deux rend `toProcess` [R18].
   */
  async receive(networkId: string, message: InboundMessage): Promise<Received> {
    const id = this.newId();
    const at = this.now().toISOString();
    const key = dedupKey(message);
    // Déjà rangé sous un autre identifiant du même message (AU032) : un doublon, jamais traité une seconde fois [R18].
    for (const previous of message.previousExternalIds ?? []) {
      const row = await this.db.first<{ id: string; status: InboundStatus }>('SELECT id, status FROM inbound_messages WHERE network_id = ? AND dedup_key = ?', [
        networkId,
        dedupKey({ ...message, externalId: previous }),
      ]);
      if (row) {
        await this.log(networkId, row.id, message.channel, message.kind, 'duplicate', 'message déjà reçu, non traité une seconde fois');
        return { inboundId: row.id, outcome: 'duplicate', toProcess: row.status === 'received' };
      }
    }
    const { changes } = await this.db.run(
      `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, external_id, conversation_ref,
         sender_channel_id, sender_name, sender_identifiers, subject, body, post_ref, property_ref, portal,
         has_attachment, status, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
       ON CONFLICT (network_id, dedup_key) DO NOTHING`,
      [
        id,
        networkId,
        key,
        message.channel,
        message.kind,
        message.externalId,
        message.conversationRef,
        message.sender.channelId,
        message.sender.name,
        JSON.stringify(message.sender.identifiers),
        // Un IBAN reçu n'est jamais rangé en clair [R15] : le masque garde le signal pour le bouclier (N05).
        message.subject === null ? null : maskIban(message.subject),
        maskIban(message.text),
        message.postRef,
        message.propertyRef,
        message.portal,
        message.hasAttachment ? 1 : 0,
        message.receivedAt.toISOString(),
        at,
      ],
    );
    if (changes === 1) {
      await this.log(networkId, id, message.channel, message.kind, 'stored', 'message reçu et rangé');
      return { inboundId: id, outcome: 'stored', toProcess: true };
    }
    const existing = await this.existing(networkId, key);
    await this.log(networkId, existing.id, message.channel, message.kind, 'duplicate', 'message déjà reçu, non traité une seconde fois');
    // Un message rangé mais jamais pris (coupure avant `claim`) peut encore être traité ; `claim` garantit qu'il ne l'est qu'une fois.
    return { inboundId: existing.id, outcome: 'duplicate', toProcess: existing.status === 'received' };
  }

  /** Range un contenu illisible, tel quel, et le signale à l'agent. Le même contenu reçu deux fois n'est rangé qu'une fois. */
  async receiveUnreadable(networkId: string, item: UnreadableInbound): Promise<Received> {
    const id = this.newId();
    const at = this.now().toISOString();
    const key = `${item.channel}:unreadable:${await sha256(item.raw)}`;
    const { changes } = await this.db.run(
      `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, raw_payload, status, received_at, created_at)
       VALUES (?, ?, ?, ?, 'unreadable', ?, 'unreadable', ?, ?)
       ON CONFLICT (network_id, dedup_key) DO NOTHING`,
      [id, networkId, key, item.channel, maskPayload(item.raw), at, at],
    );
    if (changes === 1) {
      await this.log(networkId, id, item.channel, 'unreadable', 'unreadable', `illisible, signalé à l'agent : ${item.reason}`);
      return { inboundId: id, outcome: 'unreadable', toProcess: false };
    }
    const existing = await this.existing(networkId, key);
    await this.log(networkId, existing.id, item.channel, 'unreadable', 'duplicate', 'contenu illisible déjà reçu');
    return { inboundId: existing.id, outcome: 'duplicate', toProcess: false };
  }

  /**
   * Prend un message reçu pour le traiter. Une seule instruction : si deux traitements le demandent en même temps,
   * un seul l'obtient [R18].
   */
  async claim(inboundId: string): Promise<boolean> {
    const { changes } = await this.db.run(
      "UPDATE inbound_messages SET status = 'processing' WHERE id = ? AND status = 'received'",
      [inboundId],
    );
    return changes === 1;
  }

  /** Marque un message traité, avec la fiche et le message de la fiche auxquels il est rattaché (C02). */
  async markProcessed(inboundId: string, link: { personId?: string; messageId?: string } = {}): Promise<boolean> {
    const { changes } = await this.db.run(
      `UPDATE inbound_messages SET status = 'processed', person_id = COALESCE(?, person_id), message_id = COALESCE(?, message_id)
       WHERE id = ? AND status = 'processing'`,
      [link.personId ?? null, link.messageId ?? null, inboundId],
    );
    return changes === 1;
  }

  /** Rend un message pris mais pas traité, pour qu'il soit repris plus tard (erreur pendant le traitement). */
  async release(inboundId: string): Promise<boolean> {
    const { changes } = await this.db.run(
      "UPDATE inbound_messages SET status = 'received' WHERE id = ? AND status = 'processing'",
      [inboundId],
    );
    return changes === 1;
  }

  /** Messages rangés mais jamais pris, pour une reprise après coupure : les plus anciens d'abord. */
  pending(networkId: string): Promise<InboundRow[]> {
    return this.db.all<InboundRow>(
      "SELECT * FROM inbound_messages WHERE network_id = ? AND status = 'received' ORDER BY received_at, rowid",
      [networkId],
    );
  }

  /** Ce que l'agent doit regarder lui-même : les messages illisibles, les plus anciens d'abord. */
  forAgent(networkId: string): Promise<InboundRow[]> {
    return this.db.all<InboundRow>(
      "SELECT * FROM inbound_messages WHERE network_id = ? AND status = 'unreadable' ORDER BY received_at, rowid",
      [networkId],
    );
  }

  get(inboundId: string): Promise<InboundRow | null> {
    return this.db.first<InboundRow>('SELECT * FROM inbound_messages WHERE id = ?', [inboundId]);
  }

  journal(inboundId: string): Promise<ReceptionLogRow[]> {
    return this.db.all<ReceptionLogRow>('SELECT * FROM reception_log WHERE inbound_id = ? ORDER BY occurred_at, rowid', [
      inboundId,
    ]);
  }

  private async existing(networkId: string, key: string): Promise<{ id: string; status: InboundStatus }> {
    const row = await this.db.first<{ id: string; status: InboundStatus }>(
      'SELECT id, status FROM inbound_messages WHERE network_id = ? AND dedup_key = ?',
      [networkId, key],
    );
    if (!row) throw new Error('Réception : message en double introuvable.');
    return row;
  }

  private async log(
    networkId: string,
    inboundId: string,
    channel: InboundChannel,
    kind: string,
    outcome: ReceptionOutcome,
    reason: string,
  ): Promise<void> {
    const at = this.now().toISOString();
    await this.db.run(
      `INSERT INTO reception_log (id, network_id, inbound_id, channel, kind, outcome, reason, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.newId(), networkId, inboundId, channel, kind, outcome, reason, at, at],
    );
  }
}

/** Relit les identifiants rangés d'un message reçu. */
export function senderIdentifiers(row: Pick<InboundRow, 'sender_identifiers'>): SenderIdentifier[] {
  const parsed: unknown = JSON.parse(row.sender_identifiers);
  return Array.isArray(parsed) ? (parsed as SenderIdentifier[]) : [];
}
