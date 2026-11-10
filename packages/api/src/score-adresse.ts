/**
 * Les routes du score de vente par adresse (HX17), sous `/v1/score-adresse` (BR27).
 *
 * Chaque route dit les rôles qu'elle admet, contrôlés avant toute lecture du corps ; un refus est écrit au journal [R16].
 * L'agent en activité note une adresse avec numéro d'une commune de ses zones, sans civilité ni nom [R292] : chaque point
 * du score cite sa donnée publique, sa source et sa date, et le score du jour est rangé une fois par adresse [R291].
 * L'agent (ses zones) et la direction (tout le réseau) lisent les scores et la mesure par tranche ; l'agent du mandat ou
 * la direction relie un mandat signé à une adresse notée [R293]. Les sources publiques ne servent qu'à noter : sans
 * elles, rien n'est rangé. Un champ ou un paramètre non prévu : 400 `unknown_field`. Rien n'est envoyé.
 */
import type { JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';
import { ScoreAdresse, type ScoreServices } from '../../core/src/score-adresse/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 2_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface ScoreAdresseServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** Le géocodage, le cadastre, les diagnostics et les ventes publiées ; absents, aucune adresse ne se note. */
  sources: ScoreServices | null;
}

export interface ScoreAdresseRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: ScoreAdresseServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule?: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
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
async function refuseRole(s: ScoreAdresseServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'score_adresse', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

/** Les sources ne sont lues que pour noter une adresse. */
const scores = (s: ScoreAdresseServices) => new ScoreAdresse(s.db, s.sources, s.journal, { now: s.now });

type Role = 'agent' | 'direction';

/** Aucun paramètre de requête n'est prévu : le premier venu est refusé. */
function extraQuery(request: Request): string | null {
  for (const k of new URL(request.url).searchParams.keys()) return k;
  return null;
}

/** Les routes de `/v1/score-adresse`, à ajouter à celles de `app.ts`. */
export function scoreAdresseRoutes(): ScoreAdresseRoute[] {
  /** Le rôle d'abord ; puis seulement le corps, avec ses champs prévus. */
  const withBody =
    (roles: readonly Role[], fields: readonly string[], fn: (s: ScoreAdresseServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Outcome>): ScoreAdresseRoute['handle'] =>
    async (s, v, params, request) => {
      if (!(roles as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      const extra = extraQuery(request);
      if (extra !== null) return json(400, { ok: false, rule: null, code: 'unknown_field', field: extra });
      const body = await readJson(request);
      if (!body) return badBody();
      const field = Object.keys(body).find((k) => !fields.includes(k));
      if (field !== undefined) return json(400, { ok: false, rule: null, code: 'unknown_field', field });
      return reply(await fn(s, v, params, body));
    };
  /** Le rôle d'abord ; aucun paramètre de requête. */
  const reading =
    (roles: readonly Role[], fn: (s: ScoreAdresseServices, v: Viewer) => Promise<Outcome>): ScoreAdresseRoute['handle'] =>
    async (s, v, _params, request) => {
      if (!(roles as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      const extra = extraQuery(request);
      if (extra !== null) return json(400, { ok: false, rule: null, code: 'unknown_field', field: extra });
      return reply(await fn(s, v));
    };
  const AGENT: readonly Role[] = ['agent'];
  const BOTH: readonly Role[] = ['agent', 'direction'];

  return [
    {
      method: 'POST',
      pattern: /^\/score-adresse\/scores$/,
      name: 'score_adresse.noter',
      handle: withBody(AGENT, ['address'], async (s, v, _p, b) => scores(s).score(v, { address: b.address })),
    },
    {
      method: 'GET',
      pattern: /^\/score-adresse\/scores$/,
      name: 'score_adresse.liste',
      handle: reading(BOTH, async (s, v) => {
        const r = await scores(s).list(v);
        return r.ok ? { ok: true, value: r.scores } : r;
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/score-adresse/scores/${ID}/mandat$`),
      name: 'score_adresse.relier_mandat',
      handle: withBody(BOTH, ['mandateId'], async (s, v, [scoreId], b) => {
        if (typeof b.mandateId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.mandateId)) return { ok: false, rule: null, code: 'bad_mandate' };
        const r = await scores(s).linkMandate(v, { scoreId: scoreId!, mandateId: b.mandateId });
        return r.ok ? { ok: true, value: null } : r;
      }),
    },
    {
      method: 'GET',
      pattern: /^\/score-adresse\/mesure$/,
      name: 'score_adresse.mesure',
      handle: reading(BOTH, async (s, v) => {
        const r = await scores(s).measure(v);
        return r.ok ? { ok: true, value: r.bands } : r;
      }),
    },
  ];
}
