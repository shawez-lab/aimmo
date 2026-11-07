import { expect, it } from 'vitest';
import { ANNEX_PLAIN_WORDS, CircuitSignature, MAX_REMINDERS, envelopeHash, plainWords } from '../src/documents/circuit-signature.ts';
import { ONLINE_SIGNATURE_PURPOSE } from '../src/documents/signature-en-ligne.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Dossier, vendeur, acquéreur, pièces et preuves inventés. Lundi 1er mars 2027, 13 h à Paris.
const MON_13H = new Date('2027-03-01T12:00:00.000Z');
const H = (c: string) => c.repeat(64);
let proofs = 0;

async function setup(o: { consent?: boolean } = {}) {
  const t = await setupDossier('appartement');
  t.setClock(MON_13H);
  const circuit = new CircuitSignature(t.db, t.acces, t.journal, t.storage, { now: t.now });
  const sellerId = t.personId;
  const buyerId = t.buyerId;
  for (const [personId, value] of [
    [sellerId, 'vendeur@example.test'],
    [buyerId, 'acheteur@example.test'],
  ] as const) {
    await t.store.addIdentifier({ networkId: t.network.id, personId, kind: 'email', value });
    if (o.consent !== false) await t.store.addConsent({ networkId: t.network.id, personId, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: 'accord écrit au rendez-vous (test)', givenAt: new Date('2027-02-01T09:00:00.000Z') });
  }
  const doc = { ref: t.upload(), hash: H('a') };
  const annexes = [
    { kind: 'diagnostics', ref: t.upload(), hash: H('b') },
    { kind: 'copropriete', ref: t.upload(), hash: H('c') },
  ];
  const proof = () => {
    proofs += 1;
    const ref = `preuves/0b6f1d2e-3737-4a2b-8c3d-${String(proofs).padStart(12, '0')}.pdf`;
    t.storage.refs.add(ref);
    return ref;
  };
  const prepare = async (signers = [{ personId: sellerId, group: 1 }, { personId: buyerId, group: 2 }]) => {
    const r = await circuit.prepare(t.agent, t.fileId, { document: doc, annexes, signers });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  /** Le signataire lit chaque annexe en mots simples. */
  const readAll = async (id: string, personId: string) => {
    const e = await circuit.explain(t.agent, id, personId);
    if (!e.ok) throw new Error(e.code);
    for (const a of e.value) {
      const r = await circuit.acknowledge(t.agent, id, { personId, position: a.position, textHash: a.textHash });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const sign = (id: string, personId: string, envelope: string) => circuit.sign(t.agent, id, { personId, envelopeHash: envelope, proofRef: proof() });
  const messages = async () => (await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND conversation_id LIKE 'circuit:%'"))!.n;
  return { ...t, circuit, sellerId, buyerId, doc, annexes, proof, prepare, readAll, sign, messages };
}

describeWithSqlite('HX37 · ordre des signataires, annexes groupées et rappels', () => {
  it('[R464] l’ordre des signataires est tenu : un groupe ne signe qu’une fois le précédent complet', async () => {
    const t = await setup();
    const c = await t.prepare();
    expect(c).toMatchObject({ currentGroup: 1, complete: false, signers: [{ personId: t.sellerId, role: 'vendeur', group: 1 }, { personId: t.buyerId, role: 'acquereur', group: 2 }] });
    await t.readAll(c.id, t.buyerId);
    // L'acquéreur, du groupe 2, ne signe pas avant le vendeur.
    expect(await t.sign(c.id, t.buyerId, c.envelopeHash)).toMatchObject({ ok: false, rule: 'R464', code: 'not_your_turn' });
    await t.readAll(c.id, t.sellerId);
    expect(await t.sign(c.id, t.sellerId, c.envelopeHash)).toMatchObject({ ok: true, value: { currentGroup: 2, complete: false } });
    // Une seule signature par signataire.
    expect(await t.sign(c.id, t.sellerId, c.envelopeHash)).toMatchObject({ ok: false, code: 'already_signed' });
    const done = await t.sign(c.id, t.buyerId, c.envelopeHash);
    expect(done).toMatchObject({ ok: true, value: { currentGroup: null, complete: true } });
    const types = (await t.journal.all()).map((e) => e.type).filter((x) => x.startsWith('dossier.circuit_'));
    expect(types).toEqual(['dossier.circuit_prepare', ...Array(4).fill('dossier.circuit_lecture'), 'dossier.circuit_signature', 'dossier.circuit_signature', 'dossier.circuit_complet']);
  });

  it('[R464] dans un même groupe, l’ordre est libre ; des groupes à trou ou un signataire hors du dossier sont refusés', async () => {
    const t = await setup();
    const c = await t.prepare([{ personId: t.buyerId, group: 1 }, { personId: t.sellerId, group: 1 }]);
    await t.readAll(c.id, t.buyerId);
    expect(await t.sign(c.id, t.buyerId, c.envelopeHash)).toMatchObject({ ok: true, value: { currentGroup: 1 } });
    await t.readAll(c.id, t.sellerId);
    expect(await t.sign(c.id, t.sellerId, c.envelopeHash)).toMatchObject({ ok: true, value: { complete: true } });
    const stranger = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Tiers', lastName: 'Inconnu' });
    const input = (signers: unknown) => t.circuit.prepare(t.agent, t.fileId, { document: { ref: t.upload(), hash: H('d') }, annexes: [], signers });
    expect(await input([{ personId: t.sellerId, group: 1 }, { personId: t.buyerId, group: 3 }])).toMatchObject({ ok: false, rule: 'R464', code: 'bad_signers' });
    expect(await input([{ personId: stranger.id, group: 1 }])).toMatchObject({ ok: false, rule: 'R464', code: 'not_a_party' });
    expect(await input([{ personId: t.sellerId, group: 1 }, { personId: t.sellerId, group: 2 }])).toMatchObject({ ok: false, rule: 'R464', code: 'bad_signers' });
    expect(await input([])).toMatchObject({ ok: false, rule: 'R464', code: 'bad_signers' });
  });

  it('[R465] un document et ses annexes ont une seule empreinte de dossier, et chaque signature porte celle-là', async () => {
    const t = await setup();
    const c = await t.prepare();
    const expected = await envelopeHash(t.doc, t.annexes as { kind: 'diagnostics' | 'copropriete'; ref: string; hash: string }[]);
    expect(c.envelopeHash).toBe(expected);
    expect(c.annexes.map((a) => [a.position, a.kind])).toEqual([[1, 'diagnostics'], [2, 'copropriete']]);
    // Changer une annexe, en ôter une, ou les déplacer change l'empreinte.
    const a = t.annexes as { kind: 'diagnostics' | 'copropriete'; ref: string; hash: string }[];
    expect(await envelopeHash(t.doc, [a[0]!, { ...a[1]!, hash: H('e') }])).not.toBe(expected);
    expect(await envelopeHash(t.doc, [a[0]!])).not.toBe(expected);
    expect(await envelopeHash(t.doc, [a[1]!, a[0]!])).not.toBe(expected);
    await t.readAll(c.id, t.sellerId);
    // Le document seul, sans ses annexes, ne se signe pas.
    expect(await t.sign(c.id, t.sellerId, await envelopeHash(t.doc, []))).toMatchObject({ ok: false, rule: 'R465', code: 'envelope_mismatch' });
    expect(await t.sign(c.id, t.sellerId, t.doc.hash)).toMatchObject({ ok: false, rule: 'R465', code: 'envelope_mismatch' });
    expect(await t.sign(c.id, t.sellerId, c.envelopeHash)).toMatchObject({ ok: true });
    await t.readAll(c.id, t.buyerId);
    expect(await t.sign(c.id, t.buyerId, c.envelopeHash)).toMatchObject({ ok: true });
    expect(await t.db.all("SELECT DISTINCT envelope_hash FROM signature_circuit_events WHERE circuit_id = ? AND kind = 'signature'", [c.id])).toEqual([{ envelope_hash: expected }]);
    // Une pièce absente du stockage, ou une annexe d'une sorte inconnue : pas de circuit.
    expect(await t.circuit.prepare(t.agent, t.fileId, { document: { ref: `dossiers/${t.fileId}/0b6f1d2e-4444-4a2b-8c3d-999999999999.pdf`, hash: H('a') }, annexes: [], signers: [{ personId: t.sellerId, group: 1 }] })).toMatchObject({ ok: false, code: 'not_stored' });
    expect(await t.circuit.prepare(t.agent, t.fileId, { document: { ref: t.upload(), hash: H('a') }, annexes: [{ kind: 'secret', ref: t.upload(), hash: H('b') }], signers: [{ personId: t.sellerId, group: 1 }] })).toMatchObject({ ok: false, code: 'bad_annex' });
    // Un circuit ne change plus [R17].
    await expect(t.db.run('UPDATE signature_circuit_annexes SET hash = ? WHERE circuit_id = ?', [H('f'), c.id])).rejects.toThrow(/rien ne se réécrit/);
    await expect(t.db.run('DELETE FROM signature_circuit_events WHERE circuit_id = ?', [c.id])).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R466] avant de signer, chaque signataire lit en mots simples ce que chaque annexe change pour lui', async () => {
    const t = await setup();
    const c = await t.prepare();
    const seller = await t.circuit.explain(t.agent, c.id, t.sellerId);
    const buyer = await t.circuit.explain(t.agent, c.id, t.buyerId);
    if (!seller.ok || !buyer.ok) throw new Error('explain');
    expect(seller.value.map((a) => a.text)).toEqual([ANNEX_PLAIN_WORDS.diagnostics.vendeur, ANNEX_PLAIN_WORDS.copropriete.vendeur]);
    expect(buyer.value.map((a) => a.text)).toEqual([ANNEX_PLAIN_WORDS.diagnostics.acquereur, ANNEX_PLAIN_WORDS.copropriete.acquereur]);
    // Chaque texte est propre au rôle : le vendeur et l'acquéreur ne lisent pas la même chose.
    for (const [kind, words] of Object.entries(ANNEX_PLAIN_WORDS)) expect(words.vendeur, kind).not.toBe(words.acquereur);
    // Une seule annexe lue : pas de signature.
    expect(await t.circuit.acknowledge(t.agent, c.id, { personId: t.sellerId, position: 1, textHash: seller.value[0]!.textHash })).toMatchObject({ ok: true });
    expect(await t.sign(c.id, t.sellerId, c.envelopeHash)).toMatchObject({ ok: false, rule: 'R466', code: 'annexes_not_read' });
    // Le texte de l'acquéreur ne vaut pas lecture pour le vendeur.
    expect(await t.circuit.acknowledge(t.agent, c.id, { personId: t.sellerId, position: 2, textHash: buyer.value[1]!.textHash })).toMatchObject({ ok: false, rule: 'R466', code: 'text_changed' });
    expect(await t.circuit.acknowledge(t.agent, c.id, { personId: t.sellerId, position: 2, textHash: seller.value[1]!.textHash })).toMatchObject({ ok: true, value: { signers: [{ read: [1, 2] }, { read: [] }] } });
    expect(await t.sign(c.id, t.sellerId, c.envelopeHash)).toMatchObject({ ok: true });
    // La lecture est rangée avec l'empreinte du texte montré.
    expect(await t.db.all("SELECT annex_position, shown_hash FROM signature_circuit_events WHERE circuit_id = ? AND kind = 'lecture' ORDER BY seq", [c.id])).toEqual([
      { annex_position: 1, shown_hash: (await plainWords('diagnostics', 'vendeur')).hash },
      { annex_position: 2, shown_hash: (await plainWords('copropriete', 'vendeur')).hash },
    ]);
  });

  it('[R467] aucun rappel hors des heures d’envoi : jamais la nuit ni le dimanche, et seulement au signataire dont c’est le tour', async () => {
    const t = await setup();
    const c = await t.prepare();
    // Moins de 48 heures depuis la préparation : rien.
    t.setClock(new Date('2027-03-03T11:00:00.000Z'));
    expect(await t.circuit.remind(t.network.id)).toEqual({ sent: 0, refused: 0, skipped: null });
    // Mercredi 3 mars, 15 h à Paris : un rappel au vendeur seul, dont c'est le tour, par le contrôle central.
    t.setClock(new Date('2027-03-03T14:00:00.000Z'));
    expect(await t.circuit.remind(t.network.id)).toEqual({ sent: 1, refused: 0, skipped: null });
    expect(await t.messages()).toBe(1);
    const body = await t.db.first<{ body: string; person_id: string; with_mention: number }>(
      'SELECT m.body, m.person_id, l.with_mention FROM messages m JOIN send_log l ON l.message_id = m.id WHERE m.conversation_id = ?',
      [`circuit:${c.id}`],
    );
    expect(body?.person_id).toBe(t.sellerId);
    expect(body?.body).toContain('Votre signature est attendue sur les documents de votre vente préparés le 1er mars 2027 à 13 h 00.');
    // Le premier message automatique de la conversation porte la mention de l'assistant [R06].
    expect(body?.with_mention).toBe(1);
    // Le même passage relancé : rien ne repart.
    expect(await t.circuit.remind(t.network.id)).toEqual({ sent: 0, refused: 0, skipped: null });
    // Vendredi 5 mars à 22 h, puis dimanche 7 mars à 11 h à Paris : rien n'est tenté.
    for (const night of ['2027-03-05T21:00:00.000Z', '2027-03-06T19:30:00.000Z', '2027-03-07T10:00:00.000Z', '2027-03-08T06:59:00.000Z']) {
      t.setClock(new Date(night));
      expect(await t.circuit.remind(t.network.id), night).toEqual({ sent: 0, refused: 0, skipped: 'hors_heures' });
      expect(CircuitSignature.inSendingHours(new Date(night)), night).toBe(false);
    }
    expect(await t.messages()).toBe(1);
    // Lundi 8 mars à 8 h à Paris : le deuxième rappel.
    t.setClock(new Date('2027-03-08T07:00:00.000Z'));
    expect(await t.circuit.remind(t.network.id)).toEqual({ sent: 1, refused: 0, skipped: null });
    // Chaque rappel parti l'a été dans les heures d'envoi.
    const sent = await t.db.all<{ at: string }>("SELECT at FROM signature_circuit_events WHERE circuit_id = ? AND kind = 'rappel'", [c.id]);
    for (const s of sent) expect(CircuitSignature.inSendingHours(new Date(s.at)), s.at).toBe(true);
    // Le vendeur signe : le tour passe à l'acquéreur, qui reçoit son rappel 48 heures plus tard ; le vendeur n'en reçoit plus.
    await t.readAll(c.id, t.sellerId);
    expect(await t.sign(c.id, t.sellerId, c.envelopeHash)).toMatchObject({ ok: true });
    t.setClock(new Date('2027-03-09T08:00:00.000Z'));
    expect(await t.circuit.remind(t.network.id)).toEqual({ sent: 0, refused: 0, skipped: null });
    t.setClock(new Date('2027-03-10T08:00:00.000Z'));
    expect(await t.circuit.remind(t.network.id)).toEqual({ sent: 1, refused: 0, skipped: null });
    expect(await t.db.all("SELECT person_id, n FROM signature_circuit_events WHERE circuit_id = ? AND kind = 'rappel' ORDER BY seq", [c.id])).toEqual([
      { person_id: t.sellerId, n: 1 },
      { person_id: t.sellerId, n: 2 },
      { person_id: t.buyerId, n: 1 },
    ]);
  });

  it('[R467] [R05] un rappel remis sans être rangé est retrouvé au passage suivant, sans repartir', async () => {
    const t = await setup();
    const c = await t.prepare([{ personId: t.sellerId, group: 1 }]);
    t.setClock(new Date('2027-03-03T14:00:00.000Z'));
    // Une coupure : le contrôle central a remis le rappel, la ligne du circuit n'a pas été écrite.
    const realAdd = (t.circuit as unknown as { addEvent: (...a: unknown[]) => Promise<boolean> }).addEvent.bind(t.circuit);
    (t.circuit as unknown as { addEvent: unknown }).addEvent = async () => false;
    await t.circuit.remind(t.network.id);
    (t.circuit as unknown as { addEvent: unknown }).addEvent = realAdd;
    expect(await t.messages()).toBe(1);
    expect(await t.circuit.remind(t.network.id)).toEqual({ sent: 0, refused: 0, skipped: null });
    expect(await t.messages()).toBe(1);
    expect(await t.db.all("SELECT kind, n, rule FROM signature_circuit_events WHERE circuit_id = ? AND kind LIKE 'rappel%'", [c.id])).toEqual([{ kind: 'rappel', n: 1, rule: 'R467' }]);
  });

  it('[R467] [R05] deux circuits pour la même personne ont chacun leurs rappels', async () => {
    const t = await setup();
    const c = await t.prepare([{ personId: t.sellerId, group: 1 }]);
    t.setClock(new Date('2027-03-01T13:30:00.000Z'));
    const d = await t.circuit.prepare(t.agent, t.fileId, { document: { ref: t.upload(), hash: H('9') }, annexes: [], signers: [{ personId: t.sellerId, group: 1 }] });
    if (!d.ok) throw new Error(d.code);
    for (const day of ['2027-03-03T14:00:00.000Z', '2027-03-05T14:00:00.000Z', '2027-03-08T14:00:00.000Z']) {
      t.setClock(new Date(day));
      expect(await t.circuit.remind(t.network.id), day).toEqual({ sent: 2, refused: 0, skipped: null });
    }
    expect(await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM signature_circuit_events WHERE circuit_id IN (?, ?) AND kind = 'rappel'", [c.id, d.value.id])).toEqual({ n: 6 });
  });

  it(`[R467] [R03] un rappel sans accord est refusé par le contrôle central ; ${MAX_REMINDERS} rappels au plus ; rien quand tous ont signé`, async () => {
    const t = await setup({ consent: false });
    const c = await t.prepare([{ personId: t.sellerId, group: 1 }]);
    t.setClock(new Date('2027-03-03T14:00:00.000Z'));
    expect(await t.circuit.remind(t.network.id)).toEqual({ sent: 0, refused: 1, skipped: null });
    expect(await t.messages()).toBe(0);
    expect(await t.db.first("SELECT kind, rule FROM signature_circuit_events WHERE circuit_id = ? AND kind LIKE 'rappel%'", [c.id])).toEqual({ kind: 'rappel_refuse', rule: 'R03' });
    // Le refus compte comme un essai : le suivant attend 48 heures, et trois au plus.
    expect(await t.circuit.remind(t.network.id)).toEqual({ sent: 0, refused: 0, skipped: null });
    for (const day of ['2027-03-05T14:00:00.000Z', '2027-03-08T14:00:00.000Z', '2027-03-10T14:00:00.000Z', '2027-03-12T14:00:00.000Z']) {
      t.setClock(new Date(day));
      await t.circuit.remind(t.network.id);
    }
    expect(await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM signature_circuit_events WHERE circuit_id = ? AND kind LIKE 'rappel%'", [c.id])).toEqual({ n: MAX_REMINDERS });
    // Tous ont signé : aucun rappel.
    const u = await setup();
    const d = await u.prepare([{ personId: u.sellerId, group: 1 }]);
    await u.readAll(d.id, u.sellerId);
    expect(await u.sign(d.id, u.sellerId, d.envelopeHash)).toMatchObject({ ok: true, value: { complete: true } });
    u.setClock(new Date('2027-03-03T14:00:00.000Z'));
    expect(await u.circuit.remind(u.network.id)).toEqual({ sent: 0, refused: 0, skipped: null });
  });

  it('[R16] seul l’agent du bien prépare et présente ; la direction lit les circuits', async () => {
    const t = await setup();
    const c = await t.prepare();
    expect(await t.circuit.prepare(t.sam, t.fileId, { document: t.doc, annexes: [], signers: [] })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.circuit.prepare(t.direction, t.fileId, { document: t.doc, annexes: [], signers: [] })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.circuit.sign(t.direction, c.id, { personId: t.sellerId, envelopeHash: c.envelopeHash, proofRef: t.proof() })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.circuit.circuits(t.direction, t.fileId)).toMatchObject({ ok: true, value: [{ id: c.id }] });
  });
});
