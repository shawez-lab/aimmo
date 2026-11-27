import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { NOTIFICATIONS_HOT_LINE, NOTIFICATIONS_SCREEN_REFUSALS, NOTIFICATIONS_SCRIPT, NOTIFICATIONS_UNSURE } from '../app/notifications.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { fakeDocument, pageIds, type FakeElement } from './fake-dom.ts';

// Tout est inventé : clé, fiches, envois, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const offline: Answer = () => Promise.reject(new TypeError('hors ligne'));

const SETTINGS = { quietStart: 21 * 60, quietEnd: 8 * 60 + 30, levels: { client_ecrit: 'haute', rendez_vous: 'haute', piece_recue: 'normale', tache: 'normale', info: 'coupee' } };
const HOT = { id: 'n1', personId: 'p1', kind: 'contact_chaud', urgency: 'immediate', status: 'envoyee', pushId: 'e1', createdAt: '2027-03-02T09:30:00.000Z', sentAt: '2027-03-02T09:30:20.000Z' };
const WROTE = { id: 'n2', personId: 'p2', kind: 'client_ecrit', urgency: 'haute', status: 'a_envoyer', pushId: null, createdAt: '2027-03-02T16:00:00.000Z', sentAt: null };
const UNSAFE = { id: 'n3', personId: 'mauvais id !', kind: 'info', urgency: 'basse', status: 'envoyee', pushId: null, createdAt: '2027-03-02T16:00:00.000Z', sentAt: null };
const ODD = { id: 'n4', personId: 'p4', kind: INJECTED, urgency: 'basse', status: INJECTED, pushId: null, createdAt: INJECTED, sentAt: null };

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, hash = '') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: { method: string; url: string; body: unknown }[] = [];
  const replaced: string[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
    'GET /v1/notifications/reglages': ok(SETTINGS),
    'GET /v1/notifications': ok([HOT, WROTE, UNSAFE, ODD]),
    'GET /v1/notifications/envois/e1': ok([HOT]),
    'POST /v1/notifications/reglages': ok(SETTINGS),
    ...answers,
  };
  const location = { hash };
  const context: Record<string, unknown> = {
    document,
    Date,
    Promise,
    location,
    // Comme un navigateur : sans adresse donnée, l'adresse ne change pas (l'historique des écrans, AU117).
    history: { replaceState: (_s: unknown, _t: string, url?: string) => { if (url === undefined) return; replaced.push(url); location.hash = ''; }, pushState: () => undefined },
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
      const a = table[`${method} ${url}`];
      return a ? a() : offline();
    },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  const scripts = () => els.accueil!.all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/notifications.js');
  const load = async () => {
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(NOTIFICATIONS_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const open = async (loading = true) => {
    els['notifications-ouvrir']!.listeners.click!({});
    await settle();
    if (loading) await load();
  };
  const status = () => els['notifications-etat']!.textContent;
  const body = () => els['notifications-corps']!;
  const find = (pred: (e: FakeElement) => boolean) => body().all().find(pred);
  const byId = (id: string) => find((e) => e.attributes.id === id);
  const items = () => body().all().filter((e) => e.tagName === 'li');
  const press = async (label: string) => {
    find((e) => e.tagName === 'button' && e.textContent === label)!.listeners.click!({});
    await settle();
  };
  const count = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length;
  return { els, calls, table, context, replaced, scripts, load, open, status, body, find, byId, items, press, count };
}

describe('BR67 · « Mes notifications » sur l’accueil de l’agent', () => {
  it('[R201] servi à part, chargé au seul geste, jamais gardé ; les budgets tiennent, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/notifications.js']).toBe(NOTIFICATIONS_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/notifications.js');
    const served = handleAgentApp(new Request('https://x.test/app/notifications.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: NOTIFICATIONS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(NOTIFICATIONS_SCRIPT).not.toContain('innerHTML');
    expect(JS).not.toContain("'/v1/notifications");
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/notifications'))).toBe(false);
    // DS011 · le bloc est dans l'écran « Outils » de l'agent, plus sur sa journée.
    const outils = HTML.slice(HTML.indexOf('<section id="outils"'));
    expect(outils.slice(0, outils.indexOf('<section id=', 10))).toContain('<button id="notifications-ouvrir" type="button" class="secondaire rangee">Mes notifications</button>');
    await t.open();
    expect(t.status()).toBe('');
    // Un second geste relit tout sans recharger le script.
    await t.open(false);
    expect(t.scripts()).toHaveLength(1);
    expect(t.count('GET', '/v1/notifications')).toBe(2);
    expect(t.count('GET', '/v1/notifications/reglages')).toBe(2);
  });

  it('[R413] [R412] les heures calmes en heures, chaque sorte réglable, le contact chaud dit et jamais réglable', async () => {
    const t = await run();
    await t.open();
    expect(t.byId('notifications-debut')!.value).toBe('21:00');
    expect(t.byId('notifications-fin')!.value).toBe('08:30');
    expect(t.body().textContent).toContain('Aujourd’hui : de 21 h à 8 h 30, heure de Paris.');
    expect(t.body().textContent).toContain('tout le dimanche');
    expect(t.body().textContent).toContain(NOTIFICATIONS_HOT_LINE);
    for (const k of ['client_ecrit', 'rendez_vous', 'piece_recue', 'tache', 'info']) expect(t.byId(`notifications-niveau-${k}`)).toBeDefined();
    expect(t.byId('notifications-niveau-contact_chaud')).toBeUndefined();
    expect(t.byId('notifications-niveau-info')!.value).toBe('coupee');
    const info = t.byId('notifications-niveau-info')!;
    expect(info.all().filter((e) => e.tagName === 'option').map((o) => o.textContent)).toEqual([
      'Haute : un envoi par quart d’heure au plus',
      'Normale : un envoi par heure au plus',
      'Basse : un envoi par jour',
      'Coupée : rien n’arrive au téléphone',
    ]);
    // L'agent change ses heures et un niveau : rangés en minutes du jour, sans le contact chaud.
    t.byId('notifications-debut')!.value = '22:15';
    t.byId('notifications-fin')!.value = '07:00';
    t.byId('notifications-niveau-tache')!.value = 'basse';
    await t.press('Ranger mes réglages');
    const sent = t.calls.filter((c) => c.method === 'POST' && c.url === '/v1/notifications/reglages');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ quietStart: 22 * 60 + 15, quietEnd: 7 * 60, levels: { client_ecrit: 'haute', rendez_vous: 'haute', piece_recue: 'normale', tache: 'basse', info: 'coupee' } });
    expect(JSON.stringify(sent[0]!.body)).not.toContain('contact_chaud');
    expect(t.body().textContent).toContain('Rangé : heures calmes de 22 h 15 à 7 h.');
  });

  it('[R413] une heure illisible n’est pas envoyée, et la raison est dite', async () => {
    const t = await run();
    await t.open();
    t.byId('notifications-fin')!.value = '';
    await t.press('Ranger mes réglages');
    expect(t.count('POST', '/v1/notifications/reglages')).toBe(0);
    expect(t.body().textContent).toContain(NOTIFICATIONS_SCREEN_REFUSALS.invalid_quiet);
    t.byId('notifications-fin')!.value = '25:00';
    await t.press('Ranger mes réglages');
    expect(t.count('POST', '/v1/notifications/reglages')).toBe(0);
  });

  it('[R16] chaque refus du serveur est dit en mots, jamais par son code ; une écriture sans réponse est dite incertaine', async () => {
    const t = await run({ 'POST /v1/notifications/reglages': no(400, { ok: false, rule: 'R412', code: 'hot_fixed', message: 'x' }) });
    await t.open();
    await t.press('Ranger mes réglages');
    expect(t.body().textContent).toContain(NOTIFICATIONS_SCREEN_REFUSALS.hot_fixed);
    expect(t.body().textContent).not.toContain('hot_fixed');
    t.table['POST /v1/notifications/reglages'] = offline;
    await t.press('Ranger mes réglages');
    expect(t.body().textContent).toContain(NOTIFICATIONS_UNSURE);
    t.table['POST /v1/notifications/reglages'] = no(500, { ok: false });
    await t.press('Ranger mes réglages');
    expect(t.body().textContent).toContain(NOTIFICATIONS_UNSURE);
    // Un rôle refusé à la lecture : dit en mots, rien d'autre n'est posé.
    const d = await run({ 'GET /v1/notifications/reglages': no(403, { ok: false, rule: 'R16', code: 'not_self', message: 'x' }) });
    await d.open();
    expect(d.status()).toBe(NOTIFICATIONS_SCREEN_REFUSALS.not_self);
    expect(d.items()).toHaveLength(0);
    const e = await run({ 'GET /v1/notifications': offline });
    await e.open();
    expect(e.status()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('[R16] la liste dit sorte, date et état en mots, dans l’ordre reçu, ouvre la fiche ; un champ mal formé n’est pas dit', async () => {
    const t = await run();
    await t.open();
    const items = t.items();
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Contact chaud à rappeler, le 02/03/2027 à 10:30 : envoyée.');
    expect(items[1]!.textContent).toContain('Message d’un client, le 02/03/2027 à 17:00 : à envoyer.');
    expect(t.body().textContent).not.toContain('<img');
    expect(t.body().textContent).not.toContain('mauvais id');
    items[0]!.all().find((e) => e.tagName === 'button' && e.textContent === 'Voir la fiche')!.listeners.click!({});
    await settle();
    expect(t.count('GET', '/v1/fiches/p1/resume')).toBe(1);
    const empty = await run({ 'GET /v1/notifications': ok([]) });
    await empty.open();
    expect(empty.body().textContent).toContain('Aucune notification pour le moment.');
  });

  it('[R415] ouvert par le lien d’une notification : le bloc montre l’envoi, puis l’adresse est nettoyée', async () => {
    const t = await run({}, '#envoi=e1');
    // Sans geste : le lien charge le bloc une fois l'agent entré.
    expect(t.scripts()).toHaveLength(1);
    await t.load();
    expect(t.replaced).toEqual(['/app/']);
    expect(t.count('GET', '/v1/notifications/envois/e1')).toBe(1);
    const first = t.body().all().find((e) => e.tagName === 'h4')!;
    expect(first.textContent).toBe('Cette notification');
    expect(t.items()[0]!.textContent).toContain('Contact chaud à rappeler');
    // Rouvert ensuite, le bloc ne relit plus l'envoi.
    await t.open(false);
    expect(t.count('GET', '/v1/notifications/envois/e1')).toBe(1);
    // Un envoi qui n'est pas le sien, ou un identifiant mal formé : dit inconnu, rien d'autre n'est lu.
    const u = await run({ 'GET /v1/notifications/envois/e9': no(404, { ok: false, code: 'unknown' }) }, '#envoi=e9');
    await u.load();
    expect(u.body().textContent).toContain(NOTIFICATIONS_SCREEN_REFUSALS.unknown);
    const bad = await run({}, '#envoi=pas%20bon');
    await bad.load();
    expect(bad.calls.some((c) => c.url.startsWith('/v1/notifications/envois/'))).toBe(false);
    expect(bad.body().textContent).toContain(NOTIFICATIONS_SCREEN_REFUSALS.unknown);
    expect(bad.replaced).toEqual(['/app/']);
  });

  it('[R415] un réseau coupé à l’ouverture du lien ne perd pas l’envoi : le geste suivant le montre', async () => {
    const t = await run({ 'GET /v1/notifications/envois/e1': offline }, '#envoi=e1');
    await t.load();
    expect(t.status()).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.replaced).toEqual(['/app/']);
    t.table['GET /v1/notifications/envois/e1'] = ok([HOT]);
    await t.open(false);
    expect(t.count('GET', '/v1/notifications/envois/e1')).toBe(2);
    expect(t.body().all().find((e) => e.tagName === 'h4')!.textContent).toBe('Cette notification');
    // Montré une fois, il n'est plus relu.
    await t.open(false);
    expect(t.count('GET', '/v1/notifications/envois/e1')).toBe(2);
  });

  it('[R415] le lien /notifications/<envoi> renvoie vers l’application sans rien lire ; un identifiant mal formé est inconnu', async () => {
    const r = handleAgentApp(new Request('https://x.test/notifications/e1-ab_C'))!;
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/app/#envoi=e1-ab_C');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(handleAgentApp(new Request('https://x.test/notifications/e1', { method: 'POST' }))).toBeNull();
    expect(handleAgentApp(new Request('https://x.test/notifications/pas!bon'))).toBeNull();
    expect(handleAgentApp(new Request('https://x.test/notifications/a/b'))).toBeNull();
    // Par le point d'entrée : aucune base n'est lue (la configuration n'en a pas), en mode essai seulement.
    const config = { mode: 'essai' } as unknown as ApiConfig;
    const viaApi = await handleRequest(new Request('https://x.test/notifications/e1'), config);
    expect(viaApi.status).toBe(302);
    const closed = await handleRequest(new Request('https://x.test/notifications/e1'), { mode: 'production' } as unknown as ApiConfig);
    expect(closed.status).toBe(503);
    const unknown = await handleRequest(new Request('https://x.test/notifications/pas!bon'), config);
    expect(unknown.status).toBe(404);
  });

  it('la sortie efface le bloc, et le lien est écrit dans docs/API.md', async () => {
    const t = await run();
    await t.open();
    expect(t.items().length).toBeGreaterThan(0);
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().all()).toHaveLength(0);
    expect(t.status()).toBe('');
    const api = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    expect(api).toContain('`/notifications/<id>`');
    expect(api).toContain('`/app/#envoi=<id>`');
  });
});
