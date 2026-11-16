import { describe, expect, it } from 'vitest';
import { REWARD, mentionsReward, rewardWords } from '../src/index.ts';

// RC65 : une récompense au client qui recommande ne passe pas par un détour de vocabulaire [R66].
describe('RC65 · récompense déguisée', () => {
  it('[R66] chaque forme déguisée est refusée', () => {
    for (const text of [
      'Léa aura une remise sur ses honoraires',
      'une réduction de vos frais d’agence pour vous remercier',
      'vos honoraires seront offerts',
      'Honoraires réduits pour Léa',
      'un petit virement pour vous remercier',
      'de l’argent pour Léa',
      'je vous donne 200 balles',
      'un restaurant offert',
      'un week-end offert à Léa',
      'nous vous offrons un dîner',
      'je vous invite au restaurant',
      'un bonus pour Léa',
      'une carte prépayée',
      'paiement en espèces',
      'une petite enveloppe',
      'a nice reward',
      'a gift card',
      'cash back',
      'un geste commercial',
      'un rabais',
      'une indemnité pour vous remercier',
      'un remboursement pour votre recommandation',
      'Léa recevra une indemnité',
    ]) {
      expect(mentionsReward(text), text).toBe(true);
    }
  });

  it('[R66] un mot écrit lettre par lettre est lu comme le mot', () => {
    for (const text of ['Léa aura un c a d e a u', 'une p.r.i.m.e de bienvenue', 'un C-A-D-E-A-U', 'un b o n u s', 'c a s h']) {
      expect(mentionsReward(text), text).toBe(true);
    }
    expect(rewardWords('Léa aura un c a d e a u demain')).toEqual(['c a d e a u']);
    // Un mot d'une lettre juste avant ou après ne cache pas le mot épelé.
    expect(rewardWords('un c a d e a u à Léa')).toEqual(['c a d e a u']);
    expect(rewardWords('une p.r.i.m.e à Léa')).toEqual(['p.r.i.m.e']);
    expect(rewardWords('y a c a d e a u x à Léa')).toEqual(['c a d e a u x']);
    expect(mentionsReward('a b c d e f g h')).toBe(false);
  });

  it('[R66] aucun faux refus sur les phrases d’usage', () => {
    for (const text of [
      'Hugo est d’accord pour être appelé à la remise des clés',
      'une remise en état de la cuisine',
      'estimation offerte',
      'un avis de valeur offert, sans engagement',
      'le jardin abrite des espèces protégées',
      'je vous remercie de votre confiance',
      'nous vous invitons à un repas de quartier',
      'Hugo cherche un T3 à Dijon, 21000',
      'appelé à la fin de la semaine',
      'Il a un projet de vente à l’automne',
      'les frais d’agence sont à la charge du vendeur',
      'a b',
      'l’indemnité d’immobilisation du compromis',
      'un remboursement anticipé de votre prêt',
      'le remboursement de son crédit',
      'Hugo accepte d’être appelé après le remboursement du crédit',
      'le remboursement de mon prêt',
      'le remboursement des prêts',
      'le remboursement d’emprunt',
      'le remboursement de leurs crédits',
    ]) {
      expect(mentionsReward(text), text).toBe(false);
      expect(rewardWords(text), text).toEqual([]);
    }
  });

  it('[R66] rewardWords rend les mots tels que tapés, dans l’ordre, sans doublon', () => {
    expect(rewardWords('Un CADEAU, puis un Cadeau et une Prime : 10 %')).toEqual(['CADEAU', 'Cadeau', 'Prime', '%']);
    expect(rewardWords('cadeau cadeau')).toEqual(['cadeau']);
    expect(rewardWords('une Récompense')).toEqual(['Récompense']);
    expect(rewardWords('vos Honoraires seront offerts')).toEqual(['Honoraires seront offerts']);
    expect(rewardWords('')).toEqual([]);
    expect(rewardWords(42 as unknown as string)).toEqual([]);
  });

  it('[R66] REWARD reste une expression sans état, utilisable deux fois de suite', () => {
    expect(REWARD.flags).not.toContain('g');
    expect(REWARD.test('un cadeau')).toBe(true);
    expect(REWARD.test('un cadeau')).toBe(true);
  });
});
