/**
 * Publication partout, au même prix, en mode essai (M07, P04) [R42, R43, R44, R47].
 *
 * Une seule version publiée à la fois, la même pour chaque canal (site, réseaux sociaux, fiche Google, portails) :
 * titre et texte validés par l'agent (P03), mentions et prix calculés par le code (P02), état du bien. Une nouvelle
 * version naît dès que l'un d'eux change : avenant de prix signé, bien sous offre ou vendu, nouvelle annonce validée.
 * Quand la porte de diffusion (D05) dit non, que l'annonce n'est plus validée ou que les mentions manquent, l'annonce
 * est retirée partout. Chaque passage pousse la dernière version aux canaux qui ne l'ont pas encore ; un canal en
 * panne est réessayé au passage suivant, et ne reçoit jamais deux fois la même version avec succès.
 *
 * Décidé, lecture prudente : tout est en mode essai ; les canaux sont derrière une interface, et le canal d'essai ne
 * fait que ranger l'envoi, sans rien faire partir. Un passage toutes les 15 minutes (branché avec P09) tient les
 * délais du cahier : publié partout moins d'une heure après la fin du délai de rétractation, prix répercuté en moins
 * de 15 minutes. Un bien loué ou retiré de la vente est retiré ; un bien vendu reste montré « vendu » tant que son
 * mandat le permet.
 */
import type { PublishablePhotos } from '../medias/video-generee.ts';
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PropertyStatus } from '../db/types.ts';
import { sha256 } from '../documents/modeles.ts';
import { Diffusion } from '../documents/retractation.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Annonces } from './annonces.ts';
import { MediasBien, type PublishedMedia } from './medias.ts';
import { computeMentions, MentionsAnnonce } from './mentions.ts';

export const CHANNELS = ['site', 'reseaux', 'google', 'portails'] as const;
export type Channel = (typeof CHANNELS)[number];

export type ListingState = 'en_vente' | 'sous_offre' | 'vendu' | 'retiree';

/** Ce que chaque canal reçoit. Ni adresse, ni nom, ni coordonnée du vendeur. */
export interface ListingPayload {
  /** La référence du bien dans le réseau, pour que le canal remplace l'annonce au lieu d'en créer une autre. */
  reference: string;
  version: number;
  state: ListingState;
  title: string | null;
  body: string | null;
  mentions: string | null;
  priceEur: number | null;
  /** Photos et vidéos publiables, la mention « Aménagement virtuel » à poser sur l'image quand il le faut [R48]. */
  media: PublishedMedia[];
  /**
   * AU064 · le diagnostic tel qu'il est rangé, pour que chaque portail le reprenne sans ressaisie : présent seulement
   * quand la fiche porte son numéro ADEME ou ses valeurs (une annonce sans eux garde le même contenu qu'avant).
   */
  dpe?: ListingDpe;
}

export interface ListingDpe {
  ademeNumber: string | null;
  primaryEnergyKwhM2: number | null;
  ghgKgM2: number | null;
  energyClass: string;
  climateClass: string;
  diagnosedOn: string;
}

/**
 * Un canal de diffusion. Il remplace l'annonce de la référence par la version reçue, ou la retire. Contrat : un canal
 * n'applique jamais une version plus ancienne que la dernière qu'il a appliquée pour cette référence ; c'est la
 * seconde garde, après le bail d'un passage par bien, contre un envoi en retard [R42].
 */
export interface ListingChannel {
  readonly channel: Channel;
  push(payload: ListingPayload): Promise<void>;
}

/** Le canal d'essai : il ne fait rien partir. L'envoi est rangé dans `listing_pushes` avec sa version. */
export const trialChannel = (channel: Channel): ListingChannel => ({ channel, push: async () => {} });

export type RetractReason = 'no_mandate' | 'cancelled' | 'withdrawn' | 'expired' | 'duration_unknown' | 'withdrawal_period' | 'annonce_non_validee' | 'mentions_incompletes' | 'bien_retire';

export interface SyncResult {
  version: number | null;
  state: ListingState | null;
  created: boolean;
  pushed: Channel[];
  failed: Channel[];
  /** Un autre passage travaille sur ce bien : rien n'est fait, le passage suivant reprendra. */
  busy?: true;
}

/** Durée du bail d'un passage sur un bien. */
export const SYNC_LEASE_MS = 5 * 60_000;

interface VersionRow {
  id: string;
  seq: number;
  state: ListingState;
  payload: string;
  payload_hash: string;
  created_at: string;
}

const STATE_OF: Record<PropertyStatus, ListingState | null> = {
  draft: 'en_vente',
  available: 'en_vente',
  under_offer: 'sous_offre',
  sold: 'vendu',
  rented: null,
  withdrawn: null,
};

type Refusal = { ok: false; rule: 'R16'; code: string };

export class Publication {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly channels: readonly ListingChannel[];
  private readonly diffusion: Diffusion;
  private readonly annonces: Annonces;
  private readonly mentions: MentionsAnnonce;
  private readonly medias: MediasBien;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; channels?: readonly ListingChannel[]; generatedVideoPhotos?: PublishablePhotos } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.channels = options.channels ?? CHANNELS.map(trialChannel);
    const seen = new Set<string>();
    for (const c of this.channels) {
      if (!(CHANNELS as readonly string[]).includes(c.channel) || seen.has(c.channel)) throw new Error(`Canal inconnu ou en double : ${c.channel}`);
      seen.add(c.channel);
    }
    this.diffusion = new Diffusion(db, acces, journal, { now: this.now });
    this.annonces = new Annonces(db, acces, journal, { now: this.now });
    this.mentions = new MentionsAnnonce(db, acces, journal, { now: this.now });
    // Une vidéo générée n'est relue qu'avec les photos certifiées ; sans elles, elle ne part pas [R498].
    this.medias = new MediasBien(db, acces, journal, { now: this.now, ...(options.generatedVideoPhotos ? { generatedVideoPhotos: options.generatedVideoPhotos } : {}) });
  }

  private async latest(propertyId: string): Promise<VersionRow | null> {
    return this.db.first<VersionRow>('SELECT id, seq, state, payload, payload_hash, created_at FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
  }

  /** Ce qui doit être publié maintenant, ou la raison du retrait. Toute publication passe par la porte de D05 [R42]. */
  private async desired(networkId: string, propertyId: string, reference: string, status: PropertyStatus): Promise<{ publish: Omit<ListingPayload, 'version'>; draftId: string } | { retract: RetractReason }> {
    const state = STATE_OF[status];
    if (state === null) return { retract: 'bien_retire' };
    const gate = await this.diffusion.canDiffuse(networkId, propertyId, this.now());
    if (!gate.allowed) return { retract: gate.reason as RetractReason };
    const draft = await this.annonces.publishable(networkId, propertyId);
    if (!draft) return { retract: 'annonce_non_validee' };
    const input = await this.mentions.inputFor(networkId, propertyId);
    const checklist = input ? computeMentions(input) : null;
    if (!checklist?.complete || checklist.publishedPriceEur === null) return { retract: 'mentions_incompletes' };
    const e = input?.sheet?.energy ?? null;
    const known = e && (e.ademeNumber !== undefined || e.primaryEnergyKwhM2 !== undefined || e.ghgKgM2 !== undefined);
    const dpe: ListingDpe | null = known
      ? { ademeNumber: e.ademeNumber ?? null, primaryEnergyKwhM2: e.primaryEnergyKwhM2 ?? null, ghgKgM2: e.ghgKgM2 ?? null, energyClass: e.energyClass, climateClass: e.climateClass, diagnosedOn: e.diagnosedOn }
      : null;
    return {
      draftId: draft.id,
      publish: { reference, state, title: draft.title, body: draft.body, mentions: checklist.text, priceEur: checklist.publishedPriceEur, media: await this.medias.publishable(propertyId, draft.sheetVersion), ...(dpe ? { dpe } : {}) },
    };
  }

  /**
   * Un passage pour un bien : crée une version si ce qui doit être montré a changé, puis pousse la dernière version
   * à chaque canal qui ne l'a pas encore. Sans droits : c'est le système qui publie.
   */
  async sync(networkId: string, propertyId: string): Promise<SyncResult> {
    const property = await this.db.first<{ network_id: string; reference: string; status: PropertyStatus }>('SELECT network_id, reference, status FROM properties WHERE id = ?', [propertyId]);
    if (!property || property.network_id !== networkId) return { version: null, state: null, created: false, pushed: [], failed: [] };
    // Un seul passage à la fois par bien [R42] : sans le bail, rien n'est fait.
    const lease = await this.acquire(propertyId);
    if (!lease) return { version: null, state: null, created: false, pushed: [], failed: [], busy: true };
    try {
      return await this.syncHeld(networkId, propertyId, property, lease);
    } finally {
      await this.db.run('UPDATE listing_sync_leases SET expires_at = ? WHERE property_id = ? AND token = ?', [new Date(0).toISOString(), propertyId, lease]);
    }
  }

  /** Prend le bail du bien, ou rend null s'il est tenu par un autre passage et pas encore échu. */
  private async acquire(propertyId: string): Promise<string | null> {
    const token = this.newId();
    const now = this.now();
    await this.db.run(
      `INSERT INTO listing_sync_leases (property_id, token, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (property_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at WHERE listing_sync_leases.expires_at <= ?`,
      [propertyId, token, new Date(now.getTime() + SYNC_LEASE_MS).toISOString(), now.toISOString()],
    );
    const held = await this.db.first<{ token: string }>('SELECT token FROM listing_sync_leases WHERE property_id = ?', [propertyId]);
    return held?.token === token ? token : null;
  }

  /**
   * Le statut du bien suit son annonce : publiée, il est disponible ; retirée, il ne l'est plus. Seuls `draft` et
   * `available` bougent, jamais une offre ni une vente ; un bien sans annonce garde son statut. Rejoué à chaque passage,
   * pour qu'une coupure entre la version et cette écriture se répare seule.
   */
  private async followListing(propertyId: string, state: ListingState): Promise<void> {
    if (state !== 'en_vente' && state !== 'retiree') return;
    const [from, to, type] = state === 'en_vente' ? ['draft', 'available', 'bien.disponible'] : ['available', 'draft', 'bien.plus_disponible'];
    const { changes } = await this.db.run('UPDATE properties SET status = ?, updated_at = ? WHERE id = ? AND status = ?', [to, this.now().toISOString(), propertyId, from]);
    if (changes === 1) await appendEvent(this.journal, { type, actor: 'system:publication', subject: `property:${propertyId}`, data: {} }, this.now);
  }

  private async holds(propertyId: string, token: string): Promise<boolean> {
    const held = await this.db.first<{ token: string; expires_at: string }>('SELECT token, expires_at FROM listing_sync_leases WHERE property_id = ?', [propertyId]);
    return held?.token === token && held.expires_at > this.now().toISOString();
  }

  private async syncHeld(networkId: string, propertyId: string, property: { reference: string; status: PropertyStatus }, lease: string): Promise<SyncResult> {
    const want = await this.desired(networkId, propertyId, property.reference, property.status);
    const before = await this.latest(propertyId);
    let created = false;
    if ('publish' in want || (before && before.state !== 'retiree')) {
      const content: Omit<ListingPayload, 'version'> =
        'publish' in want ? want.publish : { reference: property.reference, state: 'retiree', title: null, body: null, mentions: null, priceEur: null, media: [] };
      const hash = await sha256(JSON.stringify(content));
      const reason = 'publish' in want ? 'publication' : want.retract;
      // La version n'est créée que si son contenu diffère de la dernière, dans la même instruction : deux passages
      // simultanés ne créent jamais deux fois la même version.
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at)
         SELECT ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ? FROM listing_versions WHERE property_id = ?
         HAVING COALESCE((SELECT payload_hash FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1), '') <> ?
            AND EXISTS (SELECT 1 FROM listing_sync_leases WHERE property_id = ? AND token = ? AND expires_at > ?)`,
        [
          id, propertyId, networkId, content.state, 'publish' in want ? want.draftId : null, content.priceEur, JSON.stringify(content), hash, reason, this.now().toISOString(), propertyId,
          propertyId, hash,
          // Seul le passage qui tient encore le bail écrit une version : un passage dont le bail a échu ne peut pas
          // écrire une version périmée par-dessus le travail du passage suivant [R42].
          propertyId, lease, this.now().toISOString(),
        ],
      ).catch((error: unknown) => {
        if (/UNIQUE/i.test(String(error))) return { changes: 0 };
        throw error;
      });
      if (changes === 1) {
        created = true;
        const v = await this.latest(propertyId);
        await appendEvent(
          this.journal,
          { type: content.state === 'retiree' ? 'annonce.retiree' : 'annonce.publiee', actor: 'system:publication', subject: `property:${propertyId}`, data: { rule: content.state === 'retiree' ? 'R42' : 'R44', seq: v?.seq ?? null, state: content.state, reason } },
          this.now,
        );
      }
    }
    const current = await this.latest(propertyId);
    if (!current) return { version: null, state: null, created, pushed: [], failed: [] };
    await this.followListing(propertyId, current.state);
    const { pushed, failed } = await this.pushAll(propertyId, current, lease);
    return { version: Number(current.seq), state: current.state, created, pushed, failed };
  }

  private async pushAll(propertyId: string, v: VersionRow, lease: string): Promise<{ pushed: Channel[]; failed: Channel[] }> {
    const pushed: Channel[] = [];
    const failed: Channel[] = [];
    const payload: ListingPayload = { ...(JSON.parse(v.payload) as Omit<ListingPayload, 'version'>), version: Number(v.seq) };
    for (const c of this.channels) {
      // Bail perdu (passage trop long) : on s'arrête, le passage suivant reprendra avec la dernière version.
      if (!(await this.holds(propertyId, lease))) break;
      if (await this.db.first('SELECT id FROM listing_pushes WHERE version_id = ? AND channel = ? AND outcome = ?', [v.id, c.channel, 'ok'])) continue;
      try {
        await c.push(structuredClone(payload));
      } catch (error) {
        // Jamais avalée : l'échec est rangé et écrit au journal, sans le texte de l'erreur, et réessayé au passage suivant.
        const code = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'erreur';
        await this.db.run('INSERT INTO listing_pushes (id, version_id, channel, outcome, error_code, at) VALUES (?, ?, ?, ?, ?, ?)', [this.newId(), v.id, c.channel, 'echec', code, this.now().toISOString()]);
        await appendEvent(this.journal, { type: 'annonce.envoi_echec', actor: 'system:publication', subject: `property:${propertyId}`, data: { channel: c.channel, seq: Number(v.seq), code } }, this.now);
        failed.push(c.channel);
        continue;
      }
      const { changes } = await this.db
        .run('INSERT INTO listing_pushes (id, version_id, channel, outcome, error_code, at) VALUES (?, ?, ?, ?, NULL, ?)', [this.newId(), v.id, c.channel, 'ok', this.now().toISOString()])
        .catch((error: unknown) => {
          if (/UNIQUE/i.test(String(error))) return { changes: 0 };
          throw error;
        });
      if (changes === 1) pushed.push(c.channel);
    }
    return { pushed, failed };
  }

  /** Un passage pour tous les biens du réseau qui ont une annonce ou une version publiée. */
  async syncAll(networkId: string): Promise<{ propertyId: string; result: SyncResult | null }[]> {
    const rows = await this.db.all<{ property_id: string }>(
      'SELECT DISTINCT property_id FROM listing_drafts WHERE network_id = ? UNION SELECT DISTINCT property_id FROM listing_versions WHERE network_id = ? ORDER BY property_id',
      [networkId, networkId],
    );
    const out: { propertyId: string; result: SyncResult | null }[] = [];
    for (const r of rows) {
      try {
        out.push({ propertyId: r.property_id, result: await this.sync(networkId, r.property_id) });
      } catch {
        // Un bien en erreur n'arrête pas le passage des autres : leurs retraits doivent partir [R42]. L'échec est
        // écrit au journal, sans le texte de l'erreur, et le bien est repris au passage suivant.
        await appendEvent(this.journal, { type: 'annonce.passage_echec', actor: 'system:publication', subject: `property:${r.property_id}`, data: { rule: 'R42', code: 'erreur' } }, this.now);
        out.push({ propertyId: r.property_id, result: null });
      }
    }
    return out;
  }

  /** L'état de l'annonce d'un bien et de chaque canal, pour qui voit le bien en entier [R16]. */
  async status(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: { version: number; state: ListingState; priceEur: number | null; channels: Record<Channel, 'publiee' | 'en_attente' | 'echec'> } | null } | Refusal | { ok: false; rule: null; code: 'unknown_property' }> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'listing_status', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const v = await this.latest(propertyId);
    if (!v) return { ok: true, value: null };
    const pushes = await this.db.all<{ channel: Channel; outcome: 'ok' | 'echec' }>('SELECT channel, outcome FROM listing_pushes WHERE version_id = ?', [v.id]);
    const channels = {} as Record<Channel, 'publiee' | 'en_attente' | 'echec'>;
    for (const c of this.channels) {
      const mine = pushes.filter((x) => x.channel === c.channel);
      channels[c.channel] = mine.some((x) => x.outcome === 'ok') ? 'publiee' : mine.length > 0 ? 'echec' : 'en_attente';
    }
    const payload = JSON.parse(v.payload) as ListingPayload;
    return { ok: true, value: { version: Number(v.seq), state: v.state, priceEur: payload.priceEur, channels } };
  }
}
