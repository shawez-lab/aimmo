import { describe, expect, it, vi } from 'vitest';
import { CopieBase, DecisionEnvoi, FicheClient, FicheUnique, OBJECT_STORAGES, applyMigrations, copyKeyFromSecret, copyObjects, fileReferences, fromSyncSqlite, type ObjectStorage, type StoredObject, type Viewer } from '@aimmo/core';
import { conformiteRoutes, type ConformiteServices } from '../src/conformite.ts';
import { ERASURE_LEDGER_PREFIX, erasureOf, ledgerOnly, r2ObjectEraser } from '../src/effacement-worker.ts';
import { r2CopyStore } from '../outils/r2-copies.ts';
import { fromD1 } from '../src/d1.ts';
import { sha256Hex } from '../src/index.ts';
import worker, { type Env } from '../src/worker.ts';
import { fakeD1 } from './fake-d1.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { restoreEverything, type ErasableTarget } from '../../core/src/sauvegarde/restauration-complete.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé : le compte, les clés, les réponses du compartiment, les personnes et les fichiers.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 5)));
const RECORDING = 'boite/appels/noemie-inventee.ogg';
const SETTINGS = { CLOUDFLARE_ACCOUNT_ID: 'compte-invente', COPIES_R2_ACCESS_KEY_ID: 'id-invente', COPIES_R2_SECRET_ACCESS_KEY: 'secret-invente', COPY_KEY: SECRET };

/** Un faux compartiment `aimmo-copies` par l'API S3 : il garde les objets et compte les appels. */
function copiesBucket(options: { refusePut?: number } = {}) {
  const held = new Map<string, Uint8Array>();
  const calls: { method: string; key: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.replace(/^\/aimmo-copies\/?/, ''));
    calls.push({ method: init.method ?? 'GET', key });
    if (init.method === 'PUT') {
      if (options.refusePut) return new Response(null, { status: options.refusePut });
      if (held.has(key)) return new Response(null, { status: 412 });
      held.set(key, new Uint8Array(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const all = [...held.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Response(`<ListBucketResult>${all.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    const found = held.get(key);
    return found ? new Response(Uint8Array.from(found)) : new Response('', { status: 404 });
  }) as typeof fetch;
  // Le compartiment entier, comme le voit la copie de chaque nuit (jamais le Worker).
  const whole = r2CopyStore({ accountId: 'compte-invente', bucket: 'aimmo-copies', accessKeyId: 'id-invente', secretAccessKey: 'secret-invente', wait: async () => {}, fetch: fetchFn });
  return { held, calls, fetchFn, whole };
}

/** Un faux compartiment R2 lié au Worker : lister, lire, retirer. */
function liveBucket(seed: Record<string, string> = {}) {
  const objects = new Map<string, StoredObject>(Object.entries(seed).map(([k, v]) => [k, { bytes: new TextEncoder().encode(v) }]));
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    list: async () => [...objects.keys()],
    get: async (k: string) => objects.get(k) ?? null,
    delete: async (k: string) => {
      deleted.push(k);
      objects.delete(k);
    },
  };
}

const freshTarget = () => {
  const objects = new Map<string, StoredObject>();
  const target: ErasableTarget = {
    list: async () => [...objects.keys()],
    get: async (k) => objects.get(k) ?? null,
    put: async (k, o) => void objects.set(k, { bytes: Uint8Array.from(o.bytes), ...(o.contentType ? { contentType: o.contentType } : {}) }),
    remove: async (k) => void objects.delete(k),
  };
  return target;
};

async function setup() {
  const t = await setupDossier('appartement');
  const fiches = new FicheClient(t.db, { now: t.now });
  const stop = new DecisionEnvoi(t.db, fiches, new FicheUnique(t.db, fiches, { now: t.now }), { now: t.now });
  const routes = conformiteRoutes();
  const compliance: Viewer = { ...t.direction, role: 'compliance', userId: 'conformite-1' };
  const call = async (path: string, method: 'GET' | 'POST', body: unknown, erasure: ConformiteServices['erasure']) => {
    const bare = `/conformite${path}`;
    const route = routes.find((r) => r.method === method && r.pattern.test(bare))!;
    const params = (route.pattern.exec(bare) ?? []).slice(1);
    const init: RequestInit = body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const s: ConformiteServices = { db: t.db, journal: t.journal, acces: t.acces, stop, vault: null, now: t.now, erasure: erasure ?? null };
    const response = await route.handle(s, compliance, params, new Request(`https://api.exemple.test/v1${bare}`, init));
    return { status: response.status, body: (await response.json()) as { ok: boolean; rule?: string; code?: string; data?: any } };
  };
  // Une personne qui n'a qu'une fiche et une adresse : tout ce qui est à elle peut partir, l'effacement est complet.
  const person = await fiches.createPerson({ networkId: t.direction.networkId, agentId: null, firstName: 'Noémie', lastName: 'Inventée' });
  await fiches.addIdentifier({ networkId: t.direction.networkId, personId: person.id, kind: 'email', value: 'noemie.inventee@example.test' });
  // Un enregistrement d'appel à elle seule, rangé dans PIECES : il part avec elle.
  await t.db.run(
    "INSERT INTO calls (id, network_id, provider, call_id, status, failure, person_id, consent_given_at, recording_ref, created_at) VALUES ('appel-noemie', ?, 'essai', 'appel-noemie', 'impossible', 'echec', ?, ?, ?, ?)",
    [t.direction.networkId, person.id, t.now().toISOString(), RECORDING, t.now().toISOString()],
  );
  const request = async () => {
    const r = await call('/demandes', 'POST', { personId: person.id, kind: 'effacement', channel: 'mail', receivedOn: '2027-03-01' }, null);
    const id = r.body.data.id as string;
    expect((await call(`/demandes/${id}/effacement`, 'GET', undefined, null)).status).toBe(200);
    return id;
  };
  const firstName = async () => (await t.db.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ?', [person.id]))?.first_name ?? null;
  return { ...t, person, call, request, firstName };
}

describe('SV05 · le Worker monte l’effacement réel seulement quand tout est rangé', () => {
  it('[R17] sans `ERASURE_MODE=reel` écrit tel quel : l’essai, aucun secret lu, aucun appel', async () => {
    const b = copiesBucket();
    for (const mode of [undefined, '', 'essai', 'REEL', ' reel', 'oui', 'true']) {
      const e = await erasureOf({ ...SETTINGS, ...(mode === undefined ? {} : { ERASURE_MODE: mode }) }, b.fetchFn);
      expect(e).toEqual({ mode: 'essai', ledger: null, objects: null });
    }
    expect(b.calls).toEqual([]);
  });

  it('[R231] en mode réel, un réglage du registre manque ou la clé est mal formée : pas de registre, jamais une erreur qui la cite', async () => {
    const b = copiesBucket();
    for (const missing of ['CLOUDFLARE_ACCOUNT_ID', 'COPIES_R2_ACCESS_KEY_ID', 'COPIES_R2_SECRET_ACCESS_KEY', 'COPY_KEY'] as const) {
      for (const value of [undefined, '  ']) {
        const env: Record<string, string | undefined> = { ...SETTINGS, ERASURE_MODE: 'reel', [missing]: value };
        expect((await erasureOf(env, b.fetchFn)).ledger).toBeNull();
      }
    }
    for (const bad of ['pas-du-base64!', btoa('trop court')]) expect((await erasureOf({ ...SETTINGS, ERASURE_MODE: 'reel', COPY_KEY: bad }, b.fetchFn)).ledger).toBeNull();
    const ready = await erasureOf({ ...SETTINGS, ERASURE_MODE: 'reel' }, b.fetchFn);
    expect(ready.mode).toBe('reel');
    expect(ready.ledger).not.toBeNull();
    expect(ready.objects).not.toBeNull();
    expect(b.calls).toEqual([]);
  });

  it('[R231] le Worker ne touche au compartiment des copies que sous `effacements/`', async () => {
    const b = copiesBucket();
    const ledger = ledgerOnly(b.whole);
    const bytes = new Uint8Array([1, 2, 3]);
    for (const key of ['copies/2027-03-10/base.json', 'effacements', '../copies/x', 'effacements/../copies/x', 'autre/effacements/x']) {
      await expect(ledger.put(key, bytes)).rejects.toThrow('hors de son préfixe');
      await expect(ledger.get(key)).rejects.toThrow('hors de son préfixe');
    }
    await expect(ledger.list('copies/')).rejects.toThrow('hors de son préfixe');
    await expect(ledger.list('')).rejects.toThrow('hors de son préfixe');
    expect(b.calls).toEqual([]);
    await ledger.put(`${ERASURE_LEDGER_PREFIX}20270310T120000000Z-ab`, bytes);
    expect(await ledger.list(ERASURE_LEDGER_PREFIX)).toEqual([`${ERASURE_LEDGER_PREFIX}20270310T120000000Z-ab`]);
    // Un stockage qui rendrait une clé hors du préfixe : refusé, le registre ne se lit pas de travers.
    const leaky = ledgerOnly({ ...b.whole, list: async () => ['effacements/a', 'copies/b'] });
    await expect(leaky.list(ERASURE_LEDGER_PREFIX)).rejects.toThrow('liste hors de son préfixe');
  });

  it('[R17] un fichier se retire de son compartiment lié ; un compartiment absent ou sans retrait lève, sans citer la clé', async () => {
    const pieces = liveBucket({ 'boite/appels/a.ogg': 'OggS inventé' });
    const media = liveBucket({ 'boite/appels/a.ogg': 'même nom ailleurs' });
    const eraser = r2ObjectEraser({ PIECES: pieces, MEDIA: media, COMMERCES: { get: async () => null } });
    await eraser.remove('PIECES', 'boite/appels/a.ogg');
    expect(pieces.deleted).toEqual(['boite/appels/a.ogg']);
    expect(media.deleted).toEqual([]);
    for (const storage of ['COMMERCES', 'COFFRE'] as const) {
      const message = await eraser.remove(storage, 'dossiers/secret-invente.pdf').then(() => '', (e: Error) => e.message);
      expect(message).toContain(`Compartiment ${storage} absent`);
      expect(message).not.toContain('secret-invente');
    }
  });
});

describeWithSqlite('SV05 · l’effacement réel par le Worker, noté au registre des copies, puis refait après une restauration', () => {
  it('[R17] en essai, la route refuse et rien n’est effacé ni noté', async () => {
    const t = await setup();
    const id = await t.request();
    const b = copiesBucket();
    const name = await t.firstName();
    const r = await t.call(`/demandes/${id}/effacer`, 'POST', {}, await erasureOf({ ...SETTINGS }, b.fetchFn));
    expect([r.status, r.body]).toEqual([409, { ok: false, rule: 'R17', code: 'trial_only' }]);
    expect(await t.firstName()).toBe(name);
    expect(b.calls).toEqual([]);
  });

  it('[R231] un effacement que le registre refuse de noter n’est pas dit fait, et rien n’est effacé', async () => {
    const t = await setup();
    const id = await t.request();
    const name = await t.firstName();
    const b = copiesBucket({ refusePut: 403 });
    const live = Object.fromEntries(OBJECT_STORAGES.map((s) => [s, liveBucket()]));
    const r = await t.call(`/demandes/${id}/effacer`, 'POST', {}, await erasureOf({ ...SETTINGS, ...live, ERASURE_MODE: 'reel' }, b.fetchFn));
    expect(r.body).toMatchObject({ ok: false, rule: 'R231', code: 'ledger_unwritable' });
    expect(await t.firstName()).toBe(name);
    expect(b.held.size).toBe(0);
    // Sans réglage du registre : refusé avant tout appel.
    const none = copiesBucket();
    const r2 = await t.call(`/demandes/${id}/effacer`, 'POST', {}, await erasureOf({ ERASURE_MODE: 'reel', ...live }, none.fetchFn));
    expect(r2.body).toMatchObject({ ok: false, rule: 'R231', code: 'ledger_missing' });
    expect(none.calls).toEqual([]);
    expect(await t.firstName()).toBe(name);
  });

  it('[R17] un compartiment absent au premier passage : le fichier reste, l’effacement n’est pas dit complet ; refait avec lui, le fichier part', async () => {
    const t = await setup();
    const id = await t.request();
    const b = copiesBucket();
    const pieces = liveBucket({ [RECORDING]: 'OggS inventé' });
    const first = await t.call(`/demandes/${id}/effacer`, 'POST', {}, await erasureOf({ ...SETTINGS, ERASURE_MODE: 'reel' }, b.fetchFn));
    expect(first.body).toMatchObject({ ok: true, data: { receipt: { complete: false, objectsRemaining: 1 } } });
    expect(pieces.objects.has(RECORDING)).toBe(true);
    const second = await t.call(`/demandes/${id}/effacer`, 'POST', {}, await erasureOf({ ...SETTINGS, PIECES: pieces, ERASURE_MODE: 'reel' }, b.fetchFn));
    expect(second.body).toMatchObject({ ok: true, data: { receipt: { complete: true, objectsRemaining: 0, objectsRemoved: { PIECES: 1 } } } });
    expect(pieces.deleted).toEqual([RECORDING]);
  });

  it('[R17] [R231] de bout en bout : noté sous `effacements/`, effacé, refait sans rien de plus, puis refait après une vraie restauration', async () => {
    const t = await setup();
    const id = await t.request();
    const b = copiesBucket();
    const key = await copyKeyFromSecret(SECRET);
    const live = Object.fromEntries(OBJECT_STORAGES.map((s) => [s, liveBucket(s === 'MEDIA' ? { 'biens/b1/salon.jpg': 'JPEG inventé' } : {})])) as Record<ObjectStorage, ReturnType<typeof liveBucket>>;
    // Chaque fichier que la base cite existe dans son stockage, comme en production.
    for (const ref of await fileReferences(t.db)) live[ref.storage].objects.set(ref.key, { bytes: new TextEncoder().encode(`fichier inventé ${ref.key}`) });
    // La copie de chaque nuit, prise avant l'effacement, avec son propre accès au compartiment entier.
    const receipt = await new CopieBase(t.db, t.journal, b.whole, key, { now: t.now }).take();
    await copyObjects(live, b.whole, key, receipt.copyId);
    const before = await t.firstName();
    expect(before).not.toBeNull();

    const erasure = await erasureOf({ ...SETTINGS, ...live, ERASURE_MODE: 'reel' }, b.fetchFn);
    const start = b.calls.length;
    const done = await t.call(`/demandes/${id}/effacer`, 'POST', {}, erasure);
    expect(done.body).toMatchObject({ ok: true, data: { receipt: { mode: 'reel', complete: true } } });
    expect(await t.firstName()).not.toBe(before);
    const written = b.calls.slice(start).filter((c) => c.method === 'PUT').map((c) => c.key);
    expect(written.length).toBeGreaterThan(0);
    expect(b.calls.slice(start).every((c) => c.key.startsWith(ERASURE_LEDGER_PREFIX))).toBe(true);
    expect(written.every((k) => k.startsWith(ERASURE_LEDGER_PREFIX))).toBe(true);
    // Aucune donnée de la personne en clair dans le registre.
    for (const k of written) expect(new TextDecoder().decode(b.held.get(k)!)).not.toContain(String(before));

    // Refait : rien de plus n'est effacé, aucune table ne bouge.
    const rows = (list: { rows: number }[] | undefined) => (list ?? []).reduce((n, c) => n + c.rows, 0);
    expect(rows(done.body.data.receipt.erased)).toBeGreaterThan(0);
    expect(done.body.data.receipt.objectsRemoved).toEqual({ PIECES: 1 });
    expect(live.PIECES.deleted).toEqual([RECORDING]);
    expect(live.PIECES.objects.has(RECORDING)).toBe(false);
    const snapshot = async () => {
      const tables = await t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'journal' ORDER BY name");
      // Le contenu entier de chaque table, pas seulement son nombre de lignes.
      const out: Record<string, string> = {};
      for (const { name } of tables) out[name] = JSON.stringify(await t.db.all(`SELECT * FROM "${name}" ORDER BY rowid`));
      return out;
    };
    const before2 = await snapshot();
    const deletedBefore = Object.fromEntries(OBJECT_STORAGES.map((st) => [st, [...live[st].deleted]]));
    const again = await t.call(`/demandes/${id}/effacer`, 'POST', {}, erasure);
    expect(again.body).toMatchObject({ ok: true, data: { receipt: { complete: true } } });
    for (const part of ['erased', 'pseudonymized', 'hashed', 'stopped'] as const) expect([part, rows(again.body.data.receipt[part])]).toEqual([part, 0]);
    expect(again.body.data.receipt.objectsRemoved).toEqual({});
    expect(Object.fromEntries(OBJECT_STORAGES.map((st) => [st, live[st].deleted]))).toEqual(deletedBefore);
    const after2 = await snapshot();
    expect(Object.fromEntries(Object.entries(after2).filter(([k]) => k !== 'person_request_outputs'))).toEqual(Object.fromEntries(Object.entries(before2).filter(([k]) => k !== 'person_request_outputs')));
    expect(live.MEDIA.objects.has('biens/b1/salon.jpg')).toBe(true);

    // La vraie restauration de la copie d'avant, dans une base et des stockages neufs : la personne ne revient pas.
    const target = fromSyncSqlite(openMemoryDatabase());
    const targets = Object.fromEntries(OBJECT_STORAGES.map((s) => [s, freshTarget()])) as Record<ObjectStorage, ErasableTarget>;
    const later = new Date(t.now().getTime() + 86_400_000);
    const restored = await restoreEverything({ target, targets, store: b.whole, key, copyId: receipt.copyId, now: () => later });
    // Les deux passages sont notés ; refaire les deux ne change rien de plus.
    expect(restored).toMatchObject({ ok: true, erasuresReplayed: [...b.held.keys()].filter((k) => k.startsWith(ERASURE_LEDGER_PREFIX)).length });
    expect([...b.held.keys()].filter((k) => k.startsWith(ERASURE_LEDGER_PREFIX))).toHaveLength(2);
    const back = await target.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ?', [t.person.id]);
    expect(back?.first_name ?? null).not.toBe(before);
    expect(await targets.MEDIA.get('biens/b1/salon.jpg')).not.toBeNull();
    expect(await targets.PIECES.get(RECORDING)).toBeNull();
    expect(await target.first('SELECT id FROM calls WHERE id = ?', ['appel-noemie'])).toBeNull();
  });
});

describeWithSqlite('SV05 · le Worker passe à la route ce que ses réglages permettent, et rien de plus', () => {
  it('[R17] [R231] sans mode réel : essai ; mode réel sans registre : refusé ; registre injoignable : refusé, rien d’effacé', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    const db = fromD1(d1);
    await applyMigrations(db, loadMigrations());
    const store = new FicheClient(db);
    const network = (await store.createNetwork('Réseau test')).id;
    const person = await store.createPerson({ networkId: network, agentId: null, firstName: 'Noémie', lastName: 'Inventée' });
    const KEY = 'test-cle-sv05-conformite-aaaaaaaaaaaaaaaaaaaaaa';
    const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify([{ sha256: await sha256Hex(KEY), networkId: network, role: 'compliance', userId: 'conformite-1' }]) };
    const call = async (method: string, path: string, e: Env, body?: unknown) => {
      const r = await worker.fetch(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${KEY}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), e);
      return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; code?: string; rule?: string | null } };
    };
    // Le Worker lit l'heure réelle : la demande est reçue aujourd'hui.
    const created = await call('POST', '/conformite/demandes', env, { personId: person.id, kind: 'effacement', channel: 'mail', receivedOn: new Date().toISOString().slice(0, 10) });
    const id = created.body.data.id as string;
    expect((await call('GET', `/conformite/demandes/${id}/effacement`, env)).status).toBe(200);
    const name = async () => (await db.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ?', [person.id]))?.first_name;

    expect((await call('POST', `/conformite/demandes/${id}/effacer`, env, {})).body).toEqual({ ok: false, rule: 'R17', code: 'trial_only' });
    expect((await call('POST', `/conformite/demandes/${id}/effacer`, { ...env, ERASURE_MODE: 'reel' }, {})).body).toMatchObject({ ok: false, rule: 'R231', code: 'ledger_missing' });
    const seen: string[] = [];
    vi.stubGlobal('fetch', (async (url: string) => {
      seen.push(new URL(url).pathname);
      return new Response(null, { status: 403 });
    }) as typeof fetch);
    try {
      const r = await call('POST', `/conformite/demandes/${id}/effacer`, { ...env, ...SETTINGS, ERASURE_MODE: 'reel' }, {});
      expect(r.body).toMatchObject({ ok: false, rule: 'R231', code: 'ledger_unwritable' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.startsWith('/aimmo-copies/effacements/'))).toBe(true);
    expect(await name()).toBe('Noémie');
  });
});
