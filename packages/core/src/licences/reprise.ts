/**
 * La reprise des données de l'agence sous licence : tout, table par table, rien d'oublié (HX74 ; Feuille de route,
 * phase 5, « licence du logiciel aux agences hors réseau » ; Offre aux agents, « Licence du logiciel ») [R658, R659,
 * R657, R16, R601].
 *
 * Décidé, lecture prudente :
 *   - la direction de l'agence sous licence tire à tout moment le fichier complet de son réseau : licence active,
 *     suspendue ou terminée. Aucun prix, aucun délai, aucune condition pour reprendre ses données [R659] ;
 *   - sur la preuve d'un second facteur, pour ce fichier seul (`export_complet`, HX56) [R601] ;
 *   - le fichier suit la carte de reprise (`carte-reprise.ts`) : chaque table de la base y est, avec ses lignes ou la
 *     raison de la laisser ; rien du réseau qui donne la licence ni d'une autre agence n'y entre [R658, R657] ;
 *   - les jetons, codes et empreintes de clés sont masqués : ils ouvriraient un lien ou une séance [R659] ;
 *   - AIMMO range l'empreinte et les comptes du fichier, jamais son contenu ; la base refuse de ranger un fichier pour
 *     un autre réseau que celui de l'agence. Le fichier se vérifie ensuite, un octet changé et il ne l'est plus [R659] ;
 *   - les fichiers déposés (photos, pièces) et le journal commun ne sont pas dans le fichier, et le fichier le dit.
 *
 * Jamais vu : le fichier prouve lui-même qu'aucune table n'a été oubliée. Il porte, pour chaque table de la base, ses
 * lignes ou sa raison d'être laissée, et la vérification dit s'il couvre toute la carte d'aujourd'hui.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { LCB_FT_TRAITEMENT } from '../conformite/carte-acces.ts';
import { REGISTRE_TRAITEMENTS } from '../conformite/registre-traitements.ts';
import { canonicalJson, fingerprintOf, type SecondFactorGate } from '../rapports/export-agent.ts';
import { CARTE_REPRISE_AUTRES, COLONNES_MASQUEES, TABLES_RESEAU, type CheminReprise, type EntreeReprise, type HorsReprise } from './carte-reprise.ts';

export const REPRISE_FORMAT = 'aimmo-reprise-agence/1';
/** Ce qui remplace un secret masqué. */
export const REPRISE_MASQUE = '(masqué)';
/** Ce que le fichier ne porte pas, dit dans le fichier même. */
export const REPRISE_HORS_FICHIER = [
  'Les fichiers déposés (photos, plans, pièces) : le fichier porte leurs références et leurs empreintes, pas leur contenu.',
  'Le journal commun à toute la base, chaîné ligne à ligne : il ne se découpe pas par réseau.',
  'Le dossier de la lutte contre le blanchiment (coffre, vigilance, signalement, gel des avoirs) : il ne se lit que par la conformité, et se remet à part.',
] as const;

/** Pourquoi les tables de la lutte contre le blanchiment sont laissées [R15, R93, R94, R604]. */
export const REPRISE_LCB_FT = 'Lutte contre le blanchiment : ne se lit que par le code de la conformité, et se remet à part, par la conformité.';

/** Les tables de la lutte contre le blanchiment, prises au registre des traitements sans être nommées dans ce code. */
export function tablesLcbFt(): string[] {
  const t = REGISTRE_TRAITEMENTS.find((x) => x.id === LCB_FT_TRAITEMENT);
  if (t === undefined) throw new Error('carte de reprise : traitement de la lutte contre le blanchiment absent du registre');
  return Object.keys(t.tables);
}

type Json = string | number | boolean | null;
type Row = Record<string, Json>;

export interface RepriseAgence {
  format: typeof REPRISE_FORMAT;
  licenceId: string;
  networkId: string;
  madeAt: string;
  /** Chaque table reprise, avec toutes ses lignes du réseau de l'agence, même zéro. */
  tables: Record<string, Row[]>;
  /** Chaque table laissée, avec sa raison. */
  laissees: Record<string, { hors: HorsReprise; why: string }>;
  /** Les colonnes masquées, table par table. */
  masquees: Record<string, string[]>;
  horsFichier: string[];
}

export type RepriseRefusal = { ok: false; rule: 'R16' | 'R601' | 'R657' | 'R659'; code: string };

const NAME = /^[a-z_][a-z0-9_]*$/;

/** Toute la carte : les tables `network_id`, puis les autres, chacune une seule fois. */
export function carteReprise(): Map<string, EntreeReprise | 'reseau'> {
  const carte = new Map<string, EntreeReprise | 'reseau'>();
  for (const t of TABLES_RESEAU) carte.set(t, 'reseau');
  for (const [t, e] of Object.entries(CARTE_REPRISE_AUTRES)) {
    if (carte.has(t)) throw new Error(`carte de reprise : ${t} deux fois`);
    carte.set(t, e);
  }
  for (const t of tablesLcbFt()) {
    if (carte.has(t)) throw new Error(`carte de reprise : ${t} deux fois`);
    carte.set(t, { hors: 'lcb_ft', why: REPRISE_LCB_FT });
  }
  for (const t of carte.keys()) if (!NAME.test(t)) throw new Error(`carte de reprise : nom ${t}`);
  return carte;
}

const list = (v: string | readonly string[]): readonly string[] => (typeof v === 'string' ? [v] : v);

/**
 * La condition SQL qui choisit, dans une table, les lignes d'un réseau, avec ses paramètres. Une table `via` suit
 * chacun de ses chemins, l'un ou l'autre suffit ; une clé de plusieurs colonnes est comparée entière [R658].
 */
export function filtreReprise(carte: Map<string, EntreeReprise | 'reseau'>, table: string, networkId: string, depth = 0): { sql: string; params: string[] } {
  if (depth > 8) throw new Error(`carte de reprise : chemin trop long depuis ${table}`);
  const entry = carte.get(table);
  if (entry === undefined) throw new Error(`carte de reprise : ${table} absente`);
  if (entry === 'reseau') return { sql: 'network_id = ?', params: [networkId] };
  if ('soi' in entry) return { sql: `${entry.soi} = ?`, params: [networkId] };
  if ('hors' in entry) throw new Error(`carte de reprise : ${table} est laissée`);
  const parts: string[] = [];
  const params: string[] = [];
  for (const [cols, from, keys] of entry.via as readonly CheminReprise[]) {
    const c = list(cols);
    const k = list(keys);
    if (c.length !== k.length || c.length === 0 || ![...c, ...k, from].every((n) => NAME.test(n))) throw new Error(`carte de reprise : chemin de ${table}`);
    const inner = filtreReprise(carte, from, networkId, depth + 1);
    const left = c.length === 1 ? c[0] : `(${c.join(', ')})`;
    parts.push(`${left} IN (SELECT ${k.join(', ')} FROM ${from} WHERE ${inner.sql})`);
    params.push(...inner.params);
  }
  return { sql: parts.map((p) => `(${p})`).join(' OR '), params };
}

export class RepriseDonneesAgence {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    /** Le fichier complet est une action sensible : la preuve d'une clé d'appareil active, pour lui seul [R601]. */
    private readonly secondFactor: SecondFactorGate,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, rule: RepriseRefusal['rule'], code: string): Promise<RepriseRefusal> {
    const type = rule === 'R16' ? 'acces.refuse' : 'licences.refuse';
    await appendEvent(
      this.journal,
      { type, actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule, kind: 'licence_reprise', role: String(viewer.role), code } },
      this.now,
    );
    return { ok: false, rule, code };
  }

  /**
   * Tire le fichier complet du réseau de l'agence sous licence, pour sa direction seule, sur la preuve du second
   * facteur ; range son empreinte et ses comptes [R658, R659, R657, R601].
   */
  async make(viewer: Viewer, stepUpId?: unknown): Promise<{ ok: true; value: { document: RepriseAgence; fingerprint: string; rows: number } } | RepriseRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    const licence = await this.db.first<{ id: string }>('SELECT id FROM software_licences WHERE licensee_network_id = ?', [viewer.networkId]);
    // Le réseau qui donne les licences n'a pas de fichier de reprise : seule l'agence reprend ses données [R657].
    if (licence === null) return this.refuse(viewer, 'R657', 'pas_de_licence');
    // Avant toute lecture : sans preuve pour ce fichier, rien n'est lu (la porte écrit son refus au journal) [R601].
    const proof = await this.secondFactor.requireSecondFactor(viewer, 'export_complet', `licence:${licence.id}`, stepUpId);
    if (!proof.ok) return { ok: false, rule: 'R601', code: proof.code };
    const net = viewer.networkId;
    const carte = carteReprise();
    const document: RepriseAgence = { format: REPRISE_FORMAT, licenceId: licence.id, networkId: net, madeAt: this.now().toISOString(), tables: {}, laissees: {}, masquees: {}, horsFichier: [...REPRISE_HORS_FICHIER] };
    let rows = 0;
    for (const table of [...carte.keys()].sort()) {
      const entry = carte.get(table)!;
      if (entry !== 'reseau' && 'hors' in entry) {
        document.laissees[table] = { hors: entry.hors, why: entry.why };
        continue;
      }
      const where = filtreReprise(carte, table, net);
      const found = await this.db.all<Row>(`SELECT * FROM ${table} WHERE ${where.sql}`, where.params);
      const masked = COLONNES_MASQUEES[table] ?? [];
      if (masked.length > 0) document.masquees[table] = [...masked];
      const clean = found.map((r) => {
        const out: Row = { ...r };
        for (const c of masked) if (out[c] !== null && out[c] !== undefined) out[c] = REPRISE_MASQUE;
        return out;
      });
      // Un ordre qui ne dépend que des lignes : la même base donne le même fichier.
      document.tables[table] = clean.map((r) => [canonicalJson(r), r] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, r]) => r);
      rows += clean.length;
    }
    const fingerprint = await fingerprintOf(document);
    const tablesCount = Object.keys(document.tables).length;
    try {
      await this.db.run('INSERT INTO licence_data_exports (id, licence_id, network_id, fingerprint, tables_count, rows_count, made_by, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        this.newId(),
        licence.id,
        net,
        fingerprint,
        tablesCount,
        rows,
        this.actor(viewer),
        document.madeAt,
      ]);
    } catch {
      // Le même fichier déjà remis (même base, même instant) : son empreinte est déjà rangée.
      const known = await this.db.first('SELECT 1 AS one FROM licence_data_exports WHERE network_id = ? AND fingerprint = ?', [net, fingerprint]);
      if (known === null) return this.refuse(viewer, 'R659', 'conflit');
    }
    // Au journal : l'empreinte et les comptes, jamais le contenu [R13].
    await appendEvent(this.journal, { type: 'licences.reprise', actor: this.actor(viewer), subject: `licence:${licence.id}`, data: { rule: 'R659', fingerprint, tables: tablesCount, rows } }, this.now);
    return { ok: true, value: { document, fingerprint, rows } };
  }

  /**
   * Vérifie un fichier de reprise : son empreinte recalculée doit être celle qu'AIMMO a rangée en le remettant à cette
   * agence, et il dit s'il couvre chaque table de la carte d'aujourd'hui. Rien du contenu n'est rendu ni gardé [R659,
   * R658].
   */
  async verify(document: unknown): Promise<{ verified: boolean; fingerprint: string | null; complete: boolean; missing: string[] }> {
    const none = { verified: false, fingerprint: null, complete: false, missing: [] };
    if (document === null || typeof document !== 'object' || (document as { format?: unknown }).format !== REPRISE_FORMAT) return none;
    let fingerprint: string;
    try {
      fingerprint = await fingerprintOf(document);
    } catch {
      return none;
    }
    const d = document as { licenceId?: unknown; networkId?: unknown; tables?: unknown; laissees?: unknown };
    const row = await this.db.first('SELECT 1 AS one FROM licence_data_exports WHERE licence_id = ? AND network_id = ? AND fingerprint = ?', [String(d.licenceId), String(d.networkId), fingerprint]);
    const keys = (v: unknown): string[] => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);
    const covered = new Set([...keys(d.tables), ...keys(d.laissees)]);
    const missing = [...carteReprise().keys()].filter((t) => !covered.has(t)).sort();
    return { verified: row !== null, fingerprint, complete: missing.length === 0, missing };
  }
}
