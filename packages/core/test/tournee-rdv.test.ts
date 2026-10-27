import { expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  DEFAULT_SLOT_SETTINGS,
  FicheClient,
  REMINDER_JOB,
  ROUTE_SHARE_PURPOSE,
  RendezVous,
  SqlJournalStore,
  TourneeRendezVous,
  applyMigrations,
  chainSlots,
  checkText,
  fromSyncSqlite,
  parisInstant,
  routeText,
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
  weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, from: '09:00', to: '12:00' },
    { weekday, from: '14:00', to: '18:00' },
  ]),
};
const MIN = 60_000;

async function world(busy: { start: Date; end: Date }[] = []) {
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
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  const proche = await store.createPerson({ networkId: net.id, firstName: 'Sam' });
  await store.addIdentifier({ networkId: net.id, personId: proche.id, kind: 'email', value: 'sam.proche@example.test' });
  await store.addConsent({ networkId: net.id, personId: proche.id, purpose: ROUTE_SHARE_PURPOSE, channel: 'email', proof: 'accord écrit test', givenAt: LONG_AGO });
  const journal = new SqlJournalStore(db);
  const agenda = { busy: async () => busy };
  const rdv = new RendezVous(db, journal, { now, agenda });
  const tournee = new TourneeRendezVous(db, journal, { now, agenda });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  expect(await rdv.setAvailability(asPaul, WEEK)).toEqual({ ok: true });
  const prop = (reference: string, city: string | null, postalCode: string | null = '21000') =>
    store.createProperty({ networkId: net.id, agentId: paul.id, reference, kind: 'home', postalCode, city });
  const outbox = () => db.all<{ message_id: string }>('SELECT message_id FROM trial_outbox');
  const bodies = async () => (await db.all<{ body: string }>("SELECT body FROM messages WHERE direction = 'out'")).map((m) => m.body);
  return { db, store, net, paul, lea, proche, journal, rdv, tournee, asPaul, prop, outbox, bodies, setClock };
}

describeWithSqlite('V07 · visites enchaînées et tournée partagée', () => {
  it('[R32] [R33] l’ordre proposé tient dans les disponibilités, hors de l’agenda et des rendez-vous, trajet compris', async () => {
    const w = await world([{ start: at('2026-11-10', '09:00'), end: at('2026-11-10', '09:30') }]);
    const a = await w.prop('REF-A', 'Dijon');
    const b = await w.prop('REF-B', 'Chenôve', '21300');
    const c = await w.prop('REF-C', 'Dijon');
    const d = await w.prop('REF-D', 'Talant', '21240');
    // Un rendez-vous déjà pris en fin d'après-midi.
    expect((await w.rdv.book({ networkId: w.net.id, agentId: w.paul.id, personId: w.lea.id, kind: 'estimation', start: at('2026-11-10', '16:30'), source: 'agent' })).ok).toBe(true);
    const r = await w.tournee.proposeChain(w.asPaul, '2026-11-10', [a.id, b.id, c.id, d.id]);
    if (!r.ok) throw new Error(r.code);
    // Les biens d'une même commune se suivent.
    expect(r.visits.map((v) => v.propertyId)).toEqual([a.id, c.id, b.id, d.id]);
    expect(r.visits.map((v) => v.town)).toEqual(['Dijon', 'Dijon', 'Chenôve', 'Talant']);
    for (let i = 1; i < r.visits.length; i++) {
      expect(r.visits[i]!.start.getTime()).toBeGreaterThanOrEqual(r.visits[i - 1]!.end.getTime() + DEFAULT_SLOT_SETTINGS.travelMinutes * MIN);
    }
    // Chaque créneau proposé se réserve tel quel, dans l'ordre : rien hors des plages ni sur l'agenda [R33], aucun
    // chevauchement, trajet compris [R32].
    for (const v of r.visits) {
      const booked = await w.rdv.book({ networkId: w.net.id, agentId: w.paul.id, personId: w.lea.id, propertyId: v.propertyId, kind: 'visite', start: v.start, source: 'agent' });
      expect(booked, v.start.toISOString()).toMatchObject({ ok: true });
    }
    // La proposition ne réserve rien d'elle-même.
    expect(await w.db.all("SELECT id FROM appointments WHERE kind = 'visite' AND source <> 'agent'")).toHaveLength(0);
  });

  it('pas de place, trop de biens, bien inconnu, date fausse, pas un agent : refus nets', async () => {
    const w = await world();
    const ps = await Promise.all(Array.from({ length: 8 }, (_, i) => w.prop(`REF-${i}`, 'Dijon')));
    expect(await w.tournee.proposeChain(w.asPaul, '2026-11-10', ps.map((p) => p.id))).toEqual({ ok: false, code: 'no_room' });
    const nine = await w.prop('REF-9', 'Dijon');
    expect(await w.tournee.proposeChain(w.asPaul, '2026-11-10', [...ps.map((p) => p.id), nine.id])).toEqual({ ok: false, code: 'too_many' });
    expect(await w.tournee.proposeChain(w.asPaul, '2026-11-10', ['inconnu'])).toEqual({ ok: false, code: 'unknown_property' });
    expect(await w.tournee.proposeChain(w.asPaul, '2026-11-14', [nine.id])).toEqual({ ok: false, code: 'no_room' });
    expect(await w.tournee.proposeChain(w.asPaul, '2026-13-40', [nine.id])).toEqual({ ok: false, code: 'bad_date' });
    expect(await w.tournee.proposeChain(w.asPaul, '2026-11-10', [])).toEqual({ ok: false, code: 'no_property' });
    expect(await w.tournee.proposeChain({ role: 'direction', userId: 'dir', networkId: w.net.id }, '2026-11-10', [nine.id])).toEqual({ ok: false, code: 'not_agent' });
  });

  it('[R32] l’enchaînement garde le trajet entre visites, pas entre deux appels', () => {
    const slot = (hhmm: string, kind: 'visite' | 'appel', minutes: number) => ({ kind, start: at('2026-11-10', hhmm), end: new Date(at('2026-11-10', hhmm).getTime() + minutes * MIN) });
    const visits = ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30'].map((h) => slot(h, 'visite', 45));
    expect(chainSlots(visits, 2)!.map((s) => s.start)).toEqual([at('2026-11-10', '09:00'), at('2026-11-10', '10:15')]);
    expect(chainSlots(visits, 3)).toBeNull();
    const calls = ['09:00', '09:20', '09:40'].map((h) => slot(h, 'appel', 20));
    expect(chainSlots(calls, 3)!.map((s) => s.start)).toEqual(calls.map((c) => c.start));
  });

  it('[R09] la tournée ne porte que les heures et les communes, jamais d’adresse, de référence ni de nom de client', async () => {
    const w = await world();
    const a = await w.prop('REF-SECRET-1', 'Dijon');
    const b = await w.prop('REF-SECRET-2', null);
    const book = (start: Date, kind: 'visite' | 'appel' | 'estimation', propertyId: string | null) =>
      w.rdv.book({ networkId: w.net.id, agentId: w.paul.id, personId: w.lea.id, propertyId, kind, start, source: 'agent' });
    await book(at('2026-11-10', '09:00'), 'visite', a.id);
    await book(at('2026-11-10', '10:30'), 'appel', null);
    await book(at('2026-11-10', '14:00'), 'estimation', b.id);
    w.setClock(at('2026-11-10', '08:00'));
    expect(await w.tournee.shareDay(w.asPaul, '2026-11-10', w.proche.id, 'email')).toEqual({ ok: true, count: 2, send: { status: 'sent', rule: null } });
    const [body] = await w.bodies();
    expect(body).toContain('Bonjour Sam, voici ma tournée du mardi 10 novembre : 9 h à Dijon ; 14 h à commune non précisée.');
    for (const secret of ['REF-SECRET', '21000', 'Léa', 'Exemple', '10 h 30']) expect(body, secret).not.toContain(secret);
    const { text, figures } = routeText(at('2026-11-10', '00:00'), [{ start: at('2026-11-10', '09:00'), town: 'Dijon' }, { start: at('2026-11-10', '16:45'), town: 'Talant' }]);
    expect(checkText(text, { audience: 'client', channel: 'email', figures, firstOfConversation: true, firstName: null })).toEqual([]);
    const named = routeText(at('2026-11-10', '00:00'), [{ start: at('2026-11-10', '09:00'), town: 'Dijon' }], 'Sam');
    expect(checkText(named.text, { audience: 'client', channel: 'email', figures: named.figures, firstOfConversation: true, firstName: 'Sam' })).toEqual([]);
    expect(await w.outbox()).toHaveLength(1);
  });

  it('rien ne part sans que l’agent le demande ; la même tournée une seule fois ; mode essai et contrôle central', async () => {
    const w = await world();
    const a = await w.prop('REF-A', 'Dijon');
    await w.rdv.book({ networkId: w.net.id, agentId: w.paul.id, personId: w.lea.id, propertyId: a.id, kind: 'visite', start: at('2026-11-10', '09:00'), source: 'agent' });
    // Aucun envoi tant que l'agent ne demande rien ; aucune tâche du planificateur n'envoie de tournée.
    expect(await w.outbox()).toHaveLength(0);
    expect(REMINDER_JOB).not.toContain('tournee');
    // Pas un agent : rien.
    expect(await w.tournee.shareDay({ role: 'direction', userId: 'dir', networkId: w.net.id }, '2026-11-10', w.proche.id, 'email')).toEqual({ ok: false, code: 'not_agent' });
    // Hors des heures d'envoi : refusé [R01].
    w.setClock(at('2026-11-09', '21:30'));
    expect(await w.tournee.shareDay(w.asPaul, '2026-11-10', w.proche.id, 'email')).toMatchObject({ ok: true, send: { status: 'refused', rule: 'R01' } });
    w.setClock(at('2026-11-10', '08:00'));
    expect(await w.tournee.shareDay(w.asPaul, '2026-11-10', w.proche.id, 'email')).toMatchObject({ ok: true, send: { status: 'sent' } });
    expect(await w.tournee.shareDay(w.asPaul, '2026-11-10', w.proche.id, 'email')).toMatchObject({ ok: true, send: { status: 'refused', rule: 'R05' } });
    // Sans accord pour la tournée, rien ne part [R03] ; un client n'en a pas.
    await w.store.addIdentifier({ networkId: w.net.id, personId: w.lea.id, kind: 'email', value: 'lea.exemple@example.test' });
    await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'test', givenAt: LONG_AGO });
    expect(await w.tournee.shareDay(w.asPaul, '2026-11-10', w.lea.id, 'email')).toMatchObject({ ok: true, send: { status: 'refused', rule: 'R03' } });
    expect(await w.tournee.shareDay(w.asPaul, '2026-11-11', w.proche.id, 'email')).toEqual({ ok: false, code: 'empty' });
    expect(await w.tournee.shareDay(w.asPaul, '2026-11-10', 'inconnu', 'email')).toEqual({ ok: false, code: 'unknown_recipient' });
    expect(await w.outbox()).toHaveLength(1);
    const dump = JSON.stringify(await w.db.all("SELECT * FROM journal WHERE type = 'rdv.tournee.essai'"));
    for (const secret of ['Dijon', 'Sam', 'tournée du']) expect(dump, secret).not.toContain(secret);
  });
});
