import { expect, it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { IndicateursParcours, median } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : le dossier de M10, son acte du 10 juin 2027, ses contacts.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000002.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

async function world() {
  const t = await setupDossier('appartement');
  await t.startCompromis();
  t.setClock(at9('2027-03-11'));
  const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
  for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10']] as const) {
    const r = await e.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
    if (!r.ok) throw new Error(r.code);
  }
  const status = await t.pieces.status(t.agent, t.fileId);
  if (!status.ok) throw new Error(status.code);
  for (const piece of status.value.missing) {
    const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
    if (!r.ok) throw new Error(r.code);
  }
  t.setClock(at9('2027-06-11'));
  const acte = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
  if (!acte.ok) throw new Error(acte.code);
  const read = async (from: string, to: string) => {
    const r = await new IndicateursParcours(t.db, t.journal, { now: t.now }).of(t.direction, { from, to });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { ...t, read };
}

describeWithSqlite('IN03 · indicateurs du parcours', () => {
  it('[R214] la médiane, à la main', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 4, 10])).toBe(3);
  });

  it('[R214] du mandat à l’offre acceptée, puis de l’offre à l’acte, recalculés à la main', async () => {
    const t = await world();
    const mandate = (await t.db.first<{ signed_at: string; id: string }>('SELECT m.signed_at, m.id FROM mandates m JOIN sale_files f ON f.property_id = m.property_id WHERE f.id = ?', [t.fileId]))!;
    // La réponse du vendeur du jeu : le 1er mars 2027, l'acte le 10 juin : 101 jours.
    const v = await t.read('2026-11-01', '2027-06-30');
    expect(v.offerToActDays).toEqual({ values: [101], median: 101, unmeasured: 0 });
    const expected = Math.round((Date.parse('2027-03-01T12:00:00Z') - Date.parse(`${new Date(mandate.signed_at).toISOString().slice(0, 10)}T12:00:00Z`)) / 86_400_000);
    expect(v.mandateToOfferDays).toEqual({ values: [expected], median: expected, unmeasured: 0 });
    // Hors période : ni l'un ni l'autre.
    const empty = await t.read('2027-07-01', '2027-07-31');
    expect(empty.offerToActDays).toEqual({ values: [], median: null, unmeasured: 0 });
    expect(empty.mandateToOfferDays.median).toBeNull();
  });

  it('[R214] un mandat retiré ne sert pas de départ : le dossier se dit impossible à mesurer, jamais zéro', async () => {
    const t = await world();
    const row = (await t.db.first<{ id: string }>('SELECT m.id FROM mandates m JOIN sale_files f ON f.property_id = m.property_id WHERE f.id = ?', [t.fileId]))!;
    await t.db.run('INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [row.id, t.network.id, 'preuve inventée', '2027-01-01T00:00:00.000Z', 'x', '2027-01-01T00:00:00.000Z']);
    const v = await t.read('2026-11-01', '2027-06-30');
    expect(v.mandateToOfferDays).toEqual({ values: [], median: null, unmeasured: 1 });
  });

  it('[R214] sans contact, sans rendez-vous : le taux est absent, pas zéro ; les totaux sont ceux du tableau de bord', async () => {
    const t = await world();
    const v = await t.read('2027-07-01', '2027-07-31');
    expect(v.conversion.appointmentsPerContact).toEqual({ numerator: 0, denominator: 0, bp: null });
    expect(v.conversion.salesPerMandate.bp).toBeNull();
    expect(v.networkReferredMandates.bp).toBeNull();
    expect(v.valuationToMandateMinutes).toMatchObject({ values: [], median: null, unmeasured: 0, underTarget: 0, targetMinutes: 10 });
    const june = await t.read('2027-06-01', '2027-06-30');
    expect(june.conversion.salesPerMandate.numerator).toBe(1);
  });

  it('[R214] la part des mandats avec un client transmis : une attribution avant la signature, pas après', async () => {
    const t = await world();
    const m = (await t.db.first<{ person_id: string; agent_id: string; signed_at: string }>('SELECT person_id, agent_id, signed_at FROM mandates LIMIT 1'))!;
    const month = m.signed_at.slice(0, 7);
    const range = [`${month}-01`, `${month}-28`] as const;
    const before = await t.read(...range);
    expect(before.networkReferredMandates.numerator).toBe(0);
    const insert = (id: string, at: string) => t.db.run('INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, 2, NULL, ?)', [id, t.network.id, m.person_id, m.agent_id, 'zone', at]);
    await insert('at-apres', new Date(Date.parse(m.signed_at) + 3_600_000).toISOString());
    expect((await t.read(...range)).networkReferredMandates.numerator).toBe(0);
    await insert('at-avant', new Date(Date.parse(m.signed_at) - 3_600_000).toISOString());
    const after = await t.read(...range);
    expect(after.networkReferredMandates.numerator).toBe(1);
    expect(after.networkReferredMandates.bp).toBe(Math.round(10_000 / after.networkReferredMandates.denominator));
  });

  it('[R214] de l’avis validé à la signature : les minutes, la cible de 10 minutes, et une signature sans avis dite à part', async () => {
    const t = await world();
    await t.db.run('PRAGMA foreign_keys = OFF');
    const doc = (id: string, propertyId: string | null, createdAt: string) =>
      t.db.run(
        `INSERT INTO documents (id, network_id, template_id, template_version, template_hash, kind, mode, status, missing, agent_id, person_id, property_id, content, content_hash, created_by, created_at)
         VALUES (?, ?, 'tpl', 1, 'h', 'mandat_vente_simple', 'reel', 'complet', '[]', 'a', 'p', ?, 'texte', 'h', 'x', ?)`,
        [id, t.network.id, propertyId, createdAt],
      );
    const signed = (id: string, completedAt: string) =>
      t.db.run(`INSERT INTO signed_documents (document_id, network_id, signed_at, place, scan_ref, mandate_id, registered_by, created_at, completed_at) VALUES (?, ?, ?, 'agence', ?, ?, 'x', ?, ?)`, [id, t.network.id, completedAt, `scan-${id}`, `m-${id}`, completedAt, completedAt]);
    const property = 'bien-invente';
    await t.db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES ('avis-1', ?, ?, NULL, 'validated', '{}', 1, 2, 'texte', 'agent', '2027-08-02T08:00:00.000Z', '2027-08-02T08:00:00.000Z', 'x', '2027-08-02T08:00:00.000Z')`,
      [t.network.id, property],
    );
    await doc('d-1', property, '2027-08-02T08:03:00.000Z');
    await signed('d-1', '2027-08-02T08:07:00.000Z');
    await doc('d-2', property, '2027-08-02T08:04:00.000Z');
    await signed('d-2', '2027-08-02T08:21:00.000Z');
    await doc('d-3', null, '2027-08-03T08:00:00.000Z');
    await signed('d-3', '2027-08-03T08:30:00.000Z');
    // Un avis validé après le document ne compte pas pour lui.
    await doc('d-4', 'autre-bien', '2027-08-04T08:00:00.000Z');
    await signed('d-4', '2027-08-04T08:30:00.000Z');
    await t.db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES ('avis-2', ?, 'autre-bien', NULL, 'validated', '{}', 1, 2, 'texte', 'agent', '2027-08-04T08:10:00.000Z', '2027-08-04T08:10:00.000Z', 'x', '2027-08-04T08:10:00.000Z')`,
      [t.network.id],
    );
    const v = await t.read('2027-08-01', '2027-08-31');
    expect(v.valuationToMandateMinutes).toEqual({ values: [7, 21], median: 14, unmeasured: 2, underTarget: 1, targetMinutes: 10 });
  });

  it('[R14] [R214] aucun agent, aucune personne ni aucun identifiant dans la réponse', async () => {
    const t = await world();
    const text = JSON.stringify(await t.read('2026-11-01', '2027-06-30'));
    for (const secret of [t.alexId, t.sam.userId, t.fileId, t.offerId]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/agent|person/i);
  });
});
