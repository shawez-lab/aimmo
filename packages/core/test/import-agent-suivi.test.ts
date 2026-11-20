import { beforeEach, expect, it } from 'vitest';
import { DecisionEnvoi, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase, type SqlValue } from '../src/index.ts';
import { FOLLOW_UP_TEXT_MAX, ImportAgent, readAgentFollowUp } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from './sqlite.ts';

// AU029 · Contacts, échanges et notes inventés : example.org et des numéros 06 10 en série.
const NOW = new Date('2027-07-15T08:00:00.000Z');
const OUT_TABLES = ['send_log', 'trial_outbox', 'outbound_refs', 'send_reservations'];

interface World {
  raw: SqliteDatabase;
  db: SqlDatabase;
  fiches: FicheClient;
  unique: FicheUnique;
  importer: ImportAgent;
  net: string;
  agent: string;
  other: string;
  journal: SqlJournalStore;
}

let w: World;
const me = (): { role: 'agent'; userId: string; networkId: string } => ({ role: 'agent', userId: w.agent, networkId: w.net });
const count = async (sql: string, params: SqlValue[] = []): Promise<number> => Number((await w.db.first<{ n: number }>(sql, params))?.n ?? 0);
const snapshot = (): string => {
  const tables = w.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('journal', 'journal_entries') ORDER BY name").all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => [name, w.raw.prepare(`SELECT * FROM "${name}"`).all()]));
};
const personOf = async (email: string): Promise<string> => (await w.unique.findByIdentifier(w.net, 'email', email))[0]!.id;

/** L'export des contacts de l'ancien logiciel, avec leur identifiant Hektor. */
const CONTACTS = [
  'Id contact;Nom;Email;Téléphone portable',
  'C1;Essai1;un@example.org;06 10 00 00 01',
  'C2;Essai2;deux@example.org;06 10 00 00 02',
  'C3;Essai3;trois@example.org;',
].join('\n');

/** L'export de l'historique : échanges passés, notes, rappels à venir ou en retard, et des lignes à ne pas reprendre. */
const HISTORY = [
  'Id contact;Email;Date;Type;Commentaire;Échéance;État',
  'C1;;12/03/2027;Appel;A rappelé pour son T3, veut vendre avant l’été;;fait', // 2 : échange passé, par identifiant
  'C1;;2027-04-02;Note;Préfère être appelé le soir;;', // 3 : note de suivi
  'C1;;2027-07-01;Rappel;Relancer pour le mandat;2027-07-20;à faire', // 4 : rappel à venir
  ';deux@example.org;2027-05-10;Visite;Visite du bien de la rue Inventée;;fait', // 5 : par mail, sans identifiant
  'C2;;2027-06-30;Tâche;Envoyer l’avis de valeur;;', // 6 : tâche pas faite, échéance passée : en retard
  'C3;;2027-08-01;RDV;Rendez-vous d’estimation;;', // 7 : prévu dans le futur
  'C9;;2027-03-01;Appel;Contact inconnu;;fait', // 8 : contact absent de l'export des contacts
  ';;2027-03-01;Appel;Sans contact;;fait', // 9 : aucun contact
  'C1;;;Appel;Sans date;;fait', // 10 : aucune date
  'C1;;2027-03-01;Fax;Type inconnu;;fait', // 11 : type inconnu
  'C1;;2027-03-01;Note;;;', // 12 : note vide
  ';suivi-ailleurs@example.org;2027-03-01;Appel;Fiche d’un autre agent;;fait', // 13 : autre agent
].join('\n');

describeWithSqlite("AU029 · la reprise d'un agent garde ses échanges, ses notes de suivi et ses prochains rappels", () => {
  beforeEach(async () => {
    const raw = openMemoryDatabase();
    const db = fromSyncSqlite(raw);
    await applyMigrations(db, loadMigrations());
    const now = (): Date => NOW;
    const fiches = new FicheClient(db, { now });
    const unique = new FicheUnique(db, fiches, { now });
    const envoi = new DecisionEnvoi(db, fiches, unique, { now });
    const journal = new SqlJournalStore(db);
    const importer = new ImportAgent(db, fiches, unique, envoi, journal, { now });
    const net = (await fiches.createNetwork('Réseau test')).id;
    const agent = (await fiches.createAgent({ networkId: net, firstName: 'Nouvel', lastName: 'Agent' })).id;
    const other = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Ancien' })).id;
    const theirs = await fiches.createPerson({ networkId: net, agentId: other, firstName: 'Suivi' });
    await unique.addIdentifier({ networkId: net, agentId: other, personId: theirs.id, kind: 'email', value: 'suivi-ailleurs@example.org' });
    w = { raw, db, fiches, unique, importer, net, agent, other, journal };
  });

  it("[R84] constat reproduit : l'historique de l'ancien logiciel rejoint chaque fiche, avec ses échanges, ses notes et ses rappels", async () => {
    const r = await w.importer.run(me(), w.agent, { format: 'hektor', contacts: CONTACTS, history: HISTORY });
    if (!r.ok) throw new Error(r.code);
    expect(r.report.followUp).toMatchObject({ read: 12, history: 3, reminders: 3, known: 0, truncatedLines: [] });

    const one = await w.importer.followUpOf(me(), await personOf('un@example.org'));
    if (!one.ok) throw new Error(one.code);
    expect(one.value.history.map((h) => [h.kind, h.on, h.body, h.from])).toEqual([
      ['note', '2027-04-02', 'Préfère être appelé le soir', 'Hektor'],
      ['call', '2027-03-12', 'A rappelé pour son T3, veut vendre avant l’été', 'Hektor'],
    ]);
    expect(one.value.reminders.map((x) => [x.action, x.dueOn, x.body, x.done, x.late])).toEqual([['task', '2027-07-20', 'Relancer pour le mandat', false, false]]);

    const two = await w.importer.followUpOf(me(), await personOf('deux@example.org'));
    expect(two.ok && two.value.history.map((h) => [h.kind, h.on])).toEqual([['visit', '2027-05-10']]);
    expect(two.ok && two.value.reminders.map((x) => [x.action, x.dueOn, x.late])).toEqual([['task', '2027-06-30', true]]);

    const three = await w.importer.followUpOf(me(), await personOf('trois@example.org'));
    expect(three.ok && three.value.reminders.map((x) => [x.action, x.dueOn, x.late])).toEqual([['meeting', '2027-08-01', false]]);
  });

  it('[R84] le bilan dit chaque élément non repris, par son numéro de ligne et sa raison, sans rien deviner', async () => {
    const r = await w.importer.run(me(), w.agent, { format: 'hektor', contacts: CONTACTS, history: HISTORY });
    if (!r.ok) throw new Error(r.code);
    expect(r.report.followUp.notTaken).toEqual({
      no_contact: [9],
      unknown_contact: [8],
      other_agent: [13],
      ambiguous_contact: [],
      no_date: [10],
      unknown_type: [11],
      empty: [12],
    });
    expect(r.report.summary).toContain('6 éléments non repris, listés par leur numéro de ligne et leur raison.');
    expect(r.report.summary).toContain('3 échanges et notes repris sur leurs fiches, à leur date d\'origine.');
    expect(r.report.summary).toContain('3 rappels repris dans vos rappels : rien ne part tout seul.');
  });

  it("[R16] la fiche d'un autre agent n'est jamais touchée, et son suivi ne se lit que par lui ou la direction ; chaque refus est au journal", async () => {
    await w.importer.run(me(), w.agent, { format: 'hektor', contacts: CONTACTS, history: HISTORY });
    const theirs = await personOf('suivi-ailleurs@example.org');
    expect(await count('SELECT count(*) AS n FROM agent_import_history WHERE person_id = ?', [theirs])).toBe(0);
    expect(await w.importer.followUpOf(me(), theirs)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const mine = await personOf('un@example.org');
    expect(await w.importer.followUpOf({ role: 'agent', userId: w.other, networkId: w.net }, mine)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await w.importer.followUpOf({ role: 'compliance', userId: 'c', networkId: w.net }, mine)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.importer.followUpOf({ role: 'direction', userId: 'd', networkId: 'ailleurs' }, mine)).toMatchObject({ ok: false, code: 'unknown' });
    const byDirection = await w.importer.followUpOf({ role: 'direction', userId: 'd', networkId: w.net }, mine);
    expect(byDirection.ok && byDirection.value.history).toHaveLength(2);
    expect((await w.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(4);
  });

  it("[R18] relancé deux fois, ou l'historique seul après les contacts : rien n'est doublé", async () => {
    await w.importer.run(me(), w.agent, { format: 'hektor', contacts: CONTACTS });
    const first = await w.importer.run(me(), w.agent, { format: 'hektor', history: HISTORY });
    expect(first.ok && [first.report.followUp.history, first.report.followUp.reminders]).toEqual([3, 3]);
    const before = snapshot();
    for (const _ of [1, 2]) {
      const again = await w.importer.run(me(), w.agent, { format: 'hektor', contacts: CONTACTS, history: HISTORY });
      expect(again.ok && [again.report.followUp.history, again.report.followUp.reminders, again.report.followUp.known]).toEqual([0, 0, 6]);
    }
    expect(snapshot()).toBe(before);
  });

  it('[R03] [R17] un rappel repris est une tâche de l’agent : rien ne part, il se marque fait une fois, jamais défait', async () => {
    let out = await count("SELECT count(*) AS n FROM messages WHERE direction = 'out'");
    await w.importer.run(me(), w.agent, { format: 'hektor', contacts: CONTACTS, history: HISTORY });
    for (const t of OUT_TABLES) out += await count(`SELECT count(*) AS n FROM ${t}`);
    expect(out + (await count("SELECT count(*) AS n FROM messages WHERE direction = 'out'"))).toBe(0);

    const open = await w.importer.openReminders(me());
    if (!open.ok) throw new Error(open.code);
    expect(open.value.map((x) => [x.dueOn, x.late])).toEqual([
      ['2027-06-30', true],
      ['2027-07-20', false],
      ['2027-08-01', false],
    ]);
    expect(await w.importer.openReminders({ role: 'direction', userId: 'd', networkId: w.net })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.importer.closeReminder({ role: 'agent', userId: w.other, networkId: w.net }, open.value[0]!.id)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const done = await w.importer.closeReminder(me(), open.value[0]!.id);
    expect(done).toEqual({ ok: true, value: { id: open.value[0]!.id, closedAt: NOW.toISOString() } });
    expect(await w.importer.closeReminder(me(), open.value[0]!.id)).toEqual({ ok: false, rule: null, code: 'already_done' });
    expect(await w.importer.closeReminder(me(), 'rien')).toEqual({ ok: false, rule: null, code: 'unknown' });
    const after = await w.importer.openReminders(me());
    expect(after.ok && after.value).toHaveLength(2);
    await expect(w.db.run('DELETE FROM agent_import_reminder_closures')).rejects.toThrow(/rien ne s'efface/);
    await expect(w.db.run("UPDATE agent_import_history SET body = 'autre'")).rejects.toThrow(/ne change plus/);
    await expect(w.db.run('DELETE FROM agent_import_reminders')).rejects.toThrow(/rien ne s'efface/);
  });

  it("[R16] une fiche passée à un autre agent emporte ses rappels : l'ancien ne les voit plus", async () => {
    await w.importer.run(me(), w.agent, { format: 'hektor', contacts: CONTACTS, history: HISTORY });
    const one = await personOf('un@example.org');
    await w.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [w.other, one]);
    const open = await w.importer.openReminders(me());
    expect(open.ok && open.value.map((x) => x.dueOn)).toEqual(['2027-06-30', '2027-08-01']);
    const theirs = await w.importer.followUpOf({ role: 'agent', userId: w.other, networkId: w.net }, one);
    expect(theirs.ok && theirs.value.reminders).toHaveLength(1);
  });

  it('[R84] un contact que deux fiches de l’agent portent n’est pas deviné ; un texte trop long est coupé et signalé', async () => {
    const a = await w.fiches.createPerson({ networkId: w.net, agentId: w.agent, firstName: 'A' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.agent, personId: a.id, kind: 'email', value: 'double@example.org' });
    const b = await w.fiches.createPerson({ networkId: w.net, agentId: w.agent, firstName: 'B' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.agent, personId: b.id, kind: 'phone', value: '0610000077' });
    const long = 'x'.repeat(FOLLOW_UP_TEXT_MAX + 50);
    const csv = ['Email;Téléphone;Date;Type;Note', `double@example.org;06 10 00 00 77;2027-01-02;Appel;court`, `double@example.org;;2027-01-03;Note;${long}`].join('\n');
    const r = await w.importer.run(me(), w.agent, { format: 'excel', history: csv });
    if (!r.ok) throw new Error(r.code);
    expect(r.report.followUp.notTaken.ambiguous_contact).toEqual([2]);
    expect(r.report.followUp.truncatedLines).toEqual([3]);
    const kept = await w.db.first<{ n: number }>('SELECT length(body) AS n FROM agent_import_history');
    expect(Number(kept?.n)).toBe(FOLLOW_UP_TEXT_MAX);
  });

  it("[R13] au journal, des nombres seulement : ni texte d'échange, ni coordonnée ; la chaîne reste intacte", async () => {
    await w.importer.run(me(), w.agent, { format: 'hektor', contacts: CONTACTS, history: HISTORY });
    const text = JSON.stringify(await w.journal.all());
    expect(text).not.toMatch(/example\.org|rappelé|Relancer|Visite du bien|avis de valeur|Préfère/);
    const entry = (await w.journal.all()).find((e) => e.type === 'reseau.import');
    expect(entry?.data).toMatchObject({ history: 3, reminders: 3, followUpNotTaken: 6 });
    expect((await verifyChain(await w.journal.all())).ok).toBe(true);
  });

  it("un export d'historique sans colonne de date ni de contact est refusé, sans rien écrire", async () => {
    const before = snapshot();
    expect(await w.importer.run(me(), w.agent, { format: 'hektor', contacts: CONTACTS, history: 'Type;Commentaire\nAppel;bonjour' })).toEqual({ ok: false, rule: null, code: 'missing_columns' });
    expect(await w.importer.run(me(), w.agent, { format: 'hektor', history: 'Date;Commentaire\n2027-01-01;bonjour' })).toEqual({ ok: false, rule: null, code: 'missing_columns' });
    expect(snapshot()).toBe(before);
  });
});

it("lecture d'un historique : passé, futur, fait ou non", async () => {
  const at = new Date('2027-07-15T08:00:00.000Z');
  const csv = ['Email;Date;Type;Statut', 'a@example.org;2027-07-10;Appel;', 'a@example.org;2027-07-20;Appel;', 'a@example.org;2027-07-20;Appel;fait', 'a@example.org;2027-07-01;Rappel;terminé', 'a@example.org;2027-07-01;Rappel;'].join('\n');
  const r = await readAgentFollowUp(csv, 'excel', 'agent', at);
  expect(r.lines.map((l) => l.entry)).toEqual([
    { as: 'history', kind: 'call', on: '2027-07-10' },
    { as: 'reminder', action: 'call', on: '2027-07-20' },
    { as: 'reminder', action: 'task', on: '2027-07-01' },
  ]);
  // Un appel daté dans le futur et dit « fait » : la date ne dit pas vrai. Un rappel fait, sans texte : rien à garder.
  expect(r.skipped).toEqual([
    { line: 4, reason: 'no_date' },
    { line: 5, reason: 'empty' },
  ]);
});
