import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, client, clés.
const ORIGIN = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-c09c-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-c09c-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', direction: 'test-cle-c09c-dir-ddddddddddddddddddddddddddddd' };
type Who = keyof typeof KEYS;
const now = (): Date => new Date('2026-12-08T09:00:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Autre' });
  const lea = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  await db.run(`INSERT INTO agent_alerts (id, network_id, agent_id, person_id, conversation_id, reason, created_at, seen_at) VALUES ('al-1', ?, ?, ?, 'email:conv', 'needs_reply', ?, NULL)`, [network.id, alex.id, lea.id, now().toISOString()]);
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex.id }, sam: { role: 'agent', userId: sam.id }, direction: { role: 'direction', userId: 'direction-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
  const call = async (who: Who | null, method: string, path: string) => {
    const r = await handleRequest(new Request(`${ORIGIN}/v1${path}`, { method, headers: who ? { authorization: `Bearer ${KEYS[who]}` } : {} }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; rule?: string; code?: string; sent?: boolean; data?: { alerts?: { id: string }[]; already?: boolean } } };
  };
  return { db, call, journal: new SqlJournalStore(db) };
}

describeWithSqlite('C09c · routes des alertes', () => {
  it('[R16] [R17] l’agent lit et marque ses alertes, jamais celles d’un autre ; rien n’est envoyé ; la ligne reste', async () => {
    const t = await setup();
    expect(await t.call(null, 'GET', '/alertes-agent')).toMatchObject({ status: 401 });
    const mine = await t.call('alex', 'GET', '/alertes-agent');
    expect(mine.status).toBe(200);
    expect(mine.body.data?.alerts?.map((a) => a.id)).toEqual(['al-1']);
    expect((await t.call('sam', 'GET', '/alertes-agent')).body.data?.alerts).toEqual([]);
    expect(await t.call('sam', 'POST', '/alertes-agent/al-1/vue')).toMatchObject({ status: 403, body: { ok: false, rule: 'R16', code: 'not_assigned' } });
    expect(await t.call('direction', 'GET', '/alertes-agent')).toMatchObject({ status: 403, body: { code: 'role' } });
    expect(await t.call('alex', 'POST', '/alertes-agent/al-1/vue')).toMatchObject({ status: 200, body: { ok: true, sent: false, data: { already: false } } });
    expect((await t.call('alex', 'GET', '/alertes-agent')).body.data?.alerts).toEqual([]);
    expect((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM agent_alerts WHERE seen_at IS NOT NULL'))!.n).toBe(1);
  });
});
