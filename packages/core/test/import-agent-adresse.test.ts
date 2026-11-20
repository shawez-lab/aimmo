import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { DecisionEnvoi, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type SqlValue } from '../src/index.ts';
import { ImportAgent, readAgentProperties } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from './sqlite.ts';

// AU031 · Adresses, biens et références inventés.
const NOW = new Date('2027-07-15T08:00:00.000Z');

interface World {
  raw: SqliteDatabase;
  db: SqlDatabase;
  importer: ImportAgent;
  net: string;
  agent: string;
  other: string;
  journal: SqlJournalStore;
}

let w: World;
const me = (): { role: 'agent'; userId: string; networkId: string } => ({ role: 'agent', userId: w.agent, networkId: w.net });
const count = async (sql: string, params: SqlValue[] = []): Promise<number> => Number((await w.db.first<{ n: number }>(sql, params))?.n ?? 0);
/** Toute la base, sauf l'espace privé des adresses reprises et le journal. */
const outsidePrivate = (): string => {
  const tables = w.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('journal', 'journal_entries', 'agent_import_property_addresses') ORDER BY name")
    .all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => [name, w.raw.prepare(`SELECT * FROM "${name}"`).all()]));
};
const propertyOf = async (reference: string): Promise<string> =>
  (await w.db.first<{ property_id: string }>('SELECT property_id FROM agent_import_properties WHERE export_reference = ?', [reference]))!.property_id;

/** L'export des biens de l'ancien logiciel, avec l'adresse de chaque bien. */
const PROPERTIES = [
  'Référence;Type;Adresse;Code postal;Ville;Surface;Prix',
  'V100;Maison;12 rue des Essais;21000;Dijon;120;320000', // 2 : adresse entière
  'V200;Appartement;4 allée Fictive;21121;Fontaine-lès-Dijon;64;189000', // 3 : adresse entière
  'V300;Appartement;8 impasse Inventée;;;50;150000', // 4 : ni code postal ni commune, adresse non reprise
  'V400;Terrain;;21000;Dijon;;90000', // 5 : pas d'adresse, rien à dire
].join('\n');

describeWithSqlite("AU031 · l'adresse exacte des biens repris, gardée dans un espace privé, jamais publiée", () => {
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
    const other = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Voisin' })).id;
    w = { raw, db, importer, net, agent, other, journal };
  });

  it("[R84] constat reproduit : l'adresse de l'export est reprise, l'agent la retrouve sur son bien sans la ressaisir", async () => {
    const r = await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES });
    if (!r.ok) throw new Error(r.code);
    expect(r.report.properties).toEqual({ read: 4, created: 4, known: 0, unreadableLines: [] });
    expect(r.report.addresses).toEqual({ kept: 2, known: 0, notTakenLines: [4] });
    const v100 = await w.importer.dossierOf(me(), await propertyOf('V100'));
    expect(v100.ok && v100.value.address).toEqual({ street: '12 rue des Essais', postalCode: '21000', city: 'Dijon' });
    const v200 = await w.importer.dossierOf(me(), await propertyOf('V200'));
    expect(v200.ok && v200.value.address).toEqual({ street: '4 allée Fictive', postalCode: '21121', city: 'Fontaine-lès-Dijon' });
    // Une adresse incomplète n'est jamais complétée ni devinée ; un bien sans adresse n'en a pas.
    for (const ref of ['V300', 'V400']) {
      const d = await w.importer.dossierOf(me(), await propertyOf(ref));
      expect([ref, d.ok && d.value.address]).toEqual([ref, null]);
    }
    expect(r.report.summary).toContain("2 adresses exactes gardées dans l'espace privé de leur bien : jamais publiées, ni dans l'annonce ni dans un message.");
    expect(r.report.summary).toContain('1 adresse non reprise (incomplète, ou bien suivi par un autre agent), listée par son numéro de ligne.');
  });

  it("[R46] l'adresse reste dans l'espace privé : ni dans le bien, ni ailleurs dans la base, ni au journal", async () => {
    await w.importer.preview(me(), w.agent, { format: 'hektor', properties: PROPERTIES });
    await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES });
    await w.importer.dossierOf(me(), await propertyOf('V100'));
    const base = outsidePrivate();
    const journal = JSON.stringify(await w.journal.all());
    for (const street of ['rue des Essais', 'allée Fictive', 'impasse Inventée']) {
      expect(base).not.toContain(street);
      expect(journal).not.toContain(street);
    }
    expect(await count('SELECT count(*) AS n FROM agent_import_property_addresses')).toBe(2);
    // Rien n'est publié : les biens restent en brouillon, aucune annonce ni diffusion.
    expect(await count("SELECT count(*) AS n FROM properties WHERE status <> 'draft'")).toBe(0);
    for (const table of ['listing_pushes', 'listing_versions', 'send_log', 'trial_outbox']) expect([table, await count(`SELECT count(*) AS n FROM ${table}`)]).toEqual([table, 0]);
  });

  it("[R46] aucune sortie ne lit l'espace privé des adresses : seul l'import et sa lecture contrôlée y touchent", () => {
    // Les seules sources qui nomment la table : l'import (écriture et lecture par l'agent du bien ou la direction), et
    // les cartes de conformité (registre, accès, reprise d'un réseau) qui la déclarent sans la lire pour un public.
    const allowed = new Set([
      'core/src/reseau/import-agent.ts',
      'core/src/conformite/registre-traitements.ts',
      'core/src/conformite/carte-acces.ts',
      'core/src/licences/carte-reprise.ts',
    ]);
    const root = join(import.meta.dirname, '..', '..');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|mjs|js)$/.test(name) && readFileSync(path, 'utf8').includes('agent_import_property_addresses')) found.push(relative(root, path).split('\\').join('/'));
      }
    };
    for (const pkg of ['core', 'api']) walk(join(root, pkg, 'src'));
    expect(found.filter((f) => !allowed.has(f))).toEqual([]);
    expect(found).toContain('core/src/reseau/import-agent.ts');
  });

  it("[R16] l'adresse se lit par l'agent du bien ou la direction, chaque lecture au journal sans l'adresse ; un autre agent est refusé", async () => {
    await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES });
    const id = await propertyOf('V100');
    expect(await w.importer.dossierOf({ role: 'agent', userId: w.other, networkId: w.net }, id)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const direction = await w.importer.dossierOf({ role: 'direction', userId: 'dir-1', networkId: w.net }, id);
    expect(direction.ok && direction.value.address?.street).toBe('12 rue des Essais');
    const reads = (await w.journal.all()).filter((e) => e.type === 'bien.lu');
    expect(reads.map((e) => [e.subject, (e.data as { address: boolean }).address])).toEqual([[`property:${id}`, true]]);
    // Un autre réseau ne voit rien.
    expect(await w.importer.dossierOf({ role: 'direction', userId: 'dir-2', networkId: 'autre-reseau' }, id)).toMatchObject({ ok: false, code: 'unknown' });
  });

  it("[R18] relancé, l'adresse ne double ni ne change ; une adresse arrivée plus tard rejoint le bien déjà repris", async () => {
    const sans = ['Référence;Type;Code postal;Ville', 'V100;Maison;21000;Dijon'].join('\n');
    await w.importer.run(me(), w.agent, { format: 'hektor', properties: sans });
    const id = await propertyOf('V100');
    const before = await w.importer.dossierOf(me(), id);
    expect(before.ok && before.value.address).toBeNull();
    const first = await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES });
    expect(first.ok && first.report.addresses).toEqual({ kept: 2, known: 0, notTakenLines: [4] });
    const again = await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES.replace('12 rue des Essais', '99 rue Changée') });
    expect(again.ok && again.report.addresses).toEqual({ kept: 0, known: 2, notTakenLines: [4] });
    const after = await w.importer.dossierOf(me(), id);
    expect(after.ok && after.value.address?.street).toBe('12 rue des Essais');
    expect(await count('SELECT count(*) AS n FROM agent_import_property_addresses')).toBe(2);
    await expect(w.db.run("UPDATE agent_import_property_addresses SET city = 'Beaune'")).rejects.toThrow(/ne change plus/);
    await expect(w.db.run('DELETE FROM agent_import_property_addresses')).rejects.toThrow(/rien ne s'efface/);
  });

  it("[R84] l'aperçu compte les adresses comme l'import, sans rien ranger ; un bien passé à un autre agent ne reçoit pas d'adresse", async () => {
    const preview = await w.importer.preview(me(), w.agent, { format: 'hektor', properties: PROPERTIES });
    expect(preview.ok && preview.report.addresses).toEqual({ kept: 2, known: 0, notTakenLines: [4] });
    expect(preview.ok && preview.report.summary).toContain("2 adresses exactes seront gardées dans l'espace privé de leur bien : jamais publiées, ni dans l'annonce ni dans un message.");
    expect(await count('SELECT count(*) AS n FROM agent_import_property_addresses')).toBe(0);
    // Le bien V200, repris sans adresse, passe ensuite à un autre agent : sa ligne d'adresse n'est pas reprise.
    await w.importer.run(me(), w.agent, { format: 'hektor', properties: ['Référence;Type;Code postal;Ville', 'V200;Appartement;21121;Fontaine-lès-Dijon'].join('\n') });
    await w.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [w.other, await propertyOf('V200')]);
    const second = await w.importer.preview(me(), w.agent, { format: 'hektor', properties: PROPERTIES });
    expect(second.ok && second.report.addresses).toEqual({ kept: 1, known: 0, notTakenLines: [3, 4] });
    const r = await w.importer.run(me(), w.agent, { format: 'hektor', properties: PROPERTIES });
    expect(r.ok && r.report.addresses).toEqual({ kept: 1, known: 0, notTakenLines: [3, 4] });
    const other = await w.importer.dossierOf({ role: 'agent', userId: w.other, networkId: w.net }, await propertyOf('V200'));
    expect(other.ok && other.value.address).toBeNull();
  });

  it('lecture : le numéro de voie à part, une adresse mal formée ou sans code postal à cinq chiffres non reprise', async () => {
    const csv = [
      'Référence;Type;Numéro de voie;Rue;CP;Commune',
      'A1;Maison;7;rue du Jeu;21000;Dijon', // 2 : « 7 rue du Jeu »
      'A2;Maison;;<b>rue</b>;21000;Dijon', // 3 : balise, refusée
      'A3;Maison;3;rue Courte;2100;Dijon', // 4 : code postal de quatre chiffres
      'A4;Maison;;;21000;Dijon', // 5 : pas d'adresse
    ].join('\n');
    const reading = await readAgentProperties(csv, 'excel', 'agent-x');
    expect(reading.lines.map((l) => [l.reference, l.address, l.addressUnreadable])).toEqual([
      ['A1', { street: '7 rue du Jeu', postalCode: '21000', city: 'Dijon' }, false],
      ['A2', null, true],
      ['A3', null, true],
      ['A4', null, false],
    ]);
    // Le bien lui-même ne garde que la commune et le code postal lisibles.
    expect(reading.lines[2]?.postalCode).toBeNull();
  });
});
