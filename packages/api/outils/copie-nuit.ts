/**
 * « Copie de nuit » (SV02), lancé par le travail GitHub du même nom, jamais par le Worker [R224, R230].
 *
 * Le travail photographie la base (`wrangler d1 export`), puis ce programme charge la photo dans une base SQLite neuve,
 * y prend la copie chiffrée, la range dans le compartiment, la restaure depuis lui dans une base jetable, et écrit le compte rendu
 * dans la base `aimmo`. Tout ce qui manque ou casse se dit « non sauvegardé », avec un code, jamais un faux succès.
 *
 * L'instant de la copie est celui d'avant la photo, donné par le travail : rien de plus récent n'y est, et le rejeu
 * des effacements part de cet instant-là [R231]. La sortie ne porte que des nombres et un code ; aucune erreur n'est
 * recopiée, elle pourrait citer une ligne [R13].
 *
 * Depuis AU019b, la copie prend aussi tous les objets des quatre stockages (photos, pièces, commerces, coffre), sous la
 * même date, et les relit depuis le compartiment contre leur empreinte. Sans clé de lecture des stockages, ou si un seul
 * ne se lit pas, la nuit est « non sauvegardée » : une base sans ses fichiers ne rend pas les dossiers [R224].
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  CopieBase,
  copyKeyFromSecret,
  copyObjects,
  OBJECT_STORAGES,
  ObjectCopyError,
  restoreObjects,
  verifyingTarget,
  fromSyncSqlite,
  MemoryJournalStore,
  recordCopyRun,
  restoreCopy,
  type CopyFailure,
  type CopyKey,
  type CopyRun,
  type CopyStore,
  type ObjectSource,
  type ObjectStorage,
  type ObjectTarget,
  type SqlDatabase,
  type SyncSqlite,
} from '@aimmo/core';
import { d1Rest } from './d1-rest.ts';
import { CopyStoreError, r2CopyStore, r2ObjectSource } from './r2-copies.ts';

export const COPIES_BUCKET = 'aimmo-copies';
const ID = /^[0-9a-f-]{36}$/;

export interface NightlyInput {
  secret: string;
  store: CopyStore | null;
  /** La photo chargée ; `null` si elle manque ou ne se charge pas. */
  snapshot: () => Promise<SqlDatabase | null>;
  startedAt: string;
  /** Une base neuve et jetable, où la copie prouve qu'elle se restaure. */
  fresh: () => SqlDatabase;
  record: (run: CopyRun) => Promise<void>;
  /** Les stockages d'objets à copier ; `null` si la clé de lecture manque. */
  objects: Partial<Record<ObjectStorage, ObjectSource | null>> | null;
  now?: () => Date;
}

type Attempt = { outcome: 'copiee'; copyId: string; tables: number; rows: number; parts: number; objects: number; bytes: number } | { outcome: 'non_sauvegardee'; reason: CopyFailure };

async function attempt(input: NightlyInput): Promise<Attempt> {
  const no = (reason: CopyFailure): Attempt => ({ outcome: 'non_sauvegardee', reason });
  if (input.secret === '') return no('cle_absente');
  let key: CopyKey;
  try {
    key = await copyKeyFromSecret(input.secret);
  } catch {
    return no('cle_invalide');
  }
  if (!input.store) return no('stockage_absent');
  const sources = input.objects;
  if (!sources || OBJECT_STORAGES.some((name) => !sources[name])) return no('stockage_absent');
  const snapshot = await input.snapshot().catch(() => null);
  if (!snapshot) return no('photo_absente');
  try {
    // Le journal de la photo reste celui de la photo : la copie n'y écrit rien.
    const receipt = await new CopieBase(snapshot, new MemoryJournalStore(), input.store, key, { now: () => new Date(input.startedAt) }).take();
    if (receipt.rows === 0) return no('photo_vide');
    // « Copiée » ne se dit qu'après une vraie restauration, relue depuis le stockage : un sommaire présent ne prouve rien.
    const proof = await restoreCopy(input.fresh(), input.store, key, receipt.copyId);
    if (!proof.ok) return no(proof.code === 'manifest_missing' || proof.code === 'part_missing' ? 'stockage_en_panne' : 'copie_non_restaurable');
    const files = await copyObjects(sources, input.store, key, receipt.copyId);
    // Chaque objet relu depuis le compartiment des copies et comparé à son empreinte, sans tout tenir en mémoire.
    const targets = Object.fromEntries(OBJECT_STORAGES.map((name) => [name, verifyingTarget()])) as Record<ObjectStorage, ObjectTarget>;
    const filesProof = await restoreObjects(targets, input.store, key, receipt.copyId);
    if (!filesProof.ok) {
      const lost = filesProof.code === 'objects_missing' || (filesProof.code === 'not_identical' && filesProof.problems.some((p) => p.kind === 'object_missing'));
      return no(lost ? 'stockage_en_panne' : 'copie_non_restaurable');
    }
    if (filesProof.objects !== files.objects) return no('copie_non_restaurable');
    return { outcome: 'copiee', copyId: receipt.copyId, tables: receipt.tables, rows: receipt.rows, parts: receipt.parts, objects: files.objects, bytes: files.bytes };
  } catch (error) {
    if (error instanceof ObjectCopyError) return no(error.code === 'storage_missing' ? 'stockage_absent' : 'copie_echouee');
    return no(error instanceof CopyStoreError ? 'stockage_en_panne' : 'copie_echouee');
  }
}

/** La copie de la nuit et son compte rendu. Rend le code de sortie : 0 seulement si tout est rangé et dit. */
export async function nightlyCopy(input: NightlyInput, out: (text: string) => void): Promise<number> {
  const result = await attempt(input);
  const now = input.now ?? (() => new Date());
  const id = crypto.randomUUID();
  const run: CopyRun =
    result.outcome === 'copiee'
      ? { id, startedAt: input.startedAt, finishedAt: now().toISOString(), outcome: 'copiee', copyId: result.copyId, tables: result.tables, rows: result.rows, parts: result.parts }
      : { id, startedAt: input.startedAt, finishedAt: now().toISOString(), ...result };
  let recorded = true;
  try {
    await input.record(run);
  } catch {
    recorded = false;
  }
  if (result.outcome === 'copiee') out(`Copie rangée : ${result.tables} tables, ${result.rows} lignes, ${result.parts} morceaux ; ${result.objects} fichiers, ${result.bytes} octets.`);
  else out(`Non sauvegardé : ${result.reason}.`);
  if (!recorded) out('Compte rendu non écrit : la direction verra une nuit sans copie.');
  return result.outcome === 'copiee' && recorded ? 0 : 1;
}

/** Charge une photo faite par `wrangler d1 export`. Garde-fous coupés : ils ne doivent pas juger des lignes anciennes. */
export function loadSnapshot(path: string, open: () => SyncSqlite & { exec(sql: string): unknown }): SqlDatabase | null {
  if (!existsSync(path)) return null;
  const sql = readFileSync(path, 'utf8');
  if (sql.trim() === '') return null;
  const db = open();
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(sql);
  db.exec('PRAGMA foreign_keys = ON');
  return fromSyncSqlite(db);
}

export function isoInstant(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
}

export function storeFromEnv(env: Record<string, string | undefined>): CopyStore | null {
  const accountId = (env['CLOUDFLARE_ACCOUNT_ID'] ?? '').trim();
  const accessKeyId = (env['COPIES_R2_ACCESS_KEY_ID'] ?? '').trim();
  const secretAccessKey = (env['COPIES_R2_SECRET_ACCESS_KEY'] ?? '').trim();
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return r2CopyStore({ accountId, bucket: COPIES_BUCKET, accessKeyId, secretAccessKey });
}

/** Les compartiments des objets, comme au déploiement (`scripts/liaisons-r2.mjs`). */
export const OBJECT_BUCKETS: Readonly<Record<ObjectStorage, string>> = Object.freeze({ MEDIA: 'aimmo-medias', PIECES: 'aimmo-pieces', COMMERCES: 'aimmo-commerces', COFFRE: 'aimmo-coffre' });

/** Les quatre stockages lus avec une clé en lecture seule (H76) ; `null` si elle manque : la nuit sera « non sauvegardée ». */
export function objectSourcesFromEnv(env: Record<string, string | undefined>): Record<ObjectStorage, ObjectSource> | null {
  const accountId = (env['CLOUDFLARE_ACCOUNT_ID'] ?? '').trim();
  const accessKeyId = (env['OBJETS_R2_ACCESS_KEY_ID'] ?? '').trim();
  const secretAccessKey = (env['OBJETS_R2_SECRET_ACCESS_KEY'] ?? '').trim();
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return Object.fromEntries(OBJECT_STORAGES.map((name) => [name, r2ObjectSource({ accountId, bucket: OBJECT_BUCKETS[name], accessKeyId, secretAccessKey, jurisdiction: 'eu' })])) as Record<ObjectStorage, ObjectSource>;
}

async function main(env: Record<string, string | undefined>, out: (text: string) => void): Promise<number> {
  const token = (env['CLOUDFLARE_API_TOKEN'] ?? '').trim();
  const accountId = (env['CLOUDFLARE_ACCOUNT_ID'] ?? '').trim();
  const databaseId = (env['COPIE_BASE_AIMMO'] ?? '').trim();
  const startedAt = isoInstant(env['COPIE_DEBUT']);
  if (!token || !accountId || !ID.test(databaseId) || !startedAt) {
    out('Non sauvegardé : le travail est mal réglé, et aucun compte rendu ne peut être écrit.');
    return 1;
  }
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => SyncSqlite & { exec(sql: string): unknown } };
  const aimmo = d1Rest({ accountId, databaseId, token });
  return nightlyCopy(
    {
      secret: (env['COPY_KEY'] ?? '').trim(),
      store: storeFromEnv(env),
      snapshot: async () => loadSnapshot(env['COPIE_PHOTO'] ?? '', () => new DatabaseSync(':memory:')),
      startedAt,
      fresh: () => fromSyncSqlite(new DatabaseSync(':memory:')),
      record: (run) => recordCopyRun(aimmo, run),
      objects: objectSourcesFromEnv(env),
    },
    out,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = (text: string): void => {
    console.log(text);
    if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `${text}\n`);
  };
  main(process.env, write).then(
    (code) => process.exit(code),
    () => {
      console.error('Non sauvegardé : erreur imprévue, non recopiée.');
      process.exit(1);
    },
  );
}
