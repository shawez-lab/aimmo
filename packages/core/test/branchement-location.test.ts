import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Candidatures, ChoixProprietaire, EnvoisLocation, LOCATION_SEND_HOURS, LOCATION_SEND_JOB, MisesEnLocation, RENTAL_UPDATE_PURPOSE, locationSendJob, sendStatus, type RentalFacts } from '../src/location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agent, propriétaire et candidats inventés. Le 12 juillet 2027 est un lundi ; 8 h UTC = 10 h à Paris.
const MONDAY_10H = Date.parse('2027-07-12T08:00:00.000Z');
const MONDAY_22H = Date.parse('2027-07-12T20:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);
const FACTS: RentalFacts = {
  furnished: false,
  rentCents: 65_000,
  chargesCents: 5_000,
  livingAreaHundredths: 4_250,
  energyClass: 'G',
  finalEnergyKwh: 430,
  buildYear: 1985,
  electricityOver15: false,
  gas: 'aucune',
  leaseStart: '2027-09-01',
};

async function setup(options: { consent?: boolean } = {}) {
  let clock = MONDAY_10H;
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r) };
  const listings = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const identity = { state: async () => ({ identityVerifiedOn: '2027-07-10' }) };
  const apps = new Candidatures(db, listings, identity, files, journal, { now, newId: uuid });
  const choix = new ChoixProprietaire(db, listings, apps, files, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  /** Une personne inventée, avec son mail et, s'il le faut, son accord pour le suivi de la location. */
  const person = async (firstName: string) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, lastName: 'Inventé' });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}.invente@example.test` });
    if (options.consent !== false) await store.addConsent({ networkId: network.id, personId: p.id, purpose: RENTAL_UPDATE_PURPOSE, channel: 'email', proof: 'mandat de location test', givenAt: new Date(MONDAY_10H - 86_400_000) });
    return p;
  };
  const owner = await person('Bailleur');
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000' });
  const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
  const listingId = c.ok ? c.value.listingId : '';
  await listings.recordFacts(agent, listingId, FACTS);
  // Classé G : l'échéance du propriétaire est préparée au contrôle, jamais envoyée par lui.
  await listings.check(agent, listingId);
  const candidates: string[] = [];
  for (const name of ['Camille', 'Dominique']) {
    const pid = (await person(name)).id;
    candidates.push(pid);
    const a = await apps.apply(agent, listingId, { personId: pid });
    const id = a.ok ? a.value.applicationId : '';
    for (const sort of ['quittances_loyer', 'contrat_travail', 'bulletins_salaire']) {
      const ref = `location/${listingId}/candidatures/${id}/${uuid()}.pdf`;
      refs.add(ref);
      expect((await apps.addPiece(agent, id, { holder: 'candidat', sort, ref, sha256: SHA })).ok).toBe(true);
    }
  }
  expect((await choix.present(agent, listingId)).ok).toBe(true);
  const outbox = () =>
    db.all<{ person_id: string; body: string }>('SELECT m.person_id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id ORDER BY m.occurred_at, m.person_id');
  const sends = () => db.all<{ kind: string; status: string; rule: string | null }>('SELECT kind, status, rule FROM rental_sends ORDER BY kind, ref_id');
  const events = (type: string) => db.all<{ subject: string; data: string }>('SELECT subject, data FROM journal WHERE type = ? ORDER BY seq', [type]);
  return { db, store, journal, network, owner, candidates, listingId, outbox, sends, events, now, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('W10 · branchement de M15 dans le socle', () => {
  it('[R100] [R105] [R26] l’échéance du propriétaire et les reçus d’équité passent par le contrôle central, en essai, une seule fois', async () => {
    const t = await setup();
    const envois = new EnvoisLocation(t.db, t.journal, { now: t.now });
    // Une échéance, deux reçus de candidats et la preuve du propriétaire.
    expect(await envois.run(t.network.id)).toBe(4);
    expect(await t.sends()).toEqual([
      { kind: 'echeance', status: 'sent', rule: null },
      { kind: 'recu', status: 'sent', rule: null },
      { kind: 'recu', status: 'sent', rule: null },
      { kind: 'recu', status: 'sent', rule: null },
    ]);
    const box = await t.outbox();
    expect(box).toHaveLength(4);
    expect(box.filter((m) => m.person_id === t.owner.id).map((m) => m.body).join(' ')).toContain('1er janvier 2025');
    for (const pid of t.candidates) expect(box.filter((m) => m.person_id === pid)).toHaveLength(1);
    // Rien ne part ailleurs que dans la boîte d'essai.
    expect((await t.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM messages')).at(0)!.n).toBe(4);
    // Rejouer le passage n'envoie rien deux fois [R18].
    expect(await envois.run(t.network.id)).toBe(0);
    expect(await t.outbox()).toHaveLength(4);
    // Au journal : sorte, issue et règle, sans texte ni nom [R13] ; un reçu porte son destinataire et sa candidature.
    const logged = await t.events('location.envoi');
    expect(logged).toHaveLength(4);
    expect(JSON.stringify(logged)).not.toMatch(/Bailleur|Camille|Dominique|Inventé|example\.test|janvier/);
    expect(logged.filter((e) => JSON.parse(e.data).kind === 'recu').map((e) => JSON.parse(e.data).recipient)).toEqual(['candidat', 'candidat', 'proprietaire']);
  });

  it('[R01] [R02] [R03] le contrôle redécide au moment de l’envoi : la nuit attend, l’exclusion et l’absence d’accord refusent', async () => {
    const t = await setup();
    // Le soir, rien ne part : en attente, repris au passage suivant.
    t.setClock(MONDAY_22H);
    const envois = new EnvoisLocation(t.db, t.journal, { now: t.now });
    expect(await envois.run(t.network.id)).toBe(4);
    expect((await t.sends()).map((s) => [s.status, s.rule])).toEqual(Array(4).fill(['waiting', 'R01']));
    expect(await t.outbox()).toHaveLength(0);
    // Un candidat demande à ne plus être contacté avant le passage du lendemain : son reçu est refusé, pas envoyé.
    await t.store.addExclusion({ networkId: t.network.id, personId: t.candidates[0]!, reason: 'stop', notedAt: new Date(MONDAY_22H) });
    t.setClock(MONDAY_10H + 86_400_000);
    expect(await envois.run(t.network.id)).toBe(4);
    const box = await t.outbox();
    expect(box).toHaveLength(3);
    expect(box.some((m) => m.person_id === t.candidates[0])).toBe(false);
    const refused = (await t.sends()).filter((s) => s.status === 'refused');
    expect(refused).toHaveLength(1);
    expect(['R02', 'R04']).toContain(refused[0]!.rule);
    // Une issue définitive ne change plus : ni relue, ni modifiable.
    expect(await envois.run(t.network.id)).toBe(0);
    await expect(t.db.run("UPDATE rental_sends SET status = 'waiting'")).rejects.toThrow(/issue définitive/);
    await expect(t.db.run('DELETE FROM rental_sends')).rejects.toThrow(/rien ne s'efface/);

    // Sans l'accord du suivi de la location, rien ne part : refusé, le texte reste préparé [R03].
    const u = await setup({ consent: false });
    expect(await new EnvoisLocation(u.db, u.journal, { now: u.now }).run(u.network.id)).toBe(4);
    expect((await u.sends()).map((s) => [s.status, s.rule])).toEqual(Array(4).fill(['refused', 'R03']));
    expect(await u.outbox()).toHaveLength(0);
    expect(await u.db.all('SELECT 1 FROM rental_owner_notices')).toHaveLength(1);
  });

  it('[R01] [R18] le passage du planificateur tourne aux heures d’envoi, une fois par créneau, et rend le même résultat rejoué', async () => {
    const t = await setup();
    const job = locationSendJob(t.db, t.journal, { now: t.now });
    expect(job.name).toBe(LOCATION_SEND_JOB);
    expect(job.hours).toEqual(LOCATION_SEND_HOURS);
    expect(Math.min(...job.hours)).toBe(9);
    expect(Math.max(...job.hours)).toBe(19);
    await job.run({ slot: 'test' } as never);
    await job.run({ slot: 'test' } as never);
    expect(await t.outbox()).toHaveLength(4);
    // L'issue du contrôle : l'heure attend, la panne se reprend, le reste est définitif.
    expect(sendStatus({ status: 'sent', rule: null })).toBe('sent');
    expect(sendStatus({ status: 'failed', rule: null })).toBe('failed');
    expect(sendStatus({ status: 'refused', rule: 'R01' })).toBe('waiting');
    expect(sendStatus({ status: 'refused', rule: 'R03' })).toBe('refused');
  });
});

it('W10 · M15 sous son propre nom dans @aimmo/core', async () => {
  const core = await import('../src/index.ts');
  expect(typeof core.location.EnvoisLocation).toBe('function');
  expect(typeof core.location.MisesEnLocation).toBe('function');
});
