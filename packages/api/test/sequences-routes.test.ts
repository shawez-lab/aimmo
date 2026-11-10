import { expect, it, vi } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { SEQUENCES_JOB, sequencesJob } from '../src/sequences.ts';
import { FicheClient, Planificateur, SqlJournalStore, applyMigrations, fromSyncSqlite, type Channel, type SqlDatabase } from '../../core/src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Un mardi, 11 h à Paris. Réseau, agents, personnes, numéros, adresses et clés d'API inventés.
const TUESDAY_11H = Date.parse('2027-06-08T09:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEYS = {
  alex: 'test-cle-br31-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br31-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br31-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br31-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

async function setup(options: { consents?: { channel: Channel; purpose: string }[] } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_11H;
  const now = () => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Essai' });
  const sam = await store.createAgent({ networkId: net.id, firstName: 'Sam', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: net.id, agentId: alex.id, firstName: 'Léa', lastName: 'Inventée' });
  await store.addIdentifier({ networkId: net.id, personId: person.id, kind: 'phone', value: '06 00 00 00 01' });
  await store.addIdentifier({ networkId: net.id, personId: person.id, kind: 'email', value: 'lea@exemple.test' });
  const given = new Date(TUESDAY_11H - 10 * DAY);
  const consents = options.consents ?? [
    { channel: 'email', purpose: 'prospecting' },
    { channel: 'sms', purpose: 'prospecting' },
    { channel: 'phone', purpose: 'prospecting' },
  ];
  for (const c of consents) await store.addConsent({ networkId: net.id, personId: person.id, purpose: c.purpose, channel: c.channel, proof: 'accord de test', givenAt: given });
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: alex.id },
    sam: { role: 'agent', userId: sam.id },
    direction: { role: 'direction', userId: 'direction-1' },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: net.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
  const http = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, init), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string } };
  };
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'sequence_prospection');
  const count = async (table: string) => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
  const sequence = async (id: string) => db.first<{ status: string; end_reason: string | null }>('SELECT status, end_reason FROM prospecting_sequences WHERE id = ?', [id]);
  const steps = async (id: string) => db.all<{ position: number; outcome: string | null }>('SELECT position, outcome FROM prospecting_sequence_steps WHERE sequence_id = ? ORDER BY position', [id]);
  /** Le passage du planificateur, seul. */
  const pass = async () => new Planificateur(db, journal, [sequencesJob(db, journal, { now })], { now }).tick();
  return { db, journal, store, net, person, http, refusals, count, sequence, steps, pass, at: (t: number) => { clock = t; } };
}

const FULL = [
  { channel: 'email', afterDays: 0, text: 'Bonjour Léa, votre quartier bouge : voulez-vous connaître la valeur de votre maison ?' },
  { channel: 'phone', afterDays: 0 },
  { channel: 'letter', afterDays: 2 },
];

describeWithSqlite('BR31 · routes de la séquence de prospection, et son passage au planificateur', () => {
  it('[R16] chaque route refuse tout autre rôle que l’agent en 403, au journal, avant de lire le corps', async () => {
    const t = await setup();
    const cases: [Who, 'GET' | 'POST', string, string?][] = [
      ['direction', 'POST', '/sequences', '{pas du json'],
      ['conformite', 'POST', '/sequences'],
      ['direction', 'GET', '/sequences/jour'],
      ['conformite', 'GET', '/sequences/jour'],
      ['direction', 'POST', '/sequences/etapes/e1/fait'],
    ];
    for (const [who, method, path, raw] of cases) {
      const r = await t.http(who, method, path, undefined, raw);
      expect(r.status, `${who} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.refusals()).length).toBe(cases.length);
    expect(await t.count('prospecting_sequences')).toBe(0);
  });

  it('[R300] [R26] l’agent prépare la séquence de sa fiche ; rien ne part de la route ; le passage remet le mail au contrôle central, en mode essai seulement', async () => {
    const t = await setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: FULL });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('essai');
    const id = r.body.data.sequenceId as string;
    expect(await t.count('messages')).toBe(0);
    // Une autre fiche que la sienne : refusée, rien n'est préparé.
    const other = await t.http('sam', 'POST', '/sequences', { personId: t.person.id, steps: FULL });
    expect(other.status).toBe(403);
    expect(other.body.rule).toBe('R16');
    // Une seule séquence en cours par personne.
    expect((await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: FULL })).body).toMatchObject({ rule: 'HX20', code: 'already_active' });
    const tick = await t.pass();
    expect(tick.ran).toEqual([SEQUENCES_JOB]);
    // Le mail est passé par le contrôle central, dans la boîte d'essai : aucun vrai canal, aucun appel réseau.
    expect(await t.count('trial_outbox')).toBe(1);
    expect((await t.db.first<{ channel: string }>('SELECT channel FROM trial_outbox'))!.channel).toBe('email');
    expect((await t.steps(id))[0]!.outcome).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('[R302] sans Bloctel branché, l’appel de prospection seule n’est jamais proposé ni noté fait', async () => {
    const t = await setup();
    const id = (await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: [{ channel: 'phone', afterDays: 0 }, { channel: 'letter', afterDays: 0 }] })).body.data.sequenceId as string;
    const today = await t.http('alex', 'GET', '/sequences/jour');
    expect(today.status).toBe(200);
    const [call] = today.body.data.steps;
    expect(call).toMatchObject({ sequenceId: id, channel: 'phone', action: 'call', proposed: false, call: null });
    expect(call.reason).toBeTruthy();
    // Un appel non proposé ne se note pas fait.
    const done = await t.http('alex', 'POST', `/sequences/etapes/${call.stepId}/fait`, { callOutcome: 'called' });
    expect(done.status).toBe(409);
    expect(done.body.rule).toBe('R302');
    expect(await t.count('call_notes')).toBe(0);
  });

  it('[R302] un rappel demandé par la personne est proposé avec son numéro ; l’appel fait se note dans les appels de la fiche', async () => {
    const t = await setup({ consents: [{ channel: 'phone', purpose: 'rappel_demande' }] });
    const id = (await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: [{ channel: 'phone', afterDays: 0 }] })).body.data.sequenceId as string;
    const [step] = (await t.http('alex', 'GET', '/sequences/jour')).body.data.steps;
    expect(step).toMatchObject({ action: 'call', proposed: true, call: 'tel:+33600000001', callClosesAt: null });
    // L'issue de l'appel est obligatoire.
    expect((await t.http('alex', 'POST', `/sequences/etapes/${step.stepId}/fait`)).body).toMatchObject({ rule: 'R204', code: 'call_outcome' });
    const done = await t.http('alex', 'POST', `/sequences/etapes/${step.stepId}/fait`, { callOutcome: 'called' });
    expect(done.status).toBe(200);
    expect(done.body.data).toEqual({ finished: true, stopped: false });
    expect(await t.count('call_notes')).toBe(1);
    expect(await t.sequence(id)).toMatchObject({ status: 'finished' });
  });

  it('[R301] une demande d’arrêt arrête la séquence sur tous les canaux, au passage comme à la lecture', async () => {
    const t = await setup();
    const id = (await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: [{ channel: 'letter', afterDays: 0 }, { channel: 'email', afterDays: 1, text: 'Bonjour Léa, je reviens vers vous.' }, { channel: 'door', afterDays: 2 }] })).body.data.sequenceId as string;
    await t.store.addExclusion({ networkId: t.net.id, personId: t.person.id, reason: 'stop', channel: 'email', notedAt: new Date(TUESDAY_11H + HOUR) });
    t.at(TUESDAY_11H + 2 * HOUR);
    const today = await t.http('alex', 'GET', '/sequences/jour');
    expect(today.body.data.steps).toEqual([]);
    expect(await t.sequence(id)).toMatchObject({ status: 'stopped', end_reason: 'excluded' });
    for (const d of [1, 2]) {
      t.at(TUESDAY_11H + d * DAY);
      await t.pass();
    }
    expect(await t.count('trial_outbox')).toBe(0);
    // Une personne opposée ne reçoit pas de nouvelle séquence.
    expect((await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: [{ channel: 'letter', afterDays: 0 }] })).status).toBe(409);
  });

  it('l’agent note fait un courrier du jour ; une étape d’un autre agent est inconnue pour lui', async () => {
    const t = await setup();
    const id = (await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: [{ channel: 'letter', afterDays: 0 }] })).body.data.sequenceId as string;
    const [step] = (await t.http('alex', 'GET', '/sequences/jour')).body.data.steps;
    expect(step).toMatchObject({ action: 'letter', proposed: true });
    expect((await t.http('sam', 'POST', `/sequences/etapes/${step.stepId}/fait`)).status).toBe(404);
    const r = await t.http('alex', 'POST', `/sequences/etapes/${step.stepId}/fait`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ finished: true, stopped: false });
    expect(await t.sequence(id)).toMatchObject({ status: 'finished' });
  });

  it('le passage est inscrit au planificateur du Worker, de 9 h à 19 h du lundi au samedi', async () => {
    const t = await setup();
    expect(sequencesJob(t.db, t.journal, { now: () => new Date() })).toMatchObject({ name: 'sequences.passage', hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], weekdays: [1, 2, 3, 4, 5, 6] });
    const r = await runScheduler({ db: t.db, mode: 'essai', now: () => new Date(TUESDAY_11H) });
    expect(r?.ran).toContain(SEQUENCES_JOB);
  });

  it('corps mal formé, champ ou paramètre non prévu : 400 sans rien ranger', async () => {
    const t = await setup();
    const cases: [string, 'GET' | 'POST', unknown, string?][] = [
      ['/sequences', 'POST', undefined, '{pas du json'],
      ['/sequences', 'POST', undefined, '[1]'],
      ['/sequences', 'POST', { personId: t.person.id }],
      ['/sequences', 'POST', { personId: t.person.id, steps: 'tout' }],
      ['/sequences', 'POST', { personId: t.person.id, steps: [{ channel: 'email', afterDays: '0', text: 'x' }] }],
      ['/sequences', 'POST', { personId: t.person.id, steps: [{ channel: 'email', afterDays: 0, text: 3 }] }],
      ['/sequences', 'POST', { personId: t.person.id, steps: [{ channel: 'letter', afterDays: 0, to: 'lea@exemple.test' }] }],
      ['/sequences', 'POST', { personId: t.person.id, steps: [], agentId: 'x' }],
      ['/sequences', 'POST', { personId: 'a b', steps: [] }],
      ['/sequences/jour?agent=x', 'GET', undefined],
      ['/sequences/etapes/e1/fait', 'POST', { callOutcome: 'peut-être' }],
      ['/sequences/etapes/e1/fait', 'POST', { note: 'x' }],
    ];
    for (const [path, method, body, raw] of cases) {
      const r = await t.http('alex', method, path, body, raw);
      expect(r.status, `${path} ${JSON.stringify(body ?? raw)}`).toBe(400);
    }
    expect(await t.count('prospecting_sequences')).toBe(0);
    // Une étape mal formée pour la règle : refus de la couche métier, avec sa règle.
    const rule = await t.http('alex', 'POST', '/sequences', { personId: t.person.id, steps: [{ channel: 'pigeon', afterDays: 0 }] });
    expect(rule.status).toBe(409);
    expect(rule.body).toMatchObject({ rule: 'HX20', code: 'channel' });
  });
});
