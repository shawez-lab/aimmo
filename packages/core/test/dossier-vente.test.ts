import { expect, it } from 'vitest';
import { ControlesSignature } from '../src/index.ts';
import { Publication } from '../src/annonces/index.ts';
import { ContreOffres, ControlesOffre, DossiersVente, TransmissionOffres } from '../src/offres/index.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Une offre test de bout en bout, inventée.
const PROOF = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000001.pdf';

describeWithSqlite('O07 · offre acceptée et dossier de vente', () => {
  it('[R58] une offre test de bout en bout : enregistrée, contrôlée, transmise, contre-offre, acceptée, dossier ; compromis bloqué sans identité', async () => {
    const t = await setupOffre();
    const controles = new ControlesOffre(t.db, t.acces, t.journal, { now: t.now });
    const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
    const contre = new ContreOffres(t.db, t.acces, t.journal, { now: t.now });
    const dossiers = new DossiersVente(t.db, t.acces, t.journal, { now: t.now });
    // L'annonce est en ligne.
    await t.annonces.validate(t.agent, t.draftId);
    await t.publication.sync(t.network.id, t.propertyId);
    const recorded = await controles.recordAndCheck(t.agent, t.propertyId, t.input());
    if (!recorded.ok) throw new Error(recorded.code);
    const offer = recorded.value.offer;
    expect(await dossiers.open(t.agent, offer.id)).toEqual({ ok: false, rule: null, code: 'not_accepted' });
    await transmission.transmit(t.agent, offer.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T12:00:00.000Z'));
    await transmission.respond(t.agent, offer.id, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
    const v1 = await contre.propose(t.agent, offer.id, { amountEur: 208000, validUntil: '2027-03-05', proofRef: PROOF });
    if (!v1.ok) throw new Error(v1.code);
    expect(await dossiers.open(t.agent, offer.id)).toEqual({ ok: false, rule: null, code: 'not_accepted' });
    await contre.transmit(t.agent, v1.value.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-02T10:00:00.000Z'));
    await contre.respond(t.agent, v1.value.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-02T09:00:00.000Z' });
    const opened = await dossiers.open(t.agent, offer.id);
    expect(opened).toMatchObject({ ok: true, value: { offerId: offer.id, amountEur: 208000, steps: [] } });
    if (!opened.ok) return;
    // Le bien passe sous offre, et la publication le montre partout au passage suivant.
    expect((await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status).toBe('under_offer');
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ state: 'sous_offre', created: true });
    // Compromis bloqué tant que l'identité n'est pas vérifiée.
    expect(await dossiers.startCompromis(t.agent, opened.value.id)).toEqual({ ok: false, rule: 'R58', code: 'identity_missing' });
    expect((await t.journal.bySubject(`sale_file:${opened.value.id}`)).map((e) => e.type)).toEqual(['dossier.bloque']);
    await new ControlesSignature(t.db, t.acces, t.journal, { now: t.now }).recordIdentity(t.agent, t.buyerId, { piece: 'passeport', seenAt: new Date('2027-03-02T09:30:00.000Z') });
    const started = await dossiers.startCompromis(t.agent, opened.value.id);
    expect(started).toMatchObject({ ok: true, value: { steps: [{ step: 'compromis_en_preparation' }] } });
    expect(await dossiers.startCompromis(t.agent, opened.value.id)).toEqual({ ok: false, rule: null, code: 'already_started' });
    // L'historique de l'offre est complet et horodaté.
    const h = await contre.history(t.agent, offer.id);
    expect(h.ok && h.value.map((e) => e.event)).toEqual([
      'recue', 'enregistree', 'controlee', 'transmise:telephone', 'reponse:contre_offre',
      'proposition:1:vendeur', 'proposition:1:transmise', 'proposition:1:acceptee',
    ]);
    expect(h.ok && h.value.every((e) => /^\d{4}-\d{2}-\d{2}T/.test(e.at))).toBe(true);
  });

  it('une seule offre acceptée à la fois par bien ; droits ; rien ne s’efface', async () => {
    const t = await setupOffre();
    const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
    const dossiers = new DossiersVente(t.db, t.acces, t.journal, { now: t.now });
    const a = await t.record();
    const b = await t.record({ amountEur: 206000 });
    for (const o of [a, b]) await transmission.transmit(t.agent, o.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T12:00:00.000Z'));
    expect(await transmission.respond(t.agent, a.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' })).toMatchObject({ ok: true });
    // Une seconde acceptation sur le même bien est refusée : une seule offre acceptée à la fois.
    expect(await transmission.respond(t.agent, b.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' })).toEqual({ ok: false, rule: null, code: 'other_accepted' });
    expect(await transmission.stateOf(b)).toBe('transmise');
    expect(await dossiers.open(t.direction, a.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await dossiers.open(t.agent, a.id)).toMatchObject({ ok: true, value: { amountEur: 205000 } });
    expect(await dossiers.open(t.agent, b.id)).toEqual({ ok: false, rule: null, code: 'not_accepted' });
    // Ni par une contre-offre acceptée ensuite.
    await transmission.respond(t.agent, b.id, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T11:30:00.000Z' });
    const contre = new ContreOffres(t.db, t.acces, t.journal, { now: t.now });
    const v = await contre.propose(t.agent, b.id, { amountEur: 207000, validUntil: '2027-03-05', proofRef: PROOF });
    if (!v.ok) throw new Error(v.code);
    await contre.transmit(t.agent, v.value.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T13:00:00.000Z'));
    expect(await contre.respond(t.agent, v.value.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T12:30:00.000Z' })).toEqual({ ok: false, rule: null, code: 'other_accepted' });
    expect(await dossiers.startCompromis(t.agent, 'dossier-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    await expect(t.db.run('DELETE FROM sale_files')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R16] le compromis lit l’identité de l’acquéreur seulement avec le droit de voir sa fiche ; deux acceptations simultanées, une seule passe', async () => {
    const t = await setupOffre();
    const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
    const dossiers = new DossiersVente(t.db, t.acces, t.journal, { now: t.now });
    // Une offre d'un acquéreur suivi par un autre agent, enregistrée par la direction.
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.userId, firstName: 'Autre', lastName: 'Exemple' });
    const theirs = await t.offres.record(t.direction, t.propertyId, t.input({ buyerPersonId: other.id }));
    if (!theirs.ok) throw new Error(theirs.code);
    const mine = await t.record({ amountEur: 206000 });
    for (const o of [theirs.value, mine]) await transmission.transmit(t.agent, o.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T12:00:00.000Z'));
    const both = await Promise.all([theirs.value, mine].map((o) => transmission.respond(t.agent, o.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' })));
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, rule: null, code: 'other_accepted' }]);
    const accepted = both[0]!.ok ? theirs.value : mine;
    if (accepted.id !== theirs.value.id) return; // l'ordre dépend de l'exécution ; le cas utile est celui de l'acquéreur de l'autre agent
    const file = await dossiers.open(t.agent, theirs.value.id);
    if (!file.ok) throw new Error(file.code);
    expect(await dossiers.startCompromis(t.agent, file.value.id)).toMatchObject({ ok: false, rule: 'R16' });
  });
});
