/**
 * Les statistiques du site (HX15), branchées dans le socle (BR41).
 *
 * Routes de l'application, sous `/v1/site` (le préfixe `/v1` est retiré par `app.ts`) :
 *   GET /site/statistiques[?jours=N]      chaque page avec ses vues, ses demandes, ses vendeurs et ses mandats [R286]
 *   GET /site/prochaine-page[?jours=N]    la prochaine page à écrire, avec les chiffres qui la font [R287]
 * La direction lit tout le réseau, l'agent actif sa page et ses biens ; un autre rôle est refusé avant toute lecture,
 * et le refus est écrit au journal [R16]. La période va de 7 à 365 jours (90 sans paramètre) ; un autre paramètre : 400.
 *
 * Les vues : chaque page publique d'un contenu de AT05 (bien, prix, agent, quartier, simulateur), servie en 200 par un
 * GET sur un site en service du réseau, compte une vue de son contenu, par `countView`, qui écarte les robots (RC12).
 * Rien du visiteur n'est gardé ni écrit au journal : ni adresse, ni navigateur, ni paramètre [R285, R156]. Un HEAD, la
 * page servie à l'adresse de l'API, une page de quartier sans code, un article de quartier ne comptent pas. Compter ne
 * change jamais la page servie : un échec est écrit au journal, sans rien du visiteur. Rien n'est envoyé.
 */
import { appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { OrigineContacts, type ContentKind } from '../../core/src/attirer/origine-contacts.ts';
import { StatistiquesSite } from '../../core/src/statistiques-site/statistiques.ts';

export const TRIAL_MODE = 'essai';
/** Les contenus dont la page publique compte ses vues. */
export type CountedKind = Extract<ContentKind, 'bien' | 'prix' | 'agent' | 'quartier' | 'simulateur'>;

export interface StatistiquesSiteServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

export interface StatistiquesSiteRoute {
  method: 'GET';
  pattern: RegExp;
  /** Nom de la route pour le journal. */
  name: string;
  handle: (s: StatistiquesSiteServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

const ROLES = ['agent', 'direction'];
const DAYS = /^[1-9][0-9]{0,2}$/;

/** Le refus d'un rôle, écrit au journal comme ceux de la couche métier, avant toute lecture [R16]. */
async function refuseRole(s: StatistiquesSiteServices, viewer: Viewer, route: string): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: `route.${route}`, code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

/** La période demandée : `jours` seul, entier écrit en chiffres ; sinon `undefined` (90 jours) ; un autre paramètre : `null`. */
function daysOf(url: URL): { days: number | undefined } | { field: string } | { bad: true } {
  for (const k of url.searchParams.keys()) if (k !== 'jours') return { field: k };
  const all = url.searchParams.getAll('jours');
  if (all.length === 0) return { days: undefined };
  if (all.length > 1 || !DAYS.test(all[0]!)) return { bad: true };
  return { days: Number(all[0]) };
}

type Outcome = { ok: true; [k: string]: unknown } | { ok: false; rule: 'R16' | null; code: string };

function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, ...data } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data });
  }
  if (result.rule === 'R16') return json(403, result);
  return json(400, result);
}

/** Les routes de `/v1/site`, à ajouter à celles de `app.ts`. */
export function statistiquesSiteRoutes(): StatistiquesSiteRoute[] {
  const route =
    (name: string, fn: (stats: StatistiquesSite, v: Viewer, days: number | undefined) => Promise<Outcome>): StatistiquesSiteRoute['handle'] =>
    async (s, v, _params, request) => {
      if (!ROLES.includes(String(v.role))) return refuseRole(s, v, name);
      const p = daysOf(new URL(request.url));
      if ('field' in p) return json(400, { ok: false, rule: null, code: 'unknown_field', field: p.field });
      if ('bad' in p) return json(400, { ok: false, rule: null, code: 'bad_period' });
      return reply(await fn(new StatistiquesSite(s.db, s.journal, { now: s.now }), v, p.days));
    };
  return [
    { method: 'GET', pattern: /^\/site\/statistiques$/, name: 'site.statistiques', handle: route('site.statistiques', (stats, v, days) => stats.pages(v, { days })) },
    { method: 'GET', pattern: /^\/site\/prochaine-page$/, name: 'site.prochaine_page', handle: route('site.prochaine_page', (stats, v, days) => stats.nextPage(v, { days })) },
  ];
}

/**
 * Compter la vue d'une page publique servie, sur un site en service du réseau. Le code du contenu est celui de AT05,
 * créé à la première demande comme pour l'origine des contacts ; une page de quartier ne compte que si elle a déjà le
 * sien (AT07). Seul le navigateur annoncé est passé, pour écarter les robots, jamais rangé [R285, RC12]. Ne lève jamais.
 */
export async function countPublicView(s: StatistiquesSiteServices, request: Request, networkId: string, kind: CountedKind, ref: string): Promise<void> {
  if (request.method !== 'GET') return;
  try {
    let code: string | null;
    if (kind === 'quartier') {
      const row = await s.db.first<{ id: string }>("SELECT id FROM public_contents WHERE network_id = ? AND kind = 'quartier' AND ref = ?", [networkId, ref]);
      code = row?.id ?? null;
    } else {
      const content = await new OrigineContacts(s.db, s.journal, { now: s.now }).contentFor(networkId, kind, ref);
      code = content.ok ? content.contentId : null;
    }
    if (code === null) return;
    await new StatistiquesSite(s.db, s.journal, { now: s.now }).countView(networkId, code, { userAgent: request.headers.get('user-agent') });
  } catch (error) {
    try {
      await appendEvent(s.journal, { type: 'site.vue_non_comptee', actor: 'public:site', subject: `network:${networkId}`, data: { kind, error: error instanceof Error ? error.name : 'unknown' } }, s.now);
    } catch {
      console.error('aimmo-api : vue non comptée, sans journal', kind);
    }
  }
}
