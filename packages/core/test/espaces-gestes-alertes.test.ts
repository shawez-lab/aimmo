import { expect, it } from 'vitest';
import { Acces, Alertes, FicheAcquereur, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type DiffusionGate, type SqlDatabase } from '../src/index.ts';
import { ALERT_PURPOSE } from '../src/acquereurs/alertes.ts';
import { GestesModules, type ClientViewer } from '../src/espaces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi à 10 h, heure de Paris ; acquéreur et bien inventés.
const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const BASE = 'https://aimmo.example.test/alertes/desinscription/';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(TUESDAY_10H);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const diffusion: DiffusionGate = { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) };
  // Les canaux du mode essai : rien ne part, tout est rangé dans la boîte d'essai [R26].
  const alertes = new Alertes(db, journal, { now, diffusion, unsubscribeBase: BASE });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'd1', networkId: network.id };
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bruno' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: 'bruno@example.test' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'buy' });
  const r = await new FicheAcquereur(db, journal, { now }).update(acces, direction, project.id, { propertyKinds: ['house'], communes: ['Talant'], budgetMaxEur: 300_000 });
  if (!r.ok) throw new Error(r.code);
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'B-1', kind: 'home', dwelling: 'house', city: 'Talant', priceEur: 280_000, surfaceM2: 95, rooms: 4, status: 'available' });
  const unused = async () => { throw new Error('non appelé'); };
  const gestes = new GestesModules({ db, journal, fiche, consents: store, visites: { schedule: unused }, offres: { record: unused }, financement: { declareByBuyer: unused }, signedOffers: { has: async () => false } }, { now });
  const viewer: ClientViewer = { kind: 'client', networkId: network.id, personId: person.id, sessionId: 's-bruno', sides: ['acquereur'] };
  const outbox = () => db.all<{ body: string; channel: string }>('SELECT m.body, m.channel FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ?', [person.id]);
  /** Les messages de la personne hors de la boîte d'essai : ce qui serait vraiment parti. */
  const realSends = async () => Number((await db.first<{ n: number }>('SELECT count(*) AS n FROM messages WHERE person_id = ? AND id NOT IN (SELECT message_id FROM trial_outbox)', [person.id]))?.n ?? 0);
  return { db, alertes, gestes, viewer, network, property, outbox, realSends };
}

describeWithSqlite('EC10 · alertes demandées depuis l’espace, envoyées par M08', () => {
  it('[R49] [R03] [R26] sans demande aucune alerte ; un refus de l’espace n’en fait aucune ; après la demande, l’alerte passe par le contrôle central avec sa désinscription, en essai', async () => {
    const t = await setup();
    await t.alertes.forProperty(t.network.id, t.property.id);
    expect(await t.outbox()).toEqual([]);
    expect(await t.gestes.requestAlerts(t.viewer, {})).toMatchObject({ ok: false, rule: 'R03' });
    await t.alertes.forProperty(t.network.id, t.property.id);
    expect(await t.outbox()).toEqual([]);
    expect(await t.gestes.requestAlerts(t.viewer, { accepted: true })).toEqual({ ok: true, value: { requested: true } });
    // Le geste lui-même n'envoie rien : M08 envoie à son passage.
    expect(await t.outbox()).toEqual([]);
    await t.alertes.forProperty(t.network.id, t.property.id);
    const box = await t.outbox();
    expect(box).toHaveLength(1);
    expect(box[0]!.channel).toBe('email');
    expect(box[0]!.body).toContain(BASE);
    expect(await t.realSends()).toBe(0);
  });

  it('[R03] [R49] une demande refaite est rangée et rouvre l’envoi quand la ligne ouverte est plus ancienne qu’un retrait (AC07), et un accord qui compte n’est pas doublé', async () => {
    const t = await setup();
    const store = new FicheClient(t.db);
    const personId = t.viewer.personId;
    // Un retrait sur la fiche, un accord plus ancien resté ouvert sur son doublon, puis la fusion.
    const twin = await store.createPerson({ networkId: t.network.id, firstName: 'Doublon' });
    await store.addConsent({ networkId: t.network.id, personId: twin.id, purpose: ALERT_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-02T00:00:00.000Z') });
    const old = await store.addConsent({ networkId: t.network.id, personId, purpose: ALERT_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-01T00:00:00.000Z') });
    await store.withdrawConsent(old.id, new Date('2020-02-01T00:00:00.000Z'));
    await new FicheUnique(t.db, new FicheClient(t.db)).merge({ survivorId: personId, mergedId: twin.id, reason: 'identifiant commun' });
    const lines = () => t.db.all<{ id: string }>('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [personId, ALERT_PURPOSE]);
    await t.alertes.forProperty(t.network.id, t.property.id);
    expect(await t.outbox()).toEqual([]);
    expect(await t.gestes.requestAlerts(t.viewer, { accepted: true })).toEqual({ ok: true, value: { requested: true } });
    expect(await lines()).toHaveLength(2);
    await t.gestes.requestAlerts(t.viewer, { accepted: true });
    expect(await lines()).toHaveLength(2);
    await t.alertes.forProperty(t.network.id, t.property.id);
    expect((await t.outbox()).length).toBeGreaterThan(0);
  });
});
