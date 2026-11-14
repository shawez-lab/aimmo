import { expect, it } from 'vitest';
import { applyMigrations, fromSyncSqlite, journeyReceipt, RecusParcours, recordJourneyReceipt, SqlJournalStore, type JourneyReceipt, type SqlDatabase, type Viewer } from '@aimmo/core';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé.
const direction: Viewer = { role: 'direction', networkId: 'n1', userId: 'd1' };
let clock = new Date('2027-03-20T10:00:00.000Z');
const now = () => clock;

async function world() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  return { db, journal, recus: new RecusParcours(db, journal, { now }) };
}

const ok = (id: string, ranAt: string): JourneyReceipt => ({ id, ranAt, month: ranAt.slice(0, 7), outcome: 'reussi' });
const ko = (id: string, ranAt: string, step: 'mandat' | null = 'mandat'): JourneyReceipt => ({ id, ranAt, month: ranAt.slice(0, 7), outcome: 'rate', step });

describeWithSqlite('BR72 · le reçu du parcours complet fictif de chaque mois (Jamais vu)', () => {
  it('réussi seulement si le travail a réussi et n’a cassé nulle part ; le mois est celui de Paris', () => {
    const at = new Date('2027-03-03T04:23:00.000Z');
    expect(journeyReceipt({ id: 'a', ranAt: at, jobResult: 'success', said: 'aucune' })).toEqual({ id: 'a', ranAt: at.toISOString(), month: '2027-03', outcome: 'reussi' });
    expect(journeyReceipt({ id: 'a', ranAt: at, jobResult: 'failure', said: 'mandat' })).toMatchObject({ outcome: 'rate', step: 'mandat' });
    expect(journeyReceipt({ id: 'a', ranAt: at, jobResult: 'success', said: 'mandat' })).toMatchObject({ outcome: 'rate', step: 'mandat' });
    expect(journeyReceipt({ id: 'a', ranAt: new Date('2027-02-28T23:30:00.000Z'), jobResult: 'success', said: 'aucune' }).month).toBe('2027-03');
  });

  it('une étape hors liste, un résultat illisible ou vide : raté, sans étape, jamais un vert', () => {
    const at = new Date('2027-03-03T04:23:00.000Z');
    for (const [jobResult, said] of [['failure', 'lea.vendeuse@example.test'], ['failure', ''], ['cancelled', 'aucune'], ['', ''], ['success', ''], ['success', 'MANDAT'], ['success', 'mandat\netape=aucune']] as const) {
      expect(journeyReceipt({ id: 'a', ranAt: at, jobResult, said })).toEqual({ id: 'a', ranAt: at.toISOString(), month: '2027-03', outcome: 'rate', step: null });
    }
  });

  it('un reçu réussi ou raté avec son étape est rangé et relu par la direction', async () => {
    const t = await world();
    await recordJourneyReceipt(t.db, ko('a', '2027-03-03T04:23:00.000Z'));
    expect(await t.recus.status(direction)).toEqual({ ok: true, value: { state: 'echec', expectedMonth: '2027-03', receipt: { id: 'a', ranAt: '2027-03-03T04:23:00.000Z', month: '2027-03', outcome: 'rate', step: 'mandat' } } });
    await recordJourneyReceipt(t.db, ok('b', '2027-03-05T09:00:00.000Z'));
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'reussi', receipt: { id: 'b', outcome: 'reussi' } } });
    await recordJourneyReceipt(t.db, ko('c', '2027-03-06T09:00:00.000Z', null));
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'echec', receipt: { id: 'c', step: null } } });
  });

  it('sans reçu du mois attendu : « manquant », jamais un vert par défaut ; jusqu’au 3 à Paris, le mois d’avant suffit', async () => {
    const t = await world();
    expect(await t.recus.status(direction)).toEqual({ ok: true, value: { state: 'manquant', expectedMonth: '2027-03', receipt: null } });
    await recordJourneyReceipt(t.db, ok('a', '2027-02-03T04:23:00.000Z'));
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'manquant', expectedMonth: '2027-03', receipt: { month: '2027-02' } } });
    clock = new Date('2027-03-03T10:00:00.000Z');
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'reussi', expectedMonth: '2027-02' } });
    clock = new Date('2027-03-20T10:00:00.000Z');
  });

  it('un reçu daté dans le futur ne cache jamais les vrais', async () => {
    const t = await world();
    await recordJourneyReceipt(t.db, ko('a', '2027-03-03T04:23:00.000Z'));
    await recordJourneyReceipt(t.db, ok('b', '2027-09-03T04:23:00.000Z'));
    expect(await t.recus.status(direction)).toMatchObject({ ok: true, value: { state: 'echec', receipt: { id: 'a' } } });
  });

  it('[R16] seule la direction lit le reçu ; un refus va au journal', async () => {
    const t = await world();
    for (const role of ['agent', 'compliance'] as const) expect(await t.recus.status({ role, networkId: 'n1', userId: 'u1' } as Viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'journey_receipt')).toHaveLength(2);
  });

  it('[R13] le reçu et le journal ne portent qu’un instant, un mois, un résultat et une étape de la liste', async () => {
    const t = await world();
    await recordJourneyReceipt(t.db, journeyReceipt({ id: 'a', ranAt: new Date('2027-03-03T04:23:00.000Z'), jobResult: 'failure', said: 'lea.vendeuse@example.test' }));
    await t.recus.status(direction);
    const stored = JSON.stringify(await t.db.all('SELECT * FROM journey_receipts')) + JSON.stringify(await t.journal.all());
    expect(stored).not.toContain('lea.vendeuse');
    expect(Object.keys((await t.db.all('SELECT * FROM journey_receipts'))[0] as object).sort()).toEqual(['id', 'month', 'outcome', 'ran_at', 'step']);
  });

  it('la base refuse une étape hors liste et une étape sur un reçu réussi', async () => {
    const t = await world();
    await expect(t.db.run("INSERT INTO journey_receipts (id, ran_at, month, outcome, step) VALUES ('a', 't', '2027-03', 'rate', 'autre')")).rejects.toThrow();
    await expect(t.db.run("INSERT INTO journey_receipts (id, ran_at, month, outcome, step) VALUES ('a', 't', '2027-03', 'reussi', 'mandat')")).rejects.toThrow();
  });

  it('un reçu ne se réécrit ni ne s’efface', async () => {
    const t = await world();
    await recordJourneyReceipt(t.db, ok('a', '2027-03-03T04:23:00.000Z'));
    await expect(t.db.run("UPDATE journey_receipts SET month = '2027-04'")).rejects.toThrow(/réécrit/);
    await expect(t.db.run('DELETE FROM journey_receipts')).rejects.toThrow(/efface/);
  });
});
