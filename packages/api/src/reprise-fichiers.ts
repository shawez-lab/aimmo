/**
 * Le stockage R2 des fichiers déposés de l'agence sous licence, derrière `StockageFichiersPlages` (BR82, RC45, RC46)
 * [R663, R666, R667].
 *
 * Décidé, lecture prudente :
 *   - les pièces citées par le fichier de reprise vivent dans les compartiments des médias (`MEDIA`), des pièces
 *     (`PIECES`) et des dossiers des commerces (`COMMERCES`) ; le coffre de la conformité (`COFFRE`) n'est jamais donné
 *     ici, et le cœur ne lit jamais une clé `coffre/` [R663] ;
 *   - une référence n'est lue que dans le seul compartiment qui l'a. Trouvée dans deux, elle est dite absente : AIMMO
 *     ne devine pas laquelle est la pièce de l'agence [R663] ;
 *   - la taille vient de `head`, une plage de `get` avec `range` : une pièce n'est jamais lue entière pour être mesurée.
 *     Une panne d'un compartiment remonte ; le cœur la dit « absente » [R663].
 */
import type { StockageFichiersPlages } from '../../core/src/licences/index.ts';

/** Ce que R2 sait faire, réduit à ce que la reprise emploie. */
export interface R2PlagesBucket {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** Un compartiment qui sait `head` et `get` ; sinon `null`, et il n'est pas lu. */
export function plagesBucket(bucket: unknown): R2PlagesBucket | null {
  const b = bucket as Partial<R2PlagesBucket> | null | undefined;
  return b && typeof b.head === 'function' && typeof b.get === 'function' ? (b as R2PlagesBucket) : null;
}

export class R2FichiersPlages implements StockageFichiersPlages {
  private readonly buckets: readonly R2PlagesBucket[];

  constructor(buckets: readonly (R2PlagesBucket | null | undefined)[]) {
    this.buckets = buckets.filter((b): b is R2PlagesBucket => b !== null && b !== undefined);
  }

  /** Le seul compartiment qui a la référence, avec sa taille ; aucun ou plusieurs : `null`. */
  private async seul(ref: string): Promise<{ bucket: R2PlagesBucket; size: number } | null> {
    let found: { bucket: R2PlagesBucket; size: number } | null = null;
    for (const bucket of this.buckets) {
      const head = await bucket.head(ref);
      if (head === null || head === undefined) continue;
      // Une deuxième pièce sous la même référence : laquelle est celle de l'agence ne se devine pas [R663].
      if (found !== null) return null;
      const size = head.size;
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
      found = { bucket, size };
    }
    return found;
  }

  async taille(ref: string): Promise<number | null> {
    return (await this.seul(ref))?.size ?? null;
  }

  async read(ref: string): Promise<Uint8Array | null> {
    const found = await this.seul(ref);
    if (found === null) return null;
    const body = await found.bucket.get(ref);
    return body ? new Uint8Array(await body.arrayBuffer()) : null;
  }

  async lirePlage(ref: string, debut: number, longueur: number): Promise<Uint8Array | null> {
    const found = await this.seul(ref);
    if (found === null) return null;
    // Une plage vide ne se demande pas à R2 : rien à lire.
    if (longueur === 0) return new Uint8Array();
    const body = await found.bucket.get(ref, { range: { offset: debut, length: longueur } });
    return body ? new Uint8Array(await body.arrayBuffer()) : null;
  }
}
