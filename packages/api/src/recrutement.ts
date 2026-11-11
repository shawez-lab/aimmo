/**
 * Les routes du recrutement des 100 premiers agents (HX64, HX65), sous `/v1/recrutement` (BR02).
 *
 * La direction seule : chaque route passe par les droits de la couche métier [R16], qui écrit chaque refus au journal.
 * Les contenus (vidéos et épisodes) passent le contrôle des promesses [R80, R620], ne s'effacent jamais, et leur compte
 * rendu ne donne que des nombres [R622]. Le coût de l'agent moyen est calculé par le code depuis la base, pour un mois
 * fini seulement [R623, R624, R625] : aucun montant n'entre par une route. Les communes à pourvoir (HX68, BR37) se lisent
 * pour un mois fini [R626] et s'ouvrent ou se ferment par versions [R627]. Rien n'est envoyé.
 */
import { appendEvent, reseau, type Acces, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface RecrutementServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface RecrutementRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: RecrutementServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 introuvable ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(result.code === 'unknown' ? 404 : 403, { ok: false, ...rest });
  // `not_found` : ce qui n'existe pas ; `unknown_field` est un corps mal formé, jamais un 404.
  if (result.code === 'not_found' || (/^unknown/.test(result.code) && result.code !== 'unknown_field')) return json(404, { ok: false, ...rest });
  return json(result.rule ? 409 : 400, { ok: false, ...rest });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
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

/** Aucun montant n'entre par une route [R624] : un corps qui en porte un est refusé, sans rien ranger. */
const AMOUNT_KEYS = /amount|montant|cents|eur|fee|honorair|price|prix|cout|cost/i;
const carriesAmount = (body: Record<string, unknown>): boolean => Object.keys(body).some((k) => AMOUNT_KEYS.test(k));

const contenus = (s: RecrutementServices) => new reseau.ContenusRecrutement(s.db, s.journal, { now: s.now });
const cout = (s: RecrutementServices) => new reseau.CoutAgent(s.db, s.journal, { now: s.now });
const communes = (s: RecrutementServices) => new reseau.CommunesAPourvoir(s.db, s.journal, { now: s.now });

/** Les routes de `/v1/recrutement`, à ajouter à celles de `app.ts`. */
export function recrutementRoutes(): RecrutementRoute[] {
  type Handler = (s: RecrutementServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>;
  /** `costs` : une route du coût de l'agent, où aucun montant n'entre jamais [R624]. */
  const withBody = (fn: Handler, costs = false): RecrutementRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request);
    if (!body) return badBody();
    if (costs && carriesAmount(body)) {
      await appendEvent(s.journal, { type: 'recrutement.montant_refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R624', code: 'amount_refused' } }, s.now);
      return json(400, { ok: false, rule: 'R624', code: 'amount_refused', message: 'Aucun montant ne se saisit : il est calculé par le code.' });
    }
    return fn(s, v, params, body);
  };
  const P = '^/recrutement';
  /**
   * La direction seule, contrôlée avant même de lire le corps : un refus est toujours écrit au journal, quel que soit
   * le corps [R16]. La couche métier refait son propre contrôle derrière.
   */
  const direction = (route: RecrutementRoute): RecrutementRoute => ({
    ...route,
    handle: async (s, v, params, request) => {
      if (v.role === 'direction') return route.handle(s, v, params, request);
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R16', role: String(v.role), kind: route.name, code: 'role' } }, s.now);
      return json(403, { ok: false, rule: 'R16', code: 'role' });
    },
  });
  const routes: RecrutementRoute[] = [
    // Vidéos et épisodes du podcast (HX64).
    {
      method: 'GET',
      pattern: new RegExp(`${P}/contenus$`),
      name: 'recrutement.contenus',
      // Le compte rendu : chaque contenu, son lien marqué et son chemin, en nombres seulement [R622].
      handle: async (s, v) => reply(await contenus(s).report(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/contenus$`),
      name: 'recrutement.contenus.ranger',
      handle: withBody(async (s, v, _p, b) => reply(await contenus(s).create(v, b))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/contenus/${ID}/retrait$`),
      name: 'recrutement.contenus.retrait',
      handle: async (s, v, [id]) => reply(await contenus(s).withdraw(v, id!)),
    },
    // Le coût complet de l'agent moyen (HX65).
    {
      method: 'POST',
      pattern: new RegExp(`${P}/cout-agent/factures/${ID}/poste$`),
      name: 'recrutement.cout.poste',
      handle: withBody(async (s, v, [id], b) => {
        if (Object.keys(b).some((k) => k !== 'category')) return badBody();
        return reply(await cout(s).assign(v, id!, b.category));
      }, true),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/cout-agent/reglages$`),
      name: 'recrutement.cout.reglages',
      handle: withBody(async (s, v, _p, b) => reply(await cout(s).setSettings(v, b)), true),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/cout-agent$`),
      name: 'recrutement.cout.mois',
      handle: async (s, v, _p, r) => reply(await cout(s).month(v, new URL(r.url).searchParams.get('mois'))),
    },
    // Les communes où des clients attendent un agent (HX68).
    {
      method: 'GET',
      pattern: new RegExp(`${P}/communes$`),
      name: 'recrutement.communes.mois',
      handle: async (s, v, _p, r) => reply(await communes(s).month(v, new URL(r.url).searchParams.get('mois'))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/communes/decision$`),
      name: 'recrutement.communes.decision',
      // Le corps entier va à la couche métier, qui refuse tout champ inconnu et toute commune hors liste [R627].
      handle: withBody(async (s, v, _p, b) => reply(await communes(s).decide(v, b))),
    },
  ];
  return routes.map(direction);
}
