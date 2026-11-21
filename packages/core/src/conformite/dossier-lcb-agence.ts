/**
 * Le dossier de la lutte contre le blanchiment de l'agence sous licence, remis à son responsable de la conformité seul
 * (HX76 ; M12 Conformité, « Anti-blanchiment » ; Feuille de route, phase 5, « licence du logiciel aux agences hors
 * réseau ») [R662, R663, R664, R601, R16, R17].
 *
 * Décidé, lecture prudente :
 *   - l'agence sous licence doit garder ce dossier cinq ans après la fin de chaque relation d'affaires (code monétaire
 *     et financier, article L561-12) : elle le reprend à tout moment, licence active, suspendue ou terminée ;
 *   - seul le rôle `compliance` du réseau de l'agence le tire et le vérifie : ni sa direction, ni le réseau qui donne la
 *     licence, ni une autre agence. Le cahier : les documents anti-blanchiment « ne sont visibles que du responsable » ;
 *   - sur la preuve d'un second facteur, pour ce dossier seul (`export_complet`, sujet `licence_lcb:<id>`) [R601] ;
 *   - les tables sont celles du traitement `conformite-lcb-ft` du registre des traitements, prises sans être nommées
 *     une à une. Une table sans colonne `network_id` déclare son chemin ici (`CHEMINS_LCB`), suivi par une vraie clé
 *     étrangère ; les tables se lisent enfants d'abord (`ORDRE_LCB`), pour qu'une ligne écrite pendant la lecture
 *     n'entre qu'avec ce qu'elle désigne [R662] ;
 *   - le contenu des pièces du coffre n'est pas dans le dossier (aucun stockage n'est branché au Worker) : chaque pièce
 *     y est dite avec sa référence, son empreinte SHA-256, sa sorte et sa taille, pour que l'agence vérifie chacune
 *     quand elle la reçoit [R664] ;
 *   - AIMMO range l'empreinte du dossier, et rien d'autre : aucun compte de tables, de lignes ni de pièces. Le journal
 *     ne porte que l'empreinte [R663].
 *
 * Jamais vu : rien ne trahit le dossier. Ni le journal, ni le registre des remises, ni le fichier de reprise de la
 * direction (HX74) ne changent avec ce que le dossier contient : zéro ou dix signalements laissent les mêmes traces, et
 * la base refuse une remise à un autre rôle ou à un autre réseau [R663].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DispositifLcb } from './dispositif-lcb.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { masquerTexte, tablesLcbFt } from '../licences/reprise.ts';
import { canonicalJson, fingerprintOf, type SecondFactorGate } from '../rapports/export-agent.ts';

export const DOSSIER_LCB_FORMAT = 'aimmo-dossier-lcb-agence/1';

/** Ce que le dossier ne porte pas, dit dans le dossier même. */
export const DOSSIER_LCB_HORS_FICHIER = [
  'Le contenu des pièces du coffre : la liste « pieces » dit chacune, avec sa référence et son empreinte SHA-256, pour la vérifier quand elle est reçue.',
  'Le journal commun à toute la base, chaîné ligne à ligne : il ne se découpe pas par réseau.',
] as const;

/**
 * Le chemin d'une table du traitement qui n'a pas de colonne `network_id` : sa colonne, la table déjà trouvée, la clé
 * de cette table. Un test exige une vraie clé étrangère pour chaque chemin [R662].
 */
export const CHEMINS_LCB: Readonly<Record<string, readonly [string, string, string]>> = {
  freeze_registry_entries: ['version_id', 'freeze_registry_versions', 'id'],
};

/**
 * L'ordre de lecture : chaque table avant celles qu'elle désigne. Un test relit les clés étrangères des migrations et
 * exige cet ordre, et chaque table du traitement une seule fois [R662].
 */
export const ORDRE_LCB: readonly string[] = [
  'risk_validations',
  'risk_sheets',
  'beneficial_owners',
  'client_identifications',
  'compliance_vault_pieces',
  'vigilance_decisions',
  'vigilance_alerts',
  'vigilance_settings',
  'business_transfer_watch_decisions',
  'business_transfer_watch',
  'suspicion_decisions',
  'suspicion_reports',
  'freeze_match_decisions',
  'freeze_matches',
  'freeze_checks',
  'freeze_registry_entries',
  'freeze_registry_versions',
  'licence_lcb_exports',
  'lcb_procedures',
  'lcb_officers',
];

type Json = string | number | boolean | null;
type Row = Record<string, Json>;

/** Une pièce du coffre, dite par sa ligne [R664]. */
export interface PieceDossierLcb {
  id: string;
  storageRef: string;
  sha256: string;
  contentType: string;
  sizeBytes: number;
}

export interface DossierLcbAgence {
  format: typeof DOSSIER_LCB_FORMAT;
  licenceId: string;
  networkId: string;
  madeAt: string;
  /** Chaque table du traitement, avec toutes ses lignes du réseau de l'agence, même zéro. */
  tables: Record<string, Row[]>;
  horsFichier: string[];
  /** Chaque pièce du coffre de l'agence, triée par identifiant [R664]. */
  pieces: PieceDossierLcb[];
}

export type DossierLcbRefusal = { ok: false; rule: 'R16' | 'R601' | 'R662' | 'R663'; code: string };

const NAME = /^[a-z_][a-z0-9_]*$/;

/** L'ordre de lecture, vérifié contre le registre : chaque table du traitement, une seule fois [R662]. */
export function ordreLcb(): string[] {
  const registered = tablesLcbFt();
  const order = [...ORDRE_LCB];
  if (new Set(order).size !== order.length) throw new Error('dossier lcb : une table deux fois dans l’ordre');
  const a = [...order].sort();
  const b = [...registered].sort();
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error('dossier lcb : l’ordre ne couvre pas le traitement du registre');
  for (const t of order) if (!NAME.test(t)) throw new Error(`dossier lcb : nom ${t}`);
  return order;
}

/** La condition SQL qui choisit, dans une table du traitement, les lignes d'un réseau [R662]. */
export function filtreLcb(table: string, networkId: string): { sql: string; params: string[] } {
  const path = CHEMINS_LCB[table];
  if (path === undefined) return { sql: 'network_id = ?', params: [networkId] };
  const [col, from, key] = path;
  if (![col, from, key].every((n) => NAME.test(n)) || CHEMINS_LCB[from] !== undefined) throw new Error(`dossier lcb : chemin de ${table}`);
  return { sql: `${col} IN (SELECT ${key} FROM ${from} WHERE network_id = ?)`, params: [networkId] };
}

/** La liste des pièces du coffre, tirée des lignes du dossier seules [R664]. */
export function piecesDe(tables: unknown): PieceDossierLcb[] {
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) return [];
  const rows = (tables as Record<string, unknown>).compliance_vault_pieces;
  if (!Array.isArray(rows)) return [];
  const out: PieceDossierLcb[] = [];
  for (const r of rows) {
    if (r === null || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    out.push({ id: String(x.id), storageRef: String(x.storage_ref), sha256: String(x.sha256), contentType: String(x.content_type), sizeBytes: Number(x.size_bytes) });
  }
  return out.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

export class DossierLcbAgences {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    /** Le dossier est une action sensible : la preuve d'une clé d'appareil active, pour lui seul [R601]. */
    private readonly secondFactor: SecondFactorGate,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, rule: DossierLcbRefusal['rule'], code: string): Promise<DossierLcbRefusal> {
    // Une sorte `conformite.` : jamais dans la réponse à une demande d'accès d'une personne (carte des accès).
    await appendEvent(
      this.journal,
      { type: 'conformite.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule, kind: 'dossier_lcb_agence', role: String(viewer.role), code } },
      this.now,
    );
    return { ok: false, rule, code };
  }

  private async licenceOf(viewer: Viewer): Promise<string | null> {
    const l = await this.db.first<{ id: string }>('SELECT id FROM software_licences WHERE licensee_network_id = ?', [viewer.networkId]);
    return l?.id ?? null;
  }

  /**
   * La licence de l'agence, pour que son responsable de la conformité fasse la preuve de sa clé pour `licence_lcb:<id>`
   * avant de tirer le dossier (BR114). Rien d'autre n'est dit ; un autre rôle, ou le réseau qui donne les licences,
   * sont refusés comme au tirage [R16, R662].
   */
  async licence(viewer: Viewer): Promise<{ ok: true; value: { licenceId: string } } | DossierLcbRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'R16', 'role');
    const licenceId = await this.licenceOf(viewer);
    if (licenceId === null) return this.refuse(viewer, 'R662', 'pas_de_licence');
    return { ok: true, value: { licenceId } };
  }

  /**
   * Tire le dossier complet de l'agence sous licence, pour son responsable de la conformité seul, sur la preuve du
   * second facteur ; range son empreinte, rien d'autre [R662, R663, R664, R601].
   */
  async make(viewer: Viewer, stepUpId?: unknown): Promise<{ ok: true; value: { document: DossierLcbAgence; fingerprint: string } } | DossierLcbRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'R16', 'role');
    const licenceId = await this.licenceOf(viewer);
    // Le réseau qui donne les licences garde son dossier chez lui : seule l'agence sous licence le reprend [R662].
    if (licenceId === null) return this.refuse(viewer, 'R662', 'pas_de_licence');
    // Le dossier porte les signalements : seul le responsable nommé, le dernier, le tire (AU089) [R94].
    const gate = await new DispositifLcb(this.db, this.journal, { now: this.now }).officerGate(viewer, false);
    if (gate !== null) return this.refuse(viewer, 'R16', gate);
    // Avant toute lecture : sans preuve pour ce dossier, rien n'est lu (la porte écrit son refus au journal) [R601].
    const proof = await this.secondFactor.requireSecondFactor(viewer, 'export_complet', `licence_lcb:${licenceId}`, stepUpId);
    if (!proof.ok) return { ok: false, rule: 'R601', code: proof.code };
    const net = viewer.networkId;
    const document: DossierLcbAgence = { format: DOSSIER_LCB_FORMAT, licenceId, networkId: net, madeAt: this.now().toISOString(), tables: {}, horsFichier: [...DOSSIER_LCB_HORS_FICHIER], pieces: [] };
    const read: Record<string, Row[]> = {};
    for (const table of ordreLcb()) {
      const where = filtreLcb(table, net);
      const found = await this.db.all<Row>(`SELECT * FROM ${table} WHERE ${where.sql}`, where.params);
      const clean = found.map((r) => {
        const out: Row = { ...r };
        // Un lien qui porte un jeton ouvrirait un lien ou une séance : masqué, comme au fichier de reprise.
        for (const [c, v] of Object.entries(out)) if (typeof v === 'string') out[c] = masquerTexte(v);
        return out;
      });
      read[table] = clean.map((r) => [canonicalJson(r), r] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, r]) => r);
    }
    // Les tables du dossier se rangent par nom, quel que soit l'ordre de lecture.
    for (const t of Object.keys(read).sort()) document.tables[t] = read[t]!;
    document.pieces = piecesDe(document.tables);
    const fingerprint = await fingerprintOf(document);
    try {
      await this.db.run('INSERT INTO licence_lcb_exports (id, licence_id, network_id, fingerprint, made_by, made_at) VALUES (?, ?, ?, ?, ?, ?)', [
        this.newId(),
        licenceId,
        net,
        fingerprint,
        this.actor(viewer),
        document.madeAt,
      ]);
    } catch {
      // Le même dossier déjà remis (même base, même instant) : son empreinte est déjà rangée.
      const known = await this.db.first('SELECT 1 AS one FROM licence_lcb_exports WHERE network_id = ? AND fingerprint = ?', [net, fingerprint]);
      if (known === null) return this.refuse(viewer, 'R663', 'conflit');
    }
    // Au journal : l'empreinte seule, ni le contenu ni aucun compte [R663, R13].
    await appendEvent(this.journal, { type: 'conformite.dossier_lcb_remis', actor: this.actor(viewer), subject: `licence:${licenceId}`, data: { rule: 'R663', fingerprint } }, this.now);
    return { ok: true, value: { document, fingerprint } };
  }

  /**
   * Vérifie un dossier, pour le responsable de la conformité de cette agence seul : son empreinte recalculée doit être
   * celle qu'AIMMO a rangée en le lui remettant ; il dit s'il couvre chaque table du traitement d'aujourd'hui, et si sa
   * liste des pièces est celle que ses lignes donnent. Rien du contenu n'est rendu ni gardé [R664, R662].
   */
  async verify(
    viewer: Viewer,
    document: unknown,
  ): Promise<{ ok: true; value: { verified: boolean; fingerprint: string | null; complete: boolean; missing: string[]; piecesComplete: boolean } } | DossierLcbRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'R16', 'role');
    const none = { verified: false, fingerprint: null, complete: false, missing: [], piecesComplete: false };
    const d = document !== null && typeof document === 'object' ? (document as { format?: unknown; licenceId?: unknown; networkId?: unknown; tables?: unknown; pieces?: unknown }) : null;
    // Un dossier d'un autre réseau ne se vérifie pas ici : rien n'en est dit, pas même s'il existe [R662].
    if (d === null || d.format !== DOSSIER_LCB_FORMAT || d.networkId !== viewer.networkId) return { ok: true, value: none };
    let fingerprint: string;
    try {
      fingerprint = await fingerprintOf(document);
    } catch {
      return { ok: true, value: none };
    }
    const row = await this.db.first('SELECT 1 AS one FROM licence_lcb_exports WHERE licence_id = ? AND network_id = ? AND fingerprint = ?', [String(d.licenceId), viewer.networkId, fingerprint]);
    const tables = d.tables !== null && typeof d.tables === 'object' && !Array.isArray(d.tables) ? Object.keys(d.tables) : [];
    const missing = tablesLcbFt().filter((t) => !tables.includes(t)).sort();
    const piecesComplete = Array.isArray(d.pieces) && canonicalJson(piecesDe(d.tables)) === canonicalJson(d.pieces);
    return { ok: true, value: { verified: row !== null, fingerprint, complete: missing.length === 0, missing, piecesComplete } };
  }
}
