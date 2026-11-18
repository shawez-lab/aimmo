// AU009 · Une offre et son dossier portent plusieurs acquéreurs, chacun avec son identité, sa notification et son délai.
// Personnes, biens et dates inventés.
import { expect, it } from 'vitest';
import { DossiersVente } from '../src/offres/dossier-vente.ts';
import { hashOffer } from '../src/offres/registre-offres.ts';
import { Echeancier, buyerWithdrawalLastDay, scheduleLines } from '../src/dossiers/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
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
    // Deux fiches distinctes : rien n'a été fusionné.
    expect(await t.db.first('SELECT 1 FROM person_merges')).toBeNull();
    // Une offre sans coacquéreur reste comme avant.
    const solo = await t.offres.record(t.agent, t.propertyId, t.input({ signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000002.pdf' }));
    expect(solo.ok && solo.value.coBuyerPersonIds).toEqual([]);
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 2 });
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
      { personId: t.buyerId, lead: true, notifiedOn: '2027-03-11', version: 1, lastDay: '2027-03-22' },
      { personId: co, lead: false, notifiedOn: null, version: null, lastDay: null },
    ]);
    // Le coacquéreur n'est pas encore notifié : la rétractation reste à saisir.
    expect(lead.ok && lead.value.lines[0]).toMatchObject({ deadline: 'fin_retractation', status: 'a_saisir', day: null });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-09', proofRef: PROOF, personId: co })).toMatchObject({ ok: false, code: 'before_compromis' });
    expect(await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-17', proofRef: PROOF, personId: co })).toMatchObject({ ok: false, code: 'future_day' });
    const both = await e.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-13', proofRef: PROOF, personId: co });
    expect(both.ok && both.value.buyers[1]).toEqual({ personId: co, lead: false, notifiedOn: '2027-03-13', version: 1, lastDay: '2027-03-23' });
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
});
