import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ESPACE_AGENT_SCRIPT } from '../app/espace-agent.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const POST = '/v1/espaces/personnes/p-1/ouvrir';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const FICHE = { personId: 'p-1', firstName: 'Client', lastName: 'Inventé', contact: { allowed: true, reasons: [] }, call: null, callRefusal: 'no_consent', callClosesAt: null, projects: [], sources: [], consents: [], messages: [], callbacks: [] };
const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: 'p-1', firstName: 'Client', kind: 'callback', reason: 'À rappeler', slot: null }] };

async function open(fiche: Record<string, unknown>, answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { url: string; method: string; body?: string }[] = [];
  const routes: Record<string, Answer> = {
    '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
    '/v1/plan-du-jour': ok(PLAN),
    '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
    '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
    '/v1/fiches/p-1/resume': ok(fiche),
    ...answers,
  };
  const context = {
    document,
    Date,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method ?? 'GET', ...(init.body ? { body: init.body } : {}) });
      const a = routes[url];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, context);
  listeners.DOMContentLoaded!();
  const tick = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  const named = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  named(els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
  await tick();
  const body = els['fiche-corps']!;
  const press = async (text: string) => {
    named(body, text)[0]!.listeners.click!({});
    await tick();
    const s = body.all().find((e) => e.tagName === 'script' && e.attributes.src === '/app/espace-agent.js' && !e.attributes['data-lu']);
    if (s) {
      s.attributes['data-lu'] = 'oui';
      runInNewContext(ESPACE_AGENT_SCRIPT, context);
      s.listeners.load!({});
      await tick();
    }
  };
  const proof = () => {
    const l = body.all().find((e) => e.tagName === 'label' && e.textContent === 'Comment elle a accepté d’avoir son espace')!;
    return body.all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  const say = () => body.all().filter((e) => e.attributes.role === 'status' || e.className === 'etat').map((e) => e.textContent).join(' ');
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { body, calls, named, press, proof, say, tick, routes, posts };
}

describe('EC12 · ouvrir l’espace d’un client depuis sa fiche', () => {
  it('[R201] servi à part, rien n’est chargé avant le geste, budget tenu', async () => {
    const t = await open(FICHE);
    expect(t.body.all().some((e) => e.tagName === 'script' && e.attributes.src === '/app/espace-agent.js')).toBe(false);
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain('/v1/espaces');
    expect(budgetProblems({ html: '', js: ESPACE_AGENT_SCRIPT }, BUDGETS.page)).toEqual([]);
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/espace-agent.js'))!;
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(await served.text()).toBe(ESPACE_AGENT_SCRIPT);
  });

  it('[R03] sans preuve de l’accord, rien ne part ; une personne qu’on ne peut contacter n’a pas le geste', async () => {
    const t = await open(FICHE);
    await t.press('Ouvrir son espace client');
    await t.press('Préparer le lien de son espace');
    expect(t.posts()).toHaveLength(0);
    expect(t.say()).toContain('Écrivez comment la personne a donné son accord');
    t.proof().value = 'x'.repeat(301);
    await t.press('Préparer le lien de son espace');
    expect(t.posts()).toHaveLength(0);
    const stopped = await open({ ...FICHE, contact: { allowed: false, reasons: ['stop'] } });
    expect(stopped.named(stopped.body, 'Ouvrir son espace client')).toHaveLength(0);
  });

  it('[R26] avant le geste comme pendant, rien n’annonce un envoi réel', async () => {
    let answer: (r: Response) => void = () => undefined;
    const t = await open(FICHE, { [POST]: () => new Promise<Response>((r) => { answer = r; }) });
    await t.press('Ouvrir son espace client');
    expect(t.body.textContent).toContain('En mode essai, le lien personnel est préparé et rien ne part pour de vrai');
    expect(t.body.textContent).not.toContain('reçoit');
    t.proof().value = 'Accord de vive voix.';
    await t.press('Préparer le lien de son espace');
    expect(t.say()).toContain('Préparation…');
    expect(t.say()).not.toContain('Envoi');
    answer(Response.json({ ok: true, mode: 'essai', data: { linkId: 'l', mode: 'essai' } }));
    await t.tick();
  });

  it('les espaces pas encore ouverts et les heures d’envoi sont dits tels : ni réponse perdue, ni fausse cause', async () => {
    const t = await open(FICHE, { [POST]: no(503, { ok: false, rule: null, code: 'espace_not_configured' }) });
    await t.press('Ouvrir son espace client');
    t.proof().value = 'Accord de vive voix.';
    await t.press('Préparer le lien de son espace');
    expect(t.say()).toContain('Les espaces clients ne sont pas encore ouverts : rien n’est préparé.');
    expect(t.say()).not.toContain('Réponse perdue');
    expect(t.named(t.body, 'Préparer le lien de son espace')).toHaveLength(1);
    t.routes[POST] = no(409, { ok: false, rule: 'R01', code: 'send_refused' });
    await t.press('Préparer le lien de son espace');
    expect(t.say()).toContain('Hors des heures d’envoi : rien n’est parti.');
    expect(t.say()).not.toContain('vérifiez l’adresse');
    t.routes[POST] = no(403, { ok: false, rule: 'R16', code: 'access_cut' });
    await t.press('Préparer le lien de son espace');
    expect(t.say()).toContain('Ce geste n’est pas dans vos droits.');
  });

  it('sans réseau au chargement du script, c’est dit, et le même bouton recharge', async () => {
    const t = await open(FICHE);
    t.named(t.body, 'Ouvrir son espace client')[0]!.listeners.click!({});
    await t.tick();
    t.body.all().find((e) => e.tagName === 'script' && e.attributes.src === '/app/espace-agent.js')!.listeners.error!({});
    await t.tick();
    expect(t.say()).toContain('Pas de réseau. Réessayez dans un moment.');
    expect(t.named(t.body, 'Ouvrir son espace client')).toHaveLength(1);
  });

  it('[R26] [R160] ce qui part est dit en essai ; aucun lien à l’écran, et le geste ne se rejoue pas', async () => {
    const t = await open(FICHE, { [POST]: ok({ linkId: 'lien-secret', expiresAt: '2026-11-17T10:00:00.000Z', mode: 'essai' }) });
    await t.press('Ouvrir son espace client');
    t.proof().value = 'Elle l’a demandé au rendez-vous du 3 novembre.';
    await t.press('Préparer le lien de son espace');
    expect(t.posts()).toEqual([{ url: POST, method: 'POST', body: JSON.stringify({ consentProof: 'Elle l’a demandé au rendez-vous du 3 novembre.' }) }]);
    expect(t.body.textContent).toContain('Lien préparé en mode essai : rien n’est parti pour de vrai.');
    expect(t.body.textContent).not.toContain('lien-secret');
    expect(t.named(t.body, 'Préparer le lien de son espace')).toHaveLength(0);
  });

  it('[R161] [R16] les refus sont dits en français, sans code ; le formulaire reste', async () => {
    const t = await open(FICHE, { [POST]: no(409, { ok: false, rule: 'R161', code: 'no_file' }) });
    await t.press('Ouvrir son espace client');
    t.proof().value = 'Accord de vive voix.';
    await t.press('Préparer le lien de son espace');
    expect(t.say()).toContain('Cette personne n’est partie à aucun dossier');
    expect(t.say()).not.toContain('no_file');
    expect(t.named(t.body, 'Préparer le lien de son espace')).toHaveLength(1);
    t.routes[POST] = no(409, { ok: false, rule: 'R03', code: 'send_refused' });
    await t.press('Préparer le lien de son espace');
    expect(t.say()).toContain('Le contrôle central a refusé ce mail');
    t.routes[POST] = no(403, { ok: false, rule: 'R16', code: 'not_assigned' });
    await t.press('Préparer le lien de son espace');
    expect(t.say()).toContain('Ce client est suivi par un autre agent.');
  });

  it('[R160] [EC13] au plafond, le refus est dit en français, sans lien ni code, et rien n’est présenté comme préparé', async () => {
    const t = await open(FICHE, { [POST]: no(409, { ok: false, rule: 'R160', code: 'plafond' }) });
    await t.press('Ouvrir son espace client');
    t.proof().value = 'Accord de vive voix.';
    await t.press('Préparer le lien de son espace');
    expect(t.say()).toContain('Le plafond de liens sur 24 heures est atteint');
    expect(t.say()).toContain('rien n’est préparé');
    expect(t.say()).not.toContain('plafond:');
    expect(t.body.all().map((e) => e.textContent).join(' ')).not.toMatch(/Lien préparé|https?:|[a-z]{40}/);
  });

  describe('BR98 · au plafond, ce qui le tient et l’heure du prochain lien', () => {
    const LIENS = '/v1/espaces/personnes/p-1/liens';
    const CAP = { [POST]: no(409, { ok: false, rule: 'R160', code: 'plafond' }) };
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    /** L'heure de Paris attendue, écrite à part de l'écran. */
    const paris = (iso: string) => {
      const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).split(':');
      const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);
      return `${day(new Date(iso)) === day(new Date()) ? 'aujourd’hui' : 'demain'} à ${Number(h)} h ${m}`;
    };
    const refuse = async (allowance: Answer) => {
      const t = await open(FICHE, { ...CAP, [LIENS]: allowance });
      await t.press('Ouvrir son espace client');
      expect(t.calls.some((c) => c.url === LIENS)).toBe(false);
      t.proof().value = 'Accord de vive voix.';
      await t.press('Préparer le lien de son espace');
      return t;
    };

    it('[R160] [R13] les demandes du site jamais ouvertes sont dites, avec l’heure de Paris du prochain lien ; ni lien ni adresse', async () => {
      const next = at(5 * 3_600_000);
      const t = await refuse(ok({ limit: 3, counted: 3, requested: 3, prepared: 0, opened: 0, nextAt: next, requestsUnopened: true, checkedAt: at(0) }));
      expect(t.say()).toContain(`Plafond atteint : 3 liens ces 24 heures (3 demandés depuis le site), aucun ouvert. Rien n’est préparé. Aucune de ces demandes n’a été ouverte : elles ne viennent peut-être pas de la personne. Prochain lien possible ${paris(next)}.`);
      expect(t.calls.filter((c) => c.url === LIENS)).toEqual([{ url: LIENS, method: 'GET' }]);
      expect(t.body.all().map((e) => e.textContent).join(' ')).not.toMatch(/Lien préparé|https?:|@|plafond:/);
    });

    it('[R160] liens préparés et ouverts : comptes au singulier et au pluriel, sans la phrase des demandes ; le lendemain dit « demain »', async () => {
      const next = at(23 * 3_600_000 + 59 * 60_000);
      const t = await refuse(ok({ limit: 3, counted: 3, requested: 1, prepared: 2, opened: 1, nextAt: next, requestsUnopened: false, checkedAt: at(0) }));
      expect(t.say()).toContain(`Plafond atteint : 3 liens ces 24 heures (1 demandé depuis le site, 2 préparés), 1 ouvert. Rien n’est préparé. Prochain lien possible ${paris(next)}.`);
      expect(paris(next)).toMatch(/^demain à \d{1,2} h \d{2}$/);
    });

    it('[R10] une lecture en échec, hors réseau, incomplète ou sous le plafond garde la phrase d’avant, sans heure inventée', async () => {
      for (const answer of [
        no(403, { ok: false, rule: 'R16', code: 'role' }),
        async () => Promise.reject(new TypeError('x')),
        ok({ limit: 3, counted: 3, requested: 0, prepared: 3, opened: 0, nextAt: null, requestsUnopened: false }),
        ok({ limit: 3, counted: 3, requested: 0, prepared: 3, opened: 0, nextAt: 'pas une date', requestsUnopened: false }),
        ok({ limit: 3, counted: 2, requested: 0, prepared: 2, opened: 0, nextAt: null, requestsUnopened: false }),
        ok(null),
      ] as Answer[]) {
        const t = await refuse(answer);
        expect(t.say()).toContain('Le plafond de liens sur 24 heures est atteint pour cette personne : rien n’est préparé');
        expect(t.say()).not.toMatch(/Prochain lien| h \d{2}/);
      }
    });

    it('[R201] le script tient son budget, sans innerHTML ; l’application ne lit pas les liens', () => {
      expect(budgetProblems({ html: '', js: ESPACE_AGENT_SCRIPT }, BUDGETS.page)).toEqual([]);
      expect(ESPACE_AGENT_SCRIPT).not.toContain('innerHTML');
      expect(AGENT_APP_FILES['/app/app.js']).not.toContain('/liens');
    });
  });

  it('une réponse perdue est dite telle : le geste n’est plus offert, chaque appel ferait un nouveau lien', async () => {
    const t = await open(FICHE);
    await t.press('Ouvrir son espace client');
    t.proof().value = 'Accord de vive voix.';
    await t.press('Préparer le lien de son espace');
    expect(t.say()).toContain('Réponse perdue : le lien est peut-être préparé, la fiche ne peut pas le confirmer.');
    expect(t.named(t.body, 'Préparer le lien de son espace')).toHaveLength(0);
    expect(t.posts()).toHaveLength(1);
  });

  it('un double appui n’envoie qu’une demande', async () => {
    let answer: (r: Response) => void = () => undefined;
    const t = await open(FICHE, { [POST]: () => new Promise<Response>((r) => { answer = r; }) });
    await t.press('Ouvrir son espace client');
    t.proof().value = 'Accord de vive voix.';
    const b = t.named(t.body, 'Préparer le lien de son espace')[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await t.tick();
    expect(t.posts()).toHaveLength(1);
    answer(Response.json({ ok: true, mode: 'essai', data: { linkId: 'l', expiresAt: '2026-11-17T10:00:00.000Z', mode: 'essai' } }));
    await t.tick();
  });
});
