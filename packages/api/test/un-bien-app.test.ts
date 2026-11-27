import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { filledButtons } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { type FakeElement, fakeDocument, pageIds, placeTool } from './fake-dom.ts';

// DS013 · un bien a son écran. Tout est inventé : clé de test, biens, références, communes.
const HTML = AGENT_APP_FILES['/app/']!;
const CSS = AGENT_APP_FILES['/app/app.css']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const KEY = 'k'.repeat(40);
const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';

type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const PLACES = [
  { id: B1, reference: 'REF-1', city: 'Talant', state: 'en_vente', kind: 'home', rooms: 5, dwelling: 'house' },
  { id: B2, reference: 'REF-2', city: 'Dijon', state: null, kind: 'home', rooms: 1, dwelling: 'apartment' },
];
const DAY = (places: unknown[] = PLACES): Record<string, Answer> => ({
  '/v1/plan-du-jour': ok({ agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', hiddenSinceFrozen: 0, items: [] }),
  '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
  '/v1/annonces': ok(places),
  '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
  '/v1/alertes-agent': ok({ alerts: [], more: false }),
  '/v1/offres/a-tenir': ok({ fonds: [], financement: [], echeances: [] }),
  '/v1/apres-vente/journee': ok({}),
  '/v1/usage/matin': ok({ scope: 'agent', openedDays: 0, days: [] }),
});
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = DAY()) {
  const states: { s: string; a: unknown; t: string }[] = [];
  let onPop: ((e: { state: unknown }) => void) | null = null;
  const { els, listeners, document } = fakeDocument(pageIds(HTML, false));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: string[] = [];
  runInNewContext(JS, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string) => {
      calls.push(url);
      if (url === '/v1/moi') return ok({ role: 'agent', firstName: 'Alex' })();
      return answers[url] ? answers[url]!() : Promise.reject(new TypeError('hors ligne'));
    },
    history: { pushState: (state: { s: string; a: unknown; t: string }) => states.push(state), replaceState: (state: { s: string; a: unknown; t: string }) => states.push(state) },
    addEventListener: (type: string, f: (e: { state: unknown }) => void) => { if (type === 'popstate') onPop = f; },
    location: { origin: 'https://app.aimmo.test', pathname: '/app/', hash: '', replace: () => undefined },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (e: FakeElement) => {
    e.listeners.click!({});
    await settle();
  };
  const pop = async (state: unknown) => {
    onPop!({ state });
    await settle();
  };
  const shown = (): string[] => ['accueil', 'un-bien', 'vente', 'mandat', 'offres', 'avis', 'studio', 'outils'].filter((id) => els[id]!.hidden === false);
  const title = (): string => (document as unknown as { title: string }).title;
  return { els, calls, states, click, pop, shown, title };
}
const rowsOf = (list: FakeElement) => list.all().filter((e) => e.tagName === 'button');

describe('DS023 · un bien se dit par ce qu’il est, sa référence en petit', () => {
  it('le genre, les pièces, la commune ; puis la référence et l’état de l’annonce', async () => {
    const places = [
      ...PLACES,
      { id: '33333333-3333-4333-8333-333333333333', reference: 'REF-3', city: null, state: 'sous_offre', kind: 'home', rooms: null, dwelling: null },
      { id: '44444444-4444-4444-8444-444444444444', reference: 'REF-4', city: 'Beaune', state: null, kind: 'land', rooms: null, dwelling: null },
      { id: '55555555-5555-4555-8555-555555555555', reference: 'REF-5', city: 'Dijon', state: 'vendu', kind: 'business', rooms: 3, dwelling: 'house' },
      { id: '66666666-6666-4666-8666-666666666666', reference: 'REF-6', city: 'Dijon', state: null, kind: 'commercial', rooms: null, dwelling: null },
      // Une réponse plus ancienne, sans le genre : le bien reste nommé, sans rien inventer.
      { id: '77777777-7777-4777-8777-777777777777', reference: 'REF-7', city: 'Dijon', state: null },
    ];
    const a = await run(DAY(places));
    // La liste montre cinq lignes, puis la suite (DS002) : on déroule tout.
    const more = rowsOf(a.els.biens!).find((b) => b.textContent.startsWith('Voir la suite'));
    if (more) await a.click(more);
    expect(a.els.biens!.children.map((li) => li.textContent)).toEqual([
      'Maison 5 pièces · TalantRéf. REF-1, annonce en vente.',
      'Appartement 1 pièce · DijonRéf. REF-2, pas encore publiée.',
      'LogementRéf. REF-3, annonce sous offre.',
      'Terrain · BeauneRéf. REF-4, pas encore publiée.',
      'Fonds de commerce · DijonRéf. REF-5, annonce vendu.',
      'Local commercial · DijonRéf. REF-6, pas encore publiée.',
      'Bien · DijonRéf. REF-7, pas encore publiée.',
    ]);
  });

  it('DS041 · chaque bien est une seule ligne à toucher : plus de cinq boutons pleins par bien', async () => {
    const a = await run();
    for (const li of a.els.biens!.children) {
      const buttons = li.all().filter((e) => e.tagName === 'button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.className).toBe('secondaire rangee');
    }
    expect(JS).not.toContain("button('Avis de valeur'");
  });
});

describe('DS013 · un bien a son écran : son nom, où il en est, ses outils en rangées', () => {
  it('la ligne ouvre l’écran du bien ; chaque rangée ouvre son outil pour ce bien ; « Retour » de l’outil ramène au bien', async () => {
    const a = await run();
    await a.click(rowsOf(a.els.biens!)[0]!);
    expect(a.shown()).toEqual(['un-bien']);
    expect(a.els['un-bien-titre']!.textContent).toBe('Maison 5 pièces · Talant');
    expect(a.els['un-bien-etat']!.textContent).toBe('Réf. REF-1, annonce en vente.');
    expect(a.els['un-bien-vente']!.textContent).toBe('Voir l’annonce');
    expect(a.title()).toBe('Maison 5 pièces · Talant · AIMMO');
    for (const tool of ['vente', 'mandat', 'offres', 'avis', 'studio']) {
      await a.click(a.els[`un-bien-${tool}`]!);
      expect(a.shown(), tool).toEqual([tool]);
      // L'outil s'ouvre pour ce bien : c'est lui, et sa référence, que l'écran reçoit.
      expect(a.states.at(-1), tool).toEqual({ s: tool, a: [B1, 'REF-1'], t: 'accueil' });
      await a.click(a.els[`${tool}-retour`]!);
      expect(a.shown(), tool).toEqual(['un-bien']);
      expect(a.els['un-bien-titre']!.textContent).toBe('Maison 5 pièces · Talant');
    }
    // La mise en vente lit bien ce bien-là, et son titre porte sa référence.
    expect(a.calls).toContain(`/v1/annonces/${B1}/controle`);
    expect(a.els['vente-titre']!.textContent).toBe('');
    await a.click(a.els['un-bien-vente']!);
    expect(a.els['vente-titre']!.textContent).toBe('Mettre en vente · REF-1');
    await a.click(a.els['vente-retour']!);
    // « Retour » de l'écran du bien ramène à la journée, relue.
    const reads = a.calls.filter((c) => c === '/v1/annonces').length;
    await a.click(a.els['un-bien-retour']!);
    expect(a.shown()).toEqual(['accueil']);
    expect(a.calls.filter((c) => c === '/v1/annonces').length).toBe(reads + 1);
  });

  it('un bien pas encore publié propose « Mettre en vente » ; le second bien de la liste ouvre le sien', async () => {
    const a = await run();
    const tool = placeTool(a.els, 'Mettre en vente', 1);
    expect(a.els['un-bien-titre']!.textContent).toBe('Appartement 1 pièce · Dijon');
    expect(a.els['un-bien-etat']!.textContent).toBe('Réf. REF-2, pas encore publiée.');
    expect(tool.textContent).toBe('Mettre en vente');
    await a.click(tool);
    expect(a.calls).toContain(`/v1/annonces/${B2}/controle`);
    expect(a.calls).not.toContain(`/v1/annonces/${B1}/controle`);
  });

  it('le bien ouvert s’oublie quand on le quitte : un outil ouvert d’ailleurs revient à la journée, pas à un ancien bien', async () => {
    const a = await run();
    await a.click(rowsOf(a.els.biens!)[0]!);
    await a.click(a.els['outils-ouvrir']!);
    expect(a.shown()).toEqual(['outils']);
    // Un écran de bien ouvert par l'historique, sans passer par l'écran du bien : son « Retour » va à la journée.
    await a.pop({ s: 'vente', a: [B2, 'REF-2'], t: 'accueil' });
    expect(a.shown()).toEqual(['vente']);
    await a.click(a.els['vente-retour']!);
    expect(a.shown()).toEqual(['accueil']);
  });

  it('le bouton Retour du navigateur rouvre l’écran du bien, avec son nom et son état', async () => {
    const a = await run();
    await a.click(rowsOf(a.els.biens!)[0]!);
    const state = a.states.at(-1)!;
    expect(state).toEqual({ s: 'un-bien', a: [B1, 'REF-1', 'Maison 5 pièces · Talant', 'en_vente'], t: 'accueil' });
    await a.click(a.els['un-bien-mandat']!);
    expect(a.shown()).toEqual(['mandat']);
    await a.pop(state);
    expect(a.shown()).toEqual(['un-bien']);
    expect(a.els['un-bien-titre']!.textContent).toBe('Maison 5 pièces · Talant');
    // Puis le « Retour » d'un outil ramène toujours au bien.
    await a.click(a.els['un-bien-offres']!);
    await a.click(a.els['offres-retour']!);
    expect(a.shown()).toEqual(['un-bien']);
    // Un identifiant qui n'en est pas un n'ouvre rien.
    await a.pop({ s: 'un-bien', a: ['../x', 'REF-9', 'Faux', ''], t: 'accueil' });
    expect(a.els['un-bien-titre']!.textContent).toBe('Maison 5 pièces · Talant');
  });

  it('[R201] l’écran est dans la page, sans bouton plein : cinq rangées, et un seul « Retour » de la même forme partout', () => {
    const screen = /<section id="un-bien" hidden>([\s\S]*?)<\/section>/.exec(HTML)![1]!;
    expect(screen).toContain('<button id="un-bien-retour" type="button" class="retour">Retour</button>');
    expect([...screen.matchAll(/<button id="un-bien-([a-z]+)" type="button" class="secondaire rangee">([^<]+)<\/button>/g)].map((m) => [m[1], m[2]])).toEqual([['vente', 'Annonce'], ['mandat', 'Mandat'], ['offres', 'Offres'], ['avis', 'Avis de valeur'], ['studio', 'Studio']]);
    expect(filledButtons(`<main>${screen}</main>`)).toEqual([]);
    // DS037 · le retour de ces écrans a une seule forme : « Retour », fléché, jamais un bouton plein.
    for (const id of ['retour', 'visite-retour', 'vente-retour', 'mandat-retour', 'offres-retour', 'avis-retour', 'studio-retour', 'dossier-retour']) expect(HTML, id).toContain(`<button id="${id}" type="button" class="retour">Retour</button>`);
    expect(HTML).not.toContain('Retour à ma journée</button>');
    expect(CSS).toContain('button.rangee > span { display: grid;');
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

describe('DS013, DS041 · dans Chromium', () => {
  it.skipIf(navigateur === null)('une ligne de bien fait 72 px au plus et se touche en entier ; l’écran du bien tient en un écran, ses rangées à la taille du doigt', async () => {
    const answers = DAY();
    const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.addInitScript((k: string) => (globalThis as any).localStorage.setItem('aimmo.cle', k), KEY);
      await page.route('**/*', async (route: any) => {
        const path = new URL(route.request().url()).pathname;
        const file = AGENT_APP_FILES[path];
        if (file !== undefined) return route.fulfill({ status: 200, contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('/') ? 'text/html' : 'application/octet-stream', body: file });
        if (path === '/v1/moi') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { role: 'agent', firstName: 'Alex' } }) });
        const answer = answers[path];
        if (!answer) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: await (await answer()).text() });
      });
      await page.goto('https://aimmo.example.test/app/');
      await page.waitForSelector('#biens button.rangee');
      const rows = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('#biens > li')].map((li: any) => { const r = li.getBoundingClientRect(), b = li.querySelector('button').getBoundingClientRect(); return { height: Math.round(r.height), full: Math.round(b.width) >= Math.round(r.width) - 1 && Math.round(b.height) >= Math.round(r.height) - 1 }; }));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.height).toBeLessThanOrEqual(72);
        expect(row.height).toBeGreaterThanOrEqual(48);
        expect(row.full).toBe(true);
      }
      await page.click('#biens button.rangee');
      await page.waitForSelector('#un-bien:not([hidden])');
      expect(await page.title()).toBe('Maison 5 pièces · Talant · AIMMO');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('un-bien-titre');
      const screen = await page.evaluate(() => {
        const d = (globalThis as any).document;
        return { page: d.documentElement.scrollHeight / (globalThis as any).innerHeight, rows: [...d.querySelectorAll('#un-bien > button.rangee')].map((b: any) => Math.round(b.getBoundingClientRect().height)), wide: d.documentElement.scrollWidth > (globalThis as any).innerWidth };
      });
      expect(screen.page).toBeLessThanOrEqual(1);
      expect(screen.rows).toHaveLength(5);
      for (const h of screen.rows) expect(h).toBeGreaterThanOrEqual(48);
      expect(screen.wide).toBe(false);
      // Retour du navigateur depuis un outil : on retrouve le bien.
      await page.click('#un-bien-vente');
      await page.waitForSelector('#vente:not([hidden])');
      await page.goBack();
      await page.waitForSelector('#un-bien:not([hidden])');
      expect(await page.evaluate(() => (globalThis as any).document.getElementById('un-bien-titre').textContent)).toBe('Maison 5 pièces · Talant');
    } finally {
      await page.close();
    }
  }, 60_000);
});
