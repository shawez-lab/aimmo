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
        return { mode: 'reel', receipt: `remise-${received.length}` };
      },
    });
    t.setClock(WEDNESDAY_10H.getTime() + 10 * MINUTE);
    const r = await t.securite.raise(t.as('agent', t.alex.id), 'alerte-0001');
    expect(r).toEqual({ ok: true, recorded: true, notified: false, mode: null, level: 1 });
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

  it('[R54] AU008 : en essai, l’alerte n’est jamais dite « prévenue » : une ligne au journal, rien ne part, et pas de reprise', async () => {
    const t = await setup();
    // Le constat de l'audit : l'essai rendait `notified: true` alors que rien n'était parti.
    expect(await t.securite.raise(t.as('agent', t.alex.id), 'alerte-0003')).toEqual({ ok: true, recorded: true, notified: false, mode: 'essai', level: 1 });
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'alerte.direction.essai')).toHaveLength(1);
    expect(entries.filter((e) => e.type === 'visite.alerte')).toHaveLength(1);
    expect(await t.securite.list(t.as('direction', 'd1'))).toMatchObject({ ok: true, alerts: [{ id: 'alerte-0003', mode: 'essai', notified: false, acknowledged: false }] });
    // Une alerte en essai n'est pas renvoyée en boucle par la reprise.
    expect(await t.securite.retry()).toBe(0);
    expect((await t.journal.all()).filter((e) => e.type === 'alerte.direction.essai')).toHaveLength(1);
  });

  it('[R54] AU008 : prévenue seulement sur l’accusé réel du service d’envoi ; une réponse sans accusé est une panne reprise', async () => {
    const answers: unknown[] = [{ mode: 'reel' }, { mode: 'reel', receipt: '' }, undefined, { mode: 'reel', receipt: 'sms-remise-42' }];
    const t = await setup({ notify: async () => answers.shift() as never });
    const agent = t.as('agent', t.alex.id);
    expect(await t.securite.raise(agent, 'alerte-0100')).toMatchObject({ notified: false, mode: null });
    expect(await t.securite.retry()).toBe(0);
    expect(await t.securite.retry()).toBe(0);
    expect(await t.securite.retry()).toBe(1);
    expect(await t.db.first("SELECT mode, receipt FROM safety_alerts WHERE id = 'alerte-0100'")).toEqual({ mode: 'reel', receipt: 'sms-remise-42' });
    expect(await t.securite.status(agent, 'alerte-0100')).toMatchObject({ ok: true, alert: { notified: true, mode: 'reel', level: 1, acknowledged: false } });
    const types = (await t.journal.all()).map((e) => e.type);
    expect(types.filter((x) => x === 'visite.alerte_en_panne')).toHaveLength(3);
    expect(types.filter((x) => x === 'visite.alerte_prevenue')).toHaveLength(1);
  });

  it('[R54] AU008 : sans acquittement, l’alerte monte d’un palier toutes les 5 minutes jusqu’au palier 3, une fois chacun', async () => {
    const received: SafetyAlert[] = [];
    const t = await setup({ notify: async (a) => (received.push(a), { mode: 'reel', receipt: `r-${received.length}` }) });
    const start = WEDNESDAY_10H.getTime() + 10 * MINUTE;
    t.setClock(start);
    await t.securite.raise(t.as('agent', t.alex.id), 'alerte-0200');
    expect(received.map((a) => a.level)).toEqual([1]);
    t.setClock(start + 4 * MINUTE);
    expect(await t.securite.escalate()).toBe(0);
    t.setClock(start + 5 * MINUTE);
    // Deux passages en même temps : une seule montée.
    const both = await Promise.all([t.securite.escalate(), t.securite.escalate()]);
    expect(both[0] + both[1]).toBe(1);
    expect(received.map((a) => a.level)).toEqual([1, 2]);
    expect(received[1]).toMatchObject({ id: 'alerte-0200', town: 'Talant', appointmentId: t.appointmentId });
    t.setClock(start + 10 * MINUTE);
    expect(await t.securite.tick()).toEqual({ retried: 0, escalated: 1 });
    t.setClock(start + 30 * MINUTE);
    expect(await t.securite.escalate()).toBe(0);
    expect(received.map((a) => a.level)).toEqual([1, 2, 3]);
    const types = (await t.journal.all()).filter((e) => e.type === 'visite.alerte_escalade').map((e) => (e.data as { level: number }).level);
    expect(types).toEqual([2, 3]);
    // Un palier ne redescend jamais.
    await expect(t.db.run("UPDATE safety_alerts SET level = 1 WHERE id = 'alerte-0200'")).rejects.toThrow();
  });

  it('[R54] AU008 : la direction acquitte, l’escalade s’arrête, l’agent le lit ; l’acquittement ne change plus', async () => {
    const received: SafetyAlert[] = [];
    const t = await setup({ notify: async (a) => (received.push(a), { mode: 'reel', receipt: `r-${received.length}` }) });
    const start = WEDNESDAY_10H.getTime() + 10 * MINUTE;
    t.setClock(start);
    const agent = t.as('agent', t.alex.id);
    await t.securite.raise(agent, 'alerte-0300');
    t.setClock(start + 2 * MINUTE);
    // Ni l'agent, ni un autre réseau ne l'acquittent.
    expect(await t.securite.acknowledge(agent, 'alerte-0300')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.securite.acknowledge({ role: 'direction', userId: 'd9', networkId: 'autre' }, 'alerte-0300')).toMatchObject({ ok: false, rule: 'R16' });
    const ack = await t.securite.acknowledge(t.as('direction', 'd1'), 'alerte-0300');
    expect(ack).toMatchObject({ ok: true, already: false, alert: { acknowledged: true, acknowledgedAt: new Date(start + 2 * MINUTE).toISOString(), level: 1 } });
    expect(await t.securite.acknowledge(t.as('direction', 'd2'), 'alerte-0300')).toMatchObject({ ok: true, already: true });
    expect(await t.db.first("SELECT acknowledged_by FROM safety_alerts WHERE id = 'alerte-0300'")).toEqual({ acknowledged_by: 'd1' });
    t.setClock(start + 20 * MINUTE);
    expect(await t.securite.escalate()).toBe(0);
    expect(received).toHaveLength(1);
    expect(await t.securite.status(agent, 'alerte-0300')).toMatchObject({ ok: true, alert: { acknowledged: true, level: 1 } });
    // Un autre agent ne lit pas l'alerte d'Alex.
    expect(await t.securite.status(t.as('agent', t.sam.id), 'alerte-0300')).toMatchObject({ ok: false, rule: 'R16' });
    await expect(t.db.run("UPDATE safety_alerts SET acknowledged_by = 'd2' WHERE id = 'alerte-0300'")).rejects.toThrow();
    expect((await t.journal.all()).filter((e) => e.type === 'visite.alerte_acquittee')).toHaveLength(1);
  });

  it('[R54] AU008 : la lecture de l’agent fait monter le palier dû ; passé l’heure, plus d’escalade', async () => {
    const received: SafetyAlert[] = [];
    const t = await setup({ notify: async (a) => (received.push(a), { mode: 'reel', receipt: `r-${received.length}` }) });
    const start = WEDNESDAY_10H.getTime() + 10 * MINUTE;
    t.setClock(start);
    const agent = t.as('agent', t.alex.id);
    await t.securite.raise(agent, 'alerte-0400');
    t.setClock(start + 6 * MINUTE);
    expect(await t.securite.status(agent, 'alerte-0400')).toMatchObject({ ok: true, alert: { level: 2, notified: true } });
    // Un seul passage, 12 minutes après le geste : le palier dû est 3, atteint d'un coup.
    t.setClock(start + 12 * MINUTE);
    expect(await t.securite.escalate()).toBe(1);
    expect(await t.db.first("SELECT level FROM safety_alerts WHERE id = 'alerte-0400'")).toEqual({ level: 3 });
    expect(received.map((a) => a.level)).toEqual([1, 2, 3]);
    t.setClock(start + 6 * MINUTE);
    await t.securite.raise(agent, 'alerte-0401');
    t.setClock(start + 6 * MINUTE + 61 * MINUTE);
    expect(await t.securite.escalate()).toBe(0);
    expect(await t.securite.status(agent, 'alerte-0401')).toMatchObject({ ok: true, alert: { level: 1 } });
  });

  it('[R54] [R05] AU008 : une prise faite avant la montée de palier n’envoie jamais le nouveau palier', async () => {
    const received: SafetyAlert[] = [];
    let down = true;
    const notifier: DirectionNotifier = {
      notify: async (a) => {
        if (down) throw new Error('panne');
        received.push(a);
        return { mode: 'reel', receipt: `r-${received.length}` };
      },
    };
    const t = await setup(notifier);
    const start = WEDNESDAY_10H.getTime() + 10 * MINUTE;
    t.setClock(start);
    await t.securite.raise(t.as('agent', t.alex.id), 'alerte-0600');
    down = false;
    // La reprise s'arrête juste après sa prise, avant de relire l'alerte.
    let gate: (() => void) | null = null;
    let paused: (() => void) | null = null;
    const reached = new Promise<void>((r) => (paused = r));
    let armed = true;
    const slowDb: SqlDatabase = new Proxy(t.db, {
      get(target, prop, recv) {
        if (prop === 'first') {
          return async (sql: string, params?: unknown[]) => {
            if (armed && sql.startsWith('SELECT * FROM safety_alerts WHERE id')) {
              armed = false;
              paused!();
              await new Promise<void>((r) => (gate = r));
            }
            return target.first(sql, params as never);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const slow = new VisiteSecurisee(slowDb, t.journal, t.visites, { now: () => new Date(t.clock()), notifier });
    t.setClock(start + 3 * MINUTE);
    const late = slow.retry();
    await reached;
    t.setClock(start + 5 * MINUTE);
    expect(await t.securite.escalate()).toBe(1);
    gate!();
    expect(await late).toBe(0);
    expect(received.map((a) => a.level)).toEqual([2]);
  });

  it('[R54] AU008 : une alerte « prévenue » par l’ancien essai est reclassée en essai par la migration', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    const all = loadMigrations();
    await applyMigrations(db, all.filter((m) => m.id < '3960'));
    const store = new FicheClient(db);
    const network = await store.createNetwork('Réseau test');
    await db.run("INSERT INTO safety_alerts (id, network_id, agent_id, raised_at, notified_at, attempts) VALUES ('alerte-ancienne', ?, 'a1', '2026-11-01T09:00:00.000Z', '2026-11-01T09:00:01.000Z', 1)", [network.id]);
    await applyMigrations(db, all);
    expect(await db.first("SELECT notified_at, mode, trial_at FROM safety_alerts WHERE id = 'alerte-ancienne'")).toEqual({ notified_at: null, mode: 'essai', trial_at: '2026-11-01T09:00:01.000Z' });
  });

  it('[R54] AU008 : un envoi du palier précédent qui revient après la montée n’est pas compté pour le nouveau palier', async () => {
    let release: (() => void) | null = null;
    const received: SafetyAlert[] = [];
    const t = await setup({
      notify: async (a) => {
        received.push(a);
        if (a.level === 1 && received.length === 1) throw new Error('panne');
        if (a.level === 1) await new Promise<void>((r) => (release = r));
        return { mode: 'reel', receipt: `r-${received.length}` };
      },
    });
    const start = WEDNESDAY_10H.getTime() + 10 * MINUTE;
    t.setClock(start);
    await t.securite.raise(t.as('agent', t.alex.id), 'alerte-0500');
    t.setClock(start + 3 * MINUTE);
    const slow = t.securite.retry();
    await new Promise((r) => setTimeout(r, 5));
    t.setClock(start + 5 * MINUTE);
    expect(await t.securite.escalate()).toBe(1);
    expect(await t.db.first("SELECT level, receipt FROM safety_alerts WHERE id = 'alerte-0500'")).toEqual({ level: 2, receipt: 'r-3' });
    release!();
    expect(await slow).toBe(0);
    expect(await t.db.first("SELECT level, receipt FROM safety_alerts WHERE id = 'alerte-0500'")).toEqual({ level: 2, receipt: 'r-3' });
  });
});
