import { runInNewContext } from 'node:vm';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { PROJECT_KINDS } from '../../core/src/db/types.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOMMANDATION_SCRIPT } from '../app/recommandation.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const PATH = '/v1/apres-vente/fiches/p-1/recommandations';
type Call = { url: string; method: string; body: Record<string, unknown> | null; key: string | null };
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, code: string, rule: string | null = null): Answer => async () => Response.json({ ok: false, rule, code }, { status });
const offline: Answer = () => Promise.reject(new TypeError('hors ligne'));
const FICHE = { personId: 'p-1', firstName: 'Client', lastName: 'Inventé', contact: { allowed: true, reasons: [] }, call: null, callRefusal: 'no_consent', callClosesAt: null, projects: [], sources: [], consents: [], messages: [], callbacks: [] };
const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: 'p-1', firstName: 'Client', kind: 'callback', reason: 'À rappeler', order: 'règle 1', basis: { kind: 'request', since: '2026-11-01', purpose: null }, projectId: null }], removed: { excluded: 0, withdrawn: 0, noBasis: 0 }, hiddenSinceFrozen: 0 };
const EMPTY = { recommendedBy: [], recommended: [] };

/** La fiche ouverte. `posts` répond à chaque envoi dans l'ordre, `reads` à chaque lecture de la liste. */
async function opened(posts: Answer[] = [], reads: Answer[] = [ok(EMPTY)]) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: Call[] = [];
  const routes: Record<string, Answer> = {
    '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
    '/v1/plan-du-jour': ok(PLAN),
    '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
    '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
    '/v1/fiches/p-1/resume': ok(FICHE),
  };
  const context: Record<string, unknown> = {
    document,
    Date,
    crypto,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null, key: init.headers?.['idempotency-key'] ?? null });
      if (url === PATH) {
        const next = method === 'POST' ? posts.shift() : reads.length > 1 ? reads.shift() : reads[0];
        return next ? next() : offline();
      }
      return (routes[url] ?? offline)();
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
  const scripts = () => els.fiche!.children.filter((e) => e.attributes.src === '/app/recommandation.js');
  const said = () => body.all().find((e) => e.className === 'etat reco')!.textContent;
  const text = () => body.all().map((e) => e.textContent).join(' | ');
  const sent = () => calls.filter((c) => c.method === 'POST' && c.url === PATH);
  const press = async () => {
    named(body, 'Ranger la recommandation')[0]!.listeners.click!({});
    await tick();
  };
  const openBlock = async () => {
    named(body, 'Recommandation d’un proche')[0]!.listeners.click!({});
    await tick();
    if (scripts().length === 1 && !context.AIMMO_LOADED) {
      context.AIMMO_LOADED = true;
      runInNewContext(RECOMMANDATION_SCRIPT, context);
      scripts()[0]!.listeners.load!({});
      await tick();
    }
  };
  const fill = (over: { mail?: string; projet?: string } = {}) => {
    byLabel('Mail du proche').value = over.mail ?? 'nina@example.test';
    byLabel('Son projet').value = over.projet ?? 'buy';
  };
  return { els, calls, body, byLabel, said, text, sent, press, openBlock, fill, scripts, tick, named };
}

describe('X22 · recommander un proche depuis la fiche', () => {
  afterEach(() => vi.restoreAllMocks());

  it('[R201] rien n’est demandé avant le geste, le script est à part et tient son budget, l’application aussi', async () => {
    const a = await opened();
    expect(a.calls.some((c) => c.url === PATH)).toBe(false);
    expect(a.scripts()).toHaveLength(0);
    expect(AGENT_APP_FILES['/app/app.js']).not.toContain('/recommandations');
    expect(AGENT_APP_FILES['/app/recommandation.js']).toBe(RECOMMANDATION_SCRIPT);
    expect(budgetProblems({ html: '', js: RECOMMANDATION_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']! }, BUDGETS.application)).toEqual([]);
    expect(RECOMMANDATION_SCRIPT).not.toContain('innerHTML');
    expect(RECOMMANDATION_SCRIPT).not.toContain('localStorage');
  });

  it('chaque projet du socle a son libellé, et la liste des recommandations se lit', async () => {
    const a = await opened([], [ok({ recommendedBy: [{ firstName: 'Léa' }, { firstName: null }], recommended: [{ referralId: 'r1', firstName: 'Nina' }, { referralId: 'r2', firstName: null }] })]);
    await a.openBlock();
    const values = a.byLabel('Son projet').children.map((o) => o.attributes.value);
    expect(values).toEqual(['', ...PROJECT_KINDS]);
    for (const t of ['Recommandé par Léa', 'Recommandé par un client', 'A recommandé Nina', 'A recommandé un proche']) expect(a.text()).toContain(t);
  });

  it('[R142] la saisie part avec sa clé d’idempotence, sans preuve quand la case n’est pas cochée, et la fiche se relit', async () => {
    const a = await opened([ok({ id: 'r1', recorded: true })], [ok(EMPTY), ok({ recommendedBy: [], recommended: [{ referralId: 'r1', firstName: 'Nina' }] })]);
    await a.openBlock();
    a.fill();
    a.byLabel('Prénom du proche').value = ' Nina ';
    a.byLabel('Téléphone du proche').value = '06 00 00 00 00';
    a.byLabel('Preuve de cet accord').value = 'écrite mais case non cochée';
    await a.press();
    expect(a.sent()).toHaveLength(1);
    expect(a.sent()[0]!.body).toEqual({ projectKind: 'buy', callable: false, firstName: 'Nina', email: 'nina@example.test', phone: '06 00 00 00 00' });
    expect(a.sent()[0]!.key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(a.said()).toBe('Recommandation rangée. Elle ne demande aucun appel.');
    expect(a.text()).toContain('A recommandé Nina');
    // Le formulaire est vidé : la coordonnée du proche ne reste pas à l'écran.
    expect(a.byLabel('Mail du proche').value).toBe('');
    expect(a.byLabel('Preuve de cet accord').value).toBe('');
  });

  it('[R03] [R142] la case cochée exige une preuve avant tout envoi, et la preuve part avec elle', async () => {
    const a = await opened([ok({ id: 'r1', recorded: true })]);
    await a.openBlock();
    a.fill();
    a.byLabel('Selon le client').checked = true;
    await a.press();
    expect(a.sent()).toHaveLength(0);
    expect(a.said()).toContain('preuve de son accord');
    a.byLabel('Preuve de cet accord').value = 'dit par le client le 3 novembre';
    await a.press();
    expect(a.sent()[0]!.body).toEqual({ projectKind: 'buy', callable: true, email: 'nina@example.test', proof: 'dit par le client le 3 novembre' });
    // [R16] Le texte ne dit ni qu'un appel est créé, ni qui suit le proche : la réponse du socle est la même dans tous les cas.
    expect(a.said()).toBe('Recommandation rangée. Si cet appel est permis, il sera proposé à l’agent qui suit cette personne.');
  });

  it('une saisie incomplète n’envoie rien', async () => {
    const a = await opened();
    await a.openBlock();
    await a.press();
    expect(a.said()).toBe('Donnez un mail ou un téléphone du proche.');
    a.byLabel('Mail du proche').value = 'nina@example.test';
    await a.press();
    expect(a.said()).toBe('Choisissez le projet du proche.');
    expect(a.sent()).toHaveLength(0);
  });

  it('[R16] les droits refusés sont dits, à la lecture comme à l’envoi', async () => {
    const lu = await opened([], [no(403, 'not_assigned', 'R16')]);
    await lu.openBlock();
    expect(lu.said()).toBe('Réservé à l’agent de cette fiche et à la direction.');
    expect(lu.named(lu.body, 'Ranger la recommandation')).toHaveLength(0);
    const envoi = await opened([no(403, 'not_assigned', 'R16')]);
    await envoi.openBlock();
    envoi.fill();
    await envoi.press();
    expect(envoi.said()).toBe('Réservé à l’agent de cette fiche et à la direction.');
    expect(envoi.byLabel('Mail du proche').value).toBe('nina@example.test');
  });

  it('[R10] une réponse perdue est dite telle : la même saisie repart avec la même clé, sans doublon', async () => {
    const lost: Answer[] = [offline, no(500, 'internal'), ok({ id: 'r1', recorded: true })];
    const a = await opened(lost);
    await a.openBlock();
    a.fill();
    await a.press();
    expect(a.said()).toContain('La réponse n’est pas arrivée : rien n’est sûr.');
    expect(a.byLabel('Mail du proche').value).toBe('nina@example.test');
    await a.press();
    expect(a.said()).toContain('La réponse n’est pas arrivée : rien n’est sûr.');
    await a.press();
    expect(a.said()).toContain('Recommandation rangée.');
    const keys = a.sent().map((c) => c.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('une saisie changée après une réponse perdue prend une autre clé : la première réponse ne vaudrait pas pour elle', async () => {
    const a = await opened([offline, ok({ id: 'r1', recorded: true })]);
    await a.openBlock();
    a.fill();
    await a.press();
    a.fill({ mail: 'autre@example.test' });
    await a.press();
    const keys = a.sent().map((c) => c.key);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('un envoi encore en cours garde sa clé ; une panne déjà rangée en demande une nouvelle, et la dit', async () => {
    const a = await opened([no(409, 'in_progress'), no(500, 'retry_with_new_key'), ok({ id: 'r1', recorded: true })]);
    await a.openBlock();
    a.fill();
    await a.press();
    expect(a.said()).toContain('pas encore de réponse');
    await a.press();
    expect(a.said()).toBe('Cet envoi n’a pas abouti. Renvoyez la saisie.');
    await a.press();
    const keys = a.sent().map((c) => c.key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('un refus est dit en clair, la saisie reste, et une nouvelle demande ne relit pas ce refus', async () => {
    const a = await opened([no(409, 'reward', 'R66'), no(400, 'already_referred'), no(400, 'same_person'), no(400, 'bad_email'), no(400, 'inconnu')]);
    await a.openBlock();
    a.fill();
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      await a.press();
      lines.push(a.said());
    }
    expect(lines).toEqual([
      'Une recommandation ne se récompense jamais : retirez ce qui en parle.',
      'Ce client a déjà recommandé cette personne : rien de plus n’est rangé.',
      'Ces coordonnées sont celles du client de cette fiche.',
      'Ce mail n’est pas lisible.',
      'Cette recommandation n’est pas rangée.',
    ]);
    expect(a.byLabel('Mail du proche').value).toBe('nina@example.test');
    expect(new Set(a.sent().map((c) => c.key)).size).toBe(5);
  });

  it('[R66] aucun champ de récompense à l’écran', async () => {
    const a = await opened();
    await a.openBlock();
    const labels = a.body.all().filter((e) => e.tagName === 'label').map((e) => e.textContent);
    expect(labels.filter((l) => /prime|cadeau|commission|récompense|montant/i.test(l))).toEqual([]);
  });

  it('un double appui n’envoie qu’une fois ; un second appui sur le bloc garde la saisie', async () => {
    let release: (r: Response) => void = () => {};
    const a = await opened([() => new Promise<Response>((r) => { release = r; })]);
    await a.openBlock();
    a.fill();
    await a.openBlock();
    expect(a.byLabel('Mail du proche').value).toBe('nina@example.test');
    expect(a.calls.filter((c) => c.url === PATH && c.method === 'GET')).toHaveLength(1);
    await a.press();
    await a.press();
    expect(a.sent()).toHaveLength(1);
    release(Response.json({ ok: true, data: { id: 'r1', recorded: true } }));
    await a.tick();
    expect(a.said()).toContain('Recommandation rangée.');
  });

  it('une clé restée sans réponse après une coupure n’enferme pas : passé deux minutes, une autre clé repart', async () => {
    const a = await opened([no(409, 'in_progress'), no(409, 'in_progress'), no(409, 'in_progress'), ok({ id: 'r1', recorded: true })]);
    await a.openBlock();
    a.fill();
    const start = Date.now();
    await a.press();
    await a.press();
    expect(a.said()).toContain('pas encore de réponse');
    vi.spyOn(Date, 'now').mockReturnValue(start + 121_000);
    await a.press();
    expect(a.said()).toBe('Cet envoi n’a pas abouti. Renvoyez la saisie.');
    await a.press();
    const keys = a.sent().map((c) => c.key);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(a.said()).toContain('Recommandation rangée.');
  });

  it('deux appuis pendant la lecture : une seule lecture, et la liste relue après l’envoi est bien celle de l’écran', async () => {
    let release: (r: Response) => void = () => {};
    const first: Answer = () => new Promise<Response>((r) => { release = r; });
    const a = await opened([ok({ id: 'r1', recorded: true })], [first, ok({ recommendedBy: [], recommended: [{ referralId: 'r1', firstName: 'Nina' }] })]);
    await a.openBlock();
    await a.openBlock();
    expect(a.calls.filter((c) => c.url === PATH && c.method === 'GET')).toHaveLength(1);
    release(Response.json({ ok: true, data: EMPTY }));
    await a.tick();
    a.fill();
    await a.press();
    expect(a.text()).toContain('A recommandé Nina');
  });

  it('[R10] un script manquant est dit, et un nouvel appui réessaie', async () => {
    const a = await opened();
    a.named(a.body, 'Recommandation d’un proche')[0]!.listeners.click!({});
    await a.tick();
    a.scripts()[0]!.listeners.error!({});
    await a.tick();
    expect(a.said()).toBe('Pas de réseau. Réessayez dans un moment.');
    a.named(a.body, 'Recommandation d’un proche')[0]!.listeners.click!({});
    await a.tick();
    expect(a.scripts()).toHaveLength(2);
  });

  it('[R16] une réponse tardive après la déconnexion n’écrit rien et ne lit plus rien', async () => {
    let release: (r: Response) => void = () => {};
    const a = await opened([() => new Promise<Response>((r) => { release = r; })]);
    await a.openBlock();
    a.fill();
    await a.press();
    // La déconnexion vide la fiche : l'élément est gardé pour voir que rien n'y est écrit ensuite.
    const status = a.body.all().find((e) => e.className === 'etat reco')!;
    const reads = a.calls.filter((c) => c.url === PATH && c.method === 'GET').length;
    a.els.sortir!.listeners.click!({});
    release(Response.json({ ok: true, data: { id: 'r1', recorded: true } }));
    await a.tick();
    expect(a.calls.filter((c) => c.url === PATH && c.method === 'GET')).toHaveLength(reads);
    expect(status.textContent).toBe('Envoi…');
  });

  it('[R16] une lecture tardive après la déconnexion ne pose aucun formulaire', async () => {
    let release: (r: Response) => void = () => {};
    const a = await opened([], [() => new Promise<Response>((r) => { release = r; })]);
    await a.openBlock();
    const box = a.body.all().find((e) => e.tagName === 'section' && e.all().some((x) => x.className === 'etat reco'))!;
    a.els.sortir!.listeners.click!({});
    release(Response.json({ ok: true, data: EMPTY }));
    await a.tick();
    expect(box.all().filter((e) => e.tagName === 'button' && e.textContent === 'Ranger la recommandation')).toHaveLength(0);
  });

  it('la liste perdue après une recommandation rangée laisse le succès dit', async () => {
    const a = await opened([ok({ id: 'r1', recorded: true })], [ok(EMPTY), offline]);
    await a.openBlock();
    a.fill();
    await a.press();
    expect(a.said()).toBe('Recommandation rangée. Elle ne demande aucun appel. Pas de réseau. Réessayez dans un moment.');
  });
});
