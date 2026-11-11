import { expect, it } from 'vitest';
import { FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { DATES_PURPOSE, DatesClients } from '../src/automatismes/dates-clients.ts';
import { AUTOMATION_PURPOSE, ScenariosAutomatiques } from '../src/automatismes/scenarios.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// RC10 : l'essai d'un scénario compte les messages de date du même jour [R400, R402].
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

const WRITTEN = ['automation_runs', 'automation_daily_messages', 'messages', 'trial_outbox', 'send_log', 'client_date_messages', 'automation_switches'];

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

  /** Une personne avec son mail, son anniversaire (12 octobre par défaut) et les accords des dates et des scénarios. */
  const person = async (firstName: string, opts: { month?: number; day?: number } = {}) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    await store.addConsent({ networkId: network.id, personId: p.id, purpose: DATES_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - HOUR) });
    await store.addConsent({ networkId: network.id, personId: p.id, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - HOUR) });
    await dates.recordDate(agent, { personId: p.id, kind: 'anniversaire', month: opts.month ?? 10, day: opts.day ?? 12, proof: 'dit au téléphone (test)' });
    return p.id;
  };
  const project = (personId: string) => store.createProject({ networkId: network.id, agentId: alex.id, personId, kind: 'sell' });
  /** Compose le scénario des projets de vente trois jours après les faits, puis l'essaie. */
  const trial = async () => {
    clock = TUE_10H + 3 * DAY;
    const composed = await scenarios.compose(direction, PROJECT);
    if (!composed.ok) throw new Error('compose');
    return { scenarioId: composed.value.scenarioId, report: await scenarios.simulate(direction, composed.value.scenarioId) };
  };
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const table of WRITTEN) out[table] = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
    return out;
  };
  const dateRow = async (personId: string, status: string, at: number) => {
    const dateId = (await db.first<{ id: string }>('SELECT id FROM client_dates WHERE person_id = ?', [personId]))!.id;
    await db.run("INSERT INTO client_date_messages (network_id, person_id, kind, year, date_id, status, created_at, done_at) VALUES (?, ?, 'anniversaire', 2027, ?, ?, ?, ?)", [
      network.id,
      personId,
      dateId,
      status,
      new Date(at).toISOString(),
      status === 'en_cours' ? null : new Date(at).toISOString(),
    ]);
  };
  return { db, store, unique, network, direction, scenarios, dates, person, project, trial, counts, dateRow, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('RC10 · l’essai d’un scénario compte les messages de date', () => {
  it('[R402] [R400] message de date remis le jour prévu : compté, l’allumage est refusé, l’essai n’écrit rien d’autre', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    const ines = await t.person('Inès');
    t.setClock(TUE_10H);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    t.setClock(TUE_10H + 5 * MINUTE);
    await t.project(ines);
    const before = await t.counts();
    const { scenarioId, report } = await t.trial();
    expect(report).toMatchObject({ ok: true, value: { messages: 1, persons: 1, sameDayTwice: 1, sameDayAsDate: 1, canSwitchOn: false } });
    // L'essai ne range ni message, ni passage, ni place, ni allumage [R400].
    expect(await t.counts()).toEqual(before);
    expect(await t.scenarios.switchOn(t.direction, scenarioId)).toEqual({ ok: false, rule: 'R402', code: 'same_day_twice' });
  });

  it('[R402] une date en cours de préparation ce jour compte aussi', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    const ines = await t.person('Inès');
    await t.dateRow(ines, 'en_cours', TUE_10H - 2 * MINUTE);
    t.setClock(TUE_10H + 5 * MINUTE);
    await t.project(ines);
    expect((await t.trial()).report).toMatchObject({ ok: true, value: { sameDayTwice: 1, sameDayAsDate: 1, canSwitchOn: false } });
  });

  it('[R402] fiches réunies comprises : la date d’une fiche, le projet de l’autre', async () => {
    const t = await setup();
    t.setClock(TUE_10H - HOUR);
    const kept = await t.person('Eli');
    t.setClock(TUE_10H);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    const other = (await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Eli' })).id;
    await t.store.addIdentifier({ networkId: t.network.id, personId: other, kind: 'email', value: 'eli.autre@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: other, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(TUE_10H - HOUR) });
    t.setClock(TUE_10H + 5 * MINUTE);
    await t.project(other);
    await t.unique.merge({ survivorId: kept, mergedId: other, reason: 'même personne (test)' });
    expect((await t.trial()).report).toMatchObject({ ok: true, value: { messages: 1, sameDayTwice: 1, sameDayAsDate: 1, canSwitchOn: false } });
  });

  it('[R402] un scénario allumé tient déjà le jour : la date est dite quand même, le message compté une seule fois', async () => {
    const t = await setup();
    // Un scénario des projets d'achat est allumé avant les faits.
    const buy = await t.scenarios.compose(t.direction, { ...PROJECT, name: 'Nouveau projet d’achat', projectKind: 'buy', message: { channel: 'email', text: 'Bonjour {prenom}, votre recherche est bien notée.' } });
    if (!buy.ok) throw new Error('compose');
    await t.scenarios.simulate(t.direction, buy.value.scenarioId);
    expect(await t.scenarios.switchOn(t.direction, buy.value.scenarioId)).toMatchObject({ ok: true });
    t.setClock(TUE_10H - HOUR);
    const ines = await t.person('Inès');
    t.setClock(TUE_10H);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    t.setClock(TUE_10H + 5 * MINUTE);
    await t.store.createProject({ networkId: t.network.id, agentId: null, personId: ines, kind: 'buy' });
    await t.project(ines);
    expect((await t.trial()).report).toMatchObject({ ok: true, value: { messages: 1, sameDayTwice: 1, sameDayAsDate: 1, canSwitchOn: false } });
  });

  it('[R402] message de date d’un autre jour, reporté ou refusé : rien n’est compté', async () => {
    const t = await setup();
    // Anniversaire le 11 octobre, souhaité le lundi ; le projet arrive le mardi.
    t.setClock(TUE_10H - DAY - HOUR);
    const lundi = await t.person('Lou', { month: 10, day: 11 });
    t.setClock(TUE_10H - DAY);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    t.setClock(TUE_10H - HOUR);
    const reporte = await t.person('Rémi', { month: 1, day: 1 });
    const refuse = await t.person('Rose', { month: 1, day: 2 });
    await t.dateRow(reporte, 'reporte', TUE_10H);
    await t.dateRow(refuse, 'refuse', TUE_10H);
    t.setClock(TUE_10H + 5 * MINUTE);
    for (const p of [lundi, reporte, refuse]) await t.project(p);
    const { scenarioId, report } = await t.trial();
    expect(report).toMatchObject({ ok: true, value: { messages: 3, persons: 3, sameDayTwice: 0, sameDayAsDate: 0, canSwitchOn: true } });
    expect(await t.scenarios.switchOn(t.direction, scenarioId)).toMatchObject({ ok: true });
  });
});
