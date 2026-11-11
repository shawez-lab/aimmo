import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
import { SITE_REFUSALS, SITE_SCRIPT } from '../app/site.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
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
    { contentId: 'aaaaaaaaaaaa', kind: 'prix', ref: 'commune-une/appartement', views: 1200, demandes: ['msg-d1', 'msg-d2'], vendeurs: ['msg-d1'], mandats: ['msg-d1'], vendeursPour1000Vues: 0 },
    { contentId: 'bbbbbbbbbbbb', kind: 'agent', ref: INJECTED, views: 40, demandes: ['msg-d3'], vendeurs: [], mandats: [], vendeursPour1000Vues: 0 },
    { contentId: 'cccccccccccc', kind: 'quartier', ref: 'commune-deux/centre', views: 0, demandes: [], vendeurs: [], mandats: [], vendeursPour1000Vues: null },
  ],
};
const NEXT = {
  reason: 'proposee',
  suggestion: {
    kind: 'prix',
    commune: 'Commune Trois',
    path: '/prix/commune-trois',
    figures: { kindVendeurs: 1, kindViews: 1200, communeVendeurs: 2 },
    text: 'Écrire la page des prix de Commune Trois : texte du code.',
  },
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/gagner/rendez-vous': ok([]),
  'GET /v1/gagner/recommandations/a-appeler': ok([]),
  'GET /v1/gagner/relances': ok([]),
  'GET /v1/gagner/lettres': ok({ campaigns: [], properties: [] }),
  'GET /v1/site/prochaine-page?jours=90': ok(NEXT),
  'GET /v1/site/statistiques?jours=90': ok(PAGES),
  'GET /v1/site/prochaine-page?jours=365': ok({ reason: 'aucun_vendeur_mesure', suggestion: null }),
  'GET /v1/site/statistiques?jours=365': ok({ firstDay: '2026-10-13', lastDay: '2027-10-12', pages: [] }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['gagner-corps']!;
  const buttons = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = (src: string) => [...els.gagner!.all(), ...els['gagner-corps']!.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  els['gagner-ouvrir']!.listeners.click!({});
  await settle();
  runInNewContext(GAGNER_SCRIPT, context);
  scripts('/app/gagner.js')[0]!.listeners.load!({});
  await settle();
  const part = () => body().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Mon site')!;
  const beforeOpen = scripts('/app/site.js').length;
  const callsBefore = calls.length;
  const openSite = async (load = true) => {
    await click(buttons(part(), 'Ouvrir mon site')[0]);
    const s = scripts('/app/site.js');
    if (load) {
      runInNewContext(SITE_SCRIPT, context);
      s[s.length - 1]!.listeners.load!({});
      await settle();
    }
    return s;
  };
  const lists = (tag: string) => part().all().filter((e) => e.tagName === tag && e.className === 'liste');
  return { calls, part, buttons, click, openSite, lists, beforeOpen, callsBefore, settle };
}

describe('BR42 · écran « Gérer mon site »', () => {
  it('[R201] le script est servi à part, chargé seulement au geste, et tient le budget d’une page ; l’application tient le sien', async () => {
    const t = await run();
    expect(t.beforeOpen).toBe(0);
    expect(t.calls.slice(t.callsBefore).filter((c) => c.url.startsWith('/v1/site'))).toEqual([]);
    expect(await t.openSite()).toHaveLength(1);
    expect(AGENT_APP_FILES['/app/site.js']).toBe(SITE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/site.js');
    expect(JS).not.toContain('/app/site.js');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/site.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(budgetProblems({ html: '', js: SITE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: GAGNER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });

  it('[R16] l’écran ne fait que lire /v1/site, la clé dans l’en-tête seul, et n’écrit rien', async () => {
    const t = await run();
    await t.openSite();
    const mine = t.calls.slice(t.callsBefore);
    expect(mine.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/site/prochaine-page?jours=90', 'GET /v1/site/statistiques?jours=90']);
    for (const c of mine) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...SITE_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.sort()).toEqual(['/v1/site/prochaine-page', '/v1/site/statistiques']);
    expect(SITE_SCRIPT).not.toMatch(/'(POST|PUT|PATCH|DELETE)'/);
    expect(SITE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
  });

  it('[R286] chaque page dans l’ordre reçu, avec ses chiffres et les identifiants de ses messages, aucun nom', async () => {
    const t = await run();
    await t.openSite();
    const text = t.part().textContent;
    expect(text).toContain('Mes pages (3)');
    expect(text).toContain('Du 15/07/2027 au 12/10/2027, jours de Paris.');
    expect(text).toContain('rien garder du visiteur');
    const items = t.lists('ol')[0]!.children;
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('Page des prix · commune-une/appartement');
    expect(items[0]!.textContent).toContain('1200 vues · 2 demandes · 1 vendeur · 1 mandat');
    expect(items[0]!.textContent).toContain('0 vendeur(s) pour 1 000 vues.');
    expect(items[1]!.textContent).toContain('Ma page d’agent');
    expect(items[1]!.textContent).toContain('40 vues · 1 demande · 0 vendeur · 0 mandat');
    expect(items[2]!.textContent).toContain('Page de quartier · commune-deux/centre');
    expect(items[2]!.textContent).toContain('Aucune vue comptée : pas de taux.');
    // Chaque compteur se vérifie : les identifiants des messages sont là, repliés.
    const proofs = items[0]!.all().filter((e) => e.tagName === 'details');
    expect(proofs.map((d) => d.children[0]!.textContent)).toEqual(['Demandes : les messages', 'Vendeurs : les messages', 'Mandats : les messages']);
    expect(proofs[0]!.textContent).toContain('msg-d1');
    expect(proofs[0]!.textContent).toContain('msg-d2');
    expect(items[2]!.all().some((e) => e.tagName === 'details')).toBe(false);
    expect(text).not.toContain('aaaaaaaaaaaa');
  });

  it('[R287] la prochaine page dit la phrase et les chiffres du code ; sans proposition, sa raison en mots', async () => {
    const t = await run();
    await t.openSite();
    const text = t.part().textContent;
    expect(text).toContain('La prochaine page à écrire');
    expect(text).toContain('Écrire la page des prix de Commune Trois : texte du code.');
    expect(text).toContain('Ces pages ont amené 1 vendeur pour 1200 vues.');
    expect(text).toContain('Vendeurs déjà arrivés par le site dans cette commune : 2.');
    expect(text).toContain('Adresse de la page : /prix/commune-trois');
    expect(text).toContain('rien n’est publié tant que vous ne l’écrivez pas');
    const done = await run({ 'GET /v1/site/prochaine-page?jours=90': ok({ reason: 'toutes_les_communes_ont_leur_page', suggestion: null }) });
    await done.openSite();
    expect(done.part().textContent).toContain('Toutes les communes de vos zones ont déjà leur page : rien à écrire de plus.');
    expect(done.part().textContent).not.toContain('toutes_les_communes_ont_leur_page');
  });

  it('changer de période relit avec jours, et la période choisie est marquée', async () => {
    const t = await run();
    await t.openSite();
    const before = t.calls.length;
    const b90 = t.buttons(t.part(), '90 jours')[0]!;
    expect(b90.attributes['aria-pressed']).toBe('true');
    await t.click(t.buttons(t.part(), '365 jours')[0]);
    expect(t.calls.slice(before).map((c) => c.url)).toEqual(['/v1/site/prochaine-page?jours=365', '/v1/site/statistiques?jours=365']);
    const text = t.part().textContent;
    expect(text).toContain('Aucune page n’a encore amené de vendeur sur la période : rien à proposer pour le moment.');
    expect(text).toContain('Aucune page vue ni demande sur la période.');
    expect(t.buttons(t.part(), '365 jours')[0]!.attributes['aria-pressed']).toBe('true');
    expect(t.buttons(t.part(), '90 jours')[0]!.attributes['aria-pressed']).toBe('false');
  });

  it('tout texte reçu est posé en texte, jamais lu comme du HTML', async () => {
    const t = await run();
    await t.openSite();
    expect(t.part().textContent).toContain(INJECTED);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('l’écran ne montre jamais un code interne : chaque refus connu a ses mots, un code inconnu a une phrase sûre', async () => {
    for (const [code, words] of Object.entries(SITE_REFUSALS)) {
      const t = await run({
        'GET /v1/site/statistiques?jours=90': no(code === 'role' ? 403 : 400, { ok: false, rule: code === 'role' ? 'R16' : null, code }),
        'GET /v1/site/prochaine-page?jours=90': no(500, { ok: false, rule: null, code: 'panne_xyz' }),
      });
      await t.openSite();
      const text = t.part().textContent;
      // Un accès fermé ferme la session de l'application : l'écran n'a plus rien à dire.
      if (code !== 'agent_inactive') expect(text, code).toContain(words);
      expect(text).toContain('La proposition est indisponible pour le moment.');
      expect(text).not.toContain('panne_xyz');
      expect(text).not.toMatch(new RegExp(`\\b${code}\\b`));
    }
  });

  it('sans réseau, l’écran le dit ; le script qui ne charge pas laisse le bouton utilisable', async () => {
    const off = await run({ 'GET /v1/site/statistiques?jours=90': () => Promise.reject(new TypeError('hors ligne')), 'GET /v1/site/prochaine-page?jours=90': () => Promise.reject(new TypeError('hors ligne')) });
    await off.openSite();
    expect(off.part().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
    const t = await run();
    const s = await t.openSite(false);
    s[0]!.listeners.error!({});
    expect(t.part().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.buttons(t.part(), 'Ouvrir mon site')[0] as unknown as { disabled?: boolean }).disabled).toBeFalsy();
  });

  it('deux lectures de suite : seule la dernière dessine, même quand la première répond après', async () => {
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
    await t.openSite();
    await t.click(t.buttons(t.part(), 'Ouvrir mon site')[0]);
    release();
    await t.settle();
    const text = t.part().textContent;
    expect(text.match(/Mes pages \(/g)).toHaveLength(1);
    expect(text.match(/La prochaine page à écrire/g)).toHaveLength(1);
    expect(t.lists('ol')[0]!.children).toHaveLength(3);
  });
});
