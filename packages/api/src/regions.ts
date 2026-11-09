/**
 * Les routes de l'ouverture région par région (HX72, BR12), sous `/v1/regions`.
 *
 * Chaque route passe par les droits de la couche métier [R16] : la direction seule, tout autre rôle est refusé et le
 * refus écrit au journal. L'état est relu à chaque demande [R650, R652] ; une décision s'ajoute à la chaîne, jamais
 * ne la réécrit [R651, R653]. Ouvrir une région reste un geste de la direction, jamais automatique ; rien n'est envoyé.
 */
import type { JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { RegionsOuvertes } from '../../core/src/regions/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;

export interface RegionsServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

export interface RegionsRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais la région demandée. */
  name: string;
  handle: (s: RegionsServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string; until?: string };

/** 200 ; 403 pour un refus de droits ; 409 pour une règle (avec `until` quand l'attente a une fin) ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(403, { ok: false, ...rest });
  return json(result.rule ? 409 : 400, { ok: false, ...rest });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const regions = (s: RegionsServices) => new RegionsOuvertes(s.db, s.journal, { now: s.now });

/** Les routes de `/v1/regions`, à ajouter à celles de `app.ts`. */
export function regionsRoutes(): RegionsRoute[] {
  const P = '^/regions';
  return [
    // L'état des 18 régions, et si une nouvelle peut s'ouvrir maintenant, avec ses raisons [R650, R652].
    { method: 'GET', pattern: new RegExp(`${P}$`), name: 'regions.etat', handle: async (s, v) => reply(await regions(s).report(v)) },
    // Ouvrir ou fermer une région : une version s'ajoute à la chaîne [R651, R652].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/decision$`),
      name: 'regions.decision',
      handle: async (s, v, _params, request) => {
        // Les droits d'abord : un autre rôle est refusé et écrit au journal, même sans corps lisible [R16].
        if (v.role !== 'direction') return reply(await regions(s).decide(v, {}));
        const body = await readJson(request);
        if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
        return reply(await regions(s).decide(v, body));
      },
    },
    // La chaîne des décisions recomptée depuis la première ; la première version cassée est dite [R653].
    { method: 'GET', pattern: new RegExp(`${P}/verification$`), name: 'regions.verification', handle: async (s, v) => reply(await regions(s).verify(v)) },
  ];
}
