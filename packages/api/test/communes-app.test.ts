import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { COMMUNES_LOST, COMMUNES_REFUSALS, COMMUNES_SCRIPT } from '../app/communes.ts';
import { PHASES_SCRIPT } from '../app/phases.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, communes, raisons, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

/** Le mois fini d'avant celui de Paris, comme l'écran le calcule. */
const lastMonth = (): string => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7)) - 1;
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const MONTH = lastMonth();
const URL_MONTH = `/v1/recrutement/communes?mois=${MONTH}`;

const commune = (name: string, extra: Record<string, unknown> = {}) => ({ commune: name, clientsWaiting: 0, agentsNow: 0, open: false, openSince: null, toOpen: false, toClose: false, ...extra });
const MONTH_DATA = {
  month: MONTH,
  // L'ordre du serveur : l'écran ne le change jamais.
  communes: [
    commune('Commune Trois', { clientsWaiting: 3, toOpen: true }),
    commune('Commune Une', { clientsWaiting: 1, agentsNow: 2, open: true, openSince: '2027-09-03T08:00:00.000Z', toClose: true }),
    commune(INJECTED, { agentsNow: 1 }),
    commune('Commune Deux'),
  ],
  withoutCommune: 2,
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    [`GET ${URL_MONTH}`]: ok(MONTH_DATA),
    'POST /v1/recrutement/communes/decision': ok({ commune: 'Commune Trois', version: 1, open: true }),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const corps = () => els['phases-corps']!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  // Les phases ne répondent pas ici (hors ligne) : la partie des communes se montre quand même.
  await click(els['phases-voir']);
  runInNewContext(PHASES_SCRIPT, context);
  scriptsOf(els.reseau!, '/app/phases.js')[0]!.listeners.load!({});
  await settle();
  const part = () => corps().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Communes à pourvoir')!;
  const button = (text: string) => part().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const buttons = () => part().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const status = () => part().all().find((e) => e.attributes.role === 'status')?.textContent ?? '';
  const texts = () => part().textContent;
  const callsBefore = calls.length;
  const open = async (load = true) => {
    await click(button('Ouvrir les communes à pourvoir'));
    const s = scriptsOf(part(), '/app/communes.js');
    if (load && s.length === 1 && !context.loaded) {
      runInNewContext(COMMUNES_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const reason = (commune: string) => {
    const b = part().all().find((e) => e.tagName === 'button' && e.textContent.endsWith(`${commune} au recrutement`))!;
    const details = part().all().find((e) => e.tagName === 'details' && e.children.includes(b))!;
    return details.children.find((e) => e.tagName === 'textarea')!;
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, context, part, button, buttons, status, texts, click, open, reason, posts, scriptsOf, callsBefore };
}

describe('BR38 · les communes à pourvoir à l’écran', () => {
  it('[R201] servi à part, chargé au seul geste depuis « Phases et régions », jamais gardé ; le budget tient, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/communes.js']).toBe(COMMUNES_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/communes.js');
    const served = handleAgentApp(new Request('https://x.test/app/communes.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: COMMUNES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: PHASES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    // L'application ne change pas : ni la route, ni les mots de l'écran.
    expect(JS).not.toContain('/v1/recrutement');
    expect(JS).not.toContain('/app/communes.js');
    expect(COMMUNES_SCRIPT).not.toContain('innerHTML');
    expect(PHASES_SCRIPT).not.toContain('innerHTML');
    const t = await run();
    expect(t.part()).toBeDefined();
    expect(t.scriptsOf(t.part(), '/app/communes.js')).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/recrutement'))).toBe(false);
    await t.open();
    expect(t.texts()).toContain('Commune Trois');
    // Un second geste ne recharge pas le script : il relit le mois.
    await t.open(false);
    expect(t.scriptsOf(t.part(), '/app/communes.js')).toHaveLength(1);
    expect(t.calls.filter((c) => c.url === URL_MONTH)).toHaveLength(2);
  });

  it('sans réseau au chargement du script, l’écran le dit et le bouton revient', async () => {
    const t = await run();
    await t.open(false);
    const s = t.scriptsOf(t.part(), '/app/communes.js')[0]!;
    s.listeners.error!({});
    await settle();
    expect(t.texts()).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.button('Ouvrir les communes à pourvoir') as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it('un script arrivé sans son écran (page de portail, version ancienne) : l’écran le dit, jamais un bloc vide', async () => {
    const t = await run();
    await t.open(false);
    t.scriptsOf(t.part(), '/app/communes.js')[0]!.listeners.load!({});
    await settle();
    expect(t.texts()).toContain('Indisponible pour le moment. Réessayez dans un moment.');
    expect((t.button('Ouvrir les communes à pourvoir') as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it('une décision rangée reste dite même si la relecture du mois échoue', async () => {
    let n = 0;
    const t = await run({ [`GET ${URL_MONTH}`]: () => (++n === 1 ? ok(MONTH_DATA)() : Promise.reject(new TypeError('coupé'))) });
    await t.open();
    t.reason('Commune Trois').value = 'Trois clients sans agent';
    await t.click(t.button('Ouvrir Commune Trois au recrutement'));
    expect(t.status()).toContain('Commune Trois ouverte au recrutement : la décision est rangée');
    expect(t.status()).toContain('Pas de réseau. Réessayez dans un moment.');
  });

  it('un autre mois demandé pendant l’envoi d’une décision : c’est lui qui est relu après, jamais l’ancien', async () => {
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: { commune: 'Commune Trois', version: 1, open: true } }))));
    const t = await run({ 'POST /v1/recrutement/communes/decision': slow });
    await t.open();
    const select = t.part().all().find((e) => e.tagName === 'select')!;
    const other = select.children[1]!.attributes.value!;
    t.table[`GET /v1/recrutement/communes?mois=${other}`] = ok({ month: other, communes: [commune('Commune Autre')], withoutCommune: 0 });
    t.reason('Commune Trois').value = 'Trois clients sans agent';
    await t.click(t.button('Ouvrir Commune Trois au recrutement'));
    select.value = other;
    await t.click(t.button('Lire ce mois'));
    const reads = t.calls.filter((c) => c.url === URL_MONTH).length;
    const others = t.calls.filter((c) => c.url.endsWith(`mois=${other}`)).length;
    release();
    await settle();
    // Le mois choisi à l'instant est relu après la décision, jamais l'ancien.
    expect(t.calls.filter((c) => c.url === URL_MONTH).length).toBe(reads);
    expect(t.calls.filter((c) => c.url.endsWith(`mois=${other}`)).length).toBe(others + 1);
    expect(t.texts()).toContain('Commune Autre');
    expect(t.status()).toContain('Commune Trois ouverte au recrutement : la décision est rangée');
  });

  it('[R626] le dernier mois fini par défaut ; « à ouvrir » et « à fermer » dits en mots, dans l’ordre reçu, sans aucun code ; tout texte reçu reste du texte', async () => {
    const t = await run();
    await t.open();
    const select = t.part().all().find((e) => e.tagName === 'select')!;
    expect(select.value).toBe(MONTH);
    const options = select.children.map((o) => o.attributes.value!);
    expect(options).toHaveLength(12);
    expect(options[0]).toBe(MONTH);
    // Jamais le mois en cours : le serveur le refuserait.
    expect(options).not.toContain(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).slice(0, 7));
    const x = t.texts();
    expect(x).toMatch(/Mois (de [a-zé]+|d’(avril|août|octobre)) \d{4}/);
    expect(x).toContain('1 commune à ouvrir ; 1 commune à fermer.');
    expect(x).toContain('À ouvrir : des clients ont attendu, aucun agent ne la couvre et elle n’est pas ouverte.');
    expect(x).toContain('À fermer : un agent la couvre désormais, si vous le décidez.');
    expect(x).toContain('3 clients allés à la direction faute d’agent ce mois-là ; aucun agent ne la couvre aujourd’hui.');
    expect(x).toContain('1 client allé à la direction faute d’agent ce mois-là ; 2 agents la couvrent aujourd’hui.');
    expect(x).toContain('Ouverte au recrutement depuis le 03/09/2027.');
    expect(x).toContain('Fermée au recrutement.');
    expect(x).toContain('2 clients allés à la direction sans commune connue, ou hors de la liste');
    // L'ordre du serveur, tel quel.
    expect(x.indexOf('Commune Trois')).toBeLessThan(x.indexOf('Commune Une'));
    expect(x.indexOf('Commune Une')).toBeLessThan(x.indexOf('Commune Deux'));
    expect(COMMUNES_SCRIPT).not.toMatch(/\.sort\(|\.reverse\(/);
    for (const code of ['toOpen', 'toClose', 'clientsWaiting', 'agentsNow', 'true', 'false']) expect(x).not.toContain(code);
    // Le texte reçu est posé en texte : aucune balise n'est créée.
    expect(x).toContain(INJECTED);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(t.buttons()).toEqual([
      'Ouvrir les communes à pourvoir',
      'Lire ce mois',
      'Ouvrir Commune Trois au recrutement',
      'Fermer Commune Une au recrutement',
      `Ouvrir ${INJECTED} au recrutement`,
      'Ouvrir Commune Deux au recrutement',
    ]);
  });

  it('[R14] aucun nom de personne ni d’agent, aucun classement : des nombres et des communes seulement', async () => {
    const t = await run();
    await t.open();
    expect(t.part().all().filter((e) => ['meter', 'progress', 'input'].includes(e.tagName))).toEqual([]);
    const words = t.texts().toLowerCase().split(/[^a-zà-ÿ’]+/);
    for (const w of ['classement', 'rang', 'meilleur', 'meilleure', 'note', 'score']) expect(words).not.toContain(w);
  });

  it('[R627] la raison est exigée avant l’envoi ; ouvrir envoie la commune, le sens et la raison, puis relit le mois', async () => {
    const t = await run();
    await t.open();
    await t.click(t.button('Ouvrir Commune Trois au recrutement'));
    expect(t.posts()).toEqual([]);
    expect(t.status()).toBe(COMMUNES_REFUSALS.bad_reason);
    t.reason('Commune Trois').value = '  ab ';
    await t.click(t.button('Ouvrir Commune Trois au recrutement'));
    expect(t.posts()).toEqual([]);
    t.reason('Commune Trois').value = '  Trois   clients sans agent ce mois-là ';
    const reads = t.calls.filter((c) => c.url === URL_MONTH).length;
    await t.click(t.button('Ouvrir Commune Trois au recrutement'));
    expect(t.posts()).toEqual([
      { method: 'POST', url: '/v1/recrutement/communes/decision', body: { commune: 'Commune Trois', open: true, reason: 'Trois clients sans agent ce mois-là' }, auth: `Bearer ${KEY}` },
    ]);
    expect(t.calls.filter((c) => c.url === URL_MONTH).length).toBe(reads + 1);
    expect(t.status()).toContain('Commune Trois ouverte au recrutement : la décision est rangée');
    // Fermer envoie le sens inverse.
    t.reason('Commune Une').value = 'Deux agents la couvrent';
    await t.click(t.button('Fermer Commune Une au recrutement'));
    expect(t.posts()[1]!.body).toEqual({ commune: 'Commune Une', open: false, reason: 'Deux agents la couvrent' });
    expect(t.status()).toContain('Commune Une fermée au recrutement');
  });

  it('une réponse perdue est dite incertaine, jamais faite ni pas faite ; une panne du serveur aussi', async () => {
    for (const answer of [() => Promise.reject(new TypeError('coupé')), no(503, { ok: false }), async () => new Response('panne', { status: 502 })]) {
      const t = await run({ 'POST /v1/recrutement/communes/decision': answer });
      await t.open();
      t.reason('Commune Trois').value = 'Trois clients sans agent';
      await t.click(t.button('Ouvrir Commune Trois au recrutement'));
      expect(t.status()).toBe(COMMUNES_LOST);
      expect(t.texts()).not.toContain('la décision est rangée');
    }
  });

  it('[R16] droits : un refus se dit en mots ; l’écran ne lit et n’écrit que /v1/recrutement/communes, la clé dans l’en-tête seul', async () => {
    const t = await run({ [`GET ${URL_MONTH}`]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.open();
    expect(t.status()).toBe('Seule la direction lit et décide les communes à pourvoir.');
    expect(t.texts()).not.toContain('role');
    const u = await run({ 'POST /v1/recrutement/communes/decision': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await u.open();
    u.reason('Commune Trois').value = 'Trois clients sans agent';
    await u.click(u.button('Ouvrir Commune Trois au recrutement'));
    expect(u.status()).toBe(COMMUNES_REFUSALS.role);
    const mine = [...t.calls, ...u.calls].filter((c) => c.url.startsWith('/v1/recrutement'));
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const c of mine) {
      expect(c.url.startsWith('/v1/recrutement/communes')).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...COMMUNES_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    for (const r of routes) expect(r.startsWith('/v1/recrutement/communes'), r).toBe(true);
  });

  it('[R627] chaque refus connu de la couche métier a ses mots, jamais son code ; un code inconnu a un texte de secours', async () => {
    const core = readFileSync(new URL('../../core/src/reseau/communes-a-pourvoir.ts', import.meta.url), 'utf8');
    const codes = new Set([...core.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]!));
    for (const c of ["raw.open ? 'deja_ouverte' : 'deja_fermee'"]) expect(core).toContain(c);
    for (const c of ['deja_ouverte', 'deja_fermee', 'invalid_body']) codes.add(c);
    expect(codes.size).toBeGreaterThanOrEqual(10);
    for (const c of codes) expect(COMMUNES_REFUSALS[c], c).toBeTruthy();
    const t = await run({ 'POST /v1/recrutement/communes/decision': no(409, { ok: false, rule: 'R627', code: 'deja_ouverte' }) });
    await t.open();
    t.reason('Commune Trois').value = 'Trois clients sans agent';
    await t.click(t.button('Ouvrir Commune Trois au recrutement'));
    expect(t.status()).toBe('Cette commune est déjà ouverte au recrutement : relisez le mois.');
    const u = await run({ [`GET ${URL_MONTH}`]: no(409, { ok: false, rule: 'R626', code: 'month_not_finished' }) });
    await u.open();
    expect(u.status()).toBe('Ce mois n’est pas fini : seuls les mois finis se lisent.');
    const v = await run({ [`GET ${URL_MONTH}`]: no(409, { ok: false, rule: 'R626', code: 'code_jamais_vu' }) });
    await v.open();
    expect(v.status()).toBe('Les communes ne se lisent pas pour le moment.');
    expect(v.texts()).not.toContain('code_jamais_vu');
  });

  it('une seule décision à la fois ; seule la dernière lecture dessine', async () => {
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: { commune: 'Commune Trois', version: 1, open: true } }))));
    const t = await run({ 'POST /v1/recrutement/communes/decision': slow });
    await t.open();
    t.reason('Commune Trois').value = 'Trois clients sans agent';
    await t.click(t.button('Ouvrir Commune Trois au recrutement'));
    await t.click(t.button('Ouvrir Commune Trois au recrutement'));
    expect(t.posts()).toHaveLength(1);
    release();
    await settle();
    expect(t.status()).toContain('la décision est rangée');

    // Deux lectures de suite : la première, arrivée après, ne dessine rien.
    const later = { ...MONTH_DATA, communes: [commune('Commune Tardive')] };
    let first: () => void = () => undefined;
    let n = 0;
    const u = await run({
      [`GET ${URL_MONTH}`]: () => {
        n += 1;
        if (n === 2) return new Promise<Response>((r) => (first = () => r(Response.json({ ok: true, mode: 'essai', data: later }))));
        return ok(MONTH_DATA)();
      },
    });
    await u.open();
    await u.click(u.button('Lire ce mois'));
    await u.click(u.button('Lire ce mois'));
    first();
    await settle();
    expect(u.texts()).toContain('Commune Trois');
    expect(u.texts()).not.toContain('Commune Tardive');
  });
});
