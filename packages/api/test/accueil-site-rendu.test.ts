import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { HOME_LEDE, HOME_LISTINGS, renderSiteHome, sitePaths, type SiteHomeInput } from '../../core/src/attirer/accueil-site.ts';
import { listingCard } from '../../core/src/attirer/liste-biens.ts';
import type { PublishedListing } from '../../core/src/attirer/referencement.ts';
import { BUDGETS, filledButtons, gzipSize, htmlProblems } from '../../core/src/design/audit.ts';

// DS071 · l'accueil d'un site du réseau. Tout est inventé : les biens, l'agent, ses mentions, les photos (un dessin).
const N = ' ';
const S = ' ';
const listing = (i: number, over: Partial<PublishedListing> = {}): PublishedListing => ({
  propertyId: `p${i}`,
  agentId: 'a1',
  city: 'Dijon',
  state: 'en_vente',
  versionId: `v${i}`,
  title: `Appartement ${i + 1} pièces à Dijon`,
  priceEur: 200000 + i * 10000,
  day: `2027-01-0${9 - i}`,
  mentions: `Prix : ${200 + i * 10}${S}000${N}€ honoraires inclus, à la charge du vendeur.\nClasse énergie D, classe climat B.`,
  photo: { ref: `biens/p${i}/0b6f1d2e-1111-4a2b-8c3d-00000000000${i}.jpg`, overlay: null },
  propertyStatus: 'available',
  ...over,
});
const LISTINGS = Array.from({ length: HOME_LISTINGS }, (_, i) => listing(i + 1));
const NETWORK: SiteHomeInput = { kind: 'reseau', recruiting: true, agent: null, listings: LISTINGS, checkedAt: new Date('2027-01-09T09:05:00Z') };
const OWN: SiteHomeInput = { kind: 'agent', recruiting: false, agent: { agentId: 'a1', name: 'Alex Exemple', mentions: { rsacNumber: '123 456 789', rsacRegistry: 'Dijon', cardNumber: 'CPI 0000 0000 000 000 000', cardHolder: 'Société Exemple' } }, listings: LISTINGS.slice(0, 2), checkedAt: NETWORK.checkedAt };
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, ' ');

describe('DS071 · l’accueil du site n’est plus une liste de liens', () => {
  it('une ouverture : le titre, ce que le site prouve, la recherche, puis l’estimation ; un seul bouton plein', () => {
    const html = renderSiteHome(NETWORK);
    const opening = /<section class="ouverture" aria-labelledby="titre">([\s\S]*?)<\/section>/.exec(html)![1]!;
    expect(opening).toMatch(/^<h1 id="titre">AIMMO, le réseau d’agents immobiliers<\/h1><p class="accroche">[^<]+<\/p><form class="chercher"/);
    expect(opening).toContain(`<p class="accroche">${HOME_LEDE.reseau}</p>`);
    expect(opening.endsWith('<p><a class="appel second" href="/estimation">Estimer mon logement</a></p>')).toBe(true);
    // « Chercher » est le geste plein ; « Estimer mon logement » est au trait.
    expect(filledButtons(html)).toEqual(['Chercher']);
    expect(html).toContain('.ouverture .second{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}');
    // L'ouverture vient avant les biens, les biens avant les pages du site.
    expect(html.indexOf('class="ouverture"')).toBeLessThan(html.indexOf('<h2>Les derniers biens</h2>'));
    expect(html.indexOf('<h2>Les derniers biens</h2>')).toBeLessThan(html.indexOf('<h2>Sur ce site</h2>'));
  });

  it('la phrase ne dit que ce que le site montre : chaque preuve a sa page, et le site d’un agent ne promet pas celles du réseau', () => {
    const network = sitePaths('reseau', false).map((p) => p.path);
    // Le réseau : les biens sous mandat, les prix des ventes conclues, le compte public.
    expect(HOME_LEDE.reseau).toMatch(/mandat vérifié.*ventes réellement conclues.*compte public/);
    expect(network).toEqual(expect.arrayContaining(['/biens', '/prix', '/preuve']));
    // Le site d'un agent n'a ni `/prix` ni `/preuve` : sa phrase n'en parle pas.
    const own = sitePaths('agent', false).map((p) => p.path);
    expect(own).not.toContain('/prix');
    expect(own).not.toContain('/preuve');
    expect(HOME_LEDE.agent).not.toMatch(/prix|compte/);
    expect(renderSiteHome(OWN)).toContain(`<p class="accroche">${HOME_LEDE.agent}</p>`);
    // Ni promesse chiffrée, ni superlatif, ni parenthèse ; les mots du réseau [R07].
    for (const lede of Object.values(HOME_LEDE)) expect(lede).not.toMatch(/[()0-9€%]|meilleur|premier|n°|garanti|gratuit|mandataire/i);
    for (const html of [renderSiteHome(NETWORK), renderSiteHome(OWN)]) expect(text(html)).not.toMatch(/mandataire|gratuit|intelligence artificielle|\bIA\b/i);
  });

  it('[R152] sur le site d’un agent, son nom ouvre la page avec ses mentions, avant la phrase et la recherche', () => {
    const html = renderSiteHome(OWN);
    const opening = /<section class="ouverture" aria-labelledby="titre">([\s\S]*?)<\/section>/.exec(html)![1]!;
    expect(opening).toMatch(/^<h1 id="titre">Alex Exemple, agent immobilier<\/h1><p class="statut doux">[^<]*123 456 789[^<]*<\/p><p class="accroche">/);
    // Sans mentions publiables, ni nom ni page : la phrase et la recherche restent.
    const bare = renderSiteHome({ ...OWN, agent: null });
    expect(bare).toContain('<h1 id="titre">Votre agent immobilier AIMMO</h1><p class="accroche">');
    expect(bare).not.toContain('Alex Exemple');
  });

  it('les pages du site sont des rangées entières à toucher : le nom et sa phrase dans le même lien', () => {
    const html = renderSiteHome(NETWORK);
    const rows = [.../<ul class="chemins">([\s\S]*?)<\/ul>/.exec(html)![1]!.matchAll(/<li><a href="([^"]+)"><strong>([^<]+)<\/strong><span>([^<]+)<\/span><\/a><\/li>/g)].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual(sitePaths('reseau', true).map((p) => [p.path, p.label, p.text]));
    expect(html).toContain('.chemins a{display:block;min-height:44px;');
    // Sur le site d'un agent, sa page vient en premier.
    expect(/<ul class="chemins"><li><a href="([^"]+)">/.exec(renderSiteHome(OWN))![1]).toBe('/agents/a1');
  });

  it('[R43, R48] la carte d’un bien : la photo d’abord, le titre, le prix, la commune, et toutes ses mentions ; sans photo, un aplat à sa place', () => {
    const card = listingCard(listing(1, { photo: { ref: 'biens/p1/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg', overlay: 'Aménagement virtuel' } }));
    expect(card).toMatch(/^<li><a href="\/biens\/p1"><img src="\/medias\/biens\/p1\/[^"]+" alt="Photo du bien, aménagement virtuel" loading="lazy" decoding="async"><span class="virtuel">Aménagement virtuel<\/span><strong>Appartement 2 pièces à Dijon<\/strong><span class="prix">210/);
    expect(card).toContain('<span class="doux">Dijon · En vente</span>');
    expect(card).toContain(`<small class="doux">Prix : 210${S}000${N}€ honoraires inclus, à la charge du vendeur.\nClasse énergie D, classe climat B.</small>`);
    const bare = listingCard(listing(2, { photo: null }));
    expect(bare).toMatch(/^<li><a href="\/biens\/p2"><span class="sans"><\/span><strong>/);
    // La grille reste alignée : l'aplat a la forme d'une photo ; le titre n'est plus souligné, sauf au survol.
    const html = renderSiteHome(NETWORK);
    expect(html).toContain('.biens img,.biens .sans{display:block;width:100%;aspect-ratio:4/3;');
    expect(html).toContain('.biens a{display:block;text-decoration:none}');
    expect(html).toContain('.biens a:hover strong{text-decoration:underline}');
  });

  it('[R220] sous les biens, la garantie en une ligne puis « Voir tous les biens » ; sans bien, c’est dit en mots', () => {
    const html = renderSiteHome(NETWORK);
    expect(html).toContain('<p class="controle">Mandats vérifiés le 9 janvier 2027 à 10 h 05 : seuls les biens sous mandat en vigueur sont montrés.</p><p><a class="lien" href="/biens">Voir tous les biens</a></p><h2>Sur ce site</h2>');
    expect(html.match(/<li><a href="\/biens\/p\d">/g)).toHaveLength(HOME_LISTINGS);
    expect(renderSiteHome({ ...NETWORK, listings: [] })).toContain('<h2>Les derniers biens</h2><p class="doux">Aucun bien en vente en ce moment.</p><p class="controle">');
  });

  it('[R201] accessible et dans son budget, sur les deux sites, avec six biens ou aucun', () => {
    for (const input of [NETWORK, OWN, { ...NETWORK, listings: [] }, { ...OWN, agent: null, listings: [] }]) {
      const html = renderSiteHome(input);
      expect(htmlProblems(html)).toEqual([]);
      expect(gzipSize(html)).toBeLessThanOrEqual(BUDGETS.page.gzipBytes);
      expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
      expect(html).not.toContain('<script');
    }
  });
});

/** Dans Chromium, là où Playwright et son navigateur sont installés : sinon l'essai se signale sauté. */
type Navigateur = { newPage(o?: object): Promise<any>; close(): Promise<void> };
async function lancer(): Promise<Navigateur | null> {
  try {
    const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Navigateur> } };
    return await chromium.launch();
  } catch {
    return null;
  }
}
const navigateur = await lancer();
const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e9e3d8"/><rect y="212" width="400" height="88" fill="#c9b99d"/></svg>';

async function ouvrir(viewport: { width: number; height: number }, input: SiteHomeInput = NETWORK) {
  const page = await navigateur!.newPage({ viewport });
  await page.route('**/*', (route: any) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/medias/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: DRAWING });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: renderSiteHome(input) });
  });
  await page.goto('https://site.example.test/');
  await page.waitForSelector('.ouverture');
  return page;
}
const box = (page: any, selector: string) => page.evaluate((s: string) => { const r = (globalThis as any).document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }, selector);

describe('DS071 · l’accueil du site, dans Chromium', () => {
  it.skipIf(navigateur === null)('sur téléphone : le titre, la phrase, la recherche sur toute la largeur et l’estimation tiennent dans le premier écran', async () => {
    const page = await ouvrir({ width: 390, height: 844 });
    try {
      expect((await box(page, '.ouverture .appel')).bottom).toBeLessThanOrEqual(844);
      const [field, search, estimate] = [await box(page, '#chercher-q'), await box(page, '.chercher button'), await box(page, '.ouverture .appel')];
      // Le champ a sa ligne : la phrase d'exemple n'est plus coupée au milieu.
      expect(field.width).toBe(390 - 32);
      expect(search.top).toBeGreaterThanOrEqual(field.bottom);
      expect(search.width).toBe(390 - 32);
      for (const b of [field, search, estimate]) expect(Math.round(b.height)).toBeGreaterThanOrEqual(48);
      expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      // Chaque rangée de « Sur ce site » se touche en entier, à 44 px au moins.
      const rows = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('.chemins a')].map((a: any) => { const r = a.getBoundingClientRect(); return { h: r.height, w: r.width }; }));
      expect(rows.length).toBe(7);
      for (const r of rows) {
        expect(Math.round(r.h)).toBeGreaterThanOrEqual(44);
        expect(r.w).toBe(390 - 32);
      }
    } finally {
      await page.close();
    }
  }, 60_000);

  it.skipIf(navigateur === null)('sur ordinateur : trois biens par rang, alignés même sans photo ; le champ et son bouton sur une ligne', async () => {
    const page = await ouvrir({ width: 1440, height: 900 }, { ...NETWORK, listings: [...LISTINGS.slice(0, 5), listing(6, { photo: null })] });
    try {
      const tops = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('.biens > li')].map((li: any) => Math.round(li.getBoundingClientRect().top)));
      expect(new Set(tops.slice(0, 3)).size).toBe(1);
      expect(tops[3]).toBeGreaterThan(tops[0]!);
      // L'aplat du bien sans photo a la taille des photos de son rang : son titre est à la hauteur des autres.
      const titles = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('.biens > li strong')].slice(3).map((s: any) => Math.round(s.getBoundingClientRect().top)));
      expect(new Set(titles).size).toBe(1);
      // Les deux mesures dans le même rendu : entre deux allers-retours, une photo qui arrive allonge la page, la barre
      // de défilement apparaît, et les espacements fluides bougent d'un pixel (l'essai tombait de temps en temps).
      const [field, search] = await page.evaluate(() => ['#chercher-q', '.chercher button'].map((s) => { const r = (globalThis as any).document.querySelector(s).getBoundingClientRect(); return { top: r.top, height: r.height }; }));
      expect(Math.abs(field.top - search.top)).toBeLessThanOrEqual(1);
      expect(field.height).toBe(search.height);
    } finally {
      await page.close();
    }
  }, 60_000);
});

afterAll(async () => { await navigateur?.close(); });
