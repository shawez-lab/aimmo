import { describe, expect, it } from 'vitest';
import { FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { LOCK_TITLE, Notifications, lockText, lockTextIsSafe, type AgentPushGate, type PushPayload } from '../src/automatismes/notifications.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agents, personnes et coordonnées inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const TUE_23H = Date.parse('2027-10-12T21:00:00.000Z');
const WED_8H = Date.parse('2027-10-13T06:00:00.000Z');
const MIN = 60_000;

async function setup(options: { gate?: AgentPushGate } = {}) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const lea = await store.createAgent({ networkId: network.id, firstName: 'Léa', lastName: 'Agent' });
  const asAgent = (id: string) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  const person = async (firstName: string, agentId: string = alex.id) => {
    const p = await store.createPerson({ networkId: network.id, agentId, firstName });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'phone', value: '+33612345678' });
    return p.id;
  };
  const sent: { agentId: string; payload: PushPayload; at: number }[] = [];
  // La porte du contrôle central, en essai : elle garde chaque envoi.
  const gate: AgentPushGate = options.gate ?? { sendToAgent: async ({ agentId, payload }) => (sent.push({ agentId, payload, at: clock }), 'ok') };
  let k = 0;
  // La tâche « rappeler » d'un contact chaud (Q04), posée sans sa qualification : seule sa fiche compte ici.
  const callback = async (personId: string) => {
    const id = `cb-${++k}`;
    raw.exec('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO callback_tasks (id, network_id, person_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES (?, ?, ?, 'q', ?, 'r', ?, ?, NULL)", [
      id,
      network.id,
      personId,
      id,
      new Date(clock + 60 * MIN).toISOString(),
      new Date(clock).toISOString(),
    ]);
    raw.exec('PRAGMA foreign_keys = ON');
    return id;
  };
  const message = async (personId: string, at: number = clock, agentId: string | null = null) => {
    const id = `msg-${++k}`;
    await db.run(
      "INSERT INTO messages (id, network_id, agent_id, person_id, channel, direction, author_kind, body, occurred_at, created_at) VALUES (?, ?, ?, ?, 'whatsapp', 'in', 'person', ?, ?, ?)",
      [id, network.id, agentId, personId, 'Bonjour, je vends au 12 rue des Tuiles, 345 000 €, rappelez-moi au 06 12 34 56 78', new Date(at).toISOString(), new Date(at).toISOString()],
    );
    return id;
  };
  const notifications = new Notifications(db, journal, gate, { now, newId });
  return { db, journal, store, unique, network, alex, lea, asAgent, person, sent, callback, message, notifications, setClock: (t: number) => (clock = t), clock: () => clock };
}

describe('HX27 · texte écran verrouillé, sans base', () => {
  it('[R415] le texte n’est fait que de phrases fixes et de nombres', () => {
    expect(lockText('immediate', ['contact_chaud'])).toEqual({ title: 'AIMMO', body: 'Un contact chaud à rappeler maintenant' });
    expect(lockText('haute', ['client_ecrit', 'client_ecrit', 'rendez_vous']).body).toBe('2 messages de clients · un rendez-vous');
    expect(lockText('normale', ['piece_recue', 'tache', 'tache']).body).toBe('Une pièce reçue · 2 tâches à faire');
    expect(lockTextIsSafe(LOCK_TITLE)).toBe(true);
    // Un prénom, une adresse, un numéro, un montant ou une adresse mail ne passent jamais.
    for (const bad of ['Un message de Noa', '12 rue des Tuiles', '06 12 34 56 78', '345 000 €', 'noa@example.test', '', 'Appeler Martin maintenant']) expect(lockTextIsSafe(bad)).toBe(false);
  });
});

describeWithSqlite('HX27 · notifications sur le téléphone, réglables', () => {
  it('[R412] un contact chaud est notifié tout de suite, seul, à l’agent qui suit la fiche', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    const task = await t.callback(noa);
    t.setClock(t.clock() + 5_000);
    const [r] = await t.notifications.hotContact(task);
    expect(r).toMatchObject({ ok: true, value: { kind: 'contact_chaud', urgency: 'immediate', status: 'envoyee', agent_id: t.alex.id } });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.agentId).toBe(t.alex.id);
    // Moins d'une minute entre la tâche « rappeler » et l'envoi.
    const created = await t.db.first<{ created_at: string }>('SELECT created_at FROM callback_tasks WHERE id = ?', [task]);
    expect((t.sent[0]?.at ?? 0) - Date.parse(created?.created_at ?? '')).toBeLessThan(MIN);
    expect(t.sent[0]?.payload).toMatchObject({ urgency: 'immediate', title: 'AIMMO', body: 'Un contact chaud à rappeler maintenant' });

    // Le même contact chaud n'est jamais notifié deux fois [R18].
    await t.notifications.hotContact(task);
    await t.notifications.flush();
    expect(t.sent).toHaveLength(1);
    // Léa ne reçoit rien d'une fiche qu'elle ne suit pas [R16].
    expect(await t.notifications.notify({ agentId: t.lea.id, personId: noa, kind: 'contact_chaud', sourceKey: 'autre' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(t.sent.every((s) => s.agentId === t.alex.id)).toBe(true);
  });

  it('[R412] le contact chaud ne se coupe pas, et dit à sa place le message pas encore parti de la même personne', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    expect(await t.notifications.setSettings(me, { quietStart: 0, quietEnd: 0, levels: { contact_chaud: 'coupee' } })).toEqual({ ok: false, code: 'hot_fixed' });
    const noa = await t.person('Noa');
    const msg = await t.message(noa);
    const [m] = await t.notifications.inbound(msg);
    expect(m).toMatchObject({ ok: true, value: { kind: 'client_ecrit', urgency: 'haute', status: 'a_envoyer' } });
    await t.notifications.hotContact(await t.callback(noa));
    const rows = await t.db.all<{ kind: string; status: string }>('SELECT kind, status FROM agent_notifications ORDER BY rowid');
    expect(rows).toEqual([
      { kind: 'client_ecrit', status: 'remplacee' },
      { kind: 'contact_chaud', status: 'envoyee' },
    ]);
    // Un nouveau message juste après le contact chaud n'est pas redit.
    const [again] = await t.notifications.inbound(await t.message(noa));
    expect(again).toMatchObject({ ok: true, value: null, reason: 'deja_dit' });
    await t.notifications.flush();
    expect(t.sent).toHaveLength(1);
  });

  it('[R414] le reste est groupé par urgence, un envoi par période, qui compte chaque sorte', async () => {
    const t = await setup();
    const a = await t.person('Noa');
    const b = await t.person('Sacha');
    for (const p of [a, b, a]) await t.notifications.inbound(await t.message(p));
    await t.notifications.notify({ agentId: t.alex.id, personId: a, kind: 'piece_recue', sourceKey: 'piece:1' });
    await t.notifications.notify({ agentId: t.alex.id, personId: b, kind: 'info', sourceKey: 'info:1' });
    expect(t.sent).toHaveLength(0);

    const first = await t.notifications.flush();
    expect(first.map((p) => [p.urgency, p.count, p.status])).toEqual([
      ['haute', 3, 'partie'],
      ['normale', 1, 'partie'],
      ['basse', 1, 'partie'],
    ]);
    expect(t.sent.map((s) => s.payload.body)).toEqual(['3 messages de clients', 'Une pièce reçue', 'Une information']);

    // Un nouveau message cinq minutes après : il attend la fin de la période de 15 minutes.
    t.setClock(t.clock() + 5 * MIN);
    await t.notifications.inbound(await t.message(b));
    expect(await t.notifications.flush()).toEqual([]);
    t.setClock(t.clock() + 10 * MIN);
    const next = await t.notifications.flush();
    expect(next.map((p) => [p.urgency, p.count])).toEqual([['haute', 1]]);
    // Un message relu n'est pas notifié deux fois [R18].
    expect((await t.db.all('SELECT id FROM agent_notifications')).length).toBe(6);
  });

  it('[R413] rien de non urgent pendant les heures calmes ; une personne qui vient d’écrire passe ; le reste part à la fin', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    expect(await t.notifications.setSettings(me, { quietStart: 22 * 60, quietEnd: 7 * 60 + 30 })).toMatchObject({ ok: true });
    const noa = await t.person('Noa');
    const sacha = await t.person('Sacha');
    // 21 h à Paris : une pièce reçue de Sacha (sans message) et une tâche, notifiées à 22 h 30, heures calmes.
    t.setClock(TUE_23H - 30 * MIN);
    await t.notifications.notify({ agentId: t.alex.id, personId: sacha, kind: 'piece_recue', sourceKey: 'piece:1' });
    await t.notifications.notify({ agentId: t.alex.id, personId: sacha, kind: 'tache', sourceKey: 'tache:1' });
    // Un contact chaud sans message récent attend aussi.
    await t.notifications.notify({ agentId: t.alex.id, personId: sacha, kind: 'contact_chaud', sourceKey: 'cb:sacha' });
    expect(await t.notifications.flush()).toEqual([]);
    expect(t.sent).toHaveLength(0);

    // Noa écrit à 23 h : son message passe malgré les heures calmes.
    t.setClock(TUE_23H);
    await t.notifications.inbound(await t.message(noa));
    const night = await t.notifications.flush();
    expect(night.map((p) => [p.urgency, p.count])).toEqual([['haute', 1]]);
    expect(t.sent.map((s) => s.payload.body)).toEqual(['Un message de client']);

    // Une heure après, Noa n'a plus « juste écrit » : une pièce reçue d'elle attend le matin.
    t.setClock(TUE_23H + 60 * MIN);
    await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'piece_recue', sourceKey: 'piece:2' });
    expect(await t.notifications.flush()).toEqual([]);

    // 8 h le lendemain, hors heures calmes : tout part, groupé.
    t.setClock(WED_8H);
    const morning = await t.notifications.flush();
    expect(morning.map((p) => [p.urgency, p.count])).toEqual([
      ['immediate', 1],
      ['normale', 3],
    ]);
    expect(t.sent.slice(1).map((s) => s.payload.body)).toEqual(['Un contact chaud à rappeler maintenant', '2 pièces reçues · une tâche à faire']);
  });

  it('[R413] l’agent règle ses heures calmes et ses sortes, lui seul ; une sorte coupée ne notifie rien', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    expect(await t.notifications.setSettings(t.asAgent(t.lea.id), { quietStart: 1, quietEnd: 2 })).toMatchObject({ ok: true });
    expect(await t.notifications.setSettings({ role: 'direction', userId: 'dir-1', networkId: t.network.id }, { quietStart: 1, quietEnd: 2 })).toEqual({ ok: false, code: 'not_self' });
    expect(await t.notifications.setSettings(t.asAgent(t.alex.id), { quietStart: 1500, quietEnd: 2 })).toEqual({ ok: false, code: 'invalid_quiet' });
    expect(await t.notifications.setSettings(t.asAgent(t.alex.id), { quietStart: 0, quietEnd: 0, levels: { info: 'forte' } })).toEqual({ ok: false, code: 'invalid_level' });
    // Les réglages de Léa ne changent pas ceux d'Alex.
    expect(await t.notifications.settings(t.alex.id)).toMatchObject({ quietStart: 21 * 60, quietEnd: 8 * 60 });
    expect(await t.notifications.setSettings(t.asAgent(t.alex.id), { quietStart: 0, quietEnd: 0, levels: { info: 'coupee', piece_recue: 'haute' } })).toMatchObject({ ok: true });
    expect(await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'info', sourceKey: 'info:1' })).toEqual({ ok: true, value: null, reason: 'coupee' });
    expect(await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'piece_recue', sourceKey: 'piece:1' })).toMatchObject({ ok: true, value: { urgency: 'haute' } });
    // Un réglage ne s'efface pas : un nouveau s'ajoute [R17].
    expect((await t.db.all('SELECT id FROM agent_notification_settings')).length).toBe(2);
    await expect(t.db.run('DELETE FROM agent_notification_settings')).rejects.toThrow();
  });

  it('[R415] aucune donnée personnelle dans le texte visible écran verrouillé, ni dans ce qui part au téléphone, ni au journal', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    await t.notifications.hotContact(await t.callback(noa));
    const sacha = await t.person('Sacha');
    await t.notifications.inbound(await t.message(sacha));
    await t.notifications.notify({ agentId: t.alex.id, personId: sacha, kind: 'rendez_vous', sourceKey: 'rdv:1' });
    await t.notifications.flush();
    expect(t.sent.length).toBeGreaterThan(0);
    const outgoing = JSON.stringify(t.sent) + JSON.stringify(await t.db.all('SELECT lock_title, lock_line FROM agent_pushes'));
    const journal = JSON.stringify(await t.journal.all());
    for (const secret of ['Noa', 'Sacha', 'noa@example.test', '+33612345678', '06 12 34 56 78', 'Tuiles', '345', noa, sacha]) {
      expect(outgoing).not.toContain(secret);
    }
    for (const secret of ['Noa', 'Sacha', 'example.test', '+33612345678', 'Tuiles', '345 000']) expect(journal).not.toContain(secret);
    for (const s of t.sent) {
      expect(lockTextIsSafe(s.payload.title) && lockTextIsSafe(s.payload.body)).toBe(true);
      expect(s.payload.url).toBe(`/notifications/${s.payload.pushId}`);
    }
    // Le détail ne se lit que dans l'application, par l'agent, sous ses droits [R16].
    expect((await t.notifications.listFor(t.asAgent(t.alex.id))).length).toBe(3);
    expect(await t.notifications.listFor(t.asAgent(t.lea.id))).toEqual([]);
  });

  it('[R18] un échec du service reprend au passage suivant ; un passage coupé rend ses notifications ; sans téléphone, rien n’est perdu', async () => {
    let mode: 'echec' | 'ok' | 'aucun_appareil' | 'bloque' = 'echec';
    const calls: PushPayload[] = [];
    const t = await setup({
      gate: {
        sendToAgent: async ({ payload }) => {
          calls.push(payload);
          if (mode === 'bloque') throw new Error('coupure');
          return mode;
        },
      },
    });
    const noa = await t.person('Noa');
    const [hot] = await t.notifications.hotContact(await t.callback(noa));
    expect(hot).toMatchObject({ ok: true, value: { status: 'a_envoyer', push_id: null } });
    mode = 'ok';
    t.setClock(t.clock() + MIN);
    expect((await t.notifications.flush()).map((p) => [p.urgency, p.status])).toEqual([['immediate', 'partie']]);
    expect(calls).toHaveLength(2);

    // Un passage coupé net après sa réservation : au bout de deux minutes, ses notifications reviennent [R18].
    await t.notifications.inbound(await t.message(noa, t.clock(), t.alex.id));
    const row = await t.db.first<{ id: string }>("SELECT id FROM agent_notifications WHERE kind = 'client_ecrit'");
    // (Le message suit le contact chaud de moins de 30 minutes : il n'est pas redit, on en prend un autre sujet.)
    expect(row).toBeNull();
    await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'tache', sourceKey: 'tache:1' });
    await t.db.run("INSERT INTO agent_pushes (id, network_id, agent_id, urgency, count, lock_title, lock_line, status, reserved_at) VALUES ('coupe', ?, ?, 'normale', 1, 'AIMMO', 'Une tâche à faire', 'reservee', ?)", [
      t.network.id,
      t.alex.id,
      new Date(t.clock()).toISOString(),
    ]);
    await t.db.run("UPDATE agent_notifications SET status = 'en_envoi', push_id = 'coupe' WHERE kind = 'tache'");
    expect(await t.notifications.flush()).toEqual([]);
    t.setClock(t.clock() + 2 * MIN);
    mode = 'aucun_appareil';
    expect((await t.notifications.flush()).map((p) => [p.urgency, p.status])).toEqual([['normale', 'aucun_appareil']]);
    expect(await t.db.first('SELECT status FROM agent_pushes WHERE id = ?', ['coupe'])).toEqual({ status: 'incertaine' });
    // Sans téléphone relié, la notification reste à lire dans l'application.
    expect(await t.db.first("SELECT status FROM agent_notifications WHERE kind = 'tache'")).toEqual({ status: 'sans_appareil' });
    // Rien ne s'efface, et le texte envoyé reste celui réservé [R17].
    await expect(t.db.run('DELETE FROM agent_notifications')).rejects.toThrow();
    await expect(t.db.run("UPDATE agent_pushes SET lock_line = 'Noa' WHERE id = 'coupe'")).rejects.toThrow();
  });

  it('[R16] jamais pour une personne exclue, ni pour un agent parti', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    await t.db.run("INSERT INTO exclusions (id, network_id, person_id, reason, noted_at, created_at) VALUES ('e1', ?, ?, 'stop', ?, ?)", [t.network.id, noa, new Date(t.clock() - MIN).toISOString(), new Date(t.clock()).toISOString()]);
    expect(await t.notifications.hotContact(await t.callback(noa))).toEqual([{ ok: true, value: null, reason: 'exclue' }]);
    const sacha = await t.person('Sacha', t.lea.id);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.lea.id]);
    expect(await t.notifications.inbound(await t.message(sacha))).toEqual([{ ok: true, value: null, reason: 'agent_parti' }]);
    expect(t.sent).toHaveLength(0);
  });
  it('[R412] deux contacts chauds gardés par les heures calmes partent chacun seul, à la fin', async () => {
    const t = await setup();
    t.setClock(TUE_23H);
    const a = await t.person('Noa');
    const b = await t.person('Sacha');
    await t.notifications.notify({ agentId: t.alex.id, personId: a, kind: 'contact_chaud', sourceKey: 'cb:a' });
    await t.notifications.notify({ agentId: t.alex.id, personId: b, kind: 'contact_chaud', sourceKey: 'cb:b' });
    expect(t.sent).toHaveLength(0);
    t.setClock(WED_8H);
    expect((await t.notifications.flush()).map((p) => [p.urgency, p.count])).toEqual([
      ['immediate', 1],
      ['immediate', 1],
    ]);
    expect(t.sent.map((s) => s.payload.body)).toEqual(['Un contact chaud à rappeler maintenant', 'Un contact chaud à rappeler maintenant']);
  });

  it('[R16] une notification gardée est relue avant de partir : exclue ou fiche plus vue, elle est annulée', async () => {
    const t = await setup();
    t.setClock(TUE_23H);
    const noa = await t.person('Noa');
    const sacha = await t.person('Sacha');
    await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'tache', sourceKey: 'tache:noa' });
    await t.notifications.notify({ agentId: t.alex.id, personId: sacha, kind: 'tache', sourceKey: 'tache:sacha' });
    await t.notifications.notify({ agentId: t.alex.id, personId: sacha, kind: 'contact_chaud', sourceKey: 'cb:sacha' });
    // Dans la nuit, Noa est exclue et la fiche de Sacha passe à Léa.
    await t.db.run("INSERT INTO exclusions (id, network_id, person_id, reason, noted_at, created_at) VALUES ('e1', ?, ?, 'stop', ?, ?)", [t.network.id, noa, new Date(TUE_23H + MIN).toISOString(), new Date(TUE_23H + MIN).toISOString()]);
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.lea.id, sacha]);
    t.setClock(WED_8H);
    expect(await t.notifications.flush()).toEqual([]);
    expect(t.sent).toHaveLength(0);
    expect((await t.db.all<{ status: string }>('SELECT status FROM agent_notifications')).map((r) => r.status)).toEqual(['annulee', 'annulee', 'annulee']);
  });

  it('[R18] une notification restée « en envoi » derrière un envoi déjà fini suit son envoi au passage suivant', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'tache', sourceKey: 'tache:1' });
    await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'info', sourceKey: 'info:1' });
    const at = new Date(t.clock()).toISOString();
    // Une coupure entre l'état de l'envoi et celui de ses notifications : l'un est fini, l'autre pas.
    await t.db.run("INSERT INTO agent_pushes (id, network_id, agent_id, urgency, count, lock_title, lock_line, status, reserved_at, done_at) VALUES ('rate', ?, ?, 'normale', 1, 'AIMMO', 'Une tâche à faire', 'echec', ?, ?)", [t.network.id, t.alex.id, at, at]);
    await t.db.run("INSERT INTO agent_pushes (id, network_id, agent_id, urgency, count, lock_title, lock_line, status, reserved_at, done_at) VALUES ('parti', ?, ?, 'basse', 1, 'AIMMO', 'Une information', 'partie', ?, ?)", [t.network.id, t.alex.id, at, at]);
    await t.db.run("UPDATE agent_notifications SET status = 'en_envoi', push_id = 'rate' WHERE kind = 'tache'");
    await t.db.run("UPDATE agent_notifications SET status = 'en_envoi', push_id = 'parti' WHERE kind = 'info'");
    expect((await t.notifications.flush()).map((p) => [p.urgency, p.count])).toEqual([['normale', 1]]);
    expect(await t.db.all('SELECT kind, status FROM agent_notifications ORDER BY rowid')).toEqual([
      { kind: 'tache', status: 'envoyee' },
      { kind: 'info', status: 'envoyee' },
    ]);
    expect(t.sent).toHaveLength(1);
  });
  it('[R414] deux passages qui se croisent ne réservent jamais deux envois de la même urgence dans une période', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'tache', sourceKey: 'tache:1' });
    // Un autre passage a réservé un envoi « normale » juste après que celui-ci a lu la période.
    const at = new Date(t.clock()).toISOString();
    await t.db.run("INSERT INTO agent_pushes (id, network_id, agent_id, urgency, count, lock_title, lock_line, status, reserved_at, done_at) VALUES ('autre', ?, ?, 'normale', 1, 'AIMMO', 'Une tâche à faire', 'partie', ?, ?)", [t.network.id, t.alex.id, at, at]);
    const pushGroup = (t.notifications as unknown as { pushGroup: (a: string, u: string) => Promise<unknown> }).pushGroup.bind(t.notifications);
    const settings = t.db.first.bind(t.db);
    // La lecture de la période ne voit pas l'autre envoi : seule l'écriture le voit.
    let skipped = false;
    (t.db as { first: typeof t.db.first }).first = (async (sql: string, params?: readonly (string | number | null)[]) => {
      if (!skipped && sql.includes('SELECT reserved_at FROM agent_pushes')) return (skipped = true), null;
      return settings(sql, params);
    }) as typeof t.db.first;
    expect(await pushGroup(t.alex.id, 'normale')).toBeNull();
    expect(skipped).toBe(true);
    expect(t.sent).toHaveLength(0);
    expect(await t.db.first("SELECT status FROM agent_notifications WHERE kind = 'tache'")).toEqual({ status: 'a_envoyer' });
  });
  it('[R18] une réservation reprise par un autre passage avant la prise de ses notifications n’envoie rien', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'tache', sourceKey: 'tache:1' });
    const run = t.db.run.bind(t.db);
    // Juste après la réservation, un autre passage la déclare incertaine (pause de plus de deux minutes).
    (t.db as { run: typeof t.db.run }).run = (async (sql: string, params?: readonly (string | number | null)[]) => {
      const r = await run(sql, params);
      if (sql.includes('INSERT INTO agent_pushes')) await run("UPDATE agent_pushes SET status = 'incertaine' WHERE status = 'reservee'");
      return r;
    }) as typeof t.db.run;
    expect(await t.notifications.flush()).toEqual([]);
    expect(t.sent).toHaveLength(0);
    expect(await t.db.first("SELECT status, push_id FROM agent_notifications WHERE kind = 'tache'")).toEqual({ status: 'a_envoyer', push_id: null });
    (t.db as { run: typeof t.db.run }).run = run;
    expect((await t.notifications.flush()).map((p) => [p.urgency, p.status])).toEqual([['normale', 'partie']]);
    expect(t.sent).toHaveLength(1);
  });
  it('[R414] un groupe de 150 notifications part en un seul envoi, chaque écriture sous 100 paramètres', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    for (let i = 0; i < 150; i++) await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'tache', sourceKey: `tache:${i}` });
    const run = t.db.run.bind(t.db);
    let most = 0;
    (t.db as { run: typeof t.db.run }).run = (async (sql: string, params: readonly (string | number | null)[] = []) => ((most = Math.max(most, params.length)), run(sql, params))) as typeof t.db.run;
    const batch = t.db.batch?.bind(t.db);
    if (batch) (t.db as { batch: typeof batch }).batch = async (statements) => (statements.forEach((st) => (most = Math.max(most, st.params?.length ?? 0))), batch(statements));
    expect((await t.notifications.flush()).map((p) => [p.urgency, p.count, p.status])).toEqual([['normale', 150, 'partie']]);
    expect(t.sent.map((x) => x.payload.body)).toEqual(['150 tâches à faire']);
    expect(most).toBeLessThanOrEqual(100);
  });
  it('[R412] un contact chaud gardé la nuit dit aussi le message de la même personne arrivé avant son départ', async () => {
    const t = await setup();
    const noa = await t.person('Noa');
    t.setClock(TUE_23H);
    // Gardé par les heures calmes : Noa n'a pas écrit depuis 30 minutes.
    await t.notifications.notify({ agentId: t.alex.id, personId: noa, kind: 'contact_chaud', sourceKey: 'cb:noa' });
    t.setClock(WED_8H - 10 * MIN);
    // 7 h 50, encore en heures calmes : le message de Noa est dit par le contact chaud qui attend.
    expect(await t.notifications.inbound(await t.message(noa))).toEqual([{ ok: true, value: null, reason: 'deja_dit' }]);
    // Noa vient d'écrire : le contact chaud part, seul, et rien d'autre après lui.
    expect((await t.notifications.flush()).map((p) => [p.urgency, p.count])).toEqual([['immediate', 1]]);
    t.setClock(WED_8H + 20 * MIN);
    expect(await t.notifications.flush()).toEqual([]);
    expect(t.sent.map((x) => x.payload.body)).toEqual(['Un contact chaud à rappeler maintenant']);
  });
});
