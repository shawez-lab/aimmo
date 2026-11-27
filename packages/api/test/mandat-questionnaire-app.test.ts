import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { MANDAT_SCRIPT } from '../app/mandat.ts';
import { MANDAT_QUESTIONNAIRE_SCRIPT } from '../app/mandat-questionnaire.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds, placeTool } from './fake-dom.ts';

// BR116. Tout est inventé : clé, bien, propriétaire, questions, clauses, prix, avis de valeur.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
type Call = { method: string; url: string; body: unknown };
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, code: string, rule: string | null = null): Answer => async () => Response.json({ ok: false, rule, code }, { status });
const OWNER = { personId: 'p1', firstName: 'Léa', lastName: 'Exemple' };
const READ = { propertyId: 'b1', documents: [] as unknown[], mandate: null as unknown, owners: [OWNER] };
/** Un catalogue d'essai, plus court que le vrai : l'écran pose ce que l'API rend, sans liste à lui. */
const CATALOGUE = {
  questions: [
    { code: 'exclusivite', label: 'Le vendeur confie-t-il la vente à AIMMO seul ?', answers: [{ value: 'oui', label: 'oui, en exclusivité' }, { value: 'non', label: 'non, mandat simple' }] },
    { code: 'lieu_signature', label: 'Où le mandat est-il signé ?', answers: [{ value: 'agence', label: 'à l’agence' }, { value: 'hors_agence', label: 'hors de l’agence (domicile du vendeur)' }] },
  ],
  clauses: [
    { code: 'exclusivite', title: 'Exclusivité', basis: 'Décret essai, article 1', when: [{ question: 'exclusivite', answer: 'oui' }] },
    { code: 'retractation', title: 'Droit de rétractation de 14 jours', basis: 'Code essai, article 2', when: [{ question: 'lieu_signature', answer: 'hors_agence' }] },
  ],
  defaultMaxGapBps: 500,
};
const MANDATE = {
  id: 'q1',
  documentId: 'd9',
  kind: 'mandat_vente_exclusif',
  mode: 'essai',
  missing: ['clause:retractation', 'champ:honoraires.montant'],
  clauses: [
    { code: 'exclusivite', title: 'Exclusivité', question: 'exclusivite', answer: 'oui', basis: 'Décret essai, article 1', clauseId: 'c1', version: 2, hash: 'h', status: 'valide' },
    { code: 'retractation', title: 'Droit de rétractation de 14 jours', question: 'lieu_signature', answer: 'hors_agence', basis: 'Code essai, article 2', clauseId: null, version: null, hash: null, status: 'manquante' },
  ],
  price: { priceEur: 262500, low: 230000, high: 250000, gapBps: 500, maxGapBps: 300, check: 'ecart', valuationId: 'v1' },
  content: '<p>Texte de clause secret d’essai</p>',
  contentHash: 'x',
  createdAt: '2027-02-10T09:00:00.000Z',
};
const PREPARE = 'POST /v1/questionnaire-mandat/mandats';
const ACK = 'POST /v1/questionnaire-mandat/mandats/q1/ecart-montre';
const CHECK = 'GET /v1/questionnaire-mandat/mandats/q1/avant-signature';
const LIST = 'GET /v1/questionnaire-mandat/biens/b1/mandats';
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/annonces': ok([{ id: 'b1', reference: 'AV-1', city: 'Dijon', state: null }]),
  'GET /v1/biens/b1/mandat': ok(READ),
  'GET /v1/questionnaire-mandat': ok(CATALOGUE),
  [PREPARE]: ok(MANDATE),
  [CHECK]: ok({ ready: false, blockers: ['essai', 'manque', 'ecart_prix'] }),
  [ACK]: ok(null),
  [LIST]: ok([]),
};
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: Call[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document: { ...document, body: { appendChild() {}, removeChild() {} } },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: unknown } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? null) });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    crypto: globalThis.crypto,
    setTimeout,
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const body = () => els['mandat-corps']!;
  const find = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const press = (text: string) => click(find(text));
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)! as FakeElement & { value: string };
  const box = () => body().all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Préparer par questionnaire');
  const status = () => box()!.all().find((e) => e.className === 'etat')?.textContent ?? '';
  const open = async () => {
    await click(placeTool(els, 'Mandat'));
    const s = els.mandat!.children.filter((e) => e.tagName === 'script');
    runInNewContext(MANDAT_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  /** Ouvre le questionnaire et fait arriver son script, comme le navigateur. */
  const openQuestionnaire = async () => {
    await press('Ouvrir le questionnaire');
    const s = box()!.all().filter((e) => e.tagName === 'script');
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/mandat-questionnaire.js']);
    runInNewContext(MANDAT_QUESTIONNAIRE_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  const answerAll = () => {
    input('mq-exclusivite').value = 'oui';
    input('mq-lieu_signature').value = 'hors_agence';
  };
  return { els, calls, table, body, press, input, box, status, open, openQuestionnaire, answerAll, find, posts: () => calls.filter((c) => c.method === 'POST') };
}

describe('BR116 · le mandat par questionnaire à l’écran', () => {
  it('[R201] le script est à part, chargé au geste, et l’application reste dans son budget', async () => {
    expect(AGENT_APP_FILES['/app/mandat-questionnaire.js']).toBe(MANDAT_QUESTIONNAIRE_SCRIPT);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(budgetProblems({ html: '', js: MANDAT_QUESTIONNAIRE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: MANDAT_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(JS).not.toContain('mandat-questionnaire.js');
    const t = await run();
    await t.open();
    expect(t.box()).toBeDefined();
    expect(t.calls.some((c) => c.url.startsWith('/v1/questionnaire-mandat'))).toBe(false);
  });

  it('[R440] les questions viennent de l’API en listes fermées, et une question sans réponse n’envoie rien', async () => {
    const t = await run();
    await t.open();
    await t.openQuestionnaire();
    const q = t.input('mq-exclusivite');
    expect(q.tagName).toBe('select');
    expect(q.children.map((o) => o.value)).toEqual(['', 'oui', 'non']);
    expect(t.box()!.textContent).toContain('Où le mandat est-il signé ?');
    t.input('mq-exclusivite').value = 'oui';
    await t.press('Préparer le mandat par questionnaire');
    expect(t.status()).toBe('Répondez à la question : Où le mandat est-il signé ?');
    // Une valeur hors de la liste rendue par l'API n'est jamais envoyée.
    t.input('mq-lieu_signature').value = 'chez le notaire';
    await t.press('Préparer le mandat par questionnaire');
    expect(t.posts()).toEqual([]);
  });

  it('[R440] le mandat se prépare avec les seules réponses de la liste, et chaque clause dit sa réponse et sa loi', async () => {
    const t = await run();
    await t.open();
    await t.openQuestionnaire();
    t.answerAll();
    t.input('mq-honoraires').value = '9000';
    t.input('mq-duree').value = '12';
    await t.press('Préparer le mandat par questionnaire');
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/questionnaire-mandat/mandats', body: { personId: 'p1', propertyId: 'b1', answers: { exclusivite: 'oui', lieu_signature: 'hors_agence' }, inputs: { 'honoraires.montant': 9000, 'mandat.duree_mois': 12 } } }]);
    const text = t.box()!.textContent;
    expect(text).toContain('Exclusivité');
    expect(text).toContain('Parce que : Le vendeur confie-t-il la vente à AIMMO seul ? → oui, en exclusivité');
    expect(text).toContain('Fondement : Décret essai, article 1');
    expect(text).toContain('Parce que : Où le mandat est-il signé ? → hors de l’agence (domicile du vendeur)');
    expect(text).toContain('Fondement : Code essai, article 2');
    expect(text).toContain('Texte validé par la conformité.');
    expect(text).toContain('Texte pas encore écrit par la direction.');
    expect(text).toContain('le texte de la clause « Droit de rétractation de 14 jours »');
    // Le texte du mandat rendu par l'API n'est jamais posé à l'écran.
    expect(text).not.toContain('secret');
  });

  it('[R441] l’écart de prix se montre, le geste de l’agent appelle la route prévue, et le contrôle se relit', async () => {
    const t = await run();
    await t.open();
    await t.openQuestionnaire();
    t.answerAll();
    await t.press('Préparer le mandat par questionnaire');
    const text = t.box()!.textContent;
    expect(text).toContain('Écart de 5 % au-dessus de la fourchette (toléré : 3 %)');
    expect(text).toContain('L’écart entre le prix et l’avis de valeur n’est pas encore montré au vendeur.');
    expect(text).not.toContain('Rien n’empêche de signer');
    t.table[CHECK] = ok({ ready: false, blockers: ['essai', 'manque'] });
    await t.press('J’ai montré l’écart au vendeur');
    expect(t.posts().map((c) => [c.url, c.body])).toContainEqual(['/v1/questionnaire-mandat/mandats/q1/ecart-montre', {}]);
    expect(t.status()).toBe('Noté : le vendeur a vu le prix comparé à l’avis de valeur.');
    expect(t.box()!.textContent).not.toContain('pas encore montré au vendeur');
    expect(t.calls.filter((c) => c.url === '/v1/questionnaire-mandat/mandats/q1/avant-signature')).toHaveLength(2);
  });

  it('[R441] un prix dans la fourchette n’a pas de geste ; « prêt » n’est dit que sans aucun blocage', async () => {
    const t = await run({
      [PREPARE]: ok({ ...MANDATE, missing: [], price: { ...MANDATE.price, priceEur: 240000, gapBps: 0, check: 'dans_fourchette' } }),
      [CHECK]: ok({ ready: true, blockers: [] }),
    });
    await t.open();
    await t.openQuestionnaire();
    t.answerAll();
    await t.press('Préparer le mandat par questionnaire');
    expect(t.box()!.textContent).toContain('Le prix est dans la fourchette.');
    expect(t.find('J’ai montré l’écart au vendeur')).toBeUndefined();
    expect(t.box()!.textContent).toContain('Rien n’empêche de signer');
    // Un « prêt » contredit par un blocage, ou un blocage inconnu, n'est jamais dit prêt.
    for (const data of [{ ready: true, blockers: ['essai'] }, { ready: false, blockers: ['jamais_vu'] }, { ready: false, blockers: [] }]) {
      const u = await run({ [CHECK]: ok(data) });
      await u.open();
      await u.openQuestionnaire();
      u.answerAll();
      await u.press('Préparer le mandat par questionnaire');
      expect(u.box()!.textContent).not.toContain('Rien n’empêche de signer');
    }
    const v = await run({ [CHECK]: no(500, 'boom') });
    await v.open();
    await v.openQuestionnaire();
    v.answerAll();
    await v.press('Préparer le mandat par questionnaire');
    expect(v.box()!.textContent).toContain('rien n’est dit prêt');
  });

  it('les refus du code se disent en français, sans rien ranger de faux', async () => {
    const t = await run({ [PREPARE]: no(409, 'no_template'), [ACK]: no(403, 'not_property_agent', 'R16') });
    await t.open();
    await t.openQuestionnaire();
    t.answerAll();
    await t.press('Préparer le mandat par questionnaire');
    expect(t.status()).toBe('Aucun modèle de mandat n’est encore enregistré : voyez avec la direction.');
    t.table[PREPARE] = ok(MANDATE);
    await t.press('Préparer le mandat par questionnaire');
    await t.press('J’ai montré l’écart au vendeur');
    expect(t.status()).toBe('Seul l’agent du bien dit avoir montré l’écart au vendeur.');
    const u = await run({ 'GET /v1/questionnaire-mandat': no(403, 'role', 'R16') });
    await u.open();
    await u.openQuestionnaire();
    expect(u.status()).toBe('Le questionnaire est réservé à l’agent et à la direction.');
    expect(u.posts()).toEqual([]);
  });

  it('[R13] aucune adresse appelée ne porte un prix, une réponse ou un texte ; rien n’est gardé dans le navigateur', async () => {
    const t = await run();
    await t.open();
    await t.openQuestionnaire();
    t.answerAll();
    t.input('mq-honoraires').value = '9000';
    await t.press('Préparer le mandat par questionnaire');
    await t.press('J’ai montré l’écart au vendeur');
    for (const c of t.calls) expect(c.url).not.toMatch(/9000|262500|oui|hors_agence|\?/);
    expect(MANDAT_QUESTIONNAIRE_SCRIPT).not.toMatch(/localStorage|sessionStorage|indexedDB|innerHTML/);
  });

  it('quitter l’écran rend muette une réponse en retard', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = await run({ [PREPARE]: () => new Promise<Response>((r) => (release = r)) });
    await t.open();
    await t.openQuestionnaire();
    t.answerAll();
    const before = t.box()!;
    await t.press('Préparer le mandat par questionnaire');
    t.els['mandat-retour']!.listeners.click!({});
    await settle();
    release(Response.json({ ok: true, mode: 'essai', data: MANDATE }));
    await settle();
    expect(before.textContent).not.toContain('Parce que');
  });
});

describe('BR117 · rouvrir un mandat préparé par questionnaire', () => {
  const { content: _content, ...STORED } = MANDATE;
  const EARLIER = { ...STORED, gapAcknowledged: false, ready: false, blockers: ['essai', 'manque', 'ecart_prix'] };

  it('[R441] les mandats déjà préparés pour le bien se listent et se rouvrent, avec l’écart et le geste, sans refaire le questionnaire', async () => {
    const t = await run({ [LIST]: ok([EARLIER]) });
    await t.open();
    await t.openQuestionnaire();
    expect(t.calls.map((c) => `${c.method} ${c.url}`)).toContain(LIST);
    const text = t.box()!.textContent;
    expect(text).toContain('Déjà préparés pour ce bien');
    expect(text).toContain('Mandat exclusif, préparé le 10/02/2027 (document d’essai).');
    expect(text).toContain('Un point reste à régler avant de signer.');
    await t.press('Rouvrir');
    const after = t.box()!.textContent;
    expect(after).toContain('Parce que : Le vendeur confie-t-il la vente à AIMMO seul ? → oui, en exclusivité');
    expect(after).toContain('Écart de 5 % au-dessus de la fourchette (toléré : 3 %)');
    expect(after).toContain('L’écart entre le prix et l’avis de valeur n’est pas encore montré au vendeur.');
    await t.press('J’ai montré l’écart au vendeur');
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/questionnaire-mandat/mandats/q1/ecart-montre']);
    expect(t.status()).toBe('Noté : le vendeur a vu le prix comparé à l’avis de valeur.');
    // Rouvrir le même mandat après le geste ne le repropose pas.
    await t.press('Rouvrir');
    expect(t.find('J’ai montré l’écart au vendeur')).toBeUndefined();
    expect(t.box()!.textContent).toContain('Noté : le vendeur a vu le prix comparé à l’avis de valeur.');
  });

  it('[R441] un geste déjà noté ne se repropose pas ; une liste vide ou illisible ne dit rien de faux', async () => {
    const t = await run({ [LIST]: ok([{ ...EARLIER, gapAcknowledged: true, blockers: ['essai', 'manque'] }]) });
    await t.open();
    await t.openQuestionnaire();
    await t.press('Rouvrir');
    expect(t.find('J’ai montré l’écart au vendeur')).toBeUndefined();
    expect(t.box()!.textContent).toContain('Noté : le vendeur a vu le prix comparé à l’avis de valeur.');
    expect(t.box()!.textContent).not.toContain('Rien n’empêche de signer');

    const empty = await run();
    await empty.open();
    await empty.openQuestionnaire();
    expect(empty.box()!.textContent).not.toContain('Déjà préparés');
    expect(empty.find('Rouvrir')).toBeUndefined();

    const refused = await run({ [LIST]: no(403, 'not_property_agent', 'R16') });
    await refused.open();
    await refused.openQuestionnaire();
    expect(refused.box()!.textContent).toContain('Seul l’agent du bien dit avoir montré l’écart au vendeur.');
    expect(refused.find('Rouvrir')).toBeUndefined();
    // Le questionnaire reste utilisable pour préparer un nouveau mandat.
    refused.answerAll();
    await refused.press('Préparer le mandat par questionnaire');
    expect(refused.posts().map((c) => c.url)).toEqual(['/v1/questionnaire-mandat/mandats']);
  });

  it('[R13] un identifiant mal formé n’est pas rouvert, et aucune adresse ne porte un prix', async () => {
    const t = await run({ [LIST]: ok([{ ...EARLIER, id: 'q 1/../x' }]) });
    await t.open();
    await t.openQuestionnaire();
    expect(t.find('Rouvrir')).toBeUndefined();
    const u = await run({ [LIST]: ok([EARLIER]) });
    await u.open();
    await u.openQuestionnaire();
    await u.press('Rouvrir');
    for (const c of u.calls) expect(c.url).not.toMatch(/262500|250000|\?/);
    expect(budgetProblems({ html: '', js: MANDAT_QUESTIONNAIRE_SCRIPT }, BUDGETS.page)).toEqual([]);
  });
});
