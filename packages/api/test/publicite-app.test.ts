import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ATTIRER_SCRIPT } from '../app/attirer.ts';
import { PUBLICITE_CONFIRM, PUBLICITE_LOST, PUBLICITE_REFUSALS, PUBLICITE_SCRIPT } from '../app/publicite.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : campagnes, communes, montants, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const BASE = '/v1/marketing/publicite/campagnes';

// Des chiffres impossibles à retrouver par un calcul : l'écran montre ceux du serveur, tels quels.
const C_RUN = { id: 'cmp-1', platform: 'meta', name: 'Vendeurs du centre', state: 'en_cours', stopReason: null, spendCents: 123456, contacts: 7, mandates: 2, sales: 1, costPerContactCents: 11111, costPerMandateCents: 22222, costPerSaleCents: 33333, maxCostPerContactCents: 4000, mode: 'reel', failure: { step: 'depense', code: 'reconnecter', action: 'reconnecter' }, pendingArrivals: 3 };
const C_NEW = { id: 'cmp-2', platform: 'google_ads', name: INJECTED, state: 'a_valider', stopReason: null, spendCents: 0, contacts: 0, mandates: 0, sales: 0, costPerContactCents: null, costPerMandateCents: null, costPerSaleCents: null, maxCostPerContactCents: null, mode: null, failure: null, pendingArrivals: 0 };
const C_OK = { ...C_NEW, id: 'cmp-3', name: 'Maisons de l’est', state: 'validee', maxCostPerContactCents: 2500 };
const C_STOP = { ...C_RUN, id: 'cmp-4', name: 'Appartements', state: 'arretee', stopReason: 'seuil', mode: 'essai', failure: null, pendingArrivals: 0 };
const C_BAD = { ...C_OK, id: '../x', name: 'Identifiant tordu' };
const LIST = [C_RUN, C_NEW, C_OK, C_STOP, C_BAD];

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    'GET /v1/attirer/sites': ok([]),
    [`GET ${BASE}`]: ok(LIST),
    [`POST ${BASE}`]: ok({ id: 'cmp-9', code: 'abc' }),
    [`POST ${BASE}/cmp-2/validation`]: ok({ approvalId: 'ap-1', version: 1 }),
    [`POST ${BASE}/cmp-3/lancement`]: ok({ approvalId: 'ap-2' }),
    [`POST ${BASE}/cmp-1/arret`]: ok(null),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  await click(els['attirer-ouvrir']);
  runInNewContext(ATTIRER_SCRIPT, context);
  els.attirer!.children.filter((e) => e.tagName === 'script')[0]!.listeners.load!({});
  await settle();
  const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  const part = () => els['attirer-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Publicité payante')!;
  const button = (text: string, nth = 0) => part().all().filter((e) => e.tagName === 'button' && e.textContent === text)[nth];
  const buttons = () => part().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  // Les espaces insécables des montants (« 1 234,56 € ») lus comme des espaces ordinaires.
  const plain = (x: string) => x.replace(/[\u00a0\u202f]/g, ' ');
  const status = () => plain(part().all().find((e) => e.attributes.role === 'status')?.textContent ?? '');
  const texts = () => plain(part().textContent);
  const byId = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const open = async (load = true) => {
    await click(button('Ouvrir la publicité payante'));
    const s = scriptsOf(part(), '/app/publicite.js');
    if (load && s.length === 1 && !context.loaded) {
      runInNewContext(PUBLICITE_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const reads = () => calls.filter((c) => c.method === 'GET' && c.url === BASE).length;
  const propose = (platform: string, name: string, communes: string, radius: string) => {
    byId('pub-plateforme').value = platform;
    byId('pub-nom').value = name;
    byId('pub-communes').value = communes;
    byId('pub-rayon').value = radius;
    return click(button('Proposer cette campagne'));
  };
  /** Les budgets de la n-ième campagne de la liste reçue (rang dans la liste). */
  const budgets = (n: number, daily: string, total: string, max: string) => {
    byId(`pub-jour-${n}`).value = daily;
    byId(`pub-total-${n}`).value = total;
    byId(`pub-seuil-${n}`).value = max;
  };
  return { els, calls, context, part, button, buttons, status, texts, click, open, posts, reads, scriptsOf, byId, propose, budgets };
}

describe('BR110 · la publicité payante à l’écran de la direction', () => {
  it('[R201] servi à part, chargé au seul geste depuis « Attirer », jamais gardé ; le budget tient, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/publicite.js']).toBe(PUBLICITE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/publicite.js');
    const served = handleAgentApp(new Request('https://x.test/app/publicite.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: PUBLICITE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: ATTIRER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/marketing');
    expect(JS).not.toContain('/app/publicite.js');
    expect(PUBLICITE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    const t = await run();
    expect(t.part()).toBeDefined();
    expect(t.scriptsOf(t.part(), '/app/publicite.js')).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/marketing'))).toBe(false);
    await t.open();
    expect(t.texts()).toContain('Vendeurs du centre');
    await t.open(false);
    expect(t.scriptsOf(t.part(), '/app/publicite.js')).toHaveLength(1);
    expect(t.reads()).toBe(2);
  });

  it('sans réseau au chargement du script, ou script sans écran : l’écran le dit et le bouton revient', async () => {
    const t = await run();
    await t.open(false);
    t.scriptsOf(t.part(), '/app/publicite.js')[0]!.listeners.error!({});
    await settle();
    expect(t.texts()).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.button('Ouvrir la publicité payante') as unknown as { disabled: boolean }).disabled).toBe(false);
    const u = await run();
    await u.open(false);
    u.scriptsOf(u.part(), '/app/publicite.js')[0]!.listeners.load!({});
    await settle();
    expect(u.texts()).toContain('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('[R588] chaque campagne dans l’ordre reçu, jugée au mandat et à l’acte : chiffres du serveur en euros, état et raison d’arrêt en mots (Jamais vu)', async () => {
    const t = await run();
    await t.open();
    const x = t.texts();
    expect(x).toContain('Chaque campagne est jugée aux mandats signés et aux actes de ses contacts, pas aux clics.');
    const titles = t.part().all().filter((e) => e.tagName === 'h4').map((e) => e.textContent);
    expect(titles).toEqual(['Vendeurs du centre · Meta', `${INJECTED} · Google Ads`, 'Maisons de l’est · Google Ads', 'Appartements · Meta', 'Identifiant tordu · Google Ads']);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(x).toContain('Dépense1 234,56 €');
    expect(x).toContain('Contacts7');
    expect(x).toContain('Mandats signés par ces contacts2');
    expect(x).toContain('Actes1');
    expect(x).toContain('Coût par contact111,11 €');
    expect(x).toContain('Coût par mandat222,22 €');
    expect(x).toContain('Coût par acte333,33 €');
    expect(x).toContain('Seuil par contact40,00 €');
    expect(x).toContain('En cours.');
    // AU038 : le mode lu dans l'accusé, le dernier échec en mots avec son geste, les demandes à rattacher.
    expect(x).toContain('Mode réel : la plateforme dépense, dans les budgets validés et sous le plafond.');
    expect(x).toContain('Mode essai : rien n’est payé.');
    expect(x).toContain('À la lecture de la dépense : La connexion au compte publicitaire a expiré : reconnectez le compte du réseau.');
    expect(x).toContain('Demandes pas encore rattachées à une fiche3');
    expect(x.split(/[^a-z_]+/i)).not.toContain('reconnecter');
    expect(x).toContain('À valider : rien ne se dépense avant la validation de ses budgets.');
    expect(x).toContain('Validée, pas encore lancée.');
    expect(x).toContain('Arrêtée au seuil de coût par contact.');
    expect(x).toContain('Coût par mandatpas encore de mandat');
    expect(x).toContain('Seuil par contactpas encore validé');
    for (const code of ['en_cours', 'a_valider', 'arretee', 'echec_lancement', 'google_ads', 'null', 'undefined', 'NaN']) expect(x.split(/[^a-z_]+/i)).not.toContain(code);
    expect(PUBLICITE_SCRIPT).not.toMatch(/\.sort\(|\.reverse\(|\.reduce\(/);
    // Le montant garde ses espaces insécables : jamais coupé en fin de ligne.
    expect(t.part().textContent).toContain('1\u202f234,56\u00a0€');
    // Les gestes selon l'état : arrêter en cours, lancer validée, des budgets hors cours ; un identifiant tordu : aucun geste.
    expect(t.buttons().filter((b) => b === 'Arrêter')).toHaveLength(1);
    expect(t.buttons().filter((b) => b === 'Lancer')).toHaveLength(1);
    expect(t.buttons().filter((b) => b === 'Valider ces budgets')).toHaveLength(3);
    expect(t.part().all().some((e) => e.attributes.id === 'pub-jour-0')).toBe(false);
    expect(t.part().all().some((e) => e.attributes.id === 'pub-jour-4')).toBe(false);
    const u = await run({ [`GET ${BASE}`]: ok([]) });
    await u.open();
    expect(u.texts()).toContain('Aucune campagne pour le moment.');
  });

  it('[R589] proposer : plateforme, nom, communes en codes INSEE et rayon vérifiés avant l’appel ; seuls les communes et le rayon partent au ciblage', async () => {
    const t = await run();
    await t.open();
    const fields = t.part().all().filter((e) => ['input', 'select', 'textarea'].includes(e.tagName)).map((e) => e.attributes.id);
    expect(fields.filter((id) => id!.startsWith('pub-') && !/-\d+$/.test(id!))).toEqual(['pub-plateforme', 'pub-nom', 'pub-communes', 'pub-rayon']);
    expect(t.byId('pub-plateforme').children.map((o) => o.attributes.value)).toEqual(['', 'google_ads', 'meta']);
    await t.propose('', 'Vendeurs', '21231', '');
    expect(t.status()).toBe(PUBLICITE_REFUSALS.bad_platform);
    await t.propose('meta', 'ab', '21231', '');
    expect(t.status()).toBe(PUBLICITE_REFUSALS.bad_name);
    for (const communes of ['', '2123', '21231 21231', '75 001', 'Dijon', Array.from({ length: 31 }, (_, i) => String(21000 + i)).join(' ')]) {
      await t.propose('meta', 'Vendeurs', communes, '');
      expect(t.status(), communes).toBe(PUBLICITE_REFUSALS.communes);
    }
    for (const r of ['14', '81', '1e1', '-20', '20.5']) {
      await t.propose('meta', 'Vendeurs', '21231', r);
      expect(t.status(), r).toBe(PUBLICITE_REFUSALS.rayon);
    }
    expect(t.posts()).toEqual([]);
    const before = t.reads();
    await t.propose('meta', '  Vendeurs   du sud ', '21231, 21054;2a004\n21166', '25');
    expect(t.posts()).toEqual([{ method: 'POST', url: BASE, body: { platform: 'meta', name: 'Vendeurs du sud', targeting: { communes: ['21231', '21054', '2A004', '21166'], rayonKm: 25 } }, auth: `Bearer ${KEY}` }]);
    expect(Object.keys((t.posts()[0]!.body as { targeting: object }).targeting)).toEqual(['communes', 'rayonKm']);
    expect(t.reads()).toBe(before + 1);
    expect(t.status()).toBe('Campagne proposée : elle attend la validation de ses budgets.');
    await t.propose('google_ads', 'Sans rayon', '21231', '');
    expect(t.posts()[1]!.body).toEqual({ platform: 'google_ads', name: 'Sans rayon', targeting: { communes: ['21231'] } });
    // Un critère interdit, refusé par le serveur, est dit en mots, jamais nommé par son code.
    const u = await run({ [`POST ${BASE}`]: no(409, { ok: false, rule: 'R589', code: 'critere_interdit', detail: 'age' }) });
    await u.open();
    await u.propose('meta', 'Vendeurs', '21231', '');
    expect(u.status()).toBe(PUBLICITE_REFUSALS.critere_interdit);
  });

  it('[R587] valider : budgets en euros changés en centimes, le total au moins le budget du jour, refusés avant l’appel sinon', async () => {
    const t = await run();
    await t.open();
    const save = () => t.click(t.button('Valider ces budgets'));
    for (const [d, tot, m] of [['', '100', '10'], ['0', '100', '10'], ['10', '5', '2'], ['1,234', '100', '10'], ['-5', '100', '10'], ['abc', '100', '10'], ['10', '100', '1e2']]) {
      t.budgets(1, d!, tot!, m!);
      await save();
      expect(t.status(), `${d} ${tot} ${m}`).toBe(PUBLICITE_REFUSALS.bad_budget);
    }
    expect(t.posts()).toEqual([]);
    t.budgets(1, ' 15,5 ', '1 500', '40 €');
    await save();
    expect(t.posts()).toEqual([{ method: 'POST', url: `${BASE}/cmp-2/validation`, body: { dailyBudgetCents: 1550, totalBudgetCents: 150000, maxCostPerContactCents: 4000 }, auth: `Bearer ${KEY}` }]);
    expect(t.status()).toBe('Budgets validés : 15,50 € par jour, 1 500,00 € au total, seuil 40,00 € par contact.');
    const u = await run({ [`POST ${BASE}/cmp-2/validation`]: no(409, { ok: false, rule: 'R587', code: 'en_cours' }) });
    await u.open();
    u.budgets(1, '10', '100', '10');
    await u.click(u.button('Valider ces budgets'));
    expect(u.status()).toBe(PUBLICITE_REFUSALS.en_cours);
  });

  it('lancer et arrêter ne partent qu’au second appui ; tout autre geste annule', async () => {
    const t = await run();
    await t.open();
    await t.click(t.button('Lancer'));
    expect(t.posts()).toEqual([]);
    expect(t.status()).toBe(PUBLICITE_CONFIRM.lancer);
    // Un autre geste : le « Confirmer » revient à « Lancer », rien ne part.
    await t.click(t.button('Arrêter'));
    expect(t.buttons()).toContain('Lancer');
    expect(t.status()).toBe(PUBLICITE_CONFIRM.arreter);
    await t.click(t.button('Valider ces budgets'));
    expect(t.buttons()).toContain('Arrêter');
    expect(t.posts()).toEqual([]);
    // Saisir, choisir ou ouvrir un volet annule aussi : le bouton revient, et un appui ne fait que redemander.
    for (const gesture of [() => t.byId('pub-nom').listeners.input!({}), () => t.byId('pub-plateforme').listeners.change!({}), () => t.byId('pub-jour-1').listeners.focus!({}), () => t.part().all().find((e) => e.tagName === 'details')!.listeners.toggle!({})]) {
      await t.click(t.button('Lancer'));
      expect(t.buttons()).toContain('Confirmer : lancer');
      gesture();
      expect(t.buttons()).not.toContain('Confirmer : lancer');
      await t.click(t.button('Lancer'));
      expect(t.posts()).toEqual([]);
      expect(t.status()).toBe(PUBLICITE_CONFIRM.lancer);
      await t.click(t.button('Arrêter'));
    }
    await t.click(t.button('Valider ces budgets'));
    await t.click(t.button('Lancer'));
    await t.click(t.button('Confirmer : lancer'));
    expect(t.posts()).toEqual([{ method: 'POST', url: `${BASE}/cmp-3/lancement`, body: null, auth: `Bearer ${KEY}` }]);
    expect(t.status()).toBe('Campagne lancée : son mode et l’accusé de la plateforme se lisent dans la liste.');
    await t.click(t.button('Arrêter'));
    await t.click(t.button('Confirmer : arrêter'));
    expect(t.posts()[1]).toEqual({ method: 'POST', url: `${BASE}/cmp-1/arret`, body: null, auth: `Bearer ${KEY}` });
    expect(t.status()).toBe('Campagne arrêtée : la pause est demandée à la plateforme.');
    const u = await run({ [`POST ${BASE}/cmp-3/lancement`]: no(409, { ok: false, rule: 'R587', code: 'echec_lancement' }) });
    await u.open();
    await u.click(u.button('Lancer'));
    await u.click(u.button('Confirmer : lancer'));
    expect(u.status()).toBe(PUBLICITE_REFUSALS.echec_lancement);
  });

  it('une réponse perdue est dite incertaine ; une seule écriture à la fois ; seule la dernière lecture dessine', async () => {
    for (const answer of [() => Promise.reject(new TypeError('coupé')), no(503, { ok: false }), async () => new Response('panne', { status: 502 })]) {
      const t = await run({ [`POST ${BASE}/cmp-3/lancement`]: answer });
      await t.open();
      await t.click(t.button('Lancer'));
      await t.click(t.button('Confirmer : lancer'));
      expect(t.status()).toBe(PUBLICITE_LOST);
      expect(t.texts()).not.toContain('Campagne lancée');
    }
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: { id: 'x', code: 'y' } }))));
    const t = await run({ [`POST ${BASE}`]: slow });
    await t.open();
    await t.propose('meta', 'Vendeurs', '21231', '');
    await t.click(t.button('Proposer cette campagne'));
    expect(t.posts()).toHaveLength(1);
    release();
    await settle();
    expect(t.status()).toBe('Campagne proposée : elle attend la validation de ses budgets.');
    let first: () => void = () => undefined;
    let n = 0;
    const u = await run({
      [`GET ${BASE}`]: () => {
        n += 1;
        if (n === 2) return new Promise<Response>((r) => (first = () => r(Response.json({ ok: true, mode: 'essai', data: [{ ...C_RUN, name: 'Lecture ancienne' }] }))));
        return ok(LIST)();
      },
    });
    await u.open();
    await u.open(false);
    await u.open(false);
    first();
    await settle();
    expect(u.texts()).toContain('Vendeurs du centre');
    expect(u.texts()).not.toContain('Lecture ancienne');
  });

  it('[R16] chaque refus connu de la couche métier et de la route a ses mots, jamais son code ; l’écran ne parle qu’à /v1/marketing/publicite, la clé dans l’en-tête seul', async () => {
    const core = readFileSync(new URL('../../core/src/marketing/publicite.ts', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../src/marketing.ts', import.meta.url), 'utf8');
    const codes = new Set([...core.matchAll(/code: '([a-z_]+)'/g), ...core.matchAll(/'R(?:16|587|588|589)', '([a-z_]+)'/g), ...route.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]!));
    for (const c of ['seuil', 'budget']) codes.add(c);
    expect(codes.size).toBeGreaterThanOrEqual(30);
    for (const c of codes) expect(PUBLICITE_REFUSALS[c], c).toBeTruthy();
    const t = await run({ [`GET ${BASE}`]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.open();
    expect(t.status()).toBe(PUBLICITE_REFUSALS.role);
    const v = await run({ [`GET ${BASE}`]: no(409, { ok: false, rule: null, code: 'code_jamais_vu' }) });
    await v.open();
    expect(v.status()).toBe('Les campagnes ne se lisent pas pour le moment.');
    expect(v.texts()).not.toContain('code_jamais_vu');
    const u = await run();
    await u.open();
    await u.propose('meta', 'Vendeurs', '21231', '');
    u.budgets(1, '10', '100', '10');
    await u.click(u.button('Valider ces budgets'));
    const mine = u.calls.filter((c) => c.url.startsWith('/v1/marketing'));
    expect(mine.length).toBeGreaterThanOrEqual(4);
    for (const c of mine) {
      expect(c.url.startsWith(BASE)).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    for (const m of PUBLICITE_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)) expect(m[1]!.startsWith(BASE), m[1]).toBe(true);
  });
});
