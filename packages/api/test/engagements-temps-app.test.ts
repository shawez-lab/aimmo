import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { FINANCES_SCRIPT } from '../app/finances.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, chiffres. L'horloge : le mercredi 3 mars 2027 ; mois passé février, semaine finie du 22 février.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = (body?: string) => Promise<Response>;
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
const WEEK = '2027-02-22';
const ENG = 'GET /v1/pilotage/engagements-tenus?mois=2027-02';
const NET = `GET /v1/pilotage/temps-gagne/reseau?semaine=${WEEK}`;
const DISPO = 'GET /v1/pilotage/disponibilite?mois=2027-02';
const MINE = `GET /v1/pilotage/temps-gagne?semaine=${WEEK}`;
const DECLARE = 'POST /v1/pilotage/temps-gagne';
const nothing = { numerator: 0, denominator: 0, bp: null };
const line = (over: object) => ({ code: 'x', forWhom: 'Vendeur', label: 'Engagement inventé', source: 's', measurable: true, kept: nothing, pending: 0, inTrial: 0, setAside: 0, blindSpot: null, missedDays: [], ...over });
const PROMISES = {
  month: '2027-02',
  lines: [
    line({ label: 'Point chaque lundi', kept: { numerator: 3, denominator: 4, bp: 7500 }, missedDays: ['2027-02-08'], pending: 1, inTrial: 2, setAside: 1, blindSpot: 'Un angle mort inventé.' }),
    line({ label: 'Rappelé le jour même' }),
    line({ label: 'Alerte dans l’heure', measurable: false, kept: nothing }),
  ],
  overall: { numerator: 3, denominator: 4, bp: 7500 },
};
const NOT_CONNECTED = { month: '2027-02', connected: false, targetPercent: 99.9, services: ['site', 'api', 'application'].map((service) => ({ service, measured: false, reason: 'not_connected' })) };

async function run(role: 'agent' | 'direction', answers: Record<string, Answer> = {}) {
  clock = Date.parse('2027-03-03T10:00:00.000Z');
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role, firstName: null }),
    'GET /v1/pilotage/rapport-matin': ok(null),
    'GET /v1/pilotage/preuve': no(503, {}),
    'GET /v1/pilotage/preuve/sceaux': no(503, {}),
    'GET /v1/pilotage/parcours?du=2027-02-01&au=2027-02-28': no(503, {}),
    'GET /v1/pilotage/agents-actifs?mois=2027-02': no(503, {}),
    'GET /v1/pilotage/contacts-par-zone?mois=2027-02': no(503, {}),
    [ENG]: ok(PROMISES),
    [NET]: ok({ week: WEEK, declared: 2, notDeclared: 1, minutes: 150, withoutGesture: 1 }),
    [DISPO]: ok(NOT_CONNECTED),
    [MINE]: ok({ week: WEEK, minutes: null, version: null, gestures: 4 }),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: init.body } : {}) });
      const a = table[`${method} ${url}`];
      return a ? a(init.body) : Promise.reject(new TypeError('hors ligne'));
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
  const state = (id: string) => els[`${id}-etat`]!.textContent;
  const reread = async () => {
    els[`rapport-${role}-lire`]!.listeners.click!({});
    await settle();
  };
  const declare = async (value: string) => {
    const nodes = els['temps-agent-corps']!.all();
    nodes.find((e) => e.tagName === 'input')!.value = value;
    nodes.find((e) => e.tagName === 'button')!.listeners.click!({});
    await settle();
  };
  const formState = () => els['temps-agent-corps']!.all().find((e) => e.attributes.role === 'status')!.textContent;
  return { els, calls, table, texts, state, reread, declare, formState };
}

describe('IN10 · engagements, temps gagné et disponibilité à l’écran', () => {
  it('[R216] la direction lit chaque engagement : tenu, manqué, en attente, en essai, écarté, et ce qui n’est pas mesurable, jamais zéro', async () => {
    const t = await run('direction');
    expect(t.state('engagements')).toBe('février 2027. Tenus au total : 75 % (3 sur 4).');
    const text = t.texts('engagements');
    expect(text).toContain('Tenu : 75 % (3 sur 4).');
    expect(text).toContain('Manqué le 08/02/2027.');
    expect(text).toContain('1 cas dont le délai court encore');
    expect(text).toContain('2 cas faits à temps, restés en essai');
    expect(text).toContain('1 cas écarté du calcul');
    expect(text).toContain('Un angle mort inventé.');
    expect(text).toContain('Tenu : pas de donnée sur ce mois.');
    expect(text).toContain('Pas encore mesurable');
    expect(text).not.toMatch(/\b0 %/);
    const none = await run('direction', { [ENG]: ok({ ...PROMISES, lines: [], overall: nothing }) });
    expect(none.state('engagements')).toBe('février 2027. Aucun cas jugé sur ce mois.');
  });

  it('[R217] [R14] la direction lit le temps gagné en comptes, sans nom ; personne n’a déclaré : rien, jamais zéro', async () => {
    const t = await run('direction');
    expect(t.state('temps-reseau')).toContain('Semaine du 22/02/2027.');
    const text = t.texts('temps-reseau');
    expect(text).toContain('2 h 30 gagnées, selon 2 agents.');
    expect(text).toContain('1 agent n’a pas déclaré.');
    expect(text).toContain('1 déclaration sans aucun geste au journal');
    const none = await run('direction', { [NET]: ok({ week: WEEK, declared: 0, notDeclared: 3, minutes: null, withoutGesture: 0 }) });
    expect(none.state('temps-reseau')).toContain('Personne n’a déclaré.');
    expect(none.texts('temps-reseau')).not.toMatch(/gagnées|0 h/);
  });

  it('[R223] sans supervision : « non mesuré » pour chaque service, jamais 100 %', async () => {
    const t = await run('direction');
    expect(t.state('disponibilite')).toBe('février 2027. Non mesuré : aucune supervision n’est branchée.');
    const text = t.texts('disponibilite');
    expect(text).toContain('Le site : non mesuré, aucune supervision branchée.');
    expect(text).toContain('L’API : non mesuré');
    expect(text).toContain('L’application : non mesuré');
    expect(text).not.toContain('%');
  });

  it('[R223] avec une supervision : la part, la coupure, et la cible dite tenue, manquée ou impossible à dire', async () => {
    const m = { measured: true, monthMs: 1, observedMs: 1, answeredMs: 1, complete: true };
    const t = await run('direction', {
      [DISPO]: ok({
        month: '2027-02',
        connected: true,
        targetPercent: 99.9,
        services: [
          { ...m, service: 'site', downMs: 60_000, percent: 99.997, targetMet: true },
          { ...m, service: 'api', downMs: 90_000, percent: 99.5, targetMet: false },
          { ...m, service: 'application', downMs: 0, percent: 100, complete: false, targetMet: null },
        ],
      }),
    });
    expect(t.state('disponibilite')).toBe('février 2027.');
    const text = t.texts('disponibilite');
    expect(text).toContain('Le site : 99,997 %, 1 min de coupure, cible de 99,9 % tenue.');
    expect(text).toContain('L’API : 99,5 %, 2 min de coupure, cible de 99,9 % manquée.');
    expect(text).toContain('L’application : 100 %, mois connu en partie : cible de 99,9 % impossible à dire tenue.');
    const partial = await run('direction', { [DISPO]: ok({ month: '2027-02', connected: true, targetPercent: 99.9, services: [{ ...m, service: 'site', downMs: 7_200_000, percent: 97.222, complete: false, targetMet: false }] }) });
    expect(partial.texts('disponibilite')).toContain('Le site : 97,222 %, 120 min de coupure, mois connu en partie : cible de 99,9 % manquée.');
    const failed = await run('direction', { [DISPO]: ok({ ...NOT_CONNECTED, connected: true, services: [{ service: 'site', measured: false, reason: 'supervision_failed' }, { service: 'api', measured: false, reason: 'bad_data' }, { service: 'application', measured: false, reason: 'nothing_observed' }] }) });
    expect(failed.texts('disponibilite')).toContain('la supervision ne répond pas');
    expect(failed.texts('disponibilite')).toContain('ses données ne tiennent pas');
    expect(failed.texts('disponibilite')).toContain('rien d’observé');
  });

  it('[R217] l’agent lit « non déclarée », jamais zéro, puis déclare ses heures de la semaine finie', async () => {
    let declared: unknown = null;
    const t = await run('agent', {
      [DECLARE]: async (body) => {
        declared = JSON.parse(body!);
        t.table[MINE] = ok({ week: WEEK, minutes: 150, version: 1, gestures: 4 });
        return Response.json({ ok: true, data: {} });
      },
    });
    expect(t.state('temps-agent')).toBe('Semaine du 22/02/2027 : non déclarée.');
    expect(t.texts('temps-agent')).toContain('4 gestes à votre nom');
    await t.declare('2,5');
    expect(declared).toEqual({ week: WEEK, minutes: 150 });
    expect(t.state('temps-agent')).toBe('Déclaration rangée. Semaine du 22/02/2027 : 2 h 30 déclarées.');
  });

  it('[R217] une heure mal écrite ou de plus de 80 heures n’envoie rien ; un refus du serveur est dit ; une déclaration à zéro passe', async () => {
    let posts = 0;
    const t = await run('agent', { [DECLARE]: async () => { posts += 1; return Response.json({ ok: false, rule: 'R217', code: 'week_before_entry' }, { status: 409 }); } });
    for (const bad of ['', 'beaucoup', '80,5', '-1', '100']) {
      await t.declare(bad);
      expect(t.formState()).toContain('Entre 0 et 80 heures');
    }
    expect(posts).toBe(0);
    await t.declare('0');
    expect(posts).toBe(1);
    expect(t.calls.filter((c) => c.method === 'POST').at(-1)!.body).toBe(JSON.stringify({ week: WEEK, minutes: 0 }));
    expect(t.formState()).toContain('d’avant votre entrée');
  });

  it('[R13] une réponse perdue à la déclaration est dite telle : peut-être rangée, à relire', async () => {
    const lost = await run('agent', { [DECLARE]: async () => { throw new TypeError('hors ligne'); } });
    await lost.declare('2');
    expect(lost.formState()).toContain('Réponse perdue : votre déclaration est peut-être rangée');
    const broken = await run('agent', { [DECLARE]: no(500, {}) });
    await broken.declare('2');
    expect(broken.formState()).toContain('Réponse perdue');
    expect(broken.state('temps-agent')).toContain('non déclarée');
    expect(broken.els['temps-agent-corps']!.all().find((e) => e.tagName === 'input')!.value).toBe('2');
  });

  it('[R16] [R217] un refus du serveur n’est pas une réponse perdue : rien n’est rangé, et c’est dit', async () => {
    const refused = await run('agent', { [DECLARE]: no(403, { ok: false, rule: 'R16', code: 'agent_file_incomplete' }) });
    await refused.declare('2');
    expect(refused.formState()).toBe('Ce n’est pas dans vos droits.');
    const odd = await run('agent', { [DECLARE]: no(400, { ok: false, rule: null, code: 'bad_week' }) });
    await odd.declare('2');
    expect(odd.formState()).toContain('Refusé : rien n’est rangé');
    expect(odd.formState()).not.toContain('perdue');
  });

  it('[R217] déclaration rangée puis relecture en panne : « rangée » reste dit', async () => {
    const t = await run('agent', {
      [DECLARE]: async () => {
        t.table[MINE] = no(500, {});
        return Response.json({ ok: true, data: {} });
      },
    });
    await t.declare('2');
    expect(t.state('temps-agent')).toContain('Déclaration rangée.');
    expect(t.state('temps-agent')).toContain('Indisponible');
  });

  it('[R217] deux appuis sur « Déclarer » : un seul envoi en vol', async () => {
    let posts = 0;
    const t = await run('agent', { [DECLARE]: () => { posts += 1; return new Promise(() => {}); } });
    await t.declare('2');
    await t.declare('2');
    expect(posts).toBe(1);
  });

  it('[R217] formulaire remplacé pendant l’envoi : l’échec se dit quand même', async () => {
    let fail: (r: Response) => void = () => {};
    const t = await run('agent', { [DECLARE]: () => new Promise((r) => { fail = r; }) });
    await t.declare('2');
    await t.reread();
    fail(Response.json({ ok: false, rule: 'R217', code: 'week_before_entry' }, { status: 409 }));
    await settle();
    expect(t.state('temps-agent')).toContain('d’avant votre entrée');
  });

  it('[R223] deux lectures qui se croisent : la réponse en retard n’écrase pas la plus récente', async () => {
    const t = await run('direction');
    let first: (r: Response) => void = () => {};
    t.table[DISPO] = () => new Promise((r) => { first = r; });
    await t.reread();
    t.table[DISPO] = ok({ ...NOT_CONNECTED, connected: true, services: [{ service: 'site', measured: false, reason: 'bad_data' }] });
    await t.reread();
    expect(t.texts('disponibilite')).toContain('ses données ne tiennent pas');
    first(Response.json({ ok: true, data: NOT_CONNECTED }));
    await settle();
    expect(t.texts('disponibilite')).toContain('ses données ne tiennent pas');
    expect(t.texts('disponibilite')).not.toContain('aucune supervision');
  });

  it('[R16] [R68] l’agent n’appelle aucune route de la direction, la direction ne déclare rien', async () => {
    const a = await run('agent');
    expect(a.calls.filter((c) => /engagements-tenus|temps-gagne\/reseau|disponibilite/.test(c.url))).toEqual([]);
    const d = await run('direction');
    expect(d.calls.filter((c) => c.url.startsWith('/v1/pilotage/temps-gagne?') || c.method === 'POST')).toEqual([]);
  });

  it('[R16] droits refusés, réseau perdu, panne : dits tels, sans chiffres, jamais zéro, et chaque bloc tient seul', async () => {
    const refused = await run('direction', { [ENG]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    expect(refused.state('engagements')).toContain('pas dans vos droits');
    expect(refused.els['engagements-corps']!.children).toEqual([]);
    expect(refused.texts('disponibilite')).toContain('non mesuré');
    const lost = await run('direction', { [DISPO]: async () => { throw new TypeError('hors ligne'); } });
    expect(lost.state('disponibilite')).toContain('Pas de réseau');
    expect(lost.els['disponibilite-corps']!.children).toEqual([]);
    expect(lost.state('engagements')).toContain('Tenus au total');
    const broken = await run('agent', { [MINE]: no(500, {}) });
    expect(broken.state('temps-agent')).toContain('Indisponible');
    expect(broken.els['temps-agent-corps']!.children).toEqual([]);
  });

  it('[R217] la semaine finie est celle de Paris : le dimanche 28 février à 23 h 30 UTC, on est déjà lundi, la semaine du 22 est finie', async () => {
    const t = await run('agent');
    clock = Date.parse('2027-02-28T22:30:00.000Z');
    t.table['GET /v1/pilotage/temps-gagne?semaine=2027-02-15'] = ok({ week: '2027-02-15', minutes: null, version: null, gestures: 0 });
    await t.reread();
    expect(t.state('temps-agent')).toContain('Semaine du 15/02/2027');
    clock = Date.parse('2027-02-28T23:30:00.000Z');
    await t.reread();
    expect(t.state('temps-agent')).toContain('Semaine du 22/02/2027');
  });

  it('[R16] à la déconnexion tout disparaît ; une réponse en vol n’y revient pas', async () => {
    const t = await run('direction');
    let answer: (r: Response) => void = () => {};
    t.table[DISPO] = () => new Promise((r) => { answer = r; });
    await t.reread();
    t.els.sortir!.listeners.click!({});
    await settle();
    for (const id of ['engagements', 'temps-reseau', 'disponibilite']) {
      expect(t.els[`${id}-corps`]!.children).toEqual([]);
      expect(t.state(id)).toBe('');
    }
    answer(Response.json({ ok: true, data: NOT_CONNECTED }));
    await settle();
    expect(t.els['disponibilite-corps']!.children).toEqual([]);
    expect(t.state('disponibilite')).toBe('');
    const a = await run('agent');
    let late: (r: Response) => void = () => {};
    a.table[DECLARE] = () => new Promise((r) => { late = r; });
    await a.declare('2');
    a.els.sortir!.listeners.click!({});
    await settle();
    late(Response.json({ ok: true, data: {} }));
    await settle();
    expect(a.els['temps-agent-corps']!.children).toEqual([]);
    expect(a.state('temps-agent')).toBe('');
  });

  it('[R201] les budgets tiennent', () => {
    expect(budgetProblems({ html: '', js: FINANCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });
});
