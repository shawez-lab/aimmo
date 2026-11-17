import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ATTIRER_SCRIPT } from '../app/attirer.ts';
import { LETTRE_LOST, LETTRE_REFUSALS, LETTRE_SCRIPT } from '../app/lettre.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : titres, magazine, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));
const MAGAZINE: Answer = async () => new Response('<!doctype html><title>Magazine</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const EDITIONS = '/v1/marketing/lettre/editions';
const MAG = '/v1/marketing/magazine';

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  const blobs: string[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    'GET /v1/attirer/sites': ok([]),
    [`POST ${EDITIONS}`]: ok({ id: 'ed-1' }),
    [`GET ${MAG}`]: MAGAZINE,
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
    URL: {
      createObjectURL: (b: Blob) => {
        blobs.push(b.type);
        return 'blob:aimmo/magazine';
      },
      revokeObjectURL: () => {},
    },
    Intl,
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
  await click(els['attirer-ouvrir']);
  runInNewContext(ATTIRER_SCRIPT, context);
  els.attirer!.children.filter((e) => e.tagName === 'script')[0]!.listeners.load!({});
  await settle();
  const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  const part = () => els['attirer-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Lettre et magazine')!;
  const button = (text: string) => part().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const buttons = () => part().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const status = () => part().all().find((e) => e.attributes.role === 'status')?.textContent ?? '';
  const byId = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const open = async (load = true) => {
    await click(button('Ouvrir la lettre et le magazine'));
    const s = scriptsOf(part(), '/app/lettre.js');
    if (load && s.length === 1 && !context.loaded) {
      runInNewContext(LETTRE_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const marketing = () => calls.filter((c) => c.url.startsWith('/v1/marketing'));
  const title = (text: string) => {
    byId('lettre-titre').value = text;
    return click(button('Ouvrir cette édition'));
  };
  return { els, calls, context, page, part, button, buttons, status, click, open, marketing, scriptsOf, byId, title, blobs };
}

describe('BR111 · la lettre et le magazine à l’écran de la direction', () => {
  it('[R201] servi à part, chargé au seul geste depuis « Attirer », jamais gardé ; le budget tient, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/lettre.js']).toBe(LETTRE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/lettre.js');
    const served = handleAgentApp(new Request('https://x.test/app/lettre.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: LETTRE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: ATTIRER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/app/lettre.js');
    expect(LETTRE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    const t = await run();
    expect(t.part()).toBeDefined();
    expect(t.scriptsOf(t.part(), '/app/lettre.js')).toHaveLength(0);
    await t.open();
    // Ouvrir ne lit rien : seul un geste écrit ou tire.
    expect(t.marketing()).toEqual([]);
    expect(t.buttons()).toEqual(['Ouvrir la lettre et le magazine', 'Ouvrir cette édition', 'Tirer le magazine']);
    await t.open(false);
    expect(t.scriptsOf(t.part(), '/app/lettre.js')).toHaveLength(1);
  });

  it('sans réseau au chargement du script : l’écran le dit et le bouton revient', async () => {
    const t = await run();
    await t.open(false);
    t.scriptsOf(t.part(), '/app/lettre.js')[0]!.listeners.error!({});
    await settle();
    expect(t.part().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.button('Ouvrir la lettre et le magazine') as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it('[R586] titre sans chiffre, de 3 à 80 caractères, refusé avant l’appel ; le titre rangé est celui envoyé', async () => {
    const t = await run();
    await t.open();
    for (const bad of ['', '  ', 'ab', 'La lettre de 2027', 'Lettre n°3', 'x'.repeat(81)]) {
      await t.title(bad);
      expect(t.status()).toBe(LETTRE_REFUSALS.titre);
    }
    expect(t.marketing()).toEqual([]);
    await t.title('  La lettre   du printemps ');
    expect(t.marketing()).toEqual([{ method: 'POST', url: '/v1/marketing/lettre/editions', body: { title: 'La lettre du printemps' }, auth: `Bearer ${KEY}` }]);
    expect(t.status()).toBe('Édition « La lettre du printemps » ouverte. Elle partira par le passage planifié : rien n’est parti d’ici.');
    expect(t.byId('lettre-titre').value).toBe('');
  });

  it('[R26, R583, R584] aucun envoi ni publication proposé ; seules les routes de la lettre et du magazine', async () => {
    const t = await run();
    const before = t.calls.length;
    await t.open();
    expect(t.buttons().filter((b) => /envoy|publi|diffus/i.test(b))).toEqual([]);
    await t.title('La lettre du printemps');
    await t.click(t.button('Tirer le magazine'));
    expect(t.calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${EDITIONS}`, `GET ${MAG}`]);
  });

  it('le magazine part avec la clé dans l’en-tête, jamais dans l’adresse, et s’enregistre sans être posé dans la page', async () => {
    const t = await run();
    await t.open();
    await t.click(t.button('Tirer le magazine'));
    const c = t.marketing();
    expect(c).toEqual([{ method: 'GET', url: MAG, body: null, auth: `Bearer ${KEY}` }]);
    expect(c[0]!.url).not.toContain(KEY);
    expect(t.blobs).toHaveLength(1);
    expect(t.status()).toBe('Magazine enregistré : ouvrez-le pour l’imprimer ou l’enregistrer en PDF.');
    expect(t.part().all().some((e) => ['iframe', 'object', 'embed'].includes(e.tagName))).toBe(false);
    expect(t.part().textContent).not.toContain('<title>');
  });

  it('refus du magazine dits en mots, jamais un code ; une réponse qui n’est pas une page n’est pas enregistrée', async () => {
    const cases: [Answer, string][] = [
      [no(409, { ok: false, rule: 'R585', code: 'prix_inconnu' }), LETTRE_REFUSALS.prix_inconnu!],
      [no(409, { ok: false, rule: 'R09', code: 'coordonnee' }), LETTRE_REFUSALS.coordonnee!],
      [no(409, { ok: false, rule: 'R07', code: 'texte' }), LETTRE_REFUSALS.texte!],
      [no(403, { ok: false, rule: 'R16', code: 'role' }), LETTRE_REFUSALS.role!],
      [no(500, { ok: false }), 'Le magazine ne se tire pas pour le moment.'],
      [ok({ html: '<p>x</p>' }), 'Le magazine ne se tire pas pour le moment.'],
      [no(401, { ok: false }), 'Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'],
      [cut, 'Pas de réseau. Réessayez dans un moment.'],
    ];
    for (const [answer, said] of cases) {
      const t = await run({ [`GET ${MAG}`]: answer });
      await t.open();
      await t.click(t.button('Tirer le magazine'));
      expect(t.status()).toBe(said);
      expect(t.blobs).toEqual([]);
      expect(t.status()).not.toMatch(/prix_inconnu|coordonnee|R\d+/);
    }
  });

  it('une page coupée en route : rien n’est enregistré, l’écran le dit', async () => {
    const broken: Answer = async () => {
      const r = new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      Object.defineProperty(r, 'blob', { value: () => Promise.reject(new TypeError('coupé')) });
      return r;
    };
    const t = await run({ [`GET ${MAG}`]: broken });
    await t.open();
    await t.click(t.button('Tirer le magazine'));
    expect(t.status()).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.blobs).toEqual([]);
  });

  it('refus d’une édition dits en mots ; réponse perdue ou panne dite incertaine ; une écriture à la fois', async () => {
    const cases: [Answer, string][] = [
      [no(409, { ok: false, rule: 'R586', code: 'titre' }), LETTRE_REFUSALS.titre!],
      [no(403, { ok: false, rule: 'R16', code: 'role' }), LETTRE_REFUSALS.role!],
      [no(400, { ok: false, rule: null, code: 'unknown_field' }), LETTRE_REFUSALS.unknown_field!],
      [no(400, { ok: false, rule: null, code: 'autre' }), 'L’édition n’est pas ouverte.'],
      [no(500, { ok: false }), LETTRE_LOST],
      [cut, LETTRE_LOST],
    ];
    for (const [answer, said] of cases) {
      const t = await run({ [`POST ${EDITIONS}`]: answer });
      await t.open();
      await t.title('La lettre du printemps');
      expect(t.status()).toBe(said);
      expect(t.byId('lettre-titre').value).toBe('La lettre du printemps');
    }
    let release: () => void = () => {};
    const t = await run({ [`POST ${EDITIONS}`]: () => new Promise((r) => (release = () => r(Response.json({ ok: true, data: { id: 'ed-2' } })))) });
    await t.open();
    t.byId('lettre-titre').value = 'La lettre d’automne';
    t.button('Ouvrir cette édition')!.listeners.click!({});
    t.button('Ouvrir cette édition')!.listeners.click!({});
    await settle();
    expect(t.marketing()).toHaveLength(1);
    release();
    await settle();
    expect(t.status()).toContain('ouverte');
  });
});
