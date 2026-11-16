/**
 * Aucun fonds, bouclier contre le faux RIB (M10, N05) [R01 à R05, R13, R15, R18, R62]. Jamais vu.
 *
 * AIMMO ne reçoit jamais de fonds : ni séquestre, ni acompte, aucune table ni route ne suit de l'argent. Deux gardes :
 *
 * - en sortie, `fundsInOutgoing` refuse tout texte d'AIMMO à un client ou au notaire qui porte un IBAN, un RIB, un BIC,
 *   des coordonnées bancaires données, ou qui demande de payer ; les relances de M10 passent par elle ;
 * - en entrée, `scan` lit chaque message reçu d'une partie d'un dossier en cours (vendeur ou acquéreur, fiches réunies
 *   comprises) : s'il parle de virement, d'acompte, de séquestre, de RIB ou de changement de coordonnées bancaires, ou
 *   s'il porte un IBAN, une alerte part aussitôt à l'agent du bien, une seule par message ; seules les sortes de
 *   signaux sont rangées, jamais le texte ni l'IBAN, et rien n'est lu par une IA [R15]. Le client reçoit, par le
 *   contrôle central, dans les heures d'envoi, le rappel écrit qu'AIMMO ne demande jamais de fonds ni de changement
 *   de coordonnées bancaires.
 *
 * C'est la fraude la plus coûteuse d'une vente : un faux mail du « notaire » ou de l'« agence » qui donne un nouveau
 * RIB. Aucun réseau ni logiciel ne surveille ainsi toute la vente.
 *
 * Décidé, lecture prudente : le rappel part une fois par personne et par dossier (sujet `rappel_fonds:<dossier>`),
 * pour ne pas noyer le client ; une alerte de l'agent part à chaque message suspect ; un rappel refusé pour l'heure
 * repart au passage suivant. `scan` est branché à la réception des messages, et l'IBAN est masqué dans le message
 * rangé avant même son rattachement (N09) : le bouclier lit le masque comme un IBAN.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { IBAN, IBAN_MASK, fundsInOutgoing, plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { actorOf, type FileRefusal } from './acces-dossier.ts';
import { SALE_FOLLOW_UP_PURPOSE } from './relances.ts';
import { openFile } from './acces-dossier.ts';

export type FundSignal = 'iban' | 'coordonnees_bancaires' | 'virement' | 'acompte' | 'sequestre' | 'paiement';

// Les formes courantes, pluriels et impératifs compris. « Règlement » seul ne compte pas : règlement de copropriété.
// RC66 : aussi les détours des escrocs (domiciliation, banque changée, transfert, dépôt chiffré, moyens de détour,
// anglais). Le transfert de propriété, de bail, des risques, des charges ou du dossier n'est pas un transfert de fonds.
const INBOUND: [FundSignal, RegExp][] = [
  ['coordonnees_bancaires', /\b(?:ribs?|bic|swift|iban|coordonnees bancaires|releve d'identite bancaire|nouveaux? comptes?|changement de (?:compte|banque|coordonnees)|autre compte|comptes? bancaires?|numero de compte|nouvelles? coordonnees|coordonnees (?:\w+ )?(?:ont |a )?change\w*|sur (?:le|ce|notre|un|leur|votre) (?:nouveau )?compte|compte ci-(?:joint|dessous|apres)|domiciliations? bancaires?|(?:references?|informations?|details?|donnees) bancaires|change(?:r|z|ons|nt)? de banque|nouvelles? banques?|coordonnees du compte|bank accounts?|bank details|account numbers?|sort codes?|routing numbers?|new account)\b/],
  ['virement', /\b(?:virements?|vire[rsz]?|virons|virent|transferts? de fonds|transfere[rsz]?|fonds(?! de commerce)|transferts?(?! d(?:e|u|es) (?:la )?(?:propriete|bail|risques?|charges|dossiers?)\b)|envo(?:yer|yez|yons|ie|ies) (?:l'argent|la somme|le montant|les fonds)|transfer(?:s|red|ring)?|wire[ds]?|wiring|funds|send (?:the )?money)\b/],
  ['acompte', /\b(?:acomptes?|arrhes|depots? de garantie|depots? (?:de|d'un montant de) \d+|deposits?)\b/],
  ['sequestre', /\b(?:sequestres?|consignation|escrow)\b/],
  ['paiement', /\b(?:paye[rsz]?|paie[sz]?|payons|paiements?|verse[rsz]?|versons|versements?|regle[rz]|reglons|regler la somme|reglement de la somme|frais a regler|proceder au reglement|cheques?|wero|paypal|lydia|western union|mandats? cash|cartes? cadeaux?|bitcoins?|cryptos?|cryptomonnaies?|usdt|payments?|pay|paid|paying)\b/],
];

const isLetter = (c: string | undefined): boolean => c !== undefined && c >= 'a' && c <= 'z';
const isSpellSep = (c: string | undefined): boolean => c === ' ' || c === '.' || c === '-';

/**
 * Un mot écrit lettre par lettre, « r.i.b », « r i b », « r-i-b » (trois lettres au moins, un même séparateur), recollé :
 * « rib ». Une lettre seule voisine peut se coller à la suite (« r i b a changé », « il y a r i b ») : `dropStart` et
 * `dropEnd` laissent à part une ou deux lettres de chaque bord. Parcours linéaire, chaque caractère lu au plus deux
 * fois, jamais une expression qui pourrait s'emballer [R62].
 */
function joinSpelled(p: string, dropStart: number, dropEnd: number): string {
  let out = '';
  let i = 0;
  while (i < p.length) {
    const sep = p[i + 1];
    if (isLetter(p[i]) && !isLetter(p[i - 1]) && isSpellSep(sep)) {
      let j = i;
      let word = p[i]!;
      while (p[j + 1] === sep && isLetter(p[j + 2]) && !isLetter(p[j + 3])) {
        word += p[j + 2]!;
        j += 2;
      }
      if (word.length >= 3 && word.length - dropStart - dropEnd >= 3) {
        const head = word.slice(0, dropStart).split('');
        const tail = dropEnd > 0 ? word.slice(-dropEnd).split('') : [];
        out += [...head, word.slice(dropStart, word.length - dropEnd), ...tail].join(' ');
        i = j + 1;
        continue;
      }
    }
    out += p[i]!;
    i += 1;
  }
  return out;
}

/**
 * RC67 : longueur de l'IBAN par code de pays (Europe, outre-mer français compris). Un IBAN épelé n'est reconnu que
 * sur un pays connu, à sa longueur exacte et avec une clé juste : un téléphone ou une référence épelés n'en sont pas.
 */
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

/** Dans une suite recollée, un IBAN qui commence au début d'un morceau et finit au bout d'un morceau, clé juste. */
function runHasIban(joined: string, starts: boolean[], ends: boolean[]): boolean {
  for (let k = 0; k + 4 <= joined.length; k += 1) {
    if (!starts[k]) continue;
    const length = IBAN_LENGTHS[joined.slice(k, k + 2)];
    if (length === undefined || !isAsciiDigit(joined[k + 2]) || !isAsciiDigit(joined[k + 3])) continue;
    const end = k + length;
    if (end > joined.length || !ends[end]) continue;
    // Aucun nombre de chiffres exigé : un compte suisse ou maltais peut être fait de lettres ; la clé suffit.
    if (ibanKeyOk(joined.slice(k, end))) return true;
  }
  return false;
}

/**
 * RC67 : un IBAN épelé ou coupé n'importe où, « F R 7 6 3 0 0 0 … », « f.r.7.6… », « FR 7 6 3000 … ». Un parcours
 * linéaire relève les suites de morceaux de 1 à 4 lettres ou chiffres, séparés par trois espaces, retours à la ligne,
 * points, tirets, virgules, barres ou soulignés au plus ; tout autre signe coupe la suite, et un morceau collé à une
 * lettre accentuée n'en fait pas partie. Chaque suite recollée est relue par `runHasIban`, chaque place au plus
 * 31 fois [R62].
 */
export function spelledIban(text: string): boolean {
  let joined = '';
  let starts: boolean[] = [];
  let ends: boolean[] = [];
  const flush = (): boolean => {
    const hit = joined.length >= 15 && runHasIban(joined, starts, ends);
    joined = '';
    starts = [];
    ends = [];
    return hit;
  };
  let i = 0;
  while (i < text.length) {
    if (!isAsciiAlnum(text[i])) {
      let k = i;
      while (k < text.length && isIbanSep(text[k])) k += 1;
      if (k === i || k - i > 3) {
        if (flush()) return true;
        if (k === i) k = i + 1;
      }
      i = k;
      continue;
    }
    let j = i;
    while (j < text.length && isAsciiAlnum(text[j])) j += 1;
    if (j - i > 4 || glued(text[i - 1]) || glued(text[j])) {
      if (flush()) return true;
      i = j;
      continue;
    }
    starts[joined.length] = true;
    joined += text.slice(i, j).toUpperCase();
    ends[joined.length] = true;
    i = j;
  }
  return flush();
}

/** RC68 : les chiffres dits en mots, en français et en anglais. « Une » n'en est pas un : « une chambre ». */
const UNIT_WORDS: Record<string, number> = {
  zero: 0, un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9,
};
const TEEN_WORDS: Record<string, number> = { dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16 };
const TENS_WORDS: Record<string, number> = { vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 };
const REPEAT_WORDS: Record<string, number> = { double: 2, triple: 3 };

interface Token { word: string; raw: string; sep: string }

/** Un mot d'un nombre composé ne se lie au précédent qu'à travers des espaces ou des traits d'union, trois au plus. */
const binds = (sep: string): boolean => sep.length > 0 && sep.length <= 3 && /^[ \-]+$/.test(sep);

/** RC69 : les mots qui multiplient, « mille » (et « mil ») et « cent », en français et en anglais. */
const THOUSAND_WORDS = new Set(['mille', 'mil', 'thousand']);
const HUNDRED_WORDS = new Set(['cent', 'cents', 'hundred']);
const isMultiplier = (w: string | undefined): boolean => w !== undefined && (THOUSAND_WORDS.has(w) || HUNDRED_WORDS.has(w));

/**
 * Un nombre en mots qui commence au mot `i` : ses chiffres et le mot qui le suit, ou rien. Chaque lecture regarde au
 * plus neuf mots plus loin : le parcours reste linéaire [R62]. Une virgule coupe toujours un nombre composé.
 */
function numberAt(t: Token[], i: number): [string, number] | null {
  const at = (k: number): string | undefined => (k < t.length && (k === i || binds(t[k]!.sep)) ? t[k]!.word : undefined);
  // Un mot plus loin, lié à chacun des précédents.
  const chain = (k: number): string | undefined => {
    for (let m = i + 1; m <= k; m += 1) if (at(m) === undefined) return undefined;
    return at(k);
  };
  const unit = (k: number, min: number): number | undefined => {
    const u = UNIT_WORDS[chain(k) ?? ''];
    return u !== undefined && u >= min ? u : undefined;
  };
  /** Après dix ou soixante : « dix-sept », « onze »… ; rend la valeur au-delà de la dizaine et le mot suivant. */
  const teen = (k: number): [number, number] | null => {
    const x = chain(k);
    if (x === 'dix') {
      const u = unit(k + 1, 7);
      return u !== undefined ? [10 + u, k + 2] : [10, k + 1];
    }
    if (x !== undefined && TEEN_WORDS[x] !== undefined) return [TEEN_WORDS[x]!, k + 1];
    return null;
  };
  /** Un nombre de zéro à quatre-vingt-dix-neuf au mot `s` : sa valeur et le mot suivant. */
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
  /**
   * RC69 : « mille » ou « cent » au mot `s`, précédés ou non de deux à neuf (de one à nine en anglais) : la valeur et le
   * mot suivant. « Un mille » et « un cent » ne se disent pas en français.
   */
  const scaled = (s: number, words: Set<string>, factor: number): [number, number] | null => {
    const w = chain(s);
    if (w === undefined) return null;
    if (words.has(w)) return [factor, s + 1];
    const next = chain(s + 1);
    if (next === undefined || !words.has(next)) return null;
    const u = unit(s, next === 'thousand' || next === 'hundred' ? 1 : 2);
    return u === undefined ? null : [u * factor, s + 2];
  };
  const w = t[i]!.word;
  const repeat = REPEAT_WORDS[w];
  if (repeat !== undefined) {
    const u = unit(i + 1, 0);
    return u !== undefined ? [String(u).repeat(repeat), i + 2] : null;
  }
  // RC69 : de 100 à 9 999, « trois mille », « deux cent trente-quatre », « mille un », « two hundred and five ».
  const th = scaled(i, THOUSAND_WORDS, 1000);
  const hu = scaled(th === null ? i : th[1], HUNDRED_WORDS, 100);
  if (th !== null || hu !== null) {
    let value = (th?.[0] ?? 0) + (hu?.[0] ?? 0);
    let k = hu?.[1] ?? th![1];
    const afterAnd = hu !== null && chain(k) === 'and' ? k + 1 : k;
    const rest = below100(afterAnd);
    // Un chiffre seul suivi de « mille » ou « cent » commence le groupe suivant : « trois mille six mille ».
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

/**
 * Un sosie de chiffre dans un morceau qui porte déjà un chiffre, ou dans une lettre seule : O ou o pour 0, l minuscule
 * pour 1. Le L majuscule reste une lettre (un compte peut en porter une).
 */
function unmaskLookalikes(word: string): string {
  if (word.length > 1 && !/[0-9]/.test(word)) return word;
  return word.replace(/[Oo]/g, '0').replace(/l/g, '1');
}

/** Un morceau collé qui porte un chiffre, coupé par quatre : `spelledIban` le lit alors comme un IBAN écrit par groupes. */
const inFours = (word: string): string => (word.length > 4 && /[0-9]/.test(word) ? word.replace(/(.{4})(?=.)/g, '$1 ') : word);

/**
 * RC68 : le texte relu pour l'IBAN, nombres en mots remis en chiffres, et, si `lookalikes`, sosies de chiffres aussi ;
 * en majuscules. Forme normale de compatibilité d'abord (« ＦＲ７６ » devient « FR76 »), accents ôtés, la casse gardée
 * jusqu'aux sosies. Ce qui n'est ni un nombre ni un sosie reste tel quel.
 */
function digitsRewritten(text: string, lookalikes: boolean): string {
  const p = text.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’`]/g, "'");
  const tokens: Token[] = [];
  const re = /([\p{L}\p{N}]+)|([^\p{L}\p{N}]+)/gu;
  let sep = '';
  for (let m = re.exec(p); m !== null; m = re.exec(p)) {
    if (m[1] !== undefined) {
      tokens.push({ word: m[1].toLowerCase(), raw: m[1], sep });
      sep = '';
    } else sep = m[2]!;
  }
  let out = '';
  let i = 0;
  while (i < tokens.length) {
    const n = numberAt(tokens, i);
    out += tokens[i]!.sep;
    if (n !== null) {
      out += n[0];
      i = n[1];
    } else {
      const raw = tokens[i]!.raw;
      out += inFours(lookalikes ? unmaskLookalikes(raw) : raw);
      i += 1;
    }
  }
  return (out + sep).toUpperCase();
}

/**
 * RC68 : un IBAN dicté en mots (« F R sept six trois zéro… », « FR soixante-seize, trente, zéro zéro six… », « double
 * zéro »), ou écrit avec des sosies de chiffres (O pour 0, l pour 1, chiffres pleine chasse). Le texte relu, avec et sans
 * les sosies, passe par `spelledIban` seul : pays, longueur exacte et clé restent exigés.
 */
export function dictatedIban(text: string): boolean {
  return spelledIban(digitsRewritten(text, false)) || spelledIban(digitsRewritten(text, true));
}

/**
 * RC70 : les caractères qui ne se voient pas, ôtés : tous ceux qu'Unicode dit ignorables par défaut (trait d'union
 * conditionnel, espaces de largeur nulle, joints, marques de direction, sélecteurs de variante, ceux du plan
 * supplémentaire compris, étiquettes, indicateur d'ordre des octets), et les marques de direction en plus.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu;

/** RC70 : les lettres grecques et cyrilliques qui ont l'air d'une lettre latine, et cette lettre. */
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

/**
 * RC70 : le texte tel que l'œil le lit. Forme normale de compatibilité (« ＲＩＢ », « 𝐑𝐈𝐁 » deviennent « RIB ») ;
 * caractères invisibles ôtés ; dans un mot fait seulement de lettres latines, de chiffres et de sosies, qui porte au
 * moins un sosie, chaque sosie devient sa lettre latine. Un vrai mot russe ou grec porte presque toujours une lettre
 * sans sosie : il reste tel quel. Chaque caractère est lu une fois [R62].
 */
export function unmasked(text: string): string {
  const p = text.normalize('NFKC').replace(INVISIBLE, '');
  return p.replace(/[\p{L}\p{M}\p{N}]+/gu, (word) => {
    let out = '';
    let swapped = false;
    for (const c of word) {
      const latin = LOOKALIKE[c];
      if (latin !== undefined) {
        out += latin;
        swapped = true;
      } else if (/[A-Za-z0-9À-ɏ̀-ͯ]/.test(c)) out += c;
      else return word;
    }
    return swapped ? out : word;
  });
}

/** Les signaux d'argent d'un message reçu, dans un ordre fixe, sans rien garder du texte. */
export function fundSignals(text: string): FundSignal[] {
  const seen = unmasked(text);
  const variants: string[] = [];
  for (const p of new Set([plain(text), plain(seen)])) {
    for (const ds of [0, 1, 2]) for (const de of [0, 1, 2]) {
      const v = joinSpelled(p, ds, de);
      if (!variants.includes(v)) variants.push(v);
    }
  }
  const found: FundSignal[] = [];
  const hasIban = (t: string): boolean => IBAN.test(t) || spelledIban(t) || dictatedIban(t);
  if (text.includes(IBAN_MASK) || hasIban(text) || (seen !== text && hasIban(seen))) found.push('iban');
  for (const [signal, re] of INBOUND) if (variants.some((v) => re.test(v))) found.push(signal);
  return found;
}

export { fundsInOutgoing };

/** Le rappel au client, écrit par le code, sans chiffre ni coordonnée. */
export function fundsReminderText(firstName: string | null, property: { city: string | null; reference: string } | null = null): string {
  // Le bien nommé par sa commune et sa référence d'agence, jamais son adresse [R19] : deux dossiers, deux messages [R05].
  const sale = property ? `la vente de votre bien${property.city ? ` à ${property.city}` : ''}, référence ${property.reference}` : 'votre vente';
  return `${firstName ? `Bonjour ${firstName},` : 'Bonjour,'} un rappel important pour ${sale} : votre agent immobilier ne vous demandera jamais de virement, d'acompte ni de changement de coordonnées bancaires, et ne reçoit jamais de fonds. L'argent de la vente passe seulement par le notaire. Au moindre doute sur un message, appelez votre notaire au numéro que vous connaissez déjà, avant tout paiement.`;
}

export interface FundAlert {
  messageId: string;
  fileId: string;
  propertyId: string;
  side: 'vendeur' | 'acquereur';
  signals: FundSignal[];
  createdAt: string;
  reminder: 'sent' | 'waiting' | 'refused' | 'failed' | null;
  reminderRule: string | null;
}

export class BouclierFonds {
  private readonly now: () => Date;
  private readonly unique: FicheUnique;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const fiches = new FicheClient(db, { now: this.now });
    this.unique = new FicheUnique(db, fiches, { now: this.now });
    this.controle = new ControleEnvois(db, this.unique, new DecisionEnvoi(db, fiches, this.unique, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  /**
   * Tous les dossiers en cours dont la personne est une partie, et de quel côté : une personne qui achète et vend à la
   * fois a deux dossiers, et chaque agent doit être prévenu.
   */
  private async filesOf(networkId: string, personId: string): Promise<{ id: string; property_id: string; agent_id: string; side: 'vendeur' | 'acquereur' }[]> {
    const ids = await this.unique.membersOf(personId);
    const marks = ids.map(() => '?').join(', ');
    const buyer = await this.db.all<{ id: string; property_id: string; agent_id: string | null }>(
      `SELECT f.id, f.property_id, p.agent_id FROM sale_files f JOIN properties p ON p.id = f.property_id
       WHERE f.network_id = ? AND p.status = 'under_offer' AND ${openFile('f')} AND f.buyer_person_id IN (${marks}) ORDER BY f.opened_at, f.id`,
      [networkId, ...ids],
    );
    const seller = await this.db.all<{ id: string; property_id: string; agent_id: string | null }>(
      `SELECT f.id, f.property_id, p.agent_id FROM sale_files f JOIN properties p ON p.id = f.property_id
       JOIN sale_file_sellers v ON v.file_id = f.id
       WHERE f.network_id = ? AND p.status = 'under_offer' AND ${openFile('f')} AND v.person_id IN (${marks})
       ORDER BY f.opened_at, f.id`,
      [networkId, ...ids],
    );
    return [
      ...buyer.filter((f) => f.agent_id).map((f) => ({ id: f.id, property_id: f.property_id, agent_id: f.agent_id!, side: 'acquereur' as const })),
      ...seller.filter((f) => f.agent_id).map((f) => ({ id: f.id, property_id: f.property_id, agent_id: f.agent_id!, side: 'vendeur' as const })),
    ];
  }

  /**
   * Lit un message reçu, rangé dans `messages`. Rend les signaux trouvés, ou null s'il n'y a rien à faire (message
   * sortant, personne hors d'un dossier en cours, aucun signal). Une alerte par message et par dossier de la personne,
   * même lu deux fois [R18].
   */
  async scan(messageId: string): Promise<FundSignal[] | null> {
    const m = await this.db.first<{ id: string; network_id: string; person_id: string; direction: string; body: string }>('SELECT id, network_id, person_id, direction, body FROM messages WHERE id = ?', [messageId]);
    if (!m || m.direction !== 'in') return null;
    const signals = fundSignals(m.body);
    if (signals.length === 0) return null;
    const files = await this.filesOf(m.network_id, m.person_id);
    if (files.length === 0) return null;
    for (const file of files) {
      const { changes } = await this.db.run(
        "INSERT INTO sale_file_fund_alerts (message_id, file_id, network_id, agent_id, person_id, side, signals, created_at, reminder_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting') ON CONFLICT (message_id, file_id) DO NOTHING",
        [m.id, file.id, m.network_id, file.agent_id, m.person_id, file.side, JSON.stringify(signals), this.now().toISOString()],
      );
      if (changes !== 1) continue;
      // Au journal : les sortes de signaux, jamais le texte, l'IBAN ni la coordonnée [R13, R15].
      await appendEvent(this.journal, { type: 'dossier.alerte_fonds', actor: 'system:dossiers', subject: `sale_file:${file.id}`, data: { rule: 'R62', message: `message:${m.id}`, side: file.side, client: `person:${m.person_id}`, signals } }, this.now);
    }
    for (const file of files) await this.remind(m.id, file.id);
    return signals;
  }

  /** Le rappel au client d'une alerte, par le contrôle central, en mode essai. */
  private async remind(messageId: string, fileId: string): Promise<void> {
    const a = await this.db.first<{ file_id: string; network_id: string; agent_id: string; person_id: string; side: string; reminder_status: string | null }>(
      'SELECT file_id, network_id, agent_id, person_id, side, reminder_status FROM sale_file_fund_alerts WHERE message_id = ? AND file_id = ?',
      [messageId, fileId],
    );
    if (!a || (a.reminder_status !== null && a.reminder_status !== 'waiting' && a.reminder_status !== 'failed')) return;
    const first = await ficheFirstName(this.db, await this.unique.membersOf(a.person_id));
    const property = await this.db.first<{ city: string | null; reference: string }>('SELECT p.city, p.reference FROM sale_files f JOIN properties p ON p.id = f.property_id WHERE f.id = ?', [a.file_id]);
    const text = fundsReminderText(first, property);
    if (fundsInOutgoing(text)) throw new Error('Le rappel du bouclier ne peut pas porter de coordonnée bancaire [R62].');
    const r = await this.controle.send({
      networkId: a.network_id,
      agentId: a.agent_id,
      personId: a.person_id,
      channel: 'email',
      kind: 'follow_up',
      purpose: SALE_FOLLOW_UP_PURPOSE,
      // Une fois par personne et par dossier [R05].
      subject: `rappel_fonds:${a.file_id}`,
      fallbackTexts: [text],
      figures: (property?.reference.match(/\d+/g) ?? []).map(Number),
    });
    const status = r.status === 'sent' ? 'sent' : r.status === 'failed' ? 'failed' : r.rule === 'R01' ? 'waiting' : 'refused';
    await this.db.run('UPDATE sale_file_fund_alerts SET reminder_status = ?, reminder_rule = ? WHERE message_id = ? AND file_id = ?', [status, r.status === 'sent' ? null : r.rule, messageId, fileId]);
    await appendEvent(this.journal, { type: 'dossier.rappel_fonds', actor: 'system:dossiers', subject: `sale_file:${a.file_id}`, data: { mode: 'essai', side: a.side, client: `person:${a.person_id}`, status, rule: r.status === 'sent' ? null : r.rule } }, this.now);
  }

  /**
   * Le filet : relit les messages reçus du réseau depuis `since` (une lecture déjà faite n'ajoute rien), et reprend les
   * rappels qui attendaient l'heure ou sont restés sans issue après une panne. Rend le nombre d'alertes nouvelles.
   */
  async run(networkId: string, since: Date): Promise<number> {
    const before = (await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sale_file_fund_alerts WHERE network_id = ?', [networkId]))!.n;
    const rows = await this.db.all<{ id: string }>("SELECT m.id FROM messages m WHERE m.network_id = ? AND m.direction = 'in' AND m.occurred_at >= ? ORDER BY m.occurred_at, m.id", [networkId, since.toISOString()]);
    for (const r of rows) await this.scan(r.id);
    for (const w of await this.db.all<{ message_id: string; file_id: string }>(`SELECT a.message_id, a.file_id FROM sale_file_fund_alerts a JOIN sale_files f ON f.id = a.file_id WHERE a.network_id = ? AND ${openFile('f')} AND (a.reminder_status IS NULL OR a.reminder_status IN ('waiting', 'failed'))`, [networkId])) await this.remind(w.message_id, w.file_id);
    return (await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sale_file_fund_alerts WHERE network_id = ?', [networkId]))!.n - before;
  }

  /** Les alertes de l'agent, pour lui seul, sur les biens qu'il suit ; chaque lecture au journal [R16]. */
  async alertsOf(viewer: Viewer): Promise<{ ok: true; alerts: FundAlert[] } | FileRefusal> {
    const refuse = async (code: string): Promise<FileRefusal> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: actorOf(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'sale_file_fund_alerts', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'agent') return refuse('not_agent');
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');
    const rows = await this.db.all<{ message_id: string; file_id: string; property_id: string; side: 'vendeur' | 'acquereur'; signals: string; created_at: string; reminder_status: FundAlert['reminder']; reminder_rule: string | null }>(
      `SELECT a.message_id, a.file_id, f.property_id, a.side, a.signals, a.created_at, a.reminder_status, a.reminder_rule FROM sale_file_fund_alerts a
       JOIN sale_files f ON f.id = a.file_id JOIN properties p ON p.id = f.property_id
       WHERE a.network_id = ? AND p.agent_id = ? AND ${openFile('f')} ORDER BY a.created_at DESC, a.message_id`,
      [viewer.networkId, viewer.userId],
    );
    const alerts = rows.map((r) => ({ messageId: r.message_id, fileId: r.file_id, propertyId: r.property_id, side: r.side, signals: JSON.parse(r.signals) as FundSignal[], createdAt: r.created_at, reminder: r.reminder_status, reminderRule: r.reminder_rule }));
    await appendEvent(this.journal, { type: 'dossier.alertes_fonds_lues', actor: actorOf(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R16', files: [...new Set(alerts.map((x) => `sale_file:${x.fileId}`))] } }, this.now);
    return { ok: true, alerts };
  }
}
