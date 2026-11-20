/**
 * L'empreinte d'un identifiant, gardée à la place de sa valeur après un effacement réel (AU020c) [R04, R17].
 *
 * Décidé, lecture prudente :
 * - l'empreinte est le SHA-256 du réseau et de la clé de rapprochement (`matchKey`) de la valeur normalisée : un numéro
 *   WhatsApp et le même numéro de téléphone donnent la même empreinte, comme ils désignent la même personne ;
 * - elle est rangée dans la même colonne que la valeur, préfixée `#sha256:` : aucune valeur normalisée ne commence par
 *   `#`, donc les deux ne se confondent jamais ;
 * - ce n'est pas un anonymat : qui connaît déjà l'adresse peut la reconnaître, et c'est voulu, pour que l'arrêt de la
 *   personne tienne quand elle écrit de nouveau. Une clé secrète (empreinte à clé) renforcerait la garde contre
 *   l'essai de tous les numéros ; elle demanderait un secret rangé au Worker, non prévu ici ;
 * - une fiche qui porte au moins une empreinte est une fiche effacée : on ne lui rajoute plus rien en clair.
 */
import type { IdentifierKind } from '../db/types.ts';
import { matchKey, normalizeIdentifier } from './normalize.ts';

export const HASHED_PREFIX = '#sha256:';

export function isHashedIdentifier(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(HASHED_PREFIX);
}

/** L'empreinte d'une valeur déjà normalisée. */
export async function identifierHash(networkId: string, kind: IdentifierKind, normalized: string): Promise<string> {
  const bytes = new TextEncoder().encode(`aimmo-identifiant\n${networkId}\n${matchKey(kind, normalized)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return HASHED_PREFIX + Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Les deux formes sous lesquelles une valeur saisie peut être rangée : en clair normalisée, et son empreinte. Vide si la
 * valeur n'est pas un identifiant valable.
 */
export async function storedForms(networkId: string, kind: IdentifierKind, raw: string): Promise<string[]> {
  const value = normalizeIdentifier(kind, raw);
  if (value === null) return [];
  return [value, await identifierHash(networkId, kind, value)];
}
