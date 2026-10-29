import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { CalculInvestissement, LoyersMarche, INPUT_KEYS, checkYieldInputs, computeYield, roundDiv, type YieldInputs } from '../src/investir/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const AT = '2027-09-14T08:00:00.000Z';

interface Case {
  inputs: { price: number; rate: number; works: number; area: number; rent: [number, number, number]; charges: number; tax: number; vacancy: number };
  expected: { fees: number; totalCost: number; monthlyRent: number; annualRent: number; collectedRent: number; netIncome: number; gross: [number, number, number]; net: [number, number, number] };
}

/** 10 biens tests inventés, chacun calculé à la main ligne par ligne (centimes, points de base). */
const CASES: Case[] = [
  {
    // Bien 1 : prix 15000000 ; frais 15000000 × 750 / 10 000 = 1125000 ; coût 15000000 + 1125000 + 1000000 = 17125000.
    // Loyer 1235 × 4500 / 100 = 55575 par mois, 666900 par an ; brut 666900 × 10 000 / 17125000 = 389 pb.
    // Perçu 55575 × (12 − 1) = 611325 ; net 611325 − 60000 − 90000 = 461325 ; 461325 × 10 000 / 17125000 = 269 pb.
    // Fourchette : loyer 1010 et 1501 au m².
    inputs: { price: 15000000, rate: 750, works: 1000000, area: 4500, rent: [1235, 1010, 1501], charges: 60000, tax: 90000, vacancy: 1 },
    expected: { fees: 1125000, totalCost: 17125000, monthlyRent: 55575, annualRent: 666900, collectedRent: 611325, netIncome: 461325, gross: [318, 389, 473], net: [204, 269, 346] },
  },
  {
    // Bien 2 : prix 9800000 ; frais 9800000 × 750 / 10 000 = 735000 ; coût 9800000 + 735000 + 0 = 10535000.
    // Loyer 1450 × 2850 / 100 = 41325 par mois, 495900 par an ; brut 495900 × 10 000 / 10535000 = 471 pb.
    // Perçu 41325 × (12 − 1) = 454575 ; net 454575 − 42000 − 61000 = 351575 ; 351575 × 10 000 / 10535000 = 334 pb.
    // Fourchette : loyer 1200 et 1700 au m².
    inputs: { price: 9800000, rate: 750, works: 0, area: 2850, rent: [1450, 1200, 1700], charges: 42000, tax: 61000, vacancy: 1 },
    expected: { fees: 735000, totalCost: 10535000, monthlyRent: 41325, annualRent: 495900, collectedRent: 454575, netIncome: 351575, gross: [390, 471, 552], net: [259, 334, 408] },
  },
  {
    // Bien 3 : prix 21000000 ; frais 21000000 × 250 / 10 000 = 525000 ; coût 21000000 + 525000 + 0 = 21525000.
    // Loyer 1180 × 6200 / 100 = 73160 par mois, 877920 par an ; brut 877920 × 10 000 / 21525000 = 408 pb.
    // Perçu 73160 × (12 − 0) = 877920 ; net 877920 − 90000 − 115000 = 672920 ; 672920 × 10 000 / 21525000 = 313 pb.
    // Fourchette : loyer 1000 et 1350 au m².
    inputs: { price: 21000000, rate: 250, works: 0, area: 6200, rent: [1180, 1000, 1350], charges: 90000, tax: 115000, vacancy: 0 },
    expected: { fees: 525000, totalCost: 21525000, monthlyRent: 73160, annualRent: 877920, collectedRent: 877920, netIncome: 672920, gross: [346, 408, 467], net: [250, 313, 371] },
  },
  {
    // Bien 4 : prix 32000000 ; frais 32000000 × 780 / 10 000 = 2496000 ; coût 32000000 + 2496000 + 2500000 = 36996000.
    // Loyer 1020 × 9540 / 100 = 97308 par mois, 1167696 par an ; brut 1167696 × 10 000 / 36996000 = 316 pb.
    // Perçu 97308 × (12 − 1) = 1070388 ; net 1070388 − 150000 − 180000 = 740388 ; 740388 × 10 000 / 36996000 = 200 pb.
    // Fourchette : loyer 880 et 1190 au m².
    inputs: { price: 32000000, rate: 780, works: 2500000, area: 9540, rent: [1020, 880, 1190], charges: 150000, tax: 180000, vacancy: 1 },
    expected: { fees: 2496000, totalCost: 36996000, monthlyRent: 97308, annualRent: 1167696, collectedRent: 1070388, netIncome: 740388, gross: [272, 316, 368], net: [160, 200, 248] },
  },
  {
    // Bien 5 : prix 7500000 ; frais 7500000 × 750 / 10 000 = 562500 ; coût 7500000 + 562500 + 1500000 = 9562500.
    // Loyer 1300 × 3200 / 100 = 41600 par mois, 499200 par an ; brut 499200 × 10 000 / 9562500 = 522 pb.
    // Perçu 41600 × (12 − 2) = 416000 ; net 416000 − 50000 − 70000 = 296000 ; 296000 × 10 000 / 9562500 = 310 pb.
    // Fourchette : loyer 1100 et 1500 au m².
    inputs: { price: 7500000, rate: 750, works: 1500000, area: 3200, rent: [1300, 1100, 1500], charges: 50000, tax: 70000, vacancy: 2 },
    expected: { fees: 562500, totalCost: 9562500, monthlyRent: 41600, annualRent: 499200, collectedRent: 416000, netIncome: 296000, gross: [442, 522, 602], net: [243, 310, 376] },
  },
  {
    // Bien 6 : prix 18500000 ; frais 18500000 × 760 / 10 000 = 1406000 ; coût 18500000 + 1406000 + 500000 = 20406000.
    // Loyer 1100 × 7000 / 100 = 77000 par mois, 924000 par an ; brut 924000 × 10 000 / 20406000 = 453 pb.
    // Perçu 77000 × (12 − 1) = 847000 ; net 847000 − 110000 − 125000 = 612000 ; 612000 × 10 000 / 20406000 = 300 pb.
    // Fourchette : loyer 950 et 1300 au m².
    inputs: { price: 18500000, rate: 760, works: 500000, area: 7000, rent: [1100, 950, 1300], charges: 110000, tax: 125000, vacancy: 1 },
    expected: { fees: 1406000, totalCost: 20406000, monthlyRent: 77000, annualRent: 924000, collectedRent: 847000, netIncome: 612000, gross: [391, 453, 535], net: [243, 300, 375] },
  },
  {
    // Bien 7 : prix 13250000 ; frais 13250000 × 740 / 10 000 = 980500 ; coût 13250000 + 980500 + 850000 = 15080500.
    // Loyer 1215 × 5125 / 100 = 62269 par mois, 747228 par an ; brut 747228 × 10 000 / 15080500 = 495 pb.
    // Perçu 62269 × (12 − 1) = 684959 ; net 684959 − 78000 − 95500 = 511459 ; 511459 × 10 000 / 15080500 = 339 pb.
    // Fourchette : loyer 1000 et 1400 au m².
    inputs: { price: 13250000, rate: 740, works: 850000, area: 5125, rent: [1215, 1000, 1400], charges: 78000, tax: 95500, vacancy: 1 },
    expected: { fees: 980500, totalCost: 15080500, monthlyRent: 62269, annualRent: 747228, collectedRent: 684959, netIncome: 511459, gross: [408, 495, 571], net: [259, 339, 408] },
  },
  {
    // Bien 8 : prix 26000000 ; frais 26000000 × 250 / 10 000 = 650000 ; coût 26000000 + 650000 + 0 = 26650000.
    // Loyer 1050 × 8000 / 100 = 84000 par mois, 1008000 par an ; brut 1008000 × 10 000 / 26650000 = 378 pb.
    // Perçu 84000 × (12 − 0) = 1008000 ; net 1008000 − 130000 − 140000 = 738000 ; 738000 × 10 000 / 26650000 = 277 pb.
    // Fourchette : loyer 900 et 1200 au m².
    inputs: { price: 26000000, rate: 250, works: 0, area: 8000, rent: [1050, 900, 1200], charges: 130000, tax: 140000, vacancy: 0 },
    expected: { fees: 650000, totalCost: 26650000, monthlyRent: 84000, annualRent: 1008000, collectedRent: 1008000, netIncome: 738000, gross: [324, 378, 432], net: [223, 277, 331] },
  },
  {
    // Bien 9 : prix 6400000 ; frais 6400000 × 800 / 10 000 = 512000 ; coût 6400000 + 512000 + 3000000 = 9912000.
    // Loyer 1600 × 2500 / 100 = 40000 par mois, 480000 par an ; brut 480000 × 10 000 / 9912000 = 484 pb.
    // Perçu 40000 × (12 − 2) = 400000 ; net 400000 − 35000 − 48000 = 317000 ; 317000 × 10 000 / 9912000 = 320 pb.
    // Fourchette : loyer 1300 et 1900 au m².
    inputs: { price: 6400000, rate: 800, works: 3000000, area: 2500, rent: [1600, 1300, 1900], charges: 35000, tax: 48000, vacancy: 2 },
    expected: { fees: 512000, totalCost: 9912000, monthlyRent: 40000, annualRent: 480000, collectedRent: 400000, netIncome: 317000, gross: [393, 484, 575], net: [244, 320, 395] },
  },
  {
    // Bien 10 : prix 41000000 ; frais 41000000 × 770 / 10 000 = 3157000 ; coût 41000000 + 3157000 + 4000000 = 48157000.
    // Loyer 1000 × 12000 / 100 = 120000 par mois, 1440000 par an ; brut 1440000 × 10 000 / 48157000 = 299 pb.
    // Perçu 120000 × (12 − 1) = 1320000 ; net 1320000 − 240000 − 260000 = 820000 ; 820000 × 10 000 / 48157000 = 170 pb.
    // Fourchette : loyer 850 et 1150 au m².
    inputs: { price: 41000000, rate: 770, works: 4000000, area: 12000, rent: [1000, 850, 1150], charges: 240000, tax: 260000, vacancy: 1 },
    expected: { fees: 3157000, totalCost: 48157000, monthlyRent: 120000, annualRent: 1440000, collectedRent: 1320000, netIncome: 820000, gross: [254, 299, 344], net: [129, 170, 211] },
  },];

const src = (value: number, source = 'agent:a-1', hypothesis = 'saisi par l’agent') => ({ value, source, asOf: '2027-09-01', hypothesis });

function inputsOf(c: Case['inputs']): YieldInputs {
  return {
    price: src(c.price, 'bien:p-1', 'prix affiché du bien'),
    acquisitionFeesRateBp: src(c.rate, 'direction:d-1', 'barème des frais d’acquisition'),
    works: src(c.works, 'agent:a-1', 'devis estimé'),
    livingArea: src(c.area, 'bien:p-1', 'surface habitable de la fiche'),
    marketRent: {
      value: { centralM2Cents: c.rent[0], lowerM2Cents: c.rent[1], upperM2Cents: c.rent[2] },
      source: 'Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin, millésime 2026',
      asOf: '2027-01-15',
      hypothesis: 'loyer central de la commune',
    },
    nonRecoverableCharges: src(c.charges, 'client_dit:a-1', 'déclarées par le vendeur'),
    propertyTax: src(c.tax, 'client_dit:a-1', 'avis de taxe foncière déclaré'),
    vacancyMonths: src(c.vacancy, 'direction:d-1', 'vacance réglée'),
  };
}

const line = (r: ReturnType<typeof computeYield>, key: string) => (r.status === 'complet' ? r.lines.find((l) => l.key === key)?.value : undefined);

it('l’arrondi est écrit : au plus proche, la moitié en s’éloignant de zéro, exact sur de grands entiers', () => {
  expect(roundDiv(5, 2)).toBe(3);
  expect(roundDiv(-5, 2)).toBe(-3);
  expect(roundDiv(4, 3)).toBe(1);
  expect(roundDiv(-4, 3)).toBe(-1);
  expect(roundDiv(0, 7)).toBe(0);
  expect(roundDiv(999_999_999_999_999, 10)).toBe(100_000_000_000_000);
});

it('[R120] 10 biens tests donnent au centime et au point de base près le calcul fait à la main', () => {
  expect(CASES).toHaveLength(10);
  for (const [i, c] of CASES.entries()) {
    const r = computeYield(inputsOf(c.inputs), AT);
    expect(r.status, `bien ${i + 1}`).toBe('complet');
    if (r.status !== 'complet') continue;
    expect(
      {
        fees: line(r, 'acquisitionFees'),
        totalCost: line(r, 'totalCost'),
        monthlyRent: line(r, 'monthlyRent'),
        annualRent: line(r, 'annualRent'),
        collectedRent: line(r, 'collectedRent'),
        netIncome: line(r, 'netIncome'),
        gross: [r.grossYieldBp.low, r.grossYieldBp.central, r.grossYieldBp.high],
        net: [r.netYieldBp.low, r.netYieldBp.central, r.netYieldBp.high],
      },
      `bien ${i + 1}`,
    ).toEqual(c.expected);
    expect(line(r, 'grossYieldBp')).toBe(c.expected.gross[1]);
    expect(line(r, 'netYieldBp')).toBe(c.expected.net[1]);
  }
});

it('[R121] chaque ligne du résultat porte sa valeur, sa source, sa date et son hypothèse', () => {
  const r = computeYield(inputsOf(CASES[0]!.inputs), AT);
  if (r.status !== 'complet') throw new Error('incomplet');
  for (const l of r.lines) {
    expect(Number.isSafeInteger(l.value), l.key).toBe(true);
    expect(l.source.length, l.key).toBeGreaterThan(0);
    expect(l.asOf, l.key).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(l.hypothesis.length, l.key).toBeGreaterThan(0);
  }
  expect(r.lines.find((l) => l.key === 'marketRentM2')).toMatchObject({ source: expect.stringContaining('Estimations ANIL'), asOf: '2027-01-15' });
  expect(r.lines.find((l) => l.key === 'grossYieldBp')).toMatchObject({ source: 'calcul', asOf: AT });
});

it('[R10] une entrée manquante rend « incomplet » avec la liste de ce qui manque, jamais un rendement', () => {
  const full = inputsOf(CASES[0]!.inputs);
  for (const key of INPUT_KEYS) {
    const r = computeYield({ ...full, [key]: null }, AT);
    expect(r, key).toEqual({ status: 'incomplet', formulaVersion: 1, missing: [key] });
  }
  const r = computeYield({ ...full, price: null, marketRent: null }, AT);
  expect(r).toEqual({ status: 'incomplet', formulaVersion: 1, missing: ['price', 'marketRent'] });
  expect(JSON.stringify(r)).not.toMatch(/Yield/);
});

it('une entrée sans source, sans date, sans hypothèse, hors bornes ou inconnue est refusée', () => {
  const full = inputsOf(CASES[0]!.inputs) as unknown as Record<string, unknown>;
  expect(checkYieldInputs(full)).toMatchObject({ ok: true });
  expect(checkYieldInputs({ ...full, loanRate: src(350) })).toEqual({ ok: false, code: 'champ_inconnu' });
  expect(checkYieldInputs({ ...full, price: { value: 1_000_000, source: '', asOf: '2027-01-01', hypothesis: 'x' } })).toMatchObject({ ok: false, field: 'price' });
  expect(checkYieldInputs({ ...full, price: { value: 1_000_000, source: 'agent:a', asOf: 'hier', hypothesis: 'x' } })).toMatchObject({ ok: false, field: 'price' });
  expect(checkYieldInputs({ ...full, price: { value: 1_000_000, source: 'agent:a', asOf: '2027-01-01' } })).toMatchObject({ ok: false, field: 'price' });
  expect(checkYieldInputs({ ...full, price: src(1_000_000.5) })).toMatchObject({ ok: false, field: 'price' });
  expect(checkYieldInputs({ ...full, vacancyMonths: src(13) })).toMatchObject({ ok: false, field: 'vacancyMonths' });
  expect(checkYieldInputs({ ...full, works: src(-1) })).toMatchObject({ ok: false, field: 'works' });
  expect(checkYieldInputs({ ...full, marketRent: { value: { centralM2Cents: 900, lowerM2Cents: 1000, upperM2Cents: 1100 }, source: 's', asOf: '2027-01-01', hypothesis: 'h' } })).toMatchObject({
    ok: false,
    field: 'marketRent',
  });
});

it('[R121] aucun appel à l’IA dans le calcul ; [R125] aucun impôt ni régime fiscal calculé', () => {
  const code = readFileSync(fileURLToPath(new URL('../src/investir/calcul.ts', import.meta.url)), 'utf8');
  const imports = [...code.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  expect(imports.sort()).toEqual(['../acces/acces.ts', '../acces/droits.ts', '../db/sql.ts', '../journal/journal.ts', '../journal/types.ts', './loyers.ts']);
  const body = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  expect(body).not.toMatch(/\bfetch\s*\(|\bia\b|\bai\b|redige|prompt|\bmodel/i);
  const r = computeYield(inputsOf(CASES[0]!.inputs), AT);
  if (r.status !== 'complet') throw new Error('incomplet');
  const keys = r.lines.map((l) => l.key).join(' ');
  expect(keys).not.toMatch(/income ?tax|regime|lmnp|micro|pinel|denormandie|deficit|abattement|social|tmi|impot/i);
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse(AT);
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, attribution } = createCaptation(db, journal, { now, withQualification: true });
  const acces = new Acces(db, store, fiche, journal, { now });
  const loyers = new LoyersMarche(db, journal, { now });
  const calculs = new CalculInvestissement(db, journal, { now, loyers });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  await attribution.addZone(network.id, alex.id, 'Talant');
  await chaine.receive(network.id, 'site_form', { submissionId: 'f-1', firstName: 'Inès', email: 'ines@example.test', message: 'Je souhaite investir dans un appartement à Talant, budget 150 000 €.' });
  const project = (await db.first<{ id: string }>("SELECT id FROM projects WHERE kind = 'invest'"))!;
  // La fiche suivie par Alex, quel que soit le tirage de l'attribution.
  await db.run("UPDATE persons SET agent_id = ? WHERE id = (SELECT person_id FROM projects WHERE id = ?)", [alex.id, project.id]);
  await db.run(
    "INSERT INTO properties (id, network_id, agent_id, reference, kind, status, created_at, updated_at) VALUES ('p-1', ?, ?, 'REF-1', 'home', 'available', ?, ?)",
    [network.id, alex.id, AT, AT],
  );
  // Un bien d'Alex pas encore en vente : hors du fichier commun.
  await db.run(
    "INSERT INTO properties (id, network_id, agent_id, reference, kind, status, price_eur, surface_m2, created_at, updated_at) VALUES ('p-2', ?, ?, 'REF-2', 'home', 'draft', 150000, 45, ?, ?)",
    [network.id, alex.id, AT, AT],
  );
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  return { db, journal, acces, calculs, loyers, network, alex, sam, project, as };
}

describeWithSqlite('Y03 · calcul d’investissement rangé', () => {
  it('[R120] le calcul est rangé avec ses entrées et se rejoue à l’identique ; il ne change plus [R17]', async () => {
    const t = await setup();
    const r = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-1', projectId: t.project.id, inputs: inputsOf(CASES[3]!.inputs) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.result).toMatchObject({ status: 'complet', grossYieldBp: { central: 316 }, netYieldBp: { central: 200 } });
    const replay = await t.calculs.replay(t.network.id, r.value.id);
    expect(replay).toMatchObject({ same: true });
    expect(await t.calculs.get(t.network.id, r.value.id)).toEqual(r.value);
    await expect(t.db.run("UPDATE investment_calculations SET status = 'incomplet' WHERE id = ?", [r.value.id])).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM investment_calculations WHERE id = ?', [r.value.id])).rejects.toThrow(/rien ne s'efface/);
    // Un calcul incomplet est rangé aussi, sans rendement.
    const partial = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-1', inputs: { price: src(10_000_000) } });
    expect(partial.ok && partial.value.result.status).toBe('incomplet');
  });

  it('[R16] un autre agent ne calcule pas pour la fiche d’Alex ; la conformité ne calcule pas ; refus au journal sans chiffre', async () => {
    const t = await setup();
    const inputs = inputsOf(CASES[0]!.inputs);
    expect(await t.calculs.compute(t.acces, t.as('agent', t.sam.id), { propertyId: 'p-1', projectId: t.project.id, inputs })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.calculs.compute(t.acces, t.as('compliance', 'c-1'), { propertyId: 'p-1', inputs })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-autre', inputs })).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    expect(await t.calculs.compute(t.acces, { role: 'agent', userId: t.alex.id, networkId: 'autre' }, { propertyId: 'p-1', inputs })).toMatchObject({ ok: false, rule: 'R16' });
    // Un bien d'Alex hors du fichier commun : Sam est refusé, sans rien ranger.
    expect(await t.calculs.compute(t.acces, t.as('agent', t.sam.id), { propertyId: 'p-2', inputs })).toMatchObject({ ok: false, rule: 'R16' });
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM investment_calculations'))!.n)).toBe(0);
    const events = await t.journal.all();
    expect(events.filter((e) => e.type === 'acces.refuse').length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(events)).not.toContain('15000000');
    // Une entrée fausse est refusée au journal, sans valeur.
    expect(await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-1', inputs: { ...inputs, vacancyMonths: src(40) } })).toMatchObject({
      ok: false,
      rule: 'R120',
      field: 'vacancyMonths',
    });
  });

  it('[R121] le prix et la surface viennent du bien, le loyer de la base ; une saisie porte le nom de l’agent, jamais « bien » ni « ANIL »', async () => {
    const t = await setup();
    const csv = 'INSEE_C;loypredm2;lwr.IPm2;upr.IPm2;nbobs_com\n99001;12,35;10,10;15,01;120';
    await t.loyers.importAnil(t.as('direction', 'dir-1'), { kind: 'apartment', vintage: 2026, csv });
    const c = inputsOf(CASES[0]!.inputs);
    const r = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), {
      propertyId: 'p-2',
      marketRentQuery: { inseeCode: '99001', kind: 'apartment' },
      inputs: { acquisitionFeesRateBp: c.acquisitionFeesRateBp, works: c.works, nonRecoverableCharges: c.nonRecoverableCharges, propertyTax: c.propertyTax, vacancyMonths: c.vacancyMonths },
    });
    if (!r.ok) throw new Error(r.code);
    // Le même bien 1 qu'à la main : 150 000 €, 45 m², 12,35 €/m² → 389 pb brut, 269 pb net.
    expect(r.value.result).toMatchObject({ status: 'complet', grossYieldBp: { low: 318, central: 389, high: 473 }, netYieldBp: { central: 269 } });
    expect(r.value.inputs.price).toMatchObject({ value: 15_000_000, source: 'bien:p-2' });
    expect(r.value.inputs.livingArea).toMatchObject({ value: 4500, source: 'bien:p-2' });
    expect(r.value.inputs.marketRent!.source).toBe('Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin, millésime 2026');
    expect(r.value.inputs.works!.source).toBe(`saisi:agent:${t.alex.id}`);
    // Chaque chiffre de la fourchette a sa ligne, avec source et hypothèse.
    if (r.value.result.status !== 'complet') return;
    expect(r.value.result.lines.find((l) => l.key === 'grossYieldBpLow')).toMatchObject({ value: 318, source: 'calcul' });
    expect(r.value.result.lines.find((l) => l.key === 'netYieldBpHigh')).toMatchObject({ value: 346, source: 'calcul' });

    // Un agent qui écrit « bien » ou « ANIL » comme source d'un chiffre saisi : la source rangée reste la sienne.
    const forged = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-2', inputs: { ...c, price: src(5_000_000, 'bien:p-2', 'prix affiché') } });
    if (!forged.ok) throw new Error(forged.code);
    expect(forged.value.inputs.price!.source).toBe(`saisi:agent:${t.alex.id}`);
    expect(forged.value.inputs.marketRent!.source).toBe(`saisi:agent:${t.alex.id}`);
    // Sans loyer dans la base pour la commune : incomplet, jamais un chiffre inventé.
    const none = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-2', marketRentQuery: { inseeCode: '99009', kind: 'apartment' }, inputs: { ...c, marketRent: null } });
    expect(none.ok && none.value.result).toMatchObject({ status: 'incomplet', missing: ['marketRent'] });
  });
});
