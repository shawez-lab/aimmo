import { expect, it } from 'vitest';
import {
  Acces,
  AvisImprime,
  FicheClient,
  FicheUnique,
  PreparationAvis,
  SqlJournalStore,
  applyMigrations,
  eraOf,
  featuresOf,
  fromSyncSqlite,
  type CollecteServices,
  type DetailedSales,
  type PreparationServices,
  type Sale,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé.
const NOW = () => new Date('2026-10-27T09:00:00.000Z');
const ADDRESS = '1 Rue de l’Essai 21000 Dijon';
const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({ id: `t:${i}`, kind: 'apartment' as const, lat: 47.3225 + i * 0.0002, lon: 5.0412, surface: 60 + i, pricePerM2: 2500 + i * 20, month: `2025-0${(i % 9) + 1}` }));

function services(overrides: { sales?: Sale[]; postalCode?: string; score?: number; seen?: string[]; publicEnergy?: 'B' | null } = {}): PreparationServices {
  const sales = overrides.sales ?? SALES;
  const salesSource: DetailedSales = {
    coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test' }),
    within: async () => sales,
    scan: async () => ({ sales, issues: 0 }),
    detail: async (id) => (id === 't:1' ? null : { price: 1, street: 'Rue de la Vente', town: 'Dijon', day: null }),
  };
  const collecte: CollecteServices = {
    geocoder: { geocode: async (a) => { overrides.seen?.push(a); return { label: a, lat: 47.3225, lon: 5.0412, postalCode: overrides.postalCode ?? '21000', inseeCode: '21231', town: 'Dijon', banId: null, score: overrides.score ?? 0.9 }; } },
    cadastre: { parcelAt: async () => null },
    energy: { latestFor: async () => (overrides.publicEnergy ? { energyClass: overrides.publicEnergy, ghgClass: null, date: '2024-01-10', diagnosisNumber: null } : null) },
    risks: { risksAt: async () => [] },
  };
  return { collecte, sales: salesSource };
}

async function world(s: PreparationServices | null = services()) {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 65 });
  const journal = new SqlJournalStore(db);
  const acces = new Acces(db, store, new FicheUnique(db, store, { now: NOW }), journal, { now: NOW });
  const prep = new PreparationAvis(db, acces, journal, s, { now: NOW });
  const as = (role: string, id: string) => ({ role, userId: id, networkId: net.id }) as Viewer;
  return { db, store, net, paul, lise, property, journal, acces, prep, as };
}

describeWithSqlite('E09 · l’agent prépare un avis', () => {
  it('[R30] seul l’agent actif qui suit le bien prépare, et le refus est au journal', async () => {
    const w = await world();
    const input = { address: ADDRESS, kind: 'apartment' };
    expect(await w.prep.prepare(w.as('direction', 'd1'), w.property.id, input)).toEqual({ ok: false, rule: 'R30', code: 'not_following_agent' });
    expect(await w.prep.prepare(w.as('agent', w.lise.id), w.property.id, input)).toMatchObject({ ok: false, rule: 'R16' });
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.paul.id]);
    expect((await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, input)).ok).toBe(false);
    const entries = await w.journal.all();
    expect(entries.some((e) => e.type === 'avis.refuse' && e.actor === 'direction:d1')).toBe(true);
    expect((await w.db.all('SELECT id FROM valuation_reports')).length).toBe(0);
  });

  it('[R10] le brouillon vient du calcul, avec les ventes citées', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment', condition: 'bon' });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.status).toBe('draft');
    expect(r.value.computed_low).toBeLessThan(r.value.computed_high);
    const computed = JSON.parse(r.value.computed) as { cited: { street?: string }[] };
    expect(computed.cited.length).toBe(12);
    expect(computed.cited.filter((c) => c.street === undefined)).toHaveLength(1);
  });

  it('[R13] [R46] l’adresse sert à la collecte et n’est gardée nulle part', async () => {
    const seen: string[] = [];
    const w = await world(services({ seen }));
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    expect(seen).toEqual([ADDRESS]);
    expect(JSON.stringify(r.value)).not.toContain('Rue de l’Essai');
    expect(JSON.stringify(await w.journal.all())).not.toContain('Rue de l’Essai');
  });

  it('[R27] sans fourchette possible la raison est dite et rien n’est rangé', async () => {
    const w = await world(services({ sales: SALES.slice(0, 2) }));
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    expect(r).toMatchObject({ ok: false, rule: 'R27', code: 'peu_de_ventes' });
    expect((await w.db.all('SELECT id FROM valuation_reports')).length).toBe(0);
    const entry = (await w.journal.all()).find((e) => e.type === 'avis.sans_fourchette');
    expect(entry?.data).toMatchObject({ rule: 'R27', reason: 'peu_de_ventes' });
  });

  it('une adresse incertaine, d’une autre commune ou une saisie fautive sont refusées', async () => {
    const paul = (w: Awaited<ReturnType<typeof world>>) => w.as('agent', w.paul.id);
    let w = await world(services({ score: 0.2 }));
    expect(await w.prep.prepare(paul(w), w.property.id, { address: ADDRESS, kind: 'apartment' })).toMatchObject({ code: 'address_not_found' });
    w = await world(services({ postalCode: '75001' }));
    expect(await w.prep.prepare(paul(w), w.property.id, { address: ADDRESS, kind: 'apartment' })).toMatchObject({ code: 'other_town' });
    w = await world();
    for (const bad of [{ address: 'x', kind: 'apartment' }, { address: ADDRESS, kind: 'land' }, { address: ADDRESS, kind: 'house', condition: 'superbe' }, { address: 7, kind: 'house' }]) {
      expect(await w.prep.prepare(paul(w), w.property.id, bad)).toMatchObject({ code: 'invalid' });
    }
  });

  it('un bien sans surface, un commerce, ou un service non branché sont dits', async () => {
    const w = await world();
    const land = await w.store.createProperty({ networkId: w.net.id, agentId: w.paul.id, reference: 'B-2', kind: 'land', postalCode: '21000', city: 'Dijon', surfaceM2: 400 });
    const empty = await w.store.createProperty({ networkId: w.net.id, agentId: w.paul.id, reference: 'B-3', kind: 'home', postalCode: '21000', city: 'Dijon' });
    expect(await w.prep.prepare(w.as('agent', w.paul.id), land.id, { address: ADDRESS, kind: 'house' })).toMatchObject({ code: 'not_a_home' });
    expect(await w.prep.prepare(w.as('agent', w.paul.id), empty.id, { address: ADDRESS, kind: 'house' })).toMatchObject({ code: 'no_surface' });
    const closed = await world(null);
    expect(await closed.prep.prepare(closed.as('agent', closed.paul.id), closed.property.id, { address: ADDRESS, kind: 'apartment' })).toMatchObject({ code: 'not_configured' });
  });

  it('[R10] la fiche du bien donne le diagnostic du calcul et du texte, avant les données publiques', async () => {
    const w = await world(services({ publicEnergy: 'B' }));
    const sheet = { characteristics: { bedrooms: 2, floor: 2, floorsTotal: 4, buildYear: 1960, heating: null, outdoor: ['balcon'], landM2: null, parkingSpaces: 1, elevator: true }, energy: { energyClass: 'F', climateClass: 'E', annualCostMinEur: 900, annualCostMaxEur: 1200, costReferenceYear: 2024, diagnosedOn: '2024-01-10' }, coownership: null, risks: null, media: [] };
    await w.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', ['s1', w.property.id, w.net.id, JSON.stringify(sheet), 'x', NOW().toISOString()]);
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    expect(JSON.parse(r.value.computed).energyClass).toBe('F');
    expect(r.value.text).toContain('classe F');
    expect(r.value.text).not.toContain('classe B');
    expect((JSON.parse(r.value.computed) as { adjustments: unknown[] }).adjustments.length).toBeGreaterThan(0);
  });

  it('sans fiche, le diagnostic public sert au calcul et au texte', async () => {
    const w = await world(services({ publicEnergy: 'B' }));
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    expect(JSON.parse(r.value.computed).energyClass).toBe('B');
  });

  it('l’époque et les caractéristiques viennent de la fiche', () => {
    expect([eraOf(null), eraOf(1900), eraOf(1948), eraOf(1974), eraOf(1975), eraOf(2000), eraOf(2012), eraOf(2013)]).toEqual([null, 'avant1948', '1948-1974', '1948-1974', '1975-2000', '1975-2000', '2001-2012', 'apres2012']);
    expect(featuresOf(null)).toEqual({});
  });

  it('[R16] la liste : qui voit le bien en entier, la plus récente d’abord', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    expect(await w.prep.list(w.as('agent', w.paul.id), w.property.id)).toMatchObject({ ok: true, value: [{ id: r.value.id }] });
    expect(await w.prep.list(w.as('direction', 'd1'), w.property.id)).toMatchObject({ ok: true });
    expect(await w.prep.list(w.as('agent', w.lise.id), w.property.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await w.prep.list(w.as('agent', w.paul.id), 'inconnu')).toMatchObject({ ok: false, code: 'unknown' });
  });

  it('du brouillon à la page imprimée, sans rien de plus', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    const imprime = new AvisImprime(w.db, w.acces, w.journal, { now: NOW });
    expect(await imprime.print(w.as('agent', w.paul.id), r.value.id)).toMatchObject({ ok: false, rule: 'R30' });
  });
});
