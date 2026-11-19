/**
 * La recherche de biens en langage courant (HX28). L'acquéreur décrit ce qu'il cherche avec ses mots ; le code seul,
 * sans IA, en tire des critères pris dans les listes fermées de la fiche acquéreur (T01). Chaque critère garde les mots
 * exacts de la phrase qui le portent [R420] ; un mot discriminant n'en devient jamais un, il est écarté et dit [R50].
 *
 * Jamais vu :
 * - les critères indispensables et les préférences sont séparés d'après la phrase (« si possible », « idéalement ») ;
 * - les communes voisines sont proposées à part, chaque bien marqué « commune voisine de … », jamais ajoutées à la
 *   recherche sans un geste [R423] ;
 * - après chaque refus, avec sa raison dans une liste fermée, les critères s'ajustent et le bien refusé ne revient
 *   plus [R424] ;
 * - chaque résultat dit pourquoi il correspond, critère par critère, avec les mots de la phrase [R420].
 *
 * Seuls les biens que la diffusion autorise sont montrés, et seulement ce qu'une annonce dit : jamais l'adresse
 * [R42, R421]. Une fiche acquéreur n'est créée ou complétée qu'avec l'accord en cours de la personne [R422], et la
 * phrase n'est jamais gardée : seulement les critères et leurs mots.
 *
 * Décidé, lecture prudente : un critère est indispensable sauf si sa partie de phrase dit une préférence ; un nombre
 * sans unité n'est un budget que s'il suit « budget », « max », « jusqu'à » ou « moins de » et dépasse 10 000 ; de
 * plusieurs budgets, le plus haut est le maximum ; « sans jardin » ou « pas de garage » ne font aucun critère ; la phrase
 * est lue sur 500 caractères au plus. Les communes voisines viennent d'un réglage de la direction (défaut ci-dessous).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Project, Property } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { DEFAULT_COMMUNES } from '../qualification/regles.ts';
import {
  BUYER_FEATURES,
  DISCRIMINATING_TERMS,
  EMPTY_SEARCH,
  checkSearchChanges,
  type BuyerFeature,
  type BuyerPropertyKind,
  type BuyerSearch,
  type FicheAcquereur,
  type SearchEnergyClass,
  type SoftCriterion,
} from '../acquereurs/fiche-acquereur.ts';
import { DEFAULT_TOLERANCES, matchBuyer, type DiffusionGate, type MatchProperty, type Tolerances } from '../acquereurs/rapprochement.ts';

export const PHRASE_MAX_LENGTH = 500;

/** Un budget dit infranchissable dans la phrase : aucune tolérance au rapprochement (AU115). */
export const STRICT_BUDGET = /\b(?:budget ferme|maximum absolu|max absolu|infranchissable|pas un euro de plus|sans d[ée]passer)\b/i;

/** Les champs qu'une phrase peut remplir : ceux de la fiche acquéreur, hors financement et urgence. */
export const PHRASE_FIELDS = ['propertyKinds', 'communes', 'features', 'surfaceMinM2', 'roomsMin', 'bedroomsMin', 'budgetMaxEur', 'floorMin', 'floorMax', 'energyClassMax', 'landMinM2'] as const;
export type PhraseField = (typeof PHRASE_FIELDS)[number];

export type Strength = 'must' | 'nice';

export type CriterionSource =
  /** Les mots exacts de la phrase, et leur place. */
  | { kind: 'phrase'; words: string; start: number; end: number }
  /** Un ajustement après le refus d'un bien. */
  | { kind: 'refus'; propertyId: string; reason: RefusalReason }
  /** Une commune voisine que la personne a acceptée. */
  | { kind: 'voisine'; of: string };

export interface PhraseCriterion {
  field: PhraseField;
  /** Un type, une commune, une contrainte ou un nombre entier. */
  value: string | number;
  strength: Strength;
  source: CriterionSource;
}

export interface IgnoredWords {
  words: string;
  start: number;
  end: number;
  /** `R50` : critère discriminant, jamais retenu ; `negation` : « sans … », « pas de … ». */
  reason: 'R50' | 'negation';
}

export interface ParsedPhrase {
  criteria: PhraseCriterion[];
  ignored: IgnoredWords[];
  /** La phrase dit le budget infranchissable (AU115). */
  budgetStrict?: boolean;
}

/** Les raisons d'un refus, en liste fermée : chacune ajuste un critère d'une façon écrite. */
export const REFUSAL_REASONS = ['trop_cher', 'trop_petit', 'pas_assez_de_pieces', 'pas_assez_de_chambres', 'commune', 'type', 'manque'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** Un geste de la personne après les premiers résultats. */
export type SearchStep =
  | { refuse: string; reason: RefusalReason; feature?: BuyerFeature }
  | { acceptNeighbour: string };

/** L'état d'une recherche : les critères, et ce que les refus ont écarté. */
export interface PhraseSearch {
  criteria: PhraseCriterion[];
  ignored: IgnoredWords[];
  excludedCommunes: string[];
  excludedKinds: BuyerPropertyKind[];
  refusedPropertyIds: string[];
  /** Le budget dit infranchissable : la recherche en direct comme la fiche rangée n'ont aucune tolérance (AU115). */
  budgetStrict?: boolean;
}

/** Les communes proches de chaque commune, réglage de la direction ; la relation vaut dans les deux sens. */
export const DEFAULT_NEIGHBOURS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Dijon: ['Talant', 'Fontaine-lès-Dijon', 'Chenôve', 'Longvic', 'Quetigny', 'Saint-Apollinaire', 'Plombières-lès-Dijon', 'Ahuy', 'Chevigny-Saint-Sauveur'],
  Chenôve: ['Marsannay-la-Côte', 'Longvic', 'Perrigny-lès-Dijon'],
  Talant: ['Fontaine-lès-Dijon', 'Plombières-lès-Dijon', 'Daix'],
  'Fontaine-lès-Dijon': ['Ahuy', 'Daix', 'Hauteville-lès-Dijon'],
  Quetigny: ['Saint-Apollinaire', 'Chevigny-Saint-Sauveur'],
  Longvic: ['Ouges', 'Neuilly-Crimolois'],
});

/** Les voisines de chaque commune, dans les deux sens, limitées à la liste fermée des communes. */
export function neighbourMap(table: Readonly<Record<string, readonly string[]>>, communes: readonly string[]): Map<string, string[]> {
  const known = new Set(communes);
  const out = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    if (a === b || !known.has(a) || !known.has(b)) return;
    const list = out.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    out.set(a, list);
  };
  for (const [a, list] of Object.entries(table)) for (const b of list) {
    link(a, b);
    link(b, a);
  }
  return out;
}

// ————— Lecture de la phrase —————

/** La phrase mise en minuscules sans accents, caractère pour caractère : les places restent celles de la phrase. */
function fold(phrase: string): string {
  let out = '';
  for (const c of phrase) {
    const n = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const one = n.length === c.length ? n : c.length === 1 ? ' ' : ' '.repeat(c.length);
    out += one;
  }
  return out;
}

const key = (s: string): string => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();
/** Le motif d'une suite de mots : espaces, tirets ou apostrophes entre eux. */
const wordsPattern = (s: string): string => key(s).split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join("[\\s'’-]+");
const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';

const KIND_WORDS: readonly [string, BuyerPropertyKind][] = [
  ['maisons?|villas?|pavillons?|longeres?|corps de ferme|maison de ville', 'house'],
  ['appartements?|apparts?|studios?|duplex|lofts?', 'apartment'],
  ['terrains?( a batir)?|parcelles?', 'land'],
  ['immeubles?( de rapport)?', 'building'],
  ['(local|locaux)( commerciaux| commercial| professionnels?)?|bureaux?|boutiques?', 'commercial'],
];

const FEATURE_WORDS: readonly [string, BuyerFeature][] = [
  ['jardins?', 'garden'],
  ['balcons?', 'balcony'],
  ['terrasses?', 'terrace'],
  ['garages?', 'garage'],
  ['parkings?|places? de parking|stationnement|place pour (la|une) voiture', 'parking'],
  ['caves?', 'cellar'],
  ['ascenseur', 'elevator'],
  ['piscines?', 'pool'],
  ['plain[\\s-]?pied', 'single_storey'],
  ['calmes?', 'quiet'],
  ['lumineux|lumineuse|lumineuses|lumiere|clair et lumineux', 'bright'],
  ['(belle |une |avec )vue|vue degagee', 'view'],
  ['cheminees?', 'fireplace'],
  ['dependances?', 'outbuilding'],
];

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
});
const COUNT = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})`;
const countOf = (s: string): number => NUMBER_WORDS[s] ?? Number(s);

const MUST_MARKERS = /(?<![a-z])(absolument|imperati(f|ve|vement)|indispensable|obligatoire(ment)?|il (me|nous) faut|exige|necessaire|incontournable|non negociable)(?![a-z])/;
const NICE_MARKERS =
  /(?<![a-z])(si possible|idealement|dans l'?ideal|de preference|ce serait (bien|top|un plus)|serait un plus|un plus|en bonus|bonus|pourquoi pas|eventuellement|j'?aimerais|on aimerait|apprecie|bienvenue?s?|pas obligatoire|facultati(f|ve))(?![a-z])/;

/**
 * La force d'un critère, lue dans sa partie de phrase (coupée aux virgules, points, « mais » et « et »). Une partie sans
 * marque reprend celle de la partie à laquelle « et » la relie : « si possible un jardin et un garage » fait deux
 * préférences, « avec jardin et si possible un garage » une exigence et une préférence.
 */
function strengthIn(folded: string, at: number): Strength {
  const parts: { start: number; end: number; byEt: boolean }[] = [];
  let start = 0;
  let byEt = false;
  for (const m of folded.matchAll(/(?<!\d)[,.](?!\d)|[;!?\n]|(?<![a-z])mais(?![a-z])|(?<![a-z])et(?![a-z])/g)) {
    parts.push({ start, end: m.index, byEt });
    start = m.index + m[0].length;
    byEt = m[0] === 'et';
  }
  parts.push({ start, end: folded.length, byEt });
  let k = parts.findIndex((p) => at >= p.start && at < p.end);
  if (k < 0) k = parts.length - 1;
  for (; k >= 0; k -= 1) {
    const clause = folded.slice(parts[k]!.start, parts[k]!.end);
    if (MUST_MARKERS.test(clause)) return 'must';
    if (NICE_MARKERS.test(clause)) return 'nice';
    if (!parts[k]!.byEt) break;
  }
  return 'must';
}

/** Les mots discriminants de la liste fermée de R50, avec leur place. */
const DISCRIMINATING_PATTERN = new RegExp(`${B}(${DISCRIMINATING_TERMS.map(wordsPattern).sort((a, b) => b.length - a.length).join('|')})${E}`, 'g');

/** Une somme lue dans la phrase, en euros, ou null. */
function amount(raw: string, unit: string | undefined): number | null {
  // « 350 000 » ou « 350.000 » : des milliers ; « 1.2 » ou « 1,2 » : une décimale.
  const grouped = /^\d{1,3}(?:[\s.\u00a0\u202f]\d{3})+$/.test(raw);
  const digits = grouped ? raw.replace(/[\s.\u00a0\u202f]/g, '') : raw.replace(',', '.');
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const u = (unit ?? '').replace(/\s/g, '');
  let value = n;
  if (/^(k|keur|k€|kilo|mille)/.test(u)) value = n * 1000;
  else if (/^(m€|meur|millions?|million)/.test(u)) value = n * 1_000_000;
  const rounded = Math.round(value);
  return rounded >= 10_000 && rounded <= 1_000_000_000 ? rounded : null;
}

/**
 * Lit une phrase : des critères pris dans les listes fermées, chacun avec ses mots exacts [R420] ; les mots
 * discriminants et les négations écartés et dits [R50]. Une fonction pure, sans IA.
 */
export function parsePhrase(phrase: string, communes: readonly string[] = DEFAULT_COMMUNES): ParsedPhrase {
  const text = phrase.slice(0, PHRASE_MAX_LENGTH);
  const f = fold(text);
  const taken: [number, number][] = [];
  const free = (s: number, e: number): boolean => taken.every(([a, b]) => e <= a || s >= b);
  const criteria: PhraseCriterion[] = [];
  const ignored: IgnoredWords[] = [];
  const words = (start: number, end: number) => ({ kind: 'phrase' as const, words: text.slice(start, end), start, end });
  const strengthAt = (at: number): Strength => strengthIn(f, at);
  const negated = (at: number): boolean =>
    /(?<![a-z])(sans|pas de|pas d'|pas d’|pas un|pas une|pas a|pas au|pas en|pas sur|hors|hors de|aucun|aucune|ni|ni de|ni d'|ni d’|ni un|ni une|ni a|ni au|surtout pas|jamais)\s*$/.test(f.slice(Math.max(0, at - 14), at));
  const add = (field: PhraseField, value: string | number, start: number, end: number): void => {
    // Une négation, devant n'importe quel critère, n'en fait aucun : elle est dite une fois [R420].
    if (negated(start)) {
      if (!ignored.some((i) => i.start === start)) ignored.push({ words: text.slice(start, end), start, end, reason: 'negation' });
      return;
    }
    if (criteria.some((c) => c.field === field && c.value === value)) return;
    criteria.push({ field, value, strength: strengthAt(start), source: words(start, end) });
  };
  const scan = (pattern: RegExp, each: (m: RegExpMatchArray, start: number, end: number) => boolean | void): void => {
    for (const m of f.matchAll(pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (!free(start, end)) continue;
      if (each(m, start, end) !== false) taken.push([start, end]);
    }
  };

  // Les mots discriminants d'abord : ils ne deviennent jamais un critère, et leur place est prise.
  scan(DISCRIMINATING_PATTERN, (_m, start, end) => {
    ignored.push({ words: text.slice(start, end), start, end, reason: 'R50' });
  });

  // Les communes, la plus longue d'abord : « Fontaine-lès-Dijon » avant « Dijon ».
  for (const c of [...communes].sort((a, b) => key(b).length - key(a).length)) {
    scan(new RegExp(`${B}${wordsPattern(c)}${E}`, 'g'), (_m, start, end) => add('communes', c, start, end));
  }

  // AU072 · le terrain, avant la surface : « terrain de 500 m² » ou « 500 m² de terrain » n'est pas la surface habitable.
  const landOf = (raw: string): number | null => {
    const n = Number(raw.replace(/[ \u00a0\u202f]/g, ''));
    return Number.isInteger(n) && n >= 1 && n <= 10_000_000 ? n : null;
  };
  scan(/(?<![a-z])terrain\s+(?:de\s+|d'au moins\s+|minimum\s+|d'environ\s+)?(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d{1,7})\s*(?:m2|m²|m 2|metres? carres?)(?![a-z0-9])/g, (m, start, end) => {
    const n = landOf(m[1] ?? '');
    if (n === null) return false;
    add('landMinM2', n, start, end);
  });
  scan(/(?<![a-z0-9.,]|\d[ \u00a0\u202f])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d{1,7})\s*(?:m2|m²|m 2|metres? carres?)\s+de\s+terrain(?![a-z])/g, (m, start, end) => {
    const n = landOf(m[1] ?? '');
    if (n === null) return false;
    add('landMinM2', n, start, end);
  });
  // AU072 · l'étage : « pas de rez-de-chaussée » (à partir du 1er), « en rez-de-chaussée », « 3e étage maximum »,
  // « à partir du 2e étage ». La négation fait ici partie du critère : elle est lue avec lui.
  const ordinal = '(\\d{1,2})\\s*(?:e|eme|er|ere|°)';
  scan(/(?<![a-z])(?:pas de|pas en|pas au|jamais en|jamais au|sauf)\s+(?:rez[- ]de[- ]chaussee|rdc)(?![a-z])/g, (_m, start, end) => {
    criteria.push({ field: 'floorMin', value: 1, strength: strengthAt(start), source: words(start, end) });
  });
  scan(new RegExp(`(?<![a-z0-9])(?:au\\s+|jusqu'?au\\s+)?${ordinal}\\s+etage\\s+(?:maximum|max|maxi|au plus|au maximum)(?![a-z])`, 'g'), (m, start, end) => {
    add('floorMax', Number(m[1]), start, end);
  });
  scan(new RegExp(`(?<![a-z])(?:a partir du|au moins au|des le)\\s+${ordinal}\\s+etage(?![a-z])|(?<![a-z0-9])${ordinal}\\s+etage\\s+(?:minimum|mini|au moins)(?![a-z])`, 'g'), (m, start, end) => {
    add('floorMin', Number(m[1] ?? m[2]), start, end);
  });
  scan(/(?<![a-z])(?:en|au)\s+(?:rez[- ]de[- ]chaussee|rdc)(?![a-z])/g, (_m, start, end) => {
    add('floorMax', 0, start, end);
  });
  // AU072 · la classe énergie la moins bonne acceptée : « DPE D minimum », « classe C au moins », « D ou mieux ».
  scan(/(?<![a-z])(?:dpe|classe energie|classe energetique|etiquette energie|classe)\s+([a-g])\s+(?:minimum|mini|au moins|ou mieux)(?![a-z])/g, (m, start, end) => {
    add('energyClassMax', (m[1] ?? '').toUpperCase(), start, end);
  });

  // La surface, avant les sommes : « 80 m² » n'est pas un budget.
  // Une surface décimale (« 80,5 m² ») se lit en entier, arrondie au mètre au-dessus : jamais moins que demandé.
  // « 1 200 m² » se lit en entier, espaces insécables compris.
  scan(/(?<![a-z0-9.,]|\d[ \u00a0\u202f])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?|\d{1,6}(?:[.,]\d{1,2})?)\s*(m2|m²|m 2|metres? carres?|mcarres?)(?![a-z0-9])/g, (m, start, end) => {
    const n = Math.ceil(Number((m[1] ?? '').replace(/[ \u00a0\u202f]/g, '').replace(',', '.')));
    if (n < 1 || n > 100_000) return false;
    add('surfaceMinM2', n, start, end);
  });

  // « T3 » ou « F3 » : un appartement de 3 pièces.
  scan(/(?<![a-z0-9])[tf]([1-9])(?![a-z0-9])/g, (m, start, end) => {
    add('propertyKinds', 'apartment', start, end);
    add('roomsMin', Number(m[1]), start, end);
  });
  scan(new RegExp(`${B}${COUNT}\\s*pieces?${E}`, 'g'), (m, start, end) => {
    const n = countOf(m[1] ?? '');
    if (n < 1 || n > 50) return false;
    add('roomsMin', n, start, end);
  });
  scan(new RegExp(`${B}${COUNT}\\s*chambres?${E}`, 'g'), (m, start, end) => {
    const n = countOf(m[1] ?? '');
    if (n < 1 || n > 50) return false;
    add('bedroomsMin', n, start, end);
  });

  // Les sommes : avec une unité (€, euros, k, millions), ou après un mot de budget.
  const budgets: { value: number; start: number; end: number }[] = [];
  // Une somme niée (« pas de 500k ») est dite et écartée avant de choisir le plus haut budget.
  const skipNegated = (start: number, end: number): boolean => {
    if (!negated(start)) return false;
    ignored.push({ words: text.slice(start, end), start, end, reason: 'negation' });
    return true;
  };
  scan(
    /(?<![a-z0-9.,]|\d[ \u00a0\u202f])(\d{1,3}(?:[ .\u00a0\u202f]\d{3})+|\d+(?:[.,]\d+)?)\s*(k\s*€|keur|k|m€|meur|millions?|mille|euros?|€)(?![a-z0-9])/g,
    (m, start, end) => {
      const unit = m[2] ?? '';
      const v = amount(m[1] ?? '', /euro|€/.test(unit) && !/k|m€|meur/.test(unit) ? '' : unit);
      if (v === null) return false;
      if (!skipNegated(start, end)) budgets.push({ value: v, start, end });
    },
  );
  scan(/(?<![a-z])(budget(?:\s+ferme)?|max(imum)?(?:\s+absolu)?|jusqu'?a|moins de|pas plus de|au plus|sans depasser)\s*(de\s*)?(\d{1,3}(?:[ .  ]\d{3})+|\d{5,10})(?![a-z0-9])/g, (m, start, end) => {
    const v = amount(m[4] ?? '', '');
    if (v === null) return false;
    if (!skipNegated(start, end)) budgets.push({ value: v, start, end });
  });
  if (budgets.length > 0) {
    const top = budgets.reduce((a, b) => (b.value > a.value ? b : a));
    add('budgetMaxEur', top.value, top.start, top.end);
  }

  for (const [pattern, kind] of KIND_WORDS) {
    scan(new RegExp(`${B}(${pattern})${E}`, 'g'), (_m, start, end) => {
      add('propertyKinds', kind, start, end);
    });
  }
  for (const [pattern, feature] of FEATURE_WORDS) {
    scan(new RegExp(`${B}(${pattern})${E}`, 'g'), (_m, start, end) => {
      add('features', feature, start, end);
    });
  }
  criteria.sort((a, b) => (a.source.kind === 'phrase' && b.source.kind === 'phrase' ? a.source.start - b.source.start : 0));
  ignored.sort((a, b) => a.start - b.start);
  const budgetStrict = STRICT_BUDGET.test(phrase.slice(0, PHRASE_MAX_LENGTH));
  // Un budget dit ferme est une exigence, même relié par « et » à un souhait (AU115).
  if (budgetStrict) for (const c of criteria) if (c.field === 'budgetMaxEur') c.strength = 'must';
  return { criteria, ignored, budgetStrict };
}

// ————— Refus et voisines —————

const WORDS_LABEL: Record<PhraseField, string> = {
  propertyKinds: 'type',
  communes: 'commune',
  features: 'contrainte',
  surfaceMinM2: 'surface',
  roomsMin: 'pièces',
  bedroomsMin: 'chambres',
  budgetMaxEur: 'budget',
  floorMin: 'étage',
  floorMax: 'étage',
  energyClassMax: 'classe énergie',
  landMinM2: 'terrain',
};

/** Le bien tel qu'un refus le décrit. */
export interface RefusedProperty {
  id: string;
  match: MatchProperty;
}

/**
 * Un refus ajuste la recherche d'une façon écrite, et le bien refusé ne revient plus [R424] :
 * - trop cher : le budget passe sous ce prix, tolérance comprise ;
 * - trop petit : la surface minimale passe au-dessus, tolérance comprise ;
 * - pas assez de pièces ou de chambres : une de plus que le bien ;
 * - commune ou type : écartés ; manque : la contrainte devient indispensable.
 */
export function applyRefusal(
  search: PhraseSearch,
  property: RefusedProperty,
  reason: RefusalReason,
  feature: BuyerFeature | undefined,
  tolerances: Tolerances = DEFAULT_TOLERANCES,
): PhraseSearch {
  const next: PhraseSearch = {
    criteria: search.criteria.map((c) => ({ ...c })),
    ignored: search.ignored,
    excludedCommunes: [...search.excludedCommunes],
    excludedKinds: [...search.excludedKinds],
    // Le budget ferme survit à chaque refus (AU115).
    budgetStrict: search.budgetStrict === true,
    refusedPropertyIds: search.refusedPropertyIds.includes(property.id) ? [...search.refusedPropertyIds] : [...search.refusedPropertyIds, property.id],
  };
  const source: CriterionSource = { kind: 'refus', propertyId: property.id, reason };
  const setNumber = (field: PhraseField, value: number, better: (old: number, value: number) => boolean): void => {
    const old = next.criteria.find((c) => c.field === field && c.strength === 'must');
    if (old && typeof old.value === 'number' && !better(old.value, value)) return;
    next.criteria = next.criteria.filter((c) => !(c.field === field && c.strength === 'must'));
    next.criteria.push({ field, value, strength: 'must', source });
  };
  const p = property.match;
  if (reason === 'trop_cher' && p.priceEur !== null) {
    // Le plus grand budget dont la tolérance n'atteint plus ce prix : (prix − 1) / (1 + tolérance).
    const budget = Math.floor(((p.priceEur - 1) * 100) / (100 + tolerances.budgetOverPct));
    if (budget >= 1) setNumber('budgetMaxEur', budget, (old, v) => v < old);
  } else if (reason === 'trop_petit' && p.surfaceM2 !== null) {
    // La plus petite surface minimale dont la tolérance dépasse cette surface.
    const min = Math.floor((p.surfaceM2 * 100) / (100 - tolerances.surfaceUnderPct)) + 1;
    if (min <= 100_000) setNumber('surfaceMinM2', min, (old, v) => v > old);
  } else if (reason === 'pas_assez_de_pieces' && p.rooms !== null) {
    setNumber('roomsMin', Math.min(50, p.rooms + 1 + tolerances.roomsUnder), (old, v) => v > old);
  } else if (reason === 'pas_assez_de_chambres' && p.bedrooms !== null) {
    setNumber('bedroomsMin', Math.min(50, p.bedrooms + 1), (old, v) => v > old);
  } else if (reason === 'commune' && p.city !== null) {
    if (!next.excludedCommunes.includes(p.city)) next.excludedCommunes.push(p.city);
    next.criteria = next.criteria.filter((c) => !(c.field === 'communes' && c.value === p.city));
  } else if (reason === 'type') {
    for (const k of KINDS_OF_PROPERTY[p.kind] ?? []) if (!next.excludedKinds.includes(k)) next.excludedKinds.push(k);
    next.criteria = next.criteria.filter((c) => !(c.field === 'propertyKinds' && next.excludedKinds.includes(c.value as BuyerPropertyKind)));
  } else if (reason === 'manque' && feature !== undefined && (BUYER_FEATURES as readonly string[]).includes(feature)) {
    const old = next.criteria.find((c) => c.field === 'features' && c.value === feature);
    if (old) old.strength = 'must';
    else next.criteria.push({ field: 'features', value: feature, strength: 'must', source });
  }
  return next;
}

/** Les types de recherche auxquels répond un type du socle, comme dans le rapprochement. */
const KINDS_OF_PROPERTY: Record<string, readonly BuyerPropertyKind[]> = {
  home: ['house', 'apartment'],
  land: ['land'],
  building: ['building'],
  commercial: ['commercial'],
  business_walls: ['commercial'],
  business: ['commercial'],
};

/** Les communes voisines proposées pour la recherche : jamais une commune déjà cherchée ou écartée [R423]. */
export function proposedNeighbours(search: PhraseSearch, neighbours: Map<string, string[]>): { commune: string; of: string }[] {
  const wanted = search.criteria.filter((c) => c.field === 'communes').map((c) => String(c.value));
  const out: { commune: string; of: string }[] = [];
  for (const of of wanted) {
    for (const n of neighbours.get(of) ?? []) {
      if (wanted.includes(n) || search.excludedCommunes.includes(n) || out.some((o) => o.commune === n)) continue;
      out.push({ commune: n, of });
    }
  }
  return out;
}

/** La recherche telle qu'elle passe au rapprochement : les seuls critères indispensables. */
export function toBuyerSearch(search: PhraseSearch, strength: Strength = 'must'): BuyerSearch {
  const out: BuyerSearch = { ...EMPTY_SEARCH, propertyKinds: [], communes: [], features: [] };
  for (const c of search.criteria) {
    if (c.strength !== strength) continue;
    if (c.field === 'propertyKinds' || c.field === 'communes' || c.field === 'features') {
      const list = out[c.field] as string[];
      if (!list.includes(String(c.value))) list.push(String(c.value));
    } else if (c.field === 'energyClassMax') out.energyClassMax = String(c.value) as SearchEnergyClass;
    else if (typeof c.value === 'number') out[c.field] = c.value;
  }
  if (strength === 'must' && out.budgetMaxEur !== null) out.budgetStrict = search.budgetStrict === true;
  out.propertyKinds = out.propertyKinds.filter((k) => !search.excludedKinds.includes(k));
  out.communes = out.communes.filter((c) => !search.excludedCommunes.includes(c));
  return out;
}

// ————— Résultats —————

export interface Reason {
  text: string;
  /** Les mots de la phrase qui portent ce critère, ou ce qui l'a ajusté. */
  from: string;
}

/** Un bien proposé : seulement ce qu'une annonce dit, jamais l'adresse [R421]. */
export interface PhraseResult {
  propertyId: string;
  reference: string;
  kind: string;
  city: string | null;
  priceEur: number | null;
  surfaceM2: number | null;
  rooms: number | null;
  status: 'match' | 'tolerated';
  /** Pourquoi il correspond, critère par critère [R420]. */
  reasons: Reason[];
  /** Les préférences qu'il remplit. */
  preferencesMet: number;
  /** Rempli pour un bien d'une commune voisine, jamais cherchée par la personne [R423]. */
  neighbourOf: string | null;
}

export interface PhraseResults {
  search: PhraseSearch;
  results: PhraseResult[];
  /** Les biens des communes voisines, à part et marqués [R423]. */
  neighbours: PhraseResult[];
  proposedNeighbours: { commune: string; of: string }[];
}

const FEATURE_LABEL: Record<BuyerFeature, string> = {
  garden: 'jardin',
  balcony: 'balcon',
  terrace: 'terrasse',
  garage: 'garage',
  parking: 'stationnement',
  cellar: 'cave',
  elevator: 'ascenseur',
  pool: 'piscine',
  single_storey: 'plain-pied',
  quiet: 'calme',
  bright: 'lumineux',
  view: 'vue',
  fireplace: 'cheminée',
  outbuilding: 'dépendance',
};

const CRITERION_FIELD: Record<string, PhraseField> = {
  kind: 'propertyKinds',
  commune: 'communes',
  budget: 'budgetMaxEur',
  surface: 'surfaceMinM2',
  rooms: 'roomsMin',
  bedrooms: 'bedroomsMin',
  floor: 'floorMin',
  energy: 'energyClassMax',
  land: 'landMinM2',
};

const REFUSAL_LABEL: Record<RefusalReason, string> = {
  trop_cher: 'trop cher',
  trop_petit: 'trop petit',
  pas_assez_de_pieces: 'pas assez de pièces',
  pas_assez_de_chambres: 'pas assez de chambres',
  commune: 'commune',
  type: 'type de bien',
  manque: 'contrainte manquante',
};

const fromOf = (c: PhraseCriterion | undefined): string => {
  if (!c) return '';
  if (c.source.kind === 'phrase') return `« ${c.source.words} »`;
  if (c.source.kind === 'voisine') return `commune voisine de ${c.source.of}, acceptée`;
  return `ajusté après un refus (${REFUSAL_LABEL[c.source.reason]})`;
};

/** Juge un bien pour une recherche : null s'il ne correspond pas. Une fonction pure. */
export function judge(
  search: PhraseSearch,
  property: MatchProperty,
  tolerances: Tolerances = DEFAULT_TOLERANCES,
): { status: 'match' | 'tolerated'; reasons: Reason[]; preferencesMet: number; gap: number } | null {
  const must = toBuyerSearch(search, 'must');
  const nice = toBuyerSearch(search, 'nice');
  const kinds = KINDS_OF_PROPERTY[property.kind] ?? [];
  if (kinds.length > 0 && kinds.every((k) => search.excludedKinds.includes(k))) return null;
  if (property.city !== null && search.excludedCommunes.includes(property.city)) return null;
  const hasMustBase =
    must.propertyKinds.length + must.communes.length > 0 ||
    [must.budgetMaxEur, must.surfaceMinM2, must.roomsMin, must.bedroomsMin, must.floorMin ?? null, must.floorMax ?? null, must.energyClassMax ?? null, must.landMinM2 ?? null].some((v) => v !== null);
  const m = matchBuyer(property, must, tolerances);
  if (hasMustBase && m.status === 'miss') return null;
  const reasons: Reason[] = [];
  // Le critère qui a servi : la commune du bien, son type, ou le nombre retenu dans la recherche passée au rapprochement.
  const sourceOf = (criterion: string, strength: Strength, used: BuyerSearch): PhraseCriterion | undefined => {
    const field = CRITERION_FIELD[criterion]!;
    const candidates = search.criteria.filter((c) => c.field === field && c.strength === strength);
    if (field === 'communes') return candidates.find((c) => property.city !== null && key(String(c.value)) === key(property.city));
    if (field === 'propertyKinds') return candidates.find((c) => kinds.includes(c.value as BuyerPropertyKind) && used.propertyKinds.includes(c.value as BuyerPropertyKind)) ?? candidates[0];
    return candidates.find((c) => c.value === used[field]) ?? candidates[0];
  };
  for (const check of m.checks) reasons.push({ text: check.reason, from: fromOf(sourceOf(check.criterion, 'must', must)) });
  for (const feature of must.features) {
    if (!property.features.includes(feature)) return null;
    reasons.push({ text: `Demandé : ${FEATURE_LABEL[feature]}, présent.`, from: fromOf(search.criteria.find((c) => c.field === 'features' && c.value === feature)) });
  }
  let preferencesMet = 0;
  const niceMatch = matchBuyer(property, nice, tolerances);
  for (const check of niceMatch.checks) {
    if (check.state !== 'met') continue;
    preferencesMet += 1;
    reasons.push({ text: `Préférence remplie. ${check.reason}`, from: fromOf(sourceOf(check.criterion, 'nice', nice)) });
  }
  for (const feature of nice.features) {
    if (!property.features.includes(feature)) continue;
    preferencesMet += 1;
    reasons.push({ text: `Préférence remplie : ${FEATURE_LABEL[feature]}.`, from: fromOf(search.criteria.find((c) => c.field === 'features' && c.value === feature)) });
  }
  if (reasons.length === 0) return null;
  return { status: m.status === 'tolerated' ? 'tolerated' : 'match', reasons, preferencesMet, gap: m.gap };
}

// ————— La recherche, sur la base —————

/** Ce qu'il faut du rapprochement : la lecture d'un bien pour le rapprocher. */
export interface PropertyReader {
  propertyForMatch(p: Property): Promise<MatchProperty>;
}

export type RechercheRefusal = { ok: false; rule: 'R16' | 'R50' | 'R420' | 'R422' | 'R424'; code: string };

export interface RechercheLangageOptions {
  communes?: readonly string[];
  neighbours?: Readonly<Record<string, readonly string[]>>;
  tolerances?: Tolerances;
  /** Le plus de biens montrés, dans chaque liste. */
  limit?: number;
  now?: () => Date;
  newId?: () => string;
}

/** La finalité de l'accord qui permet de ranger une recherche dans la fiche acquéreur [R422]. */
export const SEARCH_CONSENT_PURPOSE = 'buyer_search';

const LIST_FIELD = new Set<PhraseField>(['propertyKinds', 'communes', 'features']);

export class RechercheLangage {
  private readonly communes: readonly string[];
  private readonly neighbours: Map<string, string[]>;
  private readonly tolerances: Tolerances;
  private readonly limit: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly reader: PropertyReader,
    private readonly diffusion: DiffusionGate,
    private readonly journal: JournalStore,
    options: RechercheLangageOptions = {},
  ) {
    this.communes = options.communes ?? DEFAULT_COMMUNES;
    this.neighbours = neighbourMap(options.neighbours ?? DEFAULT_NEIGHBOURS, this.communes);
    this.tolerances = options.tolerances ?? DEFAULT_TOLERANCES;
    this.limit = options.limit ?? 20;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * La recherche rejouée depuis la phrase et les gestes de la personne, toujours sur le serveur : rien de ce que
   * l'écran envoie ne devient un critère sans passer par la lecture de la phrase.
   */
  async build(networkId: string, phrase: string, steps: readonly SearchStep[] = []): Promise<PhraseSearch> {
    const parsed = parsePhrase(phrase, this.communes);
    let search: PhraseSearch = { criteria: parsed.criteria, ignored: parsed.ignored, excludedCommunes: [], excludedKinds: [], refusedPropertyIds: [], budgetStrict: parsed.budgetStrict === true };
    for (const step of steps.slice(0, 50)) {
      if ('acceptNeighbour' in step) {
        const proposal = proposedNeighbours(search, this.neighbours).find((n) => n.commune === step.acceptNeighbour);
        if (proposal) search = { ...search, criteria: [...search.criteria, { field: 'communes', value: proposal.commune, strength: 'must', source: { kind: 'voisine', of: proposal.of } }] };
        continue;
      }
      if (!(REFUSAL_REASONS as readonly string[]).includes(step.reason)) continue;
      // Seul un bien montrable se refuse, ou un bien déjà mis en vente un jour (IN11), dont l'annonce a été publique :
      // un refus fait avant sa vente garde son effet [R424], et un bien jamais montré ne laisse rien deviner [R421].
      const p = await this.db.first<Property>('SELECT * FROM properties WHERE id = ? AND network_id = ?', [step.refuse, networkId]);
      if (!p) continue;
      const shown = p.status === 'available' && (await this.diffusion.canDiffuse(networkId, p.id, this.now())).allowed;
      const onceOnSale = await this.db.first<{ n: number }>('SELECT 1 AS n FROM property_on_sale WHERE property_id = ? AND network_id = ?', [p.id, networkId]);
      if (!shown && !onceOnSale) continue;
      search = applyRefusal(search, { id: p.id, match: await this.reader.propertyForMatch(p) }, step.reason, step.feature, this.tolerances);
    }
    return search;
  }

  /** Les biens qui répondent à la phrase : seulement des biens diffusables [R421], chacun avec ses raisons [R420]. */
  async search(networkId: string, phrase: string, steps: readonly SearchStep[] = []): Promise<PhraseResults> {
    const search = await this.build(networkId, phrase, steps);
    const proposals = proposedNeighbours(search, this.neighbours);
    const neighbourOf = new Map(proposals.map((p) => [p.commune, p.of]));
    const must = toBuyerSearch(search, 'must');
    const at = this.now();
    const rows = await this.db.all<Property>("SELECT * FROM properties WHERE network_id = ? AND status = 'available' ORDER BY reference, id", [networkId]);
    const found: (PhraseResult & { gap: number })[] = [];
    const near: (PhraseResult & { gap: number })[] = [];
    for (const p of rows) {
      if (search.refusedPropertyIds.includes(p.id)) continue;
      const inNeighbour = p.city !== null && neighbourOf.has(p.city) && must.communes.length > 0;
      const match = await this.reader.propertyForMatch(p);
      // Un bien d'une commune voisine se juge comme si sa commune était cherchée, puis se marque à part.
      const judged = inNeighbour
        ? judge({ ...search, criteria: [...search.criteria, { field: 'communes', value: p.city!, strength: 'must', source: { kind: 'voisine', of: neighbourOf.get(p.city!)! } }] }, match, this.tolerances)
        : judge(search, match, this.tolerances);
      if (!judged) continue;
      // La diffusion se demande en dernier, juste avant de montrer [R42].
      if (!(await this.diffusion.canDiffuse(networkId, p.id, at)).allowed) continue;
      const result = {
        propertyId: p.id,
        reference: p.reference,
        kind: p.kind,
        city: p.city,
        priceEur: match.priceEur,
        surfaceM2: p.surface_m2,
        rooms: p.rooms,
        status: judged.status,
        reasons: inNeighbour
          ? [{ text: `Commune voisine de ${neighbourOf.get(p.city!)!}, proposée : ${p.city!} n'est pas dans la recherche.`, from: 'commune voisine' }, ...judged.reasons.filter((r) => r.from !== `commune voisine de ${neighbourOf.get(p.city!)!}, acceptée`)]
          : judged.reasons,
        preferencesMet: judged.preferencesMet,
        neighbourOf: inNeighbour ? neighbourOf.get(p.city!)! : null,
        gap: judged.gap,
      };
      (inNeighbour ? near : found).push(result);
    }
    const order = (a: PhraseResult & { gap: number }, b: PhraseResult & { gap: number }): number =>
      (a.status === b.status ? 0 : a.status === 'match' ? -1 : 1) || b.preferencesMet - a.preferencesMet || a.gap - b.gap || (a.priceEur ?? Infinity) - (b.priceEur ?? Infinity) || a.reference.localeCompare(b.reference);
    const strip = ({ gap: _gap, ...r }: PhraseResult & { gap: number }): PhraseResult => r;
    return {
      search,
      results: found.sort(order).slice(0, this.limit).map(strip),
      neighbours: near.sort(order).slice(0, this.limit).map(strip),
      proposedNeighbours: proposals,
    };
  }

  /**
   * Range la recherche dans la fiche acquéreur du projet (T01), seulement avec l'accord en cours de la personne pour
   * cette finalité [R422]. La fiche fait ses propres contrôles : droits [R16], listes fermées [R50], versions [R17].
   * La phrase n'est pas gardée ; les critères et leurs mots, oui.
   */
  async save(
    acces: Acces,
    viewer: Viewer,
    fiche: FicheAcquereur,
    projectId: string,
    phrase: string,
    steps: readonly SearchStep[] = [],
  ): Promise<{ ok: true; value: { buyerSearchId: string | null; criteria: number } } | RechercheRefusal> {
    const project = await this.db.first<Project>("SELECT * FROM projects WHERE id = ? AND network_id = ? AND kind = 'buy'", [projectId, viewer.networkId]);
    if (!project) return this.refused(viewer, projectId, 'R16', 'unknown');
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, projectId, 'R16', 'role');
    const read = await acces.readFiche(viewer, project.person_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, projectId, 'R16', 'not_assigned');

    const at = this.now().toISOString();
    const consent = await this.db.first<{ id: string }>(
      `SELECT id FROM consents WHERE person_id = ? AND network_id = ? AND purpose = ? AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?)
       ORDER BY given_at DESC, id LIMIT 1`,
      [project.person_id, project.network_id, SEARCH_CONSENT_PURPOSE, at, at],
    );
    if (!consent) return this.refused(viewer, projectId, 'R422', 'sans_accord');

    const search = await this.build(viewer.networkId, phrase, steps);
    const must = toBuyerSearch(search, 'must');
    const nice = toBuyerSearch(search, 'nice');
    if (search.criteria.length === 0) return this.refused(viewer, projectId, 'R420', 'aucun_critere');
    // La fiche n'a pas d'exclusion : une commune ou un type écarté par un refus ne se range que si la liste qui reste
    // dit ce qui est cherché ; sinon la fiche garderait ce qui a été refusé [R424].
    const cleared = (search.excludedCommunes.length > 0 && must.communes.length === 0) || (search.excludedKinds.length > 0 && must.propertyKinds.length === 0);
    if (cleared) return this.refused(viewer, projectId, 'R424', 'a_preciser');
    // Les contraintes souhaitées et indispensables vont dans la fiche pour classer ; les indispensables y sont aussi
    // rangées comme impératives, éliminatoires au rapprochement (AU071). Un budget dit infranchissable perd sa tolérance (AU115).
    const changes: Partial<BuyerSearch> = {};
    for (const field of PHRASE_FIELDS) {
      const excluded = (field === 'communes' && search.excludedCommunes.length > 0) || (field === 'propertyKinds' && search.excludedKinds.length > 0);
      if (!excluded && !search.criteria.some((c) => c.field === field && (c.strength === 'must' || field === 'features'))) continue;
      if (LIST_FIELD.has(field)) {
        const list = field === 'features' ? [...new Set([...must.features, ...nice.features])] : (must[field] as string[]);
        (changes as Record<string, unknown>)[field] = list;
      } else (changes as Record<string, unknown>)[field] = must[field];
    }
    if ('features' in changes) changes.requiredFeatures = must.features;
    // AU072 · étage, classe et terrain : un souhait se range aussi, marqué comme tel, jamais éliminatoire.
    const softOf: Record<string, SoftCriterion> = { floorMin: 'floor', floorMax: 'floor', energyClassMax: 'energy', landMinM2: 'land' };
    const soft: SoftCriterion[] = [];
    for (const field of ['floorMin', 'floorMax', 'energyClassMax', 'landMinM2'] as const) {
      if (!search.criteria.some((c) => c.field === field)) continue;
      if ((must[field] ?? null) === null && (nice[field] ?? null) !== null) {
        (changes as Record<string, unknown>)[field] = nice[field];
        if (!soft.includes(softOf[field]!)) soft.push(softOf[field]!);
      }
    }
    if (Object.keys(softOf).some((f) => f in changes)) {
      // Un souhait que la phrase ne touche pas le reste : ses bornes restent dans la fiche, et leur nature avec elles.
      const said = new Set(search.criteria.map((c) => softOf[c.field]).filter((c): c is SoftCriterion => c !== undefined));
      const before = ((await fiche.current(project.id))?.search.softCriteria ?? []).filter((c) => !said.has(c));
      const now = soft.filter((c) => !Object.keys(softOf).some((f) => softOf[f] === c && (must as unknown as Record<string, unknown>)[f] != null));
      changes.softCriteria = [...new Set([...before, ...now])];
    }
    if ('budgetMaxEur' in changes) changes.budgetStrict = must.budgetStrict === true;
    const checked = checkSearchChanges(changes, this.communes);
    if (!checked.ok) return this.refused(viewer, projectId, checked.rule === 'R16' ? 'R16' : 'R50', checked.code);
    const updated = await fiche.update(acces, viewer, projectId, checked.value);
    if (!updated.ok) return { ok: false, rule: updated.rule, code: updated.code };
    const buyerSearchId = updated.created ? (updated.value?.id ?? null) : null;
    const trace = search.criteria.map((c) => ({
      field: c.field,
      value: c.value,
      strength: c.strength,
      source: c.source.kind === 'phrase' ? { kind: 'phrase', words: c.source.words } : c.source.kind === 'voisine' ? { kind: 'voisine', of: c.source.of } : { kind: 'refus', reason: c.source.reason },
    }));
    await this.db.run(
      `INSERT INTO phrase_searches (id, network_id, project_id, buyer_search_id, consent_id, criteria, saved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.newId(), project.network_id, project.id, buyerSearchId, consent.id, JSON.stringify(trace), `${viewer.role}:${viewer.userId}`, at],
    );
    await appendEvent(
      this.journal,
      {
        type: 'recherche.rangee',
        actor: `${viewer.role}:${viewer.userId}`,
        subject: `person:${project.person_id}`,
        data: { project: project.id, criteria: trace.length, created: buyerSearchId !== null },
      },
      this.now,
    );
    return { ok: true, value: { buyerSearchId, criteria: trace.length } };
  }

  private async refused(viewer: Viewer, projectId: string, rule: RechercheRefusal['rule'], code: string): Promise<RechercheRefusal> {
    await appendEvent(
      this.journal,
      { type: 'recherche.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `project:${projectId}`, data: { rule, code } },
      this.now,
    );
    return { ok: false, rule, code };
  }
}

/** Le libellé d'un champ, pour l'écran. */
export const phraseFieldLabel = (field: PhraseField): string => WORDS_LABEL[field];
