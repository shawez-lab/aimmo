import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds, placeTool } from './fake-dom.ts';

// Tout est inventé : bien, annonce, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const CHECK = {
  complete: false,
  publishedPriceEur: 210000,
  text: '',
  items: [
    { id: 'prix', status: 'presente', text: '210 000 € honoraires inclus' },
    { id: 'energie', status: 'manquante', reason: 'pas_de_diagnostic' },
    { id: 'copropriete', status: 'sans_objet' },
  ],
};
const DRAFT = {
  id: 'd2',
  propertyId: 'b1',
  seq: 2,
  title: 'Appartement lumineux à Dijon',
  body: '',
  origin: 'secours',
  sheetVersion: 1,
  sentences: [
    { text: `Appartement de 62 m² ${INJECTED}.`, sources: [{ field: 'surfaceM2', value: '62 m²' }], problems: [] },
    { text: 'Proche de la gare.', sources: [], problems: [{ code: 'fait_sans_source', value: 'gare' }] },
  ],
  createdBy: 'agent:a1',
  createdAt: '2027-02-12T10:00:00.000Z',
  validated: null,
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([{ id: 'b1', reference: 'REF-T-1', city: 'Dijon', state: null, kind: 'home', rooms: 3, dwelling: 'apartment' }]),
  'GET /v1/annonces/b1/controle': ok(CHECK),
  'GET /v1/annonces/b1/brouillon': ok(DRAFT),
  'GET /v1/annonces/b1/publication': ok(null),
};
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push(init.body ? { method, url, body: JSON.parse(init.body) } : { method, url });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const byText = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  return { els, calls, table, byText, click, storage };
}

describe('P10 · écran « Mettre en vente »', () => {
  it('depuis la journée : la liste de contrôle, l’annonce phrase par phrase avec la source de chaque nombre, et la validation', async () => {
    const t = await run();
    // DS013, DS023, DS041 · dans la journée, le bien tient en une ligne, entière à toucher : ce qu'il est, puis sa référence et son état.
    expect(t.els.biens!.children.map((li) => li.textContent)).toEqual(['Appartement 3 pièces · DijonRéf. REF-T-1, pas encore publiée.']);
    expect(t.els.biens!.all().filter((e) => e.tagName === 'button')).toHaveLength(1);
    const tool = placeTool(t.els, 'Mettre en vente');
    // L'écran du bien : son nom en titre, sa référence et son état, et ses outils en rangées.
    expect(t.els['un-bien']!.hidden).toBe(false);
    expect(t.els['un-bien-titre']!.textContent).toBe('Appartement 3 pièces · Dijon');
    expect(t.els['un-bien-etat']!.textContent).toBe('Réf. REF-T-1, pas encore publiée.');
    expect(tool.textContent).toBe('Mettre en vente');
    await t.click(tool);
    expect(t.els.vente!.hidden).toBe(false);
    expect(t.els['vente-titre']!.textContent).toBe('Mettre en vente · REF-T-1');
    const text = t.els['vente-corps']!.textContent;
    expect(text).toContain('Il manque des mentions : l’annonce ne peut pas partir.');
    expect(text).toContain('Prix et honoraires : présente');
    expect(text).toContain('Performance énergétique : manque, absent');
    expect(text).toContain('Copropriété : sans objet');
    expect(text).toContain('62 m² : surface, lu dans la fiche du bien');
    expect(text).toContain('À corriger : fait absent de la fiche (« gare »)');
    expect(text).toContain(INJECTED);
    expect(text).not.toMatch(/pas_de_diagnostic|fait_sans_source|surfaceM2|sans_objet/);
    expect(text).toContain('Pas encore publiée : elle part d’elle-même au passage suivant');
    t.table['POST /v1/annonces/brouillons/d2/validation'] = no(409, { ok: false, rule: 'R43', code: 'mentions_incomplete', missing: [] });
    await t.click(t.byText(t.els['vente-corps']!, 'Valider l’annonce'));
    expect(t.calls.at(-1)).toEqual({ method: 'POST', url: '/v1/annonces/brouillons/d2/validation' });
    expect(t.els['vente-etat']!.textContent).toBe('Il manque des mentions obligatoires : complétez la fiche du bien.');
  });

  it('sans annonce : « Rédiger l’annonce » ; publiée : la version, le prix et chaque canal', async () => {
    const t = await run({ 'GET /v1/annonces/b1/brouillon': no(404, { ok: false, rule: null, code: 'no_draft' }) });
    await t.click(placeTool(t.els, 'Mettre en vente'));
    expect(t.els['vente-corps']!.textContent).toContain('Aucune annonce rédigée pour ce bien.');
    t.table['POST /v1/annonces/b1/brouillon'] = ok({ ...DRAFT, validated: null });
    t.table['GET /v1/annonces/b1/brouillon'] = ok({ ...DRAFT, validated: { by: 'agent:a1', at: '2027-02-12T10:05:00.000Z' } });
    t.table['GET /v1/annonces/b1/publication'] = ok({ version: 1, state: 'en_vente', priceEur: 210000, channels: { site: 'publiee', reseaux: 'en_attente', google: 'echec', portails: 'publiee' } });
    await t.click(t.byText(t.els['vente-corps']!, 'Rédiger l’annonce'));
    const text = t.els['vente-corps']!.textContent;
    expect(text).toContain('Annonce validée le 12/02/2027.');
    expect(text).toContain('Version 1, en vente');
    expect(text).toContain('réseaux sociaux : en attente');
    expect(text).toContain('fiche Google : en échec, reprise au passage suivant');
    expect(t.byText(t.els['vente-corps']!, 'Valider l’annonce')).toBeUndefined();
  });

  it('une lecture en échec n’est jamais montrée comme un état vide, et aucun geste n’est proposé dessus', async () => {
    const t = await run({ 'GET /v1/annonces/b1/brouillon': no(500, { ok: false, code: 'internal_error' }), 'GET /v1/annonces/b1/publication': () => Promise.reject(new TypeError('hors ligne')) });
    await t.click(placeTool(t.els, 'Mettre en vente'));
    const text = t.els['vente-corps']!.textContent;
    expect(text).toContain('L’annonce n’a pas pu être lue.');
    expect(text).toContain('L’état de la publication n’a pas pu être lu.');
    expect(text).not.toMatch(/Aucune annonce rédigée|Pas encore publiée/);
    expect(t.byText(t.els['vente-corps']!, 'Rédiger l’annonce')).toBeUndefined();
  });

  it('[R16] un bien hors des droits est dit ; une clé refusée efface tout', async () => {
    const denied = await run({ 'GET /v1/annonces/b1/controle': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await denied.click(placeTool(denied.els, 'Mettre en vente'));
    expect(denied.els['vente-etat']!.textContent).toBe('Ce bien n’est pas dans vos droits.');
    const refused = await run({ 'GET /v1/annonces/b1/controle': no(401, { ok: false, code: 'unauthorized' }) });
    await refused.click(placeTool(refused.els, 'Mettre en vente'));
    expect(refused.els.connexion!.hidden).toBe(false);
    expect(refused.storage.has('aimmo.cle')).toBe(false);
    expect(refused.els['vente-corps']!.children).toEqual([]);
  });
});

describe('X18 · corriger le texte de l’annonce à l’écran', () => {
  const FULL = { ...DRAFT, body: 'Appartement de 62 m².' };
  const POST = 'POST /v1/annonces/b1/correction';
  const open = async (answers: Record<string, Answer> = {}) => {
    const t = await run({ 'GET /v1/annonces/b1/brouillon': ok(FULL), ...answers });
    await t.click(placeTool(t.els, 'Mettre en vente'));
    await t.click(t.byText(t.els['vente-corps']!, 'Corriger le texte'));
    const inside = (id: string) => t.els['vente-corps']!.all().find((e) => e.attributes.id === id)!;
    const send = () => t.click(t.byText(t.els['vente-corps']!, 'Enregistrer la correction'));
    const posts = () => t.calls.filter((c) => c.method === 'POST');
    return { ...t, inside, send, posts };
  };

  it('le texte en cours est pré-rempli et part tel que tapé ; rangée, l’annonce est relue', async () => {
    const t = await open({ [POST]: ok({ ...FULL, id: 'd3' }) });
    expect(t.inside('vente-correction-titre').value).toBe('Appartement lumineux à Dijon');
    expect(t.inside('vente-correction-texte').value).toBe('Appartement de 62 m².');
    t.inside('vente-correction-texte').value = 'Appartement de 62 m² au calme.';
    const before = t.calls.length;
    await t.send();
    expect(t.calls[before]).toEqual({ method: 'POST', url: '/v1/annonces/b1/correction', body: { title: 'Appartement lumineux à Dijon', body: 'Appartement de 62 m² au calme.' } });
    expect(t.calls.slice(before + 1).map((c) => c.url)).toEqual(['/v1/annonces/b1/controle', '/v1/annonces/b1/brouillon', '/v1/annonces/b1/publication']);
    expect(t.els['vente-etat']!.textContent).toBe('Correction rangée : l’agent du bien la relit, puis la valide.');
  });

  it('sans texte dans le brouillon, les phrases servent de départ', async () => {
    const t = await open({ 'GET /v1/annonces/b1/brouillon': ok(DRAFT) });
    expect(t.inside('vente-correction-texte').value).toBe(`Appartement de 62 m² ${INJECTED}. Proche de la gare.`);
  });

  it('[R47] refusée : chaque phrase en cause et son problème, sans code technique, et ce qui est tapé reste', async () => {
    const t = await open({ [POST]: no(409, { ok: false, rule: 'R47', code: 'refused_text', sentences: [{ text: `Avec piscine ${INJECTED}.`, sources: [], problems: [{ code: 'fait_sans_source', value: 'piscine' }] }] }) });
    t.inside('vente-correction-texte').value = `Avec piscine ${INJECTED}.`;
    await t.send();
    const text = t.els['vente-corps']!.textContent;
    expect(text).toContain('Une phrase n’est pas reliée à la fiche : corrigez-la.');
    expect(text).toContain('À corriger : fait absent de la fiche (« piscine »)');
    expect(text).toContain(INJECTED);
    expect(text).not.toMatch(/refused_text|fait_sans_source/);
    expect(t.inside('vente-correction-texte').value).toBe(`Avec piscine ${INJECTED}.`);
    expect(t.posts().length).toBe(1);
  });

  it('un titre ou un texte vide ne part pas', async () => {
    const t = await open({ [POST]: ok(FULL) });
    t.inside('vente-correction-texte').value = '   ';
    await t.send();
    expect(t.posts()).toEqual([]);
    expect(t.els['vente-corps']!.textContent).toContain('Le titre et le texte sont à remplir.');
  });

  it('[R16] un droit refusé est dit, et le texte reste', async () => {
    const t = await open({ [POST]: no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    t.inside('vente-correction-texte').value = 'Mon texte.';
    await t.send();
    expect(t.els['vente-corps']!.textContent).toContain('Ce bien n’est pas dans vos droits.');
    expect(t.inside('vente-correction-texte').value).toBe('Mon texte.');
  });

  it('une réponse perdue est dite telle, sans prétendre que rien n’est fait, et le texte reste', async () => {
    const t = await open();
    t.inside('vente-correction-texte').value = 'Mon texte.';
    await t.send();
    expect(t.els['vente-corps']!.textContent).toContain('la correction a peut-être été rangée');
    expect(t.inside('vente-correction-texte').value).toBe('Mon texte.');
  });

  it('un seul envoi à la fois', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = await open({ [POST]: () => new Promise<Response>((r) => { release = r; }) });
    const go = t.byText(t.els['vente-corps']!, 'Enregistrer la correction')!;
    go.listeners.click!({});
    go.listeners.click!({});
    await settle();
    expect(t.posts().length).toBe(1);
    release(Response.json({ ok: false, rule: null, code: 'busy' }, { status: 400 }));
    await settle();
    expect(t.els['vente-corps']!.textContent).toContain('Une rédaction est déjà en cours');
    expect((go as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it('une réponse arrivée après avoir quitté l’écran ne ramène pas dessus', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = await open({ [POST]: () => new Promise<Response>((r) => { release = r; }) });
    await t.click(t.byText(t.els['vente-corps']!, 'Enregistrer la correction'));
    t.els.vente!.hidden = true;
    const before = t.calls.length;
    release(Response.json({ ok: true, mode: 'essai', data: FULL }));
    await settle();
    expect(t.calls.length).toBe(before);
    expect(t.els.vente!.hidden).toBe(true);
  });

  it.each([
    ['une panne du serveur', async () => Response.json({ ok: false, code: 'internal_error' }, { status: 500 })],
    ['une passerelle sans corps lisible', async () => new Response('<html>', { status: 502 })],
    ['un succès coupé pendant sa lecture', async () => new Response('{"ok":tr', { status: 200 })],
  ])('%s n’est jamais dite « non rangée » : le texte a pu partir', async (_name, answer) => {
    const t = await open({ [POST]: answer });
    t.inside('vente-correction-texte').value = 'Mon texte.';
    await t.send();
    const text = t.els['vente-corps']!.textContent;
    expect(text).toContain('la correction a peut-être été rangée');
    expect(text).not.toContain('n’a pas pu être rangée');
    expect(t.inside('vente-correction-texte').value).toBe('Mon texte.');
  });

  it('[R47] sur une annonce validée, AU066 : il est dit avant d’enregistrer que l’annonce en ligne y reste ; sur un brouillon, rien', async () => {
    const validated = await open({ 'GET /v1/annonces/b1/brouillon': ok({ ...FULL, validated: { at: '2027-02-12T11:00:00.000Z' } }) });
    expect(validated.els['vente-corps']!.textContent).toContain('l’annonce en ligne y reste');
    expect(validated.els['vente-corps']!.textContent).not.toContain('retirée');
    const draft = await open();
    expect(draft.els['vente-corps']!.textContent).not.toContain('l’annonce en ligne y reste');
  });

  it('pendant l’envoi, ni valider, ni rédiger, ni rouvrir : le formulaire reste et le refus arrive bien', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = await open({ [POST]: () => new Promise<Response>((r) => { release = r; }), 'POST /v1/annonces/brouillons/d2/validation': ok(FULL), 'POST /v1/annonces/b1/brouillon': ok(FULL) });
    t.inside('vente-correction-texte').value = 'Avec piscine.';
    await t.click(t.byText(t.els['vente-corps']!, 'Enregistrer la correction'));
    await t.click(t.byText(t.els['vente-corps']!, 'Valider l’annonce'));
    await t.click(t.byText(t.els['vente-corps']!, 'Rédiger de nouveau'));
    await t.click(placeTool(t.els, 'Mettre en vente'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/annonces/b1/correction']);
    expect(t.els['vente-etat']!.textContent).toBe('Un envoi part : patientez un instant.');
    release(Response.json({ ok: false, rule: 'R47', code: 'refused_text', sentences: [{ text: 'Avec piscine.', sources: [], problems: [{ code: 'fait_sans_source', value: 'piscine' }] }] }, { status: 409 }));
    await settle();
    expect(t.els['vente-corps']!.textContent).toContain('À corriger : fait absent de la fiche (« piscine »)');
    expect(t.inside('vente-correction-texte').value).toBe('Avec piscine.');
    await t.click(t.byText(t.els['vente-corps']!, 'Valider l’annonce'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/annonces/b1/correction', '/v1/annonces/brouillons/d2/validation']);
  });
});
