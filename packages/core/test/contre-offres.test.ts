import { expect, it } from 'vitest';
import { ContreOffres, TransmissionOffres } from '../src/offres/index.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Offres et contre-offres inventées.
const PROOF = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000001.pdf';

async function setup() {
  const t = await setupOffre();
  const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
  const contre = new ContreOffres(t.db, t.acces, t.journal, { now: t.now });
  const offer = await t.record();
  await transmission.transmit(t.agent, offer.id, { via: 'telephone' });
  t.setClock(new Date('2027-03-01T12:00:00.000Z'));
  return { ...t, transmission, contre, offer };
}

describeWithSqlite('O04 · contre-offres', () => {
  it('[R57] une chaîne offre, contre-offre, nouvelle offre se lit dans l’ordre avec chaque heure ; aucun montant du système', async () => {
    const t = await setup();
    // Pas de contre-offre tant que le vendeur n'en a pas fait.
    expect(await t.contre.propose(t.agent, t.offer.id, { amountEur: 215000, validUntil: '2027-03-05', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'no_counter_asked' });
    await t.transmission.respond(t.agent, t.offer.id, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
    const v1 = await t.contre.propose(t.agent, t.offer.id, { amountEur: 215000, validUntil: '2027-03-05', proofRef: PROOF });
    expect(v1).toMatchObject({ ok: true, value: { seq: 1, side: 'vendeur', amountEur: 215000 } });
    if (!v1.ok) return;
    // Une seconde proposition ne vient qu'après la réponse « contre-offre » de l'acquéreur.
    expect(await t.contre.propose(t.agent, t.offer.id, { amountEur: 210000, validUntil: '2027-03-06', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'no_counter_asked' });
    expect(await t.contre.respond(t.agent, v1.value.id, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T11:30:00.000Z' })).toEqual({ ok: false, rule: null, code: 'not_transmitted' });
    t.setClock(new Date('2027-03-01T13:00:00.000Z'));
    await t.contre.transmit(t.agent, v1.value.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T15:00:00.000Z'));
    expect(await t.contre.respond(t.agent, v1.value.id, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T12:30:00.000Z' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.contre.respond(t.agent, v1.value.id, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T14:00:00.000Z' })).toEqual({ ok: true });
    const a2 = await t.contre.propose(t.agent, t.offer.id, { amountEur: 210000, validUntil: '2027-03-06', proofRef: PROOF });
    expect(a2).toMatchObject({ ok: true, value: { seq: 2, side: 'acquereur', amountEur: 210000 } });
    if (!a2.ok) return;
    // Une proposition remplacée ne peut plus être acceptée : elle a déjà sa réponse.
    expect(await t.contre.respond(t.agent, v1.value.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T14:30:00.000Z' })).toEqual({ ok: false, rule: null, code: 'already_answered' });
    await t.contre.transmit(t.agent, a2.value.id, { via: 'en_personne' });
    t.setClock(new Date('2027-03-02T10:00:00.000Z'));
    expect(await t.contre.respond(t.agent, a2.value.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-02T09:00:00.000Z' })).toEqual({ ok: true });
    expect((await t.contre.accepted(t.offer.id))?.amountEur).toBe(210000);
    const h = await t.contre.history(t.direction, t.offer.id);
    expect(h.ok && h.value.map((e) => e.event)).toEqual([
      'recue', 'enregistree', 'transmise:telephone', 'reponse:contre_offre',
      'proposition:1:vendeur', 'proposition:1:transmise', 'proposition:1:contre_offre',
      'proposition:2:acquereur', 'proposition:2:transmise', 'proposition:2:acceptee',
    ]);
    expect(h.ok && h.value.filter((e) => e.amountEur !== undefined).map((e) => e.amountEur)).toEqual([205000, 215000, 210000]);
    // Plus rien après une acceptation.
    expect(await t.contre.propose(t.agent, t.offer.id, { amountEur: 200000, validUntil: '2027-03-06', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'no_counter_asked' });
  });

  it('[R59] une proposition échue ne peut plus être acceptée ; saisies contrôlées ; droits', async () => {
    const t = await setup();
    await t.transmission.respond(t.agent, t.offer.id, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
    expect(await t.contre.propose(t.agent, t.offer.id, { amountEur: 0, validUntil: '2027-03-05', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'bad_amount' });
    expect(await t.contre.propose(t.agent, t.offer.id, { amountEur: 215000, validUntil: '2027-02-28', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.contre.propose(t.agent, t.offer.id, { amountEur: 215000, validUntil: '2027-03-05', proofRef: 'oui' })).toEqual({ ok: false, rule: null, code: 'bad_proof' });
    expect(await t.contre.propose(t.direction, t.offer.id, { amountEur: 215000, validUntil: '2027-03-05', proofRef: PROOF })).toMatchObject({ ok: false, rule: 'R16' });
    const v1 = await t.contre.propose(t.agent, t.offer.id, { amountEur: 215000, validUntil: '2027-03-02', proofRef: PROOF });
    if (!v1.ok) throw new Error(v1.code);
    await t.contre.transmit(t.agent, v1.value.id, { via: 'ecrit' });
    expect(await t.contre.transmit(t.agent, v1.value.id, { via: 'ecrit' })).toEqual({ ok: false, rule: null, code: 'already_transmitted' });
    t.setClock(new Date('2027-03-04T10:00:00.000Z'));
    expect(await t.contre.respond(t.agent, v1.value.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-03T09:00:00.000Z' })).toEqual({ ok: false, rule: 'R59', code: 'expired' });
    expect(await t.contre.respond(t.sam, v1.value.id, { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-03T09:00:00.000Z' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.contre.respond(t.agent, 'proposition-inconnue', { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-03T09:00:00.000Z' })).toEqual({ ok: false, rule: null, code: 'unknown_proposal' });
    await expect(t.db.run('DELETE FROM offer_proposals')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R59] une contre-offre sans réponse a sa tâche avant l’échéance, comme une offre', async () => {
    const t = await setup();
    const { EcheancesOffres } = await import('../src/offres/index.ts');
    await t.transmission.respond(t.agent, t.offer.id, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
    const v1 = await t.contre.propose(t.agent, t.offer.id, { amountEur: 215000, validUntil: '2027-03-04', proofRef: PROOF });
    if (!v1.ok) throw new Error(v1.code);
    const echeances = new EcheancesOffres(t.db, t.journal, { now: t.now });
    t.setClock(new Date('2027-03-02T23:00:00.000Z')); // 3 mars, 0 h à Paris : la veille du dernier jour
    expect(await echeances.run(t.network.id)).toEqual([v1.value.id]);
    expect(await echeances.run(t.network.id)).toEqual([]);
    const tasks = await echeances.tasksOf(t.agent);
    expect(tasks.ok && tasks.tasks).toEqual([{ offerId: t.offer.id, proposalId: v1.value.id, propertyId: t.propertyId, lastDay: '2027-03-04', createdAt: '2027-03-02T23:00:00.000Z' }]);
    await t.contre.transmit(t.agent, v1.value.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-03T10:00:00.000Z'));
    await t.contre.respond(t.agent, v1.value.id, { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-03T09:00:00.000Z' });
    const after = await echeances.tasksOf(t.agent);
    expect(after.ok && after.tasks).toEqual([]);
  });
});
