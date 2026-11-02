/**
 * Dépôt d'une pièce du dossier de vente depuis le téléphone (N12) [R15, R16, R13].
 *
 * `PiecesDossier.add` attend une référence de stockage, que personne ne saurait saisir. L'agent du bien dépose le
 * fichier, le serveur le range tel quel sous `dossiers/<dossier>/` et rend la référence. Déposer ne joint rien : la
 * pièce, sa date et ses contrôles passent ensuite par `add`. Mêmes contrôles qu'en W14 : droits avant de lire un octet,
 * type admis et confirmé par les premiers octets, empreinte recalculée. Au journal : ni contenu, ni donnée personnelle.
 *
 * N13 : la preuve d'une date ou de l'acte se dépose de même et se range sous `preuves/`, la forme que ces saisies attendent.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { matchesType, sha256Hex } from '../location/depot.ts';
import { actorOf, gateSaleFile } from './acces-dossier.ts';

export const FILE_DEPOSIT_MAX_BYTES = 20 * 1024 * 1024;
/** Les seuls types qu'une pièce du dossier accepte, ceux de sa référence. */
export const FILE_DEPOSIT_TYPES: Readonly<Record<string, string>> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type FileDepositKind = 'piece' | 'preuve';

export interface FileDepositInput {
  /** `piece` par défaut : une pièce du dossier ; `preuve` : la preuve d'une date ou de l'acte (N13). */
  kind?: FileDepositKind;
  contentType: unknown;
  sha256: unknown;
  declaredSize: number | null;
  read: (max: number) => Promise<Uint8Array | null>;
}

export type FileDepositResult = { ok: true; value: { ref: string; sha256: string; size: number } } | { ok: false; rule: string | null; code: string };

/** Les contrôles d'un fichier reçu, communs aux dépôts : type admis et confirmé par les premiers octets, poids, empreinte recalculée. */
export async function checkDepositedFile(input: Pick<FileDepositInput, 'contentType' | 'sha256' | 'declaredSize' | 'read'>): Promise<{ ok: true; type: string; ext: string; bytes: Uint8Array; sha: string } | { ok: false; code: string }> {
  const type = typeof input.contentType === 'string' ? input.contentType.split(';')[0]!.trim().toLowerCase() : '';
  const ext = Object.prototype.hasOwnProperty.call(FILE_DEPOSIT_TYPES, type) ? FILE_DEPOSIT_TYPES[type] : undefined;
  if (!ext) return { ok: false, code: 'type_refuse' };
  if (typeof input.sha256 !== 'string' || !SHA.test(input.sha256)) return { ok: false, code: 'empreinte_absente' };
  if (input.declaredSize !== null && (!Number.isSafeInteger(input.declaredSize) || input.declaredSize > FILE_DEPOSIT_MAX_BYTES)) return { ok: false, code: 'trop_lourd' };
  const bytes = await input.read(FILE_DEPOSIT_MAX_BYTES);
  if (bytes === null) return { ok: false, code: 'trop_lourd' };
  if (bytes.length === 0) return { ok: false, code: 'fichier_vide' };
  if (!matchesType(type, bytes)) return { ok: false, code: 'type_refuse' };
  const sha = await sha256Hex(bytes);
  if (sha !== input.sha256) return { ok: false, code: 'empreinte_differente' };
  return { ok: true, type, ext, bytes, sha };
}

export class DepotsDossier {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly store: { put(key: string, bytes: Uint8Array, contentType: string): Promise<void> },
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async deposit(viewer: Viewer, fileId: string, input: FileDepositInput): Promise<FileDepositResult> {
    // Les droits d'abord, avant de lire un seul octet du fichier : seul l'agent du bien écrit [R16].
    const gate = await gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, true, 'sale_file_pieces');
    if (!gate.ok) return gate;
    // Un dossier clos par l'acte ne reçoit plus de pièce : aucun fichier rangé qui ne serait rattaché à rien.
    // La preuve de l'acte reste admise tant que la commission manque : une clôture coupée doit pouvoir se reprendre.
    const closedBy = input.kind === 'preuve' ? 'sale_commissions' : 'sale_file_closings';
    if (await this.db.first(`SELECT 1 FROM ${closedBy} WHERE file_id = ?`, [fileId])) return { ok: false, rule: null, code: 'closed' };
    const actor = actorOf(viewer);
    const subject = `sale_file:${fileId}`;
    const bad = async (code: string): Promise<FileDepositResult> => {
      await appendEvent(this.journal, { type: 'dossier.depot.refuse', actor, subject, data: { code } }, this.now);
      return { ok: false, rule: null, code };
    };
    const file = await checkDepositedFile(input);
    if (!file.ok) return bad(file.code);
    const { type, ext, bytes, sha } = file;
    const id = this.newId();
    if (!UUID.test(id)) throw new Error('identifiant de fichier invalide');
    const ref = input.kind === 'preuve' ? `preuves/${id}.${ext}` : `dossiers/${fileId}/${id}.${ext}`;
    try {
      await this.store.put(ref, bytes, type);
    } catch {
      return bad('stockage_indisponible');
    }
    await appendEvent(this.journal, { type: 'dossier.depot', actor, subject, data: { ref, size: bytes.length, sha256: sha } }, this.now);
    return { ok: true, value: { ref, sha256: sha, size: bytes.length } };
  }
}
