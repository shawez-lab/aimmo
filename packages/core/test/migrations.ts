// Lit les migrations de db/migrations pour les tests.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Migration } from '../src/db/migrations.ts';

export const migrationsDir = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

export function loadMigrations(): Migration[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ id: file.replace(/\.sql$/, ''), sql: readFileSync(migrationsDir + file, 'utf8') }));
}
