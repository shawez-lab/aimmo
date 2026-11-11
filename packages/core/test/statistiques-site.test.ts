import { expect, it } from 'vitest';
import { StatistiquesSite } from '../src/statistiques-site/statistiques.ts';
import { isRobotVisit } from '../src/statistiques-site/robots.ts';
import { readSchema } from '../src/conformite/registre.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, communes, contacts et contenus inventés.
const NOW = Date.parse('2026-12-07T10:00:00.000Z');
const DAY = 86_400_000;
// Navigateurs de personnes, tels qu'annoncés (chaînes publiques, aucune personne derrière).
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0';
const CUBOT = 'Mozilla/5.0 (Linux; Android 12; CUBOT X70) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const ROBOTS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'WhatsApp/2.23.20.0 A',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36',
  'curl/8.5.0',
  'python-requests/2.32.3',
  'Wget/1.21.4',
  'Go-http-client/2.0',
  'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; trendictionbot0.5.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
];

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = NOW;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const stats = new StatistiquesSite(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  const bien = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'B1', kind: 'home', postalCode: '21800', city: 'Quetigny-Test', status: 'available' });
  let codes = 0;
  const content = async (kind: string, ref: string, networkId = network.id) => {
    codes += 1;
    const id = `code${'abcdefgh'.slice(0, 8 - String(codes).length)}${[...String(codes)].map((d) => 'abcdefghij'[Number(d)]).join('')}`;
    await db.run('INSERT INTO public_contents (id, network_id, kind, ref, created_at) VALUES (?, ?, ?, ?, ?)', [id, networkId, kind, ref, new Date(NOW).toISOString()]);
    return id;
  };
  let m = 0;
  /** Une conversation venue de tel contenu, d'une personne qui vend, achète ou n'est pas encore rattachée. */
  const demande = async (contentId: string | null, o: { project?: string | null; mandate?: boolean; at?: number; conv?: string; personId?: string } = {}) => {
    m += 1;
    let personId: string | null = o.personId ?? null;
    if (o.project !== null && !o.personId) {
      const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Inès', lastName: `Durand${m}` });
      personId = person.id;
      if (o.project) await store.createProject({ networkId: network.id, agentId: alex.id, personId, kind: o.project as 'sell' });
      if (o.mandate) {
        await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'site', 'test', ?)", [
          `m${m}`,
          network.id,
          alex.id,
          personId,
          bien.id,
          new Date((o.at ?? NOW - 10 * DAY) + DAY).toISOString(),
          new Date(NOW).toISOString(),
        ]);
      }
    }
    const id = `in-${m}`;
    const at = new Date(o.at ?? NOW - 10 * DAY).toISOString();
    await db.run(
      `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, external_id, conversation_ref, sender_name, body, status, person_id, received_at, created_at)
       VALUES (?, ?, ?, 'site', 'form', ?, ?, 'Personne Inventée', 'Bonjour', 'processed', ?, ?, ?)`,
      [id, network.id, `k-${id}`, `ext-${id}`, o.conv ?? null, personId, at, at],
    );
    if (contentId) {
      const kind = (await db.first<{ kind: string }>('SELECT kind FROM public_contents WHERE id = ?', [contentId]))!.kind;
      await db.run("INSERT INTO contact_origins (id, network_id, inbound_id, content_id, content_kind, method, recorded_at) VALUES (?, ?, ?, ?, ?, 'lien', ?)", [`o-${id}`, network.id, id, contentId, kind, at]);
    }
    return id;
  };
  const views = async (code: string, n: number) => {
    for (let i = 0; i < n; i += 1) expect(await stats.countView(network.id, code, { userAgent: PHONE })).toEqual({ ok: true, counted: true });
  };
  const zone = async (agentId: string, commune: string) =>
    db.run('INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at) VALUES (?, ?, ?, ?, ?)', [`z-${agentId}-${commune}`, network.id, agentId, commune, new Date(NOW).toISOString()]);
  const person = async (project: string | null) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Martin' });
    if (project) await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: project as 'sell' });
    return p.id;
  };
  return { db, journal, stats, store, person, network, other, alex, sam, as, direction: as('direction', 'd1'), agentAlex: as('agent', alex.id), agentSam: as('agent', sam.id), bien, content, demande, views, zone, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('HX15 · statistiques du site', () => {
  it('[R285] [R156] une vue n’est qu’un compteur par contenu et par jour : rien du visiteur n’est gardé', async () => {
    const t = await setup();
    const page = await t.content('prix', 'dijon-test');
    await t.views(page, 3);
    t.setClock(NOW + DAY);
    await t.views(page, 1);
    expect(await t.db.all('SELECT content_id, day, views FROM site_page_views ORDER BY day')).toEqual([
      { content_id: page, day: '2026-12-07', views: 3 },
      { content_id: page, day: '2026-12-08', views: 1 },
    ]);
    // La table n'a aucune place pour une donnée du visiteur.
    const schema = readSchema(loadMigrations());
    const cols = schema.get('site_page_views');
    expect(cols ? [...cols.columns].sort() : null).toEqual(['content_id', 'day', 'network_id', 'views']);
    // Un code inconnu, d'un autre réseau, ou qui n'en est pas un : rien n'est compté.
    const elsewhere = await t.content('prix', 'ailleurs-test', t.other.id);
    for (const bad of [elsewhere, 'pas-un-code', 'zzzzzzzzzzzz', 42, null]) expect(await t.stats.countView(t.network.id, bad, { userAgent: PHONE })).toEqual({ ok: false, code: 'unknown_content' });
    expect(await t.db.first<{ n: number }>('SELECT SUM(views) AS n FROM site_page_views')).toEqual({ n: 4 });
    // Un compteur ne descend pas et ne s'efface pas.
    await expect(t.db.run('UPDATE site_page_views SET views = 0')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM site_page_views')).rejects.toThrow();
  });

  it('[R286] chaque statistique relie la page à des demandes réelles : demandes, vendeurs et mandats, chacun par son message', async () => {
    const t = await setup();
    const prix = await t.content('prix', 'dijon-test');
    const quartier = await t.content('quartier', 'dijon-test/centre');
    await t.views(prix, 40);
    await t.views(quartier, 10);
    const v1 = await t.demande(prix, { project: 'sell', mandate: true });
    const v2 = await t.demande(prix, { project: 'valuation' });
    const a1 = await t.demande(prix, { project: 'buy' });
    const n1 = await t.demande(prix, { project: null });
    const q1 = await t.demande(quartier, { project: 'sell' });
    // Une suite de la même conversation ne compte pas deux fois ; une conversation d'avant la période ne compte pas.
    await t.demande(prix, { project: 'buy', conv: 'conv-1' });
    await t.demande(null, { project: 'sell', conv: 'conv-1', at: NOW - 9 * DAY });
    await t.demande(prix, { project: 'sell', at: NOW - 120 * DAY });
    // Sans origine connue : aucune page ne la prend.
    await t.demande(null, { project: 'sell' });
    const r = await t.stats.pages(t.direction);
    expect(r).toMatchObject({ ok: true, firstDay: '2026-09-09', lastDay: '2026-12-07' });
    if (!r.ok) return;
    const byId = new Map(r.pages.map((p) => [p.contentId, p]));
    const p = byId.get(prix)!;
    expect(p.views).toBe(40);
    expect(p.demandes).toHaveLength(5);
    expect(p.demandes).toEqual(expect.arrayContaining([v1, v2, a1, n1]));
    expect(p.vendeurs).toEqual([v1, v2].sort());
    expect(p.mandats).toEqual([v1]);
    expect(p.vendeursPour1000Vues).toBe(50);
    expect(byId.get(quartier)).toMatchObject({ views: 10, demandes: [q1], vendeurs: [q1], mandats: [], vendeursPour1000Vues: 100 });
    // Chaque demande comptée est un message reçu du réseau.
    for (const page of r.pages) for (const id of page.demandes) expect(await t.db.first('SELECT id FROM inbound_messages WHERE id = ? AND network_id = ?', [id, t.network.id])).toEqual({ id });
    // Aucun nom dans le résultat.
    expect(JSON.stringify(r)).not.toMatch(/Inès|Durand|Inventée/);
    expect(await t.stats.pages(t.direction, { days: 3 })).toEqual({ ok: false, rule: null, code: 'bad_period' });
  });

  it('[R286] une demande est nommée par son premier message, sa personne est la première rattachée, et un mandat compte sans projet', async () => {
    const t = await setup();
    const prix = await t.content('prix', 'dijon-test');
    // Le premier message n'a pas d'origine ; le suivant la donne : la demande reste nommée par le premier.
    const first = await t.demande(null, { project: null, conv: 'conv-a', at: NOW - 12 * DAY });
    const second = await t.demande(prix, { project: null, conv: 'conv-a', at: NOW - 11 * DAY });
    // Deux personnes dans une conversation : celle du premier message compte, quel que soit l'ordre de leurs identifiants.
    const buyer = await t.person('buy');
    const seller = await t.person('sell');
    // Le premier rattaché a le plus grand identifiant : un tri par identifiant prendrait l'autre, de rôle contraire.
    const firstPerson = buyer > seller ? buyer : seller;
    const laterPerson = firstPerson === buyer ? seller : buyer;
    const conv = await t.demande(prix, { personId: firstPerson, conv: 'conv-b', at: NOW - 8 * DAY });
    await t.demande(null, { personId: laterPerson, conv: 'conv-b', at: NOW - 7 * DAY });
    // Un mandat signé sans projet de vente : compté comme mandat et comme vendeur.
    const mandat = await t.demande(prix, { mandate: true });
    const r = await t.stats.pages(t.direction);
    if (!r.ok) throw new Error('pages');
    const p = r.pages.find((x) => x.contentId === prix)!;
    expect(p.demandes).toEqual([first, conv, mandat].sort());
    expect(p.demandes).not.toContain(second);
    const expected = firstPerson === seller ? [conv, mandat].sort() : [mandat];
    expect(p.vendeurs).toEqual(expected);
    expect(p.mandats).toEqual([mandat]);
  });

  it('[R286] [R16] l’agent voit sa page et ses biens ; ni la conformité ni un agent parti ne voient rien', async () => {
    const t = await setup();
    const pageAlex = await t.content('agent', t.alex.id);
    const pageSam = await t.content('agent', t.sam.id);
    const bien = await t.content('bien', t.bien.id);
    const prix = await t.content('prix', 'dijon-test');
    for (const c of [pageAlex, pageSam, bien, prix]) await t.views(c, 2);
    const alex = await t.stats.pages(t.agentAlex);
    expect(alex.ok && alex.pages.map((p) => p.contentId).sort()).toEqual([pageAlex, bien].sort());
    const sam = await t.stats.pages(t.agentSam);
    expect(sam.ok && sam.pages.map((p) => p.contentId)).toEqual([pageSam]);
    expect(await t.stats.pages(t.as('compliance', 'c1'))).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.stats.pages({ role: 'agent', userId: t.alex.id, networkId: t.other.id })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.stats.nextPage(t.as('compliance', 'c1'))).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R287] la prochaine page à écrire : la sorte qui amène le plus de vendeurs par vue, dans la commune qui ne l’a pas encore', async () => {
    const t = await setup();
    await t.zone(t.alex.id, 'Dijon-Test');
    await t.zone(t.alex.id, 'Quetigny-Test');
    await t.zone(t.sam.id, 'Talant-Test');
    const prix = await t.content('prix', 'dijon-test');
    const quartier = await t.content('quartier', 'dijon-test/centre');
    const bien = await t.content('bien', t.bien.id);
    // Sans vendeur mesuré : rien n'est proposé.
    expect(await t.stats.nextPage(t.direction)).toEqual({ ok: true, suggestion: null, reason: 'aucun_vendeur_mesure' });
    await t.views(prix, 50);
    await t.views(quartier, 10);
    await t.demande(prix, { project: 'sell' });
    await t.demande(quartier, { project: 'sell' });
    // Deux vendeurs déjà arrivés par un bien de Quetigny-Test.
    await t.demande(bien, { project: 'sell' });
    await t.demande(bien, { project: 'valuation' });
    // Quartier : 1 vendeur pour 10 vues, mieux que prix (1 pour 50). Dijon-Test a déjà sa page de quartier ; Quetigny-Test,
    // où arrivent déjà deux vendeurs, passe avant Talant-Test.
    const r = await t.stats.nextPage(t.direction);
    expect(r).toEqual({
      ok: true,
      reason: 'proposee',
      suggestion: {
        kind: 'quartier',
        commune: 'Quetigny-Test',
        path: '/quartiers/quetigny-test/',
        figures: { kindVendeurs: 1, kindViews: 10, communeVendeurs: 2 },
        text: 'Écrire la page de quartier de Quetigny-Test : sur la période, les pages de quartier ont amené 1 vendeur pour 10 vues (100 pour 1 000 vues), et Quetigny-Test n\'a pas encore la sienne alors que 2 vendeurs y sont déjà arrivés par le site.',
      },
    });
    // L'agent : seulement ses communes.
    const sam = await t.stats.nextPage(t.agentSam);
    expect(sam).toMatchObject({ ok: true, reason: 'proposee', suggestion: { kind: 'quartier', commune: 'Talant-Test', figures: { communeVendeurs: 0 } } });
    if (sam.ok && sam.suggestion) expect(sam.suggestion.text).toBe('Écrire la page de quartier de Talant-Test : sur la période, les pages de quartier ont amené 1 vendeur pour 10 vues (100 pour 1 000 vues), et Talant-Test n\'a pas encore la sienne.');
    // Toutes les communes ont leur page : rien n'est proposé.
    await t.content('quartier', 'quetigny-test/centre');
    await t.content('quartier', 'talant-test/centre');
    expect(await t.stats.nextPage(t.direction)).toEqual({ ok: true, suggestion: null, reason: 'toutes_les_communes_ont_leur_page' });
  });

  it('[R287] une commune qui a déjà sa page, publiée sans code de suivi, n’est jamais proposée', async () => {
    const t = await setup();
    await t.zone(t.alex.id, 'Dijon-Test');
    await t.zone(t.alex.id, 'Quetigny-Test');
    await t.zone(t.alex.id, 'Talant-Test');
    const net = t.network.id;
    await t.db.exec('PRAGMA foreign_keys = OFF');
    const zone = (id: string, level: string, parent: string | null, slug: string) =>
      t.db.run("INSERT INTO price_zones (id, network_id, level, parent_id, slug, label, insee_code, ring_json, ring_source, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'test', 'x', 'x')", [id, net, level, parent, slug, slug, level === 'commune' ? '99001' : null]);
    await zone('zq', 'commune', null, 'quetigny-test');
    await zone('zq1', 'quartier', 'zq', 'centre');
    await zone('zd', 'commune', null, 'dijon-test');
    // Une page de quartier validée à Quetigny-Test, une case de prix publiée à Dijon-Test : aucune n'a de code de suivi.
    await t.db.run("INSERT INTO neighbourhood_drafts (id, network_id, zone_id, kind, topic, title, body, origin, data_digest, created_by, created_at) VALUES ('nd1', ?, 'zq1', 'page', 'quartier', 'Le centre', 'Texte', 'redaction', ?, 'x', 'x')", [net, 'c'.repeat(64)]);
    await t.db.run("INSERT INTO neighbourhood_validations (draft_id, text_sha256, data_digest, validated_by, validated_at) VALUES ('nd1', ?, ?, 'x', 'x')", ['d'.repeat(64), 'c'.repeat(64)]);
    await t.db.run(
      "INSERT INTO price_versions (id, network_id, source, dvf_last_sale, window_from, window_to, areas_digest, sales_digest, min_sales, round_to, status, computed_at, completed_at) VALUES ('v1', ?, 'DVF', '2026-06-30', '2024-07-01', '2026-06-30', ?, ?, 5, 10, 'en_cours', 'x', NULL)",
      [net, 'a'.repeat(64), 'b'.repeat(64)],
    );
    const cols = (await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('price_cells')")).map((c) => c.name);
    const values: Record<string, string | null> = { version_id: 'v1', area_id: 'zd', kind: 'apartment', status: 'publiee', hold_code: null };
    const names = cols.filter((c) => c in values);
    await t.db.run(`INSERT INTO price_cells (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((c) => values[c]!));
    await t.db.run("UPDATE price_versions SET status = 'complet', completed_at = '2026-10-20T08:00:00.000Z' WHERE id = 'v1'");
    await t.db.exec('PRAGMA foreign_keys = ON');
    // Des vendeurs par une page de quartier et par une page de prix d'une autre commune.
    const quartier = await t.content('quartier', 'autre-test/centre');
    await t.views(quartier, 10);
    await t.demande(quartier, { project: 'sell' });
    expect(await t.stats.nextPage(t.direction)).toMatchObject({ ok: true, suggestion: { kind: 'quartier', commune: 'Dijon-Test' } });
    const prix = await t.content('prix', 'autre-test');
    await t.views(prix, 1);
    await t.demande(prix, { project: 'sell' });
    await t.demande(prix, { project: 'sell' });
    expect(await t.stats.nextPage(t.direction)).toMatchObject({ ok: true, suggestion: { kind: 'prix', commune: 'Quetigny-Test', path: '/prix/quetigny-test' } });
  });

  it('[R287] à égalité de vendeurs par vue, la sorte qui en amène le plus passe d’abord ; le même jeu donne la même proposition', async () => {
    const t = await setup();
    await t.zone(t.alex.id, 'Dijon-Test');
    const prix = await t.content('prix', 'autre-test');
    const quartier = await t.content('quartier', 'autre-test/centre');
    await t.views(prix, 20);
    await t.views(quartier, 10);
    await t.demande(prix, { project: 'sell' });
    await t.demande(prix, { project: 'sell' });
    await t.demande(quartier, { project: 'sell' });
    const a = await t.stats.nextPage(t.direction);
    expect(a).toMatchObject({ ok: true, suggestion: { kind: 'prix', commune: 'Dijon-Test', path: '/prix/dijon-test' } });
    expect(await t.stats.nextPage(t.direction)).toEqual(a);
  });

  it('[R285] RC12 · une visite de personne compte, un robot, un aperçu de lien ou un script ne compte pas', async () => {
    const t = await setup();
    const page = await t.content('prix', 'dijon-test');
    for (const ua of [PHONE, DESKTOP, ANDROID, FIREFOX, CUBOT]) {
      expect(isRobotVisit(ua)).toBe(false);
      expect(await t.stats.countView(t.network.id, page, { userAgent: ua })).toEqual({ ok: true, counted: true });
    }
    for (const ua of ROBOTS) {
      expect(isRobotVisit(ua)).toBe(true);
      expect(await t.stats.countView(t.network.id, page, { userAgent: ua })).toEqual({ ok: true, counted: false });
    }
    // Sans navigateur, vide, illisible : pas une personne.
    for (const ua of [undefined, null, '', '   ', 42, ['Mozilla/5.0']]) {
      expect(isRobotVisit(ua)).toBe(true);
      expect(await t.stats.countView(t.network.id, page, { userAgent: ua })).toEqual({ ok: true, counted: false });
    }
    expect(await t.db.all('SELECT content_id, views FROM site_page_views')).toEqual([{ content_id: page, views: 5 }]);
  });

  it('[R285] RC12 · un code inconnu est refusé d’abord, robot ou non', async () => {
    const t = await setup();
    const elsewhere = await t.content('prix', 'ailleurs-test', t.other.id);
    for (const ua of [PHONE, ROBOTS[0], undefined]) {
      for (const bad of [elsewhere, 'pas-un-code', 'zzzzzzzzzzzz', 42, null]) {
        expect(await t.stats.countView(t.network.id, bad, { userAgent: ua })).toEqual({ ok: false, code: 'unknown_content' });
      }
    }
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM site_page_views')).toEqual({ n: 0 });
  });

  it('[R285] RC12 · le navigateur annoncé n’est rangé dans aucune table ni au journal', async () => {
    const t = await setup();
    const page = await t.content('prix', 'dijon-test');
    const marked = 'Mozilla/5.0 (Linux; Android 14; Marque-Inventee-RC12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
    const robot = 'Mozilla/5.0 (compatible; RobotInventeRC12bot/1.0)';
    expect(await t.stats.countView(t.network.id, page, { userAgent: marked })).toEqual({ ok: true, counted: true });
    expect(await t.stats.countView(t.network.id, page, { userAgent: robot })).toEqual({ ok: true, counted: false });
    const tables = await t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    for (const { name } of tables) {
      const rows = await t.db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`);
      const text = JSON.stringify(rows);
      expect(text.includes('Marque-Inventee-RC12'), name).toBe(false);
      expect(text.includes('RobotInventeRC12'), name).toBe(false);
    }
  });
});
