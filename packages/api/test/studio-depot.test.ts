import { expect, it } from 'vitest';
import { FicheClient, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { MEDIA_PATH } from '../src/vitrine.ts';
import { mediaUploads } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, biens, fichiers et clés inventés : les octets ne sont que des en-têtes de type suivis de remplissage.
const BASE = 'https://aimmo-api.example.test';
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 3, 1, 4, 1, 5, 9]);
const CORRECTED = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 16, 2, 7, 1, 8, 2, 8, 1, 8, 2, 8]);
const MP4 = Uint8Array.from([...'\0\0\0\x18ftypisom\0\0\x02\0'].map((c) => c.charCodeAt(0)));
const KEYS = { alex: 'test-cle-x12-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', partenaire: 'test-cle-x12-part-cccccccccccccccccccccccccccc' };
type Who = keyof typeof KEYS;

async function bytesSha(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function setup(opts: { uploads?: boolean } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-10-14T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alexandrine', lastName: 'Fictive' })).id;
  const p = (await store.createProperty({ networkId: network, agentId: alex, reference: 'DEP-1', kind: 'home', city: 'Villebrune', priceEur: 150_000, surfaceM2: 45, rooms: 2, status: 'available' })).id;
  const sheet = { characteristics: { bedrooms: 1, floor: null, floorsTotal: null, buildYear: null, heating: null, outdoor: [], landM2: null, parkingSpaces: 0, elevator: null }, energy: { energyClass: 'C', climateClass: 'C', annualCostMinEur: 800, annualCostMaxEur: 1100, costReferenceYear: 2025, diagnosedOn: '2027-09-01' }, coownership: { isCoownership: false }, risks: { inRiskZone: false }, media: [] };
  await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-1', ?, ?, 1, ?, 'agent:a', '2027-10-01')", [p, network, JSON.stringify(sheet)]);
  // Le même stockage pour le dépôt et pour la lecture de l'existence, comme `MEDIA` dans le Worker.
  const kept = new Map<string, { bytes: Uint8Array; type: string }>();
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex }, partenaire: { role: 'partner', userId: 'p-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const config: ApiConfig = {
    db,
    apiKeys,
    mode: 'essai',
    now,
    studio: {
      files: { has: async (r: string) => kept.has(r) },
      ...(opts.uploads === false ? {} : { uploads: { put: async (k: string, b: Uint8Array, t: string) => void kept.set(k, { bytes: b, type: t }) } }),
    },
  };
  const upload = async (who: Who, kind: string, bytes: Uint8Array, headers: Record<string, string> = {}, query = '') => {
    const r = await handleRequest(
      new Request(`${BASE}/v1/studio/biens/${p}/fichiers/${kind}${query}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': kind === 'video' ? 'video/mp4' : 'image/jpeg', 'x-aimmo-sha256': await bytesSha(bytes), ...headers },
        body: bytes,
      }),
      config,
    );
    return { status: r.status, body: (await r.json()) as any };
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS.alex}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as any };
  };
  const latest = async () => JSON.parse((await db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [p]))!.data);
  return { p, kept, upload, call, latest };
}

describeWithSqlite('X12 · dépôt par /v1/studio, branché dans le socle', () => {
  it('[R130] photo corrigée et original déposés tels quels, puis le certificat rangé avec leurs références', async () => {
    const t = await setup();
    const original = await t.upload('alex', 'original', JPEG);
    expect(original).toMatchObject({ status: 200, body: { ok: true, mode: 'essai', data: { kind: 'original', sheetVersion: null } } });
    const photo = await t.upload('alex', 'photo', CORRECTED, {}, '?retouche=lumiere_cadrage');
    expect(photo).toMatchObject({ status: 200, body: { ok: true, data: { kind: 'photo', sheetVersion: 2 } } });
    // À l'octet près, avec leur type.
    expect([...t.kept.get(original.body.data.ref)!.bytes]).toEqual([...JPEG]);
    expect([...t.kept.get(photo.body.data.ref)!.bytes]).toEqual([...CORRECTED]);
    expect(t.kept.get(photo.body.data.ref)!.type).toBe('image/jpeg');
    expect((await t.latest()).media).toEqual([{ ref: photo.body.data.ref, kind: 'photo', edit: 'lumiere_cadrage' }]);
    // Le certificat, rangé ensuite par l'écran avec les références et les empreintes du dépôt.
    const cert = await t.call('POST', `/studio/biens/${t.p}/photos`, {
      resultRef: photo.body.data.ref,
      resultSha256: photo.body.data.sha256,
      originalRef: original.body.data.ref,
      originalSha256: original.body.data.sha256,
      operations: [{ op: 'contraste', amount: 12 }],
      processedOn: 'appareil',
    });
    expect(cert).toMatchObject({ status: 200, body: { ok: true } });
    // Un original n'est jamais servi par la vitrine : son adresse n'en est pas une ; la photo, si.
    expect(MEDIA_PATH.test(`/medias/${original.body.data.ref}`)).toBe(false);
    expect(MEDIA_PATH.test(`/medias/${photo.body.data.ref}`)).toBe(true);
  });

  it('[R130] une empreinte qui ne correspond pas : 409, rien n’est rangé', async () => {
    const t = await setup();
    const r = await t.upload('alex', 'photo', CORRECTED, { 'x-aimmo-sha256': await bytesSha(JPEG) }, '?retouche=lumiere_cadrage');
    expect(r).toEqual({ status: 409, body: { ok: false, rule: 'R130', code: 'empreinte_differente' } });
    expect(t.kept.size).toBe(0);
  });

  it('[R16] taille et type bornés, rôle vérifié, dépôt fermé sans stockage', async () => {
    const t = await setup();
    expect(await t.upload('partenaire', 'photo', JPEG, {}, '?retouche=aucune')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    const page = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    expect(await t.upload('alex', 'photo', page, {}, '?retouche=aucune')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.upload('alex', 'photo', JPEG, { 'content-type': 'application/json' }, '?retouche=aucune')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    // Plus lourd que la borne d'une photo : refusé à la lecture, au-delà de la borne.
    const heavy = new Uint8Array(20 * 1024 * 1024 + 1);
    heavy.set(JPEG);
    expect(await t.upload('alex', 'photo', heavy, {}, '?retouche=aucune')).toMatchObject({ status: 413, body: { code: 'trop_lourd' } });
    expect(await t.upload('alex', 'photo', JPEG)).toMatchObject({ status: 409, body: { code: 'retouche_inconnue' } });
    expect(t.kept.size).toBe(0);
    // La vidéo montée entre dans la fiche.
    expect(await t.upload('alex', 'video', MP4)).toMatchObject({ status: 200, body: { data: { kind: 'video', sheetVersion: 2 } } });
    const closed = await setup({ uploads: false });
    expect(await closed.upload('alex', 'photo', JPEG, {}, '?retouche=aucune')).toMatchObject({ status: 503, body: { code: 'depot_ferme' } });
  });
});

it('X12 · `MEDIA` reçoit les octets tels quels avec leur type ; sans `put`, le dépôt reste fermé', async () => {
  const calls: unknown[] = [];
  const uploads = mediaUploads({ put: async (k: string, v: Uint8Array, o?: unknown) => void calls.push([k, [...v], o]) });
  await uploads!.put('biens/b1/originaux/x.jpg', Uint8Array.from([1, 2, 3]), 'image/jpeg');
  expect(calls).toEqual([['biens/b1/originaux/x.jpg', [1, 2, 3], { httpMetadata: { contentType: 'image/jpeg' } }]]);
  expect(mediaUploads({})).toBeNull();
  await expect(mediaUploads({ put: async () => { throw new Error('panne'); } })!.put('k', new Uint8Array(1), 'image/jpeg')).rejects.toThrow('panne');
});
