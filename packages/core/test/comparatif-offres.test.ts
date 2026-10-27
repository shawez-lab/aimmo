import { expect, it } from 'vitest';
import { ComparatifOffres, ContreOffres, TransmissionOffres } from '../src/offres/index.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Offres inventées sur le bien du jeu commun (mandat : honoraires de 10 000 €).
const PROOF = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000001.pdf';

describeWithSqlite('O06 · tableau comparatif des offres', () => {
  it('[R14] [R57] toutes les offres, dans l’ordre d’arrivée, sans tri ni note ; net vendeur depuis le mandat', async () => {
    const t = await setupOffre();
    const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
    const contre = new ContreOffres(t.db, t.acces, t.journal, { now: t.now });
    const low = await t.record({ amountEur: 190000, conditions: [], validUntil: '2027-03-03' });
    const high = await t.record({ amountEur: 215000, conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }, { kind: 'vente_autre_bien' }], validUntil: '2027-03-10' });
    const mid = await t.record({ amountEur: 200000, validUntil: '2027-03-05' });
    // La troisième offre fait l'objet d'une contre-offre du vendeur à 207 000 €.
    await transmission.transmit(t.agent, mid.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T12:00:00.000Z'));
    await transmission.respond(t.agent, mid.id, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
    await contre.propose(t.agent, mid.id, { amountEur: 207000, validUntil: '2027-03-04', proofRef: PROOF });
    const table = await new ComparatifOffres(t.db, t.acces, t.journal, { now: t.now }).table(t.agent, t.propertyId);
    expect(table).toEqual({
      ok: true,
      value: {
        count: 3,
        registerIntact: true,
        rows: [
          { seq: 1, amountEur: 190000, netSellerEur: 180000, conditions: [], daysLeft: 2, state: 'recue', counterProposals: 0 },
          { seq: 2, amountEur: 215000, netSellerEur: 205000, conditions: ['pret', 'vente_autre_bien'], daysLeft: 9, state: 'recue', counterProposals: 0 },
          { seq: 3, amountEur: 207000, netSellerEur: 197000, conditions: ['pret'], daysLeft: 3, state: 'contre_offre', counterProposals: 1 },
        ],
      },
    });
    // Aucune donnée sur l'acquéreur, aucun classement ni avis.
    expect(JSON.stringify(table)).not.toMatch(/Acheteur|Exemple|buyer|financ|downPayment|score|rang|meilleur|recommand/i);
    // La contre-offre du vendeur est acceptée : la ligne le dit.
    const props = await t.db.all<{ id: string }>('SELECT id FROM offer_proposals WHERE offer_id = ?', [mid.id]);
    await contre.transmit(t.agent, props[0]!.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T14:00:00.000Z'));
    await contre.respond(t.agent, props[0]!.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T13:30:00.000Z' });
    const after = await new ComparatifOffres(t.db, t.acces, t.journal, { now: t.now }).table(t.agent, t.propertyId);
    expect(after.ok && after.value.rows[2]).toMatchObject({ amountEur: 207000, state: 'acceptee', daysLeft: null });
    expect(low.seq).toBe(1);
    expect(high.seq).toBe(2);
  });

  it('[R56] le tableau dit si le registre est intact ; [R16] l’agent du bien et la direction seulement', async () => {
    const t = await setupOffre();
    await t.record();
    await t.record({ amountEur: 210000 });
    const comparatif = new ComparatifOffres(t.db, t.acces, t.journal, { now: t.now });
    expect(await comparatif.table(t.sam, t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await comparatif.table(t.direction, t.propertyId)).toMatchObject({ ok: true, value: { count: 2, registerIntact: true } });
    await t.db.exec('DROP TRIGGER offer_register_sans_modification');
    await t.db.run('UPDATE offer_register SET amount_eur = 199000 WHERE seq = 2');
    expect(await comparatif.table(t.agent, t.propertyId)).toMatchObject({ ok: true, value: { count: 2, registerIntact: false } });
  });
});
