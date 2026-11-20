import { expect, it } from 'vitest';
import {
  Acces,
  Designations,
  FicheClient,
  FicheUnique,
  RendezVous,
  SqlJournalStore,
  Visites,
  applyMigrations,
  fromSyncSqlite,
  verifyChain,
  type DiffusionGate,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const WEDNESDAY_10H = new Date('2026-12-09T09:00:00.000Z');
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const TEMPLATE = [
  'BON DE VISITE · {{reseau.nom}}',
  'Je soussigné {{visiteur.nom}} reconnais avoir visité le bien {{bien.reference}}, {{bien.type}} à {{bien.commune}}, {{bien.surface}}, {{bien.pieces}} pièces, au prix de {{bien.prix}}, le {{visite.date}} à {{visite.heure}}, avec {{agent.nom}}.',
  'Fait le {{signature.date}}.',
].join('\n\n');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const blocked = new Set<string>();
  const diffusion: DiffusionGate = { canDiffuse: async (_n, id) => (blocked.has(id) ? { allowed: false, reason: 'withdrawal_period' } : { allowed: true, reason: 'allowed' }) };
  const rdv = new RendezVous(db, journal, { now });
  const visites = new Visites(db, journal, acces, { diffusion, rendezVous: rdv, now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  await rdv.setAvailability(as('agent', alex.id), WEEK);
  const buyer = async (firstName: string, lastName: string | null = 'Durand') => {
    const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, ...(lastName ? { lastName } : {}) });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'buy' });
    return { person, project };
  };
  // Un bien de Sam : le fichier commun le rend visitable par les clients d'Alex.
  const property = (overrides: { surfaceM2?: number } = {}) =>
    store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B-TALANT', kind: 'home', postalCode: '21240', city: 'Talant', priceEur: 280_000, surfaceM2: overrides.surfaceM2 ?? 95, rooms: 4, status: 'available' });
  const designations = new Designations(db, acces, journal, { now });
  return { db, journal, store, fiche, visites, rdv, network, alex, sam, as, buyer, property, blocked, designations };
}

const SLIP_WITH_ADDRESS = [
  'BON DE VISITE · {{reseau.nom}}',
  'Je soussigné {{visiteur.nom}} reconnais avoir visité le bien {{bien.reference}}, situé {{bien.adresse}}, le {{visite.date}} à {{visite.heure}}, avec {{agent.nom}}.',
  'Fait le {{signature.date}}.',
].join('\n\n');
const PARCELS = [{ section: 'AB', number: '0123' }];

describeWithSqlite('T04 · visite et bon de visite', () => {
  it('une visite fixée produit son bon : bien, date et visiteur, sans adresse exacte, d’essai tant que le modèle n’est pas validé [R40]', async () => {
    const t = await setup();
    const tpl = await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    expect(tpl).toMatchObject({ ok: true, version: 1 });
    const b = await t.buyer('Inès');
    const p = await t.property();
    const r = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H, channel: 'email' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.visit.appointment).toMatchObject({ kind: 'visite', property_id: p.id, person_id: b.person.id, agent_id: t.alex.id, status: 'booked' });
    const slip = r.visit.slip;
    expect(slip).toMatchObject({ mode: 'essai', status: 'complet', missing: [] });
    expect(slip.content).toContain('Inès Durand');
    expect(slip.content).toContain('B-TALANT');
    expect(slip.content).toContain('09/12/2026 à 10 h 00');
    expect(slip.content).toContain('DOCUMENT D’ESSAI');
    expect(slip.content).toContain('[date de signature à la signature]');
    // La confirmation au visiteur, rangée dans la boîte d'essai, ne porte aucune adresse [R19].
    const confirmation = await t.db.first<{ body: string }>("SELECT body FROM messages WHERE direction = 'out' AND person_id = ?", [b.person.id]);
    expect(confirmation?.body ?? '').not.toMatch(/\d+,? (rue|avenue|boulevard|chemin|place)/i);
    // Le modèle validé par la conformité donne un bon réel.
    expect(await t.visites.validateSlipTemplate(t.as('direction', 'd1'), tpl.ok ? tpl.id : '')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.visites.validateSlipTemplate(t.as('compliance', 'c1'), tpl.ok ? tpl.id : '')).toEqual({ ok: true });
    const r2 = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: new Date(WEDNESDAY_10H.getTime() + 3 * 3_600_000) });
    expect(r2.ok && r2.visit.slip.mode).toBe('reel');
  });

  it('un champ manquant laisse le bon incomplet, jamais un texte inventé, et il ne se signe pas [R40]', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Léo', null);
    const p = await t.property();
    const r = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H });
    if (!r.ok) throw new Error(r.code);
    expect(r.visit.slip).toMatchObject({ status: 'incomplet', missing: ['visiteur.nom'] });
    expect(r.visit.slip.content).toContain('[à compléter : nom du visiteur]');
    expect(await t.visites.recordPaperSignature(t.as('agent', t.alex.id), r.visit.appointment.id, { signedAt: new Date(TUESDAY_10H), scanRef: 'scans/bon-1.pdf' })).toMatchObject({ ok: false, rule: 'R40' });
  });

  it('un modèle refuse un champ inconnu ou sans bien, date et visiteur ; sans modèle, aucune visite', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const p = await t.property();
    expect(await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H })).toMatchObject({ ok: false, rule: 'R40', code: 'no_template' });
    expect(await t.visites.createSlipTemplate(t.as('direction', 'd1'), 'Visite de {{bien.vendeur}} par {{visiteur.nom}} le {{visite.date}}, {{bien.reference}}')).toMatchObject({ ok: false, code: 'unknown_field' });
    expect(await t.visites.createSlipTemplate(t.as('direction', 'd1'), 'Visite de {{bien.reference}} le {{visite.date}}')).toMatchObject({ ok: false, code: 'missing_required_field' });
    expect(await t.visites.createSlipTemplate(t.as('agent', t.alex.id), TEMPLATE)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.db.all('SELECT * FROM appointments')).toEqual([]);
  });

  it('une visite sur un bien que la diffusion refuse est refusée [R42]', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    t.blocked.add(p.id);
    expect(await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H })).toEqual({ ok: false, rule: 'R42', code: 'withdrawal_period' });
    expect(await t.db.all('SELECT * FROM appointments')).toEqual([]);
  });

  it('une visite annulée garde son bon ; rien ne s’efface ni ne se réécrit [R17] ; la signature papier se range une fois', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const r = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H });
    if (!r.ok) throw new Error(r.code);
    const id = r.visit.appointment.id;
    const signed = await t.visites.recordPaperSignature(t.as('agent', t.alex.id), id, { signedAt: new Date(TUESDAY_10H), scanRef: 'scans/bon-1.pdf' });
    expect(signed).toMatchObject({ ok: true, slip: { signedAt: new Date(TUESDAY_10H).toISOString() } });
    // Une seconde signature ne change rien.
    await expect(t.visites.recordPaperSignature(t.as('agent', t.alex.id), id, { signedAt: new Date(TUESDAY_10H - 1000), scanRef: 'autre.pdf' })).resolves.toMatchObject({ ok: true, slip: { signedAt: new Date(TUESDAY_10H).toISOString() } });
    expect(await t.visites.cancel(t.as('agent', t.alex.id), id)).toEqual({ ok: true });
    const slip = await t.visites.slipOf(t.as('agent', t.alex.id), id);
    expect(slip).toMatchObject({ ok: true, slip: { id: r.visit.slip.id, contentHash: r.visit.slip.contentHash } });
    await expect(t.db.run('DELETE FROM visit_slips')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM visits')).rejects.toThrow();
    await expect(t.db.run("UPDATE visit_slips SET content = 'x'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM visit_slip_templates')).rejects.toThrow();
  });

  it('une visite décalée par l’agenda garde son lien : le nouveau rendez-vous a sa visite et un bon à sa date, l’ancien garde le sien', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const r = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H });
    if (!r.ok) throw new Error(r.code);
    const moved = await t.rdv.moveFromAgenda(r.visit.appointment.id, new Date(WEDNESDAY_10H.getTime() + 4 * 3_600_000));
    if (!moved.ok) throw new Error(moved.code);
    const fresh = await t.visites.slipOf(t.as('agent', t.alex.id), moved.appointment.id);
    expect(fresh).toMatchObject({ ok: true });
    if (fresh.ok) expect(fresh.slip.content).toContain('09/12/2026 à 14 h 00');
    const old = await t.visites.slipOf(t.as('agent', t.alex.id), r.visit.appointment.id);
    expect(old).toMatchObject({ ok: true, slip: { id: r.visit.slip.id } });
    const visits = await t.db.all<{ project_id: string }>('SELECT project_id FROM visits');
    expect(visits.map((v) => v.project_id)).toEqual([b.project.id, b.project.id]);
  });

  it('une visite décalée sur un bien qui ne peut plus être diffusé n’est pas reprise [R42] ; un bon manquant après une panne est refait', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const r = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H });
    if (!r.ok) throw new Error(r.code);
    t.blocked.add(p.id);
    const moved = await t.rdv.moveFromAgenda(r.visit.appointment.id, new Date(WEDNESDAY_10H.getTime() + 4 * 3_600_000));
    if (!moved.ok) throw new Error(moved.code);
    expect(await t.visites.slipOf(t.as('agent', t.alex.id), moved.appointment.id)).toMatchObject({ ok: false, code: 'unknown' });
    expect(await t.visites.slipOf(t.as('agent', t.alex.id), r.visit.appointment.id)).toMatchObject({ ok: true });
    t.blocked.delete(p.id);
    // Une visite rangée sans son bon (panne entre les deux) : le bon est refait à la lecture suivante, une fois.
    const booked = await t.rdv.book({ networkId: t.network.id, agentId: t.alex.id, personId: b.person.id, propertyId: p.id, kind: 'visite', start: new Date(WEDNESDAY_10H.getTime() + 24 * 3_600_000), source: 'agent' });
    if (!booked.ok) throw new Error(booked.code);
    await t.db.run("INSERT INTO visits (appointment_id, network_id, property_id, project_id, person_id, agent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'test', ?)", [booked.appointment.id, t.network.id, p.id, b.project.id, b.person.id, t.alex.id, new Date(TUESDAY_10H).toISOString()]);
    const [x, y] = await Promise.all([t.visites.slipOf(t.as('agent', t.alex.id), booked.appointment.id), t.visites.slipOf(t.as('agent', t.alex.id), booked.appointment.id)]);
    expect(x).toMatchObject({ ok: true });
    expect(y).toMatchObject({ ok: true });
    const n = await t.db.first<{ n: number }>('SELECT count(*) AS n FROM visit_slips WHERE appointment_id = ?', [booked.appointment.id]);
    expect(Number(n!.n)).toBe(1);
  });

  it('un agent dont le client est passé à un autre agent ne lit plus le bon ; chaque lecture du bon va au journal [R16]', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const r = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H });
    if (!r.ok) throw new Error(r.code);
    const before = (await t.journal.all()).filter((e) => e.type === 'fiche.lue').length;
    expect(await t.visites.slipOf(t.as('agent', t.alex.id), r.visit.appointment.id)).toMatchObject({ ok: true });
    expect((await t.journal.all()).filter((e) => e.type === 'fiche.lue').length).toBe(before + 1);
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, b.person.id]);
    expect(await t.visites.slipOf(t.as('agent', t.alex.id), r.visit.appointment.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.visites.recordPaperSignature(t.as('agent', t.alex.id), r.visit.appointment.id, { signedAt: new Date(TUESDAY_10H), scanRef: 'x.pdf' })).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('seuls l’agent de l’acquéreur et la direction [R16] ; un partenaire, un autre agent ou la conformité refusés, au journal', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    expect(await t.visites.schedule(t.as('agent', t.sam.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.visites.schedule(t.as('compliance', 'c1'), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H })).toMatchObject({ ok: false, rule: 'R16' });
    const r = await t.visites.schedule(t.as('direction', 'd1'), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H });
    if (!r.ok) throw new Error(r.code);
    expect(r.visit.appointment.agent_id).toBe(t.alex.id);
    expect(await t.visites.slipOf(t.as('agent', t.sam.id), r.visit.appointment.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.visites.slipOf(t.as('agent', t.alex.id), r.visit.appointment.id)).toMatchObject({ ok: true });
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'acces.refuse').length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(entries.filter((e) => e.type.startsWith('bon_visite') || e.type.startsWith('visite')))).not.toMatch(/Inès|Durand|B-TALANT/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });
});

describeWithSqlite('RC32 · une visite réservée en ligne rattachée à la recherche de l’acquéreur', () => {
  // Une visite prise depuis le site (V08) : un rendez-vous seul, sans visite ni bon.
  const online = async (t: Awaited<ReturnType<typeof setup>>, personId: string, propertyId: string | null, kind: 'visite' | 'estimation' = 'visite') => {
    const r = await t.rdv.book({ networkId: t.network.id, agentId: t.alex.id, personId, propertyId, kind, start: WEDNESDAY_10H, source: 'site', channel: null });
    if (!r.ok) throw new Error(r.code);
    return r.appointment;
  };
  const count = async (t: Awaited<ReturnType<typeof setup>>) => ({
    visits: (await t.db.all('SELECT * FROM visits')).length,
    slips: (await t.db.all('SELECT * FROM visit_slips')).length,
  });

  it('rattachée : la visite est rangée sur le projet d’achat, son bon fait à la date du rendez-vous, au journal [R40]', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const appt = await online(t, b.person.id, p.id);
    expect(await count(t)).toEqual({ visits: 0, slips: 0 });
    const r = await t.visites.attachOnline(t.as('agent', t.alex.id), { appointmentId: appt.id, projectId: b.project.id });
    if (!r.ok) throw new Error(r.code);
    expect(r.visit.appointment).toMatchObject({ id: appt.id, source: 'site', status: 'booked' });
    expect(r.visit.slip).toMatchObject({ appointmentId: appt.id, mode: 'essai', status: 'complet' });
    expect(r.visit.slip.content).toContain('Inès Durand');
    expect(r.visit.slip.content).toContain('09/12/2026 à 10 h 00');
    expect(await t.db.first('SELECT property_id, project_id, person_id, agent_id, created_by FROM visits WHERE appointment_id = ?', [appt.id])).toEqual({
      property_id: p.id,
      project_id: b.project.id,
      person_id: b.person.id,
      agent_id: t.alex.id,
      created_by: `agent:${t.alex.id}`,
    });
    // Le dossier se lit ensuite comme celui d'une visite fixée par l'agent.
    expect(await t.visites.slipOf(t.as('agent', t.alex.id), appt.id)).toMatchObject({ ok: true, slip: { id: r.visit.slip.id } });
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'visite.rattachee')).toHaveLength(1);
    expect(JSON.stringify(entries.filter((e) => e.type.startsWith('visite')))).not.toMatch(/Inès|Durand|B-TALANT/);
    // Rien n'est envoyé par le rattachement.
    expect(await t.db.all("SELECT * FROM messages WHERE direction = 'out'")).toEqual([]);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('jamais deux fois : un second rattachement, ou deux en même temps, laissent une seule visite et un seul bon', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const appt = await online(t, b.person.id, p.id);
    const both = await Promise.all([
      t.visites.attachOnline(t.as('agent', t.alex.id), { appointmentId: appt.id, projectId: b.project.id }),
      t.visites.attachOnline(t.as('direction', 'd1'), { appointmentId: appt.id, projectId: b.project.id }),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, rule: null, code: 'already_attached' });
    expect(await t.visites.attachOnline(t.as('agent', t.alex.id), { appointmentId: appt.id, projectId: b.project.id })).toEqual({ ok: false, rule: null, code: 'already_attached' });
    expect(await count(t)).toEqual({ visits: 1, slips: 1 });
    // Une visite fixée par l'agent est déjà une visite.
    const fixed = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: new Date(WEDNESDAY_10H.getTime() + 3 * 3_600_000) });
    if (!fixed.ok) throw new Error(fixed.code);
    expect(await t.visites.attachOnline(t.as('agent', t.alex.id), { appointmentId: fixed.visit.appointment.id, projectId: b.project.id })).toMatchObject({ ok: false, code: 'already_attached' });
  });

  it('projet d’une autre personne ou qui n’est pas un achat, rendez-vous qui n’est pas une visite, sans bien ou annulé : refusés, rien d’écrit', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const other = await t.buyer('Hugo');
    const p = await t.property();
    const alex = t.as('agent', t.alex.id);
    const appt = await online(t, b.person.id, p.id);
    expect(await t.visites.attachOnline(alex, { appointmentId: appt.id, projectId: other.project.id })).toEqual({ ok: false, rule: null, code: 'other_person' });
    const sell = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: b.person.id, kind: 'sell' });
    expect(await t.visites.attachOnline(alex, { appointmentId: appt.id, projectId: sell.id })).toEqual({ ok: false, rule: null, code: 'unknown_project' });
    expect(await t.visites.attachOnline(alex, { appointmentId: 'inconnu', projectId: b.project.id })).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    const later = new Date(WEDNESDAY_10H.getTime() + 2 * 3_600_000);
    const estimation = await t.rdv.book({ networkId: t.network.id, agentId: t.alex.id, personId: b.person.id, propertyId: p.id, kind: 'estimation', start: later, source: 'site', channel: null });
    if (!estimation.ok) throw new Error(estimation.code);
    expect(await t.visites.attachOnline(alex, { appointmentId: estimation.appointment.id, projectId: b.project.id })).toEqual({ ok: false, rule: null, code: 'not_a_visit' });
    const bare = await t.rdv.book({ networkId: t.network.id, agentId: t.alex.id, personId: b.person.id, propertyId: null, kind: 'visite', start: new Date(later.getTime() + 2 * 3_600_000), source: 'assistant', channel: null });
    if (!bare.ok) throw new Error(bare.code);
    expect(await t.visites.attachOnline(alex, { appointmentId: bare.appointment.id, projectId: b.project.id })).toEqual({ ok: false, rule: null, code: 'no_property' });
    expect(await t.rdv.cancelAsAgent(alex, appt.id)).toMatchObject({ ok: true });
    expect(await t.visites.attachOnline(alex, { appointmentId: appt.id, projectId: b.project.id })).toEqual({ ok: false, rule: null, code: 'not_booked' });
    expect(await count(t)).toEqual({ visits: 0, slips: 0 });
  });

  it('annulé pendant les contrôles : rien n’est rangé, le refus dit « not_booked »', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const appt = await online(t, b.person.id, p.id);
    const alex = t.as('agent', t.alex.id);
    // Le client annule par son lien pendant que la diffusion est relue.
    const gate: DiffusionGate = {
      canDiffuse: async () => {
        expect(await t.rdv.cancelAsAgent(alex, appt.id)).toMatchObject({ ok: true });
        return { allowed: true, reason: 'allowed' };
      },
    };
    const visites = new Visites(t.db, t.journal, new Acces(t.db, t.store, t.fiche, t.journal), { diffusion: gate, rendezVous: t.rdv });
    expect(await visites.attachOnline(alex, { appointmentId: appt.id, projectId: b.project.id })).toEqual({ ok: false, rule: null, code: 'not_booked' });
    expect(await count(t)).toEqual({ visits: 0, slips: 0 });
  });

  it('un agent qui ne suit pas la fiche est refusé [R16] ; un bien que la diffusion refuse [R42] ; sans modèle [R40]', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const p = await t.property();
    const appt = await online(t, b.person.id, p.id);
    const req = { appointmentId: appt.id, projectId: b.project.id };
    expect(await t.visites.attachOnline(t.as('agent', t.alex.id), req)).toEqual({ ok: false, rule: 'R40', code: 'no_template' });
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    expect(await t.visites.attachOnline(t.as('agent', t.sam.id), req)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.visites.attachOnline(t.as('compliance', 'c1'), req)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    t.blocked.add(p.id);
    expect(await t.visites.attachOnline(t.as('agent', t.alex.id), req)).toEqual({ ok: false, rule: 'R42', code: 'withdrawal_period' });
    expect(await count(t)).toEqual({ visits: 0, slips: 0 });
    t.blocked.delete(p.id);
    expect(await t.visites.attachOnline(t.as('direction', 'd1'), req)).toMatchObject({ ok: true });
  });

  it('fiches réunies : le projet d’achat de l’autre fiche est accepté, la visite va à la fiche gardée', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    // La personne a réservé sur le site avec un autre mail : une fiche neuve, réunie ensuite par l'agent.
    const fresh = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Inès' });
    const appt = await online(t, fresh.id, p.id);
    await t.fiche.merge({ survivorId: b.person.id, mergedId: fresh.id, reason: 'même personne' });
    const r = await t.visites.attachOnline(t.as('agent', t.alex.id), { appointmentId: appt.id, projectId: b.project.id });
    if (!r.ok) throw new Error(r.code);
    expect(r.visit.slip.content).toContain('Inès Durand');
    expect(await t.db.first('SELECT project_id, person_id FROM visits WHERE appointment_id = ?', [appt.id])).toEqual({ project_id: b.project.id, person_id: b.person.id });
  });
});

describeWithSqlite('BR64 · les visites réservées en ligne qui attendent sur la fiche', () => {
  const at = (h: number) => new Date(WEDNESDAY_10H.getTime() + h * 3_600_000);
  const book = async (t: Awaited<ReturnType<typeof setup>>, personId: string, propertyId: string | null, start: Date, source: 'site' | 'assistant' | 'espace' | 'agent' = 'site', kind: 'visite' | 'estimation' = 'visite') => {
    const r = await t.rdv.book({ networkId: t.network.id, agentId: t.alex.id, personId, propertyId, kind, start, source, channel: null });
    if (!r.ok) throw new Error(r.code);
    return r.appointment;
  };

  it('seulement les visites en ligne prises, avec un bien lisible, pas encore rattachées, fiches réunies comprises, sans adresse', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const fresh = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Inès' });
    const site = await book(t, b.person.id, p.id, at(0), 'site');
    const merged = await book(t, fresh.id, p.id, at(2), 'espace');
    await t.fiche.merge({ survivorId: b.person.id, mergedId: fresh.id, reason: 'même personne' });
    // Écartés : fixée par l'agent, une estimation, sans bien, annulée, déjà rattachée, bien hors des droits.
    await book(t, b.person.id, p.id, at(4), 'agent');
    await book(t, b.person.id, p.id, at(6), 'site', 'estimation');
    await book(t, b.person.id, null, at(8), 'assistant');
    const cancelled = await book(t, b.person.id, p.id, at(24), 'site');
    expect(await t.rdv.cancelAsAgent(t.as('agent', t.alex.id), cancelled.id)).toMatchObject({ ok: true });
    const attached = await book(t, b.person.id, p.id, at(26), 'assistant');
    expect(await t.visites.attachOnline(t.as('agent', t.alex.id), { appointmentId: attached.id, projectId: b.project.id })).toMatchObject({ ok: true });
    const hidden = await t.store.createProperty({ networkId: t.network.id, agentId: t.sam.id, reference: 'B-CACHE', kind: 'home', postalCode: '21000', city: 'Dijon', priceEur: 200_000, surfaceM2: 60, rooms: 3, status: 'draft' });
    await book(t, b.person.id, hidden.id, at(28), 'site');

    const r = await t.visites.onlineToAttach(t.as('agent', t.alex.id), fresh.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toEqual([
      { appointmentId: site.id, start: site.start_at, end: site.end_at, source: 'site', property: { reference: 'B-TALANT', city: 'Talant' } },
      { appointmentId: merged.id, start: merged.start_at, end: merged.end_at, source: 'espace', property: { reference: 'B-TALANT', city: 'Talant' } },
    ]);
    // La direction voit aussi le bien de Sam en brouillon.
    const d = await t.visites.onlineToAttach(t.as('direction', 'd1'), b.person.id);
    expect(d.ok && d.value.map((v) => v.property.reference)).toEqual(['B-TALANT', 'B-TALANT', 'B-CACHE']);
    // Une fois rattachée, elle n'attend plus.
    expect(await t.visites.attachOnline(t.as('agent', t.alex.id), { appointmentId: site.id, projectId: b.project.id })).toMatchObject({ ok: true });
    const after = await t.visites.onlineToAttach(t.as('agent', t.alex.id), b.person.id);
    expect(after.ok && after.value.map((v) => v.appointmentId)).toEqual([merged.id]);
  });

  it('un agent qui ne suit pas la fiche, ou un autre rôle, est refusé et le refus va au journal [R16]', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const p = await t.property();
    await book(t, b.person.id, p.id, at(0));
    expect(await t.visites.onlineToAttach(t.as('agent', t.sam.id), b.person.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.visites.onlineToAttach(t.as('compliance', 'c1'), b.person.id)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.visites.onlineToAttach(t.as('agent', t.alex.id), 'inconnu')).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    const refused = (await t.journal.all()).filter((e) => e.actor === `agent:${t.sam.id}` || e.actor === 'compliance:c1');
    expect(refused.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(refused)).not.toMatch(/Inès|Durand|B-TALANT/);
  });

  it('des biens hors des droits en tête ne cachent pas les visites suivantes : jusqu’à 20 visites lisibles', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const p = await t.property();
    const hidden = await t.store.createProperty({ networkId: t.network.id, agentId: t.sam.id, reference: 'B-CACHE', kind: 'home', postalCode: '21000', city: 'Dijon', priceEur: 200_000, surfaceM2: 60, rooms: 3, status: 'draft' });
    // 60 visites sur le bien caché d'abord, puis 22 sur le bien lisible, une par demi-journée ouvrée.
    const slots: Date[] = [];
    for (let day = 0; slots.length < 82; day++) {
      const d = new Date(WEDNESDAY_10H.getTime() + day * 86_400_000);
      if (new Date(d.getTime() + 3_600_000).getUTCDay() === 0) continue;
      slots.push(d, new Date(d.getTime() + 4 * 3_600_000));
    }
    for (const [i, start] of slots.slice(0, 82).entries()) await book(t, b.person.id, i < 60 ? hidden.id : p.id, start);
    const r = await t.visites.onlineToAttach(t.as('agent', t.alex.id), b.person.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toHaveLength(20);
    expect(new Set(r.value.map((v) => v.property.reference))).toEqual(new Set(['B-TALANT']));
  });

  it('une visite en ligne rattachée puis décalée n’est pas proposée de nouveau : son remplaçant est déjà une visite', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), TEMPLATE);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const appt = await book(t, b.person.id, p.id, at(0), 'site');
    expect(await t.visites.attachOnline(t.as('agent', t.alex.id), { appointmentId: appt.id, projectId: b.project.id })).toMatchObject({ ok: true });
    const moved = await t.rdv.moveFromAgenda(appt.id, at(2));
    if (!moved.ok) throw new Error(moved.code);
    expect(moved.appointment).toMatchObject({ source: 'site', replaces_id: appt.id, status: 'booked' });
    expect(await t.visites.attachOnline(t.as('agent', t.alex.id), { appointmentId: moved.appointment.id, projectId: b.project.id })).toMatchObject({ ok: false, code: 'already_attached' });
    const r = await t.visites.onlineToAttach(t.as('agent', t.alex.id), b.person.id);
    expect(r).toEqual({ ok: true, value: [] });
    // Une visite en ligne décalée sans avoir été rattachée reste proposée.
    const loose = await book(t, b.person.id, p.id, at(24), 'espace');
    const again = await t.rdv.moveFromAgenda(loose.id, at(26));
    if (!again.ok) throw new Error(again.code);
    const r2 = await t.visites.onlineToAttach(t.as('agent', t.alex.id), b.person.id);
    expect(r2.ok && r2.value.map((v) => v.appointmentId)).toEqual([again.appointment.id]);
  });

});

describeWithSqlite('AU076 · le bon de visite désigne précisément le bien', () => {
  it('AU076 · le bon désigne le bien par son adresse exacte, la plus récente, sans qu’elle aille dans la confirmation ni le journal [R19, R40]', async () => {
    const t = await setup();
    // Le constat : un modèle qui demande l'adresse du bien était refusé (« unknown_field »).
    const tpl = await t.visites.createSlipTemplate(t.as('direction', 'd1'), SLIP_WITH_ADDRESS);
    expect(tpl).toMatchObject({ ok: true, version: 1 });
    const b = await t.buyer('Inès');
    const p = await t.property();
    // Sam, l'agent du bien, le désigne ; il corrige ensuite le numéro : la plus récente vaut.
    expect(await t.designations.setProperty(t.as('agent', t.sam.id), p.id, { address: { street: '3 rue des Essais', postalCode: '21240', city: 'Talant' }, parcels: PARCELS })).toMatchObject({ ok: true });
    expect(await t.designations.setProperty(t.as('agent', t.sam.id), p.id, { address: { street: '5 rue des Essais', postalCode: '21240', city: 'Talant' }, parcels: PARCELS })).toMatchObject({ ok: true });
    const r = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H, channel: 'email' });
    if (!r.ok) throw new Error(r.code);
    expect(r.visit.slip).toMatchObject({ status: 'complet', missing: [] });
    expect(r.visit.slip.content).toContain('situé 5 rue des Essais, 21240 Talant');
    expect(r.visit.slip.content).not.toContain('3 rue des Essais');
    // Le bon relu par l'agent de l'acquéreur est le même, au caractère près.
    expect(await t.visites.slipOf(t.as('agent', t.alex.id), r.visit.appointment.id)).toMatchObject({ ok: true, slip: { contentHash: r.visit.slip.contentHash } });
    // Hors du bon : ni aucun message (la confirmation est écrite par le code, sans adresse), ni le journal, ni la fiche du bien ne portent la rue [R19].
    const bodies = await t.db.all<{ body: string }>('SELECT body FROM messages');
    for (const m of bodies) expect(m.body).not.toContain('rue des Essais');
    const events = await t.db.all<{ subject: string | null; data: string }>('SELECT subject, data FROM journal');
    for (const e of events) expect(`${e.subject ?? ''} ${e.data}`).not.toContain('rue des Essais');
    expect(JSON.stringify(await t.db.first('SELECT * FROM properties WHERE id = ?', [p.id]))).not.toContain('rue des Essais');
  });

  it('AU076 · sans désignation du bien, le bon reste incomplet et ne se signe pas ; jamais une adresse devinée [R40]', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), SLIP_WITH_ADDRESS);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const r = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H });
    if (!r.ok) throw new Error(r.code);
    expect(r.visit.slip).toMatchObject({ status: 'incomplet', missing: ['bien.adresse'] });
    expect(r.visit.slip.content).toContain('[à compléter : adresse du bien]');
    expect(await t.visites.recordPaperSignature(t.as('agent', t.alex.id), r.visit.appointment.id, { signedAt: new Date(TUESDAY_10H), scanRef: 'scans/bon-1.pdf' })).toMatchObject({ ok: false, rule: 'R40' });
  });

  it('AU076 · la désignation d’un bien d’un autre réseau ne passe jamais dans le bon [R16]', async () => {
    const t = await setup();
    await t.visites.createSlipTemplate(t.as('direction', 'd1'), SLIP_WITH_ADDRESS);
    const b = await t.buyer('Inès');
    const p = await t.property();
    const other = await t.store.createNetwork('Autre réseau');
    // Une ligne glissée sous un autre réseau, pour le même bien : le bon ne la lit pas.
    await t.db.run('PRAGMA foreign_keys = OFF');
    await t.db.run(
      "INSERT INTO property_designations (id, network_id, property_id, version, street, postal_code, city, parcels, set_by, set_at) VALUES ('d-x', ?, ?, 1, '9 rue Étrangère', '21000', 'Dijon', '[]', 'agent:x', '2026-12-01T00:00:00.000Z')",
      [other.id, p.id],
    );
    await t.db.run('PRAGMA foreign_keys = ON');
    const r = await t.visites.schedule(t.as('agent', t.alex.id), { propertyId: p.id, projectId: b.project.id, start: WEDNESDAY_10H });
    if (!r.ok) throw new Error(r.code);
    expect(r.visit.slip).toMatchObject({ status: 'incomplet', missing: ['bien.adresse'] });
    expect(r.visit.slip.content).not.toContain('Étrangère');
  });
});
