/** Types des lignes de la fiche client unique, d'après db/migrations/0001_fiche_client.sql. */

export const IDENTIFIER_KINDS = ['email', 'phone', 'instagram', 'facebook', 'whatsapp'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export const CHANNELS = ['email', 'phone', 'sms', 'instagram', 'facebook', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];
export type MessageChannel = Channel | 'site';
/**
 * Canaux de sortie : ceux de la fiche, plus la session de l'assistant du site (C08). Sur celle-ci on ne fait que
 * répondre au visiteur, dans sa session : aucun accord, aucune exclusion ne s'y note par canal.
 */
export const OUTBOUND_CHANNELS = [...CHANNELS, 'site'] as const;
export type OutboundChannelName = (typeof OUTBOUND_CHANNELS)[number];

export const EXCLUSION_REASONS = ['network_list', 'stop', 'refused', 'sold', 'followed_elsewhere'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const PROJECT_KINDS = [
  'sell',
  'buy',
  'rent_out',
  'rent',
  'invest',
  'sell_business',
  'buy_business',
  'valuation',
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export type PropertyKind = 'home' | 'land' | 'building' | 'commercial' | 'business_walls' | 'business';
export type PropertyStatus = 'draft' | 'available' | 'under_offer' | 'sold' | 'rented' | 'withdrawn';
export type ContactStatus = 'new' | 'active' | 'inactive';
export type AgentStatus = 'active' | 'left';
export type ProjectPropertyRole = 'owned' | 'interested' | 'proposed';
export type MessageDirection = 'in' | 'out';
export type MessageAuthor = 'person' | 'agent' | 'ai' | 'system';

/** Colonnes communes : chaque ligne porte le réseau, et l'agent quand il est connu. */
export interface Scoped {
  network_id: string;
  agent_id: string | null;
}

export interface Network {
  id: string;
  name: string;
  created_at: string;
}

export interface Agent {
  id: string;
  network_id: string;
  first_name: string;
  last_name: string;
  zone: string | null;
  status: AgentStatus;
  sponsor_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Person extends Scoped {
  id: string;
  first_name: string | null;
  last_name: string | null;
  language: string;
  contact_status: ContactStatus;
  last_contact_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonIdentifier extends Scoped {
  id: string;
  person_id: string;
  kind: IdentifierKind;
  value: string;
  created_at: string;
}

export interface Consent extends Scoped {
  id: string;
  person_id: string;
  purpose: string;
  channel: Channel;
  proof: string;
  given_at: string;
  withdrawn_at: string | null;
  created_at: string;
}

export interface Exclusion extends Scoped {
  id: string;
  person_id: string;
  reason: ExclusionReason;
  /** null : tous les canaux. */
  channel: Channel | null;
  noted_at: string;
  lifted_at: string | null;
  created_at: string;
  /** La fusion défaite qui a recopié cette ligne ; sa date de création reste celle de l'original [AC08]. */
  undone_merge_id?: string | null;
}

export interface Project extends Scoped {
  id: string;
  person_id: string;
  kind: ProjectKind;
  stage: string;
  deadline: string | null;
  budget_min_eur: number | null;
  budget_max_eur: number | null;
  /** Critères en JSON. */
  criteria: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Source extends Scoped {
  id: string;
  person_id: string;
  project_id: string | null;
  channel: string;
  detail: string | null;
  occurred_at: string;
  created_at: string;
}

export interface Property extends Scoped {
  id: string;
  reference: string;
  kind: PropertyKind;
  postal_code: string | null;
  city: string | null;
  surface_m2: number | null;
  rooms: number | null;
  price_eur: number | null;
  status: PropertyStatus;
  created_at: string;
  updated_at: string;
  /** Pour un logement (« home ») : maison ou appartement ; null tant qu'on ne sait pas (AU070). */
  dwelling?: Dwelling | null;
}

/** Maison ou appartement, pour un logement du socle (AU070). */
export const DWELLINGS = ['house', 'apartment'] as const;
export type Dwelling = (typeof DWELLINGS)[number];

export interface ProjectProperty extends Scoped {
  project_id: string;
  property_id: string;
  role: ProjectPropertyRole;
  created_at: string;
}

export interface Message extends Scoped {
  id: string;
  person_id: string;
  project_id: string | null;
  conversation_id: string | null;
  channel: MessageChannel;
  direction: MessageDirection;
  author_kind: MessageAuthor;
  body: string;
  cost_cents: number;
  occurred_at: string;
  created_at: string;
}

export interface PersonMerge extends Scoped {
  id: string;
  survivor_id: string;
  merged_id: string;
  reason: string;
  merged_at: string;
  undone_at: string | null;
  created_at: string;
}
