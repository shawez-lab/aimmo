// Jeu de test commun aux tâches de M11 : un faux M10 qui rapporte les dossiers clos qu'on lui donne.
import type { ClosedSale, DossiersClos } from '../src/apres-vente/index.ts';

export class FakeDossiersClos implements DossiersClos {
  readonly sales: ClosedSale[] = [];
  async closedBetween(_networkId: string, fromDay: string, toDay: string): Promise<readonly ClosedSale[]> {
    return this.sales.filter((s) => s.closedOn >= fromDay && s.closedOn <= toDay);
  }
  async byId(_networkId: string, fileId: string): Promise<ClosedSale | null> {
    return this.sales.find((s) => s.fileId === fileId) ?? null;
  }
}
