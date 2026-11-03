/**
 * Dépôt des pièces d'une mise en location depuis le téléphone (W14) [R16, R13].
 *
 * L'annexe d'un logement, la preuve du choix du propriétaire et la notice d'information du bail se rangeaient par une
 * référence saisie à la main. L'agent dépose maintenant le fichier : le serveur le range tel quel, sous la référence
 * que les gestes de M15 attendent déjà, et rend cette référence. Ces gestes gardent leurs propres contrôles : déposer ne
 * joint rien.
 *
 * Un fichier n'est rangé que si :
 * - qui dépose peut écrire sur ce logement [R16] ; c'est vérifié avant de lire le fichier ;
 * - son type est admis pour sa sorte, sa taille tient, et ses premiers octets sont ceux de son type : une page, un
 *   script ou un fichier vide ne passent pas ;
 * - son empreinte SHA-256, recalculée sur les octets reçus, est celle que l'appareil a dite.
 *
 * Au journal : la sorte, la taille, l'empreinte et la référence, jamais le contenu ni une donnée personnelle [R13].
 * Une pièce d'une candidature (W18) se dépose de même, avant son geste de rangement, qui contrôle sa sorte [R104].
 * Aucune route ne relit ces fichiers depuis l'écran. Rien n'est effacé : un fichier déposé puis jamais joint reste rangé.
 * Une pièce de candidature a sa ligne de dépôt (W19), écrite avant le fichier, pour que l'accès et l'effacement la voient
 * même si le geste la refuse ensuite ou si sa réponse se perd [R95, R97].
 */
import type { Viewer } from '../acces/droits.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { matchesSignature } from '../studio/depot.ts';
import type { LocationRefusal, MisesEnLocation } from './logement.ts';

export const RENTAL_DEPOSIT_KINDS = ['annexe', 'preuve', 'notice', 'piece'] as const;
export type RentalDepositKind = (typeof RENTAL_DEPOSIT_KINDS)[number];

/** 20 Mo : un diagnostic en PDF ou la photo d'un document prise au téléphone. */
export const RENTAL_DEPOSIT_MAX_BYTES = 20 * 1024 * 1024;

const PIECE_TYPES: Readonly<Record<string, string>> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
/** Les types admis pour chaque sorte, et l'extension de la référence, celles que les gestes de M15 acceptent. */
export const RENTAL_DEPOSIT_TYPES: Record<RentalDepositKind, Readonly<Record<string, string>>> = {
  annexe: PIECE_TYPES,
  // Un choix dit à l'oral se prouve aussi par une note écrite.
  preuve: { ...PIECE_TYPES, 'text/plain': 'txt' },
  notice: { 'application/pdf': 'pdf' },
  // Une pièce d'une candidature (W18), rangée dans le dossier de cette candidature.
  piece: PIECE_TYPES,
};

const FOLDER: Record<Exclude<RentalDepositKind, 'piece'>, string> = { annexe: '', preuve: 'choix/', notice: 'bail/' };
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Le stockage où le fichier est rangé tel quel. */
export interface RentalUploadStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** Une pièce de candidature à déposer : son dossier, et à qui elle est, déjà contrôlés par `Candidatures.placeOf`. */
export interface PieceDepositPlace {
  applicationId: string;
  holder: string;
  personId: string;
}

export interface PieceDepositRow extends PieceDepositPlace {
  id: string;
  ref: string;
  sha256: string;
  size: number;
  depositedBy: string;
}

/** Le registre des dépôts de pièces (W19). */
export interface PieceDepositLedger {
  recordDeposit(row: PieceDepositRow): Promise<void>;
}

export interface RentalDepositInput {
  kind: unknown;
  contentType: unknown;
  sha256: unknown;
  /** La taille annoncée, contrôlée avant toute lecture ; null quand la requête ne la dit pas. */
  declaredSize: number | null;
  /** Lit le fichier, au plus `max` octets ; null s'il dépasse. Appelé seulement après les contrôles de droits. */
  read: (max: number) => Promise<Uint8Array | null>;
}

export type RentalDepositResult = { ok: true; value: { kind: RentalDepositKind; ref: string; sha256: string; size: number } } | LocationRefusal;

/** Une note : du texte UTF-8 sans octet nul ; un fichier binaire renommé ne passe pas. */
function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function matchesType(type: string, bytes: Uint8Array): boolean {
  if (type === 'text/plain') return isPlainText(bytes);
  if (type === 'application/pdf') return String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
  return matchesSignature(type, bytes);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class DepotsLocation {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly listings: MisesEnLocation,
    private readonly store: RentalUploadStore,
    private readonly journal: JournalStore,
    private readonly ledger: PieceDepositLedger,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * `place`, pour la seule sorte `piece` : la candidature et le titulaire, déjà contrôlés sous les droits de celui qui
   * dépose par `Candidatures.placeOf`. Sans elle une pièce n'a pas de dossier où se ranger.
   */
  async deposit(viewer: Viewer, listingId: unknown, input: RentalDepositInput, place?: PieceDepositPlace): Promise<RentalDepositResult> {
    // Les droits d'abord, avant de lire un seul octet du fichier [R16].
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    // Le journal du logement est au propriétaire ; ce qui touche une pièce est à la candidature [R16].
    const subject = place ? `rental_application:${place.applicationId}` : `rental:${listing.id}`;
    const bad = async (code: string): Promise<RentalDepositResult> => {
      await appendEvent(this.journal, { type: 'location.depot.refuse', actor, subject, data: { code } }, this.now);
      return { ok: false, rule: null, code };
    };
    if (!(RENTAL_DEPOSIT_KINDS as readonly unknown[]).includes(input.kind)) return bad('sorte_inconnue');
    const kind = input.kind as RentalDepositKind;
    if ((kind === 'piece') !== (place !== undefined)) return bad('sorte_inconnue');
    const type = typeof input.contentType === 'string' ? input.contentType.split(';')[0]!.trim().toLowerCase() : '';
    const ext = Object.prototype.hasOwnProperty.call(RENTAL_DEPOSIT_TYPES[kind], type) ? RENTAL_DEPOSIT_TYPES[kind][type] : undefined;
    if (!ext) return bad('type_refuse');
    if (typeof input.sha256 !== 'string' || !SHA.test(input.sha256)) return bad('empreinte_absente');
    if (input.declaredSize !== null && (!Number.isSafeInteger(input.declaredSize) || input.declaredSize > RENTAL_DEPOSIT_MAX_BYTES)) return bad('trop_lourd');
    const bytes = await input.read(RENTAL_DEPOSIT_MAX_BYTES);
    if (bytes === null) return bad('trop_lourd');
    if (bytes.length === 0) return bad('fichier_vide');
    if (!matchesType(type, bytes)) return bad('type_refuse');
    const sha = await sha256Hex(bytes);
    if (sha !== input.sha256) return bad('empreinte_differente');
    const id = this.newId();
    if (!UUID.test(id)) throw new Error('identifiant de fichier invalide');
    const ref = `location/${listing.id}/${kind === 'piece' ? `candidatures/${place!.applicationId}/` : FOLDER[kind]}${id}.${ext}`;
    try {
      // La ligne d'abord : aucun fichier stocké sans elle, même si le serveur s'arrête juste après [R95].
      if (place) await this.ledger.recordDeposit({ ...place, id, ref, sha256: sha, size: bytes.length, depositedBy: actor });
      await this.store.put(ref, bytes, type);
    } catch {
      return bad('stockage_indisponible');
    }
    // La pièce d'un garant ne donne au candidat ni son chemin ni son empreinte, seulement l'identifiant de sa ligne de dépôt.
    const data = place ? { kind, size: bytes.length, deposit: id } : { kind, ref, size: bytes.length, sha256: sha };
    await appendEvent(this.journal, { type: 'location.depot', actor, subject, data }, this.now);
    return { ok: true, value: { kind, ref, sha256: sha, size: bytes.length } };
  }
}
