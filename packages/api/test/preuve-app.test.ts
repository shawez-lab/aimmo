import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { FINANCES_SCRIPT } from '../app/finances.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, chiffres.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const month = (over: Record<string, unknown>) => ({ month: '2027-01', complete: true, counted: 12, simple: 4, exclusive: 8, untyped: 0, cancelledError: 0, withdrawn: 0, terminated: 0, notInscribed: 0, targetMet: true, ...over });
const COUNTER = {
  startMonth: '2027-01',
  target: 10,
  requiredMonths: 6,
  currentMonth: '2027-03',
  months: [month({}), month({ month: '2027-02', counted: 9, simple: 9, exclusive: 0, targetMet: false, notInscribed: 2, withdrawn: 1 }), month({ month: '2027-03', complete: false, counted: 3, simple: 3, exclusive: 0, targetMet: false })],
  currentRun: { length: 0, from: null, to: null },
  bestRun: { length: 1, from: '2027-01', to: '2027-01' },
  condition: { met: false, metOn: null },
  registerSound: true,
};
const PUBLISHED = { months: [{ month: '2027-01', counted: null, sealSeq: null, corrected: false, changedSinceSeal: false }, { month: '2027-02', counted: null, sealSeq: null, corrected: false, changedSinceSeal: false }], seals: [], chainSound: true, registerSound: true, condition: { met: false, metOn: null } };

async function run(answers: Record<string, Answer> = {}, role = 'direction') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role, firstName: null }),
    'GET /v1/pilotage/rapport-matin': ok(null),
    'GET /v1/pilotage/preuve': ok(COUNTER),
    'GET /v1/pilotage/preuve/sceaux': ok(PUBLISHED),
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
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const read = async (who: 'direction' | 'agent' = 'direction') => {
    els[`rapport-${who}-lire`]!.listeners.click!({});
    await settle();
    const s = els[who === 'agent' ? 'chiffres' : 'reseau']!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/finances.js');
    if (s.length === 1 && !context.loaded) {
      runInNewContext(FINANCES_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const corps = () => els['preuve-corps']!;
  const texts = () => corps().all().map((e) => e.textContent).join(' | ');
  const buttons = () => corps().all().filter((e) => e.tagName === 'button');
  const inputs = () => corps().all().filter((e) => e.tagName === 'input');
  const seals = () => calls.filter((c) => c.method === 'POST' && c.url === '/v1/pilotage/preuve/sceau');
  return { els, calls, table, read, corps, texts, buttons, inputs, seals };
}

describe('IN05 · la preuve à l’écran de la direction', () => {
  it('[R210] [R211] montre la série, chaque mois, ce qui reste à inscrire, et le mois en cours sans geste', async () => {
    const t = await run();
    await t.read();
    const text = t.texts();
    expect(text).toContain('Série en cours : 0 mois sur 6');
    expect(text).toContain('janvier 2027 : 12 sur 10');
    expect(text).toContain('8 exclusifs, 4 simples');
    expect(text).toContain('février 2027 : 9 sur 10');
    expect(text).toContain('1 rétractés');
    expect(text).toContain('2 mandats signés restent à inscrire');
    expect(text).toContain('mars 2027 : 3 sur 10, mois en cours');
    // Janvier et février finis, pas scellés : un geste chacun ; mars : aucun.
    expect(t.buttons().map((b) => b.textContent)).toEqual(['Comparer et sceller', 'Comparer et sceller']);
    // DS022 · sceller un mois s'ouvre au geste : chaque formulaire vit dans son volet, son bouton plein ne se voit qu'ouvert.
    const folds = t.corps().all().filter((e) => e.tagName === 'details' && e.children[0]?.tagName === 'summary' && /^Sceller /.test(e.children[0].textContent));
    expect(folds.map((d) => d.children[0]!.textContent)).toEqual(['Sceller février 2027', 'Sceller janvier 2027']);
    for (const b of t.buttons()) expect(folds.some((d) => d.all().includes(b))).toBe(true);
  });

  it('[R212] sceller envoie le mois et le comptage, puis relit ; un seul envoi à la fois ; un comptage illisible ne part pas', async () => {
    let answer: (r: Response) => void = () => {};
    const t = await run({ 'POST /v1/pilotage/preuve/sceau': () => new Promise((r) => { answer = r; }) });
    await t.read();
    const [button] = t.buttons();
    const [input] = t.inputs();
    expect(input!.attributes.inputmode).toBe('numeric');
    input!.value = 'douze';
    button!.listeners.click!({});
    await settle();
    expect(t.seals()).toEqual([]);
    expect(t.texts()).toContain('un nombre entier');
    input!.value = '12';
    button!.listeners.click!({});
    button!.listeners.click!({});
    await settle();
    // Février d'abord à l'écran : le plus récent en premier.
    expect(t.seals()).toEqual([{ method: 'POST', url: '/v1/pilotage/preuve/sceau', body: { month: '2027-02', manualCount: 12 } }]);
    t.table['GET /v1/pilotage/preuve/sceaux'] = ok({ ...PUBLISHED, months: [{ ...PUBLISHED.months[0]! }, { month: '2027-02', counted: 9, sealSeq: 1, corrected: false, changedSinceSeal: false }] });
    answer(Response.json({ ok: true, data: { seq: 1 } }));
    await settle();
    expect(t.els['preuve-etat']!.textContent).toContain('février 2027 est scellé');
    expect(t.texts()).toContain('Scellé et publié');
    expect(t.buttons()).toHaveLength(1);
  });

  it.each([
    [no(409, { ok: false, rule: 'R212', code: 'count_mismatch', counted: 9, given: 12 }), 'le registre compte 9, vous comptez 12'],
    [no(409, { ok: false, rule: 'R212', code: 'not_inscribed', notInscribed: 2 }), '2 mandats signés restent à inscrire'],
    [no(409, { ok: false, rule: 'R212', code: 'register_broken' }), 'registre des mandats est abîmé'],
    [no(409, { ok: false, rule: 'R212', code: 'already_sealed' }), 'déjà scellé'],
    [no(409, { ok: false, rule: 'R212', code: 'conflict' }), 'Un autre sceau'],
    [no(403, { ok: false, rule: 'R16', code: 'role' }), 'pas dans vos droits'],
    [async () => { throw new TypeError('hors ligne'); }, 'Réponse perdue'],
  ] as [Answer, string][])('[R212] chaque refus est dit en français, le comptage reste à l’écran : %#', async (answer, words) => {
    const t = await run({ 'POST /v1/pilotage/preuve/sceau': answer });
    await t.read();
    const [button] = t.buttons();
    const [input] = t.inputs();
    input!.value = '12';
    button!.listeners.click!({});
    await settle();
    expect(t.texts()).toContain(words);
    expect(t.inputs()[0]!.value).toBe('12');
    expect((button as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it('[R211] condition remplie, mois changé depuis son sceau, intégrité abîmée, compte pas commencé : chacun se dit', async () => {
    const met = await run({
      'GET /v1/pilotage/preuve': ok({ ...COUNTER, condition: { met: true, metOn: '2027-06' } }),
      'GET /v1/pilotage/preuve/sceaux': ok({ ...PUBLISHED, chainSound: false, months: [{ month: '2027-01', counted: 12, sealSeq: 1, corrected: false, changedSinceSeal: true }, PUBLISHED.months[1]] }),
    });
    await met.read();
    // La chaîne des sceaux est abîmée : le compteur a beau dire remplie, l'écran ne le dit pas.
    expect(met.texts()).not.toContain('Condition remplie');
    expect(met.texts()).toContain('Série en cours');
    expect(met.texts()).toContain('contrôle d’intégrité a échoué');
    expect(met.texts()).toContain('Changé depuis son sceau');
    expect(met.buttons()).toHaveLength(2);
    const sound = await run({ 'GET /v1/pilotage/preuve': ok({ ...COUNTER, condition: { met: true, metOn: '2027-06' } }) });
    await sound.read();
    expect(sound.texts()).toContain('Condition remplie en juin 2027');
    const early = await run({ 'GET /v1/pilotage/preuve': ok({ ...COUNTER, months: [] }), 'GET /v1/pilotage/preuve/sceaux': ok({ ...PUBLISHED, months: [] }) });
    await early.read();
    expect(early.texts()).toContain('Le compte commence en janvier 2027');
  });

  it('[R16] droits refusés et réseau perdu : dits tels, sans chiffres, et le rapport du matin reste lisible', async () => {
    const refused = await run({ 'GET /v1/pilotage/preuve': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await refused.read();
    expect(refused.els['preuve-etat']!.textContent).toContain('pas dans vos droits');
    expect(refused.corps().children).toEqual([]);
    const offline = await run({ 'GET /v1/pilotage/preuve/sceaux': async () => { throw new TypeError('hors ligne'); } });
    await offline.read();
    expect(offline.els['preuve-etat']!.textContent).toContain('Pas de réseau');
    expect(offline.els['rapport-direction-etat']!.textContent).toContain('Aucun rapport rangé');
  });

  it('[R16] l’agent qui lit son rapport ne demande jamais la preuve', async () => {
    const t = await run({}, 'agent');
    await t.read('agent');
    expect(t.calls.filter((c) => c.url === '/v1/pilotage/rapport-matin')).toHaveLength(1);
    expect(t.calls.filter((c) => c.url.includes('/preuve'))).toEqual([]);
  });

  it('[R16] à la déconnexion, la preuve lue disparaît ; une lecture ou un sceau en vol ne s’affiche pas à la session suivante', async () => {
    const t = await run();
    await t.read();
    expect(t.corps().children).not.toEqual([]);
    const [button] = t.buttons();
    const [input] = t.inputs();
    input!.value = '12';
    let answer: (r: Response) => void = () => {};
    t.table['POST /v1/pilotage/preuve/sceau'] = () => new Promise((r) => { answer = r; });
    button!.listeners.click!({});
    await settle();
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.corps().children).toEqual([]);
    expect(t.els['preuve-etat']!.textContent).toBe('');
    answer(Response.json({ ok: true, data: { seq: 1 } }));
    await settle();
    expect(t.corps().children).toEqual([]);
    expect(t.els['preuve-etat']!.textContent).toBe('');
    expect(t.calls.filter((c) => c.method === 'GET' && c.url === '/v1/pilotage/preuve')).toHaveLength(1);
  });

  it('[R16] une lecture en vol ne s’affiche pas à la session suivante', async () => {
    let answer: (r: Response) => void = () => {};
    const t = await run({ 'GET /v1/pilotage/preuve': () => new Promise((r) => { answer = r; }) });
    await t.read();
    t.els.sortir!.listeners.click!({});
    await settle();
    answer(Response.json({ ok: true, data: COUNTER }));
    await settle();
    expect(t.corps().children).toEqual([]);
    expect(t.els['preuve-etat']!.textContent).toBe('');
  });

  it('[R201] les budgets tiennent', () => {
    expect(budgetProblems({ html: '', js: FINANCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });
});
