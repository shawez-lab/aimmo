/**
 * Diffusion sur chaque portail souscrit, avec accusé et statut par portail (M07, AU004) [R668, R42, R44, R46].
 *
 * Constat de l'audit : AIMMO ne fournissait que son flux XML d'essai (`portails.ts`) ; l'agent devait garder son ancien
 * logiciel pour publier sur les portails, sans savoir ce qui y était vraiment en ligne.
 *
 * Ici, chaque portail réglé actif par la direction (HX38, `diffusion_portal_settings`) et choisi pour le bien, sans
 * retrait temporaire et aux champs exigés remplis (plan « à diffuser » de HX38), reçoit la dernière version publiée du bien (P04), la même que les
 * autres canaux [R44] : il la publie la première fois, la modifie ensuite, la retire quand le bien sort de la vente ou
 * que le portail n'est plus à diffuser (écarté, suspendu, champs manquants, portail arrêté) [R42]. Un geste n'est « accusé » que sur l'accusé rendu par le portail ; sans accusé, c'est
 * un échec, réessayé au passage suivant. Un portail sans connecteur réel (accord de flux H10 pas encore là) passe en
 * essai : rien ne part, et le statut le dit « essai », jamais « publiée ».
 *
 * Décidé, lecture prudente : les connecteurs réels se branchent derrière `PortalConnector`, un par portail, une fois
 * l'accord de flux obtenu ; le statut d'un portail se lit du dernier accusé, jamais de l'envoi seul. Un passage à la
 * fois par bien (bail de 5 minutes) : deux passages n'envoient jamais deux fois la même version.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DiffusionSurveillee, type PlanStatus } from '../diffusion/surveillance.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ListingPayload, ListingState } from './publication.ts';

export type PortalAction = 'publier' | 'modifier' | 'retirer';

/** Ce que rend un portail réel quand il a pris le geste en compte. */
export interface PortalReceipt {
  /** L'accusé du portail : son identifiant de dépôt ou de transaction. */
  receipt: string;
  /** La référence de l'annonce chez le portail, quand il en donne une. */
  portalRef?: string | null;
}

/**
 * Le connecteur d'un portail. `mode: 'reel'` seulement quand l'accord de flux existe (H10) : `send` rend alors
 * l'accusé du portail, ou lève une erreur. Un connecteur d'essai ne fait rien partir.
 */
export interface PortalConnector {
  readonly portal: string;
  readonly mode: 'reel' | 'essai';
  /**
   * Contrat : idempotent sur `key` (bien, portail, version, geste). Un geste dont l'accusé n'a pas pu être rangé est
   * renvoyé avec la même clé au passage suivant ; le connecteur rend alors le même accusé sans rien déposer deux fois.
   */
  send(operation: { key: string; action: PortalAction; listing: ListingPayload }): Promise<PortalReceipt | null>;
}

export const trialPortal = (portal: string): PortalConnector => ({ portal, mode: 'essai', send: async () => null });

/** Le code d'un portail, celui de HX38 : son domaine. */
export const PORTAL_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])$/;
const RECEIPT = /^[\x21-\x7e]{1,200}$/;
const ON_PORTALS: ReadonlySet<ListingState> = new Set(['en_vente', 'sous_offre']);
export const PORTAL_LEASE_MS = 5 * 60_000;
/** Un envoi plus long est coupé, bien avant la fin du bail : il sera repris avec la même clé. */
export const PORTAL_SEND_TIMEOUT_MS = 60_000;

export type PortalState = 'publiee' | 'retiree' | 'en_attente' | 'echec' | 'essai' | 'non_publiee';

export interface PortalStatus {
  portal: string;
  /** Le plan de HX38 pour ce bien et ce portail ; `inactif` : portail arrêté par la direction. */
  plan: PlanStatus | 'inactif';
  mode: 'reel' | 'essai';
  /** `publiee` : la dernière version est accusée en ligne ; `en_attente` : une version plus récente reste à accuser. */
  state: PortalState;
  /** La version accusée en dernier, son geste, son accusé et sa date. */
  acknowledged: { seq: number; action: PortalAction; receipt: string; portalRef: string | null; at: string } | null;
  /** La version publiée du bien que ce portail devrait montrer. */
  expectedSeq: number | null;
  lastError: { seq: number; action: PortalAction; code: string; at: string } | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };

interface VersionRow {
  id: string;
  seq: number;
  state: ListingState;
  payload: string;
}

interface AckRow {
  n: number;
  seq: number;
  action: PortalAction;
  receipt: string;
  portal_listing_id: string | null;
  at: string;
}

export class DiffusionPortails {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly connectors: Map<string, PortalConnector>;
  private readonly surveillance: DiffusionSurveillee;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; connectors?: readonly PortalConnector[] } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.connectors = new Map();
    for (const c of options.connectors ?? []) {
      if (!PORTAL_NAME.test(c.portal) || this.connectors.has(c.portal)) throw new Error(`Portail inconnu ou en double : ${c.portal}`);
      this.connectors.set(c.portal, c);
    }
    this.surveillance = new DiffusionSurveillee(db, acces, journal, { now: this.now, newId: this.newId });
  }

  private connector(portal: string): PortalConnector {
    return this.connectors.get(portal) ?? trialPortal(portal);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async latestVersion(propertyId: string): Promise<VersionRow | null> {
    return this.db.first<VersionRow>('SELECT id, seq, state, payload FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
  }

  private async lastAck(propertyId: string, portal: string): Promise<AckRow | null> {
    return this.db.first<AckRow>(
      "SELECT n, seq, action, receipt, portal_listing_id, at FROM portal_operations WHERE property_id = ? AND portal = ? AND outcome = 'accuse' ORDER BY n DESC LIMIT 1",
      [propertyId, portal],
    );
  }

  /** Ce que ce portail doit recevoir maintenant, ou rien. */
  private static due(version: VersionRow | null, listing: ListingPayload | null, toDiffuse: boolean, ack: AckRow | null): PortalAction | null {
    const live = ack !== null && ack.action !== 'retirer';
    const show = toDiffuse && version !== null && listing !== null && ON_PORTALS.has(version.state) && listing.priceEur !== null && listing.mentions !== null;
    if (show) {
      if (live && ack.seq >= Number(version.seq)) return null;
      return live ? 'modifier' : 'publier';
    }
    // Plus à diffuser sur ce portail : retirer ce qui est encore en ligne, une fois [R42].
    return live ? 'retirer' : null;
  }

  private async acquire(propertyId: string): Promise<string | null> {
    const token = this.newId();
    const now = this.now();
    await this.db.run(
      `INSERT INTO portal_sync_leases (property_id, token, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (property_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at WHERE portal_sync_leases.expires_at <= ?`,
      [propertyId, token, new Date(now.getTime() + PORTAL_LEASE_MS).toISOString(), now.toISOString()],
    );
    const held = await this.db.first<{ token: string }>('SELECT token FROM portal_sync_leases WHERE property_id = ?', [propertyId]);
    return held?.token === token ? token : null;
  }

  private async holds(propertyId: string, token: string): Promise<boolean> {
    const held = await this.db.first<{ token: string; expires_at: string }>('SELECT token, expires_at FROM portal_sync_leases WHERE property_id = ?', [propertyId]);
    return held?.token === token && held.expires_at > this.now().toISOString();
  }

  /**
   * Les portails à suivre pour ce bien : ceux que la direction a réglés actifs, avec le plan de HX38, et ceux qui en
   * ont déjà accusé une version, même arrêtés depuis, pour pouvoir l'y retirer.
   */
  private async portalsFor(networkId: string, propertyId: string): Promise<{ portal: string; plan: PlanStatus | 'inactif' }[]> {
    const plans = new Map<string, PlanStatus | 'inactif'>((await this.surveillance.plan(networkId, propertyId)).map((x) => [x.portal, x.status]));
    const seen = await this.db.all<{ portal: string }>("SELECT DISTINCT portal FROM portal_operations WHERE property_id = ? AND outcome = 'accuse'", [propertyId]);
    for (const x of seen) if (!plans.has(x.portal)) plans.set(x.portal, 'inactif');
    return [...plans.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([portal, plan]) => ({ portal, plan }));
  }

  /**
   * Un passage pour un bien : chaque portail reçoit le geste qui lui manque. Sans droits : c'est le système qui
   * diffuse, depuis la version publiée seulement, jamais depuis un brouillon [R42, R44].
   */
  async sync(networkId: string, propertyId: string): Promise<{ acknowledged: string[]; trial: string[]; failed: string[]; busy?: true }> {
    const out = { acknowledged: [] as string[], trial: [] as string[], failed: [] as string[] };
    const property = await this.db.first<{ network_id: string }>('SELECT network_id FROM properties WHERE id = ?', [propertyId]);
    if (property?.network_id !== networkId) return out;
    const lease = await this.acquire(propertyId);
    if (!lease) return { ...out, busy: true };
    try {
      const version = await this.latestVersion(propertyId);
      const listing = version ? ({ ...(JSON.parse(version.payload) as Omit<ListingPayload, 'version'>), version: Number(version.seq) } as ListingPayload) : null;
      for (const { portal, plan } of await this.portalsFor(networkId, propertyId)) {
        if (!(await this.holds(propertyId, lease))) break;
        const ack = await this.lastAck(propertyId, portal);
        const action = DiffusionPortails.due(version, listing, plan === 'a_diffuser', ack);
        if (!action || !version || !listing) continue;
        // Un retrait porte la version qui le décide ; il ne transporte que la référence, sans contenu.
        const sent: ListingPayload = action === 'retirer' ? { reference: listing.reference, version: listing.version, state: 'retiree', title: null, body: null, mentions: null, priceEur: null, media: [] } : listing;
        const outcome = await this.send(networkId, propertyId, portal, version, action, sent, ack !== null && ack.action !== 'retirer', lease);
        out[outcome === 'accuse' ? 'acknowledged' : outcome === 'essai' ? 'trial' : 'failed'].push(portal);
      }
      return out;
    } finally {
      await this.db.run('UPDATE portal_sync_leases SET expires_at = ? WHERE property_id = ? AND token = ?', [new Date(0).toISOString(), propertyId, lease]);
    }
  }

  private async send(networkId: string, propertyId: string, portal: string, version: VersionRow, action: PortalAction, listing: ListingPayload, live: boolean, lease: string): Promise<'accuse' | 'essai' | 'echec' | 'deja'> {
    const c = this.connector(portal);
    const record = async (outcome: 'accuse' | 'essai' | 'echec', extra: { receipt?: string; portalRef?: string | null; code?: string }): Promise<boolean> => {
      // Seul le passage qui tient encore le bail range un geste : un passage en retard n'écrit rien par-dessus le suivant.
      const { changes } = await this.db
        .run(
          `INSERT INTO portal_operations (id, network_id, property_id, portal, n, version_id, seq, action, outcome, receipt, portal_listing_id, error_code, at)
           SELECT ?, ?, ?, ?, (SELECT COALESCE(MAX(n), 0) + 1 FROM portal_operations WHERE property_id = ? AND portal = ?), ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM portal_sync_leases WHERE property_id = ? AND token = ? AND expires_at > ?)`,
          [
            this.newId(), networkId, propertyId, portal, propertyId, portal, version.id, Number(version.seq), action, outcome, extra.receipt ?? null, extra.portalRef ?? null, extra.code ?? null, this.now().toISOString(),
            propertyId, lease, this.now().toISOString(),
          ],
        )
        .catch((error: unknown) => {
          if (/UNIQUE/i.test(String(error))) return { changes: 0 };
          throw error;
        });
      return changes === 1;
    };
    if (c.mode !== 'reel' && live) {
      // Une annonce réelle est en ligne, mais son connecteur n'est plus là : rien ne la modifie ni ne la retire.
      // Ce n'est pas un essai : c'est un échec, dit au statut et au journal, repris dès que le connecteur revient.
      await record('echec', { code: 'connecteur_absent' });
      await appendEvent(this.journal, { type: 'portail.echec', actor: 'system:portails', subject: `property:${propertyId}`, data: { rule: 'R668', portal, seq: Number(version.seq), action, code: 'connecteur_absent' } }, this.now);
      return 'echec';
    }
    if (c.mode !== 'reel') {
      // Essai : rien ne part. Rangé une fois par version et par geste, jamais compté comme publié.
      if (await record('essai', {})) await appendEvent(this.journal, { type: 'portail.essai', actor: 'system:portails', subject: `property:${propertyId}`, data: { rule: 'R668', portal, seq: Number(version.seq), action } }, this.now);
      return 'essai';
    }
    let receipt: PortalReceipt | null;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('delai_depasse')), PORTAL_SEND_TIMEOUT_MS)));
      try {
        receipt = await Promise.race([c.send({ key: `${propertyId}:${portal}:${Number(version.seq)}:${action}`, action, listing: structuredClone(listing) }), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const code = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'erreur';
      await record('echec', { code });
      await appendEvent(this.journal, { type: 'portail.echec', actor: 'system:portails', subject: `property:${propertyId}`, data: { rule: 'R668', portal, seq: Number(version.seq), action, code } }, this.now);
      return 'echec';
    }
    const portalRef = receipt && typeof receipt.portalRef === 'string' && RECEIPT.test(receipt.portalRef) ? receipt.portalRef : null;
    if (!receipt || typeof receipt.receipt !== 'string' || !RECEIPT.test(receipt.receipt)) {
      // Sans accusé lisible, rien n'est tenu pour publié : réessayé au passage suivant.
      await record('echec', { code: 'accuse_absent' });
      await appendEvent(this.journal, { type: 'portail.echec', actor: 'system:portails', subject: `property:${propertyId}`, data: { rule: 'R668', portal, seq: Number(version.seq), action, code: 'accuse_absent' } }, this.now);
      return 'echec';
    }
    if (!(await record('accuse', { receipt: receipt.receipt, portalRef }))) return 'deja';
    await appendEvent(this.journal, { type: `portail.${action === 'publier' ? 'publiee' : action === 'modifier' ? 'modifiee' : 'retiree'}`, actor: 'system:portails', subject: `property:${propertyId}`, data: { rule: 'R668', portal, seq: Number(version.seq), receipt: receipt.receipt } }, this.now);
    return 'accuse';
  }

  /** Un passage pour chaque bien du réseau qui a une version publiée. Un bien en erreur n'arrête pas les autres. */
  async syncAll(networkId: string): Promise<{ propertyId: string; ok: boolean }[]> {
    const rows = await this.db.all<{ property_id: string }>('SELECT DISTINCT property_id FROM listing_versions WHERE network_id = ? ORDER BY property_id', [networkId]);
    const out: { propertyId: string; ok: boolean }[] = [];
    for (const r of rows) {
      try {
        await this.sync(networkId, r.property_id);
        out.push({ propertyId: r.property_id, ok: true });
      } catch {
        await appendEvent(this.journal, { type: 'portail.passage_echec', actor: 'system:portails', subject: `property:${r.property_id}`, data: { rule: 'R668', code: 'erreur' } }, this.now);
        out.push({ propertyId: r.property_id, ok: false });
      }
    }
    return out;
  }

  /** Le statut du bien sur chaque portail, pour qui voit le bien en entier [R16]. */
  async status(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: PortalStatus[] } | Refusal | { ok: false; rule: null; code: 'unknown_property' }> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'portal_status', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const version = await this.latestVersion(propertyId);
    const listing = version ? ({ ...(JSON.parse(version.payload) as Omit<ListingPayload, 'version'>), version: Number(version.seq) } as ListingPayload) : null;
    const out: PortalStatus[] = [];
    for (const { portal, plan } of await this.portalsFor(viewer.networkId, propertyId)) {
      const mode = this.connector(portal).mode;
      const ack = await this.lastAck(propertyId, portal);
      const due = DiffusionPortails.due(version, listing, plan === 'a_diffuser', ack);
      const err = await this.db.first<{ n: number; seq: number; action: PortalAction; error_code: string; at: string }>(
        "SELECT n, seq, action, error_code, at FROM portal_operations WHERE property_id = ? AND portal = ? AND outcome = 'echec' ORDER BY n DESC LIMIT 1",
        [propertyId, portal],
      );
      const lastError = err && (!ack || Number(err.n) > Number(ack.n)) ? { seq: Number(err.seq), action: err.action, code: err.error_code, at: err.at } : null;
      const live = ack !== null && ack.action !== 'retirer';
      let state: PortalState;
      if (due === null) state = live ? 'publiee' : ack ? 'retiree' : 'non_publiee';
      else if (mode === 'essai') state = ack !== null && ack.action !== 'retirer' ? 'echec' : 'essai';
      else if (lastError && version && lastError.seq === Number(version.seq)) state = 'echec';
      else state = 'en_attente';
      out.push({
        portal,
        plan,
        mode,
        state,
        acknowledged: ack ? { seq: Number(ack.seq), action: ack.action, receipt: ack.receipt, portalRef: ack.portal_listing_id, at: ack.at } : null,
        expectedSeq: plan === 'a_diffuser' && version ? Number(version.seq) : null,
        lastError,
      });
    }
    return { ok: true, value: out };
  }
}
