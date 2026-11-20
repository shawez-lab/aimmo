import { expect, it } from 'vitest';
import { FicheClient, FicheUnique, applyMigrations, type SqlDatabase, type SqlValue } from '@aimmo/core';
import { sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { BacASableBase, DurableSandboxStorage, schemaStatements, type DurableNamespaceLike, type DurableStateLike } from '../src/bac-a-sable.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// AU025 · Réseau, agents et clients inventés.
const BASE = 'https://aimmo-api.example.test';
const KEYS = { nina: 'test-cle-au025-nina-aaaaaaaaaaaaaaaaaaaaaaaaaaa', vic: 'test-cle-au025-vic-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', direction: 'test-cle-au025-direction-ccccccccccccccccccccc' };
type Who = keyof typeof KEYS;

/** `ctx.storage` d'un objet durable adossé à SQLite, imité sur node:sqlite : `sql.exec` et `transactionSync`. */
function durableState(db: SqliteDatabase): DurableStateLike {
  db.exec('PRAGMA foreign_keys = ON');
  return {
    storage: {
      sql: {
        exec(query: string, ...bindings: SqlValue[]) {
          // Comme Cloudflare : plusieurs instructions d'un coup quand rien n'est lié.
          if (bindings.length === 0 && !/^\s*select\b/i.test(query)) {
            db.exec(query);
            return { toArray: () => [] };
          }
          const rows = db.prepare(query).all(...bindings).map((r) => ({ ...(r as object) }) as Record<string, SqlValue>);
          return { toArray: () => rows };
        },
      },
      transactionSync<T>(fn: () => T): T {
        db.exec('SAVEPOINT t');
        try {
          const out = fn();
          db.exec('RELEASE t');
          return out;
        } catch (error) {
          db.exec('ROLLBACK TO t');
          db.exec('RELEASE t');
          throw error;
        }
      },
    },
  };
}

/** Une liaison d'objets durables : un objet, avec sa base à lui, par nom. */
class FakeNamespace implements DurableNamespaceLike {
  readonly objects = new Map<string, { base: SqliteDatabase; object: BacASableBase }>();
  idFromName(name: string): unknown {
    return name;
  }
  get(id: unknown) {
    const name = String(id);
    let entry = this.objects.get(name);
    if (!entry) {
      const base = openMemoryDatabase();
      entry = { base, object: new BacASableBase(durableState(base)) };
      this.objects.set(name, entry);
    }
    const object = entry.object;
    return { fetch: (request: Request) => object.fetch(request) };
  }
}

async function setup() {
  const d1 = fakeD1(openMemoryDatabase());
  const db: SqlDatabase = fromD1(d1);
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const network = (await store.createNetwork('Réseau test')).id;
  const nina = (await store.createAgent({ networkId: network, firstName: 'Nina', lastName: 'Nouvelle' })).id;
  const vic = (await store.createAgent({ networkId: network, firstName: 'Vic', lastName: 'Ancien' })).id;
  // Un vrai client du réseau : il ne doit jamais entrer dans un bac à sable.
  const real = await store.createPerson({ networkId: network, agentId: vic, firstName: 'Réel', lastName: 'Client' });
  await new FicheUnique(db, store).addIdentifier({ networkId: network, agentId: vic, personId: real.id, kind: 'email', value: 'vrai.client@reseau.example' });
  const ids: Record<Who, { role: string; userId: string }> = { nina: { role: 'agent', userId: nina }, vic: { role: 'agent', userId: vic }, direction: { role: 'direction', userId: 'dir-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const ns = new FakeNamespace();
  const env: Env = { DB: d1, API_KEYS: apiKeys, MODE: 'essai', BAC_A_SABLE: ns };
  const call = async (who: Who, method: string, path: string, e: Env = env) => {
    const r = await worker.fetch(new Request(`${BASE}/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}` } }), e);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; code?: string; rule?: string | null } };
  };
  return { d1, db, network, nina, vic, real, ns, env, call };
}

describeWithSqlite('AU025 · le bac à sable servi par le Worker', () => {
  it('[R82] constat : sans sa base à part, le Worker laissait le premier parcours fermé ; avec elle, l\'agent ouvre son exercice et fait les cinq étapes depuis son écran', async () => {
    const t = await setup();
    // Le constat de l'audit : sans la liaison, le parcours reste « pas encore en service ».
    const { BAC_A_SABLE: _ns, ...closed } = t.env;
    expect((await t.call('nina', 'POST', '/reseau/mon-bac-a-sable', closed)).status).toBe(503);

    expect((await t.call('nina', 'GET', '/reseau/mon-bac-a-sable')).body).toMatchObject({ ok: false, code: 'not_opened' });
    const opened = await t.call('nina', 'POST', '/reseau/mon-bac-a-sable');
    expect(opened.status).toBe(200);
    expect(opened.body.data.steps.every((s: { done: boolean }) => !s.done)).toBe(true);
    // Hors de l'ordre : refusé, rien ne change.
    expect((await t.call('nina', 'POST', '/reseau/mon-bac-a-sable/etapes/avis_valide')).body).toMatchObject({ ok: false, code: 'not_next_step' });
    for (const step of ['contact_recu', 'rappel_fait', 'rendez_vous', 'avis_valide']) {
      const r = await t.call('nina', 'POST', `/reseau/mon-bac-a-sable/etapes/${step}`);
      expect([step, r.status]).toEqual([step, 200]);
    }
    // Progression persistante : relue par une nouvelle requête, puis par la direction.
    const again = await t.call('nina', 'GET', '/reseau/mon-bac-a-sable');
    expect(again.body.data).toMatchObject({ completed: true, next: null });
    expect(again.body.data.steps.map((s: { done: boolean }) => s.done)).toEqual([true, true, true, true, true]);
    expect((await t.call('direction', 'GET', `/reseau/agents/${t.nina}/bac-a-sable`)).body.data).toMatchObject({ completed: true });
    expect(await t.db.first('SELECT count(*) AS n FROM sandbox_steps WHERE agent_id = ?', [t.nina])).toEqual({ n: 5 });
  });

  it('[R82] [R16] chaque agent a sa base à lui, avec le schéma du réseau et aucune de ses lignes ; aucun envoi ne sort', async () => {
    const t = await setup();
    await t.call('nina', 'POST', '/reseau/mon-bac-a-sable');
    await t.call('nina', 'POST', '/reseau/mon-bac-a-sable/etapes/contact_recu');
    await t.call('vic', 'POST', '/reseau/mon-bac-a-sable');
    expect([...t.ns.objects.keys()].sort()).toEqual([`agent:${t.nina}`, `agent:${t.vic}`].sort());
    const nina = t.ns.objects.get(`agent:${t.nina}`)!.base;
    const vic = t.ns.objects.get(`agent:${t.vic}`)!.base;
    // Les tables du réseau sont là : le bac à sable tourne sur l'outil en service.
    const tables = (b: SqliteDatabase) => b.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => (r as { name: string }).name);
    const real = (await t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);
    expect(tables(nina).filter((n) => n !== 'bac_a_sable_schema')).toEqual(real);
    // Aucune ligne du réseau : ni ses agents, ni ses clients.
    const dump = JSON.stringify(nina.prepare('SELECT * FROM persons').all()) + JSON.stringify(nina.prepare('SELECT * FROM agents').all()) + JSON.stringify(nina.prepare('SELECT * FROM person_identifiers').all());
    expect(dump).not.toContain('vrai.client@reseau.example');
    expect(dump).not.toContain('Réel');
    expect(dump).not.toContain('Nina');
    expect(nina.prepare('SELECT id FROM networks WHERE id = ?').all(t.network)).toEqual([]);
    // Le contact inventé de Nina n'est que chez elle.
    expect(nina.prepare('SELECT count(*) AS n FROM persons').get()).toEqual({ n: 1 });
    expect(vic.prepare('SELECT count(*) AS n FROM persons').get()).toEqual({ n: 0 });
    // La réponse d'essai reste dans la boîte d'essai du bac à sable ; la base du réseau n'a rien envoyé.
    expect(Number((nina.prepare('SELECT count(*) AS n FROM trial_outbox').get() as { n: number }).n)).toBeGreaterThan(0);
    expect(await t.db.first('SELECT count(*) AS n FROM trial_outbox')).toEqual({ n: 0 });
    // Seul l'agent fait ses étapes [R16].
    expect((await t.call('direction', 'POST', '/reseau/mon-bac-a-sable/etapes/rappel_fait')).body).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('la copie du schéma laisse les objets internes, met les tables avant les index, vues et déclencheurs, et ne se fait qu\'une fois', async () => {
    const base = openMemoryDatabase();
    base.exec(`CREATE TABLE b (id TEXT PRIMARY KEY);
      CREATE TRIGGER b_garde BEFORE DELETE ON b BEGIN SELECT RAISE(ABORT, 'non'); END;
      CREATE TABLE a (id TEXT PRIMARY KEY, b TEXT REFERENCES b(id));
      CREATE INDEX a_b ON a (b);
      CREATE VIEW v AS SELECT id FROM a;
      CREATE TABLE _cf_KV (k TEXT PRIMARY KEY);
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
      INSERT INTO b VALUES ('ligne-reelle');`);
    const db = fromD1(fakeD1(base));
    const statements = await schemaStatements(db);
    expect(statements.map((s) => s.split(/\s+/).slice(0, 3).join(' '))).toEqual(['CREATE TABLE b', 'CREATE TABLE a', 'CREATE INDEX a_b', 'CREATE VIEW v', 'CREATE TRIGGER b_garde']);
    const ns = new FakeNamespace();
    const storage = new DurableSandboxStorage(ns, db);
    const sandbox = await storage.open('agent-1');
    await storage.open('agent-1');
    expect(await sandbox.all('SELECT * FROM b')).toEqual([]);
    expect((await sandbox.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'bac_a_sable_schema'")).length).toBe(1);
    expect(await sandbox.run("INSERT INTO b (id) VALUES ('x') ON CONFLICT DO NOTHING")).toEqual({ changes: 1 });
    expect(await sandbox.run("INSERT INTO b (id) VALUES ('x') ON CONFLICT DO NOTHING")).toEqual({ changes: 0 });
    // Un lot se fait d'un bloc : une erreur n'en garde rien.
    await expect(sandbox.batch!([{ sql: "INSERT INTO b (id) VALUES ('y')" }, { sql: "INSERT INTO a (id, b) VALUES ('1', 'absent')" }])).rejects.toThrow();
    expect(await sandbox.first("SELECT id FROM b WHERE id = 'y'")).toBeNull();
  });
});
