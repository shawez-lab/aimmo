/**
 * Les routes et la page de l'espace client (EC06) [R160, R161, R163, R164, R165, R16, R26, R201, R13].
 *
 * - Route de l'agent, sous `/v1/espaces` : `POST /espaces/personnes/<id>/ouvrir` (agent du client ou direction), qui
 *   ouvre l'espace d'une personne partie à un dossier, avec la preuve de son accord [R03, R160].
 * - Pages du client, sous `/espace/`, sans clé d'API : la séance est un cookie `__Host-` (HttpOnly, Secure,
 *   SameSite=Strict) donné à l'ouverture du lien ; seule son empreinte est rangée [R160].
 *   - `GET /espace/` : l'espace du client, ou la demande de lien par adresse mail ;
 *   - `POST /espace/demande` : la demande de lien, avec la même réponse pour toute adresse [R160] ;
 *   - `GET /espace/<jeton>` : une page avec un bouton ; `POST /espace/<jeton>` ouvre le lien. Un lien n'est jamais
 *     consommé par un simple affichage : les robots qui ouvrent les liens des mails pour les vérifier ne le brûlent pas ;
 *   - `POST /espace/favori`, `POST /espace/sortie` : les gestes de la page, sans script ;
 *   - `GET /espace/releve` : le relevé prouvé, en texte (EC05) ; `GET|POST /espace/verifier` : sa vérification, pour
 *     tout le monde, qui ne dit que « intact, fait le … » ou « modifié » [R164] ;
 *   - `POST /espace/api/visite|offre|piece|alertes` : les gestes du client en JSON, chacun passé au module qui le tient
 *     [R165] ;
 *   - `GET /espace/cles?bien=<id>` : les clés d'un bien du vendeur (BR53), lues seulement quand il ouvre ce lien : qui
 *     les a prises, pour quoi, jusqu'à quand, et leur retour ; un partenaire dit par son métier et sa raison sociale,
 *     jamais un nom de personne [R272, R665, R161].
 * - Toute écriture du client vérifie que la requête vient de la page elle-même (`Origin` présent et égal) ; les
 *   gestes en JSON exigent en plus l'en-tête `x-aimmo-espace: 1`.
 * - La page suit le système de design, sans script, sans ressource extérieure, sous 14 Ko compressés [R201].
 *
 * Ce fichier ne touche à aucun fichier du socle ; EC07 (voie 1) le branchera au routeur et au Worker.
 */
import { appendEvent, renderPublicPage, type Acces, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import {
  EntreeEspace,
  EspaceAcquereur,
  EspaceProprietaire,
  EspaceVendeur,
  ReleveEspace,
  type ClientParties,
  type ClientViewer,
  type GestesAcquereur,
  type ReleveKey,
  type SourcesAcquereur,
  type SourcesProprietaire,
  type SourcesVendeur,
} from '../../core/src/espaces/index.ts';
import type { SellerKeyEntry } from '../../core/src/cles/cles.ts';

export const ESPACE_PATH = '/espace/';
export const SESSION_COOKIE = '__Host-aimmo_espace';
export const MAX_ESPACE_BODY_BYTES = 32 * 1024;
/** Un relevé à vérifier : quelques centaines de lignes. */
export const MAX_RELEVE_BYTES = 512 * 1024;
const ID = '([A-Za-z0-9_-]{1,64})';
const TOKEN = /^[a-z]{40}$/;

export interface EspacesServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  acces: Acces;
  /** Le réseau de la page publique : un Worker sert un réseau. */
  networkId: string;
  parties: ClientParties;
  vendeur: SourcesVendeur;
  proprietaire: SourcesProprietaire;
  acquereur: SourcesAcquereur;
  gestes: GestesAcquereur;
  /** Les clés des biens du vendeur (BR53) ; absent : le suivi des clés n'est pas montré. */
  cles?: { forSeller(viewer: ClientViewer, propertyId: string): Promise<{ ok: true; value: SellerKeyEntry[] } | { ok: false; rule: 'R161'; code: string }> };
  /** Les clés du relevé ; vide : relevé indisponible [R164]. */
  releveKeys: readonly ReleveKey[];
  /** L'adresse de l'espace, en https, sans chiffre, terminée par `/espace/`. */
  baseUrl: string;
  newToken?: () => string;
  newId?: () => string;
}

type Role = Viewer['role'];

export interface EspacesRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  roles: readonly Role[];
  handle: (s: EspacesServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });

async function readJson(request: Request, max = MAX_ESPACE_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  if (Number(request.headers.get('content-length') ?? '0') > max) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readForm(request: Request, max = MAX_ESPACE_BODY_BYTES): Promise<URLSearchParams | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
  if (Number(request.headers.get('content-length') ?? '0') > max) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) return null;
  return new URLSearchParams(text);
}

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function espacesCore(s: EspacesServices) {
  const entree = new EntreeEspace(s.db, s.journal, s.parties, { now: s.now, baseUrl: s.baseUrl, ...(s.newToken ? { newToken: s.newToken } : {}), ...(s.newId ? { newId: s.newId } : {}) });
  return {
    entree,
    vendeur: new EspaceVendeur(s.vendeur, s.journal, { now: s.now }),
    proprietaire: new EspaceProprietaire(s.proprietaire, s.journal, { now: s.now }),
    acquereur: new EspaceAcquereur(s.db, s.acquereur, s.gestes, s.journal, { now: s.now, ...(s.newId ? { newId: s.newId } : {}) }),
    releve: new ReleveEspace(s.releveKeys, s.journal, { now: s.now }),
  };
}

/* ---------- La route de l'agent ---------- */

/** Les routes de l'agent, prêtes pour le routeur du socle (EC07) : le rôle d'abord, son refus au journal [R16]. */
export function espacesRoutes(): EspacesRoute[] {
  const routes: EspacesRoute[] = [
    {
      method: 'POST',
      pattern: new RegExp(`^/espaces/personnes/${ID}/ouvrir$`),
      name: 'espaces.ouvrir',
      roles: ['agent', 'direction'],
      handle: async (s, v, [id], request) => {
        const body = await readJson(request);
        if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body' });
        const r = await espacesCore(s).entree.invite(s.acces, v, id!, { consentProof: body.consentProof });
        if (r.ok) return json(200, { ok: true, mode: 'essai', data: r.value });
        return json(r.rule === 'R16' ? (r.code === 'unknown' ? 404 : 403) : r.rule ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
      },
    },
    {
      // BR98 · au plafond, où en sont les liens de la personne (RC61) : des comptes et une heure, jamais un lien ni une adresse [R160, R13].
      method: 'GET',
      pattern: new RegExp(`^/espaces/personnes/${ID}/liens$`),
      name: 'espaces.liens',
      roles: ['agent', 'direction'],
      handle: async (s, v, [id]) => {
        const r = await espacesCore(s).entree.linkAllowance(s.acces, v, id!);
        if (r.ok) return json(200, { ok: true, mode: 'essai', data: r.value });
        return json(r.rule === 'R16' ? (r.code === 'unknown' ? 404 : 403) : r.rule ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
      },
    },
  ];
  return routes.map((route) => ({
    ...route,
    handle: async (s, viewer, params, request) => {
      if (!route.roles.includes(viewer.role)) {
        await appendEvent(
          s.journal,
          { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: route.name, code: 'role' } },
          s.now,
        );
        return json(403, { ok: false, rule: 'R16', code: 'role' });
      }
      return route.handle(s, viewer, params, request);
    },
  }));
}

/* ---------- Les pages du client ---------- */

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };

const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(status: number, title: string, body: string, headers: Record<string, string> = {}): Response {
  return new Response(renderPublicPage({ title, body, kicker: 'Votre espace' }), { status, headers: { ...PAGE_HEADERS, ...headers } });
}

const redirect = (location: string, headers: Record<string, string> = {}): Response => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...headers } });

const cookie = (token: string, maxAge: number): string => `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

function sessionToken(request: Request): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) {
      const t = v.join('=');
      return TOKEN.test(t) ? t : null;
    }
  }
  return null;
}

/**
 * Une écriture vient-elle de la page elle-même ? Les navigateurs envoient `Origin` avec chaque POST : il doit être
 * présent et égal à celui de l'espace ; absent, `null` ou d'un autre site, l'écriture est refusée.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === new URL(request.url).origin;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Une date de la base, lue à l'heure de Paris : « 8 juin 2027 », avec l'heure si elle compte. */
export function frenchDate(iso: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (day) return `${Number(day[3])} ${MONTHS[Number(day[2]) - 1]} ${day[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year} à ${parts.hour} h ${parts.minute}`;
}

const euros = (n: number): string => `${new Intl.NumberFormat('fr-FR').format(n)} €`;

type F = { value: unknown; source?: string; at?: string; label?: string };
const isF = (x: unknown): x is F => !!x && typeof x === 'object' && 'value' in x && ('source' in x || 'label' in x);

/** Une donnée avec sa source et sa date, ou « non communiquée » [R163]. */
function shown(f: unknown, money = false): string {
  if (!isF(f) || f.value === null) return '<span class="doux">non communiquée</span>';
  const v = f.value;
  const text =
    typeof v === 'boolean'
      ? v
        ? 'oui'
        : 'non'
      : typeof v === 'number'
        ? money
          ? euros(v)
          : new Intl.NumberFormat('fr-FR').format(v)
        : Array.isArray(v)
          ? v.length === 0
            ? 'aucune'
            : v.map((x) => escape(String(x))).join(', ')
          : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)
            ? frenchDate(v)
            : typeof v === 'object' && v && 'lowEur' in v
              ? `de ${euros((v as unknown as { lowEur: number }).lowEur)} à ${euros((v as unknown as { highEur: number }).highEur)} le m²`
              : String(v);
  const safe = Array.isArray(v) ? text : escape(text);
  return `${safe} <small class="doux">${escape(f.source ?? '')}, ${escape(frenchDate(f.at ?? ''))}</small>`;
}

const row = (label: string, value: string): string => `<dt>${escape(label)}</dt><dd>${value}</dd>`;
const list = (title: string, items: string[], empty: string): string => `<h3>${escape(title)}</h3>${items.length === 0 ? `<p class="doux">${escape(empty)}</p>` : `<ul>${items.join('')}</ul>`}`;

function sellerHtml(biens: Extract<Awaited<ReturnType<EspaceVendeur['vue']>>, { ok: true }>['value'], keys: boolean): string {
  return biens
    .map(
      (b) => `<section><h2>${escape(b.reference)} · ${escape(b.city)}</h2>${keys ? `<p><a href="${ESPACE_PATH}cles?bien=${encodeURIComponent(b.propertyId)}">Qui a les clés de ce bien</a></p>` : ''}<dl>${row('Statut', shown(b.status))}${row('Prix du mandat', shown(b.price, true))}${row('Acte au plus tôt', shown(b.deed.date))}${row('Ce qui le retient', shown(b.deed.holds))}</dl>
${list('Visites', b.visits.map((v) => `<li>${shown(v.at)} · ${shown(v.state)}<br>${shown(v.report)}</li>`), 'Aucune visite pour l’instant.')}
${list('Offres', b.offers.map((o) => `<li>${shown(o.amount, true)} · net vendeur ${shown(o.netSeller, true)} · ${shown(o.state)}<br>Conditions : ${shown(o.conditions)} · valable jusqu’au ${shown(o.validUntil)}</li>`), 'Aucune offre pour l’instant.')}
${list('Documents', b.documents.map((d) => `<li>${escape(d.title)} · ${shown(d.signature)}${d.number.value === null ? '' : ` · n° ${shown(d.number)}`}</li>`), 'Aucun document.')}
${list('Rendez-vous', b.appointments.map((a) => `<li>${escape(a.kind)} · ${shown(a.at)} · ${shown(a.state)}</li>`), 'Aucun rendez-vous.')}
${list('Points de la semaine', b.weeklyPoints.map((w) => `<li>${shown(w.weekOf)}<br>${shown(w.text)}</li>`), 'Aucun point pour l’instant.')}</section>`,
    )
    .join('');
}

function ownerHtml(biens: Extract<Awaited<ReturnType<EspaceProprietaire['vue']>>, { ok: true }>['value']): string {
  return biens
    .map((b) => {
      const rentals = b.rentals
        .map(
          (r) => `<h3>Location ouverte le ${shown(r.openedAt)}</h3><dl>${row('État', shown(r.state))}${row('Loyer du bail', shown(r.lease.rent, true))}${row('Bail signé le', shown(r.lease.signedAt))}${row('Dossiers encore incomplets', String(r.waiting))}</dl>
${list('Candidatures complètes, dans l’ordre d’arrivée', r.applications.map((a) => `<li>N° ${a.rank} · reçue le ${shown(a.receivedAt)} · ${a.guarantors} garant${a.guarantors > 1 ? 's' : ''}<br>${a.pieces.map((p) => escape(p.label)).join(' ; ') || 'aucune pièce'}</li>`), 'Aucune candidature complète pour l’instant.')}`,
        )
        .join('');
      const value = b.value ? `<dl>${row(`Valeur à ${b.value.city}`, shown(b.value.range))}${row('Sources', b.value.sources.map(escape).join(' ; '))}</dl>` : '';
      return `<section><h2>${escape(b.reference)} · ${escape(b.city)}</h2>${value}${rentals}${list('Vos documents', b.documents.map((d) => `<li>${escape(d.title)} · ${shown(d.addedAt)}</li>`), 'Aucun document.')}</section>`;
    })
    .join('');
}

function buyerHtml(v: Extract<Awaited<ReturnType<EspaceAcquereur['vue']>>, { ok: true }>['value']): string {
  const props = v.properties.map(
    (p) => `<li><strong>${escape(p.reference)}</strong> · ${escape(p.kind)} à ${escape(p.city)} · ${shown(p.price, true)} · ${shown(p.surface)} m²${
      p.investor ? `<br>Rendement brut ${shown(p.investor.grossYield)} points de base · hypothèses : ${p.investor.hypotheses.map(escape).join(' ; ')}` : ''
    }<form method="post" action="${ESPACE_PATH}favori"><input type="hidden" name="bien" value="${escape(p.propertyId)}"><input type="hidden" name="favori" value="${p.favorite ? 'non' : 'oui'}"><button type="submit">${p.favorite ? 'Retirer des favoris' : 'Mettre en favori'}</button></form></li>`,
  );
  return `<section><h2>Votre recherche</h2><p>Alertes : ${v.alerts.requested ? 'demandées' : 'non demandées'}.</p>
${list('Biens proposés', props, 'Aucun bien proposé pour l’instant.')}
${list('Vos visites', v.visits.map((x) => `<li>${shown(x.at)} · ${shown(x.state)}</li>`), 'Aucune visite.')}
${list('Vos offres', v.offers.map((x) => `<li>${shown(x.amount, true)} · ${shown(x.state)}</li>`), 'Aucune offre.')}
${list('Vos dossiers', v.files.map((f) => `<li>Acte au plus tôt : ${shown(f.deedDate)} · prêt : ${shown(f.loan)}<br>${f.pieces.map((x) => `${escape(x.kind)} : ${shown(x.state)}`).join(' ; ')}</li>`), 'Aucun dossier.')}
${v.rentals.length > 0 ? list('Vos candidatures', v.rentals.map((r) => `<li>${escape(r.reference)} à ${escape(r.city)} · ${shown(r.state)}</li>`), '') : ''}</section>`;
}

/** Au plus tant de sorties dans la page, les plus récentes : la page tient son budget [R201]. */
export const MAX_KEY_ENTRIES = 50;

const APPOINTMENT_STATE: Record<NonNullable<SellerKeyEntry['appointment']>['state'], string> = { prevu: 'prévu', fait: 'fait', absent: 'personne n’est venu', annule: 'annulé' };

/** Les clés d'un bien, dites au vendeur : jamais le nom d'un visiteur ni d'une personne chez un partenaire [R272, R665]. */
function keysHtml(entries: readonly SellerKeyEntry[]): string {
  if (entries.length === 0) return '<p>Aucune clé de ce bien n’est sortie de l’agence depuis votre mandat.</p>';
  const items = entries.slice(0, MAX_KEY_ENTRIES).map((e) => {
    const who = e.partner
      ? `Remis à ${escape(e.partner.businessName)} (${escape(e.partner.trade.toLowerCase())}), sous la responsabilité de ${escape(e.agent)}`
      : `Pris par ${escape(e.agent)}`;
    const rdv = e.appointment ? `<br>Rendez-vous du ${escape(frenchDate(e.appointment.start))} au ${escape(frenchDate(e.appointment.end))} · ${APPOINTMENT_STATE[e.appointment.state]}` : '';
    const back = e.lost ? '<strong>Déclaré perdu</strong>' : e.returnedAt ? `Rendu le ${escape(frenchDate(e.returnedAt))}` : '<strong>Pas encore rendu</strong>';
    return `<li><strong>Trousseau n° ${e.number}</strong> · ${escape(e.label)}<br>${who}, le ${escape(frenchDate(e.takenAt))}, pour : ${escape(e.purpose)}${rdv}<br>${back}</li>`;
  });
  const older = entries.length - MAX_KEY_ENTRIES;
  return `<p>Chaque sortie d’une clé depuis votre mandat, de la plus récente à la plus ancienne. Le nom d’un visiteur n’est jamais montré.</p><ul>${items.join('')}</ul>${
    older > 0 ? `<p class="doux">Et ${older} sortie${older > 1 ? 's' : ''} plus ancienne${older > 1 ? 's' : ''}, que votre agent peut vous détailler.</p>` : ''
  }`;
}

const requestForm = (message = ''): string =>
  `${message}<p>Recevez par mail un lien personnel pour entrer dans votre espace. Il est valable 30 minutes et ne sert qu’une fois.</p><form method="post" action="${ESPACE_PATH}demande"><label for="adresse">Votre adresse mail</label><input id="adresse" name="adresse" type="email" autocomplete="email" required maxlength="254"><button type="submit">Recevoir mon lien</button></form><p><a href="${ESPACE_PATH}verifier">Vérifier un relevé</a></p>`;

/** Ce que voit un client dans sa séance : chacune de ses vues, selon ses côtés. */
async function spaceHtml(s: EspacesServices, viewer: ClientViewer): Promise<{ html: string; views: Record<string, unknown> }> {
  const c = espacesCore(s);
  const views: Record<string, unknown> = {};
  let html = '';
  if (viewer.sides.includes('vendeur')) {
    const r = await c.vendeur.vue(viewer);
    if (r.ok) {
      views.vente = r.value;
      html += sellerHtml(r.value, !!s.cles);
    }
  }
  if (viewer.sides.some((x) => x === 'proprietaire' || x === 'bailleur')) {
    const r = await c.proprietaire.vue(viewer);
    if (r.ok) {
      views.propriete = r.value;
      html += ownerHtml(r.value);
    }
  }
  if (viewer.sides.some((x) => x === 'acquereur' || x === 'investisseur' || x === 'candidat_locataire')) {
    const r = await c.acquereur.vue(viewer);
    if (r.ok) {
      views.recherche = r.value;
      html += buyerHtml(r.value);
    }
  }
  return { html, views };
}

/** Une page de l'espace client, ou `null` si l'adresse n'est pas à lui. */
export async function handleEspacePublic(request: Request, s: EspacesServices): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== ESPACE_PATH.slice(0, -1) && !url.pathname.startsWith(ESPACE_PATH)) return null;
  const path = url.pathname === ESPACE_PATH.slice(0, -1) ? '' : url.pathname.slice(ESPACE_PATH.length);
  const method = request.method;
  const c = espacesCore(s);
  const writing = method === 'POST';
  if (writing && !sameOrigin(request)) return page(403, 'Requête refusée', '<p>Revenez à votre espace et utilisez ses boutons.</p>');
  const session = async (): Promise<ClientViewer | null> => {
    const t = sessionToken(request);
    return t ? c.entree.session(t) : null;
  };

  if (path === '' && (method === 'GET' || method === 'HEAD')) {
    const viewer = await session();
    if (!viewer) return page(200, 'Votre espace', requestForm());
    const { html } = await spaceHtml(s, viewer);
    const releve = c.releve.available ? `<p><a href="${ESPACE_PATH}releve">Télécharger le relevé prouvé de mon espace</a></p>` : '';
    return page(200, 'Votre espace', `${html || '<p>Rien à montrer pour l’instant.</p>'}${releve}<form method="post" action="${ESPACE_PATH}sortie"><button type="submit">Me déconnecter</button></form>`);
  }

  if (path === 'demande' && writing) {
    const form = await readForm(request);
    await c.entree.requestLink(s.networkId, form?.get('adresse') ?? null);
    // La même réponse pour toute adresse, connue ou non [R160].
    return page(200, 'Votre demande est arrivée', '<p>Si cette adresse a un espace, un lien personnel vient d’y partir. Il est valable 30 minutes. Pensez à regarder vos courriers indésirables.</p>');
  }

  if (TOKEN.test(path)) {
    if (method === 'GET' || method === 'HEAD') {
      // Un simple affichage ne brûle pas le lien : seul le bouton l'ouvre.
      return page(200, 'Entrer dans votre espace', `<p>Ce lien vous est personnel.</p><form method="post" action="${ESPACE_PATH}${path}"><button type="submit">Entrer dans mon espace</button></form>`);
    }
    if (!writing) return page(405, 'Méthode non admise', '<p>Utilisez le bouton de la page.</p>');
    const opened = await c.entree.open(path);
    if (!opened.ok) return page(410, 'Ce lien n’est plus valable', requestForm('<p>Un lien ne sert qu’une fois, pendant 30 minutes. Demandez-en un nouveau.</p>'));
    const maxAge = Math.max(60, Math.floor((Date.parse(opened.value.expiresAt) - s.now().getTime()) / 1000));
    return redirect(ESPACE_PATH, { 'set-cookie': cookie(opened.value.sessionToken, maxAge) });
  }

  if (path === 'sortie' && writing) {
    const t = sessionToken(request);
    if (t) await c.entree.close(t);
    return redirect(ESPACE_PATH, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }

  if (path === 'favori' && writing) {
    const viewer = await session();
    if (!viewer) return redirect(ESPACE_PATH);
    const form = await readForm(request);
    const property = form?.get('bien') ?? '';
    if (form?.get('favori') === 'non') await c.acquereur.removeFavorite(viewer, property);
    else await c.acquereur.addFavorite(viewer, property);
    return redirect(ESPACE_PATH);
  }

  if (path === 'releve' && (method === 'GET' || method === 'HEAD')) {
    const viewer = await session();
    if (!viewer) return redirect(ESPACE_PATH);
    if (!c.releve.available) return page(503, 'Relevé indisponible', '<p>Le relevé n’est pas encore disponible. Votre espace reste lisible.</p>');
    const { views } = await spaceHtml(s, viewer);
    const made = await c.releve.make(viewer, 'votre espace', views);
    if (!made) return page(503, 'Relevé indisponible', '<p>Le relevé n’est pas encore disponible.</p>');
    return new Response(made.text, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="releve-espace.txt"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }

  if (path === 'verifier') {
    if (method === 'GET' || method === 'HEAD') {
      return page(200, 'Vérifier un relevé', `<p>Collez le relevé tel que vous l’avez reçu. La vérification dit seulement s’il est intact et quand il a été fait.</p><form method="post" action="${ESPACE_PATH}verifier"><label for="releve">Le relevé</label><textarea id="releve" name="releve" required rows="10"></textarea><button type="submit">Vérifier</button></form>`);
    }
    if (!writing) return page(405, 'Méthode non admise', '<p>Utilisez le bouton de la page.</p>');
    const form = await readForm(request, MAX_RELEVE_BYTES);
    const result = await c.releve.verify(form?.get('releve') ?? null);
    return result.status === 'intact'
      ? page(200, 'Relevé intact', `<p>Ce relevé est intact. Il a été fait le ${escape(frenchDate(result.madeAt))}.</p>`)
      : page(200, 'Relevé modifié', '<p>Ce relevé ne correspond pas à celui que le réseau a fait : il a été modifié, ou ce n’est pas un relevé d’AIMMO.</p>');
  }

  if (path === 'cles' && (method === 'GET' || method === 'HEAD')) {
    const viewer = await session();
    if (!viewer) return redirect(ESPACE_PATH);
    const back = `<p><a href="${ESPACE_PATH}">Revenir à votre espace</a></p>`;
    if (!s.cles) return page(503, 'Suivi des clés indisponible', `<p>Le suivi des clés n’est pas encore disponible dans votre espace. Votre agent peut vous dire qui a vos clés.</p>${back}`);
    const asked = url.searchParams.get('bien') ?? '';
    // Un identifiant mal formé n'entre jamais au journal tel quel : il est lu comme « ? », qu'aucun bien ne porte, et
    // son refus est écrit comme les autres [R16].
    const r = await s.cles.forSeller(viewer, /^[A-Za-z0-9_-]{1,64}$/.test(asked) ? asked : '?');
    // Un bien qui n'est pas le sien, ou plus depuis son mandat : la même réponse, rien sur le bien [R161].
    if (!r.ok) return page(403, 'Clés non visibles', `<p>Vous voyez seulement les clés d’un bien dont vous êtes aujourd’hui le vendeur, depuis votre mandat.</p>${back}`);
    return page(200, 'Les clés de mon bien', `${keysHtml(r.value)}${back}`);
  }

  const geste = /^api\/(visite|offre|piece|alertes)$/.exec(path);
  if (geste && writing) {
    if (request.headers.get('x-aimmo-espace') !== '1') return json(403, { ok: false, rule: null, code: 'origin' });
    const viewer = await session();
    if (!viewer) return json(401, { ok: false, rule: 'R160', code: 'session' });
    const body = await readJson(request);
    if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body' });
    const kind = geste[1]!;
    // Une pièce vise un dossier, une visite ou une offre un bien : chacun son seul champ.
    const field = kind === 'piece' ? body.fileId : body.propertyId;
    const target = typeof field === 'string' ? field : '';
    const input = typeof body.input === 'object' && body.input !== null && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {};
    const r =
      kind === 'visite'
        ? await c.acquereur.bookVisit(viewer, target, input)
        : kind === 'offre'
          ? await c.acquereur.writeOffer(viewer, target, input)
          : kind === 'piece'
            ? await c.acquereur.addFinancingPiece(viewer, target, input)
            : await c.acquereur.requestAlerts(viewer, input);
    if (r.ok) return json(200, { ok: true, mode: 'essai', data: r.value });
    return json(r.rule === 'R161' || r.rule === 'R165' ? 403 : r.code === 'agenda_indisponible' ? 503 : r.rule ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
  }

  return page(404, 'Page inconnue', `<p>Cette page n’existe pas. <a href="${ESPACE_PATH}">Revenir à votre espace</a></p>`);
}
