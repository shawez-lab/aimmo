import type { SqlDatabase, SqlStatement, SqlValue } from '@aimmo/core';

/**
 * Une base D1 atteinte par l'API REST de Cloudflare (I05), pour un travail lancé hors du Worker : la reprise des
 * contacts. Voir https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
 *
 * Lecture prudente :
 * - seule une lecture est refaite après une panne passagère (429, 5xx, réseau) : une écriture refaite pourrait
 *   doubler ; elle échoue, et le travail relancé reprend où il en était ;
 * - un lot est envoyé en une seule requête (`batch`), tout ou rien comme dans le Worker ;
 * - aucun message d'erreur ne cite les paramètres, qui peuvent porter une donnée personnelle [R13].
 */
export interface D1RestConfig {
  accountId: string;
  databaseId: string;
  token: string;
  fetch?: typeof fetch;
  /** Attente avant de refaire une lecture, en millisecondes (par défaut 500, 1000, 2000…). */
  wait?: (ms: number) => Promise<void>;
  retries?: number;
}

interface D1RestResult {
  results?: unknown[];
  meta?: { changes?: number };
  success?: boolean;
}

interface D1RestResponse {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: D1RestResult[];
}

const READ = /^\s*(?:SELECT|WITH)\b/i;

/** Erreur de l'API D1 : seulement le statut HTTP et les codes de Cloudflare, jamais la requête ni ses valeurs. */
export class D1RestError extends Error {
  constructor(
    readonly status: number,
    readonly codes: number[],
  ) {
    super(`D1 : requête refusée (HTTP ${status}${codes.length ? `, codes ${codes.join(', ')}` : ''}).`);
    this.name = 'D1RestError';
  }
}

export function d1Rest(config: D1RestConfig): SqlDatabase {
  const doFetch = config.fetch ?? fetch;
  const wait = config.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = config.retries ?? 4;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/d1/database/${encodeURIComponent(config.databaseId)}/query`;

  async function post(body: unknown, retryable: boolean): Promise<D1RestResult[]> {
    for (let attempt = 0; ; attempt++) {
      let response: Response | null = null;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        response = null;
      }
      const passing = response === null || response.status === 429 || response.status >= 500;
      if (passing && retryable && attempt < retries) {
        await wait(500 * 2 ** attempt);
        continue;
      }
      if (response === null) throw new D1RestError(0, []);
      let parsed: D1RestResponse | null = null;
      try {
        parsed = (await response.json()) as D1RestResponse;
      } catch {
        parsed = null;
      }
      if (!response.ok || !parsed || parsed.success !== true || !Array.isArray(parsed.result)) {
        throw new D1RestError(response.status, (parsed?.errors ?? []).map((e) => Number(e.code)).filter((c) => Number.isFinite(c)));
      }
      return parsed.result;
    }
  }

  const one = async (sql: string, params: readonly SqlValue[]): Promise<D1RestResult> => {
    const [result] = await post({ sql, params: [...params] }, READ.test(sql));
    if (!result || result.success === false) throw new D1RestError(200, []);
    return result;
  };

  return {
    async exec() {
      // Les migrations passent par `wrangler d1 migrations apply`, jamais par ce travail.
      throw new Error('D1 : exec non permis ici.');
    },
    async run(sql, params = []) {
      return { changes: Number((await one(sql, params)).meta?.changes ?? 0) };
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return ((await one(sql, params)).results ?? []) as T[];
    },
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      const rows = (await one(sql, params)).results ?? [];
      return (rows[0] ?? null) as T | null;
    },
    async batch(statements: readonly SqlStatement[]) {
      if (statements.length === 0) return [];
      const all = statements.every((s) => READ.test(s.sql));
      const results = await post({ batch: statements.map((s) => ({ sql: s.sql, params: [...(s.params ?? [])] })) }, all);
      if (results.length !== statements.length || results.some((r) => r.success === false)) throw new D1RestError(200, []);
      return results.map((r) => ({ changes: Number(r.meta?.changes ?? 0) }));
    },
  };
}

/** Vérifie que l'API prend les lots avant toute écriture : sinon le travail s'arrête, rien n'est écrit. */
export async function checkBatch(db: SqlDatabase): Promise<void> {
  if (!db.batch) throw new Error('D1 : lot non pris en charge.');
  const out = await db.batch([{ sql: 'SELECT 1 AS un' }, { sql: 'SELECT 2 AS deux' }]);
  if (out.length !== 2) throw new Error('D1 : lot non pris en charge.');
}
