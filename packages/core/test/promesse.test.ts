import { describe, expect, it } from 'vitest';
import { promisesMandates } from '../src/mandats/gagner/promesse.ts';

describe('G13 · aucune promesse de mandats', () => {
  it('[R145] un texte qui garantit, chiffre ou annonce des mandats à un agent est reconnu', () => {
    for (const text of [
      'Mandats garantis dès le premier mois.',
      'Nous vous garantissons des mandats.',
      'AIMMO vous assure des mandats exclusifs.',
      '5 mandats par mois avec les lettres de quartier.',
      'Jusqu’à 3 nouveaux mandats chaque semaine.',
      '30 % de mandats en plus.',
      'Deux fois plus de mandats en plus grâce au dossier.',
      'Doublez vos mandats en un trimestre.',
      'Vous signerez plus de mandats.',
      'Tu auras des mandats sans prospecter.',
      'Cet écran vous apporte des mandats.',
      'Les lettres génèrent des mandats.',
      'Résultats garantis.',
      'Des MANDATS GARANTIS, promis.',
    ]) {
      expect(promisesMandates(text), text).toBe(true);
    }
  });

  it('[R145] nommer les mandats sans rien promettre reste permis', () => {
    for (const text of [
      'Gagner des mandats',
      'Mandat signé le 12 octobre.',
      '3 mandats signés · 2 ventes conclues · 4 estimations tenues',
      'Le compte mensuel des mandats par source vient de la base.',
      'Ce bien n’a ni mandat signé ni vente rapportée : aucune lettre.',
      'Dossiers de vos estimations, recommandations à appeler, relances à valider, lettres à déposer.',
      'Garder ou arrêter une source reste une décision de la direction.',
      'Certaines sources ont rapporté des mandats le mois dernier.',
    ]) {
      expect(promisesMandates(text), text).toBe(false);
    }
  });
});
