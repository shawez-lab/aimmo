import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems, gzipSize } from '../../core/src/design/audit.ts';
import { RESEAU_JS, RESEAU_SCRIPT } from '../app/reseau.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : identifiants, chiffres, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const DIRECTION: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'direction', firstName: null }),
  'GET /v1/pilotage/reseau': ok({ totals: { contacts: 2, appointments: 0, mandates: 0, sales: 0 }, byAgent: [{ agentId: 'a1', contacts: 2, appointments: 0, mandates: 0, sales: 0 }] }),
  'GET /v1/pilotage/alertes': ok([]),
  'GET /v1/alertes-agent/sans-agent': ok({ total: 0, more: false }),
  'GET /v1/pilotage/reversements': ok([]),
  'GET /v1/pilotage/factures/brouillons': ok([]),
};
const AGENT: Record<string, Answer> = { 'GET /v1/moi': ok({ role: 'agent', firstName: 'Sam' }) };
const SERVED = { ...FakeElement.served };
afterEach(() => {
  FakeElement.served = { ...SERVED };
});

/** L'application dans un faux document. `arrives` : le script de la direction arrive de lui-même, ou l'essai le fait arriver. */
async function run(answers: Record<string, Answer>, arrives: 'seul' | 'à la main' = 'seul') {
  FakeElement.served = arrives === 'seul' ? { ...SERVED } : Object.fromEntries(Object.entries(SERVED).filter(([path]) => path !== '/app/reseau.js'));
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: string[] = [];
  const table: Record<string, Answer> = { ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url.split('?')[0]}`);
      const a = table[`${method} ${url.split('?')[0]}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const scripts = () => Object.values(els).flatMap((e) => e.children).filter((e) => e.tagName === 'script' && e.attributes.src === '/app/reseau.js');
  const arrive = async (at = 0) => {
    runInNewContext(RESEAU_SCRIPT, context);
    scripts()[at]!.listeners.load!({});
    await settle();
  };
  const reads = (path: string) => calls.filter((c) => c === `GET ${path}`).length;
  return { els, calls, table, storage, scripts, arrive, reads };
}

describe('DS068 · le dessin de l’écran de la direction sort du script de l’application', () => {
  it('[R201] servi à part, sous la politique de l’application, dans le budget d’une page ; hors de la coquille gardée sans réseau', async () => {
    const r = handleAgentApp(new Request('https://aimmo.example.test/app/reseau.js'))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await r.text()).toBe(RESEAU_SCRIPT);
    expect(budgetProblems({ html: '', js: RESEAU_SCRIPT }, BUDGETS.page)).toEqual([]);
    // Aucun agent ne le télécharge, même en arrière-plan.
    expect(AGENT_APP_SHELL).not.toContain('/app/reseau.js');
  });

  it('[R201] le script que chaque agent télécharge n’a plus le dessin de cet écran, et y regagne plus de 2 500 octets', () => {
    for (const text of ['Les agents sont listés dans l’ordre de leur identifiant', 'Aucun reversement à faire.', 'Valider cette facture', 'En attente : ', 'Total égal à la somme des lignes.']) {
      expect(JS, text).not.toContain(text);
      expect(RESEAU_SCRIPT, text).toContain(text);
    }
    // Ce qui reste dans l'application : l'entrée, l'effacement à la sortie et le chargeur.
    expect(JS).toContain("withTool('reseau', 'AIMMO_RESEAU', 'reseau-attend', 'reseau'");
    expect(RESEAU_JS).toContain('function wipeReseau()');
    expect(gzipSize(JS + RESEAU_SCRIPT) - gzipSize(JS)).toBeGreaterThan(2500);
  });

  it('[R13] aucun HTML écrit, rien dans les journaux ni dans le stockage du navigateur', () => {
    expect(RESEAU_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment/);
    expect(RESEAU_SCRIPT).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB/);
  });

  it('[R68] un agent ne demande jamais ce script ; la direction le reçoit une fois, quels que soient ses gestes', async () => {
    const agent = await run(AGENT);
    expect(agent.els.accueil!.hidden).toBe(false);
    expect(agent.scripts()).toEqual([]);
    const t = await run(DIRECTION);
    expect(t.els.reseau!.hidden).toBe(false);
    expect(t.scripts()).toHaveLength(1);
    expect(t.reads('/v1/pilotage/reseau')).toBe(1);
    for (const id of ['reseau-annee', 'reseau-mois']) {
      t.els[id]!.listeners.click!({});
      await settle();
    }
    expect(t.scripts()).toHaveLength(1);
    expect(t.reads('/v1/pilotage/reseau')).toBe(3);
    expect(t.els['reseau-corps']!.all().some((e) => e.textContent === 'Par agent')).toBe(true);
  });

  it('le script n’arrive pas : l’écran le dit, sans rien lire ni dessiner ; le geste suivant le redemande', async () => {
    const t = await run(DIRECTION, 'à la main');
    expect(t.els['reseau-attend']!.textContent).toBe('Chargement…');
    expect(t.reads('/v1/pilotage/reseau')).toBe(0);
    t.scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.els['reseau-attend']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.els['reseau-corps']!.children).toEqual([]);
    expect(t.reads('/v1/pilotage/reseau')).toBe(0);
    // Choisir une période redemande le script ; cette fois il arrive.
    t.els['reseau-precedent']!.listeners.click!({});
    await settle();
    expect(t.scripts()).toHaveLength(2);
    await t.arrive(1);
    expect(t.reads('/v1/pilotage/reseau')).toBe(1);
    expect(t.els['reseau-attend']!.textContent).toBe('Rien en attente.');
    expect(t.els['reseau-precedent']!.attributes['aria-pressed']).toBe('true');
  });

  it('pendant que le script arrive, le dernier geste gagne : une seule lecture, pour la dernière période choisie', async () => {
    const t = await run(DIRECTION, 'à la main');
    t.els['reseau-annee']!.listeners.click!({});
    t.els['reseau-precedent']!.listeners.click!({});
    await settle();
    expect(t.scripts()).toHaveLength(1);
    await t.arrive();
    expect(t.reads('/v1/pilotage/reseau')).toBe(1);
    expect(['mois', 'precedent', 'annee'].filter((r) => t.els[`reseau-${r}`]!.attributes['aria-pressed'] === 'true')).toEqual(['precedent']);
  });

  it('[R16] sortir pendant que le script arrive : rien n’est lu ni dessiné pour une session finie', async () => {
    const t = await run(DIRECTION, 'à la main');
    t.els.sortir!.listeners.click!({});
    await settle();
    await t.arrive();
    expect(t.calls.filter((c) => c.startsWith('GET /v1/pilotage'))).toEqual([]);
    expect(t.els['reseau-corps']!.children).toEqual([]);
    expect(t.els['reseau-attend']!.textContent).toBe('');
    expect(t.els.connexion!.hidden).toBe(false);
  });
});
