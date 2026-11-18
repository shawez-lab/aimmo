import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import {
  EstimationCommerce,
  FicheCommerce,
  checkScale,
  computeBusinessValuation,
  mulDiv,
  type BusinessSheetVersion,
  type ValuationMethod,
  type ValuationScale,
} from '../src/commerces/index.ts';
import { EMPTY_SHEET, checkSheetChanges, type BusinessSheet } from '../src/commerces/fiche.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const sheetOf = (changes: Partial<BusinessSheet>, version = 1): BusinessSheetVersion => ({
  id: 's',
  propertyId: 'p',
  version,
  sheet: { ...EMPTY_SHEET, fiscalYears: [], equipment: [], licenses: [], ...changes },
  sources: {},
  author: 'agent:a',
  createdAt: '2027-09-07T08:00:00.000Z',
});
const scaleOf = (activity: ValuationScale['activity'], method: ValuationMethod, low: number, high: number): ValuationScale => ({
  id: `b-${activity}`,
  activity,
  method,
  low,
  high,
  source: 'Barème inventé pour les tests, édition 2027',
  sourceDate: '2027-01-15',
  version: 1,
});

/**
 * Cinq commerces inventés et le calcul fait à la main, ligne par ligne (centimes ; arrondi au plus proche, la moitié
 * en s'éloignant de zéro).
 */
const CASES = [
  {
    name: 'boulangerie, 60 à 90 % du chiffre d’affaires moyen',
    kind: 'business' as const,
    method: 'revenue_pct' as const,
    sheet: {
      activity: 'boulangerie_patisserie' as const,
      fiscalYears: [
        { year: 2026, revenueCents: 43_987_600, resultCents: 4_112_300 },
        { year: 2025, revenueCents: 41_234_500, resultCents: 3_876_100 },
        { year: 2024, revenueCents: 39_456_700, resultCents: -1_234_500 },
      ],
    },
    scale: [6_000, 9_000],
    // 43 987 600 + 41 234 500 + 39 456 700 = 124 678 800 ; / 3 = 41 559 600
    base: 41_559_600,
    // 41 559 600 × 6 000 / 10 000 = 24 935 760 ; × 9 000 / 10 000 = 37 403 640
    low: 24_935_760,
    high: 37_403_640,
  },
  {
    name: 'restaurant, 2,5 à 4 fois l’excédent brut d’exploitation moyen',
    kind: 'business' as const,
    method: 'ebitda_multiple' as const,
    sheet: {
      activity: 'restaurant' as const,
      fiscalYears: [
        { year: 2026, revenueCents: 60_000_000, resultCents: 2_100_000, ebitdaCents: 5_000_001 },
        { year: 2025, revenueCents: 58_000_000, resultCents: 1_900_000, ebitdaCents: 4_000_000 },
      ],
    },
    scale: [250, 400],
    // excédents bruts : 5 000 001 + 4 000 000 = 9 000 001 ; / 2 = 4 500 000,5 → 4 500 001
    base: 4_500_001,
    // 4 500 001 × 250 / 100 = 11 250 002,5 → 11 250 003 ; × 400 / 100 = 18 000 004
    low: 11_250_003,
    high: 18_000_004,
  },
  {
    name: 'murs d’une boutique, rendement de 6 à 8 %',
    kind: 'business_walls' as const,
    method: 'rent_yield' as const,
    sheet: { activity: 'habillement' as const, leaseAnnualRentCents: 1_872_300 },
    scale: [600, 800],
    base: 1_872_300,
    // 1 872 300 × 10 000 / 800 = 23 403 750 ; / 600 = 31 205 000
    low: 23_403_750,
    high: 31_205_000,
  },
  {
    name: 'local de bureaux, rendement de 7 à 9 %',
    kind: 'commercial' as const,
    method: 'rent_yield' as const,
    sheet: { activity: 'bureaux' as const, leaseAnnualRentCents: 2_400_001 },
    scale: [700, 900],
    base: 2_400_001,
    // 24 000 010 000 / 900 = 26 666 677,78 → 26 666 678 ; / 700 = 34 285 728,57 → 34 285 729
    low: 26_666_678,
    high: 34_285_729,
  },
  {
    name: 'bar, un seul exercice, 75 à 105 % du chiffre d’affaires',
    kind: 'business' as const,
    method: 'revenue_pct' as const,
    sheet: { activity: 'bar_cafe' as const, fiscalYears: [{ year: 2026, revenueCents: 33_333_333, resultCents: 1_000_000 }] },
    scale: [7_500, 10_500],
    base: 33_333_333,
    // 33 333 333 × 7 500 / 10 000 = 24 999 999,75 → 25 000 000 ; × 10 500 / 10 000 = 34 999 999,65 → 35 000 000
    low: 25_000_000,
    high: 35_000_000,
  },
];

it('[R111] cinq commerces inventés : la fourchette est égale au centime au calcul fait à la main, chaque ligne sourcée', () => {
  for (const c of CASES) {
    const r = computeBusinessValuation(c.kind, sheetOf(c.sheet), c.method, scaleOf(c.sheet.activity, c.method, c.scale[0]!, c.scale[1]!));
    expect(r.status, c.name).toBe('ok');
    if (r.status !== 'ok') continue;
    expect([r.lowCents, r.highCents], c.name).toEqual([c.low, c.high]);
    expect(r.lines[0]!.value, c.name).toBe(c.base);
    for (const line of r.lines) {
      expect(line.source.length, `${c.name} ${line.label}`).toBeGreaterThan(0);
      expect(line.hypothesis.length, `${c.name} ${line.label}`).toBeGreaterThan(0);
    }
    // Le barème est cité avec sa source et sa date.
    expect(r.lines.some((l) => l.source.includes('Barème inventé pour les tests, édition 2027 (2027-01-15)')), c.name).toBe(true);
    // La même entrée donne le même résultat.
    expect(computeBusinessValuation(c.kind, sheetOf(c.sheet), c.method, scaleOf(c.sheet.activity, c.method, c.scale[0]!, c.scale[1]!))).toEqual(r);
  }
});

it('[R10] sans fiche, activité, barème, exercice ou loyer : « incomplet » avec ce qui manque, jamais un chiffre', () => {
  const scale = scaleOf('restaurant', 'revenue_pct', 5_000, 8_000);
  expect(computeBusinessValuation('business', null, 'revenue_pct', null)).toMatchObject({ status: 'incomplet', missing: ['fiche', 'bareme'] });
  expect(computeBusinessValuation('business', sheetOf({}), 'revenue_pct', null)).toMatchObject({ status: 'incomplet', missing: ['activite', 'bareme', 'exercices'] });
  expect(computeBusinessValuation('business', sheetOf({ activity: 'restaurant' }), 'revenue_pct', scale)).toMatchObject({ status: 'incomplet', missing: ['exercices'] });
  expect(computeBusinessValuation('commercial', sheetOf({ activity: 'bureaux' }), 'rent_yield', scaleOf('bureaux', 'rent_yield', 700, 900))).toMatchObject({ status: 'incomplet', missing: ['loyer'] });
  // Un excédent brut moyen nul ou négatif ne donne aucun multiple ; un exercice sans excédent brut ne compte pas pour zéro.
  const multiple = scaleOf('restaurant', 'ebitda_multiple', 200, 300);
  const losses = sheetOf({ activity: 'restaurant', fiscalYears: [{ year: 2026, revenueCents: 100, resultCents: 9, ebitdaCents: -50 }, { year: 2025, revenueCents: 100, resultCents: 9, ebitdaCents: 50 }] });
  expect(computeBusinessValuation('business', losses, 'ebitda_multiple', multiple)).toMatchObject({ status: 'incomplet', missing: ['excedent_brut_positif'] });
  const partial = sheetOf({ activity: 'restaurant', fiscalYears: [{ year: 2026, revenueCents: 100, resultCents: 9, ebitdaCents: 50 }, { year: 2025, revenueCents: 100, resultCents: 9 }] });
  expect(computeBusinessValuation('business', partial, 'ebitda_multiple', multiple)).toMatchObject({ status: 'incomplet', missing: ['excedent_brut'] });
  const nothingSold = sheetOf({ activity: 'restaurant', fiscalYears: [{ year: 2026, revenueCents: 0, resultCents: 0 }] });
  expect(computeBusinessValuation('business', nothingSold, 'revenue_pct', scale)).toMatchObject({ status: 'incomplet', missing: ['chiffre_affaires_positif'] });
  for (const r of [computeBusinessValuation('business', null, 'revenue_pct', null)]) expect(JSON.stringify(r)).not.toMatch(/Cents/);
});

it('[R111] un barème sans source, sans date ou aux bornes fausses est refusé', () => {
  const good = { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé, édition 2027', sourceDate: '2027-01-15' };
  expect(checkScale(good)).toMatchObject({ ok: true });
  expect(checkScale({ ...good, source: '' })).toEqual({ ok: false, rule: 'R111', code: 'source' });
  expect(checkScale({ ...good, source: undefined })).toEqual({ ok: false, rule: 'R111', code: 'source' });
  expect(checkScale({ ...good, sourceDate: '2027-02-30' })).toEqual({ ok: false, rule: 'R111', code: 'date_source' });
  expect(checkScale({ ...good, sourceDate: '2027-13-01' })).toEqual({ ok: false, rule: 'R111', code: 'date_source' });
  expect(checkScale({ ...good, low: 9_000 })).toMatchObject({ ok: false, code: 'bornes' });
  expect(checkScale({ ...good, method: 'rent_yield', high: 5_001 })).toMatchObject({ ok: false, code: 'bornes' });
  expect(checkScale({ ...good, activity: 'casino' })).toMatchObject({ ok: false, code: 'activite' });
  expect(checkScale({ ...good, method: 'au_doigt_mouille' })).toMatchObject({ ok: false, code: 'methode' });
  expect(checkScale({ ...good, comment: 'x' })).toMatchObject({ ok: false, code: 'champ_inconnu' });
});

it('[R112] le calcul n’appelle aucune IA : le module n’importe que la base, le journal, les accès et la fiche', () => {
  const source = readFileSync(new URL('../src/commerces/estimation.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]).sort();
  expect(imports).toEqual(['../acces/acces.ts', '../acces/droits.ts', '../db/sql.ts', '../db/types.ts', '../journal/journal.ts', '../journal/types.ts', './fiche.ts']);
  // Hors commentaires, aucun appel réseau.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(code).not.toMatch(/fetch\(|\bai\b|redacteur|assistant/i);
});

const TUESDAY_10H = Date.parse('2027-09-07T08:00:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { store, fiche } = createCaptation(db, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const fiches = new FicheCommerce(db, journal, { now });
  const estimations = new EstimationCommerce(db, journal, fiches, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  let seq = 0;
  const property = async (kind: 'business' | 'business_walls' | 'commercial' | 'home' = 'business') =>
    store.createProperty({ networkId: network.id, agentId: alex.id, reference: `CE-${(seq += 1)}`, kind, status: 'available', city: 'Dijon', postalCode: '21000' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  return { db, journal, acces, fiches, estimations, network, alex, sam, property, as };
}

describeWithSqlite('CE02 · estimation d’un commerce', () => {
  it('[R111] [R13] la direction range le barème ; l’agent estime ; le journal ne porte aucun chiffre', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const direction = t.as('direction', 'dir-1');
    const c = CASES[0]!;
    const p = await t.property();
    await t.fiches.update(t.acces, alex, p.id, c.sheet);
    // Sans barème : incomplet, rien n'est rangé.
    expect(await t.estimations.estimate(t.acces, alex, p.id, 'revenue_pct')).toEqual({ ok: true, status: 'incomplet', missing: ['bareme'] });
    expect(await t.estimations.recordScale(alex, { activity: 'boulangerie_patisserie', method: 'revenue_pct', low: 6_000, high: 9_000, source: 'x'.repeat(5), sourceDate: '2027-01-15' })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.estimations.recordScale(direction, { activity: 'boulangerie_patisserie', method: 'revenue_pct', low: 6_000, high: 9_000, sourceDate: '2027-01-15' })).toMatchObject({ ok: false, rule: 'R111' });
    // Une première version, corrigée par une seconde : la seconde fait foi, la première reste.
    await t.estimations.recordScale(direction, { activity: 'boulangerie_patisserie', method: 'revenue_pct', low: 5_000, high: 9_000, source: 'Barème inventé pour les tests, édition 2026', sourceDate: '2026-01-15' });
    const scale = await t.estimations.recordScale(direction, { activity: 'boulangerie_patisserie', method: 'revenue_pct', low: 6_000, high: 9_000, source: 'Barème inventé pour les tests, édition 2027', sourceDate: '2027-01-15' });
    expect(scale).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await t.estimations.estimate(t.acces, alex, p.id, 'rent_yield')).toMatchObject({ ok: false, code: 'methode' });
    const r = await t.estimations.estimate(t.acces, alex, p.id, 'revenue_pct');
    expect(r).toMatchObject({ ok: true, status: 'ok', value: { lowCents: c.low, highCents: c.high, sheetVersion: 1, validated: null } });
    const text = JSON.stringify(await t.journal.all());
    for (const n of [String(c.low), String(c.high), String(c.base), '43987600']) expect(text, n).not.toContain(n);
    await expect(t.db.run('UPDATE business_valuations SET low_cents = 1')).rejects.toThrow(/ne se réécrit pas/);
    await expect(t.db.run('DELETE FROM business_valuation_scales')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R16] non validée, seul l’agent du bien voit l’estimation ; validée, la direction et la conformité la lisent', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const p = await t.property('commercial');
    await t.fiches.update(t.acces, alex, p.id, CASES[3]!.sheet);
    await t.estimations.recordScale(t.as('direction', 'dir-1'), { activity: 'bureaux', method: 'rent_yield', low: 700, high: 900, source: 'Barème inventé pour les tests', sourceDate: '2027-01-15' });
    const r = await t.estimations.estimate(t.acces, alex, p.id, 'rent_yield');
    expect(r.ok && r.status === 'ok').toBe(true);
    if (!r.ok || r.status !== 'ok') return;
    for (const who of [t.as('direction', 'dir-1'), t.as('compliance', 'conf-1')]) expect(await t.estimations.read(t.acces, who, p.id)).toEqual({ ok: true, value: [] });
    expect(await t.estimations.validatedRange(p.id)).toBeNull();
    expect(await t.estimations.read(t.acces, t.as('agent', t.sam.id), p.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.estimations.estimate(t.acces, t.as('agent', t.sam.id), p.id, 'rent_yield')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.estimations.validate(t.acces, t.as('agent', t.sam.id), r.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.estimations.validate(t.acces, t.as('direction', 'dir-1'), r.value.id)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.estimations.read(t.acces, alex, p.id)).ok && (await t.estimations.read(t.acces, alex, p.id))).toMatchObject({ value: [{ id: r.value.id, validated: null }] });

    expect(await t.estimations.validate(t.acces, alex, r.value.id)).toMatchObject({ ok: true, value: { validated: { by: `agent:${t.alex.id}` } } });
    expect(await t.estimations.validate(t.acces, alex, r.value.id)).toMatchObject({ ok: true });
    expect(await t.estimations.read(t.acces, t.as('direction', 'dir-1'), p.id)).toMatchObject({ ok: true, value: [{ id: r.value.id, lowCents: 26_666_678, highCents: 34_285_729 }] });
    expect(await t.estimations.validatedRange(p.id)).toEqual({ lowCents: 26_666_678, highCents: 34_285_729, valuationId: r.value.id });
    expect((await t.journal.all()).filter((e) => e.type === 'commerces.estimation.validee')).toHaveLength(1);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R111] une estimation remplacée, ou faite sur une fiche qui a changé depuis, ne se valide pas ; la fourchette publiée suit la fiche', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const p = await t.property();
    await t.fiches.update(t.acces, alex, p.id, CASES[4]!.sheet);
    await t.estimations.recordScale(t.as('direction', 'dir-1'), { activity: 'bar_cafe', method: 'revenue_pct', low: 7_500, high: 10_500, source: 'Barème inventé pour les tests', sourceDate: '2027-01-15' });
    const first = await t.estimations.estimate(t.acces, alex, p.id, 'revenue_pct');
    const second = await t.estimations.estimate(t.acces, alex, p.id, 'revenue_pct');
    if (!first.ok || first.status !== 'ok' || !second.ok || second.status !== 'ok') throw new Error('estimations attendues');
    expect(await t.estimations.validate(t.acces, alex, first.value.id)).toEqual({ ok: false, rule: 'R111', code: 'estimation_remplacee' });
    await t.fiches.update(t.acces, alex, p.id, { employees: 3 });
    expect(await t.estimations.validate(t.acces, alex, second.value.id)).toEqual({ ok: false, rule: 'R111', code: 'fiche_changee' });
    const third = await t.estimations.estimate(t.acces, alex, p.id, 'revenue_pct');
    if (!third.ok || third.status !== 'ok') throw new Error('estimation attendue');
    expect(third.value.sheetVersion).toBe(2);
    await t.estimations.validate(t.acces, alex, third.value.id);
    expect(await t.estimations.validatedRange(p.id)).toMatchObject({ lowCents: 25_000_000, highCents: 35_000_000 });
    // La fiche change encore : plus aucune fourchette publiable tant qu'une nouvelle n'est pas validée.
    await t.fiches.update(t.acces, alex, p.id, { employees: 4 });
    expect(await t.estimations.validatedRange(p.id)).toBeNull();
    // Une estimation faite avec un barème corrigé depuis ne se valide pas, et ne se publie plus.
    const fourth = await t.estimations.estimate(t.acces, alex, p.id, 'revenue_pct');
    if (!fourth.ok || fourth.status !== 'ok') throw new Error('estimation attendue');
    await t.estimations.validate(t.acces, alex, fourth.value.id);
    expect(await t.estimations.validatedRange(p.id)).not.toBeNull();
    const fifth = await t.estimations.estimate(t.acces, alex, p.id, 'revenue_pct');
    if (!fifth.ok || fifth.status !== 'ok') throw new Error('estimation attendue');
    await t.estimations.recordScale(t.as('direction', 'dir-1'), { activity: 'bar_cafe', method: 'revenue_pct', low: 7_000, high: 10_000, source: 'Barème inventé pour les tests, corrigé', sourceDate: '2027-03-01' });
    expect(await t.estimations.validate(t.acces, alex, fifth.value.id)).toEqual({ ok: false, rule: 'R111', code: 'bareme_change' });
    expect(await t.estimations.validatedRange(p.id)).toBeNull();
  });

  it('un bien qui n’est pas un commerce est refusé', async () => {
    const t = await setup();
    const home = await t.property('home');
    expect(await t.estimations.estimate(t.acces, t.as('agent', t.alex.id), home.id, 'revenue_pct')).toMatchObject({ ok: false, code: 'sorte' });
  });
});

it('[R111] AU102 · un local libre s’estime sur sa valeur locative de marché et ce qui la fonde, jamais sur un bail inventé', () => {
  const scale = scaleOf('bureaux', 'rent_yield', 700, 900);
  // Une valeur locative sans ce qui la fonde ne suffit pas.
  expect(computeBusinessValuation('commercial', sheetOf({ activity: 'bureaux', marketAnnualRentCents: 1_800_000 }), 'rent_yield', scale)).toMatchObject({ status: 'incomplet', missing: ['loyer'] });
  const free = sheetOf({ activity: 'bureaux', marketAnnualRentCents: 1_800_000, marketRentBasis: 'trois locaux comparables loués en 2026 dans la rue, relevés par l’agent' });
  const r = computeBusinessValuation('commercial', free, 'rent_yield', scale);
  // 18 000 € / 9 % = 200 000 € ; / 7 % = 257 142,86 €.
  expect(r).toMatchObject({ status: 'ok', lowCents: 20_000_000, highCents: 25_714_286 });
  if (r.status !== 'ok') throw new Error('incomplet');
  expect(r.lines[0]).toMatchObject({ label: 'valeur_locative', value: 1_800_000, hypothesis: expect.stringContaining('local libre, sans bail') });
  expect(r.lines.some((l) => l.label === 'loyer_annuel')).toBe(false);
  // Le bail, s'il existe, l'emporte sur la valeur locative.
  const leased = computeBusinessValuation('commercial', sheetOf({ ...free.sheet, leaseAnnualRentCents: 1_400_000 }), 'rent_yield', scale);
  expect(leased).toMatchObject({ status: 'ok', lowCents: mulDiv(1_400_000, 10_000, 900) });
  // La base d'une valeur locative se saisit en 5 à 300 caractères.
  expect(checkSheetChanges({ marketRentBasis: 'abc' })).toMatchObject({ ok: false, field: 'marketRentBasis' });
  expect(checkSheetChanges({ marketAnnualRentCents: 0 })).toMatchObject({ ok: false, field: 'marketAnnualRentCents' });
});
