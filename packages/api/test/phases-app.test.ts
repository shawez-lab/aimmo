import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { PHASE_NAMES } from '../../core/src/conditions-phases/index.ts';
import { PHASES_SCRIPT } from '../app/phases.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, raisons, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cond = (state: string, reasons: string[] = []) => ({ state, reasons, evidence: null, hash: null });
const PHASES = {
  readAt: '2028-01-10T09:00:00.000Z',
  current: 2,
  phases: [
    { phase: 1, name: PHASE_NAMES[1], open: true, opening: null, condition: cond('inconnue', ['lecture_impossible', 'code_jamais_vu']), fellSince: true, nextOpenable: false },
    { phase: 2, name: PHASE_NAMES[2], open: true, opening: { phase: 2, openedAt: '2027-12-01T09:00:00.000Z', evidence: { met: true, reasons: [], evidence: {} }, evidenceHash: 'a'.repeat(64) }, condition: cond('remplie'), fellSince: false, nextOpenable: true },
    { phase: 3, name: PHASE_NAMES[3], open: false, opening: null, condition: cond('non_remplie', ['moins_de_3_pilotes']), fellSince: false, nextOpenable: false },
    { phase: 4, name: PHASE_NAMES[4], open: false, opening: null, condition: cond('inconnue'), fellSince: false, nextOpenable: false },
    { phase: 5, name: PHASE_NAMES[5], open: false, opening: null, condition: cond('sans_condition'), fellSince: false, nextOpenable: false },
  ],
};
const line = (code: string, name: string, extra: Record<string, unknown> = {}) => ({ code, name, home: false, open: false, openSince: null, version: null, ...extra });
const REGIONS = (ok = true, reasons: string[] = [], until: string | null = null) => ({
  readAt: '2028-01-10T09:00:00.000Z',
  phase5Open: ok,
  openable: { ok, reasons, until },
  regions: [
    line('27', 'Bourgogne-Franche-Comté', { home: true, open: true }),
    line('11', 'Île-de-France', { open: true, openSince: '2027-12-20T09:00:00.000Z', version: 1 }),
    line('84', 'Auvergne-Rhône-Alpes'),
  ],
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, role = 'direction') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role, firstName: null }),
    'GET /v1/phases': ok(PHASES),
    'GET /v1/regions': ok(REGIONS()),
    'POST /v1/phases/ouvrir': ok({ phase: 3 }),
    'POST /v1/regions/decision': ok({ region: '84', version: 2, open: true, hash: 'b'.repeat(64) }),
    'GET /v1/regions/verification': ok({ intact: true, versions: 1 }),
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
  const body = () => els['phases-corps']!;
  const state = () => els['phases-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const buttons = () => body().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/phases.js');
  const voir = async () => {
    await click(els['phases-voir']);
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(PHASES_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, body, state, texts, find, buttons, input, click, voir, posts, scripts };
}

describe('BR13 · les phases et les régions à l’écran', () => {
  it('[R201] le script ne se charge qu’au premier geste ; chaque condition dite en mots, jamais un code ; une condition retombée dite [R648]', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/phases') || c.url.startsWith('/v1/regions'))).toBe(false);
    await t.voir();
    const x = t.texts();
    expect(x).toContain('Phase 1 · Socle');
    expect(x).toContain('Ouverte d’office.');
    expect(x).toContain('Ouverte le 01/12/2027.');
    expect(x).toContain('Condition remplie');
    expect(x).toContain('Retombée : la phase suivante est ouverte');
    expect(x).toContain('Fermée.');
    for (const code of ['non_remplie', 'sans_condition', 'region_recente', 'phase5_fermee']) expect(x).not.toContain(code);
    const words = t.body().all().map((e) => e.textContent);
    for (const code of ['remplie', 'inconnue']) expect(words).not.toContain(code);
    expect(x).toContain('Condition illisible pour le moment : comptée comme non remplie');
    expect(x).toContain('La condition ne se lit pas pour le moment.');
    expect(x).toContain('Une autre raison, que cet écran ne sait pas encore dire.');
    expect(x).not.toContain('lecture_impossible');
    expect(x).not.toContain('code_jamais_vu');
    // Une phase fermée ne dit pas encore sa condition : elle ne compte qu'une fois ouverte.
    expect(x).not.toContain('Moins de 3 agents pilotes.');
    expect(t.state()).toBe('');
  });

  it('[R647] la phase suivante s’ouvre en deux appuis, et seulement quand le serveur le permet', async () => {
    const t = await run();
    await t.voir();
    // Seule la phase 3 est proposée : la phase 2 dit sa condition remplie, aucune autre ne le permet.
    expect(t.buttons().filter((b) => b.startsWith('Ouvrir la phase'))).toEqual(['Ouvrir la phase 3 : Pilote']);
    await t.click(t.find('Ouvrir la phase 3 : Pilote'));
    expect(t.posts()).toHaveLength(0);
    await t.click(t.find('Confirmer : la phase 3 ouverte ne se referme pas'));
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/phases/ouvrir', body: { phase: 3 } }]);
    expect(t.state()).toBe('Phase 3 ouverte : la preuve lue à l’instant est rangée.');
  });

  it('un refus dit sa raison en mots ; une réponse perdue est dite incertaine', async () => {
    const t = await run({ 'POST /v1/phases/ouvrir': no(409, { ok: false, rule: 'R647', code: 'condition_non_remplie', reasons: ['x'] }) });
    await t.voir();
    await t.click(t.find('Ouvrir la phase 3 : Pilote'));
    await t.click(t.find('Confirmer : la phase 3 ouverte ne se referme pas'));
    expect(t.state()).toBe('La condition de la phase d’avant n’est pas remplie à cet instant.');
    const u = await run({ 'POST /v1/phases/ouvrir': no(500, { ok: false }) });
    await u.voir();
    await u.click(u.find('Ouvrir la phase 3 : Pilote'));
    await u.click(u.find('Confirmer : la phase 3 ouverte ne se referme pas'));
    expect(u.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    const v = await run({ 'GET /v1/phases': no(403, { ok: false, rule: 'R16', code: 'role' }), 'GET /v1/regions': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await v.voir();
    expect(v.state()).toBe('Ce n’est pas dans vos droits.');
  });

  it('[R651] [R652] une région s’ouvre ou se ferme avec sa raison ; la région d’origine n’a aucun geste ; les refus dits avec leur date', async () => {
    const t = await run();
    await t.voir();
    expect(t.texts()).toContain('Ouverte d’office : la région d’origine.');
    expect(t.buttons()).not.toContain('Fermer Bourgogne-Franche-Comté');
    expect(t.buttons()).toContain('Fermer Île-de-France');
    // Raison trop courte : rien ne part.
    await t.click(t.find('Ouvrir Auvergne-Rhône-Alpes'));
    expect(t.posts()).toHaveLength(0);
    expect(t.state()).toBe('La raison : de 3 à 200 caractères.');
    t.input('region-raison-2').value = '  Agents prêts à Lyon  ';
    await t.click(t.find('Ouvrir Auvergne-Rhône-Alpes'));
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/regions/decision', body: { region: '84', open: true, reason: 'Agents prêts à Lyon' } }]);
    expect(t.state()).toBe('Auvergne-Rhône-Alpes ouverte. La décision s’ajoute à la chaîne.');
    const u = await run({ 'POST /v1/regions/decision': no(409, { ok: false, rule: 'R652', code: 'region_recente', until: '2028-03-19T09:00:00.000Z' }) });
    await u.voir();
    u.input('region-raison-2').value = 'Essai';
    await u.click(u.find('Ouvrir Auvergne-Rhône-Alpes'));
    expect(u.state()).toBe('Une autre région s’est ouverte il y a moins de 90 jours. Prochaine ouverture possible le 19/03/2028.');
  });

  it('[R651] sans phase 5 ouverte, aucune région fermée ne propose de s’ouvrir, et la raison est dite', async () => {
    const t = await run({ 'GET /v1/regions': ok(REGIONS(false, ['phase5_fermee', 'region_recente'], '2028-03-19T09:00:00.000Z')) });
    await t.voir();
    expect(t.texts()).toContain('Aucune nouvelle région ne s’ouvre maintenant : la phase 5 n’est pas ouverte, une autre région s’est ouverte il y a moins de 90 jours, jusqu’au 19/03/2028.');
    expect(t.buttons()).not.toContain('Ouvrir Auvergne-Rhône-Alpes');
    expect(t.buttons()).toContain('Fermer Île-de-France');
  });

  it('[R653] la vérification dit la chaîne intacte, ou cassée avec sa version', async () => {
    const t = await run();
    await t.voir();
    await t.click(t.find('Vérifier la chaîne des décisions'));
    expect(t.texts()).toContain('Chaîne intacte : 1 décision(s), aucune réécrite.');
    const u = await run({ 'GET /v1/regions/verification': ok({ intact: false, versions: 3, brokenAt: 2 }) });
    await u.voir();
    await u.click(u.find('Vérifier la chaîne des décisions'));
    expect(u.texts()).toContain('Chaîne cassée à la version 2');
  });

  it('chaque code de condition et de refus du serveur a son libellé', () => {
    // Chaque raison que rendent les modules des conditions, lue dans leur code, a son libellé.
    const sources = ['phase1.ts', 'pilotes.ts', 'portes.ts'].map((f) => readFileSync(new URL(`../../core/src/conditions-phases/${f}`, import.meta.url), 'utf8')).join('\n');
    const reasons = new Set([...sources.matchAll(/reasons\.(?:push|add)\('([a-z0-9_]+)'\)|reasons: \['([a-z0-9_]+)'\]/g)].map((m) => m[1] ?? m[2]!));
    expect(reasons.size).toBeGreaterThanOrEqual(15);
    for (const r of reasons) expect(PHASES_SCRIPT, r).toContain(`"${r}":`);
    for (const c of ['remplie', 'non_remplie', 'inconnue', 'sans_condition']) expect(PHASES_SCRIPT).toContain(`"${c}":`);
    for (const c of ['phase_precedente_fermee', 'condition_non_remplie', 'condition_inconnue', 'deja_ouverte', 'bad_phase', 'region_inconnue', 'region_d_origine', 'deja_fermee', 'bad_reason', 'phase5_fermee', 'region_recente', 'conflit']) {
      expect(PHASES_SCRIPT).toContain(`"${c}":`);
    }
  });

  it('[R201] le script est servi à part, jamais gardé sur l’appareil, et tient son budget ; aucun code de page', () => {
    expect(AGENT_APP_FILES['/app/phases.js']).toBe(PHASES_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/phases.js');
    expect(handleAgentApp(new Request('https://x.test/app/phases.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: PHASES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(PHASES_SCRIPT).not.toContain('innerHTML');
  });
});
