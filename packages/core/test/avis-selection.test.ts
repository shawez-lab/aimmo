import { expect, it } from 'vitest';
import {
  Acces,
  AvisDeValeur,
  FicheClient,
  FicheUnique,
  PreparationAvis,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type CollecteServices,
  type DetailedSales,
  type PreparationServices,
  type Sale,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU049 : l'agent écarte une vente aberrante, avec un motif, et l'avis est recalculé dans une nouvelle version ; la
// version précédente reste telle quelle [R692]. Tout est inventé.
const NOW = () => new Date('2026-10-27T09:00:00.000Z');
const ADDRESS = '1 Rue de l’Essai 21000 Dijon';
const SALES: Sale[] = [
  ...Array.from({ length: 13 }, (_, i) => ({ id: `t:${i}`, kind: 'apartment' as const, lat: 47.3225 + i * 0.0002, lon: 5.0412, surface: 60 + i, pricePerM2: 2500 + i * 20, month: `2025-0${(i % 9) + 1}` })),
  // Une vente à 9 800 € le m², la plus proche : aberrante.
  { id: 'folle', kind: 'apartment', lat: 47.3225, lon: 5.0412, surface: 64, pricePerM2: 9800, month: '2025-04' },
];

function services(sales: Sale[] = SALES): PreparationServices {
  const salesSource: DetailedSales = {
    coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test' }),
    within: async () => sales,
    scan: async () => ({ sales, issues: 0 }),
    detail: async () => ({ price: 1, street: 'Rue de la Vente', town: 'Dijon', day: null }),
  };
  const collecte: CollecteServices = {
    geocoder: { geocode: async (a) => ({ label: a, lat: 47.3225, lon: 5.0412, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: null, score: 0.9 }) },
    cadastre: { parcelAt: async () => null },
    energy: { latestFor: async () => null },
    risks: { risksAt: async () => [] },
  };
  return { collecte, sales: salesSource };
}

async function world(s: PreparationServices = services()) {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 65 });
  const other = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-2', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 65 });
  const journal = new SqlJournalStore(db);
  const acces = new Acces(db, store, new FicheUnique(db, store, { now: NOW }), journal, { now: NOW });
  const prep = new PreparationAvis(db, acces, journal, s, { now: NOW });
  const as = (role: string, id: string) => ({ role, userId: id, networkId: net.id }) as Viewer;
  const paulV = as('agent', paul.id);
  const first = await prep.prepare(paulV, property.id, { address: ADDRESS, kind: 'apartment' });
  if (!first.ok) throw new Error(first.code);
  return { db, store, net, paul, lise, property, other, journal, acces, prep, as, paulV, first: first.value };
}

type Computed = { cited: { id?: string; pricePerM2: number }[]; excluded: { id: string; reason: string; in: string }[]; previous: string | null; medianPerM2: number };
const computed = (c: string) => JSON.parse(c) as Computed;

describeWithSqlite('AU049 · l’agent écarte une vente et l’avis est recalculé', () => {
  it('constat : la vente aberrante est citée, avec son identifiant pour pouvoir l’écarter', async () => {
    const w = await world();
    const c = computed(w.first.computed);
    expect(c.cited.map((x) => x.id)).toContain('folle');
    expect(c).toMatchObject({ excluded: [], previous: null });
  });

  it('[R692] écarter une vente avec un motif donne une nouvelle version recalculée ; la précédente ne change pas', async () => {
    const w = await world();
    const before = await w.db.first<Record<string, unknown>>('SELECT * FROM valuation_reports WHERE id = ?', [w.first.id]);
    const r = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', previous: w.first.id, exclude: [{ id: 'folle', reason: 'prix_aberrant' }] });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.id).not.toBe(w.first.id);
    const c = computed(r.value.computed);
    expect(c.cited.map((x) => x.id)).not.toContain('folle');
    expect(c.excluded).toEqual([{ id: 'folle', reason: 'prix_aberrant', month: '2025-04', surface: 64, pricePerM2: 9800, in: w.first.id }]);
    expect(c.previous).toBe(w.first.id);
    expect(r.value.computed_high).toBeLessThanOrEqual(w.first.computed_high);
    expect(r.value.text).toContain('Votre agent a écarté une vente du calcul : prix aberrant.');
    // La sélection précédente est gardée, telle quelle.
    expect(await w.db.first('SELECT * FROM valuation_reports WHERE id = ?', [w.first.id])).toEqual(before);
    expect((await w.db.all('SELECT id FROM valuation_reports WHERE property_id = ?', [w.property.id])).length).toBe(2);
  });

  it('[R692] les écarts s’ajoutent d’une version à l’autre, et restent dits après une correction du texte', async () => {
    const w = await world();
    const second = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', previous: w.first.id, exclude: [{ id: 'folle', reason: 'prix_aberrant' }] });
    if (!second.ok) throw new Error(second.code);
    const third = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', previous: second.value.id, exclude: [{ id: 't:0', reason: 'bien_different' }, { id: 't:1', reason: 'doublon' }] });
    if (!third.ok) throw new Error(third.code);
    const c = computed(third.value.computed);
    expect(c.excluded.map((e) => [e.id, e.reason, e.in])).toEqual([['folle', 'prix_aberrant', w.first.id], ['t:0', 'bien_different', second.value.id], ['t:1', 'doublon', second.value.id]]);
    expect(c.cited.map((x) => x.id)).not.toEqual(expect.arrayContaining(['folle']));
    expect(c.cited.some((x) => x.id === 't:0' || x.id === 't:1')).toBe(false);
    expect(third.value.text).toContain('Votre agent a écarté 3 ventes du calcul : prix aberrant, bien trop différent, vente en double.');
    const edited = await new AvisDeValeur(w.db, w.journal, { now: NOW }).adjust(w.paulV, third.value.id, { text: `Votre appartement vaut entre ${third.value.text.match(/entre ([\d  ]+ €) et ([\d  ]+ €)/)?.slice(1).join(' et ')}.` });
    if (!edited.ok) throw new Error(edited.code);
    expect(edited.value.text).toContain('Votre agent a écarté 3 ventes du calcul');
  });

  it('[R692] [R27] écarter trop de ventes : plus de fourchette, la raison est dite', async () => {
    const few = SALES.slice(0, 6);
    const w = await world(services(few));
    const r = await w.prep.prepare(w.paulV, w.property.id, { address: ADDRESS, kind: 'apartment', previous: w.first.id, exclude: [{ id: 't:0', reason: 'prix_aberrant' }, { id: 't:1', reason: 'prix_aberrant' }] });
    expect(r).toMatchObject({ ok: false, rule: 'R27', code: 'peu_de_ventes', comparablesFound: 4 });
  });

  it('[R692] une vente non citée, un motif hors liste, une version d’un autre bien ou trop d’écarts sont refusés, et rien n’est rangé', async () => {
    const w = await world();
    const base = { address: ADDRESS, kind: 'apartment' };
    const cases: [Record<string, unknown>, string][] = [
      [{ previous: w.first.id, exclude: [{ id: 'inconnue', reason: 'prix_aberrant' }] }, 'invalid_exclusion'],
      [{ previous: w.first.id, exclude: [{ id: 'folle', reason: 'trop cher' }] }, 'invalid_exclusion'],
      [{ previous: w.first.id, exclude: [{ id: 'folle', reason: 'toString' }] }, 'invalid_exclusion'],
      [{ previous: w.first.id, exclude: [{ id: 'folle', reason: 'prix_aberrant' }, { id: 'folle', reason: 'doublon' }] }, 'invalid_exclusion'],
      [{ previous: w.first.id, exclude: [] }, 'invalid_exclusion'],
      [{ previous: w.first.id }, 'invalid_exclusion'],
      [{ exclude: [{ id: 'folle', reason: 'prix_aberrant' }] }, 'unknown_previous'],
      [{ previous: 'inconnu', exclude: [{ id: 'folle', reason: 'prix_aberrant' }] }, 'unknown_previous'],
      [{ previous: w.first.id, exclude: Array.from({ length: 11 }, (_, i) => ({ id: i === 10 ? 'folle' : `t:${i}`, reason: 'doublon' })) }, 'too_many_exclusions'],
    ];
    for (const [extra, code] of cases) {
      expect(await w.prep.prepare(w.paulV, w.property.id, { ...base, ...extra }), code).toEqual({ ok: false, rule: 'R692', code });
    }
    // La version d'un autre bien ne sert pas.
    expect(await w.prep.prepare(w.paulV, w.other.id, { ...base, previous: w.first.id, exclude: [{ id: 'folle', reason: 'prix_aberrant' }] })).toEqual({ ok: false, rule: 'R692', code: 'unknown_previous' });
    expect((await w.db.all('SELECT id FROM valuation_reports')).length).toBe(1);
  });

  it('[R30] seul l’agent qui suit le bien recalcule ; la nouvelle version est un brouillon à valider', async () => {
    const w = await world();
    const input = { address: ADDRESS, kind: 'apartment', previous: w.first.id, exclude: [{ id: 'folle', reason: 'prix_aberrant' }] };
    expect(await w.prep.prepare(w.as('agent', w.lise.id), w.property.id, input)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await w.prep.prepare(w.as('direction', 'd1'), w.property.id, input)).toMatchObject({ ok: false, rule: 'R30' });
    const r = await w.prep.prepare(w.paulV, w.property.id, input);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ status: 'draft', validated_by: null });
    const avis = new AvisDeValeur(w.db, w.journal, { now: NOW });
    expect(await avis.releasable(r.value.id)).toMatchObject({ ok: false, code: 'not_validated' });
    expect(await avis.validate(w.paulV, r.value.id)).toMatchObject({ ok: true });
  });
});
