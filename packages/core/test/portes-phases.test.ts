import { expect, it } from 'vitest';
import { FicheClient, SCHEDULER_JOURNAL_TYPE, SqlJournalStore, appendEvent, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import {
  ConditionPhase1,
  PortesPhases,
  phase4Condition,
  phase4Months,
  phaseConditionHash,
  type GatedPhase,
  type PhaseConditionReading,
  type PhaseConditionSources,
  type PhasesReport,
} from '../src/conditions-phases/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau d'essai, utilisateurs, références de preuve.
const PROOF = 'stockage/phase1/capture-automatisations.png';
const met = (evidence: Record<string, unknown> = { n: 1 }): PhaseConditionReading => ({ met: true, reasons: [], evidence });
const notMet = (...reasons: string[]): PhaseConditionReading => ({ met: false, reasons, evidence: { n: 0 } });

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-03-01T10:00:00.000Z');
  const now = (): Date => new Date(clock);
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1');
  // Des conditions réglables à la main : `'panne'` fait échouer la lecture.
  const state: Record<GatedPhase, PhaseConditionReading | 'panne'> = { 1: notMet('serie_trop_courte'), 2: notMet('serie_publiee_trop_courte'), 3: notMet('moins_de_3_pilotes'), 4: notMet('phase_non_ouverte') };
  const seen: { phase: GatedPhase; openings: string[] }[] = [];
  const read = (phase: GatedPhase) => async (_v: Viewer, openings: ReadonlyMap<number, string>) => {
    seen.push({ phase, openings: [...openings.keys()].map(String) });
    const s = state[phase];
    if (s === 'panne') throw new Error('module illisible');
    return structuredClone(s);
  };
  const sources: PhaseConditionSources = { 1: read(1), 2: read(2), 3: read(3), 4: read(4) };
  const portes = new PortesPhases(db, journal, { now, sources });
  const real = new PortesPhases(db, journal, { now });
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((e) => JSON.parse(e.data) as Record<string, unknown>);
  const report = async (p: PortesPhases = portes, v: Viewer = direction): Promise<PhasesReport> => {
    const r = await p.report(v);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { raw, db, journal, store, network, other, as, direction, state, seen, portes, real, now, setClock, events, report };
}

describeWithSqlite('HX71 · La porte des phases', () => {
  it('[R646] la phase 1 est ouverte d’office, les autres fermées tant qu’aucune ouverture n’est rangée', async () => {
    const t = await setup();
    const r = await t.report();
    expect(r.current).toBe(1);
    expect(r.phases.map((p) => [p.phase, p.open])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(r.phases[0]!.opening).toBeNull();
    expect(r.phases[0]!.condition).toMatchObject({ state: 'non_remplie', reasons: ['serie_trop_courte'] });
    expect(r.phases[4]!.condition.state).toBe('sans_condition');
    expect(r.phases.every((p) => !p.nextOpenable && !p.fellSince)).toBe(true);
    // Condition remplie : la phase suivante devient ouvrable, rien ne s'ouvre seul.
    t.state[1] = met();
    const again = await t.report();
    expect(again.phases[0]!.nextOpenable).toBe(true);
    expect(again.phases[1]!.open).toBe(false);
    expect(again.current).toBe(1);
    expect(await t.db.all('SELECT phase FROM phase_openings')).toEqual([]);
    // Une condition remplie d'une phase fermée ne la rend pas ouvrable : la phase d'avant doit être ouverte.
    t.state[2] = met();
    expect((await t.report()).phases[1]!.nextOpenable).toBe(false);
  });

  it('[R646] une condition dont le module ne se lit pas est « inconnue », jamais remplie, et l’ouverture est refusée', async () => {
    const t = await setup();
    t.state[1] = 'panne';
    const r = await t.report();
    expect(r.phases[0]!.condition).toEqual({ state: 'inconnue', reasons: ['lecture_impossible'], evidence: null, hash: null });
    expect(r.phases[0]!.nextOpenable).toBe(false);
    expect(await t.portes.open(t.direction, { phase: 2 })).toEqual({ ok: false, rule: 'R647', code: 'condition_inconnue', reasons: ['lecture_impossible'] });
    // Une réponse qui n'a pas la forme attendue est aussi inconnue.
    const odd = new PortesPhases(t.db, t.journal, { now: t.now, sources: { 1: async () => ({ met: 'oui' }) as unknown as PhaseConditionReading, 2: async () => notMet(), 3: async () => notMet(), 4: async () => notMet() } });
    const o = await odd.report(t.direction);
    expect(o.ok && o.value.phases[0]!.condition.state).toBe('inconnue');
    expect(await t.db.all('SELECT phase FROM phase_openings')).toEqual([]);
  });

  it('[R647] ouverture refusée sans la phase d’avant ouverte ou sans sa condition remplie à l’instant, raison dite, refus au journal', async () => {
    const t = await setup();
    expect(await t.portes.open(t.direction, { phase: 2 })).toEqual({ ok: false, rule: 'R647', code: 'condition_non_remplie', reasons: ['serie_trop_courte'] });
    t.state[2] = met();
    t.state[3] = met();
    expect(await t.portes.open(t.direction, { phase: 3 })).toEqual({ ok: false, rule: 'R647', code: 'phase_precedente_fermee' });
    expect(await t.portes.open(t.direction, { phase: 4 })).toEqual({ ok: false, rule: 'R647', code: 'phase_precedente_fermee' });
    expect(await t.portes.open(t.direction, { phase: 1 })).toEqual({ ok: false, rule: 'R647', code: 'bad_phase' });
    expect(await t.portes.open(t.direction, { phase: 6 })).toEqual({ ok: false, rule: 'R647', code: 'bad_phase' });
    expect(await t.portes.open(t.direction, { phase: 2.5 })).toEqual({ ok: false, rule: 'R647', code: 'bad_phase' });
    expect(await t.portes.open(t.direction, { phase: '2' })).toEqual({ ok: false, rule: 'R647', code: 'bad_phase' });
    expect(await t.portes.open(t.direction, { phase: 2, force: true })).toEqual({ ok: false, rule: null, code: 'unknown_field' });
    expect(await t.portes.open(t.direction, [2])).toEqual({ ok: false, rule: null, code: 'bad_shape' });
    expect(await t.portes.open(t.direction, null)).toEqual({ ok: false, rule: null, code: 'bad_shape' });
    expect((await t.events('phases.refuse')).map((e) => e.code)).toEqual(['condition_non_remplie', 'phase_precedente_fermee', 'phase_precedente_fermee', 'bad_phase', 'bad_phase', 'bad_phase', 'bad_phase', 'unknown_field', 'bad_shape', 'bad_shape']);
    expect((await t.events('phases.refuse'))[0]!.reasons).toEqual(['serie_trop_courte']);
    expect(await t.db.all('SELECT phase FROM phase_openings')).toEqual([]);
    // La condition est lue à l'instant de l'ouverture, pas reprise d'une lecture d'avant.
    t.state[1] = met();
    await t.report();
    t.state[1] = notMet('inventaire_absent');
    expect(await t.portes.open(t.direction, { phase: 2 })).toMatchObject({ ok: false, code: 'condition_non_remplie', reasons: ['inventaire_absent'] });
  });

  it('[R647, R17] une ouverture range la condition et son empreinte, une seule par phase, et ne change ni ne s’efface', async () => {
    const t = await setup();
    t.state[1] = met({ countedSeries: 30 });
    t.setClock('2027-04-02T08:00:00.000Z');
    const r = await t.portes.open(t.direction, { phase: 2 });
    if (!r.ok) throw new Error(r.code);
    const hash = await phaseConditionHash(1, met({ countedSeries: 30 }));
    expect(r.value).toEqual({ phase: 2, openedAt: '2027-04-02T08:00:00.000Z', evidence: met({ countedSeries: 30 }), evidenceHash: hash });
    expect(await t.db.all('SELECT network_id, phase, opened_at, opened_by, evidence, evidence_hash FROM phase_openings')).toEqual([
      { network_id: t.network.id, phase: 2, opened_at: '2027-04-02T08:00:00.000Z', opened_by: 'direction:direction-1', evidence: JSON.stringify(met({ countedSeries: 30 })), evidence_hash: hash },
    ]);
    expect(await t.events('phases.ouverture')).toEqual([{ rule: 'R647', phase: 2, hash }]);
    // Une empreinte change avec la moindre différence de la preuve.
    expect(await phaseConditionHash(1, met({ countedSeries: 31 }))).not.toBe(hash);
    expect(await phaseConditionHash(2, met({ countedSeries: 30 }))).not.toBe(hash);
    const read = await t.report();
    expect(read.current).toBe(2);
    expect(read.phases[1]).toMatchObject({ open: true, opening: { phase: 2, evidenceHash: hash } });
    expect(read.phases[0]!.nextOpenable).toBe(false);
    // Une seule ouverture par phase.
    expect(await t.portes.open(t.direction, { phase: 2 })).toEqual({ ok: false, rule: 'R647', code: 'deja_ouverte' });
    // La base refuse le reste, même par une écriture directe.
    await expect(t.db.run("UPDATE phase_openings SET evidence_hash = '0' WHERE phase = 2")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM phase_openings')).rejects.toThrow(/rien ne s'efface/);
    await expect(
      t.db.run('INSERT INTO phase_openings (network_id, phase, opened_at, opened_by, evidence, evidence_hash) VALUES (?, 4, ?, ?, ?, ?)', [t.network.id, 'x', 'direction:x', '{}', 'a'.repeat(64)]),
    ).rejects.toThrow(/phase d'avant/);
    await expect(
      t.db.run('INSERT INTO phase_openings (network_id, phase, opened_at, opened_by, evidence, evidence_hash) VALUES (?, 1, ?, ?, ?, ?)', [t.network.id, 'x', 'direction:x', '{}', 'a'.repeat(64)]),
    ).rejects.toThrow();
    // La phase 3, puis 4 et 5, chacune sur la condition de la précédente ; la source de la phase 4 sait quand la phase 4 s'est ouverte.
    t.state[2] = met();
    t.state[3] = met();
    t.state[4] = met();
    for (const phase of [3, 4, 5]) expect((await t.portes.open(t.direction, { phase })).ok).toBe(true);
    expect(t.seen.filter((s) => s.phase === 4).at(-1)!.openings).toEqual(['2', '3', '4']);
    const all = await t.report();
    expect(all.current).toBe(5);
    expect(all.phases.every((p) => p.open)).toBe(true);
    expect(all.phases[4]!.nextOpenable).toBe(false);
    expect(await t.portes.open(t.direction, { phase: 5 })).toEqual({ ok: false, rule: 'R647', code: 'deja_ouverte' });
    // Rien d'un autre réseau.
    const otherReport = await t.report(t.portes, t.as('direction', 'direction-2', t.other.id));
    expect(otherReport.current).toBe(1);
  });

  it('[R647] deux ouvertures en même temps : la base garde la première, l’autre est refusée', async () => {
    const t = await setup();
    t.state[1] = met();
    const [a, b] = await Promise.all([t.portes.open(t.direction, { phase: 2 }), t.portes.open(t.direction, { phase: 2 })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((x) => !x.ok)).toEqual({ ok: false, rule: 'R647', code: 'deja_ouverte' });
    expect(await t.db.all('SELECT phase FROM phase_openings')).toEqual([{ phase: 2 }]);
    expect(await t.events('phases.ouverture')).toHaveLength(1);
  });

  it('[R647] une panne de la base à l’écriture remonte, rien n’est dit ouvert', async () => {
    const t = await setup();
    t.state[1] = met();
    const failing: SqlDatabase = {
      ...t.db,
      all: t.db.all.bind(t.db),
      first: t.db.first.bind(t.db),
      run: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('INSERT INTO phase_openings')) throw new Error('base indisponible');
        return t.db.run(sql, params as never);
      },
    } as SqlDatabase;
    const p = new PortesPhases(failing, t.journal, { now: t.now, sources: { 1: async () => met(), 2: async () => notMet(), 3: async () => notMet(), 4: async () => notMet() } });
    await expect(p.open(t.direction, { phase: 2 })).rejects.toThrow(/base indisponible/);
    expect(await t.events('phases.ouverture')).toEqual([]);
    expect((await t.report()).current).toBe(1);
  });

  it('[R648] une condition retombée après l’ouverture est dite « retombée », la phase reste ouverte', async () => {
    const t = await setup();
    t.state[1] = met();
    expect((await t.portes.open(t.direction, { phase: 2 })).ok).toBe(true);
    t.state[1] = notMet('serie_trop_courte');
    const r = await t.report();
    expect(r.phases[0]).toMatchObject({ fellSince: true, condition: { state: 'non_remplie', reasons: ['serie_trop_courte'] } });
    expect(r.phases[1]!.open).toBe(true);
    expect(r.current).toBe(2);
    // Une condition illisible après l'ouverture est aussi dite retombée : jamais présumée tenue.
    t.state[1] = 'panne';
    expect((await t.report()).phases[0]!.fellSince).toBe(true);
    t.state[1] = met();
    expect((await t.report()).phases[0]!.fellSince).toBe(false);
    expect((await t.events('phases.lecture')).map((e) => e.fell)).toEqual([[1], [1], []]);
  });

  it('[R648] phase 4 : 3 mois finis de suite, complets et couverts, tous commencés après l’ouverture', () => {
    expect(phase4Months('2027-11')).toEqual(['2027-08', '2027-09', '2027-10']);
    expect(phase4Months('2028-02')).toEqual(['2027-11', '2027-12', '2028-01']);
    const ok = (month: string) => ({ month, complete: true, covered: true });
    expect(phase4Condition(null, [])).toEqual({ met: false, reasons: ['phase_non_ouverte'], evidence: { months: [] } });
    expect(phase4Condition('2027-07', [ok('2027-08'), ok('2027-09'), ok('2027-10')])).toEqual({
      met: true,
      reasons: [],
      evidence: { openedMonth: '2027-07', months: [ok('2027-08'), ok('2027-09'), ok('2027-10')] },
    });
    // Le mois de l'ouverture ne compte pas : il n'a pas commencé après elle.
    expect(phase4Condition('2027-08', [ok('2027-08'), ok('2027-09'), ok('2027-10')])).toMatchObject({ met: false, reasons: ['pas_assez_de_mois'] });
    // Un mois incomplet ou non couvert casse la série, chaque raison dite.
    expect(phase4Condition('2027-07', [ok('2027-08'), { month: '2027-09', complete: false, covered: false }, { month: '2027-10', complete: true, covered: false }])).toMatchObject({
      met: false,
      reasons: ['mois_incomplet', 'mois_non_couvert'],
    });
    expect(phase4Condition('2027-07', [ok('2027-09'), ok('2027-10')])).toMatchObject({ met: false, reasons: ['pas_assez_de_mois'] });
  });

  it('[R16] la direction seule lit et ouvre ; refus et lecture au journal', async () => {
    const t = await setup();
    t.state[1] = met();
    for (const role of ['agent', 'compliance', 'assistant']) {
      expect(await t.portes.report(t.as(role, `${role}-1`))).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.portes.open(t.as(role, `${role}-1`), { phase: 2 })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.events('acces.refuse')).map((e) => e.kind)).toEqual(['phases_report', 'phase_open', 'phases_report', 'phase_open', 'phases_report', 'phase_open']);
    expect(await t.db.all('SELECT phase FROM phase_openings')).toEqual([]);
    expect(t.seen).toEqual([]);
    await t.report();
    expect(await t.events('phases.lecture')).toEqual([{ rule: 'R16', current: 1, conditions: ['remplie', 'non_remplie', 'non_remplie', 'non_remplie', 'sans_condition'], fell: [] }]);
  });

  it('les conditions réelles : base vide jamais remplie ; 30 jours propres comptés ouvrent la phase 2, un envoi constaté ensuite la dit retombée', async () => {
    const t = await setup();
    const empty = await t.report(t.real);
    expect(empty.phases.slice(0, 4).map((p) => p.condition.state)).toEqual(['non_remplie', 'non_remplie', 'non_remplie', 'non_remplie']);
    expect(empty.phases[0]!.condition.reasons).toContain('inventaire_absent');
    expect(empty.phases[1]!.condition.reasons).toEqual(['serie_publiee_trop_courte']);
    expect(empty.phases[2]!.condition.reasons).toContain('moins_de_3_pilotes');
    expect(empty.phases[3]!.condition.reasons).toEqual(['phase_non_ouverte']);
    expect(await t.real.open(t.direction, { phase: 2 })).toMatchObject({ ok: false, code: 'condition_non_remplie' });

    // La phase 1 remplie pour de vrai : inventaire à zéro, puis 30 jours de Paris propres, relevés le lendemain.
    const phase1 = new ConditionPhase1(t.db, t.journal, { now: t.now });
    t.setClock('2027-03-01T10:00:00.000Z');
    const inv = await phase1.declareInventory(t.direction, { tasks: { gohighlevel: 0, manychat: 0, site: 0, github_actions: 0, autre: 0 }, proofRef: PROOF });
    expect(inv.ok).toBe(true);
    const addDay = (day: string, k: number) => new Date(Date.parse(`${day}T12:00:00.000Z`) + k * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 30; i++) {
      const day = addDay('2027-03-02', i);
      t.setClock(`${day}T11:00:00.000Z`);
      await appendEvent(t.journal, { type: SCHEDULER_JOURNAL_TYPE, actor: 'system:planificateur', subject: null, data: { job: 'essai', slot: `${day}T11:00:00.000Z`, outcome: 'ok', error: null } }, t.now);
      t.setClock(`${addDay(day, 1)}T01:00:00.000Z`);
      const r = await phase1.takeReading(t.network.id, day);
      if (!r.ok) throw new Error(r.code);
    }
    t.setClock('2027-04-01T08:00:00.000Z');
    const opened = await t.real.open(t.direction, { phase: 2 });
    if (!opened.ok) throw new Error(opened.code);
    expect(opened.value.evidence).toMatchObject({ met: true, evidence: { countedSeries: 30, inventory: { version: 1, total: 0 } } });
    expect(opened.value.evidenceHash).toBe(await phaseConditionHash(1, opened.value.evidence));
    // Un envoi hors règles constaté après coup sur un jour compté : la condition retombe, la phase 2 reste ouverte.
    expect((await phase1.declareOutsideSend(t.direction, { day: '2027-03-20', application: 'manychat', proofRef: PROOF })).ok).toBe(true);
    const after = await t.report(t.real);
    expect(after.phases[0]).toMatchObject({ fellSince: true, condition: { state: 'non_remplie', reasons: ['serie_trop_courte'] } });
    expect(after.phases[1]!.open).toBe(true);
    // La preuve rangée n'a pas bougé.
    expect(after.phases[1]!.opening!.evidenceHash).toBe(opened.value.evidenceHash);
  });

  it('la condition réelle de la phase 4 lit le coût de l’agent moyen des 3 mois finis : sans réglage, mois incomplets', async () => {
    const t = await setup();
    t.state[1] = met();
    t.state[2] = met();
    t.state[3] = met();
    t.setClock('2027-01-15T10:00:00.000Z');
    for (const phase of [2, 3, 4]) expect((await t.portes.open(t.direction, { phase })).ok).toBe(true);
    t.setClock('2027-05-10T10:00:00.000Z');
    const r = await t.report(t.real);
    expect(r.phases[3]!.condition).toMatchObject({
      state: 'non_remplie',
      reasons: ['mois_incomplet'],
      evidence: { openedMonth: '2027-01', months: [{ month: '2027-02' }, { month: '2027-03' }, { month: '2027-04' }] },
    });
    expect(r.phases[3]!.nextOpenable).toBe(false);
  });
});
