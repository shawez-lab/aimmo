import { expect, it } from 'vitest';
import {
  Acces,
  FicheClient,
  FicheUnique,
  RendezVous,
  SqlJournalStore,
  VISIT_CODE_MAX_ATTEMPTS,
  Visites,
  VisiteSecurisee,
  applyMigrations,
  fromSyncSqlite,
  verifyChain,
  type DirectionNotifier,
  type SafetyAlert,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { enClair } from './boite-essai.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const WEDNESDAY_10H = new Date('2026-12-09T09:00:00.000Z');
const MINUTE = 60_000;
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const TEMPLATE = 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}. Signé le {{signature.date}}.';

async function setup(notifier?: DirectionNotifier) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const rdv = new RendezVous(db, journal, { now });
  const visites = new Visites(db, journal, acces, { diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) }, rendezVous: rdv, now });
  const securite = new VisiteSecurisee(db, journal, visites, { now, ...(notifier ? { notifier } : {}) });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  await rdv.setAvailability(as('agent', alex.id), WEEK);
  await visites.createSlipTemplate(as('direction', 'd1'), TEMPLATE);
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Inès', lastName: 'Lefèvre-Durand' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: '+33 6 00 00 00 02' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'buy' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'B1', kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  const visit = await visites.schedule(as('agent', alex.id), { propertyId: property.id, projectId: project.id, start: WEDNESDAY_10H });
  if (!visit.ok) throw new Error(visit.code);
  const appointmentId = visit.visit.appointment.id;
  /** Le code rangé dans la boîte d'essai, lu dans le dernier SMS. */
  const lastCode = async () => {
    const [m] = await enClair(db.all<{ id: string; body: string }>("SELECT m.id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.channel = 'sms' ORDER BY m.occurred_at DESC, m.rowid DESC LIMIT 1"));
    return /(\d{6})/.exec(m!.body)![1]!;
  };
  return { db, journal, store, securite, visites, rdv, network, alex, sam, as, person, appointmentId, lastCode, setClock: (t: number) => (clock = t), clock: () => clock };
}

describeWithSqlite('T05 · visite sécurisée', () => {
  it('aucune visite confirmée sans téléphone et identité confirmés [R54] ; le code part par le contrôle central, rangé dans la boîte d’essai', async () => {
    const t = await setup();
    const agent = t.as('agent', t.alex.id);
    expect(await t.securite.isConfirmed(t.appointmentId)).toBe(false);
    expect(await t.securite.confirm(agent, t.appointmentId, { code: '000000', lastName: 'Lefèvre-Durand' })).toMatchObject({ ok: false, rule: 'R54', code: 'no_code' });
    expect(await t.securite.sendCode(agent, t.appointmentId, { consentProof: 'accord oral au téléphone, noté par l’agent' })).toMatchObject({ ok: true });
    const code = await t.lastCode();
    // Bon code, mauvais nom : rien n'est confirmé.
    expect(await t.securite.confirm(agent, t.appointmentId, { code, lastName: 'Martin' })).toMatchObject({ ok: false, code: 'bad_identity' });
    expect(await t.securite.isConfirmed(t.appointmentId)).toBe(false);
    // Le nom, sans accents ni casse, et le code : confirmé.
    expect(await t.securite.confirm(agent, t.appointmentId, { code, lastName: 'lefevre durand' })).toEqual({ ok: true, confirmed: true });
    expect(await t.securite.isConfirmed(t.appointmentId)).toBe(true);
    // Rien de saisi au journal [R13].
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(new RegExp(`${code}|Lefèvre|lefevre|Martin|33600000002`));
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('un code ne sert qu’une fois, expire, et cinq essais faux le bloquent', async () => {
    const t = await setup();
    const agent = t.as('agent', t.alex.id);
    await t.securite.sendCode(agent, t.appointmentId, { consentProof: 'accord oral' });
    const code = await t.lastCode();
    t.setClock(TUESDAY_10H + 31 * MINUTE);
    expect(await t.securite.confirm(agent, t.appointmentId, { code, lastName: 'Lefèvre-Durand' })).toMatchObject({ ok: false, code: 'expired' });
    t.setClock(TUESDAY_10H + 40 * MINUTE);
    await t.securite.sendCode(agent, t.appointmentId, { consentProof: 'accord oral' });
    const second = await t.lastCode();
    for (let i = 0; i < VISIT_CODE_MAX_ATTEMPTS; i += 1) {
      expect(await t.securite.confirm(agent, t.appointmentId, { code: second === '111111' ? '222222' : '111111', lastName: 'Lefèvre-Durand' })).toMatchObject({ ok: false, code: 'bad_code' });
    }
    expect(await t.securite.confirm(agent, t.appointmentId, { code: second, lastName: 'Lefèvre-Durand' })).toMatchObject({ ok: false, code: 'blocked' });
    // Un nouveau code remet les essais à zéro ; une fois confirmé, le code ne sert plus.
    await t.securite.sendCode(agent, t.appointmentId, { consentProof: 'accord oral' });
    const third = await t.lastCode();
    expect(await t.securite.confirm(agent, t.appointmentId, { code: third, lastName: 'Lefèvre-Durand' })).toEqual({ ok: true, confirmed: true });
    expect(await t.securite.sendCode(agent, t.appointmentId, { consentProof: 'accord oral' })).toMatchObject({ ok: false, code: 'already_confirmed' });
    await expect(t.db.run('UPDATE visit_safety SET phone_confirmed_at = NULL')).rejects.toThrow();
  });

  it('un accord retiré par le visiteur ne se redonne pas par la seule parole de l’agent [R03] ; la réservation ne dit jamais « confirmée » [R54]', async () => {
    const t = await setup();
    const agent = t.as('agent', t.alex.id);
    const c = await t.store.addConsent({ networkId: t.network.id, personId: t.person.id, purpose: 'visite_securisee', channel: 'sms', proof: 'test', givenAt: new Date(TUESDAY_10H - 60 * MINUTE) });
    await t.store.withdrawConsent(c.id, new Date(TUESDAY_10H - 30 * MINUTE));
    expect(await t.securite.sendCode(agent, t.appointmentId, { consentProof: 'accord oral' })).toEqual({ ok: false, rule: 'R03', code: 'consent_withdrawn' });
    expect(await t.db.all("SELECT * FROM messages WHERE channel = 'sms'")).toEqual([]);
    const bodies = await t.db.all<{ body: string }>("SELECT body FROM messages WHERE direction = 'out'");
    for (const b of bodies) expect(b.body).not.toMatch(/confirmée/);
  });

  it('le code respecte l’arrêt et les horaires [R01, R04] ; seuls l’agent du visiteur et la direction [R16]', async () => {
    const t = await setup();
    expect(await t.securite.sendCode(t.as('agent', t.sam.id), t.appointmentId, { consentProof: 'accord' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.securite.sendCode(t.as('compliance', 'c1'), t.appointmentId, { consentProof: 'accord' })).toMatchObject({ ok: false, rule: 'R16' });
    t.setClock(Date.parse('2026-12-08T21:00:00.000Z'));
    expect(await t.securite.sendCode(t.as('agent', t.alex.id), t.appointmentId, { consentProof: 'accord' })).toMatchObject({ ok: false, rule: 'R01', code: 'send_refused' });
    t.setClock(TUESDAY_10H);
    await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'stop', notedAt: new Date(TUESDAY_10H - MINUTE) });
    expect(await t.securite.sendCode(t.as('agent', t.alex.id), t.appointmentId, { consentProof: 'accord' })).toMatchObject({ ok: false, rule: 'R04' });
    expect(await t.db.all("SELECT * FROM messages WHERE channel = 'sms'")).toEqual([]);
  });

  it('l’alerte en un geste est rangée même si l’envoi échoue, avec la commune et l’heure de la visite, puis reprise sans doublon', async () => {
    const received: SafetyAlert[] = [];
    let down = true;
    const t = await setup({
      notify: async (a) => {
        if (down) throw new Error('panne');
        await new Promise((r) => setTimeout(r, 5));
        received.push(a);
      },
    });
    t.setClock(WEDNESDAY_10H.getTime() + 10 * MINUTE);
    const r = await t.securite.raise(t.as('agent', t.alex.id), 'alerte-0001');
    expect(r).toEqual({ ok: true, recorded: true, notified: false });
    // Le même geste envoyé deux fois : une seule alerte.
    await t.securite.raise(t.as('agent', t.alex.id), 'alerte-0001');
    down = false;
    const done = await Promise.all([t.securite.retry(), t.securite.retry()]);
    expect(done.reduce((a, b) => a + b, 0)).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 'alerte-0001', agentId: t.alex.id, town: 'Talant', visitStartAt: WEDNESDAY_10H.toISOString(), appointmentId: t.appointmentId });
    expect(await t.securite.retry()).toBe(0);
    const list = await t.securite.list(t.as('direction', 'd1'));
    expect(list).toMatchObject({ ok: true, alerts: [{ id: 'alerte-0001', notified: true }] });
    expect(JSON.stringify(list)).not.toMatch(/Inès|Lefèvre/);
    expect(await t.securite.list(t.as('agent', t.alex.id))).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.securite.raise(t.as('direction', 'd1'), 'alerte-0002')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.securite.raise(t.as('agent', t.sam.id), 'alerte-0001')).toMatchObject({ ok: false, rule: 'R16' });
    await expect(t.db.run('DELETE FROM safety_alerts')).rejects.toThrow();
  });

  it('l’alerte retient la visite en cours plutôt que la suivante ; les refus d’accès vont au journal [R16]', async () => {
    const t = await setup();
    // Une seconde visite à 11 h 15 ; l'alerte part à 10 h 30, pendant la première.
    const p2 = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'B2', kind: 'home', city: 'Dijon', priceEur: 200_000, surfaceM2: 60, rooms: 3, status: 'available' });
    const project = (await t.db.first<{ id: string }>('SELECT id FROM projects'))!;
    const v2 = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p2.id, projectId: project.id, start: new Date(WEDNESDAY_10H.getTime() + 75 * MINUTE) });
    if (!v2.ok) throw new Error(v2.code);
    t.setClock(WEDNESDAY_10H.getTime() + 30 * MINUTE);
    await t.securite.raise(t.as('agent', t.alex.id), 'alerte-0010');
    const row = await t.db.first<{ town: string; appointment_id: string }>("SELECT town, appointment_id FROM safety_alerts WHERE id = 'alerte-0010'");
    expect(row).toEqual({ town: 'Talant', appointment_id: t.appointmentId });
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    await t.securite.list(t.as('agent', t.alex.id));
    await t.securite.raise(t.as('direction', 'd1'), 'alerte-0011');
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length).toBe(before + 2);
  });

  it('un nom vide ou sans lettre latine ne passe jamais pour celui de la fiche [R54] ; l’alerte retrouve une visite décalée', async () => {
    const t = await setup();
    const agent = t.as('agent', t.alex.id);
    await t.db.run("UPDATE persons SET last_name = '王' WHERE id = ?", [t.person.id]);
    await t.securite.sendCode(agent, t.appointmentId, { consentProof: 'accord oral' });
    const code = await t.lastCode();
    expect(await t.securite.confirm(agent, t.appointmentId, { code, lastName: '' })).toMatchObject({ ok: false, code: 'bad_identity' });
    expect(await t.securite.confirm(agent, t.appointmentId, { code, lastName: '李' })).toMatchObject({ ok: false, code: 'bad_identity' });
    expect(await t.securite.confirm(agent, t.appointmentId, { code, lastName: '王' })).toEqual({ ok: true, confirmed: true });
    const moved = await t.rdv.moveFromAgenda(t.appointmentId, new Date(WEDNESDAY_10H.getTime() + 120 * MINUTE));
    if (!moved.ok) throw new Error(moved.code);
    t.setClock(WEDNESDAY_10H.getTime() + 130 * MINUTE);
    await t.securite.raise(agent, 'alerte-0020');
    expect(await t.db.first("SELECT town, appointment_id FROM safety_alerts WHERE id = 'alerte-0020'")).toEqual({ town: 'Talant', appointment_id: moved.appointment.id });
  });

  it('sans panne, la direction est prévenue aussitôt, en essai : une ligne au journal, rien ne part', async () => {
    const t = await setup();
    expect(await t.securite.raise(t.as('agent', t.alex.id), 'alerte-0003')).toEqual({ ok: true, recorded: true, notified: true });
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'alerte.direction.essai')).toHaveLength(1);
    expect(entries.filter((e) => e.type === 'visite.alerte')).toHaveLength(1);
  });
});
