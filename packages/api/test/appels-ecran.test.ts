import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { APPELS_SCRIPT } from '../app/appels.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
type Call = { url: string; method: string; body: Record<string, unknown> | null };
const ok = (data: unknown) => async () => Response.json({ ok: true, mode: 'essai', data });
const FICHE = { personId: 'p-1', firstName: 'Client', lastName: 'Inventé', contact: { allowed: true, reasons: [] }, call: 'tel:+33600000004', callRefusal: null, callClosesAt: null, callReopensAt: null, projects: [], sources: [], consents: [], messages: [], callbacks: [] };
const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: 'p-1', firstName: 'Client', kind: 'callback', reason: 'À rappeler', order: 'règle', legalBasis: 'demande' }] };

async function opened(fiche: Record<string, unknown>, answers: Record<string, () => Promise<Response>> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: Call[] = [];
  const routes: Record<string, () => Promise<Response>> = {
    '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
    '/v1/plan-du-jour': ok(PLAN),
    '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
    '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
    '/v1/fiches/p-1/resume': ok(fiche),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    Date,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
      const answer = routes[url];
      return answer ? answer() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, context);
  listeners.DOMContentLoaded!();
  const tick = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  const named = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  named(els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
  await tick();
  const body = els['fiche-corps']!;
  const scripts = () => body.all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/appels.js');
  const load = async () => {
    const s = scripts();
    runInNewContext(APPELS_SCRIPT, context);
    for (const e of s) e.listeners.load!({});
    await tick();
  };
  return { els, body, calls, tick, named, scripts, load, routes };
}

describe('AC12 · les gestes d’appel de la fiche', () => {
  it('[R204] [R201] « J’ai appelé » part une fois, sans heure ni numéro, puis la fiche est relue et le dit', async () => {
    const a = await opened(FICHE, { '/v1/fiches/p-1/appels': ok({ noteId: 'n-1', notedAt: '2026-11-10T09:00:00.000Z', already: false }) });
    await a.load();
    const before = a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume').length;
    const b = a.named(a.body, 'J’ai appelé')[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await a.tick();
    const posts = a.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: '/v1/fiches/p-1/appels', body: { outcome: 'called' } });
    expect(Object.keys(posts[0]!.body!)).toEqual(['outcome']);
    expect(a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume').length).toBe(before + 1);
    expect(a.els['fiche-etat']!.textContent).toBe('Appel noté.');
  });

  it('[R204] « La personne a refusé » : l’écran relu ferme l’appel et dit quand il rouvre', async () => {
    const closed = { ...FICHE, call: null, callRefusal: 'refused_recently', callReopensAt: '2027-02-08T09:00:00.000Z' };
    const a = await opened(FICHE, { '/v1/fiches/p-1/appels': ok({ noteId: 'n-1', notedAt: '2026-11-10T09:00:00.000Z', already: false }) });
    await a.load();
    a.routes['/v1/fiches/p-1/resume'] = ok(closed);
    a.named(a.body, 'La personne a refusé')[0]!.listeners.click!({});
    await a.tick();
    expect(a.calls.find((c) => c.method === 'POST')!.body).toEqual({ outcome: 'refused' });
    expect(a.body.textContent).toContain('Appel fermé : la personne a refusé. Il rouvre le 08/02/2027 à 10:00.');
    expect(a.body.all().filter((e) => e.tagName === 'a')).toHaveLength(0);
    expect(a.els['fiche-etat']!.textContent).toBe('Refus noté.');
    // Bouton fermé, les gestes restent : un fait se note. Le script n'est pas rechargé.
    expect(a.named(a.body, 'J’ai appelé')).toHaveLength(1);
    expect(a.scripts()).toHaveLength(0);
  });

  it('[R204] trop d’appels : l’écran le dit, avec la date ; ce n’est jamais « aucun numéro »', async () => {
    const a = await opened({ ...FICHE, call: null, callRefusal: 'too_many_calls', callReopensAt: '2026-12-10T10:30:00.000Z' });
    expect(a.body.textContent).toContain('Appel fermé : trop d’appels récents. Il rouvre le 10/12/2026 à 11:30.');
    expect(a.body.textContent).not.toContain('Aucun numéro');
    await a.load();
    expect(a.named(a.body, 'J’ai appelé')).toHaveLength(1);
  });

  it('[R204] refus sur une fiche qui n’a qu’une demande : l’écran dit le refus, pas l’absence d’accord, et les gestes restent', async () => {
    const a = await opened({ ...FICHE, call: null, callRefusal: 'refused_request', callReopensAt: null });
    expect(a.body.textContent).toContain('Appel fermé : la personne a refusé. Il ne rouvre que si elle redemande à être rappelée.');
    expect(a.body.textContent).not.toContain('aucun accord');
    await a.load();
    expect(a.named(a.body, 'J’ai appelé')).toHaveLength(1);
  });

  it('[R02] [R04] personne exclue, sans numéro : pas de geste ni de script', async () => {
    const stopped = await opened({ ...FICHE, call: null, callRefusal: 'excluded', contact: { allowed: false, reasons: ['stop'] } });
    expect(stopped.scripts()).toHaveLength(0);
    const none = await opened({ ...FICHE, call: null, callRefusal: 'no_phone' });
    expect(none.scripts()).toHaveLength(0);
    expect(none.body.textContent).toContain('Aucun numéro');
  });

  it('[R204] déjà noté : l’écran le dit, sans relire ; sans réseau, rien n’est noté et il le dit ; un refus se dit', async () => {
    const a = await opened(FICHE, { '/v1/fiches/p-1/appels': ok({ noteId: 'n-1', notedAt: '2026-11-10T09:00:00.000Z', already: true }) });
    await a.load();
    a.named(a.body, 'J’ai appelé')[0]!.listeners.click!({});
    await a.tick();
    expect(a.body.textContent).toContain('Déjà noté à l’instant.');
    expect(a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume')).toHaveLength(1);

    const off = await opened(FICHE);
    await off.load();
    off.named(off.body, 'La personne a refusé')[0]!.listeners.click!({});
    await off.tick();
    expect(off.body.textContent).toContain('La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.');

    const moved = await opened(FICHE, { '/v1/fiches/p-1/appels': async () => Response.json({ ok: false, rule: 'R16', code: 'not_assigned' }, { status: 403 }) });
    await moved.load();
    moved.routes['/v1/fiches/p-1/resume'] = async () => Response.json({ ok: false, code: 'not_assigned' }, { status: 403 });
    moved.named(moved.body, 'J’ai appelé')[0]!.listeners.click!({});
    await moved.tick();
    expect(moved.els['fiche-etat']!.textContent).toBe('Ce client est suivi par un autre agent.');
  });

  it('[R201] script perdu : l’écran le dit, le bouton d’appel reste ; un refus de demande ancienne a son texte', async () => {
    const a = await opened(FICHE);
    a.scripts()[0]!.listeners.error!({});
    expect(a.body.textContent).toContain('Pas de réseau : les gestes d’appel reviendront.');
    expect(a.body.all().filter((e) => e.tagName === 'a')).toHaveLength(1);
    // DS010 · ce texte est dans la fiche servie à part, avec le bloc des accords.
    expect(AGENT_APP_FILES['/app/fiche.js']).toContain('given_before_refusal');
  });

  it('[R201] le script est servi à part, hors de la coquille, et tient le budget d’une page', async () => {
    expect(AGENT_APP_SHELL).not.toContain('/app/appels.js');
    expect(budgetProblems({ html: '', js: APPELS_SCRIPT }, BUDGETS.page)).toEqual([]);
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/appels.js'))!;
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(await served.text()).toBe(APPELS_SCRIPT);
  });
});
