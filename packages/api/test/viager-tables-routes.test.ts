import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agent, tables et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const KEY = (who: string): string => `test-cle-br80-${who}-${'x'.repeat(32)}`;
type Who = 'dir' | 'alex' | 'conf';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  // Le 1er mars 2027 à Paris.
  let clock = Date.parse('2027-03-01T10:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const other = (await store.createNetwork('Autre réseau')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const ids: Record<Who, { role: string; userId: string; networkId?: string }> = {
    dir: { role: 'direction', userId: 'dir-1' },
    alex: { role: 'agent', userId: alex },
    conf: { role: 'compliance', userId: 'conf-1' },
  };
  const keys = await Promise.all((Object.keys(ids) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEY(w)), networkId: network, ...ids[w] })));
  keys.push({ sha256: await sha256Hex(KEY('autre')), networkId: other, role: 'direction', userId: 'dir-2' });
  const config: ApiConfig = { db, apiKeys: JSON.stringify(keys), mode: 'essai', now };
  const call = async (who: Who | 'autre', method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY(who)}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const table = (vintage: string, source: string, rows: { age: number; expectancyTenths: number }[], who: Who | 'autre' = 'dir') => call(who, 'POST', '/viager/tables', { vintage, source, rows });
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  return { db, network, call, table, events };
}

const ROWS = [
  { age: 68, expectancyTenths: 175 },
  { age: 75, expectancyTenths: 128 },
];

describeWithSqlite('BR80 · les tables d’espérance de vie importées, lues par la direction', () => {
  it('[R16] la direction seule lit les tables ; un agent ou la conformité est refusé, au journal', async () => {
    const t = await setup();
    for (const who of ['alex', 'conf'] as const) {
      const before = (await t.events('acces.refuse')).length;
      const r = await t.call(who, 'GET', '/viager/tables');
      expect([r.status, r.body.rule, r.body.code], who).toEqual([403, 'R16', 'role']);
      expect((await t.events('acces.refuse')).length, who).toBe(before + 1);
    }
    const r = await t.call('dir', 'GET', '/viager/tables');
    expect([r.status, r.body.data]).toEqual([200, { tables: [] }]);
  });

  it('[R541] tables listées sans leurs lignes, la plus récemment importée en service, celle même qui sert au calcul', async () => {
    const t = await setup();
    expect((await t.table('2023', 'Table de 2023 inventée, ensemble des deux sexes', ROWS)).status).toBe(200);
    // Un millésime plus ancien importé après : c'est lui qui sert, comme au calcul (dernier importé).
    expect((await t.table('2020-2022', 'Table de 2020-2022 inventée, ensemble des deux sexes', [{ age: 68, expectancyTenths: 170 }])).status).toBe(200);
    expect((await t.table('2024', 'Table d’un autre réseau inventée', ROWS, 'autre')).status).toBe(200);
    const r = await t.call('dir', 'GET', '/viager/tables');
    expect(r.status).toBe(200);
    const tables = r.body.data.tables as Record<string, unknown>[];
    expect(tables.map((x) => [x.vintage, x.rowCount, x.inUse])).toEqual([
      ['2020-2022', 1, true],
      ['2023', 2, false],
    ]);
    for (const x of tables) expect(Object.keys(x).sort()).toEqual(['importedAt', 'inUse', 'rowCount', 'source', 'tableId', 'vintage']);
    expect(JSON.stringify(r.body.data)).not.toMatch(/autre réseau|expectancy/i);
    // Le calcul cite la même table que celle dite en service.
    const inputs = {
      marketValue: { value: 20_000_000, hypothesis: 'valeur libre inventée' },
      occupied: { value: true, hypothesis: 'le vendeur garde l’usage' },
      headAges: { value: [68], hypothesis: 'âge déclaré' },
      bouquet: { value: 3_000_000, hypothesis: 'convenu avec le vendeur' },
      annualRateBp: { value: 300, hypothesis: 'taux technique retenu' },
    };
    const c = await t.call('alex', 'POST', '/viager/calculs', { inputs });
    expect(c.status).toBe(200);
    const cited = JSON.stringify(c.body.data);
    expect(cited).toContain(`table:${String(tables[0]!.tableId)}`);
    expect(cited).not.toContain(`table:${String(tables[1]!.tableId)}`);
  });
});
