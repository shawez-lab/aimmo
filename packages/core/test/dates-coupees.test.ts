import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { DATES_PURPOSE, DatesClients, STALE_PLACE_MS } from '../src/automatismes/dates-clients.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agent, personnes et adresses inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const dates = new DatesClients(db, journal, { now, newId });
  await dates.setTexts(direction, { kind: 'anniversaire', channel: 'email', texts: ['Bonjour {prenom}, joyeux anniversaire !'] });
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Zoé' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: 'zoe@example.test' });
  await store.addConsent({ networkId: network.id, personId: person.id, purpose: DATES_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(TUE_10H - DAY) });
  const recorded = await dates.recordDate({ role: 'agent', userId: alex.id, networkId: network.id }, { personId: person.id, kind: 'anniversaire', month: 10, day: 12, proof: 'dit au téléphone (test)' });
  if (!recorded.ok) throw new Error('date non rangée');
  const dateId = recorded.value.dateId;
  /** Une place laissée `en_cours` par un passage coupé net, prise il y a `ago` millisecondes. */
  const cutPlace = (ago: number) =>
    db.run("INSERT INTO client_date_messages (network_id, person_id, kind, year, date_id, status, created_at) VALUES (?, ?, 'anniversaire', 2027, ?, 'en_cours', ?)", [
      network.id,
      person.id,
      dateId,
      new Date(clock - ago).toISOString(),
    ]);
  /** Le message que le passage coupé avait rangé, avec son sujet, sans qu'il soit encore passé au mode essai. */
  const cutMessage = async () => {
    const m = await store.recordMessage({ networkId: network.id, agentId: alex.id, personId: person.id, channel: 'email', direction: 'out', authorKind: 'system', body: 'Bonjour Zoé, joyeux anniversaire !', occurredAt: new Date(clock - 20 * MINUTE) });
    await db.run("INSERT INTO message_subjects (message_id, network_id, person_id, subject, created_at) VALUES (?, ?, ?, 'date:anniversaire:2027', ?)", [m.id, network.id, person.id, new Date(clock - 20 * MINUTE).toISOString()]);
    // Comme le contrôle central : la réservation du sujet, reliée au message.
    await db.run("INSERT INTO send_reservations (person_id, key, reservation_id, network_id, message_id, created_at) VALUES (?, 'sujet:date:anniversaire:2027', 'resa-message', ?, ?, ?)", [
      person.id,
      network.id,
      m.id,
      new Date(clock - 20 * MINUTE).toISOString(),
    ]);
    return m.id;
  };
  const outbox = () => db.all<{ person_id: string }>('SELECT m.person_id FROM trial_outbox o JOIN messages m ON m.id = o.message_id');
  const place = () => db.first<{ status: string; rule: string | null; message_id: string | null }>('SELECT status, rule, message_id FROM client_date_messages WHERE person_id = ?', [person.id]);
  const sends = () => db.all<{ outcome: string; rule: string | null }>("SELECT outcome, rule FROM send_log WHERE kind = 'follow_up' ORDER BY rowid");
  return { db, journal, store, network, alex, person, dates, now, newId, cutPlace, cutMessage, outbox, place, sends, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('RC03 · un message de date arrêté net en cours reprend seul', () => {
  it('[R405] une place coupée sans message est reprise au passage suivant : un seul message', async () => {
    const t = await setup();
    await t.cutPlace(STALE_PLACE_MS + MINUTE);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, refused: 0, recovered: 0 });
    expect(await t.outbox()).toEqual([{ person_id: t.person.id }]);
    expect(await t.place()).toMatchObject({ status: 'essai', rule: null, message_id: expect.any(String) });
    // Le passage d'après ne prépare rien de plus : la place est fermée.
    t.setClock(TUE_10H + 30 * MINUTE);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, recovered: 0 });
    expect(await t.outbox()).toHaveLength(1);
  });

  it('[R405] une place coupée juste après la réservation du contrôle central, avant le message : reprise, un seul message', async () => {
    const t = await setup();
    await t.cutPlace(STALE_PLACE_MS + MINUTE);
    // Le contrôle central avait réservé le sujet, le texte et une place du plafond du jour, puis le Worker s'est arrêté.
    const at = new Date(TUE_10H - 15 * MINUTE - 30_000).toISOString();
    await t.db.run(
      "INSERT INTO send_reservations (person_id, key, reservation_id, network_id, message_id, created_at) VALUES (?, 'sujet:date:anniversaire:2027', 'resa-coupee', ?, NULL, ?), (?, 'texte:bonjour prenom joyeux anniversaire', 'resa-coupee', ?, NULL, ?)",
      [t.person.id, t.network.id, at, t.person.id, t.network.id, at],
    );
    await t.db.run("INSERT INTO send_quota_slots (network_id, kind, day, slot, reservation_id, created_at) VALUES (?, 'follow_up', '2027-10-12', '1', 'resa-coupee', ?)", [t.network.id, at]);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, refused: 0, recovered: 0 });
    expect(await t.outbox()).toHaveLength(1);
    expect(await t.place()).toMatchObject({ status: 'essai', rule: null });
    // Rien n'est effacé : la réservation coupée est gardée, renommée [R17].
    expect(await t.db.all("SELECT key FROM send_reservations WHERE reservation_id = 'resa-coupee' ORDER BY key")).toEqual([
      { key: 'sujet:date:anniversaire:2027#coupe:resa-coupee' },
      { key: 'texte:bonjour prenom joyeux anniversaire#coupe:resa-coupee' },
    ]);
    expect(await t.db.first("SELECT slot FROM send_quota_slots WHERE reservation_id = 'resa-coupee'")).toEqual({ slot: '1#coupe:resa-coupee' });
  });

  it('[R18] une place coupée dont la réservation est encore récente reste ouverte, reprise plus tard, jamais perdue', async () => {
    const t = await setup();
    await t.cutPlace(STALE_PLACE_MS + MINUTE);
    const at = new Date(TUE_10H - STALE_PLACE_MS + MINUTE).toISOString();
    await t.db.run("INSERT INTO send_reservations (person_id, key, reservation_id, network_id, message_id, created_at) VALUES (?, 'sujet:date:anniversaire:2027', 'resa-recente', ?, NULL, ?)", [t.person.id, t.network.id, at]);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, refused: 0, recovered: 0 });
    expect(await t.place()).toMatchObject({ status: 'en_cours', message_id: null });
    expect(await t.sends()).toEqual([]);
    expect(await t.db.first("SELECT key FROM send_reservations WHERE reservation_id = 'resa-recente'")).toEqual({ key: 'sujet:date:anniversaire:2027' });
    // Plus tard, place et réservation sont toutes deux trop vieilles : la réservation est rendue, un seul message part.
    t.setClock(TUE_10H + STALE_PLACE_MS + MINUTE);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, refused: 0 });
    expect(await t.outbox()).toHaveLength(1);
    expect(await t.place()).toMatchObject({ status: 'essai' });
  });

  it('[R05] une place coupée après le message passé au mode essai est fermée avec lui, aucun second message', async () => {
    const t = await setup();
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    const first = await t.place();
    // Le passage a été coupé net juste avant de fermer sa place : le message était parti en essai.
    await t.db.run("UPDATE client_date_messages SET status = 'en_cours', message_id = NULL, done_at = NULL WHERE person_id = ?", [t.person.id]);
    t.setClock(TUE_10H + STALE_PLACE_MS + MINUTE);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, refused: 0, recovered: 1 });
    expect(await t.outbox()).toHaveLength(1);
    expect(await t.place()).toEqual({ status: 'essai', rule: null, message_id: first?.message_id });
    // Le contrôle central n'a pas été rappelé : un seul envoi au journal des envois.
    expect(await t.sends()).toEqual([{ outcome: 'sent', rule: null }]);
    const lines = await t.journal.all();
    expect(lines.filter((l) => l.type === 'dates.message').map((l) => l.data)).toEqual([
      expect.not.objectContaining({ recovered: true }),
      expect.objectContaining({ status: 'essai', recovered: true }),
    ]);
  });

  it('[R05] une place coupée après le message rangé mais pas encore livré est fermée, jamais un second envoi', async () => {
    const t = await setup();
    await t.cutPlace(STALE_PLACE_MS + MINUTE);
    const messageId = await t.cutMessage();
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, recovered: 1 });
    expect(await t.outbox()).toHaveLength(0);
    expect(await t.sends()).toEqual([]);
    expect(await t.place()).toEqual({ status: 'refuse', rule: 'R05', message_id: messageId });
  });

  it('[R05] un message coupé tombé en panne ne ferme pas la place : il est refait une fois', async () => {
    const t = await setup();
    await t.cutPlace(STALE_PLACE_MS + MINUTE);
    const messageId = await t.cutMessage();
    await t.db.run(
      "INSERT INTO send_log (id, network_id, agent_id, person_id, message_id, channel, kind, outcome, rule, reason, occurred_at, created_at) VALUES ('log-f', ?, ?, ?, ?, 'email', 'follow_up', 'failed', NULL, 'panne (test)', ?, ?)",
      [t.network.id, t.alex.id, t.person.id, messageId, t.now().toISOString(), t.now().toISOString()],
    );
    // Comme le contrôle central après une panne : la réservation est rendue, renommée.
    await t.db.run("UPDATE send_reservations SET key = key || '#panne:' || reservation_id WHERE message_id = ?", [messageId]);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, recovered: 0 });
    expect(await t.outbox()).toHaveLength(1);
    expect((await t.place())?.message_id).not.toBe(messageId);
  });

  it('[R18] une place récente, celle d’un passage en cours, n’est jamais reprise par un autre', async () => {
    const t = await setup();
    await t.cutPlace(STALE_PLACE_MS - MINUTE);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0, refused: 0, recovered: 0 });
    expect(await t.outbox()).toHaveLength(0);
    expect(await t.place()).toMatchObject({ status: 'en_cours', message_id: null });
    // Juste au délai, pas au-delà : toujours pas reprise.
    t.setClock(TUE_10H + MINUTE);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0 });
    // Passé le délai : reprise, une seule fois.
    t.setClock(TUE_10H + 2 * MINUTE);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    expect(await t.outbox()).toHaveLength(1);
  });

  it('[R18] deux passages en même temps sur une place coupée : un seul la reprend, un seul message', async () => {
    const t = await setup();
    await t.cutPlace(STALE_PLACE_MS + MINUTE);
    const second = new DatesClients(t.db, t.journal, { now: t.now, newId: () => crypto.randomUUID() });
    const reports = await Promise.all([t.dates.tick(t.network.id), second.tick(t.network.id)]);
    expect(reports.reduce((s, r) => s + r.messagesInTrial, 0)).toBe(1);
    expect(await t.outbox()).toHaveLength(1);
    expect(await t.place()).toMatchObject({ status: 'essai' });
  });
});
