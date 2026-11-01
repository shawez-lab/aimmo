/**
 * Les routes de la reprise des contacts (I05), sous `/v1/reprise` : la direction dépose les trois fichiers de H15 depuis
 * l'écran du réseau, et lit où en est le lancement. Le lancement lui-même est un travail GitHub, jamais une requête du
 * Worker. Aucune réponse ni aucun journal ne recopie le contenu d'un fichier [R13] ; la direction seule y a droit [R16].
 */
import { DEPOT_MAX_BYTES, DepotsReprise, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';

export const TRIAL_MODE = 'essai';
/** Un fichier de 20 Mo au plus, et l'enveloppe JSON qui le porte. */
const MAX_BODY_BYTES = DEPOT_MAX_BYTES + 4_096;

export interface RepriseServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

export interface RepriseRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  handle: (s: RepriseServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value: unknown } | { ok: false; rule: string | null; code: string };
const reply = (r: Outcome): Response =>
  r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : json(r.rule === 'R16' ? 403 : r.code === 'file_too_large' ? 413 : 400, { ok: false, rule: r.rule, code: r.code });

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const depots = (s: RepriseServices): DepotsReprise => new DepotsReprise(s.db, s.journal, { now: s.now });

/** Les routes de la reprise, à ajouter à celles de `app.ts`. */
export function repriseRoutes(): RepriseRoute[] {
  return [
    {
      method: 'POST',
      pattern: /^\/reprise\/fichiers$/,
      name: 'reprise.depot',
      handle: async (s, v, _p, r) => {
        // Le rôle est vérifié avant de lire le corps : un autre rôle ne fait même pas lire son fichier.
        if (v.role !== 'direction') return reply(await depots(s).deposit(v, { tool: null, csv: null }));
        const body = await readJson(r);
        if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body' });
        if (Object.keys(body).some((k) => !['tool', 'csv', 'agentId'].includes(k))) return json(400, { ok: false, rule: null, code: 'unexpected_field' });
        return reply(await depots(s).deposit(v, { tool: body.tool, csv: body.csv, ...(body.agentId !== undefined ? { agentId: body.agentId } : {}) }));
      },
    },
    { method: 'GET', pattern: /^\/reprise\/etat$/, name: 'reprise.etat', handle: async (s, v) => reply(await depots(s).status(v)) },
  ];
}
