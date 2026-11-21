import { expect, it } from 'vitest';
import { Echeancier, buyerWithdrawalLastDay, preemptionLastDay, scheduleLines } from '../src/dossiers/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

it('[R61] fin de la rétractation de l’acquéreur : 10 jours dès le lendemain, prolongée au premier jour ouvrable', () => {
  const cases: [string, string][] = [
    ['2027-03-02', '2027-03-12'], // finit un vendredi
    ['2027-03-03', '2027-03-15'], // un samedi : lundi
    ['2027-03-04', '2027-03-15'], // un dimanche : lundi
    ['2027-03-19', '2027-03-30'], // lundi de Pâques
    ['2027-04-21', '2027-05-03'], // 1er mai un samedi, puis dimanche
    ['2027-04-26', '2027-05-07'], // jeudi de l'Ascension
    ['2027-07-04', '2027-07-15'], // 14 juillet
    ['2027-12-15', '2027-12-27'], // Noël un samedi
    ['2027-12-22', '2028-01-03'], // 1er janvier un samedi, changement d'année
  ];
  for (const [notified, last] of cases) expect([notified, buyerWithdrawalLastDay(notified)]).toEqual([notified, last]);
});

it('[R61] réponse de la commune : 2 mois après la réception, au dernier jour d’un mois plus court, reportée au jour ouvrable', () => {
  expect(preemptionLastDay('2027-03-15')).toBe('2027-05-18'); // 15 mai un samedi, 17 le lundi de Pentecôte
  expect(preemptionLastDay('2027-03-11')).toBe('2027-05-11');
  expect(preemptionLastDay('2027-01-31')).toBe('2027-03-31');
  expect(preemptionLastDay('2026-12-31')).toBe('2027-03-01'); // 28 février un dimanche
  expect(preemptionLastDay('2027-12-31')).toBe('2028-02-29');
  expect(preemptionLastDay('2027-11-15')).toBe('2028-01-17'); // un samedi
  expect(preemptionLastDay('2027-08-31')).toBe('2027-11-02'); // un dimanche, puis la Toussaint
});

it('[R61] la demande de pièces ou de visite suspend le délai de la commune ; il reprend pour ce qui restait, au moins un mois', () => {
  // Suspendu : pas de date tant que les pièces ne sont pas reçues.
  expect(preemptionLastDay('2027-03-15', '2027-04-20')).toBeNull();
  // Restaient 25 jours : moins d'un mois, la commune a un mois dès la reprise.
  expect(preemptionLastDay('2027-03-15', '2027-04-20', '2027-05-03')).toBe('2027-06-03');
  // Restaient 59 jours jusqu'à la fin reportée du 18 mai : ils courent dès la reprise (30 mai, un dimanche : le 31).
  expect(preemptionLastDay('2027-03-15', '2027-03-20', '2027-04-01')).toBe('2027-05-31');
  // Une demande faite pendant le report au jour ouvrable suspend encore le délai.
  expect(preemptionLastDay('2027-03-15', '2027-05-17')).toBeNull();
  expect(scheduleLines({ dia_recue: '2027-03-15', dia_suspension: '2027-05-17' }, { hasLoanCondition: true, isCoownershipLot: true }).find((l) => l.deadline === 'reponse_preemption')?.status).toBe('suspendue');
  // Une demande après la fin du délai ne le rouvre pas.
  expect(preemptionLastDay('2027-03-15', '2027-05-20', '2027-05-25')).toBe('2027-05-18');
  const facts = { hasLoanCondition: true, isCoownershipLot: true };
  expect(scheduleLines({ dia_recue: '2027-03-15', dia_suspension: '2027-04-20' }, facts).find((l) => l.deadline === 'reponse_preemption')).toEqual({ deadline: 'reponse_preemption', source: 'calcul', from: 'dia_suspension', day: null, status: 'suspendue', calendar: 'national' });
  expect(scheduleLines({ dia_recue: '2027-03-15', dia_suspension: '2027-04-20', dia_reprise: '2027-05-03' }, facts).find((l) => l.deadline === 'reponse_preemption')).toEqual({ deadline: 'reponse_preemption', source: 'calcul', from: 'dia_reprise', day: '2027-06-03', status: 'datee', calendar: 'national' });
});

it('[R10] [R61] aucune échéance sans sa date : à saisir, ou sans objet, jamais inventée', () => {
  const facts = { hasLoanCondition: true, isCoownershipLot: true };
  expect(scheduleLines({}, facts).map((l) => [l.deadline, l.status, l.day])).toEqual([
    ['fin_retractation', 'a_saisir', null], ['reponse_preemption', 'a_saisir', null], ['date_limite_pret', 'a_saisir', null], ['etat_date', 'a_saisir', null], ['acte', 'a_saisir', null],
  ]);
  const dated = scheduleLines({ compromis_signe: '2027-03-10', notification_acquereur: '2027-03-11', date_limite_pret: '2027-05-10', dia_recue: '2027-03-15', etat_date_attendu: '2027-05-20', acte_prevu: '2027-06-10' }, facts);
  expect(dated.map((l) => [l.deadline, l.source, l.day])).toEqual([
    ['fin_retractation', 'calcul', '2027-03-22'], ['reponse_preemption', 'calcul', '2027-05-18'], ['date_limite_pret', 'saisie', '2027-05-10'], ['etat_date', 'saisie', '2027-05-20'], ['acte', 'saisie', '2027-06-10'],
  ]);
  expect(scheduleLines({}, { hasLoanCondition: false, isCoownershipLot: false }).filter((l) => l.status === 'sans_objet').map((l) => l.deadline)).toEqual(['date_limite_pret', 'etat_date']);
  // Copropriété inconnue : l'état daté reste demandé.
  expect(scheduleLines({}, { hasLoanCondition: true, isCoownershipLot: null }).find((l) => l.deadline === 'etat_date')?.status).toBe('a_saisir');
});

describeWithSqlite('N02 · échéancier du dossier et alertes à l’agent', () => {
  const PARIS_9H = (day: string) => new Date(`${day}T08:00:00.000Z`);

  it('[R61] chaque dossier en cours a ses échéances et ses alertes, une seule par échéance, à l’heure de Paris', async () => {
    const t = await setupDossier();
    await t.startCompromis();
    t.setClock(PARIS_9H('2027-03-10'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF })).toMatchObject({ ok: true });
    // Le soir même : chaque échéance est encore à saisir, une tâche par échéance, une seule.
    expect(await e.run(t.network.id)).toBe(5);
    expect(await e.run(t.network.id)).toBe(0);
    let tasks = await e.tasksOf(t.agent);
    expect(tasks.ok && tasks.tasks.map((k) => `${k.deadline}:${k.kind}`)).toEqual(['fin_retractation:a_saisir', 'reponse_preemption:a_saisir', 'date_limite_pret:a_saisir', 'etat_date:a_saisir', 'acte:a_saisir']);
    t.setClock(PARIS_9H('2027-03-11'));
    for (const [kind, day] of [['notification_acquereur', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['dia_recue', '2027-03-11'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']]) {
      expect(await e.record(t.agent, t.fileId, { kind, day, proofRef: PROOF })).toMatchObject({ ok: true });
    }
    // Les dates saisies : plus rien à saisir.
    tasks = await e.tasksOf(t.agent);
    expect(tasks.ok && tasks.tasks).toEqual([]);
    // Jour après jour, sur horloge simulée : chaque échéance a sa tâche, le bon jour, une seule fois.
    for (let day = '2027-03-11'; day <= '2027-06-12'; day = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      // 23 h 30 à Paris, en heure d'hiver comme d'été : le jour de Paris compte, pas celui d'UTC.
      t.setClock(new Date(`${day}T${day < '2027-03-28' ? '22' : '21'}:30:00.000Z`));
      await e.run(t.network.id);
      await e.run(t.network.id);
    }
    const rows = await t.db.all<{ deadline: string; due_day: string; created_at: string }>("SELECT deadline, due_day, created_at FROM sale_file_tasks WHERE due_day <> '' ORDER BY created_at");
    // La tâche naît le nombre de jours réglé avant l'échéance, au jour de Paris.
    expect(rows.map((r) => [r.deadline, r.due_day, r.created_at.slice(0, 10)])).toEqual([
      ['fin_retractation', '2027-03-22', '2027-03-21'],
      ['date_limite_pret', '2027-05-10', '2027-04-30'],
      ['reponse_preemption', '2027-05-11', '2027-05-04'],
      ['etat_date', '2027-05-20', '2027-05-13'],
      ['acte', '2027-06-10', '2027-06-03'],
    ]);
    // Une échéance passée n'est plus une tâche.
    t.setClock(PARIS_9H('2027-06-11'));
    expect((await e.tasksOf(t.agent)).ok && ((await e.tasksOf(t.agent)) as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it('[R61] une date corrigée s’ajoute en nouvelle version et déplace l’échéance ; l’ancienne tâche ne compte plus', async () => {
    const t = await setupDossier();
    await t.startCompromis();
    t.setClock(PARIS_9H('2027-03-10'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    await e.record(t.agent, t.fileId, { kind: 'acte_prevu', day: '2027-03-15', proofRef: PROOF });
    await e.run(t.network.id);
    let k = await e.tasksOf(t.agent);
    expect(k.ok && k.tasks.filter((x) => x.deadline === 'acte')).toMatchObject([{ kind: 'avant_echeance', day: '2027-03-15' }]);
    const moved = await e.record(t.agent, t.fileId, { kind: 'acte_prevu', day: '2027-06-30', proofRef: PROOF });
    expect(moved.ok && moved.value.dates.acte_prevu).toEqual({ day: '2027-06-30', version: 2 });
    k = await e.tasksOf(t.agent);
    expect(k.ok && k.tasks.filter((x) => x.deadline === 'acte')).toEqual([]);
    expect((await t.db.all("SELECT day FROM sale_file_dates WHERE kind = 'acte_prevu' ORDER BY version")).length).toBe(2);
    await expect(t.db.run('DELETE FROM sale_file_dates')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE sale_file_tasks SET due_day = ''")).rejects.toThrow(/rien ne change/);
  });

  it('[R58] [R10] rien sans compromis en préparation ; des dates réelles, prouvées, dans l’ordre', async () => {
    const t = await setupDossier('maison');
    t.setClock(PARIS_9H('2027-03-10'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF })).toEqual({ ok: false, rule: 'R58', code: 'compromis_not_started' });
    await t.startCompromis();
    expect(await e.record(t.agent, t.fileId, { kind: 'acte_prevu', day: '2027-06-10', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'compromis_first' });
    expect(await e.record(t.agent, t.fileId, { kind: 'signature', day: '2027-03-10', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'unknown_date' });
    for (const day of ['2027-02-30', '10/03/2027', 20270310, null]) expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day, proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'bad_day' });
    for (const proofRef of ['scan.pdf', '', null]) expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef })).toEqual({ ok: false, rule: null, code: 'bad_proof' });
    expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-11', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'future_day' });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-09', proofRef: PROOF });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-08', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'before_compromis' });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-12', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'future_day' });
    // La suspension suppose la déclaration reçue, la reprise la suspension, dans cet ordre.
    expect(await e.record(t.agent, t.fileId, { kind: 'dia_suspension', day: '2027-03-10', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'out_of_order' });
    await e.record(t.agent, t.fileId, { kind: 'dia_recue', day: '2027-03-10', proofRef: PROOF });
    expect(await e.record(t.agent, t.fileId, { kind: 'dia_reprise', day: '2027-03-10', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'out_of_order' });
    expect(await e.record(t.agent, t.fileId, { kind: 'dia_suspension', day: '2027-03-10', proofRef: PROOF })).toMatchObject({ ok: true });
    await e.record(t.agent, t.fileId, { kind: 'dia_reprise', day: '2027-03-10', proofRef: PROOF });
    // Corriger une date qui en précède d'autres ne peut pas défaire l'ordre de celles déjà saisies.
    t.setClock(PARIS_9H('2027-03-12'));
    expect(await e.record(t.agent, t.fileId, { kind: 'dia_suspension', day: '2027-03-11', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'out_of_order' });
    expect(await e.record(t.agent, t.fileId, { kind: 'dia_recue', day: '2027-03-11', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'out_of_order' });
    t.setClock(PARIS_9H('2027-03-10'));
    // Une date à venir, lue dans le compromis, peut être dans le futur.
    expect(await e.record(t.agent, t.fileId, { kind: 'acte_prevu', day: '2027-06-10', proofRef: PROOF })).toMatchObject({ ok: true });
    // Corriger la signature après l'acte prévu : refusé.
    expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-06-11', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'future_day' });
    t.setClock(PARIS_9H('2027-06-20'));
    expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-06-11', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'before_compromis' });
    // Une maison hors copropriété : pas d'état daté.
    const s = await e.schedule(t.agent, t.fileId);
    expect(s.ok && s.value.lines.find((l) => l.deadline === 'etat_date')?.status).toBe('sans_objet');
  });

  it('[R16] seul l’agent du dossier saisit ; direction et conformité lisent ; les tâches sont à l’agent seul', async () => {
    const t = await setupDossier();
    await t.startCompromis();
    t.setClock(PARIS_9H('2027-03-10'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    const compliance = { role: 'compliance' as const, networkId: t.network.id, userId: 'c-1' };
    for (const v of [t.direction, compliance]) {
      expect(await e.record(v, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await e.schedule(v, t.fileId)).toMatchObject({ ok: true });
    }
    expect(await e.schedule(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await e.record(t.sam, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await e.schedule(t.agent, 'dossier-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    await e.run(t.network.id);
    expect(await e.tasksOf(t.direction)).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    expect(await e.tasksOf(t.sam)).toEqual({ ok: true, tasks: [] });
    // Le bien confié à un autre agent : les tâches de l'ancien ne lui sont plus montrées.
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.userId, t.propertyId]);
    expect(await e.tasksOf(t.agent)).toEqual({ ok: true, tasks: [] });
    // Le nouvel agent reçoit les tâches au passage suivant, une seule fois.
    expect(await e.run(t.network.id)).toBe(5);
    expect(await e.run(t.network.id)).toBe(0);
    const samTasks = await e.tasksOf(t.sam);
    expect(samTasks.ok && samTasks.tasks.map((x) => x.kind)).toEqual(['a_saisir', 'a_saisir', 'a_saisir', 'a_saisir', 'a_saisir']);
    // Chaque lecture des tâches est au journal [R16].
    expect((await t.journal.bySubject(`agent:${t.sam.userId}`)).filter((x) => x.type === 'dossier.taches_lues').at(-1)?.data).toEqual({ rule: 'R16', files: [`sale_file:${t.fileId}`] });
    const refusals = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((x) => x.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(4);
    // Le journal porte le type de date, jamais la date ni la preuve.
    expect(JSON.stringify(await t.journal.bySubject(`sale_file:${t.fileId}`))).not.toContain('preuves/');
  });
});
