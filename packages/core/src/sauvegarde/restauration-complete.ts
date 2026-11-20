/**
 * La restauration complète : la base et ses fichiers, puis le registre des effacements rejoué par le véritable effaceur
 * (AU021) [R231, R224, R17].
 *
 * Constat de l'audit A021 : le registre des effacements savait se rejouer, mais rien ne raccordait le véritable effaceur
 * (`SqlPersonEraser`, AU020) à une restauration qui rend aussi les fichiers. `restoreWithErasures` ne restaure que la
 * base, et l'exercice de restauration (`restoreExercise`) rend la base et les fichiers sans rien rejouer : restaurer une
 * copie prise avant un effacement faisait revenir les appels, les pièces et les enregistrements d'une personne effacée.
 *
 * Décidé, lecture prudente :
 * - la base et les fichiers viennent de la même copie, dans une base neuve et des stockages neufs, chacun relu contre son
 *   empreinte (`restoreExercise`) ; rien n'est rejoué tant que la copie n'est pas prouvée identique ;
 * - le rejeu passe par le véritable effaceur, avec les stockages restaurés : une ligne effacée emporte ses fichiers que
 *   plus rien ne cite, jamais un fichier qu'une autre personne cite encore, jamais le coffre gardé 5 ans ;
 * - un effaceur qui ne sait pas retirer un fichier des stockages restaurés ne se donne pas : sans `remove` sur chacun des
 *   quatre stockages, rien n'est restauré ;
 * - une entrée illisible, une ligne qui reste, un fichier qui reste : la restauration n'est pas dite finie, et la base et
 *   les stockages restent à jeter. Passer une base restaurée en production reste un geste humain (`docs/SAUVEGARDE.md`).
 */
import { SqlPersonEraser, type ObjectEraser } from '../conformite/effacement-reel.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { CopyKey, RestoreOutcome } from './copie.ts';
import { replayErasures, type ErasureLedgerStore, type PersonEraser } from './effacements.ts';
import { fileReferences, OBJECT_STORAGES, restoreExercise, type ObjectsOutcome, type ObjectStorage, type ObjectTarget, type ReferenceReader } from './objets.ts';

/** Un stockage neuf où restaurer, qui sait aussi retirer un fichier pour le rejeu ; sans effet s'il n'y est plus. */
export interface ErasableTarget extends ObjectTarget {
  remove(key: string): Promise<void>;
}

export type CompleteRestoreOutcome =
  | { ok: true; takenAt: string; tables: number; rows: number; objects: number; erasuresReplayed: number; erasedRows: number }
  | { ok: false; part: 'base'; code: Exclude<RestoreOutcome, { ok: true }>['code'] }
  | { ok: false; part: 'objets'; code: Exclude<ObjectsOutcome, { ok: true }>['code'] }
  | { ok: false; part: 'effacements'; code: 'ledger_unreadable' | 'erase_failed'; replayed: number };

export interface CompleteRestoreInput {
  /** Une base neuve. */
  target: SqlDatabase;
  /** Un stockage neuf par sorte de fichier, chacun capable de retirer un fichier. */
  targets: Partial<Record<ObjectStorage, ErasableTarget | null>>;
  /** Le compartiment des copies, qui garde aussi le registre des effacements. */
  store: ErasureLedgerStore;
  key: CopyKey;
  copyId: string;
  /** Le lecteur des fichiers cités par la base ; celui de la copie par défaut. */
  references?: ReferenceReader;
  /** Pour les tests seulement : un autre effaceur que le véritable, construit avec l'effaceur des stockages restaurés. */
  eraserFor?: (objects: ObjectEraser) => PersonEraser;
  clock?: () => number;
  now?: () => Date;
}

/**
 * Restaure base et fichiers d'une copie, puis refait chaque effacement noté depuis elle, avec le véritable effaceur sur
 * les stockages restaurés. Sans le rejeu entier, rien n'est dit restauré [R231].
 */
export async function restoreEverything(input: CompleteRestoreInput): Promise<CompleteRestoreOutcome> {
  // Un stockage sans retrait laisserait les fichiers d'une personne effacée : refusé avant toute écriture.
  for (const name of OBJECT_STORAGES) {
    const t = input.targets[name];
    if (!t || typeof t.remove !== 'function') return { ok: false, part: 'objets', code: 'storage_missing' };
  }
  const targets = input.targets as Record<ObjectStorage, ErasableTarget>;
  const exercise = await restoreExercise({
    target: input.target,
    targets,
    store: input.store,
    key: input.key,
    copyId: input.copyId,
    references: input.references ?? fileReferences,
    ...(input.clock ? { clock: input.clock } : {}),
  });
  if (!exercise.ok && exercise.part === 'base') return { ok: false, part: 'base', code: exercise.base.code };
  if (!exercise.ok) return { ok: false, part: 'objets', code: exercise.objects.code };
  const objects: ObjectEraser = { remove: (storage, key) => targets[storage].remove(key) };
  const eraser = input.eraserFor ? input.eraserFor(objects) : new SqlPersonEraser({ objects });
  const replay = await replayErasures(input.target, input.store, input.key, eraser, { copyTakenAt: exercise.base.takenAt, ...(input.now ? { now: input.now } : {}) });
  if (!replay.ok) return { ok: false, part: 'effacements', code: replay.code, replayed: replay.replayed };
  return { ok: true, takenAt: exercise.base.takenAt, tables: exercise.base.tables, rows: exercise.base.rows, objects: exercise.objects.objects, erasuresReplayed: replay.replayed, erasedRows: replay.erasedRows };
}
