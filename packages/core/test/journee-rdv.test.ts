import { expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  BriefsRendezVous,
  FicheClient,
  FicheUnique,
  JourneeRendezVous,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  parisInstant,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1. Tout est inventé.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

async function world() {
  let clock = at('2026-11-09', '08:00');
  const now = () => clock;
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const journal = new SqlJournalStore(db);
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  const asLise: Viewer = { role: 'agent', userId: lise.id, networkId: net.id };
  const person = async (agentId: string, firstName: string) => {
    const p = await store.createPerson({ networkId: net.id, agentId, firstName, lastName: 'Exemple' });
    await store.addConsent({ networkId: net.id, personId: p.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
    return p;
  };
  let n = 0;
  // Les rendez-vous sont posés directement : la lecture du jour ne dépend pas des disponibilités.
  const book = async (agentId: string, personId: string, start: Date, status = 'booked') => {
    n += 1;
    const id = `rdv-${n}`;
    const end = new Date(start.getTime() + 3_600_000).toISOString();
    await db.run(
      `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'estimation', ?, ?, ?, ?, 'agent', ?, ?)`,
      [id, net.id, agentId, personId, start.toISOString(), end, status, `empreinte-${n}`, LONG_AGO.toISOString(), LONG_AGO.toISOString()],
    );
    return { appointment: { id } };
  };
  const briefs = new BriefsRendezVous(db, journal, { now });
  const journee = new JourneeRendezVous(db, journal, { now });
  const setClock = (d: Date) => {
    clock = d;
  };
  return { db, store, net, other, paul, lise, journal, asPaul, asLise, person, book, briefs, journee, setClock };
}

describeWithSqlite('A02 · rendez-vous du jour de l’agent', () => {
  it('[R16] les seuls rendez-vous du jour de l’agent, à l’heure de Paris, dans l’ordre, sans les annulés', async () => {
    const w = await world();
    const lea = await w.person(w.paul.id, 'Léa');
    const max = await w.person(w.lise.id, 'Max');
    const veille = await w.book(w.paul.id, lea.id, at('2026-11-09', '23:30'));
    const tot = await w.book(w.paul.id, lea.id, at('2026-11-10', '00:15'));
    const soir = await w.book(w.paul.id, lea.id, at('2026-11-10', '23:00'));
    const midi = await w.book(w.paul.id, lea.id, at('2026-11-10', '12:00'));
    await w.book(w.paul.id, lea.id, at('2026-11-10', '15:00'), 'cancelled');
    const honore = await w.book(w.paul.id, lea.id, at('2026-11-10', '08:00'), 'honored');
    await w.book(w.paul.id, lea.id, at('2026-11-11', '00:00'));
    await w.book(w.lise.id, max.id, at('2026-11-10', '10:00'));
    void veille;
    w.setClock(at('2026-11-10', '07:45'));
    const r = await w.journee.read(w.asPaul);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.day).toBe('2026-11-10');
    expect(r.value.appointments.map((a) => a.id)).toEqual([tot.appointment.id, honore.appointment.id, midi.appointment.id, soir.appointment.id]);
    expect(r.value.appointments[0]).toMatchObject({ kind: 'estimation', status: 'booked', firstName: 'Léa', brief: null, briefMissing: 'not_ready' });
    // Lise ne voit que le sien.
    const l = await w.journee.read(w.asLise);
    expect(l.ok && l.value.appointments.map((a) => a.firstName)).toEqual(['Max']);
  });

  it('[R16] le brief rangé est rendu à l’agent du rendez-vous ; refusé à un autre rôle, à un agent parti ou d’un autre réseau, et au journal', async () => {
    const w = await world();
    const lea = await w.person(w.paul.id, 'Léa');
    const a = await w.book(w.paul.id, lea.id, at('2026-11-10', '10:00'));
    w.setClock(at('2026-11-10', '08:07'));
    expect(await w.briefs.run()).toEqual([a.appointment.id]);
    const r = await w.journee.read(w.asPaul);
    expect(r.ok && r.value.appointments[0]?.brief?.appointmentId).toBe(a.appointment.id);
    expect(r.ok && r.value.appointments[0]?.briefMissing).toBeNull();

    for (const viewer of [
      { role: 'direction', userId: 'direction-1', networkId: w.net.id },
      { role: 'agent', userId: w.paul.id, networkId: w.other.id },
    ] as Viewer[]) {
      expect(await w.journee.read(viewer)).toMatchObject({ ok: false, rule: 'R16' });
    }
    await w.db.run(`UPDATE agents SET status = 'left' WHERE id = ?`, [w.paul.id]);
    expect(await w.journee.read(w.asPaul)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });

    const events = await w.db.all<{ type: string; data: string }>(`SELECT type, data FROM journal WHERE type IN ('rdv.jour.lu', 'acces.refuse') ORDER BY seq`);
    expect(events.map((e) => e.type)).toEqual(['rdv.jour.lu', 'acces.refuse', 'acces.refuse', 'acces.refuse']);
    // [R13] le journal ne porte que des nombres, aucune donnée du client.
    for (const e of events) expect(e.data).not.toMatch(/Léa|Exemple/);
    expect(JSON.parse(events[0]!.data)).toEqual({ rule: 'R16', day: '2026-11-10', appointments: 1, briefs: 1 });
    // [R16] la fiche dont le prénom et le brief sont rendus est écrite au journal, à son nom de fiche, avant d'être rendue.
    const reads = await w.db.all<{ seq: number; subject: string; data: string }>(`SELECT seq, subject, data FROM journal WHERE type = 'fiche.lue' ORDER BY seq`);
    expect(reads.map((e) => e.subject)).toEqual([`person:${lea.id}`]);
    expect(JSON.parse(reads[0]!.data)).toEqual({ rule: 'R16', role: 'agent', via: 'rendez_vous.jour', appointment: `appointment:${a.appointment.id}`, brief: 1, members: [`person:${lea.id}`] });
    expect(reads[0]!.data).not.toMatch(/Léa|Exemple/);
  });

  it('SV13 · un nom corrigé après le brief : l’écran de la journée dit le nouveau, et le brief rangé ne change pas [R17]', async () => {
    const w = await world();
    const lea = await w.person(w.paul.id, 'Léa');
    const a = await w.book(w.paul.id, lea.id, at('2026-11-10', '10:00'));
    w.setClock(at('2026-11-10', '08:07'));
    expect(await w.briefs.run()).toEqual([a.appointment.id]);
    await w.db.run("UPDATE persons SET last_name = 'Corrigé' WHERE id = ?", [lea.id]);
    const r = await w.journee.read(w.asPaul);
    const nom = r.ok ? r.value.appointments[0]?.brief?.items.find((i) => i.label === 'Nom') : null;
    expect(nom?.value).toMatch(/ Corrigé$/);
    expect((await w.db.first<{ content: string }>('SELECT content FROM appointment_briefs WHERE appointment_id = ?', [a.appointment.id]))!.content).not.toContain('Corrigé');
  });

  it('SV13 [R16] une fiche passée à un autre agent après une correction : l’ancien agent ne lit pas le nouveau nom', async () => {
    const w = await world();
    const lea = await w.person(w.paul.id, 'Léa');
    const a = await w.book(w.paul.id, lea.id, at('2026-11-10', '10:00'));
    w.setClock(at('2026-11-10', '08:07'));
    expect(await w.briefs.run()).toEqual([a.appointment.id]);
    await w.db.run("UPDATE persons SET last_name = 'Corrigé', agent_id = ? WHERE id = ?", [w.lise.id, lea.id]);
    const r = await w.journee.read(w.asPaul);
    expect(r.ok && JSON.stringify(r.value)).not.toContain('Corrigé');
  });

  it('[R16] une fiche passée à un autre agent ne montre ni prénom ni brief ; une fusion après le brief le cache', async () => {
    const w = await world();
    const lea = await w.person(w.paul.id, 'Léa');
    const a = await w.book(w.paul.id, lea.id, at('2026-11-10', '10:00'));
    w.setClock(at('2026-11-10', '08:07'));
    await w.briefs.run();
    await w.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [w.lise.id, lea.id]);
    const r = await w.journee.read(w.asPaul);
    expect(r.ok && r.value.appointments).toEqual([expect.objectContaining({ id: a.appointment.id, firstName: null, brief: null, briefMissing: 'no_access' })]);
    // Rien de la fiche n'est rendu : aucune lecture de fiche au journal pour cette consultation.
    expect(await w.db.all(`SELECT seq FROM journal WHERE type = 'fiche.lue'`)).toEqual([]);
    // Le refus, lui, est écrit à la fiche, sans donnée.
    const refused = await w.db.all<{ subject: string; data: string }>(`SELECT subject, data FROM journal WHERE type = 'acces.refuse'`);
    expect(refused.map((e) => [e.subject, JSON.parse(e.data)])).toEqual([
      [`person:${lea.id}`, { rule: 'R16', role: 'agent', kind: 'person', code: 'not_assigned', via: 'rendez_vous.jour', appointment: `appointment:${a.appointment.id}` }],
    ]);
    await w.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [w.paul.id, lea.id]);

    // Une autre fiche de Paul fusionnée dans celle de Léa après le brief : le brief rangé ne la connaît pas.
    const double = await w.person(w.paul.id, 'Léa');
    w.setClock(at('2026-11-10', '08:30'));
    await new FicheUnique(w.db, w.store, { now: () => at('2026-11-10', '08:30') }).merge({ survivorId: lea.id, mergedId: double.id, reason: 'même mail' });
    const m = await w.journee.read(w.asPaul);
    expect(m.ok && m.value.appointments[0]).toMatchObject({ firstName: 'Léa', brief: null, briefMissing: 'changed' });
  });

  it('[R16] un bien d’un autre agent sorti du fichier commun depuis le brief cache le brief, et le refus est au journal', async () => {
    const w = await world();
    const lea = await w.person(w.paul.id, 'Léa');
    const bien = await w.store.createProperty({ networkId: w.net.id, agentId: w.lise.id, reference: 'REF-TEST-9', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 50, rooms: 2, priceEur: 150000 });
    await w.db.run(`UPDATE properties SET status = 'available' WHERE id = ?`, [bien.id]);
    const a = await w.book(w.paul.id, lea.id, at('2026-11-10', '10:00'));
    await w.db.run('UPDATE appointments SET property_id = ? WHERE id = ?', [bien.id, a.appointment.id]);
    w.setClock(at('2026-11-10', '08:07'));
    expect(await w.briefs.run()).toEqual([a.appointment.id]);
    const before = await w.journee.read(w.asPaul);
    expect(before.ok && JSON.stringify(before.value.appointments[0]?.brief)).toContain('REF-TEST-9');
    await w.db.run(`UPDATE properties SET status = 'withdrawn' WHERE id = ?`, [bien.id]);
    const after = await w.journee.read(w.asPaul);
    expect(after.ok && after.value.appointments[0]).toMatchObject({ firstName: 'Léa', brief: null, briefMissing: 'property' });
    expect(JSON.stringify(after)).not.toContain('REF-TEST-9');
    const refused = await w.db.all<{ subject: string; data: string }>(`SELECT subject, data FROM journal WHERE type = 'acces.refuse'`);
    expect(refused.map((e) => e.subject)).toEqual([`property:${bien.id}`]);
    expect(JSON.parse(refused[0]!.data)).toMatchObject({ rule: 'R16', kind: 'property', via: 'rendez_vous.jour' });
  });
});
