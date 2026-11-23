/**
 * Cœur métier d'AIMMO : fiche client unique, règles d'envoi, journal.
 * Chaque module arrive par une tâche de chantier/PLAN.md.
 */
export const AIMMO_VERSION = '0.1.0';

export * from './db/index.ts';
export * from './sauvegarde/index.ts';
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
// M10 sous son propre nom, comme M07 et M09.
export * as dossiers from './dossiers/index.ts';
export * from './apres-vente/index.ts';
// M13 sous son propre nom, comme M07, M09 et M10.
export * as pilotage from './pilotage/index.ts';
// M12 sous son propre nom, comme M13.
export * as conformite from './conformite/index.ts';
// M14 sous son propre nom, comme M12 et M13 (J13).
export * as reseau from './reseau/index.ts';
// M15 sous son propre nom, comme M14 (W10).
export * as location from './location/index.ts';
// M18 sous son propre nom, comme M15 (U09).
export * as partenaires from './partenaires/index.ts';
// M17 sous son propre nom, comme M18 (Y08).
export * as investir from './investir/index.ts';
// M16 sous son propre nom, comme M15 (CE10).
export * as commerces from './commerces/index.ts';
// M19 sous son propre nom, comme M17 (X10).
export * as studio from './studio/index.ts';
// HX01 sous son propre nom, comme M19.
export * as partage from './partage/index.ts';
// HX06 sous son propre nom, comme HX01.
export * as dictee from './dictee/index.ts';
// HX07 sous son propre nom, comme HX06.
export * as boutique from './boutique/index.ts';
// HX08 sous son propre nom, comme HX07.
export * as remises from './remises/index.ts';
// HX09 sous son propre nom, comme HX08.
export * as actualites from './actualites/index.ts';
// HX10 sous son propre nom, comme HX09.
export * as cles from './cles/index.ts';
export * as pige from './pige/index.ts';
export * as horsLigne from './hors-ligne/index.ts';
// HX13 sous son propre nom, comme HX12.
export * as presentation from './presentation/index.ts';
export * as panneaux from './panneaux/index.ts';
export * as statistiquesSite from './statistiques-site/index.ts';
export * as veilleDpe from './veille-dpe/index.ts';
export * as scoreAdresse from './score-adresse/index.ts';
export * as adressePige from './adresse-pige/index.ts';
export * as tourneeProspection from './tournee-prospection/index.ts';
export * as sequenceProspection from './sequence-prospection/index.ts';
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
export {
  DESIGN_CSS,
  ICON_SVG as DESIGN_ICON_SVG,
  PAIRES_TEXTE,
  PAIRES_TRAIT,
  ETIQUETTES_CSS,
  ETIQUETTES_DPE,
  PALETTE,
  POLICES,
  PRINT_DESIGN_CSS,
  PUBLIC_PAGE_CSS,
  THEME_COLOR,
  renderPublicPage,
} from './design/systeme.ts';
export type { PublicPageOptions, Teinte } from './design/systeme.ts';
export { GeographieReseau, NETWORK_COMMUNE_FIELDS, isInseeCode } from './geographie/communes.ts';
export type { GeographyRefusal, NetworkCommune, NetworkGeography } from './geographie/communes.ts';
