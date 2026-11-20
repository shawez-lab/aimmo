/**
 * L'effacement réel d'une personne, sa preuve et sa note au registre des effacements (AU020) [R17, R96, R231].
 *
 * Jusqu'ici, une demande d'effacement ne donnait qu'un plan d'essai (`prepareErasure`) : rien ne savait effacer pour de
 * vrai. Ici, la procédure réelle : elle suit le même plan, efface ce qui n'est qu'à la personne, garde ce que la loi
 * oblige à garder, retire les fichiers que plus rien ne cite, et rend un reçu dont l'empreinte fait la preuve.
 *
 * Décidé, lecture prudente :
 * - le mode réel ne s'ouvre que par une valeur exacte, `reel` ; toute autre valeur, ou aucune, laisse l'essai (H29 : la
 *   procédure doit être validée par le responsable et l'avocat avant d'être allumée sur le Worker) ;
 * - l'effacement réel exige que le plan d'essai ait été préparé pour la demande : le responsable a vu ce qui part ;
 * - il est noté au registre des effacements AVANT d'effacer, une entrée par fiche réunie : un effacement non noté n'est
 *   pas fait [R231] ; si la note échoue, rien n'est effacé ; s'il échoue après la note, le refaire ne change rien de
 *   plus, et la restauration le refera ;
 * - seules les lignes `effacer` du plan partent ; `garder` (obligation légale, arrêt de la personne) et `examiner`
 *   (partagé avec une autre personne) restent, et le reçu dit pourquoi ; `empreinte` : les identifiants restent sous leur
 *   seule empreinte (AU020c), et l'arrêt de la personne est posé sur tous les canaux s'il ne l'était pas [R04] ;
 * - une ligne qu'une pièce gardée cite encore (la fiche citée par un mandat ou par la demande elle-même, le bien d'un
 *   mandat) ne peut pas partir, la base le refuse : ses colonnes nominatives listées dans `PSEUDONYMIZE` sont vidées,
 *   sinon elle est gardée et dite « citée » ; une ligne qu'une table en ajout seul refuse d'effacer est dite
 *   « restante », et l'effacement n'est pas dit complet ;
 * - un fichier n'est retiré que si plus aucune ligne de la base ne le cite, jamais dans le coffre de la lutte contre le
 *   blanchiment (gardé 5 ans) ; un fichier dont le stockage n'est pas connu par le début de sa clé est dit restant ;
 * - le reçu ne porte aucun nom, aucune coordonnée, aucun identifiant de ligne : des tables, des nombres, des raisons.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase, SqlValue } from '../db/sql.ts';
import { contactKeyHash, identifierHash, isHashedIdentifier } from '../fiche/empreinte.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { normalizeIdentifier } from '../fiche/normalize.ts';
import type { IdentifierKind } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { CopyKey } from '../sauvegarde/copie.ts';
import { recordErasure, type ErasureEntry, type ErasureLedgerStore, type PersonEraser } from '../sauvegarde/effacements.ts';
import { fileReferences, REFERENCE_PREFIXES, rowReferences, type ObjectStorage } from '../sauvegarde/objets.ts';
import { accessOrder, CARTE_ACCES, type AccessMapEntry } from './carte-acces.ts';
import { assembleAccessDetail, erasurePlan, sha256Of, type ErasurePlan, type PersonRequestRefusal } from './demandes-personnes.ts';
import type { Traitement } from './registre.ts';
import { REGISTRE_TRAITEMENTS } from './registre-traitements.ts';

export type ErasureMode = 'essai' | 'reel';

/** Le mode lu dans la configuration du Worker : `reel` seulement s'il est écrit tel quel. */
export function erasureModeOf(value: unknown): ErasureMode {
  return value === 'reel' ? 'reel' : 'essai';
}

/** Les colonnes vidées d'une ligne qui ne peut pas partir parce qu'une pièce gardée la cite. */
export const PSEUDONYMIZE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  persons: ['first_name', 'last_name', 'last_contact_at'],
});

/** Le stockage d'objets, pour retirer un fichier ; sans effet si le fichier n'y est plus. */
export interface ObjectEraser {
  remove(storage: ObjectStorage, key: string): Promise<void>;
}

/** Ce que le reçu dit des identifiants gardés : sous leur seule empreinte, pour reconnaître la personne et tenir son arrêt [R04]. */
export const IDENTIFIERS_KEPT = 'Identifiants gardés sous leur seule empreinte, pour reconnaître la personne et respecter son arrêt [R04].';

/**
 * Les tables jamais effacées par la procédure : `person_merges` relie les fiches réunies, et l'arrêt posé sur l'une
 * ne vaut pour les autres que par ce lien [R04]. Gardées telles quelles, et dites « citées ».
 */
export const KEPT_LINKS: ReadonlySet<string> = new Set(['person_merges']);

/** Les tables qu'un déclencheur garde de tout effacement (`BEFORE DELETE … RAISE`) : leurs lignes resteront. */
async function guardedTables(db: SqlDatabase): Promise<Set<string>> {
  const rows = await db.all<{ tbl_name: string; sql: string | null }>("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger'");
  return new Set(rows.filter((r) => typeof r.sql === 'string' && /BEFORE\s+DELETE/i.test(r.sql) && /RAISE\s*\(\s*ABORT/i.test(r.sql)).map((r) => r.tbl_name));
}

/** Les tables par lesquelles la carte retrouve celles données, de proche en proche. */
function locatedThrough(carte: Readonly<Record<string, AccessMapEntry>>, tables: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tables];
  while (stack.length > 0) {
    const entry = carte[stack.pop()!];
    if (!entry || !('locate' in entry)) continue;
    for (const l of entry.locate as readonly unknown[]) {
      const from = l !== null && typeof l === 'object' && 'from' in l ? (l as { from: unknown }).from : null;
      if (typeof from === 'string' && !out.has(from)) {
        out.add(from);
        stack.push(from);
      }
    }
  }
  return out;
}

/** Le stockage jamais touché : le coffre de la lutte contre le blanchiment. */
const NEVER_ERASED: ReadonlySet<ObjectStorage> = new Set(['COFFRE']);

type Row = Readonly<Record<string, SqlValue>>;

export interface RealErasureCount {
  table: string;
  rows: number;
}

export interface RealErasureOutcome {
  /** Lignes supprimées, par table. */
  erased: RealErasureCount[];
  /** Lignes gardées parce qu'une pièce gardée les cite, leurs colonnes nominatives vidées. */
  pseudonymized: RealErasureCount[];
  /** Identifiants et clés de contact dont la valeur en clair a été remplacée par son empreinte (AU020c). */
  hashed: RealErasureCount[];
  /** Arrêts posés par l'effacement, sur une fiche qui n'en avait pas sur tous les canaux [R04]. */
  stopped: RealErasureCount[];
  /** Lignes gardées telles quelles parce qu'une pièce gardée ou une autre personne les cite (le bien d'un mandat). */
  cited: RealErasureCount[];
  /** Lignes à effacer qui sont encore là, ni supprimées ni vidées. */
  remaining: RealErasureCount[];
  /** Fichiers retirés, par stockage. */
  objectsRemoved: Partial<Record<ObjectStorage, number>>;
  /** Fichiers que la personne seule citait et qui n'ont pas pu être retirés. */
  objectsRemaining: number;
}

const count = (m: Map<string, number>): RealErasureCount[] => [...m].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([table, rows]) => ({ table, rows }));
const bump = (m: Map<string, number>, table: string, n = 1): void => {
  m.set(table, (m.get(table) ?? 0) + n);
};

/** La condition qui désigne exactement cette ligne, colonne par colonne, en SQL standard. */
function whereRow(row: Row): { sql: string; params: SqlValue[] } {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const column of Object.keys(row).sort()) {
    const v = row[column];
    if (v === null || v === undefined) parts.push(`"${column}" IS NULL`);
    else {
      parts.push(`"${column}" = ?`);
      params.push(v);
    }
  }
  return { sql: parts.join(' AND '), params };
}

/** Le seul effacement de ligne du code (R17) : la ligne lue, désignée colonne par colonne. */
async function deleteExact(db: SqlDatabase, p: { table: string; row: Row }): Promise<{ changes: number }> {
  const where = whereRow(p.row);
  return db.run(`DELETE FROM "${p.table}" WHERE ${where.sql}`, where.params);
}

const pseudonymized = (table: string, row: Row): boolean => (PSEUDONYMIZE[table] ?? []).length > 0 && PSEUDONYMIZE[table]!.every((c) => row[c] === null || row[c] === undefined);

/**
 * Efface, dans la base donnée, ce qui n'est qu'aux fiches données, en suivant le plan d'effacement. Sans effet de plus
 * si tout est déjà effacé : la restauration peut la rejouer.
 */
export async function eraseForReal(
  db: SqlDatabase,
  personIds: readonly string[],
  options: {
    carte?: Readonly<Record<string, AccessMapEntry>>;
    registre?: readonly Traitement[];
    objects?: ObjectEraser | null;
    /** La demande qui efface : ses fichiers à retirer sont notés avant d'effacer les lignes qui les citent. */
    target?: { requestId: string; networkId: string; at: string } | null;
  } = {},
): Promise<{ plan: ErasurePlan; outcome: RealErasureOutcome }> {
  const carte = options.carte ?? CARTE_ACCES;
  const registre = options.registre ?? REGISTRE_TRAITEMENTS;
  const detail = await assembleAccessDetail(db, personIds, { carte, registre });
  const plan = erasurePlan(detail, registre);
  const toErase = new Set(plan.lines.filter((l) => l.action === 'effacer').map((l) => l.table));
  // Les enfants avant leurs parents : l'ordre de la carte, à l'envers.
  const order = [...accessOrder(carte)].reverse().filter((t) => toErase.has(t));
  // Deux lignes en tout point pareilles partent par la même condition : une seule entrée, pour qu'un DELETE qui ne
  // touche rien veuille toujours dire « la ligne n'est plus celle lue », jamais « déjà partie avec sa jumelle ».
  const seen = new Set<string>();
  // Une ligne qui restera (table gardée par un déclencheur) doit rester retrouvable au prochain passage, et à la
  // restauration : les lignes par lesquelles la carte y mène ne partent pas tant qu'elle reste [R17, R231].
  const guarded = await guardedTables(db);
  const stuck = order.filter((t) => guarded.has(t) && (detail.exclusiveData?.[t] ?? []).length > 0);
  const holders = locatedThrough(carte, stuck);
  for (const t of KEPT_LINKS) holders.add(t);
  let pending: { table: string; row: Row; cited?: boolean }[] = order.flatMap((table) =>
    (detail.exclusiveData?.[table] ?? [])
      .filter((row) => !pseudonymized(table, row))
      .filter((row) => {
        const k = JSON.stringify([table, Object.keys(row).sort().map((c) => [c, typeof row[c] === 'object' && row[c] !== null ? String(row[c]) : row[c]])]);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((row) => ({ table, row })),
  );
  const cited = new Map<string, { storage: ObjectStorage; key: string }>();
  for (const p of pending) for (const ref of rowReferences(p.row)) cited.set(ref.key, ref);
  // Notés avant d'effacer : si le retrait échoue ou s'arrête, l'effacement refait les retrouve ici, alors que plus
  // aucune ligne ne les cite ; repris ensuite, ceux encore à retirer d'un effacement d'avant.
  const target = options.target ?? null;
  if (target) {
    for (const ref of cited.values()) {
      if (NEVER_ERASED.has(ref.storage)) continue;
      await db.run('INSERT INTO erasure_object_targets (request_id, network_id, storage, object_key, noted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [target.requestId, target.networkId, ref.storage, ref.key, target.at]);
    }
    const earlier = await db.all<{ storage: ObjectStorage; object_key: string }>('SELECT storage, object_key FROM erasure_object_targets WHERE request_id = ? AND removed_at IS NULL ORDER BY object_key', [target.requestId]);
    for (const e of earlier) if (!cited.has(e.object_key)) cited.set(e.object_key, { storage: e.storage, key: e.object_key });
  }

  const held = pending.filter((p) => holders.has(p.table)).map((p) => ({ ...p, cited: true }));
  pending = pending.filter((p) => !holders.has(p.table));
  const erased = new Map<string, number>();
  // Une ligne peut en citer une autre de la même liste : on repasse tant qu'une ligne part.
  for (let progress = true; progress && pending.length > 0; ) {
    progress = false;
    const next: typeof pending = [];
    for (const p of pending) {
      try {
        const { changes } = await deleteExact(db, p);
        if (changes === 0) {
          // La ligne lue n'est plus là telle quelle (changée entre-temps) : elle n'est pas dite partie [R17].
          next.push(p);
          continue;
        }
        bump(erased, p.table, changes);
        progress = true;
      } catch (error) {
        // Le message peut citer une valeur : il ne sort pas ; seule sa sorte est lue.
        next.push({ ...p, cited: /FOREIGN KEY/i.test(error instanceof Error ? error.message : String(error)) });
      }
    }
    pending = next;
  }
  const vidées = new Map<string, number>();
  const kept = new Map<string, number>();
  const remaining = new Map<string, number>();
  const stopped = new Map<string, number>();
  for (const p of [...pending, ...held]) {
    const columns = PSEUDONYMIZE[p.table] ?? [];
    // Citée ailleurs, sans colonne nominative à vider : gardée telle quelle, et dite.
    if (p.cited && columns.length === 0) {
      bump(kept, p.table);
      continue;
    }
    const where = whereRow(p.row);
    let done = false;
    if (columns.length > 0) {
      try {
        done = (await db.run(`UPDATE "${p.table}" SET ${columns.map((c) => `"${c}" = NULL`).join(', ')} WHERE ${where.sql}`, where.params)).changes > 0;
      } catch {
        done = false;
      }
    }
    bump(done ? vidées : remaining, p.table);
  }

  // Les identifiants ne restent que sous leur empreinte (AU020c) : la valeur en clair est remplacée, ligne par ligne.
  // Une valeur dont l'empreinte est déjà là (rangée sous empreinte après l'effacement) part : l'empreinte suffit.
  // Une ligne qui ne passe pas est dite restante [R04, R17].
  const hashed = new Map<string, number>();
  if (personIds.length > 0) {
    const ids = await db.all<{ id: string; network_id: string; person_id: string; kind: IdentifierKind; value: string } & Row>(
      `SELECT * FROM person_identifiers WHERE person_id IN (${personIds.map(() => '?').join(', ')}) ORDER BY id`,
      [...personIds],
    );
    for (const id of ids) {
      if (isHashedIdentifier(id.value)) continue;
      const print = await identifierHash(id.network_id, id.kind, normalizeIdentifier(id.kind, id.value) ?? id.value);
      try {
        const twin = await db.first('SELECT 1 AS x FROM person_identifiers WHERE person_id = ? AND kind = ? AND value = ?', [id.person_id, id.kind, print]);
        const { changes } = twin
          ? await deleteExact(db, { table: 'person_identifiers', row: id })
          : await db.run('UPDATE person_identifiers SET value = ? WHERE id = ? AND value = ?', [print, id.id, id.value]);
        bump(changes > 0 ? hashed : remaining, 'person_identifiers');
      } catch {
        bump(remaining, 'person_identifiers');
      }
    }
    // Les clés de contact aussi (identifiant chez Instagram, Messenger…) : seule une clé retrouve une personne qui écrit
    // en message privé sans adresse ni numéro [R04].
    const keys = await db.all<{ network_id: string; key: string; person_id: string } & Row>(
      `SELECT * FROM contact_keys WHERE person_id IN (${personIds.map(() => '?').join(', ')}) ORDER BY key`,
      [...personIds],
    );
    for (const k of keys) {
      if (isHashedIdentifier(k.key)) continue;
      const print = await contactKeyHash(k.network_id, k.key);
      try {
        const twin = await db.first('SELECT 1 AS x FROM contact_keys WHERE network_id = ? AND key = ?', [k.network_id, print]);
        const { changes } = twin
          ? await deleteExact(db, { table: 'contact_keys', row: k })
          : await db.run('UPDATE contact_keys SET key = ? WHERE network_id = ? AND key = ? AND person_id = ?', [print, k.network_id, k.key, k.person_id]);
        bump(changes > 0 ? hashed : remaining, 'contact_keys');
      } catch {
        bump(remaining, 'contact_keys');
      }
    }
    // L'arrêt de la personne tient sur tous les canaux : posé s'il ne l'est pas déjà, jamais levé ici [R04].
    for (const personId of personIds) {
      const person = await db.first<{ network_id: string; agent_id: string | null }>('SELECT network_id, agent_id FROM persons WHERE id = ?', [personId]);
      if (!person) continue;
      const active = await db.first("SELECT 1 AS x FROM exclusions WHERE person_id = ? AND channel IS NULL AND lifted_at IS NULL AND reason = 'stop'", [personId]);
      if (active) continue;
      const at = options.target?.at ?? new Date().toISOString();
      await db.run("INSERT INTO exclusions (id, network_id, agent_id, person_id, reason, channel, noted_at, lifted_at, created_at) VALUES (?, ?, ?, ?, 'stop', NULL, ?, NULL, ?)", [
        crypto.randomUUID(),
        person.network_id,
        person.agent_id,
        personId,
        at,
        at,
      ]);
      bump(stopped, 'exclusions');
    }
  }

  const objectsRemoved: Partial<Record<ObjectStorage, number>> = {};
  let objectsRemaining = 0;
  if (cited.size > 0) {
    const still = new Set((await fileReferences(db)).map((r) => r.key));
    for (const ref of [...cited.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      if (still.has(ref.key) || NEVER_ERASED.has(ref.storage)) continue;
      const known = Object.keys(REFERENCE_PREFIXES).some((p) => ref.key.startsWith(p));
      if (!known || !options.objects) {
        objectsRemaining += 1;
        continue;
      }
      try {
        await options.objects.remove(ref.storage, ref.key);
        objectsRemoved[ref.storage] = (objectsRemoved[ref.storage] ?? 0) + 1;
        if (target) await db.run('UPDATE erasure_object_targets SET removed_at = ? WHERE request_id = ? AND storage = ? AND object_key = ? AND removed_at IS NULL', [target.at, target.requestId, ref.storage, ref.key]);
      } catch {
        objectsRemaining += 1;
      }
    }
  }
  return { plan, outcome: { erased: count(erased), pseudonymized: count(vidées), hashed: count(hashed), stopped: count(stopped), cited: count(kept), remaining: count(remaining), objectsRemoved, objectsRemaining } };
}

/** L'effaceur réel, pour le rejeu du registre après une restauration : la fiche de l'entrée seule, sans viewer. */
export class SqlPersonEraser implements PersonEraser {
  constructor(private readonly options: { carte?: Readonly<Record<string, AccessMapEntry>>; registre?: readonly Traitement[]; objects?: ObjectEraser | null } = {}) {}

  async erase(db: SqlDatabase, entry: ErasureEntry): Promise<number> {
    // La personne entière telle qu'elle était à l'effacement, notée au registre : une ligne qui n'est qu'à elle peut citer
    // deux de ses fiches. Jamais les liens de la copie restaurée, qu'une fusion défaite depuis élargirait [R17, R231].
    const members = entry.members ?? [entry.personId];
    const { outcome } = await eraseForReal(db, members, { ...this.options, target: { requestId: entry.requestId, networkId: entry.networkId, at: entry.erasedAt } });
    // Un rejeu qui laisse ce qui devait partir n'est pas un rejeu : la restauration n'est pas dite finie [R231].
    if (outcome.remaining.length > 0 || outcome.objectsRemaining > 0) throw new Error('effacement incomplet');
    return [...outcome.erased, ...outcome.pseudonymized, ...outcome.hashed, ...outcome.stopped].reduce((n, c) => n + c.rows, 0);
  }
}

/** Le reçu de l'effacement réel : sa preuve, sans aucune donnée de la personne. */
export interface ErasureReceipt {
  format: 1;
  requestId: string;
  mode: 'reel';
  at: string;
  /** Le nombre de fiches réunies effacées, notées chacune au registre des effacements. */
  records: number;
  /** L'empreinte du plan d'effacement lu juste avant d'effacer. */
  planSha256: string;
  erased: RealErasureCount[];
  pseudonymized: RealErasureCount[];
  hashed: RealErasureCount[];
  stopped: RealErasureCount[];
  cited: RealErasureCount[];
  remaining: RealErasureCount[];
  objectsRemoved: Partial<Record<ObjectStorage, number>>;
  objectsRemaining: number;
  /** Ce qui reste, et pourquoi : obligation légale, arrêt de la personne, empreinte, partage. */
  kept: { table: string; action: 'garder' | 'empreinte' | 'examiner'; rows: number; why: string | null }[];
  alwaysKept: string[];
  /** Vrai seulement si rien de ce qui devait partir ne reste. */
  complete: boolean;
}

export type RealErasureRefusal = PersonRequestRefusal | { ok: false; rule: 'R17' | 'R231'; code: string };

interface RequestRow {
  id: string;
  network_id: string;
  person_id: string;
  kind: string;
}

/** La procédure réelle d'une demande d'effacement, par le responsable de la conformité seul. */
export class EffacementReel {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiche: FicheUnique,
    private readonly options: {
      mode: ErasureMode;
      ledger: { store: ErasureLedgerStore; key: CopyKey } | null;
      objects: ObjectEraser | null;
      now?: () => Date;
      carte?: Readonly<Record<string, AccessMapEntry>>;
      registre?: readonly Traitement[];
    },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  async erase(viewer: Viewer, requestId: string): Promise<{ ok: true; value: { receipt: ErasureReceipt; sha256: string } } | RealErasureRefusal> {
    if (viewer.role !== 'compliance') {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'effacement_reel', code: 'role' } },
        this.now,
      );
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const row = typeof requestId === 'string' ? await this.db.first<RequestRow>('SELECT id, network_id, person_id, kind FROM person_requests WHERE id = ? AND network_id = ?', [requestId, viewer.networkId]) : null;
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    if (row.kind !== 'effacement') return { ok: false, rule: null, code: 'not_erasure' };
    if (this.options.mode !== 'reel') return { ok: false, rule: 'R17', code: 'trial_only' };
    if (!this.options.ledger) return { ok: false, rule: 'R231', code: 'ledger_missing' };
    if (!this.options.objects) return { ok: false, rule: 'R17', code: 'objects_missing' };
    if (!(await this.db.first("SELECT 1 AS x FROM person_request_outputs WHERE request_id = ? AND kind = 'plan_effacement' AND mode = 'essai'", [row.id]))) {
      return { ok: false, rule: 'R96', code: 'plan_not_prepared' };
    }
    const members = await this.fiche.membersOf(row.person_id);
    const at = this.now().toISOString();
    try {
      for (const personId of members) await recordErasure(this.options.ledger.store, this.options.ledger.key, { requestId: row.id, networkId: row.network_id, personId, erasedAt: at, members: [...members] });
    } catch {
      return { ok: false, rule: 'R231', code: 'ledger_unwritable' };
    }
    let erasedNow: Awaited<ReturnType<typeof eraseForReal>>;
    try {
      erasedNow = await eraseForReal(this.db, members, { ...(this.options.carte ? { carte: this.options.carte } : {}), ...(this.options.registre ? { registre: this.options.registre } : {}), objects: this.options.objects, target: { requestId: row.id, networkId: row.network_id, at } });
    } catch {
      // Interrompu après la note au registre : la trace reste au journal, sans donnée de la personne ; le refaire, ou la
      // restauration, finit le travail [R17, R231].
      await appendEvent(
        this.journal,
        { type: 'rgpd.effacement', actor: this.actor(viewer), subject: `person_request:${row.id}`, data: { rule: 'R17', mode: 'reel', interrupted: true, complete: false } },
        this.now,
      );
      return { ok: false, rule: 'R17', code: 'interrupted' };
    }
    const { plan, outcome } = erasedNow;
    const receipt: ErasureReceipt = {
      format: 1,
      requestId: row.id,
      mode: 'reel',
      at,
      records: members.length,
      planSha256: await sha256Of(plan),
      ...outcome,
      kept: plan.lines
        .filter((l): l is typeof l & { action: 'garder' | 'empreinte' | 'examiner' } => l.action !== 'effacer')
        .map((l) => ({ table: l.table, action: l.action, rows: l.rows, why: l.action === 'empreinte' ? IDENTIFIERS_KEPT : l.why })),
      alwaysKept: plan.alwaysKept,
      complete: outcome.remaining.length === 0 && outcome.objectsRemaining === 0,
    };
    const sha256 = await sha256Of(receipt);
    await this.db.run(
      'INSERT INTO person_request_outputs (request_id, kind, mode, output_sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [row.id, 'plan_effacement', 'reel', sha256, this.actor(viewer), at],
    );
    const total = (list: RealErasureCount[]): number => list.reduce((n, c) => n + c.rows, 0);
    await appendEvent(
      this.journal,
      {
        type: 'rgpd.effacement',
        actor: this.actor(viewer),
        subject: `person_request:${row.id}`,
        data: {
          rule: 'R17',
          mode: 'reel',
          sha256,
          erased: total(outcome.erased),
          pseudonymized: total(outcome.pseudonymized),
          hashed: total(outcome.hashed),
          remaining: total(outcome.remaining),
          objects: Object.values(outcome.objectsRemoved).reduce((n, v) => n + (v ?? 0), 0),
          complete: receipt.complete,
        },
      },
      this.now,
    );
    return { ok: true, value: { receipt, sha256 } };
  }
}
