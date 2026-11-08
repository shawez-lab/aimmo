/**
 * Photos corrigées honnêtement, avec leur certificat (M19, X02) [R130].
 *
 * La photo est corrigée sur le téléphone de l'agent, jamais sur un serveur : le serveur ne reçoit que la description de
 * ce qui a été fait. Une description n'est rangée que si :
 * - chaque correction est une correction d'ensemble prise dans la liste fermée (exposition, balance des blancs,
 *   contraste, verticales, netteté, recadrage), une fois chacune, avec des réglages bornés ; toute retouche locale
 *   (zone, masque, pinceau, effacement, clonage…) ou toute autre opération est refusée ;
 * - l'original est gardé : sa référence de stockage (`biens/<bien>/originaux/<uuid>.<ext>`, jamais publiée) et son
 *   empreinte sont rangées avec celles du résultat ;
 * - le résultat est une photo de la fiche du bien (M07) ;
 * - l'original et le résultat sont bien dans le stockage (seule leur existence est lue) ; une panne ferme tout.
 *
 * Lecture prudente : un recadrage garde au moins 60 % de la largeur et de la hauteur, pour qu'il ne serve pas à sortir
 * un défaut du cadre (« aucune correction ne cache un défaut »).
 *
 * Jamais vu : chaque photo publiée porte un certificat d'honnêteté lisible par le client, ouvert par un lien au jeton
 * tiré au hasard. Il ne dit ni l'adresse, ni le bien, ni l'agent [R46, R13] : seulement les corrections faites, que
 * l'original est gardé, qu'aucune retouche locale n'a été faite, l'aménagement virtuel quand il y en a un (R48), et
 * l'empreinte de l'image, que chacun peut recalculer sur la photo qu'il voit.
 *
 * Une photo sans certificat, donc sans original rangé, ne peut pas être publiée par le Studio [R130].
 *
 * Assoupli par HX40 (décision de Shawez du 2026-11-06) [R490] : trois retouches locales sont admises, déclarées à part
 * des corrections d'ensemble, dans une liste fermée : ciel remplacé, reflets atténués, objet mobile retiré (lui-même
 * pris dans une liste fermée : jamais une fissure, une tache, un pylône ni rien qui tienne au bien ou à sa vue). Chacune
 * est inscrite au certificat, et l'image retouchée porte la mention « Photo retouchée », posée sur l'appareil et
 * déclarée avec la description ; sans elle, la description est refusée.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { orderGallery, stagingView, type StagingChangeKind } from '../medias/amenagement.ts';

export const PHOTO_OPERATIONS = ['exposition', 'balance_des_blancs', 'contraste', 'verticales', 'nettete', 'recadrage'] as const;
export type PhotoOperationKind = (typeof PHOTO_OPERATIONS)[number];

export type PhotoOperation =
  | { op: 'exposition'; ev: number }
  | { op: 'balance_des_blancs'; kelvin: number }
  | { op: 'contraste'; amount: number }
  | { op: 'verticales'; degrees: number }
  | { op: 'nettete'; amount: number }
  | { op: 'recadrage'; x: number; y: number; width: number; height: number };

/** Ce qui trahit une retouche locale : une zone, un masque, un pinceau, ou une opération qui efface ou ajoute. */
const LOCAL_KEYS = new Set(['zone', 'zones', 'masque', 'mask', 'region', 'regions', 'pinceau', 'brush', 'points', 'selection', 'polygone', 'polygon', 'calque', 'layer']);
const LOCAL_OPS = /effac|gomm|tampon|clon|inpaint|remplissage|fill|heal|correcteur|suppression|retir|remove|erase|patch|lissage|liquify|fluidit|ajout|insert|objet|ciel|sky|maquill|peau|visage|flou_local|blur_local/i;

/** Les réglages admis de chaque correction : bornés, pour qu'une correction reste une correction. */
const PARAMS: Record<PhotoOperationKind, Record<string, { min: number; max: number; integer: boolean }>> = {
  exposition: { ev: { min: -3, max: 3, integer: false } },
  balance_des_blancs: { kelvin: { min: 2000, max: 12000, integer: true } },
  contraste: { amount: { min: -100, max: 100, integer: true } },
  verticales: { degrees: { min: -15, max: 15, integer: false } },
  nettete: { amount: { min: 0, max: 100, integer: true } },
  recadrage: {
    x: { min: 0, max: 0.4, integer: false },
    y: { min: 0, max: 0.4, integer: false },
    width: { min: 0.6, max: 1, integer: false },
    height: { min: 0.6, max: 1, integer: false },
  },
};

export const OPERATION_LABELS: Record<PhotoOperationKind, string> = {
  exposition: 'Exposition',
  balance_des_blancs: 'Balance des blancs',
  contraste: 'Contraste',
  verticales: 'Verticales redressées',
  nettete: 'Netteté',
  recadrage: 'Recadrage',
};

/** Les retouches locales admises (HX40), en liste fermée [R490]. */
export const LOCAL_EDIT_KINDS = ['ciel', 'reflets', 'objet_retire'] as const;
export type LocalEditKind = (typeof LOCAL_EDIT_KINDS)[number];

/**
 * Les objets qu'une retouche peut retirer : des objets mobiles, qui ne font pas partie du bien et ne disent rien de son
 * état ni de son environnement. Tout le reste (fissure, tache, humidité, câble électrique apparent, pylône, antenne,
 * vis-à-vis, voiture garée devant…) reste sur la photo : aucune retouche ne cache un défaut [R490].
 */
export const REMOVABLE_OBJECTS = ['objet_personnel', 'photo_de_famille', 'linge', 'jouet', 'vaisselle', 'produit_menager', 'poubelle_mobile'] as const;
export type RemovableObject = (typeof REMOVABLE_OBJECTS)[number];

export type LocalEdit = { kind: 'ciel' } | { kind: 'reflets' } | { kind: 'objet_retire'; object: RemovableObject };

/** La mention posée sur une image retouchée par endroit [R490]. */
export const RETOUCH_MENTION = 'Photo retouchée';

export const LOCAL_EDIT_LABELS: Record<LocalEditKind, string> = { ciel: 'Ciel remplacé', reflets: 'Reflets atténués', objet_retire: 'Objet retiré' };

export const REMOVABLE_OBJECT_LABELS: Record<RemovableObject, string> = {
  objet_personnel: 'un objet personnel',
  photo_de_famille: 'une photo de famille',
  linge: 'du linge',
  jouet: 'un jouet',
  vaisselle: 'de la vaisselle',
  produit_menager: 'un produit ménager',
  poubelle_mobile: 'une poubelle mobile',
};

export type LocalEditsCheck = { ok: true; value: LocalEdit[] } | { ok: false; code: 'retouches_invalides' | 'retouche_hors_liste' | 'objet_hors_liste' | 'retouche_en_double'; index: number | null };

/** Contrôle les retouches locales déclarées : liste fermée, une fois chacune, objets retirés d'une liste fermée [R490]. */
export function checkLocalEdits(input: unknown): LocalEditsCheck {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input) || input.length > 2 + REMOVABLE_OBJECTS.length) return { ok: false, code: 'retouches_invalides', index: null };
  const seen = new Set<string>();
  const out: LocalEdit[] = [];
  for (const [i, raw] of input.entries()) {
    if (!isRecord(raw) || typeof raw.kind !== 'string') return { ok: false, code: 'retouches_invalides', index: i };
    if (!(LOCAL_EDIT_KINDS as readonly string[]).includes(raw.kind)) return { ok: false, code: 'retouche_hors_liste', index: i };
    const keys = Object.keys(raw).filter((k) => k !== 'kind');
    if (raw.kind === 'objet_retire') {
      if (keys.length !== 1 || keys[0] !== 'object') return { ok: false, code: 'retouches_invalides', index: i };
      if (typeof raw.object !== 'string' || !(REMOVABLE_OBJECTS as readonly string[]).includes(raw.object)) return { ok: false, code: 'objet_hors_liste', index: i };
      const key = `objet_retire:${raw.object}`;
      if (seen.has(key)) return { ok: false, code: 'retouche_en_double', index: i };
      seen.add(key);
      out.push({ kind: 'objet_retire', object: raw.object as RemovableObject });
      continue;
    }
    if (keys.length !== 0) return { ok: false, code: 'retouches_invalides', index: i };
    if (seen.has(raw.kind)) return { ok: false, code: 'retouche_en_double', index: i };
    seen.add(raw.kind);
    out.push({ kind: raw.kind as 'ciel' | 'reflets' });
  }
  return { ok: true, value: out };
}

/** Une retouche locale dite en français, pour le client. */
export function describeLocalEdit(e: LocalEdit): string {
  switch (e.kind) {
    case 'ciel':
      return 'Ciel remplacé par un autre ciel';
    case 'reflets':
      return 'Reflets atténués sur les vitres ou les miroirs';
    case 'objet_retire':
      return `Objet retiré : ${REMOVABLE_OBJECT_LABELS[e.object]}, qui ne fait pas partie du bien`;
  }
}

export type OperationsCheck = { ok: true; value: PhotoOperation[] } | { ok: false; code: 'retouche_locale' | 'operation_hors_liste' | 'reglage_invalide' | 'operation_en_double' | 'operations_invalides'; index: number | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Contrôle la liste des corrections : liste fermée, une fois chacune, réglages bornés, aucune retouche locale [R130]. */
export function checkOperations(input: unknown): OperationsCheck {
  if (!Array.isArray(input) || input.length > PHOTO_OPERATIONS.length) return { ok: false, code: 'operations_invalides', index: null };
  const seen = new Set<string>();
  const out: PhotoOperation[] = [];
  for (const [i, raw] of input.entries()) {
    if (!isRecord(raw) || typeof raw.op !== 'string') return { ok: false, code: 'operations_invalides', index: i };
    const keys = Object.keys(raw).filter((k) => k !== 'op');
    if (keys.some((k) => LOCAL_KEYS.has(k.toLowerCase())) || LOCAL_OPS.test(raw.op)) return { ok: false, code: 'retouche_locale', index: i };
    if (!(PHOTO_OPERATIONS as readonly string[]).includes(raw.op)) return { ok: false, code: 'operation_hors_liste', index: i };
    const op = raw.op as PhotoOperationKind;
    if (seen.has(op)) return { ok: false, code: 'operation_en_double', index: i };
    seen.add(op);
    const spec = PARAMS[op];
    if (keys.length !== Object.keys(spec).length || keys.some((k) => !(k in spec))) return { ok: false, code: 'reglage_invalide', index: i };
    for (const [k, s] of Object.entries(spec)) {
      const v = raw[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < s.min || v > s.max || (s.integer && !Number.isInteger(v))) return { ok: false, code: 'reglage_invalide', index: i };
    }
    if (op === 'recadrage' && ((raw.x as number) + (raw.width as number) > 1 + 1e-9 || (raw.y as number) + (raw.height as number) > 1 + 1e-9)) return { ok: false, code: 'reglage_invalide', index: i };
    const value = Object.fromEntries([['op', op], ...Object.keys(spec).map((k) => [k, raw[k]])]) as PhotoOperation;
    out.push(value);
  }
  return { ok: true, value: out };
}

const fr = (n: number, digits: number): string => n.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const signed = (n: number, digits: number): string => (n > 0 ? '+' : n < 0 ? '−' : '') + fr(Math.abs(n), digits);

/** Une correction dite en français, pour le client. */
export function describeOperation(o: PhotoOperation): string {
  switch (o.op) {
    case 'exposition':
      return `Exposition : ${signed(o.ev, 1)} IL, sur toute l’image`;
    case 'balance_des_blancs':
      return `Balance des blancs : ${fr(o.kelvin, 0)} K, sur toute l’image`;
    case 'contraste':
      return `Contraste : ${signed(o.amount, 0)} sur 100, sur toute l’image`;
    case 'verticales':
      return `Verticales redressées : ${signed(o.degrees, 1)}°`;
    case 'nettete':
      return `Netteté : ${fr(o.amount, 0)} sur 100, sur toute l’image`;
    case 'recadrage':
      return `Recadrage : ${fr(Math.round(o.width * 100), 0)} % de la largeur et ${fr(Math.round(o.height * 100), 0)} % de la hauteur gardés`;
  }
}

/** Le certificat d'honnêteté, tel que le client le lit : ni adresse, ni bien, ni agent, ni nom [R46, R13]. */
export interface PhotoCertificate {
  token: string;
  /** `AAAA-MM-JJ`, le jour où la description a été rangée. */
  issuedOn: string;
  resultSha256: string;
  originalSha256: string;
  originalKept: true;
  /** « aucune », l'aménagement virtuel [R48], ou des retouches locales déclarées [R490] ; toujours dits sur l'image. */
  localEdits: 'aucune' | 'amenagement_virtuel' | 'retouches_declarees';
  /** Chaque retouche locale déclarée, dans l'ordre [R490]. */
  retouches: { kind: LocalEditKind; label: string; detail: string }[];
  /** La mention « Photo retouchée » posée sur l'image, ou null [R490]. */
  retouchMention: typeof RETOUCH_MENTION | null;
  corrections: { op: PhotoOperationKind; label: string; detail: string }[];
  virtualStaging: boolean;
  /** La mention posée sur l'image, ou null [R48]. */
  mention: 'Aménagement virtuel' | null;
  /** Ce qui a changé sur une image aménagée, déclaré par HX41, ligne par ligne ; absent tant que rien n'est déclaré [R492]. */
  stagingChanges?: { kind: StagingChangeKind; label: string; detail: string }[];
  statement: string;
  path: string;
}

export const CERTIFICATE_PATH = '/certificat-photo/';

export interface CertifiedPhoto {
  ref: string;
  overlay: 'Aménagement virtuel' | null;
  /** La mention « Photo retouchée », déjà posée sur l'image, ou null [R490]. */
  retouchMention: typeof RETOUCH_MENTION | null;
  /** Les sortes de retouches locales déclarées [R490]. */
  retouches: LocalEditKind[];
  certificateToken: string;
  certificatePath: string;
}

export type CertResult<T> = { ok: true; value: T } | { ok: false; rule: 'R16' | 'R10' | 'R130'; code: string };

interface CertRow {
  token: string;
  property_id: string;
  result_ref: string;
  result_sha256: string;
  original_ref: string;
  original_sha256: string;
  operations: string;
  local_edits: string;
  virtual_staging: number;
  recorded_at: string;
}

interface SheetMedia {
  ref?: unknown;
  kind?: unknown;
  edit?: unknown;
}

const SHA = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function retouchSentence(edits: LocalEdit[]): string {
  const list = edits.map((e) => (e.kind === 'objet_retire' ? `objet retiré (${REMOVABLE_OBJECT_LABELS[e.object]})` : LOCAL_EDIT_LABELS[e.kind].toLowerCase())).join(', ');
  return `Retouches locales déclarées : ${list}. La mention « ${RETOUCH_MENTION} » est posée sur l’image. Aucun défaut du bien n’a été effacé ni caché.`;
}

function statementOf(ops: PhotoOperation[], virtualStaging: boolean, edits: LocalEdit[] = [], staging?: { detail: string }[]): string {
  const list = ops.map((o) => OPERATION_LABELS[o.op].toLowerCase()).join(', ');
  if (virtualStaging) {
    // Un aménagement virtuel ajoute du mobilier ou simule des travaux à un endroit précis : on le dit tel quel.
    return [
      'Aménagement virtuel : cette image n’est pas une photo telle quelle. Le mobilier ou les travaux montrés sont simulés, la mention est posée sur l’image.',
      ...(staging && staging.length > 0 ? [`Ce qui a changé : ${staging.map((c) => c.detail.charAt(0).toLowerCase() + c.detail.slice(1)).join(' ; ')}.`, 'La photo réelle du même cliché est publiée juste avant elle.'] : []),
      ops.length === 0 ? 'Aucune autre correction.' : `Autres corrections, d’ensemble : ${list}.`,
      edits.length === 0 ? 'Rien n’a été effacé ni caché.' : retouchSentence(edits),
      'La photo d’origine, sans aménagement, est gardée telle qu’elle a été prise.',
    ].join(' ');
  }
  if (edits.length > 0) {
    return [
      ops.length === 0 ? 'Corrections d’ensemble : aucune.' : `Corrections d’ensemble : ${list}.`,
      retouchSentence(edits),
      'L’original est gardé, tel qu’il a été pris.',
      'Les corrections ont été faites sur le téléphone de l’agent.',
    ].join(' ');
  }
  return [
    ops.length === 0 ? 'Cette photo n’a reçu aucune correction.' : `Cette photo n’a reçu que des corrections d’ensemble : ${list}.`,
    'Aucune retouche locale : rien n’a été effacé, caché ni ajouté par endroit.',
    'L’original est gardé, tel qu’il a été pris.',
    'Les corrections ont été faites sur le téléphone de l’agent.',
  ].join(' ');
}

/** Les retouches rangées ; une ligne d'avant HX40 n'en a aucune. */
function parseLocalEdits(raw: string | null | undefined): LocalEdit[] {
  if (!raw) return [];
  const check = checkLocalEdits(JSON.parse(raw) as unknown);
  if (!check.ok) throw new Error('Retouches rangées illisibles');
  return check.value;
}

/** Le stockage des photos : seule l'existence d'une référence est lue, jamais son contenu. */
export interface PhotoFileStore {
  has(ref: string): Promise<boolean>;
}

export interface CertificatsPhotosOptions {
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
}

export class CertificatsPhotos {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newToken: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly files: PhotoFileStore,
    options: CertificatsPhotosOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newToken = options.newToken ?? randomToken;
  }

  /**
   * L'agent du bien, ou la direction, range la description d'une photo corrigée sur son téléphone. Une fois rangée,
   * elle ne change plus : une autre correction donne une autre photo, sous une autre référence [R17].
   */
  async record(
    viewer: Viewer,
    propertyId: string,
    input: { resultRef: unknown; resultSha256: unknown; originalRef: unknown; originalSha256: unknown; operations: unknown; processedOn: unknown; localEdits?: unknown; mentionOnImage?: unknown },
  ): Promise<CertResult<PhotoCertificate>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    const actor = `${viewer.role}:${viewer.userId}`;
    const bad = async (rule: 'R10' | 'R130', code: string): Promise<CertResult<PhotoCertificate>> => {
      await appendEvent(this.journal, { type: 'studio.photo.refuse', actor, subject: `property:${propertyId}`, data: { rule, code } }, this.now);
      return { ok: false, rule, code };
    };
    if (input.processedOn !== 'appareil') return bad('R130', 'traitement_hors_appareil');
    const ops = checkOperations(input.operations);
    if (!ops.ok) return bad('R130', ops.code);
    const edits = checkLocalEdits(input.localEdits);
    if (!edits.ok) return bad('R130', edits.code);
    // Une retouche locale sans la mention posée sur l'image est refusée ; une mention sans retouche le serait aussi [R490].
    const mention = input.mentionOnImage ?? null;
    if (edits.value.length > 0 && mention !== RETOUCH_MENTION) return bad('R130', 'retouche_sans_mention');
    if (edits.value.length === 0 && mention !== null) return bad('R10', 'mention_sans_retouche');
    const originalPattern = new RegExp(`^biens/${propertyId.replace(/[^0-9A-Za-z_-]/g, '\\$&')}/originaux/${UUID}\\.(?:jpg|png|webp|heic|dng)$`);
    if (typeof input.originalRef !== 'string' || !originalPattern.test(input.originalRef)) return bad('R130', 'sans_original');
    if (typeof input.originalSha256 !== 'string' || !SHA.test(input.originalSha256)) return bad('R130', 'sans_original');
    if (typeof input.resultSha256 !== 'string' || !SHA.test(input.resultSha256)) return bad('R10', 'empreinte_invalide');
    const sheet = await this.sheetPhotos(propertyId, actor);
    if (sheet === 'illisible') return { ok: false, rule: 'R10', code: 'fiche_illisible' };
    const media = typeof input.resultRef === 'string' ? (sheet.find((m) => m.ref === input.resultRef) ?? null) : null;
    if (!media) return bad('R10', 'photo_inconnue');
    // L'original et le résultat doivent être dans le stockage : on ne certifie pas ce qui n'est pas gardé [R130].
    const stored = await this.stored([input.originalRef, media.ref]);
    if (stored === 'indisponible') return bad('R130', 'stockage_indisponible');
    if (!stored[0]) return bad('R130', 'original_absent');
    if (!stored[1]) return bad('R10', 'photo_absente');
    // Aucune correction ni aménagement : l'image publiée est l'original, à l'octet près. Sinon : elle en diffère.
    const unchanged = ops.value.length === 0 && edits.value.length === 0 && media.edit !== 'amenagement_virtuel';
    if (unchanged !== (input.resultSha256 === input.originalSha256)) return bad('R10', 'empreinte_incoherente');
    // La fiche dit « aucune retouche » : une photo corrigée la contredirait.
    if (media.edit === 'aucune' && (ops.value.length > 0 || edits.value.length > 0)) return bad('R10', 'fiche_dit_aucune');
    const existing = await this.db.first<CertRow>('SELECT * FROM photo_certificates WHERE property_id = ? AND result_ref = ?', [propertyId, media.ref]);
    if (existing) {
      const same = existing.result_sha256 === input.resultSha256 && existing.original_sha256 === input.originalSha256 && existing.operations === JSON.stringify(ops.value) && existing.local_edits === JSON.stringify(edits.value);
      return same ? { ok: true, value: this.view(existing) } : bad('R10', 'deja_certifiee');
    }
    const token = this.newToken();
    if (!TOKEN.test(token)) throw new Error('Jeton de certificat invalide');
    const row: CertRow = {
      token,
      property_id: propertyId,
      result_ref: media.ref,
      result_sha256: input.resultSha256,
      original_ref: input.originalRef,
      original_sha256: input.originalSha256,
      operations: JSON.stringify(ops.value),
      local_edits: JSON.stringify(edits.value),
      virtual_staging: media.edit === 'amenagement_virtuel' ? 1 : 0,
      recorded_at: this.now().toISOString(),
    };
    const { changes } = await this.db.run(
      `INSERT INTO photo_certificates (id, token, property_id, network_id, result_ref, result_sha256, original_ref, original_sha256, operations, local_edits, virtual_staging, processed_on, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'appareil', ?, ?) ON CONFLICT DO NOTHING`,
      [this.newId(), row.token, propertyId, seen.value.network_id, row.result_ref, row.result_sha256, input.originalRef, row.original_sha256, row.operations, row.local_edits, row.virtual_staging, actor, row.recorded_at],
    );
    if (changes !== 1) {
      // Rangé en même temps par un autre geste : on relit ce qui est rangé.
      const now = await this.db.first<CertRow>('SELECT * FROM photo_certificates WHERE property_id = ? AND result_ref = ?', [propertyId, media.ref]);
      if (now && now.result_sha256 === row.result_sha256 && now.original_sha256 === row.original_sha256 && now.operations === row.operations && now.local_edits === row.local_edits) return { ok: true, value: this.view(now) };
      return bad('R10', 'deja_certifiee');
    }
    await appendEvent(this.journal, { type: 'studio.photo.certifiee', actor, subject: `property:${propertyId}`, data: { operations: ops.value.map((o) => o.op), retouches: edits.value.map((e) => e.kind) } }, this.now);
    return { ok: true, value: this.view(row) };
  }

  /** Le certificat, lu par n'importe qui avec son lien : rien qui situe le bien ni qui nomme quelqu'un. */
  async certificate(token: unknown): Promise<PhotoCertificate | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const row = await this.db.first<CertRow>('SELECT * FROM photo_certificates WHERE token = ?', [token]);
    if (!row) return null;
    // Une image aménagée dit ce qui a changé dès que l'agent l'a déclaré (HX41) [R492].
    const staging = row.virtual_staging === 1 ? await this.db.first<{ changes: string }>('SELECT changes FROM virtual_stagings WHERE staged_token = ?', [token]) : null;
    return this.view(row, staging ? stagingView(staging.changes) : undefined);
  }

  /**
   * Les photos du bien que le Studio peut publier : celles de la dernière version de la fiche qui ont leur certificat,
   * avec la mention d'aménagement virtuel quand il y en a une [R130, R48]. Une photo sans certificat n'y est pas, ni
   * une photo dont l'original n'est plus dans le stockage : rien ne part tant que le stockage ne répond pas.
   */
  async publishable(propertyId: string): Promise<CertifiedPhoto[]> {
    const media = await this.sheetPhotos(propertyId, 'systeme:studio');
    if (media === 'illisible') return [];
    const rows = await this.db.all<CertRow>('SELECT * FROM photo_certificates WHERE property_id = ?', [propertyId]);
    const byRef = new Map(rows.map((r) => [r.result_ref, r]));
    const out: CertifiedPhoto[] = [];
    for (const m of media) {
      const c = byRef.get(m.ref);
      if (!c) continue;
      // La fiche dit désormais « aménagement virtuel » d'une photo certifiée sans : le certificat ne dit plus vrai,
      // la photo ne part pas tant qu'une nouvelle photo n'a pas son certificat [R130, R48]. L'inverse garde la mention.
      if (m.edit === 'amenagement_virtuel' && c.virtual_staging !== 1) continue;
      const stored = await this.stored([c.original_ref, m.ref]);
      if (stored === 'indisponible') return [];
      if (!stored[0] || !stored[1]) continue;
      const retouches = parseLocalEdits(c.local_edits);
      out.push({ ref: m.ref, overlay: c.virtual_staging === 1 ? 'Aménagement virtuel' : null, retouchMention: retouches.length > 0 ? RETOUCH_MENTION : null, retouches: retouches.map((e) => e.kind), certificateToken: c.token, certificatePath: CERTIFICATE_PATH + c.token });
    }
    // Une image aménagée ne part qu'avec sa jumelle réelle déclarée (HX41), juste après elle : jamais en couverture,
    // jamais seule photo de sa pièce [R493].
    const twins = await this.db.all<{ staged_ref: string; real_ref: string; staged_token: string }>('SELECT staged_ref, real_ref, staged_token FROM virtual_stagings WHERE property_id = ?', [propertyId]);
    const tokens = new Map(out.map((p) => [p.ref, p.certificateToken] as const));
    // Une déclaration vaut pour l'image certifiée qu'elle a vue, pas pour une autre rangée sous la même référence.
    const valid = twins.filter((t) => tokens.get(t.staged_ref) === t.staged_token);
    return orderGallery(out, new Map(valid.map((t) => [t.staged_ref, t.real_ref] as const))).photos;
  }

  /** Une photo peut-elle partir ? Seulement de la fiche et avec son certificat [R130]. */
  async checkPublishable(propertyId: string, ref: unknown): Promise<{ ok: true; value: CertifiedPhoto } | { ok: false; rule: 'R130' | 'R10'; code: 'sans_certificat' | 'photo_inconnue' }> {
    const sheet = await this.sheetPhotos(propertyId, 'systeme:studio');
    if (sheet === 'illisible' || typeof ref !== 'string' || !sheet.some((m) => m.ref === ref)) return { ok: false, rule: 'R10', code: 'photo_inconnue' };
    const found = (await this.publishable(propertyId)).find((p) => p.ref === ref);
    return found ? { ok: true, value: found } : { ok: false, rule: 'R130', code: 'sans_certificat' };
  }

  private view(row: CertRow, stagingChanges?: PhotoCertificate['stagingChanges']): PhotoCertificate {
    const ops = JSON.parse(row.operations) as PhotoOperation[];
    const staged = row.virtual_staging === 1;
    const edits = parseLocalEdits(row.local_edits);
    return {
      token: row.token,
      issuedOn: row.recorded_at.slice(0, 10),
      resultSha256: row.result_sha256,
      originalSha256: row.original_sha256,
      originalKept: true,
      localEdits: staged ? 'amenagement_virtuel' : edits.length > 0 ? 'retouches_declarees' : 'aucune',
      retouches: edits.map((e) => ({ kind: e.kind, label: LOCAL_EDIT_LABELS[e.kind], detail: describeLocalEdit(e) })),
      retouchMention: edits.length > 0 ? RETOUCH_MENTION : null,
      corrections: ops.map((o) => ({ op: o.op, label: OPERATION_LABELS[o.op], detail: describeOperation(o) })),
      virtualStaging: staged,
      mention: staged ? 'Aménagement virtuel' : null,
      ...(stagingChanges ? { stagingChanges } : {}),
      statement: statementOf(ops, staged, edits, stagingChanges),
      path: CERTIFICATE_PATH + row.token,
    };
  }

  /** Les photos de la dernière fiche ; une fiche illisible est dite au journal, jamais prise pour une fiche vide. */
  private async sheetPhotos(propertyId: string, actor: string): Promise<{ ref: string; edit: string }[] | 'illisible'> {
    const row = await this.db.first<{ data: string; version: number }>('SELECT data, version FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    if (!row) return [];
    let media: unknown;
    try {
      const data = JSON.parse(row.data) as unknown;
      media = isRecord(data) ? (data.media ?? []) : null;
    } catch {
      media = null;
    }
    if (!Array.isArray(media)) {
      await appendEvent(this.journal, { type: 'studio.photo.fiche_illisible', actor, subject: `property:${propertyId}`, data: { rule: 'R10', version: row.version } }, this.now);
      return 'illisible';
    }
    return (media as SheetMedia[])
      .filter((m) => isRecord(m) && m.kind === 'photo' && typeof m.ref === 'string' && typeof m.edit === 'string')
      .map((m) => ({ ref: m.ref as string, edit: m.edit as string }));
  }

  /** L'existence de chaque référence dans le stockage ; une panne du stockage ferme tout [R130]. */
  private async stored(refs: string[]): Promise<boolean[] | 'indisponible'> {
    try {
      return await Promise.all(refs.map((r) => this.files.has(r)));
    } catch (error) {
      await appendEvent(this.journal, { type: 'studio.photo.stockage_indisponible', actor: 'systeme:studio', subject: null, data: { rule: 'R130', error: error instanceof Error ? error.name : 'inconnue' } }, this.now);
      return 'indisponible';
    }
  }

  private async full(viewer: Viewer, propertyId: string): Promise<CertResult<{ network_id: string }>> {
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    return { ok: true, value: { network_id: read.value.network_id } };
  }

  private async refused<T>(viewer: Viewer, propertyId: string, code: string): Promise<CertResult<T>> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'photo_certificate', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
