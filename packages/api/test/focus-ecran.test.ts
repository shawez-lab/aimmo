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
  '/v1/plan-du-jour': ok({ agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: 'p-1', firstName: 'Léa', kind: 'callback', reason: 'A demandé à être rappelée', order: 'règle 1', basis: { kind: 'request', since: '2026-11-01', purpose: null }, projectId: null, taskId: 't-1', reportId: null }], removed: { excluded: 0, withdrawn: 0, noBasis: 0 }, hiddenSinceFrozen: 0 }),
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
    expect((a.els['partenaires-titre'] as unknown as { tabIndex: number }).tabIndex).toBe(-1);
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

  it('le titre qui reçoit le focus dit déjà quel écran s’ouvre, même avant la réponse du serveur', async () => {
    const a = await app();
    const voir = a.els.plan!.all().find((e) => e.tagName === 'button' && e.textContent === 'Voir la fiche')!;
    voir.listeners.click!({});
    // La fiche ne répond pas (pas de réseau) : le titre focalisé n'est pas vide pour autant.
    expect(a.els.fiche!.hidden).toBe(false);
    expect(a.document.activeElement).toBe(a.els['fiche-nom']);
    expect(a.els['fiche-nom']!.textContent).toBe('Fiche du client');
    await a.tick();
    expect(a.els['fiche-nom']!.textContent).toBe('Fiche du client');
    // La visite pose aussi un titre avant d'être lue, au lieu de le vider.
    expect(JS).toMatch(/\$\('visite-titre'\)\.textContent = 'Visite';\s*\$\('visite-etat'\)\.textContent = 'Chargement…';\s*show\('visite', \[id\]\);/);
    expect(JS).not.toContain("$('visite-titre').textContent = '';");
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
    // DS069 : la page de la direction porte tous les écrans, celui du réseau compris.
    const FULL = AGENT_APP_FILES['/app/reseau']!;
    const ids = pageIds(FULL);
    const starts = SCREENS.map((s) => FULL.indexOf(`<section id="${s}"`));
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
      const next = Math.min(...starts.filter((x) => x > starts[i]!), FULL.length);
      const first = FULL.slice(starts[i]!, next).match(/<h2\b[^>]*>/)?.[0];
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

describe('DS063 · le titre de la page dit l’écran, jamais une personne', () => {
  /** Le faux document ne porte pas le texte de la page : les titres écrits dans le HTML servi y sont remis. */
  const withTitles = async () => {
    const a = await app();
    for (const [, id, text] of HTML.matchAll(/<h2 id="([a-z-]+-titre)"[^>]*>([^<]+)<\/h2>/g)) if (a.els[id!]) a.els[id!]!.textContent = text!;
    return a;
  };

  it('chaque écran ouvert renomme la page ; la journée ne dit pas le prénom, la déconnexion rend « Connexion »', async () => {
    const a = await withTitles();
    const title = (): string => (a.document as unknown as { title: string }).title;
    expect(title()).toBe('Ma journée · AIMMO');
    expect(title()).not.toContain('Alex');
    a.els['outils-ouvrir']!.listeners.click!({});
    await a.tick();
    expect(title()).toBe('Outils · AIMMO');
    a.els['partenaires-ouvrir']!.listeners.click!({});
    await a.tick();
    expect(title()).toBe('Mes partenaires · AIMMO');
    a.els['chiffres-ouvrir']!.listeners.click!({});
    await a.tick();
    expect(title()).toBe('Mes chiffres · AIMMO');
    a.els.sortir!.listeners.click!({});
    await a.tick();
    expect(title()).toBe('Connexion · AIMMO');
  });

  it('la fiche d’un client s’appelle « Fiche client » : son nom n’est jamais dans le titre de la page', async () => {
    const a = await app();
    // Le plan du jour porte une personne : son bouton ouvre sa fiche.
    const open = a.els.plan!.all().find((e) => e.tagName === 'button' && e.textContent === 'Voir la fiche');
    expect(open).toBeDefined();
    open!.listeners.click!({});
    await a.tick();
    expect(a.els.fiche!.hidden).toBe(false);
    const title = (a.document as unknown as { title: string }).title;
    expect(title).toBe('Fiche client · AIMMO');
    expect(title).not.toContain('Léa');
  });

  it('le script ne lit le titre que dans l’écran : `titleOf`, et deux noms fixes pour la journée et la fiche', () => {
    expect(JS).toContain("document.title = (titled === 'accueil' ? 'Ma journée · ' : titled === 'fiche' ? 'Fiche client · ' : h && h.textContent ? h.textContent + ' · ' : '') + 'AIMMO';");
    // Aucun autre endroit n'écrit le titre de la page.
    expect(JS.match(/document\.title\s*=/g)).toHaveLength(1);
  });
});

describe('DS062 · l’écran de connexion n’est plus nu', () => {
  it('la marque dans l’en-tête, un titre, une seule phrase qui dit quoi faire, et la clé personnelle repliée', () => {
    expect(HTML).toContain('<header class="tete"><h1 class="marque">AIMMO</h1></header>');
    const login = /<section id="connexion" hidden>([\s\S]*?)<\/section>/.exec(HTML)![1]!;
    expect(login).toContain('<h2 id="connexion-titre">Connexion</h2>');
    // Une phrase, pas un mode d'emploi : hors du formulaire replié, un seul paragraphe.
    const open = login.replace(/<details>[\s\S]*?<\/details>/, '');
    expect(open.match(/<p>/g)).toHaveLength(1);
    expect(open).toContain('<p id="erreur" role="alert" hidden></p>');
    expect(open).toContain('demandez à la direction votre lien d’accès');
    expect(login).toContain('<details><summary>J’ai une clé personnelle</summary>');
    // Le seul geste montré d'emblée n'apparaît que si l'appareil a sa clé.
    expect(open).toContain('<button id="entrer-appareil" type="button" hidden>Entrer avec la clé de cet appareil</button>');
  });
});

describe('DS064 · dans Chromium', () => {
  it.skipIf(navigateur === null)('DS063 · le titre suit l’écran, et se précise quand le titre de l’écran se précise', async () => {
    const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.addInitScript((k: string) => (globalThis as any).localStorage.setItem('aimmo.cle', k), KEY);
      await page.route('**/*', async (route: any) => {
        const path = new URL(route.request().url()).pathname;
        const file = AGENT_APP_FILES[path];
        if (file !== undefined) return route.fulfill({ status: 200, contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('/') ? 'text/html' : 'application/octet-stream', body: file });
        const answer = BASE[path];
        if (answer) return route.fulfill({ status: 200, contentType: 'application/json', body: await (await answer()).text() });
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
      });
      await page.goto('https://aimmo.example.test/app/');
      await page.waitForSelector('#accueil:not([hidden])');
      expect(await page.title()).toBe('Ma journée · AIMMO');
      await page.click('#chiffres-ouvrir');
      await page.waitForSelector('#chiffres:not([hidden])');
      expect(await page.title()).toBe('Mes chiffres · AIMMO');
      // Un écran précise son titre après coup (« Mandat · REF-1 ») : la page suit, sans que l'écran ait à le demander.
      await page.evaluate(() => { (globalThis as any).document.getElementById('chiffres-titre').textContent = 'Mes chiffres · novembre'; });
      await page.waitForFunction(() => (globalThis as any).document.title === 'Mes chiffres · novembre · AIMMO');
      // L'écran quitté n'est plus écouté : son titre peut changer sans renommer la page.
      await page.click('#outils-ouvrir');
      await page.waitForSelector('#outils:not([hidden])');
      await page.evaluate(() => { (globalThis as any).document.getElementById('chiffres-titre').textContent = 'Autre chose'; });
      await page.waitForTimeout(50);
      expect(await page.title()).toBe('Outils · AIMMO');
    } finally {
      await page.close();
    }
  }, 60_000);


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
      // DS005 · les outils ont leur onglet : l'écran ouvert depuis eux y revient, et le focus suit chaque fois.
      await page.click('#outils-ouvrir');
      await page.waitForSelector('#outils:not([hidden])');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('outils-titre');
      await page.click('#partenaires-ouvrir');
      await page.waitForSelector('#partenaires:not([hidden])');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('partenaires-titre');
      await page.click('#partenaires-retour');
      await page.waitForSelector('#outils:not([hidden])');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('outils-titre');
      await page.click('#journee-ouvrir');
      await page.waitForSelector('#accueil:not([hidden])');
      expect(await page.evaluate(() => (globalThis as any).document.activeElement.id)).toBe('bonjour');
    } finally {
      await page.close();
    }
  }, 60_000);
});

afterAll(async () => { await navigateur?.close(); });
