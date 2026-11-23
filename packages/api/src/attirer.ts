/**
 * Les routes de M01, Attirer (AT09), et ses pages publiques, branchées dans `app.ts` par AT11.
 *
 * Routes de l'application, sous `/v1/attirer` (le préfixe `/v1` est retiré par `app.ts`) :
 *   prix regroupés (AT01) : versions, zones, recalcul ; page de l'agent (AT03) : mentions, titulaire, aperçu ;
 *   référencement (AT04) : sites et plans ; origine des contacts (AT05) : mesure du mois ; fiche Google (AT06) :
 *   avis, réponses, validations, publications ; pages de quartier (AT07) : données, textes, validations ; tableau de
 *   mise en service (AU088) : les preuves déclarées par la direction et les fonctions qu'elles ferment [R675].
 * Chaque route dit les rôles qu'elle admet : un autre rôle est refusé avant que le corps soit lu, et le refus est écrit
 * au journal [R16]. La couche métier refait ses propres contrôles. Rien ne part réellement : fiche Google et IndexNow
 * restent en mode essai [R26].
 *
 * Pages publiques, servies sur le site du réseau et sur le site de chaque agent, reconnus par leur adresse (`public_sites`) :
 *   GET /                                          l'accueil du site, ses derniers biens et ses chemins [R220, R152]
 *   GET /biens                                     la liste des biens du site, chacun revérifié à la lecture [R220, R153]
 *   GET /agents, GET /prix                         les listes d'agents et de communes, sur le site du réseau [R14, R150, R152]
 *   GET /prix/:commune[/:quartier]                 la page de prix, seulement sur le site du réseau [R150, R151]
 *   GET /agents/:agent                             la page de l'agent, sur le site du réseau et sur le sien [R152]
 *   GET /quartiers/:commune/:quartier[/prix|/equipements]  la page de quartier ou son article validé [R155]
 *   GET, POST /estimation                          la fourchette de la commune de E05, sur les deux sites [R31, R10]
 *   GET /mentions-legales, /donnees-personnelles   depuis les réglages du réseau, ce qui manque se voit [R221, R10]
 *   GET /simulateur                                le simulateur de prêt, qui ne garde rien [R157]
 *   GET /preuve, /preuve.json                      le compte public de la preuve à Dijon, sur le site du réseau [R213]
 *   GET /sitemap.xml, /robots.txt                  le plan du site et ses consignes aux moteurs [R153]
 *   GET /chercher                                  la recherche en langage courant, sans connexion, jamais gardée (BR44) [R420, R421, R423]
 *   GET /neuf/:programme                           la grille publiée d'un programme neuf, sur le site du réseau (BR76) [R543, R544, R153]
 * Une adresse inconnue, un site hors service, une page non publiable : 404, sans rien dire de plus. Tant que le
 * chantier est en mode essai, les pages ne sont pas indexées (`x-robots-tag`, `robots.txt`).
 */
import { FicheClient, FicheUnique, Rapprochement, appendEvent, pilotage, renderPublicPage, type JournalStore, type Role, type SqlDatabase, type Viewer } from '@aimmo/core';
import { MentionsSite, siteReady, renderLegalNotice, renderPrivacyPage, withLegalLinks, OrigineContacts, PageAgent, QualiteAgent, PagesQuartier, PrixRegroupes, Referencement, HOME_LISTINGS, latestListings, parseListingsQuery, parseDirectoryPage, renderAgentsList, renderListingsPage, renderPricesList, renderSiteHome, renderNeighbourhoodPage, renderPricePage, selectListings, type IndexNowClient, type NeighbourhoodWriter, type PriceSalesSource } from '../../core/src/attirer/index.ts';
import { FicheGoogle, type GbpClient, type ReviewReplyWriter } from '../../core/src/attirer/fiche-google.ts';
import { loanSimulatorHeaders, renderLoanSimulatorPage } from '../../core/src/attirer/simulateur-pret.ts';
import type { DiffusionGate } from '../../core/src/acquereurs/rapprochement.ts';
import { handleEstimationPage, type EstimationPageConfig } from './estimation.ts';
import { countPublicView, type CountedKind } from './statistiques-site.ts';
import { RechercheLangage } from '../../core/src/recherche/langage-courant.ts';
import { keepPublished, parsePublicSearchQuery, publicSearchSteps, renderPublicSearchPage, type PublicSearchPageInput } from '../../core/src/recherche/page-publique.ts';
import { MiseEnService } from '../../core/src/conformite/mise-en-service.ts';
import { isRobotVisit } from '../../core/src/statistiques-site/robots.ts';
import { ProgrammesNeufs, renderNewBuildGrid } from '../../core/src/neuf-viager/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 16_000;
/** Un contour de commune va jusqu'à 2 000 points : cette seule route a sa propre limite. */
const ZONE_BODY_BYTES = 64_000;
const ID = '([A-Za-z0-9_-]{1,64})';
const SLUG = '([a-z0-9]+(?:-[a-z0-9]+)*)';
/** L'estimation en ligne de chaque site (E05). */
export const ESTIMATE_HREF = '/estimation';

export interface AttirerServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** `essai` tant que le plan ne l'a pas mis en service : rien ne part, aucune page n'est indexée [R26]. */
  mode?: 'essai' | 'reel';
  /** La lecture des ventes DVF ; absente, le recalcul des prix est refusé. */
  priceSales?: PriceSalesSource | null;
  /** IndexNow, Google Business Profile, rédactions par l'IA : absents, rien ne part et le texte de secours sert. */
  indexNow?: IndexNowClient | null;
  gbp?: GbpClient | null;
  /**
   * AU037 : la fiche Google seule passe en `reel` quand le Worker a rangé son vrai client (H07) ; les pages, IndexNow
   * et le reste de M01 gardent `mode`. Absent : celui de `mode`.
   */
  gbpMode?: 'essai' | 'reel';
  gbpWriter?: ReviewReplyWriter | null;
  neighbourhoodWriter?: NeighbourhoodWriter | null;
  diffusion?: DiffusionGate | null;
  /** Le réseau qui reçoit les candidatures de `/rejoindre` : seul son site y mène. */
  recruitingNetworkId?: string | null;
  /** La Base adresse nationale et les ventes de l'estimation en ligne (E05) ; absentes, la page dit qu'elle n'est pas ouverte. */
  estimation?: EstimationPageConfig['services'];
  estimationLimits?: EstimationPageConfig['limits'];
}

export interface AttirerRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : tout autre est refusé avant la lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: AttirerServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule?: string | null; code?: string; reason?: string };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    // Une réponse métier sans `value` porte ses champs à côté de `ok` (`siteId`, `id`, `mode`…) : ils deviennent `data`.
    const { ok: _ok, ...fields } = result as Record<string, unknown>;
    const data = 'value' in fields ? fields.value : Object.keys(fields).length > 0 ? fields : null;
    return json(200, { ok: true, mode: TRIAL_MODE, data: data ?? null });
  }
  const { ok: _ok, ...rest } = result;
  const rule = result.rule ?? null;
  if (rule === 'R16') return json(result.code === 'unknown' || result.code === 'agent_inconnu' ? 404 : 403, { ok: false, ...rest, rule });
  return json(rule ? 409 : 400, { ok: false, ...rest, rule });
}

const value = <T>(v: T): Outcome => ({ ok: true, value: v });

async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });

const services = (s: AttirerServices) => {
  const referencement = new Referencement(s.db, s.journal, { now: s.now, indexNow: s.indexNow ?? null, mode: s.mode ?? 'essai', recruitingNetworkId: s.recruitingNetworkId ?? null });
  const prices = s.priceSales ? new PrixRegroupes(s.db, s.journal, s.priceSales, { now: s.now }) : null;
  // La lecture des prix publiés n'utilise jamais la source des ventes.
  const readPrices = new PrixRegroupes(s.db, s.journal, NO_SALES, { now: s.now });
  return {
    referencement,
    prices,
    readPrices,
    pageAgent: new PageAgent(s.db, s.journal, { now: s.now }),
    qualite: new QualiteAgent(s.db, s.journal, { now: s.now }),
    origine: new OrigineContacts(s.db, s.journal, { now: s.now }),
    quartiers: new PagesQuartier(s.db, s.journal, { now: s.now, writer: s.neighbourhoodWriter ?? undefined, prices: readPrices, listings: referencement }),
    google: new FicheGoogle(s.db, s.journal, {
      now: s.now,
      client: s.gbp ?? undefined,
      writer: s.gbpWriter ?? undefined,
      // Le mode réel exige le vrai client : sans lui, rien ne part [R26].
      mode: s.gbp ? (s.gbpMode ?? s.mode ?? 'essai') : 'essai',
      ...(s.diffusion ? { diffusion: s.diffusion } : {}),
    }),
  };
};

/** Aucune vente n'est lue hors du recalcul : la lecture des prix publiés et les zones n'en ont pas besoin. */
const NO_SALES: PriceSalesSource = {
  coverage: async () => null,
  within: async () => [],
};

/** Le rôle d'abord : un rôle non admis est refusé, au journal, sans que le corps soit lu [R16, R13]. */
export function guarded(route: AttirerRoute): AttirerRoute['handle'] {
  return async (s, viewer, params, request) => {
    if (!route.roles.includes(viewer.role)) {
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: `route.${route.name}`, code: 'role' } }, s.now);
      return json(403, { ok: false, rule: 'R16', code: 'role' });
    }
    return route.handle(s, viewer, params, request);
  };
}

export function attirerRoutes(): AttirerRoute[] {
  const withBody =
    (fn: (s: AttirerServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>, maxBytes = MAX_BODY_BYTES): AttirerRoute['handle'] =>
    async (s, v, params, request) => {
      const body = await readJson(request, maxBytes);
      return body ? fn(s, v, params, body) : badBody();
    };
  const P = '^/attirer';
  const DIRECTION: readonly Role[] = ['direction'];
  const STAFF: readonly Role[] = ['agent', 'direction'];
  const routes: AttirerRoute[] = [
    // AT01 · prix regroupés
    { method: 'GET', pattern: new RegExp(`${P}/prix/versions$`), name: 'attirer.prix_versions', roles: DIRECTION, handle: async (s, v) => reply(value(await services(s).readPrices.versions(v.networkId))) },
    { method: 'GET', pattern: new RegExp(`${P}/prix/zones$`), name: 'attirer.prix_zones', roles: DIRECTION, handle: async (s, v) => reply(await services(s).readPrices.zones(v)) },
    // BR97 · les zones mises de côté du calcul, à retirer puis retracer (RC60) : nom, niveau et raison, jamais le contour.
    { method: 'GET', pattern: new RegExp(`${P}/prix/zones/a-refaire$`), name: 'attirer.prix_zones_a_refaire', roles: DIRECTION, handle: async (s, v) => reply(await services(s).readPrices.zonesToRedraw(v)) },
    { method: 'POST', pattern: new RegExp(`${P}/prix/zones$`), name: 'attirer.prix_zone', roles: DIRECTION, handle: withBody(async (s, v, _p, b) => reply(await services(s).readPrices.defineZone(v, b as never)), ZONE_BODY_BYTES) },
    { method: 'POST', pattern: new RegExp(`${P}/prix/zones/${ID}/retrait$`), name: 'attirer.prix_zone_retrait', roles: DIRECTION, handle: async (s, v, [id]) => reply(await services(s).readPrices.retireZone(v, id)) },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/prix/recalcul$`),
      name: 'attirer.prix_recalcul',
      roles: DIRECTION,
      handle: async (s, v) => {
        const prices = services(s).prices;
        if (!prices) return reply({ ok: false, rule: null, code: 'source_absente' });
        return reply(value(await prices.recompute(v.networkId)));
      },
    },
    // AT03 · page de l'agent ; AT16 · la lecture de l'écran
    {
      method: 'GET',
      pattern: new RegExp(`${P}/agents$`),
      name: 'attirer.agents',
      roles: DIRECTION,
      handle: async (s, v) => {
        const r = await services(s).pageAgent.network(v);
        if (!r.ok) return reply(r);
        const sites = new Map((await services(s).referencement.agentSiteSettings(v.networkId)).map((x) => [x.agentId, x]));
        const departed = await services(s).referencement.departedAgentSites(v.networkId);
        return reply(value({ ...r.value, departed, agents: r.value.agents.map((a) => ({ ...a, site: sites.has(a.agentId) ? { baseUrl: sites.get(a.agentId)!.baseUrl, active: sites.get(a.agentId)!.active } : null })) }));
      },
    },
    { method: 'POST', pattern: new RegExp(`${P}/agents/${ID}/mentions$`), name: 'attirer.agent_mentions', roles: DIRECTION, handle: withBody(async (s, v, [id], b) => reply(await services(s).pageAgent.setLegalMentions(v, id!, { rsacNumber: b.rsacNumber, rsacRegistry: b.rsacRegistry }))) },
    // Le titre écrit à côté du nom des agents, dans une liste fermée (AU012) [R07].
    { method: 'GET', pattern: new RegExp(`${P}/titre-agent$`), name: 'attirer.titre_agent_lu', roles: DIRECTION, handle: async (s, v) => reply(await services(s).qualite.title(v)) },
    { method: 'POST', pattern: new RegExp(`${P}/titre-agent$`), name: 'attirer.titre_agent', roles: DIRECTION, handle: withBody(async (s, v, _p, b) => reply(await services(s).qualite.setTitle(v, b.title))) },
    { method: 'POST', pattern: new RegExp(`${P}/titulaire$`), name: 'attirer.titulaire', roles: DIRECTION, handle: withBody(async (s, v, _p, b) => reply(await services(s).pageAgent.setCardHolder(v, b.holder))) },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/agents/${ID}/page$`),
      name: 'attirer.agent_page',
      roles: STAFF,
      handle: async (s, v, [id]) => {
        // Un agent ne voit que l'aperçu de sa propre page ; la direction, celle de chaque agent du réseau [R16].
        if (v.role === 'agent' && v.userId !== id) {
          await appendEvent(s.journal, { type: 'acces.refuse', actor: `agent:${v.userId}`, subject: null, data: { rule: 'R16', role: 'agent', kind: 'route.attirer.agent_page', code: 'not_assigned' } }, s.now);
          return json(403, { ok: false, rule: 'R16', code: 'not_assigned' });
        }
        const r = await services(s).pageAgent.inputFor(v.networkId, id!);
        if (r.ok) return reply(value({ publishable: true, missing: null }));
        if (r.rule === 'R16') return json(404, { ok: false, rule: 'R16', code: 'unknown' });
        return reply(value({ publishable: false, missing: r.reason }));
      },
    },
    // RS05 · mentions légales du site
    { method: 'GET', pattern: new RegExp(`${P}/mentions-site$`), name: 'attirer.site_mentions', roles: DIRECTION, handle: async (s, v) => reply(value(await new MentionsSite(s.db, s.journal, { now: s.now }).read(v.networkId))) },
    { method: 'POST', pattern: new RegExp(`${P}/mentions-site$`), name: 'attirer.site_mention', roles: DIRECTION, handle: withBody(async (s, v, _p, b) => reply(await new MentionsSite(s.db, s.journal, { now: s.now }).set(v, b))) },
    // AU088 · le tableau de mise en service : preuves déclarées par la direction, et les fonctions qu'elles ferment [R675]
    { method: 'GET', pattern: new RegExp(`${P}/mise-en-service$`), name: 'attirer.mise_en_service', roles: DIRECTION, handle: async (s, v) => reply(value(await new MiseEnService(s.db, s.journal, { now: s.now }).board(v.networkId))) },
    { method: 'POST', pattern: new RegExp(`${P}/mise-en-service$`), name: 'attirer.mise_en_service_preuve', roles: DIRECTION, handle: withBody(async (s, v, _p, b) => reply(await new MiseEnService(s.db, s.journal, { now: s.now }).declare(v, b))) },
    // AT04 · référencement
    { method: 'GET', pattern: new RegExp(`${P}/sites$`), name: 'attirer.sites', roles: DIRECTION, handle: async (s, v) => reply(value(await services(s).referencement.sites(v.networkId))) },
    { method: 'POST', pattern: new RegExp(`${P}/sites$`), name: 'attirer.site', roles: DIRECTION, handle: withBody(async (s, v, _p, b) => reply(await services(s).referencement.setSite(v, b))) },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/sites/${ID}/plan$`),
      name: 'attirer.site_plan',
      roles: DIRECTION,
      handle: async (s, v, [id]) => {
        const r = await services(s).referencement.sitemap(v.networkId, id!);
        return r.ok ? reply(value(r.entries)) : json(404, { ok: false, rule: null, code: r.code });
      },
    },
    // AT05 · origine des contacts
    { method: 'GET', pattern: new RegExp(`${P}/origine/(\\d{4}-\\d{2})$`), name: 'attirer.origine_mesure', roles: DIRECTION, handle: async (s, v, [month]) => {
      const r = await services(s).origine.measure(v, month);
      return reply(r.ok ? value(r.measure) : r);
    } },
    // AT06 · fiche Google
    { method: 'POST', pattern: new RegExp(`${P}/google/agents/${ID}/fiche$`), name: 'attirer.google_fiche', roles: DIRECTION, handle: withBody(async (s, v, [id], b) => reply(await services(s).google.setLocation(v, id!, { locationRef: b.locationRef, title: b.title, websiteUri: b.websiteUri }))) },
    // AU037 · la mise à jour des informations de la fiche : l'accusé de Google, ou l'échec et son geste.
    { method: 'POST', pattern: new RegExp(`${P}/google/agents/${ID}/informations$`), name: 'attirer.google_informations', roles: DIRECTION, handle: async (s, v, [id]) => reply(await services(s).google.sendInfo(v, id!)) },
    { method: 'GET', pattern: new RegExp(`${P}/google/agents/${ID}/avis$`), name: 'attirer.google_avis', roles: STAFF, handle: async (s, v, [id]) => reply(await services(s).google.reviews(v, id!)) },
    // AT14 · l'écran de la fiche : l'agent ouvre la sienne sans connaître son identifiant, la direction choisit un agent.
    { method: 'GET', pattern: new RegExp(`${P}/google/moi$`), name: 'attirer.google_moi', roles: ['agent'], handle: async (s, v) => reply(await services(s).google.screen(v, v.userId)) },
    { method: 'GET', pattern: new RegExp(`${P}/google/agents/${ID}$`), name: 'attirer.google_ecran', roles: STAFF, handle: async (s, v, [id]) => reply(await services(s).google.screen(v, id!)) },
    { method: 'POST', pattern: new RegExp(`${P}/google/agents/${ID}/lecture$`), name: 'attirer.google_lecture', roles: STAFF, handle: async (s, v, [id]) => reply(await services(s).google.readReviews(v, id!)) },
    { method: 'POST', pattern: new RegExp(`${P}/google/agents/${ID}/publication$`), name: 'attirer.google_publication', roles: STAFF, handle: async (s, v, [id]) => reply(await services(s).google.preparePost(v, id!)) },
    { method: 'POST', pattern: new RegExp(`${P}/google/avis/${ID}/brouillon$`), name: 'attirer.google_brouillon', roles: STAFF, handle: async (s, v, [id]) => reply(await services(s).google.draftReply(v, id)) },
    { method: 'POST', pattern: new RegExp(`${P}/google/avis/${ID}/reponse$`), name: 'attirer.google_reponse', roles: STAFF, handle: withBody(async (s, v, [id], b) => reply(await services(s).google.writeReply(v, id, b.body))) },
    { method: 'POST', pattern: new RegExp(`${P}/google/textes/${ID}/valider$`), name: 'attirer.google_valider', roles: STAFF, handle: async (s, v, [id]) => reply(await services(s).google.validate(v, id)) },
    { method: 'POST', pattern: new RegExp(`${P}/google/textes/${ID}/publier$`), name: 'attirer.google_publier', roles: STAFF, handle: async (s, v, [id]) => reply(await services(s).google.publish(v, id)) },
    { method: 'POST', pattern: new RegExp(`${P}/google/textes/${ID}/liberer$`), name: 'attirer.google_liberer', roles: DIRECTION, handle: async (s, v, [id]) => reply(await services(s).google.releaseClaim(v, id)) },
    // AT07 · pages de quartier ; AT13 · les lectures de l'écran
    { method: 'GET', pattern: new RegExp(`${P}/quartiers$`), name: 'attirer.quartiers', roles: DIRECTION, handle: async (s, v) => reply(await services(s).quartiers.zones(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/quartiers/${ID}/faits$`), name: 'attirer.quartier_faits', roles: DIRECTION, handle: async (s, v, [id]) => reply(await services(s).quartiers.facts(v, id)) },
    { method: 'POST', pattern: new RegExp(`${P}/quartiers/${ID}/faits$`), name: 'attirer.quartier_fait', roles: DIRECTION, handle: withBody(async (s, v, [id], b) => reply(await services(s).quartiers.recordFact(v, id, b as never))) },
    { method: 'POST', pattern: new RegExp(`${P}/quartiers/${ID}/brouillon$`), name: 'attirer.quartier_brouillon', roles: DIRECTION, handle: withBody(async (s, v, [id], b) => reply(await services(s).quartiers.draft(v, id, b.kind, b.topic))) },
    { method: 'POST', pattern: new RegExp(`${P}/quartiers/${ID}/texte$`), name: 'attirer.quartier_texte', roles: DIRECTION, handle: withBody(async (s, v, [id], b) => reply(await services(s).quartiers.write(v, id, b.kind, b.topic, b.title, b.body))) },
    { method: 'GET', pattern: new RegExp(`${P}/quartiers/${ID}/textes$`), name: 'attirer.quartier_textes', roles: DIRECTION, handle: async (s, v, [id]) => reply(await services(s).quartiers.drafts(v, id)) },
    { method: 'POST', pattern: new RegExp(`${P}/quartiers/textes/${ID}/valider$`), name: 'attirer.quartier_valider', roles: DIRECTION, handle: async (s, v, [id]) => reply(await services(s).quartiers.validate(v, id)) },
  ];
  return routes.map((r) => ({ ...r, handle: guarded(r) }));
}

/* ---------------------------------------------------------------- pages publiques */

const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function pageHeaders(type: string, mode: 'essai' | 'reel'): Record<string, string> {
  return {
    'content-type': type,
    'content-security-policy': PAGE_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'public, max-age=300',
    ...(mode === 'essai' ? { 'x-robots-tag': 'noindex, nofollow' } : {}),
  };
}

const notFound = (): Response => new Response('Page inconnue.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

export const PUBLIC_PATHS = {
  accueil: /^\/$/,
  liste: /^\/biens$/,
  agents: /^\/agents$/,
  listePrix: /^\/prix$/,
  prix: new RegExp(`^/prix/${SLUG}(?:/${SLUG})?$`),
  agent: new RegExp(`^/agents/${ID}$`),
  quartier: new RegExp(`^/quartiers/${SLUG}/${SLUG}(?:/(prix|equipements))?$`),
  estimation: /^\/estimation$/,
  mentions: /^\/mentions-legales$/,
  donnees: /^\/donnees-personnelles$/,
  simulateur: /^\/simulateur$/,
  preuve: /^\/preuve(\.json)?$/,
  plan: /^\/sitemap\.xml$/,
  robots: /^\/robots\.txt$/,
  chercher: /^\/chercher$/,
  neuf: new RegExp(`^/neuf/${ID}$`),
};

/** La page de la recherche publique : jamais en cache, jamais indexée, et son formulaire ne mène qu'à elle-même. */
const SEARCH_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const searchHeaders = (): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': SEARCH_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
});

/** Le site en service qui sert cette adresse, et son réseau ; `null` pour toute autre adresse. */
async function siteOf(s: AttirerServices, referencement: Referencement, origin: string) {
  const rows = await s.db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM public_sites WHERE base_url = ?', [origin]);
  for (const r of rows) {
    const site = (await referencement.sites(r.network_id)).find((x) => x.baseUrl === origin);
    if (site) return { networkId: r.network_id, site };
  }
  return null;
}

/** La page de référence d'un bien publié, telle que la vitrine la pose sur la page du bien [R153, R46]. */
export interface ListingReference {
  canonical: string;
  /** L'en-tête `Link` à poser sur la réponse. */
  link: string;
  /** Les données structurées, déjà échappées pour un `<script type="application/ld+json">`. */
  structuredData: string;
}

/**
 * Ce qu'un site du réseau fait de la page d'un bien (AT11) :
 *   `hors_site`  l'adresse demandée n'est pas un site en service (l'adresse de l'API) : la vitrine sert la page sans référence ;
 *   `masque`     le site d'un agent et le bien publié d'un autre agent, ou le site d'un autre réseau : la page n'y est pas
 *                servie, une seule page de référence [R153, R16] ;
 *   `reference`  la page de référence du bien, à poser sur la page ;
 *   `aucune`     un site en service, mais le bien n'y est pas publié : la vitrine décide seule (retiré, inconnu).
 */
export type ListingPresence = { kind: 'hors_site' } | { kind: 'masque' } | { kind: 'aucune' } | ({ kind: 'reference' } & ListingReference);

export async function listingPresence(s: AttirerServices, requestUrl: string, propertyId: string, propertyNetworkId?: string): Promise<ListingPresence> {
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return { kind: 'hors_site' };
  }
  const referencement = new Referencement(s.db, s.journal, { now: s.now, indexNow: null, mode: s.mode ?? 'essai' });
  const found = await siteOf(s, referencement, origin);
  if (!found) return { kind: 'hors_site' };
  // Le site d'un réseau ne sert jamais le bien d'un autre réseau [R16].
  if (propertyNetworkId !== undefined && propertyNetworkId !== found.networkId) return { kind: 'masque' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(propertyId)) return { kind: 'aucune' };
  // Le site d'un agent ne montre que les biens de son agent, quel que soit leur état (vendu, retiré, incomplet).
  if (found.site.kind === 'agent') {
    const owner = await s.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ? AND network_id = ?', [propertyId, found.networkId]);
    if (!owner || owner.agent_id !== found.site.agentId) return { kind: 'masque' };
  }
  const listing = (await referencement.published(found.networkId)).find((l) => l.propertyId === propertyId);
  if (!listing) return { kind: 'aucune' };
  const seo = await referencement.listingSeo(found.networkId, propertyId);
  if (!seo) return { kind: 'aucune' };
  return { kind: 'reference', canonical: seo.canonical, link: `<${seo.canonical}>; rel="canonical"`, structuredData: seo.structuredData };
}

/**
 * La page de référence d'un bien publié, pour la page du bien servie par la vitrine (P10) sur n'importe quel site du
 * réseau : son adresse unique (site de son agent s'il en a un en service, sinon celui du réseau), l'en-tête `Link` à
 * poser sur la réponse et les données structurées, sans adresse [R153, R46]. `null` quand l'adresse demandée n'est pas
 * un site en service, ou que le bien n'y est pas publié : la vitrine ne pose alors aucune page de référence.
 */
export async function listingReference(s: AttirerServices, requestUrl: string, propertyId: string): Promise<ListingReference | null> {
  const p = await listingPresence(s, requestUrl, propertyId);
  return p.kind === 'reference' ? { canonical: p.canonical, link: p.link, structuredData: p.structuredData } : null;
}

/**
 * Une page publique de M01, ou `null` quand le chemin n'en est pas une (la suite du Worker la cherche ailleurs).
 * Seules les méthodes GET et HEAD sont servies ; une page non publiable répond 404 [R150, R152, R155].
 */
export async function handleAttirerPublic(s: AttirerServices, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const kind = (Object.keys(PUBLIC_PATHS) as (keyof typeof PUBLIC_PATHS)[]).find((k) => PUBLIC_PATHS[k].test(path));
  if (!kind) return null;
  // Seule l'estimation reçoit un formulaire : elle dit elle-même les méthodes qu'elle admet.
  if (kind !== 'estimation' && request.method !== 'GET' && request.method !== 'HEAD') return new Response('Méthode non permise.', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
  const svc = services(s);
  const found = await siteOf(s, svc.referencement, url.origin);
  if (!found) return notFound();
  const { networkId, site } = found;
  const legal = new MentionsSite(s.db, s.journal, { now: s.now });
  // Une mention légale manque, ou une preuve de mise en service n'est pas valide : le site reste en essai, non indexé [R221, R675].
  const mode: 'essai' | 'reel' = s.mode === 'reel' && siteReady(await legal.read(networkId)) ? 'reel' : 'essai';
  const html = (body: string): Response => new Response(request.method === 'HEAD' ? null : withLegalLinks(body), { status: 200, headers: pageHeaders('text/html; charset=utf-8', mode) });
  const m = PUBLIC_PATHS[kind].exec(path)!;
  // La page servie compte une vue de son contenu (BR41) ; rien du visiteur, et compter ne change jamais la page [R285].
  const counted = async (res: Response, content: CountedKind, ref: string): Promise<Response> => {
    if (res.status === 200) await countPublicView(s, request, networkId, content, ref);
    return res;
  };
  // Une page qui montre des biens ne survit qu'une minute en cache au retrait de l'un d'eux [R220].
  const liveHtml = (body: string): Response => new Response(request.method === 'HEAD' ? null : withLegalLinks(body), { status: 200, headers: { ...pageHeaders('text/html; charset=utf-8', mode), 'cache-control': 'public, max-age=60' } });
  switch (kind) {
    case 'accueil': {
      // Sans la porte, rien n'est montré [R220].
      if (!s.diffusion) return notFound();
      const all = await svc.referencement.published(networkId);
      const checkedAt = s.now();
      const listings = await latestListings(site.kind === 'agent' ? all.filter((l) => l.agentId === site.agentId) : all, s.diffusion, networkId, checkedAt, HOME_LISTINGS);
      // Le nom de l'agent ne va jamais sans ses mentions [R152].
      const own = site.kind === 'agent' ? await svc.pageAgent.inputFor(networkId, site.agentId!) : null;
      const agent = own?.ok ? { agentId: own.input.agentId, name: `${own.input.firstName} ${own.input.lastName}`, mentions: own.input.mentions, title: own.input.title } : null;
      return liveHtml(renderSiteHome({ kind: site.kind, recruiting: s.recruitingNetworkId === networkId, agent, listings, checkedAt }));
    }
    case 'liste': {
      // Sans la porte, rien n'est montré [R220].
      const query = parseListingsQuery(url.searchParams);
      if (!query || !s.diffusion) return notFound();
      const all = await svc.referencement.published(networkId);
      const published = site.kind === 'agent' ? all.filter((l) => l.agentId === site.agentId) : all;
      const checkedAt = s.now();
      const selection = await selectListings(published, s.diffusion, networkId, checkedAt, query);
      if (!selection) return notFound();
      return liveHtml(renderListingsPage({ ...selection, query, checkedAt }));
    }
    case 'agents': {
      // Réservée au site du réseau : le site d'un agent ne parle que de lui [R153].
      if (site.kind !== 'reseau') return notFound();
      const number = parseDirectoryPage(url.searchParams);
      const list = number === null ? null : renderAgentsList(await svc.pageAgent.publicAgents(networkId), number);
      return list === null ? notFound() : html(list);
    }
    case 'listePrix': {
      if (site.kind !== 'reseau') return notFound();
      const number = parseDirectoryPage(url.searchParams);
      const list = number === null ? null : renderPricesList(await svc.referencement.priceCommunes(networkId), number);
      return list === null ? notFound() : html(list);
    }
    case 'prix': {
      // Les pages de prix vivent sur le site du réseau seulement : une seule page de référence [R153].
      if (site.kind !== 'reseau') return notFound();
      const prices = await svc.readPrices.communePrices(networkId, m[1]!);
      if (!prices) return notFound();
      const page = renderPricePage(prices, { communeSlug: m[1]!, quarterSlug: m[2] ?? null, estimateHref: ESTIMATE_HREF, siteUrl: site.baseUrl });
      return page.ok ? counted(html(page.html), 'prix', m[2] ? `${m[1]}/${m[2]}` : m[1]!) : notFound();
    }
    case 'agent': {
      // Le site d'un agent ne montre que la page de son agent.
      if (site.kind === 'agent' && site.agentId !== m[1]) return notFound();
      // Sans la porte, rien n'est montré : ses biens la passent comme sur la liste [R220].
      if (!s.diffusion) return notFound();
      const page = await svc.pageAgent.page(networkId, m[1]!, s.diffusion);
      return page.ok ? counted(liveHtml(page.html), 'agent', m[1]!) : notFound();
    }
    case 'quartier': {
      if (site.kind !== 'reseau') return notFound();
      const published = await svc.quartiers.published(networkId, m[1], m[2], m[3] ?? 'quartier');
      if (!published) return notFound();
      const page = renderNeighbourhoodPage(published, { siteUrl: site.baseUrl, estimateHref: ESTIMATE_HREF });
      // Seule la page du quartier compte, jamais ses articles : le contenu de AT07 est la page.
      if (!page.ok) return notFound();
      return m[3] ? html(page.html) : counted(html(page.html), 'quartier', `${m[1]}/${m[2]}`);
    }
    case 'estimation': {
      // Le rendez-vous : la page de l'agent sur son site si elle est publiable [R152], sinon l'accueil ; la liste sur le réseau.
      const own = site.kind === 'agent' ? await svc.pageAgent.inputFor(networkId, site.agentId!) : null;
      const appointmentHref = site.kind === 'reseau' ? '/agents' : own?.ok ? `/agents/${encodeURIComponent(site.agentId!)}` : '/';
      return handleEstimationPage(request, { db: s.db, networkId, services: s.estimation, limits: s.estimationLimits, now: s.now, mode, appointmentHref });
    }
    case 'mentions':
      return html(renderLegalNotice(await legal.read(networkId)));
    case 'donnees':
      return html(renderPrivacyPage(await legal.read(networkId)));
    case 'simulateur': {
      const headers = await loanSimulatorHeaders();
      return counted(new Response(request.method === 'HEAD' ? null : withLegalLinks(renderLoanSimulatorPage()), { status: 200, headers: { ...headers, ...(mode === 'essai' ? { 'x-robots-tag': 'noindex, nofollow' } : {}) } }), 'simulateur', 'simulateur');
    }
    case 'preuve': {
      // Le compte du réseau, sur son seul site : les pages d'agent ne le portent pas.
      if (site.kind !== 'reseau') return notFound();
      const proof = await new pilotage.SceauxPreuve(s.db, s.journal, { now: s.now }).servedPublication(networkId);
      if (m[1]) return new Response(request.method === 'HEAD' ? null : JSON.stringify(proof), { status: 200, headers: pageHeaders('application/json; charset=utf-8', mode) });
      return html(renderPublicPage({ title: 'La preuve à Dijon, mois par mois', kicker: 'Compte public', body: pilotage.proofPageBody(proof), robots: mode === 'essai' ? 'noindex' : 'index' }));
    }
    case 'plan': {
      const plan = await svc.referencement.sitemap(networkId, site.siteId);
      if (!plan.ok) return notFound();
      return new Response(request.method === 'HEAD' ? null : plan.xml, { status: 200, headers: { ...pageHeaders('application/xml; charset=utf-8', mode), 'cache-control': 'public, max-age=3600' } });
    }
    case 'chercher': {
      // Sans la porte, rien n'est montré [R220] ; la phrase n'est ni gardée, ni écrite au journal, ni comptée.
      const query = parsePublicSearchQuery(url.searchParams);
      if (!query || !s.diffusion) return notFound();
      const page = (status: number, input: PublicSearchPageInput): Response =>
        new Response(request.method === 'HEAD' ? null : withLegalLinks(renderPublicSearchPage(input)), { status, headers: searchHeaders() });
      if ('tooLong' in query) return page(400, { state: 'too_long', phrase: query.phrase });
      if (query.phrase === null) return page(200, { state: 'form' });
      // Un robot annoncé ne reçoit aucun bien : la liste publique reste son chemin, page par page [RC12].
      if (isRobotVisit(request.headers.get('user-agent'))) return page(200, { state: 'robot', phrase: query.phrase });
      const fiche = new FicheUnique(s.db, new FicheClient(s.db, { now: s.now }), { now: s.now });
      const recherche = new RechercheLangage(s.db, new Rapprochement(s.db, fiche, s.diffusion, s.journal, { now: s.now }), s.diffusion, s.journal, { now: s.now, limit: Number.MAX_SAFE_INTEGER });
      const found = await recherche.search(networkId, query.phrase, publicSearchSteps(query));
      const all = await svc.referencement.published(networkId);
      const published = site.kind === 'agent' ? all.filter((l) => l.agentId === site.agentId) : all;
      // La coupe à PUBLIC_SEARCH_LIMIT se fait après le tri par site : un bien de ce site n'est jamais évincé par d'autres.
      const kept = keepPublished(found, published);
      return page(200, {
        state: 'results',
        phrase: query.phrase,
        neighbours: query.neighbours,
        results: kept.results,
        near: kept.neighbours,
        proposedNeighbours: found.proposedNeighbours,
        ignored: found.search.ignored,
        understood: found.search.criteria.length,
        checkedAt: s.now(),
      });
    }
    case 'neuf': {
      // Une seule page de référence : le site du réseau, comme les prix [R153]. Seuls les lots publiables y sont [R543].
      if (site.kind !== 'reseau') return notFound();
      const grid = await new ProgrammesNeufs(s.db, s.journal, { now: s.now }).publishedGrid(networkId, m[1]!);
      if (!grid) return notFound();
      // Le contact mène à la page de l'agent du programme si elle est publiable [R152], jamais à son nom sur la grille.
      const owner = await s.db.first<{ agent_id: string }>('SELECT agent_id FROM new_programs WHERE id = ? AND network_id = ?', [grid.programId, networkId]);
      const own = owner ? await svc.pageAgent.inputFor(networkId, owner.agent_id) : null;
      const contactHref = own?.ok ? `/agents/${encodeURIComponent(owner!.agent_id)}` : '/agents';
      const page = renderNewBuildGrid({ grid, contactHref });
      // Un lot vendu ne survit qu'une minute en cache [R543].
      return liveHtml(renderPublicPage({ title: page.title, kicker: 'Programme neuf', body: page.body, robots: mode === 'essai' ? 'noindex' : 'index' }));
    }
    case 'robots': {
      // En essai, rien n'est indexé ; le plan est toujours déclaré, celui du site lui-même [R153].
      // La recherche publique n'est jamais parcourue par un moteur (BR44).
      const lines = ['User-agent: *', ...(mode === 'essai' ? ['Disallow: /'] : ['Disallow: /chercher', 'Allow: /']), `Sitemap: ${site.baseUrl}/sitemap.xml`, ''];
      return new Response(request.method === 'HEAD' ? null : lines.join('\n'), { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=3600' } });
    }
  }
}
