import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { CANDIDATE_FALLBACK, CANDIDATE_MENTION, Candidatures, ReponsesCandidats, checkRecruitingText, topicOf } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, direction et candidats inventés.
let clock = Date.parse('2027-07-02T08:00:00.000Z');

const GRILLE = 'La part de l’agent suit une grille écrite, la même pour tous : au moins 70 % de chaque commission dès la première vente, et une part qui monte avec le chiffre de l’année. Nous ne promettons aucun revenu.';
const FRAIS = 'Aucun pack mensuel, aucun frais d’entrée, aucun frais par dossier : 0 € pour travailler avec le système.';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const candidatures = new Candidatures(db, journal, { now });
  const reponses = new ReponsesCandidats(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: 'agent-1', networkId: network.id };
  const candidate = async (email: string, consent = true): Promise<string> => {
    await candidatures.apply(network.id, {
      firstName: 'Noa',
      email,
      currentStatus: 'autre_metier',
      experience: 'aucune',
      source: 'podcast',
      contactConsent: consent ? { given: true, proof: 'case cochée sur la page' } : { given: false },
    });
    return (await db.first<{ id: string }>('SELECT id FROM candidates WHERE email = ?', [email]))!.id;
  };
  return { db, journal, reponses, network, dir, agent, candidate };
}

describeWithSqlite('J02 · réponses de l’assistant aux candidats', () => {
  it('[R80] une question sur ce que gagne un agent reçoit la grille écrite, jamais un chiffre de revenu ; la première réponse porte la mention [R06]', async () => {
    const t = await setup();
    expect(await t.reponses.write(t.dir, 'remuneration', GRILLE)).toMatchObject({ ok: true });
    const id = await t.candidate('noa@example.test');
    for (const q of ['Combien je peux gagner par mois ?', 'Quel salaire au début ?', 'C’est quoi la rémunération ?', 'Les frais, et combien on gagne ?']) expect(topicOf(q), q).toBe('remuneration');
    const r = await t.reponses.answer(t.network.id, id, 'msg-1', 'Combien je peux gagner par mois, en vrai ?');
    expect(r).toMatchObject({ status: 'prepared', topic: 'remuneration', answered: true });
    const replies = await t.reponses.repliesOf(t.dir, id);
    expect(replies.ok && replies.value).toEqual([expect.objectContaining({ topic: 'remuneration', mode: 'essai', body: `${GRILLE}\n\n${CANDIDATE_MENTION}` })]);
    expect(replies.ok && checkRecruitingText(replies.value[0]!.body)).toEqual({ ok: true });
    // La deuxième réponse n'a plus la mention.
    await t.reponses.write(t.dir, 'frais', FRAIS);
    expect(await t.reponses.answer(t.network.id, id, 'msg-2', 'Il y a des frais d’entrée ?')).toMatchObject({ status: 'prepared', topic: 'frais', answered: true });
    const again = await t.reponses.repliesOf(t.dir, id);
    expect(again.ok && again.value[1]!.body).toBe(FRAIS);
  });

  it('[R80] la direction ne peut pas écrire une réponse qui promet un revenu, ni parler de l’IA [R06]', async () => {
    const t = await setup();
    expect(await t.reponses.write(t.dir, 'remuneration', 'Nos agents gagnent 5 000 € par mois')).toEqual({ ok: false, rule: 'R80', code: 'income_promise' });
    expect(await t.reponses.write(t.dir, 'remuneration', 'Jusqu’à 8 000 par mois avec la grille')).toEqual({ ok: false, rule: 'R80', code: 'income_promise' });
    expect(await t.reponses.write(t.dir, 'outils', 'Notre intelligence artificielle fait tout pour vous')).toMatchObject({ ok: false, rule: 'R06' });
    expect(await t.reponses.write(t.agent, 'frais', FRAIS)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.reponses.write(t.dir, 'meteo', FRAIS)).toEqual({ ok: false, rule: null, code: 'bad_topic' });
    expect(await t.db.all('SELECT id FROM recruiting_answers')).toEqual([]);
  });

  it('[R10] sans réponse écrite, rien n’est inventé : texte de secours et tâche pour la direction [R12]', async () => {
    const t = await setup();
    const id = await t.candidate('lou@example.test');
    expect(await t.reponses.answer(t.network.id, id, 'msg-1', 'Quelle est la zone de Dijon ?')).toMatchObject({ status: 'prepared', topic: 'zone', answered: false });
    expect(await t.reponses.answer(t.network.id, id, 'msg-2', 'Bonjour, j’ai une question bizarre')).toMatchObject({ status: 'prepared', topic: null, answered: false });
    const replies = await t.reponses.repliesOf(t.dir, id);
    expect(replies.ok && replies.value.map((r) => r.body)).toEqual([`${CANDIDATE_FALLBACK}\n\n${CANDIDATE_MENTION}`, CANDIDATE_FALLBACK]);
    const tasks = await t.reponses.openTasks(t.dir);
    expect(tasks.ok && tasks.value.map((x) => x.topic)).toEqual(['zone', null]);
    expect(tasks.ok && (await t.reponses.taskDone(t.dir, tasks.value[0]!.taskId))).toEqual({ ok: true });
    const left = await t.reponses.openTasks(t.dir);
    expect(left.ok && left.value).toHaveLength(1);
    expect(await t.reponses.openTasks(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    await expect(t.db.run('DELETE FROM recruiting_tasks')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R03] un candidat sans accord ne reçoit rien ; [R18] une question ne reçoit qu’une réponse ; [R13] rien de la question au journal', async () => {
    const t = await setup();
    await t.reponses.write(t.dir, 'remuneration', GRILLE);
    const silent = await t.candidate('sans@example.test', false);
    expect(await t.reponses.answer(t.network.id, silent, 'msg-1', 'Combien on gagne ?')).toEqual({ status: 'refused', rule: 'R03', code: 'no_consent' });
    expect(await t.db.all('SELECT id FROM candidate_replies')).toEqual([]);
    const id = await t.candidate('ok@example.test');
    const first = await t.reponses.answer(t.network.id, id, 'msg-1', 'Combien on gagne, question secrète ?');
    const second = await t.reponses.answer(t.network.id, id, 'msg-1', 'Combien on gagne, question secrète ?');
    expect(first.status).toBe('prepared');
    expect(second).toEqual({ status: 'already', replyId: first.status === 'prepared' ? first.replyId : '' });
    expect(await t.db.all('SELECT id FROM candidate_replies')).toHaveLength(1);
    expect(await t.reponses.answer(t.network.id, 'inconnu', 'msg-1', 'x')).toEqual({ status: 'refused', rule: null, code: 'unknown_candidate' });
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/secr[eè]te|example\.test|Noa|70 %/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('la dernière réponse écrite d’un sujet compte ; les anciennes restent [R17]', async () => {
    const t = await setup();
    await t.reponses.write(t.dir, 'essai', 'L’essai dure 30 jours, sans frais.');
    await t.reponses.write(t.dir, 'essai', 'L’essai dure 30 jours, sans frais ; vous partez avec un mois de préavis.');
    const current = await t.reponses.current(t.dir);
    expect(current.ok && current.value).toEqual([expect.objectContaining({ topic: 'essai', body: 'L’essai dure 30 jours, sans frais ; vous partez avec un mois de préavis.' })]);
    expect(await t.db.all('SELECT id FROM recruiting_answers')).toHaveLength(2);
    await expect(t.db.run("UPDATE recruiting_answers SET body = 'x'")).rejects.toThrow(/ne change plus/);
  });
});
