import { expect, it } from 'vitest';
import { Echeancier, buyerWithdrawalLastDay } from '../src/dossiers/echeancier.ts';
import { REGISTERED_LETTER_PURPOSE, RecommandeElectronique, letterText } from '../src/documents/recommande.ts';
import { FakeChannel } from '../src/envoi/canaux.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Dossier, acquéreur, adresse et preuves inventés. Jeudi 11 mars 2027, 10 h à Paris.
const THU_10H = new Date('2027-03-11T09:00:00.000Z');
let proofs = 0;

async function setup(o: { consent?: boolean; real?: boolean } = {}) {
  const t = await setupDossier('maison');
  const port = new FakeChannel('email');
  const lre = new RecommandeElectronique(t.db, t.acces, t.journal, t.storage, { now: t.now, ...(o.real === false ? {} : { port }) });
  const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
  await t.startCompromis();
  t.setClock(THU_10H);
  const signed = await echeancier.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
  if (!signed.ok) throw new Error(signed.code);
  await t.store.addIdentifier({ networkId: t.network.id, personId: t.buyerId, kind: 'email', value: 'acheteur@example.test' });
  if (o.consent !== false) {
    await t.store.addConsent({ networkId: t.network.id, personId: t.buyerId, purpose: REGISTERED_LETTER_PURPOSE, channel: 'email', proof: 'accord écrit au compromis (test)', givenAt: new Date('2027-03-10T09:00:00.000Z') });
  }
  /** Une preuve du prestataire, rangée au faux stockage. */
  const proof = () => {
    proofs += 1;
    const ref = `preuves/0b6f1d2e-7777-4a2b-8c3d-${String(proofs).padStart(12, '0')}.pdf`;
    t.storage.refs.add(ref);
    return ref;
  };
  const compromis = t.upload();
  const ready = async () => {
    const p = await lre.prepare(t.agent, t.fileId, { documentRef: compromis });
    if (!p.ok) throw new Error(p.code);
    return p.value.id;
  };
  const sendNow = async () => {
    const id = await ready();
    const s = await lre.send(t.agent, id);
    if (!s.ok) throw new Error(s.code);
    t.setClock(new Date(THU_10H.getTime() + 3_600_000));
    return { id, sent: s.value };
  };
  const fill = async (id: string, kind: string, occurredAt: string, ref = proof(), providerRef = 'fake-1') => lre.recordProof({ letterId: id, providerRef, kind, occurredAt, proofRef: ref });
  return { ...t, port, lre, echeancier, proof, compromis, ready, sendNow, fill };
}

const line = (s: { lines: { deadline: string; day: string | null; status: string }[] }) => s.lines.find((l) => l.deadline === 'fin_retractation')!;

describeWithSqlite('HX36 · lettre recommandée électronique et notification de l’avant-contrat', () => {
  it('[R460] la date de première présentation de la preuve remplit seule l’échéancier et lance le calcul de la rétractation', async () => {
    const t = await setup();
    const { id } = await t.sendNow();
    // Avant la première présentation : la rétractation attend sa date.
    const before = await t.echeancier.schedule(t.agent, t.fileId);
    if (!before.ok) throw new Error(before.code);
    expect(line(before.value)).toMatchObject({ status: 'a_saisir', day: null });
    const depot = await t.fill(id, 'depot', '2027-03-11T09:00:30.000Z');
    expect(depot).toMatchObject({ ok: true, value: { schedule: null, letter: { status: 'deposee' } } });
    // Première présentation le vendredi 12 mars à 23 h 30 en temps universel : le samedi 13 à Paris.
    t.setClock(new Date('2027-03-13T08:00:00.000Z'));
    const ref = t.proof();
    const r = await t.fill(id, 'premiere_presentation', '2027-03-12T23:30:00.000Z', ref);
    if (!r.ok) throw new Error(r.code);
    expect(buyerWithdrawalLastDay('2027-03-13')).toBe('2027-03-23');
    expect(r.value.schedule).toEqual({ filled: true, reason: 'ecrite', day: '2027-03-13', withdrawalLastDay: '2027-03-23' });
    const after = await t.echeancier.schedule(t.agent, t.fileId);
    if (!after.ok) throw new Error(after.code);
    expect(line(after.value)).toMatchObject({ status: 'datee', day: '2027-03-23', source: 'calcul', from: 'notification_acquereur' });
    expect(after.value.dates.notification_acquereur).toEqual({ day: '2027-03-13', version: 1 });
    // Écrite par le système, avec la preuve même du prestataire : personne n'a rien ressaisi.
    expect(await t.db.all("SELECT day, proof_ref, by FROM sale_file_dates WHERE file_id = ? AND kind = 'notification_acquereur'", [t.fileId])).toEqual([{ day: '2027-03-13', proof_ref: ref, by: 'system:recommande' }]);
    // La même preuve reçue deux fois : rien ne change, aucune version de plus.
    expect(await t.fill(id, 'premiere_presentation', '2027-03-12T23:30:00.000Z', ref)).toMatchObject({ ok: true, value: { schedule: null } });
    // Refusée ou non réclamée, la lettre a été présentée : la date reste.
    const refused = await t.fill(id, 'refus', '2027-03-13T07:00:00.000Z');
    expect(refused).toMatchObject({ ok: true, value: { letter: { status: 'refus' }, schedule: null } });
    expect(await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM sale_file_dates WHERE file_id = ? AND kind = 'notification_acquereur'", [t.fileId])).toEqual({ n: 1 });
  });

  it('[R460] [R17] la preuve l’emporte sur une date saisie à la main, qui reste ; une date hors de l’ordre du compromis n’est pas écrite', async () => {
    const t = await setup();
    const { id } = await t.sendNow();
    const typed = await t.echeancier.record(t.agent, t.fileId, { kind: 'notification_acquereur', day: '2027-03-11', proofRef: PROOF });
    if (!typed.ok) throw new Error(typed.code);
    await t.fill(id, 'depot', '2027-03-11T09:01:00.000Z');
    t.setClock(new Date('2027-03-12T10:00:00.000Z'));
    const r = await t.fill(id, 'premiere_presentation', '2027-03-12T09:00:00.000Z');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.schedule).toMatchObject({ filled: true, reason: 'ecrite', day: '2027-03-12', withdrawalLastDay: '2027-03-22' });
    expect(await t.db.all("SELECT version, day, by FROM sale_file_dates WHERE file_id = ? AND kind = 'notification_acquereur' ORDER BY version", [t.fileId])).toEqual([
      { version: 1, day: '2027-03-11', by: `agent:${t.alexId}` },
      { version: 2, day: '2027-03-12', by: 'system:recommande' },
    ]);

    // Une autre lettre, dont la présentation précéderait la signature corrigée du compromis : rien n'est écrit, la raison est dite.
    const u = await setup();
    const sent = await u.sendNow();
    await u.fill(sent.id, 'depot', '2027-03-11T09:01:00.000Z');
    // La signature corrigée au 12 mars après l'envoi : la présentation du 11 la précéderait.
    u.setClock(new Date('2027-03-12T10:00:00.000Z'));
    const corrected = await u.echeancier.record(u.agent, u.fileId, { kind: 'compromis_signe', day: '2027-03-12', proofRef: PROOF });
    if (!corrected.ok) throw new Error(corrected.code);
    const late = await u.fill(sent.id, 'premiere_presentation', '2027-03-11T10:00:00.000Z');
    if (!late.ok) throw new Error(late.code);
    expect(late.value.schedule).toEqual({ filled: false, reason: 'before_compromis', day: '2027-03-11', withdrawalLastDay: null });
    expect(await u.db.first("SELECT 1 AS x FROM sale_file_dates WHERE file_id = ? AND kind = 'notification_acquereur'", [u.fileId])).toBeNull();
    expect(await u.db.first("SELECT 1 AS x FROM journal WHERE type = 'dossier.recommande_date_non_ecrite'")).toEqual({ x: 1 });
  });

  it('[R461] la lettre ne part que par le contrôle central, au geste de l’agent du bien, avec l’accord de l’acquéreur, une seule fois', async () => {
    const t = await setup({ consent: false });
    // Seul l'agent du bien prépare et envoie.
    expect(await t.lre.prepare(t.direction, t.fileId, { documentRef: t.compromis })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.lre.prepare(t.sam, t.fileId, { documentRef: t.compromis })).toMatchObject({ ok: false });
    // Le compromis joint doit être rangé au dossier.
    expect(await t.lre.prepare(t.agent, t.fileId, { documentRef: 'dossiers/autre/0b6f1d2e-4444-4a2b-8c3d-000000000999.pdf' })).toEqual({ ok: false, rule: null, code: 'bad_ref' });
    expect(await t.lre.prepare(t.agent, t.fileId, { documentRef: `dossiers/${t.fileId}/0b6f1d2e-4444-4a2b-8c3d-000000000999.pdf` })).toEqual({ ok: false, rule: 'R462', code: 'not_stored' });
    const id = await t.ready();
    expect(await t.lre.send(t.direction, id)).toMatchObject({ ok: false, rule: 'R16' });
    // Sans l'accord de l'acquéreur à la voie électronique, le contrôle central refuse : rien ne part.
    const noConsent = await t.lre.send(t.agent, id);
    expect(noConsent).toMatchObject({ ok: true, value: { sent: false, rule: 'R03', status: 'preparee' } });
    expect(t.port.sent).toHaveLength(0);
    // La nuit, même avec l'accord : refusé pour l'heure, le geste se refait le matin.
    await t.store.addConsent({ networkId: t.network.id, personId: t.buyerId, purpose: REGISTERED_LETTER_PURPOSE, channel: 'email', proof: 'accord écrit au compromis (test)', givenAt: new Date('2027-03-10T09:00:00.000Z') });
    t.setClock(new Date('2027-03-11T21:30:00.000Z'));
    expect(await t.lre.send(t.agent, id)).toMatchObject({ ok: true, value: { sent: false, rule: 'R01' } });
    t.setClock(new Date('2027-03-12T08:00:00.000Z'));
    const ok = await t.lre.send(t.agent, id);
    expect(ok).toMatchObject({ ok: true, value: { sent: true, rule: null, status: 'envoyee' } });
    expect(t.port.sent).toHaveLength(1);
    // Le texte est celui du code, tel quel : sans mention d'assistant, sans prix ni adresse.
    expect(t.port.sent[0]!.body).toBe(letterText({ firstName: 'Acheteur', signedOn: '2027-03-10', agentName: 'Alex Agent' }));
    expect(t.port.sent[0]!.body).toContain('10 mars 2027');
    expect(t.port.sent[0]!.body).not.toMatch(/assistant|€|rue/i);
    expect(t.port.sent[0]!.to).toBe('acheteur@example.test');
    // Passée par le contrôle central : rangée au journal des envois.
    expect(await t.db.all("SELECT outcome, rule FROM send_log WHERE person_id = ? ORDER BY rowid", [t.buyerId])).toEqual([
      { outcome: 'refused', rule: 'R03' },
      { outcome: 'refused', rule: 'R01' },
      { outcome: 'sent', rule: null },
    ]);
    // Une seule fois : ni la même lettre, ni une nouvelle lettre du même dossier.
    expect(await t.lre.send(t.agent, id)).toEqual({ ok: false, rule: 'R461', code: 'already_sent' });
    expect(await t.lre.prepare(t.agent, t.fileId, { documentRef: t.compromis })).toEqual({ ok: false, rule: 'R461', code: 'already_sent' });
    expect(t.port.sent).toHaveLength(1);
    // Le journal ne porte ni adresse ni texte.
    const events = JSON.stringify(await t.db.all("SELECT data FROM journal WHERE type LIKE 'dossier.recommande%'"));
    for (const s of ['acheteur@example.test', 'rétractation', 'Acheteur']) expect(events).not.toContain(s);
  });

  it('[R461] une signature corrigée après la préparation demande une nouvelle lettre', async () => {
    const t = await setup();
    const id = await t.ready();
    const corrected = await t.echeancier.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-09', proofRef: PROOF });
    if (!corrected.ok) throw new Error(corrected.code);
    expect(await t.lre.send(t.agent, id)).toEqual({ ok: false, rule: null, code: 'changed' });
    expect(t.port.sent).toHaveLength(0);
    const fresh = await t.ready();
    expect(await t.lre.send(t.agent, fresh)).toMatchObject({ ok: true, value: { sent: true } });
    expect(t.port.sent[0]!.body).toContain('9 mars 2027');
  });

  it('[R462] chaque preuve du prestataire est rangée au dossier, dans l’ordre, une seule fois, en ajout seul', async () => {
    const t = await setup();
    const id = await t.ready();
    // Pas de preuve avant l'envoi.
    expect(await t.fill(id, 'depot', '2027-03-11T09:00:00.000Z')).toEqual({ ok: false, rule: 'R461', code: 'not_sent' });
    const s = await t.lre.send(t.agent, id);
    if (!s.ok) throw new Error(s.code);
    t.setClock(new Date('2027-03-11T10:00:00.000Z'));
    // Une preuve non rangée, mal formée, d'une autre lettre, datée du futur ou d'avant l'envoi : refusée.
    expect(await t.lre.recordProof({ letterId: id, providerRef: 'fake-1', kind: 'depot', occurredAt: '2027-03-11T09:00:00.000Z', proofRef: 'preuves/0b6f1d2e-7777-4a2b-8c3d-999999999999.pdf' })).toEqual({ ok: false, rule: 'R462', code: 'not_stored' });
    expect(await t.fill(id, 'depot', '2027-03-11T09:00:00.000Z', 'ailleurs/x.pdf')).toEqual({ ok: false, rule: 'R462', code: 'bad_ref' });
    expect(await t.fill(id, 'depot', '2027-03-11T09:00:00.000Z', t.proof(), 'fake-2')).toEqual({ ok: false, rule: 'R462', code: 'unknown_ref' });
    expect(await t.fill(id, 'depot', '2027-03-11T11:00:00.000Z')).toEqual({ ok: false, rule: null, code: 'bad_time' });
    expect(await t.fill(id, 'depot', '2027-03-11T08:59:00.000Z')).toEqual({ ok: false, rule: null, code: 'out_of_order' });
    expect(await t.fill(id, 'tampon', '2027-03-11T09:00:00.000Z')).toEqual({ ok: false, rule: null, code: 'unknown_proof' });
    // Présentée avant d'être déposée : refusé.
    expect(await t.fill(id, 'premiere_presentation', '2027-03-11T09:00:00.000Z')).toEqual({ ok: false, rule: null, code: 'out_of_order' });
    const depotRef = t.proof();
    expect(await t.fill(id, 'depot', '2027-03-11T09:00:00.000Z', depotRef)).toMatchObject({ ok: true });
    // Un second dépôt, ou la même preuve pour un autre fait : refusé.
    expect(await t.fill(id, 'depot', '2027-03-11T09:00:10.000Z')).toEqual({ ok: false, rule: 'R462', code: 'already_recorded' });
    expect(await t.fill(id, 'premiere_presentation', '2027-03-11T09:00:20.000Z', depotRef)).toEqual({ ok: false, rule: 'R462', code: 'proof_used' });
    const presented = t.proof();
    expect(await t.fill(id, 'premiere_presentation', '2027-03-11T09:00:20.000Z', presented)).toMatchObject({ ok: true });
    expect(await t.fill(id, 'acceptation', '2027-03-11T09:00:30.000Z')).toMatchObject({ ok: true, value: { letter: { status: 'acceptation' } } });
    // Une seule suite : acceptée, refusée ou non réclamée.
    expect(await t.fill(id, 'non_reclamee', '2027-03-11T09:00:40.000Z')).toEqual({ ok: false, rule: 'R462', code: 'already_recorded' });
    // Rangées au dossier : l'agent, la direction et la conformité les lisent avec leur référence.
    for (const viewer of [t.agent, t.direction]) {
      const l = await t.lre.letters(viewer, t.fileId);
      if (!l.ok) throw new Error(l.code);
      expect(l.value).toHaveLength(1);
      expect(l.value[0]!.documentRef).toBe(t.compromis);
      expect(l.value[0]!.events.map((e) => [e.kind, e.proofRef])).toEqual([
        ['envoi', null],
        ['depot', depotRef],
        ['premiere_presentation', presented],
        ['acceptation', expect.stringMatching(/^preuves\//)],
      ]);
    }
    expect(await t.lre.letters(t.sam, t.fileId)).toMatchObject({ ok: false });
    // Rien ne s'efface ni ne se réécrit.
    await expect(t.db.run('DELETE FROM registered_letter_events WHERE letter_id = ?', [id])).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE registered_letter_events SET proof_ref = 'x' WHERE letter_id = ?", [id])).rejects.toThrow(/rien ne se réécrit/);
    await expect(t.db.run('DELETE FROM registered_letters WHERE id = ?', [id])).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE registered_letters SET document_ref = 'x' WHERE id = ?", [id])).rejects.toThrow(/rien ne se réécrit/);
  });

  it('[R463] sans le port du prestataire, la lettre reste dans la boîte d’essai : rien ne part, aucune preuve, aucune date', async () => {
    const t = await setup({ real: false });
    const id = await t.ready();
    const s = await t.lre.send(t.agent, id);
    expect(s).toMatchObject({ ok: true, value: { sent: false, rule: 'R463', status: 'essai' } });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox')).toEqual({ n: 1 });
    expect(await t.fill(id, 'depot', '2027-03-11T09:00:00.000Z')).toEqual({ ok: false, rule: 'R463', code: 'trial' });
    expect(await t.db.first("SELECT 1 AS x FROM sale_file_dates WHERE file_id = ? AND kind = 'notification_acquereur'", [t.fileId])).toBeNull();
    // Une lettre d'essai n'empêche pas d'en préparer une vraie le jour où le port est branché.
    expect(await t.lre.prepare(t.agent, t.fileId, { documentRef: t.compromis })).toMatchObject({ ok: true });
    // Le port du prestataire est sur le canal email, et nul autre.
    expect(() => new RecommandeElectronique(t.db, t.acces, t.journal, t.storage, { port: new FakeChannel('sms') })).toThrow(/canal email/);
  });
});
