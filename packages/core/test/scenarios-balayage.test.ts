import { expect, it, vi } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { DEFAULT_SCENARIO_SETTINGS, ScenariosAutomatiques, type ScenarioSettings } from '../src/automatismes/scenarios.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agent et personnes inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Une tâche seulement : aucun message, aucun accord à prendre ; le balayage est le même. */
const CALL_BACK = {
  name: 'Rappeler chaque nouveau contact',
  trigger: 'nouveau_contact',
  waitHours: 0,
  message: null,
  task: { title: 'Rappeler le nouveau contact', dueInDays: 1 },
};

async function setup(settings?: Partial<ScenarioSettings>) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const store = new FicheClient(db, { now });
  const scenarios = new ScenariosAutomatiques(db, new SqlJournalStore(db), { now, newId, ...(settings ? { settings: { ...DEFAULT_SCENARIO_SETTINGS, ...settings } } : {}) });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  /** Une fiche datée de l'heure de l'horloge, écrite maintenant. */
  const person = async (firstName: string): Promise<string> => (await store.createPerson({ networkId: network.id, agentId: alex.id, firstName })).id;
  /** Les bornes de chaque lecture des nouveaux contacts par le passage. */
  const reads: string[] = [];
  const all = db.all.bind(db);
  vi.spyOn(db, 'all').mockImplementation(((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM persons p') && params) reads.push(String(params[1]));
    return all(sql, params);
  }) as typeof db.all);
  const runFor = async (personId: string) => db.first<{ triggered_at: string }>('SELECT triggered_at FROM automation_runs WHERE person_id = ?', [personId]);
  /** Composé, essayé et allumé à l'heure de l'horloge. */
  const lit = async (): Promise<string> => {
    const made = await scenarios.compose(direction, CALL_BACK);
    if (!made.ok) throw new Error(made.code);
    const tried = await scenarios.simulate(direction, made.value.scenarioId);
    if (!tried.ok) throw new Error(tried.code);
    const on = await scenarios.switchOn(direction, made.value.scenarioId);
    if (!on.ok) throw new Error(on.code);
    reads.length = 0;
    return made.value.scenarioId;
  };
  const tick = () => scenarios.tick(network.id);
  return { scenarios, person, reads, runFor, lit, tick, setClock: (t: number) => (clock = t) };
}

const iso = (t: number): string => new Date(t).toISOString();

describeWithSqlite('RC19 · le passage relit les faits depuis le dernier rangé', () => {
  it('[R401] sans passage rangé, la lecture part de l’allumage ; ensuite, du dernier fait rangé moins la marge', async () => {
    const t = await setup();
    t.setClock(TUE_10H - 3 * DAY);
    const avant = await t.person('Avant');
    t.setClock(TUE_10H);
    await t.lit();
    t.setClock(TUE_10H + 3 * DAY);
    expect(await t.tick()).toMatchObject({ created: 0 });
    expect(t.reads).toEqual([iso(TUE_10H)]);
    // Un fait vient ; le passage suivant ne relit plus depuis l'allumage.
    const ines = await t.person('Inès');
    t.setClock(TUE_10H + 3 * DAY + HOUR);
    expect(await t.tick()).toMatchObject({ created: 1 });
    expect((await t.runFor(ines))?.triggered_at).toBe(iso(TUE_10H + 3 * DAY));
    t.setClock(TUE_10H + 3 * DAY + 2 * HOUR);
    expect(await t.tick()).toMatchObject({ created: 0 });
    expect(t.reads.at(-1)).toBe(iso(TUE_10H + 2 * DAY));
    // Le passé d'avant l'allumage reste à l'écart [R401].
    expect(await t.runFor(avant)).toBeNull();
  });

  it('[R401] la lecture ne part jamais d’avant l’allumage, même avec une marge plus longue', async () => {
    const t = await setup({ rescanHours: 10 * 24 });
    t.setClock(TUE_10H - HOUR);
    const avant = await t.person('Avant');
    t.setClock(TUE_10H);
    await t.lit();
    t.setClock(TUE_10H + 2 * HOUR);
    await t.person('Inès');
    expect(await t.tick()).toMatchObject({ created: 1 });
    expect(await t.tick()).toMatchObject({ created: 0 });
    expect(t.reads).toEqual([iso(TUE_10H), iso(TUE_10H)]);
    expect(await t.runFor(avant)).toBeNull();
  });

  it('[R401] un fait daté dans la marge et écrit après le dernier rangé est rangé, une seule fois', async () => {
    const t = await setup();
    await t.lit();
    t.setClock(TUE_10H + 3 * DAY);
    await t.person('Inès');
    expect(await t.tick()).toMatchObject({ created: 1 });
    // Daté 23 h avant le dernier fait rangé, écrit seulement maintenant.
    t.setClock(TUE_10H + 3 * DAY - 23 * HOUR);
    const tard = await t.person('Tardif');
    t.setClock(TUE_10H + 3 * DAY + HOUR);
    expect(await t.tick()).toMatchObject({ created: 1 });
    expect((await t.runFor(tard))?.triggered_at).toBe(iso(TUE_10H + 3 * DAY - 23 * HOUR));
    expect(await t.tick()).toMatchObject({ created: 0 });
  });

  it('[R401] un fait daté avant la marge et écrit après coup ne déclenche plus rien', async () => {
    const t = await setup();
    await t.lit();
    t.setClock(TUE_10H + 3 * DAY);
    await t.person('Inès');
    expect(await t.tick()).toMatchObject({ created: 1 });
    // Après l'allumage, mais 25 h avant le dernier fait rangé : trop tard pour un message d'accueil.
    t.setClock(TUE_10H + 2 * DAY - HOUR);
    const vieux = await t.person('Ancien');
    t.setClock(TUE_10H + 3 * DAY + HOUR);
    expect(await t.tick()).toMatchObject({ created: 0 });
    expect(await t.runFor(vieux)).toBeNull();
  });

  it('[R401] la marge se règle', async () => {
    const t = await setup({ rescanHours: 1 });
    await t.lit();
    t.setClock(TUE_10H + DAY);
    await t.person('Inès');
    expect(await t.tick()).toMatchObject({ created: 1 });
    t.setClock(TUE_10H + DAY - 30 * 60_000);
    const dans = await t.person('Dedans');
    t.setClock(TUE_10H + DAY - 2 * HOUR);
    const hors = await t.person('Dehors');
    t.setClock(TUE_10H + DAY + HOUR);
    expect(await t.tick()).toMatchObject({ created: 1 });
    expect(t.reads.at(-1)).toBe(iso(TUE_10H + DAY - HOUR));
    expect(await t.runFor(dans)).not.toBeNull();
    expect(await t.runFor(hors)).toBeNull();
  });
});
