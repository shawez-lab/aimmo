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
 *   - les jetons, codes et empreintes de clés sont masqués, et dans chaque texte les liens qui portent un jeton : ils
 *     ouvriraient un lien ou une séance [R659] ;
 *   - le fichier se lit sur la base qui vit, chaque table avant celles qu'elle désigne : une ligne écrite pendant la
 *     lecture n'y entre qu'avec ce qu'elle désigne [R658] ;
 *   - AIMMO range l'empreinte et les comptes du fichier, jamais son contenu ; la base refuse de ranger un fichier pour
 *     un autre réseau que celui de l'agence. Le fichier se vérifie ensuite, un octet changé et il ne l'est plus [R659] ;
 *   - les fichiers déposés (photos, pièces) et le journal commun ne sont pas dans le fichier, et le fichier le dit ;
 *   - le fichier dit chaque fichier déposé de l'agence : la liste `fichiers` porte chaque référence d'une colonne
 *     `fichier` ou `preuve` de la carte des fichiers, avec sa table, sa colonne et sa ligne (HX75) [R660, R661].
 *
 * Jamais vu : le fichier prouve lui-même qu'aucune table n'a été oubliée. Il porte, pour chaque table de la base, ses
 * lignes ou sa raison d'être laissée, et la vérification dit s'il couvre toute la carte d'aujourd'hui. Elle recalcule
 * aussi la liste des fichiers déposés depuis les lignes du fichier même, et dit si elle est complète (HX75).
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { LCB_FT_TRAITEMENT } from '../conformite/carte-acces.ts';
import { REGISTRE_TRAITEMENTS } from '../conformite/registre-traitements.ts';
import { canonicalJson, fingerprintOf, type SecondFactorGate } from '../rapports/export-agent.ts';
import { FICHIERS_JSON, cleLigne, colonnesFichiers, type SorteReference } from './carte-fichiers.ts';
import { CARTE_REPRISE_AUTRES, COLONNES_MASQUEES, ORDRE_REPRISE, TABLES_RESEAU, type CheminReprise, type EntreeReprise, type HorsReprise } from './carte-reprise.ts';

export const REPRISE_FORMAT = 'aimmo-reprise-agence/2';
/** Le format d'avant HX75, sans la liste des fichiers : un tel fichier reste vérifiable [R661]. */
export const REPRISE_FORMAT_1 = 'aimmo-reprise-agence/1';
/** Ce qui remplace un secret masqué. */
export const REPRISE_MASQUE = '(masqué)';
/** Ce qui remplace, dans un texte, un lien qui porte un jeton (un lien de rappel, de désinscription, d'espace). */
export const REPRISE_LIEN_MASQUE = '(lien masqué)';
// Un lien : son origine (`https://hôte`), puis son chemin, ses paramètres et son ancre. Ni guillemet, ni espace, ni
// barre oblique inverse : un lien écrit dans un JSON s'arrête avant l'échappement de son guillemet.
const LINK = /\bhttps?:\/\/[^\s"'<>\\/?#]*([^\s"'<>\\]*)/gi;
// Un jeton : une suite d'au moins 16 caractères d'un jeton, cherchée dans le chemin et les paramètres seulement, jamais
// dans le nom d'hôte.
const TOKEN = /[A-Za-z0-9_-]{16,}/;

/** Masque, dans un texte, chaque lien dont le chemin ou les paramètres portent un jeton [R659]. */
export function masquerLiens(text: string): string {
  return text.replace(LINK, (link: string, rest: string) => (TOKEN.test(rest) ? REPRISE_LIEN_MASQUE : link));
}

function maskDeep(value: unknown): unknown {
  if (typeof value === 'string') return masquerLiens(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)]));
  return value;
}

/**
 * Masque une valeur texte d'une ligne. Un JSON (objet ou tableau) est masqué chaîne par chaîne puis réécrit, pour rester
 * un JSON lisible ; il n'est réécrit que si un lien a été masqué [R659, R658].
 */
export function masquerTexte(text: string): string {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return masquerLiens(text);
    }
    const masked = maskDeep(parsed);
    const out = JSON.stringify(masked);
    return out === JSON.stringify(parsed) ? text : out;
  }
  return masquerLiens(text);
}
/** Ce que le fichier ne porte pas, dit dans le fichier même. */
export const REPRISE_HORS_FICHIER = [
  'Les fichiers déposés (photos, plans, pièces, vidéos, enregistrements) : leur contenu n’est pas dans le fichier ; la liste « fichiers » dit chacun, avec la table, la colonne et la ligne qui le citent.',
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
  /** Chaque fichier déposé de l'agence cité par une ligne du fichier, trié [R661]. */
  fichiers: FichierRepris[];
}

/** Un fichier déposé, dit par la ligne qui le cite [R661]. */
export interface FichierRepris {
  table: string;
  colonne: string;
  /** La clé de la ligne qui le cite : sa clé primaire, colonne par colonne. */
  ligne: Record<string, string | number | null>;
  sorte: SorteReference;
  /** La référence, masquée comme dans la ligne [R659]. */
  ref: string;
}

/**
 * La liste des fichiers déposés cités par des lignes : chaque valeur non vide d'une colonne `fichier` ou `preuve` de la
 * carte des fichiers, dans un ordre qui ne dépend que des lignes [R661].
 */
export function fichiersDe(tables: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>): FichierRepris[] {
  const out: FichierRepris[] = [];
  for (const table of Object.keys(tables).sort()) {
    const cols = colonnesFichiers(table);
    const json = FICHIERS_JSON[table];
    if (cols.length === 0 && json === undefined) continue;
    const rows = tables[table];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const ligne: Record<string, string | number | null> = {};
      for (const c of cleLigne(table)) {
        const v = row[c];
        ligne[c] = typeof v === 'string' || typeof v === 'number' ? v : null;
      }
      for (const { colonne, sorte } of cols) {
        const v = row[colonne];
        if (typeof v !== 'string' || v.trim() === '') continue;
        out.push({ table, colonne, ligne, sorte, ref: v });
      }
      // Une liste de références dans une colonne JSON (les photos et vidéos de la fiche du bien) ; dite `data.media[].ref`.
      if (json !== undefined) {
        const raw = row[json.colonne];
        let parsed: unknown = null;
        try {
          parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }
        const items = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)[json.liste] : null;
        if (Array.isArray(items)) {
          for (const item of items) {
            const v = item !== null && typeof item === 'object' ? (item as Record<string, unknown>)[json.champ] : null;
            if (typeof v === 'string' && v.trim() !== '') out.push({ table, colonne: `${json.colonne}.${json.liste}[].${json.champ}`, ligne, sorte: json.sorte, ref: v });
          }
        }
      }
    }
  }
  // Trié par table, colonne, ligne, puis référence.
  const k = (f: FichierRepris) => canonicalJson([f.table, f.colonne, f.ligne, f.ref]);
  return out.map((f) => [k(f), f] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, f]) => f);
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
    const document: RepriseAgence = { format: REPRISE_FORMAT, licenceId: licence.id, networkId: net, madeAt: this.now().toISOString(), tables: {}, laissees: {}, masquees: {}, horsFichier: [...REPRISE_HORS_FICHIER], fichiers: [] };
    let rows = 0;
    // Les tables du fichier se rangent par nom, quel que soit l'ordre de lecture.
    for (const [table, entry] of carte) if (entry !== 'reseau' && 'hors' in entry) document.laissees[table] = { hors: entry.hors, why: entry.why };
    // Les tables reprises, chacune avant celles qu'elle désigne : une ligne ajoutée pendant la lecture n'entre qu'avec ce
    // qu'elle désigne [R658].
    const order = ORDRE_REPRISE.filter((t) => carte.has(t) && !(t in document.laissees));
    if (order.length + Object.keys(document.laissees).length !== carte.size) throw new Error('carte de reprise : ordre de lecture incomplet');
    for (const table of order) {
      const where = filtreReprise(carte, table, net);
      const found = await this.db.all<Row>(`SELECT * FROM ${table} WHERE ${where.sql}`, where.params);
      const masked = COLONNES_MASQUEES[table] ?? [];
      if (masked.length > 0) document.masquees[table] = [...masked];
      const clean = found.map((r) => {
        const out: Row = { ...r };
        for (const [c, v] of Object.entries(out)) if (typeof v === 'string') out[c] = masquerTexte(v);
        for (const c of masked) if (out[c] !== null && out[c] !== undefined) out[c] = REPRISE_MASQUE;
        return out;
      });
      // Un ordre qui ne dépend que des lignes : la même base donne le même fichier.
      document.tables[table] = clean.map((r) => [canonicalJson(r), r] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, r]) => r);
      rows += clean.length;
    }
    // Les fichiers déposés, tirés des lignes masquées du fichier : la liste ne porte rien que les lignes ne portent [R661].
    document.fichiers = fichiersDe(document.tables);
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
    await appendEvent(this.journal, { type: 'licences.reprise', actor: this.actor(viewer), subject: `licence:${licence.id}`, data: { rule: 'R659', fingerprint, tables: tablesCount, rows, files: document.fichiers.length } }, this.now);
    return { ok: true, value: { document, fingerprint, rows } };
  }

  /**
   * Vérifie un fichier de reprise : son empreinte recalculée doit être celle qu'AIMMO a rangée en le remettant à cette
   * agence, et il dit s'il couvre chaque table de la carte d'aujourd'hui. Pour un fichier `/2`, la liste des fichiers
   * déposés est recalculée depuis ses lignes avec la carte des fichiers d'aujourd'hui : `filesComplete` dit si elle
   * concorde, `filesMissing` compte les fichiers qu'elle ne dit pas, `filesExtra` ceux qu'elle dit en trop ; un fichier
   * `/1` n'a pas de liste, `filesComplete` y vaut `false`. Rien du contenu n'est rendu ni gardé [R659, R658, R661].
   */
  async verify(document: unknown): Promise<{ verified: boolean; fingerprint: string | null; complete: boolean; missing: string[]; filesComplete: boolean; filesMissing: number; filesExtra: number }> {
    const none = { verified: false, fingerprint: null, complete: false, missing: [], filesComplete: false, filesMissing: 0, filesExtra: 0 };
    const format = document !== null && typeof document === 'object' ? (document as { format?: unknown }).format : undefined;
    if (format !== REPRISE_FORMAT && format !== REPRISE_FORMAT_1) return none;
    let fingerprint: string;
    try {
      fingerprint = await fingerprintOf(document);
    } catch {
      return none;
    }
    const d = document as { licenceId?: unknown; networkId?: unknown; tables?: unknown; laissees?: unknown; fichiers?: unknown };
    const row = await this.db.first('SELECT 1 AS one FROM licence_data_exports WHERE licence_id = ? AND network_id = ? AND fingerprint = ?', [String(d.licenceId), String(d.networkId), fingerprint]);
    const keys = (v: unknown): string[] => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);
    const covered = new Set([...keys(d.tables), ...keys(d.laissees)]);
    const missing = [...carteReprise().keys()].filter((t) => !covered.has(t)).sort();
    const files = format === REPRISE_FORMAT ? compareFichiers(d.tables, d.fichiers) : { complete: false, missing: 0, extra: 0 };
    return { verified: row !== null, fingerprint, complete: missing.length === 0, missing, filesComplete: files.complete, filesMissing: files.missing, filesExtra: files.extra };
  }
}

/** Compare la liste des fichiers d'un fichier de reprise à celle que ses lignes donnent aujourd'hui [R661]. */
function compareFichiers(tables: unknown, fichiers: unknown): { complete: boolean; missing: number; extra: number } {
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables) || !Array.isArray(fichiers)) return { complete: false, missing: 0, extra: 0 };
  const count = (list: readonly unknown[]) => {
    const m = new Map<string, number>();
    for (const f of list) {
      const k = canonicalJson(f);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const expected = count(fichiersDe(tables as Record<string, Record<string, unknown>[]>));
  const given = count(fichiers);
  let missing = 0;
  let extra = 0;
  for (const [k, n] of expected) missing += Math.max(0, n - (given.get(k) ?? 0));
  for (const [k, n] of given) extra += Math.max(0, n - (expected.get(k) ?? 0));
  return { complete: missing === 0 && extra === 0, missing, extra };
}
