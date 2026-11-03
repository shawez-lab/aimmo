import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { MESURE_SOURCES_SCRIPT, PROOF_MAX_BYTES, PROOF_TYPES } from '../app/mesure-sources.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES } from '../src/partenaires.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, chiffres, raisons.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const clean = (t: string): string => t.replace(/[  ]/g, ' ');
const LINE_B = { source: 'referral', label: 'Recommandation', mandates: 2, appointments: 3, costCents: 120050, costPerMandateCents: 60025, decision: { decision: 'garder', month: '2027-09', decidedAt: '2027-10-02T08:00:00.000Z' } };
const LINE_A = { source: 'social', label: 'Réseaux sociaux', mandates: 0, appointments: 1, costCents: 5000, costPerMandateCents: null, decision: null };
const LINE_C = { source: 'portal', label: 'Portail', mandates: 1, appointments: 0, costCents: null, costPerMandateCents: null, decision: null };
const LINE_U = { source: 'inconnue', label: 'Source inconnue', mandates: 0, appointments: 2, costCents: null, costPerMandateCents: null, decision: null };
const REPORT = { month: '2027-10', lines: [LINE_B, LINE_A, LINE_C, LINE_U], totals: { mandates: 3, appointments: 6, costCents: 125050 } };
const NOW = Date.parse('2027-11-05T12:00:00.000Z');
class Clock extends Date {
  static override now(): number {
    return NOW;
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const pdf = { type: 'application/pdf', size: 900, name: 'facture-secrete.pdf' };

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    'GET /v1/gagner/mesure/2027-10': ok(REPORT),
    'POST /v1/gagner/mesure/preuves': ok({ proofRef: 'mesure-sources/n1/p1.pdf' }),
    'POST /v1/gagner/mesure/couts': ok({ version: 1 }),
    'POST /v1/gagner/mesure/decisions': ok({ id: 'd1' }),
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
  const body = () => els['mesure-corps']!;
  const state = () => clean(els['mesure-etat']!.textContent);
  const texts = () => clean(body().all().map((e) => e.textContent).join(' | '));
  const find = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)! as FakeElement & { files?: unknown[] };
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/mesure-sources.js');
  const voir = async (month = '2027-10') => {
    els['mesure-mois']!.value = month;
    await click(els['mesure-voir']);
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(MESURE_SOURCES_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/v1/gagner/'));
  return { els, calls, table, body, state, texts, find, input, click, voir, posts, scripts };
}

describe('G14 · la mesure des sources à l’écran', () => {
  it('le script ne se charge qu’au premier geste, et lit le mois choisi', async () => {
    const t = await run();
    expect(t.calls.some((c) => c.url.startsWith('/v1/gagner/mesure'))).toBe(false);
    expect(t.scripts()).toHaveLength(0);
    await t.voir();
    expect(t.calls.filter((c) => c.url === '/v1/gagner/mesure/2027-10')).toHaveLength(1);
    expect(t.texts()).toContain('Mois 2027-10');
    expect(t.texts()).toContain('En tout : 3 mandats signés, 6 rendez-vous tenus, 1 250,50 € de coûts saisis.');
  });

  it('sans mois choisi, le mois passé à l’heure de Paris ; un mois illisible ne part pas', async () => {
    const t = await run({ 'GET /v1/gagner/mesure/2027-10': ok(REPORT) });
    await t.voir('');
    expect(t.els['mesure-mois']!.value).toBe('2027-10');
    expect(t.calls.filter((c) => c.url === '/v1/gagner/mesure/2027-10')).toHaveLength(1);
    t.calls.length = 0;
    await t.voir('2027-13');
    expect(t.state()).toBe('Choisissez un mois.');
    expect(t.calls).toHaveLength(0);
  });

  it('[R144] chaque ligne dit ses nombres, dans l’ordre reçu, sans rien recommander', async () => {
    const t = await run();
    await t.voir();
    const strong = t.body().all().filter((e) => e.tagName === 'strong').map((e) => e.textContent);
    expect(strong).toEqual(['Recommandation', 'Réseaux sociaux', 'Portail', 'Source inconnue']);
    const all = t.texts();
    expect(all).toContain('2 mandats signés · 3 rendez-vous tenus');
    expect(all).toContain('Coût : 1 200,50 €, soit 600,25 € par mandat.');
    expect(all).toContain('Coût : 50,00 €, aucun mandat sur ce mois.');
    expect(all).toContain('Coût non saisi.');
    expect(all).toContain('Votre dernière décision : garder');
    expect(all).not.toMatch(/recommand(é|e|ons)\b|conseil|meilleure|à arrêter|rentable/i);
  });

  it('[R144] rien ne part sans un appui de la direction : lire le mois n’écrit rien', async () => {
    const t = await run();
    await t.voir();
    expect(t.posts()).toEqual([]);
  });

  it('[R144] une source inconnue se lit, mais ne se règle pas', async () => {
    const t = await run();
    await t.voir();
    expect(t.find('Ranger le coût')).toHaveLength(3);
    expect(t.find('Arrêter cette source')).toHaveLength(3);
  });

  it('le coût part en centimes exacts, après le dépôt de sa preuve, et le mois est relu', async () => {
    const t = await run();
    await t.voir();
    t.input('mesure-montant-0').value = '1 019,99';
    t.input('mesure-preuve-0').files = [pdf];
    await t.click(t.find('Ranger le coût')[0]);
    const [up, cost] = t.posts();
    expect(up!.url).toBe('/v1/gagner/mesure/preuves');
    expect(up!.headers['content-type']).toBe('application/pdf');
    expect(up!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(up!.url).not.toContain('facture');
    expect(cost!.url).toBe('/v1/gagner/mesure/couts');
    expect(cost!.body).toEqual({ month: '2027-10', source: 'referral', amountCents: 101999, proofRef: 'mesure-sources/n1/p1.pdf' });
    expect(t.state()).toBe('Coût rangé, avec sa preuve.');
    expect(t.calls.filter((c) => c.url === '/v1/gagner/mesure/2027-10')).toHaveLength(2);
  });

  it('un montant illisible, ou sans preuve, ou d’un autre format, ne part pas', async () => {
    const t = await run();
    await t.voir();
    const go = t.find('Ranger le coût')[0];
    for (const bad of ['', 'douze', '12,345', '-5', '1,2,3']) {
      t.input('mesure-montant-0').value = bad;
      await t.click(go);
      expect(t.state()).toContain('Le coût : un montant');
    }
    t.input('mesure-montant-0').value = '12';
    await t.click(go);
    expect(t.state()).toBe('Choisissez la preuve de ce coût.');
    t.input('mesure-preuve-0').files = [{ type: 'image/gif', size: 10 }];
    await t.click(go);
    expect(t.state()).toBe('La preuve : un fichier PDF, JPEG ou PNG.');
    t.input('mesure-preuve-0').files = [{ type: 'application/pdf', size: PROOF_MAX_BYTES + 1 }];
    await t.click(go);
    expect(t.state()).toBe('Cette preuve dépasse 10 Mo : rien n’est envoyé.');
    expect(t.posts()).toEqual([]);
  });

  it('une preuve déjà rangée n’est pas renvoyée quand seul le coût a été refusé', async () => {
    const t = await run({ 'POST /v1/gagner/mesure/couts': no(400, { ok: false, rule: null, code: 'conflict' }) });
    await t.voir();
    t.input('mesure-montant-1').value = '10';
    t.input('mesure-preuve-1').files = [pdf];
    await t.click(t.find('Ranger le coût')[1]);
    expect(t.state()).toBe('Une autre saisie vient de passer : relisez le mois, puis recommencez.');
    t.table['POST /v1/gagner/mesure/couts'] = ok({ version: 2 });
    await t.click(t.find('Ranger le coût')[1]);
    expect(t.posts().filter((c) => c.url.endsWith('/preuves'))).toHaveLength(1);
    expect(t.posts().filter((c) => c.url.endsWith('/couts'))).toHaveLength(2);
    expect(t.state()).toBe('Coût rangé, avec sa preuve.');
  });

  it('stockage absent : dit en français, et aucun coût ne part', async () => {
    const t = await run({ 'POST /v1/gagner/mesure/preuves': no(503, { ok: false, rule: null, code: 'storage_unavailable' }) });
    await t.voir();
    t.input('mesure-montant-0').value = '10';
    t.input('mesure-preuve-0').files = [pdf];
    await t.click(t.find('Ranger le coût')[0]);
    expect(t.state()).toBe('Le stockage des preuves n’est pas en service : aucun coût ne peut être rangé pour le moment.');
    expect(t.posts().filter((c) => c.url.endsWith('/couts'))).toEqual([]);
  });

  it('[R10] une réponse perdue ou une panne n’est dite ni faite ni refusée', async () => {
    const LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez le mois avant de recommencer.';
    const t = await run({ 'POST /v1/gagner/mesure/couts': () => Promise.reject(new TypeError('coupé')) });
    await t.voir();
    t.input('mesure-montant-0').value = '10';
    t.input('mesure-preuve-0').files = [pdf];
    await t.click(t.find('Ranger le coût')[0]);
    expect(t.state()).toBe(LOST);
    t.table['POST /v1/gagner/mesure/decisions'] = no(500, { ok: false, code: 'internal' });
    t.input('mesure-raison-0').value = 'Trop peu de retours';
    await t.click(t.find('Arrêter cette source')[0]);
    expect(t.state()).toBe(LOST);
    const u = await run({ 'POST /v1/gagner/mesure/preuves': () => Promise.reject(new TypeError('coupé')) });
    await u.voir();
    u.input('mesure-montant-0').value = '10';
    u.input('mesure-preuve-0').files = [pdf];
    await u.click(u.find('Ranger le coût')[0]);
    expect(u.state()).toBe(LOST);
  });

  it('[R10] une écriture passée reste dite, même si la relecture du mois échoue', async () => {
    const t = await run();
    await t.voir();
    delete t.table['GET /v1/gagner/mesure/2027-10'];
    t.input('mesure-raison-0').value = 'Bons retours';
    await t.click(t.find('Garder cette source')[0]);
    expect(t.state()).toBe('Décision rangée : garder. Pas de réseau. Réessayez dans un moment.');
  });

  it('[R144] une décision porte sa raison et son mois ; sans raison, elle ne part pas', async () => {
    const t = await run();
    await t.voir();
    await t.click(t.find('Arrêter cette source')[2]);
    expect(t.state()).toBe('La raison : de 3 à 200 caractères.');
    expect(t.posts()).toEqual([]);
    t.input('mesure-raison-2').value = '  Aucun mandat en six mois  ';
    await t.click(t.find('Arrêter cette source')[2]);
    expect(t.posts()[0]!.body).toEqual({ month: '2027-10', source: 'portal', decision: 'arreter', reason: 'Aucun mandat en six mois' });
    expect(t.state()).toBe('Décision rangée : arrêter.');
  });

  it('[R16] un refus de droits est dit, sans rien montrer', async () => {
    const t = await run({ 'GET /v1/gagner/mesure/2027-10': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.voir();
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
    expect(t.body().children).toEqual([]);
  });

  it('[R10] sans réseau, la lecture le dit', async () => {
    const t = await run();
    delete t.table['GET /v1/gagner/mesure/2027-10'];
    await t.voir();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('en sortant, rien ne reste à l’écran, et deux appuis ne font qu’une liste', async () => {
    const t = await run();
    await t.voir();
    t.els['mesure-voir']!.listeners.click!({});
    t.els['mesure-voir']!.listeners.click!({});
    await settle();
    expect(t.body().all().filter((e) => e.tagName === 'ul')).toHaveLength(1);
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
    expect(t.els['mesure-mois']!.value).toBe('');
  });

  it('un script qui ne charge pas, ou arrive abîmé, est dit, et un nouvel appui réessaie', async () => {
    const t = await run();
    await t.click(t.els['mesure-voir']);
    t.scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    await t.click(t.els['mesure-voir']);
    t.scripts()[1]!.listeners.load!({});
    await settle();
    expect(t.state()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
    await t.click(t.els['mesure-voir']);
    expect(t.scripts()).toHaveLength(3);
  });

  it('les formats et le poids de l’écran sont ceux de la route', () => {
    expect(PROOF_TYPES).toEqual(UPLOAD_TYPES.map((u) => u.type));
    expect(PROOF_MAX_BYTES).toBe(MAX_UPLOAD_BYTES);
  });

  it('[R201] le script est servi à part, jamais gardé sur l’appareil, et tient son budget ; aucun code de page', () => {
    expect(AGENT_APP_FILES['/app/mesure-sources.js']).toBe(MESURE_SOURCES_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/mesure-sources.js');
    expect(handleAgentApp(new Request('https://x.test/app/mesure-sources.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: MESURE_SOURCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(MESURE_SOURCES_SCRIPT).not.toContain('innerHTML');
  });
});
