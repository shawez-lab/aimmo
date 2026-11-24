import { expect, it } from 'vitest';
import { FicheUnique, Modeles, RegistreMandats, SignaturePapier } from '../src/index.ts';
import { EspaceVendeur, SqlClientParties, SqlSourcesVendeur, type ClientViewer } from '../src/espaces/index.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { describeWithSqlite } from './sqlite.ts';
import { designerTout } from './designation-jeu.ts';

// Réseau, biens, vendeurs, visiteurs et acquéreurs inventés.
const H = 3_600_000;
let k = 0;

async function setup() {
  const t = await setupDossier();
  const parties = new SqlClientParties(t.db);
  const sources = new SqlSourcesVendeur(t.db, t.acces, t.journal, { now: t.now });
  const espace = new EspaceVendeur(sources, t.journal, { now: t.now });
  const viewer = async (personId: string): Promise<ClientViewer> => ({ kind: 'client', networkId: t.network.id, personId, sessionId: `s-${personId}`, sides: await parties.sidesOf(t.network.id, personId) });
  const visitor = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Bérénice', lastName: 'Visiteuse' });
  await t.store.addIdentifier({ networkId: t.network.id, agentId: t.alexId, personId: visitor.id, kind: 'email', value: 'berenice.visiteuse@example.test' });
  const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: visitor.id, kind: 'buy' });
  const iso = (ms: number) => new Date(ms).toISOString();
  /** Une visite du bien, avec son compte rendu ; rangée comme le font M05 et T06. */
  const visit = async (startAt: string, opinion: string | null, status: 'valide' | 'brouillon' = 'valide', personId = visitor.id, propertyId = t.propertyId) => {
    const id = `rdv-${++k}`;
    const start = Date.parse(startAt);
    await t.db.run(
      `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visite', ?, ?, 'honored', ?, 'agent', NULL, ?, ?)`,
      [id, t.network.id, t.alexId, personId, propertyId, iso(start), iso(start + H), `h-${id}`, iso(start - 48 * H), iso(start)],
    );
    await t.db.run('INSERT INTO visits (appointment_id, network_id, property_id, project_id, person_id, agent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, t.network.id, propertyId, project.id, personId, t.alexId, 'agent:test', iso(start - 48 * H)]);
    if (opinion !== null) {
      const report = JSON.stringify({ interest: 'fort', opinion, readyToOffer: false, reservations: ['cuisine à rafraîchir'], strengths: ['séjour lumineux'] });
      await t.db.run(
        `INSERT INTO visit_reports (appointment_id, network_id, dictation, report, source, status, validated_by, validated_at, delivery_status, delivery_rule, message_id, created_by, created_at, updated_at) VALUES (?, ?, 'dictée de test', ?, 'agent', ?, ?, ?, NULL, NULL, NULL, 'agent:test', ?, ?)`,
        [id, t.network.id, report, status, status === 'valide' ? 'agent:test' : null, status === 'valide' ? iso(start + 4 * H) : null, iso(start + H), iso(start + H)],
      );
    }
    return id;
  };
  /** Un point de la semaine, rangé comme le fait T07. */
  const point = async (week: string, status: 'valide' | 'prepare', opinions: string[] = ['séjour apprécié']) => {
    const figures = JSON.stringify({ week, views: 120, contacts: 3, visitsDone: 2, visitsPlanned: 1, opinions });
    await t.db.run(
      `INSERT INTO weekly_points (mandate_id, week, network_id, property_id, person_id, agent_id, figures, next_actions, status, validated_by, validated_at, delivery_status, delivery_rule, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      [t.mandateId, week, t.network.id, t.propertyId, t.personId, t.alexId, figures, status, status === 'valide' ? 'agent:test' : null, status === 'valide' ? `${week}T09:00:00.000Z` : null, `${week}T08:00:00.000Z`, `${week}T08:00:00.000Z`],
    );
  };
  return { ...t, parties, sources, espace, viewer, visitor, visit, point };
}

describeWithSqlite('EC08 · lecteurs SQL de l’espace du vendeur', () => {
  it('[R161] le mandant d’un mandat inscrit est vendeur ; l’acquéreur est acquéreur ; une fiche sans dossier ou un inconnu, rien', async () => {
    const t = await setup();
    expect(await t.parties.sidesOf(t.network.id, t.personId)).toEqual(['vendeur']);
    expect(await t.parties.sidesOf(t.network.id, t.buyerId)).toEqual(['acquereur']);
    // Une fiche sans visite, offre, recherche ni alerte n'a aucun côté.
    expect(await t.parties.sidesOf(t.network.id, t.visitor.id)).toEqual([]);
    expect(await t.parties.sidesOf(t.network.id, 'p-inconnue')).toEqual([]);
    // D'un autre réseau, la même personne n'a aucun côté.
    expect(await t.parties.sidesOf('autre-reseau', t.personId)).toEqual([]);
  });

  it('[R161] une fiche fusionnée compte pour la fiche gardée : le vendeur garde son espace après une fusion', async () => {
    const t = await setup();
    const kept = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Léa', lastName: 'Exemple' });
    await new FicheUnique(t.db, t.store, { now: t.now }).merge({ survivorId: kept.id, mergedId: t.personId, reason: 'identifiant commun' });
    expect(await t.parties.sidesOf(t.network.id, kept.id)).toEqual(['vendeur']);
    const v = await t.espace.vue(await t.viewer(kept.id));
    if (!v.ok) throw new Error(v.code);
    expect(v.value.map((b) => b.propertyId)).toEqual([t.propertyId]);
    expect(v.value[0]!.documents.map((d) => d.title)).toContain('Mandat de vente simple');
  });

  it('[R161] un mandat annulé au registre ne fait plus de la personne un vendeur, et ne montre plus rien', async () => {
    const t = await setup();
    const r = await new RegistreMandats(t.db, t.journal, { now: t.now }).cancel(t.direction, t.mandateId, 'termination');
    expect(r.ok).toBe(true);
    expect(await t.parties.sidesOf(t.network.id, t.personId)).toEqual([]);
    expect(await t.sources.sellerPropertiesOf(t.network.id, t.personId)).toEqual([]);
    expect(await t.sources.offersOf(t.network.id, t.propertyId, t.personId)).toEqual([]);
  });

  it('[R161] [R163] le vendeur voit son vrai dossier : prix du mandat, offre du registre avec son net, date d’acte et ce qui la tient', async () => {
    const t = await setup();
    const v = await t.espace.vue(await t.viewer(t.personId));
    if (!v.ok) throw new Error(v.code);
    expect(v.value).toHaveLength(1);
    const b = v.value[0]!;
    expect(b.propertyId).toBe(t.propertyId);
    expect(b.reference).toBe('REF-T-1');
    expect(b.city).toBe('Dijon');
    expect(b.price).toMatchObject({ value: 200000, source: 'mandat en vigueur' });
    expect(b.offers).toHaveLength(1);
    // Montant et net vendeur lus du tableau des offres (O06) : 205 000 €, moins 10 000 € d'honoraires du mandat.
    expect(b.offers[0]!.amount).toMatchObject({ value: 205000 });
    expect(b.offers[0]!.netSeller).toMatchObject({ value: 195000 });
    expect(b.offers[0]!.state).toMatchObject({ value: 'acceptée', at: '2027-03-01T11:00:00.000Z' });
    expect(b.offers[0]!.conditions).toMatchObject({ value: ['pret'] });
    // La date d'acte vient du chemin critique du dossier (N09), vue du vendeur, sans rien du financement de l'acquéreur.
    expect(b.deed.holds).toMatchObject({ source: 'échéancier du dossier' });
    const holds = b.deed.holds.value ?? [];
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.join(' ')).not.toMatch(/prêt|banque|apport/i);
    // Ni nom, ni coordonnée, ni financement de l'acquéreur, nulle part dans la vue.
    const json = JSON.stringify(v.value);
    expect(json).not.toContain('Acheteur');
    expect(json).not.toContain(t.buyerId);
    expect(json).not.toContain('150000');
    expect(json).not.toContain('70000');
  });

  it('[R161] [R06] les visites et leurs comptes rendus validés ; un compte rendu qui cite le visiteur est retenu, un brouillon n’est pas montré', async () => {
    const t = await setup();
    await t.visit('2027-02-20T14:00:00.000Z', 'Visite agréable, séjour apprécié.');
    await t.visit('2027-02-21T14:00:00.000Z', 'Bérénice a beaucoup aimé, écrire à berenice.visiteuse@example.test.');
    await t.visit('2027-02-22T14:00:00.000Z', 'Brouillon non relu.', 'brouillon');
    const v = await t.espace.vue(await t.viewer(t.personId));
    if (!v.ok) throw new Error(v.code);
    const visits = v.value[0]!.visits;
    expect(visits).toHaveLength(3);
    expect(visits[0]!.state).toMatchObject({ value: 'faite' });
    expect(visits[0]!.report).toMatchObject({ source: 'compte rendu validé par l’agent' });
    expect(String(visits[0]!.report.value)).toContain('Visite agréable');
    expect(visits[0]!.interest).toMatchObject({ value: 'fort' });
    expect(visits[1]!.report).toEqual({ value: null, label: 'non communiquée' });
    expect(visits[2]!.report).toEqual({ value: null, label: 'non communiquée' });
    const json = JSON.stringify(v.value);
    expect(json).not.toContain('Bérénice');
    expect(json).not.toContain('Visiteuse');
    expect(json).not.toContain('example.test');
    expect(json).not.toContain(t.visitor.id);
  });

  it('[R161] un visiteur connu est toujours rattaché, avec ce qui l’identifie, pour la retenue', async () => {
    const t = await setup();
    await t.visit('2027-02-20T14:00:00.000Z', 'Visite agréable.');
    const visits = await t.sources.visitsOf(t.network.id, t.propertyId, t.personId);
    expect(visits[0]!.visitor).toMatchObject({ personId: t.visitor.id, firstName: 'Bérénice', lastName: 'Visiteuse', emails: ['berenice.visiteuse@example.test'] });
    const offers = await t.sources.offersOf(t.network.id, t.propertyId, t.personId);
    expect(offers[0]!.buyer).toMatchObject({ personId: t.buyerId, firstName: 'Acheteur', lastName: 'Exemple' });
  });

  it('[R161] rien d’avant le premier mandat du vendeur sur le bien : ni visite d’un ancien propriétaire, ni offre', async () => {
    const t = await setup();
    // Une visite du bien un an avant le mandat (signé le 10 février 2027) : du temps d'un autre propriétaire.
    await t.visit('2026-02-10T14:00:00.000Z', 'Ancienne visite.');
    await t.visit('2027-02-20T14:00:00.000Z', 'Visite agréable.');
    const visits = await t.sources.visitsOf(t.network.id, t.propertyId, t.personId);
    expect(visits.map((x) => x.at)).toEqual(['2027-02-20T14:00:00.000Z']);
    // Pour une personne qui n'est pas mandante du bien, chaque lecteur ne rend rien.
    expect(await t.sources.visitsOf(t.network.id, t.propertyId, t.buyerId)).toEqual([]);
    expect(await t.sources.offersOf(t.network.id, t.propertyId, t.buyerId)).toEqual([]);
    expect(await t.sources.documentsOf(t.network.id, t.propertyId, t.buyerId)).toEqual([]);
    expect(await t.sources.weeklyPointsOf(t.network.id, t.propertyId, t.buyerId)).toEqual([]);
    expect(await t.sources.appointmentsOf(t.network.id, t.propertyId, t.buyerId)).toEqual([]);
    expect(await t.sources.earliestDeedOf(t.network.id, t.propertyId, t.buyerId)).toBeNull();
  });

  it('[R161] un ancien propriétaire ne voit rien de la vente suivante du même bien, ni le nouveau de l’ancienne', async () => {
    const t = await setup();
    // Le bien est revendu : un nouveau propriétaire signe à son tour un mandat, plus tard, sur le même bien.
    t.setClock(new Date('2027-09-01T12:00:00.000Z'));
    const next = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Nouveau', lastName: 'Propriétaire' });
    // Le mandat suivant, rangé comme le font M06 et le registre (D04) : les contrôles de signature sont testés ailleurs.
    await t.db.run(
      `INSERT INTO mandates (id, network_id, agent_id, person_id, project_id, property_id, signed_at, source_kind, source_detail, source_id, recorded_by, created_at) VALUES ('m-suivant', ?, ?, ?, NULL, ?, ?, 'referral', NULL, NULL, 'agent:test', ?)`,
      [t.network.id, t.alexId, next.id, t.propertyId, t.now().toISOString(), t.now().toISOString()],
    );
    const seq = Number((await t.db.first<{ n: number }>('SELECT MAX(seq) AS n FROM mandate_register WHERE network_id = ?', [t.network.id]))!.n) + 1;
    await t.db.run(
      `INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, cancels_seq, reason, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', 'm-suivant', 99, 'T-099', ?, ?, ?, NULL, NULL, ?, 'agent:test', 'x', 'h-suivant')`,
      [t.network.id, seq, t.alexId, t.propertyId, t.now().toISOString(), t.now().toISOString()],
    );
    t.setClock(new Date('2027-09-03T12:00:00.000Z'));
    await t.visit('2027-09-02T14:00:00.000Z', 'Visite de la revente.');
    const o = await t.offres.record(t.agent, t.propertyId, t.input({ amountEur: 260000, receivedAt: '2027-09-03T09:00:00.000Z', validUntil: '2027-09-12' }));
    if (!o.ok) throw new Error(o.code);
    // L'ancien propriétaire n'a plus de côté vendeur, ni le bien, ni rien de ses lecteurs.
    expect(await t.parties.sidesOf(t.network.id, t.personId)).toEqual([]);
    expect(await t.sources.sellerPropertiesOf(t.network.id, t.personId)).toEqual([]);
    expect(await t.sources.visitsOf(t.network.id, t.propertyId, t.personId)).toEqual([]);
    expect(await t.sources.offersOf(t.network.id, t.propertyId, t.personId)).toEqual([]);
    expect(await t.sources.earliestDeedOf(t.network.id, t.propertyId, t.personId)).toBeNull();
    // Le nouveau voit sa vente : la visite et l'offre d'après son mandat, rien de la vente d'avant.
    const v = await t.espace.vue(await t.viewer(next.id));
    if (!v.ok) throw new Error(v.code);
    expect(v.value[0]!.visits).toHaveLength(1);
    expect(v.value[0]!.offers.map((x) => x.amount.value)).toEqual([260000]);
    expect(v.value[0]!.documents).toEqual([]);
    expect(v.value[0]!.deed.date).toEqual({ value: null, label: 'non communiquée' });
  });

  it('[R161] [R96] un mandat rétracté après l’ouverture ne donne pas le dossier au mandant plus ancien', async () => {
    const t = await setup();
    const older = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Ancienne', lastName: 'Propriétaire' });
    const at = '2026-06-01T09:00:00.000Z';
    await t.db.run(
      `INSERT INTO mandates (id, network_id, agent_id, person_id, project_id, property_id, signed_at, source_kind, source_detail, source_id, recorded_by, created_at) VALUES ('m-ancien', ?, ?, ?, NULL, ?, ?, 'referral', NULL, NULL, 'agent:test', ?)`,
      [t.network.id, t.alexId, older.id, t.propertyId, at, at],
    );
    const seq = Number((await t.db.first<{ n: number }>('SELECT MAX(seq) AS n FROM mandate_register WHERE network_id = ?', [t.network.id]))!.n) + 1;
    await t.db.run(
      `INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, cancels_seq, reason, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', 'm-ancien', 98, 'T-098', ?, ?, ?, NULL, NULL, ?, 'agent:test', 'x', 'h-ancien')`,
      [t.network.id, seq, t.alexId, t.propertyId, at, at],
    );
    const later = t.now().toISOString();
    await t.db.run("INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, 'Lettre reçue', ?, 'test', ?)", [t.mandateId, t.network.id, later, later]);
    expect(await t.sources.earliestDeedOf(t.network.id, t.propertyId, older.id)).toBeNull();
    expect((await t.sources.documentsOf(t.network.id, t.propertyId, older.id)).map((d) => d.kind)).toEqual([]);
  });

  it('[R163] [R13] sans le tableau des offres, aucun chiffre n’est recomposé et l’échec va au journal', async () => {
    const t = await setup();
    // Un bien sans agent : le registre des offres refuse sa lecture.
    await t.db.run('UPDATE properties SET agent_id = NULL WHERE id = ?', [t.propertyId]);
    const offers = await t.sources.offersOf(t.network.id, t.propertyId, t.personId);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ amountEur: null, netSellerEur: null, validUntil: null, state: null, conditions: [] });
    const v = await t.espace.vue(await t.viewer(t.personId));
    if (!v.ok) throw new Error(v.code);
    expect(v.value[0]!.offers[0]!.amount).toEqual({ value: null, label: 'non communiquée' });
    const events = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'espaces.source_indisponible'");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.data).toContain('offres');
  });

  it('[R161] [R163] documents : le mandat signé, les pièces du vendeur ; jamais une pièce de l’acquéreur', async () => {
    const t = await setup();
    const titre = await t.pieces.add(t.agent, t.fileId, { piece: 'titre_propriete', ref: t.upload(), issuedOn: '2027-02-01' });
    expect(titre.ok).toBe(true);
    const fiche = await t.pieces.add(t.agent, t.fileId, { piece: 'fiche_renseignements_acquereur', ref: t.upload(), issuedOn: '2027-02-28' });
    expect(fiche.ok).toBe(true);
    const v = await t.espace.vue(await t.viewer(t.personId));
    if (!v.ok) throw new Error(v.code);
    const docs = v.value[0]!.documents;
    expect(docs.map((d) => d.title)).toEqual(['Mandat de vente simple', 'Titre de propriété']);
    expect(docs[0]!.signature).toMatchObject({ value: 'signé' });
    expect(docs[1]!.signature).toMatchObject({ value: 'pas à signer', source: 'dossier de vente' });
    expect(JSON.stringify(v.value)).not.toMatch(/acquéreur remplie|renseignements de l/);
  });

  it('[R161] [R53] points de la semaine : seuls les validés, avec le texte du module ; un avis qui cite le visiteur retient le point', async () => {
    const t = await setup();
    // Bérénice a visité le bien : elle est une personne venue pour le bien, que l'espace retient [R161].
    await t.visit('2027-02-20T14:00:00.000Z', null);
    await t.point('2027-02-15', 'valide');
    await t.point('2027-02-22', 'prepare');
    await t.point('2027-03-01', 'valide', ['Bérénice a aimé le séjour']);
    const v = await t.espace.vue(await t.viewer(t.personId));
    if (!v.ok) throw new Error(v.code);
    const points = v.value[0]!.weeklyPoints;
    expect(points.map((p) => p.weekOf.value)).toEqual(['2027-03-01', '2027-02-15']);
    expect(points[0]!.text).toEqual({ value: null, label: 'non communiquée' });
    expect(String(points[1]!.text.value)).toContain('voici le point de la semaine du 15/02 au 21/02');
    expect(JSON.stringify(v.value)).not.toContain('Bérénice');
  });

  it('[R161] parcours de 5 vendeurs sur une vraie base : chacun voit son bien et son offre, rien d’un autre client', async () => {
    const t = await setup();
    const modeles = new Modeles(t.db, t.acces, t.journal, { now: t.now });
    const signature = new SignaturePapier(t.db, t.acces, t.journal, { now: t.now });
    const sellers: { personId: string; propertyId: string; reference: string; buyer: string }[] = [{ personId: t.personId, propertyId: t.propertyId, reference: 'REF-T-1', buyer: 'Acheteur' }];
    for (let i = 2; i <= 5; i++) {
      const seller = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: `Vendeur${i}`, lastName: `Inventé${i}` });
      const property = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: `REF-T-${i}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 50 + i, rooms: 3, priceEur: 150000 + i * 1000 });
      const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: seller.id, kind: 'sell' });
      await t.store.linkProjectProperty({ networkId: t.network.id, agentId: t.alexId, projectId: project.id, propertyId: property.id, role: 'owned' });
      await identiteAuCoffre({ db: t.db, acces: t.acces, journal: t.journal, now: t.now }, t.agent, seller.id, { piece: 'carte_identite', seenAt: t.now() });
      await designerTout(t.db);
      const d = await modeles.generate(t.agent, { kind: 'mandat_vente_simple', personId: seller.id, propertyId: property.id, inputs: { 'honoraires.montant': 8000, 'honoraires.charge': 'acquereur', 'mandat.duree_mois': 12 } });
      if (!d.ok) throw new Error(d.code);
      const s = await signature.register(t.agent, d.document.id, { signedAt: t.now(), place: 'agence', scanRef: `scans/mandat-${i}.pdf`, source: 'referral' });
      if (!s.ok) throw new Error(s.code);
      sellers.push({ personId: seller.id, propertyId: property.id, reference: `REF-T-${i}`, buyer: `Acquéreur${i}` });
    }
    t.setClock(new Date('2027-03-02T12:00:00.000Z'));
    for (const s of sellers.slice(1)) {
      const i = Number(s.reference.slice(-1));
      const property = { id: s.propertyId };
      const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: `Acquéreur${i}`, lastName: `Fictif${i}` });
      const o = await t.offres.record(t.agent, property.id, t.input({ buyerPersonId: buyer.id, amountEur: 140000 + i * 1000, receivedAt: '2027-03-02T09:00:00.000Z', validUntil: '2027-03-12' }));
      if (!o.ok) throw new Error(o.code);
    }
    for (const s of sellers) {
      const viewer = await t.viewer(s.personId);
      expect(viewer.sides).toEqual(['vendeur']);
      const v = await t.espace.vue(viewer);
      if (!v.ok) throw new Error(v.code);
      expect(v.value.map((b) => b.propertyId)).toEqual([s.propertyId]);
      expect(v.value[0]!.offers).toHaveLength(1);
      const json = JSON.stringify(v.value);
      for (const other of sellers) {
        expect(json).not.toContain(other.buyer);
        if (other === s) continue;
        expect(json).not.toContain(other.reference);
        expect(json).not.toContain(other.personId);
        // Le bien d'un autre vendeur est refusé, sans rien dire de lui.
        expect(await t.espace.bien(viewer, other.propertyId)).toEqual({ ok: false, rule: 'R161', code: 'not_party' });
      }
    }
  });

  it('[R13] la lecture d’un espace laisse au journal des identifiants et des nombres, jamais un nom', async () => {
    const t = await setup();
    await t.visit('2027-02-20T14:00:00.000Z', 'Visite agréable.');
    await t.espace.vue(await t.viewer(t.personId));
    const rows = await t.db.all<{ data: string }>('SELECT data FROM journal');
    const all = rows.map((r) => r.data).join('\n');
    expect(all).not.toContain('Bérénice');
    expect(all).not.toContain('Acheteur');
    expect(all).not.toContain('example.test');
  });
});
