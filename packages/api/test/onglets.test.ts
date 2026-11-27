import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

// DS005, DS006, DS011, DS065, DS066 · les onglets de l'agent. Tout est inventé : clés de test, prénom, réponses.
const HTML = AGENT_APP_FILES['/app/']!;
const PAGE = AGENT_APP_FILES['/app/reseau']!;
const CSS = AGENT_APP_FILES['/app/app.css']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const KEY = 'k'.repeat(40);

type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const DAY: Record<string, Answer> = {
  '/v1/plan-du-jour': ok({ agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [] }),
  '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
  '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
};
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};
const between = (html: string, from: string, to: string): string => html.slice(html.indexOf(from), html.indexOf(to));

/** L'application ouverte par une clé gardée : le rôle est celui que `/v1/moi` rend. */
async function run(role: 'agent' | 'direction' | 'compliance', options: { hash?: string; answers?: Record<string, Answer> } = {}) {
  const direction = role === 'direction';
  const { els, listeners, document } = fakeDocument(pageIds(HTML, direction));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  if (direction) storage.set('aimmo.reseau', '1');
  const calls: string[] = [];
  const answers: Record<string, Answer> = { ...DAY, ...options.answers };
  runInNewContext(JS, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url === '/v1/moi') return ok({ role, firstName: 'Alex' })();
      return answers[url] ? answers[url]!() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    history: { pushState: () => undefined, replaceState: () => undefined },
    location: { origin: 'https://app.aimmo.test', pathname: direction ? '/app/reseau' : '/app/', hash: options.hash ?? '', replace: () => undefined },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (id: string) => {
    els[id]!.listeners.click!({});
    await settle();
  };
  const current = () => Object.fromEntries(['journee', 'outils', 'chiffres'].map((t) => [t, els[`${t}-ouvrir`]!.attributes['aria-current'] ?? null]));
  const dayReads = () => calls.filter((c) => c === 'GET /v1/plan-du-jour').length;
  return { els, document, calls, click, current, dayReads };
}

describe('DS005 · une barre d’onglets, toujours là pour l’agent', () => {
  it('[R201] la page porte un repère de navigation à trois onglets, avant le contenu, et un bouton pour l’enjamber', () => {
    const nav = /<nav id="onglets" class="onglets" aria-label="Sections" hidden>([\s\S]*?)<\/nav>/.exec(HTML)!;
    expect(nav).not.toBeNull();
    const tabs = [...nav[1]!.matchAll(/<button id="([a-z-]+)" type="button" class="discret"><svg viewBox="0 0 24 24" aria-hidden="true">[\s\S]*?<\/svg>([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]);
    expect(tabs).toEqual([['journee-ouvrir', 'Journée'], ['outils-ouvrir', 'Outils'], ['chiffres-ouvrir', 'Chiffres']]);
    // Le dessin d'un onglet est dans la page, jamais écrit par le script [R13] ; il prend la couleur du texte.
    expect(nav[1]).not.toMatch(/stroke=|fill=|style=/);
    expect(CSS).toMatch(/\.onglets svg \{[^}]*fill: none; stroke: currentColor;/);
    // DS066 · le repère vient avant le contenu, et un bouton, premier de la page, mène droit au contenu.
    expect(HTML.indexOf('<nav id="onglets"')).toBeLessThan(HTML.indexOf('<main>'));
    expect(HTML).toMatch(/<body>\n<button id="vers-contenu" type="button" class="evitement" hidden>Aller au contenu<\/button>\n<header/);
    // La page de la direction a la même barre, qui y reste cachée.
    expect(PAGE).toContain(nav[0]);
  });

  it('pour l’agent entré, les onglets se montrent et disent où il est ; sa journée est l’onglet ouvert', async () => {
    const a = await run('agent');
    expect(a.els.accueil!.hidden).toBe(false);
    expect(a.els.onglets!.hidden).toBe(false);
    expect(a.els['vers-contenu']!.hidden).toBe(false);
    expect(a.current()).toEqual({ journee: 'page', outils: null, chiffres: null });
    await a.click('outils-ouvrir');
    expect(a.els.outils!.hidden).toBe(false);
    expect(a.els.accueil!.hidden).toBe(true);
    expect(a.current()).toEqual({ journee: null, outils: 'page', chiffres: null });
    // DS064 · le focus rejoint le titre de l'écran ouvert.
    expect(a.document.activeElement).toBe(a.els['outils-titre']);
    await a.click('chiffres-ouvrir');
    expect(a.els.chiffres!.hidden).toBe(false);
    expect(a.current()).toEqual({ journee: null, outils: null, chiffres: 'page' });
    await a.click('journee-ouvrir');
    expect(a.els.accueil!.hidden).toBe(false);
    expect(a.current()).toEqual({ journee: 'page', outils: null, chiffres: null });
  });

  it('ouvrir les outils ne relit rien et ne coupe pas la journée en cours de lecture ; revenir à la journée la relit', async () => {
    let release: (r: Response) => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = r));
    const a = await run('agent', { answers: { '/v1/contacts-chauds': slow } });
    expect(a.els['chauds-etat']!.textContent).toBe('Chargement…');
    const before = a.calls.length;
    await a.click('outils-ouvrir');
    expect(a.calls.length).toBe(before);
    // La réponse arrive pendant que l'agent est aux outils : elle est posée quand même.
    release(Response.json({ ok: true, mode: 'essai', data: { slot: 'morning', contacts: [] } }));
    await settle();
    expect(a.els['chauds-etat']!.textContent).not.toBe('Chargement…');
    expect(a.dayReads()).toBe(1);
    await a.click('journee-ouvrir');
    expect(a.dayReads()).toBe(2);
  });

  it('un écran ouvert depuis les outils y revient, sans relire la journée ; ouvert depuis la journée, il revient à la journée', async () => {
    const a = await run('agent');
    await a.click('outils-ouvrir');
    await a.click('partenaires-ouvrir');
    expect(a.els.partenaires!.hidden).toBe(false);
    // L'écran ouvert garde son onglet marqué, sans se dire « la page » de l'onglet.
    expect(a.current()).toEqual({ journee: null, outils: 'true', chiffres: null });
    expect(a.els.onglets!.hidden).toBe(false);
    await a.click('partenaires-retour');
    expect(a.els.outils!.hidden).toBe(false);
    expect(a.els.accueil!.hidden).toBe(true);
    expect(a.current().outils).toBe('page');
    expect(a.dayReads()).toBe(1);
    // Le même écran, ouvert alors que la journée est l'onglet en cours, revient à la journée et la relit.
    await a.click('journee-ouvrir');
    await a.click('partenaires-ouvrir');
    expect(a.current()).toEqual({ journee: 'true', outils: null, chiffres: null });
    await a.click('partenaires-retour');
    expect(a.els.accueil!.hidden).toBe(false);
    expect(a.dayReads()).toBe(3);
    for (const id of ['partenaires', 'louer', 'investir', 'commerces', 'gagner']) expect(HTML, id).toContain(`<button id="${id}-retour" type="button" class="retour">Retour</button>`);
  });

  it('[R16] ni la direction ni la conformité n’ont les onglets de l’agent ; avant d’entrer, personne ne les a', async () => {
    const d = await run('direction');
    expect(d.els.reseau!.hidden).toBe(false);
    expect(d.els.onglets!.hidden).toBe(true);
    expect(d.els['vers-contenu']!.hidden).toBe(true);
    const c = await run('compliance');
    expect(c.els.conformite!.hidden).toBe(false);
    expect(c.els.onglets!.hidden).toBe(true);
    // Sorti, l'agent n'a plus d'onglets : l'écran de connexion est seul.
    const a = await run('agent');
    await a.click('outils-ouvrir');
    await a.click('sortir');
    expect(a.els.connexion!.hidden).toBe(false);
    expect(a.els.onglets!.hidden).toBe(true);
    expect(a.els['vers-contenu']!.hidden).toBe(true);
    // L'écran sans réseau garde son seul retour : la barre n'y est pas, « Se déconnecter » y reste.
    expect(JS).toContain("$('onglets').hidden = $('vers-contenu').hidden = !agentIn || out || id === 'hors-ligne';");
  });
});

describe('DS011 · les outils ont leur écran, la journée garde la journée', () => {
  const HOME = between(HTML, '<section id="accueil"', '<section id="outils"');
  const TOOLS = between(HTML, '<section id="outils"', '<section id="fiche"');
  const ENTRIES = ['gagner-ouvrir', 'louer-ouvrir', 'commerces-ouvrir', 'investir-ouvrir', 'partenaires-ouvrir', 'cles-rendre-ouvrir', 'remises-accueil', 'fiche-google-ouvrir', 'actualites-ouvrir', 'actualites-vues', 'integration-ouvrir', 'academie-ouvrir', 'notifications-ouvrir', 'cles-accueil-voir'];

  it('chaque outil a quitté l’accueil pour l’écran « Outils », avec ses identifiants : aucun branchement ne change', () => {
    expect(TOOLS).toMatch(/^<section id="outils" hidden>\n<h2 id="outils-titre">Outils<\/h2>/);
    for (const id of ENTRIES) {
      expect(TOOLS, id).toContain(` id="${id}"`);
      expect(HOME, id).not.toContain(` id="${id}"`);
    }
    // L'accueil garde ce qui fait la journée, dans cet ordre.
    const titles = [...HOME.matchAll(/<h3 id="[a-z-]+">([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(titles).toEqual(['À reprendre', 'À tenir sur mes ventes', 'Mon plan du jour', 'Contacts chauds à rappeler', 'Rendez-vous du jour', 'Mes biens à mettre en vente', 'Après mes ventes', 'Ma semaine']);
    // « Mes chiffres » n'est plus un bloc de l'accueil : c'est un onglet, et sa phrase l'a suivi sur son écran.
    expect(HOME).not.toContain('Mes chiffres');
    expect(between(HTML, '<section id="chiffres"', '<section id="reseau"')).toContain('<p class="doux">Chaque chiffre s’ouvre sur les lignes qui le font : vous pouvez tout recompter.</p>');
    expect(HTML).not.toContain('chiffres-retour');
  });

  it('l’écran « Outils » est un index : trois groupes, une rangée par outil, à son nom, sans phrase permanente', () => {
    const groups = [...TOOLS.matchAll(/<h3>([^<]+)<\/h3>([\s\S]*?)(?=<h3>|<\/section>\n$)/g)].map((m) => [m[1], [...m[2]!.matchAll(/<button id="[a-z-]+" type="button" class="secondaire rangee"(?: aria-label="[^"]+")?>([^<]+)<\/button>/g)].map((b) => b[1])]);
    expect(groups).toEqual([
      ['Mes dossiers', ['Gagner des mandats', 'Mes locations', 'Mes commerces', 'Mes investisseurs', 'Mes partenaires']],
      // « Mes remises négociées » et « Mes panneaux » s'y posent avec la journée, dans `remises-accueil`.
      ['Au quotidien', ['Mes clés à rendre', 'Fiche Google', 'Mes actualités', 'Déjà vues']],
      ['Mon compte', ['Mon dossier', 'Académie', 'Mes notifications', 'Clés de mes appareils']],
    ]);
    // Aucun bouton hors de ces rangées, aucun bloc, aucune phrase toujours affichée : seuls des états, vides au départ.
    expect(TOOLS.match(/<button\b/g)).toHaveLength(13);
    expect(TOOLS).not.toContain('class="bloc"');
    expect([...TOOLS.matchAll(/<p\b[^>]*>([^<]*)<\/p>/g)].filter((m) => m[1] !== '').map((m) => m[0])).toEqual(['<p class="doux">L’empreinte, le visage ou le code de l’appareil protège chaque clé. Elle ne quitte jamais l’appareil.</p>']);
    // « Déjà vues » garde le nom que ses messages citent [R269] ; seul, il se dit en entier à qui ne voit pas la rangée du dessus.
    expect(TOOLS).toContain('<button id="actualites-vues" type="button" class="secondaire rangee" aria-label="Actualités déjà vues">Déjà vues</button>');
    // Cette phrase-là ne se montre qu'avec les clés, une fois ouvertes.
    expect(CSS).toContain('#cles-accueil-corps:empty + .doux { display: none; }');
    // Une rangée a la hauteur d'une cible et se lit comme une ligne : pas de cadre, un filet, un chevron.
    expect(CSS).toMatch(/button\.rangee, #remises-accueil > \.bloc > button \{[^}]*min-height: calc\(var\(--cible\) \+ var\(--e-2\)\);[^}]*border-top: 1px solid var\(--trait\);[^}]*box-shadow: none;/);
    // L'engagement que portait l'entrée des locations est gardé, sur l'écran des locations.
    expect(between(HTML, '<section id="louer"', '<div id="louer-corps">')).toContain('Aucun loyer ni dépôt ne passe par AIMMO.');
  });

  it('le lien d’une notification ouvre l’écran des outils, là où « Mes notifications » se lit', async () => {
    const a = await run('agent', { hash: '#envoi=abc' });
    expect(a.els.outils!.hidden).toBe(false);
    expect(a.current().outils).toBe('page');
    expect(a.els['notifications-etat']!.textContent).toBe('Chargement…');
  });

  it('[R82] un dossier d’agent incomplet : le message dit où se trouve « Mon dossier »', async () => {
    const closed: Answer = async () => Response.json({ ok: false, code: 'agent_file_incomplete' }, { status: 403 });
    const a = await run('agent', { answers: { '/v1/plan-du-jour': closed } });
    expect(a.els['plan-etat']!.textContent).toBe('Fermé tant que votre dossier d’agent est incomplet : ouvrez « Mon dossier », dans les outils.');
    expect(between(HTML, '<section id="outils"', '<section id="fiche"')).toContain('>Mon dossier</button>');
  });
});

describe('DS006, DS065 · « Se déconnecter » a quitté l’en-tête', () => {
  it('l’en-tête ne porte plus que la marque ; le bouton est au pied de l’écran de départ de chaque rôle, à la taille des autres', async () => {
    expect(HTML).toContain('<header class="tete"><h1 class="marque">AIMMO</h1></header>');
    expect(HTML.match(/id="sortir"/g)).toHaveLength(1);
    expect(HTML.indexOf('id="sortir"')).toBeGreaterThan(HTML.lastIndexOf('</section>'));
    // DS065 · plus de bouton réduit à 40 px dans l'en-tête : il a la cible du système.
    expect(CSS).not.toMatch(/\.tete button/);
    expect(CSS).not.toMatch(/min-height: 40px/);
    const a = await run('agent');
    expect(a.els.sortir!.hidden).toBe(true);
    await a.click('outils-ouvrir');
    expect(a.els.sortir!.hidden).toBe(false);
    await a.click('partenaires-ouvrir');
    expect(a.els.sortir!.hidden).toBe(true);
    const d = await run('direction');
    expect(d.els.sortir!.hidden).toBe(false);
    const c = await run('compliance');
    expect(c.els.sortir!.hidden).toBe(false);
    // Sortir efface la clé et ramène à la connexion, comme avant.
    await a.click('partenaires-retour');
    await a.click('sortir');
    expect(a.els.connexion!.hidden).toBe(false);
    expect(a.els.sortir!.hidden).toBe(true);
  });
});

/** La même barre dans Chromium, là où Playwright et son navigateur sont installés : sinon l'essai se signale sauté. */
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

async function ouvrir(viewport: { width: number; height: number }) {
  const page = await navigateur!.newPage({ viewport });
  await page.addInitScript((k: string) => (globalThis as any).localStorage.setItem('aimmo.cle', k), KEY);
  await page.route('**/*', async (route: any) => {
    const path = new URL(route.request().url()).pathname;
    const file = AGENT_APP_FILES[path];
    if (file !== undefined) {
      const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('/') ? 'text/html' : 'application/octet-stream';
      return route.fulfill({ status: 200, contentType: type, body: file });
    }
    if (path === '/v1/moi') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { role: 'agent', firstName: 'Alex' } }) });
    const answer = DAY[path];
    if (answer) return route.fulfill({ status: 200, contentType: 'application/json', body: await (await answer()).text() });
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
  });
  await page.goto('https://aimmo.example.test/app/');
  await page.waitForSelector('#accueil:not([hidden])');
  return page;
}
const box = (page: any, selector: string) => page.evaluate((s: string) => { const r = (globalThis as any).document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }, selector);

describe('DS005 · dans Chromium', () => {
  it.skipIf(navigateur === null)('sur téléphone, la barre tient en bas, chaque onglet fait 48 px au moins, et rien du contenu ne reste dessous', async () => {
    const page = await ouvrir({ width: 390, height: 844 });
    try {
      const nav = await box(page, '#onglets');
      expect(nav.left).toBe(0);
      expect(nav.width).toBe(390);
      expect(Math.round(nav.bottom)).toBe(844);
      for (const id of ['journee-ouvrir', 'outils-ouvrir', 'chiffres-ouvrir']) {
        const b = await box(page, `#${id}`);
        expect(b.height, id).toBeGreaterThanOrEqual(48);
        expect(b.width, id).toBeGreaterThanOrEqual(48);
      }
      // L'onglet ouvert se lit sans la couleur : un trait au-dessus de lui, les autres n'en ont pas.
      const marks = await page.evaluate(() => ['journee', 'outils'].map((t) => (globalThis as any).getComputedStyle((globalThis as any).document.getElementById(`${t}-ouvrir`)).boxShadow));
      expect(marks[0]).not.toBe('none');
      expect(marks[1]).toBe('none');
      await page.click('#outils-ouvrir');
      await page.waitForSelector('#outils:not([hidden])');
      // DS011 · l'index des outils tient en deux écrans de téléphone, chaque rangée fait 48 px au moins.
      expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollHeight)).toBeLessThanOrEqual(2 * 844);
      const rows = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('#outils button')].map((b: any) => b.getBoundingClientRect().height));
      expect(rows.length).toBeGreaterThanOrEqual(15);
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(48);
      // « Se déconnecter », dernier élément de l'écran : une fois la page défilée jusqu'au bout, il est au-dessus de la barre.
      await page.evaluate(() => (globalThis as any).scrollTo(0, (globalThis as any).document.documentElement.scrollHeight));
      const out = await box(page, '#sortir');
      expect(out.height).toBeGreaterThanOrEqual(48);
      expect(out.bottom).toBeLessThanOrEqual((await box(page, '#onglets')).top);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.skipIf(navigateur === null)('[DS066] au clavier, le premier arrêt est « Aller au contenu » : il se montre et mène au titre de l’écran', async () => {
    const page = await ouvrir({ width: 390, height: 844 });
    try {
      expect((await box(page, '#vers-contenu')).width).toBeLessThanOrEqual(1);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('vers-contenu');
      const shown = await box(page, '#vers-contenu');
      expect(shown.width).toBeGreaterThan(100);
      expect(shown.height).toBeGreaterThanOrEqual(48);
      // Sans lui, l'arrêt suivant est le premier onglet : les onglets viennent avant le contenu.
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('journee-ouvrir');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('bonjour');
    } finally {
      await page.close();
    }
  }, 60_000);

  it.skipIf(navigateur === null)('sur ordinateur, les onglets forment une colonne à gauche, à côté du contenu et jamais dessus', async () => {
    const page = await ouvrir({ width: 1280, height: 800 });
    try {
      const nav = await box(page, '#onglets');
      expect(nav.left).toBe(0);
      expect(nav.top).toBe(0);
      expect(Math.round(nav.bottom)).toBe(800);
      expect(nav.width).toBeLessThan(260);
      expect((await box(page, 'main')).left).toBeGreaterThanOrEqual(nav.right);
      const [a, b] = [await box(page, '#journee-ouvrir'), await box(page, '#outils-ouvrir')];
      expect(b.top).toBeGreaterThanOrEqual(a.bottom);
      expect(a.height).toBeGreaterThanOrEqual(48);
      // La marque, dans l'en-tête, reste lisible : la colonne passe sous lui.
      const brand = await page.evaluate(() => { const r = (globalThis as any).document.querySelector('.marque').getBoundingClientRect(); const e = (globalThis as any).document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e && e.className; });
      expect(brand).toBe('marque');
    } finally {
      await page.close();
    }
  }, 60_000);
});

afterAll(async () => { await navigateur?.close(); });
