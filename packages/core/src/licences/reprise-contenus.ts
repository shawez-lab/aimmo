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
import { Sha256Flux } from './sha256-flux.ts';

/** Le stockage des fichiers déposés : les octets d'une référence, ou `null` s'il ne l'a pas. */
export interface StockageFichiers {
  read(ref: string): Promise<Uint8Array | null>;
}

/**
 * Un stockage qui sait dire la taille d'une pièce et en lire une plage (ce que R2 sait faire) : une pièce trop grosse
 * pour un lot se remet alors en tranches, sans jamais être lue entière (RC46) [R667].
 */
export interface StockageFichiersPlages extends StockageFichiers {
  /** La taille d'une référence, ou `null` s'il ne l'a pas. */
  taille(ref: string): Promise<number | null>;
  /** Les octets `[debut, debut + longueur)` d'une référence, ou `null` s'il ne l'a pas. */
  lirePlage(ref: string, debut: number, longueur: number): Promise<Uint8Array | null>;
}

const avecPlages = (s: StockageFichiers): s is StockageFichiersPlages =>
  typeof (s as Partial<StockageFichiersPlages>).taille === 'function' && typeof (s as Partial<StockageFichiersPlages>).lirePlage === 'function';

/** La taille d'une tranche, et celle d'une pièce au plus (RC46) [R667]. */
export const TRANCHE_OCTETS = 8 * 1024 * 1024;
export const PIECE_OCTETS_MAX = 2 * 1024 * 1024 * 1024;

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

export type ContenusRefusal = { ok: false; rule: 'R16' | 'R601' | 'R657' | 'R659' | 'R667'; code: string };

export type StatutPieceEnTranches = 'prete' | 'absente' | 'masquee' | 'trop_grosse';

/** Une tranche dite par l'empreinte d'une pièce : sa place, sa taille et son empreinte [R667]. */
export interface TrancheDite {
  debut: number;
  taille: number;
  sha256: string;
}

/** L'empreinte d'une pièce lue tranche par tranche, sans son contenu (RC46) [R667]. */
export interface EmpreintePiece {
  /** L'empreinte du fichier de reprise. */
  fingerprint: string;
  index: number;
  table: string;
  colonne: string;
  ligne: Record<string, string | number | null>;
  sorte: SorteReference;
  ref: string;
  statut: StatutPieceEnTranches;
  /** Pour une pièce prête : sa taille, son SHA-256 entier, la taille d'une tranche et chaque tranche. */
  taille: number | null;
  sha256: string | null;
  trancheOctets: number;
  tranches: TrancheDite[];
  /** L'empreinte de ce qui précède, au journal. */
  manifeste: string;
}

export type StatutTranche = 'remise' | 'absente' | 'masquee' | 'alteree' | 'trop_grosse';

/** Une tranche remise : ses octets et leur empreinte recalculée à cet instant (RC46) [R667]. */
export interface TrancheReprise {
  fingerprint: string;
  index: number;
  statut: StatutTranche;
  debut: number;
  /** La taille de la pièce lue à cet instant, ou `null`. */
  total: number | null;
  taille: number | null;
  sha256: string | null;
  contenu: Uint8Array | null;
  /** Le début de la tranche suivante, ou `null` à la dernière. */
  suite: number | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

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
  private readonly trancheOctets: number;
  private readonly pieceMax: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly secondFactor: SecondFactorGate,
    private readonly storage: StockageFichiers,
    options: { now?: () => Date; maxBytes?: number; maxPieces?: number; trancheOctets?: number; pieceMax?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.reprise = new RepriseDonneesAgence(db, journal, secondFactor, { now: this.now });
    this.maxBytes = options.maxBytes ?? LOT_OCTETS_MAX;
    this.maxPieces = options.maxPieces ?? LOT_PIECES_MAX;
    this.trancheOctets = options.trancheOctets ?? TRANCHE_OCTETS;
    this.pieceMax = options.pieceMax ?? PIECE_OCTETS_MAX;
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
   * Les portes communes à chaque remise : direction de l'agence sous licence, fichier remis par AIMMO à cette agence,
   * intact et dont la liste concorde [R16, R657, R659, R661]. La preuve du second facteur est demandée à part, après le
   * contrôle des paramètres de l'appel.
   */
  private async ouvrir(viewer: Viewer, document: unknown): Promise<{ ok: true; licenceId: string; fingerprint: string; fichiers: FichierRepris[] } | ContenusRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    const licence = await this.db.first<{ id: string }>('SELECT id FROM software_licences WHERE licensee_network_id = ?', [viewer.networkId]);
    if (licence === null) return this.refuse(viewer, 'R657', 'pas_de_licence');
    // Seul un fichier remis par AIMMO à cette agence, intact et dont la liste concorde, ouvre le stockage [R659, R661].
    const check = await this.reprise.verify(document);
    const d = (document ?? {}) as { licenceId?: unknown; networkId?: unknown; fichiers?: unknown };
    if (!check.verified || !check.filesComplete || check.fingerprint === null || d.licenceId !== licence.id || d.networkId !== viewer.networkId || !Array.isArray(d.fichiers)) {
      return this.refuse(viewer, 'R659', 'fichier_non_verifie');
    }
    return { ok: true, licenceId: licence.id, fingerprint: check.fingerprint, fichiers: d.fichiers as FichierRepris[] };
  }

  /** La taille d'une pièce dite par le stockage, ou `null` (absente, panne, réponse mal formée). */
  private async tailleDe(ref: string): Promise<number | null> {
    if (!avecPlages(this.storage)) return null;
    try {
      const n: unknown = await this.storage.taille(ref);
      return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  /** Une plage lue, seulement si elle a exactement la longueur demandée ; sinon `null`. */
  private async plage(ref: string, debut: number, longueur: number): Promise<Uint8Array | null> {
    if (!avecPlages(this.storage)) return null;
    try {
      const raw: unknown = await this.storage.lirePlage(ref, debut, longueur);
      // Une copie à soi : le stockage peut réutiliser son tampon.
      return raw instanceof Uint8Array && raw.byteLength === longueur ? raw.slice() : null;
    } catch {
      return null;
    }
  }

  /**
   * Remet un lot des pièces citées par un fichier de reprise, à partir de la place `depuis` de sa liste `fichiers`
   * [R666]. Rien n'est lu au stockage avant que le fichier soit reconnu et la preuve du second facteur donnée.
   */
  async remettre(viewer: Viewer, document: unknown, stepUpId?: unknown, depuis: unknown = 0): Promise<{ ok: true; value: LotReprise } | ContenusRefusal> {
    const opened = await this.ouvrir(viewer, document);
    if (!opened.ok) return opened;
    const { fichiers } = opened;
    const licence = { id: opened.licenceId };
    const check = { fingerprint: opened.fingerprint };
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
        // Un stockage qui dit la taille : une pièce plus grosse qu'un lot n'est jamais lue entière (RC46).
        const known = await this.tailleDe(f.ref);
        if (known !== null && known > this.maxBytes) got = { size: known };
        else {
          let raw: unknown;
          try {
            raw = await this.storage.read(f.ref);
          } catch {
            raw = null;
          }
          got = !(raw instanceof Uint8Array) ? null : raw.byteLength > this.maxBytes ? { size: raw.byteLength } : { content: raw.slice() };
        }
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

  /** La pièce à la place `index` de la liste, après les portes ; `null` si la place n'est pas un entier de la liste. */
  private piece(fichiers: FichierRepris[], index: unknown): FichierRepris | null {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= fichiers.length) return null;
    return fichiers[index]!;
  }

  /**
   * L'empreinte d'une pièce lue tranche par tranche, jamais entière en mémoire : sa taille, le SHA-256 de la pièce
   * entière et celui de chaque tranche (RC46) [R667]. Rien n'est remis ici : les tranches se demandent ensuite par
   * `remettreTranche`, chacune vérifiable contre cette liste.
   */
  async empreintePiece(viewer: Viewer, document: unknown, stepUpId: unknown, index: unknown): Promise<{ ok: true; value: EmpreintePiece } | ContenusRefusal> {
    const opened = await this.ouvrir(viewer, document);
    if (!opened.ok) return opened;
    const f = this.piece(opened.fichiers, index);
    if (f === null) return this.refuse(viewer, 'R659', 'bad_input');
    if (!avecPlages(this.storage)) return this.refuse(viewer, 'R667', 'stockage_sans_plages');
    const proof = await this.secondFactor.requireSecondFactor(viewer, 'export_complet', `licence:${opened.licenceId}`, stepUpId);
    if (!proof.ok) return { ok: false, rule: 'R601', code: proof.code };

    const base = { fingerprint: opened.fingerprint, index: index as number, table: f.table, colonne: f.colonne, ligne: f.ligne, sorte: f.sorte, ref: f.ref, trancheOctets: this.trancheOctets };
    const lire = async (): Promise<Pick<EmpreintePiece, 'statut' | 'taille' | 'sha256' | 'tranches'>> => {
      const none = { taille: null, sha256: null, tranches: [] };
      // Une référence masquée n'est pas lue ; une clé du coffre, jamais [R663].
      if (masked(f.ref)) return { statut: 'masquee', ...none };
      if (f.ref.startsWith(PREFIXE_COFFRE)) return { statut: 'absente', ...none };
      const total = await this.tailleDe(f.ref);
      if (total === null) return { statut: 'absente', ...none };
      if (total > this.pieceMax) return { statut: 'trop_grosse', taille: total, sha256: null, tranches: [] };
      const entiere = new Sha256Flux();
      const tranches: TrancheDite[] = [];
      for (let debut = 0; debut < total; debut += this.trancheOctets) {
        const longueur = Math.min(this.trancheOctets, total - debut);
        const octets = await this.plage(f.ref, debut, longueur);
        // Une plage qui n'a pas la longueur dite, une panne : la pièce n'est pas celle dont on a lu la taille.
        if (octets === null) return { statut: 'absente', ...none };
        entiere.update(octets);
        tranches.push({ debut, taille: longueur, sha256: await sha256Hex(octets) });
      }
      // Une pièce vide a une tranche, vide, à 0 : celle que remet `remettreTranche`.
      if (total === 0) tranches.push({ debut: 0, taille: 0, sha256: await sha256Hex(new Uint8Array()) });
      // La taille relue à la fin : une pièce changée pendant la lecture n'a pas d'empreinte [R663].
      if ((await this.tailleDe(f.ref)) !== total) return { statut: 'absente', ...none };
      return { statut: 'prete', taille: total, sha256: entiere.hex(), tranches };
    };
    const lu = await lire();
    const sansManifeste = { ...base, ...lu };
    const manifeste = await fingerprintOf(sansManifeste);
    // Au journal : les empreintes du fichier et du manifeste, la place, des tailles ; ni référence ni contenu [R13].
    await appendEvent(
      this.journal,
      {
        type: 'licences.reprise.piece',
        actor: this.actor(viewer),
        subject: `licence:${opened.licenceId}`,
        data: { rule: 'R667', fingerprint: opened.fingerprint, manifeste, index: base.index, statut: lu.statut, taille: lu.taille, tranches: lu.tranches.length },
      },
      this.now,
    );
    return { ok: true, value: { ...sansManifeste, manifeste } };
  }

  /**
   * Remet la tranche d'une pièce qui commence à `debut`, avec son empreinte recalculée sur les octets lus (RC46) [R667].
   * Avec l'empreinte `attendue` (celle de la liste de `empreintePiece`), une tranche dont les octets ne sont plus ceux-là
   * n'est jamais remise : « altérée ».
   */
  async remettreTranche(
    viewer: Viewer,
    document: unknown,
    stepUpId: unknown,
    index: unknown,
    debut: unknown,
    attendue?: unknown,
  ): Promise<{ ok: true; value: TrancheReprise } | ContenusRefusal> {
    const opened = await this.ouvrir(viewer, document);
    if (!opened.ok) return opened;
    const f = this.piece(opened.fichiers, index);
    if (f === null) return this.refuse(viewer, 'R659', 'bad_input');
    if (typeof debut !== 'number' || !Number.isSafeInteger(debut) || debut < 0 || debut % this.trancheOctets !== 0 || debut >= this.pieceMax) {
      return this.refuse(viewer, 'R659', 'bad_input');
    }
    if (attendue !== undefined && (typeof attendue !== 'string' || !HEX64.test(attendue))) return this.refuse(viewer, 'R659', 'bad_input');
    if (!avecPlages(this.storage)) return this.refuse(viewer, 'R667', 'stockage_sans_plages');
    const proof = await this.secondFactor.requireSecondFactor(viewer, 'export_complet', `licence:${opened.licenceId}`, stepUpId);
    if (!proof.ok) return { ok: false, rule: 'R601', code: proof.code };

    const base = { fingerprint: opened.fingerprint, index: index as number, debut };
    const none = { taille: null, sha256: null, contenu: null, suite: null };
    const lire = async (): Promise<TrancheReprise> => {
      if (masked(f.ref)) return { ...base, statut: 'masquee', total: null, ...none };
      if (f.ref.startsWith(PREFIXE_COFFRE)) return { ...base, statut: 'absente', total: null, ...none };
      const total = await this.tailleDe(f.ref);
      if (total === null) return { ...base, statut: 'absente', total: null, ...none };
      if (total > this.pieceMax) return { ...base, statut: 'trop_grosse', total, ...none };
      // Une place hors de la pièce : rien à remettre ; seule une pièce vide a une tranche vide, à 0.
      if (debut > 0 && debut >= total) return { ...base, statut: 'absente', total, ...none };
      const longueur = Math.min(this.trancheOctets, total - debut);
      const octets = longueur === 0 ? new Uint8Array() : await this.plage(f.ref, debut, longueur);
      if (octets === null) return { ...base, statut: 'absente', total, ...none };
      // La taille relue après la lecture : une pièce qui a grandi ou rapetissé pendant ce temps ne remet rien [R663].
      if ((await this.tailleDe(f.ref)) !== total) return { ...base, statut: 'absente', total: null, ...none };
      const sha256 = await sha256Hex(octets);
      if (attendue !== undefined && sha256 !== attendue) return { ...base, statut: 'alteree', total, ...none };
      const suite = debut + longueur < total ? debut + longueur : null;
      return { ...base, statut: 'remise', total, taille: longueur, sha256, contenu: octets, suite };
    };
    const tranche = await lire();
    // Au journal : la place, des tailles et le statut ; ni référence ni contenu [R13].
    await appendEvent(
      this.journal,
      {
        type: 'licences.reprise.tranche',
        actor: this.actor(viewer),
        subject: `licence:${opened.licenceId}`,
        data: { rule: 'R667', fingerprint: opened.fingerprint, index: tranche.index, debut, statut: tranche.statut, octets: tranche.taille ?? 0, attendue: attendue !== undefined },
      },
      this.now,
    );
    return { ok: true, value: tranche };
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

/** Dit si une tranche remise est celle que dit l'empreinte de sa pièce : même place, même taille, même empreinte [R667]. */
export async function trancheIntacte(empreinte: Pick<EmpreintePiece, 'statut' | 'index' | 'taille' | 'tranches'>, tranche: Pick<TrancheReprise, 'statut' | 'index' | 'debut' | 'total' | 'contenu'>): Promise<boolean> {
  if (empreinte.statut !== 'prete' || tranche.statut !== 'remise' || tranche.contenu === null) return false;
  if (tranche.index !== empreinte.index || tranche.total !== empreinte.taille) return false;
  const dite = empreinte.tranches.find((t) => t.debut === tranche.debut);
  return dite !== undefined && dite.taille === tranche.contenu.byteLength && dite.sha256 === (await sha256Hex(tranche.contenu));
}

/** Dit si des tranches, dans l'ordre, recomposent la pièce que dit son empreinte : chaque tranche et le SHA-256 entier [R667]. */
export async function pieceRecomposee(empreinte: Pick<EmpreintePiece, 'statut' | 'taille' | 'sha256' | 'tranches'>, tranches: readonly Uint8Array[]): Promise<boolean> {
  if (empreinte.statut !== 'prete' || tranches.length !== empreinte.tranches.length) return false;
  const entiere = new Sha256Flux();
  let total = 0;
  for (let i = 0; i < tranches.length; i++) {
    const t = tranches[i]!;
    const dite = empreinte.tranches[i]!;
    if (dite.debut !== total || dite.taille !== t.byteLength || dite.sha256 !== (await sha256Hex(t))) return false;
    entiere.update(t);
    total += t.byteLength;
  }
  return total === empreinte.taille && entiere.hex() === empreinte.sha256;
}

/** L'empreinte du manifeste d'une pièce rendue, à comparer à celle du journal [R667]. */
export async function empreinteManifestePiece(e: EmpreintePiece): Promise<string> {
  const { manifeste: _m, ...rest } = e;
  return fingerprintOf(rest);
}
