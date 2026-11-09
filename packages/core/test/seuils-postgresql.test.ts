import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { POSTGRES_LIMITS, PassagePostgresql, forecastCrossing } from '../src/passage-postgresql/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseaux et agents inventés. Les mesures de taille et de temps sont données par le test, jamais lues d'une vraie base.

const DAY = 86_400_000;

async function setup(opts: { bytes?: () => Promise<number | null>; report?: { ms: number; fail?: boolean } } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-03-10T09:00:00.000Z');
  const now = (): Date => new Date(clock);
  const goTo = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  let bytes = 1_000_000;
  let reportMs = opts.report?.ms ?? 1200;
  let chrono = 0;
  let n = 0;
  const passage = new PassagePostgresql(db, journal, {
    now,
    databaseBytes: opts.bytes ?? (async () => bytes),
    ...(opts.report
      ? {
          networkReport: async () => {
            if (opts.report?.fail) throw new Error('rapport en échec');
            chrono += reportMs;
          },
        }
      : {}),
    clockMs: () => chrono,
    newId: () => `rel-${++n}`,
  });
  const agents: string[] = [];
  const addAgents = async (count: number, networkId = network.id) => {
    for (let i = 0; i < count; i += 1) agents.push((await store.createAgent({ networkId, firstName: `Prénom${agents.length}`, lastName: 'Agent' })).id);
  };
  const as = (role: string, userId = 'dir-1'): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const dir = as('direction');
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ? ORDER BY seq', [type])).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  return {
    db,
    passage,
    network,
    other,
    agents,
    addAgents,
    dir,
    as,
    goTo,
    events,
    setBytes: (b: number) => {
      bytes = b;
    },
    setReportMs: (ms: number) => {
      reportMs = ms;
    },
  };
}

describeWithSqlite('HX66 · seuils du passage à PostgreSQL', () => {
  it('[R16] la direction seule relève, lit et décide ; chaque refus est au journal', async () => {
    const t = await setup({ report: { ms: 100 } });
    for (const role of ['agent', 'assistant', 'admin']) {
      expect(await t.passage.measureNow(t.as(role))).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.passage.state(t.as(role))).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.passage.decide(t.as(role), 'passer')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.events('acces.refuse')).length).toBe(9);
    expect(await t.db.all('SELECT id FROM postgres_threshold_readings')).toEqual([]);
  });

  it('[R630] un relevé lit les agents actifs de toute la base, la taille et le temps du rapport, puis est rangé', async () => {
    const t = await setup({ report: { ms: 1234 } });
    await t.addAgents(3);
    await t.addAgents(2, t.other.id);
    // Un agent parti ne compte pas ; un départ annulé ou à venir le laisse compter.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.agents[0]!]);
    await t.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('d1', ?, ?, '2027-01-01', '2027-03-01', 'accord_mutuel', 1, 'direction:dir-1', 'x')",
      [t.network.id, t.agents[1]!],
    );
    await t.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('d2', ?, ?, '2027-03-01', '2027-04-30', 'accord_mutuel', 1, 'direction:dir-1', 'x')",
      [t.network.id, t.agents[2]!],
    );
    t.setBytes(42_000_000);
    const r = await t.passage.measureNow(t.dir);
    expect(r.ok && r.value.values).toEqual({ agents: 3, taille: 42_000_000, rapport: 1234 });
    expect(await t.db.all('SELECT agents_active, db_bytes, report_ms, source FROM postgres_threshold_readings')).toEqual([{ agents_active: 3, db_bytes: 42_000_000, report_ms: 1234, source: 'direction' }]);
    const [ev] = await t.events('postgresql.releve');
    expect(ev).toMatchObject({ readingId: 'rel-1', agents: 3, crossed: [], alerted: [], unknown: {} });
  });

  it('[R630] sans source de taille, la taille est lue dans la base elle-même', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const passage = new PassagePostgresql(db, new SqlJournalStore(db), { now: () => new Date('2027-03-10T09:00:00.000Z') });
    const r = await passage.measureScheduled();
    expect(r.values.taille).toBeGreaterThan(0);
    expect(r.values.rapport).toBeNull();
    expect(r.source).toBe('passage');
  });

  it('[R630] une mesure absente ou en échec est inconnue, jamais « sous le seuil », et la cause est au journal', async () => {
    const t = await setup({
      bytes: async () => {
        throw new Error('pragma refusé');
      },
      report: { ms: 10, fail: true },
    });
    const r = await t.passage.measureNow(t.dir);
    expect(r.ok && r.value.values).toEqual({ agents: 0, taille: null, rapport: null });
    expect((await t.events('postgresql.releve'))[0]).toMatchObject({ unknown: { taille: 'echec', rapport: 'echec' } });
    const s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('inconnu');
    expect(s.ok && s.value.unknownBecause).toEqual(['mesure_inconnue']);
    expect(s.ok && s.value.thresholds.map((x) => x.crossed)).toEqual([false, null, null]);
    // Une taille qui n'est pas un nombre entier positif est inconnue aussi.
    const u = await setup({ bytes: async () => -5, report: { ms: 10 } });
    const v = await u.passage.measureNow(u.dir);
    expect(v.ok && v.value.values.taille).toBeNull();
    // Un rapport pas branché est inconnu, avec sa cause.
    const w = await setup();
    await w.passage.measureNow(w.dir);
    expect((await w.events('postgresql.releve'))[0]).toMatchObject({ unknown: { rapport: 'non_branche' } });
  });

  it('[R630] jamais « sous les seuils » sans relevé, ni avec un relevé de plus de 8 jours', async () => {
    const t = await setup({ report: { ms: 100 } });
    let s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('inconnu');
    expect(s.ok && s.value.unknownBecause).toEqual(['aucun_releve']);
    await t.passage.measureNow(t.dir);
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('sous_les_seuils');
    t.goTo('2027-03-18T09:00:00.000Z');
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('sous_les_seuils');
    t.goTo('2027-03-18T09:00:01.000Z');
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('inconnu');
    expect(s.ok && s.value.unknownBecause).toEqual(['releve_ancien']);
  });

  it('[R630] [R17] un relevé, une alerte ou une décision ne changent ni ne s\'effacent', async () => {
    const t = await setup({ report: { ms: 6000 } });
    await t.passage.measureNow(t.dir);
    await t.passage.decide(t.dir, 'attendre');
    await expect(t.db.run('UPDATE postgres_threshold_readings SET report_ms = 1')).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM postgres_threshold_readings')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE postgres_threshold_alerts SET created_at = 'x'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM postgres_threshold_alerts')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE postgres_decisions SET choice = 'passer'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM postgres_decisions')).rejects.toThrow(/rien ne s'efface/);
    // La base refuse une version hors suite, et une mesure négative.
    await expect(t.db.run("INSERT INTO postgres_decisions (version, choice, decided_at) VALUES (5, 'passer', 'x')")).rejects.toThrow(/hors suite/);
    await expect(t.db.run("INSERT INTO postgres_threshold_readings (id, measured_at, agents_active, source) VALUES ('z', 'x', -1, 'direction')")).rejects.toThrow();
  });

  it('[R631] plus de 50 agents actifs : à décider, une seule alerte même relevé deux fois ; 50 tout juste ne franchit pas', async () => {
    const t = await setup({ report: { ms: 100 } });
    await t.addAgents(50);
    await t.passage.measureNow(t.dir);
    let s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('sous_les_seuils');
    await t.addAgents(1, t.other.id);
    t.goTo('2027-03-11T09:00:00.000Z');
    await t.passage.measureNow(t.dir);
    t.goTo('2027-03-12T09:00:00.000Z');
    await t.passage.measureScheduled();
    expect(await t.db.all('SELECT threshold, reading_id, created_at FROM postgres_threshold_alerts')).toEqual([{ threshold: 'agents', reading_id: 'rel-2', created_at: '2027-03-11T09:00:00.000Z' }]);
    const evs = await t.events('postgresql.releve');
    expect(evs.map((e) => e.alerted)).toEqual([[], ['agents'], []]);
    expect(evs.map((e) => e.crossed)).toEqual([[], ['agents'], ['agents']]);
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('a_decider');
    expect(s.ok && s.value.thresholds[0]).toMatchObject({ threshold: 'agents', value: 51, crossed: true, alertedAt: '2027-03-11T09:00:00.000Z' });
  });

  it('[R631] plus de 5 Go ou plus de 5 secondes rendent aussi « à décider » ; tout juste au seuil, non', async () => {
    const t = await setup({ report: { ms: 5000 } });
    t.setBytes(POSTGRES_LIMITS.taille);
    await t.passage.measureNow(t.dir);
    let s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('sous_les_seuils');
    t.setBytes(POSTGRES_LIMITS.taille + 1);
    await t.passage.measureNow(t.dir);
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('a_decider');
    const u = await setup({ report: { ms: 5001 } });
    await u.passage.measureNow(u.dir);
    s = await u.passage.state(u.dir);
    expect(s.ok && s.value.status).toBe('a_decider');
    expect(await u.db.all('SELECT threshold FROM postgres_threshold_alerts')).toEqual([{ threshold: 'rapport' }]);
  });

  it('[R631] une décision n\'est possible qu\'après un seuil franchi, et seulement « passer » ou « attendre »', async () => {
    const t = await setup({ report: { ms: 100 } });
    await t.passage.measureNow(t.dir);
    expect(await t.passage.decide(t.dir, 'attendre')).toEqual({ ok: false, rule: 'R631', code: 'aucun_seuil' });
    expect(await t.passage.decide(t.dir, 'basculer')).toEqual({ ok: false, rule: null, code: 'bad_choice' });
    expect(await t.db.all('SELECT version FROM postgres_decisions')).toEqual([]);
    expect((await t.events('postgresql.refuse')).map((e) => e.code)).toEqual(['aucun_seuil', 'bad_choice']);
  });

  it('[R631] « attendre » vaut 90 jours, puis à décider ; un nouveau seuil franchi la rend caduque ; « passer » ne bascule rien', async () => {
    const t = await setup({ report: { ms: 6000 } });
    await t.passage.measureNow(t.dir);
    t.goTo('2027-03-11T09:00:00.000Z');
    const d = await t.passage.decide(t.dir, 'attendre');
    expect(d).toEqual({ ok: true, value: { version: 1, choice: 'attendre', decidedAt: '2027-03-11T09:00:00.000Z' } });
    let s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('attendre');
    expect(s.ok && s.value.decision?.validUntil).toBe('2027-06-09T09:00:00.000Z');
    // Le même seuil relevé encore : « attendre » tient.
    t.goTo('2027-03-12T09:00:00.000Z');
    await t.passage.measureNow(t.dir);
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('attendre');
    // 90 jours plus tard : à décider de nouveau.
    t.goTo('2027-06-09T09:00:00.000Z');
    await t.passage.measureNow(t.dir);
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('a_decider');
    // Une nouvelle attente, puis un autre seuil franchi : à décider tout de suite.
    await t.passage.decide(t.dir, 'attendre');
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('attendre');
    t.goTo('2027-06-10T09:00:00.000Z');
    t.setBytes(POSTGRES_LIMITS.taille + 10);
    await t.passage.measureNow(t.dir);
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('a_decider');
    // « Passer » est rangé et dit ; rien d'autre ne change dans la base.
    const p = await t.passage.decide(t.dir, 'passer');
    expect(p.ok && p.value.version).toBe(3);
    s = await t.passage.state(t.dir);
    expect(s.ok && s.value.status).toBe('passage_decide');
    expect(s.ok && s.value.decision).toMatchObject({ version: 3, choice: 'passer', validUntil: null });
    expect((await t.events('postgresql.decision')).map((e) => e.choice)).toEqual(['attendre', 'attendre', 'passer']);
  });

  it('[R632] prévision par moindres carrés, recalculée à la main sur un jeu inventé', () => {
    const t0 = Date.parse('2027-01-01T12:00:00.000Z');
    // 10, 20, 30, 40 agents à 0, 10, 20, 30 jours : pente 1 par jour, droite y = 10 + x ; plus de 50 au jour 40.
    const points = [10, 20, 30, 40].map((v, i) => ({ atMs: t0 + i * 10 * DAY, value: v }));
    expect(forecastCrossing(points, 50)).toEqual({ date: '2027-02-10', perDay: 1, points: 4, reason: null });
    // Valeurs bruitées : x = 0, 7, 14 ; y = 0, 14, 7. Moyennes 7 et 7 ; sxy = (-7)(-7) + 0 + 7·0 = 49 ; sxx = 98 ;
    // pente 0,5 ; ordonnée 7 − 0,5·7 = 3,5 ; la limite 10 est atteinte à x = 13, déjà passé : le jour du dernier relevé.
    const noisy = [0, 14, 7].map((v, i) => ({ atMs: t0 + i * 7 * DAY, value: v }));
    expect(forecastCrossing(noisy, 10)).toEqual({ date: '2027-01-15', perDay: 0.5, points: 3, reason: null });
  });

  it('[R632] aucune prévision avec moins de 3 relevés, sur moins de 7 jours, sans hausse, déjà franchi ou au-delà de 10 ans', () => {
    const t0 = Date.parse('2027-01-01T12:00:00.000Z');
    const at = (days: number[], values: number[]) => days.map((d, i) => ({ atMs: t0 + d * DAY, value: values[i]! }));
    expect(forecastCrossing(at([0, 10], [1, 2]), 50).reason).toBe('trop_peu');
    expect(forecastCrossing(at([0, 3, 6.9], [1, 2, 3]), 50).reason).toBe('trop_peu');
    expect(forecastCrossing(at([0, 4, 8], [3, 3, 3]), 50).reason).toBe('sans_hausse');
    expect(forecastCrossing(at([0, 4, 8], [5, 4, 3]), 50).reason).toBe('sans_hausse');
    expect(forecastCrossing(at([0, 4, 8], [10, 30, 51]), 50)).toEqual({ date: null, perDay: null, points: 3, reason: 'franchi' });
    const far = forecastCrossing(at([0, 10, 20], [0, 0.001, 0.002]), 50);
    expect(far.reason).toBe('au_dela');
    expect(far.date).toBeNull();
  });

  it('[R632] l\'état donne la prévision de chaque seuil depuis les relevés des 90 derniers jours seulement', async () => {
    const t = await setup({ report: { ms: 1000 } });
    // Un vieux relevé, hors de la fenêtre, qui casserait la tendance s'il comptait.
    await t.addAgents(45);
    await t.passage.measureNow(t.dir);
    await t.db.exec('DROP TRIGGER postgres_threshold_readings_fige');
    await t.db.run("UPDATE postgres_threshold_readings SET measured_at = '2026-10-01T09:00:00.000Z'");
    // 10, 20 puis 30 agents à 0, 10 et 20 jours.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id IN (SELECT id FROM agents LIMIT 35)");
    t.goTo('2027-03-10T09:00:00.000Z');
    await t.passage.measureNow(t.dir);
    await t.db.run("UPDATE agents SET status = 'active' WHERE id IN (SELECT id FROM agents WHERE status = 'left' LIMIT 10)");
    t.goTo('2027-03-20T09:00:00.000Z');
    await t.passage.measureNow(t.dir);
    await t.db.run("UPDATE agents SET status = 'active' WHERE id IN (SELECT id FROM agents WHERE status = 'left' LIMIT 10)");
    t.goTo('2027-03-30T09:00:00.000Z');
    t.setReportMs(1000);
    await t.passage.measureNow(t.dir);
    const s = await t.passage.state(t.dir);
    const agents = s.ok ? s.value.thresholds.find((x) => x.threshold === 'agents') : null;
    // Pente 1 par jour depuis 10 au 10 mars : 50 au 40e jour, le 19 avril.
    expect(agents?.forecast).toEqual({ date: '2027-04-19', perDay: 1, points: 3, reason: null });
    const rapport = s.ok ? s.value.thresholds.find((x) => x.threshold === 'rapport') : null;
    expect(rapport?.forecast.reason).toBe('sans_hausse');
  });

  it('[R16] [R13] la lecture est écrite au journal avant d\'être rendue, sans donnée personnelle', async () => {
    const t = await setup({ report: { ms: 100 } });
    await t.addAgents(2);
    await t.passage.measureNow(t.dir);
    await t.passage.state(t.dir);
    expect(await t.events('postgresql.etat_lu')).toEqual([{ rule: 'R16', status: 'sous_les_seuils' }]);
    const all = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type LIKE 'postgresql.%'");
    expect(all.map((r) => r.data).join(' ')).not.toMatch(/Prénom|Agent/);
  });
});
