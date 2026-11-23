import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { INVESTIR_SCRIPT } from '../app/investir.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : investisseurs, biens, communes, montants, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const line = (key: string, value: number, unit: string, source = 'calcul', hypothesis = 'formule écrite') => ({ key, value, unit, source, asOf: '2027-09-14T08:00:00.000Z', hypothesis });
// Des chiffres volontairement impossibles à retrouver par un calcul : l'écran doit montrer ceux du serveur, tels quels.
const RESULT = {
  status: 'complet',
  formulaVersion: 1,
  lines: [
    line('price', 15_000_000, 'cents', 'bien:b1', 'prix affiché du bien'),
    line('marketRentM2', 1235, 'cents_per_m2', 'Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin, millésime 2026', 'loyer central'),
    line('works', 1_000_000, 'cents', 'saisi:agent:a1', `devis ${INJECTED}`),
    line('vacancyMonths', 1, 'months', 'saisi:agent:a1', 'vacance réglée'),
    line('grossYieldBp', 777, 'bp'),
  ],
  grossYieldBp: { low: 611, central: 777, high: 905 },
  netYieldBp: { low: 302, central: 404, high: 506 },
};
const PROJECT = { projectId: 'p1', firstName: 'Inès', openedAt: '2027-09-01T08:00:00.000Z', profile: { budgetCents: 20_000_000, declaredDownPaymentCents: null, rentalTarget: 'furnished', sectors: ['99001'], targetGrossYieldBp: 350, deadline: null }, version: 2 };
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/investir/biens/sans-commune': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/investir/projets': ok([PROJECT, { ...PROJECT, projectId: 'p2', firstName: INJECTED, profile: null }]),
  'GET /v1/investir/projets/p1/profil': ok({ current: { profile: PROJECT.profile, version: 2 }, history: [] }),
  'GET /v1/investir/biens': ok([{ propertyId: 'b1', reference: 'REF-I-1', city: 'Commune Une', priceCents: 15_000_000, surfaceHundredths: 4500, inseeCode: '99001', rentKind: 'apartment' }]),
  'POST /v1/investir/calculs': ok({ id: 'c1', propertyId: 'b1', projectId: 'p1', inputs: {}, result: RESULT }),
  'POST /v1/investir/biens/b1/contraintes': ok({
    constraints: [{ kind: 'energie', status: 'interdit', text: 'Interdit à la location : classe énergie G, interdite à la location depuis le 01/01/2025.', source: 'fiche du bien b1, version 1' }],
    rentalBan: true,
    energyUnknown: false,
    alertsFirst: ['Interdit à la location : classe énergie G, interdite à la location depuis le 01/01/2025.'],
    computedAt: '2027-09-14T08:00:00.000Z',
  }),
  'POST /v1/investir/notes': ok({ id: 'n1', calculationId: 'c2', projectId: 'p1', origin: 'secours', text: `Interdit à la location : classe énergie G.\n\nLe bien coûte 171 250 € au total. ${INJECTED}`, textSha256: 'a'.repeat(64), status: 'a_valider' }),
  'POST /v1/investir/notes/n1/validation': ok({ id: 'n1', text: 'Interdit à la location : classe énergie G.', textSha256: 'a'.repeat(64), status: 'validee' }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['investir-corps']!;
  const state = () => els['investir-etat']!.textContent;
  const byText = (text: string, nth = 0) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text)[nth];
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const input = (label: string, nth = 0) => {
    const l = body().all().filter((e) => e.tagName === 'label' && e.textContent === label)[nth];
    if (!l) throw new Error(`libellé absent : ${label}`);
    return body().all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const scripts = () => els.investir!.children.filter((e) => e.tagName === 'script');
  // L'écran est chargé à sa première ouverture : le test pose le script servi, puis signale son chargement.
  const loadScript = async () => {
    const s = scripts();
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/investir.js']);
    runInNewContext(INVESTIR_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  const ouvrir = async () => {
    await click(els['investir-ouvrir']);
    if (scripts().length === 1 && !body().children.length) await loadScript();
  };
  const openP1 = async () => {
    await ouvrir();
    await click(byText('Ouvrir', 0));
  };
  const compute = async () => {
    await openP1();
    input('Frais d’acquisition, en % du prix').value = '7,5';
    input('Travaux estimés, en euros').value = '10 000';
    input('Charges non récupérables par an, en euros').value = '600';
    input('Provision pour charges récupérables par mois, en euros').value = '0';
    input('Taxe foncière par an, en euros').value = '900';
    input('Vacance, en mois par an').value = '1';
    await click(byText('Calculer'));
  };
  return { els, calls, table, context, byText, click, input, body, state, posts, scripts, loadScript, ouvrir, openP1, compute };
}

describe('Y09 · écran « Investir » de l’application', () => {
  it('[R16] l’écran ne lit et n’écrit que par les routes /v1/investir, la clé dans l’en-tête seul', async () => {
    const t = await run();
    await t.compute();
    await t.click(t.byText('Rédiger la note'));
    await t.click(t.byText('Je l’ai relue : valider la note'));
    const screen = t.calls.filter((c) => !/^\/v1\/(moi|plan-du-jour|alertes-agent|contacts-chauds|rendez-vous|usage|annonces$|offres\/a-tenir|apres-vente)/.test(c.url));
    expect(screen.length).toBeGreaterThanOrEqual(7);
    for (const c of screen) {
      expect(c.url.startsWith('/v1/investir'), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const screenJs = INVESTIR_SCRIPT.slice(INVESTIR_SCRIPT.indexOf('var INVESTIR_REFUSALS'), INVESTIR_SCRIPT.indexOf('function renderNote'));
    const routes = [...screenJs.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(3);
    // La seule lecture hors de /v1/investir : les biens de la personne, pour lui proposer ceux sans commune (X20).
    for (const r of routes) expect(r.startsWith('/v1/investir') || r === '/v1/annonces', r).toBe(true);
  });

  it('[R121] aucun chiffre n’est calculé sur le téléphone : l’écran montre ceux du serveur, avec leur source et leur hypothèse', async () => {
    const t = await run();
    await t.compute();
    const sent = JSON.parse(t.posts().find((c) => c.url === '/v1/investir/calculs')!.body!);
    // Les saisies, converties en centimes et en points de base, rien d'autre ; le loyer est demandé à la base.
    expect(sent).toMatchObject({
      propertyId: 'b1',
      projectId: 'p1',
      marketRentQuery: { inseeCode: '99001', kind: 'apartment' },
      inputs: { acquisitionFeesRateBp: { value: 750 }, works: { value: 1_000_000 }, nonRecoverableCharges: { value: 60_000 }, recoverableCharges: { value: 0 }, propertyTax: { value: 90_000 }, vacancyMonths: { value: 1 } },
    });
    expect(sent.inputs.marketRent).toBeUndefined();
    expect(sent.inputs.price).toBeUndefined();
    const text = t.body().textContent;
    // 7,77 %, 6,11 % et 9,05 % ne se calculent pas depuis les saisies : ils viennent du serveur.
    expect(text).toContain('Brut 7,77 %');
    expect(text).toContain('de 6,11 % à 9,05 %');
    expect(text).toContain('Net avant impôt 4,04 %');
    expect(text).toContain('Source : Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin, millésime 2026');
    expect(text).toContain('Hypothèse : loyer central.');
    // Un texte reçu reste un texte.
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(text).toContain(INJECTED);
    // Le script de l'écran ne porte aucune formule de rendement.
    const screenJs = INVESTIR_SCRIPT.slice(INVESTIR_SCRIPT.indexOf('var INVESTIR_REFUSALS'), INVESTIR_SCRIPT.indexOf('function renderNote'));
    expect(screenJs).not.toMatch(/\*\s*12|\*\s*10000|10000\s*\//);
  });

  it('AU100 · la trésorerie après prêt est dite simulation d’essai pour l’agent seul, jamais dans la note du client', async () => {
    const plain = await run();
    await plain.compute();
    expect(plain.body().textContent).not.toContain('Trésorerie après prêt');
    const RES = { ...RESULT, formulaVersion: 2, lines: [...RESULT.lines, line('monthlyCashflow', -12_300, 'cents')] };
    const t = await run({ 'POST /v1/investir/calculs': ok({ id: 'c1', propertyId: 'b1', projectId: 'p1', inputs: {}, result: RES }) });
    await t.compute();
    expect(t.body().textContent).toContain('Trésorerie après prêt : simulation d’essai pour vous seul, à valider par l’avocat. Elle n’entre jamais dans la note remise au client.');
  });

  it('[R124] l’alerte d’un bien classé G est en tête, avant tout chiffre', async () => {
    const t = await run();
    await t.compute();
    const nodes = t.body().all();
    const alert = nodes.findIndex((e) => e.className === 'alerte-energie');
    const firstFigure = nodes.findIndex((e) => e.className === 'rendement');
    expect(alert).toBeGreaterThanOrEqual(0);
    expect(alert).toBeLessThan(firstFigure);
    expect(nodes[alert]!.attributes.role).toBe('alert');
    expect(nodes[alert]!.textContent).toMatch(/^Interdit à la location/);
    // Sans contraintes lues, l'écran le dit, et ne montre pas un rendement comme si de rien n'était.
    const u = await run({ 'POST /v1/investir/biens/b1/contraintes': no(500, { ok: false }) });
    await u.compute();
    expect(u.body().all().find((e) => e.className === 'alerte-energie')!.textContent).toBe('Contraintes indisponibles : aucune proposition sans elles.');
  });

  it('[R126] les curseurs d’hypothèses font recalculer et réécrire la note par le serveur ; la validation renvoie l’empreinte du texte lu', async () => {
    const t = await run();
    await t.compute();
    t.input('Vacance, en mois par an', 1).value = '3';
    t.input('Travaux, en euros').value = '25 000';
    t.input('Loyer de marché retenu').value = 'low';
    await t.click(t.byText('Rédiger la note'));
    const note = JSON.parse(t.posts().find((c) => c.url === '/v1/investir/notes')!.body!);
    expect(note).toMatchObject({ calculationId: 'c1', projectId: 'p1', hypotheses: { vacancyMonths: 3, worksCents: 2_500_000, rent: 'low' } });
    const shown = t.body().all().find((e) => e.className === 'note-texte')!;
    expect(shown.textContent.startsWith('Interdit à la location')).toBe(true);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    await t.click(t.byText('Je l’ai relue : valider la note'));
    const v = t.posts().find((c) => c.url === '/v1/investir/notes/n1/validation')!;
    expect(JSON.parse(v.body!)).toMatchObject({ textSha256: 'a'.repeat(64) });
    expect(t.state()).toBe('Note validée : elle peut être montrée au client.');
  });

  it('[R123] le profil n’a aucun champ de revenus, d’emploi, de patrimoine ni de crédit ; une nouvelle version est rangée', async () => {
    const t = await run({ 'POST /v1/investir/projets/p1/profil': ok({ created: true }) });
    await t.openP1();
    // AU100 · le financement du calcul d'un bien (simulation d'essai de l'agent) n'est pas le profil de la personne.
    const LOAN = ['inv-pret', 'inv-taux', 'inv-duree', 'inv-assurance'];
    const labels = t.body().all().filter((e) => e.tagName === 'label' && !LOAN.includes(String(e.attributes.for))).map((e) => e.textContent.toLowerCase());
    expect(t.body().all().filter((e) => e.tagName === 'label' && LOAN.includes(String(e.attributes.for)))).toHaveLength(4);
    for (const l of labels) expect(l, l).not.toMatch(/revenu|salaire|emploi|employeur|patrimoine|épargne|crédit|prêt|solvab|banque/);
    t.input('Budget, en euros').value = '180 000';
    t.input('Secteurs : codes INSEE des communes, séparés par des virgules').value = '99001, 2a004';
    await t.click(t.byText('Ranger le profil'));
    const sent = JSON.parse(t.posts().find((c) => c.url === '/v1/investir/projets/p1/profil')!.body!);
    expect(sent).toEqual({
      changes: { budgetCents: 18_000_000, declaredDownPaymentCents: null, targetGrossYieldBp: 350, rentalTarget: 'furnished', deadline: null, sectors: ['99001', '2A004'] },
      from: 'client_dit',
    });
  });

  it('les refus sont dits en français, sans code ; hors réseau, rien n’est enregistré', async () => {
    const t = await run({ 'POST /v1/investir/calculs': no(409, { ok: false, rule: 'R122', code: 'loyer_saisi' }) });
    await t.compute();
    expect(t.state()).toBe('Le loyer de marché vient de la base, il ne se saisit pas.');
    const u = await run();
    await u.openP1();
    u.input('Frais d’acquisition, en % du prix').value = 'sept';
    await u.click(u.byText('Calculer'));
    expect(u.state()).toBe('Un champ n’est pas valable : vérifiez la saisie.');
    expect(u.posts()).toHaveLength(0);
  });

  it('l’accueil ouvre la liste des investisseurs ; un prénom reçu reste du texte', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.els.investir!.hidden).toBe(false);
    expect(t.els.accueil!.hidden).toBe(true);
    const text = t.body().textContent;
    expect(text).toContain('Inès');
    expect(text).toContain('Budget 200 000,00 € · Location meublée · Rendement brut attendu 3,50 % · Secteurs 99001');
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    await t.click(t.els['investir-retour']);
    expect(t.els.accueil!.hidden).toBe(false);
  });

  it('[R201] l’écran est un script à part, chargé une seule fois à sa première ouverture, jamais gardé sur l’appareil', async () => {
    expect(JS).not.toContain('var INVESTIR_REFUSALS');
    expect(JS).not.toContain('/v1/investir');
    expect(AGENT_APP_SHELL).not.toContain('/app/investir.js');
    // Le script tient le budget d'une page, et l'application le sien.
    expect(budgetProblems({ html: '', js: INVESTIR_SCRIPT }, BUDGETS.page)).toEqual([]);
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/investir.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(await served.text()).toBe(INVESTIR_SCRIPT);
    const t = await run();
    await t.click(t.els['investir-ouvrir']);
    expect(t.state()).toBe('Chargement…');
    expect(t.calls.some((c) => c.url.startsWith('/v1/investir'))).toBe(false);
    await t.loadScript();
    expect(t.body().textContent).toContain('Inès');
    // Seconde ouverture : le script déjà chargé sert, rien n'est demandé de nouveau.
    await t.click(t.els['investir-retour']);
    await t.click(t.els['investir-ouvrir']);
    expect(t.scripts()).toHaveLength(1);
    expect(t.body().textContent).toContain('Inès');
  });

  it('sans réseau, le chargement le dit ; un script arrivé après un changement d’écran ne montre rien', async () => {
    const t = await run();
    await t.click(t.els['investir-ouvrir']);
    t.scripts()[0]!.listeners.error!({});
    await new Promise((r) => setTimeout(r, 0));
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    const u = await run();
    await u.click(u.els['investir-ouvrir']);
    await u.click(u.els['investir-retour']);
    runInNewContext(INVESTIR_SCRIPT, u.context);
    u.scripts()[0]!.listeners.load!({});
    await new Promise((r) => setTimeout(r, 0));
    expect(u.calls.some((c) => c.url.startsWith('/v1/investir'))).toBe(false);
    expect(u.els.accueil!.hidden).toBe(false);
  });
});

describe('X20 · ranger la commune d’un bien', () => {
  const MISSING = { 'GET /v1/investir/biens/sans-commune': ok([{ propertyId: 'b2', reference: 'REF-I-2', city: 'Commune Deux', postalCode: '21000' }]) };
  const POST = 'POST /v1/investir/biens/b2/commune';
  const RENT = (code: string, status = 'inconnu') => ({ [`GET /v1/investir/loyers?insee=${code}&type=apartment`]: ok({ status }) });
  const open = async (answers: Record<string, Answer> = {}) => {
    const t = await run({ ...MISSING, ...RENT('21231'), ...answers });
    await t.openP1();
    return t;
  };
  const fill = (t: Awaited<ReturnType<typeof open>>, code = '21231') => {
    t.input('Bien', 1).value = 'b2';
    t.input('Code INSEE de la commune').value = code;
    t.input('Type de logement').value = 'apartment';
  };
  const go = (t: Awaited<ReturnType<typeof open>>) => t.click(t.byText('Ranger la commune'));

  it('les biens viennent de la lecture du socle, et rien n’est choisi d’avance', async () => {
    const t = await open();
    const box = t.input('Bien', 1);
    expect(box.children.map((o) => o.value)).toEqual(['', 'b2']);
    expect(box.value).toBe('');
    expect(t.input('Type de logement').value).toBe('');
  });

  it('[R122] le premier appui confronte le code au loyer connu et dit que c’est sans retour ; une saisie changée redemande', async () => {
    const t = await open({ [POST]: ok(null), ...RENT('21166', 'connu') });
    fill(t);
    await go(t);
    expect(t.posts()).toEqual([]);
    expect(t.body().textContent).toContain('Aucun loyer de marché n’est connu pour ce code.');
    expect(t.body().textContent).toContain('Le code 21231 ne pourra plus être changé pour ce bien.');
    t.input('Code INSEE de la commune').value = '21166';
    await go(t);
    expect(t.posts()).toEqual([]);
    expect(t.body().textContent).toContain('Un loyer de marché est connu pour ce code.');
    await go(t);
    expect(t.posts().map((c) => [c.url, c.body])).toEqual([['/v1/investir/biens/b2/commune', JSON.stringify({ inseeCode: '21166', rentKind: 'apartment' })]]);
    expect(t.state()).toBe('Commune rangée.');
  });

  it('[R122] le code postal du bien saisi à la place du code INSEE est signalé ; un loyer non lu est dit tel', async () => {
    const t = await open();
    fill(t, '21000');
    await go(t);
    const text = t.body().textContent;
    expect(text).toContain('Attention : 21000 est le code postal du bien');
    expect(text).toContain('Le loyer de marché de ce code n’a pas pu être lu.');
    expect(t.posts()).toEqual([]);
  });

  it('un code mal écrit ou un choix manquant ne part pas ; la Corse passe', async () => {
    const t = await open({ [POST]: ok(null), ...RENT('2A004') });
    fill(t, '123');
    await go(t);
    await go(t);
    expect(t.posts()).toEqual([]);
    expect(t.body().textContent).toContain('Le code INSEE a 5 caractères');
    t.input('Type de logement').value = '';
    t.input('Code INSEE de la commune').value = '21231';
    await go(t);
    expect(t.body().textContent).toContain('Choisissez le bien et le type de logement.');
    fill(t, '2a004');
    await go(t);
    await go(t);
    expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ inseeCode: '2A004', rentKind: 'apartment' });
  });

  it.each([
    [403, { ok: false, rule: 'R16', code: 'not_assigned' }, 'Ce bien n’est pas dans vos droits.'],
    [409, { ok: false, rule: 'R122', code: 'deja_rangee' }, 'Une commune est déjà rangée pour ce bien'],
    [409, { ok: false, rule: 'R122', code: 'autre_departement' }, 'Ce code n’est pas du département du bien'],
    [409, { ok: false, rule: 'R122', code: 'pas_un_logement' }, 'Ce bien n’est pas un logement'],
    [400, { ok: false, code: 'invalid_body' }, 'La commune n’a pas pu être rangée.'],
  ] as [number, unknown, string][])('[R16] refus %i : dit en français, sans code', async (status, answer, text) => {
    const t = await open({ [POST]: no(status, answer) });
    fill(t);
    await go(t);
    await go(t);
    expect(t.body().textContent).toContain(text);
    expect(t.body().textContent).not.toMatch(/deja_rangee|not_assigned|invalid_body|autre_departement|pas_un_logement/);
  });

  it.each([
    ['hors ligne', () => Promise.reject(new TypeError('hors ligne'))],
    ['une panne', async () => Response.json({ ok: false }, { status: 500 })],
    ['un succès coupé', async () => new Response('{"ok":tr', { status: 200 })],
  ] as [string, Answer][])('réponse perdue (%s) : dite telle', async (_n, answer) => {
    const t = await open({ [POST]: answer });
    fill(t);
    await go(t);
    await go(t);
    expect(t.body().textContent).toContain('la commune a peut-être été rangée');
  });

  it('un seul envoi à la fois', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = await open({ [POST]: () => new Promise<Response>((r) => { release = r; }) });
    fill(t);
    await go(t);
    await go(t);
    await go(t);
    expect(t.posts().length).toBe(1);
    release(Response.json({ ok: false, rule: 'R122', code: 'deja_rangee' }, { status: 409 }));
    await settle();
    expect(t.body().textContent).toContain('Une commune est déjà rangée');
  });

  it('une liste non lue n’est jamais dite vide, et son échec est dit', async () => {
    const t = await open({ 'GET /v1/investir/biens': no(500, { ok: false }) });
    expect(t.body().textContent).toContain('La liste des biens n’a pas pu être lue.');
    expect(t.body().textContent).not.toContain('Aucun bien calculable');
    const n = await open({ 'GET /v1/investir/biens/sans-commune': no(500, { ok: false }) });
    expect(n.byText('Ranger la commune')).toBeUndefined();
    expect(n.body().textContent).toContain('La liste des biens sans commune n’a pas pu être lue.');
  });

  it('aucun bien sans commune : aucun bloc', async () => {
    const t = await open({ 'GET /v1/investir/biens/sans-commune': ok([]) });
    expect(t.byText('Ranger la commune')).toBeUndefined();
  });
});

describe('Y14 · retrouver les calculs et les notes d’un projet', () => {
  const HISTORY = {
    calculs: [
      { id: 'c1', createdAt: '2027-09-14T08:00:00.000Z', status: 'complet', reference: INJECTED },
      { id: 'c2', createdAt: '2027-09-13T08:00:00.000Z', status: 'incomplet', reference: null },
    ],
    notes: [
      { id: 'n1', calculationId: 'c1', createdAt: '2027-09-14T09:00:00.000Z', status: 'validee', validatedAt: '2027-09-15T09:00:00.000Z', reference: 'REF-I-1' },
      { id: 'n2', calculationId: 'c1', createdAt: '2027-09-14T10:00:00.000Z', status: 'a_valider', validatedAt: null, reference: 'REF-I-1' },
    ],
    more: true,
    hidden: 2,
  };
  const OPEN = 'Voir les calculs et les notes';
  const HIST = 'GET /v1/investir/projets/p1/historique';

  it('[R16] rien n’est lu avant le geste ; la liste dit les chiffres rangés, ce qui manque et ce qui est sorti', async () => {
    const t = await run({ [HIST]: ok(HISTORY) });
    await t.openP1();
    expect(t.calls.some((c) => c.url.endsWith('/historique'))).toBe(false);
    await t.click(t.byText(OPEN));
    const text = t.body().textContent;
    expect(text).toContain(`Calcul du 14/09/2027, bien ${INJECTED}`);
    // Aucun rendement dans la liste : il ne se montre qu'avec les alertes du jour [R124].
    expect(text).not.toContain('7,77');
    expect(text).toContain('Incomplet : aucun rendement.');
    expect(text).toContain('Validée le 15/09/2027 : relisez-la');
    expect(text).toContain('Pas encore validée.');
    expect(text).toContain('2 ligne(s) portent sur un bien hors de vos droits');
    expect(text).toContain('Seules les plus récentes sont montrées.');
    expect(t.body().all().filter((e) => e.tagName === 'img')).toEqual([]);
  });

  const NOTE_D = { status: 'validee', createdAt: '2027-09-14T09:00:00.000Z', validatedAt: '2027-09-15T09:00:00.000Z', held: false, alertsFirst: [], note: { text: `Texte rangé ${INJECTED}` } };
  const CALC = { calculation: { id: 'c1', createdAt: '2027-09-14T08:00:00.000Z', result: RESULT }, alertsFirst: ['Interdit à la location : classe énergie G.'] };

  it('[R17] [R124] relire montre les alertes du jour d’abord, puis le calcul rangé, sa date et ses hypothèses, sans rien écrire', async () => {
    const t = await run({
      [HIST]: ok(HISTORY),
      'GET /v1/investir/calculs/c1/relecture': ok(CALC),
      'GET /v1/investir/notes/n1/relecture': ok(NOTE_D),
      'GET /v1/investir/notes/n2/relecture': ok({ ...NOTE_D, status: 'a_valider', validatedAt: null, note: { text: 'Brouillon rangé' } }),
    });
    await t.openP1();
    const before = t.posts().length;
    await t.click(t.byText(OPEN));
    await t.click(t.byText('Relire', 0));
    const text = t.body().textContent;
    expect(text).toContain('Calcul du 14/09/2027, tel qu’il a été rangé');
    expect(text).toContain('Brut 7,77 %');
    expect(text).toContain('Hypothèse : prix affiché du bien');
    expect(text).toContain(`devis ${INJECTED}`);
    expect(text.indexOf('Interdit à la location')).toBeLessThan(text.indexOf('Brut 7,77 %'));
    expect(t.body().all().find((e) => e.textContent === CALC.alertsFirst[0])!.attributes.role).toBe('alert');
    await t.click(t.byText('Relire', 2));
    expect(t.body().textContent).toContain('Note validée le 15/09/2027');
    expect(t.body().textContent).toContain(`Texte rangé ${INJECTED}`);
    expect(t.body().textContent).not.toContain('tel qu’il a été rangé');
    await t.click(t.byText('Relire', 3));
    expect(t.body().textContent).toContain('Elle ne se montre pas au client.');
    expect(t.byText('Je l’ai relue : valider la note')).toBeUndefined();
    expect(t.posts().length).toBe(before);
  });

  it('[R124] une note validée qui ne tient plus est dite retenue, sans son texte ; sans contraintes, ni chiffre ni texte', async () => {
    const held = await run({ [HIST]: ok(HISTORY), 'GET /v1/investir/notes/n1/relecture': ok({ ...NOTE_D, held: true, note: null, alertsFirst: ['Interdit à la location : classe énergie G.'] }) });
    await held.openP1();
    await held.click(held.byText(OPEN));
    await held.click(held.byText('Relire', 2));
    expect(held.body().textContent).toContain('Note retenue');
    expect(held.body().textContent).toContain('Le client ne la reçoit pas.');
    expect(held.body().textContent).toContain('Interdit à la location');
    const blind = await run({ [HIST]: ok(HISTORY), 'GET /v1/investir/calculs/c1/relecture': ok({ calculation: CALC.calculation }) });
    await blind.openP1();
    await blind.click(blind.byText(OPEN));
    await blind.click(blind.byText('Relire', 0));
    expect(blind.body().textContent).toContain('Contraintes indisponibles');
    expect(blind.body().textContent).not.toContain('7,77');
  });

  it('[R16] [R10] un refus, une panne ou une liste vide se disent, sans se confondre', async () => {
    const refused = await run({ [HIST]: no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await refused.openP1();
    await refused.click(refused.byText(OPEN));
    expect(refused.body().textContent).toContain('Ce n’est pas dans vos droits.');
    const lost = await run({});
    await lost.openP1();
    await lost.click(lost.byText(OPEN));
    expect(lost.body().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
    expect(lost.body().textContent).not.toContain('Aucun calcul rangé');
    const broken = await run({ [HIST]: ok(null) });
    await broken.openP1();
    await broken.click(broken.byText(OPEN));
    expect(broken.body().textContent).toContain('Lecture indisponible pour le moment.');
    const empty = await run({ [HIST]: ok({ calculs: [], notes: [], more: false, hidden: 0 }) });
    await empty.openP1();
    await empty.click(empty.byText(OPEN));
    expect(empty.body().textContent).toContain('Aucun calcul rangé pour ce projet.');
  });

  it('[R16] relire un calcul refusé le dit, et ne montre aucun chiffre ; un identifiant mal formé n’est jamais demandé', async () => {
    const t = await run({
      [HIST]: ok({ ...HISTORY, calculs: [HISTORY.calculs[0], { ...HISTORY.calculs[1], id: '../x' }] }),
      'GET /v1/investir/calculs/c1/relecture': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }),
    });
    await t.openP1();
    await t.click(t.byText(OPEN));
    await t.click(t.byText('Relire', 0));
    expect(t.body().textContent).toContain('Ce n’est pas dans vos droits.');
    expect(t.body().textContent).not.toContain('tel qu’il a été rangé');
    expect(t.calls.some((c) => c.url.includes('..'))).toBe(false);
  });

  it('[R201] l’écran tient son budget', () => {
    expect(budgetProblems({ html: '', js: INVESTIR_SCRIPT }, BUDGETS.page)).toEqual([]);
  });
});
