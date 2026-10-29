import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { CessionCommerce, FicheCommerce, VigilanceCession, type VaultDeposits } from '../src/commerces/index.ts';
import { FUNDS_REQUEST_TEXT } from '../src/conformite/vigilance.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const proof = (n: number): string => `preuves/00000000-0000-4000-8000-${String(n).padStart(12, '0')}.pdf`;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-09-07T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { store, fiche } = createCaptation(db, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const fiches = new FicheCommerce(db, journal, { now });
  const cessions = new CessionCommerce(db, journal, fiches, { now });
  const deposited = new Set<string>();
  const vault: VaultDeposits = { everDeposited: async (_n, personId, kinds) => kinds.some((k) => deposited.has(`${personId}:${k}`)) };
  const vigilance = new VigilanceCession(db, journal, vault, { now });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  const alex = as('agent', alexAgent.id);
  const direction = as('direction', 'dir-1');
  await cessions.recordCommune(direction, { postalCode: '21000', city: 'Dijon', inPerimeter: false, source: 'Liste inventée des périmètres', sourceDate: '2026-06-30' });
  let seq = 0;
  let n = 0;
  /** Un fonds sans salarié ni licence, dont toutes les étapes avant la cession sont faites. */
  const readyFile = async () => {
    const p = await store.createProperty({ networkId: network.id, agentId: alexAgent.id, reference: `CE-${(seq += 1)}`, kind: 'business', status: 'available', city: 'Dijon', postalCode: '21000' });
    await fiches.update(acces, alex, p.id, { activity: 'restaurant', employees: 0 });
    const f = await cessions.open(acces, alex, p.id);
    if (!f.ok) throw new Error('ouverture');
    await cessions.record(acces, alex, f.value.fileId, { kind: 'cession_prevue', day: '2027-12-01', proofRef: proof((n += 1)) });
    await cessions.setEscrow(acces, alex, f.value.fileId, { kind: 'notaire', name: 'Office notarial inventé' });
    return f.value.fileId;
  };
  const buyer = async (first: string) => (await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: first, lastName: 'Inventé' })).id;
  return { db, journal, acces, cessions, vigilance, deposited, alex, sam: as('agent', 'sam'), direction, compliance: as('compliance', 'conf-1'), readyFile, buyer, networkId: network.id, record: (fileId: string, kind: string, day: string) => cessions.record(acces, alex, fileId, { kind, day, proofRef: proof((n += 1)) }) };
}

describeWithSqlite('CE08 · vigilance renforcée de la cession', () => {
  it('[R118] [R14] sans bénéficiaires effectifs ni origine des fonds, une alerte au responsable, une seule ; elle ne bloque rien', async () => {
    const t = await setup();
    const fileId = await t.readyFile();
    const company = await t.buyer('Société');
    expect(await t.vigilance.setBuyer(t.acces, t.alex, fileId, { personId: company, legalPerson: true })).toMatchObject({ ok: true, value: { version: 1 } });
    const list = await t.vigilance.list(t.compliance);
    expect(list.ok && list.value.map((a) => [a.fileId, a.missing])).toEqual([[fileId, ['beneficiaires_effectifs', 'origine_des_fonds']]]);
    // Une seule : ni un nouvel examen, ni la tâche quotidienne, ni une nouvelle version de l'acquéreur n'en ajoutent.
    expect(await t.vigilance.examine(t.networkId, fileId)).toBe(false);
    expect(await t.vigilance.run(t.networkId)).toBe(0);
    await t.vigilance.setBuyer(t.acces, t.alex, fileId, { personId: company, legalPerson: true });
    const again = await t.vigilance.list(t.compliance);
    expect(again.ok && again.value).toHaveLength(1);
    // L'alerte ne bloque rien : la cession se déclare prête.
    expect(await t.cessions.declareReady(t.acces, t.alex, fileId)).toMatchObject({ ok: true, value: { ready: true } });
  });

  it('[R118] ce qui manque est lu au coffre : personne physique, pièces déposées, cession signée', async () => {
    const t = await setup();
    const natural = await t.readyFile();
    const p = await t.buyer('Camille');
    await t.vigilance.setBuyer(t.acces, t.alex, natural, { personId: p, legalPerson: false });
    const covered = await t.readyFile();
    const q = await t.buyer('Dominique');
    t.deposited.add(`${q}:origine_fonds`);
    await t.vigilance.setBuyer(t.acces, t.alex, covered, { personId: q, legalPerson: false });
    const company = await t.readyFile();
    const r = await t.buyer('Société');
    t.deposited.add(`${r}:registre_beneficiaires`);
    t.deposited.add(`${r}:origine_fonds`);
    await t.vigilance.setBuyer(t.acces, t.alex, company, { personId: r, legalPerson: true });
    const signed = await t.readyFile();
    await t.record(signed, 'cession_signee', '2027-09-01');
    await t.vigilance.setBuyer(t.acces, t.alex, signed, { personId: await t.buyer('Eden'), legalPerson: true });
    const list = await t.vigilance.list(t.compliance);
    expect(list.ok && list.value.map((a) => [a.fileId, a.missing])).toEqual([[natural, ['origine_des_fonds']]]);
  });

  it('[R14] seul le responsable voit et décide ; l’agent ne reçoit que la demande neutre, s’il l’a décidée', async () => {
    const t = await setup();
    const fileId = await t.readyFile();
    await t.vigilance.setBuyer(t.acces, t.alex, fileId, { personId: await t.buyer('Camille'), legalPerson: false });
    expect(await t.vigilance.list(t.alex)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.vigilance.list(t.direction)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.vigilance.fundsRequest(t.acces, t.alex, fileId)).toEqual({ ok: true, value: null });
    const list = await t.vigilance.list(t.compliance);
    const alertId = list.ok ? list.value[0]!.id : '';
    expect(await t.vigilance.decide(t.alex, alertId, { decision: 'classee', reason: 'x', validatorName: 'y' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.vigilance.decide(t.compliance, alertId, { decision: 'origine_des_fonds_demandee', reason: '', validatorName: 'Responsable Inventé' })).toMatchObject({ ok: false, code: 'missing_reason' });
    expect(await t.vigilance.decide(t.compliance, alertId, { decision: 'origine_des_fonds_demandee', reason: 'Apport important déclaré sans justificatif.', validatorName: 'Responsable Inventé' })).toMatchObject({
      ok: true,
      value: { decision: { decision: 'origine_des_fonds_demandee', validatorName: 'Responsable Inventé' } },
    });
    expect(await t.vigilance.decide(t.compliance, alertId, { decision: 'classee', reason: 'r', validatorName: 'n' })).toMatchObject({ ok: false, code: 'already_decided' });
    const request = await t.vigilance.fundsRequest(t.acces, t.alex, fileId);
    expect(request).toEqual({ ok: true, value: expect.objectContaining({ text: FUNDS_REQUEST_TEXT, sent: false }) });
    // La demande ne dit ni l'alerte, ni sa raison, ni ce qui manque.
    expect(JSON.stringify(request)).not.toMatch(/alerte|origine_des_fonds|Apport important|vigilance/i);
    expect(await t.vigilance.fundsRequest(t.acces, t.sam, fileId)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R15] [R13] aucune pièce ni donnée de fonds lue ou rangée ; l’alerte est au journal sous sa propre référence', async () => {
    const t = await setup();
    const fileId = await t.readyFile();
    await t.vigilance.setBuyer(t.acces, t.alex, fileId, { personId: await t.buyer('Camille'), legalPerson: true });
    const events = (await t.journal.all()).filter((e) => e.type === 'commerces.cession.vigilance');
    expect(events).toHaveLength(1);
    expect(events[0]!.subject).toMatch(/^business_vigilance:/);
    expect(JSON.stringify(events)).not.toMatch(/Camille|property:|person:/);
    const source = readFileSync(new URL('../src/commerces/vigilance-cession.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/compliance_vault_pieces|storage_ref|fetch\(|amount|montant_eur|_eur\b/);
    for (const table of ['business_transfer_buyers', 'business_transfer_vigilance', 'business_transfer_vigilance_decisions']) {
      const cols = await t.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
      for (const c of cols) expect(c.name, `${table}.${c.name}`).not.toMatch(/amount|eur|iban|piece|storage|sha256/);
    }
    await expect(t.db.run('DELETE FROM business_transfer_vigilance')).rejects.toThrow(/rien ne s'efface/);
  });
});
