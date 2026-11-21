import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  AD_FAILURE_ACTIONS,
  AdPlatformError,
  PublicitePayante,
  googleAdsPlatform,
  metaAdsPlatform,
  recordAdArrival,
  trialAdPlatform,
  type AdLaunch,
  type AdPlatform,
  type AdReceipt,
  type AdRef,
} from '../src/marketing/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU038 · la vraie campagne : réseau, comptes, communes, lieux, jetons et montants inventés.
const START = Date.parse('2027-10-11T08:00:00.000Z');
const TARGET = { communes: ['21231', '21166'], rayonKm: 30 };
const BUDGET = { dailyBudgetCents: 2_000, totalBudgetCents: 30_000, maxCostPerContactCents: 1_500 };
const CAP = 50_000;

/** Une plateforme réelle simulée : elle rend un accusé, lit la dépense donnée, et note les pauses. */
function fakeReal(opts: { receipt?: AdReceipt | void; failStart?: AdPlatformError; spend?: (ref: AdRef, day: string) => number } = {}) {
  const started: AdLaunch[] = [];
  const paused: Array<[string, string | null | undefined]> = [];
  const platform: AdPlatform = {
    mode: 'reel',
    start: async (l) => {
      started.push(l);
      if (opts.failStart) throw opts.failStart;
      return 'receipt' in opts ? opts.receipt : { externalRef: '120000000000001' };
    },
    pause: async (code, ref) => {
      paused.push([code, ref]);
    },
    ...(opts.spend ? { spend: async (ref: AdRef, day: string) => opts.spend!(ref, day) } : {}),
  };
  return { platform, started, paused };
}

async function setup(meta: AdPlatform, cap: number | null = CAP) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const pub = new PublicitePayante(db, journal, { google_ads: trialAdPlatform(), meta }, { now, ...(cap === null ? {} : { realCapCents: cap }) });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  const campaign = async () => {
    const c = await pub.create(dir, { platform: 'meta', name: 'Vendeurs Dijon', targeting: TARGET });
    if (!c.ok) throw new Error(c.code);
    return c.value;
  };
  const report = async () => {
    const r = await pub.report(dir);
    if (!r.ok) throw new Error(r.code);
    return r.value[0]!;
  };
  return { db, journal, store, pub, network, alex, dir, events, campaign, report, now, advance: (ms: number) => (clock += ms) };
}

describeWithSqlite('AU038 · une campagne réelle à budget plafonné, suivie jusqu’au mandat', () => {
  it('[R587] constat : une plateforme réelle demande son plafond ; au-delà, la validation est refusée ; en deçà, le lancement range l’accusé réel', async () => {
    const real = fakeReal();
    // Le constat : sans plafond réglé à la mise en service (H63), aucune plateforme réelle n'est admise.
    await expect(setup(real.platform, null)).rejects.toThrow(/plafond/);
    const t = await setup(real.platform);
    const c = await t.campaign();
    expect(await t.pub.approve(t.dir, c.id, { ...BUDGET, totalBudgetCents: CAP + 1 })).toMatchObject({ ok: false, rule: 'R587', code: 'plafond' });
    expect((await t.events('publicite.refus')).some((e) => e.code === 'plafond')).toBe(true);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true });
    expect(await t.pub.start(t.dir, c.id)).toMatchObject({ ok: true });
    expect(real.started).toEqual([{ code: c.code, communes: ['21166', '21231'], radiusKm: 30, dailyBudgetCents: 2_000, totalBudgetCents: 30_000 }]);
    expect(await t.db.first('SELECT mode, external_ref FROM ad_campaign_receipts')).toEqual({ mode: 'reel', external_ref: '120000000000001' });
    expect(await t.events('publicite.lancee')).toEqual([expect.objectContaining({ mode: 'reel' })]);
    expect(await t.report()).toMatchObject({ state: 'en_cours', mode: 'reel', failure: null, pendingArrivals: 0 });
    // L'arrêt demande la pause avec la référence rendue par la plateforme.
    expect(await t.pub.stop(t.dir, c.id)).toMatchObject({ ok: true });
    expect(real.paused).toEqual([[c.code, '120000000000001']]);
    await expect(t.db.run('DELETE FROM ad_campaign_receipts')).rejects.toThrow(/efface/);
    await expect(t.db.run("UPDATE ad_campaign_receipts SET external_ref = 'x'")).rejects.toThrow(/change/);
  });

  it('[R587] [R588] le plafond se relit au lancement ; une plateforme d’essai mise à la place d’une réelle ne confirme jamais sa pause', async () => {
    const real = fakeReal();
    const t = await setup(real.platform);
    const c = await t.campaign();
    await t.pub.approve(t.dir, c.id, BUDGET);
    // Le plafond baissé après la validation : rien ne part au-delà.
    const lower = new PublicitePayante(t.db, t.journal, { google_ads: trialAdPlatform(), meta: real.platform }, { now: t.now, realCapCents: 10_000 });
    expect(await lower.start(t.dir, c.id)).toMatchObject({ ok: false, rule: 'R587', code: 'plafond' });
    expect(real.started).toEqual([]);
    expect(await t.pub.start(t.dir, c.id)).toMatchObject({ ok: true });
    expect(await t.db.first('SELECT mode FROM ad_campaign_start_modes')).toEqual({ mode: 'reel' });
    // Les réglages réels perdus : la plateforme d'essai prend la place, l'arrêt ne tient pas la pause pour faite.
    const trial = trialAdPlatform();
    const lost = new PublicitePayante(t.db, t.journal, { google_ads: trialAdPlatform(), meta: trial }, { now: t.now });
    expect(await lost.stop(t.dir, c.id)).toMatchObject({ ok: true });
    expect(trial.paused).toEqual([]);
    expect(await t.db.first('SELECT paused_at FROM ad_campaign_stops')).toEqual({ paused_at: null });
    expect((await t.report()).failure).toEqual({ step: 'pause', code: 'hors_service', action: 'reconnecter' });
    // Rien de neuf ne se valide tant que la pause n'est pas confirmée ; les réglages rétablis, le passage la redemande.
    expect(await lost.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false, code: 'pause_en_attente' });
    await lost.runChecks(t.network.id);
    expect(await t.db.first('SELECT paused_at FROM ad_campaign_stops')).toEqual({ paused_at: null });
    await t.pub.runChecks(t.network.id);
    expect(real.paused).toEqual([[c.code, '120000000000001']]);
    expect(await t.db.first<{ paused_at: string | null }>('SELECT paused_at FROM ad_campaign_stops')).not.toEqual({ paused_at: null });
  });

  it('[R587] un lancement réel sans accusé est un échec, la pause cherchée par le code ; un jeton expiré se dit « reconnecter »', async () => {
    const silent = fakeReal({ receipt: undefined });
    const t = await setup(silent.platform);
    const c = await t.campaign();
    await t.pub.approve(t.dir, c.id, BUDGET);
    expect(await t.pub.start(t.dir, c.id)).toEqual({ ok: false, rule: 'R587', code: 'echec_lancement', detail: 'inconnue' });
    expect(silent.paused).toEqual([[c.code, null]]);
    expect(await t.report()).toMatchObject({ state: 'arretee', stopReason: 'echec_lancement', mode: null, failure: { step: 'lancement', code: 'inconnue', action: 'verifier' } });

    const expired = fakeReal({ failStart: new AdPlatformError('reconnecter') });
    const u = await setup(expired.platform);
    const d = await u.campaign();
    await u.pub.approve(u.dir, d.id, BUDGET);
    expect(await u.pub.start(u.dir, d.id)).toMatchObject({ ok: false, code: 'echec_lancement', detail: 'reconnecter' });
    expect((await u.report()).failure).toEqual({ step: 'lancement', code: 'reconnecter', action: 'reconnecter' });
    expect(await u.events('publicite.echec')).toEqual([{ rule: 'R587', step: 'lancement', code: 'reconnecter', action: 'reconnecter' }]);
    // Une validation nouvelle efface l'échec de l'écran, jamais de la base [R17].
    u.advance(60_000);
    await u.pub.approve(u.dir, d.id, BUDGET);
    expect((await u.report()).failure).toBeNull();
    expect(await u.db.first<{ n: number }>('SELECT count(*) AS n FROM ad_campaign_failures')).toEqual({ n: 1 });
    // Chaque échec a son geste.
    for (const code of Object.keys(AD_FAILURE_ACTIONS)) expect(AD_FAILURE_ACTIONS[code as keyof typeof AD_FAILURE_ACTIONS]).toMatch(/^(reconnecter|donner_acces|corriger|reessayer|verifier)$/);
  });

  it('[R588] la dépense des trois derniers jours est lue chez la plateforme et arrête la campagne au seuil ; une lecture en échec n’est pas rangée', async () => {
    let amounts: Record<string, number> = {};
    let broken = false;
    const real = fakeReal({
      spend: (ref, day) => {
        if (broken) throw new AdPlatformError('indisponible');
        expect(ref.externalRef).toBe('120000000000001');
        return amounts[day] ?? 0;
      },
    });
    const t = await setup(real.platform);
    const c = await t.campaign();
    await t.pub.approve(t.dir, c.id, BUDGET);
    await t.pub.start(t.dir, c.id);
    // Le jour du lancement seul : rien avant lui n'est lu.
    amounts = { '2027-10-11': 900 };
    expect(await t.pub.syncSpend(t.network.id)).toEqual({ days: 1, failures: 0 });
    expect((await t.report()).spendCents).toBe(900);
    t.advance(86_400_000);
    amounts = { '2027-10-11': 1_000, '2027-10-12': 700 };
    broken = true;
    expect(await t.pub.syncSpend(t.network.id)).toEqual({ days: 0, failures: 2 });
    expect((await t.report()).spendCents).toBe(900);
    expect((await t.report()).failure).toEqual({ step: 'depense', code: 'indisponible', action: 'reessayer' });
    broken = false;
    expect(await t.pub.syncSpend(t.network.id)).toEqual({ days: 2, failures: 0 });
    // 1 700 € > 1 500 € de seuil sans contact : la campagne s'arrête seule, la pause demandée avec la référence.
    expect(await t.report()).toMatchObject({ spendCents: 1_700, state: 'arretee', stopReason: 'seuil' });
    expect(real.paused).toEqual([[c.code, '120000000000001']]);
  });

  it('[R588] une demande arrivée par le lien de la campagne devient son contact quand le message est rattaché à une fiche, et son mandat compte', async () => {
    const real = fakeReal();
    const t = await setup(real.platform);
    const c = await t.campaign();
    const inbound = async (id: string, at: string) =>
      t.db.run("INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, body, status, received_at, created_at) VALUES (?, ?, ?, 'site', 'form', 'x', 'processed', ?, ?)", [id, t.network.id, id, at, at]);
    await inbound('in-0', '2027-10-11T08:30:00.000Z');
    const link = `https://reseau.example/estimer?o=${c.code}`;
    // Jamais lancée : rien n'est rangé.
    expect(await recordAdArrival(t.db, t.journal, t.now, t.network.id, 'in-0', { link })).toBeNull();
    await t.pub.approve(t.dir, c.id, BUDGET);
    await t.pub.start(t.dir, c.id);
    await inbound('in-1', '2027-10-11T09:00:00.000Z');
    await inbound('in-2', '2027-10-11T09:05:00.000Z');
    // Deux codes, c'est un doute ; un code inconnu, rien.
    expect(await recordAdArrival(t.db, t.journal, t.now, t.network.id, 'in-2', { link: `${link}&o=autre` })).toBeNull();
    expect(await recordAdArrival(t.db, t.journal, t.now, t.network.id, 'in-2', { landingPage: 'https://reseau.example/?o=inconnu1234' })).toBeNull();
    expect(await recordAdArrival(t.db, t.journal, t.now, t.network.id, 'in-1', { landingPage: link })).toEqual({ campaignId: c.id });
    expect(await recordAdArrival(t.db, t.journal, t.now, t.network.id, 'in-1', { landingPage: link })).toEqual({ campaignId: c.id });
    expect(await t.db.first('SELECT inbound_id, arrived_at, matched_at FROM ad_campaign_arrivals')).toEqual({ inbound_id: 'in-1', arrived_at: '2027-10-11T09:00:00.000Z', matched_at: null });
    // Pas encore de fiche : la demande attend, l'écran la compte.
    expect(await t.pub.matchArrivals(t.network.id)).toEqual({ matched: 0 });
    expect((await t.report()).pendingArrivals).toBe(1);
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Paule', lastName: 'Essai' });
    await t.db.run('UPDATE inbound_messages SET person_id = ? WHERE id = ?', [p.id, 'in-1']);
    expect(await t.pub.matchArrivals(t.network.id)).toEqual({ matched: 1 });
    expect(await t.pub.matchArrivals(t.network.id)).toEqual({ matched: 0 });
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES ('m-1', ?, ?, ?, 'bien-1', '2027-10-20T10:00:00.000Z', 'portal', 'agent:test', '2027-10-20T10:00:00.000Z')", [t.network.id, t.alex.id, p.id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    expect(await t.report()).toMatchObject({ contacts: 1, mandates: 1, pendingArrivals: 0 });
    // Le contact compte depuis l'arrivée de la demande, pas depuis le rapprochement.
    expect(await t.db.first('SELECT arrived_at FROM ad_campaign_contacts')).toEqual({ arrived_at: '2027-10-11T09:00:00.000Z' });
    // Au journal : des issues, jamais une personne [R13].
    expect(JSON.stringify(await t.events('publicite.demande'))).not.toContain(p.id);
    await expect(t.db.run('DELETE FROM ad_campaign_arrivals')).rejects.toThrow(/efface/);
  });
});

/** Un faux serveur HTTP : chaque appel noté, la réponse choisie par l'adresse. */
function fakeHttp(answer: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const http = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const raw = typeof init.body === 'string' ? init.body : '';
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    calls.push({ url, method: init.method ?? 'GET', body, headers: (init.headers ?? {}) as Record<string, string> });
    const a = answer(url, init);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { http, calls };
}

const LAUNCH: AdLaunch = { code: 'abcdefgh2345', communes: ['21166', '21231'], radiusKm: 30, dailyBudgetCents: 2_000, totalBudgetCents: 30_000 };
const PLACES = { '21231': '1006094', '21166': '1006095' };

it('[R589] Google Ads : créée en pause, zone en communes seules, mots et annonce avec le lien suivi, puis activée ; dépense en centimes ; erreurs en codes', async () => {
  let n = 0;
  const g = fakeHttp((url, init) => {
    if (url.includes('oauth2')) return { body: { access_token: 'jeton-essai', expires_in: 3600 } };
    if (url.endsWith('googleAds:search')) return { body: { results: [{ metrics: { costMicros: '12345678' } }] } };
    n += 1;
    const kind = url.split('/').pop()!.replace(':mutate', '');
    // Une ligne rendue par opération, comme le compte réel.
    const count = (JSON.parse(String(init.body)) as { operations: unknown[] }).operations.length;
    return { body: { results: Array.from({ length: count }, (_, i) => ({ resourceName: `customers/1234567890/${kind}/${n}${i ? `-${i}` : ''}` })) } };
  });
  const config = {
    http: g.http,
    landingUrl: 'https://reseau.example/estimer?utm=x',
    places: PLACES,
    clientId: 'abc.apps.googleusercontent.com',
    clientSecret: 'secret-essai',
    refreshToken: 'rafraichir-essai',
    developerToken: 'dev-essai',
    customerId: '1234567890',
    keywords: ['estimation maison dijon'],
    headlines: ['Estimer votre bien', 'Vendre à Dijon', 'Un conseiller local'],
    descriptions: ['Un conseiller du réseau vous répond.', 'Prenez rendez-vous en ligne.'],
  };
  expect(() => googleAdsPlatform({ ...config, headlines: ['Un', 'Deux'] })).toThrow(/Titres/);
  const google = googleAdsPlatform(config);
  // Une commune sans lieu réglé : rien ne part.
  await expect(google.start({ ...LAUNCH, communes: ['21000'] })).rejects.toMatchObject({ failure: 'lieu_inconnu' });
  expect(g.calls).toEqual([]);
  const receipt = (await google.start(LAUNCH)) as AdReceipt;
  expect(receipt).toEqual({ externalRef: 'customers/1234567890/campaigns/2' });
  const mutations = g.calls.filter((c) => c.url.includes(':mutate'));
  expect(mutations.map((c) => c.url.split('/').pop())).toEqual(['campaignBudgets:mutate', 'campaigns:mutate', 'campaignCriteria:mutate', 'adGroups:mutate', 'adGroupCriteria:mutate', 'adGroupAds:mutate', 'campaigns:mutate']);
  const ops = (i: number) => (mutations[i]!.body as { operations: Array<Record<string, any>> }).operations;
  expect(ops(0)[0]!.create).toMatchObject({ name: 'AIMMO abcdefgh2345', amountMicros: '20000000' });
  expect(ops(1)[0]!.create).toMatchObject({ name: 'AIMMO abcdefgh2345', status: 'PAUSED', advertisingChannelType: 'SEARCH' });
  expect(ops(2).map((o) => o.create)).toEqual([
    { campaign: 'customers/1234567890/campaigns/2', location: { geoTargetConstant: 'geoTargetConstants/1006095' } },
    { campaign: 'customers/1234567890/campaigns/2', location: { geoTargetConstant: 'geoTargetConstants/1006094' } },
  ]);
  // Aucun critère sur la personne : ni âge, ni sexe, ni audience [R589].
  expect(JSON.stringify(mutations.map((c) => c.body))).not.toMatch(/ageRange|gender|userList|income|parental|audience/i);
  expect(ops(5)[0]!.create.ad.finalUrls).toEqual(['https://reseau.example/estimer?utm=x&o=abcdefgh2345']);
  expect(ops(6)[0]).toEqual({ update: { resourceName: 'customers/1234567890/campaigns/2', status: 'ENABLED' }, updateMask: 'status' });
  expect(mutations.every((c) => c.headers.authorization === 'Bearer jeton-essai' && c.headers['developer-token'] === 'dev-essai')).toBe(true);
  // La dépense d'un jour : 12,345678 € → 1 235 centimes.
  expect(await google.spend!({ code: LAUNCH.code, externalRef: receipt.externalRef }, '2027-10-11')).toBe(1_235);
  // Les erreurs de Google deviennent des codes fermés, jamais leur message.
  const bad = fakeHttp(() => ({ status: 401, body: { error: { status: 'UNAUTHENTICATED', message: 'jeton secret-essai' } } }));
  const off = googleAdsPlatform({ ...config, http: bad.http });
  await expect(off.pause(LAUNCH.code, null)).rejects.toMatchObject({ failure: 'reconnecter', message: 'plateforme publicitaire : reconnecter' });
  const denied = googleAdsPlatform({ ...config, http: fakeHttp((url) => (url.includes('oauth2') ? { body: { access_token: 'j', expires_in: 3600 } } : { status: 403, body: { error: { status: 'PERMISSION_DENIED' } } })).http });
  await expect(denied.start(LAUNCH)).rejects.toMatchObject({ failure: 'acces' });
});

it('[R589] Meta : catégorie logement toujours déclarée, villes et rayon pour tous les adultes, plafond de dépense, lien suivi ; rayon trop petit refusé avant tout appel', async () => {
  const m = fakeHttp((url, init) => {
    if (init.method === 'GET' && url.includes('/insights')) return { body: { data: [{ spend: '12.34' }] } };
    if (init.method === 'GET') return { body: { data: [{ id: '555' }, { id: '556' }] } };
    if (/\/[0-9]+$/.test(url)) return { body: { success: true } };
    return { body: { id: String(100 + m.calls.length) } };
  });
  const config = { http: m.http, landingUrl: 'https://reseau.example/estimer', places: PLACES, accessToken: 'jeton-meta-essai', adAccountId: '987654321', pageId: '111222333', message: 'Votre bien estimé par un conseiller du réseau.' };
  const meta = metaAdsPlatform(config);
  await expect(meta.start({ ...LAUNCH, radiusKm: 20 })).rejects.toMatchObject({ failure: 'rayon' });
  await expect(meta.start({ ...LAUNCH, radiusKm: null })).rejects.toMatchObject({ failure: 'rayon' });
  expect(m.calls).toEqual([]);
  const receipt = await meta.start(LAUNCH);
  expect(receipt).toEqual({ externalRef: '101' });
  const [campaign, adset, creative, ad, on] = m.calls;
  expect(campaign!.url).toBe('https://graph.facebook.com/v23.0/act_987654321/campaigns');
  expect(campaign!.body).toMatchObject({ name: 'AIMMO abcdefgh2345', status: 'PAUSED', special_ad_categories: ['HOUSING'], special_ad_category_country: ['FR'], spend_cap: 30_000 });
  expect((adset!.body as Record<string, unknown>).targeting).toEqual({
    geo_locations: { cities: [{ key: '1006095', radius: 30, distance_unit: 'kilometer' }, { key: '1006094', radius: 30, distance_unit: 'kilometer' }], location_types: ['home', 'recent'] },
    age_min: 18,
    age_max: 65,
  });
  expect(adset!.body).toMatchObject({ campaign_id: '101', daily_budget: 2_000 });
  expect(creative!.body).toMatchObject({ object_story_spec: { page_id: '111222333', link_data: { link: 'https://reseau.example/estimer?o=abcdefgh2345' } } });
  expect(ad!.body).toMatchObject({ adset_id: '102', creative: { creative_id: '103' } });
  expect(on).toMatchObject({ url: 'https://graph.facebook.com/v23.0/101', body: { status: 'ACTIVE' } });
  expect(m.calls.every((c) => c.headers.authorization === 'Bearer jeton-meta-essai' && !c.url.includes('jeton'))).toBe(true);
  expect(await meta.spend!({ code: LAUNCH.code, externalRef: '101' }, '2027-10-11')).toBe(1_234);
  // Sans accusé, la pause retrouve les campagnes par leur nom.
  const before = m.calls.length;
  await meta.pause(LAUNCH.code, null);
  expect(m.calls.slice(before).map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
    'GET https://graph.facebook.com/v23.0/act_987654321/campaigns',
    'POST https://graph.facebook.com/v23.0/555',
    'POST https://graph.facebook.com/v23.0/556',
  ]);
  const expired = metaAdsPlatform({ ...config, http: fakeHttp(() => ({ status: 400, body: { error: { code: 190, message: 'jeton-meta-essai expiré' } } })).http });
  await expect(expired.pause(LAUNCH.code, '101')).rejects.toMatchObject({ failure: 'reconnecter' });
  const refused = metaAdsPlatform({ ...config, http: fakeHttp(() => ({ status: 400, body: { error: { code: 100 } } })).http });
  await expect(refused.start(LAUNCH)).rejects.toMatchObject({ failure: 'refusee' });
});
