import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { LICENCES_SCRIPT } from '../app/licences.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, agences, SIREN, cartes, raisons, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const licence = (extra: Record<string, unknown>) => ({
  id: 'lic-a',
  agencyName: 'Agence des Essais',
  siren: '732829320',
  department: '69',
  region: '84',
  grantedAt: '2028-01-05T09:00:00.000Z',
  state: 'active',
  stateSince: '2028-01-05T09:00:00.000Z',
  tariffVersion: 1,
  monthlyCents: 45000,
  oldTariff: true,
  cardExpiresOn: '2030-06-30',
  cardExpired: false,
  ...extra,
});
const LIST = {
  readAt: '2028-01-10T09:00:00.000Z',
  tariff: { version: 2, monthlyCents: 49000, decidedAt: '2028-01-08T09:00:00.000Z' },
  licences: [
    licence({}),
    licence({ id: 'lic-b', agencyName: 'Cabinet Imaginaire', department: '2A', region: '94', state: 'suspendue', stateSince: '2028-01-09T09:00:00.000Z', tariffVersion: 2, monthlyCents: 49000, oldTariff: false, cardExpiresOn: '2028-01-01', cardExpired: true }),
    licence({ id: 'lic-d', agencyName: 'Maison Fictive', state: 'terminee', stateSince: '2028-01-09T10:00:00.000Z' }),
    licence({ id: 'lic-e', agencyName: 'Agence Future', state: 'etat_jamais_vu' }),
  ],
};
const { siren: _s, region: _r, ...MINE } = licence({ oldTariff: false, tariffVersion: 2, monthlyCents: 49000 });
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
    'GET /v1/licences': ok(LIST),
    'GET /v1/licences/ma-licence': ok(MINE),
    'POST /v1/licences/tarif': ok({ version: 3, monthlyCents: 52000, decidedAt: '2028-02-01T09:00:00.000Z' }),
    'POST /v1/licences/licence': ok({ id: 'lic-c', licenseeNetworkId: 'net-c', tariffVersion: 2, monthlyCents: 49000 }),
    'POST /v1/licences/etat': ok({ licenceId: 'lic-a', version: 1, state: 'suspendue' }),
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
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['licences-corps']!;
  const state = () => els['licences-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const buttons = () => body().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/licences.js');
  const voir = async () => {
    await click(els['licences-voir']);
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(LICENCES_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, body, state, texts, find, buttons, input, click, voir, posts, scripts };
}

describe('BR16 · les licences du logiciel à l’écran', () => {
  it('[R201] le script ne se charge qu’au premier geste ; chaque état dit en mots, jamais un code [R655] [R656]', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/licences'))).toBe(false);
    await t.voir();
    const x = t.texts();
    expect(x).toContain('490,00 € HT par mois, version 2 du 08/01/2028 : le même pour chaque agence.');
    expect(x).toContain('Agence des Essais');
    expect(x).toContain('SIREN 732829320 · département 69, Auvergne-Rhône-Alpes · donnée le 05/01/2028.');
    expect(x).toContain('Active depuis le 05/01/2028.');
    expect(x).toContain('450,00 € HT par mois, tarif version 1, à l’ancien tarif : un nouveau tarif ne change pas une licence déjà donnée.');
    expect(x).toContain('Carte professionnelle valable jusqu’au 30/06/2030.');
    expect(x).toContain('département 2A, Corse');
    expect(x).toContain('Suspendue depuis le 09/01/2028.');
    expect(x).toContain('Carte professionnelle échue le 01/01/2028 : rien ne se coupe seul, la décision vous revient.');
    expect(x).toContain('Terminée : elle ne bouge plus depuis le 09/01/2028.');
    expect(x).toContain('État que cet écran ne sait pas encore dire depuis le 05/01/2028.');
    for (const code of ['active', 'suspendue', 'terminee', 'etat_jamais_vu', 'lic-a', '45000']) expect(x).not.toContain(code);
    // Une licence terminée n'a aucun geste ; une active se suspend ; une suspendue se reprend.
    expect(t.buttons()).toContain('Suspendre Agence des Essais');
    expect(t.buttons()).toContain('Reprendre Cabinet Imaginaire');
    expect(t.buttons().filter((b) => b.includes('Maison Fictive'))).toEqual([]);
    expect(t.buttons().filter((b) => b.includes('Agence Future'))).toEqual([]);
    expect(t.state()).toBe('');
  });

  it('[R656] terminer une licence se fait en deux appuis, avec sa raison', async () => {
    const t = await run();
    await t.voir();
    await t.click(t.find('Terminer Agence des Essais'));
    expect(t.posts()).toHaveLength(0);
    expect(t.state()).toBe('La raison : de 3 à 200 caractères.');
    t.input('licence-raison-0').value = '  Fin du contrat  ';
    await t.click(t.find('Terminer Agence des Essais'));
    expect(t.posts()).toHaveLength(0);
    await t.click(t.find('Confirmer : terminée, la licence ne bouge plus'));
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/licences/etat', body: { licenceId: 'lic-a', state: 'terminee', reason: 'Fin du contrat' } }]);
    expect(t.state()).toBe('Licence de Agence des Essais terminée : elle ne bouge plus.');
    const u = await run();
    await u.voir();
    u.input('licence-raison-1').value = 'Paiement reçu';
    await u.click(u.find('Reprendre Cabinet Imaginaire'));
    expect(u.posts()).toEqual([{ method: 'POST', url: '/v1/licences/etat', body: { licenceId: 'lic-b', state: 'active', reason: 'Paiement reçu' } }]);
    expect(u.state()).toBe('Licence de Cabinet Imaginaire reprise.');
  });

  it('[R655] le tarif part en centimes ; une saisie illisible ne part pas', async () => {
    const t = await run();
    await t.voir();
    const publish = () => t.find('Publier ce tarif');
    for (const bad of ['', 'abc', '0,99', '100000,01', '12,345', '-5']) {
      t.input('licence-tarif').value = bad;
      t.input('licence-tarif-raison').value = 'Nouvelle année';
      await t.click(publish());
      expect(t.state(), bad).toBe('Le tarif : un montant en euros hors taxes, de 1 € à 100 000 € par mois, au centime près.');
    }
    t.input('licence-tarif').value = '520';
    t.input('licence-tarif-raison').value = 'x';
    await t.click(publish());
    expect(t.state()).toBe('La raison : de 3 à 200 caractères.');
    expect(t.posts()).toHaveLength(0);
    t.input('licence-tarif').value = ' 520,5 ';
    t.input('licence-tarif-raison').value = 'Nouvelle année';
    await t.click(publish());
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/licences/tarif', body: { monthlyCents: 52050, reason: 'Nouvelle année' } }]);
    expect(t.state()).toBe('Tarif publié : 520,50 € HT par mois. Les licences déjà données gardent le leur.');
  });

  it('[R654] [R655] donner une licence : aucun champ de prix, une saisie illisible ne part pas', async () => {
    const t = await run();
    await t.voir();
    expect(t.texts()).toContain('Le prix est celui du tarif en vigueur, 490,00 € HT par mois : il ne se saisit pas.');
    const give = () => t.find('Donner la licence');
    const fill = (v: Record<string, string>) => {
      const all = { 'licence-agence': 'Agence Nouvelle', 'licence-siren': '732 829 320', 'licence-carte': 'cpi 2101 2028 000 000 042', 'licence-carte-fin': '2030-12-31', 'licence-departement': '21', ...v };
      for (const [k, value] of Object.entries(all)) t.input(k).value = value;
    };
    const cases: [Record<string, string>, string][] = [
      [{ 'licence-agence': 'A' }, 'Le nom de l’agence : de 2 à 120 caractères.'],
      [{ 'licence-siren': '732829321' }, 'Le SIREN : 9 chiffres, avec une clé juste.'],
      [{ 'licence-siren': '73282932' }, 'Le SIREN : 9 chiffres, avec une clé juste.'],
      [{ 'licence-carte': '2101 2028' }, 'La carte professionnelle : « CPI » suivi de son numéro, et sa date de fin de validité.'],
      [{ 'licence-carte-fin': '2030-02-30' }, 'La carte professionnelle : « CPI » suivi de son numéro, et sa date de fin de validité.'],
      [{ 'licence-departement': '20' }, 'Ce département ne se reconnaît pas.'],
    ];
    for (const [v, said] of cases) {
      fill(v);
      await t.click(give());
      expect(t.state(), JSON.stringify(v)).toBe(said);
    }
    expect(t.posts()).toHaveLength(0);
    fill({ 'licence-departement': '2a' });
    await t.click(give());
    expect(t.posts()).toEqual([
      { method: 'POST', url: '/v1/licences/licence', body: { agencyName: 'Agence Nouvelle', siren: '732829320', cardNumber: 'CPI 2101 2028 000 000 042', cardExpiresOn: '2030-12-31', department: '2A' } },
    ]);
    expect(Object.keys(t.posts()[0]!.body as object)).not.toContain('monthlyCents');
    expect(t.state()).toBe('Licence donnée à Agence Nouvelle au tarif en vigueur. L’agence naît comme son propre réseau.');
  });

  it('un refus du serveur dit sa raison en mots ; une réponse perdue est dite incertaine', async () => {
    const t = await run({ 'POST /v1/licences/licence': no(409, { ok: false, rule: 'R654', code: 'phase5_fermee' }) });
    await t.voir();
    for (const [k, v] of Object.entries({ 'licence-agence': 'Agence Nouvelle', 'licence-siren': '732829320', 'licence-carte': 'CPI 2101 2028 000 000 042', 'licence-carte-fin': '2030-12-31', 'licence-departement': '21' })) t.input(k).value = v;
    await t.click(t.find('Donner la licence'));
    expect(t.state()).toBe('La phase 5 n’est pas ouverte : aucune licence ne se donne avant.');
    const u = await run({ 'POST /v1/licences/etat': no(409, { ok: false, rule: 'R656', code: 'terminee' }) });
    await u.voir();
    u.input('licence-raison-0').value = 'Essai';
    await u.click(u.find('Suspendre Agence des Essais'));
    expect(u.state()).toBe('Cette licence est terminée : elle ne bouge plus.');
    const v = await run({ 'POST /v1/licences/tarif': no(503, { ok: false }) });
    await v.voir();
    v.input('licence-tarif').value = '500';
    v.input('licence-tarif-raison').value = 'Essai';
    await v.click(v.find('Publier ce tarif'));
    expect(v.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    const w = await run({ 'POST /v1/licences/etat': () => Promise.reject(new TypeError('coupé')) });
    await w.voir();
    w.input('licence-raison-0').value = 'Essai';
    await w.click(w.find('Suspendre Agence des Essais'));
    expect(w.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    const y = await run({ 'GET /v1/licences': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await y.voir();
    expect(y.state()).toBe('Ce n’est pas dans vos droits.');
    expect(y.calls.some((c) => c.url === '/v1/licences/ma-licence')).toBe(false);
    const z = await run({ 'GET /v1/licences': () => Promise.reject(new TypeError('hors ligne')) });
    await z.voir();
    expect(z.state()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('[R657] la direction d’une agence sous licence ne voit que la sienne, sans aucun geste', async () => {
    const t = await run({ 'GET /v1/licences': no(409, { ok: false, rule: 'R657', code: 'agence_licenciee' }) });
    await t.voir();
    const x = t.texts();
    expect(x).toContain('Votre licence');
    expect(x).toContain('Agence des Essais');
    expect(x).toContain('Active depuis le 05/01/2028.');
    expect(x).toContain('490,00 € HT par mois, tarif version 2.');
    expect(x).not.toContain('Les licences données');
    expect(x).not.toContain('Le tarif');
    expect(x).not.toContain('SIREN');
    // Aucun geste sur la licence ; seulement la reprise de ses données (BR19).
    expect(t.buttons()).toEqual(['Tirer le fichier de mes données', 'Vérifier le fichier tiré']);
    expect(t.state()).toBe('');
    const u = await run({ 'GET /v1/licences': no(409, { ok: false, rule: 'R657', code: 'agence_licenciee' }), 'GET /v1/licences/ma-licence': no(409, { ok: false, rule: 'R657', code: 'pas_de_licence' }) });
    await u.voir();
    expect(u.state()).toBe('Aucune licence n’est rangée pour votre agence.');
  });

  it('chaque code de refus des licences a son libellé ; servi à part, jamais gardé, budget tenu, aucun innerHTML [R201]', () => {
    const sources = [readFileSync(new URL('../../core/src/licences/licences.ts', import.meta.url), 'utf8'), readFileSync(new URL('../src/licences.ts', import.meta.url), 'utf8')].join('\n');
    const codes = new Set([...sources.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]!));
    // Les refus de la lecture publique du tarif ne viennent jamais à cet écran.
    codes.delete('method_not_allowed');
    expect(codes.size).toBeGreaterThanOrEqual(18);
    for (const c of codes) expect(LICENCES_SCRIPT, c).toContain(`"${c}":`);
    for (const c of ['bad_shape', 'unknown_field']) expect(LICENCES_SCRIPT).toContain(`"${c}":`);
    for (const s of ['active', 'suspendue', 'terminee']) expect(LICENCES_SCRIPT).toContain(`"${s}":`);
    expect(AGENT_APP_FILES['/app/licences.js']).toBe(LICENCES_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/licences.js');
    expect(handleAgentApp(new Request('https://x.test/app/licences.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: LICENCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(LICENCES_SCRIPT).not.toContain('innerHTML');
  });
});
