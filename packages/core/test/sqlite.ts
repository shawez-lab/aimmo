// Accès à node:sqlite pour les tests. Sur GitHub, sous Node 22, il est obligatoire.
// Ailleurs, par exemple chez Codex sans Node 22, les tests SQLite sont sautés au lieu d'échouer.
import { createRequire } from 'node:module';
import { describe } from 'vitest';

export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const require = createRequire(import.meta.url);

function loadSqlite(): SqliteModule | null {
  try {
    return require('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

export const sqlite = loadSqlite();
export const sqliteRequired = process.env.GITHUB_ACTIONS === 'true';
export const describeWithSqlite = sqlite || sqliteRequired ? describe : describe.skip;

export function openMemoryDatabase(): SqliteDatabase {
  if (!sqlite) throw new Error('node:sqlite manque : il faut Node 22.5 ou plus.');
  return new sqlite.DatabaseSync(':memory:');
}
