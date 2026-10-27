/**
 * Cœur métier d'AIMMO : fiche client unique, règles d'envoi, journal.
 * Chaque module arrive par une tâche de chantier/PLAN.md.
 */
export const AIMMO_VERSION = '0.1.0';

export * from './db/index.ts';
export * from './fiche/index.ts';
export * from './envoi/index.ts';
export * from './reception/index.ts';
export * from './acces/index.ts';
export * from './reprise/index.ts';
export * from './biens/index.ts';
export * from './captation/index.ts';
export * from './qualification/index.ts';
export * from './bascule/index.ts';
export * from './estimation/index.ts';
export * from './rendezvous/index.ts';
export * from './mandats/index.ts';
export * from './documents/index.ts';
export * from './acquereurs/index.ts';
export * from './visites/index.ts';
// M07 sous son propre nom : certains noms (CHANNELS, euros…) existent déjà dans le socle.
export * as annonces from './annonces/index.ts';
// M09 sous son propre nom, comme M07 : `CheckLine` existe déjà dans le socle.
export * as offres from './offres/index.ts';
export { hashEntry } from './journal/hash.ts';
export { appendEvent, verifyChain } from './journal/journal.ts';
export { MemoryJournalStore } from './journal/memory-store.ts';
export { SqliteJournalStore } from './journal/sqlite-store.ts';
export { SqlJournalStore } from './journal/sql-store.ts';
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
