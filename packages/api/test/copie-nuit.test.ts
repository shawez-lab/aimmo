import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, describe } from 'vitest';
import { applyMigrations, OBJECT_STORAGES, restoreObjects, type ObjectSource, type ObjectStorage, type ObjectTarget, type StoredObject, CopieBase, copyKeyFromSecret, FicheClient, fromSyncSqlite, MemoryJournalStore, restoreCopy, SqlJournalStore, type CopyRun, type CopyStore, type SqlDatabase } from '@aimmo/core';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { isoInstant, loadSnapshot, nightlyCopy, objectSourcesFromEnv, OBJECT_BUCKETS, storeFromEnv, type NightlyInput } from '../outils/copie-nuit.ts';
import { CopyStoreError, parseListPage, r2CopyStore, r2ObjectSource, signV4 } from '../outils/r2-copies.ts';
// @ts-expect-error script du dépôt, sans déclaration de types
import { R2_BINDINGS } from '../../../scripts/liaisons-r2.mjs';

// Tout est inventé : la base, les personnes, le stockage, les clés.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const STARTED = '2027-03-10T01:23:00.000Z';
const MARK = 'Inventee-Lisible';

const memory = () => {
  const parts = new Map<string, Uint8Array>();
  const store: CopyStore = { put: async (k, b) => { parts.set(k, b); }, get: async (k) => parts.get(k) ?? null };
  return { parts, store };
};

async function source(): Promise<SqlDatabase> {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const fiche = new FicheClient(db, { now: () => new Date(STARTED) });
  const network = await fiche.createNetwork('Réseau test');
  const agent = await fiche.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  await fiche.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: MARK });
  return db;
}

const fichiers = (): Record<ObjectStorage, ObjectSource> => {
  const seed: Record<ObjectStorage, Record<string, StoredObject>> = {
    MEDIA: { 'biens/b1/salon.jpg': { bytes: Uint8Array.from({ length: 900 }, (_, i) => i % 251), contentType: 'image/jpeg' } },
    PIECES: { 'dossiers/d1/compromis.pdf': { bytes: new TextEncoder().encode(`%PDF ${MARK}`) } },
    COMMERCES: {},
    COFFRE: { 'coffre/n1/piece.pdf': { bytes: new TextEncoder().encode('%PDF coffre') } },
  };
  return Object.fromEntries(OBJECT_STORAGES.map((n) => [n, { list: async () => Object.keys(seed[n]), get: async (k: string) => seed[n][k] ?? null }])) as Record<ObjectStorage, ObjectSource>;
};

async function night(over: Partial<NightlyInput> = {}) {
  const runs: CopyRun[] = [];
  const said: string[] = [];
  const { parts, store } = memory();
  const db = await source();
  const code = await nightlyCopy({ secret: SECRET, store, snapshot: async () => db, startedAt: STARTED, fresh: () => fromSyncSqlite(openMemoryDatabase()), record: async (r) => { runs.push(r); }, objects: fichiers(), ...over }, (t) => said.push(t));
  return { code, runs, said, parts, store, db };
}

describeWithSqlite('SV02 · la copie de nuit', () => {
  it('[R230] tout est là : la copie est rangée, se restaure, et l’instant dit est celui d’avant la photo', async () => {
    const t = await night();
    expect(t.code).toBe(0);
    expect(t.runs).toHaveLength(1);
    const run = t.runs[0]!;
    expect(run).toMatchObject({ outcome: 'copiee', startedAt: STARTED });
    if (run.outcome !== 'copiee') throw new Error('refus');
    expect(run.rows).toBeGreaterThan(0);
    const restored = await restoreCopy(fromSyncSqlite(openMemoryDatabase()), t.store, await copyKeyFromSecret(SECRET), run.copyId);
    expect(restored).toMatchObject({ ok: true, takenAt: STARTED });
    expect(t.said.join(' ')).toContain('Copie rangée');
    expect(t.said.join(' ')).not.toContain(MARK);
  });

  it('[R224] AU019b : la nuit copie aussi les fichiers des quatre stockages, relus depuis le compartiment', async () => {
    const t = await night();
    const run = t.runs[0]!;
    if (run.outcome !== 'copiee') throw new Error('refus');
    expect(t.said.join(' ')).toContain('3 fichiers');
    const targets = Object.fromEntries(OBJECT_STORAGES.map((n) => {
      const held = new Map<string, StoredObject>();
      return [n, { list: async () => [...held.keys()], get: async (k: string) => held.get(k) ?? null, put: async (k: string, o: StoredObject) => { held.set(k, o); } }];
    })) as Record<ObjectStorage, ObjectTarget>;
    expect(await restoreObjects(targets, t.store, await copyKeyFromSecret(SECRET), run.copyId)).toMatchObject({ ok: true, storages: 4, objects: 3 });
    expect(await targets.PIECES.get('dossiers/d1/compromis.pdf')).toEqual({ bytes: new TextEncoder().encode(`%PDF ${MARK}`) });
  });

  it('[R224] AU019b : sans clé de lecture des stockages, ou s’il en manque un, la nuit n’est pas sauvegardée', async () => {
    const sans = await night({ objects: null });
    expect(sans.runs).toEqual([expect.objectContaining({ outcome: 'non_sauvegardee', reason: 'stockage_absent' })]);
    expect(sans.parts.size).toBe(0);
    const { COFFRE: _c, ...trois } = fichiers();
    const t = await night({ objects: trois });
    expect(t.runs).toEqual([expect.objectContaining({ outcome: 'non_sauvegardee', reason: 'stockage_absent' })]);
    expect(t.code).toBe(1);
  });

  it('[R224] AU019b : un fichier cité par la base mais absent de son stockage, ou disparu pendant la copie : « non sauvegardé »', async () => {
    const db = await source();
    await db.exec('CREATE TABLE essai_fichiers (ref TEXT)');
    await db.run("INSERT INTO essai_fichiers (ref) VALUES ('offres/4c1b0d8e-0000-4000-8000-000000000001.pdf')");
    const t = await night({ snapshot: async () => db });
    expect(t.runs).toEqual([expect.objectContaining({ outcome: 'non_sauvegardee', reason: 'stockage_en_panne' })]);
    const objects = fichiers();
    const media = objects.MEDIA;
    objects.MEDIA = { list: media.list, get: async () => null };
    const db2 = await source();
    await db2.exec('CREATE TABLE essai_fichiers (ref TEXT)');
    await db2.run("INSERT INTO essai_fichiers (ref) VALUES ('biens/b1/salon.jpg')");
    const t2 = await night({ snapshot: async () => db2, objects });
    expect(t2.runs).toEqual([expect.objectContaining({ outcome: 'non_sauvegardee', reason: 'stockage_en_panne' })]);
    expect(t2.code).toBe(1);
  });

  it('[R224] AU019b : un stockage qui ne se lit pas : « stockage en panne », jamais une copie sans ses fichiers', async () => {
    const objects = fichiers();
    objects.MEDIA = { list: async () => { throw new CopyStoreError('Stockage des objets injoignable.'); }, get: async () => null };
    const t = await night({ objects });
    expect(t.runs).toEqual([expect.objectContaining({ outcome: 'non_sauvegardee', reason: 'stockage_en_panne' })]);
    expect(t.code).toBe(1);
  });

  it('[R224] AU019b : les compartiments lus sont ceux du déploiement, avec une clé à part, en Europe', async () => {
    expect(OBJECT_BUCKETS).toEqual(R2_BINDINGS);
    expect(objectSourcesFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'compte' })).toBeNull();
    expect(objectSourcesFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'compte', COPIES_R2_ACCESS_KEY_ID: 'a', COPIES_R2_SECRET_ACCESS_KEY: 'b' })).toBeNull();
    const seen: string[] = [];
    const src = r2ObjectSource({ accountId: 'compte', bucket: 'aimmo-coffre', accessKeyId: 'id', secretAccessKey: 'secret', jurisdiction: 'eu', now: () => new Date(STARTED), fetch: (async (url: string) => { seen.push(url); return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'); }) as typeof fetch });
    expect(await src.list()).toEqual([]);
    expect(seen[0]).toBe('https://compte.eu.r2.cloudflarestorage.com/aimmo-coffre?list-type=2&max-keys=1000');
  });

  it('[R224] AU019b : la liste suit chaque page jusqu’à la dernière, et lit les clés échappées', async () => {
    const pages = [
      '<ListBucketResult><Contents><Key>biens/a&amp;b.jpg</Key><Size>1</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>jeton+/=1</NextContinuationToken></ListBucketResult>',
      '<ListBucketResult><Contents><Key>biens/c.jpg</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
    ];
    const urls: string[] = [];
    const src = r2ObjectSource({ accountId: 'compte', bucket: 'aimmo-medias', accessKeyId: 'id', secretAccessKey: 'secret', now: () => new Date(STARTED), fetch: (async (url: string) => { urls.push(url); return new Response(pages[urls.length - 1]); }) as typeof fetch });
    expect(await src.list()).toEqual(['biens/a&b.jpg', 'biens/c.jpg']);
    expect(urls[1]).toContain('continuation-token=jeton%2B%2F%3D1');
    expect(() => parseListPage('<IsTruncated>true</IsTruncated>')).toThrow(CopyStoreError);
  });

  it('[R224] AU019b : la lecture d’un objet garde son type ; absent, il est dit disparu ; refusée, l’erreur ne cite pas la clé', async () => {
    const answers = [new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/pdf' } }), new Response('', { status: 404 }), new Response('', { status: 403 })];
    const urls: string[] = [];
    const src = r2ObjectSource({ accountId: 'compte', bucket: 'aimmo-pieces', accessKeyId: 'id', secretAccessKey: 'secret', now: () => new Date(STARTED), fetch: (async (url: string) => { urls.push(url); return answers.shift()!; }) as typeof fetch });
    expect(await src.get("dossiers/d1/l'acte (1).pdf")).toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' });
    expect(urls[0]).toBe('https://compte.r2.cloudflarestorage.com/aimmo-pieces/dossiers/d1/l%27acte%20%281%29.pdf');
    expect(await src.get('dossiers/d1/parti.pdf')).toBeNull();
    const error = await src.get('dossiers/d1/secret.pdf').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CopyStoreError);
    expect(String(error)).not.toContain('secret.pdf');
  });

  it('[R230] la copie ne change pas la photo', async () => {
    const t = await night();
    expect(await new SqlJournalStore(t.db).all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'base.copie' })]));
  });

  const refused: [string, Partial<NightlyInput>, string][] = [
    ['sans clé', { secret: '' }, 'cle_absente'],
    ['une clé mauvaise', { secret: 'pas-une-cle' }, 'cle_invalide'],
    ['sans stockage', { store: null }, 'stockage_absent'],
    ['sans photo', { snapshot: async () => null }, 'photo_absente'],
    ['une photo qui ne se charge pas', { snapshot: async () => { throw new Error(MARK); } }, 'photo_absente'],
  ];
  it.each(refused)('[R230] %s : « non sauvegardé », jamais un faux succès, et rien de rangé', async (_name, over, reason) => {
    const t = await night(over);
    expect(t.code).toBe(1);
    expect(t.runs).toEqual([expect.objectContaining({ outcome: 'non_sauvegardee', reason })]);
    expect(t.parts.size).toBe(0);
    expect(t.said.join(' ')).toContain(`Non sauvegardé : ${reason}`);
    expect(t.said.join(' ')).not.toContain(MARK);
  });

  it('[R230] une photo vide n’est pas une copie', async () => {
    const empty = fromSyncSqlite(openMemoryDatabase());
    const t = await night({ snapshot: async () => empty });
    expect(t.code).toBe(1);
    expect(t.runs[0]).toMatchObject({ outcome: 'non_sauvegardee', reason: 'photo_vide' });
  });

  it('[R230] un stockage en panne, ou qui répond oui sans ranger : « non sauvegardé »', async () => {
    const down = await night({ store: { put: async () => { throw new CopyStoreError('panne inventée'); }, get: async () => null } });
    expect(down.code).toBe(1);
    expect(down.runs[0]).toMatchObject({ outcome: 'non_sauvegardee', reason: 'stockage_en_panne' });
    const liar = await night({ store: { put: async () => {}, get: async () => null } });
    expect(liar.code).toBe(1);
    expect(liar.runs[0]).toMatchObject({ outcome: 'non_sauvegardee', reason: 'stockage_en_panne' });
    // Le sommaire est là, mais un morceau s'est perdu : une présence ne prouve rien.
    const { parts: kept, store: real } = memory();
    const losing = await night({ store: { put: async (k, b) => { if (!/\/000000$/.test(k)) await real.put(k, b); }, get: real.get } });
    expect(kept.size).toBeGreaterThan(0);
    expect(losing.code).toBe(1);
    expect(losing.runs[0]).toMatchObject({ outcome: 'non_sauvegardee', reason: 'stockage_en_panne' });
    const bug = await night({ store: { put: async () => { throw new Error(MARK); }, get: async () => null } });
    expect(bug.runs[0]).toMatchObject({ outcome: 'non_sauvegardee', reason: 'copie_echouee' });
    expect(bug.said.join(' ')).not.toContain(MARK);
  });

  it('[R230] une photo incohérente, qui ne se restaurerait pas à l’identique, n’est pas une copie', async () => {
    const db = fromSyncSqlite(openMemoryDatabase());
    await db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent (id));');
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO child VALUES ('c1', 'orphelin')");
    await db.exec('PRAGMA foreign_keys = ON');
    const t = await night({ snapshot: async () => db });
    expect(t.code).toBe(1);
    expect(t.runs[0]).toMatchObject({ outcome: 'non_sauvegardee', reason: 'copie_non_restaurable' });
  });

  it('[R230] un compte rendu non écrit : le travail échoue, même si la copie est rangée', async () => {
    const t = await night({ record: async () => { throw new Error(MARK); } });
    expect(t.code).toBe(1);
    expect(t.said.join(' ')).toContain('Compte rendu non écrit');
    expect(t.said.join(' ')).not.toContain(MARK);
  });

  it('[R224] une photo faite comme celle de wrangler se charge, garde-fous compris, et se copie', async () => {
    const db = openMemoryDatabase();
    const dir = mkdtempSync(join(tmpdir(), 'photo-'));
    const path = join(dir, 'photo.sql');
    writeFileSync(path, [
      'PRAGMA defer_foreign_keys=TRUE;',
      'CREATE TABLE parent (id TEXT PRIMARY KEY);',
      'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent (id));',
      `INSERT INTO "child" VALUES('c1','p1');`,
      `INSERT INTO "parent" VALUES('p1');`,
      "CREATE TRIGGER child_garde BEFORE DELETE ON child BEGIN SELECT RAISE(ABORT, 'non'); END;",
    ].join('\n'));
    const loaded = loadSnapshot(path, () => db)!;
    const { store } = memory();
    const key = await copyKeyFromSecret(SECRET);
    const r = await new CopieBase(loaded, new MemoryJournalStore(), store, key).take();
    expect(r).toMatchObject({ tables: 2, rows: 2 });
    expect(loadSnapshot(join(dir, 'absente.sql'), () => db)).toBeNull();
    writeFileSync(path, '  \n');
    expect(loadSnapshot(path, () => db)).toBeNull();
  });
});

describe('SV02 · le compartiment des copies', () => {
  it('[R230] la signature suit l’exemple publié par AWS', async () => {
    // L'exemple « GET Object » de la documentation d'AWS pour la signature v4.
    const auth = await signV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      bodySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      amzDate: '20130524T000000Z',
      region: 'us-east-1',
      accessKeyId: 'AKIA' + 'IOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(auth).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
    expect(auth.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')).toBe(true);
  });

  const setup = (answers: (number | Error)[], stored: Uint8Array | null = null) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const waits: number[] = [];
    const store = r2CopyStore({
      accountId: 'compte', bucket: 'aimmo-copies', accessKeyId: 'id-invente', secretAccessKey: 'secret-invente',
      now: () => new Date(STARTED),
      wait: async (ms) => { waits.push(ms); },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (init.method === 'GET' && stored) return new Response(Uint8Array.from(stored));
        const a = answers.shift() ?? 500;
        if (a instanceof Error) throw a;
        return new Response(a === 200 && init.method === 'GET' ? new Uint8Array([7]) : null, { status: a });
      }) as typeof fetch,
    });
    return { store, calls, waits };
  };

  it('[R224] un morceau part signé, dans le bon compartiment, et ne peut pas en écraser un autre', async () => {
    const t = setup([200]);
    await t.store.put('copies/x/000001', new Uint8Array([1, 2]));
    expect(t.calls[0]!.url).toBe('https://compte.r2.cloudflarestorage.com/aimmo-copies/copies/x/000001');
    const h = t.calls[0]!.init.headers as Record<string, string>;
    expect(h['if-none-match']).toBe('*');
    expect(h['authorization']).toContain('Credential=id-invente/20270310/auto/s3/aws4_request');
    expect(h['authorization']).toContain('if-none-match');
    expect(JSON.stringify(h)).not.toContain('secret-invente');
  });

  it('[R224] une place déjà prise est refusée ; après une réponse perdue, seul le même contenu passe', async () => {
    await expect(setup([412]).store.put('k', new Uint8Array([1]))).rejects.toBeInstanceOf(CopyStoreError);
    const same = setup([503, 412], new Uint8Array([1]));
    await expect(same.store.put('k', new Uint8Array([1]))).resolves.toBeUndefined();
    expect(same.waits).toEqual([500]);
    const other = setup([new TypeError('coupure'), 412], new Uint8Array([9]));
    await expect(other.store.put('k', new Uint8Array([1]))).rejects.toBeInstanceOf(CopyStoreError);
  });

  it('[R230] la panne s’arrête après trois essais ; un refus franc, dès le premier', async () => {
    const down = setup([500, 500, 500, 200]);
    await expect(down.store.put('k', new Uint8Array([1]))).rejects.toBeInstanceOf(CopyStoreError);
    expect(down.calls).toHaveLength(3);
    const denied = setup([403, 200]);
    await expect(denied.store.put('k', new Uint8Array([1]))).rejects.toBeInstanceOf(CopyStoreError);
    expect(denied.calls).toHaveLength(1);
  });

  it('[R224] à la lecture : absent, `null` ; panne, une erreur sans le nom de la clé', async () => {
    expect(await setup([404]).store.get('k')).toBeNull();
    expect(await setup([200]).store.get('k')).toEqual(new Uint8Array([7]));
    const e = await setup([500]).store.get('copies/secret-de-place').catch((x: Error) => x);
    expect(e).toBeInstanceOf(CopyStoreError);
    expect((e as Error).message).not.toContain('secret-de-place');
    await expect(setup([new TypeError('coupure')]).store.get('k')).rejects.toBeInstanceOf(CopyStoreError);
  });

  it('[R230] sans ses trois réglages, pas de stockage ; l’instant du travail est contrôlé', () => {
    expect(storeFromEnv({})).toBeNull();
    expect(storeFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a', COPIES_R2_ACCESS_KEY_ID: 'b' })).toBeNull();
    expect(storeFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a', COPIES_R2_ACCESS_KEY_ID: 'b', COPIES_R2_SECRET_ACCESS_KEY: 'c' })).not.toBeNull();
    expect(isoInstant('2027-03-10T01:23:00Z')).toBe('2027-03-10T01:23:00.000Z');
    expect(isoInstant('hier')).toBeNull();
    expect(isoInstant(undefined)).toBeNull();
  });
});

describe('SV02 · le travail de nuit', () => {
  const yml = readFileSync(join(import.meta.dirname, '../../../.github/workflows/copie-nuit.yml'), 'utf8');

  it('[R230] la photo n’en sort jamais et est détruite, même après un échec', () => {
    expect(yml).not.toMatch(/upload-artifact|actions\/cache@|cat .*photo/);
    expect(yml).toMatch(/if: always\(\)\s+run: rm -f "\$RUNNER_TEMP\/photo\.sql"/);
  });

  it('[R230] le lien de téléchargement que donne wrangler ne va jamais au journal du travail', () => {
    expect(yml).toMatch(/d1 export aimmo --remote --output "\$RUNNER_TEMP\/photo\.sql\.part" >\/dev\/null 2>&1/);
    expect(yml.match(/d1 export/g)).toHaveLength(1);
  });

  it('[R230] une photo coupée par une panne n’a jamais le nom de la photo ; les deux fichiers sont détruits', () => {
    expect(yml).toMatch(/>\/dev\/null 2>&1; then\s+mv "\$RUNNER_TEMP\/photo\.sql\.part" "\$RUNNER_TEMP\/photo\.sql"/);
    expect(yml).toContain('rm -f "$RUNNER_TEMP/photo.sql" "$RUNNER_TEMP/photo.sql.part"');
  });

  it('[R230] une photo ratée laisse dire « non sauvegardé » ; la copie, elle, ne cache pas son échec', () => {
    const steps = yml.split('- name: ');
    expect(steps.find((s) => s.startsWith('Photo de la base'))).toContain('continue-on-error: true');
    expect(steps.find((s) => s.startsWith('Copie chiffrée'))).not.toContain('continue-on-error');
  });

  it('[R230] depuis main seulement, avec l’instant pris avant la photo', () => {
    expect(yml).toContain("github.ref == 'refs/heads/main'");
    expect(yml.indexOf("Instant d'avant la photo")).toBeLessThan(yml.indexOf('Photo de la base'));
  });
});
