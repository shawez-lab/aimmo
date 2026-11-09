/**
 * L'adresse du serveur MCP d'AIMMO (HX55), sous `/v1/mcp` (BR08).
 *
 * - `POST /v1/mcp` : JSON-RPC 2.0, avec la clé de portée « mcp » de l'agent, la seule qu'il confie à son assistant ; elle
 *   n'ouvre aucune autre route, et aucune autre clé n'ouvre celle-ci (contrôle du socle, `app.ts`). Le socle a déjà
 *   revérifié, pour cet appel, l'accès coupé, le départ et le dossier de l'agent [R16, R82] ; la couche métier revérifie
 *   ses droits sur chaque bien et chaque fiche, et écrit chaque appel et chaque refus au journal avant de rendre la
 *   moindre donnée [R590]. La direction, la conformité et les partenaires n'y ont aucun outil : refusés avant le corps.
 * - `GET /v1/mcp/brouillons` et `POST /v1/mcp/brouillons/<id>/decision` : l'agent lit ses brouillons et les valide ou
 *   les refuse lui-même, depuis l'application ; aucun outil MCP ne le fait [R591]. Ces deux routes n'admettent que la
 *   séance d'une clé d'appareil (BR06) : une clé d'API, que l'agent a pu confier à son assistant, y est refusée, pour
 *   qu'un assistant ne valide jamais ce qu'il a écrit, ni ne relise le texte d'une note [R590, R591].
 * - `POST /v1/mcp/public/<réseau>` : sans clé, le seul outil public, les biens que la diffusion autorise à l'instant
 *   même, tels que leur annonce publiée les décrit [R592]. Limité en débit par adresse et par réseau.
 *
 * Rien n'est envoyé, publié ni validé par le serveur.
 */
import { appendEvent, SqlJournalStore, type Acces, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { Referencement } from '../../core/src/attirer/index.ts';
import { Diffusion } from '../../core/src/documents/retractation.ts';
import { Brouillons, ServeurMcp, type JsonRpcResponse, type McpCaller } from '../../core/src/mcp/index.ts';
import { takeSlot } from './assistant.ts';
import { fromDeviceSession } from './cles.ts';
import { sha256Hex } from './auth.ts';

export const TRIAL_MODE = 'essai';
/** Une requête JSON-RPC tient en quelques ko : une note de brouillon fait 2 000 caractères au plus. */
const MAX_BODY_BYTES = 16_000;
const ID = '([A-Za-z0-9_-]{1,64})';
export const MCP_PUBLIC_PREFIX = '/v1/mcp/public/';

export interface McpServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

type Role = Viewer['role'];
const AGENT: readonly Role[] = ['agent'];

export interface McpRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  roles: readonly Role[];
  handle: (s: McpServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

async function readJson(request: Request): Promise<unknown | undefined> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return undefined;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Une réponse JSON-RPC ; une notification (sans identifiant) n'en attend aucune : 202, corps vide. */
const rpc = (response: JsonRpcResponse | null): Response => (response === null ? new Response(null, { status: 202, headers: HEADERS }) : json(200, response));
const parseError = (): Response => json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Corps JSON attendu.' } });

function server(s: McpServices): ServeurMcp {
  return new ServeurMcp({
    db: s.db,
    acces: s.acces,
    brouillons: new Brouillons(s.db, s.acces, s.journal, { now: s.now }),
    journal: s.journal,
    published: new Referencement(s.db, s.journal, { now: s.now, indexNow: null, mode: TRIAL_MODE }),
    gate: new Diffusion(s.db, s.acces, s.journal, { now: s.now }),
    now: s.now,
  });
}

type Outcome = { ok: true; value: unknown } | { ok: false; rule: string; code: string };
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value });
  if (result.rule === 'R16') return json(403, { ok: false, rule: result.rule, code: result.code });
  return json(result.rule ? 409 : 400, { ok: false, rule: result.rule, code: result.code });
}

/** Les routes de `/v1/mcp` sous clé, à ajouter à celles de `app.ts`. */
export function mcpRoutes(): McpRoute[] {
  const routes: McpRoute[] = [
    {
      method: 'POST',
      pattern: /^\/mcp$/,
      name: 'mcp.agent',
      roles: AGENT,
      handle: async (s, v, _p, request) => {
        const body = await readJson(request);
        if (body === undefined) {
          // Un corps illisible, d'un autre type ou trop gros est un refus : au journal, sans le corps [R590, R13].
          await appendEvent(s.journal, { type: 'mcp.refus', actor: `${String(v.role)}:${v.userId}`, subject: null, data: { rule: 'R590', code: 'parse_error' } }, s.now);
          return parseError();
        }
        const caller: McpCaller = { kind: 'agent', viewer: v };
        return rpc(await server(s).handle(caller, body));
      },
    },
    // L'agent lit ses brouillons, sans le contenu d'aucune fiche ; il les décide lui-même [R591].
    {
      method: 'GET',
      pattern: /^\/mcp\/brouillons$/,
      name: 'mcp.brouillons',
      roles: AGENT,
      handle: async (s, v) => reply(await new Brouillons(s.db, s.acces, s.journal, { now: s.now }).listOwn(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/mcp/brouillons/${ID}/decision$`),
      name: 'mcp.brouillons.decision',
      roles: AGENT,
      handle: async (s, v, [id], request) => {
        const body = await readJson(request);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, rule: null, code: 'invalid_body' });
        const b = body as Record<string, unknown>;
        if (Object.keys(b).some((k) => k !== 'decision')) return json(400, { ok: false, rule: null, code: 'unknown_field' });
        return reply(await new Brouillons(s.db, s.acces, s.journal, { now: s.now }).decide(v, id, b.decision));
      },
    },
  ];
  const APPLICATION_ONLY = new Set(['mcp.brouillons', 'mcp.brouillons.decision']);
  return routes.map((route) => ({
    ...route,
    handle: async (s, v, params, request) => {
      // La direction, la conformité et les partenaires n'ont aucun outil : refusés avant le corps, au journal [R590, R16].
      if (!route.roles.includes(v.role)) {
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R16', role: String(v.role), kind: route.name, code: 'role' } }, s.now);
        return json(403, { ok: false, rule: 'R16', code: 'role' });
      }
      if (APPLICATION_ONLY.has(route.name) && !fromDeviceSession(request)) {
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R591', role: String(v.role), kind: route.name, code: 'application_requise' } }, s.now);
        return json(403, { ok: false, rule: 'R591', code: 'application_requise', message: 'Depuis l’application seulement, avec la clé de cet appareil.' });
      }
      return route.handle(s, v, params, request);
    },
  }));
}

// ---------------------------------------------------------------- lecture publique

/** Les limites de la lecture publique, par heure. */
export interface McpPublicLimits {
  perIp: number;
  perNetwork: number;
}
export const DEFAULT_MCP_PUBLIC_LIMITS: McpPublicLimits = Object.freeze({ perIp: 120, perNetwork: 5000 });

/**
 * `POST /v1/mcp/public/<réseau>` : le serveur MCP sans agent, pour les assistants d'achat et les partenaires [R592].
 * `null` si l'adresse n'en est pas une.
 */
export async function handleMcpPublic(request: Request, s: { db: SqlDatabase; acces: Acces; now: () => Date; limits?: McpPublicLimits }): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(MCP_PUBLIC_PREFIX)) return null;
  const networkId = path.slice(MCP_PUBLIC_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(networkId) || !(await s.db.first('SELECT 1 FROM networks WHERE id = ?', [networkId]))) {
    return json(404, { ok: false, rule: null, code: 'not_found' });
  }
  if (request.method !== 'POST') return json(405, { ok: false, rule: null, code: 'method_not_allowed' });
  const limits = s.limits ?? DEFAULT_MCP_PUBLIC_LIMITS;
  const at = s.now();
  const ip = request.headers.get('cf-connecting-ip');
  if (ip && !(await takeSlot(s.db, networkId, `mcp_public_adresse:${await sha256Hex(`${ip}:${at.toISOString().slice(0, 13)}`)}`, limits.perIp, at))) {
    return json(429, { ok: false, rule: null, code: 'too_many_requests' });
  }
  if (!(await takeSlot(s.db, networkId, 'mcp_public:reseau', limits.perNetwork, at))) return json(429, { ok: false, rule: null, code: 'too_many_requests' });
  const body = await readJson(request);
  if (body === undefined) return parseError();
  const journal = new SqlJournalStore(s.db);
  return rpc(await server({ db: s.db, journal, acces: s.acces, now: s.now }).handle({ kind: 'public', networkId }, body));
}
