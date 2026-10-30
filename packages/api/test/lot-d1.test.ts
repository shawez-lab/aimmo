import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, runBatch } from '@aimmo/core';
import { Candidatures, DossierAgent, Entretiens } from '../../core/src/reseau/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { fromD1 } from '../src/d1.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// J15 · sous D1, un lot passe par `batch`, tout ou rien.
describeWithSqlite('J15 · écriture en lot sous D1', () => {
  it('un lot qui échoue en route ne garde rien ; un lot qui réussit garde tout', async () => {
    const db = fromD1(fakeD1(openMemoryDatabase()));
    await db.exec('CREATE TABLE a (id TEXT PRIMARY KEY); CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT NOT NULL REFERENCES a (id));');
    await expect(runBatch(db, [{ sql: 'INSERT INTO a (id) VALUES (?)', params: ['x'] }, { sql: "INSERT INTO b (id, a_id) VALUES ('y', 'absent')" }])).rejects.toThrow();
    expect(await db.all('SELECT id FROM a')).toEqual([]);
    expect(await runBatch(db, [{ sql: 'INSERT INTO a (id) VALUES (?)', params: ['x'] }, { sql: "INSERT INTO b (id, a_id) VALUES ('y', 'x')" }])).toEqual([{ changes: 1 }, { changes: 1 }]);
  });
});

describeWithSqlite('J15 · entrée d’un agent sous D1', () => {
  it('[R18] une entrée qui échoue ne laisse aucun agent ; deux entrées simultanées n’en créent qu’un', async () => {
    let clock = Date.parse('2027-07-10T08:00:00.000Z');
    const now = (): Date => new Date((clock += 1000));
    const db = fromD1(fakeD1(openMemoryDatabase()));
    await applyMigrations(db, loadMigrations());
    const journal = new SqlJournalStore(db);
    const store = new FicheClient(db, { now });
    const candidatures = new Candidatures(db, journal, { now });
    const entretiens = new Entretiens(db, journal, { now });
    const files = { has: async () => true, putDraft: async (agentId: string) => `agents/${agentId}/brouillon.txt` };
    const dossier = new DossierAgent(db, store, entretiens, files, journal, { now });
    const network = await store.createNetwork('Réseau test');
    const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
    // Candidat, entretien et décision inventés.
    await candidatures.apply(network.id, { firstName: 'Ana', lastName: 'Nouvelle', email: 'lot-d1@example.test', currentStatus: 'autre_metier', experience: 'aucune', source: 'page' });
    const cand = (await db.first<{ id: string }>('SELECT id FROM candidates WHERE email = ?', ['lot-d1@example.test']))!.id;
    const s = await entretiens.schedule(dir, cand, { at: new Date(clock + 3_600_000).toISOString(), interviewer: 'Shawez' });
    clock += 2 * 3_600_000;
    if (!s.ok) throw new Error('entretien');
    await entretiens.markHeld(dir, s.interviewId, 'Shawez');
    await entretiens.decide(dir, cand, { decision: 'oui', reason: 'Projet clair et secteur libre', deciderName: 'Shawez' });

    const count = async (sql: string, p: (string | number)[] = []) => (await db.first<{ n: number }>(sql, p))!.n;
    const before = await count('SELECT count(*) AS n FROM agents');
    await db.exec("CREATE TRIGGER panne_entree BEFORE INSERT ON agent_onboardings BEGIN SELECT RAISE(ABORT, 'panne inventée'); END");
    await expect(dossier.admit(dir, cand)).rejects.toThrow(/panne/);
    expect(await count('SELECT count(*) AS n FROM agents')).toBe(before);
    await db.exec('DROP TRIGGER panne_entree');
    const [a, b] = await Promise.all([dossier.admit(dir, cand), dossier.admit(dir, cand)]);
    expect(a.ok && b.ok && a.agentId === b.agentId).toBe(true);
    expect(await count('SELECT count(*) AS n FROM agents')).toBe(before + 1);
    expect(await count('SELECT count(*) AS n FROM agent_onboardings WHERE candidate_id = ?', [cand])).toBe(1);
  });
});
