/**
 * Classer et extraire un contact (M03, Q01), par règles fixes écrites ici, sans IA. Elles servent quand l'IA manque,
 * et elles bornent l'IA : une sortie de l'IA hors des champs prévus est refusée [R23], un financement qu'elle
 * prête à la personne sans qu'elle l'ait déclaré aussi [R24], un montant absent du message aussi [R10].
 *
 * Rien n'est déduit de la personne : seulement ce qu'elle demande, dans une liste fermée de champs et de mots.
 */
import type { ProjectKind } from '../db/types.ts';
import { plain } from '../envoi/texte.ts';

/** Vendeur, acquéreur, demande d'estimation, mise en location, professionnel, partenaire, curiosité, indésirable. */
export const CATEGORIES = ['seller', 'buyer', 'valuation', 'rent_out', 'professional', 'partner', 'curious', 'spam'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Le module qui prend la suite : location (M15), commerce et entreprise (M16), investissement (M17). */
export const ROUTES = ['M15', 'M16', 'M17'] as const;
export type Route = (typeof ROUTES)[number];

export const DEADLINES = ['now', 'within_3_months', 'within_6_months', 'within_1_year', 'later'] as const;
export type Deadline = (typeof DEADLINES)[number];

/** Le financement, seulement tel que la personne l'a déclaré, jamais évalué [R24]. */
export const FINANCINGS = ['cash', 'loan_approved', 'loan_in_progress', 'loan_needed'] as const;
export type Financing = (typeof FINANCINGS)[number];

/** Les critères admis : une liste fermée de mots sur le bien, rien sur la personne [R23]. */
export const CRITERIA = [
  'house',
  'apartment',
  'studio',
  'land',
  'building',
  'garden',
  'balcony',
  'terrace',
  'garage',
  'parking',
  'cellar',
  'elevator',
  'pool',
  'single_storey',
  'quiet',
  'bright',
  'view',
  'fireplace',
  'outbuilding',
] as const;
export type Criterion = (typeof CRITERIA)[number] | `rooms:${number}` | `bedrooms:${number}`;

/** Les champs d'une qualification, et seulement eux [R23]. */
export interface Qualified {
  category: Category;
  route: Route | null;
  city: string | null;
  budgetMinEur: number | null;
  budgetMaxEur: number | null;
  /** Prix souhaité par un vendeur. */
  priceEur: number | null;
  deadline: Deadline | null;
  financing: Financing | null;
  criteria: Criterion[];
}

export const QUALIFIED_KEYS: readonly (keyof Qualified)[] = [
  'category',
  'route',
  'city',
  'budgetMinEur',
  'budgetMaxEur',
  'priceEur',
  'deadline',
  'financing',
  'criteria',
];

/** Les communes reconnues : un réglage, des noms publics. Les zones des agents viendront en Q03. */
export const DEFAULT_COMMUNES: readonly string[] = Object.freeze([
  'Dijon',
  'Chenôve',
  'Talant',
  'Fontaine-lès-Dijon',
  'Quetigny',
  'Chevigny-Saint-Sauveur',
  'Longvic',
  'Saint-Apollinaire',
  'Marsannay-la-Côte',
  'Plombières-lès-Dijon',
  'Ahuy',
  'Daix',
  'Hauteville-lès-Dijon',
  'Sennecey-lès-Dijon',
  'Neuilly-Crimolois',
  'Ouges',
  'Fénay',
  'Perrigny-lès-Dijon',
  'Corcelles-les-Monts',
  'Flavignerot',
  'Bretenière',
  'Magny-sur-Tille',
  'Bressey-sur-Tille',
  'Asnières-lès-Dijon',
  'Messigny-et-Vantoux',
  'Velars-sur-Ouche',
  'Beaune',
  'Auxonne',
  'Genlis',
  'Is-sur-Tille',
  'Nuits-Saint-Georges',
  'Gevrey-Chambertin',
  'Fixin',
  'Couchey',
  'Brochon',
  'Saint-Jean-de-Losne',
  'Arc-sur-Tille',
  'Mirebeau-sur-Bèze',
]);

/** Mots de la commune, pour la trouver dans un texte : « fontaine les dijon » comme « Fontaine-lès-Dijon ». */
const communeKey = (name: string): string => plain(name).replace(/[^a-z0-9]+/g, ' ').trim();

export function findCommune(text: string, communes: readonly string[] = DEFAULT_COMMUNES): string | null {
  const p = ` ${communeKey(text)} `;
  // La plus longue d'abord : « Fontaine-lès-Dijon » avant « Dijon ».
  const sorted = [...communes].sort((a, b) => communeKey(b).length - communeKey(a).length);
  return sorted.find((c) => p.includes(` ${communeKey(c)} `)) ?? null;
}

const has = (p: string, patterns: readonly RegExp[]): boolean => patterns.some((r) => r.test(p));

const SPAM = [
  // Un lien seul ne suffit pas : une personne peut citer l'annonce qu'elle a vue.
  /\b(?:seo|referencement|backlinks?|crypto|bitcoin|casino|forex|viagra)\b/,
  /\b(?:gagnez|cliquez ici|offre exclusive|promotion exclusive|votre site (?:web|internet))\b/,
  /\b(?:augmenter (?:votre|vos) (?:visibilite|ventes|abonnes))\b/,
];
const PARTNER = [
  /\b(?:partenariat|partenaire|collaborer|collaboration|apporteur d.affaires)\b/,
  /\bje suis (?:notaire|courtier|diagnostiqueur|artisan|architecte|geometre|photographe|home stager|banquier|conseiller bancaire)\b/,
  /\b(?:notre|mon) (?:cabinet|agence de diagnostic|entreprise de (?:renovation|travaux|demenagement))\b.*\b(?:propos|travailler)/,
];
const PROFESSIONAL = [
  /\b(?:local commercial|locaux commerciaux|local professionnel|fonds de commerce|murs commerciaux|bail commercial|droit au bail|bureaux?)\b/,
  /\b(?:ma|notre) (?:societe|entreprise|boutique|restaurant|commerce|activite)\b/,
  /\b(?:cession|ceder|reprise) (?:de |d.)?(?:mon |ma |notre |un |une )?(?:commerce|fonds|entreprise|societe|activite)\b/,
];
const RENT_OUT = [
  /\b(?:mettre|mise) en location\b/,
  /\b(?:louer|faire louer) (?:mon|ma|notre|nos|un bien que)\b/,
  /\bgestion locative\b/,
  /\b(?:trouver|cherche) (?:un|des) locataires?\b/,
  /\bmon locataire\b/,
];
const SELLER = [
  /\b(?:je|nous) (?:vends|vendons|souhaite(?:rions|ons)? vendre|voudrai(?:s|ent|t) vendre|veux vendre|voulons vendre|pense(?:ons)? (?:a )?vendre|envisage(?:ons)? de vendre)\b/,
  /\b(?:mettre|mise) en vente\b/,
  /\bvendre (?:mon|ma|mes|notre|nos)\b/,
  /\bmandat de vente\b/,
];
const VALUATION = [/\bestim/, /\bcombien (?:vaut|vaudrait)\b/, /\bvaleur (?:de|du) (?:mon|ma|notre|nos)\b/, /\bavis de valeur\b/];
const BUYER = [
  /\b(?:acheter|achat|acquerir|acquisition)\b/,
  /\b(?:je|nous) (?:cherche|cherchons|recherche|recherchons)\b/,
  /\b(?:toujours|encore) (?:disponible|dispo|en vente|a vendre)\b/,
  /\b(?:est-il|est-elle|est il|est elle) (?:toujours |encore )?(?:disponible|dispo)\b/,
  /\b(?:visiter|une visite|la visite)\b/,
  /\binteresse(?:e|es|s)? par\b/,
  /\bprimo.?accedant/,
];
const RENTAL = [/\b(?:a louer|en location|une location|louer (?:un|une)|location (?:d.un|d.une))\b/];
const INVEST = [/\b(?:investir|investissement|investisseur|rendement|rentabilite|lmnp|pinel|immeuble de rapport)\b/];

/** Le module qui prend la suite, d'après la catégorie et les mots du message. */
function routeOf(category: Category, p: string): Route | null {
  if (category === 'rent_out') return 'M15';
  if (category === 'professional') return 'M16';
  if (category === 'buyer' || category === 'curious') {
    if (has(p, INVEST)) return 'M17';
    if (has(p, RENTAL)) return 'M15';
  }
  return null;
}

export interface ClassifyContext {
  /** Le message cite un bien reconnu : la personne s'y intéresse. */
  propertyRecognized?: boolean;
}

export function classifyByRules(text: string, ctx: ClassifyContext = {}): Category {
  const p = plain(text);
  if (has(p, SPAM)) return 'spam';
  if (has(p, PARTNER)) return 'partner';
  if (has(p, PROFESSIONAL)) return 'professional';
  if (has(p, RENT_OUT)) return 'rent_out';
  if (has(p, SELLER)) return 'seller';
  if (has(p, VALUATION)) return 'valuation';
  if (has(p, BUYER) || has(p, INVEST) || has(p, RENTAL) || ctx.propertyRecognized) return 'buyer';
  return 'curious';
}

// « k » seul, jamais le début de « km » ou de « kg » ; jamais le chiffre d'un « T3 » collé au montant qui suit.
const AMOUNT = /(?<![\p{L}\d])(\d+(?:[ \u00a0\u202f.]\d{3})*(?:,\d+)?)\s*(k€|keur|k(?![\p{L}\d])|mille\b)?\s*(€|euros?\b|eur\b)?/gu;
const MONEY_CONTEXT = /(?:budget|prix|maximum|max|jusqu.a|entre|autour de|environ|vers)\W*$/;

/** Les montants du message, en euros : seulement ceux qui en sont sûrement, jamais « 3 pièces » ni « 2 ans ». */
export function amountsIn(text: string): number[] {
  return moneyMentions(text).map((m) => m.amount);
}

interface MoneyMention {
  amount: number;
  /** Les mots juste avant le montant, pour savoir ce qu'il désigne. */
  before: string;
}

/** Un montant qui n'est ni un budget ni un prix : l'apport, les frais, une mensualité, un revenu. */
// « Frais inclus » ou « hors frais » dit ce que couvre le budget : ce n'est pas un montant de frais.
const OTHER_MONEY =
  /\b(?:apport|(?<!hors )frais(?!(?: de notaire| d.agence| d.acquisition)? (?:inclus|compris))|mensualites?|salaires?|revenus?|charges|taxe|epargne|loyer actuel|honoraires|commission)\b[^0-9]*$/;
const LABELLED_MONEY = /\b(?:budget|prix|maximum|max|jusqu.a|plafond|vendre a|mettre a)\b[^0-9]*$/;
// « Apport maximum 30 000 » reste un apport : seul le nom d'un budget ou d'un prix change de sujet.
const MONEY_LABEL = /\b(?:budget|prix|vendre a|mettre a)\b/g;

/** Un montant de frais, d'apport ou de revenu : le dernier sujet nommé avant lui décide, « frais de notaire, budget 300 000 ». */
function isOtherMoney(before: string): boolean {
  const labels = [...before.matchAll(MONEY_LABEL)];
  const last = labels[labels.length - 1];
  return OTHER_MONEY.test(last ? before.slice((last.index ?? 0) + last[0].length) : before);
}

/** Les montants qui peuvent être un budget ou un prix : ni l'apport, ni les frais, ni un revenu [R10]. */
function budgetAmountsIn(text: string): number[] {
  return moneyMentions(text)
    .filter((m) => !isOtherMoney(m.before))
    .map((m) => m.amount);
}

function moneyMentions(text: string): MoneyMention[] {
  const p = plain(text).replace(/[\u00a0\u202f]/g, ' ');
  const found: MoneyMention[] = [];
  for (const m of p.matchAll(AMOUNT)) {
    const [, raw = '', thousand, currency] = m;
    const value = Number(raw.replace(/[ .]/g, '').replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    const before = p.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0);
    const amount = thousand ? value * 1000 : value;
    // Un loyer s'écrit en centaines d'euros : avec la devise, dès 100 € ; sinon, dès 1 000.
    const floor = currency ? 100 : 1000;
    if ((thousand || currency || MONEY_CONTEXT.test(before)) && amount >= floor && amount <= 100_000_000) {
      found.push({ amount: Math.round(amount), before: p.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0) });
    }
  }
  return found;
}

function deadlineOf(p: string): Deadline | null {
  if (/\b(?:pas (?:presse|pressee|presses|urgent)|rien ne presse|plus tard|dans quelques annees|d.ici (?:deux|2|quelques) ans)\b/.test(p)) return 'later';
  if (/\b(?:urgent|urgence|rapidement|au plus vite|des que possible|asap|ce mois|tout de suite|immediatement)\b/.test(p)) return 'now';
  if (/\b(?:(?:d.ici|dans|sous) (?:1|2|3|un|deux|trois) mois|ce trimestre|cet (?:ete|hiver|automne)|ce printemps)\b/.test(p)) return 'within_3_months';
  if (/\b(?:(?:d.ici|dans|sous) (?:4|5|6|quatre|cinq|six) mois|d.ici l.ete|semestre)\b/.test(p)) return 'within_6_months';
  if (/\b(?:(?:d.ici|dans|sous) (?:un|1) an|l.an prochain|l.annee prochaine|courant \d{4})\b/.test(p)) return 'within_1_year';
  return null;
}

const NEGATION = /\b(?:pas|ne|n'|jamais|aucun|aucune|plus|ni|sans)\b|\bpour (?:le moment|l'instant)\b|\bencore\b/;
// Un accord seulement espéré, à demander ou au conditionnel n'est pas déclaré : rien n'est rangé.
const HYPOTHETICAL = /\b(?:paierai|paierons|payerai|payerons|aurai|aurons|obtiendrai|obtiendrons|si|s'il|quand|lorsque|des que|une fois|je vais|nous allons|on va|demander|pourrai|pourrais|pourrions|pourrons|espere|esperons|aimerais|voudrais|devrait|devrais|devrions|peut-etre|eventuellement|bientot|prochainement)\b/;
const WAITING = /\b(?:j'attends|nous attendons|on attend|en attente (?:de|d'|du))\b/;
const FINANCING_WORDS = /\b(?:accord (?:de|du)|pret|credit|emprunt|financement|banque|comptant|cash|fonds propres)\b/;

/** Le financement déclaré dans une seule proposition, ou null si elle le nie, le met au futur ou n'en dit rien. */
function financingOfClause(c: string): Financing | null {
  if (!FINANCING_WORDS.test(c)) return null;
  // « Sans prêt » déclare un achat comptant ; toute autre négation, ou « pour le moment », ne déclare rien,
  // pas même une attente (« je ne suis pas en attente de prêt »).
  const cash = /\bsans (?:pret|credit|emprunt)\b/.test(c);
  if (NEGATION.test(cash ? c.replace(/\bsans (?:pret|credit|emprunt)\b/g, '') : c)) return null;
  // « J'attends l'accord de la banque » : le dossier est en cours, rien n'est accordé.
  if (WAITING.test(c)) return 'loan_in_progress';
  if (HYPOTHETICAL.test(c)) return null;
  if (cash || /\b(?:comptant|cash|fonds propres)\b/.test(c)) return 'cash';
  // Un accord acquis, dit comme tel : « j'ai l'accord de principe », « accord de prêt obtenu », « prêt accordé ».
  if (
    /\b(?:j'ai|nous avons|on a|avons obtenu|ai obtenu|avec)\s+(?:deja\s+)?(?:un |l'|mon |notre |notre )?accord (?:de|du) (?:pret|principe|financement|la banque|ma banque|notre banque|banque)\b/.test(c) ||
    /\baccord (?:de|du) (?:pret|principe|financement|banque)\b[^.]*\b(?:obtenu|accorde|valide|en poche|recu|signe)\b/.test(c) ||
    /\b(?:pret|financement) (?:accorde|valide|obtenu|ok)\b/.test(c)
  ) {
    return 'loan_approved';
  }
  if (/\b(?:pret en cours|financement en cours|dossier (?:de pret |de financement )?en cours|rendez-vous (?:avec|a) (?:la|ma) banque|mon courtier|simulation de pret)\b/.test(c)) return 'loan_in_progress';
  if (/\b(?:avec (?:un|mon) (?:pret|credit)|besoin d'un (?:pret|credit)|(?:faire|faut) un (?:pret|credit))\b/.test(c)) return 'loan_needed';
  return null;
}

/**
 * Le financement que la personne déclare elle-même, proposition par proposition ; null si elle n'en dit rien, le nie,
 * l'attend seulement ou se contredit [R24]. Jamais évalué.
 */
export function declaredFinancing(text: string): Financing | null {
  // Une phrase au conditionnel, au futur ou à l'hypothèse ne déclare rien, même découpée par des virgules.
  const sentences = plain(text)
    .split(/[.;!?\n]/)
    .filter((sentence) => !HYPOTHETICAL.test(sentence));
  const clauses = sentences.flatMap((sentence) => sentence.split(/,|\bmais\b|\bet\b|\bou\b/));
  const found = new Set(clauses.map(financingOfClause).filter((f): f is Financing => f !== null));
  return found.size === 1 ? [...found][0]! : null;
}

const CRITERIA_WORDS: readonly [Criterion, RegExp][] = [
  ['house', /\bmaisons?\b|\bpavillon/],
  ['apartment', /\bappart(?:ement)?s?\b/],
  ['studio', /\bstudios?\b/],
  ['land', /\bterrains?\b/],
  ['building', /\bimmeubles?\b/],
  ['garden', /\bjardin/],
  ['balcony', /\bbalcon/],
  ['terrace', /\bterrasse/],
  ['garage', /\bgarages?\b/],
  ['parking', /\b(?:parking|place de stationnement)/],
  ['cellar', /\bcaves?\b/],
  ['elevator', /\bascenseur/],
  ['pool', /\bpiscine/],
  ['single_storey', /\bplain.?pied/],
  ['quiet', /\b(?:calme|au calme)\b/],
  ['bright', /\b(?:lumineux|lumineuse|lumiere)\b/],
  ['view', /\b(?:belle vue|vue degagee|avec vue)\b/],
  ['fireplace', /\bcheminee/],
  ['outbuilding', /\bdependance/],
];

const NEGATORS = /^(?:sans|pas|ni|aucun|aucune|jamais|eviter|evite)$/;
/** Ce qui peut séparer une négation de ce qu'elle nie : « pas besoin d'un grand jardin ». Rien d'autre. */
const NEGATION_FILLER = /^(?:besoin|envie|forcement|vraiment|absolument|de|d'|du|des|un|une|le|la|les|l'|mon|ma|mes|grande?s?|petite?s?|gros|grosses?|beaux?|belles?)$/;
const PROPERTY_TYPE = /^(?:maisons?|pavillons?|appart(?:ement)?s?|studios?|terrains?|immeubles?)$/;
const CRITERION_WORD = /^(?:maisons?|pavillons?|appart(?:ement)?s?|studios?|terrains?|immeubles?|jardins?|balcons?|terrasses?|garages?|parkings?|caves?|ascenseurs?|piscines?|cheminees?|dependances?|[tf]\d{1,2}|\d{1,2}|pieces?|chambres?)$/;
/** « Jardin pas nécessaire », « garage : non » : la négation vient après le mot. */
const DENIED_AFTER =
  /^[\p{L}-]*\s*(?:(?:(?:n'est|ne sont|est|sont)\s+)?(?:pas|non)\s+(?:forcement\s+|vraiment\s+|absolument\s+)?(?:necessaires?|obligatoires?|indispensables?|utiles?|souhaitee?s?|voulue?s?)\b|:\s*non\b)/u;

/**
 * Le mot trouvé à cette place est-il nié ? La portée est stricte : on remonte depuis le mot, et seuls des déterminants,
 * « besoin de », un adjectif de taille ou d'autres critères reliés peuvent le séparer de la négation. « Je ne sais pas
 * combien vaut ma maison » et « sans travaux, 3 chambres » ne nient rien.
 */
function isDenied(p: string, start: number, end: number): boolean {
  if (DENIED_AFTER.test(p.slice(end))) return true;
  const tokens = p.slice(0, start).match(/[\p{L}\d]+'?|[.,;:!?()\n]/gu) ?? [];
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i]!;
    if (NEGATORS.test(t)) return true;
    // « Ne… plus » nie ; « plus » seul non.
    if (t === 'plus') return tokens.slice(Math.max(0, i - 3), i).some((w) => w === 'ne' || w.startsWith("n'"));
    if (NEGATION_FILLER.test(t) || CRITERION_WORD.test(t)) continue;
    // Une liste continue après une virgule : « pas de piscine, de jardin ou de cave ».
    if (t === ',' && /^(?:de|d'|du|des)$/.test(tokens[i + 1] ?? '')) continue;
    // « Pas de jardin et un balcon » : un nouveau groupe ; « sans cave et garage » : la même négation.
    if ((t === 'et' || t === 'ou') && !/^(?:un|une|des)$/.test(tokens[i + 1] ?? '')) continue;
    // « Pas de maison avec piscine » nie les deux ; « sans jardin avec garage » demande le garage.
    if (t === 'avec' && PROPERTY_TYPE.test(tokens[i - 1] ?? '')) continue;
    return false;
  }
  return false;
}

const globally = (r: RegExp): RegExp => new RegExp(r.source, 'g');

/** Chaque critère que le message cite, et s'il l'affirme au moins une fois ou seulement le nie. */
function mentionedCriteria(p: string): Map<Criterion, boolean> {
  const out = new Map<Criterion, boolean>();
  const note = (c: Criterion, m: RegExpMatchArray): void => {
    const start = m.index ?? 0;
    out.set(c, (out.get(c) ?? false) || !isDenied(p, start, start + m[0].length));
  };
  for (const [c, r] of CRITERIA_WORDS) for (const m of p.matchAll(globally(r))) note(c, m);
  const count = (kind: 'rooms' | 'bedrooms', r: RegExp): void => {
    for (const m of p.matchAll(r)) {
      const n = Number(m[1] ?? m[2]);
      if (n >= 1 && n <= 20) note(`${kind}:${n}`, m);
    }
  };
  count('rooms', /\b(?:(\d{1,2}) pieces?|[tf](\d{1,2}))\b/g);
  count('bedrooms', /\b(\d{1,2}) chambres?\b/g);
  return out;
}

function criteriaOf(p: string): Criterion[] {
  const found = [...mentionedCriteria(p)].filter(([, affirmed]) => affirmed).map(([c]) => c);
  // Un seul nombre de pièces et de chambres : le premier affirmé.
  const first = (prefix: string): Criterion | undefined => found.find((c) => c.startsWith(prefix));
  const plainOnes = found.filter((c) => !c.startsWith('rooms:') && !c.startsWith('bedrooms:'));
  return [...plainOnes, first('rooms:'), first('bedrooms:')].filter((c): c is Criterion => c !== undefined);
}

export function isCriterion(value: unknown): value is Criterion {
  if (typeof value !== 'string') return false;
  if ((CRITERIA as readonly string[]).includes(value)) return true;
  const m = /^(rooms|bedrooms):(\d{1,2})$/.exec(value);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 20;
}

export interface QualifyRulesOptions extends ClassifyContext {
  communes?: readonly string[];
}

/** Classe et extrait par règles fixes, sans IA. */
export function qualifyByRules(text: string, options: QualifyRulesOptions = {}): Qualified {
  const p = plain(text);
  const category = classifyByRules(text, options);
  // Le budget ou le prix : jamais l'apport, les frais ni un revenu ; un montant nommé « budget » ou « prix » d'abord.
  const mentions = moneyMentions(text).filter((m) => !isOtherMoney(m.before));
  const labelled = mentions.filter((m) => LABELLED_MONEY.test(m.before));
  const amounts = (labelled.length > 0 && !/\bentre\b/.test(p) ? labelled : mentions).map((m) => m.amount);
  const range = /\bentre\b/.test(p) && amounts.length >= 2;
  const seller = category === 'seller' || category === 'valuation';
  const wantsAmount = category === 'buyer' || category === 'seller' || category === 'rent_out' || category === 'professional';
  const min = range ? Math.min(amounts[0]!, amounts[1]!) : null;
  const max = range ? Math.max(amounts[0]!, amounts[1]!) : (amounts[0] ?? null);
  return {
    category,
    route: routeOf(category, p),
    city: findCommune(text, options.communes),
    budgetMinEur: wantsAmount && !seller ? min : null,
    budgetMaxEur: wantsAmount && !seller ? max : null,
    priceEur: wantsAmount && seller ? max : null,
    deadline: deadlineOf(p),
    financing: category === 'spam' || category === 'partner' ? null : declaredFinancing(text),
    criteria: category === 'spam' || category === 'partner' ? [] : criteriaOf(p),
  };
}

export type AiRefusal = { rule: 'R23' | 'R24' | 'R10'; reason: string };

const isAmount = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);

/**
 * Vérifie la sortie de l'IA : exactement les champs prévus [R23], un financement seulement s'il est déclaré tel quel
 * dans le message [R24], des montants présents dans le message [R10]. Rend la qualification, ou la raison du refus,
 * sans jamais reprendre le texte reçu.
 */
export function checkAiQualification(raw: unknown, text: string, communes: readonly string[] = DEFAULT_COMMUNES): Qualified | AiRefusal {
  const r23 = (reason: string): AiRefusal => ({ rule: 'R23', reason });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return r23('Sortie de l’IA illisible.');
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.some((k) => !(QUALIFIED_KEYS as readonly string[]).includes(k))) return r23('Champ non prévu dans la sortie de l’IA.');
  if (QUALIFIED_KEYS.some((k) => !(k in o))) return r23('Champ manquant dans la sortie de l’IA.');
  if (!(CATEGORIES as readonly unknown[]).includes(o.category)) return r23('Catégorie inconnue.');
  if (o.route !== null && !(ROUTES as readonly unknown[]).includes(o.route)) return r23('Module de suite inconnu.');
  if (o.deadline !== null && !(DEADLINES as readonly unknown[]).includes(o.deadline)) return r23('Délai inconnu.');
  if (o.financing !== null && !(FINANCINGS as readonly unknown[]).includes(o.financing)) return r23('Financement inconnu.');
  if (o.city !== null && !(typeof o.city === 'string' && communes.includes(o.city))) return r23('Commune hors de la liste.');
  if (!Array.isArray(o.criteria) || !o.criteria.every(isCriterion)) return r23('Critère hors de la liste.');
  if (!isAmount(o.budgetMinEur) || !isAmount(o.budgetMaxEur) || !isAmount(o.priceEur)) return r23('Montant mal formé.');
  if (o.financing !== null && o.financing !== declaredFinancing(text)) {
    return { rule: 'R24', reason: 'Financement non déclaré par la personne : jamais évalué.' };
  }
  // Un critère que le message nie n'est pas un critère de la personne : l'IA n'en décide pas.
  const mentioned = mentionedCriteria(plain(text));
  if (o.criteria.some((c: Criterion) => mentioned.get(c) === false)) return r23('Critère nié par le message.');
  // Seulement les montants du message, et ceux qui peuvent être un budget ou un prix : une surface, un nombre de
  // pièces, l'apport ou les frais n'en sont pas.
  const inText = new Set(budgetAmountsIn(text));
  if ([o.budgetMinEur, o.budgetMaxEur, o.priceEur].some((v) => v !== null && !inText.has(v as number))) {
    return { rule: 'R10', reason: 'Montant absent du message.' };
  }
  return {
    category: o.category as Category,
    route: o.route as Route | null,
    city: o.city as string | null,
    budgetMinEur: o.budgetMinEur as number | null,
    budgetMaxEur: o.budgetMaxEur as number | null,
    priceEur: o.priceEur as number | null,
    deadline: o.deadline as Deadline | null,
    financing: o.financing as Financing | null,
    criteria: [...new Set(o.criteria as Criterion[])],
  };
}

/** Le projet que la qualification ouvre ou complète ; aucun pour un partenaire, une curiosité, un indésirable. */
export function projectKindOf(q: Pick<Qualified, 'category' | 'route'>, text: string): ProjectKind | null {
  switch (q.category) {
    case 'seller':
      return 'sell';
    case 'valuation':
      return 'valuation';
    case 'rent_out':
      return 'rent_out';
    case 'buyer':
      return q.route === 'M15' ? 'rent' : q.route === 'M17' ? 'invest' : 'buy';
    case 'professional':
      return /\b(?:ceder|cession|vente|vendre|vends|reprise de (?:mon|ma|notre))\b/.test(plain(text)) ? 'sell_business' : 'buy_business';
    default:
      return null;
  }
}

const SIGN_OFF = /\n\s*(?:cordialement|bien [aà] (?:vous|toi)|bonne (?:journ[eé]e|soir[eé]e)|merci d['’]avance|merci par avance|[aà] bient[oô]t|salutations)\b[\s\S]*$/iu;
const SELF_NAMED = /\b([Jj]e m['’]appelle|[Jj]e me nomme|[Jj]e suis|[Mm]oi c['’]est|[Cc]['’]est|[Ii]ci)(\s+)(\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)*)/gu;

/**
 * Le texte que l'IA peut lire pour qualifier : sans les noms connus de la fiche, sans le nom que la personne se
 * donne (« je suis Zoé Exemple »), sans la signature après une formule de fin [R15]. Les communes restent.
 */
export function withoutNames(text: string, knownNames: readonly string[], communes: readonly string[] = DEFAULT_COMMUNES): string {
  let out = text.normalize('NFC');
  const cut = SIGN_OFF.exec(out);
  if (cut) out = out.slice(0, cut.index);
  const isCommune = (words: string): boolean => communes.some((c) => communeKey(c) === communeKey(words));
  out = out.replace(SELF_NAMED, (all: string, intro: string, space: string, name: string) => (isCommune(name) ? all : `${intro}${space}[nom]`));
  for (const name of knownNames) {
    const n = name.normalize('NFC').trim();
    if (n.length < 2 || isCommune(n)) continue;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\p{L}])${escaped}(?=$|[^\\p{L}])`, 'giu'), '$1[nom]');
  }
  return out.trim();
}
