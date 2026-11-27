import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { MES_BIENS_SCRIPT } from '../app/mes-biens.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { type FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// DS004 · la liste des biens de l'agent. Tout est inventé : clé de test, références, communes.
const HTML = AGENT_APP_FILES['/app/']!;
const CSS = AGENT_APP_FILES['/app/app.css']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const KEY = 'k'.repeat(40);
const INJECTED = '<img src=x onerror="alert(1)">';
const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const PLACES = [
  { id: id(1), reference: 'REF-1', city: 'Talant', state: 'en_vente', kind: 'home', rooms: 5, dwelling: 'house' },
  { id: id(2), reference: 'REF-2', city: 'Dijon', state: null, kind: 'home', rooms: 1, dwelling: 'apartment' },
  { id: id(3), reference: 'REF-3', city: 'Fontaine-lès-Dijon', state: 'sous_offre', kind: 'home', rooms: 4, dwelling: 'apartment' },
  { id: id(4), reference: 'REF-4', city: 'Dijon', state: 'en_vente', kind: 'commercial', rooms: null, dwelling: null },
  { id: id(5), reference: 'REF-5', city: null, state: null, kind: 'land', rooms: null, dwelling: null },
];
const DAY: Record<string, Answer> = {
  '/v1/plan-du-jour': ok({ agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', hiddenSinceFrozen: 0, items: [] }),
  '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
  '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
  '/v1/alertes-agent': ok({ alerts: [], more: false }),
  '/v1/offres/a-tenir': ok({ fonds: [], financement: [], echeances: [] }),
  '/v1/apres-vente/journee': ok({}),
  '/v1/usage/matin': ok({ scope: 'agent', openedDays: 0, days: [] }),
};
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer | null> = {}) {
  const states: { s: string; a: unknown; t: string }[] = [];
  let onPop: ((e: { state: unknown }) => void) | null = null;
  const { els, listeners, document } = fakeDocument(pageIds(HTML, false));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: string[] = [];
  const table: Record<string, Answer | null> = { ...DAY, '/v1/annonces': ok(PLACES), ...answers };
  const context: Record<string, unknown> = {
    document,
    Date,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string) => {
      calls.push(url);
      if (url === '/v1/moi') return ok({ role: 'agent', firstName: 'Alex' })();
      const answer = table[url];
      return answer ? answer() : Promise.reject(new TypeError('hors ligne'));
    },
    history: { pushState: (state: { s: string; a: unknown; t: string }) => states.push(state), replaceState: (state: { s: string; a: unknown; t: string }) => states.push(state) },
    addEventListener: (type: string, f: (e: { state: unknown }) => void) => { if (type === 'popstate') onPop = f; },
    location: { origin: 'https://app.aimmo.test', pathname: '/app/', hash: '', replace: () => undefined },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const scripts = () => els['mes-biens']!.all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/mes-biens.js');
  /** Un geste ; le script de l'écran se charge à sa première demande, comme dans le navigateur. */
  const click = async (e: FakeElement) => {
    e.listeners.click!({});
    await settle();
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(MES_BIENS_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const body = () => els['mes-biens-corps']!;
  const list = () => body().all().find((e) => e.attributes.id === 'mes-biens-liste')!;
  const rows = () => list().children.filter((li) => li.children[0]?.className === 'secondaire rangee');
  const names = () => rows().map((li) => li.all().find((e) => e.tagName === 'strong')!.textContent);
  const notes = () => rows().map((li) => li.all().find((e) => e.className === 'doux')!.textContent);
  const count = () => body().children.find((e) => e.tagName === 'p')!.textContent;
  const filter = () => body().all().find((e) => e.tagName === 'select');
  const type = async (text: string) => {
    const input = body().all().find((e) => e.tagName === 'input')!;
    input.value = text;
    input.listeners.input!({});
    await settle();
  };
  const choose = async (value: string) => {
    const pick = filter()!;
    pick.value = value;
    pick.listeners.change!({});
    await settle();
  };
  const reads = () => calls.filter((c) => c === '/v1/annonces').length;
  const pop = async (state: unknown) => {
    onPop!({ state });
    await settle();
  };
  return { els, calls, table, states, storage, click, body, list, rows, names, notes, count, filter, type, choose, reads, scripts, pop };
}

describe('DS004 · l’agent a la liste de ses biens, y cherche et la filtre', () => {
  it('[R16] l’onglet « Biens » lit les biens de l’agent : chacun dit ce qu’il est, puis sa référence et l’état de son annonce ; une ligne ouvre l’écran du bien', async () => {
    const a = await run();
    const before = a.reads();
    await a.click(a.els['mes-biens-ouvrir']!);
    expect(a.els['mes-biens']!.hidden).toBe(false);
    expect(a.els.accueil!.hidden).toBe(true);
    expect(a.reads()).toBe(before + 1);
    expect(a.names()).toEqual(['Maison 5 pièces · Talant', 'Appartement 1 pièce · Dijon', 'Appartement 4 pièces · Fontaine-lès-Dijon', 'Local commercial · Dijon', 'Terrain']);
    expect(a.notes()).toEqual(['Réf. REF-1, annonce en vente.', 'Réf. REF-2, pas encore publiée.', 'Réf. REF-3, annonce sous offre.', 'Réf. REF-4, annonce en vente.', 'Réf. REF-5, pas encore publiée.']);
    expect(a.count()).toBe('5 biens');
    expect(a.els['mes-biens-etat']!.textContent).toBe('');
    // L'onglet est le repère (le titre de la page, « Mes biens · AIMMO », est vérifié dans Chromium).
    expect(a.els['mes-biens-ouvrir']!.attributes['aria-current']).toBe('page');
    expect(a.els['journee-ouvrir']!.attributes['aria-current']).toBeUndefined();
    // Une ligne ouvre l'écran de ce bien (DS013), sans rien relire : la liste vient de le lire.
    const reads = a.reads();
    await a.click(a.rows()[2]!.children[0]!);
    expect(a.els['un-bien']!.hidden).toBe(false);
    expect(a.els['un-bien-titre']!.textContent).toBe('Appartement 4 pièces · Fontaine-lès-Dijon');
    expect(a.els['un-bien-etat']!.textContent).toBe('Réf. REF-3, annonce sous offre.');
    expect(a.reads()).toBe(reads);
    expect(a.states.at(-1)).toEqual({ s: 'un-bien', a: [id(3), 'REF-3', 'Appartement 4 pièces · Fontaine-lès-Dijon', 'sous_offre'], t: 'mes-biens' });
    // L'onglet reste « Biens » sur l'écran du bien, sans dire que c'est sa page.
    expect(a.els['mes-biens-ouvrir']!.attributes['aria-current']).toBe('true');
    // « Retour » de l'écran du bien ramène à la liste, relue ; un outil du bien y revient aussi, par le bien.
    await a.click(a.els['un-bien-retour']!);
    expect(a.els['mes-biens']!.hidden).toBe(false);
    expect(a.reads()).toBe(reads + 1);
    expect(a.names()).toHaveLength(5);
    await a.click(a.rows()[0]!.children[0]!);
    await a.click(a.els['un-bien-mandat']!);
    expect(a.els.mandat!.hidden).toBe(false);
    await a.click(a.els['mandat-retour']!);
    expect(a.els['un-bien']!.hidden).toBe(false);
    await a.click(a.els['un-bien-retour']!);
    expect(a.els['mes-biens']!.hidden).toBe(false);
  });

  it('chercher par genre, commune ou référence, sans accents ni capitales ; filtrer par état de l’annonce ; les deux reviennent avec l’onglet', async () => {
    const a = await run();
    await a.click(a.els['mes-biens-ouvrir']!);
    const reads = a.reads();
    await a.type('fontaine les');
    expect(a.names()).toEqual([]);
    await a.type('fontaine-les');
    expect(a.names()).toEqual(['Appartement 4 pièces · Fontaine-lès-Dijon']);
    expect(a.count()).toBe('1 sur 5');
    await a.type('DIJON');
    expect(a.names()).toEqual(['Appartement 1 pièce · Dijon', 'Appartement 4 pièces · Fontaine-lès-Dijon', 'Local commercial · Dijon']);
    await a.type('ref-5');
    expect(a.names()).toEqual(['Terrain']);
    await a.type('appartement');
    expect(a.names()).toHaveLength(2);
    await a.type('zz');
    expect(a.count()).toBe('Aucun bien ne correspond.');
    await a.type('');
    // Le filtre ne propose que les états présents dans la liste, dits en clair.
    expect(a.filter()!.children.map((o) => [o.attributes.value, o.textContent])).toEqual([['', 'Tous'], ['en_vente', 'En vente'], ['aucune', 'Pas encore publiée'], ['sous_offre', 'Sous offre']]);
    await a.choose('aucune');
    expect(a.names()).toEqual(['Appartement 1 pièce · Dijon', 'Terrain']);
    expect(a.count()).toBe('2 sur 5');
    await a.type('dijon');
    expect(a.names()).toEqual(['Appartement 1 pièce · Dijon']);
    // Chercher et filtrer ne relisent rien.
    expect(a.reads()).toBe(reads);
    // Ouvrir le bien puis revenir : la recherche et le filtre sont toujours là.
    await a.click(a.rows()[0]!.children[0]!);
    await a.click(a.els['un-bien-retour']!);
    expect(a.names()).toEqual(['Appartement 1 pièce · Dijon']);
    expect(a.body().all().find((e) => e.tagName === 'input')!.value).toBe('dijon');
    expect(a.filter()!.value).toBe('aucune');
    // Se déconnecter efface tout : la liste, la recherche, le filtre, et la clé.
    await a.click(a.els['outils-ouvrir']!);
    await a.click(a.els.sortir!);
    expect(a.body().children).toHaveLength(0);
    expect(a.storage.get('aimmo.cle')).toBeUndefined();
  });

  it('un seul état dans la liste : pas de filtre ; un état inconnu se dit « Publiée » ; une longue liste se déroule par cinquante', async () => {
    const same = await run({ '/v1/annonces': ok(PLACES.filter((p) => p.state === 'en_vente')) });
    await same.click(same.els['mes-biens-ouvrir']!);
    expect(same.filter()).toBeUndefined();
    expect(same.count()).toBe('2 biens');
    const odd = await run({ '/v1/annonces': ok([PLACES[0]!, { ...PLACES[1]!, state: 'etat_nouveau' }]) });
    await odd.click(odd.els['mes-biens-ouvrir']!);
    expect(odd.filter()!.children.map((o) => o.textContent)).toEqual(['Tous', 'En vente', 'Publiée']);
    expect(odd.notes()[1]).toBe('Réf. REF-2, annonce publiée.');
    const many = Array.from({ length: 130 }, (_, i) => ({ id: id(i + 1), reference: `REF-${i + 1}`, city: 'Dijon', state: null, kind: 'home', rooms: 3, dwelling: 'house' }));
    const a = await run({ '/v1/annonces': ok(many) });
    await a.click(a.els['mes-biens-ouvrir']!);
    expect(a.rows()).toHaveLength(50);
    expect(a.count()).toBe('130 biens');
    const more = () => a.list().all().find((e) => e.tagName === 'button' && e.textContent.startsWith('Voir la suite'));
    expect(more()!.textContent).toBe('Voir la suite : 80 autres');
    expect(more()!.className).toBe('secondaire');
    await a.click(more()!);
    await a.click(more()!);
    expect(a.rows()).toHaveLength(130);
    expect(more()).toBeUndefined();
    await a.type('ref-13');
    expect(a.rows()).toHaveLength(2);
  });

  it('[R10] aucun bien : dit simplement ; une lecture manquée n’est jamais « aucun bien » : le bandeau, avec « Réessayer »', async () => {
    const none = await run({ '/v1/annonces': ok([]) });
    await none.click(none.els['mes-biens-ouvrir']!);
    expect(none.count()).toBe('Aucun bien pour le moment.');
    expect(none.rows()).toHaveLength(0);
    for (const [name, answer, text] of [['hors réseau', null, 'Pas de réseau.Réessayer'], ['panne', async () => new Response('{"ok":false}', { status: 500 }), 'Indisponible pour le moment.Réessayer'], ['réponse illisible', ok({ pas: 'une liste' }), 'Indisponible pour le moment.Réessayer']] as const) {
      const a = await run();
      a.table['/v1/annonces'] = answer;
      await a.click(a.els['mes-biens-ouvrir']!);
      expect(a.els['mes-biens-etat']!.textContent, name).toBe(text);
      expect(a.els['mes-biens-etat']!.children[0]!.className, name).toBe('alerte');
      expect(a.body().children, name).toHaveLength(0);
      // « Réessayer » relit la liste.
      a.table['/v1/annonces'] = ok(PLACES);
      await a.click(a.els['mes-biens-etat']!.all().find((e) => e.tagName === 'button')!);
      expect(a.names(), name).toHaveLength(5);
      expect(a.els['mes-biens-etat']!.textContent, name).toBe('');
    }
  });

  it('[R13] un texte reçu reste un texte ; un identifiant mal formé n’a pas de ligne', async () => {
    const a = await run();
    // La liste abîmée n'arrive qu'à l'onglet : la journée a déjà lu la sienne.
    a.table['/v1/annonces'] = ok([{ ...PLACES[0]!, city: INJECTED, reference: INJECTED }, { ...PLACES[1]!, id: '../autre' }, null, 'x']);
    await a.click(a.els['mes-biens-ouvrir']!);
    expect(a.rows()).toHaveLength(1);
    expect(a.names()[0]).toBe(`Maison 5 pièces · ${INJECTED}`);
    expect(a.list().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(MES_BIENS_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('[R16] une clé refusée pendant la lecture ferme l’application ; quitter l’onglet efface la liste ; le Retour du navigateur la relit', async () => {
    const refused = await run();
    refused.table['/v1/annonces'] = async () => Response.json({ ok: false, code: 'unauthorized' }, { status: 401 });
    await refused.click(refused.els['mes-biens-ouvrir']!);
    expect(refused.els.connexion!.hidden).toBe(false);
    expect(refused.storage.get('aimmo.cle')).toBeUndefined();
    const a = await run();
    await a.click(a.els['mes-biens-ouvrir']!);
    expect(a.names()).toHaveLength(5);
    const state = a.states.at(-1)!;
    expect(state).toEqual({ s: 'mes-biens', a: null, t: 'mes-biens' });
    await a.click(a.els['journee-ouvrir']!);
    expect(a.els.accueil!.hidden).toBe(false);
    expect(a.body().children).toHaveLength(0);
    const reads = a.reads();
    await a.pop(state);
    expect(a.els['mes-biens']!.hidden).toBe(false);
    expect(a.reads()).toBe(reads + 1);
    expect(a.names()).toHaveLength(5);
    expect(a.els['mes-biens-ouvrir']!.attributes['aria-current']).toBe('page');
  });

  it('[R201] l’écran est servi à part, chargé une fois, hors de la coquille ; l’application tient son budget', async () => {
    expect(AGENT_APP_FILES['/app/mes-biens.js']).toBe(MES_BIENS_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/mes-biens.js');
    expect(JS).not.toContain('Chercher par genre');
    expect(budgetProblems({ html: '', js: MES_BIENS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: CSS, js: JS }, BUDGETS.application)).toEqual([]);
    const a = await run();
    expect(a.scripts()).toHaveLength(0);
    await a.click(a.els['mes-biens-ouvrir']!);
    await a.click(a.els['journee-ouvrir']!);
    await a.click(a.els['mes-biens-ouvrir']!);
    expect(a.scripts()).toHaveLength(1);
    expect(a.names()).toHaveLength(5);
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

describe('DS004 · dans Chromium', () => {
  it.skipIf(navigateur === null)('sur le plus petit téléphone : cinq onglets à la taille du doigt, des lignes entières à toucher, un filtre avec son libellé, rien ne déborde', async () => {
    const answers: Record<string, Answer> = { ...DAY, '/v1/annonces': ok(PLACES) };
    const page = await navigateur!.newPage({ viewport: { width: 320, height: 640 } });
    try {
      page.setDefaultTimeout(5000);
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
      await page.waitForSelector('#accueil:not([hidden])');
      const tabs = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('#onglets button')].map((b: any) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), clipped: b.scrollWidth > b.clientWidth, text: b.textContent }; }));
      expect(tabs.map((t: any) => t.text)).toEqual(['Journée', 'Clients', 'Biens', 'Outils', 'Chiffres']);
      for (const t of tabs) {
        expect(t.w).toBeGreaterThanOrEqual(48);
        expect(t.h).toBeGreaterThanOrEqual(48);
        expect(t.clipped).toBe(false);
      }
      await page.click('#mes-biens-ouvrir');
      await page.waitForSelector('#mes-biens-liste button.rangee');
      expect(await page.title()).toBe('Mes biens · AIMMO');
      const rows = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('#mes-biens-liste > li')].map((li: any) => { const r = li.getBoundingClientRect(), b = li.querySelector('button').getBoundingClientRect(); return { height: Math.round(r.height), full: Math.abs(b.width - r.width) < 1 && Math.abs(b.height - r.height) < 1 }; }));
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.height).toBeGreaterThanOrEqual(48);
        expect(row.height).toBeLessThanOrEqual(96);
        expect(row.full).toBe(true);
      }
      expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth > (globalThis as any).innerWidth)).toBe(false);
      // Le champ et le filtre ont leur libellé ; choisir un état filtre aussitôt.
      await page.getByLabel('État de l’annonce').selectOption('sous_offre');
      await page.waitForFunction(() => (globalThis as any).document.querySelectorAll('#mes-biens-liste > li').length === 1);
      await page.getByLabel('État de l’annonce').selectOption('');
      await page.getByLabel('Chercher par genre, commune ou référence').fill('terrain');
      await page.waitForFunction(() => (globalThis as any).document.querySelectorAll('#mes-biens-liste > li').length === 1);
      // La ligne ouvre l'écran du bien ; « Retour » ramène à la liste, la recherche gardée.
      await page.click('#mes-biens-liste button.rangee');
      await page.waitForSelector('#un-bien:not([hidden])');
      expect(await page.title()).toBe('Terrain · AIMMO');
      await page.click('#un-bien-retour');
      await page.waitForSelector('#mes-biens-liste button.rangee');
      expect(await page.inputValue('#mes-biens-chercher')).toBe('terrain');
    } finally {
      await page.close();
    }
  });
});
