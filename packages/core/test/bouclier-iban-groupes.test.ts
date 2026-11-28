import { expect, it } from 'vitest';
import { dictatedIban, fundSignals } from '../src/dossiers/bouclier.ts';
import { expectLinear } from './lineaire.ts';

// RC69 : un IBAN dicté par groupes de quatre, « trois mille, six mille, zéro zéro zéro un… ». IBAN inventés : la clé
// est calculée ici.

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
const TENS: Record<number, string> = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante' };
const TEENS = ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];

/** Un nombre de 1 à 99 en français écrit, avec traits d'union. */
function below100(n: number): string {
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

/** Un nombre de 1 à 9 999 en français écrit ; `dash` relie tout par des traits d'union (orthographe de 1990). */
function frNumber(n: number, dash = false): string {
  const parts: string[] = [];
  const th = Math.floor(n / 1000);
  const h = Math.floor((n % 1000) / 100);
  const r = n % 100;
  if (th > 0) parts.push(th === 1 ? 'mille' : `${FR_DIGITS[th]} mille`);
  if (h > 0) parts.push(h === 1 ? 'cent' : `${FR_DIGITS[h]} ${r === 0 ? 'cents' : 'cent'}`);
  if (r > 0) parts.push(below100(r));
  const s = parts.join(' ');
  return dash ? s.replace(/ /g, '-') : s;
}

/** Un groupe de quatre chiffres dit comme au téléphone : les zéros de tête un par un, puis le nombre. */
function sayGroup(group: string, dash = false): string {
  if (!/^\d+$/.test(group)) return group.split('').map((c) => (/\d/.test(c) ? FR_DIGITS[Number(c)]! : c)).join(' ');
  const lead = /^0*/.exec(group)![0];
  const rest = group.slice(lead.length);
  const words = lead.split('').map(() => 'zéro');
  if (rest.length > 0) words.push(frNumber(Number(rest), dash));
  return words.join(' ');
}

/** L'IBAN dit par groupes de quatre : « F R soixante-seize, trois mille, six mille… ». */
function sayGroups(iban: string, dash = false, sep = ', '): string {
  const key = Number(iban.slice(2, 4));
  const head = `${iban[0]} ${iban[1]} ${key < 10 ? `zéro ${FR_DIGITS[key]}` : below100(key)}`;
  const groups = iban.slice(4).match(/.{1,4}/g)!;
  return [head, ...groups.map((g) => sayGroup(g, dash))].join(sep);
}

/** Un nombre de 1 à 9 999 en anglais, chiffres des dizaines dits un par un après « hundred and ». */
function enNumber(n: number): string {
  const parts: string[] = [];
  const th = Math.floor(n / 1000);
  const h = Math.floor((n % 1000) / 100);
  const r = n % 100;
  if (th > 0) parts.push(`${EN_DIGITS[th]} thousand`);
  if (h > 0) parts.push(`${EN_DIGITS[h]} hundred`);
  if (r > 0) parts.push(`${parts.length > 0 ? 'and ' : ''}${r < 10 ? EN_DIGITS[r] : `${EN_DIGITS[Math.floor(r / 10)]} ${EN_DIGITS[r % 10]}`}`);
  return parts.join(' ');
}
function sayGroupsEn(iban: string): string {
  const head = `${iban[0]} ${iban[1]} ${EN_DIGITS[Number(iban[2])]} ${EN_DIGITS[Number(iban[3])]}`;
  const groups = iban.slice(4).match(/.{1,4}/g)!;
  return [
    head,
    ...groups.map((g) => {
      if (!/^\d+$/.test(g)) return g.split('').join(' ');
      const lead = /^0*/.exec(g)![0];
      const rest = g.slice(lead.length);
      const words = lead.split('').map(() => 'zero');
      if (rest.length > 0) {
        // Les dizaines anglaises ne sont pas lues : un groupe qui en porte se dit chiffre par chiffre.
        const n = Number(rest);
        words.push(n >= 100 && (n % 100 < 10) ? enNumber(n) : rest.split('').map((c) => EN_DIGITS[Number(c)]!).join(' '));
      }
      return words.join(' ');
    }),
  ].join(', ');
}

it('le test parle bien : les groupes du FR se disent « trois mille », « six mille », « zéro zéro zéro un »', () => {
  const said = sayGroups(FR);
  expect(said).toContain('trois mille');
  expect(said).toContain('six mille');
  expect(said).toContain('zéro cent douze');
  expect(said).toContain('trois mille quatre cent cinquante-six');
  expect(frNumber(3412)).toBe('trois mille quatre cent douze');
  expect(frNumber(200)).toBe('deux cents');
  expect(frNumber(9999)).toBe('neuf mille neuf cent quatre-vingt-dix-neuf');
});

it('[R62] un IBAN dicté par groupes de quatre, avec « mille », « cent », « cents », alerte', () => {
  for (const iban of [FR, BE, DE]) {
    const cases = [
      `Pour le dépôt, voici le compte : ${sayGroups(iban)}. Merci`,
      sayGroups(iban, true),
      sayGroups(iban).replace(/é/g, 'e'),
      sayGroups(iban).toUpperCase(),
      sayGroups(iban, false, '\n'),
    ];
    for (const text of cases) {
      expect(dictatedIban(text), text).toBe(true);
      expect(fundSignals(text), text).toContain('iban');
    }
  }
});

it('[R62] chaque nombre de 100 à 9 999 est lu dans un groupe', () => {
  // Un IBAN belge porte trois groupes : chaque nombre y est mis à son tour en tête du deuxième groupe.
  for (let n = 100; n <= 9999; n += 37) {
    const group = String(n).padStart(4, '0');
    const iban = withKey('BE', `5390${group}7034`);
    const said = sayGroups(iban);
    expect(dictatedIban(said), said).toBe(true);
  }
  for (const n of [100, 101, 200, 1000, 1001, 1100, 2000, 2026, 9000, 9100, 9999]) {
    const iban = withKey('BE', `5390${String(n).padStart(4, '0')}7034`);
    for (const dash of [false, true]) expect(dictatedIban(sayGroups(iban, dash)), String(n)).toBe(true);
  }
});

it('[R62] des groupes dits sans aucune pause, « trois mille six mille », restent deux groupes', () => {
  const text = sayGroups(FR, false, ' ');
  expect(text).toContain('trois mille six mille');
  expect(dictatedIban(text), text).toBe(true);
});

it('[R62] « mil » et « mille un » sont lus aussi', () => {
  const iban = withKey('BE', '539010017034');
  const said = sayGroups(iban);
  expect(said).toContain('mille un');
  expect(dictatedIban(said)).toBe(true);
  const iban2 = withKey('BE', '539019007034');
  expect(dictatedIban(sayGroups(iban2).replace('mille', 'mil'))).toBe(true);
});

it('[R62] des groupes mêlés à des chiffres dits un par un et à des paires alertent', () => {
  const g = FR.slice(4).match(/.{1,4}/g)!;
  const text =
    `${sayGroups(FR).split(', ')[0]}, ${sayGroup(g[0]!)}, six zéro zéro zéro, ${sayGroup(g[2]!)}, trente-quatre ` +
    `cinquante-six, ${g[4]!.split('').map((c) => FR_DIGITS[Number(c)]).join(' ')}, ${sayGroup(g[5]!)}`;
  expect(dictatedIban(text), text).toBe(true);
  expect(fundSignals(text)).toContain('iban');
});

it('[R62] un IBAN dicté par groupes en anglais alerte', () => {
  for (const iban of [FR, BE, DE]) {
    const said = sayGroupsEn(iban);
    expect(dictatedIban(said), said).toBe(true);
  }
  expect(sayGroupsEn(FR)).toContain('three thousand');
  const iban = withKey('BE', '539002057034');
  expect(sayGroupsEn(iban)).toContain('two hundred and five');
  expect(dictatedIban(sayGroupsEn(iban))).toBe(true);
});

it('aucune alerte sur une clé fausse ni sur des nombres ordinaires en mots', () => {
  for (const iban of [FR, BE, DE]) expect(dictatedIban(sayGroups(wrongKey(iban))), iban).toBe(false);
  for (const text of [
    'Le prix est de trois cent mille euros, frais de notaire en plus.',
    'Signature prévue en deux mille vingt-six, le six mars à neuf heures.',
    'Je suis d\'accord à cent pour cent, mille mercis pour la visite.',
    'Deux cents mètres de la gare, trois mille euros de charges par an, neuf cent quatre-vingt-dix-neuf euros de taxe.',
    'Le terrain fait mille deux cents mètres carrés, la maison cent vingt.',
    'F R soixante-seize, trois mille, six mille.',
  ]) {
    expect(dictatedIban(text), text).toBe(false);
    expect(fundSignals(text), text).not.toContain('iban');
  }
});

it('lecture linéaire : 40 000 caractères de mots en nombres, sans emballement', () => {
  const chunk = 'neuf mille neuf cent quatre-vingt-dix-neuf trois cents mil cent and hundred thousand ';
  const build = (n: number): string => chunk.repeat(Math.ceil(n / chunk.length)).slice(0, n);
  expect(dictatedIban(build(40_000))).toBe(false);
  expectLinear(build, dictatedIban);
});
