import { describe, expect, it } from 'vitest';
import { CATEGORIES, DEADLINES, FINANCINGS, qualifyByRules, scoreContact, type ScoreInput } from '../src/index.ts';

const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  category: 'buyer',
  deadline: null,
  city: null,
  criteria: [],
  amountGiven: false,
  propertyRecognized: false,
  ...over,
});

describe('Q02 · note et température par barème fixe', () => {
  it('[R24] chaque note a sa raison en une ligne, sans donnée personnelle, et le même contact a la même note', () => {
    for (const category of CATEGORIES) {
      for (const deadline of [null, ...DEADLINES]) {
        const s = scoreContact(input({ category, deadline, city: 'Talant', propertyRecognized: true }));
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(100);
        expect(s.reason).not.toMatch(/\n/);
        expect(s.reason).toMatch(new RegExp(`: ${s.score}, (froid|tiède|chaud)\\.$`));
        // La commune n'est qu'« une commune donnée » : la raison ne la cite pas.
        expect(s.reason).not.toContain('Talant');
        expect(scoreContact(input({ category, deadline, city: 'Talant', propertyRecognized: true }))).toEqual(s);
      }
    }
  });

  it('un vendeur pressé qui cite un bien est chaud ; une curiosité est froide ; un partenaire ou un indésirable valent zéro', () => {
    expect(scoreContact(input({ category: 'seller', deadline: 'now', city: 'Dijon' }))).toEqual({
      score: 70,
      temperature: 'hot',
      reason: 'Vendeur, délai immédiat, commune donnée : 70, chaud.',
    });
    expect(scoreContact(input({ category: 'buyer', propertyRecognized: true, deadline: 'within_3_months' })).temperature).toBe('hot');
    expect(scoreContact(input({ category: 'buyer' })).temperature).toBe('cold');
    expect(scoreContact(input({ category: 'curious', deadline: 'now', propertyRecognized: true })).temperature).toBe('warm');
    expect(scoreContact(input({ category: 'partner', deadline: 'now', propertyRecognized: true }))).toMatchObject({ score: 0, temperature: 'cold' });
    expect(scoreContact(input({ category: 'spam', deadline: 'now' }))).toMatchObject({ score: 0, temperature: 'cold' });
  });

  it('[R14] [R24] la note ne dépend ni du financement, ni de la valeur du budget, ni de rien sur la personne', () => {
    const base = 'Je cherche une maison avec jardin à Talant, d’ici 3 mois';
    const variants = [
      `${base}, budget 150 000 €.`,
      `${base}, budget 900 000 €.`,
      `${base}, budget 150 000 €, j’ai l’accord de principe de la banque.`,
      `${base}, budget 150 000 €, achat sans prêt.`,
      `${base}, budget 150 000 €, avec un prêt.`,
      `${base}, budget 150 000 €. Je suis retraité, divorcé, avec trois enfants.`,
      `${base}, budget 150 000 €. Nous sommes un jeune couple de médecins.`,
    ];
    const scores = variants.map((text) => {
      const q = qualifyByRules(text);
      return scoreContact({ ...q, amountGiven: q.budgetMaxEur !== null || q.priceEur !== null, propertyRecognized: false });
    });
    expect(new Set(scores.map((s) => JSON.stringify(s))).size).toBe(1);
    // Le barème n'a même pas de place pour le financement.
    expect(FINANCINGS.some((f) => JSON.stringify(scores[0]).includes(f))).toBe(false);
  });
});
