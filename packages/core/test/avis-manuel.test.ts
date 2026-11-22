import { expect, it } from 'vitest';
import {
  Acces,
  AvisDeValeur,
  AvisImprime,
  FicheClient,
  FicheUnique,
  PreparationAvis,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  readManual,
  referencesMedian,
  type CollecteServices,
  type DetailedSales,
  type PreparationServices,
  type Sale,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU046 : en secteur pauvre en ventes publiées ou non couvert, l'agent ouvre un avis motivé avec ses propres ventes
// vérifiées [R690]. Tout est inventé.
const NOW = () => new Date('2026-10-27T09:00:00.000Z');
const ADDRESS = '1 Rue de l’Essai 21000 Dijon';
const FEW: Sale[] = [0, 1].map((i) => ({ id: `t:${i}`, kind: 'apartment' as const, lat: 47.3225, lon: 5.0412, surface: 64, pricePerM2: 2500, month: '2025-05' }));
const MANY: Sale[] = Array.from({ length: 14 }, (_, i) => ({ id: `m:${i}`, kind: 'apartment' as const, lat: 47.3225 + i * 0.0002, lon: 5.0412, surface: 60 + i, pricePerM2: 2500 + i * 20, month: `2025-0${(i % 9) + 1}` }));

/** Trois ventes de l'agent, autour de 2 400 € le m² ; un bien de 65 m² vaut donc 156 000 € environ. */
const REFERENCES = [
  { month: '2026-03', surface: 62, price: 148_800, proof: 'agence', street: 'Rue des Tilleuls', town: 'Dijon' },
  { month: '2025-11', surface: 70, price: 168_000, proof: 'acte', town: 'Dijon' },
  { month: '2024-09', surface: 58, price: 142_100, proof: 'notaire' },
];
const MANUAL = { low: 148_000, high: 164_000, verified: true, references: REFERENCES };

function services(o: { sales?: Sale[]; postalCode?: string; covered?: boolean } = {}): PreparationServices {
  const sales = o.sales ?? FEW;
  const salesSource: DetailedSales = {
    coverage: async () => (o.covered === false ? null : { department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test' }),
    within: async () => sales,
    scan: async () => ({ sales, issues: 0 }),
    detail: async () => ({ price: 1, street: 'Rue de la Vente', town: 'Dijon', day: null }),
  };
  const collecte: CollecteServices = {
    geocoder: { geocode: async (a) => ({ label: a, lat: 47.3225, lon: 5.0412, postalCode: o.postalCode ?? '21000', inseeCode: '21231', town: 'Dijon', banId: null, score: 0.9 }) },
    cadastre: { parcelAt: async () => null },
    energy: { latestFor: async () => null },
    risks: { risksAt: async () => [] },
  };
  return { collecte, sales: salesSource };
}

async function world(s: PreparationServices = services(), postalCode = '21000') {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-1', kind: 'home', postalCode, city: 'Dijon', surfaceM2: 65 });
  const journal = new SqlJournalStore(db);
  const acces = new Acces(db, store, new FicheUnique(db, store, { now: NOW }), journal, { now: NOW });
  const prep = new PreparationAvis(db, acces, journal, s, { now: NOW });
  const as = (role: string, id: string) => ({ role, userId: id, networkId: net.id }) as Viewer;
  return { db, store, net, paul, lise, property, journal, acces, prep, as, paulV: as('agent', paul.id) };
}

describeWithSqlite('AU046 · l’avis motivé par les ventes vérifiées de l’agent', () => {
  it('constat : sans fourchette du calcul, le refus dit que l’avis motivé est possible', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment' });
    expect(r).toEqual({ ok: false, rule: 'R27', code: 'peu_de_ventes', comparablesFound: 2, manualPossible: true });
    expect(await w.db.all('SELECT id FROM valuation_reports')).toEqual([]);
  });

  it('[R690] [R27] en secteur pauvre, l’avis motivé est un brouillon qui dit l’absence de fourchette automatique', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL });
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ status: 'draft', agent_low: 148_000, agent_high: 164_000, computed_low: 148_000, computed_high: 164_000, text_by: 'fallback', validated_by: null });
    expect(r.value.text).toContain('Il n’y a pas de fourchette automatique pour ce bien');
    expect(r.value.text).toContain('trop peu nombreuses');
    expect(r.value.text).toContain('La fourchette est celle de votre agent');
    expect(r.value.text).toContain('3 ventes réelles');
    expect(r.value.text).toContain('148 000 €');
    expect(r.value.text).toContain('164 000 €');
    expect(r.value.text).toContain('mars 2026');
    expect(r.value.text).toContain('ventes réelles que votre agent a vérifiées');
    expect(r.value.text).not.toContain('ventes réelles publiées');
    const computed = JSON.parse(r.value.computed) as Record<string, unknown>;
    // Rien ne fait passer les ventes de l'agent pour des ventes publiées.
    expect(computed).toMatchObject({ method: 'manual', noRangeReason: 'peu_de_ventes', comparablesFound: 2, medianPerM2: null, comparables: 0, cited: [], adjustments: [], referencesMedianPerM2: 2400, latestUsedSale: '2026-03' });
    expect((computed.references as { proofLabel: string }[]).map((x) => x.proofLabel)).toEqual(['Vente conclue par l’agence', 'Acte de vente consulté', 'Référence notariale']);
  });

  it('[R13] le journal dit l’avis motivé, sans chiffre ni lieu', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL });
    if (!r.ok) throw new Error(r.code);
    const entry = (await w.journal.all()).find((e) => e.type === 'avis.brouillon');
    expect(entry?.data).toMatchObject({ manual: true, reason: 'peu_de_ventes' });
    const all = JSON.stringify(await w.journal.all());
    for (const secret of ['148000', '164000', 'Tilleuls', 'Rue de l’Essai']) expect(all).not.toContain(secret);
  });

  it('[R690] hors des départements couverts ou sans données publiées, l’avis motivé est ouvert aussi', async () => {
    const alsace = await world(services({ postalCode: '67000' }), '67000');
    const a = await alsace.prep.prepare(alsace.paulV, alsace.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL });
    if (!a.ok) throw new Error(a.code);
    expect(a.value.text).toContain('ne couvrent pas ce département');
    expect(JSON.parse(a.value.computed)).toMatchObject({ noRangeReason: 'dvf_non_couvert' });

    const empty = await world(services({ covered: false }));
    const e = await empty.prep.prepare(empty.paulV, empty.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL });
    if (!e.ok) throw new Error(e.code);
    expect(JSON.parse(e.value.computed)).toMatchObject({ noRangeReason: 'donnees_absentes' });
  });

  it('[R30] rien ne part avant la validation de l’agent ; validé, la page imprimée montre ses ventes et leur preuve', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL });
    if (!r.ok) throw new Error(r.code);
    const avis = new AvisDeValeur(w.db, w.journal, { now: NOW });
    const imprime = new AvisImprime(w.db, w.acces, w.journal, { now: NOW });
    expect(await avis.releasable(r.value.id)).toMatchObject({ ok: false, rule: 'R30', code: 'not_validated' });
    expect(await imprime.print(w.paulV, r.value.id)).toMatchObject({ ok: false, rule: 'R30' });
    expect(await avis.validate(w.as('agent', w.lise.id), r.value.id)).toMatchObject({ ok: false, code: 'not_following_agent' });
    expect(await avis.validate(w.paulV, r.value.id)).toMatchObject({ ok: true, value: { status: 'validated' } });
    expect(await avis.releasable(r.value.id)).toMatchObject({ ok: true, value: { low: 148_000, high: 164_000 } });
    const page = await imprime.print(w.paulV, r.value.id);
    if (!page.ok) throw new Error(page.code);
    expect(page.html).toContain('Ventes vérifiées par votre agent');
    expect(page.html).toContain('Il n’y a pas de fourchette automatique pour ce bien');
    expect(page.html).toContain('Rue des Tilleuls, Dijon');
    expect(page.html).toContain('Acte de vente consulté');
    expect(page.html).not.toContain('Ventes réelles comparables');
  });

  it('[R30] l’agent corrige le texte de l’avis motivé sous le même contrôle', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL });
    if (!r.ok) throw new Error(r.code);
    const avis = new AvisDeValeur(w.db, w.journal, { now: NOW });
    const ok = await avis.adjust(w.paulV, r.value.id, { text: 'Votre bien se situe entre 148 000 € et 164 000 €, selon 3 ventes que j’ai vérifiées.' });
    expect(ok).toMatchObject({ ok: true, value: { text_by: 'agent' } });
    if (!ok.ok) return;
    // Ce que l'avis motivé doit dire reste, quel que soit le texte de l'agent [R690].
    for (const said of ['Il n’y a pas de fourchette automatique pour ce bien', 'trop peu nombreuses', 'La fourchette est celle de votre agent', '3 ventes réelles', 'ventes réelles que votre agent a vérifiées']) {
      expect(ok.value.text).toContain(said);
    }
    expect(await avis.adjust(w.paulV, r.value.id, { text: 'Votre bien vaut 300 000 €.' })).toMatchObject({ ok: false, code: 'text_refused' });
    const bare = await avis.adjust(w.paulV, r.value.id, { text: 'Votre bien vaut entre 148 000 € et 164 000 €.' });
    if (!bare.ok) throw new Error(bare.code);
    expect(bare.value.text).toContain('Il n’y a pas de fourchette automatique pour ce bien');
    expect(await avis.validate(w.paulV, r.value.id)).toMatchObject({ ok: true });
  });

  it('[R690] un ajustement ne fait pas sortir la fourchette de ce que disent les ventes, ni à la validation', async () => {
    const w = await world();
    const r = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL });
    if (!r.ok) throw new Error(r.code);
    const avis = new AvisDeValeur(w.db, w.journal, { now: NOW });
    expect(await avis.adjust(w.paulV, r.value.id, { low: 300_000, high: 600_000 })).toEqual({ ok: false, rule: 'R30', code: 'invalid_range' });
    expect(await avis.adjust(w.paulV, r.value.id, { low: 300_000, high: 330_000 })).toEqual({ ok: false, rule: 'R30', code: 'invalid_range' });
    expect(await avis.adjust(w.paulV, r.value.id, { low: 120_000, high: 170_000 })).toEqual({ ok: false, rule: 'R30', code: 'invalid_range' });
    const fine = await avis.adjust(w.paulV, r.value.id, { low: 150_000, high: 162_000 });
    expect(fine).toMatchObject({ ok: true, value: { agent_low: 150_000, agent_high: 162_000 } });
    // Une fourchette changée en base, hors de l'ajustement, ne se valide pas.
    await w.db.run('UPDATE valuation_reports SET agent_low = 400000, agent_high = 450000 WHERE id = ?', [r.value.id]);
    expect(await avis.validate(w.paulV, r.value.id)).toEqual({ ok: false, rule: 'R30', code: 'invalid_range' });
  });

  it('[R690] [R29] des ventes mal formées, non déclarées vérifiées ou situées par un numéro sont refusées, et rien n’est rangé', async () => {
    const w = await world();
    const ref = REFERENCES[0]!;
    const cases: [unknown, string][] = [
      [{ ...MANUAL, verified: undefined }, 'not_verified'],
      [{ ...MANUAL, verified: 'oui' }, 'not_verified'],
      [{ ...MANUAL, references: REFERENCES.slice(0, 2) }, 'invalid_references'],
      [{ ...MANUAL, references: Array.from({ length: 21 }, () => ref) }, 'invalid_references'],
      [{ ...MANUAL, references: [...REFERENCES.slice(1), { ...ref, month: '2026-11' }] }, 'invalid_references'],
      [{ ...MANUAL, references: [...REFERENCES.slice(1), { ...ref, month: '2021-09' }] }, 'invalid_references'],
      [{ ...MANUAL, references: [...REFERENCES.slice(1), { ...ref, month: '2026-13' }] }, 'invalid_references'],
      [{ ...MANUAL, references: [...REFERENCES.slice(1), { ...ref, street: '12 rue des Tilleuls' }] }, 'invalid_references'],
      [{ ...MANUAL, references: [...REFERENCES.slice(1), { ...ref, town: '<b>Dijon</b>' }] }, 'invalid_references'],
      [{ ...MANUAL, references: [...REFERENCES.slice(1), { ...ref, proof: 'souvenir' }] }, 'invalid_references'],
      [{ ...MANUAL, references: [...REFERENCES.slice(1), { ...ref, proof: 'toString' }] }, 'invalid_references'],
      [{ ...MANUAL, references: [...REFERENCES.slice(1), { ...ref, price: 148_800.5 }] }, 'invalid_references'],
      [{ ...MANUAL, references: [...REFERENCES.slice(1), { ...ref, surface: 0 }] }, 'invalid_references'],
      [{ ...MANUAL, references: 'trois ventes' }, 'invalid_references'],
      [[MANUAL], 'invalid_references'],
      [{ ...MANUAL, low: 164_000, high: 148_000 }, 'invalid_range'],
      [{ ...MANUAL, low: 120_000, high: 170_000 }, 'invalid_range'],
      [{ ...MANUAL, low: 148_000.5 }, 'invalid_range'],
      [{ ...MANUAL, low: 240_000, high: 260_000 }, 'range_far_from_references'],
      [{ ...MANUAL, low: 90_000, high: 100_000 }, 'range_far_from_references'],
    ];
    for (const [manual, code] of cases) {
      expect(await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', manual }), code).toEqual({ ok: false, rule: 'R690', code });
    }
    expect(await w.db.all('SELECT id FROM valuation_reports')).toEqual([]);
  });

  it('[R27] quand le calcul donne une fourchette, une fourchette saisie à côté est refusée', async () => {
    const w = await world(services({ sales: MANY }));
    expect(await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL })).toEqual({ ok: false, rule: 'R690', code: 'range_available' });
    expect(await w.db.all('SELECT id FROM valuation_reports')).toEqual([]);
    expect((await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment' })).ok).toBe(true);
  });

  it('[R30] seul l’agent actif qui suit le bien ouvre un avis motivé', async () => {
    const w = await world();
    expect(await w.prep.prepare(w.as('direction', 'd1'), w.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL })).toMatchObject({ ok: false, rule: 'R30' });
    expect(await w.prep.prepare(w.as('agent', w.lise.id), w.property.id, { address: ADDRESS, kind: 'apartment', manual: MANUAL })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await w.db.all('SELECT id FROM valuation_reports')).toEqual([]);
  });

  it('les ventes sont lues proprement : du plus récent au plus ancien, médiane au m²', () => {
    const r = readManual(MANUAL, NOW());
    if (!r.ok) throw new Error(r.code);
    expect(r.value.references.map((x) => x.month)).toEqual(['2026-03', '2025-11', '2024-09']);
    expect(r.value.references.map((x) => x.pricePerM2)).toEqual([2400, 2400, 2450]);
    expect(referencesMedian(r.value.references)).toBe(2400);
    expect(referencesMedian([...r.value.references.slice(0, 1), { ...r.value.references[2]! }])).toBe(2425);
  });
});

describeWithSqlite('AU047 · l’avis d’un terrain et d’un immeuble', () => {
  const LAND_REFS = [
    { month: '2026-02', surface: 780, price: 93_600, proof: 'acte', town: 'Fontaine-lès-Dijon' },
    { month: '2025-06', surface: 900, price: 112_500, proof: 'notaire' },
    { month: '2024-12', surface: 650, price: 78_000, proof: 'agence' },
  ];
  const BUILDING_REFS = [
    { month: '2026-01', surface: 310, price: 589_000, proof: 'acte', street: 'Rue des Forges' },
    { month: '2025-04', surface: 280, price: 518_000, proof: 'confrere' },
    { month: '2024-10', surface: 350, price: 630_000, proof: 'notaire' },
  ];

  async function withKind(kind: 'land' | 'building', surfaceM2: number) {
    const w = await world();
    const p = await w.store.createProperty({ networkId: w.net.id, agentId: w.paul.id, reference: `B-${kind}`, kind, postalCode: '21000', city: 'Dijon', surfaceM2 });
    return { ...w, p };
  }

  it('constat : un terrain ou un immeuble n’avait aucun avis ; sans ventes de l’agent, la raison est dite et rien n’est rangé', async () => {
    for (const kind of ['land', 'building'] as const) {
      const w = await withKind(kind, 800);
      expect(await w.prep.prepare(w.paulV, w.p.id, { address: ADDRESS, kind })).toEqual({ ok: false, rule: 'R27', code: 'type', comparablesFound: 0, manualPossible: true });
      expect(await w.db.all('SELECT id FROM valuation_reports')).toEqual([]);
      expect((await w.journal.all()).find((e) => e.type === 'avis.sans_fourchette')?.data).toMatchObject({ rule: 'R27', reason: 'type' });
    }
  });

  it('[R690] un terrain : avis motivé au prix du m² de terrain, validé puis imprimé', async () => {
    const w = await withKind('land', 800);
    const r = await w.prep.prepare(w.paulV, w.p.id, { address: ADDRESS, kind: 'land', manual: { low: 90_000, high: 104_000, verified: true, references: LAND_REFS } });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.text).toContain('Pour votre terrain de 800 m² à Dijon, votre agent estime la valeur entre 90 000 € et 104 000 €.');
    expect(r.value.text).toContain('le calcul automatique ne traite que les appartements et les maisons');
    expect(JSON.parse(r.value.computed)).toMatchObject({ method: 'manual', kind: 'land', surface: 800, noRangeReason: 'type', referencesMedianPerM2: 120, cited: [], medianPerM2: null, energyClass: null });
    const avis = new AvisDeValeur(w.db, w.journal, { now: NOW });
    expect(await avis.validate(w.paulV, r.value.id)).toMatchObject({ ok: true });
    const page = await new AvisImprime(w.db, w.acces, w.journal, { now: NOW }).print(w.paulV, r.value.id);
    if (!page.ok) throw new Error(page.code);
    expect(page.html).toContain('Ventes vérifiées par votre agent');
    expect(page.html).toContain('Fontaine-lès-Dijon');
  });

  it('[R690] un immeuble : avis motivé sur ses ventes vérifiées ; la fourchette suit les ventes', async () => {
    const w = await withKind('building', 300);
    const manual = { low: 540_000, high: 600_000, verified: true, references: BUILDING_REFS };
    const r = await w.prep.prepare(w.paulV, w.p.id, { address: ADDRESS, kind: 'building', manual });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.text).toContain('Pour votre immeuble de 300 m²');
    expect(JSON.parse(r.value.computed)).toMatchObject({ kind: 'building', referencesMedianPerM2: 1850 });
    expect(await w.prep.prepare(w.paulV, w.p.id, { address: ADDRESS, kind: 'building', manual: { ...manual, low: 900_000, high: 1_000_000 } })).toEqual({ ok: false, rule: 'R690', code: 'range_far_from_references' });
    expect(await w.prep.prepare(w.paulV, w.p.id, { address: ADDRESS, kind: 'apartment', manual })).toMatchObject({ code: 'invalid' });
    expect(await w.prep.prepare(w.paulV, w.p.id, { address: ADDRESS, kind: 'land', manual })).toMatchObject({ code: 'invalid' });
  });

  it('[R690] un terrain à moins d’un euro le m² garde ses centimes, du contrôle de la fourchette au texte', async () => {
    const w = await withKind('land', 5000);
    const cheap = [0, 1, 2].map((i) => ({ month: `2025-0${i + 1}`, surface: 5000, price: 3_000, proof: 'acte' }));
    expect(await w.prep.prepare(w.paulV, w.p.id, { address: ADDRESS, kind: 'land', manual: { low: 4_500, high: 5_500, verified: true, references: cheap } })).toEqual({ ok: false, rule: 'R690', code: 'range_far_from_references' });
    const r = await w.prep.prepare(w.paulV, w.p.id, { address: ADDRESS, kind: 'land', manual: { low: 2_800, high: 3_400, verified: true, references: cheap } });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.text).toContain('Leur prix médian est de 0,6 € le m².');
    expect(JSON.parse(r.value.computed)).toMatchObject({ referencesMedianPerM2: 0.6 });
    const avis = new AvisDeValeur(w.db, w.journal, { now: NOW });
    expect(await avis.adjust(w.paulV, r.value.id, { low: 4_500, high: 5_500 })).toEqual({ ok: false, rule: 'R30', code: 'invalid_range' });
    expect(await avis.validate(w.paulV, r.value.id)).toMatchObject({ ok: true });
    const page = await new AvisImprime(w.db, w.acces, w.journal, { now: NOW }).print(w.paulV, r.value.id);
    if (!page.ok) throw new Error(page.code);
    expect(page.html).toContain('0,6 €/m²');
  });

  it('[R30] seul l’agent qui suit le terrain ouvre son avis', async () => {
    const w = await withKind('land', 800);
    const manual = { low: 90_000, high: 104_000, verified: true, references: LAND_REFS };
    expect(await w.prep.prepare(w.as('agent', w.lise.id), w.p.id, { address: ADDRESS, kind: 'land', manual })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await w.prep.prepare(w.as('direction', 'd1'), w.p.id, { address: ADDRESS, kind: 'land', manual })).toMatchObject({ ok: false, rule: 'R30' });
    expect(await w.db.all('SELECT id FROM valuation_reports')).toEqual([]);
  });
});
