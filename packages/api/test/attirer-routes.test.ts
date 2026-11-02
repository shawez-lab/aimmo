import { expect, it } from 'vitest';
import { ROLES, SqlJournalStore, applyMigrations, fromSyncSqlite, type Role, type SqlDatabase, type Viewer } from '@aimmo/core';
import type { PriceSalesSource } from '../../core/src/attirer/index.ts';
import type { EstimatedKind, Sale } from '../../core/src/estimation/fourchette.ts';
import { attirerRoutes, handleAttirerPublic, listingReference, type AttirerServices } from '../src/attirer.ts';
import { htmlProblems } from '../../core/src/design/audit.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
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
  const s: AttirerServices = { db, journal, now, priceSales };
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
    const reel = await handleAttirerPublic({ ...t.s, mode: 'reel' }, new Request(`${NET}/robots.txt`));
    expect(await reel!.text()).toContain('Allow: /');
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
});
