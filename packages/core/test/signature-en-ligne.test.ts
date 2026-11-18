import { expect, it } from 'vitest';
import { ONLINE_SIGNATURE_PURPOSE } from '../src/documents/signature-en-ligne.ts';
import {
  Acces,
  ControlesSignature,
  FicheClient,
  FicheUnique,
  MAX_CODE_ATTEMPTS,
  Modeles,
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
import { enClair, tablesContenant } from './boite-essai.ts';

// Modèle et personnes inventés.
const BODY = 'Mandat de test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}}.';
const T0 = Date.parse('2027-02-10T10:00:00.000Z'); // mercredi, 11 h à Paris
const CONSENT = { consentProof: 'accord donné au rendez-vous (test)' };

async function setup() {
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
  const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } });
  if (!d.ok) throw new Error(d.code);
  await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: 'lea.exemple@example.test' });
  const online = new SignatureEnLigne(db, acces, journal, { now });
  /** Les codes rangés dans la boîte d'essai, dans l'ordre. */
  const codes = async (): Promise<string[]> =>
    (await enClair(db.all<{ id: string; body: string }>(`SELECT m.id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.body LIKE '%code de signature%' ORDER BY m.occurred_at, m.created_at`))).map((r) => /(\d{6})/.exec(r.body)![1]!);
  return { raw, db, journal, online, agent, direction, sam, network, documentId: d.document.id, codes, at: (ms: number) => (clock = T0 + ms) };
}

describeWithSqlite('D08 · signature en ligne AIMMO, en mode essai', () => {
  it('[HX61] le code de signature part entier à la boîte d’essai, mais n’est rangé en clair ni dans les messages, ni dans la boîte, ni au journal', async () => {
    const t = await setup();
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    const [code] = await t.codes();
    const stored = await t.db.all<{ body: string }>(`SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.body LIKE '%code de signature%'`);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.body).toContain('[code masqué]');
    expect(await tablesContenant(t.db, code!, ['messages', 'trial_outbox', 'journal', 'send_log', 'send_reservations'])).toEqual([]);
    // Le code, lu dans le mail par le signataire, signe.
    expect((await t.online.sign(t.agent, s.value.sessionId, { code: code! })).ok).toBe(true);
  });

  it('un code ne sert qu’une fois ; la preuve garde l’empreinte, l’horodatage et la méthode ; jamais une signature réelle', async () => {
    const t = await setup();
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    expect(await t.codes()).toHaveLength(1);
    t.at(60_000);
    const r = await t.online.sign(t.agent, s.value.sessionId, { code: (await t.codes())[0]!, drawing: 'M10 10 L20 20' });
    expect(r).toMatchObject({ ok: true, value: { documentId: t.documentId, method: 'code_et_trace', mode: 'essai', realSignature: false, signedAt: new Date(T0 + 60_000).toISOString() } });
    expect(await t.online.sign(t.agent, s.value.sessionId, { code: (await t.codes())[0]! })).toEqual({ ok: false, rule: null, code: 'already_signed' });
    // Aucun mandat rangé, aucun numéro donné : la signature en ligne attend H24.
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandates')).toEqual({ n: 0 });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandate_register')).toEqual({ n: 0 });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM signed_documents')).toEqual({ n: 0 });
    // Ni le code ni le tracé ne sont gardés, seulement leurs empreintes ; le journal n'a ni code ni nom.
    const row = await t.db.first<Record<string, string>>('SELECT * FROM signature_sessions');
    expect(JSON.stringify(row)).not.toContain((await t.codes())[0]!);
    expect(JSON.stringify(row)).not.toContain('M10 10');
    const journal = JSON.stringify(await t.journal.all());
    expect(journal).not.toContain((await t.codes())[0]!);
    expect(journal).not.toMatch(/Léa|Exemple/);
  });

  it('un code expire ; cinq essais faux bloquent la session', async () => {
    const t = await setup();
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    t.at(10 * 60_000 + 1);
    expect(await t.online.sign(t.agent, s.value.sessionId, { code: (await t.codes())[0]! })).toEqual({ ok: false, rule: null, code: 'expired' });
    t.at(0);
    const s2 = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s2.ok) throw new Error(s2.code);
    const wrong = (await t.codes())[1] === '000000' ? '000001' : '000000';
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) expect(await t.online.sign(t.agent, s2.value.sessionId, { code: wrong })).toEqual({ ok: false, rule: null, code: 'wrong_code' });
    expect(await t.online.sign(t.agent, s2.value.sessionId, { code: wrong })).toEqual({ ok: false, rule: null, code: 'blocked' });
    expect(await t.online.sign(t.agent, s2.value.sessionId, { code: (await t.codes())[1]! })).toEqual({ ok: false, rule: null, code: 'blocked' });
  });

  it('un document modifié avant ou après la signature est détecté par son empreinte', async () => {
    const t = await setup();
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    expect(await t.online.sign(t.agent, s.value.sessionId, { code: (await t.codes())[0]! })).toMatchObject({ ok: true });
    expect(await t.online.verify(s.value.sessionId)).toEqual({ signed: true, intact: true });
    // Quelqu'un qui a la main sur la base retire la garde du document et le réécrit.
    t.raw.exec('DROP TRIGGER documents_fige');
    await t.db.run('UPDATE documents SET content = ? WHERE id = ?', ['<p>autre texte</p>', t.documentId]);
    expect(await t.online.verify(s.value.sessionId)).toEqual({ signed: true, intact: false });
    const s2 = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s2.ok) throw new Error(s2.code);
    await t.db.run('UPDATE documents SET content = ? WHERE id = ?', ['<p>encore un autre</p>', t.documentId]);
    expect(await t.online.sign(t.agent, s2.value.sessionId, { code: (await t.codes())[1]! })).toEqual({ ok: false, rule: null, code: 'document_changed' });
  });

  it('[R41, R16] un document qui échoue aux contrôles n’ouvre pas de session ; autre agent refusé ; l’envoi d’essai ne garde pas le code', async () => {
    const t = await setup();
    expect(await t.online.start({ role: 'agent', userId: t.sam.id, networkId: t.network.id } as Viewer, t.documentId, CONSENT)).toMatchObject({ ok: false, rule: 'R16' });
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    expect(await t.online.sign({ role: 'agent', userId: t.sam.id, networkId: t.network.id } as Viewer, s.value.sessionId, { code: (await t.codes())[0]! })).toMatchObject({ ok: false, rule: 'R16' });
    // Un nouveau barème plus strict : le document n'est plus au barème, aucune session ne s'ouvre.
    await new ControlesSignature(t.db, (t.online as unknown as { acces: Acces }).acces, t.journal, { now: () => new Date(T0 + 1000) }).setFeeSchedule(t.direction, { maxRatePercent: 1, minEur: 0 });
    expect(await t.online.start(t.agent, t.documentId, CONSENT)).toMatchObject({ ok: false, rule: 'R41', code: 'checks_failed' });
    expect(await t.codes()).toHaveLength(1);
    expect(await t.online.sign(t.agent, 'inconnue', { code: '123456' })).toEqual({ ok: false, rule: null, code: 'unknown_session' });
  });

  it('des essais faux simultanés sont tous comptés ; le code et l’exemplaire passent par le contrôle central', async () => {
    const t = await setup();
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    const code = (await t.codes())[0]!;
    const wrong = code === '000000' ? '000001' : '000000';
    const results = await Promise.all(Array.from({ length: 8 }, () => t.online.sign(t.agent, s.value.sessionId, { code: wrong })));
    expect(results.filter((r) => !r.ok && r.code === 'wrong_code').length).toBeLessThanOrEqual(MAX_CODE_ATTEMPTS - 1);
    expect(await t.db.first<{ attempts: number; status: string }>('SELECT attempts, status FROM signature_sessions')).toEqual({ attempts: MAX_CODE_ATTEMPTS, status: 'bloquee' });
    expect(await t.online.sign(t.agent, s.value.sessionId, { code })).toEqual({ ok: false, rule: null, code: 'blocked' });
    // Le mail du code est passé par le contrôle central : il est au journal des envois, avec son type.
    expect(await t.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM send_log WHERE kind = 'alert' AND outcome = 'sent'`)).toEqual({ n: 1 });
  });

  it('le signataire reçoit son exemplaire dans la boîte d’essai ; la nuit, le code ne part pas [R01]', async () => {
    const t = await setup();
    t.at(12 * 3_600_000); // 23 h à Paris
    expect(await t.online.start(t.agent, t.documentId, CONSENT)).toMatchObject({ ok: false, rule: 'R01', code: 'send_refused' });
    expect(await t.online.start(t.agent, t.documentId, { consentProof: '' })).toEqual({ ok: false, rule: null, code: 'bad_consent' });
    t.at(24 * 3_600_000); // le lendemain, 11 h à Paris
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    await t.online.sign(t.agent, s.value.sessionId, { code: (await t.codes())[0]! });
    expect(await t.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.body LIKE '%exemplaire%'`)).toEqual({ n: 1 });
    // Ce mandant a signé cette version : il ne rouvre pas de session (AU001).
    expect(await t.online.start(t.agent, t.documentId, CONSENT)).toEqual({ ok: false, rule: null, code: 'already_signed' });
  });

  it('l’exemplaire signé est gardé et lisible ; refusé pour l’heure, son envoi est repris plus tard', async () => {
    const t = await setup();
    t.at(8 * 3_600_000 + 58 * 60_000); // 19 h 58 à Paris
    const s = await t.online.start(t.agent, t.documentId, CONSENT);
    if (!s.ok) throw new Error(s.code);
    t.at(9 * 3_600_000 + 1 * 60_000); // 20 h 01 : le code est encore valable, l'envoi d'initiative non
    const r = await t.online.sign(t.agent, s.value.sessionId, { code: (await t.codes())[0]! });
    expect(r).toMatchObject({ ok: true, value: { copySent: false } });
    const copy = await t.online.copy(t.agent, s.value.sessionId);
    expect(copy.ok && copy.sent).toBe(false);
    expect(copy.ok && copy.content).toContain('Mandat de test');
    expect(copy.ok && copy.content).toContain(`session ${s.value.sessionId}`);
    expect(await t.online.copy({ role: 'agent', userId: t.sam.id, networkId: t.network.id } as Viewer, s.value.sessionId)).toMatchObject({ ok: false, rule: 'R16' });
    t.at(22 * 3_600_000); // le lendemain, 9 h à Paris
    expect(await t.online.sendCopy({ role: 'agent', userId: t.sam.id, networkId: t.network.id } as Viewer, s.value.sessionId)).toBe(false);
    expect(await t.online.sendCopy(t.agent, s.value.sessionId)).toBe(true);
    expect(await t.online.sendCopy(t.agent, s.value.sessionId)).toBe(true);
    const sent = await t.db.all<{ body: string }>(`SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.body LIKE '%exemplaire%'`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(s.value.sessionId);
    await expect(t.db.run(`UPDATE signature_sessions SET copy_status = 'a_envoyer'`)).rejects.toThrow(/figée/);
  });

  it('[R03] un accord redonné est rangé quand la ligne ouverte est plus ancienne qu’un retrait (AC07), et un accord qui compte n’est pas doublé', async () => {
    const t = await setup();
    const doc = (await t.db.first<{ person_id: string }>('SELECT person_id FROM documents WHERE id = ?', [t.documentId]))!;
    const store = new FicheClient(t.db, { now: () => new Date(T0) });
    // Un retrait sur la fiche, un accord plus ancien resté ouvert sur son doublon, puis la fusion.
    const twin = await store.createPerson({ networkId: t.network.id, firstName: 'Doublon' });
    await store.addConsent({ networkId: t.network.id, personId: twin.id, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-02T00:00:00.000Z') });
    const old = await store.addConsent({ networkId: t.network.id, personId: doc.person_id, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-01T00:00:00.000Z') });
    await store.withdrawConsent(old.id, new Date('2020-02-01T00:00:00.000Z'));
    const unique = new FicheUnique(t.db, new FicheClient(t.db));
    await unique.merge({ survivorId: doc.person_id, mergedId: twin.id, reason: 'identifiant commun' });
    expect(await unique.hasConsentInForce(doc.person_id, ONLINE_SIGNATURE_PURPOSE, 'email')).toBe(false);
    const lines = () => t.db.all<{ id: string }>('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [doc.person_id, ONLINE_SIGNATURE_PURPOSE]);
    expect(await lines()).toHaveLength(1);
    const first = await t.online.start(t.agent, t.documentId, CONSENT);
    expect(first.ok).toBe(true);
    expect(await lines()).toHaveLength(2);
    expect(await unique.hasConsentInForce(doc.person_id, ONLINE_SIGNATURE_PURPOSE, 'email')).toBe(true);
    t.at(1000);
    await t.online.start(t.agent, t.documentId, CONSENT);
    expect(await lines()).toHaveLength(2);
  });
});
