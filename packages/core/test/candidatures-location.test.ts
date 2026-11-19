import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Candidatures, MisesEnLocation, OFFICIAL_PIECES, type RentalFacts } from '../src/location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, propriétaire, candidats et garants inventés. Le 12 juillet 2027 est un lundi.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
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
};

/** Des pièces que la liste officielle ne permet pas de demander : chacune est refusée [R104]. */
const FORBIDDEN = [
  'releve_compte', 'attestation_bonne_tenue_compte', 'photo_identite', 'carte_vitale', 'dossier_medical', 'extrait_casier_judiciaire', 'cheque_reservation',
  'contrat_mariage', 'certificat_concubinage', 'jugement_divorce', 'attestation_absence_credit', 'autorisation_prelevement', 'rib', 'releve_bancaire',
  'justificatif_situation_familiale', 'carte_assure_social', 'remise_compte_bloque', 'avis_imposition_parents', 'constructor', '__proto__', 'tostring',
];

describe('W04 · liste officielle', () => {
  it('[R104] chaque pièce de la liste a sa catégorie ; aucune pièce interdite n’y figure', () => {
    for (const [sort, p] of Object.entries(OFFICIAL_PIECES)) {
      expect(['domicile', 'activite', 'ressources', 'garantie'], sort).toContain(p.category);
      expect(p.label.length).toBeGreaterThan(3);
    }
    for (const sort of FORBIDDEN) expect(Object.prototype.hasOwnProperty.call(OFFICIAL_PIECES, sort), sort).toBe(false);
    expect(JSON.stringify(OFFICIAL_PIECES)).not.toMatch(/identit|passeport|compte|bancaire|vitale|m[ée]dical|casier/i);
    // Annexe II : la caution ne fournit ni attestation d'hébergement, ni certificat de scolarité, ni bourse, ni simulation
    // d'aides ; elle peut fournir une facture d'eau ou d'énergie et une attestation d'assurance du logement.
    const forCaution = (sort: string) => OFFICIAL_PIECES[sort]!.holders.includes('caution');
    for (const sort of ['attestation_hebergement', 'attestation_election_domicile', 'attestation_precedent_bailleur', 'certificat_scolarite', 'avis_bourse', 'simulation_aides_logement', 'quittances_loyer']) {
      expect(forCaution(sort), sort).toBe(false);
    }
    for (const sort of ['derniere_quittance', 'facture_eau_energie', 'attestation_assurance_logement', 'avis_taxe_fonciere', 'contrat_travail', 'avis_imposition', 'titre_propriete_ressource']) {
      expect(forCaution(sort), sort).toBe(true);
    }
    // Le titre de propriété ou l'avis de taxe foncière vaut aussi ressource ; un autre professionnel justifie son activité.
    expect(OFFICIAL_PIECES.titre_propriete_ressource!.category).toBe('ressources');
    expect(OFFICIAL_PIECES.piece_activite_autre!.category).toBe('activite');
  });
});

async function setup() {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r) };
  const listings = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const verified = new Set<string>();
  const identity = { state: async (_n: string, personId: string) => ({ identityVerifiedOn: verified.has(personId) ? '2027-07-10' : null }) };
  const apps = new Candidatures(db, listings, identity, files, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000' });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const compliance = { role: 'compliance' as const, userId: 'conf-1', networkId: network.id };
  const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
  if (!c.ok) throw new Error(c.code);
  const listingId = c.value.listingId;
  await listings.recordFacts(agent, listingId, FACTS);
  const person = async (i: number) => (await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: `Candidat${i}`, lastName: 'Inventé' })).id;
  const ref = (applicationId: string) => {
    const r = `location/${listingId}/candidatures/${applicationId}/${uuid()}.pdf`;
    refs.add(r);
    return r;
  };
  const piece = (applicationId: string, holder: string, sort: string) => apps.addPiece(agent, applicationId, { holder, sort, ref: ref(applicationId), sha256: SHA });
  /** Un dossier complet pour le candidat : identité au coffre, un domicile, une activité, des ressources. */
  const full = async (applicationId: string, holder: string, personId: string) => {
    verified.add(personId);
    for (const sort of [holder === 'candidat' ? 'quittances_loyer' : 'derniere_quittance', 'contrat_travail', 'bulletins_salaire', 'avis_imposition']) expect((await piece(applicationId, holder, sort)).ok, sort).toBe(true);
  };
  const events = (type: string) => db.all<{ data: string }>('SELECT data FROM journal WHERE type = ? ORDER BY seq', [type]);
  return { db, journal, store, network, alex, bea, owner, apps, listings, agent, other, dir, compliance, listingId, person, piece, full, verified, ref, events };
}

describeWithSqlite('W04 · candidatures limitées à la liste officielle', () => {
  it('[R104] 20 candidatures inventées : aucune pièce interdite n’est acceptée, chaque refus est au journal', async () => {
    const t = await setup();
    let refused = 0;
    for (let i = 1; i <= 20; i++) {
      const pid = await t.person(i);
      const a = await t.apps.apply(t.agent, t.listingId, { personId: pid });
      expect(a).toMatchObject({ ok: true, value: { arrival: i } });
      const id = a.ok ? a.value.applicationId : '';
      await t.full(id, 'candidat', pid);
      const sort = FORBIDDEN[i % FORBIDDEN.length]!;
      expect(await t.piece(id, 'candidat', sort), sort).toMatchObject({ ok: false, rule: /^R1(04|5)$/ });
      refused++;
      const v = await t.apps.read(t.agent, id);
      expect(v.ok && v.value.complete).toBe(true);
      expect(v.ok && v.value.pieces.every((p) => Object.prototype.hasOwnProperty.call(OFFICIAL_PIECES, p.sort))).toBe(true);
    }
    expect((await t.events('location.piece_refusee')).length).toBe(refused);
    // Aucune ligne rangée n'est hors de la liste officielle.
    const sorts = await t.db.all<{ sort: string }>('SELECT DISTINCT sort FROM rental_application_pieces');
    for (const s of sorts) expect(Object.keys(OFFICIAL_PIECES)).toContain(s.sort);
  });

  it('[R104] [R15] chaque sorte interdite est refusée ; une pièce d’identité va au coffre, jamais ici', async () => {
    const t = await setup();
    const pid = await t.person(1);
    const a = await t.apps.apply(t.agent, t.listingId, { personId: pid });
    const id = a.ok ? a.value.applicationId : '';
    for (const sort of FORBIDDEN) expect(await t.piece(id, 'candidat', sort), sort).toEqual({ ok: false, rule: 'R104', code: 'not_allowed' });
    for (const sort of ['carte_identite', 'passeport', 'permis_conduire', 'titre_sejour']) expect(await t.piece(id, 'candidat', sort), sort).toEqual({ ok: false, rule: 'R15', code: 'identity_in_vault' });
    expect(await t.db.all('SELECT 1 FROM rental_application_pieces')).toHaveLength(0);
    // Le journal nomme la sorte refusée, jamais la personne.
    for (const e of await t.events('location.piece_refusee')) expect(e.data).not.toMatch(/Candidat|Inventé/);
  });

  it('[R104] un seul justificatif de domicile ; la complétude suit la liste écrite, identité lue au coffre', async () => {
    const t = await setup();
    const pid = await t.person(1);
    const a = await t.apps.apply(t.agent, t.listingId, { personId: pid });
    const id = a.ok ? a.value.applicationId : '';
    const v0 = await t.apps.read(t.agent, id);
    expect(v0.ok && v0.value.missing).toEqual([
      { holder: 'candidat', what: 'identite' },
      { holder: 'candidat', what: 'domicile' },
      { holder: 'candidat', what: 'activite' },
      { holder: 'candidat', what: 'ressources' },
    ]);
    expect((await t.piece(id, 'candidat', 'quittances_loyer')).ok).toBe(true);
    expect(await t.piece(id, 'candidat', 'attestation_hebergement')).toEqual({ ok: false, rule: 'R104', code: 'one_domicile' });
    expect((await t.piece(id, 'candidat', 'certificat_scolarite')).ok).toBe(true);
    expect((await t.piece(id, 'candidat', 'avis_bourse')).ok).toBe(true);
    const v1 = await t.apps.read(t.agent, id);
    expect(v1.ok && v1.value.missing).toEqual([{ holder: 'candidat', what: 'identite' }]);
    t.verified.add(pid);
    const v2 = await t.apps.read(t.agent, id);
    expect(v2.ok && v2.value).toMatchObject({ complete: true, missing: [] });
    // Ni note, ni rang, ni score dans ce que lit l'agent [R14].
    expect(JSON.stringify(v2)).not.toMatch(/score|note|rank|rang|solvab/i);
  });

  it('[R104] garants : une personne avec ses pièces, ou Visale avec son seul visa', async () => {
    const t = await setup();
    const pid = await t.person(1);
    const gid = await t.person(2);
    const a = await t.apps.apply(t.agent, t.listingId, { personId: pid });
    const id = a.ok ? a.value.applicationId : '';
    await t.full(id, 'candidat', pid);
    const g = await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId: gid });
    const guarantor = g.ok ? g.value.guarantorId : '';
    const v = await t.apps.read(t.agent, id);
    expect(v.ok && v.value.missing.map((m) => m.what)).toEqual(['identite', 'domicile', 'activite', 'ressources']);
    await t.full(id, guarantor, gid);
    expect((await t.apps.read(t.agent, id)).ok && (await t.apps.read(t.agent, id) as { value: { complete: boolean } }).value.complete).toBe(true);
    // Un garant personne n'a pas de visa Visale ; Visale n'a que son visa.
    expect(await t.piece(id, guarantor, 'visa_visale')).toEqual({ ok: false, rule: 'R104', code: 'not_for_holder' });
    const vis = await t.apps.addGuarantor(t.agent, id, { kind: 'visale' });
    const visale = vis.ok ? vis.value.guarantorId : '';
    expect(await t.piece(id, visale, 'bulletins_salaire')).toEqual({ ok: false, rule: 'R104', code: 'not_for_holder' });
    expect((await t.apps.read(t.agent, id) as { value: { missing: unknown[] } }).value.missing).toEqual([{ holder: visale, what: 'visa_visale' }]);
    expect((await t.piece(id, visale, 'visa_visale')).ok).toBe(true);
    expect((await t.apps.read(t.agent, id) as { value: { complete: boolean } }).value.complete).toBe(true);
    // W18 : un seul garant Visale par dossier, même par deux demandes en même temps (index de la base).
    expect(await t.apps.addGuarantor(t.agent, id, { kind: 'visale' })).toEqual({ ok: false, rule: null, code: 'already_added' });
    await expect(t.db.run("INSERT INTO rental_guarantors (id, application_id, kind, person_id, added_by, added_at) VALUES ('g-double', ?, 'visale', NULL, 'agent:x', '2027-01-01T00:00:00.000Z')", [id])).rejects.toThrow(/UNIQUE/i);
    expect(await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId: pid })).toEqual({ ok: false, rule: null, code: 'unknown_person' });
    expect(await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId: gid })).toEqual({ ok: false, rule: null, code: 'already_added' });
    expect(await t.piece(id, 'garant-inconnu', 'contrat_travail')).toEqual({ ok: false, rule: null, code: 'unknown_holder' });
  });

  it('[R104] la caution ne fournit que les pièces de l’annexe II : refusées sinon, au journal ; toute pièce interdite aussi', async () => {
    const t = await setup();
    const pid = await t.person(1);
    const gid = await t.person(2);
    const a = await t.apps.apply(t.agent, t.listingId, { personId: pid });
    const id = a.ok ? a.value.applicationId : '';
    const g = await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId: gid });
    const guarantor = g.ok ? g.value.guarantorId : '';
    for (const sort of ['attestation_hebergement', 'attestation_election_domicile', 'attestation_precedent_bailleur', 'certificat_scolarite', 'avis_bourse', 'simulation_aides_logement', 'quittances_loyer']) {
      expect(await t.piece(id, guarantor, sort), sort).toEqual({ ok: false, rule: 'R104', code: 'not_for_holder' });
    }
    for (const sort of FORBIDDEN) expect(await t.piece(id, guarantor, sort), sort).toEqual({ ok: false, rule: 'R104', code: 'not_allowed' });
    // Une facture d'énergie suffit comme domicile ; la candidature devient complète avec le reste de l'annexe II.
    t.verified.add(gid);
    t.verified.add(pid);
    for (const sort of ['facture_eau_energie', 'piece_activite_autre', 'titre_propriete_ressource']) expect((await t.piece(id, guarantor, sort)).ok, sort).toBe(true);
    for (const sort of ['avis_taxe_fonciere', 'piece_activite_autre', 'titre_propriete_ressource']) expect((await t.piece(id, 'candidat', sort)).ok, sort).toBe(true);
    expect((await t.apps.read(t.agent, id) as { value: { complete: boolean } }).value.complete).toBe(true);
    expect(await t.db.all("SELECT 1 FROM rental_application_pieces WHERE holder = ? AND sort NOT IN ('facture_eau_energie', 'piece_activite_autre', 'titre_propriete_ressource')", [guarantor])).toHaveLength(0);
  });

  it('[R104] un lien DossierFacile vaut dossier sans autre pièce ; un lien d’ailleurs est refusé', async () => {
    const t = await setup();
    const a = await t.apps.apply(t.agent, t.listingId, { personId: await t.person(1), dossierFacileUrl: 'https://locataire.dossierfacile.logement.gouv.fr/file/abcd-1234-efgh' });
    expect((await t.apps.read(t.agent, a.ok ? a.value.applicationId : '') as { value: { complete: boolean; dossierFacile: boolean } }).value).toMatchObject({ complete: true, dossierFacile: true });
    for (const url of ['http://locataire.dossierfacile.logement.gouv.fr/file/abcd-1234', 'https://dossierfacile.example.com/file/abcd-1234', 'https://locataire.dossierfacile.logement.gouv.fr/file/x']) {
      expect(await t.apps.apply(t.agent, t.listingId, { personId: await t.person(2), dossierFacileUrl: url }), url).toEqual({ ok: false, rule: null, code: 'bad_dossierfacile' });
    }
  });

  describe('W22 · le candidat, par appel direct', () => {
    it('[R16] le contact d’un autre agent est refusé et le refus au journal ; le bailleur aussi ; la direction peut ranger un contact d’un agent', async () => {
      const t = await setup();
      const autre = (await t.store.createPerson({ networkId: t.network.id, agentId: t.bea.id, firstName: 'Autre', lastName: 'Agent' })).id;
      expect(await t.apps.apply(t.agent, t.listingId, { personId: autre })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
      const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.subject === `rental:${t.listingId}`);
      expect(refused.map((e) => e.data)).toEqual([expect.objectContaining({ rule: 'R16', kind: 'rental_applicant', code: 'not_assigned' })]);
      expect(JSON.stringify(refused)).not.toContain(autre);
      expect(await t.apps.apply(t.agent, t.listingId, { personId: t.owner.id })).toEqual({ ok: false, rule: null, code: 'unknown_person' });
      expect(await t.db.first('SELECT 1 FROM rental_applications')).toBeNull();
      expect((await t.apps.apply(t.dir, t.listingId, { personId: autre })).ok).toBe(true);
    });

    it('[R105] une fiche réunie reste rangée sur la fiche gardée, une seule fois', async () => {
      const t = await setup();
      const [gardee, reunie] = [(await t.person(1))!, (await t.person(2))!];
      await t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES (?, ?, ?, ?, ?, 'test', '2027-07-01T08:00:00.000Z', '2027-07-01T08:00:00.000Z')", [uuid(), t.network.id, t.alex.id, gardee, reunie]);
      expect((await t.apps.apply(t.agent, t.listingId, { personId: reunie })).ok).toBe(true);
      expect((await t.db.first<{ person_id: string }>('SELECT person_id FROM rental_applications'))!.person_id).toBe(gardee);
      expect(await t.apps.apply(t.agent, t.listingId, { personId: gardee })).toEqual({ ok: false, rule: null, code: 'already_applied' });
    });
  });

  describe('W20 · le garant, par appel direct', () => {
    const merge = (t: Awaited<ReturnType<typeof setup>>, survivor: string, merged: string) =>
      t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES (?, ?, ?, ?, ?, 'test', '2027-07-01T08:00:00.000Z', '2027-07-01T08:00:00.000Z')", [uuid(), t.network.id, t.alex.id, survivor, merged]);
    const applied = async (t: Awaited<ReturnType<typeof setup>>, person: string, url?: string) => {
      const a = await t.apps.apply(t.agent, t.listingId, { personId: person, ...(url ? { dossierFacileUrl: url } : {}) });
      if (!a.ok) throw new Error(a.code);
      return a.value.applicationId;
    };

    it('[R16] le contact d’un autre agent, même par une fiche réunie, est refusé et le refus est au journal ; la direction peut', async () => {
      const t = await setup();
      const id = await applied(t, (await t.person(1))!);
      const autre = (await t.store.createPerson({ networkId: t.network.id, agentId: t.bea.id, firstName: 'Autre', lastName: 'Agent' })).id;
      const mixte = (await t.person(2))!;
      await merge(t, mixte, (await t.store.createPerson({ networkId: t.network.id, agentId: t.bea.id, firstName: 'Autre2', lastName: 'Agent' })).id);
      for (const personId of [autre, mixte]) expect(await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
      // Une fiche d'un autre agent, réunie dans une autre : refusée pareil, et le refus au journal.
      const gardeeBea = (await t.store.createPerson({ networkId: t.network.id, agentId: t.bea.id, firstName: 'Autre3', lastName: 'Agent' })).id;
      const reunieBea = (await t.store.createPerson({ networkId: t.network.id, agentId: t.bea.id, firstName: 'Autre4', lastName: 'Agent' })).id;
      await merge(t, gardeeBea, reunieBea);
      expect(await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId: reunieBea })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
      const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.subject === `rental_application:${id}`);
      expect(refused).toHaveLength(3);
      expect(refused[0]!.data).toMatchObject({ rule: 'R16', code: 'not_assigned' });
      expect(JSON.stringify(refused)).not.toContain(autre);
      expect(await t.db.first('SELECT 1 FROM rental_guarantors')).toBeNull();
      expect((await t.apps.addGuarantor(t.dir, id, { kind: 'personne', personId: autre })).ok).toBe(true);
    });

    it('[R16] une fiche réunie, celle du candidat, le candidat par une autre fiche, un autre candidat ou le bailleur sont refusés', async () => {
      const t = await setup();
      const [cand, doublon, reunie, gardee, voisin] = [(await t.person(1))!, (await t.person(2))!, (await t.person(3))!, (await t.person(4))!, (await t.person(5))!];
      await merge(t, cand, doublon);
      await merge(t, gardee, reunie);
      const id = await applied(t, cand);
      await applied(t, voisin);
      const owner = (await t.db.first<{ owner_person_id: string }>('SELECT owner_person_id FROM rental_listings WHERE id = ?', [t.listingId]))!.owner_person_id;
      for (const personId of [cand, doublon, reunie, voisin, owner, 'inconnue']) expect(await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId }), personId).toEqual({ ok: false, rule: null, code: 'unknown_person' });
      expect(await t.db.first('SELECT 1 FROM rental_guarantors')).toBeNull();
      expect((await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId: gardee })).ok).toBe(true);
    });

    it('[R16] l’écran ne propose que ce que le geste accepte : bailleur réuni et candidat au bout d’une chaîne de fusions écartés', async () => {
      const t = await setup();
      const [survivant, chaineA, chaineB, chaineC, libre, cand] = [(await t.person(1))!, (await t.person(2))!, (await t.person(3))!, (await t.person(4))!, (await t.person(5))!, (await t.person(6))!];
      const owner = (await t.db.first<{ owner_person_id: string }>('SELECT owner_person_id FROM rental_listings WHERE id = ?', [t.listingId]))!.owner_person_id;
      await merge(t, survivant, owner);
      await merge(t, chaineA, chaineB);
      const id = await applied(t, cand);
      await applied(t, chaineB);
      await merge(t, chaineC, chaineA);
      const listed = await t.apps.addableContacts(t.agent, t.listingId);
      const offered = listed.ok ? listed.value.contacts.map((c) => c.personId) : [];
      expect(offered).toEqual([libre]);
      for (const personId of [survivant, chaineC]) expect(await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId }), personId).toEqual({ ok: false, rule: null, code: 'unknown_person' });
      expect((await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId: libre })).ok).toBe(true);
    });

    it('[R104] un dossier DossierFacile ne reçoit ni pièce, ni garant, ni dépôt par appel direct', async () => {
      const t = await setup();
      const id = await applied(t, (await t.person(1))!, 'https://locataire.dossierfacile.logement.gouv.fr/file/abcd-1234-efgh');
      const refusal = { ok: false, rule: 'R104', code: 'dossierfacile' };
      expect(await t.apps.addGuarantor(t.agent, id, { kind: 'visale' })).toEqual(refusal);
      expect(await t.apps.addGuarantor(t.agent, id, { kind: 'personne', personId: await t.person(2) })).toEqual(refusal);
      expect(await t.apps.addPiece(t.agent, id, { holder: 'candidat', sort: 'bulletins_salaire', ref: `location/${t.listingId}/candidatures/${id}/${uuid()}.pdf`, sha256: 'a'.repeat(64) })).toEqual(refusal);
      expect(await t.apps.placeOf(t.agent, id, 'candidat')).toEqual(refusal);
      // Une pièce interdite reste refusée pour ce qu'elle est, et nommée au journal.
      expect(await t.apps.addPiece(t.agent, id, { holder: 'candidat', sort: 'releve_compte', ref: 'x', sha256: 'a'.repeat(64) })).toEqual({ ok: false, rule: 'R104', code: 'not_allowed' });
      expect((await t.journal.all()).filter((e) => e.type === 'location.piece_refusee').map((e) => e.data)).toEqual([{ rule: 'R104', sort: 'releve_compte' }]);
      expect(await t.db.first('SELECT 1 FROM rental_guarantors')).toBeNull();
      expect(await t.db.first('SELECT 1 FROM rental_application_pieces')).toBeNull();
    });
  });

  it('[R16] [R105] les contacts à ajouter : ceux de l’agent, sans le bailleur ni un candidat, même réuni ; une personne réunie n’a qu’une candidature', async () => {
    const t = await setup();
    const merge = (survivor: string, merged: string) =>
      t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES (?, ?, ?, ?, ?, 'test', '2027-07-01T08:00:00.000Z', '2027-07-01T08:00:00.000Z')", [`fusion-${merged}`, t.network.id, t.alex.id, survivor, merged]);
    const [gardee, reunie, candidate, libre, mixte] = [await t.person(1), await t.person(2), await t.person(3), await t.person(4), await t.person(5)];
    const autre = (await t.store.createPerson({ networkId: t.network.id, agentId: t.bea.id, firstName: 'Autre', lastName: 'Agent' })).id;
    const autreMixte = (await t.store.createPerson({ networkId: t.network.id, agentId: t.bea.id, firstName: 'Autre2', lastName: 'Agent' })).id;
    await merge(gardee!, reunie!);
    await merge(mixte!, autreMixte);
    expect((await t.apps.apply(t.agent, t.listingId, { personId: candidate })).ok).toBe(true);

    const seen = await t.apps.addableContacts(t.agent, t.listingId);
    if (!seen.ok) throw new Error(seen.code);
    expect(seen.value.contacts.map((c) => c.personId).sort()).toEqual([gardee, libre].sort());
    expect(seen.value.contacts.map((c) => c.personId)).not.toContain(autre);
    expect(seen.value.more).toBe(false);
    // L'agent d'un autre logement est refusé [R16].
    expect(await t.apps.addableContacts(t.other, t.listingId)).toMatchObject({ ok: false, rule: 'R16' });

    // La fiche réunie mène à la fiche gardée : une candidature, pas deux.
    const a = await t.apps.apply(t.agent, t.listingId, { personId: reunie });
    if (!a.ok) throw new Error(a.code);
    expect((await t.db.first<{ person_id: string }>('SELECT person_id FROM rental_applications WHERE id = ?', [a.value.applicationId]))!.person_id).toBe(gardee);
    expect(await t.apps.apply(t.agent, t.listingId, { personId: gardee })).toEqual({ ok: false, rule: null, code: 'already_applied' });
    expect(await t.apps.apply(t.agent, t.listingId, { personId: reunie })).toEqual({ ok: false, rule: null, code: 'already_applied' });
    const after = await t.apps.addableContacts(t.agent, t.listingId);
    expect(after.ok && after.value.contacts.map((c) => c.personId)).toEqual([libre]);
  });

  it('[R105] une candidature rangée sur une fiche réunie ensuite ferme la fiche gardée', async () => {
    const t = await setup();
    const [gardee, reunie] = [await t.person(1), await t.person(2)];
    expect((await t.apps.apply(t.agent, t.listingId, { personId: reunie })).ok).toBe(true);
    await t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES ('f1', ?, ?, ?, ?, 'test', '2027-07-20T08:00:00.000Z', '2027-07-20T08:00:00.000Z')", [t.network.id, t.alex.id, gardee, reunie]);
    expect(await t.apps.apply(t.agent, t.listingId, { personId: gardee })).toEqual({ ok: false, rule: null, code: 'already_applied' });
    const after = await t.apps.addableContacts(t.agent, t.listingId);
    expect(after.ok && after.value.contacts).toEqual([]);
  });

  it('[R14] [R17] l’ordre d’arrivée seul ; une personne ne candidate qu’une fois ; rien ne s’efface', async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const a = await t.apps.apply(t.agent, t.listingId, { personId: await t.person(i) });
      ids.push(a.ok ? a.value.applicationId : '');
    }
    const all = await t.apps.list(t.agent, t.listingId);
    expect(all.ok && all.value.map((a) => a.arrival)).toEqual([1, 2, 3]);
    expect(all.ok && all.value.map((a) => a.applicationId)).toEqual(ids);
    const pid = (await t.db.first<{ person_id: string }>('SELECT person_id FROM rental_applications WHERE id = ?', [ids[0]!]))!.person_id;
    expect(await t.apps.apply(t.agent, t.listingId, { personId: pid })).toEqual({ ok: false, rule: null, code: 'already_applied' });
    await expect(t.db.run('UPDATE rental_applications SET arrival = 9')).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM rental_applications')).rejects.toThrow(/rien ne s'efface/);
    const cols = await t.db.all<{ name: string }>("SELECT p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name LIKE 'rental_appl%'");
    for (const c of cols) expect(c.name).not.toMatch(/score|note|rank|income|revenu|salaire/i);
  });

  it('[R16] l’agent du logement et la direction rangent ; la conformité lit ; un autre agent est refusé', async () => {
    const t = await setup();
    const pid = await t.person(1);
    expect(await t.apps.apply(t.other, t.listingId, { personId: pid })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.apps.apply(t.compliance, t.listingId, { personId: pid })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const a = await t.apps.apply(t.dir, t.listingId, { personId: pid });
    const id = a.ok ? a.value.applicationId : '';
    expect(await t.apps.addPiece(t.other, id, { holder: 'candidat', sort: 'contrat_travail', ref: t.ref(id), sha256: SHA })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect((await t.apps.read(t.compliance, id)).ok).toBe(true);
    expect(await t.apps.read(t.agent, 'inconnue')).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    expect(await t.apps.apply(t.agent, t.listingId, { personId: 'personne' })).toEqual({ ok: false, rule: null, code: 'unknown_person' });
    expect(await t.apps.addPiece(t.agent, id, { holder: 'candidat', sort: 'contrat_travail', ref: `ailleurs/${uuid()}.pdf`, sha256: SHA })).toEqual({ ok: false, rule: null, code: 'bad_ref' });
    expect(await t.apps.addPiece(t.agent, id, { holder: 'candidat', sort: 'contrat_travail', ref: `location/${t.listingId}/candidatures/${id}/${uuid()}.pdf`, sha256: SHA })).toEqual({ ok: false, rule: null, code: 'not_stored' });
    expect((await t.events('location.lue')).map((e) => JSON.parse(e.data).what)).toEqual(['application']);
  });
});
