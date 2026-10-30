// Une base D1 de test, posée sur node:sqlite, qui imite l'API des Workers : prepare, bind, run, all, first, exec.
import type { D1Database, D1PreparedStatement, D1Result } from '../src/d1.ts';
import type { SqliteDatabase } from '../../core/test/sqlite.ts';

type Value = string | number | null;

const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

export function fakeD1(db: SqliteDatabase): D1Database {
  db.exec('PRAGMA foreign_keys = ON');
  type Statement = D1PreparedStatement & { sql: string; params: Value[] };
  const statement = (sql: string, params: Value[]): Statement => ({
    sql,
    params,
    bind: (...values) => statement(sql, values),
    async run(): Promise<D1Result<unknown>> {
      const result = db.prepare(sql).run(...params) as { changes?: number | bigint };
      return { results: [], meta: { changes: Number(result.changes ?? 0) } };
    },
    async all<T>(): Promise<D1Result<T>> {
      return { results: db.prepare(sql).all(...params).map((row) => plain<T>(row)), meta: { changes: 0 } };
    },
    async first<T>(): Promise<T | null> {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? null : plain<T>(row);
    },
  });
  return {
    prepare: (sql) => statement(sql, []),
    async exec(sql) {
      db.exec(sql);
      return { count: 1 };
    },
    // Comme D1 : un lot est une transaction, tout ou rien.
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = statements.map((s) => {
          const { sql, params } = s as Statement;
          const result = db.prepare(sql).run(...params) as { changes?: number | bigint };
          return { results: [], meta: { changes: Number(result.changes ?? 0) } };
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
