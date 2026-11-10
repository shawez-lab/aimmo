import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { POSTGRES_READING_JOB, POSTGRES_REPORT_ACTOR, postgresReadingJob } from '../src/postgresql.ts';
import { FicheClient, Planificateur, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseaux, utilisateurs et clés inventés. Le 2028-01-10 est un lundi.
const START = '2028-01-10T09:00:00.000Z';
const KEYS = {
  direction: 'test-cle-br25-direction-aaaaaaaaaaaaaaaaaaaaa',
  autre: 'test-cle-br25-autre-direction-bbbbbbbbbbbbbbbbb',
  agent: 'test-cle-br25-agent-cccccccccccccccccccccccccccc',
  conformite: 'test-cle-br25-conformite-dddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

async function setup(options: { platform?: boolean } = {}) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse(START);
  const now = (): Date => new Date(clock);
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const platform = await store.createNetwork('Réseau plateforme test');
  const other = await store.createNetwork('Réseau voisin test');
  const agentId = (await store.createAgent({ networkId: platform.id, firstName: 'Alex', lastName: 'Essai' })).id;
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    direction: { role: 'direction', userId: 'direction-1', networkId: platform.id },
    autre: { role: 'direction', userId: 'direction-2', networkId: other.id },
    agent: { role: 'agent', userId: agentId, networkId: platform.id },
    conformite: { role: 'compliance', userId: 'conformite-1', networkId: platform.id },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, ...(options.platform === false ? {} : { platformNetworkId: platform.id }) };
  const http = async (who: Who, method: string, path: string, body?: unknown, rawBody?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  const readings = async () => db.all<{ agents_active: number | null; elapsed_ms: number | null; source: string }>('SELECT agents_active, elapsed_ms, source FROM postgres_threshold_readings ORDER BY seq');
  const decisions = async () => Number((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM postgres_decisions'))?.n ?? 0);
  const addAgents = async (n: number) => {
    for (let i = 0; i < n; i++) await store.createAgent({ networkId: other.id, firstName: `Agent${i}`, lastName: 'Essai' });
  };
  return { db, journal, now, setClock, http, events, readings, decisions, addAgents, platform, other };
}

describeWithSqlite('BR25 · routes des seuils du passage à PostgreSQL', () => {
  const cases: [string, string, unknown?][] = [
    ['GET', '/postgresql'],
    ['POST', '/postgresql/releve'],
    ['POST', '/postgresql/decision', { choice: 'attendre' }],
  ];

  it('[R16] chaque route refuse tout autre rôle que la direction, en 403, avec le refus au journal, sans rien ranger', async () => {
    const t = await setup();
    for (const who of ['agent', 'conformite'] as Who[]) {
      for (const [method, path, body] of cases) {
        const before = (await t.events('acces.refuse')).length;
        const r = await t.http(who, method, path, body);
        expect(r.status, `${who} ${method} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
        expect((await t.events('acces.refuse')).length, `${who} ${method} ${path}`).toBe(before + 1);
      }
      // Même sans corps lisible, le refus de droits passe d'abord et s'écrit au journal.
      const r = await t.http(who, 'POST', '/postgresql/decision', undefined, '{pas du json');
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ rule: 'R16', code: 'role' });
    }
    expect(await t.readings()).toHaveLength(0);
    expect(await t.decisions()).toBe(0);
  });

  it('[R16] la direction d’un autre réseau est refusée, et tout est refusé sans réseau de la plateforme réglé', async () => {
    const t = await setup();
    for (const [method, path, body] of cases) {
      const before = (await t.events('acces.refuse')).length;
      const r = await t.http('autre', method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'autre_reseau' });
      expect((await t.events('acces.refuse')).length).toBe(before + 1);
    }
    const r = await t.http('autre', 'POST', '/postgresql/decision', undefined, '{pas du json');
    expect(r.status).toBe(403);

    const u = await setup({ platform: false });
    for (const [method, path, body] of cases) {
      const res = await u.http('direction', method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body).toMatchObject({ ok: false, rule: 'R16', code: 'autre_reseau' });
    }
    expect(await t.readings()).toHaveLength(0);
    expect(await u.readings()).toHaveLength(0);
  });

  it('[R630] la direction de la plateforme demande un relevé : rangé, avec le temps du rapport du réseau mesuré', async () => {
    const t = await setup();
    const r = await t.http('direction', 'POST', '/postgresql/releve');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ source: 'direction' });
    expect(r.body.data.values.agents).toBe(1);
    expect(typeof r.body.data.values.rapport).toBe('number');
    const rows = await t.readings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agents_active: 1, source: 'direction' });
    expect(rows[0]!.elapsed_ms).not.toBeNull();
    // Le rapport chronométré est celui du réseau de la plateforme, lu par le système.
    const lectures = await t.events('pilotage.lecture');
    expect(lectures.some((e) => e.actor === `direction:${POSTGRES_REPORT_ACTOR}` && e.subject === `network:${t.platform.id}`)).toBe(true);
    const state = await t.http('direction', 'GET', '/postgresql');
    expect(state.status).toBe(200);
    expect(state.body.data.status).toBe('sous_les_seuils');
  });

  it('[R631] décider sans seuil franchi est refusé en 409 ; un choix inconnu ou un corps illisible en 400, sans rien ranger', async () => {
    const t = await setup();
    const none = await t.http('direction', 'POST', '/postgresql/decision', { choice: 'attendre' });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ ok: false, rule: 'R631', code: 'aucun_seuil' });
    const bad = await t.http('direction', 'POST', '/postgresql/decision', { choice: 'basculer' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'bad_choice' });
    const unreadable = await t.http('direction', 'POST', '/postgresql/decision', undefined, '{pas du json');
    expect(unreadable.status).toBe(400);
    expect(unreadable.body).toMatchObject({ code: 'invalid_body' });
    const extra = await t.http('direction', 'POST', '/postgresql/decision', { choice: 'attendre', passage: 'maintenant' });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({ code: 'unknown_field' });
    expect(await t.decisions()).toBe(0);
  });

  it('[R631] un seuil franchi rend l’état « à décider », et la direction dit « attendre » ; rien ne bascule seul', async () => {
    const t = await setup();
    await t.addAgents(50);
    const r = await t.http('direction', 'POST', '/postgresql/releve');
    expect(r.body.data.values.agents).toBe(51);
    expect((await t.http('direction', 'GET', '/postgresql')).body.data.status).toBe('a_decider');
    const d = await t.http('direction', 'POST', '/postgresql/decision', { choice: 'attendre' });
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ version: 1, choice: 'attendre' });
    expect((await t.http('direction', 'GET', '/postgresql')).body.data.status).toBe('attendre');
    expect(await t.decisions()).toBe(1);
  });

  it('[R630] le planificateur prend un relevé le lundi à 4 h de Paris, une seule fois ; pas les autres jours', async () => {
    const t = await setup();
    // Lundi 4 h 10 de Paris (heure d'hiver).
    t.setClock('2028-01-10T03:10:00.000Z');
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, platformNetworkId: t.platform.id });
    let rows = await t.readings();
    expect(rows.filter((x) => x.source === 'passage')).toHaveLength(1);
    expect(rows[0]!.elapsed_ms).not.toBeNull();
    // Un second passage dans la même heure ne range rien de plus.
    t.setClock('2028-01-10T03:40:00.000Z');
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, platformNetworkId: t.platform.id });
    rows = await t.readings();
    expect(rows.filter((x) => x.source === 'passage')).toHaveLength(1);
    // Mardi à 4 h : rien.
    t.setClock('2028-01-11T03:10:00.000Z');
    await new Planificateur(t.db, t.journal, [postgresReadingJob(t.db, t.journal, { now: t.now, platformNetworkId: t.platform.id })], { now: t.now }).tick();
    expect(await t.readings()).toHaveLength(1);
    expect(POSTGRES_READING_JOB).toBe('postgresql.releve');
  });

  it('[R630] sans réseau de la plateforme, le relevé planifié est rangé avec un temps de rapport inconnu, jamais « sous le seuil »', async () => {
    const t = await setup();
    t.setClock('2028-01-10T03:10:00.000Z');
    await new Planificateur(t.db, t.journal, [postgresReadingJob(t.db, t.journal, { now: t.now, platformNetworkId: null })], { now: t.now }).tick();
    const rows = await t.readings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.elapsed_ms).toBeNull();
    const r = await t.http('direction', 'GET', '/postgresql');
    expect(r.body.data.status).toBe('inconnu');
  });
});
