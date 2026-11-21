/**
 * AU067 · Le retrait urgent part tout de suite (M07) [R42, R668].
 *
 * Une rétractation ou une annulation du mandat ferme la porte de la diffusion. Avant, le retrait attendait le passage
 * des quarts d'heure ; ici, le geste lance aussitôt, pour ce seul bien, le passage des canaux puis celui des portails
 * souscrits, et rend chaque accusé reçu. Un canal ou un portail en panne n'arrête rien : il reste dû, et le passage
 * planifié le réessaie jusqu'à son accusé.
 *
 * Mêmes portes et même bail que le passage planifié : si un passage tient déjà ce bien, rien n'est fait deux fois et
 * celui-ci finit le retrait.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Acces } from '../acces/acces.ts';
import { DiffusionPortails, type PortalConnector } from './diffusion-portails.ts';
import { Publication, type Channel, type ListingChannel, type ListingState } from './publication.ts';

export interface RetraitImmediat {
  propertyId: string;
  /** L'état de la dernière version : `retiree` quand le bien ne doit plus être montré. */
  state: ListingState | null;
  /** Les canaux qui ont reçu le retrait, ceux qui l'ont manqué (réessayés au passage suivant). */
  channels: { pushed: Channel[]; failed: Channel[] };
  /** Les portails : chacun avec son accusé, ou en essai, ou en échec (réessayé au passage suivant). */
  portals: { portal: string; outcome: 'accuse' | 'essai' | 'echec'; receipt: string | null }[];
  /** Un autre passage tenait déjà ce bien : il finit le retrait. */
  busy: boolean;
}

export class RetraitsImmediats {
  private readonly now: () => Date;
  private readonly publication: Publication;
  private readonly portails: DiffusionPortails;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; channels?: readonly ListingChannel[]; portals?: readonly PortalConnector[] } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.publication = new Publication(db, acces, journal, { now: this.now, ...(options.channels ? { channels: options.channels } : {}) });
    this.portails = new DiffusionPortails(db, acces, journal, { now: this.now, ...(options.portals ? { connectors: options.portals } : {}) });
  }

  /** Le bien d'un mandat, s'il en a un dans ce réseau. */
  async propertyOfMandate(networkId: string, mandateId: string): Promise<string | null> {
    const m = await this.db.first<{ property_id: string | null }>('SELECT property_id FROM mandates WHERE id = ? AND network_id = ?', [mandateId, networkId]);
    return m?.property_id ?? null;
  }

  /** Le passage de ce bien, maintenant : canaux puis portails, avec chaque accusé. */
  async run(networkId: string, propertyId: string, actor: string): Promise<RetraitImmediat> {
    const r = await this.publication.sync(networkId, propertyId);
    if (r.busy) return { propertyId, state: r.state, channels: { pushed: [], failed: [] }, portals: [], busy: true };
    const p = await this.portails.sync(networkId, propertyId);
    const receipts = await this.db.all<{ portal: string; receipt: string | null }>(
      `SELECT o.portal, o.receipt FROM portal_operations o
        WHERE o.property_id = ? AND o.outcome = 'accuse'
          AND o.n = (SELECT MAX(x.n) FROM portal_operations x WHERE x.property_id = o.property_id AND x.portal = o.portal AND x.outcome = 'accuse')`,
      [propertyId],
    );
    const receiptOf = new Map(receipts.map((x) => [x.portal, x.receipt]));
    const portals: RetraitImmediat['portals'] = [
      ...p.acknowledged.map((portal) => ({ portal, outcome: 'accuse' as const, receipt: receiptOf.get(portal) ?? null })),
      ...p.trial.map((portal) => ({ portal, outcome: 'essai' as const, receipt: null })),
      ...p.failed.map((portal) => ({ portal, outcome: 'echec' as const, receipt: null })),
    ].sort((a, b) => (a.portal < b.portal ? -1 : a.portal > b.portal ? 1 : 0));
    const busy = p.busy === true;
    await appendEvent(
      this.journal,
      { type: 'annonce.retrait_immediat', actor, subject: `property:${propertyId}`, data: { rule: 'R42', state: r.state, pushed: r.pushed, failed: [...r.failed, ...p.failed] } },
      this.now,
    );
    return { propertyId, state: r.state, channels: { pushed: r.pushed, failed: r.failed }, portals, busy };
  }
}
