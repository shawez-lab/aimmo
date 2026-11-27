import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { promisesIncome } from '../../core/src/reseau/recrutement.ts';
import { CANDIDATURES_ENTRY_HTML, INTEGRATION_HOME_HTML, INTEGRATION_HTML, INTEGRATION_SCRIPT } from '../app/integration.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp, stripCommentLines } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : agents, candidats, coordonnées, modules, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown, extra: Record<string, unknown> = {}): Answer => async () => Response.json({ ok: true, mode: 'essai', data, ...extra });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const FILE = {
  agentId: 'ag1',
  complete: false,
  lines: [
    { kind: 'contrat_agent_commercial', label: 'Contrat d’agent commercial signé', state: 'valide', version: 1, issuedOn: '2027-07-01', validUntil: null },
    { kind: 'attestation_habilitation', label: 'Attestation d’habilitation délivrée par le titulaire de la carte', state: 'projet', version: 1, issuedOn: null, validUntil: null },
    { kind: 'immatriculation_rsac', label: 'Immatriculation au registre spécial des agents commerciaux', state: 'manquante', version: null, issuedOn: null, validUntil: null },
    { kind: 'assurance_rcp', label: 'Assurance de responsabilité civile professionnelle', state: 'echue', version: 1, issuedOn: '2026-07-01', validUntil: '2027-07-01' },
    { kind: 'attestation_vigilance', label: INJECTED, state: 'valide', version: 1, issuedOn: '2027-07-01', validUntil: '2028-01-01' },
  ],
  missing: ['immatriculation_rsac'],
  expired: ['assurance_rcp'],
  drafts: ['attestation_habilitation'],
  nextStep: 'Déposez votre attestation d’habilitation une fois signée.',
};
const SANDBOX = {
  agentId: 'ag1',
  steps: [
    { step: 'contact_recu', label: 'Contact reçu', done: true, at: '2027-07-12T08:00:00.000Z' },
    { step: 'qualification', label: 'Qualification', done: false, at: null },
  ],
  next: 'Qualifiez le contact inventé.',
  completed: false,
  countedAtAcademy: false,
};
const COUNTER = {
  agentId: 'ag1',
  startedOn: '2027-07-01',
  arrivedOn: '2027-07-01',
  periodSource: 'arrivee',
  obligations: [
    { obligation: 'annuelle', from: '2027-07-01', until: '2028-06-30', requiredMinutes: 840, doneMinutes: 150, declaredMinutes: 45, missingMinutes: 690, daysLeft: 354 },
    { obligation: 'deontologie', from: '2027-07-01', until: '2030-06-30', requiredMinutes: 120, doneMinutes: 120, declaredMinutes: 0, missingMinutes: 0, daysLeft: 1084 },
  ],
};
const TRACKS = [
  {
    track: 'entree',
    modules: [
      { id: 'm1', title: 'Déontologie du mandat', position: 1, videoId: 'abcdefghijk', durationMinutes: 120, topic: 'deontologie', mandatory: true, done: true },
      { id: 'm2', title: INJECTED, position: 2, videoId: 'javascript:x', durationMinutes: 30, topic: 'general', mandatory: false, done: false },
    ],
  },
];
// Dans l'ordre d'arrivée, tel que le serveur le donne : c2 est arrivée avant c1, elle reste devant [R81].
const CANDIDATES = [
  { id: 'c2', firstName: 'Zoé', lastName: 'Essai', email: 'zoe@exemple.test', phone: null, town: 'Commune Une', currentStatus: 'autre_metier', experience: 'aucune', question: null, source: 'page', sponsorAgentId: null, contactable: true, createdAt: '2027-07-01T08:00:00.000Z' },
  { id: 'c1', firstName: 'Adam', lastName: null, email: null, phone: '0600000000', town: null, currentStatus: 'agent_commercial', experience: 'plus_de_5_ans', question: INJECTED, source: 'parrain', sponsorAgentId: 'ag9', contactable: false, createdAt: '2027-07-02T08:00:00.000Z' },
];
const SHEET = {
  candidateId: 'c2',
  declared: { firstName: 'Zoé', lastName: 'Essai', town: 'Commune Une', currentStatus: 'autre_metier', experience: 'aucune', question: 'Comment se passe l’essai ?', source: 'page' },
  questions: ['Qu’est-ce qui vous amène vers le métier ?', 'Dans quel secteur souhaitez-vous travailler ?'],
  pieces: [{ kind: 'assurance_rcp', label: 'Assurance de responsabilité civile professionnelle' }],
  interviews: [{ interviewId: 'i1', scheduledAt: '2027-07-10T08:00:00.000Z', interviewer: 'Shawez', held: false }],
  decision: null,
};
const AGENT: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/reseau/mon-dossier': ok(FILE),
  'GET /v1/reseau/mon-referent': ok({ firstName: 'Bérénice', until: '2027-10-10', phone: '06 00 00 00 01', email: 'berenice@exemple.test' }),
  'GET /v1/reseau/mon-bac-a-sable': ok(SANDBOX),
  'GET /v1/reseau/ma-formation': ok(COUNTER),
  'GET /v1/reseau/academie': ok(TRACKS),
  'POST /v1/reseau/academie/modules/m2/fait': ok(null, { already: false }),
  'GET /v1/formation/agents/ag1/attestations': ok({ attestations: [] }),
};
const DIRECTION: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'direction', firstName: null }),
  'GET /v1/pilotage/reseau': ok({ from: '2027-07-01', to: '2027-07-31', totals: { contacts: 0, appointments: 0, mandates: 0, sales: 0 }, byAgent: [], byZone: [], bySource: { contacts: [], mandates: [] }, aiCosts: { totalCents: 0, byChannel: [], perSignedMandateCents: null } }),
  'GET /v1/pilotage/alertes': ok([]),
  'GET /v1/pilotage/reversements': ok([]),
  'GET /v1/pilotage/factures/brouillons': ok([]),
  'GET /v1/reseau/candidatures': ok(CANDIDATES),
  'GET /v1/reseau/candidatures/c2/entretien': ok(SHEET),
  'POST /v1/reseau/candidatures/c2/entretien': ok(null, { interviewId: 'i2' }),
  'POST /v1/reseau/entretiens/i1/tenu': ok(null),
  'POST /v1/reseau/candidatures/c2/decision': ok(null, { decision: 'oui', opensOnboarding: true }),
  'POST /v1/reseau/candidatures/c2/admettre': ok(null, { agentId: 'ag2' }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, base: Record<string, Answer> = AGENT) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...base, ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['integration-corps']!;
  const state = () => els['integration-etat']!.textContent;
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
  const scripts = () => els.integration!.children.filter((e) => e.tagName === 'script');
  const loadScript = async () => {
    const s = scripts();
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/integration.js']);
    runInNewContext(INTEGRATION_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  const ouvrir = async (button: 'integration-ouvrir' | 'academie-ouvrir' | 'candidatures-ouvrir') => {
    await click(els[button]);
    if (scripts().length === 1 && !body().children.length) await loadScript();
  };
  return { els, calls, context, byText, click, input, body, state, posts, scripts, loadScript, ouvrir, storage };
}

const visible = (html: string): string => html.replace(/<[^>]+>/g, ' ');
const strings = (js: string): string[] => [...js.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]!);
const sections = (t: Awaited<ReturnType<typeof run>>) => t.body().children.filter((e) => e.tagName === 'section').map((e) => e.children[0]!.textContent);

describe('J14 · écrans de M14 dans l’application', () => {
  it('[R16] chaque écran ne lit et n’écrit que par les routes /v1/reseau, la clé dans l’en-tête seul', async () => {
    const t = await run();
    await t.ouvrir('integration-ouvrir');
    await t.click(t.els['integration-retour']);
    await t.ouvrir('academie-ouvrir');
    await t.click(t.byText('J’ai fini ce module'));
    const d = await run({}, DIRECTION);
    await d.ouvrir('candidatures-ouvrir');
    await d.click(d.byText('Fiche d’entretien'));
    d.input('Personne qui a mené l’entretien').value = 'Shawez';
    await d.click(d.byText('Marquer tenu'));
    const screen = [...t.calls, ...d.calls].filter((c) => /^\/v1\/reseau\//.test(c.url) || !/^\/v1\/(moi|plan-du-jour|alertes-agent|contacts-chauds|rendez-vous\/jour|usage|annonces$|offres\/a-tenir|apres-vente|pilotage)/.test(c.url));
    expect(screen.length).toBeGreaterThanOrEqual(9);
    for (const c of screen) {
      expect(/^\/v1\/(reseau|formation)\//.test(c.url), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...INTEGRATION_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(6);
    for (const r of routes) expect(/^\/v1\/(reseau|formation)\//.test(r), r).toBe(true);
  });

  it('[R82] « Mon intégration » : chaque pièce et son état, l’étape suivante, le référent et le premier parcours ; tout texte reçu reste du texte', async () => {
    const t = await run();
    await t.ouvrir('integration-ouvrir');
    expect(t.els.integration!.hidden).toBe(false);
    expect(t.els['integration-titre']!.textContent).toBe('Mon intégration');
    expect(sections(t)).toEqual(['Mon dossier d’agent', 'Mon référent', 'Mon premier parcours']);
    const text = t.body().textContent;
    expect(text).toContain('Déposez votre attestation d’habilitation une fois signée.');
    expect(text).toContain('2 pièce(s) valide(s) sur 5');
    expect(text).toContain('Projet, à déposer signé');
    expect(text).toContain('Manquante');
    expect(text).toContain('Échue le ');
    expect(text).toContain('Valide jusqu’au ');
    expect(text).toContain('l’accès aux clients reste fermé');
    expect(text).toContain('Bérénice');
    expect(text).toContain('Votre référent jusqu’au ');
    // AU112 · un toucher pour joindre le référent, par ses coordonnées professionnelles.
    const links = t.body().all().filter((e) => e.tagName === 'a').map((e) => [e.textContent, e.attributes.href]);
    expect(links).toEqual(expect.arrayContaining([['Appeler Bérénice', 'tel:0600000001'], ['Écrire à Bérénice', 'mailto:berenice@exemple.test']]));
    expect(text).toContain('Contact reçu');
    expect(text).toContain('Qualifiez le contact inventé.');
    expect(text).toContain(INJECTED);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    const meter = t.body().all().find((e) => e.tagName === 'meter')!;
    expect(meter.attributes).toMatchObject({ min: '0', max: '5', value: '2', 'aria-label': '2 pièces valides sur 5' });
    // Le retour ramène à la journée.
    await t.click(t.els['integration-retour']);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.body().children).toHaveLength(0);
  });

  it('« Mon intégration » : sans référent, sans parcours ouvert, chaque partie le dit à part, sans rien inventer', async () => {
    const t = await run({
      'GET /v1/reseau/mon-referent': ok(null),
      'GET /v1/reseau/mon-bac-a-sable': no(409, { ok: false, rule: null, code: 'not_opened' }),
      'GET /v1/reseau/mon-dossier': ok({ ...FILE, complete: true, nextStep: 'Votre dossier est complet : l’accès à vos clients est ouvert.' }),
    });
    await t.ouvrir('integration-ouvrir');
    const text = t.body().textContent;
    expect(text).toContain('Pas encore de référent : la direction vous en attribue un pour vos 90 premiers jours.');
    // AU025 : un parcours pas encore ouvert s'ouvre depuis l'écran, par l'agent lui-même.
    expect(text).toContain('Un exercice à vous seul, sur un contact inventé');
    expect(t.byText('Ouvrir mon exercice')).toBeDefined();
    expect(text).not.toContain('l’accès aux clients reste fermé');
    const u = await run({ 'GET /v1/reseau/mon-bac-a-sable': no(503, { ok: false, rule: null, code: 'unavailable' }), 'GET /v1/reseau/mon-dossier': no(503, { ok: false, rule: null, code: 'unavailable' }) });
    await u.ouvrir('integration-ouvrir');
    expect(sections(u)).toEqual(['Mon dossier d’agent', 'Mon référent', 'Mon premier parcours']);
    expect(u.body().textContent).toContain('Pas encore en service.');
    expect(u.body().textContent).toContain('Bérénice');
    const w = await run({ 'GET /v1/reseau/mon-dossier': undefined as unknown as Answer, 'GET /v1/reseau/mon-referent': undefined as unknown as Answer, 'GET /v1/reseau/mon-bac-a-sable': undefined as unknown as Answer });
    await w.ouvrir('integration-ouvrir');
    expect(w.state()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('[R82] [R16] un agent au dossier incomplet garde sa clé : sa journée dit pourquoi elle est fermée, « Mon dossier » s’ouvre', async () => {
    const closed = no(403, { ok: false, rule: 'R82', code: 'agent_file_incomplete' });
    const t = await run({ 'GET /v1/plan-du-jour': closed, 'GET /v1/contacts-chauds': closed, 'GET /v1/rendez-vous/jour': closed, 'GET /v1/annonces': closed, 'GET /v1/apres-vente/journee': closed });
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.els.connexion!.hidden).toBe(true);
    expect(t.storage.get('aimmo.cle')).toBe(KEY);
    expect(t.els['plan-etat']!.textContent).toBe('Fermé tant que votre dossier d’agent est incomplet : ouvrez « Mon dossier », dans les outils.');
    await t.ouvrir('integration-ouvrir');
    expect(t.body().textContent).toContain('Mon dossier d’agent');
    await t.click(t.els['integration-retour']);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.storage.get('aimmo.cle')).toBe(KEY);
    // Un autre refus 403 reste une clé refusée : tout est effacé.
    const u = await run({ 'GET /v1/plan-du-jour': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    expect(u.els.connexion!.hidden).toBe(false);
    expect(u.storage.has('aimmo.cle')).toBe(false);
  });

  it('[R85] « Académie » : les heures du serveur, les modules faits, aucun horaire ; un module fini est noté puis recompté', async () => {
    const t = await run();
    await t.ouvrir('academie-ouvrir');
    expect(t.els['integration-titre']!.textContent).toBe('Académie');
    expect(sections(t)).toEqual(['Mes heures de formation', 'Parcours d’entrée', 'Mes attestations']);
    const text = t.body().textContent;
    // Les chiffres du serveur, tels quels : rien n'est recalculé ici.
    expect(text).toContain('2 h 30 sur 14 h');
    expect(text).toContain('Il reste 11 h 30 avant le ');
    expect(text).toContain('(354 jours)');
    expect(text).toContain('Obligation remplie pour la période');
    // AU027 : les heures déclarées sans quiz réussi sont dites à part, jamais ajoutées au compte.
    expect(text).toContain('Plus 0 h 45 déclarées sans justificatif : réussissez le quiz du module pour qu’elles comptent.');
    expect(text.match(/déclarées sans justificatif/g)).toHaveLength(1);
    // AU028 : rien n'est dit d'un cycle antérieur qui n'a pas été repris.
    expect(text).not.toContain('cycle d’avant');
    const repris = await run({ 'GET /v1/reseau/ma-formation': ok({ ...COUNTER, startedOn: '2025-09-01', periodSource: 'cycle_anterieur' }) });
    await repris.ouvrir('academie-ouvrir');
    expect(repris.body().textContent).toContain('Vos périodes continuent votre cycle d’avant votre arrivée, commencé le 01/09/2025 ; vos attestations d’avant y sont comptées.');
    expect(text).toContain('Aucun horaire imposé');
    expect(text).toContain('1 module(s) fait(s) sur 2');
    expect(text).toContain('120 min · déontologie · obligatoire');
    // Un seul bouton : le module déjà fait n'en a pas.
    expect(t.body().all().filter((e) => e.tagName === 'button' && e.textContent === 'J’ai fini ce module')).toHaveLength(1);
    // La vidéo s'ouvre par son seul identifiant reconnu ; un identifiant douteux ne donne aucun lien.
    const links = t.body().all().filter((e) => e.tagName === 'a');
    expect(links.map((a) => a.attributes.href)).toEqual(['https://www.youtube-nocookie.com/embed/abcdefghijk']);
    expect(links[0]!.attributes.rel).toBe('noopener noreferrer');
    expect(text).toContain(INJECTED);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    await t.click(t.byText('J’ai fini ce module'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/reseau/academie/modules/m2/fait']);
    expect(t.state()).toBe('Module noté : vos heures sont recomptées.');
    expect(t.calls.filter((c) => c.url === '/v1/reseau/ma-formation')).toHaveLength(2);
    const u = await run({ 'POST /v1/reseau/academie/modules/m2/fait': no(404, { ok: false, rule: null, code: 'unknown_module' }) });
    await u.ouvrir('academie-ouvrir');
    await u.click(u.byText('J’ai fini ce module'));
    expect(u.state()).toBe('Ce module n’existe plus : rouvrez l’académie.');
  });

  it('[R81] « Candidatures » : l’ordre d’arrivée tel que reçu, sans tri, sans filtre, sans note ; seule la direction y entre', async () => {
    const d = await run({}, DIRECTION);
    expect(d.els.reseau!.hidden).toBe(false);
    await d.ouvrir('candidatures-ouvrir');
    expect(d.els['integration-titre']!.textContent).toBe('Candidatures');
    expect(d.els['integration-retour']!.textContent).toBe('Retour au réseau');
    const text = d.body().textContent;
    expect(text).toContain('2 candidature(s)');
    expect(text.indexOf('Zoé Essai')).toBeLessThan(text.indexOf('Adam'));
    expect(text).toContain('Autre métier, aucune expérience de l’immobilier, venu par la page de recrutement.');
    expect(text).toContain('0600000000 · ne pas recontacter : pas d’accord');
    // Aucun tri, aucun filtre, aucune note : ni champ, ni liste de choix, ni étoile, ni chiffre de classement.
    const list = d.body().all();
    expect(list.filter((e) => ['input', 'select', 'textarea', 'meter', 'progress'].includes(e.tagName))).toEqual([]);
    expect(list.filter((e) => e.tagName === 'button').map((e) => e.textContent)).toEqual(['Fiche d’entretien', 'Fiche d’entretien']);
    expect(text).not.toMatch(/note|score|rang|trier|filtrer|★/i);
    for (const s of strings(INTEGRATION_SCRIPT)) expect(s).not.toMatch(/\bsort\b|score|ranking|filtrer|trier/i);
    expect(INTEGRATION_SCRIPT).not.toMatch(/\.sort\(|\.reverse\(/);
    // Le retour ramène à l'écran du réseau.
    await d.click(d.els['integration-retour']);
    expect(d.els.reseau!.hidden).toBe(false);
    // L'entrée des candidatures est sur l'écran du réseau, jamais sur la journée de l'agent.
    expect(CANDIDATURES_ENTRY_HTML).toContain('candidatures-ouvrir');
    expect(INTEGRATION_HOME_HTML).not.toContain('candidatures-ouvrir');
  });

  it('[R81] la fiche d’entretien : le déclaré, les mêmes questions ; entretien fixé, tenu ; décision nommée avec son motif ; puis l’intégration', async () => {
    const d = await run({}, DIRECTION);
    await d.ouvrir('candidatures-ouvrir');
    await d.click(d.byText('Fiche d’entretien'));
    expect(d.els['integration-titre']!.textContent).toBe('Entretien de Zoé');
    expect(sections(d)).toEqual(['Ce que la personne a déclaré', 'Les questions, les mêmes pour tous', 'Les pièces à fournir si elle entre', 'Entretiens', 'Décision']);
    expect(d.state()).toBe('Le déclaré tel quel, les mêmes questions pour tous : aucune note, aucun avis.');
    expect(d.body().textContent).toContain('Comment se passe l’essai ?');
    // Fixer un entretien : un jour, une heure, une personne.
    d.input('Jour et heure').value = '2027-07-20T10:00';
    d.input('Personne qui le mènera').value = '  Shawez  ';
    await d.click(d.byText('Fixer l’entretien'));
    const fixed = JSON.parse(d.posts().find((c) => c.url === '/v1/reseau/candidatures/c2/entretien')!.body!);
    expect(Object.keys(fixed)).toEqual(['at', 'interviewer']);
    expect(fixed.interviewer).toBe('Shawez');
    expect(Number.isNaN(Date.parse(fixed.at))).toBe(false);
    expect(d.state()).toBe('Entretien fixé.');
    // Sans date, rien ne part.
    const before = d.posts().length;
    await d.click(d.byText('Fixer l’entretien'));
    expect(d.state()).toBe('Date illisible : choisissez le jour et l’heure.');
    expect(d.posts()).toHaveLength(before);
    // Marquer tenu, avec la personne qui l'a mené.
    d.input('Personne qui a mené l’entretien').value = 'Shawez';
    await d.click(d.byText('Marquer tenu'));
    expect(JSON.parse(d.posts().find((c) => c.url === '/v1/reseau/entretiens/i1/tenu')!.body!)).toEqual({ heldByName: 'Shawez' });
    // La décision : trois choix, un motif, une personne nommée ; aucun autre champ [R81].
    expect(d.input('Décision').children.map((o) => o.textContent)).toEqual(['Choisir', 'Oui, il entre', 'Non', 'À revoir']);
    await d.click(d.byText('Ranger la décision'));
    expect(d.state()).toBe('Choisissez la décision.');
    d.input('Décision').value = 'oui';
    d.input('Motif').value = 'Projet clair et secteur choisi.';
    d.input('Personne qui décide').value = 'Shawez';
    await d.click(d.byText('Ranger la décision'));
    expect(JSON.parse(d.posts().find((c) => c.url === '/v1/reseau/candidatures/c2/decision')!.body!)).toEqual({ decision: 'oui', reason: 'Projet clair et secteur choisi.', deciderName: 'Shawez' });
    expect(d.state()).toBe('Décision rangée.');
    // Chaque champ a son libellé, pour les lecteurs d'écran.
    for (const f of d.body().all().filter((e) => ['input', 'textarea', 'select'].includes(e.tagName))) {
      expect(d.body().all().some((l) => l.tagName === 'label' && l.attributes.for === f.attributes.id), f.attributes.id).toBe(true);
    }
    // Un refus du serveur est dit en français.
    const r = await run({ 'POST /v1/reseau/candidatures/c2/decision': no(409, { ok: false, rule: 'R81', code: 'no_interview' }) }, DIRECTION);
    await r.ouvrir('candidatures-ouvrir');
    await r.click(r.byText('Fiche d’entretien'));
    r.input('Décision').value = 'oui';
    await r.click(r.byText('Ranger la décision'));
    expect(r.state()).toBe('Un « oui » demande un entretien déjà tenu.');
    // Après un « oui », la décision est montrée telle quelle, et l'intégration s'ouvre.
    const decided = { ...SHEET, interviews: [{ ...SHEET.interviews[0], held: true }], decision: { decision: 'oui', reason: 'Projet clair.', deciderName: 'Shawez', decidedAt: '2027-07-10T09:00:00.000Z' } };
    const a = await run({ 'GET /v1/reseau/candidatures/c2/entretien': ok(decided) }, DIRECTION);
    await a.ouvrir('candidatures-ouvrir');
    await a.click(a.byText('Fiche d’entretien'));
    expect(a.body().textContent).toContain('Oui, il entre · par Shawez, le ');
    expect(a.body().textContent).toContain('Motif : Projet clair.');
    expect(a.body().all().filter((e) => e.tagName === 'button' && e.textContent === 'Marquer tenu')).toHaveLength(0);
    await a.click(a.byText('Ouvrir son intégration'));
    expect(JSON.parse(a.posts().find((c) => c.url === '/v1/reseau/candidatures/c2/admettre')!.body!)).toEqual({});
    expect(a.state()).toBe('Intégration ouverte : son dossier d’agent l’attend.');
    // Le retour ramène à la liste, puis au réseau.
    await a.click(a.els['integration-retour']);
    expect(a.body().textContent).toContain('2 candidature(s)');
  });

  it('[R80] aucun texte de ces écrans ne promet de revenus', () => {
    const texts = [visible(INTEGRATION_HOME_HTML), visible(CANDIDATURES_ENTRY_HTML), visible(INTEGRATION_HTML), ...strings(INTEGRATION_SCRIPT)];
    expect(texts.length).toBeGreaterThan(80);
    expect(texts.filter((x) => promisesIncome(x))).toEqual([]);
    expect(promisesIncome('Gagnez 5 000 € par mois')).toBe(true);
  });

  it('[R201] un script à part, chargé une seule fois, jamais gardé ; l’application servie sans ses lignes de commentaire', async () => {
    expect(JS).not.toContain('INTEGRATION_REFUSALS');
    expect(JS).not.toContain('/v1/reseau/');
    expect(AGENT_APP_SHELL).not.toContain('/app/integration.js');
    expect(budgetProblems({ html: '', js: INTEGRATION_SCRIPT }, BUDGETS.page)).toEqual([]);
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/integration.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(await served.text()).toBe(INTEGRATION_SCRIPT);
    // Seules les lignes qui ne sont qu'un commentaire partent ; le code et les chaînes restent tels quels.
    expect(stripCommentLines("  // seul\n  var a = 'http://x'; // fin\n  /* bloc */\n  /* ouvert\n  b();")).toBe("  var a = 'http://x'; // fin\n  /* ouvert\n  b();");
    expect(JS.split('\n').some((l) => /^\s*\/\//.test(l))).toBe(false);
    const t = await run();
    await t.click(t.els['integration-ouvrir']);
    expect(t.state()).toBe('Chargement…');
    expect(t.calls.some((c) => c.url.startsWith('/v1/reseau'))).toBe(false);
    await t.loadScript();
    expect(t.body().textContent).toContain('Mon dossier d’agent');
    await t.click(t.els['integration-retour']);
    await t.click(t.els['academie-ouvrir']);
    expect(t.scripts()).toHaveLength(1);
    expect(t.body().textContent).toContain('Mes heures de formation');
    // La sortie efface l'écran : aucune donnée ne reste.
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toHaveLength(0);
  });

  it('sans réseau au chargement, l’écran le dit ; un script arrivé après un changement d’écran ne montre rien', async () => {
    const t = await run();
    await t.click(t.els['integration-ouvrir']);
    t.scripts()[0]!.listeners.error!({});
    await new Promise((r) => setTimeout(r, 0));
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    const u = await run();
    await u.click(u.els['integration-ouvrir']);
    await u.click(u.els['integration-retour']);
    runInNewContext(INTEGRATION_SCRIPT, u.context);
    u.scripts()[0]!.listeners.load!({});
    await new Promise((r) => setTimeout(r, 0));
    expect(u.calls.some((c) => c.url.startsWith('/v1/reseau'))).toBe(false);
    expect(u.els.accueil!.hidden).toBe(false);
  });
});

describe('AU024 · déposer une pièce là où elle manque, depuis le téléphone', () => {
  const PATH = '/v1/reseau/agents/ag1/pieces/fichier';
  const RECEIPT = { kind: 'immatriculation_rsac', label: 'Immatriculation au registre spécial des agents commerciaux', version: 1, receivedAt: '2027-07-12T08:00:00.000Z', bytes: 245_760 };
  const after = { ...FILE, lines: FILE.lines.map((l) => (l.kind === 'immatriculation_rsac' ? { ...l, state: 'valide', version: 1, issuedOn: '2027-07-01' } : l)) };
  const photo = (extra: Record<string, unknown> = {}) => ({ name: 'kbis.jpg', type: 'image/jpeg', size: 245_760, ...extra });
  /** Le bloc de dépôt d'une pièce : son résumé, son fichier, ses dates, son bouton. */
  const box = (t: Awaited<ReturnType<typeof run>>, summary: string) => {
    const d = t.body().all().find((e) => e.tagName === 'details' && e.children[0]?.textContent === summary);
    if (!d) throw new Error(`bloc absent : ${summary}`);
    const inputOf = (label: string) => d.all().find((e) => e.attributes.id === d.all().find((x) => x.tagName === 'label' && x.textContent === label)?.attributes.for);
    return { d, inputOf, text: () => d.textContent, confirm: () => d.all().find((e) => e.tagName === 'button' && e.textContent === 'Confirmer l’envoi') };
  };
  const choose = async (t: Awaited<ReturnType<typeof run>>, input: FakeElement | undefined, file: unknown) => {
    (input as unknown as { files: unknown[] }).files = [file];
    input!.listeners.change!({});
    await settle();
  };

  it('[R82] constat : chaque pièce manquante, en projet ou échue a son dépôt ; une pièce valide n’en a pas', async () => {
    const t = await run();
    await t.ouvrir('integration-ouvrir');
    const summaries = t.body().all().filter((e) => e.tagName === 'summary').map((e) => e.textContent);
    expect(summaries).toEqual(expect.arrayContaining(['Déposer la version signée', 'Déposer cette pièce', 'Déposer la nouvelle version']));
    expect(summaries.filter((s) => s.startsWith('Déposer'))).toHaveLength(3);
    const file = box(t, 'Déposer cette pièce').inputOf('Le document : PDF, ou photo JPEG ou PNG, 10 Mo au plus')!;
    expect(file.attributes).toMatchObject({ type: 'file', accept: 'application/pdf,image/jpeg,image/png' });
    // L'assurance demande sa fin de validité ; l'immatriculation la propose ; le contrat n'en a pas.
    expect(box(t, 'Déposer la nouvelle version').inputOf('Fin de validité, lue sur le document')).toBeDefined();
    expect(box(t, 'Déposer cette pièce').inputOf('Fin de validité, si le document en porte une')).toBeDefined();
  });

  it('[R82] [R16] aperçu avant l’envoi, confirmation, fichier envoyé tel quel avec sa clé, puis l’accusé de réception du serveur', async () => {
    const t = await run({ [`POST ${PATH}?kind=immatriculation_rsac&issuedOn=2027-07-01`]: ok({ ...after, receipt: RECEIPT }), 'GET /v1/reseau/mon-dossier': ok(FILE) });
    await t.ouvrir('integration-ouvrir');
    const b = box(t, 'Déposer cette pièce');
    // Rien ne part sans document ni date.
    await t.click(b.confirm());
    expect(b.text()).toContain('Choisissez d’abord le document, ou prenez-le en photo.');
    const f = photo();
    await choose(t, b.inputOf('Le document : PDF, ou photo JPEG ou PNG, 10 Mo au plus'), f);
    expect(b.text()).toContain('Avant l’envoi : « kbis.jpg », photo, 240 Ko. Vérifiez que c’est bien : Immatriculation au registre spécial des agents commerciaux.');
    await t.click(b.confirm());
    expect(b.text()).toContain('Indiquez la date du document.');
    expect(t.posts()).toEqual([]);
    b.inputOf('Date du document')!.value = '2027-07-01';
    await t.click(b.confirm());
    const sent = t.calls.find((c) => c.method === 'POST')!;
    expect(sent.url).toBe(`${PATH}?kind=immatriculation_rsac&issuedOn=2027-07-01`);
    expect(sent.body).toBe(f);
    expect(sent.auth).toBe(`Bearer ${KEY}`);
    // L'écran est relu : la pièce est valide, et l'accusé de réception est dit.
    expect(t.state()).toBe('Reçue le 12/07/2027 à 10:00 : Immatriculation au registre spécial des agents commerciaux, version 1, 240 Ko. Elle compte dès maintenant dans votre dossier.');
  });

  it('[R82] un fichier d’un autre type ou trop lourd n’est pas proposé ; un refus du serveur est dit en mots', async () => {
    const t = await run({ [`POST ${PATH}?kind=assurance_rcp&issuedOn=2027-07-01&validUntil=2028-06-30`]: no(400, { ok: false, rule: null, code: 'bad_file' }) });
    await t.ouvrir('integration-ouvrir');
    const b = box(t, 'Déposer la nouvelle version');
    const input = b.inputOf('Le document : PDF, ou photo JPEG ou PNG, 10 Mo au plus');
    await choose(t, input, { name: 'page.html', type: 'text/html', size: 10 });
    expect(b.text()).toContain('Ce fichier n’est ni un PDF ni une photo JPEG ou PNG : choisissez-en un autre.');
    await choose(t, input, { name: 'scan.pdf', type: 'application/pdf', size: 12 * 1024 * 1024 });
    expect(b.text()).toContain('Ce fichier pèse 12,0 Mo : 10 Mo au plus.');
    b.inputOf('Date du document')!.value = '2027-07-01';
    await t.click(b.confirm());
    expect(t.posts()).toEqual([]);
    await choose(t, input, { name: 'scan.pdf', type: 'application/pdf', size: 90_000 });
    await t.click(b.confirm());
    expect(b.text()).toContain('Cette pièce a une fin de validité : lisez-la sur le document et indiquez-la.');
    b.inputOf('Fin de validité, lue sur le document')!.value = '2028-06-30';
    await t.click(b.confirm());
    expect(b.text()).toContain('Ce fichier ne se lit pas comme il le dit : reprenez la photo ou le PDF.');
  });
});

describe('AU025 · le premier parcours se fait depuis l’écran', () => {
  const steps = (done: number) => ['contact_recu', 'qualification', 'rappel_fait', 'rendez_vous', 'avis_valide'].map((step, i) => ({ step, label: `Étape ${i + 1}`, done: i < done, at: i < done ? '2027-07-12T08:00:00.000Z' : null }));
  const progress = (done: number) => ({ agentId: 'ag1', steps: steps(done), next: done < 5 ? `Étape ${done + 1}` : null, completed: done === 5, countedAtAcademy: done === 5 });

  it('[R82] l’agent ouvre son exercice, puis seule la prochaine étape porte son geste ; chaque geste part à sa route', async () => {
    const t = await run({
      'GET /v1/reseau/mon-bac-a-sable': no(400, { ok: false, rule: null, code: 'not_opened' }),
      'POST /v1/reseau/mon-bac-a-sable': ok(progress(0)),
    });
    await t.ouvrir('integration-ouvrir');
    await t.click(t.byText('Ouvrir mon exercice'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/reseau/mon-bac-a-sable']);
    for (const [done, label, step] of [[0, 'Recevoir le message du vendeur', 'contact_recu'], [2, 'Je l’ai rappelé', 'rappel_fait'], [3, 'Fixer le rendez-vous d’estimation', 'rendez_vous'], [4, 'Valider l’avis de valeur', 'avis_valide']] as const) {
      const u = await run({ 'GET /v1/reseau/mon-bac-a-sable': ok(progress(done)), [`POST /v1/reseau/mon-bac-a-sable/etapes/${step}`]: ok(progress(done + 1)) });
      await u.ouvrir('integration-ouvrir');
      const gestures = u.body().all().filter((e) => e.tagName === 'button' && Object.values({ a: 'Recevoir le message du vendeur', b: 'Je l’ai rappelé', c: 'Fixer le rendez-vous d’estimation', d: 'Valider l’avis de valeur' }).includes(e.textContent));
      expect(gestures.map((e) => e.textContent)).toEqual([label]);
      await u.click(u.byText(label));
      expect(u.posts().map((c) => c.url)).toEqual([`/v1/reseau/mon-bac-a-sable/etapes/${step}`]);
      expect(u.state()).toBe('Étape faite : votre progression est gardée.');
    }
    // Fini : plus aucun geste, le parcours est dit complet.
    const f = await run({ 'GET /v1/reseau/mon-bac-a-sable': ok(progress(5)) });
    await f.ouvrir('integration-ouvrir');
    expect(f.body().textContent).toContain('Parcours complet, compté à l’académie.');
    expect(f.body().all().filter((e) => e.tagName === 'button' && /vendeur|rappelé|rendez-vous|avis/.test(e.textContent))).toEqual([]);
  });

  it('une qualification manquée : un nouveau message relance le parcours', async () => {
    const t = await run({ 'GET /v1/reseau/mon-bac-a-sable': ok(progress(1)), 'POST /v1/reseau/mon-bac-a-sable/etapes/contact_recu': ok(progress(2)) });
    await t.ouvrir('integration-ouvrir');
    await t.click(t.byText('Recevoir un nouveau message'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/reseau/mon-bac-a-sable/etapes/contact_recu']);
  });

  it('une étape refusée est dite en clair, jamais par un code', async () => {
    const t = await run({ 'GET /v1/reseau/mon-bac-a-sable': ok(progress(2)), 'POST /v1/reseau/mon-bac-a-sable/etapes/rappel_fait': no(400, { ok: false, rule: null, code: 'not_next_step' }) });
    await t.ouvrir('integration-ouvrir');
    await t.click(t.byText('Je l’ai rappelé'));
    expect(t.state()).toBe('Faites d’abord l’étape d’avant : la liste est relue.');
  });

});

describe('AU026 · le quiz et l’attestation se passent depuis l’académie, sans appel manuel à l’API', () => {
  const DRAWN = {
    attemptId: 'q1',
    questions: [
      { questionId: 'x1', prompt: 'Qui signe le mandat ?', choices: ['Le vendeur', 'Le voisin'] },
      { questionId: 'x2', prompt: INJECTED, choices: ['Oui', 'Non', 'Je ne sais pas'] },
    ],
  };
  const FINGERPRINT = 'a'.repeat(64);
  const ATTESTATION = {
    attestationId: 'at1',
    fingerprint: FINGERPRINT,
    document: {
      kind: 'aimmo.attestation-formation', version: 1, attestationId: 'at1', networkId: 'n1', agentId: 'ag1',
      scope: { kind: 'track', ref: 'entree' },
      modules: [{ moduleId: 'm1', title: 'Déontologie du mandat', durationMinutes: 120 }],
      ruleIds: ['R570'], questionCount: 2, issuedOn: '2027-07-12',
    },
  };
  const WRONG = {
    allRight: false,
    results: [
      { questionId: 'x1', right: true, review: null },
      { questionId: 'x2', right: false, review: { moduleId: 'm1', moduleTitle: 'Déontologie du mandat', videoId: 'abcdefghijk', ruleId: 'R570', ruleTitle: 'Quiz tiré des règles' } },
    ],
    modulesToDo: [],
    attestation: null,
  };
  const PERFECT = { allRight: true, results: [{ questionId: 'x1', right: true, review: null }, { questionId: 'x2', right: true, review: null }], modulesToDo: [], attestation: ATTESTATION };
  const quizButtons = (t: Awaited<ReturnType<typeof run>>) => t.body().all().filter((e) => e.tagName === 'button' && /quiz/i.test(e.textContent));
  const answer = (t: Awaited<ReturnType<typeof run>>, values: string[]) => values.forEach((v, n) => { t.body().all().find((e) => e.attributes.id === `quiz-q-${n}`)!.value = v; });

  it('[R570] chaque parcours et chaque module offrent leur quiz : tiré par le serveur, sans la bonne réponse', async () => {
    const t = await run({ 'POST /v1/formation/quiz': ok(DRAWN) });
    await t.ouvrir('academie-ouvrir');
    // Le constat de l'audit : sans ces boutons, le quiz ne se passait que par un appel manuel à l'API.
    expect(quizButtons(t).map((b) => b.textContent)).toEqual(['Passer le quiz du parcours', 'Quiz de ce module', 'Quiz de ce module']);
    await t.click(t.byText('Passer le quiz du parcours'));
    expect(t.posts().map((c) => [c.url, c.body])).toEqual([['/v1/formation/quiz', JSON.stringify({ track: 'entree' })]]);
    expect(t.els['integration-titre']!.textContent).toBe('Quiz · Parcours d’entrée');
    expect(t.els['integration-retour']!.textContent).toBe('Retour à l’académie');
    const text = t.body().textContent;
    expect(text).toContain('Qui signe le mandat ?');
    expect(text).toContain(INJECTED);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    // Un quiz de module se tire par son seul module.
    const u = await run({ 'POST /v1/formation/quiz': ok(DRAWN) });
    await u.ouvrir('academie-ouvrir');
    await u.click(u.byText('Quiz de ce module', 1));
    expect(u.posts().map((c) => c.body)).toEqual([JSON.stringify({ moduleId: 'm2' })]);
  });

  it('[R570] [R14] les réponses rendues une fois : juste ou à revoir, avec le module et la règle, sans note ni bonne réponse', async () => {
    const t = await run({ 'POST /v1/formation/quiz': ok(DRAWN), 'POST /v1/formation/quiz/q1/reponses': ok(WRONG) });
    await t.ouvrir('academie-ouvrir');
    await t.click(t.byText('Passer le quiz du parcours'));
    // Une question sans réponse : rien ne part.
    answer(t, ['0', '']);
    await t.click(t.byText('Rendre mes réponses'));
    expect(t.state()).toBe('Répondez à chaque question avant de rendre le quiz.');
    expect(t.posts()).toHaveLength(1);
    answer(t, ['0', '2']);
    await t.click(t.byText('Rendre mes réponses'));
    expect(t.posts().map((c) => [c.url, c.body])[1]).toEqual(['/v1/formation/quiz/q1/reponses', JSON.stringify({ answers: [0, 2] })]);
    const text = t.body().textContent;
    expect(text).toContain('Juste');
    expect(text).toContain('À revoir');
    expect(text).toContain('Revoir le module « Déontologie du mandat », règle R570 : Quiz tiré des règles.');
    expect(t.body().all().filter((e) => e.tagName === 'a').map((a) => a.attributes.href)).toEqual(['https://www.youtube-nocookie.com/embed/abcdefghijk']);
    // Aucune note, aucun nombre de bonnes réponses, aucun pourcentage [R14].
    expect(text).not.toMatch(/\d+\s*(\/|sur)\s*\d+|%|note|score/i);
    expect(t.state()).toBe('Quiz rendu : revoyez les modules indiqués, puis tirez un nouveau quiz.');
    // Rendu deux fois : le refus du serveur est dit en français.
    const u = await run({ 'POST /v1/formation/quiz': ok(DRAWN), 'POST /v1/formation/quiz/q1/reponses': no(409, { ok: false, rule: null, code: 'already_submitted' }) });
    await u.ouvrir('academie-ouvrir');
    await u.click(u.byText('Passer le quiz du parcours'));
    answer(u, ['0', '1']);
    await u.click(u.byText('Rendre mes réponses'));
    expect(u.state()).toBe('Ce quiz a déjà été rendu : tirez-en un nouveau pour qu’il compte.');
    const v = await run({ 'POST /v1/formation/quiz': no(409, { ok: false, rule: null, code: 'not_enough_questions' }) });
    await v.ouvrir('academie-ouvrir');
    await v.click(v.byText('Passer le quiz du parcours'));
    expect(v.state()).toBe('Pas encore assez de questions pour ce quiz : la direction en prépare. Revenez plus tard.');
  });

  it('[R571] un quiz sans faute donne l’attestation à l’écran : son empreinte, le document enregistré tel quel, la page de vérification', async () => {
    const t = await run({ 'POST /v1/formation/quiz': ok(DRAWN), 'POST /v1/formation/quiz/q1/reponses': ok(PERFECT) });
    const saved: { parts: unknown[]; download?: string }[] = [];
    t.context.Blob = function (this: { parts: unknown[] }, parts: unknown[]) { this.parts = parts; saved.push({ parts }); };
    t.context.URL = { createObjectURL: () => 'blob:essai', revokeObjectURL: () => undefined };
    await t.ouvrir('academie-ouvrir');
    await t.click(t.byText('Passer le quiz du parcours'));
    answer(t, ['0', '0']);
    await t.click(t.byText('Rendre mes réponses'));
    expect(t.state()).toBe('Sans faute : votre attestation est délivrée.');
    const text = t.body().textContent;
    expect(text).toContain('Parcours d’entrée · délivrée le ');
    expect(text).toContain('Déontologie du mandat · 120 min');
    expect(text).toContain(`Empreinte : ${FINGERPRINT}`);
    expect(t.body().all().some((e) => e.tagName === 'a' && e.attributes.href === '/attestation')).toBe(true);
    await t.click(t.byText('Enregistrer l’attestation'));
    // Le document tel que rangé, seul : c'est lui que la page de vérification recalcule [R571].
    expect(saved.map((x) => JSON.parse(String(x.parts[0])))).toEqual([ATTESTATION.document]);
    expect(t.state()).toBe('Attestation enregistrée sur cet appareil.');
  });

  it('[R571] [R16] les attestations déjà obtenues se relisent et s’enregistrent depuis l’académie, par l’agent lui-même', async () => {
    const t = await run({ 'GET /v1/formation/agents/ag1/attestations': ok({ attestations: [ATTESTATION] }) });
    await t.ouvrir('academie-ouvrir');
    expect(t.calls.filter((c) => c.method === 'GET' && c.url.startsWith('/v1/formation/')).map((c) => [c.url, c.auth])).toEqual([['/v1/formation/agents/ag1/attestations', `Bearer ${KEY}`]]);
    expect(t.body().textContent).toContain(`Empreinte : ${FINGERPRINT}`);
    expect(t.byText('Enregistrer l’attestation')).toBeDefined();
    const u = await run();
    await u.ouvrir('academie-ouvrir');
    expect(u.body().textContent).toContain('Aucune attestation pour le moment');
    // Une empreinte douteuse n'est pas montrée comme une attestation.
    const v = await run({ 'GET /v1/formation/agents/ag1/attestations': ok({ attestations: [{ ...ATTESTATION, fingerprint: 'x' }] }) });
    await v.ouvrir('academie-ouvrir');
    expect(v.body().textContent).not.toContain('Empreinte');
    expect(v.byText('Enregistrer l’attestation')).toBeUndefined();
  });
});
