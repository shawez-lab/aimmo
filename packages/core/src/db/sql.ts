/**
 * Une seule couche d'accès aux données, en SQL standard.
 * Asynchrone pour servir la même interface à Cloudflare D1 (S09) et à SQLite (tests, local).
 */
export type SqlValue = string | number | null;

export interface SqlDatabase {
  /** Exécute un script de plusieurs instructions, sans paramètres (migrations). */
  exec(sql: string): Promise<void>;
  /** Rend le nombre de lignes changées (`changes` sous node:sqlite, `meta.changes` sous D1). */
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
}

/** Ce qu'il faut d'une base synchrone de type `node:sqlite` `DatabaseSync`, sans l'importer. */
export interface SyncSqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): unknown;
    get(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
  };
}

/** Adapte une base `node:sqlite` à l'interface commune et active les clés étrangères, comme D1. */
export function fromSyncSqlite(db: SyncSqlite): SqlDatabase {
  db.exec('PRAGMA foreign_keys = ON');
  // node:sqlite rend des objets sans prototype : on les recopie en objets ordinaires.
  const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params = []) {
      const result = db.prepare(sql).run(...params) as { changes?: number | bigint } | undefined;
      return { changes: Number(result?.changes ?? 0) };
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return db.prepare(sql).all(...params).map((row) => plain<T>(row));
    },
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? null : plain<T>(row);
    },
  };
}
