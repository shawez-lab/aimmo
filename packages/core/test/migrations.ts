// Lit les migrations de db/migrations pour les tests.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Migration } from '../src/db/migrations.ts';

export const migrationsDir = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

let before: string | null = null;
let kept: readonly string[] = [];

/**
 * Pour un test de migration seulement : les jeux montés pendant `fn` s'arrêtent avant la migration `id`. `keep` garde
 * des migrations plus récentes, sans lien avec celle que le test éprouve, dont le code actuel du jeu a besoin.
 */
export async function withMigrationsBefore<T>(id: string, fn: () => Promise<T>, keep: readonly string[] = []): Promise<T> {
  before = id;
  kept = keep;
  try {
    return await fn();
  } finally {
    before = null;
    kept = [];
  }
}

export function loadMigrations(): Migration[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .filter((file) => before === null || file < before || kept.includes(file.replace(/\.sql$/, '')))
    .sort()
    .map((file) => ({ id: file.replace(/\.sql$/, ''), sql: readFileSync(migrationsDir + file, 'utf8') }));
}
