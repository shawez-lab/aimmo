import { expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  DecisionEnvoi,
  FicheClient,
  FicheUnique,
  REMINDER_WEEKDAYS,
  RappelsRendezVous,
  RendezVous,
  SqlJournalStore,
  appointmentReminderJob,
  applyMigrations,
  checkText,
  fromSyncSqlite,
  newBookingToken,
  parisInstant,
  reminderText,
  type Availability,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1 ; le lundi 9 novembre. Tout est inventé.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const WEEK: Availability = {
  weekly: [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
    { weekday, from: '08:00', to: '12:00' },
    { weekday, from: '14:00', to: '18:00' },
  ]),
};
const LINK = 'https://rdv.example.test/r/';

async function world() {
  let clock = NOW;
  const now = () => clock;
  const setClock = (d: Date) => {
    clock = d;
  };
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const fiche = new FicheUnique(db, store);
  const decisions = new DecisionEnvoi(db, store, fiche);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: net.id, personId: lea.id, kind: 'email', value: 'lea.exemple@example.test' });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  const journal = new SqlJournalStore(db);
  const rdv = new RendezVous(db, journal, { now, linkBase: LINK });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  expect(await rdv.setAvailability(asPaul, WEEK)).toEqual({ ok: true });
  const tokens: string[] = [];
  const rappels = new RappelsRendezVous(db, journal, {
    now,
    linkBase: LINK,
    newToken: () => {
      const t = newBookingToken();
      tokens.push(t);
      return t;
    },
  });
  const book = async (start: Date, over: Partial<Parameters<RendezVous['book']>[0]> = {}) => {
    const r = await rdv.book({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'visite', start, source: 'site', channel: 'email', ...over });
    if (!r.ok) throw new Error(`réservation refusée : ${r.code}`);
    return r;
  };
  const outbox = () => db.all<{ message_id: string }>('SELECT message_id FROM trial_outbox');
  const bodies = async () => (await db.all<{ body: string }>("SELECT body FROM messages WHERE direction = 'out' ORDER BY occurred_at, rowid")).map((m) => m.body);
  const runAt = (d: Date) => {
    setClock(d);
    return rappels.run();
  };
  return { db, store, net, paul, lea, journal, rdv, rappels, decisions, asPaul, tokens, book, outbox, bodies, runAt, setClock };
}

describeWithSqlite('V04 · rappels la veille et le jour même', () => {
  it('[R05] un rappel la veille et un le jour même, chacun une seule fois, avec un lien qui sert à ce rendez-vous', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-11', '09:00'));
    expect(await w.runAt(at('2026-11-10', '10:00'))).toEqual([{ appointmentId: r.appointment.id, kind: 'veille', status: 'sent', rule: null, delivered: false }]);
    expect(await w.runAt(at('2026-11-10', '11:00'))).toEqual([]);
    expect(await w.runAt(at('2026-11-11', '08:00'))).toEqual([{ appointmentId: r.appointment.id, kind: 'jour', status: 'sent', rule: null, delivered: false }]);
    expect(await w.runAt(at('2026-11-11', '08:30'))).toEqual([]);
    expect(await w.outbox()).toHaveLength(3); // confirmation, veille, jour
    const [, veille, jour] = await w.bodies();
    expect(veille).toContain('Bonjour Léa, petit rappel : votre visite est prévue demain, le mercredi 11 novembre à 9 h.');
    expect(jour).toContain('aujourd’hui, le mercredi 11 novembre à 9 h.');
    expect(veille).toContain(`${LINK}${w.tokens[0]}`);
    expect(jour).toContain(`${LINK}${w.tokens[1]}`);
    // Le lien du rappel ne sert qu'à son rendez-vous : il l'annule, et rien ne part ensuite.
    const other = await w.book(at('2026-11-12', '09:00'));
    w.setClock(at('2026-11-11', '08:40'));
    expect(await w.rdv.cancel(w.tokens[1]!)).toMatchObject({ ok: true, appointment: { id: r.appointment.id, status: 'cancelled' } });
    expect((await w.rdv.get(other.appointment.id))!.status).toBe('booked');
    expect(await w.rdv.cancel(w.tokens[0]!)).toEqual({ ok: false, code: 'not_booked' });
  });

  it('[R05] deux passages en même temps : un seul rappel', async () => {
    const w = await world();
    await w.book(at('2026-11-11', '09:00'));
    w.setClock(at('2026-11-10', '10:00'));
    const results = await Promise.all([w.rappels.run(), w.rappels.run(), w.rappels.run()]);
    expect(results.flat().filter((o) => o.status === 'sent')).toHaveLength(1);
    expect(await w.outbox()).toHaveLength(2);
  });

  it('[R01] aucun rappel le dimanche ni hors des heures d’envoi ; un rappel manqué n’est pas reporté', async () => {
    const w = await world();
    const monday = await w.book(at('2026-11-16', '10:00'));
    const wednesday = await w.book(at('2026-11-11', '15:00'));
    // Le dimanche 15 : la veille du lundi, refusée pour l'heure [R01].
    expect(await w.runAt(at('2026-11-15', '10:00'))).toEqual([{ appointmentId: monday.appointment.id, kind: 'veille', status: 'waiting', rule: 'R01', delivered: false }]);
    // Le mardi soir : la veille du mercredi, refusée pour l'heure [R01].
    expect(await w.runAt(at('2026-11-10', '21:00'))).toEqual([{ appointmentId: wednesday.appointment.id, kind: 'veille', status: 'waiting', rule: 'R01', delivered: false }]);
    expect(await w.outbox()).toHaveLength(2); // les deux confirmations seulement
    // Le lendemain, la veille n'a plus de sens : seul le rappel du jour part.
    expect(await w.runAt(at('2026-11-11', '08:00'))).toEqual([{ appointmentId: wednesday.appointment.id, kind: 'jour', status: 'sent', rule: null, delivered: false }]);
    expect(await w.runAt(at('2026-11-16', '08:00'))).toEqual([{ appointmentId: monday.appointment.id, kind: 'jour', status: 'sent', rule: null, delivered: false }]);
    expect(await w.outbox()).toHaveLength(4);
    // La tâche ne passe pas le dimanche.
    expect(REMINDER_WEEKDAYS).not.toContain(7);
    expect(appointmentReminderJob(w.db, w.journal).weekdays).toEqual(REMINDER_WEEKDAYS);
  });

  it('rien pour un rendez-vous annulé ni pour un rendez-vous sans canal', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-11', '09:00'));
    await w.book(at('2026-11-11', '15:00'), { channel: null });
    expect(await w.rdv.cancelAsAgent(w.asPaul, r.appointment.id)).toMatchObject({ ok: true });
    expect(await w.runAt(at('2026-11-10', '10:00'))).toEqual([]);
    expect(await w.runAt(at('2026-11-11', '08:00'))).toEqual([]);
    expect(await w.outbox()).toHaveLength(1);
  });

  it('[R02] jamais à une personne exclue', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-11', '09:00'));
    await w.decisions.recordExclusion({ networkId: w.net.id, personId: w.lea.id, at: at('2026-11-09', '09:00'), reason: 'refused' });
    expect(await w.runAt(at('2026-11-10', '10:00'))).toEqual([{ appointmentId: r.appointment.id, kind: 'veille', status: 'refused', rule: 'R02', delivered: false }]);
    expect(await w.runAt(at('2026-11-10', '11:00'))).toEqual([]);
    expect(await w.outbox()).toHaveLength(1);
  });

  it('[R04] jamais à une personne qui a demandé l’arrêt, sur n’importe quel canal', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-11', '09:00'));
    await w.decisions.recordStopRequest({ networkId: w.net.id, personId: w.lea.id, at: at('2026-11-09', '09:00') });
    expect(await w.runAt(at('2026-11-10', '10:00'))).toEqual([{ appointmentId: r.appointment.id, kind: 'veille', status: 'refused', rule: 'R04', delivered: false }]);
    expect(await w.outbox()).toHaveLength(1);
  });

  it('[R03] sans accord pour les rendez-vous, aucun rappel', async () => {
    const w = await world();
    const marc = await w.store.createPerson({ networkId: w.net.id, firstName: 'Marc' });
    await w.store.addIdentifier({ networkId: w.net.id, personId: marc.id, kind: 'email', value: 'marc.exemple@example.test' });
    const r = await w.book(at('2026-11-11', '09:00'), { personId: marc.id });
    expect(await w.runAt(at('2026-11-10', '10:00'))).toEqual([{ appointmentId: r.appointment.id, kind: 'veille', status: 'refused', rule: 'R03', delivered: false }]);
    expect(await w.outbox()).toHaveLength(0);
  });

  it('[R01] une confirmation en attente part au premier passage dans les heures d’envoi, une seule fois [R05]', async () => {
    const w = await world();
    w.setClock(at('2026-11-09', '21:30'));
    const r = await w.book(at('2026-11-12', '09:00'));
    expect(r.appointment.confirmation_status).toBe('waiting');
    expect(await w.outbox()).toHaveLength(0);
    expect(await w.runAt(at('2026-11-09', '22:00'))).toEqual([{ appointmentId: r.appointment.id, kind: 'confirmation', status: 'waiting', rule: 'R01', delivered: false }]);
    expect(await w.runAt(at('2026-11-10', '08:00'))).toEqual([{ appointmentId: r.appointment.id, kind: 'confirmation', status: 'sent', rule: null, delivered: false }]);
    const sentToken = w.tokens.at(-1)!;
    expect((await w.rdv.get(r.appointment.id))!.confirmation_status).toBe('sent');
    expect(await w.runAt(at('2026-11-10', '09:00'))).toEqual([]);
    const [confirmation] = await w.bodies();
    expect(confirmation).toContain('Bonjour Léa, votre visite est réservée le jeudi 12 novembre à 9 h.'); // [R54]
    expect(confirmation).toContain(`${LINK}${sentToken}`);
    expect((await w.rdv.byToken(sentToken))!.id).toBe(r.appointment.id);
    // Puis la veille et le jour même, normalement.
    expect((await w.runAt(at('2026-11-11', '10:00'))).map((o) => [o.kind, o.status])).toEqual([['veille', 'sent']]);
    expect((await w.runAt(at('2026-11-12', '08:00'))).map((o) => [o.kind, o.status])).toEqual([['jour', 'sent']]);
    expect(await w.outbox()).toHaveLength(3);
  });

  it('jamais deux messages le même jour pour le même rendez-vous : la confirmation du jour tient lieu de rappel', async () => {
    const w = await world();
    // Réservé lundi pour mardi : la confirmation part lundi, la veille.
    const r = await w.book(at('2026-11-10', '09:00'));
    expect(await w.runAt(at('2026-11-09', '10:00'))).toEqual([{ appointmentId: r.appointment.id, kind: 'veille', status: 'skipped', rule: null, delivered: false }]);
    expect(await w.runAt(at('2026-11-10', '08:00'))).toEqual([{ appointmentId: r.appointment.id, kind: 'jour', status: 'sent', rule: null, delivered: false }]);
    // Réservé le soir pour le surlendemain : la confirmation en attente part le lendemain, la veille, et le rappel de
    // la veille est sans objet.
    w.setClock(at('2026-11-10', '21:00'));
    const s = await w.book(at('2026-11-12', '15:00'));
    expect((await w.runAt(at('2026-11-11', '08:00'))).map((o) => [o.kind, o.status])).toEqual([
      ['confirmation', 'sent'],
      ['veille', 'skipped'],
    ]);
    expect((await w.runAt(at('2026-11-12', '08:00'))).filter((o) => o.appointmentId === s.appointment.id).map((o) => [o.kind, o.status])).toEqual([['jour', 'sent']]);
    expect(await w.outbox()).toHaveLength(4);
  });

  it('le texte du rappel passe le contrôle du texte [R06] [R08] [R09] [R10]', () => {
    const start = at('2026-11-10', '14:30');
    for (const name of ['Léa', null]) {
      for (const kind of ['estimation', 'visite', 'signature', 'appel'] as const) {
        for (const which of ['veille', 'jour'] as const) {
          const { text, figures } = reminderText(which, kind, start, name, `${LINK}${newBookingToken()}`);
          expect(checkText(text, { audience: 'client', channel: 'email', figures, firstOfConversation: name !== null, firstName: name }), text).toEqual([]);
        }
      }
    }
    expect(reminderText('jour', 'estimation', start, null, null).text).toBe('Bonjour, petit rappel : votre rendez-vous d’estimation est prévu aujourd’hui, le mardi 10 novembre à 14 h 30.');
    expect(() => new RappelsRendezVous(null as never, null as never, { linkBase: 'https://rdv.example.test/r1/' })).toThrow();
  });

  it('[R13] le journal ne porte ni texte, ni nom, ni coordonnée, ni jeton', async () => {
    const w = await world();
    await w.book(at('2026-11-11', '09:00'));
    await w.runAt(at('2026-11-10', '10:00'));
    const dump = JSON.stringify(await w.db.all('SELECT * FROM journal'));
    for (const secret of ['Léa', 'Exemple', 'lea.exemple', 'rappel :', ...w.tokens]) expect(dump, secret).not.toContain(secret);
    expect(dump).toContain('rdv.rappel.essai');
  });
});
