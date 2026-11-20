/**
 * Ce que la direction sait de la copie de chaque nuit (SV02) [R230, R16, R13].
 *
 * Décidé, lecture prudente :
 * - le travail de nuit range son compte rendu, réussi ou non ; le Worker ne prend aucune copie, il lit ;
 * - l'alerte ne dépend pas du travail : s'il n'a pas tourné du tout (GitHub Actions à l'arrêt), rien n'est écrit, et le
 *   passage de 6 h voit qu'aucune copie réussie n'est arrivée. Ne rien savoir ne vaut jamais « à jour » ;
 * - une nuit va de 6 h la veille à 6 h, heure de Paris ; une alerte par nuit, jamais deux ;
 * - tout vaut pour la base entière, donc pour tous les réseaux : la direction lit une date et un état, ni le nombre de
 *   lignes ni celui des tables.
 */
import type { Viewer } from '../acces/droits.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { expectedRestoreMonth } from './restauration.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { parisDayStart } from '../pilotage/tableau-agent.ts';

/** La durée de garde des copies : la règle du compartiment (H50), écrite aussi au registre des traitements. */
export const COPY_KEEP_DAYS = 30;
export const COPY_WATCH_JOB = 'sauvegarde.surveillance';
const WATCH_HOUR = 6;
const SHOWN_NIGHTS = 7;

export const COPY_FAILURES = ['cle_absente', 'cle_invalide', 'stockage_absent', 'photo_absente', 'photo_vide', 'stockage_en_panne', 'copie_non_restaurable', 'copie_echouee'] as const;
export type CopyFailure = (typeof COPY_FAILURES)[number];

export type CopyRun =
  | { id: string; startedAt: string; finishedAt: string; outcome: 'copiee'; copyId: string; tables: number; rows: number; parts: number }
  | { id: string; startedAt: string; finishedAt: string; outcome: 'non_sauvegardee'; reason: CopyFailure };

/** Le compte rendu du travail : une seule fois, jamais réécrit. */
export async function recordCopyRun(db: SqlDatabase, run: CopyRun): Promise<void> {
  const success = run.outcome === 'copiee';
  await db.run(
    'INSERT INTO base_copy_runs (id, started_at, finished_at, outcome, reason, copy_id, tables_count, rows_count, parts_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [run.id, run.startedAt, run.finishedAt, run.outcome, success ? null : run.reason, success ? run.copyId : null, success ? run.tables : null, success ? run.rows : null, success ? run.parts : null],
  );
}

const previousDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Le début de la dernière nuit finie : une copie plus ancienne ne suffit plus. */
export function copyWindowStart(at: Date): Date {
  const local = localTime(at, 'Europe/Paris');
  const finishedOn = local.minutes >= WATCH_HOUR * 60 ? local.date : previousDay(local.date);
  return new Date(parisDayStart(previousDay(finishedOn)).getTime() + WATCH_HOUR * 3_600_000);
}

export type CopyState = 'a_jour' | 'en_retard' | 'jamais';

export interface CopyStatus {
  state: CopyState;
  lastSuccessAt: string | null;
  /** Le dernier échec rapporté, s'il est plus récent que la dernière réussite. */
  lastFailure: { at: string; reason: CopyFailure } | null;
  /** Les dernières nuits sans copie, la plus récente d'abord. */
  missedNights: string[];
  /**
   * AU109 · La preuve que la copie tourne vraiment : une copie réussie depuis la veille à 6 h et un test de restauration
   * réussi pour le mois attendu. Sans les deux, « non prouvée » : l'allumage (H50) n'est jamais supposé.
   */
  activation: 'prouvee' | 'non_prouvee';
  /** Le dernier test de restauration réussi du mois attendu, ou rien. */
  exerciseAt: string | null;
}

export class SuiviCopies {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async lastSuccess(): Promise<string | null> {
    const row = await this.db.first<{ at: string | null }>("SELECT MAX(started_at) AS at FROM base_copy_runs WHERE outcome = 'copiee'");
    return row?.at ?? null;
  }

  /** La direction seule [R16]. */
  async status(viewer: Viewer): Promise<{ ok: true; value: CopyStatus } | { ok: false; rule: 'R16'; code: 'role' }> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const subject = `network:${viewer.networkId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'base_copies', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const lastSuccessAt = await this.lastSuccess();
    const failure = await this.db.first<{ at: string; reason: CopyFailure }>(
      "SELECT started_at AS at, reason FROM base_copy_runs WHERE outcome = 'non_sauvegardee' AND started_at > ? ORDER BY started_at DESC LIMIT 1",
      [lastSuccessAt ?? ''],
    );
    const nights = await this.db.all<{ night: string }>('SELECT night FROM base_copy_alerts ORDER BY night DESC LIMIT ?', [SHOWN_NIGHTS]);
    const state: CopyState = lastSuccessAt === null ? 'jamais' : lastSuccessAt >= copyWindowStart(this.now()).toISOString() ? 'a_jour' : 'en_retard';
    const exercise = await this.db.first<{ at: string | null }>(
      "SELECT MAX(tested_at) AS at FROM base_restore_receipts WHERE month >= ? AND outcome = 'reussie' AND tested_at <= ?",
      [expectedRestoreMonth(this.now()), this.now().toISOString()],
    );
    const exerciseAt = exercise?.at ?? null;
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor, subject, data: { kind: 'base_copies' } }, this.now);
    return { ok: true, value: { state, lastSuccessAt, lastFailure: failure ?? null, missedNights: nights.map((n) => n.night), activation: state === 'a_jour' && exerciseAt !== null ? 'prouvee' : 'non_prouvee', exerciseAt } };
  }

  /** Une nuit sans copie réussie donne une alerte, une seule. Rend vrai si elle vient d'être levée. */
  async watch(): Promise<boolean> {
    const at = this.now();
    const lastSuccessAt = await this.lastSuccess();
    if (lastSuccessAt !== null && lastSuccessAt >= copyWindowStart(at).toISOString()) return false;
    const night = localTime(at, 'Europe/Paris').date;
    const { changes } = await this.db.run('INSERT INTO base_copy_alerts (night, last_success_at, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [night, lastSuccessAt, at.toISOString()]);
    if (changes !== 1) return false;
    await appendEvent(this.journal, { type: 'base.copie_manquee', actor: 'system:sauvegarde', subject: `copy:nuit-${night}`, data: { rule: 'R230', night } }, this.now);
    return true;
  }
}

/** Le passage du planificateur : de 6 h à 8 h, pour qu'une panne de 6 h ne perde pas l'alerte. */
export function copyWatchJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob {
  return {
    name: COPY_WATCH_JOB,
    hours: [WATCH_HOUR, WATCH_HOUR + 1, WATCH_HOUR + 2],
    run: async () => {
      await new SuiviCopies(db, journal, options).watch();
    },
  };
}
