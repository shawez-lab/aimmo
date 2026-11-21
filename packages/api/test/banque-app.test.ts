import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import {
  BANQUE_FAILED,
  BANQUE_FRESH,
  BANQUE_LOST,
  BANQUE_NO_STATEMENT,
  BANQUE_REFUSALS,
  BANQUE_REMINDER_STATES,
  BANQUE_ROLE,
  BANQUE_SCRIPT,
  BANQUE_STALE,
  BANQUE_WHY_CITED,
  BANQUE_WHY_ELSEWHERE,
  BANQUE_WHY_NONE,
  BANQUE_WHY_UNCITED,
} from '../app/banque.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, relevés, factures, montants, relances.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown, rest: Record<string, unknown> = {}): Answer => async () => Response.json({ ok: true, mode: 'essai', data, ...rest });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const FRESH = { lastImportDay: '2027-07-14', ageDays: 1, fresh: true, reason: 'frais', maxAgeDays: 7 };
const PROPOSALS = [
  // Le libellé cite la seconde facture : elle passe en tête.
  { lineId: 'l1', day: '2027-07-14', amountCents: 1_000_000, cited: ['F-2027-00002'], candidates: [{ invoiceId: 'f1', label: 'F-2027-00001' }, { invoiceId: 'f2', label: 'F-2027-00002' }] },
  { lineId: 'l2', day: '2027-07-15', amountCents: 450_000, cited: [], candidates: [{ invoiceId: 'f3', label: 'F-2027-00003' }] },
  { lineId: 'l3', day: '2027-07-15', amountCents: 120_050, cited: ['F-2027-00009'], candidates: [{ invoiceId: 'f4', label: 'F-2027-00004' }] },
  { lineId: 'l4', day: '2027-07-15', amountCents: 999, cited: [], candidates: [] },
];
const RECS = [
  { lineId: 'l9', invoiceId: 'f9', label: 'F-2027-00010', day: '2027-07-10', amountCents: 800_000, mode: 'auto' },
  { lineId: 'l8', invoiceId: 'f8', label: 'F-2027-00011', day: '2027-07-11', amountCents: 300_000, mode: 'direction', receipt: null },
  { lineId: 'l7', invoiceId: 'f7', label: 'F-2027-00014', day: '2027-07-08', amountCents: 200_000, mode: 'auto', receipt: { receivedAt: '2027-07-07T22:00:00.000Z', payoutDueAt: '2027-07-09T22:00:00.000Z', proof: 'ligne' } },
  { lineId: 'l6', invoiceId: 'f6', label: 'F-2027-00015', day: '2027-07-08', amountCents: 100_000, mode: 'direction', receipt: { receivedAt: '2027-07-08T08:00:00.000Z', payoutDueAt: '2027-07-10T08:00:00.000Z', proof: 'autre' } },
  { lineId: 'l5', invoiceId: 'f5', label: 'F-2027-00016', day: '2027-07-08', amountCents: 100_000, mode: 'direction', receipt: { receivedAt: 'demain', payoutDueAt: '2027-07-10T08:00:00.000Z', proof: 'ligne' } },
];
const TEXT = 'Bonjour,\n\nla facture F-2027-00012 de 5 000,00 €, émise le 1er juin 2027, arrivait à échéance le 1er juillet 2027.\n\nSi elle a déjà été réglée, une simple réponse suffit.';
const REMINDERS = [
  { id: 'r2', invoiceId: 'f12', label: 'F-2027-00012', rank: 1, text: 'Bonjour, déjà partie.', status: 'envoyee', rule: null, preparedAt: '2027-06-01T04:00:00.000Z', validatedBy: 'direction:d1' },
  { id: 'r1', invoiceId: 'f12', label: 'F-2027-00012', rank: 2, text: TEXT, status: 'a_valider', rule: null, preparedAt: '2027-07-15T04:00:00.000Z', validatedBy: null },
  { id: 'r3', invoiceId: 'f13', label: 'F-2027-00013', rank: 1, text: INJECTED, status: 'close', rule: null, preparedAt: '2027-07-15T04:00:00.000Z', validatedBy: null },
];

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
const btn = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
const btns = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);

async function desk(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  (document as { body?: FakeElement }).body = new FakeElement('body');
  const calls: { method: string; url: string; body: Record<string, unknown> | null; type: string | null }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/gagner/engagements': ok([]),
    'GET /v1/finances/banque/fraicheur': ok(FRESH),
    'GET /v1/finances/banque/propositions': ok(PROPOSALS),
    'GET /v1/finances/banque/rapprochements': ok(RECS),
    'GET /v1/finances/relances': ok(REMINDERS),
    'POST /v1/finances/banque/releve': ok(null, { added: 3, already: 1 }),
    'POST /v1/finances/banque/lignes/l1/rapprochement': ok({ lineId: 'l1', invoiceId: 'f2' }),
    'POST /v1/finances/banque/factures/f9/encaissement': ok(null, { payoutDueAt: '2027-07-17T08:00:00.000Z' }),
    'POST /v1/finances/relances/r1/validation': ok(null),
    ...answers,
  };
  const ctx: Record<string, unknown> = {
    document,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, type: init.headers?.['content-type'] ?? null });
      const a = table[`${method} ${url}`] ?? (method === 'GET' && url === '/v1/moi' ? ok({ role: 'direction', firstName: null }) : undefined);
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
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
  const part = () => els['engagements-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Banque et relances des impayés')!;
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const open = async () => {
    await click(btn(part(), 'Ouvrir la banque'));
    const s = scriptsOf(part(), '/app/banque.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(BANQUE_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const status = () => part().all().find((e) => e.className === 'banque')?.children[0]?.textContent ?? '';
  return { els, ctx, calls, table, part, input, open, click, posts, status, button: (t: string) => btn(part(), t), buttons: (t: string) => btns(part(), t), text: () => part().textContent };
}

describe('BR93 · la banque et les relances d’impayés à l’écran de la direction', () => {
  it('[R201] un seul script servi à part, chargé au seul geste sous les engagements ; budgets tenus, sans innerHTML ni fetch', async () => {
    expect(AGENT_APP_FILES['/app/banque.js']).toBe(BANQUE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/banque.js');
    const served = handleAgentApp(new Request('https://x.test/app/banque.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: BANQUE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: ENGAGEMENTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/finances/banque');
    expect(BANQUE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|eval\(|fetch\(/);
    // Seules les routes de la banque et des relances.
    for (const path of BANQUE_SCRIPT.match(/'\/v1\/[^']*'/g) ?? []) expect(path).toMatch(/^'\/v1\/finances\/(banque|relances)'$/);
    const d = await desk();
    expect(scriptsOf(d.part(), '/app/banque.js')).toHaveLength(0);
    expect(d.calls.some((c) => c.url.startsWith('/v1/finances'))).toBe(false);
    await d.open();
    expect(scriptsOf(d.part(), '/app/banque.js')).toHaveLength(1);
    expect(d.calls.filter((c) => c.url.startsWith('/v1/finances')).map((c) => c.url).sort()).toEqual(['/v1/finances/banque/fraicheur', '/v1/finances/banque/propositions', '/v1/finances/banque/rapprochements', '/v1/finances/relances']);
    await d.click(d.button('Ouvrir la banque'));
    expect(scriptsOf(d.part(), '/app/banque.js')).toHaveLength(1);
    // Les titres suivent ceux des engagements, sans saut.
    expect(d.part().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent)).toEqual(['Le dernier relevé', 'Déposer le relevé de la banque', 'Lignes à choisir', 'Factures rapprochées', 'Relances des factures impayées']);
    expect(d.input('banque-releve').attributes.type).toBe('file');
    expect(d.part().all().some((e) => e.tagName === 'label' && e.attributes.for === 'banque-releve')).toBe(true);
  });

  it('[R553] la fraîcheur se lit avant tout : frais, ancien, aucun relevé, et la relance impossible dite (Jamais vu)', async () => {
    const fresh = await desk();
    await fresh.open();
    expect(fresh.text()).toContain('Dernier relevé déposé le 14/07/2027, hier.');
    expect(fresh.text()).toContain(BANQUE_FRESH);
    expect(fresh.text()).not.toContain(BANQUE_STALE);
    const old = await desk({ 'GET /v1/finances/banque/fraicheur': ok({ lastImportDay: '2027-07-01', ageDays: 14, fresh: false, reason: 'releve_ancien', maxAgeDays: 7 }) });
    await old.open();
    expect(old.text()).toContain('Dernier relevé déposé le 01/07/2027, il y a 14 jours.');
    expect(old.text()).toContain(`Plus de 7 jours. ${BANQUE_STALE}`);
    expect(old.text()).not.toContain(BANQUE_FRESH);
    const today = await desk({ 'GET /v1/finances/banque/fraicheur': ok({ ...FRESH, ageDays: 0, lastImportDay: '2027-07-15' }) });
    await today.open();
    expect(today.text()).toContain('le 15/07/2027, aujourd’hui.');
    const none = await desk({ 'GET /v1/finances/banque/fraicheur': ok({ lastImportDay: null, ageDays: null, fresh: false, reason: 'aucun_releve', maxAgeDays: 7 }) });
    await none.open();
    expect(none.text()).toContain(BANQUE_NO_STATEMENT);
    // La fraîcheur passe en premier, avant le dépôt et les lignes.
    expect(none.text().indexOf(BANQUE_NO_STATEMENT)).toBeLessThan(none.text().indexOf('Déposer le relevé'));
    // Une forme inattendue n'est pas dite comme un fait.
    const odd = await desk({ 'GET /v1/finances/banque/fraicheur': ok({ lastImportDay: '14/07', ageDays: -1, fresh: true, reason: 'frais', maxAgeDays: 7 }) });
    await odd.open();
    expect(odd.text()).not.toContain('Dernier relevé déposé');
    expect(odd.text()).toContain('La banque n’a pas pu être lue');
  });

  it('[R551] [R15] le relevé : fichier lu et envoyé tel quel sous csv, trop gros ou vide arrêté avant l’envoi, réponse dite, écran relu', async () => {
    const d = await desk();
    await d.open();
    await d.click(d.button('Déposer ce relevé'));
    expect(d.status()).toBe('Choisissez le fichier du relevé.');
    (d.input('banque-releve') as unknown as { files: unknown }).files = [{ size: 1_000_001, text: async () => 'x' }];
    await d.click(d.button('Déposer ce relevé'));
    expect(d.status()).toContain('dépasse 1 Mo');
    (d.input('banque-releve') as unknown as { files: unknown }).files = [{ size: 0, text: async () => '' }];
    await d.click(d.button('Déposer ce relevé'));
    expect(d.status()).toContain('vide');
    expect(d.posts()).toHaveLength(0);
    const csv = '﻿Date;Libellé;Montant\r\n2027-07-14;VIR SEPA ETUDE F-2027-00002;10 000,00\r\n';
    (d.input('banque-releve') as unknown as { files: unknown }).files = [{ size: csv.length, text: async () => csv }];
    const before = d.calls.length;
    await d.click(d.button('Déposer ce relevé'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/finances/banque/releve', body: { csv }, type: 'application/json' }]);
    expect(d.status()).toBe('Relevé déposé : 3 lignes nouvelles, 1 déjà connue.');
    // L'écran est relu après le dépôt.
    expect(d.calls.slice(before).filter((c) => c.method === 'GET').map((c) => c.url)).toContain('/v1/finances/banque/fraicheur');
  });

  it('[R551] les refus du relevé dits en mots : ligne illisible avec son numéro, jour à venir, droits, réponse perdue', async () => {
    const cases: [Answer, string][] = [
      [no(400, { ok: false, rule: null, code: 'bad_statement', line: 4 }), 'La ligne 4 du relevé est illisible (jour ; libellé ; montant attendus) : rien n’est rangé.'],
      [no(400, { ok: false, rule: null, code: 'bad_statement', line: 0 }), BANQUE_REFUSALS.future_day!],
      [no(400, { ok: false, rule: null, code: 'invalid_body' }), BANQUE_REFUSALS.invalid_body!],
      [no(400, { ok: false, rule: null, code: 'secret_inconnu' }), BANQUE_FAILED],
      [no(500, { ok: false }), BANQUE_FAILED],
      [cut, BANQUE_LOST],
    ];
    for (const [answer, said] of cases) {
      const d = await desk({ 'POST /v1/finances/banque/releve': answer });
      await d.open();
      (d.input('banque-releve') as unknown as { files: unknown }).files = [{ size: 10, text: async () => '2027-07-14;VIR;1,00' }];
      await d.click(d.button('Déposer ce relevé'));
      expect(d.status()).toBe(said);
      expect(d.text()).not.toMatch(/bad_statement|invalid_body|secret_inconnu/);
    }
  });

  it('[R551] chaque ligne à choisir dit pourquoi le passage ne l’a pas tranchée ; la facture citée passe en tête (Jamais vu)', async () => {
    const d = await desk();
    await d.open();
    const text = d.text();
    expect(text).toContain('Ligne du 14/07/2027 : 10 000,00 €');
    expect(text).toContain('Le libellé cite : F-2027-00002.');
    expect(text).toContain(BANQUE_WHY_CITED);
    expect(text).toContain(BANQUE_WHY_UNCITED);
    expect(text).toContain(BANQUE_WHY_ELSEWHERE);
    expect(text).toContain('Facture F-2027-00002, 10 000,00 € · citée par le libellé');
    // La facture citée vient avant l'autre, même si le serveur l'a rendue seconde.
    const order = d.part().all().filter((e) => e.tagName === 'button' && e.textContent.startsWith('Rapprocher de ')).map((e) => e.textContent);
    expect(order).toEqual(['Rapprocher de F-2027-00002', 'Rapprocher de F-2027-00001', 'Rapprocher de F-2027-00003', 'Rapprocher de F-2027-00004']);
    // Un crédit sans facture du même montant : à part, sans bouton.
    expect(text).toContain('Autres crédits, sans facture de ce montant (1)');
    expect(text).toContain('Ligne du 15/07/2027 : 9,99 €');
    expect(text).toContain(BANQUE_WHY_NONE);
    expect(d.posts()).toHaveLength(0);
  });

  it('[R551] rapprocher : seulement après confirmation, vers la facture proposée, aucun montant envoyé ; annuler ne range rien', async () => {
    const d = await desk();
    await d.open();
    await d.click(d.button('Rapprocher de F-2027-00002'));
    expect(d.posts()).toHaveLength(0);
    expect(d.text()).toContain('La ligne du 14/07/2027 de 10 000,00 € paie la facture F-2027-00002');
    await d.click(d.button('Annuler'));
    expect(d.button('Confirmer le rapprochement')).toBeUndefined();
    expect(d.posts()).toHaveLength(0);
    await d.click(d.button('Rapprocher de F-2027-00002'));
    await d.click(d.button('Confirmer le rapprochement'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/finances/banque/lignes/l1/rapprochement', body: { invoiceId: 'f2' }, type: 'application/json' }]);
    expect(d.status()).toBe('Ligne du 14/07/2027 rapprochée de la facture F-2027-00002. Rangez maintenant son encaissement.');
  });

  it('[R551] les refus du rapprochement dits en mots, jamais un code', async () => {
    for (const code of ['amount', 'credited', 'already', 'before_invoice', 'not_credit', 'unknown_line', 'unknown_invoice'] as const) {
      const d = await desk({ 'POST /v1/finances/banque/lignes/l1/rapprochement': no(code.startsWith('unknown') ? 404 : 409, { ok: false, rule: code.startsWith('unknown') ? null : 'R551', code }) });
      await d.open();
      await d.click(d.button('Rapprocher de F-2027-00002'));
      await d.click(d.button('Confirmer le rapprochement'));
      expect(d.status()).toBe(BANQUE_REFUSALS[code]);
    }
  });

  it('[R552] rapprochements : par le passage ou par la direction ; l’encaissement rangé après confirmation, la ligne pour preuve', async () => {
    const d = await desk();
    await d.open();
    const text = d.text();
    expect(text).toContain('Facture F-2027-00010 : 8 000,00 €');
    expect(text).toContain('Payée par la ligne du 10/07/2027, rapprochée seule par le passage');
    expect(text).toContain('Payée par la ligne du 11/07/2027, rapprochée par la direction.');
    // Un encaissement déjà rangé se dit, sans bouton ; un détail illisible n'offre pas de geste non plus.
    expect(d.buttons('Ranger l’encaissement')).toHaveLength(2);
    expect(text).toContain('Encaissement rangé, reçu le 08/07/2027 00:00, cette ligne de banque pour preuve. Part de l’agent à verser avant le 10/07/2027 00:00.');
    expect(text).toContain('Encaissement rangé, reçu le 08/07/2027 10:00, avec une autre preuve, aux commissions.');
    expect(text).toContain('Un encaissement est rangé, mais son détail n’a pas pu être lu.');
    const [first] = d.buttons('Ranger l’encaissement');
    await d.click(first);
    expect(d.posts()).toHaveLength(0);
    expect(d.text()).toContain('Ranger l’encaissement de la facture F-2027-00010, reçu le 10/07/2027, avec la ligne de banque pour preuve.');
    await d.click(d.button('Confirmer l’encaissement'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/finances/banque/factures/f9/encaissement', body: null, type: null }]);
    expect(d.status()).toBe('Encaissement de la facture F-2027-00010 rangé, la ligne de banque pour preuve. La part de l’agent est à verser avant le 17/07/2027 10:00.');
    for (const code of ['already', 'not_reconciled', 'sale_cancelled', 'not_invoiced']) {
      const x = await desk({ 'POST /v1/finances/banque/factures/f9/encaissement': no(409, { ok: false, rule: 'R552', code }) });
      await x.open();
      await x.click(x.buttons('Ranger l’encaissement')[0]);
      await x.click(x.button('Confirmer l’encaissement'));
      expect(x.status()).toBe(BANQUE_REFUSALS[code]);
    }
  });

  it('[R553] relances : texte posé en texte mot pour mot, état en mots, seule « à valider » se valide après confirmation', async () => {
    const d = await desk();
    await d.open();
    const text = d.text();
    for (const line of TEXT.split('\n').filter((l) => l.trim())) expect(text).toContain(line);
    expect(text).toContain(BANQUE_REMINDER_STATES.a_valider);
    expect(text).toContain(BANQUE_REMINDER_STATES.envoyee);
    expect(text).toContain(BANQUE_REMINDER_STATES.close);
    // Le texte reçu reste du texte.
    expect(d.part().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(text).toContain(INJECTED);
    // À valider en premier, puis les autres ; un seul bouton, pour la seule relance à valider.
    expect(text.indexOf('relance 2 sur 3')).toBeLessThan(text.indexOf('relance 1 sur 3'));
    expect(d.buttons('Valider ce texte')).toHaveLength(1);
    await d.click(d.button('Valider ce texte'));
    expect(d.posts()).toHaveLength(0);
    await d.click(d.button('Confirmer la validation'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/finances/relances/r1/validation', body: { preparedAt: '2027-07-15T04:00:00.000Z', text: TEXT }, type: 'application/json' }]);
    expect(d.status()).toBe('Relance de la facture F-2027-00012 validée : elle partira au prochain passage, en mode essai.');
    const late = await desk({ 'POST /v1/finances/relances/r1/validation': no(409, { ok: false, rule: 'R553', code: 'not_pending' }) });
    await late.open();
    await late.click(late.button('Valider ce texte'));
    await late.click(late.button('Confirmer la validation'));
    expect(late.status()).toBe(BANQUE_REFUSALS.not_pending);
  });

  it('[R16] refus de droits et réseau coupé dits en mots ; une forme inattendue jamais montrée ; une réponse d’une session finie jetée', async () => {
    const role = await desk({ 'GET /v1/finances/banque/fraicheur': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await role.open();
    expect(role.status()).toBe(BANQUE_ROLE);
    expect(role.text()).not.toContain('Lignes à choisir');
    const offline = await desk({ 'GET /v1/finances/banque/fraicheur': cut, 'GET /v1/finances/banque/propositions': cut, 'GET /v1/finances/banque/rapprochements': cut, 'GET /v1/finances/relances': cut });
    await offline.open();
    expect(offline.status()).toBe('Pas de réseau. Réessayez dans un moment.');
    const odd = await desk({ 'GET /v1/finances/banque/propositions': ok([{ lineId: 'l1"><b>', day: '2027-07-14', amountCents: 1, cited: [], candidates: [] }, { lineId: 'l5', day: '2027-07-14', amountCents: 5, cited: [], candidates: [{ invoiceId: 'f/../x', label: 'F-2027-00005' }] }]) });
    await odd.open();
    expect(odd.text()).not.toContain('l1"');
    expect(odd.buttons('Rapprocher de F-2027-00005')).toHaveLength(0);
    // Une lecture qui revient après la fin de la session est jetée.
    let release: (r: Response) => void = () => undefined;
    const slow = await desk({ 'GET /v1/finances/relances': () => new Promise<Response>((r) => { release = r; }) });
    await slow.click(slow.button('Ouvrir la banque'));
    runInNewContext(BANQUE_SCRIPT, slow.ctx);
    scriptsOf(slow.part(), '/app/banque.js')[0]!.listeners.load!({});
    await settle();
    await slow.click(slow.els['sortir']);
    release(Response.json({ ok: true, mode: 'essai', data: REMINDERS }));
    await settle();
    expect(slow.els['reseau']!.textContent).not.toContain('Facture F-2027-00012');
  });
});
