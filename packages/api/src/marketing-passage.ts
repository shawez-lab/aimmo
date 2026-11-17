/**
 * Le passage planifié du marketing (BR112) : les créneaux dus du calendrier de publication (HX52) et l'envoi des
 * éditions de la lettre d'information (HX53), au planificateur du socle, en mode essai seulement [R26].
 *
 * - Calendrier, à chaque heure : pour chaque réseau qui a un créneau dû depuis moins de deux heures et pas encore
 *   passé, `CalendrierPublications.runDue`, avec la vraie porte de publication de X05 (`Publications.publish`), qui
 *   relit la validation de l'agent, la porte de diffusion, les certificats, et n'a que les canaux d'essai [R582, R134,
 *   R42, R26]. Chaque créneau est réservé en base avant l'appel : rejoué, il ne passe pas deux fois ; sans lien marqué
 *   vers la page du bien, rien ne part [R582, R156]. Le planificateur ne passe qu'une fois par heure : un créneau part
 *   au plus tard au passage de l'heure suivante, jamais plus de deux heures après son heure (il est alors manqué).
 *   Sans le stockage des fichiers du studio (`MEDIA`), les certificats et les accords ne se lisent pas : le passage du
 *   calendrier ne tourne pas, et aucun créneau n'est consommé à tort.
 * - Lettre, du lundi au samedi à 10 h et 16 h : chaque édition ouverte depuis moins de sept jours passe par
 *   `LettreInformation.sendEdition`, qui ne prépare une lettre qu'aux accords de la lettre en vigueur [R583], une par
 *   édition et par personne, réservée en base [R05] ; une lettre qui attend (heure, bien parti entre-temps) est reprise
 *   au passage suivant de la semaine. Sans lien de désinscription réglé (`LETTRE_DESINSCRIPTION_BASE`), aucune lettre ne
 *   part et chaque édition le dit au journal, sans donnée [R584].
 *
 * Au journal : les issues et leurs règles, jamais un texte ni un lien [R13].
 */
import { Acces, FicheClient, FicheUnique, type JournalStore, type ScheduledJob, type SqlDatabase } from '@aimmo/core';
import { checkUnsubscribeBase } from '../../core/src/acquereurs/alertes.ts';
import { OrigineContacts } from '../../core/src/attirer/origine-contacts.ts';
import { Diffusion } from '../../core/src/documents/retractation.ts';
import { CalendrierPublications, LATE_MS, type CalendarDeps, type LettreInformation } from '../../core/src/marketing/index.ts';
import { letterService } from './marketing.ts';
import { studioCore } from './studio.ts';

/** Le nom du passage du calendrier de publication, sans donnée. */
export const CALENDAR_JOB = 'marketing.calendrier';
/** Le nom du passage des éditions de la lettre, sans donnée. */
export const LETTER_JOB = 'marketing.lettre';
/** La page publique de désinscription de la lettre, hors de `/v1`, sans chiffre [R10]. */
export const LETTER_UNSUBSCRIBE_PATH = '/lettre/desinscription/';
/** Une édition est envoyée pendant sept jours après son ouverture, puis plus jamais. */
export const LETTER_EDITION_DAYS = 7;
/** Les heures de Paris du passage de la lettre, dans les heures permises du contrôle central [R01]. */
export const LETTER_HOURS: readonly number[] = [10, 16];

/**
 * Le lien de désinscription de la lettre (variable `LETTRE_DESINSCRIPTION_BASE`) : en https, sans chiffre, terminé par
 * `/lettre/desinscription/`, la page qui retire l'accord de la lettre. Lecture prudente : absent ou mal formé, null, et
 * aucune lettre ne part [R584].
 */
export function letterUnsubscribeBase(raw: string | undefined | null): string | null {
  const base = (raw ?? '').trim();
  if (!base.endsWith(LETTER_UNSUBSCRIBE_PATH)) return null;
  try {
    return checkUnsubscribeBase(base);
  } catch {
    return null;
  }
}

/**
 * Le passage des créneaux dus du calendrier, à chaque heure. Les dépendances sont faites au moment du passage. Un
 * réseau en panne n'empêche pas les autres ; la première erreur remonte au planificateur, qui l'écrit au journal [R13].
 */
export function calendarJob(db: SqlDatabase, journal: JournalStore, deps: () => CalendarDeps, options: { now: () => Date }): ScheduledJob {
  return {
    name: CALENDAR_JOB,
    hours: Array.from({ length: 24 }, (_, h) => h),
    run: async () => {
      const now = options.now();
      const networks = await db.all<{ network_id: string }>(
        `SELECT DISTINCT c.network_id FROM social_calendar_slots c LEFT JOIN social_calendar_runs r ON r.slot_id = c.id
          WHERE r.slot_id IS NULL AND c.due_at <= ? AND c.due_at > ? ORDER BY c.network_id`,
        [now.toISOString(), new Date(now.getTime() - LATE_MS).toISOString()],
      );
      if (networks.length === 0) return;
      const calendrier = new CalendrierPublications(db, journal, deps(), { now: options.now });
      let failure: unknown = null;
      for (const n of networks) {
        try {
          await calendrier.runDue(n.network_id);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== null) throw failure;
    },
  };
}

/**
 * Le passage des éditions de la lettre, du lundi au samedi à 10 h et 16 h : chaque édition ouverte depuis moins de
 * sept jours, la plus ancienne d'abord. Une édition en panne n'empêche pas les autres ; la première erreur remonte.
 */
export function letterJob(db: SqlDatabase, letter: () => LettreInformation, options: { now: () => Date }): ScheduledJob {
  return {
    name: LETTER_JOB,
    hours: LETTER_HOURS,
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      const since = new Date(options.now().getTime() - LETTER_EDITION_DAYS * 86_400_000).toISOString();
      const editions = await db.all<{ id: string }>('SELECT id FROM newsletter_editions WHERE created_at > ? ORDER BY created_at, id', [since]);
      if (editions.length === 0) return;
      const lettre = letter();
      let failure: unknown = null;
      for (const e of editions) {
        try {
          await lettre.sendEdition(e.id);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== null) throw failure;
    },
  };
}

export interface MarketingJobsOptions {
  now: () => Date;
  /** Le stockage des fichiers du studio (`MEDIA`) ; absent, le passage du calendrier ne tourne pas. */
  files: { has(ref: string): Promise<boolean> } | null;
  /** Le lien de désinscription de la lettre, déjà vérifié par `letterUnsubscribeBase` ; null, aucune lettre ne part [R584]. */
  letterUnsubscribeBase: string | null;
}

/**
 * Les passages du marketing branchés comme au Worker : la porte de publication est celle du studio (X05), avec ses
 * canaux d'essai par défaut ; la lettre est celle des routes, avec les canaux d'essai du contrôle central [R26].
 */
export function marketingJobs(db: SqlDatabase, journal: JournalStore, options: MarketingJobsOptions): ScheduledJob[] {
  const { now, files } = options;
  const jobs: ScheduledJob[] = [];
  if (files) {
    jobs.push(
      calendarJob(
        db,
        journal,
        () => {
          const store = new FicheClient(db, { now });
          const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
          return {
            gate: studioCore({ db, journal, now, files }).publications,
            diffusion: new Diffusion(db, acces, journal, { now }),
            links: new OrigineContacts(db, journal, { now }),
          };
        },
        { now },
      ),
    );
  }
  jobs.push(letterJob(db, () => letterService({ db, journal, now }, options.letterUnsubscribeBase), { now }));
  return jobs;
}
