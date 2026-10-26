/**
 * Cœur métier d'AIMMO : fiche client unique, règles d'envoi, journal.
 * Chaque module arrive par une tâche de chantier/PLAN.md.
 */
export const AIMMO_VERSION = '0.1.0';

export * from './db/index.ts';
export * from './fiche/index.ts';
export * from './envoi/index.ts';
