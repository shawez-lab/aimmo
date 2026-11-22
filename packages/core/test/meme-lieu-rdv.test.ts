import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  DEFAULT_SLOT_SETTINGS,
  FicheClient,
  MeilleursCreneaux,
  RendezVous,
  SqlJournalStore,
  applyMigrations,
  conflictOf,
  fromSyncSqlite,
  freeSlots,
  parisInstant,
  type Availability,
  type Place,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU055 : deux visites au même bien s'enchaînent avec la marge du même lieu. Novembre 2026, Paris à UTC+1. Tout est inventé.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');
const WEEK: Availability = { weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [{ weekday, from: '09:00', to: '12:00' }, { weekday, from: '14:00', to: '18:00' }]) };
const DAY = '2026-11-10';
const MIN = 60_000;

/** Une base où la vérification d'avant ne voit aucun rendez-vous : seule la base tranche [R32]. */
function blindPrecheck(db: SqlDatabase): SqlDatabase {
  return {
    ...db,
    exec: db.exec.bind(db),
    run: db.run.bind(db),
    first: db.first.bind(db),
    all: ((sql: string, params?: unknown[]) =>
      sql.startsWith('SELECT kind, start_at, end_at, property_id FROM appointments') ? Promise.resolve([]) : db.all(sql, params as never)) as SqlDatabase['all'],
  };
}

async function world() {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  const tom = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Tom', lastName: 'Exemple' });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: new Date('2026-01-01T00:00:00Z') });
  const journal = new SqlJournalStore(db);
  const rdv = new RendezVous(db, journal, { now: () => NOW });
  const blind = new RendezVous(blindPrecheck(db), journal, { now: () => NOW });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  expect(await rdv.setAvailability(asPaul, WEEK)).toEqual({ ok: true });
  const property = async (reference: string) =>
    (await store.createProperty({ networkId: net.id, agentId: paul.id, reference, kind: 'home', postalCode: '21000', city: 'Commune test' })).id;
  const p = await property('AU055-A');
  const q = await property('AU055-B');
  const book = (start: Date, propertyId: string | null, over: { kind?: 'visite' | 'appel' | 'estimation'; personId?: string; via?: RendezVous } = {}) =>
    (over.via ?? rdv).book({ networkId: net.id, agentId: paul.id, personId: over.personId ?? lea.id, propertyId, kind: over.kind ?? 'visite', start, source: 'agent' });
  const free = (propertyId?: string | null) => rdv.freeSlotsFor(paul.id, 'visite', at(DAY, '00:00'), at(DAY, '12:00'), undefined, propertyId);
  const liveHolds = async (id: string) => (await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM appointment_holds WHERE appointment_id = ? AND released_at IS NULL', [id]))[0]!.n;
  return { db, net, paul, lea, tom, journal, rdv, blind, p, q, book, free, liveHolds };
}

describe('AU055 · la marge du même lieu, sans toucher au trajet entre deux lieux', () => {
  const visit = (start: string, propertyId: string | null) => ({ kind: 'visite' as const, start: at(DAY, start), end: new Date(at(DAY, start).getTime() + 45 * MIN), propertyId });

  it('[R700] au même bien, la marge réglée ; ailleurs, le trajet ; un bien inconnu ne vaut jamais même lieu', () => {
    const booked = [visit('09:00', 'bien-1')];
    expect(DEFAULT_SLOT_SETTINGS.samePlaceMinutes).toBe(10);
    expect(conflictOf(visit('09:55', 'bien-1'), booked, [])).toBeNull();
    expect(conflictOf(visit('09:50', 'bien-1'), booked, [])).toBe('R32');
    expect(conflictOf(visit('09:55', 'bien-2'), booked, [])).toBe('R32');
    expect(conflictOf(visit('10:15', 'bien-2'), booked, [])).toBeNull();
    expect(conflictOf(visit('09:55', null), [visit('09:00', null)], [])).toBe('R32');
    // Un appel ne demande toujours aucun trajet.
    expect(conflictOf({ kind: 'appel', start: at(DAY, '09:45'), end: at(DAY, '10:05'), propertyId: 'bien-1' }, booked, [])).toBeNull();
  });

  it('[R700] sans marge réglée, le trajet vaut aussi au même bien ; une marge hors des pas ou au-delà du trajet est refusée', () => {
    const { samePlaceMinutes: _ignored, ...withoutMargin } = DEFAULT_SLOT_SETTINGS;
    expect(conflictOf(visit('09:55', 'bien-1'), [visit('09:00', 'bien-1')], [], withoutMargin)).toBe('R32');
    const base = { availability: WEEK, kind: 'visite' as const, from: at(DAY, '00:00'), to: at(DAY, '12:00'), now: NOW, booked: [], busy: [] };
    expect(() => freeSlots({ ...base, settings: { ...DEFAULT_SLOT_SETTINGS, samePlaceMinutes: 7 } })).toThrow('même lieu');
    expect(() => freeSlots({ ...base, settings: { ...DEFAULT_SLOT_SETTINGS, samePlaceMinutes: 35 } })).toThrow('même lieu');
    expect(() => freeSlots({ ...base, settings: { ...DEFAULT_SLOT_SETTINGS, samePlaceMinutes: -5 } })).toThrow('même lieu');
    expect(freeSlots({ ...base, settings: { ...DEFAULT_SLOT_SETTINGS, samePlaceMinutes: 0 } }).length).toBeGreaterThan(0);
  });
});

describeWithSqlite('AU055 · deux visites au même bien s’enchaînent, réservées pour de vrai', () => {
  it('[R700] le constat : une seconde visite au même bien dix minutes après la première se réserve, ailleurs non', async () => {
    const w = await world();
    expect((await w.book(at(DAY, '09:00'), w.p)).ok).toBe(true); // 9:00 à 9:45
    expect(await w.book(at(DAY, '09:50'), w.p, { personId: w.tom.id })).toMatchObject({ ok: false, rule: 'R32', code: 'taken' });
    expect(await w.book(at(DAY, '09:55'), w.q, { personId: w.tom.id })).toMatchObject({ ok: false, rule: 'R32', code: 'taken' });
    expect(await w.book(at(DAY, '09:55'), null, { personId: w.tom.id })).toMatchObject({ ok: false, rule: 'R32', code: 'taken' });
    expect((await w.book(at(DAY, '09:55'), w.p, { personId: w.tom.id })).ok).toBe(true);
    // Le trajet vers un autre lieu reste entier, des deux côtés de l'enchaînement.
    expect(await w.book(at(DAY, '11:05'), w.q)).toMatchObject({ ok: false, rule: 'R32' }); // 10:40 + 25 min
    expect((await w.book(at(DAY, '11:10'), w.q)).ok).toBe(true);
  });

  it('[R700] les créneaux proposés : avec le bien, celui qui suit la visite au même bien ; sans lui, le trajet entier', async () => {
    const w = await world();
    expect((await w.book(at(DAY, '09:00'), w.p)).ok).toBe(true);
    const starts = async (propertyId?: string | null) => (await w.free(propertyId)).map((s) => s.start.getTime());
    expect((await starts(w.p))[0]).toBe(at(DAY, '10:00').getTime());
    expect((await starts(w.q))[0]).toBe(at(DAY, '10:15').getTime());
    expect((await starts())[0]).toBe(at(DAY, '10:15').getTime());
    // Chaque créneau proposé au même bien se réserve.
    expect((await w.book(at(DAY, '10:00'), w.p, { personId: w.tom.id })).ok).toBe(true);
  });

  it('[R700] [R32] la base tranche même si la vérification d’avant n’a rien vu : marge du même lieu et trajet ailleurs', async () => {
    const w = await world();
    expect((await w.book(at(DAY, '09:00'), w.p)).ok).toBe(true);
    expect(await w.book(at(DAY, '09:55'), w.q, { via: w.blind, personId: w.tom.id })).toMatchObject({ ok: false, rule: 'R32', code: 'taken' });
    expect(await w.book(at(DAY, '09:50'), w.p, { via: w.blind, personId: w.tom.id })).toMatchObject({ ok: false, rule: 'R32', code: 'taken' });
    const second = await w.book(at(DAY, '09:55'), w.p, { via: w.blind, personId: w.tom.id });
    expect(second.ok).toBe(true);
    // Un refus ne laisse aucune tranche tenue.
    const orphans = await w.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM appointment_holds h LEFT JOIN appointments a ON a.id = h.appointment_id WHERE h.released_at IS NULL AND (a.id IS NULL OR a.status <> 'booked')",
    );
    expect(orphans[0]!.n).toBe(0);
    // Un appel juste avant ou après reste possible : il ne demande ni trajet ni marge.
    expect((await w.book(at(DAY, '10:40'), null, { kind: 'appel', via: w.blind })).ok).toBe(true);
  });

  it('[R700] [R32] la première visite annulée : son trajet partagé passe à la seconde, un autre lieu reste refusé par la base', async () => {
    const w = await world();
    const first = await w.book(at(DAY, '09:00'), w.p);
    const second = await w.book(at(DAY, '09:55'), w.p, { personId: w.tom.id });
    if (!first.ok || !second.ok) throw new Error('réservation refusée');
    expect((await w.rdv.cancelAsAgent({ role: 'agent', userId: w.paul.id, networkId: w.net.id }, first.appointment.id)).ok).toBe(true);
    expect(await w.liveHolds(first.appointment.id)).toBe(0);
    // 9:00 à 9:45 ailleurs : 10 minutes avant la seconde visite, bien moins que le trajet. La base le refuse seule.
    expect(await w.book(at(DAY, '09:00'), w.q, { via: w.blind })).toMatchObject({ ok: false, rule: 'R32', code: 'taken' });
    expect(await w.book(at(DAY, '09:00'), w.q)).toMatchObject({ ok: false, rule: 'R32' });
    // Au même bien, la place libérée se reprend.
    expect((await w.book(at(DAY, '09:00'), w.p)).ok).toBe(true);
    // La seconde annulée à son tour : plus rien n'est tenu par l'une ou l'autre.
    expect((await w.rdv.cancelAsAgent({ role: 'agent', userId: w.paul.id, networkId: w.net.id }, second.appointment.id)).ok).toBe(true);
    expect(await w.liveHolds(second.appointment.id)).toBe(0);
  });

  it('[R700] décaler la seconde visite au même bien garde la marge, sans perdre l’une ni l’autre', async () => {
    const w = await world();
    expect((await w.book(at(DAY, '09:00'), w.p)).ok).toBe(true);
    const second = await w.book(at(DAY, '10:30'), w.p, { personId: w.tom.id });
    if (!second.ok) throw new Error('réservation refusée');
    expect((await w.rdv.reschedule(second.token, at(DAY, '09:50'))).ok).toBe(false);
    expect((await w.rdv.get(second.appointment.id))!.status).toBe('booked');
    const moved = await w.rdv.reschedule(second.token, at(DAY, '09:55'));
    expect(moved.ok).toBe(true);
    const booked = await w.rdv.bookedOf(w.paul.id);
    expect(booked.map((a) => a.start_at)).toEqual([at(DAY, '09:00').toISOString(), at(DAY, '09:55').toISOString()]);
  });

  it('[R700] le meilleur créneau suit la marge du même lieu, et garde le trajet ailleurs [R237]', async () => {
    const w = await world();
    const here: Place = { lat: 47.325, lon: 5.04 };
    const best = new MeilleursCreneaux(w.db, { placeOf: async () => here });
    expect((await w.book(at(DAY, '09:00'), w.p)).ok).toBe(true);
    const same = await best.rank({ agentId: w.paul.id, kind: 'visite', target: here, propertyId: w.p, free: await w.free(w.p), limit: 100 });
    expect(same.map((s) => s.start.getTime())).toContain(at(DAY, '10:00').getTime());
    const other = await best.rank({ agentId: w.paul.id, kind: 'visite', target: here, propertyId: w.q, free: await w.free(w.p), limit: 100 });
    expect(other.map((s) => s.start.getTime())).not.toContain(at(DAY, '10:00').getTime());
  });
});
