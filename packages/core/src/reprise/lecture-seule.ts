import type { SqlDatabase } from '../db/sql.ts';

const READ = /^\s*(?:SELECT|WITH)\b/i;
// Même dans une lecture, rien qui écrive, ni deux instructions à la suite.
const WRITE = /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b|;\s*\S/i;

/**
 * Une base qu'on ne peut que lire. Sert à reprendre les données d'un autre système, la base du site par exemple,
 * sans jamais y écrire : toute autre instruction qu'une lecture échoue avant d'atteindre la base.
 */
export function readOnly(db: SqlDatabase): SqlDatabase {
  const check = (sql: string): void => {
    if (!READ.test(sql) || WRITE.test(sql)) throw new Error('Base en lecture seule : seules les lectures sont permises.');
  };
  return {
    async exec() {
      throw new Error('Base en lecture seule : seules les lectures sont permises.');
    },
    async run() {
      throw new Error('Base en lecture seule : seules les lectures sont permises.');
    },
    async all<T>(sql: string, params?: readonly (string | number | null)[]) {
      check(sql);
      return db.all<T>(sql, params);
    },
    async first<T>(sql: string, params?: readonly (string | number | null)[]) {
      check(sql);
      return db.first<T>(sql, params);
    },
  };
}
