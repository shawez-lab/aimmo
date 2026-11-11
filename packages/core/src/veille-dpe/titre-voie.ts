/**
 * Le titre d'une voie (« rue du Docteur Chaussier », « place du Maréchal Leclerc ») n'est pas une personne.
 *
 * Partagé par la veille des diagnostics et le score par adresse [R288, R292], et par les lettres de quartier [R140] :
 * le titre qui suit juste le type de la voie, avec un article facultatif, est remplacé par « voie » avant le contrôle
 * des civilités. Toute autre marque de personne reste. Ce fichier n'importe rien, pour n'ouvrir aucun cycle.
 */
/**
 * Les types de voie après lesquels un titre n'est pas une personne : ceux de la lettre de quartier, tous, plus ceux de la
 * veille (RC06). Un test relève que chaque type accepté par la lettre est ici, pour qu'ils ne divergent plus.
 */
export const ROAD_TITLE_TYPES = Object.freeze([
  'rue', 'ruelle', 'avenue', 'av', 'boulevard', 'bd', 'place', 'allee', 'impasse', 'quai', 'square', 'chemin', 'cours', 'route',
  'passage', 'promenade', 'rond point', 'esplanade', 'parc', 'residence', 'faubourg', 'lotissement', 'sentier', 'voie', 'parvis',
  'hameau', 'lieu dit', 'clos', 'cite', 'montee', 'venelle', 'traverse', 'mail',
] as const);
/** Les titres qui suivent le type d'une voie. Les abréviations de civilité (« Mme », « Mlle », « Mr ») n'y sont pas. */
export const ROAD_TITLES = Object.freeze([
  'docteur', 'dr', 'maitre', 'me', 'm', 'monsieur', 'madame', 'mademoiselle', 'president', 'general', 'marechal', 'professeur',
  'abbe', 'cardinal', 'commandant', 'colonel', 'capitaine', 'lieutenant', 'chanoine', 'pere', 'mere', 'saint', 'sainte',
] as const);
const ROAD_TITLE = new RegExp(`(?:^| )(?:${ROAD_TITLE_TYPES.join('|')})(?: (?:du|de la|de l|des|de|d))? (?:${ROAD_TITLES.join('|')})(?= |$)`, 'g');

/** Le texte, déjà réduit à des mots sans accent ni ponctuation, sans le titre de ses voies. */
export function withoutRoadTitles(words: string): string {
  return ` ${words} `.replace(ROAD_TITLE, ' voie').trim();
}
