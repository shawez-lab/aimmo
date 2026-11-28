import { expect, it } from 'vitest';
import { fundSignals, unleet } from '../src/dossiers/bouclier.ts';
import { expectLinear } from './lineaire.ts';

// RC71 : un faux RIB écrit en « leet », des chiffres ou des signes à la place des lettres. Textes inventés.

it('[R62] « R1B », « 1BAN », « B1C », « c00rdonnées » donnent les coordonnées bancaires', () => {
  for (const t of [
    'Voici notre nouveau R1B pour la vente',
    'Merci d\'utiliser ce nouvel 1BAN',
    'le B1C a changé',
    'nos c00rd0nnées bancaires ont changé',
    'nos coordonnees b@nc@ires sont nouvelles',
    'Nous avons ch@ngé de b4nque',
    'r1b en pièce jointe',
  ]) expect(fundSignals(t), t).toContain('coordonnees_bancaires');
});

it('[R62] « v1r3ment », « @compte », « $équestre », « p@yer », « paypa1 » donnent le bon signal', () => {
  expect(fundSignals('merci de faire le v1r3ment aujourd\'hui')).toContain('virement');
  expect(fundSignals('le vir3ment doit partir ce soir')).toContain('virement');
  expect(fundSignals('l\'@compte est à verser')).toContain('acompte');
  expect(fundSignals('un 4compte de 10 %')).toContain('acompte');
  expect(fundSignals('le $équestre chez nous')).toContain('sequestre');
  expect(fundSignals('le 5equestre chez nous')).toContain('sequestre');
  expect(fundSignals('merci de p@yer avant vendredi')).toContain('paiement');
  expect(fundSignals('réglez par paypa1')).toContain('paiement');
  expect(fundSignals('please w1re the d3posit')).toEqual(expect.arrayContaining(['virement', 'acompte']));
  expect(fundSignals('le tr@nsfert des f0nds')).toContain('virement');
});

it('[R62] le leet se mêle aux sosies et aux caractères invisibles', () => {
  expect(fundSignals('nouveau R1Β')).toContain('coordonnees_bancaires'); // bêta grec
  expect(fundSignals('v1r​3ment')).toContain('virement');
  expect(fundSignals('Ｒ１Ｂ modifié')).toContain('coordonnees_bancaires'); // pleine chasse
});

it('les mots et nombres d\'une annonce ou d\'un rendez-vous ne donnent aucun signal', () => {
  for (const t of [
    'Un T3 de 70 m2 au 3e étage, lot 1A, bâtiment B2',
    'Visite le 1er mars à 15h30, puis le 2ème lot à 17h45',
    'F4 rénové, DPE C, 4G et 5G dans le quartier, 21000 Dijon',
    'Prix : 250 000 €, soit 3 571 € le m², R+1 avec garage',
    'appelez-moi au 06 12 34 56 78 ou écrivez à paul.martin@exemple.fr',
    'le 7e arrondissement, un 2 pièces, 45m2, 1ère visite',
    'Réf. A12B, mandat 2026-0042, code 4B7',
  ]) expect(fundSignals(t), t).toEqual([]);
});

it('un nombre seul ne change jamais, un mot sans chiffre non plus', () => {
  expect(unleet('5000 € et 21000 Dijon')).toBe('5000 € et 21000 Dijon');
  expect(unleet('Bonjour Madame')).toBe('Bonjour Madame');
  expect(unleet('R1B v1r3ment @compte $équestre')).toBe('RiB virement acompte séquestre');
  expect(unleet('paypa1', 'l')).toBe('paypal');
});

it('[R62] lecture linéaire : 40 000 caractères de leet, sans emballement', () => {
  const chunk = 'v1r3 c00 @b$ 4a5 ';
  expectLinear((n) => chunk.repeat(Math.ceil(n / chunk.length)), fundSignals);
});
