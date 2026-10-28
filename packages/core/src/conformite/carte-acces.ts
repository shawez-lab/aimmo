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
  /** Les lignes ne comptent pas si ce champ du JSON de `data` a cette valeur (champ → valeur). */
  jsonNot?: Readonly<Record<string, string>>;
  where?: Readonly<Record<string, string>>;
  /** Seulement les lignes de `from` trouvées par cette colonne directe : pas celles de l'autre partie. */
  onlyMatchedBy?: string;
  /** D'autres colonnes qui doivent aussi valoir celles de la même ligne de `from` (colonne ici → colonne là-bas). */
  alsoMatch?: Readonly<Record<string, string>>;
  /** Seulement les lignes de `from` qui ont ces valeurs. */
  parentWhere?: Readonly<Record<string, string>>;
}

/** Un tableau JSON dont chaque élément nomme sa personne : seuls ses éléments sortent. */
export interface JsonLocator {
  json: string;
  /** Les champs de l'élément qui portent l'identifiant, une valeur ou une liste. */
  idFields: readonly string[];
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

const ENVOI = (why: string): JournalSubjectUse => ({ excluded: 'envoi', why: `Sujet d'un envoi du contrôle central (${why}) : jamais écrit au journal, rangé avec la personne dans message_subjects et send_log, lus par sa fiche.` });

export const JOURNAL_SUBJECTS: Readonly<Record<string, JournalSubjectUse>> = {
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
  property: 'journal',
  project: 'journal',
  referral: 'journal',
  signature: 'journal',
  rental_presentation: 'journal',
  listing: 'journal',
  inbound: 'journal',
  message: 'journal',
  task: 'journal',
  alert: 'journal',
  proposal: 'journal',
  offre: ENVOI('transmission d\'une offre'),
  rappel_fonds: ENVOI('rappel des fonds'),
  suivi_valeur: ENVOI('suivi de valeur'),
  merci: ENVOI('remerciement'),
  avis: ENVOI('demande d\'avis'),
  apres_vente: ENVOI('relance après la vente'),
  visite_code: ENVOI('code de sécurité de visite'),
  compte_rendu: ENVOI('compte rendu'),
  point_semaine: ENVOI('point de la semaine'),
  relance_avis: ENVOI('relance d\'un avis de valeur'),
  relance_piece: ENVOI('relance d\'une pièce'),
  rdv_confirmation: ENVOI('confirmation de rendez-vous'),
  tournee: ENVOI('tournée de visites'),
  agent: { excluded: 'agent', why: 'Un agent du réseau.' },
  agent_pair: { excluded: 'agent', why: 'Un binôme d\'agents.' },
  academy_module: { excluded: 'agent', why: 'Formation des agents.' },
  academy_session: { excluded: 'agent', why: 'Formation des agents.' },
  training_case: { excluded: 'agent', why: 'Entraînement des agents.' },
  training_session: { excluded: 'agent', why: 'Entraînement des agents.' },
  assistance: { excluded: 'agent', why: 'Assistance d\'un agent par le réseau.' },
  recruiting_answer: { excluded: 'candidat', why: 'Réponse à un candidat au réseau.' },
  candidate: { excluded: 'candidat', why: 'Un candidat au réseau.' },
  partner: { excluded: 'partenaire', why: 'Un partenaire professionnel.' },
  partner_prospect: { excluded: 'partenaire', why: 'Un futur partenaire.' },
  network: { excluded: 'sans_client', why: 'Le réseau lui-même.' },
  template: { excluded: 'sans_client', why: 'Modèle de document.' },
  lease_template: { excluded: 'sans_client', why: 'Modèle de bail.' },
  visit_template: { excluded: 'sans_client', why: 'Modèle de bon de visite.' },
  commune: { excluded: 'sans_client', why: 'Zone d\'une commune.' },
  page: { excluded: 'sans_client', why: 'Page publique.' },
  registry: { excluded: 'sans_client', why: 'Relecture du registre des traitements.' },
  rdv_rappel_: ENVOI('rappel de rendez-vous, `rdv_rappel_<sorte>:`'),
  vigilance_alert: { excluded: 'lcb_ft', why: 'Alerte de vigilance.' },
  vault_piece: { excluded: 'lcb_ft', why: 'Pièce du coffre de la conformité.' },
  risk_sheet: { excluded: 'lcb_ft', why: 'Fiche de risque.' },
  baisse: { excluded: 'pas_un_sujet', why: 'Clé d\'une alerte du pilotage (pilotage_alerts), jamais un sujet du journal.' },
  budget_ia: { excluded: 'pas_un_sujet', why: 'Clé d\'une alerte du pilotage (pilotage_alerts), jamais un sujet du journal.' },
  remplace: { excluded: 'pas_un_sujet', why: 'Code d\'attente d\'une facture, rangé dans les données d\'un événement du dossier de vente.' },
  suspicion_report: { excluded: 'lcb_ft', why: 'Signalement au responsable.' },
};

export const CARTE_ACCES: Readonly<Record<string, AccessMapEntry>> = {
  // relation-clients
  persons: { locate: by('id') },
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
  agent_import_contacts: { locate: by('person_id') },
  agent_import_referrals: { locate: by('person_id') },
  // messages
  messages: { locate: by('person_id') },
  message_kinds: { locate: [via('message_id', 'messages')] },
  message_subjects: { locate: by('person_id') },
  send_log: { locate: by('person_id') },
  send_reservations: { locate: by('person_id') },
  inbound_messages: { locate: by('person_id') },
  reception_log: { locate: [via('inbound_id', 'inbound_messages')] },
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
  value_tracking: { locate: by('person_id') },
  value_tracking_sends: { locate: [via('tracking_id', 'value_tracking')] },
  value_tracking_alerts: { locate: by('person_id') },
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
  daily_plans: { locate: [{ json: 'items', idFields: ['personId', 'memberIds'] }] },
  visits: { locate: by('person_id') },
  visit_slip_templates: out('sans_client', 'Modèle de bon de visite du réseau.'),
  visit_slips: { locate: [via('appointment_id', 'appointments')] },
  visit_safety: { locate: [via('appointment_id', 'appointments')], secrets: ['code_hash'] },
  safety_alerts: { locate: [via('appointment_id', 'appointments')] },
  visit_reports: { locate: [via('appointment_id', 'appointments')] },
  visit_tasks: { locate: [via('appointment_id', 'appointments')] },
  // mandats-documents
  mandates: { locate: by('person_id') },
  mandate_register_settings: out('sans_client', 'Réglage de la numérotation du registre des mandats.'),
  mandate_register: { locate: [via('mandate_id', 'mandates')] },
  document_templates: out('sans_client', 'Modèle de document du réseau.'),
  documents: { locate: [...by('person_id'), via('mandate_id', 'mandates')] },
  fee_schedules: out('sans_client', 'Barème d\'honoraires du réseau.'),
  identity_checks: { locate: by('person_id') },
  document_checks: { locate: [via('document_id', 'documents')] },
  signed_documents: { locate: [via('document_id', 'documents')] },
  mandate_early_starts: { locate: [via('mandate_id', 'mandates')] },
  mandate_withdrawals: { locate: [via('mandate_id', 'mandates')] },
  mandate_tasks: { locate: [via('mandate_id', 'mandates')] },
  signed_amendments: { locate: [via('document_id', 'documents')] },
  signature_sessions: { locate: [via('document_id', 'documents')], secrets: ['code_hash'] },
  // biens-annonces : les biens de la personne, par son mandat, son projet ou sa mise en location.
  properties: { locate: [via('id', 'mandates', 'property_id'), via('id', 'project_properties', 'property_id'), via('id', 'rental_listings', 'property_id')] },
  property_links: { locate: [via('property_id', 'properties')] },
  property_details: { locate: [via('property_id', 'properties')] },
  property_sheets: { locate: [via('property_id', 'properties')] },
  listing_settings: out('sans_client', 'Réglage des annonces du réseau (numéro de carte professionnelle).'),
  listing_drafts: { locate: [via('property_id', 'properties')] },
  listing_validations: { locate: [via('property_id', 'properties')] },
  listing_versions: { locate: [via('property_id', 'properties')] },
  video_text_checks: { locate: [via('property_id', 'properties')] },
  agent_import_properties: { locate: [via('property_id', 'properties')] },
  // acquereurs
  buyer_searches: { locate: by('person_id') },
  property_alerts: { locate: by('person_id') },
  alert_unsubscribe_tokens: { locate: by('person_id'), secrets: ['token_hash'] },
  agent_whatsapp_alerts: { locate: by('person_id') },
  weekly_points: { locate: by('person_id') },
  // offres-dossiers-vente : l'acquéreur par son offre ; le vendeur voit son dossier de vente sans l'acquéreur.
  offer_register: { locate: by('buyer_person_id') },
  offer_checks: { locate: [via('offer_id', 'offer_register')] },
  offer_transmissions: { locate: [via('offer_id', 'offer_register')] },
  offer_responses: { locate: [via('offer_id', 'offer_register')] },
  offer_untransmitted_alerts: { locate: [via('offer_id', 'offer_register')] },
  offer_tasks: { locate: [via('offer_id', 'offer_register')] },
  offer_proposals: { locate: [via('offer_id', 'offer_register')] },
  proposal_transmissions: { locate: [via('proposal_id', 'offer_proposals')] },
  proposal_responses: { locate: [via('proposal_id', 'offer_proposals')] },
  proposal_tasks: { locate: [via('proposal_id', 'offer_proposals')] },
  sale_files: { locate: [...by('buyer_person_id'), via('property_id', 'mandates', 'property_id')], own: { buyer_person_id: ['offer_id'] } },
  sale_file_steps: { locate: [via('file_id', 'sale_files')] },
  sale_file_pieces: { locate: [via('file_id', 'sale_files')] },
  sale_file_dates: { locate: [via('file_id', 'sale_files')] },
  sale_file_tasks: { locate: [via('file_id', 'sale_files')] },
  sale_file_reminders: { locate: by('person_id') },
  // Le financement est celui de l'acquéreur : le vendeur ne le voit pas.
  sale_file_financing: { locate: [via('file_id', 'sale_files', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  sale_file_financing_alerts: { locate: [via('file_id', 'sale_files', 'id', { onlyMatchedBy: 'buyer_person_id' })] },
  sale_file_fund_alerts: { locate: by('person_id') },
  sale_file_closings: { locate: [via('file_id', 'sale_files')] },
  // apres-vente
  referrals: {
    locate: by('referrer_id', 'referred_id'),
    own: { referrer_id: [], referred_id: ['first_name', 'project_id', 'callable', 'call_due_at', 'call_done_at'] },
  },
  review_requests: { locate: by('person_id') },
  after_sale_tasks: { locate: [via('file_id', 'sale_files')] },
  after_sale_choices: { locate: by('person_id') },
  after_sale_reminders: { locate: by('person_id') },
  after_sale_unsubscribe_tokens: { locate: by('person_id'), secrets: ['token_hash'] },
  satisfaction_tokens: { locate: by('person_id'), secrets: ['token_hash'] },
  satisfaction_answers: { locate: by('person_id') },
  thank_you_tasks: { locate: by('person_id') },
  owner_booklets: { locate: by('person_id') },
  owner_booklet_links: { locate: by('person_id'), secrets: ['token_hash'] },
  referral_requests: out('non_rattachable', 'Clé de rejeu d\'une requête de l\'API, rangée sous son empreinte : la recommandation qu\'elle a créée est lue dans referrals.'),
  // commissions-factures
  sale_commissions: out('agent', 'Honoraires et rémunération de l\'agent.'),
  commission_grids: out('sans_client', 'Grille de rémunération des agents.'),
  commissions: out('agent', 'Rémunération de l\'agent.'),
  commission_shares: out('agent', 'Partage de la rémunération entre agents.'),
  commission_steps: out('agent', 'Étapes du paiement de la rémunération de l\'agent.'),
  invoice_drafts: { locate: by('recipient_person_id') },
  invoices: { locate: [via('draft_id', 'invoice_drafts')] },
  invoice_transmissions: { locate: [via('invoice_id', 'invoices')] },
  commission_receipts: out('agent', 'Encaissement des honoraires par le réseau.'),
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
  // agents-reseau
  networks: out('sans_client', 'Le réseau lui-même.'),
  agents: out('agent', 'Fiche de l\'agent.'),
  access_invitations: out('agent', 'Invitation d\'accès d\'un agent.'),
  access_keys: out('agent', 'Clé d\'accès d\'un utilisateur du réseau.'),
  agent_zones: out('agent', 'Communes de l\'agent.'),
  agent_availabilities: out('agent', 'Disponibilités de l\'agent.'),
  agent_public_cards: out('agent', 'Carte publique de l\'agent.'),
  agent_review_links: out('agent', 'Lien d\'avis de l\'agent.'),
  agent_onboardings: out('agent', 'Intégration de l\'agent.'),
  agent_file_pieces: out('agent', 'Dossier de l\'agent.'),
  agent_file_alerts: out('agent', 'Alertes du dossier de l\'agent.'),
  academy_modules: out('sans_client', 'Modules de l\'académie.'),
  academy_completions: out('agent', 'Formation de l\'agent.'),
  academy_sessions: out('sans_client', 'Sessions de l\'académie.'),
  academy_attendance: out('agent', 'Présence de l\'agent en formation.'),
  academy_alerts: out('agent', 'Alertes de formation de l\'agent.'),
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
  agent_departure_handovers: { locate: [{ column: 'subject_id', where: { kind: 'person' } }, via('subject_id', 'projects', 'id', { where: { kind: 'project' } }), via('subject_id', 'properties', 'id', { where: { kind: 'property' } })] },
  agent_departure_reassignments: { locate: [{ column: 'subject_id', where: { kind: 'person' } }, via('subject_id', 'projects', 'id', { where: { kind: 'project' } }), via('subject_id', 'properties', 'id', { where: { kind: 'property' } })] },
  // conformite-lcb-ft : ses tables sont écartées toutes ensemble, depuis le registre (`LCB_FT_EXCLUSIONS`), sans être
  // nommées ici : seul le code de la conformité lit le coffre, la vigilance et les signalements.
  ...LCB_FT_EXCLUSIONS,
  // partenaires : les mises en relation du client, par son projet.
  partners: out('partenaire', 'Fiche du partenaire.'),
  partner_zones: out('partenaire', 'Zones du partenaire.'),
  partner_credentials: out('partenaire', 'Justificatifs du partenaire.'),
  partner_credential_alerts: out('partenaire', 'Alertes des justificatifs du partenaire.'),
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
  // preuves-et-registre : le journal de la personne et de ses dossiers, sans la lutte contre le blanchiment.
  journal: {
    locate: [
      { column: 'subject', prefix: 'person:' },
      via('subject', 'mandates', 'id', { prefix: 'mandate:' }),
      via('subject', 'documents', 'id', { prefix: 'document:' }),
      via('subject', 'offer_register', 'id', { prefix: 'offer:' }),
      // Le dossier de vente au journal porte le financement et les alertes de fonds de l'acquéreur : à lui seul.
      via('subject', 'sale_files', 'id', { prefix: 'sale_file:', onlyMatchedBy: 'buyer_person_id' }),
      via('subject', 'appointments', 'id', { prefix: 'appointment:' }),
      via('subject', 'appointments', 'id', { prefix: 'visit:' }),
      via('subject', 'rental_applications', 'id', { prefix: 'rental_application:' }),
      via('subject', 'rental_listings', 'id', { prefix: 'rental:' }),
      via('subject', 'person_requests', 'id', { prefix: 'person_request:' }),
      // Le journal d'un bien n'est qu'à qui le possède : par son mandat, son projet (bien possédé) ou sa mise en
      // location ; jamais à l'acquéreur qui s'y intéresse.
      via('subject', 'mandates', 'property_id', { prefix: 'property:' }),
      via('subject', 'project_properties', 'property_id', { prefix: 'property:', parentWhere: { role: 'owned' } }),
      via('subject', 'rental_listings', 'property_id', { prefix: 'property:' }),
      via('subject', 'projects', 'id', { prefix: 'project:' }),
      via('subject', 'partner_referrals', 'id', { prefix: 'referral:' }),
      via('subject', 'signature_sessions', 'id', { prefix: 'signature:' }),
      // Le reçu d'équité d'un candidat, au journal de la présentation, est au candidat, retrouvé par sa candidature ;
      // le propriétaire n'a que le sien.
      via('subject', 'rental_presentations', 'id', { prefix: 'rental_presentation:', jsonNot: { recipient: 'candidat' } }),
      via('data', 'rental_applications', 'id', { jsonPath: 'application', startsWith: { subject: 'rental_presentation:' } }),
      via('subject', 'listing_drafts', 'id', { prefix: 'listing:' }),
      via('subject', 'inbound_messages', 'id', { prefix: 'inbound:' }),
      via('subject', 'messages', 'id', { prefix: 'message:' }),
      via('subject', 'appointment_tasks', 'id', { prefix: 'task:' }),
      via('subject', 'safety_alerts', 'id', { prefix: 'alert:' }),
      via('subject', 'offer_proposals', 'id', { prefix: 'proposal:' }),
    ],
    // Les données d'un événement peuvent nommer une autre personne (`referrer: person:<id>`) : masquées.
    foreignPersons: ['actor', 'data'],
    // L'arrivée d'une candidature, au journal du logement, est la donnée du candidat : elle n'est pas au propriétaire.
    skip: { column: 'type', prefixes: [...JOURNAL_LCB_PREFIXES, 'location.candidature'], marked: 'data', markers: JOURNAL_LCB_MARKERS },
  },
  registry_reviews: out('sans_client', 'Relecture du registre des traitements.'),
  registry_review_alerts: out('sans_client', 'Alerte de relecture du registre.'),
  // droits-des-personnes
  person_requests: { locate: by('person_id') },
  person_request_outputs: { locate: [via('request_id', 'person_requests')] },
  person_request_answers: { locate: [via('request_id', 'person_requests')] },
  person_request_alerts: { locate: [via('request_id', 'person_requests')] },
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
  rental_guarantors: { locate: by('person_id') },
  // Les pièces du candidat lui-même ; celles d'un garant sont au garant.
  rental_application_pieces: { locate: [via('application_id', 'rental_applications', 'id', { where: { holder: 'candidat' } }), via('holder', 'rental_guarantors')] },
  // La présentation au propriétaire montre les dossiers d'autres personnes : il en voit la date et l'empreinte.
  rental_presentations: { locate: [via('listing_id', 'rental_listings')], shared: ['snapshot'] },
  rental_choices: { locate: [via('listing_id', 'rental_listings'), via('application_id', 'rental_applications')] },
  rental_fairness_receipts: { locate: by('person_id') },
  rental_lease_templates: out('sans_client', 'Modèle de bail du réseau.'),
  // Le bail et l'état des lieux rendus portent les noms et le domicile des deux parties : leur texte n'est pas montré,
  // leur empreinte reste ; chaque partie en a reçu son exemplaire.
  rental_leases: { locate: [via('listing_id', 'rental_listings'), via('application_id', 'rental_applications')], shared: ['content'] },
  rental_fees: { locate: [via('listing_id', 'rental_listings')] },
  // L'état des lieux et la remise des clés : au propriétaire par son logement, au locataire par son bail.
  rental_inventories: { locate: [via('listing_id', 'rental_listings'), via('lease_id', 'rental_leases')], shared: ['content'] },
  rental_inventory_signatures: { locate: [via('inventory_id', 'rental_inventories')] },
  rental_inventory_copies: { locate: [via('inventory_id', 'rental_inventories')] },
  rental_handovers: { locate: [via('listing_id', 'rental_listings'), via('lease_id', 'rental_leases')] },
  rental_management_links: { locate: [via('listing_id', 'rental_listings')] },
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
          for (const c of Object.keys(l.startsWith ?? {})) named.add(c);
          if (l.jsonNot) named.add('data');
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
        if (l.onlyMatchedBy && parent && 'locate' in parent && !parent.locate.some((p) => isDirect(p) && p.column === l.onlyMatchedBy)) {
          gaps.push({ kind: 'colonne_inconnue', table: l.from, column: l.onlyMatchedBy });
        }
      }
    }
    for (const c of [...Object.keys(entry.own ?? {}), ...Object.values(entry.own ?? {}).flat(), ...(entry.secrets ?? []), ...(entry.shared ?? []), ...(entry.skip ? [entry.skip.column, ...(entry.skip.marked ? [entry.skip.marked] : [])] : [])]) named.add(c);
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
