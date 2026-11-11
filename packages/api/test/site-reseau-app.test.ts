import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ATTIRER_SCRIPT } from '../app/attirer.ts';
import { SITE_SCRIPT } from '../app/site.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { statistiquesSiteRoutes } from '../src/statistiques-site.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : communes, pages, identifiants de messages, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const PAGES = {
  firstDay: '2027-07-15',
  lastDay: '2027-10-12',
  pages: [
    { contentId: 'aaaaaaaaaaaa', kind: 'agent', ref: 'agent-un', views: 900, demandes: ['msg-a1'], vendeurs: ['msg-a1'], mandats: [], vendeursPour1000Vues: 1 },
    { contentId: 'bbbbbbbbbbbb', kind: 'prix', ref: INJECTED, views: 3100, demandes: ['msg-b1', 'msg-b2'], vendeurs: ['msg-b2'], mandats: ['msg-b2'], vendeursPour1000Vues: 0 },
  ],
};
const NEXT = {
  reason: 'proposee',
  suggestion: { kind: 'quartier', commune: 'Commune Quatre', path: '/quartiers/commune-quatre', figures: { kindVendeurs: 3, kindViews: 4000, communeVendeurs: 1 }, text: 'Écrire la page de quartier de Commune Quatre : texte du code.' },
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'direction', firstName: null }),
  'GET /v1/attirer/sites': ok([{ siteId: 's1', kind: 'reseau', agentId: null, baseUrl: 'https://reseau.exemple.test' }]),
  'GET /v1/site/prochaine-page?jours=90': ok(NEXT),
  'GET /v1/site/statistiques?jours=90': ok(PAGES),
  'GET /v1/site/prochaine-page?jours=30': ok({ reason: 'aucun_vendeur_mesure', suggestion: null }),
  'GET /v1/site/statistiques?jours=30': ok({ firstDay: '2027-09-13', lastDay: '2027-10-12', pages: [] }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['attirer-corps']!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  els['attirer-ouvrir']!.listeners.click!({});
  await settle();
  runInNewContext(ATTIRER_SCRIPT, context);
  els.attirer!.children.filter((e) => e.tagName === 'script')[0]!.listeners.load!({});
  await settle();
  const part = () => body().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Statistiques du site')!;
  const buttons = (text: string) => part().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const scripts = () => body().all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/site.js');
  const beforeOpen = scripts().length;
  const callsBefore = calls.length;
  const openStats = async (load = true) => {
    await click(buttons('Ouvrir les statistiques')[0]);
    const s = scripts();
    if (load) {
      runInNewContext(SITE_SCRIPT, context);
      s[s.length - 1]!.listeners.load!({});
      await settle();
    }
    return s;
  };
  return { calls, part, buttons, click, openStats, beforeOpen, callsBefore, settle };
}

describe('BR43 · les statistiques du site de tout le réseau, dans « Attirer »', () => {
  it('[R201] le script de « Mon site » n’est chargé qu’au geste, depuis « Attirer », et les deux scripts tiennent le budget d’une page', async () => {
    const t = await run();
    expect(t.part()).toBeDefined();
    expect(t.beforeOpen).toBe(0);
    expect(t.calls.slice(t.callsBefore).filter((c) => c.url.startsWith('/v1/site'))).toEqual([]);
    expect(await t.openStats()).toHaveLength(1);
    expect(JS).not.toContain('/app/site.js');
    expect(budgetProblems({ html: '', js: ATTIRER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: SITE_SCRIPT }, BUDGETS.page)).toEqual([]);
  });

  it('[R16] la partie ne fait que lire /v1/site, routes existantes, la clé dans l’en-tête seul', async () => {
    const t = await run();
    await t.openStats();
    const mine = t.calls.slice(t.callsBefore);
    expect(mine.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/site/prochaine-page?jours=90', 'GET /v1/site/statistiques?jours=90']);
    const routes = statistiquesSiteRoutes();
    for (const c of mine) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
      const path = c.url.slice('/v1'.length).split('?')[0]!;
      const route = routes.find((r) => r.method === c.method && r.pattern.test(path));
      // La direction lit tout le réseau par ces routes : contrôle des droits testé par BR41 (statistiques-site-routes).
      expect(route, c.url).toBeDefined();
    }
  });

  it('[R286] en mode réseau, les pages du réseau et la page d’un agent sont dites pour le réseau, dans l’ordre et avec les chiffres reçus', async () => {
    const t = await run();
    await t.openStats();
    const text = t.part().textContent;
    expect(text).toContain('Les pages du réseau (2)');
    expect(text).not.toContain('Mes pages');
    expect(text).not.toContain('Ma page d’agent');
    expect(text).toContain('Quelle page du réseau amène des vendeurs');
    expect(text.indexOf('Page d’un agent · agent-un')).toBeGreaterThan(-1);
    expect(text.indexOf('Page d’un agent · agent-un')).toBeLessThan(text.indexOf('Page des prix'));
    expect(text).toContain('900 vues · 1 demande · 1 vendeur · 0 mandat');
    expect(text).toContain('3100 vues · 2 demandes · 1 vendeur · 1 mandat');
    expect(text).toContain('Écrire la page de quartier de Commune Quatre : texte du code.');
    expect(text).toContain('Ces pages ont amené 3 vendeurs pour 4000 vues.');
    // Tout texte reçu est posé en texte.
    expect(text).toContain(INJECTED);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('l’écran de l’agent garde ses mots : sans le mode réseau, rien ne change', () => {
    const made: string[] = [];
    const fake = (tag: string, text?: string) => {
      const e = new FakeElement(tag);
      if (text !== undefined) {
        e.textContent = text;
        made.push(text);
      }
      return e;
    };
    const context: Record<string, unknown> = {};
    runInNewContext(SITE_SCRIPT, context);
    const screen = (context.AIMMO_SITE as (t: unknown) => { show: (b: FakeElement) => Promise<boolean> })({ el: fake, clear: () => undefined, send: () => new Promise(() => undefined), button: (x: string) => fake('button', x) });
    void screen.show(new FakeElement('div'));
    expect(made).toContain('90 jours');
    expect(made.some((x) => x.includes('réseau'))).toBe(false);
  });

  it('changer de période relit avec jours ; seule la dernière lecture dessine', async () => {
    let release: () => void = () => undefined;
    let first = true;
    const t = await run({
      'GET /v1/site/statistiques?jours=90': async () => {
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
          return Response.json({ ok: true, mode: 'essai', data: { ...PAGES, pages: [] } });
        }
        return Response.json({ ok: true, mode: 'essai', data: PAGES });
      },
    });
    await t.openStats();
    await t.click(t.buttons('Ouvrir les statistiques')[0]);
    release();
    await t.settle();
    expect(t.part().textContent.match(/Les pages du réseau \(/g)).toHaveLength(1);
    expect(t.part().textContent).toContain('Les pages du réseau (2)');
    const before = t.calls.length;
    await t.click(t.buttons('30 jours')[0]);
    expect(t.calls.slice(before).map((c) => c.url)).toEqual(['/v1/site/prochaine-page?jours=30', '/v1/site/statistiques?jours=30']);
    expect(t.part().textContent).toContain('Aucune page vue ni demande sur la période.');
    expect(t.buttons('30 jours')[0]!.attributes['aria-pressed']).toBe('true');
  });

  it('un refus est dit en mots, jamais par son code ; un script qui ne charge pas laisse le bouton utilisable', async () => {
    const t = await run({
      'GET /v1/site/statistiques?jours=90': no(403, { ok: false, rule: 'R16', code: 'role' }),
      'GET /v1/site/prochaine-page?jours=90': no(500, { ok: false, rule: null, code: 'panne_xyz' }),
    });
    await t.openStats();
    const text = t.part().textContent;
    expect(text).toContain('Les statistiques du site ne sont pas dans vos droits.');
    expect(text).toContain('Les pages du réseau');
    expect(text).not.toMatch(/\brole\b|panne_xyz/);
    const off = await run();
    const s = await off.openStats(false);
    s[0]!.listeners.error!({});
    expect(off.part().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((off.buttons('Ouvrir les statistiques')[0] as unknown as { disabled?: boolean }).disabled).toBeFalsy();
  });
});
