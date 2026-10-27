import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, RegistreMandats, SqlJournalStore, applyMigrations } from '@aimmo/core';
import { sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés et registre inventés pour les tests.
const BASE = 'https://aimmo-api.example.workers.dev';
const KEY_AGENT = 'test-cle-registre-agent-aaaaaaaaaaaaaaaaaaaaaaa';
const KEY_OTHER = 'test-cle-registre-autre-bbbbbbbbbbbbbbbbbbbbbbb';
const KEY_DIRECTION = 'test-cle-registre-direction-ccccccccccccccccccc';
const KEY_COMPLIANCE = 'test-cle-registre-conformite-ddddddddddddddddddd';

describeWithSqlite('D01 · routes du registre des mandats', () => {
  it('[R39, R16] réglage par la direction, une fois ; contrôle par la direction et la conformité ; lignes pour l’agent du mandat', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    const db = fromD1(d1);
    await applyMigrations(db, loadMigrations());
    const store = new FicheClient(db);
    const network = await store.createNetwork('Réseau test');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
    const keys = await Promise.all(
      [
        { key: KEY_AGENT, role: 'agent', userId: alex.id },
        { key: KEY_OTHER, role: 'agent', userId: sam.id },
        { key: KEY_DIRECTION, role: 'direction', userId: 'direction-1' },
        { key: KEY_COMPLIANCE, role: 'compliance', userId: 'conformite-1' },
      ].map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), networkId: network.id, ...rest })),
    );
    const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify(keys) };
    const call = (path: string, key: string, body?: unknown) =>
      worker.fetch(
        new Request(`${BASE}${path}`, body === undefined ? { headers: { authorization: `Bearer ${key}` } } : { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        env,
      );

    expect((await call('/v1/registre/reglage', KEY_AGENT, { prefix: 'T-', firstNumber: 1, width: 3 })).status).toBe(403);
    expect((await call('/v1/registre/reglage', KEY_DIRECTION, { prefix: 'T-', firstNumber: 1, width: 3, extra: 1 })).status).toBe(400);
    expect((await call('/v1/registre/reglage', KEY_DIRECTION, { prefix: 'T-', firstNumber: 0, width: 3 })).status).toBe(400);
    expect((await call('/v1/registre/reglage', KEY_DIRECTION, { prefix: 'T-', firstNumber: 7, width: 3 })).status).toBe(200);
    expect((await call('/v1/registre/reglage', KEY_DIRECTION, { prefix: 'T-', firstNumber: 1, width: 3 })).status).toBe(409);

    const journal = new SqlJournalStore(db);
    const fiche = new FicheUnique(db, store);
    const acces = new Acces(db, store, fiche, journal);
    const lea = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa' });
    const m = await new Mandats(db, fiche, journal).record(acces, { role: 'agent', userId: alex.id, networkId: network.id }, { personId: lea.id, signedAt: new Date('2027-02-10T10:00:00Z'), source: 'referral' });
    if (!m.ok) throw new Error(m.code);
    await new RegistreMandats(db, journal).inscribe({ role: 'agent', userId: alex.id, networkId: network.id }, m.id);

    const lines = (await (await call(`/v1/mandats/${m.id}/registre`, KEY_AGENT)).json()) as { data: { number: string }[] };
    expect(lines.data.map((l) => l.number)).toEqual(['T-007']);
    expect((await call(`/v1/mandats/${m.id}/registre`, KEY_OTHER)).status).toBe(403);
    for (const key of [KEY_DIRECTION, KEY_COMPLIANCE]) {
      expect(await (await call('/v1/registre/controle', key)).json()).toEqual({ ok: true, mode: 'essai', data: { ok: true, lines: 1 } });
    }
    expect((await call('/v1/registre/controle', KEY_AGENT)).status).toBe(403);
    expect(JSON.stringify(await journal.all())).not.toMatch(/test-cle|Léa/);
  });
});
