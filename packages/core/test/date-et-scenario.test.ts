import { expect, it } from 'vitest';
import { FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { DATES_PURPOSE, DatesClients } from '../src/automatismes/dates-clients.ts';
import { AUTOMATION_PURPOSE, ScenariosAutomatiques } from '../src/automatismes/scenarios.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// RC09 : un message de date tient la place du jour des scénarios [R402, R405].
// Un mardi d'octobre, 10 h à Paris. Réseau, agents, personnes et adresses inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PROJECT = {
  name: 'Nouveau projet de vente',
  trigger: 'nouveau_projet',
  projectKind: 'sell',
  waitHours: 0,
  message: { channel: 'email', text: 'Bonjour {prenom}, votre projet de vente est bien noté. Je reviens vers vous très vite.' },
  task: null,
};

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H - 2 * DAY;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const scenarios = new ScenariosAutomatiques(db, journal, { now, newId });
  const dates = new DatesClients(db, journal, { now, newId });
  await dates.setTexts(direction, { kind: 'anniversaire', channel: 'email', texts: ['Bonjour {prenom}, joyeux anniversaire ! Belle journée à vous.'] });
  // Le scénario est allumé deux jours avant : les projets ouverts ensuite le déclenchent, sans attente.
  const composed = await scenarios.compose(direction, PROJECT);
  const scenarioId = composed.ok ? composed.value.scenarioId : '';
  await scenarios.simulate(direction, scenarioId);
  expect(await scenarios.switchOn(direction, scenarioId)).toMatchObject({ ok: true });

  /** Une personne avec son mail, son anniversaire le 12 octobre et l'accord des dates ; l'accord des scénarios par défaut. */
  const person = async (firstName: string, opts: { scenarioConsent?: boolean; month?: number; day?: number } = {}) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    await store.addConsent({ networkId: network.id, personId: p.id, purpose: DATES_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - HOUR) });
    if (opts.scenarioConsent !== false) await store.addConsent({ networkId: network.id, personId: p.id, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - HOUR) });
    await dates.recordDate(agent, { personId: p.id, kind: 'anniversaire', month: opts.month ?? 10, day: opts.day ?? 12, proof: 'dit au téléphone (test)' });
    return p.id;
  };
  /** Ouvre un projet de vente : le scénario a un passage dû tout de suite. */
  const project = (personId: string) => store.createProject({ networkId: network.id, agentId: alex.id, personId, kind: 'sell' });
  const outbox = async () => (await db.all<{ body: string; person_id: string }>('SELECT m.body, m.person_id FROM trial_outbox o JOIN messages m ON m.id = o.message_id ORDER BY m.rowid')).map((r) => [r.person_id, r.body.includes('anniversaire') ? 'date' : 'scenario']);
  const runs = () => db.all<{ status: string; message_status: string | null; message_rule: string | null }>('SELECT status, message_status, message_rule FROM automation_runs ORDER BY rowid');
  const places = () => db.all<{ person_id: string; run_id: string | null }>('SELECT person_id, run_id FROM automation_daily_messages ORDER BY rowid');
  const dateStatus = () => db.all<{ person_id: string; status: string; rule: string | null }>('SELECT person_id, status, rule FROM client_date_messages ORDER BY person_id');
  return { db, store, unique, network, scenarios, dates, person, project, outbox, runs, places, dateStatus, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('RC09 · un message de date tient la place du jour des scénarios', () => {
  it('[R402] message de date remis ce jour : le scénario dû ensuite est refusé, sa place rendue, rien ne part', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    const ines = await t.person('Inès');
    t.setClock(TUE_10H);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, sameDay: 0 });
    t.setClock(TUE_10H + 5 * MINUTE);
    await t.project(ines);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 1, messagesInTrial: 0, messagesRefused: 1 });
    expect(await t.runs()).toEqual([{ status: 'fait', message_status: 'refuse', message_rule: 'R402' }]);
    expect(await t.places()).toEqual([{ person_id: ines, run_id: null }]);
    expect(await t.outbox()).toEqual([[ines, 'date']]);
    // Le scénario n'a rien demandé au contrôle central : un seul message journalisé.
    expect((await t.db.all('SELECT 1 FROM send_log')).length).toBe(1);
  });

  it('[R402] [R405] place de scénario prise ce jour : la date attend, reportée, comptée à part, rien de plus ne part', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    const ines = await t.person('Inès');
    await t.project(ines);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    t.setClock(TUE_10H);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, refused: 0, sameDay: 1 });
    expect(await t.dateStatus()).toEqual([{ person_id: ines, status: 'reporte', rule: null }]);
    expect(await t.outbox()).toEqual([[ines, 'scenario']]);
    // Le passage suivant du même jour attend encore ; le lendemain, la date n'est plus souhaitée : jamais un jour plus tard.
    t.setClock(TUE_10H + 2 * HOUR);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, sameDay: 1 });
    t.setClock(TUE_10H + DAY);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, sameDay: 0 });
    expect(await t.outbox()).toEqual([[ines, 'scenario']]);
  });

  it('[R402] un scénario refusé par le contrôle central rend sa place : la date part au passage du même jour', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    const sans = await t.person('Sans', { scenarioConsent: false });
    await t.project(sans);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesRefused: 1 });
    expect(await t.runs()).toEqual([{ status: 'fait', message_status: 'refuse', message_rule: 'R03' }]);
    t.setClock(TUE_10H);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, sameDay: 0 });
    expect(await t.outbox()).toEqual([[sans, 'date']]);
  });

  it('[R402] une date reportée reprend au passage suivant du jour quand la place du scénario est rendue', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    const ines = await t.person('Inès');
    const run = await t.db.run(
      "INSERT INTO automation_runs (id, network_id, scenario_id, version, trigger_ref, person_id, triggered_at, due_at, status, created_at) SELECT 'run-x', ?, id, 1, 'test', ?, ?, ?, 'en_cours', ? FROM automation_scenarios LIMIT 1",
      [t.network.id, ines, new Date(TUE_10H - HOUR).toISOString(), new Date(TUE_10H - HOUR).toISOString(), new Date(TUE_10H - HOUR).toISOString()],
    );
    expect(run.changes).toBe(1);
    // Un passage de scénario en cours tient la place : la date attend.
    await t.db.run("INSERT INTO automation_daily_messages (network_id, person_id, day, run_id, created_at) VALUES (?, ?, '2027-10-12', 'run-x', ?)", [t.network.id, ines, new Date(TUE_10H - HOUR).toISOString()]);
    t.setClock(TUE_10H);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ sameDay: 1, messagesInTrial: 0 });
    // Son message est refusé : la place est rendue, la date part au passage suivant.
    await t.db.run("UPDATE automation_daily_messages SET run_id = NULL WHERE run_id = 'run-x'");
    t.setClock(TUE_10H + HOUR);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ sameDay: 0, messagesInTrial: 1 });
    expect(await t.dateStatus()).toEqual([{ person_id: ines, status: 'essai', rule: null }]);
  });

  it('[R402] une date en cours de préparation ce jour tient aussi la place : de deux passages, un seul message', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    const ines = await t.person('Inès');
    const dateId = (await t.db.first<{ id: string }>('SELECT id FROM client_dates WHERE person_id = ?', [ines]))!.id;
    // Un passage des dates a pris la place de l'année et n'a pas fini : le scénario venu en même temps ne part pas.
    await t.db.run("INSERT INTO client_date_messages (network_id, person_id, kind, year, date_id, status, created_at) VALUES (?, ?, 'anniversaire', 2027, ?, 'en_cours', ?)", [
      t.network.id,
      ines,
      dateId,
      new Date(TUE_10H - 2 * MINUTE).toISOString(),
    ]);
    t.setClock(TUE_10H);
    await t.project(ines);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, messagesRefused: 1 });
    expect(await t.runs()).toEqual([{ status: 'fait', message_status: 'refuse', message_rule: 'R402' }]);
    expect(await t.outbox()).toEqual([]);
  });

  it('[R402] fiches réunies comprises, dans les deux sens', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    // La date part sur une fiche ; le scénario vient d'une autre fiche, réunie ensuite : refusé.
    const kept = await t.person('Eli');
    t.setClock(TUE_10H);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    const other = (await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Eli' })).id;
    await t.store.addIdentifier({ networkId: t.network.id, personId: other, kind: 'email', value: 'eli.autre@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: other, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(TUE_10H - HOUR) });
    await t.unique.merge({ survivorId: kept, mergedId: other, reason: 'même personne (test)' });
    t.setClock(TUE_10H + 5 * MINUTE);
    await t.project(other);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, messagesRefused: 1 });
    expect(await t.runs()).toEqual([{ status: 'fait', message_status: 'refuse', message_rule: 'R402' }]);

    // Le scénario part sur une fiche réunie, puis la date de la fiche gardée attend.
    const sam = await t.person('Sam');
    const samOther = (await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Sam' })).id;
    await t.store.addIdentifier({ networkId: t.network.id, personId: samOther, kind: 'email', value: 'sam.autre@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: samOther, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(TUE_10H - HOUR) });
    await t.project(samOther);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    await t.unique.merge({ survivorId: sam, mergedId: samOther, reason: 'même personne (test)' });
    t.setClock(TUE_10H + HOUR);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, sameDay: 1 });
    expect((await t.outbox()).filter(([p]) => p === sam || p === samOther)).toEqual([[samOther, 'scenario']]);
  });

  it('[R402] un scénario refusé parce qu’une fiche réunie tenait déjà la place rend la sienne', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    const kept = await t.person('Eli', { scenarioConsent: false });
    const other = (await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Eli' })).id;
    // L'autre fiche tient la place du jour par un passage refusé sans la rendre (comme avant RC09) : elle compte encore.
    await t.db.run(
      "INSERT INTO automation_runs (id, network_id, scenario_id, version, trigger_ref, person_id, triggered_at, due_at, status, created_at) SELECT 'run-autre', ?, id, 1, 'test', ?, ?, ?, 'fait', ? FROM automation_scenarios LIMIT 1",
      [t.network.id, other, new Date(TUE_10H - HOUR).toISOString(), new Date(TUE_10H - HOUR).toISOString(), new Date(TUE_10H - HOUR).toISOString()],
    );
    await t.db.run("INSERT INTO automation_daily_messages (network_id, person_id, day, run_id, created_at) VALUES (?, ?, '2027-10-12', 'run-autre', ?)", [t.network.id, other, new Date(TUE_10H - HOUR).toISOString()]);
    await t.unique.merge({ survivorId: kept, mergedId: other, reason: 'même personne (test)' });
    await t.project(kept);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesRefused: 1 });
    // La place prise sous la fiche gardée est rendue : seule celle de l'autre fiche reste tenue.
    expect(await t.places()).toEqual([
      { person_id: other, run_id: 'run-autre' },
      { person_id: kept, run_id: null },
    ]);
  });

  it('[R402] un message de date d’un autre jour ne gêne pas le scénario', async () => {
    const t = await setup();
    // Anniversaire le 11 octobre, souhaité le lundi ; le projet arrive le mardi.
    t.setClock(TUE_10H - DAY - HOUR);
    const ines = await t.person('Inès', { month: 10, day: 11 });
    t.setClock(TUE_10H - DAY);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    t.setClock(TUE_10H);
    await t.project(ines);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, messagesRefused: 0 });
    expect(await t.outbox()).toEqual([
      [ines, 'date'],
      [ines, 'scenario'],
    ]);
  });
});
