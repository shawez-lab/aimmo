import { expect, it } from 'vitest';
import type { SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, client, clés.
const ORIGIN = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-ac02-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-ac02-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', conformite: 'test-cle-ac02-conf-ccccccccccccccccccccccccccc', direction: 'test-cle-ac02-dir-ddddddddddddddddddddddddddddd' };
type Who = keyof typeof KEYS;
const PROOF = 'Accord donné de vive voix au rendez-vous, pour suivre sa vente par mail.';

async function setup() {
  const t = await setupDossier();
  const samId = (await t.db.first<{ id: string }>("SELECT id FROM agents WHERE network_id = ? AND first_name = 'Sam'", [t.network.id]))!.id;
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: t.alexId }, sam: { role: 'agent', userId: samId }, conformite: { role: 'compliance', userId: 'conf-1' }, direction: { role: 'direction', userId: 'direction-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db as SqlDatabase, apiKeys, mode: 'essai', now: t.now };
  const post = async (who: Who | null, path: string, body?: unknown) => {
    const r = await handleRequest(
      new Request(`${ORIGIN}/v1/fiches/${t.personId}${path}`, {
        method: 'POST',
        headers: { ...(who ? { authorization: `Bearer ${KEYS[who]}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      config,
    );
    return { status: r.status, body: (await r.json()) as { ok: boolean; rule?: string | null; code?: string; sent?: boolean; data?: { consentId: string; already?: boolean } } };
  };
  const accord = () => ({ purpose: 'suivi_vente', channel: 'email', proof: PROOF, givenOn: new Date(t.now().getTime() - 86_400_000).toISOString().slice(0, 10) });
  const lines = () => t.db.all<{ type: string; data: string }>('SELECT type, data FROM journal ORDER BY rowid');
  return { t, post, accord, lines };
}

describeWithSqlite('AC02 · routes des accords dans le socle', () => {
  it('[R16] [R202] l’agent de la fiche note puis retire un accord par l’API, rien n’est envoyé, la ligne reste', async () => {
    const { t, post, accord, lines } = await setup();
    const noted = await post('alex', '/accords', accord());
    expect(noted.status).toBe(200);
    expect(noted.body).toMatchObject({ ok: true, sent: false, data: { already: false } });
    const id = noted.body.data!.consentId;
    expect((await post('alex', `/accords/${id}/retrait`)).status).toBe(200);
    const row = await t.db.first<{ withdrawn_at: string | null }>('SELECT withdrawn_at FROM consents WHERE id = ?', [id]);
    expect(row?.withdrawn_at).not.toBeNull();
    const journal = await lines();
    expect(journal.some((l) => l.type === 'fiche.accord_note')).toBe(true);
    expect(journal.some((l) => l.type === 'fiche.accord_retire')).toBe(true);
    expect(JSON.stringify(journal)).not.toContain('vive voix');
  });

  it('[R16] la direction le peut aussi ; un autre agent et la conformité sont refusés et le refus va au journal ; sans clé, rien', async () => {
    const { t, post, accord, lines } = await setup();
    expect((await post(null, '/accords', accord())).status).toBe(401);
    for (const who of ['sam', 'conformite'] as const) {
      const before = (await lines()).length;
      const refused = await post(who, '/accords', accord());
      expect(refused.status).toBe(403);
      expect(refused.body.rule).toBe('R16');
      expect((await lines()).length).toBeGreaterThan(before);
    }
    const noted = await post('direction', '/accords', accord());
    expect(noted.status).toBe(200);
    const refused = await post('sam', `/accords/${noted.body.data!.consentId}/retrait`);
    expect(refused.status).toBe(403);
    expect((await post('direction', `/accords/${noted.body.data!.consentId}/retrait`)).status).toBe(200);
  });

  it('[R04] [R202] une personne qui a demandé l’arrêt ne reçoit aucun accord par la route', async () => {
    const { t, post, accord } = await setup();
    await t.store.addExclusion({ networkId: t.network.id, personId: t.personId, reason: 'stop', notedAt: new Date(t.now().getTime() - 60_000) });
    const refused = await post('alex', '/accords', accord());
    expect(refused.status).toBe(409);
    expect(refused.body.rule).toBe('R04');
  });
});
