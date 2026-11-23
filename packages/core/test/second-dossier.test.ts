import { expect, it } from 'vitest';
import { applyMigrations } from '../src/index.ts';
import { ActeVente, ArretDossier, Echeancier } from '../src/dossiers/index.ts';
import { DossiersVente, TransmissionOffres } from '../src/offres/index.ts';
import { SqlSourcesAcquereur, SqlSourcesVendeur } from '../src/espaces/index.ts';
import { Commissions } from '../src/pilotage/commissions.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { loadMigrations, withMigrationsBefore } from './migrations.ts';
import { describeWithSqlite } from './sqlite.ts';

// SV14 · Tout est inventé : le dossier du jeu de M10, arrêté, puis un second dossier sur le même bien (H51).
const STOP_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

async function stopped() {
  const t = await setupDossier();
  t.storage.refs.add(PROOF);
  t.storage.refs.add(STOP_PROOF);
  const arret = new ArretDossier(t.db, t.acces, t.journal, t.storage, { now: t.now });
  const dossiers = new DossiersVente(t.db, t.acces, t.journal, { now: t.now });
  const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
  t.setClock(at9('2027-03-04'));
  const r = await arret.stop(t.agent, t.fileId, { reason: 'pret_refuse', proofRef: STOP_PROOF });
  if (!r.ok) throw new Error(r.code);
  /** Une autre offre, transmise, acceptée, et son dossier ouvert. */
  const accept = async () => {
    t.setClock(at9('2027-03-05'));
    const offer = await t.record({ validUntil: '2027-03-20' });
    await transmission.transmit(t.agent, offer.id, { via: 'telephone' });
    t.setClock(at9('2027-03-06'));
    const answer = await transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: at9('2027-03-05').toISOString() });
    if (!answer.ok) throw new Error(answer.code);
    return offer.id;
  };
  const open = async (offerId: string) => {
    const opened = await dossiers.open(t.agent, offerId);
    if (!opened.ok) throw new Error(opened.code);
    return { offerId, fileId: opened.value.id };
  };
  const reopen = async () => open(await accept());
  return { ...t, arret, dossiers, transmission, accept, open, reopen };
}

describeWithSqlite('SV14 · un second dossier sur un bien', () => {
  it('[R233] après un arrêt, un second dossier s’ouvre, et chaque passage lit le bon', async () => {
    const t = await stopped();
    const second = await t.reopen();
    expect(second.fileId).not.toBe(t.fileId);
    expect((await t.db.all('SELECT id FROM sale_files WHERE property_id = ?', [t.propertyId])).length).toBe(2);
    expect((await t.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [t.propertyId]))?.status).toBe('under_offer');

    // L'acquéreur ne voit avancer que le dossier ouvert ; le vendeur lit l'état de chaque offre.
    const identity = { state: async () => ({ identityVerifiedOn: '2027-02-20' }) };
    const acquereur = new SqlSourcesAcquereur(t.db, t.acces, identity, t.journal, { now: t.now });
    expect((await acquereur.filesOf(t.network.id, t.buyerId)).map((f) => f.fileId)).toEqual([second.fileId]);
    const vendeur = new SqlSourcesVendeur(t.db, t.acces, t.journal, { now: t.now });
    const states = Object.fromEntries((await vendeur.offersOf(t.network.id, t.propertyId, t.personId)).map((o) => [o.id, o.state]));
    expect(states).toEqual({ [t.offerId]: 'la vente ne se fait plus', [second.offerId]: 'acceptée' });

    // Le dossier arrêté reste lisible et fermé ; le second reçoit les dates, la commission et l'acte.
    expect(await t.arret.of(t.direction, t.fileId)).toMatchObject({ ok: true, value: { reason: 'pret_refuse' } });
    const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    expect(await echeancier.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-06', proofRef: PROOF })).toMatchObject({ ok: false, code: 'file_stopped' });
    const commissions = new Commissions(t.db, t.acces, t.journal, { now: t.now });
    expect(await commissions.setGrid(t.direction, { validFrom: '2027-03-06', defaultRateBp: 7000 })).toMatchObject({ ok: true });
    await t.verifyBuyer(at9('2027-03-06'));
    expect(await t.dossiers.startCompromis(t.agent, second.fileId)).toMatchObject({ ok: true });
    t.setClock(at9('2027-03-08'));
    expect(await echeancier.record(t.agent, second.fileId, { kind: 'compromis_signe', day: '2027-03-07', proofRef: PROOF })).toMatchObject({ ok: true });
    expect(await echeancier.record(t.agent, second.fileId, { kind: 'notification_acquereur', day: '2027-03-07', proofRef: PROOF })).toMatchObject({ ok: true });
    t.setClock(at9('2027-03-20'));
    expect(await commissions.sync(t.network.id)).toEqual({ planned: 1, due: 0 });
    const listed = await commissions.list(t.direction);
    expect(listed.ok && listed.value.map((c) => c.fileId)).toEqual([second.fileId]);
    // L'acte lit les pièces du second dossier, jamais l'arrêt du premier.
    const acte = new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now });
    expect(await acte.record(t.agent, second.fileId, { signedOn: '2027-03-19', proofRef: PROOF })).toMatchObject({ ok: false, rule: 'R60', code: 'incomplete' });
    expect(await acte.record(t.agent, t.fileId, { signedOn: '2027-03-19', proofRef: PROOF })).toMatchObject({ ok: false, code: 'file_stopped' });
  });

  it('[R233] jamais deux dossiers ouverts sur un bien, par le service comme par la base', async () => {
    const t = await stopped();
    const second = await t.reopen();
    // L'offre du dossier arrêté ne rouvre rien ; une troisième offre acceptée ne passe pas tant que le second vit.
    expect(await t.dossiers.open(t.agent, t.offerId)).toEqual({ ok: false, rule: null, code: 'previous_file_stopped' });
    expect(await t.dossiers.open(t.agent, second.offerId)).toMatchObject({ ok: false, code: 'already_open' });
    t.setClock(at9('2027-03-07'));
    const third = await t.record({ validUntil: '2027-03-20' });
    await t.transmission.transmit(t.agent, third.id, { via: 'telephone' });
    expect(await t.transmission.respond(t.agent, third.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: at9('2027-03-07').toISOString() })).toMatchObject({ ok: false, code: 'other_accepted' });
    await expect(
      t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('x', ?, ?, ?, ?, 1, 'a', 'b')", [t.network.id, t.propertyId, third.id, t.buyerId]),
    ).rejects.toThrow(/UNIQUE/);
    expect((await t.db.all('SELECT id FROM sale_files WHERE property_id = ?', [t.propertyId])).length).toBe(2);
    // Une offre n'a jamais deux dossiers, même arrêtés.
    await expect(
      t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('y', ?, ?, ?, ?, 1, 'a', 'b')", [t.network.id, t.propertyId, t.offerId, t.buyerId]),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('[R17] la table refaite : aucune ligne perdue ni changée, liens intacts, preuve de recopie gardée', async () => {
    // La base telle qu'avant SV14 : un dossier ouvert puis arrêté, avec ses étapes et son vendeur.
    // AU002 : le mandat du jeu lit la désignation du bien ; AU014 : son modèle dit son objet. Ni l'un ni l'autre ne
    // touche à `sale_files`.
    const t = await withMigrationsBefore('1760', stopped, ['3970_designations_mandat', '4113_mandat_location']);
    expect(await t.db.first("SELECT 1 FROM sqlite_master WHERE name = 'sale_files_recopie'")).toBeNull();
    const snapshot = async () => ({
      files: await t.db.all('SELECT * FROM sale_files ORDER BY id'),
      sellers: await t.db.all('SELECT * FROM sale_file_sellers ORDER BY file_id'),
      stops: await t.db.all('SELECT * FROM sale_file_stops ORDER BY file_id'),
    });
    const before = await snapshot();
    expect(before.files).toHaveLength(1);
    expect(before.stops).toHaveLength(1);
    // Avant : le second dossier bute sur l'ancienne unicité du bien.
    const offerId = await t.accept();
    await expect(t.open(offerId)).rejects.toThrow('already_open');

    // Comme `wrangler d1 migrations apply` : la migration passe dans une seule transaction, liens vérifiés à la fin.
    await t.db.exec('BEGIN');
    expect((await applyMigrations(t.db, loadMigrations()))[0]).toBe('1760_second_dossier');
    await t.db.exec('COMMIT');
    expect(await snapshot()).toEqual(before);
    expect(await t.db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(await t.db.all('SELECT rows_copied, complete FROM sale_files_recopie')).toEqual([{ rows_copied: 1, complete: 1 }]);
    // La preuve ne change pas, ne s'efface pas, et une recopie incomplète ne s'y écrit pas.
    await expect(t.db.run("INSERT INTO sale_files_recopie (done_at, rows_copied, complete) VALUES ('a', 0, 0)")).rejects.toThrow(/CHECK/);
    await expect(t.db.run('UPDATE sale_files_recopie SET rows_copied = 0')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM sale_files_recopie')).rejects.toThrow();
    // Les gardes de la table refaite sont là : rien ne change ni ne s'efface.
    await expect(t.db.run('UPDATE sale_files SET amount_eur = 1')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM sale_files')).rejects.toThrow();
    // Et le second dossier s'ouvre désormais.
    const second = await t.open(offerId);
    expect((await t.db.all('SELECT id FROM sale_files WHERE property_id = ?', [t.propertyId])).map((r) => (r as { id: string }).id).sort()).toEqual([t.fileId, second.fileId].sort());
  });
});
