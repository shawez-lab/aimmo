import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { COPROPRIETE_SCRIPT } from '../app/copropriete.ts';
import { AVANT_CONTRAT_SCRIPT } from '../app/avant-contrat.ts';
import { DOSSIER_SCRIPT } from '../app/dossier.ts';
import { OFFRES_SCRIPT } from '../app/offres.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
type Call = { method: string; url: string; body: unknown };
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, code: string): Answer => async () => Response.json({ ok: false, code }, { status });
const PATH = {
  fileId: 'f1', today: '2027-03-11', earliestActDay: '2027-04-20', conditional: true, plannedActDay: '2027-04-01', late: true,
  holder: { reason: 'piece_manquante', item: 'titre_propriete', who: 'vendeur', notBefore: null },
  lines: [{ reason: 'piece_manquante', item: 'titre_propriete', who: 'vendeur', notBefore: null }, { reason: 'reponse_commune', item: 'reponse_preemption', who: 'commune', notBefore: '2027-04-20' }],
};
const PIECES = {
  fileId: 'f1', missing: ['titre_propriete'], unknown: [], identity: 'non_verifiee', complete: false,
  lines: [
    { piece: 'titre_propriete', side: 'vendeur', reason: 'toujours', received: null },
    { piece: 'dpe', side: 'vendeur', reason: 'bien_bati', received: { piece: 'dpe', version: 2, ref: 'dossiers/f1/x.pdf', issuedOn: '2027-03-10', receivedAt: '2027-03-11T08:00:00.000Z' } },
  ],
};
const SCHEDULE = { fileId: 'f1', dates: {}, lines: [{ deadline: 'fin_retractation', source: 'calcul', day: '2027-03-22', status: 'datee', from: 'notification_acquereur' }, { deadline: 'acte', source: 'saisie', day: null, status: 'a_saisir', from: 'acte_prevu' }] };
const READS: Record<string, Answer> = {
  'GET /v1/dossiers/f1/chemin': ok({ path: PATH, seller: {}, buyer: {} }),
  'GET /v1/dossiers/f1/pieces': ok(PIECES),
  'GET /v1/dossiers/f1/echeancier': ok(SCHEDULE),
  'GET /v1/dossiers/f1/acte': ok(null),
  'GET /v1/dossiers/f1/arret': ok(null),
  'GET /v1/dossiers/f1/financement': ok({ fileId: 'f1', hasLoanCondition: true, steps: [] }),
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/annonces': ok([{ id: 'b1', reference: 'AV-1', city: 'Dijon', state: 'sous_offre' }]),
  'GET /v1/offres/biens/b1/suivi': ok({ count: 1, registerIntact: true, offers: [{ seq: 1, id: 'o1', amountEur: 200000, offeredEur: 200000, netSellerEur: null, conditionDetails: [], daysLeft: null, state: 'acceptee', buyer: null, downPaymentEur: null, loanEur: null, next: 'aucun', proposalId: null, file: { id: 'f1', compromisStarted: true }, history: [] }] }),
  ...READS,
};
const pdf = (type = 'application/pdf', size = 8) => ({ type, size, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7').buffer });

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
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const find = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const body = () => els['dossier-corps']!;
  const state = () => els['dossier-etat']!.textContent;
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)! as FakeElement & { value: string; files?: unknown[] };
  // Depuis « Mes biens » : l'écran Offres, puis le dossier de l'offre.
  const open = async () => {
    await click(find(els.biens!, 'Offres'));
    runInNewContext(OFFRES_SCRIPT, context);
    els.offres!.children.filter((e) => e.tagName === 'script')[0]!.listeners.load!({});
    await settle();
    await click(find(els['offres-corps']!, 'Voir le dossier de vente'));
    const s = els.dossier!.children.filter((e) => e.tagName === 'script');
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/dossier.js']);
    runInNewContext(DOSSIER_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  return { els, calls, table, body, state, click, find, input, open, context, settle, posts: () => calls.filter((c) => c.method === 'POST') };
}

describe('N12 · écran du dossier de vente', () => {
  it('[R201] le script est à part, et l’application reste dans son budget', () => {
    expect(AGENT_APP_FILES['/app/dossier.js']).toBe(DOSSIER_SCRIPT);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(budgetProblems({ html: '', js: DOSSIER_SCRIPT }, BUDGETS.page)).toEqual([]);
  });

  it('[R61] [R10] depuis l’offre : ce qui tient le dossier, l’acte au plus tôt, les pièces et les échéances, sans date inventée', async () => {
    const t = await run();
    await t.open();
    expect(t.els.dossier!.hidden).toBe(false);
    const text = t.body().textContent;
    expect(text).toContain('Pièce manquante : Titre de propriété · au vendeur');
    expect(text).toContain('Acte au plus tôt : 20 avril 2027, si les points sans date sont levés.');
    expect(text).toContain('L’acte prévu tombe avant le jour au plus tôt.');
    expect(text).toContain('Pièces reçues : 1 sur 2');
    expect(text).toContain('Diagnostic énergétique (vendeur) : reçue, datée du 10 mars 2027, version 2');
    expect(text).toContain('Titre de propriété (vendeur) : à recevoir');
    expect(text).toContain('Identité de l’acquéreur à vérifier.');
    expect(text).toContain('Fin du délai de rétractation : 22 mars 2027');
    expect(text).toContain('Acte : date à saisir');
  });

  it('[R10] un délai passé ne tient plus le dossier ; sans droit sur l’acquéreur, son identité n’est pas affirmée', async () => {
    const lapsed = { reason: 'fin_retractation', item: 'fin_retractation', who: 'acquereur', notBefore: '2027-03-11' };
    const identity = { reason: 'identite_a_verifier', item: null, who: 'acquereur', notBefore: null };
    const t = await run({
      'GET /v1/dossiers/f1/chemin': ok({ path: { ...PATH, holder: lapsed, lines: [lapsed, identity] }, seller: {}, buyer: {} }),
      'GET /v1/dossiers/f1/pieces': ok({ ...PIECES, identity: 'non_visible' }),
    });
    await t.open();
    const text = t.body().textContent;
    expect(text).not.toContain('Délai de rétractation en cours');
    expect(text).toContain('Identité de l’acquéreur : hors de vos droits, voyez avec la direction.');
    expect(text).not.toContain('Identité de l’acquéreur à vérifier');
    const u = await run({ 'GET /v1/dossiers/f1/chemin': ok({ path: { ...PATH, holder: lapsed, lines: [lapsed] }, seller: {}, buyer: {} }) });
    await u.open();
    expect(u.body().textContent).toContain('Rien ne tient ce dossier.');
    expect(u.body().textContent).not.toContain('Le reste à lever');
  });

  it('un dossier clos par l’acte le dit, sans chemin ni dépôt', async () => {
    const t = await run({ 'GET /v1/dossiers/f1/acte': ok({ signedOn: '2027-06-01' }) });
    await t.open();
    const text = t.body().textContent;
    expect(text).toContain('Acte signé le 1 juin 2027.');
    expect(text).not.toContain('Ce qui tient le dossier');
    expect(t.find(t.body(), 'Ranger la pièce')).toBeUndefined();
    expect(text).toContain('Pièces reçues : 1 sur 2');
  });

  it('[R233] un dossier arrêté le dit, sans chemin ni geste ; l’arrêt demande raison, preuve et confirmation', async () => {
    const off = await run({ 'GET /v1/dossiers/f1/arret': ok({ reason: 'pret_refuse', on: '2027-03-20' }) });
    await off.open();
    expect(off.body().textContent).toContain('Prêt refusé, le 20 mars 2027.');
    expect(off.body().textContent).not.toContain('Ce qui tient le dossier');
    for (const b of ['Ranger la pièce', 'Ranger la date', 'Arrêter ce dossier']) expect(off.find(off.body(), b)).toBeUndefined();
    const ref = 'preuves/0b6f1d2e-4444-4a2b-8c3d-000000000001.pdf';
    const t = await run({ 'POST /v1/dossiers/f1/preuves': ok({ ref }), 'POST /v1/dossiers/f1/arret': ok({ reason: 'autre', on: '2027-03-20' }) });
    await t.open();
    const stop = () => t.find(t.body(), 'Arrêter ce dossier');
    await t.click(stop());
    expect(t.state()).toBe('Choisissez la raison.');
    t.input('dossier-arret-raison').value = 'pret_refuse';
    await t.click(stop());
    expect(t.state()).toBe('Joignez la preuve de l’arrêt.');
    t.input('dossier-arret-preuve').files = [pdf()];
    await t.click(stop());
    expect(t.state()).toContain('cela ne se défait pas');
    expect(t.posts().filter((c) => c.url.endsWith('/arret'))).toEqual([]);
    await t.click(t.find(t.body(), 'Confirmer l’arrêt : Prêt refusé'));
    expect(t.posts().filter((c) => c.url.endsWith('/arret')).map((c) => c.body)).toEqual([{ reason: 'pret_refuse', proofRef: ref }]);
  });

  it('[R15] la pièce se choisit dans la liste attendue : aucune pièce d’identité, aucune référence à saisir', async () => {
    const t = await run();
    await t.open();
    expect(t.input('dossier-piece').children.map((o) => o.value)).toEqual(['', 'titre_propriete', 'dpe']);
    expect(t.body().textContent).toContain('Une pièce d’identité ne se range jamais ici');
    expect(t.input('dossier-fichier').attributes.accept).toBe('application/pdf,image/jpeg,image/png');
  });

  it('[R60] déposer puis ranger : pièce, date et fichier sont demandés ; un refus garde le dépôt, sans le renvoyer', async () => {
    const ref = 'dossiers/f1/0b6f1d2e-4444-4a2b-8c3d-000000000001.pdf';
    const t = await run({ 'POST /v1/dossiers/f1/fichiers': ok({ ref }), 'POST /v1/dossiers/f1/pieces': no(400, 'bad_date') });
    await t.open();
    const save = () => t.find(t.body(), 'Ranger la pièce');
    await t.click(save());
    expect(t.state()).toBe('Choisissez la pièce.');
    t.input('dossier-piece').value = 'titre_propriete';
    await t.click(save());
    expect(t.state()).toBe('Dites la date du document.');
    t.input('dossier-date').value = '2027-03-10';
    await t.click(save());
    expect(t.state()).toBe('Joignez le document.');
    t.input('dossier-fichier').files = [pdf('text/html')];
    await t.click(save());
    expect(t.state()).toBe('Ce fichier n’est pas admis : PDF, JPEG ou PNG.');
    expect(t.posts()).toEqual([]);
    const file = pdf();
    t.input('dossier-fichier').files = [file];
    await t.click(save());
    expect(t.state()).toBe('La date du document : un vrai jour, jamais à venir.');
    t.table['POST /v1/dossiers/f1/pieces'] = ok(PIECES);
    await t.click(save());
    expect(t.posts().filter((c) => c.url.endsWith('/fichiers'))).toHaveLength(1);
    expect(t.posts().at(-1)).toMatchObject({ url: '/v1/dossiers/f1/pieces', body: { piece: 'titre_propriete', ref, issuedOn: '2027-03-10' } });
    expect(t.state()).toBe('Pièce rangée.');
  });

  it('une lecture en échec n’est jamais montrée comme un dossier vide ; un fonds de commerce renvoie à son écran', async () => {
    const t = await run({ 'GET /v1/dossiers/f1/pieces': no(400, 'business') });
    await t.open();
    expect(t.state()).toBe('Un fonds de commerce se suit dans « Commerces ».');
    expect(t.body().children).toEqual([]);
    const u = await run({ 'GET /v1/dossiers/f1/chemin': no(403, 'not_assigned') });
    await u.open();
    expect(u.state()).toBe('Ce dossier n’est pas dans vos droits.');
  });
});

describe('N13 · faire avancer le dossier depuis l’écran', () => {
  const PROOF_REF = 'preuves/0b6f1d2e-4444-4a2b-8c3d-000000000002.pdf';
  const SIGNED = { ...SCHEDULE, dates: { compromis_signe: { day: '2027-03-10', version: 1 } } };
  const signed = (extra: Record<string, Answer> = {}) => run({ 'GET /v1/dossiers/f1/echeancier': ok(SIGNED), 'POST /v1/dossiers/f1/preuves': ok({ ref: PROOF_REF }), ...extra });
  const options = (f: FakeElement) => f.children.map((o) => o.value);

  it('[R201] l’écran, avec ses saisies, reste dans son budget', () => {
    expect(budgetProblems({ html: '', js: DOSSIER_SCRIPT }, BUDGETS.page)).toEqual([]);
  });

  it('[R61] tant que le compromis n’est pas saisi, seule sa signature se saisit ; l’acte attend', async () => {
    const t = await run();
    await t.open();
    expect(options(t.input('dossier-saisie-genre'))).toEqual(['', 'compromis_signe']);
    expect(t.find(t.body(), 'Ranger l’acte signé')).toBeUndefined();
    expect(t.body().textContent).toContain('L’acte se range une fois la signature du compromis saisie.');
  });

  it('[R61] ce qui n’a pas d’objet n’est pas proposé ; la suspension suit la réception, la reprise suit la suspension', async () => {
    const lines = [{ deadline: 'date_limite_pret', source: 'saisie', day: null, status: 'sans_objet', from: 'date_limite_pret' }, { deadline: 'etat_date', source: 'saisie', day: null, status: 'sans_objet', from: 'etat_date_attendu' }];
    const t = await run({ 'GET /v1/dossiers/f1/echeancier': ok({ fileId: 'f1', lines, dates: { compromis_signe: { day: '2027-03-10', version: 1 } } }) });
    await t.open();
    expect(options(t.input('dossier-saisie-genre'))).toEqual(['', 'compromis_signe', 'notification_acquereur', 'dia_recue', 'acte_prevu']);
    expect(t.input('dossier-saisie-genre').children[1]!.textContent).toBe('Compromis signé (corriger le 10 mars 2027)');
    const u = await run({ 'GET /v1/dossiers/f1/echeancier': ok({ fileId: 'f1', lines, dates: { compromis_signe: { day: '2027-03-10', version: 2 }, dia_recue: { day: '2027-03-11', version: 1 }, dia_suspension: { day: '2027-03-12', version: 1 } } }) });
    await u.open();
    expect(options(u.input('dossier-saisie-genre'))).toContain('dia_reprise');
    expect(u.body().textContent).toContain('Compromis signé : 10 mars 2027, version 2');
  });

  it('[R10] une date part avec sa preuve déposée, sans référence à saisir ; un refus se dit en français, sans renvoyer le fichier', async () => {
    const t = await signed({ 'POST /v1/dossiers/f1/dates': no(400, 'future_day') });
    await t.open();
    const save = () => t.find(t.body(), 'Ranger la date');
    await t.click(save());
    expect(t.state()).toBe('Choisissez la date à saisir.');
    t.input('dossier-saisie-genre').value = 'notification_acquereur';
    await t.click(save());
    expect(t.state()).toBe('Dites le jour.');
    t.input('dossier-saisie-jour').value = '2099-01-01';
    await t.click(save());
    expect(t.state()).toBe('Joignez la preuve de cette date.');
    expect(t.posts()).toEqual([]);
    t.input('dossier-saisie-preuve').files = [pdf()];
    await t.click(save());
    expect(t.state()).toBe('Ce jour est à venir : seul ce qui a déjà eu lieu se saisit ici.');
    t.table['POST /v1/dossiers/f1/dates'] = ok(SIGNED);
    t.input('dossier-saisie-jour').value = '2027-03-11';
    await t.click(save());
    expect(t.posts().filter((c) => c.url.endsWith('/preuves'))).toHaveLength(1);
    expect(t.posts().at(-1)).toMatchObject({ url: '/v1/dossiers/f1/dates', body: { kind: 'notification_acquereur', day: '2027-03-11', proofRef: PROOF_REF } });
    expect(t.state()).toBe('Date rangée.');
  });

  it('[R10] une preuve qui n’est plus rangée est redéposée au prochain essai', async () => {
    const t = await signed({ 'POST /v1/dossiers/f1/dates': no(400, 'not_stored') });
    await t.open();
    t.input('dossier-saisie-genre').value = 'acte_prevu';
    t.input('dossier-saisie-jour').value = '2027-06-01';
    t.input('dossier-saisie-preuve').files = [pdf()];
    const save = () => t.find(t.body(), 'Ranger la date');
    await t.click(save());
    expect(t.state()).toBe('Le fichier n’est pas rangé : choisissez-le de nouveau.');
    await t.click(save());
    expect(t.posts().filter((c) => c.url.endsWith('/preuves'))).toHaveLength(2);
  });

  it('[R14] le financement : une liste fermée, sans montant ni taux ; aucune réponse par défaut', async () => {
    const steps = [{ step: 'offre_pret_emise', day: '2027-04-02', declaredBy: 'courtier', recordedAt: '2027-04-03T08:00:00.000Z' }];
    const t = await signed({ 'POST /v1/dossiers/f1/financement': no(400, 'no_loan_condition'), 'GET /v1/dossiers/f1/financement': ok({ fileId: 'f1', hasLoanCondition: true, steps }) });
    await t.open();
    expect(t.body().textContent).toContain('Offre de prêt reçue par l’acquéreur : 2 avril 2027, dit par le courtier');
    const save = () => t.find(t.body(), 'Ranger l’étape');
    await t.click(save());
    expect(t.state()).toBe('Choisissez l’étape.');
    t.input('dossier-pret-etape').value = 'refus';
    t.input('dossier-pret-jour').value = '2027-04-05';
    await t.click(save());
    expect(t.state()).toBe('Dites qui la déclare.');
    t.input('dossier-pret-qui').value = 'acquereur';
    await t.click(save());
    expect(t.state()).toBe('L’offre n’a pas de condition de prêt : rien à suivre.');
    t.table['POST /v1/dossiers/f1/financement'] = ok({ fileId: 'f1', hasLoanCondition: true, steps });
    await t.click(save());
    expect(t.posts().at(-1)).toMatchObject({ url: '/v1/dossiers/f1/financement', body: { step: 'refus', day: '2027-04-05', declaredBy: 'acquereur' } });
    expect(Object.keys(t.posts().at(-1)!.body as object).sort()).toEqual(['day', 'declaredBy', 'step']);
    expect(t.state()).toBe('Étape rangée.');
    for (const id of ['dossier-pret-montant', 'dossier-pret-taux']) expect(t.body().all().some((e) => e.attributes.id === id)).toBe(false);
  });

  it('AU083 · deux banques : les étapes se lisent par demande, et la banque dite part avec l’étape', async () => {
    const steps = [
      { step: 'offre_pret_emise', day: '2027-04-02', declaredBy: 'courtier', recordedAt: 'x', demande: 'Banque A' },
      { step: 'refus', day: '2027-04-03', declaredBy: 'acquereur', recordedAt: 'x', demande: 'Banque B' },
    ];
    const t = await signed({ 'GET /v1/dossiers/f1/financement': ok({ fileId: 'f1', hasLoanCondition: true, steps }), 'POST /v1/dossiers/f1/financement': no(400, 'bad_request') });
    await t.open();
    const text = t.body().textContent;
    expect(text).toContain('Demande : Banque A');
    expect(text).toContain('Demande : Banque B');
    t.input('dossier-pret-etape').value = 'accord_principe';
    t.input('dossier-pret-jour').value = '2027-04-05';
    t.input('dossier-pret-qui').value = 'courtier';
    t.input('dossier-pret-demande').value = '  Banque B ';
    await t.click(t.find(t.body(), 'Ranger l’étape'));
    expect(t.posts().at(-1)).toMatchObject({ url: '/v1/dossiers/f1/financement', body: { step: 'accord_principe', day: '2027-04-05', declaredBy: 'courtier', demande: 'Banque B' } });
    expect(t.state()).toBe('Dites le nom de la banque ou du courtier, sans numéro de compte ni de dossier.');
  });

  it('[R14] sans condition de prêt, aucun suivi à remplir', async () => {
    const t = await signed({ 'GET /v1/dossiers/f1/financement': ok({ fileId: 'f1', hasLoanCondition: false, steps: [] }) });
    await t.open();
    expect(t.body().textContent).toContain('L’offre n’a pas de condition de prêt : rien à suivre.');
    expect(t.find(t.body(), 'Ranger l’étape')).toBeUndefined();
  });

  it('[R60] l’acte se confirme sur le jour montré ; un refus dit ce qui manque, avec des noms lisibles', async () => {
    const t = await signed({ 'POST /v1/dossiers/f1/acte': async () => Response.json({ ok: false, rule: 'R60', code: 'incomplete', missing: ['titre_propriete'], expired: ['etat_risques'], unknown: ['copropriete'], identity: 'non_verifiee' }, { status: 409 }) });
    await t.open();
    const ask = () => t.find(t.body(), 'Ranger l’acte signé');
    await t.click(ask());
    expect(t.state()).toBe('Dites le jour de la signature.');
    t.input('dossier-acte-jour').value = '2027-06-01';
    await t.click(ask());
    expect(t.state()).toBe('Joignez l’attestation du notaire.');
    t.input('dossier-acte-preuve').files = [pdf()];
    await t.click(ask());
    expect(t.state()).toBe('Le dossier sera clos et le bien passera vendu : cela ne se défait pas.');
    expect(t.posts()).toEqual([]);
    const confirm = () => t.find(t.body(), 'Confirmer : acte signé le 1 juin 2027');
    t.input('dossier-acte-jour').value = '2027-06-02';
    await t.click(confirm());
    expect(t.state()).toBe('Le jour a changé : rangez de nouveau.');
    expect(confirm()).toBeUndefined();
    expect(t.posts()).toEqual([]);
    t.input('dossier-acte-jour').value = '2027-06-01';
    await t.click(ask());
    await t.click(confirm());
    expect(t.state()).toBe('L’acte n’est pas rangé : il manque : Titre de propriété ; périmée au jour de l’acte : État des risques ; à compléter : la copropriété ; identité de l’acquéreur non vérifiée ce jour-là.');
    t.table['POST /v1/dossiers/f1/acte'] = ok({ signedOn: '2027-06-01' });
    t.table['GET /v1/dossiers/f1/acte'] = ok({ signedOn: '2027-06-01' });
    await t.click(confirm());
    expect(t.posts().filter((c) => c.url.endsWith('/preuves'))).toHaveLength(1);
    expect(t.posts().at(-1)).toMatchObject({ url: '/v1/dossiers/f1/acte', body: { signedOn: '2027-06-01', proofRef: PROOF_REF } });
    expect(t.state()).toBe('Acte rangé : le dossier est clos.');
    expect(t.body().textContent).toContain('Acte signé le 1 juin 2027.');
    for (const label of ['Ranger la date', 'Ranger l’étape', 'Ranger l’acte signé', 'Ranger la pièce']) expect(t.find(t.body(), label)).toBeUndefined();
  });

  it('[R60] « Dossier complet » ne coexiste plus avec une pièce périmée en tête', async () => {
    const stale = { reason: 'piece_perimee', item: 'dpe', who: 'vendeur', notBefore: null };
    const t = await run({
      'GET /v1/dossiers/f1/chemin': ok({ path: { ...PATH, holder: stale, lines: [stale] }, seller: {}, buyer: {} }),
      'GET /v1/dossiers/f1/pieces': ok({ ...PIECES, missing: [], identity: 'verifiee', complete: true }),
    });
    await t.open();
    const text = t.body().textContent;
    expect(text).toContain('Pièce périmée : Diagnostic énergétique · au vendeur');
    expect(text).toContain('À renouveler avant l’acte : Diagnostic énergétique.');
    expect(text).toContain('Diagnostic énergétique (vendeur) : reçue, datée du 10 mars 2027, version 2, à renouveler');
    expect(text).not.toContain('Dossier complet');
    const u = await run({ 'GET /v1/dossiers/f1/chemin': ok({ path: { ...PATH, holder: null, lines: [] }, seller: {}, buyer: {} }), 'GET /v1/dossiers/f1/pieces': ok({ ...PIECES, missing: [], identity: 'verifiee', complete: true }) });
    await u.open();
    expect(u.body().textContent).toContain('Dossier complet.');
  });
});

describe('BR88 · la copropriété et l’urbanisme, depuis le dossier', () => {
  it('[R201] le bloc se charge au premier geste, une seule fois, et ne fait que lire', async () => {
    const t = await run({
      'GET /v1/dossiers/f1/copropriete/resume': no(404, 'no_summary'),
      'GET /v1/dossiers/f1/copropriete/acquereur': no(404, 'no_summary'),
    });
    await t.open();
    const part = t.body().children.find((e) => e.tagName === 'section' && e.textContent.startsWith('Copropriété et urbanisme'))!;
    expect(part).toBeDefined();
    const before = t.calls.length;
    expect(part.all().some((e) => e.tagName === 'script')).toBe(false);
    await t.click(t.find(part, 'Lire le résumé de copropriété et d’urbanisme'));
    const scripts = part.all().filter((e) => e.tagName === 'script');
    expect(scripts.map((e) => e.attributes.src)).toEqual(['/app/copropriete.js']);
    expect(t.calls.length).toBe(before);
    runInNewContext(COPROPRIETE_SCRIPT, t.context);
    scripts[0]!.listeners.load!({});
    await t.settle();
    expect(t.calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/dossiers/f1/copropriete/resume', 'GET /v1/dossiers/f1/copropriete/acquereur']);
    expect(part.textContent).toContain('Aucun résumé de copropriété et d’urbanisme n’est encore préparé pour ce dossier.');
    // Relire ne recharge pas le script ; rien n'est jamais envoyé.
    await t.click(t.find(part, 'Lire le résumé de copropriété et d’urbanisme'));
    expect(part.all().filter((e) => e.tagName === 'script')).toHaveLength(1);
    expect(t.calls.slice(before)).toHaveLength(4);
    expect(t.posts()).toEqual([]);
  });
});


describe('BR90 · le résumé de copropriété préparé depuis le dossier', () => {
  it('[R201] [R12] le second geste charge le même script, et le PDF part tel quel, en application/pdf, avec la clé', async () => {
    const REF = `sha256:${'c'.repeat(64)}`;
    const URL_PDF = '/v1/dossiers/f1/copropriete/pdf?kind=fiche_synthetique';
    const t = await run({ [`POST ${URL_PDF}`]: ok({ document: { kind: 'fiche_synthetique', ref: REF, pages: ['Charges : budget voté.'] }, pagesToRead: [], pagesToReadText: null, reading: { source: 'manuel', sentences: [], toRead: [], dropped: 0 } }) });
    const seen: { headers: Record<string, string>; body: unknown }[] = [];
    const fetch0 = t.context.fetch as (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>;
    t.context.fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
      if (url === URL_PDF) seen.push({ headers: init.headers ?? {}, body: init.body });
      return fetch0(url, init);
    };
    await t.open();
    const part = t.body().children.find((e) => e.tagName === 'section' && e.textContent.startsWith('Copropriété et urbanisme'))!;
    const before = t.calls.length;
    await t.click(t.find(part, 'Préparer un nouveau résumé depuis les PDF'));
    const scripts = part.all().filter((e) => e.tagName === 'script');
    expect(scripts.map((e) => e.attributes.src)).toEqual(['/app/copropriete.js']);
    runInNewContext(COPROPRIETE_SCRIPT, t.context);
    scripts[0]!.listeners.load!({});
    await t.settle();
    expect(t.calls.length).toBe(before);
    const label = (text: string) => part.all().find((e) => e.attributes.id === part.all().find((l) => l.tagName === 'label' && l.textContent === text)!.attributes.for)! as FakeElement & { files?: unknown[] };
    label('Sorte du document').value = 'fiche_synthetique';
    const file = pdf();
    label('Fichier PDF').files = [file];
    await t.click(t.find(part, 'Déposer et prélire'));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe(file);
    expect(seen[0]!.headers['content-type']).toBe('application/pdf');
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(part.textContent).toContain('fiche synthétique, 1 page');
  });
});

describe('BR91 · l’avant-contrat, depuis le dossier', () => {
  it('[R201] [R511] le bloc se charge au premier geste ; le projet part tel quel à …/preuves avec son empreinte, puis le même fichier à …/pdf', async () => {
    const REF = 'preuves/0b6f1d2e-4444-4a2b-8c3d-000000000009.pdf';
    const PDF_URL = `/v1/dossiers/f1/avant-contrat/pdf?documentRef=${encodeURIComponent(REF)}`;
    const EMPTY = { brief: null, draft: null, differences: [], texts: [], comparedToEarlierBrief: false, blocked: false, deposit: { expectedEur: null, receivedEur: null, receivedBy: 'notaire', receivedOn: null, status: 'sans_objet' } };
    const t = await run({
      'GET /v1/dossiers/f1/avant-contrat': ok(EMPTY),
      'POST /v1/dossiers/f1/preuves': ok({ ref: REF }),
      [`POST ${PDF_URL}`]: ok({ documentRef: REF, pageCount: 1, pagesToRead: [], pagesToReadText: null, reading: { source: 'manuel', proposal: { priceEur: null, conditions: [], loanDeadline: null, deedBy: null, deposit: null }, toRead: ['prix'] } }),
    });
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetch0 = t.context.fetch as (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>;
    t.context.fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
      if (init.body && typeof init.body === 'object') seen.push({ url, headers: init.headers ?? {}, body: init.body });
      return fetch0(url, init);
    };
    await t.open();
    const part = t.body().children.find((e) => e.tagName === 'section' && e.textContent.startsWith('Avant-contrat'))!;
    expect(part).toBeDefined();
    const before = t.calls.length;
    expect(part.all().some((e) => e.tagName === 'script')).toBe(false);
    await t.click(t.find(part, 'Ouvrir l’avant-contrat : note, projet du notaire, dépôt'));
    const scripts = part.all().filter((e) => e.tagName === 'script');
    expect(scripts.map((e) => e.attributes.src)).toEqual(['/app/avant-contrat.js']);
    expect(t.calls.length).toBe(before);
    runInNewContext(AVANT_CONTRAT_SCRIPT, t.context);
    scripts[0]!.listeners.load!({});
    await t.settle();
    expect(t.calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/dossiers/f1/avant-contrat']);
    expect(part.textContent).toContain('Aucune note au notaire n’est encore rangée.');
    const label = (text: string) => part.all().find((e) => e.attributes.id === part.all().find((l) => l.tagName === 'label' && l.textContent === text)!.attributes.for)! as FakeElement & { files?: unknown[] };
    const file = pdf();
    label('Le projet reçu du notaire, en PDF').files = [file];
    await t.click(t.find(part, 'Déposer et prélire'));
    expect(seen.map((s) => s.url)).toEqual(['/v1/dossiers/f1/preuves', PDF_URL]);
    expect(seen.every((s) => s.body === file && s.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(seen[0]!.headers['x-aimmo-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[1]!.headers['content-type']).toBe('application/pdf');
    expect(part.textContent).toContain('À lire vous-même : le prix.');
    // Rouvrir ne recharge pas le script.
    await t.click(t.find(part, 'Ouvrir l’avant-contrat : note, projet du notaire, dépôt'));
    expect(part.all().filter((e) => e.tagName === 'script')).toHaveLength(1);
  });
});

describe('BR91 · une date de l’avant-contrat écrite relit tout le dossier', () => {
  it('[R513] après le report des dates, l’échéancier du dossier est relu (remarque de Codex)', async () => {
    const FULL = { brief: null, draft: { id: 'd1', fileId: 'f1', version: 1 }, differences: [], texts: [], comparedToEarlierBrief: false, blocked: false, deposit: { expectedEur: null, receivedEur: null, receivedBy: 'notaire', receivedOn: null, status: 'sans_objet' } };
    const t = await run({ 'GET /v1/dossiers/f1/avant-contrat': ok(FULL), 'POST /v1/dossiers/f1/avant-contrat/dates': ok({ acte_prevu: 'ecrite' }) });
    await t.open();
    const part = () => t.body().children.find((e) => e.tagName === 'section' && e.textContent.startsWith('Avant-contrat'))!;
    await t.click(t.find(part(), 'Ouvrir l’avant-contrat : note, projet du notaire, dépôt'));
    runInNewContext(AVANT_CONTRAT_SCRIPT, t.context);
    part().all().find((e) => e.tagName === 'script')!.listeners.load!({});
    await t.settle();
    const before = t.calls.length;
    await t.click(t.find(part(), 'Reporter les dates du projet à l’échéancier'));
    expect(t.calls.slice(before).map((c) => `${c.method} ${c.url}`)).toContain('GET /v1/dossiers/f1/echeancier');
    expect(t.state()).toBe('Date de l’acte : écrite à l’échéancier.');
  });
});
