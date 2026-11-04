// Le prix à montrer d'un bien publié : celui de son annonce [R44], avenants et honoraires compris, jamais celui de la fiche.
import type { SqlDatabase } from '../db/sql.ts';

/** Le prix de la dernière version de l'annonce ; sans annonce en ligne, le prix de la fiche. */
export async function shownPrice(db: SqlDatabase, propertyId: string, sheetPriceEur: number | null): Promise<number | null> {
  const v = await db.first<{ state: string; price_eur: number | null }>('SELECT state, price_eur FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
  return v && v.state !== 'retiree' && v.price_eur !== null ? Number(v.price_eur) : sheetPriceEur;
}
