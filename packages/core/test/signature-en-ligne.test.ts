import { expect, it } from 'vitest';
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
  TrialCodeSender,
  applyMigrations,
  fromSyncSqlite,
  type CodeSender,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Modèle et personnes inventés.
const BODY = 'Mandat de test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}}.';
const T0 = Date.parse('2027-02-10T10:00:00.000Z');

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
  await controles.recordIdentity(agent, p.id, { piece: 'carte_identite', seenAt: new Date(T0) });
  const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } });
  if (!d.ok) throw new Error(d.code);
  const codes: string[] = [];
  const sender: CodeSender = { send: async ({ code }) => void codes.push(code) };
  const online = new SignatureEnLigne(db, acces, journal, sender, { now });
  return { raw, db, journal, online, agent, direction, sam, network, documentId: d.document.id, codes, at: (ms: number) => (clock = T0 + ms) };
}

describeWithSqlite('D08 · signature en ligne AIMMO, en mode essai', () => {
  it('un code ne sert qu’une fois ; la preuve garde l’empreinte, l’horodatage et la méthode ; jamais une signature réelle', async () => {
    const t = await setup();
    const s = await t.online.start(t.agent, t.documentId);
    if (!s.ok) throw new Error(s.code);
    expect(t.codes).toHaveLength(1);
    expect(t.codes[0]).toMatch(/^\d{6}$/);
    t.at(60_000);
    const r = await t.online.sign(t.agent, s.value.sessionId, { code: t.codes[0]!, drawing: 'M10 10 L20 20' });
    expect(r).toMatchObject({ ok: true, value: { documentId: t.documentId, method: 'code_et_trace', mode: 'essai', realSignature: false, signedAt: new Date(T0 + 60_000).toISOString() } });
    expect(await t.online.sign(t.agent, s.value.sessionId, { code: t.codes[0]! })).toEqual({ ok: false, rule: null, code: 'already_signed' });
    // Aucun mandat rangé, aucun numéro donné : la signature en ligne attend H24.
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandates')).toEqual({ n: 0 });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandate_register')).toEqual({ n: 0 });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM signed_documents')).toEqual({ n: 0 });
    // Ni le code ni le tracé ne sont gardés, seulement leurs empreintes ; le journal n'a ni code ni nom.
    const row = await t.db.first<Record<string, string>>('SELECT * FROM signature_sessions');
    expect(JSON.stringify(row)).not.toContain(t.codes[0]!);
    expect(JSON.stringify(row)).not.toContain('M10 10');
    const journal = JSON.stringify(await t.journal.all());
    expect(journal).not.toContain(t.codes[0]!);
    expect(journal).not.toMatch(/Léa|Exemple/);
  });

  it('un code expire ; cinq essais faux bloquent la session', async () => {
    const t = await setup();
    const s = await t.online.start(t.agent, t.documentId);
    if (!s.ok) throw new Error(s.code);
    t.at(10 * 60_000 + 1);
    expect(await t.online.sign(t.agent, s.value.sessionId, { code: t.codes[0]! })).toEqual({ ok: false, rule: null, code: 'expired' });
    t.at(0);
    const s2 = await t.online.start(t.agent, t.documentId);
    if (!s2.ok) throw new Error(s2.code);
    const wrong = t.codes[1] === '000000' ? '000001' : '000000';
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) expect(await t.online.sign(t.agent, s2.value.sessionId, { code: wrong })).toEqual({ ok: false, rule: null, code: 'wrong_code' });
    expect(await t.online.sign(t.agent, s2.value.sessionId, { code: wrong })).toEqual({ ok: false, rule: null, code: 'blocked' });
    expect(await t.online.sign(t.agent, s2.value.sessionId, { code: t.codes[1]! })).toEqual({ ok: false, rule: null, code: 'blocked' });
  });

  it('un document modifié avant ou après la signature est détecté par son empreinte', async () => {
    const t = await setup();
    const s = await t.online.start(t.agent, t.documentId);
    if (!s.ok) throw new Error(s.code);
    expect(await t.online.sign(t.agent, s.value.sessionId, { code: t.codes[0]! })).toMatchObject({ ok: true });
    expect(await t.online.verify(s.value.sessionId)).toEqual({ signed: true, intact: true });
    // Quelqu'un qui a la main sur la base retire la garde du document et le réécrit.
    t.raw.exec('DROP TRIGGER documents_fige');
    await t.db.run('UPDATE documents SET content = ? WHERE id = ?', ['<p>autre texte</p>', t.documentId]);
    expect(await t.online.verify(s.value.sessionId)).toEqual({ signed: true, intact: false });
    const s2 = await t.online.start(t.agent, t.documentId);
    if (!s2.ok) throw new Error(s2.code);
    await t.db.run('UPDATE documents SET content = ? WHERE id = ?', ['<p>encore un autre</p>', t.documentId]);
    expect(await t.online.sign(t.agent, s2.value.sessionId, { code: t.codes[1]! })).toEqual({ ok: false, rule: null, code: 'document_changed' });
  });

  it('[R41, R16] un document qui échoue aux contrôles n’ouvre pas de session ; autre agent refusé ; l’envoi d’essai ne garde pas le code', async () => {
    const t = await setup();
    expect(await t.online.start({ role: 'agent', userId: t.sam.id, networkId: t.network.id } as Viewer, t.documentId)).toMatchObject({ ok: false, rule: 'R16' });
    const s = await t.online.start(t.agent, t.documentId);
    if (!s.ok) throw new Error(s.code);
    expect(await t.online.sign({ role: 'agent', userId: t.sam.id, networkId: t.network.id } as Viewer, s.value.sessionId, { code: t.codes[0]! })).toMatchObject({ ok: false, rule: 'R16' });
    // Un nouveau barème plus strict : le document n'est plus au barème, aucune session ne s'ouvre.
    await new ControlesSignature(t.db, (t.online as unknown as { acces: Acces }).acces, t.journal, { now: () => new Date(T0 + 1000) }).setFeeSchedule(t.direction, { maxRatePercent: 1, minEur: 0 });
    expect(await t.online.start(t.agent, t.documentId)).toMatchObject({ ok: false, rule: 'R41', code: 'checks_failed' });
    expect(t.codes).toHaveLength(1);
    const trial = new TrialCodeSender(t.journal, () => new Date(T0));
    await trial.send({ networkId: t.network.id, personId: 'p', sessionId: 's', code: '123456' });
    expect(JSON.stringify(await t.journal.all())).not.toContain('123456');
    expect(await t.online.sign(t.agent, 'inconnue', { code: '123456' })).toEqual({ ok: false, rule: null, code: 'unknown_session' });
  });
});
