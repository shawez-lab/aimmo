import { describe, expect, it } from 'vitest';
import { ControlesOffre, MAX_VALIDITY_DAYS, USUAL_VALIDITY_DAYS, offerCheckLines, validityDays, type Offer } from '../src/offres/index.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// AU080 · une offre reçue avec plus de 60 jours de validité est gardée avec son échéance exacte, et le contrôle le signale.
// Offres inventées. Reçue le lundi 1er mars 2027, 10 h à Paris.
const OFFER: Offer = {
  id: 'o1', propertyId: 'b1', seq: 1, buyerPersonId: 'p1', coBuyerPersonIds: [], amountEur: 205000,
  conditions: [], validUntil: '2027-03-10',
  downPaymentEur: 205000, loanEur: 0, signedRef: 'offres/x.pdf', receivedAt: '2027-03-01T09:00:00.000Z', agentId: 'a1', at: '2027-03-01T10:00:00.000Z', hash: 'h',
};
const NOW = new Date('2027-03-02T10:00:00.000Z');

describe('AU080 · durée de validité inhabituelle', () => {
  it('[R56] la durée se compte du jour de réception à Paris au dernier jour de validité', () => {
    expect(USUAL_VALIDITY_DAYS).toBe(60);
    expect(MAX_VALIDITY_DAYS).toBe(730);
    expect(validityDays('2027-03-01T09:00:00.000Z', '2027-04-30')).toBe(60);
    expect(validityDays('2027-03-01T09:00:00.000Z', '2027-05-01')).toBe(61);
    // Reçue à 23 h 30 à Paris le 28 février, encore le 28 en heure de Paris : le jour de Paris compte, pas celui du serveur.
    expect(validityDays('2027-02-28T22:30:00.000Z', '2027-03-01')).toBe(1);
    // Passage à l'heure d'été (28 mars 2027) : des jours entiers, jamais 59,96.
    expect(validityDays('2027-03-01T09:00:00.000Z', '2027-06-30')).toBe(121);
  });

  it('[R14] au-delà de 60 jours, une ligne de constat de plus, sans note ; à 60 jours, les lignes d’avant, inchangées', () => {
    const usual = offerCheckLines({ ...OFFER, validUntil: '2027-04-30' }, null, NOW);
    expect(usual.map((l) => l.check)).toEqual(['identite', 'financement', 'pret', 'validite']);
    const long = offerCheckLines({ ...OFFER, validUntil: '2027-06-30' }, null, NOW);
    expect(long).toEqual([
      { check: 'identite', status: 'non_verifiee' },
      { check: 'financement', status: 'couvert' },
      { check: 'pret', status: 'sans_objet' },
      { check: 'validite', status: 'en_cours', lastDay: '2027-06-30' },
      { check: 'validite_longue', status: 'atypique', days: 121, usualDays: 60 },
    ]);
  });
});

describeWithSqlite('AU080 · offre à longue validité enregistrée fidèlement', () => {
  it('[R56] l’offre de 121 jours est inscrite avec son échéance exacte ; le contrôle d’enregistrement la signale ; au journal, des codes', async () => {
    const t = await setupOffre();
    const controles = new ControlesOffre(t.db, t.acces, t.journal, { now: t.now });
    // Le constat : avant, cette offre réelle était refusée (« validUntil »), le fait reçu perdu.
    const r = await controles.recordAndCheck(t.agent, t.propertyId, t.input({ validUntil: '2027-06-30' }));
    expect(r).toMatchObject({ ok: true, value: { offer: { seq: 1, validUntil: '2027-06-30' } } });
    if (!r.ok) return;
    expect(r.value.lines.at(-1)).toEqual({ check: 'validite_longue', status: 'atypique', days: 121, usualDays: 60 });
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 1 });
    const list = await t.offres.list(t.agent, t.propertyId);
    expect(list.ok && list.value[0]!.validUntil).toBe('2027-06-30');
    const logged = (await t.journal.bySubject(`offer:${r.value.offer.id}`)).find((e) => e.type === 'offre.controlee');
    expect((logged!.data as { lines: string[] }).lines).toContain('validite_longue:atypique');
    expect(JSON.stringify(logged!.data)).not.toMatch(/121|2027-06-30/);
    // 730 jours tout juste (2028 est bissextile) : gardée aussi ; au-delà, une date mal saisie, refusée avec le champ nommé.
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ validUntil: '2029-02-28' }))).toMatchObject({ ok: true, value: { seq: 2, validUntil: '2029-02-28' } });
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ validUntil: '2029-03-01' }))).toEqual({ ok: false, rule: null, code: 'invalid', field: 'validUntil' });
    // Une offre usuelle : aucune ligne de plus.
    const usual = await controles.recordAndCheck(t.agent, t.propertyId, t.input({ validUntil: '2027-04-30' }));
    expect(usual.ok && usual.value.lines.map((l) => l.check)).toEqual(['identite', 'financement', 'pret', 'validite']);
  });
});
