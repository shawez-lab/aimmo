import { expect, it } from 'vitest';
import { AvisDeValeur, FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, Fourchette, type Sale } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé. Clés de test, jamais utilisées ailleurs.
const NOW = () => new Date('2026-10-31T10:00:00.000Z');
const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({ id: `t:${i}`, kind: 'apartment' as const, lat: 47.3225 + i * 0.0002, lon: 5.0412, surface: 60 + i, pricePerM2: 2500 + i * 20, month: `2025-0${(i % 9) + 1}` }));

async function world() {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 65 });
  const avis = new AvisDeValeur(db, new SqlJournalStore(db), { now: NOW });
  const range = await new Fourchette({ coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2025], source: 'DVF test' }), within: async () => SALES }, undefined, NOW).estimate({ kind: 'apartment', surface: 65, lat: 47.3225, lon: 5.0412, postalCode: '21000' });
  if (!range.ok) throw new Error(range.reason);
  const report = await avis.draft({ networkId: net.id, propertyId: property.id, kind: 'apartment', surface: 65, range });
  const keys = { paul: 'p'.repeat(40), lise: 'l'.repeat(40) };
  const apiKeys = JSON.stringify([
    { sha256: await sha256Hex(keys.paul), role: 'agent', userId: paul.id, networkId: net.id },
    { sha256: await sha256Hex(keys.lise), role: 'agent', userId: lise.id, networkId: net.id },
  ]);
  const get = (id: string, key: string) => handleRequest(new Request(`https://aimmo.example.test/v1/avis/${id}/imprimable`, { headers: { authorization: `Bearer ${key}` } }), { db, apiKeys, mode: 'essai', now: NOW });
  return { avis, report, keys, get, paul, net };
}

describeWithSqlite('E08 · route de l’avis imprimable', () => {
  it('[R30] un brouillon est refusé, l’avis validé sort en page HTML fermée', async () => {
    const w = await world();
    const refused = await w.get(w.report.id, w.keys.paul);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ ok: false, rule: 'R30', code: 'not_validated' });

    expect((await w.avis.validate({ role: 'agent', userId: w.paul.id, networkId: w.net.id } as never, w.report.id)).ok).toBe(true);
    const page = await w.get(w.report.id, w.keys.paul);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('Avis de valeur');
  });

  it('[R16] un autre agent est refusé, un avis inconnu n’existe pas', async () => {
    const w = await world();
    await w.avis.validate({ role: 'agent', userId: w.paul.id, networkId: w.net.id } as never, w.report.id);
    const other = await w.get(w.report.id, w.keys.lise);
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ rule: 'R16' });
    expect((await w.get('inconnu', w.keys.paul)).status).toBe(404);
  });
});
