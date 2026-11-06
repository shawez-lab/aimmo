import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  AgendaSync,
  AppleAgenda,
  FicheClient,
  RendezVous,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  googleEventId,
  keyOfGoogleId,
  parisInstant,
  parseMultistatus,
  type Availability,
  type Viewer,
} from '../src/index.ts';
import { SERVERS, TOKEN, type FakeServer } from './agenda-serveurs.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1. Tout est inventé.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');
const WEEK: Availability = { weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [{ weekday, from: '09:00', to: '12:00' }, { weekday, from: '14:00', to: '18:00' }]) };

async function world(server: FakeServer) {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: net.id, personId: lea.id, kind: 'email', value: 'lea.exemple@example.test' });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: new Date('2026-01-01T00:00:00Z') });
  const journal = new SqlJournalStore(db);
  const now = () => NOW;
  let sync: AgendaSync;
  const rdv = new RendezVous(db, journal, { now, agenda: { busy: (a, f, t) => sync.busySource().busy(a, f, t) } });
  sync = new AgendaSync(db, journal, server.provider(now), rdv, { now });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  await rdv.setAvailability(asPaul, WEEK);
  const book = async (start: Date) => {
    const r = await rdv.book({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'estimation', start, source: 'site' });
    if (!r.ok) throw new Error(`refusé : ${r.code}`);
    return r.appointment;
  };
  const ours = () => server.live().filter((e) => e.key?.startsWith('aimmo:'));
  const slots = async (kind: 'appel' | 'estimation' = 'appel') =>
    (await rdv.freeSlotsFor(paul.id, kind, at('2026-11-10', '00:00'), at('2026-11-10', '23:59'))).map((s) => s.start.getTime());
  const journalText = async () => JSON.stringify(await journal.all());
  return { db, journal, sync, rdv, paul, lea, book, ours, slots, journalText };
}

for (const make of SERVERS) {
  const name = make().name;
  describeWithSqlite(`HX02 · agenda relié à ${name}`, () => {
    it('[R236] un rendez-vous ajouté dans AIMMO apparaît dans l’agenda, une seule fois, sans nom ni coordonnée', async () => {
      const server = make();
      const w = await world(server);
      const a = await w.book(at('2026-11-10', '09:00'));
      expect(await w.sync.push()).toEqual({ written: 1, failed: 0 });
      expect(await w.sync.push()).toEqual({ written: 0, failed: 0 });
      await w.sync.run();
      expect(w.ours()).toHaveLength(1);
      expect(w.ours()[0]).toMatchObject({ key: `aimmo:${a.id}`, start: at('2026-11-10', '09:00'), end: at('2026-11-10', '10:00'), cancelled: false, title: 'Estimation · AIMMO' });
      const sent = server.requests.map((r) => r.body + r.url).join('\n');
      for (const secret of ['Léa', 'Exemple', 'lea.exemple', '@example']) expect(sent, secret).not.toContain(secret);
      // Chaque appel porte l'autorisation de la connexion de l'agent.
      expect(server.requests.every((r) => r.auth === TOKEN)).toBe(true);
    });

    it('[R236] une écriture faite mais dont la réponse s’est perdue n’est jamais doublée', async () => {
      const server = make();
      const w = await world(server);
      await w.book(at('2026-11-10', '09:00'));
      server.loseNextWrite = true;
      expect(await w.sync.push()).toEqual({ written: 0, failed: 1 });
      expect(w.ours()).toHaveLength(1);
      expect(await w.sync.push()).toEqual({ written: 1, failed: 0 });
      await w.sync.run();
      expect(w.ours()).toHaveLength(1);
    });

    it('[R33] un événement ajouté dans l’agenda bloque ses créneaux dans AIMMO ; un événement « disponible » non', async () => {
      const server = make();
      const w = await world(server);
      server.agentAdd(at('2026-11-10', '14:00'), at('2026-11-10', '15:00'));
      server.agentAdd(at('2026-11-10', '10:00'), at('2026-11-10', '11:00'), { free: true });
      const slots = await w.slots();
      expect(slots).not.toContain(at('2026-11-10', '14:30').getTime());
      expect(slots).toContain(at('2026-11-10', '10:15').getTime());
      // Les événements d'AIMMO ne bloquent pas leur propre rendez-vous.
      await w.book(at('2026-11-10', '16:00'));
      await w.sync.push();
      expect(await w.slots()).toContain(at('2026-11-10', '17:30').getTime());
    });

    it('[R32] un rendez-vous déplacé dans l’agenda est déplacé dans AIMMO, toujours un seul événement', async () => {
      const server = make();
      const w = await world(server);
      const a = await w.book(at('2026-11-10', '09:00'));
      await w.sync.run();
      const [e] = w.ours();
      server.agentMove(e!.id, at('2026-11-10', '15:00'), at('2026-11-10', '16:00'));
      const r = await w.sync.run();
      expect(r.moved).toBe(1);
      expect((await w.rdv.get(a.id))?.status).toBe('cancelled');
      const now = await w.db.first<{ start_at: string }>("SELECT start_at FROM appointments WHERE replaces_id = ? AND status = 'booked'", [a.id]);
      expect(now?.start_at).toBe(at('2026-11-10', '15:00').toISOString());
      await w.sync.run();
      expect(w.ours()).toHaveLength(1);
      expect(w.ours()[0]).toMatchObject({ start: at('2026-11-10', '15:00'), cancelled: false });
    });

    it('un rendez-vous supprimé dans l’agenda est annulé dans AIMMO', async () => {
      const server = make();
      const w = await world(server);
      const a = await w.book(at('2026-11-10', '09:00'));
      await w.sync.run();
      server.agentRemove(w.ours()[0]!.id);
      const r = await w.sync.run();
      expect(r.cancelled).toBe(1);
      expect((await w.rdv.get(a.id))?.status).toBe('cancelled');
    });

    it('[R236] un rendez-vous annulé dans AIMMO reste dans l’agenda, marqué annulé : rien n’y est effacé', async () => {
      const server = make();
      const w = await world(server);
      const a = await w.book(at('2026-11-10', '09:00'));
      await w.sync.run();
      await w.rdv.cancelFromAgenda(a.id);
      await w.sync.push();
      expect(w.ours()).toHaveLength(1);
      expect(w.ours()[0]!.cancelled).toBe(true);
      expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);
      // Annulé, il ne bloque plus rien.
      expect(await w.slots('estimation')).toContain(at('2026-11-10', '09:00').getTime());
    });

    it('[R13] une panne du service : la réservation reste, la ligne est reprise, le journal ne porte que le nom de l’erreur', async () => {
      const server = make();
      const w = await world(server);
      await w.book(at('2026-11-10', '09:00'));
      server.failNext = 500;
      expect(await w.sync.push()).toEqual({ written: 0, failed: 1 });
      const text = await w.journalText();
      expect(text).toContain('AgendaHttpError');
      expect(text).not.toContain('jeton-essai');
      expect(await w.sync.push()).toEqual({ written: 1, failed: 0 });
      expect(w.ours()).toHaveLength(1);
    });

    it('un curseur de changements périmé fait relire l’agenda : aucun rendez-vous ne reste sans son événement', async () => {
      const server = make();
      const w = await world(server);
      const a = await w.book(at('2026-11-10', '09:00'));
      await w.sync.run();
      server.expireCursor();
      server.agentRemove(w.ours()[0]!.id);
      await w.sync.run();
      const status = (await w.rdv.get(a.id))?.status;
      if (name === 'Google Agenda') {
        // Google rend les suppressions dans la relecture complète : elle est connue, le rendez-vous est annulé.
        expect(status).toBe('cancelled');
      } else {
        // Outlook et Apple ne rendent pas ce qui a disparu : jamais annulé sur ce seul silence, l'événement est remis, noté.
        expect(status).toBe('booked');
        expect(w.ours().filter((e) => !e.cancelled)).toHaveLength(1);
        expect((await w.journal.all()).some((e) => e.type === 'rdv.agenda.manquant')).toBe(true);
      }
    });
  });
}

describe('HX02 · lecture des réponses des services', () => {
  it('[R236] l’identifiant Google tiré de la clé se relit, et rien d’autre ne passe pour une clé', () => {
    const key = 'aimmo:0b6f2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
    const id = googleEventId(key);
    expect(id).toMatch(/^[0-9a-v]+$/);
    expect(keyOfGoogleId(id)).toBe(key);
    expect(keyOfGoogleId(googleEventId('perso:rdv'))).toBeNull();
    expect(keyOfGoogleId('abc123')).toBeNull();
    expect(keyOfGoogleId('x1')).toBeNull();
  });

  it('une réponse CalDAV dont une propriété manque (propstat 404) n’est pas lue comme une suppression', () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/c/a.ics</D:href><D:propstat><D:prop><C:calendar-data/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat><D:propstat><D:prop><D:getetag>"1"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:sync-token>t</D:sync-token></D:multistatus>`;
    expect(parseMultistatus(xml).responses).toEqual([{ href: '/c/a.ics', status: 200, data: null }]);
  });

  it('les réponses CalDAV se lisent quels que soient les préfixes, échappées ou en CDATA', () => {
    const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/c/a.ics</href><propstat><prop><cal:calendar-data xmlns:cal="urn:ietf:params:xml:ns:caldav">BEGIN:VEVENT&#13;
END:VEVENT</cal:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response><response><href>/c/b.ics</href><status>HTTP/1.1 404 Not Found</status></response><sync-token>http://x/sync/7</sync-token></multistatus>`;
    const r = parseMultistatus(xml);
    expect(r.syncToken).toBe('http://x/sync/7');
    expect(r.responses).toEqual([
      { href: '/c/a.ics', status: 200, data: 'BEGIN:VEVENT\r\nEND:VEVENT' },
      { href: '/c/b.ics', status: 404, data: null },
    ]);
  });
});

describeWithSqlite('HX02 · Apple et Outlook : récurrences, heures locales, fenêtre', () => {
  it('[R33] une série hebdomadaire Apple commencée la semaine d’avant bloque chaque occurrence', async () => {
    const server = SERVERS[2]!();
    const w = await world(server);
    server.agentAdd(at('2026-11-03', '14:00'), at('2026-11-03', '15:00'), { weekly: true });
    const slots = await w.slots();
    expect(slots).not.toContain(at('2026-11-10', '14:30').getTime());
    expect(slots).toContain(at('2026-11-10', '15:00').getTime());
  });

  it('[R33] un événement Apple avec DURATION au lieu de DTEND bloque toute sa durée', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261110T130000Z', 'DURATION:PT1H30M', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b', 'DTSTART;VALUE=DATE:20261111', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/c/a.ics</D:href><D:propstat><D:prop><C:calendar-data>${ics}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    const fetch = async () => new Response(xml, { status: 207 });
    return new AppleAgenda({ fetch, authorization: async () => 'x' }, async () => 'https://caldav.example.test/c/')
      .events('agent', at('2026-11-10', '00:00'), at('2026-11-12', '00:00'))
      .then((events) => {
        expect(events.map((e) => [e.start.toISOString(), e.end.toISOString()])).toEqual([
          ['2026-11-10T13:00:00.000Z', '2026-11-10T14:30:00.000Z'],
          [at('2026-11-11', '00:00').toISOString(), at('2026-11-12', '00:00').toISOString()],
        ]);
      });
  });

  it('Outlook : un retrait rendu pour un événement sorti de la fenêtre n’annule pas le rendez-vous', async () => {
    const server = SERVERS[1]!();
    const w = await world(server);
    const a = await w.book(at('2026-11-10', '09:00'));
    await w.sync.run();
    // L'agent repousse l'événement de deux ans : Graph le signale comme retiré de la fenêtre, il existe toujours.
    server.agentMove(w.ours()[0]!.id, at('2028-11-14', '09:00'), at('2028-11-14', '10:00'));
    await w.sync.run();
    const booked = await w.db.all<{ id: string }>("SELECT id FROM appointments WHERE status = 'booked' AND (id = ? OR replaces_id = ?)", [a.id, a.id]);
    expect(booked).toHaveLength(1);
    expect(w.ours()).toHaveLength(1);
  });

  it('Outlook : la fenêtre des changements est relue avant sa fin, et un déplacement lointain revient', async () => {
    const server = SERVERS[1]!();
    let clock = NOW;
    const db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const store = new FicheClient(db);
    const net = await store.createNetwork('Réseau test');
    const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
    const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
    const journal = new SqlJournalStore(db);
    const now = () => clock;
    let sync: AgendaSync;
    const rdv = new RendezVous(db, journal, { now, agenda: { busy: (a, f, t) => sync.busySource().busy(a, f, t) } });
    sync = new AgendaSync(db, journal, server.provider(now), rdv, { now });
    await rdv.setAvailability({ role: 'agent', userId: paul.id, networkId: net.id }, WEEK);
    await sync.run();
    // Seize mois plus tard, un rendez-vous loin au-delà de la première fenêtre.
    clock = at('2028-03-06', '08:00');
    const r = await rdv.book({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'estimation', start: at('2028-03-07', '09:00'), source: 'agent' });
    if (!r.ok) throw new Error(r.code);
    await sync.run();
    const e = server.live().find((x) => x.key === `aimmo:${r.appointment.id}`)!;
    server.agentRemove(e.id);
    await sync.run();
    expect((await rdv.get(r.appointment.id))?.status).toBe('cancelled');
  });

  it('[R33] un événement Apple à l’heure de Paris (TZID) bloque le bon créneau', async () => {
    const server = SERVERS[2]!();
    const w = await world(server);
    server.agentAdd(at('2026-11-10', '14:00'), at('2026-11-10', '15:00'), { parisLocal: true });
    const slots = await w.slots();
    expect(slots).not.toContain(at('2026-11-10', '14:30').getTime());
    expect(slots).toContain(at('2026-11-10', '15:00').getTime());
  });
});
