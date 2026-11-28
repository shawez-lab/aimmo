import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds, placeTool } from './fake-dom.ts';

// Tout est inventé : biens, clients, identifiants, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const settle = async () => {
  for (let i = 0; i < 24; i++) await new Promise((r) => setTimeout(r, 0));
};
const DAY: Record<string, Answer> = {
  '/v1/plan-du-jour': ok(null),
  '/v1/contacts-chauds': ok({ contacts: [{ personId: 'p1', firstName: 'Camille', lastName: 'Exemple', reason: 'À rappeler' }] }),
  '/v1/rendez-vous/jour': ok({ appointments: [] }),
  '/v1/usage/matin': ok(null),
  '/v1/annonces': ok([{ id: 'b1', reference: 'REF-T-1', city: 'Dijon', state: null }]),
  '/v1/annonces/b1/controle': ok({ complete: false, publishedPriceEur: null, text: '', items: [] }),
  '/v1/annonces/b1/brouillon': ok(null),
  '/v1/annonces/b1/publication': ok(null),

};
type Entry = { how: 'push' | 'replace'; s: string | null; url: string | undefined };

/** L'application dans un faux document, avec une barre d'adresse et un historique qui notent ce qu'on leur écrit. */
async function run(hash = '', role: 'agent' | 'direction' = 'agent') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: string[] = [];
  const entries: Entry[] = [];
  const location = { origin: 'https://app.aimmo.test', pathname: '/app/', hash, replace: () => undefined };
  let onPop: ((e: { state: unknown }) => void) | null = null;
  const write = (how: 'push' | 'replace') => (state: { s?: string } | null, _title: string, url?: string) => {
    entries.push({ how, s: state?.s ?? null, url });
    history.state = state;
    if (url !== undefined) location.hash = url.startsWith('#') ? url : '';
  };
  const history: { state: unknown; pushState: ReturnType<typeof write>; replaceState: ReturnType<typeof write> } = { state: null, pushState: write('push'), replaceState: write('replace') };
  runInNewContext(JS, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url === '/v1/moi') return ok({ role, firstName: 'Alex' })();
      return DAY[url] ? DAY[url]!() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    history,
    location,
    addEventListener: (type: string, f: (e: { state: unknown }) => void) => {
      if (type === 'popstate') onPop = f;
    },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (id: string) => {
    els[id]!.listeners.click!({});
    await settle();
  };
  /** Un geste sur un élément que le script a posé, ou sur un bouton de la page. */
  const tap = async (e: FakeElement) => {
    e.listeners.click!({});
    await settle();
  };
  const shown = () => Object.keys(els).filter((id) => /^(accueil|clients|mes-biens|outils|chiffres|fiche|un-bien|vente|mandat|offres|avis|studio|dossier|bien|visite|partenaires|apres|louer|investir|commerces|gagner|connexion|attente|reseau|conformite)$/.test(id) && !els[id]!.hidden);
  /** Les adresses écrites, dans l'ordre, sans les écritures qui n'en donnent pas. */
  const urls = () => entries.filter((e) => e.url !== undefined).map((e) => e.url);
  const pop = async (state: unknown) => {
    onPop!({ state });
    await settle();
  };
  return { els, calls, entries, urls, location, history, click, tap, shown, pop };
}
const ADDRESS = /^(\/app\/|#[a-z-]+(\/[A-Za-z0-9_-]{1,64}){0,2})$/;

describe('DS007 · une adresse par écran', () => {
  it('chaque écran qui sait se rouvrir écrit la sienne ; la journée garde celle de l’application', async () => {
    const t = await run();
    // Le premier écran ne touche pas à l'adresse : c'est celle qui a ouvert l'application.
    expect(t.entries).toEqual([{ how: 'replace', s: 'accueil', url: undefined }]);
    await t.click('clients-ouvrir');
    await t.click('mes-biens-ouvrir');
    await t.click('outils-ouvrir');
    await t.click('chiffres-ouvrir');
    await t.click('journee-ouvrir');
    expect(t.urls()).toEqual(['#clients', '#mes-biens', '#outils', '#chiffres', '/app/']);
    expect(t.location.hash).toBe('');
    // Un bien, puis un de ses outils : l'écran, l'identifiant et la référence, rien d'autre.
    await t.tap(placeTool(t.els, 'Mettre en vente'));
    expect(t.urls().slice(-2)).toEqual(['#un-bien/b1/REF-T-1', '#vente/b1/REF-T-1']);
    expect(t.location.hash).toBe('#vente/b1/REF-T-1');
    await t.click('vente-retour');
    await t.click('un-bien-mandat');
    expect(t.urls().at(-1)).toBe('#mandat/b1/REF-T-1');
    for (const url of t.urls()) expect(url, url).toMatch(ADDRESS);
  });

  it('[R13] aucune donnée de client dans l’adresse : la fiche d’un client s’écrit par son identifiant interne', async () => {
    const t = await run();
    await t.tap(t.els.chauds!.all().find((e) => e.tagName === 'button')!);
    expect(t.els.fiche!.hidden).toBe(false);
    expect(t.urls().at(-1)).toBe('#fiche/p1');
    expect(t.urls().join(' ')).not.toMatch(/Camille|Exemple/);
    // Le nom d'un bien, sa ville et son état restent dans l'écran : l'adresse n'en prend que l'identifiant et la référence.
    await t.click('journee-ouvrir');
    await t.tap(placeTool(t.els, 'Mandat'));
    expect(t.urls().join(' ')).not.toMatch(/Dijon/);
    for (const url of t.urls()) expect(url, url).toMatch(ADDRESS);
  });

  it('recharger, ouvrir un second onglet, un favori : l’écran de l’adresse se rouvre par-dessus la journée, et « Retour » y ramène', async () => {
    const t = await run('#vente/b1/REF-T-1');
    expect(t.shown()).toEqual(['vente']);
    expect(t.calls).toContain('GET /v1/annonces/b1/controle');
    // La journée a été lue d'abord, et son entrée d'historique a l'adresse de l'application ; l'écran demandé vient par-dessus.
    expect(t.calls).toContain('GET /v1/plan-du-jour');
    expect(t.entries.map((e) => [e.how, e.s, e.url])).toEqual([
      ['replace', 'accueil', undefined],
      ['replace', 'accueil', '/app/'],
      ['push', 'vente', '#vente/b1/REF-T-1'],
    ]);
    expect(t.els['vente-bien']!.textContent).toContain('Réf. REF-T-1');
    // La page vient de se charger : comme le premier écran, celui-ci ne déplace pas le focus (DS064) ; le suivant, si.
    expect(FakeElement.active).toBeNull();
    await t.click('chiffres-ouvrir');
    expect(FakeElement.active).toBe(t.els['chiffres-titre']);
    await t.pop({ s: 'accueil', a: null, t: 'accueil' });
    expect(t.shown()).toEqual(['accueil']);
    // Un onglet, par son adresse.
    const tab = await run('#chiffres');
    expect(tab.shown()).toEqual(['chiffres']);
    expect(tab.els['chiffres-ouvrir']!.attributes['aria-current']).toBe('page');
    const tools = await run('#outils');
    expect(tools.shown()).toEqual(['outils']);
    const client = await run('#fiche/p1');
    expect(client.shown()).toEqual(['fiche']);
    expect(client.calls).toContain('GET /v1/fiches/p1/resume');
    // L'adresse ne sert qu'une fois : revenir à la journée ne rouvre rien.
    await client.click('journee-ouvrir');
    expect(client.shown()).toEqual(['accueil']);
    expect(client.location.hash).toBe('');
  });

  it('[R16] rien d’autre n’entre par l’adresse : un écran inconnu, un identifiant mal formé, un nombre d’identifiants faux, un nom d’objet', async () => {
    // Ce que lit une ouverture sans adresse : toute autre lecture viendrait de l'adresse.
    const plain = new Set((await run()).calls);
    for (const hash of ['#onglets', '#connexion', '#attente', '#reseau', '#conformite', '#mandat', '#mandat/b1', '#mandat/b1/REF/x', '#fiche', '#fiche/p1/p2', '#fiche/..%2Fmoi', '#fiche/<img>', '#vente/b1/a b', '#clients/p1', '#constructor', '#__proto__', '#toString/a/b', '#hasOwnProperty/a', '#', '#/', '#accueil']) {
      const t = await run(hash);
      expect(t.shown(), hash).toEqual(['accueil']);
      expect(t.entries, hash).toEqual([{ how: 'replace', s: 'accueil', url: undefined }]);
      expect(t.calls.filter((c) => !plain.has(c)), hash).toEqual([]);
    }
  });

  it('un lien d’envoi se lit encore après l’ouverture de la journée, qui n’efface pas l’adresse : il ouvre les outils', async () => {
    const t = await run('#envoi=abc');
    expect(t.shown()).toEqual(['outils']);
    expect(t.entries.map((e) => [e.how, e.s, e.url])).toEqual([
      ['replace', 'accueil', undefined],
      ['push', 'outils', '#outils'],
    ]);
  });

  it('à la sortie, l’adresse redevient celle de l’application : le suivant sur cet appareil ne rouvre rien', async () => {
    const t = await run();
    await t.click('clients-ouvrir');
    expect(t.location.hash).toBe('#clients');
    await t.click('outils-ouvrir');
    await t.click('sortir');
    expect(t.shown()).toEqual(['connexion']);
    expect(t.entries.at(-1)).toEqual({ how: 'replace', s: null, url: '/app/' });
    expect(t.location.hash).toBe('');
  });

  it('la direction n’a pas d’écran d’agent à rouvrir : une adresse d’agent ne lui ouvre rien', async () => {
    const t = await run('#fiche/p1', 'direction');
    expect(t.shown()).not.toContain('fiche');
    expect(t.calls).not.toContain('GET /v1/fiches/p1/resume');
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

describe('DS007 · dans Chromium', () => {
  it.skipIf(navigateur === null)('l’adresse suit l’écran ; recharger garde l’écran ; « Retour » du navigateur ramène à la journée, à l’adresse de l’application', async () => {
    const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.addInitScript((k: string) => (globalThis as any).localStorage.setItem('aimmo.cle', k), KEY);
      await page.route('**/*', async (route: any) => {
        const url = new URL(route.request().url());
        const file = AGENT_APP_FILES[url.pathname];
        if (file !== undefined) return route.fulfill({ status: 200, contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname === '/app/' ? 'text/html' : 'application/octet-stream', body: file });
        if (url.pathname === '/v1/moi') return route.fulfill({ status: 200, contentType: 'application/json', body: await (await ok({ role: 'agent', firstName: 'Alex' })()).text() });
        const answer = DAY[url.pathname];
        if (!answer || route.request().method() !== 'GET') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: await (await answer()).text() });
      });
      const hash = () => page.evaluate(() => (globalThis as any).location.hash);
      const visible = (id: string) => page.evaluate((i: string) => !(globalThis as any).document.getElementById(i).hidden, id);
      await page.goto('https://aimmo.example.test/app/');
      await page.waitForSelector('#accueil:not([hidden])');
      expect(await hash()).toBe('');
      await page.click('#chiffres-ouvrir');
      await page.waitForSelector('#chiffres:not([hidden])');
      expect(await hash()).toBe('#chiffres');
      await page.click('#journee-ouvrir');
      await page.waitForSelector('#accueil:not([hidden])');
      expect(await hash()).toBe('');
      await page.click('#biens button.rangee');
      await page.waitForSelector('#un-bien:not([hidden])');
      expect(await hash()).toBe('#un-bien/b1/REF-T-1');
      await page.click('#un-bien-vente');
      await page.waitForSelector('#vente:not([hidden])');
      expect(await hash()).toBe('#vente/b1/REF-T-1');
      // Recharger : la journée se lit, puis l'écran de l'adresse revient par-dessus.
      await page.reload();
      await page.waitForSelector('#vente:not([hidden])');
      expect(await hash()).toBe('#vente/b1/REF-T-1');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.tagName)).toBe('BODY');
      expect(await page.textContent('#vente-bien')).toContain('Réf. REF-T-1');
      // « Retour » du navigateur : la journée, à l'adresse de l'application.
      await page.goBack();
      await page.waitForSelector('#accueil:not([hidden])');
      expect(await hash()).toBe('');
      expect(await visible('vente')).toBe(false);
      // Une adresse fabriquée n'ouvre rien : la journée, et rien de caché.
      await page.goto('https://aimmo.example.test/app/#onglets');
      await page.reload();
      await page.waitForSelector('#accueil:not([hidden])');
      expect(await visible('onglets')).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
