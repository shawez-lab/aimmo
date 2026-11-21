import { expect, it } from 'vitest';
import type { CommunePrices } from '../src/attirer/prix-versions.ts';
import { adFingerprint, cleanAd, firstMessage, Pige, saysNoAgency, type RawAd } from '../src/pige/pige.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, annonces et prix inventés.
const MONDAY_10H = Date.parse('2026-12-07T09:00:00.000Z');
const DAY = 86_400_000;

const talantPrices: CommunePrices = {
  versionId: 'v1',
  computedAt: '2026-11-01T00:00:00.000Z',
  cells: [
    { zone: { slug: 'talant', name: 'Talant', level: 'commune' }, kind: 'house', status: 'publiee', sales: 24, median: 2800, q1: 2500, q3: 3100, source: 'DVF, base publique', dvfLastSale: '2026-06-30', period: { from: '2024-07-01', to: '2026-06-30' } },
  ],
  held: [],
};

async function setup(maxLinkedAds?: number) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_10H;
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
  const market = { communePrices: async (_n: string, slug: string) => (slug === 'talant' ? talantPrices : null) };
  const pige = new Pige(db, journal, market, { now, ...(maxLinkedAds ? { maxLinkedAds } : {}) });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  let n = 0;
  const ad = (over: Partial<RawAd> = {}): RawAd => {
    n += 1;
    return {
      source: 'Site A',
      sourceRef: `a-${n}`,
      kind: 'house',
      commune: 'Talant',
      postalCode: '21240',
      surfaceM2: 90,
      rooms: 4,
      priceEur: 279_000,
      publishedAt: new Date(clock - DAY).toISOString(),
      text: 'Belle maison avec jardin.',
      ...over,
    };
  };
  return {
    db, journal, pige, network, alex, sam, ad,
    agentAlex: as('agent', alex.id), agentSam: as('agent', sam.id), direction: as('direction', 'd1'), compliance: as('compliance', 'c1'),
    at: (t: number) => { clock = t; },
  };
}

it('[R273] les mots « pas d’agence » sont reconnus, « pas de frais d’agence » ne l’est pas', () => {
  for (const t of ['Pas d’agence merci', 'AGENCES S’ABSTENIR', 'Vente sans agence', 'Agences immobilières non merci', 'pas de démarchage', 'Entre particuliers uniquement', 'No agency']) {
    expect(saysNoAgency(t), t).toBe(true);
  }
  for (const t of ['Pas de frais d’agence à payer', 'Proche de l’agence postale', 'Maison familiale']) expect(saysNoAgency(t), t).toBe(false);
});

it('[R273] une annonce sans surface, sans prix ou à venir n’est pas lue ; rien d’autre que le bien n’est gardé', async () => {
  const now = new Date(MONDAY_10H);
  const base = { source: 'Site A', sourceRef: 'x1', kind: 'house', commune: 'Talant', postalCode: '21240', surfaceM2: 90, priceEur: 200_000, publishedAt: '2026-12-01T00:00:00.000Z' };
  expect(cleanAd({ ...base, surfaceM2: undefined }, now)).toBeNull();
  expect(cleanAd({ ...base, priceEur: 'cher' }, now)).toBeNull();
  expect(cleanAd({ ...base, publishedAt: '2027-01-01T00:00:00.000Z' }, now)).toBeNull();
  const clean = cleanAd({ ...base, phone: '0600000000', name: 'Jean Particulier', text: 'Appelez le 06 00 00 00 00' } as RawAd, now);
  expect(clean).not.toBeNull();
  expect(JSON.stringify(clean)).not.toMatch(/06|Jean|Appelez/);
});

it('[R672] l’empreinte d’un bien ne dépend ni du site ni du prix, mais de ses pièces quand elles sont dites', async () => {
  const a = await adFingerprint({ kind: 'house', postalCode: '21240', commune: 'Talant', surfaceM2: 90 });
  expect(await adFingerprint({ kind: 'house', postalCode: '21240', commune: 'TALANT', surfaceM2: 90 })).toBe(a);
  expect(await adFingerprint({ kind: 'house', postalCode: '21240', commune: 'Talant', surfaceM2: 91 })).not.toBe(a);
  // Sans pièces, l'empreinte d'avant : ce qui était fermé le reste.
  expect(await adFingerprint({ kind: 'house', postalCode: '21240', commune: 'Talant', surfaceM2: 90, rooms: null })).toBe(a);
  const p3 = await adFingerprint({ kind: 'house', postalCode: '21240', commune: 'Talant', surfaceM2: 90, rooms: 3 });
  expect(p3).not.toBe(a);
  expect(await adFingerprint({ kind: 'house', postalCode: '21240', commune: 'Talant', surfaceM2: 90, rooms: 4 })).not.toBe(p3);
});

it('le premier message ne porte que les chiffres donnés, ni question ni parenthèse', () => {
  const t = firstMessage({ kind: 'house', commune: 'Talant', surfaceM2: 90, agentFirstName: 'Alex', market: { adPerM2: 3100, medianPerM2: 2800, gapPct: 11, sales: 24, source: 'DVF', dvfLastSale: '2026-06-30' } });
  expect(t).toContain('90 m²');
  expect(t).toMatch(/2\s800 €/);
  expect(t).not.toMatch(/[?()]/);
  expect(t).not.toContain('11');
});

describeWithSqlite('HX11 · Pige des annonces de particuliers', () => {
  it('[R273] une annonce marquée « pas d’agence » n’entre jamais dans la file, ni le même bien vu sur un autre site', async () => {
    const s = await setup();
    const r = await s.pige.ingest(s.network.id, [
      s.ad({ text: 'Maison à vendre. Agences s’abstenir.' }),
      s.ad({ commune: 'Talant', surfaceM2: 70, rooms: 3, noAgency: true }),
      // Le même bien que le premier, sur un autre site, sans la mention : il reste dehors.
      s.ad({ source: 'Site B', text: 'Maison à vendre.' }),
      s.ad({ surfaceM2: 120, rooms: 5 }),
    ]);
    expect(r).toEqual({ added: 1, noAgency: 3, outside: 0, unreadable: 0 });
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.surfaceM2)).toEqual([120]);
    // Même la base refuse de la ranger.
    const fp = await adFingerprint({ kind: 'house', postalCode: '21240', commune: 'Talant', surfaceM2: 90, rooms: 4 });
    await expect(
      s.db.run("INSERT INTO pige_ads (id, network_id, source, source_ref, fingerprint, kind, commune, postal_code, surface_m2, rooms, price_eur, published_at, collected_at) VALUES ('z', ?, 'Site C', 'c1', ?, 'house', 'Talant', '21240', 90, 4, 200000, '2026-12-01', '2026-12-01')", [s.network.id, fp]),
    ).rejects.toThrow(/pas d'agence/);
  });

  it('[R273] un site qui tait les pièces ou arrondit la surface d’un mètre ne rouvre pas un bien « pas d’agence »', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad(), s.ad({ surfaceM2: 60, rooms: 3 })]);
    await s.pige.ingest(s.network.id, [
      s.ad({ source: 'Site B', rooms: undefined, noAgency: true }),
      s.ad({ source: 'Site C', surfaceM2: 61, rooms: undefined, text: 'Agences s’abstenir' }),
    ]);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
    const first = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE surface_m2 = 90"))!.id;
    expect(await s.pige.prepare(s.agentAlex, first)).toMatchObject({ ok: false, rule: 'R273' });
  });

  it('[R273] une annonce « pas d’agence » sans prix ni date ferme quand même le bien', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const r = await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B', priceEur: undefined, publishedAt: undefined, noAgency: true })]);
    expect(r.noAgency).toBe(1);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
    const first = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    expect(await s.pige.prepare(s.agentAlex, first)).toMatchObject({ ok: false, rule: 'R273' });
  });

  it('[R274] le prix du moment est celui de l’annonce publiée le plus récemment ; une relève rejouée n’ajoute rien', async () => {
    const s = await setup();
    const a = s.ad();
    const b = s.ad({ source: 'Site B', priceEur: 252_000, publishedAt: new Date(MONDAY_10H - 1000).toISOString() });
    expect((await s.pige.ingest(s.network.id, [a, b])).added).toBe(2);
    s.at(MONDAY_10H + DAY);
    expect((await s.pige.ingest(s.network.id, [a, b])).added).toBe(0);
    expect((await s.pige.ingest(s.network.id, [a, b])).added).toBe(0);
    let q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.priceEur)).toEqual([252_000]);
    // Le site A republie à son prix : la publication la plus récente l'emporte.
    expect((await s.pige.ingest(s.network.id, [{ ...a, publishedAt: new Date(MONDAY_10H + DAY - 1000).toISOString() }])).added).toBe(1);
    q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.priceEur)).toEqual([279_000]);
  });

  it('[R274] une annonce dont la surface est corrigée ne laisse pas l’ancien bien en file, ni un prix à zéro', async () => {
    const s = await setup();
    const a = s.ad();
    await s.pige.ingest(s.network.id, [a]);
    s.at(MONDAY_10H + DAY);
    await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: 95, priceEur: 252_000 }]);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => [e.surfaceM2, e.priceEur])).toEqual([[95, 252_000]]);
    const old = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads WHERE surface_m2 = 90'))!.id;
    expect(await s.pige.prepare(s.agentAlex, old)).toMatchObject({ ok: false, code: 'annonce_remplacee' });
  });

  it('[R04] [R275] un non sur l’annonce corrigée ferme aussi le message préparé avant la correction', async () => {
    const s = await setup();
    const a = s.ad();
    await s.pige.ingest(s.network.id, [a, s.ad({ source: 'Site B' })]);
    const old = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site A'"))!.id;
    const p = await s.pige.prepare(s.agentAlex, old);
    if (!p.ok) throw new Error('prepare');
    s.at(MONDAY_10H + DAY);
    await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: 95 }]);
    const fresh = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads WHERE surface_m2 = 95'))!.id;
    expect(await s.pige.prepare(s.agentAlex, fresh)).toMatchObject({ ok: false, rule: 'R05' });
    expect(await s.pige.oppose(s.agentAlex, fresh)).toEqual({ ok: true });
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R04' });
    // Le même bien resté à 90 m² sur le site B sort aussi de la file.
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
  });

  it('[R273] une annonce corrigée et marquée « pas d’agence » d’un coup ferme le bien de sa surface d’avant', async () => {
    const s = await setup();
    const a = s.ad();
    await s.pige.ingest(s.network.id, [a]);
    const old = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    const p = await s.pige.prepare(s.agentAlex, old);
    if (!p.ok) throw new Error('prepare');
    s.at(MONDAY_10H + DAY);
    await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: 95, noAgency: true }]);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R273' });
    // Revue plus tard à 90 m² sans la mention, la même annonce reste dehors.
    expect((await s.pige.ingest(s.network.id, [{ ...a, priceEur: 260_000 }])).added).toBe(0);
  });

  it('[R04] un non suit le bien de proche en proche, d’un site et d’une correction à l’autre', async () => {
    const s = await setup();
    const a = s.ad();
    await s.pige.ingest(s.network.id, [a]);
    const first = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    const p = await s.pige.prepare(s.agentAlex, first);
    if (!p.ok) throw new Error('prepare');
    s.at(MONDAY_10H + DAY);
    await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: 95 }]);
    const b = s.ad({ source: 'Site B', surfaceM2: 95 });
    await s.pige.ingest(s.network.id, [b]);
    s.at(MONDAY_10H + 2 * DAY);
    await s.pige.ingest(s.network.id, [{ ...b, surfaceM2: 100 }]);
    const last = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads WHERE surface_m2 = 100'))!.id;
    expect(await s.pige.oppose(s.agentAlex, last)).toEqual({ ok: true });
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R04' });
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
  });

  it('[R273] une annonce écartée parce que le bien est « pas d’agence » ne rentre pas après une correction de surface', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad({ noAgency: true })]);
    const b = s.ad({ source: 'Site B' });
    expect((await s.pige.ingest(s.network.id, [b])).added).toBe(0);
    s.at(MONDAY_10H + DAY);
    expect((await s.pige.ingest(s.network.id, [{ ...b, surfaceM2: 95 }])).added).toBe(0);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
  });

  it('[R05] [R275] deux messages préparés pour deux annonces reliées ensuite : un seul est remis', async () => {
    const s = await setup();
    const b = s.ad({ source: 'Site B', surfaceM2: 100 });
    await s.pige.ingest(s.network.id, [s.ad(), b]);
    const a = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site A'"))!.id;
    const bId = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site B'"))!.id;
    const pa = await s.pige.prepare(s.agentAlex, a);
    const pb = await s.pige.prepare(s.agentAlex, bId);
    if (!pa.ok || !pb.ok) throw new Error('prepare');
    expect((await s.pige.validate(s.agentAlex, pa.draftId, 'annonce')).ok).toBe(true);
    s.at(MONDAY_10H + DAY);
    await s.pige.ingest(s.network.id, [{ ...b, surfaceM2: 90 }]);
    expect(await s.pige.validate(s.agentAlex, pb.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R05', code: 'bien_deja_contacte' });
  });

  it('[R273] la même annonce revue « pas d’agence » sans surface ferme quand même le bien', async () => {
    const s = await setup();
    const a = s.ad();
    await s.pige.ingest(s.network.id, [a]);
    const id = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    const p = await s.pige.prepare(s.agentAlex, id);
    if (!p.ok) throw new Error('prepare');
    expect((await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: undefined, kind: undefined, noAgency: true }])).noAgency).toBe(1);
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R273' });
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
  });

  it('[R05] deux remises en même temps de deux messages d’un même bien relié : une seule passe', async () => {
    const s = await setup();
    const b = s.ad({ source: 'Site B', surfaceM2: 100 });
    await s.pige.ingest(s.network.id, [s.ad(), b]);
    const a = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site A'"))!.id;
    const bId = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site B'"))!.id;
    const pa = await s.pige.prepare(s.agentAlex, a);
    const pb = await s.pige.prepare(s.agentAlex, bId);
    if (!pa.ok || !pb.ok) throw new Error('prepare');
    await s.pige.ingest(s.network.id, [{ ...b, surfaceM2: 90 }]);
    const both = await Promise.all([s.pige.validate(s.agentAlex, pa.draftId, 'annonce'), s.pige.validate(s.agentAlex, pb.draftId, 'annonce')]);
    expect(both.filter((v) => v.ok)).toHaveLength(1);
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM pige_handovers'))!.n).toBe(1);
  });

  it('[R273] une annonce vue d’abord « pas d’agence » sans surface ni sorte ne rentre jamais ensuite', async () => {
    const s = await setup();
    const a = s.ad();
    expect((await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: undefined, kind: undefined, noAgency: true }])).noAgency).toBe(1);
    expect((await s.pige.ingest(s.network.id, [a])).added).toBe(0);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
  });

  it('[R273] une fermeture rangée juste avant la remise l’empêche, dans l’écriture même', async () => {
    const s = await setup();
    const a = s.ad();
    await s.pige.ingest(s.network.id, [a]);
    const id = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    const p = await s.pige.prepare(s.agentAlex, id);
    if (!p.ok) throw new Error('prepare');
    // La fermeture arrive entre les lectures et l'écriture de la remise.
    const run = s.db.run.bind(s.db);
    let once = false;
    s.db.run = async (sql, params) => {
      if (!once && sql.includes('INSERT INTO pige_handovers')) {
        once = true;
        await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: undefined, noAgency: true }]);
      }
      return run(sql, params);
    };
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R273' });
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM pige_handovers'))!.n).toBe(0);
  });

  it('[R273] une annonce fermée par sa seule clé, lue ensuite en entier, ferme son bien sur les autres sites', async () => {
    const s = await setup();
    const a = s.ad();
    await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: undefined, kind: undefined, noAgency: true }]);
    await s.pige.ingest(s.network.id, [a]);
    expect((await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B' })])).added).toBe(0);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
  });

  it('[R04] une correction qui relie le bien à un non juste avant la remise : aucun texte rendu', async () => {
    const s = await setup();
    const b = s.ad({ source: 'Site B', surfaceM2: 100 });
    await s.pige.ingest(s.network.id, [s.ad(), b]);
    const a = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site A'"))!.id;
    const bId = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site B'"))!.id;
    const p = await s.pige.prepare(s.agentAlex, a);
    if (!p.ok) throw new Error('prepare');
    expect(await s.pige.oppose(s.agentAlex, bId)).toEqual({ ok: true });
    const run = s.db.run.bind(s.db);
    let once = false;
    s.db.run = async (sql, params) => {
      if (!once && sql.includes('INSERT INTO pige_handovers')) {
        once = true;
        await s.pige.ingest(s.network.id, [{ ...b, surfaceM2: 90 }]);
      }
      return run(sql, params);
    };
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R04' });
  });

  it('[R273] une annonce fermée par sa clé, revue avec sa surface mais sans prix, ferme son bien sur les autres sites', async () => {
    const s = await setup();
    const a = s.ad();
    await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: undefined, noAgency: true }]);
    await s.pige.ingest(s.network.id, [{ ...a, priceEur: undefined }]);
    expect((await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B' })])).added).toBe(0);
  });

  it('un bien vu sur 40 sites se prépare et se remet sans dépasser les paramètres de la base', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, Array.from({ length: 40 }, (_, i) => s.ad({ source: `Site ${i + 1}` })));
    const id = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site 1'"))!.id;
    const all = s.db.all.bind(s.db);
    const first = s.db.first.bind(s.db);
    const run = s.db.run.bind(s.db);
    const guard = (params?: readonly unknown[]) => expect((params ?? []).length).toBeLessThanOrEqual(100);
    s.db.all = async (sql, params) => (guard(params), all(sql, params));
    s.db.first = async (sql, params) => (guard(params), first(sql, params));
    s.db.run = async (sql, params) => (guard(params), run(sql, params));
    const p = await s.pige.prepare(s.agentAlex, id);
    if (!p.ok) throw new Error('prepare');
    expect((await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).ok).toBe(true);
  });

  it('[R273] [R04] une annonce incomplète d’un bien fermé ferme sa clé : corrigée ensuite, elle n’entre pas', async () => {
    for (const how of ['pas_agence', 'non'] as const) {
      const s = await setup();
      await s.pige.ingest(s.network.id, [how === 'pas_agence' ? s.ad({ noAgency: true }) : s.ad()]);
      if (how === 'non') expect(await s.pige.oppose(s.agentAlex, (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id)).toEqual({ ok: true });
      const b = s.ad({ source: 'Site B' });
      await s.pige.ingest(s.network.id, [{ ...b, priceEur: undefined }]);
      expect((await s.pige.ingest(s.network.id, [{ ...b, surfaceM2: 95 }])).added, how).toBe(0);
      const q = await s.pige.queue(s.agentAlex);
      expect(q.ok && q.value, how).toEqual([]);
    }
  });

  it('[R273] un refus rangé sous la seule clé d’une annonce suit le bien jusqu’à l’annonce incomplète d’un autre site', async () => {
    for (const surface of [90, 91, 89]) {
      const s = await setup();
      const a = s.ad();
      await s.pige.ingest(s.network.id, [a]);
      await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: undefined, noAgency: true }]);
      const b = s.ad({ source: 'Site B', surfaceM2: surface });
      await s.pige.ingest(s.network.id, [{ ...b, priceEur: undefined }]);
      expect((await s.pige.ingest(s.network.id, [{ ...b, surfaceM2: 95 }])).added, String(surface)).toBe(0);
      const q = await s.pige.queue(s.agentAlex);
      expect(q.ok && q.value).toEqual([]);
    }
  });

  it('[R273] une correction incomplète d’une annonce déjà vue suit l’histoire de cette annonce jusqu’au refus', async () => {
    const s = await setup();
    const a = s.ad();
    const b = s.ad({ source: 'Site B' });
    await s.pige.ingest(s.network.id, [a, b]);
    await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: undefined, noAgency: true }]);
    await s.pige.ingest(s.network.id, [{ ...b, surfaceM2: 95, priceEur: undefined }]);
    expect((await s.pige.ingest(s.network.id, [s.ad({ source: 'Site C', surfaceM2: 95 })])).added).toBe(0);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
  });

  it('[R273] un bien relié à plus d’annonces que la limite se ferme, jamais supposé ouvert', async () => {
    const s = await setup(3);
    const a = s.ad();
    await s.pige.ingest(s.network.id, [a]);
    const id = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    const p = await s.pige.prepare(s.agentAlex, id);
    if (!p.ok) throw new Error('prepare');
    await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B' }), s.ad({ source: 'Site C' }), s.ad({ source: 'Site D' })]);
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R273', code: 'bien_trop_relie' });
    // Une annonce vue incomplète alors que le bien est trop relié pour être suivi garde sa clé fermée : corrigée
    // ensuite, elle n'entre pas.
    await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: 95 }]);
    const e = s.ad({ source: 'Site E' });
    await s.pige.ingest(s.network.id, [{ ...e, priceEur: undefined }]);
    expect((await s.pige.ingest(s.network.id, [{ ...e, surfaceM2: 110 }])).added).toBe(0);
  });

  it('une surface corrigée seule, même prix et même date, est relevée', async () => {
    const s = await setup();
    const a = s.ad();
    await s.pige.ingest(s.network.id, [a]);
    expect((await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: 95 }])).added).toBe(1);
    expect((await s.pige.ingest(s.network.id, [{ ...a, surfaceM2: 95 }])).added).toBe(0);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.surfaceM2)).toEqual([95]);
  });

  it('une annonce republiée au même prix est relevée, et reste dans la file au-delà de 60 jours', async () => {
    const s = await setup();
    const a = s.ad({ publishedAt: new Date(MONDAY_10H - 59 * DAY).toISOString() });
    await s.pige.ingest(s.network.id, [a]);
    s.at(MONDAY_10H + 5 * DAY);
    const again = { ...a, publishedAt: new Date(MONDAY_10H + 4 * DAY).toISOString() };
    expect((await s.pige.ingest(s.network.id, [again])).added).toBe(1);
    expect((await s.pige.ingest(s.network.id, [again])).added).toBe(0);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.length).toBe(1);
  });

  it('[R274] une annonce revenue à son ancien prix est relevée à ce prix', async () => {
    const s = await setup();
    const one = s.ad();
    await s.pige.ingest(s.network.id, [one]);
    s.at(MONDAY_10H + DAY);
    await s.pige.ingest(s.network.id, [{ ...one, priceEur: 252_000 }]);
    s.at(MONDAY_10H + 2 * DAY);
    expect((await s.pige.ingest(s.network.id, [one])).added).toBe(1);
    expect((await s.pige.ingest(s.network.id, [one])).added).toBe(0);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.priceEur)).toEqual([279_000]);
  });

  it('[R274] la même annonce revue à un autre prix garde la baisse ; rejouée telle quelle, rien ne double', async () => {
    const s = await setup();
    const one = s.ad();
    await s.pige.ingest(s.network.id, [one]);
    expect((await s.pige.ingest(s.network.id, [one])).added).toBe(0);
    s.at(MONDAY_10H + DAY);
    expect((await s.pige.ingest(s.network.id, [{ ...one, priceEur: 252_000 }])).added).toBe(1);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.priceEur)).toEqual([252_000]);
  });

  it('un bien republié après 60 jours reste dans la file par sa nouvelle annonce', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad({ publishedAt: new Date(MONDAY_10H - 59 * DAY).toISOString() })]);
    s.at(MONDAY_10H + 5 * DAY);
    await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B', publishedAt: new Date(MONDAY_10H + 4 * DAY).toISOString() })]);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.source)).toEqual(['Site B']);
  });

  it('[R05] un bien vu à un mètre carré près sur un autre site n’a pas de second message', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const first = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    expect((await s.pige.prepare(s.agentAlex, first)).ok).toBe(true);
    await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B', surfaceM2: 91, rooms: undefined })]);
    const other = (await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site B'"))!.id;
    expect(await s.pige.prepare(s.agentAlex, other)).toMatchObject({ ok: false, rule: 'R05' });
  });

  it('[R273] un bien déjà en file sort de la file quand une autre annonce de lui dit « pas d’agence », et ne reçoit plus de message', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const q1 = await s.pige.queue(s.agentAlex);
    const adId = q1.ok ? q1.value[0]!.adId : '';
    await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B', text: 'Particulier uniquement, pas d’agence' })]);
    const q2 = await s.pige.queue(s.agentAlex);
    expect(q2.ok && q2.value).toEqual([]);
    expect(await s.pige.prepare(s.agentAlex, adId)).toMatchObject({ ok: false, rule: 'R273', code: 'pas_agence' });
  });

  it('[R273] seules les communes des zones entrent ; chaque agent voit les siennes, la direction tout le réseau', async () => {
    const s = await setup();
    const r = await s.pige.ingest(s.network.id, [s.ad(), s.ad({ commune: 'Fontaine-lès-Dijon', postalCode: '21121', surfaceM2: 60, rooms: 3, kind: 'apartment' }), s.ad({ commune: 'Beaune', postalCode: '21200' })]);
    expect(r.outside).toBe(1);
    const alex = await s.pige.queue(s.agentAlex);
    const sam = await s.pige.queue(s.agentSam);
    const dir = await s.pige.queue(s.direction);
    expect(alex.ok && alex.value.map((e) => e.commune)).toEqual(['Talant']);
    expect(sam.ok && sam.value.map((e) => e.commune)).toEqual(['Fontaine-lès-Dijon']);
    expect(dir.ok && dir.value.length).toBe(2);
    expect(await s.pige.queue(s.compliance)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R273] aucun nom, numéro, mail ni texte d’annonce n’est rangé', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad({ text: 'Contact : Jean Particulier, 06 11 22 33 44, jean@exemple.test', phone: '0611223344', email: 'jean@exemple.test', name: 'Jean Particulier' } as Partial<RawAd>)]);
    const rows = await s.db.all<Record<string, unknown>>('SELECT * FROM pige_ads');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/Jean|0611|06 11|exemple|Contact/);
    const events = await s.db.all<{ data: string }>('SELECT data FROM journal');
    expect(JSON.stringify(events)).not.toMatch(/Jean|0611|exemple/);
  });

  it('[R274] l’écart avec le marché vient de la case publiée, avec sa source et sa date ; sans case, « marché non chiffré »', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad(), s.ad({ commune: 'Fontaine-lès-Dijon', postalCode: '21121' })]);
    const dir = await s.pige.queue(s.direction);
    if (!dir.ok) throw new Error('file');
    const talant = dir.value.find((e) => e.commune === 'Talant')!;
    expect(talant.market).toEqual({ adPerM2: 3100, medianPerM2: 2800, gapPct: 11, sales: 24, source: 'DVF, base publique', dvfLastSale: '2026-06-30' });
    const fontaine = dir.value.find((e) => e.commune === 'Fontaine-lès-Dijon')!;
    expect(fontaine.market).toEqual({ unpriced: true, reason: 'marche_non_chiffre' });
  });

  it('[R274] une baisse de prix change l’écart, pas le bien : un seul en file, au dernier prix', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    s.at(MONDAY_10H + DAY);
    await s.pige.ingest(s.network.id, [s.ad({ priceEur: 252_000, publishedAt: new Date(MONDAY_10H + DAY - 1000).toISOString() })]);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.length).toBe(1);
    expect(q.ok && q.value[0]!.priceEur).toBe(252_000);
    expect(q.ok && 'gapPct' in q.value[0]!.market && q.value[0]!.market.gapPct).toBe(0);
  });

  it('[R275] [R10] le premier message est préparé par le code, une fois par bien, avec les seuls chiffres de l’annonce et du marché', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const q = await s.pige.queue(s.agentAlex);
    const adId = q.ok ? q.value[0]!.adId : '';
    const p = await s.pige.prepare(s.agentAlex, adId);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.body).toContain('Talant');
    expect(p.body).toMatch(/2\s800 €/);
    expect(p.body).toContain('Alex, agent immobilier');
    expect(await s.pige.prepare(s.agentAlex, adId)).toMatchObject({ ok: false, rule: 'R05', code: 'deja_prepare' });
    // Le même bien vu sur un autre site n'a pas de second message [R05].
    await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B' })]);
    const other = await s.db.first<{ id: string }>("SELECT id FROM pige_ads WHERE source = 'Site B'");
    expect(await s.pige.prepare(s.agentAlex, other!.id)).toMatchObject({ ok: false, rule: 'R05' });
  });

  it('[R275] seul l’agent de la zone prépare et valide ; la direction ne signe aucun message', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const adId = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    expect(await s.pige.prepare(s.agentSam, adId)).toMatchObject({ ok: false, code: 'hors_zone' });
    expect(await s.pige.prepare(s.direction, adId)).toMatchObject({ ok: false, rule: 'R16' });
    const p = await s.pige.prepare(s.agentAlex, adId);
    if (!p.ok) throw new Error('prepare');
    expect(await s.pige.validate(s.agentSam, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R16' });
    // La direction lit le message préparé.
    const dir = await s.pige.queue(s.direction);
    expect(dir.ok && dir.value[0]!.draft?.body).toBe(p.body);
  });

  it('[R275] [R05] [R01] validé par la messagerie de l’annonce : remis à l’agent, une seule fois, dans les heures ; rien ne part d’AIMMO', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const adId = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    const p = await s.pige.prepare(s.agentAlex, adId);
    if (!p.ok) throw new Error('prepare');
    // Dimanche : hors des heures d'envoi.
    s.at(MONDAY_10H - DAY);
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R01' });
    // Lundi, 21 h à Paris : hors des heures.
    s.at(MONDAY_10H + 11 * 3_600_000);
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R01' });
    // Samedi, 10 h : permis [R01].
    s.at(MONDAY_10H + 5 * DAY);
    const v = await s.pige.validate(s.agentAlex, p.draftId, 'annonce');
    expect(v).toEqual({ ok: true, body: p.body, channel: 'annonce' });
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R05', code: 'deja_remis' });
    // Aucun message rangé ni envoyé par AIMMO.
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM messages'))!.n).toBe(0);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value[0]!.draft?.handed).toBe(true);
  });

  it('[R275] [R03] par téléphone, SMS, WhatsApp ou mail, le contrôle central refuse faute d’accord préalable', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const adId = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    const p = await s.pige.prepare(s.agentAlex, adId);
    if (!p.ok) throw new Error('prepare');
    for (const channel of ['phone', 'sms', 'whatsapp', 'email']) {
      expect(await s.pige.validate(s.agentAlex, p.draftId, channel), channel).toMatchObject({ ok: false, rule: 'R03' });
    }
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'pigeon')).toMatchObject({ ok: false, code: 'bad_channel' });
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM pige_handovers'))!.n).toBe(0);
  });

  it('[R04] [R02] un non du particulier ferme le bien pour toujours, sur tous ses sites', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    const adId = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    const p = await s.pige.prepare(s.agentAlex, adId);
    if (!p.ok) throw new Error('prepare');
    expect(await s.pige.oppose(s.agentSam, adId)).toMatchObject({ ok: false, code: 'hors_zone' });
    expect(await s.pige.oppose(s.agentAlex, adId)).toEqual({ ok: true });
    expect(await s.pige.validate(s.agentAlex, p.draftId, 'annonce')).toMatchObject({ ok: false, rule: 'R04' });
    await s.pige.ingest(s.network.id, [s.ad({ source: 'Site B' }), s.ad({ source: 'Site C', surfaceM2: 89, rooms: undefined })]);
    const q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
    // La base refuse aussi la remise.
    await expect(s.db.run("INSERT INTO pige_handovers (draft_id, agent_id, channel, handed_at) VALUES (?, ?, 'annonce', '2026-12-07')", [p.draftId, s.alex.id])).rejects.toThrow(/bien fermé/);
  });

  it('rien ne change ni ne s’efface, et chaque mouvement va au journal', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad()]);
    await expect(s.db.run('UPDATE pige_ads SET price_eur = 1')).rejects.toThrow(/rien ne change/);
    await expect(s.db.run('DELETE FROM pige_ads')).rejects.toThrow(/rien ne s'efface/);
    const adId = (await s.db.first<{ id: string }>('SELECT id FROM pige_ads'))!.id;
    const p = await s.pige.prepare(s.agentAlex, adId);
    if (!p.ok) throw new Error('prepare');
    await s.pige.validate(s.agentAlex, p.draftId, 'annonce');
    const types = (await s.db.all<{ type: string }>('SELECT type FROM journal ORDER BY seq')).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['pige.collectee', 'pige.preparee', 'pige.remise']));
    expect((await verifyChain(await s.journal.all())).ok).toBe(true);
  });

  it('un agent parti ne lit plus la file', async () => {
    const s = await setup();
    await s.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('dep-1', ?, ?, '2026-11-01', '2026-12-01', 'demission_agent', 1, 'direction:d1', '2026-11-01T10:00:00.000Z')",
      [s.network.id, s.alex.id],
    );
    expect(await s.pige.queue(s.agentAlex)).toMatchObject({ ok: false, rule: 'R16' });
  });

  // AU035 : deux appartements de 65 m² dans la même commune ne sont pas pris pour le même bien sans preuve.
  const flat = { kind: 'apartment', surfaceM2: 65 } as const;

  it('[R672] deux appartements de 65 m² à Talant, l’un de 3 pièces, l’autre de 4, restent deux biens : ni « pas d’agence », ni non, ni message ne passent de l’un à l’autre', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad({ ...flat, rooms: 3, priceEur: 180_000 }), s.ad({ ...flat, source: 'Site B', rooms: 4, priceEur: 182_000 })]);
    let q = await s.pige.queue(s.agentAlex);
    if (!q.ok) throw new Error('file');
    expect(q.value.map((e) => [e.rooms, e.sites]).sort()).toEqual([[3, 1], [4, 1]]);
    const three = q.value.find((e) => e.rooms === 3)!.adId;
    const four = q.value.find((e) => e.rooms === 4)!.adId;
    // Un message pour l'un n'empêche pas celui de l'autre [R05 vise le même bien].
    expect(await s.pige.prepare(s.agentAlex, three)).toMatchObject({ ok: true });
    expect(await s.pige.prepare(s.agentAlex, four)).toMatchObject({ ok: true });
    // Le 3 pièces revu « pas d'agence » sur un troisième site : lui seul est fermé.
    await s.pige.ingest(s.network.id, [s.ad({ ...flat, source: 'Site C', rooms: 3, noAgency: true })]);
    q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.adId)).toEqual([four]);
    // Un non sur le 4 pièces ne ferme que lui ; un nouveau 5 pièces de 65 m² entre.
    expect(await s.pige.oppose(s.agentAlex, four)).toEqual({ ok: true });
    await s.pige.ingest(s.network.id, [s.ad({ ...flat, source: 'Site D', rooms: 5 })]);
    q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.rooms)).toEqual([5]);
  });

  it('[R672] le même appartement, mêmes surface et pièces sur deux sites, est un seul bien, avec un seul message', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad({ ...flat, rooms: 3 }), s.ad({ ...flat, source: 'Site B', rooms: 3 })]);
    const q = await s.pige.queue(s.agentAlex);
    if (!q.ok) throw new Error('file');
    expect(q.value.map((e) => e.sites)).toEqual([2]);
    const ids = (await s.db.all<{ id: string }>('SELECT id FROM pige_ads ORDER BY source')).map((r) => r.id);
    expect(await s.pige.prepare(s.agentAlex, ids[0]!)).toMatchObject({ ok: true });
    expect(await s.pige.prepare(s.agentAlex, ids[1]!)).toMatchObject({ ok: false, rule: 'R05' });
    // Revu « pas d'agence » à 1 m² près, mêmes pièces : fermé.
    await s.pige.ingest(s.network.id, [s.ad({ ...flat, source: 'Site C', surfaceM2: 66, rooms: 3, noAgency: true })]);
    const after = await s.pige.queue(s.agentAlex);
    expect(after.ok && after.value).toEqual([]);
  });

  it('[R672] un site qui tait les pièces ne réunit rien, mais ferme dans le doute, sans que le doute passe à un troisième bien', async () => {
    const s = await setup();
    await s.pige.ingest(s.network.id, [s.ad({ ...flat, rooms: 3 }), s.ad({ ...flat, source: 'Site B', rooms: undefined }), s.ad({ ...flat, source: 'Site C', rooms: 4 })]);
    let q = await s.pige.queue(s.agentAlex);
    if (!q.ok) throw new Error('file');
    // Trois biens dans la file, aucun réuni.
    expect(q.value.map((e) => e.rooms ?? 0).sort()).toEqual([0, 3, 4]);
    const unknown = q.value.find((e) => e.rooms === null)!.adId;
    const three = q.value.find((e) => e.rooms === 3)!.adId;
    const four = q.value.find((e) => e.rooms === 4)!.adId;
    // Un message pour celui qui tait ses pièces : ni le 3 ni le 4 pièces, qui pourraient être lui, n'en ont un second [R05].
    expect(await s.pige.prepare(s.agentAlex, unknown)).toMatchObject({ ok: true });
    expect(await s.pige.prepare(s.agentAlex, three)).toMatchObject({ ok: false, rule: 'R05' });
    expect(await s.pige.prepare(s.agentAlex, four)).toMatchObject({ ok: false, rule: 'R05' });
    // Le 3 pièces dit « pas d'agence » ailleurs : il est fermé, celui qui tait ses pièces aussi, dans le doute ; le 4
    // pièces, qui ne peut pas être le 3 pièces, reste dans la file.
    await s.pige.ingest(s.network.id, [s.ad({ ...flat, source: 'Site D', rooms: 3, noAgency: true })]);
    q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.adId)).toEqual([four]);
    // Une nouvelle annonce qui tait ses pièces n'entre pas (doute), et rien n'est rangé sur elle : un 4 pièces vu ensuite
    // sur un autre site entre quand même.
    const before = (await s.db.first<{ n: number }>('SELECT count(*) AS n FROM pige_no_agency'))!.n;
    const r = await s.pige.ingest(s.network.id, [s.ad({ ...flat, source: 'Site E', rooms: undefined })]);
    expect(r).toMatchObject({ added: 0, noAgency: 1 });
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM pige_no_agency'))!.n).toBe(before);
    expect(await s.pige.ingest(s.network.id, [s.ad({ ...flat, source: 'Site F', rooms: 4 })])).toMatchObject({ added: 1 });
  });

  it('[R672] deux annonces qui taisent leurs pièces ne sont jamais réunies, ni avant ni après que leurs pièces se disent', async () => {
    const s = await setup();
    const a = s.ad({ ...flat, rooms: undefined });
    const b = s.ad({ ...flat, source: 'Site B', rooms: undefined });
    await s.pige.ingest(s.network.id, [a, b]);
    let q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.sites)).toEqual([1, 1]);
    // Leurs pièces se disent : 3 et 4. Le 3 pièces revu « pas d'agence » ailleurs ne ferme pas le 4 pièces.
    s.at(MONDAY_10H + 3_600_000);
    await s.pige.ingest(s.network.id, [{ ...a, rooms: 3 }, { ...b, rooms: 4 }]);
    await s.pige.ingest(s.network.id, [s.ad({ ...flat, source: 'Site C', rooms: 3, noAgency: true })]);
    q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => [e.source, e.rooms])).toEqual([['Site B', 4]]);
  });

  it('[R672] une annonce fermée seulement dans le doute entre le jour où ses pièces la séparent du bien fermé', async () => {
    const s = await setup();
    const a = s.ad({ ...flat, rooms: undefined });
    await s.pige.ingest(s.network.id, [a]);
    await s.pige.ingest(s.network.id, [s.ad({ ...flat, source: 'Site B', rooms: 3, noAgency: true })]);
    let q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
    s.at(MONDAY_10H + 3_600_000);
    expect(await s.pige.ingest(s.network.id, [{ ...a, rooms: 4 }])).toMatchObject({ added: 1, noAgency: 0 });
    q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value.map((e) => e.rooms)).toEqual([4]);
    // Corrigée en 3 pièces, elle est prouvée le bien fermé : dehors.
    s.at(MONDAY_10H + 7_200_000);
    await s.pige.ingest(s.network.id, [{ ...a, rooms: 3 }]);
    q = await s.pige.queue(s.agentAlex);
    expect(q.ok && q.value).toEqual([]);
  });
});
