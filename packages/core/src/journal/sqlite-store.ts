import type { JournalData, JournalEntry, JournalStore } from './types.ts';

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface JournalSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
}

interface JournalRow {
  seq: number;
  at: string;
  type: string;
  actor: string;
  subject: string | null;
  data: string;
  prev_hash: string;
  hash: string;
}

function toEntry(value: unknown): JournalEntry {
  const row = value as JournalRow;
  return {
    seq: row.seq,
    at: row.at,
    type: row.type,
    actor: row.actor,
    subject: row.subject,
    data: JSON.parse(row.data) as JournalData,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export class SqliteJournalStore implements JournalStore {
  constructor(private readonly database: JournalSqliteDatabase) {}

  async append(entry: JournalEntry): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO journal (seq, at, type, actor, subject, data, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.seq,
        entry.at,
        entry.type,
        entry.actor,
        entry.subject,
        JSON.stringify(entry.data),
        entry.prevHash,
        entry.hash,
      );
  }

  async last(): Promise<JournalEntry | null> {
    const row = this.database.prepare('SELECT * FROM journal ORDER BY seq DESC LIMIT 1').get();
    return row === undefined ? null : toEntry(row);
  }

  async all(): Promise<JournalEntry[]> {
    return this.rows('SELECT * FROM journal ORDER BY seq');
  }

  async bySubject(subject: string): Promise<JournalEntry[]> {
    return this.rows('SELECT * FROM journal WHERE subject = ? ORDER BY seq', subject);
  }

  async byPeriod(fromIso: string, toIso: string): Promise<JournalEntry[]> {
    return this.rows(
      'SELECT * FROM journal WHERE at >= ? AND at <= ? ORDER BY seq',
      fromIso,
      toIso,
    );
  }

  private rows(sql: string, ...params: unknown[]): JournalEntry[] {
    return this.database.prepare(sql).all(...params).map(toEntry);
  }
}
