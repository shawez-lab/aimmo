import { expect, it } from 'vitest';
import {
  CarnetsProprietaire,
  RelancesApresVente,
  SOLICITATION,
  buildCarnet,
  carnetText,
  checkCarnet,
  energyValidUntil,
  verifyCarnet,
  type BiensVendus,
  type ClosedSale,
  type SoldPropertyFacts,
} from '../src/apres-vente/index.ts';
import { Fourchette, type Sale, type SalesCoverage, type SalesSource } from '../src/estimation/fourchette.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { FakeDossiersClos } from './apres-vente-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Ventes inventées, tirées par un générateur fixe, autour d'un point de Dijon.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function inventedSales(seed: number, n: number): Sale[] {
  const r = rng(seed);
  const out: Sale[] = [];
  for (let i = 0; i < n; i++) {
    const kind = r() < 0.6 ? 'apartment' : 'house';
    const month = `${2026 + Math.floor(r() * 2)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}`;
    out.push({ id: `v${i}`, kind, lat: Number((47.322 + (r() - 0.5) * 0.02).toFixed(5)), lon: Number((5.041 + (r() - 0.5) * 0.02).toFixed(5)), surface: Math.round(30 + r() * 120), pricePerM2: Math.round(1800 + r() * 2200), month });
  }
  return out;
}
const COVERAGE: SalesCoverage = { department: '21', lastSale: '2027-12-20', years: [2026, 2027], source: 'DVF, ventes de test inventées' };
class MemorySales implements SalesSource {
  constructor(readonly all: readonly Sale[]) {}
  async coverage() {
    return COVERAGE;
  }
  async within(kind: Sale['kind']) {
    return this.all.filter((s) => s.kind === kind);
  }
}
const SALES = new MemorySales(inventedSales(5, 400));
const NOW = new Date('2028-03-09T10:00:00.000Z');
const SALE = { reference: 'REF-T-7', city: 'Dijon' };

const FACTS: Record<string, SoldPropertyFacts> = {
  appartement: { kind: 'apartment', surface: 65, lat: 47.3225, lon: 5.0412, postalCode: '21000', energy: { energyClass: 'D', diagnosedOn: '2026-11-03' } },
  maison: { kind: 'house', surface: 110, lat: 47.321, lon: 5.04, postalCode: '21000', energy: { energyClass: 'C', diagnosedOn: '2021-06-15' } },
  ancienDpe: { kind: 'apartment', surface: 48, lat: 47.323, lon: 5.042, postalCode: '21000', energy: { energyClass: 'F', diagnosedOn: '2016-04-01' } },
  terrain: { kind: 'land', surface: 600, lat: 47.32, lon: 5.04, postalCode: '21000', energy: null },
  sansPosition: { kind: 'apartment', surface: 70, lat: null, lon: null, postalCode: '21000', energy: null },
};

it('la validité du diagnostic énergétique suit ses règles : 10 ans, et les fins anticipées des anciens', () => {
  expect(energyValidUntil('2026-11-03')).toBe('2036-11-02');
  expect(energyValidUntil('2021-07-01')).toBe('2031-06-30');
  expect(energyValidUntil('2021-06-30')).toBe('2024-12-31');
  expect(energyValidUntil('2018-01-01')).toBe('2024-12-31');
  expect(energyValidUntil('2017-12-31')).toBe('2022-12-31');
  expect(energyValidUntil('2013-01-01')).toBe('2022-12-31');
  expect(energyValidUntil('2012-05-01')).toBe('2022-04-30');
  expect(energyValidUntil('2024-02-29')).toBe('2034-02-28');
  expect(energyValidUntil('2024-03-01')).toBe('2034-02-28');
});

it('[R10] [R09] cinq carnets tests, chacun relu par le code contre ses sources ; aucun ne démarche', async () => {
  for (const [name, facts] of Object.entries(FACTS)) {
    const c = await buildCarnet(SALE, facts, SALES, NOW);
    expect(await verifyCarnet(c, SALE, facts, SALES, NOW), name).toEqual([]);
    // Relecture indépendante de la fabrication du carnet : chaque chiffre contre sa source.
    const r = await new Fourchette(SALES, undefined, () => NOW).estimate({ kind: facts.kind, surface: facts.surface, lat: facts.lat, lon: facts.lon, postalCode: facts.postalCode, energyClass: facts.energy?.energyClass ?? null });
    if (r.ok) {
      expect(c.value).toMatchObject({ known: true, low: r.low, high: r.high, comparables: r.comparables.length, latestSale: r.latestUsedSale, source: COVERAGE.source });
      expect(c.yearCount).toBe(r.comparables.filter((x) => x.month >= '2027-04').length);
    } else {
      expect(c.value.known).toBe(false);
      expect(c.yearCount).toBe(0);
    }
    for (const y of c.yearSales) {
      expect(SALES.all.some((x) => Math.round(x.surface) === y.surface && Math.round(x.pricePerM2) === y.pricePerM2 && x.month === y.month), name).toBe(true);
      expect(y.month >= '2027-04').toBe(true);
    }
    if (facts.energy) expect(c.energy).toMatchObject({ known: true, energyClass: facts.energy.energyClass, diagnosedOn: facts.energy.diagnosedOn, validUntil: energyValidUntil(facts.energy.diagnosedOn) });
    else expect(c.energy.known).toBe(false);
    const text = carnetText(c);
    expect(SOLICITATION.test(text), name).toBe(false);
    expect(text).toContain('Ce carnet ne vous demande rien.');
    // Aucune position ni identifiant de vente dans le carnet.
    expect(text).not.toMatch(/47\.3|5\.04|\bv\d+\b/);
  }
  const flat = await buildCarnet(SALE, FACTS['appartement']!, SALES, NOW);
  expect(flat.value.known).toBe(true);
  expect(carnetText(flat)).toMatch(/Valeur : entre \d{3} \d{3} € et \d{3} \d{3} €, calculée d'après \d+ ventes comparables publiées/);
  expect(flat.yearSales.length).toBeGreaterThan(0);
  expect(flat.yearSales.every((s) => s.month > '2027-03')).toBe(true);
  expect(carnetText(flat)).toContain("valable jusqu'au 2 novembre 2036");
  const old = await buildCarnet(SALE, FACTS['ancienDpe']!, SALES, NOW);
  expect(carnetText(old)).toContain("il n'est plus valable depuis le 31 décembre 2022");
  const land = await buildCarnet(SALE, FACTS['terrain']!, SALES, NOW);
  expect(carnetText(land)).toContain('Valeur : non communiquée, car ce type de bien ne se compare pas aux ventes publiées.');
  expect(carnetText(land)).toContain('Diagnostic énergétique : non communiqué.');
  expect(carnetText(await buildCarnet(SALE, FACTS['sansPosition']!, SALES, NOW))).toContain('Valeur : non communiquée, car la position ou la surface du bien manque.');
});

it('[R10] plus de 10 ventes dans l’année : le carnet dit leur nombre exact, et montre les 10 plus récentes', async () => {
  // Les mêmes ventes, toutes publiées à l'automne 2027.
  const recent = new MemorySales(SALES.all.map((x, i) => ({ ...x, month: `2027-${10 + (i % 3)}` })));
  const c = await buildCarnet(SALE, FACTS['appartement']!, recent, NOW);
  expect(c.yearCount).toBeGreaterThan(10);
  expect(c.yearSales).toHaveLength(10);
  expect(carnetText(c)).toContain(`Ventes comparables publiées sur les douze derniers mois : ${c.yearCount}, dont les 10 plus récentes :`);
  expect(checkCarnet(c)).toEqual([]);
});

it('[R10] un carnet dont un chiffre ne vient pas de ses sources, ou qui démarche, est refusé', async () => {
  const facts = FACTS['appartement']!;
  const c = await buildCarnet(SALE, facts, SALES, NOW);
  if (!c.value.known) throw new Error('valeur attendue');
  expect(await verifyCarnet({ ...c, value: { ...c.value, high: c.value.high + 1000 } }, SALE, facts, SALES, NOW)).toEqual([{ rule: 'R10', detail: 'le carnet ne correspond pas à ses sources' }]);
  expect(await verifyCarnet({ ...c, yearSales: [...c.yearSales, { surface: 99, pricePerM2: 9999, month: '2028-01' }] }, SALE, facts, SALES, NOW)).toHaveLength(1);
  expect(checkCarnet({ ...c, city: 'Dijon. Profitez-en pour vendre maintenant' }).map((p) => p.rule)).toContain('demarchage');
  for (const phrase of ['vendre maintenant', 'Estimation gratuite', 'profitez', 'Faites estimer votre bien', "N'attendez pas"]) expect(SOLICITATION.test(phrase), phrase).toBe(true);
});

describeWithSqlite('F06 · carnet du propriétaire, un an après (Jamais vu)', () => {
  const BASE = 'https://aimmo.example.test/desinscription/';
  const CARNET = 'https://aimmo.example.test/carnet/';
  // Paris en mars 2028 : UTC+1.
  const paris = (day: string, hour: number) => new Date(`${day}T${String(hour - 1).padStart(2, '0')}:05:00.000Z`);

  async function setup(facts: SoldPropertyFacts | null = FACTS['appartement']!) {
    const t = await setupAnnonce();
    const dossiers = new FakeDossiersClos();
    const biens: BiensVendus = { factsOf: async () => facts };
    const carnets = new CarnetsProprietaire(t.db, t.journal, biens, SALES, { now: t.now, base: CARNET });
    const relances = new RelancesApresVente(t.db, t.journal, dossiers, { now: t.now, unsubscribeBase: BASE, carnets });
    let n = 0;
    const client = async (firstName: string) => {
      n += 1;
      const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName: 'Exemple' });
      await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: `carnet${n}@example.test` });
      return p.id;
    };
    const close = (fileId: string, closedOn: string, clients: ClosedSale['clients']) => dossiers.sales.push({ fileId, agentId: t.alexId, closedOn, city: 'Dijon', reference: 'REF-T-7', clients });
    const inbox = (personId: string) => t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ?', [personId]);
    const passes = async (from: string, days: number) => {
      for (let i = 0; i < days; i++) {
        const day = new Date(Date.parse(`${from}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
        t.setClock(paris(day, 10));
        await relances.run(t.network.id);
      }
    };
    return { ...t, dossiers, carnets, relances, client, close, inbox, passes };
  }

  it('[R65] un an après, l’acquéreur qui l’a accepté reçoit le carnet de son bien avec sa relance ; le vendeur, non', async () => {
    const t = await setup();
    const buyer = await t.client('Ana');
    const seller = await t.client('Victor');
    t.close('f1', '2027-03-09', [{ personId: seller, side: 'vendeur' }, { personId: buyer, side: 'acquereur' }]);
    t.setClock(paris('2027-03-09', 11));
    for (const p of [buyer, seller]) expect(await t.relances.recordChoice(t.agent, 'f1', p, { choice: 'un_an', proof: 'case cochée, test' })).toEqual({ ok: true });
    await t.passes('2028-03-09', 3);
    const box = await t.inbox(buyer);
    expect(box).toHaveLength(1);
    expect(box[0]!.body).toContain(`Le carnet de votre bien, un an après, sans rien à remplir : ${CARNET}`);
    const token = box[0]!.body.slice(box[0]!.body.indexOf(CARNET) + CARNET.length).slice(0, 32);
    const read = await t.carnets.read(token);
    expect(read?.text).toContain('Le carnet de votre bien à Dijon, référence REF-T-7, un an après votre achat.');
    expect(read?.text).not.toMatch(/Ana|Victor|example\.test/);
    expect(await t.carnets.read('bcdefghijklmnopqrstuvwxyzabcdefg')).toBeNull();
    // Le vendeur reçoit sa relance, sans carnet.
    const sellerBox = await t.inbox(seller);
    expect(sellerBox).toHaveLength(1);
    expect(sellerBox[0]!.body).not.toContain(CARNET);
    // Le journal dit que le carnet est fait, sans rien de son contenu.
    const events = (await t.journal.bySubject('sale_file:f1')).filter((e) => e.type === 'apres_vente.carnet');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/€|Dijon|REF/);
  });

  it('[R65] sans accord donné à l’acte, aucun carnet ; sans faits du bien, la relance part sans carnet', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const b = await t.client('Bea');
    t.close('f1', '2027-03-09', [{ personId: a, side: 'acquereur' }]);
    t.close('f2', '2027-03-09', [{ personId: b, side: 'acquereur' }]);
    t.setClock(paris('2027-03-09', 11));
    await t.relances.recordChoice(t.agent, 'f2', b, { choice: 'non', proof: 'refus à l’acte, test' });
    await t.passes('2028-03-09', 3);
    expect(await t.inbox(a)).toHaveLength(0);
    expect(await t.inbox(b)).toHaveLength(0);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM owner_booklets'))?.n).toBe(0);

    const u = await setup(null);
    const c = await u.client('Cyr');
    u.close('f3', '2027-03-09', [{ personId: c, side: 'acquereur' }]);
    u.setClock(paris('2027-03-09', 11));
    await u.relances.recordChoice(u.agent, 'f3', c, { choice: 'oui', proof: 'case cochée, test' });
    await u.passes('2028-03-09', 3);
    const box = await u.inbox(c);
    expect(box).toHaveLength(1);
    expect(box[0]!.body).not.toContain(CARNET);
  });

  it('les ventes publiques en panne : la relance part sans carnet, et l’erreur est au journal', async () => {
    const t = await setup();
    const broken = new CarnetsProprietaire(t.db, t.journal, { factsOf: async () => FACTS['appartement']! }, { coverage: async () => { throw new Error('DVF indisponible'); }, within: async () => [] }, { now: t.now, base: CARNET });
    const relances = new RelancesApresVente(t.db, t.journal, t.dossiers, { now: t.now, unsubscribeBase: BASE, carnets: broken });
    const a = await t.client('Ana');
    const v = await t.client('Victor');
    t.close('f1', '2027-03-09', [{ personId: a, side: 'acquereur' }, { personId: v, side: 'vendeur' }]);
    t.setClock(paris('2027-03-09', 11));
    for (const p of [a, v]) await relances.recordChoice(t.agent, 'f1', p, { choice: 'oui', proof: 'case cochée, test' });
    t.setClock(paris('2028-03-09', 10));
    expect(await relances.run(t.network.id)).toBe(2);
    expect((await t.inbox(a))[0]!.body).not.toContain(CARNET);
    const events = (await t.journal.bySubject('sale_file:f1')).filter((e) => e.type === 'apres_vente.carnet');
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual(['erreur']);
  });

  it('un carnet se fait une fois ; il ne change ni ne s’efface', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const sale: ClosedSale = { fileId: 'f1', agentId: t.alexId, closedOn: '2027-03-09', city: 'Dijon', reference: 'REF-T-7', clients: [{ personId: a, side: 'acquereur' }] };
    t.setClock(NOW);
    const first = await t.carnets.create(t.network.id, sale, a);
    const second = await t.carnets.create(t.network.id, sale, a);
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect((await t.carnets.read(first!.slice(CARNET.length)))?.text).toBe((await t.carnets.read(second!.slice(CARNET.length)))?.text);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM owner_booklets'))?.n).toBe(1);
    await expect(t.db.run('DELETE FROM owner_booklets')).rejects.toThrow();
    await expect(t.db.run("UPDATE owner_booklets SET content = '{}'")).rejects.toThrow();
  });
});
