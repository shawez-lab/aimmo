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

type World = Awaited<ReturnType<typeof world>>;

/** Un mandat signé, inscrit à la ligne suivante du registre, clés étrangères coupées par le test. */
async function liveMandate(t: World, id: string, signedAt: string, personId = 'p-x') {
  await t.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, 'referral', 'x', ?)", [id, t.network.id, t.alexId, personId, signedAt, signedAt]);
  const seq = Number((await t.db.first<{ n: number | null }>('SELECT MAX(seq) AS n FROM mandate_register WHERE network_id = ?', [t.network.id]))?.n ?? 0) + 1;
  await t.db.run("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, signed_at, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', ?, ?, ?, ?, ?, ?, 'x', 'p', ?)", [t.network.id, seq, id, 1000 + seq, `T-${1000 + seq}`, t.alexId, signedAt, signedAt, `h-${id}`]);
  return seq;
}
const withdraw = (t: World, id: string) => t.db.run('INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, t.network.id, 'preuve inventée', '2027-01-01T00:00:00.000Z', 'x', '2027-01-01T00:00:00.000Z']);
async function cancelLine(t: World, id: string, reason: string) {
  const line = (await t.db.first<{ seq: number; number_value: number; number: string; signed_at: string }>("SELECT seq, number_value, number, signed_at FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'", [id]))!;
  const seq = Number((await t.db.first<{ n: number }>('SELECT MAX(seq) AS n FROM mandate_register WHERE network_id = ?', [t.network.id]))!.n) + 1;
  await t.db.run("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, signed_at, cancels_seq, reason, at, actor, prev_hash, hash) VALUES (?, ?, 'annulation', ?, ?, ?, ?, ?, ?, ?, ?, 'x', 'p', ?)", [t.network.id, seq, id, line.number_value, line.number, t.alexId, line.signed_at, line.seq, reason, line.signed_at, `h-c-${id}`]);
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

  it('[R214] sans contact, sans rendez-vous : le taux est absent, pas zéro ; les ventes sont celles du tableau de bord', async () => {
    const t = await world();
    const v = await t.read('2027-07-01', '2027-07-31');
    expect(v.conversion.appointmentsPerContact).toEqual({ numerator: 0, denominator: 0, bp: null });
    expect(v.conversion.salesPerMandate.bp).toBeNull();
    expect(v.networkReferredMandates.bp).toBeNull();
    expect(v.valuationToMandateMinutes).toMatchObject({ values: [], median: null, unmeasured: 0, underTarget: 0, targetMinutes: 10 });
    const june = await t.read('2027-06-01', '2027-06-30');
    expect(june.conversion.salesPerMandate.numerator).toBe(1);
  });

  it('[R214] la part des mandats avec un client transmis : avant la signature, pas un client déjà suivi, fiches réunies comprises', async () => {
    const t = await world();
    await t.db.run('PRAGMA foreign_keys = OFF');
    const range = ['2027-10-01', '2027-10-31'] as const;
    const SIGNED = '2027-10-10T10:00:00.000Z';
    const attribution = (id: string, personId: string, reason: string, at: string) => t.db.run('INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, 2, NULL, ?)', [id, t.network.id, personId, t.alexId, reason, at]);
    await liveMandate(t, 'm-a', SIGNED, 'p-a');
    await liveMandate(t, 'm-b', SIGNED, 'p-b');
    await liveMandate(t, 'm-c', SIGNED, 'p-c');
    await liveMandate(t, 'm-d', SIGNED, 'p-d');
    await attribution('at-a', 'p-a', 'zone', '2027-10-09T10:00:00.000Z'); // transmis avant : compte
    await attribution('at-b', 'p-b', 'zone', '2027-10-11T10:00:00.000Z'); // après la signature : ne compte pas
    await attribution('at-c', 'p-c', 'already_followed', '2027-10-09T10:00:00.000Z'); // déjà suivi : ne compte pas
    await attribution('at-d', 'p-d-ancienne', 'zone', '2027-10-09T10:00:00.000Z'); // sur une fiche réunie depuis
    expect((await t.read(...range)).networkReferredMandates.numerator).toBe(1);
    await t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES ('fus-1', ?, NULL, 'p-d', 'p-d-ancienne', 'doublon inventé', '2027-10-09T12:00:00.000Z', '2027-10-09T12:00:00.000Z')", [t.network.id]);
    expect((await t.read(...range)).networkReferredMandates).toEqual({ numerator: 2, denominator: 4, bp: 5000 });
  });

  it('[R214] les taux, recalculés à la main : une réattribution n’ajoute pas un contact, un mandat retiré ou pas inscrit ne compte pas', async () => {
    const t = await world();
    await t.db.run('PRAGMA foreign_keys = OFF');
    const range = ['2027-11-01', '2027-11-30'] as const;
    const attribution = (id: string, replaces: string | null) => t.db.run("INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, 'p-x', NULL, ?, ?, 2, ?, '2027-11-03T10:00:00.000Z')", [id, t.network.id, t.alexId, replaces ? 'reassigned' : 'zone', replaces]);
    await attribution('c-1', null);
    await attribution('c-1b', 'c-1');
    await attribution('c-1c', 'c-1b');
    await attribution('c-2', null);
    for (const id of ['r-1', 'r-2', 'r-3']) {
      await t.db.run("INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES (?, ?, ?, 'p-x', NULL, 'estimation', '2027-11-04T08:00:00.000Z', '2027-11-04T09:00:00.000Z', 'honored', ?, 'agent', NULL, '2027-11-01T08:00:00.000Z', '2027-11-01T08:00:00.000Z')", [id, t.network.id, t.alexId, id]);
    }
    await liveMandate(t, 'm-1', '2027-11-05T10:00:00.000Z');
    await liveMandate(t, 'm-2', '2027-11-06T10:00:00.000Z');
    await liveMandate(t, 'm-retire', '2027-11-07T10:00:00.000Z');
    await withdraw(t, 'm-retire');
    await liveMandate(t, 'm-erreur', '2027-11-08T10:00:00.000Z');
    await cancelLine(t, 'm-erreur', 'error');
    await liveMandate(t, 'm-resilie', '2027-11-09T10:00:00.000Z');
    await cancelLine(t, 'm-resilie', 'termination');
    await t.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES ('m-pas-inscrit', ?, ?, 'p-x', '2027-11-10T10:00:00.000Z', 'referral', 'x', '2027-11-10T10:00:00.000Z')", [t.network.id, t.alexId]);
    const v = await t.read(...range);
    expect(v.conversion.appointmentsPerContact).toEqual({ numerator: 3, denominator: 2, bp: 15_000 });
    expect(v.conversion.mandatesPerAppointment).toEqual({ numerator: 3, denominator: 3, bp: 10_000 });
    expect(v.conversion.salesPerMandate).toEqual({ numerator: 0, denominator: 3, bp: 0 });
  });

  it('[R214] une offre acceptée après contre-offre : la date est celle de la dernière proposition, sans dossier ouvert aussi', async () => {
    const t = await world();
    await t.db.run('PRAGMA foreign_keys = OFF');
    const property = (await t.db.first<{ property_id: string }>('SELECT property_id FROM sale_files WHERE id = ?', [t.fileId]))!.property_id;
    const seq = (await t.db.first<{ n: number }>('SELECT MAX(seq) AS n FROM offer_register WHERE property_id = ?', [property]))!.n + 1;
    await t.db.run(
      `INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash)
       VALUES ('of-co', ?, ?, ?, 'p-x', 100000, '[]', '2028-01-01', 0, 0, 'ref', '2027-12-01T10:00:00.000Z', ?, '2027-12-01T10:00:00.000Z', 'x', 'p', 'hash-of-co')`,
      [t.network.id, property, seq, t.alexId],
    );
    await t.db.run("INSERT INTO offer_responses (offer_id, network_id, outcome, proof_ref, responded_at, recorded_by, at) VALUES ('of-co', ?, 'contre_offre', 'ref', '2027-12-02T10:00:00.000Z', 'x', '2027-12-02T10:00:00.000Z')", [t.network.id]);
    const v0 = await t.read('2027-12-01', '2027-12-31');
    expect(v0.mandateToOfferDays.values).toEqual([]); // pas encore acceptée
    const proposal = (id: string, n: number, side: string) => t.db.run("INSERT INTO offer_proposals (id, offer_id, network_id, seq, side, amount_eur, valid_until, proof_ref, created_by, at) VALUES (?, 'of-co', ?, ?, ?, 100000, '2028-01-01', 'ref', 'x', '2027-12-03T10:00:00.000Z')", [id, t.network.id, n, side]);
    const answer = (id: string, outcome: string, at: string) => t.db.run("INSERT INTO proposal_responses (proposal_id, outcome, proof_ref, responded_at, recorded_by, at) VALUES (?, ?, 'ref', ?, 'x', ?)", [id, outcome, at, at]);
    await proposal('pr-1', 1, 'vendeur');
    await answer('pr-1', 'contre_offre', '2027-12-05T10:00:00.000Z');
    await proposal('pr-2', 2, 'acquereur');
    await answer('pr-2', 'acceptee', '2027-12-08T10:00:00.000Z');
    const m = (await t.db.first<{ signed_at: string }>("SELECT signed_at FROM mandates WHERE property_id = ? ORDER BY signed_at DESC LIMIT 1", [property]))!;
    const expected = Math.round((Date.parse('2027-12-08T12:00:00Z') - Date.parse(`${m.signed_at.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
    expect((await t.read('2027-12-01', '2027-12-31')).mandateToOfferDays).toEqual({ values: [expected], median: expected, unmeasured: 0 });
    // Le vendeur dit non à la toute dernière proposition : l'ancienne acceptation n'existe pas, rien n'est mesuré.
    await proposal('pr-3', 3, 'vendeur');
    await answer('pr-3', 'refusee', '2027-12-09T10:00:00.000Z');
    expect((await t.read('2027-12-01', '2027-12-31')).mandateToOfferDays.values).toEqual([]);
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
    const signed = async (id: string, completedAt: string) => {
      await liveMandate(t, `m-${id}`, completedAt);
      await t.db.run(`INSERT INTO signed_documents (document_id, network_id, signed_at, place, scan_ref, mandate_id, registered_by, created_at, completed_at) VALUES (?, ?, ?, 'agence', ?, ?, 'x', ?, ?)`, [id, t.network.id, completedAt, `scan-${id}`, `m-${id}`, completedAt, completedAt]);
    };
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
    // À la borne : 10 minutes pile, comme la chronologie, n'est pas sous la cible. Un mandat retiré ne compte plus.
    await doc('d-5', property, '2027-09-02T08:00:00.000Z');
    await t.db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES ('avis-3', ?, ?, NULL, 'validated', '{}', 1, 2, 'texte', 'agent', '2027-09-02T07:59:00.000Z', '2027-09-02T07:59:00.000Z', 'x', '2027-09-02T07:59:00.000Z')`,
      [t.network.id, property],
    );
    await signed('d-5', '2027-09-02T08:09:00.000Z');
    expect((await t.read('2027-09-01', '2027-09-30')).valuationToMandateMinutes).toMatchObject({ values: [10], underTarget: 0 });
    await withdraw(t, 'm-d-5');
    expect((await t.read('2027-09-01', '2027-09-30')).valuationToMandateMinutes.values).toEqual([]);
  });

  it('[R14] [R214] aucun agent, aucune personne ni aucun identifiant dans la réponse', async () => {
    const t = await world();
    const text = JSON.stringify(await t.read('2026-11-01', '2027-06-30'));
    for (const secret of [t.alexId, t.sam.userId, t.fileId, t.offerId]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/agent|person/i);
  });
});
