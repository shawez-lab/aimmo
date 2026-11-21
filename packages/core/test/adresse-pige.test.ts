import { expect, it } from 'vitest';
import { AdressePige, AdemeDiagnosisSearch, proposeAddresses, type AdFacts, type DiagnosisSearch } from '../src/adresse-pige/adresse.ts';
import type { CadastreService } from '../src/estimation/collecte.ts';
import { adFingerprint, cleanAd, Pige, type RawAd } from '../src/pige/pige.ts';
import type { Diagnosis } from '../src/veille-dpe/veille.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, annonces, diagnostics et parcelles inventés.
const MONDAY_10H = Date.parse('2026-12-07T09:00:00.000Z');
const DAY = 86_400_000;

const diag = (over: Partial<Diagnosis> = {}): Diagnosis => ({
  number: '2621E0000001T',
  kind: 'house',
  energyClass: 'F',
  ghgClass: 'E',
  surfaceM2: 90.2,
  diagnosedOn: '2026-09-15',
  receivedOn: '2026-09-16',
  streetNumber: '7',
  street: 'Rue des Essais',
  postcode: '21240',
  commune: 'Talant',
  lat: 47.33,
  lon: 5.01,
  ...over,
});

const facts = (over: Partial<AdFacts> = {}): AdFacts => ({
  kind: 'house',
  postcode: '21240',
  commune: 'Talant',
  surfaceM2: 90,
  energyClass: 'F',
  diagnosedOn: '2026-09-15',
  publishedOn: '2026-12-06',
  site: 'Site A',
  ...over,
});

it('[R294] chaque adresse proposée montre sa confiance, et chaque point cite sa donnée, sa source et sa date', () => {
  const [c, ...rest] = proposeAddresses(facts(), [diag()], { byDiagnosis: { '2621E0000001T': { id: '21617000AB0042', areaM2: 600 } }, readOn: '2026-12-07' });
  expect(rest).toEqual([]);
  expect(c).toMatchObject({ diagnosisNumber: '2621E0000001T', streetNumber: '7', street: 'Rue des Essais', confidence: 100, level: 'forte' });
  expect(c!.points.map((p) => [p.criterion, p.points])).toEqual([
    ['surface', 35],
    ['classe_energie', 25],
    ['date_diagnostic', 25],
    ['cadastre', 15],
  ]);
  for (const p of c!.points) {
    expect(p.fact.length).toBeGreaterThan(10);
    expect(p.source.length).toBeGreaterThan(3);
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
  expect(c!.points[0]!.fact).toContain('90,2 m²');
  expect(c!.points[3]).toMatchObject({ source: 'Cadastre (IGN, API Carto)', date: '2026-12-07' });
  expect(c!.points[3]!.fact).toContain('21617000AB0042');
});

it('[R294] un critère tu par l’annonce ne donne aucun point et le dit ; un critère contredit écarte l’adresse ; la confiance se partage', () => {
  const two = [diag(), diag({ number: '2621E0000002T', streetNumber: '9', surfaceM2: 89.4 })];
  const silent = proposeAddresses(facts({ energyClass: null, diagnosedOn: null }), two, { byDiagnosis: {}, readOn: '2026-12-07' });
  expect(silent).toHaveLength(2);
  const first = silent[0]!;
  expect(first.points.find((p) => p.criterion === 'classe_energie')).toMatchObject({ points: 0, source: 'Site A' });
  expect(first.points.find((p) => p.criterion === 'date_diagnostic')).toMatchObject({ points: 0 });
  expect(first.points.find((p) => p.criterion === 'cadastre')).toMatchObject({ points: 0 });
  // 35 et 25 points, partagés : la plus proche en surface d'abord, aucune n'est « forte ».
  expect(silent.map((c) => c.diagnosisNumber)).toEqual(['2621E0000001T', '2621E0000002T']);
  expect(silent.map((c) => c.confidence)).toEqual([20, 10]);
  expect(silent.every((c) => c.level === 'faible')).toBe(true);
  expect(first.points.find((p) => p.criterion === 'partage')?.fact).toContain('2 adresses');
  // L'annonce dit F : un diagnostic classé D est écarté ; une autre date aussi ; une autre surface aussi.
  expect(proposeAddresses(facts(), [diag({ energyClass: 'D' })], { byDiagnosis: {}, readOn: '2026-12-07' })).toEqual([]);
  expect(proposeAddresses(facts(), [diag({ diagnosedOn: '2026-09-14' })], { byDiagnosis: {}, readOn: '2026-12-07' })).toEqual([]);
  expect(proposeAddresses(facts(), [diag({ surfaceM2: 92 })], { byDiagnosis: {}, readOn: '2026-12-07' })).toEqual([]);
  // Un diagnostic plus vieux que dix ans, ou établi après l'annonce, n'en propose pas.
  expect(proposeAddresses(facts({ energyClass: null, diagnosedOn: null }), [diag({ diagnosedOn: '2016-12-05' })], { byDiagnosis: {}, readOn: '2026-12-07' })).toEqual([]);
  expect(proposeAddresses(facts({ energyClass: null, diagnosedOn: null }), [diag({ diagnosedOn: '2026-12-07' })], { byDiagnosis: {}, readOn: '2026-12-07' })).toEqual([]);
  // Les mêmes données, dans un autre ordre, donnent les mêmes adresses.
  expect(proposeAddresses(facts({ energyClass: null, diagnosedOn: null }), [...two].reverse(), { byDiagnosis: {}, readOn: '2026-12-07' })).toEqual(silent);
});

it('[R294] plusieurs diagnostics d’un même logement font une seule adresse, représentée par le plus récent', () => {
  const r = proposeAddresses(facts({ diagnosedOn: null }), [diag({ number: '2621E0000005T', diagnosedOn: '2025-03-01' }), diag(), diag({ number: '2621E0000006T', street: 'rue des essais' })], { byDiagnosis: {}, readOn: '2026-12-07' });
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ diagnosisNumber: '2621E0000001T', confidence: 60 });
});

it('[R294] une adresse qui porte une civilité ou un nom est écartée ; le titre d’une voie ne l’est pas ; aucun nom dans le résultat', () => {
  const r = proposeAddresses(facts(), [diag({ street: 'Chez Mme Essai' }), diag({ number: '2621E0000003T', street: 'Rue du Docteur Chaussier' })], { byDiagnosis: {}, readOn: '2026-12-07' });
  expect(r.map((c) => c.street)).toEqual(['Rue du Docteur Chaussier']);
  expect(JSON.stringify(r)).not.toMatch(/Mme|propriétaire|téléphone|@/);
});

it('[R294] la recherche à l’ADEME n’envoie que le code postal, la sorte, la surface et la classe', async () => {
  const urls: string[] = [];
  const search = new AdemeDiagnosisSearch(async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
  await search.matching({ postcode: '21240', kind: 'house', surfaceMin: 89, surfaceMax: 91, energyClass: 'F' });
  const q = decodeURIComponent(urls[0]!);
  expect(q).toContain('code_postal_ban:"21240"');
  expect(q).toContain('type_batiment:"maison"');
  expect(q).toContain('surface_habitable_logement:[89 TO 91]');
  expect(q).toContain('etiquette_dpe:"F"');
  expect(q).not.toMatch(/nom_proprietaire|telephone|mail/);
});

it('[R294] la recherche à l’ADEME suit ses pages suivantes, jamais ailleurs', async () => {
  const urls: string[] = [];
  const base = 'https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines';
  const search = new AdemeDiagnosisSearch(async (url: string) => {
    urls.push(url);
    const body = urls.length === 1 ? { results: [{ a: 1 }], next: `${base}?after=1` } : urls.length === 2 ? { results: [{ a: 2 }], next: 'https://ailleurs.example/x' } : { results: [{ a: 3 }] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  expect(await search.matching({ postcode: '21240', kind: 'house', surfaceMin: 89, surfaceMax: 91, energyClass: null })).toEqual([{ a: 1 }, { a: 2 }]);
  expect(urls).toHaveLength(2);
});

it('l’annonce dit sa classe et sa date ; une valeur illisible est tue, jamais devinée', () => {
  const now = new Date(MONDAY_10H);
  const base = { source: 'Site A', sourceRef: 'x1', kind: 'house', commune: 'Talant', postalCode: '21240', surfaceM2: 90, priceEur: 200_000, publishedAt: '2026-12-01T00:00:00.000Z' };
  expect(cleanAd({ ...base, energyClass: 'f', diagnosedOn: '2026-09-15' }, now)).toMatchObject({ energyClass: 'F', diagnosedOn: '2026-09-15' });
  expect(cleanAd({ ...base, energyClass: 'H', diagnosedOn: '2026-09-15' }, now)).toMatchObject({ energyClass: null, diagnosedOn: '2026-09-15' });
  expect(cleanAd({ ...base, energyClass: 'F', diagnosedOn: '2026-02-30' }, now)).toMatchObject({ energyClass: 'F', diagnosedOn: null });
  expect(cleanAd({ ...base, energyClass: 'F', diagnosedOn: '2027-01-01' }, now)).toMatchObject({ diagnosedOn: null });
});

async function setup(over: { search?: DiagnosisSearch | 'down'; cadastre?: CadastreService | 'down' } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const clock = MONDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const zone = async (agentId: string, commune: string) =>
    db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), network.id, agentId, commune]);
  await zone(alex.id, 'Talant');
  await zone(sam.id, 'Fontaine-lès-Dijon');
  const pige = new Pige(db, journal, { communePrices: async () => null }, { now });
  const queries: unknown[] = [];
  const search: DiagnosisSearch | undefined =
    over.search === 'down'
      ? { matching: async () => { throw new Error('HTTP 503'); } }
      : (over.search ?? {
          matching: async (q) => {
            queries.push(q);
            // La source rend aussi des champs de trop : ils ne doivent jamais passer.
            return [
              { numero_dpe: '2621E0000001T', date_etablissement_dpe: '2026-09-15', date_reception_dpe: '2026-09-16', etiquette_dpe: 'F', etiquette_ges: 'E', type_batiment: 'maison', surface_habitable_logement: 90.2, numero_voie_ban: '7', nom_rue_ban: 'Rue des Essais', code_postal_ban: '21240', nom_commune_ban: 'Talant', _geopoint: '47.33,5.01', nom_proprietaire: 'Jean Essai', telephone: '0600000000' },
            ];
          },
        });
  const cadastre: CadastreService | undefined =
    over.cadastre === 'down' ? { parcelAt: async () => { throw new Error('HTTP 500'); } } : (over.cadastre ?? { parcelAt: async () => ({ id: '21617000AB0042', section: 'AB', number: '0042', area: 600 }) });
  const adresses = new AdressePige(db, journal, pige, { ...(search ? { search } : {}), ...(cadastre ? { cadastre } : {}) }, { now });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  let n = 0;
  const ad = (o: Partial<RawAd> = {}): RawAd => {
    n += 1;
    return { source: 'Site A', sourceRef: `a-${n}`, kind: 'house', commune: 'Talant', postalCode: '21240', surfaceM2: 90, rooms: 4, priceEur: 279_000, publishedAt: new Date(clock - DAY).toISOString(), text: 'Belle maison.', energyClass: 'F', diagnosedOn: '2026-09-15', ...o };
  };
  const firstAd = async () => {
    const q = await pige.queue(as('agent', alex.id));
    if (!q.ok) throw new Error('file');
    return q.value[0]!.adId;
  };
  return { db, journal, store, pige, adresses, network, alex, sam, ad, firstAd, queries, agentAlex: as('agent', alex.id), agentSam: as('agent', sam.id), direction: as('direction', 'd1'), compliance: as('compliance', 'c1') };
}

describeWithSqlite('HX18 · Adresse probable d’une annonce de pige, et bien créé sans ressaisie', () => {
  it('[R295] [R273] une annonce revenue « pas d’agence » par sa seule référence est refusée aussi par la base', async () => {
    const s = await setup({ search: { matching: async () => [] } });
    const first = s.ad();
    await s.pige.ingest(s.network.id, [first]);
    const adId = await s.firstAd();
    await s.pige.ingest(s.network.id, [{ source: first.source, sourceRef: first.sourceRef, noAgency: true } as RawAd]);
    expect(await s.adresses.convert(s.agentAlex, { adId })).toMatchObject({ ok: false, rule: 'R273' });
    const ad = (await s.db.first<{ fingerprint: string }>('SELECT fingerprint FROM pige_ads WHERE id = ?', [adId]))!;
    const prop = await s.store.createProperty({ networkId: s.network.id, agentId: s.alex.id, reference: 'BY', kind: 'home', city: 'Talant', priceEur: 1, surfaceM2: 90, rooms: 4, status: 'draft' });
    await expect(
      s.db.run("INSERT INTO pige_properties (property_id, network_id, source, ad_id, fingerprint, ad_site, ad_kind, published_at, agent_id, created_at) VALUES (?, ?, 'pige', ?, ?, 'Site A', 'house', '2026-12-06', ?, '2026-12-07')", [prop.id, s.network.id, adId, ad.fingerprint, s.alex.id]),
    ).rejects.toThrow(/bien fermé/);
  });

  it('[R295] une annonce corrigée entre la file et la conversion : la fiche prend sa dernière relève entière', async () => {
    const s = await setup({ search: { matching: async () => [] } });
    const first = s.ad({ rooms: 4, priceEur: 200_000 });
    await s.pige.ingest(s.network.id, [first]);
    const adId = await s.firstAd();
    await s.pige.ingest(s.network.id, [{ ...first, rooms: 5, priceEur: 210_000 }]);
    const r = await s.adresses.convert(s.agentAlex, { adId });
    expect(r.ok && [r.value.rooms, r.value.priceEur]).toEqual([5, 210_000]);
  });

  it('[R295] une date de diagnostic dite sans classe est gardée et reprise', async () => {
    const s = await setup({ search: { matching: async () => [] } });
    await s.pige.ingest(s.network.id, [s.ad({ energyClass: undefined, diagnosedOn: '2026-09-15' })]);
    const r = await s.adresses.convert(s.agentAlex, { adId: await s.firstAd() });
    expect(r.ok && [r.value.energyClass, r.value.diagnosedOn]).toEqual([null, '2026-09-15']);
  });

  it('[R294] [R295] une classe ou une date de diagnostic corrigée par l’annonce remplace l’ancienne ; rejouée telle quelle, rien n’est ajouté', async () => {
    const s = await setup({ search: { matching: async () => [] } });
    const first = s.ad();
    await s.pige.ingest(s.network.id, [first]);
    await s.pige.ingest(s.network.id, [first]);
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM pige_ads'))!.n).toBe(1);
    await s.pige.ingest(s.network.id, [{ ...first, energyClass: 'D', diagnosedOn: '2026-10-01' }]);
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM pige_ads'))!.n).toBe(2);
    const adId = await s.firstAd();
    const r = await s.adresses.convert(s.agentAlex, { adId });
    expect(r.ok && [r.value.energyClass, r.value.diagnosedOn]).toEqual(['D', '2026-10-01']);
  });

  it('[R294] l’agent de la zone reçoit les adresses probables, avec confiance et sources ; rien du particulier n’est cherché', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const adId = await s.firstAd();
    const r = await s.adresses.propose(s.agentAlex, adId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ street: 'Rue des Essais', streetNumber: '7', confidence: 100, level: 'forte' });
    expect(r.missing).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/Jean|0600000000|proprietaire/);
    expect(s.queries).toEqual([{ postcode: '21240', kind: 'house', surfaceMin: 89, surfaceMax: 91, energyClass: 'F' }]);
    // Rangé : le numéro du diagnostic et la confiance, jamais l'adresse, qu'un bien fermé plus tard ne laisserait pas.
    const row = await s.db.first<{ candidates: string }>('SELECT candidates FROM pige_address_proposals WHERE id = ?', [r.proposalId]);
    expect(JSON.parse(row!.candidates)).toEqual([{ diagnosisNumber: '2621E0000001T', confidence: 100, level: 'forte' }]);
    expect(row!.candidates).not.toMatch(/Essais|"7"/);
    // Un autre agent, la conformité : refusés ; au journal, aucune adresse.
    expect(await s.adresses.propose(s.agentSam, adId)).toMatchObject({ ok: false, code: 'hors_zone' });
    expect(await s.adresses.propose(s.compliance, adId)).toMatchObject({ ok: false, rule: 'R16' });
    const events = JSON.stringify(await s.journal.bySubject(`pige_ad:${adId}`));
    expect(events).toContain('pige.adresses_proposees');
    expect(events).not.toMatch(/Essais|Talant/);
  });

  it('[R294] le cadastre est lu pour toutes les adresses possibles avant la limite des cinq montrées', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => ({ numero_dpe: `2621E000010${i}T`, date_etablissement_dpe: '2026-09-15', date_reception_dpe: '2026-09-16', etiquette_dpe: 'F', type_batiment: 'maison', surface_habitable_logement: 90, numero_voie_ban: String(i + 1), nom_rue_ban: 'Rue des Essais', code_postal_ban: '21240', nom_commune_ban: 'Talant', _geopoint: `47.3${i},5.01` }));
    // Seule la dernière adresse a une parcelle : elle doit sortir en tête.
    const s = await setup({ search: { matching: async () => lines }, cadastre: { parcelAt: async (lat) => (lat === 47.35 ? { id: '21617000AB0099', section: 'AB', number: '0099', area: 500 } : null) } });
    await s.pige.ingest(s.network.id, [s.ad()]);
    const r = await s.adresses.propose(s.agentAlex, await s.firstAd());
    expect(r.ok && r.candidates).toHaveLength(5);
    expect(r.ok && r.candidates[0]!.streetNumber).toBe('6');
  });

  it('[R294] une source en panne se dit avec sa raison, et la veille déjà rangée sert encore', async () => {
    const s = await setup({ search: 'down', cadastre: 'down' });
    await s.db.run(
      `INSERT INTO dpe_diagnoses (id, network_id, number, kind, energy_class, ghg_class, surface_m2, diagnosed_on, received_on, street_number, street, postcode, commune, commune_slug, lat, lon, first_seen_at)
       VALUES ('dd1', ?, '2621E0000009T', 'house', 'F', NULL, 90, '2026-09-15', '2026-09-16', '12', 'Allée des Tests', '21240', 'Talant', 'talant', 47.33, 5.01, '2026-09-17T00:00:00.000Z')`,
      [s.network.id],
    );
    await s.pige.ingest(s.network.id, [s.ad()]);
    const r = await s.adresses.propose(s.agentAlex, await s.firstAd());
    expect(r.ok && r.candidates.map((c) => [c.street, c.confidence])).toEqual([['Allée des Tests', 85]]);
    expect(r.ok && r.missing.map((m) => m.source)).toEqual(['Diagnostics de performance énergétique (ADEME)', 'Cadastre (IGN, API Carto)']);
    expect(r.ok && r.missing.every((m) => m.reason.length > 5)).toBe(true);
  });

  it('[R295] la fiche du bien reprend tous les champs de l’annonce, source « pige », et l’adresse retenue avec sa confiance', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const adId = await s.firstAd();
    const p = await s.adresses.propose(s.agentAlex, adId);
    if (!p.ok) throw new Error('proposition');
    const r = await s.adresses.convert(s.agentAlex, { adId, proposalId: p.proposalId, diagnosisNumber: '2621E0000001T' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      kind: 'home', adKind: 'house', postalCode: '21240', city: 'Talant', surfaceM2: 90, rooms: 4, priceEur: 279_000,
      energyClass: 'F', diagnosedOn: '2026-09-15', source: 'pige', adSite: 'Site A',
      address: { streetNumber: '7', street: 'Rue des Essais', confidence: 100, level: 'forte' },
    });
    const prop = await s.db.first<Record<string, unknown>>('SELECT agent_id, kind, postal_code, city, surface_m2, rooms, price_eur, status FROM properties WHERE id = ?', [r.value.propertyId]);
    expect(prop).toEqual({ agent_id: s.alex.id, kind: 'home', postal_code: '21240', city: 'Talant', surface_m2: 90, rooms: 4, price_eur: 279_000, status: 'draft' });
    expect(await s.adresses.sourceOf(s.agentAlex, r.value.propertyId)).toMatchObject({ ok: true, source: 'pige', adSite: 'Site A', confidence: 100 });
    // Un seul bien par bien de pige, même vu sur un autre site.
    await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B', surfaceM2: 91 })]);
    const siteB = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site B'"))!.id;
    expect(await s.adresses.convert(s.agentAlex, { adId: siteB })).toMatchObject({ ok: false, rule: 'R295', code: 'deja_cree' });
    expect(await s.adresses.convert(s.agentAlex, { adId })).toMatchObject({ ok: false, rule: 'R295', code: 'deja_cree' });
    // Une adresse qui n'a pas été proposée ne se retient pas.
    await s.pige.ingest(s.network.id, [s.ad({ surfaceM2: 140, rooms: 6 })]);
    const q = await s.pige.queue(s.agentAlex);
    const other = q.ok ? q.value.find((e) => e.surfaceM2 === 140)!.adId : '';
    expect(await s.adresses.convert(s.agentAlex, { adId: other, proposalId: p.proposalId, diagnosisNumber: '2621E0000001T' })).toMatchObject({ ok: false, rule: 'R294', code: 'adresse_inconnue' });
    // Sans adresse, la fiche se crée quand même, source « pige ».
    const bare = await s.adresses.convert(s.agentAlex, { adId: other });
    expect(bare.ok && bare.value).toMatchObject({ source: 'pige', surfaceM2: 140, rooms: 6, address: null });
    expect(await s.adresses.convert(s.agentSam, { adId: other })).toMatchObject({ ok: false });
    expect((await verifyChain(await s.journal.all())).ok).toBe(true);
  });

  it('[R295] [R273] une annonce « pas d’agence » n’est jamais convertie, ni par le code, ni par la base ; un non non plus', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad(), s.ad({ surfaceM2: 60, rooms: 3 })]);
    const q = await s.pige.queue(s.agentAlex);
    if (!q.ok) throw new Error('file');
    const big = q.value.find((e) => e.surfaceM2 === 90)!.adId;
    const small = q.value.find((e) => e.surfaceM2 === 60)!.adId;
    // Le même bien revu « pas d'agence » sur un autre site : il est fermé.
    await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B', surfaceM2: 91, text: 'Agences s’abstenir' })]);
    expect(await s.adresses.propose(s.agentAlex, big)).toMatchObject({ ok: false, rule: 'R273', code: 'pas_agence' });
    expect(await s.adresses.convert(s.agentAlex, { adId: big })).toMatchObject({ ok: false, rule: 'R273', code: 'pas_agence' });
    // Le particulier a dit non : fermé aussi.
    await s.pige.oppose(s.agentAlex, small);
    expect(await s.adresses.convert(s.agentAlex, { adId: small })).toMatchObject({ ok: false, rule: 'R04' });
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM pige_properties'))!.n).toBe(0);
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM properties'))!.n).toBe(0);
    // Même la base refuse : l'empreinte exacte, et une empreinte seulement reliée (92 m², fermée avec le 91 m² du site B).
    const fp = (await s.db.first<{ fingerprint: string }>('SELECT fingerprint FROM pige_ads WHERE id = ?', [big]))!.fingerprint;
    const prop = await s.store.createProperty({ networkId: s.network.id, agentId: s.alex.id, reference: 'BX', kind: 'home', city: 'Talant', priceEur: 1, surfaceM2: 90, rooms: 4, status: 'draft' });
    await expect(
      s.db.run("INSERT INTO pige_properties (property_id, network_id, source, ad_id, fingerprint, ad_site, ad_kind, published_at, agent_id, created_at) VALUES (?, ?, 'pige', ?, ?, 'Site A', 'house', '2026-12-06', ?, '2026-12-07')", [prop.id, s.network.id, big, fp, s.alex.id]),
    ).rejects.toThrow(/bien fermé/);
    // Une empreinte libre qui n'est pas celle de l'annonce fermée : refusée aussi.
    const free = await adFingerprint({ kind: 'house', postalCode: '21240', commune: 'Talant', surfaceM2: 300, rooms: 9 });
    await expect(
      s.db.run("INSERT INTO pige_properties (property_id, network_id, source, ad_id, fingerprint, ad_site, ad_kind, published_at, agent_id, created_at) VALUES (?, ?, 'pige', ?, ?, 'Site A', 'house', '2026-12-06', ?, '2026-12-07')", [prop.id, s.network.id, big, free, s.alex.id]),
    ).rejects.toThrow(/bien fermé/);
    // Une annonce ouverte, rangée en base : une clé reliée mais fermée ne s'y attache pas.
    await s.pige.ingest(s.network.id, [s.ad({ surfaceM2: 300, rooms: 9 })]);
    const open = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads WHERE fingerprint = ?', [free]))!.id;
    await s.db.run("INSERT INTO pige_properties (property_id, network_id, source, ad_id, fingerprint, ad_site, ad_kind, published_at, agent_id, created_at) VALUES (?, ?, 'pige', ?, ?, 'Site A', 'house', '2026-12-06', ?, '2026-12-07')", [prop.id, s.network.id, open, free, s.alex.id]);
    const near = await adFingerprint({ kind: 'house', postalCode: '21240', commune: 'Talant', surfaceM2: 92, rooms: 4 });
    await expect(s.db.run('INSERT INTO pige_property_keys (network_id, key, property_id) VALUES (?, ?, ?)', [s.network.id, near, prop.id])).rejects.toThrow(/bien fermé/);
  });

  it('[R296] ce que la pige rapporte : biens créés et mandats signés, par niveau de confiance ; l’agent voit les siens', async () => {
    const s = await setup({ search: { matching: async () => [] } });
    await s.pige.ingest(s.network.id, [s.ad(), s.ad({ surfaceM2: 140, rooms: 6 })]);
    const q = await s.pige.queue(s.agentAlex);
    if (!q.ok) throw new Error('file');
    const made: string[] = [];
    for (const e of q.value) {
      const r = await s.adresses.convert(s.agentAlex, { adId: e.adId });
      if (r.ok) made.push(r.value.propertyId);
    }
    expect(made).toHaveLength(2);
    const seller = await s.store.createPerson({ networkId: s.network.id, agentId: s.alex.id, firstName: 'Vera', lastName: 'Vendeuse' });
    const signed = new Date(MONDAY_10H + DAY).toISOString();
    await s.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, source_detail, recorded_by, created_at) VALUES ('m1', ?, ?, ?, ?, ?, 'other', 'pige', 'test', ?)", [
      s.network.id, s.alex.id, seller.id, made[0]!, signed, signed,
    ]);
    const y = await s.adresses.yieldOf(s.direction);
    expect(y.ok && y.value).toEqual({
      rows: [
        { level: 'forte', properties: 0, mandates: 0 },
        { level: 'moyenne', properties: 0, mandates: 0 },
        { level: 'faible', properties: 0, mandates: 0 },
        { level: 'sans_adresse', properties: 2, mandates: 1 },
      ],
      properties: 2,
      mandates: 1,
      rate: 0.5,
    });
    const sam = await s.adresses.yieldOf(s.agentSam);
    expect(sam.ok && sam.value.properties).toBe(0);
    expect(await s.adresses.yieldOf(s.compliance)).toMatchObject({ ok: false, rule: 'R16' });
    // La source reste « pige » après le mandat ; un autre agent ne la lit pas.
    expect(await s.adresses.sourceOf(s.agentAlex, made[0])).toMatchObject({ ok: true, source: 'pige' });
    expect(await s.adresses.sourceOf(s.agentSam, made[0])).toMatchObject({ ok: false, rule: 'R16' });
  });
});
