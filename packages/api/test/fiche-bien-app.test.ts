import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { FICHE_BIEN_SCRIPT } from '../app/fiche-bien.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds, placeTool } from './fake-dom.ts';

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

async function run(answers: Record<string, Answer> = {}, kept: Record<string, string> = {}) {
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
  const storage = new Map<string, string>([['aimmo.cle', KEY], ...Object.entries(kept)]);
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
    await click(placeTool(els, 'Mettre en vente'));
    await click(find('Remplir la fiche du bien'));
    const s = body().all().filter((e: FakeElement) => e.tagName === 'script');
    if (s.length === 1) {
      runInNewContext(FICHE_BIEN_SCRIPT, context);
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const save = () => click(find('Enregistrer la fiche'));
  return { els, calls, table, context, body, find, click, f, posts, open, save, storage };
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

  it('AU064 · le numéro ADEME et les valeurs du diagnostic se saisissent une fois et partent avec la fiche', async () => {
    const t = await run({ [POST]: ok({ version: 5 }) });
    await t.open();
    t.f('fiche-bien-dpe-numero').value = ' 2321e0123456j ';
    t.f('fiche-bien-dpe-ep').value = '212';
    t.f('fiche-bien-dpe-ges').value = '41';
    await t.save();
    expect(t.posts()[0]!.body.energy).toEqual({ ...SHEET.energy, ademeNumber: '2321E0123456J', primaryEnergyKwhM2: 212, ghgKgM2: 41 });
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

  it('AU064 · un numéro ADEME saisi seul ouvre le diagnostic : il part et se contrôle, jamais perdu', async () => {
    const t = await run({ [GET]: no(404, { ok: false, rule: null, code: 'no_sheet' }), 'POST /v1/annonces/b1/fiche?siVersion=0': ok({ version: 1 }) });
    await t.open();
    t.f('fiche-bien-dpe-numero').value = '2321E0123456J';
    await t.save();
    // Le diagnostic n'est pas complet : rien ne part, et ce qui manque est dit ; la saisie n'est jamais jetée en silence.
    expect(t.posts()).toEqual([]);
    expect(t.body().textContent).toContain('À vérifier : ');
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
    await t.click(placeTool(t.els, 'Mettre en vente'));
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
    await t.click(placeTool(t.els, 'Mettre en vente'));
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
    await t.click(placeTool(t.els, 'Mettre en vente'));
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

describe('AU105 · une saisie de la fiche du bien non enregistrée se retrouve, ou s’abandonne en le disant', () => {
  const type = (t: Awaited<ReturnType<typeof run>>, id: string, value: string) => {
    const f = t.f(id);
    f.value = value;
    f.listeners.input!({});
  };
  it('[R276] constat : saisie, retour accidentel, fermeture, réouverture : la saisie revient, et part à l’enregistrement', async () => {
    const t = await run();
    await t.open();
    type(t, 'fiche-bien-bedrooms', '3');
    const kept = JSON.parse(t.storage.get('aimmo.brouillons')!);
    expect(Object.keys(kept)).toHaveLength(1);
    expect(Object.values(kept)[0]).toMatchObject({ value: { version: 4, raw: { 'fiche-bien-bedrooms': '3' } } });
    // Revenir à la valeur rangée n'est plus une saisie : le brouillon s'efface.
    type(t, 'fiche-bien-bedrooms', '2');
    expect(JSON.parse(t.storage.get('aimmo.brouillons')!)).toEqual({});
    type(t, 'fiche-bien-bedrooms', '3');

    // L'application est fermée, puis rouverte sur le même appareil.
    const again = await run({ [POST]: ok({ version: 5 }) }, { 'aimmo.brouillons': t.storage.get('aimmo.brouillons')! });
    await again.open();
    expect(again.f('fiche-bien-bedrooms').value).toBe('2');
    expect(again.body().textContent).toContain('Une saisie de cette fiche n’a pas été enregistrée sur cet appareil.');
    await again.click(again.find('Reprendre la saisie'));
    expect(again.f('fiche-bien-bedrooms').value).toBe('3');
    await again.save();
    expect(again.posts().at(-1)).toMatchObject({ url: '/v1/annonces/b1/fiche?siVersion=4', body: { characteristics: { bedrooms: 3 } } });
    expect(JSON.parse(again.storage.get('aimmo.brouillons')!)).toEqual({});
  });

  it('[R276] l’abandon se dit d’un geste : la saisie disparaît, la fiche rangée reste', async () => {
    const t = await run();
    await t.open();
    type(t, 'fiche-bien-bedrooms', '5');
    const again = await run({}, { 'aimmo.brouillons': t.storage.get('aimmo.brouillons')! });
    await again.open();
    await again.click(again.find('Abandonner la saisie'));
    expect(again.body().textContent).not.toContain('n’a pas été enregistrée');
    expect(again.f('fiche-bien-bedrooms').value).toBe('2');
    expect(JSON.parse(again.storage.get('aimmo.brouillons')!)).toEqual({});
    expect(again.posts()).toEqual([]);
  });

  it('[R276] la saisie se garde telle quelle, même pas encore valable : des lots tapés avant « en copropriété », un nombre mal écrit', async () => {
    const SANS = { ...SHEET, coownership: null };
    const t = await run({ [GET]: ok({ propertyId: 'b1', version: 4, sheet: SANS }) });
    await t.open();
    type(t, 'fiche-bien-lots', '8');
    type(t, 'fiche-bien-bedrooms', '3 ch');
    const again = await run({ [GET]: ok({ propertyId: 'b1', version: 4, sheet: SANS }) }, { 'aimmo.brouillons': t.storage.get('aimmo.brouillons')! });
    await again.open();
    await again.click(again.find('Reprendre la saisie'));
    expect(again.f('fiche-bien-lots').value).toBe('8');
    expect(again.f('fiche-bien-bedrooms').value).toBe('3 ch');
  });

  it('[R276] reprise sur une fiche qui a changé : la saisie se pose sur la version lue, ses photos comprises', async () => {
    const t = await run();
    await t.open();
    type(t, 'fiche-bien-bedrooms', '3');
    const MORE = [...MEDIA, { ref: 'biens/b1/0b6f1d2e-3333-4a2b-8c3d-000000000002.jpg', kind: 'photo', edit: 'aucune' }];
    const again = await run({ [GET]: ok({ propertyId: 'b1', version: 5, sheet: { ...SHEET, media: MORE } }), 'POST /v1/annonces/b1/fiche?siVersion=5': ok({ version: 6 }) }, { 'aimmo.brouillons': t.storage.get('aimmo.brouillons')! });
    await again.open();
    expect(again.body().textContent).toContain('la fiche a changé depuis');
    await again.click(again.find('Reprendre la saisie'));
    await again.save();
    expect(again.posts().at(-1)).toMatchObject({ url: '/v1/annonces/b1/fiche?siVersion=5', body: { characteristics: { bedrooms: 3 }, media: MORE } });
  });

  it('[R276] un appareil qui ne peut pas garder la saisie le dit tout de suite', async () => {
    const t = await run();
    await t.open();
    (t.context.localStorage as { setItem: (k: string, v: string) => void }).setItem = () => { throw new Error('plein'); };
    type(t, 'fiche-bien-bedrooms', '3');
    expect(t.body().textContent).toContain('Cet appareil ne peut pas garder cette saisie : enregistrez-la avant de quitter l’écran.');
  });

  it('[R276] tant que la saisie gardée attend un choix, la fiche ne se modifie pas et ne l’efface pas', async () => {
    const t = await run();
    await t.open();
    type(t, 'fiche-bien-bedrooms', '3');
    const kept = t.storage.get('aimmo.brouillons')!;
    const again = await run({}, { 'aimmo.brouillons': kept });
    await again.open();
    expect((again.f('fiche-bien-floor') as FakeElement & { disabled?: boolean }).disabled).toBe(true);
    expect((again.find('Enregistrer la fiche') as FakeElement & { disabled?: boolean }).disabled).toBe(true);
    type(again, 'fiche-bien-floor', '4');
    expect(again.storage.get('aimmo.brouillons')).toBe(kept);
    await again.click(again.find('Abandonner la saisie'));
    expect((again.f('fiche-bien-floor') as FakeElement & { disabled?: boolean }).disabled).toBe(false);
  });

  it('[R276] pendant l’envoi, rien ne se tape ; le brouillon ne s’efface qu’avec ce qui a été rangé', async () => {
    let answer: (r: Response) => void = () => {};
    const t = await run({ [POST]: () => new Promise<Response>((r) => { answer = r; }) });
    await t.open();
    type(t, 'fiche-bien-bedrooms', '3');
    void t.click(t.find('Enregistrer la fiche'));
    await new Promise((r) => setTimeout(r, 0));
    expect((t.f('fiche-bien-bedrooms') as FakeElement & { disabled?: boolean }).disabled).toBe(true);
    answer(Response.json({ ok: false, code: 'busy' }, { status: 409 }));
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    expect((t.f('fiche-bien-bedrooms') as FakeElement & { disabled?: boolean }).disabled).toBe(false);
    expect(JSON.parse(t.storage.get('aimmo.brouillons')!)).not.toEqual({});
  });

  it('[R276] une saisie plus récente d’un autre onglet reste gardée quand cet onglet enregistre la sienne', async () => {
    let answer: (r: Response) => void = () => {};
    const t = await run({ [POST]: () => new Promise<Response>((r) => { answer = r; }), 'GET /v1/annonces/b1/fiche': ok({ propertyId: 'b1', version: 4, sheet: SHEET }) });
    await t.open();
    type(t, 'fiche-bien-bedrooms', '3');
    void t.click(t.find('Enregistrer la fiche'));
    await new Promise((r) => setTimeout(r, 0));
    // L'autre onglet garde entre-temps sa propre saisie.
    const all = JSON.parse(t.storage.get('aimmo.brouillons')!);
    const k = Object.keys(all)[0]!;
    all[k] = { at: 'x', value: { version: 4, raw: { ...all[k].value.raw, 'fiche-bien-bedrooms': '4' } } };
    t.storage.set('aimmo.brouillons', JSON.stringify(all));
    answer(Response.json({ ok: true, mode: 'essai', data: { version: 5 } }));
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(t.storage.get('aimmo.brouillons')!)[k].value.raw['fiche-bien-bedrooms']).toBe('4');
  });

  it('[R13] la sortie efface les brouillons de l’appareil', async () => {
    const t = await run();
    await t.open();
    type(t, 'fiche-bien-bedrooms', '5');
    expect(t.storage.get('aimmo.brouillons')).toBeDefined();
    t.els.sortir!.listeners.click!({});
    expect(t.storage.get('aimmo.brouillons')).toBeUndefined();
  });
});

