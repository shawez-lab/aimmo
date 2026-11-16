import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
import { NEUF_COPY_FAILED, NEUF_LOST, NEUF_MISSING, NEUF_NONE, NEUF_NO_SCALE, NEUF_PORTALS_NOTE, NEUF_REFUSALS, NEUF_SCRIPT, NEUF_SOLD } from '../app/neuf.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : programmes, promoteurs, lots, prix, barèmes, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const PROGRAMS = [
  { programId: 'pg1', name: 'Les Jardins Inventés', city: 'Dijon', postalCode: '21000', promoter: 'Promoteur Inventé', createdAt: '2027-01-02T09:00:00Z' },
  { programId: 'pg2', name: INJECTED, city: 'Chenôve', postalCode: '21300', promoter: 'Autre Promoteur', createdAt: '2027-01-01T09:00:00Z' },
  { programId: '../x', name: 'Mal formé', city: 'X', postalCode: '21000', promoter: 'X' },
];
const fees = {
  newFees: { value: 1_000_000, source: 'Barème neuf du réseau', asOf: '2027-01-01', hypothesis: 'prix TTC du lot × 400 points de base (barème du neuf)' },
  oldFees: { value: 1_875_000, source: 'Barème ancien du réseau', asOf: '2027-01-01', hypothesis: 'même prix × 750 points de base (barème de l’ancien)' },
  saving: { value: 875_000, source: 'calcul:neuf', asOf: '2027-03-10', hypothesis: 'frais de l’ancien − frais du neuf, au même prix' },
};
const A1 = { lotRef: 'A1', typology: 't3', livingAreaHundredths: 6250, floor: 2, priceCents: 25_000_000, confirmedOn: '2027-03-08' };
const B2 = { lotRef: 'B2', typology: 'studio', livingAreaHundredths: 2805, floor: 0, priceCents: 12_345_678, confirmedOn: '2027-03-09' };
const GRID = {
  programId: 'pg1',
  name: 'Les Jardins Inventés',
  city: 'Dijon',
  postalCode: '21000',
  promoter: 'Promoteur Inventé',
  day: '2027-03-10',
  lots: [
    { ...A1, fees },
    { ...B2, fees: null },
  ],
  all: [
    { ...A1, version: 2, status: 'disponible' },
    { ...B2, version: 1, status: 'disponible' },
    { lotRef: 'C3', version: 3, typology: 't2', livingAreaHundredths: 4500, floor: -1, priceCents: 18_000_000, status: 'vendu', confirmedOn: '2027-02-01' },
    { lotRef: 'D4', version: 1, typology: 'maison', livingAreaHundredths: 9000, floor: 1, priceCents: 30_000_000, status: 'disponible', confirmedOn: '2027-01-02' },
    { lotRef: INJECTED, version: 1, typology: 'inconnue', livingAreaHundredths: 1, floor: 0, priceCents: 1, status: 'vendu', confirmedOn: 'x' },
  ],
  toConfirm: ['D4'],
};

const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/gagner/rendez-vous': ok([]),
  'GET /v1/gagner/recommandations/a-appeler': ok([]),
  'GET /v1/gagner/relances': ok([]),
  'GET /v1/gagner/lettres': ok({ campaigns: [], properties: [] }),
  'GET /v1/neuf/programmes': ok(PROGRAMS),
  'GET /v1/neuf/programmes/pg1': ok(GRID),
  'POST /v1/neuf/programmes/pg1/lots': ok({ ...A1, version: 3, status: 'option' }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, clipboard?: { writeText: (t: string) => Promise<void> }) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: Record<string, unknown> | undefined; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) }, ...(clipboard ? { clipboard } : {}) },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['gagner-corps']!;
  const buttons = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = (src: string) => [...els.gagner!.all(), ...els['gagner-corps']!.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  els['gagner-ouvrir']!.listeners.click!({});
  await settle();
  runInNewContext(GAGNER_SCRIPT, context);
  scripts('/app/gagner.js')[0]!.listeners.load!({});
  await settle();
  const part = () => body().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Programmes neufs')!;
  const beforeOpen = scripts('/app/neuf.js').length;
  const callsBefore = calls.length;
  const open = async () => {
    await click(buttons(part(), 'Ouvrir mes programmes')[0]);
    runInNewContext(NEUF_SCRIPT, context);
    const s = scripts('/app/neuf.js');
    s[s.length - 1]!.listeners.load!({});
    await settle();
  };
  const grid = async () => {
    await open();
    await click(buttons(part(), 'Voir la grille')[0]);
  };
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const set = (id: string, value: string) => {
    input(id).value = value;
  };
  const fill = () => {
    set('neuf-lot-ref', 'E5');
    set('neuf-lot-type', 't4');
    set('neuf-lot-surface', '85,5');
    set('neuf-lot-etage', '3');
    set('neuf-lot-prix', '312 000,50');
    set('neuf-lot-etat', 'disponible');
    set('neuf-lot-confirme', '2027-03-10');
  };
  const status = () =>
    part()
      .all()
      .filter((e) => e.attributes.role === 'status')
      .map((e) => e.textContent)
      .join(' | ');
  return { calls, table, part, buttons, click, open, grid, input, set, fill, status, beforeOpen, callsBefore, mine: () => calls.slice(callsBefore).filter((c) => c.url.startsWith('/v1/neuf')) };
}

describe('BR78 · la grille de mes programmes neufs, à l’écran de l’agent', () => {
  it('[R201] un seul script servi à part, chargé au seul geste depuis « Gagner des mandats » ; budgets tenus, sans innerHTML', async () => {
    const t = await run();
    expect(t.beforeOpen).toBe(0);
    expect(t.mine()).toEqual([]);
    await t.open();
    expect(t.mine().map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/neuf/programmes']);
    for (const c of t.mine()) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    expect(AGENT_APP_FILES['/app/neuf.js']).toBe(NEUF_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/neuf.js');
    expect(JS).not.toContain('/app/neuf.js');
    expect(JS).not.toContain('/v1/neuf');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/neuf.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(budgetProblems({ html: '', js: NEUF_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: GAGNER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(NEUF_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    const routes = [...NEUF_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect([...new Set(routes)].sort()).toEqual(['/v1/neuf/programmes', '/v1/neuf/programmes/']);
  });

  it('les programmes de l’agent dans l’ordre reçu ; un identifiant mal formé est tu ; aucun programme : dit en mots', async () => {
    const t = await run();
    await t.open();
    const items = t.part().all().filter((e) => e.tagName === 'ul' && e.className === 'liste')[0]!.children;
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Les Jardins Inventés');
    expect(items[0]!.textContent).toContain('21000 Dijon · promoteur Promoteur Inventé');
    expect(items[1]!.textContent).toContain(INJECTED);
    expect(t.part().textContent).not.toContain('Mal formé');
    const none = await run({ 'GET /v1/neuf/programmes': ok([]) });
    await none.open();
    expect(none.status()).toBe(NEUF_NONE);
  });

  it('[R544] la grille : lots publiés avec prix, surface, étage et frais sourcés ; sans barème, aucun chiffre de frais', async () => {
    const t = await run();
    await t.grid();
    expect(t.mine().map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/neuf/programmes', 'GET /v1/neuf/programmes/pg1']);
    const text = t.part().textContent;
    expect(text).toContain('Promoteur : Promoteur Inventé · 21000 Dijon');
    expect(text).toContain('Lots publiés (2)');
    const pub = t.part().all().find((e) => e.tagName === 'ol')!.children;
    expect(pub[0]!.textContent).toContain('Lot A1 · 250 000 €');
    expect(pub[0]!.textContent).toContain('T3 · 62,5 m² · Étage 2 · confirmé le 08/03/2027');
    expect(pub[0]!.textContent).toContain('Frais du neuf : 10 000 €');
    expect(pub[0]!.textContent).toContain('prix TTC du lot × 400 points de base (barème du neuf) · source : Barème neuf du réseau · en vigueur depuis le 01/01/2027');
    expect(pub[0]!.textContent).toContain('Frais de l’ancien au même prix : 18 750 €');
    expect(pub[0]!.textContent).toContain('Écart : 8 750 €');
    expect(pub[0]!.textContent).not.toContain(NEUF_NO_SCALE);
    // Sans barème : la raison, aucun chiffre de frais.
    expect(pub[1]!.textContent).toContain('Lot B2 · 123 456,78 €');
    expect(pub[1]!.textContent).toContain('Studio · 28,05 m² · Rez-de-chaussée');
    expect(pub[1]!.textContent).toContain(NEUF_NO_SCALE);
    expect(pub[1]!.textContent).not.toContain('Frais du neuf');
    // Un frais incomplet (sans source) n'est jamais dit à moitié.
    const half = await run({ 'GET /v1/neuf/programmes/pg1': ok({ ...GRID, lots: [{ ...A1, fees: { ...fees, saving: { ...fees.saving, source: '' } } }] }) });
    await half.grid();
    expect(half.part().textContent).toContain(NEUF_NO_SCALE);
    expect(half.part().textContent).not.toContain('Écart :');
    // Des frais du neuf plus hauts que ceux de l'ancien : l'écart reçu, négatif, est dit avec son signe [R544].
    const up = { newFees: { ...fees.newFees, value: 2_000_000 }, oldFees: { ...fees.oldFees, value: 1_000_000 }, saving: { ...fees.saving, value: -1_000_000 } };
    const higher = await run({ 'GET /v1/neuf/programmes/pg1': ok({ ...GRID, lots: [{ ...A1, fees: up }] }) });
    await higher.grid();
    expect(higher.part().textContent).toContain('Écart : −10\u202f000\u00a0€');
    expect(higher.part().textContent).not.toContain(NEUF_NO_SCALE);
  });

  it('[R543] les lots à reconfirmer à part ; un lot vendu dit « ne revient jamais », sans aucun geste', async () => {
    const t = await run();
    await t.grid();
    const text = t.part().textContent;
    expect(text).toContain('À reconfirmer auprès du promoteur (1)');
    expect(text).toContain('plus de 14 jours');
    expect(text).toContain('Lot D4');
    expect(text).toContain('Tous les lots (4)');
    const all = t.part().all().filter((e) => e.tagName === 'ul' && e.className === 'liste').at(-1)!.children;
    const sold = all.find((li) => li.textContent.includes('Lot C3'))!;
    expect(sold.textContent).toContain('Vendu');
    expect(sold.textContent).toContain(NEUF_SOLD);
    expect(sold.textContent).toContain('Niveau -1');
    expect(sold.all().some((e) => e.tagName === 'button')).toBe(false);
    expect(all.filter((li) => li.all().some((e) => e.tagName === 'button' && e.textContent === 'Mettre à jour'))).toHaveLength(3);
    // Le lot mal formé est tu, son texte jamais posé comme du HTML.
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('ranger un lot : chaque champ envoyé en entiers, champ manquant refusé avant l’appel, puis la grille relue', async () => {
    const t = await run();
    await t.grid();
    await t.click(t.buttons(t.part(), 'Ranger un nouveau lot')[0]);
    await t.click(t.buttons(t.part(), 'Ranger ce lot')[0]);
    expect(t.status()).toContain(NEUF_MISSING);
    expect(t.mine().filter((c) => c.method === 'POST')).toEqual([]);
    t.fill();
    t.set('neuf-lot-surface', '85,555');
    await t.click(t.buttons(t.part(), 'Ranger ce lot')[0]);
    expect(t.mine().filter((c) => c.method === 'POST')).toEqual([]);
    t.fill();
    const before = t.mine().length;
    await t.click(t.buttons(t.part(), 'Ranger ce lot')[0]);
    const after = t.mine().slice(before);
    expect(after.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /v1/neuf/programmes/pg1/lots', 'GET /v1/neuf/programmes/pg1']);
    expect(after[0]!.body).toEqual({ lotRef: 'E5', typology: 't4', livingAreaHundredths: 8550, floor: 3, priceCents: 31_200_050, status: 'disponible', confirmedOn: '2027-03-10' });
    expect(t.status()).toContain('Lot E5 rangé.');
  });

  it('mettre à jour un lot reprend ses valeurs, la référence fixée', async () => {
    const t = await run();
    await t.grid();
    await t.click(t.buttons(t.part(), 'Mettre à jour')[0]);
    expect(t.input('neuf-lot-ref').value).toBe('A1');
    expect(t.input('neuf-lot-ref').attributes.readonly).toBe('readonly');
    expect(t.input('neuf-lot-type').value).toBe('t3');
    expect(t.input('neuf-lot-surface').value).toBe('62,5');
    expect(t.input('neuf-lot-etage').value).toBe('2');
    expect(t.input('neuf-lot-prix').value).toBe('250000');
    t.set('neuf-lot-etat', 'option');
    t.set('neuf-lot-confirme', '2027-03-10');
    const before = t.mine().length;
    await t.click(t.buttons(t.part(), 'Ranger ce lot')[0]);
    expect(t.mine()[before]!.body).toEqual({ lotRef: 'A1', typology: 't3', livingAreaHundredths: 6250, floor: 2, priceCents: 25_000_000, status: 'option', confirmedOn: '2027-03-10' });
  });

  it('[R543, R16] chaque refus est dit en mots, jamais par son code ; une écriture sans réponse est incertaine et la grille relue', async () => {
    const t = await run({ 'POST /v1/neuf/programmes/pg1/lots': no(409, { ok: false, rule: 'R543', code: 'vendu' }) });
    await t.grid();
    await t.click(t.buttons(t.part(), 'Ranger un nouveau lot')[0]);
    t.fill();
    await t.click(t.buttons(t.part(), 'Ranger ce lot')[0]);
    expect(t.status()).toContain(NEUF_REFUSALS.vendu);
    expect(t.part().textContent).not.toContain('R543');
    const lost = await run({ 'POST /v1/neuf/programmes/pg1/lots': cut });
    await lost.grid();
    await lost.click(lost.buttons(lost.part(), 'Ranger un nouveau lot')[0]);
    lost.fill();
    const before = lost.mine().length;
    await lost.click(lost.buttons(lost.part(), 'Ranger ce lot')[0]);
    expect(lost.mine().slice(before).map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(lost.status()).toContain(NEUF_LOST);
    const left = await run({ 'GET /v1/neuf/programmes': no(403, { ok: false, rule: 'R16', code: 'agent_left' }) });
    await left.open();
    expect(left.status()).toBe(NEUF_REFUSALS.agent_left);
    const other = await run({ 'GET /v1/neuf/programmes/pg1': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await other.grid();
    expect(other.status()).toBe(NEUF_REFUSALS.not_assigned);
    const odd = await run({ 'GET /v1/neuf/programmes/pg1': no(409, { ok: false, rule: null, code: 'constructor' }) });
    await odd.grid();
    expect(odd.status()).toBe('La grille ne se lit pas pour le moment.');
  });

  it('le retour mène à la liste ; tout texte reçu est posé en texte', async () => {
    const t = await run();
    await t.grid();
    await t.click(t.buttons(t.part(), 'Retour à mes programmes')[0]);
    expect(t.buttons(t.part(), 'Voir la grille')).toHaveLength(2);
    expect(t.part().textContent).toContain(INJECTED);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
  });
});

describe('BR99 · le texte des portails d’un programme neuf, prêt à copier (Jamais vu)', () => {
  const LISTING = {
    programId: 'pg1',
    title: `Les Jardins Inventés, programme neuf à Dijon : 2 lots dès 123 456,78 € ${INJECTED}`,
    body: `Programme neuf Les Jardins Inventés.\n• Lot B2 · Studio\n• Lot A1 · T3 ${INJECTED}`,
    day: '2027-03-10',
    validUntil: '2027-03-22',
    lots: [
      { lotRef: 'B2', priceCents: 12_345_678, confirmedOn: '2027-03-09', written: true },
      { lotRef: 'A1', priceCents: 25_000_000, confirmedOn: '2027-03-08', written: true },
    ],
    omitted: 0,
  };
  const portals = (t: Awaited<ReturnType<typeof run>>) => t.part().all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Texte pour les portails')!;

  it('[R543] [R10] au seul geste, titre et texte posés en texte, le jour où il tient et le lendemain dits en mots ; copie réussie dite', async () => {
    const copied: string[] = [];
    const t = await run({ 'GET /v1/neuf/programmes/pg1/annonce': ok(LISTING) }, { writeText: async (x) => void copied.push(x) });
    await t.grid();
    const box = portals(t);
    expect(box.textContent).toContain(NEUF_PORTALS_NOTE);
    // Rien n'est lu avant le geste.
    expect(t.mine().some((c) => c.url.endsWith('/annonce'))).toBe(false);
    await t.click(t.buttons(box, 'Préparer le texte des portails')[0]);
    expect(t.mine().filter((c) => c.url.endsWith('/annonce')).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/neuf/programmes/pg1/annonce']);
    expect(box.textContent).toContain('Ce texte tient jusqu’au 22/03/2027 inclus. Le 23/03/2027, un lot n’est plus confirmé : faites reconfirmer les lots par le promoteur, puis recopiez le texte, ou retirez l’annonce.');
    expect(box.textContent).toContain(LISTING.title);
    const area = box.all().find((e) => e.tagName === 'textarea')!;
    expect(area.textContent).toBe(LISTING.body);
    expect(area.attributes.readonly).toBe('readonly');
    expect(box.all().some((e) => e.tagName === 'img')).toBe(false);
    await t.click(t.buttons(box, 'Copier le titre')[0]);
    expect(box.textContent).toContain('Titre copié.');
    await t.click(t.buttons(box, 'Copier le texte')[0]);
    expect(box.textContent).toContain('Texte copié.');
    expect(copied).toEqual([LISTING.title, LISTING.body]);
  });

  it('le lendemain passe le mois et l’année ; des lots comptés sans ligne sont dits', async () => {
    const t = await run({ 'GET /v1/neuf/programmes/pg1/annonce': ok({ ...LISTING, validUntil: '2027-12-31', omitted: 3 }) });
    await t.grid();
    await t.click(t.buttons(portals(t), 'Préparer le texte des portails')[0]);
    expect(portals(t).textContent).toContain('jusqu’au 31/12/2027 inclus. Le 01/01/2028,');
    expect(portals(t).textContent).toContain('3 lots ne tiennent pas dans les 4 000 signes');
  });

  it('copie impossible : dit en mots, le texte reste à sélectionner', async () => {
    const none = await run({ 'GET /v1/neuf/programmes/pg1/annonce': ok(LISTING) });
    await none.grid();
    await none.click(none.buttons(portals(none), 'Préparer le texte des portails')[0]);
    await none.click(none.buttons(portals(none), 'Copier le texte')[0]);
    expect(portals(none).textContent).toContain(NEUF_COPY_FAILED);
    const refused = await run({ 'GET /v1/neuf/programmes/pg1/annonce': ok(LISTING) }, { writeText: () => Promise.reject(new Error('refusé')) });
    await refused.grid();
    await refused.click(refused.buttons(portals(refused), 'Préparer le texte des portails')[0]);
    await refused.click(refused.buttons(portals(refused), 'Copier le titre')[0]);
    expect(portals(refused).textContent).toContain(NEUF_COPY_FAILED);
    expect(portals(refused).textContent).not.toContain('Titre copié.');
  });

  it('[R10] refus dits en mots, jamais un code ; lecture en échec : « texte non préparé », jamais un texte d’avant', async () => {
    const empty = await run({ 'GET /v1/neuf/programmes/pg1/annonce': no(409, { ok: false, rule: 'R543', code: 'no_lot_published' }) });
    await empty.grid();
    await empty.click(empty.buttons(portals(empty), 'Préparer le texte des portails')[0]);
    expect(portals(empty).textContent).toContain(`Texte non préparé : ${NEUF_REFUSALS.no_lot_published}`);
    expect(portals(empty).textContent).not.toContain('no_lot_published');
    expect(portals(empty).all().some((e) => e.tagName === 'textarea')).toBe(false);

    // Un premier texte, puis la relecture coupée : l'ancien texte disparaît.
    const t = await run({ 'GET /v1/neuf/programmes/pg1/annonce': ok(LISTING) });
    await t.grid();
    await t.click(t.buttons(portals(t), 'Préparer le texte des portails')[0]);
    expect(portals(t).textContent).toContain(LISTING.title);
    t.table['GET /v1/neuf/programmes/pg1/annonce'] = cut;
    await t.click(t.buttons(portals(t), 'Préparer le texte des portails')[0]);
    expect(portals(t).textContent).not.toContain(LISTING.title);
    expect(portals(t).all().some((e) => e.tagName === 'textarea')).toBe(false);
    expect(portals(t).textContent).toContain('Texte non préparé');

    // Une réponse mal formée ou un code inconnu : jamais un texte, jamais le code.
    const odd = await run({ 'GET /v1/neuf/programmes/pg1/annonce': ok({ ...LISTING, validUntil: 'demain' }) });
    await odd.grid();
    await odd.click(odd.buttons(portals(odd), 'Préparer le texte des portails')[0]);
    expect(portals(odd).textContent).toContain('Texte non préparé : la grille ne se lit pas pour le moment.');
    expect(portals(odd).textContent).not.toContain(LISTING.title);
  });
});
