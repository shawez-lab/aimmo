import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AVIS_SCRIPT } from '../app/avis.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
type Call = { method: string; url: string; body: Record<string, unknown> | null };
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, code: string): Answer => async () => Response.json({ ok: false, code }, { status });
const DRAFT = { id: 'r1', propertyId: 'b1', status: 'draft', computedLow: 180000, computedHigh: 200000, low: 180000, high: 200000, text: 'Texte <b>de l’avis</b>', createdAt: '2026-11-02T08:00:00.000Z', validatedAt: null };
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/annonces': ok([{ id: 'b1', reference: 'AV-1', city: 'Dijon', state: null }]),
};

async function run(answers: Record<string, Answer>) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: Call[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document: { ...document, body: { appendChild() {}, removeChild() {} } },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    URL: { createObjectURL: () => 'blob:aimmo/x', revokeObjectURL: () => {} },
    setTimeout,
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  const settle = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await settle();
  const body = () => els['avis-corps']!;
  const state = () => els['avis-etat']!.textContent;
  const byText = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)! as FakeElement & { value: string };
  const open = async () => {
    await click(els.biens!.all().find((e) => e.tagName === 'button' && e.textContent === 'Avis de valeur'));
    const s = els.avis!.children.filter((e) => e.tagName === 'script');
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/avis.js']);
    runInNewContext(AVIS_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  return { els, calls, table, body, state, byText, click, input, open };
}

describe('E10 · écran de l’avis de valeur', () => {
  it('[R201] le script est à part, et l’application reste dans son budget', () => {
    expect(AGENT_APP_FILES['/app/avis.js']).toBe(AVIS_SCRIPT);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(budgetProblems({ html: '', js: AVIS_SCRIPT }, BUDGETS.page)).toEqual([]);
  });

  it('[R46] sans avis, le formulaire prépare un brouillon et l’adresse quitte l’écran', async () => {
    const t = await run({ 'GET /v1/biens/b1/avis': ok([]), 'POST /v1/biens/b1/avis': ok(DRAFT) });
    await t.open();
    t.input('avis-adresse').value = '1 Rue de l’Essai 21000 Dijon';
    t.input('avis-type').value = 'apartment';
    t.input('avis-etat-bien').value = 'bon';
    t.table['GET /v1/biens/b1/avis'] = ok([DRAFT]);
    await t.click(t.byText('Préparer le brouillon'));
    expect(t.calls.find((c) => c.method === 'POST')?.body).toEqual({ address: '1 Rue de l’Essai 21000 Dijon', kind: 'apartment', condition: 'bon' });
    expect(t.state()).toContain('Brouillon prêt');
    expect(t.body().all().some((e) => String((e as unknown as { value?: string }).value ?? '').includes('Essai'))).toBe(false);
  });

  it('un refus est dit en français, sans code', async () => {
    const t = await run({ 'GET /v1/biens/b1/avis': ok([]), 'POST /v1/biens/b1/avis': no(422, 'peu_de_ventes') });
    await t.open();
    t.input('avis-adresse').value = '1 Rue de l’Essai 21000 Dijon';
    await t.click(t.byText('Préparer le brouillon'));
    expect(t.state()).toBe('Trop peu de ventes comparables pour une fourchette fiable.');
  });

  it('[R30] un changement non enregistré ne se valide pas, puis s’enregistre sans la fourchette inchangée', async () => {
    const t = await run({ 'GET /v1/biens/b1/avis': ok([DRAFT]), 'POST /v1/avis/r1/ajustement': ok(DRAFT), 'POST /v1/avis/r1/validation': ok({ ...DRAFT, status: 'validated' }) });
    await t.open();
    expect(t.input('avis-texte').value).toBe(DRAFT.text);
    t.input('avis-bas').value = '175000';
    await t.click(t.byText('Valider l’avis'));
    expect(t.state()).toContain('Enregistrez d’abord');
    expect(t.calls.some((c) => c.url.endsWith('/validation'))).toBe(false);
    await t.click(t.byText('Enregistrer'));
    expect(t.calls.find((c) => c.url.endsWith('/ajustement'))?.body).toEqual({ low: 175000 });
  });

  it('[R30] la validation passe par le serveur ; l’avis validé se télécharge, sans bouton de modification', async () => {
    const validated = { ...DRAFT, status: 'validated', validatedAt: '2026-11-02T09:00:00.000Z' };
    const t = await run({ 'GET /v1/biens/b1/avis': ok([DRAFT]), 'POST /v1/avis/r1/validation': ok(validated), 'GET /v1/avis/r1/imprimable': async () => new Response('<html></html>', { status: 200 }) });
    await t.open();
    t.table['GET /v1/biens/b1/avis'] = ok([validated]);
    await t.click(t.byText('Valider l’avis'));
    expect(t.state()).toBe('Avis validé.');
    expect(t.byText('Enregistrer')).toBeUndefined();
    await t.click(t.byText('Télécharger la page à imprimer'));
    expect(t.state()).toContain('Page téléchargée');
  });

  it('[R30] une validation refusée par le serveur est dite, et la page refusée aussi', async () => {
    const validated = { ...DRAFT, status: 'validated' };
    const t = await run({ 'GET /v1/biens/b1/avis': ok([DRAFT]), 'POST /v1/avis/r1/validation': no(422, 'other_range_in_text'), 'GET /v1/avis/r1/imprimable': no(403, 'not_following_agent') });
    await t.open();
    await t.click(t.byText('Valider l’avis'));
    expect(t.state()).toBe('Le texte dit encore la fourchette du calcul : corrigez-le.');
    t.table['GET /v1/biens/b1/avis'] = ok([validated]);
    await t.click(t.els['avis-retour']);
    await t.click(t.els.biens!.all().find((e) => e.tagName === 'button' && e.textContent === 'Avis de valeur'));
    await t.click(t.byText('Télécharger la page à imprimer'));
    expect(t.state()).toBe('Seul l’agent qui suit ce bien prépare et valide son avis.');
  });

  it('[R16] un bien hors de ses droits est dit, et le texte reçu reste du texte', async () => {
    const t = await run({ 'GET /v1/biens/b1/avis': no(403, 'not_assigned') });
    await t.open();
    expect(t.state()).toBe('Ce bien n’est pas dans vos droits.');
    expect(AVIS_SCRIPT).not.toContain('innerHTML');
  });
});
