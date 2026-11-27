import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENTS_INDEX_FROM, AGENTS_PER_PAGE, COMMUNES_INDEX_FROM, COMMUNES_PER_PAGE, letterOf, renderAgentsList, renderPricesList } from '../../core/src/attirer/annuaire-site.ts';
import type { PublicAgent } from '../../core/src/attirer/page-agent.ts';
import type { PublicCommune } from '../../core/src/attirer/referencement.ts';
import { BUDGETS, gzipSize, htmlProblems } from '../../core/src/design/audit.ts';

// DS075 · les listes d'agents et de communes. Tout est inventé : les noms, les zones, les numéros, les communes.
const fr = (a: string, b: string): number => a.localeCompare(b, 'fr');
const FIRSTS = ['Alex', 'Camille', 'Dominique', 'Élise', 'Farid', 'Gaëlle', 'Hugo', 'Inès', 'Jules', 'Karim', 'Léa', 'Manon', 'Nadia', 'Octave', 'Rose', 'Sacha', 'Théo'];
const LASTS = ['Abel', 'Aubert', 'Barre', 'Blanc', 'Carré', 'Colin', 'Da Silva', 'Dupré', 'Émery', 'Faure', 'Garnier', 'Henry', 'Imbert', 'Jacob', 'Klein', 'Lambert', 'Le Gall', 'Marchand', 'Morel', 'Noël', 'Olivier', 'Perrin', 'Renard', 'Simon', 'Tessier', 'Vidal', 'Weber', 'Zeller'];
const MENTIONS = { rsacNumber: '123 456 789', rsacRegistry: 'Dijon', cardNumber: 'CPI 0000 0000 000 000 000', cardHolder: 'Société Exemple' };

function agents(count: number): PublicAgent[] {
  const people = Array.from({ length: count }, (_, i) => ({ first: FIRSTS[(i * 7) % FIRSTS.length]!, last: LASTS[(i * 11 + Math.floor(i / 17)) % LASTS.length]! }));
  people.sort((a, b) => fr(a.last, b.last) || fr(a.first, b.first));
  return people.map((p, i) => ({ agentId: `ag-${i}`, name: `${p.first} ${p.last}`, lastName: p.last, zone: i % 3 === 0 ? null : 'Ville inventée', mentions: MENTIONS }));
}

function communes(count: number): PublicCommune[] {
  const heads = ['Aigne', 'Bar', 'Cham', 'Dam', 'Échi', 'Font', 'Gevr', 'Is', 'Long', 'Mag', 'Mes', 'Neu', 'Or', 'Per', 'Rou', 'Sau', 'Til', 'Val', 'Vou'];
  const tails = ['ay', 'ey', 'igny', 'ange', 'ecourt', 'eville', 'ot', 'oux', 'ans', 'ières', 'ol', 'euil', 'y'];
  const ends = ['', '-sur-Ouche', '-le-Château', '-en-Montagne', '-la-Côte', '-les-Monts'];
  const names = new Set<string>();
  for (let i = 0; names.size < count; i++) names.add(heads[i % heads.length]! + tails[(i * 5 + Math.floor(i / heads.length)) % tails.length]! + ends[Math.floor(i / (heads.length * tails.length)) % ends.length]! + (i >= heads.length * tails.length * ends.length ? `-${String.fromCharCode(97 + (i % 26))}` : ''));
  return [...names].sort(fr).map((name, i) => ({ slug: `c-${i}`, name }));
}

const text = (html: string): string => html.replace(/<head>.*<\/head>/s, '').replace(/<[^>]+>/g, ' ');
const letters = (html: string): [string, string][] => [...(/<nav class="lettres" aria-label="Aller à une lettre">(.*?)<\/nav>/.exec(html)?.[1] ?? '').matchAll(/<a href="([^"]*)">([^<]+)<\/a>/g)].map((m) => [m[2]!, m[1]!]);
const titles = (html: string): string[] => [...html.matchAll(/<h2(?: id="[^"]+")?>([^<]+)<\/h2>/g)].map((m) => m[1]!);

describe('DS075 · les listes d’agents et de communes se feuillettent par lettre', () => {
  it('la lettre d’un nom : sans accent, en capitale ; « Autres » pour ce qui ne commence pas par une lettre', () => {
    expect(['Éclair', 'œuvre', 'd’Artois', '  Zola', 'ábaco'].map(letterOf)).toEqual(['E', 'O', 'D', 'Z', 'A']);
    expect(['2 Alpes', '', '’s-Gravenhage'].map(letterOf)).toEqual(['Autres', 'Autres', 'Autres']);
  });

  it('une courte liste se lit d’un regard : ni index ni titres de lettre', () => {
    const few = renderAgentsList(agents(AGENTS_INDEX_FROM - 1))!;
    expect(few).not.toContain('class="lettres"');
    expect(few).not.toContain('<h2');
    expect(few.match(/<ul class="annuaire">/g)).toHaveLength(1);
    const towns = renderPricesList(communes(COMMUNES_INDEX_FROM - 1))!;
    expect(towns).not.toContain('class="lettres"');
    expect(towns).not.toContain('<h2');
    expect(towns.match(/<ul class="annuaire communes">/g)).toHaveLength(1);
  });

  it('une longue liste d’agents : l’index couvre toute la liste, et chaque lettre mène à la page où elle commence', () => {
    const all = agents(250);
    const pages = Array.from({ length: Math.ceil(all.length / AGENTS_PER_PAGE) }, (_, k) => renderAgentsList(all, k + 1)!);
    expect(renderAgentsList(all, pages.length + 1)).toBeNull();
    const firstAt = new Map<string, number>();
    all.forEach((a, i) => { if (!firstAt.has(letterOf(a.lastName))) firstAt.set(letterOf(a.lastName), i); });
    pages.forEach((html, k) => {
      const index = letters(html);
      // Les mêmes lettres sur chaque page, dans l'ordre de la liste : celles qui ont au moins un agent, pas les autres.
      expect(index.map(([l]) => l)).toEqual([...firstAt.keys()]);
      for (const [letter, href] of index) {
        const at = Math.floor(firstAt.get(letter)! / AGENTS_PER_PAGE);
        const id = `lettre-${letter.toLowerCase()}`;
        expect(href, `${letter}, page ${k + 1}`).toBe(at === k ? `#${id}` : `${at === 0 ? '/agents' : `/agents?page=${at + 1}`}#${id}`);
        // L'ancre existe sur la page visée, une seule fois.
        expect(pages[at]!.match(new RegExp(`<h2 id="${id}">${letter}</h2>`, 'g'))).toHaveLength(1);
      }
    });
    // La liste est triée : aucune lettre ne revient deux fois sur une page, et une lettre coupée par la page le dit.
    for (const html of pages) expect(new Set(titles(html)).size).toBe(titles(html).length);
    const cut = letterOf(all[AGENTS_PER_PAGE]!.lastName);
    expect(letterOf(all[AGENTS_PER_PAGE - 1]!.lastName)).toBe(cut);
    expect(titles(pages[1]!)[0]).toBe(`${cut}, suite`);
    expect(pages[1]).not.toContain(`id="lettre-${cut.toLowerCase()}"`);
    // Les pages se suivent comme avant.
    expect(pages[0]).toContain('<a rel="next" href="/agents?page=2">Page suivante</a>');
    expect(pages[2]).toContain('<a rel="prev" href="/agents?page=2">Page précédente</a><a rel="next" href="/agents?page=4">Page suivante</a>');
  });

  it('[R152] [R14] rangé par lettre, chaque agent garde ses mentions sous son nom, et la page ne porte toujours aucun chiffre sur son activité', () => {
    const html = renderAgentsList(agents(AGENTS_PER_PAGE))!;
    expect(html).toContain('class="lettres"');
    expect(html.match(/<li><a href="\/agents\/ag-\d+">[^<]*<strong>[^<]+<\/strong><\/a>(?:<p>Ville inventée<\/p>)?<p class="doux">Agent commercial[^<]*123 456 789[^<]*<\/p><\/li>/g)).toHaveLength(AGENTS_PER_PAGE);
    const visible = text(html.replace(/<p class="doux">Agent commercial[^<]*<\/p>/g, ''));
    expect(visible).not.toMatch(/\d/);
    expect(visible).not.toMatch(/note|classement|vente|mandat|avis/i);
  });

  it('le nom de famille, par lequel la liste se range, est en gras ; un nom qui ne finit pas par lui reste entier, et rien n’est écrit sans échappement', () => {
    const one = (name: string, lastName: string): string => renderAgentsList([{ agentId: 'ag-1', name, lastName, zone: null, mentions: MENTIONS }])!;
    expect(one('Alex Da Silva', 'Da Silva')).toContain('<a href="/agents/ag-1">Alex <strong>Da Silva</strong></a>');
    expect(one('Alex Exemple', 'Autre')).toContain('<a href="/agents/ag-1">Alex Exemple</a>');
    expect(one('Alex Exemple', '')).toContain('<a href="/agents/ag-1">Alex Exemple</a>');
    expect(one('Alex <b>Essai', '<b>Essai')).toContain('<a href="/agents/ag-1">Alex <strong>&lt;b&gt;Essai</strong></a>');
  });

  it('les communes : des colonnes, lettre par lettre ; ce qui ne commence pas par une lettre est rangé sous « Autres »', () => {
    const all = [{ slug: 'c-x', name: '2 Vallées' }, ...communes(COMMUNES_PER_PAGE + 80)];
    const one = renderPricesList(all)!;
    expect(one).toContain('.communes{grid-template-columns:repeat(auto-fill,minmax(min(9.5rem,100%),1fr))');
    expect(letters(one)[0]).toEqual(['Autres', '#lettre-autres']);
    expect(one).toContain('<h2 id="lettre-autres">Autres</h2><ul class="annuaire communes"><li><a href="/prix/c-x">2 Vallées</a></li></ul><h2 id="lettre-a">A</h2>');
    // Chaque commune de la page est dans un groupe, une fois.
    expect(one.match(/<li><a href="\/prix\/c-[^"]+">/g)).toHaveLength(COMMUNES_PER_PAGE);
    const two = renderPricesList(all, 2)!;
    expect(two.match(/<li><a href="\/prix\/c-[^"]+">/g)).toHaveLength(81);
    const last = letters(two).at(-1)!;
    expect(last[1]).toBe(`#lettre-${last[0].toLowerCase()}`);
    expect(letters(two)[1]![1]).toBe('/prix#lettre-a');
  });

  it('[R201] accessibles et dans leur budget : une page pleine d’agents, une page pleine de communes, sans aucun script', () => {
    const lastOf = (count: number, size: number): number => Math.ceil(count / size);
    for (const html of [renderAgentsList(agents(500))!, renderAgentsList(agents(500), lastOf(500, AGENTS_PER_PAGE))!, renderPricesList(communes(2000))!, renderPricesList(communes(2000), lastOf(2000, COMMUNES_PER_PAGE))!, renderAgentsList(agents(3))!, renderPricesList([])!]) {
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
afterAll(async () => {
  await navigateur?.close();
});

async function ouvrir(viewport: { width: number; height: number }, html: string, path = '/') {
  const page = await navigateur!.newPage({ viewport });
  await page.route('**/*', (route: any) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(`https://site.example.test${path}`);
  await page.waitForSelector('main h1');
  return page;
}
/** La hauteur de la page, les liens trop petits pour un doigt, et si la page déborde en largeur. */
const mesures = (page: any) =>
  page.evaluate(() => {
    const d = (globalThis as any).document;
    const small = [...d.querySelectorAll('main a')].filter((a: any) => { const r = a.getBoundingClientRect(); return Math.round(r.width) < 44 || Math.round(r.height) < 44; }).map((a: any) => a.textContent);
    return { height: d.documentElement.scrollHeight, small, wide: d.documentElement.scrollWidth > (globalThis as any).innerWidth };
  });
const tops = (page: any, selector: string, count: number) => page.evaluate(([s, n]: [string, number]) => [...(globalThis as any).document.querySelectorAll(s)].slice(0, n).map((e: any) => Math.round(e.getBoundingClientRect().top)), [selector, count]);

describe('DS075 · les listes, dans Chromium', () => {
  it.skipIf(navigateur === null)('sur téléphone, deux mille communes : deux colonnes, des liens à la taille du doigt, et une page qui tient en dix écrans', async () => {
    const page = await ouvrir({ width: 390, height: 844 }, renderPricesList(communes(2000))!);
    const m = await mesures(page);
    expect(m.small).toEqual([]);
    expect(m.wide).toBe(false);
    // L'audit mesurait 21 582 px : une page de communes, titres de lettre compris, tient en dix écrans de téléphone.
    expect(m.height).toBeLessThanOrEqual(10 * 844);
    const [a, b, c] = await tops(page, '.communes:first-of-type li', 3);
    expect(a).toBe(b);
    expect(c).toBeGreaterThan(a);
    await page.close();
  });

  it.skipIf(navigateur === null)('l’index reste en haut de l’écran, et la lettre touchée arrive juste dessous, jamais cachée', async () => {
    const page = await ouvrir({ width: 390, height: 844 }, renderPricesList(communes(2000))!, '/prix');
    const target = await page.evaluate(() => { const links = [...(globalThis as any).document.querySelectorAll('.lettres a')].filter((a: any) => a.getAttribute('href').startsWith('#')); return links[links.length - 1].getAttribute('href'); });
    await page.evaluate((h: string) => { (globalThis as any).document.querySelector(`.lettres a[href="${h}"]`).click(); }, target);
    await page.waitForFunction((h: string) => (globalThis as any).location.hash === h, target);
    const seen = await page.evaluate((h: string) => {
      const d = (globalThis as any).document;
      const bar = d.querySelector('.lettres').getBoundingClientRect();
      const title = d.querySelector(h).getBoundingClientRect();
      return { barTop: Math.round(bar.top), barBottom: Math.round(bar.bottom), titleTop: Math.round(title.top), scrolled: (globalThis as any).scrollY };
    }, target);
    expect(seen.scrolled).toBeGreaterThan(2000);
    expect(seen.barTop).toBe(0);
    expect(seen.titleTop).toBeGreaterThanOrEqual(seen.barBottom);
    expect(seen.titleTop).toBeLessThan(200);
    // L'index tient sur une ligne : il défile de côté, la page non.
    expect(seen.barBottom).toBeLessThanOrEqual(52);
    expect((await mesures(page)).wide).toBe(false);
    await page.close();
  });

  it.skipIf(navigateur === null)('sur ordinateur : les agents sur trois colonnes, les communes sur cinq au moins, l’index sur une seule ligne', async () => {
    const page = await ouvrir({ width: 1440, height: 900 }, renderAgentsList(agents(500))!);
    const m = await mesures(page);
    expect(m.small).toEqual([]);
    expect(m.wide).toBe(false);
    const [a, b, c, d] = await tops(page, '.annuaire:first-of-type li', 4);
    expect([b, c]).toEqual([a, a]);
    expect(d).toBeGreaterThan(a);
    expect(new Set(await tops(page, '.lettres a', 40)).size).toBe(1);
    await page.close();
    const towns = await ouvrir({ width: 1440, height: 900 }, renderPricesList(communes(2000))!);
    const row = await tops(towns, '.communes:first-of-type li', 5);
    expect(new Set(row).size).toBe(1);
    expect((await mesures(towns)).small).toEqual([]);
    await towns.close();
  });

  it.skipIf(navigateur === null)('sur téléphone, cinq cents agents : un par ligne, des mentions lisibles, rien qui déborde, et une page qui tient en dix écrans', async () => {
    const page = await ouvrir({ width: 390, height: 844 }, renderAgentsList(agents(500))!);
    const m = await mesures(page);
    expect(m.small).toEqual([]);
    expect(m.wide).toBe(false);
    // L'audit mesurait 17 299 px.
    expect(m.height).toBeLessThanOrEqual(10 * 844);
    const size = await page.evaluate(() => parseFloat((globalThis as any).getComputedStyle((globalThis as any).document.querySelector('.annuaire .doux')).fontSize));
    expect(size).toBeGreaterThanOrEqual(13);
    await page.close();
  });

  it.skipIf(navigateur === null)('sur le plus petit téléphone, 320 px, et jusqu’à 240 px : la grille rétrécit, aucune des deux listes ne déborde', async () => {
    for (const width of [320, 280, 240]) {
      for (const html of [renderAgentsList(agents(500))!, renderAgentsList(agents(3))!, renderPricesList(communes(2000))!, renderPricesList(communes(12))!]) {
        const page = await ouvrir({ width, height: 640 }, html);
        const m = await mesures(page);
        expect(m.wide, `${width} px`).toBe(false);
        // Aucun élément de la liste ne mord sur la marge de droite de la page.
        const beyond = await page.evaluate(() => {
          const d = (globalThis as any).document;
          const main = d.querySelector('main');
          const edge = main.getBoundingClientRect().right - parseFloat((globalThis as any).getComputedStyle(main).paddingRight);
          return [...d.querySelectorAll('.annuaire li')].filter((e: any) => e.getBoundingClientRect().right > edge + 0.5).length;
        });
        expect(beyond, `${width} px`).toBe(0);
        await page.close();
      }
    }
  });
});
