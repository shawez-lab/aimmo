import { expect, it } from 'vitest';
import { runBatch } from '@aimmo/core';
import { fromD1 } from '../src/d1.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// J15 · sous D1, un lot passe par `batch`, tout ou rien.
describeWithSqlite('J15 · écriture en lot sous D1', () => {
  it('un lot qui échoue en route ne garde rien ; un lot qui réussit garde tout', async () => {
    const db = fromD1(fakeD1(openMemoryDatabase()));
    await db.exec('CREATE TABLE a (id TEXT PRIMARY KEY); CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT NOT NULL REFERENCES a (id));');
    await expect(runBatch(db, [{ sql: 'INSERT INTO a (id) VALUES (?)', params: ['x'] }, { sql: "INSERT INTO b (id, a_id) VALUES ('y', 'absent')" }])).rejects.toThrow();
    expect(await db.all('SELECT id FROM a')).toEqual([]);
    expect(await runBatch(db, [{ sql: 'INSERT INTO a (id) VALUES (?)', params: ['x'] }, { sql: "INSERT INTO b (id, a_id) VALUES ('y', 'x')" }])).toEqual([{ changes: 1 }, { changes: 1 }]);
  });
});
