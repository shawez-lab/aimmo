import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { EngagementsManques, EngagementsTenus, MISSED_PROMISE_PAGE, pilotageHourlyJob } from '../src/pilotage/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé. On est le 20 juillet 2027 à 7 h 30 de Paris ; les cas sont en juin et en juillet.
const NOW = '2027-07-20T05:30:00.000Z';

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  raw.exec('PRAGMA foreign_keys = OFF');
  let clock = new Date(NOW);
  const now = (): Date => clock;
  const journal = new SqlJournalStore(db);
  const network = await new FicheClient(db, { now }).createNetwork('Réseau test');
  const net = network.id;
  const as = (role: string): Viewer => ({ role, userId: 'u1', networkId: net }) as Viewer;
  const t = new EngagementsManques(db, journal, { now });
  let n = 0;
  const id = (p = 'x') => `${p}${(n += 1)}`;
  /** Une visite tenue, sans compte rendu : un cas manqué après 24 h. */
  const visit = async (person: string, endAt: string, agent = 'a1') => {
    const i = id('v');
    await db.run("INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'visite', ?, ?, 'honored', ?, 'test', ?, ?)", [i, net, agent, person, new Date(Date.parse(endAt) - 3_600_000).toISOString(), endAt, i, endAt, endAt]);
    return i;
  };
  const exclude = (person: string, lifted: string | null = null) => db.run('INSERT INTO exclusions (id, network_id, person_id, reason, noted_at, lifted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id('e'), net, person, 'stop', '2027-06-01T00:00:00.000Z', lifted, '2027-06-01T00:00:00.000Z']);
  const open = async () => {
    const r = await t.open(as('direction'));
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const table of ['messages', 'trial_outbox', 'send_log']) out[table] = Number((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
    return out;
  };
  return { raw, db, journal, net, as, t, id, visit, exclude, open, counts, now, tenus: new EngagementsTenus(db, journal, { now }), setClock: (iso: string) => { clock = new Date(iso); } };
}

describeWithSqlite('IN12 · engagement manqué, rappel par un responsable', () => {
  it('[R228] un cas manqué donne une seule tâche, même rejoué ; un cas dans son délai n’en donne pas ; le mois passé et le mois en cours comptent', async () => {
    const s = await setup();
    await s.visit('p1', '2027-06-10T10:00:00.000Z');
    await s.visit('p2', '2027-07-10T10:00:00.000Z');
    await s.visit('p3', '2027-07-20T05:00:00.000Z'); // le délai de 24 h court encore
    await s.visit('p4', '2027-04-10T10:00:00.000Z'); // trop ancien pour le passage
    expect(await s.t.sync(s.net)).toBe(2);
    expect(await s.t.sync(s.net)).toBe(0);
    const v = await s.open();
    expect(v.total).toBe(2);
    expect(v.tasks.map((x) => [x.code, x.day, x.personId, x.doNotCall])).toEqual([
      ['compte_rendu_24h', '2027-06-10', 'p1', false],
      ['compte_rendu_24h', '2027-07-10', 'p2', false],
    ]);
    expect(v.tasks[0]!.label).toBe('Compte rendu de chaque visite sous 24 h');
    s.setClock('2027-07-21T06:00:00.000Z');
    expect(await s.t.sync(s.net)).toBe(1);
    expect((await s.open()).total).toBe(3);
  });

  it('[R228] [R216] un engagement du jour même n’est manqué qu’après son minuit de Paris : pas de tâche le matin, ni s’il est tenu le jour même', async () => {
    const s = await setup();
    const callback = (person: string, created: string, done: string | null) => s.db.run("INSERT INTO callback_tasks (id, network_id, person_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES (?, ?, ?, 'q', ?, 'r', ?, ?, ?)", [s.id('c'), s.net, person, s.id('k'), created, created, done]);
    const offer = (id: string, received: string) => s.db.run("INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES (?, ?, ?, 1, 'acquereur', 100, '[]', '2027-12-31', 0, 0, 'r', ?, 'a', ?, 'a', 'x', ?)", [id, s.net, `bien-${id}`, received, received, id]);
    await callback('tenu', '2027-07-20T01:00:00.000Z', '2027-07-20T08:00:00.000Z');
    await callback('non-tenu', '2027-07-20T01:30:00.000Z', null);
    await offer('o1', '2027-07-20T04:30:00.000Z');
    expect(await s.t.sync(s.net)).toBe(0); // 7 h 30 à Paris : la journée n'est pas finie.
    s.setClock('2027-07-20T21:59:00.000Z'); // 23 h 59 à Paris
    expect(await s.t.sync(s.net)).toBe(0);
    s.setClock('2027-07-20T22:00:00.000Z'); // minuit à Paris : le cas tenu ne donne rien
    expect(await s.t.sync(s.net)).toBe(2);
    expect((await s.open()).tasks.map((t) => t.code).sort()).toEqual(['offre_jour_meme', 'rappel_chaud']);
    expect((await s.open()).tasks.find((t) => t.code === 'rappel_chaud')!.personId).toBe('non-tenu');
  });

  it('[R228] [R216] la tâche suit la mesure : les cas manqués du mois sont exactement ceux que voit la direction', async () => {
    const s = await setup();
    await s.visit('p1', '2027-06-10T10:00:00.000Z');
    await s.visit('p2', '2027-06-11T10:00:00.000Z');
    await s.db.run("INSERT INTO callback_tasks (id, network_id, person_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES ('c', ?, 'p3', 'q', 'k', 'r', ?, ?, NULL)", [s.net, '2027-06-12T10:00:00.000Z', '2027-06-12T10:00:00.000Z']);
    const r = await s.tenus.ofMonth(s.as('direction'), '2027-06');
    if (!r.ok) throw new Error(r.code);
    const missed = await s.tenus.missedCases(s.net, '2027-06');
    expect(missed.map((c) => c.day).sort()).toEqual(r.value.lines.flatMap((l) => l.missedDays).sort());
    expect(missed).toHaveLength(3);
    expect(JSON.stringify(r.value)).not.toContain('p1');
  });

  it('[R228] la machine n’envoie rien au client, et le journal ne dit ni qui ni quoi d’une personne', async () => {
    const s = await setup();
    await s.visit('personne-inventee', '2027-06-10T10:00:00.000Z');
    const before = await s.counts();
    await s.t.sync(s.net);
    const { tasks } = await s.open();
    await s.t.close(s.as('direction'), tasks[0]!.id, 'rappele');
    expect(await s.counts()).toEqual(before);
    const events = (await s.journal.all()).filter((e) => e.type.startsWith('pilotage.engagement_manque'));
    expect(events.map((e) => e.type)).toEqual(['pilotage.engagement_manque', 'pilotage.engagement_manque_fait']);
    expect(events[0]!.data).toEqual({ rule: 'R228', code: 'compte_rendu_24h', day: '2027-06-10' });
    expect(JSON.stringify(await s.journal.all())).not.toContain('personne-inventee');
  });

  it('[R228] deux fiches réunies : la personne est la fiche gardée, sans nouvelle tâche', async () => {
    const s = await setup();
    await s.visit('perdue', '2027-06-10T10:00:00.000Z');
    await s.db.run("INSERT INTO person_merges (id, network_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES ('m1', ?, 'gardee', 'perdue', 'r', ?, ?)", [s.net, NOW, NOW]);
    await s.t.sync(s.net);
    expect((await s.open()).tasks[0]!.personId).toBe('gardee');
    expect(await s.t.sync(s.net)).toBe(0);
  });

  it('[R18] [R228] des fiches réunies après la naissance de la tâche : aucune nouvelle tâche, la lecture rend la fiche gardée, et l’annulation non plus', async () => {
    const s = await setup();
    const callback = (id: string, person: string) => s.db.run("INSERT INTO callback_tasks (id, network_id, person_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES (?, ?, ?, 'q', ?, 'r', ?, ?, NULL)", [id, s.net, person, id, '2027-06-10T10:00:00.000Z', '2027-06-10T10:00:00.000Z']);
    await callback('c1', 'p1');
    await callback('c2', 'p2');
    await s.visit('p2', '2027-06-10T10:00:00.000Z');
    expect(await s.t.sync(s.net)).toBe(3);
    await s.db.run("INSERT INTO person_merges (id, network_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES ('m1', ?, 'p1', 'p2', 'r', ?, ?)", [s.net, NOW, NOW]);
    expect(await s.t.sync(s.net)).toBe(0);
    expect((await s.open()).tasks.every((t) => t.personId === 'p1')).toBe(true);
    await s.db.run("UPDATE person_merges SET undone_at = ? WHERE id = 'm1'", [NOW]);
    expect(await s.t.sync(s.net)).toBe(0);
    expect((await s.open()).total).toBe(3);
  });

  it('[R02] [R228] l’exclusion se voit sur toute la famille : la fiche gardée après la tâche, une chaîne de fusions, une fiche réunie', async () => {
    const merge = (s: Awaited<ReturnType<typeof setup>>, survivor: string, merged: string) => s.db.run('INSERT INTO person_merges (id, network_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [s.id('m'), s.net, survivor, merged, 'r', NOW, NOW]);
    const kept = await setup();
    await kept.visit('p', '2027-06-10T10:00:00.000Z');
    await kept.t.sync(kept.net);
    await merge(kept, 'g', 'p');
    await kept.exclude('g');
    const task = (await kept.open()).tasks[0]!;
    expect(task).toMatchObject({ personId: 'g', doNotCall: true });
    expect(await kept.t.close(kept.as('direction'), task.id, 'rappele')).toEqual({ ok: false, rule: 'R02', code: 'do_not_call' });
    const chain = await setup();
    await chain.visit('p', '2027-06-10T10:00:00.000Z');
    await chain.t.sync(chain.net);
    await merge(chain, 'b', 'a');
    await merge(chain, 'p', 'b');
    await chain.exclude('a');
    expect((await chain.open()).tasks[0]).toMatchObject({ personId: 'p', doNotCall: true });
    const future = await setup();
    await future.visit('p', '2027-06-10T10:00:00.000Z');
    await future.t.sync(future.net);
    await future.db.run("INSERT INTO exclusions (id, network_id, person_id, reason, noted_at, created_at) VALUES ('e', ?, 'p', 'stop', '2099-01-01T00:00:00.000Z', ?)", [future.net, NOW]);
    expect((await future.open()).tasks[0]!.doNotCall).toBe(false);
  });

  it('[R228] le passage tient avec les clés étrangères actives, sur de vraies fiches et de vrais agents', async () => {
    const s = await setup();
    await s.db.run("INSERT INTO agents (id, network_id, first_name, last_name, status, created_at, updated_at) VALUES ('a1', ?, 'Prénom', 'Nom', 'active', ?, ?)", [s.net, NOW, NOW]);
    await s.db.run("INSERT INTO persons (id, network_id, agent_id, first_name, last_name, created_at, updated_at) VALUES ('p1', ?, 'a1', 'Octave', 'Inventé', ?, ?)", [s.net, NOW, NOW]);
    s.raw.exec('PRAGMA foreign_keys = ON');
    await s.visit('p1', '2027-06-10T10:00:00.000Z');
    expect(await s.t.sync(s.net)).toBe(1);
    expect((await s.open()).tasks[0]).toMatchObject({ personId: 'p1' });
    await expect(s.db.run("INSERT INTO missed_promise_tasks (id, network_id, promise_code, case_key, day, person_id, created_at) VALUES ('z', ?, 'point_lundi', 'k', '2027-06-01', 'fantome', ?)", [s.net, NOW])).rejects.toThrow();
  });

  it('[R02] [R228] une personne exclue : « ne pas appeler », son rappel ne se note jamais fait, seul « sans appel » ferme la tâche', async () => {
    const s = await setup();
    await s.visit('p1', '2027-06-10T10:00:00.000Z');
    await s.t.sync(s.net);
    await s.exclude('p1');
    const task = (await s.open()).tasks[0]!;
    expect(task.doNotCall).toBe(true);
    const d = s.as('direction');
    expect(await s.t.close(d, task.id, 'rappele')).toEqual({ ok: false, rule: 'R02', code: 'do_not_call' });
    expect(await s.t.close(d, task.id, 'injoignable')).toEqual({ ok: false, rule: 'R02', code: 'do_not_call' });
    expect(await s.t.close(d, task.id, 'sans_appel')).toMatchObject({ ok: true });
    expect((await s.open()).total).toBe(0);
  });

  it('[R02] une exclusion levée n’empêche plus l’appel', async () => {
    const s = await setup();
    await s.visit('p1', '2027-06-10T10:00:00.000Z');
    await s.t.sync(s.net);
    await s.exclude('p1', '2027-06-20T00:00:00.000Z');
    expect((await s.open()).tasks[0]!.doNotCall).toBe(false);
  });

  it('[R17] [R18] une tâche fermée ne change plus : le même geste n’ajoute rien, un autre est refusé, et rien ne s’efface', async () => {
    const s = await setup();
    await s.visit('p1', '2027-06-10T10:00:00.000Z');
    await s.t.sync(s.net);
    const task = (await s.open()).tasks[0]!;
    const d = s.as('direction');
    expect(await s.t.close(d, task.id, 'nimporte')).toEqual({ ok: false, rule: null, code: 'bad_outcome' });
    expect(await s.t.close(d, 'inconnue', 'rappele')).toEqual({ ok: false, rule: null, code: 'unknown_task' });
    expect(await s.t.close(d, task.id, 'rappele')).toEqual({ ok: true, value: { id: task.id, outcome: 'rappele' } });
    expect(await s.t.close(d, task.id, 'rappele')).toMatchObject({ ok: true });
    expect(await s.t.close(d, task.id, 'injoignable')).toEqual({ ok: false, rule: 'R228', code: 'already_done' });
    expect((await s.journal.all()).filter((e) => e.type === 'pilotage.engagement_manque_fait')).toHaveLength(1);
    await expect(s.db.run('DELETE FROM missed_promise_tasks WHERE id = ?', [task.id])).rejects.toThrow();
    await expect(s.db.run("UPDATE missed_promise_tasks SET outcome = 'injoignable' WHERE id = ?", [task.id])).rejects.toThrow();
    expect(await s.t.sync(s.net)).toBe(0);
    expect((await s.open()).total).toBe(0);
  });

  it('[R16] la direction seule : lire et fermer sont refusés aux autres, et notés ; une tâche d’un autre réseau est inconnue', async () => {
    const s = await setup();
    await s.visit('p1', '2027-06-10T10:00:00.000Z');
    await s.t.sync(s.net);
    const task = (await s.open()).tasks[0]!;
    for (const role of ['agent', 'compliance', 'client']) {
      expect(await s.t.open(s.as(role))).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await s.t.close(s.as(role), task.id, 'rappele')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await s.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(6);
    const other = { role: 'direction', userId: 'u2', networkId: 'autre' } as Viewer;
    expect(await s.t.close(other, task.id, 'rappele')).toEqual({ ok: false, rule: null, code: 'unknown_task' });
    expect(await s.t.open(other)).toMatchObject({ ok: true, value: { total: 0, tasks: [] } });
    expect((await s.open()).total).toBe(1);
  });

  it('[R228] la lecture dit le total et rend les plus anciennes d’abord', async () => {
    const s = await setup();
    for (let i = 0; i < MISSED_PROMISE_PAGE + 2; i += 1) await s.db.run("INSERT INTO missed_promise_tasks (id, network_id, promise_code, case_key, day, created_at) VALUES (?, ?, 'point_lundi', ?, ?, ?)", [`t${String(i).padStart(3, '0')}`, s.net, `k${i}`, i === 0 ? '2027-06-02' : '2027-06-01', NOW]);
    const v = await s.open();
    expect(v.total).toBe(MISSED_PROMISE_PAGE + 2);
    expect(v.tasks).toHaveLength(MISSED_PROMISE_PAGE);
    expect(v.tasks.every((x) => x.day === '2027-06-01')).toBe(true);
  });

  it('[R228] un engagement envers l’agent se rappelle à l’agent ; une offre, au vendeur du dernier mandat du bien', async () => {
    const s = await setup();
    const A = '2027-06-10T10:00:00.000Z';
    await s.db.run("INSERT INTO commission_receipts (file_id, network_id, received_at, proof_ref, payout_due_at, recorded_by, created_at) VALUES ('f1', ?, ?, 'r', ?, 'd', ?)", [s.net, A, '2027-06-11T10:00:00.000Z', A]);
    await s.db.run("INSERT INTO sale_commissions (file_id, network_id, mandate_id, agent_id, fee_eur, due_on, status, created_at) VALUES ('f1', ?, 'm', 'agent-1', 1000, '2027-06-10', 'due', ?)", [s.net, A]);
    for (const [id, person, signed] of [['m1', 'ancien-vendeur', '2026-01-01T10:00:00.000Z'], ['m2', 'vendeur', '2027-01-01T10:00:00.000Z']] as const) {
      await s.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, 'a', ?, 'bien', ?, 'referral', 'x', ?)", [id, s.net, person, signed, signed]);
    }
    await s.db.run("INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES ('o1', ?, 'bien', 1, 'acquereur', 100, '[]', '2027-12-31', 0, 0, 'r', ?, 'a', ?, 'a', 'x', 'h')", [s.net, A, A]);
    const missed = await s.tenus.missedCases(s.net, '2027-06');
    expect(missed.find((c) => c.code === 'commission_24h')).toMatchObject({ key: 'f1', personId: null, agentId: 'agent-1' });
    expect(missed.find((c) => c.code === 'offre_jour_meme')).toMatchObject({ key: 'o1', personId: 'vendeur', agentId: null });
    await s.t.sync(s.net);
    expect((await s.open()).tasks.map((t) => t.agentId ?? t.personId).sort()).toEqual(['agent-1', 'vendeur']);
    expect((await s.open()).tasks.find((t) => t.agentId === 'agent-1')!.agentName).toBeNull();
    await s.db.run("INSERT INTO agents (id, network_id, first_name, last_name, created_at, updated_at) VALUES ('agent-1', ?, 'Inès', 'Inventée', ?, ?)", [s.net, A, A]);
    const named = (await s.open()).tasks;
    expect(named.find((t) => t.agentId === 'agent-1')!.agentName).toBe('Inès Inventée');
    expect(named.find((t) => t.personId === 'vendeur')!.agentName).toBeNull();
  });

  it('[R228] le passage de chaque heure ne crée les tâches qu’à 7 h de Paris', async () => {
    const s = await setup();
    await s.visit('p1', '2027-06-10T10:00:00.000Z');
    const job = pilotageHourlyJob(s.db, s.journal, { now: s.now });
    s.setClock('2027-07-20T04:30:00.000Z'); // 6 h 30 à Paris
    await job.run({ job: 'pilotage.passage', slot: 's', at: s.now() } as never);
    expect((await s.open()).total).toBe(0);
    s.setClock(NOW); // 7 h 30 à Paris
    await job.run({ job: 'pilotage.passage', slot: 's', at: s.now() } as never);
    expect((await s.open()).total).toBe(1);
    s.setClock('2027-07-20T06:00:00.000Z'); // 8 h à Paris
    await job.run({ job: 'pilotage.passage', slot: 's', at: s.now() } as never);
    expect((await s.open()).total).toBe(1);
  });
});
