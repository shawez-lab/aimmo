import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ASSET_KINDS, ASSET_LICENCES, ASSET_SOURCES, WITHDRAWAL_REASONS } from '../../core/src/studio/bibliotheque.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { BIBLIOTHEQUE_KINDS, BIBLIOTHEQUE_LICENCES, BIBLIOTHEQUE_PROOF_MAX_BYTES, BIBLIOTHEQUE_PROOF_TYPES, BIBLIOTHEQUE_REASONS, BIBLIOTHEQUE_SCRIPT, BIBLIOTHEQUE_SOURCES } from '../app/bibliotheque.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES } from '../src/partenaires.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, titres, auteurs, références.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const BASE = '/v1/studio/bibliotheque';
const REF = 'bibliotheque/preuves/00000000-0000-4000-8000-000000000001.pdf';
const LIST = [
  { id: 'a1', kind: 'image', title: 'Zèbre sur fond clair', source: 'banque_sous_licence', licence: 'cc_by', attribution: 'Auteur Inventé', validUntil: null, recordedAt: '2027-01-01T08:00:00.000Z', withdrawn: null, usable: true },
  { id: 'a2', kind: 'musique', title: 'Air du matin', source: 'achat_unitaire', licence: 'licence_achetee', attribution: null, validUntil: '2027-12-31', recordedAt: '2027-01-01T08:00:00.000Z', withdrawn: null, usable: true },
  { id: 'a3', kind: 'musique', title: 'Air échu', source: 'achat_unitaire', licence: 'abonnement', attribution: null, validUntil: '2026-01-31', recordedAt: '2025-01-01T08:00:00.000Z', withdrawn: null, usable: false },
  { id: 'a4', kind: 'image', title: 'Image retirée', source: 'domaine_public', licence: 'cc0', attribution: null, validUntil: null, recordedAt: '2025-01-01T08:00:00.000Z', withdrawn: { reason: 'preuve_invalide', at: '2027-02-03T08:00:00.000Z' }, usable: false },
];
let clock = 0;
class Clock extends Date {
  static override now(): number {
    return clock;
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const pdf = { type: 'application/pdf', size: 900, name: 'licence-secret.pdf' };

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    [`GET ${BASE}`]: ok(LIST),
    [`POST ${BASE}`]: ok(LIST[1]),
    [`POST ${BASE}/preuves`]: ok({ proofRef: REF }),
    [`POST ${BASE}/a2/retrait`]: ok(LIST[1]),
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
  const body = () => els['bibliotheque-corps']!;
  const state = () => els['bibliotheque-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)! as FakeElement & { files?: unknown[] };
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/bibliotheque.js');
  const open = async () => {
    await click(els['bibliotheque-ouvrir']);
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(BIBLIOTHEQUE_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const fill = () => {
    input('bibliotheque-sorte').value = 'musique';
    input('bibliotheque-titre').value = ' Air du matin ';
    input('bibliotheque-source').value = 'achat_unitaire';
    input('bibliotheque-licence').value = 'licence_achetee';
    input('bibliotheque-mention').value = '';
    input('bibliotheque-duree').value = 'date';
    input('bibliotheque-fin').value = '2027-12-31';
    input('bibliotheque-preuve').files = [pdf];
  };
  const add = () => click(find('Ranger cette entrée')[0]);
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/v1/studio/'));
  return { els, calls, table, body, state, texts, find, input, click, open, fill, add, posts, scripts };
}

describe('X13 · la bibliothèque et la mesure des visuels à l’écran', () => {
  it('le script ne se charge qu’au premier geste', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/studio/'))).toBe(false);
    await t.open();
    expect(t.scripts()).toHaveLength(1);
    expect(t.calls.filter((c) => c.url === BASE)).toHaveLength(1);
  });

  it('[R133] la liste dit ce qui est utilisable, expiré ou retiré, dans l’ordre reçu', async () => {
    const t = await run();
    await t.open();
    const names = t.body().all().filter((e) => e.tagName === 'strong').map((e) => e.textContent);
    expect(names).toEqual(['Zèbre sur fond clair', 'Air du matin', 'Air échu', 'Image retirée']);
    expect(t.texts()).toContain('Utilisable, licence sans fin.');
    expect(t.texts()).toContain('Mention : Auteur Inventé');
    expect(t.texts()).toContain('Utilisable jusqu’au 31/12/2027.');
    expect(t.texts()).toContain('Licence expirée le 31/01/2026. Elle n’est plus proposée.');
    expect(t.texts()).toContain('Retirée le 03/02/2027 : Preuve non valable. Elle n’est plus proposée.');
    // Une entrée retirée n'a plus de geste.
    expect(t.find('Retirer cette entrée')).toHaveLength(3);
  });

  it('[R133] une licence manquante est refusée et dite ; rien ne part, pas même la preuve', async () => {
    const t = await run();
    await t.open();
    await t.add();
    expect(t.state()).toBe('Choisissez musique ou image.');
    t.fill();
    t.input('bibliotheque-titre').value = 'x';
    await t.add();
    expect(t.state()).toContain('Le titre');
    t.fill();
    t.input('bibliotheque-source').value = '';
    await t.add();
    expect(t.state()).toBe('Choisissez la source : sans elle, rien n’est rangé.');
    t.fill();
    t.input('bibliotheque-licence').value = '';
    await t.add();
    expect(t.state()).toBe('Choisissez la licence : sans elle, rien n’est rangé.');
    t.fill();
    t.input('bibliotheque-licence').value = 'cc_by';
    await t.add();
    expect(t.state()).toBe('Cette licence exige de nommer l’auteur à chaque usage : écrivez sa mention.');
    t.fill();
    t.input('bibliotheque-duree').value = '';
    await t.add();
    expect(t.state()).toBe('Dites jusqu’à quand vaut la licence, ou qu’elle est sans fin.');
    t.input('bibliotheque-duree').value = 'date';
    t.input('bibliotheque-fin').value = '';
    await t.add();
    expect(t.state()).toBe('Dites jusqu’à quand vaut la licence, ou qu’elle est sans fin.');
    t.fill();
    t.input('bibliotheque-preuve').files = [];
    await t.add();
    expect(t.state()).toBe('Choisissez la preuve de la licence : sans elle, rien n’est rangé.');
    t.input('bibliotheque-preuve').files = [{ type: 'text/html', size: 10 }];
    await t.add();
    expect(t.state()).toBe('La preuve : un fichier PDF, JPEG ou PNG.');
    t.input('bibliotheque-preuve').files = [{ type: 'application/pdf', size: BIBLIOTHEQUE_PROOF_MAX_BYTES + 1 }];
    await t.add();
    expect(t.state()).toBe('Cette preuve dépasse 10 Mo : rien n’est envoyé.');
    expect(t.posts()).toEqual([]);
  });

  it('[R133] [R13] une entrée part après sa preuve, sous la référence du serveur ; le nom du fichier ne part pas', async () => {
    const t = await run();
    await t.open();
    t.fill();
    await t.add();
    expect(t.posts().map((c) => c.url)).toEqual([`${BASE}/preuves`, BASE]);
    expect(t.posts()[0]!.body).toBe(pdf);
    expect(t.posts()[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(t.posts()[0]!.url).not.toContain(KEY);
    expect(t.posts()[1]!.body).toEqual({ kind: 'musique', title: 'Air du matin', source: 'achat_unitaire', licence: 'licence_achetee', validUntil: '2027-12-31', proofRef: REF });
    expect(JSON.stringify(t.posts()[1]!.body)).not.toContain('licence-secret');
    expect(t.state()).toBe('Entrée rangée.');
    expect(t.input('bibliotheque-titre').value).toBe('');
  });

  it('[R133] sans fin : aucune date ne part, même saisie ; la mention part quand elle est écrite', async () => {
    const t = await run();
    await t.open();
    t.fill();
    t.input('bibliotheque-duree').value = 'sans_fin';
    t.input('bibliotheque-licence').value = 'cc_by';
    t.input('bibliotheque-mention').value = ' Auteur Inventé ';
    await t.add();
    expect(t.posts()[1]!.body).toMatchObject({ validUntil: null, attribution: 'Auteur Inventé', licence: 'cc_by' });
  });

  it('[R133] un refus du serveur est dit ; la preuve n’est pas renvoyée, sauf si le serveur ne la retrouve plus', async () => {
    const t = await run({ [`POST ${BASE}`]: no(409, { ok: false, rule: 'R133', code: 'licence_expiree' }) });
    await t.open();
    t.fill();
    await t.add();
    expect(t.state()).toBe('Cette licence est déjà expirée : elle n’est pas rangée.');
    await t.add();
    expect(t.posts().filter((c) => c.url === `${BASE}/preuves`)).toHaveLength(1);
    t.table[`POST ${BASE}`] = no(409, { ok: false, rule: 'R133', code: 'preuve_absente' });
    await t.add();
    expect(t.state()).toBe('La preuve n’est pas retrouvée : déposez-la de nouveau.');
    await t.add();
    expect(t.posts().filter((c) => c.url === `${BASE}/preuves`)).toHaveLength(2);
  });

  it('stockage absent ou Studio fermé : dit en français, et rien n’est rangé', async () => {
    const t = await run({ [`POST ${BASE}/preuves`]: no(503, { ok: false, code: 'storage_unavailable' }) });
    await t.open();
    t.fill();
    await t.add();
    expect(t.state()).toBe('Le stockage des preuves n’est pas en service : rien ne peut être rangé pour le moment.');
    expect(t.posts().map((c) => c.url)).toEqual([`${BASE}/preuves`]);
    const u = await run({ [`GET ${BASE}`]: no(503, { ok: false, code: 'studio_files_not_configured', message: 'x' }) });
    await u.open();
    expect(u.state()).toBe('Le stockage du Studio n’est pas en service : la bibliothèque est fermée pour le moment.');
  });

  it('[R17] le retrait demande un motif et deux appuis espacés', async () => {
    clock = 100_000;
    const t = await run();
    await t.open();
    const b = t.find('Retirer cette entrée')[1]!;
    await t.click(b);
    expect(t.state()).toBe('Choisissez le motif du retrait.');
    t.input('bibliotheque-motif-a2').value = 'licence_retiree';
    await t.click(b);
    expect(t.state()).toContain('cela ne se défait pas');
    clock += 500;
    await t.click(b);
    expect(t.posts()).toEqual([]);
    clock += 2000;
    await t.click(b);
    expect(t.posts()).toMatchObject([{ url: `${BASE}/a2/retrait`, body: { reason: 'licence_retiree' } }]);
    expect(t.state()).toBe('Entrée retirée.');
  });

  it('[R10] une réponse perdue n’est dite ni faite ni refusée, au dépôt, à l’ajout et au retrait', async () => {
    const text = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la bibliothèque avant de recommencer.';
    for (const answer of [async () => { throw new TypeError('coupure'); }, no(500, { ok: false, code: 'panne' }), async () => new Response('pas du json', { status: 200 })] as Answer[]) {
      const a = await run({ [`POST ${BASE}/preuves`]: answer });
      await a.open();
      a.fill();
      await a.add();
      expect(a.state()).toBe(text);
      expect(a.posts().map((c) => c.url)).toEqual([`${BASE}/preuves`]);
      const b = await run({ [`POST ${BASE}`]: answer });
      await b.open();
      b.fill();
      await b.add();
      expect(b.state()).toBe(text);
      const c = await run({ [`POST ${BASE}/a2/retrait`]: answer });
      await c.open();
      c.input('bibliotheque-motif-a2').value = 'licence_retiree';
      clock = 100_000;
      const w = c.find('Retirer cette entrée')[1]!;
      await c.click(w);
      clock += 2000;
      await c.click(w);
      expect(c.state()).toBe(text);
    }
  });

  it('[R10] rangée, mais la liste n’est pas relue : le fait reste dit', async () => {
    const t = await run();
    await t.open();
    t.fill();
    t.table[`GET ${BASE}`] = async () => { throw new TypeError('coupure'); };
    await t.add();
    expect(t.state()).toBe('Entrée rangée. Pas de réseau. Réessayez dans un moment.');
  });

  it('[R132] la mesure dit tenue, non tenue ou incomplète, et nomme chaque visuel à revoir', async () => {
    const line = { postId: 'x', mediaRef: 'biens/b1/photo-essai.jpg', sentAt: '2027-03-04T08:00:00.000Z', verdict: 'adresse_visible' };
    const t = await run({ 'GET /v1/studio/mesure-visuels': ok({ counted: 20, complete: true, passed: true, lines: [], named: [] }) });
    await t.open();
    const read = () => t.click(t.find('Lire la mesure')[0]);
    await read();
    expect(t.texts()).toContain('Mesure tenue : 20 visuels publiés, aucune adresse visible.');
    t.table['GET /v1/studio/mesure-visuels'] = ok({ counted: 20, complete: true, passed: false, lines: [line], named: [line, { ...line, verdict: 'liste_absente' }] });
    await read();
    expect(t.texts()).toContain('Mesure non tenue : 2 visuels à revoir sur 20.');
    expect(t.texts()).toContain('Publié le 04/03/2027 : adresse visible');
    expect(t.texts()).toContain('Publié le 04/03/2027 : liste de contrôle absente');
    expect(t.texts()).toContain('biens/b1/photo-essai.jpg');
    t.table['GET /v1/studio/mesure-visuels'] = ok({ counted: 1, complete: false, passed: false, lines: [], named: [] });
    await read();
    expect(t.texts()).toContain('1 visuel publié sur 20 : la mesure n’est pas encore complète.');
    expect(t.texts()).not.toContain('Mesure tenue');
    t.table['GET /v1/studio/mesure-visuels'] = async () => { throw new TypeError('coupure'); };
    await read();
    expect(t.texts()).toContain('Pas de réseau. Réessayez dans un moment.');
    expect(t.texts()).not.toContain('la mesure n’est pas encore complète');
  });

  it('[R16] un refus de droits est dit, sans rien montrer, sur la liste comme sur la mesure', async () => {
    const t = await run({ [`GET ${BASE}`]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.open();
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
    expect(t.body().children).toEqual([]);
    const u = await run({ 'GET /v1/studio/mesure-visuels': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await u.open();
    await u.click(u.find('Lire la mesure')[0]);
    expect(u.texts()).toContain('Ce n’est pas dans vos droits.');
  });

  it('en sortant, rien ne reste à l’écran ; un script qui manque est dit, et un nouvel appui réessaie', async () => {
    const t = await run();
    await t.open();
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
    const u = await run();
    await u.click(u.els['bibliotheque-ouvrir']);
    u.scripts()[0]!.listeners.error!({});
    await settle();
    expect(u.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    await u.click(u.els['bibliotheque-ouvrir']);
    u.scripts()[1]!.listeners.load!({});
    await settle();
    expect(u.state()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('les listes de l’écran sont celles du métier ; les formats et le poids, ceux de la route', () => {
    expect(Object.keys(BIBLIOTHEQUE_KINDS).sort()).toEqual([...ASSET_KINDS].sort());
    expect(Object.keys(BIBLIOTHEQUE_SOURCES).sort()).toEqual([...ASSET_SOURCES].sort());
    expect(Object.keys(BIBLIOTHEQUE_LICENCES).sort()).toEqual([...ASSET_LICENCES].sort());
    expect(Object.keys(BIBLIOTHEQUE_REASONS).sort()).toEqual([...WITHDRAWAL_REASONS].sort());
    expect(BIBLIOTHEQUE_PROOF_TYPES).toEqual(UPLOAD_TYPES.map((u) => u.type));
    expect(BIBLIOTHEQUE_PROOF_MAX_BYTES).toBe(MAX_UPLOAD_BYTES);
  });

  it('[R201] le script est servi à part, jamais gardé sur l’appareil, et tient son budget ; aucun code de page', () => {
    expect(AGENT_APP_FILES['/app/bibliotheque.js']).toBe(BIBLIOTHEQUE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/bibliotheque.js');
    expect(handleAgentApp(new Request('https://x.test/app/bibliotheque.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: BIBLIOTHEQUE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(BIBLIOTHEQUE_SCRIPT).not.toContain('innerHTML');
  });
});
