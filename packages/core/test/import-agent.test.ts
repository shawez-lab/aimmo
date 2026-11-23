import { beforeEach, expect, it } from 'vitest';
import { DecisionEnvoi, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase, type SqlValue } from '../src/index.ts';
import { ImportAgent, exportDay, readAgentContacts, readAgentProperties } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from './sqlite.ts';

// Agents, contacts et biens inventés : example.org et des numéros 06 10 en série.
const NOW = new Date('2027-07-15T08:00:00.000Z');
const OUT_TABLES = ['send_log', 'trial_outbox', 'outbound_refs', 'send_reservations'];

interface World {
  raw: SqliteDatabase;
  db: SqlDatabase;
  fiches: FicheClient;
  unique: FicheUnique;
  envoi: DecisionEnvoi;
  importer: ImportAgent;
  net: string;
  agent: string;
  other: string;
  journal: SqlJournalStore;
}

let w: World;

const phone = (i: number): string => `06 10 ${String(Math.floor(i / 10000) % 100).padStart(2, '0')} ${String(Math.floor(i / 100) % 100).padStart(2, '0')} ${String(i % 100).padStart(2, '0')}`;
const viewer = (): { role: 'agent'; userId: string; networkId: string } => ({ role: 'agent', userId: w.agent, networkId: w.net });

/** Un export Hektor de n contacts : un sur cinq client, un sur cinq avec un accord prouvé, le reste sans base. */
function hektor(n: number, from = 0): string {
  const lines = ['Civilité;Nom;Prénom;Email;Téléphone portable;N° mandat;Date accord;Preuve accord;Finalité;Désinscrit'];
  for (let i = from; i < from + n; i += 1) {
    const kind = i % 5;
    lines.push(
      [
        'M.',
        `Essai${i}`,
        'Test',
        `contact${i}@example.org`,
        phone(i),
        kind === 0 ? `M${1000 + i}` : '',
        kind === 1 ? '12/03/2026' : '',
        kind === 1 ? 'formulaire signé en agence' : '',
        kind === 1 ? 'Prospection' : '',
        kind === 4 && i % 10 === 9 ? 'oui' : 'non',
      ].join(';'),
    );
  }
  return lines.join('\n');
}

/** Un export Excel de n contacts, aux en-têtes d'un tableur. */
function excel(n: number, from = 0): string {
  const lines = ['Prénom,Nom,Mail,Tel,Vente,Date consentement,Preuve consentement,Finalité accord'];
  for (let i = from; i < from + n; i += 1) {
    const kind = i % 4;
    lines.push([`P${i}`, `Excel${i}`, `excel${i}@example.org`, kind === 3 ? '' : `+33 6 20 00 ${String(Math.floor(i / 100)).padStart(2, '0')} ${String(i % 100).padStart(2, '0')}`, kind === 0 ? '2025-06-01' : '', kind === 1 ? '2026-01-10' : '', kind === 1 ? 'case cochée sur le site' : '', kind === 1 ? 'alertes' : ''].join(','));
  }
  return lines.join('\n');
}

const count = async (sql: string, params: SqlValue[] = []): Promise<number> => Number((await w.db.first<{ n: number }>(sql, params))?.n ?? 0);
const outCount = async (): Promise<number> => {
  let total = await count("SELECT count(*) AS n FROM messages WHERE direction = 'out'");
  for (const t of OUT_TABLES) total += await count(`SELECT count(*) AS n FROM ${t}`);
  return total;
};
const snapshot = (): string => {
  const tables = w.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('journal', 'journal_entries') ORDER BY name").all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => [name, w.raw.prepare(`SELECT * FROM "${name}"`).all()]));
};

describeWithSqlite("import des contacts et des biens d'un agent", () => {
  beforeEach(async () => {
    const raw = openMemoryDatabase();
    const db = fromSyncSqlite(raw);
    await applyMigrations(db, loadMigrations());
    const now = (): Date => NOW;
    const fiches = new FicheClient(db, { now });
    const unique = new FicheUnique(db, fiches, { now });
    const envoi = new DecisionEnvoi(db, fiches, unique, { now });
    const journal = new SqlJournalStore(db);
    const importer = new ImportAgent(db, fiches, unique, envoi, journal, { now });
    const net = (await fiches.createNetwork('Réseau test')).id;
    const agent = (await fiches.createAgent({ networkId: net, firstName: 'Nouvel', lastName: 'Agent' })).id;
    const other = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Ancien' })).id;
    w = { raw, db, fiches, unique, envoi, importer, net, agent, other, journal };
  });

  it("[R84] [R18] 500 contacts Hektor : aucun doublon, relancé deux fois sans rien doubler", async () => {
    const csv = hektor(500);
    const first = await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: csv });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.report.contacts.read).toBe(500);
    expect(first.report.contacts.created).toBe(500);
    expect(first.report.contacts.basis).toEqual({ client: 100, consent: 100, none: 300 });
    expect(await count('SELECT count(*) AS n FROM persons')).toBe(500);
    const before = snapshot();
    for (const _ of [1, 2]) {
      const again = await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: csv });
      expect(again.ok && again.report.contacts.created).toBe(0);
      expect(again.ok && again.report.contacts.consents).toBe(0);
    }
    expect(snapshot()).toBe(before);
    expect(await count('SELECT count(*) AS n FROM persons')).toBe(500);
    expect(await count("SELECT count(*) AS n FROM sources WHERE channel = 'import'")).toBe(500);
  });

  it('[R84] [R18] 500 contacts Excel, dont 125 sans téléphone : aucun doublon, relancé deux fois sans rien doubler', async () => {
    const csv = excel(500);
    const first = await w.importer.run(viewer(), w.agent, { format: 'excel', contacts: csv });
    expect(first.ok && first.report.contacts.created).toBe(500);
    expect(first.ok && first.report.contacts.basis).toEqual({ client: 125, consent: 125, none: 250 });
    const before = snapshot();
    await w.importer.run(viewer(), w.agent, { format: 'excel', contacts: csv });
    await w.importer.run(viewer(), w.agent, { format: 'excel', contacts: csv });
    expect(snapshot()).toBe(before);
  });

  it('[R84] [R18] le même contact présent deux fois dans l\'export, ou écrit autrement, ne fait qu\'une fiche', async () => {
    const csv = ['Nom;Email;Téléphone', 'A;Double@Example.org;0610000001', 'A;double@example.org;+33 6 10 00 00 01', 'B;;06.10.00.00.01'].join('\n');
    const r = await w.importer.run(viewer(), w.agent, { format: 'excel', contacts: csv });
    expect(r.ok && r.report.contacts.read).toBe(3);
    expect(await count('SELECT count(*) AS n FROM persons')).toBe(1);
  });

  it('[R84] [R03] aucun message ne part à l\'import, et un contact sans base est refusé par le contrôle central', async () => {
    expect(await outCount()).toBe(0);
    const r = await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: hektor(50) });
    expect(r.ok).toBe(true);
    expect(await outCount()).toBe(0);
    const none = (await w.unique.findByIdentifier(w.net, 'email', 'contact2@example.org'))[0]!;
    expect(await w.importer.basisOf(none.id)).toBe('none');
    expect(await count('SELECT count(*) AS n FROM consents WHERE person_id = ?', [none.id])).toBe(0);
    // Un mardi à 10 h : seule l'absence d'accord peut refuser.
    const at = new Date('2027-07-20T08:00:00.000Z');
    for (const channel of ['email', 'sms', 'phone', 'whatsapp'] as const) {
      for (const kind of ['prospecting', 'follow_up', 'alert'] as const) {
        const d = await w.envoi.decide(none.id, { channel, kind, at });
        expect(d.allowed).toBe(false);
        expect(d.rule).toBe('R03');
      }
    }
  });

  it('[R84] [R03] un client avec mandat n\'a aucun accord inventé ; un accord prouvé est rangé tel quel, pour sa seule finalité', async () => {
    await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: hektor(10) });
    const client = (await w.unique.findByIdentifier(w.net, 'email', 'contact0@example.org'))[0]!;
    expect(await w.importer.basisOf(client.id)).toBe('client');
    expect(await count('SELECT count(*) AS n FROM consents WHERE person_id = ?', [client.id])).toBe(0);
    const consented = (await w.unique.findByIdentifier(w.net, 'email', 'contact1@example.org'))[0]!;
    expect(await w.importer.basisOf(consented.id)).toBe('consent');
    const consents = await w.db.all<{ purpose: string; channel: string; proof: string; given_at: string }>('SELECT purpose, channel, proof, given_at FROM consents WHERE person_id = ? ORDER BY channel', [consented.id]);
    expect(consents).toEqual([
      { purpose: 'prospecting', channel: 'email', proof: 'import Hektor · formulaire signé en agence', given_at: '2026-03-12T12:00:00.000Z' },
    ]);
    const at = new Date('2027-07-20T08:00:00.000Z');
    expect((await w.envoi.decide(consented.id, { channel: 'email', kind: 'prospecting', at })).allowed).toBe(true);
    // Pas une autre finalité que celle prouvée.
    expect((await w.envoi.decide(consented.id, { channel: 'email', kind: 'alert', at })).rule).toBe('R03');
  });

  it('[R84] [R03] un accord sans date, sans preuve, sans finalité connue, daté dans le futur ou sur un canal inconnu ne vaut rien', async () => {
    const csv = [
      'Email;Date accord;Preuve accord;Finalité;Canal accord',
      'a@example.org;;preuve;prospection;',
      'b@example.org;2026-01-01;;prospection;',
      'c@example.org;2026-01-01;preuve;tout;',
      'd@example.org;2030-01-01;preuve;prospection;',
      'e@example.org;31/02/2026;preuve;prospection;',
      'f@example.org;2026-01-01;preuve;prospection;pigeon',
      'g@example.org;2026-01-01;preuve;suivi;mail',
      'h@example.org;;;;',
    ].join('\n');
    const r = await w.importer.run(viewer(), w.agent, { format: 'apimo', contacts: csv });
    if (!r.ok) throw new Error('refus');
    expect(r.report.contacts.incompleteConsentLines).toEqual([2, 3, 4, 5, 6, 7]);
    expect(r.report.contacts.basis).toEqual({ client: 0, consent: 1, none: 7 });
    expect(await count('SELECT count(*) AS n FROM consents')).toBe(1);
    expect(await w.db.first('SELECT purpose, channel FROM consents')).toEqual({ purpose: 'follow_up', channel: 'email' });
  });

  it("[R84] un accord sur un canal sans coordonnée dans la ligne n'est pas rangé", async () => {
    const csv = ['Email;Date accord;Preuve accord;Finalité;Canal accord', 'a@example.org;2026-01-01;preuve;alertes;sms'].join('\n');
    await w.importer.run(viewer(), w.agent, { format: 'excel', contacts: csv });
    expect(await count('SELECT count(*) AS n FROM consents')).toBe(0);
  });

  it("[R03] [R84] un accord retiré ne revient jamais par un nouvel import, quel que soit le format ou la preuve", async () => {
    const line = (proof: string): string => ['Email;Date accord;Preuve accord;Finalité', `retrait@example.org;2026-01-10;${proof};prospection`].join('\n');
    await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: line('formulaire signé') });
    const person = (await w.unique.findByIdentifier(w.net, 'email', 'retrait@example.org'))[0]!;
    const consent = (await w.db.first<{ id: string }>('SELECT id FROM consents WHERE person_id = ?', [person.id]))!;
    await w.fiches.withdrawConsent(consent.id, new Date('2027-02-01T10:00:00.000Z'));
    const at = new Date('2027-07-20T08:00:00.000Z');
    expect((await w.envoi.decide(person.id, { channel: 'email', kind: 'prospecting', at })).rule).toBe('R03');
    await w.importer.run(viewer(), w.agent, { format: 'excel', contacts: line('formulaire signé') });
    await w.importer.run(viewer(), w.agent, { format: 'apimo', contacts: line('bulletin papier en agence') });
    expect(await count('SELECT count(*) AS n FROM consents WHERE person_id = ?', [person.id])).toBe(1);
    expect((await w.envoi.decide(person.id, { channel: 'email', kind: 'prospecting', at })).rule).toBe('R03');
  });

  it("[R84] [R03] une valeur qui dit l'absence ne fait ni un client ni un accord", async () => {
    const csv = [
      'Email;N° mandat;Vente;Date accord;Preuve accord;Finalité',
      'a@example.org;Pas de mandat;;;;',
      'b@example.org;non signé;;;;',
      'c@example.org;;aucune;;;',
      'd@example.org;;;2026-01-01;aucune preuve;prospection',
      'e@example.org;;;2026-01-01;Inconnue;prospection',
      'f@example.org;;;2026-01-01;n/a;prospection',
      'g@example.org;;;2026-01-01;?;prospection',
      'h@example.org;M-2026-014;;;;',
      'i@example.org;;12/05/2025;;;',
    ].join('\n');
    const r = await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: csv });
    if (!r.ok) throw new Error('refus');
    expect(r.report.contacts.basis).toEqual({ client: 2, consent: 0, none: 7 });
    expect(r.report.contacts.incompleteConsentLines).toEqual([5, 6, 7, 8]);
    expect(await count('SELECT count(*) AS n FROM consents')).toBe(0);
  });

  it("[R04] [R16] une désinscription d'un contact suivi par un autre agent vaut arrêt sur sa fiche, sans rien d'autre", async () => {
    const theirs = await w.fiches.createPerson({ networkId: w.net, agentId: w.other, firstName: 'Suivi' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.other, personId: theirs.id, kind: 'email', value: 'suivi@example.org' });
    await w.fiches.addConsent({ networkId: w.net, agentId: w.other, personId: theirs.id, purpose: 'prospecting', channel: 'email', proof: 'accord test', givenAt: new Date('2026-01-01T10:00:00.000Z') });
    const at = new Date('2027-07-20T08:00:00.000Z');
    expect((await w.envoi.decide(theirs.id, { channel: 'email', kind: 'prospecting', at })).allowed).toBe(true);
    const csv = ['Email;Désinscrit', 'suivi@example.org;oui'].join('\n');
    const r = await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: csv });
    expect(r.ok && r.report.contacts.toDirection).toBe(1);
    expect(r.ok && r.report.contacts.exclusions).toBe(1);
    expect((await w.envoi.decide(theirs.id, { channel: 'email', kind: 'prospecting', at })).allowed).toBe(false);
    expect((await w.fiches.getPerson(theirs.id))!.agent_id).toBe(w.other);
    await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: csv });
    expect(await count("SELECT count(*) AS n FROM exclusions WHERE person_id = ?", [theirs.id])).toBe(1);
  });

  it('[R18] [R51] deux imports de biens en même temps ne font qu\'un bien par référence', async () => {
    const csv = ['Référence;Type', 'V1;Maison', 'V2;Terrain'].join('\n');
    const [a, b] = await Promise.all([
      w.importer.run(viewer(), w.agent, { format: 'hektor', properties: csv }),
      w.importer.run(viewer(), w.agent, { format: 'hektor', properties: csv }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(await count('SELECT count(*) AS n FROM properties')).toBe(2);
    expect(await count('SELECT count(*) AS n FROM agent_import_properties')).toBe(2);
    expect((a.ok ? a.report.properties.created : 0) + (b.ok ? b.report.properties.created : 0)).toBe(2);
    expect(await count("SELECT count(*) AS n FROM properties WHERE dwelling = 'house'")).toBe(1);
  });

  it('[R04] une désinscription dans l\'export vaut arrêt', async () => {
    await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: hektor(10) });
    const stopped = (await w.unique.findByIdentifier(w.net, 'email', 'contact9@example.org'))[0]!;
    expect(await count("SELECT count(*) AS n FROM exclusions WHERE person_id = ? AND reason = 'stop'", [stopped.id])).toBe(1);
  });

  it('[R16] une fiche suivie par un autre agent n\'est jamais reprise : elle va à la direction, intacte', async () => {
    const theirs = await w.fiches.createPerson({ networkId: w.net, agentId: w.other, firstName: 'Déjà' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: w.other, personId: theirs.id, kind: 'phone', value: '0610000003' });
    const unassigned = await w.fiches.createPerson({ networkId: w.net, agentId: null, firstName: 'Libre' });
    await w.unique.addIdentifier({ networkId: w.net, agentId: null, personId: unassigned.id, kind: 'email', value: 'libre@example.org' });
    const before = JSON.stringify([await w.unique.view(theirs.id), await w.unique.view(unassigned.id)]);
    const csv = [
      'Email;Téléphone;N° mandat;Date accord;Preuve accord;Finalité',
      'nouveau@example.org;06 10 00 00 03;M1;2026-01-01;preuve;prospection',
      'libre@example.org;;;;;',
      'autre@example.org;;;;;',
    ].join('\n');
    const r = await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: csv });
    if (!r.ok) throw new Error('refus');
    expect(r.report.contacts.toDirection).toBe(2);
    expect(r.report.contacts.created).toBe(1);
    expect(JSON.stringify([await w.unique.view(theirs.id), await w.unique.view(unassigned.id)])).toBe(before);
    expect(await count('SELECT count(*) AS n FROM persons WHERE agent_id = ?', [w.agent])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM consents')).toBe(0);
    const dir = await w.importer.referrals({ role: 'direction', userId: 'dir', networkId: w.net });
    expect(dir.ok && dir.value.map((x) => x.personId).sort()).toEqual([theirs.id, unassigned.id].sort());
    // Relancé : rien de neuf à la direction.
    await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: csv });
    expect(await count('SELECT count(*) AS n FROM agent_import_referrals')).toBe(2);
    const refused = await w.importer.referrals(viewer());
    expect(refused).toEqual({ ok: false, rule: 'R16', code: 'role' });
  });

  it('[R16] seul l\'agent lui-même, actif, ou la direction lancent l\'import ; chaque refus est au journal', async () => {
    const csv = hektor(3);
    expect(await w.importer.run({ role: 'agent', userId: w.other, networkId: w.net }, w.agent, { format: 'hektor', contacts: csv })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await w.importer.run({ role: 'compliance', userId: 'c', networkId: w.net }, w.agent, { format: 'hektor', contacts: csv })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.importer.run({ role: 'direction', userId: 'd', networkId: 'ailleurs' }, w.agent, { format: 'hektor', contacts: csv })).toMatchObject({ ok: false, code: 'unknown' });
    expect(await count('SELECT count(*) AS n FROM persons')).toBe(0);
    const refusals = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refusals).toHaveLength(3);
    const byDirection = await w.importer.run({ role: 'direction', userId: 'd', networkId: w.net }, w.agent, { format: 'hektor', contacts: csv });
    expect(byDirection.ok).toBe(true);
    expect(await count('SELECT count(*) AS n FROM persons WHERE agent_id = ?', [w.agent])).toBe(3);
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.agent]);
    expect(await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: csv })).toMatchObject({ ok: false, code: 'agent_inactive' });
  });

  it('[R13] rien d\'une coordonnée ni d\'un nom au journal, et la chaîne reste intacte', async () => {
    await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: hektor(20), properties: 'Référence;Type;Ville;Adresse\nV1;Maison;Dijon;12 rue Inventée' });
    // Les empreintes et les identifiants tirés au hasard sont retirés d'abord : un « 0610 » dans un hash n'est pas un numéro.
    const text = JSON.stringify(await w.journal.all())
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
      .replace(/[0-9a-f]{64}/g, '<empreinte>');
    expect(text).not.toMatch(/example\.org|06 ?10|Essai\d|formulaire|rue Inventée|V1\b/);
    expect(text).toContain('reseau.import');
    expect((await verifyChain(await w.journal.all())).ok).toBe(true);
  });

  it('[R51] les biens sont rangés à l\'agent, en brouillon, l\'adresse à part (AU031), une seule fois ; une ligne illisible est signalée', async () => {
    const csv = [
      'Référence;Type de bien;Adresse;Code postal;Ville;Surface habitable;Nb pièces;Prix FAI',
      'V100;Appartement T3;3 rue Inventée;21000;Dijon;68,5 m²;3;189 000 €',
      'V101;Terrain;;21121;Fontaine-lès-Dijon;;;95000',
      ';Maison;;21000;Dijon;;;',
      'V103;Péniche;;21000;Dijon;;;',
    ].join('\n');
    const r = await w.importer.run(viewer(), w.agent, { format: 'hektor', properties: csv });
    if (!r.ok) throw new Error('refus');
    expect(r.report.properties).toEqual({ read: 2, created: 2, known: 0, unreadableLines: [4, 5] });
    const rows = await w.db.all<Record<string, unknown>>('SELECT agent_id, kind, postal_code, city, surface_m2, rooms, price_eur, status FROM properties ORDER BY price_eur DESC');
    expect(rows).toEqual([
      { agent_id: w.agent, kind: 'home', postal_code: '21000', city: 'Dijon', surface_m2: 68.5, rooms: 3, price_eur: 189000, status: 'draft' },
      { agent_id: w.agent, kind: 'land', postal_code: '21121', city: 'Fontaine-lès-Dijon', surface_m2: null, rooms: null, price_eur: 95000, status: 'draft' },
    ]);
    // AU031 · L'adresse exacte n'est plus jetée : elle n'est que dans l'espace privé du bien, jamais dans le bien.
    expect(snapshot().replace(/\["agent_import_property_addresses",\[[^\]]*\]\]/, '')).not.toContain('rue Inventée');
    expect(await w.db.all('SELECT street, postal_code, city FROM agent_import_property_addresses')).toEqual([{ street: '3 rue Inventée', postal_code: '21000', city: 'Dijon' }]);
    // AU070 · « Appartement T3 » reste un appartement après import ; un terrain n'est ni l'un ni l'autre.
    expect(await w.db.all('SELECT kind, dwelling FROM properties ORDER BY price_eur DESC')).toEqual([{ kind: 'home', dwelling: 'apartment' }, { kind: 'land', dwelling: null }]);
    const again = await w.importer.run(viewer(), w.agent, { format: 'hektor', properties: csv });
    expect(again.ok && again.report.properties).toEqual({ read: 2, created: 0, known: 2, unreadableLines: [4, 5] });
    expect(await count('SELECT count(*) AS n FROM properties')).toBe(2);
    expect(await count('SELECT count(*) AS n FROM listing_versions')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM listing_pushes')).toBe(0);
  });

  it('le compte rendu dit les nombres et les lignes illisibles, sans donnée personnelle', async () => {
    const csv = ['Prénom;Email;Téléphone;Mandat', 'Zoé;zoe@example.org;;M1', 'Yann;pas-un-mail;;', 'Xavier;x@example.org;123;', 'Wen;w@example.org;;'].join('\n');
    const r = await w.importer.run(viewer(), w.agent, { format: 'google', contacts: csv });
    if (!r.ok) throw new Error('refus');
    expect(r.report.contacts.unreadableLines).toEqual([3]);
    expect(r.report.contacts.partialLines).toEqual([4]);
    expect(r.report.summary).toEqual([
      '1 client avec un mandat ou une vente : vous pouvez les suivre pour ce dossier.',
      "0 contact avec un accord prouvé : seulement pour ce qu'ils ont accepté.",
      '2 contacts sans accord prouvé : aucun premier message, jamais. Ils peuvent vous écrire, vous leur répondrez.',
      '2 lignes à regarder, listées par leur numéro.',
      "0 bien rangé en brouillon : rien n'est publié.",
    ]);
    expect(r.report.summary.join(' ')).not.toMatch(/Zoé|example/);
  });

  it('un fichier sans colonne de coordonnées, mal formé ou d\'un format inconnu est refusé, sans rien écrire', async () => {
    expect(await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: 'Nom;Ville\nA;Dijon' })).toEqual({ ok: false, rule: null, code: 'missing_columns' });
    expect(await w.importer.run(viewer(), w.agent, { format: 'hektor', contacts: 'Email\n"a@example.org' })).toEqual({ ok: false, rule: null, code: 'malformed_file' });
    expect(await w.importer.run(viewer(), w.agent, { format: 'tableur', contacts: hektor(1) })).toEqual({ ok: false, rule: null, code: 'unknown_format' });
    expect(await count('SELECT count(*) AS n FROM persons')).toBe(0);
  });
});

it('lecture des dates d\'export', () => {
  expect(exportDay('2026-03-12')).toBe('2026-03-12');
  expect(exportDay('12/03/2026')).toBe('2026-03-12');
  expect(exportDay('1/3/2026 10:00')).toBe('2026-03-01');
  expect(exportDay('2026-03-12T09:00:00Z')).toBe('2026-03-12');
  expect(exportDay('31/02/2026')).toBeNull();
  expect(exportDay('hier')).toBeNull();
  expect(exportDay(null)).toBeNull();
});

it('Google Contacts : en-têtes reconnus, clé d\'origine propre à l\'agent et stable', async () => {
  const csv = 'First Name,Last Name,E-mail 1 - Value,Phone 1 - Value\nAna,Test,ana@example.org,+33 6 10 00 00 09\n';
  const a = await readAgentContacts(csv, 'google', 'agent-a', NOW);
  const b = await readAgentContacts(csv, 'google', 'agent-b', NOW);
  expect(a.lines[0]!.contact.emails).toEqual(['ana@example.org']);
  expect(a.lines[0]!.contact.phones).toEqual(['+33 6 10 00 00 09']);
  expect(a.lines[0]!.contact.origin).not.toBe(b.lines[0]!.contact.origin);
  expect((await readAgentContacts(csv, 'google', 'agent-a', NOW)).lines[0]!.contact.origin).toBe(a.lines[0]!.contact.origin);
  expect(a.lines[0]!.contact.origin).toMatch(/^import:agent-a:google:h[0-9a-f]{24}$/);
  await expect(readAgentProperties('Ville\nDijon', 'excel', 'agent-a')).rejects.toThrow(/référence/);
});
