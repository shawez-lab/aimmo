import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { VIAGER_NOTICE, computeViager, type ViagerInputs } from '../../core/src/neuf-viager/index.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
import {
  VIAGER_EXPERT_DONE,
  VIAGER_LOST,
  VIAGER_MISSING,
  VIAGER_NONE,
  VIAGER_NO_TABLE,
  VIAGER_REFUSALS,
  VIAGER_SAME,
  VIAGER_SCRIPT,
  VIAGER_STORED_GAP,
  VIAGER_STORED_LOST,
  VIAGER_STORED_NONE,
  VIAGER_STORED_REPLACED,
  VIAGER_STORED_SAME,
  VIAGER_TABLE_CHANGED,
} from '../app/viager.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : projets, prénoms, biens, valeurs, âges, table, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const PROJECTS = {
  page: 0,
  more: false,
  projects: [
    { projectId: 'pj1', kind: 'sell', stage: 'new', firstName: 'Camille', properties: [{ propertyId: 'b1', reference: 'V-101', postcode: '21000', city: 'Dijon' }], referrals: [] },
    { projectId: 'pj2', kind: 'buy', stage: 'new', firstName: 'Acheteur', properties: [{ propertyId: 'b9', reference: 'A-900', postcode: '21000', city: 'Dijon' }], referrals: [] },
    { projectId: 'pj3', kind: 'sell', stage: 'new', firstName: INJECTED, properties: [{ propertyId: 'b2', reference: 'V-102', postcode: null, city: null }], referrals: [] },
    { projectId: 'pj4', kind: 'sell', stage: 'new', firstName: 'Sans bien', properties: [], referrals: [] },
    { projectId: '../x', kind: 'sell', stage: 'new', firstName: 'Mal formé', properties: [{ propertyId: 'b3', reference: 'X', postcode: '21000', city: 'X' }], referrals: [] },
  ],
};
const TYPED = (exp: number[] | null): ViagerInputs => ({
  marketValue: { value: 30_000_000, source: 'saisi:agent:alex', asOf: '2027-03-10', hypothesis: 'avis de valeur du 1er mars' },
  occupied: { value: true, source: 'saisi:agent:alex', asOf: '2027-03-10', hypothesis: 'viager occupé, choisi à l’écran' },
  headAges: { value: [75], source: 'saisi:agent:alex', asOf: '2027-03-10', hypothesis: 'âge révolu de chaque tête, saisi à l’écran' },
  bouquet: { value: 5_000_000, source: 'saisi:agent:alex', asOf: '2027-03-10', hypothesis: 'demande du vendeur' },
  annualRateBp: { value: 450, source: 'saisi:agent:alex', asOf: '2027-03-10', hypothesis: 'taux d’usage de l’expert' },
  expectancies: exp ? { value: exp, source: 'table:t-1 · Table inventée · millésime 2026', asOf: '2027-03-01', hypothesis: 'espérance de vie à l’âge de chaque tête, ensemble des deux sexes' } : null,
});
const FULL = computeViager(TYPED([128]), '2027-03-10T09:00:00Z');
const EMPTY = computeViager(TYPED(null), '2027-03-10T09:00:00Z');
const CALC = { id: 'c1', propertyId: 'b1', projectId: 'pj1', inputs: TYPED([128]), result: FULL, createdBy: 'agent:alex', createdAt: '2027-03-10T09:00:00Z' };

const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/gagner/rendez-vous': ok([]),
  'GET /v1/gagner/recommandations/a-appeler': ok([]),
  'GET /v1/gagner/relances': ok([]),
  'GET /v1/gagner/lettres': ok({ campaigns: [], properties: [] }),
  'GET /v1/partenaires/projets': ok(PROJECTS),
  'POST /v1/viager/calculs': ok(CALC),
  'GET /v1/viager/calculs/c1/rejeu': ok({ same: true, result: FULL }),
  'POST /v1/viager/calculs/c1/expert': ok({ referralId: 'r1' }),
  'GET /v1/viager/biens/b1/calculs': ok([]),
  'GET /v1/viager/biens/b2/calculs': ok([]),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: Record<string, unknown> | undefined; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['gagner-corps']!;
  const buttons = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = (src: string) => [...els.gagner!.all(), ...els['gagner-corps']!.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  els['gagner-ouvrir']!.listeners.click!({});
  await settle();
  runInNewContext(GAGNER_SCRIPT, context);
  scripts('/app/gagner.js')[0]!.listeners.load!({});
  await settle();
  const part = () => body().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Viager')!;
  const beforeOpen = scripts('/app/viager.js').length;
  const callsBefore = calls.length;
  const open = async () => {
    await click(buttons(part(), 'Calculer un viager')[0]);
    runInNewContext(VIAGER_SCRIPT, context);
    const s = scripts('/app/viager.js');
    s[s.length - 1]!.listeners.load!({});
    await settle();
  };
  const input = (id: string) => part().all().find((e) => e.attributes.id === id);
  const set = (id: string, value: string) => {
    input(id)!.value = value;
  };
  const bien = async (label = 'Viager du bien V-101, Dijon') => {
    await open();
    await click(buttons(part(), label)[0]);
  };
  const fill = () => {
    set('viager-valeur', '300 000');
    set('viager-valeur-source', 'avis de valeur du 1er mars');
    set('viager-forme', 'occupe');
    set('viager-age-1', '75');
    set('viager-bouquet', '50 000');
    set('viager-bouquet-source', 'demande du vendeur');
    set('viager-taux', '4,5');
    set('viager-taux-source', 'taux d’usage de l’expert');
  };
  const compute = async () => {
    await bien();
    fill();
    await click(buttons(part(), 'Calculer')[0]);
  };
  const status = () =>
    part()
      .all()
      .filter((e) => e.attributes.role === 'status')
      .map((e) => e.textContent)
      .join(' | ');
  const mine = () => calls.slice(callsBefore).filter((c) => c.url.startsWith('/v1/viager') || c.url.startsWith('/v1/partenaires'));
  return { calls, part, buttons, click, open, bien, input, set, fill, compute, status, beforeOpen, mine };
}

describe('BR81 · le calcul de viager à l’écran de l’agent', () => {
  it('[R201] un seul script servi à part, chargé au seul geste depuis « Gagner des mandats » ; budgets tenus, sans innerHTML', async () => {
    const t = await run();
    expect(t.beforeOpen).toBe(0);
    expect(t.mine()).toEqual([]);
    await t.open();
    expect(t.mine().map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/partenaires/projets']);
    for (const c of t.mine()) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    expect(AGENT_APP_FILES['/app/viager.js']).toBe(VIAGER_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/viager.js');
    expect(JS).not.toContain('/app/viager.js');
    expect(JS).not.toContain('/v1/viager');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/viager.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(budgetProblems({ html: '', js: VIAGER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: GAGNER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(VIAGER_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    const routes = [...VIAGER_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect([...new Set(routes)].sort()).toEqual(['/v1/partenaires/projets', '/v1/viager/biens/', '/v1/viager/calculs', '/v1/viager/calculs/']);
  });

  it('[R16] seuls les projets de vente avec un bien rendu sont offerts ; texte reçu posé en texte, entrée mal formée tue ; aucun : dit en mots', async () => {
    const t = await run();
    await t.open();
    const offered = t.part().all().filter((e) => e.tagName === 'button' && e.textContent.startsWith('Viager du bien'));
    expect(offered.map((b) => b.textContent)).toEqual(['Viager du bien V-101, Dijon', 'Viager du bien V-102']);
    expect(t.part().textContent).toContain('Vendre · Camille');
    expect(t.part().textContent).toContain(INJECTED);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
    for (const hidden of ['A-900', 'Sans bien', 'Mal formé']) expect(t.part().textContent).not.toContain(hidden);
    expect(t.part().textContent).toContain(VIAGER_NOTICE);
    const none = await run({ 'GET /v1/partenaires/projets': ok({ page: 0, more: false, projects: [PROJECTS.projects[1]] }) });
    await none.open();
    expect(none.status()).toContain(VIAGER_NONE);
  });

  it('[R540, R542] chaque chiffre dit avec sa source, sa date et son hypothèse ; la mention « ni offre ni conseil » toujours à l’écran', async () => {
    const t = await run();
    await t.bien();
    expect(t.part().textContent).toContain(VIAGER_NOTICE);
    expect(t.input('viager-esperance')).toBeUndefined();
    await t.compute();
    const sent = t.mine().find((c) => c.method === 'POST' && c.url === '/v1/viager/calculs')!;
    expect(sent.body).toEqual({
      propertyId: 'b1',
      projectId: 'pj1',
      inputs: {
        marketValue: { value: 30_000_000, hypothesis: 'avis de valeur du 1er mars' },
        occupied: { value: true, hypothesis: 'viager occupé, choisi à l’écran' },
        headAges: { value: [75], hypothesis: 'âge révolu de chaque tête, saisi à l’écran' },
        bouquet: { value: 5_000_000, hypothesis: 'demande du vendeur' },
        annualRateBp: { value: 450, hypothesis: 'taux d’usage de l’expert' },
      },
    });
    expect(FULL.status).toBe('complet');
    if (FULL.status !== 'complet') return;
    const text = t.part().textContent;
    const items = t.part().all().filter((e) => e.tagName === 'ol' && e.className === 'liste')[0]!.children;
    expect(items).toHaveLength(FULL.lines.length);
    for (const [i, l] of FULL.lines.entries()) {
      expect(items[i]!.textContent).toContain(l.hypothesis);
      expect(items[i]!.textContent).toContain('le 10/03/2027'.replace('10/03/2027', `${l.asOf.slice(8)}/${l.asOf.slice(5, 7)}/${l.asOf.slice(0, 4)}`));
      expect(items[i]!.textContent).toMatch(/source : (saisi à l’écran|calcul AIMMO, formule 1|table de la direction : Table inventée · millésime 2026)/);
    }
    expect(text).toContain('Bouquet : 50 000 €');
    expect(text).toContain('Taux technique annuel : 4,5 %');
    expect(text).toContain('Espérance de vie, première tête : 12,8 ans');
    expect(text).toContain('Forme du viager : occupé');
    expect(text).toContain(`Durée retenue : ${FULL.months} mois`);
    expect(text).not.toContain('agent:alex');
    expect(text).not.toContain('t-1');
    expect(text.split(VIAGER_NOTICE).length).toBeGreaterThan(2);
  });

  it('[R541] sans table d’espérance, aucun chiffre et la raison dite', async () => {
    const t = await run({ 'POST /v1/viager/calculs': ok({ ...CALC, inputs: TYPED(null), result: EMPTY }) });
    await t.compute();
    expect(EMPTY.status).toBe('incomplet');
    expect(t.status()).toContain(VIAGER_NO_TABLE);
    expect(t.part().all().some((e) => e.tagName === 'ol')).toBe(false);
    expect(t.buttons(t.part(), 'Rejouer le calcul')).toHaveLength(0);
    expect(t.part().textContent).toContain(VIAGER_NOTICE);
  });

  it('[R542] un bouquet plus grand que la valeur occupée refusé en mots ; champ manquant refusé avant l’appel ; jamais un code', async () => {
    const t = await run({ 'POST /v1/viager/calculs': no(409, { ok: false, rule: 'R542', code: 'bouquet_trop_haut', field: 'bouquet' }) });
    await t.compute();
    expect(t.status()).toContain(VIAGER_REFUSALS.bouquet_trop_haut);
    expect(t.status()).not.toContain('bouquet_trop_haut');
    const m = await run();
    await m.bien();
    m.fill();
    m.set('viager-taux-source', '');
    await m.click(m.buttons(m.part(), 'Calculer')[0]);
    expect(m.status()).toContain(VIAGER_MISSING);
    m.fill();
    m.set('viager-age-2', 'soixante');
    await m.click(m.buttons(m.part(), 'Calculer')[0]);
    expect(m.status()).toContain(VIAGER_MISSING);
    expect(m.mine().filter((c) => c.method === 'POST')).toEqual([]);
    m.set('viager-age-2', '72');
    await m.click(m.buttons(m.part(), 'Calculer')[0]);
    expect((m.mine().find((c) => c.method === 'POST')!.body!.inputs as { headAges: { value: number[] } }).headAges.value).toEqual([75, 72]);
    const odd = await run({ 'POST /v1/viager/calculs': no(409, { ok: false, rule: 'R540', code: 'code_inconnu' }) });
    await odd.compute();
    expect(odd.status()).toContain('Le calcul n’a pas été fait.');
    expect(odd.status()).not.toContain('code_inconnu');
    const lost = await run({ 'POST /v1/viager/calculs': cut });
    await lost.compute();
    expect(lost.status()).toContain(VIAGER_LOST);
  });

  it('[R540] le rejeu dit « identique », ou chaque écart', async () => {
    const t = await run();
    await t.compute();
    await t.click(t.buttons(t.part(), 'Rejouer le calcul')[0]);
    expect(t.status()).toContain(VIAGER_SAME);
    if (FULL.status !== 'complet') return;
    const moved = { ...FULL, lines: FULL.lines.map((l) => (l.key === 'monthlyRent' ? { ...l, value: l.value + 100 } : l)) };
    const d = await run({ 'GET /v1/viager/calculs/c1/rejeu': ok({ same: false, result: moved }) });
    await d.compute();
    await d.click(d.buttons(d.part(), 'Rejouer le calcul')[0]);
    const rent = FULL.lines.find((l) => l.key === 'monthlyRent')!.value;
    const euros = (c: number) => `${String(Math.trunc(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${c % 100 ? ',' + String(c % 100).padStart(2, '0').replace(/0$/, '') : ''} €`;
    expect(d.part().textContent).toContain(`Rente mensuelle : ${euros(rent)} au calcul, ${euros(rent + 100)} au rejeu`);
    expect(d.status()).not.toContain(VIAGER_SAME);
    const tb = await run({ 'GET /v1/viager/calculs/c1/rejeu': ok({ same: false, result: FULL }) });
    await tb.compute();
    await tb.click(tb.buttons(tb.part(), 'Rejouer le calcul')[0]);
    expect(tb.status()).toContain(VIAGER_TABLE_CHANGED);
  });

  it('le dernier calcul d’un bien reste lisible et rejouable au retour, sans rien garder sur l’appareil', async () => {
    const t = await run();
    await t.compute();
    await t.click(t.buttons(t.part(), 'Retour aux projets')[0]);
    expect(t.part().all().some((e) => e.tagName === 'ol')).toBe(false);
    await t.click(t.buttons(t.part(), 'Viager du bien V-101, Dijon')[0]);
    expect(t.status()).toContain('Dernier calcul de ce bien, rangé le 10/03/2027.');
    await t.click(t.buttons(t.part(), 'Rejouer le calcul')[0]);
    expect(t.status()).toContain(VIAGER_SAME);
    expect(t.mine().filter((c) => c.method === 'POST' && c.url === '/v1/viager/calculs')).toHaveLength(1);
    await t.click(t.buttons(t.part(), 'Retour aux projets')[0]);
    await t.click(t.buttons(t.part(), 'Viager du bien V-102')[0]);
    expect(t.status()).not.toContain('Dernier calcul');
  });

  it('[R542] l’expert est proposé par la mise en relation, jamais écrit à sa place', async () => {
    const t = await run();
    await t.compute();
    expect(t.input('viager-cp')).toBeUndefined();
    await t.click(t.buttons(t.part(), 'Proposer l’expert au vendeur')[0]);
    const posted = t.mine().filter((c) => c.method === 'POST');
    expect(posted.map((c) => c.url)).toEqual(['/v1/viager/calculs', '/v1/viager/calculs/c1/expert']);
    expect(posted[1]!.body).toEqual({});
    expect(t.status()).toContain(VIAGER_EXPERT_DONE);
    expect(VIAGER_SCRIPT).not.toMatch(/mailto:|sms:|wa\.me|\/v1\/messages|\/v1\/partenaires\/relations/);
    // Un bien sans code postal : le code postal est demandé, cinq chiffres, avant le tirage.
    const n = await run({ 'POST /v1/viager/calculs': ok({ ...CALC, propertyId: 'b2', projectId: 'pj3' }), 'GET /v1/viager/calculs/c1/rejeu': ok({ same: true, result: FULL }) });
    await n.bien('Viager du bien V-102');
    n.fill();
    await n.click(n.buttons(n.part(), 'Calculer')[0]);
    n.set('viager-cp', '210');
    await n.click(n.buttons(n.part(), 'Proposer l’expert au vendeur')[0]);
    expect(n.status()).toContain(VIAGER_REFUSALS.bad_postcode);
    expect(n.mine().filter((c) => c.url.endsWith('/expert'))).toEqual([]);
    n.set('viager-cp', '21000');
    await n.click(n.buttons(n.part(), 'Proposer l’expert au vendeur')[0]);
    expect(n.mine().find((c) => c.url.endsWith('/expert'))!.body).toEqual({ postcode: '21000' });
    const none = await run({ 'POST /v1/viager/calculs/c1/expert': no(409, { ok: false, rule: 'R542', code: 'no_partner' }) });
    await none.compute();
    await none.click(none.buttons(none.part(), 'Proposer l’expert au vendeur')[0]);
    expect(none.status()).toContain(VIAGER_REFUSALS.no_partner);
  });
});

// BR84 : un calcul plus ancien, rangé une autre fois, et un incomplet ; chacun avec ce que dit son rejeu.
const OLD = { ...CALC, id: 'c0', createdAt: '2027-02-01T09:00:00Z' };
const BARE = { ...CALC, id: 'c2', inputs: TYPED(null), result: EMPTY, createdAt: '2027-01-15T09:00:00Z' };
const STORED = [
  { calculation: CALC, replay: 'identique', tableReplaced: false },
  { calculation: OLD, replay: 'ecart', tableReplaced: true },
  { calculation: BARE, replay: 'identique', tableReplaced: false },
  // Mal formés : jamais dits.
  { calculation: { ...CALC, id: '../x' }, replay: 'identique', tableReplaced: false },
  { calculation: { ...CALC, id: 'c9', propertyId: 'b2' }, replay: 'identique', tableReplaced: false },
  { calculation: { ...CALC, id: 'c8' }, replay: 'peut-etre', tableReplaced: false },
  { calculation: { ...CALC, id: 'c7', createdAt: 'hier' }, replay: 'identique', tableReplaced: false },
];

describe('BR84 · les calculs de viager d’un bien relus à l’écran de l’agent', () => {
  it('[R540] [R541] à l’ouverture du bien, ses calculs rangés, du plus récent au plus ancien, chacun dit en mots s’il tient encore', async () => {
    const t = await run({ 'GET /v1/viager/biens/b1/calculs': ok(STORED) });
    await t.bien();
    expect(t.mine().map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/partenaires/projets', 'GET /v1/viager/biens/b1/calculs']);
    const sec = t.part().all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Calculs déjà rangés pour ce bien')!;
    const items = sec.all().filter((e) => e.tagName === 'ul')[0]!.children;
    expect(items.map((li) => li.children[0]!.textContent)).toEqual(['Calcul du 10/03/2027', 'Calcul du 01/02/2027', 'Calcul du 15/01/2027']);
    expect(items[0]!.textContent).toContain('Bouquet 50 000 €, puis');
    expect(items[0]!.textContent).toContain(VIAGER_STORED_SAME);
    expect(items[0]!.textContent).not.toContain(VIAGER_STORED_REPLACED);
    expect(items[1]!.textContent).toContain(VIAGER_STORED_GAP);
    expect(items[1]!.textContent).toContain(VIAGER_STORED_REPLACED);
    expect(items[2]!.textContent).toContain('Incomplet : aucun chiffre.');
    // Chaque état est dit en mots, sur une ligne à lui, jamais par une couleur seule.
    for (const text of [VIAGER_STORED_SAME, VIAGER_STORED_GAP, VIAGER_STORED_REPLACED]) expect(sec.all().some((e) => e.tagName === 'p' && e.textContent === text)).toBe(true);
    expect(sec.textContent).not.toContain('agent:alex');
    expect(sec.textContent).not.toContain('t-1');
    // Le formulaire reste là, sous la liste : rien n'est calculé à l'ouverture.
    expect(t.input('viager-valeur')).toBeDefined();
    expect(t.mine().filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('[R540] un calcul de la liste se rouvre pour être relu, rejoué et proposé à l’expert ; un seul résultat à l’écran', async () => {
    const t = await run({ 'GET /v1/viager/biens/b1/calculs': ok(STORED), 'GET /v1/viager/calculs/c0/rejeu': ok({ same: false, result: FULL }) });
    await t.bien();
    await t.click(t.buttons(t.part(), 'Relire le calcul du 01/02/2027')[0]);
    expect(t.part().all().filter((e) => e.tagName === 'h4' && e.textContent === 'Résultat du calcul')).toHaveLength(1);
    expect(t.part().textContent).toContain('Bouquet : 50 000 €');
    await t.click(t.buttons(t.part(), 'Rejouer le calcul')[0]);
    expect(t.mine().some((c) => c.url === '/v1/viager/calculs/c0/rejeu')).toBe(true);
    expect(t.status()).toContain(VIAGER_TABLE_CHANGED);
    // Un nouveau calcul prend la place : toujours un seul résultat, et la liste est relue.
    t.fill();
    await t.click(t.buttons(t.part(), 'Calculer')[0]);
    expect(t.part().all().filter((e) => e.tagName === 'h4' && e.textContent === 'Résultat du calcul')).toHaveLength(1);
    expect(t.mine().filter((c) => c.url === '/v1/viager/biens/b1/calculs')).toHaveLength(2);
    expect(t.part().all().filter((e) => e.attributes.id === 'viager-cp')).toHaveLength(0);
    // L'incomplet se relit sans chiffre, et sa raison dite [R541].
    await t.click(t.buttons(t.part(), 'Relire le calcul du 15/01/2027')[0]);
    expect(t.status()).toContain(VIAGER_NO_TABLE);
    expect(t.buttons(t.part(), 'Rejouer le calcul')).toHaveLength(0);
  });

  it('[R16] aucun calcul, réponse perdue ou refus dits en mots ; la réponse d’un bien quitté est jetée', async () => {
    const none = await run();
    await none.bien();
    expect(none.status()).toContain(VIAGER_STORED_NONE);
    const lost = await run({ 'GET /v1/viager/biens/b1/calculs': cut });
    await lost.bien();
    expect(lost.status()).toContain(VIAGER_STORED_LOST);
    expect(lost.input('viager-valeur')).toBeDefined();
    const down = await run({ 'GET /v1/viager/biens/b1/calculs': no(503, { ok: false, code: 'unavailable' }) });
    await down.bien();
    expect(down.status()).toContain(VIAGER_STORED_LOST);
    const refused = await run({ 'GET /v1/viager/biens/b1/calculs': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await refused.bien();
    expect(refused.status()).toContain(VIAGER_REFUSALS.not_assigned);
    expect(refused.status()).not.toContain('not_assigned');

    // La liste du premier bien arrive après l'ouverture du second : jetée.
    let release: (r: Response) => void = () => {};
    const late = await run({ 'GET /v1/viager/biens/b1/calculs': () => new Promise<Response>((r) => (release = r)) });
    await late.bien();
    await late.click(late.buttons(late.part(), 'Retour aux projets')[0]);
    await late.click(late.buttons(late.part(), 'Viager du bien V-102')[0]);
    release(Response.json({ ok: true, mode: 'essai', data: STORED }));
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(late.part().textContent).not.toContain('Calcul du 10/03/2027');
    expect(late.status()).toContain(VIAGER_STORED_NONE);
  });
});

