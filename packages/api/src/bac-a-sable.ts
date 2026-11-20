import type { SqlDatabase, SqlStatement, SqlValue, reseau } from '@aimmo/core';

/**
 * AU025 · Le stockage à part du bac à sable, dans le Worker.
 *
 * Chaque agent a sa propre base : une base SQLite d'objet durable Cloudflare, nommée d'après lui, jamais la base D1 du
 * réseau. À sa première ouverture, elle reçoit une copie du schéma de la base du réseau, et seulement le schéma : les
 * tables, index, vues et déclencheurs, aucune ligne. Le bac à sable tourne ainsi sur l'outil réel tel qu'il est en
 * service, sans aucune donnée réelle [R82]. Les types de Cloudflare sont décrits ici, au plus juste, pour que tout se
 * teste sous Node.
 */

/** Ce qu'il faut de `ctx.storage.sql` d'un objet durable adossé à SQLite. */
export interface DurableSqlCursor {
  toArray(): Record<string, SqlValue>[];
}
export interface DurableSql {
  exec(query: string, ...bindings: SqlValue[]): DurableSqlCursor;
}
export interface DurableStateLike {
  storage: { sql: DurableSql; transactionSync<T>(fn: () => T): T };
}

/** Ce qu'il faut d'une liaison d'objets durables. */
export interface DurableStubLike {
  fetch(request: Request): Promise<Response>;
}
export interface DurableNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableStubLike;
}

/** La marque d'une base dont le schéma est copié : une table du bac à sable seulement. */
const READY_TABLE = 'bac_a_sable_schema';
const ORDER: Record<string, number> = { table: 0, index: 1, view: 2, trigger: 3 };

/**
 * Le schéma de la base du réseau, sans aucune ligne : tables, puis index, vues et déclencheurs, chacun dans l'ordre de
 * sa création. Les objets internes de SQLite, de D1 et de Cloudflare sont laissés.
 */
export async function schemaStatements(db: SqlDatabase): Promise<string[]> {
  const rows = await db.all<{ type: string; name: string; sql: string | null; n: number }>(
    "SELECT type, name, sql, rowid AS n FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index', 'view', 'trigger') ORDER BY rowid",
  );
  return rows
    .filter((r) => !/^(sqlite_|_cf_|d1_)/i.test(r.name) && r.name !== READY_TABLE)
    .sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || a.n - b.n)
    .map((r) => r.sql!);
}

type Op =
  | { op: 'ready' }
  | { op: 'init'; statements: string[] }
  | { op: 'exec'; sql: string }
  | { op: 'run' | 'all' | 'first'; sql: string; params: SqlValue[] }
  | { op: 'batch'; statements: { sql: string; params: SqlValue[] }[] };

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * L'objet durable d'un bac à sable : une base SQLite à un seul agent. Il n'a aucune liaison, aucun canal, aucune
 * sortie : il ne répond qu'au Worker, par sa liaison, jamais à une adresse publique.
 */
export class BacASableBase {
  private readonly sql: DurableSql;
  private readonly transaction: <T>(fn: () => T) => T;

  constructor(state: DurableStateLike, _env?: unknown) {
    this.sql = state.storage.sql;
    this.transaction = (fn) => state.storage.transactionSync(fn);
  }

  private changes(): number {
    return Number(this.sql.exec('SELECT changes() AS n').toArray()[0]?.n ?? 0);
  }

  private run(sql: string, params: readonly SqlValue[]): { changes: number } {
    this.sql.exec(sql, ...params).toArray();
    return { changes: this.changes() };
  }

  private ready(): boolean {
    return this.sql.exec("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", READY_TABLE).toArray().length > 0;
  }

  async fetch(request: Request): Promise<Response> {
    let op: Op;
    try {
      op = (await request.json()) as Op;
    } catch {
      return reply(400, { error: 'bad_request' });
    }
    try {
      switch (op.op) {
        case 'ready':
          return reply(200, { ready: this.ready() });
        case 'init':
          // Une seule fois, d'un bloc : une copie à moitié faite n'est jamais gardée.
          this.transaction(() => {
            if (this.ready()) return;
            for (const statement of op.statements) this.sql.exec(statement).toArray();
            this.sql.exec(`CREATE TABLE ${READY_TABLE} (copied_at TEXT NOT NULL)`).toArray();
            this.sql.exec(`INSERT INTO ${READY_TABLE} (copied_at) VALUES (?)`, new Date().toISOString()).toArray();
          });
          return reply(200, { ready: true });
        case 'exec':
          this.sql.exec(op.sql).toArray();
          return reply(200, {});
        case 'run':
          return reply(200, this.run(op.sql, op.params));
        case 'all':
          return reply(200, { rows: this.sql.exec(op.sql, ...op.params).toArray() });
        case 'first':
          return reply(200, { row: this.sql.exec(op.sql, ...op.params).toArray()[0] ?? null });
        case 'batch':
          return reply(200, { results: this.transaction(() => op.statements.map((s) => this.run(s.sql, s.params))) });
        default:
          return reply(400, { error: 'bad_request' });
      }
    } catch (error) {
      return reply(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** La base d'un bac à sable vue du Worker : chaque requête part à l'objet durable de l'agent, et à lui seul. */
function remoteDatabase(stub: DurableStubLike): SqlDatabase & { call<T>(op: Op): Promise<T> } {
  const call = async <T>(op: Op): Promise<T> => {
    const res = await stub.fetch(new Request('https://bac-a-sable.invalid/sql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op) }));
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`Bac à sable : ${body.error ?? res.status}`);
    return body;
  };
  return {
    call,
    async exec(sql) {
      await call({ op: 'exec', sql });
    },
    async run(sql, params = []) {
      return call<{ changes: number }>({ op: 'run', sql, params: [...params] });
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return (await call<{ rows: T[] }>({ op: 'all', sql, params: [...params] })).rows;
    },
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      return (await call<{ row: T | null }>({ op: 'first', sql, params: [...params] })).row;
    },
    async batch(statements: readonly SqlStatement[]) {
      return (await call<{ results: { changes: number }[] }>({ op: 'batch', statements: statements.map((s) => ({ sql: s.sql, params: [...(s.params ?? [])] })) })).results;
    },
  };
}

/**
 * Le stockage des bacs à sable du Worker : l'objet durable nommé d'après l'agent, toujours le même pour lui, jamais
 * celui d'un autre. Sa première ouverture y copie le schéma de la base du réseau, sans aucune ligne.
 */
export class DurableSandboxStorage implements reseau.SandboxStorage {
  constructor(
    private readonly namespace: DurableNamespaceLike,
    private readonly network: SqlDatabase,
  ) {}

  async open(agentId: string): Promise<SqlDatabase> {
    const db = remoteDatabase(this.namespace.get(this.namespace.idFromName(`agent:${agentId}`)));
    if (!(await db.call<{ ready: boolean }>({ op: 'ready' })).ready) {
      await db.call({ op: 'init', statements: await schemaStatements(this.network) });
    }
    return db;
  }
}
