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
    // L'apport, les frais ou un revenu ne sont jamais le budget.
    expect(qualifyByRules('Je cherche une maison, apport de 50 000 €, budget maximum de 300 000 €.')).toMatchObject({ budgetMaxEur: 300_000 });
    expect(qualifyByRules('Je cherche une maison, salaire de 3 000 € par mois.')).toMatchObject({ budgetMaxEur: null });
  });

  it('un nombre qui n’est pas un montant n’en devient pas un : pièces, surfaces, années', () => {
    expect(amountsIn('Un T3 de 65 m² au 2e étage, construit en 1975, 3 chambres')).toEqual([]);
    expect(amountsIn('budget 250 000 € maximum, ou 260k')).toEqual([250_000, 260_000]);
    // Espaces insécables, fines ou non, comme les écrit un clavier français.
    expect(amountsIn('budget 300\u00a0000\u00a0€')).toEqual([300_000]);
    expect(amountsIn('budget 300\u202f000 €')).toEqual([300_000]);
    // Un loyer, avec sa devise.
    expect(amountsIn('loyer de 650 € par mois, 3 pièces, 2e étage')).toEqual([650]);
    // Une distance ou un poids ne sont pas des milliers d'euros.
    expect(amountsIn('maison à 10 km de Dijon, budget 250k')).toEqual([250_000]);
    expect(amountsIn('à 15 kms de Beaune, terrain de 800 m²')).toEqual([]);
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
      ['Je cherche une maison, je ne suis pas en attente de prêt.', null],
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
    // Q09 : une fiche créée depuis un message porte tout le nom dans son prénom ; chaque mot compte, sans égard aux accents.
    expect(withoutNames('Bonjour, rappelez Zoé après 18h pour le T3.', ['Zoé Exemple'])).toBe('Bonjour, rappelez [nom] après 18h pour le T3.');
    expect(withoutNames('Bonjour, Mme Exemple cherche un T3.', ['Zoé Exemple'])).toBe('Bonjour, Mme [nom] cherche un T3.');
    expect(withoutNames('EXEMPLE Zoé, je cherche un T3.', ['Zoé Exemple'])).toBe('[nom] [nom], je cherche un T3.');
    expect(withoutNames('Bonjour, Helene Exemple cherche un T3.', ['Hélène', 'Exemple'])).toBe('Bonjour, [nom] [nom] cherche un T3.');
    expect(withoutNames('Jean Pierre Exemple cherche.', ['Jean-Pierre', 'Exemple'])).toBe('[nom] [nom] cherche.');
    expect(withoutNames('Madame Le Gall cherche à la gare.', ['Madame Le Gall'])).toBe('[nom] cherche à la gare.');
    expect(withoutNames('Le T3 de la gare, pour Le Gall.', ['Le Gall'])).toBe('Le T3 de la gare, pour [nom].');
    expect(withoutNames('Maison à Dijon pour Dijon Exemple.', ['Dijon Exemple'])).toBe('Maison à Dijon pour [nom].');
    expect(withoutNames('Je suis M. Durand, je cherche un T3.', [])).toBe('Je suis [nom], je cherche un T3.');
    expect(withoutNames('Je m’appelle Zoé de la Tour et je cherche.', [])).toBe('Je m’appelle [nom] et je cherche.');
    expect(withoutNames('Je cherche un T3. Cordialement, Alix Durand', [])).toBe('Je cherche un T3.');
    expect(withoutNames('Je cherche un T3.\nAlix Durand', [])).toBe('Je cherche un T3.');
    expect(withoutNames('Je cherche un T3 à\nTalant', [])).toBe('Je cherche un T3 à\nTalant');
    expect(withoutNames('Nom : Durand\nPrénom : Basile\nJe cherche un T3.', [])).toBe('Nom : [nom]\nPrénom : [nom]\nJe cherche un T3.');
    expect(withoutNames('Trouvé par @zoe.exemple sur le réseau.', [])).toBe('Trouvé par [compte] sur le réseau.');
    expect(withoutNames('Je vends ma maison rue des Lilas à Talant.', [])).toBe('Je vends ma maison [adresse] à Talant.');
    expect(withoutNames('Maison au 12 de la rue Monge.', [])).toBe('Maison [adresse].');
    expect(withoutNames('Une place de parking dans la rue calme.', [])).toBe('Une place de parking dans la rue calme.');
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

describe('Q07 · critères niés et montants qui n’en sont pas', () => {
  const criteria = (text: string) => qualifyByRules(text).criteria;

  it('[R23] un critère nié n’est pas rangé, un critère affirmé à côté l’est', () => {
    expect(criteria('Je cherche une maison sans jardin.')).toEqual(['house']);
    expect(criteria('Je cherche une maison sans jardin ni garage.')).toEqual(['house']);
    expect(criteria('Je cherche un appartement, pas de cave, pas besoin d’ascenseur.')).toEqual(['apartment']);
    expect(criteria('Je cherche une maison, pas de jardin mais une terrasse.')).toEqual(['house', 'terrace']);
    expect(criteria('Je cherche une maison sans piscine avec garage.')).toEqual(['house', 'garage']);
    expect(criteria('Je ne veux pas de maison, plutôt un appartement.')).toEqual(['apartment']);
    expect(criteria('Je cherche un appartement sans grand balcon.')).toEqual(['apartment']);
  });

  it('[R23] pièces et chambres niées ne sont pas rangées ; le nombre affirmé l’est', () => {
    expect(criteria('Je cherche, pas un T2 mais un T3.')).toEqual(['rooms:3']);
    expect(criteria('Je cherche un appartement, pas 2 chambres, plutôt 3 chambres.')).toEqual(['apartment', 'bedrooms:3']);
  });

  it('une tournure où « pas » ne nie rien garde le critère', () => {
    expect(criteria('Je cherche, pas de souci pour une maison avec jardin.')).toEqual(['house', 'garden']);
    expect(criteria('Pas loin du centre, je cherche un jardin.')).toEqual(['garden']);
    expect(criteria('Je cherche une maison pas trop chère avec jardin.')).toEqual(['house', 'garden']);
  });

  it('un critère nié une fois et affirmé plus loin est rangé : la personne l’a demandé', () => {
    expect(criteria('Pas de garage pour le moment. Finalement, je voudrais un garage.')).toEqual(['garage']);
  });

  const ai = (over: Partial<Qualified>): Qualified => ({
    category: 'buyer',
    route: null,
    city: null,
    budgetMinEur: null,
    budgetMaxEur: null,
    priceEur: null,
    deadline: null,
    financing: null,
    criteria: [],
    ...over,
  });

  it('[R23] l’IA qui range un critère que le message nie est refusée', () => {
    expect(checkAiQualification(ai({ criteria: ['garden'] }), 'Je cherche une maison sans jardin.')).toMatchObject({ rule: 'R23' });
    expect(checkAiQualification(ai({ criteria: ['rooms:2'] }), 'Je cherche, pas un T2 mais un T3.')).toMatchObject({ rule: 'R23' });
    expect(checkAiQualification(ai({ criteria: ['house'] }), 'Je cherche une maison sans jardin.')).toMatchObject({ criteria: ['house'] });
    // L'IA peut déduire un critère que le message ne cite pas tel quel : seul un refus écrit l'en empêche.
    expect(checkAiQualification(ai({ criteria: ['quiet'] }), 'Je cherche une maison sans jardin.')).toMatchObject({ criteria: ['quiet'] });
  });

  it('[R10] « frais inclus » n’écarte pas le budget, un montant de frais reste écarté', () => {
    expect(qualifyByRules('Je cherche une maison, budget frais inclus de 300 000 €.')).toMatchObject({ budgetMaxEur: 300_000 });
    expect(qualifyByRules('Je cherche une maison, budget frais de notaire inclus de 300 000 €.')).toMatchObject({ budgetMaxEur: 300_000 });
    expect(qualifyByRules('Je cherche une maison à 300 000 € frais compris.')).toMatchObject({ budgetMaxEur: 300_000 });
    expect(qualifyByRules('Je cherche une maison, budget hors frais de 300 000 €.')).toMatchObject({ budgetMaxEur: 300_000 });
    expect(qualifyByRules('Je cherche une maison, frais de notaire, budget 300 000 €.')).toMatchObject({ budgetMaxEur: 300_000 });
    expect(qualifyByRules('Je cherche une maison, frais de notaire de 20 000 €.')).toMatchObject({ budgetMaxEur: null });
    expect(qualifyByRules('Je cherche une maison, budget 300 000 € et apport de 20 000 €.')).toMatchObject({ budgetMaxEur: 300_000 });
  });

  it('[R10] l’IA qui donne l’apport comme budget est refusée, sauf si ce montant est aussi cité comme budget', () => {
    const text = 'Je cherche une maison, apport de 50 000 €, budget maximum de 300 000 €.';
    expect(checkAiQualification(ai({ budgetMaxEur: 50_000 }), text)).toMatchObject({ rule: 'R10' });
    expect(checkAiQualification(ai({ budgetMaxEur: 300_000 }), text)).toMatchObject({ budgetMaxEur: 300_000 });
    expect(checkAiQualification(ai({ budgetMaxEur: 50_000 }), 'Budget 50 000 € pour un garage, apport de 50 000 €.')).toMatchObject({ budgetMaxEur: 50_000 });
  });

  it('[R23] une négation qui porte sur autre chose ne fait pas perdre le critère', () => {
    expect(criteria('Je ne sais pas combien vaut ma maison.')).toEqual(['house']);
    expect(criteria('Je ne connais pas la valeur de mon appartement à Dijon.')).toEqual(['apartment']);
    expect(criteria('Je ne suis pas pressé de vendre ma maison.')).toEqual(['house']);
    expect(criteria('J’achète sans crédit une maison à Dijon.')).toEqual(['house']);
    expect(criteria('Achat sans prêt appartement T3 Dijon')).toEqual(['apartment', 'rooms:3']);
    expect(criteria('Je cherche une maison sans travaux 4 chambres jardin')).toEqual(['house', 'garden', 'bedrooms:4']);
    expect(criteria('Je cherche une maison, pas de travaux et 3 chambres')).toEqual(['house', 'bedrooms:3']);
    expect(criteria('Je cherche un appartement pas très cher 3 pièces')).toEqual(['apartment', 'rooms:3']);
    expect(criteria('Je cherche une maison pas moins de 3 chambres')).toEqual(['house', 'bedrooms:3']);
    expect(checkAiQualification(ai({ criteria: ['house'] }), 'Je ne sais pas combien vaut ma maison.')).toMatchObject({ criteria: ['house'] });
  });

  it('[R23] toutes les formes d’une négation écartent le critère, pour les règles comme pour l’IA', () => {
    expect(criteria('Je cherche une maison (sans jardin).')).toEqual(['house']);
    expect(criteria('Nous ne voulons plus de jardin ni de piscine, nous cherchons un appartement.')).toEqual(['apartment']);
    expect(criteria('Je cherche une maison, jardin pas nécessaire.')).toEqual(['house']);
    expect(criteria('Je cherche un appartement, ascenseur pas obligatoire, garage pas indispensable.')).toEqual(['apartment']);
    expect(criteria('Je cherche une maison, garage : non.')).toEqual(['house']);
    expect(criteria('Je ne veux pas de piscine, de jardin ou de cave.')).toEqual([]);
    expect(criteria('Surtout pas de maison avec piscine, je cherche un appartement.')).toEqual(['apartment']);
    expect(criteria('Pas besoin d’un grand jardin, je cherche une terrasse.')).toEqual(['terrace']);
    expect(checkAiQualification(ai({ criteria: ['elevator'] }), 'Je cherche, ascenseur pas obligatoire.')).toMatchObject({ rule: 'R23' });
    // « Plus » seul ne nie rien.
    expect(criteria('Je cherche plus de jardin.')).toEqual(['garden']);
  });

  it('[R10] « max » ou « jusqu’à » après un apport ou des frais ne font pas un budget', () => {
    expect(qualifyByRules('Je cherche une maison, mensualité max 1 200 €, budget 300 000 €.')).toMatchObject({ budgetMaxEur: 300_000 });
    expect(qualifyByRules('Je cherche un appartement, apport jusqu’à 50 000 €, budget 250 000 €.')).toMatchObject({ budgetMaxEur: 250_000 });
    expect(qualifyByRules('Je cherche un appartement, charges max 150 €, budget 200 000 €.')).toMatchObject({ budgetMaxEur: 200_000 });
    expect(qualifyByRules('Je cherche une maison, apport maximum 30 000 €.')).toMatchObject({ budgetMaxEur: null });
    expect(qualifyByRules('Je cherche un appartement, frais de notaire max 20 000 €.')).toMatchObject({ budgetMaxEur: null });
    expect(checkAiQualification(ai({ budgetMaxEur: 30_000 }), 'Je cherche, apport maximum 30 000 €, budget 200 000 €.')).toMatchObject({ rule: 'R10' });
  });

  it('[R10] le chiffre d’un T3 ne se colle pas au montant qui suit', () => {
    expect(qualifyByRules('Je cherche un T3 250 000 € à Dijon')).toMatchObject({ budgetMaxEur: 250_000, criteria: ['rooms:3'] });
    expect(checkAiQualification(ai({ budgetMaxEur: 250_000 }), 'Je cherche un T3 250 000 € à Dijon')).toMatchObject({ budgetMaxEur: 250_000 });
  });
});
