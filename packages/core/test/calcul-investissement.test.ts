import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { CalculInvestissement, LoyersMarche, INPUT_KEYS, checkYieldInputs, computeYield, monthlyPayment, roundDiv, type YieldInputs } from '../src/investir/index.ts';
import { CASES, type Case } from './investir-jeu.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const AT = '2027-09-14T08:00:00.000Z';


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
    recoverableCharges: src(0, 'client_dit:a-1', 'sans provision pour charges récupérables'),
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
    expect(r, key).toEqual({ status: 'incomplet', formulaVersion: 2, missing: [key] });
  }
  const r = computeYield({ ...full, price: null, marketRent: null }, AT);
  expect(r).toEqual({ status: 'incomplet', formulaVersion: 2, missing: ['price', 'marketRent'] });
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
    // Le loyer du bien 4 rangé dans la base, comme l'ANIL le publie : le calcul le lit, il n'est jamais saisi [R122].
    await t.loyers.importAnil(t.as('direction', 'dir-1'), { kind: 'apartment', vintage: 2026, csv: 'INSEE_C;loypredm2;lwr.IPm2;upr.IPm2;nbobs_com\n99004;10,20;8,80;11,90;80' });
    const r = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), {
      propertyId: 'p-1',
      projectId: t.project.id,
      marketRentQuery: { inseeCode: '99004', kind: 'apartment' },
      inputs: { ...inputsOf(CASES[3]!.inputs), marketRent: null },
    });
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
      inputs: { acquisitionFeesRateBp: c.acquisitionFeesRateBp, works: c.works, nonRecoverableCharges: c.nonRecoverableCharges, recoverableCharges: c.recoverableCharges, propertyTax: c.propertyTax, vacancyMonths: c.vacancyMonths },
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
    const forged = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-2', inputs: { ...c, marketRent: null, price: src(5_000_000, 'bien:p-2', 'prix affiché') } });
    if (!forged.ok) throw new Error(forged.code);
    expect(forged.value.inputs.price!.source).toBe(`saisi:agent:${t.alex.id}`);
    // AU100 · un financement saisi avec une source et une date inventées : il porte le nom de l'agent et le jour du calcul.
    const loan = { value: { loanCents: 4_000_000, annualRateBp: 360, months: 240, insuranceMonthlyCents: 1_000 }, source: 'bien:fake', asOf: '2001-01-01', hypothesis: 'offre déclarée' };
    const financed = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-2', inputs: { ...c, marketRent: null, financing: loan } });
    if (!financed.ok) throw new Error(financed.code);
    expect(financed.value.inputs.financing).toMatchObject({ source: `saisi:agent:${t.alex.id}`, hypothesis: 'offre déclarée' });
    expect(financed.value.inputs.financing!.asOf).not.toBe('2001-01-01');
    for (const l of financed.value.result.status === 'complet' ? financed.value.result.lines.filter((x) => x.key.startsWith('loan') && x.source !== 'calcul') : []) expect(l.source).toBe(`saisi:agent:${t.alex.id}`);
    // Un loyer de marché saisi est refusé, même avec une source « ANIL » ou une commune connue : seule la base le donne.
    for (const marketRentQuery of [undefined, { inseeCode: '99001', kind: 'apartment' }]) {
      expect(await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-2', marketRentQuery, inputs: c })).toMatchObject({ ok: false, rule: 'R122', code: 'loyer_saisi', field: 'marketRent' });
    }
    // Sans loyer dans la base pour la commune : incomplet, jamais un chiffre inventé.
    const none = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-2', marketRentQuery: { inseeCode: '99009', kind: 'apartment' }, inputs: { ...c, marketRent: null } });
    expect(none.ok && none.value.result).toMatchObject({ status: 'incomplet', missing: ['marketRent'] });
  });
});

it('[R120] AU099 · la provision pour charges récupérables sort du loyer charges comprises : 800 € dont 100 € de charges → 700 €', () => {
  const base = inputsOf(CASES[0]!.inputs);
  const inputs: YieldInputs = {
    ...base,
    livingArea: src(4_000, 'bien:p-1', 'surface habitable de la fiche'),
    marketRent: { ...base.marketRent!, value: { centralM2Cents: 2_000, lowerM2Cents: 1_800, upperM2Cents: 2_200 } },
    recoverableCharges: src(10_000, 'client_dit:a-1', 'provision déclarée par le vendeur'),
    vacancyMonths: src(0),
    nonRecoverableCharges: src(0),
    propertyTax: src(0),
  };
  const r = computeYield(inputs, AT);
  if (r.status !== 'complet') throw new Error('incomplet');
  expect(r.formulaVersion).toBe(2);
  expect(line(r, 'monthlyRentWithCharges')).toBe(80_000);
  expect(line(r, 'recoverableCharges')).toBe(10_000);
  expect(line(r, 'monthlyRent')).toBe(70_000);
  expect(line(r, 'annualRent')).toBe(840_000);
  // Sans double déduction : le revenu net est le loyer hors charges, rien d'autre ne retire la provision.
  expect(line(r, 'netIncome')).toBe(840_000);
  const without = computeYield({ ...inputs, recoverableCharges: src(0) }, AT);
  if (without.status !== 'complet') throw new Error('incomplet');
  expect(r.grossYieldBp.central).toBeLessThan(without.grossYieldBp.central);
  expect(r.netYieldBp.low).toBe(roundDiv((1_800 * 40 - 10_000) * 12 * 10_000, line(r, 'totalCost')!));
  // Une provision au moins égale au loyer de la borne basse : incomplet sur la provision, jamais un loyer négatif.
  expect(computeYield({ ...inputs, recoverableCharges: src(72_000) }, AT)).toEqual({ status: 'incomplet', formulaVersion: 2, missing: ['recoverableCharges'] });
  // Un calcul rangé en version 1, sans provision, se rejoue avec ses formules et donne le même résultat qu'avant.
  const { recoverableCharges: _gone, ...old } = inputs;
  const v1 = computeYield(old as unknown as YieldInputs, AT, 1);
  if (v1.status !== 'complet') throw new Error('incomplet');
  expect(v1.formulaVersion).toBe(1);
  expect(line(v1, 'monthlyRent')).toBe(80_000);
  expect(v1.lines.some((l) => l.key === 'recoverableCharges')).toBe(false);
  // En version 2, la provision manquante est dite.
  expect(computeYield(old as unknown as YieldInputs, AT)).toEqual({ status: 'incomplet', formulaVersion: 2, missing: ['recoverableCharges'] });
});

it('[R120] AU100 · avec un prêt déclaré, la trésorerie mensuelle après mensualité et assurance, sans toucher au rendement', () => {
  const base = inputsOf(CASES[0]!.inputs);
  const plain = computeYield(base, AT);
  const loan = { loanCents: 15_000_000, annualRateBp: 360, months: 300, insuranceMonthlyCents: 2_500 };
  const withLoan = computeYield({ ...base, financing: { value: loan, source: 'client_dit:a-1', asOf: '2027-09-01', hypothesis: 'offre de prêt déclarée' } }, AT);
  if (plain.status !== 'complet' || withLoan.status !== 'complet') throw new Error('incomplet');
  expect(withLoan.grossYieldBp).toEqual(plain.grossYieldBp);
  expect(withLoan.netYieldBp).toEqual(plain.netYieldBp);
  // 150 000 € à 3,60 % sur 25 ans : 759,00 € par mois (calcul à la main de l'annuité).
  expect(monthlyPayment(loan)).toBe(75_900);
  expect(monthlyPayment({ ...loan, annualRateBp: 0 })).toBe(50_000);
  const net = line(withLoan, 'netIncome')!;
  expect(line(withLoan, 'monthlyCashflow')).toBe(roundDiv(net, 12) - 75_900 - 2_500);
  expect(line(withLoan, 'monthlyCashflowLow')).toBeLessThanOrEqual(line(withLoan, 'monthlyCashflow')!);
  expect(withLoan.lines.find((l) => l.key === 'loanCents')).toMatchObject({ source: 'client_dit:a-1', hypothesis: 'offre de prêt déclarée' });
  // Sans prêt, aucune ligne de trésorerie, et rien ne manque.
  expect(plain.lines.some((l) => l.key.startsWith('monthlyCashflow'))).toBe(false);
  // Un prêt mal formé est refusé à l'entrée.
  const raw = base as unknown as Record<string, unknown>;
  expect(checkYieldInputs({ ...raw, financing: { value: { ...loan, months: 6 }, source: 's', asOf: '2027-09-01', hypothesis: 'h' } })).toEqual({ ok: false, code: 'valeur', field: 'financing' });
  expect(checkYieldInputs({ ...raw, financing: { value: loan, source: 'client', asOf: '2027-09-01', hypothesis: 'offre' } })).toMatchObject({ ok: true, value: { financing: { value: loan } } });
});
