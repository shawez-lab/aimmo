import { describe, expect, it } from 'vitest';
import { DvfSiteSales, Fourchette, readableStreet, readableTown, type DvfFileReader } from '../src/index.ts';

// Fichiers inventés au format de `donnees-dvf/` du site : aucune vente réelle.
const STEP = 0.05;
const tileOf = (lat: number, lon: number) => `${Math.floor(lon / STEP)}_${Math.floor(lat / STEP)}`;
const CENTER = { lat: 47.3225, lon: 5.0412 };
const HOME = tileOf(CENTER.lat, CENTER.lon);

function files(): Map<string, string> {
  const rows: unknown[][] = [];
  const details: string[] = [];
  for (let i = 0; i < 14; i++) {
    rows.push([CENTER.lat + i * 0.0002, CENTER.lon, 0, 60 + i, 2500 + i * 10, 202405, 3, 0]);
    details.push(JSON.stringify([150000 + i * 1000, i % 2 ? '12 B RUE DES ESSAIS' : 'AV DE L ESSAI', 'DIJON-SUR-TEST', 1 + i]));
  }
  rows.push([CENTER.lat, CENTER.lon, 1, 110, 2400, 202311, 5, 600]);
  details.push(JSON.stringify([264000, 'CHE DES PRES', 'SAINT-TEST-LES-ESSAIS', 9]));
  rows.push([CENTER.lat, CENTER.lon, 0, 'abc', 2500, 202405, 3, 0]);
  details.push('');
  const index = {
    source: 'DVF test, Licence Ouverte 2.0',
    departement: '21',
    annees: [2023, 2024, 2025],
    derniere_vente: '2025-12-30',
    genere_le: '2026-10-10',
    tuile: STEP,
    tuiles: [HOME, '1_1'],
  };
  return new Map([
    ['index.json', JSON.stringify(index)],
    [`t/${HOME}.json`, JSON.stringify(rows)],
    [`d/${HOME}.txt`, details.join('\n')],
    ['t/1_1.json', '{illisible'],
  ]);
}

function reader(store = files()): DvfFileReader & { calls: string[] } {
  const calls: string[] = [];
  const read = async (path: string) => {
    calls.push(path);
    return store.get(path) ?? null;
  };
  return Object.assign(read, { calls });
}

describe('E02 · ventes DVF du site comme source', () => {
  it('lit l’index et les tuiles du site, ventes du bon type seulement', async () => {
    const src = new DvfSiteSales(reader());
    expect(await src.coverage()).toEqual({ department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test, Licence Ouverte 2.0' });
    const flats = await src.within('apartment', CENTER.lat, CENTER.lon, 500);
    expect(flats).toHaveLength(14);
    expect(flats[0]).toEqual({ id: `${HOME}:0`, kind: 'apartment', lat: CENTER.lat, lon: CENTER.lon, surface: 60, pricePerM2: 2500, month: '2024-05', rooms: 3, land: null });
    const houses = await src.within('house', CENTER.lat, CENTER.lon, 500);
    expect(houses).toEqual([expect.objectContaining({ id: `${HOME}:14`, month: '2023-11', land: 600 })]);
    expect(src.skipped.sales).toBeGreaterThan(0);
  });

  it('ne fait que lire : une seule lecture par fichier, jamais d’autre accès', async () => {
    const read = reader();
    const src = new DvfSiteSales(read);
    await src.within('apartment', CENTER.lat, CENTER.lon, 500);
    await src.within('apartment', CENTER.lat, CENTER.lon, 800);
    await src.detail(`${HOME}:1`);
    await src.detail(`${HOME}:2`);
    expect(read.calls).toEqual(['index.json', `t/${HOME}.json`, `d/${HOME}.txt`]);
  });

  it('une tuile absente ou illisible ne casse rien et est comptée ; sans index, aucune donnée', async () => {
    const store = files();
    store.delete(`t/${HOME}.json`);
    const src = new DvfSiteSales(reader(store));
    expect(await src.within('apartment', CENTER.lat, CENTER.lon, 500)).toEqual([]);
    expect(src.skipped.tiles).toBe(1);
    const bad = new DvfSiteSales(async (path) => (path === 't/1_1.json' ? '{illisible' : null));
    expect(await bad.coverage()).toBeNull();
    const broken = new DvfSiteSales(async () => {
      throw new Error('réseau');
    });
    expect(await broken.coverage()).toBeNull();
    expect(await broken.within('apartment', CENTER.lat, CENTER.lon, 500)).toEqual([]);
  });

  it('[R29] une vente citée n’a ni numéro de voie ni nom', async () => {
    const src = new DvfSiteSales(reader());
    expect(await src.detail(`${HOME}:1`)).toEqual({ price: 151000, street: 'Rue des Essais', town: 'Dijon-sur-Test', day: 2 });
    expect(await src.detail(`${HOME}:0`)).toEqual({ price: 150000, street: 'Avenue de l’Essai'.replace('’', "'"), town: 'Dijon-sur-Test', day: 1 });
    expect(await src.detail(`${HOME}:15`)).toBeNull();
    expect(await src.detail('../../secret:1')).toBeNull();
    expect(await src.detail('9_9:0')).toBeNull();
    for (const raw of ['12 RUE DES ESSAIS', '3 bis AV DU TEST', '7B PL DE LA GARE', '101, BD DU PARC']) expect(readableStreet(raw), raw).not.toMatch(/\d/);
    expect(readableTown('SAINT-TEST-LES-ESSAIS')).toBe('Saint-Test-les-Essais');
  });

  it('sert de source à la fourchette', async () => {
    const r = await new Fourchette(new DvfSiteSales(reader()), undefined, () => new Date('2026-10-27T10:00:00Z')).estimate({
      kind: 'apartment',
      surface: 65,
      lat: CENTER.lat,
      lon: CENTER.lon,
      postalCode: '21000',
      floor: 2,
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.comparables).toHaveLength(14);
    expect(r.latestUsedSale).toBe('2024-05');
    expect(r.data.lastSale).toBe('2025-12-30');
  });
});
