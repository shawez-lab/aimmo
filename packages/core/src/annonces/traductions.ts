/**
 * Annonces dans plusieurs langues, pour les acheteurs et les portails étrangers (Phase 3, HX05) [R257, R258, R259].
 *
 * Chaque annonce française validée par l'agent (P03) peut exister en anglais, et dans chaque langue que l'agent du bien
 * déclare parler, dans une liste fermée : ourdou, hindi, pendjabi (gurmukhi), persan, arabe, grec, et depuis AU069
 * allemand, espagnol, italien et néerlandais. Chaque langue ne s'ouvre que pour l'agent qui la déclare, ou le relecteur
 * désigné : le réseau se règle selon les langues de ses agents, avec la même validation et le même contrôle des chiffres.
 * Les quatre langues nouvelles sont rangées en base sous l'anglais, avec leur langue réelle à côté (migration 4115) ;
 * le code lit toujours la langue réelle.
 *
 * Décidé, lecture prudente :
 * - L'IA, derrière une interface, ne voit jamais les chiffres ni les lettres de classe énergie : le code les remplace
 *   par des repères `⟦1⟧`, `⟦2⟧`… qu'elle doit rendre chacun une fois, et le code remet lui-même les valeurs. Une IA
 *   qui perd, double ou invente un repère, ou qui écrit un chiffre, est refusée ; rien n'est gardé de son texte.
 * - Le contrôle final, le même pour l'IA et pour l'agent qui écrit sa traduction lui-même, exige dans le titre et dans
 *   le texte exactement les mêmes nombres, écrits pareil, et les mêmes lettres de classe ; aucun chiffre d'une autre
 *   écriture (arabe, persan, devanagari, gurmukhi), aucun nombre en lettres d'une liste fermée par langue, aucun lien,
 *   aucune adresse mail [R257].
 * - Les mentions légales et le prix ne sont jamais traduits : ils restent ceux de la version française publiée, au
 *   caractère près, calculés par le code (P02).
 * - Seul l'agent du bien valide, et seulement une langue qu'il déclare parler, ou le relecteur que la direction a désigné
 *   pour ce bien et cette langue, qui la déclare aussi ; l'anglais n'est plus ouvert d'office (AU113) ; seule la
 *   dernière traduction d'une langue compte, et seulement sur l'annonce française encore publiable : une nouvelle
 *   annonce française rend toutes ses traductions caduques [R258].
 * - Le flux des portails étrangers et la réponse à un acheteur étranger ne portent qu'une traduction validée et à
 *   jour [R259]. La réponse sort ici en texte seulement : elle partira par le contrôle central des envois quand elle
 *   sera branchée (R01 à R10).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { agentState } from '../acces/etat-agent.ts';
import { replyLanguage } from '../captation/premiere-reponse.ts';
import { publicTextProblems, sentences } from './annonce-sourcee.ts';
import { Annonces } from './annonces.ts';
import { dpeXml, surfacesXml, type PortalFormat } from './portails.ts';
import type { ListingPayload } from './publication.ts';

/** Les langues des annonces traduites. Le français est la langue source, jamais traduite. */
export const LISTING_LANGUAGES = ['en', 'de', 'es', 'it', 'nl', 'ur', 'hi', 'pa', 'fa', 'ar', 'el'] as const;
export type ListingLanguage = (typeof LISTING_LANGUAGES)[number];

export const LANGUAGE_NAMES: Readonly<Record<ListingLanguage, string>> = {
  en: 'anglais',
  de: 'allemand',
  es: 'espagnol',
  it: 'italien',
  nl: 'néerlandais',
  ur: 'ourdou',
  hi: 'hindi',
  pa: 'pendjabi',
  fa: 'persan',
  ar: 'arabe',
  el: 'grec',
};

/** Sens d'écriture, pour l'écran et les portails. */
export const RIGHT_TO_LEFT: ReadonlySet<ListingLanguage> = new Set(['ur', 'fa', 'ar']);

export const isListingLanguage = (v: unknown): v is ListingLanguage => typeof v === 'string' && (LISTING_LANGUAGES as readonly string[]).includes(v);

/** Les langues en lettres latines : un mot latin y est permis, sans venir du français. */
const LATIN_LANGUAGES: ReadonlySet<ListingLanguage> = new Set(['en', 'de', 'es', 'it', 'nl']);

/**
 * La langue sous laquelle une traduction ou un relecteur est rangé en base (migration 4115) : les quatre langues
 * ajoutées par AU069 sous l'anglais, leur langue réelle dans `language_code`.
 */
const STORED_UNDER: Readonly<Partial<Record<ListingLanguage, 'en'>>> = { de: 'en', es: 'en', it: 'en', nl: 'en' };
const storedLanguage = (l: ListingLanguage): string => STORED_UNDER[l] ?? l;

/** L'IA qui traduit : elle reçoit le titre et le texte avec des repères à la place des chiffres et des classes. */
export interface ListingTranslator {
  translate(input: { language: ListingLanguage; title: string; body: string }): Promise<{ title: string; body: string }>;
}

// ——— Contrôle [R257] ———

/** Un nombre écrit à la française : milliers séparés par une espace (ordinaire, fine ou insécable), ou décimale. */
const NUMBER = /\d{1,3}(?:[   ]\d{3})+(?![\d])|\d+(?:[.,]\d+)?/g;
/** Une lettre de classe énergie ou climat, seule. */
const CLASS_LETTER = /(?<![\p{L}\p{N}])[A-G](?![\p{L}\p{N}])/gu;
/**
 * En anglais, « A » en tête de phrase suivi d'un mot en minuscules est l'article, pas une classe ; en espagnol et en
 * italien, « A » et « E » ainsi placés sont une préposition ou « et ».
 */
const SENTENCE_WORD: Partial<Record<ListingLanguage, RegExp>> = {
  en: /(?:^|[.!?]\s+)A(?=\s+\p{Ll})/gu,
  es: /(?:^|[.!?]\s+)[AE](?=\s+\p{Ll})/gu,
  it: /(?:^|[.!?]\s+)[AE](?=\s+\p{Ll})/gu,
};
const ANY_DIGIT = /\p{Nd}/u;
const ASCII_DIGIT = /[0-9]/;
const MARKER = /⟦(\d+)⟧/g;
const LINK_OR_MAIL = /@|https?:|www\./i;

/**
 * Nombres en lettres, par langue : seuls les mots qui ne veulent rien dire d'autre (« one », « ένα », « دو » ou « नौ »
 * ont d'autres sens et n'y sont pas). C'est une garde de plus : l'IA ne voit aucun chiffre, et l'agent relit.
 */
const NUMBER_WORDS: Readonly<Record<ListingLanguage, readonly string[]>> = {
  de: ['zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'neun', 'zehn', 'elf', 'zwölf', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'hundert', 'tausend', 'million', 'millionen', 'dutzend', 'erste', 'zweite', 'dritte'],
  es: ['dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'cien', 'ciento', 'mil', 'millón', 'millones', 'docena', 'primero', 'primer', 'segundo', 'tercero', 'tercer'],
  it: ['due', 'tre', 'quattro', 'cinque', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'venti', 'trenta', 'quaranta', 'cinquanta', 'cento', 'mille', 'mila', 'milione', 'milioni', 'dozzina', 'primo', 'terzo'],
  nl: ['twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'negen', 'tien', 'elf', 'twaalf', 'twintig', 'dertig', 'veertig', 'vijftig', 'honderd', 'duizend', 'miljoen', 'dozijn', 'eerste', 'tweede', 'derde'],
  en: ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'thousand', 'million', 'dozen', 'first', 'second', 'third', 'fourth', 'fifth'],
  el: ['δύο', 'τρία', 'τρεις', 'τέσσερα', 'τέσσερις', 'πέντε', 'έξι', 'επτά', 'εφτά', 'οκτώ', 'οχτώ', 'εννέα', 'εννιά', 'δέκα', 'είκοσι', 'τριάντα', 'εκατό', 'χίλια', 'χιλιάδες', 'εκατομμύριο', 'εκατομμύρια'],
  ar: ['اثنان', 'اثنين', 'اثنتان', 'ثلاث', 'ثلاثة', 'أربع', 'أربعة', 'خمس', 'خمسة', 'ستة', 'سبع', 'سبعة', 'ثمانية', 'تسع', 'تسعة', 'عشرة', 'عشرون', 'عشرين', 'مائة', 'مئة', 'آلاف', 'مليون'],
  fa: ['سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'بیست', 'صد', 'هزار', 'میلیون'],
  ur: ['تین', 'چار', 'پانچ', 'چھ', 'سات', 'آٹھ', 'دس', 'بیس', 'ہزار', 'لاکھ', 'کروڑ'],
  hi: ['तीन', 'चार', 'पांच', 'पाँच', 'छह', 'सात', 'आठ', 'दस', 'बीस', 'हज़ार', 'हजार', 'लाख', 'करोड़'],
  pa: ['ਤਿੰਨ', 'ਚਾਰ', 'ਪੰਜ', 'ਛੇ', 'ਸੱਤ', 'ਅੱਠ', 'ਵੀਹ', 'ਹਜ਼ਾਰ', 'ਲੱਖ', 'ਕਰੋੜ'],
};

export type TranslationProblem =
  | 'texte_vide'
  | 'trop_long'
  | 'chiffre_manquant'
  | 'chiffre_ajoute'
  | 'chiffres_intervertis'
  | 'classes_interverties'
  | 'chiffre_autre_ecriture'
  | 'nombre_en_lettres'
  | 'classe_manquante'
  | 'classe_ajoutee'
  | 'lien_ou_mail'
  | 'adresse'
  | 'critere_discriminant'
  | 'mot_interdit'
  | 'mot_latin_sans_source';

/**
 * Ce qu'aucune annonce traduite ne peut porter, comme l'annonce française [R46] : une voie nommée, un critère
 * discriminant, un mot interdit. Listes fermées par langue, mots entiers ; le contrôle français (publicTextProblems)
 * s'applique en plus à chaque phrase, pour ce qui resterait écrit en français. Une garde de plus : l'IA ne reçoit que
 * l'annonce française déjà contrôlée, et l'agent relit avant de valider.
 */
const PUBLIC_TERMS: Readonly<Record<ListingLanguage, { adresse: readonly string[]; critere_discriminant: readonly string[]; mot_interdit: readonly string[] }>> = {
  en: {
    adresse: ['street', 'st', 'road', 'rd', 'avenue', 'ave', 'lane', 'boulevard', 'blvd', 'alley', 'quay', 'rue'],
    critere_discriminant: ['origin', 'ethnic', 'ethnicity', 'race', 'racial', 'religion', 'religious', 'christian', 'christians', 'muslim', 'muslims', 'jewish', 'jew', 'catholic', 'protestant', 'hindu', 'sikh', 'nationality', 'foreigner', 'foreigners', 'foreign', 'french only', 'disability', 'disabled', 'handicapped', 'no children', 'no kids', 'without children', 'children', 'kids', 'couple', 'couples', 'single', 'singles', 'retired', 'retiree', 'retirees', 'pensioner', 'pensioners', 'family', 'families', 'young', 'senior', 'seniors', 'elderly', 'age', 'aged', 'man', 'men', 'woman', 'women', 'gender', 'sex', 'orientation', 'pregnant', 'pregnancy', 'opinion', 'opinions', 'union', 'surname', 'appearance', 'reserved for', 'exclusively for', 'only for', 'ideal for', 'perfect for', 'french', 'european', 'african', 'asian', 'arab'],
    mot_interdit: ['free', 'ai', 'artificial intelligence', 'chatgpt', 'gpt', 'robot', 'bot', 'algorithm', 'generated', 'automatically'],
  },
  de: {
    adresse: ['straße', 'strasse', 'allee', 'gasse', 'chaussee', 'boulevard', 'rue'],
    critere_discriminant: ['religion', 'rasse', 'herkunft', 'nationalität', 'ausländer', 'kinder', 'kinderlos', 'familie', 'familien', 'paar', 'paare', 'rentner', 'senioren', 'frauen', 'männer', 'alter', 'geschlecht', 'muslime', 'christen', 'juden', 'ideal für', 'perfekt für', 'nur für'],
    mot_interdit: ['kostenlos', 'gratis', 'ki', 'künstliche intelligenz', 'roboter', 'algorithmus', 'automatisch'],
  },
  es: {
    adresse: ['calle', 'avenida', 'paseo', 'bulevar', 'callejón', 'rue'],
    critere_discriminant: ['religión', 'raza', 'origen', 'nacionalidad', 'extranjero', 'extranjeros', 'niños', 'familia', 'familias', 'pareja', 'parejas', 'jubilado', 'jubilados', 'mujeres', 'hombres', 'edad', 'musulmanes', 'cristianos', 'judíos', 'ideal para', 'perfecto para', 'solo para', 'sólo para'],
    mot_interdit: ['gratis', 'gratuito', 'ia', 'inteligencia artificial', 'robot', 'algoritmo', 'automáticamente'],
  },
  it: {
    adresse: ['viale', 'piazza', 'vicolo', 'lungomare', 'rue'],
    critere_discriminant: ['religione', 'razza', 'origine', 'nazionalità', 'stranieri', 'straniero', 'bambini', 'famiglia', 'famiglie', 'coppia', 'coppie', 'pensionato', 'pensionati', 'donne', 'uomini', 'età', 'musulmani', 'cristiani', 'ebrei', 'ideale per', 'perfetto per', 'solo per'],
    mot_interdit: ['gratis', 'gratuito', 'ia', 'intelligenza artificiale', 'robot', 'algoritmo', 'automaticamente'],
  },
  nl: {
    adresse: ['straat', 'laan', 'plein', 'steeg', 'gracht', 'rue'],
    critere_discriminant: ['religie', 'ras', 'afkomst', 'nationaliteit', 'buitenlanders', 'buitenlander', 'kinderen', 'gezin', 'gezinnen', 'gepensioneerd', 'gepensioneerden', 'vrouwen', 'mannen', 'leeftijd', 'moslims', 'christenen', 'joden', 'ideaal voor', 'perfect voor', 'alleen voor'],
    mot_interdit: ['gratis', 'ai', 'kunstmatige intelligentie', 'robot', 'algoritme', 'automatisch'],
  },
  el: {
    adresse: ['οδός', 'οδό', 'οδού', 'λεωφόρος', 'λεωφόρο', 'πλατεία', 'στενό'],
    critere_discriminant: ['θρησκεία', 'φυλή', 'εθνικότητα', 'παιδιά', 'οικογένεια', 'οικογένειες', 'ζευγάρι', 'συνταξιούχος', 'συνταξιούχοι', 'μουσουλμάνος', 'χριστιανός', 'εβραίος', 'ξένος', 'ξένοι', 'γυναίκα', 'γυναίκες', 'άνδρας', 'άνδρες', 'ηλικία'],
    mot_interdit: ['δωρεάν', 'ρομπότ', 'αλγόριθμος'],
  },
  ar: {
    adresse: ['شارع', 'طريق', 'زقاق', 'جادة', 'ساحة'],
    critere_discriminant: ['دين', 'عرق', 'جنسية', 'أطفال', 'عائلة', 'عائلات', 'مسلم', 'مسلمين', 'مسيحي', 'يهودي', 'أجنبي', 'أجانب', 'نساء', 'رجال', 'متقاعد', 'عمر'],
    mot_interdit: ['مجاني', 'مجانا', 'مجانًا', 'روبوت', 'خوارزمية'],
  },
  fa: {
    adresse: ['خیابان', 'کوچه', 'بلوار', 'میدان'],
    critere_discriminant: ['دین', 'مذهب', 'نژاد', 'ملیت', 'کودک', 'کودکان', 'بچه', 'خانواده', 'مسلمان', 'مسیحی', 'یهودی', 'خارجی', 'زنان', 'مردان', 'بازنشسته', 'سن'],
    mot_interdit: ['رایگان', 'ربات', 'الگوریتم'],
  },
  ur: {
    adresse: ['سڑک', 'گلی', 'شاہراہ', 'چوک'],
    critere_discriminant: ['مذہب', 'نسل', 'قومیت', 'بچے', 'بچوں', 'خاندان', 'مسلمان', 'عیسائی', 'یہودی', 'ہندو', 'غیر ملکی', 'خواتین', 'مرد', 'ریٹائرڈ', 'عمر'],
    mot_interdit: ['مفت', 'روبوٹ', 'الگورتھم'],
  },
  hi: {
    adresse: ['सड़क', 'गली', 'मार्ग', 'चौक'],
    critere_discriminant: ['धर्म', 'जाति', 'नस्ल', 'राष्ट्रीयता', 'बच्चे', 'बच्चों', 'परिवार', 'मुस्लिम', 'ईसाई', 'यहूदी', 'हिंदू', 'सिख', 'विदेशी', 'महिलाएं', 'पुरुष', 'सेवानिवृत्त', 'उम्र'],
    mot_interdit: ['मुफ्त', 'मुफ़्त', 'रोबोट', 'एल्गोरिदम'],
  },
  pa: {
    adresse: ['ਸੜਕ', 'ਗਲੀ', 'ਮਾਰਗ', 'ਚੌਕ'],
    critere_discriminant: ['ਧਰਮ', 'ਜਾਤ', 'ਨਸਲ', 'ਕੌਮੀਅਤ', 'ਬੱਚੇ', 'ਬੱਚਿਆਂ', 'ਪਰਿਵਾਰ', 'ਮੁਸਲਮਾਨ', 'ਈਸਾਈ', 'ਸਿੱਖ', 'ਹਿੰਦੂ', 'ਵਿਦੇਸ਼ੀ', 'ਔਰਤਾਂ', 'ਮਰਦ', 'ਉਮਰ'],
    mot_interdit: ['ਮੁਫ਼ਤ', 'ਮੁਫਤ', 'ਰੋਬੋਟ'],
  },
};

const fold = (t: string): string => t.normalize('NFC').toLowerCase();
/** Un terme entier (un ou plusieurs mots) dans le texte, sans être collé à une autre lettre. */
const hasTerm = (text: string, term: string): boolean => {
  const escaped = fold(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'u').test(fold(text));
};

/**
 * Les voies nommées que les mots entiers ne voient pas : en allemand et en néerlandais, le nom de la voie est soudé
 * (« Lindenstraße », « Kerkstraat ») ; en italien et en espagnol, « via », « corso » ou « plaza » ont d'autres sens et ne
 * désignent une voie que suivis d'un nom propre (« via Roma », « plaza Mayor », pas « plaza de garaje »). Un mot qui
 * finit par la voie et prend la majuscule d'un nom propre, ou ce mot suivi d'une majuscule, est refusé ; « Platz » et « weg » ne sont pas dans la liste, car
 * « Stellplatz » ou « Fußweg » ne nomment rien.
 */
const STREET_SUFFIXES: Partial<Record<ListingLanguage, readonly string[]>> = {
  de: ['straße', 'strasse', 'allee', 'gasse', 'chaussee', 'damm'],
  nl: ['straat', 'laan', 'plein', 'steeg', 'gracht', 'kade', 'singel'],
};
/** L'abréviation allemande soudée : « Lindenstr. ». */
const GERMAN_STR = /\p{L}str\.(?!\p{L})/u;
const STREET_BEFORE_NAME: Partial<Record<ListingLanguage, RegExp>> = {
  it: /(?<![\p{L}\p{M}])(?:[Vv]ia|[Vv]iale|[Cc]orso|[Pp]iazza|[Pp]iazzale|[Ll]argo|[Vv]icolo|[Ll]ungomare)\s+(?:(?:del|della|dei|degli|delle|di)\s+|d['’]\s*)?\p{Lu}/u,
  es: /(?<![\p{L}\p{M}])(?:[Cc]alle|[Aa]venida|[Pp]laza|[Pp]aseo|[Cc]amino|[Rr]onda|[Bb]ulevar|[Cc]allejón)\s+(?:(?:de|del|de la|de los|de las)\s+)?\p{Lu}/u,
};
function namesAStreet(text: string, language: ListingLanguage): boolean {
  const before = STREET_BEFORE_NAME[language];
  if (before?.test(text)) return true;
  if (language === 'de' && GERMAN_STR.test(text)) return true;
  const suffixes = STREET_SUFFIXES[language];
  if (!suffixes) return false;
  // Un nom de voie est un nom propre, qui prend la majuscule : « De deuren slaan open » ne nomme aucune « laan ».
  const names = text.normalize('NFC').match(/(?<![\p{L}\p{M}])\p{Lu}[\p{L}\p{M}]*/gu) ?? [];
  return names.some((w) => suffixes.some((x) => fold(w).endsWith(x)));
}

function publicProblems(source: string, translated: string, language: ListingLanguage): TranslationProblem[] {
  const out = new Set<TranslationProblem>();
  for (const sentence of sentences(translated)) for (const p of publicTextProblems(sentence)) out.add(p.code as TranslationProblem);
  const terms = PUBLIC_TERMS[language];
  for (const code of ['adresse', 'critere_discriminant', 'mot_interdit'] as const) if (terms[code].some((t) => hasTerm(translated, t))) out.add(code);
  if (namesAStreet(translated, language)) out.add('adresse');
  // Dans une langue d'une autre écriture, un mot en lettres latines ne peut être qu'un nom repris du français (Dijon) :
  // sinon, refusé.
  if (!LATIN_LANGUAGES.has(language)) {
    const known = new Set((fold(source).match(/\p{Script=Latin}+/gu) ?? []));
    if ((fold(translated).match(/\p{Script=Latin}+/gu) ?? []).some((w) => !known.has(w))) out.add('mot_latin_sans_source');
  }
  return [...out];
}

const MAX_TITLE = 160;
const MAX_BODY = 4000;

/** Une unité collée au nombre, qui doit le suivre aussi dans la traduction : « 62 m² » n'est jamais « 62 sq ft ». */
const UNIT_AFTER = /^[   ]?(m²|m2|€|%)/;

/** Les nombres, dans leur ordre, chacun avec son unité : intervertir « 3 pièces » et « 62 m² » est refusé. */
const numbersOf = (s: string): string[] =>
  [...s.matchAll(NUMBER)].map((m) => {
    const unit = UNIT_AFTER.exec(s.slice(m.index + m[0].length))?.[1] ?? '';
    return `${m[0].replace(/[  ]/g, ' ')}${unit === '' ? '' : ` ${unit === 'm2' ? 'm²' : unit}`}`;
  });
/** Les lettres de classe, dans leur ordre : « classe D, climat B » n'est jamais « classe B, climat D ». */
const classesOf = (s: string, language: ListingLanguage | 'fr'): string[] => {
  const word = language === 'fr' ? undefined : SENTENCE_WORD[language];
  const text = word ? s.replace(word, (m) => m.slice(0, -1)) : s;
  return text.match(CLASS_LETTER) ?? [];
};
const sameSequence = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Les éléments de `a` absents de `b`, comptés avec leurs répétitions. */
function missing(a: readonly string[], b: readonly string[]): string[] {
  const left = [...b];
  const out: string[] = [];
  for (const x of a) {
    const i = left.indexOf(x);
    if (i === -1) out.push(x);
    else left.splice(i, 1);
  }
  return out;
}

function checkField(source: string, translated: string, language: ListingLanguage, max: number): TranslationProblem[] {
  const problems: TranslationProblem[] = [];
  if (translated.trim() === '') return ['texte_vide'];
  if (translated.length > max) problems.push('trop_long');
  // Un chiffre d'une autre écriture n'est jamais « le même chiffre » : il est refusé, même de même valeur.
  if ([...translated].some((c) => ANY_DIGIT.test(c) && !ASCII_DIGIT.test(c))) problems.push('chiffre_autre_ecriture');
  const sn = numbersOf(source);
  const tn = numbersOf(translated);
  if (missing(sn, tn).length > 0) problems.push('chiffre_manquant');
  if (missing(tn, sn).length > 0) problems.push('chiffre_ajoute');
  if (!problems.includes('chiffre_manquant') && !problems.includes('chiffre_ajoute') && !sameSequence(sn, tn)) problems.push('chiffres_intervertis');
  const sc = classesOf(source, 'fr');
  const tc = classesOf(translated, language);
  if (missing(sc, tc).length > 0) problems.push('classe_manquante');
  if (missing(tc, sc).length > 0) problems.push('classe_ajoutee');
  if (!problems.includes('classe_manquante') && !problems.includes('classe_ajoutee') && !sameSequence(sc, tc)) problems.push('classes_interverties');
  const words = new Set((translated.toLowerCase().normalize('NFC').match(/[\p{L}\p{M}]+/gu) ?? []));
  if (NUMBER_WORDS[language].some((w) => words.has(w.normalize('NFC')))) problems.push('nombre_en_lettres');
  if (LINK_OR_MAIL.test(translated)) problems.push('lien_ou_mail');
  problems.push(...publicProblems(source, translated, language));
  return problems;
}

/**
 * Le contrôle d'une traduction [R257] : mêmes nombres écrits pareil, mêmes lettres de classe, dans le titre et dans le
 * texte, rien d'autre. Rend la liste des problèmes ; vide, la traduction passe.
 */
export function controlTranslation(source: { title: string; body: string }, translated: { title: string; body: string }, language: ListingLanguage): { ok: boolean; title: TranslationProblem[]; body: TranslationProblem[] } {
  const title = checkField(source.title, translated.title, language, MAX_TITLE);
  const body = checkField(source.body, translated.body, language, MAX_BODY);
  return { ok: title.length === 0 && body.length === 0, title, body };
}

/** Le texte français avec des repères à la place des nombres et des classes, et la table pour les remettre. */
export function maskFigures(text: string, values: string[]): string {
  const PROTECTED = new RegExp(`${NUMBER.source}|${CLASS_LETTER.source}`, 'gu');
  return text.replace(PROTECTED, (m) => {
    values.push(m);
    return `⟦${values.length}⟧`;
  });
}

/** Remet les valeurs à la place des repères ; null si un repère manque, revient deux fois, est inconnu, ou si l'IA a écrit un chiffre. */
export function unmaskFigures(text: string, values: readonly string[], expected: readonly number[]): string | null {
  // Chaque repère une fois, et dans l'ordre du français : des repères intervertis échangeraient des chiffres.
  const seen = [...text.matchAll(MARKER)].map((m) => Number(m[1]));
  if (!sameSequence(seen.map(String), expected.map(String))) return null;
  const rest = text.replace(MARKER, '');
  if (ANY_DIGIT.test(rest) || /[⟦⟧]/.test(rest)) return null;
  return text.replace(MARKER, (_, n: string) => values[Number(n) - 1]!);
}

// ——— Langue de l'acheteur ———

const URDU_ONLY = /[ٹڈڑںےۓھ]/;
const PERSIAN_OR_URDU = /[پچژگیک]/;

/**
 * La langue de l'acheteur : celle de sa fiche si elle est de la liste, sinon devinée de l'écriture de son message
 * (grec, devanagari, gurmukhi, alphabet arabe : lettres propres à l'ourdou, puis au persan, sinon arabe), sinon
 * l'anglais ou le français comme la première réponse (C04).
 */
export function buyerLanguage(personLanguage: string | null, text: string): ListingLanguage | 'fr' {
  if (isListingLanguage(personLanguage)) return personLanguage;
  if (personLanguage === 'fr') return 'fr';
  if (/\p{Script=Greek}/u.test(text)) return 'el';
  if (/\p{Script=Gurmukhi}/u.test(text)) return 'pa';
  if (/\p{Script=Devanagari}/u.test(text)) return 'hi';
  if (/\p{Script=Arabic}/u.test(text)) return URDU_ONLY.test(text) ? 'ur' : PERSIAN_OR_URDU.test(text) ? 'fa' : 'ar';
  return replyLanguage(null, text);
}

// ——— Traductions rangées ———

export interface ListingTranslation {
  id: string;
  propertyId: string;
  draftId: string;
  language: ListingLanguage;
  seq: number;
  title: string;
  body: string;
  origin: 'ia' | 'agent';
  createdBy: string;
  createdAt: string;
  validated: { by: string; at: string } | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: null; code: 'unknown_property' | 'unknown_translation' | 'no_listing' | 'bad_text' | 'bad_languages' | 'busy' | 'no_translator' | 'ia_indisponible' }
  | { ok: false; rule: 'R257'; code: 'refused_text'; title: TranslationProblem[]; body: TranslationProblem[] }
  | { ok: false; rule: 'R257'; code: 'ia_refusee' }
  | { ok: false; rule: 'R258'; code: 'langue_non_parlee' | 'not_latest' | 'stale_listing' | 'already_validated' };

interface TranslationRow {
  id: string;
  property_id: string;
  draft_id: string;
  language: ListingLanguage;
  seq: number;
  title: string;
  body: string;
  origin: 'ia' | 'agent';
  created_by: string;
  created_at: string;
  validated_by: string | null;
  validated_at: string | null;
  network_id: string;
}

/** La langue réelle d'une ligne (migration 4115). */
const T_LANGUAGE = 'COALESCE(t.language_code, t.language)';
const SELECT = `SELECT t.id, t.property_id, t.draft_id, ${T_LANGUAGE} AS language, t.seq, t.title, t.body, t.origin, t.created_by, t.created_at, t.network_id,
  v.validated_by, v.validated_at FROM listing_translations t LEFT JOIN listing_translation_validations v ON v.translation_id = t.id`;

const toTranslation = (r: TranslationRow): ListingTranslation => ({
  id: r.id,
  propertyId: r.property_id,
  draftId: r.draft_id,
  language: r.language,
  seq: Number(r.seq),
  title: r.title,
  body: r.body,
  origin: r.origin,
  createdBy: r.created_by,
  createdAt: r.created_at,
  validated: r.validated_by && r.validated_at ? { by: r.validated_by, at: r.validated_at } : null,
});

const AI_TIMEOUT_MS = 20_000;

export class AnnoncesTraduites {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly translator: ListingTranslator | null;
  private readonly timeoutMs: number;
  private readonly annonces: Annonces;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; translator?: ListingTranslator; timeoutMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.translator = options.translator ?? null;
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
    this.annonces = new Annonces(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'listing_translation', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  // ——— Langues de l'agent ———

  /** Les langues que l'agent déclare parler, de la liste fermée : la dernière déclaration fait foi. */
  async languagesOf(networkId: string, agentId: string): Promise<ListingLanguage[]> {
    const row = await this.db.first<{ languages: string }>('SELECT languages FROM agent_language_declarations WHERE network_id = ? AND agent_id = ? ORDER BY seq DESC LIMIT 1', [networkId, agentId]);
    if (!row) return [];
    const parsed = JSON.parse(row.languages) as unknown[];
    return LISTING_LANGUAGES.filter((l) => parsed.includes(l));
  }

  /** L'agent déclare ses langues, ou la direction pour lui. Une nouvelle déclaration remplace la précédente, gardée. */
  async declareLanguages(viewer: Viewer, agentId: string, languages: unknown): Promise<{ ok: true; value: ListingLanguage[] } | Refusal | Problem> {
    const subject = `agent:${agentId}`;
    if (!(viewer.role === 'direction' || (viewer.role === 'agent' && viewer.userId === agentId))) return this.refuse(viewer, subject, 'role');
    const agent = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [agentId, viewer.networkId]);
    if (!agent) return this.refuse(viewer, subject, 'unknown');
    if (!Array.isArray(languages) || languages.length > LISTING_LANGUAGES.length || !languages.every(isListingLanguage)) return { ok: false, rule: null, code: 'bad_languages' };
    const value = LISTING_LANGUAGES.filter((l) => languages.includes(l));
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.db.run(
          `INSERT INTO agent_language_declarations (id, network_id, agent_id, seq, languages, declared_by, declared_at)
           SELECT ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM agent_language_declarations WHERE agent_id = ?`,
          [this.newId(), viewer.networkId, agentId, JSON.stringify(value), this.actor(viewer), this.now().toISOString(), agentId],
        );
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      await appendEvent(this.journal, { type: 'agent.langues', actor: this.actor(viewer), subject, data: { rule: 'R258', languages: value } }, this.now);
      return { ok: true, value };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  /**
   * Les langues ouvertes pour un bien : celles que parle son agent, et celles où la direction a désigné un relecteur qui
   * la déclare toujours. L'anglais n'est plus ouvert d'office : il faut une compétence déclarée ou un relecteur (AU113).
   */
  async languagesFor(networkId: string, agentId: string | null, propertyId?: string): Promise<ListingLanguage[]> {
    const spoken = agentId ? await this.languagesOf(networkId, agentId) : [];
    const reviewed = propertyId ? [...(await this.reviewers(networkId, propertyId)).keys()] : [];
    return LISTING_LANGUAGES.filter((l) => spoken.includes(l) || reviewed.includes(l));
  }

  /**
   * Celui qui a validé compte-t-il encore pour cette langue (AU113) [R258] ? L'agent du bien qui la déclare toujours, ou
   * le relecteur toujours désigné pour ce bien et cette langue. Un relecteur retiré ou remplacé : la validation tombe.
   */
  private async stillQualified(networkId: string, agentId: string | null, propertyId: string, language: ListingLanguage, by: string): Promise<boolean> {
    const m = /^agent:(.+)$/.exec(by);
    if (!m) return false;
    const who = m[1]!;
    if (who === agentId && (await this.languagesOf(networkId, who)).includes(language)) return true;
    return (await this.reviewers(networkId, propertyId)).get(language) === who;
  }

  /** Les relecteurs désignés d'un bien, par langue : seulement ceux qui déclarent toujours la langue et sont en activité. */
  async reviewers(networkId: string, propertyId: string): Promise<Map<ListingLanguage, string>> {
    const rows = await this.db.all<{ language: ListingLanguage; reviewer_agent_id: string | null }>(
      `SELECT COALESCE(r.language_code, r.language) AS language, r.reviewer_agent_id FROM translation_reviewers r
       WHERE r.network_id = ? AND r.property_id = ? AND r.seq = (SELECT MAX(x.seq) FROM translation_reviewers x
         WHERE x.property_id = r.property_id AND COALESCE(x.language_code, x.language) = COALESCE(r.language_code, r.language))`,
      [networkId, propertyId],
    );
    const out = new Map<ListingLanguage, string>();
    for (const r of rows) {
      if (!r.reviewer_agent_id) continue;
      // Un relecteur parti (même le jour de son départ, avant le passage du planificateur) ou au dossier incomplet ne relit plus [R86].
      if ((await agentState(this.db, networkId, r.reviewer_agent_id, this.now())) === 'actif' && (await this.languagesOf(networkId, r.reviewer_agent_id)).includes(r.language)) out.set(r.language, r.reviewer_agent_id);
    }
    return out;
  }

  /**
   * La direction désigne, pour un bien et une langue, un relecteur : un agent du réseau en activité qui déclare la langue
   * (AU113). Lui seul valide alors les traductions de cette langue que l'agent du bien ne parle pas. `null` le retire.
   */
  async designateReviewer(viewer: Viewer, propertyId: string, language: unknown, reviewerAgentId: unknown): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `property:${propertyId}`, 'role');
    const p = await this.db.first<{ id: string }>('SELECT id FROM properties WHERE id = ? AND network_id = ?', [propertyId, viewer.networkId]);
    if (!p) return { ok: false, rule: null, code: 'unknown_property' };
    if (!isListingLanguage(language)) return { ok: false, rule: null, code: 'bad_languages' };
    if (reviewerAgentId !== null) {
      if (typeof reviewerAgentId !== 'string') return { ok: false, rule: null, code: 'bad_languages' };
      const a = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [reviewerAgentId, viewer.networkId]);
      if (a?.status !== 'active' || !(await this.languagesOf(viewer.networkId, reviewerAgentId)).includes(language)) return { ok: false, rule: 'R258', code: 'langue_non_parlee' };
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.db.run(
          `INSERT INTO translation_reviewers (id, network_id, property_id, language, language_code, seq, reviewer_agent_id, designated_by, designated_at)
           SELECT ?, ?, ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM translation_reviewers WHERE property_id = ? AND language = ?`,
          [this.newId(), viewer.networkId, propertyId, storedLanguage(language), language, reviewerAgentId, this.actor(viewer), this.now().toISOString(), propertyId, storedLanguage(language)],
        );
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      await appendEvent(this.journal, { type: 'annonce.relecteur', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R258', language, designated: reviewerAgentId !== null } }, this.now);
      return { ok: true };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  // ——— Brouillons de traduction ———

  /** Le bien, lisible en entier par ce lecteur ; seuls l'agent du bien et la direction écrivent, seul l'agent valide. */
  private async gate(viewer: Viewer, propertyId: string, need: 'read' | 'write' | 'validate'): Promise<{ ok: true; networkId: string; agentId: string | null } | Refusal | Problem> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.value.network_id !== viewer.networkId) return this.refuse(viewer, `property:${propertyId}`, 'other_network');
    if (p.view !== 'full') return this.refuse(viewer, `property:${propertyId}`, 'not_assigned');
    if (need === 'write' && viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, `property:${propertyId}`, 'role');
    if (need === 'validate' && (viewer.role !== 'agent' || p.value.agent_id !== viewer.userId)) return this.refuse(viewer, `property:${propertyId}`, 'role');
    return { ok: true, networkId: p.value.network_id, agentId: p.value.agent_id };
  }

  private async store(viewer: Viewer, networkId: string, propertyId: string, draftId: string, language: ListingLanguage, text: { title: string; body: string }, origin: 'ia' | 'agent'): Promise<ListingTranslation | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.newId();
      try {
        await this.db.run(
          `INSERT INTO listing_translations (id, property_id, network_id, draft_id, language, language_code, seq, title, body, origin, created_by, created_at)
           SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ? FROM listing_translations WHERE property_id = ? AND language = ?`,
          [id, propertyId, networkId, draftId, storedLanguage(language), language, text.title, text.body, origin, this.actor(viewer), this.now().toISOString(), propertyId, storedLanguage(language)],
        );
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      const row = await this.db.first<TranslationRow>(`${SELECT} WHERE t.id = ?`, [id]);
      if (!row) continue;
      const t = toTranslation(row);
      await appendEvent(this.journal, { type: 'annonce.traduction', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R257', language, seq: t.seq, origin } }, this.now);
      return t;
    }
    return null;
  }

  /** L'IA traduit ; une panne, un délai dépassé ou une réponse hors format rend sa raison, jamais son texte d'erreur. */
  private async askTranslator(translator: ListingTranslator, language: ListingLanguage, masked: { title: string; body: string }): Promise<{ title: string; body: string } | { failure: 'panne' | 'delai' | 'hors_format' }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = Symbol('delai');
    try {
      const out = await Promise.race([
        translator.translate({ language, title: masked.title, body: masked.body }),
        new Promise<typeof late>((resolve) => {
          timer = setTimeout(() => resolve(late), this.timeoutMs);
        }),
      ]);
      if (out === late) return { failure: 'delai' };
      if (!out || typeof out.title !== 'string' || typeof out.body !== 'string') return { failure: 'hors_format' };
      return { title: out.title.trim(), body: out.body.trim() };
    } catch {
      return { failure: 'panne' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** L'annonce française encore publiable du bien, d'où part toute traduction. */
  private async source(networkId: string, propertyId: string) {
    return this.annonces.publishable(networkId, propertyId);
  }

  /**
   * L'IA traduit l'annonce française publiable dans une langue ouverte pour le bien. Les chiffres et les classes ne lui
   * sont jamais montrés ; son texte est contrôlé, et un texte refusé n'est pas gardé.
   */
  async propose(viewer: Viewer, propertyId: string, language: unknown): Promise<{ ok: true; value: ListingTranslation } | Refusal | Problem> {
    const g = await this.gate(viewer, propertyId, 'write');
    if (!g.ok) return g;
    if (!isListingLanguage(language) || !(await this.languagesFor(g.networkId, g.agentId, propertyId)).includes(language)) return { ok: false, rule: 'R258', code: 'langue_non_parlee' };
    const draft = await this.source(g.networkId, propertyId);
    if (!draft) return { ok: false, rule: null, code: 'no_listing' };
    if (!this.translator) return { ok: false, rule: null, code: 'no_translator' };
    const values: string[] = [];
    const title = maskFigures(draft.title, values);
    const titleMarkers = values.map((_, i) => i + 1);
    const body = maskFigures(draft.body, values);
    const bodyMarkers = values.map((_, i) => i + 1).slice(titleMarkers.length);
    const out = await this.askTranslator(this.translator, language, { title, body });
    if ('failure' in out) {
      // Au journal : la langue et la raison seulement, jamais le texte ni l'erreur du fournisseur [R13].
      await appendEvent(this.journal, { type: 'annonce.traduction_ia_indisponible', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R257', language, reason: out.failure } }, this.now);
      return { ok: false, rule: null, code: 'ia_indisponible' };
    }
    const t = unmaskFigures(out.title, values, titleMarkers);
    const b = unmaskFigures(out.body, values, bodyMarkers);
    const control = t !== null && b !== null ? controlTranslation(draft, { title: t, body: b }, language) : null;
    if (t === null || b === null || !control?.ok) {
      // Au journal : la langue et les codes seulement, jamais le texte [R13].
      const codes = control ? [...new Set([...control.title, ...control.body])] : ['reperes'];
      await appendEvent(this.journal, { type: 'annonce.traduction_ia_refusee', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R257', language, codes } }, this.now);
      return { ok: false, rule: 'R257', code: 'ia_refusee' };
    }
    const stored = await this.store(viewer, g.networkId, propertyId, draft.id, language, { title: t, body: b }, 'ia');
    return stored ? { ok: true, value: stored } : { ok: false, rule: null, code: 'busy' };
  }

  /** L'agent écrit ou corrige la traduction lui-même : elle passe le même contrôle. */
  async correct(viewer: Viewer, propertyId: string, language: unknown, text: { title: unknown; body: unknown }): Promise<{ ok: true; value: ListingTranslation } | Refusal | Problem> {
    const g = await this.gate(viewer, propertyId, 'write');
    if (!g.ok) return g;
    if (!isListingLanguage(language) || !(await this.languagesFor(g.networkId, g.agentId, propertyId)).includes(language)) return { ok: false, rule: 'R258', code: 'langue_non_parlee' };
    if (typeof text.title !== 'string' || typeof text.body !== 'string') return { ok: false, rule: null, code: 'bad_text' };
    const draft = await this.source(g.networkId, propertyId);
    if (!draft) return { ok: false, rule: null, code: 'no_listing' };
    const value = { title: text.title.trim(), body: text.body.trim() };
    const control = controlTranslation(draft, value, language);
    if (!control.ok) {
      await appendEvent(this.journal, { type: 'annonce.traduction_refusee', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R257', language, codes: [...new Set([...control.title, ...control.body])] } }, this.now);
      return { ok: false, rule: 'R257', code: 'refused_text', title: control.title, body: control.body };
    }
    const stored = await this.store(viewer, g.networkId, propertyId, draft.id, language, value, 'agent');
    return stored ? { ok: true, value: stored } : { ok: false, rule: null, code: 'busy' };
  }

  /** La dernière traduction du bien dans une langue, avec sa validation. */
  async read(viewer: Viewer, propertyId: string, language: unknown): Promise<{ ok: true; value: ListingTranslation | null } | Refusal | Problem> {
    // AU113 · le relecteur désigné lit la traduction de sa langue sur ce bien, et elle seule, pour la relire.
    const reviewing = viewer.role === 'agent' && isListingLanguage(language) && (await this.reviewers(viewer.networkId, propertyId)).get(language) === viewer.userId;
    if (!reviewing) {
      const g = await this.gate(viewer, propertyId, 'read');
      if (!g.ok) return g;
    } else {
      // La lecture du relecteur s'écrit au journal comme toute lecture d'un bien, avant de rendre le texte [R16].
      await appendEvent(this.journal, { type: 'bien.lu', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: 'agent', view: 'relecteur', language: language as string } }, this.now);
    }
    if (!isListingLanguage(language)) return { ok: false, rule: 'R258', code: 'langue_non_parlee' };
    const row = await this.db.first<TranslationRow>(`${SELECT} WHERE t.property_id = ? AND ${T_LANGUAGE} = ? ORDER BY t.seq DESC LIMIT 1`, [propertyId, language]);
    return { ok: true, value: row ? toTranslation(row) : null };
  }

  /**
   * L'agent du bien valide la dernière traduction d'une langue qu'il parle, ou le relecteur désigné (AU113) [R258], faite sur
   * l'annonce française encore publiable, et qui passe encore le contrôle [R257].
   */
  async validate(viewer: Viewer, translationId: string): Promise<{ ok: true; value: ListingTranslation } | Refusal | Problem> {
    const row = await this.db.first<TranslationRow>(`${SELECT} WHERE t.id = ?`, [translationId]);
    if (!row || row.network_id !== viewer.networkId) {
      await this.refuse(viewer, `listing_translation:${translationId}`, 'unknown');
      return { ok: false, rule: null, code: 'unknown_translation' };
    }
    const t = toTranslation(row);
    // AU113 · valide l'agent du bien qui parle la langue, ou le relecteur que la direction a désigné pour ce bien et cette langue.
    const reviewer = (await this.reviewers(viewer.networkId, row.property_id)).get(t.language);
    let g: { ok: true; networkId: string; agentId: string | null } | Refusal | Problem;
    if (viewer.role === 'agent' && reviewer === viewer.userId) {
      const p = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ? AND network_id = ?', [row.property_id, viewer.networkId]);
      g = { ok: true, networkId: viewer.networkId, agentId: p?.agent_id ?? null };
    } else {
      g = await this.gate(viewer, row.property_id, 'validate');
      if (!g.ok) return g;
      if (!(await this.languagesOf(g.networkId, viewer.userId)).includes(t.language)) return { ok: false, rule: 'R258', code: 'langue_non_parlee' };
    }
    if (t.validated) return { ok: false, rule: 'R258', code: 'already_validated' };
    const latest = await this.db.first<{ id: string }>('SELECT id FROM listing_translations WHERE property_id = ? AND COALESCE(language_code, language) = ? ORDER BY seq DESC LIMIT 1', [t.propertyId, t.language]);
    if (latest?.id !== t.id) return { ok: false, rule: 'R258', code: 'not_latest' };
    const draft = await this.source(g.networkId, t.propertyId);
    if (!draft || draft.id !== t.draftId) return { ok: false, rule: 'R258', code: 'stale_listing' };
    const control = controlTranslation(draft, t, t.language);
    if (!control.ok) return { ok: false, rule: 'R257', code: 'refused_text', title: control.title, body: control.body };
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      'INSERT INTO listing_translation_validations (translation_id, property_id, network_id, validated_by, validated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (translation_id) DO NOTHING',
      [t.id, t.propertyId, g.networkId, this.actor(viewer), at],
    );
    if (changes !== 1) return { ok: false, rule: 'R258', code: 'already_validated' };
    await appendEvent(this.journal, { type: 'annonce.traduction_validee', actor: this.actor(viewer), subject: `property:${t.propertyId}`, data: { rule: 'R258', language: t.language, seq: t.seq } }, this.now);
    return { ok: true, value: { ...t, validated: { by: this.actor(viewer), at } } };
  }

  /**
   * Pour le système : la traduction à montrer dans une langue, ou null. Seule la dernière de la langue compte, validée,
   * sur ce brouillon français précis, qui passe encore le contrôle, et dans une langue que l'agent du bien parle encore.
   */
  async current(networkId: string, propertyId: string, draft: { id: string; title: string; body: string }, language: ListingLanguage): Promise<ListingTranslation | null> {
    const row = await this.db.first<TranslationRow>(`${SELECT} WHERE t.property_id = ? AND ${T_LANGUAGE} = ? ORDER BY t.seq DESC LIMIT 1`, [propertyId, language]);
    if (!row || row.network_id !== networkId) return null;
    const t = toTranslation(row);
    if (!t.validated || t.draftId !== draft.id) return null;
    const property = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ? AND network_id = ?', [propertyId, networkId]);
    if (!property || !(await this.stillQualified(networkId, property.agent_id, propertyId, language, t.validated.by))) return null;
    return controlTranslation(draft, t, language).ok ? t : null;
  }

  /**
   * L'annonce à répondre à un acheteur étranger, dans sa langue [R259] : la traduction validée et à jour de la dernière
   * version publiée, encore en vente ou sous offre, sinon l'anglaise, sinon rien (la réponse reste en français). Le prix,
   * les mentions et la version sont ceux de la version publiée, jamais traduits.
   */
  async forBuyer(networkId: string, propertyId: string, language: ListingLanguage | 'fr'): Promise<{ language: ListingLanguage; title: string; body: string; rightToLeft: boolean; priceEur: number; mentions: string; version: number } | null> {
    if (language === 'fr') return null;
    const published = await publishedListing(this.db, networkId, propertyId);
    if (!published) return null;
    for (const l of language === 'en' ? (['en'] as const) : ([language, 'en'] as const)) {
      const t = await this.current(networkId, propertyId, published.draft, l);
      if (t) return { language: l, title: t.title, body: t.body, rightToLeft: RIGHT_TO_LEFT.has(l), priceEur: published.listing.priceEur, mentions: published.listing.mentions, version: published.listing.version };
    }
    return null;
  }

  /**
   * L'annonce à joindre à la première réponse d'un acheteur (C04, RC34) [R259] : dans la langue de sa fiche, sinon de
   * l'écriture de son message, sinon en anglais ; rien s'il écrit en français ou si aucune traduction n'est à jour.
   */
  async forBuyerMessage(networkId: string, propertyId: string, personLanguage: string | null, text: string) {
    return this.forBuyer(networkId, propertyId, buyerLanguage(personLanguage, text));
  }
}

const ON_PORTALS = new Set(['en_vente', 'sous_offre']);

type Published = { listing: ListingPayload & { priceEur: number; mentions: string; title: string; body: string }; draft: { id: string; title: string; body: string } };

/** La dernière version publiée d'un bien, si elle est encore en vente ou sous offre, complète, et tirée d'une annonce. */
function toPublished(r: { seq: number; payload: string; draft_id: string | null }): Published | null {
  const l = { ...(JSON.parse(r.payload) as Omit<ListingPayload, 'version'>), version: Number(r.seq) };
  if (!ON_PORTALS.has(l.state) || l.priceEur === null || l.mentions === null || l.title === null || l.body === null || !r.draft_id) return null;
  return { listing: l as Published['listing'], draft: { id: r.draft_id, title: l.title, body: l.body } };
}

async function publishedListing(db: SqlDatabase, networkId: string, propertyId: string): Promise<Published | null> {
  const r = await db.first<{ seq: number; payload: string; draft_id: string | null }>(
    'SELECT seq, payload, draft_id FROM listing_versions WHERE network_id = ? AND property_id = ? ORDER BY seq DESC LIMIT 1',
    [networkId, propertyId],
  );
  return r ? toPublished(r) : null;
}

// ——— Portails étrangers [R259] ———

export interface TranslatedListingPayload extends ListingPayload {
  language: ListingLanguage;
}

/**
 * Le flux des portails étrangers : pour la dernière version publiée de chaque bien encore en vente ou sous offre,
 * chaque traduction validée et à jour de son annonce. Titre et texte traduits ; prix, mentions, médias et état sont
 * ceux de la version publiée, au caractère près.
 */
export class ExportPortailsEtrangers {
  private readonly traductions: AnnoncesTraduites;
  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    journal: JournalStore,
  ) {
    this.traductions = new AnnoncesTraduites(db, acces, journal);
  }

  async listings(networkId: string, languages: readonly ListingLanguage[] = LISTING_LANGUAGES): Promise<TranslatedListingPayload[]> {
    const rows = await this.db.all<{ seq: number; payload: string; property_id: string; draft_id: string | null }>(
      `SELECT v.seq, v.payload, v.property_id, v.draft_id FROM listing_versions v
       WHERE v.network_id = ? AND v.seq = (SELECT MAX(seq) FROM listing_versions w WHERE w.property_id = v.property_id)`,
      [networkId],
    );
    const out: TranslatedListingPayload[] = [];
    for (const r of rows) {
      const p = toPublished(r);
      if (!p) continue;
      const { listing: l, draft } = p;
      for (const language of LISTING_LANGUAGES.filter((x) => languages.includes(x))) {
        const t = await this.traductions.current(networkId, r.property_id, draft, language);
        if (t) out.push({ ...l, language, title: t.title, body: t.body });
      }
    }
    return out.sort((a, b) => (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : LISTING_LANGUAGES.indexOf(a.language) - LISTING_LANGUAGES.indexOf(b.language)));
  }

  async feed(networkId: string, format: PortalFormat = INTERNATIONAL_TRIAL_FORMAT, languages?: readonly ListingLanguage[]): Promise<{ contentType: string; body: string }> {
    return { contentType: format.contentType, body: format.render(await this.listings(networkId, languages)) };
  }
}

const xml = (s: string): string =>
  s
    .replace(/[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Le format d'essai des portails étrangers, décrit dans `docs/PORTAILS.md`. */
export const INTERNATIONAL_TRIAL_FORMAT: PortalFormat = {
  name: 'aimmo-essai-international-1',
  contentType: 'application/xml; charset=utf-8',
  render(listings) {
    const items = (listings as readonly TranslatedListingPayload[]).map((l) => {
      const media = l.media
        .map((m) => `<media type="${xml(m.kind)}" ref="${xml(m.ref)}"${m.overlay ? ` mention="${xml(m.overlay)}"` : ''}/>`)
        .join('');
      return (
        `<annonce reference="${xml(l.reference)}" version="${l.version}" etat="${xml(l.state)}" langue="${xml(l.language)}" sens="${RIGHT_TO_LEFT.has(l.language) ? 'rtl' : 'ltr'}">` +
        `<prix devise="EUR">${l.priceEur ?? ''}</prix>` +
        `<titre>${xml(l.title ?? '')}</titre>` +
        `<texte>${xml(l.body ?? '')}</texte>` +
        `<mentions langue="fr">${xml(l.mentions ?? '')}</mentions>` +
        // AU064 · le diagnostic part aussi aux portails étrangers, tel qu'il est rangé.
        dpeXml(l.dpe) +
        surfacesXml(l.surfaces) +
        `<medias>${media}</medias>` +
        `</annonce>`
      );
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<flux format="aimmo-essai-international-1">${items.join('')}</flux>\n`;
  },
};
