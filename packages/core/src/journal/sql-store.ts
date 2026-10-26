import type { SqlDatabase } from '../db/sql.ts';
import type { JournalData, JournalEntry, JournalStore } from './types.ts';

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

const toEntry = (row: JournalRow): JournalEntry => ({
  seq: Number(row.seq),
  at: row.at,
  type: row.type,
  actor: row.actor,
  subject: row.subject,
  data: JSON.parse(row.data) as JournalData,
  prevHash: row.prev_hash,
  hash: row.hash,
});

/**
 * Le journal à empreintes sur l'interface commune : la même table sous Cloudflare D1 (S09) et sous SQLite.
 * L'ajout seul est imposé par la base elle-même (migration 0002).
 */
export class SqlJournalStore implements JournalStore {
  constructor(private readonly db: SqlDatabase) {}

  async append(entry: JournalEntry): Promise<void> {
    await this.db.run(
      `INSERT INTO journal (seq, at, type, actor, subject, data, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.seq, entry.at, entry.type, entry.actor, entry.subject, JSON.stringify(entry.data), entry.prevHash, entry.hash],
    );
  }

  async last(): Promise<JournalEntry | null> {
    const row = await this.db.first<JournalRow>('SELECT * FROM journal ORDER BY seq DESC LIMIT 1');
    return row === null ? null : toEntry(row);
  }

  all(): Promise<JournalEntry[]> {
    return this.rows('SELECT * FROM journal ORDER BY seq');
  }

  bySubject(subject: string): Promise<JournalEntry[]> {
    return this.rows('SELECT * FROM journal WHERE subject = ? ORDER BY seq', [subject]);
  }

  byPeriod(fromIso: string, toIso: string): Promise<JournalEntry[]> {
    return this.rows('SELECT * FROM journal WHERE at >= ? AND at <= ? ORDER BY seq', [fromIso, toIso]);
  }

  private async rows(sql: string, params: readonly (string | number)[] = []): Promise<JournalEntry[]> {
    return (await this.db.all<JournalRow>(sql, params)).map(toEntry);
  }
}
