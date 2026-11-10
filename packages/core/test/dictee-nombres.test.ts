import { describe, expect, it } from 'vitest';
import { dictee } from '../src/index.ts';
import { parseNumberWords, readNumberRun } from '../src/dictee/nombres.ts';

const { readDictation } = dictee;

// Tout est inventé. Jeudi 3 décembre 2026, 10 h à Paris.
const NOW = new Date(Date.parse('2026-12-03T09:00:00.000Z'));
const read = (text: string) => readDictation(text, { now: NOW });
const field = (text: string, target: dictee.DictationTarget, key: dictee.DictatedKey) => {
  const f = dictee.fieldOf(read(text), target, key);
  return f ? [f.value, f.quote] : undefined;
};
const at = (text: string) => dictee.fieldOf(read(text), 'rendezvous', 'start')?.value;

describe('RC01 · les nombres dits en lettres', () => {
  it('[R260] un nombre en lettres ne se lit que d’une seule façon', () => {
    const cases: [string, number | null][] = [
      ['zero', 0],
      ['un', 1],
      ['une', 1],
      ['dix-sept', 17],
      ['vingt et un', 21],
      ['vingt-et-une', 21],
      ['soixante-dix', 70],
      ['soixante et onze', 71],
      ['soixante-dix-neuf', 79],
      ['quatre-vingts', 80],
      ['quatre-vingt-un', 81],
      ['quatre-vingt-dix-sept', 97],
      ['septante-deux', 72],
      ['huitante', 80],
      ['octante-trois', 83],
      ['nonante-cinq', 95],
      ['cent', 100],
      ['cent un', 101],
      ['deux cents', 200],
      ['deux cent cinquante', 250],
      ['mille', 1000],
      ['deux cent cinquante mille', 250_000],
      ['deux cents mille', 200_000],
      ['un million', 1_000_000],
      ['un million deux cent mille', 1_200_000],
      // Mal formés ou ambigus : rien.
      ['deux trois', null],
      ['vingt cent', null],
      ['vingt un', null],
      ['soixante onze', null],
      ['trois et quatre', null],
      ['un cent', null],
      ['un mille', null],
      ['mille deux mille', null],
      ['mille un million', null],
      ['zero un', null],
      ['et', null],
      ['', null],
    ];
    for (const [words, n] of cases) expect(parseNumberWords(words), words).toBe(n);
  });

  it('[R260] « un » devant un nombre est l’article : « un trois pièces » a 3 pièces, et le passage ne le porte pas', () => {
    expect(readNumberRun('un trois')).toEqual({ value: 3, skip: 3 });
    expect(readNumberRun('une deux')).toEqual({ value: 2, skip: 4 });
    expect(readNumberRun('vingt et un')).toEqual({ value: 21, skip: 0 });
    expect(readNumberRun('deux trois')).toBeNull();
    expect(field('Elle vend un appartement, un trois pièces à Dijon.', 'bien', 'rooms')).toEqual([3, 'trois pièces']);
  });

  it('[R260] pièces, surface et prix demandé dits en lettres, chacun avec ses mots pour passage', () => {
    const d = read('Madame Claire Exemple vend un appartement, un trois pièces de quatre-vingt-cinq mètres carrés, à Dijon. Prix demandé deux cent cinquante mille euros.');
    expect(d.fields.filter((f) => f.target === 'bien').map((f) => [f.key, f.value, f.quote])).toEqual([
      ['kind', 'home', 'appartement'],
      ['city', 'Dijon', 'Dijon'],
      ['surfaceM2', 85, 'quatre-vingt-cinq mètres carrés'],
      ['rooms', 3, 'trois pièces'],
      ['priceEur', 250000, 'deux cent cinquante mille euros'],
    ]);
    for (const f of d.fields) expect(d.sentences[f.sentence], `${f.target}.${f.key}`).toContain(f.quote);
    expect(d.conflicts).toEqual([]);
    expect(field('Il vend sa maison de soixante et onze m².', 'bien', 'surfaceM2')).toEqual([71, 'soixante et onze m²']);
    expect(field('Il vend sa maison, prix un million deux cent mille euros.', 'bien', 'priceEur')).toEqual([1_200_000, 'un million deux cent mille euros']);
  });

  it('[R260] un nombre en lettres collé à un autre nombre, à « virgule » ou à « et demi » n’est pas lu', () => {
    expect(field('Il vend sa maison de deux trois pièces.', 'bien', 'rooms')).toBeUndefined();
    expect(field('Il vend sa maison de cent vingt virgule cinq mètres carrés.', 'bien', 'surfaceM2')).toBeUndefined();
    expect(field('Il vend sa maison de cent mètres carrés et demi.', 'bien', 'surfaceM2')).toBeUndefined();
    expect(field('Il vend sa maison, T2 trois pièces.', 'bien', 'rooms')).toEqual([2, 'T2']);
    expect(field('Il vend sa maison de 85,5 cinq pièces.', 'bien', 'rooms')).toBeUndefined();
    // « neuf » se dit aussi d'un bien neuf : collé au nombre, rien n'est tranché.
    expect(field('Il vend un appartement neuf trois pièces.', 'bien', 'rooms')).toBeUndefined();
    expect(field('Il vend un appartement neuf, trois pièces.', 'bien', 'rooms')).toBeUndefined();
    // Après un mot qui n'est pas un nombre, « et » ne gêne pas.
    expect(field('Il vend sa maison, salon et quatre pièces.', 'bien', 'rooms')).toEqual([4, 'quatre pièces']);
    expect(field('Il vend une maison, un trois pièces et demie.', 'bien', 'rooms')).toBeUndefined();
    expect(field('Il vend une maison, 3 pièces et demie.', 'bien', 'rooms')).toBeUndefined();
    // Un tiret typographique : le trait d'union insécable lie le nombre, un demi-cadratin ne laisse lire aucun bout.
    expect(field('Il vend sa maison de quatre\u2011vingt\u2011cinq mètres carrés.', 'bien', 'surfaceM2')).toEqual([85, 'quatre\u2011vingt\u2011cinq mètres carrés']);
    expect(field('Il vend sa maison de quatre\u2013vingt\u2013cinq mètres carrés.', 'bien', 'surfaceM2')).toBeUndefined();
  });

  it('[R260] un choix entre deux nombres, ou des lettres et des chiffres mêlés, ne sont pas lus', () => {
    for (const s of ['Il vend une maison de trois ou quatre pièces.', 'Il vend une maison de 3 ou 4 pièces.', 'Il vend une maison de trois à quatre pièces.', 'Il vend une maison de trois, quatre pièces.', 'Il vend sa maison, 2 ou trois pièces.']) {
      expect(field(s, 'bien', 'rooms'), s).toBeUndefined();
    }
    for (const s of ['Il vend sa maison, prix deux cent 50 000 euros.', 'Il vend sa maison, prix un million 200 000 euros.', 'Il vend sa maison, prix deux cent cinquante mille 500 euros.', 'Il vend sa maison, prix deux cent quatre-vingt ou trois cent mille euros.']) {
      expect(field(s, 'bien', 'priceEur'), s).toBeUndefined();
    }
    expect(field('Il vend sa maison de cent 20 m².', 'bien', 'surfaceM2')).toBeUndefined();
    for (const s of ['Visite demain à 15 heures trente.', 'Visite demain à 10 h quinze.', 'Visite demain à midi trente.', 'Visite le douze ou treize janvier à dix heures.', 'Visite le 12 ou 13 janvier à 10 h.']) expect(at(s), s).toBeUndefined();
    // « un » seul reste l'article devant des chiffres.
    expect(field('Il vend sa maison, un 3 pièces.', 'bien', 'rooms')).toEqual([3, '3 pièces']);
    expect(field('La maison fait 120 m², 5 pièces.', 'bien', 'rooms')).toEqual([5, '5 pièces']);
  });

  it('[R260] chiffres et lettres qui disent deux valeurs : le champ n’est pas proposé ; la même valeur : il l’est', () => {
    const two = read('Il vend sa maison, 4 pièces. Non, cinq pièces.');
    expect(dictee.fieldOf(two, 'bien', 'rooms')).toBeUndefined();
    expect(two.conflicts).toContainEqual({ target: 'bien', key: 'rooms' });
    expect(field('Il vend sa maison, T3, trois pièces.', 'bien', 'rooms')).toEqual([3, 'T3']);
  });

  it('[R260] le prix en lettres suit les mêmes règles que le prix en chiffres', () => {
    expect(field('Il vend sa maison, il demande une remise de cinq mille euros.', 'bien', 'priceEur')).toBeUndefined();
    expect(field('Il vend sa maison, son budget est de trois cent mille euros.', 'bien', 'priceEur')).toBeUndefined();
    expect(field('Il vend sa maison de cent mètres carrés pour trois cent mille euros.', 'bien', 'priceEur')).toBeUndefined();
    expect(field('Il vend sa maison, prix au mètre carré deux mille cinq cents euros.', 'bien', 'priceEur')).toBeUndefined();
    expect(field('Il vend sa maison, prix au m² 2 500 euros.', 'bien', 'priceEur')).toBeUndefined();
    expect(field('Il vend sa maison, prix trois cent mille euros et demi.', 'bien', 'priceEur')).toBeUndefined();
    expect(field('Il vend sa maison, prix 300 000 euros et demi.', 'bien', 'priceEur')).toBeUndefined();
    // « un mille » ne se dit pas : rien, pas même « mille ».
    expect(field('Il vend sa maison, prix un mille euros.', 'bien', 'priceEur')).toBeUndefined();
    expect(field('Elle veut vendre sa maison trois cent mille euros.', 'bien', 'priceEur')).toEqual([300000, 'trois cent mille euros']);
  });

  it('[R260] l’heure et le jour du rendez-vous dits en lettres', () => {
    expect(at('Estimation mardi à quinze heures.')).toBe('2026-12-08T14:00:00.000Z');
    expect(at('Estimation mardi à quinze heures trente.')).toBe('2026-12-08T14:30:00.000Z');
    expect(at('Estimation mardi vers dix-sept heures.')).toBe('2026-12-08T16:00:00.000Z');
    expect(at('Visite le douze janvier à neuf heures.')).toBe('2027-01-12T08:00:00.000Z');
    expect(at('Visite le trente et un décembre à 10 h.')).toBe('2026-12-31T09:00:00.000Z');
    expect(at('Signature le premier février à onze heures.')).toBe('2027-02-01T10:00:00.000Z');
    expect(dictee.fieldOf(read('Estimation mardi à quinze heures trente.'), 'rendezvous', 'start')?.quote).toBe('mardi à quinze heures trente');
    // Rien qui ne se lise d'une seule façon.
    expect(at('Estimation mardi à quatorze heures et demie.')).toBeUndefined();
    expect(at('Estimation mardi à dix heures moins le quart.')).toBeUndefined();
    expect(at('Estimation mardi à vingt-cinq heures.')).toBeUndefined();
    expect(at('Estimation mardi à quinze heures soixante-dix.')).toBeUndefined();
    // Des minutes suivies d'un autre mot ont pu le prendre : rien.
    expect(at('Visite demain à dix heures une maison à Talant.')).toBeUndefined();
    expect(at('Visite mardi à quinze heures deux acheteurs.')).toBeUndefined();
    expect(at('Visite demain à quinze heures trente avec lui.')).toBeUndefined();
    // Deux heures dites, même si l'une ne se lit pas : rien n'est choisi.
    for (const s of ['Visite demain à dix heures ou onze heures.', 'Visite demain à dix heures, non onze heures.', 'Visite demain à 10 h ou onze heures.', 'Visite demain à dix heures, enfin plutôt deux heures.']) expect(at(s), s).toBeUndefined();
    // De 1 h à 7 h en lettres, ou suivie de « du soir », l'heure ne se lit pas d'une seule façon.
    expect(at('Visite demain à deux heures.')).toBeUndefined();
    expect(at('Visite demain à huit heures du soir.')).toBeUndefined();
    expect(at('Visite demain à dix heures du matin.')).toBeUndefined();
    expect(at('Visite le trente février à 10 h.')).toBeUndefined();
    expect(at('Visite le deux trois janvier à 10 h.')).toBeUndefined();
  });

  it('[R260] une durée n’est pas une heure, et une année dite sans être lue fait refuser le jour', () => {
    expect(at('Rappel demain à 10 h, dans une heure.')).toBe('2026-12-04T09:00:00.000Z');
    // Seule l'heure dite après « à » ou « vers » est une heure ; « il y a deux heures » est une durée.
    for (const s of ['Visite de deux heures demain.', 'Estimation demain, prévoir deux heures.', 'Visite demain en une heure.', 'Visite de dix heures demain.', 'Rappel demain, il a appelé il y a dix heures.']) {
      expect(dictee.fieldOf(read(s), 'rendezvous', 'start'), s).toBeUndefined();
    }
    expect(at('Visite de deux heures demain à 10 h.')).toBe('2026-12-04T09:00:00.000Z');
    expect(at('Visite le douze janvier vingt-huit à dix heures.')).toBeUndefined();
    expect(at('Visite le 12 janvier 28 à 10 h.')).toBeUndefined();
    expect(at('Estimation le premier mars deux mille vingt-huit à dix heures.')).toBeUndefined();
    expect(at('Estimation le 1er mars deux mille vingt-huit à 10 h.')).toBeUndefined();
    expect(at('Estimation le 12 mars 2100 à 10 h.')).toBeUndefined();
    expect(at('Estimation le 12 mars 2027 à 10 h.')).toBe('2027-03-12T09:00:00.000Z');
  });
});
