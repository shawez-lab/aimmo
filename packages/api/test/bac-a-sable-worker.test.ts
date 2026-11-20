import { expect, it } from 'vitest';
import { FicheClient, FicheUnique, applyMigrations, type SqlDatabase, type SqlValue } from '@aimmo/core';
import { sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { D1SandboxStorage } from '../src/bac-a-sable.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// AU025 · Réseau, agents et clients inventés.
const BASE = 'https://aimmo-api.example.test';
const KEYS = { nina: 'test-cle-au025-nina-aaaaaaaaaaaaaaaaaaaaaaaaaaa', vic: 'test-cle-au025-vic-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', direction: 'test-cle-au025-direction-ccccccccccccccccccccc' };
type Who = keyof typeof KEYS;

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
  // La base à part des bacs à sable : une autre base D1, avec les mêmes migrations.
  const sandboxBase = openMemoryDatabase();
  const sandbox: SqlDatabase = fromD1(fakeD1(sandboxBase));
  await applyMigrations(sandbox, loadMigrations());
  const env: Env = { DB: d1, API_KEYS: apiKeys, MODE: 'essai', BAC_A_SABLE_DB: fakeD1(sandboxBase) };
  const call = async (who: Who, method: string, path: string, e: Env = env) => {
    const r = await worker.fetch(new Request(`${BASE}/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}` } }), e);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; code?: string; rule?: string | null } };
  };
  return { d1, db, network, nina, vic, real, sandbox, sandboxBase, env, call };
}

describeWithSqlite('AU025 · le bac à sable servi par le Worker', () => {
  it('[R82] constat : sans sa base à part, le Worker laissait le premier parcours fermé ; avec elle, l\'agent ouvre son exercice et fait les cinq étapes depuis son écran', async () => {
    const t = await setup();
    // Le constat de l'audit : sans la liaison, le parcours reste « pas encore en service ».
    const { BAC_A_SABLE_DB: _sandbox, ...closed } = t.env;
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

  it('[R82] [R16] la base des bacs à sable n\'a aucune ligne du réseau ; chaque agent y a son réseau d\'entraînement, sans rien mêler ; aucun envoi ne sort', async () => {
    const t = await setup();
    await t.call('nina', 'POST', '/reseau/mon-bac-a-sable');
    await t.call('nina', 'POST', '/reseau/mon-bac-a-sable/etapes/contact_recu');
    await t.call('vic', 'POST', '/reseau/mon-bac-a-sable');
    const box = t.sandboxBase;
    // Aucune ligne du réseau : ni ses agents réels, ni ses clients.
    const dump = JSON.stringify(box.prepare('SELECT * FROM persons').all()) + JSON.stringify(box.prepare('SELECT * FROM agents').all()) + JSON.stringify(box.prepare('SELECT * FROM person_identifiers').all());
    expect(dump).not.toContain('vrai.client@reseau.example');
    expect(dump).not.toContain('Réel');
    expect(dump).not.toContain('Nina');
    expect(box.prepare('SELECT id FROM networks WHERE id = ?').all(t.network)).toEqual([]);
    // Deux réseaux d'entraînement, un par agent ; le contact inventé de Nina n'est que dans le sien.
    const nets = box.prepare('SELECT n.id AS id, a.id AS agent FROM networks n JOIN agents a ON a.network_id = n.id ORDER BY a.id').all() as { id: string; agent: string }[];
    expect(nets.map((r) => r.agent).sort()).toEqual([t.nina, t.vic].sort());
    const netOf = (agent: string) => nets.find((r) => r.agent === agent)!.id;
    expect(box.prepare('SELECT count(*) AS n FROM persons WHERE network_id = ?').get(netOf(t.nina))).toEqual({ n: 1 });
    expect(box.prepare('SELECT count(*) AS n FROM persons WHERE network_id = ?').get(netOf(t.vic))).toEqual({ n: 0 });
    // Le contact de Nina ne fait rien avancer chez Vic.
    const vic = await t.call('vic', 'GET', '/reseau/mon-bac-a-sable');
    expect(vic.body.data.steps.every((s: { done: boolean }) => !s.done)).toBe(true);
    expect((await t.call('vic', 'POST', '/reseau/mon-bac-a-sable/etapes/rappel_fait')).body).toMatchObject({ ok: false, code: 'not_next_step' });
    // La réponse d'essai reste dans la boîte d'essai du bac à sable ; la base du réseau n'a rien envoyé.
    expect(Number((box.prepare('SELECT count(*) AS n FROM trial_outbox').get() as { n: number }).n)).toBeGreaterThan(0);
    expect(await t.db.first('SELECT count(*) AS n FROM trial_outbox')).toEqual({ n: 0 });
    // Seul l'agent fait ses étapes [R16].
    expect((await t.call('direction', 'POST', '/reseau/mon-bac-a-sable/etapes/rappel_fait')).body).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('la base du bac à sable n\'est jamais celle du réseau', async () => {
    const t = await setup();
    expect(() => new D1SandboxStorage(t.db, t.db)).toThrow();
    // La même base liée deux fois : le Worker garde le bac à sable fermé.
    expect((await t.call('nina', 'POST', '/reseau/mon-bac-a-sable', { ...t.env, BAC_A_SABLE_DB: t.d1 })).status).toBe(503);
    expect(await new D1SandboxStorage(t.sandbox, t.db).open(t.nina)).toBe(t.sandbox);
  });
});
