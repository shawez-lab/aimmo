import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// DS064 · le focus suit l'écran. Tout est inventé : clé de test, prénom, réponses du serveur.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;

const ok = (data: unknown) => async () => Response.json({ ok: true, mode: 'essai', data });
const BASE: Record<string, () => Promise<Response>> = {
  '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
  '/v1/plan-du-jour': ok({ agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [], removed: { excluded: 0, withdrawn: 0, noBasis: 0 }, hiddenSinceFrozen: 0 }),
  '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
  '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
};

async function app() {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  runInNewContext(JS, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string) => (BASE[url] ? BASE[url]!() : Promise.reject(new TypeError('hors ligne'))),
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  const tick = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  return { els, document, tick };
}

/** Les écrans que `show` sait ouvrir, lus dans le script servi. */
const SCREENS: string[] = JSON.parse(JS.match(/function show\(id, args\) \{\s*(\[[^\]]+\])/)![1]!.replace(/'/g, '"'));
/** Le titre de chaque écran, tel que `show` le cherche. */
const titleOf = (id: string) => (id === 'accueil' ? 'bonjour' : id === 'fiche' ? 'fiche-nom' : `${id}-titre`);

describe('DS064 · le focus va au titre du nouvel écran', () => {
  it('au chargement, rien ne bouge ; ensuite, chaque écran ouvert donne le focus à son titre', async () => {
    const a = await app();
    expect(a.els.accueil!.hidden).toBe(false);
    // La page vient de s'ouvrir : le focus reste où le navigateur le met.
    expect(a.document.activeElement).toBeNull();
    a.els['partenaires-ouvrir']!.listeners.click!({});
    await a.tick();
    expect(a.els.partenaires!.hidden).toBe(false);
    expect(a.document.activeElement).toBe(a.els['partenaires-titre']);
    expect(a.els['partenaires-titre']!.attributes.tabindex).toBe('-1');
    a.els['partenaires-retour']!.listeners.click!({});
    await a.tick();
    expect(a.els.accueil!.hidden).toBe(false);
    expect(a.document.activeElement).toBe(a.els.bonjour);
    a.els['chiffres-ouvrir']!.listeners.click!({});
    await a.tick();
    expect(a.document.activeElement).toBe(a.els['chiffres-titre']);
    // Se déconnecter : le focus va au titre de la connexion, pas sur un bouton désormais caché.
    a.els.sortir!.listeners.click!({});
    await a.tick();
    expect(a.els.connexion!.hidden).toBe(false);
    expect(a.document.activeElement).toBe(a.els['connexion-titre']);
  });

  it('un écran redessiné sur place ne vole pas le focus à ce que l’agent touche', async () => {
    const a = await app();
    a.els['chiffres-ouvrir']!.listeners.click!({});
    await a.tick();
    const pressed = new FakeElement('button');
    pressed.focus();
    // Changer de période redessine le même écran : le focus reste sur le bouton touché.
    a.els['chiffres-precedent']!.listeners.click!({});
    await a.tick();
    expect(a.els.chiffres!.hidden).toBe(false);
    expect(a.document.activeElement).toBe(pressed);
  });

  it('chaque écran a un titre de niveau 2 que le focus rejoint, dans l’écran lui-même', () => {
    expect(SCREENS.length).toBeGreaterThan(20);
    const ids = pageIds(HTML);
    const starts = SCREENS.map((s) => HTML.indexOf(`<section id="${s}"`));
    for (const [i, s] of SCREENS.entries()) {
      // L'attente n'est qu'une ligne « Chargement… », sans écran ni titre ; l'écran sans réseau dessine son titre lui-même.
      if (s === 'attente') continue;
      if (s === 'hors-ligne') {
        expect(AGENT_APP_FILES['/app/hors-ligne.js']).toContain("el('h2', 'Mes visites sans réseau')).setAttribute('id', 'hors-ligne-titre')");
        continue;
      }
      expect(starts[i], s).toBeGreaterThanOrEqual(0);
      expect(ids, s).toContain(titleOf(s));
      // Le titre est le premier h2 de l'écran, avant l'écran suivant.
      const next = Math.min(...starts.filter((x) => x > starts[i]!), HTML.length);
      const first = HTML.slice(starts[i]!, next).match(/<h2\b[^>]*>/)?.[0];
      expect(first, s).toBe(`<h2 id="${titleOf(s)}">`);
    }
  });
});

/** La même chose dans Chromium, là où Playwright et son navigateur sont installés : sinon le test se signale sauté. */
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

describe('DS064 · dans Chromium', () => {
  it.skipIf(navigateur === null)('après l’ouverture d’un écran, l’élément actif est son titre, pas le corps de la page', async () => {
    const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.addInitScript((k: string) => (globalThis as any).localStorage.setItem('aimmo.cle', k), KEY);
      await page.route('**/*', async (route: any) => {
        const path = new URL(route.request().url()).pathname;
        const file = AGENT_APP_FILES[path];
        if (file !== undefined) {
          const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('/') ? 'text/html' : 'application/octet-stream';
          return route.fulfill({ status: 200, contentType: type, body: file });
        }
        const answer = BASE[path];
        if (answer) {
          const r = await answer();
          return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
        }
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
      });
      await page.goto('https://aimmo.example.test/app/');
      await page.waitForSelector('#accueil:not([hidden])');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.tagName)).toBe('BODY');
      await page.click('#partenaires-ouvrir');
      await page.waitForSelector('#partenaires:not([hidden])');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('partenaires-titre');
      await page.click('#partenaires-retour');
      await page.waitForSelector('#accueil:not([hidden])');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('bonjour');
    } finally {
      await page.close();
    }
  }, 60_000);
});

afterAll(async () => { await navigateur?.close(); });
