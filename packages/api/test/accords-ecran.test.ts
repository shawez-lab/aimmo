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

describe('AC03 · noter et retirer un accord depuis la fiche', () => {
  const fill = (a: Awaited<ReturnType<typeof openedFiche>>, over: Record<string, string> = {}) => {
    a.byLabel('Sujet').value = over.purpose ?? 'rappel_demande';
    a.byLabel('Canal').value = over.channel ?? 'phone';
    a.byLabel('Donné le').value = over.day ?? '2026-10-01';
    a.byLabel('Comment elle l’a donné').value = over.proof ?? 'Elle me l’a demandé de vive voix à l’agence.';
  };

  it('[R03] [R202] l’agent note une demande de rappel : le jour seul part, puis la fiche est relue', async () => {
    const a = await openedFiche(FICHE, { '/v1/fiches/p-1/accords': ok({ consentId: 'c-3', already: false }) });
    // Rien de présélectionné : sujet, canal et jour sont à choisir.
    expect(a.byLabel('Sujet').value).toBe('');
    expect(a.byLabel('Canal').value).toBe('');
    expect(a.byLabel('Donné le').value).toBe('');
    fill(a);
    const before = a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume').length;
    a.named(a.body, 'Noter l’accord')[0]!.listeners.click!({});
    await a.tick();
    const post = a.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v1/fiches/p-1/accords');
    // Aucune heure du téléphone n'est envoyée.
    expect(post.body).toEqual({ purpose: 'rappel_demande', channel: 'phone', proof: 'Elle me l’a demandé de vive voix à l’agence.', givenOn: '2026-10-01' });
    expect(a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume').length).toBe(before + 1);
  });

  it('[R202] un double clic n’envoie qu’une demande', async () => {
    const a = await openedFiche(FICHE, { '/v1/fiches/p-1/accords': ok({ consentId: 'c-3', already: false }) });
    fill(a);
    const note = a.named(a.body, 'Noter l’accord')[0]!;
    note.listeners.click!({});
    note.listeners.click!({});
    await a.tick();
    expect(a.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('[R202] déjà noté : l’écran le dit, la preuve tapée n’est pas perdue en silence', async () => {
    const a = await openedFiche(FICHE, { '/v1/fiches/p-1/accords': ok({ consentId: 'c-1', givenAt: '2026-10-01T10:00:00.000Z', already: true }) });
    fill(a);
    a.named(a.body, 'Noter l’accord')[0]!.listeners.click!({});
    await a.tick();
    expect(a.body.textContent).toContain('Déjà noté, le 01/10/2026 : la nouvelle preuve n’est pas rangée.');
    expect(a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume')).toHaveLength(1);
  });

  it('[R03] le retrait vise l’accord en cours ; un accord déjà retiré n’a pas de bouton', async () => {
    const a = await openedFiche(FICHE, { '/v1/fiches/p-1/accords/c-1/retrait': ok({ consentId: 'c-1', withdrawnAt: '2026-11-02T10:00:00.000Z' }) });
    const withdraw = a.named(a.body, 'Retirer cet accord');
    expect(withdraw).toHaveLength(1);
    expect(a.body.textContent).toContain('Retiré le');
    withdraw[0]!.listeners.click!({});
    await a.tick();
    expect(a.calls.find((c) => c.method === 'POST')!.url).toBe('/v1/fiches/p-1/accords/c-1/retrait');
    expect(a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume')).toHaveLength(2);
  });

  it('[R04] une personne arrêtée n’a pas de formulaire, mais un accord reste retirable', async () => {
    const a = await openedFiche({ ...FICHE, contact: { allowed: false, reasons: ['stop'] }, callRefusal: 'excluded' });
    expect(a.named(a.body, 'Noter l’accord')).toEqual([]);
    expect(a.named(a.body, 'Retirer cet accord')).toHaveLength(1);
  });

  it.each([
    ['bad_proof', 'R202', 400, 'Écrivez comment la personne a donné son accord'],
    ['given_before_withdrawal', 'R03', 409, 'il faut un accord donné après le retrait'],
  ])('[R202] le refus %s se dit en français, sans code, et le formulaire reste rempli', async (code, rule, status, text) => {
    const a = await openedFiche(FICHE, { '/v1/fiches/p-1/accords': async () => Response.json({ ok: false, rule, code }, { status }) });
    fill(a, { proof: 'court' });
    a.named(a.body, 'Noter l’accord')[0]!.listeners.click!({});
    await a.tick();
    expect(a.body.textContent).toContain(text);
    expect(a.body.textContent).not.toContain(code);
    expect(a.byLabel('Comment elle l’a donné').value).toBe('court');
    expect(a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume')).toHaveLength(1);
  });

  it.each([
    ['stopped', 'R04', 409, 'a demandé l’arrêt'],
    ['not_assigned', 'R16', 403, 'suivi par un autre agent'],
  ])('[R04] [R16] le refus %s dit que la fiche a changé : elle est relue, le message reste', async (code, rule, status, text) => {
    const a = await openedFiche(FICHE, { '/v1/fiches/p-1/accords': async () => Response.json({ ok: false, rule, code }, { status }) });
    fill(a);
    a.named(a.body, 'Noter l’accord')[0]!.listeners.click!({});
    await a.tick();
    expect(a.calls.filter((c) => c.url === '/v1/fiches/p-1/resume')).toHaveLength(2);
    expect(a.els['fiche-etat']!.textContent).toContain(text);
  });

  it('un jour non choisi passe au serveur, qui le refuse ; sans réseau, l’écran le dit', async () => {
    const a = await openedFiche(FICHE, { '/v1/fiches/p-1/accords': async () => Response.json({ ok: false, rule: 'R202', code: 'bad_date' }, { status: 400 }) });
    fill(a, { day: '' });
    a.named(a.body, 'Noter l’accord')[0]!.listeners.click!({});
    await a.tick();
    expect(a.body.textContent).toContain('Choisissez le jour où la personne l’a donné.');
    const b = await openedFiche(FICHE);
    fill(b);
    b.named(b.body, 'Noter l’accord')[0]!.listeners.click!({});
    await b.tick();
    expect(b.body.textContent).toContain('Pas de réseau : rien n’est enregistré.');
  });
});
