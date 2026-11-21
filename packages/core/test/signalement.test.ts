import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ControleEnvois, DecisionEnvoi, FakeChannel, FicheUnique, SqlSendJournal, conformite, verifyChain, type Channel, type Viewer } from '../src/index.ts';
import { RegistreOffres } from '../src/offres/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { describeWithSqlite } from './sqlite.ts';

// Clients, dossier, agents et responsable inventés. Un mardi de mars, à 10 h à Paris.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const NOTE = 'Paiement proposé en espèces, sans explication.';

async function setup(options: { dispositif?: boolean } = {}) {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const signalement = new conformite.SignalementSoupcon(t.db, t.acces, t.journal, { now: t.now });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  // Le contrôle central des envois, avec un faux canal par canal.
  const fiche = new FicheUnique(t.db, t.store, { now: t.now });
  const decisions = new DecisionEnvoi(t.db, t.store, fiche, { now: t.now });
  const outbox = (['email', 'sms'] as Channel[]).map((c) => new FakeChannel(c));
  const controle = new ControleEnvois(t.db, fiche, decisions, { channels: outbox, journal: new SqlSendJournal(t.db), budget: { allows: async () => false }, now: t.now });
  await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'lea.exemple@example.test' });
  await t.store.addConsent({ networkId: t.network.id, personId: t.personId, purpose: 'follow_up', channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  const mandateRef = `mandate:${t.mandateId}`;
  // AU089 · le responsable nommé par la direction, et la procédure approuvée (inventés) : sans eux, personne ne lit.
  const dispositif = new conformite.DispositifLcb(t.db, t.journal, { now: t.now });
  if (options.dispositif !== false) await dispositif.designate(t.direction, 'conformite-1');
  if (options.dispositif !== false) await dispositif.approveProcedure(t.direction, { documentRef: 'procedures/lcb-v1.pdf', documentSha256: 'a'.repeat(64), approvedBy: 'Avocat Essai', approvedOn: '2027-03-01' });
  return { ...t, signalement, controle, outbox, mandateRef, dispositif, as, conformite: as('compliance', 'conformite-1'), partner: as('partner', 'partenaire-1') };
}

describeWithSqlite('L05 · signaler au responsable', () => {
  it('[R94] [R16] AU089 · dossier témoin : sans responsable nommé personne ne lit ; nommé, lui seul ; sans procédure approuvée, il ne décide pas', async () => {
    const t = await setup({ dispositif: false });
    // L'agent signale toujours : le dossier est figé et attend le responsable.
    expect(await t.signalement.report(t.agent, t.mandateRef, { note: NOTE })).toEqual({ ok: true, status: 'transmis' });
    // Le constat : n'importe quel compte de conformité lisait et décidait, sans responsable nommé ni procédure.
    expect(await t.signalement.list(t.conformite)).toEqual({ ok: false, rule: 'R16', code: 'pas_de_responsable' });
    expect(await t.dispositif.status(t.direction)).toEqual({ ok: true, value: { officer: null, procedure: null, ready: false } });
    // La direction seule nomme ; l'identifiant est contrôlé.
    expect(await t.dispositif.designate(t.agent, 'conformite-1')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.dispositif.designate(t.direction, 'un nom avec espaces')).toEqual({ ok: false, rule: null, code: 'bad_officer' });
    expect((await t.dispositif.designate(t.direction, 'conformite-1')).ok).toBe(true);
    // Un autre compte de conformité ne lit rien.
    expect(await t.signalement.list(t.as('compliance', 'conformite-2'))).toEqual({ ok: false, rule: 'R16', code: 'pas_responsable' });
    const list = await t.signalement.list(t.conformite);
    const id = list.ok ? list.value[0]!.reportId : '';
    expect(list.ok && list.value).toHaveLength(1);
    const decision = { decision: 'pas_de_declaration', reason: 'Explication écrite reçue (essai).', validatorName: 'Responsable Essai' };
    expect(await t.signalement.decide(t.conformite, id, decision)).toEqual({ ok: false, rule: 'R16', code: 'procedure_non_approuvee' });
    // La procédure approuvée : version, document, avocat, jour ; jamais dans le futur.
    const proc = { documentRef: 'procedures/lcb-v1.pdf', documentSha256: 'b'.repeat(64), approvedBy: 'Avocat Essai', approvedOn: '2027-03-01' };
    expect(await t.dispositif.approveProcedure(t.direction, { ...proc, approvedOn: '2099-01-01' })).toEqual({ ok: false, rule: null, code: 'bad_day' });
    expect(await t.dispositif.approveProcedure(t.direction, { ...proc, documentSha256: 'x' })).toEqual({ ok: false, rule: null, code: 'bad_document' });
    const ready = await t.dispositif.approveProcedure(t.direction, proc);
    expect(ready).toMatchObject({ ok: true, value: { officer: { userId: 'conformite-1' }, procedure: { version: 1, approvedBy: 'Avocat Essai', approvedOn: '2027-03-01' }, ready: true } });
    expect((await t.signalement.decide(t.conformite, id, decision)).ok).toBe(true);
    // Une nouvelle nomination remplace l'ancienne : l'ancien responsable ne lit plus.
    await t.dispositif.designate(t.direction, 'conformite-2');
    expect(await t.signalement.list(t.conformite)).toEqual({ ok: false, rule: 'R16', code: 'pas_responsable' });
    expect((await t.signalement.list(t.as('compliance', 'conformite-2'))).ok).toBe(true);
    // Rien ne change ni ne s'efface [R17].
    await expect(t.db.run("UPDATE lcb_officers SET officer_user_id = 'x'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM lcb_procedures')).rejects.toThrow();
  });

  it('[R94] [R16] seul le responsable voit le signalement ; l’agent qui l’a fait voit seulement « transmis »', async () => {
    const t = await setup();
    expect(await t.signalement.report(t.agent, t.mandateRef, { note: NOTE })).toEqual({ ok: true, status: 'transmis' });
    // Un autre agent, la direction, un partenaire : refusés, sans savoir si un signalement existe.
    for (const viewer of [t.sam, t.direction, t.partner]) {
      const r = await t.signalement.report(viewer, t.mandateRef, { note: NOTE });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('transmis');
      expect(await t.signalement.list(viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect(await t.signalement.list(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Le responsable le voit sans délai, avec la note de l'agent, en attente de sa décision.
    const list = await t.signalement.list(t.conformite);
    expect(list).toMatchObject({ ok: true, value: [{ caseRef: t.mandateRef, personId: t.personId, note: NOTE, reportedBy: `agent:${t.alexId}`, decision: null }] });
    expect(list.ok && list.value[0]!.lines).toBeGreaterThan(3);
    // Entrées refusées.
    expect(await t.signalement.report(t.agent, 'mandate:x', { note: NOTE })).toEqual({ ok: false, rule: null, code: 'bad_case' });
    expect(await t.signalement.report(t.agent, t.mandateRef, { note: ' ' })).toEqual({ ok: false, rule: null, code: 'bad_note' });
    expect(await t.signalement.report(t.agent, 'offer:00000000-0000-4000-8000-000000000000', { note: NOTE })).toEqual({ ok: false, rule: null, code: 'unknown_case' });
  });

  it('[R94] [R17] le dossier est figé : le responsable voit tout changement et toute pièce disparue', async () => {
    const t = await setup();
    await t.signalement.report(t.agent, t.mandateRef, { note: NOTE });
    const id = (await t.signalement.list(t.conformite)).ok ? ((await t.signalement.list(t.conformite)) as { value: conformite.SuspicionReport[] }).value[0]!.reportId : '';
    expect(await t.signalement.checkFrozen(t.conformite, id)).toEqual({ ok: true, value: { intact: true, changed: [], missing: [], added: [] } });
    // Une ligne ajoutée après ne change pas la copie figée ; une ligne changée, si.
    await t.amend(210000);
    const after = await t.signalement.checkFrozen(t.conformite, id);
    expect(after).toMatchObject({ ok: true, value: { intact: true, changed: [], missing: [] } });
    expect(after.ok && after.value.added.map((a) => a.table)).toEqual(expect.arrayContaining(['documents', 'signed_amendments']));
    // Une modification forcée en base, protections retirées : la copie figée la voit.
    await t.db.exec('DROP TRIGGER IF EXISTS mandates_fige');
    await t.db.run("UPDATE mandates SET source_detail = 'modifié' WHERE id = ?", [t.mandateId]);
    expect(await t.signalement.checkFrozen(t.conformite, id)).toMatchObject({ ok: true, value: { intact: false, changed: [{ table: 'mandates', key: t.mandateId }], missing: [] } });
    // Une pièce du coffre effacée de force est dite disparue.
    const piece = (await t.db.first<{ id: string }>('SELECT id FROM compliance_vault_pieces WHERE person_id = ?', [t.personId]))!.id;
    await t.db.exec('DROP TRIGGER IF EXISTS compliance_vault_pieces_sans_effacement');
    await t.db.run('DELETE FROM compliance_vault_pieces WHERE id = ?', [piece]);
    expect(await t.signalement.checkFrozen(t.conformite, id)).toMatchObject({ ok: true, value: { intact: false, missing: [{ table: 'compliance_vault_pieces', key: piece }] } });
    expect(await t.signalement.checkFrozen(t.agent, id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Rien ne s'efface ni ne change du signalement.
    await expect(t.db.run('DELETE FROM suspicion_reports')).rejects.toThrow('signalement gardé');
    await expect(t.db.run("UPDATE suspicion_reports SET note = 'x'")).rejects.toThrow('signalement gardé');
  });

  it('[R94] [R17] une offre ou un dossier de vente figent aussi le mandat, le vendeur et leur conformité', async () => {
    const t = await setup();
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
    const offer = await new RegistreOffres(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.propertyId, {
      buyerPersonId: buyer.id, amountEur: 195000, conditions: [], validUntil: '2027-03-20', downPaymentEur: 195000, loanEur: 0,
      signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000001.pdf', receivedAt: '2027-03-09T08:00:00.000Z',
    });
    if (!offer.ok) throw new Error(offer.code);
    const fileId = '0b6f1d2e-9999-4a2b-8c3d-000000000009';
    await t.db.run(
      'INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [fileId, t.network.id, t.propertyId, offer.value.id, buyer.id, 195000, NOW.toISOString(), `agent:${t.alexId}`],
    );
    const sellerPiece = (await t.db.first<{ id: string }>('SELECT id FROM compliance_vault_pieces WHERE person_id = ?', [t.personId]))!.id;
    for (const ref of [`offer:${offer.value.id}`, `sale_file:${fileId}`]) {
      expect(await t.signalement.report(t.agent, ref, { note: NOTE })).toEqual({ ok: true, status: 'transmis' });
    }
    const list = await t.signalement.list(t.conformite);
    if (!list.ok) throw new Error(list.code);
    const onOffer = list.value.find((r) => r.caseRef.startsWith('offer:'));
    const onFile = list.value.find((r) => r.caseRef.startsWith('sale_file:'));
    expect(onOffer).toMatchObject({ caseRef: `offer:${offer.value.id}`, personId: buyer.id });
    expect(onFile).toMatchObject({ caseRef: `sale_file:${fileId}`, personId: buyer.id });
    for (const r of [onOffer!, onFile!]) expect(await t.signalement.checkFrozen(t.conformite, r.reportId)).toMatchObject({ ok: true, value: { intact: true } });
    // L'offre d'origine changée de force : le dossier de vente le voit, comme l'offre.
    await t.db.exec('DROP TRIGGER IF EXISTS offer_register_sans_modification');
    await t.db.run('UPDATE offer_register SET amount_eur = 150000 WHERE id = ?', [offer.value.id]);
    for (const r of [onOffer!, onFile!]) {
      expect(await t.signalement.checkFrozen(t.conformite, r.reportId)).toMatchObject({ ok: true, value: { intact: false, changed: [{ table: 'offer_register', key: offer.value.id }] } });
    }
    // La pièce du vendeur effacée de force : le dossier de vente le voit aussi.
    await t.db.exec('DROP TRIGGER IF EXISTS compliance_vault_pieces_sans_effacement');
    await t.db.run('DELETE FROM compliance_vault_pieces WHERE id = ?', [sellerPiece]);
    const check = await t.signalement.checkFrozen(t.conformite, onFile!.reportId);
    expect(check.ok && check.value.missing).toContainEqual({ table: 'compliance_vault_pieces', key: sellerPiece });
  });

  it('[R94] [R17] RC36 · un mandat fige les offres du bien, leurs dossiers de vente et leurs acquéreurs ; une offre fige sa vente', async () => {
    const t = await setup();
    const registre = new RegistreOffres(t.db, t.acces, t.journal, { now: t.now });
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
    const buyerPiece = await identiteAuCoffre(t, t.agent, buyer.id, { piece: 'carte_identite', seenAt: NOW });
    if (!buyerPiece.ok) throw new Error(buyerPiece.code);
    const offerOn = async (propertyId: string, personId: string, n: number) => {
      const r = await registre.record(t.agent, propertyId, {
        buyerPersonId: personId, amountEur: 195000, conditions: [], validUntil: '2027-03-20', downPaymentEur: 195000, loanEur: 0,
        signedRef: `offres/0b6f1d2e-1111-4a2b-8c3d-00000000000${n}.pdf`, receivedAt: '2027-03-09T08:00:00.000Z',
      });
      if (!r.ok) throw new Error(r.code);
      return r.value.id;
    };
    const offerId = await offerOn(t.propertyId, buyer.id, 1);
    // L'offre d'un autre bien du même agent, avec un autre acquéreur : hors du dossier du mandat.
    const other = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'REF-T-2', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 40, rooms: 2, priceEur: 150000 });
    const stranger = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Autre', lastName: 'Exemple' });
    const otherOffer = '0b6f1d2e-2222-4a2b-8c3d-000000000002';
    await t.db.run(
      "INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES (?, ?, ?, 1, ?, 140000, '[]', '2027-03-20', 140000, 0, 'offres/autre.pdf', ?, ?, ?, ?, 'genese', 'empreinte-autre-bien')",
      [otherOffer, t.network.id, other.id, stranger.id, NOW.toISOString(), t.alexId, NOW.toISOString(), `agent:${t.alexId}`],
    );
    const fileId = '0b6f1d2e-9999-4a2b-8c3d-000000000009';
    await t.db.run(
      'INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [fileId, t.network.id, t.propertyId, offerId, buyer.id, 195000, NOW.toISOString(), `agent:${t.alexId}`],
    );
    for (const ref of [t.mandateRef, `offer:${offerId}`]) expect(await t.signalement.report(t.agent, ref, { note: NOTE })).toEqual({ ok: true, status: 'transmis' });
    const list = await t.signalement.list(t.conformite);
    if (!list.ok) throw new Error(list.code);
    const onMandate = list.value.find((r) => r.caseRef === t.mandateRef)!;
    const onOffer = list.value.find((r) => r.caseRef === `offer:${offerId}`)!;
    for (const r of [onMandate, onOffer]) expect(await t.signalement.checkFrozen(t.conformite, r.reportId)).toEqual({ ok: true, value: { intact: true, changed: [], missing: [], added: [] } });
    // Une offre arrivée après le signalement n'est pas dans le périmètre de ce jour : la copie figée reste intacte.
    await offerOn(t.propertyId, buyer.id, 3);
    expect(await t.signalement.checkFrozen(t.conformite, onMandate.reportId)).toEqual({ ok: true, value: { intact: true, changed: [], missing: [], added: [] } });
    // Le dossier de vente changé de force : le mandat et l'offre le voient.
    await t.db.exec('DROP TRIGGER IF EXISTS sale_files_sans_modification');
    for (const trigger of (await t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sale_files'"))) await t.db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    await t.db.run('UPDATE sale_files SET amount_eur = 150000 WHERE id = ?', [fileId]);
    for (const r of [onMandate, onOffer]) {
      expect(await t.signalement.checkFrozen(t.conformite, r.reportId)).toMatchObject({ ok: true, value: { intact: false, changed: [{ table: 'sale_files', key: fileId }] } });
    }
    // La pièce du coffre de l'acquéreur effacée de force : le mandat le voit.
    await t.db.exec('DROP TRIGGER IF EXISTS compliance_vault_pieces_sans_effacement');
    await t.db.run('DELETE FROM compliance_vault_pieces WHERE id = ?', [buyerPiece.id]);
    const check = await t.signalement.checkFrozen(t.conformite, onMandate.reportId);
    expect(check.ok && check.value.missing).toContainEqual({ table: 'compliance_vault_pieces', key: buyerPiece.id });
    // L'offre de l'autre bien changée de force : ni le mandat ni l'offre ne le voient.
    for (const trigger of (await t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'offer_register'"))) await t.db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    await t.db.run('UPDATE offer_register SET amount_eur = 100000 WHERE id = ?', [otherOffer]);
    for (const r of [onMandate, onOffer]) {
      const c = await t.signalement.checkFrozen(t.conformite, r.reportId);
      if (!c.ok) throw new Error(c.code);
      expect([...c.value.changed, ...c.value.missing, ...c.value.added].map((l) => l.key)).not.toContain(otherOffer);
    }
  });

  it('[R94] RC36 · un bien aux 120 offres se fige en lots de 100 valeurs au plus (limite de D1)', async () => {
    const t = await setup();
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
    const offers = Array.from({ length: 120 }, (_, i) => `0b6f1d2e-3333-4a2b-8c3d-${String(i).padStart(12, '0')}`);
    for (const [i, id] of offers.entries()) {
      await t.db.run(
        "INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES (?, ?, ?, ?, ?, 190000, '[]', '2027-03-20', 190000, 0, 'offres/lot.pdf', ?, ?, ?, ?, 'genese', ?)",
        [id, t.network.id, t.propertyId, i + 1, buyer.id, NOW.toISOString(), t.alexId, NOW.toISOString(), `agent:${t.alexId}`, `empreinte-${i}`],
      );
    }
    let max = 0;
    const strict = Object.create(t.db) as typeof t.db;
    const guard = (params: readonly unknown[] | undefined) => {
      max = Math.max(max, params?.length ?? 0);
      if ((params?.length ?? 0) > 100) throw new Error('too many SQL variables');
    };
    strict.all = async (sql, params) => (guard(params), t.db.all(sql, params));
    strict.first = async (sql, params) => (guard(params), t.db.first(sql, params));
    strict.run = async (sql, params) => (guard(params), t.db.run(sql, params));
    const s = new conformite.SignalementSoupcon(strict, t.acces, t.journal, { now: t.now });
    expect(await s.report(t.agent, t.mandateRef, { note: NOTE })).toEqual({ ok: true, status: 'transmis' });
    const list = await s.list(t.conformite);
    if (!list.ok) throw new Error(list.code);
    expect(list.value[0]!.lines).toBeGreaterThan(120);
    const id = list.value[0]!.reportId;
    expect(await s.checkFrozen(t.conformite, id)).toEqual({ ok: true, value: { intact: true, changed: [], missing: [], added: [] } });
    expect(max).toBeLessThanOrEqual(100);
    // La dernière offre, au-delà du premier lot, changée de force : vue.
    for (const trigger of (await t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'offer_register'"))) await t.db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    await t.db.run('UPDATE offer_register SET amount_eur = 100000 WHERE id = ?', [offers[119]!]);
    expect(await s.checkFrozen(t.conformite, id)).toMatchObject({ ok: true, value: { intact: false, changed: [{ table: 'offer_register', key: offers[119] }] } });
  });

  it('[R94] [R17] pour une société, l’identité de chaque bénéficiaire effectif est figée aussi', async () => {
    const t = await setup();
    const owner = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Associé', lastName: 'Exemple' });
    const piece = await identiteAuCoffre(t, t.agent, owner.id, { piece: 'carte_identite', seenAt: NOW });
    if (!piece.ok) throw new Error(piece.code);
    await t.db.run("INSERT INTO client_identifications (id, network_id, person_id, entity, owners_count, declared_by, declared_at) VALUES ('decl-0000-0001', ?, ?, 'societe', 1, ?, ?)", [t.network.id, t.personId, `agent:${t.alexId}`, NOW.toISOString()]);
    await t.db.run("INSERT INTO beneficial_owners (declaration_id, network_id, owner_person_id, share_hundredths) VALUES ('decl-0000-0001', ?, ?, 10000)", [t.network.id, owner.id]);
    await t.signalement.report(t.agent, t.mandateRef, { note: NOTE });
    const list = await t.signalement.list(t.conformite);
    if (!list.ok) throw new Error(list.code);
    const id = list.value[0]!.reportId;
    expect(await t.signalement.checkFrozen(t.conformite, id)).toMatchObject({ ok: true, value: { intact: true } });
    await t.db.exec('DROP TRIGGER IF EXISTS compliance_vault_pieces_sans_effacement');
    await t.db.run('DELETE FROM compliance_vault_pieces WHERE id = ?', [piece.id]);
    const check = await t.signalement.checkFrozen(t.conformite, id);
    expect(check.ok && check.value.missing).toContainEqual({ table: 'compliance_vault_pieces', key: piece.id });
  });

  it('[R94] le responsable décide seul, une seule fois, avec sa raison, son nom et sa date ; tout au journal sans nom', async () => {
    const t = await setup();
    await t.signalement.report(t.agent, t.mandateRef, { note: NOTE });
    const list = await t.signalement.list(t.conformite);
    if (!list.ok) throw new Error(list.code);
    const id = list.value[0]!.reportId;
    for (const viewer of [t.agent, t.direction, t.partner]) {
      expect(await t.signalement.decide(viewer, id, { decision: 'declaration_faite', reason: 'Soupçon confirmé', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect(await t.signalement.decide(t.conformite, id, { decision: 'autre', reason: 'x', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'bad_decision' });
    expect(await t.signalement.decide(t.conformite, id, { decision: 'declaration_faite', reason: 'x', validatorName: ' ' })).toEqual({ ok: false, rule: null, code: 'missing_name' });
    const d = await t.signalement.decide(t.conformite, id, { decision: 'declaration_faite', reason: 'Soupçon confirmé', validatorName: 'Camille Conforme' });
    expect(d).toMatchObject({ ok: true, value: { decision: { decision: 'declaration_faite', validatorName: 'Camille Conforme', decidedOn: '2027-03-09' } } });
    expect(await t.signalement.decide(t.conformite, id, { decision: 'pas_de_declaration', reason: 'x', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'already_decided' });
    const events = (await t.journal.all()).filter((e) => e.type.startsWith('conformite.signalement'));
    expect(events.map((e) => [e.type, e.subject, e.data.rule])).toEqual([
      ['conformite.signalement', `suspicion_report:${id}`, 'R94'],
      ['conformite.signalement_decision', `suspicion_report:${id}`, 'R94'],
    ]);
    // Le journal de la fiche du client ne dit rien du signalement.
    expect(JSON.stringify(await t.journal.bySubject(`person:${t.personId}`))).not.toMatch(/signalement|suspicion/);
    const text = JSON.stringify(await t.journal.all());
    for (const word of ['Camille', 'espèces', 'Soupçon']) expect(text).not.toContain(word);
    expect(await verifyChain(await t.journal.all())).toMatchObject({ ok: true });
  });

  it('[R94] Jamais vu : le client reçoit exactement les mêmes textes, avec ou sans signalement', async () => {
    const run = async (withReport: boolean) => {
      const t = await setup();
      if (withReport) expect(await t.signalement.report(t.agent, t.mandateRef, { note: NOTE })).toMatchObject({ ok: true });
      const sent = [];
      for (const [subject, text] of [
        ['relance:vente-1', 'Bonjour Léa, votre agent vous rappelle cette semaine pour faire le point.'],
        ['relance:vente-1', 'Bonjour Léa, votre agent vous rappelle cette semaine pour faire le point.'],
        ['point:semaine-10', 'Bonjour Léa, voici le point de la semaine sur votre bien.'],
      ] as const) {
        const r = await t.controle.send({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, channel: 'email', kind: 'follow_up', subject, fallbackTexts: [text] });
        sent.push([r.status, r.rule ?? null, r.body ?? null]);
      }
      await t.publication.sync(t.network.id, t.propertyId);
      return {
        sent,
        delivered: t.outbox.map((c) => c.sent.map((m) => [c.channel, m.to, m.body])),
        portals: t.channels.map((c) => c.received.map((p) => JSON.stringify({ ...p, version: undefined, id: undefined }))),
      };
    };
    const without = await run(false);
    const withIt = await run(true);
    expect(without.delivered.flat().length).toBeGreaterThan(0);
    expect(withIt).toEqual(without);
  });

  it('[R94] un signalement rangé sans son événement est repris au journal, une seule fois', async () => {
    const t = await setup();
    let failing = true;
    const flaky = {
      append: async (e: Parameters<typeof t.journal.append>[0]) => {
        if (failing && e.type === 'conformite.signalement') throw new Error('journal en panne');
        return t.journal.append(e);
      },
      last: () => t.journal.last(),
      all: () => t.journal.all(),
      bySubject: (s: string) => t.journal.bySubject(s),
      byPeriod: (a: string, b: string) => t.journal.byPeriod(a, b),
    };
    const s = new conformite.SignalementSoupcon(t.db, t.acces, flaky, { now: t.now });
    await expect(s.report(t.agent, t.mandateRef, { note: NOTE })).rejects.toThrow('journal en panne');
    failing = false;
    await s.list(t.conformite);
    await s.list(t.conformite);
    expect((await t.journal.all()).filter((e) => e.type === 'conformite.signalement')).toHaveLength(1);
  });
});

describe('L05 · rien ne lit le signalement hors de son code', () => {
  it('[R94] ni le contrôle des envois ni aucun autre code ne lit les tables du signalement', () => {
    const roots = ['../src', '../../api/src'].map((r) => fileURLToPath(new URL(r, import.meta.url)));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    roots.forEach(walk);
    const readers = files.filter((f) => /suspicion_(reports|decisions)|SignalementSoupcon|signalement\.ts/.test(readFileSync(f, 'utf8'))).map((f) => f.split(/[\\/]/).slice(-2).join('/'));
    // Le registre des traitements (L06) nomme les tables sans les lire ; l'index de la conformité exporte le module ; les
    // routes de M12 (L09) appellent le module, qui garde seul ses tables et ne les ouvre qu'au responsable.
    // Le dossier de l'agence sous licence (HX76) remet les tables du signalement entières à son seul responsable [R662].
    expect(readers.sort()).toEqual(['conformite/dossier-lcb-agence.ts', 'conformite/index.ts', 'conformite/registre-traitements.ts', 'conformite/signalement.ts', 'src/conformite.ts']);
    expect(readFileSync(fileURLToPath(new URL('../../api/src/conformite.ts', import.meta.url)), 'utf8')).not.toMatch(/suspicion_(reports|decisions)/);
  });
});
