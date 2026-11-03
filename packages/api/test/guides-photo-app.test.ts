import { runInNewContext } from 'node:vm';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { describe, expect, it } from 'vitest';
import { GUIDES_PHOTO_SCRIPT } from '../app/guides-photo.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const LIST = '/v1/studio/guides-a-valider';
const VALIDATE = '/v1/studio/biens/b-1/guide/validation';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, code: string, rule: string | null = null): Answer => async () => Response.json({ ok: false, rule, code }, { status });
const offline: Answer = () => Promise.reject(new TypeError('hors ligne'));
const INJECTED = '<img src=x onerror=alert(1)>';
const ONE = { items: [{ propertyId: 'b-1', reference: 'REF-1', city: 'Villebrune', views: ['Entrée', 'Séjour'] }], more: false };
const NONE = { items: [], more: false };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(lists: Answer[] = [ok(ONE)], posts: Answer[] = []) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string }[] = [];
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url });
      if (url === '/v1/moi') return ok({ role: 'direction', firstName: null })();
      if (url === LIST) return (lists.length > 1 ? lists.shift()! : lists[0] ?? offline)();
      if (url === VALIDATE) return (posts.shift() ?? offline)();
      return offline();
    },
    Intl,
    Date,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['guides-photo-corps']!;
  const state = () => els['guides-photo-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const buttons = () => body().all().filter((e) => e.tagName === 'button' && e.textContent === 'Valider ce guide');
  const scripts = () => els.reseau!.children.filter((e: FakeElement) => e.attributes.src === '/app/guides-photo.js');
  const open = async () => {
    els['guides-photo-voir']!.listeners.click!({});
    await settle();
    if (scripts().length === 1 && !context.LOADED) {
      context.LOADED = true;
      runInNewContext(GUIDES_PHOTO_SCRIPT, context);
      scripts()[0]!.listeners.load!({});
      await settle();
    }
  };
  const press = async () => {
    buttons()[0]!.listeners.click!({});
    await settle();
  };
  const sent = () => calls.filter((c) => c.method === 'POST' && c.url === VALIDATE);
  return { els, calls, state, texts, buttons, scripts, open, press, sent };
}

describe('X23 · les guides photo à valider', () => {
  it('[R201] rien n’est demandé avant le geste ; script à part dans son budget, application dans le sien', async () => {
    const t = await run();
    expect(t.calls.some((c) => c.url === LIST)).toBe(false);
    expect(t.scripts()).toHaveLength(0);
    expect(JS).not.toContain('/guide/validation');
    expect(AGENT_APP_FILES['/app/guides-photo.js']).toBe(GUIDES_PHOTO_SCRIPT);
    expect(budgetProblems({ html: '', js: GUIDES_PHOTO_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(GUIDES_PHOTO_SCRIPT).not.toContain('innerHTML');
  });

  it('la liste dit le bien et ses vues, en texte ; vide, elle le dit ; le reste à regarder aussi', async () => {
    const t = await run([ok({ items: [{ propertyId: 'b-1', reference: INJECTED, city: null, views: ['Entrée'] }], more: true })]);
    await t.open();
    expect(t.texts()).toContain(INJECTED);
    expect(t.texts()).toContain('1 photo(s) retenue(s) : Entrée.');
    expect(t.texts()).toContain('D’autres biens restent à regarder');
    const vide = await run([ok(NONE)]);
    await vide.open();
    expect(vide.texts()).toContain('Aucun guide à valider.');
    expect(vide.buttons()).toHaveLength(0);
  });

  it('[R17] valider part une fois, sans corps, puis la liste est relue', async () => {
    const t = await run([ok(ONE), ok(NONE)], [ok({ ready: true, validated: { by: 'direction:d', at: '2027-01-01T00:00:00.000Z' } })]);
    await t.open();
    await t.press();
    expect(t.sent()).toHaveLength(1);
    expect(t.state()).toBe('Guide validé.');
    expect(t.texts()).toContain('Aucun guide à valider.');
  });

  it('[R16] les droits refusés sont dits, à la lecture et à la validation', async () => {
    const lu = await run([no(403, 'role', 'R16')]);
    await lu.open();
    expect(lu.state()).toBe('Réservé à la direction.');
    const valide = await run([ok(ONE)], [no(403, 'not_assigned', 'R16')]);
    await valide.open();
    await valide.press();
    expect(valide.state()).toBe('Réservé à la direction.');
  });

  it('[R10] une réponse perdue ou une panne est dite telle ; un second appui ne range rien de plus', async () => {
    const t = await run([ok(ONE)], [offline, no(500, 'internal'), ok({ ready: true })]);
    await t.open();
    await t.press();
    expect(t.state()).toContain('La réponse n’est pas arrivée : rien n’est sûr.');
    await t.press();
    expect(t.state()).toContain('La réponse n’est pas arrivée : rien n’est sûr.');
    await t.press();
    expect(t.state()).toBe('Guide validé.');
    expect(t.sent()).toHaveLength(3);
  });

  it('[R10] un guide qui n’est plus prêt est dit, et la liste est relue', async () => {
    const t = await run([ok(ONE), ok(NONE)], [no(409, 'pas_pret', 'R10')]);
    await t.open();
    await t.press();
    expect(t.state()).toBe('Ce guide n’est plus prêt : une vue a changé. Rien n’est validé.');
    expect(t.texts()).toContain('Aucun guide à valider.');
  });

  it('un double appui n’envoie qu’une fois', async () => {
    let release: (r: Response) => void = () => {};
    const t = await run([ok(ONE), ok(NONE)], [() => new Promise<Response>((r) => { release = r; })]);
    await t.open();
    const b = t.buttons()[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await settle();
    expect(t.sent()).toHaveLength(1);
    release(Response.json({ ok: true, data: { ready: true } }));
    await settle();
    expect(t.state()).toBe('Guide validé.');
  });

  it('[R10] un script manquant est dit, et un nouvel appui réessaie', async () => {
    const t = await run();
    t.els['guides-photo-voir']!.listeners.click!({});
    await settle();
    t.scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    t.els['guides-photo-voir']!.listeners.click!({});
    await settle();
    expect(t.scripts()).toHaveLength(2);
  });

  it('[R16] une liste qui arrive après la déconnexion n’écrit rien', async () => {
    let release: (r: Response) => void = () => {};
    const t = await run([() => new Promise<Response>((r) => { release = r; })]);
    await t.open();
    t.els.sortir!.listeners.click!({});
    await settle();
    release(Response.json({ ok: true, data: ONE }));
    await settle();
    expect(t.buttons()).toHaveLength(0);
    expect(t.state()).toBe('');
  });
});
