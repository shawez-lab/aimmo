import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  applyMigrations,
  appendEvent,
  CopieBase,
  copyKeyFromSecret,
  copyObjects,
  FicheClient,
  fromSyncSqlite,
  OBJECT_STORAGES,
  ObjectCopyError,
  restoreExercise,
  fileReferences,
  REFERENCE_PREFIXES,
  restoreObjects,
  SqlJournalStore,
  type CopyStore,
  type ObjectStorage,
  type ObjectTarget,
  type SqlDatabase,
  type StoredObject,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : le réseau, les personnes, les fichiers, le stockage et les clés.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 7)));
const MARK = 'Fichier-Invente-Lisible';

const memoryCopies = () => {
  const parts = new Map<string, Uint8Array>();
  const store: CopyStore = {
    put: async (k, b) => {
      parts.set(k, b);
    },
    get: async (k) => parts.get(k) ?? null,
  };
  return { parts, store };
};

const memoryBucket = (seed: Record<string, StoredObject> = {}) => {
  const objects = new Map<string, StoredObject>(Object.entries(seed));
  const bucket: ObjectTarget = {
    list: async () => [...objects.keys()],
    get: async (k) => objects.get(k) ?? null,
    put: async (k, o) => {
      objects.set(k, { bytes: Uint8Array.from(o.bytes), ...(o.contentType ? { contentType: o.contentType } : {}) });
    },
  };
  return { objects, bucket };
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const photo = (n: number): Uint8Array => Uint8Array.from({ length: 2048 + n }, (_, i) => (i * 31 + n) % 256);

const emptyDb = (): SqlDatabase => fromSyncSqlite(openMemoryDatabase());

async function world() {
  const db = emptyDb();
  await applyMigrations(db, loadMigrations());
  const now = () => new Date('2027-03-10T02:00:00.000Z');
  const fiches = new FicheClient(db, { now });
  const network = await fiches.createNetwork('Réseau test');
  const agent = await fiches.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  await fiches.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Inventée' });
  const sources = {
    MEDIA: memoryBucket({ 'biens/b1/salon.jpg': { bytes: photo(1), contentType: 'image/jpeg' }, 'biens/b1/cuisine.jpg': { bytes: photo(2), contentType: 'image/jpeg' } }),
    PIECES: memoryBucket({ 'dossiers/d1/compromis-signe.pdf': { bytes: bytes(`%PDF ${MARK} compromis`), contentType: 'application/pdf' }, 'agents/a1/carte.pdf': { bytes: bytes('%PDF carte') } }),
    COMMERCES: memoryBucket({ 'commerces/c1/bilan.pdf': { bytes: bytes(`%PDF ${MARK} bilan`) } }),
    COFFRE: memoryBucket({ 'coffre/k1/piece-identite.pdf': { bytes: bytes(`%PDF ${MARK} coffre`) } }),
  };
  const copies = memoryCopies();
  const key = await copyKeyFromSecret(SECRET);
  const receipt = await new CopieBase(db, new SqlJournalStore(db), copies.store, key, { now }).take();
  return { db, sources, copies, key, receipt };
}

const sourcesOf = (w: Awaited<ReturnType<typeof world>>) => Object.fromEntries(OBJECT_STORAGES.map((s) => [s, w.sources[s].bucket])) as Record<ObjectStorage, ObjectTarget>;
const freshTargets = () => {
  const made = Object.fromEntries(OBJECT_STORAGES.map((s) => [s, memoryBucket()])) as Record<ObjectStorage, ReturnType<typeof memoryBucket>>;
  const targets = Object.fromEntries(OBJECT_STORAGES.map((s) => [s, made[s].bucket])) as Record<ObjectStorage, ObjectTarget>;
  return { made, targets };
};

describeWithSqlite('AU019 · la copie prend aussi les objets de chaque stockage', () => {
  it('[R224] constat : une copie de la seule base ne se dit pas restaurée, ses fichiers manquent', async () => {
    const w = await world();
    const { targets } = freshTargets();
    const out = await restoreExercise({ target: emptyDb(), targets, store: w.copies.store, key: w.key, copyId: w.receipt.copyId, references: async () => [] });
    expect(out).toEqual({ ok: false, part: 'objets', objects: { ok: false, code: 'objects_missing' } });
  });

  it('[R224] l’exercice restaure la base et tous les objets de chaque stockage, octet par octet, depuis la copie seule', async () => {
    const w = await world();
    const copied = await copyObjects(sourcesOf(w), w.copies.store, w.key, w.receipt.copyId);
    expect(copied).toMatchObject({ storages: 4, objects: 6, vanished: 0 });
    // Les sources disparaissent : seule la copie reste.
    for (const s of OBJECT_STORAGES) w.sources[s].objects.clear();
    const { made, targets } = freshTargets();
    const target = emptyDb();
    const out = await restoreExercise({
      target,
      targets,
      store: w.copies.store,
      key: w.key,
      copyId: w.receipt.copyId,
      references: async () => [
        { storage: 'MEDIA', key: 'biens/b1/salon.jpg' },
        { storage: 'COFFRE', key: 'coffre/k1/piece-identite.pdf' },
      ],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.objects).toMatchObject({ storages: 4, objects: 6 });
    expect(out.objects.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(made.MEDIA.objects.get('biens/b1/salon.jpg')).toEqual({ bytes: photo(1), contentType: 'image/jpeg' });
    expect(new TextDecoder().decode(made.COFFRE.objects.get('coffre/k1/piece-identite.pdf')!.bytes)).toContain('coffre');
    expect(made.PIECES.objects.get('agents/a1/carte.pdf')).toEqual({ bytes: bytes('%PDF carte') });
    expect(await target.first<{ n: number }>('SELECT count(*) AS n FROM persons')).toEqual({ n: 1 });
  });

  it('[R224] le compartiment ne voit ni nom de fichier ni contenu : seulement des numéros, chiffrés', async () => {
    const w = await world();
    await copyObjects(sourcesOf(w), w.copies.store, w.key, w.receipt.copyId);
    const places = [...w.copies.parts.keys()].filter((k) => k.includes('/objets/'));
    expect(places).toHaveLength(7);
    for (const p of places) expect(p).toMatch(/^copies\/[0-9a-fTZ-]+\/objets\/(sommaire|\d{7})$/);
    const all = [...w.copies.parts.values()].map((b) => new TextDecoder('latin1').decode(b)).join('\n');
    expect(all).not.toContain(MARK);
    expect(all).not.toContain('piece-identite');
  });

  it('[R224] un stockage absent : rien n’est copié, rien n’est écrit', async () => {
    const w = await world();
    const before = w.copies.parts.size;
    const { COFFRE: _oublie, ...sansCoffre } = sourcesOf(w);
    await expect(copyObjects(sansCoffre, w.copies.store, w.key, w.receipt.copyId)).rejects.toBeInstanceOf(ObjectCopyError);
    expect(w.copies.parts.size).toBe(before);
  });

  it('[R224] un objet abîmé, déplacé ou manquant dans la copie se dit, jamais « restauré »', async () => {
    const w = await world();
    await copyObjects(sourcesOf(w), w.copies.store, w.key, w.receipt.copyId);
    const places = [...w.copies.parts.keys()].filter((k) => /\/objets\/\d{7}$/.test(k)).sort();
    const abime = Uint8Array.from(w.copies.parts.get(places[0]!)!);
    abime[abime.length - 1] = (abime[abime.length - 1] ?? 0) ^ 1;
    w.copies.parts.set(places[0]!, abime);
    w.copies.parts.set(places[1]!, w.copies.parts.get(places[2]!)!);
    w.copies.parts.delete(places[3]!);
    const out = await restoreObjects(freshTargets().targets, w.copies.store, w.key, w.receipt.copyId);
    expect(out.ok).toBe(false);
    if (out.ok || out.code !== 'not_identical') throw new Error('attendu : non identique');
    expect(out.problems.map((p) => p.kind).sort()).toEqual(['object_corrupt', 'object_corrupt', 'object_missing']);
  });

  it('[R224] un stockage neuf qui rend d’autres octets que ceux envoyés : « non identique »', async () => {
    const w = await world();
    await copyObjects(sourcesOf(w), w.copies.store, w.key, w.receipt.copyId);
    const { targets } = freshTargets();
    const menteur = memoryBucket();
    targets.MEDIA = { ...menteur.bucket, get: async (k) => (menteur.objects.has(k) ? { bytes: bytes('autre chose') } : null) };
    const out = await restoreObjects(targets, w.copies.store, w.key, w.receipt.copyId);
    expect(out).toEqual({ ok: false, code: 'not_identical', problems: [{ kind: 'object_differs', storage: 'MEDIA' }, { kind: 'object_differs', storage: 'MEDIA' }] });
  });

  it('[R224] jamais par-dessus un stockage qui contient déjà des objets, ni sans un des stockages', async () => {
    const w = await world();
    await copyObjects(sourcesOf(w), w.copies.store, w.key, w.receipt.copyId);
    const { made, targets } = freshTargets();
    made.PIECES.objects.set('deja-la.pdf', { bytes: bytes('vivant') });
    expect(await restoreObjects(targets, w.copies.store, w.key, w.receipt.copyId)).toEqual({ ok: false, code: 'target_not_empty' });
    expect(made.MEDIA.objects.size).toBe(0);
    const { COFFRE: _c, ...trois } = freshTargets().targets;
    expect(await restoreObjects(trois, w.copies.store, w.key, w.receipt.copyId)).toEqual({ ok: false, code: 'storage_missing' });
  });

  it('[R224] une autre clé ne lit rien ; un objet supprimé pendant la copie est compté, pas inventé', async () => {
    const w = await world();
    const sources = sourcesOf(w);
    const media = sources.MEDIA;
    sources.MEDIA = { ...media, get: async (k) => (k.endsWith('cuisine.jpg') ? null : media.get(k)) };
    expect(await copyObjects(sources, w.copies.store, w.key, w.receipt.copyId)).toMatchObject({ objects: 5, vanished: 1 });
    const other = await copyKeyFromSecret(btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 250 - i))));
    expect(await restoreObjects(freshTargets().targets, w.copies.store, other, w.receipt.copyId)).toEqual({ ok: false, code: 'undecryptable' });
  });

  it('[R224] un fichier cité par la base restaurée mais absent de la copie fait échouer l’exercice', async () => {
    const w = await world();
    await copyObjects(sourcesOf(w), w.copies.store, w.key, w.receipt.copyId);
    const out = await restoreExercise({
      target: emptyDb(),
      targets: freshTargets().targets,
      store: w.copies.store,
      key: w.key,
      copyId: w.receipt.copyId,
      references: async () => [
        { storage: 'MEDIA', key: 'biens/b1/salon.jpg' },
        { storage: 'PIECES', key: 'dossiers/d1/mandat-perdu.pdf' },
      ],
    });
    expect(out).toEqual({ ok: false, part: 'objets', objects: { ok: false, code: 'not_identical', problems: [{ kind: 'reference_missing', storage: 'PIECES' }] } });
  });

  it('[R224] sans lecteur des fichiers cités par la base, l’exercice n’est jamais « restauré », même si la liste des stockages est vide', async () => {
    const w = await world();
    const vides = Object.fromEntries(OBJECT_STORAGES.map((s) => [s, memoryBucket().bucket])) as Record<ObjectStorage, ObjectTarget>;
    expect(await copyObjects(vides, w.copies.store, w.key, w.receipt.copyId)).toMatchObject({ objects: 0 });
    const target = emptyDb();
    const out = await restoreExercise({ target, targets: freshTargets().targets, store: w.copies.store, key: w.key, copyId: w.receipt.copyId, references: null });
    expect(out).toEqual({ ok: false, part: 'objets', objects: { ok: false, code: 'references_unchecked' } });
    // Refusé avant d'écrire : la base neuve reste vide.
    expect(await target.all("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
  });

  it('[R224] les fichiers cités se lisent dans toutes les tables, entiers ou dans un JSON, jamais dans le journal', async () => {
    const db = emptyDb();
    await applyMigrations(db, loadMigrations());
    await db.exec('CREATE TABLE essai_a (ref TEXT, n INTEGER)');
    await db.exec('CREATE TABLE "essai b" (medias TEXT)');
    await db.run('INSERT INTO essai_a (ref, n) VALUES (?, 1), (?, 2), (?, 3), (?, 4)', ['coffre/n1/k1', 'biens/../coffre/x', 'une phrase qui cite biens/b1/a.jpg', 'dossiers/d1/']);
    await db.run('INSERT INTO "essai b" (medias) VALUES (?)', [JSON.stringify([{ ref: 'biens/b2/c.jpg' }, { ref: 'preuves/p.pdf' }])]);
    await appendEvent(new SqlJournalStore(db), { type: 'test.evenement', actor: 'system:test', subject: 'property:b0', data: { ref: 'biens/efface.jpg' } }, () => new Date('2027-01-01T00:00:00.000Z'));
    const refs = (await fileReferences(db)).sort((a, b) => (a.key < b.key ? -1 : 1));
    expect(refs).toEqual([
      { storage: 'MEDIA', key: 'biens/b2/c.jpg' },
      { storage: 'COFFRE', key: 'coffre/n1/k1' },
      { storage: 'PIECES', key: 'preuves/p.pdf' },
    ]);
  });

  it('[R224] garde-fou : chaque début de clé de fichier construit par le code est connu du contrôle des références', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith('.ts')) files.push(join(dir, e.name));
      }
    };
    for (const pkg of ['core/src', 'api/src']) walk(join(root, pkg));
    // Pas des fichiers des stockages : les copies elles-mêmes, et les fichiers publics des ventes (DVF) servis à part.
    const autres = new Set(['copies/', 't/', 'd/', 'candidatures/']);
    const seen = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/`([a-z][a-z0-9-]*\/)\$\{/g)) seen.add(m[1]!);
      for (const m of text.matchAll(/_PREFIX = '([a-z][a-z0-9-]*\/)'/g)) seen.add(m[1]!);
    }
    expect(seen.size).toBeGreaterThan(10);
    expect([...seen].filter((p) => !autres.has(p) && !(p in REFERENCE_PREFIXES)).sort()).toEqual([]);
  });

  it('[R224] dans les vraies tables : le dossier d’un commerce et le coffre, par leur référence de stockage, même libre', async () => {
    const db = emptyDb();
    await applyMigrations(db, loadMigrations());
    await db.exec('PRAGMA foreign_keys = OFF');
    const sha = 'a'.repeat(64);
    await db.run("INSERT INTO business_dossier_documents (id, network_id, property_id, kind, title, storage_ref, content_sha256, added_by, added_at) VALUES ('x1', 'n1', 'p1', 'bilan', 'Bilan', 'commerces/n1/p1/' || ?, ?, 'u1', '2027-01-01'), ('x2', 'n1', 'p1', 'autre', 'Libre', 'depot-libre-42.pdf', ?, 'u1', '2027-01-01')", [sha, sha, sha]);
    await db.run("INSERT INTO compliance_vault_pieces (id, network_id, person_id, kind, storage_ref, sha256, content_type, size_bytes, verified_on, deposited_by, deposited_at) VALUES ('v1', 'n1', 'pe1', 'passeport', 'coffre/n1/v1', ?, 'application/pdf', 10, '2027-01-01', 'u1', '2027-01-01')", [sha]);
    await db.exec('PRAGMA foreign_keys = ON');
    const keys = (await fileReferences(db)).map((r) => r.key).sort();
    expect(keys).toEqual(['coffre/n1/v1', `commerces/n1/p1/${sha}`, 'depot-libre-42.pdf']);
    // La copie a le document libre dans COMMERCES et la pièce du coffre, pas le bilan : « non identique ».
    const w = await world();
    const sources = sourcesOf(w);
    sources.COMMERCES = memoryBucket({ 'depot-libre-42.pdf': { bytes: bytes('libre') } }).bucket;
    sources.COFFRE = memoryBucket({ 'coffre/n1/v1': { bytes: bytes('piece') } }).bucket;
    await copyObjects(sources, w.copies.store, w.key, w.receipt.copyId);
    const out = await restoreObjects(freshTargets().targets, w.copies.store, w.key, w.receipt.copyId, await fileReferences(db));
    expect(out).toEqual({ ok: false, code: 'not_identical', problems: [{ kind: 'reference_missing', storage: 'COMMERCES' }] });
  });
});
