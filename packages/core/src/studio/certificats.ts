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
 * - le résultat est une photo de la fiche du bien (M07).
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
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

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
  /** « aucune », ou l'aménagement virtuel, seule modification par endroit admise, toujours dite sur l'image [R48]. */
  localEdits: 'aucune' | 'amenagement_virtuel';
  corrections: { op: PhotoOperationKind; label: string; detail: string }[];
  virtualStaging: boolean;
  /** La mention posée sur l'image, ou null [R48]. */
  mention: 'Aménagement virtuel' | null;
  statement: string;
  path: string;
}

export const CERTIFICATE_PATH = '/certificat-photo/';

export interface CertifiedPhoto {
  ref: string;
  overlay: 'Aménagement virtuel' | null;
  certificateToken: string;
  certificatePath: string;
}

export type CertResult<T> = { ok: true; value: T } | { ok: false; rule: 'R16' | 'R10' | 'R130'; code: string };

interface CertRow {
  token: string;
  property_id: string;
  result_ref: string;
  result_sha256: string;
  original_sha256: string;
  operations: string;
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

function statementOf(ops: PhotoOperation[], virtualStaging: boolean): string {
  const list = ops.map((o) => OPERATION_LABELS[o.op].toLowerCase()).join(', ');
  if (virtualStaging) {
    // Un aménagement virtuel ajoute du mobilier ou simule des travaux à un endroit précis : on le dit tel quel.
    return [
      'Aménagement virtuel : cette image n’est pas une photo telle quelle. Le mobilier ou les travaux montrés sont simulés, la mention est posée sur l’image.',
      ops.length === 0 ? 'Aucune autre correction.' : `Autres corrections, d’ensemble : ${list}.`,
      'Rien n’a été effacé ni caché.',
      'La photo d’origine, sans aménagement, est gardée telle qu’elle a été prise.',
    ].join(' ');
  }
  return [
    ops.length === 0 ? 'Cette photo n’a reçu aucune correction.' : `Cette photo n’a reçu que des corrections d’ensemble : ${list}.`,
    'Aucune retouche locale : rien n’a été effacé, caché ni ajouté par endroit.',
    'L’original est gardé, tel qu’il a été pris.',
    'Les corrections ont été faites sur le téléphone de l’agent.',
  ].join(' ');
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
    input: { resultRef: unknown; resultSha256: unknown; originalRef: unknown; originalSha256: unknown; operations: unknown; processedOn: unknown },
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
    const originalPattern = new RegExp(`^biens/${propertyId.replace(/[^0-9A-Za-z_-]/g, '\\$&')}/originaux/${UUID}\\.(?:jpg|png|webp|heic|dng)$`);
    if (typeof input.originalRef !== 'string' || !originalPattern.test(input.originalRef)) return bad('R130', 'sans_original');
    if (typeof input.originalSha256 !== 'string' || !SHA.test(input.originalSha256)) return bad('R130', 'sans_original');
    if (typeof input.resultSha256 !== 'string' || !SHA.test(input.resultSha256)) return bad('R10', 'empreinte_invalide');
    const media = await this.photoOf(propertyId, input.resultRef);
    if (!media) return bad('R10', 'photo_inconnue');
    // Aucune correction ni aménagement : l'image publiée est l'original, à l'octet près. Sinon : elle en diffère.
    const unchanged = ops.value.length === 0 && media.edit !== 'amenagement_virtuel';
    if (unchanged !== (input.resultSha256 === input.originalSha256)) return bad('R10', 'empreinte_incoherente');
    // La fiche dit « aucune retouche » : une photo corrigée la contredirait.
    if (media.edit === 'aucune' && ops.value.length > 0) return bad('R10', 'fiche_dit_aucune');
    const existing = await this.db.first<CertRow>('SELECT * FROM photo_certificates WHERE property_id = ? AND result_ref = ?', [propertyId, media.ref]);
    if (existing) {
      const same = existing.result_sha256 === input.resultSha256 && existing.original_sha256 === input.originalSha256 && existing.operations === JSON.stringify(ops.value);
      return same ? { ok: true, value: this.view(existing) } : bad('R10', 'deja_certifiee');
    }
    const token = this.newToken();
    if (!TOKEN.test(token)) throw new Error('Jeton de certificat invalide');
    const row: CertRow = {
      token,
      property_id: propertyId,
      result_ref: media.ref,
      result_sha256: input.resultSha256,
      original_sha256: input.originalSha256,
      operations: JSON.stringify(ops.value),
      virtual_staging: media.edit === 'amenagement_virtuel' ? 1 : 0,
      recorded_at: this.now().toISOString(),
    };
    const { changes } = await this.db.run(
      `INSERT INTO photo_certificates (id, token, property_id, network_id, result_ref, result_sha256, original_ref, original_sha256, operations, virtual_staging, processed_on, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'appareil', ?, ?) ON CONFLICT DO NOTHING`,
      [this.newId(), row.token, propertyId, seen.value.network_id, row.result_ref, row.result_sha256, input.originalRef, row.original_sha256, row.operations, row.virtual_staging, actor, row.recorded_at],
    );
    if (changes !== 1) {
      // Rangé en même temps par un autre geste : on relit ce qui est rangé.
      const now = await this.db.first<CertRow>('SELECT * FROM photo_certificates WHERE property_id = ? AND result_ref = ?', [propertyId, media.ref]);
      if (now && now.result_sha256 === row.result_sha256 && now.original_sha256 === row.original_sha256 && now.operations === row.operations) return { ok: true, value: this.view(now) };
      return bad('R10', 'deja_certifiee');
    }
    await appendEvent(this.journal, { type: 'studio.photo.certifiee', actor, subject: `property:${propertyId}`, data: { operations: ops.value.map((o) => o.op) } }, this.now);
    return { ok: true, value: this.view(row) };
  }

  /** Le certificat, lu par n'importe qui avec son lien : rien qui situe le bien ni qui nomme quelqu'un. */
  async certificate(token: unknown): Promise<PhotoCertificate | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const row = await this.db.first<CertRow>('SELECT * FROM photo_certificates WHERE token = ?', [token]);
    return row ? this.view(row) : null;
  }

  /**
   * Les photos du bien que le Studio peut publier : celles de la dernière version de la fiche qui ont leur certificat,
   * avec la mention d'aménagement virtuel quand il y en a une [R130, R48]. Une photo sans certificat n'y est pas.
   */
  async publishable(propertyId: string): Promise<CertifiedPhoto[]> {
    const media = await this.sheetPhotos(propertyId);
    const rows = await this.db.all<CertRow>('SELECT * FROM photo_certificates WHERE property_id = ?', [propertyId]);
    const byRef = new Map(rows.map((r) => [r.result_ref, r]));
    const out: CertifiedPhoto[] = [];
    for (const m of media) {
      const c = byRef.get(m.ref);
      if (!c) continue;
      // La fiche dit désormais « aménagement virtuel » d'une photo certifiée sans : le certificat ne dit plus vrai,
      // la photo ne part pas tant qu'une nouvelle photo n'a pas son certificat [R130, R48]. L'inverse garde la mention.
      if (m.edit === 'amenagement_virtuel' && c.virtual_staging !== 1) continue;
      out.push({ ref: m.ref, overlay: c.virtual_staging === 1 ? 'Aménagement virtuel' : null, certificateToken: c.token, certificatePath: CERTIFICATE_PATH + c.token });
    }
    return out;
  }

  /** Une photo peut-elle partir ? Seulement de la fiche et avec son certificat [R130]. */
  async checkPublishable(propertyId: string, ref: unknown): Promise<{ ok: true; value: CertifiedPhoto } | { ok: false; rule: 'R130' | 'R10'; code: 'sans_certificat' | 'photo_inconnue' }> {
    if (!(await this.photoOf(propertyId, ref))) return { ok: false, rule: 'R10', code: 'photo_inconnue' };
    const found = (await this.publishable(propertyId)).find((p) => p.ref === ref);
    return found ? { ok: true, value: found } : { ok: false, rule: 'R130', code: 'sans_certificat' };
  }

  private view(row: CertRow): PhotoCertificate {
    const ops = JSON.parse(row.operations) as PhotoOperation[];
    const staged = row.virtual_staging === 1;
    return {
      token: row.token,
      issuedOn: row.recorded_at.slice(0, 10),
      resultSha256: row.result_sha256,
      originalSha256: row.original_sha256,
      originalKept: true,
      localEdits: staged ? 'amenagement_virtuel' : 'aucune',
      corrections: ops.map((o) => ({ op: o.op, label: OPERATION_LABELS[o.op], detail: describeOperation(o) })),
      virtualStaging: staged,
      mention: staged ? 'Aménagement virtuel' : null,
      statement: statementOf(ops, staged),
      path: CERTIFICATE_PATH + row.token,
    };
  }

  private async sheetPhotos(propertyId: string): Promise<{ ref: string; edit: string }[]> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    if (!row) return [];
    let media: SheetMedia[] = [];
    try {
      const data = JSON.parse(row.data) as { media?: unknown };
      media = Array.isArray(data.media) ? (data.media as SheetMedia[]) : [];
    } catch {
      return [];
    }
    return media.filter((m) => isRecord(m) && m.kind === 'photo' && typeof m.ref === 'string' && typeof m.edit === 'string').map((m) => ({ ref: m.ref as string, edit: m.edit as string }));
  }

  private async photoOf(propertyId: string, ref: unknown): Promise<{ ref: string; edit: string } | null> {
    if (typeof ref !== 'string') return null;
    return (await this.sheetPhotos(propertyId)).find((m) => m.ref === ref) ?? null;
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
