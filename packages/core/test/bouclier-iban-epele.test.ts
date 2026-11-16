import { expect, it } from 'vitest';
import { fundSignals, spelledIban } from '../src/dossiers/bouclier.ts';

// RC67 : un IBAN épelé caractère par caractère, ou coupé n'importe où. IBAN inventés : la clé est calculée ici.

function withKey(country: string, bban: string): string {
  const s = `${bban}${country}00`.toUpperCase();
  let r = 0;
  for (const ch of s) {
    const v = ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return `${country}${String(98 - r).padStart(2, '0')}${bban}`;
}

const FR = withKey('FR', '1234598765000123456789X42'.slice(0, 23)); // 27 caractères
const BE = withKey('BE', '539007547034');
const DE = withKey('DE', '370400440532013000');
const CH = withKey('CH', '00762011623852957');
const ES = withKey('ES', '21000418450200051332');
const IT = withKey('IT', 'X0542811101000000123456');
const LU = withKey('LU', '0019400644750000');
const MC = withKey('MC', '11222003330123456789030');

const spell = (iban: string, sep: string): string => iban.split('').join(sep);
const wrongKey = (iban: string): string => `${iban.slice(0, 2)}${iban[2] === '9' ? '0' : '9'}${iban.slice(3)}`;

it('les IBAN de test ont la longueur de leur pays', () => {
  expect([FR, BE, DE, CH, ES, IT, LU, MC].map((x) => x.length)).toEqual([27, 16, 22, 21, 24, 27, 20, 27]);
});

it('[R62] un IBAN épelé avec espaces, points, tirets, retours à la ligne alerte', () => {
  for (const iban of [FR, BE, DE, CH, ES, IT, LU, MC]) {
    for (const sep of [' ', '.', '-', '\n', ' - ', ', ', '/', '_']) {
      const t = `Voici les coordonnées : ${spell(iban, sep)} merci`;
      expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining(['iban'])]);
    }
  }
});

it('[R62] un IBAN épelé en minuscules, en groupes mêlés, sans aucun mot bancaire, alerte', () => {
  const mixed = `${FR.slice(0, 1)} ${FR.slice(1, 2)} ${FR.slice(2, 3)} ${FR.slice(3, 4)} ${FR.slice(4, 8)} ${FR.slice(8, 12)} ${spell(FR.slice(12), ' ')}`;
  const cases = [
    `Merci de faire le nécessaire sur ${spell(FR, ' ').toLowerCase()} avant vendredi`,
    `Bonjour, ${mixed}. Cordialement`,
    `Pour la suite : ${FR.slice(0, 2)} ${spell(FR.slice(2), ' ')}`,
    `${spell(BE, '  ')}`,
    `(${spell(DE, '.')})`,
    `Le nouveau : ${FR.slice(0, 4)}-${spell(FR.slice(4), '-')}.`,
  ];
  for (const t of cases) {
    expect([t, spelledIban(t)]).toEqual([t, true]);
    expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining(['iban'])]);
  }
});

it('[R62] un IBAN dont le compte est fait de lettres (Suisse) alerte aussi', () => {
  const ch = withKey('CH', '00762ABCDEFGHIJKL');
  expect(ch.length).toBe(21);
  expect(spelledIban(spell(ch, ' '))).toBe(true);
  expect(fundSignals(`Merci : ${spell(ch, '.')}`)).toContain('iban');
});

it('[R62] une clé fausse, un téléphone, des références, des dates, des montants épelés ne sont pas un IBAN', () => {
  const cases = [
    `Le numéro : ${spell(wrongKey(FR), ' ')}`,
    'Appelez-moi au 0 6 1 2 3 4 5 6 7 8 ou au 06 12 34 56 78',
    'Mon portable : +33 6 12 34 56 78, fixe 03 80 12 34 56',
    'Lot B 2 0 1, bâtiment A, 3 e étage, parking P 1 2, cave C 0 4',
    'Visite le 12 / 03 / 2027 à 10 h 30, puis le 14 - 03 - 2027',
    'Prix : 2 5 0 0 0 0 euros, frais 7 5 0 0, surface 8 5 m2, 21000 Dijon',
    'Référence FR 21 00 01 23 45 67 89 01 23 45 67 89',
    'Code d’accès A B 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6',
    'DE 12 rue des Forges, 2 1 0 0 0 DIJON, tél 0 3 8 0 1 2 3 4 5 6',
    'Remise des clés à 9 h, rendez-vous chez le notaire à 1 4 h 3 0',
  ];
  for (const t of cases) {
    expect([t, spelledIban(t)]).toEqual([t, false]);
    expect([t, fundSignals(t)]).toEqual([t, expect.not.arrayContaining(['iban'])]);
  }
});

it('un morceau collé à une lettre accentuée fait partie du mot, pas de la suite', () => {
  // « éF » est un mot : la suite commence à « R », sans code de pays devant les chiffres.
  expect(spelledIban(`é${spell(FR, ' ')}`)).toBe(false);
  expect(spelledIban(`é ${spell(FR, ' ')}`)).toBe(true);
});

it('[R62] la lecture reste linéaire : 40 000 caractères de morceaux épelés en moins de 500 ms', () => {
  const t = 'F R 7 6 1 2 3 4 '.repeat(2500);
  const t0 = performance.now();
  spelledIban(t);
  fundSignals(t);
  expect(performance.now() - t0).toBeLessThan(500);
});
