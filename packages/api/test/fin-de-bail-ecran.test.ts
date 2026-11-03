import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
type Call = { url: string; method: string; body: Record<string, unknown> | null };
const ok = (data: unknown) => async () => Response.json({ ok: true, mode: 'essai', data });
const FICHE = {
  personId: 'p-1',
  firstName: 'Client',
  lastName: 'Inventé',
  contact: { allowed: true, reasons: [] },
  call: null,
  callRefusal: 'no_consent',
  callClosesAt: null,
  projects: [],
  sources: [],
  consents: [
    { id: 'c-1', purpose: 'suivi_vente', channel: 'email', givenAt: '2026-10-01T10:00:00.000Z', withdrawnAt: null },
    { id: 'c-2', purpose: 'suivi_location', channel: 'email', givenAt: '2026-09-01T10:00:00.000Z', withdrawnAt: '2026-09-15T10:00:00.000Z' },
  ],
  messages: [],
  callbacks: [],
};
const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: 'p-1', firstName: 'Client', kind: 'callback', reason: 'À rappeler', order: 'règle 1', basis: { kind: 'request', since: '2026-11-01', purpose: null }, projectId: null }], removed: { excluded: 0, withdrawn: 0, noBasis: 0 }, hiddenSinceFrozen: 0 };

async function openedFiche(fiche: Record<string, unknown>, answers: Record<string, () => Promise<Response>> = {}) {
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
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
    document,
    Date,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
      const answer = routes[url];
      return answer ? answer() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  const tick = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  const named = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  named(els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
  await tick();
  const body = els['fiche-corps']!;
  const byLabel = (label: string): FakeElement => {
    const l = body.all().find((e) => e.tagName === 'label' && e.textContent.startsWith(label))!;
    return body.all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  return { els, body, calls, tick, named, byLabel };
}

describe('G15 · la fin de bail notée depuis la fiche', () => {
  const PATH = '/v1/gagner/fiches/p-1/fin-de-bail';
  const posts = (a: Awaited<ReturnType<typeof openedFiche>>) => a.calls.filter((c) => c.method === 'POST' && c.url === PATH);
  const said = (a: Awaited<ReturnType<typeof openedFiche>>) => a.body.all().filter((e) => e.tagName === 'p' && e.attributes.role === 'status').map((e) => e.textContent).join('');
  const press = async (a: Awaited<ReturnType<typeof openedFiche>>) => {
    a.named(a.body, 'Noter cette date')[0]!.listeners.click!({});
    await a.tick();
  };

  it('[R143] la date part telle quelle, et rien n’est envoyé à personne', async () => {
    const a = await openedFiche(FICHE, { [PATH]: ok({ id: 'm1' }) });
    a.byLabel('Date de fin du bail').value = '2027-06-30';
    await press(a);
    expect(posts(a)[0]!.body).toEqual({ onDay: '2027-06-30' });
    expect(said(a)).toContain('Date notée. Rien ne part');
  });

  it('sans date, rien ne part', async () => {
    const a = await openedFiche(FICHE);
    await press(a);
    expect(said(a)).toBe('Choisissez la date.');
    expect(posts(a)).toEqual([]);
  });

  it('[R16] la fiche d’un autre, ou la direction : refus dit ; une date illisible aussi', async () => {
    const a = await openedFiche(FICHE, { [PATH]: async () => Response.json({ ok: false, rule: 'R16', code: 'not_assigned' }, { status: 403 }) });
    a.byLabel('Date de fin du bail').value = '2027-06-30';
    await press(a);
    expect(said(a)).toBe('Réservé à l’agent de cette fiche.');
    const b = await openedFiche(FICHE, { [PATH]: async () => Response.json({ ok: false, rule: null, code: 'bad_day' }, { status: 400 }) });
    b.byLabel('Date de fin du bail').value = '2027-02-31';
    await press(b);
    expect(said(b)).toBe('Cette date n’est pas lisible.');
  });

  it('[R10] une réponse perdue ou une panne n’est dite ni faite ni refusée', async () => {
    const a = await openedFiche(FICHE);
    a.byLabel('Date de fin du bail').value = '2027-06-30';
    await press(a);
    expect(said(a)).toContain('rien n’est sûr');
    const b = await openedFiche(FICHE, { [PATH]: async () => Response.json({ ok: false, code: 'internal' }, { status: 500 }) });
    b.byLabel('Date de fin du bail').value = '2027-06-30';
    await press(b);
    expect(said(b)).toContain('rien n’est sûr');
  });
});
