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
import type { EnergyClass, HeatingKind, OutdoorKind } from './fiche-bien.ts';

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
}

export const FACT_KEYS: readonly (keyof ListingFacts)[] = [
  'kind', 'city', 'postalCode', 'surfaceM2', 'rooms', 'bedrooms', 'floor', 'floorsTotal', 'buildYear', 'heating', 'outdoor', 'landM2', 'parkingSpaces', 'elevator', 'energyClass', 'climateClass',
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
  quatorze: 14, quinze: 15, seize: 16, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, cent: 100, mille: 1000,
  premier: 1, première: 1, deuxième: 2, second: 2, seconde: 2, troisième: 3, quatrième: 4, cinquième: 5, sixième: 6, septième: 7, huitième: 8, neuvième: 9, dixième: 10,
};
// « un », « une » et « neuf » sont surtout des mots ordinaires : ils ne comptent comme nombres que devant une unité.
const SPELLED_NEEDS_UNIT = new Set(['un', 'une', 'neuf']);
const UNIT_AFTER = /^\s*(pièces?|chambres?|étages?|niveaux?|places?|m²|m2|mètres?|ans?|salles?|lots?)\b/i;

const NUMBER = /\d{1,3}(?:[   ]\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;

const VOIE = /(?<![\p{L}\p{N}])(rue|ruelle|avenue|av\.|boulevard|bd|place|chemin|impasse|allée|route|quai|cours|square|passage|faubourg|rond-point|lieu-dit|lotissement|résidence)\s+(\S+)(?:\s+(\S+))?/giu;
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
const STREET_NUMBER = /\b\d{1,4}\s*(?:bis|ter)?\s*,?\s+(rue|avenue|boulevard|bd|chemin|impasse|allée|route|quai|cours)\b/iu;

/** Critères discriminants dans l'accès au logement : liste fermée, volontairement large [R46]. */
export const DISCRIMINATORY_TERMS: readonly string[] = [
  'origine', 'ethnie', 'ethnique', 'race', 'racial', 'religion', 'religieux', 'religieuse', 'chrétien', 'chrétienne', 'musulman', 'musulmane', 'juif', 'juive',
  'catholique', 'protestant', 'nationalité', 'étranger', 'étrangère', 'étrangers', 'français uniquement', 'française uniquement', 'handicap', 'handicapé', 'handicapée',
  'sans enfant', 'sans enfants', "pas d'enfant", "pas d'enfants", 'couple', 'couples', 'célibataire', 'célibataires', 'retraité', 'retraités', 'retraitée', 'famille', 'familles',
  'familial', 'familiale', 'jeune couple', 'jeunes', 'senior', 'seniors', 'âgé', 'âgée', 'âge', 'homme', 'hommes', 'femme', 'femmes', 'sexe', 'orientation', 'mœurs', 'moeurs',
  'grossesse', 'enceinte', 'opinion', 'opinions', 'syndicat', 'syndical', 'patronyme', 'apparence', 'réservé à', 'réservée à', 'exclusivement pour', 'idéal pour',
];

/** Mots jamais permis dans un texte destiné au public (AGENTS.md). */
export const FORBIDDEN_TERMS: readonly string[] = [
  'gratuit', 'gratuite', 'gratuitement', 'mandataire', 'mandataires', 'ia', 'intelligence artificielle', 'chatgpt', 'gpt', 'robot', 'algorithme', 'généré', 'générée', 'automatiquement',
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
  // Sans champ dans la fiche : jamais de source.
  {
    terms: ['piscine', 'cave', 'caves', 'cellier', 'grenier', 'combles', 'véranda', 'cheminée', 'climatisation', 'climatisé', 'fibre', 'double vitrage', 'parquet', 'dressing', 'buanderie',
      'neuf', 'rénové', 'rénovée', 'refait', 'refaite', 'refaits', 'travaux', 'vue', 'sans vis-à-vis', 'traversant', 'traversante', 'plein sud', 'exposé', 'exposée', 'interphone',
      'digicode', 'gardien', 'gardienne', 'loggia', 'mezzanine', 'sous-sol', 'dépendance', 'dépendances', 'puits', 'portail', 'motorisé', 'alarme', 'domotique', 'tramway', 'gare',
      'écoles', 'école', 'commerces', 'métro'],
    field: null,
    has: () => false,
  },
];

const norm = (s: string): string => s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Un terme, entier, entre deux limites de mot (lettres accentuées comprises). */
const termRe = (t: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, 'iu');

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
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Contrôle une phrase : ses sources et ses problèmes. */
export function traceSentence(sentence: string, facts: ListingFacts): SourcedSentence {
  const sources: SourcedSentence['sources'] = [];
  const problems: SentenceProblem[] = [];
  const lower = norm(sentence);
  const numbers = numericSources(facts);
  const addSource = (field: keyof ListingFacts, value: string) => {
    if (!sources.some((s) => s.field === field && s.value === value)) sources.push({ field, value });
  };

  // Adresse [R46].
  const street = STREET_NUMBER.exec(sentence)?.[0] ?? findStreet(sentence);
  if (street) problems.push({ code: 'adresse', value: street });

  // Critères discriminants [R46] et mots interdits.
  for (const term of DISCRIMINATORY_TERMS) if (termRe(norm(term)).test(lower)) problems.push({ code: 'critere_discriminant', value: term });
  for (const term of FORBIDDEN_TERMS) if (termRe(term).test(lower)) problems.push({ code: 'mot_interdit', value: term });

  // Nombres en chiffres [R47] : chacun doit être une valeur de la fiche. Le numéro d'une voie est déjà refusé.
  const matchesSource = (value: number): { field: keyof ListingFacts } | undefined => numbers.find((n) => n.value === value);
  for (const m of sentence.matchAll(NUMBER)) {
    const raw = m[0];
    const value = parseNumber(raw);
    const src = matchesSource(value);
    if (src) addSource(src.field, raw.replace(/[  ]/g, ' '));
    else problems.push({ code: 'nombre_sans_source', value: raw });
  }
  // Nombres en lettres.
  for (const m of lower.matchAll(/[\p{L}]+/gu)) {
    const word = m[0];
    const value = SPELLED[word];
    if (value === undefined) continue;
    if (SPELLED_NEEDS_UNIT.has(word) && !UNIT_AFTER.test(lower.slice((m.index ?? 0) + word.length))) continue;
    const src = matchesSource(value);
    if (src) addSource(src.field, word);
    else problems.push({ code: 'nombre_sans_source', value: word });
  }

  // Classes du diagnostic.
  for (const m of sentence.matchAll(/\bclasse\s+(?:énergie\s+|climat\s+|énergétique\s+)?([A-Za-z])\b/giu)) {
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
  if (f.energyClass) lines.push(`Classe énergie ${f.energyClass}.`);
  return { title, body: lines.join(' ') };
}
