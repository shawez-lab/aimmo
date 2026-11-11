import { expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  FicheClient,
  RendezVous,
  SqlJournalStore,
  applyMigrations,
  checkText,
  confirmationText,
  fromSyncSqlite,
  newBookingToken,
  parisInstant,
  type Availability,
  type Viewer,
} from '../src/index.ts';
import { MASKED_SECRET } from '../src/envoi/controle.ts';
import { remis, tablesContenant } from './boite-essai.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1. Tout est inventé.
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
const LINK = 'https://rdv.example.test/r/';

async function world(options: { busy?: { start: Date; end: Date }[] } = {}) {
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
  await store.addIdentifier({ networkId: net.id, personId: lea.id, kind: 'email', value: 'lea.exemple@example.test' });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  const journal = new SqlJournalStore(db);
  const busy = options.busy ?? [];
  const rdv = new RendezVous(db, journal, { now, linkBase: LINK, agenda: { busy: async () => busy } });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  expect(await rdv.setAvailability(asPaul, WEEK)).toEqual({ ok: true });
  const book = (start: Date, over: Partial<Parameters<RendezVous['book']>[0]> = {}) =>
    rdv.book({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'estimation', start, source: 'site', ...over });
  return { db, store, net, paul, lise, lea, journal, rdv, asPaul, book, setClock };
}

const noOverlap = (rows: { start_at: string; end_at: string }[]) => {
  const sorted = [...rows].sort((a, b) => a.start_at.localeCompare(b.start_at));
  for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start_at >= sorted[i - 1]!.end_at).toBe(true);
};

describeWithSqlite('V02 · réservation, confirmation et annulation', () => {
  it('[R33] l’agent seul fixe ses disponibilités ; rien hors de ses plages ni sur un événement occupé', async () => {
    const w = await world({ busy: [{ start: at('2026-11-10', '14:00'), end: at('2026-11-10', '15:00') }] });
    expect(await w.rdv.setAvailability({ role: 'direction', userId: 'dir-1', networkId: w.net.id }, WEEK)).toEqual({ ok: false, code: 'not_agent' });
    expect(await w.rdv.setAvailability(w.asPaul, { weekly: [{ weekday: 1, from: '12:00', to: '10:00' }] })).toEqual({ ok: false, code: 'invalid' });
    expect(await w.book(at('2026-11-10', '12:30'))).toMatchObject({ ok: false, rule: 'R33', code: 'outside_availability' });
    expect(await w.book(at('2026-11-14', '10:00'))).toMatchObject({ ok: false, rule: 'R33', code: 'outside_availability' });
    expect(await w.book(at('2026-11-10', '14:30'))).toMatchObject({ ok: false, rule: 'R33', code: 'agenda_busy' });
    expect(await w.book(at('2026-11-10', '09:00'), { agentId: w.lise.id })).toMatchObject({ ok: false, rule: 'R33', code: 'no_availability' });
    expect(await w.book(at('2026-11-10', '09:00'))).toMatchObject({ ok: true });
  });

  it('[R32] le même créneau réservé deux fois en même temps : une seule réservation passe', async () => {
    const w = await world();
    const results = await Promise.all([w.book(at('2026-11-10', '09:00')), w.book(at('2026-11-10', '09:00')), w.book(at('2026-11-10', '09:30'))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.rule === 'R32' && r.code === 'taken')).toBe(true);
    expect(await w.rdv.bookedOf(w.paul.id)).toHaveLength(1);
  });

  it('[R32] la base refuse un chevauchement même si la vérification d’avant l’a manqué', async () => {
    const w = await world();
    expect((await w.book(at('2026-11-10', '09:00'))).ok).toBe(true);
    // Une tranche déjà tenue fait échouer toute l'instruction : aucune tranche du second rendez-vous n'est gardée.
    const holds = await w.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM appointment_holds WHERE released_at IS NULL');
    expect(holds[0]!.n).toBeGreaterThan(0);
    const raw = w.db.run("INSERT INTO appointment_holds (agent_id, layer, unit, appointment_id) VALUES (?, 'own', ?, 'x'), (?, 'own', ?, 'x')", [
      w.paul.id,
      Math.floor(at('2026-11-10', '09:30').getTime() / 300_000),
      w.paul.id,
      Math.floor(at('2026-11-10', '12:00').getTime() / 300_000),
    ]);
    await expect(raw).rejects.toThrow();
    expect((await w.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM appointment_holds WHERE appointment_id = 'x'"))[0]!.n).toBe(0);
  });

  it('[R32] le temps de trajet est laissé entre deux rendez-vous sur place, pas autour d’un appel', async () => {
    const w = await world();
    expect((await w.book(at('2026-11-10', '14:00'), { kind: 'visite' })).ok).toBe(true); // 14:00 à 14:45
    expect(await w.book(at('2026-11-10', '15:00'), { kind: 'visite' })).toMatchObject({ ok: false, rule: 'R32' });
    expect((await w.book(at('2026-11-10', '14:45'), { kind: 'appel' })).ok).toBe(true); // 14:45 à 15:05
    expect((await w.book(at('2026-11-10', '15:15'), { kind: 'visite' })).ok).toBe(true);
    noOverlap(await w.rdv.bookedOf(w.paul.id));
  });

  it('10 rendez-vous tests sans doublon ni oubli', async () => {
    const w = await world();
    const slots = await w.rdv.freeSlotsFor(w.paul.id, 'visite', at('2026-11-10', '00:00'), at('2026-11-11', '23:59'));
    const taken: string[] = [];
    for (const slot of slots) {
      if (taken.length === 10) break;
      const r = await w.book(slot.start, { kind: 'visite' });
      if (r.ok) taken.push(r.appointment.id);
      // Après chaque réservation, les créneaux encore proposés ne la chevauchent pas.
      const still = await w.rdv.freeSlotsFor(w.paul.id, 'visite', at('2026-11-10', '00:00'), at('2026-11-11', '23:59'));
      for (const s of still) expect(await w.book(s.start, { kind: 'visite', personId: w.lea.id, source: 'agent' }).then((x) => (x.ok ? w.rdv.cancelAsAgent(w.asPaul, x.appointment.id).then(() => true) : false))).toBe(true);
    }
    expect(taken).toHaveLength(10);
    const booked = await w.rdv.bookedOf(w.paul.id);
    expect(booked.map((b) => b.id).sort()).toEqual([...taken].sort());
    noOverlap(booked);
  });

  it('une annulation libère le créneau aussitôt', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-10', '09:00'));
    if (!r.ok) throw new Error('réservation refusée');
    const before = (await w.rdv.freeSlotsFor(w.paul.id, 'estimation', at('2026-11-10', '00:00'), at('2026-11-10', '23:59'))).map((s) => s.start.getTime());
    expect(before).not.toContain(at('2026-11-10', '09:00').getTime());
    const t0 = Date.now();
    expect(await w.rdv.cancel(r.token)).toMatchObject({ ok: true, appointment: { status: 'cancelled' } });
    expect(Date.now() - t0).toBeLessThan(60_000);
    const after = (await w.rdv.freeSlotsFor(w.paul.id, 'estimation', at('2026-11-10', '00:00'), at('2026-11-10', '23:59'))).map((s) => s.start.getTime());
    expect(after).toContain(at('2026-11-10', '09:00').getTime());
    expect((await w.book(at('2026-11-10', '09:00'))).ok).toBe(true);
    expect(await w.rdv.cancel(r.token)).toEqual({ ok: false, code: 'not_booked' });
  });

  it('le lien ne sert qu’à son rendez-vous ; l’agent seul annule les siens', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '09:00'));
    const b = await w.book(at('2026-11-10', '14:00'));
    if (!a.ok || !b.ok) throw new Error('réservation refusée');
    expect(a.token).toMatch(/^[a-z]{32}$/);
    expect(a.token).not.toBe(b.token);
    expect(await w.rdv.cancel(newBookingToken())).toEqual({ ok: false, code: 'unknown' });
    expect(await w.rdv.cancel('lea.exemple@example.test')).toEqual({ ok: false, code: 'unknown' });
    expect((await w.rdv.cancel(a.token)).ok).toBe(true);
    expect((await w.rdv.get(b.appointment.id))!.status).toBe('booked');
    expect(await w.rdv.cancelAsAgent({ role: 'agent', userId: w.lise.id, networkId: w.net.id }, b.appointment.id)).toEqual({ ok: false, code: 'not_agent' });
    expect((await w.rdv.cancelAsAgent(w.asPaul, b.appointment.id)).ok).toBe(true);
    // Le jeton n'est jamais gardé, seule son empreinte.
    expect(JSON.stringify(await w.db.all('SELECT * FROM appointments'))).not.toContain(a.token);
  });

  it('décaler : le nouveau créneau peut chevaucher l’ancien ; s’il ne passe pas, l’ancien reste', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-10', '09:00'));
    if (!r.ok) throw new Error('réservation refusée');
    const moved = await w.rdv.reschedule(r.token, at('2026-11-10', '09:30'));
    expect(moved).toMatchObject({ ok: true, appointment: { replaces_id: r.appointment.id, status: 'booked' } });
    expect((await w.rdv.get(r.appointment.id))!.status).toBe('cancelled');
    if (!moved.ok) throw new Error('décalage refusé');
    expect(await w.rdv.reschedule(moved.token, at('2026-11-10', '12:30'))).toMatchObject({ ok: false, rule: 'R33' });
    expect((await w.rdv.get(moved.appointment.id))!.status).toBe('booked');
    // Les tranches de l'ancien sont reprises : le créneau reste tenu.
    expect(await w.book(at('2026-11-10', '09:30'))).toMatchObject({ ok: false, rule: 'R32' });
    expect(await w.rdv.reschedule(r.token, at('2026-11-10', '15:00'))).toEqual({ ok: false, rule: null, code: 'not_booked' });
  });

  it('un lien ne décale qu’une fois, même en double clic ; l’ancien créneau est bien libéré', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-10', '09:00'));
    if (!r.ok) throw new Error('réservation refusée');
    const same = await Promise.all([w.rdv.reschedule(r.token, at('2026-11-10', '15:00')), w.rdv.reschedule(r.token, at('2026-11-10', '15:00'))]);
    expect(same.filter((x) => x.ok)).toHaveLength(1);
    expect(await w.rdv.bookedOf(w.paul.id)).toHaveLength(1);
    // Le créneau de 9 h est vraiment libre : proposé et réservable.
    expect((await w.book(at('2026-11-10', '09:00'))).ok).toBe(true);
    const s = await w.book(at('2026-11-12', '09:00'));
    if (!s.ok) throw new Error('réservation refusée');
    const two = await Promise.all([w.rdv.reschedule(s.token, at('2026-11-12', '14:00')), w.rdv.reschedule(s.token, at('2026-11-12', '16:00'))]);
    expect(two.filter((x) => x.ok)).toHaveLength(1);
    const booked = await w.rdv.bookedOf(w.paul.id);
    expect(booked.filter((b) => b.start_at.startsWith('2026-11-12'))).toHaveLength(1);
    const leftover = await w.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM appointment_holds h JOIN appointments a ON a.id = h.appointment_id WHERE h.released_at IS NULL AND a.status <> 'booked'",
    );
    expect(leftover[0]!.n).toBe(0);
  });

  it('une panne de l’agenda pendant un décalage ne fait pas perdre le rendez-vous', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-10', '09:00'));
    if (!r.ok) throw new Error('réservation refusée');
    const broken = new RendezVous(w.db, w.journal, { now: () => NOW, agenda: { busy: async () => Promise.reject(new Error('agenda en panne')) } });
    await expect(broken.reschedule(r.token, at('2026-11-10', '15:00'))).rejects.toThrow('agenda en panne');
    expect((await w.rdv.get(r.appointment.id))!.status).toBe('booked');
    expect(await w.book(at('2026-11-10', '09:00'))).toMatchObject({ ok: false, rule: 'R32' });
    expect((await w.rdv.reschedule(r.token, at('2026-11-10', '15:00'))).ok).toBe(true);
  });

  it('le journal en panne au moment de réserver : la réservation est défaite, le créneau reste libre', async () => {
    const w = await world();
    let failing = true;
    const journal = {
      ...w.journal,
      append: (...args: Parameters<typeof w.journal.append>) => (failing ? Promise.reject(new Error('journal en panne')) : w.journal.append(...args)),
      last: (...args: Parameters<typeof w.journal.last>) => w.journal.last(...args),
    } as unknown as typeof w.journal;
    const rdv = new RendezVous(w.db, journal, { now: () => NOW });
    await expect(rdv.book({ networkId: w.net.id, agentId: w.paul.id, personId: w.lea.id, kind: 'estimation', start: at('2026-11-10', '09:00'), source: 'site' })).rejects.toThrow('journal en panne');
    failing = false;
    expect(await w.rdv.bookedOf(w.paul.id)).toHaveLength(0);
    expect((await w.book(at('2026-11-10', '09:00'))).ok).toBe(true);
  });

  it('le journal en panne après un décalage : le nouveau rendez-vous et son lien sont rendus', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-10', '09:00'));
    if (!r.ok) throw new Error('réservation refusée');
    const journal = {
      append: (entry: Parameters<typeof w.journal.append>[0]) => (entry.type === 'rdv.decale' ? Promise.reject(new Error('journal en panne')) : w.journal.append(entry)),
      last: () => w.journal.last(),
    } as unknown as typeof w.journal;
    const moved = await new RendezVous(w.db, journal, { now: () => NOW }).reschedule(r.token, at('2026-11-10', '15:00'));
    expect(moved).toMatchObject({ ok: true, warning: 'journal_failed', appointment: { replaces_id: r.appointment.id } });
    if (!moved.ok) throw new Error('décalage refusé');
    expect((await w.rdv.cancel(moved.token)).ok).toBe(true);
  });

  it('une libération restée en panne se termine à la demande suivante', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-10', '09:00'));
    if (!r.ok) throw new Error('réservation refusée');
    let broken = true;
    const db = {
      ...w.db,
      exec: w.db.exec.bind(w.db),
      all: w.db.all.bind(w.db),
      first: w.db.first.bind(w.db),
      run: (sql: string, params?: Parameters<typeof w.db.run>[1]) => {
        if (broken && sql.startsWith('UPDATE appointment_holds')) {
          broken = false;
          return Promise.reject(new Error('panne passagère'));
        }
        return w.db.run(sql, params);
      },
    };
    await expect(new RendezVous(db, w.journal, { now: () => NOW }).cancel(r.token)).rejects.toThrow('panne passagère');
    expect(await w.book(at('2026-11-10', '09:00'))).toMatchObject({ ok: false, rule: 'R32' });
    expect(await w.rdv.cancel(r.token)).toEqual({ ok: false, code: 'not_booked' });
    expect((await w.book(at('2026-11-10', '09:00'))).ok).toBe(true);
  });

  it('un trajet impair est partagé exactement : un créneau proposé se réserve', async () => {
    const w = await world();
    const settings = { durations: { estimation: 60, visite: 45, signature: 60, appel: 20 }, travelMinutes: 15, stepMinutes: 15, minNoticeMinutes: 120, travelAroundBusy: true };
    const rdv = new RendezVous(w.db, w.journal, { now: () => NOW, settings });
    const base = { networkId: w.net.id, agentId: w.paul.id, personId: w.lea.id, kind: 'visite' as const, source: 'site' as const };
    expect((await rdv.book({ ...base, start: at('2026-11-10', '09:00') })).ok).toBe(true); // 9:00 à 9:45
    const offered = (await rdv.freeSlotsFor(w.paul.id, 'visite', at('2026-11-10', '00:00'), at('2026-11-10', '12:00'))).map((x) => x.start.getTime());
    expect(offered[0]).toBe(at('2026-11-10', '10:00').getTime());
    expect((await rdv.book({ ...base, start: at('2026-11-10', '10:00') })).ok).toBe(true);
    expect(() => new RendezVous(w.db, w.journal, { settings: { ...settings, travelMinutes: 12 } })).toThrow('multiple de 5');
  });

  it('des plages hors des tranches de 5 minutes sont refusées : chaque créneau proposé se réserve', async () => {
    const w = await world();
    expect(await w.rdv.setAvailability(w.asPaul, { weekly: [{ weekday: 2, from: '09:02', to: '12:02' }] })).toEqual({ ok: false, code: 'invalid' });
  });

  it('[R01] réservé le soir : la confirmation attend les heures d’envoi, rien ne part la nuit', async () => {
    const w = await world();
    w.setClock(at('2026-11-09', '21:30'));
    const r = await w.book(at('2026-11-12', '09:00'), { channel: 'email' });
    expect(r).toMatchObject({ ok: true, confirmation: { status: 'refused', rule: 'R01' }, appointment: { confirmation_status: 'waiting' } });
    expect(await w.db.all('SELECT message_id FROM trial_outbox')).toHaveLength(0);
  });

  it('la confirmation passe tout de suite par le contrôle central, en mode essai : rangée, jamais envoyée [R26]', async () => {
    const w = await world();
    const r = await w.book(at('2026-11-10', '09:00'), { channel: 'email' });
    expect(r).toMatchObject({ ok: true, confirmation: { status: 'sent', rule: null }, appointment: { confirmation_status: 'sent' } });
    const out = await w.db.all<{ id: string; body: string }>("SELECT id, body FROM messages WHERE direction = 'out'");
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toContain('confirmé le mardi 10 novembre à 9 h');
    // Le lien pour décaler ou annuler est remis entier, et rangé masqué [HX61, RC16].
    if (!r.ok) throw new Error(r.code);
    expect(remis(out[0]!.id)).toContain(`${LINK}${r.token}`);
    expect(out[0]!.body).toContain(MASKED_SECRET.lien);
    expect(await tablesContenant(w.db, r.token)).toEqual([]);
    expect(await w.db.all('SELECT message_id FROM trial_outbox')).toHaveLength(1);
    // Sans accord pour les rendez-vous, la réservation tient, la confirmation est refusée [R03].
    const marc = await w.store.createPerson({ networkId: w.net.id, firstName: 'Marc' });
    await w.store.addIdentifier({ networkId: w.net.id, personId: marc.id, kind: 'email', value: 'marc.exemple@example.test' });
    expect(await w.book(at('2026-11-10', '14:00'), { personId: marc.id, channel: 'email' })).toMatchObject({ ok: true, confirmation: { status: 'refused', rule: 'R03' } });
  });

  it('le texte de confirmation passe le contrôle du texte [R06] [R08] [R09] [R10]', () => {
    const start = at('2026-11-10', '14:30');
    for (const name of ['Léa', null]) {
      for (const kind of ['estimation', 'visite', 'signature', 'appel'] as const) {
        const { text, figures } = confirmationText(kind, start, name, `${LINK}${newBookingToken()}`);
        expect(checkText(text, { audience: 'client', channel: 'email', figures, firstOfConversation: name !== null, firstName: name }), text).toEqual([]);
      }
    }
    // [R54] une visite n'est pas dite confirmée tant que le visiteur ne l'a pas confirmée.
    expect(confirmationText('visite', start, 'Léa', null).text).toBe('Bonjour Léa, votre visite est réservée le mardi 10 novembre à 14 h 30. Votre agent immobilier la confirmera avec vous avant la visite.');
  });

  it('refus nets : délai trop court, heure mal formée, personne d’un autre réseau ; journal sans nom ni coordonnée [R13]', async () => {
    const w = await world();
    w.setClock(at('2026-11-10', '08:30'));
    expect(await w.book(at('2026-11-10', '09:00'))).toMatchObject({ ok: false, code: 'too_soon' });
    expect(await w.book(new Date(at('2026-11-10', '14:00').getTime() + 60_000))).toMatchObject({ ok: false, code: 'bad_time' });
    const other = await w.store.createNetwork('Autre');
    const stranger = await w.store.createPerson({ networkId: other.id, firstName: 'Zoé' });
    expect(await w.book(at('2026-11-10', '14:00'), { personId: stranger.id })).toMatchObject({ ok: false, code: 'unknown_person' });
    await w.book(at('2026-11-10', '14:00'), { channel: 'email' });
    const dump = JSON.stringify(await w.db.all('SELECT * FROM journal'));
    for (const secret of ['Léa', 'Exemple', 'lea.exemple', 'confirmé']) expect(dump, secret).not.toContain(secret);
    expect(dump).toContain('rdv.reserve');
  });
});
