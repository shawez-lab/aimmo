import { expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  Acces,
  DEFAULT_SLOT_SETTINGS,
  FicheClient,
  FicheUnique,
  RendezVous,
  SqlJournalStore,
  applyMigrations,
  freeSlots,
  fromSyncSqlite,
  parisInstant,
  validDuration,
  type Availability,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU056 · Novembre 2026 : Paris est à UTC+1. Tout est inventé.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const WEEK: Availability = {
  weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, from: '09:00', to: '12:00' },
    { weekday, from: '14:00', to: '18:00' },
  ]),
};
const MINUTE = 60_000;

async function world() {
  const now = () => NOW;
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: net.id, personId: lea.id, kind: 'email', value: 'lea.exemple@example.test' });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  const journal = new SqlJournalStore(db);
  const rdv = new RendezVous(db, journal, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  const asLise: Viewer = { role: 'agent', userId: lise.id, networkId: net.id };
  expect(await rdv.setAvailability(asPaul, WEEK)).toEqual({ ok: true });
  const base = { networkId: net.id, agentId: paul.id, personId: lea.id } as const;
  return { db, journal, net, paul, lea, rdv, acces, asPaul, asLise, base };
}

const minutesOf = (a: { start_at: string; end_at: string }) => (Date.parse(a.end_at) - Date.parse(a.start_at)) / MINUTE;

describeWithSqlite('AU056 · la durée propre d’un rendez-vous', () => {
  it('[R32] un rendez-vous chez le notaire de 90 minutes : le conflit se contrôle sur ces 90 minutes', async () => {
    const w = await world();
    const notaire = await w.rdv.book({ ...w.base, kind: 'signature', start: at('2026-11-10', '09:00'), source: 'agent', durationMinutes: 90 });
    expect(notaire.ok).toBe(true);
    if (!notaire.ok) return;
    expect(minutesOf(notaire.appointment)).toBe(90);
    // Avec la durée du type (60 minutes), un appel à 10:15 serait libre ; avec 90 minutes, il chevauche.
    expect(await w.rdv.book({ ...w.base, kind: 'appel', start: at('2026-11-10', '10:15'), source: 'agent' })).toMatchObject({ ok: false, rule: 'R32', code: 'taken' });
    // Un rendez-vous sur place garde le trajet après les 90 minutes : 10:30 + 30 minutes.
    expect(await w.rdv.book({ ...w.base, kind: 'visite', start: at('2026-11-10', '10:45'), source: 'agent' })).toMatchObject({ ok: false, rule: 'R32' });
    expect(await w.rdv.book({ ...w.base, kind: 'visite', start: at('2026-11-10', '11:00'), source: 'agent' })).toMatchObject({ ok: true });
  });

  it('[R32] une contre-visite de 20 minutes ne bloque que ses 20 minutes, trajet compris', async () => {
    const w = await world();
    const contre = await w.rdv.book({ ...w.base, kind: 'visite', start: at('2026-11-10', '14:00'), source: 'agent', durationMinutes: 20 });
    expect(contre.ok && minutesOf(contre.appointment)).toBe(20);
    // 14:20 + 30 minutes de trajet : 14:50 est libre, alors qu'avec 45 minutes il faudrait attendre 15:15.
    expect(await w.rdv.book({ ...w.base, kind: 'visite', start: at('2026-11-10', '14:45'), source: 'agent' })).toMatchObject({ ok: false, rule: 'R32' });
    expect(await w.rdv.book({ ...w.base, kind: 'visite', start: at('2026-11-10', '14:50'), source: 'agent' })).toMatchObject({ ok: true });
  });

  it('[R33] la durée choisie doit tenir dans les disponibilités', async () => {
    const w = await world();
    // 11:00 + 90 minutes dépasse la plage du matin (12:00) ; 11:00 + 60 minutes y tient.
    expect(await w.rdv.book({ ...w.base, kind: 'signature', start: at('2026-11-10', '11:00'), source: 'agent', durationMinutes: 90 })).toMatchObject({ ok: false, rule: 'R33', code: 'outside_availability' });
    expect(await w.rdv.book({ ...w.base, kind: 'signature', start: at('2026-11-10', '11:00'), source: 'agent' })).toMatchObject({ ok: true });
  });

  it('une durée propre vient de l’agent seul, en minutes entières par pas de 5, de 10 minutes à 8 heures', async () => {
    const w = await world();
    const start = at('2026-11-10', '09:00');
    expect(await w.rdv.book({ ...w.base, kind: 'estimation', start, source: 'site', durationMinutes: 20 })).toEqual({ ok: false, rule: null, code: 'bad_duration' });
    for (const bad of [0, 5, 22, 12.5, 485, Number.NaN]) {
      expect(await w.rdv.book({ ...w.base, kind: 'estimation', start, source: 'agent', durationMinutes: bad })).toEqual({ ok: false, rule: null, code: 'bad_duration' });
    }
    expect([10, 20, 90, 480].every(validDuration)).toBe(true);
    expect(await w.db.first('SELECT COUNT(*) AS n FROM appointments')).toEqual({ n: 0 });
  });

  it('[R32] un rendez-vous de 90 minutes déplacé dans l’agenda garde ses 90 minutes', async () => {
    const w = await world();
    const notaire = await w.rdv.book({ ...w.base, kind: 'signature', start: at('2026-11-10', '09:00'), source: 'agent', durationMinutes: 90 });
    if (!notaire.ok) throw new Error('réservation attendue');
    const moved = await w.rdv.moveFromAgenda(notaire.appointment.id, at('2026-11-12', '14:00'));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.appointment.start_at).toBe(at('2026-11-12', '14:00').toISOString());
    expect(minutesOf(moved.appointment)).toBe(90);
    // Un rendez-vous à la durée du type la garde aussi.
    const simple = await w.rdv.book({ ...w.base, kind: 'estimation', start: at('2026-11-13', '09:00'), source: 'site' });
    if (!simple.ok) throw new Error('réservation attendue');
    const simpleMoved = await w.rdv.moveFromAgenda(simple.appointment.id, at('2026-11-13', '14:00'));
    expect(simpleMoved.ok && minutesOf(simpleMoved.appointment)).toBe(DEFAULT_SLOT_SETTINGS.durations.estimation);
  });

  it('[R33] les créneaux libres d’une durée propre tiennent tout entiers dans la plage', () => {
    const slots = freeSlots({
      availability: { weekly: [{ weekday: 2, from: '09:00', to: '12:00' }] },
      kind: 'signature',
      durationMinutes: 90,
      from: at('2026-11-10', '00:00'),
      to: at('2026-11-11', '00:00'),
      now: NOW,
      booked: [],
      busy: [],
    });
    expect(slots.at(-1)!.start.toISOString()).toBe(at('2026-11-10', '10:30').toISOString());
    expect(slots.every((s) => s.end.getTime() - s.start.getTime() === 90 * MINUTE)).toBe(true);
    expect(() => freeSlots({ availability: WEEK, kind: 'visite', durationMinutes: 7, from: NOW, to: NOW, now: NOW, booked: [], busy: [] })).toThrow();
  });

  it('[R16] l’agent réserve pour son client seulement ; la direction n’a pas d’agenda', async () => {
    const w = await world();
    const input = { personId: w.lea.id, kind: 'signature' as const, start: at('2026-11-10', '09:00'), durationMinutes: 90 };
    expect(await w.rdv.bookAsAgent({ role: 'direction', userId: 'dir-1', networkId: w.net.id }, w.acces, input)).toMatchObject({ ok: false, rule: 'R16', code: 'not_agent' });
    expect(await w.rdv.bookAsAgent(w.asLise, w.acces, input)).toMatchObject({ ok: false, rule: 'R16' });
    // Une visite passe par sa route, avec son bon et le contrôle de la diffusion [R40, R42].
    expect(await w.rdv.bookAsAgent(w.asPaul, w.acces, { ...input, kind: 'visite', durationMinutes: 20 })).toEqual({ ok: false, rule: 'R40', code: 'visit_route' });
    const ok = await w.rdv.bookAsAgent(w.asPaul, w.acces, input);
    expect(ok.ok).toBe(true);
    if (!ok.ok || !('appointment' in ok)) return;
    expect(ok.appointment).toMatchObject({ agent_id: w.paul.id, source: 'agent', kind: 'signature', confirmation_status: null });
    expect(minutesOf(ok.appointment)).toBe(90);
    const refusals = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(2);
  });
});
