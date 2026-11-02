/**
 * Routes des accords notés par l'agent (AC01), branchées dans le socle (AC02) [R03, R202, R16].
 *
 *   POST /v1/fiches/<id>/accords                { purpose, channel, proof, givenAt } : note un accord, avec sa preuve
 *   POST /v1/fiches/<id>/accords/<id>/retrait   retire l'accord ; la ligne reste [R17]
 *
 * Le rôle est contrôlé avant de lire le corps, et son refus va au journal [R16]. Rien n'est envoyé d'ici.
 */
import { AccordsFiche, appendEvent, type AccordsResult, type Acces, type FicheClient, type JournalStore, type Viewer } from '@aimmo/core';

export const MAX_ACCORD_BODY_BYTES = 8 * 1024;
const ID = '([A-Za-z0-9_-]{1,64})';
const FIELDS = new Set(['purpose', 'channel', 'proof', 'givenAt']);
const ROLES: readonly Viewer['role'][] = ['agent', 'direction'];

export interface AccordsServices {
  store: FicheClient;
  acces: Acces;
  journal: JournalStore;
  now: () => Date;
}

export interface AccordsRoute {
  method: 'POST';
  pattern: RegExp;
  name: string;
  handle: (s: AccordsServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  if (Number(request.headers.get('content-length') ?? '0') > MAX_ACCORD_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_ACCORD_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function statusOf(rule: string | null, code: string): number {
  if (code === 'unknown' || code === 'unknown_consent') return 404;
  if (rule === 'R16') return 403;
  if (rule === 'R02' || rule === 'R03' || rule === 'R04') return 409;
  return 400;
}

function answer<T>(r: AccordsResult<T>): Response {
  // « essai » : noter un accord n'envoie rien, et rien ne part tant que le plan ne l'a pas mis en service [R26].
  return r.ok ? json(200, { ok: true, mode: 'essai', sent: false, data: r.value }) : json(statusOf(r.rule, r.code), { ok: false, rule: r.rule, code: r.code });
}

const core = (s: AccordsServices): AccordsFiche => new AccordsFiche(s.store, s.acces, s.journal, { now: s.now });

/** Le rôle d'abord, son refus au journal [R16] ; le corps n'est lu qu'ensuite. */
function guarded(handle: AccordsRoute['handle']): AccordsRoute['handle'] {
  return async (s, viewer, params, request) => {
    if (!ROLES.includes(viewer.role)) {
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), code: 'role' } }, s.now);
      return json(403, { ok: false, rule: 'R16', code: 'role' });
    }
    return handle(s, viewer, params, request);
  };
}

export function accordsRoutes(): AccordsRoute[] {
  return [
    {
      method: 'POST',
      pattern: new RegExp(`^/fiches/${ID}/accords$`),
      name: 'fiche.accord.note',
      handle: guarded(async (s, viewer, [id], request) => {
        const body = await readJson(request);
        if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body' });
        if (Object.keys(body).some((k) => !FIELDS.has(k))) return json(400, { ok: false, rule: null, code: 'unexpected_field' });
        return answer(await core(s).record(viewer, id!, body));
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/fiches/${ID}/accords/${ID}/retrait$`),
      name: 'fiche.accord.retrait',
      handle: guarded(async (s, viewer, [id, consentId]) => answer(await core(s).withdraw(viewer, id!, consentId!))),
    },
  ];
}
