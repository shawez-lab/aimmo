import { expect, it } from 'vitest';
import { applyMigrations, CopieBase, copyKeyFromSecret, FicheClient, fromSyncSqlite, recordErasure, replayErasures, restoreWithErasures, SqlJournalStore, verifyChain, type ErasureLedgerStore, type PersonEraser, type SqlDatabase } from '@aimmo/core';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : le réseau, les personnes, le stockage, les clés et l'effaceur, qui ne touche qu'à ces bases de test.
const SECRET = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const OTHER = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 200 - i)));
const MARK = 'Inventee-Lisible';
const TAKEN = '2027-03-10T02:00:00.000Z';
const now = () => new Date(TAKEN);

const memoryStore = () => {
  const parts = new Map<string, Uint8Array>();
  const store: ErasureLedgerStore = {
    put: async (k, b) => { parts.set(k, b); },
    get: async (k) => parts.get(k) ?? null,
    list: async (prefix) => [...parts.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
  return { parts, store };
};

// L'effaceur du test : sans effet si la personne n'y est plus, comme la procédure réelle devra l'être.
const contacts = "CREATE TABLE test_contacts (person_id TEXT PRIMARY KEY, label TEXT NOT NULL)";
const eraser: PersonEraser & { seen: string[] } = {
  seen: [],
  async erase(db, entry) {
    this.seen.push(entry.personId);
    return (await db.run('DELETE FROM test_contacts WHERE person_id = ?', [entry.personId])).changes;
  },
};

async function world() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const fiche = new FicheClient(db, { now });
  const network = await fiche.createNetwork('Réseau test');
  await db.exec(contacts);
  for (const id of ['p1', 'p2', 'p3']) await db.run('INSERT INTO test_contacts (person_id, label) VALUES (?, ?)', [id, `${MARK}-${id}`]);
  const { parts, store } = memoryStore();
  const key = await copyKeyFromSecret(SECRET);
  const receipt = await new CopieBase(db, new SqlJournalStore(db), store, key, { now }).take();
  eraser.seen = [];
  const entry = (personId: string, erasedAt: string) => ({ requestId: `dem-${personId}`, networkId: network.id, personId, erasedAt });
  return { db, parts, store, key, receipt, entry };
}

const left = async (db: SqlDatabase) => (await db.all<{ person_id: string }>('SELECT person_id FROM test_contacts ORDER BY person_id')).map((r) => r.person_id);
const blank = (): SqlDatabase => fromSyncSqlite(openMemoryDatabase());

describeWithSqlite('SV02 · un effacement fait après la copie est refait après la restauration', () => {
  it('[R231] la personne effacée après la copie ne revient pas ; le rejeu est écrit au journal, dont la chaîne reste valide', async () => {
    const t = await world();
    await recordErasure(t.store, t.key, t.entry('p2', '2027-03-10T12:00:00.000Z'));
    const target = blank();
    const r = await restoreWithErasures(target, t.store, t.key, t.receipt.copyId, eraser, { now: () => new Date('2027-03-11T09:00:00.000Z') });
    expect(r).toMatchObject({ ok: true, erasuresReplayed: 1 });
    expect(await left(target)).toEqual(['p1', 'p3']);
    const events = await new SqlJournalStore(target).all();
    const replay = events.filter((e) => e.type === 'rgpd.effacement_rejoue');
    expect(replay.map((e) => e.subject)).toEqual(['person:p2']);
    expect(JSON.stringify(replay)).not.toContain(MARK);
    expect((await verifyChain(events)).ok).toBe(true);
  });

  it('[R231] sans le rejeu, la copie seule fait bien revenir la personne : c’est ce que le rejeu répare', async () => {
    const t = await world();
    await recordErasure(t.store, t.key, t.entry('p2', '2027-03-10T12:00:00.000Z'));
    const { restoreCopy } = await import('@aimmo/core');
    const target = blank();
    expect((await restoreCopy(target, t.store, t.key, t.receipt.copyId)).ok).toBe(true);
    expect(await left(target)).toEqual(['p1', 'p2', 'p3']);
  });

  it('[R231] un effacement bien plus ancien que la copie n’est pas refait ; dans la marge d’une heure, il l’est ; l’ordre est celui des dates', async () => {
    const t = await world();
    await recordErasure(t.store, t.key, t.entry('p3', '2027-03-10T12:00:00.000Z'));
    await recordErasure(t.store, t.key, t.entry('p1', '2027-03-08T12:00:00.000Z'));
    await recordErasure(t.store, t.key, t.entry('p2', '2027-03-10T01:30:00.000Z'));
    const target = blank();
    const r = await restoreWithErasures(target, t.store, t.key, t.receipt.copyId, eraser);
    expect(r).toMatchObject({ ok: true, erasuresReplayed: 2 });
    expect(eraser.seen).toEqual(['p2', 'p3']);
    expect(await left(target)).toEqual(['p1']);
  });

  it('[R231] rejouer deux fois ne change rien de plus', async () => {
    const t = await world();
    await recordErasure(t.store, t.key, t.entry('p2', '2027-03-10T12:00:00.000Z'));
    const target = blank();
    await restoreWithErasures(target, t.store, t.key, t.receipt.copyId, eraser);
    expect(await replayErasures(target, t.store, t.key, eraser, { copyTakenAt: TAKEN })).toEqual({ ok: true, replayed: 1, erasedRows: 0 });
    expect(await left(target)).toEqual(['p1', 'p3']);
  });

  it('[R231] une entrée changée ou une mauvaise clé : la restauration n’est pas dite finie, et rien n’est effacé', async () => {
    const t = await world();
    await recordErasure(t.store, t.key, t.entry('p1', '2027-03-10T11:00:00.000Z'));
    await recordErasure(t.store, t.key, t.entry('p2', '2027-03-10T12:00:00.000Z'));
    const last = [...t.parts.keys()].filter((k) => k.startsWith('effacements/')).sort().at(-1)!;
    const bytes = t.parts.get(last)!.slice();
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    t.parts.set(last, bytes);
    const target = blank();
    expect(await restoreWithErasures(target, t.store, t.key, t.receipt.copyId, eraser)).toEqual({ ok: false, code: 'erasures_not_replayed', cause: 'ledger_unreadable', replayed: 0 });
    expect(eraser.seen).toEqual([]);
    expect(await left(target)).toEqual(['p1', 'p2', 'p3']);
    expect(await replayErasures(target, t.store, await copyKeyFromSecret(OTHER), eraser, { copyTakenAt: TAKEN })).toEqual({ ok: false, code: 'ledger_unreadable', replayed: 0 });
  });

  it('[R231] un effacement qui échoue : pas dit fini, le nombre déjà refait se lit, et l’erreur ne sort pas', async () => {
    const t = await world();
    await recordErasure(t.store, t.key, t.entry('p1', '2027-03-10T11:00:00.000Z'));
    await recordErasure(t.store, t.key, t.entry('p2', '2027-03-10T12:00:00.000Z'));
    const failing: PersonEraser = { erase: async (db, e) => { if (e.personId === 'p2') throw new Error(MARK); return eraser.erase(db, e); } };
    const r = await restoreWithErasures(blank(), t.store, t.key, t.receipt.copyId, failing);
    expect(r).toEqual({ ok: false, code: 'erasures_not_replayed', cause: 'erase_failed', replayed: 1 });
  });

  it('[R231] une panne du stockage à la lecture du registre : pas dit fini', async () => {
    const t = await world();
    const broken: ErasureLedgerStore = { ...t.store, list: async () => { throw new Error('panne inventée'); } };
    expect(await restoreWithErasures(blank(), broken, t.key, t.receipt.copyId, eraser)).toMatchObject({ ok: false, code: 'erasures_not_replayed', cause: 'ledger_unreadable' });
  });

  it('[R231] une copie refusée reste refusée, sans toucher au registre', async () => {
    const t = await world();
    expect(await restoreWithErasures(blank(), t.store, t.key, '20270310T020000Z-0000000000000000', eraser)).toEqual({ ok: false, code: 'manifest_missing' });
    expect(eraser.seen).toEqual([]);
  });

  it('[R231] le registre est illisible dans le stockage, et il refuse un effacement mal décrit', async () => {
    const t = await world();
    await recordErasure(t.store, t.key, t.entry('p2', '2027-03-10T12:00:00.000Z'));
    const stored = [...t.parts].find(([k]) => k.startsWith('effacements/'))!;
    expect(stored[0]).not.toContain('p2');
    expect(new TextDecoder('latin1').decode(stored[1])).not.toMatch(/p2|dem-/);
    await expect(recordErasure(t.store, t.key, t.entry('', 'pas une date'))).rejects.toThrow('mal décrit');
  });
});
