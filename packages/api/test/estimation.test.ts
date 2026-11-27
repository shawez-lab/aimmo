import { expect, it } from 'vitest';
import { DvfSiteSales, FicheClient, SqlJournalStore, applyMigrations, type Geocoded, type Geocoder, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés et données inventées pour les tests.
const KEY_EST = 'test-cle-estimation-iiiiiiiiiiiiiiiiiiiiiiiiiiii';
const KEY_CHAT = 'test-cle-assistant-jjjjjjjjjjjjjjjjjjjjjjjjjjjj';
const URL_EST = 'https://aimmo-api.example.workers.dev/v1/estimation/commune';
const VISITOR = 'visiteur-essai-0000000001';
const NOW = () => new Date('2026-10-27T09:00:00.000Z');
const STEP = 0.05;
const CENTER = { lat: 47.3225, lon: 5.0412 };
const tile = `${Math.floor(CENTER.lon / STEP)}_${Math.floor(CENTER.lat / STEP)}`;

function dvfFiles(): Map<string, string> {
  const rows: unknown[][] = [];
  const details: string[] = [];
  for (let i = 0; i < 24; i++) {
    const house = i % 4 === 3;
    rows.push([CENTER.lat + (i % 6) * 0.001, CENTER.lon + Math.floor(i / 6) * 0.001, house ? 1 : 0, 50 + i * 3, 2000 + i * 50, 202401 + (i % 12), 3, house ? 400 : 0]);
    // Deux ventes d'une commune voisine, dans le rayon : elles ne comptent pas.
    details.push(JSON.stringify([100000 + i, 'RUE DE L ESSAI', i < 2 ? 'VOISINE-SUR-TEST' : 'VILLE-TEST', 5]));
  }
  return new Map([
    ['index.json', JSON.stringify({ source: 'DVF test', departement: '21', annees: [2023, 2024, 2025], derniere_vente: '2025-12-30', tuile: STEP, tuiles: [tile] })],
    [`t/${tile}.json`, JSON.stringify(rows)],
    [`d/${tile}.txt`, details.join('\n')],
  ]);
}

class FakeGeocoder implements Geocoder {
  asked: string[] = [];
  async geocode(q: string): Promise<Geocoded | null> {
    this.asked.push(q);
    if (!/21990 Ville-Test/i.test(q)) return null;
    return { label: 'Ville-Test', lat: CENTER.lat, lon: CENTER.lon, postalCode: '21990', inseeCode: '21999', town: 'Ville-Test', banId: null, score: 0.95 };
  }
}

async function world() {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  const net = await new FicheClient(db).createNetwork('Réseau test');
  const intakeKeys = JSON.stringify([
    { sha256: await sha256Hex(KEY_EST), networkId: net.id, source: 'site_estimate' },
    { sha256: await sha256Hex(KEY_CHAT), networkId: net.id, source: 'site_chat' },
  ]);
  const files = dvfFiles();
  const geocoder = new FakeGeocoder();
  const config = {
    db,
    mode: 'essai',
    apiKeys: undefined,
    intakeKeys,
    estimation: { geocoder, sales: new DvfSiteSales(async (p) => files.get(p) ?? null) },
    estimationLimits: { perVisitor: 3, perNetwork: 100 },
    now: NOW,
  };
  const call = async (body: unknown, key = KEY_EST, cfg: Record<string, unknown> = config) => {
    const res = await handleRequest(
      new Request(URL_EST, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      cfg as typeof config,
    );
    return { status: res.status, text: await res.clone().text(), body: (await res.json()) as Record<string, unknown> };
  };
  const ask = (over: Record<string, unknown> = {}) => ({ visitorId: VISITOR, postalCode: '21990', town: 'Ville-Test', kind: 'appartement', ...over });
  return { db, config, call, ask, geocoder, journal: new SqlJournalStore(db) };
}

// RS04 : les sites et leurs pages, inventés. La clé sert seulement à régler les sites.
const NET_SITE = 'https://reseau-rs04.example.test';
const AGENT_SITE = 'https://alex-rs04.example.test';
const KEY_DIR = 'test-cle-rs04-direction-kkkkkkkkkkkkkkkkkkkkkkkkk';

async function sitesWorld() {
  const w = await world();
  const net = (await w.db.first<{ id: string }>('SELECT id FROM networks'))!.id;
  await w.db.run("INSERT INTO agents (id, network_id, first_name, last_name, created_at, updated_at) VALUES ('ag-rs04', ?, 'Alex', 'Exemple', 'x', 'x')", [net]);
  const config = { ...w.config, apiKeys: JSON.stringify([{ sha256: await sha256Hex(KEY_DIR), role: 'direction', userId: 'dir-1', networkId: net }]) };
  for (const body of [{ kind: 'reseau', baseUrl: NET_SITE, active: true }, { kind: 'agent', agentId: 'ag-rs04', baseUrl: AGENT_SITE, active: true }]) {
    const res = await handleRequest(new Request('https://aimmo-api.example.workers.dev/v1/attirer/sites', { method: 'POST', headers: { authorization: `Bearer ${KEY_DIR}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config as never);
    expect(res.status).toBe(200);
  }
  const get = (url: string, cfg: unknown = config) => handleRequest(new Request(url), cfg as never);
  const post = (body: string, host = NET_SITE, type = 'application/x-www-form-urlencoded') => handleRequest(new Request(`${host}/estimation`, { method: 'POST', headers: { 'content-type': type }, body }), config as never);
  const form = (over: Record<string, string> = {}) => new URLSearchParams({ visitorId: VISITOR, postalCode: '21990', town: 'Ville-Test', kind: 'appartement', ...over }).toString();
  return { ...w, config, net, get, post, form };
}

describeWithSqlite('RS04 · la page d’estimation du site', () => {
  it('[R10] [R31] la fourchette est celle de E05, au chiffre près, et aucun champ ne parle d’un bien précis', async () => {
    const t = await sitesWorld();
    const page = await t.get(`${NET_SITE}/estimation`);
    expect(page.status).toBe(200);
    const blank = await page.text();
    expect(blank).toContain('name="postalCode"');
    expect(blank).not.toMatch(/name="(surface|address|adresse|rooms|pieces)"/i);
    const api = (await t.call(t.ask({ visitorId: 'visiteur-essai-0000000002' }))).body.data as { perM2: { low: number; median: number; high: number }; sales: number };
    const res = await t.post(t.form());
    expect(res.status).toBe(200);
    const html = (await res.text()).replace(/\u202f|\u00a0/g, ' ');
    const money = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €/m²`;
    expect(html).toContain(`De ${money(api.perM2.low)} à ${money(api.perM2.high)}`);
    expect(html).toContain(`Prix médian : ${money(api.perM2.median)}`);
    expect(html).toContain(`Sur ${api.sales} ventes`);
    expect(html).toContain('Source : DVF test');
    // [R28] La date des données et le manque des ventes récentes sont dits, comme par E05.
    expect(html).toContain('dernière vente connue le 30 décembre 2025');
    expect(html).toContain('Les ventes des derniers mois ne sont pas encore publiées');
    expect(html).toContain('sans visite, personne ne peut le dire');
    for (const field of ['surface=80', 'adresse=1+rue+inventee']) expect((await t.post(`${t.form()}&${field}`)).status, field).toBe(400);
  });

  it('[R03] aucune coordonnée n’est demandée, rien du visiteur n’est gardé ni au journal, le rendez-vous reste son choix', async () => {
    const t = await sitesWorld();
    const html = await (await t.get(`${NET_SITE}/estimation`)).text();
    expect(html).not.toMatch(/type="(email|tel)"|name="(email|phone|telephone|nom)"/i);
    expect(html).toContain('personne ne vous recontactera');
    expect(html).toContain('href="/agents"');
    await t.post(t.form());
    const events = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(events).toContain('public:estimation');
    expect(events).not.toContain('21990');
    expect(events).not.toContain('Ville-Test');
    expect(events).not.toContain(VISITOR);
    const calls = JSON.stringify(await t.db.all('SELECT * FROM assistant_calls'));
    expect(calls).not.toContain(VISITOR);
  });

  it('les limites de E05 tiennent : par visite, puis pour le réseau, quel que soit le visiteur', async () => {
    const t = await sitesWorld();
    for (let i = 0; i < 3; i++) expect((await t.post(t.form())).status).toBe(200);
    const over = await t.post(t.form());
    expect(over.status).toBe(429);
    expect(await over.text()).toContain('Trop de demandes');
    // La limite du réseau tient quel que soit l'identifiant donné par le formulaire.
    t.config.estimationLimits = { perVisitor: 3, perNetwork: 5 };
    expect((await t.post(t.form({ visitorId: 'visiteur-essai-0000000098' }))).status).toBe(200);
    expect((await t.post(t.form({ visitorId: 'visiteur-essai-0000000097' }))).status).toBe(200);
    expect((await t.post(t.form({ visitorId: 'visiteur-essai-0000000099' }))).status).toBe(429);
  });

  it('une saisie invalide est dite en français et garde ce qui est écrit, échappé ; la fourchette absente est dite', async () => {
    const t = await sitesWorld();
    const cases: [Record<string, string>, string][] = [
      [{ postalCode: '21' }, 'en 5 chiffres'],
      [{ town: 'Ville 2' }, 'sans chiffre'],
      [{ kind: 'chateau' }, 'appartement ou maison'],
      [{ kind: 'constructor' }, 'appartement ou maison'],
    ];
    for (const [over, text] of cases) {
      const res = await t.post(t.form(over));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(text);
    }
    expect((await t.post(t.form({ visitorId: 'court' }))).status).toBe(400);
    expect((await t.post('{}', NET_SITE, 'application/json')).status).toBe(400);
    expect((await t.post(`${t.form()}&kind=maison`)).status).toBe(400);
    expect((await t.post(`${t.form()}&x=${'a'.repeat(3000)}`)).status).toBe(400);
    const hostile = await (await t.post(t.form({ town: '"><script>x</script>' }))).text();
    expect(hostile).not.toContain('<script>x');
    const unknown = await t.post(t.form({ town: 'Inconnue' }));
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toContain('Nous ne trouvons pas cette commune');
    // [R28] Un département que les ventes publiques ne couvrent pas est dit tel.
    const uncovered = await t.post(t.form({ postalCode: '67000', town: 'Ville' }));
    expect(uncovered.status).toBe(200);
    expect(await uncovered.text()).toContain('ne couvrent pas ce département');
  });

  it('[R13] une panne du géocodage : la page reste, avec la saisie et le rendez-vous, et le journal ne dit rien du visiteur', async () => {
    const t = await sitesWorld();
    const sales = t.config.estimation.sales;
    (t.config as { estimation: unknown }).estimation = { sales, geocoder: { geocode: async () => { throw new TypeError('panne'); } } };
    const res = await t.post(t.form());
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('ne répond pas en ce moment');
    expect(html).toContain('value="21990"');
    expect(html).toContain('href="/agents"');
    const events = JSON.stringify(await t.db.all("SELECT * FROM journal WHERE type = 'api.erreur'"));
    expect(events).toContain('TypeError');
    expect(events).not.toContain('21990');
    expect(events).not.toContain('Ville-Test');
  });

  it('[R153] sur les deux sites ; hors d’un site, 404 ; sans données, la page le dit et le lien aboutit ; aucune réponse en cache', async () => {
    const t = await sitesWorld();
    const own = await t.get(`${AGENT_SITE}/estimation`);
    expect(own.status).toBe(200);
    // Le site d'un agent sans ses mentions ne mène pas à sa page [R152]. DS087 · sans fourchette, l'action principale
    // est « Voir la fourchette » : le rendez-vous est un lien filaire.
    expect(await own.text()).toContain('class="appel secondaire" href="/"');
    expect(own.headers.get('cache-control')).toBe('no-store');
    expect(own.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(own.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect((await t.get('https://aimmo-api.example.workers.dev/estimation')).status).toBe(404);
    const { estimation: _none, ...closed } = t.config;
    const res = await t.get(`${NET_SITE}/estimation`, closed);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('pas encore ouverte');
    expect(html).not.toContain('<form');
    expect((await handleRequest(new Request(`${NET_SITE}/estimation`, { method: 'PUT' }), t.config as never)).status).toBe(405);
    const head = await handleRequest(new Request(`${NET_SITE}/estimation`, { method: 'HEAD' }), t.config as never);
    expect(await head.text()).toBe('');
  });
});

describeWithSqlite('E05 · estimation en ligne du site', () => {
  it('[R31] rend la fourchette au m² de la commune, ses ventes seulement, et propose un rendez-vous', async () => {
    const w = await world();
    const r = await w.call(w.ask());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      mode: 'essai',
      data: { town: 'Ville-Test', postalCode: '21990', kind: 'apartment', next: 'appointment', data: { lastSale: '2025-12-30', recentMissing: true } },
    });
    const data = r.body['data'] as { sales: number; perM2: { low: number; median: number; high: number }; period: { from: string; to: string } };
    // 18 appartements, dont 2 dans la commune voisine.
    expect(data.sales).toBe(16);
    expect(data.perM2.low).toBeLessThan(data.perM2.median);
    expect(data.perM2.median).toBeLessThan(data.perM2.high);
    expect(data.period.from <= data.period.to).toBe(true);
    // Aucun prix total, aucune donnée de vente individuelle.
    expect(r.text).not.toMatch(/"(price|low|high)"\s*:\s*\d{6,}/);
    expect(r.text).not.toMatch(/surface|Rue de|street|price"/);
  });

  it('[R31] une surface, une adresse ou tout autre champ est refusé : jamais le prix d’un bien précis', async () => {
    const w = await world();
    for (const over of [{ surface: 65 }, { address: '1 rue de l’Essai' }, { lat: 47.3 }, { rooms: 3 }]) {
      const r = await w.call(w.ask(over));
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.body['code']).toBe('unexpected_field');
    }
    expect((await w.call(w.ask({ town: '12 rue de l’Essai' }))).status).toBe(400);
    expect(w.geocoder.asked).toEqual([]);
  });

  it('seuls le code postal et la commune partent au géocodage', async () => {
    const w = await world();
    await w.call(w.ask());
    expect(w.geocoder.asked).toEqual(['21990 Ville-Test']);
  });

  it('sans fourchette possible, la raison et le rendez-vous', async () => {
    const w = await world();
    expect((await w.call(w.ask({ town: 'Inconnue' }))).body).toMatchObject({ ok: true, data: null, reason: 'commune_introuvable', next: 'appointment' });
    expect((await w.call(w.ask({ kind: 'maison' }))).body).toMatchObject({ data: null, reason: 'peu_de_ventes' });
    expect((await w.call(w.ask({ postalCode: '57000', visitorId: 'visiteur-essai-0000000002' }))).body).toMatchObject({ data: null, reason: 'dvf_non_couvert' });
    expect((await w.call(w.ask({ postalCode: '75001', visitorId: 'visiteur-essai-0000000002' }))).body).toMatchObject({ data: null, reason: 'hors_zone' });
  });

  it('[R15] limites par visiteur, rien du visiteur gardé hors de l’empreinte de son identifiant', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) expect((await w.call(w.ask())).status).toBe(200);
    expect((await w.call(w.ask())).status).toBe(429);
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000009' }))).status).toBe(200);
    const dump = JSON.stringify([await w.db.all('SELECT * FROM assistant_calls'), await w.journal.all()]);
    expect(dump).not.toContain(VISITOR);
    expect(dump).not.toContain('Ville-Test');
  });

  it('une limite par réseau, et l’empreinte du visiteur change d’heure en heure', async () => {
    const w = await world();
    const cfg = { ...w.config, estimationLimits: { perVisitor: 10, perNetwork: 2 } };
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000011' }), KEY_EST, cfg)).status).toBe(200);
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000012' }), KEY_EST, cfg)).status).toBe(200);
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000013' }), KEY_EST, cfg)).status).toBe(429);
    const later = { ...cfg, now: () => new Date('2026-10-27T10:00:00.000Z') };
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000011' }), KEY_EST, later)).status).toBe(200);
    const scopes = (await w.db.all<{ scope: string }>("SELECT scope FROM assistant_calls WHERE scope LIKE 'estimation:%' AND scope != 'estimation:reseau'")).map((r) => r.scope);
    // Quatre empreintes : le même visiteur, à deux heures différentes, en a deux qui ne se relient pas.
    expect(new Set(scopes).size).toBe(4);
  });

  it('des ventes illisibles : pas de fourchette faussée, la raison et le nombre au journal', async () => {
    const w = await world();
    const files = dvfFiles();
    files.delete(`d/${tile}.txt`);
    const cfg = { ...w.config, estimation: { geocoder: w.geocoder, sales: new DvfSiteSales(async (p) => files.get(p) ?? null) } };
    expect((await w.call(w.ask(), KEY_EST, cfg)).body).toMatchObject({ data: null, reason: 'donnees_absentes', next: 'appointment' });
    const logged = (await w.journal.all()).filter((e) => e.type === 'estimation.commune');
    expect(logged.at(-1)?.data).toMatchObject({ ok: false, reason: 'donnees_absentes' });
    expect(Number(logged.at(-1)?.data['missingFiles'])).toBeGreaterThan(0);
  });

  it('une tuile illisible ou une ligne mal formée compte à chaque demande, même gardée en mémoire', async () => {
    const w = await world();
    const [x, y] = tile.split('_').map(Number) as [number, number];
    const missing = dvfFiles();
    const idx = JSON.parse(missing.get('index.json')!) as { tuiles: string[] };
    idx.tuiles.push(`${x + 1}_${y}`);
    missing.set('index.json', JSON.stringify(idx));
    const shared = new DvfSiteSales(async (p) => missing.get(p) ?? null);
    const cfg = { ...w.config, estimation: { geocoder: w.geocoder, sales: shared } };
    for (const visitorId of ['visiteur-essai-0000000021', 'visiteur-essai-0000000022']) {
      expect((await w.call(w.ask({ visitorId }), KEY_EST, cfg)).body, visitorId).toMatchObject({ data: null, reason: 'donnees_absentes' });
    }
    const malformed = dvfFiles();
    const rows = JSON.parse(malformed.get(`t/${tile}.json`)!) as unknown[];
    rows.push([47.3, 5.04, 0, 'soixante', 2500, 202401, 3, 0]);
    malformed.set(`t/${tile}.json`, JSON.stringify(rows));
    const cfg2 = { ...w.config, estimation: { geocoder: w.geocoder, sales: new DvfSiteSales(async (p) => malformed.get(p) ?? null) } };
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000023' }), KEY_EST, cfg2)).body).toMatchObject({ data: null, reason: 'donnees_absentes' });
    // Un détail sans commune lisible compte aussi.
    const noTown = dvfFiles();
    const lines = noTown.get(`d/${tile}.txt`)!.split('\n');
    lines[5] = '[]';
    noTown.set(`d/${tile}.txt`, lines.join('\n'));
    const cfg3 = { ...w.config, estimation: { geocoder: w.geocoder, sales: new DvfSiteSales(async (p) => noTown.get(p) ?? null) } };
    expect((await w.call(w.ask({ visitorId: 'visiteur-essai-0000000024' }), KEY_EST, cfg3)).body).toMatchObject({ data: null, reason: 'donnees_absentes' });
  });

  it('clé `site_estimate` seulement ; sans données branchées ou hors essai, fermé', async () => {
    const w = await world();
    expect((await w.call(w.ask(), KEY_CHAT)).status).toBe(401);
    const { estimation: _unused, ...closed } = w.config;
    expect((await w.call(w.ask(), KEY_EST, closed)).status).toBe(503);
    expect((await w.call(w.ask(), KEY_EST, { ...w.config, mode: 'reel' })).status).toBe(503);
    const get = await handleRequest(new Request(URL_EST, { headers: { authorization: `Bearer ${KEY_EST}` } }), w.config);
    expect(get.status).toBe(405);
  });
});
