// Lit les migrations de db/migrations pour les tests.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Migration } from '../src/db/migrations.ts';

export const migrationsDir = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

let before: string | null = null;

/** Pour un test de migration seulement : les jeux montés pendant `fn` s'arrêtent avant la migration `id`. */
export async function withMigrationsBefore<T>(id: string, fn: () => Promise<T>): Promise<T> {
  before = id;
  try {
    return await fn();
  } finally {
    before = null;
  }
}

export function loadMigrations(): Migration[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .filter((file) => before === null || file < before)
    .sort()
    .map((file) => ({ id: file.replace(/\.sql$/, ''), sql: readFileSync(migrationsDir + file, 'utf8') }));
}
