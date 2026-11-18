import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, type Viewer } from '@aimmo/core';
import { identiteAuCoffre } from '../../core/test/identite-coffre.ts';
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

describeWithSqlite('D03, D04 · routes des contrôles avant signature et de la signature papier', () => {
  it('[R41, R16, R39] barème, identité vérifiée, contrôle passé, puis mandat signé et numéroté ; sans identité, refusé', async () => {
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
    const scanRef = `mandats/${bien.id}/test-1.pdf`;
    const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify(keys), PIECES: { head: async (k: string) => (k === scanRef ? {} : null) } as never };
    const post = async (path: string, key: string, body: unknown = {}) =>
      worker.fetch(new Request(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);

    const template = (await (await post('/v1/modeles', KEY_DIRECTION, { kind: 'mandat_vente_simple', body: 'Test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}, {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.' })).json()) as { data: { id: string } };
    await post(`/v1/modeles/${template.data.id}/validation`, KEY_COMPLIANCE);
    expect((await post('/v1/honoraires/bareme', KEY_AGENT, { maxRatePercent: 5, minEur: 3000 })).status).toBe(403);
    expect((await post('/v1/honoraires/bareme', KEY_DIRECTION, { maxRatePercent: 5, minEur: 3000 })).status).toBe(200);
    // AU002 : la désignation du bien et le domicile du mandant, saisis par leurs routes ; un autre agent ne le peut pas.
    expect((await post(`/v1/biens/${bien.id}/designation`, KEY_AGENT, { address: { street: '1 rue de l’Essai', postalCode: '21000', city: 'Dijon' }, parcels: [{ section: 'AB', number: '1' }] })).status).toBe(200);
    expect((await post(`/v1/biens/${bien.id}/designation`, KEY_AGENT, { address: { street: '1 rue de l’Essai', postalCode: '21000', city: 'Dijon' }, parcels: [] })).status).toBe(400);
    expect((await post(`/v1/biens/${bien.id}/designation`, KEY_AGENT, { address: {}, parcels: [], autre: 1 })).status).toBe(400);
    expect((await post(`/v1/biens/${bien.id}/designation`, KEY_COMPLIANCE, { address: { street: '1 rue de l’Essai', postalCode: '21000', city: 'Dijon' }, parcels: [{ section: 'AB', number: '1' }] })).status).toBe(403);
    expect((await post(`/v1/fiches/${lea.id}/domicile`, KEY_COMPLIANCE, { street: '2 avenue du Test', postalCode: '21000', city: 'Dijon' })).status).toBe(403);
    expect((await post(`/v1/fiches/${lea.id}/domicile`, KEY_AGENT, { street: '2 avenue du Test', postalCode: '21000', city: 'Dijon' })).status).toBe(200);
    const doc = (await (await post('/v1/documents', KEY_AGENT, { kind: 'mandat_vente_simple', personId: lea.id, propertyId: bien.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur' } })).json()) as { data: { id: string } };
    const before = (await (await post(`/v1/documents/${doc.data.id}/controle`, KEY_AGENT)).json()) as { data: { passed: boolean } };
    expect(before.data.passed).toBe(false);
    expect((await post(`/v1/fiches/${lea.id}/identite`, KEY_AGENT, { piece: 'carte_identite', seenAt: '2020-01-01', numero: 'x' })).status).toBe(400);
    expect((await post(`/v1/fiches/${lea.id}/identite`, KEY_AGENT, { piece: 'carte_identite', seenAt: new Date().toISOString() })).status).toBe(200);
    // Depuis L03, la case « pièce vue » ne suffit plus : seule la pièce déposée au coffre fait foi [R92].
    const still = (await (await post(`/v1/documents/${doc.data.id}/controle`, KEY_AGENT)).json()) as { data: { passed: boolean } };
    expect(still.data.passed).toBe(false);
    const journal = new SqlJournalStore(db);
    const acces = new Acces(db, store, new FicheUnique(db, store), journal);
    const deposited = await identiteAuCoffre({ db, acces, journal, now: () => new Date() }, { role: 'agent', userId: alex.id, networkId: network.id } as Viewer, lea.id, { piece: 'carte_identite', seenAt: new Date() });
    expect(deposited.ok).toBe(true);
    const after = (await (await post(`/v1/documents/${doc.data.id}/controle`, KEY_AGENT)).json()) as { data: { passed: boolean } };
    expect(after.data.passed).toBe(true);
    // D04 : signé sur papier, numéroté au registre, exemplaire avec son numéro.
    await post('/v1/registre/reglage', KEY_DIRECTION, { prefix: 'T-', firstNumber: 1, width: 3 });
    const paper = { signedAt: new Date(Date.now() - 60_000).toISOString(), place: 'agence', scanRef, source: 'referral' };
    const signed = await post(`/v1/documents/${doc.data.id}/signature-papier`, KEY_AGENT, paper);
    expect(signed.status).toBe(200);
    expect(((await signed.json()) as { data: { number: string } }).data.number).toBe('T-001');
    expect((await post(`/v1/documents/${doc.data.id}/signature-papier`, KEY_AGENT, paper)).status).toBe(409);
    const copy = (await (await worker.fetch(new Request(`${BASE}/v1/documents/${doc.data.id}/exemplaire`, { headers: { authorization: `Bearer ${KEY_AGENT}` } }), env)).json()) as { data: { number: string; content: string } };
    expect(copy.data.content).toContain('<span class="signe">T-001</span>');
    // D05 : la décision de diffusion se lit sous les droits du bien ; ce modèle de test n'a pas de durée.
    const bienId = bien.id;
    const decision = (await (await worker.fetch(new Request(`${BASE}/v1/biens/${bienId}/diffusion`, { headers: { authorization: `Bearer ${KEY_AGENT}` } }), env)).json()) as { data: { allowed: boolean; reason: string } };
    expect(decision.data).toMatchObject({ allowed: false, reason: 'duration_unknown' });
    const signedBody = (await (await worker.fetch(new Request(`${BASE}/v1/documents/${doc.data.id}/exemplaire`, { headers: { authorization: `Bearer ${KEY_AGENT}` } }), env)).json()) as { data: unknown };
    expect(signedBody.data).toBeTruthy();
    const mandate = await db.first<{ id: string }>('SELECT id FROM mandates');
    const late = await post(`/v1/mandats/${mandate!.id}/retractation`, KEY_AGENT, { proof: 'test', receivedAt: new Date().toISOString() });
    expect(late.status).toBe(400);
    expect(((await late.json()) as { code: string }).code).toBe('no_withdrawal_period');
    expect((await post(`/v1/mandats/${mandate!.id}/retractation`, KEY_AGENT, { proof: 'test', receivedAt: 'hier' })).status).toBe(400);
    expect(JSON.stringify(await new SqlJournalStore(db).all())).not.toMatch(/test-cle|Léa/);
  });
});
