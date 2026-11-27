import { runInNewContext } from 'node:vm';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { RECLAMATIONS_REFUSALS, RECLAMATIONS_SCRIPT } from '../app/reclamations.ts';
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




const LIST = '/v1/securite/reclamations?fiche=p-1';
const RECORD = '/v1/securite/fiches/p-1/reclamations';
type A = Awaited<ReturnType<typeof openedFiche>>;
const scripts = (a: A) => a.els.fiche!.children.filter((e) => e.attributes.src === '/app/reclamations.js');
const part = (a: A) => a.body.all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Réclamations')!;
const said = (a: A) => part(a).all().find((e) => e.attributes.role === 'status')!.textContent;
const texts = (a: A) => part(a).all().map((e) => e.textContent);
const inPart = (a: A, label: string): FakeElement => {
  const l = part(a).all().find((e) => e.tagName === 'label' && e.textContent === label)!;
  return part(a).all().find((e) => e.attributes.id === l.attributes.for)!;
};
const parisDay = (offset = 0): string => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
};
const fr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const open = async (routes: Record<string, () => Promise<Response>>) => {
  const a = await openedFiche(FICHE, routes);
  a.named(a.body, 'Réclamations')[0]!.listeners.click!({});
  await a.tick();
  runInNewContext(RECLAMATIONS_SCRIPT, a.context);
  scripts(a)[0]!.listeners.load!({});
  await a.tick();
  return a;
};
const C = (over: Record<string, unknown> = {}) => ({
  complaintId: 'r1',
  personId: 'p-1',
  agentId: 'a1',
  receivedOn: parisDay(-3),
  receivedBy: 'mail',
  summary: 'Le compte rendu de visite n’est jamais arrivé.',
  responseDays: 30,
  dueOn: parisDay(10),
  status: 'ouverte',
  answer: null,
  alerts: [],
  mediator: null,
  ...over,
});
const click = async (a: A, text: string, i = 0) => {
  a.named(part(a), text)[i]!.listeners.click!({});
  await a.tick();
};

describe('BR69 · les réclamations dans la fiche', () => {
  it('[R201] servi à part, chargé au geste par le chargeur commun ; rien n’est lu avant ; budgets tenus ; aucun innerHTML', async () => {
    const a = await openedFiche(FICHE);
    expect(a.calls.some((c) => c.url.startsWith('/v1/securite'))).toBe(false);
    expect(scripts(a)).toEqual([]);
    expect(AGENT_APP_FILES['/app/reclamations.js']).toBe(RECLAMATIONS_SCRIPT);
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain('/v1/securite');
    // DS010 · la fiche servie à part demande ce bloc au chargeur commun, qui reste dans l'application.
    expect(AGENT_APP_FILES['/app/fiche.js']).toContain("lazyBlock('Réclamations', '/app/reclamations.js', 'AIMMO_RECLAMATIONS', personId)");
    expect(AGENT_APP_FILES['/app/app.js']).toContain('function lazyBlock(');
    expect(RECLAMATIONS_SCRIPT).not.toContain('innerHTML');
    expect(budgetProblems({ html: '', js: RECLAMATIONS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']! }, BUDGETS.application)).toEqual([]);
  });

  it('BR71 · le groupe des fiches réunies est demandé au serveur ; une réclamation d’une fiche réunie est dite comme telle ; un champ mal formé est tu', async () => {
    const a = await open({ [LIST]: ok([C(), C({ complaintId: 'r2', personId: 'p-2', summary: 'Fiche réunie' }), C({ complaintId: 'r4', personId: '<b>', summary: 'Mal formée' })]) });
    expect(a.calls.filter((c) => c.url.startsWith('/v1/securite')).map((c) => [c.url, c.method])).toEqual([[LIST, 'GET']]);
    const all = texts(a);
    expect(all).toContain('« Fiche réunie »');
    expect(all.filter((x) => x === 'Rangée sur une fiche réunie à celle-ci.').length).toBe(1);
    const reunie = part(a).all().filter((e) => e.tagName === 'article')[1]!;
    expect(reunie.all().map((e) => e.textContent)).toContain('Rangée sur une fiche réunie à celle-ci.');
    expect(all.some((x) => x.includes('Mal formée'))).toBe(false);
    expect(part(a).all().filter((e) => e.tagName === 'article').length).toBe(2);
  });

  it('BR71 · une fiche inconnue ou mal formée : le refus est dit en mots, jamais un code', async () => {
    for (const [code, words] of [['unknown_person', 'Cette fiche n’existe plus.'], ['bad_fiche', 'Cette fiche n’est pas lisible.'], ['unexpected_field', 'Cette lecture n’est pas lisible.']]) {
      const a = await open({ [LIST]: async () => Response.json({ ok: false, rule: null, code }, { status: code === 'unknown_person' ? 404 : 400 }) });
      expect(said(a)).toBe(words);
    }
  });

  it('l’échéance est celle de la base, avec les jours qui restent', async () => {
    const a = await open({ [LIST]: ok([C(), C({ complaintId: 'r3', dueOn: parisDay(1), summary: 'Panneau abîmé' })]) });
    const all = texts(a);
    expect(all).toContain(`Réclamation reçue le ${fr(parisDay(-3))} par mail`);
    expect(all).toContain('« Le compte rendu de visite n’est jamais arrivé. »');
    expect(all).toContain(`Réponse attendue au plus tard le ${fr(parisDay(10))} : il reste 10 jours.`);
    expect(all).toContain(`Réponse attendue au plus tard le ${fr(parisDay(1))} : il reste 1 jour.`);
    expect(all).not.toContain('Rangée sur une fiche réunie à celle-ci.');
    expect(part(a).all().filter((e) => e.tagName === 'article').length).toBe(2);
    expect(said(a)).toBe('');
  });

  it('[R606] ranger : date, voie et motif envoyés tels quels ; l’échéance n’est jamais calculée à l’écran mais relue', async () => {
    let list = [] as unknown[];
    const routes = {
      [LIST]: async () => Response.json({ ok: true, mode: 'essai', data: list }),
      [RECORD]: async () => {
        list = [C({ receivedOn: parisDay(-1), receivedBy: 'courrier', summary: 'Retard de réponse', dueOn: parisDay(20) })];
        return Response.json({ ok: true, mode: 'essai', data: list[0] });
      },
    };
    const a = await open(routes);
    expect(said(a)).toBe('Aucune réclamation rangée sur cette fiche.');
    expect(inPart(a, 'Reçue le').value).toBe(parisDay());
    inPart(a, 'Reçue le').value = parisDay(-1);
    inPart(a, 'Arrivée par').value = 'courrier';
    inPart(a, 'Ce que le client reproche').value = 'Retard de réponse';
    await click(a, 'Ranger la réclamation');
    const post = a.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(RECORD);
    expect(post.body).toEqual({ receivedOn: parisDay(-1), receivedBy: 'courrier', summary: 'Retard de réponse' });
    expect(said(a)).toBe('Réclamation rangée.');
    expect(texts(a)).toContain(`Réponse attendue au plus tard le ${fr(parisDay(20))} : il reste 20 jours.`);
    expect(a.calls.filter((c) => c.url === LIST).length).toBe(2);
  });

  it('[R606] la réponse se note une fois : le formulaire disparaît ensuite ; « en retard » est dit ; une échéance passée est dite', async () => {
    let answered = false;
    const routes = {
      [LIST]: async () =>
        Response.json({
          ok: true,
          data: [
            answered
              ? C({ dueOn: parisDay(-2), status: 'non_reglee', answer: { outcome: 'non_reglee', note: 'Geste refusé', answeredOn: parisDay(), late: true } })
              : C({ dueOn: parisDay(-2) }),
          ],
        }),
      '/v1/securite/reclamations/r1/reponse': async () => {
        answered = true;
        return Response.json({ ok: true, data: null });
      },
    };
    const a = await open(routes);
    expect(texts(a)).toContain(`Échéance passée le ${fr(parisDay(-2))} : la réponse sera notée en retard.`);
    expect(texts(a)).toContain('La réponse ne se note qu’une fois.');
    inPart(a, 'Issue').value = 'non_reglee';
    inPart(a, 'Réponse donnée au client').value = 'Geste refusé';
    await click(a, 'Noter la réponse');
    expect(a.calls.find((c) => c.method === 'POST')!.body).toEqual({ outcome: 'non_reglee', note: 'Geste refusé' });
    expect(said(a)).toBe('Réponse notée.');
    expect(texts(a)).toContain(`Non réglée, répondu le ${fr(parisDay())}, en retard.`);
    expect(texts(a)).toContain('« Geste refusé »');
    expect(a.named(part(a), 'Noter la réponse')).toEqual([]);
  });

  it('[R607] médiateur à remettre : texte mot pour mot et bouton ; remis ensuite ; envoyé dit sans bouton', async () => {
    let handed = false;
    const offer = (status: string) => ({ cause: 'echeance', status, text: 'Vous pouvez saisir le médiateur Exemple : https://mediateur.example', createdOn: parisDay(-1), sendRule: null });
    const routes = {
      [LIST]: async () =>
        Response.json({
          ok: true,
          data: [
            C({ dueOn: parisDay(-1), mediator: offer(handed ? 'remis' : 'a_remettre') }),
            C({ complaintId: 'r9', dueOn: parisDay(-1), mediator: offer('envoye') }),
          ],
        }),
      '/v1/securite/reclamations/r1/mediateur-remis': async () => {
        handed = true;
        return Response.json({ ok: true, data: null });
      },
    };
    const a = await open(routes);
    expect(texts(a)).toContain('Proposition du médiateur à remettre vous-même au client :');
    expect(texts(a)).toContain('« Vous pouvez saisir le médiateur Exemple : https://mediateur.example »');
    expect(texts(a)).toContain(`Proposition du médiateur envoyée au client le ${fr(parisDay(-1))} (mode essai : rien ne part encore vraiment).`);
    expect(a.named(part(a), 'Remise au client').length).toBe(1);
    await click(a, 'Remise au client');
    expect(a.calls.find((c) => c.method === 'POST')!.url).toBe('/v1/securite/reclamations/r1/mediateur-remis');
    expect(said(a)).toBe('Remise notée.');
    expect(texts(a)).toContain('Proposition du médiateur remise au client.');
    expect(a.named(part(a), 'Remise au client')).toEqual([]);
  });

  it('[R16] chaque refus est dit en mots, jamais un code ; une écriture sans réponse est dite incertaine et la liste relue', async () => {
    const refused = (status: number, code: string, rule: string | null = null) => async () => Response.json({ ok: false, rule, code }, { status });
    const a = await open({ [LIST]: refused(403, 'role', 'R16') });
    expect(said(a)).toBe('Réservé à l’agent qui suit cette fiche et à la direction.');
    const b = await open({ [LIST]: ok([]), [RECORD]: refused(400, 'future_date') });
    await click(b, 'Ranger la réclamation');
    expect(said(b)).toBe(RECLAMATIONS_REFUSALS.future_date);
    expect(texts(b)).toContain('Ranger une réclamation reçue');
    const c = await open({ [LIST]: ok([]), [RECORD]: refused(409, 'mystere') });
    await click(c, 'Ranger la réclamation');
    expect(said(c)).toBe('Refusé : relisez la saisie.');
    const d = await open({ [LIST]: ok([]), [RECORD]: async () => Promise.reject(new TypeError('coupure')) });
    await click(d, 'Ranger la réclamation');
    expect(said(d)).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste avant de recommencer.');
    expect(d.calls.filter((x) => x.url === LIST).length).toBe(2);
    const p = await open({ [LIST]: ok([]), [RECORD]: async () => new Response('panne', { status: 500 }) });
    await click(p, 'Ranger la réclamation');
    expect(said(p)).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste avant de recommencer.');
    expect(p.calls.filter((x) => x.url === LIST).length).toBe(2);
    const e = await open({ [LIST]: async () => Promise.reject(new TypeError('hors ligne')) });
    expect(said(e)).toBe('Pas de réseau. Réessayez dans un moment.');
    for (const code of Object.keys(RECLAMATIONS_REFUSALS)) expect(RECLAMATIONS_REFUSALS[code as keyof typeof RECLAMATIONS_REFUSALS]).not.toMatch(/_/);
  });

  it('[R201] texte reçu posé en texte ; champ mal formé tu', async () => {
    const a = await open({
      [LIST]: ok([
        C({ summary: '<img src=x onerror=alert(1)>' }),
        C({ complaintId: 'r2', receivedBy: 'pigeon' }),
        C({ complaintId: 'r3', dueOn: 'demain' }),
        C({ complaintId: 'bad id!' }),
        C({ complaintId: 'r5', status: 'reglee', answer: { outcome: 'autre', note: 'x' } }),
        'pas un objet',
      ]),
    });
    expect(part(a).all().filter((e) => e.tagName === 'article').length).toBe(1);
    expect(part(a).all().find((e) => e.textContent === '« <img src=x onerror=alert(1)> »')).toBeDefined();
    expect(part(a).all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('une écriture finie sur une fiche n’arrête pas la lecture d’une autre fiche', async () => {
    let finish: (r: Response) => void = () => undefined;
    let release: (r: Response) => void = () => undefined;
    let reads = 0;
    const a = await open({
      [LIST]: () => {
        reads += 1;
        if (reads === 2) return new Promise<Response>((r) => (release = r));
        return Promise.resolve(Response.json({ ok: true, data: [] }));
      },
      [RECORD]: () => new Promise<Response>((r) => (finish = r)),
    });
    const first = part(a);
    a.named(first, 'Ranger la réclamation')[0]!.listeners.click!({});
    await a.tick();
    // La fiche est rouverte : un nouveau bloc lit pendant que l'écriture de l'ancien attend.
    a.named(a.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await a.tick();
    expect(part(a)).not.toBe(first);
    a.named(part(a), 'Réclamations')[0]!.listeners.click!({});
    await a.tick();
    expect(reads).toBe(2);
    finish(Response.json({ ok: true, data: null }));
    await a.tick();
    release(Response.json({ ok: true, data: [C()] }));
    await a.tick();
    expect(said(a)).toBe('');
    expect(texts(a)).toContain('« Le compte rendu de visite n’est jamais arrivé. »');
  });
});
