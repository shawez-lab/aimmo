/**
 * Les routes de la pige des annonces de particuliers (HX11), sous `/v1/pige` (BR29).
 *
 * Chaque route dit les rôles qu'elle admet, contrôlés avant toute lecture du corps ; un refus est écrit au journal [R16].
 * La couche métier refait ses propres contrôles (agent en activité, zone, auteur du message). Une annonce « pas d'agence »
 * n'entre jamais dans la file [R273] ; l'écart avec le marché ne vient que de la case publiée des prix regroupés [R274] ;
 * le premier message est rendu à l'agent pour qu'il le colle lui-même dans la messagerie de l'annonce, rien ne part
 * d'AIMMO [R275, R26]. Le vrai fournisseur (AU034) est branché par le Worker quand ses réglages sont là ; sans source,
 * la relève répond 400 `source_absente` et rien n'est rangé. Chaque relève laisse sa ligne, réussie ou en panne, et
 * `GET /pige/etat` dit la date de la dernière relève réussie et l'alerte d'une panne [R671].
 */
import type { JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';
import { PrixRegroupes, type PriceSalesSource } from '../../core/src/attirer/prix-versions.ts';
import { Pige, pigeCollectState, runPigeCollect, type PigeProviderSettings, type PigeSource } from '../../core/src/pige/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 2_048;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface PigeServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** Le fournisseur des annonces de particuliers ; absent tant qu'aucun n'est branché. */
  source: PigeSource | null;
  /** AU034 : les réglages du fournisseur ; absents, la relève reste celle de la source donnée, pour tout réseau. */
  provider?: PigeProviderSettings | null;
}

export interface PigeRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: PigeServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule?: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ou hors zone ; 404 inconnu ; 502 pour une panne du fournisseur ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { ok: _ok, rule = null, ...rest } = result;
  if (result.code === 'fournisseur_en_panne') return json(502, { ok: false, rule, ...rest });
  if (/^unknown/.test(result.code)) return json(404, { ok: false, rule, ...rest });
  if (rule === 'R16' || result.code === 'hors_zone') return json(403, { ok: false, rule, ...rest });
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

/**
 * Une route sans corps n'en admet aucun : un corps vide ou `{}` passe ; un corps illisible, trop gros ou portant un
 * champ est refusé en 400 avant que rien ne soit lu ni rangé.
 */
async function refuseAnyBody(request: Request): Promise<Response | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return badBody();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return badBody();
  if (text.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return badBody();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return badBody();
  const field = Object.keys(value)[0];
  return field === undefined ? null : json(400, { ok: false, rule: null, code: 'unknown_field', field });
}


/** Le refus d'un rôle, écrit au journal comme ceux de la couche métier, avant que le corps soit lu [R16]. */
async function refuseRole(s: PigeServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'pige', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

/** La lecture des prix publiés n'utilise jamais une source de ventes : seules les cases déjà publiées comptent [R274]. */
const NO_SALES: PriceSalesSource = {
  coverage: async () => null,
  within: async () => [],
};

/** La source de ce réseau : avec les réglages du fournisseur, seul son réseau la reçoit. */
function sourceFor(s: PigeServices, networkId: string): PigeSource | null {
  if (!s.source) return null;
  const owner = s.provider?.networkId?.trim();
  return s.provider && owner !== networkId ? null : s.source;
}

const NO_PROVIDER: PigeProviderSettings = { url: undefined, token: undefined, networkId: undefined };

export const pige = (s: PigeServices) => new Pige(s.db, s.journal, new PrixRegroupes(s.db, s.journal, NO_SALES, { now: s.now }), { now: s.now });

type Role = 'agent' | 'direction';

/** Aucun paramètre de requête n'est prévu : le premier venu est refusé. */
function extraQuery(request: Request): string | null {
  for (const k of new URL(request.url).searchParams.keys()) return k;
  return null;
}

/** Les routes de `/v1/pige`, à ajouter à celles de `app.ts`. */
export function pigeRoutes(): PigeRoute[] {
  /** Le rôle d'abord ; puis seulement le corps, avec ses champs prévus. */
  const withBody =
    (roles: readonly Role[], fields: readonly string[], fn: (s: PigeServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Outcome>): PigeRoute['handle'] =>
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
  /** Le rôle d'abord ; ni paramètre de requête ni corps. */
  const bare =
    (roles: readonly Role[], fn: (s: PigeServices, v: Viewer, params: string[]) => Promise<Outcome>): PigeRoute['handle'] =>
    async (s, v, params, request) => {
      if (!(roles as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      const extra = extraQuery(request);
      if (extra !== null) return json(400, { ok: false, rule: null, code: 'unknown_field', field: extra });
      if (request.method === 'POST') {
        const refused = await refuseAnyBody(request);
        if (refused) return refused;
      }
      return reply(await fn(s, v, params));
    };
  const AGENT: readonly Role[] = ['agent'];
  const BOTH: readonly Role[] = ['agent', 'direction'];
  const DIRECTION: readonly Role[] = ['direction'];

  return [
    {
      method: 'GET',
      pattern: /^\/pige$/,
      name: 'pige.file',
      handle: bare(BOTH, async (s, v) => {
        const r = await pige(s).queue(v);
        return r.ok ? { ok: true, value: r.value } : r;
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/pige/annonces/${ID}/message$`),
      name: 'pige.preparer',
      handle: bare(AGENT, async (s, v, [adId]) => {
        const r = await pige(s).prepare(v, adId);
        return r.ok ? { ok: true, value: { draftId: r.draftId, body: r.body, sent: false } } : r;
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/pige/messages/${ID}/validation$`),
      name: 'pige.valider',
      handle: withBody(AGENT, ['channel'], async (s, v, [draftId], b) => {
        const r = await pige(s).validate(v, draftId, b.channel);
        // Le texte est remis à l'agent, à coller lui-même : rien n'est parti d'AIMMO [R275].
        return r.ok ? { ok: true, value: { body: r.body, channel: r.channel, sent: false, toPaste: true } } : r;
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/pige/annonces/${ID}/opposition$`),
      name: 'pige.opposition',
      handle: bare(BOTH, async (s, v, [adId]) => {
        const r = await pige(s).oppose(v, adId);
        return r.ok ? { ok: true, value: null } : r;
      }),
    },
    {
      method: 'GET',
      pattern: /^\/pige\/etat$/,
      name: 'pige.etat',
      handle: bare(BOTH, async (s, v) => {
        const r = await pigeCollectState(s.db, s.journal, v, s.provider ?? NO_PROVIDER, s.now);
        return r.ok ? { ok: true, value: r.value } : r;
      }),
    },
    {
      method: 'POST',
      pattern: /^\/pige\/releve$/,
      name: 'pige.releve',
      handle: bare(DIRECTION, async (s, v) => {
        const source = sourceFor(s, v.networkId);
        if (!source) return { ok: false, rule: null, code: 'source_absente' };
        const r = await runPigeCollect(s.db, s.journal, pige(s), v.networkId, source, s.now);
        if (r.outcome === 'panne') return { ok: false, rule: 'R671', code: 'fournisseur_en_panne', reason: r.reason };
        return { ok: true, value: { added: r.added, noAgency: r.noAgency, outside: r.outside, unreadable: r.unreadable } };
      }),
    },
  ];
}
