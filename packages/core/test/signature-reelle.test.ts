import { expect, it } from 'vitest';
import type { DeliveryReceipt, OutboundMessage } from '../src/envoi/canaux.ts';
import {
  Acces,
  ControlesSignature,
  FakeChannel,
  FicheClient,
  FicheUnique,
  Modeles,
  PROOF_FORMAT,
  RegistreMandats,
  SignatureEnLigne,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { enClair } from './boite-essai.ts';
import { designerTout } from './designation-jeu.ts';

// Modèle, avocat et personnes inventés.
const BODY = 'Mandat de test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.';
const T0 = Date.parse('2027-02-10T10:00:00.000Z'); // mercredi, 11 h à Paris
const CONSENT = { consentProof: 'accord donné au rendez-vous (test)' };
const SOURCE = { source: 'referral' };
const AVIS = { reference: 'Avis écrit 2027-02 du cabinet Exemple-Avocats', validatedOn: new Date('2027-02-01T00:00:00.000Z') };

async function setup(options: { mail?: boolean } = {}) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = T0;
  const now = () => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'direction-1', networkId: network.id };
  const v = await modeles.createVersion(direction, 'mandat_vente_simple', BODY);
  await modeles.validate({ role: 'compliance', userId: 'c-1', networkId: network.id }, v.ok ? v.template.id : '');
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
  await identiteAuCoffre({ db, acces, journal, now }, agent, p.id, { piece: 'carte_identite', seenAt: new Date(T0) });
  await designerTout(db);
  const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } });
  if (!d.ok) throw new Error(d.code);
  await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: 'lea.exemple@example.test' });
  // Le mail réel, simulé : un faux canal qui garde ce qu'il aurait remis.
  const mail = new FakeChannel('email');
  const online = new SignatureEnLigne(db, acces, journal, { now, ...(options.mail ? { channels: [mail] } : {}) });
  const trialCodes = async (): Promise<string[]> =>
    (await enClair(db.all<{ id: string; body: string }>(`SELECT m.id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.body LIKE '%code de signature%' ORDER BY m.occurred_at, m.created_at`))).map((r) => /(\d{6})/.exec(r.body)![1]!);
  const realCodes = (): string[] => mail.sent.filter((m) => m.body.includes('code de signature')).map((m) => /(\d{6})/.exec(m.body)![1]!);
  const trialCount = async (): Promise<number> => (await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox'))!.n;
  return { raw, db, journal, acces, now, modeles, online, mail, agent, direction, sam, network, documentId: d.document.id, trialCodes, realCodes, trialCount, at: (ms: number) => (clock = T0 + ms) };
}

describeWithSqlite('AU003 · la signature en ligne réelle, distincte de l’essai', () => {
  it('[R41] constat : sans validation de l’avocat ni mail réel, la signature reste d’essai, dite telle, et ne range aucun mandat', async () => {
    // Le constat de l'audit : avant AU003, aucune voie ne menait à une signature réelle. Il en reste une seule, gardée.
    const none = await setup();
    expect(await none.online.mode(none.agent)).toEqual({ ok: true, value: { mode: 'essai', missing: ['mail_reel', 'validation_avocat'], proofFormat: PROOF_FORMAT } });
    // Le mail réel seul, ou la validation seule : toujours l'essai.
    const mailOnly = await setup({ mail: true });
    expect(await mailOnly.online.mode(mailOnly.agent)).toMatchObject({ ok: true, value: { mode: 'essai', missing: ['validation_avocat'] } });
    expect((await none.online.recordValidation(none.direction, AVIS)).ok).toBe(true);
    expect(await none.online.mode(none.agent)).toMatchObject({ ok: true, value: { mode: 'essai', missing: ['mail_reel'] } });
    // Une session d'essai le dit dans le résultat, dans le code et dans l'exemplaire, et ne range rien.
    const s = await none.online.start(none.agent, none.documentId, CONSENT);
    expect(s).toMatchObject({ ok: true, value: { mode: 'essai' } });
    if (!s.ok) throw new Error(s.code);
    // X17 · la session d'essai rend son code, pour essayer le parcours à l'écran ; c'est celui de la boîte d'essai.
    expect(s.value.trialCode).toBe((await none.trialCodes())[0]);
    const signed = await none.online.sign(none.agent, s.value.sessionId, { code: (await none.trialCodes())[0]! });
    expect(signed).toMatchObject({ ok: true, value: { mode: 'essai', realSignature: false, allSigned: true } });
    const bodies = (await enClair(none.db.all<{ id: string; body: string }>('SELECT m.id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id'))).map((r) => r.body);
    expect(bodies.length).toBe(2);
    for (const body of bodies) expect(body).toContain('Signature d’essai, sans valeur juridique.');
    const copy = await none.online.copy(none.agent, s.value.sessionId);
    expect(copy.ok && copy.content).toContain('essai, sans valeur juridique');
    expect(await none.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM signed_documents')).toEqual({ n: 0 });
    expect(await none.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM signature_dossiers')).toEqual({ n: 0 });
    expect(await none.online.finish(none.agent, none.documentId)).toEqual({ ok: false, rule: 'R41', code: 'not_all_signed' });
    // Le mail réel branché, sans validation : une session d'essai n'y envoie rien, tout reste dans la boîte d'essai.
    const m = await mailOnly.online.start(mailOnly.agent, mailOnly.documentId, CONSENT);
    if (!m.ok) throw new Error(m.code);
    expect(m.value.mode).toBe('essai');
    expect((await mailOnly.online.sign(mailOnly.agent, m.value.sessionId, { code: (await mailOnly.trialCodes())[0]! })).ok).toBe(true);
    expect(mailOnly.mail.sent).toEqual([]);
    expect(await mailOnly.trialCount()).toBe(2);
  });

  it('[R41] [R39] signée réellement : mandat inscrit au registre, dossier de preuve figé, exemplaire et dossier remis au mandant par le mail réel', async () => {
    const t = await setup({ mail: true });
    expect((await t.online.recordValidation(t.direction, AVIS)).ok).toBe(true);
    expect(await t.online.mode(t.agent)).toMatchObject({ ok: true, value: { mode: 'reel', missing: [] } });
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    expect(s).toMatchObject({ ok: true, value: { mode: 'reel' } });
    if (!s.ok) throw new Error(s.code);
    // Le code part par le mail réel, jamais par la boîte d'essai, et sans la mention de l'essai.
    expect(t.realCodes()).toHaveLength(1);
    // X17 · une session réelle ne rend jamais son code à l'agent : il ne part qu'au signataire.
    expect(s.value).not.toHaveProperty('trialCode');
    expect(JSON.stringify(s)).not.toContain(t.realCodes()[0]!);
    expect(t.mail.sent[0]!.body).not.toContain('essai');
    expect(await t.trialCount()).toBe(0);
    t.at(60_000);
    const r = await t.online.sign(t.agent, s.value.sessionId, { code: t.realCodes()[0]!, drawing: 'M10 10 L20 20' });
    expect(r).toMatchObject({ ok: true, value: { mode: 'reel', realSignature: true, allSigned: true, method: 'code_et_trace' } });
    // La source du mandat n'est pas sur la fiche : le document attend que l'agent la donne [R38].
    expect(r.ok && r.value.finished).toEqual({ ok: false, rule: 'R38', code: 'missing_source' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM signature_dossiers')).toEqual({ n: 0 });
    expect(await t.online.finish(t.agent, t.documentId, SOURCE)).toMatchObject({ ok: true, value: { number: 'T-001' } });
    // Le mandat est inscrit, à distance, avec son numéro.
    expect(await t.db.first('SELECT number, place, scan_ref FROM signed_documents WHERE document_id = ?', [t.documentId])).toEqual({ number: 'T-001', place: 'distance', scan_ref: `signature-en-ligne/${t.documentId}` });
    expect(await t.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM mandate_register WHERE kind = 'inscription'`)).toEqual({ n: 1 });
    // Le dossier de preuve : format, validation, empreintes, horodatages, méthode ; il ne nomme personne.
    const d = await t.online.dossier(t.agent, t.documentId);
    if (!d.ok) throw new Error(d.code);
    expect(d.value.dossier).toContain(PROOF_FORMAT);
    expect(d.value.dossier).toContain('Avis écrit 2027-02 du cabinet Exemple-Avocats');
    expect(d.value.dossier).toContain('T-001');
    expect(d.value.dossier).toContain(new Date(T0 + 60_000).toISOString());
    expect(d.value.dossier).toContain('signature tracée à l’écran');
    expect(d.value.dossier).not.toMatch(/Léa|lea\.exemple/);
    expect(d.value.dossier).not.toContain('M10 10');
    // L'exemplaire remis : le mandat numéroté, suivi du dossier.
    expect(d.value.copy).toContain('<span class="signe">T-001</span>');
    expect(d.value.copy).toContain(d.value.dossier);
    // Remis au mandant par le mail réel, avec la référence et l'empreinte de son exemplaire.
    const remise = t.mail.sent.find((m) => m.body.includes('dossier de preuve vous sont remis'));
    expect(remise?.to).toBe('lea.exemple@example.test');
    expect(remise?.body).toContain('T-001');
    expect(remise?.body).toContain(d.value.copyHash);
    // L'exemplaire signé et le dossier sont joints au mail : le mandant les reçoit, pas seulement leur référence.
    expect(remise?.attachments?.map((a) => a.name)).toEqual(['exemplaire-signe-T-001.html', 'dossier-de-preuve-T-001.html']);
    expect(remise?.attachments?.[0]!.content).toBe(d.value.copy);
    expect(remise?.attachments?.[1]!.content).toBe(d.value.dossier);
    // Ni l'exemplaire ni le dossier ne sont rangés avec le message.
    expect(JSON.stringify(await t.db.all('SELECT body FROM messages'))).not.toContain('Dossier de preuve de la signature');
    expect(await t.db.first(`SELECT status FROM signature_remises WHERE document_id = ?`, [t.documentId])).toEqual({ status: 'envoyee' });
    // Redemandé : rien n'est refait, rien ne repart.
    const sentBefore = t.mail.sent.length;
    const again = await t.online.finish(t.agent, t.documentId);
    expect(again).toMatchObject({ ok: true, value: { number: 'T-001', dossierHash: d.value.dossierHash, remises: [{ position: 1, sent: true }] } });
    expect(t.mail.sent.length).toBe(sentBefore);
    expect(await t.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM mandate_register`)).toEqual({ n: 1 });
    const events = (await t.journal.all()).map((e) => e.type);
    expect(events).toContain('signature.reelle');
    expect(events.filter((e) => e === 'signature.dossier')).toHaveLength(1);
    expect(JSON.stringify(await t.journal.all())).not.toContain(t.realCodes()[0]!);
  });

  it('[R41] une signature d’essai d’avant la validation ne compte pas : le mandant signe de nouveau, en réel', async () => {
    const t = await setup({ mail: true });
    const s1 = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s1.ok) throw new Error(s1.code);
    expect(s1.value.mode).toBe('essai');
    expect((await t.online.sign(t.agent, s1.value.sessionId, { code: (await t.trialCodes())[0]! })).ok).toBe(true);
    expect((await t.online.recordValidation(t.direction, AVIS)).ok).toBe(true);
    // Le mode d'une session ne change jamais, même par la base.
    await expect(t.db.run(`UPDATE signature_sessions SET mode = 'reel' WHERE id = ?`, [s1.value.sessionId])).rejects.toThrow();
    expect(await t.online.finish(t.agent, t.documentId)).toEqual({ ok: false, rule: 'R41', code: 'not_all_signed' });
    const s2 = await t.online.start(t.agent, t.documentId, CONSENT);
    expect(s2).toMatchObject({ ok: true, value: { mode: 'reel' } });
    if (!s2.ok) throw new Error(s2.code);
    expect(await t.online.sign(t.agent, s2.value.sessionId, { code: t.realCodes()[0]! })).toMatchObject({ ok: true, value: { realSignature: true, allSigned: true } });
    expect((await t.online.finish(t.agent, t.documentId, SOURCE)).ok).toBe(true);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM signature_dossiers')).toEqual({ n: 1 });
  });

  it('[R16] [R17] seule la direction enregistre la validation ; validation, dossier et remise ne se réécrivent ni ne s’effacent', async () => {
    const t = await setup({ mail: true });
    expect(await t.online.recordValidation(t.agent, AVIS)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.journal.all()).some((e) => e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'signature_validation')).toBe(true);
    expect(await t.online.recordValidation(t.direction, { ...AVIS, reference: 'x' })).toEqual({ ok: false, rule: null, code: 'bad_reference' });
    expect(await t.online.recordValidation(t.direction, { ...AVIS, validatedOn: new Date(T0 + 86_400_000) })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.online.mode({ role: 'compliance', userId: 'c-1', networkId: t.network.id } as Viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.online.recordValidation(t.direction, AVIS)).ok).toBe(true);
    // Une validation d'un autre format ne rend rien réel.
    await t.db.run(`INSERT INTO signature_validations (id, network_id, proof_format, reference, validated_on, recorded_by, recorded_at) VALUES ('v-autre', ?, 'autre-format', 'Avis ancien', '2026-01-01', 'direction:x', ?)`, [t.network.id, new Date(T0 + 1).toISOString()]);
    expect(await t.online.mode(t.agent)).toMatchObject({ ok: true, value: { mode: 'reel' } });
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    await t.online.sign(t.agent, s.value.sessionId, { code: t.realCodes()[0]! });
    expect((await t.online.finish(t.agent, t.documentId, SOURCE)).ok).toBe(true);
    // Un autre agent ne lit pas le dossier [R16].
    expect(await t.online.dossier({ role: 'agent', userId: t.sam.id, networkId: t.network.id }, t.documentId)).toMatchObject({ ok: false, rule: 'R16' });
    for (const sql of [
      `UPDATE signature_validations SET reference = 'autre'`,
      `DELETE FROM signature_validations`,
      `UPDATE signature_dossiers SET dossier = 'autre'`,
      `DELETE FROM signature_dossiers`,
      `UPDATE signature_remises SET status = 'a_envoyer'`,
      `DELETE FROM signature_remises`,
    ]) await expect(t.db.run(sql)).rejects.toThrow();
  });

  it('une remise tombée avec le canal n’est jamais dite envoyée, et repart une seule fois', async () => {
    const t = await setup({ mail: true });
    expect((await t.online.recordValidation(t.direction, AVIS)).ok).toBe(true);
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    await t.online.sign(t.agent, s.value.sessionId, { code: t.realCodes()[0]! });
    // Le canal tombe pendant la remise : rien n'est noté envoyé.
    t.mail.failWith = new Error('panne');
    expect(await t.online.finish(t.agent, t.documentId, SOURCE)).toMatchObject({ ok: true, value: { remises: [{ position: 1, sent: false }] } });
    expect(await t.db.first(`SELECT status FROM signature_remises WHERE document_id = ?`, [t.documentId])).toEqual({ status: 'a_envoyer' });
    t.mail.failWith = null;
    expect(await t.online.finish(t.agent, t.documentId)).toMatchObject({ ok: true, value: { remises: [{ position: 1, sent: true }] } });
    expect(t.mail.sent.filter((m) => m.body.includes('dossier de preuve vous sont remis'))).toHaveLength(1);
  });

  it('[R44] un avenant ne se signe jamais en réel : il ne s’inscrirait pas aux avenants signés', async () => {
    const t = await setup({ mail: true });
    expect((await t.online.recordValidation(t.direction, AVIS)).ok).toBe(true);
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    await t.online.sign(t.agent, s.value.sessionId, { code: t.realCodes()[0]! });
    expect((await t.online.finish(t.agent, t.documentId, SOURCE)).ok).toBe(true);
    const v = await t.modeles.createVersion(t.direction, 'avenant_mandat', 'Avenant de test au mandat n° {{mandat.numero}} : durée portée à {{avenant.duree_mois}}.');
    if (!v.ok) throw new Error(v.code);
    await t.modeles.validate({ role: 'compliance', userId: 'c-1', networkId: t.network.id }, v.template.id);
    const doc = await t.db.first<{ person_id: string; property_id: string }>('SELECT person_id, property_id FROM documents WHERE id = ?', [t.documentId]);
    const a = await t.modeles.generate(t.agent, { kind: 'avenant_mandat', personId: doc!.person_id, propertyId: doc!.property_id, inputs: { 'avenant.duree_mois': 18 } as never, mandateId: `m-${t.documentId}` });
    if (!a.ok) throw new Error(a.code);
    const started = await t.online.start(t.agent, a.document.id, CONSENT);
    // Ouvert ou refusé par ses contrôles, il n'est jamais réel ; et il ne se finit pas en réel.
    if (started.ok) expect(started.value.mode).toBe('essai');
    expect(await t.online.finish(t.agent, a.document.id, SOURCE)).toEqual({ ok: false, rule: null, code: 'not_a_mandate' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM signature_dossiers')).toEqual({ n: 1 });
  });

  it('un envoi de remise abandonné avant la remise (panne) est remplacé après une heure, et le mandant reçoit ses pièces', async () => {
    // Un canal qui reste bloqué : l'envoi est réservé, puis le travail s'arrête avant la remise.
    class Bloque {
      readonly channel = 'email' as const;
      hang = false;
      held = 0;
      readonly sent: OutboundMessage[] = [];
      deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
        if (this.hang && message.body.includes('pièces jointes')) {
          this.held += 1;
          return new Promise(() => {});
        }
        this.sent.push(message);
        return Promise.resolve({ externalId: `bloque-${this.sent.length}` });
      }
    }
    const t = await setup();
    let clock = T0;
    const now = () => new Date(clock);
    const canal = new Bloque();
    // On attend que l'envoi soit vraiment bloqué, pas un quart de seconde : sur une machine chargée, le travail
    // n'avait pas toujours atteint le canal, et l'essai suivant n'était pas encore réservé.
    const blocked = async (n: number): Promise<void> => {
      for (let i = 0; i < 1500 && canal.held < n; i++) await new Promise((r) => setTimeout(r, 5));
      expect(canal.held).toBe(n);
    };
    const online = new SignatureEnLigne(t.db, t.acces, t.journal, { now, channels: [canal] });
    expect((await online.recordValidation(t.direction, AVIS)).ok).toBe(true);
    const s = await online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    const code = /(\d{6})/.exec(canal.sent[0]!.body)![1]!;
    await online.sign(t.agent, s.value.sessionId, { code });
    canal.hang = true;
    void online.finish(t.agent, t.documentId, SOURCE);
    await blocked(1);
    canal.hang = false;
    // Tout de suite : l'essai en cours n'est ni dit remis, ni doublé.
    expect(await online.finish(t.agent, t.documentId)).toMatchObject({ ok: true, value: { remises: [{ position: 1, sent: false }] } });
    expect(canal.sent.filter((m) => m.body.includes('pièces jointes'))).toHaveLength(0);
    // Plus d'une heure après, sans accusé ni échec : un nouvel essai part ; il est bloqué lui aussi.
    clock = T0 + 61 * 60_000;
    canal.hang = true;
    void online.finish(t.agent, t.documentId);
    await blocked(2);
    canal.hang = false;
    expect(await t.db.first('SELECT status, attempt FROM signature_remises')).toEqual({ status: 'a_envoyer', attempt: 2 });
    // Encore une heure : le troisième essai part, avec les pièces et un texte qui n'est pas celui des deux autres.
    clock = T0 + 122 * 60_000;
    expect(await online.finish(t.agent, t.documentId)).toMatchObject({ ok: true, value: { remises: [{ position: 1, sent: true }] } });
    const remis = canal.sent.filter((m) => m.body.includes('pièces jointes'));
    expect(remis).toHaveLength(1);
    expect(remis[0]!.attachments).toHaveLength(2);
    expect(await t.db.first('SELECT status, attempt FROM signature_remises')).toEqual({ status: 'envoyee', attempt: 3 });
  });

  it('[R01] une remise refusée la nuit reste à envoyer, et part à la demande suivante, une seule fois', async () => {
    const t = await setup({ mail: true });
    expect((await t.online.recordValidation(t.direction, AVIS)).ok).toBe(true);
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    const r = await t.online.sign(t.agent, s.value.sessionId, { code: t.realCodes()[0]! });
    expect(r).toMatchObject({ ok: true, value: { realSignature: true, allSigned: true } });
    t.at(12 * 3600_000); // 23 h à Paris : rien ne part
    expect(await t.online.finish(t.agent, t.documentId, SOURCE)).toMatchObject({ ok: true, value: { remises: [{ position: 1, sent: false }] } });
    expect(await t.db.first(`SELECT status FROM signature_remises WHERE document_id = ?`, [t.documentId])).toEqual({ status: 'a_envoyer' });
    expect(t.mail.sent.some((m) => m.body.includes('dossier de preuve vous sont remis'))).toBe(false);
    t.at(23 * 3600_000); // le lendemain, 10 h à Paris
    expect(await t.online.finish(t.agent, t.documentId)).toMatchObject({ ok: true, value: { remises: [{ position: 1, sent: true }] } });
    expect(await t.online.finish(t.agent, t.documentId)).toMatchObject({ ok: true, value: { remises: [{ position: 1, sent: true }] } });
    expect(t.mail.sent.filter((m) => m.body.includes('dossier de preuve vous sont remis'))).toHaveLength(1);
  });
});
