import { expect, it } from 'vitest';
import {
  FicheClient,
  RendezVous,
  SqlJournalStore,
  StatutRendezVous,
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
const WEEK: Availability = { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: '08:00', to: '18:00' })) };

async function world() {
  let clock = NOW;
  const now = () => clock;
  const setClock = (d: Date) => {
    clock = d;
  };
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  const journal = new SqlJournalStore(db);
  const rdv = new RendezVous(db, journal, { now });
  const statut = new StatutRendezVous(db, journal, { now });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  const asLise: Viewer = { role: 'agent', userId: lise.id, networkId: net.id };
  expect(await rdv.setAvailability(asPaul, WEEK)).toEqual({ ok: true });
  const book = async (start: Date) => {
    const r = await rdv.book({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'visite', start, source: 'agent' });
    if (!r.ok) throw new Error(`réservation refusée : ${r.code}`);
    return r.appointment;
  };
  return { db, net, paul, lise, lea, journal, rdv, statut, asPaul, asLise, book, setClock };
}

describeWithSqlite('V06 · statut et compte rendu', () => {
  it('seul l’agent du rendez-vous change son statut, une fois le rendez-vous commencé', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '10:00'));
    expect(await w.statut.mark(w.asLise, a.id, 'honored')).toEqual({ ok: false, code: 'not_agent' });
    expect(await w.statut.mark({ role: 'direction', userId: 'dir-1', networkId: w.net.id }, a.id, 'honored')).toEqual({ ok: false, code: 'not_agent' });
    expect(await w.statut.mark({ ...w.asPaul, networkId: 'autre' }, a.id, 'honored')).toEqual({ ok: false, code: 'unknown' });
    expect(await w.statut.mark(w.asLise, a.id, 'cancelled')).toEqual({ ok: false, code: 'not_agent' });
    expect(await w.statut.mark(w.asPaul, a.id, 'honored')).toEqual({ ok: false, code: 'too_early' });
    expect(await w.statut.mark(w.asPaul, a.id, 'perdu' as never)).toEqual({ ok: false, code: 'bad_status' });
    w.setClock(at('2026-11-10', '10:50'));
    expect(await w.statut.mark(w.asPaul, a.id, 'honored')).toMatchObject({ ok: true, appointment: { status: 'honored' }, taskId: null });
  });

  it('un statut final ne change plus, même en double clic ou par la base', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '10:00'));
    const b = await w.book(at('2026-11-10', '14:00'));
    w.setClock(at('2026-11-10', '16:00'));
    const both = await Promise.all([w.statut.mark(w.asPaul, a.id, 'honored'), w.statut.mark(w.asPaul, a.id, 'absent')]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    const status = (await w.rdv.get(a.id))!.status;
    for (const s of ['honored', 'absent', 'cancelled'] as const) expect(await w.statut.mark(w.asPaul, a.id, s)).toMatchObject({ ok: false });
    expect((await w.rdv.get(a.id))!.status).toBe(status);
    await expect(w.db.run("UPDATE appointments SET status = 'booked' WHERE id = ?", [a.id])).rejects.toThrow();
    // Annulé : par l'annulation de V02, une seule fois.
    expect(await w.statut.mark(w.asPaul, b.id, 'cancelled')).toMatchObject({ ok: true, appointment: { status: 'cancelled' } });
    expect(await w.statut.mark(w.asPaul, b.id, 'honored')).toEqual({ ok: false, code: 'not_booked' });
  });

  it('un absent ouvre une tâche de suivi chez l’agent, une seule ; l’agent la marque faite', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '10:00'));
    w.setClock(at('2026-11-10', '10:30'));
    const r = await w.statut.mark(w.asPaul, a.id, 'absent');
    if (!r.ok || !r.taskId) throw new Error('pas de tâche');
    const tasks = await w.statut.openTasks(w.asPaul);
    expect(tasks).toMatchObject([{ id: r.taskId, appointment_id: a.id, person_id: w.lea.id, kind: 'follow_absent', done_at: null }]);
    expect(await w.statut.openTasks(w.asLise)).toEqual([]);
    expect(await w.statut.taskDone(w.asLise, r.taskId)).toEqual({ ok: false, code: 'not_agent' });
    expect(await w.statut.taskDone(w.asPaul, r.taskId)).toEqual({ ok: true });
    expect(await w.statut.taskDone(w.asPaul, r.taskId)).toEqual({ ok: false, code: 'already_done' });
    expect(await w.statut.openTasks(w.asPaul)).toEqual([]);
    expect(await w.db.all('SELECT id FROM appointment_tasks')).toHaveLength(1);
    await expect(w.db.run('DELETE FROM appointment_tasks')).rejects.toThrow();
  });

  it('le compte rendu : par le seul agent, après le rendez-vous ; il ne change plus et ne s’efface pas', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '10:00'));
    expect(await w.statut.report(w.asPaul, a.id, { text: 'Trop tôt.', origin: 'typed' })).toEqual({ ok: false, code: 'not_done' });
    w.setClock(at('2026-11-10', '11:00'));
    await w.statut.mark(w.asPaul, a.id, 'honored');
    expect(await w.statut.report(w.asLise, a.id, { text: 'Pas le mien.', origin: 'typed' })).toEqual({ ok: false, code: 'not_agent' });
    expect(await w.statut.report(w.asPaul, a.id, { text: '   ', origin: 'dictated' })).toEqual({ ok: false, code: 'empty' });
    expect(await w.statut.report(w.asPaul, a.id, { text: 'x'.repeat(20_001), origin: 'typed' })).toEqual({ ok: false, code: 'too_long' });
    expect(await w.statut.report(w.asPaul, a.id, { text: 'Visite', origin: 'audio' as never })).toEqual({ ok: false, code: 'bad_origin' });
    expect(await w.statut.report(w.asPaul, a.id, { text: 'Visite agréable, la cliente rappelle jeudi.', origin: 'dictated' })).toMatchObject({ ok: true });
    expect(await w.statut.report(w.asPaul, a.id, { text: 'Complément : budget confirmé.', origin: 'typed' })).toMatchObject({ ok: true });
    const r = await w.statut.reports(w.asPaul, a.id);
    expect(r.ok && r.reports.map((x) => [x.origin, x.text])).toEqual([
      ['dictated', 'Visite agréable, la cliente rappelle jeudi.'],
      ['typed', 'Complément : budget confirmé.'],
    ]);
    expect(await w.statut.reports(w.asLise, a.id)).toEqual({ ok: false, code: 'not_agent' });
    await expect(w.db.run("UPDATE appointment_reports SET text = 'autre'")).rejects.toThrow();
    await expect(w.db.run('DELETE FROM appointment_reports')).rejects.toThrow();
  });

  it('[R13] le journal ne porte pas le texte du compte rendu', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '10:00'));
    w.setClock(at('2026-11-10', '11:00'));
    await w.statut.mark(w.asPaul, a.id, 'absent');
    await w.statut.report(w.asPaul, a.id, { text: 'Madame Exemple absente, téléphone éteint.', origin: 'dictated' });
    const dump = JSON.stringify(await w.db.all('SELECT * FROM journal'));
    for (const secret of ['Exemple', 'téléphone éteint', 'Léa']) expect(dump, secret).not.toContain(secret);
    expect(dump).toContain('rdv.compte_rendu');
    expect(dump).toContain('rdv.statut');
  });
});
