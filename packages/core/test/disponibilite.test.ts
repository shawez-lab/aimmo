import { expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { DisponibiliteService, FakeSupervision, computeAvailability, type SupervisionReport } from '../src/pilotage/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé. Juin 2027 à Paris : du 31 mai 22:00 UTC au 30 juin 22:00 UTC, 720 heures.
const JUNE = '2027-06';
const START = '2027-05-31T22:00:00.000Z';
const END = '2027-06-30T22:00:00.000Z';
const JUNE_MS = 720 * 3_600_000;
const whole = [{ from: new Date(START), to: new Date(END) }];
const d = (iso: string) => new Date(iso);

async function setup(options: { connected?: boolean } = {}) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const supervision = new FakeSupervision();
  const now = () => new Date('2027-07-15T10:00:00.000Z');
  const t = new DisponibiliteService(journal, { now, ...(options.connected === false ? {} : { supervision }) });
  const as = (role: string): Viewer => ({ role, userId: 'u1', networkId: 'n1' }) as Viewer;
  return { db, journal, supervision, t, as, direction: as('direction') };
}

const read = async (s: Awaited<ReturnType<typeof setup>>, month = JUNE) => {
  const r = await s.t.ofMonth(s.direction, month);
  if (!r.ok) throw new Error(r.code);
  return r.value;
};
const service = async (s: Awaited<ReturnType<typeof setup>>, name: 'site' | 'api' | 'application', report: SupervisionReport) => {
  s.supervision.reports.set(name, report);
  const v = await read(s);
  return v.services.find((x) => x.service === name)!;
};

describeWithSqlite('IN09 · disponibilité du service', () => {
  it('[R223] sans supervision branchée : « non mesuré », jamais 100 %, pour chaque service', async () => {
    const s = await setup({ connected: false });
    const v = await read(s);
    expect(v.connected).toBe(false);
    expect(v.services).toEqual([
      { service: 'site', measured: false, reason: 'not_connected' },
      { service: 'api', measured: false, reason: 'not_connected' },
      { service: 'application', measured: false, reason: 'not_connected' },
    ]);
    expect(JSON.stringify(v)).not.toContain('percent":');
  });

  it('[R223] calcul à la main : 43 min 12 s de coupure sur 720 h font 99,9 % tout juste, une milliseconde de plus manque la cible', async () => {
    const s = await setup();
    const atTarget = await service(s, 'api', { observed: whole, outages: [{ from: d('2027-06-10T08:00:00.000Z'), to: d('2027-06-10T08:43:12.000Z') }] });
    expect(atTarget).toEqual({ service: 'api', measured: true, monthMs: JUNE_MS, observedMs: JUNE_MS, answeredMs: JUNE_MS - 2_592_000, downMs: 2_592_000, complete: true, percent: 99.9, targetMet: true });
    const over = await service(s, 'api', { observed: whole, outages: [{ from: d('2027-06-10T08:00:00.000Z'), to: d('2027-06-10T08:43:12.001Z') }] });
    expect(over).toMatchObject({ downMs: 2_592_001, percent: 99.899, targetMet: false });
  });

  it('[R223] chaque service a sa propre part, et la cible dite est 99,9 %', async () => {
    const s = await setup();
    s.supervision.reports.set('site', { observed: whole, outages: [] });
    s.supervision.reports.set('api', { observed: whole, outages: [{ from: d('2027-06-02T00:00:00.000Z'), to: d('2027-06-02T07:12:00.000Z') }] }); // 7 h 12 = 1 %
    const v = await read(s);
    expect(v.targetPercent).toBe(99.9);
    expect(v.services[0]).toMatchObject({ service: 'site', percent: 100, targetMet: true });
    expect(v.services[1]).toMatchObject({ service: 'api', percent: 99, targetMet: false });
    expect(v.services[2]).toEqual({ service: 'application', measured: false, reason: 'nothing_observed' });
  });

  it('[R223] deux coupures qui se chevauchent ne comptent qu’une fois, et une coupure à cheval sur deux mois est coupée au mois', async () => {
    const s = await setup();
    const overlapping = await service(s, 'site', {
      observed: whole,
      outages: [
        { from: d('2027-06-05T10:15:00.000Z'), to: d('2027-06-05T10:45:00.000Z') },
        { from: d('2027-06-05T10:00:00.000Z'), to: d('2027-06-05T10:30:00.000Z') },
      ],
    });
    expect(overlapping).toMatchObject({ downMs: 45 * 60_000 });
    const onEdges = await service(s, 'site', {
      observed: [{ from: d('2027-05-01T00:00:00.000Z'), to: d('2027-07-31T00:00:00.000Z') }],
      outages: [
        { from: d('2027-05-31T21:00:00.000Z'), to: d('2027-05-31T22:10:00.000Z') },
        { from: d('2027-06-30T21:50:00.000Z'), to: d('2027-06-30T23:00:00.000Z') },
        { from: d('2027-05-10T00:00:00.000Z'), to: d('2027-05-10T01:00:00.000Z') },
      ],
    });
    expect(onEdges).toMatchObject({ observedMs: JUNE_MS, downMs: 20 * 60_000, complete: true });
  });

  it('[R223] une coupure pas finie court jusqu’au bout de ce qui est observé', async () => {
    const s = await setup();
    const v = await service(s, 'site', { observed: whole, outages: [{ from: d('2027-06-30T21:00:00.000Z'), to: null }] });
    expect(v).toMatchObject({ downMs: 3_600_000, targetMet: false });
  });

  it('[R223] une milliseconde de coupure n’affiche jamais 100 %', async () => {
    const s = await setup();
    const v = await service(s, 'site', { observed: whole, outages: [{ from: d('2027-06-05T10:00:00.000Z'), to: d('2027-06-05T10:00:00.001Z') }] });
    expect(v).toMatchObject({ percent: 99.999, targetMet: true });
  });

  it('[R223] un mois observé en partie le dit : la part porte sur l’observé, la cible n’est jamais dite atteinte', async () => {
    const s = await setup();
    const half = [{ from: d(START), to: d('2027-06-15T22:00:00.000Z') }];
    const clean = await service(s, 'site', { observed: half, outages: [] });
    expect(clean).toMatchObject({ observedMs: 360 * 3_600_000, complete: false, percent: 100, targetMet: null });
    // Hors du temps observé, une coupure n'est pas comptée : on ne l'a pas vue.
    const unseen = await service(s, 'site', { observed: half, outages: [{ from: d('2027-06-20T00:00:00.000Z'), to: d('2027-06-20T05:00:00.000Z') }] });
    expect(unseen).toMatchObject({ downMs: 0, targetMet: null });
    // Plus d'un millième du mois entier coupé : la cible est manquée, même sans avoir tout vu.
    const missed = await service(s, 'site', { observed: half, outages: [{ from: d('2027-06-02T00:00:00.000Z'), to: d('2027-06-02T01:00:00.000Z') }] });
    expect(missed).toMatchObject({ downMs: 3_600_000, complete: false, targetMet: false });
  });

  it('[R223] deux périodes observées qui se touchent valent le mois entier', async () => {
    const s = await setup();
    const v = await service(s, 'site', { observed: [{ from: d('2027-06-15T00:00:00.000Z'), to: d(END) }, { from: d(START), to: d('2027-06-15T00:00:00.000Z') }], outages: [] });
    expect(v).toMatchObject({ complete: true, targetMet: true });
  });

  it('[R223] un mois au changement d’heure compte ses vraies heures', async () => {
    const s = await setup();
    s.supervision.reports.set('site', { observed: [{ from: d('2026-09-01T00:00:00.000Z'), to: d('2027-04-30T00:00:00.000Z') }], outages: [] });
    expect((await read(s, '2026-10')).services[0]).toMatchObject({ monthMs: 745 * 3_600_000, complete: true });
    expect((await read(s, '2027-03')).services[0]).toMatchObject({ monthMs: 743 * 3_600_000, complete: true });
    expect(s.supervision.asked.find((a) => a.from.toISOString() === '2027-02-28T23:00:00.000Z')?.to.toISOString()).toBe('2027-03-31T22:00:00.000Z');
  });

  it('[R223] une donnée incohérente rend le service « non mesuré », rien n’est écarté en douce', async () => {
    const s = await setup();
    const reversed = await service(s, 'site', { observed: whole, outages: [{ from: d('2027-06-05T11:00:00.000Z'), to: d('2027-06-05T10:00:00.000Z') }] });
    expect(reversed).toEqual({ service: 'site', measured: false, reason: 'bad_data' });
    expect(await service(s, 'site', { observed: whole, outages: [{ from: new Date('rien'), to: null }] })).toMatchObject({ reason: 'bad_data' });
    expect(await service(s, 'site', { observed: [{ from: d(END), to: d(START) }], outages: [] })).toMatchObject({ reason: 'bad_data' });
    expect(await service(s, 'site', { outages: [] } as unknown as SupervisionReport)).toMatchObject({ reason: 'bad_data' });
    expect(computeAvailability(null as unknown as SupervisionReport, 0, 1)).toBeNull();
  });

  it('[R223] rien d’observé : « non mesuré » ; supervision en panne : « non mesuré », sans son message', async () => {
    const s = await setup();
    expect(await service(s, 'site', { observed: [{ from: d('2027-05-01T00:00:00.000Z'), to: d('2027-05-02T00:00:00.000Z') }], outages: [] })).toEqual({ service: 'site', measured: false, reason: 'nothing_observed' });
    s.supervision.failWith = new Error('https://secret.example/?cle=abc');
    const v = await read(s);
    expect(v.connected).toBe(true);
    expect(v.services.every((x) => !x.measured && x.reason === 'supervision_failed')).toBe(true);
    const all = await s.journal.all();
    expect(JSON.stringify(v) + JSON.stringify(all)).not.toContain('secret');
  });

  it('[R223] seul un mois fini se lit, un mois mal écrit est refusé', async () => {
    const s = await setup();
    expect(await s.t.ofMonth(s.direction, '2027-07')).toEqual({ ok: false, rule: 'R223', code: 'month_not_finished' });
    expect(await s.t.ofMonth(s.direction, '2999-01')).toEqual({ ok: false, rule: 'R223', code: 'month_not_finished' });
    for (const bad of ['2027-13', '2027', null, 202706]) expect(await s.t.ofMonth(s.direction, bad)).toEqual({ ok: false, rule: null, code: 'bad_month' });
    expect(s.supervision.asked).toEqual([]);
  });

  it('[R16] la direction seule : les autres sont refusés, notés, et la supervision n’est pas appelée', async () => {
    const s = await setup();
    for (const role of ['agent', 'compliance', 'client', 'partner']) {
      expect(await s.t.ofMonth(s.as(role), JUNE)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect(s.supervision.asked).toEqual([]);
    const all = await s.journal.all();
    expect(all.filter((e) => e.type === 'acces.refuse')).toHaveLength(4);
  });

  it('[R13] la lecture de la direction est au journal, sans chiffre ni coupure', async () => {
    const s = await setup();
    s.supervision.reports.set('site', { observed: whole, outages: [] });
    await read(s);
    const events = (await s.journal.all()).filter((e) => e.type === 'pilotage.lecture');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ kind: 'availability', month: JUNE });
  });
});
