import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { FINANCES_SCRIPT } from '../app/finances.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, chiffres.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
let clock = 1_800_000_000_000;
class Clock extends Date {
  static override now(): number {
    return clock;
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const REPORT = {
  day: '2026-11-03',
  period: { from: '2026-11-02', to: '2026-11-02' },
  text: 'Hier : 3 contacts, 1 rendez-vous, 0 mandat, 0 vente.\n2 contacts chauds à rappeler.\nAlerte : 1 rappel en retard.',
  content: {},
};
const ROUTE = 'GET /v1/pilotage/rapport-matin';

async function run(role: 'agent' | 'direction', answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; auth: string | undefined }[] = [];
  const sent: string[] = [];
  const table: Record<string, Answer> = { 'GET /v1/moi': ok({ role, firstName: null }), [ROUTE]: ok(REPORT), ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      if (init.body) sent.push(init.body);
      calls.push({ method, url, auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date: Clock,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const host = role === 'agent' ? 'chiffres' : 'reseau';
  const scripts = () => els[host]!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/finances.js');
  const body = () => els[`rapport-${role}-corps`]!;
  const state = () => els[`rapport-${role}-etat`]!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const press = async () => {
    els[`rapport-${role}-lire`]!.listeners.click!({});
    await settle();
  };
  const load = async () => {
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(FINANCES_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const read = async () => {
    await press();
    await load();
  };
  const reports = () => calls.filter((c) => c.url.startsWith('/v1/pilotage/rapport-matin'));
  return { els, calls, table, body, state, texts, press, load, read, reports, scripts, bodies: () => sent };
}

describe('K10 · le rapport du matin à l’écran', () => {
  it('[R68] l’agent lit son rapport sur « Mes chiffres », ligne par ligne, par la seule route du rapport', async () => {
    const t = await run('agent');
    await t.read();
    expect(t.state()).toContain('Rapport du');
    expect(t.state()).toContain('pour le');
    expect(t.texts()).toContain('Hier : 3 contacts');
    expect(t.body().children).toHaveLength(3);
    expect(t.body().children[2]!.className).toBe('retard');
    // Le serveur choisit le rapport d'après la clé : aucun agent, aucun lecteur dans l'adresse.
    expect(t.reports().map((c) => c.url)).toEqual(['/v1/pilotage/rapport-matin']);
    expect(t.calls.every((c) => !c.url.includes(KEY))).toBe(true);
  });

  it('[R16] la direction lit le sien sur « Le réseau », et son écran ne se mêle pas de celui de l’agent', async () => {
    const t = await run('direction');
    await t.read();
    expect(t.texts()).toContain('Hier : 3 contacts');
    expect(t.els['rapport-agent-corps']!.children).toEqual([]);
    expect(t.reports().map((c) => c.url)).toEqual(['/v1/pilotage/rapport-matin']);
  });

  it('une période de plusieurs jours est dite', async () => {
    const t = await run('direction', { [ROUTE]: ok({ ...REPORT, day: '2026-11-02', period: { from: '2026-10-30', to: '2026-11-01' } }) });
    await t.read();
    expect(t.state()).toMatch(/du .* au /);
  });

  it('pas encore de rapport aujourd’hui, ou aucun ce jour-là : c’est dit, sans erreur', async () => {
    const t = await run('agent', { [ROUTE]: ok(null) });
    await t.read();
    expect(t.state()).toBe('Aucun rapport rangé aujourd’hui pour le moment : ils s’écrivent les jours ouvrés à 7 h 30.');
    expect(t.body().children).toEqual([]);
    // Un dimanche, un jour ouvré passé sans rapport, un jour à venir : le message ne prétend rien sur la raison.
    for (const day of ['2026-11-01', '2026-10-27', '2030-01-08']) {
      t.els['rapport-agent-jour']!.value = day;
      t.table[`GET /v1/pilotage/rapport-matin?jour=${day}`] = ok(null);
      await t.press();
      expect(t.state()).toBe('Aucun rapport rangé pour ce jour.');
    }
  });

  it('un autre jour se relit, et un jour mal écrit ne part pas', async () => {
    const t = await run('agent');
    t.els['rapport-agent-jour']!.value = '2026-10-30';
    t.table['GET /v1/pilotage/rapport-matin?jour=2026-10-30'] = ok({ ...REPORT, day: '2026-10-30', period: { from: '2026-10-29', to: '2026-10-29' } });
    await t.read();
    expect(t.reports().map((c) => c.url)).toEqual(['/v1/pilotage/rapport-matin?jour=2026-10-30']);
    t.els['rapport-agent-jour']!.value = 'hier';
    await t.press();
    expect(t.state()).toBe('Choisissez un jour.');
    expect(t.reports()).toHaveLength(1);
    expect(t.body().children).toEqual([]);
  });

  it('[R16] un refus et l’absence de réseau sont dits, et une erreur n’affiche aucun chiffre', async () => {
    const t = await run('agent', { [ROUTE]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.read();
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
    t.table[ROUTE] = async () => Promise.reject(new TypeError('hors ligne'));
    await t.press();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    t.table[ROUTE] = no(500, { ok: false, code: 'panne' });
    await t.press();
    expect(t.state()).toBe('Indisponible pour le moment. Réessayez plus tard.');
    expect(t.body().children).toEqual([]);
  });

  it('[R16] à la déconnexion, le rapport lu disparaît ; une réponse qui tarde ne s’affiche pas à la session suivante', async () => {
    const t = await run('agent');
    await t.read();
    t.els['rapport-agent-jour']!.value = '2026-10-30';
    let release: (r: Response) => void = () => undefined;
    t.table['GET /v1/pilotage/rapport-matin?jour=2026-10-30'] = () => new Promise((r) => (release = r));
    await t.press();
    t.els.sortir!.listeners.click!({});
    await settle();
    release(Response.json({ ok: true, data: REPORT }));
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
    expect(t.els['rapport-agent-jour']!.value).toBe('');
  });

  it('[R68] une réponse qui tarde ne s’affiche pas après un changement d’écran, qui relit ensuite le rapport', async () => {
    const t = await run('direction');
    await t.read();
    t.els['rapport-direction-jour']!.value = '2026-10-30';
    let release: (r: Response) => void = () => undefined;
    t.table['GET /v1/pilotage/rapport-matin?jour=2026-10-30'] = () => new Promise((r) => (release = r));
    await t.press();
    // Changer de période ouvre une nouvelle session de l'écran : la réponse d'avant n'a plus sa place.
    t.table['GET /v1/pilotage/reseau'] = ok({});
    t.els['reseau-precedent']!.listeners.click!({});
    await settle();
    release(Response.json({ ok: true, data: { ...REPORT, text: 'Ancien rapport.' } }));
    await settle();
    expect(t.texts()).not.toContain('Ancien rapport.');
    t.table[ROUTE] = ok(REPORT);
    await t.press();
    expect(t.texts()).toContain('Hier : 3 contacts');
  });

  it('[R16] sortir pendant le chargement du script : le rapport n’est jamais demandé', async () => {
    const t = await run('agent');
    await t.press();
    t.els.sortir!.listeners.click!({});
    await settle();
    await t.load();
    expect(t.reports()).toEqual([]);
    expect(t.state()).toBe('');
  });

  it('un script arrivé abîmé est dit', async () => {
    const t = await run('agent');
    await t.press();
    t.scripts()[0]!.listeners.load!({});
    await settle();
    expect(t.state()).toBe('Indisponible pour le moment. Réessayez dans un moment.');
    expect(t.reports()).toEqual([]);
  });

  it('deux appuis rapides font un seul chargement et un seul rapport', async () => {
    const t = await run('agent');
    t.els['rapport-agent-lire']!.listeners.click!({});
    t.els['rapport-agent-lire']!.listeners.click!({});
    await settle();
    expect(t.scripts()).toHaveLength(1);
    await t.load();
    t.els['rapport-agent-lire']!.listeners.click!({});
    t.els['rapport-agent-lire']!.listeners.click!({});
    await settle();
    expect(t.body().children).toHaveLength(3);
  });

  it('un script qui ne charge pas est dit, et un nouvel appui réessaie', async () => {
    const t = await run('direction');
    await t.press();
    t.scripts()[0]!.listeners.error!({});
    await settle();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    await t.press();
    expect(t.scripts()).toHaveLength(2);
  });

  it('[R201] le script est servi à part, hors de la coquille, et tient le budget d’une page', async () => {
    expect(AGENT_APP_SHELL).not.toContain('/app/finances.js');
    expect(budgetProblems({ html: '', js: FINANCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    const r = handleAgentApp(new Request('https://x.test/app/finances.js'));
    expect(r?.status).toBe(200);
    expect(HTML).not.toContain('AIMMO_FINANCES');
  });
});

// Tout est inventé : dossiers, agents, montants, références.
const COMMISSIONS = 'GET /v1/pilotage/commissions';
const TASKS = 'GET /v1/pilotage/reversements';
const BLOCKED = 'GET /v1/pilotage/commissions/a-trancher';
const PAID = { receivedAt: '2026-10-28T09:00:00.000Z', payoutDueAt: '2026-10-29T09:00:00.000Z', paidAt: null, late: null };
const SHARES = [
  { kind: 'reseau', beneficiaryId: null, reason: null, amountCents: 300000 },
  { kind: 'agent', beneficiaryId: 'alex', reason: null, amountCents: 500000 },
  { kind: 'partage', beneficiaryId: 'sam', reason: 'binome', amountCents: 200000 },
];
const commission = (fileId: string, status: string, extra: object = {}) => ({
  fileId,
  agentId: 'alex',
  compromisOn: '2026-09-01',
  feeCents: 1000000,
  feeCharge: 'vendeur',
  status,
  steps: [{ status: 'prevue', at: '2026-09-01T10:00:00.000Z' }, { status, at: '2026-10-20T10:00:00.000Z' }],
  shares: SHARES,
  payment: null,
  cancelled: false,
  ...extra,
});
const ALL = [
  commission('d-prevue', 'prevue'),
  commission('d-due', 'due'),
  commission('d-enc', 'facturee'),
  commission('d-ver', 'facturee', { payment: PAID }),
  commission('d-paye', 'payee', { payment: { ...PAID, paidAt: '2026-10-28T15:00:00.000Z', late: false } }),
];
const TASK = { fileId: 'd-ver', receivedAt: '2026-10-28T09:00:00.000Z', payoutDueAt: '2026-10-29T09:00:00.000Z', alerts: [] as string[] };

async function direction(answers: Record<string, Answer> = {}) {
  const t = await run('direction', { [COMMISSIONS]: ok(ALL), [TASKS]: ok([TASK]), [BLOCKED]: ok([]), ...answers });
  const body = () => t.els['commissions-corps']!;
  const state = () => t.els['commissions-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const by = (tag: string) => body().all().filter((e) => e.tagName === tag);
  const buttons = (text: string) => by('button').filter((e) => e.textContent === text);
  const voir = async () => {
    t.els['commissions-voir']!.listeners.click!({});
    await settle();
    await t.load();
  };
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  /** Remplit le geste dont le bouton est `b`, puis l'envoie en deux appuis espacés. */
  const fill = (b: FakeElement, when: string, ref: string) => {
    const box = body().all().find((e) => e.children.includes(b))!;
    const inputs = box.children.filter((e) => e.tagName === 'input');
    inputs[0]!.value = when;
    inputs[1]!.value = ref;
    return box;
  };
  const posts = () => t.calls.filter((c) => c.method === 'POST');
  return { ...t, body, state, texts, by, buttons, voir, click, fill, posts };
}

describe('K11 · commissions, encaissement et reversement pour la direction', () => {
  it('[R69] chaque commission est rangée par ce qu’elle attend, avec ses parts et ses dates', async () => {
    const t = await direction();
    await t.voir();
    const titles = t.by('h4').map((e) => e.textContent);
    expect(titles).toEqual(['À verser (1)', 'À encaisser (1)', 'À facturer (1)', 'Prévues, en attente de l’acte (1)', 'Payées (1)']);
    expect(t.texts()).toContain('Partage, agent sam (binôme pendant une absence)');
    expect(t.texts()).toContain('Part du réseau');
    expect(t.texts()).toContain('à la charge du vendeur');
    expect(t.texts()).toContain('À verser avant le');
    expect(t.texts()).not.toContain('Écart');
  });

  it('[R67] le geste n’est proposé que là où il a sa place : encaissement sur une commission facturée, versement après encaissement', async () => {
    const t = await direction();
    await t.voir();
    expect(t.buttons('Rapporter l’encaissement')).toHaveLength(1);
    expect(t.buttons('Rapporter le versement')).toHaveLength(1);
    const lis = t.by('li');
    const of = (id: string) => lis.find((li) => li.children[0]?.textContent === `Dossier ${id}`)!;
    expect(of('d-enc').all().some((e) => e.textContent === 'Rapporter l’encaissement')).toBe(true);
    expect(of('d-ver').all().some((e) => e.textContent === 'Rapporter le versement')).toBe(true);
    for (const id of ['d-prevue', 'd-due', 'd-paye']) expect(of(id).all().filter((e) => e.tagName === 'button')).toEqual([]);
  });

  it('[R67] [R70] l’encaissement part en deux appuis, sans aucun montant, et l’échéance dite vient du serveur', async () => {
    const t = await direction({ 'POST /v1/pilotage/dossiers/d-enc/encaissement': ok({ payoutDueAt: '2026-11-03T15:00:00.000Z' }) });
    await t.voir();
    const b = t.buttons('Rapporter l’encaissement')[0]!;
    t.fill(b, '2026-11-02T10:00', 'releve-2026-11-ligne-14');
    await t.click(b);
    expect(t.posts()).toEqual([]);
    expect(t.buttons('Confirmer : rapporter l’encaissement')).toHaveLength(1);
    clock += 2000;
    await t.click(b);
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/pilotage/dossiers/d-enc/encaissement']);
    const sent = JSON.parse(t.bodies().at(-1)!) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['proofRef', 'receivedAt']);
    expect(sent.proofRef).toBe('releve-2026-11-ligne-14');
    expect(String(sent.receivedAt)).toMatch(/Z$/);
    expect(sent.receivedAt).toBe(new Date('2026-11-02T10:00').toISOString());
    expect(t.state()).toContain('Encaissement rangé pour le dossier d-enc : à verser avant le');
  });

  it('[R70] le versement dit s’il a tenu les 24 h ouvrées', async () => {
    const t = await direction({ 'POST /v1/pilotage/dossiers/d-ver/reversement': ok({ late: true }) });
    await t.voir();
    const b = t.buttons('Rapporter le versement')[0]!;
    t.fill(b, '2026-11-02T10:00', 'virement-77');
    await t.click(b);
    clock += 2000;
    await t.click(b);
    expect(Object.keys(JSON.parse(t.bodies().at(-1)!) as object).sort()).toEqual(['paidAt', 'proofRef']);
    expect(t.state()).toContain('après l’échéance');
    t.table['POST /v1/pilotage/dossiers/d-ver/reversement'] = ok({ late: false });
    await t.voir();
    const c = t.buttons('Rapporter le versement')[0]!;
    t.fill(c, '2026-11-02T10:00', 'virement-77');
    await t.click(c);
    clock += 2000;
    await t.click(c);
    expect(t.state()).toContain('dans les 24 h ouvrées');
  });

  it('date absente et preuve illisible sont dites avant tout envoi', async () => {
    const t = await direction();
    await t.voir();
    const b = t.buttons('Rapporter l’encaissement')[0]!;
    const box = t.fill(b, '', 'virement-77');
    const said = () => box.children.find((e) => e.tagName === 'p')!.textContent;
    await t.click(b);
    expect(said()).toBe('Indiquez le jour et l’heure.');
    t.fill(b, '2026-11-02T10:00', 'relevé de Jean');
    await t.click(b);
    expect(said()).toContain('lettres sans accent');
    expect(t.posts()).toEqual([]);
    expect(t.buttons('Rapporter l’encaissement')).toHaveLength(1);
  });

  it('[R67] les refus du serveur sont dits en français ; rien n’est rangé deux fois', async () => {
    const route = 'POST /v1/pilotage/dossiers/d-enc/encaissement';
    const t = await direction({ [route]: no(400, { ok: false, rule: null, code: 'future_time' }) });
    await t.voir();
    const b = t.buttons('Rapporter l’encaissement')[0]!;
    const box = t.fill(b, '2026-11-02T10:00', 'virement-77');
    const said = () => box.children.find((e) => e.tagName === 'p')!.textContent;
    await t.click(b);
    clock += 2000;
    await t.click(b);
    expect(said()).toBe('Cette date est à venir : rapportez seulement ce qui a eu lieu.');
    expect((b as FakeElement & { disabled?: boolean }).disabled).toBe(false);
    t.table[route] = async () => Promise.reject(new TypeError('hors ligne'));
    await t.click(b);
    clock += 2000;
    await t.click(b);
    // Une réponse perdue ne prétend pas que rien n'est rangé.
    expect(said()).toBe('Réponse perdue : ce geste est peut-être rangé. Relisez la liste avant de recommencer.');
    // Déjà rapporté depuis un autre appareil : la liste est relue, le refus reste dit.
    t.table[route] = no(400, { ok: false, rule: null, code: 'already' });
    t.table[COMMISSIONS] = ok([commission('d-enc', 'facturee', { payment: PAID })]);
    t.table[TASKS] = ok([{ ...TASK, fileId: 'd-enc' }]);
    await t.click(b);
    clock += 2000;
    await t.click(b);
    expect(t.state()).toBe('C’est déjà rapporté.');
    expect(t.buttons('Rapporter l’encaissement')).toEqual([]);
    expect(t.buttons('Rapporter le versement')).toHaveLength(1);
  });

  it('[R69] des parts qui ne refont pas les honoraires : l’écart est dit, et aucun geste n’est proposé', async () => {
    const t = await direction({ [COMMISSIONS]: ok([commission('d-enc', 'facturee', { feeCents: 1000001 })]), [TASKS]: ok([]) });
    await t.voir();
    expect(t.texts()).toContain('Écart de');
    expect(t.buttons('Rapporter l’encaissement')).toEqual([]);
  });

  it('[R16] sans la liste des reversements, on ne propose aucun geste ; un refus et le hors-réseau sont dits', async () => {
    const t = await direction({ [TASKS]: no(500, { ok: false }) });
    await t.voir();
    expect(t.state()).toBe('Indisponible pour le moment. Réessayez plus tard.');
    expect(t.by('button')).toEqual([]);
    t.table[COMMISSIONS] = no(403, { ok: false, rule: 'R16', code: 'role' });
    t.table[TASKS] = ok([]);
    await t.voir();
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
    t.table[COMMISSIONS] = async () => Promise.reject(new TypeError('hors ligne'));
    await t.voir();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('[R67] un versement rangé dont l’étape a manqué n’est plus à encaisser ni à verser : dit, sans geste', async () => {
    const t = await direction({ [COMMISSIONS]: ok([commission('d-coupe', 'facturee', { payment: { ...PAID, paidAt: '2026-10-29T15:00:00.000Z', late: true } })]), [TASKS]: ok([]) });
    await t.voir();
    expect(t.by('h4').map((e) => e.textContent)).toEqual(['Payées (1)']);
    expect(t.by('button')).toEqual([]);
    expect(t.texts()).toContain('après l’échéance');
    expect(t.texts()).toContain('se reprend au prochain passage');
  });

  it('[R71] une vente annulée par un avoir n’a plus aucun geste, et ce qui a été encaissé est dit', async () => {
    const t = await direction({ [COMMISSIONS]: ok([commission('d-a', 'facturee', { cancelled: true }), commission('d-b', 'facturee', { cancelled: true, payment: PAID })]), [TASKS]: ok([{ ...TASK, fileId: 'd-b' }]) });
    await t.voir();
    expect(t.by('h4').map((e) => e.textContent)).toEqual(['Ventes annulées par un avoir (2)']);
    expect(t.by('button')).toEqual([]);
    expect(t.texts()).toContain('Déjà encaissée le');
  });

  it('[R63] [R67] ce que le passage laisse de côté est dit en tête, en français, sans geste', async () => {
    const t = await direction({
      [COMMISSIONS]: ok([commission('d-ecart', 'prevue')]),
      [TASKS]: ok([]),
      [BLOCKED]: ok([{ fileId: 'd-grille', code: 'no_grid' }, { fileId: 'd-ecart', code: 'honoraires' }, { fileId: 'd-autre', code: 'raison_inconnue' }]),
    });
    await t.voir();
    expect(t.by('h4').map((e) => e.textContent)).toEqual(['À trancher (3)']);
    expect(t.texts()).toContain('Dossier d-grille : aucune grille');
    expect(t.texts()).toContain('Dossier d-ecart : les honoraires de l’acte');
    expect(t.texts()).toContain('Dossier d-autre : la commission n’avance plus.');
    expect(t.texts()).not.toContain('en attente de l’acte');
    expect(t.state()).toBe('');
  });

  it('[R70] une échéance dépassée est dite', async () => {
    const t = await direction({ [TASKS]: ok([{ ...TASK, alerts: ['avant_echeance', 'echeance_depassee'] }]) });
    await t.voir();
    expect(t.texts()).toContain('Échéance dépassée.');
  });

  it('[R69] un écart sur une commission à verser retire aussi le geste', async () => {
    const t = await direction({ [COMMISSIONS]: ok([commission('d-ver', 'facturee', { feeCents: 1000001, payment: PAID })]) });
    await t.voir();
    expect(t.texts()).toContain('Écart de');
    expect(t.buttons('Rapporter le versement')).toEqual([]);
  });

  it('deux appuis trop rapprochés n’envoient rien ; sans suite la demande retombe ; pendant l’envoi, le bouton ne répond plus', async () => {
    const route = 'POST /v1/pilotage/dossiers/d-enc/encaissement';
    let release: (r: Response) => void = () => undefined;
    const t = await direction({ [route]: () => new Promise((r) => (release = r)) });
    await t.voir();
    const b = t.buttons('Rapporter l’encaissement')[0]!;
    t.fill(b, '2026-11-02T10:00', 'virement-77');
    await t.click(b);
    clock += 500;
    await t.click(b);
    expect(t.posts()).toEqual([]);
    clock += 20000;
    await t.click(b);
    expect(t.posts()).toEqual([]);
    clock += 2000;
    await t.click(b);
    expect(t.posts()).toHaveLength(1);
    await t.click(b);
    clock += 2000;
    await t.click(b);
    expect(t.posts()).toHaveLength(1);
    t.table[COMMISSIONS] = ok([]);
    t.table[TASKS] = ok([]);
    t.els.sortir!.listeners.click!({});
    await settle();
    release(Response.json({ ok: true, data: { payoutDueAt: '2026-11-03T15:00:00.000Z' } }));
    await settle();
    expect(t.state()).toBe('');
  });

  it('[R16] une liste qui tarde ne s’affiche pas après la déconnexion', async () => {
    let release: (r: Response) => void = () => undefined;
    const t = await direction();
    await t.voir();
    t.table[COMMISSIONS] = () => new Promise((r) => (release = r));
    t.els['commissions-voir']!.listeners.click!({});
    await settle();
    t.els.sortir!.listeners.click!({});
    await settle();
    release(Response.json({ ok: true, data: ALL }));
    await settle();
    expect(t.body().children).toEqual([]);
  });

  it('un geste réussi reste dit quand la relecture de la liste échoue', async () => {
    const t = await direction({ 'POST /v1/pilotage/dossiers/d-enc/encaissement': ok({ payoutDueAt: '2026-11-03T15:00:00.000Z' }) });
    await t.voir();
    const b = t.buttons('Rapporter l’encaissement')[0]!;
    t.fill(b, '2026-11-02T10:00', 'virement-77');
    await t.click(b);
    clock += 2000;
    t.table[COMMISSIONS] = no(500, { ok: false });
    await t.click(b);
    expect(t.state()).toContain('Encaissement rangé pour le dossier d-enc');
    expect(t.state()).toContain('Indisponible');
  });

  it('[R16] [R68] un agent ne demande jamais les commissions du réseau en se connectant', async () => {
    const t = await run('agent');
    await settle();
    expect(t.calls.filter((c) => c.url.includes('/pilotage/commissions') || c.url.includes('/pilotage/reversements'))).toEqual([]);
    expect(t.calls.filter((c) => c.url.includes('/a-trancher'))).toEqual([]);
    expect(t.els.reseau!.hidden).toBe(true);
  });

  it('aucune commission : c’est dit ; à la déconnexion, tout disparaît', async () => {
    const t = await direction({ [COMMISSIONS]: ok([]), [TASKS]: ok([]) });
    await t.voir();
    expect(t.state()).toContain('Aucune commission');
    t.table[COMMISSIONS] = ok(ALL);
    t.table[TASKS] = ok([TASK]);
    await t.voir();
    expect(t.body().children.length).toBeGreaterThan(0);
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
  });
});

describe('K13 · le chemin de chaque euro (Jamais vu)', () => {
  // Du point de vue d'un agent : ses seules parts, comme les rend le serveur [R68].
  const own = [{ kind: 'agent', beneficiaryId: 'alex', reason: null, amountCents: 500000 }];
  const steps = (...list: string[]) => list.map((status, i) => ({ status, at: `2026-1${i % 2}-0${i + 1}T10:00:00.000Z` }));
  const view = (fileId: string, extra: object) => ({ fileId, agentId: 'alex', compromisOn: '2026-09-01', feeCents: 1000000, feeCharge: 'vendeur', status: 'prevue', steps: steps('prevue'), shares: own, payment: null, signedOn: null, cancelled: false, ...extra });
  const receipt = { receivedAt: '2026-10-28T09:00:00.000Z', payoutDueAt: '2026-10-29T09:00:00.000Z', paidAt: null, late: null };

  async function agent(data: unknown[] | Answer) {
    const t = await run('agent', { [COMMISSIONS]: typeof data === 'function' ? data : ok(data) });
    const body = () => t.els['euros-corps']!;
    const state = () => t.els['euros-etat']!.textContent;
    const texts = () => body().all().map((e) => e.textContent).join(' | ');
    const voir = async () => {
      t.els['euros-voir']!.listeners.click!({});
      await settle();
      await t.load();
    };
    return { ...t, body, state, texts, voir };
  }

  it('[R68] [R14] l’agent suit ses parts seules, sans aucune comparaison ni route du réseau', async () => {
    const t = await agent([view('d-1', {})]);
    await t.voir();
    expect(t.texts()).toContain('Dossier d-1 : ma part');
    expect(t.texts()).not.toMatch(/rang|classement|moyenne|meilleur|Part du réseau/i);
    expect(t.calls.filter((c) => c.url.includes('/reversements') || c.url.includes('/a-trancher') || c.url.includes('/pilotage/reseau'))).toEqual([]);
  });

  it('les cinq étapes du chemin sont dites, faites ou non', async () => {
    const t = await agent([view('d-1', { status: 'facturee', steps: steps('prevue', 'due', 'facturee'), payment: receipt })]);
    await t.voir();
    const way = t.body().all().filter((e) => e.tagName === 'ol')[0]!.children;
    expect(way.map((e) => e.textContent.split(' : ')[0])).toEqual(['Compromis signé', 'Acte signé', 'Facture émise', 'Honoraires encaissés par le réseau', 'Versée sur mon compte']);
    expect(way[3]!.textContent).toContain(' : le ');
    // Les jours signés, pas l'heure où le passage les a vus.
    expect(way[0]!.textContent).toContain('01/09/2026');
    expect(way[1]!.textContent).toContain('pas encore');
    expect(t.texts()).not.toContain('Acte signé : le');
    expect(way[4]!.textContent).toContain('pas encore');
  });

  it('le jour de l’acte vient de l’acte rapporté', async () => {
    const t = await agent([view('d-1', { status: 'due', steps: steps('prevue', 'due'), signedOn: '2026-10-15' })]);
    await t.voir();
    const way = t.body().all().filter((e) => e.tagName === 'ol')[0]!.children;
    expect(way[1]!.textContent).toContain('15/10/2026');
  });

  it('[R70] l’heure limite vient du serveur : avant elle, promesse ; après, dépassement dit', async () => {
    const limit = '2026-10-29T09:00:00.000Z';
    clock = Date.parse('2026-10-28T12:00:00.000Z');
    const t = await agent([view('d-1', { status: 'facturee', payment: { ...receipt, payoutDueAt: limit } })]);
    await t.voir();
    expect(t.texts()).toContain('Promesse : versée au plus tard le');
    expect(t.texts()).not.toContain('dépassée');
    clock = Date.parse('2026-10-29T09:00:01.000Z');
    await t.voir();
    expect(t.texts()).toContain('Heure limite dépassée');
    // Une autre heure limite du serveur change ce qui est dit : l'écran ne la recalcule pas.
    t.table[COMMISSIONS] = ok([view('d-1', { status: 'facturee', payment: { ...receipt, payoutDueAt: '2026-11-20T09:00:00.000Z' } })]);
    await t.voir();
    expect(t.texts()).toContain('Promesse : versée au plus tard le');
  });

  it('[R70] tenue ou non, la promesse est dite une fois le versement rangé', async () => {
    const t = await agent([
      view('d-1', { status: 'payee', payment: { ...receipt, paidAt: '2026-10-28T15:00:00.000Z', late: false } }),
      view('d-2', { status: 'payee', payment: { ...receipt, paidAt: '2026-10-30T15:00:00.000Z', late: true } }),
    ]);
    await t.voir();
    expect(t.texts()).toContain('Versée dans les 24 h ouvrées promises.');
    expect(t.texts()).toContain('la promesse n’a pas été tenue');
  });

  it('[R69] les totaux refont la somme des lignes, au centime, même avec plusieurs parts sur un dossier', async () => {
    const t = await agent([
      view('d-1', { status: 'payee', shares: [{ kind: 'agent', beneficiaryId: 'alex', reason: null, amountCents: 100001 }, { kind: 'parrainage', beneficiaryId: 'alex', reason: null, amountCents: 50 }], payment: { ...receipt, paidAt: '2026-10-28T15:00:00.000Z', late: false } }),
      view('d-2', { status: 'due', shares: [{ kind: 'partage', beneficiaryId: 'alex', reason: 'binome', amountCents: 200002 }] }),
      view('d-3', { status: 'facturee', shares: [{ kind: 'agent', beneficiaryId: 'alex', reason: null, amountCents: 300003 }], payment: receipt }),
      view('d-4', { status: 'facturee', cancelled: true, shares: [{ kind: 'agent', beneficiaryId: 'alex', reason: null, amountCents: 700 }] }),
    ]);
    await t.voir();
    const total = t.body().children[0]!.textContent;
    const spaced = (s: string) => s.replace(/\s/g, ' ');
    expect(spaced(total)).toContain('Versé : 1 000,51');
    expect(spaced(total)).toContain('À venir : 5 000,05');
    expect(spaced(total)).toContain('Annulé : 7,00');
    expect(t.texts()).toContain('Vente annulée par un avoir');
  });

  it('[R69] AU092 · la vente sous grille à paliers dit le cumul de l’année, le palier et son taux', async () => {
    const t = await agent([view('d-1', { tier: { year: 2027, cumulCents: 2_000_000, tierSeq: 2, fromCents: 1_500_000, rateBp: 6000 } }), view('d-2', {})]);
    await t.voir();
    const spaced = t.texts().replace(/\s/g, ' ');
    expect(spaced).toContain('Grille à paliers : palier 2 (à partir de 15 000,00');
    expect(spaced).toContain('soit 60 % ; chiffre d’affaires 2027 déjà compté avant cette vente : 20 000,00');
  });

  it('un versement rangé dont l’étape a manqué compte comme versé', async () => {
    const t = await agent([view('d-1', { status: 'facturee', payment: { ...receipt, paidAt: '2026-10-28T15:00:00.000Z', late: false } })]);
    await t.voir();
    expect(t.body().children[0]!.textContent).toMatch(/^Versé : 5.000,00/);
  });

  it('[R16] aucune commission, refus, hors réseau : dits ; à la déconnexion, tout disparaît', async () => {
    const t = await agent([]);
    await t.voir();
    expect(t.state()).toContain('Aucune commission');
    t.table[COMMISSIONS] = no(403, { ok: false, rule: 'R16', code: 'role' });
    await t.voir();
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
    t.table[COMMISSIONS] = async () => Promise.reject(new TypeError('hors ligne'));
    await t.voir();
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    t.table[COMMISSIONS] = ok([view('d-1', {})]);
    await t.voir();
    expect(t.body().children.length).toBeGreaterThan(0);
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.state()).toBe('');
  });
});

describe('K12 · grille, alertes, factures et avoirs', () => {
  const GRID = 'GET /v1/pilotage/grille';
  const SETTINGS = 'GET /v1/pilotage/reglages';
  const INVOICES = 'GET /v1/pilotage/factures';
  const grid = { version: 2, inForce: { version: 2, validFrom: '2026-09-01', defaultRateBp: 7000 }, upcoming: [] as object[], agents: [{ agentId: 'alex', name: 'Alex Essai', rateBp: 7500 }, { agentId: 'sam', name: 'Sam Essai', rateBp: null }] };
  const set = { aiMonthlyBudgetCents: 10000, aiAlertBp: 7000, dropAlertBp: 3000, documentNoticeDays: 30 };
  const invoice = (id: string, label: string, kind: string, corrects: string | null = null) => ({
    id,
    fileId: 'd-1',
    issuer: 'reseau',
    content: { label, kind, issuedOn: '2026-10-20', issuer: 'Réseau essai', recipient: 'Client essai', designation: 'x', htCents: 100000, vatBp: 2000, vatCents: 20000, ttcCents: 120000, mentions: [], corrects, saleDay: null, reason: null },
    transmitted: { mode: 'essai', platformRef: 'ref-1' },
  });
  async function direct(answers: Record<string, Answer> = {}) {
    const t = await run('direction', { [GRID]: ok(grid), [SETTINGS]: ok(set), [INVOICES]: ok([invoice('f-1', 'F-1', 'honoraires')]), ...answers });
    const load = t.load;
    const open = async (id: string) => {
      t.els[id]!.listeners.click!({});
      await settle();
      await load();
    };
    const of = (id: string) => t.els[id]!.all();
    const inputs = () => of('grille-corps').filter((e) => e.tagName === 'input');
    const press = async (host: string, text: string) => {
      const b = of(host).find((e) => e.tagName === 'button' && e.textContent === text);
      if (!b) throw new Error(`bouton absent : ${text}`);
      b.listeners.click!({});
      await settle();
      return b;
    };
    const said = (host: string) => of(host).filter((e) => e.tagName === 'p').map((e) => e.textContent).join(' | ');
    return { ...t, open, of, inputs, press, said };
  }

  it('DS057 · un taux propre nomme son agent par son prénom et son nom, jamais par son identifiant', async () => {
    const id = 'acf2c1b2-2d19-49c6-b889-ea38885db2be';
    const t = await direct({ [GRID]: ok({ ...grid, agents: [{ agentId: id, name: 'Alex Essai', rateBp: 7500 }, { agentId: 'b7d0a1c4-0000-4000-8000-000000000001', name: null, rateBp: null }] }), 'POST /v1/pilotage/grille': ok({ version: 3 }) });
    await t.open('grille-voir');
    const labels = t.of('grille-corps').filter((e) => e.tagName === 'label').map((e) => e.textContent);
    expect(labels).toContain('Taux propre à Alex Essai, en % (vide : le taux commun)');
    expect(labels).toContain('Taux propre à un agent dont le nom manque, en % (vide : le taux commun)');
    expect(t.of('grille-corps').map((e) => e.textContent).join(' ')).not.toMatch(/acf2c1b2|b7d0a1c4/);
    // L'identifiant reste ce qui part au serveur.
    const [from] = t.inputs();
    from!.value = '2027-01-01';
    await t.press('grille-corps', 'Ranger cette version');
    expect(JSON.parse(t.bodies().at(-1)!).agents).toEqual([{ agentId: id, rateBp: 7500 }]);
  });

  it('[R17] une nouvelle version part de la dernière : aucun taux propre ne se perd en silence', async () => {
    const t = await direct({ 'POST /v1/pilotage/grille': ok({ version: 3 }) });
    await t.open('grille-voir');
    const [from, rate, alex, sam] = t.inputs();
    expect(rate!.value).toBe('70');
    expect(alex!.value).toBe('75');
    expect(sam!.value).toBe('');
    from!.value = '2027-01-01';
    await t.press('grille-corps', 'Ranger cette version');
    expect(JSON.parse(t.bodies().at(-1)!)).toEqual({ validFrom: '2027-01-01', defaultRateBp: 7000, agents: [{ agentId: 'alex', rateBp: 7500 }], expectedVersion: 2 });
    expect(t.els['grille-etat']!.textContent).toContain('Nouvelle version de la grille rangée');
  });

  it('une virgule et des décimales passent en points de base ; un taux hors bornes ne part pas', async () => {
    const t = await direct({ 'POST /v1/pilotage/grille': ok({ version: 3 }) });
    await t.open('grille-voir');
    const [from, rate] = t.inputs();
    const posts = () => t.calls.filter((c) => c.method === 'POST');
    await t.press('grille-corps', 'Ranger cette version');
    expect(t.said('grille-corps')).toContain('Choisissez un jour valide.');
    from!.value = '2027-01-01';
    for (const bad of ['101', 'beaucoup', '-5', '']) {
      rate!.value = bad;
      await t.press('grille-corps', 'Ranger cette version');
      expect(t.said('grille-corps')).toContain('Un taux va de 0 à 100 %.');
    }
    expect(posts()).toEqual([]);
    rate!.value = '70,5';
    await t.press('grille-corps', 'Ranger cette version');
    expect(JSON.parse(t.bodies().at(-1)!).defaultRateBp).toBe(7050);
  });

  it('une date passée refusée par le serveur est dite en français', async () => {
    const t = await direct({ 'POST /v1/pilotage/grille': no(400, { ok: false, rule: null, code: 'past_day' }) });
    await t.open('grille-voir');
    t.inputs()[0]!.value = '2020-01-01';
    await t.press('grille-corps', 'Ranger cette version');
    expect(t.said('grille-corps')).toContain('Une grille ne vaut que pour l’avenir');
  });

  it('[R17] ce qui est en vigueur et ce qui est programmé sont dits ; un formulaire périmé est refusé en français', async () => {
    const t = await direct({
      [GRID]: ok({ ...grid, version: 4, upcoming: [{ version: 4, validFrom: '2027-01-01', defaultRateBp: 6500 }] }),
      'POST /v1/pilotage/grille': no(400, { ok: false, rule: null, code: 'stale_grid' }),
    });
    await t.open('grille-voir');
    expect(t.said('grille-corps')).toContain('En vigueur : Version 2, 70 %');
    expect(t.said('grille-corps')).toContain('Déjà programmée : Version 4, 65 %');
    t.inputs()[0]!.value = '2027-02-01';
    await t.press('grille-corps', 'Ranger cette version');
    expect(JSON.parse(t.bodies().at(-1)!).expectedVersion).toBe(4);
    expect(t.said('grille-corps')).toContain('Une autre version vient d’être rangée');
  });

  it('une réponse perdue ne prétend jamais que rien n’est rangé', async () => {
    const t = await direct({ 'POST /v1/pilotage/grille': async () => Promise.reject(new TypeError('hors ligne')), 'POST /v1/pilotage/reglages': no(500, { ok: false }) });
    await t.open('grille-voir');
    t.inputs()[0]!.value = '2027-02-01';
    await t.press('grille-corps', 'Ranger cette version');
    expect(t.said('grille-corps')).toContain('Réponse perdue : cette version est peut-être rangée.');
    await t.press('grille-corps', 'Ranger ces alertes');
    expect(t.said('grille-corps')).toContain('Réponse perdue : ces alertes sont peut-être rangées.');
    expect(t.said('grille-corps')).not.toContain('rien n’est rangé');
  });

  it('un geste réussi reste dit quand la relecture échoue', async () => {
    const t = await direct({ 'POST /v1/pilotage/grille': ok({ version: 3 }), 'POST /v1/pilotage/factures/f-1/avoir': ok({ content: { label: 'A-1' } }) });
    await t.open('grille-voir');
    t.inputs()[0]!.value = '2027-02-01';
    t.table[GRID] = no(500, { ok: false });
    await t.press('grille-corps', 'Ranger cette version');
    expect(t.els['grille-etat']!.textContent).toContain('Nouvelle version de la grille rangée');
    expect(t.els['grille-etat']!.textContent).toContain('Indisponible');
    await t.open('factures-voir');
    const b = await t.press('factures-corps', 'Corriger par un avoir');
    clock += 2000;
    t.table[INVOICES] = async () => Promise.reject(new TypeError('hors ligne'));
    b.listeners.click!({});
    await settle();
    expect(t.els['factures-etat']!.textContent).toContain('Avoir émis en mode essai : A-1.');
  });

  it('aucune grille : dit, car aucune commission ne peut naître', async () => {
    const t = await direct({ [GRID]: ok({ version: null, inForce: null, upcoming: [], agents: [] }) });
    await t.open('grille-voir');
    expect(t.said('grille-corps')).toContain('aucune commission ne peut naître');
  });

  it('[R16] sans la dernière version, aucun formulaire : rien ne peut écraser une grille à l’aveugle', async () => {
    const t = await direct({ [GRID]: no(500, { ok: false }) });
    await t.open('grille-voir');
    expect(t.inputs()).toEqual([]);
    expect(t.els['grille-etat']!.textContent).toBe('Indisponible pour le moment. Réessayez plus tard.');
    t.table[GRID] = no(403, { ok: false, rule: 'R16', code: 'role' });
    await t.open('grille-voir');
    expect(t.els['grille-etat']!.textContent).toBe('Ce n’est pas dans vos droits.');
  });

  it('les alertes se règlent : euros en centimes, vide sans plafond, bornes dites', async () => {
    const t = await direct({ 'POST /v1/pilotage/reglages': ok({ version: 2 }) });
    await t.open('grille-voir');
    const all = t.inputs();
    const [budget, ai, , notice] = all.slice(-4);
    expect(budget!.value).toBe('100');
    expect(notice!.value).toBe('30');
    budget!.value = '150,50';
    await t.press('grille-corps', 'Ranger ces alertes');
    expect(JSON.parse(t.bodies().at(-1)!)).toEqual({ aiMonthlyBudgetCents: 15050, aiAlertBp: 7000, dropAlertBp: 3000, documentNoticeDays: 30 });
    expect(t.said('grille-corps')).toContain('Alertes rangées.');
    budget!.value = '';
    await t.press('grille-corps', 'Ranger ces alertes');
    expect(JSON.parse(t.bodies().at(-1)!).aiMonthlyBudgetCents).toBeNull();
    const before = t.bodies().length;
    budget!.value = '0';
    await t.press('grille-corps', 'Ranger ces alertes');
    expect(t.said('grille-corps')).toContain('Le budget doit être');
    budget!.value = '';
    ai!.value = '150';
    await t.press('grille-corps', 'Ranger ces alertes');
    expect(t.said('grille-corps')).toContain('Un seuil va de 0,01 à 100 %.');
    ai!.value = '0';
    await t.press('grille-corps', 'Ranger ces alertes');
    expect(t.said('grille-corps')).toContain('Un seuil va de 0,01 à 100 %.');
    ai!.value = '70';
    notice!.value = '500';
    await t.press('grille-corps', 'Ranger ces alertes');
    expect(t.said('grille-corps')).toContain('Le préavis va de 1 à 365 jours.');
    expect(t.bodies()).toHaveLength(before);
  });

  it('[R71] un avoir se confirme en deux appuis, avec sa raison, et ne touche pas la facture', async () => {
    const t = await direct({ 'POST /v1/pilotage/factures/f-1/avoir': ok({ content: { label: 'A-1' } }) });
    await t.open('factures-voir');
    expect(t.of('factures-corps').map((e) => e.textContent).join(' ')).toContain('Honoraires F-1');
    const b = await t.press('factures-corps', 'Corriger par un avoir');
    expect(t.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(t.said('factures-corps')).toContain('Un avoir ne se reprend pas');
    b.listeners.click!({});
    await settle();
    expect(t.calls.filter((c) => c.method === 'POST')).toEqual([]);
    clock += 2000;
    t.table[INVOICES] = ok([invoice('f-1', 'F-1', 'honoraires'), invoice('a-1', 'A-1', 'avoir', 'F-1')]);
    b.listeners.click!({});
    await settle();
    expect(JSON.parse(t.bodies().at(-1)!)).toEqual({ reason: 'erreur_montant' });
    expect(t.els['factures-etat']!.textContent).toContain('Avoir émis en mode essai : A-1.');
    const rows = t.of('factures-corps').map((e) => e.textContent).join(' | ');
    expect(rows).toContain('Corrigée par un avoir.');
    expect(rows).toContain('Corrige la facture F-1.');
    // Ni la facture corrigée ni l'avoir n'offrent un nouvel avoir.
    expect(t.of('factures-corps').filter((e) => e.textContent === 'Corriger par un avoir')).toEqual([]);
  });

  it('[R71] la vente annulée prévient de ce qu’elle arrête, et les refus sont dits', async () => {
    const route = 'POST /v1/pilotage/factures/f-1/avoir';
    const t = await direct({ [route]: no(400, { ok: false, rule: null, code: 'busy' }) });
    await t.open('factures-voir');
    t.of('factures-corps').find((e) => e.tagName === 'select')!.value = 'vente_annulee';
    const b = await t.press('factures-corps', 'Corriger par un avoir');
    expect(t.said('factures-corps')).toContain('La vente sera dite annulée');
    clock += 2000;
    b.listeners.click!({});
    await settle();
    expect(t.said('factures-corps')).toContain('Une autre facture est en cours');
    t.table[route] = async () => Promise.reject(new TypeError('hors ligne'));
    b.listeners.click!({});
    await settle();
    clock += 2000;
    b.listeners.click!({});
    await settle();
    expect(t.said('factures-corps')).toContain('Réponse perdue : l’avoir est peut-être émis.');
    t.table[route] = no(400, { ok: false, rule: null, code: 'already' });
    t.table[INVOICES] = ok([invoice('f-1', 'F-1', 'honoraires'), invoice('a-1', 'A-1', 'avoir', 'F-1')]);
    clock += 2000;
    b.listeners.click!({});
    await settle();
    clock += 2000;
    b.listeners.click!({});
    await settle();
    expect(t.els['factures-etat']!.textContent).toBe('Cette facture a déjà son avoir.');
  });

  it('[R13] l’export part avec la clé dans l’en-tête, jamais dans l’adresse ; une période fausse ne part pas', async () => {
    const route = 'GET /v1/pilotage/factures/export?du=2026-10-01&au=2026-10-31';
    const t = await direct({ [route]: async () => new Response('a;b', { status: 500 }) });
    t.els['factures-du']!.value = '2026-10-31';
    t.els['factures-au']!.value = '2026-10-01';
    await t.open('factures-export');
    expect(t.els['factures-export-etat']!.textContent).toContain('Choisissez une période');
    t.els['factures-du']!.value = '2026-10-01';
    t.els['factures-au']!.value = '2026-10-31';
    t.els['factures-export']!.listeners.click!({});
    await settle();
    const call = t.calls.find((c) => c.url.includes('/factures/export'))!;
    expect(call.auth).toContain(KEY);
    expect(call.url).not.toContain(KEY);
    expect(t.els['factures-export-etat']!.textContent).toBe('Export indisponible. Réessayez plus tard.');
  });

  it('[R16] à la déconnexion, grille, factures et période disparaissent', async () => {
    const t = await direct();
    await t.open('grille-voir');
    await t.open('factures-voir');
    t.els['factures-du']!.value = '2026-10-01';
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.els['grille-corps']!.children).toEqual([]);
    expect(t.els['factures-corps']!.children).toEqual([]);
    expect(t.els['factures-du']!.value).toBe('');
  });

  it('[R16] un agent ne demande ni la grille, ni les réglages, ni les factures du réseau', async () => {
    const t = await run('agent');
    await settle();
    expect(t.calls.filter((c) => /pilotage\/(grille|reglages|factures)/.test(c.url))).toEqual([]);
  });

  it('[R201] l’application et le script tiennent leur budget', () => {
    expect(budgetProblems({ html: '', js: FINANCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });
});
