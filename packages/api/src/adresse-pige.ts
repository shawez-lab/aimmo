/**
 * Les routes de l'adresse probable d'une annonce de pige, et du bien créé sans ressaisie (HX18), sous `/v1/pige` (BR30).
 *
 * Chaque route dit les rôles qu'elle admet, contrôlés avant toute lecture du corps ; un refus est écrit au journal [R16].
 * La couche métier refait ses propres contrôles (agent en activité, zone, auteur de la proposition, agent du bien).
 * Chaque adresse rendue porte sa confiance et ses sources ; les coordonnées du particulier ne sont jamais cherchées
 * [R294]. La fiche du bien reprend les champs de l'annonce, source « pige » ; une annonce « pas d'agence » ou fermée par
 * un non n'est jamais convertie [R295, R273]. Ce que la pige rapporte se lit par niveau de confiance [R296]. La base de
 * l'ADEME et le cadastre passent par la lecture des données publiques (`fetchPublicData`) ; sans elle, seuls les
 * diagnostics de la veille servent, et la réponse le dit. Rien n'est envoyé.
 */
import type { JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';
import { PrixRegroupes, type PriceSalesSource } from '../../core/src/attirer/prix-versions.ts';
import { Pige } from '../../core/src/pige/index.ts';
import { AdressePige, type AdressePigeServices } from '../../core/src/adresse-pige/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 2_048;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface AdressePigeRouteServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** La base de l'ADEME et le cadastre ; vides, seuls les diagnostics de la veille servent. */
  sources: AdressePigeServices;
}

export interface AdressePigeRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: AdressePigeRouteServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule?: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ou hors zone ; 404 inconnu ; 409 pour une règle ou une annonce remplacée ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { ok: _ok, rule = null, ...rest } = result;
  if (/^unknown/.test(result.code) || result.code === 'inconnu') return json(404, { ok: false, rule, ...rest });
  if (rule === 'R16' || result.code === 'hors_zone') return json(403, { ok: false, rule, ...rest });
  return json(rule || result.code === 'annonce_remplacee' ? 409 : 400, { ok: false, rule, ...rest });
}

async function readText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > MAX_BODY_BYTES ? null : text;
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });

/** Un objet JSON, ou null : illisible, trop gros, pas un objet. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Le refus d'un rôle, écrit au journal comme ceux de la couche métier, avant que le corps soit lu [R16]. */
async function refuseRole(s: AdressePigeRouteServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'adresse_pige', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

/** La lecture des prix publiés n'utilise jamais une source de ventes : seules les cases déjà publiées comptent [R274]. */
const NO_SALES: PriceSalesSource = {
  coverage: async () => null,
  within: async () => [],
};

const adresses = (s: AdressePigeRouteServices) =>
  new AdressePige(s.db, s.journal, new Pige(s.db, s.journal, new PrixRegroupes(s.db, s.journal, NO_SALES, { now: s.now }), { now: s.now }), s.sources, { now: s.now });

type Role = 'agent' | 'direction';

/** Aucun paramètre de requête n'est prévu : le premier venu est refusé. */
function extraQuery(request: Request): string | null {
  for (const k of new URL(request.url).searchParams.keys()) return k;
  return null;
}

/** Les routes de l'adresse probable et du bien de pige, à ajouter à celles de `app.ts`. */
export function adressePigeRoutes(): AdressePigeRoute[] {
  /**
   * Le rôle d'abord ; puis le corps, un objet JSON avec ses seuls champs prévus. Un corps vide vaut `{}` ; une route
   * sans champ prévu refuse tout champ.
   */
  const handler =
    (roles: readonly Role[], fields: readonly string[], fn: (s: AdressePigeRouteServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Outcome>): AdressePigeRoute['handle'] =>
    async (s, v, params, request) => {
      if (!(roles as readonly string[]).includes(String(v.role))) return refuseRole(s, v);
      const extra = extraQuery(request);
      if (extra !== null) return json(400, { ok: false, rule: null, code: 'unknown_field', field: extra });
      let body: Record<string, unknown> = {};
      if (request.method === 'POST') {
        const text = await readText(request);
        if (text === null) return badBody();
        if (text.trim() !== '') {
          if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return badBody();
          const parsed = parseObject(text);
          if (!parsed) return badBody();
          body = parsed;
        }
        const field = Object.keys(body).find((k) => !fields.includes(k));
        if (field !== undefined) return json(400, { ok: false, rule: null, code: 'unknown_field', field });
      }
      return reply(await fn(s, v, params, body));
    };
  const AGENT: readonly Role[] = ['agent'];
  const BOTH: readonly Role[] = ['agent', 'direction'];

  return [
    {
      method: 'POST',
      pattern: new RegExp(`^/pige/annonces/${ID}/adresses$`),
      name: 'pige.adresses',
      handle: handler(AGENT, [], async (s, v, [adId]) => {
        const r = await adresses(s).propose(v, adId);
        if (!r.ok) return r;
        return { ok: true, value: { proposalId: r.proposalId, adId: r.adId, candidates: r.candidates, missing: r.missing } };
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/pige/annonces/${ID}/bien$`),
      name: 'pige.bien',
      handle: handler(AGENT, ['proposalId', 'diagnosisNumber'], async (s, v, [adId], b) => {
        // Sans `diagnosisNumber`, le bien est créé sans adresse ; avec, seule une adresse proposée se retient [R294].
        if (b.proposalId !== undefined && (b.diagnosisNumber === undefined || b.diagnosisNumber === null)) return { ok: false, rule: null, code: 'invalid_body', field: 'diagnosisNumber' };
        const r = await adresses(s).convert(v, { adId, proposalId: b.proposalId, diagnosisNumber: b.diagnosisNumber });
        return r.ok ? { ok: true, value: r.value } : r;
      }),
    },
    {
      method: 'GET',
      pattern: /^\/pige\/rapport$/,
      name: 'pige.rapport',
      handle: handler(BOTH, [], async (s, v) => {
        const r = await adresses(s).yieldOf(v);
        return r.ok ? { ok: true, value: r.value } : r;
      }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/pige/biens/${ID}$`),
      name: 'pige.bien_source',
      handle: handler(BOTH, [], async (s, v, [propertyId]) => {
        const r = await adresses(s).sourceOf(v, propertyId);
        return r.ok ? { ok: true, value: { propertyId, source: r.source, adSite: r.adSite, confidence: r.confidence } } : r;
      }),
    },
  ];
}
