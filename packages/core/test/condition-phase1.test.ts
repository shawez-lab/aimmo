import { expect, it } from 'vitest';
import {
  AUTOMATION_JOURNAL_TYPE,
  FicheClient,
  FicheUnique,
  PaliersBascule,
  SCHEDULER_JOURNAL_TYPE,
  SqlJournalStore,
  SqlSendJournal,
  appendEvent,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { ConditionPhase1, PHASE1_DAYS, phase1Condition, phase1DayStatus, type Phase1Report } from '../src/conditions-phases/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau d'essai, agent, clients, références de preuve. Mars 2027 est à l'heure d'hiver : un jour
// de Paris va de 23 h UTC la veille à 23 h UTC.
const PROOF = 'stockage/phase1/capture-automatisations.png';

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-03-01T10:00:00.000Z');
  const now = (): Date => new Date(clock);
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1');
  const agent = (await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' })).id;
  const condition = new ConditionPhase1(db, journal, { now });
  const sendJournal = new SqlSendJournal(db, undefined, now);
  let n = 0;
  const person = async (networkId = network.id) => (await store.createPerson({ networkId, agentId: networkId === network.id ? agent : null, firstName: `Client${(n += 1)}` })).id;
  /** Un message parti à cet instant, avec ou sans sa ligne « parti » du contrôle central. */
  const message = async (at: string, opts: { personId?: string; author?: 'ai' | 'system' | 'agent'; controlled?: boolean; networkId?: string } = {}) => {
    const networkId = opts.networkId ?? network.id;
    const personId = opts.personId ?? (await person(networkId));
    const m = await store.recordMessage({
      networkId,
      agentId: null,
      personId,
      conversationId: `c-${personId}`,
      channel: 'email',
      direction: 'out',
      authorKind: opts.author ?? 'system',
      body: 'Bonjour, voici le suivi.',
      occurredAt: new Date(at),
    });
    if (opts.controlled ?? true) await log(at, personId, 'sent', m.id, networkId);
    return { personId, messageId: m.id };
  };
  const log = (at: string, personId: string, outcome: 'sent' | 'refused' | 'failed', messageId: string | null = null, networkId = network.id) =>
    sendJournal.record({
      networkId,
      agentId: null,
      personId,
      messageId,
      channel: 'email',
      kind: 'follow_up',
      outcome,
      rule: outcome === 'refused' ? 'R04' : null,
      reason: 'essai',
      aiText: false,
      fallbackText: true,
      withMention: false,
      occurredAt: new Date(at),
    });
  /** Un passage du planificateur du socle à cet instant. */
  const plannerRun = async (at: string) => {
    setClock(at);
    await appendEvent(journal, { type: SCHEDULER_JOURNAL_TYPE, actor: 'system:planificateur', subject: null, data: { job: 'essai', slot: at, outcome: 'ok', error: null } }, now);
  };
  const addDay = (day: string, k: number) => new Date(Date.parse(`${day}T12:00:00.000Z`) + k * 86_400_000).toISOString().slice(0, 10);
  /** `count` jours propres à partir de `from` : un passage du planificateur à midi, puis le relevé le lendemain. */
  const cleanDays = async (from: string, count: number) => {
    for (let i = 0; i < count; i++) {
      const day = addDay(from, i);
      await plannerRun(`${day}T11:00:00.000Z`);
      setClock(`${addDay(day, 1)}T01:00:00.000Z`);
      const r = await condition.takeReading(network.id, day);
      if (!r.ok) throw new Error(r.code);
    }
  };
  const inventory = async (at: string, tasks: Partial<Record<string, number>> = {}) => {
    setClock(at);
    const r = await condition.declareInventory(direction, { tasks: { gohighlevel: 0, manychat: 0, site: 0, github_actions: 0, autre: 0, ...tasks }, proofRef: PROOF });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const report = async (at: string): Promise<Phase1Report> => {
    setClock(at);
    const r = await condition.report(direction);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((e) => JSON.parse(e.data) as Record<string, unknown>);
  return { raw, db, journal, store, fiche, network, other, as, direction, agent, condition, now, setClock, person, message, log, plannerRun, addDay, cleanDays, inventory, report, events };
}

describeWithSqlite('HX70 · 30 jours sans aucun envoi hors règles : la condition de la phase 1', () => {
  it('[R643] un jour sans relevé, ou sans aucun passage du planificateur, n’est jamais propre', async () => {
    expect(phase1DayStatus(null, { sent: 0, refused: 0, withoutControl: 0, whileExcluded: 0, siteGaps: 0, siteFailures: 0, outside: 0 })).toBe('sans_donnee');
    const t = await setup();
    // Le 10 : un passage, relevé. Le 11 : aucun passage, relevé quand même. Le 12 : un passage, jamais relevé.
    await t.plannerRun('2027-03-10T11:00:00.000Z');
    await t.plannerRun('2027-03-12T11:00:00.000Z');
    t.setClock('2027-03-13T01:00:00.000Z');
    expect((await t.condition.takeReading(t.network.id, '2027-03-10')).ok).toBe(true);
    const r11 = await t.condition.takeReading(t.network.id, '2027-03-11');
    expect(r11.ok && r11.value.plannerRuns).toBe(0);
    const rep = await t.report('2027-03-13T10:00:00.000Z');
    expect(rep.days.map((d) => [d.day, d.status])).toEqual([
      ['2027-03-10', 'propre'],
      ['2027-03-11', 'sans_donnee'],
      ['2027-03-12', 'sans_donnee'],
    ]);
    expect(rep.currentSeries).toBe(0);
    expect(rep.bestSeries).toBe(1);
  });

  it('[R643] le relevé ne se prend que pour un jour de Paris fini, une seule fois, et ne change plus', async () => {
    const t = await setup();
    // 23 h 30 UTC le 10 mars, c'est déjà le 11 à Paris : le 10 est fini, le 11 non.
    t.setClock('2027-03-10T23:30:00.000Z');
    expect(await t.condition.takeReading(t.network.id, '2027-03-11')).toEqual({ ok: false, rule: 'R643', code: 'jour_pas_fini' });
    expect(await t.condition.takeReading(t.network.id, '2027-03-12')).toEqual({ ok: false, rule: 'R643', code: 'jour_pas_fini' });
    expect(await t.condition.takeReading(t.network.id, '2027-02-30')).toEqual({ ok: false, rule: 'R643', code: 'bad_day' });
    expect(await t.condition.takeReading(t.network.id, '2027-13-01')).toEqual({ ok: false, rule: 'R643', code: 'bad_day' });
    expect(await t.condition.takeReading(t.network.id, '2027-03-32')).toEqual({ ok: false, rule: 'R643', code: 'bad_day' });
    expect(await t.condition.takeReading(t.network.id, '2025-12-31')).toEqual({ ok: false, rule: 'R643', code: 'bad_day' });
    const first = await t.condition.takeReading(t.network.id, '2027-03-10');
    expect(first.ok && first.already).toBe(false);
    // Un envoi hors contrôle rangé ensuite ne réécrit pas le relevé : le second appel rend le premier.
    await t.message('2027-03-10T12:00:00.000Z', { controlled: false });
    const second = await t.condition.takeReading(t.network.id, '2027-03-10');
    expect(second.ok && second.already).toBe(true);
    expect(second.ok && second.value.withoutControl).toBe(0);
    await expect(t.db.run("UPDATE phase1_day_readings SET without_control = 0 WHERE day = '2027-03-10'")).rejects.toThrow();
    await expect(t.db.run("DELETE FROM phase1_day_readings WHERE day = '2027-03-10'")).rejects.toThrow();
    expect(await t.events('condition_phase1.releve')).toHaveLength(1);
  });

  it('[R643] un message automatique parti sans ligne « parti » du contrôle rend le jour hors règles ; un refus, non', async () => {
    const t = await setup();
    const p = await t.person();
    await t.message('2027-03-10T09:00:00.000Z'); // passé par le contrôle
    await t.log('2027-03-10T09:30:00.000Z', p, 'refused'); // refusé : se voit, ne salit rien
    await t.message('2027-03-10T10:00:00.000Z', { author: 'agent', controlled: false }); // écrit par un humain du réseau
    // 23 h 30 UTC le 10 : le 11 à Paris.
    await t.message('2027-03-10T23:30:00.000Z', { author: 'ai', controlled: false });
    // Un message du même genre dans un autre réseau ne compte pas ici.
    await t.message('2027-03-10T12:00:00.000Z', { controlled: false, networkId: t.other.id });
    // Une ligne « en panne » du contrôle ne vaut pas une ligne « parti ».
    const failed = await t.message('2027-03-11T12:00:00.000Z', { controlled: false });
    await t.log('2027-03-11T12:00:00.000Z', failed.personId, 'failed', failed.messageId);
    const counts = await t.condition.count(t.network.id, '2027-03-10', '2027-03-11');
    expect(counts.get('2027-03-10')).toEqual({ sent: 1, refused: 1, withoutControl: 0, whileExcluded: 0, siteGaps: 0, siteFailures: 0, outside: 0 });
    expect(counts.get('2027-03-11')).toMatchObject({ sent: 0, withoutControl: 2 });
  });

  it('[R643] la base recompte les exclusions sans croire le contrôle : connue et en cours à l’instant, fiches réunies comprises', async () => {
    const t = await setup();
    const at = '2027-03-10T12:00:00.000Z';
    // A : exclue avant l'envoi, exclusion rangée avant : hors règles.
    const a = await t.person();
    t.setClock('2027-03-09T10:00:00.000Z');
    await t.store.addExclusion({ networkId: t.network.id, personId: a, reason: 'stop', notedAt: new Date('2027-03-09T10:00:00.000Z') });
    // B : exclusion datée d'avant, mais rangée après l'envoi : le contrôle ne pouvait pas la voir.
    const b = await t.person();
    t.setClock('2027-03-10T13:00:00.000Z');
    await t.store.addExclusion({ networkId: t.network.id, personId: b, reason: 'stop', notedAt: new Date('2027-03-10T11:00:00.000Z') });
    // C : exclusion levée avant l'envoi.
    const c = await t.person();
    t.setClock('2027-03-08T10:00:00.000Z');
    const ex = await t.store.addExclusion({ networkId: t.network.id, personId: c, reason: 'refused', notedAt: new Date('2027-03-08T10:00:00.000Z') });
    await t.store.liftExclusion(ex.id, new Date('2027-03-09T10:00:00.000Z'));
    // D réunie à E (exclue) avant l'envoi : hors règles. F réunie à G (exclue) après l'envoi : non.
    const d = await t.person();
    const e = await t.person();
    const f = await t.person();
    const g = await t.person();
    t.setClock('2027-03-09T10:00:00.000Z');
    await t.store.addExclusion({ networkId: t.network.id, personId: e, reason: 'stop', notedAt: new Date('2027-03-09T10:00:00.000Z') });
    await t.store.addExclusion({ networkId: t.network.id, personId: g, reason: 'stop', notedAt: new Date('2027-03-09T10:00:00.000Z') });
    await t.fiche.merge({ survivorId: d, mergedId: e, reason: 'même adresse' });
    t.setClock('2027-03-10T15:00:00.000Z');
    await t.fiche.merge({ survivorId: f, mergedId: g, reason: 'même adresse' });
    for (const personId of [a, b, c, d, f]) await t.message(at, { personId });
    const counts = await t.condition.count(t.network.id, '2027-03-10', '2027-03-10');
    expect(counts.get('2027-03-10')).toMatchObject({ sent: 5, whileExcluded: 2, withoutControl: 0 });
  });

  it('[R643] les écarts et les pannes signalés par le site sur ses automatisations comptent ; pas ceux des canaux de captation', async () => {
    const t = await setup();
    const paliers = new PaliersBascule(t.db, t.journal, { now: t.now });
    t.setClock('2027-03-10T09:00:00.000Z');
    await paliers.incident(t.network.id, 'rappel_visite', 'unexplained_gap', 'R04', 'intake:site_auto');
    await paliers.incident(t.network.id, 'courrier_vendeur', 'failure', null, 'system:bascule');
    await paliers.incident(t.network.id, 'captation_email', 'failure', null, 'system:captation');
    await paliers.incident(t.other.id, 'rappel_visite', 'unexplained_gap', null, 'intake:site_auto');
    const counts = await t.condition.count(t.network.id, '2027-03-10', '2027-03-10');
    expect(counts.get('2027-03-10')).toMatchObject({ siteGaps: 1, siteFailures: 1 });
  });

  it('[R643] un refus du socle que le site pouvait passer outre, ou une panne dont le retour en ombre n’a pas pu s’écrire, rend le jour hors règles', async () => {
    const t = await setup();
    const p = await t.person();
    const q = await t.person(t.other.id);
    t.setClock('2027-03-10T09:00:00.000Z');
    const ask = (personId: string, data: Record<string, unknown>) =>
      appendEvent(t.journal, { type: AUTOMATION_JOURNAL_TYPE, actor: 'intake:site_auto', subject: `person:${personId}`, data: { mode: 'essai', sent: false, automation: 'rappel_visite', ...data } }, t.now);
    // En ombre, le socle refuse pour R02 : le site décide seul, il a pu envoyer.
    await ask(p, { status: 'refused', rule: 'R02', decides: false });
    // Le socle décide : son refus vaut, rien n'est parti.
    await ask(p, { status: 'refused', rule: 'R02', decides: true });
    // Le socle aurait laissé partir ; ou fiche inconnue, sans règle : rien d'hors règles.
    await ask(p, { status: 'would_send', rule: null, decides: false });
    await ask(p, { status: 'refused', rule: null, decides: false, code: 'unknown_person' });
    // Un autre réseau ne compte pas ici.
    await ask(q, { status: 'refused', rule: 'R04', decides: false });
    // Le 11 : une panne dont le retour en ombre n'a pas pu s'écrire ; une autre erreur d'API ne compte pas.
    t.setClock('2027-03-11T09:00:00.000Z');
    await appendEvent(t.journal, { type: 'api.erreur', actor: 'intake:site_auto', subject: null, data: { route: 'automatisations.retour_arriere', error: 'Error' } }, t.now);
    await appendEvent(t.journal, { type: 'api.erreur', actor: 'intake:site', subject: null, data: { route: 'demandes', error: 'Error' } }, t.now);
    const counts = await t.condition.count(t.network.id, '2027-03-10', '2027-03-11');
    expect(counts.get('2027-03-10')).toMatchObject({ siteGaps: 1, siteFailures: 0 });
    expect(counts.get('2027-03-11')).toMatchObject({ siteGaps: 0, siteFailures: 1 });
  });

  it('[R643, R644] un jour figé propre ne le reste pas si un envoi hors règles est rangé après : le pire des deux l’emporte', async () => {
    const t = await setup();
    await t.cleanDays('2027-03-10', 3);
    expect((await t.report('2027-03-13T10:00:00.000Z')).currentSeries).toBe(3);
    t.setClock('2027-03-13T10:00:00.000Z');
    const r = await t.condition.declareOutsideSend(t.direction, { day: '2027-03-11', application: 'gohighlevel', proofRef: 'stockage/phase1/ghl-sms.png' });
    expect(r.ok).toBe(true);
    const rep = await t.report('2027-03-13T10:05:00.000Z');
    const d11 = rep.days.find((d) => d.day === '2027-03-11')!;
    expect(d11.status).toBe('hors_regles');
    expect(d11.recountWorse).toBe(true);
    expect(d11.reading?.outside).toBe(0);
    expect(rep.currentSeries).toBe(1);
    // Un relevé figé hors règles ne redevient jamais propre, même si le recompte ne voit plus rien.
    expect(phase1DayStatus({ plannerRuns: 3, sent: 0, refused: 0, withoutControl: 1, whileExcluded: 0, siteGaps: 0, siteFailures: 0, outside: 0 }, { sent: 0, refused: 0, withoutControl: 0, whileExcluded: 0, siteGaps: 0, siteFailures: 0, outside: 0 })).toBe(
      'hors_regles',
    );
    // Un envoi constaté ne s'efface ni ne change.
    await expect(t.db.run('DELETE FROM phase1_outside_sends')).rejects.toThrow();
    await expect(t.db.run("UPDATE phase1_outside_sends SET day = '2027-03-01'")).rejects.toThrow();
  });

  it('[R644] un envoi constaté hors d’AIMMO : un jour commencé, une application connue, une preuve', async () => {
    const t = await setup();
    t.setClock('2027-03-10T10:00:00.000Z');
    const declare = (input: unknown) => t.condition.declareOutsideSend(t.direction, input);
    expect(await declare({ day: '2027-03-11', application: 'manychat', proofRef: PROOF })).toEqual({ ok: false, rule: 'R644', code: 'bad_day' });
    expect(await declare({ day: '2027-02-29', application: 'manychat', proofRef: PROOF })).toEqual({ ok: false, rule: 'R644', code: 'bad_day' });
    expect(await declare({ day: '2027-13-01', application: 'manychat', proofRef: PROOF })).toEqual({ ok: false, rule: 'R644', code: 'bad_day' });
    expect(await declare({ day: '2027-03-10', application: 'zapier', proofRef: PROOF })).toEqual({ ok: false, rule: 'R644', code: 'bad_application' });
    expect(await declare({ day: '2027-03-10', application: 'manychat', proofRef: '../secret' })).toEqual({ ok: false, rule: 'R644', code: 'bad_proof' });
    expect(await declare({ day: '2027-03-10', application: 'manychat', proofRef: PROOF, note: 'x' })).toEqual({ ok: false, rule: null, code: 'unknown_field' });
    expect(await declare([])).toEqual({ ok: false, rule: null, code: 'bad_shape' });
    expect((await declare({ day: '2027-03-10', application: 'manychat', proofRef: PROOF })).ok).toBe(true);
    expect(await t.events('condition_phase1.refuse')).toHaveLength(7);
    // Le journal ne porte pas la preuve.
    expect(JSON.stringify(await t.events('condition_phase1.envoi_hors_aimmo'))).not.toContain('capture');
  });

  it('[R644] l’inventaire des tâches planifiées : chaque application dite, par versions qui se suivent et ne changent plus', async () => {
    const t = await setup();
    t.setClock('2027-03-10T10:00:00.000Z');
    const declare = (input: unknown) => t.condition.declareInventory(t.direction, input);
    const all = { gohighlevel: 4, manychat: 2, site: 0, github_actions: 1, autre: 0 };
    expect(await declare({ tasks: { gohighlevel: 4, manychat: 2 }, proofRef: PROOF })).toEqual({ ok: false, rule: 'R644', code: 'bad_tasks' });
    expect(await declare({ tasks: { ...all, zapier: 1 }, proofRef: PROOF })).toEqual({ ok: false, rule: 'R644', code: 'bad_tasks' });
    expect(await declare({ tasks: { ...all, site: -1 }, proofRef: PROOF })).toEqual({ ok: false, rule: 'R644', code: 'bad_tasks' });
    expect(await declare({ tasks: { ...all, site: 1.5 }, proofRef: PROOF })).toEqual({ ok: false, rule: 'R644', code: 'bad_tasks' });
    expect(await declare({ tasks: { ...all, site: 1001 }, proofRef: PROOF })).toEqual({ ok: false, rule: 'R644', code: 'bad_tasks' });
    expect(await declare({ tasks: all, proofRef: '' })).toEqual({ ok: false, rule: 'R644', code: 'bad_proof' });
    expect(await declare({ tasks: all, proofRef: PROOF })).toEqual({ ok: true, value: { version: 1, total: 7 } });
    expect(await declare({ tasks: { ...all, gohighlevel: 0 }, proofRef: PROOF })).toEqual({ ok: true, value: { version: 2, total: 3 } });
    await expect(
      t.db.run("INSERT INTO phase1_app_inventories (network_id, version, gohighlevel, manychat, site, github_actions, autre, proof_ref, declared_at) VALUES (?, 4, 0, 0, 0, 0, 0, 'abc', 'x')", [t.network.id]),
    ).rejects.toThrow();
    await expect(t.db.run('UPDATE phase1_app_inventories SET gohighlevel = 0')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM phase1_app_inventories')).rejects.toThrow();
    const rep = await t.report('2027-03-10T11:00:00.000Z');
    expect(rep.inventories.map((i) => [i.version, i.total])).toEqual([
      [1, 7],
      [2, 3],
    ]);
    expect(rep.condition.reasons).toContain('taches_planifiees');
  });

  it('[R645] 30 jours propres de suite après l’inventaire à zéro remplissent la condition ; 29 non', async () => {
    expect(phase1Condition(null, 40)).toEqual({ met: false, reasons: ['inventaire_absent'] });
    const t = await setup();
    await t.inventory('2027-03-01T10:00:00.000Z');
    await t.cleanDays('2027-03-02', PHASE1_DAYS - 1);
    let rep = await t.report('2027-03-31T10:00:00.000Z');
    expect(rep.countFrom).toBe('2027-03-02');
    expect(rep.countedSeries).toBe(29);
    expect(rep.condition).toEqual({ met: false, reasons: ['serie_trop_courte'] });
    await t.cleanDays('2027-03-31', 1);
    rep = await t.report('2027-04-01T10:00:00.000Z');
    expect(rep.countedSeries).toBe(30);
    expect(rep.condition).toEqual({ met: true, reasons: [] });
    // Le jour d'aujourd'hui n'est jamais compté : la série va jusqu'à hier.
    expect(rep.lastDay).toBe('2027-03-31');
  });

  it('[R645] seuls comptent les jours après l’inventaire à zéro ; une version non nulle ensuite remet le compte à rien', async () => {
    const t = await setup();
    await t.inventory('2027-03-01T10:00:00.000Z', { manychat: 3 });
    await t.cleanDays('2027-03-02', 20);
    // L'inventaire passe à zéro le 15 : seuls les jours à partir du 16 comptent.
    await t.inventory('2027-03-15T10:00:00.000Z');
    await t.inventory('2027-03-18T10:00:00.000Z'); // encore zéro : le compte part toujours du 16
    let rep = await t.report('2027-03-22T10:00:00.000Z');
    expect(rep.currentSeries).toBe(20);
    expect(rep.countFrom).toBe('2027-03-16');
    expect(rep.countedSeries).toBe(6);
    // Une tâche réapparaît : plus rien ne compte.
    await t.inventory('2027-03-22T11:00:00.000Z', { github_actions: 1 });
    rep = await t.report('2027-03-22T12:00:00.000Z');
    expect(rep.countFrom).toBeNull();
    expect(rep.countedSeries).toBe(0);
    expect(rep.condition.reasons).toEqual(['taches_planifiees', 'serie_trop_courte']);
  });

  it('[R645] un jour sans donnée ou hors règles casse la série', async () => {
    const t = await setup();
    await t.inventory('2027-03-01T10:00:00.000Z');
    await t.cleanDays('2027-03-02', 10);
    // Le 12 : aucun relevé. Puis 5 jours propres.
    await t.cleanDays('2027-03-13', 5);
    let rep = await t.report('2027-03-18T10:00:00.000Z');
    expect(rep.days.find((d) => d.day === '2027-03-12')?.status).toBe('sans_donnee');
    expect(rep.currentSeries).toBe(5);
    expect(rep.bestSeries).toBe(10);
    // Un message automatique sans le contrôle le 16 : la série repart du 17.
    await t.message('2027-03-16T10:00:00.000Z', { controlled: false });
    rep = await t.report('2027-03-18T10:05:00.000Z');
    expect(rep.days.find((d) => d.day === '2027-03-16')).toMatchObject({ status: 'hors_regles', recountWorse: true });
    expect(rep.currentSeries).toBe(1);
  });

  it('[R16] la direction seule range et lit ; refus et lecture au journal ; rien d’un autre réseau', async () => {
    const t = await setup();
    t.setClock('2027-03-10T10:00:00.000Z');
    for (const role of ['agent', 'compliance', 'assistant']) {
      const v = t.as(role, `${role}-1`);
      expect(await t.condition.report(v)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.condition.declareInventory(v, { tasks: { gohighlevel: 0, manychat: 0, site: 0, github_actions: 0, autre: 0 }, proofRef: PROOF })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.condition.declareOutsideSend(v, { day: '2027-03-10', application: 'site', proofRef: PROOF })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.events('acces.refuse')).filter((e) => e.rule === 'R16')).toHaveLength(9);
    expect(await t.db.all('SELECT * FROM phase1_app_inventories')).toHaveLength(0);
    // L'inventaire d'un autre réseau ne compte pas ici.
    await t.condition.declareInventory(t.as('direction', 'd-2', t.other.id), { tasks: { gohighlevel: 0, manychat: 0, site: 0, github_actions: 0, autre: 0 }, proofRef: PROOF });
    const rep = await t.report('2027-03-10T11:00:00.000Z');
    expect(rep.inventories).toHaveLength(0);
    expect(rep.condition.reasons).toContain('inventaire_absent');
    expect(await t.events('condition_phase1.lecture')).toHaveLength(1);
  });
});
