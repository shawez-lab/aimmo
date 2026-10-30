import { expect, it } from 'vitest';
import {
  Acces,
  AnciensContacts,
  ControleBaseLegale,
  FicheClient,
  FicheUnique,
  Mandats,
  OLD_CONTACT_PURPOSE,
  PlanDuJour,
  PlansDuJour,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type Geocoder,
  type SqlDatabase,
  type Viewer,
} from '@aimmo/core';
import { Annuaire, MiseEnRelation, type ConsentProofStore } from '../../core/src/partenaires/index.ts';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { OLD_CONTACTS_JOB, SOURCE_MEASURE_JOB, gagnerJobs } from '../src/gagner.ts';
import { runScheduler } from '../src/planificateur.ts';
import { sha256Hex } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, partenaire, personnes, adresses, preuves et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const DAY = 86_400_000;
// Un mardi d'octobre, 10 h à Paris.
const START = Date.parse('2027-10-12T08:00:00.000Z');
const KEYS = { alex: 'test-cle-g12-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', direction: 'test-cle-g12-dir-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb', partenaire: 'test-cle-g12-part-cccccccccccccccccccccccccccc' };
type Who = keyof typeof KEYS;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeFiles implements ConsentProofStore {
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

const PLACES: Record<string, { lat: number; lon: number }> = {
  '8 rue des Tilleuls Essai, 21000 Dijon': { lat: 47.322, lon: 5.0415 },
  '10 rue des Tilleuls Essai 21000 Dijon': { lat: 47.3222, lon: 5.0415 },
  '12 rue des Tilleuls Essai 21000 Dijon': { lat: 47.3223, lon: 5.0415 },
};
const geocoder: Geocoder = { geocode: async (a) => (PLACES[a] ? { label: a, ...PLACES[a]!, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: null, score: 0.9 } : null) };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date((clock += 1000));
  const setClock = (t: number): void => {
    clock = t;
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const files = new FakeFiles();
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Essai' })).id;
  const agent: Viewer = { role: 'agent', userId: alex, networkId: network };
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network };
  // Un partenaire aux justificatifs valides, à qui Alex a confié une mise en relation : il peut recommander.
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 1 });
  const added = await annuaire.addPartner(direction, { trade: 'notaire', businessName: 'Étude Essai', postcodes: ['21000'] });
  if (!added.ok) throw new Error(added.code);
  const partnerId = added.value.partnerId;
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  await annuaire.addCredential(direction, partnerId, { kind: 'assurance_rcp', number: 'N-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${partnerId}`) });
  const client = await store.createPerson({ networkId: network, agentId: alex, firstName: 'Client' });
  const project = await store.createProject({ networkId: network, agentId: alex, personId: client.id, kind: 'sell' });
  const r = await relations.propose(agent, { projectId: project.id, trade: 'notaire', postcode: '21000' });
  if (!r.ok) throw new Error(r.code);
  await relations.recordConsent(agent, r.value.referralId, { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${r.value.referralId}`) });
  await relations.entrust(agent, r.value.referralId);
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex }, direction: { role: 'direction', userId: 'dir-1' }, partenaire: { role: 'partner', userId: partnerId } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, gagner: { proofs: files, geocoder } };
  const call = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${KEYS[who]}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const res = await handleRequest(new Request(`${BASE}/v1${path}`, init), config);
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.startsWith('application/json') ? ((await res.json()) as any) : null };
  };
  /** Une personne d'Alex, avec son mail, et un accord de relance d'ancien contact si demandé. */
  const person = async (firstName: string, opts: { oldContact?: boolean } = {}): Promise<string> => {
    const p = await store.createPerson({ networkId: network, agentId: alex, firstName });
    await store.addIdentifier({ networkId: network, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    if (opts.oldContact) await store.addConsent({ networkId: network, personId: p.id, purpose: OLD_CONTACT_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - 100 * DAY) });
    return p.id;
  };
  const outbox = async (): Promise<number> => Number((await db.first<{ n: number }>('SELECT count(*) AS n FROM trial_outbox'))?.n ?? 0);
  return { db, journal, store, fiche, acces, network, alex, agent, direction, partnerId, config, call, person, outbox, now, setClock, get clock() { return clock; } };
}

describeWithSqlite('G12 · branchement de M20 complet dans le socle', () => {
  it('[R16] les routes /v1/gagner sont servies par le socle, chaque rôle contrôlé avant le corps ; sans clé, rien', async () => {
    const t = await setup();
    expect(await t.call('alex', 'GET', '/gagner/relances')).toEqual({ status: 200, body: { ok: true, mode: 'essai', data: [] } });
    expect((await t.call('direction', 'GET', '/gagner/mesure/2027-10')).status).toBe(200);
    expect(await t.call('partenaire', 'GET', '/gagner/relances')).toEqual({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
    expect(await t.call('alex', 'POST', '/gagner/mesure/couts', { month: '2027-10', source: 'social', amountCents: 1, proofRef: 'x' })).toEqual({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
    expect((await t.call('alex', 'GET', '/gagner/inconnue')).status).toBe(404);
    expect((await t.call('alex', 'POST', '/gagner/relances')).status).toBe(405);
    const anonymous = await handleRequest(new Request(`${BASE}/v1/gagner/relances`), t.config);
    expect(anonymous.status).toBe(401);
    // Hors mode essai, l'API reste fermée.
    expect((await handleRequest(new Request(`${BASE}/v1/gagner/relances`, { headers: { authorization: `Bearer ${KEYS.alex}` } }), { ...t.config, mode: 'production' })).status).toBe(503);
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && String(e.data.kind).startsWith('route.gagner.'));
    expect(refused).toHaveLength(2);
  });

  it('[R143] [R26] le planificateur prépare chaque jour à 6 h la liste du mois, sans doublon ; l’agent valide, rien ne part', async () => {
    const t = await setup();
    const ines = await t.person('Inès', { oldContact: true });
    const sans = await t.person('Sans');
    expect((await t.call('alex', 'POST', `/gagner/fiches/${ines}/fin-de-bail`, { onDay: '2027-11-20' })).status).toBe(200);
    expect((await t.call('alex', 'POST', `/gagner/fiches/${sans}/fin-de-bail`, { onDay: '2027-11-20' })).status).toBe(200);
    expect(gagnerJobs(t.db, t.journal).map((j) => [j.name, j.hours])).toEqual([
      [OLD_CONTACTS_JOB, [6]],
      [SOURCE_MEASURE_JOB, [8]],
    ]);
    // Le passage réel du planificateur, mercredi et jeudi à 6 h 05 : une relance, pour la seule personne qui a l'accord.
    for (const at of ['2027-10-13T04:05:00.000Z', '2027-10-14T04:05:00.000Z']) {
      t.setClock(Date.parse(at));
      await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    }
    const rows = await t.db.all<{ person_id: string; status: string }>('SELECT person_id, status FROM old_contact_followups');
    expect(rows).toEqual([{ person_id: ines, status: 'a_valider' }]);
    expect((await t.journal.all()).filter((e) => e.type === 'anciens_contacts.passage').map((e) => e.data.prepared)).toEqual([1, 0]);
    expect(await t.outbox()).toBe(0);
    // Hors mode essai, le planificateur ne passe pas.
    t.setClock(Date.parse('2027-10-15T04:05:00.000Z'));
    expect(await runScheduler({ db: t.db, mode: 'production', now: t.now })).toBeNull();
    // L'agent valide à 10 h : le contrôle central range la relance dans la boîte d'essai, rien n'est livré [R26].
    t.setClock(Date.parse('2027-10-15T08:00:00.000Z'));
    const list = await t.call('alex', 'GET', '/gagner/relances');
    const done = await t.call('alex', 'POST', `/gagner/relances/${list.body.data[0].followupId}/valider`, {});
    expect(done.body).toEqual({ ok: true, mode: 'essai', data: { status: 'essai', rule: null, delivered: false } });
    expect(await t.outbox()).toBe(1);
  });

  it('[R144] le 1er du mois à 8 h, l’avis que la mesure du mois passé se lit, sans aucun nombre ; les autres jours, rien', async () => {
    const t = await setup();
    const [, measure] = gagnerJobs(t.db, t.journal, { now: t.now });
    t.setClock(Date.parse('2027-10-12T06:05:00.000Z'));
    await measure!.run({ job: SOURCE_MEASURE_JOB, slot: 'x', at: t.now() });
    t.setClock(Date.parse('2027-11-01T07:05:00.000Z'));
    await measure!.run({ job: SOURCE_MEASURE_JOB, slot: 'y', at: t.now() });
    t.setClock(Date.parse('2028-01-01T07:05:00.000Z'));
    await measure!.run({ job: SOURCE_MEASURE_JOB, slot: 'z', at: t.now() });
    const lines = (await t.journal.all()).filter((e) => e.type === 'gagner.mesure_a_lire');
    expect(lines.map((e) => [e.subject, e.data])).toEqual([
      [`network:${t.network}`, { rule: 'R144', month: '2027-10' }],
      [`network:${t.network}`, { rule: 'R144', month: '2027-12' }],
    ]);
    // Aucune décision n'est jamais prise par le code [R144].
    expect(await t.db.first('SELECT 1 FROM mandate_source_decisions')).toBeNull();
  });

  it('[R35] [R36] [R140] [R142] le plan du jour porte la recommandation à appeler, la relance à valider et les lettres à déposer, chacun sous sa base', async () => {
    const t = await setup();
    // Hugo, recommandé par le partenaire avec un appel à trois ; Inès, ancien contact avec une fin de bail ; Zoé, sans base.
    const reco = await t.call('partenaire', 'POST', '/gagner/recommandations', {
      firstName: 'Hugo',
      phone: '06 11 22 33 44',
      projectKind: 'sell',
      consent: { kind: 'appel_a_trois', channel: 'phone', givenAt: new Date(t.clock - DAY).toISOString(), reference: 'appel à trois du 11 octobre, noté par l’étude' },
    });
    expect(reco.status).toBe(200);
    const ines = await t.person('Inès', { oldContact: true });
    await t.call('alex', 'POST', `/gagner/fiches/${ines}/fin-de-bail`, { onDay: '2027-11-20' });
    expect(await new AnciensContacts(t.db, t.journal, { now: t.now }).prepareMonth(t.network)).toBe(1);
    // Une campagne de lettres de quartier après un mandat signé, deux adresses, sans aucun nom.
    const seller = await t.person('Vendeur');
    const sold = await t.store.createProperty({ networkId: t.network, agentId: t.alex, reference: 'T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 90, rooms: 4, priceEur: 260000 });
    await new Mandats(t.db, t.fiche, t.journal, { now: t.now }).record(t.acces, t.agent, { personId: seller, propertyId: sold.id, signedAt: new Date(t.clock), source: 'site' });
    const campaign = await t.call('alex', 'POST', '/gagner/lettres', {
      propertyId: sold.id,
      trigger: 'mandat',
      propertyAddress: '8 rue des Tilleuls Essai, 21000 Dijon',
      recipient: 'aux_habitants',
      origin: 'saisie_agent',
      addresses: [
        { number: '10', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Dijon' },
        { number: '12', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Dijon' },
      ],
    });
    expect(campaign.body).toMatchObject({ ok: true, data: { letters: 2 } });

    // Le même plan pour les mêmes données, calculé deux fois [R35].
    const plan = new PlanDuJour(t.db, t.fiche, { now: t.now });
    const first = await plan.compute(t.acces, t.agent);
    const second = await plan.compute(t.acces, t.agent);
    if (!first.ok || !second.ok) throw new Error('plan');
    expect({ ...first.value, computedAt: '' }).toEqual({ ...second.value, computedAt: '' });
    const hugo = first.value.items.find((i) => i.kind === 'recommendation')!;
    expect(first.value.items.map((i) => [i.rank, i.kind, i.firstName])).toEqual([
      [1, 'recommendation', 'Hugo'],
      [2, 'old_contact', 'Inès'],
    ]);
    expect(hugo).toMatchObject({ reason: 'Recommandé par un partenaire, accord donné : à contacter par téléphone.', basis: { kind: 'consent', purpose: 'recommandation' }, recommendation: { origin: 'partner', channel: 'phone' } });
    expect(hugo.order.startsWith('1. recommandation à rappeler ;')).toBe(true);
    expect(first.value.items[1]).toMatchObject({ reason: 'Fin de bail prochaine : relance préparée, à valider.', basis: { kind: 'consent', purpose: OLD_CONTACT_PURPOSE }, followupId: expect.any(String) });
    // Les lettres sont à part des personnes : un compte, aucun nom ni adresse [R140].
    expect(first.value.letters).toEqual([{ campaignId: campaign.body.data.campaignId, recipient: 'aux_habitants', toDeposit: 2, total: 2, since: '2027-10-12' }]);
    expect(JSON.stringify(first.value.letters)).not.toMatch(/Tilleuls|Dijon/);

    // Figé à 7 h 30 le lendemain, puis lu par l'agent par /v1/plan-du-jour.
    t.setClock(Date.parse('2027-10-13T05:30:00.000Z'));
    expect(await new PlansDuJour(t.db, t.journal, { now: t.now }).freezeAll()).toEqual({ frozen: 1, already: 0 });
    t.setClock(Date.parse('2027-10-13T07:00:00.000Z'));
    const read = await t.call('alex', 'GET', '/plan-du-jour');
    expect(read.body.data.items.map((i: { kind: string }) => i.kind)).toEqual(['recommendation', 'old_contact']);
    expect(read.body.data.letters).toMatchObject([{ toDeposit: 2 }]);

    // L'appel fait, une lettre déposée, l'accord de relance retiré : le plan figé ne les montre plus [R142, R143, R36].
    const toCall = await t.call('alex', 'GET', '/gagner/recommandations/a-appeler');
    expect((await t.call('alex', 'POST', `/gagner/recommandations/${toCall.body.data[0].recommendationId}/appel-fait`)).status).toBe(200);
    const letters = await t.call('alex', 'GET', `/gagner/lettres/${campaign.body.data.campaignId}`);
    expect((await t.call('alex', 'POST', `/gagner/lettres/lettre/${letters.body.data[0].letterId}/deposee`)).status).toBe(200);
    await t.db.run('UPDATE consents SET withdrawn_at = ? WHERE person_id = ? AND purpose = ?', [new Date(t.clock).toISOString(), ines, OLD_CONTACT_PURPOSE]);
    const after = await t.call('alex', 'GET', '/plan-du-jour');
    expect(after.body.data).toMatchObject({ items: [], hiddenSinceFrozen: 2, letters: [{ toDeposit: 1, total: 2 }] });

    // Le contrôle de la base légale relit chaque ligne à l'heure du plan : l'appel fait depuis n'est pas un écart [R36].
    t.setClock(Date.parse('2027-10-13T08:00:00.000Z'));
    const check = await new ControleBaseLegale(t.db, t.journal, { now: t.now }).run(t.network);
    expect(check).toMatchObject({ plans: 1, items: 2, gaps: 0 });

    // Une recommandation dont la personne a retiré son accord n'a plus de base, même relue à l'heure du plan [R142, R36].
    const members = await t.fiche.membersOf(hugo.personId);
    const target = { kind: 'recommendation' as const, recommendation: hugo.recommendation! };
    expect((await plan.eligibility(members, new Date(t.clock), target, { asOfPlan: true })).ok).toBe(true);
    await t.db.run('UPDATE consents SET withdrawn_at = ? WHERE person_id IN (' + members.map(() => '?').join(', ') + ') AND purpose = ?', [new Date(t.clock - 10).toISOString(), ...members, 'recommandation']);
    expect(await plan.eligibility(members, new Date(t.clock), target, { asOfPlan: true })).toEqual({ ok: false, reason: 'noBasis' });
  });
});
