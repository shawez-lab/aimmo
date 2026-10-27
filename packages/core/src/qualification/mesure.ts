/**
 * Le banc de mesure du classement (M03, Q05) : il compare le classement d'AIMMO à celui de Shawez sur des cas
 * anonymisés, et rend le taux d'accord et les écarts, par numéro de cas, sans jamais reprendre leur texte [R13].
 * Les cas réels ne viennent jamais dans le dépôt (H18) : voir docs/MESURE.md.
 */
import { parseCsv } from '../reprise/csv.ts';
import { CATEGORIES, ROUTES, type Category, type Qualified, type Route } from './regles.ts';

export interface MeasureCase {
  text: string;
  category: Category;
  /** Absent : la suite n'est pas mesurée pour ce cas. */
  route?: Route | null;
}

export interface MeasureResult {
  total: number;
  agreed: number;
  /** De 0 à 1. */
  rate: number;
  /** Les cas en désaccord, par numéro (à partir de 1), sans leur texte. */
  gaps: { case: number; expected: Category; got: Category; expectedRoute?: Route | null; gotRoute: Route | null }[];
}

export async function measure(cases: readonly MeasureCase[], classify: (text: string) => Promise<Pick<Qualified, 'category' | 'route'>>): Promise<MeasureResult> {
  const gaps: MeasureResult['gaps'] = [];
  for (const [i, c] of cases.entries()) {
    const got = await classify(c.text);
    const routeWrong = c.route !== undefined && got.route !== c.route;
    if (got.category !== c.category || routeWrong) {
      gaps.push({ case: i + 1, expected: c.category, got: got.category, ...(c.route !== undefined ? { expectedRoute: c.route } : {}), gotRoute: got.route });
    }
  }
  const agreed = cases.length - gaps.length;
  return { total: cases.length, agreed, rate: cases.length === 0 ? 0 : agreed / cases.length, gaps };
}

const CATEGORY_WORDS: Record<string, Category> = {
  vendeur: 'seller',
  acquereur: 'buyer',
  estimation: 'valuation',
  location: 'rent_out',
  'mise en location': 'rent_out',
  professionnel: 'professional',
  partenaire: 'partner',
  curiosite: 'curious',
  indesirable: 'spam',
};

const plainWord = (w: string): string => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Lit les cas au format de docs/MESURE.md : `texte;categorie;suite`, avec une ligne d'en-tête. La catégorie s'écrit
 * en français (vendeur, acquéreur, estimation…) ou en code ; la suite est vide, M15, M16 ou M17. Une ligne illisible
 * fait refuser tout le fichier, avec son numéro et sans son texte.
 */
export function parseMeasureCases(csv: string): MeasureCase[] {
  const rows = parseCsv(csv.replace(/^﻿/, '')).filter((r) => r.some((cell) => cell.trim() !== ''));
  const cases: MeasureCase[] = [];
  for (const [i, row] of rows.slice(1).entries()) {
    const [text = '', rawCategory = '', rawRoute] = row;
    const word = plainWord(rawCategory);
    const category = CATEGORY_WORDS[word] ?? ((CATEGORIES as readonly string[]).includes(word) ? (word as Category) : null);
    if (text.trim() === '' || category === null) throw new Error(`Ligne ${i + 2} illisible : texte ou catégorie manquants.`);
    const route = rawRoute === undefined ? undefined : rawRoute.trim() === '' ? null : rawRoute.trim().toUpperCase();
    if (route !== undefined && route !== null && !(ROUTES as readonly string[]).includes(route)) throw new Error(`Ligne ${i + 2} : suite inconnue.`);
    cases.push({ text, category, ...(route !== undefined ? { route: route as Route | null } : {}) });
  }
  return cases;
}
