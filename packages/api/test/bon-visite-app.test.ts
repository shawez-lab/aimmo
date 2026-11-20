import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems, gzipSize } from '../../core/src/design/audit.ts';
import { BON_VISITE_REFUSALS, BON_VISITE_SCRIPT } from '../app/bon-visite.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// AU075 · Tout est inventé : clé, visite, bien, visiteur, code.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const LABEL = 'Faire signer, sans papier';
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
  status: 'booked',
  property: { id: 'b1', reference: 'REF-T-1', city: 'Dijon' },
  projectId: 'pr1',
  visitor: { firstName: 'Inès' },
  slip: { status: 'complet', mode: 'essai', signed: false, online: null },
  safety: 'confirmee',
  report: null,
};
const CONTENT = `Bon de visite : Inès Durand visite REF-T-1 le 03/03/2027. ${INJECTED}`;
const PARAGRAPHS = ['DOCUMENT D’ESSAI : modèle non validé, sans aucune valeur juridique.', CONTENT];
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok(RDV),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/visites/v1': ok(VISIT),
  'POST /v1/visites/v1/bon/signature-en-ligne': ok({ sessionId: 's1', place: 'sur_place', channel: 'sms', codeExpiresAt: '2027-03-03T12:50:00.000Z', mode: 'essai' }),
  'GET /v1/visites/v1/bon/a-signer': ok({ paragraphs: PARAGRAPHS, slipHash: 'f'.repeat(64), codeExpiresAt: '2027-03-03T12:50:00.000Z', mode: 'essai' }),
  'POST /v1/visites/v1/bon/signature-sur-place': ok({ copy: 'remis', copyLink: false, proof: { method: 'code', realSignature: false } }),
};
const COPY = { paragraphs: PARAGRAPHS, proof: { slipHash: 'f'.repeat(64), signedAt: '2027-03-03T12:45:00.000Z', method: 'code', drawingHash: null, place: 'sur_place' } };
const NOT_SIGNED = no(409, { ok: false, rule: null, code: 'not_signed' });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function visit(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: Call[] = [];
  // L'exemplaire n'existe qu'une fois le bon signé.
  let signed = false;
  const table: Record<string, Answer> = {
    ...BASE,
    'GET /v1/visites/v1/bon/exemplaire': (b) => (signed ? ok(COPY) : NOT_SIGNED)(b),
    ...answers,
  };
  const sign = table['POST /v1/visites/v1/bon/signature-sur-place']!;
  table['POST /v1/visites/v1/bon/signature-sur-place'] = async (b) => {
    const r = await sign(b);
    if (r.ok) signed = true;
    return r;
  };
  const ctx: Record<string, unknown> = {
    document,
    Intl,
    Date,
    crypto: { randomUUID: () => '7d1c2b3a-2222-4a2b-8c3d-000000000001' },
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
  let label = LABEL;
  const part = () => corps().all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === label);
  const scripts = () => [els.fiche!, ...els.fiche!.all()].filter((e) => e.tagName === 'script' && e.attributes.src === '/app/bon-visite.js');
  const open = async () => {
    await click(part()!.children[0]);
    runInNewContext(BON_VISITE_SCRIPT, ctx);
    scripts()[0]!.listeners.load!({});
    await settle();
  };
  const btn = (text: string) => buttonIn(part()!, text);
  const boxes = () => part()!.all().filter((e) => e.tagName === 'input' && e.attributes.type === 'checkbox');
  const posts = () => calls.filter((c) => c.method === 'POST');
  const answer = () => part()!.all().filter((e) => e.attributes.role === 'status').map((e) => e.textContent).filter(Boolean).at(-1) ?? '';
  return { calls, table, part, scripts, open, btn, click, boxes, posts, answer, setLabel: (l: string) => (label = l) };
}

describe('AU075 · le bon signé sans papier, depuis l’écran de la visite', () => {
  it('[R506] un bon déjà signé en ligne garde l’accès à son exemplaire ; un exemplaire illisible se redemande', async () => {
    const t = await visit({ 'GET /v1/visites/v1': ok({ ...VISIT, slip: { ...VISIT.slip, signed: true, online: { status: 'signee', place: 'sur_place', copy: 'remis' } } }) });
    t.setLabel('Montrer l’exemplaire signé');
    let fails = 1;
    t.table['GET /v1/visites/v1/bon/exemplaire'] = async (b) => (fails-- > 0 ? Promise.reject(new TypeError('hors ligne')) : ok(COPY)(b));
    await t.open();
    expect(t.part()!.textContent).toContain('Pas de réseau : l’exemplaire ne s’affiche pas pour le moment. Réessayez.');
    expect(t.btn('Signer ici, sur mon téléphone')).toBeUndefined();
    await t.click(t.btn('Montrer l’exemplaire'));
    expect(t.part()!.textContent).toContain('Exemplaire du visiteur');
    expect(t.part()!.textContent).toContain(CONTENT);
    expect(t.part()!.textContent).not.toContain('ne s’affiche pas');
    // Signé sur papier : ni signature ni exemplaire en ligne à l'écran.
    const u = await visit({ 'GET /v1/visites/v1': ok({ ...VISIT, slip: { ...VISIT.slip, signed: true, online: null } }) });
    expect(u.part()).toBeUndefined();
    u.setLabel('Montrer l’exemplaire signé');
    expect(u.part()).toBeUndefined();
  });

  it('[R201] le geste est sur l’écran d’une visite au bon complet et non signé ; rien n’est chargé avant ; budgets tenus', async () => {
    const t = await visit();
    expect(t.part()).toBeDefined();
    expect(t.scripts()).toEqual([]);
    expect(t.calls.some((c) => c.url.includes('/bon/'))).toBe(false);
    expect(BON_VISITE_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|localStorage/);
    expect(budgetProblems({ html: '', js: BON_VISITE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(gzipSize(HTML) + gzipSize(AGENT_APP_FILES['/app/app.css']!) + gzipSize(JS)).toBeLessThan(BUDGETS.application.gzipBytes - 500);
    expect(AGENT_APP_FILES['/app/bon-visite.js']).toBe(BON_VISITE_SCRIPT);
    for (const over of [{ slip: { ...VISIT.slip, signed: true } }, { slip: { ...VISIT.slip, status: 'incomplet' } }]) {
      const u = await visit({ 'GET /v1/visites/v1': ok({ ...VISIT, ...over }) });
      expect(u.part()).toBeUndefined();
    }
  });

  it('[R506] sur place : code au visiteur, bon lu à l’écran, code tapé et tracé, puis l’exemplaire dit remis', async () => {
    const t = await visit();
    await t.open();
    expect(t.part()!.textContent).toContain('Il voit aussitôt son exemplaire et reçoit la preuve');
    // La signature à distance attend ses pages publiques : l'écran ne la propose pas.
    expect(t.btn('Envoyer le lien pour signer à distance')).toBeUndefined();
    // Sans l'accord coché, aucune preuve d'accord n'est envoyée : la couche métier refuse si aucun accord n'est en cours.
    t.boxes()[0]!.checked = true;
    await t.click(t.btn('Signer ici, sur mon téléphone'));
    expect(t.posts()[0]).toMatchObject({ url: '/v1/visites/v1/bon/signature-en-ligne', body: { place: 'sur_place', channel: 'sms', consentProof: expect.stringContaining('Accord du visiteur') } });
    // Le bon est posé en texte, jamais en HTML.
    expect(t.part()!.textContent).toContain(CONTENT);
    expect(t.part()!.all().some((e) => e.tagName === 'img')).toBe(false);
    const code = t.part()!.all().find((e) => e.tagName === 'input' && e.attributes.autocomplete === 'one-time-code')!;
    code.value = ' 234567 ';
    await t.click(t.btn('Signer le bon'));
    expect(t.posts()[1]).toEqual({ method: 'POST', url: '/v1/visites/v1/bon/signature-sur-place', body: { code: '234567', drawing: null } });
    expect(t.answer()).toContain('Bon signé, sans papier. Le visiteur a reçu la preuve de sa signature, avec l’empreinte du bon.');
    expect(t.answer()).toContain('Signature d’essai');
    // L'exemplaire s'affiche aussitôt, en texte, avec sa preuve.
    expect(t.calls.at(-1)).toMatchObject({ method: 'GET', url: '/v1/visites/v1/bon/exemplaire' });
    expect(t.btn('Montrer l’exemplaire')).toBeUndefined();
    const text = t.part()!.textContent;
    expect(text).toContain('Exemplaire du visiteur');
    expect(text).toContain(CONTENT);
    expect(text).toContain('Signé le 03/03/2027 à 13:45, par code. Empreinte du bon : ' + 'f'.repeat(64));
    expect(t.part()!.all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('[R506] le code par mail, sans accord coché ; un refus est dit en mots', async () => {
    const t = await visit();
    await t.open();
    t.boxes()[1]!.checked = false;
    await t.click(t.btn('Signer ici, sur mon téléphone'));
    expect(t.posts()[0]!.body).toEqual({ place: 'sur_place', channel: 'email' });
    const u = await visit({ 'POST /v1/visites/v1/bon/signature-en-ligne': no(409, { ok: false, rule: 'R03', code: 'no_consent' }) });
    await u.open();
    await u.click(u.btn('Signer ici, sur mon téléphone'));
    expect(u.answer()).toBe(BON_VISITE_REFUSALS.no_consent);
    const w = await visit({ 'POST /v1/visites/v1/bon/signature-sur-place': no(409, { ok: false, rule: null, code: 'wrong_code' }) });
    await w.open();
    await w.click(w.btn('Signer ici, sur mon téléphone'));
    await w.click(w.btn('Signer le bon'));
    expect(w.answer()).toBe(BON_VISITE_REFUSALS.wrong_code);
  });
});
