import { expect, it } from 'vitest';
import {
  Acces,
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
  return { db, journal, store, visites, network, alex, sam, as, buyer, property, blocked };
}

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
    expect(await t.visites.createSlipTemplate(t.as('direction', 'd1'), 'Visite de {{bien.adresse}} par {{visiteur.nom}} le {{visite.date}}, {{bien.reference}}')).toMatchObject({ ok: false, code: 'unknown_field' });
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
