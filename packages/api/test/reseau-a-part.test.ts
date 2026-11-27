import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, gzipSize } from '../../core/src/design/audit.ts';
import { RESEAU_HTML } from '../app/fichiers.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const AGENT = 'a'.repeat(40);
const DIRECTION = 'd'.repeat(40);

type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};
const idsOf = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);

/** La page telle qu'un navigateur la reçoit : sans l'écran de la direction, qui n'arrive que si la coquille le demande. */
async function run(stored: Record<string, string>, role: 'agent' | 'direction', fragment: 'servi' | 'en panne' = 'servi') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML, false));
  const storage = new Map<string, string>(Object.entries(stored));
  const calls: string[] = [];
  let reloads = 0;
  // Le navigateur lit le HTML posé dans `#reseau` : ses éléments existent à partir de là.
  Object.defineProperty(els.reseau!, 'innerHTML', { set: (html: string) => idsOf(html).forEach((id) => (els[id] = new FakeElement('div', id))) });
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url === '/app/reseau.html') return fragment === 'servi' ? Promise.resolve(new Response(RESEAU_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })) : Promise.reject(new TypeError('hors ligne'));
      if (url === '/v1/moi') return ok({ role, firstName: 'Sam' })();
      return Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    history: { pushState: () => undefined, replaceState: () => undefined },
    location: { origin: 'https://app.aimmo.test', hash: '', reload: () => (reloads += 1) },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  return { els, storage, calls, reloads: () => reloads };
}

describe('DS069 · l’écran de la direction est servi à part', () => {
  it('[R201] la page de l’agent ne porte plus un seul élément de l’écran de la direction', () => {
    expect(HTML).toContain('<section id="reseau" hidden></section>');
    const here = new Set(idsOf(HTML));
    const apart = idsOf(RESEAU_HTML);
    expect(apart.length).toBeGreaterThan(100);
    expect(apart.filter((id) => here.has(id))).toEqual([]);
    expect(HTML).not.toContain('Le réseau</h2>');
    // L'écran est servi, hors de la coquille gardée hors ligne, et tient le budget d'une page.
    expect(AGENT_APP_FILES['/app/reseau.html']).toBe(RESEAU_HTML);
    expect(AGENT_APP_SHELL).not.toContain('/app/reseau.html');
    expect(gzipSize(RESEAU_HTML)).toBeLessThanOrEqual(BUDGETS.page.gzipBytes);
    // La coquille que chaque agent télécharge a rendu la place : 2 Ko au moins sous son budget.
    expect(gzipSize(HTML) + gzipSize(AGENT_APP_FILES['/app/app.css']!) + gzipSize(JS)).toBeLessThanOrEqual(BUDGETS.application.gzipBytes - 2 * 1024);
    // Aucun identifiant en double une fois l'écran posé dans la page.
    const all = [...idsOf(HTML), ...apart];
    expect(all.length).toBe(new Set(all).size);
  });

  it('[R201] un agent démarre sans cet écran : rien n’est demandé pour lui, rien ne casse', async () => {
    const t = await run({ 'aimmo.cle': AGENT }, 'agent');
    expect(t.calls).not.toContain('GET /app/reseau.html');
    expect(t.calls[0]).toBe('GET /v1/moi');
    expect(t.els['reseau-corps']).toBeUndefined();
    expect(t.reloads()).toBe(0);
    // La journée s'ouvre, ou son repli hors ligne : jamais l'écran d'entrée ni une page blanche.
    expect(t.els.connexion!.hidden).toBe(true);
    expect(t.els.bonjour!.textContent).toBe('Bonjour Sam');
  });

  it('[R201] sur l’appareil de la direction, son écran est posé avant tout branchement : ses vrais boutons répondent', async () => {
    for (const stored of [{ 'aimmo.cle': DIRECTION, 'aimmo.reseau': '1' }, { 'aimmo.cle': AGENT, 'aimmo.cle.direction': DIRECTION }]) {
      const t = await run(stored, stored['aimmo.cle'] === DIRECTION ? 'direction' : 'agent');
      expect(t.calls[0]).toBe('GET /app/reseau.html');
      expect(t.calls[1]).toBe('GET /v1/moi');
      for (const id of ['reseau-mois', 'reseau-precedent', 'reseau-annee', 'reseau-export', 'vers-journee']) expect(typeof t.els[id]?.listeners.click, id).toBe('function');
      expect(t.reloads()).toBe(0);
    }
    const direction = await run({ 'aimmo.cle': DIRECTION, 'aimmo.reseau': '1' }, 'direction');
    expect(direction.els.reseau!.hidden).toBe(false);
    expect(direction.calls.some((c) => c.startsWith('GET /v1/pilotage/reseau'))).toBe(true);
  });

  it('[R201] la première entrée de la direction sur un appareil le note, et la page repart une fois avec son écran', async () => {
    const t = await run({ 'aimmo.cle': DIRECTION }, 'direction');
    expect(t.calls).toEqual(['GET /v1/moi']);
    expect(t.storage.get('aimmo.reseau')).toBe('1');
    expect(t.reloads()).toBe(1);
    expect(t.storage.get('aimmo.cle')).toBe(DIRECTION);
    expect(t.els.reseau!.hidden).toBe(true);
  });

  it('[R201] sans réseau pour charger son écran, la direction lit pourquoi, et la page ne repart pas en boucle', async () => {
    const t = await run({ 'aimmo.cle': DIRECTION, 'aimmo.reseau': '1' }, 'direction', 'en panne');
    expect(t.calls.slice(0, 2)).toEqual(['GET /app/reseau.html', 'GET /v1/moi']);
    expect(t.reloads()).toBe(0);
    expect(t.els.erreur!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.els.erreur!.hidden).toBe(false);
    expect(t.els.connexion!.hidden).toBe(false);
    // La clé n'est pas effacée : la panne n'est pas un refus.
    expect(t.storage.get('aimmo.cle')).toBe(DIRECTION);
  });

  it('[R201] se déconnecter efface la marque de l’appareil', async () => {
    const t = await run({ 'aimmo.cle': DIRECTION, 'aimmo.reseau': '1' }, 'direction');
    t.els.sortir!.click();
    await settle();
    expect(t.storage.has('aimmo.reseau')).toBe(false);
    expect(t.storage.has('aimmo.cle')).toBe(false);
  });
});
