/**
 * La carte des fichiers déposés de l'agence sous licence (HX75) [R660, R661].
 *
 * Aucun stockage de fichiers n'est branché au Worker : le fichier de reprise ne porte pas le contenu des pièces, des
 * photos ni des vidéos, il dit chacune. Chaque colonne `ref`, `_ref` ou `_refs` d'une table reprise est classée ici une
 * seule fois :
 * - `fichier` : une référence du stockage (pièce signée, photo, vidéo, enregistrement) ;
 * - `preuve` : la référence d'une preuve, écrit signé, mail ou pièce ; un fichier déposé est possible, elle est listée
 *   aussi, par prudence ;
 * - `externe` : un identifiant chez un autre service, ou un numéro ; ce n'est pas un fichier, la raison est dite.
 *
 * Jamais vu : le test `reprise-fichiers` relit la base ; une colonne de référence que la base gagne sans être classée,
 * ou une classe pour une colonne absente ou une table laissée, font échouer les vérifications.
 */

export type SorteReference = 'fichier' | 'preuve';

export type ClasseReference = { readonly sorte: SorteReference } | { readonly sorte: 'externe'; readonly why: string };

/** Une colonne de référence d'une table reprise : son nom se termine ainsi [R660]. */
export const COLONNE_REFERENCE = /(^|_)refs?$/;

const F: ClasseReference = { sorte: 'fichier' };
const P: ClasseReference = { sorte: 'preuve' };
const externe = (why: string): ClasseReference => ({ sorte: 'externe', why });

/** La classe de chaque colonne de référence, par `table.colonne` [R660]. */
export const CARTE_FICHIERS: Readonly<Record<string, ClasseReference>> = {
  // Fichiers du stockage.
  'business_dossier_documents.storage_ref': F,
  'calls.recording_ref': F,
  'diffusion_photo_descriptions.media_ref': F,
  'diffusion_photo_subjects.media_ref': F,
  'generated_videos.video_ref': F,
  'notary_drafts.document_ref': F,
  'offer_register.signed_ref': F,
  'photo_certificates.original_ref': F,
  'photo_certificates.result_ref': F,
  'photo_exports.result_ref': F,
  'photo_guide_shots.media_ref': F,
  // AU059 : le scan de la procuration d'un mandant représenté, rangé avec ceux du mandat.
  'document_proxies.power_ref': F,
  'registered_letters.document_ref': F,
  'signature_circuits.document_ref': F,
  'signed_amendments.scan_ref': F,
  'signed_documents.scan_ref': F,
  'social_visual_checks.media_ref': F,
  'supplier_invoice_reads.document_ref': F,
  'video_montages.video_ref': F,
  'video_text_checks.media_ref': F,
  'virtual_stagings.real_ref': F,
  'virtual_stagings.staged_ref': F,
  'visit_energy_audit_handovers.audit_ref': F,
  'visit_slips.scan_ref': F,
  'voice_notes.media_ref': F,
  'academy_modules.script_ref': F,
  'agent_file_pieces.ref': F,
  // AU028 : la pièce qui prouve le cycle de formation d'avant l'arrivée.
  'academy_prior_entries.proof_ref': P,
  'mailbox_attachments.ref': F,
  'partner_documents.ref': F,
  'rental_annexes.ref': F,
  'rental_application_pieces.ref': F,
  'rental_piece_deposits.ref': F,
  'sale_file_pieces.ref': F,
  'signature_circuit_annexes.ref': F,
  // Preuves : écrit, mail ou pièce ; listées par prudence.
  'agency_delegation_steps.proof_ref': P,
  'agency_partner_invoices.proof_ref': P,
  'business_transfer_dates.proof_ref': P,
  'commission_payouts.proof_ref': P,
  'commission_receipts.proof_ref': P,
  'commission_steps.proof_ref': P,
  'licensed_assets.proof_ref': P,
  'mandate_source_costs.proof_ref': P,
  'offer_proposals.proof_ref': P,
  'offer_responses.proof_ref': P,
  'partner_credentials.proof_ref': P,
  'partner_referral_steps.consent_proof_ref': P,
  'phase1_app_inventories.proof_ref': P,
  'phase1_outside_sends.proof_ref': P,
  'pilot_before_declarations.proof_ref': P,
  'pre_contract_deposits.proof_ref': P,
  'proposal_responses.proof_ref': P,
  'registered_letter_events.proof_ref': P,
  'rental_choices.proof_ref': P,
  'sale_file_closings.proof_ref': P,
  'sale_file_conditions.proof_ref': P,
  'sale_file_dates.proof_ref': P,
  'sale_file_buyer_notices.proof_ref': P,
  'sale_file_stops.proof_ref': P,
  'signature_circuit_events.proof_ref': P,
  'social_visual_checks.consent_ref': P,
  'virtual_tours.tour_ref': P,
  // Identifiants chez un autre service, ou numéros : pas des fichiers.
  'public_contents.ref': externe('L’identifiant interne du contenu porté par un lien : un bien, un agent, une publication, un portail.'),
  'diffusion_portal_task_closures.ref': externe('La référence de l’annonce chez le portail à la clôture de la tâche : un identifiant chez le portail.'),
  'automation_runs.trigger_ref': externe('Ce qui a lancé une automatisation : un identifiant de tâche, pas un fichier.'),
  'bank_lines.invoice_refs': externe('Les numéros de facture cités par une ligne de banque : les factures sont dans leurs propres tables.'),
  'diffusion_portal_tasks.first_ref': externe('La référence de l’annonce chez le portail, au premier écart relevé : un identifiant chez le portail.'),
  'gbp_locations.location_ref': externe('L’identifiant de la fiche chez Google : pas un fichier.'),
  'gbp_reviews.review_ref': externe('L’identifiant de l’avis chez Google : le texte de l’avis est dans la ligne.'),
  'inbound_messages.conversation_ref': externe('L’identifiant de la conversation chez la messagerie : le message est dans la ligne.'),
  'inbound_messages.post_ref': externe('L’identifiant de la publication commentée chez le réseau social.'),
  'inbound_messages.property_ref': externe('La référence de bien citée par le message : un texte, pas un fichier.'),
  'invoice_transmissions.platform_ref': externe('Le numéro de dépôt de la facture chez la plateforme de facturation.'),
  'invoice_real_deposits.platform_ref': externe('Le numéro de dépôt de la facture réelle chez la plateforme agréée.'),
  'new_program_lot_versions.lot_ref': externe('Le numéro du lot dans son programme neuf.'),
  'pending_human_replies.conversation_ref': externe('L’identifiant de la conversation chez la messagerie.'),
  'pige_ad_sightings.source_ref': externe('L’identifiant de l’annonce chez sa source publique.'),
  'pige_ads.source_ref': externe('L’identifiant de l’annonce chez sa source publique.'),
  'public_content_posts.post_ref': externe('L’identifiant de la publication chez le réseau social.'),
  'quiz_attempts.scope_ref': externe('Le parcours ou le module de la formation interrogé : un identifiant interne.'),
  'shop_order_results.printer_ref': externe('Le numéro de commande chez l’imprimeur.'),
  'virtual_tour_contacts.view_ref': externe('L’identifiant de la vue chez l’hébergeur de la visite.'),
};

/**
 * La clé de chaque table à fichiers dont la clé primaire n'est pas `id` : la ligne qui cite un fichier est dite par
 * ces colonnes, dans l'ordre de la clé primaire (test) [R661].
 */
export const CLES_LIGNES: Readonly<Record<string, readonly string[]>> = {
  agency_delegation_steps: ['delegation_id', 'step'],
  agency_partner_invoices: ['delegation_id'],
  commission_payouts: ['file_id'],
  commission_receipts: ['file_id'],
  commission_steps: ['file_id', 'status'],
  document_proxies: ['document_id', 'mandant_person_id'],
  offer_responses: ['offer_id'],
  partner_referral_steps: ['referral_id', 'seq'],
  phase1_app_inventories: ['network_id', 'version'],
  pilot_before_declarations: ['network_id', 'agent_id', 'version'],
  pre_contract_deposits: ['file_id', 'version'],
  proposal_responses: ['proposal_id'],
  registered_letter_events: ['letter_id', 'seq'],
  rental_choices: ['listing_id'],
  sale_file_closings: ['file_id'],
  sale_file_buyer_notices: ['file_id', 'person_id', 'version'],
  sale_file_conditions: ['file_id', 'kind', 'version'],
  sale_file_dates: ['file_id', 'kind', 'version'],
  sale_file_stops: ['file_id'],
  signature_circuit_annexes: ['circuit_id', 'position'],
  signature_circuit_events: ['circuit_id', 'seq'],
  signed_amendments: ['document_id'],
  signed_documents: ['document_id'],
};

/** La clé d'une table : celle déclarée, ou `id`. */
export function cleLigne(table: string): readonly string[] {
  return CLES_LIGNES[table] ?? ['id'];
}

/** La classe d'une colonne, ou `null` si elle n'est pas classée. */
export function classeReference(table: string, colonne: string): ClasseReference | null {
  return CARTE_FICHIERS[`${table}.${colonne}`] ?? null;
}

/** Les colonnes à lister d'une table (fichiers et preuves), par ordre de nom [R661]. */
export function colonnesFichiers(table: string): { colonne: string; sorte: SorteReference }[] {
  const out: { colonne: string; sorte: SorteReference }[] = [];
  for (const [k, c] of Object.entries(CARTE_FICHIERS)) {
    const dot = k.indexOf('.');
    if (k.slice(0, dot) !== table || c.sorte === 'externe') continue;
    out.push({ colonne: k.slice(dot + 1), sorte: c.sorte });
  }
  return out.sort((a, b) => (a.colonne < b.colonne ? -1 : a.colonne > b.colonne ? 1 : 0));
}

/**
 * Les colonnes JSON qui portent des références de stockage dans une liste : la fiche du bien range ses photos et ses
 * vidéos dans `media`, chacune par sa référence `ref` (M07, `annonces/fiche-bien.ts`) [R661].
 */
export const FICHIERS_JSON: Readonly<Record<string, { readonly colonne: string; readonly liste: string; readonly champ: string; readonly sorte: SorteReference }>> = {
  property_sheets: { colonne: 'data', liste: 'media', champ: 'ref', sorte: 'fichier' },
};
