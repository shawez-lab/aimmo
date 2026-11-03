import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, appendEvent, copyKeyFromSecret, CopieBase, MemoryJournalStore, restoreCopy, verifyChain, fromSyncSqlite, type CopyStore, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : le réseau, les personnes, le stockage et les clés.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const OTHER = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 200 - i)));
const MARK = 'Inventee-Lisible';

const memoryStore = () => {
  const parts = new Map<string, Uint8Array>();
  const store: CopyStore = {
    put: async (k, b) => {
      parts.set(k, b);
    },
    get: async (k) => parts.get(k) ?? null,
  };
  return { parts, store };
};

const emptyDb = (): SqlDatabase => fromSyncSqlite(openMemoryDatabase());

async function world() {
  const db = emptyDb();
  await applyMigrations(db, loadMigrations());
  const now = () => new Date('2027-03-10T02:00:00.000Z');
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  for (let i = 0; i < 1203; i += 1) {
    const p = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: `Léa"${i}`, lastName: `${MARK}'${i}` });
    if (i % 400 === 0) await appendEvent(journal, { type: 'test.evenement', actor: 'system:test', subject: `person:${p.id}`, data: { i } }, now);
  }
  const { parts, store: copies } = memoryStore();
  const key = await copyKeyFromSecret(SECRET);
  const receipt = await new CopieBase(db, journal, copies, key, { now }).take();
  return { db, journal, parts, copies, key, receipt };
}

const dump = async (db: SqlDatabase) => {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) out[name] = await db.all(`SELECT rowid AS r, * FROM "${name}" ORDER BY rowid`);
  return out;
};

describeWithSqlite('SV01 · copie chiffrée et restauration vérifiée', () => {
  it('[R224] la base restaurée est identique, table par table, objets et chaîne du journal compris, en moins d’une heure', async () => {
    const t = await world();
    const target = emptyDb();
    const r = await restoreCopy(target, t.copies, t.key, t.receipt.copyId);
    expect(r).toMatchObject({ ok: true, copyId: t.receipt.copyId, takenAt: '2027-03-10T02:00:00.000Z', tables: t.receipt.tables, rows: t.receipt.rows });
    if (!r.ok) throw new Error('refus');
    expect(r.durationMs).toBeLessThan(3_600_000);
    // Le journal de la copie la suit : la base restaurée est celle d'avant cette dernière ligne.
    const source = await dump(t.db);
    source['journal'] = (source['journal'] as unknown[]).slice(0, -1);
    expect(await dump(target)).toEqual(source);
    const objects = "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name";
    expect(await target.all(objects)).toEqual(await t.db.all(objects));
    expect((await verifyChain(await new SqlJournalStore(target).all())).ok).toBe(true);
    expect(t.receipt.rows).toBeGreaterThan(1203);
    expect(t.receipt.parts).toBeGreaterThan(2);
  });

  it('[R224] les garde-fous reviennent : la base restaurée refuse d’effacer, et les clés étrangères comptent', async () => {
    const t = await world();
    const target = emptyDb();
    await restoreCopy(target, t.copies, t.key, t.receipt.copyId);
    await expect(target.run('DELETE FROM journal')).rejects.toThrow();
    await expect(target.run("INSERT INTO consents (id, network_id, person_id, purpose, channel, proof, given_at, created_at) VALUES ('c', 'inconnu', 'inconnue', 'x', 'email', 'p', 'd', 'd')")).rejects.toThrow();
  });

  it('[R224] rien de lisible dans le stockage, ni noms ni empreintes', async () => {
    const t = await world();
    const all = [...t.parts.values()].map((b) => Buffer.from(b).toString('latin1')).join('');
    expect(all).not.toContain(MARK);
    expect(all).not.toContain('CREATE TABLE');
    expect(all).not.toContain('digest');
    expect(t.parts.size).toBe(t.receipt.parts + 1);
    // Les noms du stockage ne disent ni les tables ni leur taille.
    for (const name of t.parts.keys()) expect(name).toMatch(/^copies\/\d{8}T\d{6}Z-[0-9a-f]{16}\/(\d{6}|sommaire)$/);
    // Le journal ne porte que des comptes.
    const last = (await new SqlJournalStore(t.db).all()).at(-1)!;
    expect(last.type).toBe('base.copie');
    expect(JSON.stringify(last)).not.toContain(MARK);
  });

  it('[R224] mauvaise clé, morceau changé, déplacé, manquant ou sommaire absent : refus, et la base reste vide', async () => {
    const t = await world();
    const target = emptyDb();
    const empty = async () => expect(await target.all('SELECT name FROM sqlite_master')).toEqual([]);
    expect(await restoreCopy(target, t.copies, await copyKeyFromSecret(OTHER), t.receipt.copyId)).toEqual({ ok: false, code: 'undecryptable' });
    await empty();
    const keys = [...t.parts.keys()].filter((k) => !k.endsWith('/sommaire'));
    const [a, b] = [keys[0]!, keys[1]!];
    const [bytesA, bytesB] = [t.parts.get(a)!, t.parts.get(b)!];

    const changed = Uint8Array.from(bytesA);
    changed[changed.length - 1]! ^= 1;
    t.parts.set(a, changed);
    expect(await restoreCopy(target, t.copies, t.key, t.receipt.copyId)).toEqual({ ok: false, code: 'undecryptable' });
    await empty();

    t.parts.set(a, bytesB);
    expect(await restoreCopy(target, t.copies, t.key, t.receipt.copyId)).toEqual({ ok: false, code: 'undecryptable' });
    await empty();
    t.parts.set(a, bytesA);

    t.parts.delete(a);
    expect(await restoreCopy(target, t.copies, t.key, t.receipt.copyId)).toEqual({ ok: false, code: 'part_missing' });
    await empty();
    t.parts.set(a, bytesA);

    const manifest = [...t.parts.keys()].find((k) => k.endsWith('/sommaire'))!;
    t.parts.delete(manifest);
    expect(await restoreCopy(target, t.copies, t.key, t.receipt.copyId)).toEqual({ ok: false, code: 'manifest_missing' });
    await empty();
    expect(await restoreCopy(target, t.copies, t.key, '../autre')).toEqual({ ok: false, code: 'bad_copy_id' });
  });

  it('[R224] une base non vide est refusée : rien n’est jamais écrasé', async () => {
    const t = await world();
    const before = (await dump(t.db))['persons'];
    expect(await restoreCopy(t.db, t.copies, t.key, t.receipt.copyId)).toEqual({ ok: false, code: 'target_not_empty' });
    expect((await dump(t.db))['persons']).toEqual(before);
  });

  const small = async () => {
    const source = emptyDb();
    await source.exec('CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE enfant (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent (id)); CREATE TABLE compteur (id INTEGER PRIMARY KEY AUTOINCREMENT, texte TEXT);');
    const { store } = memoryStore();
    const key = await copyKeyFromSecret(SECRET);
    return { source, store, key, copy: new CopieBase(source, new MemoryJournalStore(), store, key) };
  };

  it('[R224] une clé étrangère cassée se dit : jamais « restaurée »', async () => {
    const s = await small();
    await s.source.exec('PRAGMA foreign_keys = OFF');
    await s.source.run("INSERT INTO enfant (id, parent_id) VALUES ('e', 'absent')");
    const { copyId } = await s.copy.take();
    const r = await restoreCopy(emptyDb(), s.store, s.key, copyId);
    expect(r).toMatchObject({ ok: false, code: 'not_identical', problems: [{ kind: 'foreign_keys', table: 'enfant' }] });
  });

  it('[R224] une ligne qui arrive différente se dit, table nommée, sans donnée', async () => {
    const s = await small();
    await s.source.run("INSERT INTO parent (id) VALUES ('vrai')");
    const { copyId } = await s.copy.take();
    const raw = emptyDb();
    const altered: SqlDatabase = { ...raw, run: (sql, params = []) => raw.run(sql, params.map((p) => (p === 'vrai' ? 'faux' : p))) };
    const r = await restoreCopy(altered, s.store, s.key, copyId);
    expect(r).toMatchObject({ ok: false, code: 'not_identical', problems: [{ kind: 'table_differs', table: 'parent' }] });
    expect(JSON.stringify(r)).not.toContain('vrai');
  });

  it('[R224] le compteur d’une table reprend où il en était, même après une ligne effacée', async () => {
    const s = await small();
    await s.source.run("INSERT INTO compteur (texte) VALUES ('a')");
    await s.source.run("INSERT INTO compteur (texte) VALUES ('b')");
    await s.source.run('DELETE FROM compteur WHERE id = 2');
    const { copyId } = await s.copy.take();
    const target = emptyDb();
    expect((await restoreCopy(target, s.store, s.key, copyId)).ok).toBe(true);
    await target.run("INSERT INTO compteur (texte) VALUES ('c')");
    expect(await target.first('SELECT id FROM compteur WHERE texte = ?', ['c'])).toEqual({ id: 3 });
  });

  it('[R224] une valeur que la copie ne sait pas relire arrête la copie : pas de sommaire, pas de copie', async () => {
    const s = await small();
    await s.source.exec("INSERT INTO parent (id) VALUES (x'00ff')");
    await expect(s.copy.take()).rejects.toThrow('parent');
  });

  it('[R224] une écriture pendant la copie ne casse pas les clés étrangères : l’enfant est lu avant son parent', async () => {
    const source = emptyDb();
    await source.exec('CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE enfant (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent (id));');
    await source.run("INSERT INTO parent (id) VALUES ('p')");
    await source.run("INSERT INTO enfant (id, parent_id) VALUES ('e', 'p')");
    const { store } = memoryStore();
    const key = await copyKeyFromSecret(SECRET);
    let once = true;
    const during: CopyStore = {
      get: store.get,
      put: async (k, b) => {
        await store.put(k, b);
        if (!once) return;
        once = false;
        await source.run("INSERT INTO parent (id) VALUES ('p2')");
        await source.run("INSERT INTO enfant (id, parent_id) VALUES ('e2', 'p2')");
      },
    };
    const { copyId } = await new CopieBase(source, new MemoryJournalStore(), during, key).take();
    expect((await restoreCopy(emptyDb(), store, key, copyId)).ok).toBe(true);
  });

  it('[R224] un journal falsifié à la source se dit : jamais « restaurée »', async () => {
    const source = emptyDb();
    await source.exec('CREATE TABLE journal (seq INTEGER PRIMARY KEY, at TEXT, type TEXT, actor TEXT, subject TEXT, data TEXT, prev_hash TEXT, hash TEXT);');
    await source.run("INSERT INTO journal VALUES (1, '2027-01-01T00:00:00.000Z', 't', 'a', NULL, '{}', 'x', 'y')");
    const { store } = memoryStore();
    const key = await copyKeyFromSecret(SECRET);
    const { copyId } = await new CopieBase(source, new MemoryJournalStore(), store, key).take();
    expect(await restoreCopy(emptyDb(), store, key, copyId)).toMatchObject({ ok: false, code: 'not_identical', problems: [{ kind: 'journal_chain' }] });
  });

  it('[R224] un objet du schéma absent, une intégrité mauvaise ou une écriture refusée se disent', async () => {
    const s = await small();
    await s.source.exec('CREATE INDEX parent_id_copie ON parent (id);');
    await s.source.run("INSERT INTO parent (id) VALUES ('secret-de-ligne')");
    const { copyId } = await s.copy.take();

    const noIndex = emptyDb();
    const skipping: SqlDatabase = { ...noIndex, run: (sql, params = []) => (sql.startsWith('CREATE INDEX') ? Promise.resolve({ changes: 0 }) : noIndex.run(sql, params)) };
    expect(await restoreCopy(skipping, s.store, s.key, copyId)).toMatchObject({ ok: false, code: 'not_identical', problems: [{ kind: 'schema_differs', name: 'parent_id_copie' }] });

    const damaged = emptyDb();
    const bad: SqlDatabase = { ...damaged, first: (sql, params) => (sql.includes('integrity_check') ? Promise.resolve({ integrity_check: 'abîmée' } as never) : damaged.first(sql, params)) };
    expect(await restoreCopy(bad, s.store, s.key, copyId)).toMatchObject({ ok: false, code: 'not_identical', problems: [{ kind: 'integrity' }] });

    const refusing = emptyDb();
    const refused: SqlDatabase = { ...refusing, run: (sql, params = []) => (sql.startsWith('INSERT') ? Promise.reject(new Error('secret-de-ligne')) : refusing.run(sql, params)) };
    const r = await restoreCopy(refused, s.store, s.key, copyId);
    expect(r).toEqual({ ok: false, code: 'restore_failed' });
    expect(await refusing.all('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });

  it('[R224] une clé qui n’est pas 32 octets en base64 est refusée', async () => {
    await expect(copyKeyFromSecret('court')).rejects.toThrow();
    await expect(copyKeyFromSecret('%%%')).rejects.toThrow();
  });
});
