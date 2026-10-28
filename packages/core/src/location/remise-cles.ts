/**
 * Remise des clés, sans argent pour AIMMO ; gestion locative par un partenaire carte G (M15, W08) [R107, R74, R73].
 *
 * AIMMO ne reçoit jamais ni loyer, ni dépôt de garantie, ni aucun fonds du locataire ou du propriétaire : la remise des
 * clés déclare seulement que le dépôt de garantie et le premier loyer sont versés directement au propriétaire, et la
 * base refuse toute autre valeur. Aucun compte bancaire n'est proposé au locataire : le récapitulatif remis aux parties
 * ne porte aucune coordonnée bancaire ni demande de payer, contrôlé par le contrôle des textes [R62, R107].
 *
 * La remise des clés suit le bail signé (W12) et l'état des lieux clos (W07). Les honoraires de location ne sont dus
 * qu'une fois le bail en vigueur signé ; leur montant vient du barème contrôlé de W02 [R102].
 *
 * La gestion locative n'est jamais faite par AIMMO : elle est confiée par la mise en relation de M18, avec l'accord du
 * propriétaire rangé, à un partenaire gestionnaire dont la carte G est valide ce jour [R74, R73].
 *
 * Décidé, lecture prudente : les honoraires de l'agence sont sa rémunération, pas des fonds tenus pour autrui ; ils
 * restent facturés par M13 (K02), jamais encaissés par cette tâche. La remise des clés ne se date pas dans l'avenir.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { bankDetailsIn, fundsInOutgoing } from '../envoi/texte.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Annuaire } from '../partenaires/annuaire.ts';
import type { MiseEnRelation } from '../partenaires/mise-en-relation.ts';
import { euros } from './annonce-location.ts';
import type { BauxLocation } from './bail.ts';
import type { EtatsDesLieux } from './etat-des-lieux.ts';
import type { HonorairesLocation } from './honoraires.ts';
import { dayInFrench, type LocationRefusal, type MisesEnLocation } from './logement.ts';

/** La signature du bail en vigueur, rendue par la signature en ligne du bail (W12). */
export interface LeaseSignatureState {
  /** La date et l'heure où le bail a été signé par les deux parties, ou rien. */
  signedAt(networkId: string, leaseId: string): Promise<string | null>;
}

export interface Handover {
  handoverId: string;
  listingId: string;
  handedOn: string;
  depositPaidTo: 'proprietaire';
  firstRentPaidTo: 'proprietaire';
  depositCents: number;
  firstRentCents: number;
  text: string;
  textSha256: string;
}

export interface FeesDue {
  due: boolean;
  dueSince: string | null;
  tenantCents: number;
  landlordCents: number;
}

export type HandoverRefusal = Omit<LocationRefusal, 'rule'> & { rule: LocationRefusal['rule'] | 'R62' | 'R73' | 'R74' | 'R106' | 'R107' };
export type HandoverResult<T> = { ok: true; value: T } | HandoverRefusal;

export interface RemiseClesOptions {
  now?: () => Date;
  newId?: () => string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class RemisesDesCles {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly fees: HonorairesLocation,
    private readonly leases: BauxLocation,
    private readonly inventories: EtatsDesLieux,
    private readonly signatures: LeaseSignatureState,
    private readonly relations: MiseEnRelation,
    private readonly annuaire: Annuaire,
    private readonly journal: JournalStore,
    options: RemiseClesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Le bail en vigueur et la date de sa signature, s'il est signé. */
  private async signedLease(networkId: string, listingId: string): Promise<{ leaseId: string; signedAt: string } | null> {
    const lease = await this.leases.current(networkId, listingId);
    if (!lease || !lease.complete) return null;
    const signedAt = await this.signatures.signedAt(networkId, lease.leaseId);
    return signedAt ? { leaseId: lease.leaseId, signedAt } : null;
  }

  /**
   * La remise des clés : après le bail signé et l'état des lieux clos ; le dépôt de garantie et le premier loyer sont
   * déclarés versés directement au propriétaire, jamais à AIMMO [R107, R106].
   */
  async handOver(viewer: Viewer, listingId: unknown, input: { handedOn?: unknown }): Promise<HandoverResult<Handover>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    const today = localTime(this.now(), 'Europe/Paris').date;
    if (typeof input.handedOn !== 'string' || !DAY.test(input.handedOn) || Number.isNaN(Date.parse(`${input.handedOn}T00:00:00Z`)) || input.handedOn > today) {
      return { ok: false, rule: null, code: 'bad_date' };
    }
    const lease = await this.signedLease(listing.networkId, listing.id);
    if (!lease) return { ok: false, rule: 'R107', code: 'lease_not_signed' };
    const inventory = await this.inventories.closedInventory(listing.networkId, listing.id);
    if (!inventory) return { ok: false, rule: 'R106', code: 'inventory_not_closed' };
    // L'état des lieux clos doit être celui du bail signé en vigueur : sous un autre bail, il ne vaut pas [R106].
    if (inventory.leaseId !== lease.leaseId) return { ok: false, rule: 'R106', code: 'inventory_other_lease' };
    const fees = await this.fees.current(listing.networkId, listing.id);
    const facts = await this.listings.currentFacts(listing.id);
    if (!fees || !facts) return { ok: false, rule: 'R102', code: 'no_fees' };
    const network = await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [listing.networkId]);
    const name = network?.name ?? 'le réseau';
    const firstRent = facts.rentCents + facts.chargesCents;
    // Le récapitulatif est écrit par le code, depuis les données ; il ne porte ni coordonnée bancaire ni demande de payer.
    const text = [
      `Remise des clés le ${dayInFrench(input.handedOn)}.`,
      `Le dépôt de garantie, ${euros(fees.depositCents)} €, et le premier loyer, ${euros(firstRent)} € charges comprises, sont réglés directement au propriétaire.`,
      `${name} et l’agent immobilier ne reçoivent ni loyer, ni dépôt de garantie, ni aucune somme pour le compte du locataire ou du propriétaire.`,
      'L’état des lieux d’entrée signé par les deux parties est joint à ce récapitulatif.',
    ].join('\n');
    if (fundsInOutgoing(text) || bankDetailsIn(text)) return { ok: false, rule: 'R62', code: 'funds_in_text' };
    const textSha = await sha256(text);
    const id = this.newId();
    const { changes } = await this.db.run(
      `INSERT INTO rental_handovers (id, listing_id, network_id, lease_id, inventory_id, handed_on, deposit_payee, first_rent_payee, deposit_cents, first_rent_cents, text, text_sha256, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, 'proprietaire', 'proprietaire', ?, ?, ?, ?, ?, ?) ON CONFLICT (listing_id) DO NOTHING`,
      [id, listing.id, listing.networkId, lease.leaseId, inventory.inventoryId, input.handedOn, fees.depositCents, firstRent, text, textSha, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_handed_over' };
    await appendEvent(this.journal, { type: 'location.remise_des_cles', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R107', paidTo: 'proprietaire' } }, this.now);
    return {
      ok: true,
      value: { handoverId: id, listingId: listing.id, handedOn: input.handedOn, depositPaidTo: 'proprietaire', firstRentPaidTo: 'proprietaire', depositCents: fees.depositCents, firstRentCents: firstRent, text, textSha256: textSha },
    };
  }

  /** Les honoraires de location : dus seulement une fois le bail en vigueur signé, au montant du barème contrôlé [R102]. */
  async feesDue(viewer: Viewer, listingId: unknown): Promise<HandoverResult<FeesDue>> {
    const listing = await this.listings.listing(viewer, listingId, false);
    if ('ok' in listing) return listing;
    const fees = await this.fees.current(listing.networkId, listing.id);
    if (!fees) return { ok: false, rule: 'R102', code: 'no_fees' };
    const lease = await this.signedLease(listing.networkId, listing.id);
    return {
      ok: true,
      value: {
        due: lease !== null,
        dueSince: lease?.signedAt ?? null,
        tenantCents: fees.tenantCents + fees.tenantInventoryCents,
        landlordCents: fees.landlordCents + fees.landlordInventoryCents,
      },
    };
  }

  /**
   * Lie la gestion locative à une mise en relation de M18 : un gestionnaire, pour le projet du propriétaire et ce
   * logement, confiée après l'accord du propriétaire, à un partenaire dont la carte G est valide ce jour [R74, R73].
   */
  async linkManagement(viewer: Viewer, listingId: unknown, referralId: unknown): Promise<HandoverResult<{ partnerId: string }>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    const referral = await this.relations.get(viewer, referralId);
    if (!referral.ok) return { ok: false, rule: referral.rule === 'R16' ? 'R16' : null, code: referral.code };
    if (referral.value.trade !== 'gestionnaire') return { ok: false, rule: 'R73', code: 'not_manager' };
    const project = await this.db.first<{ person_id: string }>('SELECT person_id FROM projects WHERE id = ? AND network_id = ?', [referral.value.projectId, listing.networkId]);
    if (project?.person_id !== listing.ownerPersonId || referral.value.propertyId !== listing.propertyId) return { ok: false, rule: null, code: 'other_listing' };
    // Confiée : l'accord du propriétaire est rangé avec sa date et sa preuve, puis l'étape « confiée » [R74].
    const entrusted = await this.relations.entrusted(listing.networkId, referral.value.referralId);
    if (!entrusted || entrusted.state === 'abandonnee') return { ok: false, rule: 'R74', code: 'not_entrusted' };
    // La carte G et l'assurance du gestionnaire, valides ce jour [R73].
    if (!(await this.annuaire.proposableOn(listing.networkId, entrusted.partnerId, this.now()))) return { ok: false, rule: 'R73', code: 'partner_unavailable' };
    const { changes } = await this.db.run(
      'INSERT INTO rental_management_links (id, listing_id, network_id, referral_id, partner_id, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (referral_id) DO NOTHING',
      [this.newId(), listing.id, listing.networkId, referral.value.referralId, entrusted.partnerId, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_linked' };
    await appendEvent(this.journal, { type: 'location.gestion_confiee', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R74', referral: `referral:${referral.value.referralId}`, partner: `partner:${entrusted.partnerId}` } }, this.now);
    return { ok: true, value: { partnerId: entrusted.partnerId } };
  }
}
