/**
 * BR106 : les plages d'un IBAN écrit par un détour, épelé (« F R 7 6 3 0 0 0 … »), dicté en mots (« F R soixante-seize,
 * trois mille, six mille… », « double zéro », anglais) ou déguisé par des sosies (O pour 0, l pour 1, pleine chasse),
 * dans le texte d'origine [R15, R62]. BR107 : aussi coupé de caractères invisibles ou écrit avec des sosies grecs ou
 * cyrilliques, lu dans le texte tel que l'œil le voit. `maskIban` les remplace par `IBAN_MASK` : un message rangé ne garde jamais un tel
 * IBAN en clair, et `fundsInOutgoing` refuse tout texte qui en porte.
 *
 * La lecture est celle du bouclier (`dossiers/bouclier.ts`, RC67 à RC69), qui importe ce fichier-ci par `texte.ts` :
 * le socle ne peut pas l'importer sans boucle. Elle est donc reprise ici, à la lettre, en suivant en plus la place de
 * chaque caractère relu dans le texte d'origine ; un test vérifie que tout IBAN lu par le bouclier est masqué ici.
 * Pays connu, longueur exacte et clé juste (modulo 97) restent exigés : un téléphone, une date ou un montant dictés ne
 * sont jamais masqués. Chaque parcours est linéaire, jamais une expression qui pourrait s'emballer.
 */

/** Longueur de l'IBAN par code de pays (Europe, outre-mer français compris), comme le bouclier. */
const IBAN_LENGTHS: Record<string, number> = {
  FR: 27, MC: 27, GP: 27, MQ: 27, GF: 27, RE: 27, YT: 27, PM: 27, NC: 27, PF: 27, WF: 27, TF: 27, BL: 27, MF: 27,
  BE: 16, LU: 20, CH: 21, LI: 21, DE: 22, AT: 20, NL: 18, ES: 24, AD: 24, PT: 25, IT: 27, SM: 27, VA: 22, GB: 22,
  IE: 22, DK: 18, SE: 24, FI: 18, NO: 15, IS: 26, PL: 28, CZ: 24, SK: 24, HU: 28, RO: 24, BG: 22, GR: 27, CY: 28,
  MT: 31, SI: 19, HR: 21, EE: 20, LV: 21, LT: 20, GI: 23,
};

const isAsciiAlnum = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
const isAsciiDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isIbanSep = (c: string | undefined): boolean => c !== undefined && /[\s.,\-/_]/.test(c);
/** Une lettre ou un chiffre hors ASCII (« é », « ² ») : un morceau qui y est collé fait partie d'un mot. */
const glued = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** La clé d'un IBAN recollé, en majuscules : vraie si le reste modulo 97 vaut 1. */
function ibanKeyOk(chars: string): boolean {
  const s = chars.slice(4) + chars.slice(0, 4);
  let r = 0;
  for (const ch of s) {
    const v = isAsciiDigit(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r === 1;
}

export type Span = [number, number];

/**
 * Les IBAN d'une suite recollée, de gauche à droite et sans chevauchement : chacun commence au début d'un morceau,
 * finit au bout d'un morceau et a sa clé juste. Rend les plages `[début, fin[` dans la suite recollée.
 */
function runIbans(joined: string, starts: boolean[], ends: boolean[]): Span[] {
  const found: Span[] = [];
  let k = 0;
  while (k + 4 <= joined.length) {
    const length = starts[k] ? IBAN_LENGTHS[joined.slice(k, k + 2)] : undefined;
    const end = length === undefined ? -1 : k + length;
    if (
      length !== undefined &&
      isAsciiDigit(joined[k + 2]) &&
      isAsciiDigit(joined[k + 3]) &&
      end <= joined.length &&
      ends[end] === true &&
      ibanKeyOk(joined.slice(k, end))
    ) {
      found.push([k, end]);
      k = end;
    } else {
      k += 1;
    }
  }
  return found;
}

/**
 * Les plages des IBAN épelés ou coupés du texte, comme `spelledIban` du bouclier : suites de morceaux de 1 à 4 lettres
 * ou chiffres ASCII, séparés par trois espaces, retours à la ligne, points, tirets, virgules, barres ou soulignés au
 * plus ; tout autre signe coupe la suite, et un morceau collé à une lettre accentuée n'en fait pas partie.
 */
export function spelledIbanSpans(text: string): Span[] {
  const spans: Span[] = [];
  let joined = '';
  let at: number[] = [];
  let starts: boolean[] = [];
  let ends: boolean[] = [];
  const flush = (): void => {
    if (joined.length >= 15) {
      for (const [a, b] of runIbans(joined, starts, ends)) spans.push([at[a]!, at[b - 1]! + 1]);
    }
    joined = '';
    at = [];
    starts = [];
    ends = [];
  };
  let i = 0;
  while (i < text.length) {
    if (!isAsciiAlnum(text[i])) {
      let k = i;
      while (k < text.length && isIbanSep(text[k])) k += 1;
      if (k === i || k - i > 3) {
        flush();
        if (k === i) k = i + 1;
      }
      i = k;
      continue;
    }
    let j = i;
    while (j < text.length && isAsciiAlnum(text[j])) j += 1;
    if (j - i > 4 || glued(text[i - 1]) || glued(text[j])) {
      flush();
      i = j;
      continue;
    }
    starts[joined.length] = true;
    for (let q = i; q < j; q += 1) {
      joined += text[q]!.toUpperCase();
      at.push(q);
    }
    ends[joined.length] = true;
    i = j;
  }
  flush();
  return spans;
}

/** Les chiffres dits en mots, en français et en anglais. « Une » n'en est pas un : « une chambre ». */
const UNIT_WORDS: Record<string, number> = {
  zero: 0, un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9,
};
const TEEN_WORDS: Record<string, number> = { dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16 };
const TENS_WORDS: Record<string, number> = { vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 };
const REPEAT_WORDS: Record<string, number> = { double: 2, triple: 3 };
const THOUSAND_WORDS = new Set(['mille', 'mil', 'thousand']);
const HUNDRED_WORDS = new Set(['cent', 'cents', 'hundred']);
const isMultiplier = (w: string | undefined): boolean => w !== undefined && (THOUSAND_WORDS.has(w) || HUNDRED_WORDS.has(w));

/** Un mot du texte normalisé : `start` et `end` sont ses places dans le texte normalisé, `sepStart` celle du séparateur qui le précède. */
interface Token { word: string; raw: string; sep: string; sepStart: number; start: number; end: number }

/** Un mot d'un nombre composé ne se lie au précédent qu'à travers des espaces ou des traits d'union, trois au plus. */
const binds = (sep: string): boolean => sep.length > 0 && sep.length <= 3 && /^[ \-]+$/.test(sep);

/**
 * Un nombre en mots qui commence au mot `i` : ses chiffres et le mot qui le suit, ou rien. Même lecture que le
 * bouclier ; chaque lecture regarde au plus neuf mots plus loin.
 */
function numberAt(t: Token[], i: number, split = false): [string, number] | null {
  const at = (k: number): string | undefined => (k < t.length && (k === i || binds(t[k]!.sep)) ? t[k]!.word : undefined);
  const chain = (k: number): string | undefined => {
    for (let m = i + 1; m <= k; m += 1) if (at(m) === undefined) return undefined;
    return at(k);
  };
  const unit = (k: number, min: number): number | undefined => {
    const u = UNIT_WORDS[chain(k) ?? ''];
    return u !== undefined && u >= min ? u : undefined;
  };
  const teen = (k: number): [number, number] | null => {
    const x = chain(k);
    if (x === 'dix') {
      const u = unit(k + 1, 7);
      return u !== undefined ? [10 + u, k + 2] : [10, k + 1];
    }
    if (x !== undefined && TEEN_WORDS[x] !== undefined) return [TEEN_WORDS[x]!, k + 1];
    return null;
  };
  const below100 = (s: number): [number, number] | null => {
    const w = chain(s);
    if (w === undefined) return null;
    const tens = TENS_WORDS[w];
    if (tens !== undefined) {
      if (tens === 60) {
        const tn = chain(s + 1) === 'et' && chain(s + 2) === 'onze' ? ([11, s + 3] as [number, number]) : teen(s + 1);
        if (tn !== null) return [60 + tn[0], tn[1]];
      }
      if (chain(s + 1) === 'et' && chain(s + 2) === 'un') return [tens + 1, s + 3];
      const u = unit(s + 1, 1);
      return u !== undefined ? [tens + u, s + 2] : [tens, s + 1];
    }
    if (w === 'quatre' && (chain(s + 1) === 'vingt' || chain(s + 1) === 'vingts')) {
      const tn = teen(s + 2);
      if (tn !== null) return [80 + tn[0], tn[1]];
      const u = unit(s + 2, 1);
      return u !== undefined ? [80 + u, s + 3] : [80, s + 2];
    }
    if (w === 'dix' || TEEN_WORDS[w] !== undefined) return teen(s);
    const u = UNIT_WORDS[w];
    return u === undefined ? null : [u, s + 1];
  };
  const scaled = (s: number, words: Set<string>, factor: number): [number, number] | null => {
    const w = chain(s);
    if (w === undefined) return null;
    if (words.has(w)) return [factor, s + 1];
    const next = chain(s + 1);
    if (next === undefined || !words.has(next)) return null;
    const u = unit(s, next === 'thousand' || next === 'hundred' ? 1 : 2);
    return u === undefined ? null : [u * factor, s + 2];
  };
  /**
   * BR109, comme RC72 au bouclier : en lecture `split`, un nombre composé de `s` à `n[1]` dont le dernier mot est un
   * chiffre de deux à neuf suivi sans pause de « mille » ou « cent » rend ce chiffre au groupe suivant :
   * « quatre-vingt-dix sept mille » se lit 90 puis 7000, « deux cent trente six mille » 230 puis 6000.
   */
  const handBack = (s: number, n: [number, number]): [number, number] => {
    if (!split || n[1] - 1 <= s || !isMultiplier(chain(n[1]))) return n;
    const last = UNIT_WORDS[t[n[1] - 1]!.word];
    return last !== undefined && last >= 2 ? [n[0] - last, n[1] - 1] : n;
  };
  const w = t[i]!.word;
  const repeat = REPEAT_WORDS[w];
  if (repeat !== undefined) {
    const u = unit(i + 1, 0);
    return u !== undefined ? [String(u).repeat(repeat), i + 2] : null;
  }
  const th = scaled(i, THOUSAND_WORDS, 1000);
  const hu = scaled(th === null ? i : th[1], HUNDRED_WORDS, 100);
  if (th !== null || hu !== null) {
    let value = (th?.[0] ?? 0) + (hu?.[0] ?? 0);
    let k = hu?.[1] ?? th![1];
    const afterAnd = hu !== null && chain(k) === 'and' ? k + 1 : k;
    const read = below100(afterAnd);
    const rest = read === null ? null : handBack(afterAnd, read);
    const opensNext = rest !== null && rest[1] === afterAnd + 1 && isMultiplier(chain(rest[1]));
    if (rest !== null && rest[0] > 0 && !opensNext) {
      value += rest[0];
      k = rest[1];
    }
    return [String(value), k];
  }
  const n = below100(i);
  return n === null ? null : [String(n[0]), n[1]];
}

/** Un texte relu, et pour chacun de ses caractères la plage `[début, fin[` du texte d'origine dont il vient. */
interface Mapped { text: string; start: number[]; end: number[] }

function mapped(): Mapped & { push: (s: string, a: number, b: number) => void } {
  const m = { text: '', start: [] as number[], end: [] as number[] };
  return Object.assign(m, {
    push(s: string, a: number, b: number): void {
      m.text += s;
      for (let q = 0; q < s.length; q += 1) {
        m.start.push(a);
        m.end.push(b);
      }
    },
  });
}

/**
 * BR107 : les caractères qui ne se voient pas, comme le bouclier (RC70) : tous ceux qu'Unicode dit ignorables par
 * défaut, et les marques de direction en plus.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu;

/** BR107 : les lettres grecques et cyrilliques qui ont l'air d'une lettre latine, et cette lettre, comme le bouclier. */
const LOOKALIKE: Record<string, string> = {
  // cyrillique
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
  'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Ԛ': 'Q',
  'Ԝ': 'W', 'Ӏ': 'I',
  // grec
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M',
  'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'ο': 'o', 'α': 'a',
  'ν': 'v', 'ρ': 'p', 'ι': 'i',
  // latin de détour
  'ı': 'i', 'ɑ': 'a', 'ɡ': 'g',
};

/** Une lettre latine (accentuée comprise), un chiffre ASCII ou un accent posé : ce qu'un mot démasqué peut garder. */
const LATIN = /[A-Za-z0-9À-ɏ̀-ͯ]/;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const WORD = /[\p{L}\p{M}\p{N}]+/uy;

/**
 * BR107 : le texte tel que l'œil le lit, comme `unmasked` du bouclier (RC70), avec la place d'origine de chaque
 * caractère. Forme normale de compatibilité (« 𝐑𝐈𝐁 », « ＦＲ７６ » deviennent « RIB », « FR76 ») ; caractères
 * invisibles ôtés ; dans un mot fait seulement de lettres latines, de chiffres et de sosies, qui porte au moins un sosie,
 * chaque sosie devient sa lettre latine. Un vrai mot russe ou grec garde ses lettres. Parcours linéaire.
 */
export function seenMapped(text: string): { text: string; start: number[]; end: number[] } {
  const p = mapped();
  let i = 0;
  for (const cp of text) {
    p.push(cp.normalize('NFKC').replace(INVISIBLE, ''), i, i + cp.length);
    i += cp.length;
  }
  const out = mapped();
  let k = 0;
  while (k < p.text.length) {
    if (!WORD_CHAR.test(p.text[k]!)) {
      out.push(p.text[k]!, p.start[k]!, p.end[k]!);
      k += 1;
      continue;
    }
    WORD.lastIndex = k;
    const j = k + WORD.exec(p.text)![0].length;
    let swapped = false;
    let foreign = false;
    for (const c of p.text.slice(k, j)) {
      if (LOOKALIKE[c] !== undefined) swapped = true;
      else if (!LATIN.test(c)) foreign = true;
    }
    const swap = swapped && !foreign;
    for (let q = k; q < j; q += 1) out.push(swap ? (LOOKALIKE[p.text[q]!] ?? p.text[q]!) : p.text[q]!, p.start[q]!, p.end[q]!);
    k = j;
  }
  return { text: out.text, start: out.start, end: out.end };
}

/** BR107 : le texte tel que l'œil le lit (voir `seenMapped`). */
export function unmaskedText(text: string): string {
  return seenMapped(text).text;
}

/**
 * Le texte en forme normale de compatibilité (« ＦＲ７６ » devient « FR76 »), accents ôtés, apostrophes droites,
 * caractère par caractère pour garder la place de chacun dans le texte d'origine ; si `seen` est donné, c'est lui qui
 * est lu, le texte tel que l'œil le voit (BR107).
 */
function normalized(text: string, seen: Mapped | null): Mapped {
  const unmask = seen !== null;
  const src: Mapped = seen ?? { text, start: [], end: [] };
  const out = mapped();
  let i = 0;
  for (const cp of src.text) {
    const n = cp.normalize('NFKC').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'");
    if (unmask) out.push(n, src.start[i]!, src.end[i + cp.length - 1]!);
    else out.push(n, i, i + cp.length);
    i += cp.length;
  }
  return out;
}

/** Un sosie de chiffre dans un morceau qui porte déjà un chiffre, ou dans une lettre seule : O ou o pour 0, l pour 1. */
function unmaskLookalikes(word: string): string {
  if (word.length > 1 && !/[0-9]/.test(word)) return word;
  return word.replace(/[Oo]/g, '0').replace(/l/g, '1');
}

/**
 * Le texte relu comme le bouclier le relit (nombres en mots remis en chiffres, et, si `lookalikes`, sosies de chiffres
 * aussi, en majuscules), avec la place d'origine de chaque caractère. Un nombre en mots tient toute la plage de ses mots.
 */
function digitsRewritten(text: string, lookalikes: boolean, seen: Mapped | null, split = false): Mapped {
  const p = normalized(text, seen);
  const from = (a: number, b: number): [number, number] => [p.start[a]!, p.end[b - 1]!];
  const tokens: Token[] = [];
  const re = /([\p{L}\p{N}]+)|([^\p{L}\p{N}]+)/gu;
  let sep = '';
  let sepStart = 0;
  for (let m = re.exec(p.text); m !== null; m = re.exec(p.text)) {
    if (m[1] !== undefined) {
      tokens.push({ word: m[1].toLowerCase(), raw: m[1], sep, sepStart, start: m.index, end: m.index + m[1].length });
      sep = '';
      sepStart = m.index + m[1].length;
    } else {
      sep = m[2]!;
      sepStart = m.index;
    }
  }
  const out = mapped();
  const pushSep = (s: string, at: number): void => {
    for (let q = 0; q < s.length; q += 1) out.push(s[q]!.toUpperCase(), ...from(at + q, at + q + 1));
  };
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const n = numberAt(tokens, i, split);
    pushSep(tok.sep, tok.sepStart);
    if (n !== null) {
      out.push(n[0], ...from(tok.start, tokens[n[1] - 1]!.end));
      i = n[1];
    } else {
      const word = lookalikes ? unmaskLookalikes(tok.raw) : tok.raw;
      // Un morceau collé qui porte un chiffre est coupé par quatre, comme un IBAN écrit par groupes.
      const inFours = word.length > 4 && /[0-9]/.test(word);
      for (let q = 0; q < word.length; q += 1) {
        const span = from(tok.start + q, tok.start + q + 1);
        out.push(word[q]!.toUpperCase(), ...span);
        if (inFours && q % 4 === 3 && q + 1 < word.length) out.push(' ', ...span);
      }
      i += 1;
    }
  }
  pushSep(sep, sepStart);
  return out;
}

/** Les plages réunies, triées, sans chevauchement. */
function merged(spans: Span[]): Span[] {
  const sorted = [...spans].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Span[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Les plages `[début, fin[` du texte d'origine qui portent un IBAN épelé, dicté en mots ou déguisé par des sosies ;
 * un nombre dit en mots est pris en entier. Rien si le texte n'en porte pas.
 */
export function hiddenIbanSpans(text: string): Span[] {
  const spans: Span[] = [...spelledIbanSpans(text)];
  const seen = seenMapped(text);
  const sources: (Mapped | null)[] = seen.text === text ? [null] : [null, seen];
  if (seen.text !== text) for (const [a, b] of spelledIbanSpans(seen.text)) spans.push([seen.start[a]!, seen.end[b - 1]!]);
  for (const source of sources) {
    for (const lookalikes of [false, true]) {
      const r = digitsRewritten(text, lookalikes, source);
      for (const [a, b] of spelledIbanSpans(r.text)) spans.push([r.start[a]!, r.end[b - 1]!]);
      // BR109 : la seconde lecture de RC72, relue seulement si elle change quelque chose.
      const split = digitsRewritten(text, lookalikes, source, true);
      if (split.text !== r.text) for (const [a, b] of spelledIbanSpans(split.text)) spans.push([split.start[a]!, split.end[b - 1]!]);
    }
  }
  return merged(spans);
}
