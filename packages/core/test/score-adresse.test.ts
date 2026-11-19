import { expect, it } from 'vitest';
import type { Geocoded } from '../src/estimation/collecte.ts';
import type { Sale } from '../src/estimation/fourchette.ts';
import { BAN_SOURCE, ScoreAdresse, addressCarriesPerson, bandOf, computeScore, factsHash, type AddressFacts, type ScoreServices } from '../src/score-adresse/score.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, adresses, diagnostics et ventes inventés.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const TODAY = '2026-12-07';
const DAY = 24 * 3_600_000;

const facts = (over: Partial<AddressFacts> = {}): AddressFacts => ({
  address: { key: 'ban:21617_0001_00007', label: '7 Rue des Essais 21240 Talant', postcode: '21240', commune: 'Talant', inseeCode: '21617' },
  energy: { energyClass: 'G', diagnosedOn: '2026-10-01', number: '2621E0000001T', source: 'Diagnostics de performance énergétique (ADEME)' },
  parcel: { id: '21617000AB0042', areaM2: 1800, source: 'Cadastre (IGN, API Carto)', readOn: TODAY },
  sales: { count: 50, years: [2021, 2022, 2023, 2024, 2025], lastSale: '2025-12-31', source: 'DVF (DGFiP), fichiers du site', radiusM: 200 },
  missing: [],
  ...over,
});

it('[R291] chaque point du score cite sa donnée publique, sa source et sa date', () => {
  const r = computeScore(facts(), TODAY);
  expect(r.points.map((p) => p.signal)).toEqual(['diagnostic_recent', 'interdiction_louer', 'ventes_voisinage', 'grande_parcelle']);
  for (const p of r.points) {
    expect(p.points).toBeGreaterThan(0);
    expect(p.fact.length).toBeGreaterThan(10);
    expect(p.source.length).toBeGreaterThan(3);
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
  expect(r.points[0]).toMatchObject({ points: 35, source: 'Diagnostics de performance énergétique (ADEME)', date: '2026-10-01' });
  expect(r.points[1]).toMatchObject({ source: BAN_SOURCE, date: '2025-01-01' });
  expect(r.points[1]!.fact).toContain('1er janvier 2025');
  expect(r.points[1]!.fact).toContain('1er octobre 2026');
  expect(r.points[2]).toMatchObject({ points: 15, source: 'DVF (DGFiP), fichiers du site', date: '2025-12-31' });
  expect(r.points[2]!.fact).toBe('10 ventes par an en moyenne à moins de 200 m, de 2021 à 2025.');
  expect(r.points[3]).toMatchObject({ points: 10, date: TODAY });
  expect(r.score).toBe(80);
  expect(r.band).toBe('tres_fort');
});

it('[R291] le même jeu de données donne le même score et la même empreinte ; une donnée absente ne donne aucun point', async () => {
  const a = computeScore(facts(), TODAY);
  const b = computeScore(JSON.parse(JSON.stringify(facts())) as AddressFacts, TODAY);
  expect(b).toEqual(a);
  expect(await factsHash(facts())).toBe(await factsHash(JSON.parse(JSON.stringify(facts())) as AddressFacts));
  expect(await factsHash(facts({ parcel: null }))).not.toBe(await factsHash(facts()));
  const none = computeScore(facts({ energy: null, parcel: null, sales: null }), TODAY);
  expect(none).toEqual({ score: 0, band: 'faible', points: [] });
  // Un diagnostic plus ancien compte moins, puis plus ; une classe D n'a pas de date d'interdiction.
  const old = computeScore(facts({ energy: { energyClass: 'D', diagnosedOn: '2026-01-15', number: null, source: 'ADEME' }, parcel: null, sales: null }), TODAY);
  expect(old.points).toEqual([{ signal: 'diagnostic_recent', points: 20, fact: expect.stringContaining('15 janvier 2026') as string, source: 'ADEME', date: '2026-01-15' }]);
  expect(computeScore(facts({ energy: { energyClass: 'D', diagnosedOn: '2024-01-15', number: null, source: 'ADEME' }, parcel: null, sales: null }), TODAY).points).toEqual([]);
  expect([bandOf(0), bandOf(14), bandOf(15), bandOf(35), bandOf(55)]).toEqual(['faible', 'faible', 'moyen', 'fort', 'tres_fort']);
});

it('[R291] [R29] aucune vente d’une adresse ni durée de détention : les ventes publiques n’entrent qu’en compte du voisinage', () => {
  const r = computeScore(facts(), TODAY);
  const text = JSON.stringify(r);
  expect(text).not.toMatch(/€|prix|achet|détention|detention|propriétaire depuis/i);
  // Peu de ventes dans le voisinage : aucun point, rien n'est dit d'une vente.
  expect(computeScore(facts({ sales: { count: 4, years: [2021, 2022, 2023, 2024, 2025], lastSale: '2025-12-31', source: 'DVF', radiusM: 200 } }), TODAY).points.map((p) => p.signal)).not.toContain('ventes_voisinage');
});

// Environ 0,0009 degré de latitude font 100 m.
function sale(i: number, kind: 'apartment' | 'house', dLat = 0): Sale {
  return { id: `t:${i}`, kind, lat: 47.33 + dLat, lon: 5.01, surface: 60, pricePerM2: 2500, month: '2024-05' };
}

/** Des services publics inventés, qui rendent aussi des champs de trop : ils ne doivent jamais passer [R291]. */
function fakeServices(over: { geocoded?: Partial<Geocoded> | null; failSales?: boolean; far?: number; issues?: number; department?: string } = {}) {
  const calls: string[] = [];
  const services: ScoreServices = {
    geocoder: {
      geocode: async (a) => {
        calls.push(`geocode:${a}`);
        if (over.geocoded === null) return null;
        return { label: '7 Rue des Essais 21240 Talant', lat: 47.33, lon: 5.01, postalCode: '21240', inseeCode: '21617', town: 'Talant', banId: '21617_0001_00007', score: 0.95, ...over.geocoded, owner: 'Jean Essai' } as Geocoded;
      },
    },
    cadastre: { parcelAt: async () => ({ id: '21617000AB0042', section: 'AB', number: '0042', area: 1800, proprietaire: 'Jean Essai' }) as never },
    energy: { latestFor: async () => ({ energyClass: 'F', ghgClass: 'E', date: '2026-11-20', diagnosisNumber: '2621E0000002T', nom_proprietaire: 'Jean Essai', telephone: '0600000000' }) as never },
    sales: {
      coverage: async () => ({ department: over.department ?? '21', lastSale: '2025-12-31', years: [2021, 2022, 2023, 2024, 2025], source: 'DVF (DGFiP), fichiers du site' }),
      scan: async (kind) => {
        if (over.failSales) throw new Error('panne');
        // 15 maisons et 35 appartements dans le rayon ; `far` ventes de plus à environ 400 m, hors du rayon.
        const near = Array.from({ length: kind === 'house' ? 15 : 35 }, (_, i) => sale(i, kind, i % 2 === 0 ? 0.0013 : -0.0013));
        const far = Array.from({ length: kind === 'house' ? (over.far ?? 0) : 0 }, (_, i) => sale(100 + i, kind, 0.0036));
        return { sales: [...near, ...far], issues: kind === 'house' ? (over.issues ?? 0) : 0 };
      },
    },
  };
  return { services, calls };
}

async function setup(services: ScoreServices | null = fakeServices().services) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const scores = new ScoreAdresse(db, services, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const zone = (agentId: string, commune: string) =>
    db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), network.id, agentId, commune]);
  await zone(alex.id, 'Talant');
  await zone(sam.id, 'Dijon');
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  let n = 0;
  const mandate = async (agentId: string, city: string | null, signedAt: number) => {
    n += 1;
    const seller = await store.createPerson({ networkId: network.id, agentId, firstName: 'Vera', lastName: `Vendeuse${n}` });
    const property = await store.createProperty({ networkId: network.id, agentId, reference: `B${n}`, kind: 'home', city, priceEur: 200_000, surfaceM2: 80, rooms: 4, status: 'available' });
    const id = `m${n}`;
    await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'neighbourhood_letter', 'test', ?)", [
      id,
      network.id,
      agentId,
      seller.id,
      property.id,
      new Date(signedAt).toISOString(),
      new Date(signedAt).toISOString(),
    ]);
    return id;
  };
  return { db, journal, scores, network, alex, sam, as, agentAlex: as('agent', alex.id), agentSam: as('agent', sam.id), direction: as('direction', 'd1'), setClock: (t: number) => (clock = t), mandate };
}

describeWithSqlite('HX17 · score de vente par adresse', () => {
  it('[R291] le score rangé garde ses points sourcés et datés, et aucune donnée de personne rendue par une source', async () => {
    const t = await setup();
    const r = await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.points.map((p) => [p.signal, p.points])).toEqual([
      ['diagnostic_recent', 35],
      ['interdiction_louer', 20],
      ['ventes_voisinage', 15],
      ['grande_parcelle', 10],
    ]);
    expect(r.value).toMatchObject({ score: 80, band: 'tres_fort', scoredOn: TODAY, address: { label: '7 Rue des Essais 21240 Talant', commune: 'Talant' } });
    expect(r.value.factsHash).toMatch(/^[0-9a-f]{64}$/);
    // Rien de ce qu'une source rend en trop n'entre : ni nom, ni numéro, ni vente [R291, R29].
    const stored = JSON.stringify(await t.db.all('SELECT * FROM address_scores'));
    for (const out of [JSON.stringify(r.value), stored]) {
      expect(out).not.toMatch(/Jean|Essai"|0600000000|proprietaire|2500|t:\d/);
    }
    // Noté de nouveau le même jour : le même score, rangé une seule fois.
    const again = await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' });
    expect(again.ok && again.value.scoreId).toBe(r.value.scoreId);
    expect(await t.db.all('SELECT id FROM address_scores')).toHaveLength(1);
    // Au journal : le score et sa tranche, jamais l'adresse [R13].
    const events = await t.journal.all();
    const journal = JSON.stringify(events);
    expect(journal).toContain('score_adresse.calcule');
    expect(journal).not.toMatch(/Essais|Talant|21240/);
    expect((await verifyChain(events)).ok).toBe(true);
  });

  it('[R291] une source en panne ne donne aucun point et se dit avec sa raison ; rien n’est inventé', async () => {
    const t = await setup(fakeServices({ failSales: true }).services);
    const r = await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.points.map((p) => p.signal)).not.toContain('ventes_voisinage');
    expect(r.value.missing).toEqual([{ source: 'Demandes de valeurs foncières (DGFiP)', reason: 'panne' }]);
    expect(r.value.score).toBe(65);
  });

  it('[R292] seul un agent en activité note une adresse d’une commune de ses zones, sans nom ; la direction lit tout', async () => {
    const t = await setup();
    // Sam n'a pas Talant dans ses zones.
    expect(await t.scores.score(t.agentSam, { address: '7 rue des Essais, Talant' })).toEqual({ ok: false, rule: 'R16', code: 'hors_zone' });
    expect(await t.scores.score(t.direction, { address: '7 rue des Essais, Talant' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.scores.score(t.as('compliance', 'c1'), { address: '7 rue des Essais, Talant' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.scores.score(t.agentAlex, { address: 'Chez Martin, 7 rue des Essais, Talant' })).toEqual({ ok: false, rule: 'R292', code: 'nom_dans_adresse' });
    expect(await t.scores.score(t.agentAlex, { address: 'Mme Dupont 7 rue des Essais Talant' })).toEqual({ ok: false, rule: 'R292', code: 'nom_dans_adresse' });
    expect(await t.scores.score(t.agentAlex, { address: '7 rue\ndes Essais' })).toEqual({ ok: false, rule: null, code: 'bad_address' });
    expect(await t.db.all('SELECT id FROM address_scores')).toHaveLength(0);
    // Un agent parti ne note plus rien.
    await t.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('dep-1', ?, ?, '2026-11-01', '2026-12-01', 'demission_agent', 1, 'direction:d1', '2026-11-01T10:00:00.000Z')",
      [t.network.id, t.alex.id],
    );
    expect(await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' })).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  it('[R292] une adresse sans numéro, introuvable ou incertaine n’est pas notée', async () => {
    const t1 = await setup(fakeServices({ geocoded: { label: 'Rue des Essais 21240 Talant' } }).services);
    expect(await t1.scores.score(t1.agentAlex, { address: 'rue des Essais, Talant' })).toEqual({ ok: false, rule: 'R291', code: 'sans_numero' });
    const t2 = await setup(fakeServices({ geocoded: null }).services);
    expect(await t2.scores.score(t2.agentAlex, { address: '7 rue des Essais, Talant' })).toEqual({ ok: false, rule: 'R291', code: 'adresse_introuvable' });
    const t3 = await setup(fakeServices({ geocoded: { score: 0.3 } }).services);
    expect(await t3.scores.score(t3.agentAlex, { address: '7 rue des Essais, Talant' })).toEqual({ ok: false, rule: 'R291', code: 'adresse_incertaine' });
    const t4 = await setup(null);
    expect(await t4.scores.score(t4.agentAlex, { address: '7 rue des Essais, Talant' })).toEqual({ ok: false, rule: null, code: 'sources_absentes' });
  });

  it('[R292] la liste ne montre à l’agent que les adresses de ses zones ; la direction voit tout le réseau', async () => {
    const t = await setup();
    const r = await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' });
    expect(r.ok).toBe(true);
    const alex = await t.scores.list(t.agentAlex);
    const sam = await t.scores.list(t.agentSam);
    const dir = await t.scores.list(t.direction);
    expect(alex.ok && alex.scores.map((s) => s.score)).toEqual([80]);
    expect(sam.ok && sam.scores).toEqual([]);
    expect(dir.ok && dir.scores).toHaveLength(1);
  });

  it('[R293] jamais vu : le taux de mandats réellement signés par tranche, lu dans les mandats, sur les années closes', async () => {
    const t = await setup();
    const r = await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' });
    if (!r.ok) throw new Error('score');
    const first = await t.scores.measure(t.direction);
    expect(first.ok && first.bands.find((b) => b.band === 'tres_fort')).toEqual({ band: 'tres_fort', label: '55 points et plus', scored: 1, closed: 0, signed: 0, signedClosed: 0, rate: null });
    // Un mandat signé avant le score ne compte pas ; un mandat d'une autre commune non plus ; celui d'un autre agent est refusé.
    const before = await t.mandate(t.alex.id, 'Talant', MONDAY_9H - 2 * DAY);
    expect(await t.scores.linkMandate(t.agentAlex, { scoreId: r.value.scoreId, mandateId: before })).toEqual({ ok: false, rule: 'R293', code: 'mandat_avant_score' });
    const elsewhere = await t.mandate(t.alex.id, 'Dijon', MONDAY_9H + 30 * DAY);
    expect(await t.scores.linkMandate(t.agentAlex, { scoreId: r.value.scoreId, mandateId: elsewhere })).toEqual({ ok: false, rule: 'R293', code: 'autre_commune' });
    const late = await t.mandate(t.alex.id, 'Talant', MONDAY_9H + 400 * DAY);
    expect(await t.scores.linkMandate(t.agentAlex, { scoreId: r.value.scoreId, mandateId: late })).toEqual({ ok: false, rule: 'R293', code: 'mandat_hors_annee' });
    const good = await t.mandate(t.alex.id, 'Talant', MONDAY_9H + 60 * DAY);
    expect(await t.scores.linkMandate(t.agentSam, { scoreId: r.value.scoreId, mandateId: good })).toEqual({ ok: false, rule: 'R16', code: 'pas_son_mandat' });
    expect(await t.scores.linkMandate(t.agentAlex, { scoreId: r.value.scoreId, mandateId: good })).toEqual({ ok: true });
    expect(await t.scores.linkMandate(t.agentAlex, { scoreId: r.value.scoreId, mandateId: good })).toEqual({ ok: false, rule: 'R293', code: 'deja_relie' });
    // Une seconde adresse, plus faible, sans mandat.
    const weak = new ScoreAdresse(t.db, { ...fakeServices({ geocoded: { label: '9 Rue des Essais 21240 Talant', banId: '21617_0001_00009' } }).services, energy: { latestFor: async () => null }, cadastre: { parcelAt: async () => null } }, t.journal, { now: () => new Date(MONDAY_9H) });
    const w = await weak.score(t.agentAlex, { address: '9 rue des Essais, Talant' });
    expect(w.ok && w.value.band).toBe('moyen');
    // L'année n'est pas close : le taux ne se dit pas encore.
    const open = await t.scores.measure(t.agentAlex);
    expect(open.ok && open.bands.find((b) => b.band === 'tres_fort')).toMatchObject({ scored: 1, closed: 0, signed: 1, signedClosed: 0, rate: null });
    // Un an et un jour plus tard : un mandat pour une adresse « très fort », aucun pour « moyen ».
    t.setClock(MONDAY_9H + 366 * DAY);
    const closed = await t.scores.measure(t.direction);
    if (!closed.ok) throw new Error('measure');
    expect(closed.bands.map((b) => [b.band, b.scored, b.closed, b.signedClosed, b.rate])).toEqual([
      ['faible', 0, 0, 0, null],
      ['moyen', 1, 1, 0, 0],
      ['fort', 0, 0, 0, null],
      ['tres_fort', 1, 1, 1, 1],
    ]);
    // Le compte rendu ne porte que des nombres : aucune adresse, aucun nom [R13].
    expect(JSON.stringify(closed)).not.toMatch(/Essais|Talant|Vera|Vendeuse/);
    // Chaque nombre se recalcule depuis la base : les mandats reliés sont ceux de G03.
    const linked = await t.db.all<{ mandate_id: string }>('SELECT l.mandate_id FROM address_score_mandates l JOIN mandates m ON m.id = l.mandate_id');
    expect(linked.map((l) => l.mandate_id)).toEqual([good]);
  });

  it('[R291] seules comptent les ventes à moins de 200 m ; des ventes illisibles ou un autre département se disent manquantes', async () => {
    // 50 ventes à 150 m et 200 de plus à 400 m : seules les 50 comptent (10 par an).
    const t = await setup(fakeServices({ far: 200 }).services);
    const r = await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' });
    expect(r.ok && r.value.points.find((p) => p.signal === 'ventes_voisinage')?.fact).toBe('10 ventes par an en moyenne à moins de 200 m, de 2021 à 2025.');
    const t2 = await setup(fakeServices({ issues: 1 }).services);
    const r2 = await t2.scores.score(t2.agentAlex, { address: '7 rue des Essais, Talant' });
    expect(r2.ok && r2.value.missing).toEqual([{ source: 'DVF (DGFiP), fichiers du site', reason: 'illisible' }]);
    expect(r2.ok && r2.value.points.map((p) => p.signal)).not.toContain('ventes_voisinage');
    const t3 = await setup(fakeServices({ department: '71' }).services);
    const r3 = await t3.scores.score(t3.agentAlex, { address: '7 rue des Essais, Talant' });
    expect(r3.ok && r3.value.missing).toEqual([{ source: 'DVF (DGFiP), fichiers du site', reason: 'hors_zone' }]);
  });

  it('[R292] le titre d’une voie n’est pas un nom ; une civilité dans l’adresse trouvée l’est', async () => {
    expect(addressCarriesPerson('12 rue du Docteur Chaussier, Dijon')).toBe(false);
    expect(addressCarriesPerson('3 boulevard Docteur Petitjean 21000 Dijon')).toBe(false);
    expect(addressCarriesPerson('5 place du Président Wilson, Dijon')).toBe(false);
    expect(addressCarriesPerson('M. Dupont 7 rue des Essais')).toBe(true);
    expect(addressCarriesPerson('7 rue des Essais chez Martin')).toBe(true);
    const t = await setup(fakeServices({ geocoded: { label: '12 Rue du Docteur Chaussier 21240 Talant' } }).services);
    expect((await t.scores.score(t.agentAlex, { address: '12 rue du Docteur Chaussier, Talant' })).ok).toBe(true);
    const t2 = await setup(fakeServices({ geocoded: { label: '7 Rue des Essais Mme Dupont 21240 Talant' } }).services);
    expect(await t2.scores.score(t2.agentAlex, { address: '7 rue des Essais, Talant' })).toEqual({ ok: false, rule: 'R292', code: 'nom_dans_adresse' });
    expect(await t2.db.all('SELECT id FROM address_scores')).toHaveLength(0);
  });

  it('[R293] un bien sans commune ne se relie pas ; un mandat signé le jour du score compte, quelle que soit l’heure', async () => {
    const t = await setup();
    const r = await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' });
    if (!r.ok) throw new Error('score');
    const nowhere = await t.mandate(t.alex.id, null, MONDAY_9H + 10 * DAY);
    expect(await t.scores.linkMandate(t.agentAlex, { scoreId: r.value.scoreId, mandateId: nowhere })).toEqual({ ok: false, rule: 'R293', code: 'commune_inconnue' });
    // Le 7 décembre à 0 h 30, heure de Paris, avant le score de 9 h.
    const sameDay = await t.mandate(t.alex.id, 'Talant', Date.parse('2026-12-06T23:30:00.000Z'));
    expect(await t.scores.linkMandate(t.agentAlex, { scoreId: r.value.scoreId, mandateId: sameDay })).toEqual({ ok: true });
    const m = await t.scores.measure(t.agentAlex);
    expect(m.ok && m.bands.find((b) => b.band === 'tres_fort')).toMatchObject({ scored: 1, signed: 1 });
  });

  it('[R291] une parcelle sans contenance se dit manquante ; une date de diagnostic impossible est illisible, sans casser le score', async () => {
    const base = fakeServices().services;
    const t = await setup({
      ...base,
      cadastre: { parcelAt: async () => ({ id: '21617000AB0042', section: 'AB', number: '0042', area: null }) },
      energy: { latestFor: async () => ({ energyClass: 'F', ghgClass: null, date: '2026-13-01', diagnosisNumber: null }) },
    });
    const r = await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.missing).toEqual([
      { source: 'Diagnostics de performance énergétique (ADEME)', reason: 'illisible' },
      { source: 'Cadastre (IGN, API Carto)', reason: 'contenance_absente' },
    ]);
    expect(r.value.points.map((p) => p.signal)).toEqual(['ventes_voisinage']);
  });

  it('[R291] rien ne change ni ne s’efface', async () => {
    const t = await setup();
    const r = await t.scores.score(t.agentAlex, { address: '7 rue des Essais, Talant' });
    expect(r.ok).toBe(true);
    await expect(t.db.run('UPDATE address_scores SET score = 0')).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM address_scores')).rejects.toThrow(/rien ne s'efface/);
  });
});

it('[R100] AU098b · une adresse de La Réunion classée G suit le calendrier de l’outre-mer : interdite à partir de 2028', () => {
  const r = computeScore(facts({ address: { key: 'ban:97411_0001_00007', label: '7 Rue des Essais 97400 Saint-Denis', postcode: '97400', commune: 'Saint-Denis', inseeCode: '97411' } }), TODAY);
  expect(r.points.find((p) => p.signal === 'interdiction_louer')?.fact).toContain('à partir du 1er janvier 2028');
});
