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
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { designerTout } from './designation-jeu.ts';
import { enClair } from './boite-essai.ts';
import { EspaceVendeur, SqlClientParties, SqlSourcesVendeur, type ClientViewer } from '../src/espaces/index.ts';

// AU001 · Le mandat d'un couple ou d'une indivision. Modèle, barème et personnes inventés.
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
  const generate = async (personId: string, coMandantIds?: string[]) => {
    await designerTout(db);
    return modeles.generate(agent, { kind: 'mandat_vente_simple', personId, propertyId: property.id, inputs: INPUTS as never, ...(coMandantIds ? { coMandantIds } : {}) });
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

describeWithSqlite('AU001 · le mandat d’un couple ou d’une indivision', () => {
  it('[R41] constat de l’audit : avec un seul mandant, un bien à deux propriétaires ne se signe pas', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    await t.owner('Noé', 'Exemple');
    await t.identify(lea);
    const d = await t.generate(lea);
    if (!d.ok) throw new Error(d.code);
    expect(failed(await t.controles.check(t.agent, d.document.id))).toEqual(['mandants_differ']);
    // [R96] Un mandat à un seul mandant est rendu entier dans sa réponse d'accès.
    const access = await conformite.assembleAccess(t.db, [lea]);
    expect(access.sections.find((x) => x.table === 'documents')!.rows[0]!.content).toBe(d.document.content);
  });

  it('[R41] deux propriétaires distincts : le mandat les nomme tous les deux et ne passe qu’une fois chacun identifié, sans réunir leurs fiches', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    const d = await t.generate(lea, [noe]);
    if (!d.ok) throw new Error(d.code);
    expect(d.document.status).toBe('complet');
    expect(d.document.content).toContain('Léa Exemple et Noé Autre');
    // Aucune identité : la première manque.
    expect(failed(await t.controles.check(t.agent, d.document.id))).toEqual(['identity_missing']);
    // La première seule ne suffit pas : celle du second mandant manque encore.
    await t.identify(lea);
    expect(failed(await t.controles.check(t.agent, d.document.id))).toEqual(['identity_missing']);
    await t.identify(noe);
    const r = await t.controles.check(t.agent, d.document.id);
    expect(r).toMatchObject({ ok: true, value: { passed: true } });
    expect(r.ok && r.value.lines.find((l) => l.check === 'mandants')).toEqual({ check: 'mandants', ok: true, code: 'mandants_match' });
    // Les deux fiches restent distinctes.
    expect(await t.unique.rootOf(lea)).toBe(lea);
    expect(await t.unique.rootOf(noe)).toBe(noe);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM person_merges')).toEqual({ n: 0 });
    // Le mandant ajouté est figé avec le document.
    await expect(t.db.run('DELETE FROM document_co_mandants')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE document_co_mandants SET position = 2')).rejects.toThrow(/ne se réécrit pas/);
  });

  it('[R41] un mandant qui n’est pas propriétaire, un propriétaire oublié, deux mandants réunis depuis : refusé', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    const tiers = await t.owner('Tom', 'Tiers', undefined, false);
    for (const id of [lea, noe, tiers]) await t.identify(id);
    const extra = await t.generate(lea, [noe, tiers]);
    if (!extra.ok) throw new Error(extra.code);
    expect(failed(await t.controles.check(t.agent, extra.document.id))).toEqual(['mandants_differ']);
    const ivy = await t.owner('Ivy', 'Troisième');
    await t.identify(ivy);
    const forgot = await t.generate(lea, [noe]);
    if (!forgot.ok) throw new Error(forgot.code);
    expect(failed(await t.controles.check(t.agent, forgot.document.id))).toEqual(['mandants_differ']);
    const all = await t.generate(lea, [noe, ivy]);
    if (!all.ok) throw new Error(all.code);
    expect(all.document.content).toContain('Léa Exemple, Noé Autre et Ivy Troisième');
    expect(failed(await t.controles.check(t.agent, all.document.id))).toEqual([]);
    // Deux mandants réunis après la génération ne sont plus deux personnes : le document ne passe plus.
    await t.unique.merge({ survivorId: noe, mergedId: ivy, reason: 'test : même personne', agentId: t.alex.id });
    expect(failed(await t.controles.check(t.agent, all.document.id))).toEqual(['mandants_merged']);
  });

  it('[R16] le second mandant doit être une autre fiche, vue en entier par l’agent ; jamais deux fois la même', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    const other = await t.owner('Zoé', 'Ailleurs', t.sam.id);
    expect(await t.generate(lea, [lea])).toEqual({ ok: false, rule: null, code: 'bad_co_mandants' });
    expect(await t.generate(lea, [noe, noe])).toEqual({ ok: false, rule: null, code: 'bad_co_mandants' });
    expect(await t.generate(lea, [''])).toEqual({ ok: false, rule: null, code: 'bad_co_mandants' });
    expect(await t.generate(lea, Array.from({ length: 10 }, () => noe))).toEqual({ ok: false, rule: null, code: 'bad_co_mandants' });
    expect(await t.generate(lea, [other])).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM documents')).toEqual({ n: 0 });
    // Une fiche déjà réunie à celle du premier mandant n'en est pas un second.
    const twin = await t.owner('Léa', 'Doublon', undefined, false);
    await t.unique.merge({ survivorId: lea, mergedId: twin, reason: 'test : même personne', agentId: t.alex.id });
    expect(await t.generate(lea, [twin])).toEqual({ ok: false, rule: null, code: 'bad_co_mandants' });
    // Le journal ne porte que le nombre de mandants ajoutés, jamais un nom [R13].
    const d = await t.generate(lea, [noe]);
    if (!d.ok) throw new Error(d.code);
    const event = await t.db.first<{ data: string }>(`SELECT data FROM journal WHERE type = 'document.genere' ORDER BY seq DESC LIMIT 1`);
    expect(JSON.parse(event!.data)).toMatchObject({ coMandants: 1 });
    expect(event!.data).not.toMatch(/Noé|Autre|Léa/);
  });

  it('[R41] en ligne : chaque mandant signe avec son propre code ; le document n’est signé qu’une fois les deux signatures faites', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    const tiers = await t.owner('Tom', 'Tiers', undefined, false);
    await t.identify(lea);
    await t.identify(noe);
    const d = await t.generate(lea, [noe]);
    if (!d.ok) throw new Error(d.code);
    const id = d.document.id;
    expect(await t.online.start(t.agent, id, { ...CONSENT, signerId: tiers })).toEqual({ ok: false, rule: null, code: 'bad_signer' });
    expect(await t.online.progress(t.agent, id)).toEqual({ ok: true, value: { documentId: id, signers: [{ personId: lea, signed: false }, { personId: noe, signed: false }], allSigned: false, allSignedReal: false } });

    const first = await t.online.start(t.agent, id, CONSENT);
    if (!first.ok) throw new Error(first.code);
    const second = await t.online.start(t.agent, id, { ...CONSENT, signerId: noe });
    if (!second.ok) throw new Error(second.code);
    // Chaque code part à son mandant, jamais à l'autre.
    const sent = await t.codes();
    expect(sent.map((c) => c.personId)).toEqual([lea, noe]);
    // Le code de l'un ne signe pas la session de l'autre.
    expect(await t.online.sign(t.agent, second.value.sessionId, { code: sent[0]!.code === sent[1]!.code ? '000000' : sent[0]!.code })).toMatchObject({ ok: false, code: 'wrong_code' });

    const one = await t.online.sign(t.agent, first.value.sessionId, { code: sent[0]!.code });
    expect(one).toMatchObject({ ok: true, value: { allSigned: false, realSignature: false } });
    expect(await t.online.progress(t.agent, id)).toMatchObject({ ok: true, value: { signers: [{ personId: lea, signed: true }, { personId: noe, signed: false }], allSigned: false } });
    expect(await t.online.start(t.agent, id, CONSENT)).toEqual({ ok: false, rule: null, code: 'already_signed' });

    const two = await t.online.sign(t.agent, second.value.sessionId, { code: sent[1]!.code });
    expect(two).toMatchObject({ ok: true, value: { allSigned: true, realSignature: false } });
    expect(await t.online.progress(t.agent, id)).toMatchObject({ ok: true, value: { allSigned: true } });
    // [R96] La réponse d'accès de Noé contient le mandat, mais ni le tracé ni la fiche de Léa.
    const forNoe = JSON.stringify(await conformite.assembleAccess(t.db, [noe]));
    expect(forNoe).toContain(id);
    const leaks = (await conformite.assembleAccess(t.db, [noe])).sections.filter((x) => JSON.stringify(x).includes(lea)).map((x) => x.table);
    expect(leaks).toEqual([]);
    // Ni son nom, que le texte du mandat porte.
    expect(forNoe).not.toMatch(/Léa|Exemple/);
    const sessions = (await conformite.assembleAccess(t.db, [noe])).sections.find((x) => x.table === 'signature_sessions')!;
    expect(sessions.rows).toHaveLength(2);
    for (const row of sessions.rows) expect(row.drawing_hash).toBe(conformite.MASKED);
    // Le signataire d'une session ne change plus.
    await expect(t.db.run('UPDATE signature_sessions SET signer_person_id = ?', [tiers])).rejects.toThrow(/figée/);
    // Un autre agent ne lit pas où en est la signature [R16].
    expect(await t.online.progress(t.samViewer, id)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R41] AU003 : un mandant d’essai et un réel ne font pas un mandat signé ; signé réellement par les deux, chacun reçoit son exemplaire et le dossier', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    await t.identify(lea);
    await t.identify(noe);
    const d = await t.generate(lea, [noe]);
    if (!d.ok) throw new Error(d.code);
    const id = d.document.id;
    // Léa signe en essai, avant la validation de l'avocat.
    const essai = await t.online.start(t.agent, id, CONSENT);
    if (!essai.ok) throw new Error(essai.code);
    expect((await t.online.sign(t.agent, essai.value.sessionId, { code: (await t.codes())[0]!.code })).ok).toBe(true);
    expect((await t.online.recordValidation(t.direction, { reference: 'Avis écrit test', validatedOn: new Date(T0 - 86_400_000) })).ok).toBe(true);
    const mail = new FakeChannel('email');
    const reel = new SignatureEnLigne(t.db, t.acces, t.journal, { now: t.now, channels: [mail] });
    const codeOf = (to: string) => /(\d{6})/.exec(mail.sent.filter((m) => m.to === to && m.body.includes('code de signature')).at(-1)!.body)![1]!;
    // Noé signe en réel : le document n'est pas signé réellement, la signature d'essai de Léa ne compte pas.
    const s2 = await reel.start(t.agent, id, { ...CONSENT, signerId: noe });
    if (!s2.ok) throw new Error(s2.code);
    expect(s2.value.mode).toBe('reel');
    expect(await reel.sign(t.agent, s2.value.sessionId, { code: codeOf('noé.autre@example.test') })).toMatchObject({ ok: true, value: { realSignature: true, allSigned: false } });
    expect(await reel.progress(t.agent, id)).toMatchObject({ ok: true, value: { allSigned: true, allSignedReal: false } });
    expect(await reel.finish(t.agent, id, { source: 'referral' })).toEqual({ ok: false, rule: 'R41', code: 'not_all_signed' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM signed_documents')).toEqual({ n: 0 });
    // Léa signe de nouveau, en réel.
    const s1 = await reel.start(t.agent, id, CONSENT);
    if (!s1.ok) throw new Error(s1.code);
    expect(await reel.sign(t.agent, s1.value.sessionId, { code: codeOf('léa.exemple@example.test') })).toMatchObject({ ok: true, value: { realSignature: true, allSigned: true } });
    // Une instance sans mail réel ne remet rien, ni par la boîte d'essai : les remises restent à envoyer.
    const done = await t.online.finish(t.agent, id, { source: 'referral' });
    expect(done).toMatchObject({ ok: true, value: { number: 'T-001', remises: [{ position: 1, sent: false }, { position: 2, sent: false }] } });
    expect((await enClair(t.db.all<{ id: string; body: string }>('SELECT m.id, m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id'))).some((m) => m.body.includes('dossier de preuve'))).toBe(false);
    // Par le mail réel : chaque mandant, à sa propre adresse, une seule fois.
    expect(await reel.finish(t.agent, id)).toMatchObject({ ok: true, value: { remises: [{ position: 1, sent: true }, { position: 2, sent: true }] } });
    expect(mail.sent.filter((m) => m.body.includes('dossier de preuve vous sont remis')).map((m) => m.to)).toEqual(['léa.exemple@example.test', 'noé.autre@example.test']);
    const dossier = await reel.dossier(t.agent, id);
    expect(dossier.ok && dossier.value.dossier).toContain('Mandant 2');
    expect(dossier.ok && dossier.value.dossier).not.toMatch(/Léa|Noé/);
  });

  it('[R16] la fiche du second mandant confiée à un autre agent : ni accord ni code envoyés par l’agent du premier', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    await t.identify(lea);
    await t.identify(noe);
    const d = await t.generate(lea, [noe]);
    if (!d.ok) throw new Error(d.code);
    const s = await t.online.start(t.agent, d.document.id, { ...CONSENT, signerId: noe });
    if (!s.ok) throw new Error(s.code);
    await t.online.sign(t.agent, s.value.sessionId, { code: (await t.codes())[0]!.code });
    const leaPending = await t.online.start(t.agent, d.document.id, CONSENT);
    if (!leaPending.ok) throw new Error(leaPending.code);
    const leaCode = (await t.codes()).at(-1)!.code;
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, noe]);
    // La session du premier, ouverte avant, ne signe pas non plus : son résultat dirait l'état du second.
    expect(await t.online.sign(t.agent, leaPending.value.sessionId, { code: leaCode })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    // Une session ouverte avant la réaffectation ne signe pas non plus.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.alex.id, noe]);
    const lateDoc = await t.generate(lea, [noe]);
    if (!lateDoc.ok) throw new Error(lateDoc.code);
    const late = await t.online.start(t.agent, lateDoc.document.id, { ...CONSENT, signerId: noe });
    if (!late.ok) throw new Error(late.code);
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, noe]);
    expect(await t.online.sign(t.agent, late.value.sessionId, { code: (await t.codes()).at(-1)!.code })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.db.first(`SELECT status FROM signature_sessions WHERE id = ?`, [late.value.sessionId])).toEqual({ status: 'ouverte' });
    const before = await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM messages');
    expect(await t.online.start(t.agent, d.document.id, { ...CONSENT, signerId: noe })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.online.progress(t.agent, d.document.id)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    // Ni le texte, ni l'exemplaire signé du second.
    expect(await t.modeles.read(t.agent, d.document.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.online.copy(t.agent, s.value.sessionId)).toMatchObject({ ok: false, rule: 'R16' });
    // Ni contrôle avant signature, ni mandat papier enregistré par l'agent du premier.
    expect(await t.controles.check(t.agent, d.document.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.papier.register(t.agent, d.document.id, { signedAt: new Date(T0), place: 'agence', scanRef: 'scans/2027/02/test-r16.pdf', source: 'referral' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM messages')).toEqual(before);
  });

  it('[R41] deux mandants réunis après l’ouverture des sessions : aucune signature reçue, jamais « tous signé »', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    await t.identify(lea);
    await t.identify(noe);
    const d = await t.generate(lea, [noe]);
    if (!d.ok) throw new Error(d.code);
    const a = await t.online.start(t.agent, d.document.id, CONSENT);
    const b = await t.online.start(t.agent, d.document.id, { ...CONSENT, signerId: noe });
    if (!a.ok || !b.ok) throw new Error('session');
    const sent = await t.codes();
    expect(await t.online.sign(t.agent, a.value.sessionId, { code: sent[0]!.code })).toMatchObject({ ok: true, value: { allSigned: false } });
    await t.unique.merge({ survivorId: lea, mergedId: noe, reason: 'test : même personne', agentId: t.alex.id });
    expect(await t.online.sign(t.agent, b.value.sessionId, { code: sent[1]!.code })).toEqual({ ok: false, rule: 'R41', code: 'mandants_merged' });
    expect(await t.online.progress(t.agent, d.document.id)).toMatchObject({ ok: true, value: { allSigned: false } });
  });

  it('[R40, R41] un modèle qui ne nomme pas le mandant ne porte pas plusieurs mandants', async () => {
    const t = await setup();
    const v = await t.modeles.createVersion(t.direction, 'mandat_vente_simple', 'Mandat sans nom : {{bien.reference}}, honoraires {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.');
    if (!v.ok) throw new Error(v.code);
    await t.modeles.validate({ role: 'compliance', userId: 'c-1', networkId: t.network.id }, v.template.id);
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    expect(await t.modeles.generate(t.agent, { kind: 'mandat_vente_simple', personId: lea, propertyId: t.property.id, inputs: INPUTS as never, coMandantIds: [noe] })).toEqual({ ok: false, rule: 'R40', code: 'bad_co_mandants' });
  });

  it('[R16] un avenant reprend les autres mandants sous droits : fiche confiée à un autre agent, avenant refusé', async () => {
    const t = await setup();
    const av = await t.modeles.createVersion(t.direction, 'avenant_mandat', 'Avenant : {{mandant.nom}}, mandat {{mandat.numero}}, {{avenant.objet}}.');
    if (!av.ok) throw new Error(av.code);
    await t.modeles.validate({ role: 'compliance', userId: 'c-1', networkId: t.network.id }, av.template.id);
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    await t.identify(lea);
    await t.identify(noe);
    const d = await t.generate(lea, [noe]);
    if (!d.ok) throw new Error(d.code);
    const r = await t.papier.register(t.agent, d.document.id, { signedAt: new Date(T0), place: 'agence', scanRef: 'scans/2027/02/test-avenant.pdf', source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    const mandateId = (await t.db.first<{ mandate_id: string }>('SELECT mandate_id FROM signed_documents WHERE document_id = ?', [d.document.id]))!.mandate_id;
    const ok = await t.modeles.generate(t.agent, { kind: 'avenant_mandat', personId: lea, propertyId: t.property.id, mandateId, inputs: { 'avenant.prix': 240000 } as never });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok && ok.document.content).toContain('Léa Exemple et Noé Autre');
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, noe]);
    expect(await t.modeles.generate(t.agent, { kind: 'avenant_mandat', personId: lea, propertyId: t.property.id, mandateId, inputs: { 'avenant.prix': 240000 } as never })).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R41, R92] sur papier : le mandat n’est numéroté que si chaque mandant était identifié au jour de la signature', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    await t.identify(lea);
    const d = await t.generate(lea, [noe]);
    if (!d.ok) throw new Error(d.code);
    const paper = { signedAt: new Date(T0), place: 'agence' as const, scanRef: 'scans/2027/02/test-couple.pdf', source: 'referral' };
    expect(await t.papier.register(t.agent, d.document.id, paper)).toMatchObject({ ok: false, rule: 'R41' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandate_register')).toEqual({ n: 0 });
    await t.identify(noe);
    expect(await t.papier.register(t.agent, d.document.id, paper)).toMatchObject({ ok: true });
    expect(await t.papier.copy(t.agent, d.document.id)).toMatchObject({ ok: true });
    // [R16] Le second mandant confié à un autre agent : l'exemplaire, qui le nomme, n'est plus rendu.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, noe]);
    expect(await t.papier.copy(t.agent, d.document.id)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
  });

  it('[R39] [R16] [R161] AU001b : chaque mandant d’un mandat signé a son espace vendeur, avec le mandat et son numéro, sans rien de l’autre', async () => {
    const t = await setup();
    const lea = await t.owner('Léa', 'Exemple');
    const noe = await t.owner('Noé', 'Autre');
    await t.identify(lea);
    await t.identify(noe);
    const d = await t.generate(lea, [noe]);
    if (!d.ok) throw new Error(d.code);
    const r = await t.papier.register(t.agent, d.document.id, { signedAt: new Date(T0), place: 'agence', scanRef: 'scans/2027/02/test-espace.pdf', source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    const number = (await t.db.first<{ number: string }>('SELECT number FROM signed_documents WHERE document_id = ?', [d.document.id]))!.number;
    expect(number).toBe('T-001');
    // Ce qui n'est qu'à Léa : un document à elle seule et un rendez-vous d'estimation avec elle.
    const own = await t.generate(lea);
    if (!own.ok) throw new Error(own.code);
    const at = new Date(T0 + 86_400_000).toISOString();
    const end = new Date(T0 + 90_000_000).toISOString();
    await t.db.run(
      `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES ('rdv-lea', ?, ?, ?, ?, 'estimation', ?, ?, 'booked', 'h-rdv-lea', 'agent', NULL, ?, ?)`,
      [t.network.id, t.alex.id, lea, t.property.id, at, end, at, at],
    );
    const parties = new SqlClientParties(t.db);
    const espace = new EspaceVendeur(new SqlSourcesVendeur(t.db, t.acces, t.journal, { now: t.now }), t.journal, { now: t.now });
    const viewer = async (personId: string): Promise<ClientViewer> => ({ kind: 'client', networkId: t.network.id, personId, sessionId: `s-${personId}`, sides: await parties.sidesOf(t.network.id, personId) });
    // Le second mandant : un espace vendeur, le mandat et son numéro.
    const noeViewer = await viewer(noe);
    expect(noeViewer.sides).toContain('vendeur');
    const forNoe = await espace.vue(noeViewer);
    if (!forNoe.ok) throw new Error(forNoe.code);
    expect(forNoe.value.map((b) => b.reference)).toEqual(['REF-T-1']);
    const mandat = forNoe.value[0]!.documents.filter((x) => x.kind === 'mandat_vente_simple');
    expect(mandat).toHaveLength(1);
    expect(mandat[0]!.signature.value).toBe('signé');
    expect(mandat[0]!.number).toMatchObject({ value: 'T-001', source: 'registre des mandats' });
    // Rien de l'autre mandant : ni son document à elle seule, ni son rendez-vous, ni son nom, ni sa fiche [R16].
    expect(forNoe.value[0]!.appointments).toEqual([]);
    const text = JSON.stringify(forNoe.value);
    expect(text).not.toContain(lea);
    expect(text).not.toContain(own.document.id);
    expect(text).not.toMatch(/Léa|Exemple/);
    // Le premier mandant voit toujours le sien, avec le même numéro, et ce qui n'est qu'à lui.
    const forLea = await espace.vue(await viewer(lea));
    if (!forLea.ok) throw new Error(forLea.code);
    expect(forLea.value[0]!.documents.filter((x) => x.kind === 'mandat_vente_simple' && x.number.value === 'T-001')).toHaveLength(1);
    expect(forLea.value[0]!.documents.filter((x) => x.kind === 'mandat_vente_simple')).toHaveLength(2);
    expect(forLea.value[0]!.appointments).toHaveLength(1);
    // Une tierce personne, propriétaire mais pas mandant, n'a pas d'espace vendeur.
    const tiers = await t.owner('Tom', 'Tiers');
    expect((await viewer(tiers)).sides).not.toContain('vendeur');
  });
});
