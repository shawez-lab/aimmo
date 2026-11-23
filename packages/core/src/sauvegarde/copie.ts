/**
 * La copie chiffrée de la base, et sa restauration vérifiée (SV01) [R224].
 *
 * Décidé, lecture prudente :
 * - la copie prend tout : le schéma tel que la base le décrit et chaque ligne, avec son rang ; rien n'est choisi table par
 *   table, pour qu'une table ajoutée demain soit copiée sans y penser ;
 * - chaque morceau et le sommaire sont chiffrés (AES-256-GCM), liés à leur copie et à leur place : un morceau changé,
 *   déplacé ou pris dans une autre copie est refusé. Les empreintes vivent dans le sommaire chiffré : en clair, elles
 *   permettraient de deviner le contenu d'une petite table. Le sommaire s'écrit en dernier : sans lui, la copie n'existe pas ;
 * - une copie ne se restaure que dans une base neuve : rien n'est jamais écrasé. Les garde-fous de la base reviennent à la
 *   fin, pour que rejouer des lignes anciennes ne les déclenche pas ;
 * - « restaurée » ne se dit qu'après preuve : mêmes empreintes, mêmes objets, clés étrangères et intégrité saines ;
 * - la copie se prend sur une photo de la base, hors du Worker : `wrangler d1 export`, chargé dans une base SQLite (SV02).
 *   Lue sur une base qui vit, elle ne serait pas à l'instant près, et un Worker atteindrait la limite de requêtes de D1.
 *   Par prudence, les enfants sont lus avant leurs parents, et tout écart se dit à la restauration, jamais comme un succès ;
 * - le stockage ne voit que la date de la copie et des numéros de morceaux : ni nom de table ni compte par table.
 */
import type { SqlDatabase, SqlValue } from '../db/sql.ts';
import { appendEvent, verifyChain } from '../journal/journal.ts';
import { SqlJournalStore } from '../journal/sql-store.ts';
import type { JournalStore } from '../journal/types.ts';

export const COPY_FORMAT = 1;
const PAGE_ROWS = 500;
const ROWID = '__copie_rang__';
export const ROWID_COLUMN = ROWID;
const KEY_BYTES = 32;
const IV_BYTES = 12;
export const COPY_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}$/;

/** Le stockage des copies, à part de la base ; un morceau ne se réécrit pas. */
export interface CopyStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

interface SchemaObject {
  type: string;
  name: string;
  sql: string;
}

interface TableSummary {
  name: string;
  rows: number;
  digest: string;
  /** Les numéros de ses morceaux dans la copie : `firstPart`, puis les suivants. */
  firstPart: number;
  parts: number;
}

interface Manifest {
  format: number;
  copyId: string;
  takenAt: string;
  schema: SchemaObject[];
  tables: TableSummary[];
  /** Le dernier numéro donné par chaque compteur : une ligne effacée ne le rend pas. */
  sequences: { name: string; seq: number }[];
}

type Row = Record<string, SqlValue>;

export interface CopyReceipt {
  copyId: string;
  takenAt: string;
  tables: number;
  rows: number;
  parts: number;
}

export type RestoreRefusal = 'bad_copy_id' | 'manifest_missing' | 'undecryptable' | 'part_corrupt' | 'part_missing' | 'bad_format' | 'target_not_empty' | 'restore_failed';
export type RestoreProblem = { kind: 'table_differs'; table: string } | { kind: 'schema_differs'; name: string } | { kind: 'foreign_keys'; table: string } | { kind: 'integrity' } | { kind: 'journal_chain' };
export type RestoreOutcome =
  | { ok: true; copyId: string; takenAt: string; tables: number; rows: number; durationMs: number; digest: string }
  | { ok: false; code: RestoreRefusal }
  | { ok: false; code: 'not_identical'; problems: RestoreProblem[]; durationMs: number };

/** La clé des copies, faite par `copyKeyFromSecret`. */
export type CopyKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text) as Uint8Array<ArrayBuffer>;

/** Refuse une clé qui n'est pas 32 octets en base64 : une clé faible ne se rattrape pas. */
export async function copyKeyFromSecret(secret: string): Promise<CopyKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    throw new Error('La clé des copies doit être en base64.');
  }
  if (raw.length !== KEY_BYTES) throw new Error('La clé des copies doit faire 32 octets.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Chiffre des octets, liés à leur place. */
export async function sealBytesAt(key: CopyKey, place: string, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytesOf(place) }, key, Uint8Array.from(bytes)));
  const out = new Uint8Array(IV_BYTES + body.length);
  out.set(iv);
  out.set(body, IV_BYTES);
  return out;
}

/** Déchiffre des octets à leur place ; `null` s'ils ont changé ou bougé, ou avec une autre clé. */
export async function openBytesAt(key: CopyKey, place: string, bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length <= IV_BYTES) return null;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: bytesOf(place) }, key, bytes.slice(IV_BYTES)));
  } catch {
    return null;
  }
}

/** Chiffre un texte, lié à sa place. */
export async function sealAt(key: CopyKey, place: string, text: string): Promise<Uint8Array> {
  return sealBytesAt(key, place, bytesOf(text));
}

/** Déchiffre un texte à sa place ; `null` s'il a changé ou bougé, ou avec une autre clé. */
export async function openAt(key: CopyKey, place: string, bytes: Uint8Array): Promise<string | null> {
  const plain = await openBytesAt(key, place, bytes);
  return plain === null ? null : decoder.decode(plain);
}

/** La place du sommaire : sans lui, la copie n'existe pas. */
export const manifestPlace = (copyId: string): string => `copies/${copyId}/sommaire`;
const partPlace = (copyId: string, index: number): string => `copies/${copyId}/${String(index).padStart(6, '0')}`;

/** Le schéma de la base, dans l'ordre où elle l'a créé, sans ce qui appartient au moteur. */
async function readSchema(db: SqlDatabase): Promise<SchemaObject[]> {
  return db.all<SchemaObject>(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY rowid",
  );
}

/** Une table, page après page, dans l'ordre de ses rangs ; la colonne `ROWID_COLUMN` porte le rang. */
export async function* pagesOf(db: SqlDatabase, table: string): AsyncGenerator<Row[]> {
  let after = -9_007_199_254_740_991;
  for (;;) {
    const rows = await db.all<Row>(`SELECT rowid AS ${ROWID}, * FROM ${q(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [after, PAGE_ROWS]);
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < PAGE_ROWS) return;
    after = Number(rows[rows.length - 1]![ROWID]);
  }
}

const checkValues = (table: string, rows: readonly Row[]): void => {
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error(`Valeur non copiable dans la table ${table}.`);
    }
  }
};

async function chain(digest: string, text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytesOf(`${digest}\n${text}`))));
}

/** L'empreinte d'une table : la même page après page, à la copie comme à la vérification. */
async function digestOf(db: SqlDatabase, table: string): Promise<{ digest: string; rows: number }> {
  let digest = '';
  let rows = 0;
  for await (const page of pagesOf(db, table)) {
    digest = await chain(digest, JSON.stringify(page));
    rows += page.length;
  }
  return { digest, rows };
}

export class CopieBase {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly store: CopyStore,
    private readonly key: CopyKey,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Prend une copie. Une panne laisse une copie sans sommaire, qui n'existe pas pour la restauration. */
  async take(): Promise<CopyReceipt> {
    const takenAt = this.now().toISOString();
    const stamp = takenAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const copyId = `${stamp}-${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;
    const schema = await readSchema(this.db);
    const tables: TableSummary[] = [];
    let nextPart = 0;
    // Dans l'ordre inverse de leur création : un enfant est lu avant son parent, qui ne peut alors que le contenir.
    for (const object of [...schema].reverse()) {
      if (object.type !== 'table') continue;
      let digest = '';
      let rows = 0;
      let parts = 0;
      const firstPart = nextPart;
      for await (const page of pagesOf(this.db, object.name)) {
        checkValues(object.name, page);
        const text = JSON.stringify(page);
        digest = await chain(digest, text);
        const place = partPlace(copyId, nextPart);
        await this.store.put(place, await sealAt(this.key, place, text));
        rows += page.length;
        parts += 1;
        nextPart += 1;
      }
      tables.push({ name: object.name, rows, digest, firstPart, parts });
    }
    const sequences = schema.some((o) => /AUTOINCREMENT/i.test(o.sql)) ? await this.db.all<{ name: string; seq: number }>('SELECT name, seq FROM sqlite_sequence ORDER BY name') : [];
    const manifest: Manifest = { format: COPY_FORMAT, copyId, takenAt, schema, tables, sequences };
    const place = manifestPlace(copyId);
    await this.store.put(place, await sealAt(this.key, place, JSON.stringify(manifest)));
    const receipt: CopyReceipt = { copyId, takenAt, tables: tables.length, rows: tables.reduce((n, t) => n + t.rows, 0), parts: tables.reduce((n, t) => n + t.parts, 0) };
    // Le journal dit la copie, sans une donnée. Il la nomme par sa date : une suite de chiffres du hasard y serait prise pour un numéro.
    await appendEvent(this.journal, { type: 'base.copie', actor: 'system:sauvegarde', subject: `copy:${stamp}`, data: { rule: 'R224', tables: receipt.tables, rows: receipt.rows, parts: receipt.parts } }, this.now);
    return receipt;
  }
}

/**
 * Restaure une copie dans une base neuve, puis prouve qu'elle est identique. La base de destination doit accepter
 * `PRAGMA foreign_keys` : une base SQLite locale, jamais la production, que D1 restaure à l'instant près.
 */
export async function restoreCopy(target: SqlDatabase, store: CopyStore, key: CopyKey, copyId: string, options: { clock?: () => number } = {}): Promise<RestoreOutcome> {
  const clock = options.clock ?? (() => Date.now());
  const started = clock();
  if (!COPY_ID.test(copyId)) return { ok: false, code: 'bad_copy_id' };
  const sealed = await store.get(manifestPlace(copyId));
  if (!sealed) return { ok: false, code: 'manifest_missing' };
  const opened = await openAt(key, manifestPlace(copyId), sealed);
  if (opened === null) return { ok: false, code: 'undecryptable' };
  const manifest = JSON.parse(opened) as Manifest;
  if (manifest.format !== COPY_FORMAT || manifest.copyId !== copyId) return { ok: false, code: 'bad_format' };
  if ((await readSchema(target)).length > 0) return { ok: false, code: 'target_not_empty' };

  // Tout se déchiffre avant la première écriture : une copie abîmée ne laisse pas une base à moitié faite.
  const pages = new Map<string, string[]>();
  for (const t of manifest.tables) {
    const texts: string[] = [];
    for (let i = 0; i < t.parts; i += 1) {
      const place = partPlace(copyId, t.firstPart + i);
      const bytes = await store.get(place);
      if (!bytes) return { ok: false, code: 'part_missing' };
      const text = await openAt(key, place, bytes);
      // Le sommaire s'est ouvert : la clé est bonne, c'est ce morceau qui est abîmé, déplacé, ou d'une autre copie.
      if (text === null) return { ok: false, code: 'part_corrupt' };
      texts.push(text);
    }
    pages.set(t.name, texts);
  }

  const problems: RestoreProblem[] = [];
  await target.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const object of manifest.schema) if (object.type === 'table') await target.run(object.sql);
    for (const t of manifest.tables) {
      for (const text of pages.get(t.name) ?? []) {
        for (const row of JSON.parse(text) as Row[]) {
          const columns = Object.keys(row);
          const names = columns.map((c) => (c === ROWID ? 'rowid' : q(c)));
          await target.run(`INSERT INTO ${q(t.name)} (${names.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map((c) => row[c] ?? null));
        }
      }
    }

    for (const s of manifest.sequences) {
      const { changes } = await target.run('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [s.seq, s.name]);
      if (changes === 0) await target.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [s.name, s.seq]);
    }

    for (const t of manifest.tables) {
      const seen = await digestOf(target, t.name);
      if (seen.digest !== t.digest || seen.rows !== t.rows) problems.push({ kind: 'table_differs', table: t.name });
    }
    // Index, vues et garde-fous en dernier : rejouer des lignes anciennes ne doit pas les déclencher.
    for (const object of manifest.schema) if (object.type !== 'table') await target.run(object.sql);
    const after = await readSchema(target);
    const names = new Set(after.map((o) => `${o.type}:${o.name}:${o.sql}`));
    for (const object of manifest.schema) if (!names.has(`${object.type}:${object.name}:${object.sql}`)) problems.push({ kind: 'schema_differs', name: object.name });

    const broken = await target.all<{ table: string }>('PRAGMA foreign_key_check');
    for (const table of new Set(broken.map((b) => b.table))) problems.push({ kind: 'foreign_keys', table });
    const integrity = await target.first<{ integrity_check: string }>('PRAGMA integrity_check');
    if (integrity?.integrity_check !== 'ok') problems.push({ kind: 'integrity' });
    if (manifest.tables.some((t) => t.name === 'journal')) {
      const chainState = await verifyChain(await new SqlJournalStore(target).all());
      if (!chainState.ok) problems.push({ kind: 'journal_chain' });
    }
  } catch {
    // Une écriture refusée laisse une base neuve à moitié faite : à jeter. L'erreur peut citer une ligne : elle ne sort pas.
    return { ok: false, code: 'restore_failed' };
  } finally {
    await target.exec('PRAGMA foreign_keys = ON');
  }

  const durationMs = clock() - started;
  if (problems.length > 0) return { ok: false, code: 'not_identical', problems, durationMs };
  // Une empreinte de toute la base : une par table permettrait de deviner le contenu d'une petite table.
  const digest = await chain('', JSON.stringify(manifest.tables.map((t) => [t.name, t.rows, t.digest])));
  return { ok: true, copyId, takenAt: manifest.takenAt, tables: manifest.tables.length, rows: manifest.tables.reduce((n, t) => n + t.rows, 0), durationMs, digest };
}
