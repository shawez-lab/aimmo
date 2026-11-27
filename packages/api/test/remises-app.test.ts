import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import { REMISES_CONFIRM, REMISES_ELSEWHERE, REMISES_LOST, REMISES_NONE_NOW, REMISES_NONE_TODAY, REMISES_RANDOM, REMISES_REFUSALS, REMISES_SCRIPT } from '../app/remises.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp, stripCommentLines } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds, placeTool } from './fake-dom.ts';

// Tout est inventé : clé, fournisseurs, partenaires, bien, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown, extra: Record<string, unknown> = {}): Answer => async () => Response.json({ ok: true, mode: 'essai', data, ...extra });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const PHOTO = { id: 'd1', category: 'photographe', supplier: 'Photo Inventée', partnerId: null, beneficiary: 'agent', title: 'Reportage à prix réseau', terms: '20 % sur le reportage complet.', source: 'Devis du 2 mars', moment: 'mandat', validFrom: '2027-01-01', validUntil: '2027-12-31' };
const DEMENAGEUR = { id: 'd2', category: 'demenageur', supplier: 'Cartons Inventés', partnerId: 'pa2', beneficiary: 'client', title: 'Déménagement', terms: '10 % pour le client.', source: 'Contrat cadre', moment: 'mandat', validFrom: '2027-01-01', validUntil: '2027-06-30' };
const ARTISAN = { ...DEMENAGEUR, id: 'd3', category: 'artisan', supplier: 'Artisan Inventé', title: 'Petits travaux' };
const WHY = 'Mandat inscrit au registre, annonce pas encore en vente.';

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function context(role: string, table: Record<string, Answer>, calls: { method: string; url: string; body: Record<string, unknown> | null }[], document: unknown) {
  return {
    document,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const a = table[`${method} ${url}`] ?? (method === 'GET' && url === '/v1/moi' ? ok({ role, firstName: null }) : undefined);
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  } as Record<string, unknown>;
}
const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
const btn = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
const statusOf = (root: FakeElement) => root.all().find((e) => e.attributes.role === 'status')?.textContent ?? '';

/** La direction, sur l'écran du réseau, sous « Engagements de service ». */
async function desk(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  (document as { body?: FakeElement }).body = new FakeElement('body');
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/gagner/engagements': ok([]),
    'GET /v1/remises': ok([PHOTO, DEMENAGEUR]),
    'POST /v1/remises': ok(null, { discountId: 'd9' }),
    'POST /v1/remises/d1/retrait': ok(null),
    ...answers,
  };
  const ctx = context('direction', table, calls, document);
  runInNewContext(JS, ctx);
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  await click(els['engagements-voir']);
  runInNewContext(ENGAGEMENTS_SCRIPT, ctx);
  scriptsOf(els.reseau!, '/app/engagements.js')[0]!.listeners.load!({});
  await settle();
  const part = () => els['engagements-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Remises négociées')!;
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const set = (id: string, value: string) => {
    const f = input(`remise-${id}`);
    f.value = value;
    f.listeners.change?.({});
  };
  const open = async () => {
    await click(btn(part(), 'Ouvrir les remises'));
    const s = scriptsOf(part(), '/app/remises.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(REMISES_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const fill = () => {
    set('categorie', 'photographe');
    set('pour', 'agent');
    set('moment', 'mandat');
    set('fournisseur', 'Photo Inventée');
    set('titre', 'Reportage');
    set('conditions', '20 % sur le reportage.');
    set('source', 'Devis du 2 mars');
    set('debut', '2027-01-01');
    set('fin', '2027-12-31');
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, part, input, set, fill, open, click, posts, status: () => statusOf(part()), button: (t: string) => btn(part(), t) };
}

/** L'agent du bien, dans l'écran « Mettre en vente ». */
async function bien(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/annonces': ok([{ id: 'b1', reference: 'REF-T-1', city: 'Dijon', state: null }]),
    'GET /v1/annonces/b1/controle': ok({ complete: true, items: [] }),
    'GET /v1/annonces/b1/brouillon': no(404, { ok: false, rule: null, code: 'no_draft' }),
    'GET /v1/annonces/b1/publication': ok(null),
    'GET /v1/remises/biens/b1': ok({ propertyId: 'b1', moment: 'mandat', forAgent: [{ ...PHOTO, why: WHY }], forClient: [{ ...DEMENAGEUR, why: WHY }, { ...ARTISAN, why: WHY }] }),
    'POST /v1/remises/d1/biens/b1/ecarter': ok(null),
    ...answers,
  };
  const ctx = context('agent', table, calls, document);
  runInNewContext(JS, ctx);
  listeners.DOMContentLoaded!();
  await settle();
  const vente = () => els['vente-corps']!;
  const press = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    (listeners as Record<string, ((e: unknown) => void) | undefined>).click?.({ target: b });
    b.listeners.click!({});
    await settle();
  };
  await press(placeTool(els, 'Mettre en vente'));
  const block = () => vente().children.find((e) => e.tagName === 'section' && btn(e, 'Remises du moment'))!;
  const open = async () => {
    await press(btn(block(), 'Remises du moment'));
    const s = scriptsOf(els.fiche!, '/app/remises.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(REMISES_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const gets = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/v1/remises'));
  return { els, calls, table, block, open, press, gets, status: () => statusOf(block()), button: (t: string) => btn(block(), t), texts: () => block().textContent };
}

describe('BR73 · les remises négociées à l’écran', () => {
  it('[R201] un seul script servi à part, chargé au seul geste par les deux portes ; budgets tenus, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/remises.js']).toBe(REMISES_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/remises.js');
    const served = handleAgentApp(new Request('https://x.test/app/remises.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: REMISES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: ENGAGEMENTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/remises');
    expect(REMISES_SCRIPT).not.toContain('innerHTML');
    const d = await desk();
    expect(scriptsOf(d.part(), '/app/remises.js')).toHaveLength(0);
    expect(d.calls.some((c) => c.url === '/v1/remises')).toBe(false);
    await d.open();
    expect(d.calls.filter((c) => c.url === '/v1/remises')).toHaveLength(1);
    // Les autres écrans sous les engagements gardent leur entrée.
    expect(d.els['engagements-corps']!.children.some((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Scénarios automatiques')).toBe(true);
    const b = await bien();
    expect(b.block()).toBeDefined();
    expect(b.gets()).toHaveLength(0);
    await b.open();
    expect(b.gets()).toHaveLength(1);
    // Un second geste ne recharge pas le script : il relit les remises.
    await b.open();
    expect(scriptsOf(b.els.fiche!, '/app/remises.js')).toHaveLength(1);
    expect(b.gets()).toHaveLength(2);
    // L'armoire du bien reste.
    expect(b.els['vente-corps']!.textContent).toContain('Armoire des clés');
  });

  it('[R266] le catalogue du jour dit en mots : catégorie, fournisseur, pour qui, moment, dates, source', async () => {
    const d = await desk();
    await d.open();
    const text = d.part().textContent;
    expect(text).toContain('Photographe · Photo Inventée');
    expect(text).toContain('Pour l’agent · Mandat inscrit au registre · du 01/01/2027 au 31/12/2027.');
    expect(text).toContain('Source : Devis du 2 mars');
    expect(text).toContain('Déménageur · Cartons Inventés');
    expect(text).toContain('Pour le client');
    const empty = await desk({ 'GET /v1/remises': ok([]) });
    await empty.open();
    expect(empty.status()).toBe('Aucune remise en vigueur aujourd’hui.');
  });

  it('[R266] ranger : tous les champs envoyés, puis le catalogue relu ; source et dates exigées avant l’appel', async () => {
    const d = await desk();
    await d.open();
    d.fill();
    await d.click(d.button('Ranger la remise'));
    expect(d.posts()).toEqual([
      {
        method: 'POST',
        url: '/v1/remises',
        body: { category: 'photographe', beneficiary: 'agent', moment: 'mandat', supplier: 'Photo Inventée', title: 'Reportage', terms: '20 % sur le reportage.', source: 'Devis du 2 mars', validFrom: '2027-01-01', validUntil: '2027-12-31' },
      },
    ]);
    expect(d.status()).toBe('Remise rangée.');
    expect(d.calls.filter((c) => c.method === 'GET' && c.url === '/v1/remises')).toHaveLength(2);
    // Sans source, ou sans date de fin : le refus en mots, et rien ne part.
    const e = await desk();
    await e.open();
    e.fill();
    e.set('source', ' ');
    await e.click(e.button('Ranger la remise'));
    expect(e.status()).toBe(REMISES_REFUSALS.sans_source);
    e.set('source', 'Devis');
    e.set('fin', '');
    await e.click(e.button('Ranger la remise'));
    expect(e.status()).toBe(REMISES_REFUSALS.bad_date);
    e.set('fin', '2026-12-31');
    await e.click(e.button('Ranger la remise'));
    expect(e.status()).toBe(REMISES_REFUSALS.bad_date);
    expect(e.posts()).toEqual([]);
  });

  it('[R76] diagnostiqueur, déménageur, artisan : pour le client seul, à l’écran comme au serveur', async () => {
    const d = await desk();
    await d.open();
    d.fill();
    d.set('categorie', 'demenageur');
    await d.click(d.button('Ranger la remise'));
    expect(d.status()).toBe(REMISES_REFUSALS.client_seulement);
    expect(d.posts()).toEqual([]);
    // Le serveur refuse aussi : son refus est dit en mots, jamais son code.
    const s = await desk({ 'POST /v1/remises': no(409, { ok: false, rule: 'R76', code: 'client_seulement' }) });
    await s.open();
    s.fill();
    await s.click(s.button('Ranger la remise'));
    expect(s.status()).toBe(REMISES_REFUSALS.client_seulement);
    expect(s.status()).not.toContain('client_seulement');
    // Une remise du client n'a pas le moment « toujours ».
    const m = await desk();
    await m.open();
    m.fill();
    m.set('pour', 'client');
    m.set('moment', 'toujours');
    await m.click(m.button('Ranger la remise'));
    expect(m.status()).toBe(REMISES_REFUSALS.moment_du_dossier);
    expect(m.posts()).toEqual([]);
  });

  it('[R73] le partenaire se choisit dans l’annuaire, par métier, code postal et domaine ; son identifiant part avec la remise', async () => {
    const SEARCH = '/v1/partenaires/annuaire?metier=diagnostiqueur&cp=21000&domaine=dpe';
    const d = await desk({
      [`GET ${SEARCH}`]: ok({ day: '2027-03-02', proposable: [{ partnerId: 'pa1', trade: 'diagnostiqueur', businessName: 'Diag Inventé' }], unavailable: [{ partnerId: 'pa3', trade: 'diagnostiqueur', businessName: INJECTED, reasons: ['assurance'] }, { partnerId: 'pa4', trade: 'notaire', businessName: 'Pas du métier' }] }),
    });
    await d.open();
    d.fill();
    d.set('categorie', 'diagnostiqueur');
    d.set('pour', 'client');
    // Sans partenaire choisi : refusé avant l'appel.
    await d.click(d.button('Ranger la remise'));
    expect(d.status()).toBe(REMISES_REFUSALS.partenaire_requis);
    // Sans domaine : la recherche ne part pas.
    d.set('cp', '21000');
    await d.click(d.button('Chercher dans l’annuaire'));
    expect(d.part().textContent).toContain(REMISES_REFUSALS.domain_required);
    d.set('domaine', 'dpe');
    await d.click(d.button('Chercher dans l’annuaire'));
    expect(d.calls.some((c) => c.url === SEARCH)).toBe(true);
    const options = d.input('remise-partenaire').children.map((o) => o.textContent);
    expect(options).toEqual(['Aucun partenaire choisi', 'Diag Inventé', `${INJECTED} (pas justifié ce jour : pas encore proposé)`]);
    expect(d.input('remise-partenaire').all().some((e) => e.tagName === 'img')).toBe(false);
    d.set('partenaire', 'pa1');
    await d.click(d.button('Ranger la remise'));
    expect(d.posts()[0]!.body).toMatchObject({ category: 'diagnostiqueur', beneficiary: 'client', partnerId: 'pa1' });
    // Changer de catégorie oublie le partenaire trouvé.
    d.set('categorie', 'demenageur');
    expect(d.input('remise-partenaire').children).toHaveLength(1);
    expect(d.input('remise-partenaire').value).toBe('');
  });

  it('[R266] retirer : deux appuis et une raison, puis le catalogue relu ; jamais sans raison', async () => {
    const d = await desk();
    await d.open();
    const article = d.part().all().find((e) => e.tagName === 'article' && e.textContent.includes('Photo Inventée'))!;
    await d.click(btn(article, 'Retirer…'));
    expect(d.posts()).toEqual([]);
    expect(article.textContent).toContain(REMISES_CONFIRM);
    await d.click(btn(article, 'Retirer pour de bon'));
    expect(d.status()).toBe(REMISES_REFUSALS.bad_reason);
    expect(d.posts()).toEqual([]);
    article.all().find((e) => e.attributes.id === 'remise-raison-d1')!.value = 'Contrat arrêté';
    await d.click(btn(article, 'Retirer pour de bon'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/remises/d1/retrait', body: { reason: 'Contrat arrêté' } }]);
    expect(d.status()).toBe('Remise retirée : elle reste au journal.');
    expect(d.calls.filter((c) => c.method === 'GET' && c.url === '/v1/remises')).toHaveLength(2);
    // Déjà retirée ailleurs : dit en mots, et la liste relue.
    const e = await desk({ 'POST /v1/remises/d1/retrait': no(400, { ok: false, rule: null, code: 'deja_retiree' }) });
    await e.open();
    const a2 = e.part().all().find((x) => x.tagName === 'article' && x.textContent.includes('Photo Inventée'))!;
    await e.click(btn(a2, 'Retirer…'));
    a2.all().find((x) => x.attributes.id === 'remise-raison-d1')!.value = 'Contrat arrêté';
    await e.click(btn(a2, 'Retirer pour de bon'));
    expect(e.status()).toContain(REMISES_REFUSALS.deja_retiree);
    expect(e.calls.filter((c) => c.method === 'GET' && c.url === '/v1/remises')).toHaveLength(2);
  });

  it('[R267, R75] sur le bien : le moment lu dans la base, les remises de l’agent puis du client dans l’ordre reçu, « tiré au sort » dit', async () => {
    const b = await bien();
    await b.open();
    const text = b.texts();
    expect(text).toContain('Moment du dossier, lu dans la base : Mandat inscrit au registre.');
    expect(text).toContain(`Pourquoi maintenant : ${WHY}`);
    expect(text).toContain(REMISES_RANDOM);
    // L'agent d'abord, puis le client dans l'ordre du serveur : jamais retrié.
    const heads = b.block().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent);
    expect(heads).toEqual(['Pour vous', 'Photographe · Photo Inventée', 'Pour le client', 'Déménageur · Cartons Inventés', 'Artisan · Artisan Inventé']);
    const reversed = await bien({ 'GET /v1/remises/biens/b1': ok({ propertyId: 'b1', moment: 'mandat', forAgent: [], forClient: [{ ...ARTISAN, why: WHY }, { ...DEMENAGEUR, why: WHY }] }) });
    await reversed.open();
    expect(reversed.block().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent)).toEqual(['Pour le client', 'Artisan · Artisan Inventé', 'Déménageur · Cartons Inventés']);
    expect(reversed.texts()).not.toContain('Pour vous');
  });

  it('aucun moment sûr : rien à proposer maintenant ; aucune remise pour ce moment : dit aussi', async () => {
    const b = await bien({ 'GET /v1/remises/biens/b1': ok(null) });
    await b.open();
    expect(b.status()).toBe(REMISES_NONE_NOW);
    expect(b.block().all().some((e) => e.tagName === 'article')).toBe(false);
    const e = await bien({ 'GET /v1/remises/biens/b1': ok({ propertyId: 'b1', moment: 'en_vente', forAgent: [], forClient: [] }) });
    await e.open();
    expect(e.texts()).toContain('Annonce en vente');
    expect(e.status()).toBe('Aucune remise négociée pour ce moment du dossier.');
  });

  it('[R267] écarter : le bloc relu, la remise n’y est plus', async () => {
    const b = await bien();
    await b.open();
    b.table['GET /v1/remises/biens/b1'] = ok({ propertyId: 'b1', moment: 'mandat', forAgent: [], forClient: [{ ...DEMENAGEUR, why: WHY }] });
    const photo = b.block().all().find((e) => e.tagName === 'article' && e.textContent.includes('Photo Inventée'))!;
    await b.press(btn(photo, 'Écarter pour ce bien'));
    expect(b.calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', url: '/v1/remises/d1/biens/b1/ecarter', body: {} }]);
    expect(b.status()).toBe('Remise écartée : elle ne reviendra plus sur ce bien.');
    expect(b.texts()).not.toContain('Photo Inventée');
    expect(b.gets()).toHaveLength(2);
  });

  it('[R16] chaque refus dit en mots, jamais un code ; une écriture sans réponse dite incertaine et relue', async () => {
    const b = await bien({ 'GET /v1/remises/biens/b1': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await b.open();
    expect(b.status()).toBe(REMISES_REFUSALS.not_assigned);
    const u = await bien({ 'GET /v1/remises/biens/b1': no(403, { ok: false, rule: 'R16', code: 'quelque_chose' }) });
    await u.open();
    expect(u.status()).toBe('Les remises ne se lisent pas pour le moment.');
    const off = await bien({ 'GET /v1/remises/biens/b1': cut });
    await off.open();
    expect(off.status()).toBe('Pas de réseau. Réessayez dans un moment.');
    // Écarter sans réponse : incertain, et le bloc relu.
    const lost = await bien({ 'POST /v1/remises/d1/biens/b1/ecarter': cut });
    await lost.open();
    const photo = lost.block().all().find((e) => e.tagName === 'article' && e.textContent.includes('Photo Inventée'))!;
    await lost.press(btn(photo, 'Écarter pour ce bien'));
    expect(lost.status()).toBe(REMISES_LOST);
    expect(lost.gets()).toHaveLength(2);
    // Ranger sans réponse, ou une panne du serveur : incertain, et le catalogue relu.
    for (const answer of [cut, no(500, { ok: false })]) {
      const d = await desk({ 'POST /v1/remises': answer });
      await d.open();
      d.fill();
      await d.click(d.button('Ranger la remise'));
      expect(d.status()).toBe(REMISES_LOST);
      expect(d.calls.filter((c) => c.method === 'GET' && c.url === '/v1/remises')).toHaveLength(2);
    }
  });

  it('texte reçu posé en texte ; une remise au champ mal formé n’est pas dite', async () => {
    const d = await desk({
      'GET /v1/remises': ok([{ ...PHOTO, supplier: INJECTED }, { ...DEMENAGEUR, id: 'mal formé' }, { ...PHOTO, id: 'd5', validUntil: 'demain' }, { ...PHOTO, id: 'd6', category: 'inconnue' }, null, 'texte']),
    });
    await d.open();
    const articles = d.part().all().filter((e) => e.tagName === 'article');
    expect(articles).toHaveLength(1);
    expect(articles[0]!.textContent).toContain(`Photographe · ${INJECTED}`);
    expect(d.part().all().some((e) => e.tagName === 'img')).toBe(false);
    // Côté bien : une remise du client rangée par erreur chez l'agent n'est pas dite.
    const b = await bien({ 'GET /v1/remises/biens/b1': ok({ propertyId: 'b1', moment: 'mandat', forAgent: [{ ...DEMENAGEUR, why: WHY }], forClient: [] }) });
    await b.open();
    expect(b.block().all().some((e) => e.tagName === 'article')).toBe(false);
    const bad = await bien({ 'GET /v1/remises/biens/b1': ok({ propertyId: 'b1', moment: 'toujours', forAgent: [], forClient: [] }) });
    await bad.open();
    expect(bad.status()).toBe('Les remises ne se lisent pas pour le moment.');
  });
});

/** L'agent, sur son accueil. */
async function accueil(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const table: Record<string, Answer> = { 'GET /v1/remises': ok([ALWAYS, PHOTO, DEMENAGEUR, ARTISAN, { ...DEMENAGEUR, id: 'd7', moment: 'acte' }]), ...answers };
  const ctx = context('agent', table, calls, document);
  runInNewContext(JS, ctx);
  listeners.DOMContentLoaded!();
  await settle();
  const block = () => els['remises-accueil']!.children.find((e) => e.tagName === 'section')!;
  const press = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const open = async () => {
    await press(btn(block(), 'Mes remises négociées'));
    const s = scriptsOf(els.fiche!, '/app/remises.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(REMISES_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const gets = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/v1/remises'));
  return { els, calls, block, open, press, gets, status: () => statusOf(block()), texts: () => block().textContent };
}
const ALWAYS = { ...PHOTO, id: 'd8', category: 'outil', supplier: 'Logiciel Inventé', title: 'Abonnement à prix réseau', terms: '30 % la première année.', source: 'Contrat du 4 janvier', moment: 'toujours' };

describe('BR74 · mes remises de tous les jours, sur l’accueil de l’agent', () => {
  it('[R201] le bloc de l’accueil passe par le chargeur commun et le même script ; rien n’est lu avant le geste ; budgets tenus', async () => {
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(budgetProblems({ html: '', js: REMISES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(JS).not.toContain('/v1/remises');
    expect(REMISES_SCRIPT).not.toContain('innerHTML');
    const a = await accueil();
    expect(a.block()).toBeDefined();
    expect(a.gets()).toHaveLength(0);
    await a.open();
    expect(a.gets()).toEqual([{ method: 'GET', url: '/v1/remises', body: null }]);
    await a.open();
    expect(scriptsOf(a.els.fiche!, '/app/remises.js')).toHaveLength(1);
    expect(a.gets()).toHaveLength(2);
  });

  it('[R266] seules les remises « toujours » pour l’agent sont montrées en entier : fournisseur, titre, conditions, source, fin', async () => {
    const a = await accueil();
    await a.open();
    const articles = a.block().all().filter((e) => e.tagName === 'article');
    expect(articles).toHaveLength(1);
    const text = articles[0]!.textContent;
    expect(text).toContain('Logiciel Inventé');
    expect(text).toContain('Abonnement à prix réseau');
    expect(text).toContain('30 % la première année.');
    expect(text).toContain('Source : Contrat du 4 janvier');
    expect(text).toContain('Jusqu’au 31/12/2027.');
    expect(a.block().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent)).toEqual(['Pour vous, tous les jours', 'Outil · Logiciel Inventé', 'Sur la page du bien, au bon moment']);
    // Aucun bouton d'écart ici : rien ne s'écarte hors d'un bien.
    expect(btn(a.block(), 'Écarter pour ce bien')).toBeUndefined();
  });

  it('[R267] Jamais vu : celles d’un moment du dossier ne sont que comptées, par moment, jamais montrées', async () => {
    const a = await accueil();
    await a.open();
    const text = a.texts();
    expect(text).toContain(REMISES_ELSEWHERE);
    const items = a.block().all().filter((e) => e.tagName === 'li').map((e) => e.textContent);
    expect(items).toEqual(['Mandat inscrit au registre : 1 pour vous, 2 pour vos clients.', 'Acte signé depuis moins de 90 jours : 1 pour vos clients.']);
    expect(text).not.toContain('Photo Inventée');
    expect(text).not.toContain('Cartons Inventés');
    expect(text).not.toContain('Artisan Inventé');
    // Une remise « toujours » marquée pour le client (rangée par erreur) n'est ni montrée ni comptée.
    const odd = await accueil({ 'GET /v1/remises': ok([{ ...ALWAYS, beneficiary: 'client' }]) });
    await odd.open();
    expect(odd.block().all().some((e) => e.tagName === 'article' || e.tagName === 'li')).toBe(false);
    expect(odd.status()).toBe(REMISES_NONE_TODAY);
  });

  it('aucune remise : dit en mots ; une remise mal formée n’est pas dite ; texte reçu posé en texte', async () => {
    const empty = await accueil({ 'GET /v1/remises': ok([]) });
    await empty.open();
    expect(empty.status()).toBe(REMISES_NONE_TODAY);
    const a = await accueil({ 'GET /v1/remises': ok([{ ...ALWAYS, supplier: INJECTED }, { ...ALWAYS, id: 'mal formé' }, { ...ALWAYS, id: 'd9', validUntil: 'demain' }, { ...PHOTO, id: 'd10', moment: 'inconnu' }, null, 'texte']) });
    await a.open();
    const articles = a.block().all().filter((e) => e.tagName === 'article');
    expect(articles).toHaveLength(1);
    expect(articles[0]!.textContent).toContain(INJECTED);
    expect(a.block().all().some((e) => e.tagName === 'img' || e.tagName === 'li')).toBe(false);
  });

  it('[R16] un refus est dit en mots, jamais son code ; sans réseau, dit aussi', async () => {
    const out = await accueil({ 'GET /v1/remises': no(403, { ok: false, rule: 'R16', code: 'agent_inactive' }) });
    await out.open();
    // Un agent sorti : la clé est refusée par l'application entière, le bloc vidé, rien de lu ne reste.
    expect(out.els['remises-accueil']!.children).toHaveLength(0);
    expect(out.els.erreur!.textContent).toBe('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.');
    const role = await accueil({ 'GET /v1/remises': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await role.open();
    expect(role.status()).toBe(REMISES_REFUSALS.role);
    const odd = await accueil({ 'GET /v1/remises': no(403, { ok: false, rule: 'R16', code: 'autre_chose' }) });
    await odd.open();
    expect(odd.status()).toBe('Les remises ne se lisent pas pour le moment.');
    const off = await accueil({ 'GET /v1/remises': cut });
    await off.open();
    expect(off.status()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('le bloc est refait à chaque retour à l’accueil et vidé à la sortie', async () => {
    const a = await accueil();
    await a.open();
    expect(a.texts()).toContain('Logiciel Inventé');
    // Retour à la journée depuis une fiche : un bloc neuf, fermé, sans rien de lu.
    a.els.retour!.listeners.click!({});
    await settle();
    // Deux blocs neufs : les remises, puis « Mes panneaux » (BR104).
    expect(a.els['remises-accueil']!.children).toHaveLength(2);
    expect(a.texts()).not.toContain('Logiciel Inventé');
    expect(btn(a.block(), 'Mes remises négociées')).toBeDefined();
    // Le script déjà chargé sert de nouveau, sans le recharger.
    await a.open();
    expect(scriptsOf(a.els.fiche!, '/app/remises.js')).toHaveLength(1);
    expect(a.texts()).toContain('Logiciel Inventé');
  });

  it('[R201] un commentaire de bloc sur plusieurs lignes est retiré du script servi ; un bloc jamais fermé reste', () => {
    expect(stripCommentLines('a();\n  /**\n   * doc\n   */\nb();')).toBe('a();\nb();');
    expect(stripCommentLines('a();\n  /* ouvert\n  b(); /* x */ c();')).toBe('a();\n  /* ouvert\n  b(); /* x */ c();');
    expect(stripCommentLines('a();\n  /* ouvert\n  b(); */ c();')).toBe('a();\n  /* ouvert\n  b(); */ c();');
    expect(JS).not.toMatch(/^\s*\/\*\*?\s*$/m);
  });
});
