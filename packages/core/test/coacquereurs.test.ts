// AU009 · Une offre et son dossier portent plusieurs acquéreurs, chacun avec son identité, sa notification et son délai.
// Personnes, biens et dates inventés.
import { expect, it } from 'vitest';
import { DossiersVente } from '../src/offres/dossier-vente.ts';
import { FicheUnique } from '../src/index.ts';
import { caseScopeOf } from '../src/conformite/dossier-fige.ts';
import { assembleAccessDetail } from '../src/conformite/demandes-personnes.ts';
import { ActeVente, ArretDossier } from '../src/dossiers/index.ts';
import { conformite } from '../src/index.ts';
import { hashOffer } from '../src/offres/registre-offres.ts';
import { Echeancier, buyerWithdrawalLastDay, scheduleLines } from '../src/dossiers/index.ts';
import { PROOF, setupDossier, lieuConnu } from './dossiers-jeu.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const FACTS = { hasLoanCondition: true, isCoownershipLot: true };

it('[R61] AU009 : la rétractation du dossier finit au délai le plus tardif des acquéreurs, à saisir tant qu’un seul manque', () => {
  const lead = { compromis_signe: '2027-03-10', notification_acquereur: '2027-03-11' };
  // Sans coacquéreur : rien ne change.
  expect(scheduleLines(lead, FACTS)[0]).toMatchObject({ deadline: 'fin_retractation', status: 'datee', day: '2027-03-22' });
  // Un coacquéreur pas encore notifié : rien n'est daté, jamais le délai du seul acquéreur en tête.
  expect(scheduleLines(lead, FACTS, [null])[0]).toMatchObject({ deadline: 'fin_retractation', status: 'a_saisir', day: null });
  // Notifié plus tard : son délai, plus tardif, l'emporte.
  expect(scheduleLines(lead, FACTS, ['2027-03-15'])[0]).toMatchObject({ status: 'datee', day: buyerWithdrawalLastDay('2027-03-15') });
  expect(buyerWithdrawalLastDay('2027-03-15')).toBe('2027-03-25');
  // Notifié avant l'acquéreur en tête : le délai de l'acquéreur en tête reste le dernier.
  expect(scheduleLines(lead, FACTS, ['2027-03-10'])[0]).toMatchObject({ day: '2027-03-22' });
});

it('[R56] AU009 : une offre d’un acquéreur seul garde son empreinte ; les coacquéreurs entrent dans l’empreinte', async () => {
  const row = {
    id: 'o1', network_id: 'n1', property_id: 'b1', seq: 1, buyer_person_id: 'p1', amount_eur: 1, conditions: '[]', valid_until: '2027-03-10',
    down_payment_eur: 1, loan_eur: 0, signed_ref: 'offres/x.pdf', received_at: 'r', agent_id: 'a1', at: 'at', actor: 'agent:a1', prev_hash: '0',
  };
  const before = await hashOffer(row);
  expect(await hashOffer({ ...row, co_buyers: '[]' })).toBe(before);
  const two = await hashOffer({ ...row, co_buyers: '["p2"]' });
  expect(two).not.toBe(before);
  expect(await hashOffer({ ...row, co_buyers: '["p3"]' })).not.toBe(two);
});

describeWithSqlite('AU009 · coacquéreurs d’une offre et de son dossier', () => {
  it('[R56] l’offre garde chaque coacquéreur sous sa propre fiche, dans le registre intact', async () => {
    const t = await setupOffre();
    const co = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Coacheteur', lastName: 'Exemple' });
    const offer = await t.record({ coBuyerPersonIds: [co.id] });
    expect(offer).toMatchObject({ buyerPersonId: t.buyerId, coBuyerPersonIds: [co.id] });
    const listed = await t.offres.list(t.agent, t.propertyId);
    expect(listed.ok && listed.value[0]!.coBuyerPersonIds).toEqual([co.id]);
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 1 });
    // Un rejeu avec la même clé rend la même offre ; avec un autre coacquéreur, c'est une autre offre : refusé.
    const keyed = t.input({ coBuyerPersonIds: [co.id], requestKey: 'cle-coacquereurs-0001', signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000003.pdf' });
    const once = await t.offres.record(t.agent, t.propertyId, keyed);
    expect(await t.offres.record(t.agent, t.propertyId, keyed)).toEqual(once);
    expect(await t.offres.record(t.agent, t.propertyId, { ...keyed, coBuyerPersonIds: [] })).toMatchObject({ ok: false, code: 'request_key_reused' });
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 2 });
    // Deux fiches distinctes : rien n'a été fusionné.
    expect(await t.db.first('SELECT 1 FROM person_merges')).toBeNull();
    // Une offre sans coacquéreur reste comme avant.
    const solo = await t.offres.record(t.agent, t.propertyId, t.input({ signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000002.pdf' }));
    expect(solo.ok && solo.value.coBuyerPersonIds).toEqual([]);
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 3 });
    expect(await t.db.all('SELECT position FROM offer_co_buyers WHERE person_id = ? ORDER BY offer_id', [co.id])).toHaveLength(2);
  });

  it('[R56] un coacquéreur qui est déjà l’acquéreur, le mandant, ou une liste trop longue : refusé, rien au registre', async () => {
    const t = await setupOffre();
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ coBuyerPersonIds: [t.buyerId] }))).toMatchObject({ ok: false, code: 'same_buyer', field: 'coBuyerPersonIds.0' });
    const seller = await t.db.first<{ person_id: string }>('SELECT person_id FROM mandates WHERE property_id = ? LIMIT 1', [t.propertyId]);
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ coBuyerPersonIds: [seller!.person_id] }))).toMatchObject({ ok: false, code: 'buyer_is_seller', field: 'coBuyerPersonIds.0' });
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ coBuyerPersonIds: ['a', 'b', 'c', 'd'] }))).toMatchObject({ ok: false, code: 'invalid', field: 'coBuyerPersonIds' });
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ coBuyerPersonIds: 'p2' }))).toMatchObject({ ok: false, code: 'invalid', field: 'coBuyerPersonIds' });
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ coBuyerPersonIds: ['inconnu'] }))).toMatchObject({ ok: false, code: 'unknown_buyer' });
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 0 });
  });

  it('[R58] le compromis attend l’identité vérifiée de chaque coacquéreur, nommé dans le refus', async () => {
    const t = await setupDossier('appartement', {}, { coBuyers: 1 });
    const dossiers = new DossiersVente(t.db, t.acces, t.journal, { now: t.now });
    await t.verifyBuyer();
    const blocked = await dossiers.startCompromis(t.agent, t.fileId);
    expect(blocked).toMatchObject({ ok: false, rule: 'R58', personId: t.coBuyerIds[0] });
    await t.verifyBuyer(undefined, t.coBuyerIds[0]);
    expect(await dossiers.startCompromis(t.agent, t.fileId)).toMatchObject({ ok: true });
  });

  it('[R61] chaque coacquéreur a sa notification, sa preuve, ses versions et son délai ; le dossier retient le dernier', async () => {
    const t = await setupDossier('appartement', {}, { coBuyers: 1 });
    const [co] = t.coBuyerIds;
    await t.startCompromis();
    t.setClock(new Date('2027-03-16T08:00:00.000Z'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF })).toMatchObject({ ok: true });
    // Le constat de l'audit : une seule date de notification pour deux acquéreurs. Elle doit désormais nommer l'acquéreur.
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-11', proofRef: PROOF })).toMatchObject({ ok: false, code: 'buyer_required' });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-11', proofRef: PROOF, personId: 'inconnu' })).toMatchObject({ ok: false, code: 'unknown_buyer' });
    expect(await e.record(t.agent, t.fileId, { kind: 'acte_prevu', day: '2027-06-10', proofRef: PROOF, personId: co })).toMatchObject({ ok: false, code: 'unknown_buyer' });
    const lead = await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-11', proofRef: PROOF, personId: t.buyerId });
    expect(lead.ok && lead.value.buyers).toEqual([
      { personId: t.buyerId, lead: true, notifiedOn: '2027-03-11', version: 1, lastDay: '2027-03-22', calendar: 'national', calendarReason: null },
      { personId: co, lead: false, notifiedOn: null, version: null, lastDay: null, calendar: 'national', calendarReason: null },
    ]);
    // Le coacquéreur n'est pas encore notifié : la rétractation reste à saisir.
    expect(lead.ok && lead.value.lines[0]).toMatchObject({ deadline: 'fin_retractation', status: 'a_saisir', day: null });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-09', proofRef: PROOF, personId: co })).toMatchObject({ ok: false, code: 'before_compromis' });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-17', proofRef: PROOF, personId: co })).toMatchObject({ ok: false, code: 'future_day' });
    const both = await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-13', proofRef: PROOF, personId: co });
    expect(both.ok && both.value.buyers[1]).toEqual({ personId: co, lead: false, notifiedOn: '2027-03-13', version: 1, lastDay: '2027-03-23', calendar: 'national', calendarReason: null });
    expect(both.ok && both.value.lines[0]).toMatchObject({ status: 'datee', day: '2027-03-23' });
    // Une correction s'ajoute en nouvelle version, l'ancienne reste [R17].
    const fixed = await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-15', proofRef: PROOF, personId: co });
    expect(fixed.ok && fixed.value.buyers[1]).toMatchObject({ notifiedOn: '2027-03-15', version: 2, lastDay: '2027-03-25' });
    expect(fixed.ok && fixed.value.lines[0]).toMatchObject({ day: '2027-03-25' });
    expect(await t.db.all('SELECT version FROM sale_file_buyer_notices WHERE file_id = ? ORDER BY version', [t.fileId])).toEqual([{ version: 1 }, { version: 2 }]);
    await expect(t.db.run('DELETE FROM sale_file_buyer_notices')).rejects.toThrow(/rien ne s'efface/);
    // Une signature corrigée après la notification du coacquéreur est refusée.
    expect(await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-16', proofRef: PROOF })).toMatchObject({ ok: false, code: 'before_compromis' });
    // Au journal, le coacquéreur par son identifiant, jamais son nom [R13].
    const logged = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((x) => x.type === 'dossier.date').map((x) => x.data);
    expect(logged).toContainEqual({ rule: 'R61', kind: 'notification_acquereur', version: 2, person: `person:${co}` });
    expect(JSON.stringify(logged)).not.toContain('Coacheteur');
  });

  it('[R603] [R94] chaque coacquéreur est une partie du dossier : contrôlé et figé comme l’acquéreur en tête', async () => {
    const t = await setupDossier('appartement', {}, { coBuyers: 1 });
    const fiches = new FicheUnique(t.db, t.store, { now: t.now });
    for (const [kind, id] of [['offer', t.offerId], ['sale_file', t.fileId]] as const) {
      const found = await caseScopeOf(t.db, fiches, t.network.id, kind, id);
      expect(found?.scope.persons).toContain(t.coBuyerIds[0]);
      expect(found?.scope.persons).toContain(t.buyerId);
    }
    const sale = await caseScopeOf(t.db, fiches, t.network.id, 'mandate', t.mandateId, { withSale: true });
    expect(sale?.scope.persons).toContain(t.coBuyerIds[0]);
  });

  it('[R60] pas d’acte si l’identité d’un coacquéreur n’est plus vérifiée au jour de l’acte', async () => {
    const t = await setupDossier('appartement', {}, { coBuyers: 1 });
    await t.startCompromis();
    t.setClock(new Date('2027-03-10T08:00:00.000Z'));
    await new Echeancier(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    // Plus d'un an après : l'acquéreur en tête refait son contrôle d'identité avant l'acte ; celui du coacquéreur date
    // de mars 2027, trop ancien.
    t.setClock(new Date('2028-06-05T08:00:00.000Z'));
    // Les lectures d'arrêté du jeu ont plus d'un an : la direction les relit (AU011).
    await lieuConnu(t, t.propertyId);
    expect(await t.verifyBuyer(new Date('2028-06-05T07:00:00.000Z'))).toMatchObject({ ok: true });
    t.setClock(new Date('2028-06-11T08:00:00.000Z'));
    const s = await t.pieces.status(t.agent, t.fileId);
    if (!s.ok) throw new Error(s.code);
    for (const piece of s.value.missing) expect(await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2028-05-01' })).toMatchObject({ ok: true });
    const acte = new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now });
    const ACT = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000009.pdf';
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2028-06-10', proofRef: ACT })).toMatchObject({ ok: false, rule: 'R60', code: 'incomplete', missing: [], expired: [], identity: 'non_verifiee' });
    // Le coacquéreur vérifié à son tour : l'acte du lendemain passe.
    expect(await t.verifyBuyer(new Date('2028-06-11T07:00:00.000Z'), t.coBuyerIds[0])).toMatchObject({ ok: true });
    t.setClock(new Date('2028-06-12T08:00:00.000Z'));
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2028-06-12', proofRef: ACT })).toMatchObject({ ok: true });
  });

  it('[R96] le coacquéreur qui demande ses données reçoit l’offre, le dossier et sa notification, sans la fiche des autres', async () => {
    const t = await setupDossier('appartement', {}, { coBuyers: 1 });
    const [co] = t.coBuyerIds;
    await t.startCompromis();
    t.setClock(new Date('2027-03-16T08:00:00.000Z'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-11', proofRef: PROOF, personId: t.buyerId })).toMatchObject({ ok: true });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-13', proofRef: PROOF, personId: co })).toMatchObject({ ok: true });
    // Une pièce du dossier et une tâche de l'agent : elles suivent le dossier pour ses parties, pas pour le coacquéreur.
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'titre_propriete', ref: t.upload(), issuedOn: '2027-03-05' })).toMatchObject({ ok: true });
    await e.run(t.network.id);
    const detail = await assembleAccessDetail(t.db, [co!]);
    const section = (table: string) => detail.response.sections.find((x) => x.table === table)?.rows ?? [];
    const offer = section('offer_register');
    expect(offer).toHaveLength(1);
    expect(offer[0]).toMatchObject({ id: t.offerId });
    expect(offer[0]!.buyer_person_id).not.toBe(t.buyerId);
    expect(offer[0]!.co_buyers).not.toContain(co);
    expect(section('sale_files')).toHaveLength(1);
    // Rien de ce qui suit l'offre pour l'acquéreur en tête : ni son contrôle d'identité, ni le journal de l'offre.
    await new (await import('../src/offres/controles-offre.ts')).ControlesOffre(t.db, t.acces, t.journal, { now: t.now }).check(t.agent, t.offerId);
    const again = await assembleAccessDetail(t.db, [co!]);
    expect(again.response.sections.map((x) => x.table)).not.toContain('offer_checks');
    expect(JSON.stringify(again.response.sections.find((x) => x.table === 'journal'))).not.toContain(`offer:${t.offerId}`);
    const leadChecks = await assembleAccessDetail(t.db, [t.buyerId]);
    expect(leadChecks.response.sections.find((x) => x.table === 'offer_checks')?.rows.length).toBeGreaterThan(0);
    expect(section('sale_file_buyer_notices')).toHaveLength(1);
    expect(section('sale_file_dates').map((r) => r.kind)).toEqual(['compromis_signe']);
    expect(section('sale_file_pieces')).toHaveLength(0);
    expect(section('sale_file_tasks')).toHaveLength(0);
    expect(JSON.stringify(detail.response)).not.toContain(t.buyerId);
    // Le journal du dossier : l'avancée partagée, dont sa propre notification.
    const journal = JSON.stringify(section('journal'));
    expect(journal).toContain(`person:${co}`);
    // compromis signé et sa propre notification ; jamais celle de l'acquéreur en tête.
    expect(section('journal').filter((r) => r.type === 'dossier.date')).toHaveLength(2);
    expect(section('journal').filter((r) => r.type === 'dossier.date' && JSON.stringify(r.data).includes('notification_acquereur') && !JSON.stringify(r.data).includes(`person:${co}`))).toHaveLength(0);
    // L'acquéreur en tête retrouve toujours son offre ; la liste des coacquéreurs lui est masquée.
    const lead = await assembleAccessDetail(t.db, [t.buyerId]);
    expect(lead.response.sections.find((x) => x.table === 'offer_register')?.rows).toHaveLength(1);
    expect(lead.response.sections.find((x) => x.table === 'sale_file_pieces')?.rows).toHaveLength(1);
    expect(lead.response.sections.find((x) => x.table === 'sale_file_tasks')?.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(lead.response.sections.find((x) => x.table === 'offer_register'))).not.toContain(co);
  });

  it('[R97] [R233] le coacquéreur d’un dossier arrêté n’entre pas aux prospects, comme l’acquéreur en tête', async () => {
    const t = await setupDossier('appartement', {}, { coBuyers: 1 });
    const [co] = t.coBuyerIds;
    const durees = new conformite.DureesProspects(t.db, t.journal, new FicheUnique(t.db, t.store, { now: t.now }), { now: t.now });
    const proof = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
    t.storage.refs.add(proof);
    t.setClock(new Date('2027-03-10T10:00:00.000Z'));
    expect(await new ArretDossier(t.db, t.acces, t.journal, t.storage, { now: t.now }).stop(t.agent, t.fileId, { reason: 'pret_refuse', proofRef: proof })).toMatchObject({ ok: true });
    for (const at of ['2030-03-10T10:00:00.000Z', '2030-04-10T10:00:00.000Z']) {
      t.setClock(new Date(at));
      await durees.run(t.network.id);
    }
    for (const id of [t.buyerId, co!]) expect(await t.db.first('SELECT 1 FROM prospect_retention_cycles WHERE person_id = ?', [id])).toBeNull();
  });

  it('[R16] un coacquéreur confié à un autre agent : l’échéancier et le registre le taisent, le délai du dossier reste', async () => {
    const t = await setupDossier('appartement', {}, { coBuyers: 1 });
    const [co] = t.coBuyerIds;
    await t.startCompromis();
    t.setClock(new Date('2027-03-16T08:00:00.000Z'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-11', proofRef: PROOF, personId: t.buyerId });
    await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-13', proofRef: PROOF, personId: co });
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.userId, co!]);
    const s = await e.schedule(t.agent, t.fileId);
    expect(s.ok && s.value.buyers[1]).toEqual({ personId: null, lead: false, notifiedOn: null, version: null, lastDay: null, calendar: null, calendarReason: null });
    expect(s.ok && s.value.lines[0]).toMatchObject({ status: 'datee', day: '2027-03-23' });
    expect(JSON.stringify(s)).not.toContain(co!);
    const { SuiviOffres } = await import('../src/offres/suivi-offres.ts');
    const listed = await new SuiviOffres(t.db, t.acces, t.journal, { now: t.now }).listFor(t.agent, t.propertyId);
    expect(JSON.stringify(listed)).not.toContain(co!);
  });
});
