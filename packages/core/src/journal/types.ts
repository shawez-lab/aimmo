export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JournalData = Record<string, JsonValue>;

export interface JournalEntryWithoutHash {
  seq: number;
  at: string;
  type: string;
  actor: string;
  subject: string | null;
  data: JournalData;
  prevHash: string;
}

export interface JournalEntry extends JournalEntryWithoutHash {
  hash: string;
}

export type JournalInput = Pick<JournalEntry, 'type' | 'actor' | 'subject' | 'data'>;

export interface JournalStore {
  append(entry: JournalEntry): Promise<void>;
  last(): Promise<JournalEntry | null>;
  all(): Promise<JournalEntry[]>;
  bySubject(subject: string): Promise<JournalEntry[]>;
  byPeriod(fromIso: string, toIso: string): Promise<JournalEntry[]>;
}
