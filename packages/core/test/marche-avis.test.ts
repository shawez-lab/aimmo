import { expect, it } from 'vitest';
import {
  Acces,
  AvisDeValeur,
  AvisImprime,
  COMPETITOR_FIELDS,
  FicheClient,
  FicheUnique,
  Fourchette,
  MarcheAvis,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  renderMarketSection,
  type MarketSection,
  type PublicFacts,
  type RangeResult,
  type Sale,
  type Viewer,
} from '../src/index.ts';
import type { KnownMarketRent, MarketRent } from '../src/investir/loyers.ts';
import { Pige, type RawAd } from '../src/pige/pige.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, biens, annonces, ventes et loyers inventés.
const DAY = 86_400_000;
const START = Date.parse('2026-11-02T09:00:00.000Z');

const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({
  id: `t:${i}`,
  kind: 'house' as const,
  lat: 47.33 + i * 0.0002,
  lon: 4.99,
  surface: 85 + i,
  pricePerM2: 2600 + i * 20,
  month: `2025-0${(i % 9) + 1}`,
}));

const RENT: KnownMarketRent = {
  status: 'connu',
  inseeCode: '21617',
  kind: 'house',
  rentM2Cents: 1050,
  lowerM2Cents: 900,
  upperM2Cents: 1220,
  observations: 18,
  source: 'anil',
  citation: 'Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin',
  vintage: 2025,
  asOf: '2026-10-20T08:00:00.000Z',
  importId: 'imp-1',
  reliability: 'peu_observations',
  reasons: ['observations'],
};

async function setup(rent: MarketRent = RENT) {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: net.id, firstName: 'Sam', lastName: 'Autre' });
  await db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, 'Talant', '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), net.id, alex.id]);
  const property = await store.createProperty({ networkId: net.id, agentId: alex.id, reference: 'B-1', kind: 'home', postalCode: '21240', city: 'Talant', surfaceM2: 90 });
  const pige = new Pige(db, journal, { communePrices: async () => null }, { now });
  const asked: string[] = [];
  const hook: { during: (() => Promise<void>) | null } = { during: null };
  const rents = {
    marketRent: async (_n: string, insee: string, kind: string) => {
      asked.push(`${insee}:${kind}`);
      const h = hook.during;
      hook.during = null;
      if (h) await h();
      return rent;
    },
  };
  const marche = new MarcheAvis(db, journal, rents, pige, { now });
  const avis = new AvisDeValeur(db, journal, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const imprime = new AvisImprime(db, acces, journal, { now });
  const as = (role: string, id: string) => ({ role, userId: id, networkId: net.id }) as Viewer;
  const range = async (): Promise<Extract<RangeResult, { ok: true }>> => {
    const r = await new Fourchette(
      { coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test' }), within: async () => SALES },
      undefined,
      now,
    ).estimate({ kind: 'house', surface: 90, lat: 47.33, lon: 4.99, postalCode: '21240' });
    if (!r.ok) throw new Error(r.reason);
    return r;
  };
  const off = { ok: false as const, source: 'test', collectedAt: '2026-11-02T09:00:00.000Z', reason: 'panne' as const };
  const facts = (inseeCode: string | null): PublicFacts => ({
    address: inseeCode
      ? { ok: true, value: { label: 'Talant', lat: 47.33, lon: 4.99, postalCode: '21240', inseeCode, town: 'Talant', banId: null, score: 0.9 }, source: 'test', collectedAt: '2026-11-02T09:00:00.000Z' }
      : off,
    parcel: off,
    energy: off,
    risks: off,
    missing: ['parcel', 'energy', 'risks'],
  });
  const draft = async (over: { kind?: 'apartment' | 'house'; inseeCode?: string | null } = {}) =>
    avis.draft({ networkId: net.id, propertyId: property.id, kind: over.kind ?? 'house', surface: 90, range: await range(), facts: facts(over.inseeCode === undefined ? '21617' : over.inseeCode) });
  let n = 0;
  const ad = (over: Partial<RawAd> = {}): RawAd => {
    n += 1;
    return { source: 'Site A', sourceRef: `ref-secret-${n}`, kind: 'house', commune: 'Talant', postalCode: '21240', surfaceM2: 92, rooms: 4, priceEur: 280_000, publishedAt: new Date(clock - 3 * DAY).toISOString(), text: 'Maison familiale.', ...over };
  };
  return { hook, db, journal, net, alex, sam, property, pige, marche, avis, imprime, asked, as, draft, ad, at: (t: number) => { clock = t; } };
}

describeWithSqlite('HX32 · avis de valeur enrichi : concurrence, loyer possible et marché de la commune', () => {
  it('[R303] chaque concurrent cite son site et le jour de son relevé, ses jours en ligne et ses baisses datées', async () => {
    const t = await setup();
    const first = t.ad({ sourceRef: 'ref-secret-a', priceEur: 300_000, publishedAt: '2026-10-03T08:00:00.000Z' });
    await t.pige.ingest(t.net.id, [first]);
    t.at(START + 2 * DAY);
    await t.pige.ingest(t.net.id, [{ ...first, priceEur: 285_000 }]);
    t.at(START + 5 * DAY);
    // Revue au même prix : aucune nouvelle relève, mais le jour vu en ligne avance.
    await t.pige.ingest(t.net.id, [{ ...first, priceEur: 285_000 }]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.competitors).toHaveLength(1);
    const c = got.value.competitors[0]!;
    expect(c).toMatchObject({ source: 'Site A', seenOn: '2026-11-07', publishedOn: '2026-10-03', daysOnline: 35, priceEur: 285_000, firstPriceEur: 300_000, perM2: 3098 });
    expect(c.drops).toEqual([{ on: '2026-11-04', fromEur: 300_000, toEur: 285_000 }]);
    const html = renderMarketSection(got.value);
    expect(html).toContain('Site A');
    expect(html).toContain('7 novembre 2026');
    expect(html).toContain('35 j');
    expect(html).toContain('le 4 novembre 2026, de 300 000 € à 285 000 € (−5 % depuis 300 000 €)');
  });

  it('[R303] chaque baisse est imprimée avec son jour et ses prix, pas seulement la dernière', async () => {
    const t = await setup();
    const a = t.ad({ sourceRef: 'deux-baisses', priceEur: 300_000 });
    await t.pige.ingest(t.net.id, [a]);
    t.at(START + DAY);
    await t.pige.ingest(t.net.id, [{ ...a, priceEur: 290_000 }]);
    t.at(START + 3 * DAY);
    await t.pige.ingest(t.net.id, [{ ...a, priceEur: 276_000 }]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    const html = renderMarketSection(got.value);
    expect(html).toContain('le 3 novembre 2026, de 300 000 € à 290 000 € ; le 5 novembre 2026, de 290 000 € à 276 000 € (−8 % depuis 300 000 €)');
  });

  it('[R303] toute la commune compte, quel que soit le code postal de l’annonce', async () => {
    const t = await setup();
    await t.pige.ingest(t.net.id, [t.ad({ sourceRef: 'autre-code', postalCode: '21241', surfaceM2: 91 })]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.competitors).toHaveLength(1);
    expect(got.value.market.ads).toBe(1);
  });

  it('[R303] une commune homonyme d’un autre département ne se mêle jamais au relevé', async () => {
    const t = await setup();
    await t.pige.ingest(t.net.id, [t.ad({ sourceRef: 'homonyme', postalCode: '71240', surfaceM2: 91 })]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.competitors).toEqual([]);
    expect(got.value.market.ads).toBe(0);
  });

  it('[R303] une surface corrigée en route ne fait pas perdre les baisses d’avant', async () => {
    const t = await setup();
    const a = t.ad({ sourceRef: 'surface-corrigee', surfaceM2: 90, priceEur: 300_000 });
    await t.pige.ingest(t.net.id, [a]);
    t.at(START + DAY);
    await t.pige.ingest(t.net.id, [{ ...a, surfaceM2: 91, priceEur: 280_000 }]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.competitors[0]).toMatchObject({ surfaceM2: 91, firstPriceEur: 300_000, priceEur: 280_000, drops: [{ on: '2026-11-03', fromEur: 300_000, toEur: 280_000 }] });
    expect(got.value.market.withDrops).toBe(1);
  });

  it('[R303] un même bien sur deux sites compte une fois, même après la surface corrigée sur l’un d’eux', async () => {
    const t = await setup();
    const a = t.ad({ source: 'Site A', sourceRef: 'pa', surfaceM2: 90 });
    const b = t.ad({ source: 'Site B', sourceRef: 'pb', surfaceM2: 90 });
    await t.pige.ingest(t.net.id, [a, b]);
    t.at(START + DAY);
    await t.pige.ingest(t.net.id, [{ ...a, surfaceM2: 91 }, b]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.market.ads).toBe(1);
    expect(got.value.competitors).toHaveLength(1);
    expect(got.value.competitors[0]!.sites).toBe(2);
  });

  it('[R303] une annonce corrigée vers une autre sorte sort du relevé, même revue en ligne depuis', async () => {
    const t = await setup();
    const a = t.ad({ sourceRef: 'corrigee', surfaceM2: 90 });
    await t.pige.ingest(t.net.id, [a]);
    t.at(START + DAY);
    await t.pige.ingest(t.net.id, [{ ...a, kind: 'apartment' }]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.competitors).toEqual([]);
    expect(got.value.market.ads).toBe(0);
  });

  it('[R303] seules comptent les annonces encore vues en ligne, de la sorte, de la commune et de surface proche ; un bien sur deux sites compte une fois', async () => {
    const t = await setup();
    await t.pige.ingest(t.net.id, [
      t.ad({ sourceRef: 'ancienne', surfaceM2: 91 }),
      t.ad({ kind: 'apartment', surfaceM2: 90 }),
      t.ad({ surfaceM2: 200 }),
      t.ad({ source: 'Site A', sourceRef: 'double-a', surfaceM2: 88, publishedAt: '2026-10-20T08:00:00.000Z' }),
      t.ad({ source: 'Site B', sourceRef: 'double-b', surfaceM2: 88, publishedAt: '2026-10-25T08:00:00.000Z' }),
    ]);
    t.at(START + 10 * DAY);
    await t.pige.ingest(t.net.id, [
      t.ad({ source: 'Site A', sourceRef: 'double-a', surfaceM2: 88, publishedAt: '2026-10-20T08:00:00.000Z' }),
      t.ad({ source: 'Site B', sourceRef: 'double-b', surfaceM2: 88, publishedAt: '2026-10-25T08:00:00.000Z' }),
    ]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.competitors).toHaveLength(1);
    expect(got.value.competitors[0]).toMatchObject({ source: 'Site A', sites: 2, surfaceM2: 88, publishedOn: '2026-10-20' });
    expect(got.value.market).toMatchObject({ ads: 1, withDrops: 0 });
  });

  it('[R303] un bien fermé (« pas d’agence » vu ensuite, ou non du particulier) n’est jamais montré', async () => {
    const t = await setup();
    const open = t.ad({ sourceRef: 'ouverte', surfaceM2: 95 });
    const later = t.ad({ sourceRef: 'fermee', surfaceM2: 85 });
    await t.pige.ingest(t.net.id, [open, later]);
    await t.pige.ingest(t.net.id, [{ ...later, source: 'Site B', sourceRef: 'autre', text: 'Pas d’agence merci' }]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.competitors.map((c) => c.surfaceM2)).toEqual([95]);
  });

  it('[R304] le loyer possible dit sa source telle quelle, son millésime, sa date et sa fiabilité', async () => {
    const t = await setup();
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(t.asked).toEqual(['21617:house']);
    expect(got.value.rent).toMatchObject({ status: 'connu', monthlyEur: 950, lowEur: 810, highEur: 1100, citation: RENT.citation, vintage: 2025, asOf: '2026-10-20', reliability: 'peu_observations', observations: 18 });
    const html = renderMarketSection(got.value);
    expect(html).toContain('Entre 810 € et 1 100 € par mois, charges comprises');
    expect(html).toContain(`Source : ${RENT.citation}, millésime 2025, données du 20 octobre 2026`);
    expect(html).toContain("Fiabilité : peu d'observations (18 observations)");
  });

  it('[R304] la sorte, la surface et la commune du relevé sont celles de l’avis, jamais un autre bien ; sans commune collectée, loyer « inconnu »', async () => {
    const t = await setup();
    await t.pige.ingest(t.net.id, [t.ad({ kind: 'house', surfaceM2: 90 }), t.ad({ kind: 'apartment', surfaceM2: 90 })]);
    const flat = await t.draft({ kind: 'apartment', inseeCode: '21617' });
    const got = await t.marche.attach(t.as('agent', t.alex.id), flat.id);
    if (!got.ok) throw new Error(got.code);
    expect(t.asked).toEqual(['21617:apartment']);
    expect(got.value).toMatchObject({ kind: 'apartment', surfaceM2: 90, market: { ads: 1 } });
    const noTown = await t.draft({ inseeCode: null });
    const blind = await t.marche.attach(t.as('agent', t.alex.id), noTown.id);
    if (!blind.ok) throw new Error(blind.code);
    expect(blind.value.rent).toEqual({ status: 'inconnu' });
    expect(t.asked).toHaveLength(1);
  });

  it('[R303] deux annonces de même surface sur un même site sont deux biens', async () => {
    const t = await setup();
    await t.pige.ingest(t.net.id, [t.ad({ sourceRef: 'un', surfaceM2: 90, priceEur: 270_000 }), t.ad({ sourceRef: 'deux', surfaceM2: 90, priceEur: 290_000 }), t.ad({ source: 'Site B', sourceRef: 'b', surfaceM2: 90, priceEur: 270_000, publishedAt: new Date(START - 10 * DAY).toISOString() })]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.market.ads).toBe(2);
    expect(got.value.competitors.map((c) => c.sites).sort()).toEqual([1, 2]);
  });

  it('[R304] sans loyer connu, l’avis dit « inconnu », jamais un chiffre', async () => {
    const t = await setup({ status: 'inconnu', inseeCode: '21617', kind: 'house' });
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.rent).toEqual({ status: 'inconnu' });
    const html = renderMarketSection(got.value);
    expect(html).toContain('Loyer possible : inconnu');
    expect(html.split('<h2>Loyer possible</h2>')[1]!.split('<h2>')[0]).not.toMatch(/\d+\s?€/);
  });

  it('[R305] l’avis imprimé ne porte ni nom, ni adresse, ni référence, ni texte d’annonce d’un concurrent', async () => {
    const t = await setup();
    await t.pige.ingest(t.net.id, [
      { ...t.ad({ sourceRef: 'ref-secret-x', text: 'Maison de Jean Vendeur, 12 rue des Lilas, appelez le 06 00 00 00 00' }), name: 'Jean Vendeur', address: '12 rue des Lilas', phone: '0600000000' } as RawAd,
    ]);
    const r = await t.draft();
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    for (const c of got.value.competitors) expect(Object.keys(c).sort()).toEqual([...COMPETITOR_FIELDS].sort());
    const ok = await t.avis.validate(t.as('agent', t.alex.id), r.id);
    if (!ok.ok) throw new Error(ok.code);
    const printed = await t.imprime.print(t.as('agent', t.alex.id), r.id);
    if (!printed.ok) throw new Error(printed.code);
    expect(printed.html).toContain('Les biens en concurrence');
    expect(printed.html).toContain('Site A');
    expect(printed.html).not.toMatch(/Jean|Vendeur|Lilas|06 00|0600000000|ref-secret|[Aa]ppelez/);
    const stored = await t.db.all<{ market: string }>('SELECT market FROM valuation_market_snapshots');
    expect(JSON.stringify(stored)).not.toMatch(/Jean|Lilas|ref-secret|0600/);
  });

  it('[R305] un nom de site hostile est échappé sur la page', () => {
    const m: MarketSection = {
      takenOn: '2026-11-02',
      commune: 'Talant',
      kind: 'house',
      surfaceM2: 90,
      competitors: [{ source: '<script>x</script>', sites: 1, seenOn: '2026-11-02', publishedOn: '2026-11-01', daysOnline: 1, surfaceM2: 90, rooms: null, priceEur: 250_000, firstPriceEur: 250_000, perM2: 2778, drops: [] }],
      rent: { status: 'inconnu' },
      market: { ads: 1, medianDaysOnline: 1, withDrops: 0, medianAskedPerM2: 2778, soldMedianPerM2: null, gapPct: null },
    };
    expect(renderMarketSection(m)).not.toContain('<script>');
  });

  it('le marché de la commune compare le prix affiché aux ventes réelles retenues par l’avis', async () => {
    const t = await setup();
    await t.pige.ingest(t.net.id, [t.ad({ surfaceM2: 100, priceEur: 330_000 }), t.ad({ surfaceM2: 150, priceEur: 420_000 })]);
    const r = await t.draft();
    const sold = (JSON.parse(r.computed) as { medianPerM2: number }).medianPerM2;
    const got = await t.marche.attach(t.as('agent', t.alex.id), r.id);
    if (!got.ok) throw new Error(got.code);
    expect(got.value.market).toMatchObject({ ads: 2, medianAskedPerM2: Math.round((3300 + 2800) / 2), soldMedianPerM2: sold, gapPct: Math.round(((3050 - sold) / sold) * 100) });
    expect(got.value.competitors).toHaveLength(1);
    expect(renderMarketSection(got.value)).toContain('2 annonces de particuliers en ligne pour des maisons');
  });

  it('[R306] seul l’agent actif qui suit le bien joint un relevé, et seulement à un brouillon ; la base refuse aussi', async () => {
    const t = await setup();
    const r = await t.draft();
    expect(await t.marche.attach(t.as('agent', t.sam.id), r.id)).toEqual({ ok: false, rule: 'R30', code: 'not_following_agent' });
    expect(await t.marche.attach(t.as('direction', 'd1'), r.id)).toEqual({ ok: false, rule: 'R30', code: 'not_following_agent' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.marche.attach(t.as('agent', t.alex.id), r.id)).toMatchObject({ ok: false, code: 'not_following_agent' });
    await t.db.run("UPDATE agents SET status = 'active' WHERE id = ?", [t.alex.id]);
    expect(await t.marche.attach(t.as('agent', t.alex.id), 42)).toEqual({ ok: false, rule: null, code: 'invalid' });
    expect((await t.marche.attach(t.as('agent', t.alex.id), r.id)).ok).toBe(true);
    const ok = await t.avis.validate(t.as('agent', t.alex.id), r.id);
    if (!ok.ok) throw new Error(ok.code);
    expect(await t.marche.attach(t.as('agent', t.alex.id), r.id)).toEqual({ ok: false, rule: 'R306', code: 'already_validated' });
    await expect(
      t.db.run("INSERT INTO valuation_market_snapshots (id, network_id, report_id, agent_id, market, created_at) VALUES ('x', ?, ?, ?, '{}', '2026-11-02T00:00:00.000Z')", [t.net.id, r.id, t.alex.id]),
    ).rejects.toThrow(/avis validé/);
  });

  it('[R306] la page imprimée lit la dernière relève faite avant la validation ; rien ne change ni ne s’efface', async () => {
    const t = await setup();
    const r = await t.draft();
    await t.marche.attach(t.as('agent', t.alex.id), r.id);
    t.at(START + DAY);
    await t.pige.ingest(t.net.id, [t.ad({ surfaceM2: 90, priceEur: 260_000 })]);
    await t.marche.attach(t.as('agent', t.alex.id), r.id);
    expect((await t.marche.latest(r.id))?.competitors).toHaveLength(1);
    const ok = await t.avis.validate(t.as('agent', t.alex.id), r.id);
    if (!ok.ok) throw new Error(ok.code);
    const printed = await t.imprime.print(t.as('agent', t.alex.id), r.id);
    if (!printed.ok) throw new Error(printed.code);
    expect(printed.html).toContain('260 000 €');
    await expect(t.db.run("UPDATE valuation_market_snapshots SET market = '{}'")).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM valuation_market_snapshots')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('DELETE FROM pige_ad_sightings')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R306] une autre panne de la base à l’enregistrement remonte, jamais dite « déjà validé »', async () => {
    const t = await setup();
    const r = await t.draft();
    await t.db.run("CREATE TRIGGER panne_essai BEFORE INSERT ON valuation_market_snapshots BEGIN SELECT RAISE(ABORT, 'panne d''essai'); END");
    await expect(t.marche.attach(t.as('agent', t.alex.id), r.id)).rejects.toThrow(/panne d'essai/);
  });

  it('[R306] un relevé joint après la lecture change la version : la validation sur la version lue est refusée', async () => {
    const t = await setup();
    const r = await t.draft();
    expect((await t.marche.attach(t.as('agent', t.alex.id), r.id)).ok).toBe(true);
    const read = (await t.avis.get(r.id))!.updated_at;
    expect((await t.marche.attach(t.as('agent', t.alex.id), r.id)).ok).toBe(true);
    expect(await t.avis.validate(t.as('agent', t.alex.id), r.id, read)).toEqual({ ok: false, rule: 'R30', code: 'changed_meanwhile' });
    const fresh = (await t.avis.get(r.id))!.updated_at;
    expect((await t.avis.validate(t.as('agent', t.alex.id), r.id, fresh)).ok).toBe(true);
  });

  it('[R306] deux relevés croisés ne partagent jamais une version : le second n’entre pas, et c’est dit', async () => {
    const t = await setup();
    const r = await t.draft();
    let read = '';
    // Pendant le calcul du premier relevé, un second se joint en entier, et l'écran lit la version qu'il laisse.
    t.hook.during = async () => {
      expect((await t.marche.attach(t.as('agent', t.alex.id), r.id)).ok).toBe(true);
      read = (await t.avis.get(r.id))!.updated_at;
    };
    expect(await t.marche.attach(t.as('agent', t.alex.id), r.id)).toEqual({ ok: false, rule: 'R306', code: 'changed_meanwhile' });
    expect(await t.db.all('SELECT id FROM valuation_market_snapshots')).toHaveLength(1);
    expect((await t.avis.get(r.id))!.updated_at).toBe(read);
    expect((await t.avis.validate(t.as('agent', t.alex.id), r.id, read)).ok).toBe(true);
  });

  it('[R306] une modification croisée qui pose la même version ne laisse pas entrer le relevé', async () => {
    const t = await setup();
    const r = await t.draft();
    const same = new Date(Date.parse(r.updated_at) + 1).toISOString();
    t.hook.during = async () => {
      await t.db.run('UPDATE valuation_reports SET updated_at = ? WHERE id = ?', [same, r.id]);
    };
    expect(await t.marche.attach(t.as('agent', t.alex.id), r.id)).toEqual({ ok: false, rule: 'R306', code: 'changed_meanwhile' });
    expect(await t.db.all('SELECT id FROM valuation_market_snapshots')).toHaveLength(0);
  });

  it('[R306] une modification après un relevé, horloge arrêtée, ne rend jamais une version déjà lue', async () => {
    const t = await setup();
    const r = await t.draft();
    expect((await t.marche.attach(t.as('agent', t.alex.id), r.id)).ok).toBe(true);
    const adjusted = await t.avis.adjust(t.as('agent', t.alex.id), r.id, { text: 'Pour votre maison, nous estimons la valeur entre 233 000 € et 258 000 €.' });
    if (!adjusted.ok) throw new Error(adjusted.code);
    expect(adjusted.value.updated_at > r.updated_at).toBe(true);
    expect(await t.avis.validate(t.as('agent', t.alex.id), r.id, r.updated_at)).toEqual({ ok: false, rule: 'R30', code: 'changed_meanwhile' });
  });

  it('[R306] un bien réattribué pendant le calcul : le relevé n’entre pas', async () => {
    const t = await setup();
    const r = await t.draft();
    t.hook.during = async () => {
      await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.id, t.property.id]);
    };
    expect(await t.marche.attach(t.as('agent', t.alex.id), r.id)).toEqual({ ok: false, rule: 'R30', code: 'not_following_agent' });
    expect(await t.db.all('SELECT id FROM valuation_market_snapshots')).toHaveLength(0);
  });

  it('[R306] un agent parti le jour même, avant le passage du départ, ne joint rien', async () => {
    const t = await setup();
    const r = await t.draft();
    await t.db.run("INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('dep-1', ?, ?, '2026-10-01', '2026-11-02', 'demission_agent', 1, 'd1', '2026-10-01T08:00:00.000Z')", [t.net.id, t.alex.id]);
    expect(await t.marche.attach(t.as('agent', t.alex.id), r.id)).toEqual({ ok: false, rule: 'R30', code: 'not_following_agent' });
  });

  it('[R13] le journal du relevé ne porte que des comptes', async () => {
    const t = await setup();
    await t.pige.ingest(t.net.id, [t.ad()]);
    const r = await t.draft();
    await t.marche.attach(t.as('agent', t.alex.id), r.id);
    const rows = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'avis.marche'");
    expect(rows).toHaveLength(1);
    // L'identifiant de l'avis est tiré au hasard : il peut porter « 280 » sans rien dire du relevé.
    const data = JSON.parse(rows[0]!.data) as Record<string, unknown>;
    expect(typeof data.report).toBe('string');
    expect(JSON.stringify({ ...data, report: null })).not.toMatch(/Site A|280|Talant|21617|ANIL/);
  });

  it('un avis sans relevé s’imprime comme avant', async () => {
    const t = await setup();
    const r = await t.draft();
    const ok = await t.avis.validate(t.as('agent', t.alex.id), r.id);
    if (!ok.ok) throw new Error(ok.code);
    const printed = await t.imprime.print(t.as('agent', t.alex.id), r.id);
    if (!printed.ok) throw new Error(printed.code);
    expect(printed.html).not.toContain('Les biens en concurrence');
  });
});
