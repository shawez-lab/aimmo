/**
 * Le planificateur du socle (S11, B02) : les tâches à heure fixe quittent GitHub Actions et les applications pour le
 * Worker AIMMO, appelé chaque heure par son déclencheur.
 *
 * Chaque tâche dit à quelles heures de Paris elle passe. Un créneau, c'est une date et une heure de Paris : une tâche
 * n'y passe qu'une fois, même si le déclencheur passe deux fois ou si l'heure revient au changement d'heure.
 * Chaque passage est écrit au journal avec son issue ; une erreur n'arrête pas les autres tâches et n'est jamais
 * avalée [R13]. En mode essai, les tâches du site ne font que noter leur passage : aucun appel sortant [R26].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const SCHEDULER_TIME_ZONE = 'Europe/Paris';
export const SCHEDULER_JOURNAL_TYPE = 'planificateur.passage';

export interface ScheduledRun {
  job: string;
  slot: string;
  at: Date;
}

export interface ScheduledJob {
  /** Nom stable, sans donnée : `site.rappels_visite`. */
  name: string;
  /** Heures de Paris, 0 à 23, où la tâche passe. */
  hours: readonly number[];
  /** Jours, 1 = lundi … 7 = dimanche ; absent : tous les jours. */
  weekdays?: readonly number[];
  /** Minute de Paris à partir de laquelle la tâche passe dans son heure ; absente : dès le début de l'heure. */
  minute?: number;
  run(run: ScheduledRun): Promise<void>;
}

export interface TickResult {
  slot: string;
  ran: string[];
  skipped: string[];
  failed: string[];
}

/** Le créneau d'un instant : `AAAA-MM-JJTHH`, heure de Paris. */
export function slotOf(at: Date, timeZone = SCHEDULER_TIME_ZONE): { slot: string; hour: number; minute: number; weekday: number } {
  const local = localTime(at, timeZone);
  const hour = Math.floor(local.minutes / 60);
  return { slot: `${local.date}T${String(hour).padStart(2, '0')}`, hour, minute: local.minutes % 60, weekday: local.weekday };
}

const NAME = /^[a-z][a-z0-9_.]{0,63}$/;

export class Planificateur {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly jobs: readonly ScheduledJob[],
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const names = new Set<string>();
    for (const job of jobs) {
      if (!NAME.test(job.name) || names.has(job.name)) throw new Error(`Nom de tâche non valable ou en double : ${job.name}`);
      if (job.hours.length === 0 || !job.hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 23)) throw new Error(`Heures non valables : ${job.name}`);
      if (job.weekdays && !job.weekdays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) throw new Error(`Jours non valables : ${job.name}`);
      if (job.minute !== undefined && !(Number.isInteger(job.minute) && job.minute >= 0 && job.minute <= 59)) throw new Error(`Minute non valable : ${job.name}`);
      names.add(job.name);
    }
  }

  /** Un passage du déclencheur : chaque tâche due dans ce créneau, une fois. */
  async tick(): Promise<TickResult> {
    const at = this.now();
    const { slot, hour, minute, weekday } = slotOf(at);
    const result: TickResult = { slot, ran: [], skipped: [], failed: [] };
    for (const job of this.jobs) {
      if (!job.hours.includes(hour) || (job.weekdays && !job.weekdays.includes(weekday))) continue;
      // Pas encore sa minute : la tâche passera au déclencheur suivant de la même heure.
      if (job.minute !== undefined && minute < job.minute) continue;
      // Réserver le créneau avant de lancer : deux passages en même temps n'en font qu'un.
      const claimed = await this.db.run('INSERT INTO scheduled_runs (job, slot, started_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [
        job.name,
        slot,
        at.toISOString(),
      ]);
      if (claimed.changes !== 1) {
        result.skipped.push(job.name);
        continue;
      }
      let outcome: 'ok' | 'error' = 'ok';
      let error: string | null = null;
      try {
        await job.run({ job: job.name, slot, at });
      } catch (e) {
        outcome = 'error';
        // Seulement le nom de l'erreur : son message pourrait porter une donnée [R13].
        error = e instanceof Error ? e.name : 'unknown';
      }
      await this.db.run('UPDATE scheduled_runs SET outcome = ?, finished_at = ? WHERE job = ? AND slot = ?', [outcome, this.now().toISOString(), job.name, slot]);
      await appendEvent(
        this.journal,
        { type: SCHEDULER_JOURNAL_TYPE, actor: 'system:planificateur', subject: null, data: { job: job.name, slot, outcome, error } },
        this.now,
      );
      (outcome === 'ok' ? result.ran : result.failed).push(job.name);
    }
    return result;
  }
}

/**
 * Les tâches à heure fixe du site (`taches.yml` → `/api/espace/taches`), inscrites au planificateur en mode essai :
 * leur passage est noté au journal, le site n'est pas appelé [R26]. Le site garde sa propre action jusqu'à B04.
 *   - rappel de visite, la veille de 18 h à 21 h ;
 *   - mails au vendeur gardés la nuit, de 8 h à 21 h.
 */
export const SITE_JOBS_TRIAL: readonly ScheduledJob[] = Object.freeze([
  { name: 'site.rappels_visite', hours: [18, 19, 20], run: async () => {} },
  { name: 'site.courriers_vendeur', hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], run: async () => {} },
]);
