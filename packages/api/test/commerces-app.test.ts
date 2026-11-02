import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems, htmlProblems } from '../../core/src/design/audit.ts';
import { COMMERCES_SCRIPT } from '../app/commerces.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : commerces, repreneurs, montants, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const DETAIL: Record<string, Answer> = {
  'GET /v1/commerces/b1/public': ok({ publicView: { kind: 'business', activity: 'restaurant', city: 'Dijon', postalCode: '21000', surfaceM2: 120 }, presentation: null }),
  'GET /v1/commerces/b1/estimations': ok([
    {
      id: 'e1',
      lowCents: 30_617_250,
      highCents: 48_987_600,
      validated: null,
      lines: [{ label: 'chiffre_affaires_moyen', value: 61_234_500, source: 'fiche du commerce, version 1', hypothesis: 'moyenne du chiffre d’affaires des exercices 2026 saisis par l’agent' }],
    },
  ]),
  'GET /v1/commerces/b1/presentation': ok({ id: 'p1', title: 'Restaurant à reprendre à Dijon', body: `Belle salle. ${INJECTED}`, validated: null }),
  'GET /v1/commerces/b1/demandes': ok([
    { personId: 'r1', firstName: 'Camille', requestedAt: '2027-09-07T08:00:00.000Z', open: false, codes: ['engagement_non_signe', 'identite_non_verifiee'] },
    { personId: 'r2', firstName: 'Dominique', requestedAt: '2027-09-08T08:00:00.000Z', open: true, codes: [] },
  ]),
  'GET /v1/commerces/b1/ouvertures': ok([
    { id: 'o1', linkId: 'l1', personId: 'r2', outcome: 'ouvert', at: '2027-09-09T08:00:00.000Z' },
    { id: 'o2', linkId: 'l1', personId: 'r2', outcome: 'autre_lecteur', at: '2027-09-09T09:00:00.000Z' },
  ]),
  'GET /v1/commerces/b1/cession': ok({
    ready: false,
    lines: [
      { step: 'cession_prevue', status: 'fait', due: '2027-12-17' },
      { step: 'information_salaries', status: 'en_retard', due: '2027-10-15' },
      { step: 'preemption', status: 'sans_objet', due: null },
    ],
  }),
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/commerces': ok([
    { propertyId: 'b1', reference: 'CE-1', kind: 'business', city: 'Dijon' },
    { propertyId: 'b2', reference: INJECTED, kind: 'business_walls', city: null },
  ]),
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
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    crypto: globalThis.crypto,
    Date,
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['commerces-corps']!;
  const state = () => els['commerces-etat']!.textContent;
  const byText = (text: string, nth = 0) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text)[nth];
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const input = (label: string) => {
    const l = body().all().find((e) => e.tagName === 'label' && e.textContent === label);
    if (!l) throw new Error(`libellé absent : ${label}`);
    return body().all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  // Le script chargé à la demande : celui que le navigateur ferait tourner, dans la même page.
  const scripts = () => els.commerces!.children.filter((e) => e.tagName === 'script');
  const loadScript = async () => {
    const s = scripts();
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/commerces.js']);
    runInNewContext(COMMERCES_SCRIPT, context);
    s[0]!.listeners.load!({});
    await settle();
  };
  const openB1 = async () => {
    await click(els['commerces-ouvrir']);
    await loadScript();
    await click(byText('Ouvrir', 0));
  };
  return { els, calls, table, byText, click, input, body, state, openB1, scripts, loadScript };
}

describe('CE11 · écran « Commerces » de l’application', () => {
  it('[R16] l’écran ne lit et n’écrit que par les routes /v1/commerces, la clé dans l’en-tête seul', async () => {
    const t = await run();
    t.table['POST /v1/commerces/estimations/e1/validation'] = ok({ id: 'e1' });
    t.table['POST /v1/commerces/presentations/p1/validation'] = ok({ id: 'p1' });
    await t.openB1();
    expect(t.els.commerces!.hidden).toBe(false);
    expect(t.els.accueil!.hidden).toBe(true);
    await t.click(t.byText('Valider l’estimation'));
    expect(t.state()).toBe('Estimation validée.');
    await t.click(t.byText('Valider la présentation'));
    expect(t.state()).toBe('Présentation validée.');
    const screen = t.calls.filter((c) => !/^\/v1\/(moi|plan-du-jour|alertes-agent|contacts-chauds|rendez-vous|usage|annonces$|apres-vente)/.test(c.url));
    expect(screen.length).toBeGreaterThan(10);
    for (const c of screen) {
      expect(c.url.startsWith('/v1/commerces'), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...COMMERCES_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(3);
    // Hors de M16, seulement : le rôle du lecteur, le dépôt des preuves et les contacts de l'agent, chacun avec ses droits.
    for (const r of routes) expect(/^\/v1\/(commerces|moi$|offres\/biens\/$)/.test(r), r).toBe(true);
  });

  it('[R110] l’écran montre ce que l’API rend, sans rien interpréter ni calculer, et tout texte reçu reste du texte', async () => {
    const t = await run();
    await t.openB1();
    const text = t.body().textContent;
    expect(text).toContain('Fonds de commerce · restaurant · Dijon · 120');
    expect(text).toContain('Fourchette : 306');
    expect(text).toContain('moyenne du chiffre d’affaires des exercices 2026 saisis par l’agent : fiche du commerce, version 1');
    expect(text).toContain('Porte fermée : engagement à signer, pièce d’identité à vérifier.');
    expect(text).toContain('Porte ouverte : le dossier peut partir.');
    expect(text).toContain('Refusé : autre lecteur');
    expect(text).toContain('Information des salariés : en retard, le 15/10/2027');
    // Le texte injecté reste un texte : aucun élément créé à partir de lui.
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(text).toContain(INJECTED);
    // La porte fermée n'offre pas d'envoi ; la porte ouverte demande d'abord l'accord.
    expect(t.body().all().filter((e) => e.tagName === 'button' && e.textContent === 'Envoyer le dossier')).toHaveLength(1);
    await t.click(t.byText('Envoyer le dossier'));
    expect(t.state()).toBe('Notez d’abord l’accord du repreneur.');
    t.table['POST /v1/commerces/b1/dossiers'] = ok({ linkId: 'l2', mode: 'essai' });
    t.input('Accord pour recevoir le lien par mail (où, quand)').value = 'au rendez-vous du 8 septembre';
    await t.click(t.byText('Envoyer le dossier'));
    expect(t.state()).toBe('Dossier envoyé par le contrôle central, en mode essai.');
    const sent = t.calls.find((c) => c.method === 'POST' && c.url === '/v1/commerces/b1/dossiers')!;
    expect(JSON.parse(sent.body!)).toEqual({ personId: 'r2', consentProof: 'au rendez-vous du 8 septembre' });
  });

  it('[R110] [R16] ce que l’API refuse à ce lecteur n’est pas montré : ni fourchette, ni demandes', async () => {
    const t = await run({
      'GET /v1/commerces/b1/estimations': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }),
      'GET /v1/commerces/b1/demandes': no(403, { ok: false, rule: 'R16', code: 'role' }),
      'GET /v1/commerces/b1/presentation': no(404, { ok: false, rule: null, code: 'no_presentation' }),
    });
    await t.openB1();
    const text = t.body().textContent;
    expect(text).not.toContain('Fourchette');
    expect(text).not.toContain('Demandes des repreneurs');
    expect(text).not.toContain('Camille');
    expect(text).toContain('Aucune estimation pour le moment.');
    // Une fiche refusée : rien du commerce n'est montré.
    const u = await run({ 'GET /v1/commerces/b1/public': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await u.openB1();
    expect(u.state()).toBe('Ce commerce n’est pas dans vos droits.');
    expect(u.body().textContent).toBe('');
  });

  it('[R201] l’écran est chargé à la demande, une seule fois, et jamais gardé sur l’appareil', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    // Le code de l'écran n'est pas dans le script de l'application que reçoit chaque agent.
    expect(JS).not.toContain('Demandes des repreneurs');
    expect(AGENT_APP_SHELL).not.toContain('/app/commerces.js');
    const r = handleAgentApp(new Request('https://aimmo.example.test/app/commerces.js'))!;
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(COMMERCES_SCRIPT);
    await t.openB1();
    expect(t.body().textContent).toContain('Demandes des repreneurs');
    // Retour à la liste puis nouvelle ouverture : le script n'est pas chargé une deuxième fois.
    await t.click(t.els['commerces-retour']);
    await t.click(t.els['commerces-retour']);
    await t.click(t.els['commerces-ouvrir']);
    expect(t.scripts()).toHaveLength(1);
    expect(t.body().textContent).toContain('CE-1');
    // Hors réseau au chargement : l'écran le dit, rien n'est montré.
    const u = await run();
    await u.click(u.els['commerces-ouvrir']);
    u.scripts()[0]!.listeners.error!({});
    await new Promise((r) => setTimeout(r, 0));
    expect(u.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(u.body().textContent).toBe('');
  });

  it('[R201] l’application, avec l’écran « Commerces », passe le contrôle d’accessibilité', () => {
    expect(htmlProblems(HTML)).toEqual([]);
    expect(HTML).toContain('id="commerces"');
    expect(HTML).toContain('<h3 id="titre-commerces-accueil">Mes commerces</h3>');
  });
});

const FILE = 'f1';
const P = `/v1/commerces/cessions/${FILE}`;
const SHA_PDF = { type: 'application/pdf', size: 8, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7').buffer };
const isOff = (b: FakeElement | undefined) => (b as unknown as { disabled?: boolean }).disabled === true;
const line = (step: string, status: string, due: string | null = null) => ({ step, status, due });
/** Un dossier ouvert : par défaut, rien de saisi ; la commune est rangée hors périmètre. */
const dossier = (over: Record<string, unknown> = {}) => ({
  fileId: FILE,
  propertyId: 'b1',
  dates: {},
  escrow: null,
  inPerimeter: false,
  ready: false,
  missing: ['cession_prevue', 'sequestre'],
  declaredReady: null,
  lines: [line('cession_prevue', 'a_saisir'), line('sequestre', 'a_saisir'), line('information_salaries', 'sans_objet'), line('preemption', 'sans_objet'), line('autorisations', 'sans_objet')],
  ...over,
});
const OPEN: Record<string, Answer> = {
  'GET /v1/commerces/b1/cession': ok(dossier()),
  [`GET ${P}/acquereur`]: ok(null),
  [`GET ${P}/demande-fonds`]: ok(null),
};
const READY = { ready: true, missing: [], declaredReady: '2027-09-10T08:00:00.000Z', lines: [line('cession_prevue', 'fait', '2027-12-17'), line('sequestre', 'fait')] };
const text = (e: FakeElement) => e.all().map((x) => x.textContent).join(' ');
const posted = (t: { calls: { method: string; url: string; body?: string }[] }, url: string) => t.calls.filter((c) => c.method === 'POST' && c.url === url);
const sets = (t: { input: (l: string) => FakeElement }, values: Record<string, string>) => {
  for (const [label, value] of Object.entries(values)) t.input(label).value = value;
};

describe('CE12 · la cession avance depuis l’écran', () => {
  it('[R16] l’agent ouvre le dossier sans rien saisir ; ni bouton sur un bien qui n’est pas un fonds, ni pour qui ne peut pas écrire', async () => {
    const t = await run({ 'GET /v1/commerces/b1/cession': ok(null) });
    await t.openB1();
    t.table['POST /v1/commerces/b1/cession'] = ok({ fileId: FILE });
    Object.assign(t.table, OPEN);
    await t.click(t.byText('Ouvrir le dossier de cession'));
    expect(t.state()).toBe('Dossier de cession ouvert.');
    expect(posted(t, '/v1/commerces/b1/cession')).toHaveLength(1);
    expect(t.byText('Ranger la date')).toBeDefined();

    const reader = await run({ 'GET /v1/commerces/b1/cession': ok(null), 'GET /v1/commerces/b1/demandes': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await reader.openB1();
    expect(reader.byText('Ouvrir le dossier de cession')).toBeUndefined();

    const walls = await run({ 'GET /v1/commerces/b1/cession': no(400, { ok: false, rule: null, code: 'sorte' }) });
    await walls.openB1();
    expect(text(walls.body())).toContain('La cession ne concerne que les fonds de commerce.');
    expect(walls.byText('Ouvrir le dossier de cession')).toBeUndefined();
  });

  it('une lecture manquée ne se dit jamais « pas de dossier », et aucun geste n’est proposé dessus', async () => {
    const t = await run({ 'GET /v1/commerces/b1/cession': async () => { throw new TypeError('coupé'); } });
    await t.openB1();
    expect(text(t.body())).toContain('Les étapes ne se lisent pas pour le moment.');
    expect(text(t.body())).not.toContain('Pas de dossier');
    expect(t.byText('Ouvrir le dossier de cession')).toBeUndefined();
  });

  it('[R16] qui ne peut pas écrire lit les étapes, sans aucun geste ni lecture de l’acquéreur', async () => {
    const t = await run({ ...OPEN, 'GET /v1/commerces/b1/demandes': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.openB1();
    expect(text(t.body())).toContain('Date de cession prévue : à saisir');
    for (const b of ['Ranger la date', 'Ranger le séquestre', 'Choisir dans mes contacts', 'Déclarer la cession prête']) expect(t.byText(b), b).toBeUndefined();
    expect(t.calls.some((c) => c.url.endsWith('/acquereur'))).toBe(false);
  });

  it('[R10] une date part avec sa preuve déposée ; personne ne saisit de référence ; le fichier n’est pas renvoyé à la reprise', async () => {
    const t = await run(OPEN);
    let attempts = 0;
    t.table['POST /v1/offres/biens/b1/fichiers/preuve'] = ok({ kind: 'preuve', ref: 'preuves/11111111-1111-4111-8111-111111111111.pdf' });
    t.table[`POST ${P}/dates`] = async () => {
      attempts += 1;
      return attempts === 1 ? Response.json({ ok: false, rule: null, code: 'future_day' }, { status: 400 }) : Response.json({ ok: true, mode: 'essai', data: {} });
    };
    await t.openB1();
    await t.click(t.byText('Ranger la date'));
    expect(t.state()).toBe('Choisissez le jour.');
    sets(t, { 'Quelle date': 'cession_prevue', 'Le jour': '2027-12-17' });
    await t.click(t.byText('Ranger la date'));
    expect(t.state()).toBe('Joignez la preuve de cette date.');
    const pick = t.input('Sa preuve : courrier, accusé de réception, acte');
    (pick as unknown as { files: unknown[] }).files = [SHA_PDF];
    expect(pick.attributes.type).toBe('file');
    expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await t.click(t.byText('Ranger la date'));
    expect(t.state()).toBe('Ce jour est à venir : seule la cession prévue peut être dans le futur.');
    expect(isOff(t.byText('Ranger la date'))).toBe(false);
    await t.click(t.byText('Ranger la date'));
    expect(t.state()).toBe('Cession prévue : date rangée.');
    expect(posted(t, '/v1/offres/biens/b1/fichiers/preuve')).toHaveLength(1);
    expect(JSON.parse(posted(t, `${P}/dates`)[1]!.body!)).toEqual({ kind: 'cession_prevue', day: '2027-12-17', proofRef: 'preuves/11111111-1111-4111-8111-111111111111.pdf' });
  });

  it('un dépôt fermé ou un mauvais fichier sont dits, et aucune date ne part', async () => {
    const closed = await run(OPEN);
    closed.table['POST /v1/offres/biens/b1/fichiers/preuve'] = no(503, { ok: false, rule: null, code: 'depot_ferme' });
    await closed.openB1();
    sets(closed, { 'Le jour': '2027-12-17' });
    (closed.input('Sa preuve : courrier, accusé de réception, acte') as unknown as { files: unknown[] }).files = [SHA_PDF];
    await closed.click(closed.byText('Ranger la date'));
    expect(closed.state()).toBe('Le dépôt des preuves n’est pas encore branché : aucune date ne peut être rangée.');
    expect(posted(closed, `${P}/dates`)).toHaveLength(0);
    expect(isOff(closed.byText('Ranger la date'))).toBe(false);

    const wrong = await run(OPEN);
    await wrong.openB1();
    sets(wrong, { 'Le jour': '2027-12-17' });
    (wrong.input('Sa preuve : courrier, accusé de réception, acte') as unknown as { files: unknown[] }).files = [{ ...SHA_PDF, type: 'video/mp4' }];
    await wrong.click(wrong.byText('Ranger la date'));
    expect(wrong.state()).toBe('Ce fichier n’est pas admis : PDF, JPEG, PNG ou texte.');
    expect(wrong.calls.some((c) => c.url.includes('/fichiers/preuve'))).toBe(false);
  });

  it('[R116] une étape bloquante empêche la suivante, dite en français : ni signature proposée, ni déclaration acceptée', async () => {
    const t = await run(OPEN);
    t.table[`POST ${P}/prete`] = no(409, { ok: false, rule: 'R116', code: 'etapes_bloquantes', missing: ['sequestre', 'information_salaries'] });
    await t.openB1();
    const kinds = () => t.input('Quelle date').children.map((o) => o.value);
    expect(kinds()).toEqual(['cession_prevue']);
    expect(text(t.body())).toContain('La signature se range une fois la cession déclarée prête.');
    expect(text(t.body())).toContain('Encore à faire avant la cession : date de cession prévue, séquestre nommé.');
    await t.click(t.byText('Déclarer la cession prête'));
    expect(t.state()).toBe('Pas encore : il reste séquestre nommé, information des salariés.');
    expect(t.state()).not.toMatch(/etapes_bloquantes|R116/);
    expect(isOff(t.byText('Déclarer la cession prête'))).toBe(false);
  });

  it('[R116] la signature s’ouvre après la déclaration, en deux appuis, et le refus du serveur reste dit', async () => {
    const t = await run({ ...OPEN, 'GET /v1/commerces/b1/cession': ok(dossier(READY)) });
    t.table['POST /v1/offres/biens/b1/fichiers/preuve'] = ok({ ref: 'preuves/11111111-1111-4111-8111-111111111111.pdf' });
    t.table[`POST ${P}/dates`] = no(409, { ok: false, rule: 'R116', code: 'cession_non_declaree' });
    await t.openB1();
    expect(text(t.body())).toContain('Cession déclarée prête le 10/09/2027.');
    expect(t.byText('Déclarer la cession prête')).toBeUndefined();
    sets(t, { 'Quelle date': 'cession_signee', 'Le jour': '2027-09-11' });
    (t.input('Sa preuve : courrier, accusé de réception, acte') as unknown as { files: unknown[] }).files = [SHA_PDF];
    await t.click(t.byText('Ranger la date'));
    expect(t.state()).toBe('Les délais des avis légaux partent de ce jour. Appuyez de nouveau pour confirmer.');
    expect(posted(t, `${P}/dates`)).toHaveLength(0);
    await t.click(t.byText('Confirmer : cession signée'));
    expect(posted(t, `${P}/dates`)).toHaveLength(1);
    expect(t.state()).toBe('Déclarez d’abord la cession prête : la signature vient après.');
  });

  it('[R116] une cession prête puis redevenue bloquée le dit, et se déclare de nouveau ; une préemption le dit aussi', async () => {
    const t = await run({ ...OPEN, 'GET /v1/commerces/b1/cession': ok(dossier({ declaredReady: '2027-09-10T08:00:00.000Z', missing: ['sequestre'] })) });
    await t.openB1();
    expect(text(t.body())).toContain('Déclarée prête le 10/09/2027, mais il manque de nouveau : séquestre nommé.');
    expect(t.byText('Déclarer la cession prête')).toBeDefined();

    const p = await run({ ...OPEN, 'GET /v1/commerces/b1/cession': ok(dossier({ inPerimeter: true, missing: ['preemption'], lines: [line('preemption', 'preemptee', '2027-12-01')] })) });
    await p.openB1();
    expect(text(p.body())).toContain('La commune a préempté : cette cession ne se fera pas.');
    expect(p.input('Quelle date').children.map((o) => o.value)).toEqual(['cession_prevue']);
  });

  it('les avis ne se proposent qu’après la signature ; la préemption n’a de dates que dans un périmètre', async () => {
    const t = await run({ ...OPEN, 'GET /v1/commerces/b1/cession': ok(dossier({ ...READY, dates: { cession_signee: { day: '2027-09-11', version: 2 } } })) });
    await t.openB1();
    expect(t.input('Quelle date').children.map((o) => o.value)).toEqual(['cession_prevue', 'cession_signee', 'publication_jal', 'publication_bodacc']);
    expect(text(t.body())).toContain('Cession signée : 11/09/2027, corrigée');

    const inside = await run({ ...OPEN, 'GET /v1/commerces/b1/cession': ok(dossier({ inPerimeter: true, lines: [line('preemption', 'a_saisir')] })) });
    await inside.openB1();
    expect(inside.input('Quelle date').children.map((o) => o.value)).toEqual(['cession_prevue', 'declaration_preemption']);
  });

  it('[R117] le séquestre nommé est envoyé ; le réseau ou un agent est refusé en français', async () => {
    const t = await run(OPEN);
    t.table[`POST ${P}/sequestre`] = no(409, { ok: false, rule: 'R117', code: 'sequestre_interdit' });
    await t.openB1();
    sets(t, { 'Qui garde le prix': 'banque', 'Son nom': '  Compte du Réseau Essai ' });
    await t.click(t.byText('Ranger le séquestre'));
    expect(JSON.parse(posted(t, `${P}/sequestre`)[0]!.body!)).toEqual({ kind: 'banque', name: 'Compte du Réseau Essai' });
    expect(t.state()).toBe('Le séquestre est un avocat, un notaire ou une banque nommés, jamais le réseau ni un agent.');
    t.table[`POST ${P}/sequestre`] = ok({});
    await t.click(t.byText('Ranger le séquestre'));
    expect(t.state()).toBe('Séquestre rangé.');
  });

  it('[R16] [R118] l’acquéreur se choisit dans les contacts, jamais par un identifiant ; aucune alerte ne se montre à l’agent', async () => {
    const t = await run(OPEN);
    t.table['GET /v1/offres/biens/b1/contacts'] = ok({ contacts: [{ personId: 'r2', firstName: 'Dominique', lastName: INJECTED }], more: true });
    t.table[`POST ${P}/acquereur`] = ok({ version: 1 });
    await t.openB1();
    const before = t.calls.length;
    expect(t.calls.some((c) => c.url.endsWith('/contacts'))).toBe(false);
    await t.click(t.byText('Choisir dans mes contacts'));
    expect(t.calls.length).toBe(before + 1);
    expect(text(t.body())).toContain('Liste coupée');
    expect(t.body().all().filter((e) => e.tagName === 'img')).toHaveLength(0);
    await t.click(t.byText('Ranger l’acquéreur'));
    expect(t.state()).toBe('Choisissez le contact et dites s’il s’agit d’une société.');
    expect(posted(t, `${P}/acquereur`)).toHaveLength(0);
    // Rien n'est présélectionné : la sorte choisie seule ne range personne.
    expect(t.input('L’acquéreur').children.map((o) => o.value)).toEqual(['', 'r2']);
    sets(t, { 'L’acquéreur': '', 'Il achète': 'oui' });
    await t.click(t.byText('Ranger l’acquéreur'));
    expect(posted(t, `${P}/acquereur`)).toHaveLength(0);
    sets(t, { 'L’acquéreur': 'r2', 'Il achète': 'oui' });
    await t.click(t.byText('Ranger l’acquéreur'));
    expect(JSON.parse(posted(t, `${P}/acquereur`)[0]!.body!)).toEqual({ personId: 'r2', legalPerson: true });
    expect(t.state()).toBe('Acquéreur rangé.');
    expect(text(t.body())).not.toMatch(/alerte|vigilance/i);

    const seen = await run({ ...OPEN, [`GET ${P}/acquereur`]: ok({ firstName: 'Camille', lastName: 'Inventée', legalPerson: false, version: 2 }) });
    await seen.openB1();
    expect(text(seen.body())).toContain('Acquéreur : Camille Inventée');
  });

  it('[R118] la demande d’origine des fonds est lue telle quelle, si le responsable l’a décidée, et rien n’est parti', async () => {
    const none = await run(OPEN);
    await none.openB1();
    expect(text(none.body())).not.toContain('Origine des fonds');

    const asked = await run({ ...OPEN, [`GET ${P}/demande-fonds`]: ok({ text: `Merci de justifier. ${INJECTED}`, documents: ['Relevé inventé'], sent: false }) });
    await asked.openB1();
    expect(text(asked.body())).toContain(`Merci de justifier. ${INJECTED}`);
    expect(text(asked.body())).toContain('Relevé inventé');
    expect(text(asked.body())).toContain('rien n’est parti');
    expect(asked.body().all().filter((e) => e.tagName === 'img')).toHaveLength(0);

    const lost = await run({ ...OPEN, [`GET ${P}/demande-fonds`]: no(500, { ok: false }) });
    await lost.openB1();
    expect(text(lost.body())).toContain('Cette partie ne se lit pas pour le moment.');
  });

  it('[R16] seule la direction range la commune ; l’agent lit qu’elle doit le faire', async () => {
    const agent = await run({ ...OPEN, 'GET /v1/commerces/b1/cession': ok(dossier({ inPerimeter: null })) });
    await agent.openB1();
    expect(text(agent.body())).toContain('La direction doit dire si la commune a un périmètre de sauvegarde.');
    expect(agent.byText('Ranger la commune')).toBeUndefined();

    const dir = await run({ ...OPEN, 'GET /v1/commerces/b1/cession': ok(dossier({ inPerimeter: null })), 'GET /v1/moi': ok({ role: 'direction', firstName: null }) });
    dir.table['POST /v1/commerces/perimetres'] = ok({ version: 1 });
    await dir.openB1();
    expect(dir.calls.some((c) => c.url === '/v1/commerces/taches-cession')).toBe(false);
    await dir.click(dir.byText('Ranger la commune'));
    expect(dir.state()).toBe('Dites si la commune a un périmètre de sauvegarde.');
    sets(dir, { 'Dijon a-t-elle un périmètre de sauvegarde ?': 'non', 'La source : délibération, arrêté': 'Liste inventée', 'Sa date': '2027-01-15' });
    await dir.click(dir.byText('Ranger la commune'));
    expect(JSON.parse(posted(dir, '/v1/commerces/perimetres')[0]!.body!)).toEqual({ postalCode: '21000', city: 'Dijon', inPerimeter: false, source: 'Liste inventée', sourceDate: '2027-01-15' });
  });

  it('le nombre de salariés inconnu se range d’ici, puisqu’il bloque l’étape', async () => {
    const t = await run({ ...OPEN, 'GET /v1/commerces/b1/cession': ok(dossier({ dates: { cession_prevue: { day: '2027-12-17', version: 1 } }, lines: [line('information_salaries', 'a_saisir')] })) });
    t.table['POST /v1/commerces/b1/fiche'] = ok({});
    await t.openB1();
    sets(t, { 'Combien de salariés a l’entreprise ?': 'quatre' });
    await t.click(t.byText('Ranger le nombre'));
    expect(t.state()).toBe('Écrivez un nombre entier, 0 s’il n’y a aucun salarié.');
    sets(t, { 'Combien de salariés a l’entreprise ?': '4' });
    await t.click(t.byText('Ranger le nombre'));
    expect(JSON.parse(posted(t, '/v1/commerces/b1/fiche')[0]!.body!)).toEqual({ employees: 4 });
  });

  it('une réponse perdue est dite telle ; le geste réussi reste dit si la relecture échoue ; un refus de droits est dit', async () => {
    const lost = await run(OPEN);
    await lost.openB1();
    await lost.click(lost.byText('Déclarer la cession prête'));
    expect(lost.state()).toBe('Réponse perdue : ce geste est peut-être rangé. Relisez les étapes avant de recommencer.');
    lost.table[`POST ${P}/prete`] = async () => new Response('panne', { status: 502 });
    await lost.click(lost.byText('Déclarer la cession prête'));
    expect(lost.state()).toBe('Réponse perdue : ce geste est peut-être rangé. Relisez les étapes avant de recommencer.');

    const kept = await run(OPEN);
    await kept.openB1();
    kept.table[`POST ${P}/prete`] = ok({});
    delete kept.table['GET /v1/commerces/b1/public'];
    await kept.click(kept.byText('Déclarer la cession prête'));
    expect(kept.state()).toBe('Cession déclarée prête. L’écran n’a pas pu être relu : réessayez dans un moment.');

    const denied = await run(OPEN);
    denied.table[`POST ${P}/prete`] = no(403, { ok: false, rule: 'R16', code: 'not_assigned' });
    await denied.openB1();
    await denied.click(denied.byText('Déclarer la cession prête'));
    expect(denied.state()).toBe('Ce geste n’est pas dans vos droits.');
  });

  it('[R16] l’agent retrouve ses étapes à faire sur la liste ; une liste illisible le dit', async () => {
    const t = await run({ 'GET /v1/commerces/taches-cession': ok([{ fileId: FILE, propertyId: 'b1', step: 'information_salaries', due: '2027-10-15' }, { fileId: 'f9', propertyId: 'autre', step: 'sequestre', due: null }]) });
    await t.click(t.els['commerces-ouvrir']);
    await t.loadScript();
    expect(text(t.body())).toContain('Mes étapes de cession à faire');
    expect(text(t.body())).toContain('Information des salariés, avant le 15/10/2027');
    expect(text(t.body())).not.toContain('Séquestre nommé');
    await t.click(t.byText('Ouvrir ce commerce'));
    expect(t.els['commerces-titre']!.textContent).toBe('Bien CE-1');

    const off = await run({ 'GET /v1/commerces/taches-cession': no(500, { ok: false }) });
    await off.click(off.els['commerces-ouvrir']);
    await off.loadScript();
    expect(text(off.body())).toContain('Vos étapes de cession ne se lisent pas pour le moment.');
  });

  it('une lecture manquée ne retire aucun geste en silence : demandes, rôle, tâches', async () => {
    const t = await run({ ...OPEN, 'GET /v1/commerces/b1/demandes': no(500, { ok: false }) });
    await t.openB1();
    expect(text(t.body())).toContain('Vos gestes ne se chargent pas : réessayez dans un moment.');
    expect(t.byText('Ranger la date')).toBeUndefined();

    const role = await run(OPEN);
    await role.openB1();
    role.table['GET /v1/moi'] = no(500, { ok: false });
    role.table[`POST ${P}/prete`] = ok({});
    await role.click(role.byText('Déclarer la cession prête'));
    expect(text(role.body())).toContain('Votre rôle ne se lit pas pour le moment');

    const tasks = await run({ 'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }) });
    await tasks.click(tasks.els['commerces-ouvrir']);
    await tasks.loadScript();
    tasks.table['GET /v1/moi'] = no(500, { ok: false });
    await tasks.click(tasks.byText('Ouvrir', 0));
    await tasks.click(tasks.els['commerces-retour']);
    expect(text(tasks.body())).toContain('Vos étapes de cession ne se lisent pas pour le moment.');
  });

  it('[R116] le premier appui armé se désarme si la date change ; une liste de contacts vide se redemande', async () => {
    const t = await run({ ...OPEN, 'GET /v1/commerces/b1/cession': ok(dossier(READY)) });
    t.table['GET /v1/offres/biens/b1/contacts'] = ok({ contacts: [], more: false });
    await t.openB1();
    sets(t, { 'Quelle date': 'cession_signee', 'Le jour': '2027-09-11' });
    (t.input('Sa preuve : courrier, accusé de réception, acte') as unknown as { files: unknown[] }).files = [SHA_PDF];
    await t.click(t.byText('Ranger la date'));
    t.input('Le jour').listeners.change!({});
    expect(t.byText('Ranger la date')).toBeDefined();
    await t.click(t.byText('Choisir dans mes contacts'));
    expect(t.state()).toBe('Aucun contact à proposer : ajoutez d’abord l’acquéreur à vos contacts.');
    expect(isOff(t.byText('Choisir dans mes contacts'))).toBe(false);
  });

  it('[R201] le script de l’écran tient le budget d’une page, et l’application le sien', () => {
    expect(budgetProblems({ html: '', js: COMMERCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });
});
