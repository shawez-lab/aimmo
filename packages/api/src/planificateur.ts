import { Planificateur, SITE_JOBS_TRIAL, SqlJournalStore, vendorFollowUpJob, type ScheduledJob, type SqlDatabase, type TickResult } from '@aimmo/core';
import { TRIAL_MODE, journalError } from './app.ts';

export interface SchedulerConfig {
  db: SqlDatabase;
  /** Variable `MODE` : hors essai, rien ne passe. */
  mode: string | undefined;
  jobs?: readonly ScheduledJob[];
  now?: () => Date;
}

/**
 * Le passage horaire du déclencheur du Worker (B02). Lecture prudente : hors mode essai, aucune tâche ne passe.
 * Une erreur du planificateur lui-même est écrite au journal, jamais avalée [R13].
 */
export async function runScheduler(config: SchedulerConfig): Promise<TickResult | null> {
  if (config.mode !== TRIAL_MODE) return null;
  const now = config.now ?? (() => new Date());
  const journal = new SqlJournalStore(config.db);
  try {
    // Tâches du site notées sans appel, et relance des vendeurs par les canaux du mode essai (E06).
    const jobs = config.jobs ?? [...SITE_JOBS_TRIAL, vendorFollowUpJob(config.db, journal, { now })];
    return await new Planificateur(config.db, journal, jobs, { now }).tick();
  } catch (error) {
    await journalError(journal, 'system:planificateur', 'planificateur', error, now);
    return null;
  }
}
