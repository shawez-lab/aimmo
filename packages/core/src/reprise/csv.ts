/**
 * Lecture d'un fichier CSV exporté d'un outil (tableur, GoHighLevel, ManyChat), sans dépendance.
 * Guillemets doublés, retours à la ligne dans un champ, séparateur virgule, point-virgule ou tabulation
 * reconnu sur la première ligne, marque d'ordre des octets retirée.
 */
export function detectDelimiter(firstLine: string): ',' | ';' | '\t' {
  const counts = ([',', ';', '\t'] as const).map((d) => [d, firstLine.split(d).length] as const);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',';
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  // Des guillemets jamais refermés avaleraient la suite du fichier : refusé plutôt que repris à moitié.
  if (quoted) throw new Error('Fichier CSV mal formé : des guillemets ne sont jamais refermés.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
