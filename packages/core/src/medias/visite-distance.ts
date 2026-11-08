/**
 * Avant et après la visite : dossier envoyé, visite à distance et son bon (M08, M19, HX44) [R502, R503, R504, R505].
 *
 * Comme Talqor et Live Visit de Hektor : envoyer le dossier du bien avant la visite, faire visiter à distance, éditer le
 * bon de visite ensuite.
 *
 * Jamais vu :
 * - le dossier envoyé est celui de la dernière version publiée du jour, au caractère près (titre, prix, mentions, texte,
 *   photos publiables), rendu par le code et relu avant de partir : un nom, une coordonnée, un numéro de mandat ou une
 *   note connus du dossier du bien ou de la visite, ou un chiffre qui ne vient pas de l'annonce (honoraires, commission,
 *   prix du mandat), et rien ne part [R502] ; il ne part que par le contrôle central des envois [R503] ; son lien ne
 *   montre plus rien dès qu'une autre version est publiée ou que le bien ne peut plus être diffusé ;
 * - le bon d'une visite faite à distance se signe en ligne juste après, comme D08 : à la fin de la visite, un lien et un
 *   code à usage unique partent au visiteur par le contrôle central ; le code expire, ne sert qu'une fois, et cinq
 *   essais faux bloquent la signature ; seules les empreintes sont gardées [R504] ;
 * - aucune offre de ce visiteur sur ce bien n'entre au registre tant que ce bon n'est pas signé, gardé par la base
 *   elle-même [R505].
 *
 * Décidé, lecture prudente :
 * - les mentions publiées restent dans le dossier, car la loi les veut sur toute présentation du bien (prix, part des
 *   honoraires à la charge de l'acquéreur, énergie, carte) [R43], comme en HX13 ; aucun autre chiffre des honoraires,
 *   ni montant, ni barème, ni partage, n'y entre : seuls les chiffres de la version publiée y sont permis ;
 * - le dossier part avant la visite seulement, pour une visite réservée, au visiteur lui-même, sur l'accord qu'il a
 *   donné de le recevoir par mail (preuve donnée par l'agent) [R03] ; en essai, il reste dans la boîte d'essai [R26] ;
 * - une visite à distance commence au plus tôt 30 minutes avant l'heure du rendez-vous et au plus tard à sa fin, et
 *   seulement si son bon pourra se signer en ligne (bon complet [R40], mail du visiteur, son accord [R03]) ; une fois
 *   commencée, son bon doit être signé en ligne avant toute offre, même si la liaison a coupé ; tant que H24 n'est pas réglé, la signature est d'essai, sans valeur juridique, mais elle
 *   suffit à ouvrir le registre des offres, comme le bon papier d'une visite sur place ;
 * - les fiches réunies d'une même personne comptent pour une seule, dans le code et dans la base.
 *
 * Le branchement au Worker (`app.ts`), l'appel vidéo, les écrans et le refus propre dans le registre des offres
 * (`offres/registre-offres.ts` appelle `bonDistanceManquant`) sont des tâches de la voie 1 : ici, ni `app.ts` ni le socle.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { DiffusionGate } from '../acquereurs/rapprochement.ts';
import { euros } from '../annonces/mentions.ts';
import { figuresIn, unsourcedFigures, visibleText } from '../boutique/supports.ts';
import { plain } from '../envoi/texte.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml, sha256 } from '../documents/modeles.ts';
import { Diffusion } from '../documents/retractation.ts';
import { CODE_TTL_MINUTES, MAX_CODE_ATTEMPTS, newSignatureCode, sameSignatureHash } from '../documents/signature-en-ligne.ts';
import { ControleEnvois, type SendResult } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { confidentialIn } from '../presentation/presentation.ts';
import type { Visites } from '../visites/visites.ts';

/** La finalité de l'accord du visiteur à recevoir le dossier du bien par mail avant sa visite [R03]. */
export const VISIT_DOSSIER_PURPOSE = 'dossier_visite';
/** La finalité de l'accord du visiteur à recevoir le lien et le code de signature de son bon par mail [R03]. */
export const REMOTE_SLIP_PURPOSE = 'signature_bon_visite';
/** Le lien du dossier reste valable jusqu'à la fin de la visite, puis 7 jours. */
export const DOSSIER_LINK_DAYS_AFTER = 7;
/** Le lien de signature reste valable 48 heures ; le code, `CODE_TTL_MINUTES`. */
export const SIGN_LINK_HOURS = 48;
/** Une visite à distance commence au plus tôt 30 minutes avant l'heure du rendez-vous. */
export const REMOTE_EARLY_MINUTES = 30;
const MAX_DRAWING = 200_000;
const MAX_PHOTOS = 30;
const DAY = 86_400_000;

export type DistanceRefusal = { ok: false; rule: string | null; code: string; reason?: string };

/** La version publiée telle que chaque canal la reçoit : seuls ces champs entrent dans le dossier [R502]. */
export interface PublishedVersion {
  versionId: string;
  payloadHash: string;
  reference: string;
  state: 'en_vente' | 'sous_offre';
  title: string;
  body: string;
  mentions: string;
  priceEur: number;
  day: string;
  photos: { ref: string; overlay: string | null }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lit la charge d'une version publiée ; null si elle n'est pas complète ou n'est pas en vente ni sous offre. */
export function publishedVersionOf(row: { id: string; state: string; payload: string; payload_hash: string; created_at: string }, reference: string): PublishedVersion | null {
  if (row.state !== 'en_vente' && row.state !== 'sous_offre') return null;
  let p: unknown;
  try {
    p = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (!isRecord(p)) return null;
  const { title, body, mentions, priceEur, media } = p;
  if (typeof title !== 'string' || title.trim() === '' || typeof body !== 'string' || body.trim() === '' || typeof mentions !== 'string' || mentions.trim() === '') return null;
  if (typeof priceEur !== 'number' || !Number.isInteger(priceEur) || priceEur <= 0) return null;
  const photos: PublishedVersion['photos'] = [];
  for (const m of Array.isArray(media) ? media : []) {
    if (!isRecord(m) || m.kind !== 'photo' || typeof m.ref !== 'string' || m.ref.length === 0 || m.ref.length > 300) continue;
    photos.push({ ref: m.ref, overlay: typeof m.overlay === 'string' ? m.overlay : null });
    if (photos.length >= MAX_PHOTOS) break;
  }
  return { versionId: row.id, payloadHash: row.payload_hash, reference, state: row.state, title, body, mentions, priceEur, day: row.created_at.slice(0, 10), photos };
}

const mediaPath = (ref: string): string => `/medias/${ref.split('/').map(encodeURIComponent).join('/')}`;
const frenchDay = (iso: string): string => iso.split('-').reverse().join('/');

const DOSSIER_CSS =
  'main{display:grid;gap:var(--e-5);padding:var(--e-4);max-width:48rem;margin:0 auto}' +
  '.photos{display:grid;gap:var(--e-3)}@media (min-width:40rem){.photos{grid-template-columns:1fr 1fr}}' +
  '.cadre{position:relative;margin:0}.photo{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--r-l);background:var(--trait)}' +
  '.virtuel{position:absolute;left:var(--e-3);top:var(--e-3);padding:var(--e-1) var(--e-3);border-radius:var(--r-s);background:var(--encre);color:var(--papier);font-weight:700;font-size:var(--t-s)}' +
  '.prix{font:700 var(--t-xl)/1 var(--police-titre);color:var(--accent);margin:0}' +
  '.mentions{margin:0;padding:var(--e-2) var(--e-3);border-left:3px solid var(--moutarde);font-size:var(--t-s);white-space:pre-line}' +
  '.texte{white-space:pre-line;margin:0}.ref{color:var(--doux);font-size:var(--t-s);letter-spacing:.08em;margin:0}';

/**
 * Le dossier du bien : la version publiée, et elle seule, au caractère près. Aucun autre champ n'existe dans ce que la
 * page reçoit [R502]. Sans script, sans rien venu d'ailleurs.
 */
export function renderDossier(v: PublishedVersion): string {
  const photos = v.photos
    .map(
      (p, i) =>
        `<figure class="cadre"><img class="photo" src="${escapeHtml(mediaPath(p.ref))}" alt="Photo ${i + 1} du bien${p.overlay ? ', aménagement virtuel' : ''}" loading="lazy">` +
        `${p.overlay ? `<figcaption class="virtuel">${escapeHtml(p.overlay)}</figcaption>` : ''}</figure>`,
    )
    .join('');
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="${THEME_COLOR}">` +
    `<title>Le bien avant votre visite</title><style>${DESIGN_CSS}${DOSSIER_CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p></header><div class="frise" aria-hidden="true"></div><main>` +
    `<h1>${escapeHtml(v.title)}</h1><p class="prix">${escapeHtml(euros(v.priceEur))}</p>` +
    `${photos ? `<section class="photos" aria-label="Photos du bien">${photos}</section>` : ''}` +
    `<p class="texte">${escapeHtml(v.body)}</p><p class="mentions">${escapeHtml(v.mentions)}</p>` +
    `<p class="ref">Réf. ${escapeHtml(v.reference)} · annonce publiée le ${escapeHtml(frenchDay(v.day))}</p>` +
    `</main></body></html>`
  );
}

/** Les sources permises des chiffres du dossier : la version publiée et rien d'autre [R502]. */
export function dossierSources(v: PublishedVersion): string[] {
  return [v.title, v.body, v.mentions, euros(v.priceEur), v.reference, frenchDay(v.day), ...v.photos.map((_, i) => String(i + 1))];
}

/**
 * La relecture du dossier avant tout envoi : ce qu'il trahirait (noms, coordonnées, numéros de mandat, notes) et ses
 * chiffres sans source. Vide si le dossier peut partir [R502].
 */
export function dossierProblems(html: string, v: PublishedVersion, secrets: readonly { names: readonly string[]; values: readonly string[]; exact?: readonly string[] }[]): string[] {
  const found = secrets.flatMap((s) => confidentialIn(html, s));
  const text = visibleText(html.replace(/<style>[\s\S]*?<\/style>/g, ' '));
  // Un numéro de mandat se cherche entier, quelle que soit sa longueur (« 12 » comme « MAND-0012 »), dans ce que
  // l'agent a écrit (titre et texte) : la relecture générale ne lit pas les valeurs courtes, et un numéro publié dans le
  // texte serait pris pour un chiffre sourcé. Le prix, les mentions et la date sont écrits par le code.
  const written = `${v.title}\n${v.body}`;
  const words = plain(written);
  for (const s of secrets) {
    for (const raw of s.exact ?? []) {
      const x = plain(raw).trim();
      if (x === '') continue;
      const esc = x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^\\p{L}\\d])${esc}($|[^\\p{L}\\d])`, 'u').test(words)) found.push(`mandat:${x}`);
      const digits = x.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
      if (digits !== '' && digits !== x && figuresIn(written).some((f) => f.replace(/^0+(?=\d)/, '') === digits)) found.push(`mandat:${digits}`);
    }
  }
  const figures = unsourcedFigures(text, dossierSources(v));
  return [...new Set([...found, ...figures.map((f) => `chiffre:${f}`)])];
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const TOKEN = /^[0-9a-f]{64}$/;

interface VisitRow {
  network_id: string;
  property_id: string;
  project_id: string;
  person_id: string;
  agent_id: string;
  status: string;
  start_at: string;
  end_at: string;
}

interface SignatureRow {
  id: string;
  network_id: string;
  appointment_id: string;
  slip_id: string;
  slip_hash: string;
  code_hash: string;
  code_expires_at: string;
  link_expires_at: string;
  attempts: number;
  status: 'ouverte' | 'signee' | 'bloquee' | 'remplacee';
  signed_at: string | null;
  proof: string | null;
}

export interface RemoteSlipProof {
  appointmentId: string;
  slipId: string;
  slipHash: string;
  signedAt: string;
  method: 'code' | 'code_et_trace';
  drawingHash: string | null;
  mode: 'essai';
  realSignature: false;
}

export interface VisiteDistanceOptions {
  diffusion?: DiffusionGate;
  /** L'adresse de la page du dossier, pour un jeton. */
  dossierUrl?: (token: string) => string;
  /** L'adresse de la page de signature du bon, pour un jeton. */
  signUrl?: (token: string) => string;
  /** Le contrôle central des envois ; par défaut, celui du mode essai (boîte d'essai, rien ne part) [R26]. */
  envois?: ControleEnvois;
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
  newCode?: () => string;
}

export class VisiteDistance {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newToken: () => string;
  private readonly newCode: () => string;
  private readonly diffusion: DiffusionGate;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly envois: ControleEnvois;
  private readonly dossierUrl: (token: string) => string;
  private readonly signUrl: (token: string) => string;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    private readonly visites: Visites,
    options: VisiteDistanceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newToken = options.newToken ?? randomToken;
    this.newCode = options.newCode ?? newSignatureCode;
    this.diffusion = options.diffusion ?? new Diffusion(db, acces, journal, { now: this.now });
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    this.envois =
      options.envois ??
      new ControleEnvois(db, this.fiche, new DecisionEnvoi(db, this.store, this.fiche, { now: this.now }), {
        channels: trialChannels(db, journal, this.now),
        journal: new SqlSendJournal(db, undefined, this.now),
        now: this.now,
      });
    this.dossierUrl = options.dossierUrl ?? ((t) => `https://aimmo.fr/visite/dossier/${t}`);
    this.signUrl = options.signUrl ?? ((t) => `https://aimmo.fr/visite/bon/${t}`);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La visite, pour l'agent qui voit la fiche du visiteur en entier ou la direction ; la lecture est au journal [R16]. */
  private async visit(viewer: Viewer, appointmentId: unknown): Promise<{ ok: true; v: VisitRow } | DistanceRefusal> {
    if (typeof appointmentId !== 'string' || appointmentId === '' || appointmentId.length > 100) return { ok: false, rule: null, code: 'unknown' };
    const access = await this.visites.accessVisit(viewer, appointmentId);
    if (!access.ok) return access;
    const v = await this.db.first<VisitRow>(
      `SELECT v.network_id, v.property_id, v.project_id, v.person_id, v.agent_id, a.status, a.start_at, a.end_at
         FROM visits v JOIN appointments a ON a.id = v.appointment_id WHERE v.appointment_id = ?`,
      [appointmentId],
    );
    if (!v || v.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    return { ok: true, v };
  }

  /** La dernière version publiée du bien, si elle est en vente ou sous offre et complète. */
  private async latest(networkId: string, propertyId: string): Promise<PublishedVersion | null> {
    const row = await this.db.first<{ id: string; state: string; payload: string; payload_hash: string; created_at: string }>(
      'SELECT id, state, payload, payload_hash, created_at FROM listing_versions WHERE property_id = ? AND network_id = ? ORDER BY seq DESC LIMIT 1',
      [propertyId, networkId],
    );
    const ref = await this.db.first<{ reference: string }>('SELECT reference FROM properties WHERE id = ? AND network_id = ?', [propertyId, networkId]);
    if (!row || !ref) return null;
    return publishedVersionOf(row, ref.reference);
  }

  /** Les noms des mandants du bien, fiches réunies comprises : interdits dans tout message [R19]. */
  private async sellerSecrets(networkId: string, propertyId: string): Promise<{ names: string[]; values: string[]; exact: string[] }> {
    const owners = await this.db.all<{ person_id: string }>(
      `SELECT person_id FROM mandates WHERE network_id = ? AND property_id = ?
       UNION SELECT pp.person_id FROM project_properties x JOIN projects pp ON pp.id = x.project_id WHERE x.network_id = ? AND x.property_id = ? AND x.role = 'owned'`,
      [networkId, propertyId, networkId, propertyId],
    );
    const names: string[] = [];
    const values: string[] = [];
    for (const o of owners) {
      const view = await this.fiche.view(o.person_id);
      for (const m of view.members) for (const n of [m.first_name, m.last_name]) if (typeof n === 'string' && n.trim() !== '') names.push(n);
      for (const i of view.identifiers) values.push(i.value);
    }
    // Les notes internes : celles des projets du vendeur et des mandats du bien ; les numéros du registre des mandats.
    const notes = await this.db.all<{ note: string | null }>(
      `SELECT pp.note FROM project_properties x JOIN projects pp ON pp.id = x.project_id WHERE x.network_id = ? AND x.property_id = ? AND x.role = 'owned'
       UNION SELECT pp.note FROM mandates m JOIN projects pp ON pp.id = m.project_id WHERE m.network_id = ? AND m.property_id = ?`,
      [networkId, propertyId, networkId, propertyId],
    );
    for (const n of notes) if (typeof n.note === 'string' && n.note.trim() !== '') values.push(n.note);
    const exact: string[] = [];
    for (const r of await this.db.all<{ number: string }>('SELECT number FROM mandate_register WHERE network_id = ? AND property_id = ?', [networkId, propertyId])) {
      values.push(r.number);
      exact.push(r.number);
    }
    return { names, values, exact };
  }

  /** Les notes de l'agent sur la visite et sur le projet du visiteur : jamais dans le dossier [R502]. */
  private async visitNotes(appointmentId: string, v: VisitRow): Promise<{ names: string[]; values: string[] }> {
    const values: string[] = [];
    for (const n of await this.db.all<{ body: string }>('SELECT body FROM visit_field_notes WHERE appointment_id = ?', [appointmentId])) values.push(n.body);
    const project = await this.db.first<{ note: string | null }>('SELECT note FROM projects WHERE id = ?', [v.project_id]);
    if (typeof project?.note === 'string' && project.note.trim() !== '') values.push(project.note);
    return { names: [], values };
  }

  private async greeting(personId: string): Promise<string> {
    const first = await ficheFirstName(this.db, await this.fiche.membersOf(personId));
    return first ? `Bonjour ${first},\n\n` : 'Bonjour,\n\n';
  }

  private async ensureConsent(networkId: string, personId: string, purpose: string, proof: unknown): Promise<boolean> {
    if (await this.fiche.hasConsentInForce(personId, purpose, 'email')) return true;
    if (typeof proof !== 'string' || proof.trim() === '' || proof.length > 300) return false;
    await this.store.addConsent({ networkId, personId, purpose, channel: 'email', proof: proof.trim(), givenAt: this.now() });
    return true;
  }

  /**
   * Envoie au visiteur, avant sa visite, le lien du dossier du bien : la dernière version publiée, rendue par le code et
   * relue [R502], par le contrôle central seulement [R503]. Rien n'est envoyé si la relecture trouve quoi que ce soit.
   */
  async sendDossier(viewer: Viewer, appointmentId: string, input: { consentProof?: unknown } = {}): Promise<{ ok: true; value: { dossierId: string; versionId: string } } | DistanceRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const v = found.v;
    const at = this.now();
    if (v.status !== 'booked') return { ok: false, rule: null, code: 'not_booked' };
    if (Date.parse(v.start_at) <= at.getTime()) return { ok: false, rule: 'R502', code: 'visit_started' };
    if (!(await this.diffusion.canDiffuse(v.network_id, v.property_id, at)).allowed) return { ok: false, rule: 'R42', code: 'not_diffusable' };
    const version = await this.latest(v.network_id, v.property_id);
    if (!version) return { ok: false, rule: 'R502', code: 'not_published' };
    const html = renderDossier(version);
    const sellers = await this.sellerSecrets(v.network_id, v.property_id);
    const problems = dossierProblems(html, version, [sellers, await this.visitNotes(appointmentId, v)]);
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'dossier_visite.refuse', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R502', count: problems.length } }, this.now);
      return { ok: false, rule: 'R502', code: 'confidential' };
    }
    if (!(await this.ensureConsent(v.network_id, v.person_id, VISIT_DOSSIER_PURPOSE, input.consentProof))) return { ok: false, rule: 'R03', code: 'no_consent' };
    const id = this.newId();
    const token = this.newToken();
    const expiresAt = new Date(Date.parse(v.end_at) + DOSSIER_LINK_DAYS_AFTER * DAY).toISOString();
    await this.db.run(
      `INSERT INTO visit_dossiers (id, network_id, appointment_id, property_id, person_id, version_id, payload_hash, content, content_hash, token_hash, expires_at, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'a_envoyer', ?, ?)`,
      [id, v.network_id, appointmentId, v.property_id, v.person_id, version.versionId, version.payloadHash, html, await sha256(html), await sha256(token), expiresAt, this.actor(viewer), at.toISOString()],
    );
    const day = frenchDay(v.start_at.slice(0, 10));
    const sent: SendResult = await this.envois.send({
      networkId: v.network_id,
      agentId: v.agent_id,
      personId: v.person_id,
      projectId: v.project_id,
      channel: 'email',
      kind: 'follow_up',
      purpose: VISIT_DOSSIER_PURPOSE,
      subject: `dossier-visite:${id}`,
      fallbackTexts: [`${await this.greeting(v.person_id)}Avant votre visite du ${day}, voici le dossier du bien ${version.reference}, tel qu’il est publié aujourd’hui : ${this.dossierUrl(token)}`],
      figures: [day, version.reference, ...(this.dossierUrl(token).match(/\d+/g) ?? [])],
      sellerNames: sellers.names,
    });
    if (sent.status !== 'sent' || !sent.messageId) {
      await this.db.run(`UPDATE visit_dossiers SET status = 'refuse' WHERE id = ? AND status = 'a_envoyer'`, [id]);
      return { ok: false, rule: sent.rule, code: 'send_refused', reason: sent.reason };
    }
    await this.db.run(`UPDATE visit_dossiers SET status = 'envoye', message_id = ? WHERE id = ? AND status = 'a_envoyer'`, [sent.messageId, id]);
    await appendEvent(this.journal, { type: 'dossier_visite.envoye', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R503', version: version.versionId } }, this.now);
    return { ok: true, value: { dossierId: id, versionId: version.versionId } };
  }

  /**
   * Le dossier, pour qui tient le lien : tel qu'il a été envoyé, tant que le lien vaut, que la version envoyée est
   * toujours la dernière publiée et que le bien peut être diffusé ; sinon rien [R502, R42].
   */
  async openDossier(token: unknown): Promise<{ ok: true; html: string } | DistanceRefusal> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return { ok: false, rule: null, code: 'unknown' };
    const d = await this.db.first<{ network_id: string; property_id: string; version_id: string; content: string; content_hash: string; expires_at: string; status: string }>(
      'SELECT network_id, property_id, version_id, content, content_hash, expires_at, status FROM visit_dossiers WHERE token_hash = ?',
      [await sha256(token)],
    );
    if (!d || d.status !== 'envoye') return { ok: false, rule: null, code: 'unknown' };
    const at = this.now();
    if (at.getTime() > Date.parse(d.expires_at)) return { ok: false, rule: null, code: 'expired' };
    const latest = await this.latest(d.network_id, d.property_id);
    if (!latest || latest.versionId !== d.version_id) return { ok: false, rule: 'R502', code: 'outdated' };
    if (!(await this.diffusion.canDiffuse(d.network_id, d.property_id, at)).allowed) return { ok: false, rule: 'R42', code: 'not_diffusable' };
    if ((await sha256(d.content)) !== d.content_hash) throw new Error('Dossier de visite : contenu changé depuis l’envoi.');
    return { ok: true, html: d.content };
  }

  /** L'agent commence la visite à distance, au plus tôt 30 minutes avant l'heure, au plus tard à sa fin [R504]. */
  async startRemote(viewer: Viewer, appointmentId: string, input: { consentProof?: unknown } = {}): Promise<{ ok: true; value: { startedAt: string } } | DistanceRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const v = found.v;
    const at = this.now();
    if (v.status !== 'booked') return { ok: false, rule: null, code: 'not_booked' };
    if (at.getTime() < Date.parse(v.start_at) - REMOTE_EARLY_MINUTES * 60_000 || at.getTime() > Date.parse(v.end_at)) return { ok: false, rule: null, code: 'outside_slot' };
    if (!(await this.diffusion.canDiffuse(v.network_id, v.property_id, at)).allowed) return { ok: false, rule: 'R42', code: 'not_diffusable' };
    // Une visite commencée bloque les offres jusqu'à la signature de son bon : elle ne commence que si ce bon pourra se
    // signer en ligne, bon complet, mail du visiteur et son accord de recevoir le lien et le code [R504, R505, R40, R03].
    const slip = await this.visites.slipOf(viewer, appointmentId);
    if (!slip.ok) return slip;
    if (slip.slip.status !== 'complet') return { ok: false, rule: 'R40', code: 'slip_incomplete' };
    const view = await this.fiche.view(v.person_id);
    if (!view.identifiers.some((i) => i.kind === 'email')) return { ok: false, rule: 'R504', code: 'no_email' };
    if (!(await this.ensureConsent(v.network_id, v.person_id, REMOTE_SLIP_PURPOSE, input.consentProof))) return { ok: false, rule: 'R03', code: 'no_consent' };
    const { changes } = await this.db.run(
      `INSERT INTO remote_visits (appointment_id, network_id, property_id, person_id, started_by, started_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (appointment_id) DO NOTHING`,
      [appointmentId, v.network_id, v.property_id, v.person_id, this.actor(viewer), at.toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_started' };
    await appendEvent(this.journal, { type: 'visite_distance.commencee', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R504' } }, this.now);
    return { ok: true, value: { startedAt: at.toISOString() } };
  }

  /**
   * L'agent finit la visite à distance ; la signature du bon part juste après, d'elle-même : le lien et le code au
   * visiteur, par le contrôle central [R504].
   */
  async endRemote(viewer: Viewer, appointmentId: string, input: { consentProof?: unknown } = {}): Promise<{ ok: true; value: { endedAt: string; signature: { ok: true; value: { sessionId: string } } | DistanceRefusal } } | DistanceRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const at = this.now().toISOString();
    const { changes } = await this.db.run(`UPDATE remote_visits SET ended_at = ? WHERE appointment_id = ? AND ended_at IS NULL`, [at, appointmentId]);
    if (changes !== 1) return { ok: false, rule: null, code: (await this.db.first('SELECT 1 FROM remote_visits WHERE appointment_id = ?', [appointmentId])) ? 'already_ended' : 'not_started' };
    await appendEvent(this.journal, { type: 'visite_distance.finie', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R504' } }, this.now);
    const signature = await this.startSignature(viewer, appointmentId, input);
    return { ok: true, value: { endedAt: at, signature } };
  }

  /**
   * Ouvre la signature en ligne du bon d'une visite à distance finie : un lien et un code à usage unique au visiteur,
   * chacun dans son message, par le contrôle central. Une signature encore ouverte est remplacée [R504].
   */
  async startSignature(viewer: Viewer, appointmentId: string, input: { consentProof?: unknown } = {}): Promise<{ ok: true; value: { sessionId: string } } | DistanceRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const v = found.v;
    const remote = await this.db.first<{ ended_at: string | null }>('SELECT ended_at FROM remote_visits WHERE appointment_id = ?', [appointmentId]);
    if (!remote) return { ok: false, rule: 'R504', code: 'not_remote' };
    if (!remote.ended_at) return { ok: false, rule: 'R504', code: 'not_ended' };
    if (await this.db.first(`SELECT 1 FROM remote_slip_signatures WHERE appointment_id = ? AND status = 'signee'`, [appointmentId])) return { ok: false, rule: null, code: 'already_signed' };
    const slip = await this.visites.slipOf(viewer, appointmentId);
    if (!slip.ok) return slip;
    if (slip.slip.status !== 'complet') return { ok: false, rule: 'R40', code: 'slip_incomplete' };
    if (!(await this.ensureConsent(v.network_id, v.person_id, REMOTE_SLIP_PURPOSE, input.consentProof))) return { ok: false, rule: 'R03', code: 'no_consent' };
    const id = this.newId();
    const token = this.newToken();
    const code = this.newCode();
    const now = this.now();
    await this.db.run(`UPDATE remote_slip_signatures SET status = 'remplacee' WHERE appointment_id = ? AND status = 'ouverte'`, [appointmentId]);
    // Deux ouvertures en même temps : la base n'en garde qu'une ouverte ; l'autre est dite, sans rien envoyer.
    try {
      await this.db.run(
        `INSERT INTO remote_slip_signatures (id, network_id, appointment_id, slip_id, slip_hash, token_hash, code_hash, code_expires_at, link_expires_at, attempts, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ouverte', ?, ?)`,
        [
          id,
          v.network_id,
          appointmentId,
          slip.slip.id,
          slip.slip.contentHash,
          await sha256(token),
          await sha256(`${id}:${code}`),
          new Date(now.getTime() + CODE_TTL_MINUTES * 60_000).toISOString(),
          new Date(now.getTime() + SIGN_LINK_HOURS * 3_600_000).toISOString(),
          this.actor(viewer),
          now.toISOString(),
        ],
      );
    } catch (e) {
      if (await this.db.first(`SELECT 1 FROM remote_slip_signatures WHERE appointment_id = ? AND status IN ('ouverte', 'signee')`, [appointmentId])) return { ok: false, rule: null, code: 'already_open' };
      throw e;
    }
    const hello = await this.greeting(v.person_id);
    const link = this.signUrl(token);
    const base = { networkId: v.network_id, agentId: v.agent_id, personId: v.person_id, projectId: v.project_id, channel: 'email' as const, kind: 'follow_up' as const, purpose: REMOTE_SLIP_PURPOSE };
    const sentLink = await this.envois.send({
      ...base,
      subject: `bon-distance:${id}:lien`,
      fallbackTexts: [`${hello}Merci pour votre visite à distance. Votre bon de visite vous attend ici, à lire puis à signer avec le code reçu dans un autre message : ${link}`],
      figures: link.match(/\d+/g) ?? [],
    });
    if (sentLink.status !== 'sent') return { ok: false, rule: sentLink.rule, code: 'send_refused', reason: sentLink.reason };
    const sentCode = await this.envois.send({
      ...base,
      subject: `bon-distance:${id}:code`,
      fallbackTexts: [`${hello}Votre code pour signer votre bon de visite : ${code}. Il est valable ${CODE_TTL_MINUTES} minutes. Ne le donnez à personne, pas même à votre agent.`],
      figures: [code, CODE_TTL_MINUTES],
    });
    if (sentCode.status !== 'sent') return { ok: false, rule: sentCode.rule, code: 'send_refused', reason: sentCode.reason };
    await appendEvent(this.journal, { type: 'bon_distance.ouvert', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R504', session: id, mode: 'essai' } }, this.now);
    return { ok: true, value: { sessionId: id } };
  }

  private async session(token: unknown): Promise<SignatureRow | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    return this.db.first<SignatureRow>('SELECT * FROM remote_slip_signatures WHERE token_hash = ?', [await sha256(token)]);
  }

  /** Le bon à lire, pour qui tient le lien, tant que la signature est ouverte et le lien valable [R504]. */
  async readSlip(token: unknown): Promise<{ ok: true; content: string } | DistanceRefusal> {
    const s = await this.session(token);
    if (!s || s.status === 'remplacee') return { ok: false, rule: null, code: 'unknown' };
    if (s.status !== 'ouverte') return { ok: false, rule: null, code: s.status === 'signee' ? 'already_signed' : 'blocked' };
    if (this.now().getTime() > Date.parse(s.link_expires_at)) return { ok: false, rule: null, code: 'expired' };
    const slip = await this.db.first<{ content: string; content_hash: string }>('SELECT content, content_hash FROM visit_slips WHERE id = ?', [s.slip_id]);
    if (!slip || slip.content_hash !== s.slip_hash) return { ok: false, rule: null, code: 'slip_changed' };
    return { ok: true, content: slip.content };
  }

  /**
   * Le visiteur signe son bon avec le code reçu, et son tracé s'il y en a un. Un code ne sert qu'une fois, expire, et
   * cinq essais faux bloquent la signature. Le résultat est une signature d'essai tant que H24 n'est pas réglé [R504].
   */
  async signSlip(token: unknown, input: { code?: unknown; drawing?: unknown }): Promise<{ ok: true; value: RemoteSlipProof } | DistanceRefusal> {
    const s = await this.session(token);
    if (!s || s.status === 'remplacee') return { ok: false, rule: null, code: 'unknown' };
    if (s.status === 'signee') return { ok: false, rule: null, code: 'already_signed' };
    if (s.status === 'bloquee') return { ok: false, rule: null, code: 'blocked' };
    const at = this.now();
    if (at.getTime() > Date.parse(s.link_expires_at) || at.getTime() > Date.parse(s.code_expires_at)) return { ok: false, rule: null, code: 'expired' };
    const drawing = input.drawing ?? null;
    if (drawing !== null && (typeof drawing !== 'string' || drawing.length === 0 || drawing.length > MAX_DRAWING)) return { ok: false, rule: null, code: 'bad_drawing' };
    const given = typeof input.code === 'string' && /^\d{6}$/.test(input.code) ? await sha256(`${s.id}:${input.code}`) : '';
    if (!given || !sameSignatureHash(given, s.code_hash)) {
      // L'essai est compté dans la base, en un seul ordre : des essais simultanés comptent chacun.
      const after = await this.db.first<{ attempts: number; status: string }>(
        `UPDATE remote_slip_signatures SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'bloquee' ELSE status END
         WHERE id = ? AND status = 'ouverte' RETURNING attempts, status`,
        [MAX_CODE_ATTEMPTS, s.id],
      );
      const blocked = !after || after.status === 'bloquee';
      await appendEvent(this.journal, { type: 'bon_distance.code_faux', actor: 'visiteur', subject: `visit:${s.appointment_id}`, data: { attempts: Number(after?.attempts ?? MAX_CODE_ATTEMPTS), blocked } }, this.now);
      return { ok: false, rule: null, code: blocked ? 'blocked' : 'wrong_code' };
    }
    const slip = await this.db.first<{ content_hash: string }>('SELECT content_hash FROM visit_slips WHERE id = ?', [s.slip_id]);
    if (!slip || slip.content_hash !== s.slip_hash) return { ok: false, rule: null, code: 'slip_changed' };
    const signedAt = at.toISOString();
    const drawingHash = typeof drawing === 'string' ? await sha256(drawing) : null;
    const proof: RemoteSlipProof = { appointmentId: s.appointment_id, slipId: s.slip_id, slipHash: s.slip_hash, signedAt, method: drawingHash ? 'code_et_trace' : 'code', drawingHash, mode: 'essai', realSignature: false };
    const { changes } = await this.db.run(
      `UPDATE remote_slip_signatures SET status = 'signee', signed_at = ?, drawing_hash = ?, proof = ? WHERE id = ? AND status = 'ouverte'`,
      [signedAt, drawingHash, JSON.stringify(proof), s.id],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_signed' };
    await appendEvent(this.journal, { type: 'bon_distance.signe', actor: 'visiteur', subject: `visit:${s.appointment_id}`, data: { rule: 'R504', method: proof.method, realSignature: false } }, this.now);
    return { ok: true, value: proof };
  }

  /**
   * Le bon d'une visite à distance manque-t-il encore pour qu'une offre de cette personne sur ce bien entre au
   * registre ? Fiches réunies comprises. La base le garde aussi [R505].
   */
  async bonDistanceManquant(networkId: string, propertyId: string, buyerPersonId: string): Promise<{ missing: false } | { missing: true; appointmentId: string }> {
    const members = new Set(await this.fiche.membersOf(buyerPersonId));
    const rows = await this.db.all<{ appointment_id: string; person_id: string }>(
      `SELECT rv.appointment_id, rv.person_id FROM remote_visits rv WHERE rv.network_id = ? AND rv.property_id = ?
          AND NOT EXISTS (SELECT 1 FROM remote_slip_signatures s WHERE s.appointment_id = rv.appointment_id AND s.status = 'signee')
        ORDER BY rv.started_at`,
      [networkId, propertyId],
    );
    for (const r of rows) {
      const theirs = await this.fiche.membersOf(r.person_id);
      if (theirs.some((m) => members.has(m))) return { missing: true, appointmentId: r.appointment_id };
    }
    return { missing: false };
  }
}
