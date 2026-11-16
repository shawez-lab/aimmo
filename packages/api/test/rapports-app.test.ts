import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import {
  RAPPORTS_BAD_NAME,
  RAPPORTS_BAD_PERIOD,
  RAPPORTS_FAILED,
  RAPPORTS_LOST,
  RAPPORTS_NEVER_TWO,
  RAPPORTS_NO_MEASURE,
  RAPPORTS_OFFLINE,
  RAPPORTS_REFUSALS,
  RAPPORTS_ROLE,
  RAPPORTS_SCRIPT,
  RAPPORTS_UNCHECKED,
  RAPPORTS_UNCHECKED_NOTE,
} from '../app/rapports.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, agents, rapports, lignes.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = (body: Record<string, unknown> | null) => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const AGENTS = [
  { agentId: 'a1', firstName: 'Lina', lastName: 'Morel' },
  { agentId: 'a2', firstName: 'Paul', lastName: 'Renard' },
];
const SAVED = [{ id: 'r1', name: 'Mandats du mois', definition: { measures: ['mandats'], grouping: 'mois' }, createdAt: '2027-03-01T08:00:00.000Z' }];

/** Le serveur inventé : il rend le rapport demandé, chaque chiffre égal à ses lignes. */
function report(b: Record<string, unknown> | null, definition?: { measures: string[]; grouping: string }) {
  const def = definition ?? (b!.definition as { measures: string[]; grouping: string });
  const from = String(b!.from), to = String(b!.to);
  const keys = def.grouping === 'total' ? ['total'] : ['2027-01', '2027-02', '2027-03'];
  const cells = def.measures.flatMap((m) => keys.map((k) => {
    const lines = k === '2027-02' ? [] : [{ id: `${m}-1`, at: '2027-01-10T09:00:00.000Z' }, { id: `${m}-2`, at: '2027-01-12' }];
    return { measure: m, key: k, value: lines.length, lines };
  }));
  const scope = b!.network === true ? { scope: 'reseau' } : { scope: 'agent', agentId: b!.agentId };
  return { ...scope, from, to, definition: def, cells };
}
const served: Answer = async (b) => Response.json({ ok: true, mode: 'essai', data: report(b) });

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
const btn = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);

async function desk(answers: Record<string, Answer> = {}, now = '2027-03-20T10:00:00.000Z') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  (document as { body?: FakeElement }).body = new FakeElement('body');
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/gagner/engagements': ok([]),
    'GET /v1/finances/rapports': ok(SAVED),
    'GET /v1/gagner/recommandations/agents': ok(AGENTS),
    'POST /v1/finances/rapports/lecture': served,
    'POST /v1/finances/rapports/r1/lecture': async (b) => Response.json({ ok: true, mode: 'essai', data: report(b, SAVED[0]!.definition) }),
    'POST /v1/finances/rapports': ok({ id: 'r2' }),
    ...answers,
  };
  const fixed = Date.parse(now);
  class FixedDate extends Date {
    constructor(...a: unknown[]) {
      if (a.length) super(a[0] as string);
      else super(fixed);
    }
    static override now() { return fixed; }
  }
  const ctx: Record<string, unknown> = {
    document,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      const a = table[`${method} ${url}`] ?? (method === 'GET' && url === '/v1/moi' ? ok({ role: 'direction', firstName: null }) : undefined);
      return a ? a(body) : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date: FixedDate,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, ctx);
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  await click(els['engagements-voir']);
  runInNewContext(ENGAGEMENTS_SCRIPT, ctx);
  scriptsOf(els.reseau!, '/app/engagements.js')[0]!.listeners.load!({});
  await settle();
  const part = () => els['engagements-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Rapports sur mesure')!;
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const open = async () => {
    await click(btn(part(), 'Ouvrir les rapports'));
    const s = scriptsOf(part(), '/app/rapports.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(RAPPORTS_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const status = () => part().all().find((e) => e.className === 'rapports')?.children[0]?.textContent ?? '';
  const choose = async (id: string, value: string) => {
    const e = input(id);
    e.value = value;
    e.listeners.change?.({});
    await settle();
  };
  return { els, ctx, calls, table, part, input, open, click, posts, status, choose, button: (t: string) => btn(part(), t), text: () => part().textContent };
}

describe('BR94 · les rapports sur mesure à l’écran de la direction', () => {
  it('[R201] un seul script servi à part, chargé au seul geste sous les engagements ; budgets tenus, sans innerHTML ni fetch', async () => {
    expect(AGENT_APP_FILES['/app/rapports.js']).toBe(RAPPORTS_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/rapports.js');
    const res = handleAgentApp(new Request('https://x.test/app/rapports.js'))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: RAPPORTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: ENGAGEMENTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/finances/rapports');
    expect(RAPPORTS_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|eval\(|fetch\(/);
    for (const path of RAPPORTS_SCRIPT.match(/'\/v1\/[^']*'/g) ?? []) expect(path).toMatch(/^'\/v1\/(finances\/rapports|gagner\/recommandations\/agents)'$/);
    const d = await desk();
    expect(scriptsOf(d.part(), '/app/rapports.js')).toHaveLength(0);
    expect(d.calls.some((c) => c.url.startsWith('/v1/finances'))).toBe(false);
    await d.open();
    expect(scriptsOf(d.part(), '/app/rapports.js')).toHaveLength(1);
    expect(d.calls.filter((c) => c.method === 'GET' && (c.url.startsWith('/v1/finances') || c.url.includes('/agents'))).map((c) => c.url).sort()).toEqual(['/v1/finances/rapports', '/v1/gagner/recommandations/agents']);
    await d.click(d.button('Ouvrir les rapports'));
    expect(scriptsOf(d.part(), '/app/rapports.js')).toHaveLength(1);
    expect(d.part().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent)).toEqual(['Composer un rapport', 'Mes rapports enregistrés']);
    for (const id of ['rapports-contacts', 'rapports-mandats', 'rapports-regroupement', 'rapports-du', 'rapports-au', 'rapports-portee', 'rapports-nom']) {
      expect(d.part().all().some((e) => e.tagName === 'label' && e.attributes.for === id)).toBe(true);
    }
    expect(d.posts()).toHaveLength(0);
  });

  it('[R560] composition : mesures cochées, regroupement, 12 derniers mois de Paris par défaut ; une composition fausse arrêtée avant l’envoi', async () => {
    const d = await desk();
    await d.open();
    expect(d.input('rapports-du').value).toBe('2026-04-01');
    expect(d.input('rapports-au').value).toBe('2027-03-20');
    expect(d.input('rapports-regroupement').value).toBe('mois');
    expect(d.input('rapports-contacts').checked).toBe(true);
    expect(d.input('rapports-rendez_vous').checked).toBe(false);
    expect(d.text()).toContain(RAPPORTS_NEVER_TWO);
    // Le total du réseau d'abord, puis les agents de la liste, sans identifiant à taper.
    expect(d.input('rapports-portee').children.map((o) => o.textContent)).toEqual(['Le total du réseau', 'Lina Morel', 'Paul Renard']);
    d.input('rapports-contacts').checked = false;
    d.input('rapports-mandats').checked = false;
    await d.click(d.button('Lire le rapport'));
    expect(d.status()).toBe(RAPPORTS_NO_MEASURE);
    d.input('rapports-ventes').checked = true;
    d.input('rapports-du').value = '2026-03-01';
    await d.click(d.button('Lire le rapport'));
    expect(d.status()).toBe(RAPPORTS_BAD_PERIOD);
    d.input('rapports-du').value = '2027-03-21';
    await d.click(d.button('Lire le rapport'));
    expect(d.status()).toBe(RAPPORTS_BAD_PERIOD);
    d.input('rapports-du').value = '2027-02-30';
    await d.click(d.button('Lire le rapport'));
    expect(d.status()).toBe(RAPPORTS_BAD_PERIOD);
    expect(d.posts()).toHaveLength(0);
    // Un an moins un jour passe.
    d.input('rapports-du').value = '2026-03-21';
    await d.click(d.button('Lire le rapport'));
    expect(d.posts()).toHaveLength(1);
  });

  it('[R14] portée : le total du réseau ou un seul agent, corps conforme à la route, jamais les deux', async () => {
    const d = await desk();
    await d.open();
    await d.click(d.button('Lire le rapport'));
    expect(d.posts()[0]).toEqual({ method: 'POST', url: '/v1/finances/rapports/lecture', body: { definition: { measures: ['contacts', 'mandats'], grouping: 'mois' }, from: '2026-04-01', to: '2027-03-20', network: true } });
    expect(d.text()).toContain('Total du réseau');
    await d.choose('rapports-portee', 'a2');
    d.input('rapports-regroupement').value = 'total';
    await d.click(d.button('Lire le rapport'));
    expect(d.posts()[1]!.body).toEqual({ definition: { measures: ['contacts', 'mandats'], grouping: 'total' }, from: '2026-04-01', to: '2027-03-20', agentId: 'a2' });
    expect(d.text()).toContain('Agent : Paul Renard');
    expect(d.text()).not.toContain('Total du réseau');
    for (const p of d.posts()) expect(p.body!.network === true && p.body!.agentId !== undefined).toBe(false);
  });

  it('[R69] [R560] chaque chiffre recompté sur ses lignes, ouvert sur elles ; mois vide à zéro ; chiffre faux dit non vérifiable, jamais montré (Jamais vu)', async () => {
    const d = await desk();
    await d.open();
    await d.click(d.button('Lire le rapport'));
    const text = d.text();
    expect(text).toContain('janvier 2027');
    expect(text).toContain('février 2027');
    const sums = d.part().all().filter((e) => e.tagName === 'summary').map((e) => e.textContent);
    expect(sums).toContain('Contacts attribués : 2');
    expect(sums).toContain('Mandats signés : 2');
    // Le mois sans ligne se lit zéro, il ne disparaît pas.
    expect(text).toContain('Contacts attribués : 0');
    expect(text).toContain('mandats-1 · 10/01/2027');
    expect(text).toContain('mandats-2 · 12/01/2027');
    expect(text).not.toContain(RAPPORTS_UNCHECKED);
    const bad = await desk({
      'POST /v1/finances/rapports/lecture': async (b) => {
        const r = report(b);
        r.cells[0]!.value = 7; // 7 annoncé, 2 lignes
        r.cells[1]!.lines = [{ id: INJECTED, at: '2027-02-01' }];
        r.cells[1]!.value = 1;
        return Response.json({ ok: true, mode: 'essai', data: r });
      },
    });
    await bad.open();
    await bad.click(bad.button('Lire le rapport'));
    expect(bad.text()).toContain(`Contacts attribués : ${RAPPORTS_UNCHECKED}`);
    expect(bad.text()).not.toContain('Contacts attribués : 7');
    expect(bad.text()).not.toContain(INJECTED);
    expect(bad.text()).toContain(RAPPORTS_UNCHECKED_NOTE);
    // Une mesure demandée absente de la réponse : rien n'est montré comme un fait.
    const missing = await desk({ 'POST /v1/finances/rapports/lecture': async (b) => { const r = report(b); r.cells = r.cells.filter((c) => c.measure !== 'mandats'); return Response.json({ ok: true, mode: 'essai', data: r }); } });
    await missing.open();
    await missing.click(missing.button('Lire le rapport'));
    expect(missing.text()).not.toContain('Contacts attribués : 2');
    expect(missing.text()).toContain('Les rapports n’ont pas pu être lus');
  });

  it('[R14] changer de portée efface le rapport ; une réponse d’une autre portée ou d’une lecture plus ancienne est jetée (Jamais vu)', async () => {
    let release: (r: Response) => void = () => undefined;
    let pending: Record<string, unknown> | null = null;
    const d = await desk({
      'POST /v1/finances/rapports/lecture': (b) => {
        if (b!.agentId === 'a1') { pending = b; return new Promise<Response>((r) => { release = r; }); }
        return served(b);
      },
    });
    await d.open();
    await d.choose('rapports-portee', 'a2');
    await d.click(d.button('Lire le rapport'));
    expect(d.text()).toContain('Agent : Paul Renard');
    // Changer d'agent efface aussitôt le rapport du premier.
    await d.choose('rapports-portee', 'a1');
    expect(d.text()).not.toContain('Agent : Paul Renard');
    await d.click(d.button('Lire le rapport'));
    // Avant la réponse, on revient au total : la réponse de Lina Morel, arrivée après, est jetée.
    await d.choose('rapports-portee', '');
    release(Response.json({ ok: true, mode: 'essai', data: report(pending) }));
    await settle();
    expect(d.text()).not.toContain('Agent : Lina Morel');
    // Une réponse pour un autre agent que celui demandé n'est jamais montrée.
    const wrong = await desk({ 'POST /v1/finances/rapports/lecture': async (b) => Response.json({ ok: true, mode: 'essai', data: report({ ...b!, agentId: 'a1' }) }) });
    await wrong.open();
    await wrong.choose('rapports-portee', 'a2');
    await wrong.click(wrong.button('Lire le rapport'));
    expect(wrong.text()).not.toContain('Agent :');
    expect(wrong.text()).not.toContain('Contacts attribués : 2');
    expect(wrong.status()).toContain('Les rapports n’ont pas pu être lus');
    // Une réponse du réseau quand un agent était demandé : jetée aussi.
    const net = await desk({ 'POST /v1/finances/rapports/lecture': async (b) => { const { agentId: _a, ...rest } = b!; return Response.json({ ok: true, mode: 'essai', data: report({ ...rest, network: true }) }); } });
    await net.open();
    await net.choose('rapports-portee', 'a1');
    await net.click(net.button('Lire le rapport'));
    expect(net.text()).not.toContain('Total du réseau');
  });

  it('enregistrer : nom de 1 à 80 caractères, refus dits en mots ; les rapports enregistrés listés et relus sur la période et la portée choisies', async () => {
    const d = await desk();
    await d.open();
    expect(d.text()).toContain('Mandats du mois');
    expect(d.text()).toContain('Mandats signés · Mois par mois (heure de Paris)');
    await d.click(d.button('Enregistrer ce rapport'));
    expect(d.status()).toBe(RAPPORTS_BAD_NAME);
    d.input('rapports-nom').value = 'x'.repeat(81);
    await d.click(d.button('Enregistrer ce rapport'));
    expect(d.status()).toBe(RAPPORTS_BAD_NAME);
    expect(d.posts()).toHaveLength(0);
    d.input('rapports-nom').value = '  Contacts et mandats  ';
    await d.click(d.button('Enregistrer ce rapport'));
    expect(d.posts()[0]).toEqual({ method: 'POST', url: '/v1/finances/rapports', body: { name: 'Contacts et mandats', definition: { measures: ['contacts', 'mandats'], grouping: 'mois' } } });
    expect(d.status()).toBe('Rapport « Contacts et mandats » enregistré : il ne change plus, et vous seul le relisez.');
    expect(d.calls.filter((c) => c.method === 'GET' && c.url === '/v1/finances/rapports')).toHaveLength(2);
    // Relire un rapport enregistré, pour un agent, sur la période choisie.
    await d.choose('rapports-portee', 'a1');
    d.input('rapports-du').value = '2027-01-01';
    await d.click(d.button('Relire « Mandats du mois »'));
    expect(d.posts()[1]).toEqual({ method: 'POST', url: '/v1/finances/rapports/r1/lecture', body: { from: '2027-01-01', to: '2027-03-20', agentId: 'a1' } });
    expect(d.text()).toContain('Agent : Lina Morel');
    expect(d.part().all().filter((e) => e.tagName === 'summary').map((e) => e.textContent)).toContain('Mandats signés : 2');
    // Un rapport enregistré mal formé n'est pas montré.
    const odd = await desk({ 'GET /v1/finances/rapports': ok([{ id: 'r9', name: INJECTED, definition: { measures: ['classement'], grouping: 'mois' } }]) });
    await odd.open();
    expect(odd.text()).not.toContain(INJECTED);
    expect(odd.text()).toContain('Aucun rapport enregistré.');
    // Refus de l'enregistrement dit en mots.
    const refused = await desk({ 'POST /v1/finances/rapports': no(400, { ok: false, rule: null, code: 'bad_name' }) });
    await refused.open();
    refused.input('rapports-nom').value = 'Nom';
    await refused.click(refused.button('Enregistrer ce rapport'));
    expect(refused.status()).toBe(RAPPORTS_BAD_NAME);
    const lost = await desk({ 'POST /v1/finances/rapports': cut });
    await lost.open();
    lost.input('rapports-nom').value = 'Nom';
    await lost.click(lost.button('Enregistrer ce rapport'));
    expect(lost.status()).toContain('le rapport a pu s’enregistrer');
  });

  it('[R16] refus (droits, comparaison, période, rapport inconnu), réseau coupé, réponse perdue dits en mots ; une session finie jetée', async () => {
    const cases: [Answer, string][] = [
      [no(403, { ok: false, rule: 'R16', code: 'role' }), RAPPORTS_ROLE],
      [no(403, { ok: false, rule: 'R16', code: 'other_network' }), RAPPORTS_REFUSALS.other_network!],
      [no(409, { ok: false, rule: 'R14', code: 'compares_agents' }), RAPPORTS_NEVER_TWO],
      [no(400, { ok: false, rule: null, code: 'bad_period' }), RAPPORTS_BAD_PERIOD],
      [no(400, { ok: false, rule: null, code: 'mystere' }), RAPPORTS_FAILED],
      [no(500, { ok: false }), RAPPORTS_FAILED],
      [cut, RAPPORTS_LOST],
    ];
    for (const [answer, said] of cases) {
      const d = await desk({ 'POST /v1/finances/rapports/lecture': answer });
      await d.open();
      await d.click(d.button('Lire le rapport'));
      expect(d.status()).toBe(said);
      expect(d.status()).not.toMatch(/R1[46]|role|compares/);
    }
    const unknown = await desk({ 'POST /v1/finances/rapports/r1/lecture': no(404, { ok: false, rule: null, code: 'unknown_report' }) });
    await unknown.open();
    await unknown.click(unknown.button('Relire « Mandats du mois »'));
    expect(unknown.status()).toBe(RAPPORTS_REFUSALS.unknown_report);
    const role = await desk({ 'GET /v1/finances/rapports': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await role.open();
    expect(role.status()).toBe(RAPPORTS_ROLE);
    expect(role.text()).not.toContain('Composer un rapport');
    const offline = await desk({ 'GET /v1/finances/rapports': cut, 'GET /v1/gagner/recommandations/agents': cut });
    await offline.open();
    expect(offline.status()).toBe(RAPPORTS_OFFLINE);
    // Sans la liste des agents, seul le total se lit, et c'est dit.
    const noAgents = await desk({ 'GET /v1/gagner/recommandations/agents': cut });
    await noAgents.open();
    expect(noAgents.status()).toContain('seul le total du réseau se lit');
    expect(noAgents.input('rapports-portee').children.map((o) => o.textContent)).toEqual(['Le total du réseau']);
    // Une lecture qui revient après la fin de la session est jetée.
    let release: (r: Response) => void = () => undefined;
    let pending: Record<string, unknown> | null = null;
    const slow = await desk({ 'POST /v1/finances/rapports/lecture': (b) => { pending = b; return new Promise<Response>((r) => { release = r; }); } });
    await slow.open();
    await slow.click(slow.button('Lire le rapport'));
    await slow.click(slow.els['sortir']);
    release(Response.json({ ok: true, mode: 'essai', data: report(pending) }));
    await settle();
    expect(slow.els['reseau']!.textContent).not.toContain('Contacts attribués : 2');
  });
});
