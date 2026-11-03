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
const DIRECTION = 'test-cle-ce22-direction-bbbbbbbbbbbbbbbbbbbbbbb';
const NDA =
  'Engagement de confidentialité (modèle inventé pour les tests). Le signataire garde secrets les chiffres et documents du commerce qui lui sont communiqués, et ne les utilise que pour étudier sa reprise.';
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
      return o ? { arrayBuffer: async () => o.bytes.slice().buffer as ArrayBuffer } : null;
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
  const env: Env = {
    DB: d1,
    MODE: 'essai',
    DOSSIER_LINK_BASE: 'https://app.example.test/dossier/',
    API_KEYS: JSON.stringify([
      { sha256: await sha256Hex(KEY), networkId: network.id, role: 'agent', userId: alex.id },
      { sha256: await sha256Hex(DIRECTION), networkId: network.id, role: 'direction', userId: 'dir-1' },
    ]),
    ...bindings,
  };
  const send = async (key: string | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await worker.fetch(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; code?: string } };
  };
  const call = (method: string, path: string, body?: unknown) => send(KEY, method, path, body);
  return { db, store, network: network.id, alex: alex.id, shop: shop.id, send, call };
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

  it('[R114] le lecteur du dossier, servi par le Worker, reçoit le texte déposé dans le compartiment', async () => {
    const { bucket } = fakeBucket();
    const t = await world({ COMMERCES: bucket });
    const reader = 'dominique.exemple@example.test';
    const who = (await t.store.createPerson({ networkId: t.network, agentId: t.alex, firstName: 'Dominique', lastName: 'Exemple' })).id;
    await t.store.addIdentifier({ networkId: t.network, personId: who, kind: 'email', value: reader });
    await t.db.run(
      `INSERT INTO compliance_vault_pieces (id, network_id, person_id, kind, storage_ref, sha256, content_type, size_bytes, verified_on, deposited_by, deposited_at) VALUES ('piece-1', ?, ?, 'carte_identite', 'coffre/piece-1', ?, 'application/pdf', 10, ?, 'compliance:conf-1', ?)`,
      [t.network, who, 'a'.repeat(64), new Date().toISOString().slice(0, 10), new Date().toISOString()],
    );
    const ok = async (r: Promise<{ status: number; body: { data?: any } }>) => {
      const done = await r;
      expect(done.status).toBe(200);
      return done.body.data;
    };
    /** Le dernier code envoyé à la personne : l'envoi reste dans la boîte d'essai. */
    const code = async (like: string): Promise<string> => /(\d{6})/.exec((await t.db.first<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? AND m.body LIKE ? ORDER BY m.rowid DESC LIMIT 1', [who, like]))!.body)![1]!;
    await ok(t.send(DIRECTION, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5000, high: 8000, source: 'Barème inventé', sourceDate: new Date().toISOString().slice(0, 10) }));
    await ok(t.send(DIRECTION, 'POST', '/commerces/engagements/modeles', { body: NDA }));
    await ok(t.call('POST', `/commerces/${t.shop}/fiche`, { activity: 'restaurant', signName: 'Le Comptoir Inventé', fiscalYears: [{ year: 2025, revenueCents: 50_000_000, resultCents: 2_000_000 }] }));
    const estimate = await ok(t.call('POST', `/commerces/${t.shop}/estimations`, { method: 'revenue_pct' }));
    await ok(t.call('POST', `/commerces/estimations/${estimate.id}/validation`));
    const presentation = await ok(t.call('POST', `/commerces/${t.shop}/presentations`));
    await ok(t.call('POST', `/commerces/presentations/${presentation.id}/validation`));
    await ok(t.call('POST', `/commerces/${t.shop}/documents/texte`, DOC));
    const { ndaId } = await ok(t.call('POST', `/commerces/${t.shop}/demandes`, { personId: who }));
    const { sessionId } = await ok(t.call('POST', `/commerces/engagements/${ndaId}/signature`, { consentProof: 'accord donné au rendez-vous' }));
    await ok(t.call('POST', `/commerces/signatures/${sessionId}`, { code: await code('%engagement de confidentialité%') }));
    await ok(t.call('POST', `/commerces/${t.shop}/dossiers`, { personId: who, consentProof: 'accord donné au rendez-vous' }));
    const sent = await t.db.first<{ body: string }>('SELECT body FROM messages WHERE person_id = ? AND body LIKE ?', [who, '%dossier confidentiel du commerce%']);
    const token = /dossier\/([a-z]{40})/.exec(sent!.body)![1]!;
    await t.send(null, 'POST', `/dossier/${token}/code`, { email: reader });
    const opened = await ok(t.send(null, 'POST', `/dossier/${token}`, { email: reader, code: await code('%code pour ouvrir%') }));
    const page = opened.pages.find((p: { title: string }) => p.title === DOC.title);
    // Le texte porte le filigrane du lecteur en caractères invisibles [R114] : retirés, il reste celui déposé.
    expect(page.text.replace(/\p{Cf}/gu, '')).toContain(TEXT.trim());
  });

  it('un texte qui commence par une marque d’ordre se relit à l’identique : le redéposer n’ajoute rien', async () => {
    const { bucket } = fakeBucket();
    const t = await world({ COMMERCES: bucket });
    const doc = { ...DOC, content: `﻿${TEXT}` };
    await t.call('POST', `/commerces/${t.shop}/documents/texte`, doc);
    expect((await t.call('POST', `/commerces/${t.shop}/documents/texte`, doc)).body.data).toMatchObject({ already: true, repaired: false });
    expect((await t.call('GET', `/commerces/${t.shop}/documents`)).body.data).toEqual([expect.objectContaining({ available: true })]);
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
