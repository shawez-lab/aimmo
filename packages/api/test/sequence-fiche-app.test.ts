import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { FicheClient, applyMigrations, fromSyncSqlite } from '../../core/src/index.ts';
import { BIENS_FICHE_SCRIPT } from '../app/biens-fiche.ts';
import { SEQUENCE_CHANNEL_LABELS, SEQUENCE_FICHE_SCRIPT, SEQUENCE_REFUSALS } from '../app/sequence-fiche.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : fiche, prénom, textes, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const ID = '0b6f1d2e-5555-4a2b-8c3d-000000000034';
const INJECTED = '<img src=x onerror="alert(1)">';
const FICHE = (allowed: boolean) => ({
  personId: ID,
  firstName: 'Client',
  lastName: 'Essai',
  contact: { allowed, reasons: allowed ? [] : ['stop'] },
  call: null,
  callRefusal: 'no_phone',
  callClosesAt: null,
  callbacks: [],
  projects: [],
  sources: [],
  qualification: null,
  messages: [],
});
const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: ID, firstName: 'Client', kind: 'callback', reason: 'Rappel', callbackDueAt: null }] };
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

async function opened(options: { allowed?: boolean; post?: Answer } = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { url: string; method: string; body: any; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
    'GET /v1/plan-du-jour': ok(PLAN),
    'GET /v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
    'GET /v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
    [`GET /v1/fiches/${ID}/resume`]: ok(FICHE(options.allowed ?? true)),
    [`GET /v1/fiches/${ID}/biens`]: ok([]),
    ...(options.post ? { 'POST /v1/sequences': options.post } : {}),
  };
  let keys = 0;
  const context: Record<string, unknown> = {
    document,
    Date,
    Object,
    crypto: { randomUUID: () => `0b6f1d2e-6666-4a2b-8c3d-${String(++keys).padStart(12, '0')}` },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  const tick = async () => {
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  const named = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  named(els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
  await tick();
  const body = els['fiche-corps']!;
  const scripts = (src: string) => body.all().filter((e) => e.tagName === 'script' && e.attributes.src === src);
  runInNewContext(BIENS_FICHE_SCRIPT, context);
  for (const s of scripts('/app/biens-fiche.js')) s.listeners.load!({});
  await tick();
  const section = () => body.all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Séquence de prospection');
  const callsBefore = calls.length;
  const open = async () => {
    named(section()!, 'Préparer une séquence')[0]!.listeners.click!({});
    await tick();
    runInNewContext(SEQUENCE_FICHE_SCRIPT, context);
    for (const s of scripts('/app/sequence-fiche.js')) s.listeners.load!({});
    await tick();
  };
  const click = async (text: string, n = 0) => {
    const b = named(section()!, text)[n];
    if (!b) throw new Error(`bouton absent : ${text}`);
    b.listeners.click!({});
    await tick();
  };
  const controls = (tag: string, suffix: string) => section()!.all().filter((e) => e.tagName === tag && (e.attributes.id ?? '').endsWith(suffix));
  const setChannel = (n: number, value: string) => {
    const s = controls('select', '-canal')[n]!;
    s.value = value;
    s.listeners.change!({});
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { calls, callsBefore, body, section, scripts, open, click, controls, setChannel, posts, tick, named };
}

describe('BR34 · préparer une séquence de prospection depuis la fiche', () => {
  it('[R201] le script est servi à part, chargé seulement au geste, et tient le budget d’une page ; l’application tient le sien sans le connaître', async () => {
    const t = await opened();
    expect(t.section()).toBeDefined();
    expect(t.scripts('/app/sequence-fiche.js')).toEqual([]);
    expect(t.calls.slice(t.callsBefore).filter((c) => c.url.startsWith('/v1/sequences'))).toEqual([]);
    await t.open();
    expect(t.scripts('/app/sequence-fiche.js')).toHaveLength(1);
    expect(t.controls('select', '-canal')).toHaveLength(1);
    expect(AGENT_APP_FILES['/app/sequence-fiche.js']).toBe(SEQUENCE_FICHE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/sequence-fiche.js');
    expect(JS).not.toContain('sequence-fiche');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/sequence-fiche.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(budgetProblems({ html: '', js: SEQUENCE_FICHE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: BIENS_FICHE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });

  it('[R301] une fiche exclue ou arrêtée n’a pas le bouton', async () => {
    const t = await opened({ allowed: false });
    expect(t.body.textContent).toContain('Biens du client');
    expect(t.section()).toBeUndefined();
    expect(t.named(t.body, 'Préparer une séquence')).toEqual([]);
  });

  it('[R300] [R26] aucun envoi : la séquence part par une seule route, la clé dans l’en-tête ; l’écran dit que mails et SMS partent seuls par le contrôle central', async () => {
    const t = await opened({ post: ok({ sequenceId: 's1' }) });
    await t.open();
    expect(t.section()!.textContent).toContain('Rien ne part d’ici. Les mails et SMS partent seuls à leur jour, par le contrôle central');
    // Étape 1 : un courrier tout de suite ; étape 2 : un mail trois jours après, avec le texte de l'agent ; étape 3 : un appel.
    expect(t.controls('textarea', '-texte')).toEqual([]);
    await t.click('Ajouter une étape');
    expect(t.controls('input', '-jour').map((i) => i.value)).toEqual(['0', '3']);
    t.setChannel(1, 'email');
    t.controls('textarea', '-texte')[0]!.value = '  Bonjour, votre rue intéresse des acheteurs.  ';
    await t.click('Ajouter une étape');
    t.setChannel(2, 'phone');
    t.controls('input', '-jour')[2]!.value = '10';
    const b = t.named(t.section()!, 'Préparer la séquence')[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await t.tick();
    expect(t.posts()).toEqual([
      {
        url: '/v1/sequences',
        method: 'POST',
        auth: `Bearer ${KEY}`,
        body: {
          personId: ID,
          steps: [
            { channel: 'letter', afterDays: 0 },
            { channel: 'email', afterDays: 3, text: 'Bonjour, votre rue intéresse des acheteurs.' },
            { channel: 'phone', afterDays: 10 },
          ],
        },
      },
    ]);
    expect(t.section()!.textContent).toContain('Séquence préparée, 3 étape(s), en mode essai : rien n’est parti.');
    const routes = [...SEQUENCE_FICHE_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]);
    expect(routes).toEqual(['/v1/sequences']);
    expect(SEQUENCE_FICHE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
  });

  it('un texte n’existe que pour un mail ou un SMS ; huit étapes au plus ; une étape se retire', async () => {
    const t = await opened();
    await t.open();
    t.setChannel(0, 'sms');
    expect(t.controls('textarea', '-texte')).toHaveLength(1);
    t.setChannel(0, 'door');
    expect(t.controls('textarea', '-texte')).toEqual([]);
    for (let i = 0; i < 10; i++) await t.click('Ajouter une étape');
    expect(t.controls('select', '-canal')).toHaveLength(8);
    expect(t.controls('input', '-jour').map((i) => i.value)).toEqual(['0', '3', '6', '9', '12', '15', '18', '21']);
    await t.click('Retirer cette étape', 7);
    expect(t.controls('select', '-canal')).toHaveLength(7);
    expect(Object.keys(SEQUENCE_CHANNEL_LABELS).sort()).toEqual(['door', 'email', 'letter', 'phone', 'sms']);
  });

  it('une saisie fausse se dit avant tout appel', async () => {
    const t = await opened({ post: ok({ sequenceId: 's1' }) });
    await t.open();
    const say = () => t.section()!.all().find((e) => e.attributes.role === 'status' && e.textContent !== '')?.textContent ?? '';
    await t.click('Ajouter une étape');
    t.controls('input', '-jour')[1]!.value = '91';
    await t.click('Préparer la séquence');
    expect(say()).toBe(`Étape 2 : ${SEQUENCE_REFUSALS.after_days}`);
    t.controls('input', '-jour')[0]!.value = '5';
    t.controls('input', '-jour')[1]!.value = '2';
    await t.click('Préparer la séquence');
    expect(say()).toBe(`Étape 2 : ${SEQUENCE_REFUSALS.after_days}`);
    t.controls('input', '-jour')[1]!.value = 'demain';
    await t.click('Préparer la séquence');
    expect(say()).toBe(`Étape 2 : ${SEQUENCE_REFUSALS.after_days}`);
    t.controls('input', '-jour')[1]!.value = '7';
    t.setChannel(1, 'email');
    await t.click('Préparer la séquence');
    expect(say()).toBe(`Étape 2 : ${SEQUENCE_REFUSALS.text}`);
    t.controls('textarea', '-texte')[0]!.value = 'x'.repeat(1001);
    await t.click('Préparer la séquence');
    expect(say()).toBe(`Étape 2 : ${SEQUENCE_REFUSALS.text}`);
    // Huit textes permis un à un, mais trop lourds ensemble pour la route (16 ko en UTF-8) : dit avant tout appel.
    for (let i = 0; i < 6; i++) await t.click('Ajouter une étape');
    for (let i = 0; i < 8; i++) t.setChannel(i, 'sms');
    t.controls('input', '-jour').forEach((d, i) => (d.value = String(i)));
    for (const x of t.controls('textarea', '-texte')) x.value = 'é'.repeat(1000);
    await t.click('Préparer la séquence');
    expect(say()).toBe(SEQUENCE_REFUSALS.invalid_body);
    expect(t.posts()).toEqual([]);
  });

  it('chaque refus connu a ses mots, aucun code n’est montré ; une réponse perdue se réessaie sans doubler', async () => {
    for (const [code, words] of Object.entries(SEQUENCE_REFUSALS)) {
      const t = await opened({ post: no(code === 'role' ? 403 : 409, { ok: false, rule: 'HX20', code }) });
      await t.open();
      await t.click('Préparer la séquence');
      expect(t.section()!.textContent).toContain(words);
      expect(t.section()!.textContent).not.toMatch(new RegExp(`(^|[^A-Za-zÀ-ÿ_])${code}($|[^A-Za-zÀ-ÿ_])`));
    }
    const lost = await opened({ post: async () => new Response('panne', { status: 502 }) });
    await lost.open();
    await lost.click('Préparer la séquence');
    expect(lost.section()!.textContent).toContain('La réponse n’est pas arrivée : la séquence est peut-être préparée. Réessayer ne la doublera pas');
    const odd = await opened({ post: no(409, { ok: false, rule: 'R99', code: `nouveau_${INJECTED}` }) });
    await odd.open();
    await odd.click('Préparer la séquence');
    expect(odd.section()!.textContent).toContain('La séquence n’est pas préparée : relisez les étapes, puis réessayez.');
    expect(odd.section()!.textContent).not.toContain('nouveau_');
  });

  it('les mots couvrent chaque refus que prépare la couche métier', () => {
    const core = readFileSync(new URL('../../core/src/sequence-prospection/sequence.ts', import.meta.url), 'utf8');
    const start = core.slice(core.indexOf('async start('), core.indexOf('async start(') + 6000);
    const codes = [...start.matchAll(/this\.refuse\(viewer, [^,]+, '[A-Z0-9]+', '([a-z_]+)'\)/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(6);
    for (const c of codes) expect(SEQUENCE_REFUSALS[c], c).toBeDefined();
    const reasons = /export type EndReason = ([^;]+);/.exec(core)![1]!.match(/'([a-z_]+)'/g)!.map((r) => r.slice(1, -1));
    // Une séquence refusée par un envoi s'arrête en cours de route : elle n'est jamais une raison de ne pas la préparer.
    for (const r of reasons.filter((x) => x !== 'refused_send')) expect(SEQUENCE_REFUSALS[`opposition_${r}`], r).toBeDefined();
  });
});

describeWithSqlite('BR34 · ce que l’écran envoie, la route l’accepte', () => {
  it('[R300] le corps préparé par l’écran est rangé tel quel, rien ne part', async () => {
    const db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const now = () => new Date('2027-06-08T09:00:00.000Z');
    const store = new FicheClient(db, { now });
    const net = await store.createNetwork('Réseau test');
    const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Essai' });
    const person = await store.createPerson({ networkId: net.id, agentId: alex.id, firstName: 'Léa', lastName: 'Inventée' });
    const key = 'test-cle-br34-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const config: ApiConfig = { db, apiKeys: JSON.stringify([{ sha256: await sha256Hex(key), networkId: net.id, role: 'agent', userId: alex.id }]), mode: 'essai', now };
    const t = await opened({ post: ok({ sequenceId: 's1' }) });
    await t.open();
    await t.click('Ajouter une étape');
    t.setChannel(1, 'door');
    await t.click('Préparer la séquence');
    const sent = t.posts()[0]!.body;
    const r = await handleRequest(
      new Request('https://aimmo-api.example.test/v1/sequences', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...sent, personId: person.id }) }),
      config,
    );
    expect(r.status).toBe(200);
    expect(await db.all('SELECT position, channel, after_days FROM prospecting_sequence_steps ORDER BY position')).toEqual([
      { position: 1, channel: 'letter', after_days: 0 },
      { position: 2, channel: 'door', after_days: 3 },
    ]);
    expect((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM messages'))!.n).toBe(0);
  });
});
