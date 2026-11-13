/**
 * Les routes de l'armoire des clés des biens (HX10), sous `/v1/trousseaux` (BR21).
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrivent chaque refus au journal : l'agent du bien en
 * activité ou la direction tiennent l'armoire ; l'agent qui a un trousseau peut le dire perdu ; chaque agent lit ce qu'il
 * a à rendre [R272]. Le numéro est donné par le code [R270] ; un trousseau n'est jamais chez deux personnes [R271]. Une
 * remise à un partenaire de l'annuaire suit R665 ; son retour passe par les mêmes routes `rendu` et `perdu`.
 * Un corps absent ou mal formé ne passe jamais avant les droits : la même demande, sans corps, est d'abord soumise à la
 * couche métier, et seul un appelant admis reçoit le 400. Rien n'est envoyé.
 */
import type { Acces, FicheUnique, JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { Cles } from '../../core/src/cles/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 4_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface TrousseauxServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  fiche: FicheUnique;
  now: () => Date;
}

export interface TrousseauxRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: TrousseauxServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
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

const cles = (s: TrousseauxServices) => new Cles(s.db, s.acces, s.fiche, s.journal, { now: s.now });

/** Les routes de `/v1/trousseaux`, à ajouter à celles de `app.ts`. */
export function trousseauxRoutes(): TrousseauxRoute[] {
  type Handler = (s: TrousseauxServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Outcome>;
  /**
   * Un corps mal formé : la demande passe d'abord sans corps par la couche métier, qui vérifie les droits avant toute
   * donnée et ne range rien sans libellé ni raison de sortie ; un refus de droits ou un inconnu sort tel quel, sinon 400.
   */
  const withBody = (fn: Handler): TrousseauxRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request);
    if (body) return reply(await fn(s, v, params, body));
    const probe = await fn(s, v, params, {});
    if (!probe.ok && (probe.rule === 'R16' || /^unknown/.test(probe.code))) return reply(probe);
    return badBody();
  };
  const P = '^/trousseaux';
  return [
    {
      method: 'GET',
      pattern: new RegExp(`${P}/a-rendre$`),
      name: 'trousseaux.a_rendre',
      handle: async (s, v) => reply(await cles(s).reminders(v)),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/biens/${ID}$`),
      name: 'trousseaux.armoire',
      handle: async (s, v, [propertyId]) => reply(await cles(s).cabinet(v, propertyId!)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/biens/${ID}$`),
      name: 'trousseaux.ranger',
      handle: withBody(async (s, v, [propertyId], b) => cles(s).register(v, propertyId!, b.label)),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/${ID}/mouvements$`),
      name: 'trousseaux.mouvements',
      handle: async (s, v, [keyId]) => reply(await cles(s).history(v, keyId!)),
    },
    // Qui peut recevoir le trousseau, pour l'écran de la sortie (BR52) : mêmes droits que la sortie [R16, R271, R665].
    {
      method: 'GET',
      pattern: new RegExp(`${P}/${ID}/choix$`),
      name: 'trousseaux.choix',
      handle: async (s, v, [keyId]) => reply(await cles(s).choices(v, keyId!)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/${ID}/sortie$`),
      name: 'trousseaux.sortie',
      handle: withBody(async (s, v, [keyId], b) =>
        cles(s).handOut(v, keyId!, { holderAgentId: b.holderAgentId, purpose: b.purpose, appointmentId: b.appointmentId, dueAt: b.dueAt }),
      ),
    },
    // Vers un partenaire de l'annuaire qui entre seul (RC17) : l'agent qui remet en répond [R665].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/${ID}/partenaire$`),
      name: 'trousseaux.partenaire',
      handle: withBody(async (s, v, [keyId], b) => cles(s).handToPartner(v, keyId!, { partnerId: b.partnerId, purpose: b.purpose, dueAt: b.dueAt })),
    },
    // Sans corps : le geste est dans l'adresse, rien à lire avant les droits.
    {
      method: 'POST',
      pattern: new RegExp(`${P}/${ID}/rendu$`),
      name: 'trousseaux.rendu',
      handle: async (s, v, [keyId]) => reply(await cles(s).giveBack(v, keyId!, 'rendu')),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/${ID}/perdu$`),
      name: 'trousseaux.perdu',
      handle: async (s, v, [keyId]) => reply(await cles(s).giveBack(v, keyId!, 'perdu')),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/${ID}/rendu-au-proprietaire$`),
      name: 'trousseaux.rendu_au_proprietaire',
      handle: async (s, v, [keyId]) => reply(await cles(s).retire(v, keyId!, 'rendu_au_proprietaire')),
    },
  ];
}
