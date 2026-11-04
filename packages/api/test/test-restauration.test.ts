import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigrations, fromSyncSqlite, type RestoreReceipt } from '@aimmo/core';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { monthlyTest, receiptLine } from '../outils/test-restauration.ts';

// Tout est inventé.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));

describeWithSqlite('SV03 · le travail du mois', () => {
  const base = async () => {
    const db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    return db;
  };

  it('[R232] sans copie : le reçu en échec est rangé, et le travail échoue', async () => {
    const db = await base();
    const said: string[] = [];
    const kept: RestoreReceipt[] = [];
    const code = await monthlyTest({ db, secret: SECRET, store: null, fresh: () => fromSyncSqlite(openMemoryDatabase()) }, async (r) => { kept.push(r); }, (t) => said.push(t));
    expect(code).toBe(1);
    expect(kept[0]).toMatchObject({ outcome: 'echouee', reason: 'aucune_copie' });
    expect(said).toEqual(['Restauration ratée : aucune_copie.']);
  });

  it('[R232] un reçu non rangé fait échouer le travail', async () => {
    const db = await base();
    const said: string[] = [];
    const code = await monthlyTest({ db, secret: SECRET, store: null, fresh: () => fromSyncSqlite(openMemoryDatabase()) }, async () => { throw new Error('panne inventée'); }, (t) => said.push(t));
    expect(code).toBe(1);
    expect(said.join(' ')).toContain('Reçu non rangé');
    expect(said.join(' ')).not.toContain('panne inventée');
  });
});

describe('SV03 · le reçu et son travail', () => {
  it('[R232] la sortie ne dit que des nombres et un code', () => {
    expect(receiptLine({ id: 'a', testedAt: 't', month: '2027-03', outcome: 'reussie', copyTakenAt: 'c', durationMs: 12, tables: 3, rows: 4, digest: 'empreinte' })).toBe('Restauration réussie : 3 tables, 4 lignes, 12 ms.');
  });

  it('[R232] chaque mois, depuis main, et rien n’arrive en production', () => {
    const yml = readFileSync(join(import.meta.dirname, '../../../.github/workflows/test-restauration.yml'), 'utf8');
    expect(yml).toContain("github.ref == 'refs/heads/main'");
    expect(yml).toMatch(/cron: '\d+ \d+ 2 \* \*'/);
    expect(yml).not.toMatch(/upload-artifact|d1 execute|d1 export|migrations apply/);
  });
});
