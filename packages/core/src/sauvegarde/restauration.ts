/**
 * Le test de restauration de chaque mois, et son reçu (SV03) [R232, R16].
 *
 * Jamais vu : la direction lit la preuve datée que ses données se restaurent vraiment, pas la promesse d'une sauvegarde.
 *
 * Décidé, lecture prudente :
 * - le test prend la dernière copie réussie et la restaure dans une base locale jetable, jamais en production ;
 * - plus d'une heure, c'est un échec : la cible du cahier, tenue même si tout est identique. La base le refuse aussi ;
 * - une copie de plus de 48 heures est un échec, même si elle se restaure : le mois ne serait pas prouvé ;
 * - le reçu ne porte que des instants, une durée, les comptes de la base entière et une empreinte de toute la base : une
 *   empreinte par table permettrait de deviner le contenu d'une petite table ;
 * - le dernier reçu du mois décide : un échec se rattrape par un test réussi, et une réussite ne cache pas un échec plus récent ;
 * - depuis AU019b, le test restaure aussi chaque fichier de chaque stockage, relu contre son empreinte, et vérifie que
 *   chaque fichier cité par la base est dans la copie : une copie sans ses fichiers est « non identique » ;
 * - le test passe le 2 du mois : jusqu'au 3 au soir, le mois attendu est encore le mois d'avant. Sans reçu, l'écran le dit.
 */
import type { ScheduledJob } from '../bascule/planificateur.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { copyKeyFromSecret, type CopyKey, type CopyStore } from './copie.ts';
import { fileReferences, OBJECT_STORAGES, restoreExercise, verifyingTarget, type ObjectStorage, type ObjectTarget } from './objets.ts';

export const RESTORE_LIMIT_MS = 3_600_000;
/** Une copie plus vieille ne prouve rien sur les données du mois : la copie de nuit est morte, le test le dit. */
export const RESTORE_COPY_MAX_AGE_MS = 48 * 3_600_000;
const FIRST_EXPECTED_DAY = 4;

export const RESTORE_FAILURES = ['aucune_copie', 'cle_absente', 'cle_invalide', 'stockage_absent', 'stockage_en_panne', 'copie_abimee', 'copie_trop_ancienne', 'non_identique', 'trop_longue', 'test_echoue'] as const;
export type RestoreFailure = (typeof RESTORE_FAILURES)[number];

export type RestoreReceipt =
  | { id: string; testedAt: string; month: string; outcome: 'reussie'; copyTakenAt: string; durationMs: number; tables: number; rows: number; digest: string }
  | { id: string; testedAt: string; month: string; outcome: 'echouee'; reason: RestoreFailure; copyTakenAt: string | null; durationMs: number | null; tables: number | null; rows: number | null };

const parisMonthOf = (at: Date): string => localTime(at, 'Europe/Paris').date.slice(0, 7);

export async function recordRestoreReceipt(db: SqlDatabase, r: RestoreReceipt): Promise<void> {
  const ok = r.outcome === 'reussie';
  await db.run(
    'INSERT INTO base_restore_receipts (id, tested_at, month, outcome, reason, copy_taken_at, duration_ms, tables_count, rows_count, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [r.id, r.testedAt, r.month, r.outcome, ok ? null : r.reason, r.copyTakenAt, r.durationMs, r.tables, r.rows, ok ? r.digest : null],
  );
}

export interface MonthlyRestoreInput {
  /** La base de production, lue pour trouver la dernière copie ; rien n'y est restauré. */
  db: SqlDatabase;
  secret: string;
  store: CopyStore | null;
  /** Une base neuve et jetable. */
  fresh: () => SqlDatabase;
  now?: () => Date;
  clock?: () => number;
}

class StoreDown extends Error {}

/** Une empreinte de la base et des fichiers ensemble : le reçu prouve les deux. */
async function combinedDigest(base: string, objects: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${base}\n${objects}`);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Le test : rend le reçu, réussi ou non ; lève seulement si la base ne se lit pas, et il n'y a alors aucun reçu à ranger. */
export async function runRestoreTest(input: MonthlyRestoreInput): Promise<RestoreReceipt> {
  const at = (input.now ?? (() => new Date()))();
  const head = { id: crypto.randomUUID(), testedAt: at.toISOString(), month: parisMonthOf(at) };
  const no = (reason: RestoreFailure, copyTakenAt: string | null = null, durationMs: number | null = null, tables: number | null = null, rows: number | null = null): RestoreReceipt => ({ ...head, outcome: 'echouee', reason, copyTakenAt, durationMs, tables, rows });
  const last = await input.db.first<{ copy_id: string; started_at: string }>("SELECT copy_id, started_at FROM base_copy_runs WHERE outcome = 'copiee' ORDER BY started_at DESC LIMIT 1");
  if (!last) return no('aucune_copie');
  if (input.secret === '') return no('cle_absente', last.started_at);
  let key: CopyKey;
  try {
    key = await copyKeyFromSecret(input.secret);
  } catch {
    return no('cle_invalide', last.started_at);
  }
  if (!input.store) return no('stockage_absent', last.started_at);
  try {
    const source = input.store;
    const watched: CopyStore = {
      put: (k, b) => source.put(k, b),
      get: async (k) => {
        try {
          return await source.get(k);
        } catch {
          throw new StoreDown();
        }
      },
    };
    const targets = Object.fromEntries(OBJECT_STORAGES.map((name) => [name, verifyingTarget()])) as Record<ObjectStorage, ObjectTarget>;
    const exercise = await restoreExercise({ target: input.fresh(), targets, store: watched, key, copyId: last.copy_id, references: fileReferences, ...(input.clock ? { clock: input.clock } : {}) });
    if (!exercise.ok && exercise.part === 'base') {
      const failed = exercise.base;
      if (failed.code === 'not_identical') return no('non_identique', last.started_at, failed.durationMs);
      const reason: Record<typeof failed.code, RestoreFailure> = { undecryptable: 'cle_invalide', manifest_missing: 'stockage_en_panne', part_missing: 'stockage_en_panne', part_corrupt: 'copie_abimee', bad_copy_id: 'copie_abimee', bad_format: 'copie_abimee', restore_failed: 'copie_abimee', target_not_empty: 'test_echoue' };
      return no(reason[failed.code], last.started_at);
    }
    if (!exercise.ok && exercise.part === 'objets') {
      // Une copie sans ses fichiers, ou dont un fichier diffère ou manque, ne rend pas les dossiers : « non identique ».
      const reason: Record<typeof exercise.objects.code, RestoreFailure> = { objects_missing: 'non_identique', not_identical: 'non_identique', undecryptable: 'cle_invalide', bad_copy_id: 'copie_abimee', bad_format: 'copie_abimee', storage_missing: 'test_echoue', target_not_empty: 'test_echoue', references_unchecked: 'test_echoue' };
      return no(reason[exercise.objects.code], last.started_at);
    }
    if (!exercise.ok) return no('test_echoue', last.started_at);
    const restored = { ...exercise.base, durationMs: exercise.durationMs, digest: await combinedDigest(exercise.base.digest, exercise.objects.digest) };
    if (restored.durationMs > RESTORE_LIMIT_MS) return no('trop_longue', last.started_at, restored.durationMs, restored.tables, restored.rows);
    if (at.getTime() - Date.parse(restored.takenAt) > RESTORE_COPY_MAX_AGE_MS) return no('copie_trop_ancienne', last.started_at, restored.durationMs, restored.tables, restored.rows);
    if (restored.tables === 0 || restored.rows === 0) return no('copie_abimee', last.started_at, restored.durationMs);
    return { ...head, outcome: 'reussie', copyTakenAt: restored.takenAt, durationMs: restored.durationMs, tables: restored.tables, rows: restored.rows, digest: restored.digest };
  } catch (error) {
    // L'erreur peut citer une ligne : elle ne sort pas.
    return no(error instanceof StoreDown ? 'stockage_en_panne' : 'test_echoue', last.started_at);
  }
}

export type RestoreState = 'reussi' | 'echec' | 'manquant';

export interface RestoreStatus {
  state: RestoreState;
  /** Le mois dont un reçu est attendu aujourd'hui. */
  expectedMonth: string;
  /** Le dernier reçu du mois attendu ; sinon le dernier connu, pour dire depuis quand. */
  receipt: RestoreReceipt | null;
}

/** Le mois dont un reçu est attendu : le mois en cours, une fois le test passé, sinon le mois d'avant. */
export function expectedRestoreMonth(at: Date): string {
  const date = localTime(at, 'Europe/Paris').date;
  if (Number(date.slice(8, 10)) >= FIRST_EXPECTED_DAY) return date.slice(0, 7);
  return new Date(Date.parse(`${date.slice(0, 7)}-01T12:00:00Z`) - 86_400_000).toISOString().slice(0, 7);
}

interface ReceiptRow {
  id: string;
  tested_at: string;
  month: string;
  outcome: 'reussie' | 'echouee';
  reason: RestoreFailure | null;
  copy_taken_at: string | null;
  duration_ms: number | null;
  tables_count: number | null;
  rows_count: number | null;
  digest: string | null;
}

const toReceipt = (r: ReceiptRow): RestoreReceipt => {
  const head = { id: r.id, testedAt: r.tested_at, month: r.month };
  return r.outcome === 'reussie'
    ? { ...head, outcome: 'reussie', copyTakenAt: r.copy_taken_at!, durationMs: r.duration_ms!, tables: r.tables_count!, rows: r.rows_count!, digest: r.digest! }
    : { ...head, outcome: 'echouee', reason: r.reason!, copyTakenAt: r.copy_taken_at, durationMs: r.duration_ms, tables: r.tables_count, rows: r.rows_count };
};

export class RecusRestauration {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * AU109 · Un mois sans reçu réussi du test de restauration, une fois passé le jour attendu : une alerte, une seule,
   * levée par le Worker, qui n'a pas besoin du travail GitHub pour cela. Rend vrai si elle vient d'être levée.
   */
  async watch(): Promise<boolean> {
    const at = this.now();
    const month = expectedRestoreMonth(at);
    const ok = await this.db.first("SELECT id FROM base_restore_receipts WHERE month >= ? AND outcome = 'reussie' AND tested_at <= ? LIMIT 1", [month, at.toISOString()]);
    if (ok) return false;
    const last = await this.db.first<{ at: string | null }>('SELECT MAX(tested_at) AS at FROM base_restore_receipts WHERE tested_at <= ?', [at.toISOString()]);
    const { changes } = await this.db.run('INSERT INTO base_restore_alerts (month, last_receipt_at, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [month, last?.at ?? null, at.toISOString()]);
    if (changes !== 1) return false;
    await appendEvent(this.journal, { type: 'base.restauration_manquee', actor: 'system:sauvegarde', subject: `copy:mois-${month}`, data: { rule: 'R232', month } }, this.now);
    return true;
  }

  /** La direction seule [R16]. Sans reçu du mois attendu : « manquant », jamais vert par défaut. */
  async status(viewer: Viewer): Promise<{ ok: true; value: RestoreStatus } | { ok: false; rule: 'R16'; code: 'role' }> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const subject = `network:${viewer.networkId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'base_restore', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const expectedMonth = expectedRestoreMonth(this.now());
    // Un reçu daté dans le futur (une horloge fausse) ne se réécrit pas : il ne doit jamais cacher les vrais.
    const latest = await this.db.first<ReceiptRow>('SELECT * FROM base_restore_receipts WHERE tested_at <= ? ORDER BY tested_at DESC LIMIT 1', [this.now().toISOString()]);
    const current = latest && latest.month >= expectedMonth ? latest : null;
    const state: RestoreState = !current ? 'manquant' : current.outcome === 'reussie' ? 'reussi' : 'echec';
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor, subject, data: { kind: 'base_restore' } }, this.now);
    return { ok: true, value: { state, expectedMonth, receipt: latest ? toReceipt(latest) : null } };
  }
}

export const RESTORE_WATCH_JOB = 'sauvegarde.surveillance_restauration';

/** AU109 · Le passage du planificateur : de 6 h à 8 h, chaque jour ; l'alerte d'un mois ne se lève qu'une fois. */
export function restoreWatchJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob {
  return {
    name: RESTORE_WATCH_JOB,
    hours: [6, 7, 8],
    run: async () => {
      await new RecusRestauration(db, journal, options).watch();
    },
  };
}
