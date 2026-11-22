import { expect, it } from 'vitest';
import { FicheClient, applyMigrations, fromSyncSqlite, type DetailedSales, type Sale } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé. Clés de test, jamais utilisées ailleurs.
// Chaque lecture de l'heure avance d'une seconde : deux versions n'ont jamais la même date de création.
let tick = 0;
const NOW = () => new Date(Date.parse('2026-10-27T09:00:00.000Z') + 1000 * tick++);
const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({ id: `t:${i}`, kind: 'apartment' as const, lat: 47.3225 + i * 0.0002, lon: 5.0412, surface: 60 + i, pricePerM2: 2500 + i * 20, month: `2025-0${(i % 9) + 1}` }));
const sales: DetailedSales = {
  coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2025], source: 'DVF test' }),
  within: async () => SALES,
  scan: async () => ({ sales: SALES, issues: 0 }),
  detail: async () => ({ price: 1, street: '12 bis Rue de la Vente', town: 'Dijon', day: null }),
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

describeWithSqlite('AU049b · la vue de l’avis montre les ventes citées, les écarts et la version précédente', () => {
  it('[R29] les ventes citées sortent sans nom ni numéro de voie, avec leur identifiant', async () => {
    const w = await world();
    const made = await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { address: '1 Rue de l’Essai 21000 Dijon', kind: 'apartment', condition: 'rafraichir' });
    expect(made.status).toBe(201);
    const { data } = (await made.json()) as { data: { method: string; kind: string; condition: string; cited: { id: string; street: string | null; town: string; month: string; surface: number; pricePerM2: number; distance: number }[]; excluded: unknown[]; previous: string | null } };
    expect(data).toMatchObject({ method: 'computed', kind: 'apartment', condition: 'rafraichir', excluded: [], previous: null });
    expect(data.cited.length).toBeGreaterThan(0);
    for (const c of data.cited) {
      expect(c.id).toMatch(/^t:/);
      expect(c.street).toBe('Rue de la Vente');
      expect(Object.keys(c).sort()).toEqual(['distance', 'id', 'month', 'pricePerM2', 'street', 'surface', 'town']);
    }
    const text = JSON.stringify(data);
    expect(text).not.toContain('12 bis');
    expect(text).not.toContain('Paul');
    expect(text).not.toContain('figures');
  });

  it('[R692] écarter une vente citée donne une nouvelle version ; la précédente reste listée, telle quelle', async () => {
    const w = await world();
    const first = ((await (await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { address: '1 Rue de l’Essai 21000 Dijon', kind: 'apartment', condition: 'travaux' })).json()) as { data: { id: string; low: number; cited: { id: string }[]; adjustments: { label: string; pct: number; source: string }[] } }).data;
    const target = first.cited[0]!.id;
    // Sans adresse ni état : l'adresse vérifiée et l'état de la version précédente sont repris.
    const next = await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { kind: 'apartment', previous: first.id, exclude: [{ id: target, reason: 'prix_aberrant' }] });
    expect(next.status).toBe(201);
    const second = ((await next.json()) as { data: { id: string; previous: string; condition: string; cited: { id: string }[]; excluded: { id: string; reason: string; in: string }[]; adjustments: { label: string; pct: number; source: string }[] } }).data;
    expect(second.id).not.toBe(first.id);
    expect(second.previous).toBe(first.id);
    expect(second.condition).toBe('travaux');
    expect(second.excluded).toMatchObject([{ id: target, reason: 'prix_aberrant', in: first.id }]);
    expect(second.cited.map((c) => c.id)).not.toContain(target);
    expect(second.adjustments.find((a) => a.label === 'État général')).toEqual(first.adjustments.find((a) => a.label === 'État général'));
    const list = ((await (await w.call('GET', `/biens/${w.property.id}/avis`, w.keys.paul)).json()) as { data: { id: string; low: number; excluded: unknown[]; cited: { id: string }[] }[] }).data;
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(list[1]).toMatchObject({ low: first.low, excluded: [] });
    expect(list[1]!.cited.map((c) => c.id)).toContain(target);
  });

  it('[R693] un ajustement retenu par l’agent sort avec sa source et son motif', async () => {
    const w = await world();
    const first = ((await (await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { address: '1 Rue de l’Essai 21000 Dijon', kind: 'apartment' })).json()) as { data: { id: string } }).data;
    const next = await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { kind: 'apartment', previous: first.id, adjust: [{ label: 'Cave', pct: 3, motive: 'visite' }] });
    expect(next.status).toBe(201);
    const second = ((await next.json()) as { data: { adjustments: { label: string; pct: number; source: string; motive: string | null }[] } }).data;
    expect(second.adjustments).toContainEqual({ label: 'Cave', pct: 3, source: 'agent', motive: 'visite' });
    expect(second.adjustments.filter((a) => a.source === 'bareme').every((a) => a.motive === null)).toBe(true);
  });

  it('[R692] un refus est dit par son code : vente non citée, version inconnue', async () => {
    const w = await world();
    const first = ((await (await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { address: '1 Rue de l’Essai 21000 Dijon', kind: 'apartment' })).json()) as { data: { id: string } }).data;
    const bad = await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { kind: 'apartment', previous: first.id, exclude: [{ id: 'pas-citee', reason: 'doublon' }] });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ rule: 'R692', code: 'invalid_exclusion' });
    const gone = await w.call('POST', `/biens/${w.property.id}/avis`, w.keys.paul, { kind: 'apartment', previous: 'inconnue', exclude: [{ id: 't:1', reason: 'doublon' }] });
    expect(await gone.json()).toMatchObject({ rule: 'R692', code: 'unknown_previous' });
  });
});
