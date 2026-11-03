import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { FINANCES_SCRIPT } from '../app/finances.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, chiffres, zones. L'horloge : le 3 mars 2027 ; le mois passé est février.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
let clock = Date.parse('2027-03-03T10:00:00.000Z');
class Clock extends Date {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [string]));
  }
  static override now(): number {
    return clock;
  }
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const PARCOURS = 'GET /v1/pilotage/parcours?du=2027-02-01&au=2027-02-28';
const ACTIFS = 'GET /v1/pilotage/agents-actifs?mois=2027-02';
const ZONES = 'GET /v1/pilotage/contacts-par-zone?mois=2027-02';
const nothing = { numerator: 0, denominator: 0, bp: null };
const EMPTY_DELAY = { values: [], median: null, unmeasured: 0 };
const JOURNEY = {
  conversion: { appointmentsPerContact: { numerator: 3, denominator: 20, bp: 1500 }, mandatesPerAppointment: nothing, salesPerMandate: { numerator: 1, denominator: 4, bp: 2500 } },
  mandateToOfferDays: { values: [10, 30], median: 20, unmeasured: 1 },
  offerToActDays: EMPTY_DELAY,
  valuationToMandateMinutes: { values: [7, 21], median: 14, unmeasured: 0, underTarget: 1, targetMinutes: 10 },
  networkReferredMandates: { numerator: 1, denominator: 4, bp: 2500 },
};
const PEOPLE = { month: '2027-02', activeSigners: 2, retainedAfterYear: { ...nothing, cohortMonth: '2026-02' } };

async function run(role: 'agent' | 'direction', answers: Record<string, Answer> = {}) {
  clock = Date.parse('2027-03-03T10:00:00.000Z');
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role, firstName: null }),
    'GET /v1/pilotage/rapport-matin': ok(null),
    'GET /v1/pilotage/preuve': no(503, {}),
    'GET /v1/pilotage/preuve/sceaux': no(503, {}),
    [PARCOURS]: ok(JOURNEY),
    [ACTIFS]: ok(PEOPLE),
    [ZONES]: ok({ month: '2027-02', zones: [{ zone: 'Nord', contacts: 8 }], otherZones: { zones: 2, contacts: 5 } }),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date: Clock,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  els[`rapport-${role}-lire`]!.listeners.click!({});
  await settle();
  const s = els[role === 'agent' ? 'chiffres' : 'reseau']!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/finances.js');
  runInNewContext(FINANCES_SCRIPT, context);
  s[0]!.listeners.load!({});
  await settle();
  const texts = (id: string) => els[`${id}-corps`]!.all().map((e) => e.textContent).join(' | ');
  return { els, calls, table, texts };
}

describe('IN06 · les indicateurs à l’écran', () => {
  it('[R214] la direction lit le mois passé : les taux, les délais, et une donnée absente dite absente, jamais zéro', async () => {
    const t = await run('direction');
    const text = t.texts('indicateurs');
    expect(t.els['indicateurs-etat']!.textContent).toBe('février 2027.');
    expect(text).toContain('Contacts en rendez-vous : 15 % (3 sur 20)');
    expect(text).toContain('Rendez-vous en mandats : pas de donnée sur ce mois');
    expect(text).toContain('Mandats en ventes : 25 % (1 sur 4)');
    expect(text).toContain('Du mandat à l’offre acceptée : 20 jours en médiane, sur 2 dossiers, 1 impossible à mesurer');
    expect(text).toContain('De l’offre à l’acte : pas de donnée sur ce mois');
    expect(text).toContain('De l’avis validé à la signature : 14 minutes en médiane, sur 2 dossiers. 1 sous 10 minutes');
    expect(text).toContain('2 agents ont signé');
    expect(text).toContain('Personne n’est entré en février 2026');
    expect(text).toContain('Nord : 8 contacts');
    expect(text).not.toMatch(/\b0 %/);
  });

  it('[R214] janvier : le mois passé est décembre de l’année d’avant, jusqu’à son dernier jour', async () => {
    const t = await run('direction', {});
    clock = Date.parse('2027-01-10T10:00:00.000Z');
    t.table['GET /v1/pilotage/parcours?du=2026-12-01&au=2026-12-31'] = ok(JOURNEY);
    t.table['GET /v1/pilotage/agents-actifs?mois=2026-12'] = ok(PEOPLE);
    t.table['GET /v1/pilotage/contacts-par-zone?mois=2026-12'] = ok({ month: '2026-12', zones: [], otherZones: null });
    t.els['rapport-direction-lire']!.listeners.click!({});
    await settle();
    expect(t.calls.map((c) => c.url)).toContain('/v1/pilotage/parcours?du=2026-12-01&au=2026-12-31');
    expect(t.els['indicateurs-etat']!.textContent).toBe('décembre 2026.');
  });

  it('[R214] le mois est celui de Paris : le 28 février à 23 h 30 UTC, c’est déjà mars, le mois passé est février', async () => {
    const t = await run('direction');
    clock = Date.parse('2027-02-28T22:30:00.000Z');
    t.table['GET /v1/pilotage/parcours?du=2027-01-01&au=2027-01-31'] = ok(JOURNEY);
    t.table['GET /v1/pilotage/agents-actifs?mois=2027-01'] = ok(PEOPLE);
    t.table['GET /v1/pilotage/contacts-par-zone?mois=2027-01'] = ok({ month: '2027-01', zones: [], otherZones: null });
    t.els['rapport-direction-lire']!.listeners.click!({});
    await settle();
    expect(t.els['indicateurs-etat']!.textContent).toBe('janvier 2027.');
    clock = Date.parse('2027-02-28T23:30:00.000Z');
    t.els['rapport-direction-lire']!.listeners.click!({});
    await settle();
    expect(t.calls.slice(-6).map((c) => c.url)).toContain('/v1/pilotage/parcours?du=2027-02-01&au=2027-02-28');
    expect(t.els['indicateurs-etat']!.textContent).toBe('février 2027.');
  });

  it('[R68] [R215] l’agent lit ce que le serveur lui rend, par la seule route des zones ; ce qui est retenu est dit sans chiffre', async () => {
    const t = await run('agent');
    expect(t.texts('zones')).toContain('Nord : 8 contacts');
    expect(t.texts('zones')).toContain('Autres zones réunies (2) : 5 contacts');
    expect(t.texts('zones')).not.toContain('trop petites');
    expect(t.calls.filter((c) => /parcours|agents-actifs|preuve/.test(c.url))).toEqual([]);
    const held = await run('agent', { [ZONES]: ok({ month: '2027-02', zones: [], otherZones: null }) });
    expect(held.els['zones-etat']!.textContent).toContain('Aucune zone à montrer');
    expect(held.texts('zones')).toContain('trop petites');
    expect(held.texts('zones')).not.toMatch(/\d/);
    expect(held.els['zones-etat']!.textContent).not.toContain('contact');
  });

  it('[R16] droits refusés, réseau perdu, panne : dits tels, sans chiffres, et le rapport reste lisible', async () => {
    const refused = await run('direction', { [ACTIFS]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    expect(refused.els['indicateurs-etat']!.textContent).toContain('pas dans vos droits');
    expect(refused.els['indicateurs-corps']!.children).toEqual([]);
    const lost = await run('agent', { [ZONES]: async () => { throw new TypeError('hors ligne'); } });
    expect(lost.els['zones-etat']!.textContent).toContain('Pas de réseau');
    expect(lost.els['rapport-agent-etat']!.textContent).toContain('Aucun rapport rangé');
    const broken = await run('direction', { [PARCOURS]: no(500, {}) });
    expect(broken.els['indicateurs-etat']!.textContent).toContain('Indisponible');
  });

  it('[R16] à la déconnexion tout disparaît ; une réponse en vol ne s’affiche pas à la session suivante', async () => {
    const t = await run('direction');
    expect(t.els['indicateurs-corps']!.children).not.toEqual([]);
    let answer: (r: Response) => void = () => {};
    t.table[PARCOURS] = () => new Promise((r) => { answer = r; });
    t.els['rapport-direction-lire']!.listeners.click!({});
    await settle();
    t.els.sortir!.listeners.click!({});
    await settle();
    answer(Response.json({ ok: true, data: JOURNEY }));
    await settle();
    expect(t.els['indicateurs-corps']!.children).toEqual([]);
    expect(t.els['indicateurs-etat']!.textContent).toBe('');
    const a = await run('agent');
    expect(a.els['zones-corps']!.children).not.toEqual([]);
    let late: (r: Response) => void = () => {};
    a.table[ZONES] = () => new Promise((r) => { late = r; });
    a.els['rapport-agent-lire']!.listeners.click!({});
    await settle();
    a.els.sortir!.listeners.click!({});
    await settle();
    expect(a.els['zones-corps']!.children).toEqual([]);
    late(new Response('panne', { status: 500 }));
    await settle();
    expect(a.els['zones-corps']!.children).toEqual([]);
    expect(a.els['zones-etat']!.textContent).toBe('');
  });

  it('[R201] les budgets tiennent', () => {
    expect(budgetProblems({ html: '', js: FINANCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });
});
