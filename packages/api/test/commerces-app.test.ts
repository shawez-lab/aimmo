import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { htmlProblems } from '../../core/src/design/audit.ts';
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
    const screen = t.calls.filter((c) => !/^\/v1\/(moi|plan-du-jour|contacts-chauds|rendez-vous|usage|annonces$|apres-vente)/.test(c.url));
    expect(screen.length).toBeGreaterThan(10);
    for (const c of screen) {
      expect(c.url.startsWith('/v1/commerces'), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...COMMERCES_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(3);
    for (const r of routes) expect(r.startsWith('/v1/commerces'), r).toBe(true);
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
