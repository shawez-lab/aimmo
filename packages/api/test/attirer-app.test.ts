import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { bodyParagraphs } from '../../core/src/attirer/quartier.ts';
import { SITE_KINDS } from '../../core/src/attirer/referencement.ts';
import { ATTIRER_SCRIPT } from '../app/attirer.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { attirerRoutes } from '../src/attirer.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : sites, chiffres, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

/** Le mois en cours à Paris, comme l'écran le demande. */
const MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
// Des chiffres impossibles à retrouver par un calcul : l'écran montre ceux du serveur, tels quels.
const MEASURE = {
  month: MONTH,
  contacts: 41,
  withOrigin: 17,
  percent: 73.7,
  targetPercent: 95,
  meetsTarget: false,
  byKind: [{ kind: 'video', contacts: 9 }, { kind: 'inconnue', contacts: 3 }, { kind: 'bien', contacts: 5 }],
  byContent: [{ contentId: 'c1', kind: 'video', ref: 'id-interne', title: INJECTED, contacts: 9 }],
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'direction', firstName: null }),
  'GET /v1/attirer/prix/versions': ok([{ id: 'v1', dvfLastSale: '2026-06-30', source: 'DVF, jeu inventé', completedAt: '2026-08-01T08:00:00.000Z' }]),
  'GET /v1/attirer/sites': ok([
    { siteId: 's1', kind: 'reseau', agentId: null, baseUrl: 'https://reseau.exemple.test' },
    { siteId: 's2', kind: 'agent', agentId: 'ag-1', baseUrl: 'https://camille.exemple.test' },
  ]),
  [`GET /v1/attirer/origine/${MONTH}`]: ok(MEASURE),
  'GET /v1/attirer/prix/zones': ok([
    { id: 'zc', level: 'commune', parentId: null, name: 'Ville Test' },
    { id: 'z1', level: 'quartier', parentId: 'zc', name: 'Ouest' },
  ]),
  'GET /v1/attirer/prix/zones/a-refaire': ok([]),
  'POST /v1/attirer/prix/zones': ok({ id: 'z9' }),
  'POST /v1/attirer/prix/zones/z1/retrait': ok({ id: 'z1' }),
  'GET /v1/attirer/agents': ok({
    holder: 'Société Exemple',
    cardNumber: 'CPI 9999',
    agents: [
      { agentId: 'ag-1', name: 'Camille Essai', rsacNumber: '123456789', rsacRegistry: 'Dijon', missing: null, site: { baseUrl: 'https://camille.exemple.test', active: true } },
      { agentId: 'ag-2', name: 'Lou Essai', rsacNumber: null, rsacRegistry: null, missing: 'statut_manquant', site: { baseUrl: 'https://lou.exemple.test', active: false } },
      { agentId: 'ag-3', name: 'Inès Essai', rsacNumber: '987654321', rsacRegistry: 'Dijon', missing: 'titulaire_manquant', site: null },
    ],
  }),
  'POST /v1/attirer/agents/ag-2/mentions': ok({}),
  'POST /v1/attirer/titulaire': ok({}),
  'GET /v1/attirer/quartiers': ok([{ zoneId: 'z1', name: 'Ouest', communeName: 'Ville Test' }]),
  'GET /v1/attirer/quartiers/z1/faits': ok([{ key: 'tram', kind: 'transport', label: 'Arrêts de tram', value: 2, unit: 'nombre', source: 'Carte inventée', sourceDate: '2026-01-15' }]),
  'GET /v1/attirer/quartiers/z1/textes': ok([
    { draftId: 'd2', zoneSlug: 'ouest', kind: 'page', topic: 'quartier', title: 'Le quartier Ouest', body: `Deux arrêts\nde tram.\n\nUne phrase ${INJECTED}.`, paragraphs: bodyParagraphs(`Deux arrêts\nde tram.\n\nUne phrase ${INJECTED}.`), current: true, origin: 'secours', trace: { ok: true, sentences: [{ text: 'Deux arrêts de tram.', sources: [{ ref: 'tram', source: 'Carte inventée', date: '2026-01-15' }], problems: [] }] }, validatedBy: null, validatedAt: null },
    { draftId: 'd1', zoneSlug: 'ouest', kind: 'article', topic: 'prix', title: 'Les prix', body: 'Texte ancien.', paragraphs: ['Texte ancien.'], current: false, origin: 'ia', trace: { ok: false, sentences: [{ text: 'Texte ancien.', sources: [], problems: [{ code: 'jugement', value: 'charmant' }] }] }, validatedBy: 'direction:d', validatedAt: '2026-02-01T08:00:00.000Z' },
  ]),
  'POST /v1/attirer/quartiers/z1/faits': ok({}),
  'POST /v1/attirer/quartiers/z1/brouillon': ok({ draftId: 'd3' }),
  'POST /v1/attirer/quartiers/z1/texte': ok({ draftId: 'd4' }),
  'POST /v1/attirer/quartiers/textes/d2/valider': ok({ draftId: 'd2' }),
  'GET /v1/attirer/sites/s1/plan': ok([{ loc: 'https://reseau.exemple.test/prix/commune-une', lastmod: null, kind: 'prix' }]),
  'POST /v1/attirer/prix/recalcul': ok({ ran: true, versionId: 'v2', published: 12, carried: 4, held: 3 }),
  'POST /v1/attirer/sites': ok({ siteId: 's3' }),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Une horloge qu'un test avance : un double appui immédiat n'est pas une confirmation. */
let clock = 0;
class Clock extends Date {
  static override now(): number {
    return clock;
  }
}
const later = (ms: number) => {
  clock += ms;
};
/** Une réponse qui n'arrive que quand le test le décide. */
function deferred(body: unknown) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer: Answer = async () => {
    await held;
    return Response.json({ ok: true, mode: 'essai', data: body });
  };
  return { answer, release };
}

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
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
    Intl,
    Date: Clock,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['attirer-corps']!;
  const state = () => els['attirer-etat']!.textContent;
  const buttons = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
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
  const scripts = () => els.attirer!.children.filter((e) => e.tagName === 'script');
  const ouvrir = async () => {
    await click(els['attirer-ouvrir']);
    const s = scripts();
    if (s.length === 1 && !body().children.length) {
      runInNewContext(ATTIRER_SCRIPT, context);
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  /** Changer l'adresse du site du réseau : deux appuis, espacés. */
  const changer = async (url: string) => {
    input('Changer l’adresse du site du réseau').value = url;
    const b = buttons('Changer l’adresse')[0];
    await click(b);
    later(2000);
    await click(b);
  };
  return { els, calls, context, click, body, buttons, texts, input, state, posts, scripts, ouvrir, storage, changer };
}

describe('AT12 · écran « Attirer » de la direction', () => {
  it('[R16] l’écran ne lit et n’écrit que par /v1/attirer, la clé dans l’en-tête seul', async () => {
    const t = await run();
    const before = t.calls.length;
    await t.ouvrir();
    await t.click(t.buttons('Voir le plan')[0]);
    const mine = t.calls.slice(before);
    expect(mine.length).toBeGreaterThan(3);
    for (const c of mine) {
      expect(c.url.startsWith('/v1/attirer/')).toBe(true);
      expect(c.url).not.toContain(KEY);
      expect(c.auth).toBe(`Bearer ${KEY}`);
    }
  });

  it('[R16] chaque adresse appelée existe parmi les routes de M01, réservées à la direction', async () => {
    const t = await run();
    const before = t.calls.length;
    await t.ouvrir();
    await t.click(t.buttons('Voir le plan')[0]);
    await t.click(t.buttons('Recalculer les prix')[0]);
    await t.changer('https://neuf.exemple.test');
    const routes = attirerRoutes();
    for (const c of t.calls.slice(before)) {
      const path = c.url.slice('/v1'.length);
      const route = routes.find((r) => r.method === c.method && r.pattern.test(path));
      expect(route, c.url).toBeDefined();
      expect(route!.roles).toEqual(['direction']);
    }
  });

  it('[R16] le corps envoyé pour un site est bien celui que la route attend', async () => {
    const t = await run();
    await t.ouvrir();
    await t.changer('  https://neuf.exemple.test ');
    const sent = JSON.parse(t.posts()[0]!.body!);
    expect(sent).toEqual({ kind: 'reseau', baseUrl: 'https://neuf.exemple.test', active: true });
    expect(SITE_KINDS).toContain(sent.kind);
    expect(t.state()).toBe('Site mis en service.');
    const u = await run({ 'GET /v1/attirer/sites': ok([]) });
    await u.ouvrir();
    u.input('Adresse du site du réseau').value = 'https://premier.exemple.test';
    await u.click(u.buttons('Mettre en service')[0]);
    expect(JSON.parse(u.posts()[0]!.body!)).toEqual({ kind: 'reseau', baseUrl: 'https://premier.exemple.test', active: true });
  });

  it('l’entrée est dans l’écran du réseau, qu’un agent n’ouvre jamais', async () => {
    // DS069 : l'écran du réseau est servi à part ; l'entrée y est, et la page de l'agent ne la porte pas.
    expect(AGENT_APP_FILES['/app/reseau.html']).toContain('id="attirer-ouvrir"');
    expect(HTML).not.toContain('id="attirer-ouvrir"');
    expect(HTML).toContain('<section id="reseau" hidden></section>');
    const agent = await run({ 'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }), 'GET /v1/plan-du-jour': ok(null) });
    expect(agent.els.reseau!.hidden).toBe(true);
    const direction = await run();
    expect(direction.els.reseau!.hidden).toBe(false);
  });

  it('les chiffres sont ceux du serveur, tels quels, dans l’ordre reçu', async () => {
    const t = await run();
    await t.ouvrir();
    const shown = t.texts();
    expect(shown).toContain('73,7 % des contacts ont leur origine connue');
    expect(shown).toContain('17 sur 41 contacts. Cible : 95 %, pas encore tenue.');
    expect(shown.indexOf('Vidéo : 9')).toBeLessThan(shown.indexOf('Origine inconnue : 3'));
    expect(shown.indexOf('Origine inconnue : 3')).toBeLessThan(shown.indexOf('Page d’un bien : 5'));
    expect(shown).toContain('DVF, jeu inventé');
  });

  it('un autre mois se lit à la demande, et reste choisi après un geste', async () => {
    const t = await run();
    await t.ouvrir();
    const f = t.input('Mois');
    const before = t.calls.length;
    f.value = '2020-01';
    f.listeners.change!({});
    await settle();
    expect(t.calls.slice(before).some((c) => c.url === '/v1/attirer/origine/2020-01')).toBe(true);
    const again = t.calls.length;
    await t.click(t.buttons('Recalculer les prix')[0]);
    expect(t.calls.slice(again).some((c) => c.url === '/v1/attirer/origine/2020-01')).toBe(true);
  });

  it('un contact sans origine connue n’affiche pas de pourcentage trompeur', async () => {
    const t = await run({ [`GET /v1/attirer/origine/${MONTH}`]: ok({ ...MEASURE, contacts: 0, withOrigin: 0, percent: 0, byKind: [], byContent: [] }) });
    await t.ouvrir();
    expect(t.texts()).toContain('Aucun contact ce mois-là.');
    expect(t.texts()).not.toContain('0 % des contacts');
  });

  it('un double appui ne relance qu’un recalcul', async () => {
    const t = await run();
    await t.ouvrir();
    const b = t.buttons('Recalculer les prix')[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await settle();
    expect(t.posts().filter((c) => c.url === '/v1/attirer/prix/recalcul')).toHaveLength(1);
    expect(t.state()).toBe('Nouvelle version : 12 prix publiés, 4 repris de la version d’avant, 3 retenus.');
  });

  it('un recalcul qui ne produit rien le dit en français, sans code', async () => {
    const t = await run({ 'POST /v1/attirer/prix/recalcul': ok({ ran: false, reason: 'source_incomplete' }) });
    await t.ouvrir();
    await t.click(t.buttons('Recalculer les prix')[0]);
    expect(t.state()).toBe('La lecture des ventes publiques est incomplète : les prix en ligne ne changent pas.');
    const u = await run({ 'POST /v1/attirer/prix/recalcul': no(400, { ok: false, rule: null, code: 'source_absente' }) });
    await u.ouvrir();
    await u.click(u.buttons('Recalculer les prix')[0]);
    expect(u.state()).toBe('La source des ventes publiques n’est pas branchée : aucun recalcul pour le moment.');
  });

  it('un refus est dit en français, sans code ni donnée', async () => {
    const t = await run({ 'POST /v1/attirer/sites': no(409, { ok: false, rule: 'R153', code: 'url_taken', secret: 'x' }) });
    await t.ouvrir();
    await t.changer('https://pris.exemple.test');
    expect(t.state()).toBe('Cette adresse sert déjà un autre site : une seule page de référence par bien.');
    const u = await run({ 'GET /v1/attirer/sites': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await u.ouvrir();
    expect(u.texts()).toContain('Ce n’est pas dans vos droits.');
    expect(u.texts()).not.toContain('R16');
    expect(u.texts()).toContain('Prix publics');
  });

  it('AT17 : l’adresse d’un agent parti se lit et se libère en deux appuis ; sans adresse gardée, rien ne s’affiche', async () => {
    const agents = await (await BASE['GET /v1/attirer/agents']!()).json() as { data: Record<string, unknown> };
    const t = await run({ 'GET /v1/attirer/agents': ok({ ...agents.data, departed: [{ agentId: 'ag-9', name: INJECTED, baseUrl: 'https://parti.exemple.test' }] }) });
    await t.ouvrir();
    expect(t.texts()).toContain('Adresses gardées par un agent parti');
    expect(t.texts()).toContain('https://parti.exemple.test');
    expect(t.texts()).not.toContain('ag-9');
    // Le nom est du texte, jamais du balisage.
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    const free = t.buttons('Libérer l’adresse')[0]!;
    await t.click(free);
    expect(t.posts()).toHaveLength(0);
    expect(t.state()).toBe('Un autre site pourra prendre cette adresse. Appuyez de nouveau pour confirmer.');
    later(2000);
    await t.click(free);
    expect(t.posts().map((c) => [c.url, JSON.parse(c.body!)])).toEqual([['/v1/attirer/sites', { kind: 'agent', agentId: 'ag-9', baseUrl: 'https://parti.exemple.test', active: false }]]);
    expect(t.state()).toBe('Adresse libérée.');
    const u = await run();
    await u.ouvrir();
    expect(u.texts()).not.toContain('agent parti');
  });

  it('AT17 : une adresse gardée par un agent parti est dite en français, avec où la libérer', async () => {
    const t = await run({ 'POST /v1/attirer/sites': no(409, { ok: false, rule: 'R153', code: 'url_agent_parti' }) });
    await t.ouvrir();
    await t.changer('https://parti.exemple.test');
    expect(t.state()).toBe('Cette adresse reste gardée par un agent parti : libérez-la dans « Agents, mentions et sites ».');
    expect(t.state()).not.toContain('url_agent_parti');
  });

  it('mettre le site du réseau hors service se confirme ; un double appui immédiat ne coupe rien', async () => {
    const t = await run();
    await t.ouvrir();
    const off = t.buttons('Mettre hors service')[0]!;
    await t.click(off);
    expect(off.textContent).toBe('Confirmer : mettre hors service');
    await t.click(off);
    expect(t.posts()).toHaveLength(0);
    later(2000);
    await t.click(off);
    expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: false });
    expect(t.state()).toBe('Site mis hors service.');
  });

  it('une demande de confirmation restée sans suite retombe', async () => {
    const t = await run();
    await t.ouvrir();
    const off = t.buttons('Mettre hors service')[0]!;
    await t.click(off);
    later(60000);
    await t.click(off);
    expect(t.posts()).toHaveLength(0);
    expect(off.textContent).toBe('Confirmer : mettre hors service');
  });

  it('un recalcul en vol reste seul, même si l’écran est relu entre-temps', async () => {
    const d = deferred({ ran: true, versionId: 'v2', published: 1, carried: 0, held: 0 });
    const t = await run({ 'POST /v1/attirer/prix/recalcul': d.answer });
    await t.ouvrir();
    await t.click(t.buttons('Recalculer les prix')[0]);
    const f = t.input('Mois');
    f.value = '2020-01';
    f.listeners.change!({});
    await settle();
    await t.click(t.buttons('Recalculer les prix')[0]);
    const count = () => t.posts().filter((c) => c.url === '/v1/attirer/prix/recalcul').length;
    expect(count()).toBe(1);
    d.release();
    await settle();
    await t.click(t.buttons('Recalculer les prix')[0]);
    expect(count()).toBe(2);
  });

  it('une clé refusée efface tout, et ramène à la connexion', async () => {
    const t = await run({ 'POST /v1/attirer/prix/recalcul': no(401, { ok: false }) });
    await t.ouvrir();
    await t.click(t.buttons('Recalculer les prix')[0]);
    expect(t.body().children.length).toBe(0);
    expect(t.state()).toBe('');
    expect(t.storage.has('aimmo.cle')).toBe(false);
    expect(t.els.connexion!.hidden).toBe(false);
  });

  it('une réponse arrivée après la sortie n’est jamais montrée', async () => {
    const d = deferred([{ siteId: 's9', kind: 'reseau', agentId: null, baseUrl: 'https://tardif.exemple.test' }]);
    const u = await run({ 'GET /v1/attirer/sites': d.answer });
    await u.click(u.els['attirer-ouvrir']);
    const s = u.scripts()[0]!;
    runInNewContext(ATTIRER_SCRIPT, u.context);
    s.listeners.load!({});
    await settle();
    await u.click(u.els['attirer-retour']);
    d.release();
    await settle();
    expect(u.body().children.length).toBe(0);
    expect(u.els.attirer!.hidden).toBe(true);
  });

  it('un texte reçu n’est jamais lu comme du HTML', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.body().all().some((e) => e.textContent.includes(INJECTED))).toBe(true);
    expect(ATTIRER_SCRIPT).not.toContain('innerHTML');
    expect(t.body().all().every((e) => e.tagName !== 'img')).toBe(true);
  });

  it('sortir de l’écran efface ce qu’il montrait', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.body().children.length).toBeGreaterThan(0);
    const f = t.input('Mois');
    f.value = '2020-01';
    f.listeners.change!({});
    await settle();
    await t.click(t.els['attirer-retour']);
    expect(t.body().children.length).toBe(0);
    expect(t.state()).toBe('');
    expect(t.els.attirer!.hidden).toBe(true);
    const before = t.calls.length;
    await t.ouvrir();
    expect(t.calls.slice(before).some((c) => c.url === `/v1/attirer/origine/${MONTH}`)).toBe(true);
  });

  it('pas de réseau : c’est dit, rien n’est inventé', async () => {
    const t = await run({ 'GET /v1/attirer/prix/versions': async () => Promise.reject(new TypeError('x')), 'GET /v1/attirer/sites': async () => Promise.reject(new TypeError('x')), 'GET /v1/attirer/quartiers': async () => Promise.reject(new TypeError('x')), 'GET /v1/attirer/prix/zones': async () => Promise.reject(new TypeError('x')), 'GET /v1/attirer/agents': async () => Promise.reject(new TypeError('x')), 'GET /v1/attirer/prix/zones/a-refaire': async () => Promise.reject(new TypeError('x')), [`GET /v1/attirer/origine/${MONTH}`]: async () => Promise.reject(new TypeError('x')) });
    await t.ouvrir();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  describe('AT16 · agents, mentions et sites', () => {
    it('[R16] chaque appel existe sous la direction, et aucun identifiant n’est montré', async () => {
      const t = await run();
      const before = t.calls.length;
      await t.ouvrir();
      expect(t.texts()).not.toContain('ag-1');
      expect(t.texts()).not.toContain('id-interne');
      await t.click(t.buttons('Enregistrer l’immatriculation')[1]);
      const routes = attirerRoutes();
      for (const c of t.calls.slice(before)) {
        const route = routes.find((r) => r.method === c.method && r.pattern.test(c.url.slice('/v1'.length)));
        expect(route, c.url).toBeDefined();
        expect(route!.roles).toEqual(['direction']);
      }
    });

    it('[R152] chaque agent dit si sa page est publiée, et ce qui manque, en français', async () => {
      const t = await run();
      await t.ouvrir();
      const shown = t.texts();
      expect(shown).toContain('Mentions complètes : sa page peut être servie.');
      expect(shown).toContain('Page non publiée : son immatriculation manque.');
      expect(shown).toContain('Page non publiée : le titulaire de la carte manque.');
      expect(shown).not.toContain('statut_manquant');
    });

    it('[R152] l’immatriculation part avec ses champs ; un refus reste en français et sans code', async () => {
      const t = await run({ 'POST /v1/attirer/agents/ag-2/mentions': no(409, { ok: false, rule: 'R152', code: 'rsac' }) });
      await t.ouvrir();
      t.input('Numéro RSAC', 1).value = 'pas un numéro';
      t.input('Greffe', 1).value = 'Dijon';
      await t.click(t.buttons('Enregistrer l’immatriculation')[1]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ rsacNumber: 'pas un numéro', rsacRegistry: 'Dijon' });
      expect(t.state()).toBe('Le numéro d’immatriculation n’est pas lisible : neuf chiffres, avec RSAC devant ou non.');
    });

    it('[R153] un site d’agent hors service se remet en service depuis l’écran, avec son genre et son agent', async () => {
      const t = await run();
      await t.ouvrir();
      await t.click(t.buttons('Remettre en service')[0]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ kind: 'agent', agentId: 'ag-2', baseUrl: 'https://lou.exemple.test', active: true });
      expect(t.state()).toBe('Site remis en service.');
    });

    it('[R153] mettre hors service le site d’un agent se confirme', async () => {
      const t = await run();
      await t.ouvrir();
      const b = t.buttons('Mettre hors service')[1]!;
      await t.click(b);
      await t.click(b);
      expect(t.posts()).toHaveLength(0);
      later(2000);
      await t.click(b);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ kind: 'agent', agentId: 'ag-1', baseUrl: 'https://camille.exemple.test', active: false });
    });

    it('[R153] un premier site se met en service, sans jamais passer pour le site du réseau', async () => {
      const t = await run();
      await t.ouvrir();
      t.input('Adresse du site', 2).value = ' https://ines.exemple.test ';
      const buttons = t.buttons('Mettre en service');
      await t.click(buttons[buttons.length - 1]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ kind: 'agent', agentId: 'ag-3', baseUrl: 'https://ines.exemple.test', active: true });
    });

    it('[R16] un agent parti ne déconnecte pas la direction', async () => {
      const t = await run({ 'POST /v1/attirer/sites': no(403, { ok: false, rule: 'R16', code: 'agent_parti' }) });
      await t.ouvrir();
      await t.click(t.buttons('Remettre en service')[0]);
      expect(t.state()).toBe('Cet agent n’est plus en activité : la liste a changé.');
      expect(t.storage.has('aimmo.cle')).toBe(true);
    });

    it('[R152] le titulaire se règle ; la carte manquante est dite', async () => {
      const t = await run();
      await t.ouvrir();
      t.input('Titulaire de la carte professionnelle').value = 'Société Neuve';
      await t.click(t.buttons('Enregistrer le titulaire')[0]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ holder: 'Société Neuve' });
      const u = await run({ 'GET /v1/attirer/agents': ok({ holder: null, cardNumber: null, agents: [] }) });
      await u.ouvrir();
      expect(u.texts()).toContain('Numéro de carte professionnelle du réseau : pas encore réglé.');
      expect(u.texts()).toContain('Aucun agent en activité.');
    });

    it('[R221] RS05 : les mentions du site se lisent et se règlent ; ce qui manque est dit ; seul ce qui change part', async () => {
      const t = await run({
        'GET /v1/attirer/mentions-site': ok({ values: { editeur_nom: 'Société Exemple' }, cardNumber: null, cardHolder: null, missing: ['Médiateur de la consommation et son site'] }),
        'POST /v1/attirer/mentions-site': ok(null),
      });
      await t.ouvrir();
      await t.click(t.buttons('Mentions légales du site')[0]);
      expect(t.texts()).toContain('le site reste en essai. Manquent : Médiateur de la consommation et son site.');
      expect(t.input('Dénomination de la société').value).toBe('Société Exemple');
      t.input('Médiateur de la consommation et son site').value = 'Médiateur Inventé';
      await t.click(t.buttons('Enregistrer les mentions')[0]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ mediateur: 'Médiateur Inventé' });
      const refused = await run({ 'GET /v1/attirer/mentions-site': no(403, { ok: false, rule: 'R16', code: 'role' }) });
      await refused.ouvrir();
      await refused.click(refused.buttons('Mentions légales du site')[0]);
      expect(refused.buttons('Enregistrer les mentions')).toHaveLength(0);
    });

    it('un double appui n’enregistre qu’une fois', async () => {
      const t = await run();
      await t.ouvrir();
      const b = t.buttons('Enregistrer le titulaire')[0]!;
      b.listeners.click!({});
      b.listeners.click!({});
      await settle();
      expect(t.posts()).toHaveLength(1);
    });
  });

  describe('AT15 · communes et quartiers', () => {
    const SQUARE = '47.0, 5.0\n47.0; 5.1\n47.1 5.1\n47.1,5.0';
    const POINTS = [[47, 5], [47, 5.1], [47.1, 5.1], [47.1, 5]];
    const remplir = (t: Awaited<ReturnType<typeof run>>, ring: string) => {
      t.input('Nom de la commune').value = 'Saint-Étienne d’Essai';
      t.input('Code INSEE').value = ' 99001 ';
      t.input('Contour : GeoJSON, ou une ligne « latitude, longitude » par point').value = ring;
      t.input('Source du contour').value = 'Contours inventés';
    };

    it('[R16] chaque appel existe sous la direction, sans identifiant à saisir', async () => {
      const t = await run();
      const before = t.calls.length;
      await t.ouvrir();
      expect(t.texts()).not.toContain('zc');
      remplir(t, SQUARE);
      await t.click(t.buttons('Ajouter')[0]);
      const routes = attirerRoutes();
      for (const c of t.calls.slice(before)) {
        const route = routes.find((r) => r.method === c.method && r.pattern.test(c.url.slice('/v1'.length)));
        expect(route, c.url).toBeDefined();
        expect(route!.roles).toEqual(['direction']);
      }
    });

    it('[R150] une commune : slug tiré du nom, lignes lues en latitude puis longitude', async () => {
      const t = await run();
      await t.ouvrir();
      remplir(t, SQUARE);
      await t.click(t.buttons('Ajouter')[0]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ level: 'commune', slug: 'saint-etienne-d-essai', name: 'Saint-Étienne d’Essai', ring: POINTS, ringSource: 'Contours inventés', inseeCode: '99001' });
      expect(t.state()).toBe('Commune ajoutée. Les prix suivront au prochain calcul.');
    });

    it('[R150] le GeoJSON est retourné en latitude puis longitude, et son dernier point répété retiré', async () => {
      const polygon = { type: 'Polygon', coordinates: [[[5, 47], [5.1, 47], [5.1, 47.1], [5, 47.1], [5, 47]]] };
      for (const pasted of [polygon, { type: 'Feature', properties: {}, geometry: polygon }]) {
        const t = await run();
        await t.ouvrir();
        remplir(t, JSON.stringify(pasted));
        await t.click(t.buttons('Ajouter')[0]);
        expect(JSON.parse(t.posts()[0]!.body!).ring).toEqual(POINTS);
      }
    });

    it('[R150] un contour illisible, ou en plusieurs morceaux, n’est jamais envoyé', async () => {
      const holed = JSON.stringify({ type: 'Polygon', coordinates: [[[5, 47], [5.1, 47], [5.1, 47.1]], [[5.01, 47.01], [5.02, 47.01], [5.02, 47.02]]] });
      for (const bad of ['', 'pas un contour', '47.0, 5.0\n47.1, 5.1', '{ pas du json', holed, '47, 5\n47, x\n48, 6']) {
        const t = await run();
        await t.ouvrir();
        remplir(t, bad);
        await t.click(t.buttons('Ajouter')[0]);
        expect(t.posts(), bad).toHaveLength(0);
        expect(t.state()).not.toBe('');
        expect(t.state()).not.toContain('ajoutée');
      }
    });

    it('[R150] chaque contour refusé dit la vraie raison', async () => {
      const square = [[5, 47], [5.1, 47], [5.1, 47.1], [5, 47]];
      const cases: [string, string][] = [
        ['pas un contour', 'Ce contour n’est pas lisible'],
        [JSON.stringify({ type: 'MultiPolygon', coordinates: [[square], [square]] }), 'Ce contour a 2 morceaux'],
        [JSON.stringify({ type: 'FeatureCollection', features: [{}, {}, {}] }), 'Ce contour a 3 morceaux'],
        [JSON.stringify({ type: 'Polygon', coordinates: [square, square] }), 'Ce contour contient une enclave'],
        ['5.0, 47.0\n5.1, 47.0\n5.1, 47.1', 'Ces points ne tombent pas en France'],
        ['6700000 850000\n6700100 850000\n6700100 850100', 'Ces points ne tombent pas en France'],
        [Array.from({ length: 2001 }, (_, i) => `47.${i} 5.${i}`).join('\n'), 'Ce contour a 2001 points'],
      ];
      for (const [bad, said] of cases) {
        const t = await run();
        await t.ouvrir();
        remplir(t, bad);
        await t.click(t.buttons('Ajouter')[0]);
        expect(t.posts(), bad).toHaveLength(0);
        expect(t.state()).toContain(said);
      }
    });

    it('[R150] un FeatureCollection à une feature et un MultiPolygon à une partie sont un seul morceau ; six décimales suffisent', async () => {
      const square = [[5.12345678, 47], [5.1, 47], [5.1, 47.1], [5, 47.1], [5.12345678, 47]];
      for (const pasted of [
        { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [square] } }] },
        { type: 'MultiPolygon', coordinates: [[square]] },
      ]) {
        const t = await run();
        await t.ouvrir();
        remplir(t, JSON.stringify(pasted));
        await t.click(t.buttons('Ajouter')[0]);
        expect(JSON.parse(t.posts()[0]!.body!).ring).toEqual([[47, 5.123457], [47, 5.1], [47.1, 5.1], [47.1, 5]]);
      }
    });

    it('[R150] l’adresse d’une zone ne perd aucune lettre', async () => {
      const t = await run();
      await t.ouvrir();
      remplir(t, SQUARE);
      t.input('Nom de la commune').value = 'Sacré-Cœur';
      await t.click(t.buttons('Ajouter')[0]);
      expect(JSON.parse(t.posts()[0]!.body!).slug).toBe('sacre-coeur');
    });

    it('un quartier se rattache à une commune choisie dans la liste, et n’envoie pas de code INSEE', async () => {
      const t = await run();
      await t.ouvrir();
      t.input('Nom du quartier').value = 'Nord';
      t.input('Contour : GeoJSON, ou une ligne « latitude, longitude » par point', 1).value = SQUARE;
      t.input('Source du contour', 1).value = 'Contours inventés';
      await t.click(t.buttons('Ajouter')[1]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ level: 'quartier', slug: 'nord', name: 'Nord', ring: POINTS, ringSource: 'Contours inventés', parentId: 'zc' });
      expect(t.state()).toBe('Quartier ajouté. Les prix suivront au prochain calcul.');
    });

    it('[R150] sans commune, seul l’ajout d’une commune est proposé, et l’écran dit ce qui manque', async () => {
      const t = await run({ 'GET /v1/attirer/prix/zones': ok([]) });
      await t.ouvrir();
      expect(t.texts()).toContain('Aucune commune : aucun prix ne peut être calculé.');
      expect(t.buttons('Ajouter')).toHaveLength(1);
    });

    it('[R150] un refus du serveur est dit en français, et la saisie reste', async () => {
      const t = await run({ 'POST /v1/attirer/prix/zones': no(409, { ok: false, rule: 'R150', code: 'chevauchement' }) });
      await t.ouvrir();
      remplir(t, SQUARE);
      await t.click(t.buttons('Ajouter')[0]);
      expect(t.state()).toBe('Ce contour recouvre une zone déjà en service : les mêmes ventes compteraient deux fois.');
      expect(t.input('Source du contour').value).toBe('Contours inventés');
    });

    it('[R150] AT19 : un contour qui se croise est dit en français, sans code, et la saisie reste', async () => {
      const t = await run({ 'POST /v1/attirer/prix/zones': no(409, { ok: false, rule: 'R150', code: 'contour_croise' }) });
      await t.ouvrir();
      remplir(t, SQUARE);
      await t.click(t.buttons('Ajouter')[0]);
      expect(t.state()).toBe('Ce contour se croise ou se touche lui-même : on ne saurait pas quelles ventes il contient. Vérifiez l’ordre des points.');
      expect(t.input('Source du contour').value).toBe('Contours inventés');
    });

    it('retirer une zone se confirme, et un double appui ne coupe rien', async () => {
      const t = await run();
      await t.ouvrir();
      const b = t.buttons('Retirer')[1]!;
      await t.click(b);
      await t.click(b);
      expect(t.posts()).toHaveLength(0);
      expect(t.state()).toBe('Ce quartier quittera le site : ses prix et sa page. Appuyez de nouveau pour confirmer.');
      later(2000);
      await t.click(b);
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/attirer/prix/zones/z1/retrait']);
      expect(t.state()).toBe('« Ouest » a quitté le site et les prochains calculs.');
    });

    it('un double appui sur Ajouter n’envoie qu’une zone', async () => {
      const t = await run();
      await t.ouvrir();
      remplir(t, SQUARE);
      const b = t.buttons('Ajouter')[0]!;
      b.listeners.click!({});
      b.listeners.click!({});
      await settle();
      expect(t.posts()).toHaveLength(1);
    });
  });

  describe('BR97 · zones à retracer', () => {
    const TODO = [
      { id: 'z1', level: 'quartier', parentId: 'zc', name: 'Ouest', reason: 'contour_croise' },
      { id: 'zx', level: 'commune', parentId: null, name: INJECTED, reason: 'contour_croise' },
    ];

    it('[R150] les zones à refaire sont dites en tête, avec leur niveau et le geste, puis marquées dans la liste', async () => {
      const t = await run({ 'GET /v1/attirer/prix/zones/a-refaire': ok(TODO) });
      await t.ouvrir();
      const texts = t.texts();
      expect(texts).toContain('2 zones mises de côté du dernier calcul : leur contour se touche lui-même, leurs prix ne sont pas publiés.');
      expect(texts).toContain('Ouest (quartier) : retirez-la, puis retracez-la.');
      expect(texts).toContain(`${INJECTED} (commune), avec ses quartiers : retirez-la, puis retracez-la.`);
      const marks = t.body().all().filter((e) => e.textContent === 'Contour à refaire : mise de côté du calcul. Retirez-la, puis retracez-la.');
      expect(marks).toHaveLength(1);
      // Le texte reçu n'est jamais lu comme du HTML, et aucun identifiant n'est montré.
      expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
      expect(texts).not.toMatch(/\bz1\b|\bzx\b|contour_croise/);
    });

    it('[R150] une seule zone se dit au singulier ; aucune : rien n’est ajouté', async () => {
      const one = await run({ 'GET /v1/attirer/prix/zones/a-refaire': ok([TODO[0]]) });
      await one.ouvrir();
      expect(one.texts()).toContain('1 zone mise de côté du dernier calcul : son contour se touche lui-même, ses prix ne sont pas publiés.');
      const none = await run();
      await none.ouvrir();
      expect(none.texts()).not.toMatch(/mise de côté|à refaire/);
    });

    it('[R10] une lecture en échec ne dit jamais « aucune » : elle dit que la liste n’est pas lue', async () => {
      for (const [answer, said] of [
        [no(403, { ok: false, rule: 'R16', code: 'role' }), 'Liste des zones à refaire non lue. Ce n’est pas dans vos droits.'],
        [no(500, { ok: false }), 'Liste des zones à refaire non lue. Indisponible pour le moment.'],
        [async () => Promise.reject(new TypeError('x')), 'Liste des zones à refaire non lue. Pas de réseau.'],
      ] as const) {
        const t = await run({ 'GET /v1/attirer/prix/zones/a-refaire': answer });
        await t.ouvrir();
        expect(t.texts()).toContain(said);
        // Le reste de l'écran des zones reste là.
        expect(t.buttons('Retirer').length).toBeGreaterThan(0);
      }
    });

    it('[R16] la lecture existe sous la direction seule', async () => {
      const t = await run();
      await t.ouvrir();
      const call = t.calls.find((c) => c.url === '/v1/attirer/prix/zones/a-refaire');
      expect(call?.method).toBe('GET');
      const route = attirerRoutes().find((r) => r.method === 'GET' && r.pattern.test('/attirer/prix/zones/a-refaire'));
      expect(route!.roles).toEqual(['direction']);
    });

    it('[R201] le script de l’écran tient le budget d’une page, sans innerHTML', () => {
      expect(budgetProblems({ html: '', js: ATTIRER_SCRIPT }, BUDGETS.page)).toEqual([]);
      expect(ATTIRER_SCRIPT).not.toContain('innerHTML');
    });
  });

  describe('AT13 · pages de quartier', () => {
    const quartier = async (answers: Record<string, Answer> = {}) => {
      const t = await run(answers);
      await t.ouvrir();
      await t.click(t.buttons('Ouvrir')[0]);
      return t;
    };

    it('[R16] le quartier se choisit dans la liste, sans identifiant, et chaque appel existe sous la direction', async () => {
      const t = await run();
      const before = t.calls.length;
      await t.ouvrir();
      expect(t.texts()).toContain('Ouest');
      expect(t.texts()).not.toContain('z1');
      await t.click(t.buttons('Ouvrir')[0]);
      expect(t.texts()).not.toContain('z1');
      await t.click(t.buttons('Préparer le texte')[0]);
      const routes = attirerRoutes();
      for (const c of t.calls.slice(before)) {
        const route = routes.find((r) => r.method === c.method && r.pattern.test(c.url.slice('/v1'.length)));
        expect(route, c.url).toBeDefined();
        expect(route!.roles).toEqual(['direction']);
      }
    });

    it('[R155] seul un texte non validé qui passe le contrôle se valide ; le texte montré est le texte reçu, entier', async () => {
      const t = await quartier();
      expect(t.buttons('Je l’ai relu : valider')).toHaveLength(1);
      const paragraphs = t.body().all().filter((e) => e.tagName === 'p').map((e) => e.textContent);
      expect(paragraphs).toContain('Deux arrêts de tram.');
      expect(paragraphs).not.toContain('Deux arrêts');
      expect(paragraphs).toContain(`Une phrase ${INJECTED}.`);
      await t.click(t.buttons('Je l’ai relu : valider')[0]);
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/attirer/quartiers/textes/d2/valider']);
      expect(t.state()).toBe('Texte validé : le site du réseau peut le servir.');
    });

    const pending = (over: Record<string, unknown>) => ({ draftId: 'd5', zoneSlug: 'ouest', kind: 'page', topic: 'quartier', title: 'Titre', body: 'Corps.', paragraphs: ['Corps.'], current: true, origin: 'secours', trace: { ok: true, sentences: [] }, validatedBy: null, validatedAt: null, ...over });

    it('[R155] un texte non validé qui ne passe plus le contrôle n’a pas de bouton, et le dit', async () => {
      const t = await quartier({ 'GET /v1/attirer/quartiers/z1/textes': ok([pending({ trace: { ok: false, sentences: [] } })]) });
      expect(t.buttons('Je l’ai relu : valider')).toHaveLength(0);
      expect(t.texts()).toContain('Ce texte ne passe plus le contrôle sur les données du jour : préparez-en un nouveau.');
    });

    it('[R155] un texte dont les données ont changé n’a pas de bouton, et le dit', async () => {
      const t = await quartier({ 'GET /v1/attirer/quartiers/z1/textes': ok([pending({ current: false })]) });
      expect(t.buttons('Je l’ai relu : valider')).toHaveLength(0);
      expect(t.texts()).toContain('Les données ont changé depuis ce texte : préparez-en un nouveau.');
    });

    it('[R155] une validation refusée pour un écran dépassé relit le quartier, et dit pourquoi', async () => {
      const t = await quartier({
        'GET /v1/attirer/quartiers/z1/textes': ok([pending({ draftId: 'd2' })]),
        'POST /v1/attirer/quartiers/textes/d2/valider': no(409, { ok: false, rule: 'R155', code: 'donnees_changees' }),
      });
      const before = t.calls.length;
      await t.click(t.buttons('Je l’ai relu : valider')[0]);
      expect(t.calls.slice(before).filter((c) => c.method === 'GET').map((c) => c.url)).toContain('/v1/attirer/quartiers/z1/textes');
      expect(t.state()).toBe('Les données ont changé depuis ce texte : préparez-en un nouveau.');
    });

    it('un double appui sur valider ne part qu’une fois', async () => {
      const t = await quartier();
      const b = t.buttons('Je l’ai relu : valider')[0]!;
      b.listeners.click!({});
      b.listeners.click!({});
      await settle();
      expect(t.posts()).toHaveLength(1);
    });

    it('deux libellés qui se confondent ne se remplacent pas ; le même libellé, si', async () => {
      const fact = (label: string) => ({ key: 'marche', kind: 'marche', label, value: null, unit: null, source: 'Mairie inventée', sourceDate: '2026-01-15' });
      const t = await quartier({ 'GET /v1/attirer/quartiers/z1/faits': ok([fact('Marché')]) });
      t.input('Libellé').value = 'Marche';
      t.input('Source').value = 'Club inventé';
      t.input('Date de la source').value = '2026-03-01';
      await t.click(t.buttons('Ranger ce fait')[0]);
      expect(t.posts()).toHaveLength(0);
      expect(t.state()).toBe('Ce libellé se confond avec « Marché » : changez-le, ou retirez d’abord ce fait.');
      t.input('Libellé').value = ' Marché ';
      await t.click(t.buttons('Ranger ce fait')[0]);
      expect(t.posts()).toHaveLength(1);
    });

    it('un long libellé coupé à sa clé ne remplace pas un autre au même début', async () => {
      const start = 'a'.repeat(60);
      const t = await quartier({ 'GET /v1/attirer/quartiers/z1/faits': ok([{ key: start, kind: 'autre', label: `${start} un`, value: null, unit: null, source: 'Source', sourceDate: '2026-01-15' }]) });
      t.input('Libellé').value = `${start} deux`;
      await t.click(t.buttons('Ranger ce fait')[0]);
      expect(t.posts()).toHaveLength(0);
    });

    it('quitter un quartier en cours de lecture : la réponse tardive n’est jamais montrée', async () => {
      const d = deferred([]);
      const t = await run({ 'GET /v1/attirer/quartiers/z1/textes': d.answer });
      await t.ouvrir();
      await t.click(t.buttons('Ouvrir')[0]);
      await t.click(t.els['attirer-retour']);
      await t.click(t.els['attirer-retour']);
      d.release();
      await settle();
      expect(t.body().children.length).toBe(0);
      expect(t.els.attirer!.hidden).toBe(true);
    });

    it('un envoi revenu après la sortie ne rouvre rien', async () => {
      const d = deferred({});
      const t = await quartier({ 'POST /v1/attirer/quartiers/textes/d2/valider': d.answer });
      await t.click(t.buttons('Je l’ai relu : valider')[0]);
      await t.click(t.els['attirer-retour']);
      await t.click(t.els['attirer-retour']);
      d.release();
      await settle();
      expect(t.els.attirer!.hidden).toBe(true);
      expect(t.body().children.length).toBe(0);
    });

    it('[R155] chaque phrase montre sa source ; un texte validé qui ne passe plus le contrôle le dit', async () => {
      const t = await quartier();
      expect(t.texts()).toContain('Source : Carte inventée, ');
      expect(t.texts()).toContain('il ne passe plus le contrôle sur les données du jour et n’est plus servi.');
      expect(t.texts()).toContain('« charmant » : jugement de valeur');
    });

    it('[R155] un texte refusé nomme les passages en cause, en français', async () => {
      const t = await quartier({ 'POST /v1/attirer/quartiers/z1/texte': no(409, { ok: false, rule: 'R155', code: 'texte_refuse', problems: [{ code: 'nombre_sans_source', value: '42' }] }) });
      t.input('Texte').value = 'Il y a 42 parcs.';
      await t.click(t.buttons('Enregistrer la correction')[0]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ kind: 'page', topic: 'quartier', title: 'Le quartier Ouest', body: 'Il y a 42 parcs.' });
      expect(t.state()).toBe('Ce texte ne passe pas le contrôle : rien n’est enregistré. « 42 » : chiffre sans source.');
    });

    it('[R155] préparer sans donnée le dit, et les couples demandés sont ceux que le métier admet', async () => {
      const t = await quartier({ 'POST /v1/attirer/quartiers/z1/brouillon': no(409, { ok: false, rule: 'R155', code: 'sans_donnees' }) });
      t.input('À préparer').value = 'article/equipements';
      await t.click(t.buttons('Préparer le texte')[0]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ kind: 'article', topic: 'equipements' });
      expect(t.state()).toBe('Aucune donnée pour ce sujet : ni fait rangé pour le quartier, ni prix publié pour un article sur les prix.');
    });

    it('un fait se range avec une clé tirée du libellé ; chiffre et unité vont ensemble', async () => {
      const t = await quartier();
      t.input('Libellé').value = ' Écoles élémentaires ';
      t.input('Valeur, si le fait est un chiffre').value = '1,5';
      t.input('Source').value = 'Annuaire inventé';
      t.input('Date de la source').value = '2026-03-01';
      await t.click(t.buttons('Ranger ce fait')[0]);
      expect(t.state()).toBe('Un chiffre va avec son unité, et une unité avec son chiffre.');
      expect(t.posts()).toHaveLength(0);
      t.input('Unité').value = 'km';
      t.input('Sorte').value = 'ecole';
      await t.click(t.buttons('Ranger ce fait')[0]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ key: 'ecoles-elementaires', kind: 'ecole', label: ' Écoles élémentaires ', value: 1.5, unit: 'km', source: 'Annuaire inventé', sourceDate: '2026-03-01' });
      expect(t.state()).toBe('Fait rangé.');
    });

    it('retirer un fait se confirme, et ne renvoie que sa clé', async () => {
      const t = await quartier();
      const b = t.buttons('Retirer ce fait')[0]!;
      await t.click(b);
      expect(t.state()).toBe('Un texte qui le cite ne sera plus servi. Appuyez de nouveau pour confirmer.');
      expect(t.posts()).toHaveLength(0);
      later(2000);
      await t.click(b);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ key: 'tram', retired: true });
    });

    it('le retour mène du quartier à Attirer, puis au réseau, et efface le quartier', async () => {
      const t = await quartier();
      await t.click(t.els['attirer-retour']);
      expect(t.texts()).not.toContain('Arrêts de tram');
      expect(t.els.attirer!.hidden).toBe(false);
      expect(t.buttons('Recalculer les prix')).toHaveLength(1);
      await t.click(t.els['attirer-retour']);
      expect(t.els.attirer!.hidden).toBe(true);
      expect(t.body().children.length).toBe(0);
    });
  });

  it('[R201] l’écran est servi à part, jamais gardé sur l’appareil, et tient le budget d’une page', async () => {
    expect(AGENT_APP_FILES['/app/attirer.js']).toBe(ATTIRER_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/attirer.js');
    const res = handleAgentApp(new Request('https://x.test/app/attirer.js'));
    expect(res?.status).toBe(200);
    expect(budgetProblems({ html: '', js: ATTIRER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(JS).not.toContain('AIMMO_ATTIRER = function');
  });
});
