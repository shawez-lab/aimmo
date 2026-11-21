/**
 * AU106 · le parcours de l'agent sur téléphone, mesuré : ouvrir une fiche, chercher, enregistrer un geste, sur un
 * portefeuille chargé et un réseau mobile modélisé. Le poids compressé d'un écran (`budgetProblems`) ne dit rien du
 * temps qu'attend l'agent : ici, chaque étape compte le temps du serveur mesuré, chaque requête à la base, l'aller-retour
 * du réseau et le transport de ce qui part et de ce qui revient. Seuils au 95e centile, publiés dans `docs/MESURE.md`.
 *
 * Ce que ce parcours ne dit pas : la vitesse sur un vrai téléphone, sur un vrai réseau, avec la vraie base D1 ; il
 * en donne un modèle prudent, rejoué à chaque vérification.
 */

/** Un réseau mobile médiocre, celui d'une cave ou d'une campagne : aller-retour, débits, et le coût d'une requête D1. */
export interface MobileNetwork {
  name: string;
  /** Un aller-retour complet entre le téléphone et le Worker, connexion déjà ouverte. */
  rttMs: number;
  /** Débits en kilobits par seconde, soit des bits par milliseconde. */
  downKbps: number;
  upKbps: number;
  /** Une requête du Worker à la base D1, du même centre de données. */
  queryMs: number;
}

export const RESEAU_MOBILE: Readonly<MobileNetwork> = Object.freeze({ name: '4G lente', rttMs: 150, downKbps: 1600, upKbps: 750, queryMs: 5 });

/** Un portefeuille chargé : ce que tient un agent installé depuis quelques années. Inventé à chaque test. */
export const PORTEFEUILLE = Object.freeze({ clients: 1000, messagesParClient: 4, rappelsParClient: 1, biens: 400 });

/** Les seuils au 95e centile, en millisecondes, du geste à la réponse lue. */
export const SEUILS_P95 = Object.freeze({ ouverture: 1000, recherche: 1500, sauvegarde: 1000 });
/**
 * Le plus de requêtes à la base par geste. Il ne dépend pas de la taille du portefeuille : une fiche se lit en quelques
 * requêtes ; une recherche lit tous les biens en quelques requêtes, puis demande la porte de la diffusion aux seuls biens
 * qu'elle montre (20 au plus par liste, environ six requêtes chacun) [R42].
 */
export const PLAFOND_REQUETES = Object.freeze({ ouverture: 40, recherche: 160, sauvegarde: 40 });
export type Etape = keyof typeof SEUILS_P95;
export const ETAPES = Object.keys(SEUILS_P95) as Etape[];

/** Ce qu'une étape a coûté, mesuré par le test. */
export interface Echantillon {
  /** Le temps du serveur, mesuré, hors base. */
  serverMs: number;
  /** Le nombre de requêtes à la base. */
  queries: number;
  /** Les octets envoyés et reçus, tels qu'ils voyagent (compressés pour la réponse). */
  requestBytes: number;
  responseBytes: number;
}

/** Le temps qu'attend l'agent pour une étape, sur ce réseau. */
export function modeledMs(sample: Echantillon, net: MobileNetwork = RESEAU_MOBILE): number {
  return net.rttMs + sample.serverMs + sample.queries * net.queryMs + (sample.requestBytes * 8) / net.upKbps + (sample.responseBytes * 8) / net.downKbps;
}

/** Le 95e centile, par la méthode du rang le plus proche ; `NaN` sans valeur. */
export function p95(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

export interface MesureParcours {
  etape: Etape;
  p95Ms: number;
  seuilMs: number;
  echantillons: number;
}

/** Les mesures d'un parcours, étape par étape ; une étape sans échantillon ou au-delà de son seuil est un problème. */
export function parcoursProblems(samples: Readonly<Record<Etape, readonly Echantillon[]>>, net: MobileNetwork = RESEAU_MOBILE): { mesures: MesureParcours[]; problems: string[] } {
  const mesures: MesureParcours[] = [];
  const problems: string[] = [];
  for (const etape of ETAPES) {
    const list = samples[etape] ?? [];
    const value = p95(list.map((s) => modeledMs(s, net)));
    mesures.push({ etape, p95Ms: Math.round(value), seuilMs: SEUILS_P95[etape], echantillons: list.length });
    if (list.length < 20) problems.push(`${etape} : ${list.length} échantillons, 20 au moins`);
    else if (!(value <= SEUILS_P95[etape])) problems.push(`${etape} : ${Math.round(value)} ms au 95e centile pour ${SEUILS_P95[etape]} ms (${net.name})`);
  }
  return { mesures, problems };
}
