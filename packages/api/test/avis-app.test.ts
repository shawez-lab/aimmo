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
const DRAFT = { id: 'r1', propertyId: 'b1', status: 'draft', computedLow: 180000, computedHigh: 200000, low: 180000, high: 200000, text: 'Texte <b>de l’avis</b>', createdAt: '2026-11-02T08:00:00.000Z', updatedAt: '2026-11-02T08:30:00.000Z', validatedAt: null };
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/annonces': ok([{ id: 'b1', reference: 'AV-1', city: 'Dijon', state: null }]),
};

async function run(answers: Record<string, Answer>, kept: Record<string, string> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY], ...Object.entries(kept)]);
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
  return { els, calls, table, body, state, byText, click, input, open, storage };
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

  it('[R30] la validation porte la version lue à l’écran', async () => {
    const t = await run({ 'GET /v1/biens/b1/avis': ok([DRAFT]), 'POST /v1/avis/r1/validation': no(409, 'changed_meanwhile') });
    await t.open();
    await t.click(t.byText('Valider l’avis'));
    expect(t.calls.find((c) => c.url.endsWith('/validation'))?.body).toEqual({ updatedAt: DRAFT.updatedAt });
    expect(t.state()).toBe('L’avis a changé entre-temps : relisez-le, puis recommencez.');
  });

  it('[R30] pendant un envoi, rien ne se tape : une correction ne se perd pas en silence', async () => {
    let release: (r: Response) => void = () => {};
    const t = await run({ 'GET /v1/biens/b1/avis': ok([DRAFT]), 'POST /v1/avis/r1/ajustement': () => new Promise<Response>((r) => { release = r; }) });
    await t.open();
    t.input('avis-texte').value = 'Autre texte';
    const save = t.byText('Enregistrer')!;
    save.listeners.click!({});
    await new Promise((r) => setTimeout(r, 0));
    expect((t.input('avis-texte') as unknown as { disabled: boolean }).disabled).toBe(true);
    expect((t.byText('Valider l’avis') as unknown as { disabled: boolean }).disabled).toBe(true);
    release(Response.json({ ok: false, code: 'text_refused' }, { status: 422 }));
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    expect((t.input('avis-texte') as unknown as { disabled: boolean }).disabled).toBe(false);
    expect(t.input('avis-texte').value).toBe('Autre texte');
  });

  it('un brouillon faux se refait sans être validé ; un ancien avis validé reste à portée', async () => {
    const old = { ...DRAFT, id: 'r0', status: 'validated' };
    const t = await run({ 'GET /v1/biens/b1/avis': ok([DRAFT, old]), 'GET /v1/avis/r0/imprimable': async () => new Response('<html></html>') });
    await t.open();
    await t.click(t.byText('Télécharger le dernier avis validé'));
    expect(t.calls.some((c) => c.url === '/v1/avis/r0/imprimable')).toBe(true);
    await t.click(t.byText('Refaire le calcul'));
    expect(t.input('avis-adresse')).toBeDefined();
    expect(t.calls.some((c) => c.url.endsWith('/validation'))).toBe(false);
  });

  it('un geste réussi reste dit quand la relecture échoue', async () => {
    const t = await run({ 'GET /v1/biens/b1/avis': ok([DRAFT]), 'POST /v1/avis/r1/validation': ok({ ...DRAFT, status: 'validated' }) });
    await t.open();
    delete t.table['GET /v1/biens/b1/avis'];
    await t.click(t.byText('Valider l’avis'));
    expect(t.state()).toBe('Avis validé. Rouvrez cet écran pour le relire.');
    expect(t.byText('Valider l’avis')).toBeUndefined();
  });

  it('un montant s’écrit avec ses espaces ; autre chose que des chiffres est dit, sans envoi', async () => {
    const t = await run({ 'GET /v1/biens/b1/avis': ok([DRAFT]), 'POST /v1/avis/r1/ajustement': ok(DRAFT) });
    await t.open();
    t.input('avis-bas').value = '175 000 €';
    await t.click(t.byText('Enregistrer'));
    expect(t.calls.find((c) => c.url.endsWith('/ajustement'))?.body).toEqual({ low: 175000 });
    t.calls.length = 0;
    t.input('avis-bas').value = 'cent mille';
    await t.click(t.byText('Enregistrer'));
    expect(t.state()).toBe('La fourchette s’écrit en euros, en chiffres seulement.');
    expect(t.calls).toEqual([]);
  });

  it('une réponse tardive ne redessine pas un écran quitté ; le retour efface tout', async () => {
    let release: (r: Response) => void = () => {};
    const t = await run({ 'GET /v1/biens/b1/avis': () => new Promise<Response>((r) => { release = r; }) });
    await t.open();
    await t.click(t.els['avis-retour']);
    release(Response.json({ ok: true, data: [DRAFT] }));
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
  });

  it('[R46] après la sortie, rien de l’avis ne reste à l’écran', async () => {
    const t = await run({ 'GET /v1/biens/b1/avis': ok([DRAFT]) });
    await t.open();
    expect(t.body().children.length).toBeGreaterThan(0);
    await t.click(t.els.sortir);
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
  });

  it('[R16] un bien hors de ses droits est dit, et le texte reçu reste du texte', async () => {
    const t = await run({ 'GET /v1/biens/b1/avis': no(403, 'not_assigned') });
    await t.open();
    expect(t.state()).toBe('Ce bien n’est pas dans vos droits.');
    expect(AVIS_SCRIPT).not.toContain('innerHTML');
  });
});

describe('AU105 · une correction de l’avis non enregistrée se retrouve, ou s’abandonne en le disant', () => {
  const answers = () => ({ 'GET /v1/biens/b1/avis': ok([DRAFT]), 'POST /v1/avis/r1/ajustement': ok({ ...DRAFT, text: 'Texte corrigé' }) });
  it('[R276] saisie, écran quitté, application fermée puis rouverte : la correction revient, et part à l’enregistrement', async () => {
    const t = await run(answers());
    await t.open();
    const text = t.input('avis-texte');
    text.value = 'Texte corrigé';
    text.listeners.input!({});
    const kept = t.storage.get('aimmo.brouillons')!;
    expect(JSON.parse(kept)['avis:r1']).toMatchObject({ value: { text: 'Texte corrigé', updatedAt: DRAFT.updatedAt } });
    const again = await run(answers(), { 'aimmo.brouillons': kept });
    await again.open();
    expect(again.input('avis-texte').value).toBe(DRAFT.text);
    expect(again.body().textContent).toContain('Une correction de cet avis n’a pas été enregistrée sur cet appareil.');
    await again.click(again.byText('Reprendre la correction'));
    expect(again.input('avis-texte').value).toBe('Texte corrigé');
    await again.click(again.byText('Enregistrer'));
    expect(again.calls.filter((c) => c.method === 'POST').at(-1)).toMatchObject({ url: '/v1/avis/r1/ajustement', body: { text: 'Texte corrigé' } });
    expect(JSON.parse(again.storage.get('aimmo.brouillons')!)).toEqual({});
  });

  it('[R276] l’avis validé depuis un autre appareil : la correction gardée reste lisible jusqu’à son abandon', async () => {
    const kept = JSON.stringify({ 'avis:r1': { at: 'x', value: { updatedAt: DRAFT.updatedAt, low: '180000', high: '210000', text: 'Texte corrigé ici' } } });
    const t = await run({ 'GET /v1/biens/b1/avis': ok([{ ...DRAFT, status: 'validated', validatedAt: '2026-11-03T08:00:00.000Z' }]) }, { 'aimmo.brouillons': kept });
    await t.open();
    expect(t.body().textContent).toContain('l’avis a été validé depuis');
    expect(t.body().textContent).toContain('Texte corrigé ici');
    await t.click(t.byText('Abandonner la correction'));
    expect(t.body().textContent).not.toContain('Texte corrigé ici');
    expect(JSON.parse(t.storage.get('aimmo.brouillons')!)).toEqual({});
  });

  it('[R276] un appareil qui ne peut pas garder la correction le dit tout de suite', async () => {
    const t = await run(answers(), { 'aimmo.brouillons': '{}' });
    await t.open();
    t.storage.set = () => { throw new Error('plein'); };
    const text = t.input('avis-texte');
    text.value = 'Autre';
    text.listeners.input!({});
    expect(t.state()).toBe('Cet appareil ne peut pas garder cette correction : enregistrez-la avant de quitter l’écran.');
  });

  it('[R276] abandonner la correction la retire de l’appareil ; l’avis rangé reste tel quel', async () => {
    const t = await run(answers());
    await t.open();
    const text = t.input('avis-texte');
    text.value = 'Autre';
    text.listeners.input!({});
    const again = await run(answers(), { 'aimmo.brouillons': t.storage.get('aimmo.brouillons')! });
    await again.open();
    await again.click(again.byText('Abandonner la correction'));
    expect(again.body().textContent).not.toContain('n’a pas été enregistrée');
    expect(again.input('avis-texte').value).toBe(DRAFT.text);
    expect(JSON.parse(again.storage.get('aimmo.brouillons')!)).toEqual({});
  });
});

