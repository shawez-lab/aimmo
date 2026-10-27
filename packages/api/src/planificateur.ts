import { Acces, FicheClient, FicheUnique, Planificateur, SITE_JOBS_TRIAL, SqlJournalStore, Visites, alertsJob, visitReportsJob, weeklyPointJob, appointmentBriefJob, appointmentReminderJob, dailyPlanJob, legalBasisJob, mandateDeadlinesJob, valueTrackingJob, vendorFollowUpJob, type CommuneRanges, type ScheduledJob, type SqlDatabase, type TickResult } from '@aimmo/core';
import { TRIAL_MODE, journalError } from './app.ts';
import { offersDailyJob } from './offres.ts';

export interface SchedulerConfig {
  db: SqlDatabase;
  /** Variable `MODE` : hors essai, rien ne passe. */
  mode: string | undefined;
  jobs?: readonly ScheduledJob[];
  /** Variable `RDV_LINK_BASE` : début du lien pour décaler ou annuler un rendez-vous ; absent, les rappels partent sans lien. */
  appointmentLinkBase?: string | undefined;
  /** La fourchette des communes (E05) pour le suivi de valeur ; absente, le suivi ne prépare aucun envoi. */
  communeRanges?: CommuneRanges | null;
  /** Variable `ALERT_UNSUBSCRIBE_BASE` : début du lien de désinscription des alertes ; absente, aucune alerte [R49]. */
  alertUnsubscribeBase?: string | undefined;
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
    // Tâches du site notées sans appel ; relance des vendeurs (E06) et rappels des rendez-vous (V04), par les canaux
    // du mode essai ; briefs des rendez-vous (V05), rangés pour l'agent, sans aucun envoi.
    const jobs = config.jobs ?? [
      ...SITE_JOBS_TRIAL,
      vendorFollowUpJob(config.db, journal, { now }),
      appointmentReminderJob(config.db, journal, { now, linkBase: config.appointmentLinkBase || null }),
      appointmentBriefJob(config.db, journal, { now }),
      // Plan du jour de chaque agent, figé à 7 h 30 (G02), sans aucun envoi.
      dailyPlanJob(config.db, journal, { now }),
      // Suivi de valeur (G04) : réponses lues, envois par les canaux du mode essai seulement.
      valueTrackingJob(config.db, journal, { now, ranges: config.communeRanges ?? null }),
      // Contrôle de la base légale des plans du jour sur 30 jours (G05), à 8 h.
      legalBasisJob(config.db, journal, { now }),
      // Échéances des mandats (D06), à 6 h : tâches pour l'agent, sans aucun envoi.
      mandateDeadlinesJob(config.db, journal, { now }),
      // Alertes aux acquéreurs (T03), de 9 h à 19 h, par les canaux du mode essai seulement.
      alertsJob(config.db, journal, { now, unsubscribeBase: config.alertUnsubscribeBase || null }),
      // Comptes rendus de visite validés en attente (T06), au passage suivant, par les canaux du mode essai.
      visitReportsJob(config.db, journal, () => {
        const store = new FicheClient(config.db, { now });
        return new Visites(config.db, journal, new Acces(config.db, store, new FicheUnique(config.db, store, { now }), journal, { now }), { now });
      }, { now }),
      // Point de la semaine au vendeur (T07) : préparé le lundi pour l'agent, envoyé après sa validation.
      weeklyPointJob(config.db, journal, () => {
        const store = new FicheClient(config.db, { now });
        return new Acces(config.db, store, new FicheUnique(config.db, store, { now }), journal, { now });
      }, { now }),
      // Offres (O09), à 6 h : offres non transmises signalées [R56], tâches la veille des échéances [R59], sans envoi.
      offersDailyJob(config.db, journal, { now }),
    ];
    return await new Planificateur(config.db, journal, jobs, { now }).tick();
  } catch (error) {
    await journalError(journal, 'system:planificateur', 'planificateur', error, now);
    return null;
  }
}
