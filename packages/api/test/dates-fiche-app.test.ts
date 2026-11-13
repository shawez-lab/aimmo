import { runInNewContext } from 'node:vm';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CLIENT_DATE_LOST, FIN_DE_BAIL_SCRIPT } from '../app/fin-de-bail.ts';
import { DATE_REFUSALS } from '../src/scenarios.ts';
import { describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
type Call = { url: string; method: string; body: Record<string, unknown> | null };
const ok = (data: unknown) => async () => Response.json({ ok: true, mode: 'essai', data });
const FICHE = {
  personId: 'p-1',
  firstName: 'Client',
  lastName: 'Inventé',
  contact: { allowed: true, reasons: [] },
  call: null,
  callRefusal: 'no_consent',
  callClosesAt: null,
  projects: [],
  sources: [],
  consents: [
    { id: 'c-1', purpose: 'suivi_vente', channel: 'email', givenAt: '2026-10-01T10:00:00.000Z', withdrawnAt: null },
    { id: 'c-2', purpose: 'suivi_location', channel: 'email', givenAt: '2026-09-01T10:00:00.000Z', withdrawnAt: '2026-09-15T10:00:00.000Z' },
  ],
  messages: [],
  callbacks: [],
};
const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: 'p-1', firstName: 'Client', kind: 'callback', reason: 'À rappeler', order: 'règle 1', basis: { kind: 'request', since: '2026-11-01', purpose: null }, projectId: null }], removed: { excluded: 0, withdrawn: 0, noBasis: 0 }, hiddenSinceFrozen: 0 };

async function openedFiche(fiche: Record<string, unknown>, answers: Record<string, () => Promise<Response>> = {}) {
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
  const byLabel = (label: string): FakeElement => {
    const l = body.all().find((e) => e.tagName === 'label' && e.textContent.startsWith(label))!;
    return body.all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  return { els, body, calls, tick, named, byLabel, routes, context };
}


const PATH = '/v1/gagner/fiches/p-1/fin-de-bail';
const DATES = '/v1/dates-clients';
type A = Awaited<ReturnType<typeof openedFiche>>;
const scripts = (a: A) => a.els.fiche!.children.filter((e) => e.attributes.src === '/app/fin-de-bail.js');
const part = (a: A) => a.body.all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Anniversaire ou fête')!;
const state = (a: A) => part(a).all().find((e) => e.attributes.role === 'status')!.textContent;
const posts = (a: A) => a.calls.filter((c) => c.method === 'POST' && c.url === DATES);
const open = async (answers: Record<string, () => Promise<Response>> = {}) => {
  const a = await openedFiche(FICHE, { [PATH]: ok([]), ...answers });
  a.named(a.body, 'Dates connues')[0]!.listeners.click!({});
  await a.tick();
  runInNewContext(FIN_DE_BAIL_SCRIPT, a.context);
  scripts(a)[0]!.listeners.load!({});
  await a.tick();
  return a;
};
const fill = (a: A, v: { sorte?: string; mois?: string; jour?: string; source?: string }) => {
  for (const [k, value] of Object.entries(v)) part(a).all().find((e) => e.attributes.id === `date-client-${k}`)!.value = value;
};
const press = async (a: A) => {
  a.named(part(a), 'Ranger cette date')[0]!.listeners.click!({});
  await a.tick();
};

describe('BR58 · l’anniversaire ou la fête rangé depuis la fiche', () => {
  it('[R201] servi dans le script de « Dates connues », chargé au geste ; rien n’est demandé avant, le budget tient', async () => {
    const a = await openedFiche(FICHE);
    expect(a.calls.some((c) => c.url === DATES)).toBe(false);
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain('/v1/dates-clients');
    expect(budgetProblems({ html: '', js: FIN_DE_BAIL_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']! }, BUDGETS.application)).toEqual([]);
    const b = await open();
    expect(part(b)).toBeDefined();
    // La fin de bail réservée ou hors ligne : la date se range quand même.
    const c = await open({ [PATH]: async () => Response.json({ ok: false, rule: 'R16', code: 'not_assigned' }, { status: 403 }) });
    expect(part(c)).toBeDefined();
  });

  it('[R405] saisie contrôlée avant l’appel : sorte, jour qui existe dans le mois, d’où vient la date ; rien ne part sinon', async () => {
    const a = await open();
    await press(a);
    expect(state(a)).toBe(DATE_REFUSALS['bad_kind']);
    fill(a, { sorte: 'anniversaire' });
    await press(a);
    expect(state(a)).toBe(DATE_REFUSALS['bad_date']);
    for (const [mois, jour] of [['2', '30'], ['4', '31'], ['1', '0'], ['1', 'dix'], ['1', '1.5']] as const) {
      fill(a, { mois, jour });
      await press(a);
      expect(state(a)).toBe(DATE_REFUSALS['bad_date']);
    }
    fill(a, { mois: '2', jour: '29', source: '   ' });
    await press(a);
    expect(state(a)).toBe(DATE_REFUSALS['no_proof']);
    expect(posts(a)).toEqual([]);
    fill(a, { source: 'Dite par la cliente au téléphone, le 3 mars' });
    await press(a);
    expect(posts(a).map((c) => c.body)).toEqual([{ personId: 'p-1', kind: 'anniversaire', month: 2, day: 29, proof: 'Dite par la cliente au téléphone, le 3 mars' }]);
  });

  it('une date rangée est dite ; le serveur refait tout et son refus est dit en mots, jamais un code', async () => {
    const a = await open({ [DATES]: ok({ dateId: 'd1' }) });
    fill(a, { sorte: 'fete', mois: '12', jour: '6', source: 'Donnée par le client en rendez-vous' });
    await press(a);
    expect(state(a)).toBe('Date rangée : fête le 6 décembre. La dernière date rangée compte.');
    for (const [code, status] of [['not_assigned', 403], ['agent_file_incomplete', 403], ['bad_date', 409], ['no_proof', 409], ['other_network', 403]] as const) {
      const b = await open({ [DATES]: async () => Response.json({ ok: false, rule: 'R404', code }, { status }) });
      fill(b, { sorte: 'fete', mois: '12', jour: '6', source: 'Donnée par le client' });
      await press(b);
      expect(state(b)).toBe(DATE_REFUSALS[code]);
      expect(state(b)).not.toContain(code);
    }
    const c = await open({ [DATES]: async () => Response.json({ ok: false, rule: null, code: 'inconnu_xyz' }, { status: 400 }) });
    fill(c, { sorte: 'fete', mois: '12', jour: '6', source: 'Donnée par le client' });
    await press(c);
    expect(state(c)).toBe('La date n’est pas rangée.');
  });

  it('[R16] une réponse perdue ou une panne est dite incertaine ; un seul envoi à la fois', async () => {
    for (const answer of [() => Promise.reject(new TypeError('coupé')), async () => Response.json({ ok: false, code: 'internal' }, { status: 503 })]) {
      const a = await open({ [DATES]: answer });
      fill(a, { sorte: 'anniversaire', mois: '3', jour: '3', source: 'Donnée par la cliente' });
      await press(a);
      expect(state(a)).toBe(CLIENT_DATE_LOST);
    }
    let release: () => void = () => undefined;
    const b = await open({ [DATES]: () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, data: { dateId: 'd1' } })))) });
    fill(b, { sorte: 'anniversaire', mois: '3', jour: '3', source: 'Donnée par la cliente' });
    await press(b);
    await press(b);
    expect(posts(b)).toHaveLength(1);
    release();
    await b.tick();
    expect(state(b)).toContain('Date rangée');
  });
});
