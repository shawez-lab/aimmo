import { expect, it } from 'vitest';
import { FicheClient } from '@aimmo/core';
import { latestListings, type PublishedListing } from '../../core/src/attirer/index.ts';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runListingSync } from '../src/vitrine.ts';
import { DELAY_END, MIN, setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, bien, sites et clés inventés.
const API = 'https://aimmo-api.example.test';
const NET = 'https://reseau-rs02.example.test';
const ALEX_SITE = 'https://alex-rs02.example.test';
const SAM_SITE = 'https://sam-rs02.example.test';
const OTHER = 'https://autre-rs02.example.test';
const KEYS = { direction: 'test-cle-rs02-dir-cccccccccccccccccccccccccccccc', autre: 'test-cle-rs02-autre-ddddddddddddddddddddddddddd' };

async function setup(recruiting = true) {
  // Le statut de l'agent n'est rangé que par `mentions` : ce fichier vérifie le site avant et après (R152).
  const t = await setupAnnonce({ statut: false });
  const other = (await new FicheClient(t.db).createNetwork('Autre réseau')).id;
  const apiKeys = JSON.stringify([
    { sha256: await sha256Hex(KEYS.direction), role: 'direction', userId: 'dir-1', networkId: t.network.id },
    { sha256: await sha256Hex(KEYS.autre), role: 'direction', userId: 'dir-9', networkId: other },
  ]);
  const stored = new Map<string, string>();
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, candidatureNetworkId: recruiting ? t.network.id : undefined, media: { get: async (key) => (stored.has(key) ? { body: 'photo' } : null) } };
  const post = async (who: keyof typeof KEYS, path: string, body: unknown) => {
    const res = await handleRequest(new Request(`${API}/v1/attirer/${path}`, { method: 'POST', headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config);
    expect(res.status, path).toBe(200);
  };
  await post('direction', 'sites', { kind: 'reseau', baseUrl: NET, active: true });
  await post('direction', 'sites', { kind: 'agent', agentId: t.alexId, baseUrl: ALEX_SITE, active: true });
  await post('direction', 'sites', { kind: 'agent', agentId: t.sam.userId, baseUrl: SAM_SITE, active: true });
  await post('autre', 'sites', { kind: 'reseau', baseUrl: OTHER, active: true });
  const page = (url: string, method = 'GET') => handleRequest(new Request(url, { method }), config);
  const mentions = async () => {
    await post('direction', `agents/${t.alexId}/mentions`, { rsacNumber: 'RSAC 123456789', rsacRegistry: 'Dijon' });
    await post('direction', 'titulaire', { holder: 'Société Exemple' });
  };
  const publish = async () => {
    // Sans statut rangé, l'annonce ne se valide pas (AU007) [R43].
    await mentions();
    const v = await t.annonces.validate(t.agent, t.draftId);
    if (!v.ok) throw new Error(v.code);
    t.setClock(new Date(DELAY_END.getTime() + 5 * MIN));
    await runListingSync(t.db, t.now);
    const version = await t.db.first<{ payload: string }>('SELECT payload FROM listing_versions ORDER BY seq DESC LIMIT 1');
    for (const m of (JSON.parse(version!.payload) as { media: { ref: string }[] }).media) stored.set(m.ref, 'photo');
  };
  return { ...t, page, publish, mentions, post };
}

const hrefs = (html: string): string[] => [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));

describeWithSqlite('RS02 · l’accueil du site', () => {
  it('aucun lien vers une page absente : chaque lien de l’accueil, sur les deux sites, répond', async () => {
    const t = await setup();
    await t.publish();
    await t.mentions();
    for (const host of [NET, ALEX_SITE]) {
      const res = await t.page(`${host}/`);
      expect(res.status).toBe(200);
      const links = hrefs(await res.text());
      expect(links.length).toBeGreaterThan(3);
      expect(links).toContain('/biens');
      expect(links.some((l) => l.startsWith('/biens/'))).toBe(true);
      for (const link of links) expect((await t.page(`${host}${link}`)).status, `${host}${link}`).toBe(200);
    }
    // La page d'un agent et la liste mènent à l'accueil.
    expect(await (await t.page(`${NET}/biens`)).text()).toContain('href="/"');
    expect(await (await t.page(`${ALEX_SITE}/agents/${t.alexId}`)).text()).toContain('href="/"');
  });

  it('le recrutement et la preuve sont sur le site du réseau, jamais sur celui d’un agent', async () => {
    const t = await setup();
    const network = hrefs(await (await t.page(`${NET}/`)).text());
    expect(network).toEqual(expect.arrayContaining(['/biens', '/agents', '/prix', '/estimation', '/simulateur', '/preuve', '/rejoindre']));
    const own = hrefs(await (await t.page(`${SAM_SITE}/`)).text());
    expect(own).toEqual(expect.arrayContaining(['/biens', '/estimation', '/simulateur']));
    expect(own).not.toContain('/rejoindre');
    expect(own).not.toContain('/agents');
    expect(own).not.toContain('/prix');
    expect(own).not.toContain('/preuve');
  });

  it('sans candidatures ouvertes à ce réseau, l’accueil et le plan ne mènent pas à /rejoindre, qui répond 503', async () => {
    const t = await setup(false);
    expect((await t.page(`${NET}/rejoindre`)).status).toBe(503);
    expect(hrefs(await (await t.page(`${NET}/`)).text())).not.toContain('/rejoindre');
    expect(await (await t.page(`${NET}/sitemap.xml`)).text()).not.toContain('/rejoindre');
    const open = await setup();
    expect(await (await open.page(`${OTHER}/`)).text()).not.toContain('/rejoindre');
  });

  it('[R220] un mandat échu ou un bien vendu sort de l’accueil, sans passage de publication ; l’heure du contrôle est écrite ; une minute en cache', async () => {
    const t = await setup();
    await t.publish();
    const lien = `/biens/${t.propertyId}`;
    const res = await t.page(`${NET}/`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.text()).toContain(lien);
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    expect(await (await t.page(`${NET}/`)).text()).not.toContain(lien);
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.propertyId]);
    expect(await (await t.page(`${NET}/`)).text()).toContain(lien);
    t.setClock(new Date('2031-01-01T10:00:00.000Z'));
    const html = await (await t.page(`${NET}/`)).text();
    expect(html).not.toContain(lien);
    expect(html).toContain('Mandats vérifiés le 1 janvier 2031 à 11 h 00');
    expect(html).toContain('Aucun bien en vente en ce moment.');
  });

  it('[R220] la page d’un agent passe la même porte : mandat échu ou bien vendu, le bien en sort ; une minute en cache', async () => {
    const t = await setup();
    await t.publish();
    await t.mentions();
    const lien = `/biens/${t.propertyId}`;
    const page = `${ALEX_SITE}/agents/${t.alexId}`;
    const res = await t.page(page);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const before = await res.text();
    expect(before).toContain(lien);
    expect(before).toContain('Mandats vérifiés le');
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    expect(await (await t.page(page)).text()).not.toContain(lien);
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.propertyId]);
    expect(await (await t.page(page)).text()).toContain(lien);
    t.setClock(new Date('2031-01-01T10:00:00.000Z'));
    const after = await t.page(page);
    expect(after.status).toBe(200);
    expect(await after.text()).not.toContain(lien);
  });

  it('[R153] [R16] le site d’un agent ne montre que ses biens ; un autre réseau, rien', async () => {
    const t = await setup();
    await t.publish();
    const lien = `/biens/${t.propertyId}`;
    expect(await (await t.page(`${ALEX_SITE}/`)).text()).toContain(lien);
    expect(await (await t.page(`${SAM_SITE}/`)).text()).not.toContain(lien);
    expect(await (await t.page(`${OTHER}/`)).text()).not.toContain(lien);
  });

  it('[R152] le site d’un agent ne dit son nom qu’avec ses mentions, et ne mène à sa page que si elle est publiable', async () => {
    const t = await setup();
    const agent = await t.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ?', [t.alexId]);
    const name = `${agent!.first_name} ${agent!.last_name}`;
    const without = await (await t.page(`${ALEX_SITE}/`)).text();
    expect(without).not.toContain(name);
    expect(without).not.toContain(`/agents/${t.alexId}`);
    await t.mentions();
    const complete = await (await t.page(`${ALEX_SITE}/`)).text();
    expect(complete).toContain(name);
    expect(complete).toContain('123 456 789');
    expect(complete).toContain('Société Exemple');
    expect(complete).toContain(`/agents/${t.alexId}`);
  });

  it('hors d’un site en service : 404, comme une adresse inconnue ; seulement GET et HEAD ; rien d’indexé en essai', async () => {
    const t = await setup();
    expect((await t.page(`${API}/`)).status).toBe(404);
    expect((await t.page('https://inconnu-rs02.example.test/')).status).toBe(404);
    const res = await t.page(`${NET}/`);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const head = await t.page(`${NET}/`, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await t.page(`${NET}/`, 'POST')).status).toBe(405);
  });

  it('un site mis hors service, le site d’un agent parti : 404 sur l’accueil', async () => {
    const t = await setup();
    expect((await t.page(`${ALEX_SITE}/`)).status).toBe(200);
    await t.post('direction', 'sites', { kind: 'agent', agentId: t.alexId, baseUrl: ALEX_SITE, active: false });
    expect((await t.page(`${ALEX_SITE}/`)).status).toBe(404);
    expect((await t.page(`${SAM_SITE}/`)).status).toBe(200);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.sam.userId]);
    expect((await t.page(`${SAM_SITE}/`)).status).toBe(404);
    expect((await t.page(`${NET}/`)).status).toBe(200);
  });

  it('[R221] la page du bien mène aux pages légales sur un site ; ni sa fiche imprimable, ni l’adresse de l’API', async () => {
    const t = await setup();
    await t.publish();
    const lien = `/biens/${t.propertyId}`;
    expect(await (await t.page(`${NET}${lien}`)).text()).toContain('href="/mentions-legales"');
    expect(await (await t.page(`${ALEX_SITE}${lien}`)).text()).toContain('href="/donnees-personnelles"');
    expect(await (await t.page(`${NET}${lien}/fiche`)).text()).not.toContain('/mentions-legales');
    expect(await (await t.page(`${API}${lien}`)).text()).not.toContain('/mentions-legales');
  });

  it('[R153] chaque chemin de l’accueil est au plan du site, et l’accueil aussi', async () => {
    const t = await setup();
    await t.mentions();
    for (const host of [NET, ALEX_SITE]) {
      const plan = await (await t.page(`${host}/sitemap.xml`)).text();
      expect(plan).toContain(`<loc>${host}/</loc>`);
      for (const link of hrefs(await (await t.page(`${host}/`)).text())) expect(plan, link).toContain(`<loc>${host}${link}</loc>`);
    }
  });

  it('[R07] « agent immobilier », jamais « mandataire », ni « gratuit »', async () => {
    const t = await setup();
    await t.mentions();
    for (const host of [NET, ALEX_SITE, SAM_SITE]) {
      const html = await (await t.page(`${host}/`)).text();
      expect(html).toMatch(/agents? immobiliers?/);
      expect(html).not.toMatch(/mandataire|gratuit/i);
    }
  });

  it('BR45 · l’accueil et la liste des biens portent la recherche avec ses mots, sur les deux sites ; jamais au plan [R153]', async () => {
    const t = await setup();
    await t.publish();
    await t.mentions();
    for (const host of [NET, ALEX_SITE]) {
      for (const path of ['/', '/biens']) {
        const html = await (await t.page(`${host}${path}`)).text();
        const form = html.match(/<form class="chercher" method="get" action="([^"]+)" role="search">([\s\S]*?)<\/form>/);
        expect(form, `${host}${path}`).not.toBeNull();
        expect(form![1]).toBe('/chercher');
        expect(form![2]).toMatch(/<label for="chercher-q">[^<]+<\/label>/);
        expect(form![2]).toMatch(/<input id="chercher-q" name="q" type="search" maxlength="500" required/);
        // Le formulaire ouvre une page qui répond, avec la phrase envoyée.
        const sent = await t.page(`${host}/chercher?q=${encodeURIComponent('appartement à Dijon')}`);
        expect(sent.status).toBe(200);
      }
      const plan = await (await t.page(`${host}/sitemap.xml`)).text();
      expect(plan).not.toContain('/chercher');
      expect(hrefs(await (await t.page(`${host}/`)).text())).not.toContain('/chercher');
    }
  });
});

it('[R220] [R14] les derniers biens : du plus récent au plus ancien, un nombre borné de contrôles, même si la porte refuse tout', async () => {
  const listing = (id: string, day: string): PublishedListing => ({ propertyId: id, agentId: null, city: null, state: 'en_vente', versionId: id, title: id, priceEur: 1, day, mentions: 'm', photo: null, propertyStatus: 'available' });
  const published = Array.from({ length: 100 }, (_, i) => listing(`b${String(i).padStart(3, '0')}`, `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`));
  let checks = 0;
  const refuse = { canDiffuse: async () => ((checks += 1), { allowed: false }) };
  expect(await latestListings(published, refuse, 'n', new Date(0), 6)).toEqual([]);
  expect(checks).toBe(24);
  checks = 0;
  const open = { canDiffuse: async () => ((checks += 1), { allowed: true }) };
  const got = await latestListings(published, open, 'n', new Date(0), 6);
  expect(got).toHaveLength(6);
  expect(checks).toBe(6);
  // Trois biens du dernier jour, puis ceux du jour d'avant ; à jour égal, le même ordre pour tous.
  expect(got.map((l) => l.day)).toEqual(['2026-01-28', '2026-01-28', '2026-01-28', '2026-01-27', '2026-01-27', '2026-01-27']);
  expect(got[0]!.propertyId < got[1]!.propertyId).toBe(true);
});
