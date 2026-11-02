/**
 * Le palier de chaque canal de captation (C09b) [R26] : essai, 10 % des messages tirés une fois pour toutes, partout,
 * et retour en essai à la première panne du canal, sans toucher aux autres. Sans vrai canal fourni, tout reste dans la
 * boîte d'essai, à tout palier. Les paliers sont ceux de la bascule (`PaliersBascule`), une automatisation par canal ;
 * `shadow` y veut dire « essai ».
 */
import { PaliersBascule } from '../bascule/paliers.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { OutboundChannelName } from '../db/types.ts';
import type { OutboundChannel } from '../envoi/canaux.ts';
import type { ChannelStaging } from '../envoi/controle.ts';
import type { JournalStore } from '../journal/types.ts';

/** Le nom du palier d'un canal. */
export const captationAutomation = (channel: OutboundChannelName): string => `captation_${channel}`;

export interface PaliersCanauxOptions {
  now?: () => Date;
  /** Les vrais canaux. Un canal absent ne fait jamais rien partir [R26]. */
  realChannels?: readonly OutboundChannel[];
}

export class PaliersCanaux implements ChannelStaging {
  private readonly paliers: PaliersBascule;
  private readonly real: ReadonlyMap<OutboundChannelName, OutboundChannel>;

  constructor(db: SqlDatabase, journal: JournalStore, options: PaliersCanauxOptions = {}) {
    this.paliers = new PaliersBascule(db, journal, options.now ? { now: options.now } : {});
    this.real = new Map((options.realChannels ?? []).map((c) => [c.channel, c]));
  }

  async route(networkId: string, channel: OutboundChannelName, ref: string | null): Promise<{ real: OutboundChannel | null; confirm: () => Promise<void> }> {
    const automation = captationAutomation(channel);
    // Sans référence, pas de tirage fixe : la boîte d'essai.
    const palier = await this.paliers.decide(networkId, automation, ref ?? 'sans-reference');
    const real = ref !== null && palier.decides ? (this.real.get(channel) ?? null) : null;
    return {
      real,
      // L'essai prouve par ses messages ; plus haut, seuls comptent ceux qui sont vraiment partis.
      confirm: async () => {
        if (palier.stage === 'shadow' || real) await this.paliers.countRequest(networkId, automation, palier.stageSince);
      },
    };
  }

  async failed(networkId: string, channel: OutboundChannelName): Promise<void> {
    await this.paliers.incident(networkId, captationAutomation(channel), 'failure', null, 'system:captation');
  }
}
