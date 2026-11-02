import { expect, it } from 'vitest';
import { FicheClient, applyMigrations, fromSyncSqlite, type DetailedSales, type Sale } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé. Clés de test, jamais utilisées ailleurs.
const NOW = () => new Date('2026-10-27T09:00:00.000Z');
const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({ id: `t:${i}`, kind: 'apartment' as const, lat: 47.3225 + i * 0.0002, lon: 5.0412, surface: 60 + i, pricePerM2: 2500 + i * 20, month: `2025-0${(i % 9) + 1}` }));
const sales: DetailedSales = {
  coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2025], source: 'DVF test' }),
  within: async () => SALES,
  scan: async () => ({ sales: SALES, issues: 0 }),
  detail: async () => ({ price: 1, street: 'Rue de la Vente', town: 'Dijon', day: null }),
};
const fetchPublicData = async (url: string) => {
  const body = url.includes('adresse') || url.includes('geopf') && url.includes('search')
    ? { features: [{ geometry: { coordinates: [5.0412, 47.3225] }, properties: { label: 'Essai', postcode: '21000', citycode: '21231', city: 'Dijon', id: 'x', score: 0.9 } }] }
    : {};
  return { ok: true, status: 200, json: async () => body };
};

async function world() {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 65 });
  const keys = { paul: 'p'.repeat(40), lise: 'l'.repeat(40) };
  const apiKeys = JSON.stringify([
    { sha256: await sha256Hex(keys.paul), role: 'agent', userId: paul.id, networkId: net.id },
    { sha256: await sha256Hex(keys.lise), role: 'agent', userId: lise.id, networkId: net.id },
  ]);
  const call = (method: string, path: string, key: string, body?: unknown, wired = true) =>
    handleRequest(
      new Request(`https://aimmo.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
      { db, apiKeys, mode: 'essai', now: NOW, ...(wired ? { estimation: { geocoder: { geocode: async () => null }, sales }, fetchPublicData } : {}) },
    );
  return { keys, property, call };
}

describeWithSqlite('E09 · routes de l’avis de valeur', () => {
  it('[R30] préparer, ajuster, valider, imprimer : le parcours de l’agent', async () => {
    const w = await world();
    const made = await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { address: '1 Rue de l’Essai 21000 Dijon', kind: 'apartment' });
    expect(made.status).toBe(201);
    const { data } = (await made.json()) as { data: { id: string; low: number; high: number; status: string; computedLow: number } };
    expect(data.status).toBe('draft');
    expect(JSON.stringify(data)).not.toContain('figures');

    expect((await w.call('GET', `/avis/${data.id}/imprimable`, w.keys.paul)).status).toBe(403);
    const adjusted = await w.call('POST', `/avis/${data.id}/ajustement`, w.keys.paul, { low: data.low - 1000 });
    expect(adjusted.status).toBe(200);
    expect(((await adjusted.json()) as { data: { low: number; computedLow: number } }).data).toMatchObject({ low: data.low - 1000, computedLow: data.computedLow });

    expect((await w.call('POST', `/avis/${data.id}/validation`, w.keys.lise)).status).toBe(403);
    expect((await w.call('POST', `/avis/${data.id}/validation`, w.keys.paul)).status).toBe(200);
    expect((await w.call('POST', `/avis/${data.id}/validation`, w.keys.paul)).status).toBe(409);
    expect((await w.call('GET', `/avis/${data.id}/imprimable`, w.keys.paul)).status).toBe(200);

    const list = await w.call('GET', `/biens/${w.property.id}/avis`, w.keys.paul);
    expect(((await list.json()) as { data: { id: string; status: string }[] }).data).toMatchObject([{ id: data.id, status: 'validated' }]);
  });

  it('[R16] un autre agent ne lit ni ne prépare ; une saisie fautive est dite', async () => {
    const w = await world();
    expect((await w.call('GET', `/biens/${w.property.id}/avis`, w.keys.lise)).status).toBe(403);
    expect((await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.lise, { address: 'Une adresse', kind: 'house' })).status).toBe(403);
    expect((await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { address: 'x', kind: 'house' })).status).toBe(422);
    expect((await w.call('POST', '/avis/inconnu/validation', w.keys.paul)).status).toBe(404);
    expect((await w.call('POST', '/avis/inconnu/ajustement', w.keys.paul, { low: 'cent' })).status).toBe(400);
  });

  it('sans données branchées, le service le dit et rien n’est rangé', async () => {
    const w = await world();
    const r = await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { address: '1 Rue de l’Essai 21000 Dijon', kind: 'apartment' }, false);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: 'not_configured' });
  });
});
