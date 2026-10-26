import { readFileSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import {
  DecisionEnvoi,
  FicheClient,
  FicheUnique,
  RepriseSite,
  SqlJournalStore,
  VALUATION_PURPOSE,
  applyMigrations,
  fromSyncSqlite,
  readSiteContacts,
  verifyChain,
  type SiteContact,
  type SiteReading,
  type SiteRequest,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from './sqlite.ts';

const NOW = new Date('2026-10-26T09:00:00.000Z');
const T = '2026-09-01T08:00:00.000Z';

interface World {
  raw: SqliteDatabase;
  db: SqlDatabase;
  fiches: FicheClient;
  unique: FicheUnique;
  envoi: DecisionEnvoi;
  journal: SqlJournalStore;
  net: string;
  shawez: string;
  other: string;
  reprise: RepriseSite;
}

async function world(): Promise<World> {
  const raw = openMemoryDatabase();
  const db = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const now = (): Date => NOW;
  const fiches = new FicheClient(db, { now });
  const unique = new FicheUnique(db, fiches, { now });
  const envoi = new DecisionEnvoi(db, fiches, unique, { now });
  const journal = new SqlJournalStore(db);
  const net = (await fiches.createNetwork('Réseau test')).id;
  const shawez = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Principal' })).id;
  const other = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Autre' })).id;
  const reprise = new RepriseSite(db, fiches, unique, envoi, journal, { networkId: net, agentId: shawez, actor: 'reprise:test', now });
  return { raw, db, fiches, unique, envoi, journal, net, shawez, other, reprise };
}

const request = (reference: string, extra: Partial<SiteRequest> = {}): SiteRequest => ({
  reference,
  type: 'maison',
  postalCode: '21000',
  city: 'Dijon',
  status: 'recue',
  reason: null,
  createdAt: T,
  statusAt: null,
  ...extra,
});

const contact = (origin: string, extra: Partial<SiteContact> = {}): SiteContact => ({
  origin,
  emails: [],
  phones: [],
  civility: null,
  firstName: 'Prénom',
  lastName: 'Nom',
  createdAt: T,
  consentAt: null,
  verified: false,
  requests: [],
  problems: [],
  ...extra,
});

const reading = (contacts: SiteContact[]): SiteReading => ({ contacts, skipped: { suspect: 0, test: 0 }, flagged: 0 });

const phone = (n: number): string => `06 10 00 ${String(Math.floor(n / 100)).padStart(2, '0')} ${String(n % 100).padStart(2, '0')}`;

/**
 * 50 contacts inventés pour 40 personnes : 40 comptes, puis 10 doublons connus (même mail en majuscules,
 * même téléphone écrit autrement, demande sans compte d'une personne qui a un compte, une personne qui relie deux comptes).
 */
function fifty(): { contacts: SiteContact[]; people: number; lost: string[] } {
  const contacts: SiteContact[] = [];
  const lost: string[] = [];
  for (let i = 1; i <= 40; i += 1) {
    const status = i % 8 === 0 ? 'close' : i % 5 === 0 ? 'pause' : 'recue';
    if (status === 'close') lost.push(`personne${i}@example.org`);
    contacts.push(
      contact(`site:compte:${i}`, {
        emails: [`personne${i}@example.org`],
        phones: i % 2 === 0 ? [phone(i)] : [],
        consentAt: T,
        requests: [request(`E-TEST-${i}`, { status, reason: status === 'close' ? 'A choisi une autre agence' : null })],
      }),
    );
  }
  for (let i = 1; i <= 4; i += 1) contacts.push(contact(`site:demande:E-DOUBLE-MAIL-${i}`, { emails: [`PERSONNE${i}@Example.org`], requests: [request(`E-DOUBLE-MAIL-${i}`)] }));
  for (const i of [2, 4, 6, 10]) contacts.push(contact(`site:demande:E-DOUBLE-TEL-${i}`, { phones: [`+33 6 10 00 ${String(Math.floor(i / 100)).padStart(2, '0')} ${String(i % 100).padStart(2, '0')}`], requests: [request(`E-DOUBLE-TEL-${i}`)] }));
  // Une demande donne le mail d'un compte et le téléphone d'un autre : les deux comptes sont la même personne.
  contacts.push(contact('site:demande:E-PONT', { emails: ['personne11@example.org'], phones: [phone(12)], requests: [request('E-PONT')] }));
  contacts.push(contact('site:demande:E-PONT-2', { emails: ['personne13@example.org'], phones: [phone(14)], requests: [request('E-PONT-2')] }));
  return { contacts, people: 38, lost };
}

async function roots(w: World): Promise<string[]> {
  const persons = await w.db.all<{ id: string }>('SELECT id FROM persons ORDER BY id');
  return [...new Set(await Promise.all(persons.map((p) => w.unique.rootOf(p.id))))].sort();
}

function snapshot(raw: SqliteDatabase): string {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}"`).all()]));
}

describeWithSqlite('reprise des contacts du site dans la fiche client', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('[R17] 50 contacts dont des doublons connus donnent exactement les fiches attendues', async () => {
    const { contacts, people } = fifty();
    const report = await w.reprise.run(reading(contacts));
    expect(contacts).toHaveLength(50);
    expect(await roots(w)).toHaveLength(people);
    expect(report).toMatchObject({ read: 50, projects: 50, apart: 0 });
    // Chaque mail repris mène à une seule fiche gardée.
    for (let i = 1; i <= 40; i += 1) {
      expect(await w.unique.findByIdentifier(w.net, 'email', `personne${i}@example.org`)).toHaveLength(1);
    }
    const [a] = await w.unique.findByIdentifier(w.net, 'email', 'personne11@example.org');
    const [b] = await w.unique.findByIdentifier(w.net, 'phone', phone(12));
    expect(a?.id).toBe(b?.id);
    // Toutes les fiches sont confiées à l'agent de la reprise.
    const agents = await w.db.all<{ agent_id: string }>('SELECT DISTINCT agent_id FROM persons');
    expect(agents).toEqual([{ agent_id: w.shawez }]);
  });

  it('[R17] relancer la reprise ne change rien, pas même le journal', async () => {
    const { contacts } = fifty();
    await w.reprise.run(reading(contacts));
    const before = snapshot(w.raw);
    const again = await w.reprise.run(reading(contacts));
    expect(snapshot(w.raw)).toBe(before);
    expect(again).toMatchObject({ created: 0, merged: 0, projects: 0, consents: 0, exclusions: 0, matched: 50 });
  });

  it('[R17] rien n\'est effacé : chaque table ne fait que grandir', async () => {
    const { contacts } = fifty();
    const count = (): Record<string, number> => {
      const tables = w.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      return Object.fromEntries(tables.map(({ name }) => [name, Number((w.raw.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
    };
    const first = count();
    await w.reprise.run(reading(contacts.slice(0, 25)));
    const middle = count();
    await w.reprise.run(reading(contacts));
    const last = count();
    for (const table of Object.keys(first)) {
      expect(middle[table]).toBeGreaterThanOrEqual(first[table] ?? 0);
      expect(last[table]).toBeGreaterThanOrEqual(middle[table] ?? 0);
    }
  });

  it('[R02] chaque « Perdu » est exclu, et rien ne lui part, pas même une réponse', async () => {
    const { contacts, lost } = fifty();
    const report = await w.reprise.run(reading(contacts));
    expect(report.exclusions).toBe(lost.length);
    for (const email of lost) {
      const [person] = await w.unique.findByIdentifier(w.net, 'email', email);
      const view = await w.unique.view(person!.id);
      expect(view.exclusions.map((e) => [e.reason, e.lifted_at])).toEqual([['refused', null]]);
      const decision = await w.envoi.decide(person!.id, { channel: 'email', kind: 'reply', at: NOW });
      expect(decision).toMatchObject({ allowed: false, rule: 'R02' });
    }
  });

  it('[R02] « Perdu » avec une raison qui dit vendu donne une exclusion « vendu »', async () => {
    await w.reprise.run(reading([contact('site:compte:1', { emails: ['a@example.org'], requests: [request('E-1', { status: 'close', reason: 'Bien déjà vendu' })] })]));
    const [person] = await w.unique.findByIdentifier(w.net, 'email', 'a@example.org');
    expect((await w.unique.view(person!.id)).exclusions.map((e) => e.reason)).toEqual(['sold']);
  });

  it('[R03] aucun accord de prospection : seulement le suivi de l\'estimation, avec sa preuve', async () => {
    const { contacts } = fifty();
    const report = await w.reprise.run(reading(contacts));
    const purposes = await w.db.all<{ purpose: string; proof: string }>('SELECT DISTINCT purpose, proof FROM consents');
    expect(new Set(purposes.map((c) => c.purpose))).toEqual(new Set([VALUATION_PURPOSE]));
    expect(purposes.every((c) => c.proof.length > 0)).toBe(true);
    expect(report.consents).toBeGreaterThan(0);
    const [person] = await w.unique.findByIdentifier(w.net, 'email', 'personne1@example.org');
    const decision = await w.envoi.decide(person!.id, { channel: 'email', kind: 'prospecting', at: NOW });
    expect(decision).toMatchObject({ allowed: false, rule: 'R03' });
  });

  it('[R13] le journal ne garde que des identifiants internes et des nombres, et sa chaîne tient', async () => {
    const { contacts } = fifty();
    await w.reprise.run(reading(contacts));
    const entries = await w.journal.all();
    expect(entries.length).toBeGreaterThan(0);
    const text = JSON.stringify(entries);
    expect(text).not.toMatch(/@example\.org|Prénom|06 10|E-TEST|site:compte/i);
    expect(await verifyChain(entries)).toEqual({ ok: true });
  });

  it('une fiche suivie par un autre agent n\'est pas réunie : la direction attribue, l\'exclusion vaut pour les deux', async () => {
    const theirs = await w.fiches.createPerson({ networkId: w.net, agentId: w.other, firstName: 'Lou' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.other, personId: theirs.id, kind: 'email', value: 'lou@example.org' });
    const mine = await w.fiches.createPerson({ networkId: w.net, agentId: w.shawez, firstName: 'Lou' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.shawez, personId: mine.id, kind: 'phone', value: '0610009999' });
    const report = await w.reprise.run(
      reading([contact('site:compte:7', { emails: ['lou@example.org'], phones: ['0610009999'], requests: [request('E-7', { status: 'close' })] })]),
    );
    expect(report.apart).toBe(1);
    expect(await w.unique.rootOf(mine.id)).not.toBe(await w.unique.rootOf(theirs.id));
    for (const id of [mine.id, theirs.id]) {
      expect((await w.unique.view(id)).exclusions.map((e) => e.reason)).toEqual(['refused']);
    }
    // Relancer ne change rien, même avec des fiches restées à part.
    const before = snapshot(w.raw);
    await w.reprise.run(
      reading([contact('site:compte:7', { emails: ['lou@example.org'], phones: ['0610009999'], requests: [request('E-7', { status: 'close' })] })]),
    );
    expect(snapshot(w.raw)).toBe(before);
  });

  it('chaque fiche reprise a sa source, même un compte sans demande, et la relance n\'en ajoute pas', async () => {
    const { contacts } = fifty();
    const all = [...contacts, contact('site:compte:99', { emails: ['sans.demande@example.org'] })];
    await w.reprise.run(reading(all));
    for (const id of await roots(w)) {
      const view = await w.unique.view(id);
      expect(view.sources.some((s) => s.channel === 'site')).toBe(true);
    }
    const count = (): number => Number((w.raw.prepare('SELECT count(*) AS n FROM sources').get() as { n: number }).n);
    const before = count();
    await w.reprise.run(reading(all));
    expect(count()).toBe(before);
  });

  it('[R04] une exclusion en cours sur une fiche restée à part vaut pour toutes les fiches de la personne', async () => {
    const theirs = await w.fiches.createPerson({ networkId: w.net, agentId: w.other, firstName: 'Noa' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.other, personId: theirs.id, kind: 'phone', value: '0610008888' });
    await w.envoi.recordStopRequest({ networkId: w.net, agentId: w.other, personId: theirs.id, at: new Date('2026-10-01T08:00:00.000Z') });
    const mine = await w.fiches.createPerson({ networkId: w.net, agentId: w.shawez, firstName: 'Noa' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.shawez, personId: mine.id, kind: 'email', value: 'noa@example.org' });
    await w.reprise.run(reading([contact('site:compte:8', { emails: ['noa@example.org'], phones: ['0610008888'], consentAt: T, requests: [request('E-8')] })]));
    for (const id of [mine.id, theirs.id]) {
      expect(await w.envoi.decide(id, { channel: 'email', kind: 'follow_up', at: NOW })).toMatchObject({ allowed: false, rule: 'R04' });
    }
  });

  it('deux reprises simultanées du même lot ne laissent qu\'une fiche par personne', async () => {
    const { contacts, people } = fifty();
    const twin = new RepriseSite(w.db, w.fiches, w.unique, w.envoi, w.journal, { networkId: w.net, agentId: w.shawez, actor: 'reprise:test', now: () => NOW });
    await Promise.all([w.reprise.run(reading(contacts)), twin.run(reading(contacts))]);
    expect(await roots(w)).toHaveLength(people);
  });

  it('un contact sans coordonnées garde sa fiche, et la relance ne la double pas', async () => {
    const lonely = contact('site:demande:E-VIDE', { problems: ['contact_illisible'], requests: [request('E-VIDE')] });
    const first = await w.reprise.run({ ...reading([lonely]), flagged: 1 });
    expect(first).toMatchObject({ created: 1, withoutIdentifier: 1, flagged: 1 });
    await w.reprise.run(reading([lonely]));
    expect(await roots(w)).toHaveLength(1);
  });

  it('une coordonnée nouvelle d\'un contact déjà repris complète sa fiche', async () => {
    await w.reprise.run(reading([contact('site:compte:3', { emails: ['c@example.org'] })]));
    const report = await w.reprise.run(reading([contact('site:compte:3', { emails: ['c@example.org'], phones: ['0610001234'] })]));
    expect(report.created).toBe(0);
    const [person] = await w.unique.findByIdentifier(w.net, 'phone', '0610001234');
    const [same] = await w.unique.findByIdentifier(w.net, 'email', 'c@example.org');
    expect(person?.id).toBe(same?.id);
  });

  it('un agent parti ou d\'un autre réseau ne reçoit aucune fiche', async () => {
    const stranger = new RepriseSite(w.db, w.fiches, w.unique, w.envoi, w.journal, { networkId: w.net, agentId: 'inconnu', actor: 'reprise:test', now: () => NOW });
    await expect(stranger.run(reading([contact('site:compte:1', { emails: ['x@example.org'] })]))).rejects.toThrow(/agent/);
    expect(await roots(w)).toHaveLength(0);
  });

  it('de la base du site à la fiche client, de bout en bout', async () => {
    const site = openMemoryDatabase();
    site.exec(readFileSync(new URL('./fixtures/site-schema.sql', import.meta.url), 'utf8'));
    site.exec(readFileSync(new URL('./fixtures/site-colonnes.sql', import.meta.url), 'utf8'));
    site
      .prepare(`INSERT INTO comptes (id, email, mdp, prenom, nom, telephone, consentement_le, cree_le) VALUES (1, 'e2e@example.org', '', 'Prénom', 'Nom', '0610005555', ?, ?)`)
      .run(T, T);
    site
      .prepare(`INSERT INTO demandes (reference, compte_id, source, type, reponses, contact, statut, cree_le) VALUES ('E-E2E-1', 1, 'site', 'maison', '{}', ?, 'recue', ?)`)
      .run(JSON.stringify({ email: 'e2e@example.org' }), T);
    site
      .prepare(`INSERT INTO demandes (reference, compte_id, source, type, reponses, contact, statut, cree_le) VALUES ('E-E2E-2', NULL, 'site', 'maison', '{}', ?, 'close', ?)`)
      .run(JSON.stringify({ email: 'E2E@example.org', telephone: '06 10 00 55 55' }), T);
    const report = await w.reprise.run(await readSiteContacts(fromSyncSqlite(site)));
    expect(report).toMatchObject({ read: 2, created: 1, projects: 2, exclusions: 1 });
    expect(await roots(w)).toHaveLength(1);
  });
});
