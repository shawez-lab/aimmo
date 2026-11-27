import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { type FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// DS061 · une panne se voit et se rattrape. Tout est inventé : clé de test, prénoms, réponses du serveur.
const HTML = AGENT_APP_FILES['/app/']!;
const CSS = AGENT_APP_FILES['/app/app.css']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const KEY = 'k'.repeat(40);

type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const down: Answer = async () => new Response('{"ok":false}', { status: 503 });
const CONTACTS = [1, 2].map((i) => ({ personId: `p-${i}`, firstName: `Prénom ${i}`, reason: 'A demandé à être rappelé', overdue: false, dueAt: '2026-11-10T09:00:00.000Z' }));
const DAY = (): Record<string, Answer> => ({
  '/v1/plan-du-jour': ok({ agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', hiddenSinceFrozen: 0, items: [] }),
  '/v1/contacts-chauds': ok({ slot: 'morning', contacts: CONTACTS }),
  '/v1/annonces': ok([]),
  '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
  '/v1/alertes-agent': ok({ alerts: [], more: false }),
  '/v1/offres/a-tenir': ok({ fonds: [], financement: [], echeances: [] }),
  '/v1/apres-vente/journee': ok({}),
  '/v1/usage/matin': ok({ scope: 'agent', openedDays: 0, days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-0${i + 3}`, opened: false })) }),
});
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer | null>) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML, false));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: string[] = [];
  runInNewContext(JS, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string) => {
      calls.push(url);
      if (url === '/v1/moi') return ok({ role: 'agent', firstName: 'Alex' })();
      const answer = answers[url];
      return answer ? answer() : Promise.reject(new TypeError('hors ligne'));
    },
    history: { pushState: () => undefined, replaceState: () => undefined },
    location: { origin: 'https://app.aimmo.test', pathname: '/app/', hash: '', replace: () => undefined },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const count = (url: string): number => calls.filter((c) => c === url).length;
  return { els, calls, count, storage };
}
/** Le bandeau d'une zone d'état, et son bouton. */
const alertOf = (state: FakeElement) => state.children.find((c) => c.className === 'alerte');
const retryOf = (state: FakeElement) => alertOf(state)?.children.find((c) => c.tagName === 'button');

describe('DS061 · une panne ne ressemble pas à une aide : un bandeau, avec « Réessayer »', () => {
  it('[R10] une lecture de la journée en panne : le bandeau à la place de la phrase grise ; « Réessayer » relit la journée, et le bandeau part', async () => {
    const answers: Record<string, Answer | null> = { ...DAY(), '/v1/contacts-chauds': down };
    const a = await run(answers);
    const state = a.els['chauds-etat']!;
    expect(alertOf(state)).toBeDefined();
    expect(state.textContent).toBe('Indisponible pour le moment.Réessayer');
    // Le geste est discret : il ne dispute pas la place de l'action d'une ligne.
    expect(retryOf(state)!.className).toBe('discret');
    expect(a.els.chauds!.children).toHaveLength(0);
    // Les autres blocs sont lus, et ne portent aucun bandeau.
    for (const id of ['plan', 'rdv', 'a-tenir', 'reprendre', 'apres-jour', 'semaine']) expect(alertOf(a.els[`${id}-etat`]!), id).toBeUndefined();
    expect(a.count('/v1/contacts-chauds')).toBe(1);
    // La panne passe : un geste, et toute la journée est relue une fois.
    answers['/v1/contacts-chauds'] = DAY()['/v1/contacts-chauds']!;
    retryOf(state)!.listeners.click!({});
    await settle();
    expect(a.count('/v1/contacts-chauds')).toBe(2);
    expect(a.count('/v1/plan-du-jour')).toBe(2);
    expect(alertOf(state)).toBeUndefined();
    expect(a.els.chauds!.children.map((li) => li.children[0]!.textContent)).toEqual(['Prénom 1', 'Prénom 2']);
    // La clé reste : une panne n'est pas un refus.
    expect(a.storage.get('aimmo.cle')).toBe(KEY);
  });

  it('sans réseau, une réponse illisible : la même chose, jamais « rien »', async () => {
    const broken: [string, Answer | null][] = [['sans réseau', null], ['pas du JSON', async () => new Response('<html>', { status: 200 })], ['refus du serveur', async () => Response.json({ ok: false, code: 'panne' })]];
    for (const [name, answer] of broken) {
      const a = await run({ ...DAY(), '/v1/rendez-vous/jour': answer });
      expect(alertOf(a.els['rdv-etat']!), name).toBeDefined();
      expect(a.els['rdv-etat']!.textContent, name).toBe('Indisponible pour le moment.Réessayer');
    }
    // Un rendu qui dit lui-même qu'il n'a pas pu lire passe par le même bandeau.
    const a = await run({ ...DAY(), '/v1/offres/a-tenir': ok({ fonds: [] }) });
    expect(alertOf(a.els['a-tenir-etat']!)).toBeDefined();
  });

  it('une fiche qui ne s’ouvre pas : « Réessayer » rouvre la même fiche, relue', async () => {
    const answers: Record<string, Answer | null> = { ...DAY(), '/v1/fiches/p-1/resume': down };
    const a = await run(answers);
    a.els.chauds!.all().find((e) => e.tagName === 'button' && e.textContent === 'Voir la fiche')!.listeners.click!({});
    await settle();
    expect(a.els.fiche!.hidden).toBe(false);
    const state = a.els['fiche-etat']!;
    expect(state.textContent).toBe('Indisponible pour le moment.Réessayer');
    expect(a.count('/v1/fiches/p-1/resume')).toBe(1);
    retryOf(state)!.listeners.click!({});
    await settle();
    expect(a.count('/v1/fiches/p-1/resume')).toBe(2);
    // Toujours la fiche, pas la journée : rien d'autre n'est relu.
    expect(a.els.fiche!.hidden).toBe(false);
    expect(a.count('/v1/plan-du-jour')).toBe(1);
  });

  it('« Mes chiffres » en panne : le bandeau, et « Réessayer » relit les chiffres, même hors réseau', async () => {
    const a = await run(DAY());
    a.els['chiffres-ouvrir']!.listeners.click!({});
    await settle();
    const state = a.els['chiffres-etat']!;
    expect(state.textContent).toBe('Pas de réseau.Réessayer');
    const before = a.calls.filter((c) => c.startsWith('/v1/pilotage/mes-chiffres')).length;
    expect(before).toBeGreaterThan(0);
    retryOf(state)!.listeners.click!({});
    await settle();
    expect(a.calls.filter((c) => c.startsWith('/v1/pilotage/mes-chiffres')).length).toBe(before + 1);
    expect(a.els.chiffres!.hidden).toBe(false);
  });

  it('[R13] le bandeau est construit par le script sans HTML, et il part avec le prochain message écrit au même endroit', () => {
    expect(JS).toContain("state.appendChild(el('span', offline ? 'Pas de réseau.' : 'Indisponible pour le moment.', 'alerte')).appendChild(button('Réessayer', retry)).className = 'discret';");
    expect(JS).not.toMatch(/innerHTML|insertAdjacentHTML/);
    expect(CSS).toContain('.etat > .alerte { display: flex;');
    // Dans la journée, un bloc en panne reprend toute la largeur : le bandeau n'est pas écrasé à côté du titre.
    expect(CSS).toContain('#accueil > .bloc:has(.alerte) { display: block; }');
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

describe('DS061 · dans Chromium', () => {
  it.skipIf(navigateur === null)('deux lectures en panne : deux bandeaux d’une ligne, la journée reste courte, et « Réessayer » au clavier relit tout', async () => {
    const answers: Record<string, Answer> = { ...DAY(), '/v1/contacts-chauds': down, '/v1/rendez-vous/jour': down };
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
        const r = await answer();
        return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
      });
      await page.goto('https://aimmo.example.test/app/');
      await page.waitForSelector('#chauds-etat .alerte');
      const seen = await page.evaluate(() => {
        const d = (globalThis as any).document;
        const box = (e: any) => e.getBoundingClientRect();
        const alerts = [...d.querySelectorAll('#accueil .alerte')];
        const first = alerts[0] as any;
        const style = (globalThis as any).getComputedStyle(first);
        return {
          count: alerts.length,
          heights: alerts.map((e: any) => Math.round(box(e).height)),
          blocks: ['chauds', 'rdv'].map((id) => Math.round(box(d.getElementById(id).closest('.bloc')).height)),
          button: Math.round(box(first.querySelector('button')).height),
          tinted: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
          page: d.documentElement.scrollHeight / (globalThis as any).innerHeight,
          wide: d.documentElement.scrollWidth > (globalThis as any).innerWidth,
        };
      });
      expect(seen.count).toBe(2);
      // Une ligne : le texte à gauche, le geste à droite, à la taille du doigt.
      for (const h of seen.heights) expect(h).toBeLessThanOrEqual(64);
      expect(seen.button).toBeGreaterThanOrEqual(44);
      for (const h of seen.blocks) expect(h).toBeLessThanOrEqual(130);
      expect(seen.tinted).toBe(true);
      expect(seen.page).toBeLessThan(1.6);
      expect(seen.wide).toBe(false);
      // La panne passe : le bouton se prend au clavier, et les deux blocs sont relus.
      answers['/v1/contacts-chauds'] = DAY()['/v1/contacts-chauds']!;
      answers['/v1/rendez-vous/jour'] = DAY()['/v1/rendez-vous/jour']!;
      await page.focus('#chauds-etat .alerte button');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (globalThis as any).document.querySelectorAll('#accueil .alerte').length === 0 && (globalThis as any).document.querySelectorAll('#chauds > li').length === 2);
    } finally {
      await page.close();
    }
  }, 60_000);
});
