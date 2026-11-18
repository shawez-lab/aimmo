import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, RemiseAudit, RendezVous, SqlJournalStore, Visites, applyMigrations, fromSyncSqlite, verifyChain, type DiffusionGate, type SqlDatabase } from '../src/index.ts';
import type { EnergyClass, PropertySheet } from '../src/annonces/index.ts';
import { Annuaire, EspacePartenaire, MiseEnRelation, PiecesPartenaires, type ConsentProofStore } from '../src/partenaires/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU010b · L'audit énergétique remis à l'acquéreur dès la première visite (art. L126-28-1 du CCH, lu le 2026-11-18).
// Réseau, agents, clients, bien et partenaires inventés.

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const WEDNESDAY_10H = new Date('2026-12-09T09:00:00.000Z');
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const TEMPLATE = 'BON DE VISITE · {{visiteur.nom}} a visité le bien {{bien.reference}} le {{visite.date}}.';
const SHA = 'a'.repeat(64);
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeStore implements ConsentProofStore {
  readonly refs = new Set<string>();
  put(prefix: string): string {
    const ref = `${prefix}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

const sheetWith = (energyClass: EnergyClass | null, coownership: PropertySheet['coownership'] = { isCoownership: false }, diagnosedOn = '2026-05-10'): PropertySheet => ({
  characteristics: { bedrooms: 3, floor: null, floorsTotal: 2, buildYear: 1975, heating: 'fioul', outdoor: ['jardin'], landM2: 600, parkingSpaces: null, elevator: false },
  energy: energyClass ? { energyClass, climateClass: energyClass, annualCostMinEur: 2100, annualCostMaxEur: 2900, costReferenceYear: 2023, diagnosedOn } : null,
  coownership,
  risks: null,
  media: [],
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const diffusion: DiffusionGate = { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) };
  const rdv = new RendezVous(db, journal, { now });
  const visites = new Visites(db, journal, acces, { diffusion, rendezVous: rdv, now });
  const remise = new RemiseAudit(db, journal, acces, { now, newId: uuid });
  const files = new FakeStore();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 1 });
  const space = new EspacePartenaire(db, annuaire, relations, journal, { now });
  const pieces = new PiecesPartenaires(db, space, relations, annuaire, files, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction', userId: string) => ({ role, userId, networkId: network.id });
  const dir = as('direction', 'dir-1');
  await rdv.setAvailability(as('agent', alex.id), WEEK);
  await visites.createSlipTemplate(dir, TEMPLATE);
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Vendeur', lastName: 'Inventé' });
  const sellProject = await store.createProject({ networkId: network.id, agentId: alex.id, personId: owner.id, kind: 'sell' });
  const property = async (kind: 'home' | 'building' = 'home', sheet: PropertySheet | null = sheetWith('F')) => {
    const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `B-${++n}`, kind, postalCode: '21240', city: 'Talant', priceEur: 280_000, surfaceM2: 95, rooms: 4, status: 'available' });
    await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: sellProject.id, propertyId: p.id, role: 'owned' });
    if (sheet) await db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', [uuid(), p.id, network.id, JSON.stringify(sheet), 'agent:x', now().toISOString()]);
    return p;
  };
  const buyer = async (firstName: string) => {
    const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, lastName: 'Durand' });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'buy' });
    return { person, project };
  };
  const visit = async (propertyId: string, projectId: string, start = WEDNESDAY_10H) => {
    const r = await visites.schedule(as('agent', alex.id), { propertyId, projectId, start });
    if (!r.ok) throw new Error(r.code);
    return r.visit;
  };
  const day = (offset = 0): string => new Date(clock + offset * 86_400_000).toISOString().slice(0, 10);
  /** Un diagnostiqueur DPE de la zone, avec ou sans la mention « audit énergétique », à qui le vendeur confie l'audit. */
  const diagnostiqueur = async (auditMention: boolean) => {
    const r = await annuaire.addPartner(dir, { trade: 'diagnostiqueur', businessName: 'Diag Inventé', postcodes: ['21240'] });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.partnerId;
    await annuaire.addCredential(dir, id, { kind: 'assurance_rcp', number: 'N-1', validFrom: day(-60), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) });
    const c = await annuaire.addCredential(dir, id, { kind: 'certification_diagnostic', domain: 'dpe', number: 'C-1', validFrom: day(-60), validUntil: day(300), proofRef: files.put(`partenaires/${id}`), auditMention });
    if (!c.ok) throw new Error(c.code);
    return id;
  };
  const entrust = async (partnerId: string, propertyId: string) => {
    const r = await relations.propose(as('agent', alex.id), { projectId: sellProject.id, trade: 'diagnostiqueur', domain: 'dpe', propertyId, postcode: '21240' });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.referralId;
    clock += 1000;
    const c = await relations.recordConsent(as('agent', alex.id), id, { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${id}`) });
    if (!c.ok) throw new Error(c.code);
    await relations.entrust(as('agent', alex.id), id);
    return id;
  };
  const depositAudit = (partnerId: string, referralId: string, issuedOn = day(-1)) =>
    pieces.deposit({ role: 'partner', userId: partnerId, networkId: network.id }, referralId, { sort: 'audit_energetique', ref: files.put(`partenaires/${partnerId}/relations/${referralId}`), sha256: SHA, issuedOn });
  const tick = (ms: number) => (clock += ms);
  return { db, journal, store, fiche, visites, remise, annuaire, network, alex, sam, as, dir, property, buyer, visit, diagnostiqueur, entrust, depositAudit, day, tick };
}

describeWithSqlite('AU010b · audit énergétique remis dès la première visite', () => {
  it('[R60] visite d’une maison classée F sans audit au bien : l’agent est prévenu dès la prise de visite, puis avant la visite', async () => {
    const t = await setup();
    const p = await t.property('home', sheetWith('F'));
    const b = await t.buyer('Inès');
    const v = await t.visit(p.id, b.project.id);
    expect(v.energyAudit).toMatchObject({ case: 'requis', energyClass: 'F', audit: null, handover: null, action: 'faire_faire', visitDay: '2026-12-09' });
    expect(v.energyAudit.message).toContain('absent du bien');
    const n = await t.remise.notice(t.as('agent', t.alex.id), v.appointment.id);
    expect(n).toEqual({ ok: true, value: v.energyAudit });
    // Un immeuble d'habitation d'un seul propriétaire aussi.
    const imm = await t.property('building', sheetWith('G'));
    expect((await t.visit(imm.id, b.project.id, new Date(WEDNESDAY_10H.getTime() + 2 * 3_600_000))).energyAudit.action).toBe('faire_faire');
  });

  it('[R60] lot de copropriété, classe non soumise ou local : rien n’est demandé, et une remise n’y est pas rangée', async () => {
    const t = await setup();
    const b = await t.buyer('Léo');
    const lot = await t.property('home', sheetWith('G', { isCoownership: true, lots: 12, annualChargesEur: 1500, proceedings: false }));
    const v = await t.visit(lot.id, b.project.id);
    expect(v.energyAudit).toMatchObject({ case: 'non_requis', action: 'aucune', energyClass: null });
    expect(v.energyAudit.message).toBe('Aucun audit énergétique à remettre pour ce bien.');
    expect(await t.remise.recordHandover(t.as('agent', t.alex.id), v.appointment.id, { handedOn: t.day(), means: 'papier' })).toEqual({ ok: false, rule: 'R60', code: 'not_required' });
    const c = await t.property('home', sheetWith('C'));
    expect((await t.visit(c.id, b.project.id, new Date(WEDNESDAY_10H.getTime() + 2 * 3_600_000))).energyAudit.action).toBe('aucune');
    expect(await t.db.all('SELECT * FROM visit_energy_audit_handovers')).toEqual([]);
  });

  it('[R60] une classe inconnue, ou lue sur un DPE d’avant juillet 2021, est dite à l’agent', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const sans = await t.property('home', sheetWith(null));
    const v = await t.visit(sans.id, b.project.id);
    expect(v.energyAudit).toMatchObject({ case: 'inconnu', action: 'preciser_classe' });
    expect(v.energyAudit.message).toContain('Classe énergie du bien inconnue');
    const ancien = await t.property('home', sheetWith('B', { isCoownership: false }, '2020-03-01'));
    expect((await t.visit(ancien.id, b.project.id, new Date(WEDNESDAY_10H.getTime() + 2 * 3_600_000))).energyAudit.action).toBe('preciser_classe');
    const sansFiche = await t.property('home', null);
    expect((await t.visit(sansFiche.id, b.project.id, new Date(WEDNESDAY_10H.getTime() + 4 * 3_600_000))).energyAudit.case).toBe('inconnu');
  });

  it('[R73] dépôt de l’audit par un diagnostiqueur certifié DPE avec mention : rangé à la fiche du bien, puis à remettre', async () => {
    const t = await setup();
    const p = await t.property('home', sheetWith('E'));
    const partner = await t.diagnostiqueur(true);
    const referral = await t.entrust(partner, p.id);
    const d = await t.depositAudit(partner, referral);
    expect(d).toMatchObject({ ok: true, value: { sort: 'audit_energetique', destination: 'property', targetId: p.id, piece: 'audit_energetique', reason: 'rule' } });
    const b = await t.buyer('Inès');
    const v = await t.visit(p.id, b.project.id);
    expect(v.energyAudit).toMatchObject({ case: 'requis', energyClass: 'E', action: 'remettre', audit: { issuedOn: t.day(-1), validUntil: '2031-12-06', valid: true } });
    expect(v.energyAudit.message).toContain('à remettre au visiteur');
  });

  it('[R73] un diagnostiqueur certifié DPE sans la mention ne range pas l’audit : il va à la file de l’agent, avec la raison', async () => {
    const t = await setup();
    const p = await t.property('home', sheetWith('F'));
    const partner = await t.diagnostiqueur(false);
    const referral = await t.entrust(partner, p.id);
    expect(await t.depositAudit(partner, referral)).toMatchObject({ ok: true, value: { destination: 'agent_queue', piece: null, reason: 'audit_mention_not_valid_on_date' } });
    const b = await t.buyer('Inès');
    expect((await t.visit(p.id, b.project.id)).energyAudit.action).toBe('faire_faire');
    // La mention ne se coche que sur une certification DPE.
    const r = await t.annuaire.addPartner(t.dir, { trade: 'diagnostiqueur', businessName: 'Autre Diag', postcodes: ['21240'] });
    if (!r.ok) throw new Error(r.code);
    expect(await t.annuaire.addCredential(t.dir, r.value.partnerId, { kind: 'certification_diagnostic', domain: 'amiante', number: 'C-2', validFrom: t.day(-1), validUntil: t.day(200), proofRef: 'x', auditMention: true })).toEqual({ ok: false, rule: 'R73', code: 'mention_not_for_domain' });
    expect(await t.annuaire.addCredential(t.dir, r.value.partnerId, { kind: 'certification_diagnostic', domain: 'dpe', number: 'C-2', validFrom: t.day(-1), validUntil: t.day(200), proofRef: 'x', auditMention: 'oui' })).toEqual({ ok: false, rule: null, code: 'bad_mention' });
  });

  it('[R60] un audit périmé le jour de la visite fait demander un nouvel audit', async () => {
    const t = await setup();
    const p = await t.property('home', sheetWith('G'));
    const partner = await t.diagnostiqueur(true);
    const referral = await t.entrust(partner, p.id);
    // Un audit fait il y a un peu plus de 5 ans, quand la certification du diagnostiqueur, elle, ne couvre pas : il va à
    // la file. On range donc l'audit à un dossier de vente du bien, daté de 2021.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('dossier-ancien', ?, ?, 'offre-x', 'p-x', 200000, '2021-11-01T10:00:00.000Z', 'agent:x')", [t.network.id, p.id]);
    await t.db.run("INSERT INTO sale_file_pieces (id, file_id, network_id, piece, version, ref, issued_on, received_at, by) VALUES ('piece-1', 'dossier-ancien', ?, 'audit_energetique', 1, 'ref-ancienne.pdf', '2021-12-01', '2021-12-02T10:00:00.000Z', 'agent:x')", [t.network.id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    const b = await t.buyer('Inès');
    const v = await t.visit(p.id, b.project.id);
    expect(v.energyAudit).toMatchObject({ action: 'faire_faire', audit: { issuedOn: '2021-12-01', validUntil: '2026-11-30', valid: false } });
    expect(v.energyAudit.message).toContain('daté du 01/12/2021, ne vaut plus');
    // Le nouvel audit, déposé ensuite, le remplace.
    expect(await t.depositAudit(partner, referral)).toMatchObject({ ok: true, value: { destination: 'property' } });
    expect(await t.remise.notice(t.as('agent', t.alex.id), v.appointment.id)).toMatchObject({ ok: true, value: { action: 'remettre', audit: { issuedOn: t.day(-1), valid: true } } });
  });

  it('[R10] la remise se range avec la date et le moyen déclarés, jamais inventés, une fois ; elle vaut pour les visites suivantes du même visiteur', async () => {
    const t = await setup();
    const p = await t.property('home', sheetWith('F'));
    const partner = await t.diagnostiqueur(true);
    const referral = await t.entrust(partner, p.id);
    const doc = await t.depositAudit(partner, referral);
    if (!doc.ok) throw new Error(doc.code);
    const b = await t.buyer('Inès');
    const v = await t.visit(p.id, b.project.id);
    const agent = t.as('agent', t.alex.id);
    // Sans date, ou avec une date fausse, future ou trop ancienne : rien n'est rangé.
    expect(await t.remise.recordHandover(agent, v.appointment.id, { handedOn: undefined, means: 'papier' })).toEqual({ ok: false, rule: 'R10', code: 'date_required' });
    expect(await t.remise.recordHandover(agent, v.appointment.id, { handedOn: '2026-02-30', means: 'papier' })).toEqual({ ok: false, rule: 'R10', code: 'date_required' });
    expect(await t.remise.recordHandover(agent, v.appointment.id, { handedOn: '2026-12-09', means: 'papier' })).toEqual({ ok: false, rule: 'R10', code: 'date_in_future' });
    expect(await t.remise.recordHandover(agent, v.appointment.id, { handedOn: '2026-11-01', means: 'papier' })).toEqual({ ok: false, rule: 'R10', code: 'date_too_early' });
    expect(await t.remise.recordHandover(agent, v.appointment.id, { handedOn: '2026-12-08', means: 'pigeon' })).toEqual({ ok: false, rule: null, code: 'bad_means' });
    expect(await t.db.all('SELECT * FROM visit_energy_audit_handovers')).toEqual([]);
    // La veille, par mail : rangée telle que déclarée, avec la référence de l'audit du bien.
    const r = await t.remise.recordHandover(agent, v.appointment.id, { handedOn: '2026-12-08', means: 'mail' });
    expect(r).toMatchObject({ ok: true, value: { action: 'deja_remis', handover: { appointmentId: v.appointment.id, handedOn: '2026-12-08', means: 'mail' } } });
    if (r.ok) expect(r.value.message).toBe('Audit énergétique déjà remis à ce visiteur le 08/12/2026.');
    const row = await t.db.first<{ handed_on: string; means: string; audit_ref: string | null; recorded_by: string }>('SELECT handed_on, means, audit_ref, recorded_by FROM visit_energy_audit_handovers');
    expect(row).toMatchObject({ handed_on: '2026-12-08', means: 'mail', recorded_by: `agent:${t.alex.id}` });
    expect(row?.audit_ref).toMatch(/^partenaires\/.+\.pdf$/);
    // Une seule fois par visite [R17] ; rien ne change ni ne s'efface.
    expect(await t.remise.recordHandover(agent, v.appointment.id, { handedOn: '2026-12-08', means: 'papier' })).toEqual({ ok: false, rule: null, code: 'already_recorded' });
    await expect(t.db.run("UPDATE visit_energy_audit_handovers SET handed_on = '2026-12-01'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM visit_energy_audit_handovers')).rejects.toThrow(/rien ne s'efface/);
    // La deuxième visite du même visiteur : déjà remis. Un autre visiteur : à remettre.
    expect((await t.visit(p.id, b.project.id, new Date(WEDNESDAY_10H.getTime() + 2 * 3_600_000))).energyAudit.action).toBe('deja_remis');
    const autre = await t.buyer('Hugo');
    expect((await t.visit(p.id, autre.project.id, new Date(WEDNESDAY_10H.getTime() + 4 * 3_600_000))).energyAudit.action).toBe('remettre');
    // Au journal : la date et le moyen, sans nom ni document [R13].
    const events = await t.journal.all();
    const ev = events.find((e) => e.type === 'visite.audit_remis');
    expect(ev?.data).toEqual({ rule: 'R60', handedOn: '2026-12-08', means: 'mail', withDocument: true });
    expect(JSON.stringify(ev)).not.toContain('Inès');
    expect((await verifyChain(events)).ok).toBe(true);
  });

  it('[R16] seuls l’agent de la visite et la direction lisent l’avis et rangent la remise ; une visite annulée ne se note pas', async () => {
    const t = await setup();
    const p = await t.property('home', sheetWith('F'));
    const b = await t.buyer('Inès');
    const v = await t.visit(p.id, b.project.id);
    expect(await t.remise.notice(t.as('agent', t.sam.id), v.appointment.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.remise.recordHandover(t.as('agent', t.sam.id), v.appointment.id, { handedOn: '2026-12-08', means: 'papier' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.remise.notice({ role: 'partner', userId: 'x', networkId: t.network.id } as never, v.appointment.id)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.remise.notice({ role: 'agent', userId: t.alex.id, networkId: 'autre-reseau' }, v.appointment.id)).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    expect(await t.remise.notice(t.dir, v.appointment.id)).toMatchObject({ ok: true, value: { action: 'faire_faire' } });
    await t.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [new Date(TUESDAY_10H).toISOString(), v.appointment.id]);
    expect(await t.remise.recordHandover(t.dir, v.appointment.id, { handedOn: '2026-12-08', means: 'papier' })).toEqual({ ok: false, rule: null, code: 'visit_not_held' });
  });
});
