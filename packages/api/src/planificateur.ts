import { Planificateur, SITE_JOBS_TRIAL, SqlJournalStore, appointmentReminderJob, vendorFollowUpJob, type ScheduledJob, type SqlDatabase, type TickResult } from '@aimmo/core';
import { TRIAL_MODE, journalError } from './app.ts';

export interface SchedulerConfig {
  db: SqlDatabase;
  /** Variable `MODE` : hors essai, rien ne passe. */
  mode: string | undefined;
  jobs?: readonly ScheduledJob[];
  /** Variable `RDV_LINK_BASE` : début du lien pour décaler ou annuler un rendez-vous ; absent, les rappels partent sans lien. */
  appointmentLinkBase?: string | undefined;
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
    // Tâches du site notées sans appel, relance des vendeurs (E06) et rappels des rendez-vous (V04), par les canaux
    // du mode essai.
    const jobs = config.jobs ?? [
      ...SITE_JOBS_TRIAL,
      vendorFollowUpJob(config.db, journal, { now }),
      appointmentReminderJob(config.db, journal, { now, linkBase: config.appointmentLinkBase || null }),
    ];
    return await new Planificateur(config.db, journal, jobs, { now }).tick();
  } catch (error) {
    await journalError(journal, 'system:planificateur', 'planificateur', error, now);
    return null;
  }
}
