import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { gzipSize } from '../../core/src/design/audit.ts';
import { RESEAU_HTML } from '../app/fichiers.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

const HTML = AGENT_APP_FILES['/app/']!;
const PAGE = AGENT_APP_FILES['/app/reseau']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const AGENT = 'a'.repeat(40);
const DIRECTION = 'd'.repeat(40);

type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};
const idsOf = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);

/**
 * Une page ouverte dans un navigateur : celle de l'agent (`/app/`, sans l'écran de la direction) ou celle de la
 * direction (`/app/reseau`). Le rôle rendu par `/v1/moi` est celui de la clé présentée.
 */
async function run(path: '/app/' | '/app/reseau', stored: Record<string, string>, network: 'là' | 'coupé' = 'là', content: 'la sienne' | 'la coquille' = 'la sienne') {
  // « la coquille » : l'adresse de la direction, servie sans réseau par la page de l'agent gardée sur l'appareil.
  const { els, listeners, document } = fakeDocument(pageIds(HTML, path === '/app/reseau' && content === 'la sienne'));
  const storage = new Map<string, string>(Object.entries(stored));
  const calls: string[] = [];
  const asked: (string | null)[] = [];
  const went: string[] = [];
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (network === 'coupé') return Promise.reject(new TypeError('hors ligne'));
      if (url === '/app/reseau') return Promise.resolve(new Response(null, { status: 200 }));
      if (url === '/v1/moi') {
        asked.push(init.headers?.authorization ?? null);
        return ok({ role: init.headers?.authorization === `Bearer ${DIRECTION}` ? 'direction' : 'agent', firstName: 'Sam' })();
      }
      return Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    history: { pushState: () => undefined, replaceState: () => undefined },
    location: { origin: 'https://app.aimmo.test', pathname: path, hash: '', replace: (to: string) => went.push(to) },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  return { els, storage, calls, asked, went };
}

describe('DS069 · l’écran de la direction n’est plus dans la page de l’agent', () => {
  it('[R201] la page de l’agent ne porte plus un seul élément de l’écran de la direction ; celle de la direction les porte tous', () => {
    expect(HTML).toContain('<section id="reseau" hidden></section>');
    const here = new Set(idsOf(HTML));
    const apart = idsOf(RESEAU_HTML);
    expect(apart.length).toBeGreaterThan(100);
    expect(apart.filter((id) => here.has(id))).toEqual([]);
    expect(HTML).not.toContain('Le réseau</h2>');
    // La page de la direction est celle de l'agent, avec cet écran à sa place, sans identifiant en double.
    expect(PAGE).toBe(HTML.replace('<section id="reseau" hidden></section>', () => `<section id="reseau" hidden>\n${RESEAU_HTML}</section>`));
    expect(idsOf(PAGE).length).toBe(new Set(idsOf(PAGE)).size);
    expect(idsOf(PAGE).length).toBe(here.size + apart.length);
    // Elle est hors de la coquille gardée sans réseau : aucun agent ne la télécharge, même en arrière-plan.
    expect(AGENT_APP_SHELL).not.toContain('/app/reseau');
    // La page que chaque agent télécharge a rendu la place de cet écran : 2 Ko compressés de moins que celle de la direction.
    expect(gzipSize(HTML)).toBeLessThanOrEqual(gzipSize(PAGE) - 2 * 1024);
  });

  it('[R13] le script n’écrit toujours aucun HTML : l’écran arrive par sa page, pas par le script', () => {
    expect(JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment/);
  });

  it('[R201] un agent démarre sur sa page : rien n’est demandé pour la direction, rien ne casse', async () => {
    const t = await run('/app/', { 'aimmo.cle': AGENT });
    expect(t.calls[0]).toBe('GET /v1/moi');
    expect(t.calls.some((c) => c.includes('/app/reseau'))).toBe(false);
    expect(t.went).toEqual([]);
    expect(t.els['reseau-corps']).toBeUndefined();
    expect(t.els.connexion!.hidden).toBe(true);
    expect(t.els.bonjour!.textContent).toBe('Bonjour Sam');
  });

  it('[R201] l’appareil de la direction ouvre sa page avant tout branchement, et ses vrais boutons y répondent', async () => {
    for (const stored of [{ 'aimmo.cle': DIRECTION, 'aimmo.reseau': '1' }, { 'aimmo.cle': AGENT, 'aimmo.cle.direction': DIRECTION }]) {
      // Sur la page de l'agent : on s'assure que la sienne répond, on y va, et rien d'autre ne se passe ici.
      const from = await run('/app/', stored);
      expect(from.calls).toEqual(['HEAD /app/reseau']);
      expect(from.went).toEqual(['/app/reseau']);
      // Sur sa page : l'écran est là, les boutons sont branchés, aucun détour.
      const t = await run('/app/reseau', stored);
      expect(t.calls[0]).toBe('GET /v1/moi');
      expect(t.went).toEqual([]);
      for (const id of ['reseau-mois', 'reseau-precedent', 'reseau-annee', 'vers-journee']) expect(typeof t.els[id]?.listeners.click, id).toBe('function');
    }
    const direction = await run('/app/reseau', { 'aimmo.cle': DIRECTION, 'aimmo.reseau': '1' });
    expect(direction.els.reseau!.hidden).toBe(false);
    expect(direction.calls.some((c) => c.startsWith('GET /v1/pilotage/reseau'))).toBe(true);
    // DS068 : l'export et les rubriques sont branchés par le script de la direction, arrivé avec son écran.
    for (const id of ['reseau-export', 'reseau-r-jour', 'reseau-r-technique']) expect(typeof direction.els[id]?.listeners.click, id).toBe('function');
  });

  it('[R201] la première entrée de la direction sur un appareil le note, et ouvre sa page', async () => {
    const t = await run('/app/', { 'aimmo.cle': DIRECTION });
    expect(t.calls).toEqual(['GET /v1/moi']);
    expect(t.storage.get('aimmo.reseau')).toBe('1');
    expect(t.went).toEqual(['/app/reseau']);
    expect(t.storage.get('aimmo.cle')).toBe(DIRECTION);
    expect(t.els.reseau!.hidden).toBe(true);
  });

  it('[R201] une invitation à deux clés sur un appareil neuf : « Voir le réseau » mène à l’écran, sans second geste', async () => {
    // La page de l'agent est partie avec sa seule clé ; l'invitation a posé celle de la direction pendant cette page.
    const first = await run('/app/', { 'aimmo.cle': AGENT });
    first.storage.set('aimmo.cle.direction', DIRECTION);
    first.els['vers-reseau']!.click();
    await settle();
    expect(first.asked.at(-1)).toBe(`Bearer ${DIRECTION}`);
    expect(first.went).toEqual(['/app/reseau']);
    expect(first.storage.get('aimmo.reseau')).toBe('ouvrir');
    // Sa page s'ouvre : elle entre avec la clé de la direction, pas celle de l'agent.
    const second = await run('/app/reseau', Object.fromEntries(first.storage));
    expect(second.asked).toEqual([`Bearer ${DIRECTION}`]);
    expect(second.els.reseau!.hidden).toBe(false);
    // Le geste n'est servi qu'une fois : au chargement suivant, l'appareil rouvre la journée de l'agent.
    expect(second.storage.get('aimmo.reseau')).toBe('1');
    const third = await run('/app/reseau', Object.fromEntries(second.storage));
    expect(third.asked).toEqual([`Bearer ${AGENT}`]);
  });

  it('[R201] sans réseau, l’appareil de la direction garde la page de l’agent : la journée et le mode sans réseau tiennent', async () => {
    const t = await run('/app/', { 'aimmo.cle': AGENT, 'aimmo.cle.direction': DIRECTION }, 'coupé');
    expect(t.calls[0]).toBe('HEAD /app/reseau');
    expect(t.went).toEqual([]);
    // Le démarrage a eu lieu ici : l'entrée avec la clé de l'agent est tentée, et aucune clé n'est effacée.
    expect(t.calls).toContain('GET /v1/moi');
    expect(t.storage.get('aimmo.cle')).toBe(AGENT);
    expect(t.storage.get('aimmo.cle.direction')).toBe(DIRECTION);
  });

  it('[R278] sans réseau, l’adresse de la direction s’ouvre sur la coquille gardée : la journée démarre, sans boucle', async () => {
    // Le service worker : il ne garde pas cette page, mais il la replie sur la coquille quand le réseau manque.
    const sw = (online: boolean) => {
      const listeners: Record<string, (event: unknown) => void> = {};
      const stored: string[] = [];
      const matched: string[] = [];
      const sandbox = {
        URL,
        Promise,
        self: { location: { origin: 'https://app.aimmo.test' }, addEventListener: (name: string, fn: (e: unknown) => void) => (listeners[name] = fn) },
        caches: {
          open: async () => ({ addAll: async (urls: string[]) => void stored.push(...urls) }),
          keys: async () => [],
          delete: async () => undefined,
          match: async (p: string) => (matched.push(p), new Response('coquille')),
        },
        fetch: async () => (online ? new Response('réseau') : Promise.reject(new TypeError('hors ligne'))),
      };
      runInNewContext(AGENT_APP_FILES['/app/sw.js']!, sandbox);
      return { listeners, stored, matched };
    };
    const ask = async (online: boolean, path: string, method = 'GET') => {
      const w = sw(online);
      let answer: Promise<Response> | null = null;
      w.listeners.fetch!({ request: { url: `https://app.aimmo.test${path}`, method }, respondWith: (p: Promise<Response>) => (answer = p) });
      return { text: answer ? await (await (answer as Promise<Response>)).text() : null, matched: w.matched };
    };
    expect(await ask(true, '/app/reseau')).toEqual({ text: 'réseau', matched: [] });
    expect(await ask(false, '/app/reseau')).toEqual({ text: 'coquille', matched: ['/app/'] });
    // La demande d'essai (HEAD) n'est pas servie par le cache : sans réseau elle échoue, et la page reste où elle est.
    expect((await ask(false, '/app/reseau', 'HEAD')).text).toBeNull();
    // À l'installation, la page de la direction n'est toujours pas gardée.
    const w = sw(true);
    const waits: Promise<unknown>[] = [];
    w.listeners.install!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(w.stored).toEqual([...AGENT_APP_SHELL]);
    expect(w.stored).not.toContain('/app/reseau');
    // Dans la page : l'adresse de la direction, le contenu de la coquille, pas de réseau. Le démarrage a lieu, sans détour ni boucle.
    const t = await run('/app/reseau', { 'aimmo.cle': AGENT, 'aimmo.cle.direction': DIRECTION }, 'coupé', 'la coquille');
    expect(t.calls[0]).toBe('HEAD /app/reseau');
    expect(t.went).toEqual([]);
    expect(t.calls).toContain('GET /v1/moi');
    expect(t.els['reseau-corps']).toBeUndefined();
    expect(t.storage.get('aimmo.cle')).toBe(AGENT);
    // Le réseau revenu, la même page mène à la vraie : un seul détour.
    const back = await run('/app/reseau', { 'aimmo.cle': AGENT, 'aimmo.cle.direction': DIRECTION }, 'là', 'la coquille');
    expect(back.calls).toEqual(['HEAD /app/reseau']);
    expect(back.went).toEqual(['/app/reseau']);
  });

  it('[R201] se déconnecter efface la marque de l’appareil', async () => {
    const t = await run('/app/reseau', { 'aimmo.cle': DIRECTION, 'aimmo.reseau': '1' });
    t.els.sortir!.click();
    await settle();
    expect(t.storage.has('aimmo.reseau')).toBe(false);
    expect(t.storage.has('aimmo.cle')).toBe(false);
  });
});
