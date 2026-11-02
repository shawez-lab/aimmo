import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { FINANCES_SCRIPT } from '../app/finances.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, chiffres.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const REPORT = {
  day: '2026-11-03',
  period: { from: '2026-11-02', to: '2026-11-02' },
  text: 'Hier : 3 contacts, 1 rendez-vous, 0 mandat, 0 vente.\n2 contacts chauds à rappeler.\nAlerte : 1 rappel en retard.',
  content: {},
};
const ROUTE = 'GET /v1/pilotage/rapport-matin';

async function run(role: 'agent' | 'direction', answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { 'GET /v1/moi': ok({ role, firstName: null }), [ROUTE]: ok(REPORT), ...answers };
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
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const host = role === 'agent' ? 'chiffres' : 'reseau';
  const scripts = () => els[host]!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/finances.js');
  const body = () => els[`rapport-${role}-corps`]!;
  const state = () => els[`rapport-${role}-etat`]!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const press = async () => {
    els[`rapport-${role}-lire`]!.listeners.click!({});
    await settle();
  };
  const load = async () => {
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(FINANCES_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const read = async () => {
    await press();
    await load();
  };
  const reports = () => calls.filter((c) => c.url.startsWith('/v1/pilotage/rapport-matin'));
  return { els, calls, table, body, state, texts, press, load, read, reports, scripts };
}

describe('K10 · le rapport du matin à l’écran', () => {
  it('[R68] l’agent lit son rapport sur « Mes chiffres », ligne par ligne, par la seule route du rapport', async () => {
    const t = await run('agent');
    await t.read();
    expect(t.state()).toContain('Rapport du');
    expect(t.state()).toContain('pour le');
    expect(t.texts()).toContain('Hier : 3 contacts');
    expect(t.body().children).toHaveLength(3);
    expect(t.body().children[2]!.className).toBe('retard');
    // Le serveur choisit le rapport d'après la clé : aucun agent, aucun lecteur dans l'adresse.
    expect(t.reports().map((c) => c.url)).toEqual(['/v1/pilotage/rapport-matin']);
    expect(t.calls.every((c) => !c.url.includes(KEY))).toBe(true);
  });

  it('[R16] la direction lit le sien sur « Le réseau », et son écran ne se mêle pas de celui de l’agent', async () => {
    const t = await run('direction');
    await t.read();
    expect(t.texts()).toContain('Hier : 3 contacts');
    expect(t.els['rapport-agent-corps']!.children).toEqual([]);
  });

  it('une période de plusieurs jours est dite', async () => {
    const t = await run('direction', { [ROUTE]: ok({ ...REPORT, day: '2026-11-02', period: { from: '2026-10-30', to: '2026-11-01' } }) });
    await t.read();
    expect(t.state()).toMatch(/du .* au /);
  });

  it('pas encore de rapport aujourd’hui, ou aucun ce jour-là : c’est dit, sans erreur', async () => {
    const t = await run('agent', { [ROUTE]: ok(null) });
    await t.read();
    expect(t.state()).toBe('Pas encore de rapport aujourd’hui : il s’écrit les jours ouvrés à 7 h 30.');
    expect(t.body().children).toEqual([]);
    t.els['rapport-agent-jour']!.value = '2026-11-01';
    t.table['GET /v1/pilotage/rapport-matin?jour=2026-11-01'] = ok(null);
    await t.press();
    expect(t.state()).toBe('Pas de rapport pour ce jour : il s’écrit les jours ouvrés seulement.');
  });

  it('un autre jour se relit, et un jour mal écrit ne part pas', async () => {
    const t = await run('agent');
    t.els['rapport-agent-jour']!.value = '2026-10-30';
    t.table['GET /v1/pilotage/rapport-matin?jour=2026-10-30'] = ok({ ...REPORT, day: '2026-10-30', period: { from: '2026-10-29', to: '2026-10-29' } });
    await t.read();
    expect(t.reports().map((c) => c.url)).toEqual(['/v1/pilotage/rapport-matin?jour=2026-10-30']);
    t.els['rapport-agent-jour']!.value = 'hier';
    await t.press();
    expect(t.state()).toBe('Choisissez un jour.');
    expect(t.reports()).toHaveLength(1);
    expect(t.body().children).toEqual([]);
  });

  it('[R16] un refus et l’absence de réseau sont dits, et une erreur n’affiche aucun chiffre', async () => {
    const t = await run('agent', { [ROUTE]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.read();
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
    t.table[ROUTE] = async () => Promise.reject(new TypeError('hors ligne'));
    await t.press();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    t.table[ROUTE] = no(500, { ok: false, code: 'panne' });
    await t.press();
    expect(t.state()).toBe('Indisponible pour le moment. Réessayez plus tard.');
    expect(t.body().children).toEqual([]);
  });

  it('[R16] à la déconnexion, le rapport lu disparaît ; une réponse qui tarde ne s’affiche pas à la session suivante', async () => {
    const t = await run('agent');
    await t.read();
    t.els['rapport-agent-jour']!.value = '2026-10-30';
    let release: (r: Response) => void = () => undefined;
    t.table['GET /v1/pilotage/rapport-matin?jour=2026-10-30'] = () => new Promise((r) => (release = r));
    await t.press();
    t.els.sortir!.listeners.click!({});
    await settle();
    release(Response.json({ ok: true, data: REPORT }));
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
    expect(t.els['rapport-agent-jour']!.value).toBe('');
  });

  it('deux appuis rapides font un seul chargement et un seul rapport', async () => {
    const t = await run('agent');
    t.els['rapport-agent-lire']!.listeners.click!({});
    t.els['rapport-agent-lire']!.listeners.click!({});
    await settle();
    expect(t.scripts()).toHaveLength(1);
    await t.load();
    t.els['rapport-agent-lire']!.listeners.click!({});
    t.els['rapport-agent-lire']!.listeners.click!({});
    await settle();
    expect(t.body().children).toHaveLength(3);
  });

  it('un script qui ne charge pas est dit, et un nouvel appui réessaie', async () => {
    const t = await run('direction');
    await t.press();
    t.scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    await t.press();
    expect(t.scripts()).toHaveLength(2);
  });

  it('[R201] le script est servi à part, hors de la coquille, et tient le budget d’une page', async () => {
    expect(AGENT_APP_SHELL).not.toContain('/app/finances.js');
    expect(budgetProblems({ html: '', js: FINANCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    const r = handleAgentApp(new Request('https://x.test/app/finances.js'));
    expect(r?.status).toBe(200);
    expect(HTML).not.toContain('AIMMO_FINANCES');
  });
});
