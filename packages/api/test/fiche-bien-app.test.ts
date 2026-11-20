import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { FICHE_BIEN_SCRIPT } from '../app/fiche-bien.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : bien, fiche, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const MEDIA = [{ ref: 'biens/b1/0b6f1d2e-3333-4a2b-8c3d-000000000001.jpg', kind: 'photo', edit: 'aucune' }];
const SHEET = {
  characteristics: { bedrooms: 2, floor: 0, floorsTotal: 3, buildYear: 1975, heating: 'collectif', outdoor: ['balcon'], landM2: null, parkingSpaces: 0, elevator: false },
  energy: { energyClass: 'D', climateClass: 'C', annualCostMinEur: 900, annualCostMaxEur: 1300, costReferenceYear: 2025, diagnosedOn: '2026-05-04' },
  coownership: { isCoownership: true, lots: 12, annualChargesEur: 0, proceedings: false },
  risks: { inRiskZone: false },
  media: MEDIA,
};
const CHECK = { complete: false, publishedPriceEur: null, text: '', items: [] };
const DRAFT = { id: 'd1', title: 'Appartement', body: 'Appartement.', sentences: [], sheetVersion: 4, validated: null };
const GET = 'GET /v1/annonces/b1/fiche';
const POST = 'POST /v1/annonces/b1/fiche?siVersion=4';
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: { method: string; url: string; body?: any }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
    'GET /v1/plan-du-jour': ok(null),
    'GET /v1/contacts-chauds': ok({ contacts: [] }),
    'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
    'GET /v1/usage/matin': ok(null),
    'GET /v1/annonces': ok([{ id: 'b1', reference: 'REF-T-1', city: 'Dijon', state: null }]),
    'GET /v1/annonces/b1/controle': ok(CHECK),
    'GET /v1/annonces/b1/brouillon': ok(DRAFT),
    'GET /v1/annonces/b1/publication': ok(null),
    [GET]: ok({ propertyId: 'b1', version: 4, sheet: SHEET }),
    ...answers,
  };
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push(init.body ? { method, url, body: JSON.parse(init.body) } : { method, url });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['vente-corps']!;
  const find = (text: string) => body().all().find((e: FakeElement) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const f = (id: string) => body().all().find((e: FakeElement) => e.attributes.id === id)!;
  const posts = () => calls.filter((c) => c.method === 'POST');
  const open = async () => {
    await click(els.biens!.all().find((e: FakeElement) => e.textContent === 'Mettre en vente'));
    await click(find('Remplir la fiche du bien'));
    const s = body().all().filter((e: FakeElement) => e.tagName === 'script');
    if (s.length === 1) {
      runInNewContext(FICHE_BIEN_SCRIPT, context);
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const save = () => click(find('Enregistrer la fiche'));
  return { els, calls, table, context, body, find, click, f, posts, open, save };
}

describe('X19 · la fiche du bien à l’écran', () => {
  it('AU114 · une lecture ratée des légendes est dite, avec « Réessayer » ; jamais confondue avec un bien sans photo', async () => {
    const t = await run();
    await t.open();
    expect(t.body().textContent).toContain('Pas de réseau : ce que montre chaque photo n’a pas pu être lu.');
    t.table['GET /v1/annonces/b1/photos/sujets'] = ok({ photos: [{ ref: MEDIA[0]!.ref, subject: 'cuisine' }], allowed: ['cuisine'] });
    await t.click(t.find('Réessayer'));
    expect(t.body().textContent).not.toContain('n’a pas pu être lu');
    expect(t.f('fiche-bien-photo-1').value).toBe('cuisine');
  });

  it('AU114 · chaque photo se dit, dans ce que la fiche porte ; le choix part tout de suite, et « je ne sais pas » le retire', async () => {
    const ref = MEDIA[0]!.ref;
    const t = await run({
      'GET /v1/annonces/b1/photos/sujets': ok({ photos: [{ ref, subject: null }], allowed: ['piece_principale', 'chambre', 'cuisine', 'balcon'] }),
      'POST /v1/annonces/b1/photos/sujet': ok(null),
    });
    await t.open();
    const s = t.f('fiche-bien-photo-1');
    expect(s.all().filter((e: FakeElement) => e.tagName === 'option').map((e: FakeElement) => e.textContent)).toEqual(['Je ne sais pas encore', 'Une pièce principale', 'Une chambre', 'La cuisine', 'Le balcon']);
    s.value = 'cuisine';
    s.listeners.change!({});
    await new Promise((r) => setTimeout(r, 0));
    s.value = '';
    s.listeners.change!({});
    await new Promise((r) => setTimeout(r, 0));
    expect(t.posts().map((p) => p.body)).toEqual([{ ref, subject: 'cuisine' }, { ref, subject: null }]);
  });

  it('[R51] la dernière version est pré-remplie, 0 reste 0, et les photos repartent telles quelles sur la version lue', async () => {
    const t = await run({ [POST]: ok({ version: 5 }) });
    await t.open();
    expect(t.f('fiche-bien-floor').value).toBe('0');
    expect(t.f('fiche-bien-parkingSpaces').value).toBe('0');
    expect(t.f('fiche-bien-landM2').value).toBe('');
    expect(t.f('fiche-bien-chauffage').value).toBe('collectif');
    expect(t.f('fiche-bien-ascenseur').value).toBe('non');
    expect(t.f('fiche-bien-ext-balcon').checked).toBe(true);
    expect(t.f('fiche-bien-charges').value).toBe('0');
    expect(t.f('fiche-bien-risques').value).toBe('non');
    expect(t.body().textContent).toContain('1 photo ou vidéo rangée reste sur la fiche.');
    t.f('fiche-bien-bedrooms').value = '3';
    // AU070 · maison ou appartement se dit sur la fiche et part avec elle.
    expect(t.f('fiche-bien-logement').value).toBe('');
    t.f('fiche-bien-logement').value = 'apartment';
    await t.save();
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/annonces/b1/fiche?siVersion=4', body: { ...SHEET, characteristics: { ...SHEET.characteristics, bedrooms: 3, dwelling: 'apartment' } } }]);
    expect(t.els['vente-etat']!.textContent).toContain('Fiche rangée, version 5.');
    expect(t.calls.at(-1)!.url).toBe('/v1/annonces/b1/publication');
  });

  it('AU065 · les années des prix, telles que le diagnostic les écrit, partent avec la dernière pour année des prix', async () => {
    const t = await run({ [POST]: ok({ version: 5 }) });
    await t.open();
    expect(t.f('fiche-bien-cout-annee').value).toBe('2025');
    t.f('fiche-bien-cout-annee').value = '2021, 2022 et 2023';
    await t.save();
    expect(t.posts()[0]!.body.energy).toEqual({ ...SHEET.energy, costReferenceYear: 2023, costReferenceYears: [2021, 2022, 2023] });
  });

  it('AU061 · les équipements et l’état du bien se cochent et partent avec la fiche ; rien coché, rien rangé', async () => {
    const t = await run({ [POST]: ok({ version: 5 }) });
    await t.open();
    t.f('fiche-bien-equip-piscine').checked = true;
    t.f('fiche-bien-equip-cheminee').checked = true;
    t.f('fiche-bien-etat').value = 'travaux_a_prevoir';
    await t.save();
    expect(t.posts()[0]!.body.characteristics).toEqual({ ...SHEET.characteristics, amenities: ['piscine', 'cheminee'], condition: 'travaux_a_prevoir' });
  });

  it('AU063 · surfaces Carrez et utile, avec la virgule, et la source de chaque surface partent avec la fiche', async () => {
    const t = await run({ [POST]: ok({ version: 5 }) });
    await t.open();
    t.f('fiche-bien-carrez').value = '61,35';
    t.f('fiche-bien-source-carrez').value = 'mesurage';
    t.f('fiche-bien-source-habitable').value = 'acte';
    await t.save();
    expect(t.posts()[0]!.body.characteristics).toEqual({ ...SHEET.characteristics, carrezM2: 61.35, surfaceSources: { habitable: 'acte', carrez: 'mesurage' } });
    // Une surface mal écrite n'est jamais rangée comme « je ne sais pas ».
    const bad = await run({ [POST]: ok({ version: 5 }) });
    await bad.open();
    bad.f('fiche-bien-utile').value = '70,555';
    await bad.save();
    expect(bad.posts()).toEqual([]);
  });

  it('sans fiche : un formulaire vide à la version 0, où un champ vide reste « je ne sais pas »', async () => {
    const t = await run({ [GET]: no(404, { ok: false, rule: null, code: 'no_sheet' }), 'POST /v1/annonces/b1/fiche?siVersion=0': ok({ version: 1 }) });
    await t.open();
    t.f('fiche-bien-copro').value = 'non';
    await t.save();
    expect(t.posts()[0]).toEqual({
      method: 'POST',
      url: '/v1/annonces/b1/fiche?siVersion=0',
      body: { characteristics: { bedrooms: null, floor: null, floorsTotal: null, buildYear: null, heating: null, outdoor: [], landM2: null, parkingSpaces: null, elevator: null }, energy: null, coownership: { isCoownership: false }, risks: null, media: [] },
    });
  });

  it('[R10] un nombre mal écrit est nommé et ne part pas : jamais rangé comme « je ne sais pas »', async () => {
    const t = await run({ [POST]: ok({ version: 5 }) });
    await t.open();
    t.f('fiche-bien-bedrooms').value = 'deux';
    await t.save();
    expect(t.posts()).toEqual([]);
    expect(t.body().textContent).toContain('À vérifier : Chambres');
    t.f('fiche-bien-bedrooms').value = '2';
    t.f('fiche-bien-charges').value = '12,5';
    await t.save();
    expect(t.posts()).toEqual([]);
    expect(t.body().textContent).toContain('À vérifier : Charges annuelles');
  });

  it('[R47] sans changement, aucune version : une version de plus ferait tomber l’annonce validée', async () => {
    const t = await run({ [POST]: ok({ version: 5 }) });
    await t.open();
    await t.save();
    expect(t.posts()).toEqual([]);
    expect(t.body().textContent).toContain('Rien n’a changé : aucune version ajoutée.');
  });

  it('[R47] sur une annonce validée, le retrait est dit avant d’enregistrer ; sinon, rien', async () => {
    const validated = await run({ 'GET /v1/annonces/b1/brouillon': ok({ ...DRAFT, validated: { at: '2027-02-12T11:00:00.000Z' } }) });
    await validated.open();
    expect(validated.body().textContent).toContain('l’annonce est retirée de tous les canaux');
    const draft = await run();
    await draft.open();
    expect(draft.body().textContent).not.toContain('retirée de tous les canaux');
  });

  it('un refus du socle nomme le champ en français, et ce qui est saisi reste', async () => {
    const t = await run({ [POST]: no(400, { ok: false, rule: null, code: 'invalid', field: 'energy.diagnosedOn' }) });
    await t.open();
    t.f('fiche-bien-bedrooms').value = '5';
    await t.save();
    expect(t.body().textContent).toContain('À vérifier : Jour du diagnostic, jamais dans le futur.');
    expect(t.body().textContent).not.toContain('energy.diagnosedOn');
    expect(t.f('fiche-bien-bedrooms').value).toBe('5');
  });

  it('une fiche changée entre-temps n’écrase rien : c’est dit', async () => {
    const t = await run({ [POST]: no(400, { ok: false, rule: null, code: 'stale' }) });
    await t.open();
    t.f('fiche-bien-bedrooms').value = '5';
    await t.save();
    expect(t.body().textContent).toContain('La fiche a changé entre-temps, rien n’est rangé');
  });

  it('[R47] une annonce validée sur une ancienne fiche n’est plus dite validée : l’écran dit quoi faire', async () => {
    const t = await run({ 'GET /v1/annonces/b1/brouillon': ok({ ...DRAFT, sheetVersion: 3, validated: { at: '2027-02-12T11:00:00.000Z' } }) });
    await t.open();
    const text = t.body().textContent;
    expect(text).toContain('La fiche du bien a changé depuis la validation de ce texte : l’annonce ne peut plus partir.');
    expect(text).not.toContain('Annonce validée le');
    expect(text).not.toContain('Cette annonce est validée.');
    const same = await run({ 'GET /v1/annonces/b1/brouillon': ok({ ...DRAFT, validated: { at: '2027-02-12T11:00:00.000Z' } }) });
    await same.open();
    expect(same.body().textContent).toContain('Annonce validée le');
    expect(same.body().textContent).not.toContain('La fiche du bien a changé');
  });

  it('une lecture ratée de la fiche ne dit pas que la validation est tombée', async () => {
    const t = await run({ 'GET /v1/annonces/b1/brouillon': ok({ ...DRAFT, sheetVersion: 3, validated: { at: '2027-02-12T11:00:00.000Z' } }), [GET]: no(500, { ok: false, code: 'internal_error' }) });
    await t.click(t.els.biens!.all().find((e: FakeElement) => e.textContent === 'Mettre en vente'));
    expect(t.body().textContent).toContain('Annonce validée le');
    expect(t.body().textContent).not.toContain('La fiche du bien a changé');
  });

  it('des lots ou des charges sans « oui » ne se perdent pas : c’est dit, et rien ne part', async () => {
    const t = await run({ [GET]: no(404, { ok: false, rule: null, code: 'no_sheet' }), 'POST /v1/annonces/b1/fiche?siVersion=0': ok({ version: 1 }) });
    await t.open();
    t.f('fiche-bien-lots').value = '12';
    await t.save();
    expect(t.posts()).toEqual([]);
    expect(t.body().textContent).toContain('vont avec « en copropriété : oui »');
    t.f('fiche-bien-copro').value = 'oui';
    t.f('fiche-bien-charges').value = '1800';
    t.f('fiche-bien-procedure').value = 'non';
    await t.save();
    expect(t.posts()[0]!.body.coownership).toEqual({ isCoownership: true, lots: 12, annualChargesEur: 1800, proceedings: false });
  });

  it('le script se charge une fois, un échec se réessaie, et une lecture ratée laisse le bouton', async () => {
    const t = await run({ [GET]: () => Promise.reject(new TypeError('hors ligne')) });
    await t.click(t.els.biens!.all().find((e: FakeElement) => e.textContent === 'Mettre en vente'));
    const open = t.find('Remplir la fiche du bien')!;
    await t.click(open);
    await t.click(open);
    const scripts = () => t.body().all().filter((e: FakeElement) => e.tagName === 'script');
    expect(scripts().length).toBe(1);
    scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.body().textContent).toContain('Pas de réseau.');
    await t.click(open);
    runInNewContext(FICHE_BIEN_SCRIPT, t.context);
    scripts()[0]!.listeners.load!({});
    await settle();
    expect(open.hidden).toBe(false);
    expect(t.find('Enregistrer la fiche')).toBeUndefined();
    t.table[GET] = ok({ propertyId: 'b1', version: 4, sheet: SHEET });
    await t.click(open);
    expect(scripts().length).toBe(0);
    expect(t.find('Enregistrer la fiche')).toBeDefined();
    expect(open.hidden).toBe(true);
  });

  it('un script abîmé est dit', async () => {
    const t = await run();
    await t.click(t.els.biens!.all().find((e: FakeElement) => e.textContent === 'Mettre en vente'));
    await t.click(t.find('Remplir la fiche du bien'));
    t.body().all().find((e: FakeElement) => e.tagName === 'script')!.listeners.load!({});
    await settle();
    expect(t.body().textContent).toContain('La fiche n’a pas pu se charger.');
  });

  it('[R16] un droit refusé est dit, à la lecture comme à l’écriture', async () => {
    const read = await run({ [GET]: no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await read.open();
    expect(read.body().textContent).toContain('Ce bien n’est pas dans vos droits.');
    expect(read.find('Enregistrer la fiche')).toBeUndefined();
    const write = await run({ [POST]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await write.open();
    write.f('fiche-bien-bedrooms').value = '5';
    await write.save();
    expect(write.body().textContent).toContain('Ce bien n’est pas dans vos droits.');
  });

  it('une lecture ratée n’ouvre jamais un formulaire vide qui effacerait la fiche', async () => {
    const down = await run({ [GET]: no(500, { ok: false, code: 'internal_error' }) });
    await down.open();
    expect(down.find('Enregistrer la fiche')).toBeUndefined();
    expect(down.body().textContent).toContain('La fiche n’a pas pu être lue.');
    const off = await run({ [GET]: () => Promise.reject(new TypeError('hors ligne')) });
    await off.open();
    expect(off.find('Enregistrer la fiche')).toBeUndefined();
    expect(off.body().textContent).toContain('Pas de réseau.');
  });

  it.each([
    ['hors ligne', () => Promise.reject(new TypeError('hors ligne'))],
    ['une panne', async () => Response.json({ ok: false, code: 'internal_error' }, { status: 500 })],
    ['un succès coupé', async () => new Response('{"ok":tr', { status: 200 })],
  ] as [string, Answer][])('réponse perdue (%s) : dite telle, ce qui est saisi reste', async (_n, answer) => {
    const t = await run({ [POST]: answer });
    await t.open();
    t.f('fiche-bien-bedrooms').value = '5';
    await t.save();
    expect(t.body().textContent).toContain('la fiche a peut-être été rangée');
    expect(t.f('fiche-bien-bedrooms').value).toBe('5');
  });

  it('un seul envoi à la fois, et aucun autre geste de l’écran pendant ce temps', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = await run({ [POST]: () => new Promise<Response>((r) => { release = r; }), 'POST /v1/annonces/brouillons/d1/validation': ok(DRAFT) });
    await t.open();
    t.f('fiche-bien-bedrooms').value = '5';
    await t.save();
    await t.save();
    await t.click(t.find('Valider l’annonce'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/annonces/b1/fiche?siVersion=4']);
    expect(t.els['vente-etat']!.textContent).toBe('Un envoi part : patientez un instant.');
    release(Response.json({ ok: false, rule: null, code: 'busy' }, { status: 400 }));
    await settle();
    expect(t.body().textContent).toContain('Un enregistrement est déjà en cours');
  });

  it('[R201] le script est à part et l’application reste dans son budget', () => {
    expect(AGENT_APP_FILES['/app/fiche-bien.js']).toBe(FICHE_BIEN_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/fiche-bien.js');
    expect(budgetProblems({ html: '', js: FICHE_BIEN_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });
});
