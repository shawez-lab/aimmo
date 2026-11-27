import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CLES_A_RENDRE_CONFIRM, CLES_A_RENDRE_CUT, CLES_A_RENDRE_REFUSALS, CLES_A_RENDRE_SCRIPT, CLES_A_RENDRE_UNSURE } from '../app/cles-a-rendre.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp, trimIndent } from '../src/agent-app.ts';
import { APP_JS } from '../app/fichiers.ts';
import { fakeDocument, pageIds, type FakeElement } from './fake-dom.ts';

// Tout est inventé : clé, trousseaux, références, partenaires, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const offline: Answer = () => Promise.reject(new TypeError('hors ligne'));

const LATE = { keyId: 'k1', number: 7, propertyId: 'p1', reference: 'REF-1', dueAt: '2027-03-02T09:30:00.000Z', overdue: true, text: 'Rendre le trousseau n° 7 (Porte d’entrée) du bien REF-1 à l’agence : après la visite.' };
const LATER = { keyId: 'k2', number: 3, propertyId: 'p2', reference: 'REF-2', dueAt: '2027-03-02T16:00:00.000Z', overdue: false, text: 'Faire revenir le trousseau n° 3 (Cave) du bien REF-2, remis à Diag Inventé (diagnostiqueur) : après « diagnostics ».' };
const UNSAFE = { keyId: 'mauvais id !', number: 9, propertyId: 'p3', reference: 'REF-3', dueAt: 'pas une date', overdue: false, text: INJECTED };

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const calls: { method: string; url: string }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
    'GET /v1/trousseaux/a-rendre': ok([LATE, LATER]),
    'POST /v1/trousseaux/k1/rendu': ok(null),
    'POST /v1/trousseaux/k1/perdu': ok(null),
    'POST /v1/trousseaux/k2/rendu': ok(null),
    'POST /v1/trousseaux/k2/perdu': ok(null),
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
  const capture = (e: { target: unknown }) => (listeners as Record<string, ((e: unknown) => void) | undefined>).click?.(e);
  const scripts = () => els.accueil!.all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/cles-a-rendre.js');
  const open = async (load = true) => {
    capture({ target: els['cles-rendre-ouvrir'] });
    els['cles-rendre-ouvrir']!.listeners.click!({});
    await settle();
    const s = scripts();
    if (load && s.length === 1 && !context.loaded) {
      runInNewContext(CLES_A_RENDRE_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const status = () => els['cles-rendre-etat']!.textContent;
  const body = () => els['cles-rendre-corps']!;
  const items = () => body().all().filter((e) => e.tagName === 'li');
  const gesture = (item: FakeElement, label: string) => item.all().find((e) => e.tagName === 'button' && e.textContent === label);
  // Un clic passe d'abord par l'écoute de tout l'écran (phase de capture), puis par le bouton.
  const press = async (target: FakeElement) => {
    capture({ target });
    target.listeners.click!({});
    await settle();
  };
  const tap = async (item: FakeElement, label: string) => {
    const b = gesture(item, label)!;
    capture({ target: b });
    b.listeners.click!({});
    await settle();
  };
  const count = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length;
  return { els, calls, table, context, scripts, open, status, body, items, gesture, tap, press, count };
}

describe('BR50 · « Mes clés à rendre » sur l’accueil de l’agent', () => {
  it('[R201] servi à part, chargé au seul geste, jamais gardé ; le budget tient, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/cles-a-rendre.js']).toBe(CLES_A_RENDRE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/cles-a-rendre.js');
    const served = handleAgentApp(new Request('https://x.test/app/cles-a-rendre.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: CLES_A_RENDRE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(CLES_A_RENDRE_SCRIPT).not.toContain('innerHTML');
    expect(JS).not.toContain("'/v1/trousseaux");
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    await t.open();
    expect(t.items()).toHaveLength(2);
    // Un second geste relit la liste sans recharger le script.
    await t.open(false);
    expect(t.scripts()).toHaveLength(1);
    expect(t.count('GET', '/v1/trousseaux/a-rendre')).toBe(2);
  });

  it('[R201] l’application est servie sans l’indentation de ses lignes, et rien d’autre n’y change', () => {
    expect(trimIndent('  var a = 1;\n\tb("  x  ");\n')).toBe('var a = 1;\nb("  x  ");\n');
    // Un gabarit à accents graves ou une chaîne coupée en fin de ligne : rien n'est touché.
    expect(trimIndent('  var a = `\n  x`;')).toBe('  var a = `\n  x`;');
    expect(trimIndent("  var a = 'x\\\n  y';")).toBe("  var a = 'x\\\n  y';");
    expect(APP_JS).not.toContain('`');
    expect(JS).not.toMatch(/^[ \t]/m);
    // Le même code, ligne pour ligne, une fois les espaces de tête ôtés.
    expect(JS.split('\n').length).toBeLessThanOrEqual(APP_JS.split('\n').length);
  });

  it('[R272] rien n’est lu avant le geste ; le bloc est dans les outils de l’agent', async () => {
    const t = await run();
    expect(t.calls.some((c) => c.url.startsWith('/v1/trousseaux'))).toBe(false);
    // DS011 · le bloc est dans l'écran « Outils » de l'agent, plus sur sa journée.
    const outils = HTML.slice(HTML.indexOf('<section id="outils"'));
    expect(outils.slice(0, outils.indexOf('<section id=', 10))).toContain('<button id="cles-rendre-ouvrir" type="button" class="secondaire rangee">Mes clés à rendre</button>');
  });

  it('[R272] [R665] chaque trousseau : le texte du serveur, l’heure du retour, « en retard » une fois passée, dans l’ordre reçu', async () => {
    const t = await run();
    await t.open();
    expect(t.status()).toBe('2 trousseaux à rendre, dont 1 en retard.');
    const [a, b] = t.items();
    expect(a!.textContent).toContain(LATE.text);
    expect(a!.textContent).toContain('En retard : à rendre depuis le 02/03/2027 à 10:30.');
    expect(a!.all().find((e) => e.textContent.startsWith('En retard'))!.className).toBe('alerte');
    expect(b!.textContent).toContain(LATER.text);
    expect(b!.textContent).toContain('À rendre au plus tard le 02/03/2027 à 17:00.');
    expect(t.gesture(a!, 'Rendu à l’agence')).toBeDefined();
    expect(t.gesture(a!, 'Perdu')).toBeDefined();
    // L'ordre du serveur, tel quel ; rien n'est trié ni calculé ici.
    expect(CLES_A_RENDRE_SCRIPT).not.toMatch(/\.sort\(|\.reverse\(|Date\.now|new Date/);
    for (const code of ['true', 'false', 'k1', 'p1']) expect(t.body().textContent).not.toContain(code);
  });

  it('tout texte reçu reste du texte ; un identifiant mal formé n’a aucun geste', async () => {
    const t = await run({ 'GET /v1/trousseaux/a-rendre': ok([UNSAFE]) });
    await t.open();
    const [u] = t.items();
    expect(u!.textContent).toContain(INJECTED);
    expect(u!.textContent).toContain('Heure du retour non dite.');
    expect(u!.all().some((e) => e.tagName === 'button')).toBe(false);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('aucune clé dehors : c’est dit en mots', async () => {
    const t = await run({ 'GET /v1/trousseaux/a-rendre': ok([]) });
    await t.open();
    expect(t.status()).toBe('Aucune clé à rendre : vous n’avez aucun trousseau dehors.');
    expect(t.items()).toHaveLength(0);
  });

  it('[R271] « Rendu à l’agence » note le retour, puis la liste est relue', async () => {
    const t = await run();
    await t.open();
    t.table['GET /v1/trousseaux/a-rendre'] = ok([LATER]);
    await t.tap(t.items()[0]!, 'Rendu à l’agence');
    expect(t.count('POST', '/v1/trousseaux/k1/rendu')).toBe(1);
    expect(t.count('GET', '/v1/trousseaux/a-rendre')).toBe(2);
    expect(t.status()).toBe('Trousseau n° 7 noté rendu à l’agence. 1 trousseau à rendre.');
    expect(t.items()).toHaveLength(1);
  });

  it('[R271] « Perdu » ne part qu’au second appui ; un autre geste annule la demande', async () => {
    const t = await run();
    await t.open();
    const [a, b] = t.items();
    await t.tap(a!, 'Perdu');
    expect(t.count('POST', '/v1/trousseaux/k1/perdu')).toBe(0);
    expect(t.status()).toBe(CLES_A_RENDRE_CONFIRM);
    expect(t.gesture(a!, 'Confirmer : perdu')).toBeDefined();
    // Un appui sur « Perdu » d'un autre trousseau annule le premier.
    await t.tap(b!, 'Perdu');
    expect(t.gesture(a!, 'Perdu')).toBeDefined();
    expect(t.gesture(a!, 'Confirmer : perdu')).toBeUndefined();
    // Relire la liste annule aussi.
    await t.open(false);
    const [c] = t.items();
    await t.tap(c!, 'Perdu');
    await t.tap(c!, 'Confirmer : perdu');
    expect(t.count('POST', '/v1/trousseaux/k1/perdu')).toBe(1);
    expect(t.count('POST', '/v1/trousseaux/k2/perdu')).toBe(0);
    expect(t.status()).toContain('Trousseau n° 7 noté perdu : il ne sortira plus.');
  });

  it('une écriture sans réponse est dite incertaine, la liste à relire', async () => {
    for (const lost of [offline, no(500, { ok: false }), async () => new Response('coupé', { status: 502 })]) {
      const t = await run({ 'POST /v1/trousseaux/k1/rendu': lost });
      await t.open();
      await t.tap(t.items()[0]!, 'Rendu à l’agence');
      expect(t.status()).toBe(CLES_A_RENDRE_UNSURE);
      expect(t.items()).toHaveLength(0);
    }
  });

  it('un seul envoi à la fois : un second geste pendant l’envoi ne part pas', async () => {
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: null }))));
    const t = await run({ 'POST /v1/trousseaux/k1/rendu': slow });
    await t.open();
    const [a, b] = t.items();
    await t.tap(a!, 'Rendu à l’agence');
    await t.tap(a!, 'Rendu à l’agence');
    await t.tap(b!, 'Rendu à l’agence');
    await t.open(false);
    expect(t.count('POST', '/v1/trousseaux/k1/rendu')).toBe(1);
    expect(t.count('POST', '/v1/trousseaux/k2/rendu')).toBe(0);
    expect(t.count('GET', '/v1/trousseaux/a-rendre')).toBe(1);
    release();
    await settle();
    expect(t.count('GET', '/v1/trousseaux/a-rendre')).toBe(2);
  });

  it('[R16] chaque refus est dit en mots, jamais par son code ; un trousseau déjà revenu fait relire la liste', async () => {
    const t = await run({ 'POST /v1/trousseaux/k1/rendu': no(403, { ok: false, rule: 'R16', code: 'pas_son_bien' }) });
    await t.open();
    await t.tap(t.items()[0]!, 'Rendu à l’agence');
    expect(t.status()).toBe(CLES_A_RENDRE_REFUSALS.pas_son_bien);
    expect(t.status()).not.toMatch(/R16|pas_son_bien/);
    expect(t.count('GET', '/v1/trousseaux/a-rendre')).toBe(1);

    const u = await run({ 'POST /v1/trousseaux/k1/perdu': no(409, { ok: false, rule: 'R271', code: 'pas_sorti' }) });
    await u.open();
    u.table['GET /v1/trousseaux/a-rendre'] = ok([LATER]);
    await u.tap(u.items()[0]!, 'Perdu');
    await u.tap(u.items()[0]!, 'Confirmer : perdu');
    expect(u.status()).toBe(`${CLES_A_RENDRE_REFUSALS.pas_sorti} 1 trousseau à rendre.`);
    expect(u.items()).toHaveLength(1);

    const v = await run({ 'GET /v1/trousseaux/a-rendre': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await v.open();
    expect(v.status()).toBe(CLES_A_RENDRE_REFUSALS.role);

    const w = await run({ 'POST /v1/trousseaux/k1/rendu': no(409, { ok: false, rule: 'R271', code: 'code_jamais_vu' }) });
    await w.open();
    await w.tap(w.items()[0]!, 'Rendu à l’agence');
    expect(w.status()).toBe('Le retour n’a pas pu être noté. Réessayez dans un moment.');
  });

  it('sans réseau au chargement du script, l’écran le dit ; un script sans son écran aussi, jamais un bloc vide', async () => {
    const t = await run();
    await t.open(false);
    t.scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.status()).toBe('Pas de réseau. Réessayez dans un moment.');
    const u = await run();
    await u.open(false);
    u.scripts()[0]!.listeners.load!({});
    await settle();
    expect(u.status()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('un retour coupé par un changement d’écran est dit incertain, ses gestes retirés ; une lecture coupée le dit aussi', async () => {
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: null }))));
    const t = await run({ 'POST /v1/trousseaux/k1/rendu': slow });
    await t.open();
    await t.tap(t.items()[0]!, 'Rendu à l’agence');
    expect(t.status()).toBe('Envoi…');
    // L'agent ouvre ses mises en relation avant la réponse, puis revient à l'accueil.
    t.els['partenaires-ouvrir']!.listeners.click!({});
    await settle();
    release();
    await settle();
    expect(t.status()).toBe(CLES_A_RENDRE_UNSURE);
    expect(t.items()).toHaveLength(0);
    // Le geste suivant repart.
    await t.open(false);
    expect(t.items()).toHaveLength(2);

    const u = await run();
    await u.open();
    u.table['GET /v1/trousseaux/a-rendre'] = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: [LATE] }))));
    await u.open(false);
    u.els['partenaires-ouvrir']!.listeners.click!({});
    await settle();
    release();
    await settle();
    expect(u.status()).toBe(CLES_A_RENDRE_CUT);
    expect(u.items()).toHaveLength(0);
  });

  it('[R271] un « Perdu » demandé avant un changement d’écran ne vaut plus : il faut le redemander', async () => {
    const t = await run();
    await t.open();
    const [a] = t.items();
    await t.tap(a!, 'Perdu');
    t.els['partenaires-ouvrir']!.listeners.click!({});
    await settle();
    await t.tap(a!, 'Confirmer : perdu');
    expect(t.count('POST', '/v1/trousseaux/k1/perdu')).toBe(0);
    expect(t.status()).toBe(CLES_A_RENDRE_CONFIRM);
    await t.tap(a!, 'Confirmer : perdu');
    expect(t.count('POST', '/v1/trousseaux/k1/perdu')).toBe(1);
  });

  it('[R271] tout autre geste de l’écran, même dans un autre bloc, annule un « Perdu » demandé', async () => {
    const t = await run();
    await t.open();
    const [a] = t.items();
    await t.tap(a!, 'Perdu');
    await t.press(t.els['actualites-vues']!);
    expect(t.gesture(a!, 'Confirmer : perdu')).toBeUndefined();
    expect(t.gesture(a!, 'Perdu')).toBeDefined();
    await t.tap(a!, 'Perdu');
    expect(t.count('POST', '/v1/trousseaux/k1/perdu')).toBe(0);
    await t.tap(a!, 'Confirmer : perdu');
    expect(t.count('POST', '/v1/trousseaux/k1/perdu')).toBe(1);
  });

  it('un chargement du script coupé par un changement d’écran ne laisse jamais « Chargement… »', async () => {
    for (const end of ['load', 'error'] as const) {
      const t = await run();
      await t.open(false);
      expect(t.status()).toBe('Chargement…');
      t.els['partenaires-ouvrir']!.listeners.click!({});
      await settle();
      if (end === 'load') runInNewContext(CLES_A_RENDRE_SCRIPT, t.context);
      t.scripts()[0]!.listeners[end]!({});
      await settle();
      expect(t.status()).toBe(CLES_A_RENDRE_CUT);
      expect(t.calls.some((c) => c.url.startsWith('/v1/trousseaux'))).toBe(false);
    }
    // La sortie avant la fin du chargement : rien n'est dit.
    const u = await run();
    await u.open(false);
    u.els.sortir!.listeners.click!({});
    await settle();
    u.scripts()[0]!.listeners.error!({});
    await settle();
    expect(u.status()).toBe('');
  });

  it('une réponse d’avant la sortie ne libère jamais l’envoi d’après', async () => {
    // Le module seul, avec ses outils : la sortie (wipe), puis un nouvel envoi, avant la réponse du premier.
    const { els, document } = fakeDocument(['cles-rendre-etat', 'cles-rendre-corps']);
    const pending: (() => void)[] = [];
    const posts: string[] = [];
    const context: Record<string, unknown> = { document };
    runInNewContext(CLES_A_RENDRE_SCRIPT, context);
    const el = (tag: string, text?: string | null, cls?: string) => {
      const n = document.createElement(tag);
      if (text !== undefined && text !== null) n.textContent = String(text);
      if (cls) n.className = cls;
      return n;
    };
    const screen = (context.AIMMO_CLES_A_RENDRE as (t: unknown) => { show: () => Promise<boolean>; wipe: () => void })({
      $: (id: string) => els[id],
      el,
      clear: (n: FakeElement) => (n.textContent = ''),
      button: (text: string, onClick: () => void) => {
        const b = el('button', text);
        b.addEventListener('click', onClick);
        return b;
      },
      date: () => '02/03/2027',
      hour: () => '10:30',
      session: () => 1,
      send: (url: string, method: string) => {
        if (method === 'GET') return Promise.resolve({ status: 200, ok: true, body: { ok: true, data: [LATE, LATER] } });
        posts.push(url);
        return new Promise((r) => pending.push(() => r({ status: 200, ok: true, body: { ok: true, data: null } })));
      },
    });
    const rows = () => els['cles-rendre-corps']!.all().filter((e) => e.tagName === 'li');
    const back = (i: number) => rows()[i]!.all().find((e) => e.tagName === 'button' && e.textContent === 'Rendu à l’agence')!;
    await screen.show();
    back(0).listeners.click!({});
    screen.wipe();
    await screen.show();
    back(1).listeners.click!({});
    expect(posts).toEqual(['/v1/trousseaux/k1/rendu', '/v1/trousseaux/k2/rendu']);
    // La réponse du premier arrive : l'envoi du second reste seul en cours.
    pending[0]!();
    await settle();
    back(0).listeners.click!({});
    expect(posts).toHaveLength(2);
    pending[1]!();
    await settle();
    expect(els['cles-rendre-etat']!.textContent).toContain('Trousseau n° 3 noté rendu à l’agence.');
  });

  it('[R13] la sortie efface le bloc ; une réponse arrivée après ne montre rien', async () => {
    let release: () => void = () => undefined;
    const t = await run();
    await t.open();
    expect(t.items()).toHaveLength(2);
    t.table['GET /v1/trousseaux/a-rendre'] = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: [LATE] }))));
    await t.open(false);
    t.els.sortir!.listeners.click!({});
    await settle();
    release();
    await settle();
    expect(t.els['cles-rendre-corps']!.children).toHaveLength(0);
    expect(t.status()).toBe('');
  });
});
