import { expect, it } from 'vitest';
import { ActeVente, Echeancier, SALE_FOLLOW_UP_PURPOSE } from '../src/dossiers/index.ts';
import {
  DEFAULT_STATEMENT_MAX_AGE_DAYS,
  RECONCILIATION_JOB,
  REMINDERS_PREPARE_JOB,
  REMINDERS_SEND_JOB,
  Rapprochements,
  RelancesImpayes,
  bankStatementFreshness,
  facturationJobs,
} from '../src/facturation/index.ts';
import { Commissions, Factures, PlateformeEssai } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : réseau, clients, factures, relevés.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000055.pdf';
const at9 = (day: string) => new Date(`${day}T07:00:00.000Z`);
const at6 = (day: string) => new Date(`${day}T04:00:00.000Z`);
const SLOT = { job: 'x', slot: 'x', at: new Date(0) };

it('[R551] [R553] trois passages nommés, aux heures dites', () => {
  const jobs = facturationJobs({} as never, {} as never, {} as never);
  expect(jobs.map((j) => j.name)).toEqual([RECONCILIATION_JOB, REMINDERS_PREPARE_JOB, REMINDERS_SEND_JOB]);
  expect(jobs[0]!.hours).toEqual(Array.from({ length: 24 }, (_, h) => h));
  expect(jobs[0]!.weekdays).toBeUndefined();
  expect(jobs[1]!.hours).toEqual([6]);
  expect(jobs[2]!.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  expect(jobs[2]!.weekdays).toEqual([1, 2, 3, 4, 5, 6]);
  expect(DEFAULT_STATEMENT_MAX_AGE_DAYS).toBe(7);
  // Un seuil hors de 1 à 31 jours est refusé dès la construction.
  for (const bad of [0, 32, 1.5]) expect(() => facturationJobs({} as never, {} as never, {} as never, { statementMaxAgeDays: bad })).toThrow();
});

describeWithSqlite('RC55 · passages du rapprochement et des relances d’impayés', () => {
  /** Une vente menée jusqu'à la facture d'honoraires validée : F-2027-00001, 10 000,00 €, émise le 11 juin 2027, échue le 11 juillet. */
  async function invoiced() {
    const t = await setupDossier('appartement');
    const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    const c = new Commissions(t.db, t.acces, t.journal, { now: t.now });
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']] as const) {
      const r = await echeancier.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
    await c.sync(t.network.id);
    const status = await t.pieces.status(t.agent, t.fileId);
    if (!status.ok) throw new Error(status.code);
    for (const piece of status.value.missing) {
      const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
      if (!r.ok) throw new Error(r.code);
    }
    t.setClock(at9('2027-06-11'));
    const acte = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    if (!acte.ok) throw new Error(acte.code);
    await c.sync(t.network.id);
    const f = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme: new PlateformeEssai() });
    await f.prepare(t.network.id);
    const drafts = await f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    const h = await f.validate(t.direction, drafts.value.find((d) => d.kind === 'honoraires')!.id);
    if (!h.ok) throw new Error('facture');
    await t.store.addIdentifier({ networkId: t.network.id, personId: t.buyerId, kind: 'email', value: 'acheteur@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: t.buyerId, purpose: SALE_FOLLOW_UP_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
    const [reconcileJob, prepareJob, sendJob] = facturationJobs(t.db, t.journal, t.acces, { now: t.now });
    const relances = new RelancesImpayes(t.db, t.journal, { now: t.now });
    const reminders = async () => {
      const l = await relances.list(t.direction);
      if (!l.ok) throw new Error('list');
      return l.value.map((r) => [r.rank, r.status, r.rule]);
    };
    const outbox = async () => (await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox'))?.n ?? 0;
    const reconciled = async () => (await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM bank_reconciliations WHERE invoice_id = ?', [h.value.id]))?.n ?? 0;
    /** Dépose un relevé au jour dit, à 9 h : une ligne sans rapport avec la facture, ou son paiement. */
    const deposit = async (day: string, line: string) => {
      t.setClock(at9(day));
      const imported = await new Rapprochements(t.db, t.acces, t.journal, { now: t.now }).importStatement(t.direction, line);
      if (!imported.ok) throw new Error('relevé');
    };
    const unrelated = (day: string) => `${day};PRLV FOURNISSEUR;-125,75\n`;
    const payment = (day: string) => `${day};VIR ETUDE F-2027-00001;10 000,00\n`;
    const waiting = async () => (await t.journal.bySubject(`network:${t.network.id}`)).filter((e) => e.type === 'facture.relances_attente');
    return { ...t, invoice: h.value, reconcileJob: reconcileJob!, prepareJob: prepareJob!, sendJob: sendJob!, relances, reminders, outbox, reconciled, deposit, unrelated, payment, waiting };
  }

  it('[R553] relevé récent, facture impayée : une relance à valider, rien ne part sans la direction', async () => {
    const t = await invoiced();
    await t.deposit('2027-07-10', t.unrelated('2027-07-10'));
    t.setClock(at6('2027-07-12'));
    await t.prepareJob.run(SLOT);
    expect(await t.reminders()).toEqual([[1, 'a_valider', null]]);
    // Le passage d'envoi ne fait rien partir d'une relance non validée.
    t.setClock(at9('2027-07-12'));
    await t.sendJob.run(SLOT);
    expect(await t.outbox()).toBe(0);
    expect(await t.waiting()).toEqual([]);
  });

  it('[R551] [R553] le paiement prouvé par le relevé du matin est rapproché avant la préparation : aucune relance', async () => {
    const t = await invoiced();
    // Le relevé déposé la veille prouve le paiement ; personne n'a lancé le rapprochement.
    await t.deposit('2027-07-11', t.payment('2027-07-11'));
    expect(await t.reconciled()).toBe(0);
    t.setClock(at6('2027-07-12'));
    await t.prepareJob.run(SLOT);
    expect(await t.reconciled()).toBe(1);
    expect(await t.reminders()).toEqual([]);
  });

  it('[R551] le passage horaire rapproche seul ce qui ne laisse qu’un choix', async () => {
    const t = await invoiced();
    await t.deposit('2027-06-20', t.payment('2027-06-20'));
    await t.reconcileJob.run(SLOT);
    expect(await t.reconciled()).toBe(1);
    // Rejouer ne rapproche rien de plus.
    await t.reconcileJob.run(SLOT);
    expect(await t.reconciled()).toBe(1);
  });

  it('[R553] [R13] relevé de plus de 7 jours, ou aucun relevé : aucune relance, l’attente dite au journal sans montant (Jamais vu)', async () => {
    const t = await invoiced();
    // Aucun relevé jamais déposé : la banque ne prouve rien, on n'écrit pas au client.
    t.setClock(at6('2027-07-12'));
    await t.prepareJob.run(SLOT);
    expect(await t.reminders()).toEqual([]);
    expect((await t.waiting()).map((e) => e.data)).toEqual([{ rule: 'R553', reason: 'aucun_releve', lastImportDay: null, maxAgeDays: 7 }]);
    // Un relevé du 4 juillet : au 11 juillet il a 7 jours, encore frais ; le 12, il en a 8.
    await t.deposit('2027-07-04', t.unrelated('2027-07-04'));
    expect(await bankStatementFreshness(t.db, t.network.id, at9('2027-07-11'))).toEqual({ lastImportDay: '2027-07-04', ageDays: 7, fresh: true, reason: 'frais', maxAgeDays: 7 });
    t.setClock(at6('2027-07-12'));
    await t.prepareJob.run(SLOT);
    expect(await t.reminders()).toEqual([]);
    const events = await t.waiting();
    expect(events.map((e) => e.data)).toEqual([
      { rule: 'R553', reason: 'aucun_releve', lastImportDay: null, maxAgeDays: 7 },
      { rule: 'R553', reason: 'releve_ancien', lastImportDay: '2027-07-04', maxAgeDays: 7 },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/1000000|10 000|F-2027/);
    // Un relevé neuf le 13 : la relance est préparée au passage suivant.
    await t.deposit('2027-07-13', t.unrelated('2027-07-13'));
    t.setClock(at6('2027-07-14'));
    await t.prepareJob.run(SLOT);
    expect(await t.reminders()).toEqual([[1, 'a_valider', null]]);
    // Un seuil réglé plus court est tenu.
    expect((await bankStatementFreshness(t.db, t.network.id, at9('2027-07-16'), 2)).fresh).toBe(false);
  });

  it('[R553] [R26] validée, la relance part en essai au passage d’envoi ; un paiement déposé avant ce passage la ferme', async () => {
    const t = await invoiced();
    await t.deposit('2027-07-10', t.unrelated('2027-07-10'));
    t.setClock(at6('2027-07-12'));
    await t.prepareJob.run(SLOT);
    const list = await t.relances.list(t.direction);
    if (!list.ok) throw new Error('list');
    expect(await t.relances.validate(t.direction, list.value[0]!.id)).toEqual({ ok: true });
    // Le paiement arrive au relevé du jour, avant le passage d'envoi : rien ne part, la relance est close.
    await t.deposit('2027-07-12', t.payment('2027-07-12'));
    t.setClock(at9('2027-07-12'));
    await t.sendJob.run(SLOT);
    expect(await t.outbox()).toBe(0);
    expect(await t.reminders()).toEqual([[1, 'close', 'rapprochee']]);

    // Une autre vente : validée, sans paiement, elle part dans la boîte d'essai seule.
    const o = await invoiced();
    await o.deposit('2027-07-10', o.unrelated('2027-07-10'));
    o.setClock(at6('2027-07-12'));
    await o.prepareJob.run(SLOT);
    const l2 = await o.relances.list(o.direction);
    if (!l2.ok) throw new Error('list');
    await o.relances.validate(o.direction, l2.value[0]!.id);
    o.setClock(at9('2027-07-12'));
    await o.sendJob.run(SLOT);
    expect(await o.outbox()).toBe(1);
    expect(await o.reminders()).toEqual([[1, 'envoyee', null]]);
  });

  it('[R553] validée, la relance attend sur un relevé devenu ancien, puis part au dépôt suivant', async () => {
    const t = await invoiced();
    await t.deposit('2027-07-10', t.unrelated('2027-07-10'));
    t.setClock(at6('2027-07-12'));
    await t.prepareJob.run(SLOT);
    const list = await t.relances.list(t.direction);
    if (!list.ok) throw new Error('list');
    await t.relances.validate(t.direction, list.value[0]!.id);
    // Le 19, le relevé du 10 a 9 jours : la relance validée attend, rien ne part.
    t.setClock(at9('2027-07-19'));
    await t.sendJob.run(SLOT);
    expect(await t.outbox()).toBe(0);
    expect(await t.reminders()).toEqual([[1, 'validee', null]]);
    await t.deposit('2027-07-19', t.unrelated('2027-07-19'));
    t.setClock(at9('2027-07-19'));
    await t.sendJob.run(SLOT);
    expect(await t.outbox()).toBe(1);
  });

  it('[R13] un réseau en panne n’empêche pas les autres ; la première erreur remonte au planificateur', async () => {
    const t = await invoiced();
    await t.deposit('2027-06-20', t.payment('2027-06-20'));
    const original = t.db.all.bind(t.db);
    // Un réseau inventé, rangé avant le vrai, dont le rapprochement tombe en panne.
    t.db.all = (async (sql: string, params?: readonly (string | number | null)[]) => {
      if (sql.includes('SELECT DISTINCT network_id FROM bank_lines')) return [{ network_id: '0000-reseau-en-panne' }, ...(await original(sql, params))];
      if (sql.includes('FROM bank_lines l JOIN invoices') && params?.[0] === '0000-reseau-en-panne') throw new Error('panne');
      return original(sql, params);
    }) as typeof t.db.all;
    await expect(t.reconcileJob.run(SLOT)).rejects.toThrow('panne');
    t.db.all = original;
    expect(await t.reconciled()).toBe(1);
  });
});
