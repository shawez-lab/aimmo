import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, OLD_CONTACT_PURPOSE, ROLES, SqlJournalStore, applyMigrations, fromSyncSqlite, type Role, type SqlDatabase, type Viewer } from '@aimmo/core';
import { Annuaire, MiseEnRelation, type ConsentProofStore } from '../../core/src/partenaires/index.ts';
import { gagnerRoutes, type GagnerServices } from '../src/gagner.ts';
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
  return { db, journal, store, fiche, acces, s, network, alex, viewers, routes, call, partnerId };
}

/** Un exemple d'adresse pour chaque route, et un corps. */
const SAMPLES: Record<string, string> = {
  'gagner.lettres_campagne': '/gagner/lettres',
  'gagner.lettres': '/gagner/lettres/c1',
  'gagner.lettres_impression': '/gagner/lettres/c1/impression',
  'gagner.lettre_deposee': '/gagner/lettres/lettre/l1/deposee',
  'gagner.recommandation': '/gagner/recommandations',
  'gagner.recommandations_envois': '/gagner/recommandations/mes-envois',
  'gagner.recommandations_a_appeler': '/gagner/recommandations/a-appeler',
  'gagner.recommandation_attribuer': '/gagner/recommandations/r1/attribuer',
  'gagner.recommandation_appel_fait': '/gagner/recommandations/r1/appel-fait',
  'gagner.fin_de_bail': '/gagner/fiches/p1/fin-de-bail',
  'gagner.relances': '/gagner/relances',
  'gagner.relance_valider': '/gagner/relances/r1/valider',
  'gagner.mesure': '/gagner/mesure/2027-10',
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
});
