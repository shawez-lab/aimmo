/**
 * BR109 : les mots d'argent écrits par un détour, lus par le socle comme le bouclier les lit (`dossiers/bouclier.ts`,
 * RC66, RC71, RC72) : épelés (« R.I.B », « r i b », « I-B-A-N »), en « leet » (« R1B », « P@yez », « v1r3ment ») et en
 * leet épelé (« R 1 B », « 1-B-A-N »). Le bouclier importe `texte.ts` : le socle ne peut pas l'importer sans boucle, la
 * lecture est donc reprise ici à la lettre ; le test d'accord (`bouclier-socle-accord.test.ts`) tient l'écart.
 *
 * `wordReadings` rend les lectures d'un texte déjà en minuscules sans accents (`plain`) et démasqué (BR107), sur
 * lesquelles `texte.ts` cherche ses mots d'argent [R62]. Chaque lecture est un parcours linéaire, jamais une expression
 * qui pourrait s'emballer.
 */

/** RC71 : les chiffres et signes qui tiennent lieu d'une lettre dans un mot. */
const LEET: Record<string, string> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
/** RC72 : dans la lecture leet d'un mot épelé, les chiffres et signes qui tiennent lieu d'une lettre comptent aussi. */
const LEET_SPELL = new Set(['0', '1', '3', '4', '5', '7', '@', '$']);

const isLetter = (c: string | undefined): boolean => c !== undefined && c >= 'a' && c <= 'z';
const isSpellSep = (c: string | undefined): boolean => c === ' ' || c === '.' || c === '-';

/**
 * Le texte relu sans le leet : seul un mot qui porte au moins une lettre et au moins un chiffre ou signe change ; un
 * nombre seul (« 5000 », « 21000 ») ne change jamais. Le 1 vaut I ou L : `one` dit lequel.
 */
export function unleetWords(text: string, one: 'i' | 'l'): string {
  return text.replace(/[\p{L}\p{M}\p{N}@$]+/gu, (word) => {
    if (!/\p{L}/u.test(word) || !/[0-9@$]/.test(word)) return word;
    let out = '';
    for (const c of word) out += c === '1' ? one : (LEET[c] ?? c);
    return out;
  });
}

/**
 * Un mot écrit lettre par lettre, avec un même séparateur (espace, point, tiret), trois lettres au moins, recollé ; une
 * ou deux lettres seules voisines (« r i b a changé ») restent à part par `dropStart` et `dropEnd`. En lecture `leet`,
 * les chiffres et signes du leet comptent comme lettres, et seul un mot qui porte une lettre et un signe est recollé,
 * puis relu sans le leet. Un mot épelé écarté est recopié d'un bloc : aucune de ses lettres ne recommence un mot.
 */
export function joinSpelledWords(p: string, dropStart: number, dropEnd: number, leet: 'i' | 'l' | null = null): string {
  const isPart = leet === null ? isLetter : (c: string | undefined): boolean => isLetter(c) || (c !== undefined && LEET_SPELL.has(c));
  let out = '';
  let i = 0;
  while (i < p.length) {
    const sep = p[i + 1];
    if (isPart(p[i]) && !isPart(p[i - 1]) && isSpellSep(sep)) {
      let j = i;
      let word = p[i]!;
      while (p[j + 1] === sep && isPart(p[j + 2]) && !isPart(p[j + 3])) {
        word += p[j + 2]!;
        j += 2;
      }
      const leetWord = leet !== null && /[a-z]/.test(word) && /[0-9@$]/.test(word);
      if ((leet === null || leetWord) && word.length >= 3 && word.length - dropStart - dropEnd >= 3) {
        const head = word.slice(0, dropStart).split('');
        const tail = dropEnd > 0 ? word.slice(-dropEnd).split('') : [];
        const middle = word.slice(dropStart, word.length - dropEnd);
        out += [...head, leet === null ? middle : unleetWords(middle, leet), ...tail].join(' ');
        i = j + 1;
        continue;
      }
      out += p.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += p[i]!;
    i += 1;
  }
  return out;
}

/** Trois lettres (ou signes du leet) séparées une à une : un mot épelé est possible. */
const MAY_BE_SPELLED = /[a-z0-9@$][ .-][a-z0-9@$][ .-][a-z0-9@$]/;
/** Une lettre collée à un chiffre ou un signe du leet : un mot en leet est possible. */
const MAY_BE_LEET = /[a-z][0-9@$]|[0-9@$][a-z]/;
/** Un signe du leet séparé d'une lettre : un leet épelé est possible. */
const MAY_BE_SPELLED_LEET = /[0-9@$][ .-][a-z]|[a-z][ .-][0-9@$]/;

/**
 * Les lectures de `p` (minuscules sans accents, déjà démasqué) qu'un mot d'argent peut prendre, `p` compris, sans
 * doublon : sans le leet (1 valant i puis l), mots épelés recollés, leet épelé recollé. Chaque lecture n'est faite que
 * si le texte peut la porter : un texte ordinaire n'a qu'une ou deux lectures.
 */
export function wordReadings(p: string): string[] {
  const out = new Set<string>([p]);
  const bases = MAY_BE_LEET.test(p) ? [p, unleetWords(p, 'i'), unleetWords(p, 'l')] : [p];
  for (const b of bases) out.add(b);
  if (MAY_BE_SPELLED.test(p)) {
    for (const b of new Set(bases)) for (const ds of [0, 1, 2]) for (const de of [0, 1, 2]) out.add(joinSpelledWords(b, ds, de));
    if (MAY_BE_SPELLED_LEET.test(p)) {
      for (const one of ['i', 'l'] as const) for (const ds of [0, 1, 2]) for (const de of [0, 1, 2]) out.add(joinSpelledWords(p, ds, de, one));
    }
  }
  return [...out];
}
