import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents et clés inventés.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const KEYS = {
  alex: 'test-cle-au041-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-au041-direction-cccccccccccccccccccccc',
  compta: 'test-cle-au041-compta-dddddddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    direction: { role: 'direction', userId: t.direction.userId },
    compta: { role: 'accountant', userId: 'compta-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const http = async (who: Who, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string } };
  };
  return { ...t, http };
}

describeWithSqlite('AU041 · routes de la capacité des agents', () => {
  it('[R681] l’agent déclare une capacité nulle pour lui, la lit, et la règle est publiée', async () => {
    const t = await setup();
    const r = await t.http('alex', 'POST', '/attribution/capacites', { capacity: 0, reason: 'Congés' });
    expect(r).toMatchObject({ status: 200, body: { ok: true, data: { agentId: t.alexId, capacity: 0, version: 1 } } });
    const mine = await t.http('alex', 'GET', '/attribution/capacites');
    expect(mine.body.data).toEqual([{ agentId: t.alexId, capacity: 0, waiting: 0, full: true, version: 1 }]);
    expect((await t.http('alex', 'GET', '/attribution/regles')).body.data.rules.join(' ')).toMatch(/capacité déclarée/);
  });

  it('[R16] un autre rôle refusé 403 ; un agent pour un autre 403 ; [R681] inchangée 409, mal formée 409, corps absent 400', async () => {
    const t = await setup();
    expect(await t.http('compta', 'GET', '/attribution/capacites')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.http('compta', 'POST', '/attribution/capacites', { capacity: 1, reason: 'Essai' })).toMatchObject({ status: 403 });
    expect(await t.http('alex', 'POST', '/attribution/capacites', { agentId: 'autre', capacity: 1, reason: 'Essai' })).toMatchObject({ status: 403 });
    await t.http('direction', 'POST', '/attribution/capacites', { agentId: t.alexId, capacity: 2, reason: 'Mi-temps' });
    expect(await t.http('direction', 'POST', '/attribution/capacites', { agentId: t.alexId, capacity: 2, reason: 'Mi-temps' })).toMatchObject({ status: 409, body: { rule: 'R681', code: 'inchangee' } });
    expect(await t.http('direction', 'POST', '/attribution/capacites', { agentId: t.alexId, capacity: 'deux', reason: 'Mi-temps' })).toMatchObject({ status: 409, body: { code: 'bad_capacity' } });
    expect((await t.http('direction', 'POST', '/attribution/capacites')).status).toBe(400);
    const all = await t.http('direction', 'GET', '/attribution/capacites');
    expect(all.body.data.find((c: { agentId: string }) => c.agentId === t.alexId)).toMatchObject({ capacity: 2, full: false });
  });

  it('docs/API.md décrit les routes de la capacité', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/\| GET \| `\/v1\/attribution\/capacites`/);
    expect(doc).toMatch(/\| POST \| `\/v1\/attribution\/capacites`/);
    expect(doc).toMatch(/R681/);
  });
});
