import { expect, it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { Commissions, Encaissements, Factures, PlateformeEssai, payoutDueAt } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : vente, agents, preuves.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

it('[R70] 24 h ouvrées, sur un jeu de cas écrits : semaine, vendredi soir, week-end, veille de férié, changement d’heure', () => {
  const cases: [string, string, string][] = [
    ['mardi 10 h', '2027-06-15T08:00:00.000Z', '2027-06-16T08:00:00.000Z'],
    ['vendredi 18 h', '2027-06-18T16:00:00.000Z', '2027-06-21T16:00:00.000Z'],
    ['samedi 11 h', '2027-06-19T09:00:00.000Z', '2027-06-21T22:00:00.000Z'],
    ['veille du 14 juillet, 15 h', '2027-07-13T13:00:00.000Z', '2027-07-15T13:00:00.000Z'],
    ['veille de l’Ascension, 9 h', '2027-05-05T07:00:00.000Z', '2027-05-07T07:00:00.000Z'],
    ['vendredi avant le passage à l’heure d’été et le lundi de Pâques, midi', '2027-03-26T11:00:00.000Z', '2027-03-30T10:00:00.000Z'],
    ['vendredi avant le passage à l’heure d’hiver et la Toussaint, midi', '2027-10-29T10:00:00.000Z', '2027-11-02T11:00:00.000Z'],
    ['minuit pile un lundi', '2027-06-20T22:00:00.000Z', '2027-06-21T22:00:00.000Z'],
  ];
  for (const [name, from, due] of cases) expect([name, payoutDueAt(new Date(from)).toISOString()]).toEqual([name, due]);
});

async function setup() {
  const t = await setupDossier('appartement');
  const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
  const commissions = (options: ConstructorParameters<typeof Commissions>[3] = {}) => new Commissions(t.db, t.acces, t.journal, { now: t.now, ...options });
  const compromis = async () => {
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']] as const) {
      const r = await echeancier.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const acte = async () => {
    const status = await t.pieces.status(t.agent, t.fileId);
    if (!status.ok) throw new Error(status.code);
    for (const piece of status.value.missing) {
      const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
      if (!r.ok) throw new Error(r.code);
    }
    t.setClock(at9('2027-06-11'));
    const r = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    if (!r.ok) throw new Error(r.code);
  };
  return { ...t, commissions, compromis, acte };
}


/** Une vente menée jusqu'à la commission due. */
async function due() {
  const t = await setup();
  const c = t.commissions();
  await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
  await t.compromis();
  await c.sync(t.network.id);
  await t.acte();
  await c.sync(t.network.id);
  const plateforme = new PlateformeEssai();
  const f = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme });
  return { ...t, c, f, plateforme };
}



describeWithSqlite('K03 · encaissement et reversement sous 24 h ouvrées', () => {
  async function invoiced() {
    const t = await due();
    await t.f.prepare(t.network.id);
    const drafts = await t.f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    await t.f.validate(t.direction, drafts.value[0]!.id);
    const e = new Encaissements(t.db, t.acces, t.journal, { now: t.now });
    return { ...t, e };
  }

  it('[R67] un versement rangé sans son étape (coupure) : le passage la reprend, et la lecture dit encaissement et versement', async () => {
    const t = await invoiced();
    t.setClock(new Date('2027-06-18T16:30:00.000Z'));
    await t.e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-18T16:00:00.000Z', proofRef: 'releves/essai-1' });
    const before = await t.c.list(t.direction);
    expect(before.ok && before.value[0]!.payment).toEqual({ receivedAt: '2027-06-18T16:00:00.000Z', payoutDueAt: '2027-06-21T16:00:00.000Z', paidAt: null, late: null });
    await t.db.run('INSERT INTO commission_payouts (file_id, network_id, paid_at, proof_ref, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [t.fileId, t.network.id, '2027-06-18T16:20:00.000Z', 'virements/essai-1', 'direction:d-1', '2027-06-18T16:20:00.000Z']);
    const cut = await t.c.list(t.direction);
    expect(cut.ok && cut.value[0]!.status).toBe('facturee');
    expect(cut.ok && cut.value[0]!.payment).toMatchObject({ paidAt: '2027-06-18T16:20:00.000Z', late: false });
    await t.e.run(t.network.id);
    await t.e.run(t.network.id);
    const after = await t.c.list(t.direction);
    expect(after.ok && after.value[0]!.status).toBe('payee');
  });

  it('[R68] [R70] l’agent de la vente lit l’heure limite de son versement, un autre agent rien de ce dossier', async () => {
    const t = await invoiced();
    t.setClock(new Date('2027-06-18T16:30:00.000Z'));
    await t.e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-18T16:00:00.000Z', proofRef: 'releves/essai-1' });
    const own = await t.c.list(t.agent);
    expect(own.ok && own.value[0]!.payment).toMatchObject({ payoutDueAt: '2027-06-21T16:00:00.000Z', paidAt: null });
    expect(own.ok && own.value[0]!.shares.map((s) => s.kind)).toEqual(['agent']);
    const other = await t.c.list(t.sam);
    expect(other.ok && other.value).toEqual([]);
  });

  it('[R71] une vente annulée par un avoir : ni encaissement ni nouveau versement', async () => {
    const t = await invoiced();
    t.setClock(new Date('2027-06-18T16:30:00.000Z'));
    await t.e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-18T16:00:00.000Z', proofRef: 'releves/essai-1' });
    const invoices = await t.f.list(t.direction);
    if (!invoices.ok) throw new Error('factures');
    expect((await t.f.credit(t.direction, invoices.value[0]!.id, 'vente_annulee')).ok).toBe(true);
    expect(await t.e.recordPayout(t.direction, t.fileId, { paidAt: '2027-06-18T16:20:00.000Z', proofRef: 'virements/essai-1' })).toMatchObject({ rule: 'R71', code: 'sale_cancelled' });
    const list = await t.c.list(t.direction);
    expect(list.ok && list.value[0]!.cancelled).toBe(true);
  });

  it('[R71] une vente annulée avant l’encaissement : l’encaissement est refusé', async () => {
    const t = await invoiced();
    const invoices = await t.f.list(t.direction);
    if (!invoices.ok) throw new Error('factures');
    await t.f.credit(t.direction, invoices.value[0]!.id, 'vente_annulee');
    t.setClock(new Date('2027-06-18T16:30:00.000Z'));
    expect(await t.e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-18T16:00:00.000Z', proofRef: 'releves/essai-1' })).toMatchObject({ rule: 'R71', code: 'sale_cancelled' });
  });

  it('[R70, R67] encaissement rapporté avec sa preuve, alertes une fois avant et après l’échéance, versement : la commission est payée', async () => {
    const t = await invoiced();
    t.setClock(new Date('2027-06-18T16:30:00.000Z'));
    expect(await t.e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-19T16:00:00.000Z', proofRef: 'releves/essai-1' })).toMatchObject({ code: 'future_time' });
    expect(await t.e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-18T16:00:00.000Z', proofRef: 'mauvaise preuve' })).toMatchObject({ code: 'bad_proof' });
    expect(await t.e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-18T16:00:00.000Z', proofRef: 'releves/essai-1' })).toEqual({ ok: true, payoutDueAt: '2027-06-21T16:00:00.000Z' });
    expect(await t.e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-18T16:00:00.000Z', proofRef: 'releves/essai-1' })).toMatchObject({ code: 'already' });
    // Samedi : rien ; lundi 15 h, il reste moins de 4 h : une alerte ; rejoué, rien de plus.
    t.setClock(new Date('2027-06-19T10:00:00.000Z'));
    expect(await t.e.run(t.network.id)).toBe(0);
    t.setClock(new Date('2027-06-21T13:00:00.000Z'));
    expect(await t.e.run(t.network.id)).toBe(1);
    expect(await t.e.run(t.network.id)).toBe(0);
    t.setClock(new Date('2027-06-21T17:00:00.000Z'));
    expect(await t.e.run(t.network.id)).toBe(1);
    const tasks = await t.e.tasks(t.direction);
    expect(tasks.ok && tasks.value).toEqual([{ fileId: t.fileId, receivedAt: '2027-06-18T16:00:00.000Z', payoutDueAt: '2027-06-21T16:00:00.000Z', alerts: ['avant_echeance', 'echeance_depassee'] }]);
    expect(await t.e.recordPayout(t.direction, t.fileId, { paidAt: '2027-06-18T15:00:00.000Z', proofRef: 'virements/essai-1' })).toMatchObject({ code: 'before_receipt' });
    expect(await t.e.recordPayout(t.direction, t.fileId, { paidAt: '2027-06-21T16:30:00.000Z', proofRef: 'virements/essai-1' })).toEqual({ ok: true, late: true });
    expect(await t.e.recordPayout(t.direction, t.fileId, { paidAt: '2027-06-21T16:30:00.000Z', proofRef: 'virements/essai-1' })).toMatchObject({ code: 'already' });
    const list = await t.c.list(t.direction);
    expect(list.ok && list.value[0]!.status).toBe('payee');
    const after = await t.e.tasks(t.direction);
    expect(after.ok && after.value).toEqual([]);
    t.setClock(new Date('2027-06-22T17:00:00.000Z'));
    expect(await t.e.run(t.network.id)).toBe(0);
    // Au journal : jamais un montant [R13] ; aucun fonds suivi, seulement des faits et leurs preuves [R62].
    expect(JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('commission.')))).not.toMatch(/1000000|700000/);
  });

  it('[R67, R16] pas d’encaissement avant la facture ; la direction seule rapporte et lit ; refus au journal', async () => {
    const t = await due();
    const e = new Encaissements(t.db, t.acces, t.journal, { now: t.now });
    expect(await e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-11T07:00:00.000Z', proofRef: 'releves/essai-1' })).toEqual({ ok: false, rule: 'R67', code: 'not_invoiced' });
    expect(await e.recordPayout(t.direction, t.fileId, { paidAt: '2027-06-11T07:00:00.000Z', proofRef: 'virements/essai-1' })).toMatchObject({ code: 'not_received' });
    const before = (await t.journal.all()).filter((x) => x.type === 'acces.refuse').length;
    expect(await e.recordReceipt(t.agent, t.fileId, { receivedAt: '2027-06-11T07:00:00.000Z', proofRef: 'releves/essai-1' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await e.tasks({ role: 'compliance', networkId: t.network.id, userId: 'c-1' })).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.journal.all()).filter((x) => x.type === 'acces.refuse').length - before).toBe(2);
    expect(await e.recordReceipt({ ...t.direction, networkId: 'autre' }, t.fileId, { receivedAt: '2027-06-11T07:00:00.000Z', proofRef: 'releves/essai-1' })).toMatchObject({ code: 'unknown' });
  });
});
