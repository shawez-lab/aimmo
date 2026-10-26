/**
 * Cœur métier d'AIMMO : fiche client unique, règles d'envoi, journal.
 * Chaque module arrive par une tâche de chantier/PLAN.md.
 */
export const AIMMO_VERSION = '0.1.0';

export { hashEntry } from './journal/hash.ts';
export { appendEvent, verifyChain } from './journal/journal.ts';
export { MemoryJournalStore } from './journal/memory-store.ts';
export { SqliteJournalStore } from './journal/sqlite-store.ts';
export type { JournalSqliteDatabase } from './journal/sqlite-store.ts';
export type {
  ChainVerification,
} from './journal/journal.ts';
export type {
  JournalData,
  JournalEntry,
  JournalEntryWithoutHash,
  JournalInput,
  JournalStore,
  JsonPrimitive,
  JsonValue,
} from './journal/types.ts';
