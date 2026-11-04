import { expect, it } from 'vitest';
import type { SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, client, clés.
const ORIGIN = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-sv06-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-sv06-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
const BODY = { requestId: '0b6f1d2e-5555-4a2b-8c3d-000000000020', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 80 };

describeWithSqlite('SV06 · routes des biens dans le socle', () => {
  it('[R16] les routes répondent par l’API : l’agent de la fiche crée et relit, un autre agent est refusé', async () => {
    const t = await setupDossier();
    const samId = (await t.db.first<{ id: string }>("SELECT id FROM agents WHERE network_id = ? AND first_name = 'Sam'", [t.network.id]))!.id;
    const apiKeys = JSON.stringify([
      { sha256: await sha256Hex(KEYS.alex), networkId: t.network.id, role: 'agent', userId: t.alexId },
      { sha256: await sha256Hex(KEYS.sam), networkId: t.network.id, role: 'agent', userId: samId },
    ]);
    const config: ApiConfig = { db: t.db as SqlDatabase, apiKeys, mode: 'essai', now: t.now };
    const call = async (key: string, method: string, body?: unknown) => {
      const r = await handleRequest(
        new Request(`${ORIGIN}/v1/fiches/${t.personId}/biens`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }),
        config,
      );
      return { status: r.status, body: (await r.json()) as { sent?: boolean; data?: unknown } };
    };
    const created = await call(KEYS.alex, 'POST', BODY);
    expect(created.status).toBe(200);
    expect(created.body.sent).toBe(false);
    expect(await t.db.first('SELECT surface_m2 FROM properties WHERE id = ?', [BODY.requestId])).toEqual({ surface_m2: 80 });
    expect((await call(KEYS.alex, 'GET')).status).toBe(200);
    expect((await call(KEYS.sam, 'POST', { ...BODY, requestId: '0b6f1d2e-5555-4a2b-8c3d-000000000021' })).status).toBe(403);
  });
});
