import { expect, it } from 'vitest';
import { Acces, FicheAgent, FicheClient, FicheUnique, SqlJournalStore, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, client, clés.
const ORIGIN = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-ac12-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-ac12-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', conformite: 'test-cle-ac12-conf-ccccccccccccccccccccccccccc', direction: 'test-cle-ac12-dir-ddddddddddddddddddddddddddd' };
type Who = keyof typeof KEYS;

async function setup() {
  const t = await setupDossier();
  const samId = (await t.db.first<{ id: string }>("SELECT id FROM agents WHERE network_id = ? AND first_name = 'Sam'", [t.network.id]))!.id;
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: t.alexId }, sam: { role: 'agent', userId: samId }, conformite: { role: 'compliance', userId: 'conf-1' }, direction: { role: 'direction', userId: 'dir-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db as SqlDatabase, apiKeys, mode: 'essai', now: t.now };
  const post = async (who: Who | null, path: string, body: unknown) => {
    const r = await handleRequest(
      new Request(`${ORIGIN}/v1/fiches/${t.personId}${path}`, { method: 'POST', headers: { ...(who ? { authorization: `Bearer ${KEYS[who]}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      config,
    );
    return { status: r.status, body: (await r.json()) as { ok: boolean; rule?: string | null; code?: string; sent?: boolean } };
  };
  const notes = () => t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM call_notes');
  return { t, post, notes };
}

describeWithSqlite('AC12 · appels notés dans le socle', () => {
  it('[R16] [R204] l’agent de la fiche et la direction notent ; un autre agent et la conformité sont refusés, au journal ; sans clé, rien', async () => {
    const { t, post, notes } = await setup();
    expect((await post(null, '/appels', { outcome: 'called' })).status).toBe(401);
    for (const who of ['sam', 'conformite'] as const) {
      const before = (await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM journal'))!.n;
      const refused = await post(who, '/appels', { outcome: 'called' });
      expect(refused.status).toBe(403);
      expect(refused.body.rule).toBe('R16');
      expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM journal'))!.n).toBeGreaterThan(before);
    }
    expect(await notes()).toEqual({ n: 0 });
    expect(await post('alex', '/appels', { outcome: 'called' })).toMatchObject({ status: 200, body: { ok: true, sent: false } });
    expect((await post('direction', '/appels', { outcome: 'refused' })).status).toBe(200);
    expect(await notes()).toEqual({ n: 2 });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox')).toEqual({ n: 0 });
  });

  it('[R204] une demande datée d’avant un refus est refusée par la route branchée', async () => {
    const { t, post } = await setup();
    expect((await post('alex', '/appels', { outcome: 'refused' })).status).toBe(200);
    const proof = 'La personne a redemandé à être rappelée, de vive voix.';
    const givenOn = new Date(t.now().getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    const refused = await post('alex', '/accords', { purpose: 'rappel_demande', channel: 'phone', proof, givenOn });
    expect(refused).toMatchObject({ status: 409, body: { rule: 'R204', code: 'given_before_refusal' } });
    expect(await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM consents WHERE purpose = 'rappel_demande'")).toEqual({ n: 0 });
  });

  it('[R204] la fiche relue ferme l’appel et dit quand il rouvre', async () => {
    const { t, post } = await setup();
    await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'phone', value: '06 00 00 00 03' });
    await t.store.addConsent({ networkId: t.network.id, personId: t.personId, purpose: 'prospecting', channel: 'phone', proof: 'accord de test', givenAt: new Date(t.now().getTime() - 86_400_000) });
    await post('alex', '/appels', { outcome: 'refused' });
    const store = new FicheClient(t.db, { now: t.now });
    const journal = new SqlJournalStore(t.db);
    const acces = new Acces(t.db, store, new FicheUnique(t.db, store, { now: t.now }), journal, { now: t.now });
    const read = await new FicheAgent(t.db, acces, { now: t.now }).read({ role: 'agent', userId: t.alexId, networkId: t.network.id }, t.personId);
    expect(read.ok && read.value).toMatchObject({ call: null, callRefusal: 'refused_recently', callReopensAt: expect.any(String) });
  });
});
