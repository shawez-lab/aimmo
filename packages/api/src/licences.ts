/**
 * Les routes de la licence du logiciel aux agences hors réseau (HX73, BR15), sous `/v1/licences`.
 *
 * Chaque route passe par les droits de la couche métier [R16] : la direction du réseau qui donne les licences fixe le
 * tarif, donne, suspend, reprend ou termine une licence ; la direction d'une agence sous licence ne lit que la sienne
 * [R657] ; tout autre rôle est refusé et le refus écrit au journal. Aucun prix dans une demande de licence : celui du
 * tarif en vigueur s'applique [R655]. Aucun prélèvement, aucun envoi.
 *
 * Le tarif public (`GET /v1/licences/tarif/<réseau>`) se lit sans clé : le prix en vigueur et chaque changement daté,
 * sans aucune agence ni aucun nombre [R655, R657].
 */
import type { JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { LicencesLogiciel } from '../../core/src/licences/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
export const LICENCES_PUBLIC_PREFIX = '/v1/licences/tarif/';
const NETWORK_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface LicencesServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

export interface LicencesRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'agence ni la licence demandées. */
  name: string;
  handle: (s: LicencesServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 404 pour une licence inconnue ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(403, { ok: false, ...rest });
  if (result.code === 'not_found') return json(404, { ok: false, ...rest });
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

const licences = (s: LicencesServices) => new LicencesLogiciel(s.db, s.journal, { now: s.now });
const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });

/**
 * Une écriture : les droits d'abord, pour qu'un autre rôle soit refusé et écrit au journal même sans corps lisible
 * [R16] ; la couche métier refait ce contrôle, et refuse aussi la direction d'une agence sous licence [R657].
 */
function write(call: (l: LicencesLogiciel, v: Viewer, body: Record<string, unknown>) => Promise<Outcome>): LicencesRoute['handle'] {
  return async (s, v, _params, request) => {
    if (v.role !== 'direction') return reply(await call(licences(s), v, {}));
    const body = await readJson(request);
    if (!body) return badBody();
    return reply(await call(licences(s), v, body));
  };
}

/** Les routes de `/v1/licences`, à ajouter à celles de `app.ts`. */
export function licencesRoutes(): LicencesRoute[] {
  const P = '^/licences';
  return [
    // Le tarif en vigueur et les licences données, pour la direction qui les donne ; la lecture va au journal [R16].
    { method: 'GET', pattern: new RegExp(`${P}$`), name: 'licences.liste', handle: async (s, v) => reply(await licences(s).list(v)) },
    // Ce que lit la direction d'une agence sous licence : la sienne seule [R657].
    { method: 'GET', pattern: new RegExp(`${P}/ma-licence$`), name: 'licences.mienne', handle: async (s, v) => reply(await licences(s).mine(v)) },
    // Un nouveau tarif mensuel, un seul pour toutes les agences ; une version s'ajoute [R655].
    { method: 'POST', pattern: new RegExp(`${P}/tarif$`), name: 'licences.tarif', handle: write((l, v, b) => l.setTariff(v, b)) },
    // Donner une licence : aucun champ de prix, la phase 5 ouverte exigée [R654, R655].
    { method: 'POST', pattern: new RegExp(`${P}/licence$`), name: 'licences.licence', handle: write((l, v, b) => l.grant(v, b)) },
    // Suspendre, reprendre ou terminer une licence, avec une raison ; terminée, elle ne bouge plus [R656].
    { method: 'POST', pattern: new RegExp(`${P}/etat$`), name: 'licences.etat', handle: write((l, v, b) => l.decide(v, b)) },
  ];
}

/**
 * Le tarif public d'un réseau, sans clé : `GET /v1/licences/tarif/<réseau>`. 404 tant qu'aucune licence ne peut se
 * donner (phase 5 fermée, aucun tarif, réseau inconnu), sans dire laquelle de ces raisons [R655, R657]. `null` si
 * l'adresse n'en est pas une.
 */
export async function handleLicencesPublic(request: Request, s: { db: SqlDatabase; journal: JournalStore; now: () => Date }): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(LICENCES_PUBLIC_PREFIX)) return null;
  if (request.method !== 'GET') return json(405, { ok: false, rule: null, code: 'method_not_allowed' });
  const networkId = path.slice(LICENCES_PUBLIC_PREFIX.length);
  const tariff = NETWORK_ID.test(networkId) ? await licences(s).publicTariff(networkId) : null;
  if (tariff === null) return json(404, { ok: false, rule: null, code: 'not_found' });
  return json(200, { ok: true, data: tariff });
}
