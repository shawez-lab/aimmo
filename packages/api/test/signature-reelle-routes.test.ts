import { expect, it } from 'vitest';
import { FicheClient, applyMigrations } from '@aimmo/core';
import { sha256Hex } from '../src/index.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';
import { fromD1 } from '../src/d1.ts';

// Clés et personnes inventées pour les tests.
const BASE = 'https://aimmo-api.example.workers.dev';
const KEY_AGENT = 'test-cle-signature-agent-aaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_DIRECTION = 'test-cle-signature-direction-cccccccccccccccccccc';

describeWithSqlite('AU003 · routes de la signature en ligne réelle', () => {
  it('[R41] [R16] le mode dit l’essai et ce qui manque ; seule la direction enregistre la validation ; sans mail réel, rien ne devient réel', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    const db = fromD1(d1);
    await applyMigrations(db, loadMigrations());
    const store = new FicheClient(db);
    const network = await store.createNetwork('Réseau test');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const keys = await Promise.all(
      [
        { key: KEY_AGENT, role: 'agent', userId: alex.id },
        { key: KEY_DIRECTION, role: 'direction', userId: 'direction-1' },
      ].map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), networkId: network.id, ...rest })),
    );
    const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify(keys) };
    const call = (method: string, path: string, key: string, body?: unknown) =>
      worker.fetch(new Request(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);

    const mode = await call('GET', '/v1/signature-en-ligne/mode', KEY_AGENT);
    expect(mode.status).toBe(200);
    expect(await mode.json()).toMatchObject({ ok: true, mode: 'essai', data: { mode: 'essai', missing: ['mail_reel', 'validation_avocat'] } });
    expect((await call('POST', '/v1/signature-en-ligne/validation', KEY_AGENT, { reference: 'Avis écrit test', validatedOn: '2026-01-05' })).status).toBe(403);
    expect((await call('POST', '/v1/signature-en-ligne/validation', KEY_DIRECTION, { reference: 'Avis écrit test', validatedOn: 'hier' })).status).toBe(400);
    expect((await call('POST', '/v1/signature-en-ligne/validation', KEY_DIRECTION, { reference: 'Avis écrit test', validatedOn: '2026-01-05', autre: 1 })).status).toBe(400);
    expect((await call('POST', '/v1/signature-en-ligne/validation', KEY_DIRECTION, { reference: 'Avis écrit test', validatedOn: '2026-01-05' })).status).toBe(201);
    // La validation seule ne suffit pas : le mail réel n'est pas branché (H05).
    expect(await (await call('GET', '/v1/signature-en-ligne/mode', KEY_AGENT)).json()).toMatchObject({ data: { mode: 'essai', missing: ['mail_reel'] } });
    expect((await call('POST', '/v1/documents/inconnu/signature-en-ligne/fin', KEY_AGENT, {})).status).toBe(404);
    expect((await call('GET', '/v1/documents/inconnu/dossier-preuve', KEY_AGENT)).status).toBe(404);
  });
});
