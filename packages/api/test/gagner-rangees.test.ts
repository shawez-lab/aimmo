import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { GAGNER_CSS, GAGNER_SCRIPT } from '../app/gagner.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';

// DS014 · « Gagner des mandats » ne déplie plus sept outils l'un sous l'autre. Tout est inventé : clé de test, réponses.
const KEY = 'k'.repeat(40);
const TOOLS = ['Ouvrir la pige', 'Ouvrir ma tournée', 'Ouvrir la veille', 'Ouvrir mon site', 'Ouvrir mon calendrier', 'Ouvrir mes programmes', 'Calculer un viager'];

describe('DS014 · chaque outil fermé est une rangée, un bloc vide tient en une ligne', () => {
  it('les sept outils s’ouvrent par une rangée au trait, plus par un bouton plein', () => {
    for (const label of TOOLS) expect(GAGNER_SCRIPT, label).toContain(`button('${label}'`);
    // Chaque outil pose sa rangée, puis l'endroit où il s'ouvre : c'est ce que la feuille reconnaît.
    expect(GAGNER_SCRIPT.match(/b\.className = 'secondaire rangee';\n    box\.appendChild\(b\);\n    box\.appendChild\(inner\);/g)).toHaveLength(TOOLS.length);
    expect(GAGNER_SCRIPT.match(/box\.appendChild\(b\);\n    box\.appendChild\(inner\);/g)).toHaveLength(TOOLS.length);
  });

  it('[R201] la feuille : un outil fermé cache son titre et sa phrase, qui reviennent à l’ouverture ; rien que des jetons', () => {
    expect(GAGNER_CSS).toContain('#gagner-corps > .bloc:has(> .rangee + div:empty) > :is(h3, p) { display: none; }');
    expect(GAGNER_CSS).toContain('#gagner-corps > .bloc:has(> h3 + .doux):not(:has(> details, > .rangee)) { display: flex;');
    expect(AGENT_APP_FILES['/app/app.css']).toContain(GAGNER_CSS);
    // Aucune couleur écrite en dur dans ces règles : elles ne posent que de la mise en page.
    expect(GAGNER_CSS.slice(0, GAGNER_CSS.indexOf('.compte'))).not.toMatch(/rgb\(|hsl\(|#[0-9a-f]{6}\b/i);
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

const EMPTY: Record<string, unknown> = {
  '/v1/plan-du-jour': { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', hiddenSinceFrozen: 0, items: [] },
  '/v1/contacts-chauds': { slot: 'morning', contacts: [] },
  '/v1/annonces': [],
  '/v1/rendez-vous/jour': { day: '2026-11-10', appointments: [] },
  '/v1/gagner/rendez-vous': [],
  '/v1/gagner/recommandations/a-appeler': [],
  '/v1/gagner/relances': [],
  '/v1/gagner/lettres': { campaigns: [], properties: [] },
};

describe('DS014 · dans Chromium', () => {
  it.skipIf(navigateur === null)('l’écran sans rien à faire tient en un écran et demi, au lieu de 3,1 ; un outil ouvert retrouve son titre et sa phrase', async () => {
    const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.addInitScript((k: string) => (globalThis as any).localStorage.setItem('aimmo.cle', k), KEY);
      await page.route('**/*', async (route: any) => {
        const path = new URL(route.request().url()).pathname;
        const file = AGENT_APP_FILES[path];
        if (file !== undefined) return route.fulfill({ status: 200, contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('/') ? 'text/html' : 'application/octet-stream', body: file });
        if (path === '/v1/moi') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { role: 'agent', firstName: 'Alex' } }) });
        if (path in EMPTY) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mode: 'essai', data: EMPTY[path] }) });
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
      });
      await page.goto('https://aimmo.example.test/app/');
      await page.waitForSelector('#accueil:not([hidden])');
      await page.click('#outils-ouvrir');
      await page.click('#gagner-ouvrir');
      await page.waitForSelector('#gagner-corps .rangee');
      const closed = await page.evaluate((tools: string[]) => {
        const d = (globalThis as any).document;
        const shown = (e: any) => !!e && e.getClientRects().length > 0;
        const blocks = [...d.querySelectorAll('#gagner-corps > .bloc')] as any[];
        const tool = blocks.filter((b) => b.querySelector(':scope > .rangee'));
        return {
          screens: d.documentElement.scrollHeight / (globalThis as any).innerHeight,
          tools: tool.map((b) => ({ label: b.querySelector(':scope > .rangee').textContent, height: Math.round(b.getBoundingClientRect().height), title: shown(b.querySelector(':scope > h3')), sentence: shown(b.querySelector(':scope > p')) })),
          filled: [...d.querySelectorAll('#gagner button')].filter((b: any) => shown(b) && !/secondaire|second|retour|discret/.test(b.className)).map((b: any) => b.textContent),
          empty: blocks.filter((b) => !b.querySelector(':scope > .rangee, :scope > details')).map((b) => Math.round(b.getBoundingClientRect().height)),
          wide: d.documentElement.scrollWidth > (globalThis as any).innerWidth,
          order: tools.every((t) => tool.some((b) => b.querySelector(':scope > .rangee').textContent === t)),
        };
      }, TOOLS);
      expect(closed.order).toBe(true);
      expect(closed.tools.map((t: { label: string }) => t.label)).toEqual(TOOLS);
      // Fermé : la rangée seule, à la taille du doigt ; ni titre ni phrase.
      for (const t of closed.tools) {
        expect(t.height, t.label).toBeGreaterThanOrEqual(48);
        expect(t.height, t.label).toBeLessThanOrEqual(64);
        expect(t.title, t.label).toBe(false);
        expect(t.sentence, t.label).toBe(false);
      }
      // Aucun bouton plein visible : huit avant.
      expect(closed.filled).toEqual([]);
      // Les blocs sans rien à montrer : leur titre et leur état, serrés, 97 px avant.
      expect(closed.empty.length).toBeGreaterThanOrEqual(3);
      for (const h of closed.empty) expect(h).toBeLessThanOrEqual(80);
      expect(closed.screens).toBeLessThanOrEqual(1.6);
      expect(closed.wide).toBe(false);
      // Ouvrir la pige : son titre et sa phrase reviennent, au-dessus de la rangée, et l'outil s'ouvre dessous.
      await page.click('#gagner-corps .rangee');
      await page.waitForFunction(() => { const b = (globalThis as any).document.querySelector('#gagner-corps > .bloc:has(> .rangee)'); return b.querySelector(':scope > div').childNodes.length > 0; });
      const opened = await page.evaluate(() => {
        const b = (globalThis as any).document.querySelector('#gagner-corps > .bloc:has(> .rangee)');
        const shown = (e: any) => !!e && e.getClientRects().length > 0;
        return { title: shown(b.querySelector(':scope > h3')) && b.querySelector(':scope > h3').textContent, sentence: shown(b.querySelector(':scope > p')) && b.querySelector(':scope > p').textContent };
      });
      expect(opened.title).toBe('Annonces de particuliers');
      expect(opened.sentence).toBe('Votre file de pige : rien ne part d’AIMMO, vous collez vous-même le premier message.');
    } finally {
      await page.close();
    }
  }, 60_000);
});
