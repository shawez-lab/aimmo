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
  /** La fiche du proche d'une recommandation, lue dans la base (le lecteur, lui, ne la reçoit pas). */
  const referred = async (id: string) => (await db.first<{ referred_id: string; agent_id: string | null; call_due_at: string | null }>('SELECT referred_id, agent_id, call_due_at FROM referrals WHERE id = ?', [id]))!;
  const refusedLines = async () => (await journal.all()).filter((e) => e.type === 'recommandation.refusee');
  return { db, journal, store, fiche, reco, network, alex, sam, as, lea, persons, referred, refusedLines };
}

const OK = { firstName: 'Hugo', email: 'hugo@example.test', projectKind: 'sell', callable: true, proof: 'Hugo est d’accord pour être appelé, dit Léa au téléphone' };

describeWithSqlite('F01 · recommandation d’un proche', () => {
  it('[R66] le proche arrive dans la fiche unique avec la source « recommandation » ; une tâche « appeler » le lendemain', async () => {
    const t = await setup();
    const r = await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, OK);
    expect(r).toEqual({ ok: true, value: { id: expect.any(String), recorded: true } });
    if (!r.ok) return;
    const row = await t.referred(r.value.id);
    expect(row.call_due_at).toBe(new Date(NOW + 24 * 3_600_000).toISOString());
    const view = await t.fiche.view(row.referred_id);
    expect(view.person).toMatchObject({ first_name: 'Hugo', agent_id: t.alex.id });
    expect(view.sources).toEqual([expect.objectContaining({ channel: 'recommandation', detail: 'recommandé par un client' })]);
    expect(view.projects).toEqual([expect.objectContaining({ kind: 'sell' })]);
    expect(view.consents).toEqual([expect.objectContaining({ purpose: REFERRAL_PURPOSE, channel: 'phone', proof: expect.stringContaining('selon le client qui recommande') })]);
    // Le lien se lit sur les deux fiches ; la tâche est dans la liste de l'agent.
    expect(await t.reco.linksOf(t.as('agent', t.alex.id), t.lea.id)).toEqual({ ok: true, value: { recommendedBy: [], recommended: [{ referralId: r.value.id, firstName: 'Hugo' }] } });
    expect(await t.reco.linksOf(t.as('agent', t.alex.id), row.referred_id)).toEqual({ ok: true, value: { recommendedBy: [{ firstName: 'Léa' }], recommended: [] } });
    expect(await t.reco.callsOf(t.as('agent', t.alex.id))).toEqual({ ok: true, value: [{ referralId: r.value.id, personId: row.referred_id, firstName: 'Hugo', dueAt: row.call_due_at }] });
    // Une seule recommandation par client et par proche [R18] : le refus ne laisse rien sur la fiche.
    expect(await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, OK)).toMatchObject({ ok: false, code: 'already_referred' });
    const again = await t.fiche.view(row.referred_id);
    expect([again.projects.length, again.sources.length, again.consents.length]).toEqual([1, 1, 1]);
    // Rien d'une coordonnée au journal [R13].
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/hugo@|example\.test|Hugo/);
    expect(entries.filter((e) => e.type === 'recommandation.rangee')).toHaveLength(1);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('[R66] jamais de récompense : aucun champ en dehors de la liste, aucun texte qui en parle ; rien n’est rangé, chaque refus au journal', async () => {
    const t = await setup();
    const before = await t.persons();
    const agent = t.as('agent', t.alex.id);
    expect(await t.reco.recommend(agent, t.lea.id, { ...OK, reward: 100 })).toEqual({ ok: false, rule: 'R66', code: 'unknown_field' });
    for (const proof of ['Léa aura un cadeau', 'prime de 200 euros', 'Léa touchera 10 %', 'une commission pour Léa', 'bon d’achat offert', 'chèque de remerciement', 'Léa sera rémunérée']) {
      expect(await t.reco.recommend(agent, t.lea.id, { ...OK, proof }), proof).toEqual({ ok: false, rule: 'R66', code: 'reward' });
    }
    expect(await t.reco.recommend(agent, t.lea.id, { ...OK, proof: ' ' })).toEqual({ ok: false, rule: 'R03', code: 'bad_proof' });
    expect(mentionsReward('Hugo est d’accord pour être appelé à la remise des clés')).toBe(false);
    expect(await t.persons()).toBe(before);
    expect((await t.refusedLines()).map((e) => e.data.code)).toEqual(['unknown_field', ...Array(7).fill('reward'), 'bad_proof']);
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/cadeau|hugo@/);
    expect(await t.db.all('SELECT * FROM referrals')).toEqual([]);
  });

  it('[R03] sans accord du proche, la fiche est rangée sans tâche ni accord', async () => {
    const t = await setup();
    const r = await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, { firstName: 'Hugo', phone: '06 12 34 56 78', projectKind: 'buy', callable: false });
    expect(r).toMatchObject({ ok: true, value: { recorded: true } });
    if (!r.ok) return;
    const row = await t.referred(r.value.id);
    expect(row.call_due_at).toBeNull();
    expect((await t.fiche.view(row.referred_id)).consents).toEqual([]);
  });

  it('[R02, R03, R04] jamais rappelé : exclusion active, accord retiré, ou opposition dite après coup ; une exclusion levée ne bloque plus', async () => {
    const t = await setup();
    const known = async (firstName: string, email: string) => {
      const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName });
      await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: email });
      return p;
    };
    const nina = await known('Nina', 'nina@example.test');
    await t.store.addExclusion({ networkId: t.network.id, personId: nina.id, reason: 'stop', notedAt: new Date(NOW - 86_400_000) });
    const paul = await known('Paul', 'paul@example.test');
    const c = await t.store.addConsent({ networkId: t.network.id, personId: paul.id, purpose: REFERRAL_PURPOSE, channel: 'phone', proof: 'test', givenAt: new Date(NOW - 2 * 86_400_000) });
    await t.store.withdrawConsent(c.id, new Date(NOW - 86_400_000));
    const zoe = await known('Zoé', 'zoe@example.test');
    const lifted = await t.store.addExclusion({ networkId: t.network.id, personId: zoe.id, reason: 'refused', notedAt: new Date(NOW - 3 * 86_400_000) });
    await t.store.liftExclusion(lifted.id, new Date(NOW - 86_400_000));
    const agent = t.as('agent', t.alex.id);
    const r1 = await t.reco.recommend(agent, t.lea.id, { ...OK, firstName: 'Nina', email: 'nina@example.test' });
    const r2 = await t.reco.recommend(agent, t.lea.id, { ...OK, firstName: 'Paul', email: 'paul@example.test' });
    const r3 = await t.reco.recommend(agent, t.lea.id, { ...OK, firstName: 'Zoé', email: 'zoe@example.test' });
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('refus');
    expect((await t.referred(r1.value.id)).call_due_at).toBeNull();
    expect((await t.referred(r2.value.id)).call_due_at).toBeNull();
    expect((await t.referred(r3.value.id)).call_due_at).not.toBeNull();
    expect((await t.fiche.view(nina.id)).consents).toEqual([]);
    expect((await t.fiche.view(paul.id)).consents).toHaveLength(1);
    // Zoé dit stop après coup : sa tâche disparaît de la liste.
    expect((await t.reco.callsOf(agent)).ok && (await t.reco.callsOf(agent) as { value: unknown[] }).value).toHaveLength(1);
    await t.store.addExclusion({ networkId: t.network.id, personId: zoe.id, reason: 'stop', notedAt: new Date(NOW) });
    expect(await t.reco.callsOf(agent)).toEqual({ ok: true, value: [] });
  });

  it('[R16] la réponse ne dit jamais si le proche est client d’un autre agent ; la tâche va à l’agent qui le suit, ou à celui qui saisit', async () => {
    const t = await setup();
    const omar = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Omar' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: omar.id, kind: 'phone', value: '+33 6 99 99 99 99' });
    const orphan = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Iris' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: orphan.id, kind: 'email', value: 'iris@example.test' });
    const agent = t.as('agent', t.alex.id);
    const fresh = await t.reco.recommend(agent, t.lea.id, OK);
    const other = await t.reco.recommend(agent, t.lea.id, { ...OK, firstName: 'Omar', email: undefined, phone: '06 99 99 99 99' });
    const none = await t.reco.recommend(agent, t.lea.id, { ...OK, firstName: 'Iris', email: 'iris@example.test' });
    if (!fresh.ok || !other.ok || !none.ok) throw new Error('refus');
    // Même forme de réponse, quel que soit le proche.
    for (const r of [fresh, other, none]) expect(Object.keys(r.value).sort()).toEqual(['id', 'recorded']);
    expect(await t.referred(other.value.id)).toMatchObject({ agent_id: t.sam.id, call_due_at: expect.any(String) });
    expect(await t.referred(none.value.id)).toMatchObject({ agent_id: t.alex.id, call_due_at: expect.any(String) });
    // Du côté de Léa, chaque proche est dit par le prénom saisi, jamais par sa fiche.
    const links = await t.reco.linksOf(agent, t.lea.id);
    if (!links.ok) throw new Error(links.code);
    expect(links.value.recommendedBy).toEqual([]);
    expect([...links.value.recommended].sort((a, b) => String(a.firstName).localeCompare(String(b.firstName)))).toEqual([
      { referralId: fresh.value.id, firstName: 'Hugo' },
      { referralId: none.value.id, firstName: 'Iris' },
      { referralId: other.value.id, firstName: 'Omar' },
    ]);
    // La tâche d'Omar est chez Sam, pas chez Alex ; « appel fait » par Sam seulement.
    expect((await t.reco.callsOf(t.as('agent', t.sam.id))) as unknown).toMatchObject({ ok: true, value: [{ referralId: other.value.id, firstName: 'Omar' }] });
    expect(await t.reco.callDone(agent, other.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    // Iris, que personne ne suivait, passe à Alex : sa tâche est dans sa liste et il ouvre sa fiche.
    expect((await t.reco.callsOf(agent)) as unknown).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ referralId: none.value.id, personId: orphan.id, firstName: 'Iris' })]) });
    // Les droits d'aujourd'hui : Sam parti ne marque plus l'appel.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.sam.id]);
    expect(await t.reco.callDone(t.as('agent', t.sam.id), other.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.db.first('SELECT call_done_at FROM referrals WHERE id = ?', [other.value.id])).toEqual({ call_done_at: null });
    await t.db.run("UPDATE agents SET status = 'active' WHERE id = ?", [t.sam.id]);
    expect(await t.reco.callDone(t.as('agent', t.sam.id), other.value.id)).toEqual({ ok: true });
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
    expect(await t.reco.callsOf(t.as('direction', 'd-1'))).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.reco.recommend(t.as('direction', 'd-1'), t.lea.id, OK)).toMatchObject({ ok: true });
    expect(await t.db.first('SELECT agent_id FROM referrals')).toEqual({ agent_id: t.alex.id });
    expect(await t.reco.recommend(t.as('agent', t.alex.id), t.lea.id, { ...OK, email: 'pas-un-mail' })).toMatchObject({ ok: false, code: 'bad_email' });
  });
});
