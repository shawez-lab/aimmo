import { runInNewContext } from 'node:vm';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { APPELS_RECUS_QUOTE_MAX, APPELS_RECUS_SCRIPT, APPELS_RECUS_STATES, APPELS_RECUS_STOP_MAX } from '../app/appels-recus.ts';
import { APPELS_RECUS_REFUSALS } from '../src/appels.ts';
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



const ROUTE = '/v1/fiches/p-1/appels-recus';
type A = Awaited<ReturnType<typeof openedFiche>>;
const scripts = (a: A) => a.els.fiche!.children.filter((e) => e.attributes.src === '/app/appels-recus.js');
const part = (a: A) => a.body.all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Appels reçus')!;
const said = (a: A) => part(a).all().find((e) => e.attributes.role === 'status')!.textContent;
const texts = (a: A) => part(a).all().map((e) => e.textContent);
const open = async (answer: () => Promise<Response>) => {
  const a = await openedFiche(FICHE, { [ROUTE]: answer });
  a.named(a.body, 'Appels reçus')[0]!.listeners.click!({});
  await a.tick();
  runInNewContext(APPELS_RECUS_SCRIPT, a.context);
  scripts(a)[0]!.listeners.load!({});
  await a.tick();
  return a;
};

const CALL = {
  id: 'c1',
  startedAt: '2026-12-08T09:00:00.000Z',
  durationS: 185,
  status: 'traite',
  failure: null,
  needsAgent: false,
  ambiguous: false,
  hasRecording: true,
  category: 'seller',
  route: null,
  summary: [
    { key: 'city', value: 'Talant', quote: 'Je souhaite vendre ma maison à Talant.', atS: 9 },
    { key: 'priceEur', value: 280000, quote: 'Je pensais à 280 000 €.', atS: 25 },
    { key: 'deadline', value: 'within_3_months', quote: 'Je voudrais vendre dans 3 mois.', atS: 30 },
    { key: 'inconnu', value: 'x', quote: 'champ inconnu', atS: 31 },
  ],
  transcript: [
    { speaker: 'agent', startS: 0, endS: 6, text: 'Bonjour, cet appel est enregistré.' },
    { speaker: 'appelant', startS: 9, endS: 20, text: 'Je souhaite vendre ma maison à Talant.' },
    { speaker: 'robot', startS: 21, endS: 22, text: 'à taire' },
  ],
  stop: null,
  originKind: 'inconnue',
};

describe('BR61 · les appels reçus dans la fiche', () => {
  it('[R201] servi à part, chargé au geste ; rien n’est lu avant ; le budget tient ; aucun innerHTML', async () => {
    const a = await openedFiche(FICHE);
    expect(a.calls.some((c) => c.url === ROUTE)).toBe(false);
    expect(scripts(a)).toEqual([]);
    expect(AGENT_APP_FILES['/app/appels-recus.js']).toBe(APPELS_RECUS_SCRIPT);
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain("/appels-recus', 'GET'");
    expect(APPELS_RECUS_SCRIPT).not.toContain('innerHTML');
    expect(budgetProblems({ html: '', js: APPELS_RECUS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']! }, BUDGETS.application)).toEqual([]);
  });

  it('[R243] chaque ligne du résumé porte la phrase dite ; un champ inconnu est tu ; la transcription s’ouvre au geste', async () => {
    const a = await open(ok([CALL]));
    expect(a.calls.filter((c) => c.url === ROUTE).map((c) => c.method)).toEqual(['GET']);
    const all = texts(a);
    expect(all.some((x) => /^Appel du .+, 3 min 5 s$/.test(x))).toBe(true);
    expect(all).toContain('Demande comprise : Vendre.');
    expect(all).toContain('Commune : Talant — dit : « Je souhaite vendre ma maison à Talant. »');
    expect(all).toContain('Prix évoqué : 280\u00a0000\u00a0€ — dit : « Je pensais à 280 000 €. »');
    expect(all).toContain('Délai : dans les 3 mois — dit : « Je voudrais vendre dans 3 mois. »');
    expect(all.some((x) => x.includes('champ inconnu'))).toBe(false);
    expect(all).toContain('L’enregistrement est gardé.');
    expect(all.some((x) => x.includes('Bonjour, cet appel'))).toBe(false);
    a.named(part(a), 'Lire la transcription')[0]!.listeners.click!({});
    const opened = texts(a);
    expect(opened).toContain('Agent (0:00) : Bonjour, cet appel est enregistré.');
    expect(opened).toContain('Appelant (0:09) : Je souhaite vendre ma maison à Talant.');
    expect(opened.some((x) => x.includes('à taire'))).toBe(false);
    expect(said(a)).toBe('');
  });

  it('[R04] la demande d’arrêt et un numéro sur plusieurs fiches sont dits ; un appel sans résumé dit quoi faire', async () => {
    const a = await open(
      ok([
        { ...CALL, id: 'c2', stop: { quote: 'Ne m’appelez plus.', atS: 40 }, ambiguous: true },
        { ...CALL, id: 'c3', status: 'sans_enregistrement', summary: [], transcript: [], hasRecording: false, category: null },
        { ...CALL, id: 'c4', status: 'impossible', failure: 'incertaine', summary: [], transcript: [], category: null },
      ]),
    );
    const all = texts(a);
    expect(all).toContain('Demande d’arrêt dite par l’appelant : « Ne m’appelez plus. ». L’arrêt de tous les envois est rangé.');
    expect(all).toContain('Ce numéro est sur plusieurs fiches : vérifiez que l’appel est bien de cette personne.');
    expect(all).toContain(APPELS_RECUS_STATES.sans_enregistrement);
    expect(all).toContain(APPELS_RECUS_STATES.incertaine);
  });

  it('[R16] un refus est dit en mots, jamais un code ; hors ligne et aucun appel sont dits', async () => {
    const a = await open(async () => Response.json({ ok: false, rule: 'R16', code: 'not_assigned', message: APPELS_RECUS_REFUSALS['not_assigned'] }, { status: 403 }));
    expect(said(a)).toBe(APPELS_RECUS_REFUSALS['not_assigned']);
    const b = await open(async () => Promise.reject(new TypeError('hors ligne')));
    expect(said(b)).toBe('Pas de réseau. Réessayez dans un moment.');
    const c = await open(ok([]));
    expect(said(c)).toBe('Aucun appel reçu pour cette personne.');
    const d = await open(async () => new Response('panne', { status: 500 }));
    expect(said(d)).toBe('Les appels reçus ne se lisent pas pour le moment.');
  });

  it('[R243] une phrase longue que le cœur admet est dite, une demande d’arrêt sur plusieurs passages aussi', async () => {
    const long = 'a'.repeat(APPELS_RECUS_QUOTE_MAX);
    const stop = 'b'.repeat(APPELS_RECUS_STOP_MAX);
    const a = await open(ok([{ ...CALL, summary: [{ key: 'city', value: 'Talant', quote: long, atS: 1 }], stop: { quote: stop, atS: 2 } }]));
    const all = texts(a);
    expect(all).toContain('Commune : Talant — dit : « ' + long + ' »');
    expect(all.some((x) => x.includes(stop))).toBe(true);
    const b = await open(ok([{ ...CALL, summary: [{ key: 'city', value: 'Talant', quote: long + 'a', atS: 1 }] }]));
    expect(texts(b)).toContain('Rien de précis n’a été compris : lisez la transcription.');
  });

  it('[R201] un texte reçu est posé en texte', async () => {
    const a = await open(ok([{ ...CALL, summary: [{ key: 'city', value: '<img src=x onerror=alert(1)>', quote: '<b>gras</b>', atS: 1 }] }]));
    const node = part(a).all().find((e) => e.textContent === 'Commune : <img src=x onerror=alert(1)> — dit : « <b>gras</b> »');
    expect(node).toBeDefined();
    expect(part(a).all().some((e) => e.tagName === 'img' || e.tagName === 'b')).toBe(false);
  });
});
