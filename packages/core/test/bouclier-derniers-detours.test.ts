import { expect, it } from 'vitest';
import { dictatedIban, fundSignals } from '../src/dossiers/bouclier.ts';
import { expectLinear } from './lineaire.ts';

// RC72 : les deux derniers détours connus du bouclier, le leet épelé (« R 1 B ») et le groupe d'IBAN dicté juste
// après un nombre composé (« quatre-vingt-dix sept mille »). Textes et IBAN inventés : la clé est calculée ici.

function withKey(country: string, bban: string): string {
  const s = `${bban}${country}00`.toUpperCase();
  let r = 0;
  for (const ch of s) {
    const v = ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return `${country}${String(98 - r).padStart(2, '0')}${bban}`;
}

it('[R62] un mot bancaire épelé en leet donne le bon signal', () => {
  for (const t of ['voici le nouveau R 1 B', 'le r.1.b est joint', 'merci d\'utiliser cet 1-B-A-N', 'le B 1 C a changé']) {
    expect(fundSignals(t), t).toContain('coordonnees_bancaires');
  }
  expect(fundSignals('faites le v.1.r.3.m.e.n.t ce soir')).toContain('virement');
  expect(fundSignals('l\'@ c o m p t e est à verser')).toContain('acompte');
  expect(fundSignals('merci de p @ y e r vendredi')).toContain('paiement');
  expect(fundSignals('le $-e-q-u-e-$-t-r-e chez nous')).toContain('sequestre');
  expect(fundSignals('réglez par p.a.y.p.a.1')).toContain('paiement');
});

it('un lot, une référence, un étage ou un téléphone épelés ne donnent aucun signal', () => {
  for (const t of [
    'Rendez-vous au lot 1 A, bâtiment 4 B 7',
    'Un T 3 au 2 e étage, entrée B 1',
    'Comptez 1 2 3 avant d\'ouvrir',
    'Mon numéro : 0 6 1 2 3 4 5 6 7 8',
    'Code de la porte : A 4 B 7 1',
    'Les 3 a b c du quartier',
  ]) expect(fundSignals(t), t).toEqual([]);
});

const DIGITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
const keyWords = (iban: string): string => iban.slice(2, 4).split('').map((d) => DIGITS[Number(d)]!).join(' ');

it('[R62] « trois mille quatre-vingt-dix sept mille trente-quatre » se lit 3090 puis 7034', () => {
  // BE 5390 3090 7034, dit sans pause entre les deux derniers groupes : le sept ouvre le groupe suivant.
  const be = withKey('BE', '539030907034');
  const text = `B E ${keyWords(be)}, cinq mille trois cent quatre-vingt-dix, trois mille quatre-vingt-dix sept mille trente-quatre`;
  expect(dictatedIban(text), text).toBe(true);
  expect(fundSignals(text), text).toContain('iban');
});

it('[R62] « vingt sept mille », « deux cent trente six mille » : le chiffre ouvre le groupe suivant', () => {
  // BE 5390 0020 7000 : « zéro zéro vingt sept mille » ; BE 5390 0230 6000 : « zéro deux cent trente six mille ».
  const a = withKey('BE', '539000207000');
  const ta = `B E ${keyWords(a)} cinq mille trois cent quatre-vingt-dix zéro zéro vingt sept mille`;
  expect(dictatedIban(ta), ta).toBe(true);
  const b = withKey('BE', '539002306000');
  for (const g of ['zéro deux cent trente six mille', 'zéro deux cent trente-six mille', 'ZERO DEUX CENT TRENTE SIX MILLE']) {
    const tb = `B E ${keyWords(b)}, cinq mille trois cent quatre-vingt-dix, ${g}`;
    expect(dictatedIban(tb), tb).toBe(true);
    expect(fundSignals(tb), tb).toContain('iban');
  }
  // Un IBAN français : « trois mille, six mille, zéro deux cent trente six mille, zéro zéro zéro un… ».
  const f = withKey('FR', '30006000023060000001189'); // 3000 6000 0230 6000 0001 189
  const groups = ['trois mille', 'six mille', 'zéro deux cent trente six mille', 'zéro zéro zéro un', 'cent quatre-vingt-neuf'];
  const tf = `F R ${keyWords(f)}, ${groups.join(', ')}`;
  expect(f.slice(4)).toBe('30006000023060000001189');
  expect(dictatedIban(tf), tf).toBe(true);
});

it('[R62] la lecture d\'avant reste faite, et une clé fausse n\'alerte jamais', () => {
  // « quatre-vingt-dix-sept, mille deux » : 0097 puis 1002, lu comme avant.
  const c = withKey('BE', '539000971002');
  const tc = `B E ${keyWords(c)}, cinq mille trois cent quatre-vingt-dix, zéro zéro quatre-vingt-dix-sept mille deux`;
  expect(dictatedIban(tc), tc).toBe(true);
  // Une clé « 01 » n'est juste pour aucun compte : aucune des deux lectures ne passe.
  const bad = `B E zéro un, cinq mille trois cent quatre-vingt-dix, zéro deux cent trente six mille`;
  expect(dictatedIban(bad), bad).toBe(false);
  expect(fundSignals('il reste quatre-vingt-dix sept mille euros à financer')).toEqual([]);
});

it('[R62] lecture linéaire : 40 000 caractères, sans emballement', () => {
  const words = 'trois mille quatre-vingt-dix sept mille vingt six cent r 1 b v.1.r.3 @ c 0 ';
  expectLinear((n) => words.repeat(Math.ceil(n / words.length)), fundSignals);
});
