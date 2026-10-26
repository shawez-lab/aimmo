/**
 * Journal des envois et des refus [R13], en ajout seul. Aucune donnée personnelle en clair : identifiants internes,
 * canal, type, règle et raison. Une interface, pour que le journal à empreintes de S07 puisse prendre le relais.
 */
import type { Channel } from '../db/types.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { SendKind } from './decision.ts';

export type SendOutcome = 'sent' | 'refused' | 'failed';

export interface SendLogEntry {
  networkId: string;
  agentId: string | null;
  personId: string;
  messageId: string | null;
  channel: Channel;
  kind: SendKind;
  outcome: SendOutcome;
  /** La règle appliquée, R01 à R13, ou null quand aucune règle n'a eu à trancher. */
  rule: string | null;
  /** Raison en français, écrite sans aucune donnée de la fiche. */
  reason: string;
  aiText: boolean;
  fallbackText: boolean;
  withMention: boolean;
  occurredAt: Date;
}

export interface SendLogRow {
  id: string;
  network_id: string;
  agent_id: string | null;
  person_id: string;
  message_id: string | null;
  channel: Channel;
  kind: SendKind;
  outcome: SendOutcome;
  rule: string | null;
  reason: string;
  ai_text: number;
  fallback_text: number;
  with_mention: number;
  occurred_at: string;
  created_at: string;
}

export interface SendJournal {
  record(entry: SendLogEntry): Promise<void>;
}

export class SqlSendJournal implements SendJournal {
  constructor(
    private readonly db: SqlDatabase,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(e: SendLogEntry): Promise<void> {
    await this.db.run(
      `INSERT INTO send_log (id, network_id, agent_id, person_id, message_id, channel, kind, outcome, rule, reason,
         ai_text, fallback_text, with_mention, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.newId(),
        e.networkId,
        e.agentId,
        e.personId,
        e.messageId,
        e.channel,
        e.kind,
        e.outcome,
        e.rule,
        e.reason,
        e.aiText ? 1 : 0,
        e.fallbackText ? 1 : 0,
        e.withMention ? 1 : 0,
        e.occurredAt.toISOString(),
        this.now().toISOString(),
      ],
    );
  }

  list(personId: string): Promise<SendLogRow[]> {
    return this.db.all<SendLogRow>('SELECT * FROM send_log WHERE person_id = ? ORDER BY occurred_at, rowid', [personId]);
  }
}
