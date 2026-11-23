/**
 * Les routes de M08 Acquéreurs et visites (T08), sous `/v1/acquereurs`, `/v1/visites` et `/v1/points` :
 *
 *   GET  /acquereurs/projets/:projet/recherche          la recherche de l'acquéreur et ses versions
 *   POST /acquereurs/projets/:projet/recherche          une nouvelle version de la recherche [R50]
 *   POST /acquereurs/projets/:projet/recherche/confirmation  la recherche dite toujours d'actualité (AU074)
 *   GET  /acquereurs/projets/:projet/secteur            le secteur privé de la recherche (AU073)
 *   POST /acquereurs/projets/:projet/secteur            un rayon autour d'un lieu, un secteur dessiné, ou « aucun »
 *   POST /biens/:bien/position                          situer le bien depuis son adresse désignée
 *   GET  /acquereurs/biens/:bien                        les acquéreurs proposés pour un bien diffusable [R51]
 *   GET  /acquereurs/biens/:bien/carte                  la carte de la demande du bien
 *   POST /acquereurs/biens/:bien/whatsapp/:projet       le lien WhatsApp de l'agent, après le contrôle central
 *   POST /acquereurs/whatsapp/:message/envoye           l'agent dit que son message est parti
 *   POST /visites                                       fixer une visite, avec son bon [R40] ; durationMinutes ? (AU056) ; joinVisit ? (AU077)
 *   POST /rendez-vous                                   { personId, propertyId?, kind, start, durationMinutes? } (AU056)
 *   GET  /visites/alertes                               les alertes de sécurité du réseau (direction)
 *   POST /visites/alertes/:alerte                       l'alerte en un geste
 *   GET  /visites/alertes/:alerte                       l'état de son alerte : palier, accusé réel, acquittement (AU008)
 *   POST /visites/alertes/:alerte/acquittement          la direction acquitte l'alerte, l'escalade s'arrête (AU008)
 *   POST /visites/modeles                               une version du modèle de bon de visite (direction)
 *   POST /visites/modeles/:modele/validation            sa validation
 *   GET  /visites/:visite                               l'écran de la visite : bien, heure, bon, sécurité, compte rendu
 *   GET  /visites/:visite/bon                           le bon de visite
 *   POST /visites/:visite/bon/signature                 le bon signé sur papier, en secours
 *   POST /visites/:visite/bon/signature-en-ligne        { place: sur_place, channel?, consentProof? } (AU075) ; « distance »
 *                                                       attend les pages publiques (voie 1) : refusé d'ici là
 *   GET  /visites/:visite/bon/a-signer                  le bon à lire sur le téléphone de l'agent, sur place (AU075)
 *   POST /visites/:visite/bon/signature-sur-place       { code, drawing? } : le visiteur signe sur place (AU075)
 *   GET  /visites/:visite/bon/exemplaire                l'exemplaire signé et sa preuve, à montrer au visiteur (AU075)
 *   POST /visites/:visite/annulation                    annuler la visite
 *   GET  /fiches/:fiche/visites-en-ligne                les visites réservées en ligne qui attendent (BR64)
 *   POST /visites/:rendez-vous/rattachement             { projectId } : la rattacher à la recherche, avec son bon (BR64)
 *   POST /visites/:visite/code                          le code envoyé au visiteur [R54]
 *   POST /visites/:visite/confirmation                  code et nom du visiteur [R54]
 *   POST /visites/:visite/compte-rendu/dictee           la dictée de l'agent
 *   POST /visites/:visite/compte-rendu/validation       la validation en un geste [R52]
 *   GET  /points?semaine=AAAA-MM-JJ                     les points de la semaine à valider
 *   GET  /points/:mandat/:semaine                       un point préparé [R53]
 *   POST /points/:mandat/:semaine/validation            sa validation avec les prochaines actions [R53]
 *
 * Chaque route passe par les droits de la couche métier, qui écrit chaque refus au journal [R16]. Aucune route
 * n'envoie elle-même : tout envoi passe par le contrôle central des envois, en mode essai [R26].
 */
import { base64Of, validTile, type TileSource } from './carte.ts';
import { AgendaUnavailableError, agendaBusyOf, type AgendaDirectory } from './agenda-reel.ts';
import {
  APPOINTMENT_KINDS,
  AlerteWhatsApp,
  CUSTOM_DURATION,
  ComptesRendus,
  Diffusion,
  FicheAcquereur,
  FicheClient,
  FicheUnique,
  INTEREST_LEVELS,
  PointSemaine,
  Rapprochement,
  RendezVous,
  Secteurs,
  SignatureBon,
  Visites,
  VisiteSecurisee,
  appendEvent,
  validDuration,
  type Acces,
  type AppointmentKind,
  type DirectionNotifier,
  type Geocoder,
  type JournalStore,
  type ReportWriter,
  type SqlDatabase,
  type Viewer,
  type VisitReport,
} from '@aimmo/core';

const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 16_000;
const ID = '([A-Za-z0-9_-]{1,64})';
const WEEK = '(\\d{4}-\\d{2}-\\d{2})';
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/;

export interface M08Services {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface M08Options {
  /** Début du lien de désinscription des alertes (`ALERT_UNSUBSCRIBE_BASE`) ; absent, aucun lien WhatsApp [R49]. */
  unsubscribeBase?: string | null;
  /** L'IA qui rédige le compte rendu (H13) ; absente, l'agent écrit lui-même. */
  reportWriter?: ReportWriter;
  /** Qui prévient la direction d'une alerte ; absent, l'essai : une ligne au journal. */
  notifier?: DirectionNotifier;
  /** La Base adresse nationale, pour situer un bien et le centre d'un rayon (AU073) ; absente, rien n'est géocodé. */
  geocoder?: Geocoder | null;
  /** AU073b · le fournisseur des tuiles de la carte des secteurs (`CARTE_TUILES_URL`) ; absent, la carte n'est pas branchée. */
  tiles?: TileSource | null;
  /** AU053 · les agendas reliés des agents (H21, H53) : un événement occupé refuse le rendez-vous [R33, R702]. */
  agendas?: AgendaDirectory | null;
}

export interface M08Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: M08Services, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
const failure = (status: number, code: string, message: string): Response => json(status, { ok: false, code, message });
const agendaClosed = (): Response => json(503, { ok: false, code: 'agenda_indisponible', rule: 'R702', message: 'Votre agenda n’a pas pu être lu : réessayez dans quelques minutes.' });
const badBody = (): Response => failure(400, 'invalid_body', 'Corps JSON attendu.');

type Outcome = { ok: true; [k: string]: unknown } | { ok: false; rule?: string | null; code: string; [k: string]: unknown };

/**
 * Une réponse de la couche métier. 403 pour un refus de droits, 404 pour un inconnu (rien n'est dit de son
 * existence), 409 pour une règle ou un état, 400 pour une saisie mal formée.
 */
export function reply(result: Outcome): Response {
  const { ok: _ok, ...rest } = result;
  if (result.ok) {
    const keys = Object.keys(rest);
    const data = keys.length === 1 && keys[0] === 'value' ? rest.value : rest;
    return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data });
  }
  const rule = result.rule ?? null;
  if (rule === 'R16') return json(result.code === 'unknown' ? 404 : 403, { ok: false, ...rest, rule });
  if (rule) return json(409, { ok: false, ...rest, rule });
  if (/^(bad|invalid)_/.test(result.code)) return json(400, { ok: false, ...rest, rule });
  return json(409, { ok: false, ...rest, rule });
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

const AGENT_BOOKING_FIELDS = new Set(['personId', 'propertyId', 'kind', 'start', 'durationMinutes']);
const durationHelp = `durationMinutes : des minutes entières, par pas de ${CUSTOM_DURATION.step}, de ${CUSTOM_DURATION.min} à ${CUSTOM_DURATION.max}.`;

/** La durée propre d'un rendez-vous (AU056) : absente, `{}` ; recevable, `{ durationMinutes }` ; sinon `null`. */
function durationOf(value: unknown): { durationMinutes?: number } | null {
  if (value === undefined || value === null) return {};
  return validDuration(value) ? { durationMinutes: value } : null;
}

/** Une saisie de compte rendu : seulement la forme connue, le contenu est contrôlé par la couche métier [R52]. */
function reportOf(value: unknown): VisitReport | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const list = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 8 && x.every((s) => typeof s === 'string' && s.length <= 200);
  if (typeof r.opinion !== 'string' || r.opinion.length > 1000 || !list(r.strengths) || !list(r.reservations)) return null;
  if (typeof r.interest !== 'string' || !(INTEREST_LEVELS as readonly string[]).includes(r.interest) || typeof r.readyToOffer !== 'boolean') return null;
  return { opinion: r.opinion, strengths: r.strengths, reservations: r.reservations, interest: r.interest as VisitReport['interest'], readyToOffer: r.readyToOffer };
}

/** Les routes de M08, à ajouter à celles de `app.ts`. */
export function m08Routes(options: M08Options = {}): M08Route[] {
  const fiche = (s: M08Services) => new FicheUnique(s.db, new FicheClient(s.db, { now: s.now }), { now: s.now });
  const diffusion = (s: M08Services) => new Diffusion(s.db, s.acces, s.journal, { now: s.now });
  const recherche = (s: M08Services) => new FicheAcquereur(s.db, s.journal, { now: s.now });
  const rapprochement = (s: M08Services) => new Rapprochement(s.db, fiche(s), diffusion(s), s.journal, { now: s.now });
  const whatsapp = (s: M08Services) => new AlerteWhatsApp(s.db, s.journal, s.acces, { now: s.now, unsubscribeBase: options.unsubscribeBase ?? null });
  // AU053 : la visite fixée par l'agent se contrôle sur son agenda relié, comme tout rendez-vous [R33, R702].
  const rendezVous = (s: M08Services) => {
    const agenda = agendaBusyOf(s.db, s.journal, options.agendas ?? null, s.now);
    return new RendezVous(s.db, s.journal, { now: s.now, ...(agenda ? { agenda } : {}) });
  };
  const visites = (s: M08Services) => new Visites(s.db, s.journal, s.acces, { now: s.now, rendezVous: rendezVous(s) });
  const securite = (s: M08Services) => new VisiteSecurisee(s.db, s.journal, visites(s), { now: s.now, ...(options.notifier ? { notifier: options.notifier } : {}) });
  const comptes = (s: M08Services) => new ComptesRendus(s.db, s.journal, visites(s), { now: s.now, ...(options.reportWriter ? { writer: options.reportWriter } : {}) });
  const signature = (s: M08Services) => new SignatureBon(s.db, s.journal, visites(s), { now: s.now });
  const points = (s: M08Services) => new PointSemaine(s.db, s.journal, s.acces, { now: s.now });
  const secteurs = (s: M08Services) => new Secteurs(s.db, s.acces, s.journal, options.geocoder ?? null, { now: s.now });
  const post = (name: string, path: string, run: (s: M08Services, v: Viewer, p: string[], body: Record<string, unknown>) => Promise<Response>): M08Route => ({
    method: 'POST',
    pattern: new RegExp(`^${path}$`),
    name,
    handle: async (s, v, p, request) => {
      const body = request.headers.get('content-length') === '0' || !request.body ? {} : await readJson(request);
      if (!body) return badBody();
      try {
        return await run(s, v, p, body);
      } catch (error) {
        // L'agenda relié de l'agent n'a pas pu être lu : rien n'est réservé, l'agent le sait [R702].
        if (error instanceof AgendaUnavailableError) return agendaClosed();
        throw error;
      }
    },
  });
  const get = (name: string, path: string, run: M08Route['handle']): M08Route => ({ method: 'GET', pattern: new RegExp(`^${path}$`), name, handle: run });

  return [
    // Acquéreurs.
    get('acquereurs.recherche', `/acquereurs/projets/${ID}/recherche`, async (s, v, [p]) => reply(await recherche(s).read(s.acces, v, p!))),
    post('acquereurs.recherche.modifier', `/acquereurs/projets/${ID}/recherche`, async (s, v, [p], body) => reply(await recherche(s).update(s.acces, v, p!, body))),
    // AU074 · L'acquéreur dit sa recherche toujours d'actualité : elle reste active, sans changer de critère.
    post('acquereurs.recherche.confirmer', `/acquereurs/projets/${ID}/recherche/confirmation`, async (s, v, [p]) => reply(await recherche(s).confirm(s.acces, v, p!))),
    // AU073 · le secteur privé de la recherche ; la position d'un bien, depuis son adresse désignée.
    get('acquereurs.secteur', `/acquereurs/projets/${ID}/secteur`, async (s, v, [p]) => reply(await secteurs(s).read(v, p!))),
    post('acquereurs.secteur.ranger', `/acquereurs/projets/${ID}/secteur`, async (s, v, [p], body) => reply(await secteurs(s).set(v, p!, body))),
    post('biens.position', `/biens/${ID}/position`, async (s, v, [b]) => reply(await secteurs(s).locate(v, b!))),
    // AU073b · centrer la carte sur un lieu dit, puis ses tuiles, par le Worker : rien du client ne part.
    get('acquereurs.secteur.lieu', `/acquereurs/projets/${ID}/secteur/lieu`, async (s, v, [p], request) => reply(await secteurs(s).place(v, p!, new URL(request.url).searchParams.get('q')))),
    get('carte.tuile', '/carte/tuiles/(\\d{1,2})/(\\d{1,6})/(\\d{1,6})', async (s, v, [z, x, y]) => {
      if (v.role !== 'agent' && v.role !== 'direction') {
        // Le refus est écrit au journal avant la réponse, sans donnée [R16].
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: null, data: { rule: 'R16', role: String(v.role), kind: 'carte_tuile', code: 'role' } }, s.now);
        return json(403, { ok: false, rule: 'R16', code: 'role' });
      }
      if (!options.tiles) return json(404, { ok: false, rule: null, code: 'carte_absente' });
      if (!validTile(Number(z), Number(x), Number(y))) return json(400, { ok: false, rule: null, code: 'tuile' });
      let failure: string | null = null;
      const t = await options.tiles.tile(Number(z), Number(x), Number(y)).catch(() => ((failure = 'erreur'), null));
      if (!t) {
        // Une panne du fournisseur ne s'avale pas : une ligne au journal, sans la tuile ni le lecteur [R13].
        await appendEvent(s.journal, { type: 'carte.tuile_echec', actor: 'system:carte', subject: null, data: { code: failure ?? 'reponse' } }, s.now);
        return json(502, { ok: false, rule: null, code: 'tuile_indisponible' });
      }
      return new Response(JSON.stringify({ ok: true, data: { type: t.type, base64: base64Of(t.bytes) } }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=86400' } });
    }),
    get('acquereurs.bien', `/acquereurs/biens/${ID}`, async (s, v, [b]) => reply(await rapprochement(s).propose(s.acces, v, b!))),
    get('acquereurs.carte', `/acquereurs/biens/${ID}/carte`, async (s, v, [b]) => reply(await rapprochement(s).demandMap(s.acces, v, b!))),
    post('acquereurs.whatsapp', `/acquereurs/biens/${ID}/whatsapp/${ID}`, async (s, v, [b, p]) => reply(await whatsapp(s).prepare(v, b!, p!))),
    post('acquereurs.whatsapp.envoye', `/acquereurs/whatsapp/${ID}/envoye`, async (s, v, [m]) => reply(await whatsapp(s).confirm(v, m!))),

    // Visites. Les adresses fixes d'abord : « alertes » et « modeles » ne sont pas des visites.
    post('visites.fixer', '/visites', async (s, v, _p, body) => {
      const { propertyId, projectId, start } = body;
      if (typeof propertyId !== 'string' || typeof projectId !== 'string' || !new RegExp(`^${ID}$`).test(propertyId) || !new RegExp(`^${ID}$`).test(projectId)) {
        return failure(400, 'invalid_ids', 'propertyId et projectId attendus.');
      }
      if (typeof start !== 'string' || !INSTANT.test(start) || Number.isNaN(Date.parse(start))) return failure(400, 'invalid_start', 'start : un instant ISO en UTC.');
      const duration = durationOf(body.durationMinutes);
      if (duration === null) return failure(400, 'invalid_duration', durationHelp);
      // AU077 · rejoindre une visite déjà fixée, même bien, même agent, même heure : une visite groupée.
      const { joinVisit } = body;
      if (joinVisit !== undefined && (typeof joinVisit !== 'string' || !new RegExp(`^${ID}$`).test(joinVisit))) return failure(400, 'invalid_ids', 'joinVisit : le rendez-vous de la visite à rejoindre.');
      return reply(await visites(s).schedule(v, { propertyId, projectId, start: new Date(start), ...duration, ...(joinVisit !== undefined ? { joinVisit } : {}) }));
    }),
    // AU056 · Un rendez-vous de l'agent pour son client, avec sa durée propre : notaire 90 minutes, appel 10 minutes.
    post('rendez-vous.agent', '/rendez-vous', async (s, v, _p, body) => {
      const unknown = Object.keys(body).find((k) => !AGENT_BOOKING_FIELDS.has(k));
      if (unknown) return failure(400, 'unknown_field', `Champ non prévu : ${unknown}.`);
      const { personId, propertyId, kind, start } = body;
      if (typeof personId !== 'string' || !new RegExp(`^${ID}$`).test(personId)) return failure(400, 'invalid_ids', 'personId attendu.');
      if (propertyId !== undefined && propertyId !== null && (typeof propertyId !== 'string' || !new RegExp(`^${ID}$`).test(propertyId))) return failure(400, 'invalid_ids', 'propertyId non valable.');
      if (typeof kind !== 'string' || !(APPOINTMENT_KINDS as readonly string[]).includes(kind)) return failure(400, 'invalid_kind', `kind attendu parmi : ${APPOINTMENT_KINDS.join(', ')}.`);
      if (typeof start !== 'string' || !INSTANT.test(start) || Number.isNaN(Date.parse(start))) return failure(400, 'invalid_start', 'start : un instant ISO en UTC.');
      const duration = durationOf(body.durationMinutes);
      if (duration === null) return failure(400, 'invalid_duration', durationHelp);
      return reply(await rendezVous(s).bookAsAgent(v, s.acces, { personId, propertyId: (propertyId as string | null | undefined) ?? null, kind: kind as AppointmentKind, start: new Date(start), ...duration }));
    }),
    get('visites.alertes', '/visites/alertes', async (s, v) => reply(await securite(s).list(v))),
    post('visites.alerte', `/visites/alertes/${ID}`, async (s, v, [a]) => {
      const r = await securite(s).raise(v, a!);
      // Sans prévenant réel, la direction n'est prévenue que dans le journal d'essai : la réponse le dit.
      return reply(r.ok ? { ...r, trial: r.mode === 'essai' || (r.mode === null && !options.notifier) } : r);
    }),
    get('visites.alerte.etat', `/visites/alertes/${ID}`, async (s, v, [a]) => reply(await securite(s).status(v, a!))),
    post('visites.alerte.acquittement', `/visites/alertes/${ID}/acquittement`, async (s, v, [a]) => reply(await securite(s).acknowledge(v, a!))),
    post('visites.modele', '/visites/modeles', async (s, v, _p, body) =>
      typeof body.body === 'string' ? reply(await visites(s).createSlipTemplate(v, body.body)) : failure(400, 'invalid_template', 'body : le texte du modèle.'),
    ),
    post('visites.modele.validation', `/visites/modeles/${ID}/validation`, async (s, v, [t]) => reply(await visites(s).validateSlipTemplate(v, t!))),
    get('visites.visite', `/visites/${ID}`, async (s, v, [a]) => {
      const access = await visites(s).accessVisit(v, a!);
      if (!access.ok) return reply(access);
      const screen = await visitScreen(s, fiche(s), a!);
      // Le bien est relu sous les droits du lecteur : un bien vendu ou retiré d'un autre agent ne se montre plus [R16].
      const property = await s.acces.readProperty(v, screen.property.id);
      return reply({ ok: true, value: property.ok ? screen : { ...screen, property: null } });
    }),
    get('visites.bon', `/visites/${ID}/bon`, async (s, v, [a]) => reply(await visites(s).slipOf(v, a!))),
    post('visites.bon.signature', `/visites/${ID}/bon/signature`, async (s, v, [a], body) => {
      const { signedAt, scanRef } = body;
      if (typeof signedAt !== 'string' || !INSTANT.test(signedAt) || Number.isNaN(Date.parse(signedAt))) return failure(400, 'invalid_signed_at', 'signedAt : un instant ISO en UTC.');
      if (typeof scanRef !== 'string') return failure(400, 'invalid_scan', 'scanRef : la référence du bon numérisé.');
      return reply(await visites(s).recordPaperSignature(v, a!, { signedAt: new Date(signedAt), scanRef }));
    }),
    // AU075 · Le bon signé sans papier : sur le téléphone de l'agent avec le code du visiteur, ou à distance [R40, R03].
    post('visites.bon.en_ligne', `/visites/${ID}/bon/signature-en-ligne`, async (s, v, [a], body) => {
      if (Object.keys(body).some((k) => !['place', 'channel', 'consentProof'].includes(k))) return failure(400, 'unexpected_field', 'place, channel et consentProof seulement.');
      return reply(await signature(s).open(v, a!, { place: body.place, channel: body.channel, consentProof: body.consentProof }));
    }),
    get('visites.bon.a_signer', `/visites/${ID}/bon/a-signer`, async (s, v, [a]) => reply(await signature(s).readOnSite(v, a!))),
    post('visites.bon.sur_place', `/visites/${ID}/bon/signature-sur-place`, async (s, v, [a], body) => {
      if (Object.keys(body).some((k) => !['code', 'drawing'].includes(k))) return failure(400, 'unexpected_field', 'code et drawing seulement.');
      return reply(await signature(s).signOnSite(v, a!, { code: body.code, drawing: body.drawing }));
    }),
    get('visites.bon.exemplaire', `/visites/${ID}/bon/exemplaire`, async (s, v, [a]) => reply(await signature(s).copyOnSite(v, a!))),
    post('visites.annulation', `/visites/${ID}/annulation`, async (s, v, [a]) => reply(await visites(s).cancel(v, a!))),
    // BR64 · Les visites réservées en ligne d'une fiche, puis leur rattachement à la recherche [R16, R40, R42].
    get('visites.en_ligne', `/fiches/${ID}/visites-en-ligne`, async (s, v, [f], request) => {
      if ([...new URL(request.url).searchParams.keys()].length > 0) return failure(400, 'unexpected_field', 'Cette lecture ne prend aucun paramètre.');
      return reply(await visites(s).onlineToAttach(v, f!));
    }),
    post('visites.rattachement', `/visites/${ID}/rattachement`, async (s, v, [a], body) => {
      const { projectId } = body;
      if (typeof projectId !== 'string' || !new RegExp(`^${ID}$`).test(projectId) || Object.keys(body).length !== 1) return failure(400, 'invalid_project', 'projectId : le projet d’achat.');
      const r = await visites(s).attachOnline(v, { appointmentId: a!, projectId });
      // Seuls le rendez-vous et le bon sont rendus : jamais l'empreinte du lien du client.
      return reply(r.ok ? { ok: true, value: { appointmentId: r.visit.appointment.id, slip: r.visit.slip } } : r);
    }),
    post('visites.code', `/visites/${ID}/code`, async (s, v, [a], body) => reply(await securite(s).sendCode(v, a!, { consentProof: typeof body.consentProof === 'string' ? body.consentProof : '' }))),
    post('visites.confirmation', `/visites/${ID}/confirmation`, async (s, v, [a], body) => {
      const { code, lastName } = body;
      if (typeof code !== 'string' || code.length > 12 || typeof lastName !== 'string' || lastName.length > 80) return failure(400, 'invalid_confirmation', 'code et lastName attendus.');
      return reply(await securite(s).confirm(v, a!, { code, lastName }));
    }),
    post('visites.dictee', `/visites/${ID}/compte-rendu/dictee`, async (s, v, [a], body) => {
      const { dictation } = body;
      if (typeof dictation !== 'string' || dictation.trim() === '' || dictation.length > 5000) return failure(400, 'invalid_dictation', 'dictation : de 1 à 5 000 caractères.');
      return reply(await comptes(s).dictate(v, a!, dictation));
    }),
    post('visites.compte_rendu.validation', `/visites/${ID}/compte-rendu/validation`, async (s, v, [a], body) => {
      const report = reportOf(body.report);
      if (report === null) return failure(400, 'invalid_report', 'report : avis, points forts, réserves, intérêt, prêt à faire une offre.');
      return reply(await comptes(s).validate(v, a!, report));
    }),

    // Points de la semaine.
    get('points.liste', '/points', async (s, v, _p, request) => {
      const week = new URL(request.url).searchParams.get('semaine') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return failure(400, 'invalid_week', 'semaine : le lundi, AAAA-MM-JJ.');
      return reply(await pointsOf(s, points(s), v, week));
    }),
    get('points.point', `/points/${ID}/${WEEK}`, async (s, v, [m, w]) => reply(await points(s).read(v, m!, w!))),
    post('points.validation', `/points/${ID}/${WEEK}/validation`, async (s, v, [m, w], body) => {
      const actions = body.actions ?? [];
      if (!Array.isArray(actions)) return failure(400, 'invalid_actions', 'actions : une liste de phrases.');
      // Une décision de prix convenue, validée explicitement et liée au rendez-vous tenu avec le vendeur [R53].
      const decision = body.decisionPrix ?? null;
      if (decision !== null && (typeof decision !== 'object' || Array.isArray(decision))) return failure(400, 'invalid_price_decision', 'decisionPrix : { rendezVous, prix, confirme }.');
      const d = decision as { rendezVous?: unknown; prix?: unknown; confirme?: unknown } | null;
      return reply(await points(s).validate(v, m!, w!, actions as string[], d ? { appointmentId: d.rendezVous as string, priceEur: d.prix as number, confirmed: d.confirme === true } : null));
    }),
  ];
}

/** Ce que montre l'écran d'une visite ; appelé seulement après le contrôle des droits [R16]. Ni nom de famille ni coordonnée. */
async function visitScreen(s: M08Services, fiche: FicheUnique, appointmentId: string) {
  const v = (await s.db.first<{ start_at: string; end_at: string; status: string; property_id: string; project_id: string; person_id: string; reference: string; city: string | null }>(
    `SELECT a.start_at, a.end_at, a.status, vi.property_id, vi.project_id, vi.person_id, p.reference, p.city
     FROM visits vi JOIN appointments a ON a.id = vi.appointment_id JOIN properties p ON p.id = vi.property_id WHERE vi.appointment_id = ?`,
    [appointmentId],
  ))!;
  const slip = await s.db.first<{ status: string; mode: string; signed_at: string | null }>('SELECT status, mode, signed_at FROM visit_slips WHERE appointment_id = ?', [appointmentId]);
  const safety = await s.db.first<{ code_expires_at: string | null; code_hash: string | null; phone_confirmed_at: string | null; identity_confirmed_at: string | null }>(
    'SELECT code_expires_at, code_hash, phone_confirmed_at, identity_confirmed_at FROM visit_safety WHERE appointment_id = ?',
    [appointmentId],
  );
  const report = await s.db.first<{ report: string | null; source: string | null; status: string; delivery_status: string | null }>(
    'SELECT report, source, status, delivery_status FROM visit_reports WHERE appointment_id = ?',
    [appointmentId],
  );
  // AU075 : l'état de la signature sans papier, jamais un code ni un lien.
  const online = await s.db.first<{ status: string; place: string; copy_status: string | null }>(
    `SELECT status, place, copy_status FROM visit_slip_signatures WHERE appointment_id = ? AND status <> 'remplacee' ORDER BY CASE status WHEN 'signee' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
    [appointmentId],
  );
  const firstName = (await fiche.view(v.person_id)).members.map((m) => m.first_name).find((n) => n) ?? null;
  const confirmed = Boolean(safety?.phone_confirmed_at && safety.identity_confirmed_at);
  return {
    appointmentId,
    start: v.start_at,
    end: v.end_at,
    status: v.status,
    property: { id: v.property_id, reference: v.reference, city: v.city },
    projectId: v.project_id,
    visitor: { firstName },
    slip: slip ? { status: slip.status, mode: slip.mode, signed: slip.signed_at !== null, online: online ? { status: online.status, place: online.place, copy: online.copy_status } : null } : null,
    safety: confirmed ? 'confirmee' : safety?.code_hash ? 'code_envoye' : 'a_confirmer',
    report: report
      ? { status: report.status, source: report.source, report: report.report ? (JSON.parse(report.report) as VisitReport) : null, delivery: report.delivery_status }
      : null,
  };
}

/** Les points de la semaine que le lecteur peut lire : les siens pour un agent, ceux du réseau pour la direction [R16]. */
async function pointsOf(s: M08Services, points: PointSemaine, viewer: Viewer, week: string) {
  if (viewer.role !== 'agent' && viewer.role !== 'direction') {
    await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'weekly_point', code: 'role' } }, s.now);
    return { ok: false as const, rule: 'R16', code: 'role' };
  }
  const rows = await s.db.all<{ mandate_id: string; property_id: string; reference: string; status: string; delivery_status: string | null }>(
    `SELECT w.mandate_id, w.property_id, p.reference, w.status, w.delivery_status FROM weekly_points w JOIN properties p ON p.id = w.property_id
     WHERE w.network_id = ? AND w.week = ? ${viewer.role === 'agent' ? 'AND w.agent_id = ?' : ''} ORDER BY p.reference, w.mandate_id`,
    viewer.role === 'agent' ? [viewer.networkId, week, viewer.userId] : [viewer.networkId, week],
  );
  const list = [];
  for (const r of rows) {
    // Chaque point passe le contrôle de la fiche du vendeur : un agent parti ou une fiche réunie hors de ses droits ne le voit plus.
    const read = await points.read(viewer, r.mandate_id, week);
    if (!read.ok) continue;
    list.push({ mandateId: r.mandate_id, week, property: { id: r.property_id, reference: r.reference }, status: r.status, delivery: r.delivery_status, text: read.text });
  }
  return { ok: true as const, value: { week, points: list } };
}
