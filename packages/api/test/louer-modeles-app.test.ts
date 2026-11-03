import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { LOUER_MODELES_SCRIPT } from '../app/louer-modeles.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, modèles, versions.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const READ = 'GET /v1/location/modeles-bail';
const POST = 'POST /v1/location/modeles-bail';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const v = (version: number, status: 'essai' | 'valide', body = `Texte ${version} ${INJECTED}`) => ({ id: `m${version}`, version, status, body, createdAt: '2027-07-01T08:00:00.000Z', validatedAt: status === 'valide' ? '2027-07-02T08:00:00.000Z' : null });
const none = { kind: 'bail_meuble', current: null, latest: null };
const state = (role: 'direction' | 'compliance', current: unknown, latest: unknown = current) => ({ canStore: role === 'direction', canValidate: role === 'compliance', kinds: [{ kind: 'bail_vide', current, latest }, none] });

async function run(role: 'direction' | 'compliance', answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string }[] = [];
  const table: Record<string, Answer> = { 'GET /v1/moi': ok({ role, firstName: null }), ...answers };
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
  const p = role === 'direction' ? 'louer-modeles' : 'louer-modeles-c';
  const body = () => els[`${p}-corps`]!;
  const say = () => els[`${p}-etat`]!.textContent;
  const byText = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: { listeners: Record<string, (e: unknown) => void> } | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.louer!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/louer-modeles.js');
  const open = async () => {
    await click(els[`${p}-ouvrir`]);
    const s = scripts()[0];
    if (s && !s.attributes['data-lu']) {
      s.attributes['data-lu'] = 'oui';
      runInNewContext(LOUER_MODELES_SCRIPT, context);
      s.listeners.load!({});
      await settle();
    }
  };
  const area = () => body().all().find((e) => e.tagName === 'textarea');
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, body, say, byText, click, open, area, posts, scripts };
}

describe('W17 · modèles de bail à l’écran', () => {
  it('[R201] servi à part, rien n’est lu avant le geste, budget tenu, application comprise', async () => {
    const t = await run('direction', { [READ]: ok(state('direction', null, null)) });
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url.includes('modeles-bail'))).toBe(false);
    expect(budgetProblems({ html: '', js: LOUER_MODELES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(JS).not.toContain('/v1/location/modeles-bail');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/louer-modeles.js'))!;
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(await served.text()).toBe(LOUER_MODELES_SCRIPT);
    await t.open();
    await t.open();
    expect(t.scripts()).toHaveLength(1);
    expect(t.body().textContent).toContain('Aucun modèle : aucun bail de cette sorte ne peut se préparer.');
  });

  it('un modèle non validé est dit d’essai ; tout texte reste du texte', async () => {
    const t = await run('direction', { [READ]: ok(state('direction', v(1, 'essai'))) });
    await t.open();
    expect(t.body().textContent).toContain('En vigueur. Version 1, modèle d’essai, pas validé : le bail qu’il fait reste un document d’essai.');
    expect(t.body().textContent).toContain(INJECTED);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('[R17] la direction ajoute une version : l’ancienne reste, et le bail garde le dernier validé', async () => {
    const t = await run('direction', { [READ]: ok(state('direction', v(1, 'valide', 'Ancien texte'))), [POST]: ok({ id: 'm2', kind: 'bail_vide', version: 2, status: 'essai', fields: [], hash: 'h' }) });
    await t.open();
    expect(t.body().textContent).toContain('En vigueur. Version 1, validée le 02/07/2027.');
    expect(t.area()!.value).toBe('Ancien texte');
    // Sans changement, rien ne part.
    await t.click(t.byText('Ranger une nouvelle version'));
    expect(t.say()).toBe('Le texte n’a pas changé : aucune version ajoutée.');
    expect(t.posts()).toHaveLength(0);
    t.area()!.value = 'Nouveau texte';
    t.table[READ] = ok(state('direction', v(1, 'valide', 'Ancien texte'), v(2, 'essai', 'Nouveau texte')));
    await t.click(t.byText('Ranger une nouvelle version'));
    expect(t.posts()[0]).toMatchObject({ url: '/v1/location/modeles-bail', body: JSON.stringify({ kind: 'bail_vide', body: 'Nouveau texte' }) });
    expect(t.say()).toBe('Version 2 rangée, modèle d’essai. L’ancienne version reste.');
    const text = t.body().textContent;
    expect(text).toContain('Ancien texte');
    expect(text).toContain('Dernière version rangée, pas en vigueur tant qu’elle n’est pas validée. Version 2, modèle d’essai');
    expect(t.area()!.value).toBe('Nouveau texte');
  });

  it('[R16] la direction n’a aucun bouton de validation ; un refus de droits est dit en clair', async () => {
    const t = await run('direction', { [READ]: ok(state('direction', v(1, 'essai'))), [POST]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.open();
    expect(t.body().all().some((e) => e.tagName === 'button' && /^Valider/.test(e.textContent ?? ''))).toBe(false);
    t.area()!.value = 'Autre texte';
    await t.click(t.byText('Ranger une nouvelle version'));
    expect(t.say()).toBe('Ce geste n’est pas dans vos droits.');
    const denied = await run('direction', { [READ]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await denied.open();
    expect(denied.say()).toBe('Ce geste n’est pas dans vos droits.');
  });

  it('[R16] la conformité valide en deux appuis, sans formulaire ; ce qui est validé n’offre plus le geste', async () => {
    const t = await run('compliance', { [READ]: ok(state('compliance', v(1, 'essai'))), 'POST /v1/location/modeles-bail/m1/validation': ok(true) });
    await t.open();
    expect(t.area()).toBeUndefined();
    expect(t.byText('Ranger une nouvelle version')).toBeUndefined();
    await t.click(t.byText('Valider la version 1'));
    expect(t.posts()).toHaveLength(0);
    expect(t.say()).toBe('Appuyez encore pour valider la version 1.');
    t.table[READ] = ok(state('compliance', v(1, 'valide')));
    await t.click(t.byText('Confirmer : texte relu par l’avocat'));
    expect(t.posts()).toHaveLength(1);
    expect(t.say()).toBe('Version 1 validée.');
    expect(t.byText('Valider la version 1')).toBeUndefined();
    expect(t.body().textContent).toContain('Version 1, validée le 02/07/2027.');
  });

  it('un champ manquant ou inconnu est dit en français, sans code ; rien n’est rangé', async () => {
    const t = await run('direction', { [READ]: ok(state('direction', v(1, 'essai'))), [POST]: no(409, { ok: false, rule: 'R40', code: 'missing_required_field', field: 'loyer.hors_charges' }) });
    await t.open();
    t.area()!.value = 'Texte incomplet';
    await t.click(t.byText('Ranger une nouvelle version'));
    expect(t.say()).toContain('Il manque le champ {{loyer.hors_charges}}');
    expect(t.say()).toContain('rien n’est rangé');
    expect(t.say()).not.toContain('missing_required_field');
    t.table[POST] = no(409, { ok: false, rule: 'R40', code: 'unknown_field' });
    await t.click(t.byText('Ranger une nouvelle version'));
    expect(t.say()).toBe('Le modèle porte un champ entre accolades que le bail ne connaît pas : rien n’est rangé.');
  });

  it('une réponse perdue est dite telle, sans refaire le geste ; hors réseau au chargement aussi', async () => {
    const t = await run('direction', { [READ]: ok(state('direction', v(1, 'essai'))) });
    await t.open();
    t.area()!.value = 'Autre texte';
    await t.click(t.byText('Ranger une nouvelle version'));
    expect(t.say()).toBe('Réponse perdue : ce geste est peut-être rangé. Relisez avant de recommencer.');
    expect(t.byText('Ranger une nouvelle version')).toBeUndefined();
    await t.click(t.byText('Relire les modèles de bail'));
    expect(t.byText('Ranger une nouvelle version')).toBeDefined();
    const off = await run('direction');
    await off.open();
    expect(off.say()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('[R16] après la sortie, les textes lus ne restent pas à l’écran', async () => {
    const t = await run('direction', { [READ]: ok(state('direction', v(1, 'essai', 'Texte lu'))) });
    await t.open();
    expect(t.body().textContent).toContain('Texte lu');
    await t.click(t.els.sortir);
    expect(t.body().textContent).not.toContain('Texte lu');
  });
});
