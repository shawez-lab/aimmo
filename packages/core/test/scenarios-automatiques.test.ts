import { expect, it } from 'vitest';
import { FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { AUTOMATION_PURPOSE, ScenariosAutomatiques, parseScenario, renderScenarioText } from '../src/automatismes/scenarios.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agents, personnes et adresses inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const WELCOME = {
  name: 'Bienvenue',
  trigger: 'nouveau_contact',
  waitHours: 2,
  message: { channel: 'email', text: 'Bonjour {prenom}, merci pour votre demande. Je vous rappelle très vite pour en parler.' },
  task: { title: 'Appeler le nouveau contact', dueInDays: 1 },
};

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
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const scenarios = new ScenariosAutomatiques(db, journal, { now, newId });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  /** Une personne créée à l'heure de l'horloge, avec son mail et, par défaut, son accord aux messages de scénario. */
  const person = async (firstName: string, consent = true, networkId = network.id) => {
    const p = await store.createPerson({ networkId, agentId: networkId === network.id ? alex.id : null, firstName });
    await store.addIdentifier({ networkId, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    if (consent) await store.addConsent({ networkId, personId: p.id, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - HOUR) });
    return p.id;
  };
  const count = async (table: string): Promise<number> => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
  const sent = () => db.all<{ person_id: string; outcome: string; rule: string | null; kind: string }>('SELECT person_id, outcome, rule, kind FROM send_log ORDER BY rowid');
  const outbox = () => db.all<{ body: string; person_id: string }>('SELECT m.body, m.person_id FROM trial_outbox o JOIN messages m ON m.id = o.message_id ORDER BY m.rowid');
  return { db, journal, store, scenarios, network, other, alex, direction, agent, person, count, sent, outbox, setClock: (t: number) => (clock = t), clock: () => clock };
}

describeWithSqlite('HX24 · scénarios automatiques réglables, essayés avant d’être allumés', () => {
  it('[R403] [R16] seule la direction compose, en listes fermées, et chaque version est gardée', async () => {
    const t = await setup();
    expect(await t.scenarios.compose(t.agent, WELCOME)).toEqual({ ok: false, rule: 'R16', code: 'not_direction' });
    expect(await t.scenarios.simulate(t.agent, 'x')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.scenarios.switchOn(t.agent, 'x')).toMatchObject({ ok: false, rule: 'R16' });
    const bad: [unknown, string][] = [
      [{ ...WELCOME, trigger: 'anniversaire' }, 'bad_trigger'],
      [{ ...WELCOME, projectKind: 'sell' }, 'bad_project_kind'],
      [{ ...WELCOME, waitHours: -1 }, 'bad_wait'],
      [{ ...WELCOME, waitHours: 1.5 }, 'bad_wait'],
      [{ ...WELCOME, script: 'x' }, 'unknown_field'],
      [{ ...WELCOME, message: { channel: 'instagram', text: WELCOME.message.text } }, 'bad_channel'],
      [{ ...WELCOME, message: { channel: 'email', text: 'Bonjour, merci pour votre demande.' } }, 'first_name_slot'],
      [{ ...WELCOME, message: { channel: 'email', text: 'Bonjour {prenom} {prenom}, merci.' } }, 'first_name_slot'],
      [{ ...WELCOME, message: { channel: 'email', text: 'Bonjour {prenom}, {nom} merci.' } }, 'first_name_slot'],
      [{ ...WELCOME, message: { channel: 'email', text: 'Bonjour {prenom}, -10 % sur nos honoraires ce mois-ci.' } }, 'text_R10'],
      [{ ...WELCOME, message: { channel: 'email', text: 'Bonjour {prenom}, votre estimation est gratuite.' } }, 'text_R07'],
      [{ ...WELCOME, message: { channel: 'email', text: 'Bonjour {prenom}, mon assistant vous répond.' } }, 'text_R06'],
      [{ ...WELCOME, message: { channel: 'email', text: 'Bonjour {prenom}, passez au 12 rue des Lilas.' } }, 'text_R09'],
      [{ ...WELCOME, message: null, task: null }, 'empty_scenario'],
      [{ ...WELCOME, task: { title: 'Appeler', dueInDays: 31 } }, 'bad_task_due'],
      [{ ...WELCOME, message: { channel: 'sms', text: `Bonjour {prenom}, ${'merci pour votre demande. '.repeat(13)}` } }, 'text_length'],
    ];
    for (const [input, code] of bad) expect([code, await t.scenarios.compose(t.direction, input)]).toEqual([code, expect.objectContaining({ ok: false, code })]);
    const v1 = await t.scenarios.compose(t.direction, WELCOME);
    expect(v1).toMatchObject({ ok: true, value: { version: 1 } });
    const id = v1.ok ? v1.value.scenarioId : '';
    expect(await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 4 }, id)).toEqual({ ok: true, value: { scenarioId: id, version: 2 } });
    // Un scénario d'un autre réseau est inconnu ici.
    expect(await t.scenarios.compose({ ...t.direction, networkId: t.other.id }, WELCOME, id)).toEqual({ ok: false, rule: 'R16', code: 'unknown' });
    const rows = await t.db.all<{ version: number; definition: string }>('SELECT version, definition FROM automation_scenarios WHERE id = ? ORDER BY version', [id]);
    expect(rows.map((r) => [r.version, (JSON.parse(r.definition) as { waitHours: number }).waitHours])).toEqual([
      [1, 2],
      [2, 4],
    ]);
    await expect(t.db.run('UPDATE automation_scenarios SET definition = ? WHERE id = ?', ['{}', id])).rejects.toThrow(/ajout seul/);
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/merci pour votre demande/);
  });

  it('[R403] le texte reçoit le prénom, ou s’en passe sans laisser de trou', () => {
    expect(renderScenarioText('Bonjour {prenom}, merci.', 'Inès')).toBe('Bonjour Inès, merci.');
    expect(renderScenarioText('Bonjour {prenom}, merci.', null)).toBe('Bonjour, merci.');
    expect(parseScenario(WELCOME)).toMatchObject({ ok: true, value: { trigger: 'nouveau_contact', projectKind: null } });
  });

  it('[R400] l’essai rejoue le mois passé, dit messages, personnes, tâches et refus par règle, et n’envoie rien', async () => {
    const t = await setup();
    // Le mois passé : 3 contacts avec accord (dont un qui a deux fiches réunies), un sans accord, un exclu, un repris.
    t.setClock(TUE_10H - 20 * DAY);
    const ines = await t.person('Inès');
    const bruno = await t.person('Bruno');
    t.setClock(TUE_10H - 10 * DAY);
    const lise = await t.person('Lise');
    const sans = await t.person('Sans', false);
    const exclu = await t.person('Exclu');
    await t.store.addExclusion({ networkId: t.network.id, personId: exclu, reason: 'network_list', notedAt: new Date(TUE_10H - 11 * DAY) });
    const sansMail = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Muet' });
    await t.store.addConsent({ networkId: t.network.id, personId: sansMail.id, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(TUE_10H - 11 * DAY) });
    const repris = await t.person('Repris');
    await t.db.run("INSERT INTO import_keys (network_id, key, target_kind, target_id, created_at) VALUES (?, 'site:compte:1', 'person', ?, ?)", [t.network.id, repris, new Date(TUE_10H).toISOString()]);
    // Trop vieux, et d'un autre réseau : jamais dans l'essai.
    t.setClock(TUE_10H - 40 * DAY);
    await t.person('Vieux');
    t.setClock(TUE_10H - 5 * DAY);
    await t.person('Ailleurs', true, t.other.id);
    t.setClock(TUE_10H);
    const before = { messages: await t.count('messages'), send_log: await t.count('send_log'), trial_outbox: await t.count('trial_outbox'), message_kinds: await t.count('message_kinds') };
    const made = await t.scenarios.compose(t.direction, WELCOME);
    const id = made.ok ? made.value.scenarioId : '';
    const report = await t.scenarios.simulate(t.direction, id);
    expect(report).toMatchObject({ ok: true, value: { version: 1, messages: 3, persons: 3, tasks: 6, refused: { R03: 1, R02: 1, sans_coordonnee: 1 }, sameDayTwice: 0, canSwitchOn: true } });
    // Rien n'est parti ni rangé : ni message, ni journal d'envoi, ni boîte d'essai, ni passage, ni tâche [R400].
    expect({ messages: await t.count('messages'), send_log: await t.count('send_log'), trial_outbox: await t.count('trial_outbox'), message_kinds: await t.count('message_kinds') }).toEqual(before);
    for (const table of ['automation_runs', 'automation_tasks', 'automation_daily_messages']) expect([table, await t.count(table)]).toEqual([table, 0]);
    expect(await t.count('automation_simulations')).toBe(1);
    const events = await t.journal.all();
    expect(events.filter((e) => e.type === 'automatismes.essai').map((e) => e.data)).toEqual([expect.objectContaining({ rule: 'R400', messages: 3, persons: 3, sent: false })]);
    expect(JSON.stringify(events)).not.toMatch(/Inès|Bruno|Lise|example\.test|merci pour votre demande/);
    expect([ines, bruno, lise, sans].length).toBe(4);
  });

  it('[R400] allumé seulement sur l’essai récent de sa version exacte, fait après le dernier allumage du réseau', async () => {
    const t = await setup();
    const a = await t.scenarios.compose(t.direction, WELCOME);
    const id = a.ok ? a.value.scenarioId : '';
    expect(await t.scenarios.switchOn(t.direction, id)).toEqual({ ok: false, rule: 'R400', code: 'not_simulated' });
    await t.scenarios.simulate(t.direction, id);
    // Une nouvelle version efface l'effet de l'essai : il faut l'essayer de nouveau.
    await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 3 }, id);
    expect(await t.scenarios.switchOn(t.direction, id)).toEqual({ ok: false, rule: 'R400', code: 'not_simulated' });
    await t.scenarios.simulate(t.direction, id);
    t.setClock(TUE_10H + 25 * HOUR);
    expect(await t.scenarios.switchOn(t.direction, id)).toEqual({ ok: false, rule: 'R400', code: 'simulation_too_old' });
    await t.scenarios.simulate(t.direction, id);
    // Un autre scénario allumé entre l'essai et l'allumage : l'essai ne l'a pas vu, il ne vaut plus.
    const b = await t.scenarios.compose(t.direction, PROJECT);
    const other = b.ok ? b.value.scenarioId : '';
    t.setClock(TUE_10H + 26 * HOUR);
    await t.scenarios.simulate(t.direction, other);
    expect(await t.scenarios.switchOn(t.direction, other)).toEqual({ ok: true, value: { version: 1 } });
    expect(await t.scenarios.switchOn(t.direction, id)).toEqual({ ok: false, rule: 'R400', code: 'simulation_before_last_switch_on' });
    await t.scenarios.simulate(t.direction, id);
    expect(await t.scenarios.switchOn(t.direction, id)).toEqual({ ok: true, value: { version: 2 } });
    // Même à la même milliseconde : deux essais faits avant le premier allumage, le second ne vaut plus.
    const c = await t.scenarios.compose(t.direction, { ...PROJECT, projectKind: 'buy' });
    const d = await t.scenarios.compose(t.direction, { ...PROJECT, projectKind: 'rent' });
    const [cId, dId] = [c.ok ? c.value.scenarioId : '', d.ok ? d.value.scenarioId : ''];
    await t.scenarios.simulate(t.direction, cId);
    await t.scenarios.simulate(t.direction, dId);
    expect(await t.scenarios.switchOn(t.direction, cId)).toMatchObject({ ok: true });
    expect(await t.scenarios.switchOn(t.direction, dId)).toEqual({ ok: false, rule: 'R400', code: 'simulation_before_last_switch_on' });
    expect((await t.journal.all()).filter((e) => e.type === 'automatismes.allumage_refuse').map((e) => e.data['code'])).toEqual(['not_simulated', 'not_simulated', 'simulation_too_old', 'simulation_before_last_switch_on', 'simulation_before_last_switch_on']);
    await expect(t.db.run("INSERT INTO automation_switches (id, network_id, scenario_id, version, lit, simulation_id, at, seq, by) VALUES ('s9', ?, ?, 2, 1, NULL, 'x', 99, 'x')", [t.network.id, id])).rejects.toThrow();
  });

  it('[R402] un scénario qui enverrait deux fois à la même personne le même jour est refusé, seul ou avec les scénarios allumés', async () => {
    const t = await setup();
    // Inès a ouvert deux projets de vente le même jour.
    t.setClock(TUE_10H - 6 * DAY);
    const ines = await t.person('Inès');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: ines, kind: 'sell' });
    t.setClock(TUE_10H - 6 * DAY + HOUR);
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: ines, kind: 'sell' });
    t.setClock(TUE_10H);
    const p = await t.scenarios.compose(t.direction, PROJECT);
    const projectId = p.ok ? p.value.scenarioId : '';
    // Le même texte ne part jamais deux fois à la même personne : le second est compté refusé, comme au contrôle central [R05].
    expect(await t.scenarios.simulate(t.direction, projectId)).toMatchObject({ ok: true, value: { messages: 1, persons: 1, refused: { R05: 1 }, sameDayTwice: 0, canSwitchOn: true } });
    // Le scénario de bienvenue, seul : rien en double. Allumé, il rend double un scénario qui vise Inès le même jour.
    const w = await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 0 });
    const welcomeId = w.ok ? w.value.scenarioId : '';
    expect(await t.scenarios.simulate(t.direction, welcomeId)).toMatchObject({ ok: true, value: { messages: 1, sameDayTwice: 0 } });
    expect(await t.scenarios.switchOn(t.direction, welcomeId)).toMatchObject({ ok: true });
    const single = await t.scenarios.compose(t.direction, { ...PROJECT, projectKind: 'buy' });
    const singleId = single.ok ? single.value.scenarioId : '';
    t.setClock(TUE_10H - 6 * DAY + 2 * HOUR);
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: ines, kind: 'buy' });
    t.setClock(TUE_10H + HOUR);
    expect(await t.scenarios.simulate(t.direction, singleId)).toMatchObject({ ok: true, value: { messages: 1, sameDayTwice: 1, canSwitchOn: false } });
    expect(await t.scenarios.switchOn(t.direction, singleId)).toEqual({ ok: false, rule: 'R402', code: 'same_day_twice' });
    // Rien n'est parti pendant ces essais.
    expect(await t.count('send_log')).toBe(0);
  });

  it('[R401] [R03] allumé, il ne regarde que l’après, une fois par fait, et passe toujours par le contrôle central, en essai', async () => {
    const t = await setup();
    t.setClock(TUE_10H - 3 * DAY);
    const avant = await t.person('Avant');
    t.setClock(TUE_10H);
    const w = await t.scenarios.compose(t.direction, WELCOME);
    const id = w.ok ? w.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, id);
    expect(await t.scenarios.switchOn(t.direction, id)).toMatchObject({ ok: true });
    t.setClock(TUE_10H + HOUR);
    const ines = await t.person('Inès');
    const sans = await t.person('Sans', false);
    // Avant l'attente : rangés, rien de fait.
    expect(await t.scenarios.tick(t.network.id)).toEqual({ created: 2, messagesInTrial: 0, messagesRefused: 0, tasks: 0, postponed: 0 });
    t.setClock(TUE_10H + 3 * HOUR + 1000);
    expect(await t.scenarios.tick(t.network.id)).toEqual({ created: 0, messagesInTrial: 1, messagesRefused: 1, tasks: 2, postponed: 0 });
    // Le contrôle central a décidé de chacun : Inès en boîte d'essai, Sans refusée faute d'accord [R03].
    const log = await t.sent();
    expect(log).toHaveLength(2);
    expect(log).toEqual(
      expect.arrayContaining([
        { person_id: ines, outcome: 'sent', rule: null, kind: 'follow_up' },
        { person_id: sans, outcome: 'refused', rule: 'R03', kind: 'follow_up' },
      ]),
    );
    expect(await t.outbox()).toEqual([{ person_id: ines, body: expect.stringContaining('Bonjour Inès, merci pour votre demande.') }]);
    const runs = await t.db.all<{ person_id: string; status: string; message_status: string; message_rule: string | null }>('SELECT person_id, status, message_status, message_rule FROM automation_runs');
    expect(runs).toHaveLength(2);
    expect(runs).toEqual(
      expect.arrayContaining([
        { person_id: ines, status: 'fait', message_status: 'essai', message_rule: null },
        { person_id: sans, status: 'fait', message_status: 'refuse', message_rule: 'R03' },
      ]),
    );
    // Jamais le passé : Avant, créée avant l'allumage, n'a aucun passage.
    expect(runs.some((r) => r.person_id === avant)).toBe(false);
    // Les tâches vont à l'agent qui suit la fiche, pour le lendemain.
    const tasks = await t.db.all<{ person_id: string }>('SELECT agent_id, person_id, title, due_day FROM automation_tasks ORDER BY person_id');
    expect(tasks).toEqual(
      [ines, sans].sort().map((person_id) => ({ agent_id: t.alex.id, person_id, title: 'Appeler le nouveau contact', due_day: '2027-10-13' })),
    );
    // Un fait ne déclenche qu'une fois.
    t.setClock(TUE_10H + 5 * HOUR);
    expect(await t.scenarios.tick(t.network.id)).toEqual({ created: 0, messagesInTrial: 0, messagesRefused: 0, tasks: 0, postponed: 0 });
    const events = (await t.journal.all()).filter((e) => e.type === 'automatismes.passage');
    expect(events.map((e) => [e.subject, e.data['message'], e.data['mode']]).sort()).toEqual(
      [
        [`person:${ines}`, 'essai', 'essai'],
        [`person:${sans}`, 'refuse', 'essai'],
      ].sort(),
    );
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Inès|example\.test|merci pour votre demande/);
  });

  it('[R402] [R01] une personne ne reçoit qu’un message de scénario par jour, et rien le soir ni le dimanche', async () => {
    const t = await setup();
    const w = await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 0, task: null });
    const welcomeId = w.ok ? w.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, welcomeId);
    await t.scenarios.switchOn(t.direction, welcomeId);
    const p = await t.scenarios.compose(t.direction, { ...PROJECT, projectKind: null });
    const projectId = p.ok ? p.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, projectId);
    expect(await t.scenarios.switchOn(t.direction, projectId)).toMatchObject({ ok: true });
    // Samedi 19 h 50 : Inès arrive avec un projet. Les deux scénarios la visent.
    const SAT_1950 = Date.parse('2027-10-16T17:50:00.000Z');
    t.setClock(SAT_1950);
    const ines = await t.person('Inès');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: ines, kind: 'sell' });
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 2, messagesInTrial: 1, messagesRefused: 1 });
    expect((await t.outbox()).length).toBe(1);
    const runs = await t.db.all<{ message_status: string; message_rule: string | null }>('SELECT message_status, message_rule FROM automation_runs ORDER BY created_at, id');
    expect(runs.map((r) => r.message_rule)).toEqual([null, 'R402']);
    // Samedi 20 h 10 puis dimanche : un nouveau contact attend lundi 8 h, sans rien prendre [R01].
    t.setClock(Date.parse('2027-10-16T18:10:00.000Z'));
    const bruno = await t.person('Bruno');
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 1, messagesInTrial: 0, postponed: 0 });
    const due = await t.db.first<{ due_at: string }>('SELECT due_at FROM automation_runs WHERE person_id = ?', [bruno]);
    expect(due!.due_at).toBe('2027-10-18T06:00:00.000Z');
    t.setClock(Date.parse('2027-10-17T10:00:00.000Z'));
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, messagesRefused: 0 });
    t.setClock(Date.parse('2027-10-18T06:00:00.000Z'));
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    expect((await t.sent()).every((s) => s.rule !== 'R01')).toBe(true);
  });

  it('[R401] [R17] arrêté, ses passages en attente sont annulés, jamais effacés, et rien ne part plus', async () => {
    const t = await setup();
    const w = await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 24 });
    const id = w.ok ? w.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, id);
    await t.scenarios.switchOn(t.direction, id);
    t.setClock(TUE_10H + HOUR);
    await t.person('Inès');
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 1 });
    expect(await t.scenarios.switchOff(t.direction, id)).toEqual({ ok: true, value: { cancelled: 1 } });
    t.setClock(TUE_10H + 30 * HOUR);
    await t.person('Bruno');
    expect(await t.scenarios.tick(t.network.id)).toEqual({ created: 0, messagesInTrial: 0, messagesRefused: 0, tasks: 0, postponed: 0 });
    expect(await t.db.all('SELECT status FROM automation_runs')).toEqual([{ status: 'annule' }]);
    expect(await t.count('send_log')).toBe(0);
    // Rallumé, il ne reprend pas ce qui est venu pendant l'arrêt.
    t.setClock(TUE_10H + 31 * HOUR);
    await t.scenarios.simulate(t.direction, id);
    await t.scenarios.switchOn(t.direction, id);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 0 });
    expect((await t.db.all<{ lit: number }>('SELECT lit FROM automation_switches ORDER BY seq')).map((r) => r.lit)).toEqual([1, 0, 1]);
  });

  it('[R402] [R05] deux fiches réunies avant le passage ne reçoivent qu’un message de scénario ce jour-là', async () => {
    const t = await setup();
    const a = await t.scenarios.compose(t.direction, { ...WELCOME, task: null });
    const aId = a.ok ? a.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, aId);
    await t.scenarios.switchOn(t.direction, aId);
    const b = await t.scenarios.compose(t.direction, { ...PROJECT, waitHours: 2 });
    const bId = b.ok ? b.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, bId);
    expect(await t.scenarios.switchOn(t.direction, bId)).toMatchObject({ ok: true });
    // Deux fiches de la même personne : l'une arrive comme contact, l'autre ouvre un projet de vente.
    t.setClock(TUE_10H + HOUR);
    const first = await t.person('Inès');
    const second = await t.person('Ines');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: second, kind: 'sell' });
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 3 });
    // Réunies avant que les passages soient dus.
    const [survivorId, mergedId] = first > second ? [first, second] : [second, first];
    await new FicheUnique(t.db, t.store).merge({ survivorId, mergedId, reason: 'test' });
    t.setClock(TUE_10H + 3 * HOUR + 1000);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, messagesRefused: 2 });
    expect(await t.outbox()).toHaveLength(1);
    const rules = (await t.db.all<{ message_rule: string | null }>('SELECT message_rule FROM automation_runs')).map((r) => r.message_rule);
    expect(rules.filter((r) => r === null)).toHaveLength(1);
    expect(rules.filter((r) => r === 'R402')).toHaveLength(2);
  });

  it('[R400] [R402] un allumage venu pendant un essai rend cet essai caduc', async () => {
    const t = await setup();
    t.setClock(TUE_10H - 6 * DAY);
    const ines = await t.person('Inès');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: ines, kind: 'buy' });
    t.setClock(TUE_10H);
    const a = await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 0 });
    const b = await t.scenarios.compose(t.direction, { ...PROJECT, projectKind: 'buy' });
    const [aId, bId] = [a.ok ? a.value.scenarioId : '', b.ok ? b.value.scenarioId : ''];
    await t.scenarios.simulate(t.direction, bId);
    // B s'allume juste après que l'essai de A a lu les scénarios allumés, et avant qu'il range son compte rendu.
    let interleaved = false;
    const db: SqlDatabase = {
      ...t.db,
      exec: (sql) => t.db.exec(sql),
      run: (sql, params) => t.db.run(sql, params),
      first: (sql, params) => t.db.first(sql, params),
      all: async <T,>(sql: string, params?: readonly (string | number | null)[]) => {
        const rows = await t.db.all<T>(sql, params as never);
        if (!interleaved && sql.includes('FROM automation_switches s')) {
          interleaved = true;
          expect(await t.scenarios.switchOn(t.direction, bId)).toMatchObject({ ok: true });
        }
        return rows;
      },
    };
    const racing = new ScenariosAutomatiques(db, t.journal, { now: () => new Date(TUE_10H) });
    expect(await racing.simulate(t.direction, aId)).toMatchObject({ ok: true, value: { sameDayTwice: 0 } });
    expect(interleaved).toBe(true);
    expect(await racing.switchOn(t.direction, aId)).toEqual({ ok: false, rule: 'R400', code: 'simulation_before_last_switch_on' });
    // Un nouvel essai voit B, et le double du même jour.
    expect(await t.scenarios.simulate(t.direction, aId)).toMatchObject({ ok: true, value: { sameDayTwice: 1, canSwitchOn: false } });
  });

  it('[R401] un arrêt venu pendant le passage du planificateur ne laisse naître ni partir aucun passage', async () => {
    const t = await setup();
    const a = await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 0 });
    const aId = a.ok ? a.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, aId);
    await t.scenarios.switchOn(t.direction, aId);
    t.setClock(TUE_10H + HOUR);
    await t.person('Inès');
    // La direction arrête le scénario juste après que le planificateur a lu les scénarios allumés.
    let interleaved = false;
    const db: SqlDatabase = {
      ...t.db,
      exec: (sql) => t.db.exec(sql),
      run: (sql, params) => t.db.run(sql, params),
      first: (sql, params) => t.db.first(sql, params),
      all: async <T,>(sql: string, params?: readonly (string | number | null)[]) => {
        const rows = await t.db.all<T>(sql, params as never);
        if (!interleaved && sql.includes('FROM automation_switches s')) {
          interleaved = true;
          expect(await t.scenarios.switchOff(t.direction, aId)).toEqual({ ok: true, value: { cancelled: 0 } });
        }
        return rows;
      },
    };
    const racing = new ScenariosAutomatiques(db, t.journal, { now: () => new Date(TUE_10H + HOUR) });
    expect(await racing.tick(t.network.id)).toEqual({ created: 0, messagesInTrial: 0, messagesRefused: 0, tasks: 0, postponed: 0 });
    expect(interleaved).toBe(true);
    expect(await t.count('automation_runs')).toBe(0);
    expect(await t.count('send_log')).toBe(0);
  });

  it('[R402] [R03] un message refusé par le contrôle central rend la place du jour à un autre scénario', async () => {
    const t = await setup();
    const mail = await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 0, task: null });
    const mailId = mail.ok ? mail.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, mailId);
    await t.scenarios.switchOn(t.direction, mailId);
    const sms = await t.scenarios.compose(t.direction, { ...PROJECT, projectKind: null, waitHours: 1, message: { channel: 'sms', text: 'Bonjour {prenom}, votre projet est bien noté. Je reviens vers vous très vite.' } });
    const smsId = sms.ok ? sms.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, smsId);
    expect(await t.scenarios.switchOn(t.direction, smsId)).toMatchObject({ ok: true });
    // Inès a donné son accord par SMS seulement : le mail est refusé [R03], le SMS part ensuite le même jour.
    t.setClock(TUE_10H + HOUR);
    const ines = await t.person('Inès', false);
    await t.store.addIdentifier({ networkId: t.network.id, personId: ines, kind: 'phone', value: '0600000001' });
    await t.store.addConsent({ networkId: t.network.id, personId: ines, purpose: AUTOMATION_PURPOSE, channel: 'sms', proof: 'case cochée (test)', givenAt: new Date(TUE_10H) });
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: ines, kind: 'sell' });
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, messagesRefused: 1 });
    t.setClock(TUE_10H + 2 * HOUR);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, messagesRefused: 0 });
    expect((await t.sent()).map((r) => [r.outcome, r.rule])).toEqual([
      ['refused', 'R03'],
      ['sent', null],
    ]);
    // Le message parti tient la place : un troisième le même jour serait refusé.
    expect(await t.db.all('SELECT run_id IS NOT NULL AS held FROM automation_daily_messages')).toEqual([{ held: 1 }]);
  });

  it('[R400] [R402] l’essai compte chaque message prévu des scénarios allumés, même refusé hier : lecture prudente', async () => {
    const t = await setup();
    // Inès, arrivée il y a 6 jours, n'a donné son accord que par SMS.
    t.setClock(TUE_10H - 6 * DAY);
    const ines = await t.person('Inès', false);
    await t.store.addIdentifier({ networkId: t.network.id, personId: ines, kind: 'phone', value: '0600000001' });
    await t.store.addConsent({ networkId: t.network.id, personId: ines, purpose: AUTOMATION_PURPOSE, channel: 'sms', proof: 'case cochée (test)', givenAt: new Date(TUE_10H - 7 * DAY) });
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: ines, kind: 'sell' });
    t.setClock(TUE_10H);
    const mail = await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 0 });
    const mailId = mail.ok ? mail.value.scenarioId : '';
    expect(await t.scenarios.simulate(t.direction, mailId)).toMatchObject({ ok: true, value: { messages: 0, refused: { R03: 1 } } });
    await t.scenarios.switchOn(t.direction, mailId);
    const sms = await t.scenarios.compose(t.direction, { ...PROJECT, message: { channel: 'sms', text: 'Bonjour {prenom}, votre projet est bien noté. Je reviens vers vous très vite.' } });
    const smsId = sms.ok ? sms.value.scenarioId : '';
    // Le mail refusé hier faute d'accord tient quand même sa journée : l'accord peut venir d'ici le prochain fait.
    expect(await t.scenarios.simulate(t.direction, smsId)).toMatchObject({ ok: true, value: { messages: 1, sameDayTwice: 1, canSwitchOn: false } });
    expect(await t.scenarios.switchOn(t.direction, smsId)).toEqual({ ok: false, rule: 'R402', code: 'same_day_twice' });
    // Le même cas, quand le mail est vraiment parti ce jour-là : le double est toujours vu, jamais effacé par son envoi.
    await t.store.addIdentifier({ networkId: t.network.id, personId: ines, kind: 'email', value: 'ines@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: ines, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(TUE_10H) });
    t.setClock(TUE_10H + HOUR);
    const bruno = await t.person('Bruno');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: bruno, kind: 'sell' });
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    expect(await t.scenarios.simulate(t.direction, smsId)).toMatchObject({ ok: true, value: { sameDayTwice: 1, canSwitchOn: false } });
  });

  it('[R401] [R01] refusé pour l’heure par le contrôle central, le passage attend le lendemain au lieu de se clore', async () => {
    const t = await setup();
    const w = await t.scenarios.compose(t.direction, { ...WELCOME, waitHours: 0 });
    const id = w.ok ? w.value.scenarioId : '';
    await t.scenarios.simulate(t.direction, id);
    await t.scenarios.switchOn(t.direction, id);
    // Mardi 19 h 59 min 59 s : le passage commence ; quand le message arrive au contrôle central, il est 20 h.
    const BEFORE_20H = Date.parse('2027-10-12T17:59:59.000Z');
    t.setClock(BEFORE_20H);
    const ines = await t.person('Inès');
    let clock = BEFORE_20H;
    const db: SqlDatabase = {
      ...t.db,
      exec: (sql) => t.db.exec(sql),
      run: (sql, params) => t.db.run(sql, params),
      first: (sql, params) => t.db.first(sql, params),
      all: async <T,>(sql: string, params?: readonly (string | number | null)[]) => {
        if (sql.startsWith('SELECT id, first_name FROM persons WHERE id IN')) clock = BEFORE_20H + 1000;
        return t.db.all<T>(sql, params as never);
      },
    };
    const late = new ScenariosAutomatiques(db, t.journal, { now: () => new Date(clock) });
    expect(await late.tick(t.network.id)).toMatchObject({ created: 1, messagesInTrial: 0, messagesRefused: 0, tasks: 0, postponed: 1 });
    expect(await t.db.first('SELECT status, due_at FROM automation_runs WHERE person_id = ?', [ines])).toEqual({ status: 'a_faire', due_at: '2027-10-13T06:00:00.000Z' });
    expect(await t.db.all('SELECT run_id FROM automation_daily_messages')).toEqual([{ run_id: null }]);
    // Le lendemain à 8 h, il part, avec sa tâche, une seule fois.
    t.setClock(Date.parse('2027-10-13T06:00:00.000Z'));
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, tasks: 1 });
    expect(await t.count('automation_tasks')).toBe(1);
  });
});
