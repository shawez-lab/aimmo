import { expect, it } from 'vitest';
import { FicheClient, applyMigrations } from '@aimmo/core';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { R2DossierStorage, type R2DossierBucket } from '../src/commerces.ts';
import { fromD1 } from '../src/d1.ts';
import { sha256Hex } from '../src/index.ts';
import worker, { type Env } from '../src/worker.ts';
import { fakeD1 } from './fake-d1.ts';

// Réseau, agent, commerce, documents et clé inventés.
const BASE = 'https://aimmo-api.example.workers.dev';
const KEY = 'test-cle-ce22-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEXT = 'Bail commercial inventé : 9 ans, loyer à l’étude. Ligne 2, « été » € 𝄞\n\n  fin ';
const DOC = { kind: 'bail', title: 'Bail commercial', content: TEXT };

/** Un compartiment qui range des octets, comme R2 : un texte mal encodé ne se relirait pas à l'identique. */
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  const bucket: R2DossierBucket = {
    put: async (key, value, options) => {
      objects.set(key, { bytes: new TextEncoder().encode(value), contentType: options?.httpMetadata?.contentType });
    },
    get: async (key) => {
      const o = objects.get(key);
      return o ? { text: async () => new TextDecoder().decode(o.bytes) } : null;
    },
  };
  return { bucket, objects };
}

async function world(bindings: Partial<Env>) {
  const d1 = fakeD1(openMemoryDatabase());
  const db = fromD1(d1);
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const shop = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'CE-22', kind: 'business', status: 'available', city: 'Dijon', postalCode: '21000', surfaceM2: 90 });
  const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify([{ sha256: await sha256Hex(KEY), networkId: network.id, role: 'agent', userId: alex.id }]), ...bindings };
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await worker.fetch(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; code?: string } };
  };
  return { shop: shop.id, call };
}

describeWithSqlite('CE22 · le dépôt des documents du dossier sur le stockage réel', () => {
  it('[R16] avec le compartiment, un texte déposé par le Worker se relit à l’identique, sous une référence sans donnée', async () => {
    const { bucket, objects } = fakeBucket();
    const t = await world({ COMMERCES: bucket });
    const put = await t.call('POST', `/commerces/${t.shop}/documents/texte`, DOC);
    expect(put).toMatchObject({ status: 200, body: { data: { already: false, repaired: false } } });
    const [key, object] = [...objects.entries()][0]!;
    expect(key).toMatch(new RegExp(`^commerces/[^/]+/${t.shop}/[0-9a-f]{64}$`));
    expect(object.contentType).toBe('text/plain; charset=utf-8');
    expect(await new R2DossierStorage(bucket).read(key)).toBe(TEXT);
    // `available` compare l'empreinte de ce qui est relu à celle du dépôt : le Worker relit donc le même texte.
    expect((await t.call('GET', `/commerces/${t.shop}/documents`)).body.data).toEqual([expect.objectContaining({ title: 'Bail commercial', available: true })]);
  });

  it('un dépôt repris ne fait rien de plus ; un contenu perdu est réécrit', async () => {
    const { bucket, objects } = fakeBucket();
    const t = await world({ COMMERCES: bucket });
    await t.call('POST', `/commerces/${t.shop}/documents/texte`, DOC);
    expect((await t.call('POST', `/commerces/${t.shop}/documents/texte`, DOC)).body.data).toMatchObject({ already: true, repaired: false });
    objects.clear();
    expect((await t.call('GET', `/commerces/${t.shop}/documents`)).body.data).toEqual([expect.objectContaining({ available: false })]);
    expect((await t.call('POST', `/commerces/${t.shop}/documents/texte`, DOC)).body.data).toMatchObject({ already: true, repaired: true });
    expect(objects.size).toBe(1);
  });

  it('une référence inconnue se lit comme absente', async () => {
    expect(await new R2DossierStorage(fakeBucket().bucket).read('commerces/inconnu')).toBeNull();
  });

  it('[R10] sans le compartiment, `stockage_absent` reste dit, même avec le compartiment des pièces', async () => {
    const pieces = fakeBucket();
    for (const bindings of [{}, { PIECES: pieces.bucket as never }]) {
      const t = await world(bindings);
      expect(await t.call('POST', `/commerces/${t.shop}/documents/texte`, DOC)).toMatchObject({ status: 400, body: { code: 'stockage_absent' } });
    }
    expect(pieces.objects.size).toBe(0);
  });
});
