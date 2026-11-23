/**
 * Les routes du marketing (HX52, HX53, HX54), sous `/v1/marketing` (BR03) : le calendrier de publication de l'agent, les
 * éditions de la lettre et le magazine des biens, la publicité payante mesurée au mandat.
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps soit lu
 * [R16]. La couche métier refait ses propres contrôles derrière (agent parti [R86], validation de la direction [R587]).
 *
 * Rien ne part ni ne se paie d'ici :
 * - le calendrier ne fait que régler et réserver ; le passage des créneaux dus est un travail planifié (`runDue`,
 *   `marketing-passage.ts`, BR112), seul à appeler le chemin de publication de X05, et la porte donnée ici refuse toute
 *   publication [R582, R26] ;
 * - la lettre ne fait qu'ouvrir une édition et tirer le magazine ; l'envoi d'une édition est un travail planifié
 *   (`marketing-passage.ts`, BR112), avec sa page de désinscription [R583, R584] ;
 * - les campagnes ne parlent qu'aux plateformes du mode essai, sauf celles que le Worker a mises en service avec leur
 *   plafond (AU038, H63) [R587] ; la dépense et les contacts sont lus par un travail planifié (`runAdsPass` :
 *   `matchArrivals`, `syncSpend`, `runChecks`), jamais saisis par une route [R588].
 */
import { Acces, FicheClient, FicheUnique, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { computeMentions, MentionsAnnonce } from '../../core/src/annonces/mentions.ts';
import { OrigineContacts } from '../../core/src/attirer/origine-contacts.ts';
import { Diffusion } from '../../core/src/documents/retractation.ts';
import { CalendrierPublications, LettreInformation, PublicitePayante, trialAdPlatform, type PublicationGate } from '../../core/src/marketing/index.ts';
import type { AdsSettings } from './publicite-reelle.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface MarketingServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** AU038 : les plateformes de la publicité rangées par le Worker (H63) ; absentes, l'essai seul. */
  ads?: AdsSettings | null;
}

type Role = Viewer['role'];
const AGENT: readonly Role[] = ['agent'];
const DIRECTION: readonly Role[] = ['direction'];
const WORK: readonly Role[] = ['agent', 'direction'];

export interface MarketingRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: MarketingServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

/** Le magazine imprimable : une page fermée à tout script, toute ressource extérieure et tout formulaire. */
const html = (page: string): Response =>
  new Response(page, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...HEADERS,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 introuvable ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(result.code === 'unknown' ? 404 : 403, { ok: false, ...rest });
  if (result.code === 'unknown') return json(404, { ok: false, ...rest });
  return json(result.rule ? 409 : 400, { ok: false, ...rest });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
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
const unknownField = (): Response => json(400, { ok: false, rule: null, code: 'unknown_field' });
/** Un corps qui porte une clé non prévue est refusé, sans rien ranger. */
const only = (body: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(body).every((k) => keys.includes(k));

type Handler = (s: MarketingServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>;
const withBody =
  (keys: readonly string[], fn: Handler): MarketingRoute['handle'] =>
  async (s, v, params, request) => {
    const body = await readJson(request);
    if (!body) return badBody();
    if (!only(body, keys)) return unknownField();
    return fn(s, v, params, body);
  };

/**
 * La porte de publication donnée au calendrier par les routes : elle ne publie jamais. Aucune route n'appelle le
 * passage des créneaux ; s'il l'était un jour par erreur, rien ne partirait [R582, R26].
 */
const NO_PUBLICATION: PublicationGate = { publish: async () => ({ ok: false, rule: 'R26', code: 'pas_depuis_une_route' }) };

function acces(s: MarketingServices): Acces {
  const store = new FicheClient(s.db, { now: s.now });
  return new Acces(s.db, store, new FicheUnique(s.db, store, { now: s.now }), s.journal, { now: s.now });
}

const calendrier = (s: MarketingServices) =>
  new CalendrierPublications(
    s.db,
    s.journal,
    { gate: NO_PUBLICATION, diffusion: new Diffusion(s.db, acces(s), s.journal, { now: s.now }), links: new OrigineContacts(s.db, s.journal, { now: s.now }) },
    { now: s.now },
  );

/** La lettre des routes, sans lien de désinscription : aucune lettre ne peut partir d'ici [R584]. */
const lettre = (s: MarketingServices): LettreInformation => letterService(s, null);

/**
 * La lettre, avec les mentions de M07 [R43] et les canaux du mode essai par défaut [R26]. Seul le passage planifié
 * (BR112) lui donne un lien de désinscription ; les routes n'en donnent jamais.
 */
export function letterService(s: MarketingServices, unsubscribeBase: string | null): LettreInformation {
  const a = acces(s);
  return new LettreInformation(s.db, s.journal, {
    now: s.now,
    unsubscribeBase,
    mentions: {
      checklist: async (networkId: string, propertyId: string) => {
        const input = await new MentionsAnnonce(s.db, a, s.journal, { now: s.now }).inputFor(networkId, propertyId);
        return input ? computeMentions(input) : null;
      },
    },
  });
}

/** Les plateformes publicitaires de l'essai, ou celles mises en service par le Worker avec leur plafond (AU038) [R587]. */
const publicite = (s: MarketingServices) =>
  s.ads
    ? new PublicitePayante(s.db, s.journal, s.ads.platforms, { now: s.now, ...(s.ads.realCapCents ? { realCapCents: s.ads.realCapCents } : {}) })
    : new PublicitePayante(s.db, s.journal, { google_ads: trialAdPlatform(), meta: trialAdPlatform() }, { now: s.now });

/** Les routes de `/v1/marketing`, à ajouter à celles de `app.ts`. */
export function marketingRoutes(): MarketingRoute[] {
  const P = '^/marketing';
  const routes: MarketingRoute[] = [
    // Calendrier de publication (HX52) : l'agent, pour son propre calendrier.
    {
      method: 'GET',
      pattern: new RegExp(`${P}/calendrier/reglages$`),
      name: 'marketing.calendrier.reglages',
      roles: AGENT,
      handle: async (s, v) => reply(await calendrier(s).rules(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/calendrier/reglages$`),
      name: 'marketing.calendrier.regler',
      roles: AGENT,
      handle: withBody(['perDay', 'hours'], async (s, v, _p, b) => reply(await calendrier(s).setRules(v, { perDay: b.perDay, hours: b.hours }))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/calendrier/semaine$`),
      name: 'marketing.calendrier.semaine',
      roles: AGENT,
      handle: withBody(['from'], async (s, v, _p, b) => reply(await calendrier(s).planWeek(v, b.from))),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/calendrier/creneaux$`),
      name: 'marketing.calendrier.creneaux',
      roles: AGENT,
      handle: async (s, v, _p, r) => {
        const q = new URL(r.url).searchParams;
        return reply(await calendrier(s).slots(v, q.get('du'), q.get('au')));
      },
    },
    // Lettre d'information et magazine (HX53).
    {
      method: 'POST',
      pattern: new RegExp(`${P}/lettre/editions$`),
      name: 'marketing.lettre.edition',
      roles: DIRECTION,
      handle: withBody(['title'], async (s, v, _p, b) => {
        const r = await lettre(s).createEdition(v, b.title);
        return reply(r.ok ? { ok: true, value: { id: r.id } } : r);
      }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/magazine$`),
      name: 'marketing.magazine',
      roles: WORK,
      handle: async (s, v) => {
        const r = await lettre(s).magazine(v);
        return r.ok ? html(r.html) : reply(r);
      },
    },
    // Publicité payante mesurée au mandat (HX54).
    {
      method: 'GET',
      pattern: new RegExp(`${P}/publicite/campagnes$`),
      name: 'marketing.publicite.compte_rendu',
      roles: DIRECTION,
      handle: async (s, v) => reply(await publicite(s).report(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/publicite/campagnes$`),
      name: 'marketing.publicite.campagne',
      roles: WORK,
      handle: withBody(['platform', 'name', 'targeting'], async (s, v, _p, b) => reply(await publicite(s).create(v, b))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/publicite/campagnes/${ID}/validation$`),
      name: 'marketing.publicite.validation',
      roles: DIRECTION,
      handle: withBody(['dailyBudgetCents', 'totalBudgetCents', 'maxCostPerContactCents'], async (s, v, [id], b) => reply(await publicite(s).approve(v, id, b))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/publicite/campagnes/${ID}/lancement$`),
      name: 'marketing.publicite.lancement',
      roles: DIRECTION,
      handle: async (s, v, [id]) => reply(await publicite(s).start(v, id)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/publicite/campagnes/${ID}/arret$`),
      name: 'marketing.publicite.arret',
      roles: DIRECTION,
      handle: async (s, v, [id]) => reply(await publicite(s).stop(v, id)),
    },
  ];
  return routes.map((route) => ({
    ...route,
    handle: async (s, v, params, request) => {
      if (route.roles.includes(v.role)) return route.handle(s, v, params, request);
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R16', role: String(v.role), kind: route.name, code: 'role' } }, s.now);
      return json(403, { ok: false, rule: 'R16', code: 'role' });
    },
  }));
}
