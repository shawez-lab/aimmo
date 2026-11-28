import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems, gzipSize } from '../../core/src/design/audit.ts';
import { DICTEE_DELIVERY, DICTEE_REFUSALS, DICTEE_SCRIPT, DICTEE_VISIT_LABEL } from '../app/dictee.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// BR103 · Tout est inventé : clé, visite, bien, visiteur, dictée.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const READ_AT = '2027-03-03T14:05:00.000Z';
const DICTATION = 'Elle a aimé le séjour lumineux, la cuisine est à refaire. Elle veut revenir mardi à 18 h pour une contre-visite.';
type Call = { method: string; url: string; body: any };
type Answer = (body: any) => Promise<Response>;

const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', sent: false, data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const RDV = {
  day: '2027-03-03',
  appointments: [{ id: 'v1', kind: 'visite', start: '2027-03-03T13:00:00.000Z', end: '2027-03-03T14:00:00.000Z', status: 'booked', firstName: 'Inès', brief: null, briefMissing: 'not_ready' }],
};
const VISIT = {
  appointmentId: 'v1',
  start: '2027-03-03T13:00:00.000Z',
  end: '2027-03-03T14:00:00.000Z',
  status: 'honored',
  property: { id: 'b1', reference: 'REF-T-1', city: 'Dijon' },
  projectId: 'pr1',
  visitor: { firstName: 'Inès' },
  slip: { status: 'complet', mode: 'essai', signed: true },
  safety: 'confirmee',
  report: null,
};
const REPORT = { opinion: 'Le visiteur a aimé le séjour lumineux.', strengths: ['séjour lumineux'], reservations: ['cuisine à refaire'], interest: 'fort', readyToOffer: false };
const DRAFT = {
  sentences: ['Elle a aimé le séjour lumineux, la cuisine est à refaire.', 'Elle veut revenir mardi à 18 h pour une contre-visite.'],
  fields: [
    { target: 'rendezvous', key: 'appointmentKind', value: 'visite', sentence: 1, quote: 'contre-visite' },
    { target: 'rendezvous', key: 'start', value: '2027-03-09T17:00:00.000Z', sentence: 1, quote: 'mardi à 18 h' },
  ],
  conflicts: [],
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok(RDV),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/visites/v1': ok(VISIT),
  'POST /v1/dictee/lecture': ok({ draft: DRAFT, readAt: READ_AT, report: REPORT }),
  'POST /v1/dictee/validation': ok({ personId: 'p1', contact: null, propertyId: null, appointmentId: 'v2', report: { delivery: 'sent', rule: null } }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function visit(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: Call[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  let uuids = 0;
  const ctx: Record<string, unknown> = {
    document,
    Intl,
    Date,
    crypto: { randomUUID: () => `7d1c2b3a-2222-4a2b-8c3d-${String(++uuids).padStart(12, '0')}` },
    setTimeout: (f: () => void, ms: number) => (ms === 0 ? setTimeout(f, 0) : 0),
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const a = table[`${method} ${url}`];
      return a ? a(body) : Promise.reject(new TypeError('hors ligne'));
    },
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
  const buttonIn = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
  await click(buttonIn(els.rdv!, 'Ouvrir la visite'));
  const corps = () => els['visite-corps']!;
  const part = () => corps().all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === DICTEE_VISIT_LABEL)!;
  const scripts = () => [els.fiche!, ...els.fiche!.all()].filter((e) => e.tagName === 'script' && e.attributes.src === '/app/dictee.js');
  const open = async () => {
    await click(part().children[0]);
    runInNewContext(DICTEE_SCRIPT, ctx);
    scripts()[0]!.listeners.load!({});
    await settle();
  };
  const btn = (text: string) => buttonIn(part(), text);
  const dictate = async (text = DICTATION) => {
    part().all().find((e) => e.tagName === 'textarea')!.value = text;
    await click(btn('Lire la dictée'));
  };
  const boxes = () => part().all().filter((e) => e.tagName === 'input' && e.attributes.type === 'checkbox');
  const reportBox = () => boxes().find((e) => String(e.attributes.id).endsWith('-compte-rendu'));
  const posts = () => calls.filter((c) => c.method === 'POST');
  const answer = () => part().all().filter((e) => e.attributes.role === 'status').map((e) => e.textContent).filter(Boolean).at(-1) ?? '';
  return { els, ctx, calls, table, corps, part, scripts, open, btn, click, dictate, boxes, reportBox, posts, answer };
}

describe('BR103 · la dictée en sortant d’une visite, depuis l’écran de la visite', () => {
  it('[R201] le bouton est sur l’écran de la visite ; rien n’est chargé ni lu avant le geste ; budgets tenus', async () => {
    const t = await visit();
    expect(t.part()).toBeDefined();
    expect(t.scripts()).toEqual([]);
    expect(t.calls.some((c) => c.url.startsWith('/v1/dictee/'))).toBe(false);
    expect(JS).toContain(`lazyBlock('${DICTEE_VISIT_LABEL}', '/app/dictee.js', 'AIMMO_DICTEE', v.appointmentId)`);
    expect(DICTEE_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(budgetProblems({ html: '', js: DICTEE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    // La place faite par BR102 reste en grande partie libre pour la suite ; la visite sans réseau (AU018) en a pris environ 200 octets, pour son chargeur,
    // le focus qui suit l'écran (DS064) environ 110, pour l'accessibilité de chaque écran, et l'onglet « Clients » (DS003) environ 80, avec le
    // chargeur qui laisse gagner le dernier geste. La fiche du client, servie à part (DS010), en a rendu plus de 3 000 : la réserve remonte.
    expect(gzipSize(HTML) + gzipSize(AGENT_APP_FILES['/app/app.css']!) + gzipSize(JS)).toBeLessThan(BUDGETS.application.gzipBytes - 3000);
    await t.open();
    expect(t.scripts()).toHaveLength(1);
    expect(t.part().textContent).toContain('ce que le visiteur a pensé du bien');
    expect(t.calls.some((c) => c.url.startsWith('/v1/dictee/'))).toBe(false);
  });

  it.each([
    ['compte rendu déjà validé', { report: { status: 'valide', source: 'ai', report: REPORT, delivery: 'sent' } }],
    ['visite annulée', { status: 'cancelled' }],
  ])('[R261] %s : pas de dictée à l’écran de la visite', async (_n, over) => {
    const t = await visit({ 'GET /v1/visites/v1': ok({ ...VISIT, ...over }) });
    expect(t.part()).toBeUndefined();
  });

  it('[R260] [R261] Jamais vu : une dictée, le compte rendu et la contre-visite proposés avec leurs phrases, validés d’un geste', async () => {
    const t = await visit();
    await t.open();
    await t.dictate();
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/dictee/lecture', body: { dictation: DICTATION, appointmentId: 'v1' } }]);
    const text = t.part().textContent;
    // Le compte rendu rédigé d'après la dictée, montré sans être rangé, coché pour partir au vendeur.
    expect(text).toContain('Le compte rendu au vendeur');
    expect(text).toContain('Le visiteur a aimé le séjour lumineux.');
    expect(text).toContain('Points forts : séjour lumineux');
    expect(text).toContain('Réserves : cuisine à refaire');
    expect(text).toContain('intérêt fort');
    expect(t.reportBox()!.checked).toBe(true);
    // La suite dictée, chaque champ avec sa phrase.
    expect(text).toContain('Dit : « mardi à 18 h », dans « Elle veut revenir mardi à 18 h pour une contre-visite. »');
    expect(t.posts()).toHaveLength(1);
    await t.click(t.btn('Valider ce qui est coché'));
    expect(t.posts()[1]).toEqual({
      method: 'POST',
      url: '/v1/dictee/validation',
      body: { requestId: '7d1c2b3a-2222-4a2b-8c3d-000000000001', dictation: DICTATION, readAt: READ_AT, keep: { rendezvous: ['appointmentKind', 'start'] }, appointmentId: 'v1', report: REPORT },
    });
    expect(t.answer()).toBe(`Rangé : le rendez-vous. Aucun message n’est parti au contact. ${DICTEE_DELIVERY.sent}`);
    // Rien d'autre n'est appelé : ni la dictée ni la validation du compte rendu de l'écran de la visite.
    expect(t.calls.some((c) => c.url.includes('/compte-rendu'))).toBe(false);
  });

  it('[R261] le compte rendu seul, coché : il part avec une validation sans champ ; décoché et rien d’autre : rien ne part', async () => {
    const t = await visit({ 'POST /v1/dictee/validation': ok({ personId: 'p1', contact: null, propertyId: null, appointmentId: null, report: { delivery: 'waiting', rule: 'R01' } }) });
    await t.open();
    await t.dictate();
    for (const b of t.boxes()) if (b !== t.reportBox()) b.checked = false;
    await t.click(t.btn('Valider ce qui est coché'));
    expect(t.posts()[1]!.body).toMatchObject({ keep: {}, appointmentId: 'v1', report: REPORT });
    expect(t.answer()).toBe(DICTEE_DELIVERY.waiting);
    const u = await visit();
    await u.open();
    await u.dictate();
    for (const b of u.boxes()) b.checked = false;
    await u.click(u.btn('Valider ce qui est coché'));
    expect(u.posts()).toHaveLength(1);
    expect(u.answer()).toBe(DICTEE_REFUSALS.nothing_kept);
  });

  it('[R260] le compte rendu décoché ne part pas ; la contre-visite seule part avec la visite', async () => {
    const t = await visit({ 'POST /v1/dictee/validation': ok({ personId: 'p1', contact: null, propertyId: null, appointmentId: 'v2', report: null }) });
    await t.open();
    await t.dictate();
    t.reportBox()!.checked = false;
    await t.click(t.btn('Valider ce qui est coché'));
    const body = t.posts()[1]!.body;
    expect(body).toMatchObject({ keep: { rendezvous: ['appointmentKind', 'start'] }, appointmentId: 'v1' });
    expect('report' in body).toBe(false);
    expect(t.answer()).toBe('Rangé : le rendez-vous. Aucun message n’est parti au contact.');
  });

  it.each([
    ['sans compte rendu', null],
    ['opinion qui n’est pas un texte', { ...REPORT, opinion: 7 }],
    ['intérêt inconnu', { ...REPORT, interest: 'énorme' }],
    ['trop de points forts', { ...REPORT, strengths: Array.from({ length: 9 }, (_, i) => `point ${i}`) }],
  ])('[R10] %s : le compte rendu n’est ni proposé ni envoyé, l’écran le dit', async (_n, report) => {
    const t = await visit({ 'POST /v1/dictee/lecture': ok({ draft: DRAFT, readAt: READ_AT, report }) });
    await t.open();
    await t.dictate();
    expect(t.reportBox()).toBeUndefined();
    expect(t.part().textContent).toContain('Le compte rendu n’a pas pu être rédigé d’après cette dictée : écrivez-le dans « Compte rendu au vendeur ».');
    await t.click(t.btn('Valider ce qui est coché'));
    expect('report' in t.posts()[1]!.body).toBe(false);
  });

  it('[R13] un compte rendu reçu est posé en texte, jamais en code', async () => {
    const t = await visit({ 'POST /v1/dictee/lecture': ok({ draft: { ...DRAFT, fields: [] }, readAt: READ_AT, report: { ...REPORT, opinion: INJECTED, strengths: [INJECTED] } }) });
    await t.open();
    await t.dictate();
    expect(t.part().textContent).toContain(INJECTED);
    expect(t.corps().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it.each([
    ['already_validated', 409, DICTEE_REFUSALS.already_validated],
    ['unknown', 404, DICTEE_REFUSALS.unknown],
    ['report_buyer_named', 409, 'Le compte rendu porte ce que la dictée ne dit pas : corrigez-le à l’écran de la visite.'],
  ])('[R16] refus %s dit en mots, jamais son code ; la dictée reste à l’écran', async (code, status, said) => {
    const t = await visit({ 'POST /v1/dictee/validation': no(status, { ok: false, rule: null, code }) });
    await t.open();
    await t.dictate();
    await t.click(t.btn('Valider ce qui est coché'));
    expect(t.answer()).toBe(said);
    expect(t.part().textContent).not.toContain(code);
    expect(t.part().all().find((e) => e.tagName === 'textarea')!.value).toBe(DICTATION);
  });

  it('[R261] la lecture refusée pour un compte rendu déjà validé est dite en mots', async () => {
    const t = await visit({ 'POST /v1/dictee/lecture': no(409, { ok: false, rule: null, code: 'already_validated' }) });
    await t.open();
    await t.dictate();
    expect(t.answer()).toBe(DICTEE_REFUSALS.already_validated);
    expect(t.reportBox()).toBeUndefined();
  });
});
