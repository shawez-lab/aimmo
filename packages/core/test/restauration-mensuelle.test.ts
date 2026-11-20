import { expect, it } from 'vitest';
import { applyMigrations, restoreCopy, copyObjects, OBJECT_STORAGES, type ObjectSource, type ObjectStorage, type StoredObject, CopieBase, copyKeyFromSecret, expectedRestoreMonth, FicheClient, fromSyncSqlite, MemoryJournalStore, RecusRestauration, recordCopyRun, recordRestoreReceipt, RESTORE_LIMIT_MS, runRestoreTest, SqlJournalStore, type CopyStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : le réseau, les personnes, le stockage, les clés.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const OTHER = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 200 - i)));
const MARK = 'Inventee-Lisible';
const direction: Viewer = { role: 'direction', networkId: 'n1', userId: 'd1' };
let clock = new Date('2027-03-02T02:47:00.000Z');
const now = () => clock;
const fresh = () => fromSyncSqlite(openMemoryDatabase());

const memory = () => {
  const parts = new Map<string, Uint8Array>();
  const store: CopyStore = { put: async (k, b) => { parts.set(k, b); }, get: async (k) => parts.get(k) ?? null };
  return { parts, store };
};

async function world(options: { objects?: Partial<Record<ObjectStorage, Record<string, StoredObject>>> | null; cites?: string[] } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  await db.exec('CREATE TABLE essai_fichiers (ref TEXT, liste TEXT)');
  for (const ref of options.cites ?? ['biens/b1/salon.jpg']) await db.run('INSERT INTO essai_fichiers (ref, liste) VALUES (?, ?)', [ref, JSON.stringify([{ kind: 'photo', ref }])]);
  const fiche = new FicheClient(db, { now });
  const network = await fiche.createNetwork('Réseau test');
  const agent = await fiche.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  await fiche.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: MARK });
  const { parts, store } = memory();
  const key = await copyKeyFromSecret(SECRET);
  const receipt = await new CopieBase(db, new MemoryJournalStore(), store, key, { now: () => new Date('2027-03-02T01:23:00.000Z') }).take();
  if (options.objects !== null) await copyObjects(fichiers(options.objects ?? PHOTO), store, key, receipt.copyId);
  const noteCopy = () => recordCopyRun(db, { id: 'r1', startedAt: '2027-03-02T01:23:00.000Z', finishedAt: '2027-03-02T01:25:00.000Z', outcome: 'copiee', copyId: receipt.copyId, tables: receipt.tables, rows: receipt.rows, parts: receipt.parts });
  const journal = new SqlJournalStore(db);
  return { db, parts, store, receipt, noteCopy, journal, recus: new RecusRestauration(db, journal, { now }) };
}

// Les fichiers des quatre stockages, et une table qui cite l'un d'eux.
const fichiers = (seed: Partial<Record<ObjectStorage, Record<string, StoredObject>>> = {}): Record<ObjectStorage, ObjectSource> =>
  Object.fromEntries(OBJECT_STORAGES.map((n) => [n, { list: async () => Object.keys(seed[n] ?? {}), get: async (k: string) => seed[n]?.[k] ?? null }])) as Record<ObjectStorage, ObjectSource>;
const PHOTO = { MEDIA: { 'biens/b1/salon.jpg': { bytes: Uint8Array.from({ length: 700 }, (_, i) => i % 13), contentType: 'image/jpeg' } } };

const ticking = (...values: number[]) => () => values.shift() ?? 0;

describeWithSqlite('SV03 · le test de restauration de chaque mois (Jamais vu)', () => {
  it('[R224] AU019b : une copie de la seule base, sans ses fichiers, n’est pas une restauration réussie', async () => {
    const t = await world({ objects: null });
    await t.noteCopy();
    expect(await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'non_identique' });
  });

  it('[R224] AU019b : un fichier cité par la base, entier ou dans un JSON, et absent de la copie fait échouer le test', async () => {
    for (const cites of [['biens/b1/salon.jpg', 'dossiers/d1/mandat.pdf'], ['coffre/n1/piece.pdf']]) {
      const t = await world({ cites });
      await t.noteCopy();
      expect(await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'non_identique' });
    }
  });

  it('[R224] AU019b : un fichier abîmé dans la copie fait échouer le test ; l’empreinte du reçu couvre aussi les fichiers', async () => {
    const t = await world();
    await t.noteCopy();
    const ok = await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now });
    expect(ok.outcome).toBe('reussie');
    if (ok.outcome !== 'reussie') throw new Error('attendu : réussi');
    const baseSeule = await restoreCopy(fresh(), t.store, await copyKeyFromSecret(SECRET), t.receipt.copyId);
    if (!baseSeule.ok) throw new Error('attendu : base restaurée');
    expect(ok.digest).not.toBe(baseSeule.digest);
    const place = [...t.parts.keys()].find((k) => /\/objets\/\d{7}$/.test(k))!;
    const abime = Uint8Array.from(t.parts.get(place)!);
    abime[20] = (abime[20] ?? 0) ^ 1;
    t.parts.set(place, abime);
    expect(await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'non_identique' });
  });

  it('[R232] la dernière copie se restaure : le reçu dit sa date, sa durée, ses comptes et une empreinte, et la direction le lit', async () => {
    const t = await world();
    await t.noteCopy();
    const r = await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now, clock: ticking(1_000, 13_000) });
    expect(r).toMatchObject({ outcome: 'reussie', month: '2027-03', copyTakenAt: '2027-03-02T01:23:00.000Z', durationMs: 12_000, tables: t.receipt.tables, rows: t.receipt.rows });
    if (r.outcome !== 'reussie') throw new Error('refus');
    expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
    await recordRestoreReceipt(t.db, r);
    clock = new Date('2027-03-20T10:00:00.000Z');
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'reussi', expectedMonth: '2027-03', receipt: { outcome: 'reussie', durationMs: 12_000 } } });
    clock = new Date('2027-03-02T02:47:00.000Z');
  });

  it('[R232] deux tests de la même copie donnent la même empreinte', async () => {
    const t = await world();
    await t.noteCopy();
    const a = await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now });
    const b = await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now });
    expect(a.outcome === 'reussie' && b.outcome === 'reussie' && a.digest === b.digest).toBe(true);
  });

  it('[R232] plus d’une heure, c’est un échec, même identique ; une heure pile passe ; la base refuse un reçu réussi trop long', async () => {
    const t = await world();
    await t.noteCopy();
    const late = await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now, clock: ticking(0, RESTORE_LIMIT_MS + 1) });
    expect(late).toMatchObject({ outcome: 'echouee', reason: 'trop_longue', durationMs: RESTORE_LIMIT_MS + 1 });
    await recordRestoreReceipt(t.db, late);
    expect(await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now, clock: ticking(0, RESTORE_LIMIT_MS) })).toMatchObject({ outcome: 'reussie' });
    await expect(t.db.run("INSERT INTO base_restore_receipts (id, tested_at, month, outcome, copy_taken_at, duration_ms, tables_count, rows_count, digest) VALUES ('x', 'a', '2027-03', 'reussie', 'b', 3600001, 1, 1, 'd')")).rejects.toThrow();
    await expect(t.db.run("INSERT INTO base_restore_receipts (id, tested_at, month, outcome, copy_taken_at, duration_ms, tables_count, rows_count, digest) VALUES ('y', 'a', '2027-03', 'reussie', 'b', 10, 0, 0, 'd')")).rejects.toThrow();
  });

  it('[R232] une copie de plus de 48 heures n’est pas une preuve, même si elle se restaure ; 48 heures pile passent', async () => {
    const t = await world();
    await t.noteCopy();
    const late = () => runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now });
    clock = new Date('2027-03-04T01:23:00.000Z');
    expect(await late()).toMatchObject({ outcome: 'reussie' });
    clock = new Date('2027-03-04T01:23:00.001Z');
    expect(await late()).toMatchObject({ outcome: 'echouee', reason: 'copie_trop_ancienne', copyTakenAt: '2027-03-02T01:23:00.000Z' });
    clock = new Date('2027-03-02T02:47:00.000Z');
  });

  it('[R232] un reçu daté dans le futur ne cache jamais les vrais', async () => {
    const t = await world();
    clock = new Date('2027-03-20T10:00:00.000Z');
    await recordRestoreReceipt(t.db, { id: 'f', testedAt: '2099-01-02T02:47:00.000Z', month: '2099-01', outcome: 'reussie', copyTakenAt: '2099-01-02T01:23:00.000Z', durationMs: 10, tables: 9, rows: 9, digest: 'd' });
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'manquant', receipt: null } });
    await recordRestoreReceipt(t.db, { id: 'g', testedAt: '2027-03-05T02:47:00.000Z', month: '2027-03', outcome: 'echouee', reason: 'non_identique', copyTakenAt: null, durationMs: null, tables: null, rows: null });
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'echec' } });
    clock = new Date('2027-03-02T02:47:00.000Z');
  });

  it('[R232] rien à restaurer, pas de clé, mauvaise clé, pas de stockage, morceau perdu : un échec et sa raison, jamais un vert', async () => {
    const t = await world();
    expect(await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'aucune_copie' });
    await t.noteCopy();
    expect(await runRestoreTest({ db: t.db, secret: '', store: t.store, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'cle_absente' });
    expect(await runRestoreTest({ db: t.db, secret: 'pas-une-cle', store: t.store, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'cle_invalide' });
    expect(await runRestoreTest({ db: t.db, secret: OTHER, store: t.store, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'cle_invalide' });
    expect(await runRestoreTest({ db: t.db, secret: SECRET, store: null, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'stockage_absent' });
    const down: CopyStore = { put: t.store.put, get: async () => { throw new Error(MARK); } };
    const failed = await runRestoreTest({ db: t.db, secret: SECRET, store: down, fresh, now });
    expect(failed).toMatchObject({ outcome: 'echouee', reason: 'stockage_en_panne' });
    expect(JSON.stringify(failed)).not.toContain(MARK);
    // Bonne clé, morceau abîmé : c'est la copie qu'il faut regarder, pas la clé.
    const first = [...t.parts.keys()].find((k) => !k.endsWith('sommaire'))!;
    const whole = t.parts.get(first)!;
    const hurt = whole.slice();
    hurt[hurt.length - 1] = hurt[hurt.length - 1]! ^ 1;
    t.parts.set(first, hurt);
    expect(await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'copie_abimee' });
    t.parts.delete(first);
    expect(await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now })).toMatchObject({ outcome: 'echouee', reason: 'stockage_en_panne' });
  });

  it('[R232] le test touche une base jetable, jamais la production', async () => {
    const t = await world();
    await t.noteCopy();
    const before = await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM persons');
    await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now });
    expect(await t.db.first('SELECT COUNT(*) AS n FROM persons')).toEqual(before);
    const refusing = await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh: () => t.db, now });
    expect(refusing).toMatchObject({ outcome: 'echouee', reason: 'test_echoue' });
  });

  it('[R232] un mois sans reçu se dit, jamais un vert par défaut ; le mois d’avant ne couvre plus le mois en cours après le 3', async () => {
    const t = await world();
    clock = new Date('2027-03-20T10:00:00.000Z');
    expect(await t.recus.status(direction)).toEqual({ ok: true, value: { state: 'manquant', expectedMonth: '2027-03', receipt: null } });
    await recordRestoreReceipt(t.db, { id: 'a', testedAt: '2027-02-02T02:47:00.000Z', month: '2027-02', outcome: 'reussie', copyTakenAt: '2027-02-02T01:23:00.000Z', durationMs: 10, tables: 9, rows: 9, digest: 'd' });
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'manquant', expectedMonth: '2027-03', receipt: { month: '2027-02' } } });
    clock = new Date('2027-03-03T10:00:00.000Z');
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'reussi', expectedMonth: '2027-02' } });
    clock = new Date('2027-03-02T02:47:00.000Z');
  });

  it('[R232] un reçu en échec se dit ; le dernier reçu du mois décide, dans les deux sens', async () => {
    const t = await world();
    clock = new Date('2027-03-20T10:00:00.000Z');
    const failure = (id: string, testedAt: string) => ({ id, testedAt, month: '2027-03', outcome: 'echouee' as const, reason: 'non_identique' as const, copyTakenAt: null, durationMs: null, tables: null, rows: null });
    await recordRestoreReceipt(t.db, failure('a', '2027-03-02T02:47:00.000Z'));
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'echec', receipt: { reason: 'non_identique' } } });
    await recordRestoreReceipt(t.db, { id: 'b', testedAt: '2027-03-05T02:47:00.000Z', month: '2027-03', outcome: 'reussie', copyTakenAt: '2027-03-05T01:23:00.000Z', durationMs: 10, tables: 9, rows: 9, digest: 'd' });
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'reussi' } });
    await recordRestoreReceipt(t.db, failure('c', '2027-03-09T02:47:00.000Z'));
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'echec' } });
    clock = new Date('2027-03-02T02:47:00.000Z');
  });

  it('[R232] le mois attendu : jusqu’au 3 à Paris, le mois d’avant ; dès le 4, le mois en cours ; janvier revient à décembre', () => {
    expect(expectedRestoreMonth(new Date('2027-03-03T22:59:00.000Z'))).toBe('2027-02');
    expect(expectedRestoreMonth(new Date('2027-03-03T23:00:00.000Z'))).toBe('2027-03');
    expect(expectedRestoreMonth(new Date('2027-01-02T10:00:00.000Z'))).toBe('2026-12');
  });

  it('[R232] le reçu ne porte aucune donnée d’un client', async () => {
    const t = await world();
    await t.noteCopy();
    const r = await runRestoreTest({ db: t.db, secret: SECRET, store: t.store, fresh, now });
    await recordRestoreReceipt(t.db, r);
    const stored = JSON.stringify(await t.db.all('SELECT * FROM base_restore_receipts'));
    expect(stored).not.toContain(MARK);
    expect(stored).not.toContain('Léa');
    expect(Object.keys(r).sort()).toEqual(['copyTakenAt', 'digest', 'durationMs', 'id', 'month', 'outcome', 'rows', 'tables', 'testedAt']);
  });

  it('[R16] seule la direction lit le reçu ; un refus va au journal', async () => {
    const t = await world();
    for (const role of ['agent', 'compliance'] as const) expect(await t.recus.status({ role, networkId: 'n1', userId: 'u1' } as Viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'base_restore')).toHaveLength(2);
  });

  it('[R232] un reçu ne se réécrit ni ne s’efface', async () => {
    const t = await world();
    await recordRestoreReceipt(t.db, { id: 'a', testedAt: 'x', month: '2027-03', outcome: 'echouee', reason: 'aucune_copie', copyTakenAt: null, durationMs: null, tables: null, rows: null });
    await expect(t.db.run("UPDATE base_restore_receipts SET month = '2027-04'")).rejects.toThrow(/réécrit/);
    await expect(t.db.run('DELETE FROM base_restore_receipts')).rejects.toThrow(/efface/);
  });
});
