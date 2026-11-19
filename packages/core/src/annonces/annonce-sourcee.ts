/**
 * Annonce sourcée (M07, P03) : le contrôle par le code du texte d'une annonce, phrase par phrase [R46, R47].
 *
 * « Jamais vu » : chaque nombre et chaque fait du texte est relié au champ de la fiche dont il vient. Un nombre, une
 * surface, une année, une classe ou un équipement sans source rend la phrase refusée, avant même la validation de
 * l'agent. Le texte ne peut donc rien inventer, et l'agent voit d'où vient chaque affirmation.
 *
 * Décidé, lecture prudente :
 * - le prix n'est jamais écrit dans le texte : seules les mentions du code le portent (P02) ; un nombre égal au prix
 *   n'a pas de source dans le texte ;
 * - les nombres écrits en lettres (« trois pièces ») sont lus comme des nombres ;
 * - un équipement de la liste fermée sans champ dans la fiche (piscine, cave, cheminée, travaux…) n'a jamais de source ;
 * - toute voie nommée (« rue », « avenue »…) est refusée, avec ou sans numéro : jamais d'adresse en public [R46] ;
 * - la liste des critères discriminants est fermée et volontairement large, mieux vaut un refus de trop [R46] ;
 * - « gratuit », « mandataire » et toute mention de l'IA sont refusés (AGENTS.md).
 */
import type { PropertyKind } from '../db/types.ts';
import type { Amenity, Condition, EnergyClass, HeatingKind, OutdoorKind } from './fiche-bien.ts';

/** Ce que l'IA reçoit du bien : ni nom, ni coordonnée, ni adresse, ni texte libre [R15, R46]. */
export interface ListingFacts {
  kind: PropertyKind;
  city: string | null;
  postalCode: string | null;
  surfaceM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  floor: number | null;
  floorsTotal: number | null;
  buildYear: number | null;
  heating: HeatingKind | null;
  outdoor: OutdoorKind[];
  landM2: number | null;
  parkingSpaces: number | null;
  elevator: boolean | null;
  energyClass: EnergyClass | null;
  climateClass: EnergyClass | null;
  /** AU061 · équipements et état dits sur la fiche ; absents, ils ne sont jamais une source. */
  amenities?: Amenity[];
  condition?: Condition | null;
}

export const FACT_KEYS: readonly (keyof ListingFacts)[] = [
  'kind', 'city', 'postalCode', 'surfaceM2', 'rooms', 'bedrooms', 'floor', 'floorsTotal', 'buildYear', 'heating', 'outdoor', 'landM2', 'parkingSpaces', 'elevator', 'energyClass', 'climateClass', 'amenities', 'condition',
];

export type SentenceProblem =
  | { code: 'nombre_sans_source'; value: string }
  | { code: 'fait_sans_source'; value: string }
  | { code: 'adresse'; value: string }
  | { code: 'critere_discriminant'; value: string }
  | { code: 'mot_interdit'; value: string };

export interface SourcedSentence {
  text: string;
  /** Les champs de la fiche d'où vient chaque nombre ou fait de la phrase. */
  sources: { field: keyof ListingFacts; value: string }[];
  problems: SentenceProblem[];
}

export interface TraceResult {
  ok: boolean;
  sentences: SourcedSentence[];
}

const SPELLED: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13,
  quatorze: 14, quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, septante: 70, octante: 80, nonante: 90, cent: 100, cents: 100, mille: 1000, million: 1_000_000, millions: 1_000_000,
  premier: 1, première: 1, deuxième: 2, second: 2, seconde: 2, troisième: 3, quatrième: 4, cinquième: 5, sixième: 6, septième: 7, huitième: 8, neuvième: 9, dixième: 10,
};
// « un », « une » et « neuf » sont surtout des mots ordinaires : ils ne comptent comme nombres que devant une unité.
const SPELLED_NEEDS_UNIT = new Set(['un', 'une', 'neuf']);
const UNIT_AFTER = /^\s*(pieces?|chambres?|etages?|niveaux?|places?|m²|m2|metres?|ans?|salles?|lots?)(?![\p{L}\p{N}])/iu;

/**
 * Le champ que l'unité qui suit un nombre lui impose : « 3 chambres » doit être le nombre de chambres, pas celui des
 * pièces. Lu sur le texte sans accents. Une unité reconnue sans champ (« ans », « lots », « salles ») n'a pas de source.
 */
const UNITS: { re: RegExp; fields: (keyof ListingFacts)[] }[] = [
  { re: /^\s*(?:e|er|ere|eme|ieme)?\s*(?:etages?|niveaux?)(?![\p{L}])/u, fields: ['floor', 'floorsTotal'] },
  { re: /^\s*(?:e|er|ere|eme|ieme)(?![\p{L}])/u, fields: ['floor'] },
  { re: /^\s*pieces?(?![\p{L}])/u, fields: ['rooms'] },
  { re: /^\s*chambres?(?![\p{L}])/u, fields: ['bedrooms'] },
  { re: /^\s*(?:m²|m2|metres? carres?|metres?)(?![\p{L}\p{N}])/u, fields: ['surfaceM2', 'landM2'] },
  { re: /^\s*(?:places?|parkings?|garages?|box|stationnements?)(?![\p{L}])/u, fields: ['parkingSpaces'] },
  { re: /^\s*(?:ans?|annees?|salles?|lots?|km|minutes?|min|%|€|euros?)(?![\p{L}])/u, fields: [] },
];
/** Sans unité, un nombre ne peut être que l'année de construction, le code postal, ou le total d'étages après « sur ». */
const NO_UNIT_FIELDS: (keyof ListingFacts)[] = ['buildYear', 'postalCode'];

const NUMBER = /\d{1,3}(?:[   ]\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;

const VOIE = /(?<![\p{L}\p{N}])(rue|r\.|ruelle|avenue|av\.?|boulevard|bd\.?|bvd\.?|pl\.|place|chemin|ch\.|chem\.?|impasse|imp\.|allée|all\.|route|rte\.?|quai|cours|crs\.?|square|sq\.?|passage|pass\.|faubourg|fg\.?|fbg\.?|rond-point|lieu-dit|lotissement|lot\.|résidence|rés\.)\s+(\S+)(?:\s+(\S+))?/giu;
const VOIE_LINK = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'saint', 'sainte', 'st', 'ste']);

/** Une voie nommée : le mot de la voie suivi d'un article, d'un nom propre ou d'un nombre. */
function findStreet(sentence: string): string | null {
  for (const m of sentence.matchAll(VOIE)) {
    const voie = m[1]!.toLowerCase();
    const next = m[2]!.replace(/[,.;:!?]+$/u, '');
    const after = (m[3] ?? '').toLowerCase();
    // « place de stationnement », « places de parking » : pas une adresse.
    if (voie === 'place' && (next.toLowerCase() === 'de' || next.toLowerCase() === "d'") && /^(stationnement|parking)/u.test(after)) continue;
    const lower = next.toLowerCase();
    const named = VOIE_LINK.has(lower) || /^[dl]['’]/u.test(lower) || /^[\p{Lu}\p{N}]/u.test(next);
    if (named) return m[0];
  }
  return null;
}
const STREET_NUMBER = /\b\d{1,4}\s*(?:bis|ter)?\s*,?\s+(rue|r\.|avenue|av\.?|boulevard|bd\.?|chemin|ch\.|impasse|imp\.|allée|route|rte\.?|quai|cours)(?![\p{L}])/iu;

/** Critères discriminants dans l'accès au logement : liste fermée, volontairement large [R46]. */
export const DISCRIMINATORY_TERMS: readonly string[] = [
  'origine', 'ethnie', 'ethnique', 'race', 'racial', 'religion', 'religieux', 'religieuse', 'chrétien', 'chrétienne', 'musulman', 'musulmane', 'juif', 'juive',
  'catholique', 'protestant', 'nationalité', 'étranger', 'étrangère', 'étrangers', 'français uniquement', 'française uniquement', 'handicap', 'handicapé', 'handicapée',
  'sans enfant', 'sans enfants', "pas d'enfant", "pas d'enfants", 'couple', 'couples', 'célibataire', 'célibataires', 'retraité', 'retraités', 'retraitée', 'famille', 'familles',
  'familial', 'familiale', 'jeune couple', 'jeunes', 'senior', 'seniors', 'âgé', 'âgée', 'âge', 'homme', 'hommes', 'femme', 'femmes', 'sexe', 'orientation', 'mœurs', 'moeurs',
  'grossesse', 'enceinte', 'opinion', 'opinions', 'syndicat', 'syndical', 'patronyme', 'apparence', 'réservé à', 'réservée à', 'réservés à', 'réservées à', 'réservé aux', 'réservée aux', 'réservés aux', 'réservées aux',
  'exclusivement pour', 'exclusivement aux', 'exclusivement à', 'uniquement pour', 'idéal pour', 'français', 'française', 'européen', 'européenne', 'africain', 'africaine', 'maghrébin', 'asiatique',
];

/** Mots jamais permis dans un texte destiné au public (AGENTS.md). */
export const FORBIDDEN_TERMS: readonly string[] = [
  'gratuit', 'gratuite', 'gratuits', 'gratuites', 'gratuitement', 'mandataire', 'mandataires', 'ia', 'intelligence artificielle', 'chatgpt', 'gpt', 'robot', 'algorithme', 'généré', 'générée', 'automatiquement',
];

/** Équipements et états reconnus : avec le test qui dit si la fiche les porte. Un terme sans champ n'a jamais de source. */
const FEATURES: { terms: string[]; field: keyof ListingFacts | null; has: (f: ListingFacts) => boolean }[] = [
  { terms: ['balcon', 'balcons'], field: 'outdoor', has: (f) => f.outdoor.includes('balcon') },
  { terms: ['terrasse', 'terrasses'], field: 'outdoor', has: (f) => f.outdoor.includes('terrasse') },
  { terms: ['jardin', 'jardins', 'jardinet'], field: 'outdoor', has: (f) => f.outdoor.includes('jardin') },
  { terms: ['cour', 'courette'], field: 'outdoor', has: (f) => f.outdoor.includes('cour') },
  { terms: ['ascenseur'], field: 'elevator', has: (f) => f.elevator === true },
  { terms: ['sans ascenseur'], field: 'elevator', has: (f) => f.elevator === false },
  { terms: ['parking', 'parkings', 'stationnement', 'garage', 'garages', 'box'], field: 'parkingSpaces', has: (f) => (f.parkingSpaces ?? 0) > 0 },
  { terms: ['rez-de-chaussée', 'rez de chaussée'], field: 'floor', has: (f) => f.floor === 0 },
  { terms: ['dernier étage'], field: 'floorsTotal', has: (f) => f.floor !== null && f.floor === f.floorsTotal },
  { terms: ['chauffage collectif'], field: 'heating', has: (f) => f.heating === 'collectif' },
  { terms: ['chauffage au gaz', 'chauffage gaz', 'chaudière gaz', 'chaudière au gaz'], field: 'heating', has: (f) => f.heating === 'individuel_gaz' },
  { terms: ['chauffage électrique', 'radiateurs électriques'], field: 'heating', has: (f) => f.heating === 'individuel_electrique' },
  { terms: ['pompe à chaleur'], field: 'heating', has: (f) => f.heating === 'pompe_a_chaleur' },
  { terms: ['fioul', 'fuel'], field: 'heating', has: (f) => f.heating === 'fioul' },
  { terms: ['poêle', 'chauffage au bois', 'chaudière bois'], field: 'heating', has: (f) => f.heating === 'bois' },
  { terms: ['terrain'], field: 'landM2', has: (f) => f.kind === 'land' || f.landM2 !== null },
  // AU061 · équipements et état dits sur la fiche : nommés seulement s'ils y sont.
  { terms: ['piscine'], field: 'amenities', has: (f) => (f.amenities ?? []).includes('piscine') },
  { terms: ['cave', 'caves'], field: 'amenities', has: (f) => (f.amenities ?? []).includes('cave') },
  { terms: ['cheminée'], field: 'amenities', has: (f) => (f.amenities ?? []).includes('cheminee') },
  { terms: ['grenier', 'combles'], field: 'amenities', has: (f) => (f.amenities ?? []).includes('grenier') },
  { terms: ['véranda'], field: 'amenities', has: (f) => (f.amenities ?? []).includes('veranda') },
  { terms: ['climatisation', 'climatisé', 'climatisée'], field: 'amenities', has: (f) => (f.amenities ?? []).includes('climatisation') },
  // Un état nié (« non rénové », « jamais refait », « pas en bon état ») ne se prouve pas par la fiche : jamais de source,
  // et il se lit avant le terme positif (AU061).
  {
    terms: ['non', 'pas', 'ni', 'jamais', 'pas encore', 'pas été', 'jamais été', 'pas vraiment'].flatMap((n) =>
      ['rénové', 'rénovée', 'rénovés', 'rénovées', 'refait', 'refaite', 'refaits', 'refaites', 'refait à neuf', 'neuf', 'neuve', 'en bon état'].map((t) => `${n} ${t}`),
    ),
    field: null,
    has: () => false,
  },
  // « Sans travaux » se lit avant « travaux » : vrai seulement pour un bien dit neuf, refait ou en bon état.
  { terms: ['sans travaux', 'aucun travaux', 'aucuns travaux', 'pas de travaux', 'aucun travail', 'sans travaux à prévoir', 'aucun travaux à prévoir', 'aucuns travaux à prévoir', 'pas de travaux à prévoir', 'rien à prévoir'], field: 'condition', has: (f) => f.condition === 'neuf' || f.condition === 'refait_a_neuf' || f.condition === 'bon_etat' },
  { terms: ['travaux à prévoir', 'des travaux', 'travaux'], field: 'condition', has: (f) => f.condition === 'travaux_a_prevoir' || f.condition === 'a_renover' },
  { terms: ['à rénover'], field: 'condition', has: (f) => f.condition === 'a_renover' },
  { terms: ['refait à neuf', 'rénové', 'rénovée', 'refait', 'refaite', 'refaits'], field: 'condition', has: (f) => f.condition === 'refait_a_neuf' },
  { terms: ['bon état'], field: 'condition', has: (f) => f.condition === 'bon_etat' || f.condition === 'refait_a_neuf' || f.condition === 'neuf' },
  { terms: ['neuf'], field: 'condition', has: (f) => f.condition === 'neuf' },
  // L'absence d'un équipement ne se prouve pas par la fiche (une case vide veut dire « je ne sais pas ») : « sans piscine »
  // n'a jamais de source, et se lit avant « piscine » (AU061).
  {
    terms: ['piscine', 'cave', 'cheminée', 'grenier', 'combles', 'véranda', 'climatisation'].flatMap((t) => [`sans ${t}`, `pas de ${t}`, `aucune ${t}`, `ni ${t}`]),
    field: null,
    has: () => false,
  },
  // Sans champ dans la fiche : jamais de source.
  {
    terms: ['cellier', 'fibre', 'double vitrage', 'parquet', 'dressing', 'buanderie',
      'vue', 'sans vis-à-vis', 'traversant', 'traversante', 'plein sud', 'exposé', 'exposée', 'interphone',
      'digicode', 'gardien', 'gardienne', 'loggia', 'mezzanine', 'sous-sol', 'dépendance', 'dépendances', 'puits', 'portail', 'motorisé', 'alarme', 'domotique', 'tramway', 'gare',
      'écoles', 'école', 'commerces', 'métro'],
    field: null,
    has: () => false,
  },
];

/**
 * Texte comparable : minuscules, sans accents, apostrophes droites, espaces réunies, et sigles à points lus d'un
 * bloc (« I.A. » → « ia »). Les termes cherchés passent par la même fonction.
 */
const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/(?<![\p{L}])((?:\p{L}\.){2,})/gu, (m) => m.replace(/\./g, ''))
    .replace(/\s+/g, ' ');
const SPELLED_NORM = new Map(Object.entries(SPELLED).map(([k, v]) => [norm(k), v] as const));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Un terme, entier, entre deux limites de mot (lettres accentuées comprises). */
const termRe = (t: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, 'iu');
/** Un terme au singulier ou au pluriel, au masculin ou au féminin : « musulman » lit aussi « musulmanes ». */
const termFormsRe = (t: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?:e|s|es|x)?(?![\\p{L}\\p{N}])`, 'iu');

/** Les nombres de la fiche, chacun avec son champ. */
function numericSources(f: ListingFacts): { field: keyof ListingFacts; value: number }[] {
  const out: { field: keyof ListingFacts; value: number }[] = [];
  const push = (field: keyof ListingFacts, v: number | null) => {
    if (v !== null) out.push({ field, value: v });
  };
  push('surfaceM2', f.surfaceM2);
  push('rooms', f.rooms);
  push('bedrooms', f.bedrooms);
  push('floor', f.floor);
  push('floorsTotal', f.floorsTotal);
  push('buildYear', f.buildYear);
  push('landM2', f.landM2);
  push('parkingSpaces', f.parkingSpaces);
  if (f.postalCode !== null && /^\d{5}$/.test(f.postalCode)) push('postalCode', Number(f.postalCode));
  return out;
}

const parseNumber = (raw: string): number => Number(raw.replace(/[   ]/g, '').replace(',', '.'));

/** Découpe en phrases : après un point, un point d'exclamation ou d'interrogation, ou un retour à la ligne. */
/** Abréviations après lesquelles un point ne finit pas la phrase : « av. des Essais » reste d'un bloc. */
const ABBREVIATIONS = /(?:^|[\s(])(?:av|bd|boul|r|pl|imp|ch|chem|all|fg|faub|rte|st|ste|sq|n°|no|num|bis|ter|m|mme|mlle|dr|env|cf|etc|réf|ref|ex|p|[\p{L}])\.$/iu;

export function sentences(text: string): string[] {
  const pieces = text
    // Un simple retour à la ligne ne coupe pas une phrase : « sans\nenfants » reste lu d'un bloc.
    .split(/(?<=[.!?])\s+|\n\s*\n/u)
    .map((s) => s.replace(/\s+/g, ' '))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: string[] = [];
  for (const piece of pieces) {
    const prev = out[out.length - 1];
    if (prev !== undefined && ABBREVIATIONS.test(prev)) out[out.length - 1] = `${prev} ${piece}`;
    else out.push(piece);
  }
  return out;
}

/** Contrôle une phrase : ses sources et ses problèmes. */
/**
 * Ce qu'aucun texte public ne peut porter, phrase ou sous-titre : une adresse ou une voie nommée, un critère
 * discriminant [R46], un mot interdit. Sans contrôle des nombres : sert aussi aux textes des vidéos (P06).
 */
export function publicTextProblems(sentence: string): SentenceProblem[] {
  const problems: SentenceProblem[] = [];
  const lower = norm(sentence);
  const street = STREET_NUMBER.exec(sentence)?.[0] ?? findStreet(sentence);
  if (street) problems.push({ code: 'adresse', value: street });
  // Chaque passage refusé est nommé une fois, tel qu'il est lu (sans accents), même si plusieurs termes le trouvent.
  const flagged = (terms: readonly string[], code: 'critere_discriminant' | 'mot_interdit') => {
    const found: { at: number; text: string }[] = [];
    for (const term of terms) {
      for (const m of lower.matchAll(new RegExp(termFormsRe(norm(term)).source, 'giu'))) {
        const at = m.index ?? 0;
        if (!found.some((f) => at < f.at + f.text.length && f.at < at + m[0].length)) found.push({ at, text: m[0] });
      }
    }
    for (const f of found.sort((x, y) => x.at - y.at)) problems.push({ code, value: f.text });
  };
  flagged(DISCRIMINATORY_TERMS, 'critere_discriminant');
  flagged(FORBIDDEN_TERMS, 'mot_interdit');
  return problems;
}

export function traceSentence(sentence: string, facts: ListingFacts): SourcedSentence {
  const sources: SourcedSentence['sources'] = [];
  const problems: SentenceProblem[] = [];
  const lower = norm(sentence);
  const numbers = numericSources(facts);
  const addSource = (field: keyof ListingFacts, value: string) => {
    if (!sources.some((s) => s.field === field && s.value === value)) sources.push({ field, value });
  };

  problems.push(...publicTextProblems(sentence));

  // Nombres [R47] : chacun doit être la valeur d'un champ de la fiche, et du champ que son unité désigne.
  const check = (value: number, raw: string, after: string, before: string) => {
    const unit = UNITS.find((u) => u.re.test(after));
    let fields: (keyof ListingFacts)[];
    if (unit) fields = unit.fields;
    else if (/(?<![\p{L}])sur\s*$/u.test(before)) fields = ['floorsTotal'];
    else fields = NO_UNIT_FIELDS;
    const src = numbers.find((n) => fields.includes(n.field) && n.value === value);
    if (src) addSource(src.field, raw);
    else problems.push({ code: 'nombre_sans_source', value: raw });
  };
  // Chiffres non latins et chiffres romains : jamais de source.
  for (const m of sentence.matchAll(/[^\P{Nd}0-9]+/gu)) problems.push({ code: 'nombre_sans_source', value: m[0] });
  for (const m of sentence.matchAll(/(?<![\p{L}])[IVXLCDM]+(?:e|er|ème|eme)?(?=\s+(?:siècle|siecle|étage|etage|arrondissement))/gu)) problems.push({ code: 'nombre_sans_source', value: m[0] });
  for (const m of lower.matchAll(NUMBER)) {
    const raw = m[0];
    const at = m.index ?? 0;
    check(parseNumber(raw), raw.replace(/[\u00a0\u202f]/g, ' '), lower.slice(at + raw.length), lower.slice(0, at));
  }
  // Nombres en lettres ; un nombre composé (« quatre-vingts », « deux cents ») n'est jamais lu comme une source.
  for (const m of lower.matchAll(/[\p{L}]+(?:-[\p{L}]+)*/gu)) {
    const parts = m[0].split('-');
    const at = m.index ?? 0;
    const values = parts.map((p) => SPELLED_NORM.get(p));
    if (values.every((v) => v === undefined)) continue;
    const after = lower.slice(at + m[0].length);
    const nextWord = /^\s+([\p{L}]+)/u.exec(after)?.[1];
    const compound = parts.length > 1 || (nextWord !== undefined && SPELLED_NORM.has(nextWord) && !['un', 'une', 'neuf'].includes(nextWord));
    const prev = /([\p{L}]+)\s+$/u.exec(lower.slice(0, at))?.[1];
    const partOfPrevious = prev !== undefined && SPELLED_NORM.has(prev) && !['un', 'une', 'neuf'].includes(prev) && parts.length === 1;
    if (partOfPrevious) continue; // déjà compté avec le mot d'avant
    if (compound) {
      problems.push({ code: 'nombre_sans_source', value: nextWord && parts.length === 1 ? `${m[0]} ${nextWord}` : m[0] });
      continue;
    }
    const word = parts[0]!;
    if (SPELLED_NEEDS_UNIT.has(word) && !UNIT_AFTER.test(after)) continue;
    check(values[0]!, word, after, lower.slice(0, at));
  }

  // Classes du diagnostic, sous toutes leurs formes : « classe énergie : B », « DPE B », « étiquette GES C ».
  for (const m of lower.matchAll(/(?<![\p{L}])(?:classe|classee?|dpe|etiquette|ges)(?:\s*[:\-–]\s*|\s+)(?:(?:energie|energetique|climat|ges|dpe)(?:\s*[:\-–]\s*|\s+))?([a-g])(?![\p{L}'])/gu)) {
    const letter = m[1]!.toUpperCase();
    if (letter === facts.energyClass) addSource('energyClass', letter);
    else if (letter === facts.climateClass) addSource('climateClass', letter);
    else problems.push({ code: 'fait_sans_source', value: m[0] });
  }

  // Équipements : le plus long terme d'abord, pour que « sans ascenseur » ne soit pas lu « ascenseur ».
  const all = FEATURES.flatMap((f) => f.terms.map((t) => ({ term: t, feature: f }))).sort((a, b) => b.term.length - a.term.length);
  let rest = lower;
  for (const { term, feature } of all) {
    const re = new RegExp(termRe(norm(term)).source, 'giu');
    if (!re.test(rest)) continue;
    rest = rest.replace(re, ' ');
    if (feature.field !== null && feature.has(facts)) addSource(feature.field, term);
    else problems.push({ code: 'fait_sans_source', value: term });
  }

  // La ville : seule celle du bien peut être nommée ; une autre ville n'est pas contrôlable ici, elle n'est pas cherchée.
  if (facts.city && termRe(norm(facts.city)).test(lower)) addSource('city', facts.city);

  return { text: sentence, sources, problems };
}

/** Contrôle tout un texte, titre compris : chaque phrase avec ses sources et ses problèmes. */
export function traceListing(title: string, body: string, facts: ListingFacts): TraceResult {
  const all = [...sentences(title), ...sentences(body)].map((s) => traceSentence(s, facts));
  return { ok: all.length > 0 && all.every((s) => s.problems.length === 0), sentences: all };
}

const KIND_LABEL: Record<PropertyKind, string> = {
  home: 'Logement',
  building: 'Immeuble',
  land: 'Terrain',
  commercial: 'Local',
  business_walls: 'Murs',
  business: 'Fonds',
};

const fr = (n: number): string => String(n).replace('.', ',');
const ordinal = (n: number): string => (n === 1 ? '1er' : `${n}e`);
const HEATING_LABEL: Record<HeatingKind, string | null> = {
  individuel_gaz: 'Chauffage au gaz',
  individuel_electrique: 'Chauffage électrique',
  collectif: 'Chauffage collectif',
  pompe_a_chaleur: 'Pompe à chaleur',
  bois: 'Chauffage au bois',
  fioul: 'Chauffage au fioul',
  autre: null,
};
const OUTDOOR_LABEL: Record<OutdoorKind, string> = { balcon: 'balcon', terrasse: 'terrasse', jardin: 'jardin', cour: 'cour' };
const AMENITY_LABEL: Record<Amenity, string> = { piscine: 'piscine', cave: 'cave', cheminee: 'cheminée', grenier: 'grenier', veranda: 'véranda', climatisation: 'climatisation' };
const CONDITION_LABEL: Record<Condition, string> = { neuf: 'Logement neuf.', refait_a_neuf: 'Refait à neuf.', bon_etat: 'En bon état.', travaux_a_prevoir: 'Travaux à prévoir.', a_renover: 'À rénover.' };

/** Le texte de secours, fait par le code depuis la fiche seule : sobre, vrai, et qui passe toujours le contrôle. */
export function fallbackListing(f: ListingFacts): { title: string; body: string } {
  const label = KIND_LABEL[f.kind];
  const titleParts = [label];
  if (f.rooms !== null && f.kind !== 'land') titleParts.push(`${f.rooms} pièce${f.rooms > 1 ? 's' : ''}`);
  if (f.surfaceM2 !== null) titleParts.push(`${fr(f.surfaceM2)} m²`);
  if (f.city) titleParts.push(f.city);
  const title = titleParts.join(', ');
  const lines: string[] = [];
  const first: string[] = [];
  if (f.surfaceM2 !== null) first.push(`${label} de ${fr(f.surfaceM2)} m²`);
  else first.push(label);
  if (f.city) first.push(`à ${f.city}`);
  let s1 = first.join(' ');
  if (f.rooms !== null && f.kind !== 'land') s1 += `, ${f.rooms} pièce${f.rooms > 1 ? 's' : ''}${f.bedrooms !== null ? ` dont ${f.bedrooms} chambre${f.bedrooms > 1 ? 's' : ''}` : ''}`;
  lines.push(`${s1}.`);
  if (f.floor !== null) {
    const where = f.floor === 0 ? 'Au rez-de-chaussée' : f.floor > 0 ? `Au ${ordinal(f.floor)} étage` : null;
    if (where) lines.push(`${where}${f.floorsTotal !== null && f.floor > 0 ? ` sur ${f.floorsTotal}` : ''}${f.elevator === true ? ', avec ascenseur' : ''}.`);
  }
  if (f.buildYear !== null) lines.push(`Construit en ${f.buildYear}.`);
  if (f.outdoor.length > 0) {
    const names = f.outdoor.map((o) => OUTDOOR_LABEL[o]);
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
    lines.push(`${list.charAt(0).toUpperCase()}${list.slice(1)}.`);
  }
  if (f.landM2 !== null && f.kind !== 'land') lines.push(`Terrain de ${fr(f.landM2)} m².`);
  if (f.parkingSpaces !== null && f.parkingSpaces > 0) lines.push(`${f.parkingSpaces} place${f.parkingSpaces > 1 ? 's' : ''} de stationnement.`);
  const heating = f.heating ? HEATING_LABEL[f.heating] : null;
  if (heating) lines.push(`${heating}.`);
  // AU061 · équipements et état, dans les mots que le contrôle relie à la fiche.
  const amenities = (f.amenities ?? []).map((a) => AMENITY_LABEL[a]);
  if (amenities.length > 0) {
    const list = amenities.length === 1 ? amenities[0]! : `${amenities.slice(0, -1).join(', ')} et ${amenities[amenities.length - 1]}`;
    lines.push(`${list.charAt(0).toUpperCase()}${list.slice(1)}.`);
  }
  if (f.condition) lines.push(CONDITION_LABEL[f.condition]);
  if (f.energyClass) lines.push(`Classe énergie ${f.energyClass}.`);
  return { title, body: lines.join(' ') };
}
