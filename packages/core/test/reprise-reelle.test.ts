import { readFileSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import {
  CONTROL_SAMPLE,
  DecisionEnvoi,
  FicheClient,
  FicheUnique,
  RepriseReelle,
  RepriseSite,
  SqlJournalStore,
  applyMigrations,
  draw,
  fromSyncSqlite,
  readSiteContacts,
  readToolCsv,
  verifyChain,
  type ImportedContact,
  type SqlDatabase,
  type ToolFiles,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from './sqlite.ts';

// Toutes les personnes et coordonnées sont inventées ; les domaines sont réservés aux exemples.
const NOW = new Date('2026-11-01T09:00:00.000Z');
const T = '2026-09-01T08:00:00.000Z';
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Un tirage fixe, pour des tests reproductibles. */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

interface World {
  site: SqliteDatabase;
  siteDb: SqlDatabase;
  db: SqlDatabase;
  fiches: FicheClient;
  unique: FicheUnique;
  journal: SqlJournalStore;
  net: string;
  shawez: string;
  other: string;
  reelle: RepriseReelle;
}

async function world(): Promise<World> {
  const site = openMemoryDatabase();
  site.exec(fixture('site-schema.sql'));
  site.exec(fixture('site-colonnes.sql'));
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
  const reelle = new RepriseReelle(db, reprise, unique, journal, { networkId: net, actor: 'reprise:test', now, random: seeded() });
  return { site, siteDb: fromSyncSqlite(site), db, fiches, unique, journal, net, shawez, other, reelle };
}

const phone = (i: number): string => `06 10 00 ${String(Math.floor(i / 100)).padStart(2, '0')} ${String(i % 100).padStart(2, '0')}`;
const mail = (i: number): string => `personne${i}@example.org`;

/** 60 comptes du site, dont 6 « Perdu », et 10 demandes sans compte, dont 3 qui doublent un compte par le téléphone. */
function fillSite(site: SqliteDatabase): void {
  const compte = site.prepare(
    `INSERT INTO comptes (id, email, mdp, civilite, prenom, nom, telephone, verifie, source, consentement_le, cree_le)
     VALUES (?, ?, '', 'Mme', 'Prénom', 'Nom', ?, 1, 'site', ?, ?)`,
  );
  const demande = site.prepare(
    `INSERT INTO demandes (reference, compte_id, source, type, code_postal, commune, reponses, contact, statut, raison, statut_le, suspect, cree_le)
     VALUES (?, ?, 'site', 'maison', '21000', 'Dijon', '{}', ?, ?, ?, ?, 0, ?)`,
  );
  for (let i = 1; i <= 60; i++) {
    compte.run(i, mail(i), phone(i), T, T);
    const lost = i % 10 === 0;
    demande.run(`E-TEST-${i}`, i, JSON.stringify({ email: mail(i), telephone: phone(i) }), lost ? 'close' : 'recue', lost ? 'ne souhaite plus être contacté' : null, T, T);
  }
  for (let j = 1; j <= 10; j++) {
    const i = 100 + j;
    // Les trois premières demandes sans compte reprennent le téléphone d'un compte : une seule fiche attendue.
    const tel = j <= 3 ? phone(j) : phone(i);
    demande.run(`E-TEST-${i}`, null, JSON.stringify({ email: mail(i), telephone: tel }), 'recue', null, T, T);
  }
}

/** Les trois exports, qui recoupent le site : exclusion de 5 comptes, 4 désabonnés de GoHighLevel, 3 de ManyChat. */
function files(): ToolFiles {
  const exclusion = ['Email;Téléphone', ...[1, 2, 3, 4, 5].map((i) => `${mail(i)};`), ';06 10 00 09 99'].join('\n');
  const ghl = ['Contact Id,First Name,Email,Phone,DND', ...Array.from({ length: 12 }, (_, k) => `g${k},Alix,${mail(k + 11)},,${k < 4 ? 'true' : ''}`)].join('\n');
  const many = ['User ID;Instagram Username;Phone;Subscribed', ...Array.from({ length: 8 }, (_, k) => `m${k};insta.exemple${k};${phone(k + 31)};${k < 3 ? 'no' : 'yes'}`)].join('\n');
  return { exclusion_list: exclusion, gohighlevel: ghl, manychat: many };
}

const count = async (db: SqlDatabase, table: string): Promise<number> => Number((await db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n ?? 0);

describeWithSqlite('reprise réelle et contrôle sur 50 fiches (I04)', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    fillSite(w.site);
  });

  it('[R02] [R04] sans l\'un des trois fichiers, ou avec un fichier vide, rien n\'est écrit', async () => {
    const { manychat: _absent, ...two } = files();
    await expect(w.reelle.run(w.siteDb, two)).rejects.toThrow(/manychat manquant/);
    await expect(w.reelle.run(w.siteDb, { ...files(), gohighlevel: '  ' })).rejects.toThrow(/gohighlevel manquant/);
    expect(await count(w.db, 'persons')).toBe(0);
    expect(await count(w.db, 'journal')).toBe(0);
  });

  it('[R04] un fichier illisible arrête tout avant la première écriture', async () => {
    await expect(w.reelle.run(w.siteDb, { ...files(), manychat: 'User ID;Phone;Subscribed\nm1;"0610000001;no\n' })).rejects.toThrow(/guillemets/);
    expect(await count(w.db, 'persons')).toBe(0);
  });

  it('[R17] la base du site n\'est ni modifiée ni écrite', async () => {
    const before = JSON.stringify([w.site.prepare('SELECT * FROM comptes').all(), w.site.prepare('SELECT * FROM demandes').all()]);
    await w.reelle.run(w.siteDb, files());
    const after = JSON.stringify([w.site.prepare('SELECT * FROM comptes').all(), w.site.prepare('SELECT * FROM demandes').all()]);
    expect(after).toBe(before);
  });

  it('[R17] [R02] [R04] une fiche par personne, toutes les exclusions posées, contrôle sur 50 fiches vert', async () => {
    const report = await w.reelle.run(w.siteDb, files());
    // 60 comptes + 7 demandes sans compte distinctes + 1 exclusion inconnue du site ; GoHighLevel et ManyChat
    // recoupent des comptes par le mail ou le téléphone : aucune fiche de plus.
    expect(await count(w.db, 'persons')).toBe(60 + 7 + 1);
    expect(report.batches.site.read).toBe(70);
    expect(report.control).toEqual({ population: 70 + 6 + 12 + 8, drawn: CONTROL_SAMPLE, duplicates: 0, missingExclusions: 0, toAssign: 0, missing: 0, ok: true });
    // Chaque personne exclue à la source a son exclusion : liste [R02], désabonnés [R04], « Perdu » [R02].
    for (const i of [1, 2, 3, 4, 5, 10, 20, 30, 11, 12, 13, 14, 31, 32, 33]) {
      const [person] = await w.unique.findByIdentifier(w.net, 'email', mail(i));
      const n = await w.db.first<{ n: number }>('SELECT count(*) AS n FROM exclusions WHERE person_id = ? AND lifted_at IS NULL', [person!.id]);
      expect(Number(n?.n), `personne ${i}`).toBeGreaterThan(0);
    }
    const [abonne] = await w.unique.findByIdentifier(w.net, 'email', mail(15));
    expect(Number((await w.db.first<{ n: number }>('SELECT count(*) AS n FROM exclusions WHERE person_id = ?', [abonne!.id]))?.n)).toBe(0);
  });

  it('relancer la reprise ne crée ni ne double rien, et le contrôle reste vert', async () => {
    await w.reelle.run(w.siteDb, files());
    const persons = await count(w.db, 'persons');
    const exclusions = await count(w.db, 'exclusions');
    const again = await w.reelle.run(w.siteDb, files());
    expect(await count(w.db, 'persons')).toBe(persons);
    expect(await count(w.db, 'exclusions')).toBe(exclusions);
    for (const batch of Object.values(again.batches)) expect(batch.created).toBe(0);
    expect(again.control.ok).toBe(true);
  });

  it('[R02] le contrôle voit une exclusion manquante', async () => {
    const { contacts } = await readToolCsv(files().exclusion_list, 'exclusion_list', NOW);
    await w.reelle.run(w.siteDb, files());
    await w.db.run('UPDATE exclusions SET lifted_at = ?', [NOW.toISOString()]);
    const control = await w.reelle.control(contacts);
    expect(control.missingExclusions).toBe(contacts.length);
    expect(control.ok).toBe(false);
  });

  it('[R17] le contrôle voit un doublon chez un même agent, et laisse à la direction deux fiches de deux agents', async () => {
    await w.reelle.run(w.siteDb, files());
    const site = (await readSiteContacts(w.siteDb)).contacts.filter((c) => c.origin === 'site:compte:40' || c.origin === 'site:compte:41');
    const twin = await w.fiches.createPerson({ networkId: w.net, agentId: w.shawez, firstName: null, lastName: null });
    await w.fiches.addIdentifier({ networkId: w.net, agentId: w.shawez, personId: twin.id, kind: 'email', value: mail(40) });
    const elsewhere = await w.fiches.createPerson({ networkId: w.net, agentId: w.other, firstName: null, lastName: null });
    await w.fiches.addIdentifier({ networkId: w.net, agentId: w.other, personId: elsewhere.id, kind: 'email', value: mail(41) });
    const control = await w.reelle.control(site);
    expect(control).toMatchObject({ drawn: 2, duplicates: 1, toAssign: 1, ok: false });
  });

  it('le contrôle voit un contact introuvable', async () => {
    const ghost: ImportedContact = { origin: 'site:compte:999', emails: ['absent@example.org'], phones: [], civility: null, firstName: null, lastName: null, createdAt: T, consentAt: null, verified: false, requests: [], problems: [] };
    const control = await w.reelle.control([ghost]);
    expect(control).toMatchObject({ drawn: 1, missing: 1, ok: false });
  });

  it('[R13] le journal du contrôle ne porte que des nombres, et sa chaîne tient', async () => {
    await w.reelle.run(w.siteDb, files());
    const entries = await w.journal.all();
    const controle = entries.filter((e) => e.type === 'reprise.controle');
    expect(controle).toHaveLength(1);
    expect(Object.values(controle[0]!.data as Record<string, unknown>).every((v) => typeof v === 'number' || typeof v === 'boolean')).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/@example\.org|Prénom|06 10|E-TEST|site:compte|insta\.exemple/i);
    expect(await verifyChain(entries)).toEqual({ ok: true });
  });
});

it('le tirage rend des éléments distincts, au plus le nombre demandé, sans toucher à la liste', () => {
  const items = Array.from({ length: 80 }, (_, i) => i);
  const picked = draw(items, 50, seeded(3));
  expect(picked).toHaveLength(50);
  expect(new Set(picked).size).toBe(50);
  expect(items).toEqual(Array.from({ length: 80 }, (_, i) => i));
  expect(draw([1, 2, 3], 50)).toHaveLength(3);
});
