import { describe, expect, it } from 'vitest';
import { briefText, compareDraft, differenceText, parseDraftTerms, rateOn, verifyReading, type BriefTerms, type DraftTerms } from '../src/avant-contrat/index.ts';
import { RegistreOffres, hashOffer, parseConditions, rateText } from '../src/offres/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// AU079 · la condition de prêt garde son taux maximal et son type ; toute divergence du projet notarial est signalée.
// Biens, acquéreurs, montants et taux inventés.
const REF = 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000079.pdf';
const LOAN = { kind: 'pret', amountEur: 150000, durationMonths: 240, maxRateBp: 385, loanType: 'amortissable' } as const;

describe('AU079 · condition de prêt complète', () => {
  it('[R56] le taux maximal hors assurance et le type de prêt sont gardés, contrôlés et rangés dans un ordre fixe', () => {
    // Le constat : avant, une condition de prêt portant un taux était refusée, faute de champ pour le garder.
    expect(parseConditions([{ loanType: 'amortissable', maxRateBp: 385, durationMonths: 240, amountEur: 150000, kind: 'pret' }])).toEqual({ ok: true, value: [LOAN] });
    expect(JSON.stringify((parseConditions([{ loanType: 'amortissable', maxRateBp: 385, durationMonths: 240, amountEur: 150000, kind: 'pret' }]) as { value: unknown }).value)).toBe(JSON.stringify([LOAN]));
    // Facultatifs : une condition sans eux reste celle d'avant, au caractère près.
    expect(JSON.stringify((parseConditions([{ kind: 'pret', amountEur: 150000, durationMonths: 240 }]) as { value: unknown }).value)).toBe('[{"kind":"pret","amountEur":150000,"durationMonths":240}]');
    expect(parseConditions([{ ...LOAN, maxRateBp: 0 }])).toEqual({ ok: false, field: 'conditions.0.maxRateBp' });
    expect(parseConditions([{ ...LOAN, maxRateBp: 2001 }])).toEqual({ ok: false, field: 'conditions.0.maxRateBp' });
    expect(parseConditions([{ ...LOAN, maxRateBp: 3.85 }])).toEqual({ ok: false, field: 'conditions.0.maxRateBp' });
    expect(parseConditions([{ ...LOAN, maxRateBp: '3,85 %' }])).toEqual({ ok: false, field: 'conditions.0.maxRateBp' });
    expect(parseConditions([{ ...LOAN, loanType: 'consommation' }])).toEqual({ ok: false, field: 'conditions.0.loanType' });
    expect(parseConditions([{ ...LOAN, banque: 'Banque Exemple' }])).toEqual({ ok: false, field: 'conditions.0' });
    expect(rateText(385)).toBe('3,85 %');
    expect(rateText(400)).toBe('4,00 %');
    expect(rateText(5)).toBe('0,05 %');
  });

  it('[R510] la note au notaire reprend le taux maximal et le type déclarés dans l’offre', () => {
    const terms: BriefTerms = { priceEur: 205000, conditions: [LOAN], depositEur: 0, loanDeadline: '2027-04-30', deedBy: '2027-06-15' };
    expect(briefText(terms)).toContain("Conditions suspensives de l'offre acceptée : obtention du prêt amortissable de 150 000 € sur 240 mois, au taux nominal hors assurance de 3,85 % au plus.");
    // Sans taux ni type, la note d'avant, inchangée.
    expect(briefText({ ...terms, conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }] })).toContain('obtention du prêt de 150 000 € sur 240 mois.');
  });

  it('[R511] un taux ou un type qui diffère, manque ou s’ajoute dans le projet du notaire est signalé avec sa page', () => {
    const brief: BriefTerms = { priceEur: 205000, conditions: [LOAN], depositEur: 0, loanDeadline: '2027-04-30', deedBy: '2027-06-15' };
    const draft = (loan: Record<string, unknown>): DraftTerms => {
      const p = parseDraftTerms({ priceEur: { value: 205000, page: 2 }, conditions: [{ ...loan, page: 4 }], loanDeadline: { value: '2027-04-30', page: 4 }, deedBy: { value: '2027-06-15', page: 7 }, deposit: null });
      if (!p.ok) throw new Error(p.field);
      return p.value;
    };
    expect(compareDraft(brief, draft(LOAN))).toEqual([]);
    const higher = compareDraft(brief, draft({ ...LOAN, maxRateBp: 420 }));
    expect(higher).toEqual([{ field: 'condition.pret.maxRateBp', expected: '3,85 %', found: '4,20 %', page: 4, blocking: false }]);
    expect(differenceText(higher[0]!)).toBe("Condition suspensive « obtention du prêt », taux maximal hors assurance : 3,85 % dans l'offre acceptée et le dossier, 4,20 % dans le projet du notaire (page 4).");
    const { maxRateBp: _r, ...noRate } = LOAN;
    expect(compareDraft(brief, draft(noRate))).toEqual([{ field: 'condition.pret.maxRateBp', expected: '3,85 %', found: null, page: 4, blocking: false }]);
    const relais = compareDraft(brief, draft({ ...LOAN, loanType: 'relais' }));
    expect(relais).toEqual([{ field: 'condition.pret.loanType', expected: 'amortissable', found: 'relais', page: 4, blocking: false }]);
    expect(differenceText(relais[0]!)).toContain('« obtention du prêt », type de prêt : amortissable');
    // Une offre sans taux, un projet qui en impose un : l'acquéreur serait tenu par un plafond qu'il n'a pas signé.
    const { maxRateBp: _b, loanType: _t, ...plain } = LOAN;
    expect(compareDraft({ ...brief, conditions: [plain] }, draft({ ...plain, maxRateBp: 300 }))).toEqual([{ field: 'condition.pret.maxRateBp', expected: null, found: '3,00 %', page: 4, blocking: false }]);
    // Les deux sans taux ni type : rien, comme avant.
    expect(compareDraft({ ...brief, conditions: [plain] }, draft(plain))).toEqual([]);
  });

  it('[R511] la prélecture ne propose le taux et le type que s’ils se retrouvent sur la page citée', () => {
    expect(rateOn('au taux nominal maximum de 3,85 % hors assurance', 385)).toBe(true);
    expect(rateOn('taux maximum 3.85%', 385)).toBe(true);
    expect(rateOn('taux de 3,850 %', 385)).toBe(true);
    expect(rateOn('taux de 4 %', 400)).toBe(true);
    expect(rateOn('taux de 4,00 %', 400)).toBe(true);
    expect(rateOn('taux de 3,8 %', 380)).toBe(true);
    expect(rateOn('taux de 13,85 %', 385)).toBe(false);
    expect(rateOn('taux de 3,851 %', 385)).toBe(false);
    expect(rateOn('taux de 3,5 %', 300)).toBe(false);
    expect(rateOn('taux de 3,85', 385)).toBe(false);
    const page = "Le présent compromis est conclu sous la condition suspensive de l'obtention d'un prêt amortissable de 150 000 € sur 240 mois au taux nominal maximum de 3,85 % hors assurance.";
    const pages = ['Prix de vente : 205 000 €.', 'Page sans objet.', 'Page sans objet.', page];
    const ok = verifyReading(pages, { conditions: [{ ...LOAN, page: 4 }] });
    expect(ok.proposal.conditions).toEqual([{ ...LOAN, page: 4 }]);
    expect(ok.toRead).not.toContain('conditions');
    // Un taux inventé, ou un type qui n'est pas écrit sur la page : la condition est à lire par l'agent.
    for (const wrong of [{ maxRateBp: 350 }, { loanType: 'relais' }, { maxRateBp: 99999 }]) {
      const r = verifyReading(pages, { conditions: [{ ...LOAN, ...wrong, page: 4 }] });
      expect(r.proposal.conditions).toEqual([]);
      expect(r.toRead).toContain('conditions');
    }
  });
});

describeWithSqlite('AU079 · registre des offres et condition de prêt complète', () => {
  async function setup() {
    const t = await setupAnnonce();
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    const offres = new RegistreOffres(t.db, t.acces, t.journal, { now: t.now });
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
    const input = (patch: Record<string, unknown> = {}) => ({
      buyerPersonId: buyer.id,
      amountEur: 205000,
      conditions: [LOAN],
      validUntil: '2027-03-10',
      downPaymentEur: 70000,
      loanEur: 150000,
      signedRef: REF,
      receivedAt: '2027-03-01T09:00:00.000Z',
      ...patch,
    });
    return { ...t, offres, input };
  }

  it('[R56] l’offre garde son taux et son type, relus tels quels ; l’empreinte les couvre, le registre reste intact', async () => {
    const t = await setup();
    const a = await t.offres.record(t.agent, t.propertyId, t.input());
    expect(a).toMatchObject({ ok: true, value: { seq: 1, conditions: [LOAN] } });
    const b = await t.offres.record(t.agent, t.propertyId, t.input({ conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }] }));
    expect(b).toMatchObject({ ok: true, value: { seq: 2, conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }] } });
    const list = await t.offres.list(t.agent, t.propertyId);
    expect(list.ok && list.value[0]!.conditions).toEqual([LOAN]);
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 2 });
    // Le taux baissé après coup, en passant outre les garde-fous de la base : l'empreinte le trahit.
    await t.db.exec('DROP TRIGGER offer_register_sans_modification');
    await t.db.run('UPDATE offer_register SET conditions = ? WHERE seq = 1', [JSON.stringify([{ ...LOAN, maxRateBp: 300 }])]);
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: false, count: 2, brokenAt: 1, problem: 'hash' });
    // Une offre d'avant, sans taux : son empreinte se recalcule à l'identique.
    const row = await t.db.first<Record<string, unknown> & { hash: string }>('SELECT * FROM offer_register WHERE seq = 2');
    const { hash, ...rest } = row!;
    expect(await hashOffer(rest as never)).toBe(hash);
  });

  it('[R56] un rejeu avec la même clé et le même taux rend l’offre déjà enregistrée ; un autre taux est refusé', async () => {
    const t = await setup();
    const first = await t.offres.record(t.agent, t.propertyId, t.input({ requestKey: 'cle-au079-00000001' }));
    expect(first.ok).toBe(true);
    const again = await t.offres.record(t.agent, t.propertyId, t.input({ requestKey: 'cle-au079-00000001', conditions: [{ loanType: 'amortissable', maxRateBp: 385, durationMonths: 240, amountEur: 150000, kind: 'pret' }] }));
    expect(again).toMatchObject({ ok: true, value: { seq: 1 } });
    const other = await t.offres.record(t.agent, t.propertyId, t.input({ requestKey: 'cle-au079-00000001', conditions: [{ ...LOAN, maxRateBp: 400 }] }));
    expect(other).toMatchObject({ ok: false, code: 'request_key_reused' });
  });
});
