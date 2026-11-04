// SV11 · Un commerce devient disponible par sa présentation validée, sans annonce ni portail : son chemin à lui, car il n'a jamais de
// version d'annonce. Disponible, il est vu des repreneurs ; la porte de la diffusion décide toujours [R42]. Seuls `draft` et `available`
// bougent, jamais une offre ni une vente. Aucun envoi, aucun nom, aucune adresse : le journal ne porte que des codes [R13, R19].
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { BUSINESS_KINDS } from './fiche.ts';
import type { PresentationCommerce } from './presentation.ts';
import type { BusinessDiffusionGate } from './repreneurs.ts';

const ACTOR = 'system:commerces';

export class DisponibiliteCommerces {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly presentations: Pick<PresentationCommerce, 'publishable'>,
    private readonly diffusion: BusinessDiffusionGate,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Un passage pour le réseau. Un commerce en erreur n'arrête pas les autres : l'échec va au journal, sans le texte de l'erreur. */
  async syncAll(networkId: string): Promise<number> {
    // Un bien qui a une version d'annonce suit `Publication` : deux chemins ne décident pas du même statut.
    const rows = await this.db.all<{ id: string; status: string }>(
      `SELECT p.id, p.status FROM properties p WHERE p.network_id = ? AND p.status IN ('draft', 'available') AND p.kind IN (${BUSINESS_KINDS.map(() => '?').join(', ')})
         AND NOT EXISTS (SELECT 1 FROM listing_versions v WHERE v.property_id = p.id) ORDER BY p.id`,
      [networkId, ...BUSINESS_KINDS],
    );
    let moved = 0;
    for (const r of rows) {
      try {
        if (await this.syncOne(networkId, r.id, r.status)) moved += 1;
      } catch {
        await appendEvent(this.journal, { type: 'commerce.passage_echec', actor: ACTOR, subject: `property:${r.id}`, data: { rule: 'R42' } }, this.now);
      }
    }
    return moved;
  }

  private async syncOne(networkId: string, propertyId: string, status: string): Promise<boolean> {
    const open = (await this.diffusion.canDiffuse(networkId, propertyId, this.now())).allowed && (await this.presentations.publishable(networkId, propertyId)) !== null;
    if (open === (status === 'available')) return false;
    // Un commerce repris d'un ancien outil, jamais passé par ici, garde son statut : ce chemin ne reprend que ce qu'il a donné.
    if (!open && !(await this.givenHere(propertyId))) return false;
    const [from, to, type] = open ? ['draft', 'available', 'bien.disponible'] : ['available', 'draft', 'bien.plus_disponible'];
    const { changes } = await this.db.run('UPDATE properties SET status = ?, updated_at = ? WHERE id = ? AND network_id = ? AND status = ?', [to, this.now().toISOString(), propertyId, networkId, from]);
    if (changes !== 1) return false;
    await appendEvent(this.journal, { type, actor: ACTOR, subject: `property:${propertyId}`, data: { rule: 'R42' } }, this.now);
    return true;
  }

  private async givenHere(propertyId: string): Promise<boolean> {
    return (await this.journal.bySubject(`property:${propertyId}`)).some((e) => e.type === 'bien.disponible' && e.actor === ACTOR);
  }
}

/** Un commerce sans annonce : ses alertes passent par son propre chemin, les repreneurs, jamais par les alertes aux acquéreurs [R110]. */
export async function isUnlistedBusiness(db: SqlDatabase, propertyId: string): Promise<boolean> {
  return (
    (await db.first(
      `SELECT 1 FROM properties p WHERE p.id = ? AND p.kind IN (${BUSINESS_KINDS.map(() => '?').join(', ')}) AND NOT EXISTS (SELECT 1 FROM listing_versions v WHERE v.property_id = p.id)`,
      [propertyId, ...BUSINESS_KINDS],
    )) !== null
  );
}
