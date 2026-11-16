import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import { PANNEAUX_BUSY, PANNEAUX_FORM, PANNEAUX_REFUSALS, PANNEAUX_SCRIPT, PANNEAUX_UNSURE } from '../app/panneaux.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, biens, adresses, numéros de panneaux.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
type Call = { method: string; url: string; body: Record<string, unknown> | null };
const ok = (data: unknown, extra: Record<string, unknown> = {}): Answer => async () => Response.json({ ok: true, mode: 'essai', data, ...extra });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const ADDRESS = { streetNumber: '12', street: 'rue des Tilleuls Inventée', postcode: '21000', city: 'Dijon' };
const POSE = { placementId: 'p1', signNumber: 7, size: 'grand', propertyId: 'b1', reference: 'REF-T-1', agentId: 'a1', placedAt: '2027-03-02T09:00:00.000Z', address: ADDRESS, pickup: null };
const DUE = { placementId: 'p2', signNumber: 9, size: 'petit', propertyId: 'b2', reference: 'REF-T-2', agentId: 'a2', placedAt: '2027-02-01T09:00:00.000Z', address: { ...ADDRESS, streetNumber: '3', street: 'allée Inventée' }, pickup: { reason: 'vendu', dueDay: '2027-03-10' } };
const COUNTS = { total: 12, enStock: 9, poses: 2, aRecuperer: 1, perdus: 1, bySize: { grand: { enStock: 4, poses: 1 }, moyen: { enStock: 3, poses: 0 }, petit: { enStock: 2, poses: 1 } } };
const STOCK = ok({ counts: COUNTS, placed: [POSE, DUE] });

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function context(role: string, table: Record<string, Answer>, calls: Call[], document: unknown) {
  return {
    document,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const a = table[`${method} ${url}`] ?? (method === 'GET' && url === '/v1/moi' ? ok({ role, firstName: null }) : undefined);
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  } as Record<string, unknown>;
}
const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
const btn = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
const statusOf = (root: FakeElement) => root.all().find((e) => e.attributes.role === 'status')?.textContent ?? '';

/** La direction, sur l'écran du réseau, sous « Engagements de service ». */
async function desk(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  (document as { body?: FakeElement }).body = new FakeElement('body');
  const calls: Call[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/gagner/engagements': ok([]),
    'GET /v1/panneaux': STOCK,
    'POST /v1/panneaux/stock': ok({ numbers: [13, 14, 15] }),
    'POST /v1/panneaux/poses/p2/retrait': ok(null),
    ...answers,
  };
  const ctx = context('direction', table, calls, document);
  runInNewContext(JS, ctx);
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    (listeners as Record<string, ((e: unknown) => void) | undefined>).click?.({ target: b });
    b.listeners.click!({});
    await settle();
  };
  await click(els['engagements-voir']);
  runInNewContext(ENGAGEMENTS_SCRIPT, ctx);
  scriptsOf(els.reseau!, '/app/engagements.js')[0]!.listeners.load!({});
  await settle();
  const part = () => els['engagements-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Stock de panneaux')!;
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const set = (size: string, count: string) => {
    input('panneau-format').value = size;
    input('panneau-nombre').value = count;
  };
  const open = async () => {
    await click(btn(part(), 'Ouvrir le stock'));
    const s = scriptsOf(part(), '/app/panneaux.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(PANNEAUX_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const gets = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/v1/panneaux'));
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/v1/panneaux'));
  return { els, table, part, open, click, set, gets, posts, status: () => statusOf(part()), button: (t: string) => btn(part(), t), texts: () => part().textContent };
}

describe('BR105 · le stock de panneaux pour la direction', () => {
  it('[R201] un bloc sous les engagements, le script servi à part chargé au seul geste ; budgets tenus, sans innerHTML', async () => {
    expect(AGENT_APP_SHELL).not.toContain('/app/panneaux.js');
    expect(JS).not.toContain('/v1/panneaux');
    expect(PANNEAUX_SCRIPT).not.toContain('innerHTML');
    expect(budgetProblems({ html: '', js: PANNEAUX_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: ENGAGEMENTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    const d = await desk();
    expect(d.part()).toBeDefined();
    expect(scriptsOf(d.part(), '/app/panneaux.js')).toHaveLength(0);
    expect(d.gets()).toHaveLength(0);
    await d.open();
    expect(d.gets()).toEqual([{ method: 'GET', url: '/v1/panneaux', body: null }]);
    // Un second geste relit, sans recharger le script.
    await d.open();
    expect(scriptsOf(d.part(), '/app/panneaux.js')).toHaveLength(1);
    expect(d.gets()).toHaveLength(2);
  });

  it('[R284] les comptes par format, l’ajout, puis toutes les poses, celles à récupérer d’abord', async () => {
    const d = await desk();
    await d.open();
    const t = d.texts();
    expect(t).toContain('Stock du réseau : 9 panneaux en stock, 2 posés, dont 1 à récupérer, 1 perdu.');
    expect(t).toContain('Grand format : 4 en stock, 1 posé.');
    expect(t).toContain('Format moyen : 3 en stock, 0 posé.');
    expect(t).toContain('Petit format : 2 en stock, 1 posé.');
    expect(d.part().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent)).toEqual(['Ajouter au stock', 'À récupérer', 'Posés']);
    expect(t).toContain('Panneau n° 9, petit format · REF-T-2');
    expect(t).toContain('Panneau n° 7, grand format · REF-T-1');
    expect(d.status()).toBe('2 panneaux posés, dont 1 à récupérer.');
    // La direction tient aussi les poses : récupérer remet au stock.
    const due = d.part().all().find((e) => e.tagName === 'li' && e.textContent.includes('n° 9'))!;
    await d.click(btn(due, 'Récupéré'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/panneaux/poses/p2/retrait', body: { outcome: 'recupere' } }]);
  });

  it('[R282] l’ajout envoie le format et le nombre, dit les numéros à écrire, puis relit', async () => {
    const d = await desk();
    await d.open();
    d.set('grand', ' 3 ');
    await d.click(d.button('Ajouter au stock'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/panneaux/stock', body: { size: 'grand', count: 3 } }]);
    expect(d.gets()).toHaveLength(2);
    expect(d.status()).toContain('3 panneaux grand format ajoutés au stock. Écrivez sur chacun son numéro : 13, 14, 15.');
    // Un seul panneau, et les numéros mal formés tus.
    d.table['POST /v1/panneaux/stock'] = ok({ numbers: [16, -1, 2.5, 'x', INJECTED, null] });
    d.set('petit', '1');
    await d.click(d.button('Ajouter au stock'));
    expect(d.status()).toContain('1 panneau petit format ajouté au stock. Écrivez sur le panneau son numéro : 16.');
    expect(d.status()).not.toContain('-1');
    expect(d.status()).not.toContain('2.5');
    d.table['POST /v1/panneaux/stock'] = ok({ numbers: 'x' });
    // La liste relue redessine le formulaire, vide.
    d.set('petit', '1');
    await d.click(d.button('Ajouter au stock'));
    expect(d.status()).toBe('1 panneau petit format ajouté au stock. 2 panneaux posés, dont 1 à récupérer.');
  });

  it('[R282] format ou nombre mal formés refusés avant l’appel', async () => {
    const d = await desk();
    await d.open();
    for (const [size, count, said] of [
      ['', '3', PANNEAUX_FORM.size],
      ['geant', '3', PANNEAUX_FORM.size],
      ['__proto__', '3', PANNEAUX_FORM.size],
      ['moyen', '', PANNEAUX_FORM.count],
      ['moyen', '0', PANNEAUX_FORM.count],
      ['moyen', '51', PANNEAUX_FORM.count],
      ['moyen', '100', PANNEAUX_FORM.count],
      ['moyen', '2,5', PANNEAUX_FORM.count],
      ['moyen', '-2', PANNEAUX_FORM.count],
    ] as const) {
      d.set(size, count);
      await d.click(d.button('Ajouter au stock'));
      expect(d.status()).toBe(said);
    }
    expect(d.posts()).toHaveLength(0);
    d.set('moyen', '50');
    await d.click(d.button('Ajouter au stock'));
    expect(d.posts()).toEqual([{ method: 'POST', url: '/v1/panneaux/stock', body: { size: 'moyen', count: 50 } }]);
  });

  it('[R16] refus du serveur dits en mots, jamais un code', async () => {
    for (const code of ['bad_size', 'bad_count', 'role', 'non_range'] as const) {
      const d = await desk({ 'POST /v1/panneaux/stock': no(code === 'role' ? 403 : 409, { ok: false, rule: code === 'role' ? 'R16' : 'R282', code }) });
      await d.open();
      d.set('grand', '2');
      await d.click(d.button('Ajouter au stock'));
      expect(d.status()).toBe(PANNEAUX_REFUSALS[code]);
      expect(d.status()).not.toContain(code);
    }
    const d = await desk({ 'POST /v1/panneaux/stock': no(409, { ok: false, rule: 'R282', code: 'jamais_vu' }) });
    await d.open();
    d.set('grand', '2');
    await d.click(d.button('Ajouter au stock'));
    expect(d.status()).toBe('Le geste n’a pas pu être noté. Réessayez dans un moment.');
    const r = await desk({ 'GET /v1/panneaux': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await r.open();
    expect(r.status()).toBe(PANNEAUX_REFUSALS.role);
  });

  it('un seul envoi à la fois ; une écriture sans réponse est dite incertaine, relue, jamais renvoyée seule', async () => {
    let release: (r: Response) => void = () => undefined;
    const d = await desk({ 'POST /v1/panneaux/stock': () => new Promise<Response>((r) => { release = r; }) });
    await d.open();
    d.set('grand', '2');
    await d.click(d.button('Ajouter au stock'));
    await d.click(d.button('Ajouter au stock'));
    expect(d.posts()).toHaveLength(1);
    // Rouvrir pendant l'envoi ne relâche rien et ne relit pas.
    await d.click(d.button('Ouvrir le stock'));
    expect(d.gets()).toHaveLength(1);
    release(Response.json({ ok: true, mode: 'essai', data: { numbers: [20, 21] } }));
    await settle();
    expect(d.status()).toContain('Écrivez sur chacun son numéro : 20, 21.');
    expect(d.gets()).toHaveLength(2);

    const u = await desk({ 'POST /v1/panneaux/stock': cut });
    await u.open();
    u.set('moyen', '4');
    await u.click(u.button('Ajouter au stock'));
    expect(u.posts()).toHaveLength(1);
    expect(u.gets()).toHaveLength(2);
    expect(u.status()).toContain(PANNEAUX_UNSURE);
    const f = await desk({ 'POST /v1/panneaux/stock': no(502, null) });
    await f.open();
    f.set('moyen', '4');
    await f.click(f.button('Ajouter au stock'));
    expect(f.posts()).toHaveLength(1);
    expect(f.status()).toContain(PANNEAUX_UNSURE);
    expect(PANNEAUX_BUSY).toContain('part encore');
  });

  it('[R13] le texte reçu est posé en texte', async () => {
    const d = await desk({ 'GET /v1/panneaux': ok({ counts: COUNTS, placed: [{ ...POSE, reference: INJECTED, address: { ...ADDRESS, street: INJECTED } }] }) });
    await d.open();
    expect(d.texts()).toContain(INJECTED);
    expect(d.part().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('l’accueil de l’agent ne propose pas l’ajout au stock', async () => {
    const { els, listeners, document } = fakeDocument(pageIds(HTML));
    const calls: Call[] = [];
    const ctx = context('agent', { 'GET /v1/panneaux': STOCK }, calls, document);
    runInNewContext(JS, ctx);
    listeners.DOMContentLoaded!();
    await settle();
    const block = els['remises-accueil']!.children.find((e) => e.tagName === 'section' && btn(e, 'Mes panneaux'))!;
    btn(block, 'Mes panneaux')!.listeners.click!({});
    await settle();
    runInNewContext(PANNEAUX_SCRIPT, ctx);
    scriptsOf(els.fiche!, '/app/panneaux.js')[0]!.listeners.load!({});
    await settle();
    expect(block.textContent).toContain('Stock du réseau');
    expect(btn(block, 'Ajouter au stock')).toBeUndefined();
    expect(block.all().some((e) => e.attributes.id === 'panneau-format')).toBe(false);
    expect(calls.some((c) => c.url === '/v1/panneaux/stock')).toBe(false);
  });
});
