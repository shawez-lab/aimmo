/**
 * La lecture d'une dictée de l'agent (HX06) : en sortant d'une visite, l'agent dicte une minute (le texte vient de la
 * dictée de son téléphone) ; le code en tire le contact, le bien et le rendez-vous, champ par champ.
 *
 * Aucun champ n'est inventé [R260] : chaque champ vient d'une seule phrase de la dictée, avec le passage exact qui le
 * porte. Le code lit, aucune IA ne propose de valeur. Un champ dit deux fois avec deux valeurs différentes n'est pas
 * proposé ; un nombre dit en lettres qui ne se lit pas d'une seule façon, une surface à virgule, un prix sans « prix »
 * ni « vend » dans sa phrase ne le sont pas non plus : l'agent les saisira lui-même. Un nombre en lettres qui se lit
 * d'une seule façon (RC01, `nombres.ts`) vaut le même nombre en chiffres, avec ses mots pour passage. Un bien n'est
 * lu que si sa sorte est dite, et jamais pour un acquéreur ; un rendez-vous n'est lu que d'une seule phrase qui dit sa sorte, son jour et son heure.
 *
 * Décidé, lecture prudente : un jour de la semaine dit (« mardi ») est le prochain, jamais aujourd'hui ; une date sans
 * année est la prochaine à venir ; une heure dite sans minutes est pile.
 */
import { localTime } from '../envoi/horaires.ts';
import { normalizeIdentifier } from '../fiche/normalize.ts';
import { DEFAULT_COMMUNES } from '../qualification/regles.ts';
import type { PropertyKind } from '../db/types.ts';
import { AGENDA_TIME_ZONE, parisInstant, type AppointmentKind } from '../rendezvous/creneaux.ts';
import { DIGITS_BEFORE, NUMBER_BEFORE, NUMBER_RUN, WORD, WORD_AFTER, parseNumberWords, readNumberRun } from './nombres.ts';

export type DictationTarget = 'contact' | 'bien' | 'rendezvous';

export const DICTATION_KEYS = {
  contact: ['firstName', 'lastName', 'phone', 'email', 'project'],
  bien: ['kind', 'postalCode', 'city', 'surfaceM2', 'rooms', 'priceEur'],
  rendezvous: ['appointmentKind', 'start'],
} as const;

export type DictatedKey = (typeof DICTATION_KEYS)[DictationTarget][number];

/** Un champ tiré de la dictée : sa valeur, la phrase qui la porte (son rang) et le passage exact de cette phrase. */
export interface DictatedField {
  target: DictationTarget;
  key: DictatedKey;
  value: string | number;
  sentence: number;
  quote: string;
}

export interface DictationDraft {
  sentences: string[];
  fields: DictatedField[];
  /** Les champs dits plusieurs fois avec des valeurs différentes : aucun n'est proposé. */
  conflicts: { target: DictationTarget; key: DictatedKey }[];
}

/** La longueur la plus longue d'une dictée : un peu plus d'une minute de parole. */
export const DICTATION_MAX_CHARS = 5000;

/** Les abréviations qu'un point ne termine pas. */
const ABBREVIATIONS = /(?:^|[\s(])(?:M|Mme|Mlle|Me|Dr|St|Ste|av|bd)$/u;

/** Coupe la dictée en phrases : un point, un point d'exclamation ou d'interrogation suivi d'un blanc, ou un retour à la ligne. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const push = (end: number) => {
    const s = text.slice(start, end).trim();
    if (s.length > 0) out.push(s);
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '\n') {
      push(i);
      start = i + 1;
      continue;
    }
    if ((c === '.' || c === '!' || c === '?') && (i + 1 === text.length || /\s/.test(text[i + 1]!))) {
      if (c === '.' && ABBREVIATIONS.test(text.slice(start, i))) continue;
      push(i + 1);
      start = i + 1;
    }
  }
  push(text.length);
  return out;
}

/** Une recherche sans accents ni casse, qui rend le passage exact du texte d'origine. */
function fold(text: string): { folded: string; index: number[] } {
  let folded = '';
  const index: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    // Le trait d'union typographique (insécable compris) vaut le trait d'union : « quatre‑vingt‑cinq » est un nombre.
    const f = text[i]!.replace(/[\u2010\u2011]/u, '-').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const ch of f) {
      folded += ch;
      index.push(i);
    }
  }
  index.push(text.length);
  return { folded, index };
}

interface Hit {
  value: string | number;
  quote: string;
  at: number;
  end: number;
}

/** Chaque passage d'une expression, lue sans accents ni casse, avec le passage d'origine. */
function hits(sentence: string, pattern: RegExp, read: (m: RegExpExecArray) => string | number | null): Hit[] {
  const { folded, index } = fold(sentence);
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const out: Hit[] = [];
  for (let m = re.exec(folded); m !== null; m = re.exec(folded)) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const value = read(m);
    if (value === null) continue;
    const at = index[m.index]!;
    const end = index[m.index + m[0].length] ?? sentence.length;
    out.push({ value, quote: sentence.slice(at, end).trim(), at, end });
  }
  return out;
}

const has = (sentence: string, pattern: RegExp): boolean => pattern.test(fold(sentence).folded);

/**
 * Chaque nombre dit en lettres suivi de `after` (RC01) : la suite de mots doit se lire d'une seule façon, et ne pas
 * finir un autre nombre (un chiffre, « virgule », un autre mot de nombre juste avant) [R260]. Le passage commence au
 * nombre, article laissé hors de lui, et finit avec `after`. `mustBefore`, s'il est donné, doit finir le texte d'avant.
 */
function wordHits(sentence: string, after: string, read: (n: number, m: RegExpExecArray) => string | number | null, mustBefore?: RegExp): Hit[] {
  const { folded, index } = fold(sentence);
  const re = new RegExp(`(${NUMBER_RUN})${after}`, 'gu');
  const out: Hit[] = [];
  for (let m = re.exec(folded); m !== null; m = re.exec(folded)) {
    const run = readNumberRun(m[1]!);
    if (run === null) continue;
    const before = folded.slice(0, m.index);
    if (NUMBER_BEFORE.test(before) || (mustBefore && !mustBefore.test(before))) continue;
    const value = read(run.value, m);
    if (value === null) continue;
    const at = index[m.index + run.skip]!;
    const end = index[m.index + m[0].length] ?? sentence.length;
    out.push({ value, quote: sentence.slice(at, end).trim(), at, end });
  }
  return out;
}

// Les expressions s'appliquent au texte sans accents et en minuscules.
const PHONE = /(?<![\d+])(?:\+33[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}(?!\d)/;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/;
const SURFACE = /(?<![\d.,]|\d[\s\u00a0\u202f])(\d{1,6})\s?(?:m²|m2|metres? carres?)(?![\p{L}\d])/u;
const ROOMS = /(?<![\d.,]|\d[\s\u00a0\u202f])(\d{1,2})\s?pieces?\b(?!\s+et demie?\b)|\b[tf](\d{1,2})\b/u;
const PRICE = /(?<![\d.,])(\d{1,3}(?:[\s.  ]\d{3})+|\d{1,10})\s?(?:€|euros?\b|(k€|k euros?\b|mille euros?\b))/u;
const PRICE_CONTEXT = /\b(?:prix|vend|vendre|vendu|mise? en vente|mettre en vente|demande|affiche)\b/;
const NOT_A_PRICE = /\b(?:budget|honoraires?|frais|commission|travaux|charges?|taxe|loyer|estim\w*|offre|apport|pret|credit|mensualite|remise|rabais|baisse|baisser|negoci\w*|paye|payee|achete|achetee|achat|acquis|acquise|marge)\b|\b(?:au|le|du|par) (?:metres? carres?|m2|m²)/u;
/** Le prix demandé suit de près « prix », « vend » ou « demande », sans autre nombre entre eux. */
const PRICE_LEAD = /\b(?:prix|vend\w*|demande|affiche)\b[^\d]{0,30}$/;
/** Ce qui suit un nombre en lettres de pièces, de surface ou de prix (RC01). Une surface « et demie » n'est pas lue. */
const ROOMS_AFTER = '\\s+pieces?(?![\\p{L}\\d])(?!\\s+et demie?\\b)';
const SURFACE_AFTER = '\\s+(?:m²|m2|metres? carres?)(?![\\p{L}\\d])(?!\\s+et demie?\\b)';
const PRICE_AFTER = '\\s+euros?(?![\\p{L}\\d])(?!\\s+et demie?\\b)';
/** Un montant « et demi » ne se lit pas, en chiffres non plus. */
const HALF_AFTER = /^\s+et demie?\b/u;
const POSTAL = /(?<![\d.,]|\d[\s\u00a0\u202f])\b((?:0[1-9]|[1-8]\d|9[0-5]|97)\d{3})\b(?![.,]?\d)(?!\s?(?:€|euros?\b|k€|m²|m2|metres?\b|pieces?\b))/u;

const KINDS: readonly [RegExp, PropertyKind][] = [
  [/\bfonds de commerce\b/, 'business'],
  [/\bmurs (?:commerciaux|d'un commerce|d’un commerce)\b/, 'business_walls'],
  [/\blocal (?:commercial|professionnel)\b|\bbureaux?\b/, 'commercial'],
  [/\bimmeuble\b/, 'building'],
  [/\bterrain\b/, 'land'],
  [/\bappartement\b|\bmaison\b|\bvilla\b|\bstudio\b|\bduplex\b|\bloft\b|\bpavillon\b/, 'home'],
];

const SELL = /\b(?:vendre|vend|vendeur|vendeuse|vendeurs|mettre en vente|mise en vente|estimer|faire estimer)\b/;
const BUY = /\b(?:acheter|achete|acheteur|acheteuse|acheteurs|acquereur|acquereurs|cherche|recherche)\b/;

/** Après « s'appelle », « Madame », « Monsieur » : un ou deux mots à majuscule, lus dans le texte d'origine. */
const NAME = /\b(?:s['’]appell(?:e|ent)|se nomm(?:e|ent)|nommee?|madame|monsieur|mme|m\.)\s+/;
const CAPITALIZED = /^(\p{Lu}[\p{L}'’-]*)(?:\s+(\p{Lu}[\p{L}'’-]*))?(?:\s+(\p{Lu}[\p{L}'’-]*))?/u;
/** Les particules d'un nom de famille : « Le Gall », « De Souza », « Van Damme » ne sont pas un prénom suivi d'un nom. */
const LOWER_PARTICLE_NEXT = /^\s+(?:de|du|des|le|la|les|van|von|der|den|da|di|del|della|dos|das|el|al|ben|bin|mac|saint|sainte)\s+\p{L}|^\s*(?:d|l)['’]\s*\p{L}/u;
const PARTICLE = /^(?:le|la|les|de|du|des|d|l|van|von|der|den|da|di|del|della|dos|das|el|al|ben|bin|mac|mc|saint|sainte|st|ste)$/;

const APPOINTMENT_WORDS = /\b(?:rendez-vous|rendez vous|rdv|rappel\w*|revoir|repasser|passer|visite|visiter|estimation|estimer|signature|signer|appel|appeler|telephoner)\b/;
const APPOINTMENT_KINDS_READ: readonly [RegExp, AppointmentKind][] = [
  [/\b(?:estimation|estimer)\b/, 'estimation'],
  [/\b(?:signature|signer)\b/, 'signature'],
  [/\b(?:rappel\w*|appel|appeler|telephoner)\b/, 'appel'],
  [/\b(?:visite|visiter|contre-visite)\b/, 'visite'],
];
const WEEKDAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const MONTHS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
/** Une année dite après le jour et le mois, qui n'est pas lue (en lettres, ou autre que 20xx) : le jour est refusé. */
const YEAR_NOT_READ = `(?!\\s+(?:\\d{2}(?:\\d{2})?(?!\\d)|${NUMBER_RUN}))`;
const DAY = new RegExp(`\\b(?:(apres-demain|apres demain|demain)|(${WEEKDAY_NAMES.join('|')})(?: prochain)?|(?:le )?(1er|[1-9]|[12]\\d|3[01]) (${MONTHS.join('|')})(?: (20\\d{2}))?)\\b${YEAR_NOT_READ}`);
/** Le jour du mois en lettres (RC01) : « le douze janvier », « le premier mai ». */
const DAY_WORDS_AFTER = `\\s+(${MONTHS.join('|')})(?![\\p{L}\\d])${YEAR_NOT_READ}`;
const FIRST_OF_MONTH = new RegExp(`\\bpremier\\s+(${MONTHS.join('|')})(?![\\p{L}\\d])${YEAR_NOT_READ}`, 'u');
/**
 * L'heure en lettres (RC01) : « quinze heures », « quinze heures trente ». Les minutes se lisent d'une seule façon,
 * de 1 à 59, sinon rien ; « et » (« et demie », « et trente minutes »), « minutes », « moins » ou un chiffre
 * derrière : rien.
 */
const TIME_WORDS_AFTER = `\\s+heures?(?:\\s+(${NUMBER_RUN}))?(?![\\p{L}\\d])(?!\\s*(?:\\d|et\\s+(?:demie?|quart|des\\b|\\d|${WORD})|minutes?\\b|moins\\b))`;
/**
 * Une heure en lettres ne se lit qu'après « à » ou « vers » (« il y a deux heures » est une durée), de 8 h à 23 h :
 * « à deux heures » se dit pour 14 h comme pour 2 h. Suivie de « du matin », « du soir » ou « de l'après-midi », elle
 * n'est pas lue non plus.
 */
const TIME_WORDS_BEFORE = /(?<![\p{L}\d])(?:a|vers)\s+$/u;
const DURATION_YA = /(?<![\p{L}\d])y\s+a\s+$/u;
/**
 * Une autre heure dite dans la phrase, même non lue (« à dix heures ou onze heures », « à dix heures, non onze
 * heures », « de dix heures à onze heures ») : le rendez-vous n'est pas lu. Seule une heure qui suit un mot de
 * durée ne compte pas ; « de » n'en est pas un, il ouvre aussi une plage.
 */
const DURATION_BEFORE = /(?:(?<![\p{L}\d])(?:dans|pendant|durant|pour|depuis|en|prevoir|prevu|y\s+a)|(?<![\p{L}\d])d['’])\s*$/u;
const TIME_QUALIFIER = /^\s+(?:du (?:matin|soir)|de l['’ ]\s*apres[- ]midi)/u;
/** Ce qui suit des minutes en lettres : la fin de la phrase ou une ponctuation, sinon elles ont pu prendre un autre mot. */
const MINUTES_END = /^\s*(?:[,.;:!?)]|$)/u;
/** Une heure entière : suivie d'un chiffre ou de « et demie », « et quart », « moins », elle n'est pas lue. */
const TIME = /\b(?:(midi)|([01]?\d|2[0-3])\s?(?:h|heures?)(?:\s?([0-5]\d))?)(?![\p{L}\d])(?!\s*(?:\d|et\s+(?:(?:demie?|quart|des)\b|\d)|et\s+(?:un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante)(?![\p{L}\d])|minutes?\b|moins\b))/u;
/**
 * Toute heure dite, lue ou non (RC01) : un nombre en chiffres ou en lettres suivi de « h », « heure » ou « heures »,
 * quoi qu'il y ait derrière, et midi et minuit. Cette recherche ne reprend pas le motif qui lit l'heure : une heure
 * que la lecture refuse (« dix heures et demie ») compte quand même comme une autre heure dite.
 */
const HOUR_MENTION = new RegExp(`(?<![\\p{L}\\d])(?:\\d{1,2}\\s?(?:h|heures?)(?![\\p{L}])|(?:${NUMBER_RUN})\\s+heures?(?![\\p{L}\\d])|midi(?![\\p{L}\\d])|minuit(?![\\p{L}\\d]))`, 'gu');
/**
 * Un nombre nu collé à l'heure lue dit une autre heure sans « h » (RC01, relecture) : « 14-15 h », « 15 h 30 ou 45 »,
 * « 15 h, sinon 16 », « 15 h, 16 au plus tard ». Le nombre ne compte qu'après « ou », « sinon », « voire », « plutôt »
 * ou un tiret, ou s'il finit la phrase : « 15 h, un couple » ou « 15 h, 12 rue … » se lisent. Dans le doute, rien.
 */
const BARE_NUMBER_AFTER = new RegExp(`^\\s*,?\\s*(?:(?:ou(?:\\s+bien)?|sinon|voire|plutot|-)\\s*(?:\\d{1,2}(?!\\d)|${WORD})|(?:a\\s+)?(?:\\d{1,2}|${WORD})\\s*(?:[.;!?)]|$|au plus (?:tard|tot)(?![\\p{L}\\d])))`, 'u');
const BARE_NUMBER_BEFORE = new RegExp(`(?:(?<![\\d.,])\\d{1,2}|(?<![\\p{L}\\d])${WORD})\\s*(?:-|,|ou|a)\\s*$`, 'u');
function crowded(sentence: string, h: Hit): boolean {
  return BARE_NUMBER_AFTER.test(fold(sentence.slice(h.end)).folded) || BARE_NUMBER_BEFORE.test(fold(sentence.slice(0, h.at)).folded);
}
/** Les heures dites dans la phrase, hors de celles qui suivent un mot de durée. */
function hourMentions(sentence: string): Hit[] {
  const { folded, index } = fold(sentence);
  const out: Hit[] = [];
  HOUR_MENTION.lastIndex = 0;
  for (let m = HOUR_MENTION.exec(folded); m !== null; m = HOUR_MENTION.exec(folded)) {
    if (DURATION_BEFORE.test(folded.slice(0, m.index))) continue;
    const at = index[m.index]!;
    const end = index[m.index + m[0].length] ?? sentence.length;
    out.push({ value: 0, quote: sentence.slice(at, end).trim(), at, end });
  }
  return out;
}

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Le jour dit, en date de Paris, depuis aujourd'hui. */
function dayOf(m: RegExpExecArray, today: { date: string; weekday: number }): string | null {
  if (m[1]) return addDays(today.date, m[1].startsWith('apres') ? 2 : 1);
  if (m[2]) {
    const target = WEEKDAY_NAMES.indexOf(m[2]) + 1;
    const ahead = ((target - today.weekday + 7) % 7) || 7;
    return addDays(today.date, ahead);
  }
  return dateOf(m[3] === '1er' ? 1 : Number(m[3]), MONTHS.indexOf(m[4]!) + 1, m[5] ? Number(m[5]) : null, today);
}

/** Le jour et le mois dits, l'année dite ou la prochaine à venir ; null s'il n'existe pas ou est passé. */
function dateOf(day: number, month: number, year: number | null, today: { date: string }): string | null {
  const pad = (n: number) => String(n).padStart(2, '0');
  const thisYear = Number(today.date.slice(0, 4));
  const build = (y: number): string | null => {
    const iso = `${y}-${pad(month)}-${pad(day)}`;
    const d = new Date(`${iso}T12:00:00.000Z`);
    return d.getUTCMonth() + 1 === month && d.getUTCDate() === day ? iso : null;
  };
  if (year !== null) {
    const date = build(year);
    return date !== null && date >= today.date ? date : null;
  }
  const date = build(thisYear);
  if (date === null) return null;
  return date >= today.date ? date : build(thisYear + 1);
}

function readContact(sentence: string): Hit[][] {
  const phones = hits(sentence, PHONE, (m) => normalizeIdentifier('phone', m[0]));
  const emails = hits(sentence, EMAIL, (m) => normalizeIdentifier('email', m[0]));
  // Le passage d'un mail n'est pas lu comme un téléphone, ni l'inverse.
  return [phones, emails];
}

function readNames(sentence: string, communes: readonly string[]): { first: Hit[]; last: Hit[] } {
  const first: Hit[] = [];
  const last: Hit[] = [];
  const { folded, index } = fold(sentence);
  const re = new RegExp(NAME.source, 'g');
  const isCommune = (w: string) => communes.some((c) => fold(c).folded === fold(w).folded);
  for (let m = re.exec(folded); m !== null; m = re.exec(folded)) {
    const civility = !/^s|^se|^nomm/.test(m[0]);
    const from = index[m.index + m[0].length]!;
    const rest = sentence.slice(from);
    const n = CAPITALIZED.exec(rest);
    if (!n) continue;
    // Les mots à majuscule qui suivent, jusqu'au premier nom de commune.
    const all = [n[1]!, ...(n[2] ? [n[2]] : []), ...(n[3] ? [n[3]] : [])];
    const cut = all.findIndex(isCommune);
    const words = cut === -1 ? all : all.slice(0, cut);
    if (words.length === 0) continue;
    let pos = 0;
    for (const w of words) pos = rest.indexOf(w, pos) + w.length;
    const quoteEnd = from + pos;
    // Un nom qui continue par une particule en minuscule (« Jean de Souza ») : coupé, il serait faux ; rien n'est proposé.
    if (LOWER_PARTICLE_NEXT.test(rest.slice(pos))) continue;
    const quote = sentence.slice(index[m.index]!, quoteEnd).trim();
    const at = index[m.index]!;
    const particle = words.map((w) => PARTICLE.test(fold(w).folded.replace(/['’]$/, '')));
    const push = (list: Hit[], value: string) => list.push({ value, quote, at, end: quoteEnd });
    // Une particule finale, deux mots sans particule après trois, ou une particule entre deux mots seulement :
    // le partage entre prénom et nom n'est pas sûr, rien n'est proposé.
    if (particle.at(-1)) continue;
    if (words.length === 1) push(civility ? last : first, words[0]!);
    else if (particle[0]) push(last, words.join(' '));
    else if (words.length === 2 && !particle[1]) {
      push(first, words[0]!);
      push(last, words[1]!);
    } else if (words.length === 3 && particle[1]) {
      push(first, words[0]!);
      push(last, `${words[1]} ${words[2]}`);
    }
  }
  return { first, last };
}

/**
 * Tous les mots qui suivent « Madame », « Monsieur », « s'appelle »… jusqu'à quatre, particules comprises, qu'un champ
 * en soit tiré ou non : ce qu'il faut retirer d'un texte envoyé à une IA [R15].
 */
export function unproposedNames(dictation: string): string[] {
  const out: string[] = [];
  const text = dictation.normalize('NFC');
  const { folded, index } = fold(text);
  const re = new RegExp(NAME.source, 'g');
  for (let m = re.exec(folded); m !== null; m = re.exec(folded)) {
    const rest = text.slice(index[m.index + m[0].length]!);
    const words = /^(?:[\p{L}'’-]+\s*){1,4}/u.exec(rest)?.[0].split(/\s+/).filter(Boolean) ?? [];
    for (const w of words) {
      if (!/^\p{Lu}/u.test(w) && !PARTICLE.test(fold(w).folded.replace(/['’].*$/, ''))) break;
      out.push(w.replace(/^(?:d|l)['’]/iu, ''));
    }
  }
  return out.filter((w) => w.length > 0);
}

function readCity(sentence: string, communes: readonly string[]): Hit[] {
  const out: Hit[] = [];
  const { folded, index } = fold(sentence);
  // La plus longue d'abord : « Fontaine-lès-Dijon » avant « Dijon » ; un passage pris ne sert qu'une fois.
  const taken: [number, number][] = [];
  const sorted = [...communes].sort((a, b) => b.length - a.length);
  for (const commune of sorted) {
    const key = fold(commune).folded.replace(/[^a-z0-9]+/g, '[^a-z0-9]+');
    const re = new RegExp(`(?<![a-z0-9])${key}(?![a-z0-9])`, 'g');
    for (let m = re.exec(folded); m !== null; m = re.exec(folded)) {
      const a = m.index;
      const b = m.index + m[0].length;
      if (taken.some(([x, y]) => a < y && b > x)) continue;
      taken.push([a, b]);
      out.push({ value: commune, quote: sentence.slice(index[a]!, index[b]!), at: index[a]!, end: index[b]! });
    }
  }
  return out;
}

/**
 * Un nombre en chiffres qui finit un nombre en lettres, ou l'un des termes d'un choix (« deux cent 50 000 euros »,
 * « 3 ou 4 pièces ») n'est pas lu [R260] ; une heure suivie d'un mot de nombre (« 15 heures trente ») non plus.
 */
const digitsAlone = (sentence: string, opts: { wordAfter?: boolean } = {}) => (h: Hit): boolean =>
  !DIGITS_BEFORE.test(fold(sentence.slice(0, h.at)).folded) && !(opts.wordAfter && WORD_AFTER.test(fold(sentence.slice(h.end)).folded));

const overlaps = (h: Hit, others: readonly Hit[]) => others.some((o) => h.at < o.end && h.end > o.at);

/**
 * Lit la dictée : chaque champ vient d'une phrase, avec son passage exact [R260]. `now` sert aux jours dits
 * (« demain », « mardi ») ; `communes` est la liste de la zone de l'agent.
 */
export function readDictation(dictation: string, options: { now: Date; communes?: readonly string[] }): DictationDraft {
  const communes = options.communes ?? DEFAULT_COMMUNES;
  const sentences = splitSentences(dictation.normalize('NFC'));
  const today = localTime(options.now, AGENDA_TIME_ZONE);
  const found: DictatedField[] = [];
  const add = (target: DictationTarget, key: DictatedKey, sentence: number, list: readonly Hit[]) => {
    for (const h of list) found.push({ target, key, value: h.value, sentence, quote: h.quote });
  };

  let kindSeen = false;
  sentences.forEach((s, i) => {
    const [phones, emails] = readContact(s) as [Hit[], Hit[]];
    const phonesOutsideMails = phones.filter((p) => !overlaps(p, emails));
    add('contact', 'phone', i, phonesOutsideMails);
    add('contact', 'email', i, emails);
    const names = readNames(s, communes);
    add('contact', 'firstName', i, names.first);
    add('contact', 'lastName', i, names.last);
    const sell = hits(s, SELL, () => 'sell');
    const buy = hits(s, BUY, () => 'buy');
    add('contact', 'project', i, [...sell, ...buy]);

    const contacts = [...phonesOutsideMails, ...emails];
    const kinds: Hit[] = [];
    for (const [re, kind] of KINDS) for (const h of hits(s, re, () => kind)) if (!overlaps(h, kinds)) kinds.push(h);
    if (kinds.length > 0) kindSeen = true;
    add('bien', 'kind', i, kinds);
    const inRange = (lo: number, hi: number) => (n: number) => (n >= lo && n <= hi ? n : null);
    const surfaceWords = wordHits(s, SURFACE_AFTER, inRange(1, 999_999));
    add('bien', 'surfaceM2', i, [...hits(s, SURFACE, (m) => Number(m[1])).filter(digitsAlone(s)), ...surfaceWords].filter((h) => !overlaps(h, contacts) && (h.value as number) >= 1));
    add('bien', 'rooms', i, [...hits(s, ROOMS, (m) => Number(m[1] ?? m[2])).filter(digitsAlone(s)), ...wordHits(s, ROOMS_AFTER, inRange(1, 99))].filter((h) => !overlaps(h, contacts) && (h.value as number) >= 1));
    const priceWords = wordHits(s, PRICE_AFTER, inRange(1, 1_000_000_000));
    if (has(s, PRICE_CONTEXT) && !has(s, NOT_A_PRICE)) {
      add(
        'bien',
        'priceEur',
        i,
        [...priceWords, ...hits(s, PRICE, (m) => {
          const n = Number(m[1]!.replace(/[\s.  ]/g, ''));
          const v = m[2] ? n * 1000 : n;
          return Number.isInteger(v) && v >= 1 && v <= 1_000_000_000 ? v : null;
        }).filter((h) => digitsAlone(s)(h) && !HALF_AFTER.test(fold(s.slice(h.end)).folded))].filter((h) => !overlaps(h, contacts) && PRICE_LEAD.test(fold(s.slice(0, h.at)).folded)),
      );
    }
    const numbers = [...contacts, ...hits(s, PRICE, () => 0), ...hits(s, SURFACE, () => 0), ...priceWords, ...surfaceWords];
    add('bien', 'postalCode', i, hits(s, POSTAL, (m) => m[1]!).filter((h) => !overlaps(h, numbers)));
    add('bien', 'city', i, readCity(s, communes));

    // Le rendez-vous : sa sorte, son jour et son heure, dans la même phrase.
    if (has(s, APPOINTMENT_WORDS)) {
      const days = [
        ...hits(s, DAY, (m) => dayOf(m, today)).filter(digitsAlone(s)),
        ...wordHits(s, DAY_WORDS_AFTER, (n, m) => (n >= 1 && n <= 31 ? dateOf(n, MONTHS.indexOf(m[2]!) + 1, null, today) : null)),
        ...hits(s, FIRST_OF_MONTH, (m) => dateOf(1, MONTHS.indexOf(m[1]!) + 1, null, today)).filter((h) => digitsAlone(s)(h) && !NUMBER_BEFORE.test(fold(s.slice(0, h.at)).folded)),
      ];
      const timeWords = wordHits(
        s,
        TIME_WORDS_AFTER,
        (h, m) => {
          const rest = m.input.slice(m.index + m[0].length);
          if (h < 8 || h > 23 || TIME_QUALIFIER.test(rest)) return null;
          // Un mot de nombre derrière l'heure, non pris pour minutes (« quinze heures trente minutes ») : rien.
          if (m[2] === undefined) return WORD_AFTER.test(rest) ? null : h * 60;
          if (!MINUTES_END.test(rest)) return null;
          const minutes = parseNumberWords(m[2]);
          return minutes !== null && minutes >= 1 && minutes <= 59 ? h * 60 + minutes : null;
        },
        TIME_WORDS_BEFORE,
      ).filter((h) => !DURATION_YA.test(fold(s.slice(0, h.at)).folded));
      const times = [...hits(s, TIME, (m) => (m[1] ? 12 * 60 : Number(m[2]) * 60 + Number(m[3] ?? 0))).filter(digitsAlone(s, { wordAfter: true })), ...timeWords].filter((h) => !overlaps(h, numbers));
      const sorts: Hit[] = [];
      for (const [re, kind] of APPOINTMENT_KINDS_READ) for (const h of hits(s, re, () => kind)) sorts.push(h);
      const crowdedTimes = times.filter((h) => crowded(s, h));
      const mentions = hourMentions(s).filter((h) => !overlaps(h, numbers) || overlaps(h, times));
      const otherTimes = mentions.filter((h) => !overlaps(h, times));
      if (days.length === 1 && times.length === 1 && otherTimes.length === 0 && mentions.length === 1 && crowdedTimes.length === 0) {
        const day = days[0]!;
        const time = times[0]!;
        const start = parisInstant(day.value as string, time.value as number);
        if (start) {
          const a = Math.min(day.at, time.at);
          const b = Math.max(day.end, time.end);
          found.push({ target: 'rendezvous', key: 'start', value: start.toISOString(), sentence: i, quote: s.slice(a, b).trim() });
          add('rendezvous', 'appointmentKind', i, sorts);
        }
      } else if (days.length >= 1 && times.length + mentions.length >= 1) {
        // Deux jours ou deux heures dans la phrase : le rendez-vous n'est pas lu, l'agent le prendra lui-même.
        found.push({ target: 'rendezvous', key: 'start', value: '', sentence: i, quote: '' });
      }
    }
  });

  // Un champ dit plusieurs fois doit dire la même chose ; sinon il n'est pas proposé. La première phrase qui le dit
  // porte le renvoi.
  const fields: DictatedField[] = [];
  const conflicts: DictationDraft['conflicts'] = [];
  for (const target of Object.keys(DICTATION_KEYS) as DictationTarget[]) {
    for (const key of DICTATION_KEYS[target] as readonly DictatedKey[]) {
      const all = found.filter((f) => f.target === target && f.key === key);
      if (all.length === 0) continue;
      const values = new Set(all.map((f) => f.value));
      if (values.size > 1 || all[0]!.value === '') conflicts.push({ target, key });
      else fields.push(all[0]!);
    }
  }
  // Un bien n'existe que si sa sorte est dite, et jamais pour un acquéreur ; un rendez-vous, que s'il a son heure.
  const project = fields.find((f) => f.target === 'contact' && f.key === 'project')?.value;
  const keepBien = kindSeen && fields.some((f) => f.target === 'bien' && f.key === 'kind') && project !== 'buy';
  const keepRdv = fields.some((f) => f.target === 'rendezvous' && f.key === 'start');
  return {
    sentences,
    fields: fields.filter((f) => (f.target === 'bien' ? keepBien : f.target === 'rendezvous' ? keepRdv : true)),
    conflicts: conflicts.filter((c) => (c.target === 'bien' ? keepBien : c.target === 'rendezvous' ? keepRdv || c.key === 'start' : true)),
  };
}

/** Le champ d'une cible dans la lecture, s'il y est. */
export function fieldOf(draft: DictationDraft, target: DictationTarget, key: DictatedKey): DictatedField | undefined {
  return draft.fields.find((f) => f.target === target && f.key === key);
}
