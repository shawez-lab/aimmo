/**
 * Dépôt d'une offre signée ou d'une preuve depuis le téléphone (O10) [R16, R13, R57].
 *
 * Le registre et les réponses attendent une référence de stockage, que personne ne saurait saisir. L'agent du bien
 * dépose le fichier : le serveur le range tel quel et rend la référence. Déposer ne joint rien : l'enregistrement de
 * l'offre et la réponse du vendeur gardent leurs contrôles. Mêmes contrôles qu'en W14 : droits avant de lire un octet,
 * type admis et confirmé par les premiers octets, empreinte recalculée. Au journal : ni contenu, ni donnée personnelle.
 */
import type { Viewer } from '../acces/droits.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { matchesType, sha256Hex, type RentalUploadStore } from '../location/depot.ts';
import type { RegistreOffres } from './registre-offres.ts';

export const OFFER_DEPOSIT_KINDS = ['signee', 'preuve'] as const;
export type OfferDepositKind = (typeof OFFER_DEPOSIT_KINDS)[number];
export const OFFER_DEPOSIT_MAX_BYTES = 20 * 1024 * 1024;

const PIECES: Readonly<Record<string, string>> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
/** Une réponse dite à l'oral se prouve aussi par une note écrite ; l'offre signée, jamais. */
export const OFFER_DEPOSIT_TYPES: Record<OfferDepositKind, Readonly<Record<string, string>>> = { signee: PIECES, preuve: { ...PIECES, 'text/plain': 'txt' } };
const FOLDER: Record<OfferDepositKind, string> = { signee: 'offres/', preuve: 'preuves/' };
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OfferDepositInput {
  kind: unknown;
  contentType: unknown;
  sha256: unknown;
  declaredSize: number | null;
  read: (max: number) => Promise<Uint8Array | null>;
}

export type OfferDepositResult =
  | { ok: true; value: { kind: OfferDepositKind; ref: string; sha256: string; size: number } }
  | { ok: false; rule: string | null; code: string };

export class DepotsOffres {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly registre: Pick<RegistreOffres, 'gate'>,
    private readonly store: RentalUploadStore,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async deposit(viewer: Viewer, propertyId: string, input: OfferDepositInput): Promise<OfferDepositResult> {
    // Les droits d'abord, avant de lire un seul octet du fichier [R16].
    const gate = await this.registre.gate(viewer, propertyId);
    if (!gate.ok) return gate;
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const subject = `property:${propertyId}`;
    const bad = async (code: string): Promise<OfferDepositResult> => {
      await appendEvent(this.journal, { type: 'offre.depot.refuse', actor, subject, data: { code } }, this.now);
      return { ok: false, rule: null, code };
    };
    if (!(OFFER_DEPOSIT_KINDS as readonly unknown[]).includes(input.kind)) return bad('sorte_inconnue');
    const kind = input.kind as OfferDepositKind;
    const type = typeof input.contentType === 'string' ? input.contentType.split(';')[0]!.trim().toLowerCase() : '';
    const ext = Object.prototype.hasOwnProperty.call(OFFER_DEPOSIT_TYPES[kind], type) ? OFFER_DEPOSIT_TYPES[kind][type] : undefined;
    if (!ext) return bad('type_refuse');
    if (typeof input.sha256 !== 'string' || !SHA.test(input.sha256)) return bad('empreinte_absente');
    if (input.declaredSize !== null && (!Number.isSafeInteger(input.declaredSize) || input.declaredSize > OFFER_DEPOSIT_MAX_BYTES)) return bad('trop_lourd');
    const bytes = await input.read(OFFER_DEPOSIT_MAX_BYTES);
    if (bytes === null) return bad('trop_lourd');
    if (bytes.length === 0) return bad('fichier_vide');
    if (!matchesType(type, bytes)) return bad('type_refuse');
    const sha = await sha256Hex(bytes);
    if (sha !== input.sha256) return bad('empreinte_differente');
    const id = this.newId();
    if (!UUID.test(id)) throw new Error('identifiant de fichier invalide');
    const ref = `${FOLDER[kind]}${id}.${ext}`;
    try {
      await this.store.put(ref, bytes, type);
    } catch {
      return bad('stockage_indisponible');
    }
    await appendEvent(this.journal, { type: 'offre.depot', actor, subject, data: { kind, ref, size: bytes.length, sha256: sha } }, this.now);
    return { ok: true, value: { kind, ref, sha256: sha, size: bytes.length } };
  }
}
