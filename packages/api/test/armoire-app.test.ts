import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ARMOIRE_CONFIRM, ARMOIRE_REFUSALS, ARMOIRE_SCRIPT, ARMOIRE_UNSURE } from '../app/armoire.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { fakeDocument, pageIds, type FakeElement } from './fake-dom.ts';

// Tout est inventé : clé, bien, trousseaux, agents, partenaire, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown, extra: Record<string, unknown> = {}): Answer => async () => Response.json({ ok: true, mode: 'essai', data, ...extra });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const offline: Answer = () => Promise.reject(new TypeError('hors ligne'));

const AT_AGENCY = { id: 'c1', number: 4, label: 'Porte d’entrée', propertyId: 'b1', state: 'armoire', holder: null, retirement: null };
const WITH_AGENT = {
  id: 'c2',
  number: 5,
  label: 'Cave',
  propertyId: 'b1',
  state: 'sorti',
  holder: { agentId: 'a2', name: 'Lou M.', since: '2027-03-02T08:00:00.000Z', purpose: 'visite', appointmentId: 'r1', dueAt: '2027-03-02T09:30:00.000Z' },
  retirement: null,
};
const WITH_PARTNER = {
  id: 'c3',
  number: 6,
  label: 'Garage',
  propertyId: 'b1',
  state: 'sorti',
  holder: null,
  partner: { partnerId: 'pa1', trade: 'diagnostiqueur', tradeLabel: 'Diagnostiqueur', businessName: 'Diag Inventé', responsible: { agentId: 'a1', name: 'Alex D.' }, since: '2027-03-02T10:00:00.000Z', purpose: 'diagnostic', dueAt: '2027-03-02T15:00:00.000Z' },
  retirement: null,
};
const LOST = { id: 'c4', number: 2, label: 'Boîte aux lettres', propertyId: 'b1', state: 'retire', holder: null, retirement: { reason: 'perdu', at: '2027-02-20T10:00:00.000Z' } };
const MOVES = [
  { loanId: 'l1', holder: { agentId: 'a2', name: 'Lou M.' }, purpose: 'estimation', appointmentId: 'r0', outAt: '2027-02-01T09:00:00.000Z', dueAt: '2027-02-01T10:00:00.000Z', returned: { outcome: 'rendu', at: '2027-02-01T10:10:00.000Z' } },
  { loanId: 'l2', holder: { agentId: 'a1', name: 'Alex D.' }, purpose: 'diagnostic', appointmentId: null, outAt: '2027-02-05T09:00:00.000Z', dueAt: '2027-02-05T15:00:00.000Z', returned: null, partner: { partnerId: 'pa1', trade: 'diagnostiqueur', businessName: 'Diag Inventé' } },
];

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
    'GET /v1/annonces': ok([{ id: 'b1', reference: 'REF-T-1', city: 'Dijon', state: null }]),
    'GET /v1/annonces/b1/controle': ok({ complete: true, items: [] }),
    'GET /v1/annonces/b1/brouillon': no(404, { ok: false, rule: null, code: 'no_draft' }),
    'GET /v1/annonces/b1/publication': ok(null),
    'GET /v1/trousseaux/biens/b1': ok([AT_AGENCY, WITH_AGENT, WITH_PARTNER, LOST]),
    'GET /v1/trousseaux/c1/mouvements': ok(MOVES),
    'POST /v1/trousseaux/biens/b1': ok(null, { keyId: 'c9', number: 12 }),
    'POST /v1/trousseaux/c1/rendu-au-proprietaire': ok(null),
    'POST /v1/trousseaux/c2/rendu': ok(null),
    'POST /v1/trousseaux/c2/perdu': ok(null),
    'POST /v1/trousseaux/c3/rendu': ok(null),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    Date,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push(init.body ? { method, url, body: JSON.parse(init.body) } : { method, url });
      const a = table[`${method} ${url}`];
      return a ? a() : offline();
    },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const vente = () => els['vente-corps']!;
  const byText = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const capture = (e: { target: unknown }) => (listeners as Record<string, ((e: unknown) => void) | undefined>).click?.(e);
  const press = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    capture({ target: b });
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => vente().all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/armoire.js');
  const openVente = () => press(byText(els.biens!, 'Mettre en vente'));
  const openArmoire = async (load = true) => {
    await press(byText(vente(), 'Ouvrir l’armoire'));
    const s = scripts();
    if (load && s.length === 1) {
      if (!context.loaded) runInNewContext(ARMOIRE_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const status = () => vente().all().find((e) => e.tagName === 'p' && e.className === 'etat' && e.attributes.role === 'status')?.textContent ?? '';
  const items = () => vente().all().filter((e) => e.tagName === 'li' && e.textContent.startsWith('Trousseau'));
  const item = (n: number) => items().find((li) => li.textContent.startsWith(`Trousseau n° ${n} `))!;
  const count = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length;
  return { els, calls, table, context, vente, byText, press, scripts, openVente, openArmoire, status, items, item, count };
}

describe('BR51 · L’armoire d’un bien dans l’écran « Mettre en vente »', () => {
  it('[R201] servi à part, chargé au seul geste, jamais gardé ; rien n’est lu avant ; le budget tient, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/armoire.js']).toBe(ARMOIRE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/armoire.js');
    const served = handleAgentApp(new Request('https://x.test/app/armoire.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: ARMOIRE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(ARMOIRE_SCRIPT).not.toContain('innerHTML');
    expect(JS).not.toContain("'/v1/trousseaux/biens");
    const t = await run();
    await t.openVente();
    expect(t.vente().textContent).toContain('Armoire des clés');
    expect(t.scripts()).toHaveLength(0);
    expect(t.count('GET', '/v1/trousseaux/biens/b1')).toBe(0);
    await t.openArmoire();
    expect(t.count('GET', '/v1/trousseaux/biens/b1')).toBe(1);
    expect(t.items()).toHaveLength(4);
  });

  it('[R271] chaque trousseau dit son numéro, son libellé et où il est, dans l’ordre du serveur, avec ses seuls gestes permis', async () => {
    const t = await run();
    await t.openVente();
    await t.openArmoire();
    expect(t.items().map((li) => li.children[0]!.textContent)).toEqual(['Trousseau n° 4 · Porte d’entrée', 'Trousseau n° 5 · Cave', 'Trousseau n° 6 · Garage', 'Trousseau n° 2 · Boîte aux lettres']);
    expect(t.item(4).textContent).toContain('À l’agence, dans l’armoire.');
    expect(t.item(5).textContent).toContain('Chez Lou M. depuis le 02/03/2027 à 09:00, pour « Visite ». À rendre au plus tard le 02/03/2027 à 10:30.');
    expect(t.item(6).textContent).toContain('Remis à Diag Inventé (Diagnostiqueur) par Alex D., qui en répond, le 02/03/2027 à 11:00, pour « Diagnostics ».');
    expect(t.item(2).textContent).toContain('Perdu, noté le 20/02/2027 à 11:00 : il ne sort plus.');
    const gestures = (n: number) => t.item(n).children.filter((e) => e.tagName === 'button').map((b) => b.textContent);
    expect(gestures(4)).toEqual(['Mouvements', 'Rendu au propriétaire']);
    expect(gestures(5)).toEqual(['Mouvements', 'Rendu à l’agence', 'Perdu']);
    expect(gestures(2)).toEqual(['Mouvements']);
    expect(t.status()).toBe('4 trousseaux, dont 2 dehors.');
    expect(t.vente().textContent).not.toMatch(/armoire'|sorti'|diagnostiqueur|pa1|a2/);
  });

  it('[R270] ranger envoie le seul libellé ; le numéro vient du serveur ; un libellé refusé le dit en mots', async () => {
    const t = await run();
    await t.openVente();
    await t.openArmoire();
    const input = t.vente().all().find((e) => e.id === null && e.attributes.id === 'armoire-libelle')!;
    const label = t.vente().all().find((e) => e.tagName === 'label' && e.attributes.for === 'armoire-libelle')!;
    expect(label.textContent).toContain('sans chiffre, adresse ni code');
    input.value = 'Cave';
    await t.press(t.byText(t.vente(), 'Ranger dans l’armoire'));
    expect(t.calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/v1/trousseaux/biens/b1', body: { label: 'Cave' } });
    expect(t.status()).toBe('Trousseau rangé sous le n° 12. 4 trousseaux, dont 2 dehors.');
    expect(t.count('GET', '/v1/trousseaux/biens/b1')).toBe(2);
    expect(input.value).toBe('');
    t.table['POST /v1/trousseaux/biens/b1'] = no(409, { ok: false, rule: 'R270', code: 'bad_label' });
    input.value = '12 rue Inventée';
    await t.press(t.byText(t.vente(), 'Ranger dans l’armoire'));
    expect(t.status()).toBe(ARMOIRE_REFUSALS.bad_label);
    expect(input.value).toBe('12 rue Inventée');
    // Trop court : rien ne part.
    const before = t.calls.length;
    input.value = ' ';
    await t.press(t.byText(t.vente(), 'Ranger dans l’armoire'));
    expect(t.calls.length).toBe(before);
    expect(t.status()).toBe(ARMOIRE_REFUSALS.bad_label);
  });

  it('[R271] les mouvements, du plus ancien au plus récent, avec qui, pour quoi, quand et le retour', async () => {
    const t = await run();
    await t.openVente();
    await t.openArmoire();
    await t.press(t.byText(t.item(4), 'Mouvements'));
    const moves = t.item(4).all().filter((e) => e.tagName === 'li').map((li) => li.textContent);
    expect(moves).toEqual([
      'Sorti par Lou M. le 01/02/2027 à 10:00, pour « Estimation » : revenu le 01/02/2027 à 11:10.',
      'Remis à Diag Inventé par Alex D. le 05/02/2027 à 10:00, pour « Diagnostics » : pas encore revenu, à rendre au plus tard le 05/02/2027 à 16:00.',
    ]);
    t.table['GET /v1/trousseaux/c2/mouvements'] = ok([]);
    await t.press(t.byText(t.item(5), 'Mouvements'));
    expect(t.item(5).textContent).toContain('Jamais sorti de l’armoire.');
  });

  it('[R271] « Perdu » et « Rendu au propriétaire » ne partent qu’au second appui ; un autre geste annule', async () => {
    const t = await run();
    await t.openVente();
    await t.openArmoire();
    await t.press(t.byText(t.item(5), 'Perdu'));
    expect(t.count('POST', '/v1/trousseaux/c2/perdu')).toBe(0);
    expect(t.status()).toBe(ARMOIRE_CONFIRM);
    // Un autre geste annule la demande.
    await t.press(t.byText(t.item(4), 'Mouvements'));
    expect(t.byText(t.item(5), 'Perdu')).toBeDefined();
    await t.press(t.byText(t.item(5), 'Perdu'));
    await t.press(t.byText(t.item(5), 'Confirmer : perdu'));
    expect(t.count('POST', '/v1/trousseaux/c2/perdu')).toBe(1);
    expect(t.status()).toBe('Trousseau n° 5 noté perdu : il ne sortira plus. 4 trousseaux, dont 2 dehors.');
    await t.press(t.byText(t.item(4), 'Rendu au propriétaire'));
    expect(t.count('POST', '/v1/trousseaux/c1/rendu-au-proprietaire')).toBe(0);
    await t.press(t.byText(t.item(4), 'Confirmer : rendu au propriétaire'));
    expect(t.count('POST', '/v1/trousseaux/c1/rendu-au-proprietaire')).toBe(1);
    expect(t.status()).toContain('Trousseau n° 4 noté rendu au propriétaire : il ne sortira plus.');
  });

  it('après une écriture l’armoire est relue ; un retour d’un partenaire passe par « Rendu à l’agence »', async () => {
    const t = await run();
    await t.openVente();
    await t.openArmoire();
    await t.press(t.byText(t.item(6), 'Rendu à l’agence'));
    expect(t.count('POST', '/v1/trousseaux/c3/rendu')).toBe(1);
    expect(t.count('GET', '/v1/trousseaux/biens/b1')).toBe(2);
    expect(t.status()).toBe('Trousseau n° 6 noté rendu à l’agence. 4 trousseaux, dont 2 dehors.');
  });

  it('une écriture sans réponse est dite incertaine, les gestes d’avant retirés ; un seul envoi à la fois', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = await run({ 'POST /v1/trousseaux/c2/rendu': () => new Promise<Response>((r) => (release = r)) });
    await t.openVente();
    await t.openArmoire();
    const back = t.byText(t.item(5), 'Rendu à l’agence')!;
    await t.press(back);
    await t.press(back);
    await t.press(t.byText(t.item(6), 'Rendu à l’agence'));
    expect(t.count('POST', '/v1/trousseaux/c2/rendu')).toBe(1);
    expect(t.count('POST', '/v1/trousseaux/c3/rendu')).toBe(0);
    release(new Response('panne', { status: 502 }));
    await settle();
    expect(t.status()).toBe(ARMOIRE_UNSURE);
    expect(t.items()).toHaveLength(0);
  });

  it('[R16] chaque refus se dit en mots, jamais par un code ; un état changé ailleurs fait relire l’armoire', async () => {
    const t = await run({ 'GET /v1/trousseaux/biens/b1': no(403, { ok: false, rule: 'R16', code: 'pas_son_bien' }) });
    await t.openVente();
    await t.openArmoire();
    expect(t.status()).toBe(ARMOIRE_REFUSALS.pas_son_bien);
    expect(t.status()).not.toMatch(/pas_son_bien|R16|403/);
    const u = await run({ 'POST /v1/trousseaux/c1/rendu-au-proprietaire': no(409, { ok: false, rule: 'R271', code: 'deja_retire' }) });
    await u.openVente();
    await u.openArmoire();
    await u.press(u.byText(u.item(4), 'Rendu au propriétaire'));
    await u.press(u.byText(u.item(4), 'Confirmer : rendu au propriétaire'));
    expect(u.status()).toBe(`${ARMOIRE_REFUSALS.deja_retire} 4 trousseaux, dont 2 dehors.`);
    expect(u.count('GET', '/v1/trousseaux/biens/b1')).toBe(2);
    const v = await run({ 'GET /v1/trousseaux/biens/b1': no(403, { ok: false, rule: 'R16', code: 'nouveau_code' }) });
    await v.openVente();
    await v.openArmoire();
    expect(v.status()).toBe('L’armoire ne se lit pas pour le moment.');
  });

  it('un texte reçu est posé en texte ; un identifiant douteux n’offre aucun geste', async () => {
    const t = await run({ 'GET /v1/trousseaux/biens/b1': ok([{ ...AT_AGENCY, id: 'mauvais id !', label: INJECTED }]) });
    await t.openVente();
    await t.openArmoire();
    expect(t.items()[0]!.textContent).toContain(INJECTED);
    expect(t.items()[0]!.children.filter((e) => e.tagName === 'button')).toHaveLength(0);
    expect(t.vente().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('le script arrivé après un changement d’écran ne dessine rien ; un second geste ne recharge pas le script', async () => {
    const t = await run();
    await t.openVente();
    await t.press(t.byText(t.vente(), 'Ouvrir l’armoire'));
    await t.press(t.byText(t.vente(), 'Ouvrir l’armoire'));
    expect(t.scripts()).toHaveLength(1);
    const late = t.scripts()[0]!;
    // L'écran est rouvert avant l'arrivée du script : l'ancienne zone ne s'ouvre pas.
    await t.openVente();
    runInNewContext(ARMOIRE_SCRIPT, t.context);
    late.listeners.load!({});
    await settle();
    expect(t.count('GET', '/v1/trousseaux/biens/b1')).toBe(0);
    // Le script est gardé en mémoire : la nouvelle zone s'ouvre sans le recharger.
    await t.press(t.byText(t.vente(), 'Ouvrir l’armoire'));
    expect(t.scripts()).toHaveLength(0);
    expect(t.count('GET', '/v1/trousseaux/biens/b1')).toBe(1);
    expect(t.items()).toHaveLength(4);
  });
});
