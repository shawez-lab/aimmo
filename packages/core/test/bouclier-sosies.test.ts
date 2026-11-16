import { expect, it } from 'vitest';
import { fundSignals, unmasked } from '../src/dossiers/bouclier.ts';

// RC70 : un faux RIB masqué par des caractères invisibles, des sosies grecs ou cyrilliques, des lettres de fantaisie.
// IBAN inventé, clé calculée ici.

function ibanFr(bban: string): string {
  const s = (bban + 'FR00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0;
  for (const d of s) r = (r * 10 + Number(d)) % 97;
  return 'FR' + String(98 - r).padStart(2, '0') + bban;
}
const IBAN_OK = ibanFr('30001000641234567890185');

const ZW = '​';
const SHY = '­';

it('[R62] des sosies grecs ou cyrilliques dans « RIB » ou « IBAN » donnent les coordonnées bancaires', () => {
  for (const t of [
    'Voici notre nouveau RΙΒ pour la vente', // iota, bêta grecs
    'Nouveau RІВ ci-joint', // i et b cyrilliques
    'Merci d\'utiliser ce nouvel ІBAN', // i cyrillique
    'nos cоordonnеes bancaires ont changé', // o et e cyrilliques
    'R I Β modifié', // épelé, bêta
  ]) expect(fundSignals(t), t).toContain('coordonnees_bancaires');
});

it('[R62] des caractères invisibles dans le mot ne cachent plus le signal', () => {
  expect(fundSignals(`merci de faire le vir${ZW}ement`)).toContain('virement');
  expect(fundSignals(`Merci d'utiliser ce nouvel I${ZW}BAN`)).toContain('coordonnees_bancaires');
  expect(fundSignals(`c${SHY}oordonnées b${SHY}ancaires changées`)).toContain('coordonnees_bancaires');
  expect(fundSignals('l⁠⁠⁠acompte doit être versé')).toContain('acompte');
  expect(fundSignals('﻿s‍e‌questre')).toContain('sequestre');
  expect(fundSignals('RI‮B')).toContain('coordonnees_bancaires');
});

it('[R62] des lettres mathématiques ou en pleine chasse sont lues comme les lettres', () => {
  expect(fundSignals('\u{1d411}\u{1d408}\u{1d401} modifié')).toContain('coordonnees_bancaires');
  expect(fundSignals('ＲＩＢ modifié')).toContain('coordonnees_bancaires');
  expect(fundSignals('faites le 𝓋𝒾𝓇𝑒𝓂𝑒𝓃𝓉 aujourd\'hui')).toContain('virement');
});

it('[R62] un IBAN coupé par des invisibles ou écrit avec des sosies de lettres alerte', () => {
  const spaced = IBAN_OK.replace(/(.{4})(?=.)/g, '$1 ');
  expect(fundSignals('Voici : ' + IBAN_OK.split('').join(ZW))).toContain('iban');
  expect(fundSignals('Voici : ' + spaced.replace(/ /g, ` ${ZW}`))).toContain('iban');
  // « F » n'a pas de sosie, « R » non plus : on masque les chiffres en pleine chasse et on coupe
  expect(fundSignals('à verser ici ' + IBAN_OK.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d))))).toContain('iban');
  // IBAN belge : « BE » écrit en cyrillique
  const be = (() => {
    const bban = '539007547034';
    const s = (bban + 'BE00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
    let r = 0;
    for (const d of s) r = (r * 10 + Number(d)) % 97;
    return String(98 - r).padStart(2, '0') + bban;
  })();
  expect(fundSignals('compte : ВЕ' + be)).toContain('iban');
});

it('rien ne change pour un texte sans sosie ni invisible', () => {
  expect(fundSignals('Voici notre nouveau RIB')).toEqual(['coordonnees_bancaires']);
  expect(fundSignals('Bonjour, la visite de samedi est confirmée.')).toEqual([]);
  expect(fundSignals('Le transfert de propriété a lieu chez le notaire.')).toEqual([]);
});

it('une phrase russe ou grecque ordinaire, un nom propre accentué : aucun signal', () => {
  for (const t of [
    'Здравствуйте, мы хотим посмотреть квартиру в субботу.',
    'Спасибо за визит, всё было хорошо.',
    'Καλημέρα, θα θέλαμε να δούμε το διαμέρισμα.',
    'Ευχαριστώ πολύ για την επίσκεψη.',
    'Merci, Zoë Hélène Ørsted et José Núñez',
    'Ваш дом очень красивый',
  ]) expect(fundSignals(t), t).toEqual([]);
});

it('un vrai mot cyrillique ou grec reste tel quel ; seul un mot fait de sosies est ramené', () => {
  expect(unmasked('Здравствуйте')).toBe('Здравствуйте');
  expect(unmasked('Καλημέρα')).toBe('Καλημέρα');
  expect(unmasked('РІВ')).toBe('PIB'); // le Р cyrillique est un P
  expect(unmasked('RΙΒ')).toBe('RIB');
  expect(unmasked(`a${ZW}b${SHY}c`)).toBe('abc');
  expect(unmasked('ＲＩＢ')).toBe('RIB');
  expect(unmasked('Hélène')).toBe('Hélène');
});

it('[R62] lecture linéaire : 40 000 caractères de sosies et d\'invisibles en moins de 500 ms', () => {
  const chunk = `Р${ZW}І${SHY}Β οа `;
  const text = chunk.repeat(Math.ceil(40_000 / chunk.length)).slice(0, 40_000);
  const t0 = performance.now();
  fundSignals(text);
  expect(performance.now() - t0).toBeLessThan(500);
});
