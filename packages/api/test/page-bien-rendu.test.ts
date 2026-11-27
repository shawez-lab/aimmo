import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { renderListingPage, type PageInput } from '../../core/src/annonces/page-bien.ts';
import { withLegalLinks } from '../../core/src/attirer/mentions-site.ts';

// DS072 · la page publique d'un bien, rendue dans Chromium. Tout est inventé : le bien, l'agent, les photos (un dessin).
const N = ' ';
const S = ' ';
const LISTING: PageInput = {
  payload: {
    reference: 'REF-T-1',
    version: 3,
    state: 'en_vente',
    title: 'Maison 5 pièces avec jardin à Talant',
    body: 'Un séjour traversant.\nTrois chambres.\nUn jardin clos, plein sud.\nGarage et cave.',
    mentions: `Prix : 320${S}000${N}€ honoraires inclus, soit 307${S}700${N}€ hors honoraires et 4${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.\nClasse énergie D, classe climat B. Logement à consommation énergétique moyenne.\nCarte professionnelle n° CPI 0000.`,
    priceEur: 320000,
    media: [],
    surfaces: [{ kind: 'habitable', m2: 118, source: 'mesurage' }],
  },
  agent: { firstName: 'Alex', lastName: 'Exemple', phone: '03 00 00 00 00', email: 'alex@exemple.test' },
  photos: Array.from({ length: 7 }, (_, i) => ({ ref: `biens/b1/0b6f1d2e-${String(i + 1).repeat(4)}-4a2b-8c3d-00000000000${i + 1}.jpg`, kind: 'photo' as const, overlay: i === 2 ? 'Aménagement virtuel' : null, caption: `Photo ${i + 1}` })),
};
const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e9e3d8"/><rect y="212" width="400" height="88" fill="#c9b99d"/></svg>';

/** Là où Playwright et son navigateur sont installés : sinon l'essai se signale sauté. */
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

async function ouvrir(viewport: { width: number; height: number }, input: PageInput = LISTING, site = false) {
  const page = await navigateur!.newPage({ viewport });
  await page.route('**/*', (route: any) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/medias/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: DRAWING });
    // Sur un site, la page reçoit en plus les liens des pages légales, posés à la fin [R221].
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: site ? withLegalLinks(renderListingPage(input)) : renderListingPage(input) });
  });
  await page.goto('https://site.example.test/biens/b1');
  await page.waitForSelector('.photos img');
  return page;
}
const box = (page: any, selector: string) => page.evaluate((s: string) => { const r = (globalThis as any).document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }, selector);

describe('DS072 · la page du bien, dans Chromium', () => {
  it.skipIf(navigateur === null)('sur téléphone : la photo ouvre la page en grand, la suivante dépasse, et la galerie se feuillette sans que la page bouge de côté', async () => {
    const page = await ouvrir({ width: 390, height: 844 });
    try {
      const first = await box(page, '.photos li:first-child img');
      expect(first.top).toBeLessThan(120);
      expect(first.width).toBeGreaterThanOrEqual(0.8 * 390);
      // La deuxième photo dépasse du bord : on voit qu'il y en a d'autres.
      const second = await box(page, '.photos li:nth-child(2) img');
      expect(second.left).toBeLessThan(390);
      expect(second.right).toBeGreaterThan(390);
      const strip = await page.evaluate(() => { const u = (globalThis as any).document.querySelector('.photos'); return { scroll: u.scrollWidth, client: u.clientWidth, page: (globalThis as any).document.documentElement.scrollWidth }; });
      expect(strip.scroll).toBeGreaterThan(5 * strip.client);
      expect(strip.page).toBeLessThanOrEqual(390);
      // Le titre, le prix et les faits tiennent dans le premier écran, sous la photo.
      expect((await box(page, 'h1')).bottom).toBeLessThan(844);
      expect((await box(page, '.prix')).bottom).toBeLessThan(844);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.skipIf(navigateur === null)('sur téléphone : les deux gestes restent au pied de l’écran pendant toute la lecture, à 48 px au moins, et ne cachent pas la fin', async () => {
    const page = await ouvrir({ width: 390, height: 844 });
    try {
      for (const y of [0, 500]) {
        await page.evaluate((to: number) => (globalThis as any).scrollTo(0, to), y);
        const bar = await box(page, '.gestes');
        expect(Math.round(bar.bottom), `à ${y} px`).toBe(844);
        expect(bar.left).toBe(0);
        expect(bar.width).toBe(390);
      }
      for (const n of [1, 2]) expect((await box(page, `.gestes a:nth-child(${n})`)).height).toBeGreaterThanOrEqual(48);
      // « Demander une visite » est le geste plein, le plus large.
      expect((await box(page, '.gestes a:nth-child(1)')).width).toBeGreaterThan((await box(page, '.gestes a:nth-child(2)')).width);
      // Au bout de la page, la barre est à sa place, après l'agent : rien n'est dessous.
      await page.evaluate(() => (globalThis as any).scrollTo(0, (globalThis as any).document.documentElement.scrollHeight));
      expect((await box(page, '.agent')).bottom).toBeLessThanOrEqual((await box(page, '.gestes')).top + 1);
      // [R43] les mentions se lisent : visibles, à 13 px au moins.
      const mentions = await page.evaluate(() => { const m = (globalThis as any).document.querySelector('.mentions'); const s = (globalThis as any).getComputedStyle(m); return { size: parseFloat(s.fontSize), shown: s.display !== 'none' && s.visibility === 'visible' && m.getBoundingClientRect().height > 40 }; });
      expect(mentions.shown).toBe(true);
      expect(mentions.size).toBeGreaterThanOrEqual(13);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.skipIf(navigateur === null)('[R221] sur un site, les liens des pages légales viennent après les gestes : ni dessous, ni par-dessus', async () => {
    const page = await ouvrir({ width: 390, height: 844 }, LISTING, true);
    try {
      // En haut de page, les gestes sont au pied de l'écran et les liens légaux plus bas, hors de l'écran.
      expect(Math.round((await box(page, '.gestes')).bottom)).toBe(844);
      await page.evaluate(() => (globalThis as any).scrollTo(0, (globalThis as any).document.documentElement.scrollHeight));
      const [bar, legal] = [await box(page, '.gestes'), await box(page, 'nav[aria-label="Informations légales"]')];
      expect(legal.top).toBeGreaterThanOrEqual(bar.bottom);
      expect(legal.bottom).toBeLessThanOrEqual(844);
      // Chaque lien légal se touche : 24 px au moins de haut, sans rien dessus.
      const top = await page.evaluate(() => { const a = (globalThis as any).document.querySelector('nav[aria-label="Informations légales"] a'); const r = a.getBoundingClientRect(); return (globalThis as any).document.elementFromPoint(r.left + 4, r.top + r.height / 2) === a; });
      expect(top).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.skipIf(navigateur === null)('sur ordinateur : une mosaïque de hauteur bornée, le titre et le prix dans le premier écran, l’agent à côté du texte et qui suit la lecture', async () => {
    const page = await ouvrir({ width: 1440, height: 900 });
    try {
      const gallery = await box(page, '.photos');
      expect(gallery.height).toBeLessThanOrEqual(0.64 * 900 + 1);
      // La première photo est la grande : deux rangs de haut, deux colonnes de large.
      const [big, small] = [await box(page, '.photos li:first-child'), await box(page, '.photos li:nth-child(2)')];
      expect(big.width).toBeGreaterThan(1.8 * small.width);
      expect(big.height).toBeGreaterThan(1.8 * small.height);
      expect((await box(page, 'h1')).top).toBeLessThan(900);
      expect((await box(page, '.prix')).bottom).toBeLessThanOrEqual(900);
      const [text, contact] = [await box(page, '.texte'), await box(page, '.contact')];
      expect(contact.left).toBeGreaterThanOrEqual(text.right);
      // Les gestes sont dans la colonne de l'agent, l'un sous l'autre.
      const [a, b] = [await box(page, '.gestes a:nth-child(1)'), await box(page, '.gestes a:nth-child(2)')];
      expect(b.top).toBeGreaterThanOrEqual(a.bottom);
      expect(a.left).toBeGreaterThanOrEqual(contact.left - 1);
      // En descendant, la colonne de l'agent reste en haut de l'écran tant que le texte se lit.
      await page.evaluate(() => (globalThis as any).scrollTo(0, 700));
      const after = await box(page, '.contact');
      expect(after.top).toBeGreaterThanOrEqual(0);
      expect(after.top).toBeLessThan(120);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.skipIf(navigateur === null)('une seule photo prend toute la largeur ; sans photo, la page commence par l’état et le titre', async () => {
    const one = await ouvrir({ width: 390, height: 844 }, { ...LISTING, photos: LISTING.photos.slice(0, 1) });
    try {
      expect((await box(one, '.photos li:first-child img')).width).toBe(390 - 32);
    } finally {
      await one.close();
    }
    const html = renderListingPage({ ...LISTING, photos: [] });
    expect(html).not.toContain('class="photos"');
    expect(html).toContain('<main><div class="corps"><div><p><span class="etat">En vente</span></p><h1>');
  }, 60_000);
});

afterAll(async () => { await navigateur?.close(); });
