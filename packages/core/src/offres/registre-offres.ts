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
 * l'acquéreur doit être une fiche que celui qui enregistre voit en entier (une offre d'un client d'un autre agent passe
 * par la direction, en attendant les règles entre agents de M14) ; la durée de validité va de 1 à 60 jours ; le
 * financement déclaré ne sert qu'à vérifier la cohérence des montants (O02), jamais à noter l'acquéreur [R14].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { Diffusion } from '../documents/retractation.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
export const OFFER_GENESIS = '0'.repeat(64);
export const MAX_VALIDITY_DAYS = 60;

/** `autre` : une autre condition, sans texte libre ; son contenu est dans l'offre signée rangée par sa référence. */
export const CONDITION_KINDS = ['pret', 'vente_autre_bien', 'permis_construire', 'certificat_urbanisme', 'autre'] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export type OfferCondition =
  | { kind: 'pret'; amountEur: number; durationMonths: number }
  | { kind: 'vente_autre_bien' }
  | { kind: 'permis_construire' }
  | { kind: 'certificat_urbanisme' }
  | { kind: 'autre' };

export interface OfferInput {
  buyerPersonId: unknown;
  amountEur: unknown;
  conditions: unknown;
  validUntil: unknown;
  downPaymentEur: unknown;
  loanEur: unknown;
  signedRef: unknown;
  receivedAt: unknown;
}

export interface Offer {
  id: string;
  propertyId: string;
  seq: number;
  buyerPersonId: string;
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

/** L'empreinte d'une offre : tout ce qu'elle porte, dans un ordre fixe, et l'empreinte de la précédente. */
export async function hashOffer(r: Omit<Row, 'hash'>): Promise<string> {
  const fields = [
    r.id, r.network_id, r.property_id, Number(r.seq), r.buyer_person_id, Number(r.amount_eur), r.conditions, r.valid_until,
    Number(r.down_payment_eur), Number(r.loan_eur), r.signed_ref, r.received_at, r.agent_id, r.at, r.actor, r.prev_hash,
  ];
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

/** Contrôle les conditions suspensives : liste fermée, une fois chacune, le prêt avec son montant et sa durée. */
export function parseConditions(v: unknown): { ok: true; value: OfferCondition[] } | { ok: false; field: string } {
  if (!Array.isArray(v) || v.length > CONDITION_KINDS.length) return { ok: false, field: 'conditions' };
  const out: OfferCondition[] = [];
  const seen = new Set<string>();
  for (const [i, c] of v.entries()) {
    if (!isRecord(c) || !(CONDITION_KINDS as readonly unknown[]).includes(c.kind) || seen.has(String(c.kind))) return { ok: false, field: `conditions.${i}` };
    seen.add(String(c.kind));
    if (c.kind === 'pret') {
      if (Object.keys(c).some((k) => !['kind', 'amountEur', 'durationMonths'].includes(k))) return { ok: false, field: `conditions.${i}` };
      if (!isInt(c.amountEur, 1, 100_000_000)) return { ok: false, field: `conditions.${i}.amountEur` };
      if (!isInt(c.durationMonths, 1, 480)) return { ok: false, field: `conditions.${i}.durationMonths` };
      out.push({ kind: 'pret', amountEur: c.amountEur, durationMonths: c.durationMonths });
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
type Problem =
  | { ok: false; rule: null; code: 'invalid'; field: string }
  | { ok: false; rule: null; code: 'unknown_property' | 'unknown_buyer' | 'busy' }
  | { ok: false; rule: 'R42'; code: 'not_on_sale' };

const toOffer = (r: Row): Offer => ({
  id: r.id,
  propertyId: r.property_id,
  seq: Number(r.seq),
  buyerPersonId: r.buyer_person_id,
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

  /** Enregistre une offre reçue et l'inscrit au registre du bien. */
  async record(viewer: Viewer, propertyId: string, input: OfferInput): Promise<{ ok: true; value: Offer } | Refusal | Problem> {
    const g = await this.gate(viewer, propertyId);
    if (!g.ok) return g;
    const now = this.now();
    const today = localTime(now, TIME_ZONE).date;
    const bad = (field: string): Problem => ({ ok: false, rule: null, code: 'invalid', field });
    if (typeof input.buyerPersonId !== 'string' || input.buyerPersonId.length > 64) return bad('buyerPersonId');
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
    // L'acquéreur : une fiche du réseau, que celui qui enregistre voit en entier [R16].
    const buyer = await this.acces.readFiche(viewer, input.buyerPersonId);
    if (!buyer.ok) return buyer.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_buyer' } : (buyer as Refusal);
    if (buyer.view !== 'full') return this.refuse(viewer, `person:${input.buyerPersonId}`, 'not_assigned');
    // Un bien reçoit des offres seulement s'il est en vente sous mandat (D05) [R42].
    const sale = await this.diffusion.canDiffuse(g.networkId, propertyId, now);
    const status = await this.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [propertyId]);
    // Vendu, loué ou retiré de la vente : plus d'offre, même si le mandat court encore.
    if (!sale.allowed || !status || ['sold', 'rented', 'withdrawn'].includes(status.status)) return { ok: false, rule: 'R42', code: 'not_on_sale' };

    // Une ancre manquée après une panne du journal est reprise d'abord, pour une ligne intacte seulement.
    await this.resumeAnchors(viewer, propertyId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.db.first<{ seq: number; hash: string }>('SELECT seq, hash FROM offer_register WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
      const line: Omit<Row, 'hash'> = {
        id: this.newId(),
        network_id: g.networkId,
        property_id: propertyId,
        seq: (last ? Number(last.seq) : 0) + 1,
        buyer_person_id: buyer.value.person.id,
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
        await this.db.run(
          `INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [line.id, line.network_id, line.property_id, line.seq, line.buyer_person_id, line.amount_eur, line.conditions, line.valid_until, line.down_payment_eur, line.loan_eur, line.signed_ref, line.received_at, line.agent_id, line.at, line.actor, line.prev_hash, hash],
        );
      } catch (error) {
        // Un autre enregistrement a pris ce rang : on recommence avec le suivant.
        if (/UNIQUE|ajout seul/i.test(String(error))) continue;
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
