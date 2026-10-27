import { expect, it } from 'vitest';
import { DvfSiteSales, FicheClient, SqlJournalStore, applyMigrations, type Geocoded, type Geocoder, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés et données inventées pour les tests.
const KEY_EST = 'test-cle-estimation-iiiiiiiiiiiiiiiiiiiiiiiiiiii';
const KEY_CHAT = 'test-cle-assistant-jjjjjjjjjjjjjjjjjjjjjjjjjjjj';
const URL_EST = 'https://aimmo-api.example.workers.dev/v1/estimation/commune';
const VISITOR = 'visiteur-essai-0000000001';
const NOW = () => new Date('2026-10-27T09:00:00.000Z');
const STEP = 0.05;
const CENTER = { lat: 47.3225, lon: 5.0412 };
const tile = `${Math.floor(CENTER.lon / STEP)}_${Math.floor(CENTER.lat / STEP)}`;

function dvfFiles(): Map<string, string> {
  const rows: unknown[][] = [];
  const details: string[] = [];
  for (let i = 0; i < 24; i++) {
    const house = i % 4 === 3;
    rows.push([CENTER.lat + (i % 6) * 0.001, CENTER.lon + Math.floor(i / 6) * 0.001, house ? 1 : 0, 50 + i * 3, 2000 + i * 50, 202401 + (i % 12), 3, house ? 400 : 0]);
    // Deux ventes d'une commune voisine, dans le rayon : elles ne comptent pas.
    details.push(JSON.stringify([100000 + i, 'RUE DE L ESSAI', i < 2 ? 'VOISINE-SUR-TEST' : 'VILLE-TEST', 5]));
  }
  return new Map([
    ['index.json', JSON.stringify({ source: 'DVF test', departement: '21', annees: [2023, 2024, 2025], derniere_vente: '2025-12-30', tuile: STEP, tuiles: [tile] })],
    [`t/${tile}.json`, JSON.stringify(rows)],
    [`d/${tile}.txt`, details.join('\n')],
  ]);
}

class FakeGeocoder implements Geocoder {
  asked: string[] = [];
  async geocode(q: string): Promise<Geocoded | null> {
    this.asked.push(q);
    if (!/21990 Ville-Test/i.test(q)) return null;
    return { label: 'Ville-Test', lat: CENTER.lat, lon: CENTER.lon, postalCode: '21990', inseeCode: '21999', town: 'Ville-Test', banId: null, score: 0.95 };
  }
}

async function world() {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  const net = await new FicheClient(db).createNetwork('Réseau test');
  const intakeKeys = JSON.stringify([
    { sha256: await sha256Hex(KEY_EST), networkId: net.id, source: 'site_estimate' },
    { sha256: await sha256Hex(KEY_CHAT), networkId: net.id, source: 'site_chat' },
  ]);
  const files = dvfFiles();
  const geocoder = new FakeGeocoder();
  const config = {
    db,
    mode: 'essai',
    apiKeys: undefined,
    intakeKeys,
    estimation: { geocoder, sales: new DvfSiteSales(async (p) => files.get(p) ?? null) },
    estimationLimits: { perVisitor: 3, perNetwork: 100 },
    now: NOW,
  };
  const call = async (body: unknown, key = KEY_EST, cfg: Record<string, unknown> = config) => {
    const res = await handleRequest(
      new Request(URL_EST, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      cfg as typeof config,
    );
    return { status: res.status, text: await res.clone().text(), body: (await res.json()) as Record<string, unknown> };
  };
  const ask = (over: Record<string, unknown> = {}) => ({ visitorId: VISITOR, postalCode: '21990', town: 'Ville-Test', kind: 'appartement', ...over });
  return { db, config, call, ask, geocoder, journal: new SqlJournalStore(db) };
}

describeWithSqlite('E05 · estimation en ligne du site', () => {
  it('[R31] rend la fourchette au m² de la commune, ses ventes seulement, et propose un rendez-vous', async () => {
    const w = await world();
    const r = await w.call(w.ask());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      mode: 'essai',
      data: { town: 'Ville-Test', postalCode: '21990', kind: 'apartment', next: 'appointment', data: { lastSale: '2025-12-30', recentMissing: true } },
    });
    const data = r.body['data'] as { sales: number; perM2: { low: number; median: number; high: number }; period: { from: string; to: string } };
    // 18 appartements, dont 2 dans la commune voisine.
    expect(data.sales).toBe(16);
    expect(data.perM2.low).toBeLessThan(data.perM2.median);
    expect(data.perM2.median).toBeLessThan(data.perM2.high);
    expect(data.period.from <= data.period.to).toBe(true);
    // Aucun prix total, aucune donnée de vente individuelle.
    expect(r.text).not.toMatch(/"(price|low|high)"\s*:\s*\d{6,}/);
    expect(r.text).not.toMatch(/surface|Rue de|street|price"/);
  });

  it('[R31] une surface, une adresse ou tout autre champ est refusé : jamais le prix d’un bien précis', async () => {
    const w = await world();
    for (const over of [{ surface: 65 }, { address: '1 rue de l’Essai' }, { lat: 47.3 }, { rooms: 3 }]) {
      const r = await w.call(w.ask(over));
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.body['code']).toBe('unexpected_field');
    }
    expect((await w.call(w.ask({ town: '12 rue de l’Essai' }))).status).toBe(400);
    expect(w.geocoder.asked).toEqual([]);
  });

  it('seuls le code postal et la commune partent au géocodage', async () => {
    const w = await world();
    await w.call(w.ask());
    expect(w.geocoder.asked).toEqual(['21990 Ville-Test']);
  });

  it('sans fourchette possible, la raison et le rendez-vous', async () => {
    const w = await world();
    expect((await w.call(w.ask({ town: 'Inconnue' }))).body).toMatchObject({ ok: true, data: null, reason: 'commune_introuvable', next: 'appointment' });
    expect((await w.call(w.ask({ kind: 'maison' }))).body).toMatchObject({ data: null, reason: 'peu_de_ventes' });
    expect((await w.call(w.ask({ postalCode: '57000', visitorId: 'visiteur-essai-0000000002' }))).body).toMatchObject({ data: null, reason: 'dvf_non_couvert' });
    expect((await w.call(w.ask({ postalCode: '75001', visitorId: 'visiteur-essai-0000000002' }))).body).toMatchObject({ data: null, reason: 'hors_zone' });
  });

  it('[R15] limites par visiteur, rien du visiteur gardé hors de l’empreinte de son identifiant', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) expect((await w.call(w.ask())).status).toBe(200);
    expect((await w.call(w.ask())).status).toBe(429);
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000009' }))).status).toBe(200);
    const dump = JSON.stringify([await w.db.all('SELECT * FROM assistant_calls'), await w.journal.all()]);
    expect(dump).not.toContain(VISITOR);
    expect(dump).not.toContain('Ville-Test');
  });

  it('une limite par réseau, et l’empreinte du visiteur change d’heure en heure', async () => {
    const w = await world();
    const cfg = { ...w.config, estimationLimits: { perVisitor: 10, perNetwork: 2 } };
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000011' }), KEY_EST, cfg)).status).toBe(200);
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000012' }), KEY_EST, cfg)).status).toBe(200);
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000013' }), KEY_EST, cfg)).status).toBe(429);
    const later = { ...cfg, now: () => new Date('2026-10-27T10:00:00.000Z') };
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000011' }), KEY_EST, later)).status).toBe(200);
    const scopes = (await w.db.all<{ scope: string }>("SELECT scope FROM assistant_calls WHERE scope LIKE 'estimation:%' AND scope != 'estimation:reseau'")).map((r) => r.scope);
    // Quatre empreintes : le même visiteur, à deux heures différentes, en a deux qui ne se relient pas.
    expect(new Set(scopes).size).toBe(4);
  });

  it('des ventes illisibles : pas de fourchette faussée, la raison et le nombre au journal', async () => {
    const w = await world();
    const files = dvfFiles();
    files.delete(`d/${tile}.txt`);
    const cfg = { ...w.config, estimation: { geocoder: w.geocoder, sales: new DvfSiteSales(async (p) => files.get(p) ?? null) } };
    expect((await w.call(w.ask(), KEY_EST, cfg)).body).toMatchObject({ data: null, reason: 'donnees_absentes', next: 'appointment' });
    const logged = (await w.journal.all()).filter((e) => e.type === 'estimation.commune');
    expect(logged.at(-1)?.data).toMatchObject({ ok: false, reason: 'donnees_absentes' });
    expect(Number(logged.at(-1)?.data['missingFiles'])).toBeGreaterThan(0);
  });

  it('clé `site_estimate` seulement ; sans données branchées ou hors essai, fermé', async () => {
    const w = await world();
    expect((await w.call(w.ask(), KEY_CHAT)).status).toBe(401);
    const { estimation: _unused, ...closed } = w.config;
    expect((await w.call(w.ask(), KEY_EST, closed)).status).toBe(503);
    expect((await w.call(w.ask(), KEY_EST, { ...w.config, mode: 'reel' })).status).toBe(503);
    const get = await handleRequest(new Request(URL_EST, { headers: { authorization: `Bearer ${KEY_EST}` } }), w.config);
    expect(get.status).toBe(405);
  });
});
