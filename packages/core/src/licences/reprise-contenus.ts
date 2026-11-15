/**
 * Le contenu des fichiers déposés de l'agence sous licence, remis avec l'empreinte de chacun (RC45 ; Feuille de route,
 * phase 5, « licence du logiciel aux agences hors réseau » ; Offre aux agents, « Licence du logiciel ») [R666, R659,
 * R661, R657, R663, R601, R16, R13].
 *
 * Décidé, lecture prudente :
 *   - le fichier de reprise (HX74, HX75) dit chaque fichier déposé, sans son contenu. La direction de l'agence, et elle
 *     seule, en reçoit ici les octets, par lots, sur la preuve d'un second facteur pour chaque lot [R601] ;
 *   - seul un fichier de reprise qu'AIMMO a remis à cette agence, intact, dont la liste concorde avec ses lignes, ouvre
 *     le stockage : une référence glissée dans un fichier changé n'est jamais lue, pas même cherchée [R659, R661] ;
 *   - chaque pièce est remise avec son empreinte SHA-256 et sa taille, recalculées sur les octets lus à cet instant ; le
 *     lot porte un manifeste (sans contenu) dont l'empreinte va au journal : l'agence peut prouver plus tard que ce
 *     qu'elle tient est ce qu'AIMMO lui a remis ;
 *   - une référence masquée dans le fichier n'est pas lue (« masquée ») ; une pièce que le stockage n'a pas, un stockage
 *     en panne, ou une référence du coffre de la conformité (jamais lue ici) : « absente », sans dire laquelle des trois
 *     [R663] ; une pièce plus grosse que le plafond d'un lot : « trop grosse », jamais coupée ;
 *   - au journal : l'empreinte du fichier, celle du manifeste et des comptes ; jamais une référence ni un contenu [R13].
 *
 * Jamais vu : l'agence qui quitte le logiciel repart avec chacune de ses pièces et la preuve, pièce par pièce, que c'est
 * bien celle qu'AIMMO gardait, et personne ne peut s'en servir pour lire un fichier qui n'est pas à elle.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { fingerprintOf, type SecondFactorGate } from '../rapports/export-agent.ts';
import type { SorteReference } from './carte-fichiers.ts';
import { REPRISE_LIEN_MASQUE, REPRISE_MASQUE, RepriseDonneesAgence, type FichierRepris } from './reprise.ts';

/** Le stockage des fichiers déposés : les octets d'une référence, ou `null` s'il ne l'a pas. */
export interface StockageFichiers {
  read(ref: string): Promise<Uint8Array | null>;
}

/** Les clés du coffre de la conformité (`R2VaultStorage`, `coffre/<réseau>/<id>`) : jamais lues ici [R663]. */
export const PREFIXE_COFFRE = 'coffre/';

/** Au plus, par lot : la somme des tailles remises, et le nombre de pièces. */
export const LOT_OCTETS_MAX = 32 * 1024 * 1024;
export const LOT_PIECES_MAX = 100;

export type StatutPiece = 'remise' | 'absente' | 'masquee' | 'trop_grosse';

/** Une pièce du lot, à sa place dans la liste `fichiers` du fichier de reprise [R666]. */
export interface PieceReprise {
  /** Sa place dans la liste `fichiers`. */
  index: number;
  table: string;
  colonne: string;
  ligne: Record<string, string | number | null>;
  sorte: SorteReference;
  ref: string;
  statut: StatutPiece;
  /** Pour une pièce remise : l'empreinte et la taille des octets lus, et ces octets. */
  sha256: string | null;
  taille: number | null;
  contenu: Uint8Array | null;
}

export interface LotReprise {
  /** L'empreinte du fichier de reprise dont les pièces sont remises. */
  fingerprint: string;
  depuis: number;
  pieces: PieceReprise[];
  /** La place de la prochaine pièce à demander, ou `null` quand la liste est finie. */
  suite: number | null;
  /** L'empreinte du manifeste du lot : les pièces sans leur contenu. */
  manifeste: string;
}

export type ContenusRefusal = { ok: false; rule: 'R16' | 'R601' | 'R657' | 'R659'; code: string };

/** Le manifeste d'un lot : chaque pièce sans son contenu, dans l'ordre du lot [R666]. */
export function manifesteDe(fingerprint: string, pieces: readonly PieceReprise[]): unknown {
  return { fingerprint, pieces: pieces.map(({ contenu: _c, ...rest }) => rest) };
}

async function sha256Hex(content: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const masked = (ref: string) => ref === REPRISE_MASQUE || ref.includes(REPRISE_LIEN_MASQUE);

export class ContenusRepriseAgence {
  private readonly now: () => Date;
  private readonly reprise: RepriseDonneesAgence;
  private readonly maxBytes: number;
  private readonly maxPieces: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly secondFactor: SecondFactorGate,
    private readonly storage: StockageFichiers,
    options: { now?: () => Date; maxBytes?: number; maxPieces?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.reprise = new RepriseDonneesAgence(db, journal, secondFactor, { now: this.now });
    this.maxBytes = options.maxBytes ?? LOT_OCTETS_MAX;
    this.maxPieces = options.maxPieces ?? LOT_PIECES_MAX;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, rule: ContenusRefusal['rule'], code: string): Promise<ContenusRefusal> {
    const type = rule === 'R16' ? 'acces.refuse' : 'licences.refuse';
    await appendEvent(
      this.journal,
      { type, actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule, kind: 'licence_reprise_contenus', role: String(viewer.role), code } },
      this.now,
    );
    return { ok: false, rule, code };
  }

  /**
   * Remet un lot des pièces citées par un fichier de reprise, à partir de la place `depuis` de sa liste `fichiers`
   * [R666]. Rien n'est lu au stockage avant que le fichier soit reconnu et la preuve du second facteur donnée.
   */
  async remettre(viewer: Viewer, document: unknown, stepUpId?: unknown, depuis: unknown = 0): Promise<{ ok: true; value: LotReprise } | ContenusRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    const licence = await this.db.first<{ id: string }>('SELECT id FROM software_licences WHERE licensee_network_id = ?', [viewer.networkId]);
    if (licence === null) return this.refuse(viewer, 'R657', 'pas_de_licence');
    // Seul un fichier remis par AIMMO à cette agence, intact et dont la liste concorde, ouvre le stockage [R659, R661].
    const check = await this.reprise.verify(document);
    const d = (document ?? {}) as { licenceId?: unknown; networkId?: unknown; fichiers?: unknown };
    if (!check.verified || !check.filesComplete || check.fingerprint === null || d.licenceId !== licence.id || d.networkId !== viewer.networkId || !Array.isArray(d.fichiers)) {
      return this.refuse(viewer, 'R659', 'fichier_non_verifie');
    }
    const fichiers = d.fichiers as FichierRepris[];
    if (typeof depuis !== 'number' || !Number.isInteger(depuis) || depuis < 0 || depuis > fichiers.length) return this.refuse(viewer, 'R659', 'bad_input');
    // La preuve, avant toute lecture du stockage ; la porte écrit son refus au journal [R601].
    const proof = await this.secondFactor.requireSecondFactor(viewer, 'export_complet', `licence:${licence.id}`, stepUpId);
    if (!proof.ok) return { ok: false, rule: 'R601', code: proof.code };

    const pieces: PieceReprise[] = [];
    // Une même référence citée par plusieurs lignes n'est lue qu'une fois dans le lot.
    // Ce qui est gardé : une copie à soi des octets lus (le stockage peut réutiliser son tampon), ou la seule taille d'une
    // pièce trop grosse, jamais ses octets.
    const read = new Map<string, { content: Uint8Array } | { size: number } | null>();
    let bytes = 0;
    let suite: number | null = null;
    for (let i = depuis; i < fichiers.length; i++) {
      if (pieces.length >= this.maxPieces) {
        suite = i;
        break;
      }
      const f = fichiers[i]!;
      const base = { index: i, table: f.table, colonne: f.colonne, ligne: f.ligne, sorte: f.sorte, ref: f.ref };
      const none = { sha256: null, taille: null, contenu: null };
      if (masked(f.ref)) {
        pieces.push({ ...base, statut: 'masquee', ...none });
        continue;
      }
      let got: { content: Uint8Array } | { size: number } | null;
      if (f.ref.startsWith(PREFIXE_COFFRE)) got = null;
      else if (read.has(f.ref)) got = read.get(f.ref)!;
      else {
        let raw: unknown;
        try {
          raw = await this.storage.read(f.ref);
        } catch {
          raw = null;
        }
        got = !(raw instanceof Uint8Array) ? null : raw.byteLength > this.maxBytes ? { size: raw.byteLength } : { content: raw.slice() };
        read.set(f.ref, got);
      }
      if (got === null) {
        pieces.push({ ...base, statut: 'absente', ...none });
        continue;
      }
      if ('size' in got) {
        pieces.push({ ...base, statut: 'trop_grosse', sha256: null, taille: got.size, contenu: null });
        continue;
      }
      const size = got.content.byteLength;
      // Le lot s'arrête avant la pièce qui le ferait déborder ; elle ouvrira le lot suivant.
      if (bytes + size > this.maxBytes) {
        suite = i;
        break;
      }
      bytes += size;
      // Une copie par pièce : changer les octets d'une pièce remise ne change ni une autre ni ce qui est gardé.
      const own = got.content.slice();
      pieces.push({ ...base, statut: 'remise', sha256: await sha256Hex(own), taille: size, contenu: own });
    }
    const manifeste = await fingerprintOf(manifesteDe(check.fingerprint, pieces));
    const count = (s: StatutPiece) => pieces.filter((p) => p.statut === s).length;
    // Au journal : les empreintes et des comptes, jamais une référence ni un contenu [R13].
    await appendEvent(
      this.journal,
      {
        type: 'licences.reprise.contenus',
        actor: this.actor(viewer),
        subject: `licence:${licence.id}`,
        data: { rule: 'R666', fingerprint: check.fingerprint, manifeste, depuis, suite, remises: count('remise'), absentes: count('absente'), masquees: count('masquee'), tropGrosses: count('trop_grosse'), octets: bytes },
      },
      this.now,
    );
    return { ok: true, value: { fingerprint: check.fingerprint, depuis, pieces, suite, manifeste } };
  }
}

/** Dit si des octets sont ceux d'une pièce remise : même taille, même empreinte [R666]. */
export async function pieceIntacte(piece: Pick<PieceReprise, 'statut' | 'sha256' | 'taille'>, content: Uint8Array): Promise<boolean> {
  return piece.statut === 'remise' && piece.taille === content.byteLength && piece.sha256 === (await sha256Hex(content));
}

/** L'empreinte d'un manifeste rendu, à comparer à celle du journal [R666]. */
export async function empreinteManifeste(lot: Pick<LotReprise, 'fingerprint' | 'pieces'>): Promise<string> {
  return fingerprintOf(manifesteDe(lot.fingerprint, lot.pieces));
}
