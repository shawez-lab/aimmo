import { describe, expect, it } from 'vitest';
import { applyMigrations, copyKeyFromSecret, fromSyncSqlite, recordErasure, replayErasures, type PersonEraser, type SqlDatabase } from '@aimmo/core';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { completeListPage, CopyStoreError, r2CopyStore } from '../outils/r2-copies.ts';

// Tout est inventé : le compte, les clés, les réponses du compartiment et les personnes.
const NOW = new Date('2027-03-10T12:00:00.000Z');
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 3)));

/** Un faux compartiment S3 : il garde les objets, répond aux listes par pages de `size` clés. */
function bucket(size = 1000, options: { refuseList?: number; foreign?: string } = {}) {
  const held = new Map<string, Uint8Array>();
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    urls.push(url);
    headers.push(init.headers as Record<string, string>);
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.replace(/^\/aimmo-copies\/?/, ''));
    if (init.method === 'PUT') {
      if (held.has(key)) return new Response(null, { status: 412 });
      held.set(key, new Uint8Array(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    if (u.searchParams.get('list-type') === '2') {
      if (options.refuseList) return new Response('', { status: options.refuseList });
      const prefix = u.searchParams.get('prefix') ?? '';
      const all = [...held.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (options.foreign) all.push(options.foreign);
      const start = Number(u.searchParams.get('continuation-token') ?? '0');
      const page = all.slice(start, start + size);
      const more = start + size < all.length;
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + size}</NextContinuationToken>` : ''}</ListBucketResult>`;
      return new Response(xml);
    }
    const found = held.get(key);
    return found ? new Response(Uint8Array.from(found)) : new Response('', { status: 404 });
  }) as typeof fetch;
  const store = r2CopyStore({ accountId: 'compte', bucket: 'aimmo-copies', accessKeyId: 'id-invente', secretAccessKey: 'secret-invente', now: () => NOW, wait: async () => {}, fetch: fetchFn });
  return { store, held, urls, headers };
}

describe('AU021 · le compartiment des copies tient aussi le registre des effacements', () => {
  it('[R231] la liste d’un préfixe est signée, suit chaque page, et ne rend que ce préfixe', async () => {
    const b = bucket(2);
    for (const k of ['effacements/c', 'effacements/a', 'copies/x/sommaire', 'effacements/b']) await b.store.put(k, new Uint8Array([1]));
    b.urls.length = 0;
    expect(await b.store.list('effacements/')).toEqual(['effacements/a', 'effacements/b', 'effacements/c']);
    expect(b.urls[0]).toBe('https://compte.r2.cloudflarestorage.com/aimmo-copies?list-type=2&max-keys=1000&prefix=effacements%2F');
    expect(b.urls[1]).toContain('continuation-token=2');
    expect(b.headers[0]!['authorization']).toContain('Credential=id-invente/20270310/auto/s3/aws4_request');
    expect(JSON.stringify(b.headers)).not.toContain('secret-invente');
  });

  it('[R231] une liste refusée, coupée sans suite ou hors du préfixe lève, sans citer de clé', async () => {
    await expect(bucket(1000, { refuseList: 403 }).store.list('effacements/')).rejects.toBeInstanceOf(CopyStoreError);
    const foreign = bucket(1000, { foreign: 'copies/autre-personne' });
    const error = await foreign.store.list('effacements/').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CopyStoreError);
    expect(String(error)).not.toContain('autre-personne');
    const down = r2CopyStore({ accountId: 'compte', bucket: 'aimmo-copies', accessKeyId: 'id', secretAccessKey: 's', now: () => NOW, fetch: (async () => { throw new TypeError('coupure'); }) as typeof fetch });
    await expect(down.list('effacements/')).rejects.toBeInstanceOf(CopyStoreError);
  });

  it('[R231] une réponse 200 coupée ou mal formée ne passe jamais pour un registre vide', async () => {
    const bad = [
      '<ListBucketResult><Contents><Key>effacements/a</Key>',
      '<ListBucketResult><Contents><Key>effacements/a</Key></Contents>',
      '<ListBucketResult><Contents><Key>effacements/a</Key></Contents></ListBucketResult>',
      '<ListBucketResult><Contents><Size>1</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
      '<Error><Code>InternalError</Code></Error>',
      '',
    ];
    for (const xml of bad) {
      expect(completeListPage(xml)).toBe(false);
      const store = r2CopyStore({ accountId: 'compte', bucket: 'aimmo-copies', accessKeyId: 'id', secretAccessKey: 's', now: () => NOW, fetch: (async () => new Response(xml)) as typeof fetch });
      await expect(store.list('effacements/')).rejects.toBeInstanceOf(CopyStoreError);
    }
    expect(completeListPage('<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListBucketResult>')).toBe(true);
  });
});

describeWithSqlite('AU021 · le registre relu dans le compartiment est rejoué', () => {
  it('[R231] noté puis relu par le compartiment, un effacement est rejoué dans l’ordre ; une liste en panne : pas dit fini', async () => {
    const b = bucket(1);
    const key = await copyKeyFromSecret(SECRET);
    for (const [personId, at] of [['p2', '2027-03-10T12:00:00.000Z'], ['p1', '2027-03-10T11:00:00.000Z']] as const) {
      await recordErasure(b.store, key, { requestId: `dem-${personId}`, networkId: 'reseau-1', personId, erasedAt: at });
    }
    const seen: string[] = [];
    const eraser: PersonEraser = { erase: async (_db, e) => { seen.push(e.personId); return 1; } };
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    expect(await replayErasures(db, b.store, key, eraser, { copyTakenAt: '2027-03-10T02:00:00.000Z', now: () => NOW })).toEqual({ ok: true, replayed: 2, erasedRows: 2 });
    expect(seen).toEqual(['p1', 'p2']);
    const broken = bucket(1000, { refuseList: 500 });
    expect(await replayErasures(db, broken.store, key, eraser, { copyTakenAt: '2027-03-10T02:00:00.000Z', now: () => NOW })).toEqual({ ok: false, code: 'ledger_unreadable', replayed: 0 });
  });
});
