import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import {
  NEUF_DIRECTION_LEFT,
  NEUF_DIRECTION_LOST,
  NEUF_DIRECTION_NO_PROGRAM,
  NEUF_DIRECTION_NO_SCALE,
  NEUF_DIRECTION_PROGRAM_MISSING,
  NEUF_DIRECTION_REFUSALS,
  NEUF_DIRECTION_SCALE_MISSING,
  NEUF_DIRECTION_SCRIPT,
} from '../app/neuf-direction.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, barèmes, promoteurs, agents, programmes.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const S = (id: string, rateBp: number, source: string, validFrom: string) => ({ scaleId: id, rateBp, source, validFrom, setAt: '2027-02-01T10:00:00.000Z' });
const BOARD = {
  day: '2027-03-01',
  neuf: { current: S('s2', 260, 'Barème du neuf inventé', '2027-01-01'), upcoming: [S('s3', 280, 'Barème d’avril inventé', '2027-04-01')], replaced: [S('s1', 200, 'Barème de 2026 inventé', '2026-01-01')] },
  ancien: { current: null, upcoming: [], replaced: [] },
};
const AGENTS = [
  { agentId: 'ag1', firstName: 'Alex', lastName: 'Agent' },
  { agentId: 'ag2', firstName: 'Sam', lastName: 'Exemple' },
];
const PROGRAMS = [
  { programId: 'pg1', name: 'Les Jardins inventés', city: 'Dijon', postalCode: '21000', promoter: 'Promoteur Exemple', agentId: 'ag1', createdAt: '2027-02-01T10:00:00.000Z' },
  { programId: 'pg2', name: 'Le Clos inventé', city: 'Chenôve', postalCode: '21300', promoter: 'Autre Promoteur', agentId: 'ag9', createdAt: '2027-01-01T10:00:00.000Z' },
];
const ANNUAIRE = { proposable: [{ partnerId: 'pa1', businessName: 'Promoteur Exemple', trade: 'promoteur' }], unavailable: [{ partnerId: 'pa2', businessName: 'Promoteur en attente', trade: 'promoteur' }, { partnerId: 'pa3', businessName: 'Notaire glissé', trade: 'notaire' }] };

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
const btn = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);

async function desk(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  (document as { body?: FakeElement }).body = new FakeElement('body');
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/gagner/engagements': ok([]),
    'GET /v1/neuf/baremes': ok(BOARD),
    'GET /v1/neuf/programmes': ok(PROGRAMS),
    'GET /v1/gagner/recommandations/agents': ok(AGENTS),
    'GET /v1/partenaires/annuaire?metier=promoteur&cp=21000': ok(ANNUAIRE),
    'POST /v1/neuf/baremes': ok({ id: 's9' }),
    'POST /v1/neuf/programmes': ok({ programId: 'pg9' }),
    ...answers,
  };
  const ctx: Record<string, unknown> = {
    document,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const a = table[`${method} ${url}`] ?? (method === 'GET' && url === '/v1/moi' ? ok({ role: 'direction', firstName: null }) : undefined);
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, ctx);
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  await click(els['engagements-voir']);
  runInNewContext(ENGAGEMENTS_SCRIPT, ctx);
  scriptsOf(els.reseau!, '/app/engagements.js')[0]!.listeners.load!({});
  await settle();
  const part = () => els['engagements-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Programmes neufs')!;
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const set = (id: string, value: string) => {
    input(id).value = value;
  };
  const open = async () => {
    await click(btn(part(), 'Ouvrir les programmes neufs'));
    const s = scriptsOf(part(), '/app/neuf-direction.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(NEUF_DIRECTION_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const statuses = () => part().all().filter((e) => e.attributes.role === 'status').map((e) => e.textContent);
  return { calls, table, part, input, set, open, click, posts, statuses, button: (t: string) => btn(part(), t), text: () => part().textContent };
}

describe('BR79 · les programmes neufs à l’écran de la direction', () => {
  it('[R201] un seul script servi à part, chargé au seul geste sous les engagements ; budgets tenus, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/neuf-direction.js']).toBe(NEUF_DIRECTION_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/neuf-direction.js');
    const served = handleAgentApp(new Request('https://x.test/app/neuf-direction.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: NEUF_DIRECTION_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: ENGAGEMENTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/neuf');
    expect(NEUF_DIRECTION_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    const d = await desk();
    expect(scriptsOf(d.part(), '/app/neuf-direction.js')).toHaveLength(0);
    expect(d.calls.some((c) => c.url.startsWith('/v1/neuf'))).toBe(false);
    await d.open();
    expect(scriptsOf(d.part(), '/app/neuf-direction.js')).toHaveLength(1);
    // Rouvrir ne recharge pas le script.
    await d.click(d.button('Ouvrir les programmes neufs'));
    expect(scriptsOf(d.part(), '/app/neuf-direction.js')).toHaveLength(1);
  });

  it('[R544] chaque barème dit avec sa source : en vigueur, à venir, remplacé ; sans barème en vigueur, aucun frais calculé', async () => {
    const d = await desk();
    await d.open();
    const text = d.text();
    expect(text).toContain('En vigueur depuis le 01/01/2027 : 2,6 %');
    expect(text).toContain('Source : Barème du neuf inventé');
    expect(text).toContain('À venir, à partir du 01/04/2027 : 2,8 %');
    expect(text).toContain('Remplacé, du 01/01/2026 : 2 %');
    expect(text).toContain('Frais de l’ancien');
    expect(text).toContain(NEUF_DIRECTION_NO_SCALE);
    expect(text.split(NEUF_DIRECTION_NO_SCALE)).toHaveLength(2);
  });

  it('[R544] ranger un barème : pourcentage envoyé en points de base entiers, source et premier jour exigés avant l’appel, puis l’écran relu', async () => {
    const d = await desk();
    await d.open();
    // Un vrai champ de date, que le navigateur sait remplir.
    expect([d.input('neuf-bareme-debut').tagName, d.input('neuf-bareme-debut').attributes.type]).toEqual(['input', 'date']);
    expect(d.input('neuf-bareme-sorte').tagName).toBe('select');
    d.set('neuf-bareme-sorte', 'ancien');
    d.set('neuf-bareme-taux', '7,5');
    d.set('neuf-bareme-source', 'abc');
    d.set('neuf-bareme-debut', '2027-03-01');
    await d.click(d.button('Ranger ce barème'));
    expect(d.posts()).toHaveLength(0);
    expect(d.statuses()).toContain(NEUF_DIRECTION_SCALE_MISSING);
    d.set('neuf-bareme-source', 'Barème de l’ancien inventé');
    d.set('neuf-bareme-debut', '');
    await d.click(d.button('Ranger ce barème'));
    expect(d.posts()).toHaveLength(0);
    d.set('neuf-bareme-debut', '2027-03-01');
    d.set('neuf-bareme-taux', '7,555');
    await d.click(d.button('Ranger ce barème'));
    expect(d.posts()).toHaveLength(0);
    d.set('neuf-bareme-taux', '7,5 %');
    const before = d.calls.filter((c) => c.url === '/v1/neuf/baremes' && c.method === 'GET').length;
    await d.click(d.button('Ranger ce barème'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/neuf/baremes', body: { kind: 'ancien', rateBp: 750, source: 'Barème de l’ancien inventé', validFrom: '2027-03-01' } }]);
    expect(d.calls.filter((c) => c.url === '/v1/neuf/baremes' && c.method === 'GET').length).toBe(before + 1);
    expect(d.statuses()).toContain('Barème rangé : l’écran est relu.');
  });

  it('les programmes avec le nom de leur agent ; un agent sorti dit comme tel ; aucun : dit en mots', async () => {
    const d = await desk();
    await d.open();
    expect(d.text()).toContain('Les Jardins inventés');
    expect(d.text()).toContain('21000 Dijon · promoteur Promoteur Exemple · confié à Alex Agent');
    expect(d.text()).toContain(`Chenôve · promoteur Autre Promoteur · ${NEUF_DIRECTION_LEFT}`);
    expect(d.text()).not.toContain('ag9');
    const e = await desk({ 'GET /v1/neuf/programmes': ok([]) });
    await e.open();
    expect(e.text()).toContain(NEUF_DIRECTION_NO_PROGRAM);
  });

  it('[R73] ouvrir un programme : promoteur choisi dans l’annuaire par code postal, agent parmi ceux en activité, identifiants envoyés', async () => {
    const d = await desk();
    await d.open();
    // Rien de choisi : rien ne part.
    await d.click(d.button('Ouvrir le programme'));
    expect(d.posts()).toHaveLength(0);
    expect(d.statuses()).toContain(NEUF_DIRECTION_PROGRAM_MISSING);
    d.set('neuf-programme-cp', '2100');
    await d.click(d.button('Chercher le promoteur dans l’annuaire'));
    expect(d.text()).toContain(NEUF_DIRECTION_REFUSALS.bad_postcode);
    d.set('neuf-programme-cp', '21000');
    await d.click(d.button('Chercher le promoteur dans l’annuaire'));
    const options = d.input('neuf-programme-promoteur').children.map((o) => o.value);
    expect(options).toEqual(['', 'pa1', 'pa2']);
    expect(d.text()).toContain('2 promoteurs trouvés');
    expect(d.text()).not.toContain('Notaire glissé');
    const agents = d.input('neuf-programme-agent').children.map((o) => [o.value, o.textContent]);
    expect(agents).toEqual([['', 'Choisir…'], ['ag1', 'Alex Agent'], ['ag2', 'Sam Exemple']]);
    d.set('neuf-programme-nom', 'Les Jardins inventés');
    d.set('neuf-programme-ville', 'Dijon');
    d.set('neuf-programme-promoteur', 'pa1');
    d.set('neuf-programme-agent', 'ag2');
    await d.click(d.button('Ouvrir le programme'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/neuf/programmes', body: { promoterPartnerId: 'pa1', agentId: 'ag2', name: 'Les Jardins inventés', city: 'Dijon', postalCode: '21000' } }]);
    expect(d.statuses()).toContain('Programme ouvert : il est confié à Sam Exemple.');
  });

  it('sans la liste des agents, aucun programme ne s’ouvre', async () => {
    const d = await desk({ 'GET /v1/gagner/recommandations/agents': no(503, { ok: false, code: 'panne' }) });
    await d.open();
    expect(d.part().all().some((e) => e.attributes.id === 'neuf-programme-agent')).toBe(false);
    expect(d.text()).toContain('aucun programme ne s’ouvre');
    expect(d.text()).not.toContain('confié à');
  });

  it('[R16] chaque refus dit en mots, jamais un code ; une écriture sans réponse dite incertaine et l’écran relu', async () => {
    const d = await desk({ 'POST /v1/neuf/baremes': no(409, { ok: false, rule: 'R544', code: 'rate' }) });
    await d.open();
    d.set('neuf-bareme-sorte', 'neuf');
    d.set('neuf-bareme-taux', '25');
    d.set('neuf-bareme-source', 'Barème du neuf inventé');
    d.set('neuf-bareme-debut', '2027-03-01');
    await d.click(d.button('Ranger ce barème'));
    expect(d.statuses()).toContain(NEUF_DIRECTION_REFUSALS.rate);
    expect(d.text()).not.toMatch(/\brate\b|R544/);

    const r = await desk({ 'GET /v1/neuf/baremes': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await r.open();
    expect(r.text()).toContain(NEUF_DIRECTION_REFUSALS.role);

    const l = await desk({ 'POST /v1/neuf/baremes': cut });
    await l.open();
    l.set('neuf-bareme-sorte', 'neuf');
    l.set('neuf-bareme-taux', '2,5');
    l.set('neuf-bareme-source', 'Barème du neuf inventé');
    l.set('neuf-bareme-debut', '2027-03-01');
    const before = l.calls.filter((c) => c.url === '/v1/neuf/baremes' && c.method === 'GET').length;
    await l.click(l.button('Ranger ce barème'));
    expect(l.statuses()).toContain(NEUF_DIRECTION_LOST);
    expect(l.calls.filter((c) => c.url === '/v1/neuf/baremes' && c.method === 'GET').length).toBe(before + 1);
  });

  it('texte reçu posé en texte ; un champ mal formé est tu', async () => {
    const d = await desk({
      'GET /v1/neuf/baremes': ok({
        day: '2027-03-01',
        neuf: { current: S('s1', 250, INJECTED, '2027-01-01'), upcoming: [S('s2', 99999, 'Taux hors bornes', '2027-05-01'), S('../x', 300, 'Identifiant douteux', '2027-06-01')], replaced: [S('s4', 200, 'Jour mal formé', '01/01/2026')] },
        ancien: { current: null, upcoming: [], replaced: [] },
      }),
      'GET /v1/neuf/programmes': ok([{ ...PROGRAMS[0], name: INJECTED }, { ...PROGRAMS[1], programId: 'a b' }]),
    });
    await d.open();
    const texts = d.part().all().map((e) => e.textContent);
    expect(texts.some((x) => x.includes(INJECTED))).toBe(true);
    expect(d.part().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(d.text()).not.toContain('Taux hors bornes');
    expect(d.text()).not.toContain('Identifiant douteux');
    expect(d.text()).not.toContain('Jour mal formé');
    expect(d.text()).not.toContain('Le Clos inventé');
  });
});
