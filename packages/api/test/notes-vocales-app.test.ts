import { runInNewContext } from 'node:vm';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { NOTES_VOCALES_SCRIPT, NOTES_VOCALES_TEXT_MAX } from '../app/notes-vocales.ts';
import { NOTES_VOCALES_REFUSALS } from '../src/appels.ts';
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
  const byLabel = (label: string): FakeElement => {
    const l = body.all().find((e) => e.tagName === 'label' && e.textContent.startsWith(label))!;
    return body.all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  return { els, body, calls, tick, named, byLabel, routes, context };
}



const ROUTE = '/v1/fiches/p-1/notes-vocales';
type A = Awaited<ReturnType<typeof openedFiche>>;
const scripts = (a: A) => a.els.fiche!.children.filter((e) => e.attributes.src === '/app/notes-vocales.js');
const part = (a: A) => a.body.all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Notes vocales')!;
const said = (a: A) => part(a).all().find((e) => e.attributes.role === 'status')!.textContent;
const texts = (a: A) => part(a).all().map((e) => e.textContent);
const open = async (answer: () => Promise<Response>) => {
  const a = await openedFiche(FICHE, { [ROUTE]: answer });
  a.named(a.body, 'Notes vocales')[0]!.listeners.click!({});
  await a.tick();
  runInNewContext(NOTES_VOCALES_SCRIPT, a.context);
  scripts(a)[0]!.listeners.load!({});
  await a.tick();
  return a;
};

const NOTE = {
  id: 'v1',
  receivedAt: '2026-12-08T09:00:00.000Z',
  channel: 'whatsapp',
  transcript: 'Je souhaite vendre ma maison à Talant rapidement.',
  language: 'fr',
  confidence: 0.934,
  hasAudio: true,
};

describe('BR62 · les notes vocales dans la fiche', () => {
  it('[R201] servi à part, chargé au geste ; rien n’est lu avant ; le budget tient ; aucun innerHTML', async () => {
    const a = await openedFiche(FICHE);
    expect(a.calls.some((c) => c.url === ROUTE)).toBe(false);
    expect(scripts(a)).toEqual([]);
    expect(AGENT_APP_FILES['/app/notes-vocales.js']).toBe(NOTES_VOCALES_SCRIPT);
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain("/notes-vocales', 'GET'");
    expect(NOTES_VOCALES_SCRIPT).not.toContain('innerHTML');
    expect(budgetProblems({ html: '', js: NOTES_VOCALES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']! }, BUDGETS.application)).toEqual([]);
  });

  it('[R240] chaque note est dite comme une transcription, avec sa langue et sa sûreté ; l’audio n’est pas lié', async () => {
    const a = await open(ok([NOTE, { ...NOTE, id: 'v2', channel: 'instagram', language: 'en', confidence: 0.7, hasAudio: false, transcript: 'I want to buy a flat.' }]));
    expect(a.calls.filter((c) => c.url === ROUTE).map((c) => c.method)).toEqual(['GET']);
    const all = texts(a);
    expect(all.some((x) => /^Note vocale reçue par WhatsApp, le .+ à .+$/.test(x))).toBe(true);
    expect(all).toContain('« Je souhaite vendre ma maison à Talant rapidement. »');
    expect(all).toContain('Transcription automatique, pas les mots écrits par la personne ; parlé en français ; sûre à 93\u00a0%.');
    expect(all).toContain('L’audio d’origine reste chez WhatsApp.');
    expect(all).toContain('Transcription automatique, pas les mots écrits par la personne ; parlé en anglais ; sûre à 70\u00a0%.');
    expect(all.filter((x) => x.startsWith('L’audio')).length).toBe(1);
    expect(said(a)).toBe('');
  });

  it('[R201] un champ mal formé est tu : canal inconnu, texte trop long, langue ou sûreté hors forme', async () => {
    const long = 'a'.repeat(NOTES_VOCALES_TEXT_MAX);
    const a = await open(
      ok([
        { ...NOTE, id: 'v3', channel: 'sms' },
        { ...NOTE, id: 'v4', transcript: long + 'a' },
        { ...NOTE, id: 'v5', transcript: long, language: 'xx-YY<', confidence: 7 },
        { ...NOTE, id: 'v6', transcript: 'Bonjour', language: 'sw', confidence: null },
        'pas un objet',
      ]),
    );
    const all = texts(a);
    expect(part(a).all().filter((e) => e.tagName === 'h4').length).toBe(2);
    expect(all).toContain('« ' + long + ' »');
    expect(all).toContain('Transcription automatique, pas les mots écrits par la personne.');
    expect(all).toContain('Transcription automatique, pas les mots écrits par la personne ; parlé en langue « sw ».');
  });

  it('[R16] un refus est dit en mots, jamais un code ; hors ligne et aucune note sont dits', async () => {
    const a = await open(async () => Response.json({ ok: false, rule: 'R16', code: 'not_assigned', message: NOTES_VOCALES_REFUSALS['not_assigned'] }, { status: 403 }));
    expect(said(a)).toBe(NOTES_VOCALES_REFUSALS['not_assigned']);
    const b = await open(async () => Promise.reject(new TypeError('hors ligne')));
    expect(said(b)).toBe('Pas de réseau. Réessayez dans un moment.');
    const c = await open(ok([]));
    expect(said(c)).toBe('Aucune note vocale reçue de cette personne.');
    const d = await open(async () => new Response('panne', { status: 500 }));
    expect(said(d)).toBe('Les notes vocales ne se lisent pas pour le moment.');
  });

  it('[R201] un texte reçu est posé en texte', async () => {
    const a = await open(ok([{ ...NOTE, transcript: '<img src=x onerror=alert(1)>' }]));
    expect(part(a).all().find((e) => e.textContent === '« <img src=x onerror=alert(1)> »')).toBeDefined();
    expect(part(a).all().some((e) => e.tagName === 'img')).toBe(false);
  });
});
