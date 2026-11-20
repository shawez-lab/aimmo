import { expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  FakeChannel,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignatureEnLigne,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  conformite,
  fromSyncSqlite,
  documentProxies,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { designerTout } from './designation-jeu.ts';
import { enClair } from './boite-essai.ts';

// AU059 · Le vendeur représenté par procuration. Modèle, barème, personnes et scans inventés.
const BODY = 'Mandat de test : {{mandant.nom}}, {{bien.reference}}, honoraires {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.';
const T0 = Date.parse('2027-02-10T10:00:00.000Z'); // mercredi, 11 h à Paris
const INPUTS = { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as const;
const CONSENT = { consentProof: 'accord donné au rendez-vous (test)' };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => new Date(T0);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, unique, journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const online = new SignatureEnLigne(db, acces, journal, { now });
  const papier = new SignaturePapier(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const samViewer: Viewer = { role: 'agent', userId: sam.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'direction-1', networkId: network.id };
  const v = await modeles.createVersion(direction, 'mandat_vente_simple', BODY);
  if (!v.ok) throw new Error(v.code);
  await modeles.validate({ role: 'compliance', userId: 'c-1', networkId: network.id }, v.template.id);
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 90, rooms: 4, priceEur: 250000 });
  /** Un propriétaire du bien, avec sa propre fiche et son propre mail. */
  const owner = async (firstName: string, lastName: string, agentId = alex.id, owns = true) => {
    const p = await store.createPerson({ networkId: network.id, agentId, firstName, lastName });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.test` });
    if (owns) {
      const project = await store.createProject({ networkId: network.id, agentId, personId: p.id, kind: 'sell' });
      await store.linkProjectProperty({ networkId: network.id, agentId, projectId: project.id, propertyId: property.id, role: 'owned' });
    }
    return p.id;
  };
  const identify = (personId: string) => identiteAuCoffre({ db, acces, journal, now }, agent, personId, { piece: 'carte_identite', seenAt: new Date(T0) });
  const generate = async (personId: string, extra: { coMandantIds?: string[]; proxies?: unknown[] } = {}) => {
    await designerTout(db);
    return modeles.generate(agent, { kind: 'mandat_vente_simple', personId, propertyId: property.id, inputs: INPUTS as never, ...(extra as object) });
  };
  /** Les codes rangés dans la boîte d'essai, avec la fiche à qui chacun part. */
  const codes = async (): Promise<{ personId: string; code: string }[]> =>
    (
      await enClair(
        db.all<{ id: string; body: string; person_id: string }>(
          `SELECT m.id, m.body, m.person_id FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.body LIKE '%code de signature%' ORDER BY m.occurred_at, m.created_at`,
        ),
      )
    ).map((r) => ({ personId: r.person_id, code: /(\d{6})/.exec(r.body)![1]! }));
  return { db, journal, acces, now, store, unique, modeles, controles, online, papier, network, alex, sam, agent, samViewer, direction, property, owner, identify, generate, codes };
}

const failed = (r: Awaited<ReturnType<ControlesSignature['check']>>) => (r.ok ? r.value.lines.filter((l) => !l.ok).map((l) => l.code) : [r.code]);
const REF = (propertyId: string, n = 1) => `mandats/${propertyId}/0000000${n}-0000-4000-8000-000000000000.pdf`;
const proxyOf = (mandantId: string, proxyId: string, propertyId: string, over: Record<string, unknown> = {}) => ({ mandantId, proxyId, powerKind: 'notariee', grantedOn: '2027-02-01', powerRef: REF(propertyId), ...over });

describeWithSqlite('AU059 · le vendeur représenté par procuration', () => {
  it('[R41] le mandat distingue la partie et son représentant, nommés tous deux avec la procuration', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const paul = await t.owner('Paul', 'Tiers', undefined, false);
    const d = await t.generate(lea, { proxies: [proxyOf(lea, paul, t.property.id)] });
    if (!d.ok) throw new Error(d.code);
    expect(d.document.status).toBe('complet');
    expect(d.document.content).toContain('Léa Exemple, ayant pour représentant Paul Tiers en vertu d’une procuration notariée du 01/02/2027');
    expect(await documentProxies(t.db, d.document.id)).toEqual([{ mandantId: lea, proxyId: paul, powerKind: 'notariee', grantedOn: '2027-02-01', powerRef: REF(t.property.id) }]);
    // Rien ne se réécrit ni ne s'efface [R17].
    await expect(t.db.run('UPDATE document_proxies SET proxy_person_id = mandant_person_id')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM document_proxies')).rejects.toThrow();
  });

  it('[R16, R41] une procuration mal donnée est refusée : rien n’est préparé', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    const paul = await t.owner('Paul', 'Tiers', undefined, false);
    const autre = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'REF-T-2', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 50, rooms: 2, priceEur: 150000 });
    const bad = { ok: false, rule: null, code: 'bad_proxies' };
    // Le représentant ne peut pas être un mandant ; le représenté doit en être un ; une seule procuration par mandant.
    expect(await t.generate(lea, { coMandantIds: [noe], proxies: [proxyOf(lea, noe, t.property.id)] })).toEqual(bad);
    expect(await t.generate(lea, { proxies: [proxyOf(paul, lea, t.property.id)] })).toEqual(bad);
    expect(await t.generate(lea, { proxies: [proxyOf(lea, paul, t.property.id), proxyOf(lea, paul, t.property.id, { powerRef: REF(t.property.id, 2) })] })).toEqual(bad);
    // Une procuration future, d'une autre sorte, ou dont le scan est rangé pour un autre bien.
    expect(await t.generate(lea, { proxies: [proxyOf(lea, paul, t.property.id, { grantedOn: '2027-03-01' })] })).toEqual(bad);
    expect(await t.generate(lea, { proxies: [proxyOf(lea, paul, t.property.id, { powerKind: 'orale' })] })).toEqual(bad);
    expect(await t.generate(lea, { proxies: [proxyOf(lea, paul, autre.id, { powerRef: REF(autre.id) })] })).toEqual(bad);
    expect(await t.generate(lea, { proxies: [proxyOf(lea, paul, t.property.id, { note: 'x' })] })).toEqual(bad);
    // Un représentant dont l'agent ne voit pas la fiche [R16].
    const ailleurs = await t.owner('Zoé', 'Ailleurs', t.sam.id, false);
    expect(await t.generate(lea, { proxies: [proxyOf(lea, ailleurs, t.property.id)] })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.db.all('SELECT * FROM document_proxies')).toEqual([]);
  });

  it('[R41] le contrôle exige la procuration dans le stockage et l’identité vérifiée du représentant', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const paul = await t.owner('Paul', 'Tiers', undefined, false);
    await t.identify(lea);
    const d = await t.generate(lea, { proxies: [proxyOf(lea, paul, t.property.id)] });
    if (!d.ok) throw new Error(d.code);
    const stored = new Set<string>();
    const withScans = (scans: { has(ref: string): Promise<boolean> } | null) => new ControlesSignature(t.db, t.acces, t.journal, { now: t.now, scans });
    const store = { has: async (r: string) => stored.has(r) };
    // Sans stockage où la vérifier, la procuration ne passe jamais.
    expect(failed(await t.controles.check(t.agent, d.document.id))).toEqual(['depot_ferme']);
    expect(failed(await withScans(null).check(t.agent, d.document.id))).toEqual(['depot_ferme']);
    expect(failed(await withScans(store).check(t.agent, d.document.id))).toEqual(['power_absent']);
    stored.add(REF(t.property.id));
    expect(failed(await withScans(store).check(t.agent, d.document.id))).toEqual(['proxy_identity_missing']);
    await t.identify(paul);
    const ok = await withScans(store).check(t.agent, d.document.id);
    expect(failed(ok)).toEqual([]);
    expect(ok.ok && ok.value.lines.find((l) => l.check === 'procuration')).toEqual({ check: 'procuration', ok: true, code: 'power_checked' });
  });

  it('[R41] en ligne, le code part au représentant, qui signe pour le mandant ; c’est gardé', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const paul = await t.owner('Paul', 'Tiers', undefined, false);
    await t.identify(lea);
    await t.identify(paul);
    const d = await t.generate(lea, { proxies: [proxyOf(lea, paul, t.property.id)] });
    if (!d.ok) throw new Error(d.code);
    const online = new SignatureEnLigne(t.db, t.acces, t.journal, { now: t.now, scans: { has: async (r) => r === REF(t.property.id) } });
    const session = await online.start(t.agent, d.document.id, CONSENT);
    if (!session.ok) throw new Error(session.code);
    const sent = await t.codes();
    expect(sent.map((c) => c.personId)).toEqual([paul]);
    expect(await t.db.all('SELECT mandant_person_id, proxy_person_id FROM signature_session_proxies WHERE session_id = ?', [session.value.sessionId])).toEqual([{ mandant_person_id: lea, proxy_person_id: paul }]);
    expect(await online.sign(t.agent, session.value.sessionId, { code: sent[0]!.code })).toMatchObject({ ok: true, value: { allSigned: true } });
    // L'exemplaire part au représentant, qui a donné son accord ; le mandant n'en reçoit rien sans le sien [R03].
    expect(await online.sendCopy(t.agent, session.value.sessionId)).toBe(true);
    const copies = await enClair(t.db.all<{ id: string; body: string; person_id: string }>("SELECT m.id, m.body, m.person_id FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.body LIKE '%enregistré sous la référence%'"));
    expect(copies.map((c) => c.person_id)).toEqual([paul]);
  });

  it('[R41] un représentant réuni à un mandant après l’envoi du code : le code ne signe plus rien', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const paul = await t.owner('Paul', 'Tiers', undefined, false);
    await t.identify(lea);
    await t.identify(paul);
    const d = await t.generate(lea, { proxies: [proxyOf(lea, paul, t.property.id)] });
    if (!d.ok) throw new Error(d.code);
    const online = new SignatureEnLigne(t.db, t.acces, t.journal, { now: t.now, scans: { has: async (r) => r === REF(t.property.id) } });
    const session = await online.start(t.agent, d.document.id, CONSENT);
    if (!session.ok) throw new Error(session.code);
    const sent = await t.codes();
    await t.unique.merge({ survivorId: lea, mergedId: paul, reason: 'test : même personne', agentId: t.alex.id });
    expect(await online.sign(t.agent, session.value.sessionId, { code: sent[0]!.code })).toEqual({ ok: false, rule: 'R41', code: 'mandants_merged' });
    expect(await t.db.first("SELECT status FROM signature_sessions WHERE id = ?", [session.value.sessionId])).not.toEqual({ status: 'signee' });
  });

  it('[R16] le document nomme le représentant : qui ne voit plus sa fiche ne lit plus le document', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const paul = await t.owner('Paul', 'Tiers', undefined, false);
    const d = await t.generate(lea, { proxies: [proxyOf(lea, paul, t.property.id)] });
    if (!d.ok) throw new Error(d.code);
    expect((await t.modeles.read(t.agent, d.document.id)).ok).toBe(true);
    // Le représentant confié à un autre agent : sa fiche n'est plus vue en entier.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, paul]);
    expect(await t.modeles.read(t.agent, d.document.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.controles.check(t.agent, d.document.id)).toMatchObject({ ok: false, rule: 'R16' });
    // Une date du calendrier mal formée est refusée, jamais une erreur.
    // L'exemplaire signé sur papier nomme le représentant : il n'est rendu qu'à qui le voit aussi en entier.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.alex.id, paul]);
    await t.identify(lea);
    await t.identify(paul);
    const papier = new SignaturePapier(t.db, t.acces, t.journal, { now: t.now, scans: { has: async () => true } });
    expect(await papier.register(t.agent, d.document.id, { signedAt: new Date(T0), place: 'agence', scanRef: `mandats/${t.property.id}/00000009-0000-4000-8000-000000000000.pdf`, source: 'referral' })).toMatchObject({ ok: true });
    expect((await papier.copy(t.agent, d.document.id)).ok).toBe(true);
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, paul]);
    expect(await papier.copy(t.agent, d.document.id)).toMatchObject({ ok: false, rule: 'R16' });
    const marc = await t.owner('Marc', 'Tiers', undefined, false);
    expect(await t.generate(lea, { proxies: [proxyOf(lea, marc, t.property.id, { grantedOn: '2027-13-01' })] })).toEqual({ ok: false, rule: null, code: 'bad_proxies' });
  });
});
