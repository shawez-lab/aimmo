import { expect, it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { DossiersVente, TransmissionOffres } from '../src/offres/index.ts';
import { partage } from '../src/index.ts';
import type { Viewer } from '../src/acces/droits.ts';
import { FakePieceStore, PROOF } from './dossiers-jeu.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const { PartageAgences, splitAgencyFee } = partage;

// Tout est inventé : le bien en vente du jeu de M07, une agence partenaire, son bon de délégation et une vente.
const BON = 'preuves/0b6f1d2e-8888-4a2b-8c3d-000000000001.pdf';
const FACTURE = 'preuves/0b6f1d2e-8888-4a2b-8c3d-000000000002.pdf';
const ACT_PROOF = 'preuves/0b6f1d2e-8888-4a2b-8c3d-000000000003.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

it('[R235] le partage des honoraires : part de l’agence au centime inférieur, la somme fait toujours les honoraires', () => {
  expect(splitAgencyFee(1_000_000, 5_000)).toEqual({ partnerCents: 500_000, ownCents: 500_000 });
  expect(splitAgencyFee(1_000_001, 3_333)).toEqual({ partnerCents: 333_300, ownCents: 666_701 });
  for (const [fee, bp] of [[0, 1], [1, 9_999], [999_999, 4_250], [12_345_678, 1]] as const) {
    const s = splitAgencyFee(fee, bp);
    expect(s.partnerCents + s.ownCents).toBe(fee);
    expect(s.partnerCents).toBeLessThanOrEqual(Math.floor((fee * bp) / 10_000));
  }
  for (const bad of [0, 10_000, -1, 12.5, Number.NaN]) expect(() => splitAgencyFee(1000, bad)).toThrow();
  expect(() => splitAgencyFee(10.5, 5000)).toThrow();
});

describeWithSqlite('HX01 · partage de biens entre agences et partage d’honoraires', () => {
  async function setup() {
    const t = await setupOffre();
    // L'annonce validée et publiée : le bien est en vente.
    await t.annonces.validate(t.agent, t.draftId);
    await t.publication.sync(t.network.id, t.propertyId);
    const proofs = new FakePieceStore();
    for (const ref of [BON, FACTURE, ACT_PROOF, PROOF]) proofs.refs.add(ref);
    const p = new PartageAgences(t.db, t.acces, t.journal, proofs, { now: t.now });
    const reg = await p.registerAgency(t.direction, { businessName: 'Agence du Lac Fictive', cardNumber: 'CPI 2101 2027 000 000 001' });
    if (!reg.ok) throw new Error(reg.code);
    const other = await p.registerAgency(t.direction, { businessName: 'Agence des Vignes Fictive', cardNumber: 'CPI 2101 2027 000 000 002' });
    if (!other.ok) throw new Error(other.code);
    const agency: Viewer = { role: 'partner', networkId: t.network.id, userId: reg.value.id };
    const stranger: Viewer = { role: 'partner', networkId: t.network.id, userId: other.value.id };
    const shared = await p.shareProperty(t.agent, t.propertyId, reg.value.id);
    if (!shared.ok) throw new Error(shared.code);
    const shareId = shared.value.shareId;
    /** Le bon proposé à 40 %, accepté, signé. */
    const signed = async (bp = 4_000) => {
      expect(await p.proposeDelegation(t.agent, shareId, { partnerShareBp: bp })).toMatchObject({ ok: true });
      expect(await p.acceptDelegation(agency, shareId)).toMatchObject({ ok: true });
      expect(await p.recordSigned(t.agent, shareId, { proofRef: BON, mandateAllowsDelegation: true })).toMatchObject({ ok: true });
    };
    /** L'acquéreur de l'agence fait une offre acceptée ; le dossier s'ouvre et se rattache à la délégation. */
    const openFile = async () => {
      const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
      const offer = await t.record();
      await transmission.transmit(t.agent, offer.id, { via: 'telephone' });
      t.setClock(new Date('2027-03-01T12:00:00.000Z'));
      const r = await transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
      if (!r.ok) throw new Error(r.code);
      const opened = await new DossiersVente(t.db, t.acces, t.journal, { now: t.now }).open(t.agent, offer.id);
      if (!opened.ok) throw new Error(opened.code);
      return opened.value.id;
    };
    return { ...t, p, proofs, agency, stranger, shareId, signed, openFile };
  }

  it('[R234] aucune co-visite avant la délégation signée, même proposée et acceptée, même par une écriture directe', async () => {
    const t = await setup();
    const wishedAt = '2027-03-02T14:00:00.000Z';
    expect(await t.p.requestVisit(t.agency, t.shareId, { wishedAt })).toEqual({ ok: false, rule: 'R234', code: 'delegation_non_signee' });
    expect(await t.p.proposeDelegation(t.agent, t.shareId, { partnerShareBp: 4_000 })).toMatchObject({ ok: true });
    expect(await t.p.requestVisit(t.agency, t.shareId, { wishedAt })).toEqual({ ok: false, rule: 'R234', code: 'delegation_non_signee' });
    // Pas de bon rangé sans l'accord de l'agence.
    expect(await t.p.recordSigned(t.agent, t.shareId, { proofRef: BON, mandateAllowsDelegation: true })).toEqual({ ok: false, rule: 'R234', code: 'not_accepted' });
    expect(await t.p.acceptDelegation(t.agency, t.shareId)).toMatchObject({ ok: true });
    expect(await t.p.requestVisit(t.agency, t.shareId, { wishedAt })).toEqual({ ok: false, rule: 'R234', code: 'delegation_non_signee' });
    // Même la base refuse une visite d'une délégation non signée.
    const d = (await t.db.first<{ id: string }>('SELECT id FROM agency_delegations'))!;
    await expect(
      t.db.run("INSERT INTO agency_visits (id, delegation_id, network_id, wished_at, requested_by, requested_at) VALUES ('v1', ?, ?, ?, 'x', 'x')", [d.id, t.network.id, wishedAt]),
    ).rejects.toThrow(/non signée/);
    await expect(t.db.run("INSERT INTO agency_delegation_steps (delegation_id, step, proof_ref, at, by) VALUES ('nope', 'signee', 'x', 'x', 'x')")).rejects.toThrow();
    // Ni un bon signé sans l'attestation du mandat, ni un dossier rattaché avant la signature, par une écriture directe.
    await expect(t.db.run("INSERT INTO agency_delegation_steps (delegation_id, step, proof_ref, at, by) VALUES (?, 'signee', 'x', 'x', 'x')", [d.id])).rejects.toThrow(/CHECK/);
    const fileId = await t.openFile();
    await expect(t.db.run("INSERT INTO agency_delegation_files (delegation_id, file_id, at, by) VALUES (?, ?, 'x', 'x')", [d.id, fileId])).rejects.toThrow(/non signée/);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    // Le bon signé, sans l'attestation de la clause du mandat, n'est pas rangé.
    expect(await t.p.recordSigned(t.agent, t.shareId, { proofRef: BON, mandateAllowsDelegation: false })).toEqual({ ok: false, rule: 'R234', code: 'mandate_clause' });
    expect(await t.p.recordSigned(t.agent, t.shareId, { proofRef: 'preuves/0b6f1d2e-8888-4a2b-8c3d-000000000099.pdf', mandateAllowsDelegation: true })).toEqual({ ok: false, rule: null, code: 'not_stored' });
    expect(await t.p.recordSigned(t.agent, t.shareId, { proofRef: BON, mandateAllowsDelegation: true })).toMatchObject({ ok: true });
    const visit = await t.p.requestVisit(t.agency, t.shareId, { wishedAt });
    expect(visit).toMatchObject({ ok: true });
    // Une autre agence ne demande rien sur ce partage ; un agent n'accepte pas à la place de l'agence.
    expect(await t.p.requestVisit(t.stranger, t.shareId, { wishedAt })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.p.acceptDelegation(t.agent, t.shareId)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.p.requestVisit(t.agency, t.shareId, { wishedAt: '2027-02-01T10:00:00.000Z' })).toEqual({ ok: false, rule: null, code: 'past_time' });
  });

  it('[R234] l’agence ne reçoit jamais de coordonnée du vendeur, ni avant ni après la signature de la délégation', async () => {
    const t = await setup();
    // Le vendeur du jeu, avec un mail et un téléphone inventés.
    const owner = (await t.db.first<{ person_id: string }>(
      "SELECT j.person_id FROM projects j JOIN project_properties pp ON pp.project_id = j.id WHERE pp.property_id = ? AND pp.role = 'owned'",
      [t.propertyId],
    ))!;
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.alexId, personId: owner.person_id, kind: 'email', value: 'lea.vendeuse@exemple.invalid' });
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.alexId, personId: owner.person_id, kind: 'phone', value: '+33600000042' });
    const person = (await t.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM persons WHERE id = ?', [owner.person_id]))!;
    const secrets = [person.first_name, person.last_name, 'lea.vendeuse@exemple.invalid', '+33600000042'];
    expect(secrets.length).toBeGreaterThan(0);
    const leaks = async () => {
      const seen = JSON.stringify([await t.p.sharedWithMe(t.agency), await t.p.progress(t.agency, t.shareId), await t.p.statement(t.agency, t.shareId)]);
      return secrets.filter((s) => seen.includes(s));
    };
    expect(await leaks()).toEqual([]);
    const before = await t.p.sharedWithMe(t.agency);
    expect(before).toMatchObject({ ok: true, value: [{ shareId: t.shareId, stage: 'partage' }] });
    if (!before.ok) throw new Error();
    expect(Object.keys(before.value[0]!).sort()).toEqual(['city', 'kind', 'postalCode', 'priceEur', 'reference', 'rooms', 'shareId', 'stage', 'surfaceM2']);
    await t.signed();
    expect(await leaks()).toEqual([]);
    // Une autre agence ne voit pas ce bien, un agent ne lit pas la liste d'une agence.
    expect(await t.p.sharedWithMe(t.stranger)).toEqual({ ok: true, value: [] });
    expect(await t.p.sharedWithMe(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Le journal ne porte ni nom ni montant [R13].
    const journal = JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('partage.')));
    expect(journal).toContain('partage.delegation');
    for (const s of secrets) expect(journal).not.toContain(s);
  });

  it('[R235] le partage du bon s’applique à la facture : relevé calculé à l’acte sur les honoraires dus, facture de l’agence au montant exact, une fois', async () => {
    const t = await setup();
    await t.signed(4_000);
    // Le partage proposé ne change plus, ni par l'application ni par la base.
    expect(await t.p.proposeDelegation(t.agent, t.shareId, { partnerShareBp: 1_000 })).toEqual({ ok: false, rule: 'R235', code: 'already_proposed' });
    await expect(t.db.run('UPDATE agency_delegations SET partner_share_bp = 1000')).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM agency_delegations')).rejects.toThrow(/rien ne s'efface/);
    const visit = await t.p.requestVisit(t.agency, t.shareId, { wishedAt: '2027-03-01T10:30:00.000Z' });
    if (!visit.ok) throw new Error(visit.code);
    const fileId = await t.openFile();
    expect(await t.p.visitDone(t.agent, t.shareId, visit.value.visitId)).toMatchObject({ ok: true });
    expect(await t.p.attachFile(t.agent, t.shareId, fileId)).toMatchObject({ ok: true });
    // Avant l'acte : aucun relevé, aucune facture.
    expect(await t.p.statement(t.agency, t.shareId)).toEqual({ ok: true, value: null });
    expect(await t.p.recordPartnerInvoice(t.direction, t.shareId, { ttcCents: 400_000, proofRef: FACTURE })).toEqual({ ok: false, rule: 'R235', code: 'no_statement' });
    // Compromis, pièces, acte.
    const dossiers = new DossiersVente(t.db, t.acces, t.journal, { now: t.now });
    const { identiteAuCoffre } = await import('./identite-coffre.ts');
    await identiteAuCoffre({ db: t.db, acces: t.acces, journal: t.journal, now: t.now }, t.agent, t.buyerId, { piece: 'passeport', seenAt: new Date('2027-03-01T11:30:00.000Z') });
    expect(await dossiers.startCompromis(t.agent, fileId)).toMatchObject({ ok: true });
    t.setClock(at9('2027-03-10'));
    await new Echeancier(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    const { PiecesDossier } = await import('../src/dossiers/index.ts');
    const storage = new FakePieceStore();
    storage.refs.add(ACT_PROOF);
    const pieces = new PiecesDossier(t.db, t.acces, t.journal, storage, { now: t.now });
    const s = await pieces.status(t.agent, fileId);
    if (!s.ok) throw new Error(s.code);
    let n = 0;
    for (const piece of s.value.missing) {
      n += 1;
      const ref = `dossiers/${fileId}/0b6f1d2e-5555-4a2b-8c3d-${String(n).padStart(12, '0')}.pdf`;
      storage.refs.add(ref);
      await pieces.add(t.agent, fileId, { piece, ref, issuedOn: '2027-03-05' });
    }
    t.setClock(at9('2027-06-11'));
    const acte = await new ActeVente(t.db, t.acces, t.journal, storage, { now: t.now }).record(t.agent, fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    expect(acte).toMatchObject({ ok: true, value: { commission: { feeEur: 10000 } } });
    // Le relevé : 40 % des honoraires dus, venus du mandat, jamais saisis.
    const expected = { feeCents: 1_000_000, partnerShareBp: 4_000, partnerCents: 400_000, ownCents: 600_000, partnerInvoiceReceivedOn: null };
    expect(await t.p.statement(t.agency, t.shareId)).toEqual({ ok: true, value: expected });
    expect(await t.p.statement(t.agent, t.shareId)).toEqual({ ok: true, value: expected });
    expect(await t.p.statement(t.stranger, t.shareId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    await expect(t.db.run('UPDATE agency_fee_statements SET partner_cents = 1')).rejects.toThrow(/rien ne change/);
    // Un relevé saisi à la main, à un autre partage ou d'autres honoraires, est refusé par la base.
    const dl = (await t.db.first<{ id: string }>('SELECT id FROM agency_delegations'))!;
    for (const [fee, partner] of [[1_000_000, 900_000], [2_000_000, 800_000], [1_000_000, 399_999]] as const) {
      await expect(
        t.db.run(
          "INSERT INTO agency_fee_statements (delegation_id, network_id, file_id, fee_cents, partner_share_bp, partner_cents, own_cents, computed_at) VALUES (?, ?, ?, ?, 4000, ?, ?, 'x')",
          [dl.id, t.network.id, fileId, fee, partner, fee - partner],
        ),
      ).rejects.toThrow(/non calculé/);
    }
    expect(dl.id).toBeTruthy();
    // La facture de l'agence : refusée à un autre montant, par l'application comme par la base.
    expect(await t.p.recordPartnerInvoice(t.direction, t.shareId, { ttcCents: 400_001, proofRef: FACTURE })).toEqual({ ok: false, rule: 'R235', code: 'montant_different' });
    const d = (await t.db.first<{ id: string }>('SELECT id FROM agency_delegations'))!;
    await expect(
      t.db.run("INSERT INTO agency_partner_invoices (delegation_id, network_id, proof_ref, ttc_cents, received_at, by) VALUES (?, ?, 'x', 1, 'x', 'x')", [d.id, t.network.id]),
    ).rejects.toThrow(/différent du relevé/);
    expect(await t.p.recordPartnerInvoice(t.agent, t.shareId, { ttcCents: 400_000, proofRef: FACTURE })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.p.recordPartnerInvoice(t.direction, t.shareId, { ttcCents: 400_000, proofRef: FACTURE })).toEqual({ ok: true, value: { receivedOn: '2027-06-11' } });
    expect(await t.p.recordPartnerInvoice(t.direction, t.shareId, { ttcCents: 400_000, proofRef: FACTURE })).toEqual({ ok: false, rule: 'R235', code: 'already_received' });
    expect(await t.p.statement(t.agency, t.shareId)).toEqual({ ok: true, value: { ...expected, partnerInvoiceReceivedOn: '2027-06-11' } });
    // Jamais vu : l'agence lit en direct où en est le dossier, daté, sans un nom ni un montant.
    const progress = await t.p.progress(t.agency, t.shareId);
    expect(progress).toMatchObject({ ok: true, value: { stage: 'acte_signe' } });
    if (!progress.ok) throw new Error();
    expect(progress.value.steps.map((s) => s.stage)).toEqual([
      'partage',
      'delegation_proposee',
      'delegation_acceptee',
      'delegation_signee',
      'visite_demandee',
      'visite_faite',
      'dossier_ouvert',
      'compromis_signe',
      'acte_signe',
    ]);
    expect(progress.value.steps.at(-2)).toEqual({ stage: 'compromis_signe', on: '2027-03-10' });
    expect(progress.value.steps.at(-1)).toEqual({ stage: 'acte_signe', on: '2027-06-10' });
    expect(JSON.stringify(progress.value)).not.toMatch(/Acheteur|Exemple|10000|205000/);
  });

  it('[R235] un dossier ne se rattache qu’une fois, à une délégation signée du même bien ; le bien vendu ailleurs se dit sans raison', async () => {
    const t = await setup();
    const fileId = await t.openFile();
    expect(await t.p.attachFile(t.agent, t.shareId, fileId)).toEqual({ ok: false, rule: 'R234', code: 'delegation_non_signee' });
    // Le bien n'est plus en vente : la fiche commune le dit, sans dire pourquoi.
    expect(await t.p.progress(t.agency, t.shareId)).toMatchObject({ ok: true, value: { stage: 'bien_indisponible' } });
    // Un bien sous offre ne se partage plus.
    const reg = await t.p.registerAgency(t.direction, { businessName: 'Agence du Port Fictive', cardNumber: 'CPI 2101 2027 000 000 003' });
    if (!reg.ok) throw new Error(reg.code);
    expect(await t.p.shareProperty(t.agent, t.propertyId, reg.value.id)).toEqual({ ok: false, rule: null, code: 'not_for_sale' });
    await t.signed();
    expect(await t.p.attachFile(t.agent, t.shareId, fileId)).toMatchObject({ ok: true });
    expect(await t.p.attachFile(t.agent, t.shareId, fileId)).toMatchObject({ ok: true });
    expect(await t.p.attachFile(t.agent, t.shareId, 'autre-dossier')).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    expect(await t.p.attachFile(t.sam, t.shareId, fileId)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R16] seule la direction range une agence, seul l’agent du bien partage, une carte connue n’est pas rangée deux fois', async () => {
    const t = await setup();
    expect(await t.p.registerAgency(t.agent, { businessName: 'Agence Exemple', cardNumber: 'CPI 2101 2027 000 000 009' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.p.registerAgency(t.direction, { businessName: 'Autre Exemple', cardNumber: 'cpi 2101 2027 000 000 001' })).toEqual({ ok: false, rule: null, code: 'already_known' });
    expect(await t.p.registerAgency(t.direction, { businessName: 'x', cardNumber: 'CPI 2101 2027 000 000 010' })).toEqual({ ok: false, rule: null, code: 'bad_name' });
    expect(await t.p.registerAgency(t.direction, { businessName: 'Agence Exemple', cardNumber: '<script>' })).toEqual({ ok: false, rule: null, code: 'bad_card' });
    expect(await t.p.shareProperty(t.sam, t.propertyId, t.stranger.userId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.p.shareProperty(t.direction, t.propertyId, t.stranger.userId)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.p.shareProperty(t.agent, t.propertyId, 'inconnue')).toEqual({ ok: false, rule: null, code: 'unknown_agency' });
    // Partager deux fois avec la même agence rend le même partage.
    expect(await t.p.shareProperty(t.agent, t.propertyId, t.agency.userId)).toEqual({ ok: true, value: { shareId: t.shareId } });
    expect(await t.p.proposeDelegation(t.agent, t.shareId, { partnerShareBp: 10_000 })).toEqual({ ok: false, rule: null, code: 'bad_share' });
    expect(await t.p.proposeDelegation(t.agency, t.shareId, { partnerShareBp: 5_000 })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.p.progress(t.stranger, t.shareId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.p.progress(t.direction, t.shareId)).toMatchObject({ ok: true, value: { stage: 'partage' } });
  });
});
