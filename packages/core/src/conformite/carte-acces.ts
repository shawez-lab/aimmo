/**
 * Carte des demandes d'accès (M12, L07) [R96].
 *
 * Pour chaque table du registre des traitements (L06), la carte dit comment y trouver les lignes d'une personne :
 *
 * - par une colonne qui porte son identifiant (`person_id`, `buyer_person_id`…), avec un préfixe s'il le faut
 *   (`subject = 'person:<id>'` au journal) ;
 * - par une ligne déjà trouvée dans une autre table : la colonne vaut la clé de cette ligne (un rendez-vous de la
 *   personne, puis ses rappels) ;
 * - dans un tableau JSON dont chaque élément nomme sa personne (le plan du jour d'un agent) : seuls ses éléments sortent.
 *
 * Ou bien, pourquoi la table n'entre pas dans la réponse : elle ne porte aucune donnée d'un client (réglages, agents,
 * partenaires, candidats au réseau), ne peut être reliée à personne, ou relève de la lutte contre le blanchiment, dont
 * le droit d'accès s'exerce auprès de la CNIL (code monétaire et financier, article L561-45).
 *
 * Jamais vu : `checkAccessMap` compare la carte aux migrations et au registre. Une table du registre absente de la
 * carte, ou une colonne qui désigne une personne et que la carte ne suit pas, fait échouer les vérifications : la
 * réponse d'accès ne peut pas oublier une table que la base a gagnée.
 *
 * Rien d'une autre personne : quand une ligne nomme deux personnes (un parrain et son filleul, un vendeur et son
 * acquéreur), les colonnes de l'autre sont masquées. Les empreintes de jetons et de codes, des secrets de sécurité,
 * sont masquées aussi.
 */
import type { Schema, Traitement } from './registre.ts';
import { REGISTRE_TRAITEMENTS } from './registre-traitements.ts';

/** Une colonne qui porte l'identifiant de la personne, avec son préfixe éventuel. */
export interface DirectLocator {
  column: string;
  prefix?: string;
  /** Les lignes ne comptent que si ces colonnes ont ces valeurs. */
  where?: Readonly<Record<string, string>>;
}

/** Une colonne qui vaut la clé d'une ligne déjà trouvée dans une autre table. */
export interface ViaLocator {
  column: string;
  from: string;
  key: string;
  prefix?: string;
  /** La valeur n'est pas la colonne entière mais ce champ de son JSON (`column` est alors une colonne JSON). */
  jsonPath?: string;
  /** Les lignes ne comptent que si ces colonnes commencent par ces textes. */
  startsWith?: Readonly<Record<string, string>>;
  /** Les lignes ne comptent que si ces champs du JSON de `data` ont ces valeurs (champ → valeur). */
  jsonIs?: Readonly<Record<string, string>>;
  /** Les lignes ne comptent pas si ce champ du JSON de `data` a cette valeur, ou l'une de ces valeurs. */
  jsonNot?: Readonly<Record<string, string | readonly string[]>>;
  /** Les lignes ne comptent que si ces colonnes ont l'une de ces valeurs. */
  only?: Readonly<Record<string, readonly string[]>>;
  /** Les lignes ne comptent pas si ces colonnes ont l'une de ces valeurs. */
  except?: Readonly<Record<string, readonly string[]>>;
  where?: Readonly<Record<string, string>>;
  /** Seulement les lignes de `from` trouvées par cette colonne directe, ou portant cette marque (`tag`) : pas celles de l'autre partie. */
  onlyMatchedBy?: string;
  /** Pas les lignes de `from` trouvées seulement par cette marque (`tag`) : un coacquéreur ne reçoit pas ce qui suit le dossier pour les autres (AU009). */
  notOnlyBy?: string;
  /** D'autres colonnes qui doivent aussi valoir celles de la même ligne de `from` (colonne ici → colonne là-bas). */
  alsoMatch?: Readonly<Record<string, string>>;
  /** Pour une colonne de `alsoMatch` : le préfixe ajouté à la valeur de la ligne de `from` (`rental:` devant l'identifiant du logement). */
  alsoMatchPrefix?: Readonly<Record<string, string>>;
  /** Les lignes trouvées par ce chemin portent cette marque, que `onlyMatchedBy` d'une table suivante peut exiger. */
  tag?: string;
  /** Seulement les lignes de `from` qui ont ces valeurs. */
  parentWhere?: Readonly<Record<string, string>>;
}

/** Un tableau JSON dont chaque élément nomme sa personne : seuls ses éléments sortent. */
export interface JsonLocator {
  json: string;
  /** Les champs de l'élément qui portent l'identifiant, une valeur ou une liste. */
  idFields: readonly string[];
  /**
   * Des champs dont chaque valeur doit être une fiche de la personne : un élément qui nomme aussi une autre fiche
   * (une fusion annulée depuis) n'est pas rendu, comme il n'est plus relu ailleurs.
   */
  onlyMine?: readonly string[];
}

export type Locator = DirectLocator | ViaLocator | JsonLocator;

export type ExclusionReason = 'sans_client' | 'agent' | 'candidat' | 'partenaire' | 'non_rattachable' | 'lcb_ft';

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  sans_client: 'Aucune donnée d\'un client : réglage, modèle ou compte agrégé du réseau.',
  agent: 'Données des agents du réseau, pas des clients.',
  candidat: 'Données des candidats au réseau, pas des clients.',
  partenaire: 'Données des partenaires professionnels, pas des clients.',
  non_rattachable: 'Données qui ne peuvent être reliées à aucune personne.',
  lcb_ft: 'Lutte contre le blanchiment : le droit d\'accès s\'exerce auprès de la CNIL (code monétaire et financier, article L561-45).',
};

export type AccessMapEntry =
  | {
      locate: readonly Locator[];
      /** Pour une colonne directe : les colonnes qui appartiennent à la personne qu'elle désigne. Montrées seulement si la ligne a été trouvée par elle. */
      own?: Readonly<Record<string, readonly string[]>>;
      /** Secrets de sécurité (empreintes de jetons ou de codes) : jamais montrés. */
      secrets?: readonly string[];
      /** Des colonnes qui mêlent les données d'une autre personne (un document à deux parties) : jamais montrées, leur empreinte reste. */
      shared?: readonly string[];
      /**
       * Les colonnes `shared` ne le sont que pour les lignes dont `key` figure dans `from.column` : un mandat n'est à deux
       * parties que s'il a un autre mandant (AU001). Sans cela, toute ligne de la table est partagée.
       */
      sharedIf?: { key: string; from: string; column: string; alsoFrom?: readonly string[] };
      /** Des lignes à écarter : une colonne et les débuts de valeur écartés. */
      /**
       * Des lignes à écarter : celles dont `column` commence par l'un des `prefixes`, et celles dont `marked` contient
       * l'une des valeurs JSON de `markers` (une chaîne entière entre guillemets).
       */
      skip?: { column: string; prefixes: readonly string[]; marked?: string; markers?: readonly string[] };
      /**
       * Des colonnes (texte ou JSON) où toute référence à une autre fiche de personne, `person:<id>` ou `<id>`, est
       * masquée ; la ligne n'est alors plus à la seule personne (à examiner avant un effacement).
       */
      foreignPersons?: readonly string[];
    }
  | { excluded: ExclusionReason; why: string };

const by = (...columns: string[]): DirectLocator[] => columns.map((column) => ({ column }));
const via = (column: string, from: string, key = 'id', extra: Partial<ViaLocator> = {}): ViaLocator => ({ column, from, key, ...extra });
const out = (excluded: ExclusionReason, why: string): AccessMapEntry => ({ excluded, why });
/** Un document qui a d'autres mandants (AU001). */
// Un document nommant plusieurs personnes : des co-mandants (AU001) ou un représentant par procuration (AU059).
const CO_MANDANTS = (key: string) => ({ key, from: 'document_co_mandants', column: 'document_id', alsoFrom: ['document_proxies'] });

/** Le traitement dont le droit d'accès s'exerce auprès de la CNIL. */
export const LCB_FT_TRAITEMENT = 'conformite-lcb-ft';

const LCB_FT_EXCLUSIONS: Readonly<Record<string, AccessMapEntry>> = Object.fromEntries(
  Object.keys(REGISTRE_TRAITEMENTS.find((t) => t.id === LCB_FT_TRAITEMENT)?.tables ?? {}).map((table) => [table, out('lcb_ft', 'Lutte contre le blanchiment.')]),
);

/** Les sortes d'événements du journal qui relèvent de la lutte contre le blanchiment : jamais dans la réponse. */
export const JOURNAL_LCB_PREFIXES = ['coffre.', 'risque.', 'identification.', 'vigilance.', 'conformite.'] as const;
/**
 * Les marques, dans les données d'un événement, d'un geste de la lutte contre le blanchiment écrit par un autre module :
 * un refus de lire le coffre, une fiche de risque ou une vigilance, un dossier bloqué par l'identification. Un tel
 * événement n'entre jamais dans la réponse, quelle que soit sa sorte.
 */
export const JOURNAL_LCB_MARKERS = ['compliance_vault', 'risk_sheet', 'identification', 'vigilance', 'conformite', 'R58', 'R90', 'R91', 'R92', 'R93', 'R94'] as const;

/**
 * Chaque préfixe de sujet écrit dans le code (`subject: \`<préfixe>:…\``), et ce qu'en fait la réponse d'accès.
 * `journal` : le journal est lu sous ce préfixe (une entrée de `CARTE_ACCES.journal.locate`). Sinon, la raison pour
 * laquelle il ne l'est pas. Un test relève chaque préfixe du code et exige qu'il soit ici : un nouveau sujet ne peut
 * pas manquer à la réponse sans qu'on l'ait décidé.
 */
export type JournalSubjectUse = 'journal' | { excluded: ExclusionReason | 'envoi' | 'pas_un_sujet'; why: string };

/**
 * Chaque sorte d'événement écrit au journal d'un dossier de vente (`sale_file:<id>`), et à qui elle revient. Un dossier
 * a deux parties : l'acquéreur (`buyer_person_id`) et le vendeur (`sale_file_sellers`). Aucune sorte n'est attribuée par
 * défaut : un test relève chaque événement écrit sous ce sujet dans le code et exige qu'il soit ici.
 *
 * - `partage` : l'avancée du dossier, que ses deux parties suivent (dates, pièces reçues, acte) : aux deux ;
 * - `acquereur` : ce qui n'est qu'à l'acquéreur (son financement, son carnet de propriétaire) ;
 * - `client` : ce qui est fait pour un seul client (sa relance, sa note, son remerciement, sa facture), qui porte sa
 *   fiche (`client: 'person:<id>'`) : à ce client seul, retrouvé par ses fiches réunies ; sans `client`, à personne ;
 * - sinon, la raison pour laquelle l'événement n'entre pas dans la réponse.
 */
export type SaleFileEventUse = 'partage' | 'acquereur' | 'client' | { excluded: ExclusionReason; why: string };

const INTERNE = (why: string): SaleFileEventUse => ({ excluded: 'agent', why });

export const SALE_FILE_EVENTS: Readonly<Record<string, SaleFileEventUse>> = {
  'dossier.compromis_en_preparation': 'partage',
  // La raison peut être le prêt de l'acquéreur : elle ne va pas au vendeur [R233, R14].
  'dossier.arrete': 'acquereur',
  'dossier.date': 'partage',
  'dossier.date_a_saisir': 'partage',
  'dossier.echeance': 'partage',
  // Les conditions suspensives sont celles du compromis, signé par les deux parties (AU082).
  'dossier.condition': 'partage',
  'dossier.condition_alerte': 'partage',
  'dossier.piece_recue': 'partage',
  'dossier.depot': INTERNE('Fichier déposé par l\'agent, pas encore rangé comme pièce : sa référence, sans donnée d\'un client.'),
  'dossier.depot.refuse': INTERNE('Dépôt refusé pour un motif technique, sans donnée d\'un client.'),
  'dossier.piece_refusee': 'partage',
  // HX34 : l'état des risques avance avec le dossier ; le journal n'en porte que des identifiants et des drapeaux.
  'dossier.etat_risques_prepare': 'partage',
  'dossier.etat_risques_range': 'partage',
  'dossier.etat_risques_perime_a_l_acte': 'partage',
  // HX35 : le résumé de copropriété et les travaux votés signalés ; le journal n'en porte que des identifiants et des nombres.
  'dossier.copropriete_resumee': 'partage',
  'dossier.travaux_votes_signales': 'partage',
  // RC42 : la prélecture des documents de la copropriété par l'IA ; le journal n'en porte que la source, des rubriques et des nombres.
  'dossier.copropriete_prelue': 'partage',
  // RC52 : la zone d'urbanisme collectée au Géoportail ; le journal n'en porte que l'issue et sa raison, jamais l'adresse.
  'dossier.urbanisme_collecte': 'partage',
  // HX36 : la lettre recommandée de l'avant-contrat et ses preuves ; le journal n'en porte que des identifiants et des règles.
  // HX45 : note au notaire, projet comparé, dépôt reçu par le notaire, dates reportées ; le journal n'en porte que des noms de termes et des règles.
  'avant_contrat.note': 'partage',
  'avant_contrat.projet': 'partage',
  'avant_contrat.dates': 'partage',
  'avant_contrat.dates_bloquees': 'partage',
  'avant_contrat.depot': 'partage',
  'avant_contrat.depot_refuse': 'partage',
  // RC39 : la prélecture du projet par l'IA, que les deux parties peuvent connaître ; le journal n'en porte que la source et des noms de termes.
  'avant_contrat.prelecture': 'partage',
  'dossier.recommande_prepare': 'partage',
  'dossier.recommande_envoye': 'partage',
  'dossier.recommande_essai': 'partage',
  'dossier.recommande_refuse': 'partage',
  'dossier.recommande_preuve': 'partage',
  'dossier.recommande_date_non_ecrite': 'partage',
  // HX37 : le circuit de signature, ses lectures, signatures et rappels ; le journal n'en porte que des identifiants et des nombres.
  'dossier.circuit_prepare': 'partage',
  'dossier.circuit_lecture': 'partage',
  'dossier.circuit_signature': 'partage',
  'dossier.circuit_complet': 'partage',
  'dossier.circuit_rappel': 'partage',
  'dossier.circuit_rappel_refuse': 'partage',
  'dossier.dia_preparee': INTERNE('Préparation par l\'agent de la déclaration pour le notaire : des nombres de champs, sans donnée d\'un client.'),
  'dossier.acte_signe': 'partage',
  'dossier.acte_refuse': 'partage',
  'dossier.bloque': 'partage',
  'dossier.financement': 'acquereur',
  'dossier.alerte_financement': 'acquereur',
  'apres_vente.carnet': 'acquereur',
  'dossier.alerte_fonds': 'client',
  'dossier.rappel_fonds': 'client',
  'dossier.relance': 'client',
  'apres_vente.remerciement_tache': 'client',
  'apres_vente.remerciement': 'client',
  'apres_vente.remerciement_decision': 'client',
  'apres_vente.remerciement_appel': 'client',
  'apres_vente.demande_avis': 'client',
  'apres_vente.satisfaction': 'client',
  'apres_vente.choix_relances': 'client',
  'apres_vente.relance': 'client',
  'facture.emise': 'client',
  'facture.avoir': 'client',
  'facture.attente': INTERNE('Facturation en attente : fonctionnement du réseau, sans donnée du client.'),
  'facture.erreur': INTERNE('Erreur de facturation : fonctionnement du réseau, sans donnée du client.'),
  'facture.envoi_en_panne': INTERNE('Plateforme de facturation en panne : fonctionnement du réseau.'),
  'facture.facturx_attente': INTERNE('Facture électronique en attente d\'identités : fonctionnement du réseau, sans donnée du client.'),
  'facture.facturx_panne': INTERNE('Identités de facturation en panne : fonctionnement du réseau.'),
  'facture.reelle_attente': INTERNE('Facture réelle en attente d\'identités : fonctionnement du réseau, sans donnée du client.'),
  'facture.statut': INTERNE('Statut d\'une facture chez la plateforme agréée : fonctionnement du réseau, sans donnée du client.'),
  'facture.suivi_en_panne': INTERNE('Suivi de la plateforme de facturation en panne : fonctionnement du réseau.'),
  'commission.attente': INTERNE('Rémunération de l\'agent.'),
  'commission.ecart': INTERNE('Rémunération de l\'agent.'),
  'commission.etape': INTERNE('Rémunération de l\'agent.'),
  'commission.encaissement': INTERNE('Encaissement des honoraires par le réseau.'),
  // HX49 : rapprochement d'une facture et d'une ligne de banque (des identifiants) ; relance d'une facture impayée, qui porte la fiche du client.
  'banque.rapprochement': INTERNE('Rapprochement d\'une facture et d\'une ligne de banque du réseau : des identifiants, sans donnée d\'un client.'),
  'facture.relance': 'client',
  'commission.reversement': INTERNE('Reversement à l\'agent.'),
  'commission.alerte_reversement': INTERNE('Alerte de reversement à l\'agent.'),
  'acces.refuse': INTERNE('Accès refusé à un membre du réseau.'),
  // HX46 : invitation d'un client à donner un avis vérifié (porte sa fiche) ; refus d'invitation, sans donnée d'un client.
  'avis.invitation': 'client',
  'avis.refuse': INTERNE('Invitation à un avis refusée : dossier non clos ou personne hors du dossier, sans donnée d\'un client.'),
  'apres_vente.lien_avis_manquant': INTERNE('Lien d\'avis manquant de l\'agent.'),
  'apres_vente.lien_avis': INTERNE('Lien d\'avis réglé pour l\'agent.'),
  // Le signalement au responsable d'un dossier de vente : jamais dans la réponse (lutte contre le blanchiment).
  'conformite.signalement': { excluded: 'lcb_ft', why: 'Signalement au responsable de la conformité.' },
  'conformite.signalement_decision': { excluded: 'lcb_ft', why: 'Décision du responsable sur un signalement.' },
  // HX57 : le contrôle du gel des avoirs, au responsable seul (lutte contre le blanchiment et gel des avoirs).
  'securite.gel_registre': { excluded: 'lcb_ft', why: 'Version du registre national des gels importée par le responsable.' },
  'securite.gel_controle': { excluded: 'lcb_ft', why: 'Contrôle d\'un dossier contre le registre des gels.' },
  'securite.gel_correspondance': { excluded: 'lcb_ft', why: 'Correspondance au registre des gels, au responsable seul.' },
  'securite.gel_decision': { excluded: 'lcb_ft', why: 'Décision du responsable sur une correspondance au registre des gels.' },
};

/** Les événements écrits sous le bien qui portent une offre : ceux d'un acquéreur, jamais de qui possède ou a possédé le bien [R96]. */
const PROPERTY_OFFER_EVENTS = ['offre.enregistree', 'offre.cle_reutilisee', 'offre.depot', 'offre.depot.refuse', 'dossier.ouvert'] as const;
const saleFileTypes = (...uses: SaleFileEventUse[]): string[] => Object.entries(SALE_FILE_EVENTS).filter(([, u]) => uses.includes(u)).map(([t]) => t).sort();

const ENVOI = (why: string): JournalSubjectUse => ({ excluded: 'envoi', why: `Sujet d'un envoi du contrôle central (${why}) : jamais écrit au journal, rangé avec la personne dans message_subjects et send_log, lus par sa fiche.` });

export const JOURNAL_SUBJECTS: Readonly<Record<string, JournalSubjectUse>> = {
  ad_campaign: { excluded: 'sans_client', why: 'Une campagne de publicité payante (HX54) : sa création, ses validations, son lancement, son arrêt et ses contacts comptés, sans donnée d\'un client ; les contacts se lisent dans ad_campaign_contacts par person_id.' },
  device: { excluded: 'agent', why: 'Une clé d\'accès d\'un appareil d\'un utilisateur du réseau (HX56) : rangement, accord, retrait, connexion.' },
  user: { excluded: 'agent', why: 'Un utilisateur du réseau, objet d\'une preuve de second facteur (HX56) : « ajouter un appareil ».' },
  exit_access: { excluded: 'agent', why: 'Un accès de sortie d\'un agent parti (AU111) : un refus de son retrait, sans le lien ni donnée d\'un client.' },
  edition: { excluded: 'sans_client', why: 'Une édition de la lettre d\'information (HX53) : son ouverture par la direction, sans donnée d\'un client.' },
  lettre: ENVOI('lettre d\'information d\'une édition, HX53'),
  bien: ENVOI('bien proposé à une personne, une seule fois [R05], relu par la lettre d\'information, HX53'),
  complaint: { excluded: 'sans_client', why: 'Une réclamation (HX58) : des codes seulement (rangement, réponse, alertes, médiateur), jamais le motif ni le texte ; la réclamation se lit dans complaints par person_id.' },
  mcp_draft: { excluded: 'agent', why: 'Un brouillon de l\'assistant de l\'agent (HX55) : son rangement et sa décision ; une note, et sa fiche, se lisent dans mcp_drafts par person_id.' },
  report: { excluded: 'sans_client', why: 'Un rapport sur mesure enregistré (HX62) : des mesures et un regroupement, sans donnée d\'un client.' },
  new_program: { excluded: 'sans_client', why: 'Un programme neuf d\'un promoteur partenaire (HX48) : sa création et les versions de ses lots, sans donnée d\'un client.' },
  date: ENVOI('message d\'anniversaire ou de fête, HX25'),
  mail: ENVOI('réponse validée à un mail de la boîte de l\'agent, HX26'),
  recommande: ENVOI('lettre recommandée de l\'avant-contrat, HX36'),
  circuit: ENVOI('rappel de signature d\'un circuit, HX37'),
  vitrine: { excluded: 'sans_client', why: 'Un écran de vitrine du réseau ou d\'un agent : sa création, sans donnée d\'un client.' },
  scenario: { excluded: 'sans_client', why: 'Un scénario automatique de la direction : sa composition, ses essais, ses allumages, sans donnée d\'un client.' },
  avis_verifie: { excluded: 'sans_client', why: 'Un avis vérifié publié (HX46) : la remise de sa preuve à la conformité, ou un refus d\'accès, sans donnée d\'un client.' },
  captation: { excluded: 'pas_un_sujet', why: 'L\'état de la réception des mails (AU032) : un refus de lecture, des réglages et des comptes, jamais une personne.' },
  copy: { excluded: 'pas_un_sujet', why: 'Une copie de la base : des comptes, jamais une donnée d\'une personne.' },
  person: 'journal',
  mandate: 'journal',
  document: 'journal',
  offer: 'journal',
  sale_file: 'journal',
  appointment: 'journal',
  visit: 'journal',
  rental_application: 'journal',
  rental: 'journal',
  person_request: 'journal',
  prospect_retention: 'journal',
  valuation: { excluded: 'sans_client', why: 'Refus d\'imprimer un avis inconnu de ce réseau : un identifiant demandé, sans donnée d\'un client.' },
  breach: { excluded: 'sans_client', why: 'Fuite de données : les gestes du responsable, sans donnée d\'un client.' },
  property: 'journal',
  project: 'journal',
  referral: 'journal',
  signature: 'journal',
  rental_presentation: 'journal',
  listing: 'journal',
  listing_translation: 'journal',
  discount: { excluded: 'sans_client', why: 'Remise négociée du réseau, sans donnée d\'un client.' },
  news: { excluded: 'sans_client', why: 'Actualité du réseau, de source publique, sans donnée d\'un client.' },
  pige_ad: { excluded: 'sans_client', why: 'Annonce de particulier : le bien sans adresse, jamais le particulier.' },
  pige_draft: { excluded: 'sans_client', why: 'Premier message de pige de l\'agent, sans nom ni coordonnée du particulier.' },
  sign: { excluded: 'sans_client', why: 'Panneau du stock : son numéro, ses poses et retraits, sans adresse ni donnée d\'un client.' },
  dpe: { excluded: 'non_rattachable', why: 'Diagnostic publié par l\'ADEME et sa lettre « Au propriétaire », sans adresse ni nom.' },
  dpe_sector: { excluded: 'agent', why: 'Secteur de veille des diagnostics de l\'agent, sans adresse.' },
  address_score: { excluded: 'non_rattachable', why: 'Score de vente d\'une adresse : le score, sa tranche et le mandat relié, sans adresse ni nom.' },
  key: { excluded: 'sans_client', why: 'Trousseau d\'un bien : son numéro et les agents qui l\'ont eu, sans donnée d\'un client.' },
  shop_order: { excluded: 'sans_client', why: 'Commande de supports de l\'agent : l\'annonce publiée et sa carte professionnelle, sans donnée d\'un client.' },
  inbound: 'journal',
  voice_note: 'journal',
  call: 'journal',
  prospecting_sequence: 'journal',
  prospecting_sequence_step: { excluded: 'pas_un_sujet', why: 'Refus d\'accès à une étape de séquence inconnue ou d\'un autre agent : la ligne ne porte que l\'identifiant demandé.' },
  sequence: ENVOI('étape d\'une séquence de prospection, HX20'),
  message: 'journal',
  task: 'journal',
  alert: 'journal',
  proposal: 'journal',
  lease_signature: 'journal',
  signature_bail: ENVOI('code et exemplaire de la signature du bail'),
  signature_engagement: ENVOI('code de la signature de l\'engagement de confidentialité d\'un commerce'),
  dossier_commerce: ENVOI('lien personnel du dossier protégé d\'un commerce'),
  espace_client: ENVOI('lien personnel de l\'espace client'),
  offre: ENVOI('transmission d\'une offre'),
  rappel_fonds: ENVOI('rappel des fonds'),
  suivi_valeur: ENVOI('suivi de valeur'),
  ancien_contact: ENVOI('relance d\'un ancien contact'),
  merci: ENVOI('remerciement'),
  avis: ENVOI('demande d\'avis'),
  apres_vente: ENVOI('relance après la vente'),
  visite_code: ENVOI('code de sécurité de visite'),
  compte_rendu: ENVOI('compte rendu'),
  point_semaine: ENVOI('point de la semaine'),
  relance_avis: ENVOI('relance d\'un avis de valeur'),
  relance_piece: ENVOI('relance d\'une pièce'),
  relance_facture: ENVOI('relance d\'une facture d\'honoraires impayée'),
  rdv_confirmation: ENVOI('confirmation de rendez-vous'),
  tournee: ENVOI('tournée de visites'),
  agent: { excluded: 'agent', why: 'Un agent du réseau.' },
  agent_pair: { excluded: 'agent', why: 'Un binôme d\'agents.' },
  agent_push: { excluded: 'agent', why: 'Un envoi au téléphone d\'un agent, rangé dans la boîte d\'essai des notifications (SV15).' },
  academy_module: { excluded: 'agent', why: 'Formation des agents.' },
  quiz_question: { excluded: 'agent', why: 'Question de formation des agents (HX63).' },
  quiz_attempt: { excluded: 'agent', why: 'Quiz de formation d\'un agent (HX63).' },
  quiz_attestation: { excluded: 'agent', why: 'Attestation de formation d\'un agent (HX63).' },
  academy_session: { excluded: 'agent', why: 'Formation des agents.' },
  training_case: { excluded: 'agent', why: 'Entraînement des agents.' },
  training_session: { excluded: 'agent', why: 'Entraînement des agents.' },
  assistance: { excluded: 'agent', why: 'Assistance d\'un agent par le réseau.' },
  recruiting_answer: { excluded: 'candidat', why: 'Réponse à un candidat au réseau.' },
  candidate: { excluded: 'candidat', why: 'Un candidat au réseau.' },
  partner: { excluded: 'partenaire', why: 'Un partenaire professionnel.' },
  partner_prospect: { excluded: 'partenaire', why: 'Un futur partenaire.' },
  partner_agency: { excluded: 'partenaire', why: 'Une agence partenaire, un professionnel (HX01).' },
  agency_share: { excluded: 'partenaire', why: 'Un bien partagé avec une agence partenaire : ni nom ni montant d\'un client (HX01).' },
  pro_send: { excluded: 'partenaire', why: 'Un envoi à un professionnel, rangé dans la boîte d\'essai.' },
  network: { excluded: 'sans_client', why: 'Le réseau lui-même.' },
  licence: { excluded: 'sans_client', why: 'Une licence du logiciel donnée à une agence hors réseau (HX73) : son octroi, ses états et ses lectures, des codes et un prix, jamais un client.' },
  template: { excluded: 'sans_client', why: 'Modèle de document.' },
  clause: { excluded: 'sans_client', why: 'Texte d\'une clause du questionnaire de mandat.' },
  mandat_questionnaire: { excluded: 'sans_client', why: 'Mandat préparé par questionnaire : refus d\'accès et écart montré, seulement son identifiant ; sa préparation est au sujet de la fiche.' },
  lease_template: { excluded: 'sans_client', why: 'Modèle de bail.' },
  visit_template: { excluded: 'sans_client', why: 'Modèle de bon de visite.' },
  commune: { excluded: 'sans_client', why: 'Zone d\'une commune.' },
  price_zone: { excluded: 'sans_client', why: 'Zone des prix publics.' },
  price_version: { excluded: 'sans_client', why: 'Version des prix publics.' },
  page: { excluded: 'sans_client', why: 'Page publique.' },
  registry: { excluded: 'sans_client', why: 'Relecture du registre des traitements.' },
  rdv_rappel_: ENVOI('rappel de rendez-vous, `rdv_rappel_<sorte>:`'),
  vigilance_alert: { excluded: 'lcb_ft', why: 'Alerte de vigilance.' },
  business_vigilance: { excluded: 'lcb_ft', why: 'Alerte de vigilance d\'une cession de fonds.' },
  vault_piece: { excluded: 'lcb_ft', why: 'Pièce du coffre de la conformité.' },
  risk_sheet: { excluded: 'lcb_ft', why: 'Fiche de risque.' },
  baisse: { excluded: 'pas_un_sujet', why: 'Clé d\'une alerte du pilotage (pilotage_alerts), jamais un sujet du journal.' },
  budget_ia: { excluded: 'pas_un_sujet', why: 'Clé d\'une alerte du pilotage (pilotage_alerts), jamais un sujet du journal.' },
  remplace: { excluded: 'pas_un_sujet', why: 'Code d\'attente d\'une facture, rangé dans les données d\'un événement du dossier de vente.' },
  suspicion_report: { excluded: 'lcb_ft', why: 'Signalement au responsable.' },
  freeze_registry: { excluded: 'lcb_ft', why: 'Version du registre des gels.' },
  freeze_check: { excluded: 'lcb_ft', why: 'Contrôle du gel des avoirs.' },
  freeze_match: { excluded: 'lcb_ft', why: 'Correspondance au registre des gels.' },
};

export const CARTE_ACCES: Readonly<Record<string, AccessMapEntry>> = {
  // relation-clients
  persons: { locate: by('id') },
  person_name_corrections: { locate: by('person_id') },
  person_identifiers: { locate: by('person_id') },
  consents: { locate: by('person_id') },
  exclusions: { locate: by('person_id') },
  projects: { locate: by('person_id') },
  sources: { locate: by('person_id') },
  project_properties: { locate: [via('project_id', 'projects')] },
  person_merges: { locate: by('survivor_id', 'merged_id'), own: { survivor_id: [], merged_id: [] } },
  person_relations: { locate: by('person_id') },
  qualifications: { locate: by('person_id') },
  qualification_corrections: { locate: [via('qualification_id', 'qualifications')] },
  contact_scores: { locate: by('person_id') },
  attributions: { locate: by('person_id') },
  callback_tasks: { locate: by('person_id') },
  missed_promise_tasks: { locate: by('person_id') },
  call_notes: { locate: by('person_id') },
  agent_import_contacts: { locate: by('person_id') },
  agent_import_referrals: { locate: by('person_id') },
  agent_import_history: { locate: by('person_id') },
  agent_import_reminders: { locate: by('person_id') },
  agent_import_reminder_closures: { locate: [via('origin_key', 'agent_import_reminders', 'origin_key')] },
  // I05 : les exports bruts de H15, déposés par la direction pour la reprise ; le texte n'est rattaché à aucune fiche
  // (les fiches reprises, elles, sont lues par la carte). Gardés pour relancer la reprise, puis purgés par la procédure
  // d'effacement de la conformité : leurs morceaux s'effacent, la reprise refuse alors un dépôt incomplet.
  reprise_depots: out('non_rattachable', 'Dépôt d\'un export pour la reprise : sorte, taille, empreinte et date, aucun nom.'),
  reprise_depot_morceaux: out('non_rattachable', 'Texte brut d\'un export déposé pour la reprise, lu en entier par la reprise seule ; à purger une fois la reprise faite.'),
  // messages
  messages: { locate: by('person_id') },
  message_kinds: { locate: [via('message_id', 'messages')] },
  message_subjects: { locate: by('person_id') },
  send_log: { locate: by('person_id') },
  send_reservations: { locate: by('person_id') },
  inbound_messages: { locate: by('person_id') },
  reception_log: { locate: [via('inbound_id', 'inbound_messages')] },
  inbound_message_keys: { locate: [via('inbound_id', 'inbound_messages')] },
  virtual_tour_contacts: { locate: [via('inbound_id', 'inbound_messages')] },
  // Une note vocale se reconnaît au message reçu qu'elle est devenue : même réseau, même canal, même identifiant.
  voice_notes: { locate: [via('external_id', 'inbound_messages', 'external_id', { alsoMatch: { network_id: 'network_id', channel: 'channel' } })] },
  // HX21 : un appel se retrouve par sa fiche ; un appel masqué ne garde rien de personnel.
  calls: { locate: by('person_id') },
  // HX20 : les séquences de prospection d'une personne, et le texte écrit pour elle à chaque étape.
  prospecting_sequences: { locate: by('person_id') },
  prospecting_sequence_steps: { locate: [via('sequence_id', 'prospecting_sequences')] },
  call_journal: { locate: [via('call_id', 'calls')] },
  // HX22 : le passage de main de l'assistant vocal se retrouve par l'appel rangé.
  voice_assistant_calls: { locate: [via('call_row_id', 'calls')] },
  // HX24 : le passage d'un scénario, la place du message du jour et la tâche, rattachés à la fiche.
  automation_runs: { locate: by('person_id') },
  automation_daily_messages: { locate: by('person_id') },
  automation_tasks: { locate: by('person_id') },
  client_dates: { locate: by('person_id') },
  client_date_messages: { locate: by('person_id') },
  mailbox_mails: { locate: by('person_id') },
  mailbox_drafts: { locate: by('person_id') },
  agent_notifications: { locate: by('person_id') },
  agent_notification_settings: out('agent', 'Heures calmes et niveaux de notification d\'un agent : aucune donnée de client.'),
  agent_pushes: out('agent', 'Envoi au téléphone d\'un agent : des phrases fixes et des nombres, aucune donnée de client [R415].'),
  agent_push_sends: out('agent', 'Envoi au téléphone d\'un agent réservé par le contrôle central (SV15) : un identifiant et sa réponse, aucune donnée de client.'),
  agent_push_log: out('agent', 'Décisions du contrôle central sur les envois aux agents (SV15), sans texte ni donnée de client.'),
  mailbox_attachments: { locate: [via('project_id', 'projects')] },
  mailbox_attachment_links: { locate: [via('mail_id', 'mailbox_mails')] },
  client_date_texts: out('sans_client', 'Textes des messages de date écrits par la direction : aucune donnée de client.'),
  automation_scenarios: out('sans_client', 'Scénario composé par la direction : un déclencheur, une attente, un texte fixe, aucune donnée de client.'),
  automation_simulations: out('sans_client', 'Essai d\'un scénario sur le passé : des comptes, aucune personne.'),
  automation_switches: out('sans_client', 'Allumages et arrêts d\'un scénario par la direction.'),
  contact_keys: { locate: by('person_id') },
  attach_log: { locate: by('person_id') },
  conversation_handovers: { locate: by('person_id') },
  agent_alerts: { locate: by('person_id') },
  outbound_refs: { locate: [via('message_id', 'messages')] },
  // Une conversation se reconnaît à son réseau, son canal et sa référence.
  pending_human_replies: { locate: [via('conversation_ref', 'inbound_messages', 'conversation_ref', { alsoMatch: { network_id: 'network_id', channel: 'channel' } })] },
  legal_basis_checks: out('sans_client', 'Contrôle du plan du jour : des nombres par jour et par raison, aucune personne.'),
  // assistant-site
  assistant_sessions: out('non_rattachable', 'Empreinte de session d\'un visiteur du site, sans nom ni coordonnée.'),
  // estimation
  valuation_deliveries: { locate: by('person_id') },
  // L'avis de valeur : remis à la personne, ou fait sur le bien qu'elle a mis en vente ou qu'elle possède, même pas encore remis.
  valuation_reports: {
    locate: [
      via('id', 'valuation_deliveries', 'report_id'),
      via('property_id', 'mandates', 'property_id'),
      via('property_id', 'project_properties', 'property_id', { parentWhere: { role: 'owned' } }),
    ],
  },
  valuation_follow_ups: { locate: [via('report_id', 'valuation_reports')] },
  valuation_market_snapshots: { locate: [via('report_id', 'valuation_reports')] },
  value_tracking: { locate: by('person_id') },
  value_tracking_sends: { locate: [via('tracking_id', 'value_tracking')] },
  value_tracking_alerts: { locate: by('person_id') },
  old_contact_moments: { locate: by('person_id') },
  old_contact_followups: { locate: by('person_id') },
  // rendez-vous-visites
  appointments: { locate: by('person_id'), secrets: ['token_hash'] },
  appointment_holds: { locate: [via('appointment_id', 'appointments')] },
  appointment_calendar: { locate: [via('appointment_id', 'appointments')] },
  agenda_cursors: out('agent', 'Curseur de synchronisation de l\'agenda de l\'agent.'),
  appointment_reminders: { locate: [via('appointment_id', 'appointments')] },
  appointment_links: { locate: [via('appointment_id', 'appointments')], secrets: ['token_hash'] },
  appointment_briefs: { locate: [via('appointment_id', 'appointments')] },
  appointment_reports: { locate: [via('appointment_id', 'appointments')] },
  appointment_tasks: { locate: by('person_id') },
  // HX12 : ce qui est saisi pendant une visite, retrouvé par son rendez-vous.
  offline_ops: { locate: [via('appointment_id', 'appointments')] },
  visit_field_notes: { locate: [via('appointment_id', 'appointments')] },
  visit_photos: { locate: [via('appointment_id', 'appointments')] },
  visit_shot_skips: { locate: [via('appointment_id', 'appointments')] },
  presentation_ratings: { locate: [via('appointment_id', 'appointments')] },
  daily_plans: { locate: [{ json: 'items', idFields: ['personId', 'memberIds'], onlyMine: ['personId', 'memberIds'] }] },
  visits: { locate: by('person_id') },
  visit_energy_audit_handovers: { locate: by('person_id') },
  visit_slip_templates: out('sans_client', 'Modèle de bon de visite du réseau.'),
  visit_slips: { locate: [via('appointment_id', 'appointments')] },
  visit_dossiers: { locate: by('person_id'), secrets: ['token_hash'] },
  remote_visits: { locate: by('person_id') },
  remote_slip_signatures: { locate: [via('appointment_id', 'appointments')], secrets: ['token_hash', 'code_hash'] },
  visit_slip_signatures: { locate: [via('appointment_id', 'appointments')], secrets: ['token_hash', 'code_hash', 'copy_token_hash'] },
  visit_safety: { locate: [via('appointment_id', 'appointments')], secrets: ['code_hash'] },
  safety_alerts: { locate: [via('appointment_id', 'appointments')] },
  visit_reports: { locate: [via('appointment_id', 'appointments')] },
  visit_tasks: { locate: [via('appointment_id', 'appointments')] },
  // mandats-documents
  mandates: { locate: by('person_id') },
  mandate_register_settings: out('sans_client', 'Réglage de la numérotation du registre des mandats.'),
  proof_seals: out('sans_client', 'Comptes mensuels scellés, numéros du registre et empreintes : aucune personne n\'y est nommée.'),
  proof_publication_cache: out('sans_client', 'Copie recalculable du compte public, sans personne nommée.'),
  neighbourhood_campaigns: out('sans_client', 'Campagne de lettres d\'un agent : aucune personne nommée, seulement le centre du rayon.'),
  neighbourhood_letters: out('non_rattachable', 'Lettre adressée « Au propriétaire » ou « Aux habitants » d\'une adresse : rattachée à aucune fiche.'),
  service_commitments: out('sans_client', 'Engagement de service du réseau, rangé par la direction.'),
  mandate_source_costs: out('sans_client', 'Coût d\'une source de mandats saisi par la direction, sans client.'),
  mandate_source_decisions: out('sans_client', 'Décision de la direction sur une source de mandats, sans client.'),
  mandate_register: { locate: [via('mandate_id', 'mandates')] },
  document_templates: out('sans_client', 'Modèle de document du réseau.'),
  // Un mandat qui nomme plusieurs mandants (AU001) est, comme un bail, à plusieurs parties : la fiche de l'autre et le texte
  // qui les nomme tous ne sont jamais montrés, leur empreinte reste ; un mandat à un seul mandant est montré entier [R96].
  documents: { locate: [...by('person_id'), via('mandate_id', 'mandates'), via('id', 'document_co_mandants', 'document_id'), via('id', 'document_proxies', 'document_id')], foreignPersons: ['person_id'], shared: ['content'], sharedIf: CO_MANDANTS('id') },
  // AU001 : un autre mandant d'un mandat, par sa fiche.
  document_co_mandants: { locate: [...by('person_id')] },
  // AU059 : le mandant comme son représentant y trouvent la ligne qui les nomme.
  document_mandant_rights: { locate: [...by('person_id')] },
  document_proxies: { locate: [...by('mandant_person_id'), ...by('proxy_person_id')], foreignPersons: ['mandant_person_id', 'proxy_person_id'] },
  signature_session_proxies: { locate: [...by('mandant_person_id'), ...by('proxy_person_id')], foreignPersons: ['mandant_person_id', 'proxy_person_id'] },
  // AU002 : le domicile du mandant, par sa fiche ; la désignation du bien, par le bien.
  person_domiciles: { locate: by('person_id') },
  property_designations: { locate: [via('property_id', 'properties')] },
  property_positions: { locate: [via('property_id', 'properties')] },
  property_sanitation: { locate: [via('property_id', 'properties')] },
  fee_schedules: out('sans_client', 'Barème d\'honoraires du réseau.'),
  fee_schedule_tiers: out('sans_client', 'Tranches du barème d\'honoraires du réseau.'),
  identity_checks: { locate: by('person_id') },
  document_checks: { locate: [via('document_id', 'documents')] },
  mandate_clause_versions: out('sans_client', 'Texte d\'une clause du questionnaire de mandat, écrit par la direction.'),
  mandate_clause_validations: out('sans_client', 'Validation d\'un texte de clause par la conformité.'),
  mandate_price_gap_settings: out('sans_client', 'Écart de prix toléré, réglé par la direction.'),
  mandate_questionnaires: { locate: [...by('person_id'), via('document_id', 'documents')] },
  mandate_questionnaire_gap_acks: { locate: [via('questionnaire_id', 'mandate_questionnaires')] },
  signed_documents: { locate: [via('document_id', 'documents')], shared: ['copy_content'], sharedIf: CO_MANDANTS('document_id') },
  mandate_early_starts: { locate: [via('mandate_id', 'mandates')] },
  risk_statements: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  coownership_summaries: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  registered_letters: { locate: [...by('person_id'), via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  registered_letter_events: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  pre_contract_briefs: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  notary_drafts: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  notary_draft_differences: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  pre_contract_deposits: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  signature_circuits: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  signature_circuit_annexes: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  signature_circuit_signers: { locate: [...by('person_id'), via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  signature_circuit_events: { locate: [...by('person_id'), via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  mandate_withdrawals: { locate: [via('mandate_id', 'mandates')] },
  mandate_tasks: { locate: [via('mandate_id', 'mandates')] },
  signed_amendments: { locate: [via('document_id', 'documents')], shared: ['copy_content'], sharedIf: CO_MANDANTS('document_id') },
  // Un mandat à plusieurs mandants (AU001) : la session d'un autre signataire vient avec le document ; son tracé et sa
  // fiche ne sont jamais montrés [R96].
  signature_sessions: { locate: [...by('signer_person_id'), via('document_id', 'documents')], secrets: ['code_hash'], shared: ['drawing_hash', 'copy_content'], sharedIf: CO_MANDANTS('document_id'), foreignPersons: ['signer_person_id'] },
  // AU003 : le dossier de preuve et l'exemplaire remis, par le document ; la remise, par la fiche du mandant.
  signature_dossiers: { locate: [via('document_id', 'documents')], shared: ['copy_content'], sharedIf: CO_MANDANTS('document_id') },
  signature_remises: { locate: [...by('person_id'), via('document_id', 'documents')] },
  signature_validations: out('sans_client', 'Validation du format du dossier de preuve par l\'avocat du réseau.'),
  // biens-annonces : les biens de la personne, par son mandat, son projet ou sa mise en location.
  properties: { locate: [via('id', 'mandates', 'property_id'), via('id', 'project_properties', 'property_id'), via('id', 'rental_listings', 'property_id')] },
  property_links: { locate: [via('property_id', 'properties')] },
  property_details: { locate: [via('property_id', 'properties')] },
  property_sheets: { locate: [via('property_id', 'properties')] },
  listing_settings: out('sans_client', 'Réglage des annonces du réseau (numéro de carte professionnelle).'),
  card_holders: out('sans_client', 'Titulaire de la carte professionnelle du réseau.'),
  agent_title_settings: out('sans_client', 'Titre écrit à côté du nom des agents, réglé par la direction.'),
  site_legal_mentions: out('sans_client', 'Mentions légales du site, réglées par la direction.'),
  listing_drafts: { locate: [via('property_id', 'properties')] },
  listing_validations: { locate: [via('property_id', 'properties')] },
  listing_translations: { locate: [via('property_id', 'properties')] },
  listing_translation_validations: { locate: [via('property_id', 'properties')] },
  translation_reviewers: { locate: [via('property_id', 'properties')] },
  listing_versions: { locate: [via('property_id', 'properties')] },
  listing_version_media_sheets: { locate: [via('version_id', 'listing_versions')] },
  video_text_checks: { locate: [via('property_id', 'properties')] },
  agent_import_properties: { locate: [via('property_id', 'properties')] },
  agent_import_property_pieces: { locate: [via('property_id', 'properties')] },
  agent_import_property_addresses: { locate: [via('property_id', 'properties')] },
  // acquereurs
  buyer_searches: { locate: by('person_id') },
  buyer_search_confirmations: { locate: [via('project_id', 'projects')] },
  buyer_search_areas: { locate: [via('project_id', 'projects')] },
  phrase_searches: { locate: [via('project_id', 'projects')] },
  property_alerts: { locate: by('person_id') },
  alert_unsubscribe_tokens: { locate: by('person_id'), secrets: ['token_hash'] },
  ad_campaigns: out('sans_client', 'Campagnes de publicité payante (HX54) : une plateforme, un nom, des communes et un rayon ; aucune personne.'),
  ad_campaign_approvals: out('sans_client', 'Validations de la direction d\'une campagne (HX54) : budgets et seuil ; aucune personne.'),
  ad_campaign_starts: out('sans_client', 'Lancements d\'une campagne (HX54), en essai : aucune personne.'),
  ad_campaign_stops: out('sans_client', 'Arrêts d\'une campagne (HX54) : motif, dépense et nombre de contacts ; aucune personne.'),
  ad_campaign_spend: out('sans_client', 'Dépense d\'une campagne par jour, lue chez la plateforme (HX54) : aucune personne.'),
  ad_campaign_repauses: out('sans_client', 'Pauses redemandées d\'une campagne (HX54) : aucune personne.'),
  ad_campaign_launches: out('sans_client', 'Réponses des plateformes aux lancements d\'une campagne (HX54) : aucune personne.'),
  ad_campaign_contacts: { locate: by('person_id') },
  newsletter_editions: out('sans_client', 'Éditions de la lettre d\'information (HX53) : un titre, la direction qui l\'ouvre ; aucune personne.'),
  newsletter_letters: { locate: by('person_id') },
  newsletter_unsubscribe_tokens: { locate: by('person_id'), secrets: ['token_hash'] },
  agent_whatsapp_alerts: { locate: by('person_id') },
  weekly_points: { locate: by('person_id') },
  // offres-dossiers-vente : l'acquéreur par son offre ; le vendeur voit son dossier de vente sans l'acquéreur.
  // Les coacquéreurs (AU009) : leurs fiches ne sont pas montrées à l'acquéreur en tête qui demande ses données.
  // Un coacquéreur trouve l'offre par son lien ; la fiche de l'acquéreur en tête et la liste des autres lui sont masquées.
  offer_co_buyers: { locate: by('person_id') },
  offer_buyer_shares: { locate: by('buyer_person_id') },
  offer_register: { locate: [...by('buyer_person_id'), via('id', 'offer_co_buyers', 'offer_id', { tag: 'coacquereur' })], own: { buyer_person_id: [] }, shared: ['co_buyers'] },
  // Ce qui suit l'offre est rendu à l'acquéreur en tête seul : son contrôle porte son identité ; un coacquéreur reçoit
  // l'offre et l'avancée du dossier, jamais le contrôle ni les échanges de l'autre (AU009) [R96].
  offer_checks: { locate: [via('offer_id', 'offer_register', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  offer_transmissions: { locate: [via('offer_id', 'offer_register', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  offer_responses: { locate: [via('offer_id', 'offer_register', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  offer_untransmitted_alerts: { locate: [via('offer_id', 'offer_register', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  offer_tasks: { locate: [via('offer_id', 'offer_register', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  offer_proposals: { locate: [via('offer_id', 'offer_register', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  proposal_transmissions: { locate: [via('proposal_id', 'offer_proposals')] },
  proposal_responses: { locate: [via('proposal_id', 'offer_proposals')] },
  proposal_tasks: { locate: [via('proposal_id', 'offer_proposals')] },
  // Le vendeur d'un dossier est celui rangé à son ouverture, jamais tout mandant passé ou futur du bien.
  sale_file_sellers: { locate: by('person_id') },
  sale_files: { locate: [...by('buyer_person_id'), via('id', 'sale_file_sellers', 'file_id', { tag: 'vendeur' }), via('offer_id', 'offer_register', 'id', { onlyMatchedBy: 'coacquereur', tag: 'coacquereur' })], own: { buyer_person_id: ['offer_id'] } },
  // L'avancée du dossier (étapes, dates, acte) est aussi celle du coacquéreur ; le reste du dossier ne lui est pas rendu (AU009).
  sale_file_steps: { locate: [via('file_id', 'sale_files')] },
  sale_file_pieces: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  // La notification de l'acquéreur en tête est à lui : un coacquéreur reçoit les dates partagées, et la sienne par
  // `sale_file_buyer_notices` (AU009) [R96].
  sale_file_dates: {
    locate: [
      via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' }),
      via('file_id', 'sale_files', 'id', { onlyMatchedBy: 'coacquereur', except: { kind: ['notification_acquereur'] } }),
    ],
  },
  // La notification d'un coacquéreur est la sienne (AU009).
  sale_file_buyer_notices: { locate: by('person_id') },
  sale_file_tasks: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  // Les conditions suspensives du dossier et leurs alertes (AU082).
  sale_file_conditions: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  sale_file_condition_tasks: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  sale_file_reminders: { locate: by('person_id') },
  // Le financement est celui de l'acquéreur : le vendeur ne le voit pas.
  sale_file_financing: { locate: [via('file_id', 'sale_files', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  sale_file_financing_alerts: { locate: [via('file_id', 'sale_files', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  sale_file_fund_alerts: { locate: by('person_id') },
  sale_file_closings: { locate: [via('file_id', 'sale_files')] },
  sale_file_stops: { locate: [via('file_id', 'sale_files', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  // apres-vente
  referrals: {
    locate: by('referrer_id', 'referred_id'),
    own: { referrer_id: [], referred_id: ['first_name', 'project_id', 'callable', 'call_due_at', 'call_done_at'] },
  },
  // Recommandations des partenaires (G08) : à la personne recommandée.
  partner_recommendations: { locate: by('referred_id') },
  partner_recommendation_submissions: out('partenaire', 'Date d\'un envoi d\'un partenaire, sans personne.'),
  partner_recommendation_race_guard: out('partenaire', 'Garde d\'un lot, toujours vide, sans personne.'),
  partner_recommendation_withheld: { locate: [via('recommendation_id', 'partner_recommendations')], secrets: ['identifier_sha256'] },
  review_requests: { locate: by('person_id') },
  after_sale_tasks: { locate: [via('file_id', 'sale_files', 'id', { notOnlyBy: 'coacquereur' })] },
  after_sale_choices: { locate: by('person_id') },
  after_sale_reminders: { locate: by('person_id') },
  after_sale_unsubscribe_tokens: { locate: by('person_id'), secrets: ['token_hash'] },
  satisfaction_tokens: { locate: by('person_id'), secrets: ['token_hash'] },
  satisfaction_answers: { locate: by('person_id') },
  verified_review_invites: { locate: by('person_id'), secrets: ['token_hash'] },
  verified_reviews: { locate: by('person_id') },
  thank_you_tasks: { locate: by('person_id') },
  owner_booklets: { locate: by('person_id') },
  owner_booklet_links: { locate: by('person_id'), secrets: ['token_hash'] },
  referral_requests: out('non_rattachable', 'Clé de rejeu d\'une requête de l\'API, rangée sous son empreinte : la recommandation qu\'elle a créée est lue dans referrals.'),
  // commissions-factures
  sale_commissions: out('agent', 'Honoraires et rémunération de l\'agent.'),
  commission_grids: out('sans_client', 'Grille de rémunération des agents.'),
  commission_grid_tiers: out('sans_client', 'Paliers de la grille de rémunération des agents.'),
  commission_tier_picks: out('agent', 'Palier retenu pour la rémunération d’une vente.'),
  commissions: out('agent', 'Rémunération de l\'agent.'),
  commission_shares: out('agent', 'Partage de la rémunération entre agents.'),
  custom_reports: out('agent', 'Rapports sur mesure enregistrés par un agent ou la direction (HX62) : des mesures et un regroupement, aucun client.'),
  mcp_drafts: { locate: by('person_id') },
  complaints: { locate: by('person_id') },
  complaint_answers: { locate: [via('complaint_id', 'complaints')] },
  complaint_alerts: { locate: [via('complaint_id', 'complaints')] },
  complaint_mediator_offers: { locate: [via('complaint_id', 'complaints')] },
  complaint_settings: out('sans_client', 'Réglage du délai de réponse et du médiateur du réseau (HX58) : aucun client.'),
  security_devices: out('agent', 'Clés d\'accès des appareils des utilisateurs du réseau (HX56) : aucun client.'),
  security_challenges: out('agent', 'Défis envoyés aux appareils des utilisateurs du réseau (HX56) : aucun client ; l\'objet d\'une action sensible n\'est qu\'un identifiant.'),
  security_sessions: out('agent', 'Séances ouvertes par la clé d\'un appareil (HX56) : aucun client.'),
  security_step_ups: out('agent', 'Preuves du second facteur des utilisateurs du réseau (HX56) : aucun client ; l\'objet n\'est qu\'un identifiant.'),
  agent_export_authorizations: out('agent', 'Autorisation d\'un export de reprise d\'un agent (AU110) : périmètre, contrat, durée, aucun client.'),
  agent_exports: out('agent', 'Empreinte d\'un export complet remis à un agent (HX62) : jamais le contenu, aucun client.'),
  agent_exit_accesses: out('agent', 'Accès de sortie d\'un agent parti (AU111) : l\'empreinte du lien et sa durée, aucun client.'),
  agent_exit_access_revocations: out('agent', 'Retrait d\'un accès de sortie d\'agent (AU111) : qui et quand, aucun client.'),
  commission_steps: out('agent', 'Étapes du paiement de la rémunération de l\'agent.'),
  invoice_drafts: { locate: by('recipient_person_id') },
  invoices: { locate: [via('draft_id', 'invoice_drafts')] },
  invoice_transmissions: { locate: [via('invoice_id', 'invoices')] },
  invoice_facturx: { locate: [via('invoice_id', 'invoices')] },
  invoice_transmission_claims: { locate: [via('invoice_id', 'invoices')] },
  invoice_real_numbers: { locate: [via('invoice_id', 'invoices')] },
  invoice_real_deposits: { locate: [via('invoice_id', 'invoices')] },
  invoice_real_statuses: { locate: [via('invoice_id', 'invoices')] },
  commission_receipts: out('agent', 'Encaissement des honoraires par le réseau.'),
  // HX49 : les factures fournisseurs et le relevé de la banque du réseau ne portent aucune donnée d'un client (le
  // libellé du relevé n'est pas gardé) ; le rapprochement suit la facture du client, la relance est à son destinataire.
  supplier_invoice_reads: out('sans_client', 'Lecture d\'une facture d\'un fournisseur du réseau.'),
  supplier_invoices: out('sans_client', 'Facture d\'un fournisseur du réseau.'),
  bank_lines: out('non_rattachable', 'Ligne du relevé de banque du réseau : un jour, un montant, une empreinte, sans libellé.'),
  bank_reconciliations: { locate: [via('invoice_id', 'invoices')] },
  invoice_reminders: { locate: by('person_id') },
  agent_cost_assignments: out('sans_client', 'Poste d\'une facture d\'un fournisseur du réseau, dit par la direction (HX65).'),
  agent_cost_settings: out('sans_client', 'Réglages du coût complet de l\'agent moyen, par la direction (HX65).'),
  commission_payouts: out('agent', 'Reversement à l\'agent.'),
  commission_payout_alerts: out('agent', 'Alerte de reversement à l\'agent.'),
  // pilotage
  morning_reports: out('sans_client', 'Rapport du matin de la direction : des nombres, aucune personne.'),
  pilotage_settings: out('sans_client', 'Réglage du pilotage.'),
  pilotage_alerts: out('sans_client', 'Alerte de pilotage sur des nombres du réseau.'),
  // recrutement
  candidates: out('candidat', 'Candidat au réseau.'),
  recruiting_answers: out('sans_client', 'Réponses types du recrutement.'),
  candidate_replies: out('candidat', 'Réponses préparées pour un candidat.'),
  recruiting_tasks: out('candidat', 'Tâches du recrutement.'),
  candidate_interviews: out('candidat', 'Entretiens de recrutement.'),
  candidate_interview_outcomes: out('candidat', 'Issue des entretiens.'),
  candidate_decisions: out('candidat', 'Décisions de recrutement.'),
  recruiting_contents: out('sans_client', 'Vidéos et épisodes du recrutement, rangés par la direction (HX64).'),
  recruiting_commune_decisions: out('sans_client', 'Communes ouvertes au recrutement par la direction (HX68) : un nom de commune, aucune personne.'),
  recruiting_content_withdrawals: out('sans_client', 'Retrait d\'une vidéo ou d\'un épisode du recrutement.'),
  candidate_content_origins: out('candidat', 'Contenu d\'origine d\'une candidature.'),
  // agents-reseau
  networks: out('sans_client', 'Le réseau lui-même.'),
  agents: out('agent', 'Fiche de l\'agent.'),
  access_invitations: out('agent', 'Invitation d\'accès d\'un agent.'),
  access_keys: out('agent', 'Clé d\'accès d\'un utilisateur du réseau.'),
  assistant_keys: out('agent', 'Clé que l\'agent confie à son assistant pour le serveur MCP (BR09) : empreinte seule.'),
  agent_zones: out('agent', 'Communes de l\'agent.'),
  agent_availabilities: out('agent', 'Disponibilités de l\'agent.'),
  agent_public_cards: out('agent', 'Carte publique de l\'agent.'),
  agent_language_declarations: out('agent', 'Langues que l\'agent déclare parler.'),
  // HX31 : les écrans de vitrine, sans donnée d'un client.
  vitrine_screens: out('agent', 'Écran de vitrine du réseau ou d\'un agent.'),
  vitrine_screen_switches: out('sans_client', 'Allumage ou extinction d\'un écran de vitrine.'),
  // HX38 : la diffusion surveillée d'un bien, trouvée par le bien de la personne.
  diffusion_portal_settings: out('sans_client', 'Réglage d\'un portail par la direction : son domaine et les champs qu\'il exige.'),
  diffusion_portal_choices: { locate: [via('property_id', 'properties')] },
  diffusion_portal_suspensions: { locate: [via('property_id', 'properties')] },
  diffusion_portal_resumptions: { locate: [via('suspension_id', 'diffusion_portal_suspensions')] },
  diffusion_portal_feedback: { locate: [via('property_id', 'properties')] },
  diffusion_portal_checks: { locate: [via('property_id', 'properties')] },
  diffusion_portal_tasks: out('agent', 'Tâche de correction de l\'agent du bien, quand un portail rejette ou montre un écart.'),
  diffusion_portal_task_closures: out('agent', 'Fermeture d\'une tâche de correction de l\'agent.'),
  diffusion_portal_texts: { locate: [via('property_id', 'properties')] },
  diffusion_portal_text_validations: { locate: [via('text_id', 'diffusion_portal_texts')] },
  diffusion_photo_subjects: { locate: [via('property_id', 'properties')] },
  diffusion_photo_descriptions: { locate: [via('property_id', 'properties')] },
  // HX07 : la boutique de l'agent, sans donnée d'un client.
  shop_tariffs: out('sans_client', 'Tarifs des supports imprimés, depuis le devis d\'un imprimeur.'),
  shop_orders: out('agent', 'Commande de supports de l\'agent : l\'annonce publiée et sa carte professionnelle.'),
  shop_order_validations: out('agent', 'Validation d\'une commande par l\'agent.'),
  shop_order_sends: out('sans_client', 'Envoi réservé d\'une commande à l\'imprimeur.'),
  shop_order_results: out('sans_client', 'Réponse de l\'imprimeur à une commande.'),
  // HX08 : les remises négociées, sans donnée d'un client.
  network_discounts: out('sans_client', 'Remise négociée par la direction auprès d\'un fournisseur.'),
  network_discount_withdrawals: out('sans_client', 'Retrait d\'une remise par la direction.'),
  network_discount_dismissals: out('agent', 'Remise écartée par l\'agent pour un bien.'),
  // HX09 : les actualités du réseau, sans donnée d'un client.
  network_news: out('sans_client', 'Actualité juridique ou de marché rangée par la direction, avec sa source publique.'),
  network_news_withdrawals: out('sans_client', 'Retrait d\'une actualité par la direction.'),
  network_news_deliveries: out('agent', 'Actualité montrée une fois à un agent.'),
  // HX10 : les clés des biens, sans donnée d'un client.
  property_keys: out('sans_client', 'Trousseau d\'un bien rangé dans l\'armoire de l\'agence, avec son numéro.'),
  property_key_loans: out('agent', 'Sortie d\'un trousseau : l\'agent qui l\'a, depuis quand, pour quoi.'),
  property_key_returns: out('agent', 'Retour d\'un trousseau à l\'armoire.'),
  property_key_retirements: out('sans_client', 'Trousseau rendu au propriétaire ou perdu.'),
  property_key_partner_loans: out('agent', 'Remise d\'un trousseau à un partenaire de l\'annuaire : à qui, pour quoi, jusqu\'à quand, l\'agent qui en répond.'),
  property_key_partner_returns: out('agent', 'Retour d\'un trousseau remis à un partenaire.'),
  // HX14 : le stock de panneaux. L'adresse d'une pose est celle du bien : trouvée par le bien de la personne.
  signs: out('sans_client', 'Panneau du stock du réseau, avec son numéro et son format.'),
  sign_placements: { locate: [via('property_id', 'properties')] },
  sign_removals: out('agent', 'Panneau récupéré ou perdu, noté par l\'agent ou la direction.'),
  sign_pickup_tasks: out('agent', 'Tâche « récupérer le panneau » de l\'agent de la pose.'),
  // HX15 : les vues du site, sans rien d'un visiteur.
  site_page_views: out('non_rattachable', 'Nombre de vues d\'un contenu public par jour : aucune donnée d\'un visiteur.'),
  // HX16 : la veille des diagnostics énergétiques publiés ; le logement, jamais son propriétaire, qui n'est pas cherché.
  dpe_watch_sectors: out('agent', 'Secteur de veille de l\'agent : une commune de ses zones et son code postal.'),
  dpe_watch_stops: out('agent', 'Fin d\'un secteur de veille de l\'agent.'),
  dpe_diagnoses: out('non_rattachable', 'Diagnostic publié par l\'ADEME : le logement et son adresse, aucun propriétaire, jamais cherché.'),
  dpe_alert_items: out('agent', 'Ligne de l\'alerte du jour d\'un secteur de veille de l\'agent.'),
  dpe_letters: out('non_rattachable', 'Lettre « Au propriétaire » d\'un logement classé F ou G, sans nom, écrite par le code.'),
  // HX17 : le score de vente d'une adresse, tiré de données publiques ; jamais son propriétaire, qui n'est pas cherché.
  address_scores: out('non_rattachable', 'Score de vente d\'une adresse : ses points publics sourcés et datés, aucun propriétaire.'),
  address_score_mandates: out('non_rattachable', 'Mandat signé relié à une adresse notée, pour mesurer le score.'),
  // HX11 : la pige des annonces de particuliers, sans nom, numéro, mail ni texte de l'annonce.
  pige_no_agency: out('sans_client', 'Empreinte d\'un bien vu « pas d\'agence » : il n\'entre jamais dans la file.'),
  pige_ads: out('sans_client', 'Annonce de particulier : le bien sans adresse et sa source, jamais le particulier.'),
  pige_oppositions: out('sans_client', 'Bien de pige fermé après un non du particulier, par son empreinte.'),
  pige_drafts: out('agent', 'Premier message de pige préparé pour l\'agent de la zone.'),
  pige_handovers: out('agent', 'Message de pige validé et remis à l\'agent, à coller lui-même.'),
  // HX18 : l'adresse probable d'une annonce de pige, tirée des diagnostics publiés ; jamais le particulier.
  pige_ad_sightings: out('sans_client', 'Jour où une annonce de particulier est vue en ligne : son site et sa référence, jamais le particulier.'),
  pige_ad_energy: out('sans_client', 'Classe énergie et date du diagnostic dites par une annonce de particulier.'),
  pige_address_proposals: out('agent', 'Adresses probables d\'une annonce, tirées des diagnostics publiés, pour l\'agent de la zone.'),
  pige_property_keys: out('sans_client', 'Empreinte reliée à un bien créé depuis la pige : un seul bien par bien de pige.'),
  pige_properties: { locate: [via('property_id', 'properties')] },
  voice_assistant_lines: out('agent', 'Ligne de l\'assistant vocal : le numéro de l\'agent, rien d\'un client.'),
  agent_legal_mentions: out('agent', 'Mentions légales de l\'agent : statut et immatriculation.'),
  agent_review_links: out('agent', 'Lien d\'avis de l\'agent.'),
  agent_onboardings: out('agent', 'Intégration de l\'agent.'),
  agent_time_saved: out('agent', 'Temps gagné déclaré par l\'agent : aucune donnée de client.'),
  agent_file_pieces: out('agent', 'Dossier de l\'agent.'),
  agent_file_alerts: out('agent', 'Alertes du dossier de l\'agent.'),
  academy_modules: out('sans_client', 'Modules de l\'académie.'),
  academy_completions: out('agent', 'Formation de l\'agent.'),
  academy_sessions: out('sans_client', 'Sessions de l\'académie.'),
  academy_attendance: out('agent', 'Présence de l\'agent en formation.'),
  academy_alerts: out('agent', 'Alertes de formation de l\'agent.'),
  quiz_questions: out('sans_client', 'Questions de formation des agents (HX63).'),
  quiz_attempts: out('agent', 'Quiz de formation de l\'agent, réponses lues par lui seul (HX63).'),
  quiz_attestations: out('agent', 'Attestations de formation de l\'agent (HX63).'),
  academy_prior_entries: out('agent', 'Cycle de formation de l\'agent avant son arrivée (AU028).'),
  sandbox_runs: out('agent', 'Bac à sable de l\'agent, sur des clients inventés.'),
  sandbox_steps: out('agent', 'Étapes du bac à sable de l\'agent.'),
  training_cases: out('sans_client', 'Cas d\'entraînement inventés.'),
  training_sessions: out('agent', 'Entraînement de l\'agent.'),
  training_turns: out('agent', 'Échanges d\'entraînement de l\'agent, sur des cas inventés.'),
  agent_referents: out('agent', 'Référent de l\'agent.'),
  agent_pairs: out('agent', 'Binômes d\'agents.'),
  agent_absences: out('agent', 'Absences de l\'agent.'),
  assistance_requests: out('agent', 'Questions de l\'agent à la direction.'),
  assistance_alerts: out('agent', 'Alertes des questions de l\'agent.'),
  sponsorships: out('agent', 'Parrainage entre agents.'),
  referral_settings: out('sans_client', 'Réglage du parrainage entre agents.'),
  agent_departures: out('agent', 'Départ de l\'agent.'),
  pilot_agents: out('agent', 'Désignation d\'un agent pilote par la direction (HX69).'),
  pilot_before_declarations: out('agent', 'Mandats signés par un agent pilote avant son arrivée, dits par la direction avec leur preuve (HX69).'),
  phase1_outside_sends: out('sans_client', 'Envoi hors règles constaté hors d\'AIMMO, rangé par la direction avec sa preuve (HX70).'),
  phase1_app_inventories: out('sans_client', 'Tâches encore planifiées dans les applications, dites par la direction avec leur preuve (HX70).'),
  phase_openings: out('agent', 'Ouverture d\'une phase de la Feuille de route par la direction (HX71).'),
  region_decisions: out('sans_client', 'Régions ouvertes ou fermées par la direction (HX72) : un code de région, aucune personne.'),
  licence_tariffs: out('sans_client', 'Tarif de la licence du logiciel, un seul pour toutes les agences (HX73) : un prix, aucune personne.'),
  software_licences: out('sans_client', 'Licence du logiciel donnée à une agence hors réseau (HX73) : une entreprise, jamais un client.'),
  licence_states: out('sans_client', 'État d\'une licence du logiciel (HX73) : une entreprise, jamais un client.'),
  licence_data_exports: out('sans_client', 'Empreinte et comptes d\'un fichier de reprise remis à une agence sous licence (HX74) : jamais le contenu, aucun client.'),
  agent_departure_handovers: { locate: [{ column: 'subject_id', where: { kind: 'person' } }, via('subject_id', 'projects', 'id', { where: { kind: 'project' } }), via('subject_id', 'properties', 'id', { where: { kind: 'property' } })] },
  agent_departure_reassignments: { locate: [{ column: 'subject_id', where: { kind: 'person' } }, via('subject_id', 'projects', 'id', { where: { kind: 'project' } }), via('subject_id', 'properties', 'id', { where: { kind: 'property' } })] },
  // conformite-lcb-ft : ses tables sont écartées toutes ensemble, depuis le registre (`LCB_FT_EXCLUSIONS`), sans être
  // nommées ici : seul le code de la conformité lit le coffre, la vigilance et les signalements.
  ...LCB_FT_EXCLUSIONS,
  // partenaires : les mises en relation du client, par son projet.
  partners: out('partenaire', 'Fiche du partenaire.'),
  partner_zones: out('partenaire', 'Zones du partenaire.'),
  // HX01 : le partage d'un bien avec une agence partenaire ne porte aucune personne ; un relevé porte les honoraires
  // d'un dossier, déjà rendus par la commission du dossier.
  partner_agencies: out('partenaire', 'Une agence partenaire, un professionnel.'),
  agency_shares: out('partenaire', 'Un bien partagé avec une agence.'),
  agency_delegations: out('partenaire', 'Le bon de délégation entre agences.'),
  agency_delegation_steps: out('partenaire', 'Accord et signature du bon de délégation.'),
  agency_visits: out('partenaire', 'Co-visite demandée par une agence.'),
  agency_visits_done: out('partenaire', 'Co-visite faite.'),
  agency_delegation_files: out('partenaire', 'Dossier de vente rattaché à une délégation.'),
  agency_fee_statements: out('partenaire', 'Relevé du partage d\'honoraires entre agences.'),
  agency_partner_invoices: out('partenaire', 'Facture de rétrocession reçue d\'une agence.'),
  commission_agency_shares: out('partenaire', 'Part d\'une agence partenaire sur une commission.'),
  partner_credentials: out('partenaire', 'Justificatifs du partenaire.'),
  partner_credential_alerts: out('partenaire', 'Alertes des justificatifs du partenaire.'),
  local_hazard_orders: out('sans_client', 'Lecture d\'un arrêté local par commune (termites, mérule), sans client.'),
  partner_credential_mentions: out('partenaire', 'Mention audit énergétique d\'une certification du partenaire.'),
  partner_referrals: { locate: [via('project_id', 'projects')] },
  partner_referral_options: { locate: [via('referral_id', 'partner_referrals')] },
  partner_referral_steps: { locate: [via('referral_id', 'partner_referrals')] },
  partner_referral_fees: { locate: [via('referral_id', 'partner_referrals')] },
  partner_referral_disclosures: { locate: [via('referral_id', 'partner_referrals')] },
  partner_documents: { locate: [via('referral_id', 'partner_referrals')] },
  partner_followups: { locate: [via('referral_id', 'partner_referrals')] },
  partner_reviews: { locate: [via('referral_id', 'partner_referrals')] },
  partner_review_reads: out('agent', 'Lecture d\'un avis par un membre du réseau.'),
  partner_prospects: out('partenaire', 'Futur partenaire, adresse professionnelle.'),
  partner_prospect_mails: out('partenaire', 'Mails préparés pour un futur partenaire.'),
  partner_prospect_optouts: out('partenaire', 'Opposition d\'un futur partenaire.'),
  partner_addresses: out('partenaire', 'Adresse professionnelle et accord du partenaire.'),
  partner_optouts: out('partenaire', 'Opposition d\'un partenaire.'),
  pro_sends: out('partenaire', 'Envois aux partenaires et futurs partenaires.'),
  pro_send_log: out('partenaire', 'Décisions des envois aux professionnels, sans adresse.'),
  // preuves-et-registre : le journal de la personne et de ses dossiers, sans la lutte contre le blanchiment.
  journal: {
    locate: [
      { column: 'subject', prefix: 'person:' },
      via('subject', 'mandates', 'id', { prefix: 'mandate:' }),
      via('subject', 'documents', 'id', { prefix: 'document:' }),
      via('subject', 'offer_register', 'id', { prefix: 'offer:', onlyMatchedBy: 'buyer_person_id' }),
      // Le dossier de vente : chaque sorte d'événement à la partie que dit SALE_FILE_EVENTS, jamais par défaut.
      via('subject', 'sale_files', 'id', { prefix: 'sale_file:', onlyMatchedBy: 'buyer_person_id', only: { type: saleFileTypes('partage', 'acquereur') } }),
      via('subject', 'sale_files', 'id', { prefix: 'sale_file:', onlyMatchedBy: 'vendeur', only: { type: saleFileTypes('partage') } }),
      // Un coacquéreur (AU009) suit l'avancée partagée du dossier ; ce qui n'est qu'à l'acquéreur en tête (son financement) reste à lui.
      via('subject', 'sale_files', 'id', { prefix: 'sale_file:', onlyMatchedBy: 'coacquereur', only: { type: saleFileTypes('partage') }, jsonNot: { kind: 'notification_acquereur' } }),
      // Sa propre notification, qui porte sa fiche (`person`).
      via('data', 'persons', 'id', { prefix: 'person:', jsonPath: 'person', startsWith: { subject: 'sale_file:' }, only: { type: ['dossier.date'] } }),
      // Ce qui est fait pour un seul client du dossier porte sa fiche : à lui seul, même si le bien a eu d'autres mandants.
      via('data', 'persons', 'id', { prefix: 'person:', jsonPath: 'client', startsWith: { subject: 'sale_file:' }, only: { type: saleFileTypes('client') } }),
      via('subject', 'appointments', 'id', { prefix: 'appointment:' }),
      via('subject', 'appointments', 'id', { prefix: 'visit:' }),
      via('subject', 'rental_applications', 'id', { prefix: 'rental_application:' }),
      // AU097 · l'ajout ou le retrait d'un colocataire nomme sa ligne : il est aussi au colocataire concerné, à lui seul.
      via('data', 'rental_cotenant_changes', 'id', { jsonPath: 'change', startsWith: { subject: 'rental_application:', type: 'location.colocataire' } }),
      // Le journal du logement est au propriétaire, sauf l'arrivée d'une candidature, qui est au candidat (ci-dessous).
      // Les événements d'une session de signature du bail sont à qui signe (le propriétaire reçoit les siens par sa
      // propre session, ci-dessous), jamais à l'autre partie.
      // Ce qui est fait par le locataire en tant que partie (sa signature de l'état des lieux, son exemplaire du bail)
      // est au locataire seul.
      via('subject', 'rental_listings', 'id', { prefix: 'rental:', except: { type: ['location.candidature', 'location.signature_ouverte', 'location.signature_essai'] }, jsonNot: { party: ['locataire', 'colocataire'] } }),
      // Au journal du logement, ce qui nomme une candidature est au candidat, et ce qui nomme une session de
      // signature du bail est à qui signe.
      via('data', 'rental_applications', 'id', { prefix: 'rental_application:', jsonPath: 'application', startsWith: { subject: 'rental:' } }),
      via('data', 'rental_lease_signatures', 'id', { jsonPath: 'session', startsWith: { subject: 'rental:' } }),
      // AU097 · la signature d'un colocataire : ses événements sont à lui seul.
      via('data', 'rental_lease_cotenant_signatures', 'id', { jsonPath: 'session', startsWith: { subject: 'rental:' } }),
      // L'état des lieux du locataire, retrouvé par son bail : le logement et la version au journal, jamais ce que le
      // propriétaire y a signé ; son exemplaire du bail, par l'empreinte de l'exemplaire.
      via('data', 'rental_inventories', 'version', { jsonPath: 'version', onlyMatchedBy: 'locataire', startsWith: { subject: 'rental:', type: 'location.etat_des_lieux' }, alsoMatch: { subject: 'listing_id' }, alsoMatchPrefix: { subject: 'rental:' }, jsonNot: { party: 'bailleur' } }),
      // L'avis d'exemplaire d'un colocataire nomme sa session : il est à lui seul, jamais au locataire ni au bailleur (AU097).
      via('data', 'rental_lease_copies', 'content_sha256', { jsonPath: 'copy', onlyMatchedBy: 'locataire', startsWith: { subject: 'rental:', type: 'location.bail_exemplaire' }, jsonNot: { party: ['bailleur', 'colocataire'] } }),
      via('subject', 'person_requests', 'id', { prefix: 'person_request:' }),
      via('subject', 'prospect_retention_cycles', 'id', { prefix: 'prospect_retention:' }),
      // Le journal d'un bien n'est qu'à qui le possède : par son mandat, son projet (bien possédé) ou sa mise en
      // location ; jamais à l'acquéreur qui s'y intéresse.
      // Les offres et l'ouverture du dossier nomment l'offre de l'acquéreur : elles ne sont pas au journal du possesseur.
      via('subject', 'mandates', 'property_id', { prefix: 'property:', except: { type: PROPERTY_OFFER_EVENTS } }),
      via('subject', 'project_properties', 'property_id', { prefix: 'property:', parentWhere: { role: 'owned' }, except: { type: PROPERTY_OFFER_EVENTS } }),
      via('subject', 'rental_listings', 'property_id', { prefix: 'property:', except: { type: PROPERTY_OFFER_EVENTS } }),
      via('subject', 'projects', 'id', { prefix: 'project:' }),
      via('subject', 'partner_referrals', 'id', { prefix: 'referral:' }),
      via('subject', 'signature_sessions', 'id', { prefix: 'signature:' }),
      // Le reçu d'équité d'un candidat, au journal de la présentation, est au candidat, retrouvé par sa candidature ;
      // le propriétaire n'a que le sien.
      via('subject', 'rental_presentations', 'id', { prefix: 'rental_presentation:', jsonNot: { recipient: 'candidat' } }),
      via('data', 'rental_applications', 'id', { jsonPath: 'application', startsWith: { subject: 'rental_presentation:' } }),
      via('subject', 'listing_drafts', 'id', { prefix: 'listing:' }),
      via('subject', 'listing_translations', 'id', { prefix: 'listing_translation:' }),
      via('subject', 'inbound_messages', 'id', { prefix: 'inbound:' }),
      via('subject', 'voice_notes', 'id', { prefix: 'voice_note:' }),
      via('subject', 'calls', 'id', { prefix: 'call:' }),
      via('subject', 'prospecting_sequences', 'id', { prefix: 'prospecting_sequence:' }),
      via('subject', 'messages', 'id', { prefix: 'message:' }),
      via('subject', 'appointment_tasks', 'id', { prefix: 'task:' }),
      via('subject', 'safety_alerts', 'id', { prefix: 'alert:' }),
      via('subject', 'offer_proposals', 'id', { prefix: 'proposal:' }),
      via('subject', 'rental_lease_signatures', 'id', { prefix: 'lease_signature:' }),
      via('subject', 'rental_lease_cotenant_signatures', 'id', { prefix: 'lease_signature:' }),
    ],
    // Les données d'un événement peuvent nommer une autre personne (`referrer: person:<id>`) : masquées.
    foreignPersons: ['actor', 'data'],
    skip: { column: 'type', prefixes: [...JOURNAL_LCB_PREFIXES], marked: 'data', markers: JOURNAL_LCB_MARKERS },
  },
  registry_reviews: out('sans_client', 'Relecture du registre des traitements.'),
  registry_review_alerts: out('sans_client', 'Alerte de relecture du registre.'),
  // droits-des-personnes
  person_requests: { locate: by('person_id') },
  person_request_outputs: { locate: [via('request_id', 'person_requests')] },
  erasure_object_targets: { locate: [via('request_id', 'person_requests')] },
  person_request_answers: { locate: [via('request_id', 'person_requests')] },
  person_request_alerts: { locate: [via('request_id', 'person_requests')] },
  // durees-et-fuites : le prospect par son cycle ; la personne concernée par une fuite, par la liste figée.
  prospect_retention_cycles: { locate: by('person_id') },
  prospect_retention_outcomes: { locate: [via('cycle_id', 'prospect_retention_cycles')] },
  data_breaches: out('sans_client', 'Fuite de données : moment de la connaissance et échéance, sans donnée d\'un client.'),
  data_breach_evaluations: out('sans_client', 'Évaluation d\'une fuite, en listes fermées ; les personnes concernées sont dans data_breach_persons.'),
  data_breach_persons: { locate: by('person_id') },
  data_breach_cuts: out('agent', 'Accès coupés pendant une fuite : les clés des agents et du réseau.'),
  data_breach_restores: out('agent', 'Accès rétablis après une fuite.'),
  data_breach_notifications: out('sans_client', 'Notification d\'une fuite à la CNIL ou aux personnes, notée par le responsable.'),
  data_breach_alerts: out('sans_client', 'Alerte au responsable sur l\'échéance d\'une fuite.'),
  // location : le propriétaire par son logement, le candidat par sa candidature.
  rental_listings: { locate: by('owner_person_id') },
  rental_facts: { locate: [via('listing_id', 'rental_listings')] },
  rental_annexes: { locate: [via('listing_id', 'rental_listings')] },
  rental_checks: { locate: [via('listing_id', 'rental_listings')] },
  rental_owner_notices: { locate: by('owner_person_id') },
  rental_zones: out('sans_client', 'Zones de loyer, données publiques.'),
  rental_listing_communes: { locate: [via('listing_id', 'rental_listings')] },
  rental_ads: { locate: [via('listing_id', 'rental_listings')] },
  rental_ad_validations: { locate: [via('ad_id', 'rental_ads')] },
  rental_applications: { locate: by('person_id') },
  // Un garant Visale n'a pas de personne : sa ligne et son visa sont au candidat (W24).
  rental_guarantors: { locate: [...by('person_id'), via('application_id', 'rental_applications', 'id', { where: { kind: 'visale' } })] },
  // Les pièces du candidat lui-même ; celles d'un garant sont au garant.
  rental_application_pieces: { locate: [via('application_id', 'rental_applications', 'id', { where: { holder: 'candidat' } }), via('holder', 'rental_guarantors'), via('holder', 'persons', 'id', { prefix: 'colocataire:' })] },
  // AU097 · chaque colocataire : sa ligne, sa place au bail, sa signature et son avis d'exemplaire sont à lui.
  rental_cotenant_changes: { locate: by('person_id') },
  rental_lease_cotenants: { locate: by('person_id') },
  rental_lease_cotenant_revisions: { locate: [via('lease_id', 'rental_leases')] },
  rental_lease_cotenant_signatures: { locate: by('person_id'), secrets: ['code_hash'] },
  rental_lease_cotenant_copy_deliveries: { locate: by('person_id') },
  // Chaque fichier déposé, joint ou non, est à la personne pour qui il a été déposé (W19).
  rental_piece_deposits: { locate: by('person_id') },
  // Le constat d'une pièce est à la personne de la pièce, comme la pièce elle-même (HX47).
  rental_piece_findings: { locate: [via('piece_id', 'rental_application_pieces')] },
  // La présentation au propriétaire montre les dossiers d'autres personnes : il en voit la date et l'empreinte.
  rental_presentations: { locate: [via('listing_id', 'rental_listings')], shared: ['snapshot'] },
  rental_choices: { locate: [via('listing_id', 'rental_listings'), via('application_id', 'rental_applications')] },
  rental_fairness_receipts: { locate: by('person_id') },
  rental_lease_templates: out('sans_client', 'Modèle de bail du réseau.'),
  // Le bail et l'état des lieux rendus portent les noms et le domicile des deux parties : leur texte n'est pas montré,
  // leur empreinte reste ; chaque partie en a reçu son exemplaire.
  // Le bail retrouvé par la candidature est celui du locataire : marqué, pour lui rendre ce qu'il y a fait en partie.
  rental_leases: { locate: [via('listing_id', 'rental_listings'), via('application_id', 'rental_applications', 'id', { tag: 'locataire' }), via('id', 'rental_lease_cotenants', 'lease_id', { tag: 'colocataire' })], shared: ['content'] },
  // La signature en ligne du bail : chaque partie a la sienne ; l'exemplaire signé nomme les deux, son texte n'est
  // montré à aucune, son empreinte reste.
  rental_lease_signatures: { locate: by('person_id'), secrets: ['code_hash'] },
  // AU097 · un colocataire retrouve l'exemplaire du bail qui le nomme, jamais ce qui est au seul locataire choisi.
  rental_lease_copies: { locate: [via('lease_id', 'rental_leases'), via('lease_id', 'rental_leases', 'id', { onlyMatchedBy: 'locataire', tag: 'locataire' }), via('lease_id', 'rental_leases', 'id', { onlyMatchedBy: 'colocataire', tag: 'colocataire' })], shared: ['content'] },
  rental_lease_copy_deliveries: { locate: [via('lease_id', 'rental_lease_copies', 'lease_id')] },
  rental_fees: { locate: [via('listing_id', 'rental_listings')] },
  // L'état des lieux et la remise des clés : au propriétaire par son logement, au locataire par son bail.
  rental_inventories: { locate: [via('listing_id', 'rental_listings', 'id', { tag: 'bailleur' }), via('lease_id', 'rental_leases'), via('lease_id', 'rental_leases', 'id', { onlyMatchedBy: 'locataire', tag: 'locataire' })], shared: ['content'] },
  // La signature et l'exemplaire de chaque partie sont à elle seule : le propriétaire par son logement, le locataire par son bail.
  rental_inventory_signatures: { locate: [via('inventory_id', 'rental_inventories', 'id', { onlyMatchedBy: 'bailleur', where: { party: 'bailleur' } }), via('inventory_id', 'rental_inventories', 'id', { onlyMatchedBy: 'locataire', where: { party: 'locataire' } })] },
  rental_inventory_copies: { locate: [via('inventory_id', 'rental_inventories', 'id', { onlyMatchedBy: 'bailleur', where: { party: 'bailleur' } }), via('inventory_id', 'rental_inventories', 'id', { onlyMatchedBy: 'locataire', where: { party: 'locataire' } })] },
  rental_handovers: { locate: [via('listing_id', 'rental_listings'), via('lease_id', 'rental_leases')] },
  rental_management_links: { locate: [via('listing_id', 'rental_listings')] },
  // L'issue de l'envoi d'une échéance au propriétaire ou d'un reçu d'équité au candidat : à qui l'a reçu.
  rental_sends: { locate: [via('ref_id', 'rental_owner_notices', 'id', { where: { kind: 'echeance' } }), via('ref_id', 'rental_fairness_receipts', 'id', { where: { kind: 'recu' } })] },
  // M19 · Studio.
  photo_guide_shots: out('sans_client', 'Photos retenues pour le guide de prise de vue d\'un bien : aucune personne.'),
  photo_guide_validations: out('sans_client', 'Validation d\'un bien photographié avec le guide : aucune personne.'),
  photo_certificates: out('sans_client', 'Description des corrections d\'une photo de bien et son certificat : aucune personne.'),
  photo_exports: out('sans_client', 'Export d\'une photo de bien avec son filigrane : le nom professionnel de l\'agent et un code de contenu, aucun client.'),
  virtual_stagings: out('sans_client', 'Ce qui a changé sur une image aménagée d\'un bien et sa photo réelle : aucune personne.'),
  floor_plans: out('sans_client', 'Pièces et cotes du plan d\'un logement : aucune personne.'),
  agent_likeness_consents: out('agent', 'Accord écrit de l\'agent pour sa voix ou son avatar de synthèse.'),
  agent_likeness_revocations: out('agent', 'Retrait par l\'agent de son accord pour sa voix ou son avatar.'),
  generated_videos: out('sans_client', 'Description d\'une vidéo générée depuis les photos d\'un bien : aucune personne.'),
  virtual_tours: out('sans_client', 'Vues d\'une visite à 360 degrés d\'un bien, reliées aux pièces du plan : aucune personne.'),
  video_montages: out('sans_client', 'Description du montage d\'une vidéo de bien : aucune personne.'),
  licensed_assets: out('sans_client', 'Musiques et images sous licence du réseau : aucune personne.'),
  licensed_asset_withdrawals: out('sans_client', 'Retraits d\'entrées de la bibliothèque sous licence : aucune personne.'),
  social_posts: out('sans_client', 'Publications d\'un bien sur les réseaux, tirées de sa fiche : aucune personne.'),
  social_visual_checks: out('sans_client', 'Listes de contrôle des visuels publiés ; l\'accord d\'une personne photographiée est une pièce du stockage, sans nom ici.'),
  social_post_validations: out('sans_client', 'Validation d\'une publication par l\'agent : aucune personne.'),
  social_post_attempts: out('sans_client', 'Essais d\'envoi d\'une publication, en mode essai : aucune personne.'),
  social_post_sends: out('sans_client', 'Issues des envois d\'une publication : aucune personne.'),
  social_calendar_rules: out('agent', 'Réglages du calendrier de publication d\'un agent (HX52) : nombres par réseau et heures, aucune personne.'),
  social_calendar_slots: out('sans_client', 'Créneaux du calendrier de publication (HX52) : un bien, une publication, un réseau, une heure ; aucune personne.'),
  social_calendar_runs: out('sans_client', 'Passages des créneaux du calendrier (HX52) : aucune personne.'),
  social_calendar_outcomes: out('sans_client', 'Issues des passages du calendrier (HX52) : aucune personne.'),
  // L'option demandée suit la mise en relation, donc le projet et son client.
  studio_option_requests: { locate: [via('referral_id', 'partner_referrals')] },
  // M17 · Investir.
  investor_profiles: { locate: by('person_id') },
  // M16 · Commerces et entreprises : la fiche suit son bien, comme la fiche de commercialisation.
  business_sheets: { locate: [via('property_id', 'properties')] },
  business_valuations: { locate: [via('property_id', 'properties')] },
  business_valuation_validations: { locate: [via('valuation_id', 'business_valuations')] },
  business_presentations: { locate: [via('property_id', 'properties')] },
  business_presentation_validations: { locate: [via('presentation_id', 'business_presentations')] },
  business_nda_templates: out('sans_client', 'Modèles d\'engagement de confidentialité, rangés par la direction : aucune personne.'),
  business_access_requests: { locate: by('person_id') },
  business_ndas: { locate: by('person_id') },
  business_nda_signatures: { locate: by('person_id'), secrets: ['code_hash'] },
  business_nda_revocations: { locate: [via('nda_id', 'business_ndas')] },
  business_dossier_documents: { locate: [via('property_id', 'properties')] },
  business_dossier_links: { locate: by('person_id'), secrets: ['token_hash'] },
  business_dossier_link_revocations: { locate: [via('link_id', 'business_dossier_links')] },
  business_dossier_accesses: { locate: by('person_id') },
  business_dossier_open_codes: { locate: [via('link_id', 'business_dossier_links')], secrets: ['code_hash'] },
  business_buyer_profiles: { locate: [via('project_id', 'projects')] },
  base_restore_receipts: out('sans_client', 'Reçu d\'un test de restauration : des instants, des comptes et une empreinte de toute la base, aucune personne.'),
  base_copy_runs: out('sans_client', 'Compte rendu d\'une copie de nuit de la base : des instants, des comptes et un code de raison, aucune personne.'),
  business_safeguard_communes: out('sans_client', 'Communes dotées d\'un périmètre de sauvegarde, rangées par la direction : aucune personne.'),
  business_transfer_files: { locate: [via('property_id', 'properties')] },
  business_transfer_third_parties: { locate: [via('file_id', 'business_transfer_files')] },
  business_transfer_dates: { locate: [via('file_id', 'business_transfer_files')] },
  business_transfer_ready: { locate: [via('file_id', 'business_transfer_files')] },
  business_transfer_tasks: { locate: [via('file_id', 'business_transfer_files')] },
  business_lease_tasks: { locate: [via('property_id', 'properties')] },
  business_transfer_buyers: { locate: by('person_id') },
  business_valuation_scales: out('sans_client', 'Barèmes d\'estimation par activité, rangés par la direction : aucune personne.'),
  market_rent_imports: out('sans_client', 'Imports des loyers de marché de la Carte des loyers de l\'ANIL, par commune : aucune personne.'),
  investment_calculations: { locate: [via('project_id', 'projects')] },
  // Un calcul de viager porte sur le crédirentier : rattaché au projet de la personne, ou au bien qu'elle a mis en vente
  // ou qu'elle possède ; jamais par un bien qui l'intéresse seulement. Un calcul à la fois sur un bien et un projet exige
  // que ce projet possède ce bien (HX48) : un calcul trouvé par le bien n'est jamais celui d'une autre personne.
  viager_calculations: {
    locate: [
      via('project_id', 'projects'),
      via('property_id', 'mandates', 'property_id'),
      via('property_id', 'project_properties', 'property_id', { parentWhere: { role: 'owned' } }),
    ],
  },
  life_tables: out('sans_client', 'Tables d\'espérance de vie importées par la direction (HX48) : aucune personne, l\'auteur de l\'import seulement.'),
  life_table_rows: out('sans_client', 'Lignes d\'une table d\'espérance de vie, par âge, pour l\'ensemble des deux sexes : aucune personne.'),
  acquisition_fee_scales: out('sans_client', 'Barème des frais d\'acquisition rangé par la direction (HX48) : aucune personne.'),
  new_programs: out('agent', 'Programme neuf d\'un promoteur partenaire, confié à un agent (HX48) : aucun client.'),
  new_program_lot_versions: out('sans_client', 'Versions des lots d\'un programme neuf (HX48) : aucun client, l\'auteur de la version seulement.'),
  commune_rental_rules: out('sans_client', 'Règles de location des communes rangées par la direction : aucune personne.'),
  price_zones: out('sans_client', 'Zones des prix publics tracées par la direction : aucune personne.'),
  price_zone_retirements: out('sans_client', 'Retraits des zones des prix publics : aucune personne.'),
  neighbourhood_facts: out('sans_client', 'Données publiques d\'un quartier, avec leur source : aucune personne.'),
  neighbourhood_drafts: out('sans_client', 'Texte d\'une page de quartier, sans nom de client par règle [R155, R46].'),
  neighbourhood_validations: out('sans_client', 'Validation nommée d\'un texte de quartier.'),
  investment_notes: { locate: [via('project_id', 'projects')] },
  investor_alerts: { locate: by('person_id') },
  client_space_links: { locate: by('person_id') },
  client_space_sessions: { locate: by('person_id') },
  client_space_favorites: { locate: by('person_id') },
  property_communes: out('sans_client', 'Commune et type de logement d\'un bien en vente : aucune personne.'),
  gbp_locations: out('agent', 'Fiche Google de l\'agent.'),
  gbp_reviews: out('non_rattachable', 'Avis publié sur Google, gardé nettoyé : sans le nom de son auteur ni d\'un client, sans adresse, coordonnée ni montant ; il ne peut être relié à aucune fiche.'),
  gbp_drafts: out('agent', 'Texte de la fiche Google de l\'agent, sans nom de client par règle [R154].'),
  gbp_validations: out('agent', 'Validation d\'un texte de la fiche Google.'),
  gbp_sends: out('agent', 'Envoi à la fiche Google de l\'agent.'),
  gbp_claims: out('agent', 'Réservation d\'un envoi à la fiche Google de l\'agent.'),
  public_sites: out('agent', 'Site public d\'un agent, ou du réseau : aucune personne cliente.'),
  seo_signals: out('sans_client', 'Adresses de pages publiques signalées aux moteurs : aucune personne.'),
  public_contents: out('agent', 'Identifiant d\'un contenu public du réseau : un bien, un prix, une page d\'agent, une publication ; aucune personne cliente.'),
  public_content_posts: out('sans_client', 'Référence d\'une publication du réseau chez un réseau social : aucune personne.'),
  contact_origins: { locate: [via('inbound_id', 'inbound_messages')] },
  contact_ai_engines: { locate: [via('inbound_id', 'inbound_messages')] },
  contact_vitrines: { locate: [via('inbound_id', 'inbound_messages')] },
};

/** Une colonne dont le nom désigne l'identifiant d'une personne de la fiche client. */
export function isPersonPointer(column: string): boolean {
  return /^(person_id|[a-z_]+_person_id|survivor_id|merged_id|referrer_id|referred_id)$/.test(column);
}

export type AccessMapGap =
  | { kind: 'table_absente'; table: string }
  | { kind: 'table_inconnue'; table: string }
  | { kind: 'colonne_inconnue'; table: string; column: string }
  | { kind: 'personne_non_suivie'; table: string; column: string }
  | { kind: 'source_inconnue'; table: string; from: string }
  | { kind: 'exclusion_mal_fondee'; table: string; column: string }
  | { kind: 'boucle'; tables: string[] };

const isDirect = (l: Locator): l is DirectLocator => !('json' in l) && !('from' in l);
const isVia = (l: Locator): l is ViaLocator => 'from' in l;

/** L'ordre de lecture : chaque table après celles d'où ses lignes viennent. Lève une erreur sur une boucle. */
export function accessOrder(carte: Readonly<Record<string, AccessMapEntry>>): string[] {
  const order: string[] = [];
  const state = new Map<string, 'en_cours' | 'fait'>();
  const visit = (table: string, path: string[]): void => {
    if (state.get(table) === 'fait') return;
    if (state.get(table) === 'en_cours') throw new Error(`boucle dans la carte des demandes d'accès : ${[...path, table].join(' → ')}`);
    state.set(table, 'en_cours');
    const entry = carte[table];
    if (entry && 'locate' in entry) for (const l of entry.locate) if (isVia(l) && l.from !== table) visit(l.from, [...path, table]);
    state.set(table, 'fait');
    order.push(table);
  };
  for (const table of Object.keys(carte).sort()) visit(table, []);
  return order;
}

/** Compare la carte au registre et aux migrations : une liste vide veut dire que la réponse d'accès lit toute la base. */
export function checkAccessMap(schema: Schema, registre: readonly Traitement[], carte: Readonly<Record<string, AccessMapEntry>>): AccessMapGap[] {
  const gaps: AccessMapGap[] = [];
  const registered = new Map<string, string>();
  for (const t of registre) for (const table of Object.keys(t.tables)) registered.set(table, t.id);
  for (const table of registered.keys()) if (!(table in carte)) gaps.push({ kind: 'table_absente', table });
  for (const [table, entry] of Object.entries(carte)) {
    const columns = schema.get(table)?.columns;
    if (!columns || !registered.has(table)) {
      gaps.push({ kind: 'table_inconnue', table });
      continue;
    }
    const pointers = columns.filter(isPersonPointer);
    if ('excluded' in entry) {
      // Seule la lutte contre le blanchiment peut écarter une table qui désigne un client.
      const lcb = entry.excluded === 'lcb_ft' && registered.get(table) === LCB_FT_TRAITEMENT;
      if (!lcb) for (const column of pointers) gaps.push({ kind: 'exclusion_mal_fondee', table, column });
      if (entry.excluded === 'lcb_ft' && registered.get(table) !== LCB_FT_TRAITEMENT) gaps.push({ kind: 'exclusion_mal_fondee', table, column: '*' });
      continue;
    }
    const named = new Set<string>();
    for (const l of entry.locate) {
      if ('json' in l) named.add(l.json);
      else {
        named.add(l.column);
        for (const c of Object.keys(l.where ?? {})) named.add(c);
        if (isVia(l)) {
          for (const c of [...Object.keys(l.startsWith ?? {}), ...Object.keys(l.except ?? {}), ...Object.keys(l.only ?? {})]) named.add(c);
          if (l.jsonNot || l.jsonIs) named.add('data');
        }
      }
      if (isVia(l)) {
        const parent = carte[l.from];
        if (!parent || 'excluded' in parent) gaps.push({ kind: 'source_inconnue', table, from: l.from });
        else if (!schema.get(l.from)?.columns.includes(l.key)) gaps.push({ kind: 'colonne_inconnue', table: l.from, column: l.key });
        for (const there of Object.keys(l.parentWhere ?? {})) if (!schema.get(l.from)?.columns.includes(there)) gaps.push({ kind: 'colonne_inconnue', table: l.from, column: there });
        for (const [here, there] of Object.entries(l.alsoMatch ?? {})) {
          named.add(here);
          if (!schema.get(l.from)?.columns.includes(there)) gaps.push({ kind: 'colonne_inconnue', table: l.from, column: there });
        }
        for (const here of Object.keys(l.alsoMatchPrefix ?? {})) if (!(here in (l.alsoMatch ?? {}))) gaps.push({ kind: 'colonne_inconnue', table, column: here });
        if (l.notOnlyBy && parent && 'locate' in parent && !parent.locate.some((p) => isVia(p) && p.tag === l.notOnlyBy)) gaps.push({ kind: 'colonne_inconnue', table: l.from, column: l.notOnlyBy });
        if (l.onlyMatchedBy && parent && 'locate' in parent && !parent.locate.some((p) => (isDirect(p) && p.column === l.onlyMatchedBy) || (isVia(p) && p.tag === l.onlyMatchedBy))) {
          gaps.push({ kind: 'colonne_inconnue', table: l.from, column: l.onlyMatchedBy });
        }
      }
    }
    for (const c of [...Object.keys(entry.own ?? {}), ...Object.values(entry.own ?? {}).flat(), ...(entry.secrets ?? []), ...(entry.shared ?? []), ...(entry.sharedIf ? [entry.sharedIf.key] : []), ...(entry.skip ? [entry.skip.column, ...(entry.skip.marked ? [entry.skip.marked] : [])] : [])]) named.add(c);
    for (const c of named) if (!columns.includes(c)) gaps.push({ kind: 'colonne_inconnue', table, column: c });
    // Chaque colonne qui désigne une personne est suivie : sinon la réponse oublierait des lignes, ou montrerait celles d'un autre.
    const followed = new Set(entry.locate.filter(isDirect).map((l) => l.column));
    for (const column of pointers) if (!followed.has(column)) gaps.push({ kind: 'personne_non_suivie', table, column });
  }
  try {
    accessOrder(carte);
  } catch (error) {
    gaps.push({ kind: 'boucle', tables: [(error as Error).message] });
  }
  return gaps;
}

export function describeAccessGap(gap: AccessMapGap): string {
  switch (gap.kind) {
    case 'table_absente':
      return `la table ${gap.table} est au registre mais pas dans la carte des demandes d'accès : dire comment y trouver les lignes d'une personne, ou pourquoi elle n'en a pas`;
    case 'table_inconnue':
      return `la carte des demandes d'accès cite ${gap.table}, absente du registre ou des migrations`;
    case 'colonne_inconnue':
      return `la carte des demandes d'accès cite ${gap.table}.${gap.column}, absente des migrations`;
    case 'personne_non_suivie':
      return `la colonne ${gap.table}.${gap.column} désigne une personne et la carte des demandes d'accès ne la suit pas`;
    case 'source_inconnue':
      return `la table ${gap.table} est lue depuis ${gap.from}, qui n'est pas lue elle-même`;
    case 'exclusion_mal_fondee':
      return `la table ${gap.table} est écartée de la réponse d'accès mais désigne une personne (${gap.column})`;
    case 'boucle':
      return gap.tables.join(', ');
  }
}
