// D10 : le mandat en vigueur à une date passée se lit avec les avenants et les mandats de cette date-là.
import { expect, it } from 'vitest';
import { Diffusion, mandateTerms } from '../src/documents/index.ts';
import { ActeVente, Echeancier, mandateFeeAt } from '../src/dossiers/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000002.pdf';
const COMPROMIS = '2027-03-10';

describeWithSqlite('D10 · conditions d’un mandat à une date passée', () => {
  async function ready() {
    const t = await setupDossier();
    await t.startCompromis();
    t.setClock(at9(COMPROMIS));
    await new Echeancier(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.fileId, { kind: 'compromis_signe', day: COMPROMIS, proofRef: PROOF });
    const s = await t.pieces.status(t.agent, t.fileId);
    if (!s.ok) throw new Error(s.code);
    for (const piece of s.value.missing) await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-05' });
    const diffusion = new Diffusion(t.db, t.acces, t.journal, { now: t.now });
    return { ...t, diffusion, acte: new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }) };
  }

  it('[R63] un avenant qui raccourcit le mandat après le compromis ne retire pas la commission', async () => {
    const t = await ready();
    t.setClock(at9('2027-03-20'));
    await t.amendDuration(1); // Fin au 10 mars : le jour du compromis, si l'avenant comptait déjà.
    expect(await mandateFeeAt(t.db, t.diffusion, t.network.id, t.propertyId, COMPROMIS)).toEqual({ ok: true, mandateId: t.mandateId, feeEur: 10000, feeCharge: 'acquereur' });
    t.setClock(at9('2027-06-11'));
    const r = await t.acte.record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    expect(r.ok && r.value.commission.feeEur).toBe(10000);
  });

  it('[R63] un avenant signé avant le compromis compte, et ce jour-là aussi', async () => {
    const before = await ready();
    before.setClock(at9('2027-03-09'));
    await before.amendDuration(1, at9('2027-03-09'));
    before.setClock(at9('2027-03-20'));
    expect(await mandateFeeAt(before.db, before.diffusion, before.network.id, before.propertyId, COMPROMIS)).toEqual({ ok: false, code: 'no_mandate_in_force' });
    const sameDay = await ready();
    sameDay.setClock(new Date(`${COMPROMIS}T16:30:00.000Z`)); // Après l'heure de lecture du compromis, le même jour.
    await sameDay.amendDuration(1);
    expect(await mandateFeeAt(sameDay.db, sameDay.diffusion, sameDay.network.id, sameDay.propertyId, COMPROMIS)).toEqual({ ok: false, code: 'no_mandate_in_force' });
  });

  it('[R63] un avenant signé à 23 h 30 à Paris compte pour ce jour de Paris, pas pour la veille', async () => {
    const t = await ready();
    t.setClock(new Date('2027-03-10T22:30:00.000Z')); // 23 h 30 à Paris, le 10 mars.
    await t.amendDuration(1);
    t.setClock(at9('2027-03-20'));
    const terms = (day: string) => mandateTerms(t.db, t.mandateId, new Date(`${day}T11:00:00.000Z`));
    expect((await terms('2027-03-09'))?.durationMonths).toBe(12);
    expect((await terms('2027-03-10'))?.durationMonths).toBe(1);
  });

  it('[R63] les conditions se relisent à chaque date, dans les deux sens ; sans date, toutes les signatures comptent', async () => {
    const t = await ready();
    t.setClock(at9('2027-03-12'));
    await t.amendDuration(6);
    t.setClock(at9('2027-04-02'));
    await t.amendDuration(24);
    await t.amend(195000);
    const terms = (day: string) => mandateTerms(t.db, t.mandateId, new Date(`${day}T11:00:00.000Z`));
    expect(await terms('2027-03-11')).toMatchObject({ durationMonths: 12, priceEur: 200000, amendments: [] });
    expect(await terms('2027-03-20')).toMatchObject({ durationMonths: 6, priceEur: 200000 });
    expect((await terms('2027-03-20'))?.amendments.length).toBe(1);
    expect(await terms('2027-05-01')).toMatchObject({ durationMonths: 24, priceEur: 195000 });
    expect(await mandateTerms(t.db, t.mandateId)).toMatchObject({ durationMonths: 24, priceEur: 195000 });
    // Le 10 août, fin des six mois : l'avenant de 24 mois, signé avant cette date, garde le mandat en cours.
    expect((await t.diffusion.canDiffuse(t.network.id, t.propertyId, at9('2027-03-20'))).reason).toBe('allowed');
    expect((await t.diffusion.canDiffuse(t.network.id, t.propertyId, at9('2027-08-10'))).reason).toBe('allowed');
  });

  it('[R63] un nouveau mandat signé après le compromis ne masque pas celui qui était en vigueur', async () => {
    const t = await ready();
    t.setClock(at9('2027-03-20'));
    // Un seul mandat vivant par bien (D15) : le premier se termine d'abord, après le compromis.
    await t.amendDuration(1);
    await t.signNewMandate(9000);
    expect(await mandateFeeAt(t.db, t.diffusion, t.network.id, t.propertyId, COMPROMIS)).toEqual({ ok: true, mandateId: t.mandateId, feeEur: 10000, feeCharge: 'acquereur' });
  });

  it('[R63] un mandat échu au compromis et rallongé après reste échu ce jour-là : pas de commission', async () => {
    const t = await ready();
    t.setClock(at9('2027-03-20'));
    await t.amendDuration(24, at9('2027-03-15'));
    await t.amendDuration(1, at9('2027-03-09'));
    expect(await mandateFeeAt(t.db, t.diffusion, t.network.id, t.propertyId, COMPROMIS)).toEqual({ ok: false, code: 'no_mandate_in_force' });
    // Aujourd'hui, la dernière durée signée vaut.
    expect((await t.diffusion.canDiffuse(t.network.id, t.propertyId)).allowed).toBe(true);
  });

  it('[R63] une demande écrite reçue après le compromis ne fait pas passer un mandat en délai devant celui en vigueur', async () => {
    const t = await ready();
    t.setClock(at9('2027-03-20'));
    // Un seul mandat vivant par bien (D15) : le premier se termine le 15 mars, après le compromis ; l'autre, signé avant, s'enregistre ensuite.
    await t.amendDuration(1, at9('2027-03-15'));
    const later = await t.signNewMandate(9000, at9('2027-03-05'), 'hors_agence');
    expect(await t.diffusion.recordEarlyStart(t.agent, later, { proof: 'mail du vendeur (test)', receivedAt: at9('2027-03-15') })).toEqual({ ok: true });
    expect(await mandateFeeAt(t.db, t.diffusion, t.network.id, t.propertyId, COMPROMIS)).toEqual({ ok: true, mandateId: t.mandateId, feeEur: 10000, feeCharge: 'acquereur' });
    // À partir du jour où elle est reçue, la demande compte.
    expect(await t.diffusion.canDiffuse(t.network.id, t.propertyId, at9('2027-03-15'))).toMatchObject({ allowed: true, reason: 'allowed_early_start', mandateId: later });
  });

  it('[R42] à la date d’aujourd’hui, rien ne change : l’avenant raccourci ferme la diffusion dès sa signature', async () => {
    const t = await ready();
    t.setClock(at9('2027-03-20'));
    expect((await t.diffusion.canDiffuse(t.network.id, t.propertyId)).allowed).toBe(true);
    await t.amendDuration(1);
    expect(await t.diffusion.canDiffuse(t.network.id, t.propertyId)).toMatchObject({ allowed: false, reason: 'expired' });
    // Un nouveau mandat signé, la diffusion repart sur lui.
    const fresh = await t.signNewMandate(9000);
    expect(await t.diffusion.canDiffuse(t.network.id, t.propertyId)).toMatchObject({ allowed: true, mandateId: fresh });
  });

  it('[R42] un mandat n’existe pas avant sa signature : aucune date passée ne le donne', async () => {
    const t = await ready();
    t.setClock(at9('2027-03-20'));
    await t.amendDuration(1);
    await t.signNewMandate(9000);
    expect(await t.diffusion.canDiffuse(t.network.id, t.propertyId, at9('2027-02-01'))).toEqual({ allowed: false, reason: 'no_mandate', mandateId: null, withdrawalLastDay: null });
  });
});
