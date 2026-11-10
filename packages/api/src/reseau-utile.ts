/**
 * Les routes des remises négociées (HX08) et des actualités utiles (HX09), sous `/v1/remises` et `/v1/actualites`
 * (BR20).
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrivent chaque refus au journal : la direction seule
 * range et retire une remise ou une actualité, et lit le catalogue des actualités ; l'agent en activité lit le catalogue
 * des remises, celles de son bien au moment lu dans la base [R267], en écarte une, et lit son fil [R269]. Rien n'est
 * envoyé : ni au fournisseur, ni au client, ni à l'agent hors de l'application.
 */
import type { Acces, JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { Actualites } from '../../core/src/actualites/index.ts';
import { Remises } from '../../core/src/remises/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface ReseauUtileServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface ReseauUtileRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: ReseauUtileServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
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

const remises = (s: ReseauUtileServices) => new Remises(s.db, s.acces, s.journal, { now: s.now });
const actualites = (s: ReseauUtileServices) => new Actualites(s.db, s.acces, s.journal, { now: s.now });

/** Les routes de `/v1/remises` et `/v1/actualites`, à ajouter à celles de `app.ts`. */
export function reseauUtileRoutes(): ReseauUtileRoute[] {
  type Handler = (s: ReseauUtileServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>;
  const withBody = (fn: Handler): ReseauUtileRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request);
    if (!body) return badBody();
    return fn(s, v, params, body);
  };
  return [
    // Remises (HX08).
    {
      method: 'GET',
      pattern: /^\/remises$/,
      name: 'remises.catalogue',
      handle: async (s, v) => reply(await remises(s).catalogue(v)),
    },
    {
      method: 'POST',
      pattern: /^\/remises$/,
      name: 'remises.ranger',
      handle: withBody(async (s, v, _p, b) =>
        reply(
          await remises(s).setDiscount(v, {
            category: b.category,
            supplier: b.supplier,
            partnerId: b.partnerId,
            beneficiary: b.beneficiary,
            title: b.title,
            terms: b.terms,
            source: b.source,
            moment: b.moment,
            validFrom: b.validFrom,
            validUntil: b.validUntil,
          }),
        ),
      ),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/remises/${ID}/retrait$`),
      name: 'remises.retrait',
      handle: withBody(async (s, v, [id], b) => reply(await remises(s).withdraw(v, id!, b.reason))),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/remises/biens/${ID}$`),
      name: 'remises.bien',
      handle: async (s, v, [propertyId]) => reply(await remises(s).suggestionsFor(v, propertyId!)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/remises/${ID}/biens/${ID}/ecarter$`),
      name: 'remises.ecarter',
      handle: async (s, v, [id, propertyId]) => reply(await remises(s).dismiss(v, id!, propertyId!)),
    },
    // Actualités (HX09).
    {
      method: 'GET',
      pattern: /^\/actualites$/,
      name: 'actualites.fil',
      handle: async (s, v) => reply(await actualites(s).feed(v)),
    },
    {
      method: 'GET',
      pattern: /^\/actualites\/catalogue$/,
      name: 'actualites.catalogue',
      handle: async (s, v) => reply(await actualites(s).catalogue(v)),
    },
    {
      method: 'POST',
      pattern: /^\/actualites$/,
      name: 'actualites.publier',
      handle: withBody(async (s, v, _p, b) =>
        reply(
          await actualites(s).publish(v, {
            topic: b.topic,
            title: b.title,
            impact: b.impact,
            sourceName: b.sourceName,
            sourceUrl: b.sourceUrl,
            sourceDate: b.sourceDate,
            ...(b.target === undefined ? {} : { target: b.target }),
          }),
        ),
      ),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/actualites/${ID}/retrait$`),
      name: 'actualites.retrait',
      handle: withBody(async (s, v, [id], b) => reply(await actualites(s).withdraw(v, id!, b.reason))),
    },
  ];
}
