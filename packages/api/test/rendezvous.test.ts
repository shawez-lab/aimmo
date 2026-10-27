import { expect, it } from 'vitest';
import { APPOINTMENT_PURPOSE, FicheClient, RendezVous, SqlJournalStore, applyMigrations, parisInstant, type SqlDatabase, type Viewer } from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés et données inventées pour les tests. Novembre 2026 : Paris est à UTC+1 ; le lundi 9 novembre.
const KEY = 'test-cle-reservation-kkkkkkkkkkkkkkkkkkkkkkkkkk';
const KEY_EST = 'test-cle-estimation-iiiiiiiiiiiiiiiiiiiiiiiiiiii';
const BASE = 'https://aimmo-api.example.workers.dev/v1/rendez-vous';
const VISITOR = 'visiteur-essai-0000000001';
const LINK = 'https://rdv.example.test/r/';
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');

async function world(limits?: { slotsPerVisitor: number; bookingsPerVisitor: number; perNetwork: number }) {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const other = await store.createNetwork('Autre réseau');
  const zoe = await store.createAgent({ networkId: other.id, firstName: 'Zoé', lastName: 'Essai' });
  const journal = new SqlJournalStore(db);
  const rdv = new RendezVous(db, journal, { now: () => NOW });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  await rdv.setAvailability(asPaul, { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: '09:00', to: '12:00' })) });
  await rdv.setAvailability({ role: 'agent', userId: zoe.id, networkId: other.id }, { weekly: [{ weekday: 2, from: '09:00', to: '12:00' }] });
  // Un rendez-vous déjà pris, dont rien ne doit sortir.
  await rdv.book({ networkId: net.id, agentId: paul.id, personId: (await store.createPerson({ networkId: net.id, firstName: 'Marc', lastName: 'Secret' })).id, kind: 'visite', start: at('2026-11-10', '11:00'), source: 'agent' });
  const intakeKeys = JSON.stringify([
    { sha256: await sha256Hex(KEY), networkId: net.id, source: 'site_booking' },
    { sha256: await sha256Hex(KEY_EST), networkId: net.id, source: 'site_estimate' },
  ]);
  const config = { db, mode: 'essai', apiKeys: undefined, intakeKeys, appointmentLinkBase: LINK, now: () => NOW, ...(limits ? { bookingLimits: limits } : {}) };
  const call = async (path: 'creneaux' | 'reservation', body: unknown, key = KEY) => {
    const res = await handleRequest(
      new Request(`${BASE}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      config as never,
    );
    return { status: res.status, text: await res.clone().text(), body: (await res.json()) as Record<string, unknown> };
  };
  const slotsAsk = (over: Record<string, unknown> = {}) => ({ visitorId: VISITOR, agentId: paul.id, kind: 'estimation', from: '2026-11-10', days: 1, ...over });
  const bookAsk = (start: string, over: Record<string, unknown> = {}) => ({
    visitorId: VISITOR,
    agentId: paul.id,
    kind: 'estimation',
    start,
    source: 'site',
    firstName: 'Léa',
    email: 'lea.exemple@example.test',
    consentProof: 'case cochée « J’accepte d’être contacté pour ce rendez-vous », formulaire de réservation',
    ...over,
  });
  return { db, store, net, paul, zoe, journal, rdv, call, slotsAsk, bookAsk };
}

describeWithSqlite('V08 · réservation depuis le site et les messages, en mode essai', () => {
  it('[R33] les créneaux ne portent que leur début et leur fin, rien d’autre de l’agenda', async () => {
    const w = await world();
    const r = await w.call('creneaux', w.slotsAsk());
    expect(r.status).toBe(200);
    const slots = r.body.slots as { start: string; end: string }[];
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(Object.keys(s).sort()).toEqual(['end', 'start']);
    // Le rendez-vous déjà pris (11 h, trajet compris) n'est pas proposé, et rien de lui ne sort.
    expect(slots.map((s) => s.start)).not.toContain(at('2026-11-10', '10:30').toISOString());
    for (const secret of ['Marc', 'Secret', 'visite', 'booked']) expect(r.text, secret).not.toContain(secret);
    // Un agent d'un autre réseau, ou inconnu : une liste vide, sans rien dire de plus.
    expect((await w.call('creneaux', w.slotsAsk({ agentId: w.zoe.id }))).body).toEqual({ ok: true, mode: 'essai', slots: [] });
    expect((await w.call('creneaux', w.slotsAsk({ agentId: 'inconnu' }))).body).toEqual({ ok: true, mode: 'essai', slots: [] });
    // La signature ne se réserve pas en ligne ; des champs en trop sont refusés.
    expect((await w.call('creneaux', w.slotsAsk({ kind: 'signature' }))).status).toBe(400);
    expect((await w.call('creneaux', w.slotsAsk({ days: 15 }))).status).toBe(400);
    expect((await w.call('creneaux', w.slotsAsk({ agenda: true }))).status).toBe(400);
  });

  it('[R03] l’accord « rendez-vous » est enregistré avec sa preuve au moment de réserver ; la confirmation revient tout de suite, rien ne part', async () => {
    const w = await world();
    const slots = (await w.call('creneaux', w.slotsAsk())).body.slots as { start: string }[];
    const r = await w.call('reservation', w.bookAsk(slots[0]!.start));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'essai', sent: false, appointment: { kind: 'estimation', start: slots[0]!.start }, confirmation: { booked: true } });
    expect((await w.rdv.byToken(r.body.token as string))?.confirmation_status).toBe('sent');
    expect(r.body.token).toMatch(/^[a-z]{32}$/);
    const [lea] = await w.store.findPersonsByIdentifier(w.net.id, 'email', 'lea.exemple@example.test');
    const consents = await w.store.listConsents(lea!.id);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ purpose: APPOINTMENT_PURPOSE, channel: 'email', given_at: NOW.toISOString(), withdrawn_at: null });
    expect(consents[0]!.proof).toContain('case cochée');
    expect(consents[0]!.proof).toContain('réservation en ligne (site)');
    // Mode essai : la confirmation est rangée, jamais envoyée [R26].
    const outbox = await w.db.all<{ message_id: string }>('SELECT message_id FROM trial_outbox');
    expect(outbox).toHaveLength(1);
    // Le lien rendu sert au rendez-vous.
    expect((await w.rdv.byToken(r.body.token as string))?.person_id).toBe(lea!.id);
    // Sans preuve d'accord : refusé avant tout.
    expect((await w.call('reservation', w.bookAsk(slots[1]!.start, { consentProof: ' ' }))).status).toBe(400);
  });

  it('[R32] le même créneau demandé deux fois : une seule réservation ; l’accord d’une réservation refusée est retiré', async () => {
    const w = await world();
    const slots = (await w.call('creneaux', w.slotsAsk())).body.slots as { start: string }[];
    const [a, b] = await Promise.all([
      w.call('reservation', w.bookAsk(slots[0]!.start, { visitorId: 'visiteur-essai-0000000002', email: 'a.exemple@example.test' })),
      w.call('reservation', w.bookAsk(slots[0]!.start, { visitorId: 'visiteur-essai-0000000003', email: 'b.exemple@example.test' })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // Un créneau non proposé (agenda pris, ou hors plage) : refusé, sans fiche nouvelle.
    const before = (await w.db.all('SELECT id FROM persons')).length;
    expect((await w.call('reservation', w.bookAsk(at('2026-11-10', '14:00').toISOString(), { email: 'c.exemple@example.test' }))).status).toBe(409);
    expect((await w.db.all('SELECT id FROM persons')).length).toBe(before);
    // L'accord de la réservation perdue est retiré, jamais effacé.
    const loser = a.status === 409 ? 'a.exemple@example.test' : 'b.exemple@example.test';
    const [p] = await w.store.findPersonsByIdentifier(w.net.id, 'email', loser);
    const consents = p ? await w.store.listConsents(p.id) : [];
    expect(consents.every((c) => c.withdrawn_at !== null)).toBe(true);
  });

  it('[R16] la réponse ne dit pas si la personne était connue, exclue ou avait demandé l’arrêt ; elle est retrouvée par son mail', async () => {
    const w = await world();
    const known = await w.store.createPerson({ networkId: w.net.id, firstName: 'Léa', lastName: 'Exemple' });
    await w.store.addIdentifier({ networkId: w.net.id, personId: known.id, kind: 'email', value: 'lea.exemple@example.test' });
    await w.store.addExclusion({ networkId: w.net.id, personId: known.id, reason: 'stop', notedAt: new Date('2026-01-01T00:00:00Z') });
    const slots = (await w.call('creneaux', w.slotsAsk())).body.slots as { start: string }[];
    const r1 = await w.call('reservation', w.bookAsk(slots[0]!.start));
    const later = (await w.call('creneaux', w.slotsAsk({ from: '2026-11-11' }))).body.slots as { start: string }[];
    const r2 = await w.call('reservation', w.bookAsk(later[0]!.start, { visitorId: 'visiteur-essai-0000000009', email: 'nouveau.exemple@example.test' }));
    const shape = (b: Record<string, unknown>) => JSON.stringify({ ...b, token: 'x', appointment: { ...(b.appointment as object), start: 'x', end: 'x' } });
    expect(r1.status).toBe(200);
    expect(shape(r1.body)).toBe(shape(r2.body));
    // L'état réel reste sur le rendez-vous : la confirmation à une personne qui a dit stop est refusée [R02].
    expect((await w.rdv.byToken(r1.body.token as string))?.confirmation_status).toBe('refused');
    expect(r1.text).not.toContain(known.id);
    expect((await w.rdv.byToken(r1.body.token as string))?.person_id).toBe(known.id);
  });

  it('[R02] [R04] un numéro noté en WhatsApp sur une fiche qui a dit stop : retrouvé en réservant par téléphone, rien ne part', async () => {
    const w = await world();
    const known = await w.store.createPerson({ networkId: w.net.id, firstName: 'Léa' });
    await w.store.addIdentifier({ networkId: w.net.id, personId: known.id, kind: 'whatsapp', value: '+33612345678' });
    await w.store.addExclusion({ networkId: w.net.id, personId: known.id, reason: 'stop', notedAt: new Date('2026-01-01T00:00:00Z') });
    const before = (await w.db.all('SELECT id FROM persons')).length;
    const slots = (await w.call('creneaux', w.slotsAsk())).body.slots as { start: string }[];
    const r = await w.call('reservation', w.bookAsk(slots[0]!.start, { email: undefined, phone: '06 12 34 56 78' }));
    expect(r.status).toBe(200);
    expect((await w.db.all('SELECT id FROM persons')).length).toBe(before);
    const a = await w.rdv.byToken(r.body.token as string);
    expect(a).toMatchObject({ person_id: known.id, confirmation_status: 'refused' });
    expect(await w.db.all('SELECT message_id FROM trial_outbox')).toHaveLength(0);
  });

  it('[R04] un mail nouveau et un téléphone d’une fiche qui a dit stop : la fiche est retrouvée, rien ne part', async () => {
    const w = await world();
    const known = await w.store.createPerson({ networkId: w.net.id, agentId: w.paul.id, firstName: 'Léa' });
    await w.store.addIdentifier({ networkId: w.net.id, personId: known.id, kind: 'phone', value: '+33612345678' });
    await w.store.addExclusion({ networkId: w.net.id, personId: known.id, reason: 'stop', notedAt: new Date('2026-01-01T00:00:00Z') });
    const before = (await w.db.all('SELECT id FROM persons')).length;
    const slots = (await w.call('creneaux', w.slotsAsk())).body.slots as { start: string }[];
    const r = await w.call('reservation', w.bookAsk(slots[0]!.start, { email: 'nouveau.mail@example.test', phone: '06 12 34 56 78' }));
    expect(r.status).toBe(200);
    expect((await w.db.all('SELECT id FROM persons')).length).toBe(before);
    expect(await w.rdv.byToken(r.body.token as string)).toMatchObject({ person_id: known.id, confirmation_status: 'refused' });
    expect(await w.db.all('SELECT message_id FROM trial_outbox')).toHaveLength(0);
  });

  it('un numéro connu en WhatsApp seulement sert aussi la confirmation par SMS', async () => {
    const w = await world();
    const known = await w.store.createPerson({ networkId: w.net.id, firstName: 'Léa' });
    await w.store.addIdentifier({ networkId: w.net.id, personId: known.id, kind: 'whatsapp', value: '+33612345678' });
    const slots = (await w.call('creneaux', w.slotsAsk())).body.slots as { start: string }[];
    const r = await w.call('reservation', w.bookAsk(slots[0]!.start, { email: undefined, phone: '06 12 34 56 78' }));
    expect(await w.rdv.byToken(r.body.token as string)).toMatchObject({ person_id: known.id, confirmation_status: 'sent' });
    expect(await w.db.all('SELECT message_id FROM trial_outbox')).toHaveLength(1);
  });

  it('un contact porté par deux fiches distinctes : le rendez-vous tient, sans confirmation par message', async () => {
    const w = await world();
    for (const name of ['Léa', 'Lou']) {
      const p = await w.store.createPerson({ networkId: w.net.id, firstName: name });
      await w.store.addIdentifier({ networkId: w.net.id, personId: p.id, kind: 'email', value: 'partage.exemple@example.test' });
    }
    const slots = (await w.call('creneaux', w.slotsAsk())).body.slots as { start: string }[];
    const r = await w.call('reservation', w.bookAsk(slots[0]!.start, { email: 'partage.exemple@example.test' }));
    expect(r.body).toMatchObject({ ok: true, confirmation: { booked: true } });
    expect((await w.rdv.byToken(r.body.token as string))?.confirmation_status).toBeNull();
    expect(await w.db.all('SELECT message_id FROM trial_outbox')).toHaveLength(0);
  });

  it('limites d’appels par visiteur et par réseau ; seule la clé site_booking ouvre la réservation', async () => {
    const w = await world({ slotsPerVisitor: 2, bookingsPerVisitor: 1, perNetwork: 100 });
    expect((await w.call('creneaux', w.slotsAsk())).status).toBe(200);
    expect((await w.call('creneaux', w.slotsAsk())).status).toBe(200);
    expect((await w.call('creneaux', w.slotsAsk())).status).toBe(429);
    expect((await w.call('creneaux', w.slotsAsk({ visitorId: 'visiteur-essai-0000000004' }))).status).toBe(200);
    const slots = (await w.call('creneaux', w.slotsAsk({ visitorId: 'visiteur-essai-0000000005' }))).body.slots as { start: string }[];
    expect((await w.call('reservation', w.bookAsk(slots[0]!.start))).status).toBe(200);
    expect((await w.call('reservation', w.bookAsk(slots[slots.length - 1]!.start, { email: 'autre.exemple@example.test' }))).status).toBe(429);
    const n = await world({ slotsPerVisitor: 10, bookingsPerVisitor: 10, perNetwork: 2 });
    expect((await n.call('creneaux', n.slotsAsk({ visitorId: 'visiteur-essai-0000000006' }))).status).toBe(200);
    expect((await n.call('creneaux', n.slotsAsk({ visitorId: 'visiteur-essai-0000000007' }))).status).toBe(200);
    expect((await n.call('creneaux', n.slotsAsk({ visitorId: 'visiteur-essai-0000000008' }))).status).toBe(429);
    expect((await w.call('creneaux', w.slotsAsk(), KEY_EST)).status).toBe(401);
    expect((await w.call('reservation', w.bookAsk(at('2026-11-10', '10:30').toISOString()), KEY_EST)).status).toBe(401);
  });

  it('[R13] le journal ne porte ni nom, ni mail, ni preuve', async () => {
    const w = await world();
    const slots = (await w.call('creneaux', w.slotsAsk())).body.slots as { start: string }[];
    await w.call('reservation', w.bookAsk(slots[0]!.start));
    const dump = JSON.stringify(await w.db.all('SELECT * FROM journal'));
    for (const secret of ['Léa', 'lea.exemple', 'case cochée']) expect(dump, secret).not.toContain(secret);
    expect(dump).toContain('rdv.en_ligne');
  });
});
