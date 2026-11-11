import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
import { STREET_VIEW, TOURNEE_REFUSALS, TOURNEE_SCRIPT } from '../app/tournee.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : communes, adresses, positions, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const GOOD_LINK = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=47.12345,4.98765';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const TOUR = {
  date: '2027-10-12',
  stops: [
    { kind: 'panneau', opportunityId: 'panneau:p1', start: '2027-10-12T07:00:00.000Z', end: '2027-10-12T07:10:00.000Z', travelMinutes: 12, town: 'Commune Une', addresses: ['3 rue des Essais, 99000 Commune Une'], streetView: GOOD_LINK, detail: 'Panneau n° 7 à récupérer : bien vendu.' },
    { kind: 'rendez-vous', appointmentKind: 'estimation', start: '2027-10-12T08:00:00.000Z', end: '2027-10-12T09:00:00.000Z', town: 'Commune Deux' },
    // Une position mal formée, ou un lien qui porterait autre chose que la position : jamais posé.
    { kind: 'lettres', opportunityId: 'lettres:c1', start: '2027-10-12T09:30:00.000Z', end: '2027-10-12T09:40:00.000Z', travelMinutes: 0, town: INJECTED, addresses: ['1 allée Inventée', INJECTED], streetView: `${GOOD_LINK}&q=Dupont`, detail: '5 lettres aux habitants à déposer.' },
  ],
  left: [
    { opportunityId: 'diagnostic:d1', kind: 'diagnostic', reason: 'lieu_inconnu' },
    { opportunityId: 'panneau:p2', kind: 'panneau', reason: 'pas_de_place' },
  ],
  outsideZone: 4,
  travelMinutes: 37,
  agendaRelie: false,
};
const MAP = {
  opportunities: [
    { id: 'panneau:p1', kind: 'panneau', town: 'Commune Une', addresses: ['3 rue des Essais, 99000 Commune Une'], place: { lat: 47.12345, lon: 4.98765 }, streetView: GOOD_LINK, minutes: 10, detail: 'Panneau n° 7 à récupérer : bien vendu.' },
    { id: 'diagnostic:d1', kind: 'diagnostic', town: 'Commune Deux', addresses: ['8 impasse Fictive'], place: null, streetView: null, minutes: 10, detail: 'Nouveau diagnostic classé G, établi le 2 octobre 2027.' },
    { id: 'lettres:c1', kind: 'lettres', town: 'Commune Une', addresses: ['1 allée Inventée'], place: null, streetView: 'javascript:alert(1)', minutes: 10, detail: '5 lettres aux habitants à déposer.' },
  ],
  outsideZone: 4,
  agendaRelie: false,
};

const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/gagner/rendez-vous': ok([]),
  'GET /v1/gagner/recommandations/a-appeler': ok([]),
  'GET /v1/gagner/relances': ok([]),
  'GET /v1/gagner/lettres': ok({ campaigns: [], properties: [] }),
  'GET /v1/tournee': ok(TOUR),
  'GET /v1/tournee/carte': ok(MAP),
  'GET /v1/tournee?date=2027-10-13': ok({ ...TOUR, date: '2027-10-13', stops: [], left: [], outsideZone: 0, travelMinutes: 0 }),
  'GET /v1/tournee/carte?date=2027-10-13': ok({ opportunities: [], outsideZone: 0, agendaRelie: false }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['gagner-corps']!;
  const buttons = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = (src: string) => [...els.gagner!.all(), ...els['gagner-corps']!.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  els['gagner-ouvrir']!.listeners.click!({});
  await settle();
  runInNewContext(GAGNER_SCRIPT, context);
  scripts('/app/gagner.js')[0]!.listeners.load!({});
  await settle();
  const part = () => body().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Ma tournée de prospection')!;
  const beforeOpen = scripts('/app/tournee.js').length;
  const callsBefore = calls.length;
  const openTour = async (load = true) => {
    await click(buttons(part(), 'Ouvrir ma tournée')[0]);
    const s = scripts('/app/tournee.js');
    if (load) {
      runInNewContext(TOURNEE_SCRIPT, context);
      s[s.length - 1]!.listeners.load!({});
      await settle();
    }
    return s;
  };
  const lists = (tag: string) => part().all().filter((e) => e.tagName === tag && e.className === 'liste');
  const links = () => part().all().filter((e) => e.tagName === 'a');
  return { calls, part, buttons, click, openTour, lists, links, beforeOpen, callsBefore, settle };
}

describe('BR35 · écran de la tournée de prospection et de la carte des opportunités', () => {
  it('[R201] le script est servi à part, chargé seulement au geste, et tient le budget d’une page ; l’application tient le sien', async () => {
    const t = await run();
    expect(t.beforeOpen).toBe(0);
    expect(t.calls.slice(t.callsBefore).filter((c) => c.url.startsWith('/v1/tournee'))).toEqual([]);
    expect(await t.openTour()).toHaveLength(1);
    expect(AGENT_APP_FILES['/app/tournee.js']).toBe(TOURNEE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/tournee.js');
    expect(JS).not.toContain('/app/tournee.js');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/tournee.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(budgetProblems({ html: '', js: TOURNEE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: GAGNER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });

  it('[R16] [R298] l’écran ne fait que lire /v1/tournee, la clé dans l’en-tête seul, et n’écrit rien', async () => {
    const t = await run();
    await t.openTour();
    const mine = t.calls.slice(t.callsBefore);
    expect(mine.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/tournee', 'GET /v1/tournee/carte']);
    for (const c of mine) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...TOURNEE_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.sort()).toEqual(['/v1/tournee', '/v1/tournee/carte']);
    expect(TOURNEE_SCRIPT).not.toMatch(/'(POST|PUT|PATCH|DELETE)'/);
    expect(TOURNEE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
  });

  it('[R298] les arrêts dans l’ordre reçu, le rendez-vous dit fixe, ce qui ne tient pas avec sa raison en mots', async () => {
    const t = await run();
    await t.openTour();
    const text = t.part().textContent;
    expect(text).toContain('Ma tournée du 12/10/2027');
    expect(text).toContain('rien n’est réservé ni envoyé');
    expect(text).toContain('Votre agenda personnel n’est pas encore relié : seuls vos rendez-vous AIMMO sont comptés.');
    const stops = t.lists('ol')[0]!.children;
    expect(stops).toHaveLength(3);
    expect(stops[0]!.textContent).toContain('09:00 – 09:10 · Panneau à récupérer · Commune Une');
    expect(stops[0]!.textContent).toContain('12 min de route depuis l’arrêt d’avant.');
    expect(stops[0]!.textContent).toContain('3 rue des Essais, 99000 Commune Une');
    expect(stops[1]!.textContent).toContain('10:00 – 11:00 · Estimation (fixe)');
    expect(stops[1]!.textContent).toContain('Rendez-vous déjà pris : il ne bouge pas.');
    expect(stops[2]!.textContent).toContain('Lettres à déposer');
    expect(text).toContain('37 min de route estimées sur la journée.');
    expect(text).toContain('Pas dans la tournée (2)');
    expect(text).toContain('Porte-à-porte après un diagnostic : lieu inconnu : l’adresse n’a pas été reconnue.');
    expect(text).toContain('Panneau à récupérer : pas de place dans vos disponibilités ce jour-là.');
    expect(text).not.toMatch(/lieu_inconnu|pas_de_place|rendez-vous'|diagnostic:d1/);
  });

  it('[R297] hors des zones : un nombre seul ; la carte regroupe par commune dans l’ordre reçu', async () => {
    const t = await run();
    await t.openTour();
    const text = t.part().textContent;
    expect(text).toContain('4 opportunité(s) hors de vos zones : comptée(s), jamais montrée(s).');
    expect(text).toContain('Ma carte des opportunités (3)');
    const heads = t.part().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent);
    expect(heads).toEqual(['Commune Une (2)', 'Commune Deux (1)']);
    expect(text).toContain('Nouveau diagnostic classé G, établi le 2 octobre 2027.');
  });

  it('[R299] le lien de la vue des rues n’est posé qu’à sa forme attendue, dans un nouvel onglet sans référent', async () => {
    const t = await run();
    await t.openTour();
    const links = t.links();
    // Le premier arrêt et sa première opportunité : deux liens, et seulement ceux-là.
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.attributes.href).toBe(GOOD_LINK);
      expect(a.attributes.target).toBe('_blank');
      expect(a.attributes.rel).toBe('noopener noreferrer');
      expect(a.attributes.referrerpolicy).toBe('no-referrer');
    }
    expect(t.part().textContent).toContain('Position inconnue : pas de vue des rues.');
    expect(STREET_VIEW.test(GOOD_LINK)).toBe(true);
    for (const bad of [`${GOOD_LINK}&q=Dupont`, 'javascript:alert(1)', 'https://www.google.com/maps/place/3+rue+des+Essais', GOOD_LINK.replace('https', 'http')]) expect(STREET_VIEW.test(bad), bad).toBe(false);
  });

  it('tout texte reçu est posé en texte, jamais lu comme du HTML', async () => {
    const t = await run();
    await t.openTour();
    expect(t.part().textContent).toContain(INJECTED);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('le jour choisi est transmis tel quel ; un jour vide est refusé avant tout appel', async () => {
    const t = await run();
    await t.openTour();
    const input = t.part().all().find((e) => e.tagName === 'input')!;
    expect(input.attributes.type).toBe('date');
    const before = t.calls.length;
    input.value = '';
    await t.click(t.buttons(t.part(), 'Voir ce jour')[0]);
    expect(t.calls.length).toBe(before);
    expect(t.part().textContent).toContain('Choisissez un jour dans le calendrier.');
    input.value = '2027-10-13';
    await t.click(t.buttons(t.part(), 'Voir ce jour')[0]);
    expect(t.calls.slice(before).map((c) => c.url)).toEqual(['/v1/tournee?date=2027-10-13', '/v1/tournee/carte?date=2027-10-13']);
    expect(t.part().textContent).toContain('Ma tournée du 13/10/2027');
    expect(t.part().textContent).toContain('Aucun arrêt ce jour-là.');
    expect(t.part().textContent).toContain('Aucune opportunité dans vos zones pour le moment.');
  });

  it('l’écran ne montre jamais un code interne : chaque refus connu a ses mots, un code inconnu a une phrase sûre', async () => {
    for (const [code, words] of Object.entries(TOURNEE_REFUSALS)) {
      const t = await run({ 'GET /v1/tournee': no(code === 'role' ? 403 : 409, { ok: false, rule: 'R16', code }), 'GET /v1/tournee/carte': no(500, { ok: false, rule: null, code: 'panne_xyz' }) });
      await t.openTour();
      const text = t.part().textContent;
      if (code !== 'agent_inactive') expect(text, code).toContain(words);
      expect(text).toContain('La carte est indisponible pour le moment.');
      expect(text).not.toContain('panne_xyz');
      expect(text).not.toContain(code === 'role' ? '"role"' : code);
    }
  });

  it('sans réseau, l’écran le dit ; le script qui ne charge pas laisse le bouton utilisable', async () => {
    const off = await run({ 'GET /v1/tournee': () => Promise.reject(new TypeError('hors ligne')), 'GET /v1/tournee/carte': () => Promise.reject(new TypeError('hors ligne')) });
    await off.openTour();
    expect(off.part().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
    const t = await run();
    const s = await t.openTour(false);
    s[0]!.listeners.error!({});
    expect(t.part().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.buttons(t.part(), 'Ouvrir ma tournée')[0] as unknown as { disabled?: boolean }).disabled).toBeFalsy();
  });

  it('deux ouvertures de suite : seule la dernière lecture dessine, même quand la première répond après', async () => {
    let release: () => void = () => undefined;
    let first = true;
    const t = await run({
      'GET /v1/tournee': async () => {
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
          return Response.json({ ok: true, mode: 'essai', data: { ...TOUR, stops: [] } });
        }
        return Response.json({ ok: true, mode: 'essai', data: TOUR });
      },
    });
    await t.openTour();
    await t.click(t.buttons(t.part(), 'Ouvrir ma tournée')[0]);
    release();
    await t.settle();
    const text = t.part().textContent;
    expect(text.match(/Ma tournée du /g)).toHaveLength(1);
    expect(text.match(/Ma carte des opportunités/g)).toHaveLength(1);
    expect(t.lists('ol')[0]!.children).toHaveLength(3);
  });
});
