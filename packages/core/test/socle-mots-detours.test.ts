import { expect, it } from 'vitest';
import { IBAN_MASK, bankDetailsIn, fundsInOutgoing, maskIban, paymentRequestIn } from '../src/envoi/texte.ts';
import { joinSpelledWords, unleetWords, wordReadings } from '../src/envoi/mots-detours.ts';
import { expectLinear } from './lineaire';

// BR109 : le socle lit les mots d'argent épelés, en leet et en leet épelé, et l'IBAN dicté juste après un nombre
// composé, comme le bouclier (RC66, RC71, RC72). Textes et IBAN inventés : la clé est calculée ici.

function withKey(country: string, bban: string): string {
  const s = `${bban}${country}00`.toUpperCase();
  let r = 0;
  for (const ch of s) {
    const v = ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return `${country}${String(98 - r).padStart(2, '0')}${bban}`;
}
const DIGITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
const keyWords = (iban: string): string => iban.slice(2, 4).split('').map((d) => DIGITS[Number(d)]!).join(' ');

it('[R62] les mots épelés, en leet et en leet épelé sont refusés à la sortie', () => {
  for (const t of [
    'Voici notre R.I.B à jour',
    'Notre r i b a changé',
    'Utilisez ce I.B.A.N.',
    'Le B-I-C a changé',
    'Voici le nouveau R1B',
    'Utilisez cet 1BAN',
    'Le B1C a changé',
    'Voici le nouveau R 1 B',
    'Utilisez cet 1-B-A-N',
    'r.1.b joint',
    'P@yez avant vendredi',
    'V1rez la somme ce soir',
    'Merci de v1rer le solde',
    'Voici nos c00rdonnées bancaires',
  ]) {
    expect(fundsInOutgoing(t), t).toBe(true);
  }
  expect(bankDetailsIn('Voici le nouveau R 1 B')).toBe(true);
  expect(bankDetailsIn('Voici notre R.I.B')).toBe(true);
  expect(paymentRequestIn('P@yez la somme de 500 euros')).toBe(true);
  expect(paymentRequestIn('V1rez le montant demain')).toBe(true);
});

it('les textes ordinaires d’AIMMO restent acceptés', () => {
  for (const t of [
    'Bonjour Claire, le T3 de Dijon est disponible au 1er étage.',
    'Visite du F4 demain à 15h30, R+1 avec jardin.',
    'Il y a 3 pièces et un garage, réf. A7B2.',
    'Écrivez-nous à contact@exemple.fr ou au 06 12 34 56 78.',
    'Le bien est en 4G, proche du tram T1 et de la ligne B 3.',
    'Nous avons reçu votre demande, à très bientôt.',
    'Le lot 1 A est vendu, le 4 B 7 reste libre.',
    'Une visite a eu lieu : r a s.',
    'Prix : 245 000 €, DPE C, 5 pièces.',
  ]) {
    expect(fundsInOutgoing(t), t).toBe(false);
    expect(maskIban(t), t).toBe(t);
  }
});

it('les lectures des mots : leet, épelé, leet épelé', () => {
  expect(unleetWords('r1b 5000 t3', 'i')).toBe('rib 5000 te');
  expect(unleetWords('paypa1', 'l')).toBe('paypal');
  expect(joinSpelledWords('notre r i b a change', 0, 1)).toBe('notre rib a change');
  expect(joinSpelledWords('le r 1 b', 0, 0, 'i')).toBe('le rib');
  expect(wordReadings('bonjour, a demain')).toEqual(['bonjour, a demain']);
});

it('[R15] [R62] l’IBAN dicté juste après un nombre composé est masqué en entier, le texte autour inchangé', () => {
  const be = withKey('BE', '539030907034');
  const six = withKey('BE', '539002306000');
  for (const t of [
    `B E ${keyWords(be)}, cinq mille trois cent quatre-vingt-dix, trois mille quatre-vingt-dix sept mille trente-quatre`,
    `B E ${keyWords(six)}, cinq mille trois cent quatre-vingt-dix, zéro deux cent trente six mille`,
  ]) {
    const text = `Bonjour, voici : ${t}. Merci !`;
    expect(maskIban(text), t).toBe(`Bonjour, voici : ${IBAN_MASK}. Merci !`);
    expect(fundsInOutgoing(text), t).toBe(true);
  }
  // Une clé fausse : rien n'est masqué.
  const wrong = `B E ${keyWords(be) === 'un un' ? 'deux deux' : 'un un'}, cinq mille trois cent quatre-vingt-dix, trois mille quatre-vingt-dix sept mille trente-quatre`;
  expect(maskIban(wrong)).toBe(wrong);
  // Un prix ordinaire dit en mots ne change pas.
  const price = 'Le prix est de deux cent trente six mille euros.';
  expect(maskIban(price)).toBe(price);
});

it('lecture linéaire : 40 000 caractères épelés, en leet et en mots', () => {
  const chunk = 'r 1 b v.1.r.3.m.e.n.t P@yez a b c d quatre-vingt-dix sept mille ';
  expectLinear(
    (n) => chunk.repeat(Math.ceil(n / chunk.length)).slice(0, n),
    (t) => {
      fundsInOutgoing(t);
      maskIban(t);
    },
  );
});
