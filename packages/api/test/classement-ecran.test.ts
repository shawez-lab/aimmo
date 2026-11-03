import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, ROUTES } from '@aimmo/core';
import { CATEGORY_LABELS, CLASSEMENT_SCRIPT, ROUTE_LABELS } from '../app/classement.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
type Call = { url: string; method: string; body: Record<string, unknown> | null };
const ok = (data: unknown) => async () => Response.json({ ok: true, mode: 'essai', data });
const QUAL = { id: 'q-1', category: 'seller', route: null, classifiedAt: '2026-11-09T09:00:00.000Z', correction: null };
const FICHE = { personId: 'p-1', firstName: 'Client', lastName: 'Inventé', contact: { allowed: true, reasons: [] }, call: null, callRefusal: 'no_phone', callClosesAt: null, callReopensAt: null, projects: [], sources: [], consents: [], messages: [], callbacks: [], qualification: QUAL };
const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: 'p-1', firstName: 'Client', kind: 'callback', reason: 'À rappeler', order: 'règle', legalBasis: 'demande' }] };
const PATH = '/v1/qualifications/q-1/correction';

async function opened(fiche: Record<string, unknown>, answers: Record<string, () => Promise<Response>> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: Call[] = [];
  const routes: Record<string, () => Promise<Response>> = {
    '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
    '/v1/plan-du-jour': ok(PLAN),
    '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
    '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
    '/v1/fiches/p-1/resume': ok(fiche),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    Date,
    Object,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
      const answer = routes[url];
      return answer ? answer() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, context);
  listeners.DOMContentLoaded!();
  const tick = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  const named = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  named(els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
  await tick();
  const body = els['fiche-corps']!;
  const scripts = () => body.all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/classement.js');
  const load = async () => {
    runInNewContext(CLASSEMENT_SCRIPT, context);
    for (const e of scripts()) e.listeners.load!({});
    await tick();
  };
  const selects = () => body.all().filter((e) => e.tagName === 'select' && /-(classe|suite)$/.test(e.attributes.id ?? ''));
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, body, calls, tick, named, scripts, load, selects, posts, routes };
}

describe('Q08 · corriger le classement depuis la fiche', () => {
  it('les listes fermées couvrent tout le classement du socle, sans rien de plus', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...CATEGORIES].sort());
    expect(Object.keys(ROUTE_LABELS).sort()).toEqual([...ROUTES].sort());
  });

  it('[R16] la correction part sans identifiant à saisir, une seule fois, puis la fiche est relue et montre l’origine et la correction [R17]', async () => {
    const a = await opened(FICHE, { [PATH]: ok(undefined) });
    await a.load();
    expect(a.body.textContent).toContain('Vendre, d’après son message du 09/11/2026.');
    // Rien à saisir : deux listes et un bouton, déjà sur le classement du moment.
    const [category, route] = a.selects();
    expect(category!.value).toBe('seller');
    expect(route!.value).toBe('aucune');
    expect(a.body.all().some((e) => e.tagName === 'input' && /classe|suite/.test(e.attributes.id ?? ''))).toBe(false);
    category!.value = 'buyer';
    route!.value = 'M17';
    a.routes['/v1/fiches/p-1/resume'] = ok({ ...FICHE, qualification: { ...QUAL, correction: { category: 'buyer', route: 'M17', correctedAt: '2026-11-10T09:00:00.000Z' } } });
    const b = a.named(a.body, 'Corriger le classement')[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await a.tick();
    expect(a.posts()).toEqual([{ url: PATH, method: 'POST', body: { category: 'buyer', route: 'M17' } }]);
    expect(a.body.textContent).toContain('Corrigé le 10/11/2026 : Chercher un bien, suite : Investissement.');
    expect(a.body.textContent).toContain('Classement d’origine, gardé : Vendre.');
    expect(a.els['fiche-etat']!.textContent).toBe('Correction enregistrée.');
    expect(a.scripts()).toHaveLength(0);
    // La correction nouvelle part du classement corrigé.
    expect(a.selects()[0]!.value).toBe('buyer');
    expect(a.selects()[1]!.value).toBe('M17');
  });

  it('retirer la suite envoie null ; rien de changé n’envoie rien et le dit', async () => {
    const q = { ...QUAL, category: 'rent_out', route: 'M15' };
    const a = await opened({ ...FICHE, qualification: q }, { [PATH]: ok(undefined) });
    await a.load();
    a.named(a.body, 'Corriger le classement')[0]!.listeners.click!({});
    await a.tick();
    expect(a.posts()).toEqual([]);
    expect(a.body.textContent).toContain('C’est déjà ce classement : rien à corriger.');
    a.selects()[1]!.value = 'aucune';
    a.named(a.body, 'Corriger le classement')[0]!.listeners.click!({});
    await a.tick();
    expect(a.posts()[0]!.body).toEqual({ category: 'rent_out', route: null });
  });

  it('changer la seule catégorie recale la suite, pour ne pas fausser la mesure ; chercher un bien reste au choix ; un candidat à la location n’est pas dit acheteur', async () => {
    const a = await opened(FICHE, { [PATH]: ok(undefined) });
    await a.load();
    const [category, route] = a.selects();
    const pick = (value: string) => { category!.value = value; category!.listeners.change!({}); };
    pick('rent_out');
    expect(route!.value).toBe('M15');
    pick('professional');
    expect(route!.value).toBe('M16');
    pick('seller');
    expect(route!.value).toBe('aucune');
    route!.value = 'M17';
    pick('buyer');
    expect(route!.value).toBe('M17');
    pick('rent_out');
    a.named(a.body, 'Corriger le classement')[0]!.listeners.click!({});
    await a.tick();
    expect(a.posts()[0]!.body).toEqual({ category: 'rent_out', route: 'M15' });

    const tenant = await opened({ ...FICHE, qualification: { ...QUAL, category: 'buyer', route: 'M15' } });
    await tenant.load();
    expect(tenant.body.textContent).toContain('Chercher un bien, suite : Location, d’après son message');
    expect(tenant.body.textContent).not.toContain('Acheter');
  });

  it('aucune note ni score n’est montré, même si la réponse en portait ; l’écran dit ce que la correction ne change pas', async () => {
    const a = await opened({ ...FICHE, qualification: { ...QUAL, score: 87, temperature: 'hot', source: 'ai' } });
    await a.load();
    const bloc = a.body.all().find((e) => e.tagName === 'section' && e.textContent.startsWith('Classement de la demande'))!;
    expect(bloc.textContent).not.toMatch(/87|hot|chaud|note|score|\bIA\b/i);
    expect(bloc.textContent).toContain('Elle ne change ni le projet ni les rappels.');
    expect(CLASSEMENT_SCRIPT).not.toMatch(/score|temperature/);
  });

  it('[R16] un refus se dit et la fiche est relue ; sans réseau, rien n’est enregistré ; une panne se dit', async () => {
    const moved = await opened(FICHE, { [PATH]: async () => Response.json({ ok: false, rule: 'R16', code: 'not_assigned' }, { status: 403 }) });
    await moved.load();
    moved.selects()[0]!.value = 'buyer';
    moved.routes['/v1/fiches/p-1/resume'] = async () => Response.json({ ok: false, code: 'not_assigned' }, { status: 403 });
    moved.named(moved.body, 'Corriger le classement')[0]!.listeners.click!({});
    await moved.tick();
    expect(moved.els['fiche-etat']!.textContent).toBe('Ce client est suivi par un autre agent.');

    const off = await opened(FICHE);
    await off.load();
    off.selects()[0]!.value = 'buyer';
    off.named(off.body, 'Corriger le classement')[0]!.listeners.click!({});
    await off.tick();
    expect(off.body.textContent).toContain('La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.');

    const down = await opened(FICHE, { [PATH]: async () => Response.json({ ok: false, code: 'panne' }, { status: 500 }) });
    await down.load();
    down.selects()[0]!.value = 'buyer';
    down.named(down.body, 'Corriger le classement')[0]!.listeners.click!({});
    await down.tick();
    expect(down.body.textContent).toContain('La correction n’est pas enregistrée : réessayez.');
  });

  it('[R02] une personne exclue garde le bloc ; sans classement, ni bloc ni script ; un identifiant douteux ne fait pas de formulaire', async () => {
    const stopped = await opened({ ...FICHE, contact: { allowed: false, reasons: ['stop'] }, callRefusal: 'excluded' });
    await stopped.load();
    expect(stopped.named(stopped.body, 'Corriger le classement')).toHaveLength(1);
    const none = await opened({ ...FICHE, qualification: null });
    expect(none.scripts()).toHaveLength(0);
    expect(none.body.textContent).not.toContain('Classement');
    const odd = await opened({ ...FICHE, qualification: { ...QUAL, id: '../autre' } });
    await odd.load();
    expect(odd.named(odd.body, 'Corriger le classement')).toHaveLength(0);
  });

  it('[R201] script perdu : l’écran le dit et le reste de la fiche tient ; le script est à part, hors de la coquille, dans le budget', async () => {
    const a = await opened(FICHE);
    a.scripts()[0]!.listeners.error!({});
    expect(a.body.textContent).toContain('Pas de réseau : le classement reviendra.');
    expect(a.body.textContent).toContain('Accords');
    expect(AGENT_APP_SHELL).not.toContain('/app/classement.js');
    expect(AGENT_APP_FILES['/app/classement.js']!).toContain('AIMMO_CLASSEMENT');
    expect(budgetProblems({ html: '', js: CLASSEMENT_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']! }, BUDGETS.application)).toEqual([]);
  });
});
