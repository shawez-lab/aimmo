/**
 * 50 contacts inventés, chacun avec le classement attendu. Aucune vraie personne, aucun vrai numéro, aucune vraie
 * adresse. Les cas réels anonymisés de Shawez (H18) ne viendront jamais dans le dépôt : ils seront mesurés à part (Q05).
 */
import type { Category, Route } from '../../src/index.ts';

export interface QualificationCase {
  text: string;
  category: Category;
  route?: Route | null;
  /** Le message cite un bien reconnu. */
  property?: boolean;
}

export const QUALIFICATION_CASES: readonly QualificationCase[] = [
  // Vendeurs
  { text: 'Bonjour, je souhaite vendre ma maison à Talant, 5 pièces avec jardin. Pouvez-vous me rappeler ?', category: 'seller' },
  { text: 'Nous envisageons de vendre notre appartement à Dijon d’ici 6 mois.', category: 'seller' },
  { text: 'Je vends mon studio rue de la Liberté, à combien pourrait-on le mettre en vente ?', category: 'seller' },
  { text: 'Bonsoir, on voudrait mettre en vente la maison de famille à Chenôve, pas pressés.', category: 'seller' },
  { text: 'Je pense à vendre mon T3 à Quetigny, prix souhaité 210 000 €.', category: 'seller' },
  { text: 'Hello, I want to sell my flat in Dijon. Je veux vendre rapidement.', category: 'seller' },
  { text: 'Bonjour, mandat de vente pour mon terrain à Daix, vous prenez ?', category: 'seller' },
  // Acquéreurs
  { text: 'Bonjour, la maison est-elle toujours disponible ? Je voudrais la visiter samedi.', category: 'buyer', property: true },
  { text: 'Je cherche un appartement 3 pièces à Dijon, budget 250 000 € maximum, avec balcon.', category: 'buyer' },
  { text: 'Nous recherchons une maison avec jardin à Fontaine-lès-Dijon, entre 300 000 et 350 000 euros, accord de principe de la banque.', category: 'buyer' },
  { text: 'Encore dispo ?', category: 'buyer', property: true },
  { text: 'Intéressé par ce bien, est-il possible de faire une visite ?', category: 'buyer', property: true },
  { text: 'Primo-accédants, nous cherchons un T2 lumineux à Longvic, achat d’ici 3 mois.', category: 'buyer' },
  { text: 'Bonjour, je souhaite acheter un terrain à Saint-Apollinaire pour faire construire.', category: 'buyer' },
  { text: 'Est-ce que ce bien est encore en vente ?', category: 'buyer', property: true },
  { text: 'Je cherche une maison de plain-pied avec garage, sans prêt, budget 280k.', category: 'buyer' },
  // Demandes d'estimation
  { text: 'Combien vaut mon appartement à Dijon centre ?', category: 'valuation' },
  { text: 'Bonjour, je voudrais une estimation de ma maison à Marsannay-la-Côte.', category: 'valuation' },
  { text: 'Pouvez-vous estimer notre maison, c’est pour une succession.', category: 'valuation' },
  { text: 'J’aimerais connaître la valeur de mon terrain à Ahuy.', category: 'valuation' },
  { text: 'Avis de valeur pour un appartement T4, merci.', category: 'valuation' },
  { text: 'Estimation gratuite possible ? Maison 4 pièces à Chevigny-Saint-Sauveur.', category: 'valuation' },
  // Mises en location
  { text: 'Je souhaite mettre en location mon appartement à Dijon, vous faites la gestion locative ?', category: 'rent_out', route: 'M15' },
  { text: 'Bonjour, je cherche un locataire pour mon studio près de la fac.', category: 'rent_out', route: 'M15' },
  { text: 'Nous voudrions louer notre maison à Talant pendant notre expatriation.', category: 'rent_out', route: 'M15' },
  { text: 'Mon locataire part en décembre, pouvez-vous relouer le bien ?', category: 'rent_out', route: 'M15' },
  { text: 'Faire louer mon T2 meublé, vous prenez quels frais ?', category: 'rent_out', route: 'M15' },
  // Professionnels
  { text: 'Je cherche un local commercial de 80 m² en centre-ville de Dijon pour ma boutique.', category: 'professional', route: 'M16' },
  { text: 'Bonjour, nous souhaitons céder notre fonds de commerce, un restaurant à Beaune.', category: 'professional', route: 'M16' },
  { text: 'Notre société cherche des bureaux à Quetigny, 150 m², bail commercial.', category: 'professional', route: 'M16' },
  { text: 'Vente des murs commerciaux de ma pharmacie, vous gérez ce type de bien ?', category: 'professional', route: 'M16' },
  { text: 'Reprise de mon entreprise de boulangerie à Genlis, je pars à la retraite.', category: 'professional', route: 'M16' },
  // Partenaires
  { text: 'Bonjour, je suis courtier en prêt immobilier à Dijon et je vous propose un partenariat.', category: 'partner' },
  { text: 'Je suis diagnostiqueur, je voudrais collaborer avec votre agence.', category: 'partner' },
  { text: 'Notre entreprise de rénovation peut vous proposer de travailler ensemble sur vos biens à rafraîchir.', category: 'partner' },
  { text: 'Je suis photographe immobilier, une collaboration vous intéresserait ?', category: 'partner' },
  { text: 'Apporteur d’affaires sur Dijon, je peux vous transmettre des vendeurs.', category: 'partner' },
  // Simples curiosités
  { text: 'Bonjour, quel est le prix moyen au mètre carré à Dijon en ce moment ?', category: 'curious' },
  { text: 'Vous êtes ouverts le samedi ?', category: 'curious' },
  { text: 'Je me renseigne juste sur le marché, merci.', category: 'curious' },
  { text: 'Super vidéo, très jolie maison !', category: 'curious' },
  { text: 'C’est où exactement ce quartier ?', category: 'curious' },
  { text: 'Les prix vont baisser l’an prochain à votre avis ?', category: 'curious' },
  // Indésirables
  { text: 'Augmentez vos ventes ! Cliquez ici : http://exemple.invalid/promo', category: 'spam' },
  { text: 'Boostez votre référencement SEO, offre exclusive pour votre site web.', category: 'spam' },
  { text: 'Investissez en crypto et doublez vos gains, www.exemple.invalid', category: 'spam' },
  { text: 'Nous pouvons augmenter vos abonnés Instagram en 7 jours.', category: 'spam' },
  // Locations et investissements, vers M15 et M17
  { text: 'Je cherche une location à Dijon, un T2 avec ascenseur.', category: 'buyer', route: 'M15' },
  { text: 'Je souhaite investir dans un immeuble de rapport à Dijon, quel rendement ?', category: 'buyer', route: 'M17' },
  { text: 'Investissement locatif LMNP, je cherche un studio près du campus.', category: 'buyer', route: 'M17' },
];
