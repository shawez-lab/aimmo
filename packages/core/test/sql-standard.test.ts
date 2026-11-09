import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NON_STANDARD_KINDS, blankComments, countByKind, excesses, findNonStandard, lowerCeilings, raisedCeilings, renderMap, type Ceilings, type NonStandardHit } from '../src/passage-postgresql/index.ts';

// HX67 : ce qui n'est pas du SQL standard, compté fichier par fichier, plafonné, et la carte du passage écrite depuis
// ce compte [R633]. Les jeux d'essai sont inventés.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ceilingsPath = fileURLToPath(new URL('./sql-plafonds.json', import.meta.url));
const mapPath = join(root, 'docs/PASSAGE-POSTGRESQL.md');
/** Le fichier qui décrit les sortes les cite dans ses textes : il n'est pas compté. */
const SELF = 'packages/core/src/passage-postgresql/sql-standard.ts';

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, ext));
    else if (name.endsWith(ext)) out.push(path);
  }
  return out;
}

function scanRepository(): Record<string, NonStandardHit[]> {
  const found: Record<string, NonStandardHit[]> = {};
  for (const path of walk(join(root, 'db/migrations'), '.sql')) found[relative(root, path)] = findNonStandard(readFileSync(path, 'utf8'), 'sql');
  for (const path of walk(join(root, 'packages/core/src'), '.ts')) {
    const rel = relative(root, path);
    if (rel !== SELF) found[rel] = findNonStandard(readFileSync(path, 'utf8'), 'ts');
  }
  return found;
}

/**
 * Les plafonds de la branche principale, lus par git : sans eux, aucune baisse ni montée ne se vérifie, et le test
 * échoue plutôt que de passer sans rien dire. Quand la référence manque (copie sans historique), elle est cherchée une
 * fois. Avant la première fusion, le fichier n'existe pas sur la branche principale : la référence est alors le
 * fichier lui-même.
 */
function baseCeilings(): Ceilings {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main');
  } catch {
    git('fetch', '--quiet', '--depth=1', 'origin', 'main:refs/remotes/origin/main');
  }
  const rel = relative(root, ceilingsPath);
  try {
    return JSON.parse(git('show', `refs/remotes/origin/main:${rel}`)) as Ceilings;
  } catch (error) {
    const known = git('ls-tree', '--name-only', 'refs/remotes/origin/main', rel).trim();
    if (known === '') return JSON.parse(readFileSync(ceilingsPath, 'utf8')) as Ceilings;
    throw error;
  }
}

const kinds = (text: string, lang: 'sql' | 'ts' = 'sql') => findNonStandard(text, lang).map((h) => `${h.kind}@${h.line}`);

describe('HX67 · chaque sorte de SQL non standard est reconnue', () => {
  it('[R633] chaque sorte a son essai, et le SQL standard équivalent ne compte pas', () => {
    const cases: Record<string, [string, string]> = {
      declencheur: ["CREATE TRIGGER t BEFORE DELETE ON x BEGIN SELECT 1; END;", 'CREATE INDEX t ON x (a);'],
      raise: ["SELECT RAISE(ABORT, 'non');", "SELECT 'RAISE plus tard';"],
      insert_or: ['INSERT OR IGNORE INTO x VALUES (1);', 'INSERT INTO x VALUES (1) ON CONFLICT DO NOTHING;'],
      glob: ["SELECT 1 WHERE a GLOB '[0-9]*';", "SELECT 1 WHERE a LIKE '1%';"],
      date_sqlite: ["SELECT DATETIME('now'), strftime('%Y', a), JulianDay(a), unixepoch(a), date('now'), DATE(a, '+' || n || ' days'), time(a, '+1 hour');", 'SELECT CURRENT_TIMESTAMP, date(a), DATE(substr(a, 1, 10));'],
      autoincrement: ['CREATE TABLE x (id INTEGER PRIMARY KEY AUTOINCREMENT);', 'CREATE TABLE x (id INTEGER PRIMARY KEY);'],
      pragma: ['PRAGMA foreign_keys = ON; SELECT * FROM pragma_table_info(\'x\');', 'SELECT 1;'],
      rowid: ['SELECT rowid, last_insert_rowid() FROM x;', 'SELECT id FROM x;'],
      group_concat: ['SELECT group_concat(a) FROM x;', "SELECT string_agg(a, ',') FROM x;"],
      json_sqlite: ["SELECT json_extract(a, '$.b'), j.value FROM x, json_each(x.a) j;", 'SELECT a FROM x;'],
      ifnull: ['SELECT IFNULL(a, 0) FROM x;', 'SELECT COALESCE(a, 0) FROM x;'],
      iif: ['SELECT iif(a > 0, 1, 0) FROM x;', 'SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END FROM x;'],
      instr: ["SELECT instr(a, 'b') FROM x;", "SELECT position('b' in a) FROM x;"],
      char: ["SELECT DISTINCT CHAR(10), ALL char(9) FROM x WHERE instr(a, char(13)) = 0 AND CHAR(9) <> '';", 'CREATE TABLE x (a CHAR(3), "b" char (12)); ALTER TABLE x ADD COLUMN c CHAR(2); SELECT CAST(a AS CHAR(3)), chr(10);'],
      printf: ["SELECT PRINTF('%d', a) FROM x;", "SELECT format('%s', a) FROM x;"],
    };
    expect(Object.keys(cases).sort()).toEqual(NON_STANDARD_KINDS.map((k) => k.kind).sort());
    for (const [kind, [bad, good]] of Object.entries(cases)) {
      expect(findNonStandard(bad, 'sql').filter((h) => h.kind === kind).length, kind).toBeGreaterThan(0);
      expect(findNonStandard(good, 'sql'), kind).toEqual([]);
    }
    expect(kinds("SELECT datetime('now'), STRFTIME('%Y', a), julianday(a), UnixEpoch(a);")).toEqual(['date_sqlite@1', 'date_sqlite@1', 'date_sqlite@1', 'date_sqlite@1']);
    expect(kinds("SELECT DISTINCT CHAR(10) FROM x WHERE instr(a, char(13)) = 0 AND CHAR(9) <> '';").filter((k) => k.startsWith('char'))).toEqual(['char@1', 'char@1', 'char@1']);
    expect(kinds("SELECT date('now'), DATE(a, '+1 day'), date(a), date(substr(a, 1, 10)), time(a, 'localtime');")).toEqual(['date_sqlite@1', 'date_sqlite@1', 'date_sqlite@1']);
    // Un espace avant les parenthèses ne change rien pour SQLite, ni pour le compte.
    expect(kinds("SELECT date ('now'), time  ('now'), DATE (a, '+1 day'), date (a);")).toEqual(['date_sqlite@1', 'date_sqlite@1', 'date_sqlite@1']);
    // Dans les chaînes du TypeScript, une phrase en français n'est pas un appel ; la forme collée du SQL, si.
    expect(kinds("const t = 'Les ventes, avec leur date (R28, R29).'; db.all(\"SELECT date(a, '+1 day')\");", 'ts')).toEqual(['date_sqlite@1']);
  });

  it('[R633] les commentaires ne comptent pas, les chaînes oui, et les lignes restent justes', () => {
    const sql = "-- PRAGMA dans un commentaire\nSELECT 1; /* GLOB\n AUTOINCREMENT */\nSELECT '-- pas un commentaire', IFNULL(a, 0) FROM x;\nINSERT OR IGNORE INTO x VALUES (1);";
    expect(kinds(sql)).toEqual(['ifnull@4', 'insert_or@5']);
    const ts = [
      "// db.run('PRAGMA foreign_keys = ON')",
      '/** Lit `PRAGMA page_count`. */',
      "const url = 'https://exemple.test/a'; const q = 'SELECT IFNULL(a, 0) FROM x';",
      'const d = new Date(); const t = typeof d; const n = date(a, b); rowid(x); GLOB;',
      "const r = /[']/; await db.run('INSERT OR REPLACE INTO x VALUES (1)');",
      '`SELECT ${a} FROM x WHERE b GLOB ?`;',
    ].join('\n');
    expect(kinds(ts, 'ts')).toEqual(['ifnull@3', 'insert_or@5', 'glob@6']);
    // Une division n'est pas une expression régulière : la chaîne qui suit est lue.
    expect(kinds("const h = a / 2 + b / 3; await db.first('SELECT IFNULL(a, 0) FROM x');", 'ts')).toEqual(['ifnull@1']);
    expect(kinds("const h = a / 2; const p = '/chemin/'; await db.first('SELECT IFNULL(a, 0) FROM x');", 'ts')).toEqual(['ifnull@1']);
    // Les retours à la ligne d'un commentaire bloc sont gardés.
    expect(blankComments('a/*\n\n*/b', 'ts').split('\n')).toHaveLength(3);
  });
});

describe('HX67 · plafonds par fichier', () => {
  const hit = (kind: string, line: number): NonStandardHit => ({ kind, line });

  it('[R633] une forme ajoutée dans un fichier fait échouer avec le fichier et la ligne ; un compte qui baisse passe', () => {
    const ceilings: Ceilings = { 'db/migrations/0001_x.sql': { rowid: 2 } };
    expect(excesses({ 'db/migrations/0001_x.sql': [hit('rowid', 3), hit('rowid', 9)] }, ceilings)).toEqual([]);
    expect(excesses({ 'db/migrations/0001_x.sql': [hit('rowid', 3)] }, ceilings)).toEqual([]);
    expect(excesses({ 'db/migrations/0001_x.sql': [hit('rowid', 3), hit('rowid', 9), hit('rowid', 12)] }, ceilings)).toEqual([
      { file: 'db/migrations/0001_x.sql', kind: 'rowid', ceiling: 2, count: 3, lines: [3, 9, 12] },
    ]);
    // Une sorte nouvelle dans un fichier connu, ou un fichier nouveau : plafond zéro.
    expect(excesses({ 'db/migrations/0001_x.sql': [hit('glob', 4)], 'db/migrations/9999_neuf.sql': [hit('pragma', 1)] }, ceilings)).toEqual([
      { file: 'db/migrations/0001_x.sql', kind: 'glob', ceiling: 0, count: 1, lines: [4] },
      { file: 'db/migrations/9999_neuf.sql', kind: 'pragma', ceiling: 0, count: 1, lines: [1] },
    ]);
  });

  it('[R633] un plafond qui monte par rapport à la branche principale est refusé, un fichier ou une sorte nouveaux aussi', () => {
    const base: Ceilings = { a: { raise: 2, glob: 1 } };
    expect(raisedCeilings({ a: { glob: 1 } }, base)).toEqual([]);
    expect(raisedCeilings({ a: { glob: 2, iif: 1 }, b: { pragma: 1 } }, base)).toEqual([
      { file: 'a', kind: 'glob', base: 1, now: 2 },
      { file: 'a', kind: 'iif', base: 0, now: 1 },
      { file: 'b', kind: 'pragma', base: 0, now: 1 },
    ]);
  });

  it('[R633] les déclencheurs et leur RAISE, garde des tables, sont comptés mais tolérés sans plafond', () => {
    const hits = findNonStandard("CREATE TRIGGER t BEFORE DELETE ON x BEGIN SELECT RAISE(ABORT, 'non'); END;\nSELECT 1 WHERE a GLOB 'b';", 'sql');
    expect(hits.map((h) => h.kind)).toEqual(['declencheur', 'raise', 'glob']);
    expect(countByKind(hits)).toEqual({ glob: 1 });
    expect(excesses({ 'db/migrations/9999_neuf.sql': hits.slice(0, 2) }, {})).toEqual([]);
    expect(lowerCeilings({ a: hits }, { a: { raise: 5, glob: 1 } })).toEqual({ a: { glob: 1 } });
  });

  it('[R633] les plafonds ne font que baisser quand ils sont réécrits', () => {
    const ceilings: Ceilings = { a: { glob: 2, iif: 1 }, b: { pragma: 1 } };
    expect(lowerCeilings({ a: [hit('glob', 1), hit('glob', 2), hit('glob', 3), hit('instr', 4)], b: [] }, ceilings)).toEqual({ a: { glob: 2 } });
  });

  it('[R633] le dépôt ne dépasse aucun plafond, et chaque plafond correspond à une occurrence', () => {
    const found = scanRepository();
    const ceilings = JSON.parse(readFileSync(ceilingsPath, 'utf8')) as Ceilings;
    if (process.env.ECRIRE_CARTE_SQL === '1') {
      writeFileSync(ceilingsPath, `${JSON.stringify(lowerCeilings(found, ceilings), null, 2)}\n`);
      writeFileSync(mapPath, renderMap(found));
    }
    const raised = raisedCeilings(ceilings, baseCeilings());
    expect(raised.map((r) => `${r.file} : plafond ${r.kind} monté de ${r.base} à ${r.now} par rapport à la branche principale`)).toEqual([]);
    const over = excesses(found, ceilings);
    expect(over.map((e) => `${e.file} : ${e.kind}, ${e.count} pour un plafond de ${e.ceiling}, lignes ${e.lines.join(', ')}`)).toEqual([]);
    // Un plafond au-dessus du compte doit être baissé : la carte et les plafonds disent ce qui existe.
    expect(lowerCeilings(found, ceilings)).toEqual(ceilings);
  });

  it('[R633] la carte du passage est celle que donne le compte', () => {
    expect(readFileSync(mapPath, 'utf8')).toBe(renderMap(scanRepository()));
  });
});
