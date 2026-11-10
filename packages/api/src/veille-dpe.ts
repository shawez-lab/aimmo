/**
 * Les routes de la veille des nouveaux diagnostics énergétiques (HX16), sous `/v1/veille-dpe` (BR26).
 *
 * Chaque route dit les rôles qu'elle admet, contrôlés avant toute lecture du corps ; un refus est écrit au journal [R16].
 * L'agent en activité ouvre et ferme ses secteurs (une commune de ses zones en cours, avec son code postal), lit son
 * alerte du jour et prépare la lettre « Au propriétaire » d'un logement classé F ou G de sa zone [R289, R290] ; la carte
 * se lit par l'agent (ses zones) et par la direction (tout le réseau) ; la lettre s'imprime par l'agent qui l'a préparée
 * ou par la direction. Aucun nom de propriétaire n'est demandé ni rendu [R288]. Rien n'est envoyé : la lettre s'imprime.
 * Un champ non prévu : 400 `unknown_field`. Le passage de chaque jour est au planificateur (`dpeWatchJob`).
 */
import type { JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';
import { VeilleDpe } from '../../core/src/veille-dpe/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 2_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface VeilleDpeServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

export interface VeilleDpeRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: VeilleDpeServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });
const PRINT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  ...HEADERS,
};

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
async function refuseRole(s: VeilleDpeServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'veille_dpe', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

/** Les routes ne lisent que la base : la source de l'ADEME ne sert qu'au passage du planificateur. */
const veille = (s: VeilleDpeServices) => new VeilleDpe(s.db, null, s.journal, { now: s.now });

type Role = 'agent' | 'direction';

/** Les paramètres de la requête prévus, et eux seuls : un autre est refusé. */
function query(request: Request, allowed: readonly string[]): { ok: true; params: URLSearchParams } | { ok: false; field: string } {
  const params = new URL(request.url).searchParams;
  for (const k of params.keys()) if (!allowed.includes(k)) return { ok: false, field: k };
  return { ok: true, params };
}

/** Les routes de `/v1/veille-dpe`, à ajouter à celles de `app.ts`. */
export function veilleDpeRoutes(): VeilleDpeRoute[] {
  /** Le rôle d'abord ; puis seulement le corps, avec ses champs prévus. */
  const withBody =
    (roles: readonly Role[], fields: readonly string[], fn: (s: VeilleDpeServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Outcome>): VeilleDpeRoute['handle'] =>
    async (s, v, params, request) => {
      if (!(roles as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      const body = await readJson(request);
      if (!body) return badBody();
      const extra = Object.keys(body).find((k) => !fields.includes(k));
      if (extra !== undefined) return json(400, { ok: false, rule: null, code: 'unknown_field', field: extra });
      return reply(await fn(s, v, params, body));
    };
  /** Le rôle d'abord ; puis les seuls paramètres de requête prévus. */
  const reading =
    (roles: readonly Role[], allowed: readonly string[], fn: (s: VeilleDpeServices, v: Viewer, params: string[], q: URLSearchParams) => Promise<Outcome>): VeilleDpeRoute['handle'] =>
    async (s, v, params, request) => {
      if (!(roles as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      const q = query(request, allowed);
      if (!q.ok) return json(400, { ok: false, rule: null, code: 'unknown_field', field: q.field });
      return reply(await fn(s, v, params, q.params));
    };
  const AGENT: readonly Role[] = ['agent'];
  const BOTH: readonly Role[] = ['agent', 'direction'];

  return [
    {
      method: 'GET',
      pattern: /^\/veille-dpe\/secteurs$/,
      name: 'veille_dpe.secteurs',
      handle: reading(AGENT, [], async (s, v) => {
        const r = await veille(s).sectors(v);
        return r.ok ? { ok: true, value: r.sectors } : r;
      }),
    },
    {
      method: 'POST',
      pattern: /^\/veille-dpe\/secteurs$/,
      name: 'veille_dpe.ouvrir',
      handle: withBody(AGENT, ['commune', 'postcode'], async (s, v, _p, b) => {
        const r = await veille(s).watch(v, { commune: b.commune, postcode: b.postcode });
        return r.ok ? { ok: true, value: { sectorId: r.sectorId } } : r;
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/veille-dpe/secteurs/${ID}/fermeture$`),
      name: 'veille_dpe.fermer',
      handle: withBody(AGENT, [], async (s, v, [sectorId]) => {
        const r = await veille(s).unwatch(v, sectorId!);
        return r.ok ? { ok: true, value: null } : r;
      }),
    },
    {
      method: 'GET',
      pattern: /^\/veille-dpe\/alertes$/,
      name: 'veille_dpe.alertes',
      handle: reading(AGENT, ['day'], async (s, v, _p, q) => {
        const day = q.get('day');
        const r = await veille(s).alerts(v, day === null ? undefined : day);
        return r.ok ? { ok: true, value: r.alerts } : r;
      }),
    },
    {
      method: 'GET',
      pattern: /^\/veille-dpe\/carte$/,
      name: 'veille_dpe.carte',
      handle: reading(BOTH, ['commune', 'classes'], async (s, v, _p, q) => {
        const commune = q.get('commune');
        const classes = q.get('classes');
        const r = await veille(s).map(v, {
          ...(commune === null ? {} : { commune }),
          ...(classes === null ? {} : { classes: classes.split(',') }),
        });
        return r.ok ? { ok: true, value: r.points } : r;
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/veille-dpe/diagnostics/${ID}/lettre$`),
      name: 'veille_dpe.preparer_lettre',
      handle: withBody(AGENT, [], async (s, v, [diagnosisId]) => {
        const r = await veille(s).prepareLetter(v, diagnosisId!);
        return r.ok ? { ok: true, value: { letterId: r.letterId, body: r.body, bannedFrom: r.bannedFrom } } : r;
      }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/veille-dpe/lettres/${ID}$`),
      name: 'veille_dpe.imprimer_lettre',
      handle: async (s, v, [letterId], request) => {
        if (!(BOTH as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
        const q = query(request, []);
        if (!q.ok) return json(400, { ok: false, rule: null, code: 'unknown_field', field: q.field });
        const r = await veille(s).printLetter(v, letterId!);
        return r.ok ? new Response(r.html, { status: 200, headers: PRINT_HEADERS }) : reply(r);
      },
    },
  ];
}
