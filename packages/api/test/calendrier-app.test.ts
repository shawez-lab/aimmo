import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { SOCIAL_CHANNELS } from '../../core/src/studio/publications.ts';
import { CALENDRIER_CHANNELS, CALENDRIER_LOST, CALENDRIER_NO_PROPERTY, CALENDRIER_OUTCOMES, CALENDRIER_REASONS, CALENDRIER_REFUSALS, CALENDRIER_SCRIPT } from '../app/calendrier.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : réglages, créneaux, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

// Dimanche 10 octobre 2027 à 22 h 30 UTC : lundi 11 octobre à 0 h 30 à Paris. Le jour de l'écran est celui de Paris.
const NOW = Date.UTC(2027, 9, 10, 22, 30);
const C = '/v1/marketing/calendrier';
const SLOTS_URL = `${C}/creneaux?du=2027-10-11&au=2027-10-24`;
const zero = Object.fromEntries(SOCIAL_CHANNELS.map((c) => [c, 0]));
const TODAY_RULES = { version: 1, perDay: { ...zero, instagram: 2, facebook: 1 }, hours: ['09:00', '18:30'], effectiveDay: '2027-10-01' };
const NEXT_RULES = { version: 2, perDay: { ...zero, linkedin: 1 }, hours: ['12:00'], effectiveDay: '2027-10-12' };
// Dans l'ordre reçu, volontairement pas celui des heures : l'écran ne trie rien.
const SLOTS = [
  { id: 's2', day: '2027-10-12', channel: 'facebook', rank: 0, dueAt: '2027-10-12T07:00:00.000Z', postId: 'p2', propertyId: 'b2', propertyReference: 'AIM-0002', outcome: null, reason: null },
  { id: 's1', day: '2027-10-11', channel: 'instagram', rank: 0, dueAt: '2027-10-11T07:00:00.000Z', postId: 'p1', propertyId: 'b1', propertyReference: 'AIM-0001', outcome: 'refuse', reason: 'sans_lien' },
  { id: 's3', day: '2027-10-11', channel: 'instagram', rank: 1, dueAt: '2027-10-11T16:30:00.000Z', postId: 'p3', propertyId: 'b3', propertyReference: null, outcome: 'envoye', reason: null },
  { id: 's4', day: '2027-10-11', channel: INJECTED, rank: 0, dueAt: 'pas une date', postId: 'p4', propertyId: 'b4', propertyReference: INJECTED, outcome: 'manque', reason: null },
  { id: 's5', day: '2027-10-11', channel: 'youtube', rank: 0, dueAt: '2027-10-11T07:00:00.000Z', postId: 'p5', propertyId: 'b5', propertyReference: 'X'.repeat(41), outcome: 'refuse', reason: 'inconnue' },
];

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

class FixedDate extends Date {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(NOW);
    else super(...(a as [number]));
  }
  static override now() {
    return NOW;
  }
}

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
    'GET /v1/gagner/rendez-vous': ok([]),
    'GET /v1/gagner/recommandations/a-appeler': ok([]),
    'GET /v1/gagner/relances': ok([]),
    'GET /v1/gagner/lettres': ok({ campaigns: [], properties: [] }),
    [`GET ${C}/reglages`]: ok({ today: TODAY_RULES, next: NEXT_RULES }),
    [`GET ${SLOTS_URL}`]: ok(SLOTS),
    [`POST ${C}/reglages`]: ok({ version: 3, perDay: zero, hours: ['08:00'], effectiveDay: '2027-10-12' }),
    [`POST ${C}/semaine`]: ok(SLOTS.slice(0, 3)),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Date: FixedDate,
    Intl,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = (src: string) => [...els.gagner!.all(), ...els['gagner-corps']!.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  await click(els['gagner-ouvrir']);
  runInNewContext(GAGNER_SCRIPT, context);
  scripts('/app/gagner.js')[0]!.listeners.load!({});
  await settle();
  const part = () => els['gagner-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Calendrier de publication')!;
  const button = (text: string) => part().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const buttons = () => part().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const plain = (x: string) => x.replace(/[  ]/g, ' ');
  const status = () => plain(part().all().find((e) => e.attributes.role === 'status')?.textContent ?? '');
  const texts = () => plain(part().textContent);
  const byId = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const open = async (load = true) => {
    await click(button('Ouvrir mon calendrier'));
    const s = scripts('/app/calendrier.js');
    if (load && s.length === 1 && !context.loaded) {
      runInNewContext(CALENDRIER_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const marketing = () => calls.filter((c) => c.url.startsWith('/v1/marketing'));
  const posts = () => calls.filter((c) => c.method === 'POST');
  const items = () => part().all().filter((e) => e.tagName === 'li').map((e) => plain(e.textContent));
  const setRules = (hours: string[], counts: Record<string, string>) => {
    [0, 1, 2].forEach((i) => (byId(`cal-heure-${i}`).value = hours[i] ?? ''));
    for (const c of SOCIAL_CHANNELS) byId(`cal-${c}`).value = counts[c] ?? '';
    return click(button('Ranger ce réglage'));
  };
  return { els, calls, part, button, buttons, status, texts, click, open, marketing, posts, items, scripts, byId, setRules };
}

describe('BR111 · le calendrier de publication à l’écran de l’agent', () => {
  it('[R201] servi à part, chargé au seul geste depuis « Gagner des mandats », jamais gardé ; le budget tient, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/calendrier.js']).toBe(CALENDRIER_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/calendrier.js');
    const served = handleAgentApp(new Request('https://x.test/app/calendrier.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: CALENDRIER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: GAGNER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/marketing');
    expect(JS).not.toContain('/app/calendrier.js');
    expect(CALENDRIER_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    expect(Object.keys(CALENDRIER_CHANNELS)).toEqual([...SOCIAL_CHANNELS]);
    const t = await run();
    expect(t.scripts('/app/calendrier.js')).toHaveLength(0);
    expect(t.marketing()).toEqual([]);
    await t.open();
    expect(t.marketing().map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${C}/reglages`, `GET ${SLOTS_URL}`]);
    expect(t.marketing().every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
    await t.open(false);
    expect(t.scripts('/app/calendrier.js')).toHaveLength(1);
    expect(t.marketing()).toHaveLength(4);
  });

  it('sans réseau au chargement du script : l’écran le dit et le bouton revient', async () => {
    const t = await run();
    await t.open(false);
    t.scripts('/app/calendrier.js')[0]!.listeners.error!({});
    await settle();
    expect(t.texts()).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.button('Ouvrir mon calendrier') as unknown as { disabled: boolean }).disabled).toBe(false);
  });

  it('[R581] le réglage d’aujourd’hui et le prochain, dit valable à partir de son jour', async () => {
    const t = await run();
    await t.open();
    expect(t.texts()).toContain('Aujourd’hui : Instagram 2, Facebook 1 par jour, à 09 h 00, 18 h 30.');
    expect(t.texts()).toContain('À partir du mardi 12 octobre : LinkedIn 1 par jour, à 12 h 00.');
    const t2 = await run({ [`GET ${C}/reglages`]: ok({ today: null, next: null }) });
    await t2.open();
    expect(t2.texts()).toContain('Aujourd’hui : aucun réglage en vigueur.');
    expect(t2.texts()).not.toContain('À partir du');
  });

  it('[R581] le réglage est vérifié avant l’appel (0 à 3, heures valides et croissantes), puis dit valable à partir du lendemain', async () => {
    const t = await run();
    await t.open();
    const bad: [string[], Record<string, string>, string][] = [
      [[], {}, CALENDRIER_REFUSALS.heures_invalides!],
      [['9h'], {}, CALENDRIER_REFUSALS.heures_invalides!],
      [['24:00'], {}, CALENDRIER_REFUSALS.heures_invalides!],
      [['18:00', '09:00'], {}, CALENDRIER_REFUSALS.heures_invalides!],
      [['09:00', '09:00'], {}, CALENDRIER_REFUSALS.heures_invalides!],
      [['09:00'], { instagram: '2' }, CALENDRIER_REFUSALS.nombres_invalides!],
      [['09:00', '12:00', '18:00'], { instagram: '4' }, CALENDRIER_REFUSALS.nombres_invalides!],
      [['09:00'], { facebook: '-1' }, CALENDRIER_REFUSALS.nombres_invalides!],
      [['09:00'], { tiktok: '1,5' }, CALENDRIER_REFUSALS.nombres_invalides!],
    ];
    for (const [hours, counts, said] of bad) {
      await t.setRules(hours, counts);
      expect(t.status()).toBe(said);
    }
    expect(t.posts()).toEqual([]);
    // Une heure laissée vide au milieu est écartée ; un réseau laissé vide vaut 0.
    await t.setRules(['08:00', '', '19:45'], { instagram: '2', google: '1' });
    expect(t.posts()).toEqual([{ method: 'POST', url: `${C}/reglages`, body: { perDay: { ...zero, instagram: 2, google: 1 }, hours: ['08:00', '19:45'] }, auth: `Bearer ${KEY}` }]);
    expect(t.status()).toBe('Réglage rangé : il vaut à partir du mardi 12 octobre, jamais pour aujourd’hui.');
  });

  it('[R580, R582] les créneaux dans l’ordre reçu, chacun avec son jour, son heure de Paris, son réseau et ce qu’il est devenu ; un créneau sans lien marqué le dit', async () => {
    const t = await run();
    await t.open();
    expect(t.items()).toEqual([
      'mardi 12 octobre à 09 h 00 · FacebookBien AIM-0002' + CALENDRIER_OUTCOMES.a_venir,
      'lundi 11 octobre à 09 h 00 · InstagramBien AIM-0001' + CALENDRIER_REASONS.sans_lien,
      'lundi 11 octobre à 18 h 30 · Instagram' + CALENDRIER_NO_PROPERTY + CALENDRIER_OUTCOMES.envoye,
      'lundi 11 octobre à — · Réseau inconnuBien ' + INJECTED + CALENDRIER_OUTCOMES.manque,
      'lundi 11 octobre à 09 h 00 · YouTube' + CALENDRIER_NO_PROPERTY + CALENDRIER_REASONS.controle,
    ]);
    // La référence piégée n'est que du texte : aucun élément n'est créé à partir d'elle.
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
    const t2 = await run({ [`GET ${SLOTS_URL}`]: ok([]) });
    await t2.open();
    expect(t2.texts()).toContain('Aucun créneau réservé sur les deux semaines.');
  });

  it('[R580] RC75 · chaque créneau montre la référence de son bien, jamais l’identifiant interne ; sans référence, il le dit', async () => {
    const list = [
      { ...SLOTS[0], propertyId: 'b-interne-1', propertyReference: '  AIM-0102  ' },
      { ...SLOTS[2], propertyId: 'b-interne-2', propertyReference: undefined },
      { ...SLOTS[2], propertyId: 'b-interne-3', propertyReference: '   ' },
      { ...SLOTS[2], propertyId: 'b-interne-4', propertyReference: 42 },
    ];
    const t = await run({ [`GET ${SLOTS_URL}`]: ok(list) });
    await t.open();
    const lines = t.part().all().filter((e) => e.tagName === 'li').map((li) => li.children[1]!.textContent);
    expect(lines).toEqual(['Bien AIM-0102', CALENDRIER_NO_PROPERTY, CALENDRIER_NO_PROPERTY, CALENDRIER_NO_PROPERTY]);
    expect(t.texts()).not.toMatch(/b-interne/);
  });

  it('réserver la semaine part du jour de Paris, puis relit le calendrier', async () => {
    const t = await run();
    await t.open();
    await t.click(t.button('Réserver ma semaine'));
    expect(t.posts()).toEqual([{ method: 'POST', url: `${C}/semaine`, body: { from: '2027-10-11' }, auth: `Bearer ${KEY}` }]);
    expect(t.status()).toBe('Semaine réservée : 3 créneaux pour vos publications prêtes.');
    expect(t.marketing().filter((c) => c.url === `${C}/reglages` && c.method === 'GET')).toHaveLength(2);
  });

  it('[R26, R582, R16] aucun envoi ni publication proposé à l’écran ; seules les routes du calendrier', async () => {
    const t = await run();
    await t.open();
    expect(t.buttons()).toEqual(['Ouvrir mon calendrier', 'Ranger ce réglage', 'Réserver ma semaine']);
    await t.setRules(['09:00'], { instagram: '1' });
    await t.click(t.button('Réserver ma semaine'));
    expect(t.marketing().every((c) => c.url.startsWith(`${C}/`))).toBe(true);
    expect(t.marketing().some((c) => /publi|envoi|passage/.test(c.url))).toBe(false);
  });

  it('refus dits en mots, jamais un code ; réponse perdue ou panne dite incertaine ; une écriture à la fois', async () => {
    const cases: [Answer, string][] = [
      [no(409, { ok: false, rule: 'R581', code: 'version_concurrente' }), CALENDRIER_REFUSALS.version_concurrente!],
      [no(409, { ok: false, rule: 'R86', code: 'agent_parti' }), CALENDRIER_REFUSALS.agent_parti!],
      [no(403, { ok: false, rule: 'R16', code: 'role' }), CALENDRIER_REFUSALS.role!],
      [no(409, { ok: false, rule: 'R581', code: 'autre' }), 'Le réglage n’est pas rangé.'],
      [no(500, { ok: false }), CALENDRIER_LOST],
      [cut, CALENDRIER_LOST],
    ];
    for (const [answer, said] of cases) {
      const t = await run({ [`POST ${C}/reglages`]: answer });
      await t.open();
      await t.setRules(['09:00'], { instagram: '1' });
      expect(t.status()).toBe(said);
      expect(t.status()).not.toMatch(/version_concurrente|agent_parti|R\d+/);
    }
    const t = await run({ [`GET ${C}/reglages`]: no(409, { ok: false, rule: 'R86', code: 'agent_parti' }) });
    await t.open();
    expect(t.status()).toBe(CALENDRIER_REFUSALS.agent_parti);
    const t2 = await run({ [`GET ${SLOTS_URL}`]: cut });
    await t2.open();
    expect(t2.status()).toBe('Pas de réseau. Réessayez dans un moment.');
    let release: () => void = () => {};
    const t3 = await run({ [`POST ${C}/semaine`]: () => new Promise((r) => (release = () => r(Response.json({ ok: true, data: [] })))) });
    await t3.open();
    t3.button('Réserver ma semaine')!.listeners.click!({});
    t3.button('Réserver ma semaine')!.listeners.click!({});
    await settle();
    expect(t3.posts()).toHaveLength(1);
    release();
    await settle();
    expect(t3.status()).toBe('Semaine réservée : 0 créneau pour vos publications prêtes.');
  });

  it('seule la dernière lecture dessine', async () => {
    const pending: (() => void)[] = [];
    let n = 0;
    const t = await run({
      [`GET ${C}/reglages`]: () => {
        n += 1;
        const mine = n;
        return new Promise((r) => pending.push(() => r(Response.json({ ok: true, data: { today: mine === 1 ? { ...TODAY_RULES, perDay: { ...zero, tiktok: 1 } } : TODAY_RULES, next: null } }))));
      },
    });
    await t.open();
    await t.open(false);
    pending[1]!();
    await settle();
    pending[0]!();
    await settle();
    expect(t.texts()).toContain('Instagram 2');
    expect(t.texts()).not.toContain('TikTok 1');
  });
});
