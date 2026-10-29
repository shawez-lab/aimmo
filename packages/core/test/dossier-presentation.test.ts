import { expect, it } from 'vitest';
import { Acces, DossierPresentation, FicheClient, FicheUnique, Mandats, SqlJournalStore, applyMigrations, fromSyncSqlite, promisesSomething, renderDossier, type SqlDatabase } from '../src/index.ts';
import { htmlProblems } from '../src/design/audit.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un journal inventé : visites, comptes rendus, points de la semaine, avis et ventes de test.
const NOW = Date.parse('2027-10-12T08:00:00.000Z');
const H = 3_600_000;
const DAY = 24 * H;
const iso = (t: number) => new Date(t).toISOString();

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(NOW);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const dossier = new DossierPresentation(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  const agent = (id = alex.id) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Camille', lastName: 'Vendeuse' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: owner.id, kind: 'sell' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 90, rooms: 4, priceEur: 260000 });
  let k = 0;
  const appointment = async (kind: string, endAt: number, agentId = alex.id, status = 'honored') => {
    const id = `rdv-${++k}`;
    await db.run(
      `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', NULL, ?, ?)`,
      [id, network.id, agentId, owner.id, property.id, kind, iso(endAt - H), iso(endAt), status, `h-${k}`, iso(endAt - 2 * DAY), iso(endAt - 2 * DAY)],
    );
    return id;
  };
  const visit = async (endAt: number, report: 'valide' | 'brouillon' | null, validatedAfterH: number | null, agentId = alex.id) => {
    const id = await appointment('visite', endAt, agentId);
    await db.run('INSERT INTO visits (appointment_id, network_id, property_id, project_id, person_id, agent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, network.id, property.id, project.id, owner.id, agentId, 'agent:test', iso(endAt - 2 * DAY)]);
    if (report) {
      const v = validatedAfterH === null ? null : iso(endAt + validatedAfterH * H);
      await db.run(
        `INSERT INTO visit_reports (appointment_id, network_id, dictation, report, source, status, validated_by, validated_at, delivery_status, delivery_rule, message_id, created_by, created_at, updated_at) VALUES (?, ?, 'dictée de test', NULL, 'agent', ?, ?, ?, NULL, NULL, NULL, 'agent:test', ?, ?)`,
        [id, network.id, report, report === 'valide' ? 'agent:test' : null, report === 'valide' ? v : null, iso(endAt), iso(endAt)],
      );
    }
  };
  const mandate = await new Mandats(db, fiche, journal, { now }).record(acces, agent(), { personId: owner.id, propertyId: property.id, signedAt: new Date(NOW - 100 * DAY), source: 'site' });
  if (!mandate.ok) throw new Error(mandate.code);
  const point = async (week: string, createdAt: number, status: 'valide' | 'prepare', validatedAfterH: number | null) => {
    await db.run(
      `INSERT INTO weekly_points (mandate_id, week, network_id, property_id, person_id, agent_id, figures, next_actions, status, validated_by, validated_at, delivery_status, delivery_rule, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      [mandate.id, week, network.id, property.id, owner.id, alex.id, status, status === 'valide' ? 'agent:test' : null, status === 'valide' && validatedAfterH !== null ? iso(createdAt + validatedAfterH * H) : null, iso(createdAt), iso(createdAt)],
    );
  };
  return { db, journal, store, dossier, network, alex, sam, agent, dir, owner, property, appointment, visit, point };
}

describeWithSqlite('G07 · dossier de présentation pour chaque rendez-vous de mandat (Jamais vu)', () => {
  it('[R141] Jamais vu : chaque engagement avec le taux réellement tenu, égal au calcul fait à la main, et sa preuve', async () => {
    const t = await setup();
    // La direction a rangé ses engagements il y a plus d'un an.
    const before = new DossierPresentation(t.db, t.journal, { now: () => new Date(NOW - 400 * DAY) });
    expect(await before.setCommitment(t.dir, { code: 'compte_rendu', label: 'Un compte rendu après chaque visite', measure: 'compte_rendu_visite', delayHours: 24, active: true })).toEqual({ ok: true, value: { version: 1 } });
    expect(await before.setCommitment(t.dir, { code: 'point_semaine', label: 'Un point chaque semaine au vendeur', measure: 'point_semaine', delayHours: 48, active: true })).toMatchObject({ ok: true });
    // Visites d'Alex sous la version 1 (24 h) : tenue (10 h), en retard (30 h), brouillon, sans compte rendu,
    // restée « réservée » et jamais ouverte, sans compte rendu (elle compte quand même), tenue (23 h) : 2 sur 6.
    await t.visit(NOW - 200 * DAY, 'valide', 10);
    await t.visit(NOW - 150 * DAY, 'valide', 30);
    await t.visit(NOW - 100 * DAY, 'brouillon', null);
    await t.visit(NOW - 50 * DAY, null, null);
    const booked = await t.appointment('visite', NOW - 30 * DAY, t.alex.id, 'booked');
    // Elle n'a jamais été ouverte (rendez-vous décalé) : pas de ligne de visite, elle compte quand même.
    expect(booked).toEqual(expect.any(String));
    await t.visit(NOW - 10 * DAY, 'valide', 23);
    // Hors du compte : plus d'un an, une visite de Sam, une visite finie il y a 2 h dont le délai court encore.
    await t.visit(NOW - 400 * DAY, 'valide', 1);
    await t.visit(NOW - 20 * DAY, null, null, t.sam.id);
    await t.visit(NOW - 2 * H, null, null);
    // Points de la semaine : validé en 1 h, en 50 h, jamais validé : 1 sur 3.
    await t.point('2027-W30', NOW - 80 * DAY, 'valide', 1);
    await t.point('2027-W31', NOW - 73 * DAY, 'valide', 50);
    await t.point('2027-W32', NOW - 66 * DAY, 'prepare', null);
    const rdv = await t.appointment('estimation', NOW + 2 * DAY, t.alex.id, 'booked');
    const d = await t.dossier.build(t.agent(), rdv);
    if (!d.ok) throw new Error(d.code);
    const cr = d.value.commitments.find((c) => c.code === 'compte_rendu')!;
    expect([cr.kept, cr.total, cr.rate]).toEqual([2, 6, 2 / 6]);
    expect(cr.proof.map((p) => p.kept)).toEqual([true, false, false, false, false, true]);
    const ps = d.value.commitments.find((c) => c.code === 'point_semaine')!;
    expect([ps.kept, ps.total, ps.rate]).toEqual([1, 3, 1 / 3]);
    // Une version 2 à 36 h, il y a 5 jours : elle ne juge que les cas d'après elle ; le passé garde la version 1.
    const recent = new DossierPresentation(t.db, t.journal, { now: () => new Date(NOW - 5 * DAY) });
    expect(await recent.setCommitment(t.dir, { code: 'compte_rendu', label: 'Un compte rendu après chaque visite', measure: 'compte_rendu_visite', delayHours: 36, active: true })).toEqual({ ok: true, value: { version: 2 } });
    await t.visit(NOW - 3 * DAY, 'valide', 30);
    await t.dossier.setCommitment(t.dir, { code: 'point_semaine', label: 'Un point chaque semaine au vendeur', measure: 'point_semaine', delayHours: 48, active: false });
    const again = await t.dossier.build(t.agent(), rdv);
    expect(again.ok && again.value.commitments.map((c) => [c.code, c.version, c.kept, c.total])).toEqual([['compte_rendu', 2, 3, 7]]);
    const html = renderDossier(again.ok ? again.value : d.value, 'Alex Essai');
    expect(html).toContain('Tenu 3 fois sur 7, soit 43 %');
    // La preuve est visible à l'écran comme à l'impression.
    expect(html).not.toContain('<details');
    expect(html.match(/<ul class="preuve">/g)).toHaveLength(1);
    expect(htmlProblems(html)).toEqual([]);
  });

  it('[R141] chaque nombre vient de la base avec sa source ; tous les avis de la période, jamais choisis ni réécrits', async () => {
    const t = await setup();
    await t.db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at, validated_by, validated_at) VALUES ('v1', ?, ?, ?, 'validated', ?, 240000, 270000, 'Avis', 'fallback', ?, ?, 'agent:test', ?)`,
      [
        t.network.id,
        t.property.id,
        t.alex.id,
        JSON.stringify({ cited: [{ month: '2027-03', surface: 85, pricePerM2: 2900, distance: 212, street: 'rue des Voisins Essai', town: 'Dijon' }], latestUsedSale: '2027-03', data: { source: 'DVF test', recentMissing: true } }),
        iso(NOW - 5 * DAY),
        iso(NOW - 5 * DAY),
        iso(NOW - 5 * DAY),
      ],
    );
    for (const [file, score, ago, comment] of [['f1', 5, 300, 'Merci à Alex pour la vente rue des Voisins'], ['f2', 2, 100, null], ['f3', 4, 10, 'Très bien'], ['f4', 5, 500, null]] as const) {
      await t.db.run('INSERT INTO satisfaction_answers (file_id, person_id, network_id, agent_id, score, comment, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [file, `p-${file}`, t.network.id, t.alex.id, score, comment, iso(NOW - ago * DAY)]);
    }
    // Deux actes rangés aujourd'hui : l'un signé il y a 100 jours (compté), l'autre il y a 400 jours (hors période).
    await t.db.exec('PRAGMA foreign_keys = OFF');
    for (const [file, ago] of [['s1', 100], ['s2', 400]] as const) {
      const signed = new Date(NOW - ago * DAY).toISOString().slice(0, 10);
      await t.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, ?, 'preuves/test.pdf', 'a_demarrer', ?, 'agent:test')", [file, t.network.id, signed, iso(NOW - DAY)]);
      await t.db.run("INSERT INTO sale_commissions (file_id, network_id, mandate_id, agent_id, fee_eur, fee_charge, due_on, status, created_at) VALUES (?, ?, 'm', ?, 1000, 'vendeur', ?, 'due', ?)", [file, t.network.id, t.alex.id, signed, iso(NOW - DAY)]);
    }
    await t.db.exec('PRAGMA foreign_keys = ON');
    const rdv = await t.appointment('estimation', NOW + DAY, t.alex.id, 'booked');
    const d = await t.dossier.build(t.agent(), rdv);
    if (!d.ok) throw new Error(d.code);
    expect(d.value.sales).toEqual({ source: 'DVF test', latestUsedSale: '2027-03', recentMissing: true, dvfNotCovered: false, validatedOn: '2027-10-07', items: [{ month: '2027-03', surfaceM2: 85, pricePerM2: 2900, distanceM: 200 }] });
    // La date des données est dite entière : les ventes récentes manquent encore [R28].
    expect(renderDossier(d.value, 'Alex Essai')).toContain('Les ventes les plus récentes ne sont pas encore publiées.');
    // Tous les avis des 12 derniers mois, la mauvaise note comprise, dans l'ordre des dates ; jamais le commentaire.
    expect(d.value.reviews).toMatchObject({ count: 3, average: 3.7, answers: [{ score: 5 }, { score: 2 }, { score: 4 }] });
    expect(d.value.results).toMatchObject({ mandates: 1, sales: 1, estimationsHonored: 0 });
    for (const section of [d.value.sales!, d.value.reviews, d.value.results]) expect(section.source).toEqual(expect.any(String));
    // Rien qui situe un autre client : ni rue, ni commentaire, ni personne [R46, R13].
    const all = JSON.stringify(d.value) + renderDossier(d.value, 'Alex Essai');
    expect(all).not.toMatch(/Voisins|Merci|Très bien|p-f|Camille/);
  });

  it('[R141] aucune promesse de prix ni de délai : liste fermée de tournures, refusées dans les engagements et dans le texte de l’IA', async () => {
    const t = await setup();
    for (const label of ['Vente garantie en moins de trois mois', 'Nous vendrons au meilleur prix', 'Votre bien vendu en un mois', 'Compte rendu sous 24 h', 'Prix assuré', 'Votre bien vendu dans le mois', 'Une vente en quelques semaines', 'Votre bien trouvera preneur sous un mois', 'Le prix le plus haut du quartier', 'Vendre vite et bien', 'Votre bien sera vendu dans deux semaines', 'Une vente sous trois mois', 'Vendu en quelques jours']) {
      expect(await t.dossier.setCommitment(t.dir, { code: 'essai', label, measure: 'point_semaine', delayHours: 24, active: true }), label).toEqual({ ok: false, rule: 'R141', code: 'promise' });
    }
    expect(promisesSomething('Un compte rendu après chaque visite')).toBe(false);
    const withAi = new DossierPresentation(t.db, t.journal, { now: () => new Date(NOW), drafter: { welcome: async () => 'Je vous garantis une vente rapide au meilleur prix.' } });
    const rdv = await t.appointment('estimation', NOW + DAY, t.alex.id, 'booked');
    const d = await withAi.build(t.agent(), rdv);
    expect(d.ok && [d.value.welcomeBy, d.value.welcome]).toEqual(['code', 'Voici, pour notre rendez-vous, ce que je vous propose et ce que j’ai réellement tenu pour mes clients.']);
    expect((await t.journal.all()).filter((e) => e.type === 'dossier_presentation.ia_refusee')).toHaveLength(1);
  });

  it('[R16] seul l’agent du rendez-vous ouvre son dossier ; seule la direction range les engagements', async () => {
    const t = await setup();
    const rdv = await t.appointment('estimation', NOW + DAY, t.alex.id, 'booked');
    expect(await t.dossier.build(t.agent(t.sam.id), rdv)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.dossier.build(t.dir, rdv)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.dossier.setCommitment(t.agent(), { code: 'x', label: 'Un point chaque semaine', measure: 'point_semaine', delayHours: 24, active: true })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const visite = await t.appointment('visite', NOW + DAY, t.alex.id, 'booked');
    expect(await t.dossier.build(t.agent(), visite)).toEqual({ ok: false, rule: null, code: 'not_a_mandate_appointment' });
    // Le jour de son départ, dès minuit, même avant le passage du planificateur : plus aucun dossier [R86].
    await t.db.run("INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('dep1', ?, ?, '2027-09-12', '2027-10-12', 'demission_agent', 1, 'direction:dir-1', '2027-09-12T08:00:00.000Z')", [t.network.id, t.alex.id]);
    expect((await t.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ?', [t.alex.id]))!.status).toBe('active');
    expect(await t.dossier.build(t.agent(), rdv)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    await expect(t.db.run("INSERT INTO service_commitments (id, network_id, code, version, label, measure, delay_hours, active, set_by, set_at) VALUES ('c', ?, 'auto', 1, 'Engagement automatique', 'point_semaine', 24, 1, 'system:x', '2027-10-01')", [t.network.id])).rejects.toThrow();
  });
});
