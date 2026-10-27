import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  amountsIn,
  checkAiQualification,
  declaredFinancing,
  findCommune,
  qualifyByRules,
  withoutNames,
  type Qualified,
} from '../src/index.ts';
import { QUALIFICATION_CASES } from './fixtures/qualification-cas.ts';

describe('Q01 · classer et extraire par règles fixes', () => {
  it('50 cas inventés couvrent les 8 catégories et sont classés juste à 90 % au moins', () => {
    expect(QUALIFICATION_CASES).toHaveLength(50);
    expect(new Set(QUALIFICATION_CASES.map((c) => c.category))).toEqual(new Set(CATEGORIES));
    const wrong = QUALIFICATION_CASES.filter((c) => {
      const q = qualifyByRules(c.text, { propertyRecognized: c.property ?? false });
      return q.category !== c.category || (c.route !== undefined && q.route !== c.route);
    });
    expect(wrong.map((c) => c.text)).toEqual([]);
    expect(1 - wrong.length / QUALIFICATION_CASES.length).toBeGreaterThanOrEqual(0.9);
  });

  it('un lien seul ne fait pas un indésirable : une personne peut citer l’annonce vue', () => {
    expect(qualifyByRules('Je veux visiter https://exemple.invalid/annonce/123').category).toBe('buyer');
    expect(qualifyByRules('Cliquez ici pour gagner : https://exemple.invalid/promo').category).toBe('spam');
  });

  it('extraction : commune, budget, délai, financement déclaré, critères', () => {
    const q = qualifyByRules('Nous recherchons une maison avec jardin à Fontaine-lès-Dijon, entre 300 000 et 350 000 euros, 4 pièces, nous avons l’accord de principe de la banque, d’ici 3 mois.');
    expect(q).toEqual<Qualified>({
      category: 'buyer',
      route: null,
      city: 'Fontaine-lès-Dijon',
      budgetMinEur: 300_000,
      budgetMaxEur: 350_000,
      priceEur: null,
      deadline: 'within_3_months',
      financing: 'loan_approved',
      criteria: ['house', 'garden', 'rooms:4'],
    });
    const seller = qualifyByRules('Je pense à vendre mon T3 à Quetigny, prix souhaité 210 000 €, pas pressé.');
    expect(seller).toMatchObject({ category: 'seller', city: 'Quetigny', priceEur: 210_000, budgetMaxEur: null, deadline: 'later', criteria: ['rooms:3'] });
    expect(qualifyByRules('Je cherche une maison, budget 280k, sans prêt.')).toMatchObject({ budgetMaxEur: 280_000, financing: 'cash' });
  });

  it('un nombre qui n’est pas un montant n’en devient pas un : pièces, surfaces, années', () => {
    expect(amountsIn('Un T3 de 65 m² au 2e étage, construit en 1975, 3 chambres')).toEqual([]);
    expect(amountsIn('budget 250 000 € maximum, ou 260k')).toEqual([250_000, 260_000]);
    // Espaces insécables, fines ou non, comme les écrit un clavier français.
    expect(amountsIn('budget 300\u00a0000\u00a0€')).toEqual([300_000]);
    expect(amountsIn('budget 300\u202f000 €')).toEqual([300_000]);
    // Un loyer, avec sa devise.
    expect(amountsIn('loyer de 650 € par mois, 3 pièces, 2e étage')).toEqual([650]);
    expect(findCommune('près de fontaine les dijon')).toBe('Fontaine-lès-Dijon');
    expect(findCommune('à Dijon centre')).toBe('Dijon');
    expect(findCommune('à Lyon')).toBeNull();
  });

  it('[R24] le financement n’est rangé que s’il est déclaré : jamais déduit d’un budget, d’un métier ou d’un âge', () => {
    for (const text of [
      'Je cherche une maison, budget 400 000 €.',
      'Je suis médecin et je cherche un appartement.',
      'Jeune couple, nous cherchons notre première maison.',
      'Retraité, je cherche un plain-pied.',
    ]) {
      expect(qualifyByRules(text).financing, text).toBeNull();
      expect(declaredFinancing(text), text).toBeNull();
    }
    expect(declaredFinancing('Rendez-vous avec ma banque la semaine prochaine')).toBe('loan_in_progress');
    // Une négation, une attente ou « pour le moment » ne déclarent jamais un prêt accordé ni un achat comptant.
    for (const [text, expected] of [
      ['Je n’ai pas encore d’accord de ma banque.', null],
      ['Pas de prêt accordé pour l’instant.', null],
      ['J’attends l’accord de principe.', 'loan_in_progress'],
      ['Pas de cash, il faut un prêt.', 'loan_needed'],
      ['Je ne paierai pas comptant, besoin d’un prêt.', null],
      ['Sans financement pour le moment.', null],
      ['Sans prêt pour le moment.', null],
      ['Achat sans prêt.', 'cash'],
      ['Accord de prêt obtenu.', 'loan_approved'],
      ['Comptant ou avec un prêt, je ne sais pas.', null],
      ['Je cherche une maison sans accord de prêt.', null],
      ['Si j’obtiens un accord de prêt, je pourrai acheter une maison.', null],
      ['Je vais demander un accord de prêt pour acheter une maison.', null],
      ['Accord de principe de la banque.', null],
      ['Nous avons l’accord de principe de la banque.', 'loan_approved'],
      ['Si je peux, je paierai comptant.', null],
    ] as const) {
      expect(declaredFinancing(text), text).toBe(expected);
    }
  });

  it('[R23] rien de sensible n’est déduit : santé, origine, religion, famille ne sont jamais des champs ni des critères', () => {
    const q = qualifyByRules('Je cherche un plain-pied à Dijon car je suis handicapé, nous sommes musulmans et divorcés avec 3 enfants, d’origine marocaine.');
    expect(Object.keys(q).sort()).toEqual(['budgetMaxEur', 'budgetMinEur', 'category', 'city', 'criteria', 'deadline', 'financing', 'priceEur', 'route']);
    expect(q.criteria).toEqual(['single_storey']);
    expect(JSON.stringify(q)).not.toMatch(/handicap|musulman|divorc|enfant|maroc|origine/i);
  });
});

describe('Q01 · ce que l’IA peut lire [R15]', () => {
  it('[R15] ni le nom que la personne se donne, ni les noms connus, ni la signature ; les communes restent', () => {
    expect(withoutNames('Bonjour, je m’appelle Zoé Exemple et je cherche à Talant.', [])).toBe('Bonjour, je m’appelle [nom] et je cherche à Talant.');
    expect(withoutNames('Moi c’est Basile, maison à Dijon svp', [])).toBe('Moi c’est [nom], maison à Dijon svp');
    expect(withoutNames('Bonjour, ici Dijon centre ?', [])).toBe('Bonjour, ici Dijon centre ?');
    expect(withoutNames('Bonjour, Mme Lambda cherche un T2.', ['Lambda'])).toBe('Bonjour, Mme [nom] cherche un T2.');
    expect(withoutNames('Je cherche un T2.\nCordialement,\nAlix Exemple\n06 00 00 00 00', [])).toBe('Je cherche un T2.');
    expect(withoutNames('Je suis médecin et je cherche un appartement.', [])).toBe('Je suis médecin et je cherche un appartement.');
  });
});

describe('Q01 · sortie de l’IA, bornée par les règles', () => {
  const text = 'Nous cherchons une maison à Talant, budget 320 000 €, prêt en cours, avec jardin.';
  const good = {
    category: 'buyer',
    route: null,
    city: 'Talant',
    budgetMinEur: null,
    budgetMaxEur: 320_000,
    priceEur: null,
    deadline: null,
    financing: 'loan_in_progress',
    criteria: ['house', 'garden'],
  };

  it('une sortie conforme est gardée', () => {
    expect(checkAiQualification(good, text)).toEqual(good);
  });

  it('[R23] un champ non prévu, un critère hors liste ou une commune inventée font refuser toute la sortie', () => {
    expect(checkAiQualification({ ...good, family: 'couple avec enfants' }, text)).toMatchObject({ rule: 'R23' });
    expect(checkAiQualification({ ...good, criteria: ['garden', 'proche mosquée'] }, text)).toMatchObject({ rule: 'R23' });
    expect(checkAiQualification({ ...good, criteria: ['garden', 'accessible handicapé'] }, text)).toMatchObject({ rule: 'R23' });
    expect(checkAiQualification({ ...good, city: 'Quartier calme et familial' }, text)).toMatchObject({ rule: 'R23' });
    expect(checkAiQualification({ ...good, category: 'investor' }, text)).toMatchObject({ rule: 'R23' });
    const { criteria: _dropped, ...missing } = good;
    expect(checkAiQualification(missing, text)).toMatchObject({ rule: 'R23' });
    expect(checkAiQualification('acheteur sérieux', text)).toMatchObject({ rule: 'R23' });
  });

  it('[R24] un financement que la personne n’a pas déclaré est refusé : l’IA n’évalue jamais la solvabilité', () => {
    expect(checkAiQualification({ ...good, financing: 'loan_approved' }, text)).toMatchObject({ rule: 'R24' });
    expect(checkAiQualification({ ...good, financing: 'cash' }, 'Je cherche une maison, budget 900 000 €.')).toMatchObject({ rule: 'R24' });
    // Une attente déclarée : l'IA qui dit « en cours » est gardée, « accordé » est refusé.
    const waiting = 'Nous cherchons une maison à Talant, budget 320 000 €, j’attends l’accord de principe de ma banque.';
    expect(checkAiQualification(good, waiting)).toEqual(good);
    expect(checkAiQualification({ ...good, financing: 'loan_approved' }, waiting)).toMatchObject({ rule: 'R24' });
  });

  it('[R10] un montant absent du message est refusé', () => {
    expect(checkAiQualification({ ...good, budgetMaxEur: 350_000 }, text)).toMatchObject({ rule: 'R10' });
    // Une surface ou un nombre de pièces ne deviennent jamais un budget.
    const t3 = 'Je cherche un T3 de 65 m² à Talant.';
    expect(checkAiQualification({ ...good, city: 'Talant', financing: null, budgetMaxEur: 65 }, t3)).toMatchObject({ rule: 'R10' });
  });
});
