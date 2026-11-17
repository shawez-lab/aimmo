import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { COUT_AGENT_LOST, COUT_AGENT_POSTES, COUT_AGENT_REFUSALS, COUT_AGENT_SCRIPT } from '../app/cout-agent.ts';
import { PHASES_SCRIPT } from '../app/phases.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, factures, montants, raisons.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const parisMonth = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).slice(0, 7);
const shift = (month: string, by: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const n = y * 12 + (m - 1) + by;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
};
const NOW = parisMonth();
const MONTH = shift(NOW, -1);
const BASE = '/v1/recrutement/cout-agent';
const URL_MONTH = `${BASE}?mois=${MONTH}`;

const COSTS = { ia: 120000, clients_apportes: 80000, diffusion: 45050, accompagnement: 30000, conformite: 10000 };
const MONTH_DATA = {
  month: MONTH,
  complete: true,
  missing: [],
  settings: { version: 2, validFrom: MONTH, provisionBp: 250, marginBp: 1000 },
  agentsPresent: 4,
  feesCents: 2000000,
  networkShareCents: 600000,
  agentSharesCents: 1350000,
  sponsorSharesCents: 50000,
  costs: COSTS,
  provisionCents: 33750,
  fullCostCents: 318800,
  marginCents: 31880,
  requiredCents: 350680,
  averageAgent: { networkShareCents: 150000, requiredCents: 87670 },
  covered: true,
  networkBp: 3000,
  breakEvenNetworkBp: 1754,
  breakEvenUnreachable: false,
  aiMeasuredCents: 98765,
  lines: { files: [], invoices: [], unclassified: [] },
};
const INCOMPLETE = {
  ...MONTH_DATA,
  complete: false,
  covered: false,
  missing: ['reglage', 'factures_non_classees'],
  settings: null,
  breakEvenNetworkBp: null,
  networkBp: null,
  lines: { files: [], invoices: [], unclassified: ['fac-1', 'fac-2', INJECTED] },
};

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
    [`GET ${URL_MONTH}`]: ok(MONTH_DATA),
    [`POST ${BASE}/reglages`]: ok({ version: 3, validFrom: NOW, provisionBp: 1250, marginBp: 1005 }),
    [`POST ${BASE}/factures/fac-1/poste`]: ok({ invoiceId: 'fac-1', version: 1, category: 'diffusion' }),
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
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const corps = () => els['phases-corps']!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  // Les phases ne répondent pas ici (hors ligne) : la partie du coût se montre quand même.
  await click(els['phases-voir']);
  runInNewContext(PHASES_SCRIPT, context);
  scriptsOf(els.reseau!, '/app/phases.js')[0]!.listeners.load!({});
  await settle();
  const part = () => corps().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Coût de l’agent moyen')!;
  const button = (text: string) => part().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const buttons = () => part().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const status = () => part().all().find((e) => e.attributes.role === 'status')?.textContent ?? '';
  const texts = () => part().textContent;
  const byId = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const open = async (load = true) => {
    await click(button('Ouvrir le coût de l’agent moyen'));
    const s = scriptsOf(part(), '/app/cout-agent.js');
    if (load && s.length === 1 && !context.loaded) {
      runInNewContext(COUT_AGENT_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const fill = (from: string, prov: string, marg: string, reason: string) => {
    byId('cout-depuis').value = from;
    byId('cout-provision').value = prov;
    byId('cout-marge').value = marg;
    byId('cout-raison').value = reason;
  };
  return { els, calls, table, context, part, button, buttons, status, texts, click, open, posts, scriptsOf, byId, fill };
}

describe('BR108 · le coût de l’agent moyen à l’écran de la direction', () => {
  it('[R201] servi à part, chargé au seul geste depuis « Phases et régions », jamais gardé ; le budget tient, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/cout-agent.js']).toBe(COUT_AGENT_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/cout-agent.js');
    const served = handleAgentApp(new Request('https://x.test/app/cout-agent.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: COUT_AGENT_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: PHASES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/recrutement');
    expect(JS).not.toContain('/app/cout-agent.js');
    expect(COUT_AGENT_SCRIPT).not.toContain('innerHTML');
    expect(PHASES_SCRIPT).not.toContain('innerHTML');
    const t = await run();
    expect(t.part()).toBeDefined();
    expect(t.scriptsOf(t.part(), '/app/cout-agent.js')).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/recrutement'))).toBe(false);
    await t.open();
    expect(t.texts()).toContain('Agents présents');
    // Un second geste ne recharge pas le script : il relit le mois.
    await t.open(false);
    expect(t.scriptsOf(t.part(), '/app/cout-agent.js')).toHaveLength(1);
    expect(t.calls.filter((c) => c.url === URL_MONTH)).toHaveLength(2);
  });

  it('sans réseau au chargement du script, ou script sans écran : l’écran le dit et le bouton revient', async () => {
    const t = await run();
    await t.open(false);
    t.scriptsOf(t.part(), '/app/cout-agent.js')[0]!.listeners.error!({});
    await settle();
    expect(t.texts()).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.button('Ouvrir le coût de l’agent moyen') as unknown as { disabled: boolean }).disabled).toBe(false);
    const u = await run();
    await u.open(false);
    u.scriptsOf(u.part(), '/app/cout-agent.js')[0]!.listeners.load!({});
    await settle();
    expect(u.texts()).toContain('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('les communes à pourvoir restent à leur place, avant le coût, chacune avec son script', async () => {
    const t = await run();
    const titles = t.els['phases-corps']!.children.filter((e) => e.tagName === 'section').map((e) => e.children[0]!.textContent);
    expect(titles.indexOf('Communes à pourvoir')).toBeGreaterThanOrEqual(0);
    expect(titles.indexOf('Communes à pourvoir')).toBeLessThan(titles.indexOf('Coût de l’agent moyen'));
  });

  it('[R623, R624, R625] un mois complet : chaque chiffre du serveur dit en euros, couvert ou non, le seuil et la part du mois (Jamais vu)', async () => {
    const t = await run();
    await t.open();
    const select = t.byId('cout-mois');
    expect(select.value).toBe(MONTH);
    const options = select.children.map((o) => o.attributes.value!);
    expect(options).toHaveLength(12);
    expect(options).not.toContain(NOW);
    const x = t.texts();
    expect(x).toMatch(/Mois (de [a-zé]+|d’(avril|août|octobre)) \d{4}/);
    expect(x).toContain('La part du réseau couvre le coût complet de l’agent moyen, marge comprise.');
    expect(x).toContain('Seuil : 17,54 % des honoraires au réseau couvrent tout juste le coût, marge comprise ; ce mois, le réseau en a gardé 30 %.');
    expect(x).toContain('Honoraires encaissés, hors taxe20 000,00 €');
    expect(x).toContain('Part du réseau6 000,00 €');
    expect(x).toContain('Intelligence artificielle1 200,00 €');
    expect(x).toContain('Diffusion450,50 €');
    expect(x).toContain('Provision de fin de contrat337,50 €');
    expect(x).toContain('À couvrir3 506,80 €');
    expect(x).toContain('Agent moyen : à couvrir876,70 €');
    expect(x).toContain('Agents présents4');
    expect(x).toContain('IA mesurée message par message : 987,65 €, pour comparer aux factures ; hors calcul.');
    expect(x).toContain('provision 2,5 % des parts des agents, marge 10 % du coût complet.');
    // Aucun code ni nom de champ, aucun recalcul : pas de tri, pas d'addition.
    for (const code of ['complete', 'covered', 'networkBp', 'clients_apportes', 'true', 'false', 'undefined', 'NaN']) expect(x).not.toContain(code);
    expect(COUT_AGENT_SCRIPT).not.toMatch(/\.sort\(|\.reverse\(|\.reduce\(/);
    // Non couvert, ou seuil hors d'atteinte : dit en mots.
    const u = await run({ [`GET ${URL_MONTH}`]: ok({ ...MONTH_DATA, covered: false, breakEvenNetworkBp: null, breakEvenUnreachable: true }) });
    await u.open();
    expect(u.texts()).toContain('La part du réseau ne couvre pas le coût complet de l’agent moyen, marge comprise.');
    expect(u.texts()).toContain('Même tous les honoraires au réseau ne couvriraient pas le coût de ce mois.');
    const v = await run({ [`GET ${URL_MONTH}`]: ok({ ...MONTH_DATA, feesCents: 0, networkBp: null, breakEvenNetworkBp: null, averageAgent: null }) });
    await v.open();
    expect(v.texts()).toContain('Aucun honoraire encaissé ce mois : pas de seuil.');
    expect(v.texts()).not.toContain('Agent moyen');
  });

  it('[R623, R624] un mois incomplet n’est jamais dit couvert ; ce qui manque est dit, chaque facture sans poste se classe et le mois est relu', async () => {
    const t = await run({ [`GET ${URL_MONTH}`]: ok({ ...INCOMPLETE, covered: true }) });
    await t.open();
    const x = t.texts();
    expect(x).toContain('Mois incomplet : il n’est jamais dit couvert.');
    expect(x).not.toContain('La part du réseau couvre');
    expect(x).toContain('Aucun réglage de provision et de marge ne vaut pour ce mois.');
    // Des honoraires, mais pas de seuil tant que le mois est incomplet : jamais « aucun honoraire ».
    expect(x).toContain('Pas de seuil tant que le mois est incomplet.');
    expect(x).not.toContain('Aucun honoraire encaissé');
    // Un identifiant mal formé n'est ni montré ni envoyé.
    expect(x).toContain('2 factures du mois n’ont pas de poste.');
    expect(x).not.toContain(INJECTED);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(t.buttons()).toContain('Donner ce poste à la facture fac-1');
    expect(t.buttons()).toContain('Donner ce poste à la facture fac-2');
    // Sans poste choisi : rien ne part.
    await t.click(t.button('Donner ce poste à la facture fac-1'));
    expect(t.posts()).toEqual([]);
    expect(t.status()).toBe(COUT_AGENT_REFUSALS.bad_category);
    const sel = t.byId('cout-poste-0');
    expect(sel.children.map((o) => o.attributes.value)).toEqual(['', ...Object.keys(COUT_AGENT_POSTES)]);
    sel.value = 'diffusion';
    const reads = t.calls.filter((c) => c.url === URL_MONTH).length;
    await t.click(t.button('Donner ce poste à la facture fac-1'));
    expect(t.posts()).toEqual([{ method: 'POST', url: `${BASE}/factures/fac-1/poste`, body: { category: 'diffusion' }, auth: `Bearer ${KEY}` }]);
    expect(t.calls.filter((c) => c.url === URL_MONTH).length).toBe(reads + 1);
    expect(t.status()).toBe('Poste rangé pour la facture fac-1 : Diffusion.');
  });

  it('[R624] le réglage : à partir de ce mois ou d’un mois à venir, en pour cent changés en points de base, avec sa raison ; aucun montant n’est envoyé', async () => {
    const t = await run();
    await t.open();
    const from = t.byId('cout-depuis');
    const months = from.children.map((o) => o.attributes.value!);
    expect(months[0]).toBe(NOW);
    expect(months).toHaveLength(12);
    expect(months).not.toContain(MONTH);
    const save = () => t.click(t.button('Ranger ce réglage'));
    for (const [p, m] of [['', '10'], ['12,345', '10'], ['100,01', '10'], ['-1', '10'], ['abc', '10'], ['10', '1e2']]) {
      t.fill(NOW, p!, m!, 'Nouvelle provision');
      await save();
      expect(t.status()).toBe(COUT_AGENT_REFUSALS.bad_bp);
    }
    t.fill(MONTH, '12,5', '10', 'Nouvelle provision');
    await save();
    expect(t.status()).toBe(COUT_AGENT_REFUSALS.mois_passe);
    t.fill(NOW, '12,5', '10', 'ab');
    await save();
    expect(t.status()).toBe(COUT_AGENT_REFUSALS.bad_reason);
    expect(t.posts()).toEqual([]);
    t.fill(NOW, ' 12,5 ', '10.05', '  Provision   relevée après le pilote ');
    await save();
    expect(t.posts()).toEqual([
      { method: 'POST', url: `${BASE}/reglages`, body: { validFrom: NOW, provisionBp: 1250, marginBp: 1005, reason: 'Provision relevée après le pilote' }, auth: `Bearer ${KEY}` },
    ]);
    expect(t.status()).toMatch(/^Réglage rangé à partir (de|d’) .+ : provision 12,5 %, marge 10,05 %\.$/);
    // Aucune clé de montant : la route la refuserait [R624].
    for (const k of Object.keys(t.posts()[0]!.body as object)) expect(k).not.toMatch(/amount|montant|cents|eur|fee|honorair|price|prix|cout|cost/i);
    t.fill(NOW, '100', '0', 'Tout en provision');
    await save();
    expect((t.posts()[1]!.body as Record<string, unknown>).provisionBp).toBe(10000);
    expect((t.posts()[1]!.body as Record<string, unknown>).marginBp).toBe(0);
  });

  it('une réponse perdue est dite incertaine, jamais faite ni pas faite ; une panne du serveur aussi ; une écriture rangée reste dite si la relecture échoue', async () => {
    for (const answer of [() => Promise.reject(new TypeError('coupé')), no(503, { ok: false }), async () => new Response('panne', { status: 502 })]) {
      const t = await run({ [`POST ${BASE}/reglages`]: answer });
      await t.open();
      t.fill(NOW, '2', '10', 'Nouvelle provision');
      await t.click(t.button('Ranger ce réglage'));
      expect(t.status()).toBe(COUT_AGENT_LOST);
      expect(t.texts()).not.toContain('Réglage rangé');
    }
    let n = 0;
    const u = await run({ [`GET ${URL_MONTH}`]: () => (++n === 1 ? ok(MONTH_DATA)() : Promise.reject(new TypeError('coupé'))) });
    await u.open();
    u.fill(NOW, '2', '10', 'Nouvelle provision');
    await u.click(u.button('Ranger ce réglage'));
    expect(u.status()).toContain('Réglage rangé à partir');
    expect(u.status()).toContain('Pas de réseau. Réessayez dans un moment.');
  });

  it('une seule écriture à la fois ; seule la dernière lecture dessine', async () => {
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: { version: 3 } }))));
    const t = await run({ [`POST ${BASE}/reglages`]: slow });
    await t.open();
    t.fill(NOW, '2', '10', 'Nouvelle provision');
    await t.click(t.button('Ranger ce réglage'));
    await t.click(t.button('Ranger ce réglage'));
    expect(t.posts()).toHaveLength(1);
    release();
    await settle();
    expect(t.status()).toContain('Réglage rangé');
    let first: () => void = () => undefined;
    let n = 0;
    const u = await run({
      [`GET ${URL_MONTH}`]: () => {
        n += 1;
        if (n === 2) return new Promise<Response>((r) => (first = () => r(Response.json({ ok: true, mode: 'essai', data: { ...MONTH_DATA, agentsPresent: 99 } }))));
        return ok(MONTH_DATA)();
      },
    });
    await u.open();
    await u.click(u.button('Lire ce mois'));
    await u.click(u.button('Lire ce mois'));
    first();
    await settle();
    expect(u.texts()).toContain('Agents présents4');
    expect(u.texts()).not.toContain('99');
  });

  it('[R14, R625] la moyenne seule : aucun nom d’agent, aucun classement, aucun montant à saisir', async () => {
    const t = await run();
    await t.open();
    const inputs = t.part().all().filter((e) => e.tagName === 'input').map((e) => e.attributes.id);
    expect(inputs).toEqual(['cout-provision', 'cout-marge']);
    expect(t.part().all().filter((e) => ['meter', 'progress'].includes(e.tagName))).toEqual([]);
    const words = t.texts().toLowerCase().split(/[^a-zà-ÿ’]+/);
    for (const w of ['classement', 'rang', 'meilleur', 'meilleure', 'note', 'score']) expect(words).not.toContain(w);
  });

  it('[R16] droits : un refus se dit en mots ; l’écran ne lit et n’écrit que /v1/recrutement/cout-agent, la clé dans l’en-tête seul', async () => {
    const t = await run({ [`GET ${URL_MONTH}`]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.open();
    expect(t.status()).toBe(COUT_AGENT_REFUSALS.role);
    expect(t.texts()).not.toContain('role');
    const u = await run({ [`POST ${BASE}/reglages`]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await u.open();
    u.fill(NOW, '2', '10', 'Nouvelle provision');
    await u.click(u.button('Ranger ce réglage'));
    expect(u.status()).toBe(COUT_AGENT_REFUSALS.role);
    const mine = [...t.calls, ...u.calls].filter((c) => c.url.startsWith('/v1/recrutement'));
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const c of mine) {
      expect(c.url.startsWith(BASE)).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    expect(COUT_AGENT_SCRIPT).toContain(`'${BASE}'`);
    for (const m of COUT_AGENT_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)) expect(m[1]!.startsWith(BASE), m[1]).toBe(true);
  });

  it('[R623, R624] chaque refus connu de la couche métier et de la route a ses mots, jamais son code ; un code inconnu a un texte de secours', async () => {
    const core = readFileSync(new URL('../../core/src/reseau/cout-agent.ts', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../src/recrutement.ts', import.meta.url), 'utf8');
    const codes = new Set([...core.matchAll(/code: '([a-z_]+)'/g), ...route.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]!));
    expect(codes.size).toBeGreaterThanOrEqual(14);
    for (const c of codes) expect(COUT_AGENT_REFUSALS[c], c).toBeTruthy();
    const t = await run({ [`GET ${URL_MONTH}`]: ok(INCOMPLETE), [`POST ${BASE}/factures/fac-1/poste`]: no(409, { ok: false, rule: 'R623', code: 'deja_classee' }) });
    await t.open();
    t.byId('cout-poste-0').value = 'ia';
    await t.click(t.button('Donner ce poste à la facture fac-1'));
    expect(t.status()).toBe('Cette facture a déjà ce poste : relisez le mois.');
    const u = await run({ [`GET ${URL_MONTH}`]: no(409, { ok: false, rule: 'R624', code: 'month_not_finished' }) });
    await u.open();
    expect(u.status()).toBe(COUT_AGENT_REFUSALS.month_not_finished);
    const v = await run({ [`GET ${URL_MONTH}`]: no(409, { ok: false, rule: 'R624', code: 'code_jamais_vu' }) });
    await v.open();
    expect(v.status()).toBe('Le coût de l’agent moyen ne se lit pas pour le moment.');
    expect(v.texts()).not.toContain('code_jamais_vu');
  });
});
