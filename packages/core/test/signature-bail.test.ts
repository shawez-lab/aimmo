import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { MAX_CODE_ATTEMPTS, ONLINE_SIGNATURE_PURPOSE } from '../src/documents/signature-en-ligne.ts';
import { Annuaire, MiseEnRelation } from '../src/partenaires/index.ts';
import {
  BauxLocation,
  Candidatures,
  ChoixProprietaire,
  EtatsDesLieux,
  HonorairesLocation,
  MisesEnLocation,
  REAL_LEASE_SIGNATURE,
  RemisesDesCles,
  SignaturesBail,
  type RentalFacts,
} from '../src/location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { signRentalMandate } from './mandat-location-jeu.ts';
import { enClair } from './boite-essai.ts';

// Réseau, agents, propriétaire, candidats, logement, adresses et mails inventés. Le 12 juillet 2027 est un lundi.
const T0 = Date.parse('2027-07-12T08:00:00.000Z'); // 10 h à Paris
let clock = T0;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);
const CONSENT = { consentProof: 'accord donné au rendez-vous (essai)' };
const FACTS: RentalFacts = {
  furnished: false,
  rentCents: 65_000,
  chargesCents: 5_000,
  livingAreaHundredths: 4_250,
  energyClass: 'D',
  finalEnergyKwh: 210,
  buildYear: 1985,
  electricityOver15: false,
  mainRoomHundredths: 1_800,
  ceilingHeightCm: 250,
  localRules: { reference: 'Règlement sanitaire départemental, art. 40', checkedOn: '2027-01-04', compliant: true },
  firstLetting: true,
  gas: 'aucune',
  leaseStart: '2027-09-01',
  chargesMode: 'provision',
};
const INPUT = { address: '12 allée des Essais', ownerAddress: '3 chemin des Exemples, Ailleurs-Essai', habitat: 'collectif', landlord: 'physique', equipment: 'Cuisine équipée, cave', professionalCard: 'CPI 2101 2027 000 000 001' };
const FEES = { tenantCents: 34_000, tenantInventoryCents: 12_750, landlordCents: 34_000, landlordInventoryCents: 12_750, depositCents: 65_000 };
const BODY = [
  'Bail de {{bail.type}} entre {{bailleur.nom}}, domicilié {{bailleur.domicile}}, bailleur, et {{locataire.nom}}, locataire.',
  'Mandataire : {{reseau.nom}}, représenté par {{agent.nom}}, carte professionnelle {{mandataire.carte}}.',
  'Désignation : {{logement.habitat}}, {{logement.pieces}} pièces principales ; équipements : {{logement.equipements}}.',
  'Logement : {{logement.adresse}}, {{logement.commune}}, surface habitable {{logement.surface_habitable}}, classe énergie {{logement.classe_energie}}.',
  'Prise d’effet le {{bail.debut}}, pour {{bail.duree}}.',
  'Loyer : {{loyer.hors_charges}} ; charges : {{charges.montant}}, en {{charges.mode}} ; dépôt de garantie : {{depot.montant}}.',
  'Honoraires du locataire : {{honoraires.locataire}}, dont état des lieux {{honoraires.etat_des_lieux}} ; du bailleur : {{honoraires.bailleur}}.',
  'Annexes : {{annexes.liste}}.',
  'Fait le {{signature.date}} à {{signature.lieu}}.',
].join('\n\n');

async function setup() {
  clock = T0;
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  // Une seconde par lecture de l'horloge : la session de 10 minutes tient sur tout un passage.
  const now = (): Date => new Date((clock += 1_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r) };
  const put = (prefix: string) => {
    const r = `${prefix}/${uuid()}.pdf`;
    refs.add(r);
    return r;
  };
  const listings = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const fees = new HonorairesLocation(db, listings, journal, { now });
  const identity = { state: async () => ({ identityVerifiedOn: '2027-07-10' }) };
  const apps = new Candidatures(db, listings, identity, files, journal, { now, newId: uuid });
  const choix = new ChoixProprietaire(db, listings, apps, files, journal, { now, newId: uuid });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const baux = new BauxLocation(db, listings, fees, choix, files, acces, journal, { now, newId: uuid });
  const signatures = new SignaturesBail(db, listings, baux, choix, acces, journal, { now, newId: uuid });
  const ai = { format: async () => Promise.reject(new Error('indisponible')) };
  const edl = new EtatsDesLieux(db, listings, baux, choix, files, acces, ai, journal, { now, newId: uuid });
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 1 });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  await store.addIdentifier({ networkId: network.id, personId: owner.id, kind: 'email', value: 'bailleur.invente@example.test' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000', city: 'Villeneuve-Essai', rooms: 2 });
  // AU014 : la location se fait sous un mandat de location signé et inscrit.
  await signRentalMandate(db, { networkId: network.id, agentId: alex.id, personId: owner.id, propertyId: home.id });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  let tenantId = '';
  /** Le logement louable, choisi, avec son bail d'essai ; complet sauf si `complete` est faux. */
  const leased = async (complete = true) => {
    expect((await baux.createTemplate(dir, 'bail_vide', BODY)).ok).toBe(true);
    const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
    const id = c.ok ? c.value.listingId : '';
    expect((await listings.recordFacts(agent, id, FACTS)).ok).toBe(true);
    for (const kind of ['dpe', 'erp', 'surface_habitable']) expect((await listings.addAnnex(agent, id, { kind, ref: put(`location/${id}`), diagnosedOn: '2027-07-01' })).ok).toBe(true);
    await listings.check(agent, id);
    await fees.setCommune(agent, id, '21999');
    expect((await fees.record(agent, id, FEES)).ok).toBe(true);
    const ids: string[] = [];
    for (const i of [1, 2]) {
      const pid = (await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: i === 1 ? 'Camille' : 'Dominique', lastName: 'Inventé' })).id;
      await store.addIdentifier({ networkId: network.id, personId: pid, kind: 'email', value: `candidat.${i}.invente@example.test` });
      const a = await apps.apply(agent, id, { personId: pid });
      const aid = a.ok ? a.value.applicationId : '';
      for (const sort of ['quittances_loyer', 'contrat_travail', 'bulletins_salaire']) await apps.addPiece(agent, aid, { holder: 'candidat', sort, ref: put(`location/${id}/candidatures/${aid}`), sha256: SHA });
      ids.push(aid);
      if (i === 2) tenantId = pid;
    }
    const p = await choix.present(agent, id);
    const r = await choix.recordChoice(agent, id, { presentationId: p.ok ? p.value.presentationId : '', applicationId: ids[1]!, decidedAt: new Date(clock).toISOString(), channel: 'ecrit', proofRef: put(`location/${id}/choix`) });
    expect(r.ok).toBe(true);
    const l = await baux.generate(agent, id, complete ? { ...INPUT, noticeRef: put(`location/${id}/bail`) } : INPUT);
    if (!l.ok) throw new Error(l.code);
    expect(l.value.status).toBe(complete ? 'complet' : 'incomplet');
    return { id, leaseId: l.value.leaseId, sha: l.value.contentSha256 };
  };
  /** Les codes de signature du bail rangés dans la boîte d'essai, dans l'ordre. */
  const codes = async (): Promise<string[]> =>
    (await enClair(db.all<{ id: string; body: string }>(`SELECT m.id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.body LIKE '%code de signature du bail%' ORDER BY m.occurred_at, m.created_at`))).map(
      (r) => /(\d{6})/.exec(r.body)![1]!,
    );
  const lastCode = async () => (await codes()).at(-1)!;
  /** Les exemplaires remis, par destinataire. */
  const copies = async () =>
    db.all<{ person_id: string; body: string }>(`SELECT m.person_id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.body LIKE '%bail signé en ligne%' ORDER BY m.person_id`);
  /** Une partie ouvre et signe. */
  const signParty = async (listingId: string, party: 'bailleur' | 'locataire', drawing?: string) => {
    const s = await signatures.start(agent, listingId, { party, ...CONSENT });
    if (!s.ok) throw new Error(s.code);
    // X17b · en essai, le code rendu à l'écran est celui de la boîte d'essai.
    expect(s.value).toMatchObject({ mode: 'essai', trialCode: await lastCode() });
    return signatures.sign(agent, s.value.sessionId, { code: await lastCode(), drawing });
  };
  return { raw, db, journal, store, listings, fees, baux, edl, signatures, annuaire, relations, apps, choix, network, agent, other, dir, owner, leased, codes, lastCode, copies, signParty, tenant: () => tenantId, put, at: (ms: number) => (clock = ms) };
}

describeWithSqlite('W12 · signature en ligne du bail, en mode essai', () => {
  it('[R108] chaque partie signe l’empreinte du bail en vigueur ; un seul exemplaire, le même pour les deux, par le contrôle central', async () => {
    const t = await setup();
    const { id, leaseId, sha } = await t.leased();
    const b = await t.signParty(id, 'bailleur', 'M10 10 L20 20');
    expect(b).toMatchObject({ ok: true, value: { leaseId, party: 'bailleur', contentSha256: sha, method: 'code_et_trace', mode: 'essai', realSignature: false, bothSigned: false } });
    expect(await t.signatures.status(t.agent.networkId, leaseId)).toMatchObject({ bailleur: expect.any(String), locataire: null, signedAt: null, copySha256: null });
    expect(await t.copies()).toHaveLength(0);
    const l = await t.signParty(id, 'locataire');
    expect(l).toMatchObject({ ok: true, value: { party: 'locataire', contentSha256: sha, method: 'code', bothSigned: true } });
    const status = (await t.signatures.status(t.agent.networkId, leaseId))!;
    expect(status.signedAt).toBe(status.locataire);
    expect(status.copiesSent).toEqual(['bailleur', 'locataire']);
    // Un seul exemplaire : le bail suivi des deux preuves ; chaque partie reçoit la même référence et la même empreinte.
    const rows = await t.db.all<{ content: string; content_sha256: string }>('SELECT content, content_sha256 FROM rental_lease_copies');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content.startsWith((await t.db.first<{ content: string }>('SELECT content FROM rental_leases WHERE id = ?', [leaseId]))!.content)).toBe(true);
    expect(rows[0]!.content).toContain('du bailleur');
    expect(rows[0]!.content).toContain('du locataire');
    const sent = await t.copies();
    expect(sent.map((m) => m.person_id).sort()).toEqual([t.owner.id, t.tenant()].sort());
    for (const m of sent) expect(m.body).toContain(`empreinte ${rows[0]!.content_sha256}`);
    expect(await t.db.all('SELECT copy_sha256 FROM rental_lease_copy_deliveries')).toEqual([{ copy_sha256: rows[0]!.content_sha256 }, { copy_sha256: rows[0]!.content_sha256 }]);
    expect(await t.signatures.copy(t.agent, id, leaseId)).toEqual({ ok: true, value: { content: rows[0]!.content, contentSha256: rows[0]!.content_sha256 } });
    // Redemander l'envoi ne double rien.
    expect(await t.signatures.sendCopies(t.agent, id)).toEqual({ ok: true, value: { copySha256: rows[0]!.content_sha256, sent: ['bailleur', 'locataire'] } });
    expect(await t.copies()).toHaveLength(2);
    // Ni code ni tracé ne sont gardés ; le journal n'a ni code ni nom.
    const all = JSON.stringify(await t.db.all('SELECT * FROM rental_lease_signatures'));
    for (const c of await t.codes()) expect(all).not.toContain(c);
    expect(all).not.toContain('M10 10');
    const journal = JSON.stringify(await t.journal.all());
    for (const c of await t.codes()) expect(journal).not.toContain(c);
    expect(journal).not.toMatch(/Inventé|Camille|Dominique|example\.test/);
  });

  it('[R108] tant que H08 et H24 ne sont pas faits, la signature ne rend jamais un bail signé réel ; la remise des clés l’attend', async () => {
    const t = await setup();
    const { id, leaseId } = await t.leased();
    await t.signParty(id, 'bailleur');
    await t.signParty(id, 'locataire');
    expect(REAL_LEASE_SIGNATURE).toBe(false);
    expect(await t.signatures.signedAt(t.agent.networkId, leaseId)).toBeNull();
    const real = new RemisesDesCles(t.db, t.listings, t.fees, t.baux, t.edl, t.signatures, t.relations, t.annuaire, t.journal, { now: () => new Date(clock), newId: uuid });
    expect(await real.handOver(t.agent, id, { handedOn: '2027-07-12' })).toEqual({ ok: false, rule: 'R107', code: 'lease_not_signed' });
    expect(await real.feesDue(t.agent, id)).toMatchObject({ ok: true, value: { due: false } });
    // Le parcours d'essai lit la signature d'essai, nommée comme telle : la remise passe à l'étape suivante.
    const trial = new RemisesDesCles(t.db, t.listings, t.fees, t.baux, t.edl, t.signatures.trialState(), t.relations, t.annuaire, t.journal, { now: () => new Date(clock), newId: uuid });
    expect(await t.signatures.trialState().signedAt(t.agent.networkId, leaseId)).toBe((await t.signatures.status(t.agent.networkId, leaseId))!.signedAt);
    expect(await trial.handOver(t.agent, id, { handedOn: '2027-07-12' })).toEqual({ ok: false, rule: 'R106', code: 'inventory_not_closed' });
    // Une seule partie signée : pas de bail signé, même en essai.
    const t2 = await setup();
    const second = await t2.leased();
    await t2.signParty(second.id, 'bailleur');
    expect(await t2.signatures.trialState().signedAt(t2.agent.networkId, second.leaseId)).toBeNull();
  });

  it('[R108] un bail remplacé après une signature demande de nouvelles signatures', async () => {
    const t = await setup();
    const { id, leaseId } = await t.leased();
    expect(await t.signParty(id, 'bailleur')).toMatchObject({ ok: true });
    // Le locataire ouvre sa signature, puis le bail est refait (nouvelle version) avant qu'il signe.
    const s = await t.signatures.start(t.agent, id, { party: 'locataire', ...CONSENT });
    if (!s.ok) throw new Error(s.code);
    const v2 = await t.baux.generate(t.agent, id, { ...INPUT, noticeRef: t.put(`location/${id}/bail`) });
    if (!v2.ok) throw new Error(v2.code);
    expect(v2.value.leaseId).not.toBe(leaseId);
    expect(await t.signatures.sign(t.agent, s.value.sessionId, { code: await t.lastCode() })).toEqual({ ok: false, rule: 'R108', code: 'lease_changed' });
    // Le nouveau bail n'a aucune signature : le bailleur signe de nouveau.
    expect(await t.signatures.status(t.agent.networkId, v2.value.leaseId)).toMatchObject({ bailleur: null, locataire: null, signedAt: null });
    const b2 = await t.signParty(id, 'bailleur');
    expect(b2).toMatchObject({ ok: true, value: { leaseId: v2.value.leaseId, contentSha256: v2.value.contentSha256, bothSigned: false } });
    expect(await t.signParty(id, 'locataire')).toMatchObject({ ok: true, value: { leaseId: v2.value.leaseId, bothSigned: true } });
    // L'ancien bail reste à une seule signature, sans exemplaire.
    expect(await t.signatures.status(t.agent.networkId, leaseId)).toMatchObject({ locataire: null, signedAt: null, copySha256: null });
    expect(await t.signatures.trialState().signedAt(t.agent.networkId, leaseId)).toBeNull();
  });

  it('[R108] [R101] [R105] seul le bail en vigueur et complet se signe', async () => {
    const t = await setup();
    const inc = await t.leased(false);
    expect(await t.signatures.start(t.agent, inc.id, { party: 'bailleur', ...CONSENT })).toEqual({ ok: false, rule: 'R101', code: 'lease_incomplete' });
    const t2 = await setup();
    const { id } = await t2.leased();
    // Le bail ne vaut plus quand les faits changent : il n'y a plus de bail en vigueur à signer.
    expect((await t2.listings.recordFacts(t2.agent, id, { ...FACTS, rentCents: 64_000 })).ok).toBe(true);
    expect(await t2.signatures.start(t2.agent, id, { party: 'locataire', ...CONSENT })).toEqual({ ok: false, rule: 'R108', code: 'no_current_lease' });
    expect(await t2.signatures.sendCopies(t2.agent, id)).toEqual({ ok: false, rule: 'R108', code: 'no_current_lease' });
    expect(await t2.signatures.start(t2.agent, id, { party: 'caution', ...CONSENT })).toEqual({ ok: false, rule: null, code: 'bad_party' });
    expect(await t2.signatures.start(t2.agent, id, { party: 'bailleur', consentProof: ' ' })).toEqual({ ok: false, rule: null, code: 'bad_consent' });
  });

  it('un code ne sert qu’une fois, expire, et cinq essais faux bloquent la session ; une partie ne signe qu’une fois', async () => {
    const t = await setup();
    const { id } = await t.leased();
    const s = await t.signatures.start(t.agent, id, { party: 'bailleur', ...CONSENT });
    if (!s.ok) throw new Error(s.code);
    t.at(clock + 10 * 60_000 + 1);
    expect(await t.signatures.sign(t.agent, s.value.sessionId, { code: await t.lastCode() })).toEqual({ ok: false, rule: null, code: 'expired' });
    const s2 = await t.signatures.start(t.agent, id, { party: 'bailleur', ...CONSENT });
    if (!s2.ok) throw new Error(s2.code);
    const good = await t.lastCode();
    const wrong = good === '000000' ? '000001' : '000000';
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) expect(await t.signatures.sign(t.agent, s2.value.sessionId, { code: wrong })).toEqual({ ok: false, rule: null, code: 'wrong_code' });
    expect(await t.signatures.sign(t.agent, s2.value.sessionId, { code: wrong })).toEqual({ ok: false, rule: null, code: 'blocked' });
    expect(await t.signatures.sign(t.agent, s2.value.sessionId, { code: good })).toEqual({ ok: false, rule: null, code: 'blocked' });
    // Deux sessions ouvertes pour la même partie : une seule signature compte.
    const a = await t.signatures.start(t.agent, id, { party: 'bailleur', ...CONSENT });
    if (!a.ok) throw new Error(a.code);
    const codeA = await t.lastCode();
    const b = await t.signatures.start(t.agent, id, { party: 'bailleur', ...CONSENT });
    if (!b.ok) throw new Error(b.code);
    const codeB = await t.lastCode();
    expect(await t.signatures.sign(t.agent, a.value.sessionId, { code: codeA })).toMatchObject({ ok: true });
    expect(await t.signatures.sign(t.agent, a.value.sessionId, { code: codeA })).toEqual({ ok: false, rule: null, code: 'already_signed' });
    expect(await t.signatures.sign(t.agent, b.value.sessionId, { code: codeB })).toEqual({ ok: false, rule: null, code: 'already_signed' });
    expect(await t.signatures.start(t.agent, id, { party: 'bailleur', ...CONSENT })).toEqual({ ok: false, rule: null, code: 'already_signed' });
    expect(await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM rental_lease_signatures WHERE status = 'signee'")).toEqual({ n: 1 });
    // Une signature rangée ne change plus, et rien ne s'efface.
    expect(() => t.raw.exec("UPDATE rental_lease_signatures SET signed_at = '2000-01-01' WHERE status = 'signee'")).toThrow(/ne change plus/);
    expect(() => t.raw.exec('DELETE FROM rental_lease_signatures')).toThrow(/rien ne s'efface/);
  });

  it('[R16] un autre agent ne présente ni n’ouvre de signature ; le refus est au journal', async () => {
    const t = await setup();
    const { id, leaseId } = await t.leased();
    expect(await t.signatures.start(t.other, id, { party: 'bailleur', ...CONSENT })).toMatchObject({ ok: false, rule: 'R16' });
    const s = await t.signatures.start(t.agent, id, { party: 'bailleur', ...CONSENT });
    if (!s.ok) throw new Error(s.code);
    expect(await t.signatures.sign(t.other, s.value.sessionId, { code: await t.lastCode() })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.signatures.sign({ ...t.agent, networkId: 'autre-reseau' }, s.value.sessionId, { code: await t.lastCode() })).toEqual({ ok: false, rule: null, code: 'unknown_session' });
    expect(await t.signatures.copy(t.other, id, leaseId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.signatures.copy({ role: 'compliance', userId: 'c-1', networkId: t.agent.networkId }, id, leaseId)).toMatchObject({ ok: false, rule: 'R16' });
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused.length).toBeGreaterThanOrEqual(2);
    // La session est restée ouverte : l'agent du bien signe encore.
    expect(await t.signatures.sign(t.agent, s.value.sessionId, { code: await t.lastCode() })).toMatchObject({ ok: true });
  });

  it('[R01] un exemplaire refusé hors des heures d’envoi est remis le lendemain, le même', async () => {
    const t = await setup();
    const { id, leaseId } = await t.leased();
    await t.signParty(id, 'bailleur');
    // 19 h 59 à Paris : le code part ; la signature tombe après 20 h, l'exemplaire attend.
    t.at(Date.parse('2027-07-12T17:59:00.000Z'));
    const s = await t.signatures.start(t.agent, id, { party: 'locataire', ...CONSENT });
    if (!s.ok) throw new Error(s.code);
    t.at(Date.parse('2027-07-12T18:05:00.000Z'));
    expect(await t.signatures.sign(t.agent, s.value.sessionId, { code: await t.lastCode() })).toMatchObject({ ok: true, value: { bothSigned: true } });
    const before = (await t.signatures.status(t.agent.networkId, leaseId))!;
    expect(before.copiesSent).toEqual([]);
    expect(before.copySha256).not.toBeNull();
    t.at(Date.parse('2027-07-13T07:00:00.000Z'));
    expect(await t.signatures.sendCopies(t.agent, id)).toEqual({ ok: true, value: { copySha256: before.copySha256, sent: ['bailleur', 'locataire'] } });
    expect(await t.copies()).toHaveLength(2);
  });

  it('[R108] un bail signé par les deux parties est remis même s’il n’est plus en vigueur à la reprise', async () => {
    const t = await setup();
    const { id, leaseId } = await t.leased();
    await t.signParty(id, 'bailleur');
    t.at(Date.parse('2027-07-12T17:59:00.000Z'));
    const s = await t.signatures.start(t.agent, id, { party: 'locataire', ...CONSENT });
    if (!s.ok) throw new Error(s.code);
    t.at(Date.parse('2027-07-12T18:05:00.000Z'));
    expect(await t.signatures.sign(t.agent, s.value.sessionId, { code: await t.lastCode() })).toMatchObject({ ok: true, value: { bothSigned: true } });
    t.at(Date.parse('2027-07-13T07:00:00.000Z'));
    // Les faits changent avant la reprise : le bail n'est plus en vigueur, il est quand même remis.
    expect((await t.listings.recordFacts(t.agent, id, { ...FACTS, rentCents: 64_000 })).ok).toBe(true);
    expect(await t.signatures.sendCopies(t.agent, id)).toMatchObject({ ok: true, value: { sent: ['bailleur', 'locataire'] } });
    expect((await t.signatures.status(t.agent.networkId, leaseId))!.copiesSent).toEqual(['bailleur', 'locataire']);
    expect(await t.copies()).toHaveLength(2);
  });

  it('[R16] l’exemplaire n’est rendu qu’à qui voit les fiches des deux parties en entier', async () => {
    const t = await setup();
    const { id, leaseId } = await t.leased();
    await t.signParty(id, 'bailleur');
    await t.signParty(id, 'locataire');
    expect((await t.signatures.copy(t.agent, id, leaseId)).ok).toBe(true);
    // Le locataire passe à un autre agent ; le bien reste à Alex : l'exemplaire ne lui est plus rendu.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.other.userId, t.tenant()]);
    expect(await t.signatures.copy(t.agent, id, leaseId)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R03] un accord redonné est rangé quand la ligne ouverte est plus ancienne qu’un retrait (AC07), et un accord qui compte n’est pas doublé', async () => {
    const t = await setup();
    const { id } = await t.leased();
    // Un retrait sur la fiche, un accord plus ancien resté ouvert sur son doublon, puis la fusion.
    const twin = await t.store.createPerson({ networkId: t.owner.network_id, firstName: 'Doublon' });
    await t.store.addConsent({ networkId: t.owner.network_id, personId: twin.id, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-02T00:00:00.000Z') });
    const old = await t.store.addConsent({ networkId: t.owner.network_id, personId: t.owner.id, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-01T00:00:00.000Z') });
    await t.store.withdrawConsent(old.id, new Date('2020-02-01T00:00:00.000Z'));
    const unique = new FicheUnique(t.db, new FicheClient(t.db));
    await unique.merge({ survivorId: t.owner.id, mergedId: twin.id, reason: 'identifiant commun' });
    expect(await unique.hasConsentInForce(t.owner.id, ONLINE_SIGNATURE_PURPOSE, 'email')).toBe(false);
    const lines = () => t.db.all<{ id: string }>('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [t.owner.id, ONLINE_SIGNATURE_PURPOSE]);
    const before = (await lines()).length;
    expect((await t.signatures.start(t.agent, id, { party: 'bailleur', ...CONSENT })).ok).toBe(true);
    expect(await lines()).toHaveLength(before + 1);
    await t.signatures.start(t.agent, id, { party: 'bailleur', ...CONSENT });
    expect(await lines()).toHaveLength(before + 1);
    expect(await unique.hasConsentInForce(t.owner.id, ONLINE_SIGNATURE_PURPOSE, 'email')).toBe(true);
  });
});

describeWithSqlite('AU097 · un bail commun de colocation', () => {
  it('deux colocataires restent deux personnes : chacun ses pièces, sa signature et son exemplaire du même bail', async () => {
    const t = await setup();
    const { id } = await t.leased();
    const chosen = (await t.choix.chosen(t.network.id, id))!;
    // Une colocataire de plus sur le dossier choisi : une personne de la fiche, avec son mail.
    const elise = await t.store.createPerson({ networkId: t.network.id, agentId: t.agent.userId, firstName: 'Élise', lastName: 'Inventée' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: elise.id, kind: 'email', value: 'elise.inventee@example.test' });
    expect(await t.apps.setCotenant(t.other, chosen.applicationId, { personId: elise.id, action: 'ajout' })).toMatchObject({ ok: false });
    expect(await t.apps.setCotenant(t.agent, chosen.applicationId, { personId: t.owner.id, action: 'ajout' })).toMatchObject({ ok: false, code: 'unknown_person' });
    expect(await t.apps.setCotenant(t.agent, chosen.applicationId, { personId: elise.id, action: 'ajout' })).toEqual({ ok: true, value: { cotenants: [elise.id] } });
    expect(await t.apps.addGuarantor(t.agent, chosen.applicationId, { kind: 'personne', personId: elise.id })).toMatchObject({ ok: false, code: 'already_cotenant' });
    // Le bail fait avant ne nomme pas Élise : il ne se signe plus.
    expect(await t.baux.current(t.network.id, id)).toBeNull();
    // Ses propres pièces, à son nom : le dossier n'est complet qu'avec elles, et sans elles aucun bail ne se fait.
    const holder = `colocataire:${elise.id}`;
    expect(await t.baux.generate(t.agent, id, { ...INPUT, noticeRef: t.put(`location/${id}/bail`) })).toMatchObject({ ok: false, code: 'dossier_incomplet' });
    const before = await t.apps.read(t.agent, chosen.applicationId);
    expect(before.ok && before.value.cotenants).toEqual([elise.id]);
    expect(before.ok && before.value.missing.filter((m) => m.holder === holder).map((m) => m.what)).toEqual(['domicile', 'activite', 'ressources']);
    expect(await t.apps.addPiece(t.agent, chosen.applicationId, { holder, sort: 'derniere_quittance', ref: t.put(`location/${id}/candidatures/${chosen.applicationId}`), sha256: SHA })).toMatchObject({ ok: false, code: 'not_for_holder' });
    for (const sort of ['attestation_hebergement', 'certificat_scolarite', 'avis_bourse']) {
      expect((await t.apps.addPiece(t.agent, chosen.applicationId, { holder, sort, ref: t.put(`location/${id}/candidatures/${chosen.applicationId}`), sha256: SHA })).ok).toBe(true);
    }
    const after = await t.apps.read(t.agent, chosen.applicationId);
    expect(after.ok && after.value.missing.filter((m) => m.holder === holder)).toEqual([]);
    // Un seul bail, qui nomme les deux locataires.
    const lease = await t.baux.generate(t.agent, id, { ...INPUT, noticeRef: t.put(`location/${id}/bail`) });
    if (!lease.ok) throw new Error(lease.code);
    expect(lease.value.content).toContain('Dominique Inventé et Élise Inventée, colocataires');
    // Le bailleur et le locataire signent : le bail n'est pas encore signé sans Élise.
    expect((await t.signParty(id, 'bailleur')).ok).toBe(true);
    expect(await t.signParty(id, 'locataire')).toMatchObject({ ok: true, value: { bothSigned: false } });
    expect((await t.signatures.status(t.network.id, lease.value.leaseId))!.signedAt).toBeNull();
    expect(await t.copies()).toEqual([]);
    // Seule une colocataire nommée au bail signe en colocataire ; Élise signe en son nom.
    expect(await t.signatures.start(t.agent, id, { party: 'colocataire', personId: t.owner.id, ...CONSENT })).toMatchObject({ ok: false, code: 'not_cotenant' });
    const s = await t.signatures.start(t.agent, id, { party: 'colocataire', personId: elise.id, ...CONSENT });
    if (!s.ok) throw new Error(s.code);
    expect(await t.signatures.sign(t.agent, s.value.sessionId, { code: await t.lastCode() })).toMatchObject({ ok: true, value: { party: 'colocataire', bothSigned: true } });
    expect(await t.signatures.start(t.agent, id, { party: 'colocataire', personId: elise.id, ...CONSENT })).toMatchObject({ ok: false, code: 'already_signed' });
    const status = (await t.signatures.status(t.network.id, lease.value.leaseId))!;
    expect(status.colocataires).toEqual([{ personId: elise.id, signedAt: expect.any(String) }]);
    expect(status.signedAt).not.toBeNull();
    // Un seul exemplaire, avec les trois preuves ; chacun en reçoit l'avis, Élise comprise.
    expect(status.cotenantCopiesSent).toEqual([elise.id]);
    // L'avis remis à Élise nomme sa session de signature : sa réponse d'accès le retrouve [R96].
    expect((await t.journal.all()).filter((e) => e.type === 'location.bail_exemplaire' && (e.data as { party?: string }).party === 'colocataire').map((e) => (e.data as { session?: string }).session)).toEqual([s.value.sessionId]);
    const sent = await t.copies();
    expect(sent.map((c) => c.person_id).sort()).toEqual([t.owner.id, t.tenant(), elise.id].sort());
    expect(new Set(sent.map((c) => /empreinte ([0-9a-f]{64})/.exec(c.body)![1])).size).toBe(1);
    const copy = await t.signatures.copy(t.agent, id, lease.value.leaseId);
    expect(copy.ok && (copy.value.content.match(/Signature en ligne d'essai/g) ?? []).length).toBe(3);
    // Élise retirée : le bail signé ne nomme plus les bons locataires, il en faut un nouveau.
    expect((await t.apps.setCotenant(t.agent, chosen.applicationId, { personId: elise.id, action: 'retrait' })).ok).toBe(true);
    expect(await t.baux.current(t.network.id, id)).toBeNull();
    // Revenue ensuite, Élise ne ranime pas l'ancien bail : la liste a changé depuis, il en faut un nouveau.
    expect((await t.apps.setCotenant(t.agent, chosen.applicationId, { personId: elise.id, action: 'ajout' })).ok).toBe(true);
    expect(await t.baux.current(t.network.id, id)).toBeNull();
    expect(await t.db.all('SELECT action FROM rental_cotenant_changes ORDER BY seq')).toEqual([{ action: 'ajout' }, { action: 'retrait' }, { action: 'ajout' }]);
  });
});
