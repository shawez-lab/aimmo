import { expect, it } from 'vitest';
import { ArretDossier, ActeVente, BouclierFonds, Echeancier, FinancementDossier, RelancesPieces, SALE_FOLLOW_UP_PURPOSE } from '../src/dossiers/index.ts';
import { DossiersVente, TransmissionOffres, nextStep } from '../src/offres/index.ts';
import { SqlSourcesAcquereur, SqlSourcesVendeur } from '../src/espaces/index.ts';
import { conformite } from '../src/index.ts';
import { Commissions } from '../src/pilotage/commissions.ts';
import { TableauAgent } from '../src/pilotage/tableau-agent.ts';
import { verifyChain } from '../src/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : le dossier du jeu de M10, et une deuxième offre sur le même bien.
const STOP_PROOF = 'preuves/0b6f1d2e-6666-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

async function setup() {
  const t = await setupDossier();
  t.storage.refs.add(PROOF);
  t.storage.refs.add(STOP_PROOF);
  const arret = new ArretDossier(t.db, t.acces, t.journal, t.storage, { now: t.now });
  const dossiers = new DossiersVente(t.db, t.acces, t.journal, { now: t.now });
  const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
  const stop = (reason: unknown = 'pret_refuse', file = t.fileId) => arret.stop(t.agent, file, { reason, proofRef: STOP_PROOF });
  const statusOf = async () => (await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status;
  /** L'annonce est en ligne, le bien sous offre. */
  const listed = async () => {
    await t.annonces.validate(t.agent, t.draftId);
    return t.publication.sync(t.network.id, t.propertyId);
  };
  /** Une deuxième offre, transmise puis acceptée. */
  const secondOffer = async () => {
    t.setClock(at9('2027-03-05'));
    const offer = await t.record({ validUntil: '2027-03-20' });
    await transmission.transmit(t.agent, offer.id, { via: 'telephone' });
    t.setClock(at9('2027-03-06'));
    const answer = await transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: at9('2027-03-05').toISOString() });
    return { offer, answer };
  };
  return { ...t, arret, dossiers, transmission, stop, statusOf, listed, secondOffer };
}

describeWithSqlite('SV09 · une offre qui tombe rend le bien disponible', () => {
  it('[R233] [R42] dossier arrêté : le bien quitte « sous offre », le passage le rend disponible et remet l’annonce', async () => {
    const t = await setup();
    expect(await t.listed()).toMatchObject({ state: 'sous_offre' });
    expect(await t.statusOf()).toBe('under_offer');
    expect(await t.stop()).toEqual({ ok: true, value: { reason: 'pret_refuse', on: expect.stringMatching(/^2027-03-/) } });
    expect(await t.statusOf()).toBe('draft');
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ state: 'en_vente', created: true });
    expect(await t.statusOf()).toBe('available');
    expect(await t.arret.of(t.direction, t.fileId)).toMatchObject({ ok: true, value: { reason: 'pret_refuse' } });
  });

  it('[R233] [R42] mandat échu : le bien ne revient pas à la vente et l’annonce reste retirée', async () => {
    const t = await setup();
    await t.listed();
    t.setClock(at9('2031-01-01'));
    expect(await t.stop()).toMatchObject({ ok: true });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ state: 'retiree' });
    expect(await t.statusOf()).toBe('draft');
  });

  it('[R233] autre dossier : un seul ouvert à la fois, un arrêt rejoué ne change rien, un second s’ouvre après (SV14)', async () => {
    const t = await setup();
    await t.listed();
    expect((await t.secondOffer()).answer).toMatchObject({ ok: false, code: 'other_accepted' });
    await t.stop();
    expect(await t.stop()).toMatchObject({ ok: false, code: 'file_stopped' });
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await t.statusOf()).toBe('available');
    expect((await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'bien.offre_tombee')).toHaveLength(1);
    // L'offre arrêtée ne bloque plus la réponse du vendeur à une autre offre, qui reste un fait à ranger [R57].
    const { offer, answer } = await t.secondOffer();
    expect(answer).toMatchObject({ ok: true });
    // L'offre du dossier arrêté n'en rouvre pas un ; l'autre offre ouvre le second dossier (H51).
    expect(await t.dossiers.open(t.agent, t.offerId)).toEqual({ ok: false, rule: null, code: 'previous_file_stopped' });
    const second = await t.dossiers.open(t.agent, offer.id);
    expect(second).toMatchObject({ ok: true, value: { propertyId: t.propertyId, offerId: offer.id } });
    expect(await t.statusOf()).toBe('under_offer');
    // Le verrou de la base, sans passer par le service : jamais deux dossiers ouverts sur un bien.
    t.setClock(at9('2027-03-07'));
    const third = await t.record({ validUntil: '2027-03-20' });
    await expect(
      t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('x', ?, ?, ?, ?, 1, 'a', 'b')", [t.network.id, t.propertyId, third.id, t.buyerId]),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('[R16] [R233] seul l’agent du bien arrête ; un autre agent ou la direction sont refusés, et c’est écrit', async () => {
    const t = await setup();
    for (const viewer of [t.direction, { ...t.agent, userId: 'autre-agent' }]) {
      expect(await t.arret.stop(viewer, t.fileId, { reason: 'autre', proofRef: STOP_PROOF })).toMatchObject({ ok: false, rule: 'R16' });
    }
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'acces.refuse').length).toBeGreaterThanOrEqual(2);
    expect(await t.statusOf()).toBe('under_offer');
  });

  it('[R233] raison hors liste, preuve absente ou non rangée : rien n’est arrêté', async () => {
    const t = await setup();
    expect(await t.stop('caprice')).toMatchObject({ ok: false, code: 'bad_reason' });
    expect(await t.arret.stop(t.agent, t.fileId, { reason: 'autre', proofRef: 'n’importe quoi' })).toMatchObject({ ok: false, code: 'bad_proof' });
    expect(await t.arret.stop(t.agent, t.fileId, { reason: 'autre', proofRef: 'preuves/0b6f1d2e-5555-4a2b-8c3d-000000000001.pdf' })).toMatchObject({ ok: false, code: 'not_stored' });
    expect(await t.db.first('SELECT 1 FROM sale_file_stops')).toBeNull();
    expect(await t.statusOf()).toBe('under_offer');
  });

  it('[R13] [R17] au journal : la raison seulement ; l’arrêt ne change ni ne s’efface', async () => {
    const t = await setup();
    await t.stop();
    const events = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'dossier.arrete');
    expect(events.map((e) => e.data)).toEqual([{ rule: 'R233', reason: 'pret_refuse' }]);
    expect(JSON.stringify(events)).not.toContain(STOP_PROOF);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
    await expect(t.db.run("UPDATE sale_file_stops SET reason = 'autre'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM sale_file_stops')).rejects.toThrow();
    await expect(t.db.run('UPDATE sale_files SET amount_eur = 1')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM sale_files')).rejects.toThrow();
  });

  it('[R233] un dossier arrêté reste lisible et ne reçoit plus rien', async () => {
    const t = await setup();
    await t.stop();
    const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    const stopped = { ok: false, code: 'file_stopped' };
    expect(await echeancier.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-01', proofRef: PROOF })).toMatchObject(stopped);
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'dpe', ref: t.upload(), issuedOn: '2027-03-01' })).toMatchObject(stopped);
    expect(await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-03-01', proofRef: PROOF })).toMatchObject(stopped);
    await t.verifyBuyer();
    expect(await t.dossiers.startCompromis(t.agent, t.fileId)).toMatchObject(stopped);
    expect(await echeancier.schedule(t.agent, t.fileId)).toMatchObject({ ok: true });
    expect(await t.pieces.status(t.agent, t.fileId)).toMatchObject({ ok: true });
  });

  it('[R233] un acte signé ne s’arrête pas ; un dossier arrêté ne se signe pas, même sans passer par le service', async () => {
    const t = await setup();
    await t.db.run("INSERT INTO sale_file_stops (file_id, network_id, reason, proof_ref, at, by) VALUES (?, ?, 'autre', ?, 'a', 'b')", [t.fileId, t.network.id, STOP_PROOF]);
    const closing = async (u: { db: typeof t.db; fileId: string; network: { id: string } }) => {
      const columns = (await u.db.all<{ name: string; notnull: number; pk: number }>('PRAGMA table_info(sale_file_closings)')).filter((c) => c.notnull || c.pk);
      const values: Record<string, string> = { file_id: u.fileId, network_id: u.network.id, aftersale: 'a_demarrer' };
      return u.db.run(`INSERT INTO sale_file_closings (${columns.map((c) => c.name).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map((c) => values[c.name] ?? '2027-03-01'));
    };
    await expect(closing(t)).rejects.toThrow(/arrêté/);
    // L'autre sens : un autre dossier, signé en base, refuse l'arrêt, par le service comme par la base.
    const u = await setup();
    await closing(u);
    expect(await u.stop()).toMatchObject({ ok: false, code: 'already_closed' });
    await expect(u.db.run("INSERT INTO sale_file_stops (file_id, network_id, reason, proof_ref, at, by) VALUES (?, ?, 'autre', ?, 'a', 'b')", [u.fileId, u.network.id, STOP_PROOF])).rejects.toThrow(/acte/);
  });

  /** Le dossier au compromis signé, puis arrêté ou non. */
  async function withCompromis(stopped: boolean) {
    const t = await setup();
    const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    const commissions = new Commissions(t.db, t.acces, t.journal, { now: t.now });
    expect(await commissions.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 })).toMatchObject({ ok: true });
    await t.startCompromis();
    t.setClock(at9('2027-03-03'));
    expect(await echeancier.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-02', proofRef: PROOF })).toMatchObject({ ok: true });
    expect(await echeancier.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-02', proofRef: PROOF })).toMatchObject({ ok: true });
    if (stopped) await t.stop();
    t.setClock(at9('2027-03-11'));
    return { ...t, echeancier, commissions };
  }

  it.each([false, true])('[R233] plus de commission, de tâche ni de relance sur un dossier arrêté (arrêté : %s)', async (stopped) => {
    const t = await withCompromis(stopped);
    expect(await t.commissions.sync(t.network.id)).toEqual({ planned: stopped ? 0 : 1, due: 0 });
    await t.echeancier.run(t.network.id);
    const tasks = await t.echeancier.tasksOf(t.agent);
    expect(tasks.ok && tasks.tasks.some((k) => k.fileId === t.fileId)).toBe(!stopped);
    await new RelancesPieces(t.db, t.acces, t.journal, t.storage, { now: t.now }).run(t.network.id);
    expect((await t.db.all('SELECT 1 FROM sale_file_reminders WHERE file_id = ?', [t.fileId])).length > 0).toBe(!stopped);
  });

  it('[R233] une commission déjà prévue ne compte plus pour l’agent une fois le dossier arrêté', async () => {
    const t = await withCompromis(false);
    await t.commissions.sync(t.network.id);
    const tableau = new TableauAgent(t.db, t.journal, { now: t.now });
    const read = async () => {
      const r = await tableau.of(t.agent, { from: '2027-03-01', to: '2027-03-31' });
      if (!r.ok) throw new Error(r.code);
      return JSON.stringify(r.value).includes(t.fileId);
    };
    expect(await read()).toBe(true);
    await t.stop();
    expect(await read()).toBe(false);
  });

  it('[R233] la liste des commissions ne montre plus une commission prévue d’un dossier arrêté', async () => {
    const t = await withCompromis(false);
    await t.commissions.sync(t.network.id);
    const seen = async () => {
      const r = await t.commissions.list(t.direction);
      return r.ok && r.value.map((c) => c.fileId);
    };
    expect(await seen()).toEqual([t.fileId]);
    await t.stop();
    expect(await seen()).toEqual([]);
  });

  it('[R233] l’acquéreur n’écrit plus sur un dossier arrêté depuis son espace', async () => {
    const t = await setup();
    const financement = new FinancementDossier(t.db, t.acces, t.journal, { now: t.now });
    const declare = () => financement.declareByBuyer(t.network.id, [t.buyerId], t.fileId, { step: 'refus', day: '2027-03-01' }, 'client:essai');
    await t.stop();
    expect(await declare()).toMatchObject({ ok: false, code: 'file_stopped' });
    expect(await t.db.first('SELECT 1 FROM sale_file_financing WHERE file_id = ?', [t.fileId])).toBeNull();
  });

  it('[R233] un rappel qui attendait ne part plus une fois le dossier arrêté', async () => {
    const t = await setup();
    await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'vendeuse@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: t.personId, purpose: SALE_FOLLOW_UP_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
    const bouclier = new BouclierFonds(t.db, t.acces, t.journal, { now: t.now });
    t.setClock(new Date('2027-03-07T21:30:00.000Z')); // Un dimanche soir : le rappel attend [R01].
    const m = await t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, channel: 'email', direction: 'in', authorKind: 'person', body: 'Le notaire demande un virement sur un autre compte.', occurredAt: t.now() });
    await bouclier.scan(m.id);
    const alert = () => t.db.first<{ reminder_status: string | null }>('SELECT reminder_status FROM sale_file_fund_alerts WHERE file_id = ?', [t.fileId]);
    expect((await alert())?.reminder_status).toBe('waiting');
    await t.stop();
    t.setClock(new Date('2027-03-08T09:00:00.000Z'));
    await bouclier.run(t.network.id, t.now());
    expect((await alert())?.reminder_status).toBe('waiting');
    expect(await t.db.all('SELECT 1 FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ?', [t.personId])).toEqual([]);
  });

  it('[R233] le tableau des offres ne propose plus de préparer le compromis d’un dossier arrêté', () => {
    expect(nextStep({ state: 'acceptee', transmitted: true, last: null, file: { compromisStarted: false, stopped: true }, otherTaken: false })).toBe('aucun');
    expect(nextStep({ state: 'acceptee', transmitted: true, last: null, file: { compromisStarted: false }, otherTaken: false })).toBe('preparer_compromis');
  });

  it('[R233] l’acquéreur d’un dossier arrêté ne le voit plus avancer dans son espace', async () => {
    const t = await setup();
    const identity = { state: async () => ({ identityVerifiedOn: '2027-02-20' }) };
    const sources = new SqlSourcesAcquereur(t.db, t.acces, identity, t.journal, { now: t.now });
    expect((await sources.filesOf(t.network.id, t.buyerId)).map((f) => f.fileId)).toEqual([t.fileId]);
    await t.stop();
    expect(await sources.filesOf(t.network.id, t.buyerId)).toEqual([]);
  });

  it('[R233] après l’arrêt, l’acquéreur et le vendeur lisent que la vente ne se fait plus, sans la raison', async () => {
    const t = await setup();
    const identity = { state: async () => ({ identityVerifiedOn: '2027-02-20' }) };
    const acquereur = new SqlSourcesAcquereur(t.db, t.acces, identity, t.journal, { now: t.now });
    const vendeur = new SqlSourcesVendeur(t.db, t.acces, t.journal, { now: t.now });
    const read = async () => ({
      buyer: (await acquereur.offersOf(t.network.id, t.buyerId))[0]!,
      seller: (await vendeur.offersOf(t.network.id, t.propertyId, t.personId))[0]!,
    });
    const before = await read();
    expect(before.buyer.state).toBe('acceptée');
    expect(before.seller.state).toBe('acceptée');
    t.setClock(at9('2027-03-10'));
    await t.stop();
    const after = await read();
    for (const offer of [after.buyer, after.seller]) {
      expect(offer.state).toBe('la vente ne se fait plus');
      expect(offer.stateAt).toBe(at9('2027-03-10').toISOString());
      // La raison reste à l'agent : un prêt refusé ne se dit pas à l'autre partie [R14].
      expect(JSON.stringify(offer)).not.toMatch(/acceptée|pret_refuse|prêt/);
    }
    // Le montant reste lisible : le dossier arrêté reste lisible, seul son état change.
    expect(after.buyer.amountEur).toBe(before.buyer.amountEur);
  });

  it('[R233] [R14] le droit d’accès du vendeur ne dit pas la raison de l’arrêt ; celui de l’acquéreur la dit', async () => {
    const t = await setup();
    await t.stop();
    const seller = await conformite.assembleAccessDetail(t.db, [t.personId]);
    expect(JSON.stringify(seller.response)).not.toContain('pret_refuse');
    expect(seller.response.sections.map((x) => x.table)).not.toContain('sale_file_stops');
    const buyer = await conformite.assembleAccessDetail(t.db, [t.buyerId]);
    expect(buyer.response.sections.find((x) => x.table === 'sale_file_stops')?.rows).toHaveLength(1);
    expect(JSON.stringify(buyer.response)).toContain('pret_refuse');
  });

  it('[R233] le vendeur lit le statut de son bien en français après l’arrêt, jamais un code', async () => {
    const t = await setup();
    const vendeur = new SqlSourcesVendeur(t.db, t.acces, t.journal, { now: t.now });
    await t.stop();
    expect((await vendeur.sellerPropertiesOf(t.network.id, t.personId))[0]?.status).toBe('pas en vente pour l’instant');
  });

  it('[R233] une autre offre du même bien garde son état après l’arrêt', async () => {
    const t = await setup();
    t.setClock(at9('2027-03-02'));
    const refused = await t.record({ validUntil: '2027-03-20' });
    await t.transmission.transmit(t.agent, refused.id, { via: 'telephone' });
    await t.transmission.respond(t.agent, refused.id, { outcome: 'refusee', proofRef: PROOF, respondedAt: at9('2027-03-02').toISOString() });
    await t.stop();
    const vendeur = new SqlSourcesVendeur(t.db, t.acces, t.journal, { now: t.now });
    const states = Object.fromEntries((await vendeur.offersOf(t.network.id, t.propertyId, t.personId)).map((o) => [o.id, o.state]));
    expect(states).toEqual({ [t.offerId]: 'la vente ne se fait plus', [refused.id]: 'refusée' });
  });

  it('[R94] [R233] l’arrêt fait partie du dossier figé : présent au gel, et vu s’il arrive après', async () => {
    const t = await setup();
    const signalement = new conformite.SignalementSoupcon(t.db, t.acces, t.journal, { now: t.now });
    const responsable = { role: 'compliance', userId: 'conformite-1', networkId: t.network.id } as Parameters<typeof signalement.list>[0];
    await new conformite.DispositifLcb(t.db, t.journal, { now: t.now }).designate({ role: 'direction', userId: 'direction-1', networkId: t.network.id } as Parameters<typeof signalement.list>[0], 'conformite-1');
    const ref = `sale_file:${t.fileId}`;
    await signalement.report(t.agent, ref, { note: 'Paiement proposé en espèces.' });
    t.setClock(at9('2027-03-10'));
    await t.stop();
    t.setClock(at9('2027-03-11'));
    await signalement.report(t.agent, ref, { note: 'Le dossier a été arrêté depuis.' });
    const list = await signalement.list(responsable);
    if (!list.ok) throw new Error(list.code);
    const first = list.value.find((r) => r.note.startsWith('Paiement'));
    const second = list.value.find((r) => r.note.startsWith('Le dossier'));
    // Gelé avant l'arrêt : l'arrêt apparaît comme un ajout, pas un silence.
    const late = await signalement.checkFrozen(responsable, first!.reportId);
    expect(late.ok && late.value.added.map((a) => a.table)).toContain('sale_file_stops');
    // Gelé après l'arrêt : il est dans la copie, et son retrait forcé se verrait.
    expect(await signalement.checkFrozen(responsable, second!.reportId)).toMatchObject({ ok: true, value: { intact: true } });
    for (const { name } of await t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sale_file_stops'")) await t.db.exec(`DROP TRIGGER "${name}"`);
    await t.db.run('DELETE FROM sale_file_stops WHERE file_id = ?', [t.fileId]);
    const gone = await signalement.checkFrozen(responsable, second!.reportId);
    expect(gone.ok && gone.value.missing.map((m) => m.table)).toContain('sale_file_stops');
  });
});
