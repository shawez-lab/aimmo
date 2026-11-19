/**
 * La copie des objets de chaque stockage, et l'exercice qui restaure la base avec eux (AU019) [R224].
 *
 * Constat de l'audit A019 : la copie prenait la base SQL, pas les octets des photos, des scans signés ni des pièces du
 * coffre. Restaurer des références sans leurs fichiers ne rend pas un dossier.
 *
 * Jamais vu : l'exercice ne dit « restauré » qu'après avoir relu, dans les stockages neufs, chaque photo, chaque scan et
 * chaque pièce du coffre, octet par octet contre son empreinte, et vérifié que chaque fichier cité par la base est là.
 *
 * Décidé, lecture prudente :
 * - chaque stockage d'objets nommé dans `OBJECT_STORAGES` est copié ; un seul manque, et rien n'est dit copié ;
 * - la copie est indépendante : chaque nuit recopie tous les objets sous sa propre date. Partager un objet avec une copie
 *   plus ancienne la ferait dépendre d'une copie que la garde de 30 jours efface ;
 * - chaque objet est chiffré, lié à sa place ; son nom, son stockage, sa taille et son empreinte vivent dans un sommaire
 *   chiffré, écrit en dernier : le compartiment ne voit que des numéros ;
 * - un objet listé puis disparu avant sa lecture a été supprimé entre-temps : il n'est pas dans la copie, et c'est dit
 *   dans le reçu par un compte, jamais par son nom ;
 * - les objets se restaurent seulement dans des stockages neufs, puis sont relus et comparés à leur empreinte ;
 * - l'exercice restaure la base et les objets de la même copie. Il échoue si la copie n'a pas d'objets (l'ancienne
 *   copie de la seule base), si un stockage manque, si un objet diffère, ou si la base cite un fichier absent.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { COPY_ID, pagesOf, ROWID_COLUMN, openAt, openBytesAt, restoreCopy, sealAt, sealBytesAt, type CopyKey, type CopyStore, type RestoreOutcome } from './copie.ts';

/** Les stockages d'objets du Worker : médias des biens, pièces des dossiers, dossiers des commerces, coffre. */
export const OBJECT_STORAGES = ['MEDIA', 'PIECES', 'COMMERCES', 'COFFRE'] as const;
export type ObjectStorage = (typeof OBJECT_STORAGES)[number];

export const OBJECTS_FORMAT = 1;

export interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
}

/** Un stockage à copier : la liste de ses clés, et la lecture d'un objet ; `null` s'il a disparu. */
export interface ObjectSource {
  list(): Promise<string[]>;
  get(key: string): Promise<StoredObject | null>;
}

/** Un stockage neuf où restaurer. */
export interface ObjectTarget extends ObjectSource {
  put(key: string, object: StoredObject): Promise<void>;
}

interface ObjectEntry {
  storage: ObjectStorage;
  key: string;
  size: number;
  digest: string;
  contentType: string | null;
  part: number;
}

interface ObjectsManifest {
  format: number;
  copyId: string;
  storages: ObjectStorage[];
  objects: ObjectEntry[];
}

export interface ObjectsReceipt {
  copyId: string;
  storages: number;
  objects: number;
  bytes: number;
  /** Les objets listés puis supprimés avant leur lecture. */
  vanished: number;
}

export type ObjectsRefusal = 'bad_copy_id' | 'objects_missing' | 'references_unchecked' | 'undecryptable' | 'bad_format' | 'storage_missing' | 'target_not_empty';
export type ObjectsProblem =
  | { kind: 'object_missing'; storage: ObjectStorage }
  | { kind: 'object_corrupt'; storage: ObjectStorage }
  | { kind: 'object_differs'; storage: ObjectStorage }
  | { kind: 'reference_missing'; storage: ObjectStorage };
export type ObjectsOutcome =
  | { ok: true; storages: number; objects: number; bytes: number; digest: string }
  | { ok: false; code: ObjectsRefusal }
  | { ok: false; code: 'not_identical'; problems: ObjectsProblem[] };

export class ObjectCopyError extends Error {
  override readonly name = 'ObjectCopyError';
  constructor(readonly code: 'storage_missing' | 'bad_copy_id') {
    super(code === 'storage_missing' ? 'Un stockage d’objets manque : rien n’est copié.' : 'Nom de copie invalide.');
  }
}

const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array): Promise<string> => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))));

/** La place du sommaire des objets, dans la copie de la base : même date, même garde. */
export const objectsManifestPlace = (copyId: string): string => `copies/${copyId}/objets/sommaire`;
const objectPlace = (copyId: string, part: number): string => `copies/${copyId}/objets/${String(part).padStart(7, '0')}`;

/** Copie tous les objets de chaque stockage sous la date de la copie de la base. */
export async function copyObjects(sources: Partial<Record<ObjectStorage, ObjectSource | null>>, store: CopyStore, key: CopyKey, copyId: string): Promise<ObjectsReceipt> {
  if (!COPY_ID.test(copyId)) throw new ObjectCopyError('bad_copy_id');
  // Avant la première écriture : une copie à qui manque un stockage ne doit même pas commencer.
  for (const name of OBJECT_STORAGES) if (!sources[name]) throw new ObjectCopyError('storage_missing');
  const objects: ObjectEntry[] = [];
  let vanished = 0;
  let bytes = 0;
  for (const storage of OBJECT_STORAGES) {
    const source = sources[storage]!;
    const keys = [...new Set(await source.list())].sort();
    for (const k of keys) {
      const found = await source.get(k);
      if (!found) {
        vanished += 1;
        continue;
      }
      const part = objects.length;
      const place = objectPlace(copyId, part);
      await store.put(place, await sealBytesAt(key, place, found.bytes));
      objects.push({ storage, key: k, size: found.bytes.length, digest: await sha256(found.bytes), contentType: found.contentType ?? null, part });
      bytes += found.bytes.length;
    }
  }
  const manifest: ObjectsManifest = { format: OBJECTS_FORMAT, copyId, storages: [...OBJECT_STORAGES], objects };
  const place = objectsManifestPlace(copyId);
  await store.put(place, await sealAt(key, place, JSON.stringify(manifest)));
  return { copyId, storages: OBJECT_STORAGES.length, objects: objects.length, bytes, vanished };
}

async function digestOfAll(objects: readonly ObjectEntry[]): Promise<string> {
  const lines = objects.map((o) => [o.storage, o.key, o.size, o.digest]).sort((a, b) => (`${a[0]}\n${a[1]}` < `${b[0]}\n${b[1]}` ? -1 : 1));
  return sha256(new TextEncoder().encode(JSON.stringify(lines)));
}

/**
 * Restaure les objets d'une copie dans des stockages neufs, puis relit chacun contre son empreinte. Les stockages
 * restent à jeter si la restauration n'est pas identique. `references` : les fichiers que la base restaurée cite.
 */
export async function restoreObjects(
  targets: Partial<Record<ObjectStorage, ObjectTarget | null>>,
  store: CopyStore,
  key: CopyKey,
  copyId: string,
  references: readonly { storage: ObjectStorage; key: string }[] = [],
): Promise<ObjectsOutcome> {
  if (!COPY_ID.test(copyId)) return { ok: false, code: 'bad_copy_id' };
  const sealed = await store.get(objectsManifestPlace(copyId));
  if (!sealed) return { ok: false, code: 'objects_missing' };
  const opened = await openAt(key, objectsManifestPlace(copyId), sealed);
  if (opened === null) return { ok: false, code: 'undecryptable' };
  const manifest = JSON.parse(opened) as ObjectsManifest;
  if (manifest.format !== OBJECTS_FORMAT || manifest.copyId !== copyId) return { ok: false, code: 'bad_format' };
  if (OBJECT_STORAGES.some((s) => !manifest.storages.includes(s))) return { ok: false, code: 'bad_format' };
  for (const name of OBJECT_STORAGES) if (!targets[name]) return { ok: false, code: 'storage_missing' };
  for (const name of OBJECT_STORAGES) if ((await targets[name]!.list()).length > 0) return { ok: false, code: 'target_not_empty' };

  const problems: ObjectsProblem[] = [];
  for (const entry of manifest.objects) {
    const place = objectPlace(copyId, entry.part);
    const sealedObject = await store.get(place);
    if (!sealedObject) {
      problems.push({ kind: 'object_missing', storage: entry.storage });
      continue;
    }
    const plain = await openBytesAt(key, place, sealedObject);
    if (plain === null || plain.length !== entry.size || (await sha256(plain)) !== entry.digest) {
      problems.push({ kind: 'object_corrupt', storage: entry.storage });
      continue;
    }
    const target = targets[entry.storage]!;
    await target.put(entry.key, entry.contentType === null ? { bytes: plain } : { bytes: plain, contentType: entry.contentType });
    // Relu depuis le stockage neuf : un envoi accepté ne prouve pas que l'objet y est.
    const back = await target.get(entry.key);
    if (!back || back.bytes.length !== entry.size || (await sha256(back.bytes)) !== entry.digest) problems.push({ kind: 'object_differs', storage: entry.storage });
  }
  // Cherché dans tous les stockages : une référence libre (dossier d'un commerce) peut vivre ailleurs que son début le dit.
  const present = new Set(manifest.objects.map((o) => o.key));
  for (const ref of references) if (!present.has(ref.key)) problems.push({ kind: 'reference_missing', storage: ref.storage });

  if (problems.length > 0) return { ok: false, code: 'not_identical', problems };
  return { ok: true, storages: manifest.storages.length, objects: manifest.objects.length, bytes: manifest.objects.reduce((n, o) => n + o.size, 0), digest: await digestOfAll(manifest.objects) };
}

/** Les fichiers que la base cite, lus dans la base restaurée : une requête par sorte de référence. */
export type ReferenceReader = (db: SqlDatabase) => Promise<{ storage: ObjectStorage; key: string }[]>;

export type ExerciseOutcome =
  | { ok: true; base: Extract<RestoreOutcome, { ok: true }>; objects: Extract<ObjectsOutcome, { ok: true }>; durationMs: number }
  | { ok: false; part: 'base'; base: Exclude<RestoreOutcome, { ok: true }> }
  | { ok: false; part: 'objets'; objects: Exclude<ObjectsOutcome, { ok: true }> };

/**
 * L'exercice de restauration complet : la base dans une base neuve, puis tous les objets de chaque stockage dans des
 * stockages neufs, depuis la même copie, chaque empreinte contrôlée. Rien n'est dit restauré tant qu'une partie manque.
 */
export async function restoreExercise(input: {
  target: SqlDatabase;
  targets: Partial<Record<ObjectStorage, ObjectTarget | null>>;
  store: CopyStore;
  key: CopyKey;
  copyId: string;
  /**
   * Obligatoire : sans lui, une liste de stockage vide ou tronquée passerait pour une copie complète. Un appelant sans
   * lecteur reçoit `references_unchecked`, jamais « restauré ».
   */
  references: ReferenceReader | null;
  clock?: () => number;
}): Promise<ExerciseOutcome> {
  const clock = input.clock ?? (() => Date.now());
  const started = clock();
  if (typeof input.references !== 'function') return { ok: false, part: 'objets', objects: { ok: false, code: 'references_unchecked' } };
  // La durée dite est celle de l'exercice entier, base et fichiers : l'horloge n'est lue qu'au début et à la fin.
  const base = await restoreCopy(input.target, input.store, input.key, input.copyId);
  if (!base.ok) return { ok: false, part: 'base', base };
  const references = await input.references(input.target);
  const objects = await restoreObjects(input.targets, input.store, input.key, input.copyId, references);
  if (!objects.ok) return { ok: false, part: 'objets', objects };
  return { ok: true, base, objects, durationMs: clock() - started };
}

/**
 * Un stockage neuf de vérification : il garde un objet jusqu'à sa relecture, puis l'oublie. La preuve de chaque nuit et
 * le test du mois relisent ainsi chaque objet sans tenir en mémoire toutes les photos du réseau.
 */
export function verifyingTarget(): ObjectTarget {
  const held = new Map<string, StoredObject>();
  return {
    list: async () => [...held.keys()],
    put: async (k, o) => {
      held.set(k, { ...o, bytes: Uint8Array.from(o.bytes) });
    },
    get: async (k) => {
      const o = held.get(k) ?? null;
      held.delete(k);
      return o;
    },
  };
}

/**
 * Le stockage où vit d'habitude chaque sorte de fichier, d'après le début de sa clé ; la clé est toujours donnée par le
 * code. Le contrôle cherche un fichier cité dans tous les stockages : ce stockage ne sert qu'à dire où chercher d'abord
 * et quoi rapporter. Un test du dépôt échoue si le code construit une clé d'un début absent d'ici. `signature-en-ligne/`
 * n'en est pas un : c'est une marque en base, la copie signée vit dans la base elle-même.
 */
export const REFERENCE_PREFIXES: Readonly<Record<string, ObjectStorage>> = Object.freeze({
  'biens/': 'MEDIA',
  'dossiers/': 'PIECES',
  'preuves/': 'PIECES',
  'agents/': 'PIECES',
  'partenaires/': 'PIECES',
  'relations/': 'PIECES',
  'mandats/': 'PIECES',
  'offres/': 'PIECES',
  'location/': 'PIECES',
  'boite/': 'PIECES',
  'mesure-sources/': 'PIECES',
  'commerces/': 'COMMERCES',
  'coffre/': 'COFFRE',
});
const PREFIXES = Object.keys(REFERENCE_PREFIXES).map((p) => p.slice(0, -1).replace(/-/g, '\\-'));
const WHOLE_REFERENCE = new RegExp(`^(?:${PREFIXES.join('|')})\\/[A-Za-z0-9._\\/-]{1,300}$`);
/** Une colonne qui ne garde que des références de stockage, quel que soit leur début. */
const STORAGE_REF_COLUMNS = new Set(['storage_ref']);

/** Les fichiers cités par une ligne : ses valeurs texte, entières ou dans un JSON, qui ont la forme d'une clé de stockage. */
export function rowReferences(row: Readonly<Record<string, unknown>>): { storage: ObjectStorage; key: string }[] {
  const found = new Map<string, { storage: ObjectStorage; key: string }>();
  const add = (key: string, any = false): void => {
    const prefix = Object.keys(REFERENCE_PREFIXES).find((p) => key.startsWith(p));
    if (!prefix && !any) return;
    if (key.endsWith('/') || key.includes('//') || key.split('/').some((s) => s === '.' || s === '..')) return;
    found.set(key, { storage: prefix ? REFERENCE_PREFIXES[prefix]! : 'COMMERCES', key });
  };
  for (const [column, value] of Object.entries(row)) {
    if (column === ROWID_COLUMN || typeof value !== 'string') continue;
    if (STORAGE_REF_COLUMNS.has(column)) add(value, true);
    else if (WHOLE_REFERENCE.test(value)) add(value);
    else if (value.startsWith('[') || value.startsWith('{')) for (const m of value.matchAll(/"([^"]{1,320})"/g)) if (WHOLE_REFERENCE.test(m[1]!)) add(m[1]!);
  }
  return [...found.values()];
}

/**
 * Les fichiers cités par la base : chaque valeur texte de chaque table, entière ou dans un JSON, qui a la forme d'une
 * clé de stockage. Toutes les tables sont lues, pour qu'une table ajoutée demain soit vérifiée sans y penser. Le journal
 * n'est pas lu : il garde l'histoire, et cite des fichiers effacés depuis. Lecture prudente : une valeur qui ressemble à
 * une clé sans en être une fait échouer l'exercice ; une fausse alerte vaut mieux qu'un faux « restauré ».
 */
export const fileReferences: ReferenceReader = async (db) => {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'journal' ORDER BY name");
  const found = new Map<string, { storage: ObjectStorage; key: string }>();
  for (const { name } of tables) {
    for await (const rows of pagesOf(db, name)) for (const row of rows) for (const ref of rowReferences(row)) found.set(ref.key, ref);
  }
  return [...found.values()];
};
