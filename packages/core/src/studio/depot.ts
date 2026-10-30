/**
 * Dépôt des fichiers finis du Studio (M19, X12) [R130, R16].
 *
 * La photo corrigée, son original et la vidéo montée sont faits sur le téléphone de l'agent (X02, X03, X11). Le serveur
 * les range tels quels dans le stockage des médias, sans jamais les décoder, les redimensionner, les recompresser ni les
 * réécrire : les octets reçus sont les octets rangés.
 *
 * Un fichier n'est rangé que si :
 * - qui dépose voit le bien en entier et est son agent ou la direction [R16] ; c'est vérifié avant de lire le fichier ;
 * - sa sorte (photo, original, vidéo), son type et sa taille sont dans les bornes, et ses premiers octets sont ceux de
 *   son type : une page, un script ou un fichier vide ne passent pas ;
 * - son empreinte SHA-256, recalculée sur les octets reçus, est celle que l'appareil a dite [R130] ; sinon rien n'est
 *   rangé.
 *
 * L'original est rangé sous `biens/<bien>/originaux/<identifiant>.<ext>` : il n'entre jamais dans la fiche du bien, et
 * la vitrine ne sert que les fichiers posés directement sous `biens/<bien>/`, donc un original n'est jamais publié. Une
 * photo ou une vidéo est ajoutée à la fiche par une nouvelle version (rien ne s'efface [R17]), écrite seulement si la
 * fiche n'a pas changé entre la lecture et l'écriture ; sinon l'ajout est recalculé sur la nouvelle version.
 *
 * Au journal : la sorte, la taille et la référence de stockage, jamais le contenu ni une donnée personnelle [R13]. Un
 * fichier rangé dont l'ajout à la fiche a échoué reste dans le stockage, sans être effacé, et l'échec est au journal.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { FicheBien, MEDIA_EDITS, parseSheet, type MediaEdit, type PropertySheet } from '../annonces/fiche-bien.ts';

export const DEPOSIT_KINDS = ['photo', 'original', 'video'] as const;
export type DepositKind = (typeof DEPOSIT_KINDS)[number];

const MB = 1024 * 1024;
/** Les tailles admises, en octets : une photo de téléphone, un original brut, une vidéo courte du modèle. */
export const DEPOSIT_MAX_BYTES: Record<DepositKind, number> = { photo: 20 * MB, original: 60 * MB, video: 95 * MB };

/** Les types admis pour chaque sorte, et l'extension de la référence rangée. */
export const DEPOSIT_TYPES: Record<DepositKind, Readonly<Record<string, string>>> = {
  photo: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  original: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/x-adobe-dng': 'dng' },
  video: { 'video/mp4': 'mp4' },
};

/** Le stockage des médias où le fichier est rangé tel quel. */
export interface StudioUploadStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface Deposit {
  propertyId: string;
  kind: DepositKind;
  ref: string;
  sha256: string;
  size: number;
  /** La version de la fiche qui porte la photo ou la vidéo ; null pour un original. */
  sheetVersion: number | null;
}

export type DepositResult = { ok: true; value: Deposit } | { ok: false; rule: 'R16' | 'R130' | 'R10' | null; code: string; [k: string]: unknown };

export interface DepositInput {
  kind: unknown;
  /** La retouche dite par l'appareil, pour une photo : `aucune`, `lumiere_cadrage` ou `amenagement_virtuel`. */
  edit?: unknown;
  contentType: unknown;
  sha256: unknown;
  /** La taille annoncée, contrôlée avant toute lecture ; null quand la requête ne la dit pas. */
  declaredSize: number | null;
  /** Lit le fichier, au plus `max` octets ; null s'il dépasse. Appelé seulement après les contrôles de droits. */
  read: (max: number) => Promise<Uint8Array | null>;
}

const SHA = /^[0-9a-f]{64}$/;
const ATTEMPTS = 5;

const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'hevc', 'hevx']);

/** Les premiers octets du fichier sont-ils ceux de son type ? Rien n'est décodé : seuls quelques octets sont lus. */
export function matchesSignature(contentType: string, b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const ftyp = ascii(b, 4, 8) === 'ftyp';
  const brand = ascii(b, 8, 12);
  switch (contentType) {
    case 'image/jpeg':
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x);
    case 'image/webp':
      return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP';
    case 'image/heic':
      return ftyp && HEIF_BRANDS.has(brand);
    case 'image/x-adobe-dng':
      return ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*';
    case 'video/mp4':
      return ftyp && !HEIF_BRANDS.has(brand);
    default:
      return false;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export interface DepotsStudioOptions {
  now?: () => Date;
  newId?: () => string;
}

export class DepotsStudio {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly fiches: FicheBien;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly store: StudioUploadStore,
    options: DepotsStudioOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.fiches = new FicheBien(db, acces, journal, { now: this.now });
  }

  /** Range un fichier fini, tel quel, puis l'ajoute à la fiche s'il est une photo ou une vidéo. */
  async deposit(viewer: Viewer, propertyId: string, input: DepositInput): Promise<DepositResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    // Les droits d'abord, avant de lire un seul octet du fichier [R16].
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : { ok: false, rule: 'R16', code: p.code };
    if (p.view !== 'full' || (viewer.role !== 'agent' && viewer.role !== 'direction')) {
      const code = p.view !== 'full' ? 'not_assigned' : 'role';
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'studio_depot', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    }
    const bad = async (rule: 'R130' | 'R10' | null, code: string): Promise<DepositResult> => {
      await appendEvent(this.journal, { type: 'studio.depot.refuse', actor, subject: `property:${propertyId}`, data: { rule, code } }, this.now);
      return { ok: false, rule, code };
    };
    if (!(DEPOSIT_KINDS as readonly unknown[]).includes(input.kind)) return bad(null, 'sorte_inconnue');
    const kind = input.kind as DepositKind;
    let edit: MediaEdit = 'aucune';
    if (kind === 'photo') {
      if (!(MEDIA_EDITS as readonly unknown[]).includes(input.edit)) return bad('R10', 'retouche_inconnue');
      edit = input.edit as MediaEdit;
    } else if (input.edit !== undefined && input.edit !== null && input.edit !== 'aucune') return bad('R10', 'retouche_inconnue');
    const type = typeof input.contentType === 'string' ? input.contentType.split(';')[0]!.trim().toLowerCase() : '';
    const ext = DEPOSIT_TYPES[kind][type];
    if (!ext) return bad(null, 'type_refuse');
    if (typeof input.sha256 !== 'string' || !SHA.test(input.sha256)) return bad('R130', 'empreinte_absente');
    const max = DEPOSIT_MAX_BYTES[kind];
    if (input.declaredSize !== null && (!Number.isSafeInteger(input.declaredSize) || input.declaredSize > max)) return bad(null, 'trop_lourd');
    // Une photo ou une vidéo entre dans la fiche : sans fiche, rien n'est rangé.
    if (kind !== 'original' && !(await this.latest(propertyId))) return bad('R10', 'fiche_absente');
    const bytes = await input.read(max);
    if (bytes === null) return bad(null, 'trop_lourd');
    if (bytes.length === 0) return bad(null, 'fichier_vide');
    if (!matchesSignature(type, bytes)) return bad(null, 'type_refuse');
    // L'empreinte des octets reçus doit être celle dite par l'appareil : sinon le fichier n'est pas celui qui a été
    // fait sur le téléphone, et rien n'est rangé [R130].
    const sha = await sha256Hex(bytes);
    if (sha !== input.sha256) return bad('R130', 'empreinte_differente');
    const id = this.newId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('identifiant de fichier invalide');
    const ref = kind === 'original' ? `biens/${propertyId}/originaux/${id}.${ext}` : `biens/${propertyId}/${id}.${ext}`;
    // Une photo ou une vidéo de plus doit tenir dans la fiche avant d'être rangée.
    if (kind !== 'original') {
      const first = await this.latest(propertyId);
      const fits = first ? this.withMedia(first.sheet, { ref, kind: kind === 'photo' ? 'photo' : 'video', edit }) : null;
      if (!fits) return bad('R10', 'fiche_absente');
      // La fiche avec ce fichier doit être une fiche valide : sinon rien n'est rangé, pas même le fichier.
      const parsed = parseSheet(fits, this.now(), propertyId);
      if (!parsed.ok) return bad('R10', parsed.field === 'media' ? 'fiche_pleine' : 'fiche_refusee');
    }
    try {
      await this.store.put(ref, bytes, type);
    } catch {
      return bad('R130', 'stockage_indisponible');
    }
    await appendEvent(this.journal, { type: 'studio.depot', actor, subject: `property:${propertyId}`, data: { rule: 'R130', kind, ref, size: bytes.length, sha256: sha } }, this.now);
    if (kind === 'original') return { ok: true, value: { propertyId, kind, ref, sha256: sha, size: bytes.length, sheetVersion: null } };
    const added = await this.addToSheet(viewer, propertyId, { ref, kind: kind === 'photo' ? 'photo' : 'video', edit });
    if (!added.ok) {
      // Le fichier reste rangé, sans être effacé ; l'agent peut le déposer de nouveau.
      await appendEvent(this.journal, { type: 'studio.depot.hors_fiche', actor, subject: `property:${propertyId}`, data: { rule: 'R17', ref, code: added.code } }, this.now);
      return { ok: false, rule: 'R10', code: added.code === 'busy' ? 'fiche_occupee' : 'fiche_refusee' };
    }
    return { ok: true, value: { propertyId, kind, ref, sha256: sha, size: bytes.length, sheetVersion: added.version } };
  }

  private async latest(propertyId: string): Promise<{ version: number; sheet: PropertySheet } | null> {
    const row = await this.db.first<{ version: number; data: string }>('SELECT version, data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    return row ? { version: row.version, sheet: JSON.parse(row.data) as PropertySheet } : null;
  }

  private withMedia(sheet: PropertySheet, media: PropertySheet['media'][number]): PropertySheet {
    return { ...sheet, media: [...(sheet.media ?? []), media] };
  }

  /** Une nouvelle version de la fiche, écrite seulement sur la version lue ; recalculée si elle a changé entre-temps. */
  private async addToSheet(viewer: Viewer, propertyId: string, media: PropertySheet['media'][number]): Promise<{ ok: true; version: number } | { ok: false; code: string }> {
    for (let i = 0; i < ATTEMPTS; i++) {
      const cur = await this.latest(propertyId);
      if (!cur) return { ok: false, code: 'no_sheet' };
      const saved = await this.fiches.save(viewer, propertyId, this.withMedia(cur.sheet, media), { ifVersion: cur.version });
      if (saved.ok) return { ok: true, version: saved.value.version };
      if (saved.code !== 'stale' && saved.code !== 'busy') return { ok: false, code: saved.code };
    }
    return { ok: false, code: 'busy' };
  }
}
