import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { COMMITMENT_MEASURES } from '../../core/src/mandats/gagner/dossier-presentation.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, textes, personne.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const ONE = { code: 'cr', version: 2, label: 'Compte rendu après chaque visite', measure: 'compte_rendu_visite', rule: 'Chaque visite tenue compte.', delayHours: 48, active: true, setAt: '2027-03-01T08:00:00.000Z' };
const TWO = { code: 'pt', version: 1, label: 'Point de la semaine au vendeur', measure: 'point_semaine', rule: 'Chaque point compte.', delayHours: 24, active: false, setAt: '2027-03-02T08:00:00.000Z' };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, role = 'direction') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role, firstName: null }),
    'GET /v1/gagner/engagements': ok([ONE, TWO]),
    'POST /v1/gagner/engagements': ok({ version: 3 }),
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
    Date,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['engagements-corps']!;
  const state = () => els['engagements-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/engagements.js');
  const voir = async () => {
    await click(els['engagements-voir']);
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(ENGAGEMENTS_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/v1/gagner/'));
  return { els, calls, table, body, state, texts, find, input, click, voir, posts, scripts };
}

describe('G15 · les engagements de service à l’écran', () => {
  it('le script ne se charge qu’au premier geste, et la liste dit chaque version', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url === '/v1/gagner/engagements')).toBe(false);
    await t.voir();
    expect(t.body().all().filter((e) => e.tagName === 'strong').map((e) => e.textContent)).toEqual([ONE.label, TWO.label]);
    expect(t.texts()).toContain('En service · délai 48 h · version 2');
    expect(t.texts()).toContain('Retiré des dossiers · délai 24 h · version 1');
  });

  it('une nouvelle version garde le code et la mesure, et reprend les valeurs en place', async () => {
    const t = await run();
    await t.voir();
    expect(t.input('engagement-0-texte').value).toBe(ONE.label);
    expect(t.input('engagement-0-delai').value).toBe('48');
    t.input('engagement-0-delai').value = '24';
    (t.input('engagement-0-actif') as FakeElement & { checked?: boolean }).checked = false;
    await t.click(t.find('Ranger cette version')[0]);
    expect(t.posts()[0]!.body).toEqual({ code: 'cr', label: ONE.label, measure: 'compte_rendu_visite', delayHours: 24, active: false });
    expect(t.state()).toBe('Version rangée : l’ancienne reste au journal.');
  });

  it('un nouvel engagement nomme sa mesure et son délai ; sans mesure ni délai lisible, rien ne part', async () => {
    const t = await run();
    await t.voir();
    t.input('engagement-nouveau-texte').value = 'Un compte rendu rapide';
    await t.click(t.find('Ajouter cet engagement')[0]);
    expect(t.state()).toBe('Le délai : un nombre entier d’heures, de 1 à 336.');
    for (const bad of ['0', '337', 'deux', '1,5']) {
      t.input('engagement-nouveau-delai').value = bad;
      await t.click(t.find('Ajouter cet engagement')[0]);
      expect(t.state()).toBe('Le délai : un nombre entier d’heures, de 1 à 336.');
    }
    t.input('engagement-nouveau-delai').value = '72';
    await t.click(t.find('Ajouter cet engagement')[0]);
    expect(t.state()).toBe('Choisissez ce qui est mesuré.');
    expect(t.posts()).toEqual([]);
    t.input('engagement-mesure').value = 'point_semaine';
    await t.click(t.find('Ajouter cet engagement')[0]);
    expect(t.posts()[0]!.body).toEqual({ code: 'point_semaine_72h', label: 'Un compte rendu rapide', measure: 'point_semaine', delayHours: 72, active: true });
    expect(t.state()).toBe('Engagement ajouté.');
  });

  it('[R141] un texte qui promet est refusé par le serveur, et dit en français', async () => {
    const t = await run({ 'POST /v1/gagner/engagements': no(409, { ok: false, rule: 'R141', code: 'promise' }) });
    await t.voir();
    t.input('engagement-0-texte').value = 'Vendu en trois semaines, garanti';
    await t.click(t.find('Ranger cette version')[0]);
    expect(t.state()).toContain('promet un résultat');
  });

  it('[R10] une réponse perdue ou une panne n’est dite ni faite ni refusée', async () => {
    const t = await run({ 'POST /v1/gagner/engagements': () => Promise.reject(new TypeError('coupé')) });
    await t.voir();
    await t.click(t.find('Ranger cette version')[0]);
    expect(t.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste avant de recommencer.');
    t.table['POST /v1/gagner/engagements'] = no(500, { ok: false, code: 'internal' });
    await t.click(t.find('Ranger cette version')[0]);
    expect(t.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste avant de recommencer.');
  });

  it('[R16] un refus de droits est dit ; une liste vide dit que le dossier le dira', async () => {
    const t = await run({ 'GET /v1/gagner/engagements': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.voir();
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
    expect(t.body().children).toEqual([]);
    const u = await run({ 'GET /v1/gagner/engagements': ok([]) });
    await u.voir();
    expect(u.texts()).toContain('Aucun engagement');
  });

  it('en sortant, rien ne reste ; deux appuis ne font qu’une liste ; un script manquant est dit', async () => {
    const t = await run();
    await t.voir();
    t.els['engagements-voir']!.listeners.click!({});
    t.els['engagements-voir']!.listeners.click!({});
    await settle();
    expect(t.body().all().filter((e) => e.tagName === 'ul')).toHaveLength(1);
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    const u = await run();
    await u.click(u.els['engagements-voir']);
    u.scripts()[0]!.listeners.error!({});
    await settle();
    expect(u.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    await u.click(u.els['engagements-voir']);
    u.scripts()[1]!.listeners.load!({});
    await settle();
    expect(u.state()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('chaque mesure du serveur a son libellé', () => {
    for (const m of COMMITMENT_MEASURES) expect(ENGAGEMENTS_SCRIPT).toContain(`"${m}":`);
  });

  it('[R201] le script est servi à part, jamais gardé sur l’appareil, et tient son budget ; aucun code de page', () => {
    expect(AGENT_APP_FILES['/app/engagements.js']).toBe(ENGAGEMENTS_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/engagements.js');
    expect(handleAgentApp(new Request('https://x.test/app/engagements.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: ENGAGEMENTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(ENGAGEMENTS_SCRIPT).not.toContain('innerHTML');
  });
});
