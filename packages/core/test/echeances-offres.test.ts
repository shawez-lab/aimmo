import { expect, it } from 'vitest';
import { EcheancesOffres, TransmissionOffres } from '../src/offres/index.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Offres inventées, valables jusqu'au 10 mars 2027.
const PROOF = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000001.pdf';

describeWithSqlite('O05 · délais de validité suivis', () => {
  it('[R59] une seule tâche par offre, la veille du dernier jour à l’heure de Paris ; rien n’est envoyé', async () => {
    const t = await setupOffre();
    const a = await t.record({ validUntil: '2027-03-10' });
    const b = await t.record({ validUntil: '2027-03-20' });
    const echeances = new EcheancesOffres(t.db, t.journal, { now: t.now });
    t.setClock(new Date('2027-03-08T22:59:00.000Z')); // 8 mars, 23 h 59 à Paris : trop tôt
    expect(await echeances.run(t.network.id)).toEqual([]);
    t.setClock(new Date('2027-03-08T23:00:00.000Z')); // 9 mars, 0 h à Paris
    expect(await echeances.run(t.network.id)).toEqual([a.id]);
    expect(await echeances.run(t.network.id)).toEqual([]);
    expect(await echeances.tasksOf(t.agent)).toEqual({ ok: true, tasks: [{ offerId: a.id, proposalId: null, propertyId: t.propertyId, lastDay: '2027-03-10', createdAt: '2027-03-08T23:00:00.000Z' }] });
    expect(await echeances.tasksOf(t.sam)).toEqual({ ok: true, tasks: [] });
    expect(await echeances.tasksOf(t.direction)).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    // [R16] Un agent parti, ou qui se dit d'un autre réseau, ne voit plus ses tâches ; le refus est au journal.
    expect(await echeances.tasksOf({ ...t.agent, networkId: 'autre-reseau' })).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect(await echeances.tasksOf(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse' && (e.data as { kind: string }).kind === 'offer_tasks')).toHaveLength(3);
    await t.db.run("UPDATE agents SET status = 'active' WHERE id = ?", [t.alexId]);
    // Le 11 mars à Paris, l'offre est échue : plus de tâche nouvelle, et elle ne peut plus être acceptée.
    t.setClock(new Date('2027-03-10T23:00:00.000Z'));
    expect(await echeances.run(t.network.id)).toEqual([]);
    const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
    expect(await transmission.stateOf(a)).toBe('echue');
    expect(await transmission.stateOf(b)).toBe('recue');
    // Rien n'est envoyé : aucun message sortant.
    expect(await t.db.all("SELECT id FROM messages WHERE direction = 'out'")).toEqual([]);
    await expect(t.db.run('DELETE FROM offer_tasks')).rejects.toThrow(/rien ne s'efface/);
  });

  it('une offre qui a reçu sa réponse n’a pas de tâche, et sa tâche disparaît de la liste une fois répondue', async () => {
    const t = await setupOffre();
    const a = await t.record({ validUntil: '2027-03-03' });
    const b = await t.record({ validUntil: '2027-03-03' });
    const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
    await transmission.transmit(t.agent, a.id, { via: 'telephone' });
    await transmission.transmit(t.agent, b.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T11:00:00.000Z'));
    await transmission.respond(t.agent, a.id, { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-01T10:30:00.000Z' });
    const echeances = new EcheancesOffres(t.db, t.journal, { now: t.now, noticeDays: 2 });
    expect(await echeances.run(t.network.id)).toEqual([b.id]);
    await transmission.respond(t.agent, b.id, { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-01T10:45:00.000Z' });
    expect(await echeances.tasksOf(t.agent)).toEqual({ ok: true, tasks: [] });
    expect(() => new EcheancesOffres(t.db, t.journal, { noticeDays: -1 })).toThrow();
  });
});
