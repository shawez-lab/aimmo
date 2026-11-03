import { expect, it } from 'vitest';
import { applyMigrations, COPY_KEEP_DAYS, copyWatchJob, copyWindowStart, fromSyncSqlite, Planificateur, recordCopyRun, SqlJournalStore, SuiviCopies, type CopyRun, type SqlDatabase, type Viewer } from '@aimmo/core';
import { REGISTRE_TRAITEMENTS } from '../src/conformite/registre-traitements.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé. Paris en hiver : 6 h de Paris = 5 h UTC.
const direction: Viewer = { role: 'direction', networkId: 'n1', userId: 'd1' };
let clock = new Date('2027-03-10T05:00:00.000Z');
const now = () => clock;

const success = (startedAt: string, id = startedAt): CopyRun => ({ id, startedAt, finishedAt: startedAt, outcome: 'copiee', copyId: `c-${id}`, tables: 9, rows: 99, parts: 3 });

async function world() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  return { db, journal, suivi: new SuiviCopies(db, journal, { now }) };
}

describeWithSqlite('SV02 · la copie de chaque nuit, vue par la direction', () => {
  it('[R230] sans aucune copie : « jamais », et jamais un faux succès', async () => {
    const t = await world();
    clock = new Date('2027-03-10T10:00:00.000Z');
    expect(await t.suivi.status(direction)).toEqual({ ok: true, value: { state: 'jamais', lastSuccessAt: null, lastFailure: null, missedNights: [], keepDays: COPY_KEEP_DAYS } });
  });

  it('[R230] un échec rapporté ne compte jamais comme une copie, et sa raison se lit', async () => {
    const t = await world();
    clock = new Date('2027-03-10T10:00:00.000Z');
    await recordCopyRun(t.db, { id: 'r1', startedAt: '2027-03-10T02:00:00.000Z', finishedAt: '2027-03-10T02:01:00.000Z', outcome: 'non_sauvegardee', reason: 'cle_absente' });
    const s = await t.suivi.status(direction);
    expect(s).toMatchObject({ ok: true, value: { state: 'jamais', lastSuccessAt: null, lastFailure: { at: '2027-03-10T02:00:00.000Z', reason: 'cle_absente' } } });
    expect(await t.suivi.watch()).toBe(true);
  });

  it('[R230] la base refuse un compte rendu qui se dirait réussi sans copie, ou un compte rendu réécrit', async () => {
    const t = await world();
    await expect(t.db.run("INSERT INTO base_copy_runs (id, started_at, finished_at, outcome) VALUES ('x', 'a', 'b', 'copiee')")).rejects.toThrow();
    await expect(t.db.run("INSERT INTO base_copy_runs (id, started_at, finished_at, outcome, copy_id) VALUES ('x', 'a', 'b', 'non_sauvegardee', 'c')")).rejects.toThrow();
    await recordCopyRun(t.db, success('2027-03-10T02:00:00.000Z', 'r2'));
    await expect(t.db.run("UPDATE base_copy_runs SET outcome = 'copiee' WHERE id = 'r2'")).rejects.toThrow(/réécrit/);
    await expect(t.db.run("DELETE FROM base_copy_runs WHERE id = 'r2'")).rejects.toThrow(/efface/);
  });

  it('[R230] une copie de la nuit : à jour, sa date se lit, et un échec plus ancien ne se montre plus', async () => {
    const t = await world();
    clock = new Date('2027-03-10T10:00:00.000Z');
    await recordCopyRun(t.db, { id: 'r0', startedAt: '2027-03-09T02:00:00.000Z', finishedAt: '2027-03-09T02:01:00.000Z', outcome: 'non_sauvegardee', reason: 'stockage_en_panne' });
    await recordCopyRun(t.db, success('2027-03-10T02:00:00.000Z'));
    expect(await t.suivi.status(direction)).toMatchObject({ ok: true, value: { state: 'a_jour', lastSuccessAt: '2027-03-10T02:00:00.000Z', lastFailure: null } });
    expect(await t.suivi.watch()).toBe(false);
    expect(await t.db.all('SELECT * FROM base_copy_alerts')).toEqual([]);
  });

  it('[R230] une nuit manquée alerte la direction, une seule fois, même si le travail n’a rien écrit', async () => {
    const t = await world();
    await recordCopyRun(t.db, success('2027-03-09T02:00:00.000Z'));
    clock = new Date('2027-03-10T05:00:00.000Z');
    expect(await t.suivi.watch()).toBe(true);
    clock = new Date('2027-03-10T06:00:00.000Z');
    expect(await t.suivi.watch()).toBe(false);
    expect(await t.db.all('SELECT night, last_success_at FROM base_copy_alerts')).toEqual([{ night: '2027-03-10', last_success_at: '2027-03-09T02:00:00.000Z' }]);
    expect(await t.suivi.status(direction)).toMatchObject({ ok: true, value: { state: 'en_retard', lastSuccessAt: '2027-03-09T02:00:00.000Z', missedNights: ['2027-03-10'] } });
    const events = (await t.journal.all()).filter((e) => e.type === 'base.copie_manquee');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ rule: 'R230', night: '2027-03-10' });
  });

  it('[R230] avant 6 h, la nuit n’est pas finie : la copie d’hier suffit encore ; à 6 h, plus', () => {
    expect(copyWindowStart(new Date('2027-03-10T04:59:00.000Z')).toISOString()).toBe('2027-03-08T05:00:00.000Z');
    expect(copyWindowStart(new Date('2027-03-10T05:00:00.000Z')).toISOString()).toBe('2027-03-09T05:00:00.000Z');
    // En été, 6 h de Paris = 4 h UTC.
    expect(copyWindowStart(new Date('2027-07-10T04:00:00.000Z')).toISOString()).toBe('2027-07-09T04:00:00.000Z');
  });

  it('[R13] une panne du passage ne l’arrête pas pour les autres tâches, et elle est écrite au journal', async () => {
    const t = await world();
    const broken: SqlDatabase = { ...t.db, first: async () => { throw new Error('panne inventée'); } };
    clock = new Date('2027-03-10T05:00:00.000Z');
    const ran: string[] = [];
    const after = { name: 'test.apres', hours: [6], run: async () => { ran.push('apres'); } };
    const result = await new Planificateur(t.db, t.journal, [copyWatchJob(broken, t.journal, { now }), after], { now }).tick();
    expect(result.failed).toEqual(['sauvegarde.surveillance']);
    expect(ran).toEqual(['apres']);
    const logged = JSON.stringify(await t.journal.all());
    expect(logged).toContain('sauvegarde.surveillance');
    expect(logged).not.toContain('panne inventée');
  });

  it('[R16] seule la direction lit l’état des copies ; un refus va au journal', async () => {
    const t = await world();
    for (const role of ['agent', 'compliance', 'assistant'] as const) {
      expect(await t.suivi.status({ role, networkId: 'n1', userId: 'u1' } as Viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused).toHaveLength(3);
    expect(refused[0]!.data).toMatchObject({ rule: 'R16', kind: 'base_copies' });
  });

  it('[R230] la lecture ne dit ni lignes ni tables de la base entière : elle vaut pour tous les réseaux', async () => {
    const t = await world();
    await recordCopyRun(t.db, success('2027-03-10T02:00:00.000Z'));
    const text = JSON.stringify(await t.suivi.status(direction));
    expect(text).not.toMatch(/rows|tables|parts|copyId/);
  });

  it('[R95] la durée de garde et le rejeu des effacements sont écrits au registre des traitements', () => {
    const t = REGISTRE_TRAITEMENTS.find((x) => x.id === 'sauvegardes');
    expect(t).toBeDefined();
    expect(t!.duree).toContain(`${COPY_KEEP_DAYS} jours`);
    expect(t!.duree).toMatch(/effacement.*refait/i);
    expect(t!.sousTraitants.join(' ')).toMatch(/GitHub/);
  });
});
