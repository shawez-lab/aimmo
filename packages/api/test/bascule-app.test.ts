import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { BASCULE_SCRIPT } from '../app/bascule.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, chiffres.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const VIEWS = [
  { automation: 'rappel_visite', stage: 'shadow', since: '2026-10-20T08:00:00.000Z', requests: 37, daysLeft: 2, lastIncidentAt: '2026-10-20T08:00:00.000Z', lastIncidentKind: 'unexplained_gap' },
  { automation: 'courrier_vendeur', stage: 'ten_percent', since: '2026-10-25T08:00:00.000Z', requests: 11, daysLeft: 0, lastIncidentAt: null, lastIncidentKind: null },
];
let clock = 0;
class Clock extends Date {
  static override now(): number {
    return clock;
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { 'GET /v1/moi': ok({ role: 'direction', firstName: null }), 'GET /v1/automatisations/paliers': ok(VIEWS), ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, auth: init.headers?.authorization });
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
  const body = () => els['bascule-corps']!;
  const state = () => els['bascule-etat']!.textContent;
  const buttons = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const load = async () => {
    const s = els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/bascule.js');
    if (s.length === 1 && !context.loadedBascule) {
      runInNewContext(BASCULE_SCRIPT, context);
      context.loadedBascule = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const voir = async () => {
    await click(els['bascule-voir']);
    await load();
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  /** Deux appuis espacés sur le bouton de passage. */
  const passer = async () => {
    const b = buttons('Passer à 10 %')[0];
    await click(b);
    clock += 2000;
    await click(b);
  };
  return { els, calls, table, click, body, buttons, texts, state, voir, load, posts, passer };
}

describe('B05 · la bascule sur l’écran du réseau', () => {
  it('[R16] [R26] la direction lit le palier, les nombres et le dernier retour en ombre, par les seules routes prévues', async () => {
    const t = await run();
    const before = t.calls.length;
    await t.voir();
    expect(t.texts()).toContain('Rappel de la visite d’estimation');
    expect(t.texts()).toContain('En ombre : le site décide seul');
    expect(t.texts()).toContain('37 demande(s) comptée(s)');
    expect(t.texts()).toContain('Encore 2 jours');
    expect(t.texts()).toContain('Dernier retour en ombre le 20/10/2026, après un écart non expliqué.');
    expect(t.texts()).toContain('À 10 % : le socle décide pour un envoi sur dix.');
    for (const c of t.calls.slice(before)) {
      expect(['/v1/automatisations/paliers']).toContain(c.url);
      expect(c.auth).toBe(`Bearer ${KEY}`);
    }
    // Le passage n'est proposé qu'en ombre : ni à 10 %, ni partout.
    expect(t.buttons('Passer à 10 %')).toHaveLength(1);
  });

  it('[R26] une automatisation jamais appelée n’annonce pas de durée, et reste proposée au serveur qui décide', async () => {
    const t = await run({ 'GET /v1/automatisations/paliers': ok([{ automation: 'rappel_visite', stage: 'shadow', since: null, requests: 0, daysLeft: 7, lastIncidentAt: null, lastIncidentKind: null }]) });
    await t.voir();
    expect(t.texts()).toContain('Aucune demande reçue pour le moment.');
    expect(t.texts()).not.toContain('Encore');
    expect(t.texts()).not.toContain('retour en ombre');
  });

  it('[R26] passer à 10 % demande deux appuis espacés, un double appui ne passe pas, et sans suite la demande retombe', async () => {
    const t = await run({ 'POST /v1/automatisations/paliers/rappel_visite/avancer': ok({ stage: 'ten_percent' }) });
    await t.voir();
    const b = t.buttons('Passer à 10 %')[0]!;
    await t.click(b);
    expect(t.state()).toContain('Appuyez de nouveau pour confirmer');
    expect(b.textContent).toBe('Confirmer : passer à 10 %');
    await t.click(b);
    expect(t.posts()).toEqual([]);
    clock += 16000;
    await t.click(b);
    expect(t.posts()).toEqual([]);
    clock += 2000;
    t.table['GET /v1/automatisations/paliers'] = ok([{ ...VIEWS[0], stage: 'ten_percent' }]);
    await t.click(b);
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/automatisations/paliers/rappel_visite/avancer']);
    expect(t.state()).toContain('Passé à 10 %');
    expect(t.buttons('Passer à 10 %')).toEqual([]);
  });

  it.each([
    ['not_open', 'Le passage n’est pas encore ouvert'],
    ['too_early', 'n’a pas encore duré 7 jours'],
    ['not_enough_requests', 'Trop peu de demandes'],
    ['role', 'pas dans vos droits'],
  ])('[R26] le refus %s est dit en français, et rien ne bouge à l’écran', async (code, said) => {
    const t = await run({ 'POST /v1/automatisations/paliers/rappel_visite/avancer': no(409, { ok: false, rule: 'R26', code }) });
    await t.voir();
    await t.passer();
    expect(t.state()).toContain(said);
    expect(t.state()).not.toContain(code);
    expect(t.texts()).toContain('En ombre');
  });

  it('une automatisation qui n’est plus en ombre : l’écran est relu', async () => {
    const t = await run({ 'POST /v1/automatisations/paliers/rappel_visite/avancer': no(409, { ok: false, rule: 'R26', code: 'not_in_shadow' }) });
    await t.voir();
    t.table['GET /v1/automatisations/paliers'] = ok([{ ...VIEWS[0], stage: 'everywhere' }]);
    await t.passer();
    expect(t.state()).toContain('n’est plus en ombre');
    expect(t.texts()).toContain('Partout');
    expect(t.buttons('Passer à 10 %')).toEqual([]);
  });

  it('[R13] le journal : intact en nombres, abîmé sans rien de son contenu', async () => {
    const t = await run({ 'GET /v1/journal/verification': ok({ ok: true, lines: 412 }) });
    await t.click(t.els['bascule-journal']);
    await t.load();
    expect(t.state()).toBe('Journal intact : 412 ligne(s) vérifiée(s).');
    t.table['GET /v1/journal/verification'] = ok({ ok: false, brokenAt: 7, reason: 'détail technique inventé', lines: 412 });
    await t.click(t.els['bascule-journal']);
    expect(t.state()).toContain('Journal abîmé à la ligne 7');
    expect(t.state()).not.toContain('détail technique');
    t.table['GET /v1/journal/verification'] = no(403, { ok: false, rule: 'R16', code: 'role' });
    await t.click(t.els['bascule-journal']);
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
  });

  it('hors réseau, c’est dit ; quitter l’écran du réseau efface ce qu’il montrait', async () => {
    const t = await run();
    await t.voir();
    expect(t.body().children.length).toBeGreaterThan(0);
    t.table['GET /v1/automatisations/paliers'] = async () => Promise.reject(new TypeError('hors ligne'));
    await t.click(t.els['bascule-voir']);
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.body().children).toEqual([]);
    t.table['GET /v1/automatisations/paliers'] = ok(VIEWS);
    await t.click(t.els['bascule-voir']);
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
  });

  it('deux appuis rapides font une seule liste, et un seul chargement du script', async () => {
    const t = await run();
    t.els['bascule-voir']!.listeners.click!({});
    t.els['bascule-voir']!.listeners.click!({});
    await settle();
    expect(t.els.reseau!.children.filter((e) => e.attributes.src === '/app/bascule.js')).toHaveLength(1);
    await t.load();
    t.els['bascule-voir']!.listeners.click!({});
    t.els['bascule-voir']!.listeners.click!({});
    await settle();
    expect(t.body().all().filter((e) => e.tagName === 'ul')).toHaveLength(1);
    expect(t.buttons('Passer à 10 %')).toHaveLength(1);
  });

  it('un script qui ne charge pas, ou arrive abîmé, est dit, et un nouvel appui réessaie', async () => {
    const t = await run();
    await t.click(t.els['bascule-voir']);
    const scripts = () => t.els.reseau!.children.filter((e) => e.attributes.src === '/app/bascule.js');
    scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    await t.click(t.els['bascule-voir']);
    expect(scripts()).toHaveLength(2);
    // Arrivé sans son contenu : `load` part quand même.
    scripts()[1]!.listeners.load!({});
    await settle();
    expect(t.state()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
    await t.click(t.els['bascule-voir']);
    expect(scripts()).toHaveLength(3);
  });

  it('une réponse qui tarde ne bloque pas le geste après une nouvelle connexion', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const t = await run({ 'GET /v1/journal/verification': async () => { await held; return Response.json({ ok: true, data: { ok: true, lines: 1 } }); } });
    await t.click(t.els['bascule-journal']);
    await t.load();
    const asked = () => t.calls.filter((c) => c.url === '/v1/journal/verification').length;
    expect(asked()).toBe(1);
    await t.click(t.els['bascule-journal']);
    expect(asked()).toBe(1);
    t.els.sortir!.listeners.click!({});
    await settle();
    t.els.cle!.value = 'n'.repeat(40);
    t.els['form-connexion']!.listeners.submit!({ preventDefault: () => undefined });
    await settle();
    t.table['GET /v1/journal/verification'] = ok({ ok: true, lines: 2 });
    await t.click(t.els['bascule-journal']);
    expect(asked()).toBe(2);
    expect(t.state()).toBe('Journal intact : 2 ligne(s) vérifiée(s).');
    // L'ancienne réponse, arrivée après, ne touche à rien.
    release();
    await settle();
    expect(t.state()).toBe('Journal intact : 2 ligne(s) vérifiée(s).');
  });

  it('[R201] le script est servi à part, jamais gardé sur l’appareil, et tient son budget ; aucun code de page', async () => {
    expect(AGENT_APP_FILES['/app/bascule.js']).toBe(BASCULE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/bascule.js');
    expect(handleAgentApp(new Request('https://x.test/app/bascule.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: BASCULE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, js: JS }, BUDGETS.application)).toEqual([]);
    expect(BASCULE_SCRIPT).not.toContain('innerHTML');
  });
});
