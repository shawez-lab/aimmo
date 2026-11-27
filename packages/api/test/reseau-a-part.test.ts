import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, gzipSize } from '../../core/src/design/audit.ts';
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
async function run(path: '/app/' | '/app/reseau', stored: Record<string, string>, network: 'là' | 'coupé' = 'là') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML, path === '/app/reseau'));
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
    // La coquille que chaque agent télécharge a rendu la place : 2 Ko au moins sous son budget.
    expect(gzipSize(HTML) + gzipSize(AGENT_APP_FILES['/app/app.css']!) + gzipSize(JS)).toBeLessThanOrEqual(BUDGETS.application.gzipBytes - 2 * 1024);
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
      for (const id of ['reseau-mois', 'reseau-precedent', 'reseau-annee', 'reseau-export', 'vers-journee']) expect(typeof t.els[id]?.listeners.click, id).toBe('function');
    }
    const direction = await run('/app/reseau', { 'aimmo.cle': DIRECTION, 'aimmo.reseau': '1' });
    expect(direction.els.reseau!.hidden).toBe(false);
    expect(direction.calls.some((c) => c.startsWith('GET /v1/pilotage/reseau'))).toBe(true);
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

  it('[R201] se déconnecter efface la marque de l’appareil', async () => {
    const t = await run('/app/reseau', { 'aimmo.cle': DIRECTION, 'aimmo.reseau': '1' });
    t.els.sortir!.click();
    await settle();
    expect(t.storage.has('aimmo.reseau')).toBe(false);
    expect(t.storage.has('aimmo.cle')).toBe(false);
  });
});
