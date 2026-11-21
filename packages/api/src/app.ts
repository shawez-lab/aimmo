import { UNSUBSCRIBE_PATH, handleUnsubscribe } from './alertes.ts';
import { handleLetterUnsubscribe } from './lettre-desinscription.ts';
import { LETTER_UNSUBSCRIBE_PATH } from './marketing-passage.ts';
import {
  AIMMO_VERSION,
  AlertesAgent,
  ATTRIBUTION_RULES,
  ControleBaseLegale,
  AUTOMATION_NAMES,
  Acces,
  Automatisations,
  OUTBOUND_CHANNELS,
  PaliersBascule,
  mailIntakeState,
  metaIntakeState,
  type MailIntakeSettings,
  type MetaIntakeSettings,
  ROLLOUT_INCIDENTS,
  captationAutomation,
  type OutboundChannelName,
  type RolloutIncident,
  REF_PATTERN,
  DEFAULT_ATTRIBUTION_SETTINGS,
  CHANNELS,
  DecisionEnvoi,
  FicheClient,
  CATEGORIES,
  measureCasesCsv,
  AvisDeValeur,
  AvisImprime,
  PreparationAvis,
  publicDataServices,
  ChronologieMandat,
  ControlesSignature,
  SignatureEnLigne,
  MAX_CO_MANDANTS,
  SignatureAvenant,
  EcheancesMandats,
  Diffusion,
  SignaturePapier,
  MandatDuBien,
  FicheAgent,
  Modeles,
  Designations,
  FicheUnique,
  JourneeRendezVous,
  Qualification,
  ROUTES as NEXT_MODULES,
  PlansDuJour,
  RegistreMandats,
  UsageMatin,
  Rappels,
  Reception,
  ReconnaissanceBien,
  SEND_KINDS,
  SqlJournalStore,
  appendEvent,
  createCaptation,
  decideAccess,
  personSubject,
  verifyChain,
  agentState,
  type AccessResult,
  type Automation,
  type Channel,
  type JournalStore,
  type SendKind,
  type SendRequest,
  type SqlDatabase,
  type Viewer,
  type Fetcher,
  type ValuationReport,
} from '@aimmo/core';
import { bearerKey, fromMcpKey, intakeFromRequest, invitationKeyOf, markMcpKey, parseApiKeys, parseIntakeKeys, sha256Hex, viewerFromRequest } from './auth.ts';
import { assistantKeyViewer } from '../../core/src/securite/index.ts';
import { LIMITED_ROLE_ROUTES } from '../../core/src/acces/droits.ts';
import { DEVICE_KEY_ROLES, INVITATION_PATH, handleInvitation, invitedKeys, mergeKeys, retireApplicationKey, retireApplicationKeysOf } from './acces.ts';
import { localTime as parisLocalTime } from '../../core/src/envoi/horaires.ts';
import { ASSISTANT_PATH, handleAssistant, type AssistantLimits } from './assistant.ts';
import type { ReplyWriter, ReportWriter } from '@aimmo/core';
import { META_PATH, handleMeta, type MetaConfig } from './meta.ts';
import { handleAgentApp } from './agent-app.ts';
import { ESTIMATION_PATH, handleEstimation, type EstimationLimits } from './estimation.ts';
import { BOOKING_PATH, BOOKING_SLOTS_PATH, handleBooking, type BookingLimits } from './rendezvous.ts';
import type { DetailedSales, Geocoder } from '@aimmo/core';
import { m08Routes } from './acquereurs.ts';
import { annonceRoutes, type AnnonceOptions } from './annonces.ts';
import { offreRoutes } from './offres.ts';
import { dossierRoutes, type DossierRoute, type PieceStore } from './dossiers.ts';
import { pilotageRoutes } from './pilotage.ts';
import { repriseRoutes } from './reprise.ts';
import { APRES_VENTE_PATH, apresVentePublicError, apresVenteRoutes, handleApresVentePublic } from './apres-vente.ts';
import { handleVitrine, type MediaStore } from './vitrine.ts';
import { handleSortiePublic, reseauRoutes, type ReseauOptions } from './reseau.ts';
import { locationRoutes, type LocationRoute, type LocationServices } from './location.ts';
import { coproprieteRoutes, type CoproprieteRoute, type CoproprieteServices } from './copropriete.ts';
import { avantContratRoutes, type AvantContratRoute, type AvantContratServices } from './avant-contrat.ts';
import { commercesRoutes, dossierReaderRoutes, type CommercesRoute, type CommercesServices } from './commerces.ts';
import { GpuUrbanism, annonces as m07, conformite } from '@aimmo/core';
import { CANDIDATURE_PATH, handleCandidature } from './candidature.ts';
import { accessCut, conformiteRoutes, type ConformiteRoute, type VaultFiles } from './conformite.ts';
import { securiteRoutes, type RegistreGelsSource, type SecuriteRoute } from './securite.ts';
import { reseauUtileRoutes, type ReseauUtileRoute } from './reseau-utile.ts';
import { trousseauxRoutes, type TrousseauxRoute } from './trousseaux.ts';
import { boutiqueRoutes, type BoutiqueRoute } from './boutique.ts';
import { panneauxRoutes, type PanneauxRoute } from './panneaux.ts';
import { veilleDpeRoutes, type VeilleDpeRoute } from './veille-dpe.ts';
import { questionnaireRoutes, type QuestionnaireRoute } from './mandat-questionnaire.ts';
import { scoreAdresseRoutes, type ScoreAdresseRoute } from './score-adresse.ts';
import { tourneeRoutes, type TourneeRoute } from './tournee.ts';
import { rechercheRoutes, type RechercheRoute } from './recherche.ts';
import { statistiquesSiteRoutes, type StatistiquesSiteRoute } from './statistiques-site.ts';
import { pigeRoutes, type PigeRoute } from './pige.ts';
import type { PigeProviderSettings, PigeSource } from '../../core/src/pige/index.ts';
import { adressePigeRoutes, type AdressePigeRoute } from './adresse-pige.ts';
import { sequencesOf, sequencesRoutes, type SequencesRoute } from './sequences.ts';
import { AdemeDiagnosisSearch, type AdressePigeServices } from '../../core/src/adresse-pige/index.ts';
import type { ScoreServices } from '../../core/src/score-adresse/index.ts';
import { phasesRoutes, type PhasesRoute } from './phases.ts';
import { datesRoutes, scenariosRoutes, type ScenariosRoute } from './scenarios.ts';
import { regionsRoutes, type RegionsRoute } from './regions.ts';
import { neufViagerRoutes, type NeufViagerRoute } from './neuf-viager.ts';
import { postgresqlRoutes, type PostgresqlRoute } from './postgresql.ts';
import { handleLicencesPublic, licencesRoutes, type LicencesRoute } from './licences.ts';
import type { StockageFichiersPlages } from '../../core/src/licences/index.ts';
import { recrutementRoutes, type RecrutementRoute } from './recrutement.ts';
import { marketingRoutes, type MarketingRoute } from './marketing.ts';
import { financesRoutes, type FinancesRoute } from './finances.ts';
import { handleMcpPublic, mcpRoutes, MCP_PUBLIC_PREFIX, type McpPublicLimits, type McpRoute } from './mcp.ts';
import { formationRoutes, handleAttestationPublic, type FormationRoute } from './formation.ts';
import { clesRoutes, handleConnexion, markDeviceSession, sessionViewer, type ClesConfig, type ClesRoute, type ConnexionLimits } from './cles.ts';
import type { LecteurFactures } from '../../core/src/facturation/index.ts';
import {
  handleEspacePartenaire,
  handlePartenairesPublic,
  partenairesPublicError,
  partenairesRoutes,
  partnerOptOutBase,
  PARTENAIRES_OPPOSITION_PATH,
  type PartenairesRoute,
  type PartnerFileStore,
  type PartnerUploadStore,
} from './partenaires.ts';
import type { FeeSettings } from '../../core/src/partenaires/index.ts';
import { Annuaire, MiseEnRelation } from '../../core/src/partenaires/index.ts';
import { investirRoutes, type InvestirRoute, type InvestirServices } from './investir.ts';
import { readCapped, studioRoutes, type StudioRoute, type StudioServices } from './studio.ts';
import { accordsRoutes, type AccordsRoute } from './accords.ts';
import { biensFicheRoutes, type BiensFicheRoute } from './biens-fiche.ts';
import { dicteeRoutes, type DicteeRoute } from './dictee.ts';
import { horsLigneRoutes, type HorsLigneRoute } from './hors-ligne.ts';
import { appelsRoutes, type AppelsRoute } from './appels.ts';
import { notificationsRoutes, type NotificationsRoute } from './notifications.ts';
import { gagnerRoutes, type GagnerRoute, type GagnerServices } from './gagner.ts';
import { CERTIFICATE_PAGE_PATH, certificatePageError, handleCertificatePage } from './certificat-photo.ts';
import { Cles } from '../../core/src/cles/index.ts';
import { ESPACE_PATH, espacesRoutes, handleEspacePublic, type EspacesRoute, type EspacesServices } from './espaces.ts';
import { investirCore } from './investir.ts';
import { EstimationEnLigne, Visites, dossiers as m10core, offres as m09core } from '@aimmo/core';
import { GestesModules, SqlClientParties, SqlSourcesAcquereur, SqlSourcesProprietaire, SqlSourcesVendeur, checkSpaceBase, type ReleveKey } from '../../core/src/espaces/index.ts';
import { PUBLIC_PATHS as ATTIRER_PUBLIC_PATHS, attirerRoutes, handleAttirerPublic, type AttirerRoute, type AttirerServices } from './attirer.ts';

/** Préfixe de version : une API versionnée unique (cahier, Architecture technique). */
export const API_PREFIX = '/v1';

/**
 * Seul mode admis tant qu'aucune tâche du plan n'a mis d'envoi réel en service : l'API décide, elle n'envoie rien.
 */
export const TRIAL_MODE = 'essai';

export interface ApiConfig {
  db: SqlDatabase;
  /** AU067 · les canaux et les connecteurs réels des portails (H10) ; absents, chacun est en essai. */
  listing?: AnnonceOptions;
  /** Secret `API_KEYS` : empreintes des clés et identité de chacune (voir auth.ts). */
  apiKeys: string | undefined;
  /** Variable `MODE` : doit valoir « essai ». */
  mode: string | undefined;
  /** Secret `INTAKE_KEYS` : clés qui ne peuvent que déposer un formulaire du site (voir auth.ts). */
  intakeKeys?: string | undefined;
  /** Le passage des automatisations du site à 10 % : fermé tant que B04 ne l'a pas ouvert [R26]. Le Worker ne le branche pas encore. */
  automationRolloutOpen?: boolean;
  /**
   * Le passage des canaux de captation (C09e) : ouvert ou non, et les canaux vraiment branchés. Absent : fermé, aucun
   * canal. Rien ne le remplit tant que C09 ne branche pas de vrai canal, et il devra dire les mêmes canaux que `realChannels`.
   */
  captationRollout?: { open: boolean; connected: readonly OutboundChannelName[] };
  /** Notifications de Meta (C07) : secrets et variables `META_*`, voir meta.ts. */
  meta?: Omit<MetaConfig, 'db' | 'now'>;
  /** AU032 : les réglages de la réception des mails (`MAIL_*`), dont l'état se lit sur `/captation/mail`. */
  mail?: Omit<MailIntakeSettings, 'mode'>;
  /** Limites d'appels de l'assistant du site (C08) ; absentes : les réglages par défaut. */
  assistantLimits?: AssistantLimits;
  /** L'IA qui rédige les réponses de l'assistant du site, une fois branchée (H13). */
  writer?: ReplyWriter;
  /**
   * L'IA qui rédige le compte rendu d'une visite d'après la dictée de l'agent, une fois branchée (H13) : la même pour
   * l'écran de la visite (M08) et pour la dictée en sortant de la visite (BR103). Absente : aucun compte rendu proposé.
   */
  reportWriter?: ReportWriter;
  /** Estimation en ligne du site (E05) : Base adresse nationale et ventes DVF ; absents, le service est fermé. */
  estimation?: { geocoder: Geocoder; sales: DetailedSales };
  /** AU073 : la Base adresse nationale pour les secteurs des recherches et la position des biens, sans lien avec DVF. */
  secteursGeocoder?: Geocoder;
  /** Les données publiques d'un bien (E09), en lecture seule ; absentes, aucun avis ne se prépare. */
  fetchPublicData?: Fetcher;
  /** Les sources du score par adresse (BR27) ; absentes, celles de `estimation` et de `fetchPublicData`, sinon aucune. */
  scoreSources?: ScoreServices | null;
  /** La source des annonces de particuliers de la pige (BR29) ; absente, aucune relève, rien n'est rangé. */
  pigeSource?: PigeSource | null;
  /** AU034 : les réglages du vrai fournisseur de la pige, pour l'état de la relève ; avec eux, seul son réseau relève. */
  pigeProvider?: PigeProviderSettings | null;
  /** La base de l'ADEME et le cadastre de l'adresse de pige (BR30) ; absents, ceux de `fetchPublicData`, sinon seuls les diagnostics de la veille. */
  adressePigeSources?: AdressePigeServices;
  estimationLimits?: EstimationLimits;
  /** Réservation des rendez-vous (V08) : limites d'appels, et début du lien pour décaler ou annuler (`RDV_LINK_BASE`). */
  bookingLimits?: BookingLimits;
  appointmentLinkBase?: string | undefined;
  /** Début du lien de désinscription des alertes (`ALERT_UNSUBSCRIBE_BASE`) : sans lui, aucune alerte WhatsApp de l'agent [R49]. */
  alertUnsubscribeBase?: string | undefined;
  /** Les médias des biens (R2, `MEDIA`) ; absent, aucune photo n'est servie. */
  media?: MediaStore;
  /** Les pièces des dossiers de vente (R2, `PIECES`) ; absent, les routes de M10 sont fermées. */
  pieces?: PieceStore;
  /** M14 (J13) : le stockage des pièces des dossiers d'agent, l'IA de l'entraînement, le bac à sable ; absents, fermés. */
  reseau?: ReseauOptions;
  /** M15 (W10) : les IA de l'annonce et de l'état des lieux ; absentes, les secours sans IA [R103, R106]. */
  location?: Pick<LocationServices, 'adWriter' | 'inventoryFormatter'>;
  /**
   * M16 (CE10) : les documents du dossier protégé (stockage réel après H38 ; absent, seule la fiche est servie), l'IA de
   * la présentation (absente, le secours sans IA [R12]) et le début des liens du dossier (`DOSSIER_LINK_BASE`).
   */
  commerces?: Partial<Pick<CommercesServices, 'storage' | 'presentationWriter' | 'baseUrl'>>;
  /** Variable `CANDIDATURE_NETWORK_ID` : le réseau qui reçoit les candidatures de `/rejoindre` ; absente, le seul réseau de la base s'il n'y en a qu'un (AU022), sinon page « bientôt ». */
  candidatureNetworkId?: string | undefined;
  /** M12 (L09) : le stockage du coffre de la conformité (R2, `COFFRE`) ; absent, le dépôt et l'ouverture d'une pièce sont fermés. */
  coffre?: VaultFiles | null;
  /** BR82 : les fichiers déposés de l'agence sous licence (R2 : `MEDIA`, `PIECES`, `COMMERCES`, jamais `COFFRE`) ; absents, leurs routes sont fermées. */
  fichiersReprise?: StockageFichiersPlages | null;
  /** M18 (U09) : le stockage des preuves et des pièces des partenaires (R2, `PIECES`, sous `partenaires/`) ; absent, les routes de M18 sont fermées. */
  partenaires?: PartenairesOptions;
  /** M17 (Y08) : l'IA de la note d'investissement (absente, le secours sans IA [R126]) et le barème des frais réglé par la direction. */
  investir?: Pick<InvestirServices, 'noteWriter' | 'feesRateBp'>;
  /**
   * M19 (X10) : le stockage des photos, originaux, preuves et accords (R2, `MEDIA`), dont seule l'existence d'une
   * référence est lue ; absent, les routes de M19 sont fermées. L'IA du corps des publications ; absente, le secours.
   * Aucun réseau réel n'est accepté ici : les publications partent vers les canaux du mode essai seulement [R26, R134].
   */
  studio?: StudioOptions;
  /**
   * M20 complet (G12) : le stockage des preuves de coût (sans lui, aucun coût ne se saisit [R144]), le géocodeur des
   * adresses des lettres (sans lui, aucune campagne ne vérifie son rayon [R140]) et les IA de rédaction (absentes, les
   * textes du code). Les relances passent par le contrôle central, en mode essai seulement [R26].
   */
  gagner?: Pick<GagnerServices, 'proofs' | 'uploads' | 'geocoder' | 'drafter' | 'letterDrafter' | 'dossierDrafter'>;
  /**
   * M01 (AT11) : les IA des réponses aux avis et des pages de quartier (absentes, les textes de secours contrôlés). Les
   * ventes DVF du recalcul des prix sont celles de l'estimation en ligne ; IndexNow et la fiche Google réelle ne sont
   * jamais passés d'ici : rien ne part, aucune page n'est indexée en mode essai [R26].
   */
  attirer?: Pick<AttirerServices, 'gbpWriter' | 'neighbourhoodWriter'>;
  /**
   * La copropriété et l'urbanisme résumés (RC52, BR87) : la Base adresse nationale, le Géoportail de l'urbanisme et le
   * lecteur IA de la prélecture. Absents, le géocodeur de l'estimation et le Géoportail lu par `fetchPublicData` ; sans
   * eux, la zone est « non collectée » ; sans lecteur (H13), tout est à lire [R12]. Rien n'est jamais reçu de l'écran [R449].
   */
  copropriete?: Pick<CoproprieteServices, 'geocoder' | 'urbanism' | 'reader'>;
  /**
   * L'avant-contrat et la prélecture du projet du notaire (HX45, RC54, BR89) : le lecteur IA de la prélecture. Absent
   * (H13), rien n'est proposé et tout est à lire [R12]. Les pièces sont celles de M10 (`pieces`).
   */
  avantContrat?: Pick<AvantContratServices, 'reader'>;
  /** Le téléchargement du fichier public du registre des gels (BR85) ; absent, seul le dépôt du fichier est ouvert. */
  registreGels?: RegistreGelsSource | null;
  /** Le lecteur des factures fournisseurs (l'IA, H13, BR04) ; absent, leur lecture est fermée. */
  lecteurFactures?: LecteurFactures | null;
  /** Le site WebAuthn des clés d'appareil (BR05, `CLES_RP_ID` et `CLES_ORIGINS`) ; absent, leurs routes sont fermées. */
  cles?: ClesConfig | null;
  /** Les limites d'appels de la connexion par une clé (BR06) ; absentes, les réglages par défaut. */
  clesLimits?: ConnexionLimits;
  /** Les limites de la lecture publique du serveur MCP (BR08) ; absentes, les réglages par défaut. */
  mcpPublicLimits?: McpPublicLimits;
  /**
   * Les espaces des clients (EC07) : le réseau de la page publique (`ESPACE_NETWORK_ID`), l'adresse de l'espace
   * (`ESPACE_BASE`, en https, sans chiffre, terminée par `/espace/`) et les clés du relevé prouvé (secret
   * `ESPACE_RELEVE_KEYS`). Sans réseau ni adresse, l'espace est fermé ; sans clé valable, le relevé est indisponible
   * et l'espace reste lisible [R164]. Le lien part par le contrôle central, en mode essai seulement [R26].
   */
  espaces?: EspacesOptions;
  /**
   * Le réseau qui exploite la plateforme (`PLATFORM_NETWORK_ID`, BR25) : seule sa direction lit et décide des seuils du
   * passage à PostgreSQL, qui couvrent toute la base ; absent, ces routes refusent tout [R16].
   */
  platformNetworkId?: string | undefined;
  now?: () => Date;
}

export interface EspacesOptions {
  networkId?: string | undefined;
  baseUrl?: string | undefined;
  releveKeys?: string | undefined;
}

export interface StudioOptions {
  files: StudioServices['files'] | null;
  writer?: StudioServices['writer'];
  /** X12 : le stockage où les fichiers finis sont rangés tels quels (R2, `MEDIA`) ; absent, le dépôt est fermé. */
  uploads?: StudioServices['uploads'];
}

export interface PartenairesOptions {
  files: (PartnerFileStore & PartnerUploadStore) | null;
  /** Variable `PARTENAIRES_OPPOSITION_BASE` (`https://…/partenaires/opposition/`) : sans elle, aucun mail de prospection [R79]. */
  optOutBase?: string | null;
  /** Le statut du courtier et de la banque, validé par l'avocat (H31) ; absent, faux [R76]. */
  fees?: FeeSettings;
}

/**
 * Les seules routes qu'un agent dont le dossier d'agent n'est pas complet et valide ce jour-là peut appeler : sa
 * session, son dossier et ses pièces, sa formation, le bac à sable fictif, l'entraînement, l'assistance, ses primes.
 * Aucune ne lit ni n'écrit un client ou un bien [R82, R16]. Toute autre route est refusée avant d'être lue.
 */
export const OPEN_WITHOUT_AGENT_FILE: ReadonlySet<string> = new Set([
  'moi',
  'reseau.mon_dossier',
  'reseau.dossier',
  'reseau.piece',
  'reseau.academie',
  'reseau.module_fait',
  'reseau.ma_formation',
  'reseau.formation',
  'reseau.bac_a_sable',
  'reseau.mon_bac_a_sable',
  'reseau.mon_bac_a_sable_ouvrir',
  'reseau.mon_bac_a_sable_etape',
  'reseau.mon_referent',
  'reseau.entrainement_cas',
  'reseau.entrainement',
  'reseau.entrainement_tour',
  'reseau.entrainement_fin',
  'reseau.assistance',
  'reseau.mes_primes',
  'reseau.primes',
  // Ses clés d'appareil et l'export de ses propres données (BR05) : aucune fiche client n'y est lue. Retirer une clé
  // d'un geste reste possible [R600], et l'export se tire à tout moment, clients par identifiant seulement [R561].
  'cles.enregistrement.debut',
  'cles.enregistrement.fin',
  'cles.appareils.retrait',
  'cles.preuve.debut',
  'cles.preuve.fin',
  'export.agent',
  'export.agent.verification',
  // Le quiz de sa formation et ses attestations (BR07) : aucune fiche client n'y est lue [R570, R571].
  'formation.quiz',
  'formation.reponses',
  'formation.attestations',
]);

const MAX_BODY_BYTES = 10_000;
/** Un modèle de mandat tient sur plusieurs pages. */
const TEMPLATE_BODY_BYTES = 120_000;

const modeles = (s: Services): Modeles => new Modeles(s.db, s.acces, s.journal, { now: s.now });
const controles = (s: Services): ControlesSignature => new ControlesSignature(s.db, s.acces, s.journal, { now: s.now });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const failure = (status: number, code: string, message: string): Response =>
  json(status, { ok: false, code, message });

const refusal = (result: { rule: 'R16'; code: string }): Response =>
  json(result.code === 'unknown' ? 404 : 403, { ok: false, rule: result.rule, code: result.code });

const answer = <T>(result: AccessResult<T>): Response =>
  result.ok ? json(200, { ok: true, mode: TRIAL_MODE, view: result.view, data: result.value }) : refusal(result);

interface Services {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  decision: DecisionEnvoi;
  rappels: Rappels;
  qualification: Qualification;
  now: () => Date;
}

function services(db: SqlDatabase, now: () => Date): Services {
  const fiches = new FicheClient(db, { now });
  const unique = new FicheUnique(db, fiches, { now });
  const journal = new SqlJournalStore(db);
  return {
    db,
    journal,
    acces: new Acces(db, fiches, unique, journal, { now }),
    decision: new DecisionEnvoi(db, fiches, unique, { now }),
    rappels: new Rappels(db, unique, journal, { now }),
    qualification: new Qualification(db, fiches, unique, new Reception(db, undefined, now), new ReconnaissanceBien(db), journal, { now }),
    now,
  };
}

type Route = (s: Services, viewer: Viewer, params: string[], request: Request) => Promise<Response>;

interface RouteDef {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: Route;
}

const ID = '([A-Za-z0-9_-]{1,64})';

const ROUTES: RouteDef[] = [
  {
    method: 'GET',
    pattern: /^\/moi$/,
    name: 'moi',
    // Qui porte la clé : le rôle, et le prénom pour un agent en activité ; rien d'autre [R16].
    handle: async (s, viewer) => {
      if (viewer.role !== 'agent') return json(200, { ok: true, mode: TRIAL_MODE, data: { role: viewer.role, firstName: null } });
      const agent = await s.db.first<{ first_name: string; status: string; network_id: string }>('SELECT first_name, status, network_id FROM agents WHERE id = ?', [viewer.userId]);
      if (!agent || agent.status !== 'active' || agent.network_id !== viewer.networkId) {
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `agent:${viewer.userId}`, subject: null, data: { rule: 'R16', role: 'agent', kind: 'session', code: 'agent_inactive' } }, s.now);
        return refusal({ rule: 'R16', code: 'agent_inactive' });
      }
      return json(200, { ok: true, mode: TRIAL_MODE, data: { role: 'agent', firstName: agent.first_name } });
    },
  },
  {
    method: 'GET',
    pattern: /^\/fiches$/,
    name: 'fiches',
    handle: async (s, viewer) => answer(await s.acces.listPersons(viewer)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/fiches/${ID}$`),
    name: 'fiche',
    handle: async (s, viewer, [id]) => answer(await s.acces.readFiche(viewer, id!)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/fiches/${ID}/resume$`),
    name: 'fiche.resume',
    // La fiche pour l'application de l'agent : projets, origines, accords, derniers messages, rappels, numéro à
    // appeler ; refusée hors des droits [R16] ; sans numéro pour une personne exclue ou arrêtée [R02, R04].
    handle: async (s, viewer, [id]) => {
      const fiche = await new FicheAgent(s.db, s.acces, { now: s.now }).read(viewer, id!);
      return fiche.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: fiche.value }) : refusal({ rule: fiche.rule, code: fiche.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/rappels/${ID}/fait$`),
    name: 'rappel.fait',
    // « Rappel fait » : la tâche garde sa ligne [R17] ; seul celui qui voit la fiche en entier la marque [R16].
    // Une tâche inconnue est refusée comme une tâche d'un autre : rien n'est dit de son existence.
    handle: async (s, viewer, [id]) =>
      (await s.rappels.done(s.acces, viewer, id!)) ? json(200, { ok: true, mode: TRIAL_MODE, sent: false }) : json(403, { ok: false, rule: 'R16', code: 'not_assigned' }),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/fiches/${ID}/journal$`),
    name: 'fiche.journal',
    handle: async (s, viewer, [id]) => answer(await s.acces.readJournalOf(viewer, id!)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/biens/${ID}$`),
    name: 'bien',
    handle: async (s, viewer, [id]) => answer(await s.acces.readProperty(viewer, id!)),
  },
  {
    method: 'POST',
    pattern: /^\/envois\/decision$/,
    name: 'envois.decision',
    handle: sendDecision,
  },
  {
    method: 'GET',
    pattern: /^\/qualifications\/cas-corriges$/,
    name: 'qualification.cas_corriges',
    // Les corrections au format du banc de mesure, sans coordonnées : la direction seule [R16, R15].
    handle: async (s, viewer) => {
      const cases = await s.qualification.correctedMeasureCases(viewer);
      if (!cases.ok) return refusal({ rule: cases.rule, code: cases.code });
      return new Response(measureCasesCsv(cases.value), { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="cas-corriges.csv"', 'cache-control': 'no-store' } });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/qualifications/${ID}/correction$`),
    name: 'qualification.correction',
    handle: correctQualification,
  },
  {
    method: 'GET',
    pattern: /^\/contacts-chauds$/,
    name: 'contacts.chauds',
    // Les contacts chauds à rappeler : un agent ne voit que les siens [R16], jamais une personne exclue [R25].
    handle: async (s, viewer) => {
      const list = await s.rappels.hotList(s.acces, viewer);
      return list.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: list.value }) : refusal({ rule: list.rule, code: list.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/alertes-agent$/,
    name: 'alertes_agent',
    // Conversations à reprendre et réponses tombées (C09c) : l'agent, seulement sur les fiches qu'il voit maintenant [R12, R16].
    handle: async (s, viewer) => {
      const list = await new AlertesAgent(s.db, s.journal, { now: s.now }).list(viewer);
      return list.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: list.value }) : refusal({ rule: list.rule, code: list.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/alertes-agent\/sans-agent$/,
    name: 'alertes_agent.sans_agent',
    // Le nombre d'alertes qu'aucun agent ne voit, pour que la direction attribue les fiches (C09d) [R12, R13, R16].
    handle: async (s, viewer) => {
      const count = await new AlertesAgent(s.db, s.journal, { now: s.now }).unseenByAnyAgent(viewer);
      return count.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: count.value }) : refusal({ rule: count.rule, code: count.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/alertes-agent/${ID}/vue$`),
    name: 'alerte_agent.vue',
    // Marquer vue ne supprime rien [R17] ; une alerte inconnue est refusée comme celle d'un autre [R16].
    handle: async (s, viewer, [id], request) => {
      // La date lue : une alerte rouverte depuis n'est pas refermée [R12]. Un petit corps, jamais gardé.
      const text = await request.text();
      let createdAt: unknown = null;
      try {
        createdAt = text.length <= 256 ? (JSON.parse(text) as { createdAt?: unknown } | null)?.createdAt : null;
      } catch {
        createdAt = null;
      }
      if (typeof createdAt !== 'string') return failure(400, 'bad_request', 'Date de l’alerte manquante.');
      const seen = await new AlertesAgent(s.db, s.journal, { now: s.now }).markSeen(viewer, id!, createdAt);
      return seen.ok ? json(200, { ok: true, mode: TRIAL_MODE, sent: false, data: seen.value }) : refusal({ rule: seen.rule, code: seen.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/plan-du-jour$/,
    name: 'plan_du_jour',
    // Le plan du jour figé à 7 h 30 : l'agent seul lit le sien [R16] ; `null` tant qu'il n'est pas encore figé. Les étapes
    // des séquences s'y ajoutent à la lecture (BR32), sans liste d'opposition tant que Bloctel n'est pas branché (H61) :
    // un appel qui ne repose que sur la prospection n'y est donc jamais proposé [R302].
    handle: async (s, viewer) => {
      const sequences = { today: (v: Viewer) => sequencesOf(s.db, s.journal, s.acces, s.now, null).today(v) };
      const plan = await new PlansDuJour(s.db, s.journal, { now: s.now, sequences }).read(viewer);
      return plan.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: plan.value }) : refusal({ rule: plan.rule, code: plan.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/rendez-vous\/jour$/,
    name: 'rendez_vous.jour',
    // Les rendez-vous du jour de l'agent, heure de Paris, avec leur brief rangé : l'agent seul lit les siens [R16].
    handle: async (s, viewer) => {
      const day = await new JourneeRendezVous(s.db, s.journal, { now: s.now }).read(viewer);
      return day.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: day.value }) : refusal({ rule: day.rule, code: day.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/usage\/matin$/,
    name: 'usage.matin',
    // L'usage du matin sur 7 jours : l'agent voit ses jours ; la direction, des nombres du réseau, sans classement [R14].
    handle: async (s, viewer) => {
      const usage = await new UsageMatin(s.db, s.journal, { now: s.now }).read(viewer);
      return usage.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: usage.value }) : refusal({ rule: usage.rule, code: usage.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/plan-du-jour\/controle$/,
    name: 'plan_du_jour.controle',
    // Les écarts du contrôle de la base légale sur 30 jours : des nombres seulement ; direction et conformité [R16].
    handle: async (s, viewer) => {
      const alerts = await new ControleBaseLegale(s.db, s.journal, { now: s.now }).alerts(viewer);
      return alerts.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: alerts.value }) : refusal({ rule: alerts.rule, code: alerts.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/automatisations\/paliers$/,
    name: 'automatisations.paliers',
    // Le palier de chaque automatisation du site : des nombres et des dates ; direction et conformité [R16, R26].
    handle: async (s, viewer) => {
      const r = await new PaliersBascule(s.db, s.journal, { now: s.now }).list(viewer, AUTOMATION_NAMES);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : refusal({ rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/registre\/reglage$/,
    name: 'registre.reglage.lire',
    // Le format en vigueur et le prochain numéro, pour l'écran de la direction (D13) [R39].
    handle: async (s, viewer) => {
      const r = await new RegistreMandats(s.db, s.journal, { now: s.now }).readSettings(viewer);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : refusal({ rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/registre\/lignes$/,
    name: 'registre.lignes',
    // Les mandats inscrits, les plus récents d'abord, pour annuler sans saisir d'identifiant (D13) ; la direction seule [R16].
    handle: async (s, viewer, _params, request) => {
      const before = new URL(request.url).searchParams.get('avant');
      if (before !== null && !/^[1-9]\d{0,9}$/.test(before)) return failure(400, 'bad_cursor', 'avant : un rang du registre.');
      const r = await new RegistreMandats(s.db, s.journal, { now: s.now }).entries(viewer, before === null ? null : Number(before));
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: { entries: r.entries, next: r.next } }) : refusal({ rule: r.rule, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: /^\/registre\/reglage$/,
    name: 'registre.reglage',
    // Le format du registre des mandats : la direction seule, une fois, avant la première inscription [R39].
    handle: async (s, viewer, _params, request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['prefix', 'firstNumber', 'width'].includes(k))) return failure(400, 'unexpected_field', 'Seuls prefix, firstNumber, width sont admis.');
      const r = await new RegistreMandats(s.db, s.journal, { now: s.now }).configure(viewer, { prefix: body.prefix as string, firstNumber: body.firstNumber as number, width: body.width as number });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE });
      return r.rule === 'R16' ? refusal({ rule: 'R16', code: r.code }) : json(r.code === 'already_configured' ? 409 : 400, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/registre\/controle$/,
    name: 'registre.controle',
    // Le contrôle d'intégrité du registre : rangs, empreintes, liens, numéros, mandats figés [R39] ; direction, conformité.
    handle: async (s, viewer) => {
      const r = await new RegistreMandats(s.db, s.journal, { now: s.now }).verify(viewer);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : refusal({ rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/mandats/${ID}/registre$`),
    name: 'mandat.registre',
    // Les lignes du registre d'un mandat : son agent, la direction, la conformité [R16].
    handle: async (s, viewer, [id]) => {
      const r = await new RegistreMandats(s.db, s.journal, { now: s.now }).linesOf(viewer, id!);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.lines }) : refusal({ rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/modeles$/,
    name: 'modeles',
    // Les modèles du réseau, toutes versions, avec leur état « essai » ou « validé » [R40].
    handle: async (s, viewer) => {
      const r = await modeles(s).list(viewer);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.templates }) : refusal(r);
    },
  },
  {
    method: 'POST',
    pattern: /^\/modeles$/,
    name: 'modeles.version',
    // Une nouvelle version d'un modèle, à l'état « essai » : la direction seule [R40].
    handle: async (s, viewer, _params, request) => {
      const body = await readJson(request, TEMPLATE_BODY_BYTES);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['kind', 'body'].includes(k))) return failure(400, 'unexpected_field', 'Seuls kind et body sont admis.');
      const r = await modeles(s).createVersion(viewer, body.kind as never, body.body as string);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.template });
      return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/modeles/${ID}/validation$`),
    name: 'modeles.validation',
    // Le modèle passe « validé » : la conformité seule, jamais le code (H08).
    handle: async (s, viewer, [id]) => {
      const r = await modeles(s).validate(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.template });
      return r.rule === 'R16' ? refusal(r) : json(r.code === 'unknown_template' ? 404 : 409, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: /^\/documents$/,
    name: 'documents.generation',
    // Un document généré depuis la dernière version du modèle, pour une fiche et un bien vus en entier [R16, R40].
    handle: async (s, viewer, _params, request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['kind', 'personId', 'propertyId', 'inputs', 'mandateId', 'coMandantIds', 'proxies', 'rights'].includes(k))) return failure(400, 'unexpected_field', 'Seuls kind, personId, propertyId, inputs, mandateId, coMandantIds, proxies, rights sont admis.');
      const { kind, personId, propertyId, inputs, mandateId, coMandantIds, proxies, rights } = body;
      // AU060 : les droits des mandants, contrôlés par la couche métier ; ici, seulement une liste courte d'objets.
      if (rights !== undefined && (!Array.isArray(rights) || rights.length > MAX_CO_MANDANTS + 1 || rights.some((r) => r === null || typeof r !== 'object' || Array.isArray(r)))) return failure(400, 'invalid_rights', 'rights : une liste de droits.');
      // AU059 : les procurations, chacune contrôlée par la couche métier ; ici, seulement une liste courte d'objets.
      if (proxies !== undefined && (!Array.isArray(proxies) || proxies.length > MAX_CO_MANDANTS + 1 || proxies.some((p) => p === null || typeof p !== 'object' || Array.isArray(p)))) return failure(400, 'invalid_proxies', 'proxies : une liste de procurations.');
      // Les autres mandants (couple, indivision) : une liste d'identifiants de fiches (AU001).
      if (coMandantIds !== undefined && (!Array.isArray(coMandantIds) || coMandantIds.length > MAX_CO_MANDANTS || coMandantIds.some((c) => typeof c !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(c)))) return failure(400, 'invalid_ids', 'coMandantIds : une liste d’identifiants.');
      if (mandateId !== undefined && (typeof mandateId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(mandateId))) return failure(400, 'invalid_ids', 'mandateId mal formé.');
      if (typeof personId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(personId) || typeof propertyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(propertyId)) {
        return failure(400, 'invalid_ids', 'personId et propertyId attendus.');
      }
      if (inputs !== undefined && (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs))) return failure(400, 'invalid_inputs', 'inputs : un objet.');
      const r = await modeles(s).generate(viewer, { kind: kind as never, personId, propertyId, ...(inputs ? { inputs: inputs as never } : {}), ...(mandateId ? { mandateId } : {}), ...(coMandantIds !== undefined ? { coMandantIds: coMandantIds as string[] } : {}), ...(proxies !== undefined ? { proxies: proxies as never } : {}), ...(rights !== undefined ? { rights: rights as never } : {}) });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.document });
      return r.rule === 'R16' ? refusal(r) : json(r.code === 'no_template' ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/biens/${ID}/designation$`),
    name: 'bien.designation',
    // L'adresse et les parcelles du bien, reprises par chaque mandat de vente (AU002) : son agent ou la direction [R16, R40].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['address', 'parcels'].includes(k))) return failure(400, 'unexpected_field', 'Seuls address et parcels sont admis.');
      const r = await new Designations(s.db, s.acces, s.journal, { now: s.now }).setProperty(viewer, id!, { address: body.address, parcels: body.parcels });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/fiches/${ID}/domicile$`),
    name: 'fiche.domicile',
    // Le domicile du mandant, repris par chaque mandat qu'il signe (AU002) : qui voit sa fiche en entier [R16, R40].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      const r = await new Designations(s.db, s.acces, s.journal, { now: s.now }).setDomicile(viewer, id!, body);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/documents/${ID}$`),
    name: 'document',
    // Un document : celui qui voit la fiche en entier [R16].
    handle: async (s, viewer, [id]) => {
      const r = await modeles(s).read(viewer, id!);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.document }) : refusal(r);
    },
  },
  {
    method: 'GET',
    pattern: /^\/honoraires\/bareme$/,
    name: 'honoraires.bareme.lire',
    // Le barème en vigueur, pour l'écran de la direction (D13) [R41].
    handle: async (s, viewer) => {
      const r = await controles(s).readFeeSchedule(viewer);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : refusal(r);
    },
  },
  {
    method: 'POST',
    pattern: /^\/honoraires\/bareme$/,
    name: 'honoraires.bareme',
    // Le barème des honoraires du réseau : taux maximal du prix et minimum ; la direction seule, en ajout seul [R41].
    handle: async (s, viewer, _params, request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['maxRatePercent', 'minEur', 'tiers'].includes(k))) return failure(400, 'unexpected_field', 'Seuls maxRatePercent, minEur et tiers sont admis.');
      // AU058 · les tranches, chacune un plafond en taux ou en forfait, contrôlées par le socle.
      const r = await controles(s).setFeeSchedule(viewer, { maxRatePercent: body.maxRatePercent as number, minEur: body.minEur as number, tiers: body.tiers });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE });
      return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/fiches/${ID}/identite$`),
    name: 'fiche.identite',
    // L'identité vérifiée : la nature de la pièce vue et quand ; jamais son numéro ni sa copie [R15, R41].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['piece', 'seenAt'].includes(k))) return failure(400, 'unexpected_field', 'Seuls piece et seenAt sont admis.');
      if (typeof body.seenAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.seenAt)) return failure(400, 'invalid_date', 'seenAt : un instant ISO en UTC.');
      const r = await controles(s).recordIdentity(viewer, id!, { piece: String(body.piece), seenAt: new Date(body.seenAt) });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: { id: r.id } });
      return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/documents/${ID}/exemplaire$`),
    name: 'document.exemplaire',
    // L'exemplaire du mandant, avec son numéro au registre [R39] : qui voit la fiche en entier [R16].
    handle: async (s, viewer, [id]) => {
      const r = await new SignaturePapier(s.db, s.acces, s.journal, { now: s.now }).copy(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: { number: r.number, content: r.content } });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/biens/${ID}/diffusion$`),
    name: 'bien.diffusion',
    // Le bien peut-il être diffusé : mandat signé, numéroté, en cours, hors délai de rétractation [R42].
    handle: async (s, viewer, [id]) => {
      const r = await new Diffusion(s.db, s.acces, s.journal, { now: s.now }).read(viewer, id!);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : refusal(r);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/mandats/${ID}/debut-anticipe$`),
    name: 'mandat.debut_anticipe',
    // La demande écrite du vendeur de diffuser avant la fin du délai de rétractation, avec sa preuve [R42].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['proof', 'receivedAt', 'receivedOn'].includes(k))) return failure(400, 'unexpected_field', 'Seuls proof, receivedAt et receivedOn sont admis.');
      if (body.receivedOn === undefined && (typeof body.receivedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.receivedAt))) return failure(400, 'invalid_date', 'receivedAt : un instant ISO en UTC.');
      const r = await new Diffusion(s.db, s.acces, s.journal, { now: s.now }).recordEarlyStart(viewer, id!, { proof: body.proof as string, ...(body.receivedOn !== undefined ? { receivedOn: body.receivedOn as string } : { receivedAt: new Date(body.receivedAt as string) }) });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE });
      return r.rule === 'R16' ? refusal(r) : json(r.code === 'unknown_mandate' ? 404 : r.code === 'already_recorded' ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/mandats/${ID}/retractation$`),
    name: 'mandat.retractation',
    // La rétractation envoyée dans le délai : le mandat s'arrête, son inscription est annulée ; `resume` finit une rétractation déjà notée [R42].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      const diffusion = new Diffusion(s.db, s.acces, s.journal, { now: s.now });
      if (Object.keys(body).some((k) => !['proof', 'receivedAt', 'sentOn', 'resume'].includes(k))) return failure(400, 'unexpected_field', 'Seuls proof, receivedAt, sentOn et resume sont admis.');
      if (body.resume !== undefined && (body.resume !== true || Object.keys(body).length !== 1)) return failure(400, 'unexpected_field', 'resume vaut true, seul.');
      if (body.resume === undefined && body.sentOn === undefined && (typeof body.receivedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.receivedAt))) return failure(400, 'invalid_date', 'receivedAt : un instant ISO en UTC.');
      const r =
        body.resume === true
          ? await diffusion.resumeWithdrawal(viewer, id!)
          : await diffusion.recordWithdrawal(viewer, id!, { proof: body.proof as string, ...(body.sentOn !== undefined ? { sentOn: body.sentOn as string } : { receivedAt: new Date(body.receivedAt as string) }) });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE });
      return r.rule === 'R16' ? refusal(r) : json(r.code === 'unknown_mandate' ? 404 : r.code === 'already_recorded' ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/mandats\/echeances$/,
    name: 'mandats.echeances',
    // Les tâches d'échéance de l'agent lui-même : fin de mandat, fin de période exclusive [R16].
    handle: async (s, viewer) => {
      const r = await new EcheancesMandats(s.db, s.journal, { now: s.now }).list(viewer);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.tasks }) : refusal(r);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/mandats/${ID}/annulation$`),
    name: 'mandat.annulation',
    // Une ligne d'annulation au registre, qui rouvre le bien (D15) : la direction seule. Une rétractation a sa route, avec sa preuve.
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => k !== 'reason')) return failure(400, 'unexpected_field', 'Seul reason est admis.');
      if (viewer.role !== 'direction') {
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `mandate:${id}`, data: { rule: 'R16', role: String(viewer.role), kind: 'annulation', code: 'role' } }, s.now);
        return refusal({ rule: 'R16', code: 'role' });
      }
      if (body.reason !== 'error' && body.reason !== 'termination') return json(400, { ok: false, rule: null, code: 'bad_reason' });
      const r = await new RegistreMandats(s.db, s.journal, { now: s.now }).cancel(viewer, id!, body.reason);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: { number: r.line.number, seq: r.line.seq } });
      if (r.rule === 'R16') return refusal(r as { rule: 'R16'; code: string });
      return json(r.code === 'already_cancelled' ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/mandats/${ID}/conditions$`),
    name: 'mandat.conditions',
    // Les conditions en vigueur d'un mandat (prix, durée) et l'historique de ses avenants signés [R16].
    handle: async (s, viewer, [id]) => {
      const r = await new SignatureAvenant(s.db, s.acces, s.journal, { now: s.now }).terms(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/avis/${ID}/imprimable$`),
    name: 'avis.imprimable',
    // L'avis validé à imprimer, à la marque de l'agent : qui voit le bien en entier [R16], jamais un brouillon [R30].
    handle: async (s, viewer, [id]) => {
      const r = await new AvisImprime(s.db, s.acces, s.journal, { now: s.now }).print(viewer, id!);
      if (r.ok) return new Response(r.html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' } });
      if (r.rule === null) return json(404, { ok: false, code: r.code });
      return json(403, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/mandats/${ID}/chronologie$`),
    name: 'mandat.chronologie',
    // La chronologie d'un mandat, de l'avis validé au numéro : la mesure du critère de M06 ; direction, conformité.
    handle: async (s, viewer, [id]) => {
      const r = await new ChronologieMandat(s.db, s.journal, { now: s.now }).read(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/documents/${ID}/signature-en-ligne$`),
    name: 'document.signature_en_ligne_etat',
    // Où en est la signature en ligne : chaque mandant, et s'il a signé la version actuelle ; le document n'est signé
    // que quand tous l'ont signé (AU001) [R16, R41].
    handle: async (s, viewer, [id]) => {
      const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).progress(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/signatures/${ID}/exemplaire$`),
    name: 'signature.exemplaire',
    // L'exemplaire d'une signature en ligne d'essai, et s'il est parti au signataire [R16].
    handle: async (s, viewer, [id]) => {
      const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).copy(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: { content: r.content, sent: r.sent } });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/signatures/${ID}/exemplaire$`),
    name: 'signature.exemplaire_envoi',
    // Reprend l'envoi de l'exemplaire refusé plus tôt (heure, exclusion…), par le contrôle central.
    handle: async (s, viewer, [id]) => {
      const sent = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).sendCopy(viewer, id!);
      return json(sent ? 200 : 409, { ok: sent, mode: TRIAL_MODE, sent });
    },
  },
  {
    method: 'GET',
    pattern: /^\/signature-en-ligne\/mode$/,
    name: 'signature.mode',
    // Essai ou réel pour une signature ouverte maintenant, et ce qui manque : le mail réel (H05), la validation de
    // l'avocat (H24). Agent ou direction [R16] (AU003).
    handle: async (s, viewer) => {
      const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).mode(viewer);
      return r.ok ? json(200, { ok: true, mode: r.value.mode, data: r.value }) : refusal(r);
    },
  },
  {
    method: 'POST',
    pattern: /^\/signature-en-ligne\/validation$/,
    name: 'signature.validation',
    // La direction enregistre la validation, par l'avocat du réseau, du format du dossier de preuve (H24) : la référence
    // de son avis écrit et sa date [R16, R17] (AU003).
    handle: async (s, viewer, _params, request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => k !== 'reference' && k !== 'validatedOn')) return failure(400, 'unexpected_field', 'Seuls reference et validatedOn sont admis.');
      if (typeof body.validatedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.validatedOn)) return failure(400, 'invalid_date', 'validatedOn : une date AAAA-MM-JJ.');
      const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).recordValidation(viewer, {
        reference: typeof body.reference === 'string' ? body.reference : '',
        validatedOn: new Date(`${body.validatedOn}T00:00:00.000Z`),
      });
      if (r.ok) return json(201, { ok: true, mode: TRIAL_MODE, data: { id: r.id } });
      return r.rule === 'R16' ? refusal({ rule: 'R16', code: r.code }) : json(400, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/documents/${ID}/dossier-preuve$`),
    name: 'document.dossier_preuve',
    // L'exemplaire remis et le dossier de preuve d'un document signé réellement par tous [R16] (AU003).
    handle: async (s, viewer, [id]) => {
      const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).dossier(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: 'reel', data: r.value });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/attribution\/regles$/,
    name: 'attribution.regles',
    // Les règles d'attribution, publiées, les mêmes pour tous [R25] : rien de personnel.
    handle: async () =>
      json(200, {
        ok: true,
        mode: TRIAL_MODE,
        data: {
          rules: ATTRIBUTION_RULES,
          callbackHours: { hot: DEFAULT_ATTRIBUTION_SETTINGS.hotCallbackHours, other: DEFAULT_ATTRIBUTION_SETTINGS.otherCallbackHours },
          communes: DEFAULT_ATTRIBUTION_SETTINGS.communes,
        },
      }),
  },
  {
    method: 'GET',
    pattern: /^\/journal\/verification$/,
    name: 'journal.verification',
    handle: verifyJournal,
  },
];

async function readJson(request: Request, max = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * La décision d'envoi, en mode essai : elle dit si un message pourrait partir et quelle règle a décidé.
 * Elle n'envoie rien et ne range aucun message. La fiche est lue sous droits d'accès [R16] et la décision
 * est écrite au journal avec sa règle [R13].
 */
async function sendDecision(s: Services, viewer: Viewer, _params: string[], request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { personId, channel, kind, purpose, conversationId, at } = body;
  if (typeof personId !== 'string' || !new RegExp(`^${ID}$`).test(personId)) {
    return failure(400, 'invalid_person', 'personId manquant ou mal formé.');
  }
  if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) {
    return failure(400, 'invalid_channel', `channel attendu parmi : ${CHANNELS.join(', ')}.`);
  }
  if (typeof kind !== 'string' || !(SEND_KINDS as readonly string[]).includes(kind)) {
    return failure(400, 'invalid_kind', `kind attendu parmi : ${SEND_KINDS.join(', ')}.`);
  }
  if (purpose !== undefined && (typeof purpose !== 'string' || !/^[a-z_]{1,40}$/.test(purpose))) {
    return failure(400, 'invalid_purpose', 'purpose mal formé.');
  }
  if (conversationId !== undefined && conversationId !== null && (typeof conversationId !== 'string' || conversationId.length > 200)) {
    return failure(400, 'invalid_conversation', 'conversationId mal formé.');
  }
  const when = at === undefined ? s.now() : typeof at === 'string' ? new Date(at) : new Date(Number.NaN);
  if (Number.isNaN(when.getTime())) return failure(400, 'invalid_at', 'at doit être une date ISO.');

  const fiche = await s.acces.readFiche(viewer, personId);
  if (!fiche.ok) return refusal(fiche);

  const sendRequest: SendRequest = {
    channel: channel as Channel,
    kind: kind as SendKind,
    at: when,
    ...(purpose === undefined ? {} : { purpose }),
    ...(conversationId === undefined ? {} : { conversationId }),
  };
  const decision = await s.decision.decide(fiche.value.person.id, sendRequest);
  await appendEvent(
    s.journal,
    {
      type: 'envoi.decision.essai',
      actor: `${viewer.role}:${viewer.userId}`,
      subject: personSubject(fiche.value.person.id),
      data: {
        mode: TRIAL_MODE,
        allowed: decision.allowed,
        rule: decision.rule,
        checked: decision.checked,
        reason: decision.reason,
        channel,
        kind,
        at: when.toISOString(),
      },
    },
    s.now,
  );
  return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data: decision });
}

/**
 * La correction du classement par l'agent : gardée telle quelle, elle rejoint les cas de mesure. Seul celui qui voit
 * la fiche en entier corrige [R16] ; la qualification d'origine reste [R17].
 */
async function correctQualification(s: Services, viewer: Viewer, [id]: string[], request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { category, route } = body;
  if (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category)) {
    return failure(400, 'invalid_category', `category attendue parmi : ${CATEGORIES.join(', ')}.`);
  }
  if (route !== undefined && route !== null && (typeof route !== 'string' || !(NEXT_MODULES as readonly string[]).includes(route))) {
    return failure(400, 'invalid_route', `route attendue parmi : ${NEXT_MODULES.join(', ')}, ou null.`);
  }
  const row = await s.db.first<{ network_id: string }>('SELECT network_id FROM qualifications WHERE id = ?', [id!]);
  if (!row || row.network_id !== viewer.networkId) return json(404, { ok: false, rule: 'R16', code: 'unknown' });
  const done = await s.qualification.correct(s.acces, viewer, id!, category as (typeof CATEGORIES)[number], (route ?? null) as (typeof NEXT_MODULES)[number] | null);
  return done ? json(200, { ok: true, mode: TRIAL_MODE }) : json(403, { ok: false, rule: 'R16', code: 'not_assigned' });
}

/** Vérifie toute la chaîne du journal. Direction et conformité seulement [R16]. */
async function verifyJournal(s: Services, viewer: Viewer): Promise<Response> {
  const decision = decideAccess(viewer, { kind: 'journal', networkId: viewer.networkId });
  const actor = `${viewer.role}:${viewer.userId}`;
  if (!decision.allowed) {
    await appendEvent(s.journal, { type: 'acces.refuse', actor, subject: null, data: { rule: 'R16', role: viewer.role, kind: 'journal', code: decision.code } }, s.now);
    return refusal(decision);
  }
  const entries = await s.journal.all();
  const result = await verifyChain(entries);
  await appendEvent(s.journal, { type: 'journal.verifie', actor, subject: null, data: { rule: 'R16', ok: result.ok, lines: entries.length } }, s.now);
  return json(200, { ok: true, mode: TRIAL_MODE, data: { ...result, lines: entries.length } });
}

/**
 * Le formulaire « Être rappelé » du site, de bout en bout jusqu'à la réponse, en mode essai : la réponse est
 * prête et écrite au journal, jamais envoyée. Une clé de dépôt ne lit rien : elle ne rend que des statuts.
 */
async function intakeForm(request: Request, config: ApiConfig, now: () => Date): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Dépôt fermé : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys, 'site_form');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const journal = new SqlJournalStore(config.db);
  try {
    const { chaine } = createCaptation(config.db, journal, { now });
    // Le lien d'arrivée et la page de départ ne servent qu'à lire l'origine du contact (AT10) : ils ne sont jamais
    // rangés, même dans un formulaire illisible gardé tel quel pour l'agent [R156].
    const { link, landingPage, ...form } = body;
    await chaine.receive(intake.networkId, 'site_form', form, {}, { origin: { link, landingPage } });
    // Rien de plus : le sort du formulaire (personne exclue, déjà connue…) ne regarde pas le déposant [R02, R16].
    return json(200, { ok: true, mode: TRIAL_MODE, sent: false, received: true });
  } catch (error) {
    await journalError(journal, 'intake:site_form', 'captation.formulaire', error, now);
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}

/** Une adresse plausible, sans la normaliser ici : la fiche le fait, et une adresse inconnue est simplement refusée. */
const MAX_EMAIL_LENGTH = 254;
const MAX_TEXT_LENGTH = 4_000;
const MAX_FIGURES = 30;

/**
 * Une automatisation du site demande si son envoi peut partir (B01), en mode essai : le socle décide par le contrôle
 * central et n'envoie rien [R26]. La clé `site_auto` ne lit aucune fiche : seule la décision et sa règle reviennent.
 */
async function automationSend(request: Request, config: ApiConfig, now: () => Date): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Demandes fermées : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys, 'site_auto');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { automation, email, ref, text, figures } = body;
  if (typeof automation !== 'string' || !(AUTOMATION_NAMES as readonly string[]).includes(automation)) {
    return failure(400, 'invalid_automation', `automation attendue parmi : ${AUTOMATION_NAMES.join(', ')}.`);
  }
  if (typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH || !email.includes('@')) return failure(400, 'invalid_email', 'email manquant ou mal formé.');
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return failure(400, 'invalid_ref', 'ref manquante ou mal formée.');
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT_LENGTH) return failure(400, 'invalid_text', 'text manquant ou trop long.');
  if (
    figures !== undefined &&
    (!Array.isArray(figures) ||
      figures.length > MAX_FIGURES ||
      !figures.every((f) => (typeof f === 'string' && f.length <= 40) || (typeof f === 'number' && Number.isFinite(f))))
  ) {
    return failure(400, 'invalid_figures', 'figures doit être une courte liste de nombres ou de textes courts.');
  }
  const journal = new SqlJournalStore(config.db);
  try {
    const decision = await new Automatisations(config.db, journal, { now }).request({
      networkId: intake.networkId,
      automation: automation as Automation,
      email,
      ref,
      text,
      ...(figures === undefined ? {} : { figures: figures as (string | number)[] }),
    });
    return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data: { status: decision.status, rule: decision.rule, code: decision.code, reason: decision.reason, stage: decision.stage, decides: decision.decides, mentionMissing: decision.mentionMissing } });
  } catch (error) {
    await journalError(journal, 'intake:site_auto', 'automatisations.envoi', error, now);
    // Une panne du socle ramène l'automatisation en ombre [R26] ; si la base elle-même est tombée, le site décide seul.
    try {
      await new PaliersBascule(config.db, journal, { now }).incident(intake.networkId, automation, 'failure', null, 'system:bascule');
    } catch (rollbackError) {
      await journalError(journal, 'intake:site_auto', 'automatisations.retour_arriere', rollbackError, now);
    }
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}

const INCIDENT_RULE = /^R[0-9]{1,3}$/;

/**
 * Le site signale un écart non expliqué ou une panne de son côté (B04a) : l'automatisation revient en ombre [R26].
 * Cette route ne peut que faire descendre. Seuls ces trois champs sont admis : aucune donnée personnelle n'y passe [R13].
 */
async function automationIncident(request: Request, config: ApiConfig, now: () => Date): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Demandes fermées : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys, 'site_auto');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  if (Object.keys(body).some((k) => !['automation', 'kind', 'rule'].includes(k))) return failure(400, 'unexpected_field', 'Seuls automation, kind, rule sont admis.');
  const { automation, kind, rule } = body;
  if (typeof automation !== 'string' || !(AUTOMATION_NAMES as readonly string[]).includes(automation)) {
    return failure(400, 'invalid_automation', `automation attendue parmi : ${AUTOMATION_NAMES.join(', ')}.`);
  }
  if (typeof kind !== 'string' || !(ROLLOUT_INCIDENTS as readonly string[]).includes(kind)) return failure(400, 'invalid_kind', `kind attendu parmi : ${ROLLOUT_INCIDENTS.join(', ')}.`);
  if (rule !== undefined && rule !== null && (typeof rule !== 'string' || !INCIDENT_RULE.test(rule))) return failure(400, 'invalid_rule', 'rule mal formée.');
  const journal = new SqlJournalStore(config.db);
  try {
    const stage = await new PaliersBascule(config.db, journal, { now }).incident(intake.networkId, automation, kind as RolloutIncident, typeof rule === 'string' ? rule : null, 'intake:site_auto');
    return json(200, { ok: true, mode: TRIAL_MODE, data: { stage } });
  } catch (error) {
    await journalError(journal, 'intake:site_auto', 'automatisations.incident', error, now);
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}

/** Les routes de M10 avec le stockage des pièces ; sans lui, chacune répond 503, sans rien lire. */
/** Le coffre de conformité n'est lu que pour son état d'identité : rien n'y est rangé depuis M15. */
const NO_VAULT_STORAGE: conformite.VaultStorage = { put: () => Promise.reject(new Error('Le coffre ne range rien depuis M15.')) };

/**
 * Les routes de M15 (W10) : pièces et annexes lues dans le stockage des pièces (`PIECES`), seule leur existence ;
 * l'identité vérifiée lue au coffre de conformité, seul son état [R104]. Sans stockage, elles sont fermées.
 */
/** Le passage de l'ombre à 10 % : un geste de la direction seule, refusé si l'ombre n'a pas tenu ou si le passage est fermé [R16, R26]. */
function rolloutRoutes(open: boolean): RouteDef[] {
  return [
    {
      method: 'POST',
      pattern: /^\/automatisations\/paliers\/([a-z_]{1,32})\/avancer$/,
      name: 'automatisations.paliers.avancer',
      handle: async (s, viewer, params) => {
        const automation = params[0]!;
        if (!(AUTOMATION_NAMES as readonly string[]).includes(automation)) return failure(404, 'not_found', 'Automatisation inconnue.');
        const r = await new PaliersBascule(s.db, s.journal, { now: s.now, open }).advance(viewer, automation);
        if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: { stage: r.stage } });
        return r.rule === 'R16' ? refusal({ rule: 'R16', code: r.code }) : json(409, { ok: false, rule: r.rule, code: r.code });
      },
    },
  ];
}

/** Le palier de chaque canal de captation (C09e) : lu par la direction et la conformité, avancé par la direction seule [R16, R26]. */
function captationRolloutRoutes(rollout: ApiConfig['captationRollout']): RouteDef[] {
  const connected = rollout?.connected ?? [];
  const open = rollout?.open === true;
  return [
    {
      method: 'GET',
      pattern: /^\/captation\/paliers$/,
      name: 'captation.paliers',
      handle: async (s, viewer) => {
        const r = await new PaliersBascule(s.db, s.journal, { now: s.now }).list(viewer, OUTBOUND_CHANNELS.map(captationAutomation));
        if (!r.ok) return refusal({ rule: r.rule, code: r.code });
        // Des nombres et des dates, dans l'ordre des canaux : jamais une fiche.
        const data = r.value.map(({ automation: _automation, ...view }, i) => ({ channel: OUTBOUND_CHANNELS[i]!, connected: connected.includes(OUTBOUND_CHANNELS[i]!), ...view }));
        return json(200, { ok: true, mode: TRIAL_MODE, data });
      },
    },
    {
      method: 'POST',
      pattern: /^\/captation\/paliers\/([a-z_]{1,32})\/avancer$/,
      name: 'captation.paliers.avancer',
      handle: async (s, viewer, params) => {
        const channel = OUTBOUND_CHANNELS.find((c) => c === params[0]);
        if (!channel) return failure(404, 'not_found', 'Canal inconnu.');
        // Sans vrai canal, le passage ne prouverait rien, et le canal branché plus tard partirait à 10 % sans essai [R26].
        const plugged = connected.includes(channel);
        const r = await new PaliersBascule(s.db, s.journal, { now: s.now, open: open && plugged }).advance(viewer, captationAutomation(channel));
        if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: { stage: r.stage } });
        if (r.rule === 'R16') return refusal({ rule: 'R16', code: r.code });
        return json(409, { ok: false, rule: r.rule, code: r.code === 'not_open' && open ? 'no_real_channel' : r.code });
      },
    },
  ];
}

/** AU032 : ce qui manque à la réception des mails, et chaque portail vérifié ou non par un vrai mail reçu [R669]. */
function mailIntakeRoutes(settings: MailIntakeSettings): RouteDef[] {
  return [
    {
      method: 'GET',
      pattern: /^\/captation\/mail$/,
      name: 'captation.mail',
      handle: async (s, viewer) => {
        const r = await mailIntakeState(s.db, s.journal, viewer, settings, s.now);
        if (!r.ok) return refusal({ rule: r.rule, code: r.code });
        return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      },
    },
  ];
}

/** AU033 : ce qui manque à la captation Meta, et chaque canal vérifié ou non par un vrai message traité [R670]. */
function metaIntakeRoutes(settings: MetaIntakeSettings): RouteDef[] {
  return [
    {
      method: 'GET',
      pattern: /^\/captation\/meta$/,
      name: 'captation.meta',
      handle: async (s, viewer) => {
        const r = await metaIntakeState(s.db, s.journal, viewer, settings, s.now);
        if (!r.ok) return refusal({ rule: r.rule, code: r.code });
        return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      },
    },
  ];
}

function m15Routes(pieces: PieceStore | null, options: Pick<LocationServices, 'adWriter' | 'inventoryFormatter'>): RouteDef[] {
  return locationRoutes().map((r: LocationRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => {
      if (!pieces) return Promise.resolve(failure(503, 'pieces_not_configured', 'Location fermée : aucun stockage des pièces.'));
      const coffre = new conformite.CoffreConformite(s.db, s.acces, NO_VAULT_STORAGE, s.journal, { now: s.now });
      const services: LocationServices = { db: s.db, journal: s.journal, now: s.now, files: pieces, identity: { state: (networkId, personId) => coffre.state(networkId, personId) }, ...options };
      return r.handle(services, viewer, params, request);
    },
  }));
}

/** Les services publics du résumé de copropriété : ceux donnés, sinon la BAN de l'estimation et le Géoportail en lecture. */
function coproprieteSourcesOf(config: ApiConfig): Pick<CoproprieteServices, 'geocoder' | 'urbanism' | 'reader'> {
  if (config.copropriete !== undefined) return config.copropriete;
  return {
    geocoder: config.estimation?.geocoder ?? null,
    urbanism: config.fetchPublicData ? new GpuUrbanism(config.fetchPublicData) : null,
  };
}

/**
 * Les routes de la copropriété et de l'urbanisme résumés (RC52, BR87) : rôles contrôlés avant le corps [R16], dossier
 * contrôlé avant tout géocodage ; la zone est lue à sa source, jamais reçue de l'écran [R449].
 */
function coproprieteRoutesDef(sources: Pick<CoproprieteServices, 'geocoder' | 'urbanism' | 'reader'>): RouteDef[] {
  return coproprieteRoutes().map((r: CoproprieteRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now, ...sources }, viewer, params, request),
  }));
}

/**
 * Les routes de l'avant-contrat (HX45, RC54, BR89) sur le stockage des pièces de M10 : sans lui, fermées comme les
 * dossiers. Rôles contrôlés avant le corps [R16] ; le PDF prélu doit être celui même déposé au dossier par `…/preuves`.
 */
function avantContratRoutesDef(pieces: PieceStore | null, options: Pick<AvantContratServices, 'reader'>): RouteDef[] {
  return avantContratRoutes().map((r: AvantContratRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) =>
      pieces
        ? r.handle({ db: s.db, journal: s.journal, now: s.now, pieces, reader: options.reader ?? null }, viewer, params, request)
        : Promise.resolve(failure(503, 'pieces_not_configured', 'Avant-contrat fermé : aucun stockage des pièces.')),
  }));
}

/** Les routes de M12 (L09) : l'arrêt après une opposition passe par le contrôle central des envois [R04]. */
function m12Routes(coffre: VaultFiles | null): RouteDef[] {
  return conformiteRoutes().map((r: ConformiteRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, stop: s.decision, vault: coffre, now: s.now }, viewer, params, request),
  }));
}

/** Les routes des réclamations et du gel des avoirs (BR01) : droits de la couche métier [R16], mode essai seul [R26]. */
function securiteRoutesDef(registreGels: RegistreGelsSource | null): RouteDef[] {
  return securiteRoutes().map((r: SecuriteRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now, registreGels }, viewer, params, request),
  }));
}

/** Les routes des remises et des actualités (BR20) : droits de la couche métier [R16], rien n'est envoyé. */
function reseauUtileRoutesDef(): RouteDef[] {
  return reseauUtileRoutes().map((r: ReseauUtileRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now }, viewer, params, request),
  }));
}

/** Les routes de l'armoire des clés des biens (BR21) : droits de la couche métier [R16], rien n'est envoyé. */
function trousseauxRoutesDef(): RouteDef[] {
  return trousseauxRoutes().map((r: TrousseauxRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) =>
      r.handle({ db: s.db, journal: s.journal, acces: s.acces, fiche: new FicheUnique(s.db, new FicheClient(s.db, { now: s.now }), { now: s.now }), now: s.now }, viewer, params, request),
  }));
}

/** Les routes de la boutique de l'agent (BR22) : rôle contrôlé avant le corps [R16], imprimeur d'essai seul [R26]. */
function boutiqueRoutesDef(): RouteDef[] {
  return boutiqueRoutes().map((r: BoutiqueRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now }, viewer, params, request),
  }));
}

/** Les routes du stock de panneaux (BR23) : rôle contrôlé avant le corps [R16], porte de diffusion de D05 [R42]. */
function panneauxRoutesDef(): RouteDef[] {
  return panneauxRoutes().map((r: PanneauxRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now }, viewer, params, request),
  }));
}

/** Les routes de la veille des diagnostics énergétiques (BR26) : rôle contrôlé avant le corps [R16], aucun nom [R288]. */
function veilleDpeRoutesDef(): RouteDef[] {
  return veilleDpeRoutes().map((r: VeilleDpeRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** Les routes du mandat par questionnaire (BR115) : rôle contrôlé avant le corps [R16], clauses et prix [R440, R441, R442]. */
function questionnaireRoutesDef(): RouteDef[] {
  return questionnaireRoutes().map((r: QuestionnaireRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now }, viewer, params, request),
  }));
}

/** Les sources du score par adresse : celles données, sinon la Base adresse nationale et les ventes de l'estimation avec le cadastre et les diagnostics publics. */
function scoreSourcesOf(config: ApiConfig): ScoreServices | null {
  if (config.scoreSources !== undefined) return config.scoreSources;
  if (!config.estimation || !config.fetchPublicData) return null;
  const pub = publicDataServices(config.fetchPublicData);
  return { geocoder: config.estimation.geocoder, cadastre: pub.cadastre, energy: pub.energy, sales: config.estimation.sales };
}

/** Les routes du score de vente par adresse (BR27) : rôle contrôlé avant le corps [R16], aucun nom [R292]. */
function scoreAdresseRoutesDef(sources: ScoreServices | null): RouteDef[] {
  return scoreAdresseRoutes().map((r: ScoreAdresseRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now, sources }, viewer, params, request),
  }));
}

/** Les routes de la recherche en langage courant (BR39) : rôle contrôlé avant le corps [R16], biens diffusables seuls [R421]. */
function rechercheRoutesDef(): RouteDef[] {
  return rechercheRoutes().map((r: RechercheRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now }, viewer, params, request),
  }));
}

/** Les routes des statistiques du site (BR41) : rôle contrôlé avant toute lecture [R16], rien du visiteur [R285]. */
function statistiquesSiteRoutesDef(): RouteDef[] {
  return statistiquesSiteRoutes().map((r: StatistiquesSiteRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** Les routes de la carte des opportunités et de la tournée (BR28) : l'agent seul, par la couche métier [R16, R297]. */
function tourneeRoutesDef(geocoder: Geocoder | null): RouteDef[] {
  return tourneeRoutes().map((r: TourneeRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now, geocoder }, viewer, params, request),
  }));
}

/** Les routes de la pige (BR29) : rôles contrôlés avant le corps [R16], rien n'est envoyé [R275]. */
function pigeRoutesDef(source: PigeSource | null, provider: PigeProviderSettings | null): RouteDef[] {
  return pigeRoutes().map((r: PigeRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now, source, provider }, viewer, params, request),
  }));
}

/** Les sources de l'adresse de pige : celles données, sinon la base de l'ADEME et le cadastre par la lecture des données publiques. */
function adressePigeSourcesOf(config: ApiConfig): AdressePigeServices {
  if (config.adressePigeSources !== undefined) return config.adressePigeSources;
  if (!config.fetchPublicData) return {};
  return { search: new AdemeDiagnosisSearch(config.fetchPublicData), cadastre: publicDataServices(config.fetchPublicData).cadastre };
}

/** Les routes de l'adresse probable d'une annonce de pige et du bien créé (BR30) : rôles contrôlés avant le corps [R16], aucun nom [R294]. */
function adressePigeRoutesDef(sources: AdressePigeServices): RouteDef[] {
  return adressePigeRoutes().map((r: AdressePigeRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now, sources }, viewer, params, request),
  }));
}

/** Les routes de la séquence de prospection (BR31) : l'agent seul, contrôlé avant le corps [R16] ; rien ne part d'une route [R300]. */
function sequencesRoutesDef(): RouteDef[] {
  return sequencesRoutes().map((r: SequencesRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    // Bloctel n'est pas branché (H61) : aucune liste d'opposition, donc aucun appel de prospection seule proposé [R302].
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now, opposition: null }, viewer, params, request),
  }));
}

/** Les routes des scénarios automatiques (BR55) et des dates des clients (BR56) : la direction seule, contrôlée avant le corps [R16, R403] ; rien ne part d'une route [R401]. */
function scenariosRoutesDef(): RouteDef[] {
  return [...scenariosRoutes(), ...datesRoutes()].map((r: ScenariosRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** Les routes des conditions de passage des phases (BR10) : la direction seule, par la couche métier [R16]. */
function phasesRoutesDef(): RouteDef[] {
  return phasesRoutes().map((r: PhasesRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/**
 * Les routes du neuf et du viager (BR75) : le rôle contrôlé avant le corps, refus au journal [R16] ; l'expert du viager
 * passe par la mise en relation de M18, avec le stockage des fichiers des partenaires, et n'est jamais proposé sans
 * lui [R542].
 */
function neufViagerRoutesDef(partenaires: PartenairesOptions | null): RouteDef[] {
  return neufViagerRoutes().map((r: NeufViagerRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => {
      const files = partenaires?.files ?? null;
      const relation = files ? new MiseEnRelation(s.db, new Annuaire(s.db, files, s.journal, { now: s.now }), files, s.journal, { now: s.now }) : null;
      return r.handle({ db: s.db, journal: s.journal, now: s.now, relation }, viewer, params, request);
    },
  }));
}

/** Les routes de l'ouverture région par région (BR12) : la direction seule, par la couche métier [R16]. */
function regionsRoutesDef(): RouteDef[] {
  return regionsRoutes().map((r: RegionsRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** Les routes des seuils du passage à PostgreSQL (BR25) : la direction du réseau de la plateforme seule [R16]. */
function postgresqlRoutesDef(platformNetworkId: string | null): RouteDef[] {
  return postgresqlRoutes().map((r: PostgresqlRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now, platformNetworkId }, viewer, params, request),
  }));
}

/** Les routes de la licence du logiciel aux agences hors réseau (BR15) : la direction, par la couche métier [R16, R657]. */
function licencesRoutesDef(): RouteDef[] {
  return licencesRoutes().map((r: LicencesRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** Les routes du recrutement des 100 premiers agents (BR02) : la direction seule, par la couche métier [R16]. */
function recrutementRoutesDef(): RouteDef[] {
  return recrutementRoutes().map((r: RecrutementRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now }, viewer, params, request),
  }));
}

/** L'adresse du serveur MCP de l'agent et ses brouillons (BR08) : l'agent seul, contrôlé avant le corps [R16, R590, R591]. */
function mcpRoutesDef(): RouteDef[] {
  return mcpRoutes().map((r: McpRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now }, viewer, params, request),
  }));
}

/** Les routes du quiz et des attestations de formation (BR07) : chaque rôle contrôlé avant le corps [R16, R570, R571]. */
function formationRoutesDef(): RouteDef[] {
  return formationRoutes().map((r: FormationRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** Les routes du marketing (BR03) : chaque rôle contrôlé avant le corps [R16] ; rien ne part ni ne se paie [R26, R587]. */
function marketingRoutesDef(): RouteDef[] {
  return marketingRoutes().map((r: MarketingRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** Les routes des finances du réseau (BR04) : chaque rôle contrôlé avant le corps [R16] ; sans lecteur, la lecture des factures est fermée. */
function financesRoutesDef(lecteur: LecteurFactures | null): RouteDef[] {
  return financesRoutes().map((r: FinancesRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now, lecteur }, viewer, params, request),
  }));
}

/** Les routes des clés d'appareil et de l'export de l'agent (BR05) : rôle contrôlé avant le corps [R16] ; sans site WebAuthn, fermées. */
function clesRoutesDef(site: ClesConfig | null, fichiers: StockageFichiersPlages | null): RouteDef[] {
  return clesRoutes().map((r: ClesRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now, site, fichiers }, viewer, params, request),
  }));
}

/**
 * Les routes de M18 (U09) : chacune contrôle son rôle avant tout et écrit le refus au journal [R16] ; un partenaire ne
 * lit que ses mises en relation confiées, par la couche métier [R77]. Sans stockage des fichiers, elles sont fermées.
 */
function m18Routes(options: PartenairesOptions | null): RouteDef[] {
  return partenairesRoutes().map((r: PartenairesRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => {
      if (!options?.files) return Promise.resolve(failure(503, 'partner_files_not_configured', 'Partenaires fermés : aucun stockage des fichiers.'));
      return r.handle(
        { db: s.db, journal: s.journal, now: s.now, files: options.files, uploads: options.files, optOutBase: partnerOptOutBase(options.optOutBase), ...(options.fees ? { fees: options.fees } : {}) },
        viewer,
        params,
        request,
      );
    },
  }));
}

/**
 * Les routes de M17 (Y08) : chacune contrôle son rôle avant de lire le corps et écrit le refus au journal [R16] ; aucun
 * chiffre n'est calculé ailleurs que dans le code du serveur [R121] ; la seule route d'alertes passe par le contrôle
 * central, en mode essai, avec le lien de désinscription du réseau [R26, R49].
 */
function m17Routes(options: Pick<InvestirServices, 'noteWriter' | 'feesRateBp' | 'unsubscribeBase'>): RouteDef[] {
  return investirRoutes().map((r: InvestirRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now, ...options }, viewer, params, request),
  }));
}

/** Sans stockage réel des documents (H38), le dossier protégé ne sert que la fiche du commerce. */
const NO_DOSSIER_DOCUMENTS = { read: async () => null };

/** Les services de M16 sur ceux du socle : l'identité et les pièces du coffre par leur seul état [R15]. */
function m16Services(db: SqlDatabase, journal: JournalStore, acces: Acces, now: () => Date, options: ApiConfig['commerces']): CommercesServices {
  const coffre = new conformite.CoffreConformite(db, acces, NO_VAULT_STORAGE, journal, { now });
  const etat = new conformite.EtatCoffre(db, { now });
  const diffusion = new Diffusion(db, acces, journal, { now });
  return {
    db,
    journal,
    now,
    identity: { state: (networkId, personId) => coffre.state(networkId, personId) },
    vault: { everDeposited: (networkId, personId, kinds, before) => etat.everDeposited(networkId, personId, kinds, before) },
    diffusion: { canDiffuse: (networkId, propertyId, at) => diffusion.canDiffuse(networkId, propertyId, at) },
    storage: options?.storage ?? NO_DOSSIER_DOCUMENTS,
    ...(options?.presentationWriter ? { presentationWriter: options.presentationWriter } : {}),
    ...(options?.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
}

/** Les routes de M16 (CE10) : chacune contrôle son rôle, puis la couche métier ses droits fins [R16]. */
function m16Routes(options: ApiConfig['commerces']): RouteDef[] {
  return commercesRoutes().map((r: CommercesRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) =>
      // Sans début de lien configuré (`DOSSIER_LINK_BASE`), aucun dossier ne part : le lien mènerait nulle part.
      r.name === 'commerces.dossier.envoi' && !options?.baseUrl
        ? Promise.resolve(failure(503, 'dossier_link_not_configured', 'Dossier protégé fermé : aucun début de lien configuré.'))
        : r.handle(m16Services(s.db, s.journal, s.acces, s.now, options), viewer, params, request),
  }));
}

/**
 * Les routes de M19 (X10) : chacune contrôle son rôle avant de lire le corps et écrit le refus au journal [R16] ; sans
 * stockage des fichiers, elles sont fermées. Les réseaux ne sont jamais passés d'ici : la couche métier ne reçoit que
 * ses canaux du mode essai, et la porte de diffusion de D05 [R26, R42, R134].
 */
function m19Routes(options: StudioOptions | null): RouteDef[] {
  return studioRoutes().map((r: StudioRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => {
      if (!options?.files) return Promise.resolve(failure(503, 'studio_files_not_configured', 'Studio fermé : aucun stockage des fichiers.'));
      return r.handle({ db: s.db, journal: s.journal, now: s.now, files: options.files, writer: options.writer ?? null, uploads: options.uploads ?? null }, viewer, params, request);
    },
  }));
}

/**
 * Les routes de M20 complet (G12) : chacune contrôle son rôle avant de lire le corps et écrit le refus au journal
 * [R16] ; la couche métier refait ses contrôles de droits. Rien ne part : les relances passent par le contrôle central,
 * avec les canaux du mode essai seulement [R26, R143].
 */
/** Les accords notés par l'agent (AC02) : chaque route contrôle son rôle avant de lire le corps [R16]. */
function accordsFicheRoutes(): RouteDef[] {
  return accordsRoutes().map((r: AccordsRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, store: new FicheClient(s.db, { now: s.now }), acces: s.acces, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** Les biens créés depuis la fiche (SV06) : la route contrôle son rôle avant de lire le corps [R16]. */
function biensDeFicheRoutes(): RouteDef[] {
  return biensFicheRoutes().map((r: BiensFicheRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, acces: s.acces, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** La création à la voix (BR100) : l'agent seul, le rôle contrôlé avant le corps [R16]. */
function dicteeRoutesDef(reportWriter: ReportWriter | null): RouteDef[] {
  return dicteeRoutes().map((r: DicteeRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, acces: s.acces, journal: s.journal, now: s.now, reportWriter }, viewer, params, request),
  }));
}

/** Les appels notés par l'agent (AC12) : la route contrôle son rôle avant de lire le corps [R16, R204]. */
function appelsFicheRoutes(): RouteDef[] {
  return appelsRoutes().map((r: AppelsRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, acces: s.acces, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** La visite sans réseau (AU018) : l'agent en activité seul, le rôle contrôlé avant le corps [R16, R276, R278]. */
function horsLigneRoutesDef(): RouteDef[] {
  return horsLigneRoutes().map((r: HorsLigneRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

/** Les notifications de l'agent (BR66) : l'agent en activité seul, pour lui seul, contrôlé avant le corps [R16, R412]. */
function notificationsRoutesDef(): RouteDef[] {
  return notificationsRoutes().map((r: NotificationsRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, now: s.now }, viewer, params, request),
  }));
}

function m20Routes(options: ApiConfig['gagner']): RouteDef[] {
  return gagnerRoutes().map((r: GagnerRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle({ db: s.db, journal: s.journal, acces: s.acces, now: s.now, ...(options ?? {}) }, viewer, params, request),
  }));
}

/** Les services de M01 sur ceux du socle, toujours en mode essai : ni IndexNow ni fiche Google réels [R26]. */
function m01Services(db: SqlDatabase, journal: JournalStore, acces: Acces, now: () => Date, config: Pick<ApiConfig, 'estimation' | 'estimationLimits' | 'attirer' | 'candidatureNetworkId'>): AttirerServices {
  const diffusion = new Diffusion(db, acces, journal, { now });
  return {
    db,
    journal,
    now,
    mode: 'essai',
    priceSales: config.estimation?.sales ?? null,
    indexNow: null,
    gbp: null,
    gbpWriter: config.attirer?.gbpWriter ?? null,
    neighbourhoodWriter: config.attirer?.neighbourhoodWriter ?? null,
    diffusion: { canDiffuse: (networkId, propertyId, at) => diffusion.canDiffuse(networkId, propertyId, at) },
    recruitingNetworkId: config.candidatureNetworkId || null,
    estimation: config.estimation ?? null,
    estimationLimits: config.estimationLimits,
  };
}

/**
 * Les routes de M01 (AT11) : chacune contrôle son rôle avant de lire le corps et écrit le refus au journal [R16] ; la
 * couche métier refait ses contrôles de portée.
 */
function m01Routes(config: Pick<ApiConfig, 'estimation' | 'attirer'>): RouteDef[] {
  return attirerRoutes().map((r: AttirerRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => r.handle(m01Services(s.db, s.journal, s.acces, s.now, config), viewer, params, request),
  }));
}

/** Ce que l'agent lit d'un avis : ni le détail brut du calcul, ni les chiffres permis. */
const avisView = (r: ValuationReport) => ({
  id: r.id,
  propertyId: r.property_id,
  status: r.status,
  computedLow: r.computed_low,
  computedHigh: r.computed_high,
  low: r.agent_low ?? r.computed_low,
  high: r.agent_high ?? r.computed_high,
  text: r.text,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  validatedAt: r.validated_at,
});

/** Un refus de l'avis : droit ou validation en 403, inconnu en 404, le reste en 409 ou 422 selon sa cause. */
function avisRefusal(r: { rule: string | null; code: string; comparablesFound?: number }): Response {
  const status = r.code === 'unknown' ? 404 : r.code === 'not_configured' || r.code === 'sales_unavailable' ? 503 : r.code === 'not_following_agent' || r.code === 'not_validated' || r.rule === 'R16' ? 403 : r.code === 'already_validated' || r.code === 'changed_meanwhile' ? 409 : 422;
  return json(status, { ok: false, rule: r.rule, code: r.code, ...(r.comparablesFound !== undefined ? { comparablesFound: r.comparablesFound } : {}) });
}

/** E09 : préparer, lire, ajuster et valider un avis de valeur. Rien ne part d'ici [R26, R30]. */
function avisRoutes(config: Pick<ApiConfig, 'estimation' | 'fetchPublicData'>): RouteDef[] {
  const preparation = (s: Services) =>
    new PreparationAvis(s.db, s.acces, s.journal, config.estimation && config.fetchPublicData ? { collecte: publicDataServices(config.fetchPublicData), sales: config.estimation.sales } : null, { now: s.now });
  const avis = (s: Services) => new AvisDeValeur(s.db, s.journal, { now: s.now });
  return [
    {
      method: 'POST',
      pattern: new RegExp(`^/biens/${ID}/avis$`),
      name: 'bien.avis_prepare',
      handle: async (s, viewer, [id], request) => {
        const body = await readJson(request);
        if (!body) return failure(400, 'invalid_body', 'Corps JSON attendu.');
        const r = await preparation(s).prepare(viewer, id!, body);
        return r.ok ? json(201, { ok: true, mode: TRIAL_MODE, data: avisView(r.value) }) : avisRefusal(r);
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/biens/${ID}/avis$`),
      name: 'bien.avis_liste',
      handle: async (s, viewer, [id]) => {
        const r = await preparation(s).list(viewer, id!);
        return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value.map(avisView) }) : avisRefusal(r);
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/avis/${ID}/ajustement$`),
      name: 'avis.ajuste',
      handle: async (s, viewer, [id], request) => {
        const body = await readJson(request);
        if (!body) return failure(400, 'invalid_body', 'Corps JSON attendu.');
        const { low, high, text } = body;
        if ((low !== undefined && typeof low !== 'number') || (high !== undefined && typeof high !== 'number') || (text !== undefined && typeof text !== 'string')) return failure(400, 'invalid_body', 'Fourchette en nombres, texte en lettres.');
        const r = await avis(s).adjust(viewer, id!, { ...(low !== undefined ? { low } : {}), ...(high !== undefined ? { high } : {}), ...(text !== undefined ? { text } : {}) });
        return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: avisView(r.value) }) : avisRefusal(r);
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/avis/${ID}/validation$`),
      name: 'avis.valide',
      handle: async (s, viewer, [id], request) => {
        // La version que l'agent a lue : une autre, enregistrée ailleurs, ne se valide pas à l'aveugle [R30].
        const body = await readJson(request);
        if (!body || typeof body.updatedAt !== 'string') return failure(400, 'invalid_body', 'Version lue attendue.');
        const r = await avis(s).validate(viewer, id!, body.updatedAt);
        return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: avisView(r.value) }) : avisRefusal(r);
      },
    },
  ];
}

/** Une page publique de M01 : prix, agent, quartier, simulateur, plan du site, consignes aux moteurs. */
const isAttirerPublic = (path: string): boolean => Object.values(ATTIRER_PUBLIC_PATHS).some((p) => p.test(path));

/** Le nom d'une clé du relevé, comme le veut `ReleveEspace`. */
const RELEVE_KEY_ID = /^[a-z][a-z-]{0,30}$/;

/**
 * Les clés du relevé prouvé, lues dans le secret `ESPACE_RELEVE_KEYS` : `nom:secret`, séparées par des virgules, la
 * première signe, les suivantes vérifient seulement (rotation). Un secret mal formé (nom invalide, secret de moins de
 * 32 caractères, nom en double) ne donne aucune clé : le relevé est indisponible plutôt que mal signé [R164].
 */
export function releveKeys(raw: string | undefined): ReleveKey[] {
  if (raw === undefined || raw.trim() === '') return [];
  const keys: ReleveKey[] = [];
  for (const part of raw.split(',')) {
    const at = part.indexOf(':');
    if (at < 0) return [];
    const id = part.slice(0, at).trim();
    const secret = part.slice(at + 1).trim();
    if (!RELEVE_KEY_ID.test(id) || secret.length < 32 || keys.some((k) => k.id === id)) return [];
    keys.push({ id, secret });
  }
  return keys;
}

/** L'adresse de l'espace : en https, sans chiffre, terminée par `/espace/` ; sinon `null`, et l'espace est fermé. */
export function espaceBase(raw: string | undefined): string | null {
  const base = raw ? checkSpaceBase(raw.trim()) : null;
  return base && new URL(base).pathname === ESPACE_PATH ? base : null;
}

/** Sans stockage des pièces, aucune offre signée n'est reconnue : l'offre écrite depuis l'espace est refusée. */
const NO_SIGNED_OFFERS = { has: async (): Promise<boolean> => false };

/**
 * Les services des espaces sur ceux du socle (EC07) : les lecteurs SQL de EC08, EC09 et EC11, les gestes de EC10
 * passés aux modules qui les tiennent [R165], l'identité lue au coffre par son seul état, le rendement par la seule
 * porte des notes validées de M17 [R163]. `null` si l'espace n'est pas configuré.
 */
function espacesServices(db: SqlDatabase, journal: JournalStore, acces: Acces, now: () => Date, config: Pick<ApiConfig, 'espaces' | 'estimation' | 'pieces'>): EspacesServices | null {
  const networkId = config.espaces?.networkId?.trim();
  const baseUrl = espaceBase(config.espaces?.baseUrl);
  if (!networkId || !baseUrl) return null;
  const coffre = new conformite.CoffreConformite(db, acces, NO_VAULT_STORAGE, journal, { now });
  const identity = { state: (n: string, personId: string) => coffre.state(n, personId) };
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const { notes } = investirCore({ db, journal, now });
  return {
    db,
    journal,
    now,
    acces,
    networkId,
    baseUrl,
    parties: new SqlClientParties(db),
    vendeur: new SqlSourcesVendeur(db, acces, journal, { now }),
    proprietaire: new SqlSourcesProprietaire(db, identity, journal, { now, ranges: config.estimation ? new EstimationEnLigne(config.estimation.geocoder, config.estimation.sales, undefined, now) : null }),
    acquereur: new SqlSourcesAcquereur(db, acces, identity, journal, { now, notes }),
    gestes: new GestesModules(
      {
        db,
        journal,
        fiche,
        consents: store,
        visites: new Visites(db, journal, acces, { now }),
        offres: new m09core.RegistreOffres(db, acces, journal, { now }),
        financement: new m10core.FinancementDossier(db, acces, journal, { now }),
        signedOffers: config.pieces ?? NO_SIGNED_OFFERS,
      },
      { now },
    ),
    // Les clés des biens du vendeur, lues quand il ouvre leur lien (BR53) [R272, R161].
    cles: new Cles(db, acces, fiche, journal, { now }),
    releveKeys: releveKeys(config.espaces?.releveKeys),
  };
}

/**
 * La route de l'agent qui ouvre l'espace d'un client (EC07) : son rôle d'abord, son refus au journal [R16] ; sans
 * espace configuré, fermée.
 */
function espacesAgentRoutes(config: Pick<ApiConfig, 'espaces' | 'estimation' | 'pieces'>): RouteDef[] {
  return espacesRoutes().map((r: EspacesRoute) => ({
    method: r.method,
    pattern: r.pattern,
    name: r.name,
    handle: (s, viewer, params, request) => {
      const services = espacesServices(s.db, s.journal, s.acces, s.now, config);
      if (!services) return Promise.resolve(failure(503, 'espace_not_configured', 'Espace des clients fermé : ni réseau ni adresse configurés.'));
      return r.handle(services, viewer, params, request);
    },
  }));
}

/**
 * Le mandat d'un bien (D11) et sa signature papier : ces routes lisent le stockage des pièces (`PIECES`). Sans lui, le dépôt
 * répond fermé, la lecture reste ouverte, et un document réel ne se signe pas : un scan doit exister [R41].
 */
function mandatRoutes(pieces: PieceStore | null): RouteDef[] {
  const mandats = (s: Services) => new MandatDuBien(s.db, s.acces, s.journal, { now: s.now });
  return [
    // Le contrôle avant signature : la procuration d'un mandant représenté se vérifie dans le stockage des scans (AU059).
    {
      method: 'POST',
      pattern: new RegExp(`^/documents/${ID}/controle$`),
      name: 'document.controle',
      // Le contrôle avant signature, ligne par ligne ; un seul échec et le document ne se signe pas [R41].
      handle: async (s, viewer, [id]) => {
        const r = await new ControlesSignature(s.db, s.acces, s.journal, { now: s.now, scans: pieces }).check(viewer, id!);
        if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
        return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, code: r.code });
      },
    },
    // La signature et la fin de la signature en ligne : la procuration s'y vérifie aussi (AU059).
    {
      method: 'POST',
      pattern: new RegExp(`^/signatures/${ID}$`),
      name: 'signature.code',
      // La signature par le code reçu, et le tracé à l'écran s'il y en a un : d'essai ou réelle selon la session (AU003).
      handle: async (s, viewer, [id], request) => {
        const body = await readJson(request, 220_000);
        if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
        if (Object.keys(body).some((k) => !['code', 'drawing'].includes(k))) return failure(400, 'unexpected_field', 'Seuls code et drawing sont admis.');
        const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now, scans: pieces }).sign(viewer, id!, {
          code: typeof body.code === 'string' ? body.code : '',
          drawing: typeof body.drawing === 'string' ? body.drawing : null,
        });
        if (r.ok) return json(200, { ok: true, mode: r.value.mode, data: r.value });
        if (r.code !== 'send_refused' && r.rule === 'R16') return refusal({ rule: 'R16', code: r.code });
        return json(r.code === 'unknown_session' ? 404 : r.code === 'already_signed' || r.code === 'blocked' ? 409 : 400, { ok: false, code: r.code });
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/documents/${ID}/signature-en-ligne/fin$`),
      name: 'document.signature_en_ligne_fin',
      // Finit un document signé réellement par chaque mandant : mandat inscrit, dossier de preuve figé, exemplaire et
      // dossier remis à chacun ; la source du mandat, si la fiche ne la donne pas [R38, R39, R41] (AU003).
      handle: async (s, viewer, [id], request) => {
        const body = (await readJson(request)) ?? {};
        if (Object.keys(body).some((k) => k !== 'source' && k !== 'sourceDetail')) return failure(400, 'unexpected_field', 'Seuls source et sourceDetail sont admis.');
        const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now, scans: pieces }).finish(viewer, id!, {
          source: typeof body.source === 'string' ? body.source : null,
          sourceDetail: typeof body.sourceDetail === 'string' ? body.sourceDetail : null,
        });
        if (r.ok) return json(200, { ok: true, mode: 'reel', data: r.value });
        if (r.rule === 'R16') return refusal({ rule: 'R16', code: r.code });
        return json(r.code === 'unknown_document' ? 404 : 409, { ok: false, rule: r.rule, code: r.code });
      },
    },
    // La signature en ligne : la procuration d'un mandant représenté se vérifie dans le stockage des scans (AU059).
    {
      method: 'POST',
      pattern: new RegExp(`^/documents/${ID}/signature-en-ligne$`),
      name: 'document.signature_en_ligne',
      // Ouvre une session de signature en ligne, en essai : le code passe par le contrôle central et reste dans la boîte
      // d'essai tant que H05 n'est pas fait ; la signature ne rend jamais un mandat réel tant que H24 n'est pas fait [R41].
      handle: async (s, viewer, [id], request) => {
        const body = await readJson(request);
        if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
        if (Object.keys(body).some((k) => k !== 'consentProof' && k !== 'signerId')) return failure(400, 'unexpected_field', 'Seuls consentProof et signerId sont admis.');
        // Le mandant qui signe, pour un mandat à plusieurs mandants ; le premier par défaut (AU001).
        if (body.signerId !== undefined && (typeof body.signerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.signerId))) return failure(400, 'invalid_ids', 'signerId mal formé.');
        const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now, scans: pieces }).start(viewer, id!, {
          consentProof: typeof body.consentProof === 'string' ? body.consentProof : '',
          ...(typeof body.signerId === 'string' ? { signerId: body.signerId } : {}),
        });
        // Le mode de la session, fixé à son ouverture : d'essai tant que H05 et H24 ne sont pas faits (AU003).
        if (r.ok) return json(200, { ok: true, mode: r.value.mode, data: r.value });
        if (r.code !== 'send_refused' && r.rule === 'R16') return refusal({ rule: 'R16', code: r.code });
        return json(400, { ok: false, rule: r.rule, code: r.code, ...('check' in r ? { check: r.check } : {}) });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/biens/${ID}/mandat$`),
      name: 'bien.mandat',
      // Les documents du bien, sans contenu, le mandat en cours et les mandants possibles : son agent, direction, conformité [R16].
      handle: async (s, viewer, [id]) => {
        const r = await mandats(s).read(viewer, id!);
        return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : refusal(r);
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/biens/${ID}/scans-mandat$`),
      name: 'bien.mandat.scan',
      // Le scan signé, rangé tel quel ; la référence rendue sert à `signature-papier`. Son agent, la direction [R16].
      handle: async (s, viewer, [id], request) => {
        const upload = pieces?.upload?.bind(pieces);
        if (!upload) return json(503, { ok: false, rule: null, code: 'depot_ferme' });
        const length = request.headers.get('content-length');
        const declaredSize = length === null || length.trim() === '' ? null : /^\d{1,12}$/.test(length.trim()) ? Number(length.trim()) : Number.NaN;
        const r = await mandats(s).depositScan(viewer, id!, { put: (key, bytes, type) => upload(key, bytes, type) }, {
          contentType: request.headers.get('content-type'),
          sha256: request.headers.get('x-aimmo-sha256'),
          declaredSize,
          read: (max) => readCapped(request, max),
        });
        if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
        if (r.rule === 'R16') return refusal(r);
        return json(({ trop_lourd: 413, type_refuse: 415, stockage_indisponible: 503 } as Record<string, number>)[r.code] ?? 400, { ok: false, rule: null, code: r.code });
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/documents/${ID}/signature-papier$`),
      name: 'document.signature_papier',
      // Un mandat signé sur papier : contrôlé à l'instant, scan présent, rangé avec sa source, numéroté, exemplaire produit [R39, R41].
      handle: async (s, viewer, [id], request) => {
        const body = await readJson(request);
        if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
        if (Object.keys(body).some((k) => !['signedAt', 'place', 'scanRef', 'source', 'sourceDetail'].includes(k))) return failure(400, 'unexpected_field', 'Seuls signedAt, place, scanRef, source, sourceDetail sont admis.');
        if (typeof body.signedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.signedAt)) return failure(400, 'invalid_date', 'signedAt : un instant ISO en UTC.');
        const r = await new SignaturePapier(s.db, s.acces, s.journal, { now: s.now, scans: pieces }).register(viewer, id!, {
          signedAt: new Date(body.signedAt),
          place: body.place as never,
          scanRef: body.scanRef as string,
          source: typeof body.source === 'string' ? body.source : null,
          sourceDetail: typeof body.sourceDetail === 'string' ? body.sourceDetail : null,
        });
        if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
        if (r.rule === 'R16') return refusal(r);
        return json(r.code === 'already_signed' ? 409 : r.code === 'depot_ferme' ? 503 : 400, { ok: false, rule: r.rule, code: r.code, ...('check' in r ? { check: r.check } : {}) });
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/documents/${ID}/signature-avenant$`),
      name: 'document.signature_avenant',
      // Un avenant signé sur papier : contrôlé à l'instant, scan présent, rangé avec son exemplaire ; le mandat change alors [R41].
      handle: async (s, viewer, [id], request) => {
        const body = await readJson(request);
        if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
        if (Object.keys(body).some((k) => !['signedAt', 'place', 'scanRef'].includes(k))) return failure(400, 'unexpected_field', 'Seuls signedAt, place, scanRef sont admis.');
        if (typeof body.signedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.signedAt)) return failure(400, 'invalid_date', 'signedAt : un instant ISO en UTC.');
        const r = await new SignatureAvenant(s.db, s.acces, s.journal, { now: s.now, scans: pieces }).register(viewer, id!, { signedAt: new Date(body.signedAt), place: body.place as never, scanRef: body.scanRef as string });
        if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
        if (r.rule === 'R16') return refusal(r);
        return json(r.code === 'already_signed' ? 409 : r.code === 'depot_ferme' ? 503 : 400, { ok: false, rule: r.rule, code: r.code, ...('check' in r ? { check: r.check } : {}) });
      },
    },
  ];
}

function m10Routes(pieces: PieceStore | null): RouteDef[] {
  return dossierRoutes().map((r: DossierRoute) => ({
    ...r,
    handle: (s, viewer, params, request) => (pieces ? r.handle({ ...s, pieces }, viewer, params, request) : Promise.resolve(failure(503, 'pieces_not_configured', 'Dossiers fermés : aucun stockage des pièces.'))),
  }));
}

/** Jamais d'erreur avalée : une ligne au journal, sans le détail qui pourrait porter une donnée [R13]. */
export async function journalError(journal: JournalStore, actor: string, route: string, error: unknown, now: () => Date): Promise<void> {
  try {
    await appendEvent(journal, { type: 'api.erreur', actor, subject: null, data: { route, error: error instanceof Error ? error.name : 'unknown' } }, now);
  } catch {
    console.error('aimmo-api : erreur sans journal', route);
  }
}

/**
 * Le point d'entrée de l'API du socle. Tout passe ici : clé, droits, journal.
 * Lecture prudente : sans clé valable, sans configuration ou hors mode essai, rien n'est lu.
 */
export async function handleRequest(request: Request, config: ApiConfig): Promise<Response> {
  const now = config.now ?? (() => new Date());
  const url = new URL(request.url);
  // L'application de l'agent (A01) : une coquille sans aucune donnée, servie seulement en mode essai.
  const app = handleAgentApp(request);
  if (app) return config.mode === TRIAL_MODE ? app : failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
  // La désinscription des alertes (T03) : une page publique, sans clé, hors de /v1 pour que le lien n'ait aucun chiffre.
  if (url.pathname.startsWith(UNSUBSCRIBE_PATH)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleUnsubscribe(request, { db: config.db, now });
      if (page) return page;
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:desinscription', 'alertes.desinscription', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // La désinscription de la lettre d'information (HX53, BR112) : une page publique, sans clé, hors de /v1, sans chiffre.
  if (url.pathname.startsWith(LETTER_UNSUBSCRIBE_PATH)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleLetterUnsubscribe(request, { db: config.db, now });
      if (page) return page;
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:desinscription', 'lettre.desinscription', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // Les pages publiques de l'après-vente (F07) : désinscription des relances, note de satisfaction, carnet du propriétaire.
  if (url.pathname.startsWith(APRES_VENTE_PATH)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleApresVentePublic(request, { db: config.db, now });
      if (page) return page;
    } catch (error) {
      await apresVentePublicError(config.db, error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // La page de candidature au réseau (J12), servie par le socle comme les autres pages publiques (J13).
  if (url.pathname === CANDIDATURE_PATH || url.pathname === `${CANDIDATURE_PATH}/`) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleCandidature(request, { db: config.db, networkId: config.candidatureNetworkId || null, now });
      if (page) return page;
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:candidature', 'reseau.candidature', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // La page d'opposition à la prospection des partenaires (U08), sans clé, servie par le socle (U09) [R04, R79].
  if (url.pathname.startsWith(PARTENAIRES_OPPOSITION_PATH)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handlePartenairesPublic(request, { db: config.db, now });
      if (page) return page;
    } catch (error) {
      await partenairesPublicError(config.db, error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // Le certificat public d'une photo (X10) : sans clé, sans aucune donnée personnelle [R46, R13].
  if (url.pathname.startsWith(CERTIFICATE_PAGE_PATH)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleCertificatePage(request, { db: config.db, now });
      if (page) return page;
    } catch (error) {
      await certificatePageError(config.db, error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // L'espace partenaire en ligne (U10) : une coquille sans donnée, qui ne lit que par /v1/partenaires.
  const space = handleEspacePartenaire(request);
  if (space) return config.mode === TRIAL_MODE ? space : failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
  // La vitrine des biens (P10) : la page publique, la fiche imprimable et les photos de la version publiée.
  if (url.pathname.startsWith('/biens/') || url.pathname.startsWith('/medias/')) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleVitrine(request, config.db, config.media, now);
      if (page) return page;
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:vitrine', 'vitrine', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // Les pages publiques de M01 (AT11), servies sur le site du réseau et celui de chaque agent, reconnus par leur adresse.
  if (isAttirerPublic(url.pathname)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    const s = services(config.db, now);
    try {
      const page = await handleAttirerPublic(m01Services(s.db, s.journal, s.acces, now, config), request);
      if (page) return page;
    } catch (error) {
      await journalError(s.journal, 'public:attirer', 'attirer.public', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // L'espace des clients (EC07), sans clé d'API : la séance du client est son cookie, à côté des clés [R160, R161].
  if (url.pathname === ESPACE_PATH.slice(0, -1) || url.pathname.startsWith(ESPACE_PATH)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    const s = services(config.db, now);
    const espace = espacesServices(s.db, s.journal, s.acces, now, config);
    if (!espace) return failure(503, 'espace_not_configured', 'Espace des clients fermé : ni réseau ni adresse configurés.');
    try {
      const page = await handleEspacePublic(request, espace);
      if (page) return page;
    } catch (error) {
      await journalError(s.journal, 'public:espace', 'espaces.public', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // Le tarif public de la licence du logiciel (BR15) : sans clé, sans aucune agence ni aucun nombre [R655, R657].
  if (url.pathname.startsWith(`${API_PREFIX}/licences/tarif/`)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    const journal = new SqlJournalStore(config.db);
    try {
      const page = await handleLicencesPublic(request, { db: config.db, journal, now });
      if (page) return page;
    } catch (error) {
      await journalError(journal, 'public:licences', 'licences.tarif_public', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // La vérification publique d'une attestation de formation (BR07) : la page et sa route, sans clé, rien de rangé [R571].
  if (url.pathname === '/attestation' || url.pathname === `${API_PREFIX}/formation/verification`) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleAttestationPublic(request, { db: config.db });
      if (page) return page;
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:attestation', 'formation.verification', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) return failure(404, 'not_found', 'Adresse inconnue.');
  const path = url.pathname.slice(API_PREFIX.length);

  if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');

  if (path === '/sante') {
    if (request.method !== 'GET') return failure(405, 'method_not_allowed', 'Méthode non admise.');
    return json(200, { ok: true, version: AIMMO_VERSION, mode: TRIAL_MODE });
  }

  if (path === '/captation/formulaire') return intakeForm(request, config, now);

  if (path === '/automatisations/envoi') return automationSend(request, config, now);
  if (path === '/automatisations/incident') return automationIncident(request, config, now);

  if (path === ESTIMATION_PATH) {
    try {
      return await handleEstimation(request, {
        db: config.db,
        intakeKeys: config.intakeKeys,
        ...(config.estimation ? { services: config.estimation } : {}),
        ...(config.estimationLimits ? { limits: config.estimationLimits } : {}),
        now,
      });
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'intake:site_estimate', 'estimation.commune', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  if (path === ASSISTANT_PATH || path.startsWith(`${ASSISTANT_PATH}/`)) {
    try {
      return await handleAssistant(request, path, {
        db: config.db,
        intakeKeys: config.intakeKeys,
        ...(config.assistantLimits ? { limits: config.assistantLimits } : {}),
        ...(config.writer ? { writer: config.writer } : {}),
        now,
      });
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'intake:site_chat', 'assistant', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  if (path === BOOKING_SLOTS_PATH || path === BOOKING_PATH) {
    try {
      return await handleBooking(request, path, {
        db: config.db,
        intakeKeys: config.intakeKeys,
        ...(config.bookingLimits ? { limits: config.bookingLimits } : {}),
        linkBase: config.appointmentLinkBase ?? null,
        now,
      });
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'intake:site_booking', 'rendez-vous', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  if (path === META_PATH) {
    const meta = config.meta ?? { appSecret: undefined, verifyTokenSha256: undefined, networkId: undefined, ownIds: undefined, appIds: undefined };
    return handleMeta(request, { ...meta, db: config.db, now });
  }

  // Le lecteur d'un dossier protégé de commerce (CE10), sans compte : le jeton du lien, son adresse et le code reçu à
  // cette adresse font foi ; la porte de CE04 est revérifiée à chaque ouverture, chaque refus journalisé [R113, R114].
  const reader = dossierReaderRoutes().find((r) => r.pattern.test(path));
  if (reader) {
    if (request.method !== reader.method) return failure(405, 'method_not_allowed', 'Méthode non admise.');
    const journal = new SqlJournalStore(config.db);
    try {
      const store = new FicheClient(config.db, { now });
      const acces = new Acces(config.db, store, new FicheUnique(config.db, store, { now }), journal, { now });
      return await reader.handle(m16Services(config.db, journal, acces, now, config.commerces), (reader.pattern.exec(path) ?? []).slice(1), request);
    } catch (error) {
      await journalError(journal, 'public:dossier', reader.name, error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  // L'accès en un clic (Z02) : un jeton d'invitation, à usage unique, échangé contre des clés neuves.
  if (`/v1${path}` === INVITATION_PATH) {
    try {
      return await handleInvitation(request, config.db, now());
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:invitation', 'acces.invitation', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  // L'accès de sortie d'un agent parti (AU111) : public, le lien seul ouvre ; jamais un client.
  if (path.startsWith('/sortie/')) {
    try {
      const exit = await handleSortiePublic(request, path, { db: config.db, journal: new SqlJournalStore(config.db), now }, config.reseau?.pieces ?? null);
      if (exit) return exit;
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:sortie', 'reseau.sortie', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  // La connexion par une clé d'appareil (BR06) : publique, limitée en débit, une seule réponse pour tout refus [R600].
  try {
    const login = await handleConnexion(request, { db: config.db, now, site: config.cles ?? null, ...(config.clesLimits ? { limits: config.clesLimits } : {}) });
    if (login) return login;
  } catch (error) {
    await journalError(new SqlJournalStore(config.db), 'public:connexion', 'cles.connexion', error, now);
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }

  // Le serveur MCP sans agent (BR08) : les seuls biens diffusables d'un réseau, sans clé, limité en débit [R592].
  if (url.pathname.startsWith(MCP_PUBLIC_PREFIX)) {
    const s = services(config.db, now);
    try {
      const page = await handleMcpPublic(request, { db: s.db, acces: s.acces, now, ...(config.mcpPublicLimits ? { limits: config.mcpPublicLimits } : {}) });
      if (page) return page;
    } catch (error) {
      await journalError(s.journal, 'public:mcp', 'mcp.public', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  // Les clés du secret `API_KEYS`, et celles remises par une invitation (Z02). Un secret présent mais mal formé
  // ferme toute l'API, même s'il existe des clés d'invitation : lecture prudente. À côté des clés, la séance d'une clé
  // d'appareil (BR06), relue dans la base à chaque demande : une clé retirée ou un agent parti la coupent [R600, R82].
  const parsedKeys = config.apiKeys === undefined || config.apiKeys.trim() === '' ? [] : parseApiKeys(config.apiKeys);
  if (parsedKeys === null) return failure(503, 'keys_not_configured', 'API fermée : aucune clé configurée.');
  // AU108 · avec les séances réglées, une clé du secret d'un agent, de la direction ou de la conformité sans date de fin
  // n'ouvre rien : elle serait un accès permanent à côté des séances. La clé « mcp » de l'assistant n'ouvre que le MCP.
  const secretKeys = config.cles ? parsedKeys.filter((k) => k.expiresOn !== undefined || k.scope === 'mcp' || !DEVICE_KEY_ROLES.includes(k.role)) : parsedKeys;
  // AU108 · avec les séances réglées, une clé d'application ne vit que le temps de ranger la clé de l'appareil.
  const keys = mergeKeys(secretKeys, await invitedKeys(config.db, config.cles ? { now: now() } : {}));
  if (keys.length === 0 && !config.cles) return failure(503, 'keys_not_configured', 'API fermée : aucune clé configurée.');
  let keyViewer = keys.length > 0 ? await viewerFromRequest(request, keys, parisLocalTime(now(), 'Europe/Paris').date) : null;
  // La clé qu'un agent a créée pour son assistant (BR09), relue dans la base à chaque demande : retirée, ou son agent
  // parti, elle n'est plus reconnue [R82]. Elle porte la portée « mcp » : elle n'ouvre que le serveur MCP [R590].
  if (keyViewer === null) {
    const bearer = bearerKey(request);
    const assistant = bearer === null ? null : await assistantKeyViewer(config.db, await sha256Hex(bearer), now());
    if (assistant !== null) {
      markMcpKey(request);
      keyViewer = assistant;
    }
  }
  const viewer = keyViewer ?? (config.cles ? await sessionViewer(request, { db: config.db, now, site: config.cles }) : null);
  // Une demande ouverte par la séance d'une clé d'appareil, et non par une clé qu'on peut confier à un assistant (BR08).
  if (keyViewer === null && viewer !== null) markDeviceSession(request);
  if (viewer === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');

  // Une même adresse peut servir à lire (GET) et à écrire (POST) : la route est choisie par l'adresse et la méthode.
  // Les routes de M08 (T08) suivent celles du socle ; elles portent le lien de désinscription du réseau.
  // Puis celles de M07 (P10) : fiche, contrôle, annonce, publication ; puis celles de M09 (O09) : les offres ; puis
  // celles de M10 (N09) : les dossiers de vente, fermés sans le stockage des pièces ; puis celles de M11 (F07) ; puis
  // celles de M13 (K08) : le pilotage ; puis celles de M14 (J13) : le réseau et l'académie ; puis celles de M15 (W10) :
  // la location, fermées sans le stockage des pièces ; puis celles de M12 (L09) : la conformité, avec les réclamations et
  // le gel des avoirs (BR01), le recrutement (BR02), le marketing (BR03), les finances (BR04), les clés d'appareil et l'export de l'agent (BR05) ; puis celles de M18
  // (U09) : les partenaires, fermées sans le stockage de leurs fichiers ; puis celles de M17 (Y08) : investir ; puis
  // celles de M16 (CE10) : les commerces ; puis celles de M19
  // (X10) : le Studio, fermées sans le stockage des fichiers ; puis celles de M20 complet (G12) : gagner des mandats ;
  // puis celles de M01 (AT11) : attirer ; puis celles de la reprise des contacts (I05) ; puis celle des espaces des
  // clients (EC07), fermée sans espace configuré.
  const routes: RouteDef[] = [
    ...ROUTES,
    ...m08Routes({ unsubscribeBase: config.alertUnsubscribeBase ?? null, geocoder: config.secteursGeocoder ?? config.estimation?.geocoder ?? null, ...(config.reportWriter ? { reportWriter: config.reportWriter } : {}) }),
    ...annonceRoutes(config.listing ?? {}),
    ...offreRoutes(config.pieces ?? null),
    ...m10Routes(config.pieces ?? null),
    ...mandatRoutes(config.pieces ?? null),
    ...apresVenteRoutes(),
    ...pilotageRoutes(),
    ...reseauRoutes(config.reseau ?? {}),
    ...rolloutRoutes(config.automationRolloutOpen === true),
    ...captationRolloutRoutes(config.captationRollout),
    ...mailIntakeRoutes({ mode: config.mode, networkId: config.mail?.networkId, forwardTo: config.mail?.forwardTo, ownAddresses: config.mail?.ownAddresses }),
    ...metaIntakeRoutes({ mode: config.mode, ...(config.meta ?? { appSecret: undefined, verifyTokenSha256: undefined, networkId: undefined, ownIds: undefined, appIds: undefined }) }),
    ...m15Routes(config.pieces ?? null, config.location ?? {}),
    ...coproprieteRoutesDef(coproprieteSourcesOf(config)),
    ...avantContratRoutesDef(config.pieces ?? null, config.avantContrat ?? {}),
    ...m12Routes(config.coffre ?? null),
    ...securiteRoutesDef(config.registreGels ?? null),
    ...reseauUtileRoutesDef(),
    ...trousseauxRoutesDef(),
    ...boutiqueRoutesDef(),
    ...panneauxRoutesDef(),
    ...veilleDpeRoutesDef(),
    ...questionnaireRoutesDef(),
    ...scoreAdresseRoutesDef(scoreSourcesOf(config)),
    ...tourneeRoutesDef(config.estimation?.geocoder ?? null),
    ...rechercheRoutesDef(),
    ...statistiquesSiteRoutesDef(),
    ...pigeRoutesDef(config.pigeSource ?? null, config.pigeProvider ?? null),
    ...adressePigeRoutesDef(adressePigeSourcesOf(config)),
    ...sequencesRoutesDef(),
    ...phasesRoutesDef(),
    ...scenariosRoutesDef(),
    ...regionsRoutesDef(),
    ...neufViagerRoutesDef(config.partenaires ?? null),
    ...postgresqlRoutesDef(config.platformNetworkId || null),
    ...licencesRoutesDef(),
    ...recrutementRoutesDef(),
    ...marketingRoutesDef(),
    ...formationRoutesDef(),
    ...mcpRoutesDef(),
    ...financesRoutesDef(config.lecteurFactures ?? null),
    ...clesRoutesDef(config.cles ?? null, config.fichiersReprise ?? null),
    ...m18Routes(config.partenaires ?? null),
    ...m17Routes({ ...(config.investir ?? {}), unsubscribeBase: config.alertUnsubscribeBase ?? null }),
    ...m16Routes(config.commerces),
    ...m19Routes(config.studio ?? null),
    ...m20Routes(config.gagner),
    ...accordsFicheRoutes(),
    ...biensDeFicheRoutes(),
    ...dicteeRoutesDef(config.reportWriter ?? null),
    ...appelsFicheRoutes(),
    ...notificationsRoutesDef(),
    ...horsLigneRoutesDef(),
    ...m01Routes(config),
    ...avisRoutes(config),
    ...repriseRoutes(),
    ...espacesAgentRoutes(config),
  ];
  const matching = routes.filter((candidate) => candidate.pattern.test(path));
  if (matching.length === 0) return failure(404, 'not_found', 'Adresse inconnue.');
  const route = matching.find((candidate) => candidate.method === request.method);
  if (!route) return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const params = (route.pattern.exec(path) ?? []).slice(1);

  const s = services(config.db, now);
  try {
    // Une fuite de données peut couper les accès (L08) : tout le réseau sauf le responsable de la conformité, ou une
    // seule personne. Les clés du secret ne se réécrivent pas : elles sont refusées ici, avant toute lecture [R97, R16].
    if (await accessCut(s.db, s.journal, viewer, now)) {
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${viewer.role}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: viewer.role, kind: `route.${route.name}`, code: 'access_cut' } }, now);
      return json(403, { ok: false, rule: 'R16', code: 'access_cut' });
    }
    // La clé confiée à un assistant (portée « mcp ») n'ouvre que le serveur MCP, et le serveur MCP n'accepte qu'elle :
    // l'assistant ne lit aucune fiche, n'enregistre aucune clé d'appareil et ne décide aucun brouillon [R590, R591].
    const mcpKey = fromMcpKey(request);
    if (mcpKey !== (route.name === 'mcp.agent')) {
      const code = mcpKey ? 'cle_mcp_hors_mcp' : 'cle_mcp_requise';
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${viewer.role}:${viewer.userId}`, subject: null, data: { rule: 'R590', role: viewer.role, kind: `route.${route.name}`, code } }, now);
      return json(403, { ok: false, rule: 'R590', code });
    }
    // AU107 · un rôle à accès limité n'atteint que ses routes nommées : toute autre est refusée avant sa porte [R16].
    const limited = LIMITED_ROLE_ROUTES[viewer.role];
    if (limited !== undefined && !limited.includes(route.name)) {
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${viewer.role}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: viewer.role, kind: `route.${route.name}`, code: 'limited_role' } }, now);
      return json(403, { ok: false, rule: 'R16', code: 'limited_role' });
    }
    // Un agent parti ne lit ni n'écrit plus rien, dès minuit le jour de son départ [R86, R16] ; un agent au dossier
    // incomplet n'a que les routes de son intégration [R82]. Le refus est écrit au journal avant toute lecture.
    if (viewer.role === 'agent') {
      const state = await agentState(s.db, viewer.networkId, viewer.userId, now());
      const code = state === 'parti' ? 'agent_inactive' : state === 'dossier_incomplet' && !OPEN_WITHOUT_AGENT_FILE.has(route.name) ? 'agent_file_incomplete' : null;
      if (code) {
        const rule = code === 'agent_inactive' ? 'R16' : 'R82';
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `agent:${viewer.userId}`, subject: null, data: { rule, role: 'agent', kind: `route.${route.name}`, code } }, now);
        return json(403, { ok: false, rule, code });
      }
    }
    const response = await route.handle(s, viewer, params, request);
    // AU108 · la clé de cet appareil rangée par une clé d'application : celle-ci cesse ; l'appareil entre désormais par
    // ses séances, qu'on coupe en retirant sa seule clé, sans toucher aux autres appareils [R600].
    const appKey = invitationKeyOf(request);
    // AU067 · une rétractation ou une annulation du mandat retire l'annonce tout de suite, partout, avec chaque accusé ;
    // ce qui échoue reste dû au passage planifié [R42, R668].
    if ((route.name === 'mandat.retractation' || route.name === 'mandat.annulation') && response.ok && params[0]) {
      const retraits = new m07.RetraitsImmediats(s.db, s.acces, s.journal, { now, ...(config.listing?.channels ? { channels: config.listing.channels } : {}), ...(config.listing?.portals ? { portals: config.listing.portals } : {}) });
      const propertyId = await retraits.propertyOfMandate(viewer.networkId, params[0]);
      if (propertyId !== null) {
        const done = await retraits.run(viewer.networkId, propertyId, `${String(viewer.role)}:${viewer.userId}`);
        const body = (await response.json()) as Record<string, unknown>;
        return json(response.status, { ...body, retraits: { state: done.state, channels: done.channels, portals: done.portals, busy: done.busy } });
      }
    }
    if (route.name === 'cles.appareils.retrait' && response.ok && params[0]) await retireApplicationKeysOf(s.db, s.journal, params[0], `${viewer.role}:${viewer.userId}`, now);
    if (appKey !== null && route.name === 'cles.enregistrement.fin' && response.ok) {
      if (await retireApplicationKey(s.db, s.journal, appKey, `${viewer.role}:${viewer.userId}`, now)) {
        // L'application le sait : elle quitte la clé retirée et propose l'entrée par la clé de l'appareil.
        const body = (await response.json()) as Record<string, unknown>;
        return json(response.status, { ...body, handoff: true });
      }
    }
    return response;
  } catch (error) {
    // Jamais d'erreur avalée : une ligne au journal, sans le détail qui pourrait porter une donnée [R13].
    try {
      await appendEvent(
        s.journal,
        { type: 'api.erreur', actor: `${viewer.role}:${viewer.userId}`, subject: null, data: { route: route.name, error: error instanceof Error ? error.name : 'unknown' } },
        now,
      );
    } catch {
      console.error('aimmo-api : erreur sans journal', route.name);
    }
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}
