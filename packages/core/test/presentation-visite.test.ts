import { describe, expect, it } from 'vitest';
import {
  Acces,
  ComptesRendus,
  FicheClient,
  FicheUnique,
  RendezVous,
  SELLER_UPDATE_PURPOSE,
  SqlJournalStore,
  Visites,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
} from '../src/index.ts';
import { euros } from '../src/annonces/mentions.ts';
import type { PublishedListing } from '../src/attirer/referencement.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../src/design/audit.ts';
import { shotPlan } from '../src/hors-ligne/cadrage.ts';
import {
  checkRatings,
  confidentialIn,
  interestOf,
  ModePresentation,
  PRESENTATION_MAX_MATCHES,
  renderPresentation,
  reportFromRatings,
  type RoomRatings,
} from '../src/presentation/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, vendeurs, acquéreurs et biens inventés.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const HOUR = 3_600_000;
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const TEMPLATE = 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.';
const mentionsOf = (price: number): string =>
  `Prix : ${euros(price)} honoraires inclus, à la charge de l'acquéreur, soit 4,5 % TTC du prix hors honoraires.\nClasse énergie D, classe climat C.\nCarte professionnelle n° CPI 2101 2027 000 000 001.`;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const rdv = new RendezVous(db, journal, { now });
  const blocked = new Set<string>();
  const diffusion = { canDiffuse: async (_n: string, propertyId: string) => (blocked.has(propertyId) ? { allowed: false, reason: 'mandate_expired' } : { allowed: true, reason: 'allowed' }) };
  const visites = new Visites(db, journal, acces, { diffusion, rendezVous: rdv, now });
  const comptes = new ComptesRendus(db, journal, visites, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction', userId: string) => ({ role, userId, networkId: network.id });
  await rdv.setAvailability(as('agent', alex.id), WEEK);
  await visites.createSlipTemplate(as('direction', 'd1'), TEMPLATE);
  const listings: PublishedListing[] = [];
  let mandates = 0;
  /** Un bien de Sam, son vendeur avec son mail et son accord, son mandat inscrit, et son annonce publiée. */
  const property = async (o: { reference: string; city: string; price: number; surface: number; rooms: number; seller: [string, string]; title?: string; state?: 'en_vente' | 'sous_offre'; status?: 'available' | 'sold'; published?: boolean }) => {
    const seller = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: o.seller[0], lastName: o.seller[1] });
    await store.addIdentifier({ networkId: network.id, personId: seller.id, kind: 'email', value: `${o.seller[0].toLowerCase()}@example.test` });
    await store.addIdentifier({ networkId: network.id, personId: seller.id, kind: 'phone', value: '+33611223344' });
    await store.addConsent({ networkId: network.id, personId: seller.id, purpose: SELLER_UPDATE_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date(MONDAY_9H - 10 * 24 * HOUR) });
    const p = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: o.reference, kind: 'home', city: o.city, priceEur: o.price, surfaceM2: o.surface, rooms: o.rooms, status: o.status ?? 'available' });
    mandates += 1;
    const signed = new Date(MONDAY_9H - 20 * 24 * HOUR).toISOString();
    await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'site', 'test', ?)", [
      `m${mandates}`,
      network.id,
      sam.id,
      seller.id,
      p.id,
      signed,
      signed,
    ]);
    await db.run(
      "INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', ?, ?, ?, ?, ?, ?, ?, 'test', 'p', ?)",
      [network.id, mandates, `m${mandates}`, 4700 + mandates, `MAND-4${700 + mandates}`, sam.id, p.id, signed, signed, `h-m${mandates}`],
    );
    if (o.published !== false)
      listings.push({
        propertyId: p.id,
        agentId: sam.id,
        city: o.city,
        state: o.state ?? 'en_vente',
        versionId: `v-${o.reference}`,
        title: o.title ?? `Maison de ${o.rooms} pièces à ${o.city}`,
        priceEur: o.price,
        day: '2026-12-01',
        mentions: mentionsOf(o.price),
        photo: { ref: `biens/${p.id}/photo.jpg`, overlay: null },
        propertyStatus: o.status ?? 'available',
      });
    return { property: p, seller };
  };
  const b1 = await property({ reference: 'B1', city: 'Talant', price: 250_000, surface: 90, rooms: 4, seller: ['Victor', 'Vendeur'] });
  const b2 = await property({ reference: 'B2', city: 'Dijon', price: 280_000, surface: 95, rooms: 5, seller: ['Odile', 'Proprio'] });
  const b3 = await property({ reference: 'B3', city: 'Dijon', price: 520_000, surface: 150, rooms: 6, seller: ['Gaston', 'Cher'] });
  const b4 = await property({ reference: 'B4', city: 'Dijon', price: 240_000, surface: 85, rooms: 4, seller: ['Lucie', 'Vendue'], status: 'sold' });
  const b5 = await property({ reference: 'B5', city: 'Talant', price: 260_000, surface: 88, rooms: 4, seller: ['Paul', 'Offre'], state: 'sous_offre' });
  const mode = new ModePresentation(db, acces, journal, visites, { now, listings: { published: async () => listings.map((l) => ({ ...l })) }, diffusion, comptesRendus: comptes });
  let n = 0;
  /** Un acquéreur inventé d'Alex, sa recherche, et sa visite du bien. */
  const visit = async (propertyId = b1.property.id, firstName = 'Inès', lastName = 'Durand') => {
    n += 1;
    const buyer = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, lastName });
    await store.addIdentifier({ networkId: network.id, personId: buyer.id, kind: 'email', value: `acheteur${n}@example.test` });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: buyer.id, kind: 'buy' });
    await db.run(
      `INSERT INTO buyer_searches (id, network_id, project_id, person_id, version, property_kinds, communes, surface_min_m2, budget_max_eur, origin, created_at)
       VALUES (?, ?, ?, ?, 1, '["house"]', '["Talant","Dijon"]', 70, 300000, ?, ?)`,
      [`s-${n}`, network.id, project.id, buyer.id, `agent:${alex.id}`, new Date(MONDAY_9H - HOUR).toISOString()],
    );
    const r = await visites.schedule(as('agent', alex.id), { propertyId, projectId: project.id, start: new Date(MONDAY_9H + 24 * HOUR + n * 90 * 60_000) });
    if (!r.ok) throw new Error(r.code);
    return { id: r.visit.appointment.id, start: Date.parse(r.visit.appointment.start_at), end: Date.parse(r.visit.appointment.end_at), project, buyer };
  };
  const toSeller = (personId: string) => db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at', [personId]);
  return { db, journal, mode, comptes, listings, blocked, network, alex, sam, as, visit, toSeller, b1, b2, b3, b4, b5, store, setClock: (t: number) => (clock = t) };
}

const ROOMS = shotPlan('home', 4);
const all = (v: 'aime' | 'moyen' | 'non'): RoomRatings => Object.fromEntries(ROOMS.map((r) => [r.key, v]));

describe('HX13 · notes et compte rendu, par le code seul', () => {
  it('[R280] chaque pièce de la liste, et elle seule, avec une note de la liste fermée', () => {
    expect(checkRatings(ROOMS, all('aime'))).toMatchObject({ ok: true });
    const { sejour: _s, ...missing } = all('aime');
    expect(checkRatings(ROOMS, missing)).toEqual({ ok: false, code: 'missing_room' });
    expect(checkRatings(ROOMS, { ...all('aime'), cave: 'aime' })).toEqual({ ok: false, code: 'unknown_room' });
    expect(checkRatings(ROOMS, { ...all('aime'), sejour: 'adore' })).toEqual({ ok: false, code: 'bad_verdict' });
    expect(checkRatings(ROOMS, [])).toEqual({ ok: false, code: 'bad_ratings' });
    expect(checkRatings(ROOMS, null)).toEqual({ ok: false, code: 'bad_ratings' });
  });

  it('[R281] l’intérêt suit une règle écrite : deux tiers aimées sans pièce rejetée, fort ; aucune aimée, aucun', () => {
    expect(interestOf(all('aime'))).toBe('fort');
    expect(interestOf(all('non'))).toBe('aucun');
    expect(interestOf(all('moyen'))).toBe('aucun');
    expect(interestOf({ ...all('aime'), cuisine: 'non' })).toBe('moyen');
    expect(interestOf({ ...all('non'), sejour: 'aime' })).toBe('faible');
    // 5 aimées sur 8, aucune rejetée : moins des deux tiers, moyen.
    expect(interestOf({ ...all('aime'), facade: 'moyen', cuisine: 'moyen', exterieur: 'moyen' })).toBe('moyen');
  });

  it('[R281] le compte rendu ne dit que les notes, jamais une offre', () => {
    const r = reportFromRatings(ROOMS, { ...all('moyen'), sejour: 'aime', exterieur: 'aime', cuisine: 'non' });
    expect(r.strengths).toEqual(['Séjour', 'Jardin, balcon ou vue']);
    expect(r.reservations).toEqual(['Cuisine']);
    expect(r.readyToOffer).toBe(false);
    expect(r.interest).toBe('moyen');
    expect(r.opinion).toContain('Avis moyen sur : Façade ou entrée, Chambre 1');
    expect(reportFromRatings(ROOMS, all('aime')).readyToOffer).toBe(false);
  });

  it('[R279] la relecture trouve un nom, une coordonnée ou une note du dossier, accents et casse ignorés', () => {
    expect(confidentialIn('<p>Maison de M. VENDEUR</p>', { names: ['Vendeur'], values: [] })).toEqual(['vendeur']);
    expect(confidentialIn('<p>Écrire à victor@example.test</p>', { names: [], values: ['victor@example.test'] })).toEqual(['victor@example.test']);
    expect(confidentialIn('<p>Appeler le 06 11 22 33 44</p>', { names: [], values: ['0611223344'] })).toEqual(['0611223344']);
    expect(confidentialIn('<h2>Maison de Victor.</h2>', { names: ['Victor'], values: [] })).toEqual(['victor']);
    expect(confidentialIn('<h2>Chez Marc-Victor</h2>', { names: ['Victor'], values: [] })).toEqual(['victor']);
    expect(confidentialIn('<h2>Chez Marc</h2>', { names: ['Marc-Victor'], values: [] })).toEqual(['marc']);
    expect(confidentialIn('<h2>Vendeur d&#39;accord à 230 000</h2>', { names: [], values: ["Vendeur d'accord à 230 000"] })).toEqual(["vendeur d'accord a 230 000"]);
    expect(confidentialIn('<img alt="Victor">', { names: ['Victor'], values: [] })).toEqual(['victor']);
    expect(confidentialIn('<p>Maison de 4 pièces</p>', { names: ['Inès Durand'], values: ['acheteur1@example.test'] })).toEqual([]);
  });
});

describe('HX13 · poids de la page', () => {
  it('[R201] la page pleine tient dans le budget d’une page publique et passe l’audit du système', () => {
    const p = (i: number) => ({ propertyId: `p${i}`, reference: `REF-${i}`, title: `Maison de 5 pièces avec jardin à Fontaine-lès-Dijon ${i}`, priceEur: 300_000 + i, mentions: mentionsOf(300_000 + i), photo: { ref: `biens/p${i}/a.jpg`, overlay: i % 2 ? 'Aménagement virtuel' : null } });
    const html = renderPresentation({
      visited: p(0),
      rooms: shotPlan('home', 7),
      matches: Array.from({ length: PRESENTATION_MAX_MATCHES }, (_, i) => ({ ...p(i + 1), reasons: ['Dans votre budget', 'Dans une commune que vous cherchez'] })),
      action: '/app/visites/a1/presentation/notes',
    });
    expect(htmlProblems(html)).toEqual([]);
    expect(budgetProblems({ html }, BUDGETS.page)).toEqual([]);
  });
});

describeWithSqlite('HX13 · mode présentation pendant la visite', () => {
  it('[R279] le bien visité et les biens qui répondent à la recherche, sans vendeur, mandat, note ni coordonnée', async () => {
    const t = await setup();
    const v = await t.visit();
    await t.db.run("INSERT INTO visit_field_notes (id, network_id, appointment_id, agent_id, shot, body, written_at, received_at) VALUES ('n1', ?, ?, ?, NULL, 'Vendeur pressé, accepterait 230 000', ?, ?)", [
      t.network.id,
      v.id,
      t.alex.id,
      new Date(v.start).toISOString(),
      new Date(v.start).toISOString(),
    ]);
    t.setClock(v.start + 10 * 60_000);
    const r = await t.mode.open(t.as('agent', t.alex.id), v.id);
    if (!r.ok) throw new Error(r.code);
    const { html, visited, matches, rooms } = r.presentation;
    expect(visited.reference).toBe('B1');
    expect(rooms.map((x) => x.key)).toEqual(ROOMS.map((x) => x.key));
    // B2 répond ; B3 est hors budget ; B4 est vendu ; B5 est sous offre : seul B2 est proposé.
    expect(matches.map((m) => m.reference)).toEqual(['B2']);
    expect(matches[0]!.reasons).toContain('Dans votre budget');
    expect(matches[0]!.reasons.join(' ')).not.toMatch(/\d/);
    expect(Object.keys(visited).sort()).toEqual(['mentions', 'photo', 'priceEur', 'propertyId', 'reference', 'title']);
    // Rien du dossier de l'agence : vendeurs, coordonnées, numéros de mandat, notes, acquéreur.
    for (const secret of ['Victor', 'Vendeur', 'Odile', 'Proprio', 'victor@', 'odile@', '+33611223344', '06 11 22 33 44', 'MAND-4', '230 000', 'pressé', 'Inès', 'Durand', 'acheteur1@', 'Sam', 'Alex']) {
      expect(html).not.toContain(secret);
    }
    expect(html).not.toMatch(/mandat|commission|vendeur/i);
    expect(htmlProblems(html)).toEqual([]);
    const events = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'presentation.ouverte'");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).not.toMatch(/Inès|Durand|Victor/);
  });

  it('[R279] une annonce qui trahirait un nom du dossier : le bien visité n’est pas montré, un bien proposé est retiré', async () => {
    const t = await setup();
    const v = await t.visit();
    t.setClock(v.start);
    t.listings.find((l) => l.propertyId === t.b2.property.id)!.title = 'Maison de 5 pièces, famille Proprio';
    const r = await t.mode.open(t.as('agent', t.alex.id), v.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.presentation.matches).toEqual([]);
    expect(r.presentation.leftOut).toEqual([{ propertyId: t.b2.property.id, reason: 'confidentiel' }]);
    expect(r.presentation.html).not.toContain('Proprio');
    t.listings.find((l) => l.propertyId === t.b1.property.id)!.title = 'Maison de 4 pièces de Victor.';
    expect(await t.mode.open(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: 'R279', code: 'confidential' });
    // Un bien proposé qui trahirait le vendeur du bien visité est retiré lui aussi.
    t.listings.find((l) => l.propertyId === t.b1.property.id)!.title = 'Maison de 4 pièces à Talant';
    t.listings.find((l) => l.propertyId === t.b2.property.id)!.title = 'Maison de Victor';
    const cross = await t.mode.open(t.as('agent', t.alex.id), v.id);
    expect(cross.ok && cross.presentation.leftOut).toEqual([{ propertyId: t.b2.property.id, reason: 'confidentiel' }]);
    expect(cross.ok && cross.presentation.html).not.toContain('Victor');
    // Le nom de l'acquéreur lui-même ne s'affiche pas non plus.
    t.listings.find((l) => l.propertyId === t.b1.property.id)!.title = 'Maison de 4 pièces pour Durand';
    expect(await t.mode.open(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: 'R279', code: 'confidential' });
  });

  it('[R279] [R42] un bien visité ni publié ni diffusable n’est pas présenté ; un bien proposé non diffusable non plus', async () => {
    const t = await setup();
    const v = await t.visit();
    t.blocked.add(t.b2.property.id);
    const r = await t.mode.open(t.as('agent', t.alex.id), v.id);
    expect(r.ok && r.presentation.matches).toEqual([]);
    t.blocked.add(t.b1.property.id);
    expect(await t.mode.open(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: 'R42', code: 'not_diffusable' });
    t.blocked.clear();
    t.listings.splice(t.listings.findIndex((l) => l.propertyId === t.b1.property.id), 1);
    expect(await t.mode.open(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: 'R279', code: 'not_published' });
  });

  it('[R16] seul qui voit la fiche de l’acquéreur ouvre la présentation et range les notes', async () => {
    const t = await setup();
    const v = await t.visit();
    t.setClock(v.start);
    expect(await t.mode.open(t.as('agent', t.sam.id), v.id)).toMatchObject({ ok: false });
    expect(await t.mode.rate(t.as('agent', t.sam.id), v.id, all('aime'))).toMatchObject({ ok: false });
    expect(await t.db.all('SELECT * FROM presentation_ratings')).toEqual([]);
  });

  it('[R280] une seule fois par visite, du début de la visite à 24 heures après sa fin ; rejouée, même réponse', async () => {
    const t = await setup();
    const v = await t.visit();
    const agent = t.as('agent', t.alex.id);
    t.setClock(v.start - 60_000);
    expect(await t.mode.rate(agent, v.id, all('aime'))).toEqual({ ok: false, rule: 'R280', code: 'too_early' });
    t.setClock(v.end + 25 * HOUR);
    expect(await t.mode.rate(agent, v.id, all('aime'))).toEqual({ ok: false, rule: 'R280', code: 'too_late' });
    t.setClock(v.end);
    const { cuisine: _c, ...partial } = all('aime');
    expect(await t.mode.rate(agent, v.id, partial)).toEqual({ ok: false, rule: 'R280', code: 'missing_room' });
    const first = await t.mode.rate(agent, v.id, all('aime'));
    expect(first).toMatchObject({ ok: true, already: false });
    const again = await t.mode.rate(agent, v.id, all('aime'));
    expect(again).toMatchObject({ ok: true, already: true });
    expect(again.ok && first.ok && again.outcome).toEqual(first.ok && first.outcome);
    expect(await t.mode.rate(agent, v.id, all('non'))).toEqual({ ok: false, rule: 'R280', code: 'already_rated' });
    expect(await t.db.all('SELECT appointment_id FROM presentation_ratings')).toHaveLength(1);
    await expect(t.db.run("UPDATE presentation_ratings SET ratings = '{}'")).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM presentation_ratings')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R280] rejouée après un changement du bien, de sa diffusion ou de la fiche : la réponse du premier envoi', async () => {
    const t = await setup();
    const agent = t.as('agent', t.alex.id);
    const v = await t.visit();
    t.setClock(v.end);
    const first = await t.mode.rate(agent, v.id, { ...all('moyen'), 'chambre-3': 'non' });
    if (!first.ok) throw new Error(first.code);
    expect(first.outcome.next).toMatchObject({ kind: 'bien', reference: 'B2' });
    t.blocked.add(t.b2.property.id);
    await t.db.run('UPDATE properties SET rooms = 2 WHERE id = ?', [t.b1.property.id]);
    expect(await t.mode.rate(agent, v.id, { ...all('moyen'), 'chambre-3': 'non' })).toEqual({ ok: true, already: true, outcome: first.outcome });
    expect(await t.mode.outcomeOf(agent, v.id)).toEqual({ ok: true, outcome: first.outcome });
    // Le compte rendu au vendeur garde la chambre notée, même si la fiche n'en compte plus que deux pièces.
    expect(await t.mode.validateReport(agent, v.id)).toMatchObject({ ok: true, delivery: 'sent' });
    expect((await t.toSeller(t.b1.seller.id))[0]!.body).toContain('Réserves : Chambre 3.');
  });

  it('[R280] une visite annulée ne se note pas', async () => {
    const t = await setup();
    const v = await t.visit();
    await t.db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [v.id]);
    t.setClock(v.end);
    expect(await t.mode.rate(t.as('agent', t.alex.id), v.id, all('aime'))).toEqual({ ok: false, rule: 'R280', code: 'cancelled' });
  });

  it('[R281] Jamais vu : des notes, le code tire le compte rendu au vendeur et la prochaine proposition', async () => {
    const t = await setup();
    const agent = t.as('agent', t.alex.id);
    // Intérêt fort : la prochaine proposition est une contre-visite.
    const v1 = await t.visit();
    const v2 = await t.visit(t.b1.property.id, 'Hugo', 'Martin');
    t.setClock(v1.end);
    const strong = await t.mode.rate(agent, v1.id, all('aime'));
    expect(strong.ok && strong.outcome.next).toMatchObject({ kind: 'contre_visite', propertyId: t.b1.property.id, reference: 'B1' });
    expect(strong.ok && strong.outcome.report.interest).toBe('fort');
    // Intérêt moyen : le premier bien qui répond à la recherche, pas encore visité, avec ses raisons.
    t.setClock(v2.end);
    const mixed = await t.mode.rate(agent, v2.id, { ...all('moyen'), sejour: 'aime', exterieur: 'aime', cuisine: 'non' });
    if (!mixed.ok) throw new Error(mixed.code);
    expect(mixed.outcome.next).toMatchObject({ kind: 'bien', propertyId: t.b2.property.id, reference: 'B2' });
    expect(mixed.outcome.next.reasons).toContain('Dans votre budget');
    // Rien n'est parti au vendeur sans le geste de l'agent.
    expect(await t.toSeller(t.b1.seller.id)).toEqual([]);
    expect(await t.mode.outcomeOf(agent, v2.id)).toEqual({ ok: true, outcome: mixed.outcome });
    expect(await t.mode.validateReport(agent, v2.id)).toEqual({ ok: true, delivery: 'sent', rule: null });
    const sent = await t.toSeller(t.b1.seller.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('Points forts : Séjour ; Jardin, balcon ou vue.');
    expect(sent[0]!.body).toContain('Réserves : Cuisine.');
    expect(sent[0]!.body).toContain('Intérêt : moyen.');
    expect(sent[0]!.body).not.toMatch(/Hugo|Martin|acheteur\d@|offre/);
    // Validé deux fois, il ne part qu'une fois.
    expect(await t.mode.validateReport(agent, v2.id)).toEqual({ ok: true, delivery: 'sent', rule: null });
    expect(await t.toSeller(t.b1.seller.id)).toHaveLength(1);
  });

  it('[R281] B2 déjà visité par l’acquéreur : il n’est pas reproposé ; sans autre bien, rien à proposer', async () => {
    const t = await setup();
    const agent = t.as('agent', t.alex.id);
    const v = await t.visit();
    const r = await t.mode.open(agent, v.id);
    expect(r.ok && r.presentation.matches.map((m) => m.reference)).toEqual(['B2']);
    // Une autre visite du même projet, de B2.
    const second = await t.db.first<{ project_id: string }>('SELECT project_id FROM visits WHERE appointment_id = ?', [v.id]);
    const s = await new Visites(t.db, t.journal, new Acces(t.db, t.store, new FicheUnique(t.db, t.store), t.journal), {
      diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) },
      rendezVous: new RendezVous(t.db, t.journal),
    }).schedule(agent, { propertyId: t.b2.property.id, projectId: second!.project_id, start: new Date(MONDAY_9H + 50 * HOUR) });
    expect(s.ok).toBe(true);
    const again = await t.mode.open(agent, v.id);
    expect(again.ok && again.presentation.matches).toEqual([]);
    t.setClock(v.end);
    const rated = await t.mode.rate(agent, v.id, { ...all('non'), sejour: 'aime' });
    expect(rated.ok && rated.outcome.next).toMatchObject({ kind: 'aucune' });
  });

  it('[R281] un compte rendu déjà dicté par l’agent n’est jamais remplacé par les notes ; sans notes, rien à valider', async () => {
    const t = await setup();
    const agent = t.as('agent', t.alex.id);
    const v = await t.visit();
    t.setClock(v.end);
    expect(await t.mode.validateReport(agent, v.id)).toEqual({ ok: false, rule: 'R281', code: 'not_rated' });
    expect(await t.comptes.dictate(agent, v.id, 'Le séjour a plu, la cuisine non.', { withoutWriter: true })).toMatchObject({ ok: true });
    expect((await t.mode.rate(agent, v.id, all('aime'))).ok).toBe(true);
    expect(await t.mode.validateReport(agent, v.id)).toEqual({ ok: false, rule: null, code: 'dictated_report' });
    expect(await t.toSeller(t.b1.seller.id)).toEqual([]);
  });
});
