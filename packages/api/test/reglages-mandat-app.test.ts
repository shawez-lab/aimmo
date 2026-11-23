import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { REGLAGES_MANDAT_SCRIPT } from '../app/reglages-mandat.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, numéros, noms.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const FEES = { maxRatePercent: 5.5, minEur: 3000, setAt: '2027-01-10T08:00:00.000Z' };
const FORMAT = { prefix: 'T-', firstNumber: 1, width: 3, setAt: '2027-01-10T08:00:00.000Z', next: 'T-004' };
const LIVE = { mandateId: 'm1', number: 'T-003', signedAt: '2027-02-10T08:00:00.000Z', agentName: 'Alex Agent', city: 'Villetest', cancelledAt: null, cancelReason: null };
const GONE = { mandateId: 'm2', number: 'T-002', signedAt: '2027-02-01T08:00:00.000Z', agentName: 'Sam Agent', city: null, cancelledAt: '2027-02-03T08:00:00.000Z', cancelReason: 'withdrawal' };
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
  const calls: { method: string; url: string; body: unknown }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    'GET /v1/honoraires/bareme': ok(FEES),
    'GET /v1/registre/reglage': ok(FORMAT),
    'GET /v1/registre/lignes': ok({ entries: [LIVE, GONE], next: null }),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
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
  const body = () => els['regmandat-corps']!;
  const state = () => els['regmandat-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const load = async () => {
    const s = els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/reglages-mandat.js');
    if (s.length === 1 && !context.loaded) {
      runInNewContext(REGLAGES_MANDAT_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const voir = async () => {
    await click(els['regmandat-voir']);
    await load();
  };
  /** Deux appuis espacés. */
  const twice = async (b: FakeElement | undefined) => {
    await click(b);
    clock += 2000;
    await click(b);
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, body, state, texts, find, input, click, load, voir, twice, posts };
}

describe('D13 · réglages du mandat pour la direction', () => {
  it('[R16] la direction lit le barème, le format et les mandats, par les seules routes prévues', async () => {
    const t = await run();
    const before = t.calls.length;
    await t.voir();
    expect(t.texts()).toContain('5,5 % du prix au plus');
    expect(t.texts()).toContain('Prochain numéro : T-004.');
    expect(t.texts()).toContain('T-003');
    expect(t.texts()).toContain('Alex Agent');
    expect(t.texts()).toContain('Annulé le 03/02/2027 : rétractation');
    for (const c of t.calls.slice(before)) expect(['/v1/honoraires/bareme', '/v1/registre/reglage', '/v1/registre/lignes']).toContain(c.url);
    // Aucun identifiant à saisir : seul le mandat vivant a son geste.
    expect(t.find('Annuler ce mandat')).toHaveLength(1);
    expect(t.body().all().some((e) => e.textContent === 'm1')).toBe(false);
  });

  it('[R16] un refus de rôle est dit en français, sans aucun formulaire', async () => {
    const refused = no(403, { ok: false, rule: 'R16', code: 'role' });
    const t = await run({ 'GET /v1/honoraires/bareme': refused, 'GET /v1/registre/reglage': refused, 'GET /v1/registre/lignes': refused });
    await t.voir();
    expect(t.texts()).toContain('Ce n’est pas dans vos droits.');
    expect(t.body().all().filter((e) => e.tagName === 'input' || e.tagName === 'button')).toEqual([]);
  });

  it('[R41] sans barème, l’écran dit que rien ne passe ; le barème part tel que saisi, virgule comprise', async () => {
    const t = await run({ 'GET /v1/honoraires/bareme': ok(null), 'POST /v1/honoraires/bareme': ok(undefined) });
    await t.voir();
    expect(t.texts()).toContain('aucun mandat ne passe ses contrôles');
    t.input('regmandat-taux').value = '5,5';
    t.input('regmandat-minimum').value = '3 000';
    t.table['GET /v1/honoraires/bareme'] = ok(FEES);
    await t.click(t.find('Ranger le barème')[0]);
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/honoraires/bareme', body: { maxRatePercent: 5.5, minEur: 3000 } }]);
    expect(t.state()).toBe('Barème rangé.');
    expect(t.texts()).toContain('5,5 % du prix au plus');
  });

  it('[R41] AU058 · des tranches se saisissent une par ligne, forfait ou taux, et se lisent en vigueur', async () => {
    const tiers = [{ upToEur: 100000, flatEur: 8000 }, { upToEur: 250000, ratePercent: 4 }, { upToEur: null, ratePercent: 3.5 }];
    const t = await run({ 'GET /v1/honoraires/bareme': ok(null), 'POST /v1/honoraires/bareme': ok(undefined) });
    await t.voir();
    t.input('regmandat-taux').value = '10';
    t.input('regmandat-minimum').value = '3000';
    t.input('regmandat-tranches').value = 'Jusqu’à 100 000 : 8 000 €\njusqu’à 250 000 € : 4 %\nAu-delà : 3,5 %';
    t.table['GET /v1/honoraires/bareme'] = ok({ ...FEES, tiers });
    await t.click(t.find('Ranger le barème')[0]);
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/honoraires/bareme', body: { maxRatePercent: 10, minEur: 3000, tiers } }]);
    expect(t.texts()).toContain('Jusqu’à 100');
    expect(t.texts()).toContain('3,5 % du prix au plus');
    // Une ligne illisible : rien ne part, et la forme attendue est dite.
    t.input('regmandat-taux').value = '10';
    t.input('regmandat-minimum').value = '3000';
    t.input('regmandat-tranches').value = 'tout pour moi';
    await t.click(t.find('Ranger le barème')[0]);
    expect(t.posts()).toHaveLength(1);
    expect(t.state()).toContain('Les tranches : une par ligne');
  });

  it('[R41] un barème vide ou illisible ne part pas ; un refus du serveur est dit en français', async () => {
    const t = await run({ 'POST /v1/honoraires/bareme': no(400, { ok: false, code: 'bad_schedule' }) });
    await t.voir();
    await t.click(t.find('Ranger le barème')[0]);
    t.input('regmandat-taux').value = 'cinq';
    t.input('regmandat-minimum').value = '3000';
    await t.click(t.find('Ranger le barème')[0]);
    expect(t.posts()).toEqual([]);
    expect(t.state()).toContain('Le taux : un pourcentage');
    t.input('regmandat-taux').value = '5,555';
    await t.click(t.find('Ranger le barème')[0]);
    expect(t.posts()).toHaveLength(1);
    expect(t.state()).toContain('au centième au plus');
    expect(t.state()).not.toContain('bad_schedule');
  });

  it('[R39] le format réglé est dit définitif, et aucun formulaire ne le propose', async () => {
    const t = await run();
    await t.voir();
    expect(t.texts()).toContain('une fois pour toutes : il ne change plus');
    expect(t.find('Régler le format')).toEqual([]);
    expect(t.body().all().some((e) => e.attributes.id === 'regmandat-prefixe')).toBe(false);
  });

  it('[R39] le format ne se règle qu’une fois : l’écran le dit, montre le premier numéro et demande deux appuis espacés', async () => {
    const t = await run({ 'GET /v1/registre/reglage': ok(null), 'POST /v1/registre/reglage': ok(undefined) });
    await t.voir();
    expect(t.texts()).toContain('ne se règle qu’une seule fois');
    t.input('regmandat-prefixe').value = 'T-';
    t.input('regmandat-premier').value = '7';
    t.input('regmandat-largeur').value = '3';
    const b = t.find('Régler le format')[0]!;
    await t.click(b);
    expect(t.state()).toContain('Le premier mandat portera le numéro T-007');
    expect(t.state()).toContain('Appuyez de nouveau');
    // Un double appui ne passe pas ; une saisie changée redemande la confirmation, avec le nouveau numéro.
    await t.click(b);
    expect(t.posts()).toEqual([]);
    clock += 2000;
    t.input('regmandat-premier').value = '8';
    await t.click(b);
    expect(t.posts()).toEqual([]);
    expect(t.state()).toContain('T-008');
    clock += 2000;
    t.table['GET /v1/registre/reglage'] = ok({ ...FORMAT, next: 'T-008' });
    await t.click(b);
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/registre/reglage', body: { prefix: 'T-', firstNumber: 8, width: 3 } }]);
    expect(t.state()).toContain('il ne change plus');
    expect(t.texts()).toContain('Prochain numéro : T-008.');
  });

  it('[R39] un format déjà réglé par quelqu’un d’autre : dit en français, et l’écran est relu', async () => {
    const t = await run({ 'GET /v1/registre/reglage': ok(null), 'POST /v1/registre/reglage': no(409, { ok: false, code: 'already_configured' }) });
    await t.voir();
    t.input('regmandat-premier').value = '1';
    t.input('regmandat-largeur').value = '3';
    t.table['GET /v1/registre/reglage'] = ok(FORMAT);
    await t.twice(t.find('Régler le format')[0]);
    expect(t.state()).toBe('Le format est déjà réglé : il ne change plus.');
    expect(t.texts()).toContain('Prochain numéro : T-004.');
  });

  it('[R39] un format refusé est dit en français, et ne part pas sans ses nombres', async () => {
    const t = await run({ 'GET /v1/registre/reglage': ok(null), 'POST /v1/registre/reglage': no(400, { ok: false, code: 'bad_settings' }) });
    await t.voir();
    await t.click(t.find('Régler le format')[0]);
    expect(t.posts()).toEqual([]);
    expect(t.state()).toContain('Le préfixe');
    t.input('regmandat-prefixe').value = 'é!';
    t.input('regmandat-premier').value = '1';
    t.input('regmandat-largeur').value = '3';
    await t.twice(t.find('Régler le format')[0]);
    expect(t.posts()).toHaveLength(1);
    expect(t.state()).toContain('Le préfixe');
    expect(t.state()).not.toContain('bad_settings');
  });

  it('[R39] le contrôle : intact en nombres, vide, ou abîmé en français, sans jamais dire intact par défaut', async () => {
    const t = await run({ 'GET /v1/registre/controle': ok({ ok: true, lines: 12 }) });
    await t.click(t.els['regmandat-controle']);
    await t.load();
    expect(t.state()).toBe('Registre intact : 12 ligne(s) vérifiée(s).');
    t.table['GET /v1/registre/controle'] = ok({ ok: true, lines: 0 });
    await t.click(t.els['regmandat-controle']);
    expect(t.state()).toBe('Registre vide : rien à contrôler.');
    t.table['GET /v1/registre/controle'] = ok({ ok: false, lines: 12, brokenAt: 7, problem: 'hash' });
    await t.click(t.els['regmandat-controle']);
    expect(t.state()).toBe('Registre abîmé à la ligne 7 : cette ligne a été modifiée après coup. Ne touchez à rien et prévenez le responsable de la conformité.');
    t.table['GET /v1/registre/controle'] = ok({ ok: false, lines: 12, brokenAt: 7, problem: 'code_inconnu' });
    await t.click(t.els['regmandat-controle']);
    expect(t.state()).toContain('Registre abîmé à la ligne 7 : une anomalie');
    expect(t.state()).not.toContain('code_inconnu');
    t.table['GET /v1/registre/controle'] = ok({ lines: 12 });
    await t.click(t.els['regmandat-controle']);
    expect(t.state()).toContain('Registre abîmé');
    t.table['GET /v1/registre/controle'] = no(403, { ok: false, rule: 'R16', code: 'role' });
    await t.click(t.els['regmandat-controle']);
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
  });

  it('une annulation demande son motif et une confirmation, dit qu’elle rouvre le bien, et relit le registre', async () => {
    const t = await run({ 'POST /v1/mandats/m1/annulation': ok({ number: 'T-003', seq: 9 }) });
    await t.voir();
    const b = t.find('Annuler ce mandat')[0]!;
    await t.click(b);
    expect(t.state()).toBe('Choisissez le motif de l’annulation.');
    expect(b.textContent).toBe('Annuler ce mandat');
    const motif = t.input('regmandat-motif-0');
    expect(motif.children.map((o) => o.value)).toEqual(['', 'error', 'termination']);
    motif.value = 'termination';
    await t.click(b);
    expect(t.state()).toContain('rouvre le bien à un nouveau mandat');
    expect(t.state()).toContain('sa diffusion s’arrête au prochain passage');
    expect(t.state()).toContain('pour résiliation');
    expect(t.state()).toContain('rien n’est effacé');
    expect(t.posts()).toEqual([]);
    await t.click(b);
    expect(t.posts()).toEqual([]);
    // Sans suite, la demande retombe.
    clock += 16000;
    await t.click(b);
    expect(t.posts()).toEqual([]);
    clock += 2000;
    t.table['GET /v1/registre/lignes'] = ok({ entries: [{ ...LIVE, cancelledAt: '2027-03-01T08:00:00.000Z', cancelReason: 'termination' }], next: null });
    await t.click(b);
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/mandats/m1/annulation', body: { reason: 'termination' } }]);
    expect(t.state()).toContain('T-003 annulé : le bien peut recevoir un nouveau mandat');
    expect(t.texts()).toContain('Annulé le 01/03/2027 : résiliation');
    expect(t.find('Annuler ce mandat')).toEqual([]);
  });

  it('changer le motif après le premier appui redemande la confirmation', async () => {
    const t = await run({ 'POST /v1/mandats/m1/annulation': ok({ number: 'T-003', seq: 9 }) });
    await t.voir();
    const b = t.find('Annuler ce mandat')[0]!;
    const motif = t.input('regmandat-motif-0');
    motif.value = 'termination';
    await t.click(b);
    clock += 2000;
    motif.value = 'error';
    await t.click(b);
    expect(t.posts()).toEqual([]);
    expect(t.state()).toContain('pour erreur');
  });

  it.each([
    ['register_broken', 'Le registre est abîmé'],
    ['not_inscribed', 'n’est pas inscrit'],
    ['unknown', 'n’est pas au registre de ce réseau'],
  ])('le refus %s d’une annulation est dit en français, et le mandat reste à l’écran', async (code, said) => {
    const t = await run({ 'POST /v1/mandats/m1/annulation': no(400, { ok: false, rule: 'R39', code }) });
    await t.voir();
    t.input('regmandat-motif-0').value = 'error';
    await t.twice(t.find('Annuler ce mandat')[0]);
    expect(t.state()).toContain(said);
    expect(t.state()).not.toContain(code);
    expect(t.find('Annuler ce mandat')).toHaveLength(1);
  });

  it('une annulation déjà faite : dit, et le registre est relu', async () => {
    const t = await run({ 'POST /v1/mandats/m1/annulation': no(409, { ok: false, code: 'already_cancelled' }) });
    await t.voir();
    t.input('regmandat-motif-0').value = 'error';
    t.table['GET /v1/registre/lignes'] = ok({ entries: [GONE], next: null });
    await t.twice(t.find('Annuler ce mandat')[0]);
    expect(t.state()).toBe('Ce mandat est déjà annulé.');
    expect(t.find('Annuler ce mandat')).toEqual([]);
  });

  it('une réponse perdue n’annonce ni réussite ni échec', async () => {
    const t = await run();
    await t.voir();
    t.input('regmandat-motif-0').value = 'error';
    await t.twice(t.find('Annuler ce mandat')[0]);
    expect(t.posts()).toHaveLength(1);
    expect(t.state()).toContain('La réponse n’est pas arrivée : rien n’est sûr');
    t.input('regmandat-taux').value = '5';
    t.input('regmandat-minimum').value = '3000';
    await t.click(t.find('Ranger le barème')[0]);
    expect(t.state()).toContain('La réponse n’est pas arrivée');
  });

  it.each([
    ['une panne', async () => Response.json({ ok: false, code: 'panne' }, { status: 500 })],
    ['une réponse illisible', async () => new Response('pas du JSON', { status: 200 })],
  ])('après %s, une écriture a pu passer : ni « pas abouti », ni « pas rangé », ni « pas réglé »', async (_name, answer) => {
    const t = await run({ 'GET /v1/registre/reglage': ok(null), 'POST /v1/mandats/m1/annulation': answer, 'POST /v1/honoraires/bareme': answer, 'POST /v1/registre/reglage': answer });
    await t.voir();
    t.input('regmandat-motif-0').value = 'error';
    await t.twice(t.find('Annuler ce mandat')[0]);
    expect(t.state()).toContain('rien n’est sûr');
    t.input('regmandat-taux').value = '5';
    t.input('regmandat-minimum').value = '3000';
    await t.click(t.find('Ranger le barème')[0]);
    expect(t.state()).toContain('rien n’est sûr');
    t.input('regmandat-premier').value = '1';
    t.input('regmandat-largeur').value = '3';
    await t.twice(t.find('Régler le format')[0]);
    expect(t.state()).toContain('rien n’est sûr');
    expect(t.posts()).toHaveLength(3);
  });

  it('une partie illisible ne propose pas de formulaire : un format non lu n’est pas un format à régler', async () => {
    const t = await run({ 'GET /v1/registre/reglage': no(500, { ok: false, code: 'panne' }) });
    await t.voir();
    expect(t.texts()).toContain('Format indisponible pour le moment.');
    expect(t.find('Régler le format')).toEqual([]);
    expect(t.texts()).toContain('T-003');
    delete t.table['GET /v1/registre/reglage'];
    await t.click(t.els['regmandat-voir']);
    expect(t.find('Régler le format')).toEqual([]);
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('la liste se lit par pages, sans perdre ce qui est affiché ; registre vide dit tel', async () => {
    const t = await run({
      'GET /v1/registre/lignes': ok({ entries: [LIVE], next: 3 }),
      'GET /v1/registre/lignes?avant=3': ok({ entries: [GONE], next: null }),
    });
    await t.voir();
    await t.click(t.find('Voir les précédents')[0]);
    expect(t.texts()).toContain('T-003');
    expect(t.texts()).toContain('T-002');
    expect(t.find('Voir les précédents')).toEqual([]);
    const v = await run({ 'GET /v1/registre/lignes': ok({ entries: [], next: null }) });
    await v.voir();
    expect(v.texts()).toContain('Aucun mandat inscrit pour le moment.');
  });

  it('quitter l’écran du réseau efface ce qu’il montrait ; deux appuis rapides font une seule liste', async () => {
    const t = await run();
    t.els['regmandat-voir']!.listeners.click!({});
    t.els['regmandat-voir']!.listeners.click!({});
    await settle();
    expect(t.els.reseau!.children.filter((e) => e.attributes.src === '/app/reglages-mandat.js')).toHaveLength(1);
    await t.load();
    t.els['regmandat-voir']!.listeners.click!({});
    t.els['regmandat-voir']!.listeners.click!({});
    await settle();
    expect(t.body().all().filter((e) => e.tagName === 'ul')).toHaveLength(1);
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
  });

  it('un script qui ne charge pas, ou arrive abîmé, est dit, et un nouvel appui réessaie', async () => {
    const t = await run();
    await t.click(t.els['regmandat-voir']);
    const scripts = () => t.els.reseau!.children.filter((e) => e.attributes.src === '/app/reglages-mandat.js');
    scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    await t.click(t.els['regmandat-voir']);
    scripts()[1]!.listeners.load!({});
    await settle();
    expect(t.state()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
    await t.click(t.els['regmandat-voir']);
    expect(scripts()).toHaveLength(3);
  });

  it('[R201] le script est servi à part, jamais gardé sur l’appareil, et tient son budget ; aucun code de page', () => {
    expect(AGENT_APP_FILES['/app/reglages-mandat.js']).toBe(REGLAGES_MANDAT_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/reglages-mandat.js');
    expect(handleAgentApp(new Request('https://x.test/app/reglages-mandat.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: REGLAGES_MANDAT_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(REGLAGES_MANDAT_SCRIPT).not.toContain('innerHTML');
  });
});
