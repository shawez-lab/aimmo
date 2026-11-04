import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ArretDossier, ActeVente, Echeancier, RelancesPieces } from '../src/dossiers/index.ts';
import { DossiersVente, TransmissionOffres } from '../src/offres/index.ts';
import { SqlSourcesAcquereur } from '../src/espaces/index.ts';
import { Commissions } from '../src/pilotage/commissions.ts';
import { TableauAgent } from '../src/pilotage/tableau-agent.ts';
import { verifyChain } from '../src/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { migrationsDir } from './migrations.ts';
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

  it('[R233] autre dossier ouvert : rien ne change pour le bien ; un seul dossier ouvert à la fois', async () => {
    const t = await setup();
    await t.listed();
    const early = await t.secondOffer();
    expect(early.answer).toMatchObject({ ok: false, code: 'other_accepted' });
    await t.stop();
    const { offer, answer } = await t.secondOffer();
    expect(answer).toMatchObject({ ok: true });
    const opened = await t.dossiers.open(t.agent, offer.id);
    expect(opened).toMatchObject({ ok: true });
    expect(await t.statusOf()).toBe('under_offer');
    // L'ancien dossier ne se réarrête pas, et ne fait pas tomber le nouveau.
    expect(await t.stop()).toMatchObject({ ok: false, code: 'file_stopped' });
    expect(await t.statusOf()).toBe('under_offer');
    expect((await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'bien.offre_tombee')).toHaveLength(1);
    // Le verrou de la base, sans passer par le service.
    const third = await t.record({ validUntil: '2027-03-20' });
    await expect(
      t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('x', ?, ?, ?, ?, 1, 'a', 'b')", [t.network.id, t.propertyId, third.id, t.buyerId]),
    ).rejects.toThrow(/UNIQUE/);
    // La même offre n'ouvre jamais un deuxième dossier.
    if (opened.ok) await t.stop('autre', opened.value.id);
    expect(await t.dossiers.open(t.agent, offer.id)).toMatchObject({ ok: false, code: 'already_open' });
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
      const columns = (await u.db.all<{ name: string; notnull: number }>('PRAGMA table_info(sale_file_closings)')).filter((c) => c.notnull);
      const values: Record<string, string> = { file_id: u.fileId, network_id: u.network.id };
      return u.db.run(`INSERT INTO sale_file_closings (${columns.map((c) => c.name).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map((c) => values[c.name] ?? '2027-03-01'));
    };
    await expect(closing(t)).rejects.toThrow(/arrêté/);
    // L'autre sens : un autre dossier, signé en base, refuse l'arrêt, par le service comme par la base.
    const u = await setup();
    await closing(u);
    expect(await u.stop()).toMatchObject({ ok: false, code: 'already_closed' });
    await expect(u.db.run("INSERT INTO sale_file_stops (file_id, network_id, reason, proof_ref, at, by) VALUES (?, ?, 'autre', ?, 'a', 'b')", [u.fileId, u.network.id, STOP_PROOF])).rejects.toThrow(/acte/);
  });

  /** Le dossier A au compromis signé, puis arrêté ou non ; un dossier B sur le bien s'il a été arrêté, pour que le bien soit sous offre. */
  async function withCompromis(stopped: boolean) {
    const t = await setup();
    const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    const commissions = new Commissions(t.db, t.acces, t.journal, { now: t.now });
    expect(await commissions.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 })).toMatchObject({ ok: true });
    await t.startCompromis();
    t.setClock(at9('2027-03-03'));
    expect(await echeancier.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-02', proofRef: PROOF })).toMatchObject({ ok: true });
    expect(await echeancier.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-02', proofRef: PROOF })).toMatchObject({ ok: true });
    if (stopped) {
      await t.stop();
      const { offer } = await t.secondOffer();
      expect(await t.dossiers.open(t.agent, offer.id)).toMatchObject({ ok: true });
    }
    expect(await t.statusOf()).toBe('under_offer');
    t.setClock(at9('2027-03-11'));
    return { ...t, echeancier, commissions };
  }

  it.each([false, true])('[R233] plus de commission, de tâche ni de relance sur un dossier arrêté, même si un autre tient le bien (arrêté : %s)', async (stopped) => {
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

  it('[R233] l’acquéreur d’un dossier arrêté ne le voit plus avancer dans son espace', async () => {
    const t = await setup();
    const identity = { state: async () => ({ identityVerifiedOn: '2027-02-20' }) };
    const sources = new SqlSourcesAcquereur(t.db, t.acces, identity, t.journal, { now: t.now });
    expect((await sources.filesOf(t.network.id, t.buyerId)).map((f) => f.fileId)).toEqual([t.fileId]);
    await t.stop();
    expect(await sources.filesOf(t.network.id, t.buyerId)).toEqual([]);
  });

  it('la table refaite garde ses lignes, ses liens et ses verrous, quand elle est déjà remplie', async () => {
    const t = await setup();
    await t.stop();
    const { offer } = await t.secondOffer();
    expect(await t.dossiers.open(t.agent, offer.id)).toMatchObject({ ok: true });
    const count = async (table: string) => (await t.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
    const before = { files: await t.db.all('SELECT * FROM sale_files ORDER BY id'), sellers: await count('sale_file_sellers'), stops: await count('sale_file_stops') };
    expect(before.files).toHaveLength(2);
    expect(before.sellers).toBeGreaterThan(0);
    // La même transaction qu'à la mise en ligne : la migration tourne sur une base déjà remplie.
    const sql = readFileSync(`${migrationsDir}1750_arret_dossier.sql`, 'utf8');
    await t.db.exec(`BEGIN; ${sql} COMMIT;`);
    expect(await t.db.all('SELECT * FROM sale_files ORDER BY id')).toEqual(before.files);
    expect(await count('sale_file_sellers')).toBe(before.sellers);
    expect(await count('sale_file_stops')).toBe(before.stops);
    expect(await t.db.all('PRAGMA foreign_key_check')).toEqual([]);
    await expect(t.db.run('DELETE FROM sale_files')).rejects.toThrow();
    await expect(t.db.run('UPDATE sale_files SET amount_eur = 1')).rejects.toThrow();
    expect(await t.db.first("SELECT name FROM sqlite_master WHERE name = 'sale_files_refaite'")).toBeNull();
  });
});
