import { expect, it } from 'vitest';
import { ALERT_PURPOSE, Alertes, Diffusion, FicheAcquereur, MisesEnVente, verifyChain } from '../src/index.ts';
import { DELAY_END, setupAnnonce as setup } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : le bien du jeu de M07 et un acquéreur.
type World = Awaited<ReturnType<typeof setup>>;
const statusOf = async (t: World) => (await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status;
const eventsOf = async (t: World) => (await t.journal.bySubject(`property:${t.propertyId}`)).map((e) => e.type);

/** Annonce validée, délai de rétractation passé : le bien se publie au prochain passage. */
async function listed(t: World) {
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(DELAY_END);
  return t.publication.sync(t.network.id, t.propertyId);
}

describeWithSqlite('SV08 · un bien publié devient disponible', () => {
  it('[R42] sans annonce publiable il reste en préparation ; publié, il est disponible, une seule fois', async () => {
    const t = await setup();
    await t.annonces.validate(t.agent, t.draftId);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await statusOf(t)).toBe('draft');
    t.setClock(DELAY_END);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ state: 'en_vente', created: true });
    expect(await statusOf(t)).toBe('available');
    await t.publication.sync(t.network.id, t.propertyId);
    expect((await eventsOf(t)).filter((e) => e === 'bien.disponible')).toHaveLength(1);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('une coupure entre la version et le statut se répare au passage suivant', async () => {
    const t = await setup();
    await listed(t);
    await t.db.run("UPDATE properties SET status = 'draft' WHERE id = ?", [t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await statusOf(t)).toBe('available');
  });

  it.each(['under_offer', 'sold', 'rented', 'withdrawn'])('[R42] un bien %s ne revient jamais à disponible', async (status) => {
    const t = await setup();
    await listed(t);
    await t.db.run('UPDATE properties SET status = ? WHERE id = ?', [status, t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await statusOf(t)).toBe(status);
  });

  it('[R42] une offre ou une vente n’est pas écrasée quand son annonce est retirée', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    const diffusion = new Diffusion(t.db, t.acces, t.journal, { now: t.now });
    await diffusion.recordEarlyStart(t.agent, t.mandateId, { proof: 'demande écrite de test', receivedAt: new Date('2027-02-12T09:00:00.000Z') });
    await t.publication.sync(t.network.id, t.propertyId);
    await t.db.run("UPDATE properties SET status = 'under_offer' WHERE id = ?", [t.propertyId]);
    t.setClock(new Date('2027-02-14T10:00:00.000Z'));
    await diffusion.recordWithdrawal(t.agent, t.mandateId, { proof: 'lettre de test', receivedAt: new Date('2027-02-14T09:00:00.000Z') });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ state: 'retiree' });
    expect(await statusOf(t)).toBe('under_offer');
  });

  it('[R42] mandat rétracté : l’annonce se retire et le bien n’est plus disponible ; un nouveau mandat le rend disponible', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    const diffusion = new Diffusion(t.db, t.acces, t.journal, { now: t.now });
    await diffusion.recordEarlyStart(t.agent, t.mandateId, { proof: 'demande écrite de test', receivedAt: new Date('2027-02-12T09:00:00.000Z') });
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await statusOf(t)).toBe('available');
    t.setClock(new Date('2027-02-14T10:00:00.000Z'));
    await diffusion.recordWithdrawal(t.agent, t.mandateId, { proof: 'lettre de test', receivedAt: new Date('2027-02-14T09:00:00.000Z') });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ state: 'retiree' });
    expect(await statusOf(t)).toBe('draft');
    expect(await eventsOf(t)).toContain('bien.plus_disponible');
    t.setClock(new Date('2027-02-15T10:00:00.000Z'));
    await t.signNewMandate(9000);
    t.setClock(new Date('2027-02-16T10:00:00.000Z'));
    const again = await t.annonces.propose(t.agent, t.propertyId);
    if (!again.ok) throw new Error(again.code);
    await t.annonces.validate(t.agent, again.value.id);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await statusOf(t)).toBe('available');
  });

  it('un bien déjà disponible sans annonce (repris d’un ancien outil) garde son statut', async () => {
    const t = await setup();
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.propertyId]);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: null });
    expect(await statusOf(t)).toBe('available');
  });

  it('[R13] le journal du statut ne porte que le bien', async () => {
    const t = await setup();
    await listed(t);
    const entry = (await t.journal.bySubject(`property:${t.propertyId}`)).find((e) => e.type === 'bien.disponible')!;
    expect(entry).toMatchObject({ actor: 'system:publication', data: {} });
    expect(Object.keys(entry.data)).toEqual([]);
  });

  it('[R222] [R26] publié, il entre dans les dates de mise en vente, et l’alerte de l’acquéreur part, en essai', async () => {
    const t = await setup();
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Inès' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: buyer.id, kind: 'email', value: 'ines.acheteuse@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: buyer.id, purpose: ALERT_PURPOSE, channel: 'email', proof: 'formulaire de test', givenAt: new Date('2027-02-01T09:00:00.000Z') });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: buyer.id, kind: 'buy' });
    const search = await new FicheAcquereur(t.db, t.journal, { now: t.now }).update(t.acces, t.direction, project.id, { communes: ['Dijon'], budgetMaxEur: 250000, surfaceMinM2: 50 });
    if (!search.ok) throw new Error(search.code);
    const alertes = new Alertes(t.db, t.journal, { now: t.now, diffusion: new Diffusion(t.db, t.acces, t.journal, { now: t.now }), unsubscribeBase: 'https://aimmo.example.test/alertes/' });
    // Avant la publication, aucune alerte ne part de ce bien.
    expect(await alertes.run()).toEqual([]);
    await listed(t);
    t.setClock(new Date('2027-03-02T09:00:00.000Z'));
    expect(await new MisesEnVente(t.db, t.journal, { now: t.now }).run()).toBe(1);
    const outcomes = await alertes.run();
    expect(outcomes).toHaveLength(1);
    const held = await t.db.all('SELECT m.id FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ?', [buyer.id]);
    expect(held).toHaveLength(1);
  });
});
