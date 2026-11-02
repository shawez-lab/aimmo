/**
 * Pages de quartier et articles (M01, AT07) [R155, R46, R07, R150, R151].
 *
 * Une page de quartier, ou un article sur ce quartier, est rédigée par l'IA derrière une interface
 * (`NeighbourhoodWriter`), ou par le secours fait par le code quand l'IA manque, tarde ou propose un texte refusé, à
 * partir des seules données de la base :
 *
 * - les cases de prix publiables du quartier et de sa commune (AT01), avec leur source et leur date ;
 * - le nombre de biens publiés dans la commune (le bien ne porte pas de position : il n'est compté qu'à la commune) ;
 * - les données publiques du quartier rangées par la direction, chacune avec sa source et sa date.
 *
 * Comme l'annonce de P03, le texte est contrôlé phrase par phrase par le code : chaque nombre et chaque fait doit être
 * relié à la donnée dont il vient, sinon le texte est refusé [R155]. Lecture prudente :
 *
 * - un nombre suivi de « € » est un prix de la case (médiane, quartiles), suivi de « ventes » un nombre de ventes, suivi
 *   de « biens » le nombre de biens publiés, suivi d'une unité (m, km, minutes, habitants, %) une donnée de cette
 *   unité ; une année est celle d'une source ou d'une période ; tout autre nombre, et tout nombre écrit en lettres
 *   (« trois écoles »), doit être la valeur d'une donnée ;
 * - un équipement nommé (tramway, école, marché, parc…) exige une donnée de ce genre ;
 * - un nom propre (un mot en majuscule hors début de phrase) doit être le nom du quartier, de la commune, d'une donnée
 *   ou d'une source ; sinon c'est un fait sans source ;
 * - les jugements et tendances sans donnée (« calme », « sûr », « prisé », « en hausse »…) sont refusés, en liste fermée,
 *   volontairement large : mieux vaut un refus de trop ;
 * - jamais d'adresse, de critère discriminant ni de mot interdit (contrôle commun de P03) [R46, R07] ; jamais le nom
 *   d'un client de la base [R46].
 *
 * Aucun texte n'est publié sans validation nommée de la direction, sur son texte exact et sur les données du moment
 * [R155]. Au moment d'être servi, le texte est recontrôlé sur les données du jour : si un chiffre a changé (nouvelle
 * publication DVF, donnée retirée), la page n'est plus servie tant qu'un nouveau texte n'est pas validé.
 */
import type { Viewer } from '../acces/droits.ts';
import { publicTextProblems, sentences } from '../annonces/annonce-sourcee.ts';
import { euros } from '../annonces/mentions.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import type { EstimatedKind } from '../estimation/fourchette.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { foldWord } from './fiche-google.ts';
import { frenchDate } from './page-prix.ts';
import type { CommunePrices, PublicCell } from './prix-versions.ts';

/* ---------- Les données ---------- */

export const FACT_KINDS = ['transport', 'ecole', 'commerce', 'marche', 'parc', 'sport', 'sante', 'culture', 'population', 'autre'] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export const FACT_UNITS = ['nombre', 'm', 'km', 'minutes', 'habitants', 'pourcent'] as const;
export type FactUnit = (typeof FACT_UNITS)[number];

/** Une donnée publique du quartier, avec sa source et sa date. */
export interface NeighbourhoodFact {
  key: string;
  kind: FactKind;
  label: string;
  value: number | null;
  unit: FactUnit | null;
  source: string;
  sourceDate: string;
}

/** Tout ce que l'IA reçoit, et tout ce sur quoi le texte est contrôlé : aucune donnée personnelle. */
export interface NeighbourhoodData {
  zone: { slug: string; name: string; communeSlug: string; communeName: string };
  /** Les cases publiables du quartier et de sa commune [R150]. */
  cells: PublicCell[];
  /** Les biens publiés dans la commune. */
  listings: number;
  facts: NeighbourhoodFact[];
}

export type Topic = 'quartier' | 'prix' | 'equipements';
export type TextKind = 'page' | 'article';

/** L'IA, derrière son interface : elle ne reçoit que les données, rend un titre et un texte. */
export interface NeighbourhoodWriter {
  write(input: { kind: TextKind; topic: Topic; data: NeighbourhoodData }): Promise<{ title: string; body: string }>;
}

/* ---------- Le contrôle du texte ---------- */

export type NeighbourhoodProblem =
  | { code: 'nombre_sans_source'; value: string }
  | { code: 'fait_sans_source'; value: string }
  | { code: 'jugement'; value: string }
  | { code: 'nom_client'; value: string }
  | { code: 'adresse'; value: string }
  | { code: 'critere_discriminant'; value: string }
  | { code: 'mot_interdit'; value: string };

/** D'où vient une affirmation : une case de prix, les biens publiés, une donnée, ou la zone elle-même. */
export interface FactSource {
  ref: string;
  source: string;
  date: string | null;
}

export interface TracedSentence {
  text: string;
  sources: FactSource[];
  problems: NeighbourhoodProblem[];
}

export interface NeighbourhoodTrace {
  ok: boolean;
  sentences: TracedSentence[];
}

/** Les noms des clients de la base, sans accent ni majuscule : aucun ne peut être écrit [R46]. */
export interface ClientNames {
  firstNames: ReadonlySet<string>;
  lastNames: ReadonlySet<string>;
}

const NO_CLIENTS: ClientNames = { firstNames: new Set(), lastNames: new Set() };

const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termFormsRe = (t: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?:e|s|es|x)?(?![\\p{L}\\p{N}])`, 'giu');

/** Les équipements reconnus, chacun avec le genre de donnée qui seul peut en être la source. */
const FEATURES: { kind: FactKind; terms: string[] }[] = [
  { kind: 'transport', terms: ['tramway', 'tram', 'bus', 'gare', 'métro', 'navette', 'ligne', 'arrêt', 'station', 'autoroute', 'rocade', 'piste cyclable', 'vélo', 'vélos'] },
  { kind: 'ecole', terms: ['école', 'écoles', 'collège', 'lycée', 'crèche', 'maternelle', 'primaire', 'université', 'campus', 'faculté'] },
  { kind: 'commerce', terms: ['commerce', 'commerces', 'boulangerie', 'supermarché', 'hypermarché', 'épicerie', 'boutique', 'boutiques', 'centre commercial', 'restaurant', 'restaurants', 'café', 'cafés'] },
  { kind: 'marche', terms: ['marché', 'halles'] },
  { kind: 'parc', terms: ['parc', 'parcs', 'jardin public', 'square', 'espace vert', 'espaces verts', 'bois', 'forêt', 'lac', 'rivière', 'canal', 'promenade'] },
  { kind: 'sport', terms: ['piscine', 'stade', 'gymnase', 'patinoire', 'terrain de sport', 'salle de sport', 'tennis'] },
  { kind: 'sante', terms: ['médecin', 'médecins', 'pharmacie', 'pharmacies', 'hôpital', 'clinique', 'centre de santé', 'dentiste'] },
  { kind: 'culture', terms: ['bibliothèque', 'médiathèque', 'musée', 'théâtre', 'cinéma', 'salle de spectacle', 'conservatoire'] },
  { kind: 'population', terms: ['habitant', 'habitants', 'population'] },
];

/** Jugements et tendances qu'aucune donnée de la base ne porte : liste fermée, volontairement large. */
export const JUDGEMENT_TERMS: readonly string[] = [
  'calme', 'tranquille', 'paisible', 'sûr', 'sûre', 'sécurisé', 'sécurité', 'insécurité', 'dangereux', 'dangereuse', 'populaire', 'bourgeois', 'bourgeoise', 'huppé', 'chic',
  'prisé', 'prisée', 'recherché', 'recherchée', 'cossu', 'cossue', 'mal famé', 'sensible', 'défavorisé', 'défavorisée', 'résidentiel', 'résidentielle', 'dynamique', 'animé', 'animée',
  'vivant', 'vivante', 'agréable', 'charmant', 'charmante', 'pittoresque', 'convivial', 'conviviale', 'hausse', 'baisse', 'augmente', 'augmenté', 'augmentation', 'diminue', 'diminué',
  'diminution', 'flambée', 'record', 'meilleur', 'meilleure', 'pire', 'cher', 'chère', 'bon marché', 'abordable', 'bonne affaire', 'rentable', 'rentabilité', 'plus-value', 'investir',
  'investissement', 'proche', 'proximité', 'à deux pas', 'à quelques pas', 'facilement', 'rapidement', 'bien desservi', 'bien desservie', 'idéalement', 'tous les commerces',
];

/**
 * Racines des jugements et tendances, lues avec leurs accents : toute forme du mot est refusée (« tranquillité »,
 * « grimpent »). Liste fermée, volontairement large.
 */
export const JUDGEMENT_STEMS: readonly string[] = [
  'tranquill', 'sécur', 'idéal', 'attracti', 'essor', 'grimp', 'envol', 'flamb', 'chut', 'recul', 'progress', 'stabil', 'apprécié', 'demandé', 'bruy', 'danger', 'délinqu',
  'crimin', 'nocturn', 'populair', 'prisé', 'recherché', 'dynami', 'anim', 'charm', 'agréabl', 'paisib', 'cossu', 'huppé', 'bourgeois', 'hauss', 'baiss', 'augment', 'diminu',
  'record', 'meilleur', 'pire', 'cherté', 'abordabl', 'rentab', 'invest', 'proche', 'proximit', 'facile', 'rapide', 'convivi', 'résidenti', 'sensibl', 'défavoris', 'vivant',
  'séduis', 'séduit', 'plébisc', 'convoit', 'tendu', 'dynamis', 'renouv', 'transform', 'rénov', 'mutation', 'gentrif', 'boom', 'explos', 'incontourn', 'exceptionn', 'unique',
  'rare', 'paradis', 'calme', 'doubl', 'tripl', 'quadrupl', 'moitié',
];
/** Mots exacts de tendance ou de jugement trop courts pour une racine. */
const JUDGEMENT_WORDS = new Set(['sûr', 'sûre', 'sûrs', 'sûres', 'chic', 'cher', 'chère', 'chers', 'chères', 'monte', 'montent', 'montée', 'monté', 'montés', 'top']);

/** Ce dont aucune donnée de la base ne parle : loyers, impôts, fréquentation, nuisances, lieux sans genre de donnée. */
const UNSOURCED_TERMS: readonly string[] = [
  'loyer', 'loyers', 'location', 'locations', 'louer', 'locataire', 'locataires', 'mensuel', 'mensuelle', 'par mois', 'rendement', 'taxe', 'taxes', 'impôt', 'impôts', 'charges',
  'visiteur', 'visiteurs', 'touriste', 'touristes', 'tourisme', 'nuisance', 'nuisances', 'pollution', 'inondation', 'inondations', 'chômage', 'revenu', 'revenus', 'salaire',
  'salaires', 'aéroport', 'église', 'églises', 'cathédrale', 'mairie', 'port', 'plage', 'magasin', 'magasins', 'poste', 'banque', 'banques', 'usine', 'usines', 'zone industrielle',
  'zoo', 'prison', 'caserne', 'commissariat', 'gendarmerie', 'vignes', 'vignoble', 'château', 'monument', 'monuments', 'patrimoine', 'histoire', 'historique', 'vue',
];

/** Les mots qui peuvent ouvrir une phrase avec une majuscule sans être un nom propre. */
const STARTERS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'pour', 'a', 'aux', 'au', 'selon', 'depuis', 'dans', 'avec', 'sur', 'en', 'ce', 'cet', 'cette', 'ces', 'ici',
  'il', 'elle', 'ils', 'elles', 'on', 'chaque', 'plusieurs', 'pas', 'son', 'sa', 'ses', 'leur', 'leurs', 'entre', 'et', 'mais', 'ou', 'donc', 'par', 'parmi', 'côté', 'cote',
]);

/** Les mots permis dans un titre, en plus des noms de la zone et de la commune. */
const TITLE_WORDS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'quartier', 'quartiers', 'prix', 'a', 'aux', 'au', 'des', 'du', 'de', 'd', 'en', 'et', 'services', 'equipements', 'vivre', 'immobilier',
  'chiffres', 'ventes', 'vente', 'logement', 'logements', 'donnees', 'appartements', 'maisons', 'marche',
]);

/**
 * Les mots permis dans le texte, sans accents, en plus des noms et libellés de la base, des équipements sourcés et des
 * nombres : mots outils et verbes neutres seulement. Tout autre mot est refusé, ce qui ferme la porte aux tendances
 * (« contre », « passé de »), aux projets (« sera prolongé »), aux classements (« la plus forte »), aux quantificateurs
 * (« toutes ») et à tout fait ajouté à côté d'une donnée vraie. Mieux vaut un refus de trop.
 */
const BODY_WORDS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'au', 'aux', 'a', 'en', 'et', 'ou', 'sur', 'pour', 'par', 'avec', 'dans', 'entre', 'selon', 'chez', 'jusqu',
  'est', 'sont', 'compte', 'comptent', 'dessert', 'desservent', 'se', 'vend', 'vendent', 'vendu', 'vendus', 'vendue', 'vendues', 'situe', 'situee', 'situes', 'situees',
  'prix', 'median', 'mediane', 'medians', 'metre', 'metres', 'carre', 'carres', 'quartile', 'quartiles', 'premier', 'troisieme', 'vente', 'ventes', 'appartement', 'appartements',
  'maison', 'maisons', 'bien', 'biens', 'logement', 'logements', 'reseau', 'quartier', 'commune', 'population', 'habitants', 'habitant', 'nombre', 'il', 'elle', 'ils', 'elles',
  'ce', 'cet', 'cette', 'ces', 'son', 'sa', 'ses', 'leur', 'leurs', 'y', 'qui', 'que', 'qu', 'dont', 'celui', 'celle', 'ceux', 'celles', 'ici', 'on', 'publie', 'publies',
  'publiee', 'publiees', 'donnee', 'donnees', 'source', 'sources', 'periode', 'eur', 'euro', 'euros', 'm', 'km', 'kilometre', 'kilometres', 'minute', 'minutes', 'min',
  'pour', 'cent', 'enregistre', 'enregistrees', 'enregistres', 'recensees', 'recenses', 'compter', 'disponible', 'disponibles',
]);

const SPELLED: Record<string, number> = {
  deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, trente: 30,
  quarante: 40, cinquante: 50, soixante: 60, cent: 100, mille: 1000, dizaine: 10, dizaines: 10, douzaine: 12, vingtaine: 20, trentaine: 30, centaine: 100, centaines: 100, milliers: 1000,
  moitie: 50, quart: 25, tiers: 33, million: 1_000_000, millions: 1_000_000, millier: 1000, milliard: 1e9, milliards: 1e9,
};

const NUMBER = /\d{1,3}(?:[   ]\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;
const parseNumber = (raw: string): number => Number(raw.replace(/[   ]/g, '').replace(',', '.'));

type NumberUse = 'prix' | 'ventes' | 'biens' | 'annee' | FactUnit | 'libre';
const UNIT_AFTER: { re: RegExp; use: NumberUse }[] = [
  { re: /^\s*(?:€|euros?|eur)(?![\p{L}])/u, use: 'prix' },
  { re: /^\s*ventes?(?![\p{L}])/u, use: 'ventes' },
  { re: /^\s*(?:biens?|logements?|annonces?)(?![\p{L}])/u, use: 'biens' },
  { re: /^\s*(?:km|kilometres?)(?![\p{L}])/u, use: 'km' },
  { re: /^\s*(?:m|metres?)(?![\p{L}²2])/u, use: 'm' },
  { re: /^\s*(?:minutes?|min|mn)(?![\p{L}])/u, use: 'minutes' },
  { re: /^\s*habitants?(?![\p{L}])/u, use: 'habitants' },
  { re: /^\s*(?:%|pour cent|pourcents?)/u, use: 'pourcent' },
];

/** Les mots en majuscule permis sans donnée : sigles de la source publique et marque du réseau. */
const ALLOWED_PROPER = new Set(['aimmo', 'dvf', 'etat', 'insee', 'etalab']);

interface Numbered {
  value: number;
  use: NumberUse[];
  source: FactSource;
  /** Pour un prix : le type de logement et le niveau de la case, que la phrase doit nommer. */
  cell?: { kind: EstimatedKind; level: 'commune' | 'quartier' };
  /** Pour une donnée : son genre et sa clé. */
  fact?: { kind: FactKind; key: string };
}

const yearOf = (iso: string): number | null => {
  const m = /^(\d{4})-/.exec(iso);
  return m ? Number(m[1]) : null;
};

const CELL_KIND: Record<EstimatedKind, string> = { apartment: 'appartements', house: 'maisons' };

/** Les nombres des données, chacun avec ce qu'il peut être et sa source. */
function numbersOf(data: NeighbourhoodData): Numbered[] {
  const out: Numbered[] = [];
  for (const c of data.cells) {
    const src = (what: string): FactSource => ({ ref: `prix:${c.zone.level}:${c.zone.slug}:${c.kind}:${what}`, source: c.source, date: c.dvfLastSale });
    const meta = { kind: c.kind, level: c.zone.level };
    out.push({ value: c.median, use: ['prix'], source: src('mediane'), cell: meta });
    out.push({ value: c.q1, use: ['prix'], source: src('q1'), cell: meta });
    out.push({ value: c.q3, use: ['prix'], source: src('q3'), cell: meta });
    out.push({ value: c.sales, use: ['ventes'], source: src('ventes'), cell: meta });
    for (const iso of [c.dvfLastSale, c.period.from, c.period.to]) {
      const y = yearOf(iso);
      if (y !== null) out.push({ value: y, use: ['annee'], source: src('periode'), cell: meta });
    }
  }
  out.push({ value: data.listings, use: ['biens'], source: { ref: 'biens:commune', source: 'Biens publiés du réseau', date: null } });
  for (const f of data.facts) {
    const src: FactSource = { ref: `fait:${f.key}`, source: f.source, date: f.sourceDate };
    if (f.value !== null && f.unit !== null) out.push({ value: f.value, use: f.unit === 'nombre' ? ['nombre', 'libre'] : [f.unit], source: src, fact: { kind: f.kind, key: f.key } });
    const y = yearOf(f.sourceDate);
    if (y !== null) out.push({ value: y, use: ['annee'], source: src });
  }
  return out;
}

/** Les noms permis : la zone, la commune, chaque donnée et chaque source, sans accent ni majuscule. */
function namedOf(data: NeighbourhoodData): { text: string; source: FactSource }[] {
  const out: { text: string; source: FactSource }[] = [];
  for (const [name, level] of [[data.zone.name, 'quartier'], [data.zone.communeName, 'commune']] as const) {
    const zone: FactSource = { ref: `zone:${level}`, source: 'Zones du réseau', date: null };
    out.push({ text: name, source: zone });
    // « Les Tilleuls » s'écrit aussi « aux Tilleuls », « des Tilleuls » : le nom sans son article.
    const bare = /^(?:les|le|la)\s+(.+)$/iu.exec(name)?.[1] ?? /^l['’](.+)$/iu.exec(name)?.[1];
    if (bare) out.push({ text: bare, source: zone });
  }
  for (const f of data.facts) out.push({ text: f.label, source: { ref: `fait:${f.key}`, source: f.source, date: f.sourceDate } });
  for (const c of data.cells) out.push({ text: c.source, source: { ref: `prix:${c.zone.level}:${c.zone.slug}:${c.kind}:source`, source: c.source, date: c.dvfLastSale } });
  for (const f of data.facts) out.push({ text: f.source, source: { ref: `fait:${f.key}`, source: f.source, date: f.sourceDate } });
  return out.filter((n) => n.text.trim().length >= 2).sort((a, b) => b.text.length - a.text.length);
}

const sameNumber = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/** Contrôle une phrase sur les données : ses sources et ses problèmes [R155]. */
export function traceNeighbourhoodSentence(sentence: string, data: NeighbourhoodData, clients: ClientNames = NO_CLIENTS, role: 'titre' | 'texte' = 'texte'): TracedSentence {
  const sources: FactSource[] = [];
  const problems: NeighbourhoodProblem[] = [];
  const add = (s: FactSource) => {
    if (!sources.some((x) => x.ref === s.ref)) sources.push(s);
  };
  for (const p of publicTextProblems(sentence)) problems.push(p as NeighbourhoodProblem);

  // Les noms permis sont lus d'abord, puis effacés : leurs mots et leurs nombres (« ligne T1 ») ne sont plus relus.
  let rest = norm(sentence);
  let restCase = sentence.replace(/\s+/g, ' ');
  for (const n of namedOf(data)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(norm(n.text))}(?![\\p{L}\\p{N}])`, 'giu');
    if (!re.test(rest)) continue;
    re.lastIndex = 0;
    add(n.source);
    // Même longueur partout : le texte sans accents et le texte d'origine restent alignés.
    let next = '';
    let last = 0;
    for (const m of rest.matchAll(re)) {
      const at = m.index ?? 0;
      next += rest.slice(last, at) + ' '.repeat(m[0].length);
      restCase = restCase.slice(0, at) + ' '.repeat(m[0].length) + restCase.slice(at + m[0].length);
      last = at + m[0].length;
    }
    rest = next + rest.slice(last);
  }

  // Jugements et tendances, sans donnée possible.
  // Lus avec leurs accents : « sûr » n'est pas « sur ».
  const restLower = restCase.toLowerCase().replace(/[’`]/g, "'");
  for (const t of JUDGEMENT_TERMS) for (const m of restLower.matchAll(termFormsRe(t.toLowerCase()))) problems.push({ code: 'jugement', value: m[0] });
  for (const m of restLower.matchAll(/[\p{L}]+(?:-[\p{L}]+)*/gu)) {
    const w = m[0];
    if (JUDGEMENT_WORDS.has(w) || JUDGEMENT_STEMS.some((st) => w.startsWith(st))) problems.push({ code: 'jugement', value: w });
  }
  // Ce dont aucune donnée ne parle.
  for (const t of UNSOURCED_TERMS) for (const m of rest.matchAll(termFormsRe(norm(t)))) problems.push({ code: 'fait_sans_source', value: m[0] });

  // Ce que la phrase nomme : le quartier, la commune, le type de logement. Un prix doit correspondre aux trois.
  const full = norm(sentence);
  const namesQuarter = sources.some((x) => x.ref === 'zone:quartier');
  const namesCommune = sources.some((x) => x.ref === 'zone:commune');
  const kindsNamed = new Set<EstimatedKind>();
  if (/(?<![\p{L}])appartements?(?![\p{L}])/u.test(full)) kindsNamed.add('apartment');
  if (/(?<![\p{L}])maisons?(?![\p{L}])/u.test(full)) kindsNamed.add('house');
  const featureAfter = (after: string): FactKind | null => {
    const head = after.slice(0, 40);
    for (const f of FEATURES) for (const t of f.terms) if (new RegExp(`^\\s*(?:\\p{L}+\\s+){0,2}${escapeRe(norm(t))}(?![\\p{L}])`, 'u').test(head)) return f.kind;
    return null;
  };

  // Nombres en chiffres.
  const numbers = numbersOf(data);
  const check = (value: number, raw: string, after: string) => {
    const unit = UNIT_AFTER.find((u) => u.re.test(after));
    let uses: NumberUse[];
    if (unit) uses = [unit.use];
    else if (Number.isInteger(value) && value >= 1900 && value <= 2100) uses = ['annee', 'libre'];
    else uses = ['libre'];
    const near = featureAfter(after);
    const src = numbers.find((n) => {
      if (!sameNumber(n.value, value) || !n.use.some((u) => uses.includes(u))) return false;
      const use = n.use.find((u) => uses.includes(u))!;
      // Un prix ou un nombre de ventes : le type de logement et le lieu de sa case doivent être nommés.
      if ((use === 'prix' || use === 'ventes') && n.cell) {
        if (!kindsNamed.has(n.cell.kind)) return false;
        if (n.cell.level === 'quartier' ? !namesQuarter : !namesCommune) return false;
      }
      // Une année : seulement avec sa source nommée, ou le mot « ventes » pour une période de prix.
      if (use === 'annee') return n.cell ? /(?<![\p{L}])ventes?(?![\p{L}])/u.test(full) || full.includes(norm(n.source.source)) : full.includes(norm(n.source.source));
      // Un nombre sans unité : la donnée de l'équipement qui le suit, ou une donnée nommée dans la phrase.
      if (use === 'libre' || use === 'nombre') {
        if (!n.fact) return false;
        return near !== null ? n.fact.kind === near : sources.some((x) => x.ref === `fait:${n.fact!.key}`);
      }
      return true;
    });
    if (src) add(src.source);
    else problems.push({ code: 'nombre_sans_source', value: raw });
  };
  for (const m of sentence.matchAll(/[^\P{Nd}0-9]+/gu)) problems.push({ code: 'nombre_sans_source', value: m[0] });
  for (const m of rest.matchAll(NUMBER)) {
    const at = m.index ?? 0;
    check(parseNumber(m[0]), m[0].replace(/[  ]/g, ' '), rest.slice(at + m[0].length));
  }
  // Nombres en lettres : seulement la valeur d'une donnée ; « un », « une » et « neuf » sont des mots ordinaires.
  for (const m of rest.matchAll(/[\p{L}]+(?:-[\p{L}]+)*/gu)) {
    const parts = m[0].split('-');
    const values = parts.map((p) => SPELLED[p]);
    if (values.every((v) => v === undefined)) continue;
    if (parts.length > 1) {
      problems.push({ code: 'nombre_sans_source', value: m[0] });
      continue;
    }
    const near = featureAfter(rest.slice((m.index ?? 0) + m[0].length));
    const src = numbers.find((n) => sameNumber(n.value, values[0]!) && n.use.some((u) => u === 'libre' || u === 'nombre') && n.fact !== undefined && (near !== null ? n.fact.kind === near : sources.some((x) => x.ref === `fait:${n.fact!.key}`)));
    if (src && !['dizaine', 'dizaines', 'douzaine', 'vingtaine', 'trentaine', 'centaine', 'centaines', 'milliers', 'moitie', 'quart', 'tiers'].includes(parts[0]!)) add(src.source);
    else problems.push({ code: 'nombre_sans_source', value: m[0] });
  }

  // Équipements : il faut une donnée de ce genre ; le plus long terme d'abord.
  const terms = FEATURES.flatMap((f) => f.terms.map((t) => ({ t, kind: f.kind }))).sort((a, b) => b.t.length - a.t.length);
  for (const { t, kind } of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(norm(t))}(?![\\p{L}\\p{N}])`, 'giu');
    if (!re.test(rest)) continue;
    re.lastIndex = 0;
    rest = rest.replace(re, (s) => ' '.repeat(s.length));
    restCase = [...restCase].map((ch, i) => (rest[i] === ' ' ? ' ' : ch)).join('');
    const fact = data.facts.find((f) => f.kind === kind);
    if (fact) add({ ref: `fait:${fact.key}`, source: fact.source, date: fact.sourceDate });
    else problems.push({ code: 'fait_sans_source', value: t });
  }

  // Noms propres hors début de phrase : ni lieu, ni personne, ni marque qui ne soit dans les données.
  const words = [...restCase.matchAll(/[\p{L}][\p{L}'’-]*/gu)];
  words.forEach((w, i) => {
    const word = w[0].replace(/^[dlDL]['’]/u, '');
    if (!/^\p{Lu}/u.test(word)) return;
    const folded = foldWord(word);
    if (ALLOWED_PROPER.has(folded)) return;
    const before = restCase.slice(0, w.index ?? 0).trimEnd();
    // En début de phrase, seulement un mot courant : un nom propre inventé n'y passe pas.
    if (i === 0 && before.replace(/[«"(\s]/gu, '') === '' && STARTERS.has(folded)) return;
    problems.push({ code: 'fait_sans_source', value: word });
  });

  if (role === 'texte') {
    // Les mots restants, hors noms, équipements et nombres : seulement ceux de la liste fermée.
    for (const w of rest.matchAll(/[\p{L}]+/gu)) if (!BODY_WORDS.has(w[0]) && SPELLED[w[0]] === undefined && !problems.some((p) => norm(p.value) === w[0])) problems.push({ code: 'fait_sans_source', value: w[0] });
  }
  if (role === 'titre') {
    // Un titre ne dit rien d'autre que le lieu et le sujet : liste fermée de mots.
    for (const w of rest.matchAll(/[\p{L}]+/gu)) if (!TITLE_WORDS.has(w[0])) problems.push({ code: 'fait_sans_source', value: w[0] });
  } else if (!sources.some((x) => !x.ref.startsWith('zone:'))) {
    // Une phrase du texte porte au moins un chiffre ou une donnée de la base ; sinon elle n'affirme rien de sourcé.
    problems.push({ code: 'fait_sans_source', value: 'phrase sans donnée' });
  }

  // Le nom d'un client de la base, de n'importe quelle façon pour un nom de famille, en majuscule pour un prénom.
  for (const w of sentence.matchAll(/[\p{L}]+/gu)) {
    const f = foldWord(w[0]);
    if (f.length < 3) continue;
    if (clients.lastNames.has(f) || (clients.firstNames.has(f) && /^\p{Lu}/u.test(w[0]))) {
      // Le nom d'une zone, d'une donnée ou d'une source qui serait aussi celui d'un client reste permis.
      if (!namedOf(data).some((n) => norm(n.text).split(/[^\p{L}]+/u).includes(f))) problems.push({ code: 'nom_client', value: w[0] });
    }
  }

  return { text: sentence, sources, problems };
}

/** Contrôle tout un texte, titre compris [R155]. */
export function traceNeighbourhood(title: string, body: string, data: NeighbourhoodData, clients: ClientNames = NO_CLIENTS): NeighbourhoodTrace {
  const all = [...sentences(title).map((s) => traceNeighbourhoodSentence(s, data, clients, 'titre')), ...sentences(body).map((s) => traceNeighbourhoodSentence(s, data, clients))];
  return { ok: all.length > 0 && all.every((s) => s.problems.length === 0), sentences: all };
}

/* ---------- Le secours fait par le code ---------- */

const fr = (n: number): string => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));
const UNIT_LABEL: Record<FactUnit, string> = { nombre: '', m: 'm', km: 'km', minutes: 'minutes', habitants: 'habitants', pourcent: '%' };

function factLine(f: NeighbourhoodFact): string {
  if (f.value === null || f.unit === null) return `${f.label}.`;
  const unit = UNIT_LABEL[f.unit];
  return `${f.label} : ${fr(f.value)}${unit ? ` ${unit}` : ''}.`;
}

/** Le texte de secours, fait par le code depuis les seules données : sobre, vrai, et qui passe toujours le contrôle. */
export function fallbackNeighbourhood(kind: TextKind, topic: Topic, data: NeighbourhoodData): { title: string; body: string } {
  const place = data.zone.name;
  const title = topic === 'prix' ? `Les prix à ${place}` : topic === 'equipements' ? `Les services à ${place}` : `Le quartier ${place}, à ${data.zone.communeName}`;
  const paragraphs: string[] = [];
  const own = data.cells.filter((c) => c.zone.level === 'quartier' && c.zone.slug === data.zone.slug);
  if (topic !== 'equipements') {
    const lines = own.map((c) => `Pour les ${CELL_KIND[c.kind]} de ${place}, le prix médian est de ${euros(c.median)} le mètre carré, sur ${c.sales} ventes, entre ${euros(c.q1)} et ${euros(c.q3)} du premier au troisième quartile.`);
    if (lines.length > 0) paragraphs.push(lines.join(' '));
    if (data.listings > 0) paragraphs.push(`${data.listings} ${data.listings > 1 ? 'biens sont' : 'bien est'} en vente avec le réseau à ${data.zone.communeName}.`);
  }
  if (topic !== 'prix' && data.facts.length > 0) paragraphs.push(data.facts.map(factLine).join(' '));
  void kind;
  return { title, body: paragraphs.join('\n\n') };
}

/* ---------- Le service ---------- */

export type NeighbourhoodRefusal =
  | { ok: false; rule: 'R16'; code: 'role' }
  | { ok: false; rule: 'R155'; code: 'texte_refuse'; problems: NeighbourhoodProblem[] }
  | { ok: false; rule: 'R155'; code: 'deja_valide' | 'donnees_changees' | 'sans_donnees' }
  | { ok: false; rule: null; code: 'zone_inconnue' | 'inconnu' | 'invalide' };

export interface NeighbourhoodDraft {
  draftId: string;
  zoneSlug: string;
  kind: TextKind;
  topic: Topic;
  title: string;
  body: string;
  origin: 'ia' | 'secours' | 'redaction';
  trace: NeighbourhoodTrace;
  validatedBy: string | null;
  validatedAt: string | null;
}

/** Un texte relu par la direction : ses paragraphes tels que le site les sert, et s'il est encore validable. */
export interface NeighbourhoodDraftForReview extends NeighbourhoodDraft {
  paragraphs: string[];
  /** Les données du jour sont celles du texte ; sinon la validation serait refusée. */
  current: boolean;
}

/** Les paragraphes d'un texte, découpés d'une seule façon : ce que la direction relit est ce que le site sert [R155]. */
export function bodyParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => p.replace(/\s+/g, ' '));
}

/** Ce que le site sert : un texte validé, recontrôlé sur les données du jour, et ses sources. */
export interface PublishedNeighbourhood {
  draftId: string;
  kind: TextKind;
  topic: Topic;
  title: string;
  body: string;
  zone: NeighbourhoodData['zone'];
  sources: FactSource[];
  validatedAt: string;
}

export interface PagesQuartierOptions {
  now?: () => Date;
  newId?: () => string;
  writer?: NeighbourhoodWriter | undefined;
  timeoutMs?: number;
  /** Les prix publics d'une commune (AT01, `PrixRegroupes.communePrices`). */
  prices: { communePrices(networkId: string, communeSlug: string): Promise<CommunePrices | null> };
  /** Les biens publiés du réseau (AT04, `Referencement.published`). */
  listings: { published(networkId: string): Promise<{ city: string | null }[]> };
}

interface ZoneRow {
  id: string;
  slug: string;
  name: string;
  commune_slug: string;
  commune_name: string;
}

interface DraftRow {
  id: string;
  zone_id: string;
  kind: TextKind;
  topic: Topic;
  title: string;
  body: string;
  origin: NeighbourhoodDraft['origin'];
  data_digest: string;
  validated_by: string | null;
  validated_at: string | null;
  text_sha256: string | null;
}

const KEY = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AI_TIMEOUT_MS = 20_000;
const PARTICLES = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'da', 'di', 'del', 'van', 'von', 'der', 'den', 'el', 'al', 'ben', 'mac', 'saint', 'sainte']);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const textHash = (r: { kind: string; topic: string; title: string; body: string }): Promise<string> => sha256Hex(`${r.kind}\n${r.topic}\n${r.title}\n${r.body}`);
export const dataDigest = (data: NeighbourhoodData): Promise<string> => sha256Hex(JSON.stringify(data));

export class PagesQuartier {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly writer: NeighbourhoodWriter | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly options: PagesQuartierOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.writer = options.writer;
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuseRole(viewer: Viewer, subject: string): Promise<NeighbourhoodRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'page_quartier', code: 'role' } }, this.now);
    return { ok: false, rule: 'R16', code: 'role' };
  }

  /** Un quartier en service, avec sa commune. */
  private async zone(networkId: string, by: { id?: unknown; communeSlug?: unknown; slug?: unknown }): Promise<ZoneRow | null> {
    const base = `SELECT z.id, z.slug, z.label AS name, c.slug AS commune_slug, c.label AS commune_name FROM price_zones z JOIN price_zones c ON c.id = z.parent_id
      WHERE z.network_id = ? AND z.level = 'quartier'
        AND z.id NOT IN (SELECT area_id FROM price_zone_retirements) AND c.id NOT IN (SELECT area_id FROM price_zone_retirements)`;
    if (typeof by.id === 'string') return this.db.first<ZoneRow>(`${base} AND z.id = ?`, [networkId, by.id]);
    if (typeof by.communeSlug === 'string' && typeof by.slug === 'string' && SLUG.test(by.communeSlug) && SLUG.test(by.slug))
      return this.db.first<ZoneRow>(`${base} AND c.slug = ? AND z.slug = ? ORDER BY z.recorded_at DESC LIMIT 1`, [networkId, by.communeSlug, by.slug]);
    return null;
  }

  /** Les données du quartier, telles qu'elles sont aujourd'hui. */
  async data(networkId: string, zone: ZoneRow): Promise<NeighbourhoodData> {
    const prices = await this.options.prices.communePrices(networkId, zone.commune_slug);
    const cells = (prices?.cells ?? [])
      .filter((c) => (c.zone.level === 'quartier' && c.zone.slug === zone.slug) || (c.zone.level === 'commune' && c.zone.slug === zone.commune_slug))
      .sort((a, b) => `${a.zone.level}${a.kind}`.localeCompare(`${b.zone.level}${b.kind}`));
    const city = norm(zone.commune_name);
    const listings = (await this.options.listings.published(networkId)).filter((l) => l.city !== null && norm(l.city) === city).length;
    const rows = await this.db.all<{ fact_key: string; kind: FactKind; label: string; value: number | null; unit: FactUnit | null; source: string; source_date: string; retired: number }>(
      `SELECT f.fact_key, f.kind, f.label, f.value, f.unit, f.source, f.source_date, f.retired FROM neighbourhood_facts f
        WHERE f.network_id = ? AND f.zone_id = ?
          AND f.rowid = (SELECT g.rowid FROM neighbourhood_facts g WHERE g.network_id = f.network_id AND g.zone_id = f.zone_id AND g.fact_key = f.fact_key ORDER BY g.recorded_at DESC, g.rowid DESC LIMIT 1)
        ORDER BY f.fact_key`,
      [networkId, zone.id],
    );
    const facts = rows.filter((r) => r.retired === 0).map((r) => ({ key: r.fact_key, kind: r.kind, label: r.label, value: r.value, unit: r.unit, source: r.source, sourceDate: r.source_date }));
    return { zone: { slug: zone.slug, name: zone.name, communeSlug: zone.commune_slug, communeName: zone.commune_name }, cells, listings, facts };
  }

  /** Les noms des clients du réseau, pour qu'aucun texte ne puisse en écrire un [R46]. */
  private async clients(networkId: string): Promise<ClientNames> {
    const firstNames = new Set<string>();
    const lastNames = new Set<string>();
    for (const p of await this.db.all<{ first_name: string | null; last_name: string | null }>('SELECT DISTINCT first_name, last_name FROM persons WHERE network_id = ?', [networkId])) {
      for (const w of (p.first_name ?? '').split(/[^\p{L}]+/u)) if (w.length >= 3) firstNames.add(foldWord(w));
      for (const w of (p.last_name ?? '').split(/[^\p{L}]+/u)) {
        const f = foldWord(w);
        if (f.length >= 3 && !PARTICLES.has(f)) lastNames.add(f);
      }
    }
    return { firstNames, lastNames };
  }

  /** Une donnée publique du quartier, rangée par la direction avec sa source et sa date. Chaque réglage s'ajoute. */
  async recordFact(
    viewer: Viewer,
    zoneId: unknown,
    input: { key: unknown; kind: unknown; label: unknown; value?: unknown; unit?: unknown; source: unknown; sourceDate: unknown; retired?: unknown },
  ): Promise<{ ok: true } | NeighbourhoodRefusal> {
    if (viewer.role !== 'direction') return this.refuseRole(viewer, `price_zone:${String(zoneId)}`);
    const zone = await this.zone(viewer.networkId, { id: zoneId });
    if (!zone) return { ok: false, rule: null, code: 'zone_inconnue' };
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    // Retirer ne dépend d'aucun contrôle de contenu : un fait devenu refusable reste toujours retirable du public.
    if (input.retired === true) return this.retireFact(viewer, zone, key);
    const label = typeof input.label === 'string' ? input.label.trim().replace(/\s+/g, ' ') : '';
    const source = typeof input.source === 'string' ? input.source.trim().replace(/\s+/g, ' ') : '';
    const date = typeof input.sourceDate === 'string' ? input.sourceDate : '';
    const value = input.value === undefined || input.value === null ? null : input.value;
    const unit = input.unit === undefined || input.unit === null ? null : input.unit;
    const valid =
      KEY.test(key) && key.length <= 60 &&
      (FACT_KINDS as readonly unknown[]).includes(input.kind) &&
      label.length >= 2 && label.length <= 120 && !/[<>]/.test(label) &&
      source.length >= 2 && source.length <= 160 && !/[<>]/.test(source) &&
      DAY.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && date <= this.now().toISOString().slice(0, 10) &&
      ((value === null && unit === null) || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e9 && (FACT_UNITS as readonly unknown[]).includes(unit)));
    if (!valid) return { ok: false, rule: null, code: 'invalide' };
    // Le libellé et la source sont publics : ni adresse, ni critère discriminant, ni mot interdit, ni nombre caché.
    if (publicTextProblems(label).length > 0 || publicTextProblems(source).length > 0) return { ok: false, rule: null, code: 'invalide' };
    const clients = await this.clients(viewer.networkId);
    for (const w of `${label} ${source}`.split(/[^\p{L}]+/u)) {
      const f = foldWord(w);
      if (f.length >= 3 && clients.lastNames.has(f)) return { ok: false, rule: null, code: 'invalide' };
    }
    await this.db.run(
      'INSERT INTO neighbourhood_facts (id, network_id, zone_id, fact_key, kind, label, value, unit, source, source_date, retired, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [this.newId(), viewer.networkId, zone.id, key, input.kind as string, label, value as number | null, unit as string | null, source, date, input.retired === true ? 1 : 0, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'attirer.quartier.donnee', actor: this.actor(viewer), subject: `price_zone:${zone.id}`, data: { rule: 'R155', key, retired: input.retired === true } }, this.now);
    return { ok: true };
  }

  /** Le retrait d'un fait en service : une ligne de plus, avec les valeurs rangées. */
  private async retireFact(viewer: Viewer, zone: ZoneRow, key: string): Promise<{ ok: true } | NeighbourhoodRefusal> {
    const fact = (await this.data(viewer.networkId, zone)).facts.find((f) => f.key === key);
    if (!fact) return { ok: false, rule: null, code: 'inconnu' };
    await this.db.run(
      'INSERT INTO neighbourhood_facts (id, network_id, zone_id, fact_key, kind, label, value, unit, source, source_date, retired, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [this.newId(), viewer.networkId, zone.id, key, fact.kind, fact.label, fact.value, fact.unit, fact.source, fact.sourceDate, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'attirer.quartier.donnee', actor: this.actor(viewer), subject: `price_zone:${zone.id}`, data: { rule: 'R155', key, retired: true } }, this.now);
    return { ok: true };
  }

  private async askWriter(input: { kind: TextKind; topic: Topic; data: NeighbourhoodData }): Promise<{ title: string; body: string } | null> {
    if (!this.writer) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        this.writer.write(structuredClone(input)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.timeoutMs);
        }),
      ]);
      if (!out || typeof out.title !== 'string' || typeof out.body !== 'string') return null;
      return { title: out.title.trim(), body: out.body.trim() };
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseKind(kind: unknown, topic: unknown): { kind: TextKind; topic: Topic } | null {
    if (kind === 'page' && (topic === undefined || topic === 'quartier')) return { kind: 'page', topic: 'quartier' };
    if (kind === 'article' && (topic === 'prix' || topic === 'equipements')) return { kind: 'article', topic };
    return null;
  }

  private async store(viewer: Viewer, zone: ZoneRow, d: { kind: TextKind; topic: Topic; title: string; body: string; origin: NeighbourhoodDraft['origin'] }, data: NeighbourhoodData, trace: NeighbourhoodTrace): Promise<NeighbourhoodDraft> {
    const id = this.newId();
    await this.db.run(
      'INSERT INTO neighbourhood_drafts (id, network_id, zone_id, kind, topic, title, body, origin, data_digest, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, zone.id, d.kind, d.topic, d.title, d.body, d.origin, await dataDigest(data), this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'attirer.quartier.texte', actor: this.actor(viewer), subject: `price_zone:${zone.id}`, data: { rule: 'R155', kind: d.kind, topic: d.topic, origin: d.origin } }, this.now);
    return { draftId: id, zoneSlug: zone.slug, kind: d.kind, topic: d.topic, title: d.title, body: d.body, origin: d.origin, trace, validatedBy: null, validatedAt: null };
  }

  /**
   * Propose un texte : celui de l'IA s'il passe le contrôle, sinon le secours du code, qui le passe toujours. Le texte
   * refusé de l'IA n'est jamais gardé.
   */
  async draft(viewer: Viewer, zoneId: unknown, kind: unknown, topic?: unknown): Promise<{ ok: true; value: NeighbourhoodDraft; aiRefused: boolean } | NeighbourhoodRefusal> {
    if (viewer.role !== 'direction') return this.refuseRole(viewer, `price_zone:${String(zoneId)}`);
    const k = this.parseKind(kind, topic);
    if (!k) return { ok: false, rule: null, code: 'invalide' };
    const zone = await this.zone(viewer.networkId, { id: zoneId });
    if (!zone) return { ok: false, rule: null, code: 'zone_inconnue' };
    const data = await this.data(viewer.networkId, zone);
    const clients = await this.clients(viewer.networkId);
    const proposed = await this.askWriter({ ...k, data });
    let aiRefused = false;
    if (proposed && proposed.title.length >= 2 && proposed.title.length <= 160 && proposed.body.length >= 1 && proposed.body.length <= 6000) {
      const trace = traceNeighbourhood(proposed.title, proposed.body, data, clients);
      if (trace.ok) return { ok: true, value: await this.store(viewer, zone, { ...k, ...proposed, origin: 'ia' }, data, trace), aiRefused };
      aiRefused = true;
    } else if (proposed) aiRefused = true;
    const fb = fallbackNeighbourhood(k.kind, k.topic, data);
    if (fb.body === '') return { ok: false, rule: 'R155', code: 'sans_donnees' };
    const trace = traceNeighbourhood(fb.title, fb.body, data, clients);
    if (!trace.ok) return { ok: false, rule: 'R155', code: 'texte_refuse', problems: trace.sentences.flatMap((s) => s.problems) };
    return { ok: true, value: await this.store(viewer, zone, { ...k, ...fb, origin: 'secours' }, data, trace), aiRefused };
  }

  /** Un texte écrit ou corrigé par la direction : contrôlé de la même façon, refusé s'il ne passe pas [R155]. */
  async write(viewer: Viewer, zoneId: unknown, kind: unknown, topic: unknown, title: unknown, body: unknown): Promise<{ ok: true; value: NeighbourhoodDraft } | NeighbourhoodRefusal> {
    if (viewer.role !== 'direction') return this.refuseRole(viewer, `price_zone:${String(zoneId)}`);
    const k = this.parseKind(kind, topic);
    if (!k || typeof title !== 'string' || typeof body !== 'string') return { ok: false, rule: null, code: 'invalide' };
    const t = title.trim();
    const b = body.trim();
    if (t.length < 2 || t.length > 160 || b.length < 1 || b.length > 6000) return { ok: false, rule: null, code: 'invalide' };
    const zone = await this.zone(viewer.networkId, { id: zoneId });
    if (!zone) return { ok: false, rule: null, code: 'zone_inconnue' };
    const data = await this.data(viewer.networkId, zone);
    const trace = traceNeighbourhood(t, b, data, await this.clients(viewer.networkId));
    if (!trace.ok) return { ok: false, rule: 'R155', code: 'texte_refuse', problems: trace.sentences.flatMap((s) => s.problems) };
    return { ok: true, value: await this.store(viewer, zone, { ...k, title: t, body: b, origin: 'redaction' }, data, trace) };
  }

  private async draftRow(networkId: string, draftId: unknown): Promise<DraftRow | null> {
    if (typeof draftId !== 'string') return null;
    return this.db.first<DraftRow>(
      `SELECT d.id, d.zone_id, d.kind, d.topic, d.title, d.body, d.origin, d.data_digest, v.validated_by, v.validated_at, v.text_sha256
         FROM neighbourhood_drafts d LEFT JOIN neighbourhood_validations v ON v.draft_id = d.id WHERE d.network_id = ? AND d.id = ?`,
      [networkId, draftId],
    );
  }

  /**
   * La validation nommée, par la direction, du texte exact sur les données du moment : si les données ont changé depuis
   * le texte, il faut un nouveau texte [R155].
   */
  async validate(viewer: Viewer, draftId: unknown): Promise<{ ok: true; value: NeighbourhoodDraft } | NeighbourhoodRefusal> {
    if (viewer.role !== 'direction') return this.refuseRole(viewer, `price_zone:texte`);
    const row = await this.draftRow(viewer.networkId, draftId);
    if (!row) return { ok: false, rule: null, code: 'inconnu' };
    if (row.validated_at) return { ok: false, rule: 'R155', code: 'deja_valide' };
    const zone = await this.zone(viewer.networkId, { id: row.zone_id });
    if (!zone) return { ok: false, rule: null, code: 'zone_inconnue' };
    const data = await this.data(viewer.networkId, zone);
    const digest = await dataDigest(data);
    if (digest !== row.data_digest) return { ok: false, rule: 'R155', code: 'donnees_changees' };
    const trace = traceNeighbourhood(row.title, row.body, data, await this.clients(viewer.networkId));
    if (!trace.ok) return { ok: false, rule: 'R155', code: 'texte_refuse', problems: trace.sentences.flatMap((s) => s.problems) };
    const at = this.now().toISOString();
    const changed = await this.db.run('INSERT OR IGNORE INTO neighbourhood_validations (draft_id, text_sha256, data_digest, validated_by, validated_at) VALUES (?, ?, ?, ?, ?)', [row.id, await textHash(row), digest, this.actor(viewer), at]);
    if (changed.changes === 0) return { ok: false, rule: 'R155', code: 'deja_valide' };
    await appendEvent(this.journal, { type: 'attirer.quartier.valide', actor: this.actor(viewer), subject: `price_zone:${row.zone_id}`, data: { rule: 'R155', kind: row.kind, topic: row.topic } }, this.now);
    return { ok: true, value: { draftId: row.id, zoneSlug: zone.slug, kind: row.kind, topic: row.topic, title: row.title, body: row.body, origin: row.origin, trace, validatedBy: this.actor(viewer), validatedAt: at } };
  }

  /** Les quartiers en service du réseau, pour la direction, rangés par commune puis par nom. */
  async zones(viewer: Viewer): Promise<{ ok: true; value: { zoneId: string; name: string; communeName: string }[] } | NeighbourhoodRefusal> {
    if (viewer.role !== 'direction') return this.refuseRole(viewer, 'price_zone:liste');
    const rows = await this.db.all<{ id: string; name: string; commune_name: string }>(
      `SELECT z.id, z.label AS name, c.label AS commune_name FROM price_zones z JOIN price_zones c ON c.id = z.parent_id
        WHERE z.network_id = ? AND z.level = 'quartier'
          AND z.id NOT IN (SELECT area_id FROM price_zone_retirements) AND c.id NOT IN (SELECT area_id FROM price_zone_retirements)`,
      [viewer.networkId],
    );
    const out = rows.map((r) => ({ zoneId: r.id, name: r.name, communeName: r.commune_name }));
    out.sort((a, b) => a.communeName.localeCompare(b.communeName, 'fr') || a.name.localeCompare(b.name, 'fr'));
    return { ok: true, value: out };
  }

  /** Les données rangées d'un quartier, pour la direction : celles qui ne sont pas retirées. */
  async facts(viewer: Viewer, zoneId: unknown): Promise<{ ok: true; value: NeighbourhoodFact[] } | NeighbourhoodRefusal> {
    if (viewer.role !== 'direction') return this.refuseRole(viewer, `price_zone:${String(zoneId)}`);
    const zone = await this.zone(viewer.networkId, { id: zoneId });
    if (!zone) return { ok: false, rule: null, code: 'zone_inconnue' };
    return { ok: true, value: (await this.data(viewer.networkId, zone)).facts };
  }

  /** Les textes d'un quartier, pour la direction : chacun avec son contrôle sur les données du jour. */
  async drafts(viewer: Viewer, zoneId: unknown): Promise<{ ok: true; value: NeighbourhoodDraftForReview[] } | NeighbourhoodRefusal> {
    if (viewer.role !== 'direction') return this.refuseRole(viewer, `price_zone:${String(zoneId)}`);
    const zone = await this.zone(viewer.networkId, { id: zoneId });
    if (!zone) return { ok: false, rule: null, code: 'zone_inconnue' };
    const data = await this.data(viewer.networkId, zone);
    const clients = await this.clients(viewer.networkId);
    const digest = await dataDigest(data);
    const rows = await this.db.all<DraftRow>(
      `SELECT d.id, d.zone_id, d.kind, d.topic, d.title, d.body, d.origin, d.data_digest, v.validated_by, v.validated_at, v.text_sha256
         FROM neighbourhood_drafts d LEFT JOIN neighbourhood_validations v ON v.draft_id = d.id WHERE d.network_id = ? AND d.zone_id = ? ORDER BY d.created_at DESC, d.rowid DESC`,
      [viewer.networkId, zone.id],
    );
    return {
      ok: true,
      value: rows.map((r) => ({ draftId: r.id, zoneSlug: zone.slug, kind: r.kind, topic: r.topic, title: r.title, body: r.body, origin: r.origin, trace: traceNeighbourhood(r.title, r.body, data, clients), validatedBy: r.validated_by, validatedAt: r.validated_at, paragraphs: bodyParagraphs(r.body), current: r.data_digest === digest })),
    };
  }

  /**
   * Le texte servi au public : le dernier validé de ce quartier et de ce sujet, seulement s'il passe encore le contrôle
   * sur les données du jour et que son texte est celui qui a été validé. Sinon rien n'est servi [R155].
   */
  async published(networkId: string, communeSlug: unknown, quarterSlug: unknown, topic: unknown = 'quartier'): Promise<PublishedNeighbourhood | null> {
    if (topic !== 'quartier' && topic !== 'prix' && topic !== 'equipements') return null;
    const zone = await this.zone(networkId, { communeSlug, slug: quarterSlug });
    if (!zone) return null;
    const row = await this.db.first<DraftRow>(
      `SELECT d.id, d.zone_id, d.kind, d.topic, d.title, d.body, d.origin, d.data_digest, v.validated_by, v.validated_at, v.text_sha256
         FROM neighbourhood_drafts d JOIN neighbourhood_validations v ON v.draft_id = d.id
        WHERE d.network_id = ? AND d.zone_id = ? AND d.topic = ? ORDER BY v.validated_at DESC, v.rowid DESC LIMIT 1`,
      [networkId, zone.id, topic],
    );
    if (!row || !row.validated_at || row.text_sha256 !== (await textHash(row))) return null;
    const data = await this.data(networkId, zone);
    const trace = traceNeighbourhood(row.title, row.body, data, await this.clients(networkId));
    if (!trace.ok) return null;
    const sources: FactSource[] = [];
    for (const s of trace.sentences.flatMap((x) => x.sources)) if (!sources.some((y) => y.source === s.source && y.date === s.date)) sources.push(s);
    return { draftId: row.id, kind: row.kind, topic: row.topic, title: row.title, body: row.body, zone: data.zone, sources, validatedAt: row.validated_at };
  }
}

/* ---------- La page publique ---------- */

export interface NeighbourhoodPageOptions {
  siteUrl: string;
  estimateHref: string;
}

const SITE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;
const SAFE_HREF = /^(?:\/[^\s"'<>]*|https:\/\/[^\s"'<>]+)$/;

const CSS =
  DESIGN_CSS +
  '.tete{display:flex;justify-content:space-between;align-items:center;gap:var(--e-4);padding:var(--e-4)}' +
  'main{max-width:42rem;margin:0 auto;padding:0 var(--e-4) var(--e-8)}' +
  '.intro{margin:var(--e-6) 0 var(--e-5)}.intro h1{font-size:clamp(2rem,8vw,2.8rem);line-height:1.05;letter-spacing:-.02em}' +
  '.fil{margin:0 0 var(--e-2);font-size:var(--t-s)}' +
  '.metier{margin:0 0 var(--e-2);font-weight:700;color:var(--accent);letter-spacing:.08em;text-transform:uppercase;font-size:var(--t-xs)}' +
  '.texte p{margin:0 0 var(--e-4);font-size:var(--t-m);line-height:1.6}' +
  '.sources{margin:var(--e-6) 0 0;padding:var(--e-4);border-radius:var(--r-m);box-shadow:inset 4px 0 0 var(--moutarde);background:var(--surface)}' +
  '.sources ul{margin:0;padding-left:var(--e-5)}.sources li{margin:0 0 var(--e-2);font-size:var(--t-s)}' +
  '.suite{margin:var(--e-6) 0 0;display:flex;flex-wrap:wrap;gap:var(--e-3);align-items:center}';

/** La page publique d'un quartier, ou d'un article sur ce quartier, depuis un texte validé et recontrôlé. */
export function renderNeighbourhoodPage(page: PublishedNeighbourhood, options: NeighbourhoodPageOptions): { ok: true; html: string } | { ok: false; code: 'adresse_invalide' | 'zone_inconnue' } {
  if (!SITE.test(options.siteUrl) || !SAFE_HREF.test(options.estimateHref)) return { ok: false, code: 'adresse_invalide' };
  if (!SLUG.test(page.zone.slug) || !SLUG.test(page.zone.communeSlug)) return { ok: false, code: 'zone_inconnue' };
  const base = `/quartiers/${page.zone.communeSlug}/${page.zone.slug}`;
  const path = page.topic === 'quartier' ? base : `${base}/${page.topic}`;
  const url = `${options.siteUrl}${path}`;
  const paragraphs = bodyParagraphs(page.body)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('');
  const sources = page.sources
    .map((s) => `<li>${escapeHtml(s.source)}${s.date ? `, au ${escapeHtml(frenchDate(s.date))}` : ''}</li>`)
    .join('');
  const crumbs = page.topic === 'quartier' ? '' : `<p class="fil"><a href="${base}">${escapeHtml(page.zone.name)}</a></p>`;
  const data = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: page.title,
    url,
    inLanguage: 'fr',
    dateModified: page.validatedAt.slice(0, 10),
    about: { '@type': 'Place', name: `${page.zone.name}, ${page.zone.communeName}` },
    publisher: { '@type': 'Organization', name: 'AIMMO' },
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const html =
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}">` +
    `<title>${escapeHtml(page.title)}</title><meta name="description" content="${escapeHtml(`${page.zone.name}, ${page.zone.communeName} : prix, services et données du quartier, chacun avec sa source.`)}"><style>${CSS}</style>` +
    `<script type="application/ld+json">${data}</script></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p></header><div class="frise" aria-hidden="true"></div><main>` +
    `<section class="intro" aria-labelledby="titre">${crumbs}<p class="metier">${escapeHtml(page.zone.communeName)} · votre agent immobilier</p><h1 id="titre">${escapeHtml(page.title)}</h1></section>` +
    `<article class="texte">${paragraphs}</article>` +
    `<section class="sources" aria-labelledby="t-sources"><h2 id="t-sources">Sources</h2><p>Chaque chiffre et chaque fait de cette page vient de ces données, relues avant publication.</p><ul>${sources}</ul></section>` +
    `<section class="suite" aria-labelledby="t-suite"><h2 id="t-suite" class="visuellement-cache">Aller plus loin</h2><a href="/prix/${page.zone.communeSlug}/${page.zone.slug}">Les prix à ${escapeHtml(page.zone.name)}</a>` +
    `<a class="appel" href="${escapeHtml(options.estimateHref)}">Estimer mon logement</a></section>` +
    `</main></body></html>`;
  return { ok: true, html };
}
