import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations } from '@aimmo/core';
import { sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés, modèle et personnes inventés pour les tests.
const BASE = 'https://aimmo-api.example.workers.dev';
const KEY_AGENT = 'test-cle-controle-agent-aaaaaaaaaaaaaaaaaaaaaaa';
const KEY_DIRECTION = 'test-cle-controle-direction-ccccccccccccccccccc';
const KEY_COMPLIANCE = 'test-cle-controle-conformite-ddddddddddddddddddd';

describeWithSqlite('D03 · routes des contrôles avant signature', () => {
  it('[R41, R16] barème, identité vérifiée, puis contrôle passé ; sans identité, refusé', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    const db = fromD1(d1);
    await applyMigrations(db, loadMigrations());
    const store = new FicheClient(db);
    const network = await store.createNetwork('Réseau test');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const lea = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
    const bien = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: lea.id, kind: 'sell' });
    await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: bien.id, role: 'owned' });
    const keys = await Promise.all(
      [
        { key: KEY_AGENT, role: 'agent', userId: alex.id },
        { key: KEY_DIRECTION, role: 'direction', userId: 'direction-1' },
        { key: KEY_COMPLIANCE, role: 'compliance', userId: 'conformite-1' },
      ].map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), networkId: network.id, ...rest })),
    );
    const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify(keys) };
    const post = async (path: string, key: string, body: unknown = {}) =>
      worker.fetch(new Request(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);

    const template = (await (await post('/v1/modeles', KEY_DIRECTION, { kind: 'mandat_vente_simple', body: 'Test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}.' })).json()) as { data: { id: string } };
    await post(`/v1/modeles/${template.data.id}/validation`, KEY_COMPLIANCE);
    expect((await post('/v1/honoraires/bareme', KEY_AGENT, { maxRatePercent: 5, minEur: 3000 })).status).toBe(403);
    expect((await post('/v1/honoraires/bareme', KEY_DIRECTION, { maxRatePercent: 5, minEur: 3000 })).status).toBe(200);
    const doc = (await (await post('/v1/documents', KEY_AGENT, { kind: 'mandat_vente_simple', personId: lea.id, propertyId: bien.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur' } })).json()) as { data: { id: string } };
    const before = (await (await post(`/v1/documents/${doc.data.id}/controle`, KEY_AGENT)).json()) as { data: { passed: boolean } };
    expect(before.data.passed).toBe(false);
    expect((await post(`/v1/fiches/${lea.id}/identite`, KEY_AGENT, { piece: 'carte_identite', seenAt: '2020-01-01', numero: 'x' })).status).toBe(400);
    expect((await post(`/v1/fiches/${lea.id}/identite`, KEY_AGENT, { piece: 'carte_identite', seenAt: new Date().toISOString() })).status).toBe(200);
    const after = (await (await post(`/v1/documents/${doc.data.id}/controle`, KEY_AGENT)).json()) as { data: { passed: boolean } };
    expect(after.data.passed).toBe(true);
    expect(JSON.stringify(await new SqlJournalStore(db).all())).not.toMatch(/test-cle|Léa/);
  });
});
