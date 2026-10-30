import { TRIAL_MODE, handleRequest } from './app.ts';
import { handleEmail, type InboundEmail } from './courrier.ts';
import { fromD1, type D1Database } from './d1.ts';
import { investorFeesRate, runScheduler } from './planificateur.ts';
import { R2PieceStore, type R2Like } from './dossiers.ts';
import { runListingSync, type MediaStore } from './vitrine.ts';
import { R2AgentPieceStore, type R2AgentBucket } from './reseau.ts';
import { R2VaultStorage, type R2VaultBucket } from './conformite.ts';
import { R2PartnerFiles, type R2PartnerBucket } from './partenaires.ts';
import { BanGeocoder, DvfSiteSales, EstimationEnLigne, httpDvfReader } from '@aimmo/core';
import type { StudioUploadStore } from '../../core/src/studio/depot.ts';

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
  /**
   * Le barème des frais d'acquisition réglé par la direction (M17), en points de base du prix, entier de 0 à 2 000, suivi
   * de la date du réglage : `750@2027-09-01`. Absent ou mal formé, aucune alerte qui demande un rendement.
   */
  INVESTIR_FRAIS_BAREME?: string;
  /** Début des liens publics de l'après-vente (F07), en https, sans chiffre, terminé par `/apres-vente/`. */
  APRES_VENTE_BASE?: string;
  /** Début des liens du dossier protégé d'un commerce (CE10), en https, sans chiffre, terminé par `/` ; absent, aucun dossier ne part. */
  DOSSIER_LINK_BASE?: string;
  /**
   * Les pièces des dossiers de vente (R2) ; absent, les routes et le passage de M10 sont fermés. Les pièces des dossiers
   * d'agent (M14) y sont rangées sous `agents/<agent>/` ; absent, leurs routes répondent « indisponible ».
   */
  PIECES?: R2Like & R2AgentBucket & R2PartnerBucket;
  /** Le réseau qui reçoit les candidatures de la page `/rejoindre` (J13) ; absent, la page dit « bientôt ». */
  CANDIDATURE_NETWORK_ID?: string;
  /** Les médias des biens (R2), lus par la vitrine ; absent, aucune photo n'est servie. */
  MEDIA?: MediaStore & { head?(key: string): Promise<unknown>; put?(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> };
  /** Le coffre de la conformité (R2), séparé de tout autre stockage (L09) ; absent, dépôt et ouverture fermés. */
  COFFRE?: R2VaultBucket;
  /** Début du lien d'opposition à la prospection des partenaires (U09), en https, sans chiffre, terminé par `/partenaires/opposition/`. */
  PARTENAIRES_OPPOSITION_BASE?: string;
}

/**
 * Les données publiques de l'estimation en ligne (E05), lues en GET seulement : jamais un envoi. Sans `DVF_BASE_URL`
 * en https, le service reste fermé.
 */
function estimationServices(env: Env) {
  const reader = env.DVF_BASE_URL ? httpDvfReader(fetch.bind(globalThis), env.DVF_BASE_URL) : null;
  return reader ? { geocoder: new BanGeocoder(fetch.bind(globalThis)), sales: new DvfSiteSales(reader) } : undefined;
}

/** Le début des liens du dossier : en https, sans chiffre (un chiffre passerait pour un nombre du message), fini par `/`. */
export function dossierLinkBase(raw: string | undefined): string | null {
  if (!raw) return null;
  return /^https:\/\/[a-z.-]+(?:\/[a-z-]+)*\/$/i.test(raw) ? raw : null;
}

/**
 * L'existence d'une référence dans `MEDIA`, pour le Studio (X10) : par `head`, sans lire le fichier ; à défaut, par
 * `get`. Une panne du stockage remonte telle quelle : la couche métier la dit au journal et ferme tout [R130].
 */
export function mediaFiles(bucket: MediaStore & { head?(key: string): Promise<unknown> }): { has(ref: string): Promise<boolean> } {
  return {
    has: async (ref: string) => {
      const found = bucket.head ? await bucket.head(ref) : await bucket.get(ref);
      return found !== null && found !== undefined;
    },
  };
}

/**
 * Le dépôt des fichiers finis du Studio dans `MEDIA` (X12) : les octets reçus, rangés tels quels avec leur type ; sans
 * `put`, le dépôt reste fermé. Une panne remonte : la couche métier la dit au journal et ne range rien [R130].
 */
export function mediaUploads(bucket: { put?(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> }): StudioUploadStore | null {
  const put = bucket.put?.bind(bucket);
  if (!put) return null;
  return {
    put: async (key: string, bytes: Uint8Array, contentType: string) => {
      await put(key, bytes, { httpMetadata: { contentType } });
    },
  };
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
      coffre: env.COFFRE ? new R2VaultStorage(env.COFFRE) : null,
      // M18 (U09) : preuves et pièces des partenaires dans `PIECES`, sous `partenaires/` ; absent, routes fermées.
      partenaires: { files: env.PIECES ? new R2PartnerFiles(env.PIECES) : null, optOutBase: env.PARTENAIRES_OPPOSITION_BASE ?? null },
      // M17 (Y08) : sans IA branchée (H13), la note suit le secours sans IA ; le barème vient du réglage de la direction.
      investir: { feesRateBp: investorFeesRate(env.INVESTIR_FRAIS_BAREME) },
      // M16 (CE10) : sans stockage réel des documents (H38), le dossier protégé ne sert que la fiche du commerce.
      commerces: dossierLinkBase(env.DOSSIER_LINK_BASE) ? { baseUrl: dossierLinkBase(env.DOSSIER_LINK_BASE)! } : {},
      // M19 (X10) : photos, originaux, preuves et accords dans `MEDIA`, dont seule l'existence est lue ; absent, fermé.
      // X12 : les fichiers finis rangés tels quels dans `MEDIA` ; sans lui (H25), le dépôt est fermé.
      studio: { files: env.MEDIA ? mediaFiles(env.MEDIA) : null, uploads: env.MEDIA ? mediaUploads(env.MEDIA) : null },
      // M20 complet (G12) : preuves de coût dans `PIECES` ; géocodeur des lettres seulement avec les données publiques
      // de l'estimation ; sans IA branchée (H13), les textes du code. Rien ne part : mode essai.
      gagner: { proofs: env.PIECES ? new R2PartnerFiles(env.PIECES) : null, geocoder: estimation?.geocoder ?? null },
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
      partnerOptOutBase: env.PARTENAIRES_OPPOSITION_BASE,
      investorFeesRateBp: investorFeesRate(env.INVESTIR_FRAIS_BAREME),
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
