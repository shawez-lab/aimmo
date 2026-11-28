import { expect, it } from 'vitest';
import { dictatedIban, fundSignals } from '../src/dossiers/bouclier.ts';
import { expectLinear } from './lineaire.ts';

// RC68 : un IBAN dicté en mots, ou écrit avec des sosies de chiffres. IBAN inventés : la clé est calculée ici.

function withKey(country: string, bban: string): string {
  const s = `${bban}${country}00`.toUpperCase();
  let r = 0;
  for (const ch of s) {
    const v = ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return `${country}${String(98 - r).padStart(2, '0')}${bban}`;
}

const FR = withKey('FR', '30006000011234567890189');
const BE = withKey('BE', '539007547034');
const DE = withKey('DE', '370400440532013000');
const wrongKey = (iban: string): string => `${iban.slice(0, 2)}${iban[2] === '9' ? '0' : '9'}${iban.slice(3)}`;

const FR_DIGITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
const EN_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** Chaque caractère dit à part : les lettres telles quelles, les chiffres en mots. */
const sayEach = (iban: string, words: string[], sep = ' '): string =>
  iban.split('').map((c) => (c >= '0' && c <= '9' ? words[Number(c)]! : c)).join(sep);

const TENS: Record<number, string> = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante' };
const TEENS = ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
/** Un nombre de 10 à 99 en français écrit, avec traits d'union. */
function frNumber(n: number): string {
  if (n < 10) return FR_DIGITS[n]!;
  if (n < 20) return TEENS[n - 10]!;
  if (n < 70) {
    const t = TENS[Math.floor(n / 10)]!;
    const u = n % 10;
    return u === 0 ? t : u === 1 ? `${t} et un` : `${t}-${FR_DIGITS[u]}`;
  }
  if (n < 80) return n === 71 ? 'soixante et onze' : `soixante-${TEENS[n - 70]}`;
  if (n === 80) return 'quatre-vingts';
  return n < 90 ? `quatre-vingt-${FR_DIGITS[n - 80]}` : `quatre-vingt-${TEENS[n - 90]}`;
}
/** L'IBAN dit par paires, comme au téléphone : « F R soixante-seize trente zéro zéro six… ». */
function sayPairs(iban: string): string {
  const out: string[] = [iban[0]!, iban[1]!];
  const rest = iban.slice(2);
  for (let k = 0; k < rest.length; k += 2) {
    const pair = rest.slice(k, k + 2);
    if (!/^\d+$/.test(pair)) out.push(...pair.split('').map((c) => (/\d/.test(c) ? FR_DIGITS[Number(c)]! : c)));
    else if (pair.length === 1 || pair[0] === '0') out.push(...pair.split('').map((c) => FR_DIGITS[Number(c)]!));
    else out.push(frNumber(Number(pair)));
  }
  return out.join(', ');
}

it('[R62] un IBAN dicté chiffre par chiffre en mots alerte, accents ou non, majuscules ou non', () => {
  for (const iban of [FR, BE, DE]) {
    const cases = [
      `Voici pour la suite : ${sayEach(iban, FR_DIGITS)}. Merci`,
      sayEach(iban, FR_DIGITS).replace(/é/g, 'e'),
      sayEach(iban, FR_DIGITS).toUpperCase(),
      sayEach(iban, FR_DIGITS, ', '),
      `${iban.slice(0, 2).toLowerCase()} ${sayEach(iban.slice(2), FR_DIGITS, ' - ')}`,
    ];
    for (const t of cases) {
      expect([t, dictatedIban(t)]).toEqual([t, true]);
      expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining(['iban'])]);
    }
  }
});

it('[R62] un IBAN dicté par paires, « soixante-seize », « quatre-vingt-dix-sept », « vingt et un », alerte', () => {
  for (const iban of [FR, BE, DE, withKey('FR', '76219716806999371580021'), withKey('FR', '81719110220171804493212')]) {
    const t = `Pour le dépôt, c'est ${sayPairs(iban)}.`;
    expect([t, dictatedIban(t)]).toEqual([t, true]);
    expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining(['iban'])]);
    const spaced = sayPairs(iban).replace(/-/g, ' ');
    expect([spaced, dictatedIban(spaced)]).toEqual([spaced, true]);
  }
});

it('[R62] « double zéro » et « triple zéro » sont lus', () => {
  const t = `F R ${sayEach(FR.slice(2, 5), FR_DIGITS)} triple zéro six double zéro ${sayEach(FR.slice(12), FR_DIGITS)}`;
  expect(FR.slice(5, 12)).toBe('0006000');
  expect([t, dictatedIban(t)]).toEqual([t, false]);
  const ok = `F R ${sayEach(FR.slice(2, 5), FR_DIGITS)} triple zéro six triple zéro ${sayEach(FR.slice(12), FR_DIGITS)}`;
  expect([ok, dictatedIban(ok)]).toEqual([ok, true]);
  const dbl = `F R ${sayEach(FR.slice(2, 5), FR_DIGITS)} double zéro zéro six double zéro zéro ${sayEach(FR.slice(12), FR_DIGITS)}`;
  expect([dbl, dictatedIban(dbl)]).toEqual([dbl, true]);
});

it('[R62] un IBAN dicté en anglais alerte', () => {
  for (const iban of [FR, BE, DE]) {
    const t = `Please use ${sayEach(iban, EN_DIGITS)} today`;
    expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining(['iban'])]);
  }
});

it('[R62] la lettre O pour zéro, le l pour un, collés ou épelés, et les chiffres pleine chasse alertent', () => {
  const sosie = (s: string): string => s.replace(/0/g, 'O').replace(/1/g, 'l');
  const full = (s: string): string =>
    s.replace(/[0-9A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  const cases = [
    `Le compte : ${sosie(FR)}`,
    `Le compte : ${FR.slice(0, 4)} ${sosie(FR.slice(4)).replace(/(.{4})/g, '$1 ')}`,
    `Le compte : ${sosie(FR).split('').join(' ')}`,
    `Le compte : ${full(FR)}`,
    `Le compte : ${full(FR).split('').join(' ')}`,
    `Le compte : ${sosie(BE).toLowerCase()}`,
  ];
  for (const t of cases) {
    expect([t, dictatedIban(t)]).toEqual([t, true]);
    expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining(['iban'])]);
  }
});

it('aucune alerte sur une clé fausse, des nombres en mots ordinaires, un téléphone dicté', () => {
  const cases = [
    sayEach(wrongKey(FR), FR_DIGITS),
    sayPairs(wrongKey(DE)),
    'Deux chambres, trois salles de bain, un garage et quatre-vingt-dix mètres carrés.',
    'Rendez-vous le six mars à neuf heures, ou le vingt et un à dix-sept heures trente.',
    'Mon numéro : zéro six, douze, trente-quatre, cinquante-six, soixante-dix-huit.',
    'zéro six un deux trois quatre cinq six sept huit',
    'Lot B deux, étage trois, porte un, code quatre cinq six sept.',
    'Il y a onze ans, au quarante-deux rue Fictive, double vitrage, triple exposition.',
    'Le bureau est ouvert de 9 h à 18 h, sauf le lundi, salle O1, couloir l2.',
    'Ref FR 2024 OO1 lot l2',
  ];
  for (const t of cases) {
    expect([t, dictatedIban(t)]).toEqual([t, false]);
    expect([t, fundSignals(t).includes('iban')]).toEqual([t, false]);
  }
});

it('lecture linéaire : 40 000 caractères de mots en nombres, sans emballement', () => {
  const chunks = ['soixante-dix-sept', 'quatre-vingt-dix-neuf', 'double', 'zéro', 'vingt et un', 'O', 'l', 'F', 'R', 'et'];
  const build = (n: number): string => {
    let t = '';
    let k = 0;
    while (t.length < n) t += `${chunks[k++ % chunks.length]} `;
    return t;
  };
  expectLinear(build, (t) => {
    dictatedIban(t);
    fundSignals(t);
  });
});

it('[R62] un L ou un O vrais d\'un compte, ou d\'un code de pays épelé, ne sont pas pris pour des chiffres', () => {
  const withL = withKey('FR', '3000600001L234567890189');
  const t = sayEach(withL, FR_DIGITS);
  expect([t, dictatedIban(t)]).toEqual([t, true]);
  for (const iban of [withKey('PL', '109010140000071219812874'), withKey('NO', '86011117947'), withKey('LU', '0019400644750000'), withKey('NL', 'ABNA0417164300')]) {
    const s = sayEach(iban, FR_DIGITS);
    expect([s, dictatedIban(s)]).toEqual([s, true]);
  }
});

it('un début d\'IBAN dicté trop court, ou d\'un pays inconnu, n\'alerte pas', () => {
  for (const t of [
    'FR99 un deux trois quatre cinq six sept huit neuf zéro',
    'ZZ99 un deux trois quatre cinq six sept huit neuf zéro un deux trois quatre cinq six sept huit neuf zéro un deux trois',
  ]) {
    expect([t, dictatedIban(t)]).toEqual([t, false]);
    expect([t, fundSignals(t).includes('iban')]).toEqual([t, false]);
  }
  // Un groupe collé à sosie : la relecture exige toujours la clé (la lecture du socle, elle, reste celle de N09).
  expect(dictatedIban('FR99 1234 5678 9O12')).toBe(false);
});

it('un IBAN écrit normalement reste lu, et rien ne change sans IBAN', () => {
  expect(fundSignals(`Le compte ${FR}`)).toContain('iban');
  expect(fundSignals('Bonjour, la visite est confirmée pour samedi.')).toEqual([]);
});
