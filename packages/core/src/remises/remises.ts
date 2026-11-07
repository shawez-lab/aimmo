/**
 * Remises négociées pour les agents du réseau (HX08) [R266, R267].
 *
 * - La direction range chaque remise avec son fournisseur, sa source (devis, contrat, courrier) et sa date de fin, jamais
 *   sans. Une remise rangée ne change plus : une correction est une nouvelle remise, l'ancienne retirée [R17]. Dès le
 *   lendemain de sa date de fin (jour de Paris), elle n'est plus montrée ni proposée, sans que personne n'agisse [R266].
 * - Jamais vu : la remise arrive au bon moment du dossier, lu dans la base et jamais déclaré. Le moment d'un bien est le
 *   plus avancé : acte signé depuis moins de 90 jours, compromis en cours, annonce en vente, mandat inscrit au registre,
 *   sinon estimation. La remise d'un photographe n'est pas proposée pour un bien dont les photos sont déjà certifiées ;
 *   celle d'un partenaire de l'annuaire, seulement s'il est justifié ce jour-là et couvre le code postal du bien [R73].
 *   Une remise écartée par l'agent pour un bien n'y revient plus [R267].
 * - Une remise d'un diagnostiqueur, d'un déménageur ou d'un artisan ne profite qu'au client, jamais à l'agent ni au
 *   réseau [R76] ; courtiers, banques et notaires n'ont pas de remise ici. Les remises pour le client sont montrées dans
 *   un ordre tiré au sort, et le client choisit son professionnel avec l'agent [R75].
 * - Rien ne part : ni au fournisseur, ni au client. AIMMO ne transmet aucun moyen de paiement.
 * - Aucune donnée personnelle au journal : seulement des identifiants internes [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Annuaire } from '../partenaires/annuaire.ts';

export const DISCOUNT_CATEGORIES = [
  { category: 'photographe', label: 'Photographe', trade: 'photographe' },
  { category: 'diagnostiqueur', label: 'Diagnostiqueur certifié', trade: 'diagnostiqueur' },
  { category: 'home_staging', label: 'Mise en valeur du bien', trade: null },
  { category: 'demenageur', label: 'Déménageur', trade: 'demenageur' },
  { category: 'artisan', label: 'Artisan', trade: 'artisan' },
  { category: 'assurance', label: 'Assurance', trade: null },
  { category: 'outil', label: 'Outil', trade: null },
  { category: 'formation', label: 'Formation', trade: null },
  { category: 'materiel', label: 'Matériel', trade: null },
] as const;
export type DiscountCategory = (typeof DISCOUNT_CATEGORIES)[number]['category'];

/** Catégories dont la remise ne profite qu'au client, jamais à l'agent ni au réseau [R76]. */
export const CLIENT_ONLY: readonly DiscountCategory[] = ['diagnostiqueur', 'demenageur', 'artisan'];

export const MOMENTS = ['estimation', 'mandat', 'en_vente', 'compromis', 'acte', 'toujours'] as const;
export type Moment = (typeof MOMENTS)[number];
/** Moments d'un dossier ; `toujours` est une remise pour l'agent, montrée au catalogue et jamais dans un dossier. */
export type DossierMoment = Exclude<Moment, 'toujours'>;
export type Beneficiary = 'agent' | 'client';

/** Jours après l'acte pendant lesquels le bien reste au moment « acte ». */
export const AFTER_DEED_DAYS = 90;

export interface DiscountInput {
  category: unknown;
  supplier: unknown;
  partnerId?: unknown;
  beneficiary: unknown;
  title: unknown;
  terms: unknown;
  source: unknown;
  moment: unknown;
  validFrom: unknown;
  validUntil: unknown;
}

export interface DiscountView {
  id: string;
  category: DiscountCategory;
  supplier: string;
  partnerId: string | null;
  beneficiary: Beneficiary;
  title: string;
  terms: string;
  source: string;
  moment: Moment;
  validFrom: string;
  validUntil: string;
}

export interface Suggestion extends DiscountView {
  /** Pourquoi maintenant, en une ligne lue dans le dossier. */
  why: string;
}

export interface Suggestions {
  propertyId: string;
  moment: DossierMoment;
  forAgent: Suggestion[];
  /** Pour le client, dans un ordre tiré au sort ; le client choisit son professionnel avec l'agent [R75]. */
  forClient: Suggestion[];
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R76' | 'R266' | null; code: string };

interface Row {
  id: string;
  network_id: string;
  category: DiscountCategory;
  supplier: string;
  partner_id: string | null;
  beneficiary: Beneficiary;
  title: string;
  terms: string;
  source: string;
  moment: Moment;
  valid_from: string;
  valid_until: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const text = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length >= min && t.length <= max ? t : null;
};
const categoryOf = (c: DiscountCategory) => DISCOUNT_CATEGORIES.find((d) => d.category === c)!;

const WHY: Record<DossierMoment, string> = {
  estimation: 'Bien en estimation, sans mandat inscrit au registre.',
  mandat: 'Mandat inscrit au registre, annonce pas encore en vente.',
  en_vente: 'Annonce en vente.',
  compromis: 'Compromis en cours.',
  acte: 'Acte signé il y a moins de 90 jours.',
};

const toView = (r: Row): DiscountView => ({
  id: r.id,
  category: r.category,
  supplier: r.supplier,
  partnerId: r.partner_id,
  beneficiary: r.beneficiary,
  title: r.title,
  terms: r.terms,
  source: r.source,
  moment: r.moment,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
});

export interface RemisesOptions {
  now?: () => Date;
  newId?: () => string;
  /** Tirage au sort de l'ordre des remises pour le client [R75] ; un nombre dans [0, 1). */
  random?: () => number;
  annuaire?: Annuaire;
}

export class Remises {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly random: () => number;
  private readonly annuaire: Annuaire;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: RemisesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.random = options.random ?? Math.random;
    // Seule la lecture des justificatifs sert ici : aucune pièce n'est rangée par les remises.
    this.annuaire = options.annuaire ?? new Annuaire(db, { has: async () => false }, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return localTime(this.now(), 'Europe/Paris').date;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'remises', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async activeAgent(viewer: Viewer): Promise<boolean> {
    if (viewer.role !== 'agent') return false;
    const a = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    return a?.status === 'active';
  }

  /** Les remises en vigueur ce jour-là : commencées, pas échues, pas retirées [R266]. */
  private async active(networkId: string): Promise<Row[]> {
    const day = this.today();
    return this.db.all<Row>(
      `SELECT d.id, d.network_id, d.category, d.supplier, d.partner_id, d.beneficiary, d.title, d.terms, d.source, d.moment, d.valid_from, d.valid_until
         FROM network_discounts d
        WHERE d.network_id = ? AND d.valid_from <= ? AND d.valid_until >= ?
          AND NOT EXISTS (SELECT 1 FROM network_discount_withdrawals w WHERE w.discount_id = d.id)
        ORDER BY d.valid_until, d.set_at, d.id`,
      [networkId, day, day],
    );
  }

  /** Une remise, depuis sa source : la direction seule [R266, R76]. */
  async setDiscount(viewer: Viewer, input: DiscountInput): Promise<{ ok: true; discountId: string } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const cat = DISCOUNT_CATEGORIES.find((d) => d.category === input.category);
    if (!cat) return { ok: false, rule: null, code: 'bad_category' };
    if (input.beneficiary !== 'agent' && input.beneficiary !== 'client') return { ok: false, rule: null, code: 'bad_beneficiary' };
    // Aucun avantage d'un diagnostiqueur, d'un déménageur ou d'un artisan à l'agent ou au réseau [R76].
    if (CLIENT_ONLY.includes(cat.category) && input.beneficiary !== 'client') return { ok: false, rule: 'R76', code: 'client_seulement' };
    if (typeof input.moment !== 'string' || !(MOMENTS as readonly string[]).includes(input.moment)) return { ok: false, rule: null, code: 'bad_moment' };
    if (input.moment === 'toujours' && input.beneficiary === 'client') return { ok: false, rule: null, code: 'moment_du_dossier' };
    const supplier = text(input.supplier, 2, 80);
    if (!supplier) return { ok: false, rule: null, code: 'bad_supplier' };
    const title = text(input.title, 2, 120);
    if (!title) return { ok: false, rule: null, code: 'bad_title' };
    const terms = text(input.terms, 2, 600);
    if (!terms) return { ok: false, rule: null, code: 'bad_terms' };
    const source = text(input.source, 2, 200);
    if (!source) return { ok: false, rule: 'R266', code: 'sans_source' };
    if (!isDay(input.validFrom) || !isDay(input.validUntil)) return { ok: false, rule: 'R266', code: 'bad_date' };
    if (input.validUntil < input.validFrom) return { ok: false, rule: 'R266', code: 'bad_date' };
    if (input.validUntil < this.today()) return { ok: false, rule: 'R266', code: 'deja_echue' };
    let partnerId: string | null = null;
    if (input.partnerId !== undefined && input.partnerId !== null) {
      if (typeof input.partnerId !== 'string') return { ok: false, rule: null, code: 'bad_partner' };
      const p = await this.db.first<{ trade: string }>('SELECT trade FROM partners WHERE id = ? AND network_id = ?', [input.partnerId, viewer.networkId]);
      if (!p) return { ok: false, rule: null, code: 'unknown_partner' };
      if (p.trade !== cat.trade) return { ok: false, rule: null, code: 'partner_trade' };
      partnerId = input.partnerId;
    }
    // Un diagnostiqueur n'est proposé que depuis l'annuaire, avec ses certifications [R73].
    if (cat.category === 'diagnostiqueur' && !partnerId) return { ok: false, rule: null, code: 'partenaire_requis' };
    const id = this.newId();
    await this.db.run(
      `INSERT INTO network_discounts (id, network_id, category, supplier, partner_id, beneficiary, title, terms, source, moment, valid_from, valid_until, set_by, set_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, cat.category, supplier, partnerId, input.beneficiary, title, terms, source, input.moment, input.validFrom, input.validUntil, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'remise.rangee', actor: this.actor(viewer), subject: `discount:${id}`, data: { rule: 'R266', category: cat.category, moment: input.moment, beneficiary: input.beneficiary, validUntil: input.validUntil } }, this.now);
    return { ok: true, discountId: id };
  }

  /** Retirer une remise avant sa date de fin : la direction seule, une fois, avec sa raison [R266]. */
  async withdraw(viewer: Viewer, discountId: string, reasonInput: unknown): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `discount:${discountId}`, 'role');
    const d = await this.db.first<{ id: string }>('SELECT id FROM network_discounts WHERE id = ? AND network_id = ?', [discountId, viewer.networkId]);
    if (!d) return { ok: false, rule: null, code: 'unknown_discount' };
    const reason = text(reasonInput, 2, 200);
    if (!reason) return { ok: false, rule: null, code: 'bad_reason' };
    const r = await this.db.run('INSERT OR IGNORE INTO network_discount_withdrawals (discount_id, reason, withdrawn_by, withdrawn_at) VALUES (?, ?, ?, ?)', [discountId, reason, this.actor(viewer), this.now().toISOString()]);
    if (r.changes === 0) return { ok: false, rule: null, code: 'deja_retiree' };
    await appendEvent(this.journal, { type: 'remise.retiree', actor: this.actor(viewer), subject: `discount:${discountId}`, data: { rule: 'R266' } }, this.now);
    return { ok: true };
  }

  /** Le catalogue du jour : les remises en vigueur, pour un agent actif ou la direction [R266, R16]. */
  async catalogue(viewer: Viewer): Promise<{ ok: true; value: DiscountView[] } | Refusal> {
    if (viewer.role !== 'direction' && !(await this.activeAgent(viewer))) return this.refuse(viewer, `network:${viewer.networkId}`, viewer.role === 'agent' ? 'agent_inactive' : 'role');
    return { ok: true, value: (await this.active(viewer.networkId)).map(toView) };
  }

  /** Le moment du dossier d'un bien, lu dans la base, jamais déclaré ; `null` passé 90 jours après l'acte [R267]. */
  async momentOf(networkId: string, propertyId: string): Promise<DossierMoment | null> {
    const file = await this.db.first<{ id: string; signed_on: string | null; stopped: number }>(
      `SELECT f.id, c.signed_on, EXISTS (SELECT 1 FROM sale_file_stops s WHERE s.file_id = f.id) AS stopped
         FROM sale_files f LEFT JOIN sale_file_closings c ON c.file_id = f.id
        WHERE f.property_id = ? AND f.network_id = ?`,
      [propertyId, networkId],
    );
    if (file && file.signed_on) {
      const deedDay = Date.parse(`${file.signed_on}T00:00:00Z`);
      const today = Date.parse(`${this.today()}T00:00:00Z`);
      return (today - deedDay) / 86_400_000 < AFTER_DEED_DAYS ? 'acte' : null;
    }
    if (file && !Number(file.stopped)) return 'compromis';
    const listing = await this.db.first<{ state: string }>('SELECT state FROM listing_versions WHERE property_id = ? AND network_id = ? ORDER BY seq DESC LIMIT 1', [propertyId, networkId]);
    if (listing?.state === 'en_vente') return 'en_vente';
    const mandate = await this.db.first<{ seq: number }>(
      `SELECT r.seq FROM mandate_register r
        WHERE r.network_id = ? AND r.property_id = ? AND r.kind = 'inscription'
          AND NOT EXISTS (SELECT 1 FROM mandate_register a WHERE a.network_id = r.network_id AND a.kind = 'annulation' AND a.cancels_seq = r.seq)
        LIMIT 1`,
      [networkId, propertyId],
    );
    return mandate ? 'mandat' : 'estimation';
  }

  /**
   * Les remises à proposer pour un bien, maintenant : au seul agent du bien, au moment lu dans la base, sans celles
   * qu'il a écartées pour ce bien, ni celles qui ne servent plus à rien pour lui [R267, R73].
   */
  async suggestionsFor(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: Suggestions | null } | Refusal | Problem> {
    const subject = `property:${propertyId}`;
    if (!(await this.activeAgent(viewer))) return this.refuse(viewer, subject, viewer.role === 'agent' ? 'agent_inactive' : 'role');
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : this.refuse(viewer, subject, String(p.code));
    if (p.view !== 'full' || p.value.agent_id !== viewer.userId) return this.refuse(viewer, subject, 'not_assigned');
    const moment = await this.momentOf(p.value.network_id, propertyId);
    // Après les 90 jours de l'acte, plus rien n'est proposé pour ce bien.
    if (moment === null) return { ok: true, value: null };
    const dismissed = new Set(
      (await this.db.all<{ discount_id: string }>('SELECT discount_id FROM network_discount_dismissals WHERE property_id = ? AND agent_id = ?', [propertyId, viewer.userId])).map((r) => r.discount_id),
    );
    const photosDone = (await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM photo_certificates WHERE property_id = ? AND network_id = ?', [propertyId, p.value.network_id]))!.n > 0;
    const postcode = p.value.postal_code;
    const keep: Suggestion[] = [];
    for (const r of await this.active(p.value.network_id)) {
      if (r.moment !== moment || dismissed.has(r.id)) continue;
      // Les photos du bien sont déjà faites et certifiées : la remise du photographe ne sert plus.
      if (r.category === 'photographe' && photosDone) continue;
      if (r.partner_id) {
        // Un partenaire de l'annuaire n'est proposé que justifié ce jour-là, et dans la zone du bien [R73].
        if (!postcode) continue;
        const zone = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM partner_zones WHERE partner_id = ? AND postcode = ?', [r.partner_id, postcode]);
        if (!zone || Number(zone.n) === 0) continue;
        if (!(await this.annuaire.proposableOn(p.value.network_id, r.partner_id, this.now()))) continue;
      }
      keep.push({ ...toView(r), why: WHY[moment] });
    }
    const forClient = keep.filter((s) => s.beneficiary === 'client');
    // Ordre tiré au sort, jamais un classement [R75].
    for (let i = forClient.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [forClient[i], forClient[j]] = [forClient[j]!, forClient[i]!];
    }
    await appendEvent(this.journal, { type: 'remise.proposee', actor: this.actor(viewer), subject, data: { rule: 'R267', moment, count: keep.length } }, this.now);
    return { ok: true, value: { propertyId, moment, forAgent: keep.filter((s) => s.beneficiary === 'agent'), forClient } };
  }

  /** L'agent écarte une remise pour un bien : elle n'y revient plus [R267]. */
  async dismiss(viewer: Viewer, discountId: string, propertyId: string): Promise<{ ok: true } | Refusal | Problem> {
    const subject = `property:${propertyId}`;
    if (!(await this.activeAgent(viewer))) return this.refuse(viewer, subject, viewer.role === 'agent' ? 'agent_inactive' : 'role');
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : this.refuse(viewer, subject, String(p.code));
    if (p.view !== 'full' || p.value.agent_id !== viewer.userId) return this.refuse(viewer, subject, 'not_assigned');
    const d = await this.db.first<{ id: string }>('SELECT id FROM network_discounts WHERE id = ? AND network_id = ?', [discountId, viewer.networkId]);
    if (!d) return { ok: false, rule: null, code: 'unknown_discount' };
    await this.db.run('INSERT OR IGNORE INTO network_discount_dismissals (discount_id, property_id, agent_id, network_id, dismissed_at) VALUES (?, ?, ?, ?, ?)', [discountId, propertyId, viewer.userId, viewer.networkId, this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'remise.ecartee', actor: this.actor(viewer), subject, data: { rule: 'R267', discount: discountId } }, this.now);
    return { ok: true };
  }

  /** Le libellé d'une catégorie, pour l'écran. */
  static label(category: DiscountCategory): string {
    return categoryOf(category).label;
  }
}
