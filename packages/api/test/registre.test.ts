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

  it('[R16, R39, R41] D13 : la direction seule lit le barème, le format et la liste, par pages, chacun dans son réseau', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    const db = fromD1(d1);
    await applyMigrations(db, loadMigrations());
    const store = new FicheClient(db);
    const network = await store.createNetwork('Réseau test');
    const other = await store.createNetwork('Autre réseau');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const keys = await Promise.all(
      [
        { key: KEY_AGENT, role: 'agent', userId: alex.id, networkId: network.id },
        { key: KEY_DIRECTION, role: 'direction', userId: 'direction-1', networkId: network.id },
        { key: KEY_COMPLIANCE, role: 'compliance', userId: 'conformite-1', networkId: network.id },
        { key: KEY_OTHER, role: 'direction', userId: 'direction-2', networkId: other.id },
      ].map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), ...rest })),
    );
    const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify(keys) };
    const get = async (path: string, key: string) => {
      const r = await worker.fetch(new Request(`${BASE}/v1${path}`, { headers: { authorization: `Bearer ${key}` } }), env);
      return { status: r.status, body: (await r.json()) as { code?: string; data: never } };
    };
    const post = (path: string, key: string, body: unknown) => worker.fetch(new Request(`${BASE}/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);

    // Rien de réglé : dit tel, jamais un réglage inventé.
    expect((await get('/honoraires/bareme', KEY_DIRECTION)).body.data).toBeNull();
    expect((await get('/registre/reglage', KEY_DIRECTION)).body.data).toBeNull();
    expect((await get('/registre/lignes', KEY_DIRECTION)).body.data).toEqual({ entries: [], next: null });

    for (const key of [KEY_AGENT, KEY_COMPLIANCE]) {
      for (const path of ['/honoraires/bareme', '/registre/reglage', '/registre/lignes']) expect((await get(path, key)).status).toBe(403);
    }

    await post('/honoraires/bareme', KEY_DIRECTION, { maxRatePercent: 5, minEur: 2000 });
    await post('/honoraires/bareme', KEY_DIRECTION, { maxRatePercent: 5.5, minEur: 3000 });
    expect((await get('/honoraires/bareme', KEY_DIRECTION)).body.data).toMatchObject({ maxRatePercent: 5.5, minEur: 3000 });
    expect((await get('/honoraires/bareme', KEY_OTHER)).body.data).toBeNull();

    await post('/registre/reglage', KEY_DIRECTION, { prefix: 'T-', firstNumber: 7, width: 3 });
    expect((await get('/registre/reglage', KEY_DIRECTION)).body.data).toMatchObject({ prefix: 'T-', firstNumber: 7, width: 3, next: 'T-007' });

    const journal = new SqlJournalStore(db);
    const fiche = new FicheUnique(db, store);
    const acces = new Acces(db, store, fiche, journal);
    const agent = { role: 'agent', userId: alex.id, networkId: network.id } as const;
    const lea = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa' });
    const ids: string[] = [];
    for (let i = 0; i < 31; i++) {
      const m = await new Mandats(db, fiche, journal).record(acces, agent, { personId: lea.id, signedAt: new Date('2027-02-10T10:00:00Z'), source: 'referral' });
      if (!m.ok) throw new Error(m.code);
      await new RegistreMandats(db, journal).inscribe(agent, m.id);
      ids.push(m.id);
    }
    expect((await get('/registre/reglage', KEY_DIRECTION)).body.data).toMatchObject({ next: 'T-038' });
    expect((await post(`/mandats/${ids[30]}/annulation`, KEY_DIRECTION, { reason: 'error' })).status).toBe(200);

    type Page = { entries: { mandateId: string; number: string; agentName: string | null; cancelReason: string | null; cancelledAt: string | null }[]; next: number | null };
    const first = (await get('/registre/lignes', KEY_DIRECTION)).body.data as Page;
    expect(first.entries).toHaveLength(30);
    // Le plus récent d'abord, sa ligne d'annulation portée par lui, jamais comptée pour un mandat de plus.
    expect(first.entries[0]).toMatchObject({ mandateId: ids[30], number: 'T-037', agentName: 'Alex Agent', cancelReason: 'error' });
    expect(first.entries[1]).toMatchObject({ number: 'T-036', cancelledAt: null, cancelReason: null });
    expect(first.next).toBe(2);
    const second = (await get(`/registre/lignes?avant=${first.next}`, KEY_DIRECTION)).body.data as Page;
    expect(second.entries.map((e) => e.number)).toEqual(['T-007']);
    expect(second.next).toBeNull();
    for (const bad of ['0', 'x', '1;2', '-1']) expect((await get(`/registre/lignes?avant=${encodeURIComponent(bad)}`, KEY_DIRECTION)).status).toBe(400);
    expect((await get('/registre/lignes', KEY_OTHER)).body.data).toEqual({ entries: [], next: null });
    expect((await get('/registre/reglage', KEY_OTHER)).body.data).toBeNull();
    // Lire n'abîme pas le registre, et le journal n'a retenu ni nom ni numéro de mandat.
    expect(await (await post('/registre/reglage', KEY_DIRECTION, { prefix: 'X', firstNumber: 1, width: 1 })).status).toBe(409);
    expect(((await get('/registre/controle', KEY_DIRECTION)).body.data as { ok: boolean }).ok).toBe(true);
    expect(JSON.stringify(await journal.all())).not.toMatch(/Alex Agent|Léa|T-037/);
  });
});
