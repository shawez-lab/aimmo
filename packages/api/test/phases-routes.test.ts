import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { PHASE1_READING_JOB, phase1ReadingJob } from '../src/phases.ts';
import { FicheClient, Planificateur, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseaux, agents, clés et preuves inventés. Le lundi 1er mars 2027, à 11 h à Paris (heure d'hiver).
const START = '2027-03-01T10:00:00.000Z';
const KEYS = {
  direction: 'test-cle-br10-direction-aaaaaaaaaaaaaaaaaaaaaa',
  agent: 'test-cle-br10-agent-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  conformite: 'test-cle-br10-conformite-ccccccccccccccccccccc',
};
type Who = keyof typeof KEYS;
const PROOF = 'stockage/phase1/capture-automatisations.png';
const TASKS = { gohighlevel: 2, manychat: 1, site: 0, github_actions: 0, autre: 0 };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse(START);
  const now = (): Date => new Date(clock);
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const agentId = (await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Pilote' })).id;
  const ids: Record<Who, { role: string; userId: string }> = {
    direction: { role: 'direction', userId: 'direction-1' },
    agent: { role: 'agent', userId: agentId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
  const http = async (who: Who, method: string, path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  const count = async (table: string) => Number((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
  return { db, journal, now, setClock, network, other, agentId, http, events, count };
}

describeWithSqlite('BR10 · routes et relevé de nuit des conditions de passage des phases', () => {
  it('[R16] chaque route refuse tout autre rôle que la direction, en 403, avec le refus au journal, sans rien ranger', async () => {
    const t = await setup();
    const cases: [string, string, unknown?][] = [
      ['GET', '/phases/pilotes'],
      ['POST', '/phases/pilotes', { agentId: t.agentId }],
      ['POST', '/phases/pilotes/avant', { agentId: t.agentId, months: [1, 2, 3], proofRef: PROOF }],
      ['GET', '/phases/phase1'],
      ['POST', '/phases/phase1/envois-hors-aimmo', { day: '2027-02-27', application: 'manychat', proofRef: PROOF }],
      ['POST', '/phases/phase1/inventaire', { tasks: TASKS, proofRef: PROOF }],
    ];
    for (const who of ['agent', 'conformite'] as Who[]) {
      for (const [method, path, body] of cases) {
        const before = (await t.events('acces.refuse')).length;
        const r = await t.http(who, method, path, body);
        expect(r.status, `${who} ${method} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
        expect((await t.events('acces.refuse')).length, `${who} ${method} ${path}`).toBe(before + 1);
      }
      // Même sans corps lisible, le refus de droits passe d'abord et s'écrit au journal.
      const before = (await t.events('acces.refuse')).length;
      expect((await t.http(who, 'POST', '/phases/phase1/inventaire', undefined, '{pas du json')).status).toBe(403);
      expect((await t.events('acces.refuse')).length).toBe(before + 1);
    }
    for (const table of ['pilot_agents', 'pilot_before_declarations', 'phase1_outside_sends', 'phase1_app_inventories']) expect(await t.count(table), table).toBe(0);
  });

  it('un corps illisible est refusé en 400 sans rien ranger ; un refus de règle répond 409 avec sa règle [R640] [R644]', async () => {
    const t = await setup();
    for (const path of ['/phases/pilotes', '/phases/pilotes/avant', '/phases/phase1/envois-hors-aimmo', '/phases/phase1/inventaire']) {
      expect((await t.http('direction', 'POST', path, undefined, '{pas du json')).status, path).toBe(400);
      expect((await t.http('direction', 'POST', path, undefined, '[1, 2]')).status, path).toBe(400);
    }
    // Champ inconnu : refus sans règle.
    expect((await t.http('direction', 'POST', '/phases/pilotes', { agentId: t.agentId, extra: 1 })).body).toMatchObject({ ok: false, rule: null, code: 'unknown_field' });
    // Agent inconnu (ou d'un autre réseau) : 404.
    const unknown = await t.http('direction', 'POST', '/phases/pilotes', { agentId: 'agent-absent' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ rule: 'R640', code: 'agent_inconnu' });
    // Déclaration d'avant pour un agent pas pilote : 409, R640.
    const notPilot = await t.http('direction', 'POST', '/phases/pilotes/avant', { agentId: t.agentId, months: [1, 2, 3], proofRef: PROOF });
    expect(notPilot.status).toBe(409);
    expect(notPilot.body).toMatchObject({ rule: 'R640', code: 'pas_pilote' });
    // Jour pas encore commencé, application oubliée : 409, R644.
    const future = await t.http('direction', 'POST', '/phases/phase1/envois-hors-aimmo', { day: '2027-03-02', application: 'manychat', proofRef: PROOF });
    expect(future.status).toBe(409);
    expect(future.body).toMatchObject({ rule: 'R644', code: 'bad_day' });
    const { autre: _autre, ...missing } = TASKS;
    const partial = await t.http('direction', 'POST', '/phases/phase1/inventaire', { tasks: missing, proofRef: PROOF });
    expect(partial.status).toBe(409);
    expect(partial.body).toMatchObject({ rule: 'R644', code: 'bad_tasks' });
    for (const table of ['pilot_agents', 'pilot_before_declarations', 'phase1_outside_sends', 'phase1_app_inventories']) expect(await t.count(table), table).toBe(0);
  });

  it('[R640] [R644] la direction désigne un pilote, range son avant, un envoi hors AIMMO et l’inventaire, puis lit les deux rapports', async () => {
    const t = await setup();
    const d = await t.http('direction', 'POST', '/phases/pilotes', { agentId: t.agentId });
    expect(d).toMatchObject({ status: 200, body: { ok: true, data: { agentId: t.agentId } } });
    expect((await t.http('direction', 'POST', '/phases/pilotes', { agentId: t.agentId })).body).toMatchObject({ rule: 'R640', code: 'deja_pilote' });
    const b = await t.http('direction', 'POST', '/phases/pilotes/avant', { agentId: t.agentId, months: [1, 2, 3], proofRef: PROOF });
    expect(b).toMatchObject({ status: 200, body: { ok: true, data: { agentId: t.agentId, version: 1, inTime: true } } });
    const o = await t.http('direction', 'POST', '/phases/phase1/envois-hors-aimmo', { day: '2027-02-27', application: 'manychat', proofRef: PROOF });
    expect(o).toMatchObject({ status: 200, body: { ok: true, data: { day: '2027-02-27' } } });
    const i = await t.http('direction', 'POST', '/phases/phase1/inventaire', { tasks: TASKS, proofRef: PROOF });
    expect(i).toMatchObject({ status: 200, body: { ok: true, data: { version: 1, total: 3 } } });

    const pilots = await t.http('direction', 'GET', '/phases/pilotes');
    expect(pilots.status).toBe(200);
    expect(pilots.body.data.condition.met).toBe(false);
    const phase1 = await t.http('direction', 'GET', '/phases/phase1');
    expect(phase1.status).toBe(200);
    expect(phase1.body.data.condition.met).toBe(false);
    expect(await t.count('pilot_agents')).toBe(1);
  });

  it('[R643] [R17] le passage de nuit fige la veille de chaque réseau une seule fois ; un second passage ne change rien', async () => {
    const t = await setup();
    // Mardi 2 mars 2027 à 0 h 30 de Paris : la veille est le lundi 1er mars.
    t.setClock('2027-03-01T23:30:00.000Z');
    const planner = new Planificateur(t.db, t.journal, [phase1ReadingJob(t.db, t.journal, { now: t.now })], { now: t.now });
    const first = await planner.tick();
    expect(first.ran).toEqual([PHASE1_READING_JOB]);
    const rows = async () => t.db.all<{ network_id: string; day: string; taken_at: string }>('SELECT network_id, day, taken_at FROM phase1_day_readings ORDER BY network_id');
    const taken = await rows();
    expect(taken.map((r) => r.day)).toEqual(['2027-03-01', '2027-03-01']);
    expect(new Set(taken.map((r) => r.network_id))).toEqual(new Set([t.network.id, t.other.id]));
    expect((await t.events('condition_phase1.releve')).length).toBe(2);

    // Une heure plus tard, un autre créneau : le relevé déjà pris est rendu, rien ne change.
    t.setClock('2027-03-02T00:30:00.000Z');
    const second = await planner.tick();
    expect(second.ran).toEqual([PHASE1_READING_JOB]);
    expect(await rows()).toEqual(taken);
    expect((await t.events('condition_phase1.releve')).length).toBe(2);

    // À midi, le passage ne tourne pas : un jour manqué n'est jamais rattrapé plus tard.
    t.setClock('2027-03-02T11:00:00.000Z');
    expect((await planner.tick()).ran).toEqual([]);
  });

  it('le passage de nuit est dans le planificateur du Worker', async () => {
    const src = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/planificateur.ts', import.meta.url), 'utf8'));
    expect(src).toContain('phase1ReadingJob(config.db, journal, { now })');
  });
});
