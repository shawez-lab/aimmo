import { describe, expect, it } from 'vitest';
import { ControlesOffre, offerCheckLines, type Offer } from '../src/offres/index.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Offres inventées.
const OFFER: Offer = {
  id: 'o1', propertyId: 'b1', seq: 1, buyerPersonId: 'p1', amountEur: 205000,
  conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }], validUntil: '2027-03-10',
  downPaymentEur: 70000, loanEur: 150000, signedRef: 'offres/x.pdf', receivedAt: '2027-03-01T09:00:00.000Z', agentId: 'a1', at: '2027-03-01T10:00:00.000Z', hash: 'h',
};
const NOW = new Date('2027-03-02T10:00:00.000Z');

describe('O02 · lignes du contrôle', () => {
  it('[R14] des constats, jamais une note : identité, financement, prêt, validité', () => {
    expect(offerCheckLines(OFFER, '2027-02-01T09:00:00.000Z', NOW)).toEqual([
      { check: 'identite', status: 'verifiee', checkedOn: '2027-02-01' },
      { check: 'financement', status: 'couvert' },
      { check: 'pret', status: 'coherent' },
      { check: 'validite', status: 'en_cours', lastDay: '2027-03-10' },
    ]);
    const lines = offerCheckLines({ ...OFFER, downPaymentEur: 20000, loanEur: 160000 }, null, new Date('2027-03-10T23:30:00.000Z'));
    expect(lines).toEqual([
      { check: 'identite', status: 'non_verifiee' },
      { check: 'financement', status: 'ecart', missingEur: 25000 },
      { check: 'pret', status: 'different', conditionLoanEur: 150000, declaredLoanEur: 160000 },
      { check: 'validite', status: 'echue', lastDay: '2027-03-10' }, // 0 h 30 le 11 mars à Paris
    ]);
    expect(offerCheckLines({ ...OFFER, conditions: [] }, null, NOW)[2]).toEqual({ check: 'pret', status: 'sans_objet' });
    // Aucune ligne ne porte de note, de rang ni d'avis.
    expect(JSON.stringify(lines)).not.toMatch(/score|note|rang|solvab|risque|fiab/i);
  });
});

describeWithSqlite('O02 · contrôle d’une offre en base', () => {
  it('[R15] l’identité est un état lu dans D03, jamais une pièce ; le contrôle est gardé et écrit au journal en codes', async () => {
    const t = await setupOffre();
    const offer = await t.record({ downPaymentEur: 40000 });
    const controles = new ControlesOffre(t.db, t.acces, t.journal, { now: t.now });
    let r = await controles.check(t.agent, offer.id);
    expect(r.ok && r.value.map((l) => `${l.check}:${l.status}`)).toEqual(['identite:non_verifiee', 'financement:ecart', 'pret:coherent', 'validite:en_cours']);
    expect(r.ok && r.value[1]).toEqual({ check: 'financement', status: 'ecart', missingEur: 15000 });
    const { ControlesSignature } = await import('../src/index.ts');
    await new ControlesSignature(t.db, t.acces, t.journal, { now: t.now }).recordIdentity(t.agent, t.buyerId, { piece: 'passeport', seenAt: new Date('2027-02-27T09:00:00.000Z') });
    r = await controles.check(t.agent, offer.id);
    expect(r.ok && r.value[0]).toEqual({ check: 'identite', status: 'verifiee', checkedOn: '2027-02-27' });
    expect(JSON.stringify(r)).not.toMatch(/passeport|carte_identite/);
    const kept = await t.db.all<{ lines: string }>('SELECT lines FROM offer_checks WHERE offer_id = ? ORDER BY checked_at, rowid', [offer.id]);
    expect(kept).toHaveLength(2);
    const logged = (await t.journal.bySubject(`offer:${offer.id}`)).filter((e) => e.type === 'offre.controlee');
    expect(logged.map((e) => e.data)).toEqual([
      { rule: 'R14', lines: ['identite:non_verifiee', 'financement:ecart', 'pret:coherent', 'validite:en_cours'] },
      { rule: 'R14', lines: ['identite:verifiee', 'financement:ecart', 'pret:coherent', 'validite:en_cours'] },
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/15000|205000|Acheteur/);
    await expect(t.db.run('DELETE FROM offer_checks')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R16] seuls l’agent du bien et la direction contrôlent ; une offre inconnue ou d’un autre réseau ne se voit pas', async () => {
    const t = await setupOffre();
    const offer = await t.record();
    const controles = new ControlesOffre(t.db, t.acces, t.journal, { now: t.now });
    expect(await controles.check(t.sam, offer.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await controles.check(t.direction, offer.id)).toMatchObject({ ok: true });
    expect(await controles.check(t.agent, 'offre-inconnue')).toEqual({ ok: false, rule: null, code: 'unknown_offer' });
    expect(await controles.check({ role: 'direction', userId: 'd-2', networkId: 'autre' } as never, offer.id)).toEqual({ ok: false, rule: null, code: 'unknown_offer' });
    expect((await t.journal.bySubject('offer:offre-inconnue')).filter((e) => e.type === 'acces.refuse')).toHaveLength(1);
    // Une offre d'un acquéreur suivi par un autre agent, enregistrée par la direction : l'agent du bien ne lit pas son identité.
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.userId, firstName: 'Autre', lastName: 'Exemple' });
    const theirs = await t.offres.record(t.direction, t.propertyId, t.input({ buyerPersonId: other.id }));
    if (!theirs.ok) throw new Error(theirs.code);
    expect(await controles.check(t.agent, theirs.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.db.all('SELECT id FROM offer_checks WHERE offer_id = ?', [theirs.value.id])).toHaveLength(0);
    expect(await controles.check(t.direction, theirs.value.id)).toMatchObject({ ok: true });
  });

  it('[R15] la règle d’identité est celle de D03 : fenêtre du réglage à la milliseconde, toutes les fiches réunies', async () => {
    const t = await setupOffre();
    const offer = await t.record();
    const { ControlesSignature } = await import('../src/index.ts');
    // Une seconde fiche de la même personne, vérifiée, puis réunie à celle de l'offre.
    const twin = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
    await new ControlesSignature(t.db, t.acces, t.journal, { now: t.now }).recordIdentity(t.agent, twin.id, { piece: 'carte_identite', seenAt: new Date('2026-09-02T10:00:00.000Z') });
    const controles = new ControlesOffre(t.db, t.acces, t.journal, { now: t.now, settings: { identityDays: 180 } });
    let r = await controles.check(t.agent, offer.id);
    expect(r.ok && r.value[0]).toEqual({ check: 'identite', status: 'non_verifiee' });
    await t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES ('f-1', ?, ?, ?, ?, 'doublon', '2027-03-01T09:00:00.000Z', '2027-03-01T09:00:00.000Z')", [t.network.id, t.alexId, t.buyerId, twin.id]);
    // 180 jours pile avant maintenant : compte encore ; une milliseconde de plus : ne compte plus.
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    r = await controles.check(t.agent, offer.id);
    expect(r.ok && r.value[0]).toEqual({ check: 'identite', status: 'verifiee', checkedOn: '2026-09-02' });
    t.setClock(new Date('2027-03-01T10:00:00.001Z'));
    r = await controles.check(t.agent, offer.id);
    expect(r.ok && r.value[0]).toEqual({ check: 'identite', status: 'non_verifiee' });
    // Une vérification datée après l'instant du contrôle ne compte pas.
    t.setClock(new Date('2026-09-01T10:00:00.000Z'));
    expect((await new ControlesOffre(t.db, t.acces, t.journal, { now: t.now }).check(t.agent, offer.id)).ok).toBe(true);
  });

  it('chaque offre enregistrée a son contrôle écrit, fait à l’enregistrement', async () => {
    const t = await setupOffre();
    const controles = new ControlesOffre(t.db, t.acces, t.journal, { now: t.now });
    const r = await controles.recordAndCheck(t.agent, t.propertyId, t.input({ downPaymentEur: 40000 }));
    expect(r).toMatchObject({ ok: true, value: { offer: { seq: 1 }, lines: [{ check: 'identite', status: 'non_verifiee' }, { check: 'financement', status: 'ecart', missingEur: 15000 }, { check: 'pret' }, { check: 'validite' }] } });
    if (!r.ok) return;
    expect(await t.db.all('SELECT id FROM offer_checks WHERE offer_id = ?', [r.value.offer.id])).toHaveLength(1);
    expect(await controles.recordAndCheck(t.agent, t.propertyId, t.input({ amountEur: 0 }))).toEqual({ ok: false, rule: null, code: 'invalid', field: 'amountEur' });
  });
});
