import { expect, it } from 'vitest';
import { fromSyncSqlite, runBatch, type SqlDatabase } from '../src/index.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// J15 · une écriture en lot, tout ou rien.
async function base(): Promise<SqlDatabase> {
  const db = fromSyncSqlite(openMemoryDatabase());
  await db.exec('CREATE TABLE a (id TEXT PRIMARY KEY); CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT NOT NULL REFERENCES a (id));');
  return db;
}

describeWithSqlite('J15 · écriture en lot', () => {
  it('un lot qui réussit garde tout et rend les lignes changées de chaque écriture', async () => {
    const db = await base();
    expect(await runBatch(db, [{ sql: "INSERT INTO a (id) VALUES ('x')" }, { sql: 'INSERT INTO b (id, a_id) VALUES (?, ?)', params: ['y', 'x'] }, { sql: "INSERT OR IGNORE INTO a (id) VALUES ('x')" }])).toEqual([
      { changes: 1 },
      { changes: 1 },
      { changes: 0 },
    ]);
  });

  it('un lot qui échoue en route ne garde rien, et la base reste utilisable', async () => {
    const db = await base();
    await expect(runBatch(db, [{ sql: "INSERT INTO a (id) VALUES ('x')" }, { sql: "INSERT INTO b (id, a_id) VALUES ('y', 'absent')" }])).rejects.toThrow();
    expect(await db.all('SELECT id FROM a')).toEqual([]);
    await db.run("INSERT INTO a (id) VALUES ('z')");
    expect(await db.all('SELECT id FROM a')).toEqual([{ id: 'z' }]);
  });

  it('sans lot dans la base (base de test faite à la main), les écritures passent l’une après l’autre', async () => {
    const real = await base();
    const plain: SqlDatabase = { exec: (s) => real.exec(s), run: (s, p) => real.run(s, p), all: (s, p) => real.all(s, p), first: (s, p) => real.first(s, p) };
    expect(await runBatch(plain, [{ sql: "INSERT INTO a (id) VALUES ('x')" }])).toEqual([{ changes: 1 }]);
  });
});
