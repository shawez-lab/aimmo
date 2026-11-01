import { readFileSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import {
  CONTROL_SAMPLE,
  DEPOT_PART_CHARS,
  DepotsReprise,
  FicheClient,
  LancementReprise,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  verifyChain,
  type SqlDatabase,
  type SqlStatement,
  type ToolFiles,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase, type SqliteDatabase } from './sqlite.ts';

// Toutes les personnes et coordonnées sont inventées ; les domaines sont réservés aux exemples.
const NOW = new Date('2026-11-01T09:00:00.000Z');
const T = '2026-09-01T08:00:00.000Z';
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

const phone = (i: number): string => `06 10 00 ${String(Math.floor(i / 100)).padStart(2, '0')} ${String(i % 100).padStart(2, '0')}`;
const mail = (i: number): string => `personne${i}@example.org`;

/** 60 comptes du site, dont 6 « Perdu », et 10 demandes sans compte, dont 3 qui doublent un compte (comme I04). */
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
    const tel = j <= 3 ? phone(j) : phone(i);
    demande.run(`E-TEST-${i}`, null, JSON.stringify({ email: mail(i), telephone: tel }), 'recue', null, T, T);
  }
}

function files(): ToolFiles {
  const exclusion = ['Email;Téléphone', ...[1, 2, 3, 4, 5].map((i) => `${mail(i)};`), ';06 10 00 09 99'].join('\n');
  const ghl = ['Contact Id,First Name,Email,Phone,DND', ...Array.from({ length: 12 }, (_, k) => `g${k},Alix,${mail(k + 11)},,${k < 4 ? 'true' : ''}`)].join('\n');
  const many = ['User ID;Instagram Username;Phone;Subscribed', ...Array.from({ length: 8 }, (_, k) => `m${k};insta.exemple${k};${phone(k + 31)};${k < 3 ? 'no' : 'yes'}`)].join('\n');
  return { exclusion_list: exclusion, gohighlevel: ghl, manychat: many };
}

const count = async (db: SqlDatabase, table: string): Promise<number> => Number((await db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n ?? 0);

/** Une base qui tombe à la n-ième écriture : la coupure d'un travail en plein milieu. */
function failingAt(db: SqlDatabase, n: number): SqlDatabase {
  let writes = 0;
  const tick = (): void => {
    writes += 1;
    if (writes === n) throw new Error('coupure');
  };
  return {
    exec: (sql) => db.exec(sql),
    run: async (sql, params) => {
      tick();
      return db.run(sql, params);
    },
    all: (sql, params) => db.all(sql, params),
    first: (sql, params) => db.first(sql, params),
    batch: async (statements: readonly SqlStatement[]) => {
      tick();
      return (db.batch as NonNullable<SqlDatabase['batch']>)(statements);
    },
  };
}

/** node:sqlite n'a pas de lot : on en fait un, tout ou rien, comme D1. */
function withBatch(raw: SqliteDatabase, db: SqlDatabase): SqlDatabase {
  return {
    ...db,
    async batch(statements) {
      raw.exec('BEGIN');
      try {
        const out: { changes: number }[] = [];
        for (const s of statements) out.push(await db.run(s.sql, s.params ?? []));
        raw.exec('COMMIT');
        return out;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

interface World {
  site: SqliteDatabase;
  siteDb: SqlDatabase;
  db: SqlDatabase;
  net: string;
  shawez: string;
  other: string;
  direction: Viewer;
  depots: DepotsReprise;
  journal: SqlJournalStore;
}

async function world(): Promise<World> {
  const site = openMemoryDatabase();
  site.exec(fixture('site-schema.sql'));
  site.exec(fixture('site-colonnes.sql'));
  fillSite(site);
  const raw = openMemoryDatabase();
  const db = withBatch(raw, fromSyncSqlite(raw));
  await applyMigrations(db, loadMigrations());
  const now = (): Date => NOW;
  const fiches = new FicheClient(db, { now });
  const net = (await fiches.createNetwork('Réseau test')).id;
  const shawez = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Principal' })).id;
  const other = (await fiches.createAgent({ networkId: net, firstName: 'Agent', lastName: 'Autre' })).id;
  const journal = new SqlJournalStore(db);
  return { site, siteDb: fromSyncSqlite(site), db, net, shawez, other, direction: { role: 'direction', networkId: net, userId: shawez }, depots: new DepotsReprise(db, journal, { now }), journal };
}

async function depositAll(w: World, f: ToolFiles = files()): Promise<void> {
  for (const [tool, csv] of Object.entries(f)) {
    const r = await w.depots.deposit(w.direction, { tool, csv });
    expect(r.ok, tool).toBe(true);
  }
}

const launch = (w: World, db: SqlDatabase = w.db, timeLeft?: () => boolean): LancementReprise =>
  new LancementReprise(db, w.siteDb, { now: () => NOW, random: seeded(), chunk: 10, ...(timeLeft ? { timeLeft } : {}) });

describeWithSqlite('lancer la reprise sur les vraies bases (I05)', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it('[R16] seule la direction dépose et lit l\'état ; le refus est écrit au journal', async () => {
    const agent: Viewer = { role: 'agent', networkId: w.net, userId: w.shawez };
    expect(await w.depots.deposit(agent, { tool: 'manychat', csv: files().manychat })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.depots.status({ role: 'compliance', networkId: w.net, userId: 'c1' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await count(w.db, 'reprise_depots')).toBe(0);
    const refus = await w.db.all<{ type: string }>("SELECT type FROM journal WHERE type = 'acces.refuse'");
    expect(refus).toHaveLength(2);
  });

  it('un fichier illisible, vide, d\'une sorte inconnue ou pour un agent inconnu est refusé sans rien ranger', async () => {
    expect(await w.depots.deposit(w.direction, { tool: 'manychat', csv: 'User ID;Phone;Subscribed\nm1;"0610000001;no\n' })).toMatchObject({ ok: false, code: 'unreadable_file' });
    expect(await w.depots.deposit(w.direction, { tool: 'manychat', csv: '   ' })).toMatchObject({ ok: false, code: 'empty_file' });
    expect(await w.depots.deposit(w.direction, { tool: 'hubspot', csv: files().manychat })).toMatchObject({ ok: false, code: 'bad_tool' });
    expect(await w.depots.deposit(w.direction, { tool: 'manychat', csv: files().manychat, agentId: 'inconnu' })).toMatchObject({ ok: false, code: 'bad_agent' });
    expect(await count(w.db, 'reprise_depots')).toBe(0);
    expect(await count(w.db, 'reprise_depot_morceaux')).toBe(0);
  });

  it('[R13] un gros fichier est rangé en morceaux et recousu à l\'identique ; le journal ne porte que des nombres', async () => {
    const rows = Array.from({ length: 6000 }, (_, k) => `g${k},Alix,contact${k}@example.org,,`);
    const big = ['Contact Id,First Name,Email,Phone,DND', ...rows].join('\n');
    const r = await w.depots.deposit(w.direction, { tool: 'gohighlevel', csv: big });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.parts).toBe(Math.ceil(big.length / DEPOT_PART_CHARS));
    expect(r.value.parts).toBeGreaterThan(1);
    expect(r.value.lines).toBe(6000);
    const [latest] = await w.depots.latest(w.net);
    expect(await w.depots.content(latest!)).toBe(big);
    const journal = JSON.stringify(await w.db.all('SELECT * FROM journal'));
    expect(journal).not.toMatch(/example\.org|Alix/);
  });

  it('[R17] un nouveau dépôt s\'ajoute, l\'ancien reste, le dernier compte ; les dépôts ne se modifient ni ne s\'effacent', async () => {
    await depositAll(w);
    await w.depots.deposit(w.direction, { tool: 'manychat', csv: files().manychat + '\nm99;insta.neuf;;yes' });
    expect(await count(w.db, 'reprise_depots')).toBe(4);
    const latest = await w.depots.latest(w.net);
    expect(latest.map((d) => d.tool)).toEqual(['exclusion_list', 'gohighlevel', 'manychat']);
    expect((await w.depots.content(latest[2]!)).endsWith('insta.neuf;;yes')).toBe(true);
    await expect(w.db.run('DELETE FROM reprise_depots')).rejects.toThrow(/ajout seul/);
    await expect(w.db.run("UPDATE reprise_depot_morceaux SET content = ''")).rejects.toThrow(/ajout seul/);
  });

  it('[R02] [R04] rien ne tourne sans les trois fichiers : aucune fiche n\'est écrite', async () => {
    expect(await launch(w).run()).toEqual({ state: 'stopped', code: 'no_files' });
    await w.depots.deposit(w.direction, { tool: 'exclusion_list', csv: files().exclusion_list });
    await w.depots.deposit(w.direction, { tool: 'gohighlevel', csv: files().gohighlevel });
    expect(await launch(w).run()).toEqual({ state: 'stopped', code: 'missing_files' });
    expect(await count(w.db, 'persons')).toBe(0);
    expect(await count(w.db, 'reprise_avancement')).toBe(0);
  });

  it('des dépôts pour deux agents différents arrêtent tout', async () => {
    await w.depots.deposit(w.direction, { tool: 'exclusion_list', csv: files().exclusion_list });
    await w.depots.deposit(w.direction, { tool: 'gohighlevel', csv: files().gohighlevel });
    await w.depots.deposit(w.direction, { tool: 'manychat', csv: files().manychat, agentId: w.other });
    expect(await launch(w).run()).toEqual({ state: 'stopped', code: 'several_agents' });
    expect(await count(w.db, 'persons')).toBe(0);
  });

  it('[R17] [R02] [R04] la reprise complète donne une fiche par personne et un contrôle sur 50 fiches vert ; le site n\'est pas modifié', async () => {
    await depositAll(w);
    const before = JSON.stringify([w.site.prepare('SELECT * FROM comptes').all(), w.site.prepare('SELECT * FROM demandes').all()]);
    const report = await launch(w).run();
    if (report.state !== 'done') throw new Error(report.state);
    expect(await count(w.db, 'persons')).toBe(60 + 7 + 1);
    expect(report.control).toEqual({ population: 68, drawn: CONTROL_SAMPLE, duplicates: 0, missingExclusions: 0, toAssign: 0, missing: 0, ok: true });
    expect(report.totals.site?.read).toBe(70);
    expect(report.totals.exclusion_list?.read).toBe(6);
    expect(report.totals.gohighlevel?.read).toBe(12);
    expect(report.totals.manychat?.read).toBe(8);
    const after = JSON.stringify([w.site.prepare('SELECT * FROM comptes').all(), w.site.prepare('SELECT * FROM demandes').all()]);
    expect(after).toBe(before);
    expect(await verifyChain(await w.journal.all())).toEqual({ ok: true });
  });

  it('[R17] la base du site est lue en lecture seule : toute écriture y échoue', async () => {
    await depositAll(w);
    const writes: string[] = [];
    const spy: SqlDatabase = {
      ...w.siteDb,
      run: async (sql, params) => {
        writes.push(sql);
        return w.siteDb.run(sql, params);
      },
      exec: async (sql) => {
        writes.push(sql);
        return w.siteDb.exec(sql);
      },
    };
    const report = await new LancementReprise(w.db, spy, { now: () => NOW, random: seeded() }).run();
    expect(report.state).toBe('done');
    expect(writes).toEqual([]);
  });

  it('un travail arrêté faute de temps reprend au morceau suivant, sans rien doubler', async () => {
    await depositAll(w);
    let left = 3;
    const first = await launch(w, w.db, () => left-- > 0).run();
    expect(first).toMatchObject({ state: 'to_continue', source: 'site', position: 30 });
    expect(await count(w.db, 'persons')).toBeLessThan(68);
    let more = 5;
    const second = await launch(w, w.db, () => more-- > 0).run();
    expect(second.state).toBe('to_continue');
    const last = await launch(w).run();
    if (last.state !== 'done') throw new Error(last.state);
    expect(last.already).toBe(false);
    expect(await count(w.db, 'persons')).toBe(68);
    expect(last.control.ok).toBe(true);
    expect(last.totals.site?.read).toBe(70);
  });

  it('une coupure net à n\'importe quelle écriture se relance sans doubler une fiche ni perdre une exclusion', async () => {
    // La même reprise sans coupure, pour comparer.
    const ref = await world();
    await depositAll(ref);
    await launch(ref).run();
    const persons = await count(ref.db, 'persons');
    const exclusions = await count(ref.db, "exclusions WHERE lifted_at IS NULL");

    for (const n of [1, 2, 3, 5, 8, 13, 40, 97, 150, 333, 600]) {
      const v = await world();
      await depositAll(v);
      await expect(launch(v, failingAt(v.db, n)).run(), `coupure à l'écriture ${n}`).rejects.toThrow(/coupure/);
      const done = await launch(v).run();
      if (done.state !== 'done') throw new Error(done.state);
      expect(done.control.ok, `coupure à l'écriture ${n}`).toBe(true);
      // Une fiche vide (sans identifiant ni clé de reprise) laissée par une coupure entre sa création et sa clé
      // ne compte pas : elle ne double aucune personne.
      const real = await count(v.db, 'persons p WHERE EXISTS (SELECT 1 FROM person_identifiers i WHERE i.person_id = p.id) OR EXISTS (SELECT 1 FROM import_keys k WHERE k.target_id = p.id)');
      expect(real, `coupure à l'écriture ${n}`).toBe(persons);
      expect(await count(v.db, "exclusions WHERE lifted_at IS NULL"), `coupure à l'écriture ${n}`).toBe(exclusions);
    }
  });

  it('relancé une fois fini sur les mêmes données, il n\'écrit plus rien', async () => {
    await depositAll(w);
    await launch(w).run();
    const journal = await count(w.db, 'journal');
    const again = await launch(w).run();
    expect(again).toMatchObject({ state: 'done', already: true });
    expect(await count(w.db, 'journal')).toBe(journal);
  });

  it('un nouveau dépôt fait repartir du début, sans rien doubler', async () => {
    await depositAll(w);
    await launch(w).run();
    await w.depots.deposit(w.direction, { tool: 'manychat', csv: files().manychat + '\nm99;insta.neuf;;no' });
    const report = await launch(w).run();
    if (report.state !== 'done') throw new Error(report.state);
    expect(report.already).toBe(false);
    expect(await count(w.db, 'persons')).toBe(69);
    expect(report.totals.site?.created).toBe(0);
  });

  const addCompte = (site: SqliteDatabase, i: number): void => {
    site.prepare(`INSERT INTO comptes (id, email, mdp, civilite, prenom, nom, telephone, verifie, source, consentement_le, cree_le) VALUES (?, ?, '', 'Mme', 'Prénom', 'Nom', ?, 1, 'site', ?, ?)`).run(i, mail(i), phone(i), T, T);
  };

  it('un nouveau contact du site entre deux lancements ne fait pas repartir les fichiers : seule la source « site » est refaite', async () => {
    await depositAll(w);
    // Coupé en pleine liste de GoHighLevel.
    let left = 9;
    const first = await launch(w, w.db, () => left-- > 0).run();
    expect(first).toMatchObject({ state: 'to_continue', source: 'gohighlevel' });
    addCompte(w.site, 500);
    const done = await launch(w).run();
    if (done.state !== 'done') throw new Error(done.state);
    expect(done.control.ok).toBe(true);
    expect(await count(w.db, 'persons')).toBe(69);
    expect(done.totals.gohighlevel?.read).toBe(12);
    expect(done.totals.site_again?.read).toBe(71);
    expect(await launch(w).run()).toMatchObject({ state: 'done', already: true });
  });

  it('une fois finie, un nouveau contact du site est repris au lancement suivant, sans refaire les fichiers', async () => {
    await depositAll(w);
    await launch(w).run();
    addCompte(w.site, 501);
    const again = await launch(w).run();
    if (again.state !== 'done') throw new Error(again.state);
    expect(again.already).toBe(false);
    expect(await count(w.db, 'persons')).toBe(69);
    expect(again.totals.site_again).toMatchObject({ read: 71, created: 1 });
    expect(again.totals.manychat?.read).toBe(8);
    expect(await launch(w).run()).toMatchObject({ state: 'done', already: true });
  });

  it('[R13] l\'avancement, l\'état et le journal ne portent aucune donnée personnelle', async () => {
    await depositAll(w);
    await launch(w, w.db, (() => { let n = 4; return () => n-- > 0; })()).run();
    await launch(w).run();
    const status = await w.depots.status(w.direction);
    const dump = JSON.stringify([await w.db.all('SELECT * FROM reprise_avancement'), await w.db.all('SELECT * FROM journal'), status]);
    expect(dump).not.toMatch(/example\.org|06 10 00|insta\.exemple|Alix|Prénom/);
    expect(status).toMatchObject({ ok: true, value: { progress: { source: 'manychat', doneAt: NOW.toISOString() } } });
  });
});
