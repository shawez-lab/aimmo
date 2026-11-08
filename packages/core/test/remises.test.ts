import { describe, expect, it } from 'vitest';
import { Annuaire } from '../src/partenaires/annuaire.ts';
import { DISCOUNT_CATEGORIES, Remises, type DiscountInput } from '../src/remises/remises.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Fournisseurs, remises et partenaires inventés.
let n = 0;
class Proofs {
  private readonly refs = new Set<string>();
  put(id: string): string {
    const ref = `partenaires/${id}/00000000-0000-4000-8000-${String(++n).padStart(12, '0')}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

async function setup() {
  const t = await setupAnnonce({ twin: false }) // photos non certifiées : le photographe se propose;
  // Le 2027-02-12 à Paris : le mandat est signé et inscrit, l'annonce pas encore en vente.
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  const proofs = new Proofs();
  const annuaire = new Annuaire(t.db, proofs, t.journal, { now: t.now });
  let draw = 0.99;
  const remises = new Remises(t.db, t.acces, t.journal, { now: t.now, annuaire, random: () => draw });
  const base: DiscountInput = {
    category: 'photographe',
    supplier: 'Studio Exemple',
    beneficiary: 'agent',
    title: '20 % sur le reportage photo',
    terms: 'Sur présentation de la carte du réseau.',
    source: 'Contrat n° C-1 du 2027-01-05',
    moment: 'mandat',
    validFrom: '2027-01-01',
    validUntil: '2027-06-30',
  };
  const add = async (over: Partial<DiscountInput> = {}) => {
    const r = await remises.setDiscount(t.direction, { ...base, ...over });
    if (!r.ok) throw new Error(r.code);
    return r.discountId;
  };
  const partner = async (trade: string, postcodes = ['21000'], insuredUntil = '2027-12-31', certifiedUntil = '2027-12-31') => {
    const r = await annuaire.addPartner(t.direction, { trade, businessName: `${trade} Exemple`, postcodes });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.partnerId;
    const c = await annuaire.addCredential(t.direction, id, { kind: 'assurance_rcp', number: 'RCP-1', validFrom: '2027-01-01', validUntil: insuredUntil, proofRef: proofs.put(id) });
    if (!c.ok) throw new Error(c.code);
    if (trade === 'diagnostiqueur') {
      const d = await annuaire.addCredential(t.direction, id, { kind: 'certification_diagnostic', domain: 'dpe', number: 'CERT-1', validFrom: '2027-01-01', validUntil: certifiedUntil, proofRef: proofs.put(id) });
      if (!d.ok) throw new Error(d.code);
    }
    return id;
  };
  const ids = (s: { forAgent: { id: string }[]; forClient: { id: string }[] } | null) => (s ? [...s.forAgent, ...s.forClient].map((x) => x.id).sort() : []);
  const suggest = async () => {
    const r = await remises.suggestionsFor(t.agent, t.propertyId);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { ...t, remises, annuaire, add, partner, ids, suggest, setDraw: (v: number) => (draw = v) };
}

describe('HX08 · catégories', () => {
  it('[R76] ni courtier, ni banque, ni notaire : aucune remise de ceux qui ne peuvent rien donner à l’agent', () => {
    const cats = DISCOUNT_CATEGORIES.map((c) => c.category as string);
    for (const c of ['courtier', 'banque', 'notaire']) expect(cats).not.toContain(c);
  });
});

describeWithSqlite('HX08 · remises négociées', () => {
  it('[R266] la direction seule range une remise, toujours avec sa source et sa date de fin', async () => {
    const t = await setup();
    const base = { category: 'outil', supplier: 'Logiciel Exemple', beneficiary: 'agent', title: 'Trois mois offerts', terms: 'Code donné par la direction.', source: 'Courriel du 2027-01-10', moment: 'toujours', validFrom: '2027-01-01', validUntil: '2027-03-31' };
    expect(await t.remises.setDiscount(t.agent, base)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.remises.setDiscount(t.direction, { ...base, source: ' ' })).toEqual({ ok: false, rule: 'R266', code: 'sans_source' });
    expect(await t.remises.setDiscount(t.direction, { ...base, source: undefined })).toEqual({ ok: false, rule: 'R266', code: 'sans_source' });
    expect(await t.remises.setDiscount(t.direction, { ...base, validUntil: undefined })).toEqual({ ok: false, rule: 'R266', code: 'bad_date' });
    expect(await t.remises.setDiscount(t.direction, { ...base, validUntil: '2027-02-30' })).toEqual({ ok: false, rule: 'R266', code: 'bad_date' });
    expect(await t.remises.setDiscount(t.direction, { ...base, validFrom: '2027-04-01' })).toEqual({ ok: false, rule: 'R266', code: 'bad_date' });
    expect(await t.remises.setDiscount(t.direction, { ...base, validUntil: '2027-02-11' })).toEqual({ ok: false, rule: 'R266', code: 'deja_echue' });
    const ok = await t.remises.setDiscount(t.direction, base);
    expect(ok.ok).toBe(true);
    const refused = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse' AND data LIKE '%remises%'");
    expect(refused.length).toBe(1);
    // La base refuse aussi une remise sans date de fin, ou qui finit avant de commencer.
    await expect(
      t.db.run("INSERT INTO network_discounts (id, network_id, category, supplier, beneficiary, title, terms, source, moment, valid_from, valid_until, set_by, set_at) VALUES ('x', ?, 'outil', 'Ab', 'agent', 'Ab', 'Ab', 'Ab', 'toujours', '2027-02-01', '2027-01-01', 'd', 'n')", [t.network.id]),
    ).rejects.toThrow();
  });

  it('[R266] une remise échue disparaît seule le lendemain de sa date de fin, sans que personne n’agisse ; ni avant son début', async () => {
    const t = await setup();
    const tool = await t.add({ category: 'outil', moment: 'toujours', validUntil: '2027-02-28' });
    const later = await t.add({ category: 'formation', moment: 'toujours', validFrom: '2027-03-01', validUntil: '2027-04-30' });
    const photo = await t.add({ validUntil: '2027-02-28' });
    const cat = async () => {
      const r = await t.remises.catalogue(t.agent);
      if (!r.ok) throw new Error(r.code);
      return r.value.map((d) => d.id);
    };
    expect(await cat()).toEqual(expect.arrayContaining([tool, photo]));
    expect(await cat()).not.toContain(later);
    // Le 28 février à 23 h 30, heure de Paris : encore en vigueur.
    t.setClock(new Date('2027-02-28T22:30:00.000Z'));
    expect(await cat()).toContain(tool);
    expect(t.ids(await t.suggest())).toContain(photo);
    // Le 1er mars à 0 h 30, heure de Paris : échue, sans retrait, nulle part.
    t.setClock(new Date('2027-02-28T23:30:00.000Z'));
    expect(await cat()).not.toContain(tool);
    expect(await cat()).toContain(later);
    expect(t.ids(await t.suggest())).not.toContain(photo);
    const withdrawals = await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM network_discount_withdrawals');
    expect(Number(withdrawals!.n)).toBe(0);
  });

  it('[R266] un retrait par la direction l’ôte tout de suite, une seule fois ; rien ne change ni ne s’efface', async () => {
    const t = await setup();
    const id = await t.add();
    expect(await t.remises.withdraw(t.agent, id, 'Fournisseur parti')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.remises.withdraw(t.direction, id, 'Fournisseur parti')).toEqual({ ok: true });
    expect(await t.remises.withdraw(t.direction, id, 'Encore')).toEqual({ ok: false, rule: null, code: 'deja_retiree' });
    expect(t.ids(await t.suggest())).not.toContain(id);
    await expect(t.db.run("UPDATE network_discounts SET valid_until = '2099-12-31' WHERE id = ?", [id])).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM network_discounts WHERE id = ?', [id])).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('DELETE FROM network_discount_withdrawals WHERE discount_id = ?', [id])).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R76] une remise d’un diagnostiqueur, d’un déménageur ou d’un artisan ne profite jamais à l’agent, par le code et par la base', async () => {
    const t = await setup();
    const diag = await t.partner('diagnostiqueur');
    for (const category of ['diagnostiqueur', 'demenageur', 'artisan']) {
      expect(await t.remises.setDiscount(t.direction, { category, supplier: 'Exemple', partnerId: category === 'diagnostiqueur' ? diag : undefined, beneficiary: 'agent', title: 'Remise', terms: 'Pour l’agent.', source: 'Devis D-2', moment: 'mandat', validFrom: '2027-01-01', validUntil: '2027-06-30' })).toEqual({
        ok: false,
        rule: 'R76',
        code: 'client_seulement',
      });
    }
    await expect(
      t.db.run("INSERT INTO network_discounts (id, network_id, category, supplier, partner_id, beneficiary, title, terms, source, moment, valid_from, valid_until, set_by, set_at) VALUES ('y', ?, 'diagnostiqueur', 'Ab', ?, 'agent', 'Ab', 'Ab', 'Ab', 'mandat', '2027-01-01', '2027-06-01', 'd', 'n')", [t.network.id, diag]),
    ).rejects.toThrow();
    // Un diagnostiqueur vient de l'annuaire, avec ses certifications [R73].
    expect(await t.remises.setDiscount(t.direction, { category: 'diagnostiqueur', supplier: 'Exemple', beneficiary: 'client', title: 'Remise', terms: 'Pour le vendeur.', source: 'Devis D-2', moment: 'mandat', validFrom: '2027-01-01', validUntil: '2027-06-30' })).toEqual({
      ok: false,
      rule: null,
      code: 'partenaire_requis',
    });
    const photographer = await t.partner('photographe');
    expect((await t.remises.setDiscount(t.direction, { category: 'diagnostiqueur', supplier: 'Exemple', partnerId: photographer, beneficiary: 'client', title: 'Remise', terms: 'Pour le vendeur.', source: 'Devis D-2', moment: 'mandat', validFrom: '2027-01-01', validUntil: '2027-06-30' })).ok).toBe(false);
  });

  it('[R267] Jamais vu : au mandat inscrit, l’agent du bien reçoit le diagnostiqueur et le photographe, pas les remises d’un autre moment', async () => {
    const t = await setup();
    const diag = await t.partner('diagnostiqueur');
    const forDiag = await t.add({ category: 'diagnostiqueur', partnerId: diag, beneficiary: 'client', title: '15 % sur le dossier de diagnostics', terms: 'Pour le vendeur, sur devis.', source: 'Devis D-3' });
    const photo = await t.add();
    const onSale = await t.add({ category: 'home_staging', moment: 'en_vente' });
    const always = await t.add({ category: 'assurance', moment: 'toujours' });
    let s = await t.suggest();
    expect(s!.moment).toBe('mandat');
    expect(s!.forAgent.map((x) => x.id)).toEqual([photo]);
    expect(s!.forClient.map((x) => x.id)).toEqual([forDiag]);
    expect(s!.forClient[0]!.why).toBe('Mandat inscrit au registre, annonce pas encore en vente.');
    expect(t.ids(s)).not.toContain(onSale);
    expect(t.ids(s)).not.toContain(always);
    // Annonce validée puis publiée : le moment avance, lu dans la base.
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    s = await t.suggest();
    expect(s!.moment).toBe('en_vente');
    expect(t.ids(s)).toEqual([onSale]);
    // Annonce retirée sans dossier vivant : aucun moment sûr, rien n'est proposé, pas même au mandat.
    const seq = (await t.db.first<{ n: number }>('SELECT MAX(seq) AS n FROM listing_versions WHERE property_id = ?', [t.propertyId]))!.n;
    await t.db.run("INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES ('lv-retrait', ?, ?, ?, 'retiree', NULL, NULL, '{}', 'h', 'retrait', ?)", [t.propertyId, t.network.id, Number(seq) + 1, t.now().toISOString()]);
    expect(await t.suggest()).toBeNull();
  });

  it('[R267] un bien sans mandat inscrit est en estimation, celui au mandat inscrit est au mandat', async () => {
    const t = await setup();
    const est = await t.add({ category: 'formation', moment: 'estimation' });
    const b = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'REF-T-2', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 40, rooms: 2, priceEur: 150000 });
    const r = await t.remises.suggestionsFor(t.agent, b.id);
    expect(r.ok && r.value!.moment).toBe('estimation');
    expect(r.ok && r.value!.forAgent.map((x) => x.id)).toEqual([est]);
    expect(await t.remises.momentOf(t.network.id, t.propertyId)).toBe('mandat');
  });

  it('[R267] offre acceptée sans compromis commencé, compromis en préparation, puis acte : chaque moment a ses remises, et plus rien 90 jours après l’acte', async () => {
    const t = await setup();
    const compromis = await t.add({ category: 'demenageur', beneficiary: 'client', moment: 'compromis', validUntil: '2027-12-31' });
    const acte = await t.add({ category: 'artisan', beneficiary: 'client', moment: 'acte', validUntil: '2027-12-31' });
    const at = t.now().toISOString();
    await t.db.run(
      "INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES ('o1', ?, ?, 1, ?, 205000, '[]', '2027-02-20', 50000, 155000, 'offres/o1.pdf', ?, ?, ?, 'agent', '0', 'h1')",
      [t.network.id, t.propertyId, t.personId, at, t.alexId, at],
    );
    await t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('f1', ?, ?, 'o1', ?, 205000, ?, 'agent')", [t.network.id, t.propertyId, t.personId, at]);
    // Offre acceptée, compromis pas encore commencé : aucun moment sûr, rien n'est proposé.
    expect(await t.suggest()).toBeNull();
    await t.db.run("INSERT INTO sale_file_steps (file_id, step, at, by) VALUES ('f1', 'compromis_en_preparation', ?, 'agent')", [at]);
    let s = await t.suggest();
    expect(s!.moment).toBe('compromis');
    expect(t.ids(s)).toEqual([compromis]);
    await t.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES ('f1', ?, '2027-05-03', 'actes/f1.pdf', 'a_demarrer', ?, 'agent')", [t.network.id, at]);
    t.setClock(new Date('2027-05-04T10:00:00.000Z'));
    s = await t.suggest();
    expect(s!.moment).toBe('acte');
    expect(t.ids(s)).toEqual([acte]);
    t.setClock(new Date('2027-08-01T10:00:00.000Z'));
    expect(await t.suggest()).toBeNull();
  });

  it('[R267] un dossier arrêté ne compte pas : le second dossier ouvert du bien fait le moment, compromis puis acte', async () => {
    const t = await setup();
    const compromis = await t.add({ category: 'demenageur', beneficiary: 'client', moment: 'compromis', validUntil: '2027-12-31' });
    const acte = await t.add({ category: 'artisan', beneficiary: 'client', moment: 'acte', validUntil: '2027-12-31' });
    const at = t.now().toISOString();
    for (const [o, seq] of [['o1', 1], ['o2', 2]] as const) {
      await t.db.run(
        "INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES (?, ?, ?, ?, ?, 205000, '[]', '2027-02-20', 50000, 155000, ?, ?, ?, ?, 'agent', '0', ?)",
        [o, t.network.id, t.propertyId, seq, t.personId, `offres/${o}.pdf`, at, t.alexId, at, `h-${o}`],
      );
    }
    await t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('f1', ?, ?, 'o1', ?, 205000, '2027-02-12T09:00:00.000Z', 'agent')", [t.network.id, t.propertyId, t.personId]);
    await t.db.run("INSERT INTO sale_file_stops (file_id, network_id, reason, proof_ref, at, by) VALUES ('f1', ?, 'pret_refuse', 'arrets/f1.pdf', ?, 'agent')", [t.network.id, at]);
    expect(await t.remises.momentOf(t.network.id, t.propertyId)).toBe('mandat');
    await t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('f2', ?, ?, 'o2', ?, 205000, '2027-02-12T09:30:00.000Z', 'agent')", [t.network.id, t.propertyId, t.personId]);
    await t.db.run("INSERT INTO sale_file_steps (file_id, step, at, by) VALUES ('f1', 'compromis_en_preparation', ?, 'agent'), ('f2', 'compromis_en_preparation', ?, 'agent')", [at, at]);
    expect(t.ids(await t.suggest())).toEqual([compromis]);
    await t.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES ('f2', ?, '2027-05-03', 'actes/f2.pdf', 'a_demarrer', ?, 'agent')", [t.network.id, at]);
    t.setClock(new Date('2027-05-04T10:00:00.000Z'));
    expect(t.ids(await t.suggest())).toEqual([acte]);
  });

  it('[R267] [R73] un diagnostiqueur assuré mais sans certification valide ce jour-là n’est plus proposé', async () => {
    const t = await setup();
    const diag = await t.partner('diagnostiqueur', ['21000'], '2027-12-31', '2027-02-20');
    const id = await t.add({ category: 'diagnostiqueur', partnerId: diag, beneficiary: 'client', source: 'Devis D-8' });
    expect(t.ids(await t.suggest())).toContain(id);
    t.setClock(new Date('2027-02-21T10:00:00.000Z'));
    expect(t.ids(await t.suggest())).not.toContain(id);
  });

  it('[R267] [R73] un partenaire n’est proposé que justifié ce jour-là et dans la zone du bien ; le photographe, pas si les photos sont certifiées', async () => {
    const t = await setup();
    const elsewhere = await t.partner('diagnostiqueur', ['75001']);
    const lapsing = await t.partner('diagnostiqueur', ['21000'], '2027-02-20');
    const a = await t.add({ category: 'diagnostiqueur', partnerId: elsewhere, beneficiary: 'client', source: 'Devis D-4' });
    const b = await t.add({ category: 'diagnostiqueur', partnerId: lapsing, beneficiary: 'client', source: 'Devis D-5' });
    const photo = await t.add();
    let s = await t.suggest();
    expect(t.ids(s)).toEqual([b, photo].sort());
    expect(t.ids(s)).not.toContain(a);
    // L'assurance du diagnostiqueur échue : il n'est plus proposé.
    t.setClock(new Date('2027-02-21T10:00:00.000Z'));
    s = await t.suggest();
    expect(t.ids(s)).toEqual([photo]);
    await t.db.run(
      "INSERT INTO photo_certificates (id, token, property_id, network_id, result_ref, result_sha256, original_ref, original_sha256, operations, virtual_staging, processed_on, recorded_by, recorded_at) VALUES ('pc1', ?, ?, ?, 'r.jpg', ?, 'o.jpg', ?, '[]', 0, 'appareil', 'agent', ?)",
      ['t'.repeat(32), t.propertyId, t.network.id, 'a'.repeat(64), 'b'.repeat(64), t.now().toISOString()],
    );
    expect(t.ids(await t.suggest())).toEqual([]);
  });

  it('[R267] une remise écartée pour un bien n’y revient plus, et reste proposée pour un autre bien', async () => {
    const t = await setup();
    const est = await t.add({ category: 'formation', moment: 'estimation' });
    const photo = await t.add();
    expect(await t.remises.dismiss(t.agent, photo, t.propertyId)).toEqual({ ok: true });
    expect(await t.remises.dismiss(t.agent, photo, t.propertyId)).toEqual({ ok: true });
    expect(t.ids(await t.suggest())).toEqual([]);
    const other = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'REF-T-3', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 40, rooms: 2, priceEur: 150000 });
    const r = await t.remises.suggestionsFor(t.agent, other.id);
    expect(r.ok && r.value!.forAgent.map((x) => x.id)).toEqual([est]);
    await expect(t.db.run('DELETE FROM network_discount_dismissals')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R75] les remises pour le client arrivent dans un ordre tiré au sort, jamais un classement', async () => {
    const t = await setup();
    const one = await t.partner('diagnostiqueur');
    const two = await t.partner('diagnostiqueur');
    const a = await t.add({ category: 'diagnostiqueur', partnerId: one, beneficiary: 'client', source: 'Devis D-6' });
    const b = await t.add({ category: 'diagnostiqueur', partnerId: two, beneficiary: 'client', source: 'Devis D-7' });
    t.setDraw(0.99);
    const first = (await t.suggest())!.forClient.map((x) => x.id);
    t.setDraw(0);
    const second = (await t.suggest())!.forClient.map((x) => x.id);
    expect(first.slice().sort()).toEqual([a, b].sort());
    expect(second).toEqual(first.slice().reverse());
  });

  it('[R16] seul l’agent du bien voit ses remises ; un autre agent, la direction ou un agent parti sont refusés, au journal', async () => {
    const t = await setup();
    await t.add();
    expect(await t.remises.suggestionsFor(t.sam, t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.remises.suggestionsFor(t.direction, t.propertyId)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.remises.dismiss(t.sam, 'x', t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect(await t.remises.suggestionsFor(t.agent, t.propertyId)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.remises.catalogue(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    const refused = await t.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE type = 'acces.refuse' AND data LIKE '%remises%'");
    expect(Number(refused[0]!.n)).toBeGreaterThanOrEqual(4);
  });

  it('[R13] le journal des remises ne porte que des identifiants : ni fournisseur, ni titre, ni conditions', async () => {
    const t = await setup();
    const id = await t.add({ supplier: 'Studio Unique Exemple', title: 'Titre unique 42', terms: 'Conditions uniques' });
    await t.suggest();
    await t.remises.dismiss(t.agent, id, t.propertyId);
    await t.remises.withdraw(t.direction, id, 'Raison unique');
    const rows = await t.db.all<{ type: string; data: string; subject: string }>("SELECT type, data, subject FROM journal WHERE type LIKE 'remise.%'");
    expect(rows.map((r) => r.type).sort()).toEqual(['remise.ecartee', 'remise.proposee', 'remise.rangee', 'remise.retiree']);
    for (const r of rows) for (const word of ['Studio Unique', 'Titre unique', 'Conditions uniques', 'Raison unique', 'Léa']) expect(`${r.subject} ${r.data}`).not.toContain(word);
  });
});
