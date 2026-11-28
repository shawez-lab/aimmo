import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { OFFRES_SCRIPT } from '../app/offres.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds, placeTool } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
type Call = { method: string; url: string; body: unknown; headers?: Record<string, string> };
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, code: string, extra: Record<string, unknown> = {}): Answer => async () => Response.json({ ok: false, code, ...extra }, { status });
const OFFER = {
  seq: 1, id: 'o1', amountEur: 205000, offeredEur: 205000, netSellerEur: 195000, conditions: ['pret'], conditionDetails: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }],
  daysLeft: 3, state: 'recue', counterProposals: 0, buyer: { firstName: 'Acheteur', lastName: '<b>Exemple</b>' }, validUntil: '2027-03-10', downPaymentEur: 70000, loanEur: 150000,
  next: 'transmettre', proposalId: null, file: null, history: [{ at: '2027-03-01T09:00:00.000Z', event: 'recue', amountEur: 205000 }],
};
const board = (offers: unknown[], intact = true) => ({ count: offers.length, registerIntact: intact, offers });
const SUIVI = 'GET /v1/offres/biens/b1/suivi';
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/annonces': ok([{ id: 'b1', reference: 'AV-1', city: 'Dijon', state: 'en_vente' }]),
};
const pdf = (type = 'application/pdf', size = 8) => ({ type, size, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7').buffer });

async function run(answers: Record<string, Answer>) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: Call[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document: { ...document, body: { appendChild() {}, removeChild() {} } },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? null), ...(init.headers ? { headers: init.headers } : {}) });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    crypto: globalThis.crypto,
    setTimeout,
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  const settle = async () => {
    for (let i = 0; i < 16; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await settle();
  const body = () => els['offres-corps']!;
  const state = () => els['offres-etat']!.textContent;
  const byText = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)! as FakeElement & { value: string; files?: unknown[] };
  const open = async () => {
    await click(placeTool(els, 'Offres'));
    const s = els.offres!.children.filter((e) => e.tagName === 'script');
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/offres.js']);
    runInNewContext(OFFRES_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  const buttons = () => body().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, body, state, byText, click, input, open, buttons, posts };
}

describe('O10 · écran des offres', () => {
  it('[R201] le script est à part, et l’application reste dans son budget', () => {
    expect(AGENT_APP_FILES['/app/offres.js']).toBe(OFFRES_SCRIPT);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(budgetProblems({ html: '', js: OFFRES_SCRIPT }, BUDGETS.page)).toEqual([]);
  });

  it('[R56] l’écran dit le registre et le prochain pas ; un nom reçu reste un texte', async () => {
    const t = await run({ [SUIVI]: ok(board([OFFER])) });
    await t.open();
    const text = t.body().textContent;
    expect(text).toContain('1 offre reçue');
    expect(text).toContain('Registre intact');
    expect(text).toContain('Offre n° 1 · Acheteur <b>Exemple</b>');
    expect(text).toContain('205 000 €');
    expect(text).toContain('Net vendeur, honoraires du mandat déduits : 195 000 €');
    expect(text).toContain('prêt de 150 000 € sur 240 mois');
    expect(text).toContain('reste 3 jours');
    expect(text).toContain('Prochain pas : la transmettre au vendeur.');
  });

  it('[R56] un registre abîmé se dit, et l’ordre reste celui du serveur', async () => {
    const t = await run({ [SUIVI]: ok(board([OFFER, { ...OFFER, id: 'o2', seq: 2, amountEur: 300000 }], false)) });
    await t.open();
    expect(t.body().textContent).toContain('Registre à vérifier');
    expect(t.body().textContent).toContain('Dans l’ordre d’arrivée, sans classement.');
    const titles = t.body().all().filter((e) => e.tagName === 'h3').map((e) => e.textContent);
    expect(titles.slice(1)).toEqual(['Offre n° 1 · Acheteur <b>Exemple</b>', 'Offre n° 2 · Acheteur <b>Exemple</b>']);
  });

  it('[R57] aucun bouton n’accepte ni ne refuse : la transmission se note, la réponse se choisit et demande sa preuve', async () => {
    const t = await run({ [SUIVI]: ok(board([OFFER])), 'POST /v1/offres/o1/transmission': ok({ via: 'telephone' }) });
    await t.open();
    expect(t.buttons().some((b) => /accepter|refuser|négocier/i.test(b))).toBe(false);
    await t.click(t.byText('Noter la transmission'));
    expect(t.posts()).toEqual([]);
    expect(t.state()).toContain('Dites comment');
    t.input('o1-via').value = 'telephone';
    await t.click(t.byText('Noter la transmission'));
    expect(t.state()).toBe('Dites quand le vendeur l’a reçue.');
    expect(t.posts()).toEqual([]);
    t.input('o1-quand').value = '2027-03-01T10:00';
    t.table[SUIVI] = ok(board([{ ...OFFER, state: 'transmise', next: 'reponse_vendeur' }]));
    await t.click(t.byText('Noter la transmission'));
    expect(t.posts()[0]).toMatchObject({ url: '/v1/offres/o1/transmission', body: { via: 'telephone', at: new Date('2027-03-01T10:00').toISOString() } });
    expect(t.state()).toBe('Transmission rangée.');

    // La réponse : ni choisie d'avance, ni sans heure, ni sans preuve.
    expect(t.input('o1-reponse').value).toBe('');
    await t.click(t.byText('Ranger la réponse'));
    expect(t.state()).toBe('Choisissez la réponse rapportée.');
    t.input('o1-reponse').value = 'acceptee';
    await t.click(t.byText('Ranger la réponse'));
    expect(t.state()).toBe('Dites quand la réponse a été reçue.');
    t.input('o1-heure').value = '2027-03-01T11:00';
    await t.click(t.byText('Ranger la réponse'));
    expect(t.state()).toBe('Joignez la preuve de la réponse.');
    expect(t.posts()).toHaveLength(1);
  });

  it('[R57] la preuve est déposée une fois, puis la réponse part avec sa référence ; un refus la garde', async () => {
    const ref = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000001.pdf';
    const t = await run({
      [SUIVI]: ok(board([{ ...OFFER, state: 'transmise', next: 'reponse_vendeur' }])),
      'POST /v1/offres/biens/b1/fichiers/preuve': ok({ ref }),
      'POST /v1/offres/o1/reponse': no(409, 'expired', { rule: 'R59' }),
    });
    await t.open();
    t.input('o1-reponse').value = 'acceptee';
    t.input('o1-heure').value = '2027-03-01T11:00';
    t.input('o1-preuve').files = [pdf('text/html')];
    await t.click(t.byText('Ranger la réponse'));
    expect(t.state()).toBe('Ce fichier n’est pas admis : PDF, JPEG ou PNG.');
    expect(t.posts()).toEqual([]);
    const file = pdf();
    t.input('o1-preuve').files = [file];
    await t.click(t.byText('Ranger la réponse'));
    expect(t.state()).toBe('Cette offre est échue : elle ne peut plus être acceptée.');
    const up = t.posts()[0]!;
    expect(up.url).toBe('/v1/offres/biens/b1/fichiers/preuve');
    expect(up.body).toBe(file);
    expect(up.headers!['x-aimmo-sha256']).toMatch(/^[0-9a-f]{64}$/);
    const again = t.posts().length;
    await t.click(t.byText('Ranger la réponse'));
    expect(t.posts().slice(again).map((c) => c.url)).toEqual(['/v1/offres/o1/reponse']);
    expect(t.posts()[1]!.body).toMatchObject({ outcome: 'acceptee', proofRef: ref });
  });

  it('la chaîne : ranger, transmettre, rapporter, chaque pas sur sa route', async () => {
    const ref = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000002.png';
    const t = await run({ [SUIVI]: ok(board([{ ...OFFER, state: 'contre_offre', next: 'ranger_proposition' }])), 'POST /v1/offres/biens/b1/fichiers/preuve': ok({ ref }), 'POST /v1/offres/o1/propositions': ok({ id: 'p1' }), 'POST /v1/offres/propositions/p1/transmission': ok(null) });
    await t.open();
    t.input('o1-montant').value = 'abc';
    await t.click(t.byText('Ranger la proposition'));
    expect(t.state()).toBe('Le montant s’écrit en euros, en chiffres seulement.');
    t.input('o1-montant').value = '210 000';
    t.input('o1-validite').value = '2027-03-05';
    t.input('o1-preuve').files = [pdf('image/png')];
    t.table[SUIVI] = ok(board([{ ...OFFER, state: 'contre_offre', next: 'transmettre_proposition', proposalId: 'p1', history: [{ at: '2027-03-01T12:00:00.000Z', event: 'proposition:1:vendeur', amountEur: 210000 }] }]));
    await t.click(t.byText('Ranger la proposition'));
    expect(t.posts().at(-1)).toMatchObject({ url: '/v1/offres/o1/propositions', body: { amountEur: 210000, validUntil: '2027-03-05', proofRef: ref } });
    expect(t.body().textContent).toContain('Proposition du vendeur : 210 000 €');
    t.input('o1-via').value = 'ecrit';
    t.input('o1-quand').value = '2027-03-01T13:00';
    await t.click(t.byText('Noter la transmission'));
    expect(t.posts().at(-1)).toMatchObject({ url: '/v1/offres/propositions/p1/transmission', body: { via: 'ecrit' } });
  });

  it('[R58] le dossier s’ouvre après l’acceptation, et le compromis bloqué dit pourquoi', async () => {
    const t = await run({ [SUIVI]: ok(board([{ ...OFFER, state: 'acceptee', next: 'ouvrir_dossier' }])), 'POST /v1/offres/o1/dossier': ok({ id: 'f1' }), 'POST /v1/offres/dossiers/f1/compromis': no(409, 'identity_missing', { rule: 'R58' }) });
    await t.open();
    t.table[SUIVI] = ok(board([{ ...OFFER, state: 'acceptee', next: 'preparer_compromis', file: { id: 'f1', compromisStarted: false } }]));
    await t.click(t.byText('Ouvrir le dossier de vente'));
    expect(t.state()).toBe('Dossier de vente ouvert.');
    await t.click(t.byText('Préparer le compromis'));
    expect(t.state()).toBe('Identité de l’acquéreur à vérifier : le compromis reste bloqué.');
  });

  it('[R14] le contrôle montre des constats, jamais une note', async () => {
    const t = await run({ [SUIVI]: ok(board([OFFER])), 'POST /v1/offres/o1/controle': ok([{ check: 'identite', status: 'non_verifiee' }, { check: 'financement', status: 'ecart', missingEur: 5000 }, { check: 'pret', status: 'coherent' }, { check: 'validite', status: 'en_cours', lastDay: '2027-03-10' }]) });
    await t.open();
    await t.click(t.byText('Voir le contrôle'));
    const text = t.body().textContent;
    expect(text).toContain('Identité non vérifiée.');
    expect(text).toContain('Écart entre le montant et le financement déclaré : 5 000 €.');
    expect(text).not.toMatch(/\bnote\b|score|solvab/i);
  });

  it('[R16] [R56] une offre s’inscrit en choisissant l’acquéreur parmi les contacts, sans identifiant saisi, avec une clé d’envoi stable', async () => {
    const ref = 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000001.pdf';
    const t = await run({
      [SUIVI]: ok(board([])),
      'GET /v1/offres/biens/b1/contacts': ok({ contacts: [{ personId: 'p1', firstName: 'Acheteur', lastName: 'Exemple' }], more: false }),
      'POST /v1/offres/biens/b1/fichiers/signee': ok({ ref }),
      'POST /v1/offres/biens/b1': no(400, 'invalid', { field: 'validUntil' }),
    });
    await t.open();
    expect(t.body().textContent).toContain('Aucune offre reçue');
    await t.click(t.byText('Enregistrer une offre reçue'));
    expect(t.input('of-acquereur').attributes.type).toBeUndefined();
    await t.click(t.byText('Inscrire au registre'));
    expect(t.state()).toBe('Choisissez l’acquéreur.');
    t.input('of-acquereur').value = 'p1';
    t.input('of-montant').value = '205 000';
    t.input('of-apport').value = '70000';
    t.input('of-pret').value = '150000';
    t.input('of-recue').value = '2027-03-01T09:00';
    t.input('of-validite').value = '2027-03-10';
    (t.input('of-c-pret') as unknown as { checked: boolean }).checked = true;
    await t.click(t.byText('Inscrire au registre'));
    expect(t.state()).toBe('Vérifiez les conditions : le prêt demande son montant et sa durée.');
    t.input('of-c-montant').value = '150000';
    t.input('of-c-duree').value = '240';
    await t.click(t.byText('Inscrire au registre'));
    expect(t.state()).toBe('Joignez l’offre signée.');
    t.input('of-signee').files = [pdf()];
    await t.click(t.byText('Inscrire au registre'));
    expect(t.state()).toBe('Dernier jour de validité : à partir d’aujourd’hui et du jour de réception, deux ans au plus.');
    const sent = t.posts().filter((c) => c.url === '/v1/offres/biens/b1');
    expect(sent[0]!.body).toMatchObject({ buyerPersonId: 'p1', amountEur: 205000, downPaymentEur: 70000, loanEur: 150000, conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }], signedRef: ref });
    t.table['POST /v1/offres/biens/b1'] = ok({ offer: { id: 'o1' }, lines: [] });
    t.table[SUIVI] = ok(board([OFFER]));
    await t.click(t.byText('Inscrire au registre'));
    const both = t.posts().filter((c) => c.url === '/v1/offres/biens/b1');
    expect((both[1]!.body as { requestKey: string }).requestKey).toBe((both[0]!.body as { requestKey: string }).requestKey);
    expect(t.posts().filter((c) => c.url.endsWith('/fichiers/signee'))).toHaveLength(1);
    expect(t.state()).toContain('Offre inscrite au registre');
  });

  it('[R56] AU079 · le taux maximal hors assurance et le type du prêt partent avec la condition, et se relisent sur l’offre', async () => {
    const ref = 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000079.pdf';
    const t = await run({
      [SUIVI]: ok(board([])),
      'GET /v1/offres/biens/b1/contacts': ok({ contacts: [{ personId: 'p1', firstName: 'Acheteur', lastName: 'Exemple' }], more: false }),
      'POST /v1/offres/biens/b1/fichiers/signee': ok({ ref }),
      'POST /v1/offres/biens/b1': no(400, 'invalid', { field: 'validUntil' }),
    });
    await t.open();
    await t.click(t.byText('Enregistrer une offre reçue'));
    t.input('of-acquereur').value = 'p1';
    t.input('of-montant').value = '205000';
    t.input('of-apport').value = '70000';
    t.input('of-pret').value = '150000';
    t.input('of-recue').value = '2027-03-01T09:00';
    t.input('of-validite').value = '2027-03-10';
    (t.input('of-c-pret') as unknown as { checked: boolean }).checked = true;
    t.input('of-c-montant').value = '150000';
    t.input('of-c-duree').value = '240';
    expect(t.input('of-c-type').children.map((o) => o.value)).toEqual(['', 'amortissable', 'in_fine', 'relais', 'ptz']);
    for (const wrong of ['3,855', '25', 'trois', '0']) {
      t.input('of-c-taux').value = wrong;
      await t.click(t.byText('Inscrire au registre'));
      expect(t.state()).toBe('Taux maximal du prêt : en %, de 0,01 à 20, deux décimales au plus, ou laissé vide.');
    }
    t.input('of-c-taux').value = '3,85 %';
    t.input('of-c-type').value = 'amortissable';
    t.input('of-signee').files = [pdf()];
    await t.click(t.byText('Inscrire au registre'));
    const sent = t.posts().filter((c) => c.url === '/v1/offres/biens/b1');
    expect(sent[0]!.body).toMatchObject({ conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, maxRateBp: 385, loanType: 'amortissable' }] });
    // Laissés vides : la condition part comme avant, sans taux ni type.
    t.input('of-c-taux').value = '';
    t.input('of-c-type').value = '';
    await t.click(t.byText('Inscrire au registre'));
    const again = t.posts().filter((c) => c.url === '/v1/offres/biens/b1');
    expect(again[1]!.body).toMatchObject({ conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }] });
    expect(Object.keys((again[1]!.body as { conditions: Record<string, unknown>[] }).conditions[0]!)).toEqual(['kind', 'amountEur', 'durationMonths']);
    // L'offre relue : le prêt dit son type et son taux.
    const shown = await run({ [SUIVI]: ok(board([{ ...OFFER, conditionDetails: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, maxRateBp: 385, loanType: 'amortissable' }] }])) });
    await shown.open();
    expect(shown.body().textContent).toContain('prêt amortissable de 150 000 € sur 240 mois, taux hors assurance 3,85 % au plus');
  });

  it('[R56] AU080 · une offre à longue validité s’inscrit, et sa durée inhabituelle se dit aussitôt, en mots', async () => {
    const ref = 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000080.pdf';
    const long = { check: 'validite_longue', status: 'atypique', days: 121, usualDays: 60 };
    const t = await run({
      [SUIVI]: ok(board([])),
      'GET /v1/offres/biens/b1/contacts': ok({ contacts: [{ personId: 'p1', firstName: 'Acheteur', lastName: 'Exemple' }], more: false }),
      'POST /v1/offres/biens/b1/fichiers/signee': ok({ ref }),
      'POST /v1/offres/biens/b1': ok({ offer: { id: 'o1' }, lines: [{ check: 'validite', status: 'en_cours', lastDay: '2027-06-30' }, long] }),
      'POST /v1/offres/o1/controle': ok([long]),
    });
    await t.open();
    await t.click(t.byText('Enregistrer une offre reçue'));
    t.input('of-acquereur').value = 'p1';
    t.input('of-montant').value = '205000';
    t.input('of-apport').value = '205000';
    t.input('of-pret').value = '0';
    t.input('of-recue').value = '2027-03-01T09:00';
    t.input('of-validite').value = '2027-06-30';
    t.input('of-signee').files = [pdf()];
    t.table[SUIVI] = ok(board([{ ...OFFER, validUntil: '2027-06-30' }]));
    await t.click(t.byText('Inscrire au registre'));
    const sent = t.posts().filter((c) => c.url === '/v1/offres/biens/b1');
    expect(sent[0]!.body).toMatchObject({ validUntil: '2027-06-30' });
    expect(t.state()).toBe('Offre inscrite au registre, avec son contrôle. Durée de validité inhabituelle : 121 jours, pour 60 d’habitude. L’offre est gardée telle quelle : vérifiez la date sur l’offre signée.');
  });

  it('[R26] [R56] tant que rien ne part vraiment, l’écran ne propose pas de transmettre par message', async () => {
    const t = await run({ [SUIVI]: ok(board([OFFER])) });
    await t.open();
    expect(t.input('o1-via').children.map((o) => o.value)).toEqual(['', 'telephone', 'en_personne']);
  });

  it('[R16] sans le droit de voir l’acquéreur, ni financement ni montant de prêt ; le refus n’attribue la décision à personne', async () => {
    const t = await run({ [SUIVI]: ok(board([{ ...OFFER, state: 'refusee', next: 'aucun', buyer: null, downPaymentEur: null, loanEur: null, conditionDetails: [{ kind: 'pret' }], daysLeft: -3 }])) });
    await t.open();
    const text = t.body().textContent;
    expect(text).not.toContain('Financement déclaré');
    expect(text).toContain('Conditions : prêt.');
    expect(text).toContain('État : refusée');
    expect(text).not.toContain('par le vendeur');
    expect(text).not.toContain('reste');
  });

  it('[R505] une offre arrêtée par le bon de la visite à distance se dit en mots, sans identifiant, et se renvoie avec la même clé', async () => {
    const ref = 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000002.pdf';
    const t = await run({
      [SUIVI]: ok(board([])),
      'GET /v1/offres/biens/b1/contacts': ok({ contacts: [{ personId: 'p1', firstName: 'Acheteur', lastName: 'Exemple' }], more: false }),
      'POST /v1/offres/biens/b1/fichiers/signee': ok({ ref }),
      'POST /v1/offres/biens/b1': no(409, 'remote_slip_unsigned', { rule: 'R505', appointmentId: 'rdv-distance-42' }),
    });
    await t.open();
    await t.click(t.byText('Enregistrer une offre reçue'));
    t.input('of-acquereur').value = 'p1';
    t.input('of-montant').value = '205000';
    t.input('of-apport').value = '205000';
    t.input('of-pret').value = '0';
    t.input('of-recue').value = '2027-03-01T09:00';
    t.input('of-validite').value = '2027-03-10';
    t.input('of-signee').files = [pdf()];
    await t.click(t.byText('Inscrire au registre'));
    expect(t.state()).toBe('Le bon de la visite à distance n’est pas encore signé : l’offre attend sa signature.');
    expect(t.state()).not.toContain('rdv-distance-42');
    expect(t.body().textContent).not.toContain('rdv-distance-42');
    expect(t.body().textContent).not.toContain('remote_slip_unsigned');
    t.table['POST /v1/offres/biens/b1'] = ok({ offer: { id: 'o1' }, lines: [] });
    t.table[SUIVI] = ok(board([OFFER]));
    await t.click(t.byText('Inscrire au registre'));
    const both = t.posts().filter((c) => c.url === '/v1/offres/biens/b1');
    expect(both).toHaveLength(2);
    expect((both[1]!.body as { requestKey: string }).requestKey).toBe((both[0]!.body as { requestKey: string }).requestKey);
    expect(t.state()).toContain('Offre inscrite au registre');
  });

  it('[R59] une offre échue garde son geste, et dit ce qui se range encore', async () => {
    const t = await run({ [SUIVI]: ok(board([{ ...OFFER, state: 'echue', next: 'reponse_vendeur', daysLeft: null }])) });
    await t.open();
    expect(t.body().textContent).toContain('Échue : seul un refus, ou une acceptation donnée à temps, se range encore.');
    expect(t.byText('Ranger la réponse')).toBeDefined();
  });

  it('un autre bouton pendant un geste ne fait pas oublier le refus du serveur', async () => {
    let release: (r: Response) => void = () => {};
    const t = await run({ [SUIVI]: ok(board([OFFER])), 'POST /v1/offres/o1/transmission': () => new Promise<Response>((r) => { release = r; }), 'POST /v1/offres/o1/controle': ok([]) });
    await t.open();
    t.input('o1-via').value = 'telephone';
    t.input('o1-quand').value = '2027-03-01T10:00';
    await t.click(t.byText('Noter la transmission'));
    await t.click(t.byText('Voir le contrôle'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/offres/o1/transmission']);
    release(Response.json({ ok: false, code: 'already_transmitted' }, { status: 409 }));
    for (let i = 0; i < 16; i++) await new Promise((r) => setTimeout(r, 0));
    expect(t.state()).toBe('Cette offre a déjà été transmise.');
  });

  it('hors ligne, rien n’est dit rangé ; un bien hors droits le dit', async () => {
    const t = await run({ [SUIVI]: no(403, 'not_assigned', { rule: 'R16' }) });
    await t.open();
    expect(t.state()).toBe('Ce bien ou ce contact n’est pas dans vos droits.');
    const u = await run({ [SUIVI]: ok(board([OFFER])) });
    await u.open();
    u.input('o1-via').value = 'telephone';
    u.input('o1-quand').value = '2027-03-01T10:00';
    await u.click(u.byText('Noter la transmission'));
    expect(u.state()).toBe('Pas de réseau : rien n’est rangé.');
  });
});

describe('DS058 · DS059 · l’offre reçue : le refus sous le champ fautif, le bouton d’envoi à portée', () => {
  const ref = 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000002.pdf';
  const FORM: Record<string, Answer> = {
    [SUIVI]: ok(board([])),
    'GET /v1/offres/biens/b1/contacts': ok({ contacts: [{ personId: 'p1', firstName: 'Acheteur', lastName: 'Exemple' }], more: false }),
    'POST /v1/offres/biens/b1/fichiers/signee': ok({ ref }),
  };
  type T = Awaited<ReturnType<typeof run>>;
  const form = async (answers: Record<string, Answer> = {}) => {
    const t = await run({ ...FORM, ...answers });
    await t.open();
    await t.click(t.byText('Enregistrer une offre reçue'));
    return t;
  };
  const type = (t: T, id: string, value: string) => {
    const f = t.input(id);
    f.value = value;
    f.listeners.input!({});
  };
  const send = (t: T) => t.click(t.byText('Inscrire au registre'));
  /** Les champs marqués, et pour chacun ce qui est écrit juste après lui. */
  const flagged = (t: T) =>
    t
      .body()
      .all()
      .filter((e) => e.attributes['aria-invalid'] === 'true')
      .map((f) => {
        const box = t.body().all().find((d) => d.children.includes(f))!;
        const next = box.children[box.children.indexOf(f) + 1]!;
        return { id: f.attributes.id, describedBy: f.attributes['aria-describedby'], noteId: next.attributes.id, note: next.textContent, cls: next.className };
      });
  const bar = (t: T) => t.body().all().find((e) => e.children.includes(t.byText('Inscrire au registre')!))!;
  const NUMBERS = 'Montant, apport et prêt s’écrivent en euros, en chiffres seulement (0 s’il n’y en a pas).';

  it('[R10] chaque refus marque son champ, le dit juste dessous et y met le curseur ; la saisie dans ce champ l’efface ; un seul à la fois', async () => {
    const t = await form({ 'POST /v1/offres/biens/b1': no(400, 'invalid', { field: 'validUntil' }) });
    expect(flagged(t)).toEqual([]);
    await send(t);
    expect(flagged(t)).toEqual([{ id: 'of-acquereur', describedBy: 'of-acquereur-erreur', noteId: 'of-acquereur-erreur', note: 'Choisissez l’acquéreur.', cls: 'retard' }]);
    expect(FakeElement.active).toBe(t.input('of-acquereur'));
    expect(t.state()).toBe('Choisissez l’acquéreur.');
    // Choisir l'acquéreur lève sa marque ; taper ailleurs ne l'aurait pas levée.
    type(t, 'of-montant', 'deux cent mille');
    expect(flagged(t).map((x) => x.id)).toEqual(['of-acquereur']);
    const who = t.input('of-acquereur');
    who.value = 'p1';
    who.listeners.change!({});
    expect(flagged(t)).toEqual([]);
    expect(who.attributes['aria-describedby']).toBeUndefined();
    // Les trois montants : le premier mal écrit est marqué, avec la phrase qui vaut pour les trois.
    type(t, 'of-apport', '70000');
    type(t, 'of-pret', '150000');
    await send(t);
    expect(flagged(t)).toMatchObject([{ id: 'of-montant', note: NUMBERS }]);
    type(t, 'of-montant', '205 000');
    type(t, 'of-apport', 'soixante-dix');
    await send(t);
    expect(flagged(t)).toMatchObject([{ id: 'of-apport', note: NUMBERS }]);
    type(t, 'of-apport', '70000');
    await send(t);
    expect(flagged(t)).toMatchObject([{ id: 'of-recue', note: 'Vérifiez le moment où l’offre a été reçue.' }]);
    type(t, 'of-recue', '2027-03-01T09:00');
    type(t, 'of-validite', '2027-03-10');
    (t.input('of-c-pret') as unknown as { checked: boolean }).checked = true;
    type(t, 'of-c-taux', 'trois');
    await send(t);
    expect(flagged(t)).toMatchObject([{ id: 'of-c-taux', note: 'Taux maximal du prêt : en %, de 0,01 à 20, deux décimales au plus, ou laissé vide.' }]);
    type(t, 'of-c-taux', '3,85');
    await send(t);
    expect(flagged(t)).toMatchObject([{ id: 'of-c-montant', note: 'Vérifiez les conditions : le prêt demande son montant et sa durée.' }]);
    type(t, 'of-c-montant', '150000');
    await send(t);
    expect(flagged(t)).toMatchObject([{ id: 'of-c-duree', note: 'Vérifiez les conditions : le prêt demande son montant et sa durée.' }]);
    type(t, 'of-c-duree', '240');
    await send(t);
    expect(flagged(t)).toMatchObject([{ id: 'of-signee', note: 'Joignez l’offre signée.' }]);
    expect(t.posts().filter((c) => c.url === '/v1/offres/biens/b1')).toEqual([]);
    // Le refus du serveur va au champ qu'il nomme, avec ses mots ; un seul champ reste marqué.
    t.input('of-signee').files = [pdf()];
    t.input('of-signee').listeners.change!({});
    await send(t);
    expect(flagged(t)).toEqual([{ id: 'of-validite', describedBy: 'of-validite-erreur', noteId: 'of-validite-erreur', note: 'Dernier jour de validité : à partir d’aujourd’hui et du jour de réception, deux ans au plus.', cls: 'retard' }]);
    expect(FakeElement.active).toBe(t.input('of-validite'));
    expect(t.body().all().filter((e) => /-erreur$/.test(e.attributes.id ?? ''))).toHaveLength(1);
    // Ce qui est saisi reste.
    expect(t.input('of-montant').value).toBe('205 000');
  });

  it('un refus qui ne nomme aucun champ, ou une coupure, ne marque rien : il se dit, c’est tout', async () => {
    const same = await form({ 'POST /v1/offres/biens/b1': no(409, 'buyer_is_seller', { field: 'buyerPersonId' }) });
    const fill = (t: T) => {
      t.input('of-acquereur').value = 'p1';
      type(t, 'of-montant', '205000');
      type(t, 'of-apport', '0');
      type(t, 'of-pret', '0');
      type(t, 'of-recue', '2027-03-01T09:00');
      type(t, 'of-validite', '2027-03-10');
      t.input('of-signee').files = [pdf()];
    };
    fill(same);
    await send(same);
    expect(same.state()).not.toBe('');
    expect(same.state()).not.toBe('Choisissez l’acquéreur.');
    expect(flagged(same)).toEqual([]);
    const cut = await form();
    fill(cut);
    await send(cut);
    expect(cut.state()).toBe('Pas de réseau : rien n’est rangé.');
    expect(flagged(cut)).toEqual([]);
    // Sans champ à marquer, ce que l'écran répond se lit aussi près du bouton.
    expect(bar(cut).children[1]!.textContent).toBe('Pas de réseau : rien n’est rangé.');
    expect(bar(same).children[1]!.textContent).toBe(same.state());
  });

  it('DS059 · « Inscrire au registre » est dans la barre d’envoi, avec une copie de ce que l’écran répond ; l’annonce reste celle du titre', async () => {
    const t = await form();
    expect(bar(t).className).toBe('envoi');
    expect(bar(t).children.map((e) => [e.tagName, e.attributes['aria-hidden'] ?? '', e.attributes.role ?? ''])).toEqual([['button', '', ''], ['p', 'true', '']]);
    const copy = bar(t).children[1]!;
    // « Revenir aux offres » reste sous la barre, filaire : un seul geste est collé, un seul bouton est plein (DS022).
    const box = t.body().all().find((e) => e.children.includes(bar(t)))!;
    expect(box.children.at(-1)!.textContent).toBe('Revenir aux offres');
    expect(box.children.at(-1)!.className).toBe('secondaire');
    expect(t.byText('Inscrire au registre')!.className).toBe('');
    // Le chargement des contacts s'est dit près du bouton, puis s'est tu.
    expect(copy.textContent).toBe('');
    // Un refus qui a son champ se lit sous ce champ, et sous le titre : la copie près du bouton ne le répète pas.
    await send(t);
    expect(t.state()).toBe('Choisissez l’acquéreur.');
    expect(copy.textContent).toBe('');
    expect(flagged(t).map((x) => x.id)).toEqual(['of-acquereur']);
    // Quitter le formulaire : tant qu'il est à l'écran, la copie suit (« Chargement… ») ; une fois l'écran redessiné, elle
    // n'est plus tenue, et l'écran continue de répondre sous son titre.
    await t.click(t.byText('Revenir aux offres'));
    expect(t.body().textContent).toContain('Aucune offre reçue');
    expect(copy.textContent).toBe('Chargement…');
    expect(t.state()).toBe('');
  });
});
