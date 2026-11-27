import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems, htmlProblems } from '../../core/src/design/audit.ts';
import { CLIENTS_SCRIPT } from '../app/clients.ts';
import { OREILLE_JS } from '../app/oreille.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { type FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// DS003 · la liste des clients de l'agent. Tout est inventé : clé de test, prénoms, noms, dates.
const HTML = AGENT_APP_FILES['/app/']!;
const CSS = AGENT_APP_FILES['/app/app.css']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const KEY = 'k'.repeat(40);
const INJECTED = '<img src=x onerror="alert(1)">';

type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const person = (i: number, first: string | null, last: string | null, lastContact: string | null) => ({ id: `p-${i}`, network_id: 'n1', first_name: first, last_name: last, language: 'fr', contact_status: 'active', last_contact_at: lastContact, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' });
const PEOPLE = [
  person(1, 'Élodie', 'Exemple', '2026-11-02T09:00:00.000Z'),
  person(2, 'Bruno', 'Inventé', null),
  person(3, 'Camille', 'Fictive', '2026-11-20T15:30:00.000Z'),
  person(4, null, null, '2026-10-01T08:00:00.000Z'),
  person(5, 'Aline', 'Modèle', null),
];
const DAY: Record<string, Answer> = {
  '/v1/plan-du-jour': ok({ agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', hiddenSinceFrozen: 0, items: [] }),
  '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
  '/v1/annonces': ok([]),
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
  const table: Record<string, Answer | null> = { ...DAY, '/v1/fiches': ok(PEOPLE), ...answers };
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
  const scripts = () => els.clients!.all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/clients.js');
  /** Le script de l'écran arrive, une fois, comme dans le navigateur. */
  const load = async () => {
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(CLIENTS_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  /** Un geste ; le script de l'écran se charge à sa première demande. */
  const click = async (e: FakeElement) => {
    e.listeners.click!({});
    await settle();
    await load();
  };
  const body = () => els['clients-corps']!;
  const list = () => body().all().find((e) => e.attributes.id === 'clients-liste')!;
  const rows = () => list().children.filter((li) => li.children[0]?.className === 'secondaire rangee');
  const names = () => rows().map((li) => li.all().find((e) => e.tagName === 'strong')!.textContent);
  const count = () => body().all().find((e) => e.tagName === 'p')!.textContent;
  const type = async (text: string) => {
    const input = body().all().find((e) => e.tagName === 'input')!;
    input.value = text;
    input.listeners.input!({});
    await settle();
  };
  const reads = () => calls.filter((c) => c === '/v1/fiches').length;
  const pop = async (state: unknown) => {
    onPop!({ state });
    await settle();
  };
  const title = (): string => (document as unknown as { title: string }).title;
  return { els, calls, table, states, storage, click, load, body, list, rows, names, count, type, reads, scripts, pop, title };
}

describe('DS003 · l’agent a la liste de ses clients, et y cherche par nom', () => {
  it('[R16] l’onglet « Clients » lit la liste des fiches de l’agent : le dernier échange d’abord, puis par nom ; chaque ligne ouvre la fiche', async () => {
    const a = await run();
    expect(a.reads()).toBe(0);
    await a.click(a.els['clients-ouvrir']!);
    expect(a.els.clients!.hidden).toBe(false);
    expect(a.reads()).toBe(1);
    expect(a.names()).toEqual(['Camille Fictive', 'Élodie Exemple', 'Sans nom', 'Aline Modèle', 'Bruno Inventé']);
    expect(a.rows().map((li) => li.all().find((e) => e.className === 'doux')!.textContent)).toEqual(['Dernier échange le 20/11/2026', 'Dernier échange le 02/11/2026', 'Dernier échange le 01/10/2026', 'Aucun échange noté', 'Aucun échange noté']);
    expect(a.count()).toBe('5 clients');
    expect(a.els['clients-etat']!.textContent).toBe('');
    // L'onglet est le repère, et le titre de la page ne dit aucun nom.
    expect(a.els['clients-ouvrir']!.attributes['aria-current']).toBe('page');
    expect(a.els['journee-ouvrir']!.attributes['aria-current']).toBeUndefined();
    // Une ligne ouvre la fiche de cette personne, et rien d'autre.
    await a.click(a.rows()[1]!.children[0]!);
    expect(a.els.fiche!.hidden).toBe(false);
    expect(a.calls).toContain('/v1/fiches/p-1/resume');
    expect(a.states.at(-1)).toEqual({ s: 'fiche', a: ['p-1'], t: 'clients' });
    // « Retour » de la fiche ramène à la liste, relue ; l'onglet reste « Clients ».
    await a.click(a.els.retour!);
    expect(a.els.clients!.hidden).toBe(false);
    expect(a.reads()).toBe(2);
    expect(a.names()).toHaveLength(5);
    expect(a.els['clients-ouvrir']!.attributes['aria-current']).toBe('page');
  });

  it('chercher par nom, sans accents ni capitales ; la recherche revient avec l’onglet, pas après la déconnexion', async () => {
    const a = await run();
    await a.click(a.els['clients-ouvrir']!);
    await a.type('elodie');
    expect(a.names()).toEqual(['Élodie Exemple']);
    expect(a.count()).toBe('1 sur 5');
    await a.type('MOD');
    expect(a.names()).toEqual(['Aline Modèle']);
    await a.type('zz');
    expect(a.names()).toEqual([]);
    expect(a.count()).toBe('Aucun client à ce nom.');
    // La recherche ne relit rien : elle cherche dans ce qui est déjà là.
    expect(a.reads()).toBe(1);
    await a.type('ine');
    expect(a.names()).toEqual(['Aline Modèle']);
    // Ouvrir une fiche puis revenir : la recherche est toujours là.
    await a.click(a.rows()[0]!.children[0]!);
    await a.click(a.els.retour!);
    expect(a.names()).toEqual(['Aline Modèle']);
    expect(a.body().all().find((e) => e.tagName === 'input')!.value).toBe('ine');
    // Se déconnecter efface tout : la liste, la recherche, et la clé.
    await a.click(a.els['outils-ouvrir']!);
    await a.click(a.els.sortir!);
    expect(a.body().children).toHaveLength(0);
    expect(a.storage.get('aimmo.cle')).toBeUndefined();
  });

  it('Jamais vu · chercher un nom comme on l’entend : mal écrit, entendu au téléphone ou dicté, il se trouve, après les noms exacts et dit comme tel', async () => {
    // Des noms inventés, courants, écrits comme l'état civil les écrit.
    const heard = [person(1, 'Philippe', 'Dupont', '2026-11-20T08:00:00.000Z'), person(2, 'Jacques', 'Lefebvre', '2026-11-19T08:00:00.000Z'), person(3, 'Wanda', 'Kowalski', '2026-11-18T08:00:00.000Z'), person(4, 'Laurent', 'Martin', '2026-11-17T08:00:00.000Z'), person(5, 'Maëlle', 'Quentin', null), person(6, 'Martine', 'Dupond', null)];
    const a = await run({ '/v1/fiches': ok(heard) });
    await a.click(a.els['clients-ouvrir']!);
    const notes = () => a.rows().map((li) => li.all().find((e) => e.className === 'doux')!.textContent);
    // Écrit comme on l'a entendu : aucun nom ne contient ces lettres, la recherche à l'oreille le trouve.
    for (const [typed, found] of [['filip', ['Philippe Dupont']], ['jack lefèvre', ['Jacques Lefebvre']], ['vanda kovalsqui', ['Wanda Kowalski']], ['lauran', ['Laurent Martin']], ['kantin', ['Maëlle Quentin']], ['FILIP DUPON', ['Philippe Dupont']]] as const) {
      await a.type(typed);
      expect(a.names(), typed).toEqual(found);
      expect(a.count(), typed).toBe('1 sur 6, dont 1 à l’oreille');
      expect(notes()[0], typed).toMatch(/^S’entend pareil\. /);
    }
    // Un nom exact passe d'abord, sans la mention ; celui qui s'entend pareil vient après, avec elle.
    await a.type('dupond');
    expect(a.names()).toEqual(['Martine Dupond', 'Philippe Dupont']);
    expect(a.count()).toBe('2 sur 6, dont 1 à l’oreille');
    expect(notes().map((n) => n.startsWith('S’entend pareil. '))).toEqual([false, true]);
    // La recherche exacte reste ce qu'elle était : elle ne perd rien, et ne dit rien de l'oreille quand elle suffit.
    await a.type('martin');
    expect(a.names()).toEqual(['Laurent Martin', 'Martine Dupond']);
    expect(a.count()).toBe('2 sur 6');
    // Moins de trois lettres : pas d'oreille, pour ne pas tout rapprocher.
    await a.type('fi');
    expect(a.names()).toEqual([]);
    expect(a.count()).toBe('Aucun client à ce nom.');
    // Rien ne part au serveur : tout se fait dans la liste déjà lue.
    expect(a.reads()).toBe(1);
    // Le champ dit ce qu'il sait faire.
    const label = a.body().all().find((e) => e.tagName === 'label')!;
    expect(label.textContent).toBe('Chercher par nom, même comme on l’entend');
    expect(label.attributes.for).toBe('clients-chercher');
  });

  it('Jamais vu · la clé « à l’oreille » : les écritures d’un même son se rejoignent, des noms différents restent différents', () => {
    const { sound, heardIn } = runInNewContext(`(function () {${OREILLE_JS}; return { sound: sound, heardIn: heardIn }; })()`) as { sound: (text: string) => string; heardIn: (key: string, typed: string) => boolean };
    const same: [string, string][] = [['Dupont', 'dupond'], ['Durand', 'durant'], ['Philippe', 'filip'], ['Kowalski', 'kovalsqui'], ['Wozniak', 'vozniak'], ['Laurent', 'lauran'], ['Jean', 'jan'], ['Martin', 'martain'], ['Lefebvre', 'lefèvre'], ['Jacques', 'jack'], ['Charles', 'charle'], ['Georges', 'jorje'], ['Quetigny', 'kétini'], ['Chenôve', 'chenove'], ['Thomas', 'toma'], ['Leroy', 'leroi'], ['Christian', 'kristian'], ['Gauthier', 'gotier'], ['Rousseau', 'rousso'], ['Schmitt', 'chmit'], ['Marchand', 'marchan'], ['Françoise', 'fransoise'], ['Exemple', 'exanple']];
    for (const [written, heard] of same) expect(sound(written), `${written} / ${heard}`).toBe(sound(heard));
    const apart: [string, string][] = [['Martin', 'marin'], ['Dupont', 'durand'], ['Petit', 'perrin'], ['Bruno', 'bruni'], ['Léa', 'lou'], ['Moreau', 'morel']];
    for (const [x, y] of apart) expect(sound(x), `${x} / ${y}`).not.toBe(sound(y));
    // Ce qui est tapé s'entend au début d'un mot : « lefev » dans « Jacques Lefebvre », pas au milieu d'un autre.
    const key = sound('Jacques Lefebvre');
    for (const typed of ['lefev', 'jack', 'jak lefèvre', 'Lefèvre']) expect(heardIn(key, typed), typed).toBe(true);
    for (const typed of ['febvre', 'le', 'ja', 'lefebvre 2', 'jacques@', '']) expect(heardIn(key, typed), typed).toBe(false);
    // Rien de vide ni d'étrange ne casse la clé ; un texte reçu reste un texte.
    expect(sound('')).toBe('');
    expect(sound(INJECTED)).toMatch(/^[a-z ]*$/);
    expect(OREILLE_JS).not.toMatch(/fetch|XMLHttpRequest|send\(|innerHTML/);
  });

  it('une longue liste : cinquante lignes, puis la suite par cinquante ; chercher repart du début', async () => {
    const many = Array.from({ length: 130 }, (_, i) => person(i + 1, `Prénom ${i + 1}`, 'Inventé', `2026-10-${String((i % 28) + 1).padStart(2, '0')}T08:00:00.000Z`));
    const a = await run({ '/v1/fiches': ok(many) });
    await a.click(a.els['clients-ouvrir']!);
    expect(a.rows()).toHaveLength(50);
    expect(a.count()).toBe('130 clients');
    const more = () => a.list().all().find((e) => e.tagName === 'button' && e.textContent.startsWith('Voir la suite'));
    expect(more()!.textContent).toBe('Voir la suite : 80 autres');
    expect(more()!.className).toBe('secondaire');
    await a.click(more()!);
    expect(a.rows()).toHaveLength(100);
    await a.click(more()!);
    expect(a.rows()).toHaveLength(130);
    expect(more()).toBeUndefined();
    await a.type('Prénom 1');
    expect(a.rows().length).toBeLessThanOrEqual(50);
    expect(a.count()).toBe('42 sur 130');
  });

  it('[R10] aucune fiche : dit simplement ; une lecture manquée n’est jamais « aucun client » : le bandeau, avec « Réessayer »', async () => {
    const none = await run({ '/v1/fiches': ok([]) });
    await none.click(none.els['clients-ouvrir']!);
    expect(none.count()).toBe('Aucun client pour le moment.');
    expect(none.rows()).toHaveLength(0);
    for (const [name, answer, text] of [['hors réseau', null, 'Pas de réseau.Réessayer'], ['panne', async () => new Response('{"ok":false}', { status: 500 }), 'Indisponible pour le moment.Réessayer'], ['réponse illisible', ok({ pas: 'une liste' }), 'Indisponible pour le moment.Réessayer']] as [string, Answer | null, string][]) {
      const a = await run({ '/v1/fiches': answer });
      await a.click(a.els['clients-ouvrir']!);
      expect(a.els['clients-etat']!.textContent, name).toBe(text);
      expect(a.els['clients-etat']!.children[0]!.className, name).toBe('alerte');
      expect(a.body().children, name).toHaveLength(0);
      // « Réessayer » relit la liste.
      a.table['/v1/fiches'] = ok(PEOPLE);
      await a.click(a.els['clients-etat']!.all().find((e) => e.tagName === 'button')!);
      expect(a.names(), name).toHaveLength(5);
      expect(a.els['clients-etat']!.textContent, name).toBe('');
    }
  });

  it('[R201] pendant que le script arrive, le dernier geste gagne : toucher « Clients » deux fois, ou partir et revenir, finit par montrer la liste', async () => {
    const a = await run();
    // Le script est demandé, mais n'est pas encore arrivé : l'essai ne le charge pas tout de suite.
    a.els['clients-ouvrir']!.listeners.click!({});
    await settle();
    expect(a.scripts()).toHaveLength(1);
    expect(a.els['clients-etat']!.textContent).toBe('Chargement…');
    // Un second appui, puis un détour par la journée et un retour : le script n'est demandé qu'une fois.
    a.els['clients-ouvrir']!.listeners.click!({});
    await settle();
    a.els['journee-ouvrir']!.listeners.click!({});
    await settle();
    a.els['clients-ouvrir']!.listeners.click!({});
    await settle();
    expect(a.scripts()).toHaveLength(1);
    expect(a.els.clients!.hidden).toBe(false);
    expect(a.els['clients-etat']!.textContent).toBe('Chargement…');
    expect(a.reads()).toBe(0);
    // Le script arrive : la liste se lit et se montre, une seule fois, pour l'écran ouvert.
    await a.load();
    expect(a.names()).toHaveLength(5);
    expect(a.els['clients-etat']!.textContent).toBe('');
    expect(a.scripts()).toHaveLength(1);
  });

  it('[R201] le script arrive après que l’agent est reparti : rien ne se dessine sur un écran quitté, et l’onglet rouvert se montre sans le redemander', async () => {
    const a = await run();
    a.els['clients-ouvrir']!.listeners.click!({});
    await settle();
    a.els['journee-ouvrir']!.listeners.click!({});
    await settle();
    expect(a.els.accueil!.hidden).toBe(false);
    // Le script arrive alors que la journée est à l'écran.
    await a.load();
    expect(a.els.accueil!.hidden).toBe(false);
    expect(a.body().children).toHaveLength(0);
    expect(a.reads()).toBe(0);
    await a.click(a.els['clients-ouvrir']!);
    expect(a.names()).toHaveLength(5);
    expect(a.scripts()).toHaveLength(1);
  });

  it('[R16] une clé refusée pendant la lecture ferme l’application ; quitter l’onglet efface la liste ; le Retour du navigateur la relit', async () => {
    const refused = await run({ '/v1/fiches': async () => Response.json({ ok: false, code: 'unauthorized' }, { status: 401 }) });
    await refused.click(refused.els['clients-ouvrir']!);
    expect(refused.els.connexion!.hidden).toBe(false);
    expect(refused.storage.get('aimmo.cle')).toBeUndefined();
    const a = await run();
    await a.click(a.els['clients-ouvrir']!);
    expect(a.names()).toHaveLength(5);
    await a.click(a.els['outils-ouvrir']!);
    expect(a.els.outils!.hidden).toBe(false);
    expect(a.body().children).toHaveLength(0);
    await a.pop({ s: 'clients', a: null, t: 'clients' });
    expect(a.els.clients!.hidden).toBe(false);
    expect(a.names()).toHaveLength(5);
    expect(a.reads()).toBe(2);
  });

  it('[R13] un nom hostile est posé en texte, jamais en HTML ; un identifiant qui n’en est pas un n’a pas de ligne', async () => {
    const a = await run({ '/v1/fiches': ok([person(1, INJECTED, INJECTED, null), { ...person(2, 'Faux', 'Identifiant', null), id: '../x' }, null, 'texte']) });
    await a.click(a.els['clients-ouvrir']!);
    expect(a.names()).toEqual([`${INJECTED} ${INJECTED}`]);
    expect(a.body().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(CLIENTS_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    expect(a.count()).toBe('1 client');
  });

  it('[R201] servi à part, chargé au seul geste, une seule fois, jamais gardé ; les budgets tiennent ; la page reste accessible', async () => {
    expect(AGENT_APP_FILES['/app/clients.js']).toBe(CLIENTS_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/clients.js');
    const served = handleAgentApp(new Request('https://x.test/app/clients.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: CLIENTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: CSS, js: JS }, BUDGETS.application)).toEqual([]);
    expect(htmlProblems(HTML)).toEqual([]);
    // La coquille ne porte ni la liste ni la recherche : seulement l'onglet, l'écran vide et le chargeur.
    expect(JS).not.toContain('Chercher par nom');
    const a = await run();
    expect(a.scripts()).toHaveLength(0);
    await a.click(a.els['clients-ouvrir']!);
    await a.click(a.els['outils-ouvrir']!);
    await a.click(a.els['clients-ouvrir']!);
    expect(a.scripts()).toHaveLength(1);
    // Le script ne lit qu'une route, celle des fiches de l'agent.
    expect(CLIENTS_SCRIPT.match(/'\/v1\/[^']*'/g)).toEqual(["'/v1/fiches'"]);
    // L'onglet est le deuxième, entre la journée et les outils, dans la même forme que les autres.
    expect([...HTML.matchAll(/<button id="([a-z]+)-ouvrir" type="button" class="discret"><svg viewBox="0 0 24 24" aria-hidden="true">/g)].map((m) => m[1])).toEqual(['journee', 'clients', 'outils', 'chiffres']);
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

describe('DS003 · dans Chromium', () => {
  it.skipIf(navigateur === null)('les onglets tiennent sur un téléphone ; une ligne de client se touche en entier ; chercher au clavier filtre la liste', async () => {
    const answers: Record<string, Answer> = { ...DAY, '/v1/fiches': ok(PEOPLE) };
    const page = await navigateur!.newPage({ viewport: { width: 320, height: 640 } });
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
      await page.waitForSelector('#accueil:not([hidden])');
      // Sur le plus petit téléphone, les cinq onglets tiennent, chacun à la taille du doigt, sans déborder.
      const tabs = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('#onglets button')].map((b: any) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), clipped: b.scrollWidth > b.clientWidth + 1 }; }));
      expect(tabs).toHaveLength(5);
      for (const t of tabs) {
        expect(t.w).toBeGreaterThanOrEqual(48);
        expect(t.h).toBeGreaterThanOrEqual(48);
        expect(t.clipped).toBe(false);
      }
      await page.click('#clients-ouvrir');
      await page.waitForSelector('#clients-liste button.rangee');
      expect(await page.title()).toBe('Mes clients · AIMMO');
      const rows = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('#clients-liste > li')].map((li: any) => { const r = li.getBoundingClientRect(), b = li.querySelector('button').getBoundingClientRect(); return { height: Math.round(r.height), full: Math.round(b.width) >= Math.round(r.width) - 1 && Math.round(b.height) >= Math.round(r.height) - 1 }; }));
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.height).toBeLessThanOrEqual(72);
        expect(row.height).toBeGreaterThanOrEqual(48);
        expect(row.full).toBe(true);
      }
      expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth > (globalThis as any).innerWidth)).toBe(false);
      // Le champ a son libellé ; taper filtre aussitôt.
      await page.getByLabel('Chercher par nom').fill('cam');
      await page.waitForFunction(() => (globalThis as any).document.querySelectorAll('#clients-liste > li').length === 1);
      expect(await page.evaluate(() => (globalThis as any).document.querySelector('#clients-liste strong').textContent)).toBe('Camille Fictive');
      // La ligne ouvre la fiche ; le titre de la page ne dit pas son nom ; « Retour » ramène à la liste filtrée.
      await page.click('#clients-liste button.rangee');
      await page.waitForSelector('#fiche:not([hidden])');
      expect(await page.title()).toBe('Fiche client · AIMMO');
      await page.click('#retour');
      await page.waitForSelector('#clients-liste button.rangee');
      expect(await page.evaluate(() => (globalThis as any).document.getElementById('clients-chercher').value)).toBe('cam');
    } finally {
      await page.close();
    }
  }, 60_000);
});
