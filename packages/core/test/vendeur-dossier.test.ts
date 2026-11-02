import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { conformite } from '../src/index.ts';
import { DossiersVente, TransmissionOffres } from '../src/offres/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// N11 : le vendeur d'un dossier est le mandant du dernier mandat vivant à l'ouverture. Personnes et biens inventés.
type T = Awaited<ReturnType<typeof setupOffre>>;

let counter = 0;

/** Une autre personne, avec un mandat inscrit au registre sur le bien, signé à `signedAt`. */
async function otherMandate(t: T, firstName: string, signedAt: string): Promise<{ personId: string; mandateId: string }> {
  counter += 1;
  const person = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName: 'Exemple' });
  const mandateId = `mandat-autre-${counter}`;
  await t.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'site', 'test', ?)", [
    mandateId, t.network.id, t.alexId, person.id, t.propertyId, signedAt, signedAt,
  ]);
  const seq = (await t.db.first<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM mandate_register WHERE network_id = ?', [t.network.id]))!.n;
  await t.db.run("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', ?, ?, ?, ?, ?, ?, ?, 'test', 'p', ?)", [
    t.network.id, seq, mandateId, 5000 + seq, `T-${5000 + seq}`, t.alexId, t.propertyId, signedAt, signedAt, `h-autre-${mandateId}`,
  ]);
  return { personId: person.id, mandateId };
}

async function cancel(t: T, mandateId: string): Promise<void> {
  const line = (await t.db.first<{ seq: number; number_value: number; number: string; agent_id: string; property_id: string; signed_at: string }>("SELECT seq, number_value, number, agent_id, property_id, signed_at FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'", [mandateId]))!;
  const seq = (await t.db.first<{ n: number }>('SELECT MAX(seq) + 1 AS n FROM mandate_register WHERE network_id = ?', [t.network.id]))!.n;
  await t.db.run("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, cancels_seq, reason, at, actor, prev_hash, hash) VALUES (?, ?, 'annulation', ?, ?, ?, ?, ?, ?, ?, 'error', ?, 'test', 'p', ?)", [
    t.network.id, seq, mandateId, line.number_value, line.number, line.agent_id, line.property_id, line.signed_at, line.seq, line.signed_at, `h-annule-${mandateId}`,
  ]);
}

/** L'offre acceptée d'un jeu de test, puis son dossier ouvert. */
async function openFile(t: T, beforeOpening?: () => Promise<void>): Promise<string> {
  const offer = await t.record();
  const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
  await transmission.transmit(t.agent, offer.id, { via: 'telephone' });
  await transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: t.now().toISOString() });
  await beforeOpening?.();
  const opened = await new DossiersVente(t.db, t.acces, t.journal, { now: t.now }).open(t.agent, offer.id);
  if (!opened.ok) throw new Error(opened.code);
  return opened.value.id;
}

const sellerOf = (t: T, fileId: string) => t.db.first<{ person_id: string; mandate_id: string }>('SELECT person_id, mandate_id FROM sale_file_sellers WHERE file_id = ?', [fileId]);
const filesSeenBy = async (t: T, personId: string) => (await conformite.assembleAccess(t.db, [personId])).sections.find((s) => s.table === 'sale_files')?.rows.map((r) => r.id) ?? [];

describeWithSqlite('N11 · le vendeur d’un dossier', () => {
  it('[R96] ni un ancien mandant ni le mandant d’un mandat signé après l’ouverture ne voient le dossier ; le vendeur le voit sans l’acquéreur', async () => {
    const t = await setupOffre();
    const former = await otherMandate(t, 'Ancienne', '2026-01-10T09:00:00.000Z');
    const fileId = await openFile(t);
    t.setClock(new Date('2027-03-02T10:00:00.000Z'));
    const later = await otherMandate(t, 'Suivante', '2027-03-02T09:00:00.000Z');

    expect(await sellerOf(t, fileId)).toMatchObject({ person_id: t.personId, mandate_id: t.mandateId });
    expect(await filesSeenBy(t, former.personId)).toEqual([]);
    expect(await filesSeenBy(t, later.personId)).toEqual([]);
    for (const other of [former, later]) {
      const answer = JSON.stringify(await conformite.assembleAccess(t.db, [other.personId]));
      expect(answer).not.toContain(fileId);
      expect(answer).not.toContain(t.buyerId);
    }
    const seller = await conformite.assembleAccess(t.db, [t.personId]);
    expect(seller.sections.find((s) => s.table === 'sale_files')!.rows).toEqual([expect.objectContaining({ id: fileId, buyer_person_id: conformite.MASKED, offer_id: conformite.MASKED })]);
    expect(JSON.stringify(seller)).not.toContain(t.buyerId);
    expect(await filesSeenBy(t, t.buyerId)).toEqual([fileId]);
  });

  it('[R96] un mandat annulé ou rétracté ne fait pas le vendeur du dossier', async () => {
    const annule = await setupOffre();
    const older = await otherMandate(annule, 'Ancienne', '2026-01-10T09:00:00.000Z');
    const fileA = await openFile(annule, () => cancel(annule, annule.mandateId));
    expect((await sellerOf(annule, fileA))?.person_id).toBe(older.personId);
    expect(await filesSeenBy(annule, annule.personId)).toEqual([]);

    const retracte = await setupOffre();
    const fileR = await openFile(retracte, async () => {
      await retracte.db.run("INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, 'Lettre reçue', ?, 'test', ?)", [retracte.mandateId, retracte.network.id, '2027-02-20T09:00:00.000Z', '2027-02-20T09:00:00.000Z']);
    });
    expect(await sellerOf(retracte, fileR)).toBeNull();
    expect(await filesSeenBy(retracte, retracte.personId)).toEqual([]);
  });

  it('le dossier et son vendeur sont rangés ensemble ; une seconde ouverture ne change rien, et le vendeur est figé', async () => {
    const t = await setupOffre();
    const fileId = await openFile(t);
    const offer = (await t.db.first<{ offer_id: string }>('SELECT offer_id FROM sale_files WHERE id = ?', [fileId]))!;
    expect(await new DossiersVente(t.db, t.acces, t.journal, { now: t.now }).open(t.agent, offer.offer_id)).toMatchObject({ ok: false, code: 'already_open' });
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sale_file_sellers'))!.n).toBe(1);
    await expect(t.db.run('UPDATE sale_file_sellers SET person_id = ?', [t.buyerId])).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM sale_file_sellers')).rejects.toThrow(/rien ne s'efface/);
  });

  it('les dossiers déjà ouverts reçoivent leur vendeur par la migration, sans toucher à ceux qui en ont un', async () => {
    const t = await setupDossier();
    const seller = await t.db.first<{ file_id: string; person_id: string }>('SELECT file_id, person_id FROM sale_file_sellers');
    const b2 = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'REF-M-2', kind: 'land', city: 'Talant', priceEur: 90000, status: 'under_offer' });
    const insertMandate = (id: string, personId: string, signedAt: string) => t.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'site', 'test', ?)", [id, t.network.id, t.alexId, personId, b2.id, signedAt, signedAt]);
    await insertMandate('non-inscrit', t.buyerId, '2027-02-20T09:00:00.000Z');
    await insertMandate('inscrit', t.personId, '2027-02-11T09:00:00.000Z');
    await insertMandate('apres', t.buyerId, '2027-03-05T09:00:00.000Z');
    const seq = (await t.db.first<{ n: number }>('SELECT MAX(seq) + 1 AS n FROM mandate_register WHERE network_id = ?', [t.network.id]))!.n;
    await t.db.run("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', 'inscrit', ?, 'T-M', ?, ?, '2027-02-11T09:00:00.000Z', '2027-02-11T09:00:00.000Z', 'test', 'p', 'h-m')", [t.network.id, seq, 7000 + seq, t.alexId, b2.id]);
    await t.db.run("INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES ('offre-m', ?, ?, 1, ?, 90000, '[]', '2027-03-10', 0, 90000, 'r', '2027-03-01T09:00:00.000Z', ?, '2027-03-01T09:00:00.000Z', 'test', 'p', 'h-offre-m')", [t.network.id, b2.id, t.buyerId, t.alexId]);
    await t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('dossier-m', ?, ?, 'offre-m', ?, 90000, '2027-03-01T13:00:00.000Z', 'test')", [t.network.id, b2.id, t.buyerId]);

    const sql = readFileSync(new URL('../../../db/migrations/1550_vendeur_dossier.sql', import.meta.url), 'utf8');
    await t.db.run(sql.slice(sql.indexOf('INSERT OR IGNORE')));

    expect(await sellerOf(t, 'dossier-m')).toEqual({ person_id: t.personId, mandate_id: 'inscrit' });
    expect((await sellerOf(t, seller!.file_id))?.person_id).toBe(seller!.person_id);
  });
});
