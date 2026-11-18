import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { MANDAT_MODELES_SCRIPT } from '../app/mandat-modeles.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, réglages, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const MODELS = 'GET /v1/modeles';
const CLAUSES_READ = 'GET /v1/questionnaire-mandat/clauses';
const READ = 'GET /v1/questionnaire-mandat/reglage';
const POST = 'POST /v1/questionnaire-mandat/reglage';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const set = (maxGapBps: number, setAt: string | null = '2027-07-02T08:00:00.000Z') => ({ maxGapBps, isDefault: setAt === null, setAt });

async function run(role: 'direction' | 'compliance', answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string }[] = [];
  const table: Record<string, Answer> = { 'GET /v1/moi': ok({ role, firstName: null }), [MODELS]: ok([]), [CLAUSES_READ]: ok([]), ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, x: string) => storage.set(k, x), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }) });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    setTimeout: () => 0,
    crypto: globalThis.crypto,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const p = role === 'direction' ? 'mandat-modeles' : 'mandat-modeles-c';
  const body = () => els[`${p}-corps`]!;
  const say = () => els[`${p}-etat`]!.textContent;
  const byText = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: { listeners: Record<string, (e: unknown) => void> } | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/mandat-modeles.js');
  const open = async () => {
    await click(els[`${p}-ouvrir`]);
    const s = scripts()[0];
    if (s && !s.attributes['data-lu']) {
      s.attributes['data-lu'] = 'oui';
      runInNewContext(MANDAT_MODELES_SCRIPT, context);
      s.listeners.load!({});
      await settle();
    }
  };
  const input = () => body().all().find((e) => e.tagName === 'input' && e.attributes.id === 'mandat-ecart');
  const store = () => byText('Régler l’écart');
  const said = () => body().all().filter((e) => e.tagName === 'p' && e.attributes.role === 'status').at(-1)?.textContent;
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, body, say, said, byText, click, open, input, store, posts, scripts };
}

const role403 = no(403, { ok: false, rule: 'R16', code: 'role' });

describe('BR119 · l’écart de prix toléré à l’écran', () => {
  it('[R201] dans le script déjà servi à part : rien dans l’application, rien lu avant le geste, budgets tenus', async () => {
    const t = await run('direction', { [READ]: ok(set(500, null)) });
    expect(JS).not.toContain('/v1/questionnaire-mandat/reglage');
    expect(MANDAT_MODELES_SCRIPT).toContain('/v1/questionnaire-mandat/reglage');
    expect(t.calls.some((c) => c.url.includes('/questionnaire-mandat'))).toBe(false);
    expect(budgetProblems({ html: '', js: MANDAT_MODELES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    await t.open();
    expect(t.scripts()).toHaveLength(1);
    expect(t.calls.filter((c) => c.url === '/v1/questionnaire-mandat/reglage')).toHaveLength(1);
  });

  it('[R441] l’écart en pour cent : le défaut est dit tel, un réglage dit sa date, jamais qui l’a réglé', async () => {
    const d = await run('direction', { [READ]: ok(set(500, null)) });
    await d.open();
    expect(d.body().textContent).toContain('En vigueur : 5 % hors de la fourchette de l’avis de valeur validé, réglage par défaut.');
    const r = await run('compliance', { [READ]: ok(set(1250)) });
    await r.open();
    expect(r.body().textContent).toContain('En vigueur : 12,5 % hors de la fourchette de l’avis de valeur validé, réglé le 02/07/2027.');
  });

  it('[R441] la direction règle de 0 à 50 %, deux décimales au plus ; hors bornes, illisible ou inchangé : rien ne part', async () => {
    const t = await run('direction', { [READ]: ok(set(500, null)), [POST]: ok(null) });
    await t.open();
    for (const typed of ['', 'cinq', '50,01', '51', '-1', '2,555', '1e2']) {
      t.input()!.value = typed;
      await t.click(t.store());
      expect(t.said(), typed).toBe('Un écart se règle de 0 à 50 %, deux décimales au plus : rien n’est envoyé.');
    }
    for (const typed of ['5', ' 5,0 % ', '5.00']) {
      t.input()!.value = typed;
      await t.click(t.store());
      expect(t.said(), typed).toBe('L’écart n’a pas changé : rien n’est envoyé.');
    }
    expect(t.posts()).toHaveLength(0);
    t.table[READ] = ok(set(275));
    t.input()!.value = '2,75 %';
    await t.click(t.store());
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/questionnaire-mandat/reglage', body: JSON.stringify({ maxGapBps: 275 }) }]);
    expect(t.said()).toBe('Écart réglé à 2,75 % pour les prochains mandats préparés.');
    expect(t.body().textContent).toContain('En vigueur : 2,75 %');
    for (const [typed, bps] of [['0', 0], ['50', 5000], ['7.5', 750]] as const) {
      t.input()!.value = typed;
      await t.click(t.store());
      expect(JSON.parse(t.posts().at(-1)!.body!)).toEqual({ maxGapBps: bps });
    }
  });

  it('[R441] [R16] les refus du serveur sont dits en français ; la saisie reste', async () => {
    for (const [answer, said] of [
      [no(400, { ok: false, rule: 'R441', code: 'bad_setting' }), 'Un écart se règle de 0 à 50 %, deux décimales au plus : rien n’est rangé.'],
      [role403, 'Ce geste n’est pas dans vos droits.'],
      [no(409, { ok: false, rule: null, code: 'autre_chose' }), 'L’écart n’est pas réglé.'],
    ] as const) {
      const t = await run('direction', { [READ]: ok(set(500, null)), [POST]: answer });
      await t.open();
      t.input()!.value = '10';
      await t.click(t.store());
      expect(t.said()).toBe(said);
      expect(t.input()!.value).toBe('10');
    }
  });

  it('[R16] la conformité lit l’écart sans champ ni bouton ; un refus de droits à la lecture est dit en clair', async () => {
    const t = await run('compliance', { [READ]: ok(set(500, null)) });
    await t.open();
    expect(t.body().textContent).toContain('La direction règle cet écart.');
    expect(t.input()).toBeUndefined();
    expect(t.store()).toBeUndefined();
    const denied = await run('direction', { [READ]: role403 });
    await denied.open();
    expect(denied.said()).toBe('Ce geste n’est pas dans vos droits.');
    expect(denied.store()).toBeUndefined();
  });

  it('une réponse perdue est dite telle, sans refaire le geste ; hors réseau au chargement aussi', async () => {
    const t = await run('direction', { [READ]: ok(set(500, null)), [POST]: no(500, { ok: false, code: 'internal' }) });
    await t.open();
    t.input()!.value = '8';
    await t.click(t.store());
    expect(t.said()).toBe('Réponse perdue : ce réglage est peut-être rangé. Relisez avant de recommencer.');
    expect(t.store()).toBeUndefined();
    expect(t.posts()).toHaveLength(1);
    await t.click(t.byText('Relire l’écart'));
    expect(t.store()).toBeDefined();
    expect(t.posts()).toHaveLength(1);
    const off = await run('direction', { [READ]: () => Promise.reject(new TypeError('hors ligne')) });
    await off.open();
    expect(off.said()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('[R441] une lecture illisible ou une panne n’est jamais prise pour le défaut', async () => {
    for (const answer of [ok(null), ok({ maxGapBps: '500', isDefault: true, setAt: null }), ok({ maxGapBps: 9000, isDefault: false, setAt: 'x' }), ok({ maxGapBps: 500, isDefault: false, setAt: null }), no(500, { ok: false, code: 'internal' })]) {
      const t = await run('direction', { [READ]: answer });
      await t.open();
      expect(t.said()).toBe('L’écart ne se lit pas pour le moment.');
      expect(t.body().textContent).not.toContain('En vigueur : ');
      expect(t.store()).toBeUndefined();
    }
  });

  it('l’écart se lit même quand les modèles et les clauses ne se lisent pas, chacun avec son état', async () => {
    const t = await run('direction', { [MODELS]: no(500, { ok: false, code: 'internal' }), [CLAUSES_READ]: no(500, { ok: false, code: 'internal' }), [READ]: ok(set(500, null)) });
    await t.open();
    expect(t.say()).toBe('Les modèles ne se lisent pas pour le moment.');
    expect(t.body().textContent).toContain('Les clauses ne se lisent pas pour le moment.');
    expect(t.said()).toBe('');
    expect(t.store()).toBeDefined();
  });

  it('[R13] rien ne reste après la sortie', async () => {
    const t = await run('direction', { [READ]: ok(set(1250)) });
    await t.open();
    await t.click(t.els.sortir);
    expect(t.body().textContent).not.toContain('12,5');
  });

  it('[R17] quitter pendant l’envoi : rien ne reste, rien ne se règle deux fois', async () => {
    let answer: (r: Response) => void = () => undefined;
    const t = await run('direction', { [READ]: ok(set(500, null)), [POST]: () => new Promise<Response>((r) => { answer = r; }) });
    await t.open();
    t.input()!.value = '9';
    await t.click(t.store());
    expect(t.said()).toBe('Envoi…');
    await t.click(t.store());
    expect(t.posts()).toHaveLength(1);
    await t.click(t.els['reseau-precedent']);
    answer(Response.json({ ok: true, mode: 'essai', data: null }));
    await settle();
    expect(t.input()).toBeUndefined();
    expect(t.body().textContent).toBe('');
  });
});
