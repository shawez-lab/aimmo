import { expect, it } from 'vitest';
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
  checkReport,
  redactIdentifiers,
  redactNames,
  fromSyncSqlite,
  verifyChain,
  type ReportWriter,
  type SqlDatabase,
  type VisitReport,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const HOUR = 3_600_000;
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const TEMPLATE = 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.';
const GOOD: VisitReport = { opinion: 'Le visiteur a aimé la lumière du séjour.', strengths: ['séjour lumineux', 'jardin'], reservations: ['cuisine à refaire'], interest: 'fort', readyToOffer: false };

async function setup(writer?: ReportWriter) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const rdv = new RendezVous(db, journal, { now });
  const visites = new Visites(db, journal, acces, { diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) }, rendezVous: rdv, now });
  const comptes = new ComptesRendus(db, journal, visites, { now, ...(writer ? { writer } : {}) });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction', userId: string) => ({ role, userId, networkId: network.id });
  await rdv.setAvailability(as('agent', alex.id), WEEK);
  await visites.createSlipTemplate(as('direction', 'd1'), TEMPLATE);
  // Le vendeur, suivi par Sam, avec son mandat et son accord pour le suivi de la vente.
  const seller = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: 'Victor', lastName: 'Vendeur' });
  await store.addIdentifier({ networkId: network.id, personId: seller.id, kind: 'email', value: 'victor@example.test' });
  await store.addConsent({ networkId: network.id, personId: seller.id, purpose: SELLER_UPDATE_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date(MONDAY_9H - 10 * 24 * HOUR) });
  const property = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B1', kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  await db.run(
    "INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES ('m1', ?, ?, ?, ?, ?, 'site', 'test', ?)",
    [network.id, sam.id, seller.id, property.id, new Date(MONDAY_9H - 20 * 24 * HOUR).toISOString(), new Date(MONDAY_9H).toISOString()],
  );
  await db.run(
    "INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, 1, 'inscription', 'm1', 1, 'T-1', ?, ?, ?, ?, 'test', 'p', 'h-m1')",
    [network.id, sam.id, property.id, new Date(MONDAY_9H - 20 * 24 * HOUR).toISOString(), new Date(MONDAY_9H).toISOString()],
  );
  let n = 0;
  /** Une visite d'un acquéreur inventé d'Alex, le lendemain ou plus tard. */
  const visit = async (firstName = 'Inès', lastName = 'Durand') => {
    n += 1;
    const buyer = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, lastName });
    await store.addIdentifier({ networkId: network.id, personId: buyer.id, kind: 'email', value: `acheteur${n}@example.test` });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: buyer.id, kind: 'buy' });
    const r = await visites.schedule(as('agent', alex.id), { propertyId: property.id, projectId: project.id, start: new Date(MONDAY_9H + 24 * HOUR + n * 90 * 60_000) });
    if (!r.ok) throw new Error(r.code);
    return { id: r.visit.appointment.id, start: Date.parse(r.visit.appointment.start_at), end: Date.parse(r.visit.appointment.end_at), project };
  };
  const toSeller = () => db.all<{ body: string; occurred_at: string }>("SELECT m.body, m.occurred_at FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at", [seller.id]);
  return { db, journal, comptes, visites, store, property, network, alex, sam, as, visit, toSeller, seller, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('T06 · compte rendu de visite dicté', () => {
  it('5 comptes rendus dictés, validés en un geste, sont chez le vendeur moins de 24 heures après la visite, sans le nom de l’acquéreur [R52]', async () => {
    const writer: ReportWriter = { write: async () => GOOD };
    const t = await setup(writer);
    const visits = [];
    for (let i = 0; i < 5; i += 1) visits.push(await t.visit(`Acheteur${i}`, `Nom${i}`));
    for (let i = 0; i < 5; i += 1) {
      const v = visits[i]!;
      t.setClock(v.end + 10 * 60_000);
      const d = await t.comptes.dictate(t.as('agent', t.alex.id), v.id, `Acheteur${i} a aimé la lumière du séjour et le jardin, la cuisine est à refaire, intérêt fort.`);
      expect(d).toMatchObject({ ok: true, source: 'ai' });
      expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id)).toEqual({ ok: true, delivery: 'sent', rule: null });
      const sent = (await t.toSeller()).at(-1)!;
      expect(Date.parse(sent.occurred_at) - v.end).toBeLessThan(24 * HOUR);
      expect(sent.body).toContain('Bonjour Victor, voici le compte rendu de la visite de votre bien');
      expect(sent.body).not.toMatch(new RegExp(`Acheteur${i}|Nom${i}|acheteur\\d@`));
    }
    expect(await t.toSeller()).toHaveLength(5);
  });

  it('SV13 · un prénom corrigé après la dictée : le vendeur est salué par le nouveau, à la validation', async () => {
    const t = await setup({ write: async () => GOOD });
    const v = await t.visit();
    t.setClock(v.end + 10 * 60_000);
    expect(await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Inès a aimé la lumière du séjour et le jardin, la cuisine est à refaire, intérêt fort.')).toMatchObject({ ok: true });
    await t.db.run("UPDATE persons SET first_name = 'Viktor' WHERE id = ?", [t.seller.id]);
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id)).toEqual({ ok: true, delivery: 'sent', rule: null });
    const sent = (await t.toSeller()).at(-1)!;
    expect(sent.body).toContain('Bonjour Viktor,');
    expect(sent.body).not.toContain('Victor');
  });

  it('rien ne part au vendeur sans validation ; un compte rendu qui nomme l’acquéreur est refusé [R52]', async () => {
    const t = await setup({ write: async () => ({ ...GOOD, opinion: 'Inès a aimé le séjour.' }) });
    const v = await t.visit();
    expect(await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Inès a aimé le séjour.')).toMatchObject({ ok: true, report: null });
    expect(await t.toSeller()).toEqual([]);
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id)).toMatchObject({ ok: false, code: 'no_report' });
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id, { ...GOOD, opinion: 'Madame Durand a aimé le séjour.' })).toMatchObject({ ok: false, rule: 'R52', code: 'buyer_named' });
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id, { ...GOOD, opinion: 'Joignable au 06 11 22 33 44.' })).toMatchObject({ ok: false, rule: 'R52', code: 'contact' });
    expect(await t.toSeller()).toEqual([]);
    // L'agent écrit lui-même : il part.
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id, GOOD)).toMatchObject({ ok: true, delivery: 'sent' });
  });

  it('le compte rendu ne part pas au mandant d’un mandat rétracté', async () => {
    const t = await setup({ write: async () => GOOD });
    const v = await t.visit();
    await t.db.run("INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES ('m1', ?, 'Lettre reçue', ?, 'test', ?)", [t.network.id, new Date(MONDAY_9H).toISOString(), new Date(MONDAY_9H).toISOString()]);
    await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'a aimé le séjour');
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id)).toMatchObject({ ok: true, delivery: 'refused' });
    expect(await t.toSeller()).toEqual([]);
  });

  it('le compte rendu ne porte que ce que la dictée dit : un chiffre ou une offre inventés sont refusés, l’agent écrit alors lui-même [R10]', async () => {
    expect(checkReport({ ...GOOD, opinion: 'Budget de 300 000 €.' }, 'a aimé le séjour')).toEqual({ ok: false, code: 'invented_figure' });
    expect(checkReport({ ...GOOD, readyToOffer: true }, 'a aimé le séjour')).toEqual({ ok: false, code: 'invented_offer' });
    expect(checkReport({ ...GOOD, readyToOffer: true }, 'veut faire une offre demain')).toMatchObject({ ok: true });
    expect(checkReport({ ...GOOD, readyToOffer: true }, 'Il ne veut pas faire une offre.')).toEqual({ ok: false, code: 'invented_offer' });
    expect(redactIdentifiers('Son Instagram @acheteur_x, ou acheteur_x tout court, ou @autre.compte.', ['acheteur_x'])).toBe('Son Instagram @[coordonnée], ou [coordonnée] tout court, ou [compte].');
    expect(redactNames('Ines DURAND a aimé le séjour, Inès aussi.', ['Inès', 'Durand'])).toBe('[nom] [nom] a aimé le séjour, [nom] aussi.');
    expect(checkReport({ ...GOOD, note: 'x' }, 'a aimé')).toEqual({ ok: false, code: 'shape' });
    const t = await setup({ write: async () => ({ ...GOOD, opinion: 'Prêt à mettre 260 000 €.' }) });
    const v = await t.visit();
    expect(await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Il a aimé le séjour.')).toMatchObject({ ok: true, report: null });
    expect((await t.journal.all()).some((e) => e.type === 'compte_rendu.ia_refusee' && e.data.code === 'invented_figure')).toBe(true);
  });

  it('l’IA ne reçoit ni coordonnée ni nom connu [R15] ; en panne, la dictée brute est gardée ; la dictée ne va jamais au journal [R13]', async () => {
    const briefs: string[] = [];
    const t = await setup({ write: async (b) => { briefs.push(b.dictation); throw new Error('panne'); } });
    const v = await t.visit();
    const dictation = 'Inès Durand, inès@example.test, 06 11 22 33 44, a adoré le jardin, Victor peut la rappeler.';
    expect(await t.comptes.dictate(t.as('agent', t.alex.id), v.id, dictation)).toMatchObject({ ok: true, report: null });
    expect(briefs[0]).not.toMatch(/Inès|Durand|example\.test|06 11|Victor/);
    expect(await t.db.first('SELECT dictation FROM visit_reports')).toEqual({ dictation });
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/jardin|Inès|Durand|Victor/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('une relance par visite, et « préparer l’offre » si l’acheteur se dit prêt, une seule fois même validé deux fois [R18]', async () => {
    const t = await setup({ write: async () => ({ ...GOOD, readyToOffer: true }) });
    const v = await t.visit();
    await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Il veut faire une offre au prix.');
    await Promise.all([t.comptes.validate(t.as('agent', t.alex.id), v.id), t.comptes.validate(t.as('agent', t.alex.id), v.id)]);
    const tasks = await t.db.all<{ kind: string; project_id: string }>('SELECT kind, project_id FROM visit_tasks ORDER BY kind');
    expect(tasks).toEqual([
      { kind: 'preparer_offre', project_id: v.project.id },
      { kind: 'relance_acquereur', project_id: v.project.id },
    ]);
    expect(await t.toSeller()).toHaveLength(1);
    expect((await t.toSeller())[0]!.body).toContain('Le visiteur envisage de faire une offre');
    // Validé, le compte rendu ne change plus [R17].
    expect(await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Autre chose.')).toMatchObject({ ok: false, code: 'already_validated' });
    await expect(t.db.run("UPDATE visit_reports SET report = '{}'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM visit_reports')).rejects.toThrow();
  });

  it('ni adresse ni coordonnée de la fiche de l’acquéreur ne va au vendeur [R52] ; un prénom commun au vendeur et à l’acquéreur n’empêche pas l’envoi', async () => {
    const t = await setup({ write: async () => GOOD });
    const v = await t.visit('Victor', 'Durand');
    await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Il a aimé la lumière du séjour et le jardin, cuisine à refaire.');
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id, { ...GOOD, opinion: 'Habite 12 rue des Lilas, aimerait vendre avant.' })).toMatchObject({ ok: false, rule: 'R52', code: 'contact' });
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id, { ...GOOD, opinion: 'Le visiteur suit acheteur_x sur les réseaux.' })).toMatchObject({ ok: true, delivery: 'sent' });
    const sent = await t.toSeller();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('Bonjour Victor,');
  });

  it('un prénom composé compte mot par mot, et une adresse mail inconnue ne va pas à l’IA [R15, R52]', async () => {
    const briefs: string[] = [];
    const t = await setup({ write: async (b) => { briefs.push(b.dictation); return GOOD; } });
    const v = await t.visit('Jean-Pierre', 'Martin-Leroy');
    await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Jean a aimé, son mail lea.martin@example.test, Leroy aussi.');
    expect(briefs[0]).not.toMatch(/Jean|lea|martin|Leroy|example/i);
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id, { ...GOOD, opinion: 'Jean a aimé le séjour.' })).toMatchObject({ ok: false, rule: 'R52', code: 'buyer_named' });
  });

  it('une particule de nom ne nomme personne : « Le Gall » n’interdit pas « le visiteur »', async () => {
    const t = await setup({ write: async () => GOOD });
    const v = await t.visit('Inès', 'Le Gall');
    await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Il a aimé la lumière du séjour et le jardin, cuisine à refaire.');
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id, { ...GOOD, opinion: 'Le visiteur a aimé la lumière du séjour.' })).toMatchObject({ ok: true, delivery: 'sent' });
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id)).toMatchObject({ ok: true, delivery: 'sent' });
  });

  it('validé la nuit : il attend l’heure [R01] et part au passage suivant ; seul l’agent de l’acquéreur ou la direction [R16]', async () => {
    const t = await setup({ write: async () => GOOD });
    const v = await t.visit();
    expect(await t.comptes.dictate(t.as('agent', t.sam.id), v.id, 'x')).toMatchObject({ ok: false, rule: 'R16' });
    await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Il a aimé la lumière du séjour et le jardin, cuisine à refaire.');
    t.setClock(Date.parse('2026-12-08T21:30:00.000Z'));
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id)).toEqual({ ok: true, delivery: 'waiting', rule: 'R01' });
    t.setClock(Date.parse('2026-12-09T08:00:00.000Z'));
    expect(await t.comptes.retry()).toBe(1);
    expect(await t.toSeller()).toHaveLength(1);
    expect(await t.comptes.retry()).toBe(0);
  });

  it('[R86] un compte rendu validé par un agent qui part ensuite ne part plus au vendeur (J13)', async () => {
    const t = await setup({ write: async () => GOOD });
    const v = await t.visit();
    await t.comptes.dictate(t.as('agent', t.alex.id), v.id, 'Il a aimé la lumière du séjour et le jardin, cuisine à refaire.');
    t.setClock(Date.parse('2026-12-08T21:30:00.000Z'));
    expect(await t.comptes.validate(t.as('agent', t.alex.id), v.id)).toEqual({ ok: true, delivery: 'waiting', rule: 'R01' });
    // Alex quitte le réseau ; le mandat du vendeur reste à Sam, toujours là.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    t.setClock(Date.parse('2026-12-09T08:00:00.000Z'));
    await t.comptes.retry();
    expect(await t.toSeller()).toHaveLength(0);
    expect(await t.db.first("SELECT delivery_status, delivery_rule FROM visit_reports WHERE appointment_id = ?", [v.id])).toEqual({ delivery_status: 'refused', delivery_rule: 'R86' });
  });
});

describeWithSqlite('AU077 · comptes rendus d’une visite groupée', () => {
  it('AU077 · chaque acquéreur a son compte rendu ; aucun ne nomme un autre acquéreur venu ensemble, ni sa coordonnée [R52]', async () => {
    const t = await setup({ write: async () => GOOD });
    const alex = t.as('agent', t.alex.id);
    const first = await t.visit('Inès', 'Durand');
    const leo = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Léo', lastName: 'Martin' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: leo.id, kind: 'email', value: 'leo.martin@example.test' });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: leo.id, kind: 'buy' });
    const joined = await t.visites.schedule(alex, { propertyId: t.property.id, projectId: project.id, start: new Date(first.start), joinVisit: first.id });
    if (!joined.ok) throw new Error(joined.code);
    const second = joined.visit.appointment.id;
    t.setClock(first.end + 10 * 60_000);
    // Le compte rendu d'Inès qui nomme Léo, ou porte son mail, est refusé ; celui de Léo qui nomme Inès aussi.
    expect(await t.comptes.dictate(alex, first.id, 'Visite faite, intérêt fort.', { withoutWriter: true })).toMatchObject({ ok: true });
    expect(await t.comptes.validate(alex, first.id, { ...GOOD, opinion: 'Comme Léo, le visiteur a aimé le séjour.' })).toMatchObject({ ok: false, rule: 'R52', code: 'buyer_named' });
    expect(await t.comptes.validate(alex, first.id, { ...GOOD, opinion: 'Le visiteur a aimé le séjour, écrire à leo.martin@example.test.' })).toMatchObject({ ok: false, rule: 'R52' });
    expect(await t.comptes.dictate(alex, second, 'Visite faite, intérêt moyen.', { withoutWriter: true })).toMatchObject({ ok: true });
    expect(await t.comptes.validate(alex, second, { ...GOOD, opinion: 'Comme Inès, le visiteur a aimé le séjour.' })).toMatchObject({ ok: false, rule: 'R52', code: 'buyer_named' });
    // Chacun le sien, validé à part : deux comptes rendus chez le vendeur, sans aucun nom d'acquéreur.
    expect(await t.comptes.validate(alex, first.id, GOOD)).toEqual({ ok: true, delivery: 'sent', rule: null });
    expect(await t.comptes.validate(alex, second, { ...GOOD, interest: 'moyen' })).toEqual({ ok: true, delivery: 'sent', rule: null });
    const sent = await t.toSeller();
    expect(sent).toHaveLength(2);
    for (const m of sent) expect(m.body).not.toMatch(/Inès|Durand|Léo|Martin|example\.test/);
    expect(await t.db.all("SELECT appointment_id FROM visit_reports WHERE status = 'valide'")).toHaveLength(2);
  });

  it('AU077 · l’IA ne lit le nom ni la coordonnée d’aucun acquéreur de la visite groupée [R15]', async () => {
    const seen: string[] = [];
    const t = await setup({ write: async (input) => { seen.push(input.dictation); return GOOD; } });
    const alex = t.as('agent', t.alex.id);
    const first = await t.visit('Inès', 'Durand');
    const leo = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Léo', lastName: 'Martin' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: leo.id, kind: 'email', value: 'leo.martin@example.test' });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: leo.id, kind: 'buy' });
    const joined = await t.visites.schedule(alex, { propertyId: t.property.id, projectId: project.id, start: new Date(first.start), joinVisit: first.id });
    if (!joined.ok) throw new Error(joined.code);
    t.setClock(first.end + 10 * 60_000);
    expect(await t.comptes.dictate(alex, first.id, 'Inès a aimé la lumière du séjour et le jardin, Léo Martin aussi (leo.martin@example.test), la cuisine est à refaire, intérêt fort.')).toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/Inès|Léo|Martin|example\.test/);
  });
});
