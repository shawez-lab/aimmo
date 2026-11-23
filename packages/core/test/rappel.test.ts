import { expect, it } from 'vitest';
import {
  Acces,
  Attribution,
  DEFAULT_ATTRIBUTION_SETTINGS,
  FicheAgent,
  Qualification,
  Rappels,
  ReconnaissanceBien,
  SqlJournalStore,
  applyMigrations,
  createCaptation,
  fromSyncSqlite,
  type CallbackWindow,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un dimanche à 23 h et un mardi à 10 h, heure de Paris.
const SUNDAY_23H = Date.parse('2026-12-06T22:00:00.000Z');
const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const MINUTE = 60_000;

async function setup(callbackWindow?: CallbackWindow) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, reception } = createCaptation(db, journal, { now, withQualification: false });
  const qualification = new Qualification(db, store, fiche, reception, new ReconnaissanceBien(db), journal, { now });
  const settings = callbackWindow ? { ...DEFAULT_ATTRIBUTION_SETTINGS, callbackWindow } : undefined;
  const attribution = new Attribution(db, fiche, journal, { now, ...(settings ? { settings } : {}) });
  const rappels = new Rappels(db, fiche, journal, { now, ...(callbackWindow ? { callbackWindow } : {}) });
  const ficheAgent = new FicheAgent(db, new Acces(db, store, fiche, journal, { now }), { now, ...(callbackWindow ? { callbackWindow } : {}) });
  const acces = new Acces(db, store, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  await attribution.addZone(network.id, alex.id, 'Talant');
  await attribution.addZone(network.id, sam.id, 'Dijon');
  let seq = 0;
  /** Un formulaire inventé, passé par qualification, note, attribution et tâche ; rend la qualification. */
  const contact = async (who: string, message: string) => {
    seq += 1;
    const started = clock;
    await chaine.receive(network.id, 'site_form', { submissionId: `f-${seq}`, firstName: who, email: `${who.toLowerCase()}@example.test`, message });
    const row = await db.first<{ id: string }>('SELECT id FROM inbound_messages ORDER BY rowid DESC LIMIT 1');
    const q = (await qualification.qualify(row!.id))!;
    await attribution.attribute(q.id);
    const task = await rappels.forQualification(q.id);
    return { q, task, elapsed: clock - started };
  };
  const as = (role: 'agent' | 'direction' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  return { db, store, journal, rappels, ficheAgent, attribution, acces, network, alex, sam, contact, as, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('Q04 · tâche « rappeler » et liste des contacts chauds', () => {
  it('chaque contact chaud a sa tâche chez son agent en moins d’une minute, de jour comme de nuit ; un contact tiède ou froid n’en a pas', async () => {
    const t = await setup();
    // La nuit du dimanche, le délai part de l'ouverture du lundi à 8 h : 9 h d'attente, puis 8 h [R682].
    const due = [8 * 60 * MINUTE, 17 * 60 * MINUTE];
    for (const [i, at] of [TUESDAY_10H, SUNDAY_23H].entries()) {
      t.setClock(at);
      const hot = await t.contact(`Hugo${i}`, 'Je souhaite vendre ma maison à Talant rapidement.');
      expect(hot.task).toMatchObject({ reason: 'Vendeur, délai immédiat, commune donnée : 70, chaud.', done_at: null });
      expect(Date.parse(hot.task!.created_at) - at).toBeLessThan(MINUTE);
      expect(Date.parse(hot.task!.due_at) - at).toBe(due[i]);
    }
    expect((await t.contact('Inès', 'Je cherche une maison.')).task).toBeNull();
    expect((await t.contact('Jules', 'Vous êtes ouverts le samedi ?')).task).toBeNull();
  });

  it('[R18] une seule tâche par contact et par projet', async () => {
    const t = await setup();
    const a = await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    const b = await t.contact('Hugo', 'Je veux vendre vite, c’est urgent, à Talant.');
    expect(b.task!.id).toBe(a.task!.id);
    expect(await t.db.all('SELECT id FROM callback_tasks')).toHaveLength(1);
    expect((await t.rappels.forQualification(a.q.id))!.id).toBe(a.task!.id);
  });

  it('[R18] après une fusion de fiches, une seule tâche par projet et une seule ligne dans la liste', async () => {
    const t = await setup();
    const a = await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    const b = await t.contact('Hugues', 'Je souhaite vendre ma maison à Talant, c’est urgent.');
    expect(a.q.person_id).not.toBe(b.q.person_id);
    const { fiche } = createCaptation(t.db, t.journal);
    await fiche.merge({ survivorId: b.q.person_id, mergedId: a.q.person_id, reason: 'même personne' });
    const c = await t.contact('Hugues', 'Je veux vendre ma maison à Talant rapidement.');
    expect(c.task!.project_id).toBe(a.task!.project_id);
    const open = await t.db.all<{ project_id: string }>('SELECT project_id FROM callback_tasks WHERE done_at IS NULL');
    expect(new Set(open.map((o) => o.project_id)).size).toBe(open.length);
    const list = await t.rappels.hotList(t.acces, t.as('direction', 'dir-1'));
    const keys = list.ok ? list.value.contacts.map((x) => x.personId) : [];
    expect(keys).toHaveLength(2);
  });

  it('[R16] la liste ne montre à un agent que ses contacts ; la direction voit tout ; un partenaire rien', async () => {
    const t = await setup();
    await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    await t.contact('Elsa', 'Je souhaite vendre mon appartement à Dijon, c’est urgent.');
    const alex = await t.rappels.hotList(t.acces, t.as('agent', t.alex.id));
    expect(alex.ok && alex.value.contacts.map((c) => c.firstName)).toEqual(['Hugo']);
    const sam = await t.rappels.hotList(t.acces, t.as('agent', t.sam.id));
    expect(sam.ok && sam.value.contacts.map((c) => c.firstName)).toEqual(['Elsa']);
    const direction = await t.rappels.hotList(t.acces, t.as('direction', 'dir-1'));
    expect(direction.ok && direction.value.contacts).toHaveLength(2);
    expect((await t.rappels.hotList(t.acces, t.as('partner', 'p-1'))).ok).toBe(false);
  });

  it('[R16] la tâche d’une fiche gardée sans agent paraît chez l’agent de la fiche réunie, jamais chez un autre', async () => {
    const t = await setup();
    const { q, task } = await t.contact('Zoé', 'Je souhaite vendre ma maison rapidement, c’est urgent.');
    expect(task).not.toBeNull();
    expect((await t.store.getPerson(q.person_id))!.agent_id).toBeNull();
    const followed = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Zoé' });
    const { fiche } = createCaptation(t.db, t.journal);
    await fiche.merge({ survivorId: q.person_id, mergedId: followed.id, reason: 'même personne' });
    const mine = await t.rappels.hotList(t.acces, t.as('agent', t.alex.id));
    expect(mine.ok && mine.value.contacts.map((c) => c.taskId)).toEqual([task!.id]);
    const other = await t.rappels.hotList(t.acces, t.as('agent', t.sam.id));
    expect(other.ok && other.value.contacts).toEqual([]);
    // La fiche réunie passe à un autre agent, à côté d'une autre : plus personne hors de la direction [R16].
    const second = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Zoé' });
    await fiche.merge({ survivorId: q.person_id, mergedId: second.id, reason: 'même personne' });
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, second.id]);
    const none = await t.rappels.hotList(t.acces, t.as('agent', t.alex.id));
    expect(none.ok && none.value.contacts).toEqual([]);
  });

  it('[R25] une personne exclue après sa tâche ne figure plus dans la liste ; exclue avant, elle n’a pas de tâche', async () => {
    const t = await setup();
    const a = await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    await t.store.addExclusion({ networkId: t.network.id, personId: a.q.person_id, reason: 'stop', notedAt: new Date(TUESDAY_10H) });
    const list = await t.rappels.hotList(t.acces, t.as('agent', t.alex.id));
    expect(list.ok && list.value.contacts).toEqual([]);
    expect(await t.rappels.forQualification(a.q.id)).toBeNull();
    const direction = await t.rappels.hotList(t.acces, t.as('direction', 'dir-1'));
    expect(direction.ok && direction.value.contacts).toEqual([]);
    // Exclue d'abord : la nouvelle demande chaude ne crée aucune tâche.
    const b = await t.contact('Elsa', 'Je souhaite vendre mon appartement à Dijon, c’est urgent.');
    expect(b.task).not.toBeNull();
    const c = await t.contact('Gaëlle', 'Je souhaite vendre ma maison à Talant.');
    await t.store.addExclusion({ networkId: t.network.id, personId: c.q.person_id, reason: 'network_list', notedAt: new Date(TUESDAY_10H) });
    const late = await t.contact('Gaëlle', 'Finalement je veux vendre rapidement à Talant.');
    expect(late.task).toBeNull();
  });

  it('matin et soir ; une tâche faite sort de la liste et garde sa ligne ; en retard, elle le dit', async () => {
    const t = await setup();
    const a = await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    const morning = await t.rappels.hotList(t.acces, t.as('agent', t.alex.id));
    expect(morning.ok && morning.value.slot).toBe('morning');
    t.setClock(TUESDAY_10H + 9 * 60 * MINUTE);
    const evening = await t.rappels.hotList(t.acces, t.as('agent', t.alex.id));
    expect(evening.ok && evening.value).toMatchObject({ slot: 'evening', contacts: [{ overdue: true }] });
    expect(await t.rappels.done(t.acces, t.as('agent', t.sam.id), a.task!.id)).toBe(false);
    expect(await t.rappels.done(t.acces, t.as('agent', t.alex.id), a.task!.id)).toBe(true);
    const after = await t.rappels.hotList(t.acces, t.as('agent', t.alex.id));
    expect(after.ok && after.value.contacts).toEqual([]);
    expect(await t.db.all('SELECT id FROM callback_tasks WHERE done_at IS NOT NULL')).toHaveLength(1);
  });

  it('aucune notification n’est envoyée : rien ne passe par un canal', async () => {
    const t = await setup();
    const before = (await t.db.all('SELECT id FROM send_log')).length;
    await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    // Seule la première réponse au formulaire passe par le contrôle des envois ; la tâche, elle, n'envoie rien.
    const sends = await t.db.all<{ kind: string }>('SELECT kind FROM send_log');
    expect(sends.length - before).toBe(1);
    expect(sends.every((s) => s.kind === 'reply')).toBe(true);
  });
});

describeWithSqlite('AU042 · la tâche « rappeler » suit la limite du service de rappel', () => {
  it('[R682] une tâche rangée en heures écoulées se lit avec la limite du service, comme la réattribution', async () => {
    const t = await setup();
    // Samedi 12 décembre 2026, 21 h à Paris : contact chaud.
    const saturday = Date.parse('2026-12-12T20:00:00.000Z');
    t.setClock(saturday);
    const hot = await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    expect(hot.task!.due_at).toBe('2026-12-14T15:00:00.000Z');
    // Une tâche d'avant R682 : sa limite rangée tombe le dimanche à 5 h.
    await t.db.run('UPDATE callback_tasks SET due_at = ? WHERE id = ?', [new Date(saturday + 8 * 60 * MINUTE).toISOString(), hot.task!.id]);
    t.setClock(Date.parse('2026-12-13T10:00:00.000Z'));
    const list = await t.rappels.hotList(t.acces, t.as('direction', 'dir-1'));
    expect(list.ok && list.value.contacts).toEqual([expect.objectContaining({ taskId: hot.task!.id, dueAt: '2026-12-14T15:00:00.000Z', overdue: false })]);
    t.setClock(Date.parse('2026-12-14T15:00:00.000Z'));
    const later = await t.rappels.hotList(t.acces, t.as('direction', 'dir-1'));
    expect(later.ok && later.value.contacts[0]).toMatchObject({ overdue: true });
  });
});

describeWithSqlite('AU042 · un service de rappel réglé autrement vaut partout', () => {
  it('[R682] ouvert le dimanche : la tâche, la liste, la fiche de l’agent et la réattribution disent la même limite', async () => {
    const open7 = { timeZone: 'Europe/Paris', from: 8 * 60, until: 20 * 60, days: [1, 2, 3, 4, 5, 6, 7], closedOnHolidays: true };
    const t = await setup(open7);
    t.setClock(Date.parse('2026-12-12T20:00:00.000Z'));
    const hot = await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    const due = '2026-12-13T15:00:00.000Z';
    expect(hot.task!.due_at).toBe(due);
    const list = await t.rappels.hotList(t.acces, t.as('direction', 'dir-1'));
    expect(list.ok && list.value.contacts[0]).toMatchObject({ dueAt: due });
    const fiche = await t.ficheAgent.read(t.as('agent', t.alex.id), hot.q.person_id);
    expect(fiche.ok && fiche.value.callbacks).toEqual([expect.objectContaining({ dueAt: due })]);
    t.setClock(Date.parse(due) - 60_000);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
  });

  it('[R682] une tâche rangée avec d’autres heures du service se lit avec les heures en vigueur', async () => {
    const open7 = { timeZone: 'Europe/Paris', from: 8 * 60, until: 20 * 60, days: [1, 2, 3, 4, 5, 6, 7], closedOnHolidays: true };
    const t = await setup(open7);
    t.setClock(Date.parse('2026-12-12T20:00:00.000Z'));
    const hot = await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    // Rangée quand le dimanche était fermé : lundi 16 h ; le service ouvre désormais le dimanche, limite dimanche 16 h.
    await t.db.run('UPDATE callback_tasks SET due_at = ? WHERE id = ?', ['2026-12-14T15:00:00.000Z', hot.task!.id]);
    const due = '2026-12-13T15:00:00.000Z';
    const list = await t.rappels.hotList(t.acces, t.as('direction', 'dir-1'));
    expect(list.ok && list.value.contacts[0]).toMatchObject({ dueAt: due });
    const fiche = await t.ficheAgent.read(t.as('agent', t.alex.id), hot.q.person_id);
    expect(fiche.ok && fiche.value.callbacks).toEqual([expect.objectContaining({ dueAt: due })]);
    t.setClock(Date.parse(due));
    expect(await t.attribution.reassignOverdue(t.network.id)).toHaveLength(1);
  });
});
