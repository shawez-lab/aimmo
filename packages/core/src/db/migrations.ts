import type { SqlDatabase } from './sql.ts';

export interface Migration {
  /** Nom du fichier sans extension, par exemple `0001_fiche_client`. L'ordre suit ce nom. */
  id: string;
  sql: string;
}

const MIGRATION_ID = /^\d{4}_[a-z0-9_]+$/;

/**
 * Applique, dans l'ordre, les migrations pas encore passées. En production, `wrangler d1 migrations apply`
 * fait ce travail ; cette fonction sert aux tests et au travail en local. Elle se relance sans erreur.
 */
export async function applyMigrations(
  db: SqlDatabase,
  migrations: readonly Migration[],
  now: () => Date = () => new Date(),
): Promise<string[]> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const done = new Set(
    (await db.all<{ id: string }>('SELECT id FROM schema_migrations')).map((row) => row.id),
  );
  const applied: string[] = [];
  for (const migration of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!MIGRATION_ID.test(migration.id)) throw new Error(`Nom de migration invalide : ${migration.id}`);
    if (done.has(migration.id)) continue;
    await db.exec(migration.sql);
    await db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
      migration.id,
      now().toISOString(),
    ]);
    applied.push(migration.id);
  }
  return applied;
}
