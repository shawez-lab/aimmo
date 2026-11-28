import { expect, it } from 'vitest';
import { dictatedIban, spelledIban } from '../src/dossiers/bouclier.ts';
import { hiddenIbanSpans } from '../src/envoi/iban-detours.ts';
import { IBAN, IBAN_MASK, bankDetailsIn, fundsInOutgoing, maskIban } from '../src/envoi/texte.ts';
import { expectLinear } from './lineaire.ts';

// BR106 : un IBAN épelé, dicté en mots ou déguisé par des sosies est masqué dans tout message rangé et refusé dans tout
// texte qui sort. IBAN inventés : la clé est calculée ici.

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
const CH = withKey('CH', '00762011623852957');
const ES = withKey('ES', '21000418450200051332');
const wrongKey = (iban: string): string => `${iban.slice(0, 2)}${iban[2] === '9' ? '0' : '9'}${iban.slice(3)}`;

const FR_DIGITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
const EN_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TENS: Record<number, string> = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante' };
const TEENS = ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];

const sayEach = (iban: string, words: string[], sep = ' '): string =>
  iban.split('').map((c) => (c >= '0' && c <= '9' ? words[Number(c)]! : c)).join(sep);

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

/** L'IBAN dit par paires : « F R soixante-seize trente zéro zéro six… ». */
function sayPairs(iban: string): string {
  const out: string[] = [iban[0]!, iban[1]!];
  const rest = iban.slice(2);
  for (let k = 0; k < rest.length; k += 2) {
    const pair = rest.slice(k, k + 2);
    if (!/^\d+$/.test(pair)) out.push(...pair.split('').map((c) => (/\d/.test(c) ? FR_DIGITS[Number(c)]! : c)));
    else if (pair.length === 1 || pair[0] === '0') out.push(...pair.split('').map((c) => FR_DIGITS[Number(c)]!));
    else out.push(below100(Number(pair)));
  }
  return out.join(' ');
}

function frNumber(n: number): string {
  const parts: string[] = [];
  const th = Math.floor(n / 1000);
  const h = Math.floor((n % 1000) / 100);
  const r = n % 100;
  if (th > 0) parts.push(th === 1 ? 'mille' : `${FR_DIGITS[th]} mille`);
  if (h > 0) parts.push(h === 1 ? 'cent' : `${FR_DIGITS[h]} ${r === 0 ? 'cents' : 'cent'}`);
  if (r > 0) parts.push(below100(r));
  return parts.join(' ');
}

/** L'IBAN dit par groupes de quatre, comme au téléphone : « F R soixante-seize, trois mille, six mille… ». */
function sayGroups(iban: string, sep = ', '): string {
  const key = Number(iban.slice(2, 4));
  const head = `${iban[0]} ${iban[1]} ${key < 10 ? `zéro ${FR_DIGITS[key]}` : below100(key)}`;
  const groups = iban.slice(4).match(/.{1,4}/g)!.map((g) => {
    if (!/^\d+$/.test(g)) return g.split('').map((c) => (/\d/.test(c) ? FR_DIGITS[Number(c)]! : c)).join(' ');
    const lead = /^0*/.exec(g)![0];
    const words = lead.split('').map(() => 'zéro');
    if (g.length > lead.length) words.push(frNumber(Number(g.slice(lead.length))));
    return words.join(' ');
  });
  return [head, ...groups].join(sep);
}

const sosie = (s: string): string => s.replace(/0/g, 'O').replace(/1/g, 'l');
const fullWidth = (s: string): string =>
  s.replace(/[0-9A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

/** Les écritures détournées d'un IBAN, épelées, dictées, déguisées. */
function detours(iban: string): string[] {
  return [
    iban.split('').join(' '),
    iban.toLowerCase().split('').join('.'),
    iban.split('').join('-'),
    iban.split('').join('\n'),
    `${iban.slice(0, 2)} ${iban.slice(2, 4).split('').join(' ')} ${iban.slice(4).match(/.{1,4}/g)!.join(' ')}`,
    sayEach(iban, FR_DIGITS),
    sayEach(iban, FR_DIGITS).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(),
    sayEach(iban, EN_DIGITS),
    sayPairs(iban),
    sayGroups(iban),
    sayGroups(iban, ' '),
    sosie(iban),
    sosie(iban).split('').join(' '),
    fullWidth(iban),
  ];
}

it('le test parle bien : chaque détour est lu par le bouclier, et aucun n\'est lu par la lecture de l\'IBAN collé', () => {
  for (const iban of [FR, BE, DE]) {
    for (const d of detours(iban)) expect(spelledIban(d) || dictatedIban(d), d).toBe(true);
  }
  expect(sayGroups(FR)).toContain('trois mille');
  expect(sayPairs(FR)).toContain('soixante');
});

it('[R15] un IBAN épelé, dicté ou déguisé est masqué en entier, le texte autour reste tel quel', () => {
  for (const iban of [FR, BE, DE, CH, ES]) {
    for (const d of detours(iban)) {
      // « cinq mille trois cent… » dit sans pause pour « 0005 1332 » est ambigu : le bouclier non plus ne le lit pas.
      if (!(spelledIban(d) || dictatedIban(d))) continue;
      const text = `Bonjour, voici le compte : ${d}. Merci, à demain.`;
      const masked = maskIban(text);
      expect(masked, text).toBe(`Bonjour, voici le compte : ${IBAN_MASK}. Merci, à demain.`);
      expect(spelledIban(masked) || dictatedIban(masked), masked).toBe(false);
    }
  }
});

it('[R15] deux IBAN détournés dans un même texte sont masqués tous les deux, et un IBAN écrit normalement aussi', () => {
  const text = `Ancien : ${sayGroups(FR)}. Nouveau : ${BE.split('').join(' ')}. Et ${DE}.`;
  expect(maskIban(text)).toBe(`Ancien : ${IBAN_MASK}. Nouveau : ${IBAN_MASK}. Et ${IBAN_MASK}.`);
});

it('[R15] un nombre en mots est masqué en entier, jamais coupé', () => {
  const text = `Le compte ${sayPairs(FR)} merci`;
  expect(maskIban(text)).toBe(`Le compte ${IBAN_MASK} merci`);
  expect(hiddenIbanSpans(text)).toEqual([[10, 10 + sayPairs(FR).length]]);
});

it('[R62] un texte qui sort avec un IBAN détourné est refusé', () => {
  for (const iban of [FR, BE, DE]) {
    for (const d of detours(iban)) {
      const text = `Bonjour Claire, pour la suite : ${d}.`;
      expect(IBAN.test(text), text).toBe(true);
      expect(bankDetailsIn(text), text).toBe(true);
      expect(fundsInOutgoing(text), text).toBe(true);
    }
  }
});

it('rien n\'est masqué sur une clé fausse, un téléphone, une date, un montant ou des nombres en mots ordinaires', () => {
  const texts = [
    ...[FR, BE, DE].flatMap((iban) => [
      wrongKey(iban).split('').join(' '),
      sayEach(wrongKey(iban), FR_DIGITS),
      sayGroups(wrongKey(iban)),
      sosie(wrongKey(iban)).split('').join(' '),
    ]),
    'Rappelez-moi au 0 6 1 2 3 4 5 6 7 8, ou au zéro six douze trente-quatre cinquante-six soixante-dix-huit.',
    'Signature le 1 2 . 0 3 . 2 0 2 7 à 1 0 h 3 0, lot A 1 2 3 4, 2 1 0 0 0 Dijon.',
    'Le prix est de trois cent mille euros, frais de notaire en plus.',
    'Signature prévue en deux mille vingt-six, le six mars à neuf heures.',
    'Je suis d\'accord à cent pour cent, mille mercis pour la visite.',
    'Deux chambres, trois salles de bain, un garage double, quatre-vingt-dix mètres carrés.',
    'F R soixante-seize, trois mille, six mille.',
    'Référence 7c9e6679-7425-40de-944b-e07fc1f90ae7 du dossier.',
  ];
  for (const text of texts) {
    expect(maskIban(text), text).toBe(text);
    expect(hiddenIbanSpans(text), text).toEqual([]);
  }
});

it('tout IBAN que le bouclier lit dans un texte épelé ou dicté est masqué par le socle', () => {
  const samples: string[] = [];
  for (let n = 100; n <= 9999; n += 211) {
    const iban = withKey('BE', `5390${String(n).padStart(4, '0')}7034`);
    samples.push(sayGroups(iban), sayPairs(iban), sayEach(iban, EN_DIGITS), sosie(iban));
  }
  for (const iban of [FR, BE, DE, CH, ES]) samples.push(...detours(iban));
  for (const s of samples) {
    if (!(spelledIban(s) || dictatedIban(s))) continue;
    const masked = maskIban(`Note : ${s} fin`);
    expect(masked, s).toContain(IBAN_MASK);
    expect(spelledIban(masked) || dictatedIban(masked), masked).toBe(false);
  }
});

it('lecture linéaire : 40 000 caractères épelés ou en mots masqués, sans emballement', () => {
  const spelled = '0 6 1 2 3 4 5 6 7 8 F R 7 6 a b c d ';
  const words = 'neuf mille neuf cent quatre-vingt-dix-neuf trois cents mil cent and hundred thousand ';
  for (const chunk of [spelled, words]) {
    const build = (n: number): string => chunk.repeat(Math.ceil(n / chunk.length)).slice(0, n);
    expect(maskIban(build(40_000))).toBe(build(40_000));
    expectLinear(build, maskIban);
  }
});

it('[R15] un IBAN qui mêle chiffres ordinaires et chiffres pleine chasse ou dictés est masqué en entier, jamais son début seul', () => {
  const g = FR.slice(4).match(/.{1,4}/g)!;
  const mixed = [
    `${FR.slice(0, 4)} ${g.slice(0, 4).join(' ')} ${fullWidth(g[4]!)} ${g[5]}`,
    `${FR.slice(0, 4)} ${g.slice(0, 4).join(' ')} ${sayEach(g[4]!, FR_DIGITS)} ${g[5]}`,
    `${FR.slice(0, 4)} ${g.slice(0, 4).join(' ')} ${sosie(g[4]!)} ${sosie(g[5]!)}`,
  ];
  for (const iban of mixed) {
    const text = `Voici : ${iban} merci`;
    expect(maskIban(text), text).toBe(`Voici : ${IBAN_MASK} merci`);
  }
});

it('[R15] un IBAN et un RIB écrits normalement restent masqués comme avant, chacun à sa place', () => {
  const text = `IBAN ${FR} et RIB 30006 00001 12345678901 89, puis ${BE}.`;
  expect(maskIban(text)).toBe(`IBAN ${IBAN_MASK} et RIB ${IBAN_MASK}, puis ${IBAN_MASK}.`);
});
