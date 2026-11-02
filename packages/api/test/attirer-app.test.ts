import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { SITE_KINDS } from '../../core/src/attirer/referencement.ts';
import { ATTIRER_SCRIPT } from '../app/attirer.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { attirerRoutes } from '../src/attirer.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : sites, chiffres, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

/** Le mois en cours à Paris, comme l'écran le demande. */
const MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
// Des chiffres impossibles à retrouver par un calcul : l'écran montre ceux du serveur, tels quels.
const MEASURE = {
  month: MONTH,
  contacts: 41,
  withOrigin: 17,
  percent: 73.7,
  targetPercent: 95,
  meetsTarget: false,
  byKind: [{ kind: 'video', contacts: 9 }, { kind: 'inconnue', contacts: 3 }, { kind: 'bien', contacts: 5 }],
  byContent: [{ contentId: 'c1', kind: 'video', ref: INJECTED, contacts: 9 }],
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'direction', firstName: null }),
  'GET /v1/attirer/prix/versions': ok([{ id: 'v1', dvfLastSale: '2026-06-30', source: 'DVF, jeu inventé', completedAt: '2026-08-01T08:00:00.000Z' }]),
  'GET /v1/attirer/sites': ok([
    { siteId: 's1', kind: 'reseau', agentId: null, baseUrl: 'https://reseau.exemple.test' },
    { siteId: 's2', kind: 'agent', agentId: 'ag-1', baseUrl: 'https://camille.exemple.test' },
  ]),
  [`GET /v1/attirer/origine/${MONTH}`]: ok(MEASURE),
  'GET /v1/attirer/sites/s1/plan': ok([{ loc: 'https://reseau.exemple.test/prix/commune-une', lastmod: null, kind: 'prix' }]),
  'POST /v1/attirer/prix/recalcul': ok({ ran: true, versionId: 'v2', published: 12, carried: 4, held: 3 }),
  'POST /v1/attirer/sites': ok({ siteId: 's3' }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Une horloge qu'un test avance : un double appui immédiat n'est pas une confirmation. */
let clock = 0;
class Clock extends Date {
  static override now(): number {
    return clock;
  }
}
const later = (ms: number) => {
  clock += ms;
};
/** Une réponse qui n'arrive que quand le test le décide. */
function deferred(body: unknown) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer: Answer = async () => {
    await held;
    return Response.json({ ok: true, mode: 'essai', data: body });
  };
  return { answer, release };
}

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date: Clock,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['attirer-corps']!;
  const state = () => els['attirer-etat']!.textContent;
  const buttons = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const input = (label: string) => {
    const l = body().all().find((e) => e.tagName === 'label' && e.textContent === label);
    if (!l) throw new Error(`libellé absent : ${label}`);
    return body().all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const scripts = () => els.attirer!.children.filter((e) => e.tagName === 'script');
  const ouvrir = async () => {
    await click(els['attirer-ouvrir']);
    const s = scripts();
    if (s.length === 1 && !body().children.length) {
      runInNewContext(ATTIRER_SCRIPT, context);
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  /** Changer l'adresse du site du réseau : deux appuis, espacés. */
  const changer = async (url: string) => {
    input('Changer l’adresse du site du réseau').value = url;
    const b = buttons('Changer l’adresse')[0];
    await click(b);
    later(2000);
    await click(b);
  };
  return { els, calls, context, click, body, buttons, texts, input, state, posts, scripts, ouvrir, storage, changer };
}

describe('AT12 · écran « Attirer » de la direction', () => {
  it('[R16] l’écran ne lit et n’écrit que par /v1/attirer, la clé dans l’en-tête seul', async () => {
    const t = await run();
    const before = t.calls.length;
    await t.ouvrir();
    await t.click(t.buttons('Voir le plan')[0]);
    const mine = t.calls.slice(before);
    expect(mine.length).toBeGreaterThan(3);
    for (const c of mine) {
      expect(c.url.startsWith('/v1/attirer/')).toBe(true);
      expect(c.url).not.toContain(KEY);
      expect(c.auth).toBe(`Bearer ${KEY}`);
    }
  });

  it('[R16] chaque adresse appelée existe parmi les routes de M01, réservées à la direction', async () => {
    const t = await run();
    const before = t.calls.length;
    await t.ouvrir();
    await t.click(t.buttons('Voir le plan')[0]);
    await t.click(t.buttons('Recalculer les prix')[0]);
    await t.changer('https://neuf.exemple.test');
    const routes = attirerRoutes();
    for (const c of t.calls.slice(before)) {
      const path = c.url.slice('/v1'.length);
      const route = routes.find((r) => r.method === c.method && r.pattern.test(path));
      expect(route, c.url).toBeDefined();
      expect(route!.roles).toEqual(['direction']);
    }
  });

  it('[R16] le corps envoyé pour un site est bien celui que la route attend', async () => {
    const t = await run();
    await t.ouvrir();
    await t.changer('  https://neuf.exemple.test ');
    const sent = JSON.parse(t.posts()[0]!.body!);
    expect(sent).toEqual({ kind: 'reseau', baseUrl: 'https://neuf.exemple.test', active: true });
    expect(SITE_KINDS).toContain(sent.kind);
    expect(t.state()).toBe('Site mis en service.');
    const u = await run({ 'GET /v1/attirer/sites': ok([]) });
    await u.ouvrir();
    u.input('Adresse du site du réseau').value = 'https://premier.exemple.test';
    await u.click(u.buttons('Mettre en service')[0]);
    expect(JSON.parse(u.posts()[0]!.body!)).toEqual({ kind: 'reseau', baseUrl: 'https://premier.exemple.test', active: true });
  });

  it('l’entrée est dans l’écran du réseau, qu’un agent n’ouvre jamais', async () => {
    const from = HTML.indexOf('<section id="reseau"');
    const to = HTML.indexOf('<p id="attente"');
    const at = HTML.indexOf('id="attirer-ouvrir"');
    expect(from).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(from);
    expect(at).toBeLessThan(to);
    const agent = await run({ 'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }), 'GET /v1/plan-du-jour': ok(null) });
    expect(agent.els.reseau!.hidden).toBe(true);
    const direction = await run();
    expect(direction.els.reseau!.hidden).toBe(false);
  });

  it('les chiffres sont ceux du serveur, tels quels, dans l’ordre reçu', async () => {
    const t = await run();
    await t.ouvrir();
    const shown = t.texts();
    expect(shown).toContain('73,7 % des contacts ont leur origine connue');
    expect(shown).toContain('17 sur 41 contacts. Cible : 95 %, pas encore tenue.');
    expect(shown.indexOf('Vidéo : 9')).toBeLessThan(shown.indexOf('Origine inconnue : 3'));
    expect(shown.indexOf('Origine inconnue : 3')).toBeLessThan(shown.indexOf('Page d’un bien : 5'));
    expect(shown).toContain('DVF, jeu inventé');
  });

  it('un autre mois se lit à la demande, et reste choisi après un geste', async () => {
    const t = await run();
    await t.ouvrir();
    const f = t.input('Mois');
    const before = t.calls.length;
    f.value = '2020-01';
    f.listeners.change!({});
    await settle();
    expect(t.calls.slice(before).some((c) => c.url === '/v1/attirer/origine/2020-01')).toBe(true);
    const again = t.calls.length;
    await t.click(t.buttons('Recalculer les prix')[0]);
    expect(t.calls.slice(again).some((c) => c.url === '/v1/attirer/origine/2020-01')).toBe(true);
  });

  it('un contact sans origine connue n’affiche pas de pourcentage trompeur', async () => {
    const t = await run({ [`GET /v1/attirer/origine/${MONTH}`]: ok({ ...MEASURE, contacts: 0, withOrigin: 0, percent: 0, byKind: [], byContent: [] }) });
    await t.ouvrir();
    expect(t.texts()).toContain('Aucun contact ce mois-là.');
    expect(t.texts()).not.toContain('0 % des contacts');
  });

  it('un double appui ne relance qu’un recalcul', async () => {
    const t = await run();
    await t.ouvrir();
    const b = t.buttons('Recalculer les prix')[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await settle();
    expect(t.posts().filter((c) => c.url === '/v1/attirer/prix/recalcul')).toHaveLength(1);
    expect(t.state()).toBe('Nouvelle version : 12 prix publiés, 4 repris de la version d’avant, 3 retenus.');
  });

  it('un recalcul qui ne produit rien le dit en français, sans code', async () => {
    const t = await run({ 'POST /v1/attirer/prix/recalcul': ok({ ran: false, reason: 'source_incomplete' }) });
    await t.ouvrir();
    await t.click(t.buttons('Recalculer les prix')[0]);
    expect(t.state()).toBe('La lecture des ventes publiques est incomplète : les prix en ligne ne changent pas.');
    const u = await run({ 'POST /v1/attirer/prix/recalcul': no(400, { ok: false, rule: null, code: 'source_absente' }) });
    await u.ouvrir();
    await u.click(u.buttons('Recalculer les prix')[0]);
    expect(u.state()).toBe('La source des ventes publiques n’est pas branchée : aucun recalcul pour le moment.');
  });

  it('un refus est dit en français, sans code ni donnée', async () => {
    const t = await run({ 'POST /v1/attirer/sites': no(409, { ok: false, rule: 'R153', code: 'url_taken', secret: 'x' }) });
    await t.ouvrir();
    await t.changer('https://pris.exemple.test');
    expect(t.state()).toBe('Cette adresse sert déjà un autre site : une seule page de référence par bien.');
    const u = await run({ 'GET /v1/attirer/sites': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await u.ouvrir();
    expect(u.texts()).toContain('Ce n’est pas dans vos droits.');
    expect(u.texts()).not.toContain('R16');
    expect(u.texts()).toContain('Prix publics');
  });

  it('mettre le site du réseau hors service se confirme ; un double appui immédiat ne coupe rien', async () => {
    const t = await run();
    await t.ouvrir();
    const off = t.buttons('Mettre hors service')[0]!;
    await t.click(off);
    expect(off.textContent).toBe('Confirmer : mettre hors service');
    await t.click(off);
    expect(t.posts()).toHaveLength(0);
    later(2000);
    await t.click(off);
    expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: false });
    expect(t.state()).toBe('Site mis hors service.');
  });

  it('une demande de confirmation restée sans suite retombe', async () => {
    const t = await run();
    await t.ouvrir();
    const off = t.buttons('Mettre hors service')[0]!;
    await t.click(off);
    later(60000);
    await t.click(off);
    expect(t.posts()).toHaveLength(0);
    expect(off.textContent).toBe('Confirmer : mettre hors service');
  });

  it('le site d’un agent se lit ici, sans geste qui le coupe et qu’on ne pourrait pas défaire', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.texts()).toContain('https://camille.exemple.test');
    expect(t.buttons('Mettre hors service')).toHaveLength(1);
  });

  it('un recalcul en vol reste seul, même si l’écran est relu entre-temps', async () => {
    const d = deferred({ ran: true, versionId: 'v2', published: 1, carried: 0, held: 0 });
    const t = await run({ 'POST /v1/attirer/prix/recalcul': d.answer });
    await t.ouvrir();
    await t.click(t.buttons('Recalculer les prix')[0]);
    const f = t.input('Mois');
    f.value = '2020-01';
    f.listeners.change!({});
    await settle();
    await t.click(t.buttons('Recalculer les prix')[0]);
    const count = () => t.posts().filter((c) => c.url === '/v1/attirer/prix/recalcul').length;
    expect(count()).toBe(1);
    d.release();
    await settle();
    await t.click(t.buttons('Recalculer les prix')[0]);
    expect(count()).toBe(2);
  });

  it('une clé refusée efface tout, et ramène à la connexion', async () => {
    const t = await run({ 'POST /v1/attirer/prix/recalcul': no(401, { ok: false }) });
    await t.ouvrir();
    await t.click(t.buttons('Recalculer les prix')[0]);
    expect(t.body().children.length).toBe(0);
    expect(t.state()).toBe('');
    expect(t.storage.has('aimmo.cle')).toBe(false);
    expect(t.els.connexion!.hidden).toBe(false);
  });

  it('une réponse arrivée après la sortie n’est jamais montrée', async () => {
    const d = deferred([{ siteId: 's9', kind: 'reseau', agentId: null, baseUrl: 'https://tardif.exemple.test' }]);
    const u = await run({ 'GET /v1/attirer/sites': d.answer });
    await u.click(u.els['attirer-ouvrir']);
    const s = u.scripts()[0]!;
    runInNewContext(ATTIRER_SCRIPT, u.context);
    s.listeners.load!({});
    await settle();
    await u.click(u.els['attirer-retour']);
    d.release();
    await settle();
    expect(u.body().children.length).toBe(0);
    expect(u.els.attirer!.hidden).toBe(true);
  });

  it('un texte reçu n’est jamais lu comme du HTML', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.body().all().some((e) => e.textContent.includes(INJECTED))).toBe(true);
    expect(ATTIRER_SCRIPT).not.toContain('innerHTML');
    expect(t.body().all().every((e) => e.tagName !== 'img')).toBe(true);
  });

  it('sortir de l’écran efface ce qu’il montrait', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.body().children.length).toBeGreaterThan(0);
    const f = t.input('Mois');
    f.value = '2020-01';
    f.listeners.change!({});
    await settle();
    await t.click(t.els['attirer-retour']);
    expect(t.body().children.length).toBe(0);
    expect(t.state()).toBe('');
    expect(t.els.attirer!.hidden).toBe(true);
    const before = t.calls.length;
    await t.ouvrir();
    expect(t.calls.slice(before).some((c) => c.url === `/v1/attirer/origine/${MONTH}`)).toBe(true);
  });

  it('pas de réseau : c’est dit, rien n’est inventé', async () => {
    const t = await run({ 'GET /v1/attirer/prix/versions': async () => Promise.reject(new TypeError('x')), 'GET /v1/attirer/sites': async () => Promise.reject(new TypeError('x')), [`GET /v1/attirer/origine/${MONTH}`]: async () => Promise.reject(new TypeError('x')) });
    await t.ouvrir();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('[R201] l’écran est servi à part, jamais gardé sur l’appareil, et tient le budget d’une page', async () => {
    expect(AGENT_APP_FILES['/app/attirer.js']).toBe(ATTIRER_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/attirer.js');
    const res = handleAgentApp(new Request('https://x.test/app/attirer.js'));
    expect(res?.status).toBe(200);
    expect(budgetProblems({ html: '', js: ATTIRER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(JS).not.toContain('AIMMO_ATTIRER = function');
  });
});
