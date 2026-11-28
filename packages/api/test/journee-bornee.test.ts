import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { HAUTEUR_MAX, screenHeightProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { type FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// DS001, DS002 · la journée de l'agent, bornée. Tout est inventé : clé de test, prénoms, biens, rendez-vous.
const HTML = AGENT_APP_FILES['/app/']!;
const CSS = AGENT_APP_FILES['/app/app.css']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const KEY = 'k'.repeat(40);

type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const contacts = (n: number) => Array.from({ length: n }, (_, i) => ({ personId: `p-${i + 1}`, firstName: `Prénom ${i + 1}`, reason: 'A demandé à être rappelé', overdue: i < 3, dueAt: '2026-11-10T09:00:00.000Z' }));
const properties = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b-${i + 1}`, reference: `REF-${i + 1}`, city: 'Dijon', state: null }));
const appointments = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r-${i + 1}`, kind: 'estimation', start: `2026-11-10T${String(8 + i).padStart(2, '0')}:00:00.000Z`, end: `2026-11-10T${String(8 + i).padStart(2, '0')}:45:00.000Z`, firstName: `Client ${i + 1}`, status: 'booked', brief: null, briefMissing: 'not_ready' }));
const plan = (n: number) => ({ agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', hiddenSinceFrozen: 0, items: Array.from({ length: n }, (_, i) => ({ rank: i + 1, personId: `p-${i + 1}`, firstName: `Prénom ${i + 1}`, kind: 'callback', reason: 'A demandé à être rappelé', order: 'règle 1', basis: null, projectId: null, taskId: null, priority: null })) });
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};
const DAY = (hot: number, goods: number, rdv = 0, lines = 0): Record<string, Answer> => ({
  '/v1/plan-du-jour': ok(plan(lines)),
  '/v1/contacts-chauds': ok({ slot: 'morning', contacts: contacts(hot) }),
  '/v1/annonces': ok(properties(goods)),
  '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: appointments(rdv) }),
  // Une journée sans rien répond partout : une lecture en panne n'est pas « rien » (DS061, R10).
  '/v1/alertes-agent': ok({ alerts: [], more: false }),
  '/v1/offres/a-tenir': ok({ fonds: [], financement: [], echeances: [] }),
  '/v1/apres-vente/journee': ok({}),
  '/v1/usage/matin': ok({ scope: 'agent', openedDays: 0, days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-0${i + 3}`, opened: false })) }),
});

async function run(answers: Record<string, Answer>) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML, false));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  runInNewContext(JS, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string) => (url === '/v1/moi' ? ok({ role: 'agent', firstName: 'Alex' })() : answers[url] ? answers[url]!() : Promise.reject(new TypeError('hors ligne'))),
    history: { pushState: () => undefined, replaceState: () => undefined },
    location: { origin: 'https://app.aimmo.test', pathname: '/app/', hash: '', replace: () => undefined },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  return { els };
}
/** Les lignes d'une liste, et le bouton « Voir la suite » s'il y est. */
const rows = (list: FakeElement) => list.children.filter((li) => !li.children.some((c) => c.tagName === 'button' && c.textContent.startsWith('Voir la suite')));
const more = (list: FakeElement) => list.all().find((e) => e.tagName === 'button' && e.textContent.startsWith('Voir la suite'));

describe('DS002 · une liste de la journée montre cinq lignes, puis propose la suite', () => {
  it('douze contacts chauds : cinq d’abord, dans l’ordre reçu, puis les sept autres au geste ; rien n’est perdu', async () => {
    const a = await run(DAY(12, 0));
    const list = a.els.chauds!;
    expect(rows(list).map((li) => li.children[0]!.textContent)).toEqual(['Prénom 1', 'Prénom 2', 'Prénom 3', 'Prénom 4', 'Prénom 5']);
    expect(more(list)!.textContent).toBe('Voir la suite : 7 autres');
    // Le bouton est filaire : il ne dispute pas la place de l'action d'une ligne.
    expect(more(list)!.className).toBe('secondaire');
    more(list)!.listeners.click!({});
    expect(rows(list).map((li) => li.children[0]!.textContent)).toEqual(Array.from({ length: 12 }, (_, i) => `Prénom ${i + 1}`));
    expect(more(list)).toBeUndefined();
    // Chaque ligne, montrée d'abord ou ensuite, garde son bouton vers la fiche.
    expect(rows(list).every((li) => li.all().some((e) => e.tagName === 'button' && e.textContent === 'Voir la fiche'))).toBe(true);
  });

  it('un portefeuille chargé se déroule par vingt : mille rappels ne font jamais mille lignes d’un coup', async () => {
    const a = await run(DAY(1000, 400));
    expect(rows(a.els.chauds!)).toHaveLength(5);
    expect(more(a.els.chauds!)!.textContent).toBe('Voir la suite : 995 autres');
    more(a.els.chauds!)!.listeners.click!({});
    expect(rows(a.els.chauds!)).toHaveLength(25);
    expect(more(a.els.chauds!)!.textContent).toBe('Voir la suite : 975 autres');
    // La suite reste à la fin de la liste, après les lignes montrées.
    expect(a.els.chauds!.children.at(-1)!.all()).toContain(more(a.els.chauds!));
    expect(rows(a.els.biens!)).toHaveLength(5);
    expect(more(a.els.biens!)!.textContent).toBe('Voir la suite : 395 autres');
  });

  it('six lignes se montrent toutes : un bouton pour une seule ligne ne ferait rien gagner', async () => {
    const six = await run(DAY(6, 6));
    expect(rows(six.els.chauds!)).toHaveLength(6);
    expect(more(six.els.chauds!)).toBeUndefined();
    expect(rows(six.els.biens!)).toHaveLength(6);
    const seven = await run(DAY(7, 0));
    expect(rows(seven.els.chauds!)).toHaveLength(5);
    expect(more(seven.els.chauds!)!.textContent).toBe('Voir la suite : 2 autres');
  });

  it('ni les rendez-vous du jour ni le plan ne sont repliés : une heure de rendez-vous ne se cache pas', async () => {
    const a = await run(DAY(0, 0, 9, 9));
    expect(a.els.rdv!.children).toHaveLength(9);
    expect(a.els.plan!.children).toHaveLength(9);
    expect(more(a.els.rdv!)).toBeUndefined();
    expect(more(a.els.plan!)).toBeUndefined();
    // Seules ces deux listes le sont, nommées dans le script : les autres gardent leurs lignes, que leur script retire une à une.
    expect(JS).toContain("if (id === 'chauds' || id === 'biens') fold(list);");
  });
});

describe('DS001 · la journée dit d’abord le jour, et un bloc vide se réduit à une ligne', () => {
  it('sous le bonjour, la date du jour, en mots ; elle s’efface avec la session', async () => {
    const a = await run(DAY(0, 0));
    expect(a.els.bonjour!.textContent).toBe('Bonjour Alex');
    expect(a.els.jour!.textContent).toMatch(/^(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche) \d{1,2}(er)? \p{L}+$/u);
    a.els.sortir!.listeners.click!({});
    expect(a.els.jour!.textContent).toBe('');
    expect(a.els.bonjour!.textContent).toBe('');
  });

  it('[R201] un bloc dont la liste est vide tient sur une ligne, son titre et son état côte à côte, sans rien cacher', () => {
    // DS060 : la même règle sert « Aujourd'hui » de la direction et « À décider » du responsable de la conformité.
    expect(CSS).toContain(':is(#accueil, #reseau-p-jour, #conformite-corps) > .bloc:has(> .liste:empty) { display: flex;');
    expect(CSS).toMatch(/:is\(#accueil, #reseau-p-jour, #conformite-corps\) > \.bloc:has\(> \.liste:empty\) > h3 \{ margin: 0; font: 500 var\(--t-s\)\/1\.5 var\(--police-texte\);/);
    // Aucun bloc n'est caché : « Indisponible » ou « Chargement… » se lisent toujours, à côté de leur titre.
    expect(CSS).not.toMatch(/#accueil[^{]*\{[^}]*display: none/);
    // Chaque liste de la journée est écrite vide dans la page, sans blanc : la règle s'applique dès l'ouverture.
    const home = HTML.slice(HTML.indexOf('<section id="accueil"'), HTML.indexOf('<section id="outils"'));
    expect(home.match(/<(ul|ol) id="[a-z-]+" class="liste"><\/\1>/g)).toHaveLength(8);
    // « Mes ventes conclues » n'est plus un bouton de la journée : c'est une rangée des outils.
    expect(home).not.toContain('apres-ouvrir');
    expect(home.match(/<button\b/g)).toHaveLength(1);
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

async function ouvrir(answers: Record<string, Answer>) {
  const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript((k: string) => (globalThis as any).localStorage.setItem('aimmo.cle', k), KEY);
  await page.route('**/*', async (route: any) => {
    const path = new URL(route.request().url()).pathname;
    const file = AGENT_APP_FILES[path];
    if (file !== undefined) {
      const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('/') ? 'text/html' : 'application/octet-stream';
      return route.fulfill({ status: 200, contentType: type, body: file });
    }
    if (path === '/v1/moi') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { role: 'agent', firstName: 'Alex' } }) });
    const answer = answers[path];
    if (answer) return route.fulfill({ status: 200, contentType: 'application/json', body: await (await answer()).text() });
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
  });
  await page.goto('https://aimmo.example.test/app/');
  await page.waitForSelector('#accueil:not([hidden])');
  await page.waitForFunction(() => !(globalThis as any).document.getElementById('chauds-etat').textContent.includes('Chargement'));
  return page;
}
const measure = (page: any) => page.evaluate(() => ({ heightPx: (globalThis as any).document.documentElement.scrollHeight, viewportPx: (globalThis as any).innerHeight, buttons: (globalThis as any).document.querySelectorAll('#accueil button').length }));
const heightOf = (page: any, id: string) => page.evaluate((i: string) => (globalThis as any).document.getElementById(i).closest('.bloc').getBoundingClientRect().height, id);

describe('DS001, DS002 · dans Chromium', () => {
  it.skipIf(navigateur === null)('avec 1 000 rappels et 400 biens, la journée tient sous la hauteur permise, au lieu de 288 écrans', async () => {
    const page = await ouvrir(DAY(1000, 400, 2, 3));
    try {
      const m = await measure(page);
      expect(screenHeightProblems([{ name: 'journée, portefeuille chargé', heightPx: m.heightPx, viewportPx: m.viewportPx }])).toEqual([]);
      expect(m.heightPx / m.viewportPx).toBeLessThan(HAUTEUR_MAX.ecrans);
      // 2 019 boutons avant ; ici ceux de cinq contacts, de cinq biens, des rendez-vous, du plan et des deux suites.
      expect(m.buttons).toBeLessThan(60);
      // La suite se déroule par vingt, sans recharger la page.
      await page.click('#chauds button.secondaire');
      expect(await page.evaluate(() => (globalThis as any).document.querySelectorAll('#chauds > li').length)).toBe(26);
    } finally {
      await page.close();
    }
  }, 60_000);

  it.skipIf(navigateur === null)('une journée sans rien tient en un écran et quart, au lieu de 5,4 : chaque bloc vide fait une ligne, un bloc rempli garde sa place', async () => {
    const empty = await ouvrir(DAY(0, 0));
    try {
      const m = await measure(empty);
      expect(m.heightPx).toBeLessThanOrEqual(1.25 * m.viewportPx);
      // Une ligne, deux quand le titre et l'état ne tiennent pas côte à côte sur un téléphone.
      for (const id of ['chauds', 'rdv', 'biens', 'plan']) expect(await heightOf(empty, id), id).toBeLessThanOrEqual(72);
      // Le titre et l'état se lisent tous deux, sur la même ligne quand elle suffit.
      const line = await empty.evaluate(() => { const b = (globalThis as any).document.getElementById('plan').closest('.bloc'); const [h, p] = [b.querySelector('h3'), b.querySelector('.etat')].map((e: any) => e.getBoundingClientRect()); return { same: Math.abs(h.bottom - p.bottom) < 6, text: b.querySelector('.etat').textContent, shown: p.width > 0 && h.width > 0 }; });
      expect(line).toEqual({ same: true, text: 'Rien au plan aujourd’hui.', shown: true });
    } finally {
      await empty.close();
    }
    const full = await ouvrir(DAY(2, 0));
    try {
      expect(await heightOf(full, 'chauds')).toBeGreaterThan(150);
      expect(await heightOf(full, 'biens')).toBeLessThanOrEqual(72);
    } finally {
      await full.close();
    }
  }, 60_000);
});

afterAll(async () => { await navigateur?.close(); });
