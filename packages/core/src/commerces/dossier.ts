/**
 * Le dossier protégé d'un commerce (M16, CE05) [R113, R114, R26].
 *
 * Le dossier ne part que par la porte de CE04 (engagement signé intact, non révoqué, identité vérifiée) : un lien
 * personnel, envoyé par le contrôle central (en essai : boîte d'essai, jamais envoyé), qui expire après un délai réglé et
 * ne s'ouvre qu'un nombre de fois réglé ; seule l'empreinte de son jeton est gardée. À chaque ouverture, la porte est
 * revérifiée et le lecteur confirme son adresse mail, qui doit être celle de la personne à qui le lien a été donné.
 * Chaque ouverture et chaque refus (lien inconnu, expiré, révoqué, épuisé, autre lecteur, porte fermée) est rangé avec
 * son lecteur et va au journal avec ses seuls codes [R114, R13].
 *
 * Chaque page servie porte un filigrane visible au nom du lecteur, avec la date et une référence de copie.
 * **Jamais vu** : chaque copie porte aussi une marque propre au lecteur et à l'ouverture, invisible à la lecture
 * (caractères sans largeur, répétée après chaque phrase) ; sur un texte qui a fui, même recopié sans mise en forme ou en
 * partie, `trace` retrouve l'ouverture et le lecteur, par la marque cachée ou, si elle a été retirée, par la référence
 * visible.
 *
 * Décidé, lecture prudente : les documents du dossier sont des textes rangés par leur référence de stockage (interface
 * `DossierStorage`, fausse dans les tests ; R2 réel après H38) et leur empreinte ; un document dont le contenu ne
 * correspond plus à l'empreinte n'est pas servi. Les fichiers PDF ou images attendent le stockage réel.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { CODE_TTL_MINUTES, MAX_CODE_ATTEMPTS, newSignatureCode, sameSignatureHash } from '../documents/signature-en-ligne.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { normalizeIdentifier } from '../fiche/normalize.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ConfidentialiteCommerce } from './confidentialite.ts';
import { ACTIVITY_LABEL } from './presentation.ts';
import { leaseMilestones, type BusinessSheet, type FicheCommerce } from './fiche.ts';

/** Le stockage des documents du dossier : un texte par référence, ou rien. */
export interface DossierStorage {
  read(ref: string): Promise<string | null>;
  /** Range un texte sous cette référence ; absent tant que le stockage réel n'est pas ouvert (H38). */
  write?(ref: string, content: string): Promise<void>;
}

/** Le texte d'un document déposé : le dossier ne sert que du texte, pour y porter le filigrane du lecteur [R114]. */
export const MAX_DOSSIER_TEXT = 1_000_000;

const DEPOSIT_PREFIX = 'commerces/';

/**
 * La place, à partir de 1 et comptée en caractères, de la première moitié de caractère laissée seule dans un texte
 * (un demi-émoji coupé par un copier-coller, que JSON laisse passer), ou `null` si le texte s'écrit tel quel en UTF-8.
 * Le stockage réel écrit en UTF-8, qui remplacerait cette moitié par « � » : le texte relu ne serait plus celui déposé.
 */
export function loneHalfAt(text: string): number | null {
  let place = 0;
  for (const c of text) {
    place += 1;
    const u = c.charCodeAt(0);
    if (c.length === 1 && u >= 0xd800 && u <= 0xdfff) return place;
  }
  return null;
}

/** Un titre de document : rempli, 120 caractères au plus, et qui s'écrit tel quel. */
function goodTitle(title: unknown): title is string {
  return typeof title === 'string' && title.trim() !== '' && title.trim().length <= 120 && loneHalfAt(title) === null;
}

export const DOSSIER_DOCUMENT_KINDS = ['bilan', 'compte_resultat', 'bail', 'liste_materiel', 'autorisation', 'autre'] as const;
export type DossierDocumentKind = (typeof DOSSIER_DOCUMENT_KINDS)[number];

/** La finalité de l'accord de la personne à recevoir le lien de son dossier par mail [R03]. */
export const DOSSIER_PURPOSE = 'dossier_commerce';

export type DossierOutcome = 'ouvert' | 'expire' | 'revoque' | 'epuise' | 'autre_lecteur' | 'porte_fermee';

export interface DossierPage {
  title: string;
  text: string;
}

export interface DossierAccess {
  id: string;
  linkId: string | null;
  personId: string | null;
  outcome: DossierOutcome;
  at: string;
}

/**
 * Un lien envoyé, sans son jeton ni son empreinte. `non_remis` : le contrôle central a refusé son envoi, il n'est jamais
 * parti. `porte_fermee` : valable, mais la porte de CE04 refuserait l'ouverture aujourd'hui ; il se rouvre si elle se rouvre.
 */
export type DossierLinkState = 'actif' | 'porte_fermee' | 'expire' | 'epuise' | 'revoque' | 'non_remis';
export interface DossierLink {
  id: string;
  personId: string;
  createdAt: string;
  expiresAt: string;
  opens: number;
  maxOpens: number;
  state: DossierLinkState;
  revokedAt: string | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R113' | 'R114' | string | null; code: string; codes?: string[]; at?: number };
export type DossierResult<T> = { ok: true; value: T } | Refusal | Problem;

// La marque cachée : un début, 48 bits (0 : espace sans largeur, 1 : antiliant sans largeur), une fin.
const MARK_START = '⁣';
const MARK_END = '⁤';
const ZERO = '​';
const ONE = '‌';
const MARK_BITS = 48;
const FRAME = new RegExp(`${MARK_START}([${ZERO}${ONE}]{${MARK_BITS}})${MARK_END}`, 'gu');
// La référence visible : la même marque, en 10 lettres d'un alphabet sans chiffres ni lettres ambiguës.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefgh';
const REF = /R[ée]f\.?\s*de\s*copie\s*:?\s*([A-Za-z]{5})[-\s]?([A-Za-z]{5})/u;

/** La marque, 12 chiffres hexadécimaux, en caractères sans largeur. */
export function hiddenMark(mark: string): string {
  const bits = BigInt(`0x${mark}`).toString(2).padStart(MARK_BITS, '0');
  return `${MARK_START}${[...bits].map((b) => (b === '1' ? ONE : ZERO)).join('')}${MARK_END}`;
}

/** La marque en référence visible, 10 lettres. */
export function visibleRef(mark: string): string {
  let n = BigInt(`0x${mark}`);
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out = ALPHABET[Number(n % 32n)]! + out;
    n /= 32n;
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Les marques trouvées dans un texte : d'abord les marques cachées, à la majorité, puis la référence visible. */
export function readMarks(text: string): { mark: string; via: 'marque' | 'reference' } | null {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(FRAME)) {
    const bits = [...m[1]!].map((c) => (c === ONE ? '1' : '0')).join('');
    const hex = BigInt(`0b${bits}`).toString(16).padStart(12, '0');
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return { mark: best[0], via: 'marque' };
  // Les invisibles retirés : un outil qui n'en ôte qu'une partie ne cache pas la référence visible.
  const r = REF.exec(text.replace(/\p{Cf}/gu, ''));
  if (!r) return null;
  let n = 0n;
  for (const c of `${r[1]}${r[2]}`) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    n = n * 32n + BigInt(v);
  }
  if (n >= 1n << 48n) return null;
  return { mark: n.toString(16).padStart(12, '0'), via: 'reference' };
}

/**
 * Le texte marqué : la marque cachée après chaque phrase et au bout de chaque ligne, pour qu'un extrait de liste ou de
 * tableau la porte aussi.
 */
function marked(text: string, mark: string): string {
  const hidden = hiddenMark(mark);
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `${line.replace(/([.!?:])(\s)/gu, `$1${hidden}$2`)}${hidden}`))
    .join('\n');
}

const euros = (cents: number): string => {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${int},${String(abs % 100).padStart(2, '0')} €`;
};

const LEASE_USE: Record<string, string> = { all_trades: 'tous commerces', named_activity: 'activité désignée', named_and_related: 'activité désignée et connexes' };
const LEASE_INDEX: Record<string, string> = { ilc: 'indice des loyers commerciaux', ilat: 'indice des loyers des activités tertiaires', icc: 'indice du coût de la construction', aucun: 'sans indexation' };
const LEASE_ASSIGNMENT: Record<string, string> = { free: 'libre', landlord_approval: 'avec l’accord du bailleur', with_business_only: 'avec le fonds seulement' };

/** La fiche complète, en texte, pour la première page du dossier. */
export function sheetText(sheet: BusinessSheet, reference: string, today: string | null = null): string {
  const lines = [`Bien : ${reference}.`];
  if (sheet.activity) lines.push(`Activité : ${ACTIVITY_LABEL[sheet.activity]}.`);
  if (sheet.signName) lines.push(`Enseigne : ${sheet.signName}.`);
  for (const y of sheet.fiscalYears) {
    const ebitda = y.ebitdaCents === undefined ? '' : `, excédent brut d’exploitation ${euros(y.ebitdaCents)}`;
    lines.push(`Exercice ${y.year} : chiffre d’affaires ${euros(y.revenueCents)}, résultat ${euros(y.resultCents)}${ebitda}.`);
  }
  const lease: string[] = [];
  if (sheet.leaseStart) lease.push(`début le ${sheet.leaseStart}`);
  if (sheet.leaseYears !== null) lease.push(`durée ${sheet.leaseYears} ans`);
  if (sheet.leaseAnnualRentCents !== null) lease.push(`loyer annuel ${euros(sheet.leaseAnnualRentCents)}`);
  if (sheet.leaseUse) lease.push(`destination ${LEASE_USE[sheet.leaseUse]}`);
  if (sheet.leaseAssignment) lease.push(`cession ${LEASE_ASSIGNMENT[sheet.leaseAssignment]}`);
  if (sheet.leaseIndex) lease.push(`révision ${LEASE_INDEX[sheet.leaseIndex]}`);
  if (lease.length > 0) lines.push(`Bail commercial : ${lease.join(', ')}.`);
  // Les dates utiles à la cession, calculées par le code depuis le début et la durée du bail (AU101).
  const dates = today ? leaseMilestones(sheet, today) : null;
  if (dates) {
    if (dates.nextTriennial) lines.push(`Prochaine échéance triennale : ${dates.nextTriennial}, congé du preneur à donner au plus tard le ${dates.triennialNoticeBy}.`);
    lines.push(dates.ended ? `Bail arrivé à son terme le ${dates.leaseEnd} : il se prolonge tant qu’aucun congé n’est donné.` : `Fin du bail : ${dates.leaseEnd}, congé à donner au plus tard le ${dates.endNoticeBy}.`);
  }
  if (sheet.employees !== null) lines.push(`Salariés : ${sheet.employees}.`);
  if (sheet.equipment.length > 0) lines.push(`Matériel : ${sheet.equipment.join(', ')}.`);
  if (sheet.licenses.length > 0) lines.push(`Autorisations : ${sheet.licenses.join(', ')}.`);
  return lines.join('\n');
}

/** Un jeton de lien : 40 lettres tirées au hasard, sans biais (environ 188 bits). */
function newToken(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const buf = new Uint8Array(64);
  let out = '';
  while (out.length < 40) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 234 && out.length < 40) out += letters[b % 26];
  }
  return out;
}

/** Une marque de 48 bits, tirée au hasard. */
function newMark(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface LinkRow {
  id: string;
  network_id: string;
  property_id: string;
  person_id: string;
  nda_id: string;
  expires_at: string;
  max_opens: number;
}

export interface DossierCommerceOptions {
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
  newMark?: () => string;
  newCode?: () => string;
  /** Durée de validité d'un lien, en jours. */
  linkDays?: number;
  /** Nombre d'ouvertures permises d'un lien. */
  maxOpens?: number;
  /** L'adresse des pages du dossier ; le jeton suit. */
  baseUrl?: string;
}

/** Ce qu'une ouverture va servir, déjà lu : le rendu ne touche plus ni la base ni le stockage. */
interface DossierContents {
  name: string;
  sheet: string | null;
  documents: { title: string; content: string | null }[];
}

/** Les pages du dossier, chacune avec le filigrane du lecteur et la marque de l'ouverture. */
function renderPages(contents: DossierContents, mark: string, at: Date): DossierPage[] {
  const when = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(at);
  const watermark = `Confidentiel : copie personnelle de ${contents.name}, ouverte le ${when}. Réf. de copie : ${visibleRef(mark)}.`;
  // Le filigrane n'est marqué qu'à sa fin : sa référence visible reste d'un bloc.
  const page = (body: string): string => `${watermark}${hiddenMark(mark)}\n\n${marked(body, mark)}`;
  const out: DossierPage[] = [];
  if (contents.sheet !== null) out.push({ title: 'Fiche du commerce', text: page(contents.sheet) });
  for (const d of contents.documents) out.push({ title: d.title, text: page(d.content ?? 'Document indisponible : votre agent immobilier vous le renverra.') });
  return out;
}

export class DossierCommerce {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newToken: () => string;
  private readonly newMark: () => string;
  private readonly newCode: () => string;
  private readonly linkDays: number;
  private readonly maxOpens: number;
  private readonly baseUrl: string;
  private readonly store: FicheClient;
  private readonly envois: ControleEnvois;
  private readonly fiche: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiches: FicheCommerce,
    private readonly confidentialite: ConfidentialiteCommerce,
    private readonly storage: DossierStorage,
    options: DossierCommerceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newToken = options.newToken ?? newToken;
    this.newMark = options.newMark ?? newMark;
    this.newCode = options.newCode ?? newSignatureCode;
    this.linkDays = options.linkDays ?? 7;
    this.maxOpens = options.maxOpens ?? 5;
    if (!Number.isInteger(this.linkDays) || this.linkDays < 1 || this.linkDays > 30) throw new Error('durée du lien invalide');
    if (!Number.isInteger(this.maxOpens) || this.maxOpens < 1 || this.maxOpens > 50) throw new Error('nombre d’ouvertures invalide');
    this.baseUrl = options.baseUrl ?? 'https://app.aimmo.fr/dossier/';
    this.store = new FicheClient(db, { now: this.now });
    const fiche = new FicheUnique(db, this.store, { now: this.now });
    this.fiche = fiche;
    // Le lien passe par le contrôle central, avec les seuls canaux du mode essai : rangé, jamais envoyé [R26].
    this.envois = new ControleEnvois(db, fiche, new DecisionEnvoi(db, this.store, fiche, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  /** L'agent du bien ou la direction range un document du dossier, par sa référence de stockage et son empreinte. */
  async addDocument(acces: Acces, viewer: Viewer, propertyId: string, input: { kind?: unknown; title?: unknown; storageRef?: unknown }): Promise<DossierResult<{ id: string }>> {
    const g = await this.gate(acces, viewer, propertyId, 'write');
    if (!g.ok) return g;
    const { kind, title, storageRef } = input;
    if (typeof kind !== 'string' || !(DOSSIER_DOCUMENT_KINDS as readonly string[]).includes(kind)) return { ok: false, rule: null, code: 'kind' };
    if (!goodTitle(title)) return { ok: false, rule: null, code: 'title' };
    if (typeof storageRef !== 'string' || storageRef.trim() === '' || storageRef.length > 300) return { ok: false, rule: null, code: 'storage_ref' };
    // Une référence du dépôt porte son bien : elle ne fait jamais entrer dans ce dossier le document d'un autre [R16].
    if (storageRef.startsWith(DEPOSIT_PREFIX) && !storageRef.startsWith(`${DEPOSIT_PREFIX}${viewer.networkId}/${propertyId}/`)) return this.refuse(viewer, propertyId, 'autre_bien');
    const content = await this.storage.read(storageRef);
    if (content === null) return { ok: false, rule: null, code: 'introuvable' };
    const id = this.newId();
    await this.db.run(
      'INSERT INTO business_dossier_documents (id, network_id, property_id, kind, title, storage_ref, content_sha256, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, propertyId, kind, title.trim(), storageRef, await sha256(content), this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'commerces.dossier.document', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { document: id, kind } }, this.now);
    return { ok: true, value: { id } };
  }

  /**
   * L'agent du bien ou la direction dépose le texte d'un document : le serveur choisit la référence, personne ne la
   * saisit. Elle vient de l'empreinte : un dépôt interrompu puis repris écrase sa copie au lieu d'en laisser une autre.
   * Le même texte déjà rangé pour ce bien rend sa ligne, et son contenu perdu est réécrit : recommencer n'ajoute rien.
   */
  async depositText(acces: Acces, viewer: Viewer, propertyId: string, input: { kind?: unknown; title?: unknown; content?: unknown }): Promise<DossierResult<{ id: string; already: boolean; repaired: boolean }>> {
    const g = await this.gate(acces, viewer, propertyId, 'write');
    if (!g.ok) return g;
    const { kind, title, content } = input;
    if (typeof kind !== 'string' || !(DOSSIER_DOCUMENT_KINDS as readonly string[]).includes(kind)) return { ok: false, rule: null, code: 'kind' };
    if (!goodTitle(title)) return { ok: false, rule: null, code: 'title' };
    if (typeof content !== 'string' || content.trim() === '' || content.length > MAX_DOSSIER_TEXT) return { ok: false, rule: null, code: 'content' };
    // Un texte qui ne s'écrit pas tel quel n'est jamais rangé : relu, il ne serait plus celui déposé, et chaque nouveau
    // dépôt se croirait une réparation. La place du premier caractère fautif est dite, pour que l'agent le retrouve.
    const lone = loneHalfAt(content);
    if (lone !== null) return { ok: false, rule: null, code: 'content_malformed', at: lone };
    if (!this.storage.write) return { ok: false, rule: null, code: 'stockage_absent' };
    const sum = await sha256(content);
    const had = await this.db.first<{ id: string; storage_ref: string }>('SELECT id, storage_ref FROM business_dossier_documents WHERE network_id = ? AND property_id = ? AND content_sha256 = ? LIMIT 1', [viewer.networkId, propertyId, sum]);
    if (had) {
      const kept = await this.storage.read(had.storage_ref);
      if (kept === content) return { ok: true, value: { id: had.id, already: true, repaired: false } };
      await this.storage.write(had.storage_ref, content);
      await appendEvent(this.journal, { type: 'commerces.dossier.document', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { document: had.id, kind, repaired: true } }, this.now);
      return { ok: true, value: { id: had.id, already: true, repaired: true } };
    }
    const ref = `${DEPOSIT_PREFIX}${viewer.networkId}/${propertyId}/${sum}`;
    await this.storage.write(ref, content);
    const added = await this.addDocument(acces, viewer, propertyId, { kind, title, storageRef: ref });
    return added.ok ? { ok: true, value: { id: added.value.id, already: false, repaired: false } } : added;
  }

  /** Les documents rangés, sans leur contenu ni leur référence, et si le lecteur les recevrait, pour qui peut en ranger [R16]. */
  async documents(acces: Acces, viewer: Viewer, propertyId: string): Promise<DossierResult<{ id: string; kind: string; title: string; addedAt: string; available: boolean }[]>> {
    const g = await this.gate(acces, viewer, propertyId, 'write');
    if (!g.ok) return g;
    const rows = await this.db.all<{ id: string; kind: string; title: string; added_at: string; storage_ref: string; content_sha256: string }>(
      'SELECT id, kind, title, added_at, storage_ref, content_sha256 FROM business_dossier_documents WHERE network_id = ? AND property_id = ? ORDER BY added_at, rowid',
      [viewer.networkId, propertyId],
    );
    const value = [];
    for (const r of rows) {
      const content = await this.storage.read(r.storage_ref);
      value.push({ id: r.id, kind: r.kind, title: r.title, addedAt: r.added_at, available: content !== null && (await sha256(content)) === r.content_sha256 });
    }
    return { ok: true, value };
  }

  /**
   * Envoie le dossier à un repreneur : seulement par la porte de CE04 [R113]. Un lien personnel, qui expire et ne
   * s'ouvre qu'un nombre de fois réglé, part par le contrôle central en essai [R26]. Le jeton n'est jamais rangé.
   */
  async send(
    acces: Acces,
    viewer: Viewer,
    propertyId: string,
    personId: string,
    input: { consentProof?: unknown },
  ): Promise<DossierResult<{ linkId: string; expiresAt: string; maxOpens: number; mode: 'essai' }>> {
    const g = await this.gate(acces, viewer, propertyId, 'write');
    if (!g.ok) return g;
    // La porte de CE04, avec ses propres contrôles d'accès ; son refus va au journal.
    const door = await this.confidentialite.confidentialSheet(acces, viewer, propertyId, personId);
    if (!door.ok) return door;
    const gate = await this.confidentialite.canSendConfidential(viewer.networkId, propertyId, personId, this.actor(viewer));
    if (!gate.ok) return { ok: false, rule: 'R113', code: 'door_closed', codes: gate.codes };
    if (typeof input.consentProof !== 'string' || input.consentProof.trim() === '' || input.consentProof.length > 300) return { ok: false, rule: null, code: 'bad_consent' };
    const consent = await this.fiche.hasConsentInForce(personId, DOSSIER_PURPOSE, 'email');
    if (!consent) await this.store.addConsent({ networkId: viewer.networkId, personId, purpose: DOSSIER_PURPOSE, channel: 'email', proof: input.consentProof.trim(), givenAt: this.now() });
    const id = this.newId();
    const token = this.newToken();
    const expiresAt = new Date(this.now().getTime() + this.linkDays * 86_400_000).toISOString();
    await this.db.run(
      `INSERT INTO business_dossier_links (id, network_id, property_id, person_id, nda_id, token_hash, expires_at, max_opens, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, propertyId, personId, gate.ndaId, await sha256(token), expiresAt, this.maxOpens, this.actor(viewer), this.now().toISOString()],
    );
    const agent = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ?', [propertyId]);
    const first = await ficheFirstName(this.db, await this.fiche.membersOf(personId));
    const sent = await this.envois.send({
      networkId: viewer.networkId,
      agentId: agent?.agent_id ?? null,
      personId,
      channel: 'email',
      kind: 'alert',
      purpose: DOSSIER_PURPOSE,
      subject: `dossier_commerce:${id}`,
      fallbackTexts: [
        `${first ? `Bonjour ${first},\n\n` : 'Bonjour,\n\n'}Votre agent immobilier vous ouvre le dossier confidentiel du commerce : ${this.baseUrl}${token}. Ce lien vous est personnel, il est valable ${this.linkDays} jours et s’ouvre ${this.maxOpens} fois au plus.`,
      ],
      figures: [this.linkDays, this.maxOpens],
      secrets: [{ kind: 'lien', value: `${this.baseUrl}${token}` }],
    });
    if (sent.status !== 'sent') {
      // Le lien reste, mais sans avoir été remis : il est révoqué aussitôt.
      await this.db.run('INSERT INTO business_dossier_link_revocations (link_id, network_id, revoked_by, revoked_at) VALUES (?, ?, ?, ?)', [id, viewer.networkId, 'systeme', this.now().toISOString()]);
      return { ok: false, rule: sent.rule, code: 'send_refused' };
    }
    await appendEvent(this.journal, { type: 'commerces.dossier.envoye', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R113', link: id, mode: 'essai' } }, this.now);
    return { ok: true, value: { linkId: id, expiresAt, maxOpens: this.maxOpens, mode: 'essai' } };
  }

  /** L'agent du bien ou la direction révoque un lien : il ne s'ouvre plus. */
  async revokeLink(acces: Acces, viewer: Viewer, linkId: string): Promise<DossierResult<{ revokedAt: string }>> {
    const link = await this.db.first<LinkRow>('SELECT * FROM business_dossier_links WHERE id = ? AND network_id = ?', [linkId, viewer.networkId]);
    if (!link) return { ok: false, rule: null, code: 'unknown_link' };
    const g = await this.gate(acces, viewer, link.property_id, 'write');
    if (!g.ok) return g;
    const revokedAt = this.now().toISOString();
    const { changes } = await this.db.run('INSERT INTO business_dossier_link_revocations (link_id, network_id, revoked_by, revoked_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      link.id,
      link.network_id,
      this.actor(viewer),
      revokedAt,
    ]);
    if (changes !== 1) return { ok: false, rule: null, code: 'already_revoked' };
    await appendEvent(this.journal, { type: 'commerces.dossier.lien_revoque', actor: this.actor(viewer), subject: `property:${link.property_id}`, data: { link: link.id } }, this.now);
    return { ok: true, value: { revokedAt } };
  }

  /** Le lien d'un jeton, s'il existe, n'est ni révoqué ni expiré, et si l'adresse donnée est celle de sa personne. */
  private async readerLink(token: unknown, readerEmail: unknown): Promise<{ link: LinkRow; email: string } | Problem> {
    const link = typeof token === 'string' && /^[a-z]{20,80}$/.test(token) ? await this.db.first<LinkRow>('SELECT * FROM business_dossier_links WHERE token_hash = ?', [await sha256(token)]) : null;
    if (!link) {
      await appendEvent(this.journal, { type: 'commerces.dossier.refuse', actor: 'lecteur', subject: null, data: { rule: 'R114', code: 'inconnu' } }, this.now);
      return { ok: false, rule: 'R114', code: 'inconnu' };
    }
    if (await this.db.first('SELECT 1 FROM business_dossier_link_revocations WHERE link_id = ?', [link.id])) return this.refusal(link, 'revoque');
    if (this.now().getTime() > Date.parse(link.expires_at)) return this.refusal(link, 'expire');
    const email = await this.isReader(link, readerEmail);
    if (!email) return this.refusal(link, 'autre_lecteur');
    return { link, email };
  }

  /**
   * Avant chaque ouverture, le lecteur reçoit un code à usage unique à l'adresse de la personne du lien, par le contrôle
   * central (en essai : boîte d'essai) : connaître l'adresse ne suffit pas, il faut la recevoir.
   */
  async requestCode(token: unknown, readerEmail: unknown): Promise<DossierResult<{ expiresAt: string }>> {
    const r = await this.readerLink(token, readerEmail);
    if (!('link' in r)) return r;
    const { link, email } = r;
    const id = this.newId();
    const code = this.newCode();
    const expiresAt = new Date(this.now().getTime() + CODE_TTL_MINUTES * 60_000).toISOString();
    await this.db.run(
      "INSERT INTO business_dossier_open_codes (id, network_id, link_id, code_hash, expires_at, attempts, status, created_at) VALUES (?, ?, ?, ?, ?, 0, 'ouvert', ?)",
      [id, link.network_id, link.id, await sha256(`${id}:${code}`), expiresAt, this.now().toISOString()],
    );
    const agent = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ?', [link.property_id]);
    const sent = await this.envois.send({
      networkId: link.network_id,
      agentId: agent?.agent_id ?? null,
      personId: link.person_id,
      channel: 'email',
      kind: 'alert',
      purpose: DOSSIER_PURPOSE,
      // Le code part à l'adresse que le lecteur a donnée, une des adresses de la personne du lien.
      to: email,
      subject: `dossier_commerce:${id}`,
      fallbackTexts: [`Bonjour,\n\nVotre code pour ouvrir le dossier confidentiel : ${code}. Il est valable ${CODE_TTL_MINUTES} minutes. Ne le donnez à personne.`],
      figures: [code, CODE_TTL_MINUTES],
      secrets: [{ kind: 'code', value: code }],
    });
    if (sent.status !== 'sent') {
      // Un code qui n'est pas parti ne sert jamais.
      await this.db.run("UPDATE business_dossier_open_codes SET status = 'bloque' WHERE id = ? AND status = 'ouvert'", [id]);
      return { ok: false, rule: sent.rule, code: 'send_refused' };
    }
    return { ok: true, value: { expiresAt } };
  }

  /**
   * Le lecteur ouvre le lien avec son adresse et le code reçu. Chaque ouverture et chaque refus est rangé avec son
   * lecteur et journalisé [R114] ; la porte de CE04 est revérifiée [R113]. Chaque page porte le filigrane et la marque.
   */
  async open(token: unknown, readerEmail: unknown, code: unknown): Promise<DossierResult<{ accessId: string; pages: DossierPage[] }>> {
    const r = await this.readerLink(token, readerEmail);
    if (!('link' in r)) return r;
    const { link } = r;
    const codeId = await this.checkCode(link, code);
    if (!codeId) return this.refusal(link, 'autre_lecteur');
    const gate = await this.confidentialite.canSendConfidential(link.network_id, link.property_id, link.person_id, 'lecteur');
    if (!gate.ok) {
      await this.useCode(codeId);
      return this.refusal(link, 'porte_fermee', gate.codes);
    }
    // Tout est lu avant d'écrire quoi que ce soit : une panne ne consomme ni le code ni une ouverture, et le lecteur réessaie.
    let contents: DossierContents;
    try {
      contents = await this.readContents(link);
    } catch {
      // Le message de la panne reste hors du journal : il pourrait nommer un document [R13].
      await appendEvent(
        this.journal,
        { type: 'commerces.dossier.panne', actor: 'lecteur', subject: `property:${link.property_id}`, data: { rule: 'R114', code: 'stockage_indisponible', link: link.id } },
        this.now,
      );
      return { ok: false, rule: null, code: 'stockage_indisponible' };
    }
    if (!(await this.useCode(codeId))) return this.refusal(link, 'autre_lecteur');
    const at = this.now();
    const accessId = this.newId();
    const mark = this.newMark();
    if (!/^[0-9a-f]{12}$/.test(mark)) throw new Error('marque invalide');
    // L'ouverture n'est rangée que s'il en reste : deux ouvertures simultanées ne dépassent pas le nombre réglé.
    const { changes } = await this.db.run(
      `INSERT INTO business_dossier_accesses (id, network_id, property_id, link_id, person_id, outcome, mark, at)
       SELECT ?, ?, ?, ?, ?, 'ouvert', ?, ? WHERE (SELECT COUNT(*) FROM business_dossier_accesses WHERE link_id = ? AND outcome = 'ouvert') < ?`,
      [accessId, link.network_id, link.property_id, link.id, link.person_id, mark, at.toISOString(), link.id, link.max_opens],
    );
    if (changes !== 1) return this.refusal(link, 'epuise');
    await appendEvent(this.journal, { type: 'commerces.dossier.ouvert', actor: 'lecteur', subject: `property:${link.property_id}`, data: { rule: 'R114', access: accessId, link: link.id } }, this.now);
    return { ok: true, value: { accessId, pages: renderPages(contents, mark, at) } };
  }

  /** Le dernier code du lien, encore ouvert et valable, égal au code donné : son identifiant. Un essai faux est compté. */
  private async checkCode(link: LinkRow, code: unknown): Promise<string | null> {
    const row = await this.db.first<{ id: string; code_hash: string; expires_at: string }>(
      "SELECT id, code_hash, expires_at FROM business_dossier_open_codes WHERE link_id = ? AND status = 'ouvert' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      [link.id],
    );
    if (!row || this.now().getTime() > Date.parse(row.expires_at)) return null;
    const given = typeof code === 'string' && /^\d{6}$/.test(code) ? await sha256(`${row.id}:${code}`) : '';
    if (!given || !sameSignatureHash(given, row.code_hash)) {
      await this.db.run(
        "UPDATE business_dossier_open_codes SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'bloque' ELSE status END WHERE id = ? AND status = 'ouvert'",
        [MAX_CODE_ATTEMPTS, row.id],
      );
      return null;
    }
    return row.id;
  }

  /** Consomme le code, une seule fois : de deux ouvertures simultanées, une seule passe. */
  private async useCode(codeId: string): Promise<boolean> {
    const { changes } = await this.db.run("UPDATE business_dossier_open_codes SET status = 'utilise' WHERE id = ? AND status = 'ouvert'", [codeId]);
    return changes === 1;
  }

  /** Les ouvertures et les refus d'un bien, pour qui le voit en entier [R16]. */
  async accesses(acces: Acces, viewer: Viewer, propertyId: string): Promise<DossierResult<DossierAccess[]>> {
    const g = await this.gate(acces, viewer, propertyId, 'read');
    if (!g.ok) return g;
    const rows = await this.db.all<{ id: string; link_id: string | null; person_id: string | null; outcome: DossierOutcome; at: string }>(
      'SELECT id, link_id, person_id, outcome, at FROM business_dossier_accesses WHERE network_id = ? AND property_id = ? ORDER BY at, rowid',
      [viewer.networkId, propertyId],
    );
    return { ok: true, value: rows.map((r) => ({ id: r.id, linkId: r.link_id, personId: r.person_id, outcome: r.outcome, at: r.at })) };
  }

  /** Les liens envoyés pour ce bien, à l'agent du bien ou à la direction : même un lien jamais ouvert peut se retirer. */
  async links(acces: Acces, viewer: Viewer, propertyId: string): Promise<DossierResult<DossierLink[]>> {
    const g = await this.gate(acces, viewer, propertyId, 'write');
    if (!g.ok) return g;
    const rows = await this.db.all<{ id: string; person_id: string; created_at: string; expires_at: string; max_opens: number; revoked_by: string | null; revoked_at: string | null; opens: number }>(
      `SELECT l.id, l.person_id, l.created_at, l.expires_at, l.max_opens, r.revoked_by, r.revoked_at,
              (SELECT COUNT(*) FROM business_dossier_accesses a WHERE a.link_id = l.id AND a.outcome = 'ouvert') AS opens
         FROM business_dossier_links l LEFT JOIN business_dossier_link_revocations r ON r.link_id = l.id
        WHERE l.network_id = ? AND l.property_id = ? ORDER BY l.created_at, l.rowid`,
      [viewer.networkId, propertyId],
    );
    const now = this.now().getTime();
    const value: DossierLink[] = [];
    for (const r of rows) {
      let state: DossierLinkState = r.revoked_at ? (r.revoked_by === 'systeme' ? 'non_remis' : 'revoque') : now > Date.parse(r.expires_at) ? 'expire' : r.opens >= r.max_opens ? 'epuise' : 'actif';
      // La même porte que l'ouverture, sans rien écrire au journal : une lecture n'est pas un refus.
      if (state === 'actif' && !(await this.confidentialite.canSendConfidential(viewer.networkId, propertyId, r.person_id, this.actor(viewer), true)).ok) state = 'porte_fermee';
      value.push({ id: r.id, personId: r.person_id, createdAt: r.created_at, expiresAt: r.expires_at, opens: r.opens, maxOpens: r.max_opens, state, revokedAt: r.revoked_at });
    }
    return { ok: true, value };
  }

  /**
   * Sur un texte qui a fui, l'agent du bien ou la direction retrouve l'ouverture et le lecteur : par la marque cachée,
   * ou par la référence visible. Rien n'est inventé : sans marque connue de ce bien, la réponse est vide.
   */
  async trace(acces: Acces, viewer: Viewer, propertyId: string, text: unknown): Promise<DossierResult<{ accessId: string; personId: string; openedAt: string; via: 'marque' | 'reference' } | null>> {
    const g = await this.gate(acces, viewer, propertyId, 'write');
    if (!g.ok) return g;
    if (typeof text !== 'string' || text.length === 0 || text.length > 2_000_000) return { ok: false, rule: null, code: 'bad_text' };
    const found = readMarks(text);
    const row = found
      ? await this.db.first<{ id: string; person_id: string; at: string }>(
          "SELECT id, person_id, at FROM business_dossier_accesses WHERE network_id = ? AND property_id = ? AND mark = ? AND outcome = 'ouvert'",
          [viewer.networkId, propertyId, found.mark],
        )
      : null;
    await appendEvent(this.journal, { type: 'commerces.dossier.trace', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { found: !!row, ...(row ? { access: row.id, via: found!.via } : {}) } }, this.now);
    return { ok: true, value: row && found ? { accessId: row.id, personId: row.person_id, openedAt: row.at, via: found.via } : null };
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refusal(link: LinkRow, outcome: DossierOutcome, codes?: string[]): Promise<Problem> {
    const id = this.newId();
    await this.db.run('INSERT INTO business_dossier_accesses (id, network_id, property_id, link_id, person_id, outcome, mark, at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)', [
      id,
      link.network_id,
      link.property_id,
      link.id,
      link.person_id,
      outcome,
      this.now().toISOString(),
    ]);
    await appendEvent(
      this.journal,
      { type: 'commerces.dossier.refuse', actor: 'lecteur', subject: `property:${link.property_id}`, data: { rule: 'R114', code: outcome, access: id, link: link.id, ...(codes ? { codes } : {}) } },
      this.now,
    );
    return { ok: false, rule: outcome === 'porte_fermee' ? 'R113' : 'R114', code: outcome, ...(codes ? { codes } : {}) };
  }

  /** L'adresse donnée, normalisée, si c'est une adresse mail de la personne du lien ; sinon `null`. */
  private async isReader(link: LinkRow, email: unknown): Promise<string | null> {
    if (typeof email !== 'string' || email.length > 320) return null;
    const value = normalizeIdentifier('email', email);
    if (!value) return null;
    return (await this.db.first("SELECT 1 FROM person_identifiers WHERE person_id = ? AND kind = 'email' AND value = ?", [link.person_id, value])) ? value : null;
  }

  /** Ce que le dossier sert au lecteur, lu sans rien écrire. Un document manquant ou changé est `null` ; une panne remonte. */
  private async readContents(link: LinkRow): Promise<DossierContents> {
    const person = await this.db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [link.person_id]);
    const name = [person?.first_name, person?.last_name].filter((x): x is string => !!x).join(' ') || 'lecteur identifié';
    const sheet = await this.fiches.current(link.property_id);
    const property = await this.db.first<{ reference: string }>('SELECT reference FROM properties WHERE id = ?', [link.property_id]);
    const docs = await this.db.all<{ title: string; storage_ref: string; content_sha256: string }>(
      'SELECT title, storage_ref, content_sha256 FROM business_dossier_documents WHERE network_id = ? AND property_id = ? ORDER BY added_at, rowid',
      [link.network_id, link.property_id],
    );
    const documents: DossierContents['documents'] = [];
    for (const d of docs) {
      const content = await this.storage.read(d.storage_ref);
      // Un document changé depuis qu'il a été rangé n'est pas servi : ce n'est plus celui que l'agent a mis au dossier.
      documents.push({ title: d.title, content: content !== null && (await sha256(content)) === d.content_sha256 ? content : null });
    }
    return { name, sheet: sheet ? sheetText(sheet.sheet, property?.reference ?? '', this.now().toISOString().slice(0, 10)) : null, documents };
  }

  /** Qui voit le bien en entier lit ; l'agent du bien et la direction écrivent [R16]. */
  private async gate(acces: Acces, viewer: Viewer, propertyId: string, need: 'read' | 'write'): Promise<{ ok: true } | Refusal | Problem> {
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, propertyId, 'not_assigned');
    if (need === 'write' && !((viewer.role === 'agent' && read.value.agent_id === viewer.userId) || viewer.role === 'direction')) return this.refuse(viewer, propertyId, 'role');
    if (!(await this.fiches.publicView(propertyId))) return { ok: false, rule: null, code: 'sorte' };
    return { ok: true };
  }

  private async refuse(viewer: Viewer, propertyId: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'business_dossier', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }
}
