import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { FINANCES_SCRIPT } from '../app/finances.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, fiches, agent. L'horloge : le mercredi 3 mars 2027.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = (body?: string) => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const NOW = Date.parse('2027-03-03T10:00:00.000Z');
class Clock extends Date {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW);
    else super(...(args as [string]));
  }
  static override now(): number {
    return NOW;
  }
}
const off = (e: FakeElement): unknown => (e as FakeElement & { disabled?: boolean }).disabled;
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const READ = 'GET /v1/pilotage/engagements-manques';
const close = (id: string) => `POST /v1/pilotage/engagements-manques/${id}/fait`;
const task = (over: object) => ({ id: 't1', code: 'point_lundi', label: 'Point chaque lundi', day: '2027-02-08', personId: 'fiche1', agentId: null, agentName: null, doNotCall: false, ...over });
const LIST = { total: 3, tasks: [task({}), task({ id: 't2', personId: 'fiche2', doNotCall: true }), task({ id: 't3', code: 'commission_24h', label: 'Commission versée sous 24 h', personId: null, agentId: 'agent1', agentName: 'Inès Inventée' })] };
const EMPTY = { total: 0, tasks: [] };
const FICHE = { personId: 'fiche1', firstName: 'Léa', lastName: 'Inventée', contact: { allowed: true, reasons: [] }, call: null, projects: [], sources: [], consents: [], messages: [], callbacks: [] };

async function run(answers: Record<string, Answer> = {}, role: 'direction' | 'agent' = 'direction') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role, firstName: null }),
    'GET /v1/pilotage/rapport-matin': ok(null),
    [READ]: ok(LIST),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: init.body } : {}) });
      const a = table[`${method} ${url}`];
      return a ? a(init.body) : Promise.resolve(Response.json({}, { status: 503 }));
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
  const host = els[role === 'agent' ? 'chiffres' : 'reseau']!;
  const s = host.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/finances.js');
  runInNewContext(FINANCES_SCRIPT, context);
  s[0]!.listeners.load!({});
  await settle();
  const body = () => els['engagements-manques-corps']!;
  const text = () => body().all().map((e) => e.textContent).join(' | ');
  const state = () => els['engagements-manques-etat']!.textContent;
  const line = (i: number) => body().all().filter((e) => e.tagName === 'li')[i]!;
  const buttons = (i: number) => line(i).all().filter((e) => e.tagName === 'button');
  const names = (i: number) => buttons(i).map((b) => b.textContent);
  const press = async (i: number, name: string) => {
    buttons(i).find((b) => b.textContent === name)!.listeners.click!({});
    await settle();
  };
  const reread = async () => {
    els['rapport-direction-lire']!.listeners.click!({});
    await settle();
  };
  const backButton = () => els.fiche!.children.find((c) => c.textContent === 'Retour au réseau');
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, storage, text, state, body, line, buttons, names, press, reread, posts, backButton };
}

describe('IN15 · les engagements manqués à rappeler, à l’écran', () => {
  it('[R228] la direction lit chaque rappel, son engagement et son jour, et le compte', async () => {
    const t = await run();
    expect(t.state()).toBe('3 rappels à faire.');
    expect(t.text()).toContain('Point chaque lundi');
    expect(t.text()).toContain('Manqué le 08/02/2027.');
    expect(t.names(0)).toEqual(['Voir la fiche', 'Rappelé', 'Injoignable', 'Sans appel']);
  });

  it('[R228] rien à rappeler : c’est dit, sans liste', async () => {
    const t = await run({ [READ]: ok(EMPTY) });
    expect(t.state()).toBe('Aucun rappel à faire.');
    expect(t.body().children).toEqual([]);
  });

  it('[R228] plus de rappels que la page : le total reste vrai, et c’est dit', async () => {
    const t = await run({ [READ]: ok({ total: 250, tasks: [task({}), task({ id: 't2' })] }) });
    expect(t.state()).toBe('250 rappels à faire. Les 2 plus anciens sont ici.');
  });

  it('[R02] [R228] une personne exclue : « ne pas appeler », sans bouton « Rappelé » ni « Injoignable »', async () => {
    const t = await run();
    expect(t.line(1).all().map((e) => e.textContent).join(' ')).toContain('Ne pas appeler');
    expect(t.names(1)).toEqual(['Voir la fiche', 'Sans appel']);
    t.table[close('t2')] = ok({ id: 't2', outcome: 'sans_appel' });
    await t.press(1, 'Sans appel');
    expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ outcome: 'sans_appel' });
  });

  it('[R02] exclue depuis la lecture : le serveur refuse, c’est dit, et la ligne relue n’a plus le bouton', async () => {
    const t = await run();
    t.table[close('t1')] = no(409, { ok: false, rule: 'R02', code: 'do_not_call' });
    t.table[READ] = ok({ total: 1, tasks: [task({ doNotCall: true })] });
    await t.press(0, 'Rappelé');
    expect(t.state()).toContain('ne doit plus être appelée : rien n’est noté');
    expect(t.names(0)).toEqual(['Voir la fiche', 'Sans appel']);
  });

  it('[R228] un engagement envers l’agent : son nom, sans fiche de client ; un cas sans personne ne se note que « sans appel »', async () => {
    const t = await run();
    expect(t.line(2).all().map((e) => e.textContent).join(' ')).toContain('À rappeler : l’agent Inès Inventée.');
    expect(t.names(2)).toEqual(['Rappelé', 'Injoignable', 'Sans appel']);
    const nobody = await run({ [READ]: ok({ total: 2, tasks: [task({ personId: null }), task({ id: 't2', personId: null, agentId: 'a' })] }) });
    expect(nobody.names(0)).toEqual(['Sans appel']);
    expect(nobody.text()).toContain('ne désigne personne');
    expect(nobody.text()).toContain('un agent dont le nom manque');
  });

  it('[R16] la fiche s’ouvre par son écran et ses droits, et aucune donnée de personne n’est lue d’avance', async () => {
    const t = await run();
    expect(t.calls.filter((c) => c.url.startsWith('/v1/fiches/'))).toEqual([]);
    t.table['GET /v1/fiches/fiche1/resume'] = no(403, { ok: false, rule: 'R16', code: 'role' });
    await t.press(0, 'Voir la fiche');
    expect(t.calls.filter((c) => c.url === '/v1/fiches/fiche1/resume')).toHaveLength(1);
    expect(t.els.fiche!.hidden).toBe(false);
    expect(t.els['fiche-etat']!.textContent).toContain('pas dans vos droits');
  });

  it('[R16] la direction revient de la fiche au réseau : sa clé reste, la fiche s’efface, la liste est relue, sans lire aucune journée d’agent', async () => {
    const t = await run({ 'GET /v1/plan-du-jour': no(403, { ok: false, rule: 'R16', code: 'not_agent' }), 'GET /v1/fiches/fiche1/resume': ok(FICHE) });
    await t.press(0, 'Voir la fiche');
    expect(t.els.fiche!.hidden).toBe(false);
    expect(t.els['fiche-nom']!.textContent).toContain('Inventée');
    expect(t.els.retour!.hidden).toBe(true);
    const before = t.calls.filter((c) => c.url === '/v1/pilotage/engagements-manques').length;
    t.table[READ] = ok(EMPTY);
    t.backButton()!.listeners.click!({});
    await settle();
    expect(t.storage.get('aimmo.cle')).toBe(KEY);
    expect(t.els.reseau!.hidden).toBe(false);
    expect(t.els.fiche!.hidden).toBe(true);
    expect(t.els['fiche-corps']!.children).toEqual([]);
    expect(t.els['fiche-nom']!.textContent).toBe('');
    expect(t.backButton()).toBeUndefined();
    expect(t.els.retour!.hidden).toBe(false);
    expect(t.calls.filter((c) => c.url === '/v1/plan-du-jour')).toEqual([]);
    expect(t.calls.filter((c) => c.url === '/v1/pilotage/engagements-manques')).toHaveLength(before + 1);
    expect(t.state()).toBe('Aucun rappel à faire.');
  });

  it('[R228] un geste encore en vol quand on revient de la fiche : la liste relue dit la vérité, rien n’est envoyé deux fois', async () => {
    const t = await run({ 'GET /v1/fiches/fiche1/resume': ok(FICHE) });
    let done: (r: Response) => void = () => {};
    t.table[close('t1')] = () => new Promise((r) => { done = r; });
    await t.press(0, 'Rappelé');
    await t.press(0, 'Voir la fiche');
    t.table[READ] = ok(LIST);
    t.backButton()!.listeners.click!({});
    await settle();
    expect(t.state()).toBe('3 rappels à faire.');
    done(Response.json({ ok: true, data: { id: 't1', outcome: 'rappele' } }));
    await settle();
    expect(t.state()).toBe('3 rappels à faire.');
    expect(t.posts()).toHaveLength(1);
  });

  it('[R16] se déconnecter depuis la fiche : le bouton du réseau disparaît, la prochaine fiche a son retour habituel', async () => {
    const t = await run({ 'GET /v1/fiches/fiche1/resume': ok(FICHE) });
    await t.press(0, 'Voir la fiche');
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.backButton()).toBeUndefined();
    expect(t.els.retour!.hidden).toBe(false);
  });

  it('[R228] un geste : l’issue est envoyée, dite, et la liste relue', async () => {
    for (const [name, outcome, said] of [['Rappelé', 'rappele', 'Rappel noté.'], ['Injoignable', 'injoignable', 'Noté : injoignable.'], ['Sans appel', 'sans_appel', 'Noté : sans appel.']] as const) {
      const t = await run();
      t.table[close('t1')] = ok({ id: 't1', outcome });
      t.table[READ] = ok(EMPTY);
      await t.press(0, name);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ outcome });
      expect(t.state()).toBe(`${said} Aucun rappel à faire.`);
      expect(t.body().children).toEqual([]);
    }
  });

  it('[R228] geste noté puis relecture en panne : « noté » reste dit', async () => {
    const t = await run();
    t.table[close('t1')] = ok({ id: 't1', outcome: 'rappele' });
    t.table[READ] = no(500, {});
    await t.press(0, 'Rappelé');
    expect(t.state()).toContain('Rappel noté.');
    expect(t.state()).toContain('Indisponible');
  });

  it('[R228] fermé autrement par quelqu’un d’autre : dit, et la liste relue', async () => {
    const t = await run();
    t.table[close('t1')] = no(409, { ok: false, rule: 'R228', code: 'already_done' });
    t.table[READ] = ok(EMPTY);
    await t.press(0, 'Injoignable');
    expect(t.state()).toBe('Ce rappel est déjà fermé autrement : rien n’est changé. Aucun rappel à faire.');
  });

  it('[R16] droits refusés, à la lecture comme au geste : dits tels, sans liste à la lecture', async () => {
    const read = await run({ [READ]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    expect(read.state()).toContain('pas dans vos droits');
    expect(read.body().children).toEqual([]);
    const gesture = await run();
    gesture.table[close('t1')] = no(403, { ok: false, rule: 'R16', code: 'role' });
    await gesture.press(0, 'Rappelé');
    expect(gesture.state()).toContain('pas dans vos droits');
    expect(gesture.state()).not.toContain('perdue');
    expect(gesture.names(0)).toContain('Rappelé');
  });

  it('[R16] l’agent n’appelle jamais cette route', async () => {
    const t = await run({}, 'agent');
    expect(t.calls.filter((c) => c.url.includes('engagements-manques'))).toEqual([]);
  });

  it('[R228] réponse perdue, réseau ou panne : dite telle, peut-être noté, et le geste redevient possible', async () => {
    for (const answer of [async () => { throw new TypeError('hors ligne'); }, no(500, {}), no(502, { ok: false, code: 'x' })] as Answer[]) {
      const t = await run();
      t.table[close('t1')] = answer;
      await t.press(0, 'Rappelé');
      expect(t.state()).toBe('Réponse perdue : ce geste est peut-être noté. Relisez avant de recommencer.');
      expect(off(t.buttons(0).find((b) => b.textContent === 'Rappelé')!)).toBe(false);
      expect(t.text()).toContain('Point chaque lundi');
    }
  });

  it('[R228] un refus sans raison connue n’est pas une réponse perdue : rien n’est noté', async () => {
    const t = await run();
    t.table[close('t1')] = no(404, { ok: false, rule: null, code: 'unknown_task' });
    await t.press(0, 'Rappelé');
    expect(t.state()).toContain('Refusé : rien n’est noté');
    expect(t.state()).not.toContain('perdue');
  });

  it('[R228] deux appuis, sur la même ligne ou sur une autre : un seul envoi en vol, les gestes sont éteints', async () => {
    const t = await run();
    t.table[close('t1')] = () => new Promise(() => {});
    t.table[close('t3')] = () => new Promise(() => {});
    await t.press(0, 'Rappelé');
    expect(t.state()).toBe('Envoi…');
    await t.press(0, 'Injoignable');
    await t.press(2, 'Rappelé');
    expect(t.posts()).toHaveLength(1);
    expect(t.buttons(2).every((b) => off(b) === true)).toBe(true);
    expect(off(t.buttons(0).find((b) => b.textContent === 'Voir la fiche')!)).toBeFalsy();
  });

  it('[R228] liste relue pendant l’envoi : les gestes restent éteints, et l’échec se dit, sans que la relecture l’efface', async () => {
    const t = await run();
    let fail: (r: Response) => void = () => {};
    t.table[close('t1')] = () => new Promise((r) => { fail = r; });
    await t.press(0, 'Rappelé');
    await t.reread();
    expect(off(t.buttons(0).find((b) => b.textContent === 'Rappelé')!)).toBe(true);
    let lateRead: (r: Response) => void = () => {};
    t.table[READ] = () => new Promise((r) => { lateRead = r; });
    await t.reread();
    fail(Response.json({}, { status: 500 }));
    await settle();
    expect(t.state()).toContain('Réponse perdue');
    lateRead(Response.json({ ok: true, data: EMPTY }));
    await settle();
    expect(t.state()).toContain('Réponse perdue');
  });

  it('[R228] deux lectures qui se croisent : la réponse en retard n’écrase pas la plus récente', async () => {
    const t = await run();
    let first: (r: Response) => void = () => {};
    t.table[READ] = () => new Promise((r) => { first = r; });
    await t.reread();
    t.table[READ] = ok(EMPTY);
    await t.reread();
    first(Response.json({ ok: true, data: LIST }));
    await settle();
    expect(t.state()).toBe('Aucun rappel à faire.');
  });

  it('[R16] à la déconnexion tout disparaît ; une lecture ou un geste en vol n’y revient pas', async () => {
    const t = await run();
    let read: (r: Response) => void = () => {};
    t.table[READ] = () => new Promise((r) => { read = r; });
    await t.reread();
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
    read(Response.json({ ok: true, data: LIST }));
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');

    const g = await run();
    let done: (r: Response) => void = () => {};
    g.table[close('t1')] = () => new Promise((r) => { done = r; });
    await g.press(0, 'Rappelé');
    g.els.sortir!.listeners.click!({});
    await settle();
    done(Response.json({ ok: true, data: { id: 't1', outcome: 'rappele' } }));
    await settle();
    expect(g.body().children).toEqual([]);
    expect(g.state()).toBe('');
    expect(g.calls.filter((c) => c.url === '/v1/pilotage/engagements-manques')).toHaveLength(1);
  });

  it('[R201] les budgets tiennent', () => {
    expect(budgetProblems({ html: '', js: FINANCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });
});
