import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { APPELS_SCRIPT } from '../app/appels.ts';
import { BIENS_FICHE_SCRIPT } from '../app/biens-fiche.ts';
import { CLASSEMENT_SCRIPT } from '../app/classement.ts';
import { FICHE_SCRIPT } from '../app/fiche.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// DS010, DS050, DS022 · la fiche d'un client : son en-tête, ses quatre parties, un seul bouton plein. Tout est
// inventé : clé de test, prénoms, noms, numéro de la plage fictive, messages.
const HTML = AGENT_APP_FILES['/app/']!;
const CSS = AGENT_APP_FILES['/app/app.css']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const KEY = 'k'.repeat(40);
const SERVED = { ...FakeElement.served };
afterEach(() => {
  FakeElement.served = { ...SERVED };
});

type Answer = (init?: { method?: string }) => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const FICHE = {
  personId: 'p-1',
  firstName: 'Léa',
  lastName: 'Exemple',
  contact: { allowed: true, reasons: [] },
  call: 'tel:+33600000001',
  callClosesAt: null,
  callRefusal: null,
  callReopensAt: null,
  projects: [
    { id: 'pr-1', kind: 'sell', stage: 'new', deadline: null, budgetMinEur: null, budgetMaxEur: null },
    { id: 'pr-2', kind: 'buy', stage: 'new', deadline: null, budgetMinEur: null, budgetMaxEur: 320000 },
    { id: 'pr-3', kind: 'sell', stage: 'recue', deadline: null, budgetMinEur: null, budgetMaxEur: null },
  ],
  sources: [{ channel: 'site', detail: 'formulaire test', occurredAt: '2026-10-01T10:00:00.000Z' }],
  consents: [{ id: 'c-1', purpose: 'rappel_demande', channel: 'phone', givenAt: '2026-10-01T10:00:00.000Z', withdrawnAt: null }],
  messages: [
    { channel: 'email', direction: 'out', author: 'agent', body: 'Message envoyé, inventé.', occurredAt: '2026-10-03T09:00:00.000Z' },
    { channel: 'site', direction: 'in', author: 'person', body: 'Message reçu, inventé.', occurredAt: '2026-10-02T09:00:00.000Z' },
  ],
  callbacks: [
    { taskId: 't-1', reason: 'Rappel inventé, à faire', dueAt: '2026-11-10T09:00:00.000Z', doneAt: null },
    { taskId: 't-0', reason: 'Rappel inventé, fait', dueAt: '2026-10-05T09:00:00.000Z', doneAt: '2026-10-04T09:00:00.000Z' },
  ],
  qualification: { id: 'q-1', category: 'seller', route: null, classifiedAt: '2026-10-02T09:00:00.000Z', correction: null },
};
const PLAN = {
  agentId: 'a1',
  day: '2026-11-10',
  computedAt: '2026-11-10T06:30:00.000Z',
  items: ['p-1', 'p-2'].map((personId, i) => ({ rank: i + 1, personId, firstName: i ? 'Bruno' : 'Léa', kind: 'callback', reason: 'A demandé à être rappelé', order: 'règle 1', basis: { kind: 'request', since: '2026-11-01', purpose: null }, projectId: null, taskId: `t-${i + 1}`, reportId: null })),
  removed: { excluded: 0, withdrawn: 0, noBasis: 0 },
  hiddenSinceFrozen: 0,
};
const DAY: Record<string, Answer> = {
  '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
  '/v1/plan-du-jour': ok(PLAN),
  '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
  '/v1/annonces': ok([]),
  '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
  '/v1/alertes-agent': ok({ alerts: [], more: false }),
  '/v1/offres/a-tenir': ok({ fonds: [], financement: [], echeances: [] }),
  '/v1/apres-vente/journee': ok({}),
  '/v1/usage/matin': ok({ scope: 'agent', openedDays: 0, days: [] }),
  '/v1/fiches/p-1/biens': ok([]),
  '/v1/fiches/p-2/biens': ok([]),
};
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML, false));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { url: string; method: string }[] = [];
  const table: Record<string, Answer> = { ...DAY, '/v1/fiches/p-1/resume': ok(FICHE), '/v1/fiches/p-2/resume': ok({ ...FICHE, personId: 'p-2', firstName: 'Bruno', lastName: 'Inventé', callbacks: [], qualification: null }), ...answers };
  const context: Record<string, unknown> = {
    document,
    Date,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      calls.push({ url, method: init.method ?? 'GET' });
      const answer = table[url];
      return answer ? answer(init) : Promise.reject(new TypeError('hors ligne'));
    },
    history: { pushState: () => undefined, replaceState: () => undefined },
    addEventListener: () => undefined,
    location: { origin: 'https://app.aimmo.test', pathname: '/app/', hash: '', replace: () => undefined },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['fiche-corps']!;
  const click = async (e: FakeElement) => {
    e.listeners.click!({});
    await settle();
  };
  /** La fiche d'une personne du plan du jour. */
  const open = (at = 0) => click(els.plan!.all().filter((e) => e.tagName === 'button' && e.textContent === 'Voir la fiche')[at]!);
  const named = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const switcher = () => body().children.find((e) => e.className === 'periodes')!;
  /** Les quatre parties, dans l'ordre : elles suivent le sélecteur dans la fiche. */
  const panels = () => body().children.slice(body().children.indexOf(switcher()) + 1);
  const pressed = () => switcher().children.map((b) => `${b.textContent}:${b.attributes['aria-pressed']}`);
  const shown = () => panels().map((p) => !p.hidden);
  const ficheScripts = () => els.fiche!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/fiche.js');
  return { els, calls, table, context, body, click, open, named, switcher, panels, pressed, shown, ficheScripts };
}

describe('DS010 · la fiche d’un client ouvre sur l’essentiel, et range le reste en quatre parties', () => {
  it('[R201] le dessin de la fiche est servi à part, hors de la coquille, sans écrire de HTML ; l’application y gagne sa place', () => {
    expect(AGENT_APP_FILES['/app/fiche.js']).toBe(FICHE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/fiche.js');
    // Ni l'en-tête, ni les accords, ni les textes d'appel ne sont plus dans le script que tout écran télécharge.
    for (const gone of ['Ne plus contacter', 'Derniers messages', 'Noter l’accord', 'given_before_refusal', 'Appel fermé']) expect(JS).not.toContain(gone);
    for (const here of ['Ne plus contacter', 'Derniers messages', 'Noter l’accord', 'given_before_refusal', 'Appel fermé']) expect(FICHE_SCRIPT).toContain(here);
    // [R13] le script ne pose que du texte.
    expect(FICHE_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(budgetProblems({ html: '', js: FICHE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: CSS, js: JS }, BUDGETS.application)).toEqual([]);
  });

  it('en tête : ce que la personne veut, le dernier message, l’appel, puis les rappels à faire ; un rappel fait garde sa ligne dans le fil [R17]', async () => {
    const a = await run();
    await a.open();
    expect(a.els['fiche-nom']!.textContent).toBe('Léa Exemple');
    const head = a.body().children.slice(0, a.body().children.indexOf(a.switcher()));
    // Chaque projet dit une fois, sans code interne ; le dernier message est le plus récent.
    expect(head[0]!.textContent).toBe('Projets : vendre, acheter. Dernier message envoyé par mail, le 03/10/2026.');
    expect(head[1]!.tagName).toBe('a');
    expect(head[1]!.attributes.href).toBe('tel:+33600000001');
    const todo = head.find((e) => e.className === 'bloc')!;
    expect(todo.textContent).toContain('Rappel inventé, à faire');
    expect(todo.textContent).not.toContain('Rappel inventé, fait');
    expect(todo.all().filter((e) => e.tagName === 'button').map((b) => b.textContent)).toEqual(['Rappel fait']);
    // Le rappel fait est dans le fil, sans bouton.
    const fil = a.panels()[0]!;
    expect(fil.textContent).toContain('Rappels faits');
    expect(fil.textContent).toContain('Rappel inventé, fait');
    expect(fil.all().filter((e) => e.tagName === 'button' && e.textContent === 'Rappel fait')).toEqual([]);
    // Une fiche sans projet ni message le dit, sans rien inventer ; sans rappel à faire, pas de bloc vide en tête.
    const empty = await run({ '/v1/fiches/p-1/resume': ok({ ...FICHE, projects: [], messages: [], callbacks: [] }) });
    await empty.open();
    const top = empty.body().children.slice(0, empty.body().children.indexOf(empty.switcher()));
    expect(top[0]!.textContent).toBe('Aucun projet noté. Aucun message.');
    expect(top.filter((e) => e.className === 'bloc')).toEqual([]);
    expect(empty.panels()[0]!.textContent).not.toContain('Rappels faits');
  });

  it('quatre parties, une seule montrée : le fil d’abord ; chaque bloc a sa partie', async () => {
    const a = await run();
    await a.open();
    expect(a.switcher().attributes.role).toBe('group');
    expect(a.switcher().attributes['aria-label']).toBe('Parties de la fiche');
    expect(a.pressed()).toEqual(['Fil:true', 'Projets:false', 'Biens:false', 'Accords:false']);
    expect(a.shown()).toEqual([true, false, false, false]);
    const [fil, projets, , accords] = a.panels();
    for (const text of ['Derniers messages', 'Message reçu, inventé.', 'Origines', 'site (formulaire test)', 'Appels reçus', 'Notes vocales']) expect(fil!.textContent).toContain(text);
    for (const text of ['Projets', 'Vendre (étape : nouveau)', 'Acheter (étape : nouveau), budget jusqu’à 320000 €', 'Vendre (étape : demande reçue)', 'Dates connues', 'Recommandation d’un proche']) expect(projets!.textContent).toContain(text);
    for (const text of ['Accords', 'Demande de rappel', 'Noter un accord', 'Ouvrir son espace client', 'Réclamations', 'Pièces au coffre']) expect(accords!.textContent).toContain(text);
    // Un geste sur le sélecteur montre la partie choisie, et elle seule.
    await a.click(a.switcher().children[3]!);
    expect(a.pressed()).toEqual(['Fil:false', 'Projets:false', 'Biens:false', 'Accords:true']);
    expect(a.shown()).toEqual([false, false, false, true]);
    await a.click(a.switcher().children[1]!);
    expect(a.shown()).toEqual([false, true, false, false]);
  });

  it('une relecture après un geste garde la partie ouverte ; une fiche ouverte d’ailleurs commence par le fil', async () => {
    const a = await run({ '/v1/fiches/p-1/accords/c-1/retrait': ok({ withdrawn: true }), '/v1/rappels/t-1/fait': ok({}) });
    await a.open();
    await a.click(a.switcher().children[3]!);
    const reads = () => a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume').length;
    expect(reads()).toBe(1);
    await a.click(a.named('Retirer cet accord')[0]!);
    expect(a.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/v1/fiches/p-1/accords/c-1/retrait']);
    expect(reads()).toBe(2);
    expect(a.pressed()).toEqual(['Fil:false', 'Projets:false', 'Biens:false', 'Accords:true']);
    expect(a.shown()).toEqual([false, false, false, true]);
    // « Rappel fait », en tête, relit aussi sans changer de partie.
    await a.click(a.named('Rappel fait')[0]!);
    expect(reads()).toBe(3);
    expect(a.shown()).toEqual([false, false, false, true]);
    // Retour à la journée, puis une autre fiche : le fil.
    await a.click(a.els.retour!);
    await a.open(1);
    expect(a.els['fiche-nom']!.textContent).toBe('Bruno Inventé');
    expect(a.shown()).toEqual([true, false, false, false]);
    // Et la première, rouverte depuis la journée, commence par le fil elle aussi.
    await a.click(a.els.retour!);
    await a.open(0);
    expect(a.shown()).toEqual([true, false, false, false]);
  });

  it('les formulaires ne s’ouvrent qu’au geste : corriger le classement, régler un secteur, ajouter un bien, noter un accord sont des volets fermés', async () => {
    FakeElement.served = { ...SERVED, '/app/biens-fiche.js': BIENS_FICHE_SCRIPT, '/app/classement.js': CLASSEMENT_SCRIPT };
    const a = await run({ '/v1/acquereurs/projets/pr-2/secteur': ok(null) });
    await a.open();
    const folds = a.body().all().filter((e) => e.tagName === 'details');
    expect(folds.map((d) => d.children[0]!.textContent)).toEqual(['Corriger', 'Régler le secteur', 'Ajouter un bien', 'Noter un accord']);
    // Chaque volet garde son formulaire entier : rien n'est retiré, tout attend le geste.
    expect(folds.map((d) => d.all().filter((e) => e.tagName === 'button').map((b) => b.textContent))).toEqual([['Corriger le classement'], ['Ranger le secteur', 'Retirer le secteur', 'Dessiner sur la carte'], ['Créer le bien'], ['Noter l’accord']]);
    for (const d of folds) {
      expect(d.children[0]!.tagName).toBe('summary');
      expect(d.attributes.open).toBeUndefined();
    }
    // Les biens ont leur partie ; le nom à compléter irait avec les accords, la séquence avec les projets.
    const [, projets, biens] = a.panels();
    expect(biens!.textContent).toContain('Biens du client');
    expect(biens!.textContent).not.toContain('Séquence de prospection');
    expect(projets!.textContent).toContain('Séquence de prospection');
    const unnamed = await run({ '/v1/fiches/p-1/resume': ok({ ...FICHE, lastName: null }) });
    await unnamed.open();
    expect(unnamed.panels()[3]!.textContent).toContain('Nom du client');
    expect(unnamed.panels()[2]!.textContent).not.toContain('Nom du client');
  });
});

describe('DS022 · sur la fiche, un seul bouton plein : « Appeler »', () => {
  it('tout geste de la fiche est filaire, blocs servis à part compris ; l’appel est le seul lien plein', async () => {
    FakeElement.served = { ...SERVED, '/app/appels.js': APPELS_SCRIPT, '/app/classement.js': CLASSEMENT_SCRIPT, '/app/biens-fiche.js': BIENS_FICHE_SCRIPT };
    const a = await run();
    await a.open();
    const buttons = a.body().all().filter((e) => e.tagName === 'button');
    // Les gestes d'appel, le classement, les biens, la séquence et la recherche d'un acquéreur sont bien là.
    for (const text of ['J’ai appelé', 'La personne a refusé', 'Rappel fait', 'Corriger le classement', 'Créer le bien', 'Préparer une séquence', 'Chercher avec ses mots', 'Recherche toujours d’actualité', 'Retirer cet accord', 'Noter l’accord', 'Ouvrir son espace client', 'Appels reçus', 'Pièces au coffre']) expect(buttons.map((b) => b.textContent)).toContain(text);
    // La règle du contrôle du système (DS087) : un bouton sans classe filaire est plein.
    const filled = buttons.filter((b) => !b.className.split(/\s+/).some((c) => /^(?:secondaire|second|retour|discret)$/.test(c)));
    expect(filled.map((b) => b.textContent)).toEqual([]);
    const calls = a.body().all().filter((e) => e.tagName === 'a');
    expect(calls.map((c) => [c.className, c.textContent])).toEqual([['appel', 'Appeler']]);
  });
});

describe('DS050 · la fiche ouvre sur le geste du jour, dans le respect des règles d’appel', () => {
  it('[R03] l’appel fermé dit pourquoi, et où noter l’accord ; [R02, R04] une personne exclue n’a ni appel ni geste d’appel', async () => {
    const closed = await run({ '/v1/fiches/p-1/resume': ok({ ...FICHE, call: null, callRefusal: 'no_consent', consents: [] }) });
    await closed.open();
    const top = closed.body().children.slice(0, closed.body().children.indexOf(closed.switcher()));
    expect(top[1]!.className).toBe('alerte');
    expect(top[1]!.textContent).toBe('Appel fermé : aucun accord ni demande de rappel enregistrés. Notez-les dans « Accords » si la personne vous les a donnés.');
    expect(closed.body().all().filter((e) => e.tagName === 'a')).toEqual([]);
    // Les gestes d'appel restent : un appel a pu être passé d'un autre téléphone.
    expect(closed.body().all().filter((e) => e.tagName === 'script').map((e) => e.attributes.src)).toContain('/app/appels.js');
    const out = await run({ '/v1/fiches/p-1/resume': ok({ ...FICHE, contact: { allowed: false, reasons: ['stop'] } }) });
    await out.open();
    const first = out.body().children.slice(0, out.body().children.indexOf(out.switcher()));
    expect(first[1]!.textContent).toBe('Ne plus contacter : a demandé l’arrêt.');
    expect(out.body().all().filter((e) => e.tagName === 'a')).toEqual([]);
    expect(out.body().all().filter((e) => e.tagName === 'script').map((e) => e.attributes.src)).not.toContain('/app/appels.js');
    // Une personne exclue n'a plus de formulaire d'accord [R02, R04].
    expect(out.body().all().filter((e) => e.tagName === 'details').map((d) => d.children[0]!.textContent)).not.toContain('Noter un accord');
  });

  it('aucun lien pour écrire depuis le téléphone de l’agent : un message ne part que par le contrôle central des envois', () => {
    // Décidé, lecture prudente (DS050) : ni `sms:` ni `mailto:` tant que le cahier ne l'a pas tranché.
    // Un lien de ce genre serait un texte qui commence par le nom du canal : aucun dans la fiche, aucun dans l'application.
    const link = /['"`](?:sms|mailto|whatsapp):|wa\.me/;
    expect(FICHE_SCRIPT).not.toMatch(link);
    expect(JS).not.toMatch(link);
  });
});

describe('[R201] le chargeur des écrans servis à part : le dernier geste gagne', () => {
  it('pendant que le script arrive, une fiche quittée ne s’affiche pas, et celle qui est ouverte s’affiche', async () => {
    FakeElement.served = {};
    const a = await run();
    await a.open(0);
    expect(a.ficheScripts()).toHaveLength(1);
    expect(a.els['fiche-etat']!.textContent).toBe('Chargement…');
    // L'agent revient à sa journée, puis ouvre une autre fiche : le script n'est demandé qu'une fois.
    await a.click(a.els.retour!);
    await a.open(1);
    expect(a.ficheScripts()).toHaveLength(1);
    expect(a.els['fiche-etat']!.textContent).toBe('Chargement…');
    // Le script arrive : c'est la fiche ouverte qui se dessine, jamais celle qui a été quittée.
    runInNewContext(FICHE_SCRIPT, a.context);
    a.ficheScripts()[0]!.listeners.load!({});
    await settle();
    expect(a.els['fiche-nom']!.textContent).toBe('Bruno Inventé');
    expect(a.els['fiche-etat']!.textContent).toBe('');
    expect(a.body().textContent).toContain('Derniers messages');
    // Le script est gardé : la fiche suivante se dessine sans le redemander.
    await a.click(a.els.retour!);
    await a.open(0);
    expect(a.ficheScripts()).toHaveLength(1);
    expect(a.els['fiche-nom']!.textContent).toBe('Léa Exemple');
  });

  it('[R10] le script perdu se dit, sans rien montrer ; rouvrir la fiche le redemande', async () => {
    FakeElement.served = {};
    const a = await run();
    await a.open(0);
    a.ficheScripts()[0]!.listeners.error!({});
    await settle();
    expect(a.els['fiche-etat']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(a.body().children).toHaveLength(0);
    await a.click(a.els.retour!);
    FakeElement.served = { ...SERVED };
    await a.open(0);
    expect(a.els['fiche-nom']!.textContent).toBe('Léa Exemple');
    expect(a.els['fiche-etat']!.textContent).toBe('');
  });

  it('[R16] une fiche hors des droits ne montre rien ; une panne propose de réessayer', async () => {
    const denied = await run({ '/v1/fiches/p-1/resume': async () => Response.json({ ok: false, rule: 'R16', code: 'not_assigned' }, { status: 403 }) });
    await denied.open(0);
    expect(denied.els['fiche-etat']!.textContent).toBe('Cette fiche n’est pas dans vos droits.');
    expect(denied.body().children).toHaveLength(0);
    const down = await run({ '/v1/fiches/p-1/resume': async () => Response.json({ ok: false }, { status: 500 }) });
    await down.open(0);
    expect(down.els['fiche-etat']!.textContent).toBe('Indisponible pour le moment.Réessayer');
    expect(down.body().children).toHaveLength(0);
  });
});

/** Dans Chromium, là où Playwright et son navigateur sont installés : sinon l'essai se signale sauté. */
type Navigateur = { newPage(o?: object): Promise<any>; close(): Promise<void> };
async function lancer(): Promise<Navigateur | null> {
  try {
    const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Navigateur> } };
    return await chromium.launch();
  } catch {
    return null;
  }
}
const navigateur = await lancer();
afterAll(async () => {
  await navigateur?.close();
});

describe('DS010 · dans Chromium', () => {
  it.skipIf(navigateur === null)('sur un téléphone, la fiche ouvre en deux écrans et demi au plus, sans déborder ; une seule partie se voit, et un seul bouton plein', async () => {
    const answers: Record<string, Answer> = { ...DAY, '/v1/fiches/p-1/resume': ok(FICHE) };
    const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      page.setDefaultTimeout(5000);
      await page.addInitScript((k: string) => (globalThis as any).localStorage.setItem('aimmo.cle', k), KEY);
      await page.route('**/*', async (route: any) => {
        const path = new URL(route.request().url()).pathname;
        const file = AGENT_APP_FILES[path];
        if (file !== undefined) return route.fulfill({ status: 200, contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('/') ? 'text/html' : 'application/octet-stream', body: file });
        const answer = answers[path];
        if (!answer) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: await (await answer()).text() });
      });
      await page.goto('https://aimmo.example.test/app/');
      await page.waitForSelector('#plan button');
      await page.click('#plan button:has-text("Voir la fiche")');
      await page.waitForSelector('#fiche-corps .periodes');
      await page.waitForSelector('#fiche-corps .gestes');
      await page.waitForSelector('#fiche-corps details', { state: 'attached' });
      const measure = () =>
        page.evaluate(() => {
          const d = (globalThis as any).document;
          const seen = (e: any) => e.offsetParent !== null;
          return {
            screens: d.documentElement.scrollHeight / (globalThis as any).innerHeight,
            overflow: d.documentElement.scrollWidth > (globalThis as any).innerWidth,
            filled: [...d.querySelectorAll('#fiche button, #fiche a.appel')].filter((b: any) => seen(b) && !/(^| )(secondaire|second|retour|discret)( |$)/.test(b.className)).map((b: any) => b.textContent),
            headings: [...d.querySelectorAll('#fiche-corps h3')].filter(seen).map((h: any) => h.textContent),
          };
        });
      // L'audit comptait 5,2 écrans, 14 blocs et 9 boutons pleins. La fiche ouvre en deux écrans et demi au plus.
      const fil = await measure();
      expect(fil.screens).toBeLessThanOrEqual(2.5);
      expect(fil.overflow).toBe(false);
      expect(fil.filled).toEqual(['Appeler']);
      expect(fil.headings).toEqual(['Rappels', 'Derniers messages', 'Rappels faits', 'Origines']);
      // Les deux gestes d'appel tiennent sur une ligne, à la taille du doigt.
      const gestures = await page.evaluate(() => [...(globalThis as any).document.querySelectorAll('#fiche-corps .gestes > button')].map((b: any) => { const r = b.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; }));
      expect(gestures).toHaveLength(2);
      expect(gestures[0]!.top).toBe(gestures[1]!.top);
      for (const g of gestures) expect(g.h).toBeGreaterThanOrEqual(44);
      // Chaque partie tient elle aussi, avec ses formulaires fermés ; le sélecteur dit laquelle est ouverte.
      for (const [name, heading] of [['Projets', 'Projets'], ['Biens', 'Biens du client'], ['Accords', 'Accords']] as const) {
        await page.click(`#fiche-corps .periodes button:has-text("${name}")`);
        const part = await measure();
        // La partie la plus longue est celle des projets d'un acquéreur : trois écrans au plus, formulaires fermés.
        expect(part.screens).toBeLessThanOrEqual(3);
        expect(part.overflow).toBe(false);
        expect(part.filled).toEqual(['Appeler']);
        expect(part.headings).toContain(heading);
        expect(part.headings).not.toContain('Derniers messages');
        expect(await page.getAttribute(`#fiche-corps .periodes button:has-text("${name}")`, 'aria-pressed')).toBe('true');
      }
      // Le volet s'ouvre au geste, au clavier comme au doigt.
      expect(await page.isVisible('#fiche-corps label:has-text("Sujet")')).toBe(false);
      await page.click('#fiche-corps summary:has-text("Noter un accord")');
      expect(await page.isVisible('#fiche-corps label:has-text("Sujet")')).toBe(true);
      // Le titre de la page ne dit jamais le nom d'une personne (DS063).
      expect(await page.title()).toBe('Fiche client · AIMMO');
    } finally {
      await page.close();
    }
  });
});
