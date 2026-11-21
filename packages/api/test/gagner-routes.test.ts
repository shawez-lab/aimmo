import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, OLD_CONTACT_PURPOSE, ROLES, RegistreMandats, SqlJournalStore, applyMigrations, fromSyncSqlite, type Role, type SqlDatabase, type Viewer } from '@aimmo/core';
import { Annuaire, MiseEnRelation, type ConsentProofStore } from '../../core/src/partenaires/index.ts';
import { gagnerRoutes, type GagnerServices } from '../src/gagner.ts';
import { MAX_UPLOAD_BYTES } from '../src/partenaires.ts';
import { htmlProblems } from '../../core/src/design/audit.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agents, partenaire, personnes et preuves inventés.
let clock = Date.parse('2027-10-12T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeFiles implements ConsentProofStore {
  readonly refs = new Set<string>(['preuves/facture-reseaux.pdf']);
  put(prefix: string): string {
    const ref = `${prefix}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const files = new FakeFiles();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 1 });
  const s: GagnerServices = { db, journal, acces, now, proofs: files };
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const viewers: Record<Role, Viewer> = {
    agent: { role: 'agent', userId: alex.id, networkId: network.id },
    direction: { role: 'direction', userId: 'dir-1', networkId: network.id },
    compliance: { role: 'compliance', userId: 'c-1', networkId: network.id },
    partner: { role: 'partner', userId: 'p-inconnu', networkId: network.id },
    assistant: { role: 'assistant', userId: 'as-1', networkId: network.id },
    accountant: { role: 'accountant', userId: 'cpt-1', networkId: network.id },
  };
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  const added = await annuaire.addPartner(viewers.direction, { trade: 'notaire', businessName: 'Étude Essai', postcodes: ['21000'] });
  if (!added.ok) throw new Error(added.code);
  const partnerId = added.value.partnerId;
  await annuaire.addCredential(viewers.direction, partnerId, { kind: 'assurance_rcp', number: 'N-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${partnerId}`) });
  viewers.partner = { role: 'partner', userId: partnerId, networkId: network.id };
  // Une mise en relation d'un client d'Alex, confiée à ce partenaire : l'agent qui recevra ses recommandations.
  const client = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Client' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: client.id, kind: 'sell' });
  const r = await relations.propose(viewers.agent, { projectId: project.id, trade: 'notaire', postcode: '21000' });
  if (!r.ok) throw new Error(r.code);
  await relations.recordConsent(viewers.agent, r.value.referralId, { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${r.value.referralId}`) });
  await relations.entrust(viewers.agent, r.value.referralId);
  const routes = gagnerRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const route = routes.find((x) => x.method === method && x.pattern.test(path));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(path) ?? []).slice(1);
    const request = new Request(`https://api.exemple.test/v1${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await route.handle(s, viewer, params, request);
    return { status: response.status, body: (await response.json()) as { ok: boolean; mode?: string; data?: any; code?: string; rule?: string } };
  };
  return { db, journal, store, fiche, acces, s, network, alex, viewers, routes, call, partnerId, files };
}

/** Un exemple d'adresse pour chaque route, et un corps. */
const SAMPLES: Record<string, string> = {
  'gagner.dossier': '/gagner/rendez-vous/r1/dossier',
  'gagner.dossier_page': '/gagner/rendez-vous/r1/dossier/page',
  'gagner.engagement': '/gagner/engagements',
  'gagner.engagements': '/gagner/engagements',
  'gagner.lettres_campagne': '/gagner/lettres',
  'gagner.lettres_liste': '/gagner/lettres',
  'gagner.rendez_vous': '/gagner/rendez-vous',
  'gagner.lettres': '/gagner/lettres/c1',
  'gagner.lettres_impression': '/gagner/lettres/c1/impression',
  'gagner.lettre_deposee': '/gagner/lettres/lettre/l1/deposee',
  'gagner.recommandation': '/gagner/recommandations',
  'gagner.recommandations_envois': '/gagner/recommandations/mes-envois',
  'gagner.recommandations_a_appeler': '/gagner/recommandations/a-appeler',
  'gagner.recommandations_agents': '/gagner/recommandations/agents',
  'gagner.recommandation_attribuer': '/gagner/recommandations/r1/attribuer',
  'gagner.recommandation_appel_fait': '/gagner/recommandations/r1/appel-fait',
  'gagner.fin_de_bail': '/gagner/fiches/p1/fin-de-bail',
  'gagner.fins_de_bail': '/gagner/fiches/p1/fin-de-bail',
  'gagner.relances': '/gagner/relances',
  'gagner.relance_valider': '/gagner/relances/r1/valider',
  'gagner.mesure': '/gagner/mesure/2027-10',
  'gagner.mesure_preuve': '/gagner/mesure/preuves',
  'gagner.mesure_cout': '/gagner/mesure/couts',
  'gagner.mesure_decision': '/gagner/mesure/decisions',
};

describeWithSqlite('G11 · routes de M20 complet', () => {
  it('[R16] chaque route refuse tout rôle non admis avant de lire le corps, et le refus est au journal', async () => {
    const t = await setup();
    expect(t.routes.map((r) => r.name).sort()).toEqual(Object.keys(SAMPLES).sort());
    let refusals = 0;
    for (const route of t.routes) {
      const path = SAMPLES[route.name]!;
      expect(route.pattern.test(path), route.name).toBe(true);
      for (const role of ROLES) {
        if (route.roles.includes(role)) continue;
        const request = new Request(`https://api.exemple.test/v1${path}`, route.method === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' } : { method: 'GET' });
        const response = await route.handle(t.s, t.viewers[role], (route.pattern.exec(path) ?? []).slice(1), request);
        expect(response.status, `${route.name} ${role}`).toBe(403);
        expect(await response.json()).toEqual({ ok: false, rule: 'R16', code: 'role' });
        expect(request.bodyUsed, `${route.name} ${role}`).toBe(false);
        refusals += 1;
      }
    }
    const lines = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && String(e.data.kind).startsWith('route.gagner.'));
    expect(lines).toHaveLength(refusals);
    expect(refusals).toBeGreaterThan(20);
  });

  it('[R38] [R142] parcours : la recommandation d’un partenaire, l’appel, le mandat signé avec sa source, compté dans la mesure', async () => {
    const t = await setup();
    const body = { firstName: 'Hugo', phone: '06 11 22 33 44', projectKind: 'sell', consent: { kind: 'appel_a_trois', channel: 'phone', givenAt: new Date(clock - DAY).toISOString(), reference: 'appel à trois du 11 octobre, noté par l’étude' } };
    expect(await t.call(t.viewers.partner, 'POST', '/gagner/recommandations', body)).toEqual({ status: 200, body: { ok: true, mode: 'essai', data: { recorded: true } } });
    expect((await t.call(t.viewers.partner, 'POST', '/gagner/recommandations', { ...body, consent: undefined })).body).toEqual({ ok: false, rule: 'R142', code: 'no_consent' });
    const list = await t.call(t.viewers.agent, 'GET', '/gagner/recommandations/a-appeler');
    expect(list.body.data).toEqual([expect.objectContaining({ origin: 'partner', firstName: 'Hugo', sourceLabel: 'Recommandé par Étude Essai' })]);
    const item = list.body.data[0];
    expect((await t.call(t.viewers.agent, 'POST', `/gagner/recommandations/${item.recommendationId}/appel-fait`)).status).toBe(200);
    // Le partenaire ne voit que la date de son envoi, rien de la suite [R77].
    expect((await t.call(t.viewers.partner, 'GET', '/gagner/recommandations/mes-envois')).body.data).toEqual([{ createdAt: expect.any(String) }]);
    // Le mandat signé garde la source « recommandation », reprise de la fiche.
    const mandat = await new Mandats(t.db, t.fiche, t.journal, { now: t.s.now }).record(t.acces, t.viewers.agent, { personId: item.personId, signedAt: new Date(clock) });
    expect(mandat).toMatchObject({ ok: true, source: 'referral', fromFiche: true });
    const report = await t.call(t.viewers.direction, 'GET', '/gagner/mesure/2027-10');
    expect(report.body.data.lines.find((l: { source: string }) => l.source === 'referral')).toMatchObject({ mandates: 1 });
    // Ni coordonnée ni prénom de la personne recommandée au journal [R13].
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/06 11|Hugo|appel à trois/);
  });

  it('[R140] [R38] parcours : la lettre de quartier après un mandat signé, déposée, puis le mandat de son destinataire avec la source « lettre de quartier »', async () => {
    const t = await setup();
    const places: Record<string, { lat: number; lon: number }> = { '8 rue des Tilleuls Essai, 21000 Dijon': { lat: 47.322, lon: 5.0415 }, '10 rue des Tilleuls Essai 21000 Dijon': { lat: 47.3222, lon: 5.0415 } };
    t.s.geocoder = { geocode: async (a) => (places[a] ? { label: a, ...places[a]!, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: null, score: 0.9 } : null) };
    const mandats = new Mandats(t.db, t.fiche, t.journal, { now: t.s.now });
    const seller = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Vendeur' });
    const sold = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 90, rooms: 4, priceEur: 260000 });
    expect(await mandats.record(t.acces, t.viewers.agent, { personId: seller.id, propertyId: sold.id, signedAt: new Date(clock), source: 'site' })).toMatchObject({ ok: true });
    const campaign = await t.call(t.viewers.agent, 'POST', '/gagner/lettres', {
      propertyId: sold.id,
      trigger: 'mandat',
      propertyAddress: '8 rue des Tilleuls Essai, 21000 Dijon',
      recipient: 'aux_habitants',
      origin: 'saisie_agent',
      addresses: [{ number: '10', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Dijon' }],
    });
    expect(campaign.body).toMatchObject({ ok: true, data: { letters: 1 } });
    const id = campaign.body.data.campaignId;
    const route = t.routes.find((r) => r.name === 'gagner.lettres_impression')!;
    const printed = await route.handle(t.s, t.viewers.agent, [id], new Request(`https://api.exemple.test/v1/gagner/lettres/${id}/impression`));
    expect(printed.headers.get('content-type')).toContain('text/html');
    expect(htmlProblems(await printed.text(), { print: true })).toEqual([]);
    const letters = await t.call(t.viewers.agent, 'GET', `/gagner/lettres/${id}`);
    expect((await t.call(t.viewers.agent, 'POST', `/gagner/lettres/lettre/${letters.body.data[0].letterId}/deposee`)).status).toBe(200);
    // Les habitants du 10 appellent : leur mandat est rangé avec la source « lettre de quartier » [R38].
    const neighbour = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Voisin' });
    expect(await mandats.record(t.acces, t.viewers.agent, { personId: neighbour.id, signedAt: new Date(clock), source: 'neighbourhood_letter' })).toMatchObject({ ok: true, source: 'neighbourhood_letter' });
    const report = await t.call(t.viewers.direction, 'GET', '/gagner/mesure/2027-10');
    expect(report.body.data.lines.find((l: { source: string }) => l.source === 'neighbourhood_letter')).toMatchObject({ mandates: 1 });
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Tilleuls/);
  });

  it('[R16] [R140] G13 : les listes de l’écran, campagnes et biens permis, estimations à venir, pour le seul agent qui les suit, sans donnée du client', async () => {
    const t = await setup();
    const places: Record<string, { lat: number; lon: number }> = { '8 rue des Tilleuls Essai, 21000 Dijon': { lat: 47.322, lon: 5.0415 }, '10 rue des Tilleuls Essai 21000 Dijon': { lat: 47.3222, lon: 5.0415 } };
    t.s.geocoder = { geocode: async (a) => (places[a] ? { label: a, ...places[a]!, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: null, score: 0.9 } : null) };
    const mandats = new Mandats(t.db, t.fiche, t.journal, { now: t.s.now });
    const bea = await t.store.createAgent({ networkId: t.network.id, firstName: 'Bea', lastName: 'Essai' });
    const beaViewer: Viewer = { role: 'agent', userId: bea.id, networkId: t.network.id };
    const seller = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Vendeuse Secrète' });
    const withMandate = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 90, rooms: 4, priceEur: 260000 });
    await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'T-2', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 50, rooms: 2, priceEur: 150000 });
    const cancelled = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'T-3', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 170000 });
    const beas = await t.store.createProperty({ networkId: t.network.id, agentId: bea.id, reference: 'B-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 70, rooms: 3, priceEur: 190000 });
    expect(await mandats.record(t.acces, t.viewers.agent, { personId: seller.id, propertyId: withMandate.id, signedAt: new Date(clock), source: 'site' })).toMatchObject({ ok: true });
    const c = await mandats.record(t.acces, t.viewers.agent, { personId: seller.id, propertyId: cancelled.id, signedAt: new Date(clock), source: 'site' });
    if (!c.ok) throw new Error('mandat');
    const registre = new RegistreMandats(t.db, t.journal, { now: t.s.now });
    expect(await registre.configure(t.viewers.direction, { prefix: 'T-', firstNumber: 1, width: 4 })).toEqual({ ok: true });
    expect(await registre.inscribe(t.viewers.agent, c.id)).toMatchObject({ ok: true });
    expect(await registre.cancel(t.viewers.direction, c.id, 'error')).toMatchObject({ ok: true });
    const bSeller = await t.store.createPerson({ networkId: t.network.id, agentId: bea.id, firstName: 'Autre' });
    expect(await mandats.record(t.acces, beaViewer, { personId: bSeller.id, propertyId: beas.id, signedAt: new Date(clock), source: 'site' })).toMatchObject({ ok: true });

    // Seul le bien au mandat signé et jamais annulé, de cet agent, peut ouvrir une campagne [R140, R16].
    const empty = await t.call(t.viewers.agent, 'GET', '/gagner/lettres');
    expect(empty.body).toEqual({ ok: true, mode: 'essai', data: { campaigns: [], properties: [{ propertyId: withMandate.id, reference: 'T-1', city: 'Dijon', triggers: ['mandat'] }] } });
    const made = await t.call(t.viewers.agent, 'POST', '/gagner/lettres', {
      propertyId: withMandate.id,
      trigger: 'mandat',
      propertyAddress: '8 rue des Tilleuls Essai, 21000 Dijon',
      recipient: 'aux_habitants',
      origin: 'saisie_agent',
      addresses: [{ number: '10', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Dijon' }],
    });
    expect(made.body).toMatchObject({ ok: true, data: { letters: 1 } });
    const after = await t.call(t.viewers.agent, 'GET', '/gagner/lettres');
    expect(after.body.data.campaigns).toEqual([{ campaignId: made.body.data.campaignId, propertyId: withMandate.id, reference: 'T-1', trigger: 'mandat', recipient: 'aux_habitants', createdAt: expect.any(String), letters: 1, deposited: 0 }]);
    // Aucune adresse dans la liste : seulement des comptes.
    expect(JSON.stringify(after.body)).not.toMatch(/Tilleuls|Vendeuse/);
    const letters = await t.call(t.viewers.agent, 'GET', `/gagner/lettres/${made.body.data.campaignId}`);
    await t.call(t.viewers.agent, 'POST', `/gagner/lettres/lettre/${letters.body.data[0].letterId}/deposee`);
    expect((await t.call(t.viewers.agent, 'GET', '/gagner/lettres')).body.data.campaigns[0]).toMatchObject({ letters: 1, deposited: 1 });
    // Une autre agente ne voit ni la campagne ni les biens d'Alex.
    expect((await t.call(beaViewer, 'GET', '/gagner/lettres')).body.data).toEqual({ campaigns: [], properties: [{ propertyId: beas.id, reference: 'B-1', city: 'Dijon', triggers: ['mandat'] }] });

    // Les estimations à venir : prévues, de trois heures avant à quinze jours après, dans l'ordre des heures.
    const H = 3_600_000;
    let k = 0;
    const appointment = async (kind: string, startAt: number, agentId = t.alex.id, status = 'booked') => {
      const id = `rdv-${++k}`;
      const at = new Date(clock).toISOString();
      await t.db.run(
        `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, replaces_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', NULL, ?, ?)`,
        [id, t.network.id, agentId, seller.id, withMandate.id, kind, new Date(startAt).toISOString(), new Date(startAt + H).toISOString(), status, `h-${k}`, at, at],
      );
      return id;
    };
    const base = clock + 10 * 60_000;
    const inTwoDays = await appointment('estimation', base + 2 * DAY);
    const oneHourAgo = await appointment('estimation', base - H);
    await appointment('estimation', base - 4 * H);
    await appointment('estimation', base + 16 * DAY);
    await appointment('visite', base + DAY);
    await appointment('estimation', base + DAY, t.alex.id, 'cancelled');
    await appointment('estimation', base + DAY, bea.id);
    const upcoming = await t.call(t.viewers.agent, 'GET', '/gagner/rendez-vous');
    expect(upcoming.body.data.map((a: { appointmentId: string }) => a.appointmentId)).toEqual([oneHourAgo, inTwoDays]);
    expect(upcoming.body.data[1]).toEqual({ appointmentId: inTwoDays, startAt: new Date(base + 2 * DAY).toISOString(), endAt: new Date(base + 2 * DAY + H).toISOString(), reference: 'T-1', city: 'Dijon' });
    expect(JSON.stringify(upcoming.body)).not.toMatch(/Vendeuse|person/);
    expect((await t.call(beaViewer, 'GET', '/gagner/rendez-vous')).body.data).toHaveLength(1);
    // Les lectures sont au journal, sans adresse ni nom.
    const types = (await t.journal.all()).map((e) => e.type);
    expect(types).toContain('lettres_quartier.liste_lue');
    expect(types).toContain('dossier_presentation.rendez_vous_lus');
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Tilleuls|Vendeuse/);
  });

  it('[R26] [R143] relances et mesure par les routes : en mode essai, rien ne part ; un coût sans preuve est refusé', async () => {
    const t = await setup();
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Inès' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: 'ines@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: p.id, purpose: OLD_CONTACT_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - 100 * DAY) });
    expect((await t.call(t.viewers.agent, 'POST', `/gagner/fiches/${p.id}/fin-de-bail`, { onDay: '2027-11-20' })).status).toBe(200);
    const { AnciensContacts } = await import('@aimmo/core');
    expect(await new AnciensContacts(t.db, t.journal, { now: t.s.now }).prepareMonth(t.network.id)).toBe(1);
    const relances = await t.call(t.viewers.agent, 'GET', '/gagner/relances');
    expect(relances.body.data).toEqual([expect.objectContaining({ firstName: 'Inès', reason: 'fin_de_bail' })]);
    const done = await t.call(t.viewers.agent, 'POST', `/gagner/relances/${relances.body.data[0].followupId}/valider`, {});
    expect(done).toEqual({ status: 200, body: { ok: true, mode: 'essai', data: { status: 'essai', rule: null, delivered: false } } });
    expect((await t.call(t.viewers.direction, 'POST', '/gagner/mesure/couts', { month: '2027-10', source: 'social', amountCents: 1000, proofRef: 'preuves/absente.pdf' })).body).toEqual({ ok: false, rule: 'R144', code: 'no_proof' });
    expect((await t.call(t.viewers.direction, 'POST', '/gagner/mesure/couts', { month: '2027-10', source: 'social', amountCents: 1000, proofRef: 'preuves/facture-reseaux.pdf' })).status).toBe(200);
    expect((await t.call(t.viewers.direction, 'POST', '/gagner/mesure/decisions', { month: '2027-10', source: 'social', decision: 'garder', reason: 'À revoir le mois prochain' })).status).toBe(200);
    expect((await t.call(t.viewers.direction, 'POST', '/gagner/mesure/decisions', 'pas un objet')).body).toEqual({ ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
  });

  it('[R16] [R141] la direction lit la dernière version de chaque engagement, actif ou non ; un agent, non', async () => {
    const t = await setup();
    expect((await t.call(t.viewers.direction, 'GET', '/gagner/engagements')).body.data).toEqual([]);
    const base = { code: 'compte_rendu', label: 'Compte rendu après chaque visite', measure: 'compte_rendu_visite', delayHours: 48, active: true };
    expect((await t.call(t.viewers.direction, 'POST', '/gagner/engagements', base)).body.data).toEqual({ version: 1 });
    expect((await t.call(t.viewers.direction, 'POST', '/gagner/engagements', { ...base, delayHours: 24, active: false })).body.data).toEqual({ version: 2 });
    const read = await t.call(t.viewers.direction, 'GET', '/gagner/engagements');
    expect(read.body.data).toEqual([expect.objectContaining({ code: 'compte_rendu', version: 2, delayHours: 24, active: false, measure: 'compte_rendu_visite', rule: expect.stringContaining('visite') })]);
    expect((await t.call(t.viewers.agent, 'GET', '/gagner/engagements')).status).toBe(403);
  });

  it('[R16] [R17] la dernière fin de bail notée se relit en tête, et l’agent d’une autre fiche ne lit rien', async () => {
    const t = await setup();
    const person = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Lise' });
    const path = `/gagner/fiches/${person.id}/fin-de-bail`;
    await t.call(t.viewers.agent, 'POST', path, { onDay: '2027-11-15' });
    await t.call(t.viewers.agent, 'POST', path, { onDay: '2028-06-30' });
    const read = await t.call(t.viewers.agent, 'GET', path);
    expect(read.body.data.map((d: { onDay: string }) => d.onDay)).toEqual(['2028-06-30', '2027-11-15']);
    const bea = await t.store.createAgent({ networkId: t.network.id, firstName: 'Béa', lastName: 'Essai' });
    expect((await t.call({ ...t.viewers.agent, userId: bea.id }, 'GET', path)).status).toBe(403);
    expect((await t.call(t.viewers.direction, 'GET', path)).status).toBe(403);
  });

  describe('G14 · dépôt de la preuve d’un coût', () => {
    const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const route = gagnerRoutes().find((r) => r.name === 'gagner.mesure_preuve')!;
    const post = (type: string, body: Uint8Array, headers: Record<string, string> = {}) =>
      new Request('https://api.exemple.test/v1/gagner/mesure/preuves', { method: 'POST', headers: { 'content-type': type, ...headers }, body });
    const stored = () => {
      const puts: { ref: string; type: string; size: number }[] = [];
      return { puts, uploads: { put: async (ref: string, bytes: Uint8Array, type: string) => void puts.push({ ref, type, size: bytes.byteLength }) } };
    };

    it('[R144] la preuve déposée porte une référence choisie par le serveur, et le coût la reprend', async () => {
      const t = await setup();
      const { puts, uploads } = stored();
      const r = await route.handle({ ...t.s, uploads }, t.viewers.direction, [], post('application/pdf', PDF));
      expect(r.status).toBe(200);
      const { data } = (await r.json()) as { data: { proofRef: string } };
      expect(data.proofRef).toMatch(new RegExp(`^mesure-sources/${t.network.id}/[0-9a-f-]{36}\\.pdf$`));
      expect(puts).toEqual([{ ref: data.proofRef, type: 'application/pdf', size: PDF.byteLength }]);
      t.files.refs.add(data.proofRef);
      const cost = await t.call(t.viewers.direction, 'POST', '/gagner/mesure/couts', { month: '2027-10', source: 'social', amountCents: 1999, proofRef: data.proofRef });
      expect(cost.body).toEqual({ ok: true, mode: 'essai', data: { version: 1 } });
    });

    it('[R16] un agent, un partenaire ou la conformité ne déposent rien, et le fichier n’est pas lu', async () => {
      const t = await setup();
      const { puts, uploads } = stored();
      for (const role of ['agent', 'partner', 'compliance'] as const) {
        const request = post('application/pdf', PDF);
        const r = await route.handle({ ...t.s, uploads }, t.viewers[role], [], request);
        expect(r.status).toBe(403);
        expect(request.bodyUsed).toBe(false);
      }
      expect(puts).toEqual([]);
    });

    it('un autre format, un faux PDF, un fichier trop lourd ou l’absence de stockage ne rangent rien', async () => {
      const t = await setup();
      const { puts, uploads } = stored();
      const code = async (s: GagnerServices, request: Request) => {
        const r = await route.handle(s, t.viewers.direction, [], request);
        return [r.status, ((await r.json()) as { code: string }).code];
      };
      const s = { ...t.s, uploads };
      expect(await code(s, post('image/gif', PDF))).toEqual([415, 'bad_type']);
      expect(await code(s, post('application/pdf', new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c])))).toEqual([415, 'bad_type']);
      expect(await code(s, post('image/png', PDF))).toEqual([415, 'bad_type']);
      expect(await code(s, post('application/pdf', new Uint8Array(0)))).toEqual([415, 'bad_type']);
      expect(await code(s, post('application/pdf', PDF, { 'content-length': String(MAX_UPLOAD_BYTES + 1) }))).toEqual([413, 'too_large']);
      expect(await code(s, post('application/pdf', new Uint8Array(MAX_UPLOAD_BYTES + 1)))).toEqual([413, 'too_large']);
      expect(await code({ ...t.s, uploads: null }, post('application/pdf', PDF))).toEqual([503, 'storage_unavailable']);
      expect(await code(t.s, post('application/pdf', PDF))).toEqual([503, 'storage_unavailable']);
      expect(puts).toEqual([]);
    });

    it('[R13] le journal garde l’empreinte seule : ni la référence, ni le nom du fichier', async () => {
      const t = await setup();
      const { uploads } = stored();
      const r = await route.handle({ ...t.s, uploads }, t.viewers.direction, [], post('application/pdf', PDF, { 'content-disposition': 'attachment; filename="facture-secrete.pdf"' }));
      const { data } = (await r.json()) as { data: { proofRef: string } };
      const rows = await t.journal.all();
      const event = rows.find((e) => e.type === 'mesure_sources.preuve')!;
      expect(Object.keys(event.data).sort()).toEqual(['rule', 'sha256']);
      const all = JSON.stringify(rows);
      expect(all).not.toContain(data.proofRef);
      expect(all).not.toContain('facture-secrete');
    });
  });
});
