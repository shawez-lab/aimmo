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
const PILOTS = {
  currentMonth: '2028-01',
  minimum: 3,
  registerSound: true,
  condition: { met: false, reasons: ['moins_de_3_pilotes', 'pilote_en_cours', 'code_pilote_jamais_vu'] },
  pilots: [
    {
      agentId: 'agent-a',
      arrivedAt: '2027-09-15T09:00:00.000Z',
      arrivalMonth: '2027-09',
      measureStart: '2027-09-30T22:00:00.000Z',
      measureEndMonth: '2027-12',
      finishedOn: '2028-01-15',
      beforeMonths: ['2027-06', '2027-07', '2027-08'],
      before: [1, 0, 2],
      beforeTotal: 3,
      after: [{ month: '2027-10', counted: 2 }, { month: '2027-11', counted: 1 }, { month: '2027-12', counted: 3 }],
      afterTotal: 6,
      lines: [],
      arrivalMonthCounted: 1,
      withdrawnOrCancelled: 0,
      declarations: [
        { version: 1, months: [1, 0, 2], proofRef: 'preuves/a-1.pdf', declaredAt: '2027-09-20T09:00:00.000Z', inTime: true, counts: true },
        { version: 2, months: [5, 5, 5], proofRef: 'preuves/a-2.pdf', declaredAt: '2027-10-20T09:00:00.000Z', inTime: false, counts: false },
      ],
      status: 'plus',
    },
    {
      agentId: 'agent-b',
      arrivedAt: '2027-12-02T09:00:00.000Z',
      arrivalMonth: '2027-12',
      measureStart: '2027-12-31T23:00:00.000Z',
      measureEndMonth: '2028-03',
      finishedOn: '2028-04-15',
      beforeMonths: ['2027-09', '2027-10', '2027-11'],
      before: null,
      beforeTotal: null,
      after: [{ month: '2028-01', counted: 0 }],
      afterTotal: 0,
      lines: [],
      arrivalMonthCounted: 0,
      withdrawnOrCancelled: 1,
      declarations: [],
      status: 'statut_jamais_vu',
    },
  ],
};
const zero = { sent: 0, refused: 0, withoutControl: 0, whileExcluded: 0, siteGaps: 0, siteFailures: 0, outside: 0 };
const dayOf = (d: string, status: string, recountWorse = false) => ({ day: d, status, reading: null, live: zero, recountWorse });
const PHASE1 = {
  today: '2028-01-10',
  lastDay: '2028-01-09',
  required: 30,
  days: [dayOf('2028-01-05', 'propre'), dayOf('2028-01-06', 'hors_regles', true), dayOf('2028-01-07', 'sans_donnee'), dayOf('2028-01-08', 'propre'), dayOf('2028-01-09', 'propre')],
  inventories: [{ version: 1, tasks: { gohighlevel: 2, manychat: 1, site: 0, github_actions: 0, autre: 0 }, total: 3, proofRef: 'preuves/inv-1.png', declaredAt: '2028-01-02T09:00:00.000Z' }],
  countFrom: null,
  currentSeries: 2,
  countedSeries: 0,
  bestSeries: 2,
  condition: { met: false, reasons: ['taches_planifiees', 'serie_trop_courte'] },
};
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
    'GET /v1/phases/pilotes': ok(PILOTS),
    'GET /v1/phases/phase1': ok(PHASE1),
    'POST /v1/phases/pilotes': ok({ agentId: 'agent-c' }),
    'POST /v1/phases/pilotes/avant': ok({ agentId: 'agent-b', version: 1, inTime: true }),
    'POST /v1/phases/phase1/inventaire': ok({ version: 2, total: 0 }),
    'POST /v1/phases/phase1/envois-hors-aimmo': ok({ id: 'x', day: '2028-01-08' }),
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
    expect(x.split('Les régions')[0]).not.toContain('Moins de 3 agents pilotes.');
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

describe('BR14 · les agents pilotes et la phase 1 à l’écran', () => {
  it('[R642] [R643] chaque statut et chaque raison dits en mots, jamais un code ; une déclaration tardive se voit', async () => {
    const t = await run();
    await t.voir();
    const x = t.texts();
    expect(x).toContain('Agent agent-a');
    expect(x).toContain('Signe plus qu’avant son arrivée.');
    expect(x).toContain('Avant : juin 2027 1, juillet 2027 0, août 2027 2 ; total 3.');
    expect(x).toContain('Après : octobre 2027 2, novembre 2027 1, décembre 2027 3 ; total 6.');
    expect(x).toContain('1 déclaration(s) rangée(s) après le début de la mesure : gardée(s), jamais comptée(s).');
    expect(x).toContain('Avant : aucune déclaration rangée à temps.');
    expect(x).toContain('État que cet écran ne sait pas encore dire.');
    expect(x).toContain('Moins de 3 agents pilotes.');
    expect(x).toContain('Un agent pilote est encore en cours de mesure.');
    expect(x).toContain('Des tâches sont encore planifiées hors d’AIMMO.');
    expect(x).toContain('Moins de 30 jours de suite sans aucun envoi hors règles.');
    expect(x).toContain('0 jour(s) propre(s) de suite qui comptent, sur 30 ; 2 de suite en tout jusqu’au 09/01/2028, meilleure série 2.');
    expect(x).toContain('Aucun jour ne compte encore : l’inventaire n’est pas à zéro.');
    expect(x).toContain('07/01/2028 : sans donnée.');
    expect(x).toContain('06/01/2028 : hors règles, recompté pire qu’au relevé de la nuit.');
    expect(x).toContain('Inventaire version 1 du 02/01/2028 : 3 tâche(s) encore planifiée(s) hors d’AIMMO (GoHighLevel 2, ManyChat 1, Le site 0, GitHub Actions 0, Autre application 0).');
    for (const code of ['statut_jamais_vu', 'code_pilote_jamais_vu', 'hors_regles', 'sans_donnee', 'pas_plus', 'en_cours', 'taches_planifiees', 'gohighlevel', 'github_actions']) expect(x).not.toContain(code);
    expect(t.state()).toBe('');
  });

  it('[R640] désigner un pilote et ranger ses mois d’avant ; une saisie illisible ne part pas', async () => {
    const t = await run();
    await t.voir();
    await t.click(t.find('Désigner comme pilote'));
    expect(t.posts()).toHaveLength(0);
    expect(t.state()).toBe('Donnez l’identifiant de l’agent.');
    t.input('pilote-agent').value = 'agent c';
    await t.click(t.find('Désigner comme pilote'));
    expect(t.posts()).toHaveLength(0);
    t.input('pilote-agent').value = ' agent-c ';
    await t.click(t.find('Désigner comme pilote'));
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/phases/pilotes', body: { agentId: 'agent-c' } }]);
    expect(t.state()).toBe('Pilote désigné.');

    const u = await run();
    await u.voir();
    const save = () => u.body().all().filter((e) => e.tagName === 'button' && e.textContent === 'Ranger les mois d’avant')[1];
    u.input('pilote-1-mois-0').value = '2';
    u.input('pilote-1-mois-1').value = '1,5';
    u.input('pilote-1-mois-2').value = '0';
    u.input('pilote-1-preuve').value = 'preuves/b.pdf';
    await u.click(save());
    expect(u.state()).toBe('Chaque mois d’avant : un nombre entier de mandats, de 0 à 500.');
    u.input('pilote-1-mois-1').value = '501';
    await u.click(save());
    expect(u.posts()).toHaveLength(0);
    u.input('pilote-1-mois-1').value = '1';
    u.input('pilote-1-preuve').value = 'preuves/../b.pdf';
    await u.click(save());
    expect(u.posts()).toHaveLength(0);
    expect(u.state()).toBe('La référence de la preuve : de 3 à 200 lettres, chiffres ou / _ . : -, sans espace.');
    u.input('pilote-1-preuve').value = 'preuves/b.pdf';
    await u.click(save());
    expect(u.posts()).toEqual([{ method: 'POST', url: '/v1/phases/pilotes/avant', body: { agentId: 'agent-b', months: [2, 1, 0], proofRef: 'preuves/b.pdf' } }]);
    expect(u.state()).toBe('Mois d’avant rangés : une nouvelle version s’ajoute, rien n’est effacé.');
  });

  it('[R644] l’inventaire part avec chaque application, même à zéro ; un champ vide ne part pas', async () => {
    const t = await run();
    await t.voir();
    for (const a of ['gohighlevel', 'manychat', 'site', 'github_actions']) t.input(`inventaire-${a}`).value = '0';
    t.input('inventaire-preuve').value = 'preuves/inv-2.png';
    await t.click(t.find('Ranger l’inventaire'));
    expect(t.posts()).toHaveLength(0);
    expect(t.state()).toBe('Chaque application : un nombre entier de tâches, de 0 à 1000, même à zéro.');
    t.input('inventaire-autre').value = '0';
    await t.click(t.find('Ranger l’inventaire'));
    expect(t.posts()).toEqual([
      { method: 'POST', url: '/v1/phases/phase1/inventaire', body: { tasks: { gohighlevel: 0, manychat: 0, site: 0, github_actions: 0, autre: 0 }, proofRef: 'preuves/inv-2.png' } },
    ]);
    expect(t.state()).toBe('Inventaire rangé : une nouvelle version s’ajoute.');
  });

  it('[R644] un envoi constaté hors d’AIMMO se range en deux appuis, jamais avec une saisie illisible', async () => {
    const t = await run();
    await t.voir();
    t.input('hors-jour').value = '2028-01-08';
    t.input('hors-application').value = 'Choisir…';
    t.input('hors-preuve').value = 'preuves/capture.png';
    await t.click(t.find('Ranger cet envoi'));
    expect(t.state()).toBe('Choisissez l’application où l’envoi a été constaté.');
    t.input('hors-application').value = 'manychat';
    t.input('hors-jour').value = '';
    await t.click(t.find('Ranger cet envoi'));
    expect(t.state()).toBe('Le jour : une date depuis le 1er janvier 2026, jamais dans le futur.');
    t.input('hors-jour').value = '2028-01-08';
    await t.click(t.find('Ranger cet envoi'));
    expect(t.posts()).toHaveLength(0);
    await t.click(t.find('Confirmer : cet envoi ne sera jamais retiré'));
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/phases/phase1/envois-hors-aimmo', body: { day: '2028-01-08', application: 'manychat', proofRef: 'preuves/capture.png' } }]);
    expect(t.state()).toBe('Envoi hors règles rangé : son jour compte comme hors règles.');
  });

  it('un refus du serveur dit sa raison en mots ; une réponse perdue est dite incertaine ; une lecture refusée est dite', async () => {
    const t = await run({ 'POST /v1/phases/pilotes': no(409, { ok: false, rule: 'R640', code: 'trop_tard' }) });
    await t.voir();
    t.input('pilote-agent').value = 'agent-c';
    await t.click(t.find('Désigner comme pilote'));
    expect(t.state()).toBe('Sa mesure a déjà commencé : un pilote se désigne avant le 1er du mois qui suit son arrivée.');
    const u = await run({ 'POST /v1/phases/pilotes': no(404, { ok: false, rule: 'R640', code: 'agent_inconnu' }) });
    await u.voir();
    u.input('pilote-agent').value = 'agent-z';
    await u.click(u.find('Désigner comme pilote'));
    expect(u.state()).toBe('Cet agent ne se trouve pas dans le réseau.');
    const v = await run({ 'POST /v1/phases/phase1/inventaire': no(503, { ok: false }) });
    await v.voir();
    for (const a of ['gohighlevel', 'manychat', 'site', 'github_actions', 'autre']) v.input(`inventaire-${a}`).value = '0';
    v.input('inventaire-preuve').value = 'preuves/inv-2.png';
    await v.click(v.find('Ranger l’inventaire'));
    expect(v.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    const w = await run({ 'POST /v1/phases/pilotes': () => Promise.reject(new TypeError('coupé')) });
    await w.voir();
    w.input('pilote-agent').value = 'agent-c';
    await w.click(w.find('Désigner comme pilote'));
    expect(w.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    const y = await run({ 'GET /v1/phases/pilotes': no(403, { ok: false, rule: 'R16', code: 'role' }), 'GET /v1/phases/phase1': async () => Response.json({ ok: true, data: { days: 'x' } }) });
    await y.voir();
    expect(y.state()).toBe('Ce n’est pas dans vos droits. Phase 1 indisponible pour le moment.');
    expect(y.texts()).toContain('Les cinq phases');
  });

  it('chaque code de refus des pilotes et de la phase 1 a son libellé ; budget tenu, aucun innerHTML [R201]', () => {
    const sources = ['phase1.ts', 'pilotes.ts'].map((f) => readFileSync(new URL(`../../core/src/conditions-phases/${f}`, import.meta.url), 'utf8')).join('\n');
    const codes = new Set([...sources.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]!));
    // Les refus d'un geste du système (relevé de la nuit) ne viennent jamais à l'écran.
    for (const c of ['jour_pas_fini']) codes.delete(c);
    expect(codes.size).toBeGreaterThanOrEqual(12);
    for (const c of codes) expect(PHASES_SCRIPT, c).toContain(`"${c}":`);
    for (const s of ['en_cours', 'parti', 'avant_non_declare', 'plus', 'pas_plus']) expect(PHASES_SCRIPT).toContain(`"${s}":`);
    expect(budgetProblems({ html: '', js: PHASES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(PHASES_SCRIPT).not.toContain('innerHTML');
  });
});
