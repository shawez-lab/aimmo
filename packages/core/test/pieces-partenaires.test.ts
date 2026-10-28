import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Annuaire, EspacePartenaire, MiseEnRelation, PIECE_RULES, PiecesPartenaires, type ConsentProofStore } from '../src/partenaires/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agent, client, bien, dossier de vente et partenaires inventés.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);

class FakeStore implements ConsentProofStore {
  readonly refs = new Set<string>();
  put(prefix: string): string {
    const ref = `${prefix}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

async function setup(withSaleFile = true) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const files = new FakeStore();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 1 });
  const space = new EspacePartenaire(db, annuaire, relations, journal, { now });
  const pieces = new PiecesPartenaires(db, space, relations, files, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Client', lastName: 'Inventé' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'sell' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-1', kind: 'home', postalCode: '21000' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
  const buyer = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Acheteur', lastName: 'Inventé' });
  const buyProject = await store.createProject({ networkId: network.id, agentId: alex.id, personId: buyer.id, kind: 'buy' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: buyProject.id, propertyId: property.id, role: 'interested' });
  const other = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Autre', lastName: 'Inventé' });
  const otherProject = await store.createProject({ networkId: network.id, agentId: alex.id, personId: other.id, kind: 'buy' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: otherProject.id, propertyId: property.id, role: 'interested' });
  const saleFileId = 'dossier-vente-test';
  if (withSaleFile) {
    // Un dossier de vente inventé, rangé sans passer par M09 : seule son existence compte ici.
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, 'offre-test', ?, 200000, ?, 'agent:x')", [
      saleFileId,
      network.id,
      property.id,
      buyer.id,
      new Date(clock).toISOString(),
    ]);
    await db.exec('PRAGMA foreign_keys = ON');
  }
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  const partner = async (trade: string, domain?: string): Promise<string> => {
    const r = await annuaire.addPartner(dir, { trade, businessName: `Partenaire ${trade}`, postcodes: ['21000'] });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.partnerId;
    const kinds = { courtier: ['immatriculation_orias'], geometre: ['inscription_ordre'] }[trade] ?? [];
    for (const kind of ['assurance_rcp', ...kinds]) await annuaire.addCredential(dir, id, { kind, number: 'N-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) });
    if (domain && domain !== 'mesurage') await annuaire.addCredential(dir, id, { kind: 'certification_diagnostic', domain, number: 'C-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) });
    return id;
  };
  /** Une demande confiée à un partenaire, avec l'accord du client. */
  const request = async (trade: string, domain?: string, withProperty = true, projectId = project.id): Promise<{ partnerId: string; referralId: string }> => {
    const partnerId = await partner(trade, domain);
    const r = await relations.propose(agent, { projectId, trade, domain, propertyId: withProperty ? property.id : undefined, postcode: '21000' });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.referralId;
    const c = await relations.recordConsent(agent, id, { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${id}`) });
    if (!c.ok) throw new Error(c.code);
    await relations.entrust(agent, id);
    return { partnerId, referralId: id };
  };
  const deposit = (req: { partnerId: string; referralId: string }, sort: string, extra: Record<string, unknown> = {}) =>
    pieces.deposit({ role: 'partner', userId: req.partnerId, networkId: network.id }, req.referralId, { sort, ref: files.put(`partenaires/${req.partnerId}/relations/${req.referralId}`), sha256: SHA, issuedOn: day(-1), ...extra });
  return { db, journal, relations, pieces, network, agent, bea, dir, property, project, buyProject, otherProject, saleFileId, request, deposit, files, day };
}

describeWithSqlite('U05 · pièces des partenaires', () => {
  it('[R78] 5 demandes suivies jusqu’au bout : chaque pièce est rangée au bon endroit, sans erreur', async () => {
    const t = await setup();
    const diag = await t.request('diagnostiqueur', 'amiante');
    const notaire = await t.request('notaire');
    const courtier = await t.request('courtier', undefined, true, t.buyProject.id);
    const artisan = await t.request('artisan');
    const geometre = await t.request('geometre');
    const expected: [typeof diag, string, string, string, string | null][] = [
      [diag, 'amiante', 'property', t.property.id, 'amiante'],
      [notaire, 'titre_propriete', 'sale_file', t.saleFileId, 'titre_propriete'],
      [notaire, 'projet_compromis', 'sale_file', t.saleFileId, 'projet_compromis'],
      [courtier, 'offre_pret', 'financing', t.saleFileId, 'offre_pret'],
      [artisan, 'devis', 'referral', artisan.referralId, null],
      [geometre, 'bornage', 'property', t.property.id, 'bornage'],
    ];
    for (const [req, sort, destination, targetId, piece] of expected) {
      const r = await t.deposit(req, sort);
      expect(r, sort).toMatchObject({ ok: true, value: { sort, destination, targetId, piece, reason: 'rule', version: 1 } });
    }
    for (const req of [diag, notaire, courtier, artisan, geometre]) {
      expect((await t.relations.close(t.agent, req.referralId, 'terminee')).ok).toBe(true);
    }
    const queued = await t.db.all("SELECT id FROM partner_documents WHERE destination = 'agent_queue'");
    expect(queued).toHaveLength(0);
    expect(await t.db.all('SELECT id FROM partner_documents')).toHaveLength(6);
  });

  it('[R78] sans dossier de vente, un diagnostic va à la fiche du bien ; une pièce du notaire ou un accord de prêt vont à la file', async () => {
    const t = await setup(false);
    const diag = await t.request('diagnostiqueur', 'dpe');
    expect(await t.deposit(diag, 'dpe')).toMatchObject({ ok: true, value: { destination: 'property', targetId: t.property.id, piece: 'dpe' } });
    const notaire = await t.request('notaire');
    expect(await t.deposit(notaire, 'titre_propriete')).toMatchObject({ ok: true, value: { destination: 'agent_queue', targetId: t.project.id, reason: 'no_sale_file' } });
    const courtier = await t.request('courtier', undefined, true, t.buyProject.id);
    expect(await t.deposit(courtier, 'accord_principe')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'no_sale_file' } });
    const termites = await t.request('diagnostiqueur', 'termites');
    expect(await t.deposit(termites, 'termites')).toMatchObject({ ok: true, value: { destination: 'property', piece: 'termites' } });
  });

  it('[R78] une sorte inconnue, une sorte d’un autre métier ou d’un autre domaine va à la file, rangée nulle part', async () => {
    const t = await setup();
    const diag = await t.request('diagnostiqueur', 'amiante');
    expect(await t.deposit(diag, 'facture_mysterieuse')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'unknown_sort', piece: null } });
    expect(await t.deposit(diag, 'titre_propriete')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'sort_not_for_trade' } });
    expect(await t.deposit(diag, 'plomb')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'other_domain' } });
    const artisan = await t.request('artisan');
    expect(await t.deposit(artisan, 'offre_pret')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'sort_not_for_trade' } });
    const sansBien = await t.request('diagnostiqueur', 'gaz', false);
    expect(await t.deposit(sansBien, 'gaz')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'no_property' } });
    for (const rule of Object.values(PIECE_RULES)) expect(rule.trades.length).toBeGreaterThan(0);
  });

  it('[R78] une pièce n’entre jamais dans le dossier d’un client qui n’y est pas partie', async () => {
    const t = await setup();
    // Le prêt du vendeur n'est pas celui de l'acquéreur du dossier.
    const pretVendeur = await t.request('courtier');
    expect(await t.deposit(pretVendeur, 'offre_pret')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'not_party' } });
    // Un autre acquéreur intéressé par le bien n'est pas partie au dossier de vente.
    const pretAutre = await t.request('courtier', undefined, true, t.otherProject.id);
    expect(await t.deposit(pretAutre, 'offre_pret')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'not_party' } });
    const notaireAutre = await t.request('notaire', undefined, true, t.otherProject.id);
    expect(await t.deposit(notaireAutre, 'projet_acte')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'not_party' } });
    // Un diagnostic demandé par un acquéreur ne va pas à la fiche du bien d'un autre.
    const diagAutre = await t.request('diagnostiqueur', 'dpe', true, t.otherProject.id);
    expect(await t.deposit(diagAutre, 'dpe')).toMatchObject({ ok: true, value: { destination: 'agent_queue', reason: 'not_party' } });
    // L'acquéreur du dossier, lui, y est partie : sa pièce du notaire y va.
    const notaireAcquereur = await t.request('notaire', undefined, true, t.buyProject.id);
    expect(await t.deposit(notaireAcquereur, 'projet_acte')).toMatchObject({ ok: true, value: { destination: 'sale_file', targetId: t.saleFileId } });
  });

  it('[R15] une pièce d’identité, un document anti-blanchiment ou un RIB ne sont jamais acceptés', async () => {
    const t = await setup();
    const notaire = await t.request('notaire');
    for (const sort of ['piece_identite', 'anti_blanchiment', 'rib']) expect(await t.deposit(notaire, sort)).toEqual({ ok: false, rule: 'R15', code: 'forbidden_piece' });
    expect(await t.db.all('SELECT id FROM partner_documents')).toHaveLength(0);
  });

  it('[R77] un partenaire ne dépose que dans ses mises en relation confiées et ouvertes', async () => {
    const t = await setup();
    const a = await t.request('artisan');
    const b = await t.request('artisan');
    const r = await t.pieces.deposit({ role: 'partner', userId: b.partnerId, networkId: t.network.id }, a.referralId, { sort: 'devis', ref: t.files.put(`partenaires/${b.partnerId}/relations/${a.referralId}`), sha256: SHA, issuedOn: t.day(-1) });
    expect(r).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.pieces.deposit(t.agent, a.referralId, { sort: 'devis', ref: 'x', sha256: SHA, issuedOn: t.day(-1) })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    await t.relations.close(t.agent, a.referralId, 'terminee');
    expect(await t.deposit(a, 'devis')).toEqual({ ok: false, rule: 'R16', code: 'closed' });
  });

  it('[R17] une pièce remplacée reste ; rien ne change ni ne s’efface ; références et dates contrôlées', async () => {
    const t = await setup();
    const a = await t.request('photographe');
    expect(await t.deposit(a, 'devis')).toMatchObject({ value: { version: 1 } });
    expect(await t.deposit(a, 'devis')).toMatchObject({ value: { version: 2 } });
    await expect(t.db.run('DELETE FROM partner_documents')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE partner_documents SET destination = 'property'")).rejects.toThrow(/ne change plus/);
    expect(await t.deposit(a, 'devis', { ref: `partenaires/${a.partnerId}/relations/autre/${uuid()}.pdf` })).toMatchObject({ code: 'bad_ref' });
    expect(await t.deposit(a, 'devis', { ref: `partenaires/${a.partnerId}/relations/${a.referralId}/${uuid()}.pdf` })).toMatchObject({ code: 'not_stored' });
    expect(await t.deposit(a, 'devis', { sha256: 'zz' })).toMatchObject({ code: 'bad_sha256' });
    expect(await t.deposit(a, 'devis', { issuedOn: t.day(3) })).toMatchObject({ code: 'bad_date' });
    expect(await t.deposit(a, 'Devis!')).toMatchObject({ code: 'bad_sort' });
  });

  it('[R13] [R16] l’agent du projet voit les pièces et leur place ; le journal ne porte ni nom ni référence', async () => {
    const t = await setup();
    const a = await t.request('notaire');
    const r = await t.deposit(a, 'titre_propriete');
    const list = await t.pieces.placements(t.agent, a.referralId);
    expect(list.ok && list.value).toEqual([r.ok && r.value]);
    const bea = { role: 'agent' as const, userId: t.bea.id, networkId: t.network.id };
    expect(await t.pieces.placements(bea, a.referralId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const all = JSON.stringify(await t.db.all("SELECT * FROM journal WHERE type LIKE 'piece_partenaire.%'"));
    expect(all).toContain('sale_file');
    expect(all).not.toContain('partenaires/');
    expect(all).not.toContain(SHA);
  });
});
