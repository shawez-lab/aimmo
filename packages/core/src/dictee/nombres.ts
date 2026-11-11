/**
 * Les nombres dits en lettres dans une dictée (RC01) : « un trois pièces », « quatre-vingt-cinq mètres carrés »,
 * « deux cent cinquante mille euros », « à quinze heures trente », « le douze janvier ».
 *
 * Un nombre en lettres n'est lu que s'il ne se lit que d'une seule façon [R260] : chaque suite de mots acceptée vient
 * d'une table écrite par le code (français écrit, plus septante, huitante, octante et nonante), et une suite qui n'y
 * est pas (« deux trois », « vingt cent », « trois et quatre ») ne donne rien. Le texte reçu est déjà sans accents et
 * en minuscules (le `fold` de la lecture).
 *
 * Décidé, lecture prudente : « un » ou « une » devant un nombre qui suit se lit comme l'article (« un trois pièces »
 * est un bien de 3 pièces), sauf devant « cent », « mille » ou « million » ; « un mille » n'est pas un nombre ; « vingts », « cents » et « million » au pluriel ou non
 * sont admis, la valeur restant la même.
 */

const UNITS = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'] as const;
const TEENS = ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'] as const;
/** Les dizaines régulières : un, et un, ou une unité derrière. Septante, huitante, octante et nonante comprises. */
const TENS: Readonly<Record<number, readonly string[]>> = {
  2: ['vingt'],
  3: ['trente'],
  4: ['quarante'],
  5: ['cinquante'],
  6: ['soixante'],
  7: ['septante'],
  8: ['huitante', 'octante'],
  9: ['nonante'],
};

/** Toutes les façons d'écrire un nombre de 1 à 99, mot par mot. */
function below100(n: number): string[][] {
  if (n === 1) return [['un'], ['une']];
  if (n < 10) return [[UNITS[n]!]];
  if (n < 17) return [[TEENS[n - 10]!]];
  if (n < 20) return [['dix', UNITS[n - 10]!]];
  const t = Math.floor(n / 10);
  const u = n % 10;
  const out: string[][] = [];
  for (const w of TENS[t] ?? []) {
    if (u === 0) out.push([w]);
    else if (u === 1) out.push([w, 'et', 'un'], [w, 'et', 'une']);
    else out.push([w, UNITS[u]!]);
  }
  if (t === 7) {
    // Soixante-dix, soixante et onze, soixante-douze… soixante-dix-neuf.
    const r = n - 60;
    if (r === 11) out.push(['soixante', 'et', 'onze']);
    else for (const x of below100(r)) out.push(['soixante', ...x]);
  }
  if (t === 8) {
    if (u === 0) out.push(['quatre', 'vingts'], ['quatre', 'vingt']);
    else for (const x of below100(u)) out.push(['quatre', 'vingt', ...x]);
  }
  if (t === 9) for (const x of below100(n - 80)) out.push(['quatre', 'vingt', ...x]);
  return out;
}

/** Toutes les façons d'écrire un nombre de 1 à 999. */
function below1000(n: number): string[][] {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 0) return below100(r);
  const heads = h === 1 ? [['cent']] : [[UNITS[h]!, 'cent'], [UNITS[h]!, 'cents']];
  if (r === 0) return heads;
  const out: string[][] = [];
  for (const head of heads) for (const x of below100(r)) out.push([...head, ...x]);
  return out;
}

/** La table : une suite de mots, séparés d'une espace, et le seul nombre qu'elle dit. */
const GROUPS: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (let n = 1; n <= 999; n += 1) {
    for (const words of below1000(n)) {
      const key = words.join(' ');
      const seen = m.get(key);
      if (seen !== undefined && seen !== n) throw new Error(`nombre en lettres ambigu : ${key}`);
      m.set(key, n);
    }
  }
  return m;
})();

/** Les mots d'un nombre. « et » ne commence jamais un nombre. */
export const NUMBER_WORDS = [
  'zero', 'une', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize',
  'quatorze', 'quinze', 'seize', 'vingts', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'septante', 'huitante',
  'octante', 'nonante', 'cents', 'cent', 'mille', 'millions', 'million',
] as const;

export const WORD = `(?:${NUMBER_WORDS.join('|')})(?![\\p{L}\\d])`;
/** Pour dire qu'un nombre en touche un autre, « premier » compte aussi (« le premier ou deux janvier »). */
const ADJACENT = `(?:${NUMBER_WORDS.join('|')}|premier|1er)(?![\\p{L}\\d])`;
const WORD_NO_ARTICLE = `(?:${NUMBER_WORDS.filter((w) => w !== 'un' && w !== 'une').join('|')}|premier|1er)(?![\\p{L}\\d])`;
/** Les blancs et les traits entre deux mots ; les tirets typographiques comptent, pour ne jamais lire la fin d'un nombre. */
const DASHES = '[\\s\\u2012-\\u2015-]';
const WORD_OR_ET = `(?:${NUMBER_WORDS.join('|')}|et)(?![\\p{L}\\d])`;

/** Une suite de mots de nombres, d'un seul tenant (espaces ou traits d'union), qui ne commence pas par « et ». */
export const NUMBER_RUN = `(?<![\\p{L}\\d])${WORD}(?:[\\s-]+${WORD_OR_ET})*`;

/**
 * Ce qui, juste avant une suite de mots, en fait la fin d'un autre nombre : un chiffre, « virgule », « point », ou un
 * mot de nombre (suivi ou non de « et »). Le nombre en lettres n'est alors pas lu.
 */
export const NUMBER_BEFORE = new RegExp(`(?:\\d[.,]?|(?<![\\p{L}\\d.,])(?:\\d+(?:[.,]\\d+)?\\s*(?:,|ou|et)|\\d{1,3}\\s*a)|(?<![\\p{L}\\d])(?:virgule|point)|(?<![\\p{L}\\d])${ADJACENT}(?:[\\s-]+(?:et|ou|a)|\\s*,)?)${DASHES}*$`, 'u');

/**
 * Ce qui, juste avant un nombre en chiffres, en fait la fin d'un nombre en lettres ou l'autre terme d'un choix
 * (« deux cent 50 000 », « un million 200 000 », « 3 ou 4 pièces », « trois, 4 pièces ») : il n'est pas lu. « un » et
 * « une » seuls restent l'article (« un 3 pièces »). « à » ne compte qu'après trois chiffres au plus (« 3 à 4 pièces ») :
 * après une année, il dit l'heure (« le 12 mars 2027 à 10 h »).
 */
export const DIGITS_BEFORE = new RegExp(`(?:(?<![\\p{L}\\d])${WORD_NO_ARTICLE}|(?<![\\p{L}\\d])${ADJACENT}[\\s-]+(?:et|ou|a)|(?<![\\p{L}\\d])${ADJACENT}\\s*,|(?<![\\p{L}\\d.,])(?:\\d+(?:[.,]\\d+)?\\s*(?:,|ou|et)|\\d{1,3}\\s*a))${DASHES}*$`, 'u');

/** Juste après un nombre en chiffres : un mot de nombre (« 15 heures trente », « 10 h quinze ») : il n'est pas lu. */
export const WORD_AFTER = new RegExp(`^\\s+${WORD}`, 'u');

const tokens = (run: string): string[] => run.split(/[\s-]+/).filter((t) => t.length > 0);

/** La valeur d'une suite de mots, ou null si elle ne se lit pas d'une seule façon. */
export function parseNumberWords(run: string): number | null {
  const t = tokens(run);
  if (t.length === 0) return null;
  if (t.length === 1 && t[0] === 'zero') return 0;
  if (t.includes('zero')) return null;
  const group = (words: string[]): number | null => (words.length === 0 ? null : GROUPS.get(words.join(' ')) ?? null);
  const millionAt = t.findIndex((w) => w === 'million' || w === 'millions');
  const thousandAt = t.indexOf('mille');
  if (t.filter((w) => w === 'million' || w === 'millions').length > 1 || t.filter((w) => w === 'mille').length > 1) return null;
  if (millionAt !== -1 && thousandAt !== -1 && thousandAt < millionAt) return null;
  let value = 0;
  let from = 0;
  if (millionAt !== -1) {
    const m = group(t.slice(0, millionAt));
    if (m === null) return null;
    value += m * 1_000_000;
    from = millionAt + 1;
  }
  if (thousandAt !== -1) {
    const words = t.slice(from, thousandAt);
    // « mille » seul vaut mille ; « un mille » ne se dit pas.
    const k = words.length === 0 ? 1 : group(words);
    if (k === null || (words.length > 0 && k === 1)) return null;
    value += k * 1000;
    from = thousandAt + 1;
  }
  const rest = t.slice(from);
  if (rest.length > 0) {
    const r = group(rest);
    if (r === null) return null;
    value += r;
  } else if (from === 0) return null;
  return value;
}

/**
 * Une suite de mots lue : sa valeur, et combien de caractères de la suite sont l'article qui la précède (« un trois »
 * se lit 3, l'article « un » laissé hors du passage). Null si elle ne se lit pas d'une seule façon.
 */
export function readNumberRun(run: string): { value: number; skip: number } | null {
  const whole = parseNumberWords(run);
  if (whole !== null) return { value: whole, skip: 0 };
  const article = /^(une?)[\s-]+/.exec(run);
  // « un mille », « un cent », « un million deux » ne se disent pas : l'article n'est pas retiré devant eux.
  if (!article || /^(?:mille|cents?|millions?)(?![\p{L}])/u.test(run.slice(article[0].length))) return null;
  const rest = parseNumberWords(run.slice(article[0].length));
  return rest === null ? null : { value: rest, skip: article[0].length };
}
