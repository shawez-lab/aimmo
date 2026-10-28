/**
 * Les routes de M18 Partenaires (U10), sous `/v1/partenaires`, la page publique d'opposition à la prospection sous
 * `/partenaires/opposition/<jeton>`, et l'espace partenaire en ligne sous `/partenaire/`.
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps de la
 * requête soit lu [R16]. Les droits fins (agent du projet, partenaire confié, justificatifs du jour) restent ceux de la
 * couche métier, qui écrit aussi ses refus au journal [R16, R73, R77].
 *
 * Rien n'est envoyé d'ici : relances et prospection sont préparées par la couche métier, en mode essai [R79, R01].
 * Aucune route ne rend de note, de rang ni d'avis transformé en tri [R14, R75]. Une pièce n'est jamais lue : seules
 * sa référence et son empreinte circulent ; le fichier déposé par un partenaire va au stockage, jamais au journal.
 */
import { appendEvent, localTime, renderPublicPage, SqlJournalStore, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import {
  Annuaire,
  EspacePartenaire,
  MiseEnRelation,
  PARTNER_TRADES,
  PIECE_RULES,
  PiecesPartenaires,
  Prospection,
  Remunerations,
  SuiviPartenaires,
  type FeeSettings,
  type FollowUpSummaryWriter,
  type PartnerTrade,
} from '../../core/src/partenaires/index.ts';
import { PARTNER_CSS, PARTNER_HTML, PARTNER_JS } from '../app/partenaire.ts';
import { journalError } from './app.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
/** Un fichier déposé par un partenaire : 10 Mo au plus, en PDF, JPEG ou PNG. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ID = '([A-Za-z0-9_-]{1,64})';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SORT = /^[a-z_]{2,40}$/;
const TIME_ZONE = 'Europe/Paris';

/** Une date du calendrier qui existe : « 2027-02-30 » est refusée. */
function realDay(v: string): boolean {
  if (!DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Le stockage des preuves et des pièces : seule l'existence d'une référence est lue, jamais son contenu. */
export interface PartnerFileStore {
  has(ref: string): Promise<boolean>;
}

/** Le dépôt d'un fichier par un partenaire, sous une référence choisie par le serveur. */
export interface PartnerUploadStore {
  put(ref: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** Le stockage R2 des fichiers de M18 : existence d'une référence et dépôt, jamais de lecture du contenu. */
export interface R2PartnerBucket {
  head(key: string): Promise<unknown | null>;
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export class R2PartnerFiles implements PartnerFileStore, PartnerUploadStore {
  constructor(private readonly bucket: R2PartnerBucket) {}
  async has(ref: string): Promise<boolean> {
    return (await this.bucket.head(ref)) !== null;
  }
  async put(ref: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(ref, bytes, { httpMetadata: { contentType } });
  }
}

export interface PartenairesServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** Preuves des justificatifs, preuves d'accord des clients, pièces déposées. */
  files: PartnerFileStore;
  /** Le dépôt des fichiers des partenaires ; absent, l'envoi d'un fichier est refusé (503) et rien n'est rangé. */
  uploads?: PartnerUploadStore | null;
  /** Le réglage du statut validé par l'avocat pour les courtiers et les banques (H31) ; faux par défaut [R76]. */
  fees?: FeeSettings;
  /** L'IA qui résume les réponses ; absente, le secours sans IA rend la même structure [R15]. */
  summaryWriter?: FollowUpSummaryWriter;
  /** Le début du lien d'opposition à la prospection (`https://…/partenaires/opposition/`). */
  optOutBase?: string | null;
  newId?: () => string;
}

type Role = Viewer['role'];

export interface PartenairesRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: PartenairesServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule, code } = result;
  if (rule === 'R16') return json(code === 'unknown' ? 404 : 403, { ok: false, rule, code });
  if (/^unknown/.test(code)) return json(404, { ok: false, rule, code });
  return json(rule ? 409 : 400, { ok: false, rule, code });
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

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body' });

const withBody =
  (fn: (s: PartenairesServices, v: Viewer, p: string[], b: Record<string, unknown>) => Promise<Response>) =>
  async (s: PartenairesServices, v: Viewer, p: string[], r: Request): Promise<Response> => {
    const body = await readJson(r);
    return body ? fn(s, v, p, body) : badBody();
  };

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function partenairesCore(s: PartenairesServices) {
  const opts = { now: s.now, ...(s.newId ? { newId: s.newId } : {}) };
  const annuaire = new Annuaire(s.db, s.files, s.journal, opts);
  const relations = new MiseEnRelation(s.db, annuaire, s.files, s.journal, opts);
  const espace = new EspacePartenaire(s.db, annuaire, relations, s.journal, { now: s.now });
  return {
    annuaire,
    relations,
    espace,
    remunerations: new Remunerations(s.db, relations, s.journal, { ...opts, ...(s.fees ? { settings: s.fees } : {}) }),
    pieces: new PiecesPartenaires(s.db, espace, relations, annuaire, s.files, s.journal, opts),
    suivi: new SuiviPartenaires(s.db, relations, s.journal, { ...opts, writer: s.summaryWriter }),
    prospection: new Prospection(s.db, s.journal, { ...opts, optOutBase: s.optOutBase ?? null }),
  };
}

const core = partenairesCore;

/* ---------- Le dépôt d'un fichier par un partenaire ---------- */

const UPLOAD_TYPES: readonly { type: string; ext: 'pdf' | 'jpg' | 'png'; magic: readonly number[] }[] = [
  { type: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { type: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readUpload(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_UPLOAD_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Le partenaire confié dépose une pièce. En JSON, une référence déjà rangée (`sort`, `ref`, `sha256`, `issuedOn`) ;
 * sinon le fichier lui-même, en PDF, JPEG ou PNG, avec `?sorte=…&faite_le=AAAA-MM-JJ` : le serveur contrôle l'accès,
 * la sorte et la date avant de ranger le fichier, choisit sa référence, calcule son empreinte, puis le range par la
 * règle écrite [R77, R78]. Le contenu n'est jamais lu au-delà de sa signature de format.
 */
async function deposit(s: PartenairesServices, viewer: Viewer, [id]: string[], request: Request): Promise<Response> {
  const c = core(s);
  const type = (request.headers.get('content-type') ?? '').toLowerCase().split(';')[0]!.trim();
  if (type === 'application/json') {
    const b = await readJson(request);
    if (!b) return badBody();
    return reply(await c.pieces.deposit(viewer, id, { sort: b.sort, ref: b.ref, sha256: b.sha256, issuedOn: b.issuedOn }));
  }
  // L'accès d'abord, avant de lire le moindre octet : un partenaire non confié ne range rien [R77].
  const access = await c.espace.access(viewer, id, { credentialsToday: false });
  if (!access.ok) return reply(access);
  const url = new URL(request.url);
  const sort = url.searchParams.get('sorte') ?? '';
  const issuedOn = url.searchParams.get('faite_le') ?? '';
  // Une sorte interdite ou illisible reçoit le refus de la couche métier (R15 au journal), sans rien ranger.
  // La couche métier contrôle la sorte avant la référence : une référence vide ne laisse passer que « bad_ref ».
  if (!SORT.test(sort)) return reply({ ok: false, rule: null, code: 'bad_sort' });
  const precheck = await c.pieces.deposit(viewer, id, { sort, ref: '', sha256: '', issuedOn });
  if (precheck.ok || precheck.code !== 'bad_ref') return reply(precheck);
  if (!realDay(issuedOn) || issuedOn > localTime(s.now(), TIME_ZONE).date) return reply({ ok: false, rule: null, code: 'bad_date' });
  const kind = UPLOAD_TYPES.find((t) => t.type === type);
  if (!kind) return json(415, { ok: false, rule: null, code: 'bad_type' });
  if (!s.uploads) return json(503, { ok: false, rule: null, code: 'storage_unavailable' });
  const bytes = await readUpload(request);
  if (!bytes) return json(413, { ok: false, rule: null, code: 'too_large' });
  if (bytes.byteLength < kind.magic.length || !kind.magic.every((b, i) => bytes[i] === b)) return json(415, { ok: false, rule: null, code: 'bad_type' });
  const ref = `partenaires/${viewer.userId}/relations/${id}/${crypto.randomUUID()}.${kind.ext}`;
  const sha256 = await sha256Hex(bytes);
  await s.uploads.put(ref, bytes, kind.type);
  const done = await c.pieces.deposit(viewer, id, { sort, ref, sha256, issuedOn });
  if (!done.ok) {
    // Le fichier est déjà au stockage : le refus est gardé au journal, sans sa référence ni son contenu [R13].
    await appendEvent(s.journal, { type: 'piece_partenaire.fichier_non_range', actor: `partner:${viewer.userId}`, subject: `referral:${id}`, data: { rule: done.rule, code: done.code, sort } }, s.now);
  }
  return reply(done);
}

/** Une note d'accord : 10 à 1 000 caractères, sans caractère de contrôle autre que le retour à la ligne. */
export const MAX_CONSENT_NOTE = 1000;
const CONSENT_CHANNEL_LABELS: Readonly<Record<string, string>> = Object.freeze({ oral: 'de vive voix', ecrit: 'par écrit', mail: 'par mail', sms: 'par SMS', whatsapp: 'par WhatsApp' });

/**
 * L'agent note l'accord du client, tel que le client l'a donné : le serveur range cette note comme preuve, sous une
 * référence qu'il choisit, et rend la référence, son empreinte et l'heure du serveur, que l'accord reprend ensuite
 * [R74]. Seulement pour une proposition encore ouverte, par l'agent du projet ou la direction [R16]. La note va au
 * stockage, jamais au journal : le journal garde l'empreinte seule [R13].
 */
async function consentNote(s: PartenairesServices, viewer: Viewer, [id]: string[], b: Record<string, unknown>): Promise<Response> {
  const c = core(s);
  const current = await c.relations.get(viewer, id);
  if (!current.ok) return reply(current);
  if (current.value.state !== 'proposee') return reply({ ok: false, rule: null, code: 'bad_state' });
  const channel = typeof b.channel === 'string' ? b.channel : '';
  if (!CONSENT_CHANNEL_LABELS[channel]) return reply({ ok: false, rule: 'R74', code: 'bad_channel' });
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (note.length < 10 || note.length > MAX_CONSENT_NOTE || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(note)) return reply({ ok: false, rule: 'R74', code: 'bad_note' });
  if (!s.uploads) return json(503, { ok: false, rule: null, code: 'storage_unavailable' });
  const at = s.now().toISOString();
  const text = [`Accord du client pour la mise en relation ${current.value.referralId}`, `Donné ${CONSENT_CHANNEL_LABELS[channel]}`, `Noté par ${viewer.role}:${viewer.userId}, le ${at}`, '', note, ''].join('\n');
  const bytes = new TextEncoder().encode(text);
  const proofRef = `relations/${current.value.referralId}/${crypto.randomUUID()}.txt`;
  const sha256 = await sha256Hex(bytes);
  await s.uploads.put(proofRef, bytes, 'text/plain; charset=utf-8');
  await appendEvent(s.journal, { type: 'mise_en_relation.preuve_accord', actor: `${viewer.role}:${viewer.userId}`, subject: `referral:${current.value.referralId}`, data: { rule: 'R74', channel, sha256 } }, s.now);
  return reply({ ok: true, value: { proofRef, sha256, at, channel } });
}

/** Les sortes qu'un partenaire peut déposer pour cette demande, avec leur nom en français. */
export const SORT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  dpe: 'Diagnostic de performance énergétique',
  amiante: 'Constat amiante',
  plomb: 'Constat de risque d’exposition au plomb',
  electricite: 'Diagnostic électricité',
  gaz: 'Diagnostic gaz',
  termites: 'État relatif aux termites',
  mesurage_carrez: 'Mesurage loi Carrez',
  bornage: 'Plan de bornage',
  titre_propriete: 'Titre de propriété',
  pre_etat_date: 'Pré-état daté',
  projet_compromis: 'Projet de compromis',
  projet_acte: 'Projet d’acte',
  accord_principe: 'Accord de principe',
  offre_pret: 'Offre de prêt',
  devis: 'Devis',
});

export function sortsFor(trade: PartnerTrade, domain: string | null): { sort: string; label: string }[] {
  return Object.entries(PIECE_RULES)
    .filter(([, r]) => r.trades.includes(trade) && (trade !== 'diagnostiqueur' || r.to !== 'diagnostic' || r.domain === domain))
    .map(([sort]) => ({ sort, label: SORT_LABELS[sort] ?? sort }));
}

const tradeLabel = (trade: PartnerTrade): string => PARTNER_TRADES.find((t) => t.trade === trade)?.label ?? trade;

/* ---------- Les routes ---------- */

const STAFF: readonly Role[] = ['agent', 'direction'];
const READERS: readonly Role[] = ['agent', 'direction', 'compliance'];
const PARTNER: readonly Role[] = ['partner'];
const DIRECTION: readonly Role[] = ['direction'];

const ROUTES: PartenairesRoute[] = [
  /* L'annuaire (U01) : la recherche ne rend ni note, ni rang, ni avis [R73, R14]. */
  {
    method: 'GET',
    pattern: /^\/partenaires\/annuaire$/,
    name: 'partenaires.annuaire.recherche',
    roles: READERS,
    handle: async (s, v, _p, r) => {
      const q = new URL(r.url).searchParams;
      return reply(await core(s).annuaire.search(v, { trade: q.get('metier'), postcode: q.get('cp'), domain: q.get('domaine') ?? undefined }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/partenaires\/annuaire$/,
    name: 'partenaires.annuaire.ajout',
    roles: STAFF,
    handle: withBody(async (s, v, _p, b) => reply(await core(s).annuaire.addPartner(v, { trade: b.trade, businessName: b.businessName, postcodes: b.postcodes }))),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/partenaires/annuaire/${ID}$`),
    name: 'partenaires.annuaire.fiche',
    roles: READERS,
    handle: async (s, v, [id]) => reply(await core(s).annuaire.status(v, id!)),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/annuaire/${ID}/zones$`),
    name: 'partenaires.annuaire.zones',
    roles: STAFF,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).annuaire.addZones(v, id!, b.postcodes))),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/annuaire/${ID}/justificatifs$`),
    name: 'partenaires.annuaire.justificatif',
    roles: STAFF,
    handle: withBody(async (s, v, [id], b) =>
      reply(await core(s).annuaire.addCredential(v, id!, { kind: b.kind, domain: b.domain, number: b.number, validFrom: b.validFrom, validUntil: b.validUntil, proofRef: b.proofRef })),
    ),
  },

  /* La mise en relation (U02, U03) : accord du client, choix d'un humain, rémunérations déclarées [R74, R75, R76]. */
  {
    method: 'POST',
    pattern: /^\/partenaires\/relations$/,
    name: 'partenaires.relation.proposition',
    roles: STAFF,
    handle: withBody(async (s, v, _p, b) =>
      reply(await core(s).relations.propose(v, { projectId: b.projectId, trade: b.trade, domain: b.domain, postcode: b.postcode, propertyId: b.propertyId })),
    ),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/partenaires/relations/${ID}$`),
    name: 'partenaires.relation',
    roles: STAFF,
    handle: async (s, v, [id]) => reply(await core(s).relations.get(v, id)),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/relations/${ID}/accord$`),
    name: 'partenaires.relation.accord',
    roles: STAFF,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).relations.recordConsent(v, id, { partnerId: b.partnerId, consentAt: b.consentAt, channel: b.channel, proofRef: b.proofRef }))),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/relations/${ID}/confier$`),
    name: 'partenaires.relation.confiee',
    roles: STAFF,
    handle: async (s, v, [id]) => reply(await core(s).relations.entrust(v, id)),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/relations/${ID}/cloture$`),
    name: 'partenaires.relation.cloture',
    roles: STAFF,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).relations.close(v, id, b.outcome))),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/relations/${ID}/remunerations$`),
    name: 'partenaires.relation.remuneration',
    roles: STAFF,
    handle: withBody(async (s, v, [id], b) =>
      reply(await core(s).remunerations.declare(v, id, { partnerId: b.partnerId, kind: b.kind, amountCents: b.amountCents, rateBp: b.rateBp, payer: b.payer, payee: b.payee })),
    ),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/partenaires/relations/${ID}/remunerations$`),
    name: 'partenaires.relation.texte_client',
    roles: STAFF,
    handle: async (s, v, [id]) => reply(await core(s).remunerations.disclose(v, id)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/partenaires/relations/${ID}/pieces$`),
    name: 'partenaires.relation.pieces',
    roles: STAFF,
    handle: async (s, v, [id]) => reply(await core(s).pieces.placements(v, id)),
  },

  /* L'écran « Partenaires » de l'application (U11) : les projets de l'agent, la preuve d'un accord noté par l'agent. */
  {
    method: 'GET',
    pattern: /^\/partenaires\/projets$/,
    name: 'partenaires.projets',
    roles: STAFF,
    handle: async (s, v) => reply(await core(s).relations.projects(v)),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/relations/${ID}/preuve-accord$`),
    name: 'partenaires.relation.preuve_accord',
    roles: STAFF,
    handle: withBody(consentNote),
  },

  /* Le suivi (U07) : délais mesurés, relances préparées, avis lus par un humain, jamais une note [R14]. */
  {
    method: 'GET',
    pattern: new RegExp(`^/partenaires/relations/${ID}/suivi$`),
    name: 'partenaires.relation.suivi',
    roles: STAFF,
    handle: async (s, v, [id]) => reply(await core(s).suivi.followUps(v, id)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/partenaires/relations/${ID}/resume$`),
    name: 'partenaires.relation.resume',
    roles: STAFF,
    handle: async (s, v, [id]) => reply(await core(s).suivi.summary(v, id)),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/relations/${ID}/avis$`),
    name: 'partenaires.relation.avis',
    roles: STAFF,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).suivi.recordReview(v, id, b))),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/partenaires/relations/${ID}/avis$`),
    name: 'partenaires.relation.avis_lus',
    roles: STAFF,
    handle: async (s, v, [id]) => reply(await core(s).suivi.readReviews(v, id)),
  },

  /* L'espace partenaire (U04, U05, U06) : ses seules demandes confiées, le dossier utile de son métier [R77]. */
  {
    method: 'GET',
    pattern: /^\/partenaires\/espace$/,
    name: 'partenaires.espace',
    roles: PARTNER,
    handle: async (s, v) => {
      const list = await core(s).espace.list(v);
      if (!list.ok) return reply(list);
      return reply({ ok: true, value: list.value.map((x) => ({ ...x, tradeLabel: tradeLabel(x.trade) })) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/partenaires/espace/${ID}$`),
    name: 'partenaires.espace.demande',
    roles: PARTNER,
    handle: async (s, v, [id]) => {
      const read = await core(s).espace.read(v, id);
      if (!read.ok) return reply(read);
      const domain = typeof read.value.file.domain === 'string' ? read.value.file.domain : null;
      return reply({ ok: true, value: { ...read.value, tradeLabel: tradeLabel(read.value.trade), sorts: sortsFor(read.value.trade, domain) } });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/espace/${ID}/etat$`),
    name: 'partenaires.espace.etat',
    roles: PARTNER,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).espace.progress(v, id, b.state))),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/espace/${ID}/pieces$`),
    name: 'partenaires.espace.piece',
    roles: PARTNER,
    handle: deposit,
  },

  /* La prospection (U08) : la direction seule ; rien ne part, le contrôle central décide [R79]. */
  {
    method: 'GET',
    pattern: /^\/partenaires\/prospection$/,
    name: 'partenaires.prospection',
    roles: DIRECTION,
    handle: async (s, v) => reply(await core(s).prospection.list(v)),
  },
  {
    method: 'POST',
    pattern: /^\/partenaires\/prospection$/,
    name: 'partenaires.prospection.ajout',
    roles: DIRECTION,
    handle: withBody(async (s, v, _p, b) => reply(await core(s).prospection.add(v, { email: b.email, addressKind: b.addressKind, trade: b.trade, businessName: b.businessName, source: b.source }))),
  },
  {
    method: 'GET',
    pattern: /^\/partenaires\/prospection\/mails$/,
    name: 'partenaires.prospection.mails',
    roles: DIRECTION,
    handle: async (s, v, _p, r) => reply(await core(s).prospection.mailsOf(v, new URL(r.url).searchParams.get('jour'))),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/partenaires/prospection/${ID}/opposition$`),
    name: 'partenaires.prospection.opposition',
    roles: DIRECTION,
    handle: async (s, v, [id]) => reply(await core(s).prospection.oppose(v, id)),
  },
];

/**
 * Les routes de M18, prêtes pour le routeur du socle (U09) : chacune contrôle le rôle avant tout, écrit le refus au
 * journal, puis passe la main à la couche métier [R16].
 */
export function partenairesRoutes(): PartenairesRoute[] {
  return ROUTES.map((route) => ({
    ...route,
    handle: async (s, viewer, params, request) => {
      if (!route.roles.includes(viewer.role)) {
        await appendEvent(
          s.journal,
          { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: route.name, code: 'role' } },
          s.now,
        );
        return reply({ ok: false, rule: 'R16', code: 'role' });
      }
      return route.handle(s, viewer, params, request);
    },
  }));
}

/* ---------- La page publique d'opposition à la prospection ---------- */

export const PARTENAIRES_OPPOSITION_PATH = '/partenaires/opposition/';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(status: number, title: string, body: string): Response {
  const html = renderPublicPage({ title, body });
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
  });
}

export interface PartenairesPublicConfig {
  db: SqlDatabase;
  now?: () => Date;
}

/**
 * La page d'opposition du mail de prospection, ou `null` si l'adresse n'est pas à elle. Le jeton seul suffit, sans
 * compte ; la page ne dit rien de l'adresse ; un geste, et plus rien ne part, sur aucun canal [R04, R79].
 */
export async function handlePartenairesPublic(request: Request, config: PartenairesPublicConfig): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PARTENAIRES_OPPOSITION_PATH)) return null;
  const now = config.now ?? (() => new Date());
  const token = url.pathname.slice(PARTENAIRES_OPPOSITION_PATH.length);
  const unknown = () => page(404, 'Lien inconnu', '<p>Ce lien n’est pas valable.</p>');
  if (!/^[a-z]{32}$/.test(token)) return unknown();
  if (request.method === 'GET' || request.method === 'HEAD') {
    return page(
      200,
      'Ne plus recevoir de message de notre part',
      `<p>Un geste suffit : nous ne vous écrirons plus, ni par mail ni autrement.</p><form method="post" action="${PARTENAIRES_OPPOSITION_PATH}${token}"><button type="submit">Ne plus recevoir de message</button></form>`,
    );
  }
  if (request.method !== 'POST') return page(405, 'Méthode non admise', '<p>Utilisez le bouton de la page.</p>');
  const prospection = new Prospection(config.db, new SqlJournalStore(config.db), { now });
  if (!(await prospection.optOut(token))) return unknown();
  return page(200, 'C’est noté', '<p>Vous ne recevrez plus de message de notre part.</p>');
}

/** Une panne de la page publique : au journal, sans donnée [R13]. */
export async function partenairesPublicError(db: SqlDatabase, error: unknown, now: () => Date): Promise<void> {
  await journalError(new SqlJournalStore(db), 'public:partenaires', 'partenaires.page', error, now);
}

/* ---------- L'espace partenaire en ligne ---------- */

export const PARTNER_SPACE_PATH = '/partenaire';

/** Rien d'extérieur, aucun script en ligne, aucun appel hors de ce Worker. */
export const PARTNER_SPACE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SPACE_FILES: Readonly<Record<string, { body: string; type: string }>> = Object.freeze({
  '/partenaire/': { body: PARTNER_HTML, type: 'text/html; charset=utf-8' },
  '/partenaire/partenaire.css': { body: PARTNER_CSS, type: 'text/css; charset=utf-8' },
  '/partenaire/partenaire.js': { body: PARTNER_JS, type: 'text/javascript; charset=utf-8' },
});

/** Les fichiers de l'espace partenaire, pour les tests. */
export const PARTNER_SPACE_FILES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries(SPACE_FILES).map(([k, v]) => [k, v.body])));

/** Sert un fichier de l'espace partenaire, ou `null` si l'adresse n'est pas à lui. */
export function handleEspacePartenaire(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== PARTNER_SPACE_PATH && !url.pathname.startsWith(`${PARTNER_SPACE_PATH}/`)) return null;
  const headers: Record<string, string> = {
    'content-security-policy': PARTNER_SPACE_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (url.pathname === PARTNER_SPACE_PATH) return new Response(null, { status: 308, headers: { ...headers, location: '/partenaire/' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Méthode non admise.', { status: 405, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' } });
  }
  const file = SPACE_FILES[url.pathname];
  if (!file) return new Response('Page inconnue.', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  return new Response(request.method === 'HEAD' ? null : file.body, { status: 200, headers: { ...headers, 'content-type': file.type, 'cache-control': 'no-cache' } });
}
