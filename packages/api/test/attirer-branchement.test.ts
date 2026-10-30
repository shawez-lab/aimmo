import { expect, it } from 'vitest';
import { FicheClient, ROLES } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { attirerRoutes } from '../src/attirer.ts';
import { sha256Hex } from '../src/index.ts';
import { runListingSync } from '../src/vitrine.ts';
import { DELAY_END, MIN, setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, bien, sites et clés inventés.
const API = 'https://aimmo-api.example.test';
const NET = 'https://reseau-at11.example.test';
const ALEX_SITE = 'https://alex-at11.example.test';
const SAM_SITE = 'https://sam-at11.example.test';
const OTHER = 'https://autre-reseau-at11.example.test';
const KEYS = {
  alex: 'test-cle-at11-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-at11-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-at11-dir-cccccccccccccccccccccccccccccc',
  autre: 'test-cle-at11-autre-ddddddddddddddddddddddddddd',
  compliance: 'test-cle-at11-conf-eeeeeeeeeeeeeeeeeeeeeeeeeeee',
  partenaire: 'test-cle-at11-part-ffffffffffffffffffffffffffff',
};
type Who = keyof typeof KEYS;

async function setup() {
  const t = await setupAnnonce();
  const other = (await new FicheClient(t.db).createNetwork('Autre réseau')).id;
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    sam: { role: 'agent', userId: t.sam.userId, networkId: t.network.id },
    direction: { role: 'direction', userId: 'dir-1', networkId: t.network.id },
    autre: { role: 'direction', userId: 'dir-9', networkId: other },
    compliance: { role: 'compliance', userId: 'c-1', networkId: t.network.id },
    partenaire: { role: 'partner', userId: 'p-1', networkId: t.network.id },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const call = async (who: Who | null, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const headers: Record<string, string> = { ...(who ? { authorization: `Bearer ${KEYS[who]}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
    const res = await handleRequest(new Request(`${API}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.startsWith('application/json') ? ((await res.json()) as any) : null };
  };
  const page = (url: string, method = 'GET', cfg: ApiConfig = config) => handleRequest(new Request(url, { method }), cfg);
  const publish = async () => {
    const v = await t.annonces.validate(t.agent, t.draftId);
    if (!v.ok) throw new Error(v.code);
    t.setClock(new Date(DELAY_END.getTime() + 5 * MIN));
    await runListingSync(t.db, t.now);
  };
  return { ...t, other, config, call, page, publish };
}

describeWithSqlite('AT11 · branchement des routes de M01 dans le socle', () => {
  it('[R16] chaque route /v1/attirer répond sous son rôle, derrière la clé ; un autre rôle est refusé au journal', async () => {
    const t = await setup();
    expect(await t.call('direction', 'GET', '/attirer/sites')).toEqual({ status: 200, body: { ok: true, mode: 'essai', data: [] } });
    expect((await t.call(null, 'GET', '/attirer/sites')).status).toBe(401);
    // Hors mode essai, l'API reste fermée.
    expect((await handleRequest(new Request(`${API}/v1/attirer/sites`, { headers: { authorization: `Bearer ${KEYS.direction}` } }), { ...t.config, mode: 'production' })).status).toBe(503);
    // Chaque route, par le socle, pour chaque rôle qu'elle n'admet pas : 403 avant toute lecture du corps.
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    const byRole: Record<string, Who> = { agent: 'alex', compliance: 'compliance', partner: 'partenaire', direction: 'direction' };
    let refused = 0;
    for (const r of attirerRoutes()) {
      const path = r.pattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\([^)]*\)/g, (g) => (g.includes('\\d{4}') ? '2026-10' : 'x1')).replace(/\\\//g, '/');
      for (const role of ROLES) {
        const who = byRole[role];
        if (!who || r.roles.includes(role)) continue;
        const res = await handleRequest(
          new Request(`${API}/v1${path}`, { method: r.method, headers: { authorization: `Bearer ${KEYS[who]}`, ...(r.method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(r.method === 'POST' ? { body: '{' } : {}) }),
          t.config,
        );
        expect(res.status, `${r.name} ${role}`).toBe(403);
        expect(await res.json()).toEqual({ ok: false, rule: 'R16', code: 'role' });
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(attirerRoutes().length);
    const kinds = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').slice(before).map((e) => String(e.data.kind));
    expect(kinds).toHaveLength(refused);
    expect(kinds.every((k) => k.startsWith('route.attirer.'))).toBe(true);
    // Une adresse inconnue sous /attirer, une méthode non admise.
    expect((await t.call('direction', 'GET', '/attirer/inconnue')).status).toBe(404);
    expect((await t.call('direction', 'POST', '/attirer/sites/x1/plan')).status).toBe(405);
  });

  it('[R16] la portée : un agent ne voit que sa page, un réseau que ses sites ; un agent parti ne lit plus rien', async () => {
    const t = await setup();
    expect((await t.call('direction', 'POST', '/attirer/sites', { kind: 'reseau', baseUrl: NET, active: true })).status).toBe(200);
    expect((await t.call('alex', 'GET', `/attirer/agents/${t.alexId}/page`)).status).toBe(200);
    expect(await t.call('alex', 'GET', `/attirer/agents/${t.sam.userId}/page`)).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.call('autre', 'GET', '/attirer/sites')).toEqual({ status: 200, body: { ok: true, mode: 'essai', data: [] } });
    expect((await t.call('direction', 'GET', '/attirer/sites')).body.data).toHaveLength(1);
    // Sans ventes publiques branchées (estimation en ligne absente), aucun recalcul des prix.
    expect(await t.call('direction', 'POST', '/attirer/prix/recalcul')).toMatchObject({ status: 400, body: { code: 'source_absente' } });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect(await t.call('alex', 'GET', `/attirer/agents/${t.alexId}/page`)).toMatchObject({ status: 403, body: { code: 'agent_inactive' } });
  });

  it('[R153] parcours d’un bien test sur les deux sites : une seule page de référence, le site d’un autre agent ne le montre pas', async () => {
    const t = await setup();
    for (const site of [
      { kind: 'reseau', baseUrl: NET, active: true },
      { kind: 'agent', agentId: t.alexId, baseUrl: ALEX_SITE, active: true },
      { kind: 'agent', agentId: t.sam.userId, baseUrl: SAM_SITE, active: true },
    ]) {
      expect((await t.call('direction', 'POST', '/attirer/sites', site)).status).toBe(200);
    }
    expect((await t.call('autre', 'POST', '/attirer/sites', { kind: 'reseau', baseUrl: OTHER, active: true })).status).toBe(200);
    await t.publish();
    const canonical = `${ALEX_SITE}/biens/${t.propertyId}`;
    // Le bien est dans les deux plans, toujours sous la même adresse.
    for (const host of [NET, ALEX_SITE]) {
      const plan = await t.page(`${host}/sitemap.xml`);
      expect(plan.status).toBe(200);
      const xml = await plan.text();
      expect(xml).toContain(`<loc>${canonical}</loc>`);
      expect(xml).not.toContain(`<loc>${NET}/biens/`);
    }
    // La page du bien, sur l'un ou l'autre site : la même page de référence, en en-tête et dans la page.
    for (const host of [NET, ALEX_SITE]) {
      const res = await t.page(`${host}/biens/${t.propertyId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('link')).toBe(`<${canonical}>; rel="canonical"`);
      const html = await res.text();
      expect(html).toContain(`<link rel="canonical" href="${canonical}">`);
      const ld = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(html);
      expect(JSON.parse(ld![1]!)).toMatchObject({ '@type': 'RealEstateListing', url: canonical });
      // Aucune adresse dans les données structurées [R46].
      expect(ld![1]).not.toMatch(/\b21000\b|rue|avenue/i);
      expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    }
    // Le site de Sam ne sert ni la page ni la fiche du bien d'Alex ; le site d'un autre réseau non plus.
    for (const host of [SAM_SITE, OTHER]) {
      expect((await t.page(`${host}/biens/${t.propertyId}`)).status).toBe(404);
      expect((await t.page(`${host}/biens/${t.propertyId}/fiche`)).status).toBe(404);
    }
    // La fiche imprimable ne se donne pas pour la page de référence.
    const fiche = await t.page(`${ALEX_SITE}/biens/${t.propertyId}/fiche`);
    expect(fiche.status).toBe(200);
    expect(fiche.headers.get('link')).toBeNull();
    // Servie à l'adresse de l'API, qui n'est pas un site : la page, sans référence.
    const api = await t.page(`${API}/biens/${t.propertyId}`);
    expect(api.status).toBe(200);
    expect(api.headers.get('link')).toBeNull();
    expect(await api.text()).not.toContain('rel="canonical"');
    // robots.txt du site de l'agent déclare son propre plan ; en essai, rien n'est indexé.
    const robots = await t.page(`${ALEX_SITE}/robots.txt`);
    expect(robots.status).toBe(200);
    const txt = await robots.text();
    expect(txt).toContain(`Sitemap: ${ALEX_SITE}/sitemap.xml`);
    expect(txt).toContain('Disallow: /');
    // Le site d'Alex fermé : la page de référence revient au site du réseau.
    expect((await t.call('direction', 'POST', '/attirer/sites', { kind: 'agent', agentId: t.alexId, baseUrl: ALEX_SITE, active: false })).status).toBe(200);
    expect((await t.page(`${NET}/biens/${t.propertyId}`)).headers.get('link')).toBe(`<${NET}/biens/${t.propertyId}>; rel="canonical"`);
    expect((await t.page(`${ALEX_SITE}/robots.txt`)).status).toBe(404);
  });

  it('[R153] [R16] le site d’un autre agent ne sert jamais le bien, même vendu ou retiré, ni ses photos', async () => {
    const t = await setup();
    const stored = new Map<string, string>();
    const config: ApiConfig = { ...t.config, media: { get: async (key) => (stored.has(key) ? { body: stored.get(key)! } : null) } };
    for (const site of [
      { kind: 'agent', agentId: t.alexId, baseUrl: ALEX_SITE, active: true },
      { kind: 'agent', agentId: t.sam.userId, baseUrl: SAM_SITE, active: true },
    ]) {
      expect((await t.call('direction', 'POST', '/attirer/sites', site)).status).toBe(200);
    }
    const photo = `biens/${t.propertyId}/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg`;
    stored.set(photo, 'photo-1');
    await t.publish();
    expect((await t.page(`${ALEX_SITE}/medias/${photo}`, 'GET', config)).status).toBe(200);
    expect((await t.page(`${SAM_SITE}/medias/${photo}`, 'GET', config)).status).toBe(404);
    // Une nouvelle version, vendue puis retirée : le site de Sam ne sert toujours rien de ce bien.
    for (const [seq, state] of [
      [2, 'vendu'],
      [3, 'retiree'],
    ] as const) {
      await t.db.run(
        `INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at)
         SELECT ?, property_id, network_id, ?, ?, ${state === 'retiree' ? 'NULL' : 'draft_id'}, ${state === 'retiree' ? 'NULL' : 'price_eur'}, json_set(payload, '$.state', ?), payload_hash, 'test', created_at
           FROM listing_versions WHERE property_id = ? AND seq = 1`,
        [`v-at11-${seq}`, seq, state, state, t.propertyId],
      );
      for (const path of [`/biens/${t.propertyId}`, `/biens/${t.propertyId}/fiche`]) {
        expect((await t.page(`${SAM_SITE}${path}`)).status, `${state} ${path}`).toBe(404);
      }
      // Sur le site d'Alex, la vitrine décide seule, sans page de référence : un bien vendu ou retiré n'en a pas.
      expect((await t.page(`${ALEX_SITE}/biens/${t.propertyId}`)).headers.get('link')).toBeNull();
    }
  });

  it('les pages publiques de M01 passent par le socle : sites reconnus seulement, mode essai seulement, rien d’autre n’est touché', async () => {
    const t = await setup();
    expect((await t.call('direction', 'POST', '/attirer/sites', { kind: 'reseau', baseUrl: NET, active: true })).status).toBe(200);
    expect((await t.call('direction', 'POST', `/attirer/agents/${t.alexId}/mentions`, { rsacNumber: 'RSAC 123456789', rsacRegistry: 'Dijon' })).status).toBe(200);
    const sim = await t.page(`${NET}/simulateur`);
    expect(sim.status).toBe(200);
    expect(sim.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect((await t.page(`${NET}/prix/inconnue`)).status).toBe(404);
    expect((await t.page(`${NET}/simulateur`, 'POST')).status).toBe(405);
    // Une adresse qui n'est pas un site : 404, sans rien dire de plus.
    expect((await t.page('https://imitation-at11.example.test/simulateur')).status).toBe(404);
    // Hors mode essai, rien n'est servi.
    expect((await t.page(`${NET}/simulateur`, 'GET', { ...t.config, mode: 'production' })).status).toBe(503);
    // Un chemin voisin qui n'est pas une page de M01 suit son chemin habituel.
    expect((await t.page(`${NET}/agents/${t.alexId}/autre`)).status).toBe(404);
    expect((await t.page(`${NET}/app/`)).status).toBe(200);
    // Une panne de la page va au journal, sans détail.
    await t.db.exec('DROP TABLE public_sites');
    expect((await t.page(`${NET}/simulateur`)).status).toBe(500);
    expect((await t.journal.all()).some((e) => e.type === 'api.erreur' && e.data.route === 'attirer.public')).toBe(true);
  });
});
