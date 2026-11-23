/**
 * AU014 · La location sous mandat de location en cours (M15) [R42, R100].
 *
 * Un professionnel ne loue que sous un mandat écrit, signé et inscrit au registre. Ici, la porte de la diffusion (R42),
 * lue pour l'objet « location » : un mandat de location signé, inscrit, ni annulé, ni rétracté, ni échu, hors délai
 * de rétractation. Un mandat de vente n'ouvre pas la location. Sans elle, aucune annonce locative n'est publiable et
 * aucun barème d'honoraires du logement ne se range.
 */
import { Acces } from '../acces/acces.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { Diffusion, type DiffusionDecision } from '../documents/retractation.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import type { JournalStore } from '../journal/types.ts';

/** Ce que la location demande à la porte de la diffusion, pour un bien. */
export interface RentalMandateGate {
  canDiffuse(networkId: string, propertyId: string, at?: Date, object?: 'vente' | 'location'): Promise<DiffusionDecision>;
}

export function rentalMandateGate(db: SqlDatabase, journal: JournalStore, now: () => Date): RentalMandateGate {
  const store = new FicheClient(db, { now });
  return new Diffusion(db, new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now }), journal, { now });
}

/** Le mandat de location du bien est-il en cours à cet instant ? */
export async function rentalMandateInForce(gate: RentalMandateGate, networkId: string, propertyId: string, at: Date): Promise<boolean> {
  return (await gate.canDiffuse(networkId, propertyId, at, 'location')).allowed;
}
