import { expect, it } from 'vitest';
import { ROLES, SqlJournalStore, applyMigrations, fromSyncSqlite, type Role, type SqlDatabase, type Viewer } from '@aimmo/core';
import { bodyParagraphs, renderNeighbourhoodPage, type PriceSalesSource } from '../../core/src/attirer/index.ts';
import type { EstimatedKind, Sale } from '../../core/src/estimation/fourchette.ts';
import { attirerRoutes, handleAttirerPublic, listingReference, type AttirerServices } from '../src/attirer.ts';
import { htmlProblems } from '../../core/src/design/audit.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { SITE_MENTION_FIELDS, SITE_TREATMENTS } from '../../core/src/attirer/mentions-site.ts';
import { launchProofInputs } from '../../core/test/mise-en-service-jeu.ts';
import { REGISTRE_TRAITEMENTS } from '../../core/src/conformite/registre-traitements.ts';
import { AGENTS_PER_PAGE, COMMUNES_PER_PAGE, renderAgentsList, renderPricesList } from '../../core/src/attirer/annuaire-site.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, biens, sites, ventes et contours inventés.
const NET = 'https://reseau.exemple.test';
const CAMILLE = 'https://camille.exemple.test';
const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: 'net-1' };
const camille: Viewer = { role: 'agent', userId: 'ag-1', networkId: 'net-1' };
const lou: Viewer = { role: 'agent', userId: 'ag-2', networkId: 'net-1' };

const COMMUNE = [[47.0, 5.0], [47.0, 5.1], [47.1, 5.1], [47.1, 5.0]];
const WEST = [[47.0, 5.0], [47.0, 5.05], [47.1, 5.05], [47.1, 5.0]];
const EAST = [[47.0, 5.05], [47.0, 5.1], [47.1, 5.1], [47.1, 5.05]];
let seq = 0;
const sale = (kind: EstimatedKind, lon: number, pricePerM2: number): Sale => {
  seq++;
  return { id: `t:${seq}`, kind, lat: 47.05 + (seq % 50) / 10000, lon, surface: 40 + (seq % 30), pricePerM2, month: '2026-03' };
};
// Ouest : 7 appartements (publiés) ; Est : 2 appartements (trop peu : retenus) ; la commune : 9 appartements.
const SALES = [...[2000, 2100, 2200, 2300, 2400, 2500, 2600].map((p) => sale('apartment', 5.02, p)), ...[3111, 3222].map((p) => sale('apartment', 5.08, p))];
const priceSales: PriceSalesSource = {
  coverage: async () => ({ department: '99', lastSale: '2026-06-30', years: [2024, 2025, 2026], source: 'DVF, jeu inventé' }),
  within: async (kind) => SALES.filter((s) => s.kind === kind),
};

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2026-10-29T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-2', 'Autre réseau', '2026-01-01T00:00:00.000Z')");
  for (const [id, net, first, last] of [
    ['ag-1', 'net-1', 'Camille', 'Exemple'],
    ['ag-2', 'net-1', 'Lou', 'Essai'],
    ['ag-9', 'net-2', 'Autre', 'Agent'],
  ]) {
    await db.run('INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id!, net!, first!, last!, 'Ville inventée', 'x', 'x']);
  }
  const s: AttirerServices = { db, journal, now, priceSales, diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'ok' }) } };
  const routes = attirerRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const request = new Request(`https://api.exemple.test${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const res = await r.handle(s, viewer, m.slice(1), request);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    }
    throw new Error(`route inconnue : ${method} ${path}`);
  };
  const get = async (url: string, method = 'GET') => handleAttirerPublic(s, new Request(url, { method }));
  return { db, journal, s, call, get };
}

async function publishListing(db: SqlDatabase, id: string, agent: string) {
  await db.exec('PRAGMA foreign_keys = OFF');
  await db.run("INSERT INTO properties (id, network_id, agent_id, reference, kind, postal_code, city, created_at, updated_at) VALUES (?, 'net-1', ?, ?, 'home', '99000', 'Ville inventée', 'x', 'x')", [id, agent, `REF-${id}`]);
  await db.run(
    "INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES (?, ?, 'net-1', 1, 'en_vente', ?, 250000, ?, 'h', 'test', '2026-10-11T09:00:00.000Z')",
    [`${id}-1`, id, `d-${id}`, JSON.stringify({ reference: `REF-${id}`, state: 'en_vente', title: `Maison ${id}`, body: 'Texte', mentions: 'Classe énergie D, classe climat C.', priceEur: 250000, media: [] })],
  );
  await db.exec('PRAGMA foreign_keys = ON');
}

/** Sites, mentions de Camille, zones et prix recalculés : tout par les routes. */
async function preparedNetwork(t: Awaited<ReturnType<typeof setup>>) {
  const net = await t.call(direction, 'POST', '/attirer/sites', { kind: 'reseau', baseUrl: NET, active: true });
  const cam = await t.call(direction, 'POST', '/attirer/sites', { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: true });
  expect([net, cam]).toMatchObject([{ status: 200 }, { status: 200 }]);
  expect((await t.call(direction, 'POST', '/attirer/agents/ag-1/mentions', { rsacNumber: 'RSAC 123456789', rsacRegistry: 'Dijon' })).status).toBe(200);
  await t.db.run("INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES ('s1', 'net-1', 'CPI 9999 0000 000 000 001', 'direction:dir-1', 'x')");
  expect((await t.call(direction, 'POST', '/attirer/titulaire', { holder: 'Société Exemple' })).status).toBe(200);
  const commune = await t.call(direction, 'POST', '/attirer/prix/zones', { level: 'commune', slug: 'ville-test', name: 'Ville Test', inseeCode: '99001', ring: COMMUNE, ringSource: 'Contour inventé' });
  expect(commune.status).toBe(200);
  const communeId = commune.body.data?.id ?? commune.body.id;
  for (const [slug, ring] of [
    ['ouest', WEST],
    ['est', EAST],
  ] as const) {
    expect((await t.call(direction, 'POST', '/attirer/prix/zones', { level: 'quartier', parentId: communeId, slug, name: slug, ring, ringSource: 'Contour inventé' })).status).toBe(200);
  }
  const recalcul = await t.call(direction, 'POST', '/attirer/prix/recalcul');
  expect(recalcul.body).toMatchObject({ ok: true, data: { ran: true } });
  return { net: net.body.data?.siteId ?? net.body.siteId, cam: cam.body.data?.siteId ?? cam.body.siteId };
}

describeWithSqlite('AT09 · routes de M01 et pages publiques', () => {
  it('[R152] [R14] RS03 : la liste des agents, publiables seulement, par ordre alphabétique, sans aucun chiffre sur leur activité', async () => {
    const t = await setup();
    await preparedNetwork(t);
    const first = await (await t.get(`${NET}/agents`))!.text();
    expect(first).toContain('href="/agents/ag-1"');
    expect(first).toContain('123 456 789');
    expect((await t.get(`${NET}/agents/ag-1`))!.status).toBe(200);
    // Lou n'a pas ses mentions ; l'agent d'un autre réseau n'y est jamais.
    expect(first).not.toContain('Lou');
    expect(first).not.toContain('ag-9');
    await t.db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES ('ag-3', 'net-1', 'Émile', 'Éclair', 'Ville inventée', 'x', 'x')");
    for (const id of ['ag-2', 'ag-3']) expect((await t.call(direction, 'POST', `/attirer/agents/${id}/mentions`, { rsacNumber: 'RSAC 987654321', rsacRegistry: 'Dijon' })).status).toBe(200);
    const html = await (await t.get(`${NET}/agents`))!.text();
    // Éclair, Essai, Exemple : l'alphabet français, pas l'ordre des octets.
    expect([...html.matchAll(/href="\/agents\/(ag-\d)"/g)].map((m) => m[1])).toEqual(['ag-3', 'ag-2', 'ag-1']);
    const visible = html.replace(/<head>.*<\/head>/s, '').replace(/<p class="doux">Agent commercial[^<]*<\/p>/g, '').replace(/<[^>]+>/g, ' ');
    expect(visible).not.toMatch(/\d/);
    expect(visible).not.toMatch(/note|classement|vente|mandat|avis/i);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = 'ag-3'");
    expect(await (await t.get(`${NET}/agents`))!.text()).not.toContain('ag-3');
    expect((await t.get(`${CAMILLE}/agents`))!.status).toBe(404);
    expect((await t.get('https://inconnu.exemple.test/agents'))!.status).toBe(404);
  });

  it('[R201] RS03 : les deux listes vont par pages ; une page au-delà de la fin ou un paramètre inattendu : 404', async () => {
    const t = await setup();
    await preparedNetwork(t);
    for (const path of ['/agents', '/prix']) {
      for (const query of ['page=2', 'page=x', 'page=0', 'autre=1', 'page=1&page=1']) expect((await t.get(`${NET}${path}?${query}`))!.status, `${path}?${query}`).toBe(404);
      expect((await t.get(`${NET}${path}?page=1`))!.status).toBe(200);
    }
    const many = Array.from({ length: AGENTS_PER_PAGE + 1 }, (_, i) => ({ agentId: `a${i}`, name: `Agent ${i}`, zone: null, mentions: { rsacNumber: '1', rsacRegistry: 'D', cardNumber: 'C', cardHolder: 'H' } }));
    const one = renderAgentsList(many)!;
    expect(one).toContain('href="/agents?page=2"');
    expect(one).not.toContain('/agents/a100"');
    const two = renderAgentsList(many, 2)!;
    expect(two).toContain('/agents/a100"');
    expect(two).toContain('href="/agents"');
    expect(renderAgentsList(many, 3)).toBeNull();
    const towns = Array.from({ length: COMMUNES_PER_PAGE + 1 }, (_, i) => ({ slug: `v${i}`, name: `Ville ${i}` }));
    expect(renderPricesList(towns)).toContain('href="/prix?page=2"');
    expect(renderPricesList(towns, 2)).toContain(`/prix/v${COMMUNES_PER_PAGE}"`);
    expect(renderPricesList(towns, 3)).toBeNull();
  });

  it('[R221] [R10] RS05 : aucune mention inventée, ce qui manque se voit, ce qui est réglé s’affiche, échappé, sur les deux sites', async () => {
    const t = await setup();
    await preparedNetwork(t);
    const empty = await (await t.get(`${NET}/mentions-legales`))!.text();
    // La carte et son titulaire viennent déjà des réglages ; les autres manquent, sauf le contact des données, sur sa propre page.
    expect(empty.match(/Mention manquante/g)).toHaveLength(Object.keys(SITE_MENTION_FIELDS).length - 1);
    expect(empty).toContain('CPI 9999 0000 000 000 001');
    expect(empty).toContain('Société Exemple');
    expect(empty).toContain(`${Object.keys(SITE_MENTION_FIELDS).length} mentions manquent`);
    expect(empty).not.toMatch(/Cloudflare|Dijon|RCS \d/);
    const privacy = await (await t.get(`${CAMILLE}/donnees-personnelles`))!.text();
    expect(privacy.match(/Mention manquante/g)).toHaveLength(2);
    expect(privacy).toContain('la CNIL');
    // Ce qui est gardé vient du registre, mot pour mot : aucune phrase écrite à part ne peut le contredire [R10].
    const unescape = (h: string) => h.replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    for (const id of SITE_TREATMENTS) {
      const t = REGISTRE_TRAITEMENTS.find((x) => x.id === id)!;
      expect(t, id).toBeTruthy();
      expect(unescape(privacy), id).toContain(t.finalite);
      expect(unescape(privacy), id).toContain(t.duree);
    }
    expect((await t.call(direction, 'POST', '/attirer/mentions-site', { editeur_nom: 'Société Inventée', mediateur: 'Médiateur Inventé' })).status).toBe(200);
    const set = await (await t.get(`${CAMILLE}/mentions-legales`))!.text();
    expect(set).toContain('Société Inventée');
    expect(set).toContain('Médiateur Inventé');
    expect(await (await t.get(`${NET}/donnees-personnelles`))!.text()).toContain('Société Inventée');
    // Un texte vide retire la mention, et elle manque de nouveau ; rien n'est effacé [R17].
    expect((await t.call(direction, 'POST', '/attirer/mentions-site', { mediateur: '' })).status).toBe(200);
    expect(await (await t.get(`${NET}/mentions-legales`))!.text()).not.toContain('Médiateur Inventé');
    expect(await t.db.all("SELECT value FROM site_legal_mentions WHERE field = 'mediateur'")).toHaveLength(2);
    for (const bad of [{ inconnu: 'x' }, { mediateur: '<b>x</b>' }, { mediateur: 'x'.repeat(301) }, { mediateur: 1 }, {}]) {
      expect((await t.call(direction, 'POST', '/attirer/mentions-site', bad)).status).toBe(400);
    }
    expect((await t.call(camille, 'POST', '/attirer/mentions-site', { mediateur: 'x' })).status).toBe(403);
    expect((await t.call(camille, 'GET', '/attirer/mentions-site')).status).toBe(403);
    expect((await t.get('https://inconnu.exemple.test/mentions-legales'))!.status).toBe(404);
    // Aucun cookie sur les pages publiques, comme la page le dit.
    for (const path of ['/mentions-legales', '/donnees-personnelles', '/agents', '/prix', '/simulateur']) expect((await t.get(`${NET}${path}`))!.headers.get('set-cookie'), path).toBeNull();
  });

  it('[R221] RS05 : liées depuis chaque page du site, et jamais vers une page absente', async () => {
    const t = await setup();
    await preparedNetwork(t);
    for (const path of ['/', '/biens', '/agents', '/prix', '/prix/ville-test', '/agents/ag-1', '/estimation', '/simulateur', '/preuve', '/mentions-legales', '/donnees-personnelles']) {
      const res = await t.get(`${NET}${path}`);
      expect(res!.status, path).toBe(200);
      const html = await res!.text();
      expect(html, path).toContain('href="/mentions-legales"');
      expect(html, path).toContain('href="/donnees-personnelles"');
    }
  });

  it('[R150] [R153] RS03 : la liste des communes mène à une page qui répond ; une zone retirée en sort ; 404 sur le site d’un agent', async () => {
    const t = await setup();
    await preparedNetwork(t);
    const html = await (await t.get(`${NET}/prix`))!.text();
    expect(html).toContain('Ville Test');
    expect(html).toContain('href="/prix/ville-test"');
    const prices = await (await t.get(`${NET}/prix/ville-test`))!.text();
    expect(prices).toContain('href="/estimation"');
    // [RS04] Le lien des pages de prix aboutit, même sans les données de l'estimation.
    expect((await t.get(`${NET}/estimation`))!.status).toBe(200);
    expect((await t.get(`${CAMILLE}/prix`))!.status).toBe(404);
    const zone = await t.db.first<{ id: string }>("SELECT id FROM price_zones WHERE slug = 'ville-test'");
    expect((await t.call(direction, 'POST', `/attirer/prix/zones/${zone!.id}/retrait`)).status).toBe(200);
    const after = await t.get(`${NET}/prix`);
    expect(after!.status).toBe(200);
    expect(await after!.text()).not.toContain('ville-test');
  });

  it('[R16] AT14 : un agent ouvre sa fiche Google sans connaître son identifiant, jamais celle d’un autre ; sans Google, l’écran répond sans erreur', async () => {
    const t = await setup();
    expect(await t.call(camille, 'GET', '/attirer/google/moi')).toMatchObject({ status: 200, body: { ok: true, data: { agentId: 'ag-1', connected: false, mode: 'essai', canConfigure: false, location: null, reviews: [], publications: [] } } });
    expect(await t.call(direction, 'GET', '/attirer/google/moi')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect(await t.call(camille, 'GET', '/attirer/google/agents/ag-2')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.call(direction, 'GET', '/attirer/google/agents/ag-9')).toMatchObject({ status: 404, body: { rule: 'R16' } });
    expect(await t.call(direction, 'GET', '/attirer/google/agents/ag-1')).toMatchObject({ status: 200, body: { data: { canConfigure: true } } });
    expect(await t.call(camille, 'POST', '/attirer/google/agents/ag-2/lecture')).toMatchObject({ status: 403 });
    expect(await t.call(camille, 'POST', '/attirer/google/agents/ag-2/publication')).toMatchObject({ status: 403 });
    expect(await t.call(camille, 'POST', '/attirer/google/agents/ag-1/lecture')).toMatchObject({ status: 400, body: { code: 'sans_fiche' } });
    expect((await t.call(direction, 'POST', '/attirer/google/agents/ag-1/fiche', { locationRef: 'locations/9', title: 'Camille Exemple', websiteUri: CAMILLE })).status).toBe(200);
    expect(await t.call(camille, 'POST', '/attirer/google/agents/ag-1/lecture')).toMatchObject({ status: 400, body: { code: 'sans_service' } });
    expect(await t.call(camille, 'POST', '/attirer/google/agents/ag-1/publication')).toMatchObject({ status: 200, body: { ok: true, data: null } });
  });

  it('[R16] chaque route refuse, avant de lire le corps, un rôle qu’elle n’admet pas, et l’écrit au journal', async () => {
    const t = await setup();
    const routes = attirerRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(20);
    for (const r of routes) {
      for (const role of ROLES) {
        if (r.roles.includes(role)) continue;
        const viewer: Viewer = { role: role as Role, userId: 'u-1', networkId: 'net-1' };
        const path = r.pattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\([^)]*\)/g, (g) => (g.includes('\\d{4}') ? '2026-10' : 'x1')).replace(/\\\//g, '/');
        // Un corps qui ferait échouer toute lecture : il ne doit jamais être lu.
        const request = new Request(`https://api.exemple.test${path}`, { method: r.method, ...(r.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{' } : {}) });
        const res = await r.handle(t.s, viewer, ['x1'], request);
        expect(res.status, `${r.name} ${role}`).toBe(403);
        expect(await res.json()).toEqual({ ok: false, rule: 'R16', code: 'role' });
        expect(request.bodyUsed).toBe(false);
      }
    }
    const refusals = await t.db.first<{ n: number }>("SELECT count(*) AS n FROM journal WHERE type = 'acces.refuse'");
    expect(Number(refusals!.n)).toBeGreaterThan(routes.length);
    // Les partenaires et la conformité n'ont aucune route ici.
    expect(routes.some((r) => r.roles.includes('partner') || r.roles.includes('compliance'))).toBe(false);
  });

  it('[R16] la portée : un agent ne voit que l’aperçu de sa propre page, et la couche métier refait ses contrôles', async () => {
    const t = await setup();
    await preparedNetwork(t);
    expect(await t.call(camille, 'GET', '/attirer/agents/ag-1/page')).toMatchObject({ status: 200, body: { data: { publishable: true } } });
    expect(await t.call(camille, 'GET', '/attirer/agents/ag-2/page')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.call(lou, 'GET', '/attirer/agents/ag-2/page')).toMatchObject({ status: 200, body: { data: { publishable: false, missing: 'statut_manquant' } } });
    expect(await t.call(direction, 'GET', '/attirer/agents/ag-9/page')).toMatchObject({ status: 404 });
    // Fiche Google : un agent ne lit pas les avis d'un autre agent.
    expect(await t.call(camille, 'GET', '/attirer/google/agents/ag-2/avis')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    // Un site d'un autre réseau n'est jamais lu.
    expect(await t.call({ ...direction, networkId: 'net-2' }, 'GET', '/attirer/sites')).toMatchObject({ status: 200, body: { data: [] } });
    // La mesure de l'origine : direction seule, et un corps illisible est refusé.
    expect(await t.call(direction, 'GET', '/attirer/origine/2026-10')).toMatchObject({ status: 200, body: { data: { contacts: 0, targetPercent: 95 } } });
    const bad = await attirerRoutes().find((r) => r.name === 'attirer.site')!.handle(t.s, direction, [], new Request('https://api.exemple.test/attirer/sites', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }));
    expect(bad.status).toBe(400);
    // Sans source de ventes, aucun recalcul.
    const noSales = await attirerRoutes().find((r) => r.name === 'attirer.prix_recalcul')!.handle({ ...t.s, priceSales: null }, direction, [], new Request('https://api.exemple.test/attirer/prix/recalcul', { method: 'POST' }));
    expect(await noSales.json()).toMatchObject({ ok: false, code: 'source_absente' });
  });

  it('[R153] parcours d’un bien test sur les deux sites : il est dans les deux plans, avec une seule page de référence', async () => {
    const t = await setup();
    const sites = await preparedNetwork(t);
    await publishListing(t.db, 'b1', 'ag-1');
    const plans: string[] = [];
    for (const host of [NET, CAMILLE]) {
      const res = (await t.get(`${host}/sitemap.xml`))!;
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/xml');
      plans.push(await res.text());
    }
    for (const xml of plans) {
      expect(xml).toContain(`<loc>${CAMILLE}/biens/b1</loc>`);
      expect(xml).not.toContain(`${NET}/biens/b1`);
    }
    // La page du bien, sur l'un ou l'autre site, désigne la même page de référence.
    for (const host of [NET, CAMILLE]) {
      expect(await listingReference(t.s, `${host}/biens/b1`, 'b1')).toMatchObject({ canonical: `${CAMILLE}/biens/b1`, link: `<${CAMILLE}/biens/b1>; rel="canonical"` });
    }
    const seo = await listingReference(t.s, `${NET}/biens/b1`, 'b1');
    expect(JSON.parse(seo!.structuredData)).toMatchObject({ url: `${CAMILLE}/biens/b1` });
    expect(seo!.structuredData).not.toContain('99000');
    // Un bien d'un autre agent n'est pas montré par le site de Camille ; un bien non publié ou un site inconnu n'ont rien.
    await publishListing(t.db, 'b2', 'ag-2');
    expect(await listingReference(t.s, `${CAMILLE}/biens/b2`, 'b2')).toBeNull();
    expect(await listingReference(t.s, `${NET}/biens/b2`, 'b2')).toMatchObject({ canonical: `${NET}/biens/b2` });
    expect(await listingReference(t.s, `${NET}/biens/absent`, 'absent')).toBeNull();
    expect(await listingReference(t.s, 'https://imitation.exemple.test/biens/b1', 'b1')).toBeNull();
    // Le plan du réseau porte aussi ses pages de prix ; celui de l'agent, sa seule page d'agent.
    expect(plans[0]).toContain(`${NET}/prix/ville-test`);
    expect(plans[1]).not.toContain('/prix/');
    expect(plans[1]).toContain(`${CAMILLE}/agents/ag-1`);
    // La même chose par la route de la direction.
    expect((await t.call(direction, 'GET', `/attirer/sites/${sites.net}/plan`)).body.data.filter((e: { kind: string }) => e.kind === 'bien')).toEqual([
      { loc: `${CAMILLE}/biens/b1`, lastmod: '2026-10-11', kind: 'bien' },
      { loc: `${NET}/biens/b2`, lastmod: '2026-10-11', kind: 'bien' },
    ]);
    // robots.txt déclare le plan du site lui-même ; en essai, rien n'est indexé.
    for (const host of [NET, CAMILLE]) {
      const robots = await (await t.get(`${host}/robots.txt`))!.text();
      expect(robots).toContain(`Sitemap: ${host}/sitemap.xml`);
      expect(robots).toContain('Disallow: /');
    }
    // [R221] Le mode réel demandé, une mention manquante : le site reste en essai.
    const gated = await handleAttirerPublic({ ...t.s, mode: 'reel' }, new Request(`${NET}/robots.txt`));
    expect(await gated!.text()).toContain('Disallow: /');
    expect((await handleAttirerPublic({ ...t.s, mode: 'reel' }, new Request(`${NET}/mentions-legales`)))!.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect((await t.call(direction, 'POST', '/attirer/mentions-site', Object.fromEntries(Object.keys(SITE_MENTION_FIELDS).map((f) => [f, `Texte inventé ${f}`])))).status).toBe(200);
    // [R675] Toutes les mentions, mais sans preuve de mise en service : le site reste en essai, et la page le dit.
    expect(await (await handleAttirerPublic({ ...t.s, mode: 'reel' }, new Request(`${NET}/robots.txt`)))!.text()).toContain('Disallow: /');
    const closed = await handleAttirerPublic({ ...t.s, mode: 'reel' }, new Request(`${NET}/mentions-legales`));
    expect(closed!.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await closed!.text()).toContain('sa mise en service n’est pas terminée');
    expect((await t.call(camille, 'GET', '/attirer/mise-en-service')).status).toBe(403);
    expect((await t.call(camille, 'POST', '/attirer/mise-en-service', launchProofInputs('2026-10-29', 'CPI 9999 0000 000 000 001')[0])).status).toBe(403);
    expect((await t.call(direction, 'POST', '/attirer/mise-en-service', { prerequisite: 'carte' })).status).toBe(400);
    for (const input of launchProofInputs('2026-10-29', 'CPI 9999 0000 000 000 001')) expect((await t.call(direction, 'POST', '/attirer/mise-en-service', input)).status).toBe(200);
    const board = (await t.call(direction, 'GET', '/attirer/mise-en-service')).body.data as { verified: boolean; features: { feature: string; open: boolean }[] };
    expect(board.verified).toBe(false);
    expect(board.features).toEqual([expect.objectContaining({ feature: 'site_reel', open: true })]);
    const reel = await handleAttirerPublic({ ...t.s, mode: 'reel' }, new Request(`${NET}/robots.txt`));
    expect(await reel!.text()).toContain('Allow: /');
    expect((await handleAttirerPublic({ ...t.s, mode: 'reel' }, new Request(`${NET}/mentions-legales`)))!.headers.get('x-robots-tag')).toBeNull();
    // Une adresse qui n'est pas un site en service : rien.
    expect((await t.get('https://imitation.exemple.test/sitemap.xml'))!.status).toBe(404);
    await t.call(direction, 'POST', '/attirer/sites', { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: false });
    expect((await t.get(`${CAMILLE}/sitemap.xml`))!.status).toBe(404);
    expect(await (await t.get(`${NET}/sitemap.xml`))!.text()).toContain(`<loc>${NET}/biens/b1</loc>`);
    expect(await listingReference(t.s, `${NET}/biens/b1`, 'b1')).toMatchObject({ canonical: `${NET}/biens/b1` });
    expect(await listingReference(t.s, `${CAMILLE}/biens/b1`, 'b1')).toBeNull();
  });

  it('[R150] [R151] aucune page publique ne sert une case non publiable ; les prix vivent sur le site du réseau', async () => {
    const t = await setup();
    await preparedNetwork(t);
    const res = (await t.get(`${NET}/prix/ville-test`))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(htmlProblems(html)).toEqual([]);
    expect(html).toContain('DVF, jeu inventé');
    // Est : deux ventes seulement, retenues ; aucun de leurs prix n'apparaît, ni sur la page de la commune ni sur la sienne.
    const est = await (await t.get(`${NET}/prix/ville-test/est`))!.text();
    for (const page of [html, est]) for (const p of ['3111', '3 111', '3222', '3 222', '3 111', '3 222']) expect(page).not.toContain(p);
    expect(est).toContain('Pas assez de ventes');
    expect((await t.get(`${CAMILLE}/prix/ville-test`))!.status).toBe(404);
    expect((await t.get(`${NET}/prix/inconnue`))!.status).toBe(404);
    expect((await t.get(`${NET}/prix/ville-test`, 'POST'))!.status).toBe(405);
    const head = (await t.get(`${NET}/prix/ville-test`, 'HEAD'))!;
    expect([head.status, await head.text()]).toEqual([200, '']);
  });

  it('[R152] [R155] [R157] page d’agent avec ses mentions, quartier seulement validé, simulateur sans collecte', async () => {
    const t = await setup();
    await preparedNetwork(t);
    for (const host of [NET, CAMILLE]) {
      const res = (await t.get(`${host}/agents/ag-1`))!;
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('123 456 789');
      expect(html).toContain('CPI 9999 0000 000 000 001');
    }
    // Lou n'a pas ses mentions : pas de page ; le site de Camille ne montre pas Lou ; l'agent d'un autre réseau n'existe pas ici.
    expect((await t.get(`${NET}/agents/ag-2`))!.status).toBe(404);
    expect((await t.get(`${CAMILLE}/agents/ag-2`))!.status).toBe(404);
    expect((await t.get(`${NET}/agents/ag-9`))!.status).toBe(404);
    // Un quartier sans texte validé : rien n'est servi.
    expect((await t.get(`${NET}/quartiers/ville-test/ouest`))!.status).toBe(404);
    expect((await t.get(`${NET}/quartiers/ville-test/ouest/prix`))!.status).toBe(404);
    const sim = (await t.get(`${CAMILLE}/simulateur`))!;
    expect(sim.status).toBe(200);
    expect(sim.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(await sim.text()).toContain('ce n’est pas une offre de prêt');
    // Un chemin qui n'est pas de M01 : la suite du Worker le cherche ailleurs.
    expect(await t.get(`${NET}/biens/b1`)).toBeNull();
    expect(await t.get(`${NET}/agents/ag-1/autre`)).toBeNull();
  });

  it('[R16] AT13 : la liste des quartiers et leurs faits, à la direction de ce réseau seule, un quartier retiré n’y est plus', async () => {
    const t = await setup();
    await preparedNetwork(t);
    // Un quartier retiré puis redéfini : la liste ne montre que sa nouvelle définition.
    const old = await t.db.first<{ id: string; parent_id: string }>("SELECT id, parent_id FROM price_zones WHERE slug = 'ouest'");
    expect((await t.call(direction, 'POST', `/attirer/prix/zones/${old!.id}/retrait`)).status).toBe(200);
    expect((await t.call(direction, 'POST', '/attirer/prix/zones', { level: 'quartier', parentId: old!.parent_id, slug: 'ouest', name: 'ouest', ring: WEST, ringSource: 'Contour refait' })).status).toBe(200);
    const list = await t.call(direction, 'GET', '/attirer/quartiers');
    expect(list.status).toBe(200);
    const items = list.body.data as { zoneId: string; name: string; communeName: string }[];
    expect(items.map((z) => z.name)).toEqual(['est', 'ouest']);
    const ouest = items[1]!;
    expect(ouest.communeName).toBeTruthy();
    expect(ouest.zoneId).not.toBe(old!.id);
    expect((await t.call(camille, 'GET', '/attirer/quartiers')).status).toBe(403);
    expect((await t.call(camille, 'GET', `/attirer/quartiers/${ouest.zoneId}/faits`)).status).toBe(403);
    expect(await t.call({ ...direction, networkId: 'net-2' }, 'GET', '/attirer/quartiers')).toMatchObject({ status: 200, body: { data: [] } });
    expect((await t.call({ ...direction, networkId: 'net-2' }, 'GET', `/attirer/quartiers/${ouest.zoneId}/faits`)).status).toBe(400);
    expect((await t.call(direction, 'POST', `/attirer/quartiers/${ouest.zoneId}/faits`, { key: 'tram', kind: 'transport', label: 'Arrêts de tram', value: 2, unit: 'nombre', source: 'Carte inventée', sourceDate: '2026-01-15' })).status).toBe(200);
    expect((await t.call(direction, 'GET', `/attirer/quartiers/${ouest.zoneId}/faits`)).body.data).toMatchObject([{ key: 'tram', value: 2, source: 'Carte inventée' }]);
    expect((await t.call(direction, 'POST', `/attirer/quartiers/${ouest.zoneId}/faits`, { key: 'tram', kind: 'transport', label: 'Arrêts de tram', value: 2, unit: 'nombre', source: 'Carte inventée', sourceDate: '2026-01-15', retired: true })).status).toBe(200);
    expect((await t.call(direction, 'GET', `/attirer/quartiers/${ouest.zoneId}/faits`)).body.data).toEqual([]);
  });

  it('[R16] AT15 : les zones du réseau, sans contour, à la direction de ce réseau seule ; une zone retirée n’y est plus', async () => {
    const t = await setup();
    await preparedNetwork(t);
    const res = await t.call(direction, 'GET', '/attirer/prix/zones');
    expect(res.status).toBe(200);
    const items = res.body.data as { id: string; level: string; parentId: string | null; name: string; ring_json?: unknown }[];
    expect(items.filter((z) => z.level === 'quartier').map((z) => z.name)).toEqual(['est', 'ouest']);
    expect(items.filter((z) => z.level === 'commune')).toHaveLength(1);
    for (const z of items) expect(Object.keys(z).sort()).toEqual(['id', 'level', 'name', 'parentId']);
    expect((await t.call(camille, 'GET', '/attirer/prix/zones')).status).toBe(403);
    expect(await t.call({ ...direction, networkId: 'net-2' }, 'GET', '/attirer/prix/zones')).toMatchObject({ status: 200, body: { data: [] } });
    const ouest = items.find((z) => z.name === 'ouest')!;
    expect((await t.call(direction, 'POST', `/attirer/prix/zones/${ouest.id}/retrait`)).status).toBe(200);
    const after = (await t.call(direction, 'GET', '/attirer/prix/zones')).body.data as { name: string }[];
    expect(after.map((z) => z.name)).not.toContain('ouest');
    // Une commune retirée emporte ses quartiers.
    const commune = items.find((z) => z.level === 'commune')!;
    expect((await t.call(direction, 'POST', `/attirer/prix/zones/${commune.id}/retrait`)).status).toBe(200);
    expect((await t.call(direction, 'GET', '/attirer/prix/zones')).body.data).toEqual([]);
  });

  it('[R16] [R150] BR97 : les zones à refaire, par nom, niveau et raison, à la direction de ce réseau seule ; retirée, elle en sort', async () => {
    const t = await setup();
    await preparedNetwork(t);
    expect(await t.call(direction, 'GET', '/attirer/prix/zones/a-refaire')).toMatchObject({ status: 200, body: { data: [] } });
    const items = (await t.call(direction, 'GET', '/attirer/prix/zones')).body.data as { id: string; level: string }[];
    const communeId = items.find((z) => z.level === 'commune')!.id;
    // Un quartier rangé avant le contrôle des contours : un nœud papillon, écrit directement en base.
    await t.db.run(
      'INSERT INTO price_zones (id, network_id, level, parent_id, slug, label, insee_code, ring_json, ring_source, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['zone-noeud', 'net-1', 'quartier', communeId, 'noeud', 'Nœud', null, JSON.stringify([[47, 5], [47.1, 5.1], [47, 5.1], [47.1, 5]]), 'Contour ancien', 'direction:dir-1', '2026-09-01T08:00:00.000Z'],
    );
    const res = await t.call(direction, 'GET', '/attirer/prix/zones/a-refaire');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'zone-noeud', level: 'quartier', parentId: communeId, name: 'Nœud', reason: 'contour_croise' }]);
    expect(JSON.stringify(res.body)).not.toMatch(/ring|47\.1/);
    expect((await t.call(camille, 'GET', '/attirer/prix/zones/a-refaire')).status).toBe(403);
    const refused = (await t.db.first<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse' ORDER BY seq DESC LIMIT 1"))!;
    expect(JSON.parse(refused.data)).toMatchObject({ rule: 'R16' });
    expect(await t.call({ ...direction, networkId: 'net-2' }, 'GET', '/attirer/prix/zones/a-refaire')).toMatchObject({ status: 200, body: { data: [] } });
    expect((await t.call(direction, 'POST', '/attirer/prix/zones/zone-noeud/retrait')).status).toBe(200);
    expect(await t.call(direction, 'GET', '/attirer/prix/zones/a-refaire')).toMatchObject({ status: 200, body: { data: [] } });
  });

  it('[R152] [R153] AT16 : la lecture des agents dit comme la page ce qui manque ; un site hors service reste lisible et se rétablit', async () => {
    const t = await setup();
    await preparedNetwork(t);
    expect((await t.call(camille, 'GET', '/attirer/agents')).status).toBe(403);
    const other = (await t.call({ ...direction, networkId: 'net-2' }, 'GET', '/attirer/agents')).body.data as { holder: unknown; cardNumber: unknown; agents: { agentId: string }[] };
    expect(other).toMatchObject({ holder: null, cardNumber: null });
    expect(other.agents.map((a) => a.agentId)).not.toContain('ag-1');
    const read = async () => (await t.call(direction, 'GET', '/attirer/agents')).body.data as { holder: string; agents: { agentId: string; missing: string | null; rsacRegistry: string | null; site: { baseUrl: string; active: boolean } | null }[] };
    const first = await read();
    expect(first.holder).toBe('Société Exemple');
    // Ce que dit la liste est ce que dit la page de chaque agent, sur les mêmes données.
    for (const a of first.agents) {
      const page = (await t.call(direction, 'GET', `/attirer/agents/${a.agentId}/page`)).body.data as { publishable: boolean; missing: string | null };
      expect(a.missing).toBe(page.missing);
    }
    const cam = first.agents.find((a) => a.agentId === 'ag-1')!;
    expect(cam).toMatchObject({ missing: null, rsacRegistry: 'Dijon', site: { baseUrl: CAMILLE, active: true } });
    expect(first.agents.find((a) => a.agentId === 'ag-2')).toMatchObject({ missing: 'statut_manquant', site: null });
    // Hors service : le site disparaît des sites en service, reste lisible ici, et se rétablit avec le même corps.
    expect((await t.call(direction, 'POST', '/attirer/sites', { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: false })).status).toBe(200);
    expect(((await read()).agents.find((a) => a.agentId === 'ag-1'))!.site).toEqual({ baseUrl: CAMILLE, active: false });
    expect((await t.call(direction, 'POST', '/attirer/sites', { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: true })).status).toBe(200);
    expect(((await read()).agents.find((a) => a.agentId === 'ag-1'))!.site).toEqual({ baseUrl: CAMILLE, active: true });
    // Un agent parti : la route le dit sans le code qui ferait passer la clé de la direction pour refusée.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = 'ag-1'");
    expect((await t.call(direction, 'POST', '/attirer/sites', { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: true })).body).toMatchObject({ code: 'agent_parti' });
    expect((await read()).agents.map((a) => a.agentId)).not.toContain('ag-1');
  });

  it('[R16] [R153] AT17 : une adresse gardée par un agent parti se lit et se libère, sans rien dire à un autre réseau', async () => {
    const t = await setup();
    await preparedNetwork(t);
    const kept = async (viewer = direction) => ((await t.call(viewer, 'GET', '/attirer/agents')).body.data as { departed: { agentId: string; name: string; baseUrl: string }[] }).departed;
    const net2 = { ...direction, networkId: 'net-2' };
    const site = (baseUrl: string, agentId = 'ag-2') => ({ kind: 'agent', agentId, baseUrl, active: true });
    // Tant que l'agent est en activité, rien n'est listé, et le refus reste le refus ordinaire.
    expect(await kept()).toEqual([]);
    expect((await t.call(direction, 'POST', '/attirer/sites', site(CAMILLE))).body).toMatchObject({ rule: 'R153', code: 'url_taken' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = 'ag-1'");
    const listed = await kept();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ agentId: 'ag-1', baseUrl: CAMILLE });
    expect(listed[0]!.name.length).toBeGreaterThan(0);
    // Le lecteur d'un autre réseau ne lit rien de cet agent, et son refus ne dit pas à qui est l'adresse.
    expect(await kept(net2)).toEqual([]);
    expect((await t.call(net2, 'POST', '/attirer/sites', { kind: 'reseau', baseUrl: CAMILLE, active: true })).body).toEqual({ ok: false, rule: 'R153', code: 'url_taken' });
    // Un agent n'y a pas accès.
    expect((await t.call(camille, 'GET', '/attirer/agents')).status).toBe(403);
    // Dans le réseau, le refus dit la cause ; le site du réseau aussi.
    expect((await t.call(direction, 'POST', '/attirer/sites', site(CAMILLE))).body).toMatchObject({ rule: 'R153', code: 'url_agent_parti' });
    expect((await t.call(direction, 'POST', '/attirer/sites', { kind: 'reseau', baseUrl: CAMILLE, active: true })).body).toMatchObject({ rule: 'R153', code: 'url_agent_parti' });
    // Libérée : plus listée, et un autre site la prend.
    expect((await t.call(direction, 'POST', '/attirer/sites', { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: false })).status).toBe(200);
    expect(await kept()).toEqual([]);
    expect((await t.call(direction, 'POST', '/attirer/sites', site(CAMILLE))).status).toBe(200);
    // L'adresse prise, l'agent revenu ne la reprend pas : une seule page de référence.
    await t.db.run("UPDATE agents SET status = 'active' WHERE id = 'ag-1'");
    expect((await t.call(direction, 'POST', '/attirer/sites', site(CAMILLE, 'ag-1'))).body).toMatchObject({ rule: 'R153', code: 'url_taken' });
  });

  it('[R152] AT16 : à chaque étape, la liste dit ce que dit la page ; la dernière valeur l’emporte, même à la même date', async () => {
    const t = await setup();
    const row = async () => ((await t.call(direction, 'GET', '/attirer/agents')).body.data as { agents: { agentId: string; missing: string | null; rsacNumber: string | null; rsacRegistry: string | null; site: unknown }[] }).agents.find((a) => a.agentId === 'ag-1')!;
    const same = async (expected: string | null) => {
      const page = (await t.call(direction, 'GET', '/attirer/agents/ag-1/page')).body.data as { missing: string | null };
      expect(page.missing).toBe(expected);
      expect((await row()).missing).toBe(expected);
    };
    await same('statut_manquant');
    expect((await t.call(direction, 'POST', '/attirer/agents/ag-1/mentions', { rsacNumber: 'RSAC 123456789', rsacRegistry: 'Dijon' })).status).toBe(200);
    await same('carte_manquante');
    await t.db.run("INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES ('s1', 'net-1', 'CPI 9999', 'direction:dir-1', 'y')");
    await same('titulaire_manquant');
    expect((await t.call(direction, 'POST', '/attirer/titulaire', { holder: 'Société Exemple' })).status).toBe(200);
    await same(null);
    // Deux immatriculations à la même date : la dernière rangée, comme la page.
    for (const [id, registry] of [['m1', 'Greffe Un'], ['m2', 'Greffe Deux']] as const) {
      await t.db.run("INSERT INTO agent_legal_mentions (id, agent_id, network_id, legal_status, rsac_number, rsac_registry, set_by, set_at) VALUES (?, 'ag-1', 'net-1', 'agent_commercial', '111 222 333', ?, 'direction:dir-1', '2099-01-01T00:00:00.000Z')", [id, registry]);
    }
    expect(await row()).toMatchObject({ rsacRegistry: 'Greffe Deux', rsacNumber: '111 222 333' });
    // Relu puis renvoyé tel quel : il passe.
    const read = await row();
    expect((await t.call(direction, 'POST', '/attirer/agents/ag-1/mentions', { rsacNumber: read.rsacNumber, rsacRegistry: read.rsacRegistry })).status).toBe(200);
    // Deux réglages du site à la même date : le dernier rangé.
    for (const [id, active] of [['p1', 1], ['p2', 0]] as const) {
      await t.db.run("INSERT INTO public_sites (id, network_id, kind, agent_id, base_url, active, set_by, set_at) VALUES (?, 'net-1', 'agent', 'ag-1', ?, ?, 'direction:dir-1', '2099-01-01T00:00:00.000Z')", [id, CAMILLE, active]);
    }
    expect((await row()).site).toEqual({ baseUrl: CAMILLE, active: false });
  });

  it('[R150] AT15 : une zone retirée quitte le site aussitôt, sans recalcul, même la dernière commune', async () => {
    const t = await setup();
    expect((await t.call(direction, 'POST', '/attirer/sites', { kind: 'reseau', baseUrl: NET, active: true })).status).toBe(200);
    const plan = async () => (await (await t.get(`${NET}/sitemap.xml`))!.text());
    const commune = await t.call(direction, 'POST', '/attirer/prix/zones', { level: 'commune', slug: 'ville-test', name: 'Ville Test', inseeCode: '99001', ring: COMMUNE, ringSource: 'Contour inventé' });
    const parentId = commune.body.data.id as string;
    // Un seul quartier, aussi grand que sa commune : aucune différence n'y retrouve une vente, sa case se publie.
    const quartier = await t.call(direction, 'POST', '/attirer/prix/zones', { level: 'quartier', parentId, slug: 'ouest', name: 'Ouest', ring: COMMUNE, ringSource: 'Contour inventé' });
    const ouest = { id: quartier.body.data.id as string, parent_id: parentId };
    expect((await t.call(direction, 'POST', '/attirer/prix/recalcul')).body).toMatchObject({ ok: true, data: { ran: true } });
    expect((await t.get(`${NET}/prix/ville-test/ouest`))!.status).toBe(200);
    expect(await plan()).toContain('/prix/ville-test/ouest');
    expect((await t.call(direction, 'POST', `/attirer/prix/zones/${ouest.id}/retrait`)).status).toBe(200);
    expect((await t.get(`${NET}/prix/ville-test/ouest`))!.status).toBe(404);
    expect(await plan()).not.toContain('/prix/ville-test/ouest');
    expect((await t.get(`${NET}/prix/ville-test`))!.status).toBe(200);
    expect((await t.call(direction, 'POST', `/attirer/prix/zones/${ouest.parent_id}/retrait`)).status).toBe(200);
    expect((await t.get(`${NET}/prix/ville-test`))!.status).toBe(404);
    expect(await plan()).not.toContain('/prix/ville-test');
    expect((await t.call(direction, 'POST', '/attirer/prix/zones', { level: 'quartier', parentId: ouest.parent_id, slug: 'nord', name: 'Nord', ring: WEST, ringSource: 'Contour inventé' })).body).toMatchObject({ code: 'parent' });
  });

  it('[R150] AT15 : hors de France ou hors de sa commune, un contour est refusé ; 2 000 points passent par la route', async () => {
    const t = await setup();
    const inverted = COMMUNE.map(([lat, lon]) => [lon, lat]);
    const commune = (slug: string, ring: unknown) => ({ level: 'commune', slug, name: slug, inseeCode: '99001', ring, ringSource: 'Contour inventé' });
    expect((await t.call(direction, 'POST', '/attirer/prix/zones', commune('inversee', inverted))).body).toMatchObject({ code: 'hors_france' });
    const circle = Array.from({ length: 2000 }, (_, i) => {
      const a = (2 * Math.PI * i) / 2000;
      return [Math.round((47.123456 + 0.05 * Math.sin(a)) * 1e6) / 1e6, Math.round((5.123456 + 0.05 * Math.cos(a)) * 1e6) / 1e6];
    });
    const big = await t.call(direction, 'POST', '/attirer/prix/zones', commune('grande', circle));
    expect(big.status).toBe(200);
    const parentId = big.body.data.id as string;
    const far = [[43, 1], [43, 1.1], [43.1, 1.1]];
    expect((await t.call(direction, 'POST', '/attirer/prix/zones', { level: 'quartier', parentId, slug: 'loin', name: 'Loin', ring: far, ringSource: 'Contour inventé' })).body).toMatchObject({ code: 'hors_commune' });
    const near = [[47.09, 5.09], [47.09, 5.15], [47.15, 5.15]];
    expect((await t.call(direction, 'POST', '/attirer/prix/zones', { level: 'quartier', parentId, slug: 'pres', name: 'Pres', ring: near, ringSource: 'Contour inventé' })).status).toBe(200);
  });

  it('[R155] AT13 : un fait reste retirable même devenu refusable, un fait inconnu ne se retire pas ; un texte dit s’il est encore validable', async () => {
    const t = await setup();
    await preparedNetwork(t);
    const zone = await t.db.first<{ id: string }>("SELECT id FROM price_zones WHERE slug = 'ouest'");
    const faits = `/attirer/quartiers/${zone!.id}/faits`;
    expect((await t.call(direction, 'POST', faits, { key: 'parc', kind: 'parc', label: 'Parc Lemoine', source: 'Mairie inventée', sourceDate: '2026-01-15' })).status).toBe(200);
    const draft = await t.call(direction, 'POST', `/attirer/quartiers/${zone!.id}/brouillon`, { kind: 'page', topic: 'quartier' });
    expect(draft.status).toBe(200);
    const textes = `/attirer/quartiers/${zone!.id}/textes`;
    expect((await t.call(direction, 'GET', textes)).body.data[0]).toMatchObject({ current: true });
    // Un client du même nom entre dans la base : le fait ne se rangerait plus, mais il se retire.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO persons (id, network_id, first_name, last_name, created_at, updated_at) VALUES ('p-l', 'net-1', 'Inès', 'Lemoine', '2026-01-01', '2026-01-01')");
    expect((await t.call(direction, 'POST', faits, { key: 'parc2', kind: 'parc', label: 'Parc Lemoine', source: 'Mairie inventée', sourceDate: '2026-01-15' })).status).toBe(400);
    expect((await t.call(direction, 'POST', faits, { key: 'parc', retired: true })).status).toBe(200);
    expect((await t.call(direction, 'GET', faits)).body.data).toEqual([]);
    expect((await t.call(direction, 'POST', faits, { key: 'parc', retired: true })).body).toMatchObject({ code: 'inconnu' });
    expect((await t.call(camille, 'POST', faits, { key: 'parc', retired: true })).status).toBe(403);
    // Le fait retiré change les données du texte : la validation serait refusée, et la lecture le dit d'avance.
    const seen = (await t.call(direction, 'GET', textes)).body.data[0];
    expect(seen.current).toBe(false);
    expect((await t.call(direction, 'POST', `/attirer/quartiers/textes/${seen.draftId}/valider`)).body).toMatchObject({ code: 'donnees_changees' });
  });

  it('[R155] AT13 : ce que la direction relit est découpé comme ce que le site sert', async () => {
    const body = 'Une ligne\ncoupée.\n\n  Un second   paragraphe. ';
    expect(bodyParagraphs(body)).toEqual(['Une ligne coupée.', 'Un second paragraphe.']);
    const zone = { slug: 'ouest', name: 'Ouest', communeSlug: 'ville-test', communeName: 'Ville Test' };
    const page = renderNeighbourhoodPage({ draftId: 'd', kind: 'page', topic: 'quartier', title: 'Titre', body, zone, sources: [], validatedAt: '2026-01-01T00:00:00.000Z' }, { siteUrl: NET, estimateHref: '/estimation' } as never);
    if (!page.ok) throw new Error(page.code);
    for (const p of bodyParagraphs(body)) expect(page.html).toContain(`<p>${p}</p>`);
  });

  it('[R155] une page de quartier validée par la direction, par les routes, est servie sur le site du réseau seulement', async () => {
    const t = await setup();
    await preparedNetwork(t);
    const zone = await t.db.first<{ id: string }>("SELECT id FROM price_zones WHERE slug = 'ouest'");
    expect((await t.call(direction, 'POST', `/attirer/quartiers/${zone!.id}/faits`, { key: 'tram', kind: 'transport', label: 'Arrêts de tram', value: 2, unit: 'nombre', source: 'Carte des transports, jeu inventé', sourceDate: '2026-09-01' })).status).toBe(200);
    expect((await t.call(camille, 'POST', `/attirer/quartiers/${zone!.id}/brouillon`, { kind: 'page', topic: 'quartier' })).status).toBe(403);
    const draft = await t.call(direction, 'POST', `/attirer/quartiers/${zone!.id}/brouillon`, { kind: 'page', topic: 'quartier' });
    expect(draft.status).toBe(200);
    const draftId = draft.body.data.draftId;
    expect((await t.get(`${NET}/quartiers/ville-test/ouest`))!.status).toBe(404);
    expect(await t.call(direction, 'POST', `/attirer/quartiers/textes/${draftId}/valider`)).toMatchObject({ status: 200 });
    const res = (await t.get(`${NET}/quartiers/ville-test/ouest`))!;
    expect(res.status).toBe(200);
    expect(htmlProblems(await res.text())).toEqual([]);
    expect((await t.get(`${CAMILLE}/quartiers/ville-test/ouest`))!.status).toBe(404);
    expect((await t.call(direction, 'GET', `/attirer/quartiers/${zone!.id}/textes`)).body.data).toHaveLength(1);
  });

  it('[R07] [R16] AU012 : la direction règle le titre écrit à côté du nom des agents, dans une liste fermée', async () => {
    const t = await setup();
    expect((await t.call(direction, 'GET', '/attirer/titre-agent')).body).toMatchObject({ ok: true, data: { setting: null, shown: 'agent immobilier' } });
    expect((await t.call(direction, 'POST', '/attirer/titre-agent', { title: 'mandataire immobilier' })).body).toMatchObject({ ok: false, rule: 'R07', code: 'titre_hors_liste' });
    expect((await t.call(camille, 'POST', '/attirer/titre-agent', { title: 'conseiller immobilier' })).status).toBe(403);
    expect((await t.call(direction, 'POST', '/attirer/titre-agent', { title: 'agent commercial en immobilier' })).status).toBe(200);
    expect((await t.call(direction, 'GET', '/attirer/titre-agent')).body).toMatchObject({ ok: true, data: { setting: 'agent commercial en immobilier', shown: 'agent commercial en immobilier' } });
  });
});
