import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { BUYER_FEATURES } from '../../core/src/acquereurs/fiche-acquereur.ts';
import { REFUSAL_REASONS } from '../../core/src/recherche/langage-courant.ts';
import { BIENS_FICHE_SCRIPT } from '../app/biens-fiche.ts';
import { RECHERCHE_FEATURE_LABELS, RECHERCHE_LOST, RECHERCHE_REFUSAL_LABELS, RECHERCHE_REFUSALS, RECHERCHE_SCRIPT } from '../app/recherche.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : fiche, projets, biens, phrase, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const ID = '0b6f1d2e-5555-4a2b-8c3d-000000000040';
const INJECTED = '<img src=x onerror="alert(1)">';
const BUY = { id: 'projet-achat-1', kind: 'buy', stage: 'new', deadline: null, budgetMinEur: null, budgetMaxEur: 250000 };
const FICHE = (projects: unknown[]) => ({
  personId: ID,
  firstName: 'Client',
  lastName: 'Essai',
  contact: { allowed: true, reasons: [] },
  call: null,
  callRefusal: 'no_phone',
  callClosesAt: null,
  callbacks: [],
  projects,
  sources: [],
  qualification: null,
  messages: [],
});
const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: ID, firstName: 'Client', kind: 'callback', reason: 'Rappel', callbackDueAt: null }] };
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', sent: false, data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const result = (id: string, reference: string, extra: Record<string, unknown> = {}) => ({
  propertyId: id,
  reference,
  kind: 'home',
  city: 'Dijon',
  priceEur: 240000,
  surfaceM2: 80,
  rooms: 4,
  status: 'match',
  reasons: [{ text: 'À Dijon', from: 'à Dijon' }],
  preferencesMet: 0,
  neighbourOf: null,
  ...extra,
});
const RESULTS = {
  search: { criteria: [], ignored: [{ words: 'sans voisins bruyants', start: 30, end: 51, reason: 'negation' }], excludedCommunes: [], excludedKinds: [], refusedPropertyIds: [] },
  // L'ordre du serveur : l'écran ne le change jamais.
  results: [result('b2', 'R-002', { status: 'tolerated', reasons: [{ text: 'Budget 250 000 €', from: '250 000 euros' }] }), result('b1', 'R-001', { city: INJECTED, address: '12 rue Inventée' })],
  neighbours: [result('b3', 'R-003', { city: 'Talant', neighbourOf: 'Dijon' })],
  proposedNeighbours: [{ commune: 'Talant', of: 'Dijon' }],
};

const tick = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};

async function opened(options: { projects?: unknown[]; answers?: Record<string, Answer> } = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { url: string; method: string; body: any; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
    'GET /v1/plan-du-jour': ok(PLAN),
    'GET /v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
    'GET /v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
    [`GET /v1/fiches/${ID}/resume`]: ok(FICHE(options.projects ?? [BUY])),
    [`GET /v1/fiches/${ID}/biens`]: ok([]),
    'POST /v1/recherche/phrase': ok(RESULTS),
    [`POST /v1/recherche/projets/${BUY.id}/phrase`]: ok({ buyerSearchId: 's1', criteria: 3 }),
    ...options.answers,
  };
  let keys = 0;
  const context: Record<string, unknown> = {
    document,
    Date,
    Object,
    crypto: { randomUUID: () => `0b6f1d2e-6666-4a2b-8c3d-${String(++keys).padStart(12, '0')}` },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await tick();
  const named = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  named(els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
  await tick();
  const body = els['fiche-corps']!;
  const scripts = (src: string) => body.all().filter((e) => e.tagName === 'script' && e.attributes.src === src);
  runInNewContext(BIENS_FICHE_SCRIPT, context);
  for (const s of scripts('/app/biens-fiche.js')) s.listeners.load!({});
  await tick();
  const section = () => body.all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Recherche en langage courant');
  const callsBefore = calls.length;
  const open = async () => {
    named(section()!, 'Chercher avec ses mots')[0]!.listeners.click!({});
    await tick();
    runInNewContext(RECHERCHE_SCRIPT, context);
    for (const s of scripts('/app/recherche.js')) s.listeners.load!({});
    await tick();
  };
  const click = async (text: string, n = 0) => {
    const b = named(section()!, text)[n];
    if (!b) throw new Error(`bouton absent : ${text}`);
    b.listeners.click!({});
    await tick();
  };
  const phrase = () => section()!.all().find((e) => e.tagName === 'textarea')!;
  const search = async (text: string) => {
    phrase().value = text;
    await click('Chercher');
  };
  const status = () => section()!.all().filter((e) => e.attributes.role === 'status').map((e) => e.textContent).join(' ');
  const posts = () => calls.filter((c) => c.method === 'POST');
  const selectsOf = (reference: string) => {
    const b = named(section()!, `Écarter la réf. ${reference}`)[0]!;
    const d = section()!.all().find((e) => e.tagName === 'details' && e.children.includes(b))!;
    return d.children.filter((e) => e.tagName === 'select');
  };
  return { calls, callsBefore, table, body, section, scripts, open, click, phrase, search, status, posts, selectsOf, named };
}

describe('BR40 · la recherche en langage courant depuis la fiche de l’acquéreur', () => {
  it('[R201] servi à part, chargé seulement au geste, budget d’une page ; l’application tient le sien sans le connaître', async () => {
    const t = await opened();
    expect(t.section()).toBeDefined();
    expect(t.scripts('/app/recherche.js')).toEqual([]);
    expect(t.calls.slice(t.callsBefore).filter((c) => c.url.startsWith('/v1/recherche'))).toEqual([]);
    await t.open();
    expect(t.scripts('/app/recherche.js')).toHaveLength(1);
    expect(t.phrase().attributes.maxlength).toBe('500');
    expect(AGENT_APP_FILES['/app/recherche.js']).toBe(RECHERCHE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/recherche.js');
    expect(JS).not.toContain('recherche.js');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/recherche.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(budgetProblems({ html: '', js: RECHERCHE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: BIENS_FICHE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(RECHERCHE_SCRIPT).not.toContain('innerHTML');
  });

  it('sans projet d’achat, aucun bloc : la recherche se range toujours dans un projet', async () => {
    const t = await opened({ projects: [{ ...BUY, id: 'projet-vente', kind: 'sell' }] });
    expect(t.body.textContent).toContain('Biens du client');
    expect(t.section()).toBeUndefined();
  });

  it('[R420] [R421] [R16] la phrase part seule, par une seule route, la clé dans l’en-tête ; chaque bien dit ses raisons et leurs mots, sans adresse, dans l’ordre reçu', async () => {
    const t = await opened();
    await t.open();
    await t.search('  Une maison à Dijon, 250 000 euros, sans voisins bruyants  ');
    const sent = t.calls.slice(t.callsBefore).filter((c) => c.url.startsWith('/v1/'));
    expect(sent.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /v1/recherche/phrase']);
    expect(sent[0]!.body).toEqual({ phrase: 'Une maison à Dijon, 250 000 euros, sans voisins bruyants', steps: [] });
    expect(sent[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(sent[0]!.url).not.toContain(KEY);
    const text = t.section()!.textContent;
    expect(text).toContain('2 biens répondent');
    expect(text.indexOf('Réf. R-002')).toBeLessThan(text.indexOf('Réf. R-001'));
    expect(text).toContain('Budget 250 000 € (d’après « 250 000 euros »).');
    expect(text).toContain('Maison ou appartement, Dijon, 240 000 €, 80 m², 4 pièces.');
    expect(text).toContain('dans la marge admise');
    // Les mots écartés sont dits, jamais devenus critère.
    expect(text).toContain('« sans voisins bruyants » : écarté, une négation ne fait jamais un critère.');
    // Un champ en trop dans la réponse n'est jamais montré : seulement ce qu'une annonce dit.
    expect(text).not.toContain('12 rue Inventée');
  });

  it('[R423] une voisine n’entre que par le geste ; ses biens sont à part et marqués', async () => {
    const t = await opened();
    await t.open();
    await t.search('Une maison à Dijon');
    expect(t.section()!.textContent).toContain('Commune voisine de Dijon : la personne ne l’a pas cherchée.');
    expect(t.posts()).toHaveLength(1);
    await t.click('Ajouter Talant (voisine de Dijon)');
    expect(t.posts()[1]!.body).toEqual({ phrase: 'Une maison à Dijon', steps: [{ acceptNeighbour: 'Talant' }] });
  });

  it('[R424] un refus part avec sa raison de la liste ; « il manque » avec sa contrainte ; les gestes s’ajoutent', async () => {
    expect(Object.keys(RECHERCHE_REFUSAL_LABELS)).toEqual([...REFUSAL_REASONS]);
    expect(Object.keys(RECHERCHE_FEATURE_LABELS)).toEqual([...BUYER_FEATURES]);
    const t = await opened();
    await t.open();
    await t.search('Une maison à Dijon');
    const [reason] = t.selectsOf('R-002');
    reason!.value = 'trop_cher';
    await t.click('Écarter la réf. R-002');
    expect(t.posts()[1]!.body).toEqual({ phrase: 'Une maison à Dijon', steps: [{ refuse: 'b2', reason: 'trop_cher' }] });
    const [why, feature] = t.selectsOf('R-001');
    why!.value = 'manque';
    feature!.value = 'garden';
    await t.click('Écarter la réf. R-001');
    expect(t.posts()[2]!.body).toEqual({ phrase: 'Une maison à Dijon', steps: [{ refuse: 'b2', reason: 'trop_cher' }, { refuse: 'b1', reason: 'manque', feature: 'garden' }] });
    // Une raison hors de la liste ne part pas.
    const [bad] = t.selectsOf('R-001');
    bad!.value = 'autre';
    await t.click('Écarter la réf. R-001');
    expect(t.posts()).toHaveLength(3);
  });

  it('[R422] ranger envoie la recherche montrée, avec ses gestes ; sans accord, le refus se dit en mots ; une réponse perdue reste incertaine', async () => {
    const t = await opened();
    await t.open();
    await t.search('Une maison à Dijon');
    await t.click('Ajouter Talant (voisine de Dijon)');
    // La phrase change après coup : ce qui est rangé est ce qui est montré.
    t.phrase().value = 'Autre chose';
    await t.click('Ranger cette recherche');
    const save = t.posts().at(-1)!;
    expect(save.url).toBe(`/v1/recherche/projets/${BUY.id}/phrase`);
    expect(save.body).toEqual({ phrase: 'Une maison à Dijon', steps: [{ acceptNeighbour: 'Talant' }] });
    expect(t.status()).toContain('Recherche rangée : 3 critères, avec les mots qui les portent. La phrase n’est pas gardée.');
    t.table[`POST /v1/recherche/projets/${BUY.id}/phrase`] = no(409, { ok: false, rule: 'R422', code: 'sans_accord' });
    await t.click('Ranger cette recherche');
    expect(t.status()).toContain(RECHERCHE_REFUSALS.sans_accord);
    expect(t.status()).not.toContain('sans_accord');
    t.table[`POST /v1/recherche/projets/${BUY.id}/phrase`] = no(500, { ok: false });
    await t.click('Ranger cette recherche');
    expect(t.status()).toContain(RECHERCHE_LOST);
  });

  it('deux projets d’achat : l’agent choisit le projet où ranger', async () => {
    const other = { ...BUY, id: 'projet-achat-2' };
    const t = await opened({ projects: [BUY, other], answers: { [`POST /v1/recherche/projets/${other.id}/phrase`]: ok({ buyerSearchId: null, criteria: 1 }) } });
    await t.open();
    await t.search('Une maison à Dijon');
    const pick = t.section()!.all().find((e) => e.tagName === 'select' && (e.attributes.id ?? '').endsWith('-projet'))!;
    pick.value = other.id;
    await t.click('Ranger cette recherche');
    expect(t.posts().at(-1)!.url).toBe(`/v1/recherche/projets/${other.id}/phrase`);
    expect(t.status()).toContain('1 critère,');
  });

  it('phrase vide ou trop longue refusée avant tout appel', async () => {
    const t = await opened();
    await t.open();
    await t.search('   ');
    expect(t.status()).toContain(RECHERCHE_REFUSALS.bad_phrase);
    await t.search('x'.repeat(501));
    expect(t.status()).toContain(RECHERCHE_REFUSALS.bad_phrase);
    expect(t.posts()).toEqual([]);
  });

  it('chaque refus connu a ses mots, aucun code montré ; hors ligne dit en mots', async () => {
    const t = await opened({ answers: { 'POST /v1/recherche/phrase': no(403, { ok: false, rule: 'R16', code: 'role' }) } });
    await t.open();
    await t.search('Une maison à Dijon');
    expect(t.status()).toContain(RECHERCHE_REFUSALS.role);
    expect(t.status()).not.toContain('role');
    delete t.table['POST /v1/recherche/phrase'];
    await t.search('Une maison à Dijon');
    expect(t.status()).toContain('Pas de réseau');
  });

  it('tout texte reçu est posé en texte', async () => {
    const t = await opened();
    await t.open();
    await t.search('Une maison à Dijon');
    const node = t.section()!.all().find((e) => e.textContent.includes(INJECTED) && e.children.length === 0)!;
    expect(node).toBeDefined();
    expect(t.section()!.all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('[R424] un geste à la fois : un second refus pendant la recherche d’un premier ne part pas, ni le rangement, et aucun geste n’est perdu', async () => {
    const t = await opened();
    await t.open();
    await t.search('Une maison à Dijon');
    let release: (r: Response) => void = () => {};
    t.table['POST /v1/recherche/phrase'] = () => new Promise<Response>((r) => (release = r));
    await t.click('Écarter la réf. R-002');
    await t.click('Écarter la réf. R-001');
    await t.click('Ranger cette recherche');
    expect(t.posts()).toHaveLength(2);
    expect(t.status()).toContain('Une recherche est en cours');
    const after = { ...RESULTS, results: [result('b1', 'R-001')] };
    release(Response.json({ ok: true, data: after }));
    await tick();
    t.table['POST /v1/recherche/phrase'] = ok({ ...after, results: [] });
    await t.click('Écarter la réf. R-001');
    expect(t.posts()[2]!.body.steps).toEqual([{ refuse: 'b2', reason: 'trop_cher' }, { refuse: 'b1', reason: 'trop_cher' }]);
    await t.click('Ranger cette recherche');
    expect(t.posts().at(-1)!.body.steps).toEqual([{ refuse: 'b2', reason: 'trop_cher' }, { refuse: 'b1', reason: 'trop_cher' }]);
  });

  it('deux recherches de suite : seule la dernière dessine', async () => {
    const t = await opened();
    await t.open();
    let release: (r: Response) => void = () => {};
    const slow = new Promise<Response>((r) => (release = r));
    t.table['POST /v1/recherche/phrase'] = () => slow;
    t.phrase().value = 'Une maison à Dijon';
    t.named(t.section()!, 'Chercher')[0]!.listeners.click!({});
    await tick();
    t.table['POST /v1/recherche/phrase'] = ok({ ...RESULTS, results: [result('b9', 'R-009')], neighbours: [], proposedNeighbours: [] });
    await t.search('Un appartement à Dijon');
    release(Response.json({ ok: true, data: RESULTS }));
    await tick();
    const text = t.section()!.textContent;
    expect(text).toContain('Réf. R-009');
    expect(text).not.toContain('Réf. R-002');
  });
});

describe('AU073 · le secteur de la recherche depuis la fiche de l’acquéreur', () => {
  it('un rayon autour d’un lieu dit part au serveur, qui le géocode ; « aucun » le retire ; un refus est dit', async () => {
    const base = `/v1/acquereurs/projets/${BUY.id}/secteur`;
    const t = await opened({
      answers: {
        [`GET ${base}`]: ok(null),
        [`POST ${base}`]: async () => Response.json({ ok: true, mode: 'essai', data: { shape: 'cercle', center: { lat: 47.3, lon: 5.0 }, radiusM: 1500, label: 'Autour de la gare' } }),
      },
    });
    const area = () => t.body.all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Secteur de la recherche')!;
    expect(area().textContent).toContain('Aucun secteur : les communes de la recherche suffisent.');
    const input = (label: string) => {
      const l = area().all().find((e) => e.tagName === 'label' && e.textContent === label)!;
      return area().all().find((e) => (e.tagName === 'input') && e.attributes.id === l.attributes.for)!;
    };
    input('Lieu précis (adresse, gare, école…)').value = 'Gare de Dijon';
    input('Rayon, en km').value = '1,5';
    input('Nom du secteur, pour vous').value = 'Autour de la gare';
    t.named(area(), 'Ranger le secteur')[0]!.listeners.click!({});
    await tick();
    expect(t.posts().at(-1)).toMatchObject({ url: base, body: { shape: 'cercle', place: 'Gare de Dijon', radiusM: 1500, label: 'Autour de la gare' } });
    expect(area().textContent).toContain('Secteur « Autour de la gare » : 1,5 km autour du lieu dit.');
    input('Rayon, en km').value = '80';
    t.named(area(), 'Ranger le secteur')[0]!.listeners.click!({});
    await tick();
    expect(area().textContent).toContain('Le rayon : de 0,1 à 50 km.');
    t.table[`POST ${base}`] = ok(null);
    t.named(area(), 'Retirer le secteur')[0]!.listeners.click!({});
    await tick();
    expect(t.posts().at(-1)).toMatchObject({ url: base, body: { shape: 'aucun' } });
    expect(area().textContent).toContain('Aucun secteur');
  });
});
