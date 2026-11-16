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
      'Léa recevra une remise d’honoraires pour sa recommandation',
      'une réduction d\'honoraires',
      'un rabais d’honoraires',
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
    // Une expression de plusieurs mots épelée d'un bout à l'autre.
    expect(rewardWords('Léa recevra une c a r t e p r é p a y é e')).toEqual(['c a r t e p r é p a y é e']);
    expect(mentionsReward('un g e s t e c o m m e r c i a l')).toBe(true);
    expect(mentionsReward('un b o n d a c h a t')).toBe(true);
    expect(mentionsReward('un w e e k e n d o f f e r t')).toBe(true);
    // Des mots épelés mêlés à des mots ordinaires, relus à leur place.
    expect(rewardWords('Léa recevra une carte p r é p a y é e pour sa recommandation')).toEqual(['carte p r é p a y é e']);
    expect(rewardWords('une b o u t e i l l e offerte pour vous remercier')).toEqual(['b o u t e i l l e offerte']);
    expect(rewardWords('vos h o n o r a i r e s seront offerts')).toEqual(['h o n o r a i r e s seront offerts']);
    expect(mentionsReward('une remise sur vos h.o.n.o.r.a.i.r.e.s')).toBe(true);
  });

  it('[R66] tout le vocabulaire, épelé en entier ou en partie, entouré de mots d’une lettre', () => {
    // Chaque expression : ses mots, et pour chaque mot s'il est épelé ; toutes les façons de l'épeler sont essayées.
    // Un mot de moins de trois lettres (« un », « au ») n'est jamais épelé : il se lit tel quel.
    const spell = (w: string): string => (w.length < 3 ? w : [...w.replace(/['’-]/g, '')].join(' '));
    const expressions = [
      'cadeau', 'prime', 'commission', 'chèque', 'récompense', 'rémunération', 'ristourne', 'bon d’achat', 'carte cadeau',
      'virement', 'argent', 'bonus', 'pourboire', 'carte prépayée', 'geste commercial', 'petite enveloppe', 'rabais',
      'indemnité', 'remboursement', 'reward', 'gift', 'cash', 'kickback', 'remise sur vos honoraires',
      'réduction de vos frais d’agence', 'honoraires offerts', 'honoraires seront offerts', 'restaurant offert',
      'week-end offert', 'bouteille offerte', 'invite au restaurant', 'offre un repas',
    ];
    const misses: string[] = [];
    for (const expression of expressions) {
      const words = expression.split(' ');
      for (let mask = 1; mask < 1 << words.length; mask += 1) {
        const written = words.map((w, i) => (mask & (1 << i) ? spell(w) : w)).join(' ');
        for (const [before, after] of [['', ' à Léa'], ['il y a ', ''], ['à ', ' à Léa'], ['y a ', ' a Léa'], ['Léa a ', ' a']]) {
          const text = `${before}${written}${after}`;
          if (!mentionsReward(text)) misses.push(text);
        }
      }
    }
    expect(misses).toEqual([]);
    expect(rewardWords('une carte p r é p a y é e à Léa')).toEqual(['carte p r é p a y é e']);
    expect(rewardWords('une remise sur vos h o n o r a i r e s à Léa')).toEqual(['remise sur vos h o n o r a i r e s']);
    expect(rewardWords('il y a c a d e a u x à Léa')).toEqual(['c a d e a u x']);
  });

  it('[R66] une saisie démesurée reste lue vite, et une récompense cachée derrière beaucoup de lettres isolées reste trouvée', () => {
    for (const text of [
      `r e m i s e ${Array(2400).fill('z').join(' ')}`,
      `r e m i s e ${Array(1300).fill('zz').join(' ')}`,
      Array(1000).fill('a b c xx').join(' '),
      `${Array(8).fill('y a c a d e a a').join(' xx ')} ${Array(1500).fill('zzzz').join(' ')}`,
    ]) {
      const start = performance.now();
      rewardWords(text.slice(0, 8000));
      expect(performance.now() - start, text.slice(0, 20)).toBeLessThan(1500);
    }
    const padded = `${Array(40).fill('a b c').join(' xx ')} et une carte p r é p a y é e à Léa`;
    expect(rewardWords(padded)).toEqual(['carte p r é p a y é e']);
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
      'Hugo accepte d’être appelé pour un achat avec un budget de 300k',
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
