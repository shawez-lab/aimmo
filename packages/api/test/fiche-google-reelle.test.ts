import { expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { gbpFromEnv } from '../src/fiche-google-reelle.ts';
import { GbpError, type GbpAck, type GbpClient, type GbpInfo } from '../../core/src/attirer/fiche-google.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// AU037 · Réseau, agents, clés, identifiants Google et fiches inventés.
const DIRECTION_KEY = 'test-cle-au037-direction-dddddddddddddddddddddd';
const AGENT_KEY = 'test-cle-au037-agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
type Body = { ok: boolean; data?: any; rule?: string | null; code?: string; error?: string; action?: string };

class FakeGoogle implements GbpClient {
  infos: GbpInfo[] = [];
  error: Error | null = null;
  async listReviews() {
    return [];
  }
  async replyToReview(): Promise<GbpAck> {
    throw new GbpError('panne');
  }
  async createPost(): Promise<GbpAck> {
    throw new GbpError('panne');
  }
  async updateInfo(locationRef: string, info: GbpInfo): Promise<GbpAck> {
    if (this.error) throw this.error;
    this.infos.push(info);
    return { ref: locationRef.replace(/^accounts\/[0-9]+\//, '') };
  }
}

async function setup(gbp: GbpClient | null) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2026-11-21T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', 'x')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, created_at, updated_at) VALUES ('ag-1', 'net-1', 'Camille', 'Exemple', 'x', 'x')");
  const apiKeys = JSON.stringify([
    { sha256: await sha256Hex(DIRECTION_KEY), expiresOn: '2099-12-31', role: 'direction', userId: 'dir-1', networkId: 'net-1' },
    { sha256: await sha256Hex(AGENT_KEY), expiresOn: '2099-12-31', role: 'agent', userId: 'ag-1', networkId: 'net-1' },
  ]);
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, ...(gbp ? { attirer: { gbp } } : {}) };
  const call = async (key: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as Body };
  };
  return { db, journal: new SqlJournalStore(db), call };
}

const FICHE = { locationRef: 'accounts/7/locations/42', title: 'Camille Exemple, agent immobilier', websiteUri: 'https://camille.exemple.test' };

describeWithSqlite('AU037 · la fiche Google servie pour de vrai quand le Worker a rangé son client', () => {
  it('le constat : avec le vrai client rangé, l’écran n’est plus en essai et la mise à jour de la fiche remonte l’accusé de Google', async () => {
    const google = new FakeGoogle();
    const t = await setup(google);
    expect((await t.call(DIRECTION_KEY, 'POST', '/attirer/google/agents/ag-1/fiche', FICHE)).status).toBe(200);
    expect((await t.call(DIRECTION_KEY, 'GET', '/attirer/google/agents/ag-1')).body.data).toMatchObject({ connected: true, mode: 'reel', link: { state: 'pret', action: null, info: null } });
    // Seule la direction met la fiche à jour [R16].
    expect(await t.call(AGENT_KEY, 'POST', '/attirer/google/agents/ag-1/informations')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect(google.infos).toEqual([]);
    expect(await t.call(DIRECTION_KEY, 'POST', '/attirer/google/agents/ag-1/informations')).toMatchObject({ status: 200, body: { ok: true, data: { changed: true, mode: 'reel' } } });
    expect(google.infos).toEqual([{ title: FICHE.title, phone: null, websiteUri: FICHE.websiteUri }]);
    expect((await t.call(DIRECTION_KEY, 'GET', '/attirer/google/agents/ag-1')).body.data.link.info).toMatchObject({ ackRef: 'locations/42', error: null });
  });

  it('une connexion refusée par Google est dite avec son geste, à l’envoi comme sur la fiche', async () => {
    const google = new FakeGoogle();
    const t = await setup(google);
    await t.call(DIRECTION_KEY, 'POST', '/attirer/google/agents/ag-1/fiche', FICHE);
    google.error = new GbpError('connexion');
    expect(await t.call(DIRECTION_KEY, 'POST', '/attirer/google/agents/ag-1/informations')).toMatchObject({ status: 400, body: { ok: false, code: 'echec', error: 'connexion', action: 'reconnecter' } });
    expect((await t.call(AGENT_KEY, 'GET', '/attirer/google/moi')).body.data.link).toMatchObject({ state: 'a_reconnecter', action: 'reconnecter' });
  });

  it('[R26] sans le vrai client, la fiche reste d’essai : rien ne part et rien n’est gardé comme accusé', async () => {
    const t = await setup(null);
    await t.call(DIRECTION_KEY, 'POST', '/attirer/google/agents/ag-1/fiche', FICHE);
    expect((await t.call(DIRECTION_KEY, 'GET', '/attirer/google/agents/ag-1')).body.data).toMatchObject({ connected: false, mode: 'essai', link: { state: 'essai' } });
    expect(await t.call(DIRECTION_KEY, 'POST', '/attirer/google/agents/ag-1/informations')).toMatchObject({ status: 200, body: { data: { mode: 'essai' } } });
    expect(await t.db.all('SELECT * FROM gbp_receipts')).toEqual([]);
  });
});

it('[R26] le Worker ne range le vrai client que si tout est réglé et bien formé (H07)', () => {
  const http = (async () => new Response('')) as typeof fetch;
  const all = { GBP_MODE: 'reel', GBP_CLIENT_ID: '123-abc.apps.googleusercontent.com', GBP_CLIENT_SECRET: 'secret-invente', GBP_REFRESH_TOKEN: 'jeton-invente' };
  expect(gbpFromEnv(all, http)).not.toBeNull();
  expect(gbpFromEnv({ ...all, GBP_MODE: 'essai' }, http)).toBeNull();
  expect(gbpFromEnv({ ...all, GBP_MODE: undefined }, http)).toBeNull();
  expect(gbpFromEnv({ ...all, GBP_CLIENT_ID: 'pas-un-client' }, http)).toBeNull();
  expect(gbpFromEnv({ ...all, GBP_CLIENT_SECRET: ' ' }, http)).toBeNull();
  expect(gbpFromEnv({ ...all, GBP_REFRESH_TOKEN: undefined }, http)).toBeNull();
});
