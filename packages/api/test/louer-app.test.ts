import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { LEASE_FIELDS } from '../../core/src/location/index.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : logements, candidats, montants, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const FACTS = { furnished: false, rentCents: 65_000, chargesCents: 5_000, livingAreaHundredths: 4_250, energyClass: 'D', finalEnergyKwh: 210, buildYear: 1985, electricityOver15: false, gas: 'aucune', leaseStart: '2027-09-01', chargesMode: 'provision', version: 1 };
const CEILINGS = { zone: 'tendue', tenantCeilingCents: 42_500, inventoryCeilingCents: 12_750, depositCeilingCents: 65_000, factsVersion: 1, inseeCode: '21901' };
// L'ordre reçu de l'API, volontairement à rebours des numéros d'arrivée : l'écran ne doit jamais le retrier.
const APPS = [
  { applicationId: 'c3', listingId: 'l1', personId: 'personne-secrete-3', arrival: 3, arrivedAt: '2027-07-11T08:00:00.000Z', dossierFacile: false, guarantors: [], pieces: [{ holder: 'candidat', category: 'ressources', sort: 'bulletins_salaire', label: 'Bulletins de salaire' }], complete: false, missing: [{ holder: 'candidat', what: 'domicile' }, { holder: 'g1', what: 'ressources' }] },
  { applicationId: 'c1', listingId: 'l1', personId: 'personne-secrete-1', arrival: 1, arrivedAt: '2027-07-09T08:00:00.000Z', dossierFacile: true, guarantors: [], pieces: [], complete: true, missing: [] },
  { applicationId: 'c2', listingId: 'l1', personId: 'personne-secrete-2', arrival: 2, arrivedAt: '2027-07-10T08:00:00.000Z', dossierFacile: false, guarantors: [{ guarantorId: 'g2', kind: 'visale', personId: null }], pieces: [{ holder: 'candidat', category: 'activite', sort: 'contrat_travail', label: 'Contrat de travail' }], complete: true, missing: [] },
];
const PRES = {
  presentationId: 'pr1',
  listingId: 'l1',
  version: 1,
  files: [
    { arrival: 2, arrivedOn: '2027-07-10', applicationId: 'c2', dossierFacile: false, pieces: ['Contrat de travail'], guarantors: ['visale'] },
    { arrival: 1, arrivedOn: '2027-07-09', applicationId: 'c1', dossierFacile: true, pieces: [], guarantors: [] },
  ],
  sha256: 'f'.repeat(64),
  createdAt: '2027-07-12T08:00:00.000Z',
};
const LEASE = { leaseId: 'bl1', mode: 'essai', complete: true, bailleur: null, locataire: null, copiesSent: [] };
const DETAIL: Record<string, Answer> = {
  'GET /v1/location/l1': ok({ check: { checkId: 'k1', listingId: 'l1', factsVersion: 1, decision: 'louable', reasons: [], bannedFrom: null, checkedAt: '2027-07-12T08:00:00.000Z' }, stale: false, required: ['dpe', 'erp', 'surface_habitable'] }),
  'GET /v1/location/l1/suivi': ok({ facts: FACTS, fees: null, lease: null, inventoryClosed: false }),
  'GET /v1/location/l1/plafonds': ok(CEILINGS),
  'GET /v1/location/l1/annonces': ok([{ adId: 'a1', listingId: 'l1', version: 1, title: 'Deux pièces lumineux', body: `Séjour clair. ${INJECTED}`, mentions: 'Location vide. Loyer 700 € charges comprises.', origin: 'secours', validatedAt: null }]),
  'GET /v1/location/l1/candidatures': ok(APPS),
  'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: null }),
  'GET /v1/location/l1/echeances': ok([]),
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/location': ok({
    listings: [
      { listingId: 'l1', reference: 'REF-L-1', city: 'Dijon', openedAt: '2027-07-01T08:00:00.000Z', decision: 'louable' },
      { listingId: 'l2', reference: INJECTED, city: null, openedAt: '2027-07-02T08:00:00.000Z', decision: 'bloque' },
    ],
    page: 0,
    more: false,
  }),
  ...DETAIL,
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  runInNewContext(JS, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['louer-corps']!;
  const state = () => els['louer-etat']!.textContent;
  const byText = (text: string, nth = 0) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text)[nth];
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  /** Le champ relié à un libellé, comme un lecteur d'écran le trouve. */
  const input = (label: string, nth = 0) => {
    const l = body().all().filter((e) => e.tagName === 'label' && e.textContent === label)[nth];
    if (!l) throw new Error(`libellé absent : ${label}`);
    return body().all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const openList = async () => {
    await click(els['louer-ouvrir']);
  };
  const openL1 = async () => {
    await openList();
    await click(byText('Ouvrir', 0));
    calls.length = 0;
  };
  return { els, calls, table, byText, click, input, body, state, posts, openList, openL1, settle };
}

describe('W11 · écran « Louer » de l’application', () => {
  it('[R16] l’écran ne lit et n’écrit que par les routes /v1/location, la clé dans l’en-tête seul', async () => {
    const t = await run();
    await t.openList();
    expect(t.els.louer!.hidden).toBe(false);
    expect(t.els.accueil!.hidden).toBe(true);
    await t.click(t.byText('Ouvrir', 0));
    t.table['POST /v1/location/l1/controle'] = ok({ decision: 'louable' });
    t.table['POST /v1/location/annonces/a1/validation'] = ok({ adId: 'a1', validatedAt: '2027-07-12T09:00:00.000Z' });
    await t.click(t.byText('Contrôler le logement'));
    await t.click(t.byText('Valider l’annonce'));
    await t.click(t.byText('Présenter de nouveau au propriétaire'));
    const screen = t.calls.filter((c) => !/^\/v1\/(moi|plan-du-jour|contacts-chauds|rendez-vous|usage|annonces$|apres-vente)/.test(c.url));
    expect(screen.length).toBeGreaterThan(10);
    for (const c of screen) {
      expect(c.url.startsWith('/v1/location'), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    // Chaque adresse écrite dans le script est une route de M15.
    const screenJs = JS.slice(JS.indexOf('M15 : l'), JS.indexOf('function wipeM08'));
    const routes = [...screenJs.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(3);
    for (const r of routes) expect(r.startsWith('/v1/location'), r).toBe(true);
  });

  it('[R105] [R14] les candidatures dans l’ordre reçu, sans nom, sans note ni tri ; tout texte reste du texte', async () => {
    const t = await run();
    await t.openList();
    const list = t.body().textContent;
    expect(list).toContain('Bien REF-L-1, Dijon');
    expect(list).toContain(`Bien ${INJECTED}`);
    expect(list).toContain('Contrôlé : bloqué avant toute annonce');
    await t.click(t.byText('Ouvrir', 0));
    const ol = t.body().all().filter((e) => e.tagName === 'ol' && e.className === 'dossiers');
    // Les candidatures : l'ordre reçu, jamais retrié par les numéros d'arrivée.
    expect(ol[0]!.children.map((li) => li.children[0]!.textContent)).toEqual(['Dossier arrivé en 3ᵉ', 'Dossier arrivé en premier', 'Dossier arrivé en 2ᵉ']);
    expect(ol[0]!.children[0]!.textContent).toContain('Incomplet : manque justificatif de domicile, justificatif de ressources du garant.');
    expect(ol[0]!.children[1]!.textContent).toContain('dossier DossierFacile');
    // La présentation : les dossiers tels que présentés, et le choix parmi eux seuls, dans cet ordre.
    expect(ol[1]!.children.map((li) => li.textContent.split(',')[0])).toEqual(['Dossier arrivé en 2ᵉ', 'Dossier arrivé en premier']);
    const radios = t.body().all().filter((e) => e.tagName === 'input' && e.attributes.type === 'radio');
    expect(radios.map((r) => r.value)).toEqual(['c2', 'c1']);
    const text = t.body().textContent;
    expect(text).not.toContain('personne-secrete');
    expect(text).not.toMatch(/\bnote\b|étoile|\/ ?5|classement|meilleur|score|revenu|solvab/i);
    // Aucun tri ni filtre proposé à l'écran.
    expect(t.body().all().some((e) => e.tagName === 'button' && /trier|filtrer/i.test(e.textContent))).toBe(false);
    expect(text).toContain(`Séjour clair. ${INJECTED}`);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    // Le parcours : logement fait, l'étape en cours est les honoraires.
    const rail = t.body().all().find((e) => e.className === 'parcours')!;
    expect(rail.children.map((li) => li.textContent)).toEqual(['Logement · fait', 'Honoraires', 'Annonce', 'Dossiers · fait', 'Choix', 'Bail', 'État des lieux']);
    expect(rail.children[1]!.attributes['aria-current']).toBe('step');
  });

  it('[R105] le choix du propriétaire part avec la présentation, la date, le canal et la preuve ; sans case cochée, rien ne part', async () => {
    const t = await run();
    await t.openL1();
    await t.click(t.byText('Enregistrer son choix'));
    expect(t.state()).toBe('Cochez le dossier choisi par le propriétaire.');
    expect(t.posts()).toHaveLength(0);
    t.body().all().filter((e) => e.tagName === 'input' && e.attributes.type === 'radio')[1]!.checked = true;
    t.input('Quand il a choisi').value = '2027-07-12T11:30';
    t.input('Comment il l’a dit').value = 'ecrit';
    t.input('Référence de la preuve rangée').value = '  location/l1/choix/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf ';
    t.table['POST /v1/location/l1/choix'] = ok({ applicationId: 'c1' });
    await t.click(t.byText('Enregistrer son choix'));
    const post = t.posts()[0]!;
    expect(post.url).toBe('/v1/location/l1/choix');
    const b = JSON.parse(post.body!);
    expect(b).toMatchObject({ presentationId: 'pr1', applicationId: 'c1', channel: 'ecrit', proofRef: 'location/l1/choix/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf' });
    expect(Number.isNaN(Date.parse(b.decidedAt))).toBe(false);
    expect(t.state()).toBe('Choix du propriétaire enregistré.');
    // Un refus est dit en clair, sans code interne.
    t.table['POST /v1/location/l1/choix'] = no(409, { ok: false, rule: 'R105', code: 'before_presentation' });
    t.body().all().filter((e) => e.tagName === 'input' && e.attributes.type === 'radio')[0]!.checked = true;
    t.input('Quand il a choisi').value = '2027-07-01T11:30';
    await t.click(t.byText('Enregistrer son choix'));
    expect(t.state()).toBe('Le choix ne peut pas précéder la présentation.');
    expect(t.state()).not.toMatch(/R105|before_/);
  });

  it('[R100] [R101] un logement bloqué dit ses raisons et n’offre pas d’annonce', async () => {
    const t = await run({
      'GET /v1/location/l1': ok({
        check: { checkId: 'k1', listingId: 'l1', factsVersion: 1, decision: 'bloque', reasons: [{ code: 'energy_class', energyClass: 'G', bannedFrom: '2025-01-01' }, { code: 'annex_missing', kind: 'erp' }], bannedFrom: '2025-01-01', checkedAt: '2027-07-12T08:00:00.000Z' },
        stale: false,
        required: ['dpe', 'erp', 'surface_habitable'],
      }),
      'GET /v1/location/l1/annonces': ok([]),
      'GET /v1/location/l1/echeances': ok([{ listingId: 'l1', energyClass: 'G', bannedFrom: '2025-01-01', text: `Votre logement ne peut plus être loué. ${INJECTED}` }]),
    });
    await t.openL1();
    const text = t.body().textContent;
    expect(text).toContain('Bloqué avant toute annonce');
    expect(text).toContain('Classe énergie G : interdite à la location depuis le 01/01/2025.');
    expect(text).toContain('État des risques : manquant.');
    expect(text).toContain('L’annonce attend un logement contrôlé louable.');
    expect(text).toContain(`Votre logement ne peut plus être loué. ${INJECTED}`);
    expect(text).toContain('Mode essai');
    expect(t.byText('Préparer l’annonce')).toBeUndefined();
    const rail = t.body().all().find((e) => e.className === 'parcours')!;
    expect(rail.children[0]!.textContent).toBe('Logement · bloqué');
    // Les faits se corrigent : des euros et des m² saisis, rangés en centimes et centièmes.
    t.input('Loyer hors charges, en euros par mois').value = '640,50';
    t.input('Surface habitable, en m²').value = '42,5';
    t.input('Classe énergie du DPE').value = 'E';
    t.table['POST /v1/location/l1/faits'] = ok({ version: 2 });
    await t.click(t.byText('Ranger les faits'));
    expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ ...Object.fromEntries(Object.entries(FACTS).filter(([k]) => k !== 'version')), rentCents: 64_050, livingAreaHundredths: 4_250, energyClass: 'E' });
    // Un montant illisible : dit, rien ne part.
    t.input('Loyer hors charges, en euros par mois').value = 'six cents';
    await t.click(t.byText('Ranger les faits'));
    expect(t.posts()).toHaveLength(1);
    expect(t.state()).toBe('Remplissez chaque champ : des nombres, et la date du bail.');
  });

  it('[R102] [R107] les plafonds viennent du code ; les honoraires sont proposés au plafond et partent en centimes ; aucun champ d’argent pour AIMMO', async () => {
    const t = await run();
    await t.openL1();
    const text = t.body().textContent;
    expect(text).toContain('Honoraires du locataire : 425,00 € au plus');
    expect(text).toContain('Dépôt de garantie : 650,00 € au plus');
    expect(text).toContain('AIMMO ne reçoit jamais ni loyer ni dépôt.');
    expect(t.input('Honoraires du locataire, hors état des lieux, en euros').value).toBe('425');
    expect(t.input('État des lieux à la charge du locataire, en euros').value).toBe('127,50');
    t.input('Honoraires du locataire, hors état des lieux, en euros').value = '400';
    t.table['POST /v1/location/l1/honoraires'] = no(409, { ok: false, rule: 'R102', code: 'deposit_ceiling' });
    await t.click(t.byText('Ranger les honoraires'));
    expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ tenantCents: 40_000, tenantInventoryCents: 12_750, landlordCents: 42_500, landlordInventoryCents: 12_750, depositCents: 65_000 });
    expect(t.state()).toBe('Le dépôt de garantie dépasse le plafond.');
    // Sans commune : le code INSEE est demandé, rien d'autre.
    const u = await run({ 'GET /v1/location/l1/plafonds': no(400, { ok: false, rule: null, code: 'no_commune' }) });
    await u.openL1();
    u.input('Code INSEE de la commune').value = ' 21231 ';
    u.table['POST /v1/location/l1/commune'] = ok({ inseeCode: '21231' });
    await u.click(u.byText('Ranger la commune'));
    expect(u.posts()[0]).toMatchObject({ url: '/v1/location/l1/commune', body: JSON.stringify({ inseeCode: '21231' }) });
    // Aucun champ de loyer encaissé, de virement ni d'IBAN dans tout le script de l'écran.
    expect(JS.slice(JS.indexOf('M15 : l'), JS.indexOf('function wipeM08'))).not.toMatch(/iban|virement|encaiss|paiement|payer/i);
  });

  it('[R103] une annonce refusée dit ce qui ne va pas, sans code interne', async () => {
    const t = await run();
    await t.openL1();
    t.table['POST /v1/location/l1/annonces/brouillon'] = no(409, { ok: false, rule: 'R103', code: 'invalid', problems: [{ code: 'critere_location', value: 'pas d’enfants' }] });
    await t.click(t.byText('Préparer une nouvelle version'));
    expect(t.state()).toContain('Critère interdit : « pas d’enfants ».');
    expect(t.state()).not.toMatch(/R103|critere_/);
  });

  it('[R108] la signature du bail : l’accord de la partie, le code d’essai, une trace facultative', async () => {
    const t = await run({
      'GET /v1/location/l1/suivi': ok({ facts: FACTS, fees: { tenantCents: 42_500, tenantInventoryCents: 12_750, landlordCents: 42_500, landlordInventoryCents: 12_750, depositCents: 65_000 }, lease: { ...LEASE, bailleur: '2027-07-12T09:00:00.000Z' }, inventoryClosed: false }),
      'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: 'c1' }),
    });
    await t.openL1();
    const text = t.body().textContent;
    expect(text).toContain('Bail en vigueur, complet · document d’essai');
    expect(text).toContain('Signé le 12/07/2027 à 11:00 (essai).');
    expect(text).toContain('Dossier arrivé en premier · choisi par le propriétaire');
    await t.click(t.byText('Envoyer le code de signature au locataire'));
    expect(t.state()).toBe('Notez comment la partie a accepté de signer en ligne.');
    expect(t.posts()).toHaveLength(0);
    t.input('Comment le locataire a accepté de signer en ligne').value = 'Accord donné au rendez-vous du 12 juillet.';
    t.table['POST /v1/location/l1/bail/signatures'] = ok({ sessionId: 's1', leaseId: 'bl1', contentSha256: 'c'.repeat(64), expiresAt: '2027-07-12T09:15:00.000Z', mode: 'essai' });
    await t.click(t.byText('Envoyer le code de signature au locataire'));
    expect(t.posts()[0]).toMatchObject({ url: '/v1/location/l1/bail/signatures', body: JSON.stringify({ party: 'locataire', consentProof: 'Accord donné au rendez-vous du 12 juillet.' }) });
    expect(t.state()).toContain('Code préparé pour le locataire (mode essai)');
    t.input('Code reçu par le locataire').value = ' 123456 ';
    t.table['POST /v1/location/signatures-bail/s1'] = ok({ party: 'locataire', bothSigned: true });
    await t.click(t.byText('Signer pour le locataire'));
    // Sans trace : le code seul part.
    expect(t.posts()[1]).toMatchObject({ url: '/v1/location/signatures-bail/s1', body: JSON.stringify({ code: '123456' }) });
    expect(t.state()).toBe('Signature du locataire rangée (essai).');
    // Le parcours ne passe jamais le bail pour signé tant que les deux parties n'ont pas signé.
    const rail = t.body().all().find((e) => e.className === 'parcours')!;
    expect(rail.children[5]!.textContent).toBe('Bail');
  });

  it('[R106] l’état des lieux pièce par pièce : aucun état choisi d’avance, chaque élément constaté, puis signé des deux parties par une trace', async () => {
    const t = await run({
      'GET /v1/location/l1/suivi': ok({ facts: FACTS, fees: null, lease: { ...LEASE, bailleur: '2027-07-12T09:00:00.000Z', locataire: '2027-07-12T09:05:00.000Z' }, inventoryClosed: false }),
      'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: 'c1' }),
    });
    await t.openL1();
    // Aucun état n'est choisi d'avance : chaque élément est « à constater ».
    const states = t.body().all().filter((e) => e.tagName === 'select' && /-etat-/.test(e.attributes.id ?? ''));
    expect(states).toHaveLength(5);
    for (const s of states) expect(s.value).toBe('');
    t.input('Adresse du logement', 1).value = '12 allée des Essais';
    await t.click(t.byText('Ranger l’état des lieux'));
    expect(t.state()).toBe('Constatez l’état de chaque élément, ou retirez son nom.');
    expect(t.posts()).toHaveLength(0);
    states.forEach((s, i) => (s.value = i === 1 ? 'usage' : 'bon'));
    // Une seconde pièce, dictée ; ses éléments sans nom ne partent pas.
    await t.click(t.byText('Ajouter une pièce'));
    t.input('Nom de la pièce', 1).value = 'Séjour';
    for (const e of t.body().all().filter((x) => x.tagName === 'input' && /-2-el-/.test(x.attributes.id ?? ''))) e.value = '';
    t.input('Observations dictées (l’IA ne fait que les mettre en forme)', 1).value = 'trace au mur près de la fenêtre';
    t.input('Électricité : index relevé').value = '012345';
    t.input('Clé ou badge').value = 'Porte d’entrée';
    t.input('Nombre').value = '2';
    const inv = { inventoryId: 'i1', listingId: 'l1', version: 1, mode: 'essai', status: 'complet', missing: [], rooms: [], content: `ÉTAT DES LIEUX D’ENTRÉE\nDOCUMENT D’ESSAI, SANS VALEUR ${INJECTED}`, contentSha256: 'd'.repeat(64) };
    t.table['POST /v1/location/l1/etat-des-lieux'] = ok(inv);
    // L'écran relu après le rangement : l'état des lieux en cours vient du serveur, pas de la mémoire du téléphone.
    const suivi = (signed: string[]) => ok({ facts: FACTS, fees: null, lease: { ...LEASE, bailleur: '2027-07-12T09:00:00.000Z', locataire: '2027-07-12T09:05:00.000Z' }, inventoryClosed: false, inventory: { ...inv, leaseId: 'bl1', signed } });
    t.table['GET /v1/location/l1/suivi'] = suivi([]);
    await t.click(t.byText('Ranger l’état des lieux'));
    expect(JSON.parse(t.posts()[0]!.body!)).toEqual({
      rooms: [
        { name: 'Entrée', elements: [{ name: 'Sol', state: 'bon' }, { name: 'Murs', state: 'usage' }, { name: 'Plafond', state: 'bon' }, { name: 'Fenêtres', state: 'bon' }, { name: 'Portes', state: 'bon' }], dictation: null },
        { name: 'Séjour', elements: [], dictation: 'trace au mur près de la fenêtre' },
      ],
      meters: [{ kind: 'electricite', index: '012345' }],
      keys: [{ kind: 'Porte d’entrée', count: 2 }],
      furniture: [],
      address: '12 allée des Essais',
    });
    expect(t.state()).toBe('État des lieux rangé, complet : relisez-le avec les deux parties, puis signez.');
    expect(t.body().textContent).toContain(`DOCUMENT D’ESSAI, SANS VALEUR ${INJECTED}`);
    // Sans trace, la signature n'est pas envoyée ; avec une trace du doigt, elle part avec l'empreinte relue.
    t.calls.length = 0;
    await t.click(t.byText('Signer pour le bailleur'));
    expect(t.state()).toBe('Tracez la signature dans le cadre.');
    expect(t.posts()).toHaveLength(0);
    const pad = t.body().all().find((e) => e.tagName === 'canvas' && e.attributes['aria-label']?.startsWith('Signature du bailleur'))!;
    expect(pad.attributes.role).toBe('img');
    pad.listeners.pointerdown!({ offsetX: 10, offsetY: 20 });
    for (let x = 12; x < 60; x += 6) pad.listeners.pointermove!({ offsetX: x, offsetY: 30 });
    pad.listeners.pointerup!({});
    t.table['POST /v1/location/etats-des-lieux/i1/signatures'] = ok({ party: 'bailleur', closed: false });
    t.table['GET /v1/location/l1/suivi'] = suivi(['bailleur']);
    await t.click(t.byText('Signer pour le bailleur'));
    const b = JSON.parse(t.posts()[0]!.body!);
    expect(b).toMatchObject({ party: 'bailleur', contentSha256: 'd'.repeat(64) });
    expect(b.drawing).toMatch(/^[0-9, ;]{10,}$/);
    expect(t.state()).toBe('Signature du bailleur rangée.');
    expect(t.body().textContent).toContain('Signé par le bailleur.');
    expect(t.body().textContent).toContain('Le refaire annulerait la signature déjà donnée');
    // Un rechargement de l'application garde l'état des lieux à signer : seul le locataire reste à signer.
    const u = await run({ 'GET /v1/location/l1/suivi': suivi(['bailleur']), 'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: 'c1' }) });
    await u.openL1();
    expect(u.byText('Signer pour le bailleur')).toBeUndefined();
    expect(u.byText('Signer pour le locataire')).toBeDefined();
    expect(u.body().textContent).toContain(`DOCUMENT D’ESSAI, SANS VALEUR ${INJECTED}`);
  });

  it('le bail préparé se relit avant la signature', async () => {
    const t = await run({ 'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: 'c1' }) });
    await t.openL1();
    t.table['POST /v1/location/l1/bail'] = ok({ leaseId: 'bl1', listingId: 'l1', version: 1, mode: 'essai', status: 'complet', missing: [], annexes: [], content: `BAIL D’ESSAI ${INJECTED}`, contentSha256: 'c'.repeat(64) });
    t.table['GET /v1/location/l1/suivi'] = ok({ facts: FACTS, fees: null, lease: LEASE, inventoryClosed: false, inventory: null });
    await t.click(t.byText('Préparer le bail'));
    expect(t.state()).toBe('Bail préparé, complet : il est à signer.');
    expect(t.body().textContent).toContain(`BAIL D’ESSAI ${INJECTED}`);
    expect(t.body().textContent).toContain('Lire le bail avec les parties');
    // Une sortie puis une autre clé : le texte du bail ne reste pas sur l'appareil [R16].
    await t.click(t.els.sortir);
    t.els.cle!.value = 'z'.repeat(40);
    t.els['form-connexion']!.listeners.submit!({ preventDefault: () => undefined });
    await t.settle();
    await t.openL1();
    expect(t.body().textContent).not.toContain('BAIL D’ESSAI');
    expect(t.body().textContent).toContain('Le texte du bail se relit sur l’appareil qui l’a préparé');
  });

  it('[R108] un code de signature expiré : dit en clair, la séance est oubliée et un nouveau code peut partir', async () => {
    const t = await run({
      'GET /v1/location/l1/suivi': ok({ facts: FACTS, fees: null, lease: LEASE, inventoryClosed: false }),
      'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: 'c1' }),
    });
    await t.openL1();
    t.input('Comment le bailleur a accepté de signer en ligne').value = 'Accord écrit reçu ce matin.';
    t.table['POST /v1/location/l1/bail/signatures'] = ok({ sessionId: 's9', leaseId: 'bl1', contentSha256: 'c'.repeat(64), expiresAt: '2027-07-12T09:15:00.000Z', mode: 'essai' });
    await t.click(t.byText('Envoyer le code de signature au bailleur'));
    t.input('Code reçu par le bailleur').value = '654321';
    t.table['POST /v1/location/signatures-bail/s9'] = no(409, { ok: false, rule: null, code: 'expired' });
    await t.click(t.byText('Signer pour le bailleur'));
    expect(t.state()).toBe('Code expiré : envoyez-en un nouveau.');
    expect(t.byText('Envoyer le code de signature au bailleur')).toBeDefined();
    // Le bouton « Renvoyer un code » ramène aussi au premier pas, sans rien envoyer.
    t.input('Comment le bailleur a accepté de signer en ligne').value = 'Accord écrit reçu ce matin.';
    await t.click(t.byText('Envoyer le code de signature au bailleur'));
    const before = t.posts().length;
    await t.click(t.byText('Renvoyer un code'));
    expect(t.posts()).toHaveLength(before);
    expect(t.byText('Envoyer le code de signature au bailleur')).toBeDefined();
  });

  it('les libellés du bail sont tous distincts sous leur clé courte, et le script ne nomme aucun « mandataire »', () => {
    const short = (k: string) => k.split('.').map((x) => x.slice(0, 4)).join('.');
    const keys = [...Object.keys(LEASE_FIELDS), 'annexe.notice_information'].map(short);
    expect(new Set(keys).size).toBe(keys.length);
    expect(JS).not.toMatch(/mandataire|gratuit/i);
  });
});
