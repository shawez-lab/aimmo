import { expect, it } from 'vitest';
import {
  applyMigrations,
  CopieBase,
  copyKeyFromSecret,
  copyObjects,
  FicheClient,
  fromSyncSqlite,
  OBJECT_STORAGES,
  recordErasure,
  replayErasures,
  restoreExercise,
  restoreWithErasures,
  fileReferences,
  SqlJournalStore,
  verifyChain,
  type ErasureLedgerStore,
  type ObjectStorage,
  type SqlDatabase,
  type StoredObject,
} from '../src/index.ts';
import { eraseForReal, SqlPersonEraser } from '../src/conformite/effacement-reel.ts';
import { sealAt } from '../src/sauvegarde/copie.ts';
import { restoreEverything, type ErasableTarget } from '../src/sauvegarde/restauration-complete.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : le réseau, les personnes, les appels, les fichiers, les stockages et les clés.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 11)));
const TAKEN = new Date('2027-03-10T02:00:00.000Z');
const ERASED = new Date('2027-03-10T12:00:00.000Z');
const RESTORED = new Date('2027-03-11T09:00:00.000Z');

const memoryLedger = () => {
  const parts = new Map<string, Uint8Array>();
  const store: ErasureLedgerStore = {
    put: async (k, b) => {
      parts.set(k, b);
    },
    get: async (k) => parts.get(k) ?? null,
    list: async (prefix) => [...parts.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
  return { parts, store };
};

const memoryBucket = (seed: Record<string, StoredObject> = {}, options: { failRemove?: boolean } = {}) => {
  const objects = new Map<string, StoredObject>(Object.entries(seed));
  const bucket: ErasableTarget = {
    list: async () => [...objects.keys()],
    get: async (k) => objects.get(k) ?? null,
    put: async (k, o) => {
      objects.set(k, { bytes: Uint8Array.from(o.bytes), ...(o.contentType ? { contentType: o.contentType } : {}) });
    },
    remove: async (k) => {
      if (options.failRemove) throw new Error('stockage indisponible');
      objects.delete(k);
    },
  };
  return { objects, bucket };
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const blank = (): SqlDatabase => fromSyncSqlite(openMemoryDatabase());
const tablesOf = async (db: SqlDatabase) => (await db.all<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'"))[0]!.n;

/**
 * Le réseau : Noé, un enregistrement d'appel à lui seul et un autre qu'il partage avec Léa. La copie est prise ; puis
 * Noé est effacé pour de vrai, noté au registre, ses lignes et son fichier retirés de la production.
 */
async function world() {
  const db = blank();
  await applyMigrations(db, loadMigrations());
  const now = () => TAKEN;
  const fiches = new FicheClient(db, { now });
  const network = await fiches.createNetwork('Réseau test');
  const noe = await fiches.createPerson({ networkId: network.id, agentId: null, firstName: 'Noé', lastName: 'Effacé' });
  await fiches.addIdentifier({ networkId: network.id, personId: noe.id, kind: 'email', value: 'noe.efface@example.test' });
  const lea = await fiches.createPerson({ networkId: network.id, agentId: null, firstName: 'Léa', lastName: 'Gardée' });
  const call = async (id: string, personId: string, ref: string) =>
    db.run(
      "INSERT INTO calls (id, network_id, provider, call_id, status, failure, person_id, consent_given_at, recording_ref, created_at) VALUES (?, ?, 'essai', ?, 'impossible', 'echec', ?, ?, ?, ?)",
      [id, network.id, id, personId, TAKEN.toISOString(), ref, TAKEN.toISOString()],
    );
  await call('appel-noe', noe.id, 'boite/appels/noe-seul.ogg');
  await call('appel-noe-2', noe.id, 'boite/appels/partage.ogg');
  await call('appel-lea', lea.id, 'boite/appels/partage.ogg');
  const live = Object.fromEntries(OBJECT_STORAGES.map((s) => [s, memoryBucket()])) as Record<ObjectStorage, ReturnType<typeof memoryBucket>>;
  live.PIECES.objects.set('boite/appels/noe-seul.ogg', { bytes: bytes('OggS Noé inventé'), contentType: 'audio/ogg' });
  live.PIECES.objects.set('boite/appels/partage.ogg', { bytes: bytes('OggS partagé inventé'), contentType: 'audio/ogg' });
  live.MEDIA.objects.set('biens/b1/salon.jpg', { bytes: bytes('JPEG inventé') });
  const ledger = memoryLedger();
  const key = await copyKeyFromSecret(SECRET);
  const receipt = await new CopieBase(db, new SqlJournalStore(db), ledger.store, key, { now }).take();
  await copyObjects(Object.fromEntries(OBJECT_STORAGES.map((s) => [s, live[s].bucket])), ledger.store, key, receipt.copyId);
  // L'effacement réel, après la copie : noté d'abord, puis fait en production (AU020).
  const entry = { requestId: 'demande-noe', networkId: network.id, personId: noe.id, erasedAt: ERASED.toISOString(), members: [noe.id] };
  await recordErasure(ledger.store, key, entry);
  const done = await eraseForReal(db, [noe.id], { objects: { remove: async (s, k) => live[s].bucket.remove(k) }, target: { requestId: entry.requestId, networkId: network.id, at: entry.erasedAt } });
  expect(done.outcome).toMatchObject({ remaining: [], objectsRemaining: 0 });
  expect(live.PIECES.objects.has('boite/appels/noe-seul.ogg')).toBe(false);
  return { db, network, noe, lea, live, ledger, key, receipt, entry };
}

const fresh = (options: { failRemove?: boolean } = {}) => {
  const made = Object.fromEntries(OBJECT_STORAGES.map((s) => [s, memoryBucket({}, options)])) as Record<ObjectStorage, ReturnType<typeof memoryBucket>>;
  const targets = Object.fromEntries(OBJECT_STORAGES.map((s) => [s, made[s].bucket])) as Record<ObjectStorage, ErasableTarget>;
  return { made, targets };
};

const noeLeft = async (db: SqlDatabase, noeId: string) => ({
  calls: (await db.all<{ id: string }>('SELECT id FROM calls WHERE person_id = ? ORDER BY id', [noeId])).map((r) => r.id),
  name: await db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [noeId]),
});

describeWithSqlite('AU021 · la restauration complète rejoue les effacements avec le véritable effaceur', () => {
  it('[R231] constat reproduit : la base et ses fichiers restaurés font revenir la personne effacée, et le rejeu sans les fichiers ne sait pas finir', async () => {
    const w = await world();
    // L'exercice rend la base et les fichiers de la copie, sans rien rejouer : Noé et son enregistrement reviennent.
    const { made, targets } = fresh();
    const target = blank();
    const exercise = await restoreExercise({ target, targets, store: w.ledger.store, key: w.key, copyId: w.receipt.copyId, references: fileReferences });
    expect(exercise.ok).toBe(true);
    expect(await noeLeft(target, w.noe.id)).toEqual({ calls: ['appel-noe', 'appel-noe-2'], name: { first_name: 'Noé', last_name: 'Effacé' } });
    expect(made.PIECES.objects.has('boite/appels/noe-seul.ogg')).toBe(true);
    // La restauration de la seule base, rejouée par le véritable effaceur sans les stockages : jamais dite finie.
    const baseOnly = await restoreWithErasures(blank(), w.ledger.store, w.key, w.receipt.copyId, new SqlPersonEraser({ objects: null }), { now: () => RESTORED });
    expect(baseOnly).toEqual({ ok: false, code: 'erasures_not_replayed', cause: 'erase_failed', replayed: 0 });
  });

  it('[R231] [R17] base et fichiers restaurés, puis rejeu : rien de ce qui devait disparaître ne revient, le reste est intact', async () => {
    const w = await world();
    const { made, targets } = fresh();
    const target = blank();
    const out = await restoreEverything({ target, targets, store: w.ledger.store, key: w.key, copyId: w.receipt.copyId, now: () => RESTORED });
    expect(out).toMatchObject({ ok: true, takenAt: TAKEN.toISOString(), erasuresReplayed: 1, objects: 3 });
    if (!out.ok) throw new Error(out.part);
    expect(out.erasedRows).toBeGreaterThan(0);
    // Noé : ses appels partis, son nom vidé, son fichier retiré du stockage restauré.
    expect(await noeLeft(target, w.noe.id)).toEqual({ calls: [], name: { first_name: null, last_name: null } });
    expect(made.PIECES.objects.has('boite/appels/noe-seul.ogg')).toBe(false);
    // Le reste comme en production : Léa, son appel, le fichier qu'elle cite encore, la photo du bien.
    expect(await target.all('SELECT id FROM calls ORDER BY id')).toEqual([{ id: 'appel-lea' }]);
    expect(await target.first('SELECT first_name FROM persons WHERE id = ?', [w.lea.id])).toEqual({ first_name: 'Léa' });
    expect([...made.PIECES.objects.keys()]).toEqual(['boite/appels/partage.ogg']);
    expect([...made.MEDIA.objects.keys()]).toEqual(['biens/b1/salon.jpg']);
    // La base restaurée dit la même chose que la production, ligne pour ligne, pour Noé.
    expect(await noeLeft(target, w.noe.id)).toEqual(await noeLeft(w.db, w.noe.id));
    // Le rejeu est au journal, sans donnée de la personne, et la chaîne reste valide.
    const events = await new SqlJournalStore(target).all();
    const replayed = events.filter((e) => e.type === 'rgpd.effacement_rejoue');
    expect(replayed.map((e) => e.subject)).toEqual([`person:${w.noe.id}`]);
    expect(JSON.stringify(replayed)).not.toMatch(/Noé|Effacé|noe\.efface/);
    expect((await verifyChain(events)).ok).toBe(true);
    // Rejouer encore ne change plus rien [R231].
    expect(await replayErasures(target, w.ledger.store, w.key, new SqlPersonEraser({ objects: { remove: (s, k) => targets[s].remove(k) } }), { copyTakenAt: TAKEN.toISOString(), now: () => RESTORED })).toEqual({ ok: true, replayed: 1, erasedRows: 0 });
  });

  it('[R231] un stockage restauré qui ne sait pas retirer un fichier : refusé avant toute écriture', async () => {
    const w = await world();
    const { made, targets } = fresh();
    const target = blank();
    const { remove: _drop, ...noRemove } = targets.PIECES;
    void _drop;
    for (const broken of [{ ...targets, PIECES: noRemove as ErasableTarget }, { ...targets, COFFRE: null }, { MEDIA: targets.MEDIA }]) {
      expect(await restoreEverything({ target, targets: broken, store: w.ledger.store, key: w.key, copyId: w.receipt.copyId, now: () => RESTORED })).toEqual({ ok: false, part: 'objets', code: 'storage_missing' });
    }
    expect(await tablesOf(target)).toBe(0);
    for (const s of OBJECT_STORAGES) expect(made[s].objects.size).toBe(0);
  });

  it('[R231] un fichier qui ne se retire pas du stockage restauré : la restauration n’est pas dite finie', async () => {
    const w = await world();
    const { targets } = fresh({ failRemove: true });
    const out = await restoreEverything({ target: blank(), targets, store: w.ledger.store, key: w.key, copyId: w.receipt.copyId, now: () => RESTORED });
    expect(out).toEqual({ ok: false, part: 'effacements', code: 'erase_failed', replayed: 0 });
  });

  it('[R231] un registre illisible : rien n’est effacé, la restauration n’est pas dite finie', async () => {
    const w = await world();
    const place = 'effacements/20270310T130000000Z-abcdefabcdefabcd';
    await w.ledger.store.put(place, await sealAt(w.key, place, JSON.stringify({ requestId: 'x', networkId: w.network.id, personId: '', erasedAt: ERASED.toISOString() })));
    const { made, targets } = fresh();
    const target = blank();
    const out = await restoreEverything({ target, targets, store: w.ledger.store, key: w.key, copyId: w.receipt.copyId, now: () => RESTORED });
    expect(out).toEqual({ ok: false, part: 'effacements', code: 'ledger_unreadable', replayed: 0 });
    // La base et les stockages restent à jeter : rien n'y a été rejoué, Noé y est encore.
    expect((await noeLeft(target, w.noe.id)).calls).toHaveLength(2);
    expect(made.PIECES.objects.has('boite/appels/noe-seul.ogg')).toBe(true);
  });

  it('[R224] une copie abîmée ou une mauvaise clé : refusée comme par l’exercice, sans rejeu', async () => {
    const w = await world();
    const other = await copyKeyFromSecret(btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 250 - i))));
    const out = await restoreEverything({ target: blank(), targets: fresh().targets, store: w.ledger.store, key: other, copyId: w.receipt.copyId, now: () => RESTORED });
    expect(out).toMatchObject({ ok: false, part: 'base' });
    expect(await restoreEverything({ target: blank(), targets: fresh().targets, store: w.ledger.store, key: w.key, copyId: 'pas-une-copie', now: () => RESTORED })).toMatchObject({ ok: false, part: 'base', code: 'bad_copy_id' });
  });
});
