/**
 * Les routes des réclamations (HX58) et du contrôle du gel des avoirs (HX57), sous `/v1/securite` (BR01).
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrit chaque refus au journal : l'agent qui suit la
 * fiche ou la direction pour les réclamations ; le responsable de la conformité seul pour le registre du gel et ses
 * résultats ; l'agent peut demander le contrôle d'un dossier de son client, et lit toujours le même mot [R605].
 * Rien n'est envoyé : la proposition du médiateur passe par le contrôle central et les seuls canaux du mode essai [R26,
 * R607]. Les passages restent ceux du planificateur (`securite.reclamations`, `securite.gel_avoirs`).
 */
import type { Acces, JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { ControleGels, Reclamations } from '../../core/src/securite/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
/** Le registre du gel compte quelques milliers de noms : son import seul a droit à un corps plus gros. */
const MAX_REGISTRY_BYTES = 4_000_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface SecuriteServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface SecuriteRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: SecuriteServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(result.code === 'unknown' ? 404 : 403, { ok: false, ...rest });
  if (/^unknown/.test(result.code)) return json(404, { ok: false, ...rest });
  return json(result.rule ? 409 : 400, { ok: false, ...rest });
}

async function readJson(request: Request, limit = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const query = (r: Request, name: string): string | null => new URL(r.url).searchParams.get(name);

// Sans `send`, les réclamations ne passent que par les canaux du mode essai : rien ne part vraiment [R26, R607].
const reclamations = (s: SecuriteServices) => new Reclamations(s.db, s.acces, s.journal, { now: s.now });
const gels = (s: SecuriteServices) => new ControleGels(s.db, s.acces, s.journal, { now: s.now });

/** Les routes de `/v1/securite`, à ajouter à celles de `app.ts`. */
export function securiteRoutes(): SecuriteRoute[] {
  type Handler = (s: SecuriteServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>;
  const withBody = (fn: Handler, limit = MAX_BODY_BYTES): SecuriteRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request, limit);
    if (!body) return badBody();
    return fn(s, v, params, body);
  };
  const P = '^/securite';
  const R = `${P}/reclamations`;
  const G = `${P}/gel`;
  return [
    // Réclamations (HX58).
    {
      method: 'GET',
      pattern: new RegExp(`${R}$`),
      name: 'securite.reclamations',
      handle: async (s, v) => reply(await reclamations(s).list(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${R}/reglage$`),
      name: 'securite.reclamations.reglage',
      handle: withBody(async (s, v, _p, b) => reply(await reclamations(s).configure(v, { responseDays: b.responseDays, mediatorName: b.mediatorName, mediatorSite: b.mediatorSite }))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/fiches/${ID}/reclamations$`),
      name: 'securite.reclamations.ranger',
      handle: withBody(async (s, v, [personId], b) => {
        const reply_ = b.reply;
        if (reply_ !== undefined && reply_ !== null && (typeof reply_ !== 'object' || Array.isArray(reply_))) return badBody();
        const r = reply_ as { channel?: unknown; conversationId?: unknown } | null | undefined;
        return reply(
          await reclamations(s).record(v, personId!, {
            receivedOn: b.receivedOn,
            receivedBy: b.receivedBy,
            summary: b.summary,
            reply: r ? { channel: r.channel, conversationId: r.conversationId } : null,
          }),
        );
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${R}/${ID}/reponse$`),
      name: 'securite.reclamations.reponse',
      handle: withBody(async (s, v, [id], b) => reply(await reclamations(s).answer(v, id!, { outcome: b.outcome, note: b.note }))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${R}/${ID}/mediateur-remis$`),
      name: 'securite.reclamations.mediateur_remis',
      handle: async (s, v, [id]) => reply(await reclamations(s).handed(v, id!)),
    },
    // Gel des avoirs (HX57).
    {
      method: 'POST',
      pattern: new RegExp(`${G}/registre$`),
      name: 'securite.gel.registre',
      handle: withBody(async (s, v, _p, b) => reply(await gels(s).importRegistry(v, { publishedAt: b.publishedAt, entries: b.entries })), MAX_REGISTRY_BYTES),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${G}/controle$`),
      name: 'securite.gel.controle',
      // Le même mot pour tous : l'agent ne lit jamais le résultat [R605].
      handle: withBody(async (s, v, _p, b) => reply(await gels(s).checkCase(v, b.caseRef))),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${G}/controles$`),
      name: 'securite.gel.controles',
      handle: async (s, v, _p, r) => {
        const caseRef = query(r, 'dossier');
        if (caseRef === null || caseRef.length > 80) return badBody();
        return reply(await gels(s).checks(v, caseRef));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`${G}/sans-nom$`),
      name: 'securite.gel.sans_nom',
      handle: async (s, v) => reply(await gels(s).unnamedCases(v)),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${G}/correspondances$`),
      name: 'securite.gel.correspondances',
      handle: async (s, v) => reply(await gels(s).matches(v)),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${G}/correspondances/${ID}/fige$`),
      name: 'securite.gel.fige',
      handle: async (s, v, [id]) => reply(await gels(s).checkFrozen(v, id!)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${G}/correspondances/${ID}/decision$`),
      name: 'securite.gel.decision',
      handle: withBody(async (s, v, [id], b) => reply(await gels(s).decide(v, id!, { decision: b.decision, reason: b.reason, validatorName: b.validatorName }))),
    },
  ];
}
