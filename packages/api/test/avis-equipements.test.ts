import { expect, it } from 'vitest';
import { FicheClient, applyMigrations, fromSyncSqlite, type DetailedSales, type Sale } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// AU051 : la piscine, le garage, la cave et le plain-pied dits sur la fiche du bien comptent dans l'avis préparé par
// l'API. Tout est inventé. Clés de test, jamais utilisées ailleurs.
const NOW = () => new Date('2026-10-27T09:00:00.000Z');
const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({ id: `t:${i}`, kind: 'apartment' as const, lat: 47.3225 + i * 0.0002, lon: 5.0412, surface: 60 + i, pricePerM2: 2500 + i * 20, month: `2025-0${(i % 9) + 1}` }));
const sales: DetailedSales = {
  coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2025], source: 'DVF test' }),
  within: async (kind) => SALES.map((s) => ({ ...s, kind })),
  scan: async () => ({ sales: SALES, issues: 0 }),
  detail: async () => ({ price: 1, street: 'Rue de la Vente', town: 'Dijon', day: null }),
};
const fetchPublicData = async (url: string) => {
  const body = url.includes('adresse') || (url.includes('geopf') && url.includes('search'))
    ? { features: [{ geometry: { coordinates: [5.0412, 47.3225] }, properties: { label: 'Essai', postcode: '21000', citycode: '21231', city: 'Dijon', id: 'x', score: 0.9 } }] }
    : {};
  return { ok: true, status: 200, json: async () => body };
};
const CHARACTERISTICS = { bedrooms: 2, floor: 1, floorsTotal: 3, buildYear: 1985, heating: null, outdoor: [], landM2: 600, parkingSpaces: null, elevator: null };

describeWithSqlite('AU051 · les équipements de la fiche passent dans l’avis', () => {
  async function world() {
    const db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const store = new FicheClient(db);
    const net = await store.createNetwork('Réseau test');
    const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
    const key = 'p'.repeat(40);
    const apiKeys = JSON.stringify([{ sha256: await sha256Hex(key), role: 'agent', userId: paul.id, networkId: net.id }]);
    let n = 0;
    /** Un bien de 65 m², avec sa fiche : seuls ses équipements changent d'un bien à l'autre. */
    const prepare = async (kind: 'apartment' | 'house', amenities: string[]) => {
      n += 1;
      const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: `B-${n}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 65 });
      const sheet = { characteristics: { ...CHARACTERISTICS, ...(amenities.length > 0 ? { amenities } : {}) }, energy: null, coownership: null, risks: null, media: [] };
      await db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', [`s${n}`, property.id, net.id, JSON.stringify(sheet), 'x', NOW().toISOString()]);
      const res = await handleRequest(
        new Request(`https://aimmo.example.test/v1/biens/${property.id}/avis`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ address: '1 Rue de l’Essai 21000 Dijon', kind }) }),
        { db, apiKeys, mode: 'essai', now: NOW, estimation: { geocoder: { geocode: async () => null }, sales }, fetchPublicData },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { computedLow: number; computedHigh: number; text: string } }).data;
    };
    return { prepare };
  }

  it('[R694] une maison avec piscine, garage ou de plain-pied vaut plus que la même sans', async () => {
    const w = await world();
    const base = await w.prepare('house', []);
    expect(base.text).not.toMatch(/piscine|garage|plain-pied/);
    for (const [amenity, said] of [['piscine', 'piscine +4 %'], ['garage', 'garage +3 %'], ['plain_pied', 'plain-pied +2 %']] as const) {
      const r = await w.prepare('house', [amenity]);
      expect(r.text, amenity).toContain(said);
      expect(r.computedHigh, amenity).toBeGreaterThan(base.computedHigh);
    }
  });

  it('[R694] un appartement avec cave ou garage vaut plus que le même sans ; la piscine et le plain-pied n’y comptent pas', async () => {
    const w = await world();
    const base = await w.prepare('apartment', []);
    for (const [amenity, said] of [['cave', 'cave +1 %'], ['garage', 'garage ou box +3 %']] as const) {
      const r = await w.prepare('apartment', [amenity]);
      expect(r.text, amenity).toContain(said);
      expect(r.computedHigh, amenity).toBeGreaterThanOrEqual(base.computedHigh);
      expect(r.computedLow + r.computedHigh, amenity).toBeGreaterThan(base.computedLow + base.computedHigh);
    }
    const same = await w.prepare('apartment', ['piscine', 'plain_pied', 'cheminee']);
    expect([same.computedLow, same.computedHigh]).toEqual([base.computedLow, base.computedHigh]);
  });
});
