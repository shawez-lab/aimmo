/**
 * Les routes du stock de panneaux (HX14), sous `/v1/panneaux` (BR23).
 *
 * Chaque route dit les rôles qu'elle admet, contrôlés avant toute lecture du corps ; un refus est écrit au journal [R16].
 * La direction ajoute des panneaux au stock, numérotés par le code [R282] ; l'agent du bien en activité ou la direction
 * pose un panneau sur un bien diffusable, à son adresse [R282, R42], et le dit récupéré ou perdu [R283] ; chacun lit le
 * stock, l'agent ses seules poses [R284]. Rien n'est envoyé. Un champ non prévu : 400 `unknown_field`.
 */
import { Diffusion, type Acces, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';
import { Panneaux } from '../../core/src/panneaux/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 4_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface PanneauxServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface PanneauxRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: PanneauxServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule?: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, rule = null, ...rest } = result;
  if (/^unknown/.test(result.code)) return json(404, { ok: false, rule, ...rest });
  if (rule === 'R16') return json(403, { ok: false, rule, ...rest });
  return json(rule ? 409 : 400, { ok: false, rule, ...rest });
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

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });

/** Le refus d'un rôle, écrit au journal comme ceux de la couche métier, avant que le corps soit lu [R16]. */
async function refuseRole(s: PanneauxServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'panneaux', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

/** Le stock du réseau, avec la porte de diffusion de D05 : un panneau est une publicité [R42]. */
const panneaux = (s: PanneauxServices) => {
  const diffusion = new Diffusion(s.db, s.acces, s.journal, { now: s.now });
  return new Panneaux(s.db, s.acces, { canDiffuse: (networkId, propertyId, at) => diffusion.canDiffuse(networkId, propertyId, at) }, s.journal, { now: s.now });
};

type Role = 'agent' | 'direction';

/** Les routes de `/v1/panneaux`, à ajouter à celles de `app.ts`. */
export function panneauxRoutes(): PanneauxRoute[] {
  /** Le rôle d'abord ; puis seulement le corps, avec ses champs prévus. */
  const withBody =
    (roles: readonly Role[], fields: readonly string[], fn: (s: PanneauxServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Outcome>): PanneauxRoute['handle'] =>
    async (s, v, params, request) => {
      if (!(roles as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      const body = await readJson(request);
      if (!body) return badBody();
      const extra = Object.keys(body).find((k) => !fields.includes(k));
      if (extra !== undefined) return json(400, { ok: false, rule: null, code: 'unknown_field', field: extra });
      return reply(await fn(s, v, params, body));
    };
  const only =
    (roles: readonly Role[], fn: (s: PanneauxServices, v: Viewer, params: string[]) => Promise<Outcome>): PanneauxRoute['handle'] =>
    async (s, v, params) =>
      (roles as readonly string[]).includes(String(v.role)) ? reply(await fn(s, v, params)) : refuseRole(s, v);
  const BOTH: readonly Role[] = ['agent', 'direction'];

  return [
    {
      method: 'GET',
      pattern: /^\/panneaux$/,
      name: 'panneaux.stock',
      handle: only(BOTH, async (s, v) => {
        const r = await panneaux(s).stock(v);
        return r.ok ? { ok: true, value: { counts: r.counts, placed: r.placed } } : r;
      }),
    },
    {
      method: 'POST',
      pattern: /^\/panneaux\/stock$/,
      name: 'panneaux.ajouter',
      handle: withBody(['direction'], ['size', 'count'], async (s, v, _p, b) => {
        const r = await panneaux(s).addToStock(v, b.size, b.count ?? 1);
        return r.ok ? { ok: true, value: { numbers: r.numbers } } : r;
      }),
    },
    {
      method: 'GET',
      pattern: /^\/panneaux\/a-recuperer$/,
      name: 'panneaux.a_recuperer',
      handle: only(BOTH, async (s, v) => {
        const r = await panneaux(s).pickups(v);
        return r.ok ? { ok: true, value: r.stops } : r;
      }),
    },
    {
      method: 'POST',
      pattern: /^\/panneaux\/poses$/,
      name: 'panneaux.poser',
      handle: withBody(BOTH, ['signNumber', 'propertyId', 'address'], async (s, v, _p, b) => {
        const r = await panneaux(s).place(v, { signNumber: b.signNumber, propertyId: b.propertyId, address: b.address });
        return r.ok ? { ok: true, value: { placementId: r.placementId } } : r;
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/panneaux/poses/${ID}/retrait$`),
      name: 'panneaux.retirer',
      handle: withBody(BOTH, ['outcome'], async (s, v, [placementId], b) => {
        const r = await panneaux(s).remove(v, placementId!, b.outcome);
        return r.ok ? { ok: true, value: null } : r;
      }),
    },
  ];
}
