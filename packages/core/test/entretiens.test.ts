import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const soon = (): string => new Date(clock + 3_600_000).toISOString();
/** Fixe un entretien, laisse passer l'heure, puis le marque tenu. */
async function heldInterview(t: Awaited<ReturnType<typeof setup>>, id: string): Promise<string> {
  const s = await t.entretiens.schedule(t.dir, id, { at: soon(), interviewer: 'Shawez' });
  if (!s.ok) throw new Error('entretien refusé');
  clock += 2 * 3_600_000;
  expect(await t.entretiens.markHeld(t.dir, s.interviewId, 'Shawez')).toEqual({ ok: true });
  return s.interviewId;
}

it('[R81] la fiche et la décision n’appellent aucune IA : le module n’importe ni IA, ni assistant, ni qualification', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/reseau/entretiens.ts', import.meta.url)), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  expect(imports).toEqual(['../acces/droits.ts', '../db/sql.ts', '../journal/journal.ts', '../journal/types.ts', './candidatures.ts']);
  expect(source).not.toMatch(/fetch\(|compose\(|anthropic|openai/i);
});

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
    // Une date passée ne se fixe pas : un entretien ne se déclare pas tenu après coup.
    expect(await t.entretiens.schedule(t.dir, id, { at: '2000-01-01T09:00:00.000Z', interviewer: 'Shawez' })).toEqual({ ok: false, rule: 'R81', code: 'past_date' });
    // Un entretien fixé n'est pas tenu : ni avant sa date, ni après sans être marqué tenu.
    const later = await t.entretiens.schedule(t.dir, id, { at: new Date(clock + 86_400_000).toISOString(), interviewer: 'Shawez' });
    expect(later.ok && (await t.entretiens.markHeld(t.dir, later.interviewId, 'Shawez'))).toEqual({ ok: false, rule: 'R81', code: 'not_yet' });
    clock += 2 * 86_400_000;
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Projet clair, secteur libre', deciderName: 'Shawez' })).toEqual({ ok: false, rule: 'R81', code: 'no_interview' });
    expect(later.ok && (await t.entretiens.markHeld(t.dir, later.interviewId, ' '))).toEqual({ ok: false, rule: 'R81', code: 'no_interviewer' });
    await heldInterview(t, id);
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: '', deciderName: 'Shawez' })).toEqual({ ok: false, rule: 'R81', code: 'no_reason' });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Projet clair, secteur libre' })).toEqual({ ok: false, rule: 'R81', code: 'no_decider' });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Projet clair', deciderName: 'Shawez', score: 9 })).toEqual({ ok: false, rule: 'R81', code: 'unknown_field' });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'peut-être', reason: 'Projet clair', deciderName: 'Shawez' })).toMatchObject({ ok: false, code: 'bad_decision' });
    expect(await t.db.all('SELECT id FROM candidate_decisions')).toEqual([]);
    expect(await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Projet clair, secteur libre', deciderName: 'Shawez' })).toEqual({ ok: true, decision: 'oui', opensOnboarding: true });
    const sheet = await t.entretiens.prepare(t.dir, id);
    expect(sheet.ok && sheet.value.decision).toMatchObject({ decision: 'oui', deciderName: 'Shawez', reason: 'Projet clair, secteur libre' });
    expect(sheet.ok && sheet.value.interviews.map((i) => i.held)).toEqual([false, true]);
    expect(await t.entretiens.acceptedIn(t.network.id, id)).toBe(true);
    expect(await t.entretiens.acceptedIn(t.other.id, id)).toBe(false);
  });

  it('[R17] une décision rangée ne change plus ; une nouvelle s’ajoute et la dernière compte', async () => {
    const t = await setup();
    const id = await t.candidate('d@example.test');
    expect(await t.entretiens.decide(t.dir, id, { decision: 'a_revoir', reason: 'Attendre la fin de son contrat actuel', deciderName: 'Marion' })).toMatchObject({ ok: true, opensOnboarding: false });
    expect(await t.entretiens.decide(t.dir, id, { decision: 'non', reason: 'Le candidat a choisi un autre projet', deciderName: 'Marion' })).toMatchObject({ ok: true, decision: 'non' });
    const sheet = await t.entretiens.prepare(t.dir, id);
    expect(sheet.ok && sheet.value.decision?.decision).toBe('non');
    expect(await t.entretiens.acceptedIn(t.network.id, id)).toBe(false);
    expect(await t.db.all('SELECT id FROM candidate_decisions')).toHaveLength(2);
    await expect(t.db.run("UPDATE candidate_decisions SET decision = 'oui'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM candidate_decisions')).rejects.toThrow(/rien ne s'efface/);
    // Même au niveau de la base, un « oui » sans entretien est refusé.
    await expect(
      t.db.run("INSERT INTO candidate_decisions (id, network_id, candidate_id, decision, reason, decided_by, decider_name, decided_at) VALUES ('x', ?, ?, 'oui', 'motif écrit', 'direction:x', 'Nom', ?)", [t.network.id, id, soon()]),
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
      expect(await t.entretiens.schedule(viewer, id, { at: soon(), interviewer: 'X' })).toMatchObject({ ok: false, rule: 'R16' });
    }
    const own = await t.entretiens.schedule(t.dir, id, { at: soon(), interviewer: 'Shawez' });
    clock += 2 * 3_600_000;
    expect(own.ok && (await t.entretiens.markHeld({ role: 'agent', userId: 'a-1', networkId: t.network.id }, own.interviewId, 'X'))).toMatchObject({ ok: false, rule: 'R16' });
    expect(own.ok && (await t.entretiens.markHeld({ role: 'direction', userId: 'd-2', networkId: t.other.id }, own.interviewId, 'X'))).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.db.all('SELECT id FROM candidate_decisions')).toEqual([]);
    expect(own.ok && (await t.entretiens.markHeld(t.dir, own.interviewId, 'Shawez'))).toEqual({ ok: true });
    await t.entretiens.decide(t.dir, id, { decision: 'oui', reason: 'Motif confidentiel écrit', deciderName: 'Shawez' });
    await t.entretiens.prepare(t.dir, id);
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'acces.refuse')).toHaveLength(11);
    // Chaque lecture d'une fiche d'entretien est au journal [R16].
    expect(entries.filter((e) => e.type === 'candidature.lue')).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toMatch(/Eli|Essai|Beaune|confidentiel|Shawez|example\.test/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });
});
