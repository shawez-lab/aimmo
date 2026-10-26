import type { SqlDatabase, SqlValue } from '@aimmo/core';

/**
 * Ce qu'il faut de Cloudflare D1, décrit ici pour ne pas dépendre des types de Cloudflare.
 * Voir https://developers.cloudflare.com/d1/worker-api/
 */
export interface D1Result<T> {
  results?: T[];
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: SqlValue[]): D1PreparedStatement;
  run(): Promise<D1Result<unknown>>;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<unknown>;
}

/**
 * Adapte une base D1 à l'interface commune du cœur. Les clés étrangères sont toujours actives sous D1.
 * Les migrations passent par `wrangler d1 migrations apply`, jamais par le Worker.
 */
export function fromD1(d1: D1Database): SqlDatabase {
  const statement = (sql: string, params: readonly SqlValue[]): D1PreparedStatement =>
    params.length === 0 ? d1.prepare(sql) : d1.prepare(sql).bind(...params);
  return {
    async exec(sql) {
      await d1.exec(sql);
    },
    async run(sql, params = []) {
      const result = await statement(sql, params).run();
      return { changes: Number(result.meta?.changes ?? 0) };
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return (await statement(sql, params).all<T>()).results ?? [];
    },
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      return statement(sql, params).first<T>();
    },
  };
}
