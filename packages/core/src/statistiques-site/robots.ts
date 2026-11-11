/**
 * Les robots ne comptent pas dans les vues du site (RC12) [R285].
 *
 * Le navigateur annoncé par la visite est lu ici seulement, pour décider ; il n'est jamais rangé ni écrit au journal.
 * Une visite sans navigateur, ou dont le navigateur porte une marque de la liste fermée ci-dessous, n'est pas une
 * personne : moteurs de recherche et robots d'IA, aperçus de liens des messageries et réseaux, outils de mesure,
 * navigateurs sans écran, bibliothèques de script.
 */

/** Les marques d'un robot, lues sans tenir compte des majuscules. « bot » seul, sauf le téléphone Cubot. */
const ROBOT_MARKS: readonly RegExp[] = [
  /(?<!cu)bot(?![a-z])/i,
  /crawl/i,
  /spider/i,
  /slurp/i,
  /scrap/i,
  /facebookexternalhit/i,
  /facebookcatalog/i,
  /^whatsapp\//i,
  /embedly/i,
  /preview/i,
  /feedfetcher/i,
  /mediapartners/i,
  /lighthouse/i,
  /pagespeed/i,
  /gtmetrix/i,
  /pingdom/i,
  /uptime/i,
  /headless/i,
  /phantomjs/i,
  /puppeteer/i,
  /playwright/i,
  /selenium/i,
  /^curl\//i,
  /^wget\//i,
  /python-requests/i,
  /python-urllib/i,
  /aiohttp/i,
  /httpx/i,
  /go-http-client/i,
  /okhttp/i,
  /^axios\//i,
  /node-fetch/i,
  /^java\//i,
  /libwww-perl/i,
  /apache-httpclient/i,
];

/** Le navigateur annoncé est-il celui d'un robot ? Vide, absent ou illisible : oui [R285]. */
export function isRobotVisit(userAgent: unknown): boolean {
  if (typeof userAgent !== 'string') return true;
  const ua = userAgent.trim();
  if (ua === '') return true;
  return ROBOT_MARKS.some((mark) => mark.test(ua));
}
