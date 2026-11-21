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
 * - audit énergétique (AU010, art. L126-28-1 du code de la construction et de l'habitation) : demandé pour la vente
 *   d'une maison ou d'un immeuble d'habitation hors copropriété (monopropriété) classé F ou G depuis le 1er avril 2023,
 *   E depuis le 1er janvier 2025, D à partir du 1er janvier 2034 ; valable 5 ans, et remis à l'acquéreur dès la
 *   première visite. La classe est celle du DPE de la fiche du bien. Une classe inconnue, ou lue sur un DPE d'avant le
 *   1er juillet 2021 (ancienne méthode), empêche le dossier d'être complet tant que la fiche ne la précise pas : on ne
 *   devine pas une obligation, ni un audit de plusieurs centaines d'euros. La copropriété inconnue fait demander l'audit.
 *   Lecture prudente : la règle de la métropole vaut aussi outre-mer, où l'obligation vient plus tard (une pièce de trop
 *   plutôt qu'un acte retardé) ;
 * - obligations locales (AU011, art. L271-4 du CCH) : l'état termites et l'information mérule pour un bâtiment dans
 *   une zone délimitée par arrêté préfectoral, le contrôle de l'assainissement non collectif pour un logement non
 *   raccordé ; la zone vient d'une lecture datée de l'arrêté, rangée par la direction pour la commune du bien
 *   (`obligations-locales.ts`), et chaque ligne porte sa source. Une commune inconnue, une zone sans lecture à jour ou un
 *   raccordement non déclaré empêchent le dossier d'être complet : on ne laisse plus ces pièces au notaire ;
 * - électricité et gaz (AU084) : demandés selon l'âge de chaque installation, ou de sa dernière rénovation complète,
 *   déclaré avec sa preuve (`installations.ts`) ; sans gaz déclaré absent, pas de diagnostic gaz. Rien de déclaré, ou un
 *   âge sans certificat ni facture : l'âge du bâtiment en tient lieu, comme avant ;
 * - un fonds de commerce relève de M16 : pas de liste ici ;
 * - une pièce d'identité, un document anti-blanchiment ou un RIB ne sont jamais des pièces du dossier [R15].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { EnergyClass, PropertySheet } from '../annonces/fiche-bien.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ControlesOffre } from '../offres/controles-offre.ts';
import { gateSaleFile, refuseFile, type PropertyKind } from './acces-dossier.ts';
import { NO_INSTALLATIONS, installationFactsOf, installationVerdict, type InstallationFacts, type InstallationReading } from './installations.ts';
import { UNKNOWN_LOCAL, localFactsOf, type LocalFacts, type LocalHazard, type LocalSource, type LocalZone } from './obligations-locales.ts';

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
  'audit_energetique',
  'etat_termites',
  'information_merule',
  'controle_assainissement',
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
  /** L'installation est déclarée, avec sa preuve, posée ou rénovée il y a 15 ans ou plus (AU084). */
  | 'installation_declaree_plus_15_ans'
  /** Le gaz est déclaré présent, sans année : l'âge du bâtiment en tient lieu (AU084). */
  | 'installation_gaz_declaree'
  | 'terrain'
  | 'lot_copropriete'
  | 'classe_energie_soumise_audit'
  | 'copropriete_inconnue'
  | 'zone_termites'
  | 'zone_merule'
  | 'assainissement_non_collectif';

export interface ExpectedPiece {
  piece: Piece;
  side: Side;
  reason: PieceReason;
  /** La source locale datée qui fait demander la pièce (AU011) : l'arrêté lu par la direction. */
  source?: LocalSource;
}


/**
 * Ce qui manque au bien pour dresser la liste : la fiche entière, la copropriété, la classe du DPE (AU010), la commune,
 * une zone locale sans lecture à jour, le raccordement aux eaux usées (AU011).
 */
export type UnknownData = 'fiche_bien' | 'copropriete' | 'classe_energie' | 'commune' | 'zone_termites' | 'zone_merule' | 'assainissement';

/** Ce qu'une lecture locale a dit pour le bien, dans la zone ou hors zone, avec sa source : l'agent voit pourquoi. */
export interface LocalReading {
  hazard: LocalHazard;
  inZone: boolean;
  source: LocalSource;
}

/** Les logements : une maison, un immeuble d'habitation. */
const HOUSING: readonly PropertyKind[] = ['home', 'building'];

/** Le premier jour d'un DPE de la méthode en vigueur : une classe lue sur un DPE plus ancien ne compte pas (AU010). */
export const DPE_CURRENT_METHOD_FROM = '2021-07-01';

/**
 * Les classes du DPE soumises à l'audit énergétique à la vente, l'année donnée (art. L126-28-1 du CCH, texte lu le
 * 2026-11-18) : F et G depuis le 1er avril 2023, E depuis le 1er janvier 2025, D à partir du 1er janvier 2034. Seule
 * l'année est connue : 2023 compte en entier, par prudence.
 */
export function auditClasses(year: number): readonly EnergyClass[] {
  if (year >= 2034) return ['D', 'E', 'F', 'G'];
  if (year >= 2025) return ['E', 'F', 'G'];
  if (year >= 2023) return ['F', 'G'];
  return [];
}

/**
 * Le cas de l'audit énergétique pour un bien, l'année donnée (AU010) : `requis` (avec la classe qui le déclenche),
 * `non_requis`, ou `inconnu` quand la fiche ne permet pas de trancher. Fonction pure, aussi pour la remise à la visite.
 */
export function energyAuditCase(kind: PropertyKind, sheet: PropertySheet | null, year: number): { case: 'requis'; energyClass: EnergyClass | null } | { case: 'non_requis' } | { case: 'inconnu' } {
  if (!HOUSING.includes(kind) || !sheet) return HOUSING.includes(kind) ? { case: 'inconnu' } : { case: 'non_requis' };
  // Un lot de copropriété n'y est pas soumis ; une copropriété inconnue le fait demander.
  if (sheet.coownership?.isCoownership === true) return { case: 'non_requis' };
  const e = sheet.energy;
  if (!e || e.diagnosedOn < DPE_CURRENT_METHOD_FROM) return { case: 'inconnu' };
  if (!auditClasses(year).includes(e.energyClass)) return { case: 'non_requis' };
  return { case: 'requis', energyClass: e.energyClass };
}

export type { PropertyKind } from './acces-dossier.ts';

export interface ExpectedList {
  pieces: ExpectedPiece[];
  unknown: UnknownData[];
  /** Les lectures locales qui ont servi (AU011), dans la zone ou non. */
  local: LocalReading[];
  /** Ce que les déclarations des installations ont décidé, pour un logement (AU084) ; vide sinon. */
  installations: InstallationReading[];
}

/** Les bâtiments : tout bien bâti, logement ou non. Un terrain et un fonds de commerce n'en sont pas. */
const BUILT: readonly PropertyKind[] = ['home', 'building', 'commercial', 'business_walls'];


/**
 * Les pièces attendues, par des règles écrites, dans un ordre fixe. Fonction pure : mêmes données, même liste [R60].
 * `year` est l'année en cours, à Paris. Un fonds de commerce rend null (M16).
 */
export function expectedPieces(
  kind: PropertyKind,
  sheet: PropertySheet | null,
  year: number,
  local: LocalFacts = UNKNOWN_LOCAL,
  installations: InstallationFacts = NO_INSTALLATIONS,
  /** L'année où l'âge des installations est jugé (AU084, relecture de Codex) : celle de l'acte, jamais avant `year`. */
  agingYear: number = year,
): ExpectedList | null {
  if (kind === 'business') return null;
  const pieces: ExpectedPiece[] = [];
  const unknown: UnknownData[] = [];
  const readings: LocalReading[] = [];
  const installationReadings: InstallationReading[] = [];
  const add = (piece: Piece, side: Side, reason: PieceReason, source?: LocalSource) => pieces.push(source ? { piece, side, reason, source } : { piece, side, reason });
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
      // Électricité et gaz : installation intérieure de plus de 15 ans. Son âge, et la présence du gaz, viennent de la
      // déclaration prouvée (AU084) ; sinon l'âge du bâtiment en tient lieu. Seule l'année est connue : 15 ans pile
      // comptent, une installation de janvier a ses 15 ans dans l'année.
      const age = Math.max(year, agingYear);
      const old = buildYear === null || age - buildYear >= 15;
      for (const installation of ['electricite', 'gaz'] as const) {
        const fact = installations[installation];
        const verdict = installationVerdict(fact, age);
        installationReadings.push({ installation, verdict: fact ? verdict : 'non_declaree', since: fact?.since ?? null, proof: fact?.proof ?? null });
        if (verdict === 'absente' || verdict === 'recente') continue;
        if (verdict === 'ancienne') {
          add(installation, 'vendeur', 'installation_declaree_plus_15_ans');
          continue;
        }
        // Non tranché : l'âge du bâtiment.
        if (installation === 'electricite') {
          if (buildYear === null) add('electricite', 'vendeur', 'annee_construction_inconnue');
          else if (old) add('electricite', 'vendeur', 'installation_plus_15_ans');
        } else if (old) {
          // Le gaz sert au chauffage, à la cuisson, à l'eau chaude : sans déclaration, demandé pour tout logement ancien.
          add('gaz', 'vendeur', fact?.present ? 'installation_gaz_declaree' : c?.heating === 'individuel_gaz' ? 'chauffage_gaz' : 'installation_gaz_possible');
        }
      }
    }
    if (sheet && sheet.coownership === null) unknown.push('copropriete');
    if (sheet?.coownership?.isCoownership) {
      // Loi ALUR : les documents remis à l'acquéreur d'un lot, dont la notice d'information et le plan pluriannuel de
      // travaux ou le diagnostic technique global ; le dossier technique amiante des parties communes si l'immeuble
      // a son permis d'avant juillet 1997, ou si on ne sait pas.
      for (const p of ['reglement_copropriete', 'pv_assemblees', 'fiche_synthetique', 'pre_etat_date', 'carnet_entretien', 'mesurage_carrez', 'notice_information', 'pppt_dtg'] as const) add(p, 'vendeur', 'lot_copropriete');
      if (buildYear === null || buildYear <= 1997) add('dta_parties_communes', 'vendeur', buildYear === null ? 'annee_construction_inconnue' : 'construit_avant_juillet_1997');
    }
    // Audit énergétique (AU010) : une maison ou un immeuble hors copropriété, classé dans une classe soumise cette année.
    if (sheet && HOUSING.includes(kind)) {
      const audit = energyAuditCase(kind, sheet, year);
      if (audit.case === 'requis') add('audit_energetique', 'vendeur', sheet.coownership === null ? 'copropriete_inconnue' : 'classe_energie_soumise_audit');
      else if (audit.case === 'inconnu') unknown.push('classe_energie');
    }
    // Obligations locales (AU011) : termites et mérule pour un bâtiment en zone d'arrêté, lue et datée ; l'assainissement
    // non collectif pour un logement non raccordé. Ce qu'on ne sait pas ne se devine pas.
    if (BUILT.includes(kind)) {
      if (!local.commune) unknown.push('commune');
      else {
        const zones: [LocalHazard, LocalZone | null, Piece, PieceReason, UnknownData][] = [
          ['termites', local.termites, 'etat_termites', 'zone_termites', 'zone_termites'],
          ['merule', local.merule, 'information_merule', 'zone_merule', 'zone_merule'],
        ];
        for (const [hazard, zone, piece, reason, missing] of zones) {
          if (!zone) {
            unknown.push(missing);
            continue;
          }
          readings.push({ hazard, inZone: zone.inZone, source: zone.source });
          if (zone.inZone) add(piece, 'vendeur', reason, zone.source);
        }
      }
    }
    if (HOUSING.includes(kind)) {
      if (local.sanitation === null) unknown.push('assainissement');
      else if (local.sanitation === 'non_collectif') add('controle_assainissement', 'vendeur', 'assainissement_non_collectif');
    }
  }
  add('fiche_renseignements_acquereur', 'acquereur', 'toujours');
  return { pieces, unknown, local: readings, installations: installationReadings };
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
  /** Les lectures locales qui ont servi, avec leur source datée (AU011). */
  local: LocalReading[];
  /** Ce que les déclarations des installations ont décidé (AU084). */
  installations: InstallationReading[];
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
  /** Range un fichier déposé (N12) ; absent, le dépôt est fermé. */
  upload?(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
export type PieceProblem =
  | { ok: false; rule: null; code: 'unknown_file' | 'file_stopped' | 'unknown_piece' | 'not_expected' | 'bad_ref' | 'not_stored' | 'ref_used' | 'business' | 'busy' | 'bad_date' | 'closed' }
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

  private refuse(viewer: Viewer, fileId: string, code: string): Promise<Refusal> {
    return refuseFile(this.journal, this.now, viewer, fileId, 'sale_file_pieces', code);
  }

  private gate(viewer: Viewer, fileId: string, write: boolean) {
    return gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, write, 'sale_file_pieces');
  }

  /**
   * L'année des règles est celle de l'ouverture du dossier, à Paris (offre acceptée, avant le compromis) : un acte
   * rapporté après un passage d'année ne fait pas demander une pièce que la vente n'exigeait pas (AU010, relecture
   * de Codex). Sans date lisible, l'année en cours, par prudence.
   */
  private async expected(fileId: string, propertyId: string, kind: PropertyKind, deedDay?: string, withInstallations = true): Promise<ExpectedList | null> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    const sheet = row ? (JSON.parse(row.data) as PropertySheet) : null;
    const opened = await this.db.first<{ opened_at: string }>('SELECT opened_at FROM sale_files WHERE id = ?', [fileId]);
    const at = opened ? new Date(opened.opened_at) : null;
    const year = Number(localTime(at && !Number.isNaN(at.getTime()) ? at : this.now(), TIME_ZONE).date.slice(0, 4));
    // Le lieu et l'installation (AU011) : lus au jour du calcul, car une lecture d'arrêté vieillit.
    const network = await this.db.first<{ network_id: string }>('SELECT network_id FROM sale_files WHERE id = ?', [fileId]);
    const local = network ? await localFactsOf(this.db, network.network_id, propertyId, localTime(this.now(), TIME_ZONE).date) : UNKNOWN_LOCAL;
    // Les installations déclarées avec leur preuve (AU084).
    const installations = network && withInstallations ? await installationFactsOf(this.db, network.network_id, propertyId) : NO_INSTALLATIONS;
    // Une installation vieillit jusqu'à l'acte (AU084, relecture de Codex) : son âge est jugé l'année de l'acte, ou
    // aujourd'hui, à Paris ; les règles qui changent avec la loi restent celles de l'ouverture.
    const agingYear = Number((deedDay ?? localTime(this.now(), TIME_ZONE).date).slice(0, 4));
    return expectedPieces(kind, sheet, year, local, installations, agingYear);
  }

  /** La liste des pièces du dossier, ce qui manque, et s'il est complet [R60]. */
  async status(viewer: Viewer, fileId: string, options: { /** Le jour de l'acte, `AAAA-MM-JJ` : l'âge des installations y est jugé. */ deedDay?: string } = {}): Promise<{ ok: true; value: FileStatus } | Refusal | PieceProblem> {
    const g = await this.gate(viewer, fileId, false);
    if (!g.ok) return g;
    return this.compute(viewer, g.file, g.kind, options.deedDay);
  }

  private async compute(viewer: Viewer, file: { id: string; network_id: string; property_id: string; buyer_person_id: string }, kind: PropertyKind, deedDay?: string): Promise<{ ok: true; value: FileStatus } | PieceProblem> {
    const list = await this.expected(file.id, file.property_id, kind, deedDay);
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
    return { ok: true, value: { fileId: file.id, lines, missing, unknown: list.unknown, local: list.local, installations: list.installations, identity, complete } };
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
    // Un dossier clos par l'acte ne reçoit plus de pièce.
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'closed' };
    const piece = input.piece as Piece;
    const list = await this.expected(g.file.id, g.file.property_id, g.kind);
    if (!list) return { ok: false, rule: null, code: 'business' };
    // Un diagnostic électricité ou gaz que l'âge du bâtiment ferait demander se range toujours : un acte rapporté après
    // une rénovation l'exige au jour de la vente (AU084, relecture de Codex). Une pièce de trop ne nuit pas.
    const installationPiece = piece === 'electricite' || piece === 'gaz';
    const expectedHere = list.pieces.some((p) => p.piece === piece) || (installationPiece && (await this.expected(g.file.id, g.file.property_id, g.kind, undefined, false))?.pieces.some((p) => p.piece === piece));
    if (!expectedHere) return { ok: false, rule: null, code: 'not_expected' };
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
