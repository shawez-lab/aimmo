import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, RendezVous, SqlJournalStore, applyMigrations, fromSyncSqlite, parisInstant, type SqlDatabase, type Viewer } from '@aimmo/core';
import { ReservationEnLigne } from '../../core/src/rendezvous/en-ligne.ts';
import { Appels, type CallSegment, type CallTranscriber } from '../../core/src/voix/appels.ts';
import { AssistantVocal, handoffsOfCalls, type ForwardedCall } from '../../core/src/voix/assistant.ts';
import { appelsRoutes, type AppelsServices } from '../src/appels.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé. Le 9 novembre 2026 est un lundi.
const WEEK = { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: '09:00', to: '18:00' })) };
const AGENT_PHONE = '06 00 00 09 11';
const CALLER = '06 00 00 03 17';
const SEGMENTS: CallSegment[] = [
  { speaker: 'agent', startS: 0, endS: 8, text: 'Cet appel est enregistré, êtes-vous d’accord ?' },
  { speaker: 'appelant', startS: 8, endS: 10, text: 'Oui.' },
  { speaker: 'appelant', startS: 11, endS: 20, text: 'Je cherche à acheter à Dijon, mon budget est de 220 000 €.' },
];
const transcriber: CallTranscriber = { transcribe: async () => ({ segments: SEGMENTS, language: 'fr', confidence: 0.9 }) };

async function setup() {
  let clock = parisInstant('2026-11-09', 8 * 60)!.getTime();
  const now = (): Date => new Date((clock += 1));
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: network.id, firstName: 'Lise', lastName: 'Essai' });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: network.id };
  const asLise: Viewer = { role: 'agent', userId: lise.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const rdvOptions = { now, linkBase: 'https://essai.example.test/' };
  const rdv = new RendezVous(db, journal, rdvOptions);
  await rdv.setAvailability(asPaul, WEEK);
  // Pas d'annonce publiée : aucun prix n'est dit, le prix reste à reprendre par l'agent.
  const property = await store.createProperty({ networkId: network.id, agentId: paul.id, reference: 'REF-V-17', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 210000, status: 'available' });
  const person = await store.createPerson({ networkId: network.id, agentId: paul.id, firstName: 'Client' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: CALLER });
  const appels = new Appels(db, journal, store, fiche, transcriber, { now });
  const reservation = new ReservationEnLigne(db, journal, rdvOptions);
  const assistant = new AssistantVocal(db, journal, acces, reservation, appels, { now });
  expect(await assistant.setLine(asPaul, { agentId: paul.id, phone: AGENT_PHONE, enabled: true })).toEqual({ ok: true });
  let n = 0;
  const forwarded = (): ForwardedCall => ({ provider: 'essai', callId: `RENVOI-${++n}`, from: CALLER, forwardedFrom: AGENT_PHONE, forwardReason: 'no_answer', startedAt: now(), propertyId: property.id, originCode: null });
  /** Un appel entier pris par l'assistant, puis son passage de main. */
  const talk = async (lines: string[]) => {
    const s = await assistant.start(forwarded());
    if (!s.ok) throw new Error(s.code);
    let state = s.state;
    for (const line of lines) state = (await assistant.hear(state, line)).state;
    return assistant.finish(state, { endedAt: now(), recordingRef: 'REC-SECRET-17' });
  };
  const s: AppelsServices = { db, acces, journal, now };
  const route = appelsRoutes().find((r) => r.name === 'fiche.appels_recus.lire')!;
  const read = async (viewer: Viewer) => {
    const path = `/fiches/${person.id}/appels-recus`;
    const response = await route.handle(s, viewer, route.pattern.exec(path)!.slice(1), new Request(`https://api.example.test/v1${path}`));
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { db, journal, rdv, appels, network, paul, lise, asPaul, asLise, direction, person, property, talk, read, now };
}

describeWithSqlite('BR63 · le passage de main de l’assistant vocal, relu dans la fiche', () => {
  it('[R248] un appel pris par l’assistant porte le rendez-vous réservé et les sujets à reprendre', async () => {
    const t = await setup();
    const h = await t.talk(['oui', 'Quel est le prix ?', 'Je voudrais visiter', 'le premier', 'oui']);
    expect(h.appointment).not.toBeNull();
    const r = await t.read(t.asPaul);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].assistant).toEqual({
      appointment: { kind: 'visite', start: h.appointment!.start, state: 'prevu', current: h.appointment!.start },
      unanswered: ['prix'],
      propertyReference: 'REF-V-17',
    });
    // Ni la référence de l'enregistrement, ni le numéro de l'appelant.
    expect(JSON.stringify(r.body)).not.toMatch(/REC-SECRET|600000317|00 03 17/);
  });

  it('[R248] le rendez-vous est suivi jusqu’au bout : décalé avec sa nouvelle heure, puis annulé', async () => {
    const t = await setup();
    const h = await t.talk(['oui', 'Je voudrais visiter', 'le premier', 'oui']);
    const first = await t.db.first<{ id: string }>("SELECT id FROM appointments WHERE source = 'assistant'");
    const later = new Date(Date.parse(h.appointment!.start) + 2 * 86_400_000);
    const moved = await t.rdv.moveFromAgenda(first!.id, later);
    if (!moved.ok) throw new Error(moved.code);
    expect((await t.read(t.asPaul)).body.data[0].assistant.appointment).toEqual({ kind: 'visite', start: h.appointment!.start, state: 'decale', current: later.toISOString() });
    await t.rdv.cancelFromAgenda(moved.appointment.id);
    expect((await t.read(t.asPaul)).body.data[0].assistant.appointment).toMatchObject({ state: 'annule', current: later.toISOString() });
  });

  it('[R248] un rendez-vous qu’on ne retrouve plus dans l’agenda est dit introuvable, jamais deviné', async () => {
    const t = await setup();
    const h = await t.talk(['oui', 'Je voudrais visiter', 'le premier', 'oui']);
    const callId = (await t.read(t.asPaul)).body.data[0].id as string;
    // Le rendez-vous ne se retrouve plus comme pris par l'assistant (rangé autrement) : rien n'est deviné.
    await t.db.run("UPDATE appointments SET source = 'site' WHERE source = 'assistant'");
    expect(await t.db.first<{ source: string }>('SELECT source FROM appointments')).toEqual({ source: 'site' });
    const map = await handoffsOfCalls(t.db, t.asPaul, t.network.id, [callId]);
    expect(map.get(callId)!.appointment).toEqual({ kind: 'visite', start: h.appointment!.start, state: 'introuvable', current: h.appointment!.start });
    expect((await t.read(t.asPaul)).body.data[0].assistant.appointment.state).toBe('introuvable');
  });

  it('[R242] sans accord d’enregistrement, aucun sujet n’est rendu', async () => {
    const t = await setup();
    await t.talk(['non', 'Quel est le prix ?', 'Je voudrais visiter', 'le premier', 'oui']);
    const r = await t.read(t.asPaul);
    expect(r.body.data[0].assistant.unanswered).toEqual([]);
    expect(r.body.data[0].assistant.appointment).toMatchObject({ kind: 'visite', state: 'prevu' });
  });

  it('[R16] la référence du bien seulement pour l’agent du bien ou la direction', async () => {
    const t = await setup();
    await t.talk(['oui', 'Quel est le prix ?']);
    expect((await t.read(t.direction)).body.data[0].assistant.propertyReference).toBe('REF-V-17');
    // La fiche passe à Lise : elle relit l'appel, pas la référence d'un bien qui n'est pas le sien.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.lise.id, t.person.id]);
    const lise = await t.read(t.asLise);
    expect(lise.status).toBe(200);
    expect(lise.body.data[0].assistant).toMatchObject({ propertyReference: null, unanswered: ['prix'] });
    expect((await t.read(t.asPaul)).status).toBe(403);
  });

  it('un appel reçu sans l’assistant ne change pas : aucun passage de main', async () => {
    const t = await setup();
    const at = t.now();
    expect(await t.appels.receive(t.network.id, { provider: 'essai', callId: 'DIRECT-1', from: CALLER, startedAt: at, endedAt: new Date(at.getTime() + 40_000), announcedAt: at, consentAt: at, recordingRef: null, originCode: null })).toMatchObject({ ok: true });
    const r = await t.read(t.asPaul);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].assistant).toBeNull();
  });

  it('[R13] la lecture n’écrit rien de plus au journal que la lecture des appels reçus', async () => {
    const t = await setup();
    await t.talk(['oui', 'Quel est le prix ?', 'Je voudrais visiter', 'le premier', 'oui']);
    const before = (await t.db.all<{ type: string }>('SELECT type FROM journal')).length;
    await t.read(t.asPaul);
    const added = await t.db.all<{ type: string; data: string }>('SELECT type, data FROM journal LIMIT -1 OFFSET ?', [before]);
    expect(added.every((e) => !e.type.startsWith('voix.') && !e.type.startsWith('rdv.'))).toBe(true);
    expect(JSON.stringify(added)).not.toMatch(/REF-V-17|prix|visite/);
  });
});
