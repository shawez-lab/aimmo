import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { AGENT_FILE_PIECES, Candidatures, Entretiens, INTERVIEW_QUESTIONS } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, direction et candidats inventés.
let clock = Date.parse('2027-07-05T08:00:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 60_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const candidatures = new Candidatures(db, journal, { now });
  const entretiens = new Entretiens(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const candidate = async (email: string, patch: Record<string, unknown> = {}): Promise<string> => {
    await candidatures.apply(network.id, { firstName: 'Eli', lastName: 'Essai', email, town: 'Beaune', currentStatus: 'autre_metier', experience: 'aucune', source: 'page', question: 'Faut-il une voiture ?', ...patch });
    return (await db.first<{ id: string }>('SELECT id FROM candidates WHERE email = ?', [email]))!.id;
  };
  return { db, journal, entretiens, network, other, dir, candidate };
}

const past = (): string => new Date(clock - 3_600_000).toISOString();

describeWithSqlite('J03 · entretien préparé, décidé par un humain', () => {
  it('[R81] la fiche d’entretien ne contient que le déclaré, les mêmes questions et pièces pour tous, sans note ni avis', async () => {
    const t = await setup();
    const a = await t.candidate('a@example.test');
    const b = await t.candidate('b@example.test', { firstName: 'Max', experience: 'plus_de_5_ans', currentStatus: 'agent_commercial', question: undefined });
    const sa = await t.entretiens.prepare(t.dir, a);
    const sb = await t.entretiens.prepare(t.dir, b);
    if (!sa.ok || !sb.ok) throw new Error('fiche refusée');
    expect(sa.value.declared).toEqual({ firstName: 'Eli', lastName: 'Essai', town: 'Beaune', currentStatus: 'autre_metier', experience: 'aucune', question: 'Faut-il une voiture ?', source: 'page' });
    expect(sa.value.questions).toEqual(sb.value.questions);
    expect(sa.value.questions).toBe(INTERVIEW_QUESTIONS);
    expect(sa.value.pieces).toEqual(sb.value.pieces);
    expect(sa.value.pieces.map((p) => p.kind)).toEqual(AGENT_FILE_PIECES.map((p) => p.kind));
    // Rien d'autre que le déclaré, les questions, les pièces, les entretiens et la décision : aucune clé de note ou d'avis.
    expect(Object.keys(sa.value).sort()).toEqual(['candidateId', 'decision', 'declared', 'interviews', 'pieces', 'questions']);
    expect(JSON.stringify(sa.value)).not.toMatch(/score|note|rang|rank|avis|resume|summary|fit/i);
    const cols = (await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('candidate_decisions')")).map((c) => c.name);
    for (const c of cols) expect(c).not.toMatch(/score|note|rank|rang|grade|rating/i);
  });

  it('[R81] une décision exige un humain nommé et un motif ; un « oui » exige un entretien tenu ; aucun champ de note [R14]', async () => {
    const t = await setup();
    const id = await t.candidate('c@example.test');
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Projet clair, secteur libre', deciderName: 'Shawez' })).toEqual({ ok: false, rule: 'R81', code: 'no_interview' });
    // Un entretien fixé dans le futur n'est pas encore tenu.
    await t.entretiens.schedule(t.dir, id, { at: new Date(clock + 86_400_000).toISOString(), interviewer: 'Shawez' });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Projet clair, secteur libre', deciderName: 'Shawez' })).toEqual({ ok: false, rule: 'R81', code: 'no_interview' });
    expect(await t.entretiens.schedule(t.dir, id, { at: past(), interviewer: 'Shawez' })).toMatchObject({ ok: true });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: '', deciderName: 'Shawez' })).toEqual({ ok: false, rule: 'R81', code: 'no_reason' });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Projet clair, secteur libre' })).toEqual({ ok: false, rule: 'R81', code: 'no_decider' });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Projet clair', deciderName: 'Shawez', score: 9 })).toEqual({ ok: false, rule: 'R81', code: 'unknown_field' });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'peut-être', reason: 'Projet clair', deciderName: 'Shawez' })).toMatchObject({ ok: false, code: 'bad_decision' });
    expect(await t.db.all('SELECT id FROM candidate_decisions')).toEqual([]);
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Projet clair, secteur libre', deciderName: 'Shawez' })).toEqual({ ok: true, decision: 'oui', opensOnboarding: true });
    const sheet = await t.entretiens.prepare(t.dir, id);
    expect(sheet.ok && sheet.value.decision).toMatchObject({ decision: 'oui', deciderName: 'Shawez', reason: 'Projet clair, secteur libre' });
    expect(sheet.ok && sheet.value.interviews).toHaveLength(2);
  });

  it('[R17] une décision rangée ne change plus ; une nouvelle s’ajoute et la dernière compte', async () => {
    const t = await setup();
    const id = await t.candidate('d@example.test');
    expect(await t.entretiens.decide(t.dir, id, { decision: 'a_revoir', reason: 'Attendre la fin de son contrat actuel', deciderName: 'Marion' })).toMatchObject({ ok: true, opensOnboarding: false });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'non', reason: 'Le candidat a choisi un autre projet', deciderName: 'Marion' })).toMatchObject({ ok: true, decision: 'non' });
    expect((await t.entretiens.decisionOf(id))?.decision).toBe('non');
    expect(await t.db.all('SELECT id FROM candidate_decisions')).toHaveLength(2);
    await expect(t.db.run("UPDATE candidate_decisions SET decision = 'oui'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM candidate_decisions')).rejects.toThrow(/rien ne s'efface/);
    // Même au niveau de la base, un « oui » sans entretien est refusé.
    await expect(
      t.db.run("INSERT INTO candidate_decisions (id, network_id, candidate_id, decision, reason, decided_by, decider_name, decided_at) VALUES ('x', ?, ?, 'oui', 'motif écrit', 'direction:x', 'Nom', ?)", [t.network.id, id, past()]),
    ).rejects.toThrow();
  });

  it('[R16] seule la direction du réseau lit et décide ; chaque refus au journal, sans nom ni motif [R13]', async () => {
    const t = await setup();
    const id = await t.candidate('e@example.test');
    for (const viewer of [
      { role: 'agent' as const, userId: 'a-1', networkId: t.network.id },
      { role: 'compliance' as const, userId: 'c-1', networkId: t.network.id },
      { role: 'direction' as const, userId: 'd-2', networkId: t.other.id },
    ]) {
      expect(await t.entretiens.prepare(viewer, id)).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.entretiens.decide(viewer, id, { decision: 'non', reason: 'motif écrit', deciderName: 'Quelqu’un' })).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.entretiens.schedule(viewer, id, { at: past(), interviewer: 'X' })).toMatchObject({ ok: false, rule: 'R16' });
    }
    expect(await t.db.all('SELECT id FROM candidate_decisions')).toEqual([]);
    await t.entretiens.schedule(t.dir, id, { at: past(), interviewer: 'Shawez' });
    await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Motif confidentiel écrit', deciderName: 'Shawez' });
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'acces.refuse')).toHaveLength(9);
    expect(JSON.stringify(entries)).not.toMatch(/Eli|Essai|Beaune|confidentiel|Shawez|example\.test/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });
});
