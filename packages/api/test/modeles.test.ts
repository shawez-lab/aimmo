import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations } from '@aimmo/core';
import { sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés et modèle inventés pour les tests.
const BASE = 'https://aimmo-api.example.workers.dev';
const KEY_AGENT = 'test-cle-modeles-agent-aaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_OTHER = 'test-cle-modeles-autre-bbbbbbbbbbbbbbbbbbbbbbbb';
const KEY_DIRECTION = 'test-cle-modeles-direction-cccccccccccccccccccc';
const KEY_COMPLIANCE = 'test-cle-modeles-conformite-dddddddddddddddddddd';

describeWithSqlite('D02 · routes des modèles et des documents', () => {
  it('[R40, R16] création par la direction, validation par la conformité, génération par l’agent de la fiche', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    const db = fromD1(d1);
    await applyMigrations(db, loadMigrations());
    const store = new FicheClient(db);
    const network = await store.createNetwork('Réseau test');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
    const lea = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
    const bien = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
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
    const body = 'Mandat de test entre {{mandant.nom}} et {{agent.nom}} pour {{bien.reference}}.\n\n' + 'Texte long de test. '.repeat(1000);
    expect((await call('/v1/modeles', KEY_AGENT, { kind: 'mandat_vente_simple', body })).status).toBe(403);
    const created = await call('/v1/modeles', KEY_DIRECTION, { kind: 'mandat_vente_simple', body });
    expect(created.status).toBe(200);
    const template = ((await created.json()) as { data: { id: string; status: string } }).data;
    expect(template.status).toBe('essai');
    expect((await call(`/v1/modeles/${template.id}/validation`, KEY_DIRECTION, {})).status).toBe(403);

    const gen = (key: string) => call('/v1/documents', key, { kind: 'mandat_vente_simple', personId: lea.id, propertyId: bien.id });
    const trial = (await (await gen(KEY_AGENT)).json()) as { data: { mode: string; status: string; content: string } };
    expect(trial.data).toMatchObject({ mode: 'essai', status: 'complet' });
    expect((await call(`/v1/modeles/${template.id}/validation`, KEY_COMPLIANCE, {})).status).toBe(200);
    const real = (await (await gen(KEY_AGENT)).json()) as { data: { id: string; mode: string; content: string } };
    expect(real.data.mode).toBe('reel');
    expect(real.data.content).toContain('Mandat de test entre Léa Exemple et Alex Agent pour REF-T-1.');
    expect((await gen(KEY_OTHER)).status).toBe(403);
    expect((await call(`/v1/documents/${real.data.id}`, KEY_AGENT)).status).toBe(200);
    expect((await call(`/v1/documents/${real.data.id}`, KEY_OTHER)).status).toBe(403);
    expect((await call('/v1/documents', KEY_AGENT, { kind: 'mandat_vente_simple', personId: lea.id, propertyId: bien.id, extra: 1 })).status).toBe(400);
    expect(((await (await call('/v1/modeles', KEY_AGENT)).json()) as { data: unknown[] }).data).toHaveLength(1);
    expect(JSON.stringify(await new SqlJournalStore(db).all())).not.toMatch(/test-cle|Léa/);
  });
});
