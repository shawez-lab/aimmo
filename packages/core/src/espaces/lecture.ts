/**
 * Ce que les lecteurs SQL des espaces partagent (EC08, EC09) [R161].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import type { SourcePerson } from './vendeur.ts';

export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Les mandats qui font d'une personne le mandant d'un bien : inscrits, ni annulés ni rétractés. */
export const LIVE_MANDATES = `
  SELECT m.id, m.property_id, m.person_id, m.signed_at FROM mandates m
  WHERE m.network_id = ? AND m.property_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM mandate_register r WHERE r.network_id = m.network_id AND r.mandate_id = m.id AND r.kind = 'inscription'
                AND NOT EXISTS (SELECT 1 FROM mandate_register c WHERE c.network_id = r.network_id AND c.kind = 'annulation' AND c.cancels_seq = r.seq))
    AND NOT EXISTS (SELECT 1 FROM mandate_withdrawals w WHERE w.mandate_id = m.id)`;

/** Les titres des documents rangés par M06 que l'espace sait nommer ; les autres sont « Document ». */
export const DOCUMENT_TITLES: Record<string, string> = {
  mandat_vente_simple: 'Mandat de vente simple',
  mandat_vente_exclusif: 'Mandat de vente exclusif',
  avenant_mandat: 'Avenant au mandat',
};

/** Ce qui identifie une personne, dans toutes ses fiches réunies, pour la retenir de tout texte [R161]. */
export async function sourcePerson(db: SqlDatabase, fiche: FicheUnique, personId: string): Promise<SourcePerson> {
  const members = await fiche.membersOf(personId);
  const q = placeholders(members.length);
  const names = await db.all<{ first_name: string | null; last_name: string | null }>(`SELECT first_name, last_name FROM person_known_names WHERE id IN (${q})`, members);
  const ids = await db.all<{ kind: string; value: string }>(`SELECT kind, value FROM person_identifiers WHERE person_id IN (${q})`, members);
  return {
    personId,
    firstName: names.map((n) => n.first_name).filter(Boolean).join(' ') || null,
    lastName: names.map((n) => n.last_name).filter(Boolean).join(' ') || null,
    emails: ids.filter((i) => i.kind === 'email').map((i) => i.value),
    phones: ids.filter((i) => i.kind === 'phone' || i.kind === 'whatsapp').map((i) => i.value),
  };
}
