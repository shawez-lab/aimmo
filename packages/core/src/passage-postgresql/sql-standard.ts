/**
 * Ce qui n'est pas du SQL standard, compté (HX67 ; Architecture technique : « Pour que ce passage soit simple, le code
 * n'utilise dès le départ que du SQL standard, par une seule couche d'accès aux données. ») [R633].
 *
 * Chaque sorte est une forme que SQLite et D1 lisent et que PostgreSQL ne lit pas telle quelle. Le test
 * `sql-standard.test.ts` les compte dans les migrations et le code, fichier par fichier : un compte peut baisser,
 * jamais monter, et une forme nouvelle dans un fichier est refusée avec son fichier et sa ligne. La carte du passage
 * (`docs/PASSAGE-POSTGRESQL.md`) est écrite depuis ce compte.
 *
 * Les déclencheurs et leur `RAISE(ABORT…)`, garde des tables [R17], sont comptés mais tolérés sans plafond : chaque
 * migration nouvelle en porte. Une fonction est reconnue quelle que soit sa casse. Les commentaires ne comptent pas. Dans le code TypeScript, seules les formes qui ne peuvent pas être du JavaScript
 * sont cherchées (aucune fonction `Date`, aucun `typeof`).
 */

export interface NonStandardKind {
  kind: string;
  /** Ce que c'est, en français. */
  label: string;
  /** Ce que PostgreSQL demande à la place. */
  postgres: string;
  pattern: RegExp;
  /**
   * Tolérée sans plafond : la garde des tables par déclencheur est la façon dont la base tient R17 (rien ne change ni
   * ne s'efface) ; chaque migration nouvelle en porte. Comptée, jamais plafonnée.
   */
  tolerated?: true;
  /** Écarte une occurrence qui n'est pas la forme cherchée (un type `CHAR(3)`, par exemple). */
  skip?: (text: string, index: number) => boolean;
}

/** Un type de colonne `CHAR(n)` après le nom d'une colonne, standard, n'est pas la fonction `char`. */
const SQL_WORDS_BEFORE_A_VALUE = new Set(['and', 'or', 'not', 'select', 'when', 'then', 'else', 'in', 'by', 'return', 'is', 'like', 'values', 'set', 'on', 'where', 'having']);
function isCharType(text: string, index: number): boolean {
  if (!/^char\s*\(\s*\d+\s*\)/i.test(text.slice(index, index + 20))) return false;
  const before = /([A-Za-z_][A-Za-z0-9_]*)"?\s+$/.exec(text.slice(Math.max(0, index - 80), index));
  return before !== null && !SQL_WORDS_BEFORE_A_VALUE.has(before[1]!.toLowerCase());
}

export const NON_STANDARD_KINDS: readonly NonStandardKind[] = [
  { kind: 'declencheur', label: 'Déclencheur écrit à la façon de SQLite (`CREATE TRIGGER … BEGIN … END`)', postgres: 'une fonction `plpgsql` et `CREATE TRIGGER … EXECUTE FUNCTION`', pattern: /\bCREATE\s+TRIGGER\b/gi, tolerated: true },
  { kind: 'raise', label: '`RAISE(ABORT, …)` dans un déclencheur', postgres: '`RAISE EXCEPTION` dans la fonction du déclencheur', pattern: /\bRAISE\s*\(\s*(?:ABORT|FAIL|IGNORE|ROLLBACK)\b/gi, tolerated: true },
  { kind: 'insert_or', label: '`INSERT OR IGNORE` ou `INSERT OR REPLACE`', postgres: '`INSERT … ON CONFLICT DO NOTHING` ou `DO UPDATE`', pattern: /\bINSERT\s+OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b/gi },
  { kind: 'glob', label: '`GLOB`', postgres: '`~` (expression régulière) ou `SIMILAR TO`', pattern: /\bGLOB\b/gi },
  { kind: 'date_sqlite', label: 'Fonctions de date de SQLite (`datetime`, `julianday`, `strftime`, `unixepoch`)', postgres: '`now()`, `to_char`, `extract`, `interval`', pattern: /\b(?:datetime|julianday|strftime|unixepoch)\s*\(/gi },
  { kind: 'autoincrement', label: '`AUTOINCREMENT`', postgres: '`GENERATED ALWAYS AS IDENTITY`', pattern: /\bAUTOINCREMENT\b/gi },
  { kind: 'pragma', label: '`PRAGMA` et fonctions `pragma_…`', postgres: 'le catalogue (`pg_catalog`, `information_schema`) ou un réglage de la base', pattern: /\bPRAGMA\b|\bpragma_\w+\s*\(/gi },
  { kind: 'rowid', label: '`rowid` et `last_insert_rowid()`', postgres: 'une clé déclarée et `RETURNING`', pattern: /\b(?:last_insert_)?rowid\b/gi },
  { kind: 'group_concat', label: '`group_concat`', postgres: '`string_agg`', pattern: /\bgroup_concat\s*\(/gi },
  { kind: 'json_sqlite', label: 'Fonctions JSON de SQLite (`json_extract`, `json_each`, `json_group_array`…)', postgres: 'opérateurs `->`, `->>` et `jsonb_array_elements`, `jsonb_agg`', pattern: /\bjson_(?:extract|each|tree|group_array|group_object|array_length|valid|type|set|insert|replace|remove|patch|quote)\s*\(/gi },
  { kind: 'ifnull', label: '`IFNULL`', postgres: '`COALESCE`', pattern: /\bIFNULL\s*\(/gi },
  { kind: 'iif', label: '`IIF`', postgres: '`CASE WHEN … END`', pattern: /\bIIF\s*\(/gi },
  { kind: 'instr', label: '`instr`', postgres: '`position(… in …)` ou `strpos`', pattern: /\binstr\s*\(/gi },
  { kind: 'char', label: '`char(…)` pour un caractère par son code', postgres: '`chr(…)`', pattern: /\bchar\s*\(/gi, skip: isCharType },
  { kind: 'printf', label: '`printf` en SQL', postgres: '`format` ou `to_char`', pattern: /\bprintf\s*\(/gi },
];

export interface NonStandardHit {
  kind: string;
  /** Ligne, à partir de 1. */
  line: number;
}

/**
 * Remplace les commentaires par des espaces, en gardant les retours à la ligne, pour que les lignes restent justes.
 * SQL : `-- …` hors chaîne. TypeScript : `// …` hors chaîne et `/* … *\/`. Les chaînes ne sont pas touchées.
 */
export function blankComments(text: string, lang: 'sql' | 'ts'): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (quote) {
      // En TypeScript, une chaîne entre ' ou " ne passe pas la ligne : une apostrophe d'une expression régulière ne
      // masque jamais la suite du fichier.
      if (lang === 'ts' && c === '\n' && quote !== '`') quote = null;
      out += c;
      if (lang === 'ts' && c === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || (lang === 'ts' && (c === '"' || c === '`'))) {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    const lineComment = lang === 'sql' ? c === '-' && next === '-' : c === '/' && next === '/';
    if (lineComment) {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < text.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Chaque forme non standard du texte, avec sa ligne, dans l'ordre du texte puis des sortes. */
export function findNonStandard(text: string, lang: 'sql' | 'ts'): NonStandardHit[] {
  const clean = blankComments(text, lang);
  const lineStarts = [0];
  for (let i = 0; i < clean.length; i += 1) if (clean[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const hits: NonStandardHit[] = [];
  for (const k of NON_STANDARD_KINDS) {
    for (const m of clean.matchAll(new RegExp(k.pattern.source, k.pattern.flags))) {
      if (k.skip?.(clean, m.index)) continue;
      hits.push({ kind: k.kind, line: lineOf(m.index) });
    }
  }
  return hits.sort((a, b) => a.line - b.line || NON_STANDARD_KINDS.findIndex((k) => k.kind === a.kind) - NON_STANDARD_KINDS.findIndex((k) => k.kind === b.kind));
}

const TOLERATED = new Set(NON_STANDARD_KINDS.filter((k) => k.tolerated).map((k) => k.kind));

/** Les comptes plafonnés d'un fichier, sorte par sorte, sans les sortes absentes ni les sortes tolérées. */
export function countByKind(hits: readonly NonStandardHit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hits) if (!TOLERATED.has(h.kind)) out[h.kind] = (out[h.kind] ?? 0) + 1;
  return out;
}

export interface CeilingRaise {
  file: string;
  kind: string;
  base: number;
  now: number;
}

/**
 * Chaque plafond plus haut que celui de la version de référence (la branche principale) : un plafond ne monte jamais,
 * et un fichier ou une sorte absents de la référence y valent zéro [R633].
 */
export function raisedCeilings(current: Ceilings, base: Ceilings): CeilingRaise[] {
  const out: CeilingRaise[] = [];
  for (const file of Object.keys(current).sort()) {
    for (const kind of Object.keys(current[file]!).sort()) {
      const now = current[file]![kind]!;
      const was = base[file]?.[kind] ?? 0;
      if (now > was) out.push({ file, kind, base: was, now });
    }
  }
  return out;
}

export type Ceilings = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface CeilingExcess {
  file: string;
  kind: string;
  ceiling: number;
  count: number;
  /** Les lignes de cette sorte dans le fichier, pour trouver l'ajout. */
  lines: number[];
}

/** Chaque fichier où une sorte dépasse son plafond (zéro quand le fichier ou la sorte n'y sont pas) [R633]. */
export function excesses(found: Readonly<Record<string, readonly NonStandardHit[]>>, ceilings: Ceilings): CeilingExcess[] {
  const out: CeilingExcess[] = [];
  for (const file of Object.keys(found).sort()) {
    const counts = countByKind(found[file]!);
    for (const kind of Object.keys(counts)) {
      const ceiling = ceilings[file]?.[kind] ?? 0;
      if (counts[kind]! > ceiling) out.push({ file, kind, ceiling, count: counts[kind]!, lines: found[file]!.filter((h) => h.kind === kind).map((h) => h.line) });
    }
  }
  return out;
}

/** Les plafonds ramenés aux comptes : jamais plus haut, une sorte disparue sort, un fichier sans rien sort. */
export function lowerCeilings(found: Readonly<Record<string, readonly NonStandardHit[]>>, ceilings: Ceilings): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const file of Object.keys(ceilings).sort()) {
    const counts = countByKind(found[file] ?? []);
    const kept: Record<string, number> = {};
    for (const kind of Object.keys(ceilings[file]!).filter((k) => !TOLERATED.has(k)).sort()) {
      const n = Math.min(ceilings[file]![kind]!, counts[kind] ?? 0);
      if (n > 0) kept[kind] = n;
    }
    if (Object.keys(kept).length > 0) out[file] = kept;
  }
  return out;
}

/** La carte du passage à PostgreSQL, écrite depuis les comptes : une ligne par sorte, puis les fichiers les plus chargés. */
export function renderMap(found: Readonly<Record<string, readonly NonStandardHit[]>>): string {
  const files = Object.keys(found).sort();
  const total = (kind: string): { count: number; files: number } => {
    let count = 0;
    let n = 0;
    for (const f of files) {
      const c = found[f]!.filter((h) => h.kind === kind).length;
      count += c;
      if (c > 0) n += 1;
    }
    return { count, files: n };
  };
  const lines = [
    '# Carte du passage à PostgreSQL',
    '',
    'Écrite par le test `packages/core/test/sql-standard.test.ts` (HX67, R633) : ne pas la modifier à la main. Pour la refaire après une baisse : `ECRIRE_CARTE_SQL=1 npx vitest run packages/core/test/sql-standard.test.ts`.',
    '',
    'Ce que SQLite et Cloudflare D1 lisent et que PostgreSQL ne lit pas tel quel, compté dans `db/migrations/` et `packages/core/src/`, commentaires exclus. Chaque compte peut baisser, jamais monter : une forme ajoutée fait échouer le test avec son fichier et sa ligne.',
    '',
    '| Sorte | Occurrences | Fichiers | À la place, sous PostgreSQL |',
    '| --- | ---: | ---: | --- |',
  ];
  for (const k of NON_STANDARD_KINDS) {
    const t = total(k.kind);
    if (k.tolerated) lines.push(`| ${k.label} | tolérée, sans plafond | | ${k.postgres} |`);
    else lines.push(`| ${k.label} | ${t.count} | ${t.files} | ${k.postgres} |`);
  }
  const capped = (f: string): number => found[f]!.filter((h) => !TOLERATED.has(h.kind)).length;
  const all = files.reduce((a, f) => a + capped(f), 0);
  const touched = files.filter((f) => capped(f) > 0);
  lines.push(
    '',
    `En tout, hors sortes tolérées : ${all} occurrences dans ${touched.length} fichiers.`,
    '',
    'Les déclencheurs et leur `RAISE` sont la garde des tables (R17) : chaque migration nouvelle en porte, ils sont tolérés sans plafond et seront réécrits en fonctions `plpgsql` au passage.',
    '',
    '## Les fichiers les plus chargés',
    '',
    '| Fichier | Occurrences |',
    '| --- | ---: |',
  );
  const top = touched.sort((a, b) => capped(b) - capped(a) || a.localeCompare(b)).slice(0, 20);
  for (const f of top) lines.push(`| \`${f}\` | ${capped(f)} |`);
  lines.push('');
  return lines.join('\n');
}
