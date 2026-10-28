/**
 * Les routes de M11 Après la vente (F07), sous `/v1/apres-vente`, ses pages publiques sous `/apres-vente/`, et ses
 * passages au planificateur.
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrit chaque refus au journal. Rien n'est envoyé
 * réellement : demandes d'avis, remerciements et relances passent par le contrôle central, en mode essai [R26].
 *
 * Les pages publiques, sans clé, n'ont qu'un jeton tiré au hasard dans l'adresse, jamais un nom ni un chiffre :
 * - `/apres-vente/desinscription/<jeton>` : la désinscription des relances après la vente, en un geste [R65] ;
 * - `/apres-vente/avis/<jeton>` : la note de 1 à 5 et le commentaire du client, une seule fois (F05) [R64] ;
 * - `/apres-vente/carnet/<jeton>` : le carnet du propriétaire (F06), lisible par son lien seulement.
 * Leur adresse vient de la variable `APRES_VENTE_BASE` (`https://…/apres-vente/`) ; sans elle, aucune relance ne part
 * [R65], les demandes d'avis partent sans lien de satisfaction, et aucun carnet ne se fait.
 */
import { journalError } from './app.ts';
import {
  Acces,
  CarnetsProprietaire,
  DemandesAvis,
  FicheClient,
  FicheUnique,
  Recommandations,
  RelancesApresVente,
  Remerciements,
  Satisfaction,
  SqlBiensVendus,
  SqlDossiersClos,
  SqlJournalStore,
  afterSaleReminderJob,
  appendEvent,
  renderPublicPage,
  reviewRequestJob,
  thankYouJob,
  type CarnetMaker,
  type Geocoder,
  type JournalStore,
  type SalesSource,
  type ScheduledJob,
  type SqlDatabase,
  type Viewer,
} from '@aimmo/core';

export const TRIAL_MODE = 'essai';
export const APRES_VENTE_PATH = '/apres-vente/';
const MAX_BODY_BYTES = 8_000;
const ID = '([A-Za-z0-9_-]{1,64})';
/** La clé d'idempotence de la recommandation : 16 à 64 caractères tirés au hasard par l'application. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Le début des liens publics de l'après-vente : https, sans chiffre [R10], terminé par `/apres-vente/`. Rend `null`
 * pour une valeur absente ou fausse : les envois qui en ont besoin ne partent pas.
 */
export function apresVenteBase(base: string | undefined | null): string | null {
  if (!base) return null;
  return /^https:\/\/[^\s\d()/]+\/apres-vente\/$/.test(base) ? base : null;
}

export const afterSaleLinks = (base: string) => ({
  unsubscribe: `${base}desinscription/`,
  satisfaction: `${base}avis/`,
  carnet: `${base}carnet/`,
});

export interface ApresVenteServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface ApresVenteRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: ApresVenteServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

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
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => json(400, { ok: false, code: 'invalid_body', message: 'Corps JSON attendu.' });

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const services = (s: ApresVenteServices) => {
  const dossiers = new SqlDossiersClos(s.db);
  const store = new FicheClient(s.db, { now: s.now });
  return {
    dossiers,
    recommandations: new Recommandations(s.db, store, new FicheUnique(s.db, store, { now: s.now }), s.acces, s.journal, { now: s.now }),
    avis: new DemandesAvis(s.db, s.journal, dossiers, { now: s.now }),
    relances: new RelancesApresVente(s.db, s.journal, dossiers, { now: s.now }),
    satisfaction: new Satisfaction(s.db, s.journal, { now: s.now }),
    remerciements: new Remerciements(s.db, s.journal, dossiers, { now: s.now }),
  };
};

/**
 * La recommandation, avec sa clé d'idempotence (reste de F01) : la même clé ne range qu'une recommandation, même en
 * deux envois simultanés ; le second reçoit la réponse du premier, ou 409 tant qu'il est en cours.
 */
async function recommend(s: ApresVenteServices, viewer: Viewer, personId: string, request: Request): Promise<Response> {
  const key = request.headers.get('idempotency-key') ?? '';
  if (!IDEMPOTENCY_KEY.test(key)) return json(400, { ok: false, code: 'idempotency_key', message: 'En-tête Idempotency-Key attendu, de 16 à 64 caractères.' });
  const body = await readJson(request);
  if (!body) return badBody();
  const actor = `${String(viewer.role)}:${viewer.userId}`;
  const hash = await sha256(`${viewer.networkId}\n${key}`);
  const taken = await s.db.run('INSERT INTO referral_requests (key_hash, network_id, actor, status, body, created_at, answered_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL) ON CONFLICT DO NOTHING', [
    hash,
    viewer.networkId,
    actor,
    s.now().toISOString(),
  ]);
  if (taken.changes !== 1) {
    const row = await s.db.first<{ actor: string; status: number | null; body: string | null }>('SELECT actor, status, body FROM referral_requests WHERE key_hash = ?', [hash]);
    if (!row || row.actor !== actor) return json(409, { ok: false, rule: null, code: 'idempotency_key_reused' });
    if (row.status === null || row.body === null) return json(409, { ok: false, rule: null, code: 'in_progress' });
    return json(row.status, JSON.parse(row.body));
  }
  const settle = (status: number, text: string) =>
    s.db.run('UPDATE referral_requests SET status = ?, body = ?, answered_at = ? WHERE key_hash = ? AND status IS NULL', [status, text, s.now().toISOString(), hash]);
  try {
    const result = await services(s).recommandations.recommend(viewer, personId, body);
    const response = reply(result as Outcome);
    await settle(response.status, await response.clone().text());
    return response;
  } catch (error) {
    // Une panne ne laisse jamais la clé « en cours » pour toujours : elle reçoit sa réponse finale, qui demande une
    // nouvelle saisie ; l'erreur suit son chemin vers le journal.
    try {
      await settle(500, JSON.stringify({ ok: false, rule: null, code: 'retry_with_new_key' }));
    } catch {
      // La base elle-même est en panne : l'erreur d'origine est celle qui compte.
    }
    throw error;
  }
}

/** Un dossier clos tel que l'écran « Après la vente » le montre : rien d'autre que ce que chaque liste permet [R16]. */
export interface ClosedFileView {
  fileId: string;
  reference: string | null;
  city: string | null;
  closedOn: string | null;
  clients: {
    personId: string;
    side: 'vendeur' | 'acquereur';
    firstName: string | null;
    thankYou: { draft: string; calledAt: string | null; decision: 'send' | 'decline' | null; sendStatus: string | null } | null;
    review: { status: string; dueDay: string } | null;
    reminders: { year: number; dueDay: string; status: string }[];
    satisfaction: { score: number; comment: string | null; answeredAt: string } | null;
  }[];
}

/** L'écran « Après la vente » : chaque dossier clos du lecteur, ses clients, et ce qui s'est passé pour chacun. */
async function closedFiles(s: ApresVenteServices, viewer: Viewer): Promise<Response> {
  const sv = services(s);
  // Les remerciements préparés sont à l'agent seul : la direction et la conformité voient le reste du dossier.
  const thanks = viewer.role === 'agent' ? await sv.remerciements.list(viewer) : { ok: true as const, value: [] };
  if (!thanks.ok) return reply(thanks);
  const reviews = await sv.avis.list(viewer);
  if (!reviews.ok) return reply(reviews);
  const reminders = await sv.relances.list(viewer);
  if (!reminders.ok) return reply(reminders);
  const notes = await sv.satisfaction.list(viewer);
  if (!notes.ok) return reply(notes);
  const files = new Map<string, ClosedFileView>();
  const client = (fileId: string, personId: string, side: 'vendeur' | 'acquereur') => {
    let f = files.get(fileId);
    if (!f) {
      f = { fileId, reference: null, city: null, closedOn: null, clients: [] };
      files.set(fileId, f);
    }
    let c = f.clients.find((x) => x.personId === personId);
    if (!c) {
      c = { personId, side, firstName: null, thankYou: null, review: null, reminders: [], satisfaction: null };
      f.clients.push(c);
    }
    return c;
  };
  for (const t of thanks.value) {
    const c = client(t.fileId, t.personId, t.side);
    c.firstName = t.firstName;
    c.thankYou = { draft: t.draft, calledAt: t.calledAt, decision: t.decision, sendStatus: t.sendStatus };
  }
  for (const r of reviews.value) client(r.fileId, r.personId, r.side).review = { status: r.status, dueDay: r.dueDay };
  // Une relance ou une note d'un dossier sans remerciement ni demande d'avis (passage arrivé après leur délai) : le
  // côté du client est lu dans le dossier clos, jamais deviné ; un client inconnu du dossier n'est pas montré.
  const sideOf = async (fileId: string, personId: string): Promise<'vendeur' | 'acquereur' | null> => {
    const known = files.get(fileId)?.clients.find((x) => x.personId === personId);
    if (known) return known.side;
    const sale = await sv.dossiers.byId(viewer.networkId, fileId);
    return sale?.clients.find((x) => x.personId === personId)?.side ?? null;
  };
  for (const r of reminders.value) {
    const side = await sideOf(r.fileId, r.personId);
    if (side) client(r.fileId, r.personId, side).reminders.push({ year: r.year, dueDay: r.dueDay, status: r.status });
  }
  for (const n of notes.value) {
    const side = await sideOf(n.fileId, n.personId);
    if (side) client(n.fileId, n.personId, side).satisfaction = { score: n.score, comment: n.comment, answeredAt: n.answeredAt };
  }
  for (const f of files.values()) {
    const sale = await sv.dossiers.byId(viewer.networkId, f.fileId);
    if (sale) {
      f.reference = sale.reference;
      f.city = sale.city;
      f.closedOn = sale.closedOn;
    }
    f.clients.sort((a, b) => (a.side === b.side ? a.personId.localeCompare(b.personId) : a.side === 'vendeur' ? -1 : 1));
  }
  const list = [...files.values()].sort((a, b) => (b.closedOn ?? '').localeCompare(a.closedOn ?? '') || a.fileId.localeCompare(b.fileId));
  return reply({ ok: true, value: list });
}

/** « Ma journée » après la vente : appels pour remercier, proches recommandés à appeler, tâches ouvertes. */
async function today(s: ApresVenteServices, viewer: Viewer): Promise<Response> {
  if (viewer.role !== 'agent') {
    await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'after_sale_day', code: 'role' } }, s.now);
    return reply({ ok: false, rule: 'R16', code: 'role' });
  }
  const sv = services(s);
  const thanks = await sv.remerciements.list(viewer, { open: true });
  if (!thanks.ok) return reply(thanks);
  const calls = await sv.recommandations.callsOf(viewer);
  if (!calls.ok) return reply(calls);
  const tasks = await sv.avis.openTasks(viewer);
  if (!tasks.ok) return reply(tasks);
  const references = new Map<string, string | null>();
  for (const id of new Set([...thanks.value.map((t) => t.fileId), ...tasks.value.map((t) => t.fileId)])) references.set(id, (await sv.dossiers.byId(viewer.networkId, id))?.reference ?? null);
  return reply({
    ok: true,
    value: {
      remercier: thanks.value
        .filter((t) => t.calledAt === null)
        .sort((a, b) => a.dueDay.localeCompare(b.dueDay) || a.fileId.localeCompare(b.fileId) || (a.side === b.side ? 0 : a.side === 'vendeur' ? -1 : 1))
        .map((t) => ({ fileId: t.fileId, personId: t.personId, firstName: t.firstName, side: t.side, reference: references.get(t.fileId) ?? null })),
      recommandations: calls.value,
      taches: tasks.value.map((t) => ({ fileId: t.fileId, kind: t.kind, reference: references.get(t.fileId) ?? null })),
    },
  });
}

/** Les routes de M11, à ajouter à celles de `app.ts`. */
export function apresVenteRoutes(): ApresVenteRoute[] {
  const withBody = (fn: (s: ApresVenteServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>): ApresVenteRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request);
    return body ? fn(s, v, params, body) : badBody();
  };
  const P = '^/apres-vente';
  return [
    { method: 'GET', pattern: new RegExp(`${P}/journee$`), name: 'apres_vente.journee', handle: (s, v) => today(s, v) },
    { method: 'GET', pattern: new RegExp(`${P}/dossiers$`), name: 'apres_vente.dossiers', handle: (s, v) => closedFiles(s, v) },
    { method: 'POST', pattern: new RegExp(`${P}/fiches/${ID}/recommandations$`), name: 'apres_vente.recommandation', handle: (s, v, [id], r) => recommend(s, v, id!, r) },
    { method: 'GET', pattern: new RegExp(`${P}/fiches/${ID}/recommandations$`), name: 'apres_vente.recommandations', handle: async (s, v, [id]) => reply(await services(s).recommandations.linksOf(v, id!)) },
    { method: 'GET', pattern: new RegExp(`${P}/appels$`), name: 'apres_vente.appels', handle: async (s, v) => reply(await services(s).recommandations.callsOf(v)) },
    { method: 'POST', pattern: new RegExp(`${P}/appels/${ID}/fait$`), name: 'apres_vente.appel_fait', handle: async (s, v, [id]) => reply(await services(s).recommandations.callDone(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/dossiers/${ID}/clients/${ID}/relances$`),
      name: 'apres_vente.choix_relances',
      handle: withBody(async (s, v, [file, person], b) => {
        if (typeof b.choice !== 'string' || typeof b.proof !== 'string') return badBody();
        return reply(await services(s).relances.recordChoice(v, file!, person!, { choice: b.choice as 'oui', proof: b.proof }));
      }),
    },
    { method: 'GET', pattern: new RegExp(`${P}/relances$`), name: 'apres_vente.relances', handle: async (s, v) => reply(await services(s).relances.list(v)) },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/lien-avis$`),
      name: 'apres_vente.lien_avis',
      // Le lien de la fiche Google de l'agent qui porte la clé ; la direction règle celui d'un agent par son id.
      handle: withBody(async (s, v, _p, b) => {
        if (typeof b.url !== 'string' || (b.agentId !== undefined && typeof b.agentId !== 'string')) return badBody();
        return reply(await services(s).avis.setReviewLink(v, typeof b.agentId === 'string' ? b.agentId : v.userId, b.url));
      }),
    },
    { method: 'GET', pattern: new RegExp(`${P}/demandes-avis$`), name: 'apres_vente.demandes_avis', handle: async (s, v) => reply(await services(s).avis.list(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/taches$`), name: 'apres_vente.taches', handle: async (s, v) => reply(await services(s).avis.openTasks(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/satisfaction$`), name: 'apres_vente.satisfaction', handle: async (s, v) => reply(await services(s).satisfaction.list(v)) },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/remerciements$`),
      name: 'apres_vente.remerciements',
      handle: async (s, v, _p, r) => reply(await services(s).remerciements.list(v, { open: new URL(r.url).searchParams.get('ouverts') === '1' })),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/dossiers/${ID}/clients/${ID}/remerciement$`),
      name: 'apres_vente.remerciement',
      handle: withBody(async (s, v, [file, person], b) => {
        if (b.decision !== 'send' && b.decision !== 'decline') return badBody();
        return reply(await services(s).remerciements.decide(v, file!, person!, b.decision));
      }),
    },
    { method: 'POST', pattern: new RegExp(`${P}/dossiers/${ID}/clients/${ID}/appele$`), name: 'apres_vente.appele', handle: async (s, v, [file, person]) => reply(await services(s).remerciements.markCalled(v, file!, person!)) },
  ];
}

/* ---------- Les pages publiques ---------- */

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(status: number, title: string, body: string): Response {
  const html = renderPublicPage({ title, body, kicker: 'Après la vente' });
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' },
  });
}

const unknownLink = (): Response => page(404, 'Lien inconnu', '<p>Ce lien n’est pas valable.</p>');

export interface ApresVentePublicConfig {
  db: SqlDatabase;
  now?: () => Date;
}

/** Une page publique de l'après-vente, ou `null` si l'adresse n'est pas à elle. */
export async function handleApresVentePublic(request: Request, config: ApresVentePublicConfig): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(APRES_VENTE_PATH)) return null;
  const now = config.now ?? (() => new Date());
  const journal = new SqlJournalStore(config.db);
  const [kind, token, ...rest] = url.pathname.slice(APRES_VENTE_PATH.length).split('/');
  if (rest.length > 0 || !token || !/^[a-z]{32}$/.test(token)) return unknownLink();
  const action = `${APRES_VENTE_PATH}${kind}/${token}`;

  if (kind === 'desinscription') {
    if (request.method === 'GET') {
      return page(200, 'Ne plus recevoir de nouvelles après la vente', `<p>Votre agent immobilier ne vous écrira plus au sujet de la vente, sur aucun canal.</p><form method="post" action="${action}"><button type="submit">Me désinscrire</button></form>`);
    }
    if (request.method !== 'POST') return page(405, 'Méthode non admise', '<p>Utilisez le bouton de la page.</p>');
    const relances = new RelancesApresVente(config.db, journal, new SqlDossiersClos(config.db), { now });
    if (!(await relances.unsubscribe(token))) return unknownLink();
    return page(200, 'C’est fait', '<p>Vous ne recevrez plus de nouvelles après la vente. Votre agent immobilier reste joignable si vous le souhaitez.</p>');
  }

  if (kind === 'avis') {
    const satisfaction = new Satisfaction(config.db, journal, { now });
    if (request.method === 'GET') {
      const state = await satisfaction.state(token);
      if (state === 'unknown') return unknownLink();
      if (state === 'used') return page(409, 'Déjà répondu', '<p>Une réponse a déjà été donnée avec ce lien. Merci.</p>');
      if (state === 'expired') return page(410, 'Lien expiré', '<p>Ce lien n’est plus valable. Votre agent immobilier reste joignable si vous le souhaitez.</p>');
      const notes = [1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="note" value="${n}" required><span>${n}</span></label>`).join('');
      return page(
        200,
        'Votre avis sur notre accompagnement',
        `<p>Une note de 1 à 5, et si vous le souhaitez quelques mots. Votre réponse reste entre vous et votre agent immobilier : elle n’est jamais publiée.</p>
<form method="post" action="${action}"><fieldset><legend>Votre note, de 1 (pas satisfait) à 5 (très satisfait)</legend><div class="notes">${notes}</div></fieldset>
<label for="commentaire">Un commentaire, si vous le souhaitez</label><textarea id="commentaire" name="commentaire" maxlength="1000"></textarea>
<button type="submit">Envoyer ma réponse</button></form>`,
      );
    }
    if (request.method !== 'POST') return page(405, 'Méthode non admise', '<p>Utilisez le bouton de la page.</p>');
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return page(400, 'Réponse illisible', '<p>Revenez à la page et utilisez son bouton.</p>');
    const text = await request.text();
    if (text.length > 8_000) return page(400, 'Réponse trop longue', '<p>Un commentaire tient en 1 000 caractères.</p>');
    const form = new URLSearchParams(text);
    const score = Number(form.get('note'));
    const outcome = await satisfaction.submit(token, { score, comment: form.get('commentaire') });
    if (outcome.ok) return page(200, 'Merci', '<p>Votre réponse est bien arrivée. Votre agent immobilier la lira.</p>');
    const messages: Record<string, [number, string, string]> = {
      unknown: [404, 'Lien inconnu', 'Ce lien n’est pas valable.'],
      used: [409, 'Déjà répondu', 'Une réponse a déjà été donnée avec ce lien. Merci.'],
      expired: [410, 'Lien expiré', 'Ce lien n’est plus valable. Votre agent immobilier reste joignable si vous le souhaitez.'],
      invalid_score: [400, 'Note manquante', 'Choisissez une note de 1 à 5, puis envoyez.'],
      invalid_comment: [400, 'Commentaire refusé', 'Un commentaire tient en 1 000 caractères, sans caractère spécial.'],
    };
    const [status, title, message] = messages[outcome.code] ?? [400, 'Réponse refusée', 'Revenez à la page et réessayez.'];
    return page(status, title, `<p>${message}</p>`);
  }

  if (kind === 'carnet') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return page(405, 'Méthode non admise', '<p>Cette page se lit seulement.</p>');
    // La lecture du carnet ne cherche aucune vente : le carnet est rangé tel qu'il a été fait et relu contre ses sources.
    const reader = new CarnetsProprietaire(config.db, journal, { factsOf: async () => null }, { coverage: async () => null, within: async () => [] }, { now, base: 'https://aimmo.invalid/carnet/' });
    const found = await reader.read(token);
    if (!found) return unknownLink();
    const [first, ...lines] = found.text.split('\n');
    let paragraphs = '';
    let items: string[] = [];
    const flush = () => {
      if (items.length > 0) paragraphs += `<ul>${items.join('')}</ul>`;
      items = [];
    };
    for (const l of lines) {
      if (l.startsWith('- ')) items.push(`<li>${escape(l.slice(2))}</li>`);
      else {
        flush();
        paragraphs += `<p>${escape(l)}</p>`;
      }
    }
    flush();
    return page(200, 'Le carnet de votre bien', `<p class="doux">${escape(first ?? '')}</p>${paragraphs}`);
  }

  return unknownLink();
}

/* ---------- Les passages au planificateur ---------- */

export interface ApresVenteJobsConfig {
  /** `APRES_VENTE_BASE`, déjà contrôlée par `apresVenteBase`. */
  base: string | null;
  /** Les ventes publiques (DVF) pour le carnet ; absentes, aucun carnet. */
  sales?: SalesSource | null;
  /** Le géocodeur du centre de la commune, pour la valeur du carnet ; absent, valeur « non communiquée ». */
  geocoder?: Geocoder | null;
  now?: () => Date;
}

/**
 * Les passages de M11 : demandes d'avis (F02) avec le lien de satisfaction (F05), remerciements (F03), relances
 * après la vente (F04) avec le carnet (F06). Les dossiers clos sont ceux de M10 (N06).
 */
export function apresVenteJobs(db: SqlDatabase, journal: JournalStore, config: ApresVenteJobsConfig): ScheduledJob[] {
  const now = config.now ?? (() => new Date());
  const dossiers = new SqlDossiersClos(db);
  const links = config.base ? afterSaleLinks(config.base) : null;
  const carnets: CarnetMaker | null =
    links && config.sales ? new CarnetsProprietaire(db, journal, new SqlBiensVendus(db, { geocoder: config.geocoder ?? null }), config.sales, { now, base: links.carnet }) : null;
  return [
    reviewRequestJob(db, journal, dossiers, { now, satisfactionBase: links?.satisfaction ?? null }),
    thankYouJob(db, journal, dossiers, { now }),
    afterSaleReminderJob(db, journal, dossiers, { now, unsubscribeBase: links?.unsubscribe ?? null, carnets }),
  ];
}

/** Une panne d'une page publique : au journal, sans donnée [R13]. */
export async function apresVentePublicError(db: SqlDatabase, error: unknown, now: () => Date): Promise<void> {
  await journalError(new SqlJournalStore(db), 'public:apres-vente', 'apres_vente.page', error, now);
}
