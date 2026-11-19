/**
 * Les routes de M07 Commercialiser (P09), sous `/v1/annonces`, et le passage de publication pour le planificateur.
 *
 * Ce fichier ne touche pas aux fichiers du socle : il expose `ANNONCE_ROUTES`, de la même forme que les routes de
 * `app.ts`, et `syncAnnonces` pour un passage toutes les 15 minutes. Leur branchement dans `app.ts` et `worker.ts`
 * (une ligne chacun) est laissé à la voie 1 du chantier, qui tient les fichiers du socle (PROTOCOLE, section 8).
 *
 * Chaque route passe par les droits de la couche métier [R16] ; les refus y sont écrits au journal. Aucune route ne
 * publie elle-même : la publication passe par la porte de diffusion, la liste de contrôle et la validation [R42, R43,
 * R47], au passage suivant ou par la route de passage immédiat.
 */
import { appendEvent, type Acces, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { commerces as m16, Diffusion } from '@aimmo/core';
import { annonces as m07 } from '@aimmo/core';

const { Annonces, DiffusionPortails, DiffusionSurveillee, FicheBien, MediasBien, MentionsAnnonce, MesureBiens, Publication, TextesPortails, shootingPlan } = m07;
type ListingChannel = m07.ListingChannel;
type PortalConnector = m07.PortalConnector;
type ListingWriter = m07.ListingWriter;
type PropertySheet = m07.PropertySheet;

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 64_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface AnnonceServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface AnnonceOptions {
  writer?: ListingWriter;
  channels?: readonly ListingChannel[];
  /** Les connecteurs réels des portails, un par accord de flux (H10). Absents : chaque portail souscrit est en essai. */
  portals?: readonly PortalConnector[];
}

export interface AnnonceRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: AnnonceServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
const failure = (status: number, code: string, message: string): Response => json(status, { ok: false, code, message });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** Une réponse de la couche métier : 200, 403 pour un refus de droits, 404 inconnu, 409 pour une règle, 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(403, { ok: false, ...rest });
  if (/^unknown|^no_/.test(result.code)) return json(404, { ok: false, ...rest });
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

const badBody = (): Response => failure(400, 'invalid_body', 'Corps JSON attendu.');

/** Les routes de M07, à ajouter à celles de `app.ts`. `options` porte l'IA et les canaux, absents : secours et essai. */
export function annonceRoutes(options: AnnonceOptions = {}): AnnonceRoute[] {
  const fiches = (s: AnnonceServices) => new FicheBien(s.db, s.acces, s.journal, { now: s.now });
  const mentions = (s: AnnonceServices) => new MentionsAnnonce(s.db, s.acces, s.journal, { now: s.now });
  const textes = (s: AnnonceServices) => new TextesPortails(s.db, s.acces, s.journal, { now: s.now });
  const annonces = (s: AnnonceServices) => new Annonces(s.db, s.acces, s.journal, { now: s.now, ...(options.writer ? { writer: options.writer } : {}) });
  const publication = (s: AnnonceServices) => new Publication(s.db, s.acces, s.journal, { now: s.now, ...(options.channels ? { channels: options.channels } : {}) });
  const surveillance = (s: AnnonceServices) => new DiffusionSurveillee(s.db, s.acces, s.journal, { now: s.now });
  const portails = (s: AnnonceServices) => new DiffusionPortails(s.db, s.acces, s.journal, { now: s.now, ...(options.portals ? { connectors: options.portals } : {}) });
  const medias = (s: AnnonceServices) => new MediasBien(s.db, s.acces, s.journal, { now: s.now });
  const mesure = (s: AnnonceServices) => new MesureBiens(s.db, s.acces, s.journal, { now: s.now });
  return [
    {
      method: 'GET',
      pattern: /^\/annonces$/,
      name: 'annonces.mes_biens',
      // Les biens que l'agent met en vente, pour l'écran « Mettre en vente » (P10) : les siens seulement, la direction
      // tout le réseau ; un agent parti ne voit plus rien [R16].
      handle: async (s, v) => {
        const refuse = async (code: string) => {
          await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: null, data: { rule: 'R16', role: String(v.role), kind: 'listing_list', code } }, s.now);
          return reply({ ok: false, rule: 'R16', code });
        };
        if (v.role !== 'agent' && v.role !== 'direction') return refuse('role');
        if (v.role === 'agent') {
          const agent = await s.db.first<{ status: string; network_id: string }>('SELECT status, network_id FROM agents WHERE id = ?', [v.userId]);
          if (agent?.status !== 'active' || agent.network_id !== v.networkId) return refuse('agent_inactive');
        }
        const rows = await s.db.all<{ id: string; reference: string; city: string | null; state: string | null }>(
          `SELECT p.id, p.reference, p.city,
             (SELECT lv.state FROM listing_versions lv WHERE lv.property_id = p.id ORDER BY lv.seq DESC LIMIT 1) AS state
           FROM properties p WHERE p.network_id = ? ${v.role === 'agent' ? 'AND p.agent_id = ?' : ''} AND p.status NOT IN ('sold', 'rented', 'withdrawn')
           ORDER BY p.reference, p.id LIMIT 200`,
          v.role === 'agent' ? [v.networkId, v.userId] : [v.networkId],
        );
        return reply({ ok: true, value: rows.map((r) => ({ id: r.id, reference: r.reference, city: r.city, state: r.state })) });
      },
    },
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/fiche$`), name: 'annonces.fiche', handle: async (s, v, [id]) => reply(await fiches(s).read(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/fiche$`),
      name: 'annonces.fiche.enregistrer',
      handle: async (s, v, [id], request) => {
        // `siVersion` : rien n'est rangé si la fiche a changé depuis sa lecture (X19) ; une photo ajoutée entre-temps n'est jamais perdue.
        const asked = new URL(request.url).searchParams.get('siVersion');
        if (asked !== null && !/^\d{1,9}$/.test(asked)) return badBody();
        const body = await readJson(request);
        return body ? reply(await fiches(s).save(v, id!, body, asked === null ? {} : { ifVersion: Number(asked) })) : badBody();
      },
    },
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/controle$`), name: 'annonces.controle', handle: async (s, v, [id]) => reply(await mentions(s).check(v, id!)) },
    // AU114 · ce que montre chaque photo : sa légende sur la page, la fiche et les portails [R478].
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/photos/sujets$`), name: 'annonces.photos.sujets', handle: async (s, v, [id]) => reply(await textes(s).photoSubjects(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/photos/sujet$`),
      name: 'annonces.photos.sujet',
      handle: async (s, v, [id], request) => {
        const body = await readJson(request);
        if (!body || Object.keys(body).some((k) => k !== 'ref' && k !== 'subject')) return badBody();
        return reply(await textes(s).describePhoto(v, { propertyId: id!, ref: body.ref, subject: body.subject ?? null }));
      },
    },
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/brouillon$`), name: 'annonces.brouillon', handle: async (s, v, [id]) => reply(await annonces(s).read(v, id!)) },
    { method: 'POST', pattern: new RegExp(`^/annonces/${ID}/brouillon$`), name: 'annonces.brouillon.proposer', handle: async (s, v, [id]) => reply(await annonces(s).propose(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/correction$`),
      name: 'annonces.correction',
      handle: async (s, v, [id], request) => {
        const body = await readJson(request);
        return body ? reply(await annonces(s).correct(v, id!, { title: body.title, body: body.body })) : badBody();
      },
    },
    { method: 'POST', pattern: new RegExp(`^/annonces/brouillons/${ID}/validation$`), name: 'annonces.validation', handle: async (s, v, [id]) => reply(await annonces(s).validate(v, id!)) },
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/publication$`), name: 'annonces.publication', handle: async (s, v, [id]) => reply(await publication(s).status(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/publication$`),
      name: 'annonces.publication.passage',
      // Un passage immédiat pour ce bien, après une validation ou un avenant : mêmes portes que le passage planifié.
      handle: async (s, v, [id]) => {
        const status = await publication(s).status(v, id!);
        if (!status.ok) return reply(status);
        if (v.role !== 'agent' && v.role !== 'direction') {
          await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `property:${id}`, data: { rule: 'R16', role: String(v.role), kind: 'listing_sync', code: 'role' } }, s.now);
          return reply({ ok: false, rule: 'R16', code: 'role' });
        }
        const result = await publication(s).sync(v.networkId, id!);
        // Les portails souscrits suivent la version publiée, dans le même passage (AU004) [R668].
        if (!result.busy) await portails(s).sync(v.networkId, id!);
        return reply({ ok: true, value: result });
      },
    },
    // AU004 : le statut du bien sur chaque portail souscrit, avec son dernier accusé [R668, R16].
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/portails$`), name: 'annonces.portails', handle: async (s, v, [id]) => reply(await portails(s).status(v, id!)) },
    // Les portails réglés par la direction (HX38) : code (domaine), champs exigés, photos minimum, actif ou arrêté.
    {
      method: 'GET',
      pattern: /^\/annonces-portails$/,
      name: 'annonces.portails.reglages',
      handle: async (s, v) => {
        if (v.role !== 'direction') {
          await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: null, data: { rule: 'R16', role: String(v.role), kind: 'portal_settings', code: 'role' } }, s.now);
          return reply({ ok: false, rule: 'R16', code: 'role' });
        }
        return reply({ ok: true, value: await surveillance(s).portals(v.networkId) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/annonces-portails$/,
      name: 'annonces.portails.regler',
      handle: async (s, v, _p, request) => {
        const body = await readJson(request);
        if (!body) return badBody();
        return reply(await surveillance(s).setPortal(v, { code: body.code, label: body.label, host: body.host, requiredFields: body.requiredFields, minPhotos: body.minPhotos, active: body.active }));
      },
    },
    // L'agent du bien choisit ou écarte un portail pour son bien (HX38) ; écarté, l'annonce y est retirée au passage.
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/portails$`),
      name: 'annonces.portails.choisir',
      handle: async (s, v, [id], request) => {
        const body = await readJson(request);
        if (!body) return badBody();
        return reply(await surveillance(s).choose(v, id!, body.portal, body.chosen));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/annonces/${ID}/semaine$`),
      name: 'annonces.semaine',
      handle: async (s, v, [id], request) => reply(await mesure(s).weekly(v, id!, new URL(request.url).searchParams.get('lundi') ?? '')),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/videos/controle$`),
      name: 'annonces.video.controle',
      handle: async (s, v, [id], request) => {
        const body = await readJson(request);
        if (!body || typeof body.ref !== 'string') return badBody();
        return reply(await medias(s).checkVideoText(v, id!, body.ref, { subtitles: body.subtitles, caption: body.caption }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/annonces/${ID}/plan-de-tournage$`),
      name: 'annonces.plan_tournage',
      handle: async (s, v, [id]) => {
        const sheet = await fiches(s).read(v, id!);
        if (!sheet.ok && sheet.code !== 'no_sheet') return reply(sheet);
        const property = await s.db.first<{ rooms: number | null }>('SELECT rooms FROM properties WHERE id = ?', [id!]);
        const plan = shootingPlan({ rooms: property?.rooms ?? null, sheet: sheet.ok ? (sheet.value.sheet as PropertySheet) : null });
        return reply({ ok: true, value: plan });
      },
    },
  ];
}

/**
 * Un passage de publication pour un réseau, à lancer toutes les 15 minutes par le planificateur : publié partout en
 * moins d'une heure après la fin du délai de rétractation, prix répercuté en moins de 15 minutes.
 */
export async function syncAnnonces(s: AnnonceServices, networkId: string, options: AnnonceOptions = {}): Promise<{ properties: number; failed: number }> {
  const all = await new Publication(s.db, s.acces, s.journal, { now: s.now, ...(options.channels ? { channels: options.channels } : {}) }).syncAll(networkId);
  // AU004 : chaque portail souscrit reçoit la version publiée, la modification ou le retrait, avec son accusé [R668].
  await new DiffusionPortails(s.db, s.acces, s.journal, { now: s.now, ...(options.portals ? { connectors: options.portals } : {}) }).syncAll(networkId);
  // SV11 : un commerce suit sa présentation validée, sans annonce ni portail.
  const fiches = new m16.FicheCommerce(s.db, s.journal, { now: s.now });
  const presentations = new m16.PresentationCommerce(s.db, s.journal, fiches, new m16.EstimationCommerce(s.db, s.journal, fiches, { now: s.now }), { now: s.now });
  await new m16.DisponibiliteCommerces(s.db, s.journal, presentations, new Diffusion(s.db, s.acces, s.journal, { now: s.now }), { now: s.now }).syncAll(networkId);
  return { properties: all.length, failed: all.filter((r) => r.result === null).length };
}
