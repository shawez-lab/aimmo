import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AIMMO_VERSION } from '../src/index.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(root + path, 'utf8');

const TASK_STATUS =
  // « en cours (voie 2) » : une tâche prise par la seconde voie du chantier (PROTOCOLE, section 8).
  /^(à faire|en cours( \(voie [23]\))?|chez Codex depuis le .+|fait \(\d{4}-\d{2}-\d{2}\)|bloquée : .+)$/;

describe('fondations du dépôt', () => {
  it('le cœur se charge', () => {
    expect(AIMMO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('chaque règle a un numéro unique et un état connu', () => {
    const rows = read('docs/REGLES.md')
      .split('\n')
      .filter((line) => /^\| R\d{2,3} \|/.test(line));
    expect(rows.length).toBeGreaterThan(0);
    // Les règles à trois chiffres (M15, à partir de R100) sont lues comme les autres.
    expect(rows.some((row) => row.startsWith('| R100 |'))).toBe(true);
    // Les vérifications lisent les mêmes lignes : une règle à trois chiffres en service sans test les fait échouer.
    expect(read('scripts/garde-fous.mjs')).toContain('/^\\| R\\d{2,3} \\|/');
    const ids = rows.map((row) => row.split('|')[1]?.trim());
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      expect(['oui', 'non']).toContain(cells[3]);
    }
  });

  it('chaque tâche du plan a un statut connu', () => {
    const lines = read('chantier/PLAN.md').split('\n');
    const tasks = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith('### '));
    expect(tasks.length).toBeGreaterThan(0);
    for (const { line, index } of tasks) {
      const status = lines[index + 1]?.match(/^- Statut : (.+)$/)?.[1];
      expect(status, `statut manquant sous « ${line} »`).toBeDefined();
      expect(status, `statut inconnu sous « ${line} »`).toMatch(TASK_STATUS);
    }
  });

});

describeWithSqlite('base SQLite des tests', () => {
  it('une base SQLite en mémoire est disponible', () => {
    const db = openMemoryDatabase();
    db.exec('create table t (x integer)');
    db.prepare('insert into t values (?)').run(1);
    expect(db.prepare('select count(*) as n from t').get()).toEqual({ n: 1 });
    db.close();
  });
});
