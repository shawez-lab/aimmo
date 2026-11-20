/**
 * Offre écrite enregistrée, avec son registre chaîné (M09, O01) [R56].
 *
 * L'agent du bien (ou la direction) enregistre chaque offre reçue pour un bien en vente : acquéreur, montant,
 * conditions suspensives dans une liste fermée, dernier jour de validité, financement déclaré, référence de l'offre
 * signée. L'offre prend aussitôt sa place dans le registre des offres du bien : un numéro dans l'ordre d'arrivée, sans
 * trou, et l'empreinte de l'offre précédente. L'empreinte de chaque ligne est aussi ancrée au journal à empreintes,
 * lui-même chaîné : une ligne modifiée, retirée ou réécrite après coup est détectée par le contrôle.
 *
 * « Jamais vu » : le vendeur peut voir combien d'offres ont été reçues pour son bien et que le registre est intact ;
 * aucune offre ne peut lui être cachée sans que cela se voie.
 *
 * Décidé, lecture prudente : un bien reçoit des offres seulement s'il peut être diffusé (mandat en cours, D05) ;
 * l'acquéreur doit être une fiche que celui qui enregistre voit en entier, ou que le collègue qui la suit a partagée
 * avec l'agent du bien pour ce seul bien (AU081) ; la durée de validité est gardée telle que l'offre la
 * donne, jusqu'à deux ans (une saisie au-delà est une faute de frappe) ; au-delà de 60 jours elle est inhabituelle et le
 * contrôle de l'offre le signale, sans jamais refuser le fait reçu (AU080) ; le
 * financement déclaré ne sert qu'à vérifier la cohérence des montants (O02), jamais à noter l'acquéreur [R14].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { FicheComplete } from '../fiche/fusion.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { Diffusion } from '../documents/retractation.ts';
import { LIVE_MANDATES } from '../espaces/lecture.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
export const OFFER_GENESIS = '0'.repeat(64);
/** La durée de validité usuelle d'une offre : au-delà, le contrôle signale une durée inhabituelle (AU080). */
export const USUAL_VALIDITY_DAYS = 60;
/** La plus longue durée de validité gardée : au-delà, une date mal saisie, jamais une offre réelle (AU080). */
export const MAX_VALIDITY_DAYS = 730;

/** Le nombre de jours entre le jour de réception (heure de Paris) et le dernier jour de validité. */
export const validityDays = (receivedAt: string, validUntil: string): number =>
  Math.round((Date.parse(`${validUntil}T12:00:00Z`) - Date.parse(`${localTime(new Date(receivedAt), TIME_ZONE).date}T12:00:00Z`)) / 86_400_000);
/** Coacquéreurs d'une offre, en plus de l'acquéreur en tête (AU009). */
export const MAX_CO_BUYERS = 3;

/** `autre` : une autre condition, sans texte libre ; son contenu est dans l'offre signée rangée par sa référence. */
export const CONDITION_KINDS = ['pret', 'vente_autre_bien', 'permis_construire', 'certificat_urbanisme', 'autre'] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

/** Le type du prêt déclaré dans la condition, liste fermée (AU079). `ptz` : prêt à taux zéro. */
export const LOAN_TYPES = ['amortissable', 'in_fine', 'relais', 'ptz'] as const;
export type LoanType = (typeof LOAN_TYPES)[number];
/** Le taux nominal annuel maximal hors assurance, en centièmes de point : 385 pour 3,85 % ; de 0,01 % à 20 %. */
export const MAX_RATE_BP = 2000;

/**
 * La condition de prêt porte son montant et sa durée, et, quand l'offre les déclare, le taux nominal maximal hors
 * assurance et le type de prêt (AU079). Facultatifs : une offre d'avant les garde absents, et son empreinte ne change pas.
 */
export type LoanCondition = { kind: 'pret'; amountEur: number; durationMonths: number; maxRateBp?: number; loanType?: LoanType };

export type OfferCondition =
  | LoanCondition
  | { kind: 'vente_autre_bien' }
  | { kind: 'permis_construire' }
  | { kind: 'certificat_urbanisme' }
  | { kind: 'autre' };

export interface OfferInput {
  buyerPersonId: unknown;
  /** Les coacquéreurs, chacun sa fiche, jamais fusionnée avec celle de l'acquéreur en tête (AU009) ; facultatif. */
  coBuyerPersonIds?: unknown;
  amountEur: unknown;
  conditions: unknown;
  validUntil: unknown;
  downPaymentEur: unknown;
  loanEur: unknown;
  signedRef: unknown;
  receivedAt: unknown;
  /** Clé d'envoi facultative : un double envoi avec la même clé rend l'offre déjà enregistrée. */
  requestKey?: unknown;
}

export interface Offer {
  id: string;
  propertyId: string;
  seq: number;
  buyerPersonId: string;
  /** Les coacquéreurs, dans l'ordre de l'offre signée ; vide pour un acquéreur seul. */
  coBuyerPersonIds: string[];
  amountEur: number;
  conditions: OfferCondition[];
  validUntil: string;
  downPaymentEur: number;
  loanEur: number;
  signedRef: string;
  receivedAt: string;
  agentId: string;
  at: string;
  hash: string;
}

export type RegisterCheck =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAt: number; problem: 'sequence' | 'chain' | 'hash' | 'anchor' };

interface Row {
  id: string;
  network_id: string;
  property_id: string;
  seq: number;
  buyer_person_id: string;
  /** JSON : les fiches des coacquéreurs ; `[]` pour un acquéreur seul (migration 3970). */
  co_buyers?: string;
  amount_eur: number;
  conditions: string;
  valid_until: string;
  down_payment_eur: number;
  loan_eur: number;
  signed_ref: string;
  received_at: string;
  agent_id: string;
  at: string;
  actor: string;
  prev_hash: string;
  hash: string;
}

/**
 * L'empreinte d'une offre : tout ce qu'elle porte, dans un ordre fixe, et l'empreinte de la précédente. Les coacquéreurs
 * s'y ajoutent dès qu'il y en a un : une offre d'un acquéreur seul garde l'empreinte qu'elle avait avant AU009.
 */
export async function hashOffer(r: Omit<Row, 'hash'>): Promise<string> {
  const fields: unknown[] = [
    r.id, r.network_id, r.property_id, Number(r.seq), r.buyer_person_id, Number(r.amount_eur), r.conditions, r.valid_until,
    Number(r.down_payment_eur), Number(r.loan_eur), r.signed_ref, r.received_at, r.agent_id, r.at, r.actor, r.prev_hash,
  ];
  if (r.co_buyers !== undefined && r.co_buyers !== '[]') fields.push(r.co_buyers);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fields)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** L'ancre au journal : l'empreinte écrite en lettres, pour qu'aucune suite de chiffres ne ressemble à un numéro [R13]. */
export const offerAnchor = (hash: string): string => hash.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED_REF = /^offres\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|jpg|png)$/;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const validDay = (d: unknown): d is string => {
  if (typeof d !== 'string' || !DAY.test(d)) return false;
  const t = Date.parse(`${d}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/**
 * Lit une condition de prêt : montant et durée exigés, taux maximal et type facultatifs, rangés dans un ordre fixe pour
 * que deux saisies équivalentes donnent le même texte (et la même empreinte). `extra` : les clés admises en plus (`page`).
 */
export function parseLoan(c: Record<string, unknown>, extra: string[]): { ok: true; value: LoanCondition } | { ok: false; field: string | null } {
  if (Object.keys(c).some((k) => !['kind', 'amountEur', 'durationMonths', 'maxRateBp', 'loanType', ...extra].includes(k))) return { ok: false, field: null };
  if (!isInt(c.amountEur, 1, 100_000_000)) return { ok: false, field: 'amountEur' };
  if (!isInt(c.durationMonths, 1, 480)) return { ok: false, field: 'durationMonths' };
  if (c.maxRateBp !== undefined && !isInt(c.maxRateBp, 1, MAX_RATE_BP)) return { ok: false, field: 'maxRateBp' };
  if (c.loanType !== undefined && !(LOAN_TYPES as readonly unknown[]).includes(c.loanType)) return { ok: false, field: 'loanType' };
  const value: LoanCondition = { kind: 'pret', amountEur: c.amountEur, durationMonths: c.durationMonths };
  if (c.maxRateBp !== undefined) value.maxRateBp = c.maxRateBp as number;
  if (c.loanType !== undefined) value.loanType = c.loanType as LoanType;
  return { ok: true, value };
}

/** Un taux en centièmes de point, écrit à la française : 385 → « 3,85 % ». */
export const rateText = (bp: number): string => `${Math.floor(bp / 100)},${String(bp % 100).padStart(2, '0')} %`;

export const LOAN_TYPE_LABEL: Record<LoanType, string> = { amortissable: 'amortissable', in_fine: 'in fine', relais: 'relais', ptz: 'à taux zéro' };

/** Contrôle les conditions suspensives : liste fermée, une fois chacune, le prêt avec son montant et sa durée, son taux maximal et son type quand l'offre les déclare. */
export function parseConditions(v: unknown): { ok: true; value: OfferCondition[] } | { ok: false; field: string } {
  if (!Array.isArray(v) || v.length > CONDITION_KINDS.length) return { ok: false, field: 'conditions' };
  const out: OfferCondition[] = [];
  const seen = new Set<string>();
  for (const [i, c] of v.entries()) {
    if (!isRecord(c) || !(CONDITION_KINDS as readonly unknown[]).includes(c.kind) || seen.has(String(c.kind))) return { ok: false, field: `conditions.${i}` };
    seen.add(String(c.kind));
    if (c.kind === 'pret') {
      const loan = parseLoan(c, []);
      if (!loan.ok) return { ok: false, field: loan.field ? `conditions.${i}.${loan.field}` : `conditions.${i}` };
      out.push(loan.value);
    } else {
      if (Object.keys(c).some((k) => k !== 'kind')) return { ok: false, field: `conditions.${i}` };
      out.push({ kind: c.kind as Exclude<ConditionKind, 'pret'> });
    }
  }
  // Rangées dans l'ordre de la liste fermée : deux saisies équivalentes donnent la même offre.
  out.sort((a, b) => CONDITION_KINDS.indexOf(a.kind) - CONDITION_KINDS.indexOf(b.kind));
  return { ok: true, value: out };
}

type Refusal = { ok: false; rule: 'R16'; code: string };

/**
 * Le partage d'un acquéreur avec l'agent d'un bien (AU081) : le collègue qui suit l'acquéreur autorise l'agent du bien à
 * présenter son offre pour ce seul bien. L'agent du bien n'en reçoit aucune donnée de la fiche : seulement le droit
 * d'inscrire l'offre au registre sous l'identifiant de l'acquéreur. Il ne vaut que tant que le collègue suit toujours
 * l'acquéreur et peut l'ouvrir lui-même ; retiré, il ne sert plus, et les offres déjà inscrites restent [R17].
 */
export interface BuyerShare {
  id: string;
  propertyId: string;
  buyerPersonId: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
}
type ShareRow = { id: string; network_id: string; property_id: string; buyer_person_id: string; granted_by: string; granted_at: string; revoked_at: string | null; revoked_by: string | null };
const toShare = (r: ShareRow): BuyerShare => ({ id: r.id, propertyId: r.property_id, buyerPersonId: r.buyer_person_id, grantedBy: r.granted_by, grantedAt: r.granted_at, revokedAt: r.revoked_at });
type BuyerRead = { ok: true; value: FicheComplete } | Refusal | { ok: false; rule: null; code: 'unknown_buyer' };
type Problem =
  | { ok: false; rule: null; code: 'invalid'; field: string }
  | { ok: false; rule: null; code: 'unknown_property' | 'unknown_buyer' | 'busy' | 'unknown_share' | 'own_property' }
  | { ok: false; rule: null; code: 'buyer_is_seller'; field: 'buyerPersonId' | `coBuyerPersonIds.${number}` }
  | { ok: false; rule: null; code: 'same_buyer'; field: `coBuyerPersonIds.${number}` }
  | { ok: false; rule: 'R42'; code: 'not_on_sale' }
  | { ok: false; rule: 'R505'; code: 'remote_slip_unsigned'; appointmentId: string }
  | { ok: false; rule: 'R56'; code: 'request_key_reused' };

/** Le texte du déclencheur `offer_register_bon_distance_signe` de la migration `2304` [R505]. */
const REMOTE_SLIP_TRIGGER = /bon de la visite à distance non signé/;

/**
 * Le rendez-vous d'une visite à distance de cet acquéreur sur ce bien dont le bon n'est pas encore signé en ligne, ou null
 * (RC25) [R505]. Même requête que la garde de la base (`offer_register_bon_distance_signe`) : les deux fiches remontent la
 * suite entière de leurs réunions en cours et se rejoignent si elles ont la même fiche de tête ; la plus ancienne visite
 * d'abord. La base reste la vraie barrière : cette lecture ne sert qu'à dire le refus en mots.
 */
export async function remoteSlipMissing(db: SqlDatabase, networkId: string, propertyId: string, buyerPersonId: string): Promise<string | null> {
  let row: { appointment_id: string } | null;
  try {
    row = await db.first<{ appointment_id: string }>(
      `SELECT rv.appointment_id FROM remote_visits rv
        WHERE rv.network_id = ? AND rv.property_id = ?
          AND NOT EXISTS (SELECT 1 FROM remote_slip_signatures s WHERE s.appointment_id = rv.appointment_id AND s.status = 'signee')
          AND EXISTS (
            WITH RECURSIVE
              acheteur(id) AS (SELECT ? UNION SELECT pm.survivor_id FROM person_merges pm JOIN acheteur ON pm.merged_id = acheteur.id WHERE pm.undone_at IS NULL),
              visiteur(id) AS (SELECT rv.person_id UNION SELECT pm.survivor_id FROM person_merges pm JOIN visiteur ON pm.merged_id = visiteur.id WHERE pm.undone_at IS NULL)
            SELECT 1 FROM acheteur JOIN visiteur ON acheteur.id = visiteur.id
          )
        ORDER BY rv.started_at, rv.appointment_id LIMIT 1`,
      [networkId, propertyId, buyerPersonId],
    );
  } catch (error) {
    // Une base d'avant la migration `2304` n'a ni ces tables ni leur garde : aucune visite à distance n'y existe.
    if (/no such table: (remote_visits|remote_slip_signatures)\b/.test(String(error))) return null;
    throw error;
  }
  return row ? row.appointment_id : null;
}

const toOffer = (r: Row): Offer => ({
  id: r.id,
  propertyId: r.property_id,
  seq: Number(r.seq),
  buyerPersonId: r.buyer_person_id,
  coBuyerPersonIds: JSON.parse(r.co_buyers ?? '[]') as string[],
  amountEur: Number(r.amount_eur),
  conditions: JSON.parse(r.conditions) as OfferCondition[],
  validUntil: r.valid_until,
  downPaymentEur: Number(r.down_payment_eur),
  loanEur: Number(r.loan_eur),
  signedRef: r.signed_ref,
  receivedAt: r.received_at,
  agentId: r.agent_id,
  at: r.at,
  hash: r.hash,
});

export class RegistreOffres {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly diffusion: Diffusion;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.diffusion = new Diffusion(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /**
   * Le bon de la visite à distance manque (RC25) [R505] : le refus nomme le rendez-vous, écrit au journal sous la visite,
   * que lit l'acquéreur lui-même et jamais le vendeur [R96], avec des identifiants seulement [R13].
   */
  private async slipMissing(viewer: Viewer, propertyId: string, appointmentId: string): Promise<Problem> {
    await appendEvent(this.journal, { type: 'offre.bon_distance_manquant', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R505', property: propertyId } }, this.now);
    return { ok: false, rule: 'R505', code: 'remote_slip_unsigned', appointmentId };
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'offer', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Seuls l'agent du bien et la direction enregistrent et lisent les offres d'un bien [R16]. */
  async gate(viewer: Viewer, propertyId: string): Promise<{ ok: true; networkId: string; agentId: string } | Refusal | Problem> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full') return this.refuse(viewer, `property:${propertyId}`, 'not_assigned');
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, `property:${propertyId}`, 'role');
    if (!p.value.agent_id) return { ok: false, rule: null, code: 'unknown_property' };
    return { ok: true, networkId: p.value.network_id, agentId: p.value.agent_id };
  }

  /**
   * L'acquéreur d'une offre, vu par celui qui l'enregistre (AU081) [R16]. L'agent du bien qui ne suit pas l'acquéreur
   * passe par le partage en cours du collègue qui le suit, pour ce bien : la fiche est relue sous les droits de ce
   * collègue (lecture écrite au journal à son nom, comme toute lecture), et l'usage du partage est écrit au nom de
   * l'agent du bien. Rien de la fiche n'est rendu à l'agent du bien : l'offre ne garde que l'identifiant.
   */
  async buyerFor(viewer: Viewer, propertyId: string, personId: string): Promise<BuyerRead> {
    if (viewer.role === 'agent') {
      const share = await this.db.first<ShareRow>(
        `SELECT s.* FROM offer_buyer_shares s JOIN properties p ON p.id = s.property_id
         WHERE s.property_id = ? AND s.buyer_person_id = ? AND s.revoked_at IS NULL AND s.network_id = ? AND p.agent_id = ? AND s.granted_by <> ?
         ORDER BY s.granted_at DESC LIMIT 1`,
        [propertyId, personId, viewer.networkId, viewer.userId, viewer.userId],
      );
      if (share) {
        const colleague = { role: 'agent', userId: share.granted_by, networkId: viewer.networkId } as Viewer;
        const read = await this.acces.readFiche(colleague, personId);
        // Le collègue ne suit plus l'acquéreur, ou ne peut plus l'ouvrir : le partage ne vaut plus.
        if (!read.ok || read.view !== 'full') return this.refuse(viewer, `person:${personId}`, 'share_lapsed');
        await appendEvent(this.journal, { type: 'offre.partage_utilise', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', share: share.id } }, this.now);
        return { ok: true, value: read.value };
      }
    }
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return read.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_buyer' } : (read as Refusal);
    if (read.view !== 'full') return this.refuse(viewer, `person:${personId}`, 'not_assigned');
    return { ok: true, value: read.value };
  }

  /**
   * Le collègue qui suit un acquéreur autorise l'agent d'un bien du réseau à présenter l'offre de cet acquéreur, pour ce
   * seul bien, sans la direction (AU081) [R16]. Il doit voir la fiche en entier et le bien (fichier commun) ; un partage
   * déjà en cours est rendu tel quel. Au journal : le partage, le bien et la fiche en identifiants, aucun nom [R13].
   */
  async shareBuyer(viewer: Viewer, propertyId: string, buyerPersonId: unknown): Promise<{ ok: true; value: BuyerShare } | Refusal | Problem> {
    if (typeof buyerPersonId !== 'string' || buyerPersonId.length === 0 || buyerPersonId.length > 64) return { ok: false, rule: null, code: 'invalid', field: 'buyerPersonId' };
    if (viewer.role !== 'agent') return this.refuse(viewer, `property:${propertyId}`, 'role');
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (!p.value.agent_id) return { ok: false, rule: null, code: 'unknown_property' };
    // L'agent du bien qui suit lui-même l'acquéreur n'a rien à partager.
    if (p.value.agent_id === viewer.userId) return { ok: false, rule: null, code: 'own_property' };
    const buyer = await this.acces.readFiche(viewer, buyerPersonId);
    if (!buyer.ok) return buyer.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_buyer' } : (buyer as Refusal);
    if (buyer.view !== 'full') return this.refuse(viewer, `person:${buyerPersonId}`, 'not_assigned');
    const ids = [...new Set([buyerPersonId, buyer.value.person.id])];
    const live = await this.db.first<ShareRow>(
      `SELECT * FROM offer_buyer_shares WHERE property_id = ? AND granted_by = ? AND revoked_at IS NULL AND buyer_person_id IN (${ids.map(() => '?').join(', ')}) ORDER BY granted_at LIMIT 1`,
      [propertyId, viewer.userId, ...ids],
    );
    if (live) return { ok: true, value: toShare(live) };
    const row: ShareRow = {
      id: this.newId(), network_id: viewer.networkId, property_id: propertyId, buyer_person_id: buyer.value.person.id,
      granted_by: viewer.userId, granted_at: this.now().toISOString(), revoked_at: null, revoked_by: null,
    };
    await appendEvent(this.journal, { type: 'offre.partage_acquereur', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', share: row.id, person: `person:${row.buyer_person_id}` } }, this.now);
    await this.db.run(
      'INSERT INTO offer_buyer_shares (id, network_id, property_id, buyer_person_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)',
      [row.id, row.network_id, row.property_id, row.buyer_person_id, row.granted_by, row.granted_at],
    );
    return { ok: true, value: toShare(row) };
  }

  /** Le collègue qui l'a donné, ou la direction, retire le partage ; la ligne reste, datée, et les offres inscrites aussi [R17]. */
  async revokeShare(viewer: Viewer, shareId: string): Promise<{ ok: true; value: BuyerShare } | Refusal | Problem> {
    const row = await this.db.first<ShareRow>('SELECT * FROM offer_buyer_shares WHERE id = ?', [shareId]);
    if (!row || row.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_share' };
    const mine = viewer.role === 'agent' && viewer.userId === row.granted_by;
    if (!mine && viewer.role !== 'direction') return this.refuse(viewer, `offer_share:${shareId}`, 'not_assigned');
    if (row.revoked_at !== null) return { ok: true, value: toShare(row) };
    const at = this.now().toISOString();
    await appendEvent(this.journal, { type: 'offre.partage_retire', actor: this.actor(viewer), subject: `property:${row.property_id}`, data: { rule: 'R16', share: row.id } }, this.now);
    await this.db.run('UPDATE offer_buyer_shares SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', [at, this.actor(viewer), shareId]);
    return { ok: true, value: { ...toShare(row), revokedAt: at } };
  }

  /** Enregistre une offre reçue et l'inscrit au registre du bien. */
  async record(viewer: Viewer, propertyId: string, input: OfferInput): Promise<{ ok: true; value: Offer } | Refusal | Problem> {
    const g = await this.gate(viewer, propertyId);
    if (!g.ok) return g;
    const now = this.now();
    const today = localTime(now, TIME_ZONE).date;
    const bad = (field: string): Problem => ({ ok: false, rule: null, code: 'invalid', field });
    const requestKey = input.requestKey ?? null;
    if (requestKey !== null && (typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(requestKey))) return bad('requestKey');
    const known = async (): Promise<Offer | null> => {
      if (requestKey === null) return null;
      const row = await this.db.first<Row>('SELECT * FROM offer_register WHERE property_id = ? AND request_key = ?', [propertyId, requestKey]);
      return row ? toOffer(row) : null;
    };
    // Un rejeu se reconnaît avant les contrôles qui dépendent de l'heure ou de l'état du bien : rejouée plus tard, la même
    // offre est rendue telle qu'enregistrée, au lieu d'être refusée comme une nouvelle.
    const early = await known();
    if (early) {
      const conds = parseConditions(input.conditions);
      const received = typeof input.receivedAt === 'string' && Number.isFinite(Date.parse(input.receivedAt)) ? new Date(input.receivedAt).toISOString() : null;
      const same = conds.ok && received === early.receivedAt && input.amountEur === early.amountEur && JSON.stringify(conds.value) === JSON.stringify(early.conditions) &&
        input.validUntil === early.validUntil && input.downPaymentEur === early.downPaymentEur && input.loanEur === early.loanEur && input.signedRef === early.signedRef;
      const buyerRead = same && typeof input.buyerPersonId === 'string' ? await this.buyerFor(viewer, propertyId, input.buyerPersonId) : null;
      // Les coacquéreurs comparés par leur fiche d'aujourd'hui, comme l'acquéreur en tête : une fiche réunie depuis reste la même personne.
      const coIn = input.coBuyerPersonIds ?? [];
      let sameCo = Array.isArray(coIn) && coIn.length === early.coBuyerPersonIds.length;
      for (const [i, id] of (sameCo ? (coIn as unknown[]) : []).entries()) {
        const read = typeof id === 'string' ? await this.buyerFor(viewer, propertyId, id) : null;
        if (!read?.ok || read.value.person.id !== early.coBuyerPersonIds[i]) sameCo = false;
      }
      if (buyerRead?.ok && buyerRead.value.person.id === early.buyerPersonId && sameCo) return { ok: true, value: early };
      await appendEvent(this.journal, { type: 'offre.cle_reutilisee', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R56', seq: early.seq } }, this.now);
      return { ok: false, rule: 'R56', code: 'request_key_reused' };
    }

    if (typeof input.buyerPersonId !== 'string' || input.buyerPersonId.length > 64) return bad('buyerPersonId');
    const coInput = input.coBuyerPersonIds ?? [];
    if (!Array.isArray(coInput) || coInput.length > MAX_CO_BUYERS) return bad('coBuyerPersonIds');
    for (const [i, id] of coInput.entries()) if (typeof id !== 'string' || id.length === 0 || id.length > 64) return bad(`coBuyerPersonIds.${i}`);
    if (!isInt(input.amountEur, 1, 100_000_000)) return bad('amountEur');
    const conditions = parseConditions(input.conditions);
    if (!conditions.ok) return bad(conditions.field);
    // Une heure complète avec son fuseau : jamais lue selon le fuseau du serveur.
    if (!(typeof input.receivedAt === 'string') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.receivedAt) || !Number.isFinite(Date.parse(input.receivedAt)) || Date.parse(input.receivedAt) > now.getTime()) return bad('receivedAt');
    const receivedAt = new Date(input.receivedAt).toISOString();
    const receivedDay = localTime(new Date(receivedAt), TIME_ZONE).date;
    if (!validDay(input.validUntil) || input.validUntil < receivedDay || input.validUntil > addDays(receivedDay, MAX_VALIDITY_DAYS) || input.validUntil < today) return bad('validUntil');
    if (!isInt(input.downPaymentEur, 0, 100_000_000)) return bad('downPaymentEur');
    if (!isInt(input.loanEur, 0, 100_000_000)) return bad('loanEur');
    if (typeof input.signedRef !== 'string' || !SIGNED_REF.test(input.signedRef)) return bad('signedRef');
    // L'acquéreur : une fiche du réseau, que celui qui enregistre voit en entier, ou partagée pour ce bien (AU081) [R16].
    const buyer = await this.buyerFor(viewer, propertyId, input.buyerPersonId);
    if (!buyer.ok) return buyer;
    // Le mandant du bien, sous aucune de ses fiches, ne se fait une offre à lui-même.
    const members = new Set(buyer.value.members.map((m) => m.id));
    const sellers = await this.db.all<{ person_id: string }>(`SELECT person_id FROM (${LIVE_MANDATES}) WHERE property_id = ?`, [g.networkId, propertyId]);
    if (sellers.some((s) => members.has(s.person_id))) return { ok: false, rule: null, code: 'buyer_is_seller', field: 'buyerPersonId' };
    // Chaque coacquéreur : une fiche vue en entier, ni le mandant, ni une personne déjà dans l'offre sous une autre fiche.
    // Les fiches restent distinctes : rien n'est fusionné, chacun garde son identité et ses droits (AU009).
    const coBuyers: string[] = [];
    const seen = new Set(members);
    for (const [i, id] of (coInput as string[]).entries()) {
      const co = await this.buyerFor(viewer, propertyId, id);
      if (!co.ok) return co;
      const its = co.value.members.map((m) => m.id);
      if (its.some((m) => seen.has(m))) return { ok: false, rule: null, code: 'same_buyer', field: `coBuyerPersonIds.${i}` };
      if (sellers.some((s) => its.includes(s.person_id))) return { ok: false, rule: null, code: 'buyer_is_seller', field: `coBuyerPersonIds.${i}` };
      for (const m of its) seen.add(m);
      coBuyers.push(co.value.person.id);
    }
    // Un bien reçoit des offres seulement s'il est en vente sous mandat (D05) [R42].
    const sale = await this.diffusion.canDiffuse(g.networkId, propertyId, now);
    const status = await this.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [propertyId]);
    // Vendu, loué ou retiré de la vente : plus d'offre, même si le mandat court encore.
    if (!sale.allowed || !status || ['sold', 'rented', 'withdrawn'].includes(status.status)) return { ok: false, rule: 'R42', code: 'not_on_sale' };
    // Une visite faite à distance dont le bon n'est pas signé : refus dit en mots, avant de prendre un rang [R505].
    for (const who of [buyer.value.person.id, ...coBuyers]) {
      const missing = await remoteSlipMissing(this.db, g.networkId, propertyId, who);
      if (missing !== null) return this.slipMissing(viewer, propertyId, missing);
    }

    // Une ancre manquée après une panne du journal est reprise d'abord, pour une ligne intacte seulement.
    await this.resumeAnchors(viewer, propertyId);
    // Un rejeu avec la même clé ne rend l'offre déjà enregistrée que si c'est bien la même offre ; une offre différente
    // envoyée avec une clé déjà prise est refusée et le refus écrit au journal, jamais avalée [R56].
    const sameOffer = (o: Offer): boolean =>
      o.buyerPersonId === buyer.value.person.id && JSON.stringify(o.coBuyerPersonIds) === JSON.stringify(coBuyers) && o.amountEur === input.amountEur && JSON.stringify(o.conditions) === JSON.stringify(conditions.value) &&
      o.validUntil === input.validUntil && o.downPaymentEur === input.downPaymentEur && o.loanEur === input.loanEur && o.signedRef === input.signedRef && o.receivedAt === receivedAt;
    const replay = async (o: Offer): Promise<{ ok: true; value: Offer } | Problem> => {
      if (sameOffer(o)) return { ok: true, value: o };
      await appendEvent(this.journal, { type: 'offre.cle_reutilisee', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R56', seq: o.seq } }, this.now);
      return { ok: false, rule: 'R56', code: 'request_key_reused' };
    };
    const already = await known();
    if (already) return replay(already);
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.db.first<{ seq: number; hash: string }>('SELECT seq, hash FROM offer_register WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
      const line: Omit<Row, 'hash'> = {
        id: this.newId(),
        network_id: g.networkId,
        property_id: propertyId,
        seq: (last ? Number(last.seq) : 0) + 1,
        buyer_person_id: buyer.value.person.id,
        co_buyers: JSON.stringify(coBuyers),
        amount_eur: input.amountEur,
        conditions: JSON.stringify(conditions.value),
        valid_until: input.validUntil,
        down_payment_eur: input.downPaymentEur,
        loan_eur: input.loanEur,
        signed_ref: input.signedRef,
        received_at: receivedAt,
        agent_id: g.agentId,
        at: now.toISOString(),
        actor: this.actor(viewer),
        prev_hash: last ? last.hash : OFFER_GENESIS,
      };
      const hash = await hashOffer(line);
      try {
        // La colonne des coacquéreurs n'est écrite que s'il y en a : une offre d'un acquéreur seul s'inscrit comme avant
        // la migration 3970, aussi sur une base qui ne l'a pas encore.
        // Le lien de chaque coacquéreur à l'offre part dans le même lot : l'un n'existe jamais sans l'autre [R96].
        const co = coBuyers.length > 0;
        const insertOffer = {
          sql: `INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash, request_key${co ? ', co_buyers' : ''})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${co ? ', ?' : ''})`,
          params: [line.id, line.network_id, line.property_id, line.seq, line.buyer_person_id, line.amount_eur, line.conditions, line.valid_until, line.down_payment_eur, line.loan_eur, line.signed_ref, line.received_at, line.agent_id, line.at, line.actor, line.prev_hash, hash, requestKey, ...(co ? [line.co_buyers!] : [])],
        };
        if (!co) await this.db.run(insertOffer.sql, insertOffer.params);
        else {
          await runBatch(this.db, [
            insertOffer,
            ...coBuyers.map((personId, i) => ({ sql: 'INSERT INTO offer_co_buyers (offer_id, network_id, person_id, position) VALUES (?, ?, ?, ?)', params: [line.id, line.network_id, personId, i + 1] })),
          ]);
        }
      } catch (error) {
        // Le même envoi, arrivé en même temps : l'offre enregistrée par l'autre est rendue.
        const twin = await known();
        if (twin) return replay(twin);
        // Un autre enregistrement a pris ce rang : on recommence avec le suivant.
        if (/UNIQUE|ajout seul/i.test(String(error))) continue;
        // Une visite à distance finie entre la lecture et l'écriture : la base a refusé, le refus est dit en mots [R505].
        if (REMOTE_SLIP_TRIGGER.test(String(error))) {
          for (const who of [buyer.value.person.id, ...coBuyers]) {
            const late = await remoteSlipMissing(this.db, g.networkId, propertyId, who);
            if (late !== null) return this.slipMissing(viewer, propertyId, late);
          }
        }
        throw error;
      }
      // L'ancre au journal : le rang et l'empreinte en lettres ; ni montant, ni nom [R13].
      await appendEvent(this.journal, { type: 'offre.enregistree', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R56', seq: line.seq, anchor: offerAnchor(hash) } }, this.now);
      return { ok: true, value: toOffer({ ...line, hash }) };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  /** Les offres d'un bien, dans l'ordre d'arrivée. */
  async list(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: Offer[] } | Refusal | Problem> {
    const g = await this.gate(viewer, propertyId);
    if (!g.ok) return g;
    const rows = await this.db.all<Row>('SELECT * FROM offer_register WHERE property_id = ? ORDER BY seq', [propertyId]);
    return { ok: true, value: rows.map(toOffer) };
  }

  /** Les ancres du journal pour un bien, par rang : un rang peut en porter plusieurs si quelqu'un a triché. */
  private async anchorsOf(propertyId: string): Promise<Map<number, Set<string>>> {
    const anchors = new Map<number, Set<string>>();
    for (const e of await this.journal.bySubject(`property:${propertyId}`)) {
      if (e.type !== 'offre.enregistree') continue;
      const d = e.data as { seq?: number; anchor?: string };
      if (typeof d.seq !== 'number' || typeof d.anchor !== 'string') continue;
      const set = anchors.get(d.seq) ?? new Set<string>();
      set.add(d.anchor);
      anchors.set(d.seq, set);
    }
    return anchors;
  }

  /** Réécrit l'ancre des lignes intactes qui n'en ont aucune (journal en panne juste après l'inscription). */
  private async resumeAnchors(viewer: Viewer, propertyId: string): Promise<void> {
    const rows = await this.db.all<Row>('SELECT * FROM offer_register WHERE property_id = ? ORDER BY seq', [propertyId]);
    const anchors = await this.anchorsOf(propertyId);
    let prev = OFFER_GENESIS;
    for (const [i, row] of rows.entries()) {
      const { hash, ...rest } = row;
      // Au premier écart, on s'arrête : on n'ancre jamais une ligne qui ne suit pas la chaîne.
      if (Number(row.seq) !== i + 1 || row.prev_hash !== prev || (await hashOffer(rest)) !== hash) return;
      const own = anchors.get(i + 1);
      if (own && !own.has(offerAnchor(hash))) return;
      if (!own) await appendEvent(this.journal, { type: 'offre.enregistree', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R56', seq: i + 1, anchor: offerAnchor(hash), resumed: true } }, this.now);
      prev = hash;
    }
  }

  private async checkOnce(propertyId: string): Promise<RegisterCheck> {
    const rows = await this.db.all<Row>('SELECT * FROM offer_register WHERE property_id = ? ORDER BY seq', [propertyId]);
    const anchors = await this.anchorsOf(propertyId);
    let prev = OFFER_GENESIS;
    for (const [i, row] of rows.entries()) {
      const broken = (problem: 'sequence' | 'chain' | 'hash' | 'anchor'): RegisterCheck => ({ ok: false, count: rows.length, brokenAt: i + 1, problem });
      if (Number(row.seq) !== i + 1) return broken('sequence');
      if (row.prev_hash !== prev) return broken('chain');
      const { hash, ...rest } = row;
      if ((await hashOffer(rest)) !== hash) return broken('hash');
      // Une seule ancre par rang, celle de la ligne : deux ancres différentes pour un rang, c'est une ligne remplacée.
      const own = anchors.get(i + 1);
      if (!own || own.size !== 1 || !own.has(offerAnchor(hash))) return broken('anchor');
      prev = hash;
    }
    // Une ancre au-delà de la dernière ligne : une offre retirée du registre.
    const highest = Math.max(0, ...anchors.keys());
    if (highest > rows.length) return { ok: false, count: rows.length, brokenAt: rows.length + 1, problem: 'sequence' };
    return { ok: true, count: rows.length };
  }

  /**
   * Le contrôle du registre d'un bien, sans droits ni donnée personnelle : le nombre d'offres et l'état du registre.
   * C'est ce que le vendeur peut voir : combien d'offres ont été reçues, et qu'aucune n'a été retirée ni changée.
   * Un écart est relu une fois avant d'être rendu : une inscription en cours, entre la ligne et son ancre, n'en est pas un.
   */
  async check(propertyId: string): Promise<RegisterCheck> {
    const first = await this.checkOnce(propertyId);
    return first.ok ? first : this.checkOnce(propertyId);
  }
}
