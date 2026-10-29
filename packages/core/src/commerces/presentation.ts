/**
 * La présentation anonyme d'un commerce (M16, CE03) : un titre et un texte publiables, sans nom ni adresse, rédigés
 * par l'IA depuis la seule vue publique et la fourchette validée [R110, R112].
 *
 * L'IA, derrière une interface, ne reçoit qu'une copie des faits publics (`PresentationFacts` : sorte, activité,
 * commune, code postal, surface, fourchette validée en euros) ; jamais l'enseigne, les exercices, le bail, les
 * salariés, le matériel ni les autorisations [R112]. Le code contrôle le texte avant de le ranger :
 * - aucun nombre qui ne soit pas dans la vue publique (surface, code postal, bornes de la fourchette) ; un nombre écrit
 *   en lettres est refusé, sauf « un » et « une » ; un nombre égal à un chiffre confidentiel est nommé comme tel ;
 * - aucun mot de l'enseigne, sauf les mots courants et ceux de la commune ; aucun article du matériel ;
 * - aucun mot qui parle d'un champ confidentiel (loyer, bail, chiffre d'affaires, résultat, salariés, matériel,
 *   licence…) [R110] ;
 * - ni voie nommée, ni critère discriminant, ni mot interdit (« mandataire », « gratuit », mention de l'IA) [R46, R07].
 * Un texte de l'IA refusé n'est pas gardé : le texte de secours du code le remplace [R12], et les problèmes sont rendus
 * à l'agent. L'agent peut corriger, avec le même contrôle.
 *
 * Seul l'agent du bien valide, seulement le dernier brouillon, contrôlé sur la fiche et l'estimation validée en
 * vigueur. Une nouvelle version de la fiche ou une autre estimation rend la présentation non publiable jusqu'à une
 * nouvelle validation. `publishable` est la seule porte pour la publication (M07, branchée par CE10). Le journal ne
 * porte que des codes, jamais le texte ni un chiffre [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PropertyKind } from '../db/types.ts';
import { publicTextProblems, sentences } from '../annonces/annonce-sourcee.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { mulDiv, type EstimationCommerce } from './estimation.ts';
import type { Activity, BusinessSheet, FicheCommerce } from './fiche.ts';

/** Ce que l'IA reçoit d'un commerce, et rien d'autre [R112]. */
export interface PresentationFacts {
  kind: PropertyKind;
  activity: Activity;
  city: string | null;
  postalCode: string | null;
  surfaceM2: number | null;
  priceLowEuros: number;
  priceHighEuros: number;
}

export const PRESENTATION_FACT_KEYS: readonly (keyof PresentationFacts)[] = [
  'kind',
  'activity',
  'city',
  'postalCode',
  'surfaceM2',
  'priceLowEuros',
  'priceHighEuros',
];

/** L'IA qui rédige. Absente, trop lente, en panne ou refusée par le contrôle : texte de secours [R12]. */
export interface PresentationWriter {
  write(facts: PresentationFacts): Promise<{ title: string; body: string }>;
}

export type PresentationProblemCode =
  | 'nombre_hors_vue_publique'
  | 'chiffre_confidentiel'
  | 'enseigne'
  | 'champ_confidentiel'
  | 'adresse'
  | 'critere_discriminant'
  | 'mot_interdit';
export interface PresentationProblem {
  code: PresentationProblemCode;
  value: string;
}

/** Ce que le contrôle connaît de la fiche confidentielle, pour le chercher dans le texte ; jamais envoyé à l'IA. */
export interface ConfidentialMarks {
  signName: string | null;
  equipment: string[];
  /** Les chiffres confidentiels, en euros ou en nombre : exercices, loyer, salariés, durée et année du bail. */
  numbers: number[];
}

export const ACTIVITY_LABEL: Readonly<Record<Activity, string>> = Object.freeze({
  boulangerie_patisserie: 'boulangerie-pâtisserie',
  boucherie_charcuterie: 'boucherie-charcuterie',
  alimentation: 'alimentation',
  restaurant: 'restaurant',
  bar_cafe: 'bar-café',
  tabac_presse: 'tabac-presse',
  hotel: 'hôtel',
  coiffure_esthetique: 'coiffure et esthétique',
  pharmacie: 'pharmacie',
  habillement: 'habillement',
  fleuriste: 'fleuriste',
  automobile: 'automobile',
  commerce_de_detail: 'commerce de détail',
  services: 'services',
  artisanat: 'artisanat',
  bureaux: 'bureaux',
  local_activite: 'local d’activité',
  entrepot: 'entrepôt',
  autre: 'autre activité',
});

const KIND_LABEL: Partial<Record<PropertyKind, string>> = {
  business: 'Fonds de commerce',
  business_walls: 'Murs commerciaux',
  commercial: 'Local professionnel',
};

/** Mots qui parlent d'un champ confidentiel : refusés dans tout texte public, mieux vaut un refus de trop [R110]. */
export const CONFIDENTIAL_TOPICS: readonly string[] = [
  'loyer', 'loyers', 'bail', 'baux', 'pas-de-porte', 'droit au bail', "chiffre d'affaires", "chiffres d'affaires", 'resultat', 'resultats', 'benefice', 'benefices',
  'excedent', 'ebe', 'ebitda', 'marge', 'marges', 'rentabilite', 'rentable', 'bilan', 'bilans', 'comptes', 'comptable', 'exercice', 'exercices', 'recette', 'recettes',
  'salarie', 'salaries', 'salariee', 'salariees', 'employe', 'employes', 'employee', 'employees', 'personnel', 'effectif', 'effectifs', 'apprenti', 'apprentis', 'equipe',
  'materiel', 'materiels', 'equipement', 'equipements', 'equipe a neuf', 'licence', 'licences', 'autorisation', 'autorisations', 'agrement', 'terrasse', 'enseigne',
  'franchise', 'franchise nationale',
];

/** Mots courants qu'une enseigne peut porter sans la désigner : ils ne la trahissent pas seuls. */
const COMMON_WORDS = new Set([
  'le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'et', 'a', 'au', 'aux', 'chez', 'en', 'sur', 'un', 'une', 'the', 'and', 'of', 'maison', 'cafe', 'bar', 'restaurant',
  'boulangerie', 'patisserie', 'boucherie', 'charcuterie', 'tabac', 'presse', 'hotel', 'coiffure', 'esthetique', 'institut', 'pharmacie', 'fleurs', 'fleuriste', 'garage',
  'atelier', 'boutique', 'magasin', 'commerce', 'bureaux', 'saint', 'sainte', 'grand', 'grande', 'petit', 'petite', 'bon', 'bonne', 'vieux', 'vieille', 'nouveau', 'nouvelle',
  'alimentation', 'epicerie', 'brasserie', 'bistrot', 'salon', 'services', 'auto', 'automobile', 'artisan', 'artisanat', 'local', 'activite', 'entrepot', 'habillement', 'mode',
]);

/** Petits mots d'un libellé de matériel, qui ne le désignent pas seuls. */
const EQUIPMENT_STOP_WORDS = ['pour', 'avec', 'sans', 'par', 'sur', 'sous', 'dans', 'une', 'des', 'les', 'aux', 'neuf', 'neuve', 'occasion', 'complet', 'complete', 'grand', 'petit', 'gros'];

/** Les nombres écrits en lettres, refusés : seuls « un » et « une » restent des mots ordinaires. */
const SPELLED_NUMBERS = [
  'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'vingt', 'vingts', 'trente', 'quarante',
  'cinquante', 'soixante', 'septante', 'huitante', 'octante', 'nonante', 'cent', 'cents', 'mille', 'million', 'millions', 'milliard', 'milliards', 'dizaine', 'dizaines', 'douzaine',
  'douzaines', 'quinzaine', 'vingtaine', 'trentaine', 'quarantaine', 'cinquantaine', 'centaine', 'centaines', 'millier', 'milliers', 'moitie', 'double', 'triple', 'quart', 'tiers',
];

/** Texte comparable : minuscules, sans accents, apostrophes droites, espaces réunies. */
const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (t: string, flags = 'iu'): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, flags);
/**
 * Une expression, chaque mot au singulier ou au pluriel, dans les deux sens : « four à sole » lit aussi « fours à
 * sole », et « fours à sole » lit aussi « four à sole ». Le mot est ramené à sa racine (sans « s » ni « x » final),
 * puis lu avec ou sans marque du pluriel.
 */
const formsRe = (t: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${t
      .split(/\s+/)
      .map((w) => `${escapeRe(w.length > 3 ? w.replace(/[sx]$/u, '') : w)}(?:s|x|es)?`)
      .join('\\s+')}(?![\\p{L}\\p{N}])`,
    'iu',
  );
const words = (s: string): string[] => norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);

/** Les nombres écrits en chiffres, séparateurs de milliers compris (« 249 000 », « 249.000 », « 85,5 »). */
const NUMBER = /(?<![\p{L}\p{N}])\d{1,3}(?:[   .]\d{3})+(?:,\d+)?(?![\p{N}])|(?<![\p{L}\p{N}])\d+(?:,\d+)?(?![\p{N}])|\d+/gu;
const parseNumber = (raw: string): number => Number(raw.replace(/[   .]/g, '').replace(',', '.'));

/** Un montant en centimes, arrondi à l'euro le plus proche. */
export const toEuros = (cents: number): number => mulDiv(cents, 1, 100);

/** Les mots qui désignent l'enseigne : tous ses mots, même courts (« QG », « AX »), hors mots courants et mots de la commune. */
function signWords(signName: string | null, city: string | null): string[] {
  if (!signName) return [];
  const cityWords = new Set(city ? words(city) : []);
  return [...new Set(words(signName).filter((w) => !COMMON_WORDS.has(w) && !cityWords.has(w) && !/^\d+$/.test(w)))];
}

/** Le texte, déjà comparable, sans le nom de la commune publique. */
function withoutCity(text: string, city: string | null): string {
  const c = city ? norm(city.normalize('NFKC')).trim() : '';
  return c.length === 0 ? text : text.replace(wordRe(c, 'giu'), ' ');
}

/** Les problèmes d'une phrase de présentation ; une liste vide si elle est publiable. */
export function presentationSentenceProblems(sentence: string, facts: PresentationFacts, marks: ConfidentialMarks): PresentationProblem[] {
  const problems: PresentationProblem[] = [];
  const add = (code: PresentationProblemCode, value: string) => {
    if (!problems.some((p) => p.code === code && p.value === value)) problems.push({ code, value });
  };
  // Les nombres se cherchent sur un texte où chaque chiffre est ramené à 0-9 (NFKC : pleine chasse, exposants) et où
  // le nom de la commune, public, est retiré : « Six-Fours-les-Plages » n'est pas un nombre.
  // Seuls « m² » et « m2 » d'une surface sont lus comme une unité ; tout autre exposant est un chiffre.
  const units = sentence.replace(/(?<![\p{L}])m\s?[²2](?![\p{L}\p{N}])/gu, ' mcarre ');
  const counted = withoutCity(norm(units.normalize('NFKC')), facts.city);
  for (const m of counted.matchAll(/(?![0-9])\p{Nd}+/gu)) add('nombre_hors_vue_publique', m[0]);
  for (const m of counted.matchAll(NUMBER)) {
    const n = parseNumber(m[0]);
    // Un nombre public ne vaut que pour son champ, reconnu à son unité : un prix en euros, une surface en m², un
    // code postal sans unité. « Prix de 85 € » avec 85 m² de surface n'a pas de source.
    const after = counted.slice((m.index ?? 0) + m[0].length);
    // La première borne d'une fourchette (« 249 358 – 374 036 € ») prend l'unité de la seconde.
    const role = /^\s*(?:€|eur\b|euros?\b)/u.test(after) || /^\s*[-–]\s*\d[\d \u00a0\u202f.]*(?:,\d+)?\s*(?:€|eur\b|euros?\b)/u.test(after) ? 'prix' : /^\s*(?:mcarre|metres? carres?\b)/u.test(after) ? 'surface' : 'nu';
    // Un signe moins devant le nombre en fait une autre valeur : jamais une valeur publique.
    // Un tiret entre deux nombres sépare les bornes d'une fourchette (« 249 358 € – 374 036 € ») ; le vrai signe moins
    // (−) ou un tiret qui ne suit pas un nombre en fait une valeur négative.
    const before = counted.slice(0, m.index ?? 0);
    const negative = /−\s?$/u.test(before) || (/[-–]\s?$/u.test(before) && !/\d\s*(?:€|eur|euros?)?\s*[-–]\s?$/u.test(before));
    const fits =
      !negative &&
      (role === 'prix'
        ? n === facts.priceLowEuros || n === facts.priceHighEuros
        : role === 'surface'
          ? facts.surfaceM2 !== null && n === facts.surfaceM2
          : facts.postalCode !== null && /^\d{5}$/.test(facts.postalCode) && m[0] === facts.postalCode);
    if (fits) continue;
    add(marks.numbers.includes(n) ? 'chiffre_confidentiel' : 'nombre_hors_vue_publique', m[0]);
  }
  const lower = norm(sentence);
  for (const w of SPELLED_NUMBERS) {
    const m = wordRe(w).exec(counted);
    if (m) add('nombre_hors_vue_publique', m[0]);
  }
  if (marks.signName) {
    const whole = norm(marks.signName).trim();
    // Une enseigne faite des seuls mots courants (« Boulangerie ») ne désigne personne : l'activité reste dicible.
    if (whole.length > 0 && signWords(marks.signName, facts.city).length > 0 && wordRe(whole).test(lower)) add('enseigne', marks.signName);
  }
  for (const w of signWords(marks.signName, facts.city)) {
    const m = formsRe(w).exec(lower);
    if (m) add('enseigne', m[0]);
  }
  // Chaque article du matériel, en entier, et chacun de ses mots porteurs (« four », « pétrin ») : omettre un
  // qualificatif ne suffit pas à le dire. Les mots courants, ceux de la commune et ceux du texte de secours, publics,
  // ne comptent pas.
  const stem = (w: string): string => (w.length > 3 ? w.replace(/(?:es|s|x)$/u, '') : w);
  const spoken = new Set([...COMMON_WORDS, ...EQUIPMENT_STOP_WORDS, ...words(Object.values(fallbackPresentation(facts)).join(' '))].map(stem));
  const withoutTown = withoutCity(lower, facts.city);
  for (const item of marks.equipment) {
    const t = norm(item).trim();
    if (t.length > 0 && formsRe(t).test(lower)) {
      add('champ_confidentiel', item);
      continue;
    }
    for (const w of words(item)) {
      if (w.length < 3 || spoken.has(stem(w)) || /^\d+$/.test(w)) continue;
      const m = formsRe(w).exec(withoutTown);
      if (m) add('champ_confidentiel', m[0]);
    }
  }
  for (const t of CONFIDENTIAL_TOPICS) {
    const m = wordRe(norm(t)).exec(lower);
    if (m) add('champ_confidentiel', m[0]);
  }
  for (const p of publicTextProblems(sentence)) add(p.code as PresentationProblemCode, p.value);
  return problems;
}

export interface CheckedSentence {
  text: string;
  problems: PresentationProblem[];
}

/** Le contrôle d'une présentation, titre compris, phrase par phrase. */
export function checkPresentation(title: string, body: string, facts: PresentationFacts, marks: ConfidentialMarks): { ok: boolean; sentences: CheckedSentence[] } {
  const all = [title, ...sentences(body)].map((text) => ({ text, problems: presentationSentenceProblems(text, facts, marks) }));
  return { ok: all.every((s) => s.problems.length === 0), sentences: all };
}

/** Un nombre écrit à la française : « 249 000 », « 85,5 ». */
const frNumber = (n: number): string => {
  const [int, dec] = String(n).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return dec ? `${grouped},${dec}` : grouped;
};

/** Le texte de secours, fait par le code depuis les seuls faits publics : il passe toujours le contrôle [R12]. */
export function fallbackPresentation(f: PresentationFacts): { title: string; body: string } {
  const kind = KIND_LABEL[f.kind] ?? 'Commerce';
  const activity = ACTIVITY_LABEL[f.activity];
  const title = `${kind}, ${activity}${f.city ? `, ${f.city}` : ''}`;
  const where = f.city ? ` à ${f.city}${f.postalCode ? ` (${f.postalCode})` : ''}` : '';
  const lines = [`${kind}, activité ${activity}${where}.`];
  if (f.surfaceM2 !== null) lines.push(`Surface de ${frNumber(f.surfaceM2)} m².`);
  lines.push(`Prix entre ${frNumber(f.priceLowEuros)} € et ${frNumber(f.priceHighEuros)} €.`);
  lines.push('Les chiffres détaillés sont communiqués après la signature d’un engagement de confidentialité et la vérification de votre identité.');
  lines.push('Votre agent immobilier AIMMO répond à vos questions.');
  return { title, body: lines.join(' ') };
}

/** Les chiffres confidentiels d'une fiche, pour les reconnaître dans un texte. */
export function confidentialMarks(sheet: BusinessSheet): ConfidentialMarks {
  const numbers: number[] = [];
  for (const y of sheet.fiscalYears) {
    numbers.push(toEuros(y.revenueCents), toEuros(Math.abs(y.resultCents)), y.year);
    if (y.ebitdaCents !== undefined) numbers.push(toEuros(Math.abs(y.ebitdaCents)));
  }
  if (sheet.leaseAnnualRentCents !== null) numbers.push(toEuros(sheet.leaseAnnualRentCents), toEuros(mulDiv(sheet.leaseAnnualRentCents, 1, 12)));
  if (sheet.leaseYears !== null) numbers.push(sheet.leaseYears);
  if (sheet.leaseStart !== null) numbers.push(Number(sheet.leaseStart.slice(0, 4)));
  if (sheet.employees !== null) numbers.push(sheet.employees);
  return { signName: sheet.signName, equipment: [...sheet.equipment], numbers };
}

export type PresentationOrigin = 'ia' | 'secours' | 'agent';

export interface BusinessPresentation {
  id: string;
  propertyId: string;
  seq: number;
  title: string;
  body: string;
  origin: PresentationOrigin;
  sheetVersion: number;
  valuationId: string;
  createdBy: string;
  createdAt: string;
  validated: { by: string; at: string } | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
export type PresentationProblemResult =
  | { ok: false; rule: null; code: 'sorte' | 'unknown_presentation' | 'no_presentation' | 'bad_text' | 'busy' }
  | { ok: false; rule: 'R10'; code: 'incomplet'; missing: string[] }
  | { ok: false; rule: 'R110'; code: 'refused_text'; sentences: CheckedSentence[] }
  | { ok: false; rule: 'R110'; code: 'not_latest' | 'stale' | 'already_validated' };

interface PresentationRow {
  id: string;
  network_id: string;
  property_id: string;
  seq: number;
  title: string;
  body: string;
  origin: PresentationOrigin;
  sheet_version: number;
  valuation_id: string;
  created_by: string;
  created_at: string;
  validated_by: string | null;
  validated_at: string | null;
}

const SELECT = `SELECT p.*, v.validated_by, v.validated_at FROM business_presentations p
  LEFT JOIN business_presentation_validations v ON v.presentation_id = p.id`;

const toPresentation = (r: PresentationRow): BusinessPresentation => ({
  id: r.id,
  propertyId: r.property_id,
  seq: Number(r.seq),
  title: r.title,
  body: r.body,
  origin: r.origin,
  sheetVersion: Number(r.sheet_version),
  valuationId: r.valuation_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  validated: r.validated_by !== null && r.validated_at !== null ? { by: r.validated_by, at: r.validated_at } : null,
});

const MAX_TITLE = 120;
const MAX_BODY = 3000;
const AI_TIMEOUT_MS = 20_000;

interface Basis {
  facts: PresentationFacts;
  marks: ConfidentialMarks;
  sheetVersion: number;
  valuationId: string;
}

const codesOf = (s: CheckedSentence[]): string[] => [...new Set(s.flatMap((x) => x.problems.map((p) => p.code)))];

export interface PresentationCommerceOptions {
  now?: () => Date;
  newId?: () => string;
  writer?: PresentationWriter;
  timeoutMs?: number;
}

export class PresentationCommerce {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly writer: PresentationWriter | null;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiches: FicheCommerce,
    private readonly estimations: EstimationCommerce,
    options: PresentationCommerceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.writer = options.writer ?? null;
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  }

  /**
   * Les faits publics du commerce, ses marques confidentielles pour le contrôle, et les versions sur lesquelles ils
   * reposent. Sans activité ou sans fourchette validée en vigueur : ce qui manque, jamais un texte [R10].
   */
  async basis(propertyId: string): Promise<Basis | { missing: string[] } | null> {
    const view = await this.fiches.publicView(propertyId);
    if (!view) return null;
    const sheet = await this.fiches.current(propertyId);
    const range = await this.estimations.validatedRange(propertyId);
    const missing: string[] = [];
    if (!sheet) missing.push('fiche');
    if (view.activity === null) missing.push('activite');
    if (!range) missing.push('estimation_validee');
    if (missing.length > 0 || !sheet || !range || view.activity === null) return { missing };
    return {
      facts: {
        kind: view.kind,
        activity: view.activity,
        city: view.city,
        postalCode: view.postalCode,
        surfaceM2: view.surfaceM2 === null ? null : Number(view.surfaceM2),
        priceLowEuros: toEuros(range.lowCents),
        priceHighEuros: toEuros(range.highCents),
      },
      marks: confidentialMarks(sheet.sheet),
      sheetVersion: sheet.version,
      valuationId: range.valuationId,
    };
  }

  /**
   * L'IA propose ; le code contrôle. Refusé, le texte de l'IA n'est pas gardé : le secours le remplace, et les phrases
   * refusées sont rendues avec leurs problèmes.
   */
  async propose(
    acces: Acces,
    viewer: Viewer,
    propertyId: string,
  ): Promise<{ ok: true; value: BusinessPresentation; aiRefused: CheckedSentence[] | null } | Refusal | PresentationProblemResult> {
    const g = await this.gate(acces, viewer, propertyId, 'write');
    if (!g.ok) return g;
    const b = await this.ready(viewer, propertyId);
    if (!('facts' in b)) return b;
    let aiRefused: CheckedSentence[] | null = null;
    const ai = await this.askWriter(b.facts);
    if (ai) {
      const checked = checkPresentation(ai.title, ai.body, b.facts, b.marks);
      if (checked.ok) {
        const stored = await this.store(viewer, g.networkId, propertyId, ai, 'ia', b);
        return stored ? { ok: true, value: stored, aiRefused: null } : { ok: false, rule: null, code: 'busy' };
      }
      aiRefused = checked.sentences.filter((s) => s.problems.length > 0);
      await appendEvent(
        this.journal,
        { type: 'commerces.presentation.ia_refusee', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R110', codes: codesOf(aiRefused) } },
        this.now,
      );
    }
    const fallback = fallbackPresentation(b.facts);
    const checked = checkPresentation(fallback.title, fallback.body, b.facts, b.marks);
    if (!checked.ok) return { ok: false, rule: 'R110', code: 'refused_text', sentences: checked.sentences.filter((s) => s.problems.length > 0) };
    const stored = await this.store(viewer, g.networkId, propertyId, fallback, 'secours', b);
    return stored ? { ok: true, value: stored, aiRefused } : { ok: false, rule: null, code: 'busy' };
  }

  /** L'agent corrige le texte : même contrôle, phrase par phrase. */
  async correct(
    acces: Acces,
    viewer: Viewer,
    propertyId: string,
    text: { title: unknown; body: unknown },
  ): Promise<{ ok: true; value: BusinessPresentation } | Refusal | PresentationProblemResult> {
    const g = await this.gate(acces, viewer, propertyId, 'write');
    if (!g.ok) return g;
    if (typeof text?.title !== 'string' || typeof text?.body !== 'string') return { ok: false, rule: null, code: 'bad_text' };
    const title = text.title.trim();
    const body = text.body.trim();
    if (title === '' || body === '' || title.length > MAX_TITLE || body.length > MAX_BODY) return { ok: false, rule: null, code: 'bad_text' };
    const b = await this.ready(viewer, propertyId);
    if (!('facts' in b)) return b;
    const checked = checkPresentation(title, body, b.facts, b.marks);
    if (!checked.ok) {
      const refused = checked.sentences.filter((s) => s.problems.length > 0);
      await appendEvent(
        this.journal,
        { type: 'commerces.presentation.texte_refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R110', codes: codesOf(refused) } },
        this.now,
      );
      return { ok: false, rule: 'R110', code: 'refused_text', sentences: refused };
    }
    const stored = await this.store(viewer, g.networkId, propertyId, { title, body }, 'agent', b);
    return stored ? { ok: true, value: stored } : { ok: false, rule: null, code: 'busy' };
  }

  /** Le dernier brouillon, pour qui voit le bien en entier [R16]. */
  async read(acces: Acces, viewer: Viewer, propertyId: string): Promise<{ ok: true; value: BusinessPresentation } | Refusal | PresentationProblemResult> {
    const g = await this.gate(acces, viewer, propertyId, 'read');
    if (!g.ok) return g;
    const row = await this.db.first<PresentationRow>(`${SELECT} WHERE p.property_id = ? ORDER BY p.seq DESC LIMIT 1`, [propertyId]);
    return row ? { ok: true, value: toPresentation(row) } : { ok: false, rule: null, code: 'no_presentation' };
  }

  /**
   * L'agent du bien valide le dernier brouillon, contrôlé sur la fiche et l'estimation validée en vigueur, et qui passe
   * encore le contrôle. Une validation est définitive [R17].
   */
  async validate(acces: Acces, viewer: Viewer, presentationId: string): Promise<{ ok: true; value: BusinessPresentation } | Refusal | PresentationProblemResult> {
    const row = await this.db.first<PresentationRow>(`${SELECT} WHERE p.id = ?`, [presentationId]);
    if (!row || row.network_id !== viewer.networkId) {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'business_presentation', code: 'unknown' } },
        this.now,
      );
      return { ok: false, rule: null, code: 'unknown_presentation' };
    }
    const g = await this.gate(acces, viewer, row.property_id, 'validate');
    if (!g.ok) return g;
    const p = toPresentation(row);
    if (p.validated) return { ok: false, rule: 'R110', code: 'already_validated' };
    const latest = await this.db.first<{ id: string }>('SELECT id FROM business_presentations WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [row.property_id]);
    if (latest?.id !== p.id) return { ok: false, rule: 'R110', code: 'not_latest' };
    const b = await this.basis(row.property_id);
    if (!b || !('facts' in b) || b.sheetVersion !== p.sheetVersion || b.valuationId !== p.valuationId) return { ok: false, rule: 'R110', code: 'stale' };
    const checked = checkPresentation(p.title, p.body, b.facts, b.marks);
    if (!checked.ok) return { ok: false, rule: 'R110', code: 'refused_text', sentences: checked.sentences.filter((s) => s.problems.length > 0) };
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      'INSERT INTO business_presentation_validations (presentation_id, network_id, validated_by, validated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [p.id, row.network_id, this.actor(viewer), at],
    );
    if (changes !== 1) return { ok: false, rule: 'R110', code: 'already_validated' };
    await appendEvent(
      this.journal,
      { type: 'commerces.presentation.validee', actor: this.actor(viewer), subject: `property:${row.property_id}`, data: { seq: p.seq } },
      this.now,
    );
    return { ok: true, value: { ...p, validated: { by: this.actor(viewer), at } } };
  }

  /**
   * La seule porte de la publication : le dernier brouillon, validé, sur la fiche et l'estimation en vigueur, qui
   * passe encore le contrôle ; sinon `null`, rien à publier [R110].
   */
  async publishable(networkId: string, propertyId: string): Promise<BusinessPresentation | null> {
    const row = await this.db.first<PresentationRow>(`${SELECT} WHERE p.property_id = ? ORDER BY p.seq DESC LIMIT 1`, [propertyId]);
    if (!row || row.network_id !== networkId) return null;
    const p = toPresentation(row);
    if (!p.validated) return null;
    const b = await this.basis(propertyId);
    if (!b || !('facts' in b) || b.sheetVersion !== p.sheetVersion || b.valuationId !== p.valuationId) return null;
    return checkPresentation(p.title, p.body, b.facts, b.marks).ok ? p : null;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async ready(viewer: Viewer, propertyId: string): Promise<Basis | PresentationProblemResult> {
    const b = await this.basis(propertyId);
    if (!b) return { ok: false, rule: null, code: 'sorte' };
    if ('missing' in b) {
      await appendEvent(
        this.journal,
        { type: 'commerces.presentation.incomplete', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R10', missing: b.missing } },
        this.now,
      );
      return { ok: false, rule: 'R10', code: 'incomplet', missing: b.missing };
    }
    return b;
  }

  private async askWriter(facts: PresentationFacts): Promise<{ title: string; body: string } | null> {
    if (!this.writer) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // L'IA reçoit une copie des seuls faits publics : elle ne peut rien changer, ni rien recevoir d'autre [R112].
      const out = await Promise.race([
        this.writer.write(structuredClone(facts)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.timeoutMs);
        }),
      ]);
      if (!out || typeof out.title !== 'string' || typeof out.body !== 'string') return null;
      const title = out.title.trim();
      const body = out.body.trim();
      if (title === '' || body === '' || title.length > MAX_TITLE || body.length > MAX_BODY) return null;
      return { title, body };
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async store(
    viewer: Viewer,
    networkId: string,
    propertyId: string,
    text: { title: string; body: string },
    origin: PresentationOrigin,
    b: Basis,
  ): Promise<BusinessPresentation | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO business_presentations (id, network_id, property_id, seq, title, body, origin, sheet_version, valuation_id, created_by, created_at)
         SELECT ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ? FROM business_presentations WHERE property_id = ?
         ON CONFLICT DO NOTHING`,
        [id, networkId, propertyId, text.title, text.body, origin, b.sheetVersion, b.valuationId, this.actor(viewer), this.now().toISOString(), propertyId],
      );
      if (changes !== 1) continue;
      const row = await this.db.first<PresentationRow>(`${SELECT} WHERE p.id = ?`, [id]);
      if (!row) continue;
      const p = toPresentation(row);
      await appendEvent(
        this.journal,
        { type: 'commerces.presentation', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { seq: p.seq, origin } },
        this.now,
      );
      return p;
    }
    return null;
  }

  /** Qui voit le bien en entier lit ; l'agent du bien et la direction écrivent ; seul l'agent du bien valide [R16]. */
  private async gate(
    acces: Acces,
    viewer: Viewer,
    propertyId: string,
    need: 'read' | 'write' | 'validate',
  ): Promise<{ ok: true; networkId: string } | Refusal | PresentationProblemResult> {
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    if (need === 'write' && !((viewer.role === 'agent' && read.value.agent_id === viewer.userId) || viewer.role === 'direction')) return this.refused(viewer, propertyId, 'role');
    if (need === 'validate' && (viewer.role !== 'agent' || read.value.agent_id !== viewer.userId)) return this.refused(viewer, propertyId, 'role');
    if (!(await this.fiches.publicView(propertyId))) return { ok: false, rule: null, code: 'sorte' };
    return { ok: true, networkId: read.value.network_id };
  }

  private async refused(viewer: Viewer, propertyId: string, code: string): Promise<Refusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'business_presentation', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
