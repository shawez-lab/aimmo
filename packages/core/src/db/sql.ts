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
  /**
   * Exécute plusieurs écritures en un seul lot, tout ou rien : si l'une échoue, aucune n'est gardée. Rend le nombre de
   * lignes changées par chacune. Facultative pour les bases de test faites à la main : `runBatch` la remplace alors
   * par des écritures l'une après l'autre.
   */
  batch?(statements: readonly SqlStatement[]): Promise<{ changes: number }[]>;
}

export interface SqlStatement {
  sql: string;
  params?: readonly SqlValue[];
}

/** Le lot de la base s'il existe (tout ou rien), sinon les écritures l'une après l'autre. */
export async function runBatch(db: SqlDatabase, statements: readonly SqlStatement[]): Promise<{ changes: number }[]> {
  if (db.batch) return db.batch(statements);
  const out: { changes: number }[] = [];
  for (const s of statements) out.push(await db.run(s.sql, s.params ?? []));
  return out;
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
    // Tout se passe sans rendre la main : aucune autre requête ne s'intercale dans la transaction.
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = statements.map((s) => {
          const result = db.prepare(s.sql).run(...(s.params ?? [])) as { changes?: number | bigint } | undefined;
          return { changes: Number(result?.changes ?? 0) };
        });
        db.exec('COMMIT');
        return out;
      } catch (error) {
        // SQLite a pu annuler la transaction lui-même : l'erreur d'origine reste celle qui remonte.
        try {
          db.exec('ROLLBACK');
        } catch {
          /* déjà annulée */
        }
        throw error;
      }
    },
  };
}
