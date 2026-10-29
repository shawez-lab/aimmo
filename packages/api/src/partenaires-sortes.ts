/**
 * Les noms en français des pièces qu'un partenaire dépose (U10), partagés par les routes de M18 et par l'écran
 * « Partenaires » de l'application de l'agent (U11). Données seules : aucun import, pour rester lisible des deux côtés.
 */
export const SORT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  dpe: 'Diagnostic de performance énergétique',
  amiante: 'Constat amiante',
  plomb: 'Constat de risque d’exposition au plomb',
  electricite: 'Diagnostic électricité',
  gaz: 'Diagnostic gaz',
  termites: 'État relatif aux termites',
  mesurage_carrez: 'Mesurage loi Carrez',
  bornage: 'Plan de bornage',
  titre_propriete: 'Titre de propriété',
  pre_etat_date: 'Pré-état daté',
  projet_compromis: 'Projet de compromis',
  projet_acte: 'Projet d’acte',
  accord_principe: 'Accord de principe',
  offre_pret: 'Offre de prêt',
  devis: 'Devis',
});
