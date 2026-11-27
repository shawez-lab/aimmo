import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { promisesMandates } from '../../core/src/mandats/gagner/promesse.ts';
import { GAGNER_HOME_HTML, GAGNER_HTML, GAGNER_SCRIPT } from '../app/gagner.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : personnes, biens, adresses, communes, chiffres, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const file = (text: string): Answer => async () => new Response(text, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

const DOSSIER = {
  generatedAt: '2027-10-12T08:00:00.000Z',
  period: { from: '2026-10-12', to: '2027-10-12' },
  welcome: `Voici ce que je vous propose. ${INJECTED}`,
  welcomeBy: 'code',
  // Des chiffres impossibles à retrouver par un calcul : l'écran montre ceux du serveur, tels quels.
  sales: { source: 'DVF, publication d’octobre 2027', latestUsedSale: '2027-06', recentMissing: true, dvfNotCovered: false, validatedOn: '2027-10-01', items: [{ month: '2027-05', surfaceM2: 87, pricePerM2: 2913, distanceM: 350 }] },
  plan: ['Photos et plan préparés dans le Studio.', 'Compte rendu après chaque visite.'],
  commitments: [{ code: 'cr', version: 3, label: 'Compte rendu de visite sous 24 h', rule: 'Mesuré sur les comptes rendus validés.', delayHours: 24, kept: 7, total: 9, rate: 7 / 9, proof: [{ day: '2027-09-02', kept: true }, { day: '2027-09-09', kept: false }] }],
  reviews: { link: null, source: 'Réponses de satisfaction', count: 4, average: 4.5, answers: [] },
  results: { source: 'Base AIMMO', mandates: 11, sales: 6, estimationsHonored: 13 },
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/gagner/rendez-vous': ok([
    { appointmentId: 'r2', startAt: '2027-10-12T07:00:00.000Z', endAt: '2027-10-12T08:00:00.000Z', reference: 'T-9', city: 'Commune Une' },
    { appointmentId: 'r1', startAt: '2027-10-14T12:30:00.000Z', endAt: '2027-10-14T13:30:00.000Z', reference: INJECTED, city: null },
  ]),
  'GET /v1/gagner/rendez-vous/r1/dossier': ok(DOSSIER),
  'GET /v1/gagner/rendez-vous/r1/dossier/page': file('<!doctype html><title>Dossier</title>'),
  'GET /v1/gagner/recommandations/a-appeler': ok([{ origin: 'partner', recommendationId: 'rec1', personId: 'per1', firstName: INJECTED, sourceLabel: 'Recommandé par Étude Essai', channel: 'phone', dueAt: '2027-10-13T08:00:00.000Z' }]),
  'POST /v1/gagner/recommandations/rec1/appel-fait': ok({ done: true }),
  'GET /v1/gagner/relances': ok([{ followupId: 'f1', personId: 'per2', firstName: 'Inès', reason: 'fin_de_bail', reasonLabel: 'Fin de bail connue dans les 90 jours', reasonDay: '2027-11-20', draft: 'Bonjour Inès, votre bail se termine bientôt : voulez-vous en parler ?', draftBy: 'ia' }]),
  'POST /v1/gagner/relances/f1/valider': ok({ status: 'essai', rule: null, delivered: false }),
  'GET /v1/gagner/lettres': ok({
    campaigns: [{ campaignId: 'c1', propertyId: 'b1', reference: 'T-1', trigger: 'mandat', recipient: 'aux_habitants', createdAt: '2027-10-10T08:00:00.000Z', letters: 3, deposited: 1 }],
    properties: [
      { propertyId: 'b1', reference: 'T-1', city: 'Commune Une', triggers: ['mandat'] },
      { propertyId: 'b2', reference: 'T-2', city: 'Commune Deux', triggers: ['vente'] },
    ],
  }),
  'POST /v1/gagner/lettres': ok({ campaignId: 'c2', letters: 2, textBy: 'secours' }),
  'GET /v1/gagner/lettres/c1': ok([
    { letterId: 'l1', number: '10', street: 'rue des Essais', postcode: '99000', city: 'Commune Une', distanceM: 120, depositedAt: '2027-10-11T09:00:00.000Z' },
    { letterId: 'l2', number: '12', street: INJECTED, postcode: '99000', city: 'Commune Une', distanceM: 140, depositedAt: null },
  ]),
  'POST /v1/gagner/lettres/lettre/l2/deposee': ok({ depositedAt: '2027-10-12T08:00:00.000Z' }),
  'GET /v1/gagner/lettres/c1/impression': file('<!doctype html><title>Lettres</title>'),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const downloads: string[] = [];
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    URL: { createObjectURL: () => 'blob:essai', revokeObjectURL: () => undefined },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  // Chaque lien de téléchargement posé puis cliqué : son nom de fichier.
  const append = page.body.appendChild.bind(page.body);
  page.body.appendChild = (child: FakeElement) => {
    child.click = () => downloads.push(child.attributes.download ?? (child as unknown as { download: string }).download);
    return append(child);
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['gagner-corps']!;
  const state = () => els['gagner-etat']!.textContent;
  const byText = (text: string, nth = 0) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text)[nth];
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const input = (label: string, nth = 0) => {
    const l = body().all().filter((e) => e.tagName === 'label' && e.textContent === label)[nth];
    if (!l) throw new Error(`libellé absent : ${label}`);
    return body().all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const scripts = () => els.gagner!.children.filter((e) => e.tagName === 'script');
  const loadScript = async () => {
    const s = scripts();
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/gagner.js']);
    runInNewContext(GAGNER_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  const ouvrir = async () => {
    await click(els['gagner-ouvrir']);
    if (scripts().length === 1 && !body().children.length) await loadScript();
  };
  return { els, calls, context, byText, click, input, body, state, posts, scripts, loadScript, ouvrir, downloads, storage };
}

/** Le texte visible d'un morceau de HTML : sans balises ni attributs. */
const visible = (html: string): string => html.replace(/<[^>]+>/g, ' ');
/** Les chaînes d'un script : ce qui peut finir à l'écran. */
const strings = (js: string): string[] => [...js.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]!);

describe('G13 · écran « Gagner des mandats » de l’application', () => {
  it('[R16] l’écran ne lit et n’écrit que par les routes /v1/gagner, la clé dans l’en-tête seul', async () => {
    const t = await run();
    await t.ouvrir();
    await t.click(t.byText('Appel fait'));
    await t.click(t.byText('Je l’ai relue : valider'));
    await t.click(t.byText('Ouvrir le dossier', 1));
    await t.click(t.byText('Télécharger le dossier à montrer au client'));
    await t.ouvrir();
    await t.click(t.byText('Ouvrir la tournée'));
    await t.click(t.byText('Déposée'));
    await t.click(t.byText('Télécharger les lettres à imprimer'));
    const screen = t.calls.filter((c) => !/^\/v1\/(moi|plan-du-jour|alertes-agent|contacts-chauds|rendez-vous\/jour|usage|annonces$|offres\/a-tenir|apres-vente)/.test(c.url));
    expect(screen.length).toBeGreaterThanOrEqual(14);
    for (const c of screen) {
      expect(c.url.startsWith('/v1/gagner/'), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    // Le script ne nomme aucune autre route.
    const routes = [...GAGNER_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(6);
    for (const r of routes) expect(r.startsWith('/v1/gagner/'), r).toBe(true);
    expect(t.downloads).toEqual(['dossier-de-presentation.html', 'lettres-T-1.html']);
  });

  it('[R145] aucun texte de l’écran, ni de l’application, ne promet de mandats', () => {
    const texts = [visible(GAGNER_HOME_HTML), visible(GAGNER_HTML), ...strings(GAGNER_SCRIPT), visible(HTML), ...strings(JS)];
    for (const [path, f] of Object.entries(AGENT_APP_FILES)) if (path.endsWith('.js')) texts.push(...strings(f));
    expect(texts.length).toBeGreaterThan(500);
    expect(texts.filter((x) => promisesMandates(x))).toEqual([]);
    // Le contrôle voit bien une promesse posée dans un écran.
    expect(promisesMandates(visible(GAGNER_HOME_HTML.replace('Gagner des mandats</button>', 'Gagner des mandats</button><p>5 mandats par mois garantis</p>')))).toBe(true);
  });

  it('[R35] [R46] les quatre parties dans l’ordre reçu, chaque texte reçu reste du texte, aucune donnée du client hors du prénom', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.els.gagner!.hidden).toBe(false);
    expect(t.els.accueil!.hidden).toBe(true);
    const titles = t.body().children.filter((e) => e.tagName === 'section').map((e) => e.children[0]!.textContent);
    expect(titles).toEqual(['Mes estimations à venir (2)', 'Recommandations à appeler (1)', 'Relances à valider (1)', 'Lettres de quartier (1)', 'Annonces de particuliers', 'Ma tournée de prospection', 'Veille des diagnostics énergétiques', 'Mon site', 'Calendrier de publication', 'Programmes neufs', 'Viager']);
    const text = t.body().textContent;
    // L'ordre reçu du serveur est gardé : r2 puis r1, sans retri.
    expect(text.indexOf('Bien T-9')).toBeLessThan(text.indexOf(`Bien ${INJECTED}`));
    expect(text).toContain('Recommandé par Étude Essai · accord pour Téléphone');
    expect(text).toContain('Fin de bail connue dans les 90 jours');
    expect(text).toContain('1 déposée(s) sur 3');
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(text).toContain(INJECTED);
    const meter = t.body().all().find((e) => e.tagName === 'meter')!;
    expect(meter.attributes).toMatchObject({ min: '0', max: '3', value: '1', 'aria-label': '1 lettres déposées sur 3' });
    // Chaque champ a son libellé, pour les lecteurs d'écran.
    for (const f of t.body().all().filter((e) => ['input', 'textarea', 'select'].includes(e.tagName))) {
      expect(t.body().all().some((l) => l.tagName === 'label' && l.attributes.for === f.attributes.id), f.attributes.id).toBe(true);
    }
  });

  it('[R141] le dossier montre les chiffres du serveur avec leur source, et ce qui a été tenu, cas par cas', async () => {
    const t = await run();
    await t.ouvrir();
    await t.click(t.byText('Ouvrir le dossier', 1));
    expect(t.calls.some((c) => c.url === '/v1/gagner/rendez-vous/r1/dossier')).toBe(true);
    const text = t.body().textContent;
    expect(text).toContain('Source : DVF, publication d’octobre 2027. Avis validé le 2027-10-01. Les ventes les plus récentes ne sont pas encore publiées.');
    expect(text).toContain('2027-05 · 87 m² · 2913 €/m² · à 350 m');
    expect(text).toContain('Tenu 7 fois sur 9');
    expect(text).toContain('2027-09-09 : non tenu');
    expect(text).toContain('4 avis, note moyenne 4,5 sur 5.');
    expect(text).toContain('11 mandats signés · 6 ventes conclues · 13 estimations tenues');
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(t.state()).toBe('Chaque chiffre vient de la base, avec sa source. Aucune promesse de prix ni de délai.');
    // Le retour ramène à la liste de l'écran, puis à la journée.
    await t.click(t.els['gagner-retour']);
    expect(t.body().textContent).toContain('Mes estimations à venir');
    await t.click(t.els['gagner-retour']);
    expect(t.els.accueil!.hidden).toBe(false);
  });

  it('[R143] [R26] la relance : texte proposé relu, envoyé seulement s’il change ; validée, rien ne part en essai', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.input('Texte de la relance, proposé, à relire', 0).value).toContain('votre bail se termine');
    await t.click(t.byText('Je l’ai relue : valider'));
    expect(JSON.parse(t.posts().find((c) => c.url === '/v1/gagner/relances/f1/valider')!.body!)).toEqual({});
    expect(t.state()).toBe('Relance validée. En essai, rien ne part.');
    const u = await run({ 'POST /v1/gagner/relances/f1/valider': no(409, { ok: false, rule: 'R03', code: 'no_consent_on_channel' }) });
    await u.ouvrir();
    u.input('Texte de la relance, proposé, à relire').value = 'Bonjour, je reviens vers vous pour votre projet, à votre rythme.';
    u.input('Canal').value = 'sms';
    await u.click(u.byText('Je l’ai relue : valider'));
    expect(JSON.parse(u.posts()[0]!.body!)).toEqual({ text: 'Bonjour, je reviens vers vous pour votre projet, à votre rythme.', channel: 'sms' });
    expect(u.state()).toBe('Pas d’accord en cours sur ce canal : choisissez-en un autre.');
    const w = await run({ 'POST /v1/gagner/relances/f1/valider': ok({ status: 'attente', rule: 'R01', delivered: false }) });
    await w.ouvrir();
    await w.click(w.byText('Je l’ai relue : valider'));
    expect(w.state()).toBe('Hors des heures d’envoi : la relance reste à valider.');
    const x = await run({ 'POST /v1/gagner/relances/f1/valider': no(409, { ok: false, rule: 'R143', code: 'no_basis_R97' }) });
    await x.ouvrir();
    await x.click(x.byText('Je l’ai relue : valider'));
    expect(x.state()).toBe('La personne n’a plus de base légale pour être relancée : la relance est close.');
  });

  it('[R140] une campagne : adresses lues ligne par ligne, jamais un nom, l’origine « saisie par l’agent » ; la ligne refusée est nommée', async () => {
    const t = await run();
    await t.ouvrir();
    t.input('Adresse du bien, pour vérifier le rayon').value = '8 rue des Essais, 99000 Commune Une';
    t.input('Adresses voisines que vous avez relevées, une par ligne : numéro, voie, code postal, commune').value = '10 rue des Essais, 99000 Commune Une\n\n12 bis rue des Essais 99000 Commune Une\n';
    await t.click(t.byText('Préparer les lettres'));
    expect(JSON.parse(t.posts().find((c) => c.url === '/v1/gagner/lettres')!.body!)).toEqual({
      propertyId: 'b1',
      trigger: 'mandat',
      propertyAddress: '8 rue des Essais, 99000 Commune Une',
      recipient: 'aux_habitants',
      origin: 'saisie_agent',
      addresses: [
        { number: '10', street: 'rue des Essais', postcode: '99000', city: 'Commune Une' },
        { number: '12 bis', street: 'rue des Essais', postcode: '99000', city: 'Commune Une' },
      ],
    });
    expect(t.state()).toBe('2 lettre(s) prête(s) à imprimer.');
    // Le destinataire est une liste fermée : jamais un nom.
    const to = t.input('Destinataire');
    expect(to.children.map((o) => o.textContent)).toEqual(['Au propriétaire', 'Aux habitants']);
    // Une ligne illisible n'envoie rien ; un événement que le bien n'a pas non plus.
    const u = await run();
    await u.ouvrir();
    u.input('Adresses voisines que vous avez relevées, une par ligne : numéro, voie, code postal, commune').value = '10 rue des Essais, 99000 Commune Une\nMadame Essai';
    await u.click(u.byText('Préparer les lettres'));
    expect(u.state()).toBe('Ligne 2 : écrivez numéro, voie, code postal et commune.');
    u.input('Événement').value = 'vente';
    await u.click(u.byText('Préparer les lettres'));
    expect(u.state()).toBe('Ce bien n’a pas cet événement : choisissez l’autre.');
    expect(u.posts()).toHaveLength(0);
    // Le refus du serveur nomme la ligne, en français.
    const v = await run({ 'POST /v1/gagner/lettres': no(409, { ok: false, rule: 'R140', code: 'out_of_radius', index: 1 }) });
    await v.ouvrir();
    v.input('Adresses voisines que vous avez relevées, une par ligne : numéro, voie, code postal, commune').value = '10 rue des Essais, 99000 Commune Une\n90 rue Lointaine, 99000 Commune Une';
    await v.click(v.byText('Préparer les lettres'));
    expect(v.state()).toBe('Ligne 2 : Adresse hors du rayon autour du bien.');
  });

  it('la tournée : chaque lettre, déposée une fois, avec ce qui reste à déposer', async () => {
    const t = await run();
    await t.ouvrir();
    await t.click(t.byText('Ouvrir la tournée'));
    const text = t.body().textContent;
    expect(text).toContain('10 rue des Essais');
    expect(text).toContain('Déposée le ');
    expect(t.body().all().filter((e) => e.tagName === 'button' && e.textContent === 'Déposée')).toHaveLength(1);
    expect(t.state()).toBe('1 lettre(s) encore à déposer.');
    await t.click(t.byText('Déposée'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/gagner/lettres/lettre/l2/deposee']);
    expect(t.state()).toBe('Dépôt noté. 1 lettre(s) encore à déposer.');
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  describe('G16 · la direction attribue une recommandation sans agent', () => {
    const ITEM = { origin: 'partner', recommendationId: 'rec9', personId: 'per9', firstName: 'Hugo', sourceLabel: 'Recommandé par Étude Essai', channel: 'phone', dueAt: '2027-10-13T08:00:00.000Z', assignable: true };
    const AGENTS = [{ agentId: 'ag9', firstName: 'Alex', lastName: 'Agent' }, { agentId: 'ag1', firstName: INJECTED, lastName: 'Essai' }];
    const LIST = { 'GET /v1/gagner/recommandations/a-appeler': ok([ITEM]) };
    const POST = 'POST /v1/gagner/recommandations/rec9/attribuer';
    const ready = async (answers: Record<string, Answer> = {}) => {
      const t = await run({ ...LIST, 'GET /v1/gagner/recommandations/agents': ok(AGENTS), ...answers });
      await t.ouvrir();
      return t;
    };

    it('[R16] ni « Appel fait » ni liste d’agents lue d’avance : le geste charge la liste, dans l’ordre reçu, en texte', async () => {
      const t = await ready();
      expect(t.byText('Appel fait')).toBeUndefined();
      expect(t.calls.some((c) => c.url.endsWith('/recommandations/agents'))).toBe(false);
      await t.click(t.byText('Choisir l’agent'));
      const pick = t.input('Agent');
      // L'ordre reçu, ni trié par identifiant ni par nom ; le nom reste du texte, jamais du HTML.
      expect(pick.children.map((o) => o.attributes.value ?? (o as unknown as { value: string }).value)).toEqual(['', 'ag9', 'ag1']);
      expect(pick.children.map((o) => o.textContent)).toEqual(['Choisissez un agent', 'Alex Agent', `${INJECTED} Essai`]);
      expect(GAGNER_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    });

    it('[R16] sans choix, rien ne part ; le choix part, et l’écran relit la liste', async () => {
      let list = [ITEM];
      const t = await ready({ 'GET /v1/gagner/recommandations/a-appeler': async () => Response.json({ ok: true, data: list }), [POST]: async () => { list = []; return Response.json({ ok: true, data: { assigned: true } }); } });
      await t.click(t.byText('Choisir l’agent'));
      await t.click(t.byText('Attribuer'));
      expect(t.posts()).toHaveLength(0);
      expect(t.state()).toBe('Choisissez un agent.');
      t.input('Agent').value = 'ag9';
      await t.click(t.byText('Attribuer'));
      expect(t.posts().map((c) => [c.url, c.body])).toEqual([['/v1/gagner/recommandations/rec9/attribuer', JSON.stringify({ agentId: 'ag9' })]]);
      expect(t.state()).toContain('Recommandation attribuée');
      expect(t.byText('Attribuer')).toBeUndefined();
    });

    it('les refus sont dits en français, sans code ; la réponse perdue n’annonce rien', async () => {
      const cases: [string, string][] = [['already_assigned', 'déjà un agent'], ['bad_agent', 'dossier incomplet ou départ'], ['awaiting_handover', 'passation'], ['followed_by_other', 'déjà suivie']];
      for (const [code, text] of cases) {
        const t = await ready({ [POST]: no(409, { ok: false, rule: null, code }) });
        await t.click(t.byText('Choisir l’agent'));
        t.input('Agent').value = 'ag1';
        await t.click(t.byText('Attribuer'));
        expect(t.state()).toContain(text);
        expect(t.state()).not.toContain(code);
      }
      const lost = await ready();
      await lost.click(lost.byText('Choisir l’agent'));
      lost.input('Agent').value = 'ag1';
      await lost.click(lost.byText('Attribuer'));
      expect(lost.state()).toContain('rien n’est sûr');
      expect(lost.state()).not.toContain('attribuée');
    });

    it('un double appui n’envoie qu’une demande', async () => {
      let answer: (r: Response) => void = () => undefined;
      const t = await ready({ [POST]: () => new Promise<Response>((r) => { answer = r; }) });
      await t.click(t.byText('Choisir l’agent'));
      t.input('Agent').value = 'ag1';
      const b = t.byText('Attribuer')!;
      b.listeners.click!({});
      b.listeners.click!({});
      await settle();
      expect(t.posts()).toHaveLength(1);
      answer(Response.json({ ok: false, rule: null, code: 'bad_agent' }, { status: 409 }));
      await settle();
      // La réponse reçue, le geste redevient possible.
      b.listeners.click!({});
      await settle();
      expect(t.posts()).toHaveLength(2);
    });

    it('aucun agent en activité, ou liste perdue : c’est dit, rien n’est proposé', async () => {
      const empty = await ready({ 'GET /v1/gagner/recommandations/agents': ok([]) });
      await empty.click(empty.byText('Choisir l’agent'));
      expect(empty.body().all().map((e) => e.textContent).join(' ')).toContain('Aucun agent en activité');
      const off = await run(LIST);
      await off.ouvrir();
      await off.click(off.byText('Choisir l’agent'));
      expect(off.state()).toContain('Pas de réseau');
      expect(off.byText('Attribuer')).toBeUndefined();
    });
  });

  it('une partie qui manque est dite à part ; sans réseau, l’écran le dit ; une clé refusée au téléchargement efface tout', async () => {
    const t = await run({ 'GET /v1/gagner/relances': no(403, { ok: false, rule: 'R16', code: 'agent_file_incomplete' }) });
    await t.ouvrir();
    expect(t.body().textContent).toContain('Votre dossier d’agent est incomplet : la direction doit le compléter.');
    expect(t.body().textContent).toContain('Recommandations à appeler (1)');
    const u = await run({ 'GET /v1/gagner/rendez-vous': undefined as unknown as Answer, 'GET /v1/gagner/recommandations/a-appeler': undefined as unknown as Answer, 'GET /v1/gagner/relances': undefined as unknown as Answer, 'GET /v1/gagner/lettres': undefined as unknown as Answer });
    await u.ouvrir();
    expect(u.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    const w = await run({ 'GET /v1/gagner/lettres/c1/impression': no(401, { ok: false }) });
    await w.ouvrir();
    await w.click(w.byText('Ouvrir la tournée'));
    await w.click(w.byText('Télécharger les lettres à imprimer'));
    expect(w.downloads).toEqual([]);
    expect(w.els.connexion!.hidden).toBe(false);
    expect(w.storage.has('aimmo.cle')).toBe(false);
  });

  it('[R201] l’écran est un script à part, chargé une seule fois à sa première ouverture, jamais gardé sur l’appareil', async () => {
    expect(JS).not.toContain('GAGNER_REFUSALS');
    expect(JS).not.toContain('/v1/gagner');
    expect(AGENT_APP_SHELL).not.toContain('/app/gagner.js');
    expect(budgetProblems({ html: '', js: GAGNER_SCRIPT }, BUDGETS.page)).toEqual([]);
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/gagner.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(await served.text()).toBe(GAGNER_SCRIPT);
    const t = await run();
    await t.click(t.els['gagner-ouvrir']);
    expect(t.state()).toBe('Chargement…');
    expect(t.calls.some((c) => c.url.startsWith('/v1/gagner'))).toBe(false);
    await t.loadScript();
    expect(t.body().textContent).toContain('Mes estimations à venir');
    await t.click(t.els['gagner-retour']);
    await t.click(t.els['gagner-ouvrir']);
    expect(t.scripts()).toHaveLength(1);
    // La sortie efface l'écran : aucune donnée ne reste.
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toHaveLength(0);
  });

  it('sans réseau au chargement, l’écran le dit ; un script arrivé après un changement d’écran ne montre rien', async () => {
    const t = await run();
    await t.click(t.els['gagner-ouvrir']);
    t.scripts()[0]!.listeners.error!({});
    await new Promise((r) => setTimeout(r, 0));
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    const u = await run();
    await u.click(u.els['gagner-ouvrir']);
    await u.click(u.els['gagner-retour']);
    runInNewContext(GAGNER_SCRIPT, u.context);
    u.scripts()[0]!.listeners.load!({});
    await new Promise((r) => setTimeout(r, 0));
    expect(u.calls.some((c) => c.url.startsWith('/v1/gagner'))).toBe(false);
    expect(u.els.accueil!.hidden).toBe(false);
  });
});
