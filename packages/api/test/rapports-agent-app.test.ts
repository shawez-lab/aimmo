import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import {
  RAPPORTS_AGENT_INACTIVE,
  RAPPORTS_AGENT_ONLY,
  RAPPORTS_AGENT_ROLE,
  RAPPORTS_AGENT_SCRIPT,
  RAPPORTS_BAD_NAME,
  RAPPORTS_BAD_PERIOD,
  RAPPORTS_FAILED,
  RAPPORTS_LOST,
  RAPPORTS_OFFLINE,
  RAPPORTS_SCRIPT,
  RAPPORTS_UNCHECKED,
  RAPPORTS_UNCHECKED_NOTE,
} from '../app/rapports.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, agent, rapports, lignes.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = (body: Record<string, unknown> | null) => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const SAVED = [{ id: 'r1', name: 'Mes mandats', definition: { measures: ['mandats'], grouping: 'total' }, createdAt: '2027-03-01T08:00:00.000Z' }];
const FIGURES = { contacts: { value: 0, lines: [] }, appointments: { value: 0, lines: [] }, mandates: { value: 0, lines: [] }, sales: { value: 0, lines: [] }, upcomingFees: { value: 0, lines: [] } };

/** Le serveur inventé : il rend le rapport de l'agent lecteur (a1), chaque chiffre égal à ses lignes. */
function report(b: Record<string, unknown> | null, definition?: { measures: string[]; grouping: string }, agentId = 'a1') {
  const def = definition ?? (b!.definition as { measures: string[]; grouping: string });
  const keys = def.grouping === 'total' ? ['total'] : ['2027-01', '2027-02', '2027-03'];
  const cells = def.measures.flatMap((m) => keys.map((k) => {
    const lines = k === '2027-02' ? [] : [{ id: `${m}-1`, at: '2027-01-10T09:00:00.000Z' }, { id: `${m}-2`, at: '2027-01-12' }];
    return { measure: m, key: k, value: lines.length, lines };
  }));
  return { scope: 'agent', agentId, from: String(b!.from), to: String(b!.to), definition: def, cells };
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
    'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
    'GET /v1/plan-du-jour': ok(null),
    'GET /v1/contacts-chauds': ok({ contacts: [] }),
    'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
    'GET /v1/usage/matin': ok(null),
    'GET /v1/annonces': ok([]),
    'GET /v1/pilotage/mes-chiffres': ok(FIGURES),
    'GET /v1/finances/rapports': ok(SAVED),
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
      const a = table[`${method} ${url}`] ?? table[`${method} ${url.split('?')[0]}`];
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
  await click(els['chiffres-ouvrir']);
  const part = () => els['chiffres-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Mes rapports sur mesure')!;
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const open = async () => {
    await click(btn(part(), 'Mes rapports sur mesure'));
    const s = scriptsOf(els.fiche!, '/app/rapports-agent.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(RAPPORTS_AGENT_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const status = () => part().children[1]?.textContent ?? '';
  return { els, ctx, calls, table, part, input, open, click, posts, status, button: (t: string) => btn(part(), t), text: () => part().textContent };
}

describe('BR95 · mes rapports sur mesure depuis « Mes chiffres »', () => {
  it('[R201] [R68] un second script servi à part, chargé au seul geste ; budgets tenus ; seules les routes des rapports, jamais la liste des agents ni le réseau', async () => {
    expect(AGENT_APP_FILES['/app/rapports-agent.js']).toBe(RAPPORTS_AGENT_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/rapports-agent.js');
    const res = handleAgentApp(new Request('https://x.test/app/rapports-agent.js'))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: RAPPORTS_AGENT_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/finances/rapports');
    expect(RAPPORTS_AGENT_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|eval\(|fetch\(/);
    for (const path of RAPPORTS_AGENT_SCRIPT.match(/'\/v1\/[^']*'/g) ?? []) expect(path).toBe("'/v1/finances/rapports'");
    expect(RAPPORTS_AGENT_SCRIPT).not.toContain('recommandations/agents');
    expect(RAPPORTS_AGENT_SCRIPT).not.toMatch(/network: true|'reseau'/);
    expect(RAPPORTS_AGENT_SCRIPT).not.toContain('Total du réseau');
    expect(RAPPORTS_AGENT_SCRIPT).toContain('globalThis.AIMMO_RAPPORTS_AGENT =');
    // Le script de la direction reste le sien.
    expect(RAPPORTS_SCRIPT).toContain('globalThis.AIMMO_RAPPORTS =');
    expect(RAPPORTS_SCRIPT).toContain('/v1/gagner/recommandations/agents');
    const d = await desk();
    expect(scriptsOf(d.els.fiche!, '/app/rapports-agent.js')).toHaveLength(0);
    expect(d.calls.some((c) => c.url.startsWith('/v1/finances'))).toBe(false);
    await d.open();
    expect(scriptsOf(d.els.fiche!, '/app/rapports-agent.js')).toHaveLength(1);
    expect(d.calls.filter((c) => c.method === 'GET' && (c.url.startsWith('/v1/finances') || c.url.includes('/agents'))).map((c) => c.url)).toEqual(['/v1/finances/rapports']);
    expect(d.part().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent)).toEqual(['Composer un rapport', 'Mes rapports enregistrés']);
    expect(d.text()).toContain(RAPPORTS_AGENT_ONLY);
    for (const id of ['mes-rapports-contacts', 'mes-rapports-regroupement', 'mes-rapports-du', 'mes-rapports-au', 'mes-rapports-nom']) {
      expect(d.part().all().some((e) => e.tagName === 'label' && e.attributes.for === id)).toBe(true);
    }
    // Aucune portée à choisir : ni le réseau, ni un autre agent.
    expect(d.part().all().some((e) => e.attributes.id === 'mes-rapports-portee' || e.attributes.id === 'rapports-portee')).toBe(false);
    expect(d.posts()).toHaveLength(0);
  });

  it('[R68] [R560] lire : le corps n’a ni agentId ni network ; 12 derniers mois de Paris par défaut ; période fausse arrêtée avant l’envoi', async () => {
    const d = await desk();
    await d.open();
    expect(d.input('mes-rapports-du').value).toBe('2026-04-01');
    expect(d.input('mes-rapports-au').value).toBe('2027-03-20');
    d.input('mes-rapports-du').value = '2026-03-01';
    await d.click(d.button('Lire le rapport'));
    expect(d.status()).toBe(RAPPORTS_BAD_PERIOD);
    expect(d.posts()).toHaveLength(0);
    d.input('mes-rapports-du').value = '2027-01-01';
    await d.click(d.button('Lire le rapport'));
    expect(d.posts()[0]).toEqual({ method: 'POST', url: '/v1/finances/rapports/lecture', body: { definition: { measures: ['contacts', 'mandats'], grouping: 'mois' }, from: '2027-01-01', to: '2027-03-20' } });
    expect(d.text()).toContain('Mes chiffres seulement');
    for (const p of d.posts()) {
      expect(p.body!).not.toHaveProperty('agentId');
      expect(p.body!).not.toHaveProperty('network');
    }
  });

  it('[R69] [R560] chaque chiffre recompté sur ses lignes et ouvert sur elles ; un chiffre faux dit non vérifiable, jamais montré (Jamais vu)', async () => {
    const d = await desk();
    await d.open();
    await d.click(d.button('Lire le rapport'));
    const sums = d.part().all().filter((e) => e.tagName === 'summary').map((e) => e.textContent);
    expect(sums).toContain('Contacts attribués : 2');
    expect(d.text()).toContain('Contacts attribués : 0');
    expect(d.text()).toContain('mandats-2 · 12/01/2027');
    expect(d.text()).not.toContain(RAPPORTS_UNCHECKED);
    const bad = await desk({
      'POST /v1/finances/rapports/lecture': async (b) => {
        const r = report(b);
        r.cells[0]!.value = 9;
        r.cells[1]!.lines = [{ id: INJECTED, at: '2027-02-01' }];
        r.cells[1]!.value = 1;
        return Response.json({ ok: true, mode: 'essai', data: r });
      },
    });
    await bad.open();
    await bad.click(bad.button('Lire le rapport'));
    expect(bad.text()).toContain(`Contacts attribués : ${RAPPORTS_UNCHECKED}`);
    expect(bad.text()).not.toContain('Contacts attribués : 9');
    expect(bad.text()).not.toContain(INJECTED);
    expect(bad.text()).toContain(RAPPORTS_UNCHECKED_NOTE);
  });

  it('[R14] [R68] une réponse du réseau, ou d’un autre agent que celui de la première lecture, est jetée (Jamais vu)', async () => {
    const net = await desk({ 'POST /v1/finances/rapports/lecture': async (b) => { const { agentId: _a, ...r } = report(b); return Response.json({ ok: true, mode: 'essai', data: { ...r, scope: 'reseau' } }); } });
    await net.open();
    await net.click(net.button('Lire le rapport'));
    expect(net.text()).not.toContain('Contacts attribués : 2');
    expect(net.status()).toContain('Les rapports n’ont pas pu être lus');
    let who = 'a1';
    const other = await desk({ 'POST /v1/finances/rapports/lecture': async (b) => Response.json({ ok: true, mode: 'essai', data: report(b, undefined, who) }) });
    await other.open();
    await other.click(other.button('Lire le rapport'));
    expect(other.text()).toContain('Contacts attribués : 2');
    who = 'a2';
    await other.click(other.button('Lire le rapport'));
    expect(other.text()).not.toContain('Contacts attribués : 2');
    expect(other.status()).toContain('Les rapports n’ont pas pu être lus');
    const bogus = await desk({ 'POST /v1/finances/rapports/lecture': async (b) => Response.json({ ok: true, mode: 'essai', data: report(b, undefined, INJECTED) }) });
    await bogus.open();
    await bogus.click(bogus.button('Lire le rapport'));
    expect(bogus.text()).not.toContain('Contacts attribués : 2');
  });

  it('enregistrer et relire ses rapports sur la période choisie ; nom de 1 à 80 caractères', async () => {
    const d = await desk();
    await d.open();
    expect(d.text()).toContain('Mes mandats');
    await d.click(d.button('Enregistrer ce rapport'));
    expect(d.status()).toBe(RAPPORTS_BAD_NAME);
    expect(d.posts()).toHaveLength(0);
    d.input('mes-rapports-nom').value = ' Mes contacts ';
    await d.click(d.button('Enregistrer ce rapport'));
    expect(d.posts()[0]).toEqual({ method: 'POST', url: '/v1/finances/rapports', body: { name: 'Mes contacts', definition: { measures: ['contacts', 'mandats'], grouping: 'mois' } } });
    expect(d.status()).toContain('Rapport « Mes contacts » enregistré');
    d.input('mes-rapports-du').value = '2027-02-01';
    await d.click(d.button('Relire « Mes mandats »'));
    expect(d.posts()[1]).toEqual({ method: 'POST', url: '/v1/finances/rapports/r1/lecture', body: { from: '2027-02-01', to: '2027-03-20' } });
    expect(d.part().all().filter((e) => e.tagName === 'summary').map((e) => e.textContent)).toContain('Mandats signés : 2');
  });

  it('[R16] refus (droits, compte pas en activité, période), réseau coupé dits en mots ; une session finie jetée', async () => {
    const cases: [Answer, string][] = [
      [no(403, { ok: false, rule: 'R16', code: 'role' }), RAPPORTS_AGENT_ROLE],
      [no(409, { ok: false, rule: 'R14', code: 'compares_agents' }), RAPPORTS_AGENT_ONLY],
      [no(400, { ok: false, rule: null, code: 'bad_period' }), RAPPORTS_BAD_PERIOD],
      [no(403, { ok: false, rule: 'R16', code: 'other_network' }), RAPPORTS_FAILED],
      [no(500, { ok: false }), RAPPORTS_FAILED],
      [cut, RAPPORTS_LOST],
    ];
    for (const [answer, said] of cases) {
      const d = await desk({ 'POST /v1/finances/rapports/lecture': answer });
      await d.open();
      await d.click(d.button('Lire le rapport'));
      expect(d.status()).toBe(said);
      expect(d.status()).not.toMatch(/R1[46]|role|agent_inactive|compares/);
    }
    const role = await desk({ 'GET /v1/finances/rapports': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await role.open();
    expect(role.status()).toBe(RAPPORTS_AGENT_ROLE);
    expect(role.text()).not.toContain('Composer un rapport');
    // Un compte qui n'est plus en activité : l'application referme la session, rien du rapport ne reste à l'écran.
    const inactive = await desk({ 'POST /v1/finances/rapports/lecture': no(403, { ok: false, rule: 'R16', code: 'agent_inactive' }) });
    await inactive.open();
    await inactive.click(inactive.button('Lire le rapport'));
    expect(inactive.els['chiffres']!.hidden).toBe(true);
    expect(inactive.els['connexion']!.hidden).toBe(false);
    expect(inactive.els['chiffres']!.textContent).not.toContain('Contacts attribués');
    expect(RAPPORTS_AGENT_SCRIPT).toContain(JSON.stringify(RAPPORTS_AGENT_INACTIVE).slice(1, -1));
    const offline = await desk({ 'GET /v1/finances/rapports': cut });
    await offline.open();
    expect(offline.status()).toBe(RAPPORTS_OFFLINE);
    let release: (r: Response) => void = () => undefined;
    let pending: Record<string, unknown> | null = null;
    const slow = await desk({ 'POST /v1/finances/rapports/lecture': (b) => { pending = b; return new Promise<Response>((r) => { release = r; }); } });
    await slow.open();
    await slow.click(slow.button('Lire le rapport'));
    // Changer de période rouvre « Mes chiffres » : une nouvelle session, la lecture d'avant est jetée.
    await slow.click(slow.els['chiffres-precedent']);
    release(Response.json({ ok: true, mode: 'essai', data: report(pending) }));
    await settle();
    expect(slow.els['chiffres']!.textContent).not.toContain('Contacts attribués : 2');
  });
});
