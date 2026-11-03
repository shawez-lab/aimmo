import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ANNUAIRE_PROOF_MAX_BYTES, ANNUAIRE_PROOF_TYPES, ANNUAIRE_SCRIPT } from '../app/annuaire.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES } from '../src/partenaires.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, entreprises, numéros, adresses.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const P = 'p1';
const CARD = {
  partnerId: P,
  trade: 'courtier',
  businessName: 'Courtage Essai',
  postcodes: ['21000', '21800'],
  proposable: false,
  domains: [],
  reasons: ['Immatriculation ORIAS manquante.'],
  lines: [
    { kind: 'assurance_rcp', domain: null, label: 'Assurance de responsabilité civile professionnelle', state: 'valide', version: 1, validFrom: '2027-01-01', validUntil: '2027-12-31' },
    { kind: 'immatriculation_orias', domain: null, label: 'Immatriculation ORIAS', state: 'manquant', version: null, validFrom: null, validUntil: null },
  ],
};
const SEARCH = {
  day: '2027-07-12',
  proposable: [{ partnerId: 'p2', trade: 'courtier', businessName: 'Zèbre Courtage' }, { partnerId: 'p3', trade: 'courtier', businessName: 'Abeille Courtage' }],
  unavailable: [{ partnerId: P, trade: 'courtier', businessName: 'Courtage Essai', reasons: ['Immatriculation ORIAS manquante.'] }],
};
const Q = '/v1/partenaires/annuaire?metier=courtier&cp=21000';
let clock = 0;
class Clock extends Date {
  static override now(): number {
    return clock;
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const pdf = { type: 'application/pdf', size: 900, name: 'orias-secret.pdf' };

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    [`GET ${Q}`]: ok(SEARCH),
    [`GET /v1/partenaires/annuaire/${P}`]: ok(CARD),
    'POST /v1/partenaires/annuaire': ok({ ...CARD }),
    [`POST /v1/partenaires/annuaire/${P}/preuves`]: ok({ proofRef: `partenaires/${P}/preuve.pdf` }),
    [`POST /v1/partenaires/annuaire/${P}/justificatifs`]: ok(CARD),
    [`POST /v1/partenaires/annuaire/${P}/zones`]: ok(CARD),
    [`POST /v1/partenaires/annuaire/${P}/adresse`]: ok({}),
    [`POST /v1/partenaires/annuaire/${P}/opposition`]: ok(1),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? null), headers: init.headers ?? {} });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date: Clock,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['annuaire-corps']!;
  const state = () => els['annuaire-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)! as FakeElement & { files?: unknown[] };
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/annuaire.js');
  const open = async () => {
    await click(els['annuaire-ouvrir']);
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(ANNUAIRE_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const chercher = async (trade = 'courtier', cp = '21000') => {
    input('annuaire-metier').value = trade;
    input('annuaire-cp').value = cp;
    await click(find('Chercher')[0]);
  };
  const fiche = async () => {
    await open();
    await chercher();
    const ouvrir = find('Ouvrir');
    await click(ouvrir[ouvrir.length - 1]);
  };
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/v1/partenaires/'));
  return { els, calls, table, body, state, texts, find, input, click, open, chercher, fiche, posts, scripts };
}

describe('U13 · l’annuaire des partenaires à l’écran', () => {
  it('le script ne se charge qu’au premier geste', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/partenaires/annuaire'))).toBe(false);
    await t.open();
    expect(t.scripts()).toHaveLength(1);
    expect(t.calls.some((c) => c.url.startsWith('/v1/partenaires/annuaire'))).toBe(false);
  });

  it('[R14] [R73] la recherche garde l’ordre reçu, dit les raisons, sans note, rang ni avis', async () => {
    const t = await run();
    await t.open();
    await t.chercher();
    expect(t.calls.filter((c) => c.url === Q)).toHaveLength(1);
    const names = t.body().all().filter((e) => e.tagName === 'strong').map((e) => e.textContent);
    expect(names).toEqual(['Zèbre Courtage', 'Abeille Courtage', 'Courtage Essai']);
    expect(t.texts()).toContain('Immatriculation ORIAS manquante.');
    expect(t.texts()).not.toMatch(/\bnote\b|étoile|classement|\bavis\b|meilleur/i);
  });

  it('une recherche incomplète ne part pas ; un diagnostiqueur porte son domaine', async () => {
    const t = await run();
    await t.open();
    await t.click(t.find('Chercher')[0]);
    expect(t.state()).toBe('Choisissez le métier.');
    await t.chercher('courtier', '210');
    expect(t.state()).toBe('Le code postal : 5 chiffres.');
    await t.chercher('diagnostiqueur', '21000');
    expect(t.state()).toBe('Pour un diagnostiqueur, choisissez le domaine.');
    expect(t.calls.some((c) => c.url.startsWith('/v1/partenaires/annuaire'))).toBe(false);
    t.table['GET /v1/partenaires/annuaire?metier=diagnostiqueur&cp=21000&domaine=gaz'] = ok({ day: 'x', proposable: [], unavailable: [] });
    t.input('annuaire-domaine').value = 'gaz';
    await t.chercher('diagnostiqueur', '21000');
    expect(t.state()).toBe('Aucun partenaire pour ce métier sur ce code postal.');
  });

  it('ajouter un partenaire ouvre sa fiche, codes postaux séparés', async () => {
    const t = await run();
    await t.open();
    await t.click(t.find('Ajouter ce partenaire')[0]);
    expect(t.state()).toBe('Choisissez le métier.');
    t.input('annuaire-nouveau-metier').value = 'courtier';
    await t.click(t.find('Ajouter ce partenaire')[0]);
    expect(t.state()).toContain('Les codes postaux');
    expect(t.posts()).toEqual([]);
    t.input('annuaire-nouveau-nom').value = ' Courtage Essai ';
    t.input('annuaire-nouveau-zones').value = '21000, 21800\n21240';
    await t.click(t.find('Ajouter ce partenaire')[0]);
    expect(t.posts()[0]!.body).toEqual({ trade: 'courtier', businessName: 'Courtage Essai', postcodes: ['21000', '21800', '21240'] });
    expect(t.state()).toBe('Partenaire ajouté : rangez ses justificatifs pour qu’il soit proposable.');
    expect(t.texts()).toContain('Pas proposable aujourd’hui.');
  });

  it('[R73] la fiche dit l’état du jour et ne propose que les justificatifs de ce métier', async () => {
    const t = await run();
    await t.fiche();
    expect(t.texts()).toContain('21000, 21800');
    expect(t.texts()).toContain('valide, du 2027-01-01 au 2027-12-31.');
    expect(t.texts()).toContain('manquant.');
    const kinds = t.input('annuaire-sorte').children.map((o) => o.value);
    expect(kinds).toEqual(['assurance_rcp', 'immatriculation_orias']);
    expect(t.body().all().some((e) => e.attributes.id === 'annuaire-certif')).toBe(false);
  });

  it('[R73] un diagnostiqueur a sa certification, avec son domaine obligatoire', async () => {
    const t = await run({ [`GET /v1/partenaires/annuaire/${P}`]: ok({ ...CARD, trade: 'diagnostiqueur', domains: ['gaz', 'mesurage'], proposable: true, reasons: [] }) });
    await t.fiche();
    expect(t.texts()).toContain('Domaines proposables : gaz, mesurage.');
    t.input('annuaire-sorte').value = 'certification_diagnostic';
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.state()).toBe('Choisissez le domaine de cette certification.');
    t.input('annuaire-certif').value = 'gaz';
    t.input('annuaire-numero').value = 'C-1';
    t.input('annuaire-debut').value = '2027-01-01';
    t.input('annuaire-fin').value = '2027-12-31';
    t.input('annuaire-preuve').files = [pdf];
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.posts().at(-1)!.body).toMatchObject({ kind: 'certification_diagnostic', domain: 'gaz' });
  });

  it('un justificatif part après le dépôt de sa preuve, sous la référence du serveur', async () => {
    const t = await run();
    await t.fiche();
    t.input('annuaire-sorte').value = 'immatriculation_orias';
    t.input('annuaire-numero').value = ' 27001234 ';
    t.input('annuaire-debut').value = '2027-01-01';
    t.input('annuaire-fin').value = '2027-12-31';
    t.input('annuaire-preuve').files = [pdf];
    await t.click(t.find('Ranger ce justificatif')[0]);
    const [up, cred] = t.posts();
    expect(up!.url).toBe(`/v1/partenaires/annuaire/${P}/preuves`);
    expect(up!.headers['content-type']).toBe('application/pdf');
    expect(up!.url).not.toContain('orias-secret');
    expect(cred!.body).toEqual({ kind: 'immatriculation_orias', number: '27001234', validFrom: '2027-01-01', validUntil: '2027-12-31', proofRef: `partenaires/${P}/preuve.pdf` });
    expect(t.state()).toBe('Justificatif rangé.');
  });

  it('un justificatif incomplet, ou d’un autre format, ne part pas', async () => {
    const t = await run();
    await t.fiche();
    const go = t.find('Ranger ce justificatif')[0];
    await t.click(go);
    expect(t.state()).toContain('Le numéro');
    t.input('annuaire-numero').value = 'N-1';
    await t.click(go);
    expect(t.state()).toContain('Les dates de validité');
    t.input('annuaire-debut').value = '2027-02-01';
    t.input('annuaire-fin').value = '2027-01-01';
    await t.click(go);
    expect(t.state()).toContain('Les dates de validité');
    t.input('annuaire-fin').value = '2027-03-01';
    await t.click(go);
    expect(t.state()).toBe('Choisissez la preuve de ce justificatif.');
    t.input('annuaire-preuve').files = [{ type: 'image/gif', size: 1 }];
    await t.click(go);
    expect(t.state()).toBe('La preuve : un fichier PDF, JPEG ou PNG.');
    t.input('annuaire-preuve').files = [{ type: 'image/png', size: ANNUAIRE_PROOF_MAX_BYTES + 1 }];
    await t.click(go);
    expect(t.state()).toBe('Cette preuve dépasse 10 Mo : rien n’est envoyé.');
    expect(t.posts()).toEqual([]);
  });

  it('une preuve déjà rangée n’est pas renvoyée après un refus du justificatif', async () => {
    const t = await run({ [`POST /v1/partenaires/annuaire/${P}/justificatifs`]: no(400, { ok: false, rule: null, code: 'bad_number' }) });
    await t.fiche();
    t.input('annuaire-numero').value = 'N@1';
    t.input('annuaire-debut').value = '2027-01-01';
    t.input('annuaire-fin').value = '2027-12-31';
    t.input('annuaire-preuve').files = [pdf];
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.state()).toContain('Le numéro : 40 caractères');
    t.table[`POST /v1/partenaires/annuaire/${P}/justificatifs`] = ok(CARD);
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.posts().filter((c) => c.url.endsWith('/preuves'))).toHaveLength(1);
    expect(t.state()).toBe('Justificatif rangé.');
  });

  it('une preuve que le serveur ne retrouve plus est redéposée à l’appui suivant', async () => {
    const t = await run({ [`POST /v1/partenaires/annuaire/${P}/justificatifs`]: no(400, { ok: false, rule: null, code: 'not_stored' }) });
    await t.fiche();
    t.input('annuaire-numero').value = 'N-1';
    t.input('annuaire-debut').value = '2027-01-01';
    t.input('annuaire-fin').value = '2027-12-31';
    t.input('annuaire-preuve').files = [pdf];
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.state()).toBe('La preuve n’est pas retrouvée : déposez-la de nouveau.');
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.posts().filter((c) => c.url.endsWith('/preuves'))).toHaveLength(2);
  });

  it('[R10] un ajout sans réponse invite à chercher avant de refaire : pas de doublon sans le savoir', async () => {
    const t = await run({ 'POST /v1/partenaires/annuaire': () => Promise.reject(new TypeError('coupé')) });
    await t.open();
    t.input('annuaire-nouveau-metier').value = 'courtier';
    t.input('annuaire-nouveau-zones').value = '21000';
    await t.click(t.find('Ajouter ce partenaire')[0]);
    expect(t.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Cherchez ce partenaire avant de l’ajouter de nouveau.');
  });

  it('stockage absent : dit en français, et aucun justificatif ne part', async () => {
    const t = await run({ [`POST /v1/partenaires/annuaire/${P}/preuves`]: no(503, { ok: false, rule: null, code: 'storage_unavailable' }) });
    await t.fiche();
    t.input('annuaire-numero').value = 'N-1';
    t.input('annuaire-debut').value = '2027-01-01';
    t.input('annuaire-fin').value = '2027-12-31';
    t.input('annuaire-preuve').files = [pdf];
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.state()).toBe('Le stockage des preuves n’est pas en service : aucun justificatif ne peut être rangé pour le moment.');
    expect(t.posts().filter((c) => c.url.endsWith('/justificatifs'))).toEqual([]);
  });

  it('[R10] une réponse perdue ou une panne n’est dite ni faite ni refusée', async () => {
    const LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la fiche avant de recommencer.';
    const t = await run({ [`POST /v1/partenaires/annuaire/${P}/zones`]: () => Promise.reject(new TypeError('coupé')), [`POST /v1/partenaires/annuaire/${P}/adresse`]: no(500, { ok: false, code: 'internal' }), [`POST /v1/partenaires/annuaire/${P}/preuves`]: () => Promise.reject(new TypeError('coupé')) });
    await t.fiche();
    t.input('annuaire-zones').value = '21000';
    await t.click(t.find('Ajouter ces codes postaux')[0]);
    expect(t.state()).toBe(LOST);
    t.input('annuaire-mail').value = 'contact@exemple.test';
    t.input('annuaire-accord').value = 'Au salon, le 3 mars';
    await t.click(t.find('Ranger l’adresse et l’accord')[0]);
    expect(t.state()).toBe(LOST);
    t.input('annuaire-numero').value = 'N-1';
    t.input('annuaire-debut').value = '2027-01-01';
    t.input('annuaire-fin').value = '2027-12-31';
    t.input('annuaire-preuve').files = [pdf];
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.state()).toBe(LOST);
  });

  it('[R10] une coupure juste après une clé refusée au dépôt n’est pas dite faite', async () => {
    const t = await run({ [`POST /v1/partenaires/annuaire/${P}/preuves`]: async () => new Response('{}', { status: 401 }) });
    await t.fiche();
    delete t.table[`GET /v1/partenaires/annuaire/${P}`];
    t.input('annuaire-numero').value = 'N-1';
    t.input('annuaire-debut').value = '2027-01-01';
    t.input('annuaire-fin').value = '2027-12-31';
    t.input('annuaire-preuve').files = [pdf];
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez la fiche avant de recommencer.');
  });

  it('[R03] l’adresse et son accord partent ensemble ; sans accord, rien ne part', async () => {
    const t = await run();
    await t.fiche();
    t.input('annuaire-mail').value = 'contact@exemple.test';
    await t.click(t.find('Ranger l’adresse et l’accord')[0]);
    expect(t.state()).toContain('Dites où et quand');
    expect(t.posts()).toEqual([]);
    t.input('annuaire-accord').value = 'Au salon, le 3 mars';
    await t.click(t.find('Ranger l’adresse et l’accord')[0]);
    expect(t.posts()[0]!.body).toEqual({ email: 'contact@exemple.test', consentProof: 'Au salon, le 3 mars' });
    expect(t.state()).toBe('Adresse et accord rangés.');
  });

  it('une clé refusée au dépôt est retirée, et l’écran se vide', async () => {
    const t = await run({ [`POST /v1/partenaires/annuaire/${P}/preuves`]: async () => new Response('{}', { status: 401 }) });
    await t.fiche();
    t.table[`GET /v1/partenaires/annuaire/${P}`] = no(401, { ok: false, code: 'unauthorized' });
    t.input('annuaire-numero').value = 'N-1';
    t.input('annuaire-debut').value = '2027-01-01';
    t.input('annuaire-fin').value = '2027-12-31';
    t.input('annuaire-preuve').files = [pdf];
    await t.click(t.find('Ranger ce justificatif')[0]);
    expect(t.body().children).toEqual([]);
    expect(t.posts().filter((c) => c.url.endsWith('/justificatifs'))).toEqual([]);
  });

  it('[R04] une adresse refusée après opposition est dite', async () => {
    const t = await run({ [`POST /v1/partenaires/annuaire/${P}/adresse`]: no(409, { ok: false, rule: 'R04', code: 'opposed' }) });
    await t.fiche();
    t.input('annuaire-mail').value = 'contact@exemple.test';
    t.input('annuaire-accord').value = 'Au salon';
    await t.click(t.find('Ranger l’adresse et l’accord')[0]);
    expect(t.state()).toContain('a demandé l’arrêt');
  });

  it('[R04] l’opposition demande deux appuis espacés', async () => {
    const t = await run();
    await t.fiche();
    const b = t.find('Noter son opposition')[0]!;
    await t.click(b);
    expect(t.posts()).toEqual([]);
    expect(t.state()).toContain('cela ne se défait pas');
    await t.click(b);
    expect(t.posts()).toEqual([]);
    clock += 2000;
    await t.click(b);
    expect(t.posts().map((c) => c.url)).toEqual([`/v1/partenaires/annuaire/${P}/opposition`]);
    expect(t.state()).toBe('Opposition notée : il ne recevra plus rien.');
  });

  it('[R16] un refus de droits est dit, sans rien montrer de la fiche', async () => {
    const t = await run({ [`GET /v1/partenaires/annuaire/${P}`]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.fiche();
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
    expect(t.texts()).not.toContain('Courtage Essai');
    await t.click(t.find('Retour à la recherche')[0]);
    expect(t.find('Chercher')).toHaveLength(1);
  });

  it('en sortant, rien ne reste à l’écran ; un script qui manque est dit, et un nouvel appui réessaie', async () => {
    const t = await run();
    await t.fiche();
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
    const u = await run();
    await u.click(u.els['annuaire-ouvrir']);
    u.scripts()[0]!.listeners.error!({});
    await settle();
    expect(u.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    await u.click(u.els['annuaire-ouvrir']);
    u.scripts()[1]!.listeners.load!({});
    await settle();
    expect(u.state()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('les formats et le poids de l’écran sont ceux de la route', () => {
    expect(ANNUAIRE_PROOF_TYPES).toEqual(UPLOAD_TYPES.map((u) => u.type));
    expect(ANNUAIRE_PROOF_MAX_BYTES).toBe(MAX_UPLOAD_BYTES);
  });

  it('[R201] le script est servi à part, jamais gardé sur l’appareil, et tient son budget ; aucun code de page', () => {
    expect(AGENT_APP_FILES['/app/annuaire.js']).toBe(ANNUAIRE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/annuaire.js');
    expect(handleAgentApp(new Request('https://x.test/app/annuaire.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: ANNUAIRE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(ANNUAIRE_SCRIPT).not.toContain('innerHTML');
  });
});
