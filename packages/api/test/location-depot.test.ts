import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { R2PieceStore } from '../src/dossiers.ts';
import { sha256Hex } from '../src/index.ts';
import { RENTAL_DEPOSIT_MAX_BYTES } from '../../core/src/location/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, propriétaire, logement, fichiers et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-w14-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', bea: 'test-cle-w14-bea-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb', conformite: 'test-cle-w14-conf-ccccccccccccccccccccccccccc' };
type Who = keyof typeof KEYS;
const PDF = new TextEncoder().encode('%PDF-1.7 diagnostic inventé');
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1]);
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const REF = (id: string, folder: string, ext: string) => new RegExp(`^location/${id}/${folder}[0-9a-f-]{36}\\.${ext}$`);

async function setup(bucketWrites = true) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-01-11T09:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const bea = (await store.createAgent({ networkId: network, firstName: 'Béa', lastName: 'Agent' })).id;
  const owner = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: 'Exemple' })).id;
  const home = (await store.createProperty({ networkId: network, agentId: alex, reference: 'L-1', kind: 'home', postalCode: '21000' })).id;
  const stored = new Map<string, { bytes: Uint8Array; type: string | undefined }>();
  const state = { broken: false };
  const bucket = {
    head: async (k: string) => (stored.has(k) ? {} : null),
    ...(bucketWrites
      ? {
          put: async (k: string, v: Uint8Array, o?: { httpMetadata?: { contentType?: string } }) => {
            if (state.broken) throw new Error('panne');
            stored.set(k, { bytes: v, type: o?.httpMetadata?.contentType });
          },
        }
      : {}),
  };
  const pieces = new R2PieceStore(bucket);
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex }, bea: { role: 'agent', userId: bea }, conformite: { role: 'compliance', userId: 'conf-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, pieces };
  const json = async (who: Who, path: string, body: unknown) => {
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const created = await json('alex', '/location', { propertyId: home, ownerPersonId: owner });
  const id = created.body.data.listingId as string;
  const deposit = async (who: Who, kind: string, bytes: Uint8Array, type: string, hash: string | null = sha(bytes), headers: Record<string, string> = {}) => {
    const r = await handleRequest(
      new Request(`${BASE}/v1/location/${id}/fichiers/${kind}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': type, ...(hash ? { 'x-aimmo-sha256': hash } : {}), ...headers },
        body: bytes,
      }),
      config,
    );
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  return { db, journal, id, stored, state, deposit, json };
}

describeWithSqlite('W14 · dépôt des pièces de la location, par le socle', () => {
  it('[R13] le fichier est rangé tel quel, sous la référence que le geste attend, et le geste l’accepte ; au journal, ni contenu ni nom', async () => {
    const t = await setup();
    const annex = await t.deposit('alex', 'annexe', PDF, 'application/pdf');
    expect(annex).toMatchObject({ status: 200, body: { ok: true, data: { kind: 'annexe', sha256: sha(PDF), size: PDF.length } } });
    const ref = annex.body.data.ref as string;
    expect(ref).toMatch(REF(t.id, '', 'pdf'));
    expect(t.stored.get(ref)).toEqual({ bytes: PDF, type: 'application/pdf' });
    // Déposer ne joint rien : le geste de M15 garde ses contrôles, et accepte cette référence.
    expect(await t.db.first('SELECT 1 FROM rental_annexes')).toBeNull();
    expect(await t.json('alex', `/location/${t.id}/annexes`, { kind: 'dpe', ref, diagnosedOn: '2027-01-02' })).toMatchObject({ status: 200, body: { ok: true } });
    const proof = await t.deposit('alex', 'preuve', JPG, 'image/jpeg');
    expect(proof.body.data.ref).toMatch(REF(t.id, 'choix/', 'jpg'));
    const note = new TextEncoder().encode('Le propriétaire a choisi par téléphone, note de l’agent.');
    expect((await t.deposit('alex', 'preuve', note, 'text/plain; charset=utf-8')).body.data.ref).toMatch(REF(t.id, 'choix/', 'txt'));
    const notice = await t.deposit('alex', 'notice', PDF, 'application/pdf');
    expect(notice.body.data.ref).toMatch(REF(t.id, 'bail/', 'pdf'));
    const events = (await t.journal.all()).filter((e) => e.type === 'location.depot');
    expect(events).toHaveLength(4);
    expect(events[0]!.data).toEqual({ kind: 'annexe', ref, size: PDF.length, sha256: sha(PDF) });
    expect(JSON.stringify(events)).not.toMatch(/diagnostic inventé|Léa|Exemple|note de l/);
  });

  it('[R16] un autre agent et la conformité sont refusés avant toute lecture, au journal, et rien n’est rangé', async () => {
    const t = await setup();
    expect(await t.deposit('bea', 'annexe', PDF, 'application/pdf')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.deposit('conformite', 'annexe', PDF, 'application/pdf')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect(t.stored.size).toBe(0);
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length).toBeGreaterThanOrEqual(2);
  });

  it('une page, un script, un fichier vide, un type mal dit, une mauvaise sorte : rien n’est rangé', async () => {
    const t = await setup();
    const html = new TextEncoder().encode('<script>alert(1)</script> une page piégée');
    expect(await t.deposit('alex', 'annexe', html, 'text/html')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'annexe', html, 'application/pdf')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'annexe', html, 'text/plain')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'notice', JPG, 'image/jpeg')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'preuve', new Uint8Array([0x41, 0, 0x42]), 'text/plain')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'preuve', new Uint8Array([0xc3, 0x28]), 'text/plain')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'annexe', new Uint8Array(0), 'application/pdf')).toMatchObject({ status: 400, body: { code: 'fichier_vide' } });
    expect((await t.deposit('alex', 'autre', PDF, 'application/pdf')).status).toBe(404);
    expect(t.stored.size).toBe(0);
    const refused = (await t.journal.all()).filter((e) => e.type === 'location.depot.refuse');
    expect(refused.length).toBe(7);
    expect(JSON.stringify(refused)).not.toContain('piégée');
  });

  it('une empreinte absente ou différente, un fichier trop lourd annoncé ou réel : rien n’est rangé', async () => {
    const t = await setup();
    expect(await t.deposit('alex', 'annexe', PDF, 'application/pdf', null)).toMatchObject({ status: 400, body: { code: 'empreinte_absente' } });
    expect(await t.deposit('alex', 'annexe', PDF, 'application/pdf', sha('autre chose'))).toMatchObject({ status: 400, body: { code: 'empreinte_differente' } });
    const big = new Uint8Array(RENTAL_DEPOSIT_MAX_BYTES + 1);
    big.set(PDF);
    expect(await t.deposit('alex', 'annexe', big, 'application/pdf')).toMatchObject({ status: 413, body: { code: 'trop_lourd' } });
    expect(t.stored.size).toBe(0);
  });

  it('une panne du stockage ne rend aucune référence ; un stockage sans écriture dit « indisponible » ; la même route reste fermée sans stockage', async () => {
    const t = await setup();
    t.state.broken = true;
    expect(await t.deposit('alex', 'annexe', PDF, 'application/pdf')).toMatchObject({ status: 503, body: { code: 'stockage_indisponible' } });
    expect((await t.journal.all()).some((e) => e.type === 'location.depot')).toBe(false);
    t.state.broken = false;
    expect((await t.deposit('alex', 'annexe', PDF, 'application/pdf')).status).toBe(200);
    const closed = await setup(false);
    expect(await closed.deposit('alex', 'annexe', PDF, 'application/pdf')).toMatchObject({ status: 503, body: { code: 'stockage_indisponible' } });
  });

  it('une référence d’un logement ne sert pas pour un autre : le geste la refuse', async () => {
    const t = await setup();
    const annex = await t.deposit('alex', 'preuve', PDF, 'application/pdf');
    expect(await t.json('alex', `/location/${t.id}/annexes`, { kind: 'dpe', ref: annex.body.data.ref, diagnosedOn: '2027-01-02' })).toMatchObject({ body: { code: 'bad_ref' } });
  });
});
