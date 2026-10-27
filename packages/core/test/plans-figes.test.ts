import { expect, it } from 'vitest';
import {
  Planificateur,
  PlansDuJour,
  SqlJournalStore,
  applyMigrations,
  createCaptation,
  dailyPlanJob,
  fromSyncSqlite,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// 7 h 30 à Paris : 6 h 30 UTC en hiver, 5 h 30 UTC en été. 7 h 07 : le déclencheur de la 7e minute.
const WINTER_7H07 = Date.parse('2027-01-15T06:07:00.000Z');
const WINTER_7H30 = Date.parse('2027-01-15T06:30:00.000Z');
const SUMMER_7H30 = Date.parse('2027-07-15T05:30:00.000Z');
const SUMMER_6H30 = Date.parse('2027-07-15T04:30:00.000Z');
const DAY = 86_400_000;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = WINTER_7H07;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const { store } = createCaptation(db, journal, { now, withQualification: false });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const gone = await store.createAgent({ networkId: network.id, firstName: 'Gil', lastName: 'Parti' });
  await db.run(`UPDATE agents SET status = 'left' WHERE id = ?`, [gone.id]);
  const person = async (agentId: string, who: string, at: number) => {
    const p = await store.createPerson({ networkId: network.id, agentId, firstName: who });
    const project = await store.createProject({ networkId: network.id, agentId, personId: p.id, kind: 'valuation', stage: 'recue' });
    await store.addSource({ networkId: network.id, agentId, personId: p.id, projectId: project.id, channel: 'site', detail: 'estimation', occurredAt: new Date(at) });
    return p.id;
  };
  const plans = new PlansDuJour(db, journal, { now });
  const scheduler = new Planificateur(db, journal, [dailyPlanJob(db, journal, { now })], { now });
  const as = (role: 'agent' | 'direction' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  return { db, journal, store, network, alex, sam, gone, person, plans, scheduler, as, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('G02 · plan du jour à 7 h 30, par le planificateur', () => {
  it('se fige à 7 h 30 de Paris, été comme hiver, pas avant', async () => {
    const t = await setup();
    await t.person(t.alex.id, 'Léa', WINTER_7H07 - 10 * DAY);
    expect((await t.scheduler.tick()).ran).toEqual([]);
    expect(await t.plans.read(t.as('agent', t.alex.id))).toEqual({ ok: true, value: null });
    t.setClock(WINTER_7H30);
    expect(await t.scheduler.tick()).toMatchObject({ slot: '2027-01-15T07', ran: ['mandats.plan_du_jour'] });
    const winter = await t.plans.read(t.as('agent', t.alex.id));
    expect(winter.ok && winter.value).toMatchObject({ day: '2027-01-15', computedAt: '2027-01-15T06:30:00.000Z', items: [{ rank: 1, firstName: 'Léa', kind: 'appointment' }] });

    t.setClock(SUMMER_6H30);
    expect((await t.scheduler.tick()).ran).toEqual([]);
    t.setClock(SUMMER_7H30);
    expect((await t.scheduler.tick()).ran).toEqual(['mandats.plan_du_jour']);
    const summer = await t.plans.read(t.as('agent', t.alex.id));
    expect(summer.ok && summer.value && summer.value.day).toBe('2027-07-15');
  });

  it('un plan par agent et par jour, même si le déclencheur passe deux fois ; un agent parti n’en a pas', async () => {
    const t = await setup();
    await t.person(t.alex.id, 'Léa', WINTER_7H30 - DAY);
    await t.person(t.sam.id, 'Paul', WINTER_7H30 - DAY);
    t.setClock(WINTER_7H30);
    await t.scheduler.tick();
    t.setClock(WINTER_7H30 + 20 * 60_000);
    expect((await t.scheduler.tick()).skipped).toEqual(['mandats.plan_du_jour']);
    // Même appelé en direct une seconde fois, rien ne se double.
    expect(await t.plans.freezeAll()).toEqual({ frozen: 0, already: 2 });
    const rows = await t.db.all<{ agent_id: string; day: string }>('SELECT agent_id, day FROM daily_plans ORDER BY agent_id');
    expect(rows.map((r) => r.agent_id).sort()).toEqual([t.alex.id, t.sam.id].sort());
    expect(rows.every((r) => r.day === '2027-01-15')).toBe(true);
  });

  it('un plan figé ne change plus, et rien ne s’efface', async () => {
    const t = await setup();
    await t.person(t.alex.id, 'Léa', WINTER_7H30 - DAY);
    t.setClock(WINTER_7H30);
    await t.plans.freezeAll();
    // Un nouveau contact arrive dans la journée : le plan du jour reste celui de 7 h 30.
    await t.person(t.alex.id, 'Noé', WINTER_7H30);
    t.setClock(WINTER_7H30 + 3 * 3_600_000);
    await t.plans.freezeAll();
    const read = await t.plans.read(t.as('agent', t.alex.id));
    expect(read.ok && read.value?.items.map((i) => i.firstName)).toEqual(['Léa']);
    await expect(t.db.run(`UPDATE daily_plans SET items = '[]'`)).rejects.toThrow();
    await expect(t.db.run('DELETE FROM daily_plans')).rejects.toThrow();
  });

  it('[R16] chaque agent ne lit que son plan ; la direction, un partenaire, un agent parti sont refusés', async () => {
    const t = await setup();
    await t.person(t.alex.id, 'Léa', WINTER_7H30 - DAY);
    await t.person(t.sam.id, 'Paul', WINTER_7H30 - DAY);
    t.setClock(WINTER_7H30);
    await t.plans.freezeAll();
    const alex = await t.plans.read(t.as('agent', t.alex.id));
    const sam = await t.plans.read(t.as('agent', t.sam.id));
    expect(alex.ok && alex.value?.items.map((i) => i.firstName)).toEqual(['Léa']);
    expect(sam.ok && sam.value?.items.map((i) => i.firstName)).toEqual(['Paul']);
    expect(await t.plans.read(t.as('direction', 'dir-1'))).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    expect(await t.plans.read(t.as('partner', 'p-1'))).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    expect(await t.plans.read(t.as('agent', t.gone.id))).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.plans.read({ role: 'agent', userId: t.alex.id, networkId: 'autre-reseau' })).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  it('[R16, R36] à la lecture, une fiche rattachée à un autre agent, exclue, arrêtée ou dont l’accord est retiré depuis 7 h 30 n’est plus rendue', async () => {
    const t = await setup();
    const lea = await t.person(t.alex.id, 'Léa', WINTER_7H30 - DAY);
    const noe = await t.person(t.alex.id, 'Noé', WINTER_7H30 - DAY);
    const ugo = await t.person(t.alex.id, 'Ugo', WINTER_7H30 - DAY);
    const zoe = await t.person(t.alex.id, 'Zoé', WINTER_7H30 - DAY);
    const consent = await t.store.addConsent({ networkId: t.network.id, personId: ugo, purpose: 'valuation_follow_up', channel: 'email', proof: 'case cochée (test)', givenAt: new Date(WINTER_7H30 - DAY) });
    t.setClock(WINTER_7H30);
    await t.plans.freezeAll();
    const before = await t.plans.read(t.as('agent', t.alex.id));
    expect(before.ok && before.value?.items).toHaveLength(4);
    t.setClock(WINTER_7H30 + 3_600_000);
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, lea]);
    await t.store.addExclusion({ networkId: t.network.id, personId: noe, reason: 'stop', channel: 'sms', notedAt: new Date(WINTER_7H30 + 1000) });
    await t.store.withdrawConsent(consent.id, new Date(WINTER_7H30 + 1000));
    const after = await t.plans.read(t.as('agent', t.alex.id));
    expect(after.ok && after.value?.items.map((i) => i.personId)).toEqual([zoe]);
    expect(after.ok && after.value?.hiddenSinceFrozen).toBe(3);
    // Le plan rangé, lui, n'a pas changé.
    const row = await t.db.first<{ items: string }>('SELECT items FROM daily_plans WHERE agent_id = ?', [t.alex.id]);
    expect((JSON.parse(row!.items) as unknown[]).length).toBe(4);
    // Le nouvel agent ne reçoit pas le plan de l'ancien.
    const sam = await t.plans.read(t.as('agent', t.sam.id));
    expect(sam.ok && sam.value?.items).toEqual([]);
  });

  it('[R16] une ligne dont les fiches réunies ont changé depuis 7 h 30 (défusion) n’est plus rendue', async () => {
    const t = await setup();
    const a = await t.person(t.alex.id, 'Léa', WINTER_7H30 - DAY);
    const b = await t.person(t.alex.id, 'Léa', WINTER_7H30 - 2 * DAY);
    const { FicheUnique } = await import('../src/index.ts');
    const unique = new FicheUnique(t.db, t.store, { now: () => new Date(WINTER_7H30 - 1000) });
    const merge = await unique.merge({ survivorId: a, mergedId: b, reason: 'même personne (test)' });
    t.setClock(WINTER_7H30);
    await t.plans.freezeAll();
    const before = await t.plans.read(t.as('agent', t.alex.id));
    expect(before.ok && before.value?.items.map((i) => i.personId)).toEqual([a]);
    expect(JSON.stringify(before)).not.toContain('memberIds');
    await unique.undoMerge(merge.id);
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, b]);
    const after = await t.plans.read(t.as('agent', t.alex.id));
    expect(after.ok && after.value?.items).toEqual([]);
    expect(after.ok && after.value?.hiddenSinceFrozen).toBe(1);
  });

  it('[R13] le journal note le passage et les lectures sans donnée personnelle ; aucun envoi', async () => {
    const t = await setup();
    await t.person(t.alex.id, 'Léa', WINTER_7H30 - DAY);
    t.setClock(WINTER_7H30);
    await t.scheduler.tick();
    await t.plans.read(t.as('agent', t.alex.id));
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'plan_du_jour.fige' && e.subject === `agent:${t.alex.id}`).map((e) => e.data)).toEqual([{ day: '2027-01-15', items: 1, excluded: 0, withdrawn: 0, noBasis: 0 }]);
    expect(entries.filter((e) => e.type === 'plan_du_jour.fige')).toHaveLength(2);
    expect(entries.some((e) => e.type === 'plan_du_jour.lu')).toBe(true);
    // La lecture des fiches faite pour l'agent dit qu'elle vient du planificateur.
    expect(entries.find((e) => e.type === 'fiches.listees')?.data).toMatchObject({ via: 'system:planificateur' });
    expect(JSON.stringify(entries)).not.toContain('Léa');
    expect(await t.db.all('SELECT id FROM messages')).toEqual([]);
    expect(await t.db.all('SELECT * FROM trial_outbox')).toEqual([]);
  });
});
