/**
 * Pièces du dossier notaire (M10, N01) [R15, R16, R17, R60].
 *
 * La liste des pièces attendues d'un dossier de vente est calculée par des règles écrites ici, les mêmes pour tous,
 * à partir des seules données du bien (type et fiche de P01). Chaque ligne porte sa raison. L'agent du dossier range
 * chaque pièce reçue par sa référence de stockage ; une nouvelle version s'ajoute, rien ne change ni ne s'efface.
 * Le dossier est « complet » quand chaque pièce attendue est reçue, que l'identité de l'acquéreur est vérifiée (un
 * état lu dans le contrôle d'identité de D03, jamais une copie) et qu'aucune donnée du bien ne manque pour dresser
 * la liste.
 *
 * Décidé, lecture prudente :
 * - une donnée du bien inconnue (année de construction, chauffage) fait demander le diagnostic qu'elle pourrait
 *   rendre inutile : mieux vaut une pièce de trop qu'un acte retardé ; la copropriété inconnue, elle, empêche le
 *   dossier d'être complet tant que la fiche ne la précise pas, car ses six pièces ne se devinent pas ;
 * - les diagnostics qui dépendent d'un arrêté local (termites, mérule, assainissement non collectif) ne sont pas
 *   encore listés : le notaire les demande, une tâche à part les ajoutera par commune ;
 * - un fonds de commerce relève de M16 : pas de liste ici ;
 * - une pièce d'identité, un document anti-blanchiment ou un RIB ne sont jamais des pièces du dossier [R15].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { PropertySheet } from '../annonces/fiche-bien.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ControlesOffre } from '../offres/controles-offre.ts';

const TIME_ZONE = 'Europe/Paris';

export const PIECES = [
  'titre_propriete',
  'fiche_renseignements_vendeur',
  'etat_risques',
  'dpe',
  'amiante',
  'plomb',
  'electricite',
  'gaz',
  'bornage',
  'reglement_copropriete',
  'pv_assemblees',
  'fiche_synthetique',
  'pre_etat_date',
  'carnet_entretien',
  'mesurage_carrez',
  'notice_information',
  'pppt_dtg',
  'dta_parties_communes',
  'fiche_renseignements_acquereur',
] as const;
export type Piece = (typeof PIECES)[number];

/** Ce qui n'est jamais une pièce du dossier : ces documents vivent dans le coffre de la conformité, ou nulle part [R15]. */
export const FORBIDDEN_PIECES = ['piece_identite', 'passeport', 'carte_identite', 'titre_sejour', 'justificatif_domicile', 'anti_blanchiment', 'rib', 'releve_bancaire', 'avis_imposition'] as const;

export type Side = 'vendeur' | 'acquereur';

/** Pourquoi une pièce est demandée : une raison écrite, lisible par l'agent. */
export type PieceReason =
  | 'toujours'
  | 'bien_bati'
  | 'construit_avant_juillet_1997'
  | 'annee_construction_inconnue'
  | 'construit_avant_1949'
  | 'installation_plus_15_ans'
  | 'chauffage_gaz'
  | 'installation_gaz_possible'
  | 'terrain'
  | 'lot_copropriete';

export interface ExpectedPiece {
  piece: Piece;
  side: Side;
  reason: PieceReason;
}

export type PropertyKind = 'home' | 'land' | 'building' | 'commercial' | 'business_walls' | 'business';

/** Ce qui manque au bien pour dresser la liste : la fiche entière, ou la copropriété. */
export type UnknownData = 'fiche_bien' | 'copropriete';

export interface ExpectedList {
  pieces: ExpectedPiece[];
  unknown: UnknownData[];
}

const HOUSING: readonly PropertyKind[] = ['home', 'building'];

/**
 * Les pièces attendues, par des règles écrites, dans un ordre fixe. Fonction pure : mêmes données, même liste [R60].
 * `year` est l'année en cours, à Paris. Un fonds de commerce rend null (M16).
 */
export function expectedPieces(kind: PropertyKind, sheet: PropertySheet | null, year: number): ExpectedList | null {
  if (kind === 'business') return null;
  const pieces: ExpectedPiece[] = [];
  const unknown: UnknownData[] = [];
  const add = (piece: Piece, side: Side, reason: PieceReason) => pieces.push({ piece, side, reason });
  add('titre_propriete', 'vendeur', 'toujours');
  add('fiche_renseignements_vendeur', 'vendeur', 'toujours');
  add('etat_risques', 'vendeur', 'toujours');
  if (kind === 'land') {
    add('bornage', 'vendeur', 'terrain');
  } else {
    if (!sheet) unknown.push('fiche_bien');
    const c = sheet?.characteristics;
    const buildYear = c?.buildYear ?? null;
    add('dpe', 'vendeur', 'bien_bati');
    // Amiante : permis de construire délivré avant le 1er juillet 1997. Seule l'année est connue : 1997 compris.
    if (buildYear === null) add('amiante', 'vendeur', 'annee_construction_inconnue');
    else if (buildYear <= 1997) add('amiante', 'vendeur', 'construit_avant_juillet_1997');
    if (HOUSING.includes(kind)) {
      // Plomb (constat de risque d'exposition) : logement construit avant le 1er janvier 1949.
      if (buildYear === null) add('plomb', 'vendeur', 'annee_construction_inconnue');
      else if (buildYear < 1949) add('plomb', 'vendeur', 'construit_avant_1949');
      // Électricité : installation de plus de 15 ans. Son âge n'est pas dans la fiche : celui du bâtiment en tient lieu,
      // et seule l'année est connue : 15 ans pile comptent, une installation de janvier a ses 15 ans dans l'année.
      const old = buildYear === null || year - buildYear >= 15;
      if (buildYear === null) add('electricite', 'vendeur', 'annee_construction_inconnue');
      else if (old) add('electricite', 'vendeur', 'installation_plus_15_ans');
      // Gaz : toute installation intérieure de plus de 15 ans, chauffage, cuisson ou eau chaude. La fiche ne dit pas s'il
      // y a du gaz : il est demandé pour tout logement ancien ; sans installation, la pièce est l'attestation d'absence.
      if (old) add('gaz', 'vendeur', c?.heating === 'individuel_gaz' ? 'chauffage_gaz' : 'installation_gaz_possible');
    }
    if (sheet && sheet.coownership === null) unknown.push('copropriete');
    if (sheet?.coownership?.isCoownership) {
      // Loi ALUR : les documents remis à l'acquéreur d'un lot, dont la notice d'information et le plan pluriannuel de
      // travaux ou le diagnostic technique global ; le dossier technique amiante des parties communes si l'immeuble
      // a son permis d'avant juillet 1997, ou si on ne sait pas.
      for (const p of ['reglement_copropriete', 'pv_assemblees', 'fiche_synthetique', 'pre_etat_date', 'carnet_entretien', 'mesurage_carrez', 'notice_information', 'pppt_dtg'] as const) add(p, 'vendeur', 'lot_copropriete');
      if (buildYear === null || buildYear <= 1997) add('dta_parties_communes', 'vendeur', buildYear === null ? 'annee_construction_inconnue' : 'construit_avant_juillet_1997');
    }
  }
  add('fiche_renseignements_acquereur', 'acquereur', 'toujours');
  return { pieces, unknown };
}

export interface ReceivedPiece {
  piece: Piece;
  version: number;
  ref: string;
  /** La date du document, `AAAA-MM-JJ` : sa durée de validité est jugée à l'acte (N06). */
  issuedOn: string;
  receivedAt: string;
}

export interface PieceLine extends ExpectedPiece {
  /** La dernière version reçue, ou null. */
  received: ReceivedPiece | null;
}

export interface FileStatus {
  fileId: string;
  lines: PieceLine[];
  missing: Piece[];
  unknown: UnknownData[];
  /**
   * Un état, jamais une copie : vérifiée dans la fenêtre du réglage de D03, ou non [R15, R58]. `non_visible` : qui lit
   * ne voit pas la fiche de l'acquéreur en entier, l'état ne lui est pas dit et le dossier n'est pas dit complet [R16].
   */
  identity: 'verifiee' | 'non_verifiee' | 'non_visible';
  complete: boolean;
}

/** Le stockage des pièces (Cloudflare R2), derrière une interface : un faux stockage dans les tests. */
export interface PieceStore {
  has(ref: string): Promise<boolean>;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
export type PieceProblem =
  | { ok: false; rule: null; code: 'unknown_file' | 'unknown_piece' | 'not_expected' | 'bad_ref' | 'not_stored' | 'ref_used' | 'business' | 'busy' | 'bad_date' }
  | { ok: false; rule: 'R15'; code: 'forbidden_piece' };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REF_FILE = new RegExp(`^${UUID}\\.(?:pdf|jpg|png)$`);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function validDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export class PiecesDossier {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly controles: ControlesOffre;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly store: PieceStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.controles = new ControlesOffre(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, fileId: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'sale_file_pieces', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /**
   * Le dossier, s'il est visible en entier : son bien vu en entier (agent du bien, direction, conformité), lecture écrite
   * au journal [R16]. `write` : seul l'agent du bien.
   */
  private async gate(viewer: Viewer, fileId: string, write: boolean): Promise<{ ok: true; file: { id: string; network_id: string; property_id: string; buyer_person_id: string }; kind: PropertyKind } | Refusal | PieceProblem> {
    const file = await this.db.first<{ id: string; network_id: string; property_id: string; buyer_person_id: string }>('SELECT id, network_id, property_id, buyer_person_id FROM sale_files WHERE id = ?', [fileId]);
    if (!file || file.network_id !== viewer.networkId) {
      await this.refuse(viewer, fileId, 'unknown');
      return { ok: false, rule: null, code: 'unknown_file' };
    }
    const p = await this.acces.readProperty(viewer, file.property_id);
    if (!p.ok) {
      // Chaque refus est aussi écrit sous le dossier, pas seulement sous le bien [R16].
      await this.refuse(viewer, fileId, p.code);
      return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_file' } : (p as Refusal);
    }
    if (p.view !== 'full') return this.refuse(viewer, fileId, 'not_assigned');
    if (write && (viewer.role !== 'agent' || viewer.userId !== p.value.agent_id)) return this.refuse(viewer, fileId, 'role');
    return { ok: true, file, kind: p.value.kind as PropertyKind };
  }

  private async expected(propertyId: string, kind: PropertyKind): Promise<ExpectedList | null> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    const sheet = row ? (JSON.parse(row.data) as PropertySheet) : null;
    const year = Number(localTime(this.now(), TIME_ZONE).date.slice(0, 4));
    return expectedPieces(kind, sheet, year);
  }

  /** La liste des pièces du dossier, ce qui manque, et s'il est complet [R60]. */
  async status(viewer: Viewer, fileId: string): Promise<{ ok: true; value: FileStatus } | Refusal | PieceProblem> {
    const g = await this.gate(viewer, fileId, false);
    if (!g.ok) return g;
    return this.compute(viewer, g.file, g.kind);
  }

  private async compute(viewer: Viewer, file: { id: string; network_id: string; property_id: string; buyer_person_id: string }, kind: PropertyKind): Promise<{ ok: true; value: FileStatus } | PieceProblem> {
    const list = await this.expected(file.property_id, kind);
    if (!list) return { ok: false, rule: null, code: 'business' };
    const rows = await this.db.all<{ piece: Piece; version: number; ref: string; issued_on: string; received_at: string }>(
      `SELECT piece, version, ref, issued_on, received_at FROM sale_file_pieces p WHERE file_id = ?
       AND version = (SELECT MAX(version) FROM sale_file_pieces q WHERE q.file_id = p.file_id AND q.piece = p.piece)`,
      [file.id],
    );
    const latest = new Map(rows.map((r) => [r.piece, { piece: r.piece, version: Number(r.version), ref: r.ref, issuedOn: r.issued_on, receivedAt: r.received_at }]));
    const lines: PieceLine[] = list.pieces.map((e) => ({ ...e, received: latest.get(e.piece) ?? null }));
    const missing = lines.filter((l) => l.received === null).map((l) => l.piece);
    // L'identité est une donnée de l'acquéreur : il faut voir sa fiche en entier, lecture écrite au journal [R16].
    const buyer = await this.acces.readFiche(viewer, file.buyer_person_id);
    let identity: FileStatus['identity'] = 'non_visible';
    if (buyer.ok && buyer.view === 'full') identity = (await this.controles.identitySeenAt(file.network_id, file.buyer_person_id, this.now())) !== null ? 'verifiee' : 'non_verifiee';
    else if (buyer.ok) await this.refuse(viewer, file.id, 'buyer_not_assigned');
    const complete = missing.length === 0 && list.unknown.length === 0 && identity === 'verifiee';
    return { ok: true, value: { fileId: file.id, lines, missing, unknown: list.unknown, identity, complete } };
  }

  /**
   * L'agent du dossier range une pièce reçue par sa référence de stockage. Une pièce interdite est refusée [R15] ; une
   * pièce non attendue aussi. Une pièce déjà reçue reçoit une nouvelle version, l'ancienne reste [R17].
   */
  async add(viewer: Viewer, fileId: string, input: { piece: string; ref: string; issuedOn: string }): Promise<{ ok: true; value: FileStatus } | Refusal | PieceProblem> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    if ((FORBIDDEN_PIECES as readonly string[]).includes(input.piece)) {
      await appendEvent(this.journal, { type: 'dossier.piece_refusee', actor: this.actor(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R15', piece: input.piece } }, this.now);
      return { ok: false, rule: 'R15', code: 'forbidden_piece' };
    }
    if (!(PIECES as readonly string[]).includes(input.piece)) return { ok: false, rule: null, code: 'unknown_piece' };
    const piece = input.piece as Piece;
    const list = await this.expected(g.file.property_id, g.kind);
    if (!list) return { ok: false, rule: null, code: 'business' };
    if (!list.pieces.some((p) => p.piece === piece)) return { ok: false, rule: null, code: 'not_expected' };
    // La référence est donnée par le stockage, dans le dossier de ce dossier de vente : aucun nom de fichier libre.
    const prefix = `dossiers/${fileId}/`;
    if (typeof input.ref !== 'string' || !input.ref.startsWith(prefix) || !REF_FILE.test(input.ref.slice(prefix.length))) return { ok: false, rule: null, code: 'bad_ref' };
    // La date du document : un vrai jour, jamais dans le futur, à Paris ; jamais inventée, saisie par l'agent [R10].
    if (!validDay(input.issuedOn) || input.issuedOn > localTime(this.now(), TIME_ZONE).date) return { ok: false, rule: null, code: 'bad_date' };
    if (!(await this.store.has(input.ref))) return { ok: false, rule: null, code: 'not_stored' };
    if (await this.db.first('SELECT 1 FROM sale_file_pieces WHERE ref = ?', [input.ref])) return { ok: false, rule: null, code: 'ref_used' };
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM sale_file_pieces WHERE file_id = ? AND piece = ?', [fileId, piece]);
    const version = Number(last?.v ?? 0) + 1;
    try {
      await this.db.run(
        'INSERT INTO sale_file_pieces (id, file_id, network_id, piece, version, ref, issued_on, received_at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [this.newId(), fileId, g.file.network_id, piece, version, input.ref, input.issuedOn, this.now().toISOString(), this.actor(viewer)],
      );
    } catch (error) {
      // Deux envois en même temps : la même version ou la même référence ne s'écrivent qu'une fois.
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: /\.ref/.test(String(error)) ? 'ref_used' : 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'dossier.piece_recue', actor: this.actor(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R60', piece, version } }, this.now);
    return this.compute(viewer, g.file, g.kind);
  }
}
