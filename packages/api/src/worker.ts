import { handleRequest } from './app.ts';
import { fromD1, type D1Database } from './d1.ts';

/** Liaisons du Worker, déclarées dans wrangler.toml ; `API_KEYS` est un secret Cloudflare. */
export interface Env {
  DB: D1Database;
  API_KEYS?: string;
  MODE?: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, { db: fromD1(env.DB), apiKeys: env.API_KEYS, mode: env.MODE });
  },
};
