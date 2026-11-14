import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { mediatorOfferText } from '../../core/src/securite/reclamations.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import { RECLAMATIONS_REGLAGE_LOST, RECLAMATIONS_REGLAGE_REFUSALS, RECLAMATIONS_REGLAGE_SCRIPT } from '../app/reclamations-reglage.ts';
import { SCENARIOS_SCRIPT } from '../app/scenarios.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, médiateurs, sites.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const PATH = '/v1/securite/reclamations/reglage';
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));
const NONE = { version: null, setAt: null, responseDays: 30, mediator: null, offerText: null, waitingForMediator: 2 };
const MED = { name: 'Médiation Exemple', site: 'https://mediation.example.test' };
const SET = { version: 3, setAt: '2027-03-09T09:00:00.000Z', responseDays: 21, mediator: MED, offerText: mediatorOfferText(MED), waitingForMediator: 0 };

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    'GET /v1/gagner/engagements': ok([]),
    [`GET ${PATH}`]: ok(NONE),
    [`POST ${PATH}`]: async () => Response.json({ ok: true, mode: 'essai', data: null, version: 4 }),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  await click(els['engagements-voir']);
  runInNewContext(ENGAGEMENTS_SCRIPT, context);
  scriptsOf(els.reseau!, '/app/engagements.js')[0]!.listeners.load!({});
  await settle();
  const part = () => els['engagements-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Réclamations : délai et médiateur')!;
  const button = (text: string) => part().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const status = () => part().all().find((e) => e.attributes.role === 'status')?.textContent ?? '';
  const texts = () => part().textContent;
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const type = (id: string, value: string) => {
    const f = input(`reclamations-reglage-${id}`);
    f.value = value;
    f.listeners.input?.({});
  };
  const open = async (load = true) => {
    await click(button('Ouvrir le réglage'));
    const s = scriptsOf(part(), '/app/reclamations-reglage.js');
    if (load && s.length === 1 && !context.loaded) {
      runInNewContext(RECLAMATIONS_REGLAGE_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const gets = () => calls.filter((c) => c.method === 'GET' && c.url === PATH);
  return { els, calls, table, context, part, button, status, texts, input, type, click, open, posts, gets, scriptsOf };
}

describe('BR70 · le délai de réponse et le médiateur, réglés par la direction', () => {
  it('[R201] servi à part, chargé au seul geste depuis « Engagements de service » ; budgets tenus, sans innerHTML ; les scénarios restent', async () => {
    expect(AGENT_APP_FILES['/app/reclamations-reglage.js']).toBe(RECLAMATIONS_REGLAGE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/reclamations-reglage.js');
    const served = handleAgentApp(new Request('https://x.test/app/reclamations-reglage.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: RECLAMATIONS_REGLAGE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: ENGAGEMENTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/app/reclamations-reglage.js');
    expect(JS).not.toContain(PATH);
    expect(RECLAMATIONS_REGLAGE_SCRIPT).not.toContain('innerHTML');
    const t = await run();
    expect(t.part()).toBeDefined();
    expect(t.scriptsOf(t.part(), '/app/reclamations-reglage.js')).toHaveLength(0);
    expect(t.gets()).toHaveLength(0);
    await t.open();
    expect(t.gets()).toHaveLength(1);
    // Un second geste ne recharge pas le script : il relit le réglage.
    await t.open(false);
    expect(t.scriptsOf(t.part(), '/app/reclamations-reglage.js')).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    // Les scénarios gardent leur entrée.
    expect(t.els['engagements-corps']!.children.some((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Scénarios automatiques')).toBe(true);
    expect(SCENARIOS_SCRIPT).toContain('AIMMO_SCENARIOS');
  });

  it('sans réseau au chargement du script, ou script sans écran : c’est dit, et le bouton revient', async () => {
    const t = await run();
    await t.open(false);
    t.scriptsOf(t.part(), '/app/reclamations-reglage.js')[0]!.listeners.error!({});
    await settle();
    expect(t.texts()).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.button('Ouvrir le réglage') as unknown as { disabled: boolean }).disabled).toBe(false);
    const u = await run();
    await u.open(false);
    u.scriptsOf(u.part(), '/app/reclamations-reglage.js')[0]!.listeners.load!({});
    await settle();
    expect(u.texts()).toContain('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('[R606] [R607] sans réglage : rien d’inventé, 30 jours dits, les réclamations en attente comptées, aucun texte au client', async () => {
    const t = await run();
    await t.open();
    expect(t.texts()).toContain('le délai de réponse est de 30 jours, et aucun médiateur n’est réglé');
    expect(t.texts()).toContain('2 réclamations attendent un médiateur');
    expect(t.texts()).not.toContain('Le texte que reçoit le client');
    expect(t.input('reclamations-reglage-delai').value).toBe('30');
    expect(t.input('reclamations-reglage-nom').value ?? '').toBe('');
  });

  it('avec réglage : version, jour, délai, médiateur et texte du serveur ; le formulaire part de ce réglage', async () => {
    const t = await run({ [`GET ${PATH}`]: ok(SET) });
    await t.open();
    expect(t.texts()).toContain('Version 3, rangée le 09/03/2027.');
    expect(t.texts()).toContain('Délai de réponse : 21 jours.');
    expect(t.texts()).toContain('Médiateur : Médiation Exemple, https://mediation.example.test.');
    expect(t.texts()).toContain(mediatorOfferText(MED));
    expect(t.texts()).not.toContain('attend');
    expect(t.input('reclamations-reglage-delai').value).toBe('21');
    expect(t.input('reclamations-reglage-nom').value).toBe('Médiation Exemple');
    expect(t.input('reclamations-reglage-site').value).toBe('https://mediation.example.test');
  });

  it('[R607] Jamais vu : avant de ranger, le texte du client est lu mot pour mot, celui du code ; une saisie changée retire « Ranger »', async () => {
    const t = await run();
    await t.open();
    expect(t.button('Ranger cette version')).toBeUndefined();
    t.type('nom', 'Médiation 21 Exemple');
    t.type('site', 'https://mediation2.example.test/saisir');
    await t.click(t.button('Lire le texte du client'));
    expect(t.texts()).toContain(mediatorOfferText({ name: 'Médiation 21 Exemple', site: 'https://mediation2.example.test/saisir' }));
    expect(t.texts()).toContain('sans frais');
    // Changer la saisie retire le bouton : on ne range que ce qu'on a lu.
    t.type('delai', '45');
    expect(t.button('Ranger cette version')).toBeUndefined();
    await t.click(t.button('Lire le texte du client'));
    await t.click(t.button('Ranger cette version'));
    expect(t.posts()).toEqual([{ method: 'POST', url: PATH, body: { responseDays: 45, mediatorName: 'Médiation 21 Exemple', mediatorSite: 'https://mediation2.example.test/saisir' } }]);
    expect(t.status()).toBe('Version 4 rangée : l’ancienne reste au journal.');
    expect(t.gets()).toHaveLength(2);
    // Un nom avec les marques du texte ne casse rien.
    const u = await run();
    await u.open();
    u.type('nom', '%%SITE%% Exemple');
    u.type('site', 'https://m.example.test');
    await u.click(u.button('Lire le texte du client'));
    expect(u.texts()).toContain(mediatorOfferText({ name: '%%SITE%% Exemple', site: 'https://m.example.test' }));
  });

  it('une saisie illisible ne part pas, et dit pourquoi en mots', async () => {
    const t = await run();
    await t.open();
    const cases: [string, string, string][] = [
      ['delai', '0', RECLAMATIONS_REGLAGE_REFUSALS.bad_days],
      ['delai', '61', RECLAMATIONS_REGLAGE_REFUSALS.bad_days],
      ['delai', '2,5', RECLAMATIONS_REGLAGE_REFUSALS.bad_days],
    ];
    t.type('nom', 'Médiation Exemple');
    t.type('site', 'https://mediation.example.test');
    for (const [id, value, said] of cases) {
      t.type(id, value);
      await t.click(t.button('Lire le texte du client'));
      expect(t.status()).toBe(said);
      expect(t.button('Ranger cette version')).toBeUndefined();
    }
    t.type('delai', '30');
    for (const [id, value, said] of [
      ['nom', '   ', RECLAMATIONS_REGLAGE_REFUSALS.bad_mediator],
      ['nom', 'x'.repeat(121), RECLAMATIONS_REGLAGE_REFUSALS.bad_mediator],
    ] as const) {
      t.type(id, value);
      await t.click(t.button('Lire le texte du client'));
      expect(t.status()).toBe(said);
    }
    t.type('nom', 'Médiation Exemple');
    for (const site of ['http://mediation.example.test', 'pas une adresse', 'https://moi:secret@mediation.example.test', `https://m.example.test/${'a'.repeat(200)}`]) {
      t.type('site', site);
      await t.click(t.button('Lire le texte du client'));
      expect(t.status()).toBe(RECLAMATIONS_REGLAGE_REFUSALS.bad_site);
    }
    expect(t.posts()).toEqual([]);
  });

  it('[R16] chaque refus est dit en mots, jamais son code ; un code inconnu a sa phrase ; une réponse perdue est dite incertaine et le réglage relu', async () => {
    for (const [answer, said] of [
      [no(403, { ok: false, rule: 'R16', code: 'role' }), RECLAMATIONS_REGLAGE_REFUSALS.role],
      [no(400, { ok: false, rule: null, code: 'bad_site' }), RECLAMATIONS_REGLAGE_REFUSALS.bad_site],
      [no(400, { ok: false, rule: null, code: 'inconnu_xyz' }), 'Le réglage n’est pas rangé.'],
    ] as const) {
      const t = await run({ [`POST ${PATH}`]: answer, [`GET ${PATH}`]: ok(SET) });
      await t.open();
      await t.click(t.button('Lire le texte du client'));
      await t.click(t.button('Ranger cette version'));
      expect(t.status()).toBe(said);
      expect(t.status()).not.toContain('inconnu_xyz');
    }
    for (const answer of [cut, no(502, { ok: false, code: 'internal' })]) {
      const t = await run({ [`POST ${PATH}`]: answer, [`GET ${PATH}`]: ok(SET) });
      await t.open();
      await t.click(t.button('Lire le texte du client'));
      await t.click(t.button('Ranger cette version'));
      expect(t.status()).toBe(RECLAMATIONS_REGLAGE_LOST);
      expect(t.gets()).toHaveLength(2);
    }
    const u = await run({ [`GET ${PATH}`]: cut });
    await u.open();
    expect(u.status()).toBe('Pas de réseau. Réessayez dans un moment.');
    const v = await run({ [`GET ${PATH}`]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await v.open();
    expect(v.status()).toBe(RECLAMATIONS_REGLAGE_REFUSALS.role);
  });

  it('tout texte reçu est posé en texte ; un champ mal formé est tu ; une seule écriture à la fois', async () => {
    const evil = { ...SET, mediator: { name: INJECTED, site: 'https://m.example.test' }, offerText: `Bonjour, ${INJECTED}` };
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: null, version: 4 }))));
    const t = await run({ [`GET ${PATH}`]: ok(evil), [`POST ${PATH}`]: slow });
    await t.open();
    expect(t.texts()).toContain(`Médiateur : ${INJECTED}, https://m.example.test.`);
    expect(t.texts()).toContain(`Bonjour, ${INJECTED}`);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
    await t.click(t.button('Lire le texte du client'));
    const ranger = t.button('Ranger cette version');
    await t.click(ranger);
    await t.click(ranger);
    expect(t.posts()).toHaveLength(1);
    release();
    await settle();
    expect(t.status()).toContain('Version 4 rangée');
    const odd = await run({ [`GET ${PATH}`]: ok({ version: 'trois', setAt: 'hier', responseDays: -2, mediator: { name: 7, site: null }, offerText: 12, waitingForMediator: 'beaucoup' }) });
    await odd.open();
    expect(odd.texts()).not.toContain('trois');
    expect(odd.texts()).not.toContain('beaucoup');
    expect(odd.texts()).not.toContain('Médiateur :');
    expect(odd.texts()).not.toContain('-2');
    expect(odd.texts()).not.toContain('Le texte que reçoit le client');
  });

  it('en sortant, rien ne reste', async () => {
    const t = await run({ [`GET ${PATH}`]: ok(SET) });
    await t.open();
    expect(t.texts()).toContain('Médiation Exemple');
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.els['engagements-corps']!.children).toEqual([]);
  });
});
