import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { PANNEAUX_BUSY, PANNEAUX_CONFIRM, PANNEAUX_FORM, PANNEAUX_OFFLINE, PANNEAUX_REFUSALS, PANNEAUX_SCRIPT, PANNEAUX_UNSURE } from '../app/panneaux.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds, placeTool } from './fake-dom.ts';

// Tout est inventé : clé, biens, adresses, numéros de panneaux.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
type Call = { method: string; url: string; body: Record<string, unknown> | null };
const ok = (data: unknown, extra: Record<string, unknown> = {}): Answer => async () => Response.json({ ok: true, mode: 'essai', data, ...extra });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const ADDRESS = { streetNumber: '12', street: 'rue des Tilleuls Inventée', postcode: '21000', city: 'Dijon' };
const ON_B1 = { placementId: 'p1', signNumber: 7, size: 'grand', propertyId: 'b1', reference: 'REF-T-1', agentId: 'a1', placedAt: '2027-03-02T09:00:00.000Z', address: ADDRESS, pickup: null };
const DUE = { placementId: 'p2', signNumber: 9, size: 'petit', propertyId: 'b2', reference: 'REF-T-2', agentId: 'a1', placedAt: '2027-02-01T09:00:00.000Z', address: { ...ADDRESS, streetNumber: '3', street: 'allée Inventée' }, pickup: { reason: 'vendu', dueDay: '2027-03-10' } };
const COUNTS = { total: 12, enStock: 9, poses: 2, aRecuperer: 1, perdus: 1, bySize: { grand: { enStock: 3, poses: 1 }, moyen: { enStock: 3, poses: 0 }, petit: { enStock: 3, poses: 1 } } };
const STOCK = ok({ counts: COUNTS, placed: [ON_B1, DUE] });

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function context(table: Record<string, Answer>, calls: Call[], document: unknown) {
  return {
    document,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const a = table[`${method} ${url}`] ?? (method === 'GET' && url === '/v1/moi' ? ok({ role: 'agent', firstName: null }) : undefined);
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
const btns = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
const statusOf = (root: FakeElement) => root.all().find((e) => e.attributes.role === 'status')?.textContent ?? '';

/** Une porte du script : l'accueil de l'agent, ou l'écran « Mettre en vente » du bien b1. */
async function screen(where: 'accueil' | 'bien', answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: Call[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/annonces': ok([{ id: 'b1', reference: 'REF-T-1', city: 'Dijon', state: null }]),
    'GET /v1/annonces/b1/controle': ok({ complete: true, items: [] }),
    'GET /v1/annonces/b1/brouillon': no(404, { ok: false, rule: null, code: 'no_draft' }),
    'GET /v1/annonces/b1/publication': ok(null),
    'GET /v1/panneaux': STOCK,
    'POST /v1/panneaux/poses': ok({ placementId: 'p3' }),
    'POST /v1/panneaux/poses/p1/retrait': ok(null),
    'POST /v1/panneaux/poses/p2/retrait': ok(null),
    ...answers,
  };
  const ctx = context(table, calls, document);
  runInNewContext(JS, ctx);
  listeners.DOMContentLoaded!();
  await settle();
  const press = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    (listeners as Record<string, ((e: unknown) => void) | undefined>).click?.({ target: b });
    b.listeners.click!({});
    await settle();
  };
  const label = where === 'accueil' ? 'Mes panneaux' : 'Panneaux du bien';
  if (where === 'bien') await press(placeTool(els, 'Mettre en vente'));
  const root = () => (where === 'accueil' ? els['remises-accueil']! : els['vente-corps']!);
  const block = () => root().children.find((e) => e.tagName === 'section' && btn(e, label))!;
  const open = async () => {
    await press(btn(block(), label));
    const s = scriptsOf(els.fiche!, '/app/panneaux.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(PANNEAUX_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const input = (id: string) => block().all().find((e) => e.attributes.id === id)!;
  const set = (id: string, value: string) => {
    input(`panneau-${id}`).value = value;
  };
  const fill = (over: Record<string, string> = {}) => {
    const v = { numero: '11', voie: '12', rue: 'rue des Tilleuls Inventée', cp: '21000', commune: 'Dijon', ...over };
    for (const [k, x] of Object.entries(v)) set(k, x);
  };
  const gets = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/v1/panneaux'));
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/v1/panneaux'));
  return { els, calls, table, block, open, press, fill, gets, posts, status: () => statusOf(block()), button: (t: string) => btn(block(), t), texts: () => block().textContent };
}

describe('BR104 · les panneaux à l’écran', () => {
  it('[R201] un seul script servi à part, chargé au seul geste par les deux portes ; budgets tenus, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/panneaux.js']).toBe(PANNEAUX_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/panneaux.js');
    const served = handleAgentApp(new Request('https://x.test/app/panneaux.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: PANNEAUX_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/panneaux');
    expect(PANNEAUX_SCRIPT).not.toContain('innerHTML');
    for (const where of ['accueil', 'bien'] as const) {
      const s = await screen(where);
      expect(s.block()).toBeDefined();
      expect(scriptsOf(s.els.fiche!, '/app/panneaux.js')).toHaveLength(0);
      expect(s.gets()).toHaveLength(0);
      await s.open();
      expect(s.gets()).toEqual([{ method: 'GET', url: '/v1/panneaux', body: null }]);
      // Un second geste ne recharge pas le script : il relit les panneaux.
      await s.open();
      expect(scriptsOf(s.els.fiche!, '/app/panneaux.js')).toHaveLength(1);
      expect(s.gets()).toHaveLength(2);
    }
    // Les autres blocs restent à leur place.
    const b = await screen('bien');
    expect(b.els['vente-corps']!.textContent).toContain('Armoire des clés');
    expect(btn(b.els['vente-corps']!, 'Remises du moment')).toBeDefined();
    const a = await screen('accueil');
    expect(btn(a.els['remises-accueil']!, 'Mes remises négociées')).toBeDefined();
  });

  it('[R284] l’accueil : les comptes du stock, les panneaux à récupérer d’abord avec leur raison et leur jour, puis les autres poses', async () => {
    const a = await screen('accueil');
    await a.open();
    const text = a.texts();
    expect(text).toContain('Stock du réseau : 9 panneaux en stock, 2 posés, dont 1 à récupérer, 1 perdu.');
    expect(a.block().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent)).toEqual(['À récupérer', 'Posés']);
    const items = a.block().all().filter((e) => e.tagName === 'li');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Panneau n° 9, petit format · REF-T-2');
    expect(items[0]!.textContent).toContain('au 3 allée Inventée, 21000 Dijon.');
    expect(items[0]!.textContent).toContain('Bien vendu : récupérer le panneau. Depuis le 10/03/2027.');
    expect(items[1]!.textContent).toContain('Panneau n° 7, grand format · REF-T-1');
    expect(items[1]!.textContent).not.toContain('récupérer');
    expect(a.status()).toBe('2 panneaux posés, dont 1 à récupérer.');
    const empty = await screen('accueil', { 'GET /v1/panneaux': ok({ counts: { ...COUNTS, poses: 0, aRecuperer: 0 }, placed: [] }) });
    await empty.open();
    expect(empty.status()).toBe('Aucun panneau posé.');
    expect(empty.texts()).toContain('0 posé, dont 0 à récupérer');
  });

  it('[R282] l’écran du bien ne montre que ses poses ; la pose envoie le numéro et l’adresse, puis relit', async () => {
    const b = await screen('bien');
    await b.open();
    const items = b.block().all().filter((e) => e.tagName === 'li');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('Panneau n° 7');
    expect(b.texts()).not.toContain('REF-T-2');
    expect(b.texts()).not.toContain('Stock du réseau');
    expect(b.status()).toBe('1 panneau posé sur ce bien.');
    b.fill({ numero: ' 11 ', commune: 'Dijon ' });
    await b.press(b.button('Poser le panneau'));
    expect(b.posts()).toEqual([
      { method: 'POST', url: '/v1/panneaux/poses', body: { signNumber: 11, propertyId: 'b1', address: { streetNumber: '12', street: 'rue des Tilleuls Inventée', postcode: '21000', city: 'Dijon' } } },
    ]);
    expect(b.gets()).toHaveLength(2);
    expect(b.status()).toBe('Panneau n° 11 posé sur ce bien. 1 panneau posé sur ce bien.');
    const none = await screen('bien', { 'GET /v1/panneaux': ok({ counts: COUNTS, placed: [DUE] }) });
    await none.open();
    expect(none.status()).toBe('Aucun panneau posé sur ce bien.');
    expect(none.button('Poser le panneau')).toBeDefined();
  });

  it('numéro, rue, code postal ou commune mal saisis : refusés avant l’appel, dits en mots', async () => {
    const b = await screen('bien');
    await b.open();
    const cases: [Record<string, string>, string][] = [
      [{ numero: '' }, PANNEAUX_FORM.number],
      [{ numero: '7a' }, PANNEAUX_FORM.number],
      [{ numero: '-3' }, PANNEAUX_FORM.number],
      [{ voie: ' ' }, PANNEAUX_FORM.street],
      [{ rue: '' }, PANNEAUX_FORM.street],
      [{ cp: '2100' }, PANNEAUX_FORM.postcode],
      [{ cp: '21 000' }, PANNEAUX_FORM.postcode],
      [{ commune: '' }, PANNEAUX_FORM.city],
    ];
    for (const [over, said] of cases) {
      b.fill(over);
      await b.press(b.button('Poser le panneau'));
      expect(b.status()).toBe(said);
    }
    expect(b.posts()).toHaveLength(0);
  });

  it('[R42, R282] un refus du serveur dit en mots, jamais son code ; la saisie reste', async () => {
    for (const code of ['no_mandate', 'withdrawal_period', 'expired', 'hors_du_bien', 'pas_au_stock', 'unknown_sign', 'bien_vendu', 'pas_son_bien']) {
      const rule = code === 'pas_son_bien' ? 'R16' : ['no_mandate', 'withdrawal_period', 'expired'].includes(code) ? 'R42' : 'R282';
      const b = await screen('bien', { 'POST /v1/panneaux/poses': no(rule === 'R16' ? 403 : 409, { ok: false, rule, code }) });
      await b.open();
      b.fill();
      await b.press(b.button('Poser le panneau'));
      expect(b.status()).toBe(PANNEAUX_REFUSALS[code]);
      expect(b.status()).not.toContain(code);
      expect(b.block().all().find((e) => e.attributes.id === 'panneau-numero')!.value).toBe('11');
      expect(b.gets()).toHaveLength(1);
    }
    const odd = await screen('bien', { 'POST /v1/panneaux/poses': no(409, { ok: false, rule: 'R282', code: 'autre_chose' }) });
    await odd.open();
    odd.fill();
    await odd.press(odd.button('Poser le panneau'));
    expect(odd.status()).toBe('Le geste n’a pas pu être noté. Réessayez dans un moment.');
  });

  it('[R283] « Récupéré » part d’un appui ; « Perdu » seulement au second, tout autre geste annule la demande', async () => {
    const a = await screen('accueil');
    await a.open();
    await a.press(btns(a.block(), 'Récupéré')[0]);
    expect(a.posts()).toEqual([{ method: 'POST', url: '/v1/panneaux/poses/p2/retrait', body: { outcome: 'recupere' } }]);
    expect(a.status()).toBe('Panneau n° 9, petit format · REF-T-2 noté récupéré : il revient au stock. 2 panneaux posés, dont 1 à récupérer.');
    const lost = btns(a.block(), 'Perdu')[1]!;
    await a.press(lost);
    expect(a.posts()).toHaveLength(1);
    expect(lost.textContent).toBe('Confirmer : perdu');
    expect(a.status()).toBe(PANNEAUX_CONFIRM);
    // Un autre geste annule : le bouton revient, rien ne part.
    await a.press(btns(a.block(), 'Récupéré')[0]);
    expect(lost.textContent).toBe('Perdu');
    const b = await screen('bien');
    await b.open();
    const l = b.button('Perdu')!;
    await b.press(l);
    await b.press(b.button('Confirmer : perdu'));
    expect(b.posts()).toEqual([{ method: 'POST', url: '/v1/panneaux/poses/p1/retrait', body: { outcome: 'perdu' } }]);
    expect(b.status()).toContain('noté perdu : il ne se posera plus.');
  });

  it('un envoi en cours garde son verrou : rouvrir le bloc ne laisse partir aucun autre geste', async () => {
    const a = await screen('accueil', { 'POST /v1/panneaux/poses/p2/retrait': () => new Promise<Response>(() => undefined) });
    await a.open();
    await a.press(btns(a.block(), 'Récupéré')[0]);
    expect(a.status()).toBe('Envoi…');
    // Rouvrir le bloc pendant l'envoi : rien n'est relu ni relâché.
    await a.press(btn(a.block(), 'Mes panneaux'));
    expect(a.gets()).toHaveLength(1);
    expect(a.status()).toBe('Envoi…');
    const lost = btns(a.block(), 'Perdu')[0]!;
    await a.press(lost);
    await a.press(lost);
    await a.press(btns(a.block(), 'Récupéré')[1]);
    expect(a.posts()).toHaveLength(1);
    // Un autre bloc ouvert pendant l'envoi attend sa fin, dit en mots.
    await a.press(placeTool(a.els, 'Mettre en vente'));
    const other = a.els['vente-corps']!.children.find((e) => e.tagName === 'section' && btn(e, 'Panneaux du bien'))!;
    await a.press(btn(other, 'Panneaux du bien'));
    expect(statusOf(other)).toBe(PANNEAUX_BUSY);
    expect(a.gets()).toHaveLength(1);
    expect(a.posts()).toHaveLength(1);
  });

  it('une écriture sans réponse est dite incertaine et la liste relue ; une pose déjà retirée fait relire', async () => {
    const off = await screen('accueil', { 'POST /v1/panneaux/poses/p2/retrait': cut });
    await off.open();
    await off.press(btns(off.block(), 'Récupéré')[0]);
    expect(off.gets()).toHaveLength(2);
    expect(off.status()).toBe(`${PANNEAUX_UNSURE} 2 panneaux posés, dont 1 à récupérer.`);
    const down = await screen('bien', { 'POST /v1/panneaux/poses': no(500, { ok: false }) });
    await down.open();
    down.fill();
    await down.press(down.button('Poser le panneau'));
    expect(down.status()).toContain(PANNEAUX_UNSURE);
    expect(down.gets()).toHaveLength(2);
    // La relecture échoue aussi : l'incertitude reste dite, avec la panne de la lecture.
    const lost = await screen('accueil', { 'POST /v1/panneaux/poses/p2/retrait': cut });
    await lost.open();
    lost.table['GET /v1/panneaux'] = cut;
    await lost.press(btns(lost.block(), 'Récupéré')[0]);
    expect(lost.status()).toBe(`${PANNEAUX_UNSURE} ${PANNEAUX_OFFLINE}`);
    const refused = await screen('bien', { 'POST /v1/panneaux/poses': no(503, { ok: false }) });
    await refused.open();
    refused.table['GET /v1/panneaux'] = no(403, { ok: false, rule: 'R16', code: 'role' });
    refused.fill();
    await refused.press(refused.button('Poser le panneau'));
    expect(refused.status()).toBe(`${PANNEAUX_UNSURE} ${PANNEAUX_REFUSALS.role}`);
    const gone = await screen('accueil', { 'POST /v1/panneaux/poses/p2/retrait': no(409, { ok: false, rule: 'R283', code: 'deja_retire' }) });
    await gone.open();
    await gone.press(btns(gone.block(), 'Récupéré')[0]);
    expect(gone.gets()).toHaveLength(2);
    expect(gone.status()).toContain(PANNEAUX_REFUSALS.deja_retire);
  });

  it('[R13] tout texte reçu posé en texte ; une pose mal formée n’est pas dite', async () => {
    const a = await screen('accueil', {
      'GET /v1/panneaux': ok({ counts: COUNTS, placed: [{ ...ON_B1, reference: INJECTED }, { ...ON_B1, placementId: 'mal formé' }, { ...ON_B1, placementId: 'p8', signNumber: '7' }, null, 'texte', { ...DUE, pickup: { reason: INJECTED, dueDay: 'demain' } }] }),
    });
    await a.open();
    const items = a.block().all().filter((e) => e.tagName === 'li');
    expect(items).toHaveLength(2);
    expect(a.texts()).toContain(INJECTED);
    expect(a.texts()).toContain('À récupérer.');
    expect(a.texts()).not.toContain('Depuis le');
    expect(a.block().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('[R16] un refus de lecture dit en mots ; sans réseau, dit aussi ; une clé refusée ne laisse rien', async () => {
    const out = await screen('accueil', { 'GET /v1/panneaux': no(403, { ok: false, rule: 'R16', code: 'agent_inactive' }) });
    await out.open();
    expect(out.els['remises-accueil']!.children).toHaveLength(0);
    expect(out.els.erreur!.textContent).toBe('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.');
    const role = await screen('accueil', { 'GET /v1/panneaux': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await role.open();
    expect(role.status()).toBe(PANNEAUX_REFUSALS.role);
    const odd = await screen('bien', { 'GET /v1/panneaux': no(403, { ok: false, rule: 'R16', code: 'autre_chose' }) });
    await odd.open();
    expect(odd.status()).toBe('Les panneaux ne se lisent pas pour le moment.');
    expect(odd.button('Poser le panneau')).toBeUndefined();
    const off = await screen('bien', { 'GET /v1/panneaux': cut });
    await off.open();
    expect(off.status()).toBe(PANNEAUX_OFFLINE);
  });
});
