import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { DEPARTURE_REASONS, Departs, addMonths, legalNoticeMonths } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, clients, biens et ventes inventés.
const DAY = 86_400_000;
let clock = 0;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function setup() {
  clock = Date.parse('2027-01-11T09:00:00.000Z');
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const fiches = new FicheClient(db, { now });
  const unique = new FicheUnique(db, fiches, { now });
  const acces = new Acces(db, fiches, unique, journal, { now });
  const departs = new Departs(db, journal, { now, newId: uuid });
  const net = (await fiches.createNetwork('Réseau test')).id;
  const other = (await fiches.createNetwork('Autre réseau')).id;
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: net };
  const agent = async (lastName: string, network = net): Promise<string> => (await fiches.createAgent({ networkId: network, firstName: 'Camille', lastName })).id;
  /** Un agent entré il y a `months` mois. */
  const since = async (id: string, months: number): Promise<void> => {
    const day = addMonths(new Date(clock).toISOString().slice(0, 10), -months);
    await db.run('UPDATE agents SET created_at = ? WHERE id = ?', [`${day}T09:00:00.000Z`, id]);
  };
  const leaver = await agent('Partant');
  const keeper = await agent('Restant');
  const persons: string[] = [];
  for (let i = 0; i < 6; i++) persons.push((await fiches.createPerson({ networkId: net, agentId: leaver, firstName: 'Client', lastName: `Inventé${i}` })).id);
  const theirs = (await fiches.createPerson({ networkId: net, agentId: keeper, firstName: 'Autre', lastName: 'Client' })).id;
  const props: string[] = [];
  for (let i = 0; i < 3; i++) props.push((await fiches.createProperty({ networkId: net, agentId: leaver, reference: `REF-${i}`, kind: 'home', status: i === 0 ? 'available' : 'draft' })).id);
  const today = (): string => new Date(clock).toISOString().slice(0, 10);
  const daysFrom = (d: number): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  /** Avance l'horloge au jour donné, à l'heure de Paris donnée (les jeux restent en hiver : Paris = UTC + 1). */
  const goTo = (day: string, parisHour = 9): void => {
    clock = Date.parse(`${day}T00:00:00.000Z`) + (parisHour - 1) * 3_600_000;
  };
  return { raw, db, journal, fiches, acces, departs, net, other, dir, agent, since, leaver, keeper, persons, theirs, props, today, daysFrom, goTo };
}

describeWithSqlite("Départ d'un agent (J11)", () => {
  it('calcule le préavis légal : 1 mois la première année, 2 la deuxième commencée, 3 ensuite', () => {
    expect(legalNoticeMonths('2025-01-15', '2025-01-15')).toBe(1);
    expect(legalNoticeMonths('2025-01-15', '2026-01-14')).toBe(1);
    expect(legalNoticeMonths('2025-01-15', '2026-01-15')).toBe(2);
    expect(legalNoticeMonths('2025-01-15', '2027-01-14')).toBe(2);
    expect(legalNoticeMonths('2025-01-15', '2027-01-15')).toBe(3);
    expect(legalNoticeMonths('2020-02-29', '2031-06-01')).toBe(3);
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2027-03-10', -12)).toBe('2026-03-10');
    expect(addMonths('2027-03-31', -1)).toBe('2027-02-28');
  });

  it('[R16] seule la direction range un départ ; la conformité lit ; chaque refus est au journal', async () => {
    const s = await setup();
    const asAgent = { role: 'agent' as const, userId: s.leaver, networkId: s.net };
    const compliance = { role: 'compliance' as const, userId: 'c-1', networkId: s.net };
    const input = { noticeGivenOn: s.today(), leavesOn: s.daysFrom(40), reason: 'demission_agent' };
    expect(await s.departs.schedule(asAgent, s.leaver, input)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await s.departs.schedule(compliance, s.leaver, input)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await s.departs.schedule({ ...s.dir, networkId: s.other }, s.leaver, input)).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    expect(await s.departs.queue(asAgent)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.departs.settlement(asAgent, s.leaver)).toMatchObject({ ok: false, rule: 'R16' });
    const refusals = await s.db.all<{ n: number }>("SELECT count(*) AS n FROM journal WHERE type = 'acces.refuse'");
    expect(Number(refusals[0]!.n)).toBe(5);
    expect((await s.departs.schedule(s.dir, s.leaver, input)).ok).toBe(true);
    expect(await s.departs.get(compliance, s.leaver)).toMatchObject({ ok: true, value: { agentId: s.leaver, leavesOn: input.leavesOn } });
  });

  it('refuse un préavis trop court, sauf faute grave ou accord commun, signalés ; jamais une date passée ; un seul départ', async () => {
    const s = await setup();
    await s.since(s.leaver, 30);
    const short = { noticeGivenOn: s.today(), leavesOn: s.daysFrom(60), reason: 'demission_agent' };
    expect(await s.departs.schedule(s.dir, s.leaver, short)).toMatchObject({ ok: false, code: 'notice_too_short' });
    expect(await s.departs.schedule(s.dir, s.leaver, { ...short, leavesOn: s.daysFrom(-1) })).toMatchObject({ ok: false, code: 'bad_leave_date' });
    expect(await s.departs.schedule(s.dir, s.leaver, { ...short, noticeGivenOn: s.daysFrom(1) })).toMatchObject({ ok: false, code: 'bad_notice_date' });
    expect(await s.departs.schedule(s.dir, s.leaver, { ...short, reason: 'raisons perso' })).toMatchObject({ ok: false, code: 'bad_reason' });
    expect(await s.departs.schedule(s.dir, s.leaver, { ...short, leavesOn: '2027-02-30' })).toMatchObject({ ok: false, code: 'bad_leave_date' });
    const full = await s.departs.schedule(s.dir, s.leaver, { ...short, leavesOn: addMonths(s.today(), 3) });
    expect(full).toMatchObject({ ok: true, value: { noticeMonths: 3, reducedNotice: false, indemnityToReview: false } });
    expect(await s.departs.schedule(s.dir, s.leaver, { ...short, leavesOn: addMonths(s.today(), 4) })).toMatchObject({ ok: false, code: 'already_scheduled' });

    const grave = await s.departs.schedule(s.dir, s.keeper, { noticeGivenOn: s.today(), leavesOn: s.today(), reason: 'faute_grave' });
    expect(grave).toMatchObject({ ok: true, value: { noticeMonths: 1, reducedNotice: true, indemnityToReview: false } });
  });

  it("dit, selon le motif, qu'une indemnité de fin de contrat est possible, sans jamais la chiffrer", async () => {
    const s = await setup();
    const expected: Record<string, boolean> = { demission_agent: false, fin_par_reseau: true, accord_mutuel: true, faute_grave: false, age_maladie: true, cession_successeur: false };
    for (const reason of DEPARTURE_REASONS) {
      const id = await s.agent(`Motif-${reason}`);
      const r = await s.departs.schedule(s.dir, id, { noticeGivenOn: s.today(), leavesOn: s.daysFrom(45), reason });
      if (!r.ok) throw new Error(r.code);
      expect(r.value.indemnityToReview).toBe(expected[reason]);
      expect(r.value.nextStep.includes('avocat')).toBe(expected[reason]);
      expect(JSON.stringify(r.value)).not.toMatch(/€|\d+ ?euros?/i);
    }
  });

  it('[R86] dès minuit le jour du départ, à Paris, rien ne part plus au nom de l’agent, même avant le planificateur', async () => {
    const s = await setup();
    const leavesOn = s.daysFrom(35);
    expect((await s.departs.schedule(s.dir, s.leaver, { noticeGivenOn: s.today(), leavesOn, reason: 'demission_agent' })).ok).toBe(true);
    const eve = new Date(Date.parse(`${leavesOn}T00:00:00.000Z`) - 3_600_000 - 1000); // 23:59:59 la veille, à Paris
    const midnight = new Date(Date.parse(`${leavesOn}T00:00:00.000Z`) - 3_600_000 + 1000); // 00:00:01 le jour même
    expect(await s.departs.isGone(s.net, s.leaver, eve)).toBe(false);
    expect(await s.departs.sendAllowed(s.net, { agentId: s.leaver }, eve)).toBe(true);
    expect(await s.departs.isGone(s.net, s.leaver, midnight)).toBe(true);
    expect(await s.departs.sendAllowed(s.net, { agentId: s.leaver }, midnight)).toBe(false);
    // Une relance préparée par l'agent parti, même au nom d'un autre, ne part plus.
    expect(await s.departs.sendAllowed(s.net, { agentId: s.keeper, preparedBy: s.leaver }, midnight)).toBe(false);
    expect(await s.departs.sendAllowed(s.net, { agentId: s.keeper }, midnight)).toBe(true);
    expect(await s.departs.sendAllowed(s.net, { agentId: null }, midnight)).toBe(true);
    // Un agent inconnu ou d'un autre réseau ne fait jamais partir quoi que ce soit.
    expect(await s.departs.sendAllowed(s.net, { agentId: 'inconnu' }, midnight)).toBe(false);
  });

  it('[R86] [R16] [R17] le jour venu : accès coupé, clients et biens à la direction, rien effacé, rien sans agent ni hors de la file', async () => {
    const s = await setup();
    const asAgent = { role: 'agent' as const, userId: s.leaver, networkId: s.net };
    const leavesOn = s.daysFrom(35);
    await s.departs.schedule(s.dir, s.leaver, { noticeGivenOn: s.today(), leavesOn, reason: 'demission_agent' });
    expect((await s.acces.readFiche(asAgent, s.persons[0]!)).ok).toBe(true);
    const before = await s.db.all<{ t: string; n: number }>("SELECT 'p' AS t, count(*) AS n FROM persons UNION ALL SELECT 'b', count(*) FROM properties");

    // La veille, le planificateur ne fait rien.
    s.goTo(s.daysFrom(34), 23);
    expect(await s.departs.runDue(s.net)).toEqual([]);

    s.goTo(leavesOn, 0.5);
    expect(await s.departs.runDue(s.net)).toEqual([{ agentId: s.leaver, persons: 6, properties: 3, toSuccessor: false }]);
    expect((await s.fiches.getAgent(s.leaver))!.status).toBe('left');
    // Plus aucune lecture : ni ses anciens clients, ni la liste, ni un bien [R86, R16].
    expect(await s.acces.readFiche(asAgent, s.persons[0]!)).toMatchObject({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await s.acces.listPersons(asAgent)).toMatchObject({ ok: false, code: 'agent_inactive' });
    expect(await s.acces.readProperty(asAgent, s.props[0]!)).toMatchObject({ ok: false, code: 'agent_inactive' });
    // Rien n'est effacé ; plus rien n'est chez l'agent parti ; tout est dans la file de la direction [R17, R86].
    expect(await s.db.all("SELECT 'p' AS t, count(*) AS n FROM persons UNION ALL SELECT 'b', count(*) FROM properties")).toEqual(before);
    expect(await s.db.first('SELECT count(*) AS n FROM persons WHERE agent_id = ?', [s.leaver])).toEqual({ n: 0 });
    expect(await s.db.first('SELECT count(*) AS n FROM properties WHERE agent_id = ?', [s.leaver])).toEqual({ n: 0 });
    const queue = await s.departs.queue(s.dir);
    if (!queue.ok) throw new Error(queue.code);
    expect(queue.value.filter((l) => l.kind === 'person').map((l) => l.subjectId).sort()).toEqual([...s.persons].sort());
    expect(queue.value.filter((l) => l.kind === 'property').map((l) => l.subjectId).sort()).toEqual([...s.props].sort());
    const orphans = await s.db.all<{ id: string }>(
      `SELECT id FROM persons WHERE network_id = ? AND (agent_id IS NULL OR agent_id IN (SELECT id FROM agents WHERE status = 'left'))
       AND id NOT IN (SELECT subject_id FROM agent_departure_handovers WHERE kind = 'person')`,
      [s.net],
    );
    expect(orphans).toEqual([]);
    expect((await s.fiches.getPerson(s.theirs))!.agent_id).toBe(s.keeper);

    // Relancé, le passage ne change rien et ne journalise rien de plus.
    const events = await s.db.first<{ n: number }>("SELECT count(*) AS n FROM journal WHERE type = 'agent.parti'");
    expect(await s.departs.runDue(s.net)).toEqual([]);
    expect(await s.db.first("SELECT count(*) AS n FROM journal WHERE type = 'agent.parti'")).toEqual(events);
    expect(events).toEqual({ n: 1 });
    // Un départ fait ne s'annule plus ; ses lignes ne s'effacent pas.
    expect(await s.departs.cancel(s.dir, s.leaver)).toMatchObject({ ok: false });
    expect(() => s.raw.exec('DELETE FROM agent_departure_handovers')).toThrow(/rien ne s'efface/);
    expect(() => s.raw.exec("UPDATE agent_departures SET leaves_on = '2030-01-01'")).toThrow(/ne change plus/);
    expect(await s.departs.schedule(s.dir, s.leaver, { noticeGivenOn: s.today(), leavesOn: s.daysFrom(40), reason: 'demission_agent' })).toMatchObject({ ok: false, code: 'already_left' });

    // Le journal ne porte ni nom ni coordonnée, et sa chaîne tient [R13].
    const entries = await s.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/Inventé|Partant|Camille/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('[R86] la direction réattribue depuis sa file, une fois, à un agent en activité seulement', async () => {
    const s = await setup();
    const leavesOn = s.daysFrom(35);
    await s.departs.schedule(s.dir, s.leaver, { noticeGivenOn: s.today(), leavesOn, reason: 'demission_agent' });
    s.goTo(leavesOn);
    await s.departs.runDue(s.net);
    const p = s.persons[0]!;
    expect(await s.departs.reassign(s.dir, { kind: 'person', subjectId: p, toAgentId: s.leaver })).toMatchObject({ ok: false, code: 'bad_agent' });
    const foreign = await s.agent('Ailleurs', s.other);
    expect(await s.departs.reassign(s.dir, { kind: 'person', subjectId: p, toAgentId: foreign })).toMatchObject({ ok: false, code: 'bad_agent' });
    expect(await s.departs.reassign({ role: 'agent', userId: s.keeper, networkId: s.net }, { kind: 'person', subjectId: p, toAgentId: s.keeper })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.departs.reassign(s.dir, { kind: 'person', subjectId: s.theirs, toAgentId: s.keeper })).toMatchObject({ ok: false, code: 'not_in_queue' });
    expect(await s.departs.reassign(s.dir, { kind: 'person', subjectId: p, toAgentId: s.keeper })).toEqual({ ok: true });
    expect((await s.fiches.getPerson(p))!.agent_id).toBe(s.keeper);
    expect(await s.departs.reassign(s.dir, { kind: 'person', subjectId: p, toAgentId: s.keeper })).toMatchObject({ ok: false, code: 'not_in_queue' });
    expect(await s.departs.reassign(s.dir, { kind: 'property', subjectId: s.props[1]!, toAgentId: s.keeper })).toEqual({ ok: true });
    const queue = await s.departs.queue(s.dir);
    if (!queue.ok) throw new Error(queue.code);
    expect(queue.value).toHaveLength(7);
    expect(queue.value.some((l) => l.subjectId === p || l.subjectId === s.props[1])).toBe(false);
    // Un agent dont le départ est venu ne reçoit plus rien, même avant le planificateur.
    const soon = await s.agent('Bientôt');
    await s.departs.schedule(s.dir, soon, { noticeGivenOn: s.today(), leavesOn: s.today(), reason: 'faute_grave' });
    expect(await s.departs.reassign(s.dir, { kind: 'person', subjectId: s.persons[1]!, toAgentId: soon })).toMatchObject({ ok: false, code: 'bad_agent' });
  });

  it("[R86] un successeur présenté ne reprend les clients qu'avec l'accord du réseau", async () => {
    const s = await setup();
    const heir = await s.agent('Successeur');
    const leavesOn = s.daysFrom(35);
    await s.departs.schedule(s.dir, s.leaver, { noticeGivenOn: s.today(), leavesOn, reason: 'cession_successeur' });
    expect(await s.departs.presentSuccessor(s.dir, s.leaver, s.leaver)).toMatchObject({ ok: false, code: 'bad_successor' });
    expect(await s.departs.presentSuccessor(s.dir, s.leaver, await s.agent('Ailleurs', s.other))).toMatchObject({ ok: false, code: 'bad_successor' });
    expect(await s.departs.decideSuccessor(s.dir, s.leaver, true)).toMatchObject({ ok: false, code: 'no_successor' });
    expect(await s.departs.presentSuccessor(s.dir, s.leaver, heir)).toMatchObject({ ok: true, value: { successor: { agentId: heir, status: 'presente' } } });
    expect(await s.departs.decideSuccessor({ role: 'agent', userId: heir, networkId: s.net }, s.leaver, true)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.departs.decideSuccessor(s.dir, s.leaver, true)).toMatchObject({ ok: true, value: { successor: { status: 'accepte' } } });
    expect(await s.departs.decideSuccessor(s.dir, s.leaver, false)).toMatchObject({ ok: false, code: 'already_decided' });
    expect(await s.departs.presentSuccessor(s.dir, s.leaver, s.keeper)).toMatchObject({ ok: false, code: 'already_decided' });
    s.goTo(leavesOn);
    expect(await s.departs.runDue(s.net)).toEqual([{ agentId: s.leaver, persons: 6, properties: 3, toSuccessor: true }]);
    for (const p of s.persons) expect((await s.fiches.getPerson(p))!.agent_id).toBe(heir);
    for (const b of s.props) expect((await s.fiches.getProperty(b))!.agent_id).toBe(heir);
    expect(await s.departs.queue(s.dir)).toMatchObject({ ok: true, value: [] });
  });

  it('[R86] un successeur refusé, ou parti entre-temps, laisse tout à la direction', async () => {
    const s = await setup();
    const heir = await s.agent('Successeur');
    const leavesOn = s.daysFrom(35);
    await s.departs.schedule(s.dir, s.leaver, { noticeGivenOn: s.today(), leavesOn, reason: 'demission_agent' });
    await s.departs.presentSuccessor(s.dir, s.leaver, heir);
    await s.departs.decideSuccessor(s.dir, s.leaver, true);
    // Le successeur accepté part avant : il ne reçoit rien.
    await s.departs.schedule(s.dir, heir, { noticeGivenOn: s.today(), leavesOn: s.daysFrom(1), reason: 'faute_grave' });
    s.goTo(leavesOn);
    const done = await s.departs.runDue(s.net);
    expect(done.find((d) => d.agentId === s.leaver)).toMatchObject({ toSuccessor: false });
    for (const p of s.persons) expect((await s.fiches.getPerson(p))!.agent_id).toBeNull();

    const t = await setup();
    const other = await t.agent('Refusé');
    await t.departs.schedule(t.dir, t.leaver, { noticeGivenOn: t.today(), leavesOn: t.daysFrom(35), reason: 'demission_agent' });
    await t.departs.presentSuccessor(t.dir, t.leaver, other);
    expect(await t.departs.decideSuccessor(t.dir, t.leaver, false)).toMatchObject({ ok: true, value: { successor: { status: 'refuse' } } });
    t.goTo(t.daysFrom(35));
    expect(await t.departs.runDue(t.net)).toEqual([{ agentId: t.leaver, persons: 6, properties: 3, toSuccessor: false }]);
  });

  it("une annulation avant le jour garde la ligne et laisse l'agent en activité ; le jour venu, trop tard", async () => {
    const s = await setup();
    const leavesOn = s.daysFrom(35);
    await s.departs.schedule(s.dir, s.leaver, { noticeGivenOn: s.today(), leavesOn, reason: 'demission_agent' });
    expect(await s.departs.cancel(s.dir, s.leaver)).toEqual({ ok: true });
    expect(await s.db.first('SELECT count(*) AS n FROM agent_departures')).toEqual({ n: 1 });
    s.goTo(leavesOn);
    expect(await s.departs.isGone(s.net, s.leaver, new Date(clock))).toBe(false);
    expect(await s.departs.runDue(s.net)).toEqual([]);
    expect((await s.fiches.getAgent(s.leaver))!.status).toBe('active');
    await s.departs.schedule(s.dir, s.leaver, { noticeGivenOn: s.today(), leavesOn: s.today(), reason: 'faute_grave' });
    expect(await s.departs.cancel(s.dir, s.leaver)).toMatchObject({ ok: false, rule: 'R86', code: 'too_late' });
    expect(await s.departs.presentSuccessor(s.dir, s.leaver, s.keeper)).toMatchObject({ ok: false, code: 'too_late' });
  });

  it('liste les commissions à solder et les contenus à rendre, sans les commissions payées', async () => {
    const s = await setup();
    // Des ventes inventées, rangées directement : seules leurs étapes comptent ici.
    s.raw.exec('PRAGMA foreign_keys = OFF');
    const sale = (file: string, agentId: string, fee: number, share: number, steps: string[], partner?: [string, number]): void => {
      s.raw.prepare('INSERT INTO commissions (file_id, network_id, agent_id, mandate_id, compromis_on, fee_cents, fee_charge, grid_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)').run(file, s.net, agentId, 'm', '2027-01-10', fee, 'g', 'x');
      s.raw.prepare("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, 1, 'reseau', NULL, NULL, ?)").run(file, fee - share - (partner?.[1] ?? 0));
      s.raw.prepare("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, 2, 'agent', ?, NULL, ?)").run(file, agentId, share);
      if (partner) s.raw.prepare("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, 3, 'partage', ?, 'binome', ?)").run(file, partner[0], partner[1]);
      for (const st of steps) s.raw.prepare('INSERT INTO commission_steps (file_id, status, proof_ref, at, by) VALUES (?, ?, ?, ?, ?)').run(file, st, 'p', 'x', 'x');
    };
    sale('f1', s.leaver, 1_000_000, 700_000, ['prevue']);
    sale('f2', s.leaver, 800_000, 560_000, ['prevue', 'due', 'facturee']);
    sale('f3', s.leaver, 900_000, 630_000, ['prevue', 'due', 'facturee', 'payee']);
    sale('f4', s.keeper, 1_200_000, 600_000, ['prevue', 'due'], [s.leaver, 240_000]);
    sale('f5', s.keeper, 500_000, 350_000, ['prevue']);
    s.raw.prepare("INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES (?, ?, ?, 'assurance_rcp', ?, ?, '2027-01-01', '2028-01-01', 0, 'x', 'x')").run('k1', s.net, s.leaver, 1, `agents/${s.leaver}/a.pdf`);
    s.raw.prepare("INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES (?, ?, ?, 'assurance_rcp', ?, ?, '2027-02-01', '2028-02-01', 0, 'x', 'x')").run('k2', s.net, s.leaver, 2, `agents/${s.leaver}/b.pdf`);
    s.raw.prepare("INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES (?, ?, ?, 'contrat_agent_commercial', 1, ?, '2027-01-01', NULL, 1, 'x', 'x')").run('k3', s.net, s.leaver, `agents/${s.leaver}/c.txt`);
    s.raw.prepare("INSERT INTO academy_sessions (id, network_id, kind, title, held_on, duration_minutes, topic, mandatory, created_by, created_at) VALUES ('s1', ?, 'salle', 'Séance test', '2027-02-01', 120, 'general', 0, 'x', 'x')").run(s.net);
    s.raw.prepare("INSERT INTO academy_attendance (session_id, agent_id, network_id, recorded_by, recorder_name, recorded_at) VALUES ('s1', ?, ?, 'x', 'Direction', 'x')").run(s.leaver, s.net);
    s.raw.exec('PRAGMA foreign_keys = ON');

    const due = await s.departs.settlement(s.dir, s.leaver);
    expect(due).toEqual({
      ok: true,
      value: [
        { fileId: 'f1', status: 'prevue', feeCents: 1_000_000, agentShareCents: 700_000 },
        { fileId: 'f2', status: 'facturee', feeCents: 800_000, agentShareCents: 560_000 },
        { fileId: 'f4', status: 'due', feeCents: 1_200_000, agentShareCents: 240_000 },
      ],
    });
    const mine = await s.departs.personalContents(s.dir, s.leaver);
    expect(mine).toEqual({ ok: true, value: { pieces: [{ kind: 'assurance_rcp', version: 2, ref: `agents/${s.leaver}/b.pdf` }], trainingMinutes: 120 } });
    expect(await s.departs.personalContents({ role: 'agent', userId: s.leaver, networkId: s.net }, s.leaver)).toMatchObject({ ok: false, rule: 'R16' });
    expect(JSON.stringify(await s.db.all("SELECT * FROM journal WHERE type LIKE 'agent_depart.%'"))).not.toContain('.pdf');
  });
});
