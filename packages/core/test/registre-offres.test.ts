import { describe, expect, it } from 'vitest';
import { RegistreOffres, parseConditions } from '../src/offres/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Biens, acquéreurs et offres inventés.
const REF = 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000001.pdf';

describe('O01 · conditions suspensives', () => {
  it('liste fermée, une fois chacune, le prêt avec son montant et sa durée, dans un ordre fixe', () => {
    expect(parseConditions([{ kind: 'vente_autre_bien' }, { kind: 'pret', amountEur: 150000, durationMonths: 240 }])).toEqual({ ok: true, value: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }, { kind: 'vente_autre_bien' }] });
    expect(parseConditions([])).toEqual({ ok: true, value: [] });
    expect(parseConditions([{ kind: 'autre' }])).toEqual({ ok: true, value: [{ kind: 'autre' }] });
    expect(parseConditions([{ kind: 'autre', texte: 'au 12 rue des Essais' }])).toEqual({ ok: false, field: 'conditions.0' });
    expect(parseConditions([{ kind: 'divers' }])).toEqual({ ok: false, field: 'conditions.0' });
    expect(parseConditions([{ kind: 'pret' }])).toEqual({ ok: false, field: 'conditions.0.amountEur' });
    expect(parseConditions([{ kind: 'pret', amountEur: 1000, durationMonths: 0 }])).toEqual({ ok: false, field: 'conditions.0.durationMonths' });
    expect(parseConditions([{ kind: 'permis_construire' }, { kind: 'permis_construire' }])).toEqual({ ok: false, field: 'conditions.1' });
    expect(parseConditions([{ kind: 'permis_construire', note: '12 rue des Essais' }])).toEqual({ ok: false, field: 'conditions.0' });
    expect(parseConditions('pret')).toEqual({ ok: false, field: 'conditions' });
  });
});

describeWithSqlite('O01 · registre des offres', () => {
  async function setup() {
    const t = await setupAnnonce();
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    const offres = new RegistreOffres(t.db, t.acces, t.journal, { now: t.now });
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
    const input = (patch: Record<string, unknown> = {}) => ({
      buyerPersonId: buyer.id,
      amountEur: 205000,
      conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }],
      validUntil: '2027-03-10',
      downPaymentEur: 70000,
      loanEur: 150000,
      signedRef: REF,
      receivedAt: '2027-03-01T09:00:00.000Z',
      ...patch,
    });
    return { ...t, offres, buyerId: buyer.id, input };
  }

  it('[R56] chaque offre prend un numéro dans l’ordre, sans trou, liée à la précédente ; le registre se contrôle', async () => {
    const t = await setup();
    const a = await t.offres.record(t.agent, t.propertyId, t.input());
    const b = await t.offres.record(t.direction, t.propertyId, t.input({ amountEur: 210000, conditions: [] }));
    expect(a).toMatchObject({ ok: true, value: { seq: 1, amountEur: 205000 } });
    expect(b).toMatchObject({ ok: true, value: { seq: 2, amountEur: 210000, conditions: [] } });
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 2 });
    const list = await t.offres.list(t.agent, t.propertyId);
    expect(list.ok && list.value.map((o) => o.seq)).toEqual([1, 2]);
    // Deux enregistrements en même temps : deux numéros différents, sans trou.
    await Promise.all([t.offres.record(t.agent, t.propertyId, t.input()), t.offres.record(t.agent, t.propertyId, t.input())]);
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 4 });
  });

  it('[R56] une ligne modifiée, retirée ou réécrite après coup est détectée ; rien ne s’efface', async () => {
    const t = await setup();
    await t.offres.record(t.agent, t.propertyId, t.input());
    await t.offres.record(t.agent, t.propertyId, t.input({ amountEur: 215000 }));
    await t.offres.record(t.agent, t.propertyId, t.input({ amountEur: 220000 }));
    await expect(t.db.run('DELETE FROM offer_register')).rejects.toThrow(/ajout seul/);
    await expect(t.db.run('UPDATE offer_register SET amount_eur = 1')).rejects.toThrow(/ajout seul/);
    // Quelqu'un passe outre les garde-fous de la base et baisse le montant de la deuxième offre.
    await t.db.exec('DROP TRIGGER offer_register_sans_modification');
    await t.db.run('UPDATE offer_register SET amount_eur = 100000 WHERE seq = 2');
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: false, count: 3, brokenAt: 2, problem: 'hash' });
    // Il réécrit aussi les empreintes de toute la chaîne : l'ancre du journal le trahit.
    const { hashOffer, OFFER_GENESIS } = await import('../src/offres/index.ts');
    let prev = OFFER_GENESIS;
    for (const row of await t.db.all<Record<string, unknown> & { id: string; hash: string }>('SELECT * FROM offer_register WHERE property_id = ? ORDER BY seq', [t.propertyId])) {
      const { hash: _h, ...rest } = row;
      const hash = await hashOffer({ ...(rest as Record<string, unknown>), prev_hash: prev } as never);
      await t.db.run('UPDATE offer_register SET prev_hash = ?, hash = ? WHERE id = ?', [prev, hash, row.id]);
      prev = hash;
    }
    expect(await t.offres.check(t.propertyId)).toMatchObject({ ok: false, brokenAt: 2, problem: 'anchor' });
    // Une offre retirée du registre : le compte ne suit plus les ancres.
    await t.db.exec('DROP TRIGGER offer_register_sans_effacement');
    const u = await setup();
    await u.offres.record(u.agent, u.propertyId, u.input());
    await u.offres.record(u.agent, u.propertyId, u.input());
    await u.db.exec('DROP TRIGGER offer_register_sans_effacement');
    await u.db.run('DELETE FROM offer_register WHERE seq = 2');
    expect(await u.offres.check(u.propertyId)).toEqual({ ok: false, count: 1, brokenAt: 2, problem: 'sequence' });
    // Puis une offre normale reprend le rang 2 : deux ancres pour un même rang, l'offre effacée reste visible.
    await u.db.exec("CREATE TRIGGER offer_register_sans_effacement BEFORE DELETE ON offer_register BEGIN SELECT RAISE(ABORT, 'registre des offres en ajout seul'); END;");
    expect(await u.offres.record(u.agent, u.propertyId, u.input({ amountEur: 190000 }))).toMatchObject({ ok: true, value: { seq: 2 } });
    expect(await u.offres.check(u.propertyId)).toEqual({ ok: false, count: 2, brokenAt: 2, problem: 'anchor' });
  });

  it('[R56] une ancre manquée après une panne du journal est reprise au prochain enregistrement', async () => {
    const t = await setup();
    await t.offres.record(t.agent, t.propertyId, t.input());
    // Le journal tombe juste après l'inscription de la deuxième offre.
    const j = t.journal;
    const failing = { last: () => j.last(), all: () => j.all(), bySubject: (x: string) => j.bySubject(x), byPeriod: (a: string, b: string) => j.byPeriod(a, b), append: async () => { throw new Error('panne du journal'); } };
    const broken = new RegistreOffres(t.db, t.acces, failing, { now: t.now });
    await expect(broken.record(t.direction, t.propertyId, t.input({ amountEur: 207000 }))).rejects.toThrow();
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: false, count: 2, brokenAt: 2, problem: 'anchor' });
    // Le prochain enregistrement reprend l'ancre de la ligne intacte, puis inscrit la sienne.
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ amountEur: 209000 }))).toMatchObject({ ok: true, value: { seq: 3 } });
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 3 });
    const resumed = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'offre.enregistree' && (e.data as { resumed?: boolean }).resumed);
    expect(resumed.map((e) => (e.data as { seq: number }).seq)).toEqual([2]);
  });

  it('une offre sans montant, sans validité ou avec une condition hors liste est refusée, le champ nommé', async () => {
    const t = await setup();
    const bad = async (patch: Record<string, unknown>) => t.offres.record(t.agent, t.propertyId, t.input(patch));
    expect(await bad({ amountEur: undefined })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'amountEur' });
    expect(await bad({ amountEur: 205000.5 })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'amountEur' });
    expect(await bad({ validUntil: undefined })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'validUntil' });
    expect(await bad({ validUntil: '2027-02-28' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'validUntil' });
    expect(await bad({ validUntil: '2029-03-02' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'validUntil' });
    expect(await bad({ validUntil: '2027-02-31' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'validUntil' });
    expect(await bad({ conditions: [{ kind: 'financement_parents' }] })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'conditions.0' });
    expect(await bad({ receivedAt: '2027-03-02T09:00:00.000Z' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'receivedAt' });
    expect(await bad({ receivedAt: '2027-03-01T09:00' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'receivedAt' });
    expect(await bad({ signedRef: 'offres/12-rue-des-Essais.pdf' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'signedRef' });
    expect(await bad({ loanEur: -1 })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'loanEur' });
    expect(await bad({ buyerPersonId: 'personne-inconnue' })).toEqual({ ok: false, rule: null, code: 'unknown_buyer' });
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 0 });
  });

  it('[R42] un bien qui ne peut pas être diffusé ne reçoit pas d’offre', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-20T10:00:00.000Z')); // pendant le délai de rétractation
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ receivedAt: '2027-02-20T09:00:00.000Z', validUntil: '2027-02-27' }))).toEqual({ ok: false, rule: 'R42', code: 'not_on_sale' });
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    for (const status of ['sold', 'rented', 'withdrawn']) {
      await t.db.run('UPDATE properties SET status = ? WHERE id = ?', [status, t.propertyId]);
      expect(await t.offres.record(t.agent, t.propertyId, t.input()), status).toEqual({ ok: false, rule: 'R42', code: 'not_on_sale' });
    }
    await t.db.run("UPDATE properties SET status = 'under_offer' WHERE id = ?", [t.propertyId]);
    expect(await t.offres.record(t.agent, t.propertyId, t.input())).toMatchObject({ ok: true });
  });

  it('[R16] seuls l’agent du bien et la direction enregistrent et lisent ; chaque refus au journal', async () => {
    const t = await setup();
    expect(await t.offres.record(t.sam, t.propertyId, t.input())).toMatchObject({ ok: false, rule: 'R16' });
    const compliance = { role: 'compliance', userId: 'c-1', networkId: t.network.id } as never;
    expect(await t.offres.record(compliance, t.propertyId, t.input())).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.offres.list(t.sam, t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    // Un acquéreur suivi par un autre agent : l'agent du bien ne le voit pas ; sans partage du collègue (AU081), l'offre passe par la direction.
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.userId, firstName: 'Autre', lastName: 'Exemple' });
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ buyerPersonId: other.id }))).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.offres.record(t.direction, t.propertyId, t.input({ buyerPersonId: other.id }))).toMatchObject({ ok: true });
    const refusals = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(4);
  });

  it('[R13] le journal porte le rang et l’ancre, ni montant ni nom', async () => {
    const t = await setup();
    await t.offres.record(t.agent, t.propertyId, t.input());
    const e = (await t.journal.bySubject(`property:${t.propertyId}`)).find((x) => x.type === 'offre.enregistree')!;
    expect(Object.keys(e.data as object).sort()).toEqual(['anchor', 'rule', 'seq']);
    expect(JSON.stringify(e.data)).not.toMatch(/205000|150000|Acheteur|Exemple|\d{6,}/);
  });
});
