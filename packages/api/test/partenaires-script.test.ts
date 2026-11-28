import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems, gzipSize } from '../../core/src/design/audit.ts';
import { PARTENAIRES_JS, PARTENAIRES_SCRIPT } from '../app/partenaires.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : projets, clients, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const PROJECTS = [{ projectId: 'pr1', kind: 'sell', stage: 'new', firstName: 'Léa', properties: [{ propertyId: 'b1', reference: 'REF-T-1', postcode: '21000', city: 'Dijon' }], referrals: [] }];
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/partenaires/projets': ok({ projects: PROJECTS, page: 0, more: true }),
  'GET /v1/partenaires/projets?page=1': ok({ projects: PROJECTS, page: 1, more: false }),
};
const SERVED = { ...FakeElement.served };
afterEach(() => {
  FakeElement.served = { ...SERVED };
});

/** L'application dans un faux document. `arrives` : le script de l'écran arrive de lui-même, ou l'essai le fait arriver. */
async function run(arrives: 'seul' | 'à la main' = 'seul') {
  FakeElement.served = arrives === 'seul' ? { ...SERVED } : Object.fromEntries(Object.entries(SERVED).filter(([path]) => path !== '/app/partenaires.js'));
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: string[] = [];
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url}`);
      const a = BASE[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const scripts = () => Object.values(els).flatMap((e) => e.children).filter((e) => e.tagName === 'script' && e.attributes.src === '/app/partenaires.js');
  const arrive = async (at = 0) => {
    runInNewContext(PARTENAIRES_SCRIPT, context);
    scripts()[at]!.listeners.load!({});
    await settle();
  };
  const tap = async (e: FakeElement | undefined) => {
    if (!e) throw new Error('bouton absent');
    e.listeners.click!({});
    await settle();
  };
  const button = (text: string) => els['partenaires-corps']!.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const reads = () => calls.filter((c) => c.startsWith('GET /v1/partenaires/projets')).length;
  return { els, calls, scripts, arrive, tap, button, reads };
}

describe('DS068 · le dessin de l’écran « Partenaires » sort du script de l’application', () => {
  it('[R201] servi à part, sous la politique de l’application, dans le budget d’une page ; hors de la coquille gardée sans réseau', async () => {
    const r = handleAgentApp(new Request('https://aimmo.example.test/app/partenaires.js'))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await r.text()).toBe(PARTENAIRES_SCRIPT);
    expect(budgetProblems({ html: '', js: PARTENAIRES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(AGENT_APP_SHELL).not.toContain('/app/partenaires.js');
  });

  it('[R201] le script que chaque agent télécharge n’a plus le dessin de cet écran, et y regagne plus de 3 500 octets', () => {
    for (const text of ['Tirer au sort et proposer au client', 'Montrer au client le texte des rémunérations', 'Aucun projet suivi pour le moment.', 'Rouvrez les projets avant de recommencer.', 'Cochez le professionnel choisi par le client.']) {
      expect(JS, text).not.toContain(text);
      expect(PARTENAIRES_SCRIPT, text).toContain(text);
    }
    // Ce qui reste dans l'application : l'entrée, l'effacement à la sortie et le chargeur.
    expect(JS).toContain("withTool('partenaires', 'AIMMO_PARTENAIRES', 'partenaires-etat', 'partenaires'");
    expect(PARTENAIRES_JS).toContain('function wipePartenaires()');
    expect(gzipSize(JS + PARTENAIRES_SCRIPT) - gzipSize(JS)).toBeGreaterThan(3500);
  });

  it('rien de ce dont l’application se sert n’est parti avec l’écran : un nom du script, s’il sert aussi à l’application, y est déclaré', () => {
    // Le compteur des formulaires vivait avec cet écran, et la conformité s'en sert : il reste dans l'application.
    const names = [...PARTENAIRES_SCRIPT.matchAll(/^  (?:function|var) ([A-Za-z_][\w]*)/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain('formSeq');
    const orphans = names.filter((n) => new RegExp(`(?<![\\w$.'’])${n}(?![\\w$])`).test(JS) && !new RegExp(`(?:function|var) ${n}\\b|, ${n} = `).test(JS));
    expect(orphans).toEqual([]);
    expect(JS).toContain('var formSeq = 0;');
  });

  it('[R13] aucun HTML écrit, rien dans les journaux ni dans le stockage du navigateur', () => {
    expect(PARTENAIRES_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment/);
    expect(PARTENAIRES_SCRIPT).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB/);
  });

  it('un agent qui n’ouvre pas l’écran ne demande jamais ce script ; il arrive une fois, quels que soient les gestes ensuite', async () => {
    const t = await run();
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.scripts()).toEqual([]);
    expect(t.reads()).toBe(0);
    await t.tap(t.els['partenaires-ouvrir']);
    expect(t.els.partenaires!.hidden).toBe(false);
    expect(t.scripts()).toHaveLength(1);
    expect(t.reads()).toBe(1);
    expect(t.els['partenaires-corps']!.all().some((e) => e.tagName === 'h3' && e.textContent === 'Vendre · Léa')).toBe(true);
    expect(t.els['partenaires-etat']!.textContent).toBe('');
    // La page suivante, puis l'écran rouvert : le script reste celui qui est arrivé, la lecture se refait.
    await t.tap(t.button('Projets suivants'));
    expect(t.calls.at(-1)).toBe('GET /v1/partenaires/projets?page=1');
    expect(t.button('Projets précédents')).toBeDefined();
    await t.tap(t.els['partenaires-ouvrir']);
    expect(t.calls.at(-1)).toBe('GET /v1/partenaires/projets');
    expect(t.scripts()).toHaveLength(1);
    expect(t.reads()).toBe(3);
  });

  it('le script n’arrive pas : l’écran le dit, sans rien lire ni dessiner ; le geste suivant le redemande', async () => {
    const t = await run('à la main');
    await t.tap(t.els['partenaires-ouvrir']);
    expect(t.els.partenaires!.hidden).toBe(false);
    expect(t.els['partenaires-etat']!.textContent).toBe('Chargement…');
    expect(t.reads()).toBe(0);
    t.scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.els['partenaires-etat']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.els['partenaires-corps']!.children).toEqual([]);
    expect(t.reads()).toBe(0);
    await t.tap(t.els['partenaires-ouvrir']);
    expect(t.scripts()).toHaveLength(2);
    await t.arrive(1);
    expect(t.reads()).toBe(1);
    expect(t.els['partenaires-etat']!.textContent).toBe('');
    expect(t.button('Tirer au sort et proposer au client')).toBeDefined();
  });

  it('[R16] sortir pendant que le script arrive : rien n’est lu ni dessiné pour une session finie', async () => {
    const t = await run('à la main');
    await t.tap(t.els['partenaires-ouvrir']);
    t.els.sortir!.listeners.click!({});
    await settle();
    await t.arrive();
    expect(t.reads()).toBe(0);
    expect(t.els['partenaires-corps']!.children).toEqual([]);
    expect(t.els['partenaires-etat']!.textContent).toBe('');
    expect(t.els.connexion!.hidden).toBe(false);
  });

  it('quitter l’écran pendant que le script arrive : il ne dessine rien sur l’écran quitté', async () => {
    const t = await run('à la main');
    await t.tap(t.els['partenaires-ouvrir']);
    await t.tap(t.els['partenaires-retour']);
    await t.arrive();
    expect(t.els.partenaires!.hidden).toBe(true);
    expect(t.els['partenaires-corps']!.children).toEqual([]);
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

describe('DS068 · « Partenaires », dans Chromium', () => {
  it.skipIf(navigateur === null)('le script n’est demandé qu’au geste, une fois ; l’écran se dessine comme avant, et se rouvre sans le redemander', async () => {
    const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      page.setDefaultTimeout(5000);
      const asked: string[] = [];
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.addInitScript((k: string) => (globalThis as any).localStorage.setItem('aimmo.cle', k), KEY);
      await page.route('**/*', async (route: any) => {
        const url = new URL(route.request().url());
        const file = AGENT_APP_FILES[url.pathname];
        if (file !== undefined) {
          if (url.pathname.endsWith('.js')) asked.push(url.pathname);
          return route.fulfill({ status: 200, contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname === '/app/' ? 'text/html' : 'application/octet-stream', body: file });
        }
        const answer = BASE[`${route.request().method()} ${url.pathname}${url.search}`];
        if (!answer) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: await (await answer()).text() });
      });
      await page.goto('https://aimmo.example.test/app/');
      await page.waitForSelector('#accueil:not([hidden])');
      expect(asked).not.toContain('/app/partenaires.js');
      await page.click('#outils-ouvrir');
      await page.click('#partenaires-ouvrir');
      await page.waitForSelector('#partenaires-corps h3');
      expect(await page.textContent('#partenaires-corps h3')).toBe('Vendre · Léa');
      expect(await page.isVisible('text=Tirer au sort et proposer au client')).toBe(true);
      expect(await page.textContent('#partenaires-etat')).toBe('');
      await page.click('text=Projets suivants');
      await page.waitForSelector('text=Projets précédents');
      await page.click('#partenaires-retour');
      await page.click('#partenaires-ouvrir');
      await page.waitForSelector('#partenaires-corps h3');
      expect(asked.filter((a) => a === '/app/partenaires.js')).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
