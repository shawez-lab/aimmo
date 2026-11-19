import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { LEASE_FIELDS } from '../../core/src/location/index.ts';
import { LOUER_SCRIPT } from '../app/louer.ts';
import { LOUER_DOSSIER_SCRIPT } from '../app/louer-dossier.ts';
import { LOUER_EDL_SCRIPT } from '../app/louer-edl.ts';
import { LOUER_REMISE_SCRIPT } from '../app/louer-remise.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
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
/** Un fichier pris sur le téléphone, inventé : la taille peut être annoncée plus grande que les octets. */
const pdfFile = (type = 'application/pdf', size = 8) => ({ type, size, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7').buffer });
const SHA_PDF = createHash('sha256').update('%PDF-1.7').digest('hex');
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string; auth: string | undefined; headers?: Record<string, string> }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), auth: init.headers?.authorization, ...(init.headers ? { headers: init.headers } : {}) });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    crypto: globalThis.crypto,
  };
  runInNewContext(JS, context);
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
  // Le script chargé à la demande : celui que le navigateur ferait tourner, dans la même page.
  const scripts = () => els.louer!.children.filter((e) => e.tagName === 'script');
  const openList = async () => {
    await click(els['louer-ouvrir']);
    const s = scripts();
    if (s.length === 1 && !s[0]!.attributes['data-lu']) {
      s[0]!.attributes['data-lu'] = 'oui';
      runInNewContext(LOUER_SCRIPT, context);
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const openL1 = async () => {
    await openList();
    await click(byText('Ouvrir', 0));
    calls.length = 0;
  };
  /** Le geste d'ouvrir la remise des clés : le script chargé à part, comme le navigateur le ferait. */
  const lazyLoad = async (src: string, code: string) => {
    const s = scripts().find((e) => e.attributes.src === src && !e.attributes['data-lu']);
    if (s) {
      s.attributes['data-lu'] = 'oui';
      runInNewContext(code, context);
      s.listeners.load!({});
      await settle();
    }
  };
  const openClosing = async () => {
    await click(byText('Ouvrir la remise des clés'));
    await lazyLoad('/app/louer-remise.js', LOUER_REMISE_SCRIPT);
  };
  /** Le geste d'ouvrir le formulaire de l'état des lieux, chargé à part. */
  const openInventory = async (label = 'Faire l’état des lieux, pièce par pièce') => {
    await click(byText(label));
    await lazyLoad('/app/louer-edl.js', LOUER_EDL_SCRIPT);
  };
  const openDossier = async (nth = 0) => {
    await click(byText('Compléter ce dossier', nth));
    await lazyLoad('/app/louer-dossier.js', LOUER_DOSSIER_SCRIPT);
  };
  return { els, calls, table, byText, click, input, body, state, posts, openList, openL1, settle, scripts, openClosing, openInventory, openDossier };
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
    const screen = t.calls.filter((c) => !/^\/v1\/(moi|plan-du-jour|alertes-agent|contacts-chauds|rendez-vous|usage|annonces$|offres\/a-tenir|apres-vente|conformite\/personnes\/[^/]+\/coffre\/recus$)/.test(c.url));
    expect(screen.length).toBeGreaterThan(10);
    for (const c of screen) {
      expect(c.url.startsWith('/v1/location'), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    // Chaque adresse écrite dans le script est une route de M15.
    // Le script de l'écran tel que posé dans l'application (l'application le sert sans ses lignes de commentaire).
    const screenJs = LOUER_SCRIPT;
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
    expect(rail.children.map((li) => li.textContent)).toEqual(['Logement · fait', 'Honoraires', 'Annonce', 'Dossiers · fait', 'Choix', 'Bail', 'État des lieux', 'Remise des clés']);
    expect(rail.children[1]!.attributes['aria-current']).toBe('step');
  });

  it('[R16] [R105] une candidature s’ajoute depuis l’écran : ses contacts seuls, lus au geste, à la dernière place', async () => {
    const t = await run({
      'GET /v1/location/l1/contacts': ok({ contacts: [{ personId: 'p-nouvelle', firstName: 'Nina', lastName: INJECTED }, { personId: 'p-sans-nom', firstName: null, lastName: null }], more: false }),
      'POST /v1/location/l1/candidatures': ok({ applicationId: 'c4', arrival: 4 }),
    });
    await t.openList();
    await t.click(t.byText('Ouvrir', 0));
    // Rien n'est lu des contacts avant le geste, depuis l'ouverture de l'écran.
    expect(t.calls.some((c) => c.url.endsWith('/contacts'))).toBe(false);
    expect(t.body().textContent).not.toContain('Nina');
    t.calls.length = 0;
    await t.click(t.byText('Choisir parmi mes contacts'));
    const who = t.input('La personne');
    const options = who.children.map((o) => o.textContent);
    expect(options).toEqual(['Choisir une personne', `Nina ${INJECTED}`, 'Contact sans nom']);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    // Sans personne choisie, rien ne part.
    await t.click(t.byText('Ranger la candidature'));
    expect(t.posts()).toEqual([]);
    expect(t.state()).toBe('Choisissez d’abord la personne.');
    who.value = 'p-nouvelle';
    t.input('Lien DossierFacile (facultatif)').value = ' https://www.dossierfacile.fr/file/abc ';
    // Un double appui ne range qu'une candidature.
    const save = t.byText('Ranger la candidature')!;
    save.listeners.click!({});
    save.listeners.click!({});
    await t.settle();
    expect(t.posts()).toHaveLength(1);
    expect(t.posts()[0]!.url).toBe('/v1/location/l1/candidatures');
    expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ personId: 'p-nouvelle', dossierFacileUrl: 'https://www.dossierfacile.fr/file/abc' });
    expect(t.state()).toBe('Candidature rangée, à sa place d’arrivée.');
  });

  it('[R201] l’écran est servi à part, chargé une fois au premier geste, et tient le budget d’une page', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(JS).not.toContain('/v1/location');
    expect(budgetProblems({ html: '', js: LOUER_SCRIPT }, BUDGETS.page)).toEqual([]);
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/louer.js'))!;
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(await served.text()).toBe(LOUER_SCRIPT);
    await t.openList();
    await t.click(t.els['louer-retour']);
    await t.openList();
    expect(t.scripts()).toHaveLength(1);
  });

  describe('W14 · déposer une pièce depuis le téléphone', () => {
    const ANNEX_REF = 'location/l1/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.pdf';
    const open = async (answers: Record<string, Answer> = {}) => {
      const t = await run(answers);
      await t.openL1();
      const pick = t.input('Le document, en PDF ou en photo') as unknown as FakeElement & { files: unknown[] };
      t.input('Date du diagnostic').value = '2027-07-01';
      return { t, pick };
    };

    it('[R16] plus aucune référence à saisir : le fichier part tel quel, avec son empreinte et la clé, puis l’annexe porte la référence rendue', async () => {
      const { t, pick } = await open({
        'POST /v1/location/l1/fichiers/annexe': ok({ kind: 'annexe', ref: ANNEX_REF }),
        'POST /v1/location/l1/annexes': ok({ kind: 'dpe', version: 1, validUntil: null }),
      });
      const labels = t.body().all().filter((e) => e.tagName === 'label').map((e) => e.textContent);
      expect(labels.filter((l) => /référence/i.test(l))).toEqual([]);
      expect(pick.attributes.type).toBe('file');
      expect(pick.attributes.accept).toBe('application/pdf,image/jpeg,image/png');
      const file = pdfFile();
      pick.files = [file];
      await t.click(t.byText('Joindre l’annexe'));
      const [up, annex] = t.posts();
      expect(up!.url).toBe('/v1/location/l1/fichiers/annexe');
      expect(up!.body).toBe(file);
      expect(up!.auth).toBe(`Bearer ${KEY}`);
      expect(up!.headers).toMatchObject({ 'content-type': 'application/pdf', 'x-aimmo-sha256': SHA_PDF });
      expect(up!.url).not.toContain(KEY);
      expect(annex!.url).toBe('/v1/location/l1/annexes');
      expect(JSON.parse(annex!.body!)).toMatchObject({ ref: ANNEX_REF, diagnosedOn: '2027-07-01' });
      expect(t.state()).toBe('Annexe jointe : contrôlez de nouveau le logement.');
    });

    it('sans fichier ou sans date, rien ne part ; un mauvais type ou un fichier trop lourd ne s’envoie même pas', async () => {
      const { t, pick } = await open();
      await t.click(t.byText('Joindre l’annexe'));
      expect(t.state()).toBe('Choisissez d’abord le document.');
      pick.files = [pdfFile('text/html')];
      await t.click(t.byText('Joindre l’annexe'));
      expect(t.state()).toBe('Ce fichier n’est pas accepté : un PDF, une photo JPEG ou PNG.');
      pick.files = [pdfFile('application/pdf', 21 * 1024 * 1024)];
      await t.click(t.byText('Joindre l’annexe'));
      expect(t.state()).toBe('Ce fichier dépasse 20 Mo.');
      pick.files = [pdfFile()];
      t.input('Date du diagnostic').value = '';
      await t.click(t.byText('Joindre l’annexe'));
      expect(t.state()).toBe('Indiquez la date du diagnostic.');
      expect(t.posts()).toHaveLength(0);
    });

    it('un refus de l’annexe après le dépôt ne redépose pas le même fichier ; un double appui n’en dépose qu’un', async () => {
      const { t, pick } = await open({
        'POST /v1/location/l1/fichiers/annexe': ok({ kind: 'annexe', ref: ANNEX_REF }),
        'POST /v1/location/l1/annexes': no(400, { ok: false, rule: null, code: 'bad_date' }),
      });
      pick.files = [pdfFile()];
      const b = t.byText('Joindre l’annexe')!;
      b.listeners.click!({});
      b.listeners.click!({});
      await t.settle();
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/location/l1/fichiers/annexe', '/v1/location/l1/annexes']);
      await t.click(b);
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/location/l1/fichiers/annexe', '/v1/location/l1/annexes', '/v1/location/l1/annexes']);
      expect(JSON.parse(t.posts()[2]!.body!)).toMatchObject({ ref: ANNEX_REF });
    });

    it('[R104] un refus du dépôt est dit en français, sans code, et l’annexe ne part pas ; hors réseau aussi', async () => {
      const { t, pick } = await open({ 'POST /v1/location/l1/fichiers/annexe': no(415, { ok: false, rule: null, code: 'type_refuse' }) });
      pick.files = [pdfFile()];
      await t.click(t.byText('Joindre l’annexe'));
      expect(t.state()).toBe('Ce fichier n’est pas accepté : un PDF, une photo JPEG ou PNG.');
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/location/l1/fichiers/annexe']);
      delete t.table['POST /v1/location/l1/fichiers/annexe'];
      await t.click(t.byText('Joindre l’annexe'));
      expect(t.state()).toBe('Pas de réseau : le fichier n’est pas rangé.');
    });

    it('une clé refusée au dépôt ramène à la connexion, comme tout autre geste', async () => {
      const { t, pick } = await open({ 'POST /v1/location/l1/fichiers/annexe': no(401, { ok: false, code: 'unauthorized' }) });
      t.table['GET /v1/location'] = no(401, { ok: false, code: 'unauthorized' });
      pick.files = [pdfFile()];
      await t.click(t.byText('Joindre l’annexe'));
      expect(t.els.connexion!.hidden).toBe(false);
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/location/l1/fichiers/annexe']);
    });

    it('la notice du bail : en PDF, déposée seulement si elle est choisie ; sans elle, le bail part sans référence', async () => {
      const t = await run({
        'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: 'c1' }),
        'POST /v1/location/l1/fichiers/notice': ok({ kind: 'notice', ref: 'location/l1/bail/cccccccc-cccc-4ccc-8ccc-cccccccccccc.pdf' }),
        'POST /v1/location/l1/bail': ok({ leaseId: 'bl1', content: 'Texte du bail', missing: [] }),
      });
      await t.openL1();
      const notice = t.input('La notice d’information, en PDF') as unknown as FakeElement & { files: unknown[] };
      expect(notice.attributes.accept).toBe('application/pdf');
      await t.click(t.byText('Préparer le bail'));
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/location/l1/bail']);
      expect(JSON.parse(t.posts()[0]!.body!).noticeRef).toBeUndefined();
      // AU096 · La qualité du bailleur part telle que l'agent l'a choisie (à choisir : vide, refusé par le serveur) ; la case
      // « étudiant » fait la variante.
      expect(JSON.parse(t.posts()[0]!.body!)).toMatchObject({ landlord: '', variant: 'standard' });
      t.input('Le bailleur est').value = 'morale';
      (t.input('Meublé loué à un étudiant, 9 mois') as unknown as { checked: boolean }).checked = true;
      t.calls.length = 0;
      await t.click(t.byText('Préparer le bail'));
      expect(JSON.parse(t.posts()[0]!.body!)).toMatchObject({ landlord: 'morale', variant: 'etudiant' });
      t.calls.length = 0;
      const again = t.input('La notice d’information, en PDF') as unknown as FakeElement & { files: unknown[] };
      again.files = [pdfFile()];
      await t.click(t.byText('Préparer le bail'));
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/location/l1/fichiers/notice', '/v1/location/l1/bail']);
      expect(JSON.parse(t.posts()[1]!.body!).noticeRef).toBe('location/l1/bail/cccccccc-cccc-4ccc-8ccc-cccccccccccc.pdf');
      // Un dépôt refusé : le bail ne part pas sans la notice que l'agent a choisie.
      t.calls.length = 0;
      t.table['POST /v1/location/l1/fichiers/notice'] = no(415, { ok: false, code: 'type_refuse' });
      const third = t.input('La notice d’information, en PDF') as unknown as FakeElement & { files: unknown[] };
      third.files = [pdfFile()];
      await t.click(t.byText('Préparer le bail'));
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/location/l1/fichiers/notice']);
    });
  });

  it('[R104] un refus de la candidature est dit en français, sans code ; la personne peut réessayer', async () => {
    const t = await run({
      'GET /v1/location/l1/contacts': ok({ contacts: [{ personId: 'p-nouvelle', firstName: 'Nina', lastName: 'Exemple' }], more: false }),
      'POST /v1/location/l1/candidatures': no(409, { ok: false, code: 'already_applied' }),
    });
    await t.openL1();
    await t.click(t.byText('Choisir parmi mes contacts'));
    t.input('La personne').value = 'p-nouvelle';
    await t.click(t.byText('Ranger la candidature'));
    expect(t.state()).toBe('Cette personne a déjà une candidature sur ce logement.');
    t.table['POST /v1/location/l1/candidatures'] = no(400, { ok: false, code: 'bad_dossierfacile' });
    await t.click(t.byText('Ranger la candidature'));
    expect(t.state()).toBe('Ce lien n’est pas un lien DossierFacile.');
    expect(t.posts()).toHaveLength(2);
  });

  it('une candidature ne s’ajoute plus quand le propriétaire a choisi ; sans réseau, les contacts se redemandent', async () => {
    const chosen = await run({ 'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: 'c2' }) });
    await chosen.openL1();
    expect(chosen.byText('Choisir parmi mes contacts')).toBeUndefined();
    const t = await run();
    await t.openL1();
    await t.click(t.byText('Choisir parmi mes contacts'));
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    t.table['GET /v1/location/l1/contacts'] = ok({ contacts: [], more: false });
    await t.click(t.byText('Choisir parmi mes contacts'));
    expect(t.state()).toBe('Aucun autre contact à proposer sur ce logement.');
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
    // Sans fichier, rien ne part ; avec lui, il est déposé d'abord, puis le choix porte la référence rendue.
    await t.click(t.byText('Enregistrer son choix'));
    expect(t.state()).toBe('Choisissez d’abord la preuve de son choix.');
    expect(t.posts()).toHaveLength(0);
    const proofRef = 'location/l1/choix/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf';
    (t.input('Sa preuve : photo, PDF ou texte écrit') as unknown as { files: unknown[] }).files = [pdfFile()];
    t.table['POST /v1/location/l1/fichiers/preuve'] = ok({ kind: 'preuve', ref: proofRef });
    t.table['POST /v1/location/l1/choix'] = ok({ applicationId: 'c1' });
    await t.click(t.byText('Enregistrer son choix'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/location/l1/fichiers/preuve', '/v1/location/l1/choix']);
    t.calls.splice(0, t.calls.findIndex((c) => c.url === '/v1/location/l1/choix'));
    const post = t.posts()[0]!;
    expect(post.url).toBe('/v1/location/l1/choix');
    const b = JSON.parse(post.body!);
    expect(b).toMatchObject({ presentationId: 'pr1', applicationId: 'c1', channel: 'ecrit', proofRef });
    expect(Number.isNaN(Date.parse(b.decidedAt))).toBe(false);
    expect(t.state()).toBe('Choix du propriétaire enregistré.');
    // Un refus est dit en clair, sans code interne.
    t.table['POST /v1/location/l1/choix'] = no(409, { ok: false, rule: 'R105', code: 'before_presentation' });
    t.body().all().filter((e) => e.tagName === 'input' && e.attributes.type === 'radio')[0]!.checked = true;
    t.input('Quand il a choisi').value = '2027-07-01T11:30';
    (t.input('Sa preuve : photo, PDF ou texte écrit') as unknown as { files: unknown[] }).files = [pdfFile()];
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
    // AU016 · Le loyer du locataire précédent : « aucun » pour une première location, sinon des euros en centimes.
    t.input('Loyer du locataire précédent, hors charges, en euros, ou « aucun »').value = 'Aucun';
    await t.click(t.byText('Ranger les faits'));
    expect(JSON.parse(t.posts()[1]!.body!)).toMatchObject({ firstLetting: true });
    expect(JSON.parse(t.posts()[1]!.body!)).not.toHaveProperty('previousRentCents');
    t.input('Loyer du locataire précédent, hors charges, en euros, ou « aucun »').value = '600';
    await t.click(t.byText('Ranger les faits'));
    expect(JSON.parse(t.posts()[2]!.body!)).toMatchObject({ previousRentCents: 60_000 });
    expect(JSON.parse(t.posts()[2]!.body!)).not.toHaveProperty('firstLetting');
    t.input('Loyer du locataire précédent, hors charges, en euros, ou « aucun »').value = 'cher';
    await t.click(t.byText('Ranger les faits'));
    expect(t.posts()).toHaveLength(3);
    expect(t.state()).toBe('Loyer précédent : un nombre, ou « aucun ».');
    t.input('Loyer du locataire précédent, hors charges, en euros, ou « aucun »').value = '';
    // Un montant illisible : dit, rien ne part.
    t.input('Loyer hors charges, en euros par mois').value = 'six cents';
    await t.click(t.byText('Ranger les faits'));
    expect(t.posts()).toHaveLength(3);
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
    // Les honoraires rangés : le total à la charge de chacun, état des lieux compris, comme dans l'annonce et le bail.
    const v = await run({ 'GET /v1/location/l1/suivi': ok({ facts: FACTS, fees: { tenantCents: 42_500, tenantInventoryCents: 12_750, landlordCents: 42_500, landlordInventoryCents: 12_750, depositCents: 65_000 }, lease: null, inventoryClosed: false }) });
    await v.openL1();
    expect(v.body().textContent).toContain('Rangés : à la charge du locataire 552,50 €, dont état des lieux 127,50 € ; du bailleur 552,50 €, dont état des lieux 127,50 € ; dépôt 650,00 €.');
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
    await t.openInventory();
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
    expect(t.byText('Relire le bail avec les parties')).toBeDefined();
  });

  it('[R16] [R14] W15 : après réouverture, le bail se relit au geste, par la seule route du bail, posé en texte ; un refus est dit en clair', async () => {
    const t = await run({
      'GET /v1/location/l1/suivi': ok({ facts: FACTS, fees: null, lease: LEASE, inventoryClosed: false }),
      'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: 'c1' }),
      'GET /v1/location/l1/bail/texte': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }),
    });
    await t.openL1();
    // Rien n'est lu avant le geste.
    expect(t.calls.some((c) => c.url.endsWith('/bail/texte'))).toBe(false);
    await t.click(t.byText('Relire le bail avec les parties'));
    expect(t.state()).toBe('Ce logement est suivi par un autre agent.');
    expect(t.state()).not.toMatch(/R16|not_assigned/);
    expect(t.body().textContent).not.toContain('BAIL D’ESSAI');
    delete t.table['GET /v1/location/l1/bail/texte'];
    await t.click(t.byText('Relire le bail avec les parties'));
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    t.table['GET /v1/location/l1/bail/texte'] = ok({ leaseId: 'bl1', content: `BAIL D’ESSAI ${INJECTED}`, contentSha256: 'a'.repeat(64) });
    await t.click(t.byText('Relire le bail avec les parties'));
    expect(t.body().textContent).toContain(`BAIL D’ESSAI ${INJECTED}`);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(t.byText('Relire le bail avec les parties')).toBeUndefined();
    // Sortie : le texte n'est plus sur l'appareil, il faut le redemander.
    await t.click(t.els.sortir);
    t.els.cle!.value = 'z'.repeat(40);
    t.els['form-connexion']!.listeners.submit!({ preventDefault: () => undefined });
    await t.settle();
    await t.openL1();
    expect(t.body().textContent).not.toContain('BAIL D’ESSAI');
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

  describe('W16 · remise des clés et gestion', () => {
    const SIGNED = { facts: FACTS, fees: null, lease: { ...LEASE, bailleur: '2027-07-12T09:00:00.000Z', locataire: '2027-07-12T09:05:00.000Z' }, inventoryClosed: true, handedOn: null };
    const FEES_DUE = { due: false, dueSince: null, tenantCents: 55_250, landlordCents: 55_250 };
    const STATE = { writable: true, leaseSigned: true, inventoryClosed: true, handover: null, managers: [], entrustable: [] };
    const HANDOVER = { handoverId: 'h1', listingId: 'l1', handedOn: '2027-07-12', depositPaidTo: 'proprietaire', firstRentPaidTo: 'proprietaire', depositCents: 65_000, firstRentCents: 70_000, text: `Remise des clés le lundi 12 juillet 2027.\nLe dépôt est réglé directement au propriétaire. ${INJECTED}`, textSha256: 'a'.repeat(64) };
    const setup = async (state: unknown, more: Record<string, Answer> = {}) => {
      const t = await run({
        'GET /v1/location/l1/suivi': ok(SIGNED),
        'GET /v1/location/l1/remise-des-cles': ok(state),
        'GET /v1/location/l1/honoraires-dus': ok(FEES_DUE),
        ...more,
      });
      await t.openL1();
      return t;
    };

    it('[R201] servi à part, chargé au premier geste, rien n’est lu avant, et chaque script tient le budget', async () => {
      const t = await setup(STATE);
      expect(t.scripts().filter((e) => e.attributes.src === '/app/louer-remise.js')).toHaveLength(0);
      expect(t.calls.some((c) => c.url.includes('remise-des-cles'))).toBe(false);
      expect(LOUER_SCRIPT).not.toContain('/remise-des-cles');
      expect(budgetProblems({ html: '', js: LOUER_REMISE_SCRIPT }, BUDGETS.page)).toEqual([]);
      expect(budgetProblems({ html: '', js: LOUER_EDL_SCRIPT }, BUDGETS.page)).toEqual([]);
      expect(budgetProblems({ html: '', js: LOUER_SCRIPT }, BUDGETS.page)).toEqual([]);
      const served = handleAgentApp(new Request('https://aimmo.example.test/app/louer-remise.js'))!;
      expect(served.headers.get('content-type')).toContain('text/javascript');
      expect(await served.text()).toBe(LOUER_REMISE_SCRIPT);
      await t.openClosing();
      expect(t.scripts().filter((e) => e.attributes.src === '/app/louer-remise.js')).toHaveLength(1);
      expect(t.calls.map((c) => c.url)).toEqual(['/v1/location/l1/remise-des-cles', '/v1/location/l1/honoraires-dus']);
    });

    it('[R108] le rail ne dit jamais « fait » pour un bail signé en essai', async () => {
      const t = await setup({ ...STATE, leaseSigned: false });
      const text = t.body().textContent;
      expect(text).toContain('Bail · signé en essai');
      expect(text).not.toContain('Bail · fait');
      const real = await setup(STATE, { 'GET /v1/location/l1/suivi': ok({ ...SIGNED, lease: { ...SIGNED.lease, mode: 'reel' } }) });
      expect(real.body().textContent).toContain('Bail · fait');
    });

    it('[R16] une autre clé sur le même appareil ne rouvre rien sans son geste', async () => {
      const t = await setup(STATE);
      await t.openClosing();
      t.calls.length = 0;
      await t.click(t.els['louer-retour']);
      await t.click(t.byText('Ouvrir', 0));
      // Le même agent revient : le bloc se rouvre.
      expect(t.calls.some((c) => c.url.endsWith('/remise-des-cles'))).toBe(true);
      await t.click(t.els.sortir);
      t.els.cle!.value = 'z'.repeat(40);
      t.els['form-connexion']!.listeners.submit!({ preventDefault: () => undefined });
      await t.settle();
      await t.openL1();
      await t.settle();
      expect(t.calls.some((c) => c.url.endsWith('/remise-des-cles'))).toBe(false);
      expect(t.byText('Ouvrir la remise des clés')).toBeDefined();
    });

    it('un script chargé mais vide ne laisse pas l’écran en attente', async () => {
      const t = await setup(STATE);
      await t.click(t.byText('Ouvrir la remise des clés'));
      t.scripts().find((e) => e.attributes.src === '/app/louer-remise.js')!.listeners.load!({});
      await t.settle();
      expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    });

    it('[R201] le formulaire de l’état des lieux est servi à part', async () => {
      const served = handleAgentApp(new Request('https://aimmo.example.test/app/louer-edl.js'))!;
      expect(served.headers.get('content-type')).toContain('text/javascript');
      expect(await served.text()).toBe(LOUER_EDL_SCRIPT);
    });

    it('sans réseau au chargement du script, c’est dit, et le même geste recharge', async () => {
      const t = await setup(STATE);
      await t.click(t.byText('Ouvrir la remise des clés'));
      const s = t.scripts().find((e) => e.attributes.src === '/app/louer-remise.js')!;
      s.listeners.error!({});
      await t.settle();
      expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
      expect(t.byText('Ouvrir la remise des clés')).toBeDefined();
    });

    it('[R108] une signature d’essai n’ouvre pas la remise : c’est dit en français, et aucun geste n’est offert', async () => {
      const t = await setup({ ...STATE, leaseSigned: false });
      await t.openClosing();
      const text = t.body().textContent;
      expect(text).toContain('Le bail n’est pas signé pour de vrai : une signature d’essai ne compte pas.');
      expect(text).toContain('Pas encore dus : ils le deviennent à la signature réelle du bail.');
      expect(t.byText('Ranger la remise des clés')).toBeUndefined();
      expect(text).not.toMatch(/lease_not_signed|R108/);
    });

    it('[R108] un refus du serveur est dit en français, sans code ; une signature devenue d’essai ne passe pas', async () => {
      const t = await setup(STATE, { 'POST /v1/location/l1/remise-des-cles': no(409, { ok: false, rule: 'R107', code: 'lease_not_signed' }) });
      await t.openClosing();
      await t.click(t.byText('Ranger la remise des clés'));
      expect(t.state()).toBe('Choisissez le jour de la remise : aujourd’hui ou un jour passé.');
      expect(t.posts()).toHaveLength(0);
      t.input('Jour de la remise des clés').value = '2027-07-12';
      await t.click(t.byText('Ranger la remise des clés'));
      expect(t.posts()[0]).toMatchObject({ url: '/v1/location/l1/remise-des-cles', body: JSON.stringify({ handedOn: '2027-07-12' }) });
      expect(t.state()).toBe('Le bail n’est pas signé pour de vrai : une signature d’essai ne compte pas.');
    });

    it('[R107] la remise rangée se relit depuis le serveur, en texte, sans aucun champ d’argent', async () => {
      const t = await setup(STATE, { 'POST /v1/location/l1/remise-des-cles': ok(HANDOVER) });
      await t.openClosing();
      expect(t.body().all().filter((e) => e.tagName === 'label').map((e) => e.textContent).filter((x) => /remise/i.test(x ?? ''))).toEqual(['Jour de la remise des clés']);
      t.table['GET /v1/location/l1/suivi'] = ok({ ...SIGNED, handedOn: '2027-07-12' });
      t.table['GET /v1/location/l1/remise-des-cles'] = ok({ ...STATE, handover: HANDOVER });
      t.input('Jour de la remise des clés').value = '2027-07-12';
      await t.click(t.byText('Ranger la remise des clés'));
      // L'écran relit : le rail, le récapitulatif du serveur, et le message reste affiché.
      expect(t.state()).toBe('Remise des clés rangée.');
      const text = t.body().textContent;
      expect(text).toContain('Remise des clés · fait');
      expect(text).toContain('Clés remises le 12/07/2027.');
      expect(text).toContain('Remise des clés le lundi 12 juillet 2027.');
      expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
      expect(t.byText('Ranger la remise des clés')).toBeUndefined();
    });

    it('[R10] une réponse perdue est dite telle, sans refaire le geste ; on relit avant de recommencer', async () => {
      const t = await setup(STATE);
      await t.openClosing();
      t.input('Jour de la remise des clés').value = '2027-07-12';
      await t.click(t.byText('Ranger la remise des clés'));
      expect(t.state()).toBe('Réponse perdue : ce geste est peut-être rangé. Relisez avant de recommencer.');
      expect(t.byText('Ranger la remise des clés')).toBeUndefined();
      expect(t.posts()).toHaveLength(1);
      t.table['GET /v1/location/l1/remise-des-cles'] = ok({ ...STATE, handover: HANDOVER });
      await t.click(t.byText('Relire la remise des clés'));
      expect(t.body().textContent).toContain('Remise des clés le lundi 12 juillet 2027.');
      expect(t.posts()).toHaveLength(1);
    });

    it('[R10] une erreur du serveur après le geste compte aussi pour une réponse perdue ; déjà rangée, on relit', async () => {
      const t = await setup(STATE, { 'POST /v1/location/l1/remise-des-cles': no(500, { ok: false }) });
      await t.openClosing();
      t.input('Jour de la remise des clés').value = '2027-07-12';
      await t.click(t.byText('Ranger la remise des clés'));
      expect(t.state()).toContain('Réponse perdue');
      await t.click(t.byText('Relire la remise des clés'));
      t.table['POST /v1/location/l1/remise-des-cles'] = no(409, { ok: false, rule: null, code: 'already_handed_over' });
      t.input('Jour de la remise des clés').value = '2027-07-12';
      await t.click(t.byText('Ranger la remise des clés'));
      expect(t.state()).toBe('La remise des clés était déjà rangée.');
    });

    it('[R16] qui lit sans agir n’a ni formulaire ni bouton ; un autre agent ne lit rien ; un geste refusé est dit', async () => {
      const reader = await setup({ ...STATE, writable: false });
      await reader.openClosing();
      expect(reader.body().textContent).toContain('Clés pas encore remises.');
      expect(reader.byText('Ranger la remise des clés')).toBeUndefined();
      const other = await setup(STATE, { 'GET /v1/location/l1/remise-des-cles': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
      await other.openClosing();
      expect(other.state()).toBe('Ce geste n’est pas dans vos droits.');
      expect(other.body().textContent).not.toContain('Honoraires de location');
      const late = await setup(STATE, { 'POST /v1/location/l1/remise-des-cles': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
      await late.openClosing();
      late.input('Jour de la remise des clés').value = '2027-07-12';
      await late.click(late.byText('Ranger la remise des clés'));
      expect(late.state()).toBe('Ce geste n’est pas dans vos droits.');
    });

    it('[R74] [R73] la gestion se confie à un professionnel nommé, jamais par une référence ; une carte échue n’offre pas de bouton', async () => {
      const entrustable = [
        { referralId: 'r1', partnerName: 'Gestion Inventée', available: true },
        { referralId: 'r2', partnerName: INJECTED, available: false },
      ];
      const t = await setup({ ...STATE, leaseSigned: false, entrustable }, { 'POST /v1/location/l1/gestion': ok({ partnerId: 'p1' }) });
      await t.openClosing();
      expect(t.body().all().filter((e) => e.tagName === 'label').map((e) => e.textContent)).not.toContain('Référence');
      expect(t.body().textContent).not.toContain('r1');
      expect(t.body().textContent).toContain('La carte G ou l’assurance de ce gestionnaire n’est pas valide ce jour.');
      expect(t.byText(`Confier la gestion à ${INJECTED}`)).toBeUndefined();
      t.table['GET /v1/location/l1/remise-des-cles'] = ok({ ...STATE, leaseSigned: false, managers: [{ partnerName: 'Gestion Inventée', linkedAt: '2027-07-12T10:00:00.000Z' }] });
      await t.click(t.byText('Confier la gestion à Gestion Inventée'));
      expect(t.posts()[0]).toMatchObject({ url: '/v1/location/l1/gestion', body: JSON.stringify({ referralId: 'r1' }) });
      expect(t.state()).toBe('Gestion confiée à Gestion Inventée.');
      expect(t.body().textContent).toContain('Confiée à Gestion Inventée, le 12/07/2027.');
    });

    it('[R73] sans gestionnaire confié, l’écran dit où aller ; un refus de la carte est dit en français', async () => {
      const none = await setup(STATE);
      await none.openClosing();
      expect(none.body().textContent).toContain('Aucun gestionnaire confié pour ce logement');
      const t = await setup({ ...STATE, entrustable: [{ referralId: 'r1', partnerName: 'Gestion Inventée', available: true }] }, { 'POST /v1/location/l1/gestion': no(409, { ok: false, rule: 'R73', code: 'partner_unavailable' }) });
      await t.openClosing();
      await t.click(t.byText('Confier la gestion à Gestion Inventée'));
      expect(t.state()).toBe('La carte G ou l’assurance de ce gestionnaire n’est pas valide ce jour.');
    });

    it('[R102] les honoraires dus viennent du code ; sans honoraires rangés, c’est dit sans bloquer le reste', async () => {
      const t = await setup(STATE, { 'GET /v1/location/l1/honoraires-dus': ok({ due: true, dueSince: '2027-07-12T09:05:00.000Z', tenantCents: 55_250, landlordCents: 50_000 }) });
      await t.openClosing();
      expect(t.body().textContent).toContain('Dus depuis le 12/07/2027 : 552,50 € pour le locataire, 500,00 € pour le bailleur.');
      expect(t.body().textContent).toContain('rien n’est encaissé ici');
      const none = await setup(STATE, { 'GET /v1/location/l1/honoraires-dus': no(409, { ok: false, rule: 'R102', code: 'no_fees' }) });
      await none.openClosing();
      expect(none.body().textContent).toContain('Les honoraires ne sont pas encore rangés.');
      expect(none.byText('Ranger la remise des clés')).toBeDefined();
    });
  });

  describe('W18 · compléter un dossier de candidature', () => {
    const FILE = { type: 'application/pdf', size: 8, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7').buffer };
    const DEP = 'POST /v1/location/candidatures/c3/fichiers/piece?holder=candidat';
    const options = (t: Awaited<ReturnType<typeof run>>, label: string) => t.input(label).children.map((o) => o.textContent);

    it('[R201] servi à part, chargé au premier geste ; budget tenu ; rien n’est offert une fois le choix fait', async () => {
      const t = await run();
      await t.openL1();
      expect(t.scripts().filter((e) => e.attributes.src === '/app/louer-dossier.js')).toHaveLength(0);
      expect(budgetProblems({ html: '', js: LOUER_DOSSIER_SCRIPT }, BUDGETS.page)).toEqual([]);
      expect(budgetProblems({ html: '', js: LOUER_SCRIPT }, BUDGETS.page)).toEqual([]);
      const served = handleAgentApp(new Request('https://aimmo.example.test/app/louer-dossier.js'))!;
      expect(await served.text()).toBe(LOUER_DOSSIER_SCRIPT);
      const done = await run({ 'GET /v1/location/l1/presentation': ok({ presentation: PRES, chosenApplicationId: 'c1' }) });
      await done.openL1();
      expect(done.byText('Compléter ce dossier')).toBeUndefined();
    });

    it('[R104] seules les pièces officielles, selon qui les fournit ; aucune pièce d’identité ; aucun nom de garant', async () => {
      const t = await run();
      await t.openL1();
      await t.openDossier(0);
      const candidate = options(t, 'La pièce');
      expect(candidate).toContain('Trois derniers bulletins de salaire');
      expect(candidate.join(' ')).not.toMatch(/identité|passeport/i);
      expect(candidate).not.toContain('Dernière quittance de loyer');
      const t2 = await run();
      await t2.openL1();
      // Un dossier DossierFacile est accepté tel quel : il n'a pas le geste [R104], donc le dossier c2 est le deuxième à l'offrir.
      expect(t2.body().all().filter((e) => e.tagName === 'button' && e.textContent === 'Compléter ce dossier')).toHaveLength(2);
      await t2.openDossier(1);
      expect(t2.byText('Garant Visale')).toBeUndefined();
      expect(options(t2, 'Qui fournit la pièce')).toEqual(['Le candidat', 'Garant Visale']);
      const who = t2.input('Qui fournit la pièce');
      who.value = 'g2';
      who.listeners.change!({});
      expect(options(t2, 'La pièce').filter((x) => x !== 'Choisir la pièce').length).toBeGreaterThan(0);
      expect(options(t2, 'La pièce')).not.toContain('Trois derniers bulletins de salaire');
    });

    it('[R105] la pièce part avec sa référence et son empreinte ; l’ordre d’arrivée ne bouge pas ; le dossier reste ouvert', async () => {
      const t = await run({ [DEP]: ok({ kind: 'piece', ref: 'location/l1/candidatures/c3/r.pdf', sha256: SHA_PDF, size: 8 }), 'POST /v1/location/candidatures/c3/pieces': ok({ category: 'ressources' }) });
      await t.openL1();
      await t.openDossier(0);
      await t.click(t.byText('Ranger la pièce'));
      expect(t.state()).toBe('Choisissez d’abord la pièce.');
      t.input('La pièce').value = 'bulletins_salaire';
      await t.click(t.byText('Ranger la pièce'));
      expect(t.state()).toBe('Choisissez d’abord le fichier.');
      expect(t.posts()).toHaveLength(0);
      (t.input('Le fichier') as unknown as { files: unknown[] }).files = [FILE];
      await t.click(t.byText('Ranger la pièce'));
      expect(t.posts()[1]).toMatchObject({ url: '/v1/location/candidatures/c3/pieces', body: JSON.stringify({ holder: 'candidat', sort: 'bulletins_salaire', ref: 'location/l1/candidatures/c3/r.pdf', sha256: SHA_PDF }) });
      expect(t.state()).toBe('Pièce rangée.');
      const arrivals = t.body().all().filter((e) => e.tagName === 'strong' && /^Dossier arrivé/.test(e.textContent ?? '')).map((e) => e.textContent);
      expect(arrivals[0]).toContain('en 3ᵉ');
      expect(t.byText('Ranger la pièce')).toBeDefined();
    });

    it('[R95] W19 : le dépôt dit à qui est la pièce ; changer de titulaire redépose le fichier pour le bon', async () => {
      const dep = (holder: string) => `POST /v1/location/candidatures/c2/fichiers/piece?holder=${holder}`;
      const t = await run({
        [dep('candidat')]: ok({ kind: 'piece', ref: 'location/l1/candidatures/c2/c.pdf', sha256: SHA_PDF, size: 8 }),
        [dep('g2')]: ok({ kind: 'piece', ref: 'location/l1/candidatures/c2/g.pdf', sha256: SHA_PDF, size: 8 }),
        'POST /v1/location/candidatures/c2/pieces': no(409, { ok: false, rule: 'R104', code: 'one_domicile' }),
      });
      await t.openL1();
      await t.openDossier(1);
      t.input('La pièce').value = 'bulletins_salaire';
      (t.input('Le fichier') as unknown as { files: unknown[] }).files = [FILE];
      await t.click(t.byText('Ranger la pièce'));
      await t.click(t.byText('Ranger la pièce'));
      expect(t.posts().filter((c) => c.url.includes('/fichiers/piece')).map((c) => c.url)).toEqual(['/v1/location/candidatures/c2/fichiers/piece?holder=candidat']);
      const who = t.input('Qui fournit la pièce');
      who.value = 'g2';
      who.listeners.change!({});
      t.input('La pièce').value = 'visa_visale';
      await t.click(t.byText('Ranger la pièce'));
      expect(t.posts().filter((c) => c.url.includes('/fichiers/piece')).map((c) => c.url)).toEqual(['/v1/location/candidatures/c2/fichiers/piece?holder=candidat', '/v1/location/candidatures/c2/fichiers/piece?holder=g2']);
      expect(t.posts().at(-1)!.body).toContain('location/l1/candidatures/c2/g.pdf');
    });

    describe('W21 · l’identité, depuis le dossier', () => {
      const VAULT = 'POST /v1/conformite/personnes/personne-secrete-3/coffre?sorte=passeport&verifie=2027-07-10';
      const fill = (t: Awaited<ReturnType<typeof run>>) => {
        t.input('La pièce vue').value = 'passeport';
        t.input('Vérifiée le').value = '2027-07-10';
        (t.input('Le fichier de la pièce') as unknown as { files: unknown[] }).files = [FILE];
      };

      it('[R15] la pièce part au coffre par sa route, jamais au dossier ; ni sa sorte ni son empreinte à l’écran', async () => {
        const t = await run({ [VAULT]: ok({}) });
        await t.openL1();
        await t.openDossier(0);
        expect(t.body().textContent).toContain('Le candidat : identité à vérifier');
        fill(t);
        await t.click(t.byText('Déposer au coffre'));
        const sent = t.posts().filter((c) => c.url.includes('/coffre'));
        expect(sent.map((c) => c.url)).toEqual(['/v1/conformite/personnes/personne-secrete-3/coffre?sorte=passeport&verifie=2027-07-10']);
        expect(t.posts().filter((c) => c.url.includes('/location/'))).toHaveLength(0);
        expect(t.state()).toBe('Pièce déposée au coffre.');
        // Aucune pièce d'identité dans la liste de celles du dossier.
        expect(options(t, 'La pièce').join(' ')).not.toMatch(/identité|passeport/i);
      });

      it('[R13] une identité vérifiée : le fait et sa date, sans la sorte, sans formulaire', async () => {
        const verified = [{ ...APPS[0]!, identityVerifiedOn: { candidat: '2027-07-10' } }, APPS[1]!, APPS[2]!];
        const t = await run({ 'GET /v1/location/l1/candidatures': ok(verified) });
        await t.openL1();
        await t.openDossier(0);
        const text = t.body().textContent ?? '';
        expect(text).toContain('Le candidat : identité vérifiée le 10/07/2027');
        expect(text).not.toContain('identité à vérifier');
        expect(t.byText('Déposer au coffre')).toBeUndefined();
        expect(text).not.toMatch(/Passeport|Carte d’identité|Empreinte/);
      });

      it('[R16] un refus de droits, un coffre fermé, une date à venir et une réponse perdue sont dits en français ; rien ne part sans date ni fichier', async () => {
        const t = await run({ [VAULT]: no(403, { ok: false, rule: 'R90', code: 'role' }) });
        await t.openL1();
        await t.openDossier(0);
        await t.click(t.byText('Déposer au coffre'));
        expect(t.state()).toBe('Dites d’abord quand la pièce a été vérifiée.');
        t.input('Vérifiée le').value = '2027-07-10';
        await t.click(t.byText('Déposer au coffre'));
        expect(t.state()).toBe('Choisissez d’abord le fichier.');
        expect(t.posts()).toHaveLength(0);
        fill(t);
        await t.click(t.byText('Déposer au coffre'));
        expect(t.state()).toBe('Le dépôt au coffre revient à l’agent de cette fiche ou au responsable de la conformité.');
        t.table[VAULT] = no(503, { ok: false, rule: null, code: 'vault_not_configured' });
        fill(t);
        await t.click(t.byText('Déposer au coffre'));
        expect(t.state()).toBe('Le coffre n’est pas encore ouvert : aucune pièce ne peut y être déposée pour le moment.');
        t.table[VAULT] = no(400, { ok: false, rule: null, code: 'bad_date' });
        fill(t);
        await t.click(t.byText('Déposer au coffre'));
        expect(t.state()).toBe('La date de vérification n’est pas valable : elle ne peut pas être dans l’avenir.');
        delete t.table[VAULT];
        fill(t);
        await t.click(t.byText('Déposer au coffre'));
        expect(t.state()).toBe('Réponse perdue : la pièce est peut-être au coffre. Rouvrez le logement avant de recommencer.');
      });

      it('[R15] la pièce d’un garant part sur la fiche du garant ; le candidat vérifié n’est plus proposé', async () => {
        const withGuarantor = [{ ...APPS[0]!, identityVerifiedOn: { candidat: '2027-07-10' }, guarantors: [{ guarantorId: 'g9', kind: 'personne', personId: 'personne-secrete-9' }] }, APPS[1]!, APPS[2]!];
        const path = 'POST /v1/conformite/personnes/personne-secrete-9/coffre?sorte=passeport&verifie=2027-07-10';
        const t = await run({ 'GET /v1/location/l1/candidatures': ok(withGuarantor), [path]: ok({}) });
        await t.openL1();
        await t.openDossier(0);
        expect(t.body().textContent).toContain('Garant 1 : identité à vérifier');
        expect(options(t, 'Pour qui')).toEqual(['Garant 1']);
        fill(t);
        await t.click(t.byText('Déposer au coffre'));
        expect(t.posts().filter((c) => c.url.includes('/coffre')).map((c) => c.url)).toEqual(['/v1/conformite/personnes/personne-secrete-9/coffre?sorte=passeport&verifie=2027-07-10']);
      });

      it('[R201] le script du dossier tient toujours son budget', () => {
        expect(budgetProblems({ html: '', js: LOUER_DOSSIER_SCRIPT }, BUDGETS.page)).toEqual([]);
      });
    });

    it('[R104] un refus du serveur est dit en français, sans code ; une réponse perdue est dite telle', async () => {
      const t = await run({ [DEP]: ok({ kind: 'piece', ref: 'location/l1/candidatures/c3/r.pdf', sha256: SHA_PDF, size: 8 }), 'POST /v1/location/candidatures/c3/pieces': no(409, { ok: false, rule: 'R104', code: 'one_domicile' }) });
      await t.openL1();
      await t.openDossier(0);
      t.input('La pièce').value = 'bulletins_salaire';
      (t.input('Le fichier') as unknown as { files: unknown[] }).files = [FILE];
      await t.click(t.byText('Ranger la pièce'));
      expect(t.state()).toBe('Un seul justificatif de domicile par personne : il est déjà rangé.');
      // Le même fichier ne se redépose pas : la référence est gardée.
      delete t.table['POST /v1/location/candidatures/c3/pieces'];
      await t.click(t.byText('Ranger la pièce'));
      expect(t.state()).toBe('Réponse perdue : ce geste est peut-être rangé. Rouvrez le logement avant de recommencer.');
      expect(t.posts().filter((c) => c.url.includes('/fichiers/piece'))).toHaveLength(1);
    });

    it('[R104] une personne qui a déjà son justificatif de domicile ne se le voit plus proposer ; un double appui n’ajoute qu’un garant', async () => {
      const apps = [{ ...APPS[0]!, pieces: [{ holder: 'candidat', category: 'domicile', sort: 'attestation_hebergement', label: 'Attestation d’hébergement' }] }];
      let answer: (r: Response) => void = () => undefined;
      const t = await run({ 'GET /v1/location/l1/candidatures': ok(apps), 'POST /v1/location/candidatures/c3/garants': () => new Promise<Response>((r) => { answer = r; }) });
      await t.openL1();
      await t.openDossier(0);
      expect(options(t, 'La pièce')).not.toContain('Trois dernières quittances de loyer');
      expect(options(t, 'La pièce')).toContain('Trois derniers bulletins de salaire');
      const visale = t.byText('Garant Visale')!;
      visale.listeners.click!({});
      visale.listeners.click!({});
      await t.settle();
      expect(t.posts()).toHaveLength(1);
      answer(Response.json({ ok: true, mode: 'essai', data: { guarantorId: 'g9' } }));
      await t.settle();
    });

    it('[R16] un garant Visale s’ajoute d’un geste ; un garant personne se choisit parmi ses contacts, lus au geste ; un refus de droits est dit', async () => {
      const t = await run({
        'POST /v1/location/candidatures/c3/garants': ok({ guarantorId: 'g9' }),
        'GET /v1/location/l1/contacts': ok({ contacts: [{ personId: 'p9', firstName: 'Garant', lastName: 'Inventé' }], more: false }),
      });
      await t.openL1();
      await t.openDossier(0);
      expect(t.calls.some((c) => c.url.endsWith('/contacts'))).toBe(false);
      await t.click(t.byText('Garant Visale'));
      expect(t.posts()[0]).toMatchObject({ url: '/v1/location/candidatures/c3/garants', body: JSON.stringify({ kind: 'visale' }) });
      expect(t.state()).toBe('Garant ajouté.');
      await t.click(t.byText('Choisir un garant parmi mes contacts'));
      await t.click(t.byText('Ajouter ce garant'));
      expect(t.state()).toBe('Choisissez d’abord la personne.');
      t.input('Le garant').value = 'p9';
      await t.click(t.byText('Ajouter ce garant'));
      expect(t.posts()[1]).toMatchObject({ body: JSON.stringify({ kind: 'personne', personId: 'p9' }) });
      t.table['POST /v1/location/candidatures/c3/garants'] = no(403, { ok: false, rule: 'R16', code: 'not_assigned' });
      await t.click(t.byText('Garant Visale'));
      expect(t.state()).toBe('Ce geste n’est pas dans vos droits.');
    });
  });
});

describe('W25 · lire l’exemplaire signé de l’état des lieux', () => {
  const CLOSED = 'c0c0c0c0-0000-4000-8000-000000000001';
  const SIGNED_LEASE = { leaseId: 'b1', mode: 'essai', complete: true, bailleur: '2027-07-12T09:00:00.000Z', locataire: '2027-07-12T09:05:00.000Z', copiesSent: [] };
  const SUIVI = ok({ facts: FACTS, fees: null, lease: SIGNED_LEASE, inventoryClosed: true, closedInventoryId: CLOSED, handedOn: null });
  const URL_COPY = `/v1/location/etats-des-lieux/${CLOSED}/exemplaires/bailleur`;
  const GO = 'Lire l’exemplaire signé';
  const open = async (copy: Answer) => {
    const t = await run({ 'GET /v1/location/l1/suivi': SUIVI, [`GET ${URL_COPY}`]: copy });
    await t.openL1();
    return t;
  };

  it('[R16] rien n’est lu avant le geste ; le texte reste du texte', async () => {
    const t = await open(ok({ content: `Bailleur ${INJECTED}`, contentSha256: 'a'.repeat(64), photos: [] }));
    expect(t.calls.some((c) => c.url === URL_COPY)).toBe(false);
    await t.click(t.byText(GO));
    expect(t.body().textContent).toContain(`Bailleur ${INJECTED}`);
    expect(t.body().textContent).toContain('a'.repeat(64));
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(t.state()).toBe('');
  });

  it('[R10] un second appui ne double pas le texte ; un refus retire l’ancien texte', async () => {
    const t = await open(ok({ content: 'Texte de l’exemplaire', contentSha256: 'a'.repeat(64), photos: [] }));
    await t.click(t.byText(GO));
    await t.click(t.byText(GO));
    expect(t.body().textContent.split('Texte de l’exemplaire')).toHaveLength(2);
    t.table[`GET ${URL_COPY}`] = no(409, { ok: false, rule: 'R106', code: 'document_changed' });
    await t.click(t.byText(GO));
    expect(t.body().textContent).not.toContain('Texte de l’exemplaire');
    expect(t.state()).toBe('Cet exemplaire ne correspond plus à ce qui a été signé : il n’est pas montré. Prévenez la direction.');
  });

  it('[R16] un exemplaire hors des droits est dit, sans texte', async () => {
    const t = await open(no(403, { ok: false, rule: 'R16', code: 'not_assigned' }));
    await t.click(t.byText(GO));
    expect(t.state()).toBe('Cet exemplaire n’est pas dans vos droits : il porte l’identité des deux parties.');
  });

  it('[R10] pas de réseau : dit tel, et le geste reste possible', async () => {
    const t = await open(async () => { throw new TypeError('coupé'); });
    await t.click(t.byText(GO));
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.byText(GO)).toBeDefined();
  });

  it('[R16] sans identifiant valable, pas de geste', async () => {
    const t = await run({ 'GET /v1/location/l1/suivi': ok({ facts: FACTS, fees: null, lease: SIGNED_LEASE, inventoryClosed: true, closedInventoryId: INJECTED, handedOn: null }) });
    await t.openL1();
    expect(t.byText(GO)).toBeUndefined();
    expect(t.body().textContent).toContain('Signé des deux parties');
  });

  it('[R201] le script tient le budget d’une page', () => {
    expect(budgetProblems({ html: '', js: LOUER_SCRIPT }, BUDGETS.page)).toEqual([]);
  });
});
