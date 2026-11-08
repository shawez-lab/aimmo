// Fabrique le catalogue des règles en service lu par les quiz de formation (HX63) [R570].
// Usage : node scripts/catalogue-regles.mjs > packages/core/src/formation/catalogue-regles.ts
// Le test `formation-quiz.test.ts` vérifie que chaque règle du catalogue est en service dans docs/REGLES.md, sous le même titre.
import { readFileSync } from 'node:fs';

const rows = [];
for (const line of readFileSync('docs/REGLES.md', 'utf8').split('\n')) {
  const m = /^\| (R\d{2,3}) \| ([^|]+?)\. .*\| oui \|/.exec(line);
  if (m) rows.push([m[1], m[2].trim()]);
}
const body = rows.map(([id, title]) => `  [${JSON.stringify(id)}, ${JSON.stringify(title)}],`).join('\n');
process.stdout.write(`// Fichier fabriqué par scripts/catalogue-regles.mjs depuis docs/REGLES.md : ne pas l'écrire à la main.
// Les règles en service, par leur numéro et leur titre, auxquelles une question de formation peut renvoyer [R570].
export const RULE_CATALOG: ReadonlyMap<string, string> = new Map([
${body}
]);
`);
