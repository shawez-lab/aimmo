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

/** Combien de fois, et à quel intervalle, on reprend la main sur un passage déjà en cours : dix secondes au plus. */
const RETRIES = 40;
const RETRY_MS = 250;

export class RetraitsImmediats {
  private readonly now: () => Date;
  private readonly publication: Publication;
  private readonly portails: DiffusionPortails;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; channels?: readonly ListingChannel[]; portals?: readonly PortalConnector[]; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    // Un passage tient déjà le bien : il relit ce qui doit être montré avant de rendre la main (AU067), et on reprend
    // la main dès qu'il la rend, pour que le retrait et ses accusés partent bien ici [R42].
    let r = await this.publication.sync(networkId, propertyId);
    for (let i = 0; r.busy && i < RETRIES; i++) {
      await this.sleep(RETRY_MS);
      r = await this.publication.sync(networkId, propertyId);
    }
    if (r.busy) return { propertyId, state: r.state, channels: { pushed: [], failed: [] }, portals: [], busy: true };
    let p = await this.portails.sync(networkId, propertyId);
    for (let i = 0; p.busy && i < RETRIES; i++) {
      await this.sleep(RETRY_MS);
      p = await this.portails.sync(networkId, propertyId);
    }
    // Ce qui est rangé pour la dernière version, quel que soit le passage qui l'a fait : le nôtre, ou celui qui tenait
    // le bien et a retiré l'annonce lui-même avant de rendre la main.
    const latest = await this.db.first<{ id: string; seq: number }>('SELECT id, seq FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
    const pushes = latest ? await this.db.all<{ channel: string; outcome: string }>('SELECT channel, outcome FROM listing_pushes WHERE version_id = ?', [latest.id]) : [];
    const ok = new Set(pushes.filter((x) => x.outcome === 'ok').map((x) => x.channel));
    const channels = {
      pushed: [...ok].sort() as Channel[],
      failed: [...new Set([...r.failed, ...pushes.filter((x) => x.outcome !== 'ok').map((x) => x.channel)])].filter((c) => !ok.has(c)).sort() as Channel[],
    };
    const ops = latest
      ? await this.db.all<{ portal: string; outcome: string; receipt: string | null }>(
          `SELECT o.portal, o.outcome, o.receipt FROM portal_operations o
            WHERE o.property_id = ? AND o.seq = ? AND o.n = (SELECT MAX(x.n) FROM portal_operations x WHERE x.property_id = o.property_id AND x.portal = o.portal AND x.seq = o.seq)`,
          [propertyId, Number(latest.seq)],
        )
      : [];
    const byPortal = new Map<string, RetraitImmediat['portals'][number]>();
    for (const o of ops) byPortal.set(o.portal, { portal: o.portal, outcome: o.outcome === 'accuse' ? 'accuse' : o.outcome === 'essai' ? 'essai' : 'echec', receipt: o.outcome === 'accuse' ? o.receipt : null });
    for (const portal of p.failed) if (byPortal.get(portal)?.outcome !== 'accuse') byPortal.set(portal, { portal, outcome: 'echec', receipt: null });
    const portals = [...byPortal.values()].sort((a, b) => (a.portal < b.portal ? -1 : a.portal > b.portal ? 1 : 0));
    const busy = p.busy === true;
    await appendEvent(
      this.journal,
      { type: 'annonce.retrait_immediat', actor, subject: `property:${propertyId}`, data: { rule: 'R42', state: r.state, pushed: channels.pushed, failed: [...channels.failed, ...portals.filter((x) => x.outcome === 'echec').map((x) => x.portal)] } },
      this.now,
    );
    return { propertyId, state: r.state, channels, portals, busy };
  }
}
