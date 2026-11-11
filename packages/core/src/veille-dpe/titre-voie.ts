/**
 * Le titre d'une voie (« rue du Docteur Chaussier », « place du Maréchal Leclerc ») n'est pas une personne.
 *
 * Partagé par la veille des diagnostics et le score par adresse [R288, R292], et par les lettres de quartier [R140] :
 * le titre qui suit juste le type de la voie, avec un article facultatif, est remplacé par « voie » avant le contrôle
 * des civilités. Toute autre marque de personne reste. Ce fichier n'importe rien, pour n'ouvrir aucun cycle.
 */
const ROAD_TITLE = /(?:^| )(?:rue|avenue|av|boulevard|bd|place|allee|impasse|quai|square|chemin|cours|route|passage|promenade|rond point|esplanade|parc|residence)(?: (?:du|de la|de l|des|de|d))? (?:docteur|dr|maitre|me|m|monsieur|madame|president|general|marechal|professeur|abbe|cardinal|commandant|colonel|capitaine|lieutenant|chanoine|pere|mere|saint|sainte)(?= |$)/g;

/** Le texte, déjà réduit à des mots sans accent ni ponctuation, sans le titre de ses voies. */
export function withoutRoadTitles(words: string): string {
  return ` ${words} `.replace(ROAD_TITLE, ' voie').trim();
}
