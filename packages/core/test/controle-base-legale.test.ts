import { expect, it } from 'vitest';
import {
  ControleBaseLegale,
  Planificateur,
  PlansDuJour,
  SqlJournalStore,
  applyMigrations,
  createCaptation,
  legalBasisJob,
  fromSyncSqlite,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Plans figés à 7 h 30 de Paris (hiver), contrôle à 8 h 05. Tout est inventé.
const DAY = 86_400_000;
const PLAN_1 = Date.parse('2027-01-10T06:30:00.000Z');
const CHECK = Date.parse('2027-01-20T07:05:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = PLAN_1;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const { store } = createCaptation(db, journal, { now, withQualification: false });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const person = async (who: string) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: who });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'valuation', stage: 'recue' });
    await store.addSource({ networkId: network.id, agentId: alex.id, personId: p.id, projectId: project.id, channel: 'site', detail: 'estimation (test)', occurredAt: new Date(PLAN_1 - 5 * DAY) });
    return p.id;
  };
  const plans = new PlansDuJour(db, journal, { now });
  const controle = new ControleBaseLegale(db, journal, { now });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  return { db, journal, store, network, alex, person, plans, controle, as, now, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('G05 · contrôle de la base légale sur 30 jours', () => {
  it('[R36] des plans sans écart rendent zéro', async () => {
    const t = await setup();
    await t.person('Léa');
    await t.person('Noé');
    for (let d = 0; d < 3; d += 1) {
      t.setClock(PLAN_1 + d * DAY);
      await t.plans.freezeAll();
    }
    t.setClock(CHECK);
    const report = await t.controle.run(t.network.id);
    expect(report).toMatchObject({ fromDay: '2026-12-22', toDay: '2027-01-20', plans: 3, items: 6, gaps: 0, byDay: {} });
    expect(await t.controle.alerts(t.as('direction', 'dir-1'))).toEqual({ ok: true, value: [] });
  });

  it('[R36] un contact sans base légale au jour du plan est trouvé, compté par raison et par jour, et signalé à la direction', async () => {
    const t = await setup();
    const lea = await t.person('Léa');
    await t.person('Noé');
    t.setClock(PLAN_1);
    await t.plans.freezeAll();
    // Un « stop » reçu la veille du plan mais noté en retard : le plan figé le portait à tort.
    await t.store.addExclusion({ networkId: t.network.id, personId: lea, reason: 'stop', channel: 'sms', notedAt: new Date(PLAN_1 - DAY) });
    // Une ligne glissée sans base légale ni fiches d'origine.
    const ghost = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Ugo' });
    await t.db.run(`INSERT INTO daily_plans (agent_id, day, network_id, items, removed, computed_at) VALUES (?, '2027-01-11', ?, ?, '{}', ?)`, [
      t.alex.id,
      t.network.id,
      JSON.stringify([{ personId: ghost.id, memberIds: [ghost.id] }, { personId: ghost.id }]),
      new Date(PLAN_1 + DAY).toISOString(),
    ]);
    t.setClock(CHECK);
    const report = await t.controle.run(t.network.id);
    expect(report).toMatchObject({ plans: 2, items: 4, gaps: 3, byReason: { excluded: 1, withdrawn: 0, noBasis: 1, unreadable: 1 }, byDay: { '2027-01-10': 1, '2027-01-11': 2 } });
    const alerts = await t.controle.alerts(t.as('direction', 'dir-1'));
    expect(alerts.ok && alerts.value.map((a) => a.gaps)).toEqual([3]);
    expect(await t.controle.alerts(t.as('compliance', 'conf-1'))).toMatchObject({ ok: true });
    // Le rapport, l'alerte et le journal ne portent que des nombres [R13].
    const everything = JSON.stringify([report, alerts, await t.journal.all(), await t.db.all('SELECT * FROM legal_basis_checks')]);
    expect(everything).not.toMatch(/Léa|Ugo|example\.test/);
    // Ni même un identifiant de fiche dans le rapport rangé et l'alerte.
    expect(JSON.stringify([report, alerts, await t.db.all('SELECT * FROM legal_basis_checks')])).not.toContain(lea);
    expect((await t.journal.all()).filter((e) => e.type === 'plan_du_jour.controle.ecart').map((e) => e.data.gaps)).toEqual([3]);
  });

  it('ne relit que les 30 derniers jours, et seulement le réseau contrôlé', async () => {
    const t = await setup();
    await t.person('Léa');
    t.setClock(PLAN_1 - 40 * DAY);
    await t.plans.freezeAll();
    t.setClock(PLAN_1);
    await t.plans.freezeAll();
    const other = await t.store.createNetwork('Autre réseau');
    t.setClock(CHECK);
    expect((await t.controle.run(t.network.id)).plans).toBe(1);
    expect((await t.controle.run(other.id)).plans).toBe(0);
  });

  it('[R16] seules la direction et la conformité lisent les alertes ; un refus est écrit au journal', async () => {
    const t = await setup();
    t.setClock(CHECK);
    for (const role of ['agent', 'partner'] as const) {
      expect(await t.controle.alerts(t.as(role, 'x-1'))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(2);
  });

  it('passe chaque jour à 8 h de Paris par le planificateur ; un rapport ne change plus et ne s’efface pas', async () => {
    const t = await setup();
    await t.person('Léa');
    await t.plans.freezeAll();
    t.setClock(CHECK);
    const p = new Planificateur(t.db, t.journal, [legalBasisJob(t.db, t.journal, { now: t.now })], { now: t.now });
    expect((await p.tick()).ran).toEqual(['mandats.controle_base_legale']);
    expect(await t.db.all('SELECT gaps FROM legal_basis_checks')).toEqual([{ gaps: 0 }]);
    await expect(t.db.run('UPDATE legal_basis_checks SET gaps = 5')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM legal_basis_checks')).rejects.toThrow();
  });
});
