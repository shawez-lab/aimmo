import { expect, it } from 'vitest';
import { dictatedIban, fundSignals, spelledIban, unmasked } from '../src/dossiers/bouclier.ts';
import { unmaskedText } from '../src/envoi/iban-detours.ts';
import { IBAN, IBAN_MASK, bankDetailsIn, checkText, fundsInOutgoing, maskIban, paymentRequestIn } from '../src/envoi/texte.ts';
import { expectLinear } from './lineaire.ts';

// BR107 : le socle lit le texte comme l'œil le voit. Un IBAN ou un mot d'argent caché par des caractères invisibles ou
// des sosies grecs ou cyrilliques est masqué à l'entrée [R15] et refusé à la sortie [R62]. IBAN inventés.

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
const groups = (iban: string, sep = ' '): string => iban.match(/.{1,4}/g)!.join(sep);
const ZW = '​';
const SHY = '­';
const LRM = '‎';
const VS = '\u{e0100}';
const mathBold = (s: string): string =>
  [...s].map((c) => (c >= '0' && c <= '9' ? String.fromCodePoint(0x1d7ce + Number(c)) : c >= 'A' && c <= 'Z' ? String.fromCodePoint(0x1d400 + c.charCodeAt(0) - 65) : c)).join('');
const masked = (before: string, after: string, hidden: string): void => {
  expect(maskIban(`${before}${hidden}${after}`)).toBe(`${before}${IBAN_MASK}${after}`);
};

it('[R15] un IBAN coupé de caractères invisibles est masqué en entier, le texte autour inchangé', () => {
  for (const cut of [ZW, SHY, LRM, '⁠', '﻿', '‍', VS]) {
    masked('Mon nouveau compte : ', ', merci.', [...FR].join(cut));
    masked('Compte ', ' ok', groups(FR, cut));
    masked('Compte ', ' ok', `${FR.slice(0, 10)}${cut}${FR.slice(10)}`);
    masked('', '', groups(BE).split(' ').join(` ${cut}`));
  }
});

it('[R15] un IBAN en chiffres mathématiques ou avec un O cyrillique ou grec pour zéro est masqué en entier', () => {
  masked('IBAN : ', ' .', mathBold(groups(FR)));
  masked('IBAN : ', ' .', groups(FR).replace(/0/g, 'О')); // О cyrillique
  masked('IBAN : ', ' .', groups(FR).replace(/0/g, 'Ο')); // Ο grec
  masked('IBAN : ', ' .', `${groups(FR).replace(/0/g, 'О')}`.split('').join(ZW));
  masked('RIB : ', ' .', `ϜR${FR.slice(2)}`.replace('Ϝ', 'F'));
});

it('[R15] un RIB français coupé d\'invisibles est masqué', () => {
  const rib = `30006${ZW}00001${ZW}12345678901${ZW}89`;
  expect(maskIban(`RIB : ${rib} fin`)).toBe(`RIB : ${IBAN_MASK} fin`);
});

it('[R62] un mot d\'argent écrit avec des sosies, des invisibles, en lettres mathématiques ou pleine chasse ne sort pas', () => {
  const texts = [
    'Voici notre nouveau RΙΒ pour la suite.', // iota et bêta grecs
    'Voici notre nouveau ІВАN pour la suite.', // І, В, А cyrilliques
    `Merci de faire le vir${ZW}ement de l'acompte.`,
    `Notre ${mathBold('IBAN')} a changé.`,
    'Notre ＢＩＣ a changé.',
    `Pay${ZW}ez avant vendredi.`,
    `Vous devez v${SHY}erser 500 € sur le compte.`,
    `Voici nos coordonnées ban${ZW}caires.`,
    `Veuillez ré${LRM}gler la somme due.`,
    `Le compte : ${[...FR].join(ZW)}`,
  ];
  for (const t of texts) expect(fundsInOutgoing(t), t).toBe(true);
  expect(bankDetailsIn('Notre nouveau RΙΒ.')).toBe(true);
  expect(paymentRequestIn(`Merci de ver${ZW}ser la somme demandée.`)).toBe(true);
  expect(checkText('Bonjour Léa, voici notre nouveau RΙΒ.', { audience: 'client' } as never).some((p) => p.rule === 'R62')).toBe(true);
});

it('textes ordinaires, phrases russes ou grecques, noms accentués : inchangés et acceptés', () => {
  const texts = [
    'Bonjour Zoé, la visite de la maison de Chenôve est confirmée samedi à 10 h.',
    'Привет, как дела? Встреча в субботу.',
    'Καλημέρα, η επίσκεψη είναι το Σάββατο.',
    'Rendez-vous avec M. Œhlenschläger et Mme Ñúñez à Dijon.',
    'Référence du bien 2024-0718, 3 chambres, 92 m², 245 000 €.',
    `Un texte avec un espace${ZW}de largeur nulle et rien d'autre.`,
    'Appelez-moi au 06 12 34 56 78 le 12/03/2027.',
  ];
  for (const t of texts) {
    expect(maskIban(t), t).toBe(t);
    expect(IBAN.test(t), t).toBe(false);
    expect(fundsInOutgoing(t), t).toBe(false);
  }
  expect(unmaskedText('Привет мир')).toBe('Привет мир');
  expect(unmaskedText('Καλημέρα')).toBe('Καλημέρα');
});

it('un texte coupé d\'invisibles a le même verdict que le texte sans eux : téléphone, date et montant inchangés', () => {
  const wrong = `${FR.slice(0, 2)}${FR[2] === '9' ? '0' : '9'}${FR.slice(3)}`;
  for (const plainText of [`Code ${wrong} fin`, 'Appelez le 06 12 34 56 78', 'Le 12/03/2027 à 14 h', 'Prix : 245 000 €']) {
    const cut = [...plainText].join(ZW);
    expect(maskIban(cut) === cut, plainText).toBe(maskIban(plainText) === plainText);
  }
});

const SAMPLE = [
  'nouveau RΙΒ', 'РІВ', 'vir​ement', 'c­oordonnées', '𝐑𝐈𝐁', 'ＲＩＢ', 'Привет мир', 'Καλημέρα',
  'аеорсухіјѕԁһӏԛԝ', 'АВЕКМНОРСТУХІЈЅԚԜӀ', 'ΑΒΕΖΗΙΚΜΝΟΡΤΥΧοανρι', 'ıɑɡ', 'Zoé à Chenôve', 'payеz', 'x\u{e0100}y',
  '‮RIB‬', 'ǅ ﬁ ½', 'mot1 Мot2 мот', 'ВIC', 'кот Kот', '﻿IBAN', 'é', 'é', '٣', 'Ⅻ',
];

it('le texte démasqué du socle est celui du bouclier sur tous les sosies et invisibles', () => {
  for (const t of SAMPLE) expect(unmaskedText(t).normalize('NFC'), JSON.stringify(t)).toBe(unmasked(t).normalize('NFC'));
});

it('[R15] tout IBAN que le bouclier lit dans le texte démasqué est masqué par maskIban', () => {
  const hidden = [
    [...FR].join(ZW),
    groups(FR, SHY),
    groups(FR).replace(/0/g, 'О'),
    mathBold(groups(BE)),
    `${groups(FR).split(' ').join(` ${LRM}`)}`,
  ];
  for (const h of hidden) {
    const t = `Mon compte : ${h}.`;
    const seen = unmasked(t);
    expect(spelledIban(seen) || dictatedIban(seen) || IBAN.test(seen), h).toBe(true);
    expect(fundSignals(t)).toContain('iban');
    expect(maskIban(t), h).toBe(`Mon compte : ${IBAN_MASK}.`);
  }
});

it('lecture linéaire : 40 000 caractères d\'invisibles et de sosies, sans emballement', () => {
  const chunk = `RΙΒ${ZW}vir${SHY}ement Привет о0О ${LRM}`;
  const build = (n: number): string => chunk.repeat(Math.ceil(n / chunk.length)).slice(0, n);
  for (const read of [maskIban, fundsInOutgoing, unmaskedText] as ((t: string) => unknown)[]) expectLinear(build, read);
});
