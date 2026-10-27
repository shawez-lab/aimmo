import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, REFERRAL_PURPOSE, Recommandations, SqlJournalStore, applyMigrations, fromSyncSqlite, mentionsReward, verifyChain, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, client et proches inventés.
const NOW = Date.parse('2027-06-15T08:00:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(NOW);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const reco = new Recommandations(db, store, fiche, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  const lea = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Cliente' });
  const persons = async () => ((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM persons'))!.n as number);
  return { db, journal, store, fiche, reco, network, alex, sam, as, lea, persons };
}

const OK = { firstName: 'Hugo', email: 'hugo@example.test', projectKind: 'sell', callable: true, proof: 'Hugo est d’accord pour être appelé, dit Léa au téléphone' };

describeWithSqlite('F01 · recommandation d’un proche', () => {
  it('[R66] le proche arrive dans la fiche unique avec la source « recommandation » et le client qui recommande ; une tâche « appeler » le lendemain', async () => {
    const t = await setup();
    const r = await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.callDueAt).toBe(new Date(NOW + 24 * 3_600_000).toISOString());
    const view = await t.fiche.view(r.value.referredId);
    expect(view.person).toMatchObject({ first_name: 'Hugo', agent_id: t.alex.id });
    expect(view.sources).toEqual([expect.objectContaining({ channel: 'recommandation', detail: 'recommandé par Léa' })]);
    expect(view.projects).toEqual([expect.objectContaining({ kind: 'sell' })]);
    expect(view.consents).toEqual([expect.objectContaining({ purpose: REFERRAL_PURPOSE, channel: 'phone', proof: expect.stringContaining('selon le client qui recommande') })]);
    // Le lien se lit sur les deux fiches.
    expect(await t.reco.linksOf(t.as('agent', t.alex.id), t.lea.id)).toEqual({ ok: true, value: { recommendedBy: [], recommended: [{ personId: r.value.referredId, firstName: 'Hugo' }] } });
    expect(await t.reco.linksOf(t.as('agent', t.alex.id), r.value.referredId)).toEqual({ ok: true, value: { recommendedBy: [{ personId: t.lea.id, firstName: 'Léa' }], recommended: [] } });
    // Une seule recommandation par client et par proche [R18].
    expect(await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, OK)).toMatchObject({ ok: false, code: 'already_referred' });
    // Rien d'une coordonnée au journal [R13].
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/hugo@|example\.test|Hugo/);
    expect(entries.filter((e) => e.type === 'recommandation.rangee')).toHaveLength(1);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('[R66] jamais de récompense : aucun champ en dehors de la liste, aucun texte qui en parle ; rien n’est rangé', async () => {
    const t = await setup();
    const before = await t.persons();
    const agent = t.as('agent', t.alex.id);
    expect(await t.reco.recommend(agent, t.lea.id, { ...OK, reward: 100 })).toEqual({ ok: false, rule: 'R66', code: 'unknown_field' });
    for (const proof of ['Léa aura un cadeau', 'prime de 200 euros', 'Léa touchera 10 %', 'une commission pour Léa', 'bon d’achat offert', 'chèque de remerciement', 'Léa sera rémunérée']) {
      expect(await t.reco.recommend(agent, t.lea.id, { ...OK, proof }), proof).toEqual({ ok: false, rule: 'R66', code: 'reward' });
    }
    expect(mentionsReward('Hugo est d’accord pour être appelé à la remise des clés')).toBe(false);
    expect(await t.persons()).toBe(before);
    expect((await t.journal.all()).filter((e) => e.type === 'recommandation.refusee')).toHaveLength(7);
    expect(await t.db.all('SELECT * FROM referrals')).toEqual([]);
  });

  it('[R03] sans accord du proche, la fiche est rangée sans tâche ni accord ; avec accord, la preuve est exigée', async () => {
    const t = await setup();
    expect(await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, { ...OK, proof: '' })).toEqual({ ok: false, rule: 'R03', code: 'bad_proof' });
    const r = await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, { firstName: 'Hugo', phone: '06 12 34 56 78', projectKind: 'buy', callable: false });
    expect(r).toMatchObject({ ok: true, value: { callDueAt: null } });
    if (!r.ok) return;
    expect((await t.fiche.view(r.value.referredId)).consents).toEqual([]);
    expect(await t.db.first('SELECT call_due_at FROM referrals')).toEqual({ call_due_at: null });
  });

  it('[R02, R04] un proche connu qui a demandé l’arrêt n’est jamais rappelé ; suivi par un autre agent, la tâche va à cet agent, sans le dire', async () => {
    const t = await setup();
    const stopped = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Nina' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: stopped.id, kind: 'email', value: 'nina@example.test' });
    await t.store.addExclusion({ networkId: t.network.id, personId: stopped.id, reason: 'stop', notedAt: new Date(NOW - 86_400_000) });
    const r1 = await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, { ...OK, firstName: 'Nina', email: 'nina@example.test' });
    expect(r1).toMatchObject({ ok: true, value: { referredId: stopped.id, callDueAt: null } });
    expect((await t.fiche.view(stopped.id)).consents).toEqual([]);
    const samClient = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Omar' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: samClient.id, kind: 'phone', value: '+33 6 99 99 99 99' });
    const r2 = await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, { ...OK, firstName: 'Omar', email: undefined, phone: '06 99 99 99 99' });
    expect(r2).toMatchObject({ ok: true, value: { referredId: samClient.id, callDueAt: null } });
    if (!r2.ok) return;
    const row = await t.db.first<{ agent_id: string; call_due_at: string | null }>('SELECT agent_id, call_due_at FROM referrals WHERE id = ?', [r2.value.id]);
    expect(row).toEqual({ agent_id: t.sam.id, call_due_at: expect.any(String) });
    // Alex ne voit pas la fiche d'Omar : le lien est dit, sans le nommer.
    expect(await t.reco.linksOf(t.as('agent', t.alex.id), t.lea.id)).toMatchObject({ ok: true, value: { recommended: [{ personId: stopped.id, firstName: 'Nina' }, { personId: null, firstName: null }] } });
    // « Appel fait » : seulement l'agent qui a la tâche ; la ligne reste.
    expect(await t.reco.callDone(t.as('agent', t.alex.id), r2.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.reco.callDone(t.as('agent', t.sam.id), r2.value.id)).toEqual({ ok: true });
    await expect(t.db.run('DELETE FROM referrals')).rejects.toThrow();
  });

  it('[R16] seuls l’agent du client et la direction rangent une recommandation ; chaque refus va au journal', async () => {
    const t = await setup();
    const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    let before = await refusals();
    expect(await t.reco.recommend(t.as('agent', t.sam.id), t.lea.id, OK)).toMatchObject({ ok: false, rule: 'R16' });
    expect((await refusals()) - before).toBe(1);
    before = await refusals();
    expect(await t.reco.recommend(t.as('compliance', 'c-1'), t.lea.id, OK)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect((await refusals()) - before).toBe(1);
    expect(await t.reco.recommend(t.as('direction', 'd-1'), t.lea.id, OK)).toMatchObject({ ok: true, value: { callDueAt: null } });
    expect(await t.db.first('SELECT agent_id FROM referrals')).toEqual({ agent_id: t.alex.id });
    expect(await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, { ...OK, email: 'pas-un-mail' })).toMatchObject({ ok: false, code: 'bad_email' });
  });
});
