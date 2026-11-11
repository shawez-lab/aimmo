/**
 * Les routes de la recherche de biens en langage courant (HX28), sous `/v1/recherche` (BR39) :
 *
 *   POST /recherche/phrase                    les biens diffusables qui répondent à la phrase, chacun avec ses raisons
 *   POST /recherche/projets/:projet/phrase    la recherche rangée dans la fiche acquéreur du projet, avec l'accord
 *
 * Chaque route dit les rôles qu'elle admet (agent, direction), contrôlés avant toute lecture du corps ; un refus est
 * écrit au journal [R16]. La phrase est lue par le code seul, sur le serveur : l'écran envoie la phrase et les gestes
 * de la personne (refus d'un bien, commune voisine acceptée), jamais des critères [R420]. Seuls des biens diffusables
 * du réseau sont montrés [R421] ; une commune voisine n'est ajoutée que par un geste [R423] ; une recherche ne se
 * range qu'avec l'accord `buyer_search` en cours de la personne [R422], et la phrase n'est jamais gardée. Un champ
 * non prévu : 400 `unknown_field`. Rien n'est envoyé.
 */
import { BUYER_FEATURES, Diffusion, FicheAcquereur, FicheClient, FicheUnique, Rapprochement, appendEvent, type Acces, type BuyerFeature, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { PHRASE_MAX_LENGTH, REFUSAL_REASONS, RechercheLangage, type RefusalReason, type SearchStep } from '../../core/src/recherche/langage-courant.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 16_000;
const MAX_STEPS = 50;
const ID = '([A-Za-z0-9_-]{1,64})';
const ID_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

export interface RechercheServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface RechercheRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: RechercheServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule?: string | null; code: string; [k: string]: unknown };

/** 200 ; 404 inconnu ; 403 pour un refus de droits ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data: result.value ?? null });
  const { ok: _ok, rule = null, ...rest } = result;
  if (rule === 'R16' && result.code === 'unknown') return json(404, { ok: false, rule, ...rest });
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
async function refuseRole(s: RechercheServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'recherche_phrase', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

/** La phrase : un texte non vide, jamais tronqué en silence. */
function phraseOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.trim().length === 0 || value.length > PHRASE_MAX_LENGTH) return null;
  return value;
}

/** Les gestes de la personne, en forme fermée ; le reste (bien montrable, commune proposée) est contrôlé par la couche métier. */
function stepsOf(value: unknown): SearchStep[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STEPS) return null;
  const steps: SearchStep[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const r = item as Record<string, unknown>;
    const keys = Object.keys(r);
    if (keys.length === 1 && keys[0] === 'acceptNeighbour') {
      if (typeof r.acceptNeighbour !== 'string' || r.acceptNeighbour.length === 0 || r.acceptNeighbour.length > 80) return null;
      steps.push({ acceptNeighbour: r.acceptNeighbour });
      continue;
    }
    if (keys.some((k) => k !== 'refuse' && k !== 'reason' && k !== 'feature')) return null;
    if (typeof r.refuse !== 'string' || !ID_VALUE.test(r.refuse)) return null;
    if (typeof r.reason !== 'string' || !(REFUSAL_REASONS as readonly string[]).includes(r.reason)) return null;
    if (r.feature !== undefined && (typeof r.feature !== 'string' || !(BUYER_FEATURES as readonly string[]).includes(r.feature))) return null;
    if ((r.reason === 'manque') !== (r.feature !== undefined)) return null;
    steps.push({ refuse: r.refuse, reason: r.reason as RefusalReason, ...(r.feature === undefined ? {} : { feature: r.feature as BuyerFeature }) });
  }
  return steps;
}

const services = (s: RechercheServices) => {
  const fiche = new FicheUnique(s.db, new FicheClient(s.db, { now: s.now }), { now: s.now });
  const diffusion = new Diffusion(s.db, s.acces, s.journal, { now: s.now });
  const rapprochement = new Rapprochement(s.db, fiche, diffusion, s.journal, { now: s.now });
  return { recherche: new RechercheLangage(s.db, rapprochement, diffusion, s.journal, { now: s.now }), fiche: new FicheAcquereur(s.db, s.journal, { now: s.now }) };
};

type Role = 'agent' | 'direction';
const ROLES: readonly Role[] = ['agent', 'direction'];
const FIELDS = ['phrase', 'steps'];

/** Les routes de `/v1/recherche`, à ajouter à celles de `app.ts`. */
export function rechercheRoutes(): RechercheRoute[] {
  /** Le rôle d'abord ; puis seulement le corps, avec ses champs prévus ; aucun paramètre de requête. */
  const withPhrase =
    (fn: (s: RechercheServices, v: Viewer, params: string[], phrase: string, steps: SearchStep[]) => Promise<Outcome>): RechercheRoute['handle'] =>
    async (s, v, params, request) => {
      if (!(ROLES as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      for (const k of new URL(request.url).searchParams.keys()) return json(400, { ok: false, rule: null, code: 'unknown_field', field: k });
      const body = await readJson(request);
      if (!body) return badBody();
      const field = Object.keys(body).find((k) => !FIELDS.includes(k));
      if (field !== undefined) return json(400, { ok: false, rule: null, code: 'unknown_field', field });
      const phrase = phraseOf(body.phrase);
      if (phrase === null) return json(400, { ok: false, rule: null, code: 'bad_phrase', max: PHRASE_MAX_LENGTH });
      const steps = stepsOf(body.steps);
      if (steps === null) return json(400, { ok: false, rule: null, code: 'bad_steps' });
      return reply(await fn(s, v, params, phrase, steps));
    };

  return [
    {
      method: 'POST',
      pattern: /^\/recherche\/phrase$/,
      name: 'recherche.phrase',
      handle: withPhrase(async (s, v, _p, phrase, steps) => ({ ok: true, value: await services(s).recherche.search(v.networkId, phrase, steps) })),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/recherche/projets/${ID}/phrase$`),
      name: 'recherche.ranger',
      handle: withPhrase(async (s, v, [projectId], phrase, steps) => {
        const { recherche, fiche } = services(s);
        const r = await recherche.save(s.acces, v, fiche, projectId!, phrase, steps);
        return r.ok ? { ok: true, value: r.value } : r;
      }),
    },
  ];
}
