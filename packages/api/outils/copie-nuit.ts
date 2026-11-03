/**
 * « Copie de nuit » (SV02), lancé par le travail GitHub du même nom, jamais par le Worker [R224, R230].
 *
 * Le travail photographie la base (`wrangler d1 export`), puis ce programme charge la photo dans une base SQLite neuve,
 * y prend la copie chiffrée, la range dans le compartiment, vérifie que le sommaire s'y relit, et écrit le compte rendu
 * dans la base `aimmo`. Tout ce qui manque ou casse se dit « non sauvegardé », avec un code, jamais un faux succès.
 *
 * L'instant de la copie est celui d'avant la photo, donné par le travail : rien de plus récent n'y est, et le rejeu
 * des effacements part de cet instant-là [R231]. La sortie ne porte que des nombres et un code ; aucune erreur n'est
 * recopiée, elle pourrait citer une ligne [R13].
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  CopieBase,
  copyKeyFromSecret,
  fromSyncSqlite,
  manifestPlace,
  MemoryJournalStore,
  recordCopyRun,
  type CopyFailure,
  type CopyKey,
  type CopyRun,
  type CopyStore,
  type SqlDatabase,
  type SyncSqlite,
} from '@aimmo/core';
import { d1Rest } from './d1-rest.ts';
import { CopyStoreError, r2CopyStore } from './r2-copies.ts';

export const COPIES_BUCKET = 'aimmo-copies';
const ID = /^[0-9a-f-]{36}$/;

export interface NightlyInput {
  secret: string;
  store: CopyStore | null;
  /** La photo chargée ; `null` si elle manque ou ne se charge pas. */
  snapshot: () => Promise<SqlDatabase | null>;
  startedAt: string;
  record: (run: CopyRun) => Promise<void>;
  now?: () => Date;
}

type Attempt = { outcome: 'copiee'; copyId: string; tables: number; rows: number; parts: number } | { outcome: 'non_sauvegardee'; reason: CopyFailure };

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
  const snapshot = await input.snapshot().catch(() => null);
  if (!snapshot) return no('photo_absente');
  try {
    // Le journal de la photo reste celui de la photo : la copie n'y écrit rien.
    const receipt = await new CopieBase(snapshot, new MemoryJournalStore(), input.store, key, { now: () => new Date(input.startedAt) }).take();
    if (receipt.rows === 0) return no('photo_vide');
    // Un stockage qui répond oui sans ranger ne fait pas une copie.
    if (!(await input.store.get(manifestPlace(receipt.copyId)))) return no('stockage_en_panne');
    return { outcome: 'copiee', copyId: receipt.copyId, tables: receipt.tables, rows: receipt.rows, parts: receipt.parts };
  } catch (error) {
    return no(error instanceof CopyStoreError ? 'stockage_en_panne' : 'copie_echouee');
  }
}

/** La copie de la nuit et son compte rendu. Rend le code de sortie : 0 seulement si tout est rangé et dit. */
export async function nightlyCopy(input: NightlyInput, out: (text: string) => void): Promise<number> {
  const result = await attempt(input);
  const now = input.now ?? (() => new Date());
  const id = crypto.randomUUID();
  const run: CopyRun = { id, startedAt: input.startedAt, finishedAt: now().toISOString(), ...result };
  let recorded = true;
  try {
    await input.record(run);
  } catch {
    recorded = false;
  }
  if (result.outcome === 'copiee') out(`Copie rangée : ${result.tables} tables, ${result.rows} lignes, ${result.parts} morceaux.`);
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
      record: (run) => recordCopyRun(aimmo, run),
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
