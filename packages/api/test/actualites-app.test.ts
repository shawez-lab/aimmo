import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ACTUALITES_CUT, ACTUALITES_LOST, ACTUALITES_REFUSALS, ACTUALITES_SCRIPT } from '../app/actualites.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, actualités, sources, références, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const offline: Answer = () => Promise.reject(new TypeError('hors ligne'));

const news = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  topic: 'juridique',
  title: `Titre ${id}`,
  impact: `Impact ${id}`,
  source: { name: 'Éditeur inventé', url: `https://exemple.test/${id}`, date: '2027-03-01' },
  target: {},
  publishedOn: '2027-03-02',
  concerned: [],
  ...extra,
});
const TARGETED = news('n1', {
  topic: 'marche',
  target: { postcodes: ['21000'] },
  concerned: [
    { propertyId: 'p1', reference: 'REF-1', why: 'code postal 21000' },
    { propertyId: 'p2', reference: 'REF-2', why: 'code postal 21000' },
  ],
});
const NETWORK = news('n2');
const UNSAFE = news('n3', { title: INJECTED, impact: INJECTED, source: { name: INJECTED, url: 'javascript:alert(1)', date: '2027-03-01' } });
const SEEN = [
  { ...news('n4', { target: { kinds: ['home'] } }), shownOn: '2027-03-05' },
  { ...news('n5'), shownOn: '2027-03-04' },
];

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, role = 'agent') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: { method: string; url: string }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role, firstName: 'Alex' }),
    'GET /v1/actualites': ok([TARGETED, NETWORK, UNSAFE]),
    'GET /v1/actualites/deja-vues': ok(SEEN),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    Date,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url });
      const a = table[`${method} ${url}`];
      return a ? a() : offline();
    },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const scripts = () => els.accueil!.all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/actualites.js');
  const click = async (id: string, load = true) => {
    els[id]!.listeners.click!({});
    await settle();
    const s = scripts();
    if (load && s.length === 1 && !context.loaded) {
      runInNewContext(ACTUALITES_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const status = () => els['actualites-etat']!.textContent;
  const body = () => els['actualites-corps']!;
  const items = () => body().all().filter((e) => e.tagName === 'li' && e.children[0]?.tagName === 'strong');
  const reads = (url: string) => calls.filter((c) => c.url === url).length;
  return { els, calls, table, context, scripts, click, status, body, items, reads };
}

describe('BR49 · « Mes actualités » sur l’accueil de l’agent', () => {
  it('[R201] servi à part, chargé au seul geste, jamais gardé ; le budget tient, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/actualites.js']).toBe(ACTUALITES_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/actualites.js');
    const served = handleAgentApp(new Request('https://x.test/app/actualites.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: ACTUALITES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(ACTUALITES_SCRIPT).not.toContain('innerHTML');
    expect(JS).not.toContain("'/v1/actualites");
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    await t.click('actualites-ouvrir');
    expect(t.items()).toHaveLength(3);
    // Un second geste ne recharge pas le script.
    await t.click('actualites-vues', false);
    expect(t.scripts()).toHaveLength(1);
  });

  it('[R269] le fil n’est jamais demandé sans le geste de l’agent : l’accueil seul ne marque rien comme vu', async () => {
    const t = await run();
    expect(t.calls.some((c) => c.url.startsWith('/v1/actualites'))).toBe(false);
    // Le bloc ne demande rien au serveur avant le geste.
    // DS011 · le bloc est dans l'écran « Outils » de l'agent, plus sur sa journée.
    const outils = HTML.slice(HTML.indexOf('<section id="outils"'));
    expect(outils.slice(0, outils.indexOf('<section id=', 10))).toContain('<button id="actualites-ouvrir" type="button" class="secondaire rangee">Mes actualités</button>');
    await t.click('actualites-vues');
    expect(t.reads('/v1/actualites')).toBe(0);
    expect(t.reads('/v1/actualites/deja-vues')).toBe(1);
  });

  it('[R269] [R268] chaque nouvelle : sa source datée avec son lien https, ce qu’elle change, les dossiers touchés et pourquoi, dans l’ordre reçu', async () => {
    const t = await run();
    await t.click('actualites-ouvrir');
    expect(t.status()).toBe('3 nouvelles actualités : elles ne reviendront plus ici, elles se relisent dans « Déjà vues ».');
    const [first, second] = t.items();
    const a = first!.textContent;
    expect(a).toContain('Titre n1');
    expect(a).toContain('Marché · rangée le 02/03/2027');
    expect(a).toContain('Ce que ça change pour vous : Impact n1');
    expect(a).toContain('Source : Éditeur inventé, du 01/03/2027');
    expect(a).toContain('Touche 2 de vos dossiers :');
    expect(a).toContain('Bien REF-1 : code postal 21000');
    expect(a).toContain('Bien REF-2 : code postal 21000');
    const link = first!.all().find((e) => e.tagName === 'a')!;
    expect(link.attributes.href).toBe('https://exemple.test/n1');
    expect(link.attributes.rel).toBe('noopener noreferrer');
    expect(second!.textContent).toContain('Juridique');
    expect(second!.textContent).toContain('Pour tout le réseau.');
    // L'ordre du serveur, tel quel ; rien n'est trié ni filtré ici.
    expect(t.body().textContent.indexOf('Titre n1')).toBeLessThan(t.body().textContent.indexOf('Titre n2'));
    expect(ACTUALITES_SCRIPT).not.toMatch(/\.sort\(|\.reverse\(/);
    for (const code of ['marche', 'juridique', 'postcodes', 'true', 'false']) expect(t.body().textContent).not.toContain(code);
  });

  it('tout texte reçu reste du texte ; un lien qui n’est pas https n’est jamais posé', async () => {
    const t = await run();
    await t.click('actualites-ouvrir');
    const third = t.items()[2]!;
    expect(third.textContent).toContain(INJECTED);
    expect(third.textContent).toContain('(lien non sûr, non montré)');
    expect(third.all().some((e) => e.tagName === 'a')).toBe(false);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('[R269] « Déjà vues » : le jour où chacune a été montrée ; une ciblée qui ne touche plus aucun dossier le dit', async () => {
    const t = await run();
    await t.click('actualites-vues');
    expect(t.status()).toBe('2 actualités déjà vues, les plus récemment montrées d’abord.');
    const [a, b] = t.items();
    expect(a!.textContent).toContain('montrée le 05/03/2027');
    expect(a!.textContent).toContain('Ne touche plus aucun de vos dossiers aujourd’hui.');
    expect(b!.textContent).toContain('montrée le 04/03/2027');
    expect(b!.textContent).toContain('Pour tout le réseau.');
    // Relire autant de fois qu'on veut : chaque geste relit.
    await t.click('actualites-vues');
    expect(t.reads('/v1/actualites/deja-vues')).toBe(2);
    expect(t.reads('/v1/actualites')).toBe(0);
  });

  it('[R269] une réponse du fil perdue (coupure ou panne) renvoie vers « Déjà vues », jamais « rien de nouveau »', async () => {
    for (const lost of [offline, no(500, { ok: false }), async () => new Response('coupé', { status: 502 })]) {
      const t = await run({ 'GET /v1/actualites': lost });
      await t.click('actualites-ouvrir');
      expect(t.status()).toBe(ACTUALITES_LOST);
      expect(t.items()).toHaveLength(0);
    }
  });

  it('fil vide et « Déjà vues » vide : c’est dit en mots', async () => {
    const t = await run({ 'GET /v1/actualites': ok([]), 'GET /v1/actualites/deja-vues': ok([]) });
    await t.click('actualites-ouvrir');
    expect(t.status()).toBe('Rien de nouveau. Celles déjà montrées se relisent dans « Déjà vues ».');
    await t.click('actualites-vues');
    expect(t.status()).toContain('Aucune actualité déjà vue encore en vigueur');
  });

  it('[R16] la direction refusée : le refus est dit en mots, jamais par son code', async () => {
    const t = await run({ 'GET /v1/actualites/deja-vues': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.click('actualites-vues');
    expect(t.status()).toBe(ACTUALITES_REFUSALS.role);
    expect(t.status()).not.toContain('R16');
  });

  it('sans réseau au chargement du script, l’écran le dit ; un script sans son écran aussi, jamais un bloc vide', async () => {
    const t = await run();
    await t.click('actualites-ouvrir', false);
    t.scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.status()).toBe('Pas de réseau. Réessayez dans un moment.');
    const u = await run();
    await u.click('actualites-ouvrir', false);
    u.scripts()[0]!.listeners.load!({});
    await settle();
    expect(u.status()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('[R269] pendant qu’un fil est demandé, aucun autre geste ne part : un double geste ne fait jamais jeter des actualités marquées vues', async () => {
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: [TARGETED] }))));
    const t = await run({ 'GET /v1/actualites': slow });
    await t.click('actualites-ouvrir');
    await t.click('actualites-ouvrir');
    await t.click('actualites-vues');
    expect(t.reads('/v1/actualites')).toBe(1);
    expect(t.reads('/v1/actualites/deja-vues')).toBe(0);
    release();
    await settle();
    expect(t.body().textContent).toContain('Titre n1');
    // Le fil arrivé, les gestes repartent.
    await t.click('actualites-vues');
    expect(t.reads('/v1/actualites/deja-vues')).toBe(1);
    expect(t.body().textContent).toContain('Déjà vues');
  });

  it('seule la dernière lecture dessine : une relecture de « Déjà vues » arrivée en retard ne remplace pas le fil', async () => {
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: SEEN }))));
    const t = await run({ 'GET /v1/actualites/deja-vues': slow });
    await t.click('actualites-vues');
    await t.click('actualites-ouvrir');
    release();
    await settle();
    expect(t.body().textContent).toContain('Nouvelles');
    expect(t.body().textContent).not.toContain('Titre n4');
  });

  it('[R269] un fil coupé par un changement d’écran ne reste jamais « Chargement… » : il renvoie vers « Déjà vues »', async () => {
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: [TARGETED] }))));
    const t = await run({ 'GET /v1/actualites': slow });
    await t.click('actualites-ouvrir');
    expect(t.status()).toBe('Chargement…');
    // L'agent ouvre ses mises en relation avant la réponse, puis revient.
    t.els['partenaires-ouvrir']!.listeners.click!({});
    await settle();
    release();
    await settle();
    expect(t.status()).toBe(ACTUALITES_CUT);
    expect(t.body().textContent).not.toContain('Titre n1');
    // Le geste suivant repart : le fil coupé ne bloque rien.
    await t.click('actualites-vues');
    expect(t.reads('/v1/actualites/deja-vues')).toBe(1);
  });

  it('[R13] la sortie efface le bloc', async () => {
    const t = await run();
    await t.click('actualites-ouvrir');
    expect(t.items()).toHaveLength(3);
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.els['actualites-corps']!.children).toHaveLength(0);
    expect(t.status()).toBe('');
  });
});
