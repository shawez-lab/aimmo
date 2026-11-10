/**
 * La carte de reprise des données d'un réseau (HX74) [R658, R659].
 *
 * Pour chaque table de la base, la carte dit comment y trouver les lignes d'un réseau, ou pourquoi elle n'entre pas
 * dans le fichier de reprise :
 *   - `TABLES_RESEAU` : la table porte la colonne `network_id` ; ses lignes sont celles de ce réseau ;
 *   - `soi` : la ligne du réseau lui-même ;
 *   - `via` : la table n'a pas de colonne `network_id` ; ses lignes sont celles dont une clé vaut celle d'une ligne déjà
 *     trouvée dans une autre table (chaque clé étrangère vers une table reprise est suivie, l'une ou l'autre suffit ;
 *     une clé de plusieurs colonnes est suivie entière). `sansCle` dit pourquoi le chemin suit une colonne sans clé
 *     étrangère ;
 *   - `hors` : la table ne porte les données d'aucun réseau (technique, publique) ou ne se découpe pas (le journal).
 *
 * Jamais vu : le test `reprise-agence` relit les migrations et leurs clés étrangères ; une table que la base gagne sans
 * entrer ici, une clé étrangère vers une table reprise qui n'est pas suivie, ou un chemin qui ne suit aucune vraie clé,
 * font échouer les vérifications. Le fichier ne peut pas oublier une table.
 */

/** Un chemin : la ou les colonnes d'ici, la table déjà trouvée, la ou les colonnes de sa clé. */
export type CheminReprise = readonly [string | readonly string[], string, string | readonly string[]];

export type HorsReprise = 'technique' | 'public' | 'commun';

export type EntreeReprise =
  | { readonly soi: string }
  | { readonly via: readonly CheminReprise[]; readonly sansCle?: string }
  | { readonly hors: HorsReprise; readonly why: string };

/** Les tables qui portent la colonne `network_id`. */
export const TABLES_RESEAU: readonly string[] = `
  academy_alerts academy_attendance academy_completions academy_modules academy_sessions access_invitations
  access_keys acquisition_fee_scales ad_campaign_contacts ad_campaigns address_score_mandates address_scores
  after_sale_choices after_sale_reminders after_sale_tasks after_sale_unsubscribe_tokens agency_delegations
  agency_fee_statements agency_partner_invoices agency_shares agency_visits agent_absences agent_alerts
  agent_availabilities agent_cost_assignments agent_cost_settings agent_departure_handovers
  agent_departure_reassignments agent_departures agent_exports agent_file_alerts agent_file_pieces
  agent_import_contacts agent_import_properties agent_import_referrals agent_language_declarations
  agent_legal_mentions agent_likeness_consents agent_notification_settings agent_notifications agent_onboardings
  agent_pairs agent_public_cards agent_push_log agent_push_sends agent_pushes agent_referents agent_review_links
  agent_time_saved agent_whatsapp_alerts agent_zones agents alert_unsubscribe_tokens appointment_briefs
  appointment_reports appointment_tasks appointments assistance_requests assistant_calls assistant_keys
  assistant_sessions attach_log attributions automation_daily_messages automation_rollouts automation_runs
  automation_scenarios automation_simulations automation_switches automation_tasks bank_lines bank_reconciliations
  beneficial_owners business_access_requests business_buyer_profiles business_dossier_accesses
  business_dossier_documents business_dossier_link_revocations business_dossier_links business_dossier_open_codes
  business_nda_revocations business_nda_signatures business_nda_templates business_ndas
  business_presentation_validations business_presentations business_safeguard_communes business_sheets
  business_transfer_buyers business_transfer_dates business_transfer_files business_transfer_ready
  business_transfer_tasks business_transfer_third_parties business_transfer_watch business_transfer_watch_decisions
  business_valuation_scales business_valuation_validations business_valuations buyer_searches call_notes
  callback_tasks calls candidate_content_origins candidate_decisions candidate_interview_outcomes
  candidate_interviews candidate_replies candidates card_holders client_date_messages client_date_texts client_dates
  client_identifications client_space_favorites client_space_links client_space_sessions commission_grids
  commission_payouts commission_receipts commissions commune_rental_rules complaint_alerts complaint_answers
  complaint_mediator_offers complaint_settings complaints compliance_vault_pieces consents contact_ai_engines
  contact_keys contact_origins contact_scores contact_vitrines conversation_handovers coownership_summaries
  custom_reports daily_plans data_breach_cuts data_breaches diffusion_photo_subjects diffusion_portal_checks
  diffusion_portal_choices diffusion_portal_feedback diffusion_portal_settings diffusion_portal_suspensions
  diffusion_portal_tasks diffusion_portal_texts document_checks document_templates documents dpe_alert_items
  dpe_diagnoses dpe_letters dpe_watch_sectors dpe_watch_stops exclusions fee_schedules floor_plans freeze_checks
  freeze_match_decisions freeze_matches freeze_registry_versions gbp_claims gbp_drafts gbp_locations gbp_reviews
  gbp_sends generated_videos human_replies identity_checks import_keys inbound_messages investment_calculations
  investment_notes investor_alerts investor_profiles invoice_drafts invoice_reminders invoices legal_basis_checks
  licence_data_exports licence_tariffs licensed_assets life_tables listing_drafts listing_settings
  listing_translation_validations listing_translations listing_validations listing_versions listing_views
  mailbox_attachments mailbox_drafts mailbox_mails mandate_clause_versions mandate_early_starts
  mandate_price_gap_settings mandate_questionnaires mandate_register mandate_register_settings mandate_source_costs
  mandate_source_decisions mandate_tasks mandate_withdrawals mandates market_rent_imports mcp_drafts message_kinds
  message_subjects messages missed_promise_tasks morning_reports neighbourhood_campaigns neighbourhood_drafts
  neighbourhood_facts neighbourhood_letters network_discount_dismissals network_discounts network_news
  network_news_deliveries new_programs newsletter_editions newsletter_letters newsletter_unsubscribe_tokens
  notary_draft_differences notary_drafts offer_checks offer_proposals offer_register offer_responses offer_tasks
  offer_transmissions offer_untransmitted_alerts offline_ops old_contact_followups old_contact_moments outbound_refs
  owner_booklets partner_addresses partner_agencies partner_credential_alerts partner_credentials partner_documents
  partner_followups partner_optouts partner_prospect_mails partner_prospect_optouts partner_prospects
  partner_recommendation_submissions partner_recommendation_withheld partner_recommendations partner_referrals
  partner_reviews partner_zones partners pending_human_replies person_identifiers person_merges
  person_name_corrections person_relations person_requests persons phase1_app_inventories phase1_day_readings
  phase1_outside_sends phase_openings photo_certificates photo_exports photo_guide_shots photo_guide_validations
  phrase_searches pige_ad_energy pige_ad_sightings pige_address_proposals pige_ads pige_drafts pige_no_agency
  pige_oppositions pige_properties pige_property_keys pilot_agents pilot_before_declarations pilotage_alerts
  pilotage_settings pre_contract_briefs pre_contract_deposits presentation_ratings price_versions price_zones
  pro_send_log pro_sends project_properties projects proof_publication_cache proof_seals properties property_alerts
  property_communes property_details property_key_loans property_keys property_links property_on_sale
  property_sheets proposal_tasks prospect_retention_cycles prospecting_sequence_steps prospecting_sequences
  public_content_posts public_contents public_sites qualification_corrections qualifications quiz_attempts
  quiz_attestations quiz_questions reception_log recruiting_answers recruiting_commune_decisions
  recruiting_content_withdrawals recruiting_contents recruiting_tasks referral_requests referral_settings referrals
  region_decisions registered_letter_events registered_letters registry_review_alerts registry_reviews
  remote_slip_signatures remote_visits rental_ads rental_applications rental_handovers rental_inventories
  rental_lease_copies rental_lease_signatures rental_lease_templates rental_leases rental_listings
  rental_management_links rental_piece_findings rental_presentations rental_sends reprise_avancement reprise_depots
  review_requests risk_sheets risk_statements risk_validations safety_alerts sale_commissions sale_file_closings
  sale_file_dates sale_file_financing sale_file_financing_alerts sale_file_fund_alerts sale_file_pieces
  sale_file_reminders sale_file_sellers sale_file_stops sale_file_tasks sale_files sandbox_runs sandbox_steps
  satisfaction_answers satisfaction_tokens security_challenges security_devices security_sessions security_step_ups
  send_log send_quota_slots send_reservations seo_signals service_commitments shop_orders shop_tariffs
  sign_pickup_tasks sign_placements sign_removals signature_circuit_annexes signature_circuit_events
  signature_circuit_signers signature_circuits signature_sessions signed_amendments signed_documents signs
  site_legal_mentions site_page_views social_calendar_rules social_calendar_slots social_posts software_licences
  sources sponsorships studio_option_requests supplier_invoice_reads supplier_invoices suspicion_decisions
  suspicion_reports thank_you_tasks training_cases training_sessions valuation_deliveries valuation_market_snapshots
  valuation_reports value_tracking value_tracking_alerts verified_review_invites verified_reviews
  viager_calculations video_montages video_text_checks vigilance_alerts vigilance_decisions vigilance_settings
  virtual_stagings virtual_tour_contacts virtual_tours visit_dossiers visit_field_notes visit_photos visit_reports
  visit_safety visit_shot_skips visit_slip_templates visit_slips visit_tasks visits vitrine_screens
  voice_assistant_calls voice_assistant_lines voice_notes weekly_points
`.trim().split(/\s+/);

/** Les autres tables : un chemin vers une table reprise, ou la raison de les laisser. */
export const CARTE_REPRISE_AUTRES: Readonly<Record<string, EntreeReprise>> = {
  ad_campaign_approvals: { via: [['campaign_id', 'ad_campaigns', 'id']] },
  ad_campaign_launches: { via: [['approval_id', 'ad_campaign_starts', 'approval_id']] },
  ad_campaign_repauses: { via: [['approval_id', 'ad_campaign_stops', 'approval_id']] },
  ad_campaign_spend: { via: [['campaign_id', 'ad_campaigns', 'id']] },
  ad_campaign_starts: { via: [['campaign_id', 'ad_campaigns', 'id'], ['approval_id', 'ad_campaign_approvals', 'id']] },
  ad_campaign_stops: { via: [['campaign_id', 'ad_campaigns', 'id'], ['approval_id', 'ad_campaign_approvals', 'id']] },
  agency_delegation_files: { via: [['file_id', 'sale_files', 'id'], ['delegation_id', 'agency_delegations', 'id']] },
  agency_delegation_steps: { via: [['delegation_id', 'agency_delegations', 'id']] },
  agency_visits_done: { via: [['visit_id', 'agency_visits', 'id']] },
  agenda_cursors: { via: [['agent_id', 'agents', 'id']], sansCle: 'Le curseur de l\'agenda d\'un agent : la colonne `agent_id` n\'a pas de clé étrangère.' },
  agent_likeness_revocations: { via: [['consent_id', 'agent_likeness_consents', 'id']] },
  agent_push_trial_outbox: { via: [['push_id', 'agent_push_sends', 'push_id']] },
  appointment_calendar: { via: [['appointment_id', 'appointments', 'id']] },
  appointment_holds: { via: [['agent_id', 'agents', 'id']], sansCle: 'Les créneaux tenus d\'un agent : la colonne `agent_id` n\'a pas de clé étrangère.' },
  appointment_links: { via: [['appointment_id', 'appointments', 'id']] },
  appointment_reminders: { via: [['appointment_id', 'appointments', 'id']] },
  assistance_alerts: { via: [['request_id', 'assistance_requests', 'id']] },
  attach_claims: { via: [['inbound_id', 'inbound_messages', 'id']] },
  base_copy_alerts: { hors: 'technique', why: 'Alerte de la copie de chaque nuit, pour la base entière : aucun réseau.' },
  base_copy_runs: { hors: 'technique', why: 'Passage de la copie de chaque nuit, pour la base entière : aucun réseau.' },
  base_restore_receipts: { hors: 'technique', why: 'Reçu du test de restauration, pour la base entière : aucun réseau.' },
  call_journal: { via: [['call_id', 'calls', 'id']] },
  client_space_favorite_removals: { via: [['favorite_id', 'client_space_favorites', 'id']] },
  client_space_link_revocations: { via: [['link_id', 'client_space_links', 'id']] },
  client_space_link_uses: { via: [['link_id', 'client_space_links', 'id']] },
  client_space_session_closures: { via: [['session_id', 'client_space_sessions', 'id']] },
  commission_agency_shares: { via: [['delegation_id', 'agency_delegations', 'id'], ['file_id', 'commissions', 'file_id']] },
  commission_payout_alerts: { via: [['file_id', 'commission_receipts', 'file_id']] },
  commission_shares: { via: [['file_id', 'commissions', 'file_id']] },
  commission_steps: { via: [['file_id', 'commissions', 'file_id']] },
  data_breach_alerts: { via: [['breach_id', 'data_breaches', 'id']] },
  data_breach_evaluations: { via: [['breach_id', 'data_breaches', 'id']] },
  data_breach_notifications: { via: [['breach_id', 'data_breaches', 'id']] },
  data_breach_persons: { via: [[['breach_id', 'version'], 'data_breach_evaluations', ['breach_id', 'version']], ['person_id', 'persons', 'id']] },
  data_breach_restores: { via: [['cut_id', 'data_breach_cuts', 'id']] },
  diffusion_portal_resumptions: { via: [['suspension_id', 'diffusion_portal_suspensions', 'id']] },
  diffusion_portal_task_closures: { via: [['task_id', 'diffusion_portal_tasks', 'id']] },
  diffusion_portal_text_validations: { via: [['text_id', 'diffusion_portal_texts', 'id']] },
  first_reply_claims: { via: [['inbound_id', 'inbound_messages', 'id']] },
  freeze_registry_entries: { via: [['version_id', 'freeze_registry_versions', 'id']] },
  gbp_validations: { via: [['draft_id', 'gbp_drafts', 'id']] },
  invoice_facturx: { via: [['invoice_id', 'invoices', 'id']] },
  invoice_transmission_claims: { via: [['invoice_id', 'invoices', 'id']] },
  invoice_transmissions: { via: [['invoice_id', 'invoices', 'id']] },
  journal: { hors: 'commun', why: 'Le journal est commun à toute la base et chaîné ligne à ligne : ses lignes ne portent pas de réseau, et en sortir une partie casserait la chaîne.' },
  licence_states: { via: [['licence_id', 'software_licences', 'id']] },
  licensed_asset_withdrawals: { via: [['asset_id', 'licensed_assets', 'id']] },
  life_table_rows: { via: [['table_id', 'life_tables', 'id']] },
  listing_pushes: { via: [['version_id', 'listing_versions', 'id']] },
  listing_sync_leases: { hors: 'technique', why: 'Bail de quelques minutes posé pendant une synchronisation des annonces : un jeton, aucune donnée.' },
  mailbox_attachment_links: { via: [['attachment_id', 'mailbox_attachments', 'id'], ['mail_id', 'mailbox_mails', 'id']] },
  mandate_clause_validations: { via: [['clause_id', 'mandate_clause_versions', 'id']] },
  mandate_questionnaire_gap_acks: { via: [['questionnaire_id', 'mandate_questionnaires', 'id']] },
  market_rents: { via: [['import_id', 'market_rent_imports', 'id']] },
  neighbourhood_validations: { via: [['draft_id', 'neighbourhood_drafts', 'id']] },
  network_discount_withdrawals: { via: [['discount_id', 'network_discounts', 'id']] },
  network_news_withdrawals: { via: [['news_id', 'network_news', 'id']] },
  networks: { soi: 'id' },
  new_program_lot_versions: { via: [['program_id', 'new_programs', 'id']] },
  owner_booklet_links: { via: [[['file_id', 'person_id'], 'owner_booklets', ['file_id', 'person_id']]] },
  partner_recommendation_race_guard: { hors: 'technique', why: 'Table de garde, vide par construction.' },
  partner_referral_disclosures: { via: [['referral_id', 'partner_referrals', 'id']] },
  partner_referral_fees: { via: [['partner_id', 'partners', 'id'], ['referral_id', 'partner_referrals', 'id']] },
  partner_referral_options: { via: [['partner_id', 'partners', 'id'], ['referral_id', 'partner_referrals', 'id']] },
  partner_referral_steps: { via: [['partner_id', 'partners', 'id'], ['referral_id', 'partner_referrals', 'id']] },
  partner_review_reads: { via: [['review_id', 'partner_reviews', 'id']] },
  person_request_alerts: { via: [['request_id', 'person_requests', 'id']] },
  person_request_answers: { via: [['request_id', 'person_requests', 'id']] },
  person_request_outputs: { via: [['request_id', 'person_requests', 'id']] },
  pige_handovers: { via: [['draft_id', 'pige_drafts', 'id']] },
  postgres_decisions: { hors: 'technique', why: 'Décision du passage à PostgreSQL, pour la base entière : aucun réseau.' },
  postgres_threshold_alerts: { hors: 'technique', why: 'Alerte des seuils du passage à PostgreSQL, pour la base entière : aucun réseau.' },
  postgres_threshold_readings: { hors: 'technique', why: 'Mesure des seuils du passage à PostgreSQL, pour la base entière : aucun réseau.' },
  price_cell_sales: { via: [[['version_id', 'area_id', 'kind'], 'price_cells', ['version_id', 'area_id', 'kind']]] },
  price_cells: { via: [['from_version_id', 'price_versions', 'id'], ['area_id', 'price_zones', 'id'], ['version_id', 'price_versions', 'id']] },
  price_zone_retirements: { via: [['area_id', 'price_zones', 'id']] },
  pro_trial_outbox: { via: [['send_id', 'pro_sends', 'id']] },
  property_key_retirements: { via: [['key_id', 'property_keys', 'id']] },
  property_key_returns: { via: [['loan_id', 'property_key_loans', 'id']] },
  proposal_responses: { via: [['proposal_id', 'offer_proposals', 'id']] },
  proposal_transmissions: { via: [['proposal_id', 'offer_proposals', 'id']] },
  prospect_retention_outcomes: { via: [['cycle_id', 'prospect_retention_cycles', 'id']] },
  rental_ad_validations: { via: [['ad_id', 'rental_ads', 'id']] },
  rental_annexes: { via: [['listing_id', 'rental_listings', 'id']] },
  rental_application_pieces: { via: [['application_id', 'rental_applications', 'id']] },
  rental_checks: { via: [[['listing_id', 'facts_version'], 'rental_facts', ['listing_id', 'version']], ['listing_id', 'rental_listings', 'id']] },
  rental_choices: { via: [['application_id', 'rental_applications', 'id'], ['presentation_id', 'rental_presentations', 'id'], ['listing_id', 'rental_listings', 'id']] },
  rental_facts: { via: [['listing_id', 'rental_listings', 'id']] },
  rental_fairness_receipts: { via: [['presentation_id', 'rental_presentations', 'id']] },
  rental_fees: { via: [[['listing_id', 'facts_version'], 'rental_facts', ['listing_id', 'version']], ['listing_id', 'rental_listings', 'id']] },
  rental_guarantors: { via: [['application_id', 'rental_applications', 'id']] },
  rental_inventory_copies: { via: [['inventory_id', 'rental_inventories', 'id']] },
  rental_inventory_signatures: { via: [['inventory_id', 'rental_inventories', 'id']] },
  rental_lease_copy_deliveries: { via: [['lease_id', 'rental_lease_copies', 'lease_id']] },
  rental_listing_communes: { via: [['listing_id', 'rental_listings', 'id']] },
  rental_owner_notices: { via: [['listing_id', 'rental_listings', 'id']] },
  rental_piece_deposits: { via: [['application_id', 'rental_applications', 'id']] },
  rental_zones: { hors: 'public', why: 'Zonage public des communes (zones tendues), commun à tous : aucun réseau.' },
  reprise_depot_morceaux: { via: [['depot_id', 'reprise_depots', 'id']] },
  sale_file_steps: { via: [['file_id', 'sale_files', 'id']] },
  sale_files_recopie: { hors: 'technique', why: 'Trace d\'une recopie de la base faite une fois : aucun réseau.' },
  scheduled_runs: { hors: 'technique', why: 'Passage du planificateur, pour la base entière : aucun réseau.' },
  schema_migrations: { hors: 'technique', why: 'Les migrations appliquées à la base : aucun réseau.' },
  shop_order_results: { via: [['order_id', 'shop_order_sends', 'order_id']] },
  shop_order_sends: { via: [['order_id', 'shop_order_validations', 'order_id']] },
  shop_order_validations: { via: [['order_id', 'shop_orders', 'id']] },
  social_calendar_outcomes: { via: [['slot_id', 'social_calendar_runs', 'slot_id']] },
  social_calendar_runs: { via: [['slot_id', 'social_calendar_slots', 'id']] },
  social_post_attempts: { via: [['post_id', 'social_posts', 'id']] },
  social_post_sends: { via: [['attempt_id', 'social_post_attempts', 'id']] },
  social_post_validations: { via: [['post_id', 'social_posts', 'id']] },
  social_visual_checks: { via: [['post_id', 'social_posts', 'id']] },
  training_turns: { via: [['session_id', 'training_sessions', 'id']] },
  trial_outbox: { via: [['message_id', 'messages', 'id']] },
  valuation_follow_ups: { via: [['report_id', 'valuation_deliveries', 'report_id']] },
  value_tracking_sends: { via: [['tracking_id', 'value_tracking', 'id']] },
  vitrine_screen_switches: { via: [['screen_id', 'vitrine_screens', 'id']] },
};

/**
 * Les colonnes masquées dans le fichier : jetons, codes et empreintes de clés, des secrets de sécurité qui ouvriraient
 * un lien ou une séance. Chaque secret de la carte des demandes d'accès y est, et chaque colonne dont le nom dit un
 * jeton, un code, un mot de passe ou un secret (test).
 */
export const COLONNES_MASQUEES: Readonly<Record<string, readonly string[]>> = {
  access_invitations: ['token_sha256'],
  access_keys: ['sha256'],
  after_sale_unsubscribe_tokens: ['token_hash'],
  alert_unsubscribe_tokens: ['token_hash'],
  appointment_links: ['token_hash'],
  appointments: ['token_hash'],
  assistant_keys: ['sha256'],
  business_dossier_links: ['token_hash'],
  business_dossier_open_codes: ['code_hash'],
  business_nda_signatures: ['code_hash'],
  client_space_links: ['token_hash'],
  client_space_sessions: ['token_hash'],
  gbp_reviews: ['author_token_hashes'],
  listing_sync_leases: ['token'],
  newsletter_unsubscribe_tokens: ['token_hash'],
  owner_booklet_links: ['token_hash'],
  partner_prospect_mails: ['optout_token_sha256'],
  partner_recommendation_withheld: ['identifier_sha256'],
  photo_certificates: ['token'],
  photo_exports: ['certificate_token'],
  referral_requests: ['key_hash'],
  remote_slip_signatures: ['code_hash', 'token_hash'],
  rental_lease_signatures: ['code_hash'],
  satisfaction_tokens: ['token_hash'],
  security_sessions: ['token_hash'],
  signature_sessions: ['code_hash'],
  verified_review_invites: ['token_hash'],
  virtual_stagings: ['real_token', 'staged_token'],
  visit_dossiers: ['token_hash'],
  visit_safety: ['code_hash'],
};
