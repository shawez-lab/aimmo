/**
 * La boutique de l'agent (HX07) : tarifs des supports, commande préparée, commande validée d'un geste, envoi à
 * l'imprimeur [R263, R264, R265].
 *
 * - Le support est tiré du bien à chaque fois (`renderSupport`) ; la commande garde le HTML exact et son empreinte.
 *   À la validation, le support est tiré de nouveau : s'il a changé (nouvelle version de l'annonce, nouveau prix, bien
 *   vendu, autre page), la commande est périmée et rien ne part [R264].
 * - Le prix d'une commande vient du dernier tarif réglé par la direction pour ce support et cette quantité, encore en
 *   vigueur, jamais d'une saisie, et la commande ne part qu'à l'imprimeur nommé par ce tarif ; un tarif changé ou échu depuis la préparation périme la commande [R264].
 * - Préparer ne commande rien. Seul l'agent qui a préparé valide, d'un geste ; l'envoi est réservé avant de partir,
 *   donc jamais deux envois d'une commande. AIMMO ne paie rien : l'imprimeur facture l'agent au prix du tarif [R265].
 * - Aucune donnée personnelle au journal : seulement des identifiants internes [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { PageBien, type AgentCard } from '../annonces/page-bien.ts';
import { professionalTitle } from '../attirer/qualite.ts';
import type { ListingPayload } from '../annonces/publication.ts';
import { Referencement } from '../attirer/referencement.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { SUPPORTS, renderSupport, type RenderedSupport, type Support, type SupportRefusal } from './supports.ts';

export interface PrintOrder {
  orderId: string;
  support: Support;
  quantity: number;
  /** Le support exact validé par l'agent. */
  html: string;
  priceCents: number;
}

/** Un imprimeur : il reçoit la commande validée et rend sa propre référence. Il ne reçoit jamais de moyen de paiement. */
export interface Imprimeur {
  readonly name: string;
  order(order: PrintOrder): Promise<{ ref: string }>;
}

/** L'imprimeur d'essai : rien ne part, la commande est rangée comme envoyée avec une référence d'essai. */
export const trialPrinter: Imprimeur = { name: 'essai', order: async (o) => ({ ref: `essai-${o.orderId}` }) };

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: string };

export type PreviewResult = (RenderedSupport & { support: Support; versionId: string | null }) | SupportRefusal | Refusal | Problem;

export interface TariffInput {
  support: unknown;
  quantity: unknown;
  priceCents: unknown;
  printer: unknown;
  source: unknown;
  validUntil: unknown;
}

export interface TariffView {
  id: string;
  support: Support;
  quantity: number;
  priceCents: number;
  printer: string;
  source: string;
  validUntil: string;
  setAt: string;
  inForce: boolean;
}

export interface OrderView {
  id: string;
  support: Support;
  propertyId: string | null;
  quantity: number;
  priceCents: number;
  preparedAt: string;
  status: 'preparee' | 'validee' | 'envoyee' | 'echec';
}

interface TariffRow {
  id: string;
  price_cents: number;
  valid_until: string;
  printer: string;
}

interface OrderRow {
  id: string;
  network_id: string;
  agent_id: string;
  property_id: string | null;
  support: Support;
  quantity: number;
  content_hash: string;
  html: string;
  tariff_id: string;
  price_cents: number;
  prepared_at: string;
}

/** Le dernier tarif réglé pour un support et une quantité : le seul qui fasse foi [R264]. */
const LATEST_TARIFF =
  'SELECT id, support, quantity, price_cents, printer, source, valid_until, set_at FROM shop_tariffs WHERE network_id = ? AND support = ? AND quantity = ? ORDER BY set_at DESC, rowid DESC LIMIT 1';

interface TariffFull {
  id: string;
  support: Support;
  quantity: number;
  price_cents: number;
  printer: string;
  source: string;
  valid_until: string;
  set_at: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export class Boutique {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly printer: Imprimeur;
  private readonly pages: PageBien;
  private readonly referencement: Referencement;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; printer?: Imprimeur; referencement?: Referencement } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.printer = options.printer ?? trialPrinter;
    this.pages = new PageBien(db, acces, journal, { now: this.now });
    this.referencement = options.referencement ?? new Referencement(db, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return localTime(this.now(), 'Europe/Paris').date;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'boutique', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Le tarif d'un support, depuis le devis d'un imprimeur : la direction seule. */
  async setTariff(viewer: Viewer, input: TariffInput): Promise<{ ok: true; tariffId: string } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    if (typeof input.support !== 'string' || !(SUPPORTS as readonly string[]).includes(input.support)) return { ok: false, rule: null, code: 'bad_support' };
    if (typeof input.quantity !== 'number' || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10000) return { ok: false, rule: null, code: 'bad_quantity' };
    if (typeof input.priceCents !== 'number' || !Number.isInteger(input.priceCents) || input.priceCents <= 0) return { ok: false, rule: null, code: 'bad_price' };
    if (typeof input.printer !== 'string' || input.printer.trim().length < 1 || input.printer.trim().length > 80) return { ok: false, rule: null, code: 'bad_printer' };
    if (typeof input.source !== 'string' || input.source.trim().length < 1 || input.source.trim().length > 200) return { ok: false, rule: null, code: 'bad_source' };
    if (typeof input.validUntil !== 'string' || !DAY.test(input.validUntil) || Number.isNaN(Date.parse(`${input.validUntil}T00:00:00Z`)) || new Date(`${input.validUntil}T00:00:00Z`).toISOString().slice(0, 10) !== input.validUntil) {
      return { ok: false, rule: null, code: 'bad_date' };
    }
    if (input.validUntil < this.today()) return { ok: false, rule: null, code: 'deja_echu' };
    const id = this.newId();
    await this.db.run(
      'INSERT INTO shop_tariffs (id, network_id, support, quantity, price_cents, printer, source, valid_until, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, input.support, input.quantity, input.priceCents, input.printer.trim(), input.source.trim(), input.validUntil, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'boutique.tarif_regle', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { tariffId: id, support: input.support, quantity: input.quantity } }, this.now);
    return { ok: true, tariffId: id };
  }

  /**
   * Les tarifs du réseau, la direction seule : pour chaque support et chaque quantité, le dernier réglé, dit en vigueur
   * ou échu. Un tarif plus ancien ne fait jamais foi, il n'est donc pas rendu [R264].
   */
  async tariffs(viewer: Viewer): Promise<{ ok: true; value: TariffView[] } | Refusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const pairs = await this.db.all<{ support: Support; quantity: number }>('SELECT DISTINCT support, quantity FROM shop_tariffs WHERE network_id = ? ORDER BY support, quantity', [viewer.networkId]);
    const rows: TariffFull[] = [];
    for (const p of pairs) {
      const t = await this.db.first<TariffFull>(LATEST_TARIFF, [viewer.networkId, p.support, Number(p.quantity)]);
      if (t) rows.push(t);
    }
    const today = this.today();
    return {
      ok: true,
      value: rows.map((r) => ({
        id: r.id,
        support: r.support,
        quantity: Number(r.quantity),
        priceCents: Number(r.price_cents),
        printer: r.printer,
        source: r.source,
        validUntil: r.valid_until,
        setAt: r.set_at,
        inForce: r.valid_until >= today,
      })),
    };
  }

  /** Le tarif qui fait foi : le dernier réglé pour ce support et cette quantité, s'il est encore en vigueur. Jamais un plus ancien. */
  private async tariff(networkId: string, support: Support, quantity: number): Promise<TariffRow | null> {
    const t = await this.db.first<TariffRow>(LATEST_TARIFF, [networkId, support, quantity]);
    return t && t.valid_until >= this.today() ? { id: t.id, price_cents: Number(t.price_cents), valid_until: t.valid_until, printer: t.printer } : null;
  }

  private async agentCard(agentId: string): Promise<AgentCard | null> {
    const a = await this.db.first<{ network_id: string; first_name: string; last_name: string; status: string }>('SELECT network_id, first_name, last_name, status FROM agents WHERE id = ?', [agentId]);
    if (!a || a.status !== 'active') return null;
    const c = await this.db.first<{ phone: string; email: string }>('SELECT phone, email FROM agent_public_cards WHERE agent_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [agentId]);
    return { firstName: a.first_name, lastName: a.last_name, phone: c?.phone ?? null, email: c?.email ?? null, title: await professionalTitle(this.db, a.network_id, agentId) };
  }

  /**
   * Le support tel qu'il serait imprimé maintenant. Les supports d'un bien : son agent seul, depuis la dernière version
   * publiée. La carte de visite : l'agent, pour lui-même.
   */
  async preview(viewer: Viewer, input: { support: unknown; propertyId?: unknown }): Promise<PreviewResult> {
    if (typeof input.support !== 'string' || !(SUPPORTS as readonly string[]).includes(input.support)) return { ok: false, rule: null, code: 'bad_support' };
    const support = input.support as Support;
    if (viewer.role !== 'agent') return this.refuse(viewer, `agent:${viewer.userId}`, 'role');

    if (support === 'carte') {
      if (input.propertyId !== undefined && input.propertyId !== null) return { ok: false, rule: null, code: 'bad_property' };
      const me = await this.db.first<{ network_id: string }>('SELECT network_id FROM agents WHERE id = ?', [viewer.userId]);
      if (!me || me.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_agent' };
      const card = await this.agentCard(viewer.userId);
      if (!card) return this.refuse(viewer, `agent:${viewer.userId}`, 'agent_inactive');
      const sites = await this.referencement.sites(viewer.networkId);
      const home = sites.find((s) => s.kind === 'agent' && s.agentId === viewer.userId) ?? sites.find((s) => s.kind === 'reseau');
      if (!home) return { ok: false, rule: null, code: 'pas_de_site' };
      const r = renderSupport({ support, agent: card, url: home.baseUrl });
      return r.ok ? { ...r, support, versionId: null } : r;
    }

    if (typeof input.propertyId !== 'string' || input.propertyId === '') return { ok: false, rule: null, code: 'bad_property' };
    const propertyId = input.propertyId;
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : this.refuse(viewer, `property:${propertyId}`, String(p.code));
    if (p.view !== 'full' || p.value.agent_id !== viewer.userId) return this.refuse(viewer, `property:${propertyId}`, 'not_assigned');
    const page = await this.pages.inputFor(p.value.network_id, propertyId);
    const version = await this.db.first<{ id: string }>('SELECT id FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
    if (!page || !version) return { ok: false, code: 'annonce_pas_en_vente' };
    const card = await this.agentCard(viewer.userId);
    if (!card) return this.refuse(viewer, `property:${propertyId}`, 'agent_inactive');
    // La page de référence du bien : jamais vers une page non publiée [R153].
    const url = await this.referencement.canonicalFor(p.value.network_id, propertyId);
    if (!url) return page.payload.state === 'en_vente' ? { ok: false, rule: null, code: 'pas_de_page' } : { ok: false, code: 'annonce_pas_en_vente' };
    const payload: ListingPayload = page.payload;
    const r = renderSupport({ support: support as 'panneau' | 'flyer' | 'vitrine', payload, agent: card, url });
    return r.ok ? { ...r, support, versionId: version.id } : r;
  }

  /**
   * Prépare une commande : le support du moment, la quantité, le prix du tarif en vigueur. Rien n'est commandé ni payé.
   * La même demande rejouée rend la même commande.
   */
  async prepare(
    viewer: Viewer,
    input: { requestId: unknown; support: unknown; propertyId?: unknown; quantity: unknown },
  ): Promise<{ ok: true; orderId: string; priceCents: number; html: string } | PreviewResult> {
    if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) return { ok: false, rule: null, code: 'bad_request' };
    if (typeof input.quantity !== 'number' || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10000) return { ok: false, rule: null, code: 'bad_quantity' };
    const existing = await this.db.first<OrderRow>('SELECT * FROM shop_orders WHERE id = ?', [input.requestId]);
    if (existing) {
      if (existing.agent_id !== viewer.userId || existing.network_id !== viewer.networkId) return this.refuse(viewer, `shop_order:${existing.id}`, 'not_owner');
      // La même demande, et seulement elle : un autre support, bien ou quantité sous la même clé est refusé.
      const sameProperty = existing.support === 'carte' ? input.propertyId === undefined || input.propertyId === null : existing.property_id === input.propertyId;
      if (existing.support !== input.support || !sameProperty || Number(existing.quantity) !== input.quantity) return { ok: false, rule: null, code: 'demande_differente' };
      return { ok: true, orderId: existing.id, priceCents: Number(existing.price_cents), html: existing.html };
    }
    const preview = await this.preview(viewer, input);
    if (!preview.ok) return preview;
    const tariff = await this.tariff(viewer.networkId, preview.support, input.quantity);
    if (!tariff) return { ok: false, rule: null, code: 'pas_de_tarif' };
    // Le prix est celui du devis d'un imprimeur : la commande ne part qu'à cet imprimeur-là [R264].
    if (tariff.printer !== this.printer.name) return { ok: false, rule: null, code: 'imprimeur_different' };
    const hash = await sha256(preview.html);
    const { changes } = await this.db.run(
      `INSERT INTO shop_orders (id, network_id, agent_id, property_id, support, quantity, listing_version_id, target_url, html, content_hash, tariff_id, price_cents, prepared_by, prepared_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [
        input.requestId, viewer.networkId, viewer.userId, preview.support === 'carte' ? null : (input.propertyId as string), preview.support, input.quantity,
        preview.versionId, preview.url, preview.html, hash, tariff.id, tariff.price_cents, this.actor(viewer), this.now().toISOString(),
      ],
    );
    if (changes === 0) return this.prepare(viewer, input);
    await appendEvent(this.journal, { type: 'boutique.commande_preparee', actor: this.actor(viewer), subject: `shop_order:${input.requestId}`, data: { support: preview.support, quantity: input.quantity, tariffId: tariff.id } }, this.now);
    return { ok: true, orderId: input.requestId, priceCents: tariff.price_cents, html: preview.html };
  }

  /**
   * Le geste de l'agent : il commande exactement ce qu'il a vu. Le support est retiré du bien et comparé à la commande ;
   * le tarif aussi. Puis l'envoi est réservé, et part une seule fois.
   */
  async validate(viewer: Viewer, orderId: unknown): Promise<{ ok: true; printerRef: string } | Refusal | Problem> {
    if (typeof orderId !== 'string' || !REQUEST_ID.test(orderId)) return { ok: false, rule: null, code: 'unknown_order' };
    const order = await this.db.first<OrderRow>('SELECT * FROM shop_orders WHERE id = ?', [orderId]);
    if (!order || order.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_order' };
    const subject = `shop_order:${order.id}`;
    if (viewer.role !== 'agent' || viewer.userId !== order.agent_id) return this.refuse(viewer, subject, 'not_owner');
    if (await this.db.first('SELECT 1 AS x FROM shop_order_sends WHERE order_id = ?', [order.id])) return { ok: false, rule: null, code: 'deja_validee' };
    // Une validation rangée sans envoi réservé (coupure entre les deux) se reprend au geste suivant, sans rien doubler.
    const resumed = (await this.db.first('SELECT 1 AS x FROM shop_order_validations WHERE order_id = ?', [order.id])) !== null;

    const now = await this.preview(viewer, { support: order.support, propertyId: order.property_id });
    if (!now.ok) return { ok: false, rule: null, code: 'support_perime' };
    if ((await sha256(now.html)) !== order.content_hash || now.html !== order.html) return { ok: false, rule: null, code: 'support_perime' };
    const tariff = await this.tariff(order.network_id, order.support, Number(order.quantity));
    if (!tariff || tariff.id !== order.tariff_id || tariff.price_cents !== Number(order.price_cents)) return { ok: false, rule: null, code: 'tarif_change' };
    if (tariff.printer !== this.printer.name) return { ok: false, rule: null, code: 'imprimeur_different' };

    const at = this.now().toISOString();
    if (!resumed) {
      const v = await this.db.run('INSERT INTO shop_order_validations (order_id, validated_by, validated_at) VALUES (?, ?, ?) ON CONFLICT (order_id) DO NOTHING', [order.id, this.actor(viewer), at]);
      if (v.changes === 0) return { ok: false, rule: null, code: 'deja_validee' };
    }
    await appendEvent(this.journal, { type: 'boutique.commande_validee', actor: this.actor(viewer), subject, data: { support: order.support, quantity: Number(order.quantity), priceCents: Number(order.price_cents) } }, this.now);
    const s = await this.db.run('INSERT INTO shop_order_sends (order_id, printer, reserved_at) VALUES (?, ?, ?) ON CONFLICT (order_id) DO NOTHING', [order.id, this.printer.name, at]);
    if (s.changes === 0) return { ok: false, rule: null, code: 'deja_validee' };
    let ref: string;
    try {
      const r = await this.printer.order({ orderId: order.id, support: order.support, quantity: Number(order.quantity), html: order.html, priceCents: Number(order.price_cents) });
      if (typeof r?.ref !== 'string' || r.ref.length < 1 || r.ref.length > 120) throw new Error('reference_imprimeur');
      ref = r.ref;
    } catch {
      await this.db.run("INSERT INTO shop_order_results (order_id, outcome, printer_ref, at) VALUES (?, 'echec', NULL, ?) ON CONFLICT (order_id) DO NOTHING", [order.id, this.now().toISOString()]);
      await appendEvent(this.journal, { type: 'boutique.envoi_echoue', actor: 'system', subject, data: { printer: this.printer.name } }, this.now);
      return { ok: false, rule: null, code: 'imprimeur_en_panne' };
    }
    await this.db.run("INSERT INTO shop_order_results (order_id, outcome, printer_ref, at) VALUES (?, 'envoyee', ?, ?) ON CONFLICT (order_id) DO NOTHING", [order.id, ref, this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'boutique.commande_envoyee', actor: 'system', subject, data: { printer: this.printer.name } }, this.now);
    return { ok: true, printerRef: ref };
  }

  /** Les commandes de l'agent, les plus récentes d'abord. */
  async orders(viewer: Viewer): Promise<OrderView[]> {
    if (viewer.role !== 'agent') return [];
    const rows = await this.db.all<OrderRow & { validated: number | null; sent: number | null; outcome: string | null }>(
      `SELECT o.*, (SELECT 1 FROM shop_order_validations v WHERE v.order_id = o.id) AS validated, (SELECT 1 FROM shop_order_sends s WHERE s.order_id = o.id) AS sent,
              (SELECT outcome FROM shop_order_results r WHERE r.order_id = o.id) AS outcome
         FROM shop_orders o WHERE o.agent_id = ? AND o.network_id = ? ORDER BY o.prepared_at DESC, o.rowid DESC`,
      [viewer.userId, viewer.networkId],
    );
    return rows.map((r) => ({
      id: r.id,
      support: r.support,
      propertyId: r.property_id,
      quantity: Number(r.quantity),
      priceCents: Number(r.price_cents),
      preparedAt: r.prepared_at,
      status: r.outcome === 'envoyee' ? 'envoyee' : r.outcome === 'echec' ? 'echec' : r.validated ? 'validee' : 'preparee',
    }));
  }
}

