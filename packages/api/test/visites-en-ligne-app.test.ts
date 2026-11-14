import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { BIENS_FICHE_SCRIPT } from '../app/biens-fiche.ts';
import { VISITES_EN_LIGNE_LOST, VISITES_EN_LIGNE_NOT_DIFFUSABLE, VISITES_EN_LIGNE_REFUSALS, VISITES_EN_LIGNE_SCRIPT } from '../app/visites-en-ligne.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// BR64 · Tout est inventé : fiche, projets, rendez-vous, biens, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const ID = '0b6f1d2e-5555-4a2b-8c3d-000000000040';
const INJECTED = '<img src=x onerror="alert(1)">';
const BUY = { id: 'projet-achat-1', kind: 'buy', stage: 'new', deadline: null, budgetMinEur: null, budgetMaxEur: 250000 };
const FICHE = (projects: unknown[]) => ({
  personId: ID,
  firstName: 'Client',
  lastName: 'Essai',
  contact: { allowed: true, reasons: [] },
  call: null,
  callRefusal: 'no_phone',
  callClosesAt: null,
  callbacks: [],
  projects,
  sources: [],
  qualification: null,
  messages: [],
});
const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: ID, firstName: 'Client', kind: 'callback', reason: 'Rappel', callbackDueAt: null }] };
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', sent: false, data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const A1 = 'rdv-en-ligne-1';
const A2 = 'rdv-en-ligne-2';
const LIST = [
  { appointmentId: A1, start: '2026-11-11T13:00:00.000Z', end: '2026-11-11T14:00:00.000Z', source: 'site', property: { reference: 'R-001', city: 'Dijon' }, address: '12 rue Inventée' },
  { appointmentId: A2, start: '2026-11-12T09:30:00.000Z', end: '2026-11-12T10:30:00.000Z', source: 'espace', property: { reference: INJECTED, city: 'Talant' } },
  // Mal formés : jamais dits.
  { appointmentId: 'x y', start: '2026-11-12T09:30:00.000Z', source: 'site', property: { reference: 'R-BAD', city: 'Dijon' } },
  { appointmentId: 'rdv-3', start: 'demain', source: 'site', property: { reference: 'R-BAD2', city: 'Dijon' } },
  { appointmentId: 'rdv-4', start: '2026-11-12T09:30:00.000Z', source: 'agent', property: { reference: 'R-BAD3', city: 'Dijon' } },
];

const tick = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};

async function opened(options: { projects?: unknown[]; answers?: Record<string, Answer> } = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { url: string; method: string; body: any; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
    'GET /v1/plan-du-jour': ok(PLAN),
    'GET /v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
    'GET /v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
    [`GET /v1/fiches/${ID}/resume`]: ok(FICHE(options.projects ?? [BUY])),
    [`GET /v1/fiches/${ID}/biens`]: ok([]),
    [`GET /v1/fiches/${ID}/visites-en-ligne`]: ok(LIST),
    [`POST /v1/visites/${A1}/rattachement`]: ok({ appointmentId: A1, slip: { appointmentId: A1, mode: 'essai', status: 'complet' } }),
    ...options.answers,
  };
  let keys = 0;
  const context: Record<string, unknown> = {
    document,
    Date,
    Object,
    crypto: { randomUUID: () => `0b6f1d2e-6666-4a2b-8c3d-${String(++keys).padStart(12, '0')}` },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await tick();
  const named = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  named(els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
  await tick();
  const body = els['fiche-corps']!;
  const scripts = (src: string) => body.all().filter((e) => e.tagName === 'script' && e.attributes.src === src);
  runInNewContext(BIENS_FICHE_SCRIPT, context);
  for (const s of scripts('/app/biens-fiche.js')) s.listeners.load!({});
  await tick();
  const section = () => body.all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Visites réservées en ligne');
  const callsBefore = calls.length;
  const open = async () => {
    named(section()!, 'Voir les visites à rattacher')[0]!.listeners.click!({});
    await tick();
    runInNewContext(VISITES_EN_LIGNE_SCRIPT, context);
    for (const s of scripts('/app/visites-en-ligne.js')) s.listeners.load!({});
    await tick();
  };
  const click = async (text: string, n = 0) => {
    const b = named(section()!, text)[n];
    if (!b) throw new Error(`bouton absent : ${text}`);
    b.listeners.click!({});
    await tick();
  };
  const status = () => section()!.all().filter((e) => e.attributes.role === 'status').map((e) => e.textContent).join(' ');
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { calls, callsBefore, table, body, section, scripts, open, click, status, posts, named };
}

describe('BR64 · les visites réservées en ligne, rattachées depuis la fiche', () => {
  it('[R201] servi à part, chargé seulement au geste, budget d’une page ; l’application tient le sien sans le connaître', async () => {
    const t = await opened();
    expect(t.section()).toBeDefined();
    expect(t.scripts('/app/visites-en-ligne.js')).toEqual([]);
    expect(t.calls.slice(t.callsBefore).filter((c) => c.url.includes('visites'))).toEqual([]);
    await t.open();
    expect(t.scripts('/app/visites-en-ligne.js')).toHaveLength(1);
    expect(AGENT_APP_FILES['/app/visites-en-ligne.js']).toBe(VISITES_EN_LIGNE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/visites-en-ligne.js');
    expect(JS).not.toContain('visites-en-ligne.js');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/visites-en-ligne.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(budgetProblems({ html: '', js: VISITES_EN_LIGNE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: BIENS_FICHE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(VISITES_EN_LIGNE_SCRIPT).not.toContain('innerHTML');
  });

  it('sans projet d’achat, aucun bloc', async () => {
    const t = await opened({ projects: [{ ...BUY, id: 'projet-vente', kind: 'sell' }] });
    expect(t.body.textContent).toContain('Biens du client');
    expect(t.section()).toBeUndefined();
  });

  it('[R16] [R19] une seule lecture, la clé dans l’en-tête ; chaque visite dite par son heure de Paris, sa référence, sa commune et d’où elle vient ; texte reçu posé en texte, champ mal formé tu', async () => {
    const t = await opened();
    await t.open();
    const sent = t.calls.slice(t.callsBefore).filter((c) => c.url.startsWith('/v1/'));
    expect(sent.map((c) => `${c.method} ${c.url}`)).toEqual([`GET /v1/fiches/${ID}/visites-en-ligne`]);
    expect(sent[0]!.auth).toBe(`Bearer ${KEY}`);
    const text = t.section()!.textContent;
    expect(text).toContain('Visite du mercredi 11 novembre à 14 h 00, réf. R-001 à Dijon, réservée sur le site.');
    expect(text).toContain(`réf. ${INJECTED} à Talant, réservée depuis son espace.`);
    expect(t.section()!.all().some((e) => e.tagName === 'img')).toBe(false);
    expect(text).not.toMatch(/R-BAD|rue Inventée|rdv-|x y/);
    expect(t.named(t.section()!, 'Rattacher à sa recherche')).toHaveLength(2);
  });

  it('[R40] rattacher envoie le projet seul ; la visite rattachée dit son bon ; aucun identifiant ni code montré', async () => {
    const t = await opened();
    await t.open();
    await t.click('Rattacher à sa recherche');
    const post = t.posts().at(-1)!;
    expect(post.url).toBe(`/v1/visites/${A1}/rattachement`);
    expect(post.body).toEqual({ projectId: BUY.id });
    expect(t.status()).toContain('Rattachée à la recherche : le bon de visite est prêt, d’essai tant que le modèle n’est pas validé.');
    expect(t.named(t.section()!, 'Rattacher à sa recherche')).toHaveLength(1);
    expect(t.section()!.textContent).not.toContain(A1);
  });

  it('[R16] [R40] [R42] chaque refus dit en mots, jamais par son code ; une réponse perdue reste incertaine', async () => {
    const t = await opened();
    await t.open();
    const at = `POST /v1/visites/${A1}/rattachement`;
    for (const [code, rule] of [['already_attached', null], ['no_template', 'R40'], ['not_booked', null], ['not_assigned', 'R16'], ['withdrawal_period', 'R42']] as const) {
      t.table[at] = no(409, { ok: false, rule, code });
      await t.click('Rattacher à sa recherche');
      expect(t.status()).toContain(VISITES_EN_LIGNE_REFUSALS[code]!);
      expect(t.status()).not.toContain(code);
    }
    t.table[at] = no(409, { ok: false, rule: 'R42', code: 'not_published' });
    await t.click('Rattacher à sa recherche');
    expect(t.status()).toContain(VISITES_EN_LIGNE_NOT_DIFFUSABLE);
    t.table[at] = no(500, { ok: false });
    await t.click('Rattacher à sa recherche');
    expect(t.status()).toContain(VISITES_EN_LIGNE_LOST);
  });

  it('deux projets d’achat : l’agent choisit le projet ; un projet hors liste ne part pas', async () => {
    const other = { ...BUY, id: 'projet-achat-2' };
    const t = await opened({ projects: [BUY, other] });
    await t.open();
    const pick = t.section()!.all().find((e) => e.tagName === 'select' && (e.attributes.id ?? '').endsWith('-projet-0'))!;
    pick.value = other.id;
    await t.click('Rattacher à sa recherche');
    expect(t.posts().at(-1)!.body).toEqual({ projectId: other.id });
    const second = t.section()!.all().find((e) => e.tagName === 'select' && (e.attributes.id ?? '').endsWith('-projet-1'))!;
    second.value = 'autre';
    const before = t.posts().length;
    await t.click('Rattacher à sa recherche');
    expect(t.posts()).toHaveLength(before);
  });

  it('lecture refusée : dite en mots ; liste vide : dite', async () => {
    const t = await opened({ answers: { [`GET /v1/fiches/${ID}/visites-en-ligne`]: no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) } });
    await t.open();
    expect(t.section()!.textContent).toContain(VISITES_EN_LIGNE_REFUSALS.not_assigned);
    const e = await opened({ answers: { [`GET /v1/fiches/${ID}/visites-en-ligne`]: ok([]) } });
    await e.open();
    expect(e.section()!.textContent).toContain('Aucune visite réservée en ligne n’attend.');
  });
});
