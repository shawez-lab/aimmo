import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { BauxLocation, Candidatures, ChoixProprietaire, HonorairesLocation, MisesEnLocation, type RentalFacts } from '../src/location/index.ts';
import { Acces, FicheUnique } from '../src/index.ts';
import { EspaceProprietaire, SqlClientParties, SqlSourcesProprietaire, type ClientViewer } from '../src/espaces/index.ts';
import type { CommuneRanges } from '../src/mandats/suivi-valeur.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { signRentalMandate } from './mandat-location-jeu.ts';

// Réseau, agents, propriétaires, candidats, garants et logements inventés. Le 12 juillet 2027 est un lundi.
let clock = 0;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);
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

const RANGE: CommuneRanges = {
  forTown: async (postalCode, town, kind) => ({
    ok: true,
    value: { town, postalCode, kind, perM2: { low: 2_400, median: 2_700, high: 3_100 }, sales: 42, period: { from: '2026-07', to: '2027-06' }, data: { lastSale: '2027-06-28', source: 'Demandes de valeurs foncières (DVF)', recentMissing: false }, next: 'appointment' },
  }),
};

async function setup(options: { real?: boolean; ranges?: CommuneRanges | null } = {}) {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 60_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r) };
  const put = (prefix: string) => {
    const r = `${prefix}/${uuid()}.pdf`;
    refs.add(r);
    return r;
  };
  const verified = new Set<string>();
  const identity = { state: async (_n: string, personId: string) => ({ identityVerifiedOn: verified.has(personId) ? '2027-07-10' : null }) };
  const listings = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const fees = new HonorairesLocation(db, listings, journal, { now });
  const apps = new Candidatures(db, listings, identity, files, journal, { now, newId: uuid });
  const choix = new ChoixProprietaire(db, listings, apps, files, journal, { now, newId: uuid });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const baux = new BauxLocation(db, listings, fees, choix, files, acces, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000', city: 'Villeneuve-Essai', rooms: 2 });
  // AU014 : la location se fait sous un mandat de location signé et inscrit.
  await signRentalMandate(db, { networkId: network.id, agentId: alex.id, personId: owner.id, propertyId: home.id });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const parties = new SqlClientParties(db);
  const sources = new SqlSourcesProprietaire(db, identity, journal, { now, ranges: options.ranges === undefined ? RANGE : options.ranges, realLeaseSignature: options.real ?? false });
  const espace = new EspaceProprietaire(sources, journal, { now });
  const viewer = async (personId: string): Promise<ClientViewer> => ({ kind: 'client', networkId: network.id, personId, sessionId: `s-${personId}`, sides: await parties.sidesOf(network.id, personId) });

  /** Une mise en location louable, avec ses candidats : un complet garanti par une personne, un incomplet, un complet. */
  const listing = async (ownerId = owner.id) => {
    const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: ownerId });
    if (!c.ok) throw new Error(c.code);
    const id = c.value.listingId;
    expect((await listings.recordFacts(agent, id, FACTS)).ok).toBe(true);
    for (const kind of ['dpe', 'erp', 'surface_habitable']) expect((await listings.addAnnex(agent, id, { kind, ref: put(`location/${id}`), diagnosedOn: '2027-07-01' })).ok).toBe(true);
    await listings.check(agent, id);
    await fees.setCommune(agent, id, '21999');
    expect((await fees.record(agent, id, FEES)).ok).toBe(true);
    return id;
  };
  const candidate = async (listingId: string, firstName: string, complete: boolean) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, lastName: 'Exemplaire' });
    await store.addIdentifier({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    verified.add(p.id);
    const a = await apps.apply(agent, listingId, { personId: p.id });
    if (!a.ok) throw new Error(a.code);
    const sorts = complete ? ['quittances_loyer', 'contrat_travail', 'bulletins_salaire'] : ['quittances_loyer'];
    for (const sort of sorts) expect((await apps.addPiece(agent, a.value.applicationId, { holder: 'candidat', sort, ref: put(`location/${listingId}/candidatures/${a.value.applicationId}`), sha256: SHA })).ok).toBe(true);
    return { personId: p.id, applicationId: a.value.applicationId };
  };
  /** Le bail du candidat choisi ; réel si le modèle est validé. */
  const lease = async (listingId: string, chosen: string, validated: boolean) => {
    const tpl = await baux.createTemplate(dir, 'bail_vide', BODY);
    if (!tpl.ok) throw new Error(tpl.code);
    if (validated) expect((await baux.validateTemplate({ role: 'compliance', userId: 'conf-1', networkId: network.id }, tpl.value.id)).ok).toBe(true);
    const p = await choix.present(agent, listingId);
    if (!p.ok) throw new Error(p.code);
    expect((await choix.recordChoice(agent, listingId, { presentationId: p.value.presentationId, applicationId: chosen, decidedAt: new Date(clock).toISOString(), channel: 'ecrit', proofRef: put(`location/${listingId}/choix`) })).ok).toBe(true);
    const l = await baux.generate(agent, listingId, { ...INPUT, noticeRef: put(`location/${listingId}/bail`) });
    if (!l.ok) throw new Error(l.code);
    return l.value;
  };
  /** Les deux signatures du bail, rangées comme le fait W12, et sa copie. */
  const sign = async (listingId: string, leaseId: string, tenantId: string) => {
    for (const [party, personId] of [['bailleur', owner.id], ['locataire', tenantId]] as const) {
      const at = new Date((clock += 60_000)).toISOString();
      await db.run(
        `INSERT INTO rental_lease_signatures (id, network_id, listing_id, lease_id, party, person_id, content_sha256, code_hash, expires_at, attempts, status, created_by, created_at, signed_at, drawing_hash, proof)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'signee', 'agent:test', ?, ?, ?, '{}')`,
        [uuid(), network.id, listingId, leaseId, party, personId, SHA, SHA, at, at, at, SHA],
      );
    }
    await db.run('INSERT INTO rental_lease_copies (lease_id, network_id, listing_id, content, content_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)', [leaseId, network.id, listingId, 'copie du bail', SHA, new Date((clock += 60_000)).toISOString()]);
  };
  return { db, store, network, alex, owner, home, agent, apps, parties, sources, espace, viewer, listing, candidate, lease, sign, now };
}

describeWithSqlite('EC09 · lecteurs SQL de l’espace du propriétaire', () => {
  it('[R161] le bailleur d’une mise en location est bailleur ; un candidat est candidat locataire, un inconnu rien', async () => {
    const t = await setup();
    const id = await t.listing();
    const c = await t.candidate(id, 'Camille', true);
    expect(await t.parties.sidesOf(t.network.id, t.owner.id)).toEqual(['bailleur']);
    expect(await t.parties.sidesOf(t.network.id, c.personId)).toEqual(['candidat_locataire']);
    expect(await t.parties.sidesOf(t.network.id, 'p-inconnue')).toEqual([]);
    expect(await t.parties.sidesOf('autre-reseau', t.owner.id)).toEqual([]);
    expect(await t.sources.ownerPropertiesOf(t.network.id, t.owner.id)).toEqual([{ propertyId: t.home.id, reference: 'L-1', city: 'Villeneuve-Essai' }]);
  });

  it('[R162] candidatures complètes seulement, dans l’ordre d’arrivée, rattachées pour la retenue, sans nom dans la vue', async () => {
    const t = await setup();
    const id = await t.listing();
    const a = await t.candidate(id, 'Camille', true);
    await t.candidate(id, 'Dominique', false);
    const c = await t.candidate(id, 'Eden', true);
    const raw = await t.sources.applicationsOf(t.network.id, id);
    expect(raw.map((x) => x.complete)).toEqual([true, false, true]);
    expect(raw[0]!.persons.map((p) => p.personId)).toEqual([a.personId]);
    expect(raw[0]!.persons[0]!.emails).toEqual(['camille@example.test']);
    expect(raw[0]!.pieces.map((p) => p.kind)).toEqual(['quittances_loyer', 'contrat_travail', 'bulletins_salaire']);
    const v = await t.espace.bien(await t.viewer(t.owner.id), t.home.id);
    if (!v.ok) throw new Error(v.code);
    const rental = v.value.rentals[0]!;
    expect(rental.waiting).toBe(1);
    expect(rental.applications.map((x) => x.rank)).toEqual([1, 2]);
    expect(rental.applications.map((x) => x.receivedAt.value)).toEqual([raw[0]!.receivedAt, raw[2]!.receivedAt]);
    expect(rental.state.value).toBe('candidatures en cours');
    const text = JSON.stringify(v.value);
    for (const leak of ['Camille', 'Eden', 'Dominique', 'Exemplaire', '@example.test', a.applicationId, c.applicationId]) expect(text).not.toContain(leak);
  });

  it('[R161] un garant personne est rattaché pour la retenue, compté, et ses pièces ne sont jamais présentées', async () => {
    const t = await setup();
    const id = await t.listing();
    const a = await t.candidate(id, 'Camille', true);
    const g = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Gaston', lastName: 'Garant' });
    await t.db.run("INSERT INTO rental_guarantors (id, application_id, kind, person_id, added_by, added_at) VALUES ('g-1', ?, 'personne', ?, 'agent:test', '2027-07-12T09:00:00.000Z')", [a.applicationId, g.id]);
    const raw = await t.sources.applicationsOf(t.network.id, id);
    expect(raw[0]!.guarantors).toBe(1);
    expect(raw[0]!.persons.map((p) => p.personId)).toEqual([a.personId, g.id]);
  });

  it('[R161] un autre propriétaire qui met le bien en location après lui le lui retire ; aucun ne voit la location de l’autre', async () => {
    const t = await setup();
    const first = await t.listing();
    await t.candidate(first, 'Camille', true);
    const next = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Nouveau', lastName: 'Bailleur' });
    const second = await t.listing(next.id);
    await t.candidate(second, 'Eden', true);
    expect(await t.parties.sidesOf(t.network.id, t.owner.id)).toEqual([]);
    expect(await t.sources.ownerPropertiesOf(t.network.id, t.owner.id)).toEqual([]);
    expect(await t.sources.rentalsOf(t.network.id, t.home.id, t.owner.id)).toEqual([]);
    expect((await t.sources.rentalsOf(t.network.id, t.home.id, next.id)).map((r) => r.rentalId)).toEqual([second]);
    const v = await t.espace.bien(await t.viewer(t.owner.id), t.home.id);
    expect(v).toMatchObject({ ok: false, rule: 'R161' });
  });

  it('[R161] une fiche fusionnée compte pour la fiche gardée', async () => {
    const t = await setup();
    await t.listing();
    const kept = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Bailleur', lastName: 'Gardé' });
    await new FicheUnique(t.db, t.store, { now: t.now }).merge({ survivorId: kept.id, mergedId: t.owner.id, reason: 'identifiant commun' });
    expect(await t.parties.sidesOf(t.network.id, kept.id)).toEqual(['bailleur']);
    expect((await t.sources.rentalsOf(t.network.id, t.home.id, kept.id)).length).toBe(1);
  });

  it('[R163] un bail d’essai n’est jamais montré ; un bail réel sans signature réelle n’a ni date, ni loyer, ni charges', async () => {
    const t = await setup();
    const id = await t.listing();
    const a = await t.candidate(id, 'Camille', true);
    const l = await t.lease(id, a.applicationId, false);
    expect(l.mode).toBe('essai');
    expect(await t.sources.leaseOf(t.network.id, id)).toBeNull();

    const r = await setup({ real: false });
    const id2 = await r.listing();
    const b = await r.candidate(id2, 'Camille', true);
    const l2 = await r.lease(id2, b.applicationId, true);
    expect(l2).toMatchObject({ mode: 'reel', status: 'complet' });
    await r.sign(id2, l2.leaseId, b.personId);
    expect(await r.sources.leaseOf(r.network.id, id2)).toEqual({ signedAt: null, startsOn: '2027-09-01', rentEur: 650, chargesEur: 50 });
    const v = await r.espace.bien(await r.viewer(r.owner.id), r.home.id);
    if (!v.ok) throw new Error(v.code);
    expect(v.value.rentals[0]!.lease.rent.value).toBeNull();
    expect(v.value.rentals[0]!.state.value).toBe('candidat choisi');
    expect(v.value.documents.map((d) => d.title)).not.toContain('Bail signé');
  });

  it('[R163] un bail réel signé par les deux parties montre sa date, son loyer et ses charges, et sa copie est rangée', async () => {
    const t = await setup({ real: true });
    const id = await t.listing();
    const a = await t.candidate(id, 'Camille', true);
    const l = await t.lease(id, a.applicationId, true);
    expect((await t.sources.leaseOf(t.network.id, id))?.signedAt).toBeNull();
    await t.sign(id, l.leaseId, a.personId);
    const lease = await t.sources.leaseOf(t.network.id, id);
    expect(lease).toMatchObject({ startsOn: '2027-09-01', rentEur: 650, chargesEur: 50 });
    expect(lease?.signedAt).toMatch(/^2027-07-12T/);
    const v = await t.espace.bien(await t.viewer(t.owner.id), t.home.id);
    if (!v.ok) throw new Error(v.code);
    expect(v.value.rentals[0]!.state.value).toBe('bail signé');
    expect(v.value.rentals[0]!.lease.rent).toMatchObject({ value: 650, source: 'bail signé' });
    expect(v.value.documents.map((d) => d.title)).toContain('Bail signé');
    expect(JSON.stringify(v.value)).not.toContain('Camille');
  });

  it('[R31] [R03] la valeur de la commune n’est montrée qu’avec un suivi inscrit et son accord en cours, jamais sans source', async () => {
    const t = await setup();
    await t.listing();
    expect(await t.sources.valueOf(t.network.id, t.owner.id, t.home.id)).toBeNull();
    await t.db.run("INSERT INTO value_tracking (id, network_id, agent_id, person_id, postal_code, town, kind, channel, created_by, created_at) VALUES ('vt-1', ?, ?, ?, '21000', 'Villeneuve-Essai', 'apartment', 'email', 'agent:test', '2027-07-01T08:00:00.000Z')", [t.network.id, t.alex.id, t.owner.id]);
    expect(await t.sources.valueOf(t.network.id, t.owner.id, t.home.id)).toBeNull();
    const consent = await t.store.addConsent({ networkId: t.network.id, agentId: t.alex.id, personId: t.owner.id, purpose: 'value_tracking', channel: 'email', proof: 'formulaire de test', givenAt: new Date('2027-07-01T08:00:00.000Z') });
    expect(await t.sources.valueOf(t.network.id, t.owner.id, t.home.id)).toEqual({ tracking: true, city: 'Villeneuve-Essai', lowEur: 2_400, highEur: 3_100, computedAt: '2027-06-28', sources: ['Demandes de valeurs foncières (DVF)'] });
    const v = await t.espace.bien(await t.viewer(t.owner.id), t.home.id);
    if (!v.ok) throw new Error(v.code);
    expect(v.value.value?.range).toEqual({ value: { lowEur: 2_400, highEur: 3_100 }, source: 'suivi de valeur de la commune', at: '2027-06-28' });
    // D'un autre bien que le sien : rien.
    expect(await t.sources.valueOf(t.network.id, t.owner.id, 'autre-bien')).toBeNull();
    await t.store.withdrawConsent(consent.id, new Date('2027-07-12T07:00:00.000Z'));
    expect(await t.sources.valueOf(t.network.id, t.owner.id, t.home.id)).toBeNull();
    // Un second logement du propriétaire dans la même commune : le suivi ne dit pas lequel, rien n'est montré.
    const other = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'L-2', kind: 'home', postalCode: '21000', city: 'Villeneuve-Essai', rooms: 3 });
    await t.db.run("INSERT INTO rental_listings (id, network_id, property_id, owner_person_id, created_by, created_at) VALUES ('rl-2', ?, ?, ?, 'agent:test', '2027-07-12T09:30:00.000Z')", [t.network.id, other.id, t.owner.id]);
    const again = await t.store.addConsent({ networkId: t.network.id, agentId: t.alex.id, personId: t.owner.id, purpose: 'value_tracking', channel: 'email', proof: 'formulaire de test', givenAt: new Date('2027-07-12T07:30:00.000Z') });
    expect(again.id).toBeTruthy();
    expect(await t.sources.valueOf(t.network.id, t.owner.id, t.home.id)).toBeNull();
    expect(await t.sources.valueOf(t.network.id, t.owner.id, other.id)).toBeNull();
    const none = await setup({ ranges: null });
    expect(await none.sources.valueOf(none.network.id, none.owner.id, none.home.id)).toBeNull();
  });

  it('[R31] un suivi d’une autre commune que celle du bien ne montre rien', async () => {
    const t = await setup();
    await t.listing();
    await t.db.run("INSERT INTO value_tracking (id, network_id, agent_id, person_id, postal_code, town, kind, channel, created_by, created_at) VALUES ('vt-1', ?, ?, ?, '21999', 'Ailleurs-Essai', 'house', 'email', 'agent:test', '2027-07-01T08:00:00.000Z')", [t.network.id, t.alex.id, t.owner.id]);
    await t.store.addConsent({ networkId: t.network.id, agentId: t.alex.id, personId: t.owner.id, purpose: 'value_tracking', channel: 'email', proof: 'formulaire de test', givenAt: new Date('2027-07-01T08:00:00.000Z') });
    expect(await t.sources.valueOf(t.network.id, t.owner.id, t.home.id)).toBeNull();
  });
});

describeWithSqlite('EC09 · l’acte fait passer le bien du vendeur à l’acquéreur', () => {
  it('[R161] après l’acte, l’acquéreur est propriétaire ; le vendeur garde sa vue de vendeur mais n’est plus propriétaire du bien', async () => {
    const t = await setupDossier();
    const parties = new SqlClientParties(t.db);
    const identity = { state: async () => ({ identityVerifiedOn: null }) };
    const sources = new SqlSourcesProprietaire(t.db, identity, t.journal, { now: t.now });
    expect(await parties.sidesOf(t.network.id, t.personId)).toEqual(['vendeur']);
    expect(await parties.sidesOf(t.network.id, t.buyerId)).toEqual(['acquereur']);
    expect((await sources.ownerPropertiesOf(t.network.id, t.personId)).map((p) => p.propertyId)).toEqual([t.propertyId]);
    const docs = await sources.documentsOf(t.network.id, t.personId, t.propertyId);
    expect(docs.map((d) => d.title)).toContain('Mandat de vente simple');
    // Les documents du vendeur ne sont jamais ceux de l'acquéreur.
    expect(await sources.documentsOf(t.network.id, t.buyerId, t.propertyId)).toEqual([]);
    await t.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, '2099-10-01', 'preuves/test.pdf', 'a_demarrer', '2099-10-01T08:00:00.000Z', 'agent:test')", [t.fileId, t.network.id]);
    expect(await parties.sidesOf(t.network.id, t.personId)).toEqual(['vendeur']);
    expect(await parties.sidesOf(t.network.id, t.buyerId)).toEqual(['proprietaire', 'acquereur']);
    expect((await sources.ownerPropertiesOf(t.network.id, t.buyerId)).map((p) => p.propertyId)).toEqual([t.propertyId]);
    expect(await sources.ownerPropertiesOf(t.network.id, t.personId)).toEqual([]);
    expect(await sources.documentsOf(t.network.id, t.buyerId, t.propertyId)).toEqual([]);
    await t.db.run("INSERT INTO owner_booklets (file_id, person_id, network_id, agent_id, content, created_at) VALUES (?, ?, ?, ?, 'carnet de test', '2100-10-01T08:00:00.000Z')", [t.fileId, t.buyerId, t.network.id, t.alexId]);
    expect((await sources.documentsOf(t.network.id, t.buyerId, t.propertyId)).map((d) => d.title)).toEqual(['Carnet du propriétaire']);
  });
});
