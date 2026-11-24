import { expect, it } from 'vitest';
import { FicheUnique } from '../src/index.ts';
import { EspaceAcquereur, SqlClientParties, SqlSourcesAcquereur, propertyKindWord, type ClientViewer, type GestesAcquereur, type InvestorNoteGate } from '../src/espaces/index.ts';
import type { DiffusionGate } from '../src/acquereurs/rapprochement.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Réseau, biens, vendeurs, acquéreurs, investisseurs et candidats inventés.
const H = 3_600_000;
let k = 0;
const SHA = 'b'.repeat(64);

const GESTES: GestesAcquereur = {
  bookVisit: async () => ({ ok: true, value: {} }),
  writeOffer: async () => ({ ok: true, value: {} }),
  addFinancingPiece: async () => ({ ok: true, value: {} }),
  requestAlerts: async () => ({ ok: true, value: {} }),
};

async function setup(options: { diffusion?: DiffusionGate; notes?: InvestorNoteGate | null } = {}) {
  const t = await setupDossier();
  // L'annonce validée et publiée : le bien est sous offre, encore diffusable.
  await t.annonces.validate(t.agent, t.draftId);
  await t.publication.sync(t.network.id, t.propertyId);
  const identity = { state: async () => ({ identityVerifiedOn: '2027-02-20' }) };
  const parties = new SqlClientParties(t.db);
  const sources = new SqlSourcesAcquereur(t.db, t.acces, identity, t.journal, { now: t.now, ...(options.diffusion ? { diffusion: options.diffusion } : {}), notes: options.notes ?? null });
  const espace = new EspaceAcquereur(t.db, sources, GESTES, t.journal, { now: t.now });
  const viewer = async (personId: string): Promise<ClientViewer> => ({ kind: 'client', networkId: t.network.id, personId, sessionId: `s-${personId}`, sides: await parties.sidesOf(t.network.id, personId) });
  const iso = (ms: number) => new Date(ms).toISOString();
  const person = async (firstName: string, lastName: string) => {
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName });
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.alexId, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    return p.id;
  };
  /** L'alerte de M08 partie à la personne, rangée comme le fait T03. */
  const alert = async (personId: string, propertyId = t.propertyId, status = 'sent') => {
    await t.db.run('INSERT INTO property_alerts (property_id, person_id, network_id, project_id, channel, status, rule, message_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)', [propertyId, personId, t.network.id, 'email', status, t.now().toISOString(), t.now().toISOString()]);
  };
  /** Une visite du bien, rangée comme le fait M05. */
  const visit = async (personId: string, startAt: string, status = 'booked') => {
    const id = `rdv-${++k}`;
    const start = Date.parse(startAt);
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId, kind: 'buy' });
    await t.db.run(
      `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visite', ?, ?, ?, ?, 'agent', NULL, ?, ?)`,
      [id, t.network.id, t.alexId, personId, t.propertyId, iso(start), iso(start + H), status, `h-${id}`, iso(start - 48 * H), iso(start - 48 * H)],
    );
    await t.db.run('INSERT INTO visits (appointment_id, network_id, property_id, project_id, person_id, agent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, t.network.id, t.propertyId, project.id, personId, t.alexId, 'agent:test', iso(start - 48 * H)]);
    return id;
  };
  return { ...t, identity, parties, sources, espace, viewer, person, alert, visit };
}

describeWithSqlite('EC11 · lecteurs SQL de l’espace de l’acquéreur', () => {
  it('[R161] l’acquéreur d’une offre, un visiteur, une alerte partie font un acquéreur ; une alerte non partie, un inconnu, rien', async () => {
    const t = await setup();
    expect(await t.parties.sidesOf(t.network.id, t.buyerId)).toEqual(['acquereur']);
    const v = await t.person('Victor', 'Visiteur');
    await t.visit(v, '2027-03-05T14:00:00.000Z');
    expect(await t.parties.sidesOf(t.network.id, v)).toEqual(['acquereur']);
    const a = await t.person('Agathe', 'Alerte');
    await t.alert(a, t.propertyId, 'waiting');
    expect(await t.parties.sidesOf(t.network.id, a)).toEqual([]);
    await t.db.run("UPDATE property_alerts SET status = 'sent' WHERE person_id = ?", [a]);
    expect(await t.parties.sidesOf(t.network.id, a)).toEqual(['acquereur']);
    expect(await t.parties.sidesOf(t.network.id, 'p-inconnue')).toEqual([]);
    expect(await t.parties.sidesOf('autre-reseau', t.buyerId)).toEqual([]);
    // Le vendeur reste vendeur, sans côté d'acheteur.
    expect(await t.parties.sidesOf(t.network.id, t.personId)).toEqual(['vendeur']);
  });

  it('[R161] [R42] un bien proposé n’est montré que diffusable, par les seuls champs de l’annonce ; le vendeur est rattaché pour la retenue', async () => {
    const t = await setup();
    await t.alert(t.buyerId);
    const raw = await t.sources.proposedOf(t.network.id, t.buyerId);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ propertyId: t.propertyId, reference: 'REF-T-1', city: 'Dijon', kind: 'Maison ou appartement', surfaceM2: 62, rooms: 3, energyClass: 'D', diffusable: true });
    expect(raw[0]!.priceEur).toBeGreaterThan(0);
    expect(raw[0]!.sellers.map((s) => s.personId)).toContain(t.personId);
    const v = await t.espace.vue(await t.viewer(t.buyerId));
    if (!v.ok) throw new Error(v.code);
    expect(v.value.properties.map((p) => p.propertyId)).toEqual([t.propertyId]);
    expect(v.value.properties[0]!.energyClass.value).toBe('D');
    expect(JSON.stringify(v.value)).not.toContain('Léa');
    // Une alerte pas encore partie ne propose rien.
    const other = await t.person('Odile', 'Attente');
    await t.alert(other, t.propertyId, 'waiting');
    expect(await t.sources.proposedOf(t.network.id, other)).toEqual([]);
  });

  it('[R163] la sorte d’un bien proposé est écrite en français, jamais avec le code de la base (DS078)', () => {
    // Une valeur, un mot : les six sortes de bien de la base.
    expect(['home', 'land', 'building', 'commercial', 'business_walls', 'business'].map(propertyKindWord)).toEqual(['Maison ou appartement', 'Terrain', 'Immeuble', 'Local commercial', 'Murs commerciaux', 'Fonds de commerce']);
    // Une sorte que la liste ne connaît pas, ou un nom hérité d'Object, n'est jamais montré tel quel.
    for (const code of ['villa', '', 'constructor', 'toString']) expect(propertyKindWord(code)).toBe('Bien');
  });

  it('[R42] un bien que la porte de diffusion refuse, ou dont l’annonce est retirée, n’est plus montré', async () => {
    const refused = await setup({ diffusion: { canDiffuse: async () => ({ allowed: false, reason: 'expired' }) } });
    await refused.alert(refused.buyerId);
    expect((await refused.sources.proposedOf(refused.network.id, refused.buyerId))[0]!.diffusable).toBe(false);
    const v = await refused.espace.vue(await refused.viewer(refused.buyerId));
    if (!v.ok) throw new Error(v.code);
    expect(v.value.properties).toEqual([]);
    const t = await setup();
    await t.alert(t.buyerId);
    await t.db.run(
      "INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES ('lv-retrait', ?, ?, 99, 'retiree', NULL, NULL, '{}', ?, 'retrait', ?)",
      [t.propertyId, t.network.id, SHA, t.now().toISOString()],
    );
    expect(await t.sources.proposedOf(t.network.id, t.buyerId)).toEqual([]);
  });

  it('[R161] [R163] l’acquéreur voit son offre du registre, son dossier : ses seules pièces, son financement déclaré, sa date d’acte', async () => {
    const t = await setup();
    const offers = await t.sources.offersOf(t.network.id, t.buyerId);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ id: t.offerId, propertyId: t.propertyId, amountEur: 205000, state: 'acceptée' });
    expect(await t.sources.offersOf(t.network.id, t.personId)).toEqual([]);
    const files = await t.sources.filesOf(t.network.id, t.buyerId);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.fileId).toBe(t.fileId);
    // Seules les pièces du côté de l'acquéreur ; aucune du vendeur.
    expect(file.pieces.map((p) => [p.kind, p.state])).toEqual([["Fiche de renseignements de l'acquéreur remplie", 'manquante']]);
    expect(file.loan).toBeNull();
    expect(file.deed).not.toBeNull();
    for (const hold of file.deed!.holds) expect(hold).not.toMatch(/vendeur/i);
    await t.db.run("INSERT INTO sale_file_financing (file_id, seq, network_id, step, day, declared_by, at, by) VALUES (?, 1, ?, 'demande_deposee', '2027-03-05', 'acquereur', '2027-03-05T10:00:00.000Z', 'agent:test')", [t.fileId, t.network.id]);
    expect((await t.sources.filesOf(t.network.id, t.buyerId))[0]!.loan).toEqual({ state: 'demande de prêt déposée', at: '2027-03-05' });
    await t.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, '2027-06-01', 'preuves/test.pdf', 'a_demarrer', '2027-06-01T12:00:00.000Z', 'agent:test')", [t.fileId, t.network.id]);
    expect((await t.sources.filesOf(t.network.id, t.buyerId))[0]!.deed).toEqual({ date: '2027-06-01', holds: [], computedAt: '2027-06-01T12:00:00.000Z' });
    // Le vendeur n'a aucun dossier d'acquéreur.
    expect(await t.sources.filesOf(t.network.id, t.personId)).toEqual([]);
  });

  it('[R163] [R13] sans le tableau des offres, aucun chiffre n’est recomposé et l’échec va au journal', async () => {
    const t = await setup();
    await t.db.run('UPDATE properties SET agent_id = NULL WHERE id = ?', [t.propertyId]);
    const offers = await t.sources.offersOf(t.network.id, t.buyerId);
    expect(offers[0]).toMatchObject({ amountEur: null, state: null });
    const v = await t.espace.vue(await t.viewer(t.buyerId));
    if (!v.ok) throw new Error(v.code);
    expect(v.value.offers[0]!.amount).toEqual({ value: null, label: 'non communiquée' });
    const events = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'espaces.source_indisponible'");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.data).not.toContain('Acheteur');
  });

  it('[R162] le candidat locataire ne voit que sa candidature et son état, jamais un rang ni les autres candidats', async () => {
    const t = await setup();
    const owner = await t.person('Bastien', 'Bailleur');
    const home = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'L-9', kind: 'home', postalCode: '21000', city: 'Dijon', rooms: 2 });
    await t.db.run("INSERT INTO rental_listings (id, network_id, property_id, owner_person_id, created_by, created_at) VALUES ('rl-1', ?, ?, ?, 'agent:test', '2027-03-01T08:00:00.000Z')", [t.network.id, home.id, owner]);
    const c1 = await t.person('Capucine', 'Candidate');
    const c2 = await t.person('Corentin', 'Candidat');
    const insert = async (id: string, personId: string, arrival: number, complete: boolean) =>
      t.db.run('INSERT INTO rental_applications (id, listing_id, network_id, person_id, arrival, dossierfacile_url, created_by, arrived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, 'rl-1', t.network.id, personId, arrival, complete ? 'https://www.dossierfacile.logement.gouv.fr/file/essai' : null, 'agent:test', `2027-03-0${arrival + 1}T08:00:00.000Z`]);
    await insert('ra-1', c1, 1, true);
    await insert('ra-2', c2, 2, false);
    expect(await t.parties.sidesOf(t.network.id, c1)).toEqual(['candidat_locataire']);
    const a1 = await t.sources.tenantApplicationsOf(t.network.id, c1);
    expect(a1).toEqual([{ rentalId: 'rl-1', propertyId: home.id, reference: 'L-9', city: 'Dijon', receivedAt: '2027-03-02T08:00:00.000Z', complete: true, state: 'complète, en attente du choix du propriétaire', stateAt: '2027-03-02T08:00:00.000Z' }]);
    expect((await t.sources.tenantApplicationsOf(t.network.id, c2))[0]!.state).toBe('incomplète : pièces à compléter');
    await t.db.run("INSERT INTO rental_presentations (id, listing_id, network_id, version, snapshot, snapshot_sha256, created_by, created_at) VALUES ('rp-1', 'rl-1', ?, 1, '{}', ?, 'agent:test', '2027-03-04T08:00:00.000Z')", [t.network.id, SHA]);
    await t.db.run("INSERT INTO rental_choices (listing_id, presentation_id, application_id, decided_at, channel, proof_ref, recorded_by, recorded_at) VALUES ('rl-1', 'rp-1', 'ra-1', '2027-03-05T08:00:00.000Z', 'ecrit', 'location/rl-1/choix.pdf', 'agent:test', '2027-03-05T08:00:00.000Z')");
    expect((await t.sources.tenantApplicationsOf(t.network.id, c1))[0]).toMatchObject({ state: 'retenue', stateAt: '2027-03-05T08:00:00.000Z' });
    expect((await t.sources.tenantApplicationsOf(t.network.id, c2))[0]!.state).toBe('non retenue');
    const v = await t.espace.vue(await t.viewer(c2));
    if (!v.ok) throw new Error(v.code);
    expect(v.value.rentals).toHaveLength(1);
    const text = JSON.stringify(v.value);
    for (const leak of ['Capucine', 'Bastien', 'Bailleur', 'ra-1', 'arrival', 'rank']) expect(text).not.toContain(leak);
    // Le bailleur est rattaché pour la retenue.
    expect((await t.sources.sellersOf(t.network.id, [home.id])).map((s) => s.personId)).toEqual([owner]);
  });

  it('[R163] [R124] le rendement de l’investisseur vient d’une note validée remise par la porte de M17, avec ses hypothèses ; sans porte, rien', async () => {
    const remise = new Set<string>(['note-1']);
    const gate: InvestorNoteGate = { forClient: async (_n, id) => (remise.has(id) ? { text: 'note', validatedAt: '2027-03-03T09:00:00.000Z' } : null) };
    const t = await setup({ notes: gate });
    const inv = await t.person('Inès', 'Investisseuse');
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: inv, kind: 'buy' });
    await t.db.run("INSERT INTO investor_profiles (id, network_id, project_id, person_id, version, sectors, origin, created_at) VALUES ('ip-1', ?, ?, ?, 1, '[\"21231\"]', 'agent:test', '2027-03-01T08:00:00.000Z')", [t.network.id, project.id, inv]);
    expect(await t.parties.sidesOf(t.network.id, inv)).toEqual(['investisseur']);
    const result = { status: 'complet', formulaVersion: 1, lines: [], grossYieldBp: { low: 480, central: 520, high: 560 }, netYieldBp: { low: 350, central: 390, high: 430 } };
    await t.db.run("INSERT INTO investment_calculations (id, network_id, property_id, project_id, inputs, status, result, formula_version, created_by, created_at) VALUES ('calc-1', ?, ?, ?, '{}', 'complet', ?, 1, 'agent:test', '2027-03-02T08:00:00.000Z')", [t.network.id, t.propertyId, project.id, JSON.stringify(result)]);
    const note = { alerts: [], paragraphs: [], figures: [], sources: [{ line: 'price', text: 'Prix d’achat : 205 000 €, annonce du 01/03/2027, prix affiché' }], mentions: ['Loyer de marché : Carte des loyers de l’ANIL.'], referral: 'Voir un professionnel.' };
    await t.db.run("INSERT INTO investment_notes (id, network_id, calculation_id, project_id, origin, note, text, text_sha256, status, created_by, created_at, validated_by, validated_at) VALUES ('note-1', ?, 'calc-1', ?, 'secours', ?, 'note', ?, 'validee', 'agent:test', '2027-03-03T08:00:00.000Z', 'agent:test', '2027-03-03T09:00:00.000Z')", [t.network.id, project.id, JSON.stringify(note), SHA]);
    expect(await t.sources.investorOf(t.network.id, inv, t.propertyId)).toEqual({
      propertyId: t.propertyId,
      grossYieldBp: 520,
      netYieldBp: 390,
      hypotheses: ['Prix d’achat : 205 000 €, annonce du 01/03/2027, prix affiché'],
      constraints: ['Loyer de marché : Carte des loyers de l’ANIL.'],
      computedAt: '2027-03-03T09:00:00.000Z',
    });
    // Un autre investisseur ne lit pas cette note ; la porte qui la retient ne laisse rien passer.
    expect(await t.sources.investorOf(t.network.id, t.buyerId, t.propertyId)).toBeNull();
    remise.delete('note-1');
    expect(await t.sources.investorOf(t.network.id, inv, t.propertyId)).toBeNull();
    const sansPorte = new SqlSourcesAcquereur(t.db, t.acces, t.identity, t.journal, { now: t.now });
    expect(await sansPorte.investorOf(t.network.id, inv, t.propertyId)).toBeNull();
  });

  it('[R49] les alertes ne sont dites demandées qu’avec l’accord en cours', async () => {
    const t = await setup();
    expect(await t.sources.alertsRequested(t.network.id, t.buyerId)).toBe(false);
    await t.store.addConsent({ networkId: t.network.id, agentId: t.alexId, personId: t.buyerId, purpose: 'alertes_biens', channel: 'email', proof: 'formulaire de test', givenAt: new Date('2027-02-01T08:00:00.000Z') });
    expect(await t.sources.alertsRequested(t.network.id, t.buyerId)).toBe(true);
    expect(await t.sources.alertsRequested('autre-reseau', t.buyerId)).toBe(false);
  });

  it('[R03] [R49] une ligne ouverte plus ancienne qu’un retrait ne fait pas dire « demandées » (AC07)', async () => {
    const t = await setup();
    const line = (given: string) => t.store.addConsent({ networkId: t.network.id, agentId: t.alexId, personId: t.buyerId, purpose: 'alertes_biens', channel: 'email', proof: 'formulaire de test', givenAt: new Date(given) });
    await line('2020-01-02T00:00:00.000Z');
    const old = await line('2020-01-01T00:00:00.000Z');
    await t.store.withdrawConsent(old.id, new Date('2020-02-01T00:00:00.000Z'));
    expect(await t.sources.alertsRequested(t.network.id, t.buyerId)).toBe(false);
  });

  it('[R161] une fiche fusionnée compte pour la fiche gardée', async () => {
    const t = await setup();
    const kept = await t.person('Acheteur', 'Gardé');
    await new FicheUnique(t.db, t.store, { now: t.now }).merge({ survivorId: kept, mergedId: t.buyerId, reason: 'identifiant commun' });
    expect(await t.parties.sidesOf(t.network.id, kept)).toEqual(['acquereur']);
    expect((await t.sources.offersOf(t.network.id, kept)).map((o) => o.id)).toEqual([t.offerId]);
    // Le dossier porte la fiche absorbée : elle est rendue sous la fiche gardée, que la vue écarte du lecteur.
    const sellers = await t.sources.sellersOf(t.network.id, [t.propertyId]);
    expect(sellers.map((s) => s.personId)).toContain(kept);
    expect(sellers.map((s) => s.personId)).not.toContain(t.buyerId);
  });

  it('[R163] une visite manquée est dite « manquée », jamais « annulée »', async () => {
    const t = await setup();
    await t.visit(t.buyerId, '2027-03-04T10:00:00.000Z', 'absent');
    expect((await t.sources.visitsOf(t.network.id, t.buyerId)).map((v) => v.state)).toEqual(['manquée']);
  });

  it('[R161] parcours de 5 acquéreurs sur une vraie base : chacun voit ses visites et ses biens, rien d’un autre client', async () => {
    const t = await setup();
    const buyers: { id: string; name: string; visit: string }[] = [];
    await t.alert(t.buyerId);
    buyers.push({ id: t.buyerId, name: 'Acheteur', visit: await t.visit(t.buyerId, '2027-03-04T10:00:00.000Z', 'honored') });
    for (let i = 2; i <= 5; i++) {
      const id = await t.person(`Acquéreur${i}`, `Fictif${i}`);
      await t.alert(id);
      buyers.push({ id, name: `Acquéreur${i}`, visit: await t.visit(id, `2027-03-0${i + 3}T10:00:00.000Z`) });
    }
    for (const b of buyers) {
      const viewer = await t.viewer(b.id);
      expect(viewer.sides).toEqual(['acquereur']);
      const v = await t.espace.vue(viewer);
      if (!v.ok) throw new Error(v.code);
      expect(v.value.properties.map((p) => p.propertyId)).toEqual([t.propertyId]);
      expect(v.value.visits).toHaveLength(1);
      expect(v.value.offers).toHaveLength(b.id === t.buyerId ? 1 : 0);
      expect(v.value.files).toHaveLength(b.id === t.buyerId ? 1 : 0);
      const text = JSON.stringify(v.value);
      for (const o of buyers.filter((x) => x.id !== b.id)) {
        expect(text).not.toContain(o.name);
        expect(text).not.toContain(o.visit);
      }
      expect(text).not.toContain('Léa');
      expect(text).not.toContain('@example.test');
    }
  });
});
