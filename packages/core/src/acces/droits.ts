import type { PropertyStatus } from '../db/types.ts';

/**
 * Droits d'accès par rôle [R16]. Une décision pure : qui voit quoi, et pourquoi.
 * Lecture prudente : tout ce qui n'est pas permis ici est refusé.
 */
export const ROLES = ['agent', 'direction', 'compliance', 'partner', 'assistant', 'accountant'] as const;
export type Role = (typeof ROLES)[number];

/**
 * AU107 · les rôles à accès limité : chacun a sa propre clé, jamais celle d'un agent ou de la direction, et n'atteint
 * que les routes nommées pour lui, par une liste fermée vérifiée avant toute autre porte.
 *
 * - `assistant` (l'assistante) : le fichier commun du réseau, bien par bien, sans aucune fiche de client.
 * - `accountant` (le comptable) : les factures fournisseurs rangées, les rapprochements bancaires et la fraîcheur du
 *   relevé, en lecture seule ; ni fiche, ni bien, ni geste.
 */
export const LIMITED_ROLE_ROUTES: Readonly<Partial<Record<Role, readonly string[]>>> = {
  assistant: ['bien'],
  accountant: ['finances.fournisseurs', 'finances.banque.rapprochements', 'finances.banque.fraicheur'],
};

/** Qui lit. Pour un agent, `userId` est son identifiant dans la table `agents`. */
export interface Viewer {
  role: Role;
  networkId: string;
  userId: string;
}

/** Statuts d'un bien qui forment le fichier commun du réseau, visible de tous ses agents. */
export const SHARED_PROPERTY_STATUSES: readonly PropertyStatus[] = ['available', 'under_offer'];

export type Resource =
  /** Une fiche client : `agentIds` porte l'agent de chaque fiche réunie dans la fiche gardée. */
  | { kind: 'person'; networkId: string; agentIds: readonly (string | null)[] }
  | { kind: 'property'; networkId: string; agentId: string | null; status: PropertyStatus }
  /** Les chiffres d'un agent : mandats, ventes, commissions. */
  | { kind: 'figures'; networkId: string; agentId: string }
  /** Le journal d'audit d'une fiche. */
  | { kind: 'journal'; networkId: string }
  /** Pièces d'identité et contrôles anti-blanchiment, rangés hors de la fiche [R15]. */
  | { kind: 'compliance_vault'; networkId: string };

export type ResourceKind = Resource['kind'];

/** `agent_file_incomplete` : un agent dont le dossier d'agent n'est pas complet et valide ce jour-là [R82]. */
export type RefusalCode = 'other_network' | 'not_assigned' | 'role' | 'unknown' | 'agent_inactive' | 'agent_file_incomplete';

export type AccessDecision =
  | { allowed: true; rule: 'R16'; view: 'full' | 'shared' }
  | { allowed: false; rule: 'R16'; code: RefusalCode };

const allow = (view: 'full' | 'shared' = 'full'): AccessDecision => ({ allowed: true, rule: 'R16', view });
const refuse = (code: RefusalCode): AccessDecision => ({ allowed: false, rule: 'R16', code });

/** Ce que chaque rôle hors agent peut lire, dans son propre réseau seulement. */
const ROLE_ACCESS: Record<Exclude<Role, 'agent'>, readonly ResourceKind[]> = {
  // La direction attribue les clients et suit le réseau ; les données anti-blanchiment ne sont visibles
  // que du responsable de la conformité.
  direction: ['person', 'property', 'figures', 'journal'],
  // La conformité traite les demandes des personnes et les contrôles ; elle n'a pas besoin des chiffres.
  compliance: ['person', 'property', 'journal', 'compliance_vault'],
  // Un partenaire ne voit rien tant qu'une mise en relation, avec l'accord du client, ne lui ouvre pas
  // un dossier précis (M18).
  partner: [],
  // L'assistante : les biens du fichier commun seuls (voir plus bas) ; le comptable : rien par cette porte.
  assistant: ['property'],
  accountant: [],
};

export function decideAccess(viewer: Viewer, resource: Resource): AccessDecision {
  if (!(ROLES as readonly string[]).includes(viewer.role)) return refuse('role');
  if (viewer.networkId !== resource.networkId) return refuse('other_network');

  // L'assistante ne lit que le fichier commun, comme un agent lit un bien qui n'est pas le sien [AU107].
  if (viewer.role === 'assistant') {
    return resource.kind === 'property' && SHARED_PROPERTY_STATUSES.includes(resource.status) ? allow('shared') : refuse('role');
  }
  if (viewer.role !== 'agent') {
    return ROLE_ACCESS[viewer.role].includes(resource.kind) ? allow() : refuse('role');
  }

  const me = viewer.userId;
  switch (resource.kind) {
    case 'person': {
      // L'agent voit la fiche s'il la suit, et qu'aucune fiche réunie n'est suivie par un autre agent.
      const assigned = resource.agentIds.filter((id): id is string => id !== null);
      return assigned.length > 0 && assigned.every((id) => id === me) ? allow() : refuse('not_assigned');
    }
    case 'property':
      if (resource.agentId === me) return allow();
      // Fichier commun : les biens en vente du réseau, sans aucune donnée de client.
      return SHARED_PROPERTY_STATUSES.includes(resource.status) ? allow('shared') : refuse('not_assigned');
    case 'figures':
      return resource.agentId === me ? allow() : refuse('not_assigned');
    case 'journal':
    case 'compliance_vault':
      return refuse('role');
  }
}
