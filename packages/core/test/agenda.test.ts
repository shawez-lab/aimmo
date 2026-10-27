import { expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  AgendaSync,
  FakeAgenda,
  FicheClient,
  Planificateur,
  RendezVous,
  SqlJournalStore,
  agendaSyncJob,
  applyMigrations,
  fromSyncSqlite,
  parisInstant,
  type Availability,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1. Tout est inventé.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');
const WEEK: Availability = { weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [{ weekday, from: '09:00', to: '12:00' }, { weekday, from: '14:00', to: '18:00' }]) };

async function world() {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: net.id, personId: lea.id, kind: 'email', value: 'lea.exemple@example.test' });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: new Date('2026-01-01T00:00:00Z') });
  const journal = new SqlJournalStore(db);
  const agenda = new FakeAgenda();
  const now = () => NOW;
  // Le rendez-vous lit l'agenda par la synchronisation, qui écarte les événements qu'AIMMO y a écrits.
  let sync: AgendaSync;
  const rdv = new RendezVous(db, journal, { now, agenda: { busy: (a, f, t) => sync.busySource().busy(a, f, t) } });
  sync = new AgendaSync(db, journal, agenda, rdv, { now });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  await rdv.setAvailability(asPaul, WEEK);
  const book = async (start: Date) => {
    const r = await rdv.book({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'estimation', start, source: 'site' });
    if (!r.ok) throw new Error(`refusé : ${r.code}`);
    return r;
  };
  const events = () => [...(agenda.calendars.get(paul.id)?.values() ?? [])];
  return { db, journal, agenda, sync, rdv, paul, lea, asPaul, book, events };
}

describeWithSqlite('V03 · agenda de l’agent dans les deux sens', () => {
  it('un rendez-vous n’est écrit qu’une fois dans l’agenda, avec l’heure, le type et un intitulé sans coordonnée', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-10', '09:00'));
    expect(await w.sync.push()).toEqual({ written: 1, failed: 0 });
    expect(await w.sync.push()).toEqual({ written: 0, failed: 0 });
    await w.sync.run();
    expect(w.events()).toHaveLength(1);
    const [e] = w.events();
    expect(e).toMatchObject({ start: at('2026-11-10', '09:00'), end: at('2026-11-10', '10:00'), cancelled: false, key: `aimmo:${r.appointment.id}`, title: 'Estimation · AIMMO' });
    const sent = JSON.stringify(w.agenda.writes);
    for (const secret of ['Léa', 'Exemple', 'lea.exemple', '@']) expect(sent, secret).not.toContain(secret);
  });

  it('[R33] les événements de l’agent bloquent ses créneaux, pas ceux qu’AIMMO a écrits', async () => {
    const w = await world();
    w.agenda.agentEdit(w.paul.id, { start: at('2026-11-10', '14:00'), end: at('2026-11-10', '15:00') });
    await w.book(at('2026-11-10', '09:00'));
    await w.sync.push();
    const slots = (await w.rdv.freeSlotsFor(w.paul.id, 'appel', at('2026-11-10', '00:00'), at('2026-11-10', '23:59'))).map((s) => s.start.getTime());
    expect(slots).not.toContain(at('2026-11-10', '14:30').getTime());
    expect(slots).toContain(at('2026-11-10', '10:00').getTime());
    // Un événement annulé par l'agent ne bloque plus rien.
    const id = w.agenda.agentEdit(w.paul.id, { start: at('2026-11-10', '16:00'), end: at('2026-11-10', '17:00') });
    w.agenda.agentEdit(w.paul.id, { id, cancelled: true });
    const after = (await w.rdv.freeSlotsFor(w.paul.id, 'appel', at('2026-11-10', '00:00'), at('2026-11-10', '23:59'))).map((s) => s.start.getTime());
    expect(after).toContain(at('2026-11-10', '16:00').getTime());
  });

  it('annulé ou décalé par le client : le même événement suit, annulé jamais effacé', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '09:00'));
    const b = await w.book(at('2026-11-12', '09:00'));
    await w.sync.push();
    expect((await w.rdv.cancel(a.token)).ok).toBe(true);
    const moved = await w.rdv.reschedule(b.token, at('2026-11-12', '15:00'));
    expect(moved.ok).toBe(true);
    await w.sync.push();
    const events = w.events();
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.key === `aimmo:${a.appointment.id}`)).toMatchObject({ cancelled: true });
    expect(events.find((e) => e.key === `aimmo:${b.appointment.id}`)).toMatchObject({ cancelled: false, start: at('2026-11-12', '15:00') });
    // Aucun passage par « annulé » pour le rendez-vous décalé.
    expect(w.agenda.writes.filter((x) => x.event.key === `aimmo:${b.appointment.id}` && x.event.cancelled)).toHaveLength(0);
  });

  it('déplacé ou annulé par l’agent dans son agenda : le rendez-vous suit', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '09:00'));
    const b = await w.book(at('2026-11-12', '09:00'));
    await w.sync.run();
    const ea = w.events().find((e) => e.key === `aimmo:${a.appointment.id}`)!;
    const eb = w.events().find((e) => e.key === `aimmo:${b.appointment.id}`)!;
    w.agenda.agentEdit(w.paul.id, { id: ea.id, start: at('2026-11-10', '14:00'), end: at('2026-11-10', '15:00') });
    w.agenda.agentEdit(w.paul.id, { id: eb.id, cancelled: true });
    expect(await w.sync.run()).toMatchObject({ moved: 1, cancelled: 1, conflicts: 0, failed: 0 });
    const booked = await w.rdv.bookedOf(w.paul.id);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ start_at: at('2026-11-10', '14:00').toISOString(), replaces_id: a.appointment.id });
    expect((await w.rdv.get(b.appointment.id))!.status).toBe('cancelled');
    // Le créneau de 9 h est libre, celui de 14 h tenu.
    expect((await w.rdv.book({ networkId: w.paul.network_id, agentId: w.paul.id, personId: w.lea.id, kind: 'estimation', start: at('2026-11-10', '09:00'), source: 'agent' })).ok).toBe(true);
    expect(await w.rdv.book({ networkId: w.paul.network_id, agentId: w.paul.id, personId: w.lea.id, kind: 'estimation', start: at('2026-11-10', '14:00'), source: 'agent' })).toMatchObject({ ok: false, rule: 'R32' });
    // Un second passage ne refait rien.
    expect(await w.sync.run()).toMatchObject({ moved: 0, cancelled: 0, conflicts: 0 });
  });

  it('[R32] [R33] déplacé par l’agent sur un créneau refusé : le rendez-vous reste, l’événement y est remis, c’est noté', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '09:00'));
    await w.book(at('2026-11-10', '14:00'));
    await w.sync.run();
    const ea = w.events().find((e) => e.key === `aimmo:${a.appointment.id}`)!;
    w.agenda.agentEdit(w.paul.id, { id: ea.id, start: at('2026-11-10', '14:30'), end: at('2026-11-10', '15:30') });
    expect(await w.sync.run()).toMatchObject({ conflicts: 1, moved: 0 });
    expect((await w.rdv.get(a.appointment.id))!).toMatchObject({ status: 'booked', start_at: at('2026-11-10', '09:00').toISOString() });
    expect(w.events().find((e) => e.id === ea.id)!.start).toEqual(at('2026-11-10', '09:00'));
    const conflicts = (await w.journal.all()).filter((e) => e.type === 'rdv.agenda.conflit');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.data).toMatchObject({ rule: 'R32' });
  });

  it('[R33] un événement d’AIMMO déplacé ou allongé par l’agent reste occupé tant qu’il n’est pas réconcilié', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '09:00'));
    const b = await w.book(at('2026-11-12', '09:00'));
    await w.sync.run();
    const ea = w.events().find((e) => e.key === `aimmo:${a.appointment.id}`)!;
    const eb = w.events().find((e) => e.key === `aimmo:${b.appointment.id}`)!;
    w.agenda.agentEdit(w.paul.id, { id: ea.id, start: at('2026-11-10', '14:00'), end: at('2026-11-10', '15:00') });
    w.agenda.agentEdit(w.paul.id, { id: eb.id, end: at('2026-11-12', '12:00') });
    const other = { networkId: w.paul.network_id, agentId: w.paul.id, personId: w.lea.id, kind: 'appel' as const, source: 'agent' as const };
    expect(await w.rdv.book({ ...other, start: at('2026-11-10', '14:00') })).toMatchObject({ ok: false, rule: 'R33' });
    expect(await w.rdv.book({ ...other, start: at('2026-11-12', '11:00') })).toMatchObject({ ok: false, rule: 'R33' });
    // Réconcilié : le déplacement est pris, l'allongement refusé et l'événement remis à la durée du type.
    expect(await w.sync.run()).toMatchObject({ moved: 1, conflicts: 1 });
    expect(w.events().find((e) => e.id === eb.id)!.end).toEqual(at('2026-11-12', '10:00'));
    expect((await w.rdv.book({ ...other, start: at('2026-11-12', '11:00') })).ok).toBe(true);
    expect(await w.rdv.book({ ...other, start: at('2026-11-10', '14:30') })).toMatchObject({ ok: false, rule: 'R32' });
  });

  it('décalé deux fois avant l’écriture : l’événement passe au dernier, jamais deux événements', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '09:00'));
    await w.sync.push();
    const b = await w.rdv.reschedule(a.token, at('2026-11-10', '14:00'));
    if (!b.ok) throw new Error('décalage refusé');
    const c = await w.rdv.reschedule(b.token, at('2026-11-10', '16:00'));
    if (!c.ok) throw new Error('décalage refusé');
    await w.sync.push();
    const live = w.events().filter((e) => !e.cancelled);
    expect(live).toHaveLength(1);
    expect(live[0]!.start).toEqual(at('2026-11-10', '16:00'));
    expect(w.events()).toHaveLength(1);
  });

  it('une panne de l’agenda ne perd aucune réservation : notée, puis reprise', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-10', '09:00'));
    w.agenda.failWith = Object.assign(new Error('refus pour lea.exemple@example.test'), { name: 'AgendaError' });
    // Agenda en panne : aucune réservation nouvelle, faute de pouvoir vérifier ses événements [R33].
    await expect(w.rdv.book({ networkId: w.paul.network_id, agentId: w.paul.id, personId: w.lea.id, kind: 'appel', start: at('2026-11-10', '15:00'), source: 'site' })).rejects.toThrow();
    await expect(w.sync.run()).rejects.toThrow();
    expect((await w.rdv.get(r.appointment.id))!.status).toBe('booked');
    const row = await w.db.first<{ state: string; last_error: string }>('SELECT state, last_error FROM appointment_calendar WHERE appointment_id = ?', [r.appointment.id]);
    expect(row).toEqual({ state: 'error', last_error: 'AgendaError' });
    const dump = JSON.stringify(await w.journal.all());
    expect(dump).toContain('rdv.agenda.panne');
    expect(dump).not.toContain('lea.exemple');
    w.agenda.failWith = null;
    expect(await w.sync.run()).toMatchObject({ written: 1, failed: 0 });
    expect(w.events()).toHaveLength(1);
  });

  it('la tâche du planificateur passe chaque heure, une fois par créneau', async () => {
    const w = await world();
    await w.book(at('2026-11-10', '09:00'));
    const p = new Planificateur(w.db, w.journal, [agendaSyncJob(w.sync)], { now: () => at('2026-11-09', '23:00') });
    expect((await p.tick()).ran).toEqual(['rdv.agenda']);
    expect((await p.tick()).skipped).toEqual(['rdv.agenda']);
    expect(w.events()).toHaveLength(1);
  });
});
