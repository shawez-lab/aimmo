import { expect, it } from 'vitest';
import {
  Acces,
  AvisImprime,
  FicheClient,
  FicheUnique,
  PreparationAvis,
  SqlJournalStore,
  adjustmentsFor,
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

  it('[R13] [R46] l’adresse sert à la collecte, et n’est ni dans l’avis ni au journal', async () => {
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
    const shop = await w.store.createProperty({ networkId: w.net.id, agentId: w.paul.id, reference: 'B-4', kind: 'commercial', postalCode: '21000', city: 'Dijon', surfaceM2: 90 });
    expect(await w.prep.prepare(w.as('agent', w.paul.id), shop.id, { address: ADDRESS, kind: 'house' })).toMatchObject({ code: 'not_a_home' });
    // AU047 : un terrain se prépare comme terrain, par l'avis motivé de l'agent seulement [R690].
    expect(await w.prep.prepare(w.as('agent', w.paul.id), land.id, { address: ADDRESS, kind: 'house' })).toMatchObject({ code: 'invalid' });
    expect(await w.prep.prepare(w.as('agent', w.paul.id), land.id, { address: ADDRESS, kind: 'land' })).toMatchObject({ rule: 'R27', code: 'type', manualPossible: true });
    expect(await w.prep.prepare(w.as('agent', w.paul.id), empty.id, { address: ADDRESS, kind: 'house' })).toMatchObject({ code: 'no_surface' });
    const closed = await world(null);
    expect(await closed.prep.prepare(closed.as('agent', closed.paul.id), closed.property.id, { address: ADDRESS, kind: 'apartment' })).toMatchObject({ code: 'not_configured' });
  });

  const SHEET = { characteristics: { bedrooms: 2, floor: 2, floorsTotal: 4, buildYear: 1985, heating: null, outdoor: [], landM2: null, parkingSpaces: null, elevator: null }, energy: { energyClass: 'F', climateClass: 'E', annualCostMinEur: 900, annualCostMaxEur: 1200, costReferenceYear: 2024, diagnosedOn: '2024-01-10' }, coownership: null, risks: null, media: [] };
  const withSheet = async (w: Awaited<ReturnType<typeof world>>, sheet: unknown) =>
    w.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', ['s1', w.property.id, w.net.id, JSON.stringify(sheet), 'x', NOW().toISOString()]);
  const adjustments = (computed: string) => (JSON.parse(computed) as { adjustments: { label: string; pct: number }[] }).adjustments;

  it('[R10] le diagnostic de la fiche passe dans le calcul et le texte, avant le public', async () => {
    const withF = await world(services({ publicEnergy: 'B' }));
    await withSheet(withF, SHEET);
    const f = await withF.prep.prepare(withF.as('agent', withF.paul.id), withF.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!f.ok) throw new Error(f.code);
    expect(adjustments(f.value.computed)).toEqual([{ label: 'Diagnostic énergétique', pct: -5 }]);
    expect(f.value.text).toContain('classe F');
    expect(f.value.text).not.toContain('classe B');

    const plain = await world(services({ publicEnergy: 'B' }));
    await withSheet(plain, { ...SHEET, energy: null });
    const none = await plain.prep.prepare(plain.as('agent', plain.paul.id), plain.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!none.ok) throw new Error(none.code);
    expect(f.value.computed_low).toBeLessThan(none.value.computed_low);
  });

  it('[R10] le diagnostic public peut être celui d’un autre lot : ni calcul ni texte pour un appartement', async () => {
    const w = await world(services({ publicEnergy: 'B' }));
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    expect(adjustments(r.value.computed)).toEqual([]);
    expect(r.value.text).not.toContain('Diagnostic énergétique');
    expect(JSON.parse(r.value.computed)).toMatchObject({ energyClass: null, missing: expect.arrayContaining(['energy']) });
  });

  it('[R10] pour une maison, le diagnostic public sert au calcul et au texte', async () => {
    const w = await world(services({ publicEnergy: 'B', sales: SALES.map((x) => ({ ...x, kind: 'house' as const })) }));
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'house' });
    if (!r.ok) throw new Error(r.code);
    expect(adjustments(r.value.computed).map((a) => a.label)).toContain('Diagnostic énergétique');
    expect(r.value.text).toContain('classe B');
  });

  it('[R10] un étage ou un ascenseur inconnus ne baissent pas le prix', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    expect(adjustments(r.value.computed)).toEqual([]);
    expect(r.value.text).not.toContain('rez-de-chaussée');
    const flat = { kind: 'apartment' as const, surface: 65, lat: 1, lon: 1, postalCode: '21000' };
    expect(adjustmentsFor({ ...flat, floor: null }).lines).toEqual([]);
    expect(adjustmentsFor({ ...flat, floor: 5 }).lines).toEqual([]);
    expect(adjustmentsFor({ ...flat, floor: 0 }).lines).toEqual([['Rez-de-chaussée', -0.05]]);
    expect(adjustmentsFor({ ...flat, floor: 5, elevator: false }).lines).toEqual([['Étage élevé sans ascenseur', -0.08]]);
    expect(adjustmentsFor({ ...flat, floor: 5, elevator: true }).lines).toEqual([['Étage élevé avec ascenseur', 0.02]]);
  });

  it('chaque caractéristique de la fiche va à son champ du calcul', () => {
    const features = featuresOf({ ...SHEET, characteristics: { bedrooms: 2, floor: 2, floorsTotal: 4, buildYear: 1960, heating: null, outdoor: ['balcon'], landM2: 300, parkingSpaces: 1, elevator: false } } as never);
    expect(features).toEqual({ era: '1948-1974', floor: 2, buildingFloors: 4, land: 300, balcony: true, terrace: false, parking: true, elevator: false, energyClass: 'F' });
    const other = featuresOf({ ...SHEET, energy: null, characteristics: { ...SHEET.characteristics, outdoor: ['terrasse'], parkingSpaces: 0 } } as never);
    expect(other).toEqual({ era: '1975-2000', floor: 2, buildingFloors: 4, land: null, balcony: false, terrace: true, parking: false });
  });

  it('l’époque vient de l’année de construction', () => {
    expect([eraOf(null), eraOf(1900), eraOf(1948), eraOf(1974), eraOf(1975), eraOf(2000), eraOf(2012), eraOf(2013)]).toEqual([null, 'avant1948', '1948-1974', '1948-1974', '1975-2000', '1975-2000', '2001-2012', 'apres2012']);
    expect(featuresOf(null)).toEqual({});
  });

  it('une source de ventes muette est dite ; un lieu muet laisse la vente sans lieu', async () => {
    const never = new Promise<never>(() => undefined);
    const blocked = services();
    blocked.sales = { ...blocked.sales, within: () => never };
    const w = await world();
    const stuck = new PreparationAvis(w.db, w.acces, w.journal, blocked, { now: NOW, salesTimeoutMs: 20 });
    expect(await stuck.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' })).toEqual({ ok: false, rule: null, code: 'sales_unavailable' });
    expect((await w.journal.all()).some((e) => e.type === 'avis.ventes_indisponibles')).toBe(true);

    const slow = services();
    slow.sales = { ...slow.sales, detail: () => never };
    const late = new PreparationAvis(w.db, w.acces, w.journal, slow, { now: NOW, detailTimeoutMs: 20 });
    const r = await late.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    expect((JSON.parse(r.value.computed) as { cited: { street?: string }[] }).cited.every((c) => c.street === undefined)).toBe(true);
  });

  it('[R691] l’avis dit sa fenêtre de temps et sa raison, et les ventes plus anciennes écartées (AU048)', async () => {
    const old = { ...SALES[0]!, id: 'vieille', month: '2021-06' };
    const w = await world(services({ sales: [...SALES, old] }));
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.text).toContain('Seules les ventes depuis octobre 2023 sont retenues, soit 36 mois. Au-delà de cette fenêtre, les prix ont trop changé');
    expect(r.value.text).toContain('Une vente plus ancienne a été écartée.');
    expect(JSON.parse(r.value.computed)).toMatchObject({ window: { months: 36, from: '2023-10', excludedOld: 1 } });
    expect((JSON.parse(r.value.computed) as { cited: { month: string }[] }).cited.map((c) => c.month)).not.toContain('2021-06');
  });

  it('[R26] préparer n’envoie rien', async () => {
    const w = await world();
    expect((await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' })).ok).toBe(true);
    expect(await w.db.all('SELECT id FROM messages')).toEqual([]);
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

describeWithSqlite('AU052 · l’adresse vérifiée se reprend au prochain avis', () => {
  const OTHER = '9 Avenue de l’Essai 21000 Dijon';
  const kept = (w: Awaited<ReturnType<typeof world>>) => w.db.all<{ version: number; address: string; postal_code: string; set_by: string }>('SELECT version, address, postal_code, set_by FROM valuation_addresses WHERE property_id = ? ORDER BY version', [w.property.id]);

  it('constat : sans adresse, la préparation était refusée ; maintenant l’adresse vérifiée du dernier avis est reprise [R695]', async () => {
    const seen: string[] = [];
    const w = await world(services({ seen }));
    const paul = w.as('agent', w.paul.id);
    expect(await w.prep.prepare(paul, w.property.id, { kind: 'apartment' })).toEqual({ ok: false, rule: null, code: 'address_needed' });
    expect((await w.prep.prepare(paul, w.property.id, { address: ADDRESS, kind: 'apartment' })).ok).toBe(true);
    const again = await w.prep.prepare(paul, w.property.id, { kind: 'apartment' });
    expect(again.ok).toBe(true);
    expect(seen).toEqual([ADDRESS, ADDRESS]);
    expect(await kept(w)).toEqual([{ version: 1, address: ADDRESS, postal_code: '21000', set_by: w.paul.id }]);
  });

  it('[R695] une autre adresse donnée la remplace par une nouvelle version ; la même ne fait rien de plus', async () => {
    const seen: string[] = [];
    const w = await world(services({ seen }));
    const paul = w.as('agent', w.paul.id);
    await w.prep.prepare(paul, w.property.id, { address: ADDRESS, kind: 'apartment' });
    await w.prep.prepare(paul, w.property.id, { address: ADDRESS, kind: 'apartment' });
    await w.prep.prepare(paul, w.property.id, { address: OTHER, kind: 'apartment' });
    await w.prep.prepare(paul, w.property.id, { address: '', kind: 'apartment' });
    expect(seen.at(-1)).toBe(OTHER);
    expect((await kept(w)).map((k) => [k.version, k.address])).toEqual([[1, ADDRESS], [2, OTHER]]);
    await expect(w.db.run("UPDATE valuation_addresses SET address = 'x'")).rejects.toThrow(/ne change pas/);
    await expect(w.db.run('DELETE FROM valuation_addresses')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R695] une adresse non vérifiée n’est pas gardée', async () => {
    for (const s of [services({ score: 0.2 }), services({ postalCode: '75001' })]) {
      const w = await world(s);
      expect((await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' })).ok).toBe(false);
      expect(await kept(w)).toEqual([]);
    }
  });

  it('[R695] sans avis précédent, l’adresse de la dernière désignation du mandat est reprise', async () => {
    const seen: string[] = [];
    const w = await world(services({ seen }));
    await w.db.run("INSERT INTO property_designations (id, network_id, property_id, version, street, postal_code, city, parcels, set_by, set_at) VALUES ('d1', ?, ?, 1, '4 Rue du Mandat', '21000', 'Dijon', '[]', 'x', ?)", [w.net.id, w.property.id, NOW().toISOString()]);
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { kind: 'apartment' });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['4 Rue du Mandat 21000 Dijon']);
    // Reprise, elle n'est pas gardée une seconde fois : la désignation reste sa source.
    expect(await kept(w)).toEqual([]);
  });

  it('[R13] [R46] [R16] l’adresse gardée n’est ni dans l’avis ni au journal, et seul l’agent qui suit le bien s’en sert', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.as('agent', w.paul.id), w.property.id, { address: ADDRESS, kind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    expect(JSON.stringify(r.value)).not.toContain('Essai 21000');
    const journal = await w.journal.all();
    expect(journal.find((e) => e.type === 'avis.adresse_gardee')?.data).toEqual({ replaced: false });
    expect(JSON.stringify(journal)).not.toContain('Rue de l’Essai');
    expect(await w.prep.prepare(w.as('agent', w.lise.id), w.property.id, { kind: 'apartment' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await w.prep.prepare(w.as('direction', 'd1'), w.property.id, { kind: 'apartment' })).toMatchObject({ ok: false, rule: 'R30' });
  });
});
