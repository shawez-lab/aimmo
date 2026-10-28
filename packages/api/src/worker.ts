import { TRIAL_MODE, handleRequest } from './app.ts';
import { handleEmail, type InboundEmail } from './courrier.ts';
import { fromD1, type D1Database } from './d1.ts';
import { runScheduler } from './planificateur.ts';
import { R2PieceStore, type R2Like } from './dossiers.ts';
import { runListingSync, type MediaStore } from './vitrine.ts';
import { R2AgentPieceStore, type R2AgentBucket } from './reseau.ts';
import { BanGeocoder, DvfSiteSales, EstimationEnLigne, httpDvfReader } from '@aimmo/core';

/**
 * Liaisons du Worker, déclarées dans wrangler.toml ; `API_KEYS` et `INTAKE_KEYS` sont des secrets Cloudflare.
 * `MAIL_NETWORK_ID`, `MAIL_FORWARD_TO` et `MAIL_OWN_ADDRESSES` servent à la réception des mails (C06).
 */
export interface Env {
  DB: D1Database;
  API_KEYS?: string;
  INTAKE_KEYS?: string;
  MODE?: string;
  MAIL_NETWORK_ID?: string;
  MAIL_FORWARD_TO?: string;
  MAIL_OWN_ADDRESSES?: string;
  /** Notifications de Meta (C07) : `META_APP_SECRET` et `META_VERIFY_TOKEN_SHA256` sont des secrets. */
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN_SHA256?: string;
  META_NETWORK_ID?: string;
  META_OWN_IDS?: string;
  META_APP_IDS?: string;
  /** Adresse publique des fichiers DVF du site, lus en lecture seule (E05), par exemple `https://…/donnees-dvf/`. */
  DVF_BASE_URL?: string;
  /** Début du lien pour décaler ou annuler un rendez-vous (V04), en https, sans chiffre, terminé par `/`. */
  RDV_LINK_BASE?: string;
  /** Début du lien de désinscription des alertes (T03), en https, sans chiffre, terminé par `/alertes/desinscription/`. */
  ALERT_UNSUBSCRIBE_BASE?: string;
  /** Début des liens publics de l'après-vente (F07), en https, sans chiffre, terminé par `/apres-vente/`. */
  APRES_VENTE_BASE?: string;
  /**
   * Les pièces des dossiers de vente (R2) ; absent, les routes et le passage de M10 sont fermés. Les pièces des dossiers
   * d'agent (M14) y sont rangées sous `agents/<agent>/` ; absent, leurs routes répondent « indisponible ».
   */
  PIECES?: R2Like & R2AgentBucket;
  /** Le réseau qui reçoit les candidatures de la page `/rejoindre` (J13) ; absent, la page dit « bientôt ». */
  CANDIDATURE_NETWORK_ID?: string;
  /** Les médias des biens (R2), lus par la vitrine ; absent, aucune photo n'est servie. */
  MEDIA?: MediaStore;
}

/**
 * Les données publiques de l'estimation en ligne (E05), lues en GET seulement : jamais un envoi. Sans `DVF_BASE_URL`
 * en https, le service reste fermé.
 */
function estimationServices(env: Env) {
  const reader = env.DVF_BASE_URL ? httpDvfReader(fetch.bind(globalThis), env.DVF_BASE_URL) : null;
  return reader ? { geocoder: new BanGeocoder(fetch.bind(globalThis)), sales: new DvfSiteSales(reader) } : undefined;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const estimation = estimationServices(env);
    return handleRequest(request, {
      db: fromD1(env.DB),
      apiKeys: env.API_KEYS,
      intakeKeys: env.INTAKE_KEYS,
      mode: env.MODE,
      appointmentLinkBase: env.RDV_LINK_BASE,
      alertUnsubscribeBase: env.ALERT_UNSUBSCRIBE_BASE,
      ...(env.MEDIA ? { media: env.MEDIA } : {}),
      ...(env.PIECES ? { pieces: new R2PieceStore(env.PIECES) } : {}),
      // M14 (J13) : sans IA branchée (H13), l'entraînement rend les répliques écrites ; le bac à sable reste fermé.
      reseau: { pieces: env.PIECES ? new R2AgentPieceStore(env.PIECES) : null },
      candidatureNetworkId: env.CANDIDATURE_NETWORK_ID,
      ...(estimation ? { estimation } : {}),
      meta: {
        appSecret: env.META_APP_SECRET,
        verifyTokenSha256: env.META_VERIFY_TOKEN_SHA256,
        networkId: env.META_NETWORK_ID,
        ownIds: env.META_OWN_IDS,
        appIds: env.META_APP_IDS,
      },
    });
  },
  /** Déclencheur horaire (wrangler.toml, `[triggers]`) : le planificateur du socle (B02). */
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const estimation = estimationServices(env);
    await runScheduler({
      db: fromD1(env.DB),
      mode: env.MODE,
      appointmentLinkBase: env.RDV_LINK_BASE,
      alertUnsubscribeBase: env.ALERT_UNSUBSCRIBE_BASE,
      communeRanges: estimation ? new EstimationEnLigne(estimation.geocoder, estimation.sales) : null,
      apresVenteBase: env.APRES_VENTE_BASE,
      soldSales: estimation?.sales ?? null,
      geocoder: estimation?.geocoder ?? null,
      pieces: env.PIECES ? new R2PieceStore(env.PIECES) : null,
    });
    // Le passage de publication (P10), une fois par quart d'heure, hors du planificateur horaire.
    if (env.MODE === TRIAL_MODE) await runListingSync(fromD1(env.DB));
  },
  async email(message: InboundEmail, env: Env): Promise<void> {
    await handleEmail(message, {
      db: fromD1(env.DB),
      mode: env.MODE,
      networkId: env.MAIL_NETWORK_ID,
      forwardTo: env.MAIL_FORWARD_TO,
      ownAddresses: env.MAIL_OWN_ADDRESSES,
    });
  },
};
