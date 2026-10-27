import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DvfSiteSales,
  Fourchette,
  MEASURE_TARGET,
  httpDvfReader,
  measureValuations,
  meetsTarget,
  parseValuationCases,
  type DvfFileReader,
  type Sale,
} from '../src/index.ts';

const NOW = () => new Date('2026-10-27T09:00:00.000Z');
// Ventes inventées autour d'un point fictif, prix au m² de 2 500 à 2 760 €.
const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({
  id: `t:${i}`,
  kind: 'apartment' as const,
  lat: 47.3225 + i * 0.0002,
  lon: 5.0412,
  surface: 60 + i,
  pricePerM2: 2500 + i * 20,
  month: `2025-0${(i % 9) + 1}`,
}));
const fourchette = new Fourchette(
  { coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test' }), within: async () => SALES },
  undefined,
  NOW,
);

const HEADER = 'type;surface;lat;lon;code_postal;estimation_agent;etage;balcon;dpe';

describe('E07 · banc de mesure de l’estimation', () => {
  it('lit le fichier des biens, colonnes dans n’importe quel ordre, facultatives comprises', () => {
    const cases = parseValuationCases(`${HEADER}\nappartement;65;47,323;5,041;21000;170 000 €;2;oui;e\nMaison;120;47.323;5.041;21000;300000;;;\n`);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toEqual({
      line: 2,
      agentValue: 170000,
      property: { kind: 'apartment', surface: 65, lat: 47.323, lon: 5.041, postalCode: '21000', floor: 2, balcony: true, energyClass: 'E' },
    });
    expect(cases[1]!.property.kind).toBe('house');
    expect(parseValuationCases('estimation_agent;code_postal;lon;lat;surface;type\n150000;21000;5.041;47.323;60;appartement')[0]!.agentValue).toBe(150000);
  });

  it('refuse des coordonnées trop précises : elles désigneraient le bien, sans jamais recopier la valeur', () => {
    expect(() => parseValuationCases(`${HEADER}\nappartement;65;47.32251;5.041;21000;170000;;;`)).toThrow(/Ligne 2 : lat .*trois décimales/);
    try {
      parseValuationCases(`${HEADER}\nappartement;65;47.32251;5.041;21000;170000;;;`);
    } catch (e) {
      expect(String(e)).not.toContain('47.32251');
    }
    expect(() => parseValuationCases(`${HEADER}\nstudio;65;47.323;5.041;21000;170000;;;`)).toThrow('Ligne 2 : type');
    expect(() => parseValuationCases(`${HEADER}\nappartement;65;47.323;5.041;21000;;;;`)).toThrow('Ligne 2 : estimation_agent');
    expect(() => parseValuationCases('type;surface\nappartement;65')).toThrow('Colonne manquante : lat.');
  });

  it('rend l’écart de chaque bien, sa position et son explication, et l’écart médian', async () => {
    const lines = [
      'appartement;65;47.323;5.041;21000;170000;;;', // proche du milieu
      'appartement;65;47.323;5.041;21000;250000;;;', // agent bien au-dessus
      'appartement;65;47.323;5.041;21000;120000;;;', // agent bien en dessous
    ];
    const result = await measureValuations(parseValuationCases(`${HEADER}\n${lines.join('\n')}`), fourchette);
    expect(result.total).toBe(3);
    expect(result.measured).toBe(3);
    expect(result.gaps.map((g) => g.position)).toEqual(['dans', 'au-dessus', 'en-dessous']);
    const [near, above, below] = result.gaps.map((g) => g.gapPct!);
    expect(Math.abs(near!)).toBeLessThan(10);
    expect(above).toBeLessThan(-25);
    expect(below).toBeGreaterThan(25);
    expect(result.medianGapPct).toBe(Math.abs(below!) < Math.abs(above!) ? Math.abs(below!) : Math.abs(above!));
    for (const gap of result.gaps) {
      expect(gap.explanation).toMatch(/ventes comparables jusqu'à \d+ m/);
      expect(gap.explanation).toContain('2025-');
    }
    expect(result.gaps[1]!.explanation).toContain('au-dessus de la fourchette');
    expect(result.inside).toBe(1);
  });

  it('un bien sans fourchette est dit avec sa raison, et ne compte pas dans l’écart médian', async () => {
    const lines = ['appartement;65;47.323;5.041;21000;170000;;;', 'appartement;65;47.323;5.041;67000;170000;;;'];
    const result = await measureValuations(parseValuationCases(`${HEADER}\n${lines.join('\n')}`), fourchette);
    expect(result.measured).toBe(1);
    expect(result.gaps[1]).toMatchObject({ line: 3, gapPct: null, position: null });
    expect(result.gaps[1]!.explanation).toContain('Pas de fourchette : département sans ventes DVF');
  });

  it('le critère du cahier : 20 biens mesurés au moins et un écart médian de moins de 10 %', async () => {
    const good = Array.from({ length: MEASURE_TARGET.cases }, () => 'appartement;65;47.323;5.041;21000;170000;;;');
    const ok = await measureValuations(parseValuationCases(`${HEADER}\n${good.join('\n')}`), fourchette);
    expect(meetsTarget(ok)).toBe(true);
    const few = await measureValuations(parseValuationCases(`${HEADER}\n${good.slice(1).join('\n')}`), fourchette);
    expect(meetsTarget(few)).toBe(false);
    const far = await measureValuations(parseValuationCases(`${HEADER}\n${good.map(() => 'appartement;65;47.323;5.041;21000;250000;;;').join('\n')}`), fourchette);
    expect(meetsTarget(far)).toBe(false);
  });

  it('le résultat ne recopie aucune coordonnée', async () => {
    const result = await measureValuations(parseValuationCases(`${HEADER}\nappartement;65;47.323;5.041;21000;170000;;;`), fourchette);
    const dump = JSON.stringify(result);
    expect(dump).not.toContain('47.323');
    expect(dump).not.toContain('5.041');
  });
});

/**
 * La mesure réelle (H19), hors du dépôt, voir docs/MESURE.md :
 * `AIMMO_ESTIMATIONS=/chemin/biens.csv AIMMO_DVF=https://…/donnees-dvf/ npx vitest run packages/core/test/mesure-estimation.test.ts`.
 * `AIMMO_DVF` peut aussi être un dossier local qui contient les fichiers DVF du site. Sans fichier, ce test est sauté.
 */
describe.runIf(process.env.AIMMO_ESTIMATIONS)('E07 · mesure sur biens réels anonymisés', () => {
  it('écart médian de moins de 10 % sur 20 biens, chaque écart expliqué', async () => {
    const dvf = process.env.AIMMO_DVF ?? '';
    const reader: DvfFileReader | null = /^https:\/\//.test(dvf)
      ? httpDvfReader((url, init) => fetch(url, init), dvf.endsWith('/') ? dvf : `${dvf}/`)
      : dvf
        ? async (path) => readFile(join(dvf, path), 'utf8').catch(() => null)
        : null;
    if (!reader) throw new Error('AIMMO_DVF manque : adresse https ou dossier des fichiers DVF du site.');
    const cases = parseValuationCases(readFileSync(process.env.AIMMO_ESTIMATIONS!, 'utf8'));
    const result = await measureValuations(cases, new Fourchette(new DvfSiteSales(reader)));
    console.log(`Mesure : ${result.measured} biens mesurés sur ${result.total}, écart médian ${result.medianGapPct ?? '—'} %, ${result.inside} dans la fourchette.`);
    for (const gap of result.gaps) console.log(`Ligne ${gap.line} : ${gap.gapPct === null ? 'sans fourchette' : `${gap.gapPct} %`}. ${gap.explanation}`);
    expect(result.measured).toBeGreaterThanOrEqual(MEASURE_TARGET.cases);
    expect(meetsTarget(result)).toBe(true);
  });
});
