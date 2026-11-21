import { TRIAL_MODE, handleRequest } from './app.ts';
import { REGISTRE_GELS_URL, REGISTRE_GELS_USER_AGENT } from './securite.ts';
import { handleEmail, type InboundEmail } from './courrier.ts';
import { fromD1, type D1Database } from './d1.ts';
import { investorFeesRate, runScheduler } from './planificateur.ts';
import { letterUnsubscribeBase } from './marketing-passage.ts';
import { isQuarterMinute, runNotificationsPass } from './notifications.ts';
import { R2PieceStore, type R2Like } from './dossiers.ts';
import { runListingSync, type MediaStore } from './vitrine.ts';
import type { AnnonceOptions } from './annonces.ts';
import { R2AgentPieceStore, type R2AgentBucket, type ReseauOptions } from './reseau.ts';
import { D1SandboxStorage } from './bac-a-sable.ts';
import { R2VaultStorage, type R2VaultBucket } from './conformite.ts';
import { R2PartnerFiles, type R2PartnerBucket } from './partenaires.ts';
import { R2DossierStorage, type R2DossierBucket } from './commerces.ts';
import { R2FichiersPlages, plagesBucket } from './reprise-fichiers.ts';
import { BanGeocoder, DvfSiteSales, EstimationEnLigne, GpuUrbanism, annonces, httpDvfReader, SqlJournalStore } from '@aimmo/core';
import type { StudioUploadStore } from '../../core/src/studio/depot.ts';
import { readClesConfig } from './cles.ts';
import { AdemeDiagnosisFeed } from '../../core/src/veille-dpe/index.ts';
import { HttpPigeSource, missingPigeSettings, type PigeFetcher, type PigeProviderSettings, type PigeSource } from '../../core/src/pige/index.ts';
import { runLiveWithdrawals, socialFromEnv } from './reseaux-reels.ts';

/**
 * AU036 : les vrais Facebook et Instagram du réseau. Publier seulement quand tout est rangé (sinon tout reste d'essai) ;
 * retirer tant que le compte et le jeton sont rangés, même une fois les envois coupés [R42].
 */
const socialOf = (env: Env) => socialFromEnv(env, fetch.bind(globalThis));
const socialSettings = (s: ReturnType<typeof socialOf>) => ({ social: s.publish, withdrawals: s.withdraw });

/**
 * Liaisons du Worker, déclarées dans wrangler.toml ; `API_KEYS` et `INTAKE_KEYS` sont des secrets Cloudflare.
 * `MAIL_NETWORK_ID`, `MAIL_FORWARD_TO` et `MAIL_OWN_ADDRESSES` servent à la réception des mails (C06).
 */
export interface Env {
  /** AU068 · « oui » : la relecture des annonces en ligne lit les pages publiques des portails (H10). Absent : aucune relecture. */
  RELECTURE_PORTAILS?: string;
  DB: D1Database;
  /** AU025 : la base D1 à part des bacs à sable, en Europe, jamais celle du réseau. Absente, le bac à sable reste fermé. */
  BAC_A_SABLE_DB?: D1Database;
  /** AU025 : le module d'académie que vaut le premier parcours fini ; absent, le parcours ne compte pas à l'académie. */
  BAC_A_SABLE_MODULE?: string;
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
  /** AU036 : `reel` met en service les vrais réseaux, avec `META_PAGE_ID`, `META_IG_USER_ID`, `META_PAGE_TOKEN` (un secret) et `RESEAUX_MEDIA_BASE`. */
  RESEAUX_MODE?: string;
  META_PAGE_ID?: string;
  META_IG_USER_ID?: string;
  META_PAGE_TOKEN?: string;
  RESEAUX_MEDIA_BASE?: string;
  /** Adresse publique des fichiers DVF du site, lus en lecture seule (E05), par exemple `https://…/donnees-dvf/`. */
  DVF_BASE_URL?: string;
  /** L'adresse du fichier JSON du registre des gels (BR85) ; absente, celle de la documentation de la DG Trésor. */
  REGISTRE_GELS_URL?: string;
  /** Début du lien pour décaler ou annuler un rendez-vous (V04), en https, sans chiffre, terminé par `/`. */
  RDV_LINK_BASE?: string;
  /** Début du lien de désinscription des alertes (T03), en https, sans chiffre, terminé par `/alertes/desinscription/`. */
  ALERT_UNSUBSCRIBE_BASE?: string;
  /** Début du lien de désinscription de la lettre (BR112), en https, sans chiffre, terminé par `/lettre/desinscription/` ; absent, aucune lettre ne part. */
  LETTRE_DESINSCRIPTION_BASE?: string;
  /**
   * Le barème des frais d'acquisition réglé par la direction (M17), en points de base du prix, entier de 0 à 2 000, suivi
   * de la date du réglage : `750@2027-09-01`. Absent ou mal formé, aucune alerte qui demande un rendement.
   */
  INVESTIR_FRAIS_BAREME?: string;
  /** Le site WebAuthn des clés d'appareil (BR05) : le domaine de l'application, sans schéma ; absent, les clés sont fermées. */
  CLES_RP_ID?: string;
  /** Les origines admises des clés d'appareil, en https, séparées par des virgules. */
  CLES_ORIGINS?: string;
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
  /** Les documents des dossiers protégés des commerces (R2), à part de tout autre stockage (H38) ; absent, le dossier ne sert que la fiche. */
  COMMERCES?: R2DossierBucket;
  /** Le coffre de la conformité (R2), séparé de tout autre stockage (L09) ; absent, dépôt et ouverture fermés. */
  COFFRE?: R2VaultBucket;
  /** Début du lien d'opposition à la prospection des partenaires (U09), en https, sans chiffre, terminé par `/partenaires/opposition/`. */
  PARTENAIRES_OPPOSITION_BASE?: string;
  /** Le réseau des espaces des clients (EC07) ; absent, l'espace est fermé. */
  ESPACE_NETWORK_ID?: string;
  /** Le réseau qui exploite la plateforme (BR25) : seule sa direction lit et décide des seuils du passage à PostgreSQL. */
  PLATFORM_NETWORK_ID?: string;
  /** L'adresse de l'espace des clients (EC07), en https, sans chiffre, terminée par `/espace/` ; absente, l'espace est fermé. */
  ESPACE_BASE?: string;
  /** Secret : les clés du relevé prouvé de l'espace, `nom:secret` séparées par des virgules ; absent, relevé indisponible [R164]. */
  ESPACE_RELEVE_KEYS?: string;
  /** AU034 : l'adresse https des annonces du fournisseur de pige retenu par le réseau ; absente, aucune relève. */
  PIGE_SOURCE_URL?: string;
  /** AU034, secret : la clé donnée par le fournisseur de pige. */
  PIGE_SOURCE_TOKEN?: string;
  /** AU034 : le réseau dont le fournisseur couvre le secteur ; seul lui relève. */
  PIGE_NETWORK_ID?: string;
}

/** Les réglages du fournisseur de pige (AU034), tels quels : leur forme est contrôlée par la couche métier. */
export function pigeProvider(env: Pick<Env, 'PIGE_SOURCE_URL' | 'PIGE_SOURCE_TOKEN' | 'PIGE_NETWORK_ID'>): PigeProviderSettings {
  return { url: env.PIGE_SOURCE_URL, token: env.PIGE_SOURCE_TOKEN, networkId: env.PIGE_NETWORK_ID };
}

/** Le vrai fournisseur de pige, seulement quand aucun réglage ne manque ; sinon aucune source [R671]. */
export function pigeSourceOf(settings: PigeProviderSettings, fetcher: PigeFetcher = fetch.bind(globalThis)): { networkId: string; source: PigeSource } | null {
  if (missingPigeSettings(settings).length > 0) return null;
  return { networkId: (settings.networkId ?? '').trim(), source: new HttpPigeSource(fetcher, { url: settings.url ?? '', token: settings.token ?? '' }) };
}

/** L'adresse du registre des gels : une adresse https seule, sinon celle de la documentation de la DG Trésor (BR85). */
export function registreGelsUrl(value: string | undefined): string {
  if (typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value.trim())) return value.trim();
  return REGISTRE_GELS_URL;
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

/**
 * Les fichiers déposés de l'agence sous licence (BR82) : les compartiments des médias, des pièces et des commerces qui
 * savent `head` et `get`, jamais le coffre [R663] ; aucun : `null`, les routes des contenus sont fermées.
 */
export function fichiersReprise(env: Pick<Env, 'MEDIA' | 'PIECES' | 'COMMERCES'>): R2FichiersPlages | null {
  const buckets = [env.MEDIA, env.PIECES, env.COMMERCES].map(plagesBucket).filter((b) => b !== null);
  return buckets.length > 0 ? new R2FichiersPlages(buckets) : null;
}

function sandboxOptions(env: Env): NonNullable<ReseauOptions['sandbox']> | null {
  if (!env.BAC_A_SABLE_DB || env.BAC_A_SABLE_DB === env.DB) return null;
  const moduleId = env.BAC_A_SABLE_MODULE && /^[A-Za-z0-9_-]{1,64}$/.test(env.BAC_A_SABLE_MODULE) ? env.BAC_A_SABLE_MODULE : null;
  // Aucune migration à jouer ici : la mise en ligne applique à cette base les mêmes migrations qu'à celle du réseau.
  return { migrations: [], storage: new D1SandboxStorage(fromD1(env.BAC_A_SABLE_DB), fromD1(env.DB)), academyModuleId: moduleId };
}

/**
 * AU067 · Les canaux et les connecteurs réels des annonces et des portails, les mêmes pour le retrait immédiat et pour
 * le passage des quarts d'heure qui en réessaie les échecs. Aucun n'est encore branché (H10) : tout reste en essai.
 */
function listingOptions(_env: Env): AnnonceOptions {
  return {};
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const estimation = estimationServices(env);
    return handleRequest(request, {
      db: fromD1(env.DB),
      listing: listingOptions(env),
      apiKeys: env.API_KEYS,
      intakeKeys: env.INTAKE_KEYS,
      mode: env.MODE,
      appointmentLinkBase: env.RDV_LINK_BASE,
      alertUnsubscribeBase: env.ALERT_UNSUBSCRIBE_BASE,
      ...(env.MEDIA ? { media: env.MEDIA } : {}),
      ...(env.PIECES ? { pieces: new R2PieceStore(env.PIECES) } : {}),
      // M14 (J13) : sans IA branchée (H13), l'entraînement rend les répliques écrites.
      // AU025 : le bac à sable vit dans sa propre base D1, avec les migrations du réseau et aucune de ses lignes.
      reseau: { pieces: env.PIECES ? new R2AgentPieceStore(env.PIECES) : null, sandbox: sandboxOptions(env) },
      candidatureNetworkId: env.CANDIDATURE_NETWORK_ID,
      // BR05 : sans site WebAuthn réglé (H64), les routes des clés d'appareil et de l'export de l'agent sont fermées.
      cles: readClesConfig(env.CLES_RP_ID, env.CLES_ORIGINS),
      coffre: env.COFFRE ? new R2VaultStorage(env.COFFRE) : null,
      fichiersReprise: fichiersReprise(env),
      // M18 (U09) : preuves et pièces des partenaires dans `PIECES`, sous `partenaires/` ; absent, routes fermées.
      platformNetworkId: env.PLATFORM_NETWORK_ID,
      espaces: { networkId: env.ESPACE_NETWORK_ID, baseUrl: env.ESPACE_BASE, releveKeys: env.ESPACE_RELEVE_KEYS },
      partenaires: { files: env.PIECES ? new R2PartnerFiles(env.PIECES) : null, optOutBase: env.PARTENAIRES_OPPOSITION_BASE ?? null },
      // M17 (Y08) : sans IA branchée (H13), la note suit le secours sans IA ; le barème vient du réglage de la direction.
      investir: { feesRateBp: investorFeesRate(env.INVESTIR_FRAIS_BAREME) },
      // M16 (CE10, CE22) : sans stockage réel des documents (H38), le dossier protégé ne sert que la fiche du commerce.
      commerces: {
        ...(dossierLinkBase(env.DOSSIER_LINK_BASE) ? { baseUrl: dossierLinkBase(env.DOSSIER_LINK_BASE)! } : {}),
        ...(env.COMMERCES ? { storage: new R2DossierStorage(env.COMMERCES) } : {}),
      },
      // M19 (X10) : photos, originaux, preuves et accords dans `MEDIA`, dont seule l'existence est lue ; absent, fermé.
      // X12 : les fichiers finis rangés tels quels dans `MEDIA` ; sans lui (H25), le dépôt est fermé.
      // AU036 : les vrais Facebook et Instagram du réseau seulement quand tout est rangé (H06, H77) ; sinon, essai.
      studio: { files: env.MEDIA ? mediaFiles(env.MEDIA) : null, uploads: env.MEDIA ? mediaUploads(env.MEDIA) : null, ...socialSettings(socialOf(env)) },
      // M20 complet (G12) : preuves de coût dans `PIECES` ; géocodeur des lettres seulement avec les données publiques
      // de l'estimation ; sans IA branchée (H13), les textes du code. Rien ne part : mode essai.
      gagner: { proofs: env.PIECES ? new R2PartnerFiles(env.PIECES) : null, uploads: env.PIECES ? new R2PartnerFiles(env.PIECES) : null, geocoder: estimation?.geocoder ?? null },
      ...(estimation ? { estimation, fetchPublicData: fetch.bind(globalThis) } : {}),
      // AU034 : le vrai fournisseur de la pige, et ses réglages pour l'état de la relève [R671].
      pigeSource: pigeSourceOf(pigeProvider(env))?.source ?? null,
      pigeProvider: pigeProvider(env),
      // BR85 : le registre des gels lu en GET sur le fichier public, au seul appui du responsable ; jamais un envoi.
      registreGels: { get: fetch.bind(globalThis), url: registreGelsUrl(env.REGISTRE_GELS_URL), userAgent: REGISTRE_GELS_USER_AGENT },
      // BR87 : la zone du résumé de copropriété lue en GET à la Base adresse nationale puis au Géoportail, au seul appui
      // de l'agent du bien ; aucun secret, jamais un envoi. Sans lecteur IA (H13), la prélecture laisse tout à lire.
      // AU073 : les secteurs des recherches et la position des biens, à la Base adresse nationale, même sans DVF.
      secteursGeocoder: new BanGeocoder(fetch.bind(globalThis)),
      copropriete: { geocoder: new BanGeocoder(fetch.bind(globalThis)), urbanism: new GpuUrbanism(fetch.bind(globalThis)) },
      mail: { networkId: env.MAIL_NETWORK_ID, forwardTo: env.MAIL_FORWARD_TO, ownAddresses: env.MAIL_OWN_ADDRESSES },
      meta: {
        appSecret: env.META_APP_SECRET,
        verifyTokenSha256: env.META_VERIFY_TOKEN_SHA256,
        networkId: env.META_NETWORK_ID,
        ownIds: env.META_OWN_IDS,
        appIds: env.META_APP_IDS,
      },
    });
  },
  /**
   * Déclencheur de chaque minute (wrangler.toml, `[triggers]`, BR65) : le passage des notifications aux agents à chaque
   * minute ; le planificateur du socle (B02) et la publication (P10) aux seuls quarts d'heure, comme avant. Une panne du
   * passage des notifications est écrite au journal et n'empêche pas le planificateur.
   */
  async scheduled(controller: { scheduledTime?: number } | undefined, env: Env): Promise<void> {
    await runNotificationsPass({ db: fromD1(env.DB), mode: env.MODE });
    const at = typeof controller?.scheduledTime === 'number' ? new Date(controller.scheduledTime) : new Date();
    if (!isQuarterMinute(at)) return;
    const estimation = estimationServices(env);
    await runScheduler({
      db: fromD1(env.DB),
      mode: env.MODE,
      listingReader: env.RELECTURE_PORTAILS === 'oui' ? new annonces.HttpListingReader(fetch.bind(globalThis) as unknown as annonces.FetchLike) : null,
      appointmentLinkBase: env.RDV_LINK_BASE,
      alertUnsubscribeBase: env.ALERT_UNSUBSCRIBE_BASE,
      communeRanges: estimation ? new EstimationEnLigne(estimation.geocoder, estimation.sales) : null,
      apresVenteBase: env.APRES_VENTE_BASE,
      soldSales: estimation?.sales ?? null,
      geocoder: estimation?.geocoder ?? null,
      pieces: env.PIECES ? new R2PieceStore(env.PIECES) : null,
      partnerOptOutBase: env.PARTENAIRES_OPPOSITION_BASE,
      investorFeesRateBp: investorFeesRate(env.INVESTIR_FRAIS_BAREME),
      platformNetworkId: env.PLATFORM_NETWORK_ID,
      dpeFeed: new AdemeDiagnosisFeed(fetch.bind(globalThis)),
      // BR112 : le calendrier de publication lit les certificats et les accords dans `MEDIA` ; la lettre attend son lien.
      studioFiles: env.MEDIA ? mediaFiles(env.MEDIA) : null,
      letterUnsubscribeBase: letterUnsubscribeBase(env.LETTRE_DESINSCRIPTION_BASE),
      // AU034 : la relève quotidienne de la pige, seulement avec le fournisseur réglé.
      pigeProvider: pigeSourceOf(pigeProvider(env)),
    });
    // Le passage de publication (P10), une fois par quart d'heure, hors du planificateur horaire.
    if (env.MODE === TRIAL_MODE) await runListingSync(fromD1(env.DB), undefined, listingOptions(env));
    // AU036 : les vraies publications d'un bien qui ne peut plus être diffusé sont retirées chez le réseau [R42].
    const social = socialOf(env).withdraw;
    if (env.MODE === TRIAL_MODE && social) {
      const db = fromD1(env.DB);
      await runLiveWithdrawals(db, new SqlJournalStore(db), () => new Date(), social);
    }
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
