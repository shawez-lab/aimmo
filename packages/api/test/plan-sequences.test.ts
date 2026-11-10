import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FicheClient, PlansDuJour, SqlJournalStore, applyMigrations, fromSyncSqlite, type Channel, type SqlDatabase } from '../../core/src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Un mardi à Paris. Réseau, agents, personnes, numéros, adresses et clés d'API inventés.
const TUESDAY_8H = Date.parse('2027-06-08T06:00:00.000Z');
const HOUR = 3_600_000;
const KEYS = {
  alex: 'test-cle-br32-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-br32-direction-cccccccccccccccccccccc',
};
type Who = keyof typeof KEYS;

async function setup(options: { consents?: { channel: Channel; purpose: string }[] } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_8H;
  const now = () => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: net.id, agentId: alex.id, firstName: 'Léa', lastName: 'Inventée' });
  await store.addIdentifier({ networkId: net.id, personId: person.id, kind: 'phone', value: '06 00 00 00 01' });
  await store.addIdentifier({ networkId: net.id, personId: person.id, kind: 'email', value: 'lea@exemple.test' });
  const consents = options.consents ?? [
    { channel: 'email', purpose: 'prospecting' },
    { channel: 'phone', purpose: 'prospecting' },
  ];
  for (const c of consents) await store.addConsent({ networkId: net.id, personId: person.id, purpose: c.purpose, channel: c.channel, proof: 'accord de test', givenAt: new Date(TUESDAY_8H - 10 * 24 * HOUR) });
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex.id }, direction: { role: 'direction', userId: 'direction-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: net.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
  const http = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, init), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const freeze = async () => new PlansDuJour(db, journal, { now }).freezeAll();
  const stored = async () => (await db.first<{ items: string }>('SELECT items FROM daily_plans'))!.items;
  return { db, journal, store, net, person, http, freeze, stored, at: (t: number) => { clock = t; } };
}

describeWithSqlite('BR32 · les étapes des séquences dans le plan du jour', () => {
  it('[R301] les étapes du jour sont lues à la lecture du plan, jamais rangées dans le plan figé ; une demande d’arrêt depuis 7 h 30 les retire', async () => {
    const t = await setup();
    expect(await t.freeze()).toEqual({ frozen: 1, already: 0 });
    const before = await t.stored();
    // Rien n'est encore préparé : le plan n'a aucune étape.
    t.at(TUESDAY_8H + 3 * HOUR);
    expect((await t.http('alex', 'GET', '/plan-du-jour')).body.data.sequenceSteps).toEqual([]);
    const id = (await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: [{ channel: 'letter', afterDays: 0 }, { channel: 'email', afterDays: 2, text: 'Bonjour Léa, je reviens vers vous.' }] })).body.data.sequenceId as string;
    const read = await t.http('alex', 'GET', '/plan-du-jour');
    expect(read.status).toBe(200);
    expect(read.body.data.sequenceSteps).toEqual([expect.objectContaining({ sequenceId: id, channel: 'letter', action: 'letter', proposed: true, firstName: 'Léa', personId: t.person.id })]);
    // Le plan rangé à 7 h 30 n'a pas changé.
    expect(await t.stored()).toBe(before);
    expect(before).not.toContain(id);
    // Une demande d'arrêt : l'étape n'est plus au plan, la séquence est arrêtée sur tous les canaux.
    await t.store.addExclusion({ networkId: t.net.id, personId: t.person.id, reason: 'stop', channel: 'email', notedAt: new Date(TUESDAY_8H + 3 * HOUR + 1) });
    t.at(TUESDAY_8H + 4 * HOUR);
    expect((await t.http('alex', 'GET', '/plan-du-jour')).body.data.sequenceSteps).toEqual([]);
    expect(await t.db.first<{ status: string }>('SELECT status FROM prospecting_sequences WHERE id = ?', [id])).toMatchObject({ status: 'stopped' });
  });

  it('[R302] sans Bloctel branché, l’appel de prospection seule est au plan mais jamais proposé, sans numéro', async () => {
    const t = await setup();
    await t.freeze();
    t.at(TUESDAY_8H + 3 * HOUR);
    await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: [{ channel: 'phone', afterDays: 0 }] });
    const [step] = (await t.http('alex', 'GET', '/plan-du-jour')).body.data.sequenceSteps;
    expect(step).toMatchObject({ action: 'call', proposed: false, call: null, reason: 'opposition_unchecked' });
  });

  it('[R300] un mail du jour est dit « part seul » ; un plan pas encore figé ne lit rien ; la direction ne lit pas le plan [R16]', async () => {
    const t = await setup();
    t.at(TUESDAY_8H - 2 * HOUR);
    await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: [{ channel: 'email', afterDays: 0, text: 'Bonjour Léa, votre quartier bouge.' }] });
    expect((await t.http('alex', 'GET', '/plan-du-jour')).body.data).toBeNull();
    t.at(TUESDAY_8H);
    await t.freeze();
    const [step] = (await t.http('alex', 'GET', '/plan-du-jour')).body.data.sequenceSteps;
    expect(step).toMatchObject({ channel: 'email', action: 'auto', proposed: false, reason: 'part_par_le_controle_central' });
    // Rien n'est parti de la lecture.
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox'))!.n).toBe(0);
    expect((await t.http('direction', 'GET', '/plan-du-jour')).status).toBe(403);
  });

  it('une source qui refuse ne donne aucune étape, et le plan reste lisible', async () => {
    const t = await setup();
    await t.freeze();
    const refusing = new PlansDuJour(t.db, t.journal, { now: () => new Date(TUESDAY_8H), sequences: { today: async () => ({ ok: false }) } });
    const viewer = { role: 'agent' as const, userId: (await t.db.first<{ id: string }>('SELECT id FROM agents'))!.id, networkId: t.net.id };
    const read = await refusing.read(viewer);
    expect(read.ok && read.value).toMatchObject({ items: expect.any(Array) });
    expect(read.ok && read.value && 'sequenceSteps' in read.value).toBe(false);
  });
});

// L'écran « Ma journée » : clé de test inventée.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
type Call = { url: string; method: string; body: Record<string, unknown> | null };
const ok = (data: unknown) => async () => Response.json({ ok: true, mode: 'essai', data });
const step = (o: Record<string, unknown>) => ({ sequenceId: 's1', position: 1, personId: 'p1', firstName: 'Léa', reason: null, call: null, callClosesAt: null, ...o });
const PLAN = {
  agentId: 'a1',
  day: '2026-11-10',
  computedAt: '2026-11-10T06:30:00.000Z',
  items: [],
  removed: { excluded: 0, withdrawn: 0, noBasis: 0 },
  hiddenSinceFrozen: 0,
  sequenceSteps: [
    step({ stepId: 'e1', channel: 'email', action: 'auto', proposed: false, reason: 'part_par_le_controle_central' }),
    step({ stepId: 'e2', channel: 'phone', action: 'call', proposed: false, reason: 'opposition_unchecked' }),
    step({ stepId: 'e3', channel: 'phone', action: 'call', proposed: true, call: 'tel:+33600000001', callClosesAt: '2026-11-10T11:00:00.000Z' }),
    step({ stepId: 'e4', channel: 'letter', action: 'letter', proposed: true }),
    step({ stepId: 'e5', channel: 'door', action: 'door', proposed: false, reason: 'code_inconnu_xyz' }),
  ],
};

async function screen(answers: Record<string, () => Promise<Response>> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: Call[] = [];
  const routes: Record<string, () => Promise<Response>> = {
    '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
    '/v1/plan-du-jour': ok(PLAN),
    '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
    '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
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
  const buttons = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  return { els, calls, tick, buttons, routes };
}

describe('BR32 · écran « Ma journée » : les étapes des séquences', () => {
  it('[R300] [R302] chaque étape est dite en clair, jamais par son code ; mail et appel non proposé sans bouton', async () => {
    const { els, buttons } = await screen();
    const [mail, closed, call, letter, door] = els.plan!.children;
    expect(mail!.textContent).toBe('Séquence · mail · LéaPart seul par le contrôle central des envois, au prochain passage.Voir la fiche');
    expect(closed!.textContent).toBe('Séquence · appel · LéaAppel de prospection : la liste d’opposition au démarchage n’est pas encore vérifiable, il n’est pas proposé.Voir la fiche');
    expect(call!.all().filter((e) => e.tagName === 'a').map((a) => a.attributes)).toEqual([{ href: 'tel:+33600000001' }]);
    expect(buttons(call!, 'Appelé')).toHaveLength(1);
    expect(buttons(call!, 'A refusé')).toHaveLength(1);
    expect(buttons(letter!, 'Fait')).toHaveLength(1);
    expect(door!.textContent).toBe('Séquence · passage à la porte · LéaPas proposée maintenant.Voir la fiche');
    for (const li of [mail!, closed!, door!]) expect(li.all().filter((e) => e.tagName === 'button').map((b) => b.textContent)).toEqual(['Voir la fiche']);
    expect(els.plan!.textContent).not.toMatch(/opposition_unchecked|part_par|code_inconnu/);
    expect(els['plan-etat']!.textContent).toBe('');
  });

  it('« Fait » note l’étape, puis le plan est relu ; « A refusé » envoie l’issue de l’appel', async () => {
    const t = await screen({ '/v1/sequences/etapes/e4/fait': ok({ finished: true, stopped: false }), '/v1/sequences/etapes/e3/fait': ok({ finished: false, stopped: true }) });
    const [, , call, letter] = t.els.plan!.children;
    t.buttons(letter!, 'Fait')[0]!.click();
    await t.tick();
    expect(t.calls.filter((c) => c.method === 'POST')).toEqual([{ url: '/v1/sequences/etapes/e4/fait', method: 'POST', body: null }]);
    expect(t.calls.filter((c) => c.url === '/v1/plan-du-jour')).toHaveLength(2);
    const again = t.els.plan!.children[2]!;
    expect(call).not.toBe(again);
    t.buttons(again, 'A refusé')[0]!.click();
    await t.tick();
    expect(t.calls.filter((c) => c.method === 'POST')[1]).toEqual({ url: '/v1/sequences/etapes/e3/fait', method: 'POST', body: { callOutcome: 'refused' } });
  });

  it('un refus est dit sans relire le plan ; un plan sans ligne ni étape dit « Rien au plan »', async () => {
    const t = await screen({ '/v1/sequences/etapes/e4/fait': async () => Response.json({ ok: false, rule: 'R301', code: 'stopped' }, { status: 409 }) });
    const letter = t.els.plan!.children[3]!;
    t.buttons(letter, 'Fait')[0]!.click();
    await t.tick();
    expect(letter.textContent).toContain('L’étape n’a pas pu être notée : relisez le plan.');
    expect(t.calls.filter((c) => c.url === '/v1/plan-du-jour')).toHaveLength(1);
    const empty = await screen({ '/v1/plan-du-jour': ok({ ...PLAN, sequenceSteps: [] }) });
    expect(empty.els['plan-etat']!.textContent).toBe('Rien au plan aujourd’hui.');
  });
});
