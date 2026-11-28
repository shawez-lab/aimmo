import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFORMITE_HTML, CONFORMITE_RUBRIQUES, CONFORMITE_SCRIPT } from '../app/conformite.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : fiches, demandes, fuites, dates, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOW = '2026-11-02T09:00:00.000Z';
const request = (over: Record<string, unknown> = {}) => ({ id: 'd1', personId: 'personne-test-g7h8i9', kind: 'acces', channel: 'mail', receivedOn: '2026-10-20', dueOn: '2026-11-20', noticeOn: '2026-11-13', exclusionId: null, answeredOn: null, answerSha256: null, late: null, ...over });
const breach = (over: Record<string, unknown> = {}) => ({ id: 'b1', awareAt: '2026-11-01T06:00:00.000Z', deadlineAt: '2026-11-04T06:00:00.000Z', evaluation: null, due: { cnil: true, personnes: false }, notified: { cnil: null, personnes: null }, cuts: [], ...over });
const REGISTER = { lastReviewOn: '2026-10-28', initial: true, dueOn: '2027-01-28', noticeOn: '2027-01-13', registryHash: 'r'.repeat(64), changedSinceReview: false };
const CALM: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'compliance', firstName: null }),
  'GET /v1/conformite/risque': ok([]),
  'GET /v1/conformite/vigilance': ok([]),
  'GET /v1/commerces/vigilance': ok([]),
  'GET /v1/conformite/signalements': ok([]),
  'GET /v1/conformite/demandes': ok([]),
  'GET /v1/conformite/demandes/alertes': ok([]),
  'GET /v1/conformite/prospects': ok([]),
  'GET /v1/conformite/fuites': ok([]),
  'GET /v1/conformite/fuites/alertes': ok([]),
  'GET /v1/conformite/registre': ok(REGISTER),
  'GET /v1/conformite/registre/alertes': ok([]),
};
const IDS = CONFORMITE_RUBRIQUES.map(([id]) => id);
const HOSTS = CONFORMITE_RUBRIQUES.map(([, , host]) => host);

/** L'écran du responsable, son script arrivé, à une heure fixée : aucune échéance ne dépend du jour de l'essai. */
async function run(answers: Record<string, Answer> = CALM, now = NOW) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: string[] = [];
  const table: Record<string, Answer> = { ...answers };
  const at = Date.parse(now);
  class Clock extends Date {
    constructor(...a: unknown[]) {
      super(...((a.length ? a : [at]) as [number]));
    }
    static override now(): number {
      return at;
    }
  }
  const context: Record<string, unknown> = {
    Date: Clock,
    Blob,
    setTimeout,
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url}`);
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const script = () => els.conformite!.children.find((e) => e.tagName === 'script' && e.attributes.src === '/app/conformite.js')!;
  const arrive = async () => {
    runInNewContext(CONFORMITE_SCRIPT, context);
    script().listeners.load!({});
    await settle();
  };
  const open = async (id: string) => {
    els[`conformite-r-${id}`]!.listeners.click!({});
    await settle();
  };
  const shown = () => IDS.filter((_, i) => !els[HOSTS[i]!]!.hidden);
  const pressed = () => IDS.filter((id) => els[`conformite-r-${id}`]!.attributes['aria-pressed'] === 'true');
  const titles = (host: string) => els[host]!.children.filter((e) => e.tagName === 'section').map((e) => e.children[0]!.textContent);
  const deadline = () => els['conformite-echeance']!.textContent;
  const buttons = (host: string) => els[host]!.all().filter((e) => e.tagName === 'button');
  return { els, calls, table, storage, script, arrive, open, shown, pressed, titles, deadline, buttons };
}

describe('DS009 · « Conformité » en trois rubriques', () => {
  it('trois rubriques ; dans la page, la rangée est cachée et les modèles restent à portée tant que le script n’est pas là', async () => {
    expect(CONFORMITE_RUBRIQUES.map(([, name]) => name)).toEqual(['À décider', 'Registres', 'Modèles']);
    expect(CONFORMITE_HTML).toContain('<div id="conformite-rubriques" class="rubriques" role="group" aria-label="Rubrique" hidden>');
    expect([...CONFORMITE_HTML.matchAll(/<button id="conformite-r-([a-z]+)" type="button" class="secondaire" aria-pressed="(true|false)">([^<]+)<\/button>/g)].map((m) => [m[1], m[2], m[3]])).toEqual(
      CONFORMITE_RUBRIQUES.map(([id, name], i) => [id, String(i === 0), name]),
    );
    // Aucune des trois parts n'est cachée dans la page : sans le script du responsable, rien ne disparaît.
    for (const host of HOSTS) expect(CONFORMITE_HTML).toContain(`<div id="${host}">`);
    const models = CONFORMITE_HTML.slice(CONFORMITE_HTML.indexOf('<div id="conformite-modeles">'));
    expect([...models.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1])).toEqual(['Modèles et clauses du mandat', 'Modèles de bail', 'Clés de mes appareils']);
    // Les clés de l'appareil sont le compte, pas une rubrique : hors des trois parts, toujours visibles.
    expect(models.indexOf('</div>')).toBeLessThan(models.indexOf('Clés de mes appareils'));
    // Le script n'arrive pas : la rangée reste cachée, aucune part n'est fermée par lui.
    const t = await run();
    t.script().listeners.error!({});
    await settle();
    expect(t.els['conformite-etat']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.els['conformite-rubriques']!.attributes.hidden === undefined && t.els['conformite-rubriques']!.hidden).toBe(true);
  });

  it('à l’arrivée, « À décider » seule se voit ; les registres ont leur rubrique ; un geste en change', async () => {
    const t = await run();
    await t.arrive();
    expect(t.els['conformite-rubriques']!.hidden).toBe(false);
    expect(t.shown()).toEqual(['decider']);
    expect(t.pressed()).toEqual(['decider']);
    expect(t.titles('conformite-corps')).toEqual(['Alertes', 'Fiches de risque à valider', 'Vigilance renforcée', 'Vigilance des cessions de fonds', 'Signalements', 'Demandes des personnes', 'Prospects arrivés à 3 ans', 'Fuites et coupures']);
    expect(t.titles('conformite-registres')).toEqual(['Registre des traitements', 'Registre des gels', 'Dossier anti-blanchiment de l’agence']);
    const before = t.calls.length;
    for (const id of ['registres', 'modeles', 'decider']) {
      await t.open(id);
      expect(t.shown()).toEqual([id]);
      expect(t.pressed()).toEqual([id]);
    }
    // Changer de rubrique ne relit rien.
    expect(t.calls.length).toBe(before);
  });

  it('actualiser ou décider garde la rubrique ouverte ; sortir efface tout ; une nouvelle entrée rouvre « À décider »', async () => {
    const t = await run({ ...CALM, 'POST /v1/conformite/registre/relecture': ok({}) });
    await t.arrive();
    await t.open('registres');
    t.els['conformite-actualiser']!.listeners.click!({});
    await settle();
    expect(t.shown()).toEqual(['registres']);
    // Un geste de l'écran relit tout, et laisse le responsable où il était.
    t.buttons('conformite-registres').find((b) => b.textContent === 'Noter la relecture')!.listeners.click!({});
    await settle();
    expect(t.calls.filter((c) => c === 'POST /v1/conformite/registre/relecture')).toHaveLength(1);
    expect(t.shown()).toEqual(['registres']);
    expect(t.titles('conformite-registres')).toHaveLength(3);
    // La sortie efface les trois parts dessinées et la phrase de l'échéance.
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.els['conformite-registres']!.children).toEqual([]);
    expect(t.els['conformite-corps']!.children).toEqual([]);
    expect(t.deadline()).toBe('');
    t.els.cle!.value = KEY;
    t.els['form-connexion']!.listeners.submit!({ preventDefault: () => undefined });
    await settle();
    expect(t.els.conformite!.hidden).toBe(false);
    expect(t.shown()).toEqual(['decider']);
  });

  it('Jamais vu · une phrase dit l’échéance légale qui tombe la première, tous registres confondus', async () => {
    // Rien d'autre en cours : la relecture du registre est la première.
    const calm = await run();
    await calm.arrive();
    expect(calm.deadline()).toBe('Première échéance : relire le registre des traitements avant le 28/01/2027.');
    // Une demande d'une personne tombe avant le registre ; une fuite, avec ses 72 heures, avant la demande.
    const asked = await run({ ...CALM, 'GET /v1/conformite/demandes': ok([request({ id: 'd0', dueOn: '2026-12-15' }), request()]) });
    await asked.arrive();
    expect(asked.deadline()).toBe('Première échéance : répondre à une demande d’une personne avant le 20/11/2026.');
    const leaked = await run({ ...CALM, 'GET /v1/conformite/demandes': ok([request()]), 'GET /v1/conformite/fuites': ok([breach()]) });
    await leaked.arrive();
    expect(leaked.deadline()).toMatch(/^Première échéance : prévenir la CNIL d’une fuite avant le 04\/11\/2026 à \d\d:\d\d\.$/);
    // Ce qui est fait ne compte plus : une demande répondue, une fuite déjà notifiée ou sans notification due.
    const done = await run({
      ...CALM,
      'GET /v1/conformite/demandes': ok([request({ answeredOn: '2026-10-30', late: false })]),
      'GET /v1/conformite/fuites': ok([breach({ notified: { cnil: { at: '2026-11-01T10:00:00.000Z', late: false }, personnes: null } }), breach({ id: 'b2', due: { cnil: false, personnes: false } })]),
    });
    await done.arrive();
    expect(done.deadline()).toBe('Première échéance : relire le registre des traitements avant le 28/01/2027.');
    // La phrase reste sous le titre, quelle que soit la rubrique ouverte.
    await leaked.open('modeles');
    expect(leaked.deadline()).toContain('prévenir la CNIL');
  });

  it('un jour du calendrier finit à Paris, quel que soit le fuseau de l’appareil : l’ordre des échéances et « passée » en dépendent', async () => {
    // L'essai tranche sur toute machine qui n'est pas à l'heure de Paris ; celle de « Vérifier » est en temps universel.
    const asked = { 'GET /v1/conformite/demandes': ok([request()]) };
    const leak = (deadlineAt: string) => ({ 'GET /v1/conformite/fuites': ok([breach({ deadlineAt })]) });
    // En hiver, le 20 novembre finit à 22:59:59 en temps universel : une échéance de la CNIL à 23:30 vient après la demande…
    const winter = await run({ ...CALM, ...asked, ...leak('2026-11-20T23:30:00.000Z') });
    await winter.arrive();
    expect(winter.deadline()).toBe('Première échéance : répondre à une demande d’une personne avant le 20/11/2026.');
    // … et à 22:30, avant.
    const earlier = await run({ ...CALM, ...asked, ...leak('2026-11-20T22:30:00.000Z') });
    await earlier.arrive();
    expect(earlier.deadline()).toContain('Première échéance : prévenir la CNIL d’une fuite avant le 20/11/2026');
    // En été, le jour finit à 21:59:59 en temps universel.
    const summer = { ...CALM, 'GET /v1/conformite/demandes': ok([request({ dueOn: '2027-07-10' })]), 'GET /v1/conformite/registre': ok({ ...REGISTER, dueOn: '2027-10-28' }) };
    const july = await run({ ...summer, ...leak('2027-07-10T22:30:00.000Z') }, '2027-07-01T09:00:00.000Z');
    await july.arrive();
    expect(july.deadline()).toBe('Première échéance : répondre à une demande d’une personne avant le 10/07/2027.');
    const julyEarlier = await run({ ...summer, ...leak('2027-07-10T21:30:00.000Z') }, '2027-07-01T09:00:00.000Z');
    await julyEarlier.arrive();
    expect(julyEarlier.deadline()).toContain('Première échéance : prévenir la CNIL d’une fuite avant le 10/07/2027');
    // Passée dès minuit à Paris : à 23:10 en temps universel le 20 novembre, il est 0 h 10 le 21 ; à 22:50, pas encore.
    const past = await run({ ...CALM, ...asked }, '2026-11-20T23:10:00.000Z');
    await past.arrive();
    expect(past.deadline()).toBe('Échéance passée : répondre à une demande d’une personne avant le 20/11/2026.');
    const notYet = await run({ ...CALM, ...asked }, '2026-11-20T22:50:00.000Z');
    await notYet.arrive();
    expect(notYet.deadline()).toBe('Première échéance : répondre à une demande d’une personne avant le 20/11/2026.');
    // La relecture du registre se compte de la même façon.
    const registry = await run({ ...CALM, 'GET /v1/conformite/registre': ok({ ...REGISTER, dueOn: '2026-11-20' }) }, '2026-11-20T23:10:00.000Z');
    await registry.arrive();
    expect(registry.deadline()).toBe('Échéance passée : relire le registre des traitements avant le 20/11/2026.');
    // Un jour illisible ne compte pas, et ne casse rien : l'échéance suivante est dite.
    const odd = await run({ ...CALM, 'GET /v1/conformite/demandes': ok([request({ dueOn: 'bientôt' })]) });
    await odd.arrive();
    expect(odd.deadline()).toBe('Première échéance : relire le registre des traitements avant le 28/01/2027.');
  });

  it('Jamais vu · une échéance passée se dit passée ; une lecture manquée, et la phrase dit qu’elle n’est pas sûre', async () => {
    const late = await run({ ...CALM, 'GET /v1/conformite/demandes': ok([request()]) }, '2026-12-01T09:00:00.000Z');
    await late.arrive();
    expect(late.deadline()).toBe('Échéance passée : répondre à une demande d’une personne avant le 20/11/2026.');
    // Les demandes n'ont pas pu être lues : la relecture du registre n'est peut-être pas la première.
    for (const route of ['GET /v1/conformite/demandes', 'GET /v1/conformite/fuites']) {
      const partial = { ...CALM };
      delete partial[route];
      const t = await run(partial);
      await t.arrive();
      expect(t.deadline(), route).toBe('Échéance connue : relire le registre des traitements avant le 28/01/2027. Une partie n’a pas pu être lue : une échéance plus proche est possible.');
    }
    // Le registre non lu, rien d'autre en cours : aucune échéance n'est donnée pour première.
    const blind = { ...CALM };
    delete blind['GET /v1/conformite/registre'];
    const t = await run(blind);
    await t.arrive();
    expect(t.deadline()).toBe('Une partie n’a pas pu être lue : une échéance plus proche est possible.');
  });

  it('les formulaires s’ouvrent au geste ; ouvrir, rejouer et déclarer sont filaires ; rien à décider, aucun bouton plein hors d’un formulaire', async () => {
    const t = await run();
    await t.arrive();
    const folded = (host: string) => t.els[host]!.all().filter((e) => e.tagName === 'details').map((d) => [d.children[0]!.tagName, d.children[0]!.textContent]);
    expect(folded('conformite-corps')).toEqual([['summary', 'Enregistrer une demande reçue']]);
    expect(folded('conformite-registres')).toEqual([['summary', 'Noter une relecture']]);
    const inForm = (b: FakeElement) => [...t.els['conformite-corps']!.all(), ...t.els['conformite-registres']!.all()].some((d) => d.tagName === 'details' && d.all().includes(b));
    const filled = [...t.buttons('conformite-corps'), ...t.buttons('conformite-registres')].filter((b) => !/(^| )(secondaire|second|retour|discret)( |$)/.test(b.className));
    expect(filled.filter((b) => !inForm(b)).map((b) => b.textContent)).toEqual([]);
    expect(filled.map((b) => b.textContent)).toEqual(['Enregistrer la demande', 'Noter la relecture']);
    for (const text of ['Déclarer une fuite connue maintenant', 'Ouvrir l’import du registre', 'Ouvrir le dossier anti-blanchiment']) {
      expect([...t.buttons('conformite-corps'), ...t.buttons('conformite-registres')].find((b) => b.textContent === text)!.className, text).toBe('secondaire');
    }
  });

  it('une fuite à évaluer montre son formulaire ; évaluée, il se rouvre au geste', async () => {
    const fresh = await run({ ...CALM, 'GET /v1/conformite/fuites': ok([breach()]) });
    await fresh.arrive();
    const form = (t: Awaited<ReturnType<typeof run>>) => t.els['conformite-corps']!.all().find((e) => e.tagName === 'details' && /fuite|évaluation/.test(e.children[0]!.textContent))! as FakeElement & { open?: boolean };
    expect(form(fresh).children[0]!.textContent).toBe('Évaluer la fuite');
    expect(form(fresh).open).toBe(true);
    const filed = await run({ ...CALM, 'GET /v1/conformite/fuites': ok([breach({ evaluation: { risk: 'eleve' } })]) });
    await filed.arrive();
    expect(form(filed).children[0]!.textContent).toBe('Revoir l’évaluation');
    expect(form(filed).open).toBe(false);
  });

  it('DS022 · une fuite a un pas à la fois : l’évaluer, puis prévenir la CNIL ; couper reste l’urgence, en rouge, tant que tout n’est pas coupé', async () => {
    type T = Awaited<ReturnType<typeof run>>;
    const item = (t: T) => t.els['conformite-corps']!.all().find((e) => e.tagName === 'li' && /Fuite connue/.test(e.textContent))!;
    const looks = (t: T) => Object.fromEntries(item(t).all().filter((e) => e.tagName === 'button').map((b) => [b.textContent, b.className || 'plein']));
    // À évaluer : l'évaluation est le pas ; prévenir la CNIL reste possible, filaire.
    const fresh = await run({ ...CALM, 'GET /v1/conformite/fuites': ok([breach()]) });
    await fresh.arrive();
    expect(looks(fresh)).toEqual({ 'Couper tous les accès maintenant': 'danger', 'Ranger l’évaluation (tout le réseau)': 'plein', 'Noter la CNIL prévenue maintenant': 'secondaire' });
    // Évaluée, la CNIL à prévenir : c'est le pas ; l'évaluation se revoit dans son volet fermé.
    const filed = await run({ ...CALM, 'GET /v1/conformite/fuites': ok([breach({ evaluation: { risk: 'eleve' } })]) });
    await filed.arrive();
    expect(looks(filed)['Noter la CNIL prévenue maintenant']).toBe('plein');
    expect(looks(filed)['Couper tous les accès maintenant']).toBe('danger');
    // Tout est coupé : couper n'est plus l'urgence ; rétablir un accès n'est jamais le pas à faire.
    const cut = await run({ ...CALM, 'GET /v1/conformite/fuites': ok([breach({ evaluation: { risk: 'eleve' }, cuts: [{ id: 'c1', scope: 'tous', cutAt: '2026-11-01T07:00:00.000Z', restoredAt: null }] })]) });
    await cut.arrive();
    expect(looks(cut)).toMatchObject({ 'Couper tous les accès maintenant': 'secondaire', 'Rétablir cet accès': 'secondaire', 'Noter la CNIL prévenue maintenant': 'plein' });
    // Un seul accès coupé, ou tout rétabli : couper tout reste l'urgence.
    const part = await run({ ...CALM, 'GET /v1/conformite/fuites': ok([breach({ cuts: [{ id: 'c1', scope: 'un', cutAt: '2026-11-01T07:00:00.000Z', restoredAt: null }, { id: 'c2', scope: 'tous', cutAt: '2026-11-01T07:00:00.000Z', restoredAt: '2026-11-01T09:00:00.000Z' }] })]) });
    await part.arrive();
    expect(looks(part)['Couper tous les accès maintenant']).toBe('danger');
    // CNIL prévenue : plus rien de plein hors du volet de l'évaluation.
    const told = await run({ ...CALM, 'GET /v1/conformite/fuites': ok([breach({ evaluation: { risk: 'eleve' }, notified: { cnil: { at: '2026-11-01T10:00:00.000Z', late: false }, personnes: null }, cuts: [{ id: 'c1', scope: 'tous', cutAt: '2026-11-01T07:00:00.000Z', restoredAt: null }] })]) });
    await told.arrive();
    expect(Object.entries(looks(told)).filter(([, look]) => look !== 'secondaire').map(([name]) => name)).toEqual(['Ranger l’évaluation (tout le réseau)']);
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

describe('DS009 · dans Chromium', () => {
  it.skipIf(navigateur === null)('sur un téléphone, une seule rubrique se voit, sans déborder ; rien à décider, aucun bouton plein ; un formulaire s’ouvre au geste', async () => {
    const answers: Record<string, Answer> = Object.fromEntries(Object.entries(CALM).map(([route, a]) => [route.replace(/^GET /, ''), a]));
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
      await page.waitForSelector('#conformite-rubriques:not([hidden])');
      const measure = () =>
        page.evaluate(() => {
          const d = (globalThis as any).document;
          const seen = (e: any) => e.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true });
          const tabs = [...d.querySelectorAll('#conformite .rubriques button')].map((b: any) => b.getBoundingClientRect());
          return {
            screens: d.documentElement.scrollHeight / (globalThis as any).innerHeight,
            overflow: d.documentElement.scrollWidth > (globalThis as any).innerWidth,
            rows: new Set(tabs.map((r: any) => Math.round(r.top))).size,
            heights: tabs.map((r: any) => Math.round(r.height)),
            headings: [...d.querySelectorAll('#conformite h3')].filter(seen).map((h: any) => h.textContent),
            filled: [...d.querySelectorAll('#conformite button')].filter((b: any) => seen(b) && !/(^| )(secondaire|second|retour|discret)( |$)/.test(b.className)).map((b: any) => b.textContent),
          };
        });
      // L'audit comptait 6,3 écrans, 13 blocs et 7 boutons pleins d'un seul tenant.
      const decider = await measure();
      expect(decider.rows).toBe(1);
      for (const h of decider.heights) expect(h).toBeGreaterThanOrEqual(44);
      expect(decider.overflow).toBe(false);
      expect(decider.screens).toBeLessThanOrEqual(3);
      expect(decider.filled).toEqual([]);
      expect(decider.headings).toEqual(['Alertes', 'Fiches de risque à valider', 'Vigilance renforcée', 'Vigilance des cessions de fonds', 'Signalements', 'Demandes des personnes', 'Prospects arrivés à 3 ans', 'Fuites et coupures', 'Clés de mes appareils']);
      await page.click('#conformite-r-registres');
      const registres = await measure();
      expect(registres.headings).toEqual(['Registre des traitements', 'Registre des gels', 'Dossier anti-blanchiment de l’agence', 'Clés de mes appareils']);
      expect(registres.screens).toBeLessThanOrEqual(2.5);
      expect(registres.filled).toEqual([]);
      expect(registres.overflow).toBe(false);
      // Le formulaire s'ouvre au geste : son bouton est alors le pas à faire.
      expect(await page.isVisible('#conformite-registres label:has-text("Votre nom")')).toBe(false);
      await page.click('#conformite-registres summary:has-text("Noter une relecture")');
      expect(await page.isVisible('#conformite-registres label:has-text("Votre nom")')).toBe(true);
      expect((await measure()).filled).toEqual(['Noter la relecture']);
      await page.click('#conformite-r-modeles');
      const modeles = await measure();
      expect(modeles.headings).toEqual(['Modèles et clauses du mandat', 'Modèles de bail', 'Clés de mes appareils']);
      expect(modeles.screens).toBeLessThanOrEqual(2);
      expect(await page.getAttribute('#conformite-r-modeles', 'aria-pressed')).toBe('true');
      expect(await page.getAttribute('#conformite-r-decider', 'aria-pressed')).toBe('false');
    } finally {
      await page.close();
    }
  });
});
