import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NON_STANDARD_KINDS, blankComments, excesses, findNonStandard, lowerCeilings, renderMap, type Ceilings, type NonStandardHit } from '../src/passage-postgresql/index.ts';

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

const kinds = (text: string, lang: 'sql' | 'ts' = 'sql') => findNonStandard(text, lang).map((h) => `${h.kind}@${h.line}`);

describe('HX67 · chaque sorte de SQL non standard est reconnue', () => {
  it('[R633] chaque sorte a son essai, et le SQL standard équivalent ne compte pas', () => {
    const cases: Record<string, [string, string]> = {
      declencheur: ["CREATE TRIGGER t BEFORE DELETE ON x BEGIN SELECT 1; END;", 'CREATE INDEX t ON x (a);'],
      raise: ["SELECT RAISE(ABORT, 'non');", "SELECT 'RAISE plus tard';"],
      insert_or: ['INSERT OR IGNORE INTO x VALUES (1);', 'INSERT INTO x VALUES (1) ON CONFLICT DO NOTHING;'],
      glob: ["SELECT 1 WHERE a GLOB '[0-9]*';", "SELECT 1 WHERE a LIKE '1%';"],
      date_sqlite: ["SELECT datetime('now'), strftime('%Y', a), julianday(a), unixepoch(a);", 'SELECT CURRENT_TIMESTAMP;'],
      autoincrement: ['CREATE TABLE x (id INTEGER PRIMARY KEY AUTOINCREMENT);', 'CREATE TABLE x (id INTEGER PRIMARY KEY);'],
      pragma: ['PRAGMA foreign_keys = ON; SELECT * FROM pragma_table_info(\'x\');', 'SELECT 1;'],
      rowid: ['SELECT rowid, last_insert_rowid() FROM x;', 'SELECT id FROM x;'],
      group_concat: ['SELECT group_concat(a) FROM x;', "SELECT string_agg(a, ',') FROM x;"],
      json_sqlite: ["SELECT json_extract(a, '$.b'), j.value FROM x, json_each(x.a) j;", 'SELECT a FROM x;'],
      ifnull: ['SELECT IFNULL(a, 0) FROM x;', 'SELECT COALESCE(a, 0) FROM x;'],
      iif: ['SELECT iif(a > 0, 1, 0) FROM x;', 'SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END FROM x;'],
      instr: ["SELECT instr(a, 'b') FROM x;", "SELECT position('b' in a) FROM x;"],
      char: ['SELECT char(10) FROM x;', 'CREATE TABLE x (a CHAR(3)); SELECT chr(10);'],
      printf: ["SELECT printf('%d', a) FROM x;", "SELECT format('%s', a) FROM x;"],
    };
    expect(Object.keys(cases).sort()).toEqual(NON_STANDARD_KINDS.map((k) => k.kind).sort());
    for (const [kind, [bad, good]] of Object.entries(cases)) {
      expect(findNonStandard(bad, 'sql').filter((h) => h.kind === kind).length, kind).toBeGreaterThan(0);
      expect(findNonStandard(good, 'sql'), kind).toEqual([]);
    }
    expect(kinds("SELECT datetime('now'), strftime('%Y', a), julianday(a), unixepoch(a);")).toEqual(['date_sqlite@1', 'date_sqlite@1', 'date_sqlite@1', 'date_sqlite@1']);
  });

  it('[R633] les commentaires ne comptent pas, les chaînes oui, et les lignes restent justes', () => {
    const sql = "-- PRAGMA dans un commentaire\nSELECT 1; /* GLOB\n AUTOINCREMENT */\nSELECT '-- pas un commentaire', IFNULL(a, 0) FROM x;\nINSERT OR IGNORE INTO x VALUES (1);";
    expect(kinds(sql)).toEqual(['ifnull@4', 'insert_or@5']);
    const ts = [
      "// db.run('PRAGMA foreign_keys = ON')",
      '/** Lit `PRAGMA page_count`. */',
      "const url = 'https://exemple.test/a'; const q = 'SELECT IFNULL(a, 0) FROM x';",
      'const d = new Date(); const t = typeof d; const n = Date.parse("x");',
      "const r = /[']/; await db.run('INSERT OR REPLACE INTO x VALUES (1)');",
      '`SELECT ${a} FROM x WHERE b GLOB ?`;',
    ].join('\n');
    expect(kinds(ts, 'ts')).toEqual(['ifnull@3', 'insert_or@5', 'glob@6']);
    // Les retours à la ligne d'un commentaire bloc sont gardés.
    expect(blankComments('a/*\n\n*/b', 'ts').split('\n')).toHaveLength(3);
  });
});

describe('HX67 · plafonds par fichier', () => {
  const hit = (kind: string, line: number): NonStandardHit => ({ kind, line });

  it('[R633] une forme ajoutée dans un fichier fait échouer avec le fichier et la ligne ; un compte qui baisse passe', () => {
    const ceilings: Ceilings = { 'db/migrations/0001_x.sql': { raise: 2 } };
    expect(excesses({ 'db/migrations/0001_x.sql': [hit('raise', 3), hit('raise', 9)] }, ceilings)).toEqual([]);
    expect(excesses({ 'db/migrations/0001_x.sql': [hit('raise', 3)] }, ceilings)).toEqual([]);
    expect(excesses({ 'db/migrations/0001_x.sql': [hit('raise', 3), hit('raise', 9), hit('raise', 12)] }, ceilings)).toEqual([
      { file: 'db/migrations/0001_x.sql', kind: 'raise', ceiling: 2, count: 3, lines: [3, 9, 12] },
    ]);
    // Une sorte nouvelle dans un fichier connu, ou un fichier nouveau : plafond zéro.
    expect(excesses({ 'db/migrations/0001_x.sql': [hit('glob', 4)], 'db/migrations/9999_neuf.sql': [hit('pragma', 1)] }, ceilings)).toEqual([
      { file: 'db/migrations/0001_x.sql', kind: 'glob', ceiling: 0, count: 1, lines: [4] },
      { file: 'db/migrations/9999_neuf.sql', kind: 'pragma', ceiling: 0, count: 1, lines: [1] },
    ]);
  });

  it('[R633] les plafonds ne font que baisser quand ils sont réécrits', () => {
    const ceilings: Ceilings = { a: { raise: 2, glob: 1 }, b: { pragma: 1 } };
    expect(lowerCeilings({ a: [hit('raise', 1), hit('raise', 2), hit('raise', 3), hit('iif', 4)], b: [] }, ceilings)).toEqual({ a: { raise: 2 } });
  });

  it('[R633] le dépôt ne dépasse aucun plafond, et chaque plafond correspond à une occurrence', () => {
    const found = scanRepository();
    const ceilings = JSON.parse(readFileSync(ceilingsPath, 'utf8')) as Ceilings;
    if (process.env.ECRIRE_CARTE_SQL === '1') {
      writeFileSync(ceilingsPath, `${JSON.stringify(lowerCeilings(found, ceilings), null, 2)}\n`);
      writeFileSync(mapPath, renderMap(found));
    }
    const over = excesses(found, ceilings);
    expect(over.map((e) => `${e.file} : ${e.kind}, ${e.count} pour un plafond de ${e.ceiling}, lignes ${e.lines.join(', ')}`)).toEqual([]);
    // Un plafond au-dessus du compte doit être baissé : la carte et les plafonds disent ce qui existe.
    expect(lowerCeilings(found, ceilings)).toEqual(ceilings);
  });

  it('[R633] la carte du passage est celle que donne le compte', () => {
    expect(readFileSync(mapPath, 'utf8')).toBe(renderMap(scanRepository()));
  });
});
