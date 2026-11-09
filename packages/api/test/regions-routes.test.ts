import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { PortesPhases, type PhaseConditionReading } from '../../core/src/conditions-phases/index.ts';
import { HOME_REGION } from '../../core/src/regions/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseaux, utilisateurs, clés et raisons inventés.
const START = '2028-01-10T09:00:00.000Z';
const KEYS = {
  direction: 'test-cle-br12-direction-aaaaaaaaaaaaaaaaaaaaaa',
  agent: 'test-cle-br12-agent-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  conformite: 'test-cle-br12-conformite-ccccccccccccccccccccc',
};
type Who = keyof typeof KEYS;
const met = (): PhaseConditionReading => ({ met: true, reasons: [], evidence: { essai: 1 } });

async function setup() {
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
  const network = await store.createNetwork('Réseau test');
  const agentId = (await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' })).id;
  const ids: Record<Who, { role: string; userId: string }> = {
    direction: { role: 'direction', userId: 'direction-1' },
    agent: { role: 'agent', userId: agentId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
  const http = async (who: Who, method: string, path: string, body?: unknown, rawBody?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; until?: string } };
  };
  /** Ouvre les phases 2 à 5 par la porte des phases (HX71), conditions d'essai remplies. */
  const openPhase5 = async () => {
    const direction = { role: 'direction', userId: 'direction-1', networkId: network.id } as Viewer;
    const portes = new PortesPhases(db, journal, { now, sources: { 1: async () => met(), 2: async () => met(), 3: async () => met(), 4: async () => met() } });
    for (const phase of [2, 3, 4, 5]) {
      const r = await portes.open(direction, { phase });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  const count = async () => Number((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM region_decisions'))?.n ?? 0);
  return { raw, db, setClock, http, openPhase5, events, count };
}

const decision = (region: string, open: boolean) => ({ region, open, reason: 'Décision d’essai' });

describeWithSqlite('BR12 · routes des régions', () => {
  it('[R16] chaque route refuse tout autre rôle que la direction, en 403, avec le refus au journal, sans rien ranger', async () => {
    const t = await setup();
    await t.openPhase5();
    const cases: [string, string, unknown?][] = [
      ['GET', '/regions'],
      ['POST', '/regions/decision', decision('11', true)],
      ['GET', '/regions/verification'],
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
      expect((await t.http(who, 'POST', '/regions/decision', undefined, '{pas du json')).status).toBe(403);
      expect((await t.events('acces.refuse')).length).toBe(before + 1);
    }
    expect(await t.count()).toBe(0);
  });

  it('un corps illisible est refusé en 400 sans rien ranger ; un champ inconnu aussi', async () => {
    const t = await setup();
    await t.openPhase5();
    for (const rawBody of ['{pas du json', '[1, 2]', 'null']) expect((await t.http('direction', 'POST', '/regions/decision', undefined, rawBody)).status, rawBody).toBe(400);
    const unknown = await t.http('direction', 'POST', '/regions/decision', { ...decision('11', true), extra: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ ok: false, rule: null, code: 'unknown_field' });
    expect(await t.count()).toBe(0);
  });

  it('[R650] [R651] l’état lu avec la région d’origine ouverte d’office ; ouverture refusée en 409 sans phase 5 ouverte', async () => {
    const t = await setup();
    const state = await t.http('direction', 'GET', '/regions');
    expect(state.status).toBe(200);
    expect(state.body.data.regions).toHaveLength(18);
    expect(state.body.data.regions.filter((r: { open: boolean }) => r.open).map((r: { code: string }) => r.code)).toEqual([HOME_REGION]);
    expect(state.body.data.phase5Open).toBe(false);
    expect(state.body.data.openable.ok).toBe(false);
    const closed = await t.http('direction', 'POST', '/regions/decision', decision('11', true));
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ ok: false, rule: 'R651', code: 'phase5_fermee' });
    // La région d'origine et un code inconnu sont refusés avec R650.
    expect((await t.http('direction', 'POST', '/regions/decision', decision(HOME_REGION, false))).body).toMatchObject({ rule: 'R650', code: 'region_d_origine' });
    expect((await t.http('direction', 'POST', '/regions/decision', decision('05', true))).status).toBe(409);
    expect(await t.count()).toBe(0);
  });

  it('[R651] [R652] ouverture acceptée après la phase 5, lue ensuite ; une seconde avant 90 jours refusée avec sa date, acceptée après', async () => {
    const t = await setup();
    await t.openPhase5();
    const ok = await t.http('direction', 'POST', '/regions/decision', decision('11', true));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ region: '11', version: 1, open: true });
    const state = await t.http('direction', 'GET', '/regions');
    expect(state.body.data.regions.filter((r: { open: boolean }) => r.open).map((r: { code: string }) => r.code).sort()).toEqual(['11', HOME_REGION]);
    const soon = await t.http('direction', 'POST', '/regions/decision', decision('84', true));
    expect(soon.status).toBe(409);
    expect(soon.body).toMatchObject({ ok: false, rule: 'R652', code: 'region_recente' });
    expect(typeof soon.body.until).toBe('string');
    t.setClock('2028-04-10T09:00:00.000Z');
    expect((await t.http('direction', 'POST', '/regions/decision', decision('84', true))).status).toBe(200);
    expect(await t.count()).toBe(2);
  });

  it('[R653] la vérification dit la chaîne intacte, puis la première version cassée après une ligne changée', async () => {
    const t = await setup();
    await t.openPhase5();
    expect((await t.http('direction', 'POST', '/regions/decision', decision('11', true))).status).toBe(200);
    expect((await t.http('direction', 'POST', '/regions/decision', decision('11', false))).status).toBe(200);
    const intact = await t.http('direction', 'GET', '/regions/verification');
    expect(intact.status).toBe(200);
    expect(intact.body.data).toEqual({ intact: true, versions: 2 });
    t.raw.exec('DROP TRIGGER region_decisions_fige');
    t.raw.prepare("UPDATE region_decisions SET reason = 'réécrite' WHERE version = 2").run();
    expect((await t.http('direction', 'GET', '/regions/verification')).body.data).toEqual({ intact: false, versions: 2, brokenAt: 2 });
  });
});
