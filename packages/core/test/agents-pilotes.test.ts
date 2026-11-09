import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, RegistreMandats, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { AgentsPilotes, measureStartOf, pilotCondition, pilotStatus, type PilotReport } from '../src/conditions-phases/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau d'essai, agents, clients, registre au préfixe « P- », références de preuve.
// Les pilotes arrivent le 10 août 2027 : avant = mai, juin, juillet ; après = septembre, octobre, novembre ; la mesure
// commence le 1er septembre à minuit de Paris (2027-08-31T22:00Z) et finit avec novembre.
const ARRIVAL = '2027-08-10T09:00:00.000Z';
const MEASURE_START = '2027-08-31T22:00:00.000Z';

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-07-01T10:00:00.000Z');
  const now = (): Date => new Date(clock);
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const mandats = new Mandats(db, fiche, journal, { now });
  const registre = new RegistreMandats(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1');
  const configured = await registre.configure(direction, { prefix: 'P-', firstNumber: 1, width: 5 });
  if (!configured.ok) throw new Error(configured.code);
  setClock(ARRIVAL);
  const agent = async (name: string, networkId = network.id) => (await store.createAgent({ networkId, firstName: name, lastName: 'Pilote' })).id;
  const pilotes = new AgentsPilotes(db, journal, { now });
  let count = 0;
  /** Un mandat signé à cet instant (l'horloge y est posée), sans l'inscrire. */
  const signed = async (at: string, agentId: string): Promise<string> => {
    setClock(at);
    count += 1;
    const p = await store.createPerson({ networkId: network.id, agentId, firstName: `Client${count}` });
    const r = await mandats.record(acces, as('agent', agentId), { personId: p.id, signedAt: new Date(at), source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    return r.id;
  };
  const inscribed = async (at: string, agentId: string): Promise<string> => {
    const id = await signed(at, agentId);
    const r = await registre.inscribe(as('agent', agentId), id);
    if (!r.ok) throw new Error(r.code);
    return id;
  };
  /** `n` mandats inscrits le 10 d'un mois, une minute d'écart. */
  const fill = async (month: string, n: number, agentId: string) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await inscribed(`${month}-10T10:${String(i).padStart(2, '0')}:00.000Z`, agentId));
    return ids;
  };
  /** Désigne et déclare l'avant, à l'heure posée (avant la mesure par défaut). */
  const pilot = async (agentId: string, months: [number, number, number], at = '2027-08-20T10:00:00.000Z') => {
    setClock(at);
    const d = await pilotes.designate(direction, { agentId });
    if (!d.ok) throw new Error(d.code);
    const b = await pilotes.declareBefore(direction, { agentId, months, proofRef: `stockage/registres/${agentId}.pdf` });
    if (!b.ok) throw new Error(b.code);
    return b.value;
  };
  const report = async (at = '2027-12-16T10:00:00.000Z') => {
    setClock(at);
    const r = await pilotes.report(direction);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((e) => JSON.parse(e.data) as Record<string, unknown>);
  return { raw, db, journal, registre, network, other, as, direction, setClock, agent, pilotes, signed, inscribed, fill, pilot, report, events };
}

describeWithSqlite('HX69 · les agents pilotes signent-ils plus qu’avant leur arrivée', () => {
  it('[R640] la mesure commence le 1er du mois de Paris qui suit l’arrivée', () => {
    expect(measureStartOf(ARRIVAL)).toBe(MEASURE_START);
    // Le 31 août à 23 h 30 de Paris est encore août ; le 31 août à 22 h 30 UTC est déjà septembre à Paris.
    expect(measureStartOf('2027-08-31T21:30:00.000Z')).toBe(MEASURE_START);
    expect(measureStartOf('2027-08-31T22:30:00.000Z')).toBe('2027-09-30T22:00:00.000Z');
    expect(measureStartOf('2027-12-05T10:00:00.000Z')).toBe('2027-12-31T23:00:00.000Z');
  });

  it('[R641] seuls les mandats inscrits du pilote, signés dans ses 3 mois d’après, comptent ; le mois d’arrivée est à part', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    const sam = await t.agent('Sam');
    await t.pilot(alex, [1, 1, 1]);
    await t.inscribed('2027-08-25T10:00:00.000Z', alex); // mois d'arrivée : à part
    await t.fill('2027-09', 2, alex);
    await t.fill('2027-10', 1, alex);
    await t.signed('2027-10-20T10:00:00.000Z', alex); // signé, jamais inscrit : ne compte pas
    await t.inscribed('2027-11-30T22:30:00.000Z', alex); // 30 novembre 23 h 30 de Paris : compte en novembre
    await t.inscribed('2027-11-30T23:30:00.000Z', alex); // déjà décembre à Paris : hors mesure
    await t.fill('2027-09', 3, sam); // un autre agent, qui n'est pas pilote
    const r = await t.report();
    expect(r.pilots).toHaveLength(1);
    const p = r.pilots[0]!;
    expect(p.arrivalMonth).toBe('2027-08');
    expect(p.beforeMonths).toEqual(['2027-05', '2027-06', '2027-07']);
    expect(p.after).toEqual([
      { month: '2027-09', counted: 2 },
      { month: '2027-10', counted: 1 },
      { month: '2027-11', counted: 1 },
    ]);
    expect(p.afterTotal).toBe(4);
    expect(p.arrivalMonthCounted).toBe(1);
    expect(p.lines.map((l) => l.number)).toEqual(['P-00002', 'P-00003', 'P-00004', 'P-00005']);
    expect(p.lines.every((l) => /^[0-9a-f]{64}$/.test(l.hash))).toBe(true);
  }, 60_000);

  it('[R641] une erreur et une rétractation retirent le mandat ; une résiliation le laisse compter, et se voit', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    await t.pilot(alex, [0, 0, 1]);
    const [a, b, c] = await t.fill('2027-09', 4, alex);
    t.setClock('2027-10-02T10:00:00.000Z');
    for (const [id, reason] of [[a, 'error'], [b, 'withdrawal'], [c, 'termination']] as const) {
      const r = await t.registre.cancel(t.as('agent', alex), id!, reason);
      if (!r.ok) throw new Error(r.code);
    }
    const r = await t.report();
    const p = r.pilots[0]!;
    expect(p.afterTotal).toBe(2);
    expect(p.withdrawnOrCancelled).toBe(2);
    expect(p.lines.filter((l) => l.terminated)).toHaveLength(1);
    expect(p.status).toBe('plus');
  }, 60_000);

  it('[R640] la déclaration d’avant : trois entiers et une référence de preuve, sinon rien n’est rangé', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    const d = await t.pilotes.designate(t.direction, { agentId: alex });
    expect(d.ok).toBe(true);
    const bad: unknown[] = [
      { agentId: alex, months: [1, 2], proofRef: 'stockage/a.pdf' },
      { agentId: alex, months: [1, 2, -1], proofRef: 'stockage/a.pdf' },
      { agentId: alex, months: [1, 2, 501], proofRef: 'stockage/a.pdf' },
      { agentId: alex, months: [1, 2, 1.5], proofRef: 'stockage/a.pdf' },
      { agentId: alex, months: ['1', 2, 3], proofRef: 'stockage/a.pdf' },
      { agentId: alex, months: [1, 2, 3], proofRef: 'une preuve' },
      { agentId: alex, months: [1, 2, 3], proofRef: 'stockage/../a.pdf' },
      { agentId: alex, months: [1, 2, 3] },
    ];
    for (const input of bad) {
      const r = await t.pilotes.declareBefore(t.direction, input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.rule).toBe('R640');
    }
    const extra = await t.pilotes.declareBefore(t.direction, { agentId: alex, months: [1, 2, 3], proofRef: 'stockage/a.pdf', total: 6 });
    expect(extra).toEqual({ ok: false, rule: null, code: 'unknown_field' });
    const sam = await t.agent('Sam');
    expect(await t.pilotes.declareBefore(t.direction, { agentId: sam, months: [1, 2, 3], proofRef: 'stockage/a.pdf' })).toEqual({ ok: false, rule: 'R640', code: 'pas_pilote' });
    expect((await t.db.all('SELECT * FROM pilot_before_declarations')).length).toBe(0);
    expect(await t.events('agents_pilotes.refuse')).toHaveLength(bad.length + 2);
  }, 60_000);

  it('[R640] [R17] les versions se suivent, rien ne change ni ne s’efface, la base refuse le reste', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    await t.pilot(alex, [1, 1, 1]);
    const v2 = await t.pilotes.declareBefore(t.direction, { agentId: alex, months: [2, 1, 1], proofRef: 'stockage/b.pdf' });
    expect(v2).toEqual({ ok: true, value: { agentId: alex, version: 2, inTime: true } });
    await expect(t.db.run('UPDATE pilot_before_declarations SET month_1 = 0 WHERE version = 1')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM pilot_before_declarations')).rejects.toThrow();
    await expect(
      t.db.run("INSERT INTO pilot_before_declarations (network_id, agent_id, version, month_1, month_2, month_3, proof_ref, declared_by, declared_at) VALUES (?, ?, 4, 0, 0, 0, 'stockage/c.pdf', 'direction:x', 'x')", [t.network.id, alex]),
    ).rejects.toThrow();
    await expect(
      t.db.run("INSERT INTO pilot_before_declarations (network_id, agent_id, version, month_1, month_2, month_3, proof_ref, declared_by, declared_at) VALUES (?, ?, 3, 0, 0, 0, 'stockage/c.pdf', 'agent:x', 'x')", [t.network.id, alex]),
    ).rejects.toThrow();
    await expect(t.db.run('DELETE FROM pilot_agents')).rejects.toThrow();
    await expect(t.db.run("UPDATE pilot_agents SET designated_by = 'direction:autre'")).rejects.toThrow();
    // La dernière version rangée à temps compte.
    const r = await t.report();
    expect(r.pilots[0]!.before).toEqual([2, 1, 1]);
    expect(r.pilots[0]!.declarations.map((d) => [d.version, d.counts])).toEqual([
      [1, false],
      [2, true],
    ]);
  }, 60_000);

  it('[R640] une version rangée après le début de la mesure est gardée, montrée, et ne compte jamais (Jamais vu)', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    await t.pilot(alex, [3, 3, 3]);
    await t.fill('2027-09', 4, alex);
    // Au premier instant de la mesure, il est trop tard : baisser l'avant ne sert à rien.
    t.setClock(MEASURE_START);
    const late = await t.pilotes.declareBefore(t.direction, { agentId: alex, months: [0, 1, 0], proofRef: 'stockage/tard.pdf' });
    expect(late).toEqual({ ok: true, value: { agentId: alex, version: 2, inTime: false } });
    const r = await t.report();
    const p = r.pilots[0]!;
    expect(p.before).toEqual([3, 3, 3]);
    expect(p.beforeTotal).toBe(9);
    expect(p.declarations).toMatchObject([
      { version: 1, inTime: true, counts: true },
      { version: 2, inTime: false, counts: false, months: [0, 1, 0], proofRef: 'stockage/tard.pdf' },
    ]);
    expect(p.status).toBe('pas_plus');
    // Sans aucune version à temps, le pilote fini est « avant non déclaré à temps », jamais « plus ».
    t.setClock(ARRIVAL);
    const sam = await t.agent('Sam');
    t.setClock('2027-08-20T10:00:00.000Z');
    expect((await t.pilotes.designate(t.direction, { agentId: sam })).ok).toBe(true);
    await t.fill('2027-10', 5, sam);
    t.setClock('2027-09-15T10:00:00.000Z');
    expect((await t.pilotes.declareBefore(t.direction, { agentId: sam, months: [0, 0, 0], proofRef: 'stockage/sam.pdf' })).ok).toBe(true);
    const s = (await t.report()).pilots.find((x) => x.agentId === sam)!;
    expect(s.before).toBeNull();
    expect(s.status).toBe('avant_non_declare');
  }, 60_000);

  it('[R642] « en cours » jusqu’à la fin du 3e mois, « plus » seulement strictement, « parti » avant la fin', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    const sam = await t.agent('Sam');
    const lou = await t.agent('Lou');
    await t.pilot(alex, [1, 1, 1]);
    await t.pilot(sam, [1, 1, 1]);
    await t.pilot(lou, [0, 0, 0]);
    await t.fill('2027-09', 4, alex);
    await t.fill('2027-10', 3, sam);
    await t.fill('2027-09', 5, lou);
    // Lou part le 15 novembre : avant la fin de sa mesure.
    t.setClock('2027-10-01T10:00:00.000Z');
    await t.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('dep-1', ?, ?, '2027-10-01', '2027-11-15', 'demission_agent', 1, 'direction:x', '2027-10-01T10:00:00.000Z')",
      [t.network.id, lou],
    );
    const order = (r: PilotReport) => [alex, sam, lou].map((id) => r.pilots.find((p) => p.agentId === id)!);
    let r = await t.report('2027-11-30T10:00:00.000Z');
    expect(order(r).map((p) => p.status)).toEqual(['en_cours', 'en_cours', 'parti']);
    r = await t.report('2027-12-14T10:00:00.000Z');
    // Jusqu'au 14 décembre, un mandat de novembre peut encore être rétracté : rien n'est fini.
    expect(order(r).map((p) => p.status)).toEqual(['en_cours', 'en_cours', 'parti']);
    expect(order(r)[0]!.finishedOn).toBe('2027-12-15');
    r = await t.report('2027-12-15T10:00:00.000Z');
    expect(order(r).map((p) => [p.status, p.beforeTotal, p.afterTotal])).toEqual([
      ['plus', 3, 4],
      ['pas_plus', 3, 3],
      ['parti', 0, 5],
    ]);
    // Un départ annulé ne compte pas ; une fiche « partie » sans départ rangé, si.
    expect(pilotStatus({ gone: false, finished: true, beforeTotal: 3, afterTotal: 3 })).toBe('pas_plus');
    expect(pilotStatus({ gone: true, finished: true, beforeTotal: 0, afterTotal: 9 })).toBe('parti');
    expect(pilotStatus({ gone: false, finished: false, beforeTotal: 0, afterTotal: 9 })).toBe('en_cours');
    expect(pilotStatus({ gone: false, finished: true, beforeTotal: null, afterTotal: 9 })).toBe('avant_non_declare');
  }, 60_000);

  it('[R642] la condition : au moins 3 pilotes, tous finis et tous « plus », registre sain', async () => {
    const t = await setup();
    const ids = [await t.agent('Alex'), await t.agent('Sam'), await t.agent('Lou')];
    for (const id of ids) await t.pilot(id, [1, 0, 1]);
    await t.fill('2027-09', 3, ids[0]!);
    await t.fill('2027-10', 3, ids[1]!);
    let r = await t.report('2027-11-15T10:00:00.000Z');
    expect(r.condition).toEqual({ met: false, reasons: ['pilote_en_cours'] });
    await t.fill('2027-11', 3, ids[2]!);
    r = await t.report();
    expect(r.registerSound).toBe(true);
    expect(r.condition).toEqual({ met: true, reasons: [] });
    // Le registre abîmé : la condition n'est plus dite remplie.
    t.raw.exec('DROP TRIGGER mandate_register_sans_modification');
    await t.db.run("UPDATE mandate_register SET signed_at = '2027-09-10T10:30:00.000Z' WHERE seq = 1");
    r = await t.report();
    expect(r.registerSound).toBe(false);
    expect(r.condition).toEqual({ met: false, reasons: ['registre_abime'] });
    expect(pilotCondition(['plus', 'plus'], true)).toEqual({ met: false, reasons: ['moins_de_3_pilotes'] });
    expect(pilotCondition(['plus', 'plus', 'pas_plus', 'avant_non_declare', 'parti'], true)).toEqual({ met: false, reasons: ['pilote_parti', 'avant_non_declare', 'pas_plus'] });
    expect(pilotCondition([], false)).toEqual({ met: false, reasons: ['moins_de_3_pilotes', 'registre_abime'] });
  }, 60_000);

  it('[R642] une rétractation rangée dans les 14 jours après la mesure défait un « plus » qui n’était pas encore dit', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    await t.pilot(alex, [1, 1, 1]);
    await t.fill('2027-10', 3, alex);
    const late = await t.inscribed('2027-11-28T10:00:00.000Z', alex);
    expect((await t.report('2027-12-09T10:00:00.000Z')).pilots[0]).toMatchObject({ status: 'en_cours', afterTotal: 4 });
    // Rétractation rangée sans ligne d'annulation au registre : elle retire quand même le mandat.
    await t.db.run('INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      late,
      t.network.id,
      'preuve inventée',
      '2027-12-10T10:00:00.000Z',
      'x',
      '2027-12-10T10:00:00.000Z',
    ]);
    const r = await t.report('2027-12-15T10:00:00.000Z');
    expect(r.pilots[0]).toMatchObject({ status: 'pas_plus', afterTotal: 3, withdrawnOrCancelled: 1 });
  }, 60_000);

  it('[R642] un délai de rétractation qui finit un dimanche ou un jour férié est prolongé, la mesure aussi', async () => {
    const t = await setup();
    // Arrivée en octobre 2026 : mesure de novembre 2026 à janvier 2027 ; le 31 janvier + 14 jours tombe le dimanche
    // 14 février, prolongé au lundi 15 : la mesure n'est finie que le 16.
    t.setClock('2026-10-05T09:00:00.000Z');
    const alex = await t.agent('Alex');
    await t.pilot(alex, [0, 0, 0], '2026-10-20T10:00:00.000Z');
    await t.fill('2026-12', 1, alex);
    expect((await t.report('2027-02-15T20:00:00.000Z')).pilots[0]).toMatchObject({ status: 'en_cours', finishedOn: '2027-02-16' });
    expect((await t.report('2027-02-16T08:00:00.000Z')).pilots[0]).toMatchObject({ status: 'plus' });
  }, 60_000);

  it('[R642] « parti » se lit dans la base : départ annulé, fiche partie, départ après la mesure, départ pas encore atteint', async () => {
    const t = await setup();
    const annule = await t.agent('Annule');
    const fiche = await t.agent('Fiche');
    const apres = await t.agent('Apres');
    const bientot = await t.agent('Bientot');
    for (const id of [annule, fiche, apres, bientot]) await t.pilot(id, [0, 0, 0]);
    for (const id of [annule, fiche, apres, bientot]) await t.fill('2027-09', 1, id);
    const depart = (id: string, agentId: string, leavesOn: string, cancelled: string | null) =>
      t.db.run(
        "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at, cancelled_at, cancelled_by) VALUES (?, ?, ?, '2027-10-01', ?, 'demission_agent', 1, 'direction:x', '2027-10-01T10:00:00.000Z', ?, ?)",
        [id, t.network.id, agentId, leavesOn, cancelled, cancelled ? 'direction:x' : null],
      );
    await depart('d-annule', annule, '2027-11-01', '2027-10-15T10:00:00.000Z');
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [fiche]);
    await depart('d-apres', apres, '2027-12-01', null);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [apres]);
    await depart('d-bientot', bientot, '2027-11-20', null);
    const status = (r: PilotReport, id: string) => r.pilots.find((p) => p.agentId === id)!.status;
    let r = await t.report('2027-11-10T10:00:00.000Z');
    expect([annule, fiche, apres, bientot].map((id) => status(r, id))).toEqual(['en_cours', 'parti', 'en_cours', 'en_cours']);
    r = await t.report('2027-12-15T10:00:00.000Z');
    expect([annule, fiche, apres, bientot].map((id) => status(r, id))).toEqual(['plus', 'parti', 'plus', 'parti']);
  }, 60_000);

  it('[R14] les pilotes se lisent dans l’ordre de leur arrivée, jamais dans l’ordre d’un nombre', async () => {
    const t = await setup();
    const first = await t.agent('Premier');
    t.setClock('2027-08-12T09:00:00.000Z');
    const second = await t.agent('Second');
    t.setClock('2027-08-14T09:00:00.000Z');
    const third = await t.agent('Troisième');
    for (const id of [third, first, second]) await t.pilot(id, [0, 0, 0]);
    await t.fill('2027-09', 1, first);
    await t.fill('2027-09', 5, third);
    await t.fill('2027-09', 3, second);
    const r = await t.report();
    expect(r.pilots.map((p) => p.agentId)).toEqual([first, second, third]);
    // Ni nom, ni rang dans le compte rendu.
    expect(JSON.stringify(r)).not.toMatch(/Premier|Second|Troisième|rank|rang/);
  }, 60_000);

  it('[R16] la direction seule désigne, déclare et lit ; refus et lecture au journal', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    for (const role of ['agent', 'compliance', 'partner', 'client']) {
      const v = t.as(role, alex);
      expect(await t.pilotes.designate(v, { agentId: alex })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.pilotes.declareBefore(v, { agentId: alex, months: [9, 9, 9], proofRef: 'stockage/a.pdf' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.pilotes.report(v)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.events('acces.refuse')).filter((e) => e.rule === 'R16')).toHaveLength(12);
    expect((await t.db.all('SELECT * FROM pilot_agents')).length).toBe(0);
    await t.report();
    const reads = await t.events('agents_pilotes.lecture');
    expect(reads).toEqual([{ rule: 'R16', pilots: 0, met: false }]);
    // Le journal ne porte ni les nombres ni la preuve d'une déclaration.
    await t.pilot(alex, [7, 8, 9]);
    const saved = JSON.stringify(await t.events('agents_pilotes.avant_range'));
    expect(saved).not.toMatch(/stockage|7|8|9/);
  }, 60_000);

  it('[R640] désigner : un agent actif du réseau, une seule fois', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    const ailleurs = await t.agent('Ailleurs', t.other.id);
    const parti = await t.agent('Parti');
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [parti]);
    expect(await t.pilotes.designate(t.direction, { agentId: ailleurs })).toEqual({ ok: false, rule: 'R640', code: 'agent_inconnu' });
    expect(await t.pilotes.designate(t.direction, { agentId: 'personne' })).toEqual({ ok: false, rule: 'R640', code: 'agent_inconnu' });
    expect(await t.pilotes.designate(t.direction, { agentId: parti })).toEqual({ ok: false, rule: 'R640', code: 'agent_parti' });
    expect(await t.pilotes.designate(t.direction, { agentId: alex })).toEqual({ ok: true, value: { agentId: alex } });
    expect(await t.pilotes.designate(t.direction, { agentId: alex })).toEqual({ ok: false, rule: 'R640', code: 'deja_pilote' });
    // Une fois sa mesure commencée, un agent ne se désigne plus : aucun avant ne pourrait compter.
    t.setClock(ARRIVAL);
    const tard = await t.agent('Tard');
    t.setClock(MEASURE_START);
    expect(await t.pilotes.designate(t.direction, { agentId: tard })).toEqual({ ok: false, rule: 'R640', code: 'trop_tard' });
    expect(await t.pilotes.designate(t.direction, { agentId: alex, note: 'x' })).toEqual({ ok: false, rule: null, code: 'unknown_field' });
    expect(await t.pilotes.designate(t.direction, null)).toEqual({ ok: false, rule: null, code: 'bad_shape' });
    // Un pilote d'un autre réseau ne se lit jamais.
    const r = await t.report();
    expect(r.pilots.map((p) => p.agentId)).toEqual([alex]);
  }, 60_000);

  it('[R640] l’arrivée est l’entrée du candidat devenu agent, sinon la création de sa fiche', async () => {
    const t = await setup();
    const alex = await t.agent('Alex');
    await t.raw.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO agent_onboardings (agent_id, network_id, candidate_id, created_by, created_at) VALUES (?, ?, 'cand-1', 'direction:x', '2027-10-05T08:00:00.000Z')", [alex, t.network.id]);
    await t.raw.exec('PRAGMA foreign_keys = ON');
    await t.pilot(alex, [0, 0, 0]);
    const r = await t.report('2028-02-01T10:00:00.000Z');
    expect(r.pilots[0]).toMatchObject({ arrivalMonth: '2027-10', beforeMonths: ['2027-07', '2027-08', '2027-09'], measureEndMonth: '2028-01' });
  }, 60_000);
});
