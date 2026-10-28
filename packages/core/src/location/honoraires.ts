/**
 * Honoraires du locataire et dépôt de garantie sous le plafond (M15, W02) [R102].
 *
 * Loi du 6 juillet 1989, article 5, et son décret d'application : la part du locataire pour la visite, la constitution
 * du dossier et la rédaction du bail ne dépasse pas 12 € par m² habitable en zone très tendue, 10 € en zone tendue et
 * 8 € ailleurs ; celle de l'état des lieux d'entrée, 3 € par m². Le total du locataire ne dépasse jamais la part du
 * bailleur. Article 22 et 25-6 : le dépôt de garantie d'un logement vide ne dépasse pas un mois de loyer hors charges,
 * celui d'un meublé deux mois.
 *
 * Les montants sont en centimes, calculés par le code, jamais par l'IA. La zone d'une commune est une donnée publique
 * rangée avec sa source et sa date d'effet (`rental_zones`), jamais écrite dans le code ; une commune sans zone connue
 * prend le plafond le plus bas. Un barème au-delà d'un plafond est refusé à l'enregistrement, et la base le refuse aussi.
 * Chaque barème est une version rangée avec ses plafonds ; la précédente reste [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { validDay, type LocationRefusal, type LocationResult, type MisesEnLocation } from './logement.ts';

const TIME_ZONE = 'Europe/Paris';

export const RENTAL_ZONES = ['tres_tendue', 'tendue', 'autre'] as const;
export type RentalZone = (typeof RENTAL_ZONES)[number];

/** Plafond de la part du locataire (visite, dossier, bail), en euros par m² habitable. Réglage, écrit par la loi. */
export const TENANT_CEILING_EUR_PER_M2: Readonly<Record<RentalZone, number>> = Object.freeze({ tres_tendue: 12, tendue: 10, autre: 8 });
/** Plafond de la part du locataire pour l'état des lieux d'entrée, en euros par m² habitable. */
export const INVENTORY_CEILING_EUR_PER_M2 = 3;

const INSEE = /^(?:\d{5}|2[AB]\d{3})$/;

export interface FeeCeilings {
  zone: RentalZone | 'inconnue';
  tenantCeilingCents: number;
  inventoryCeilingCents: number;
  depositCeilingCents: number;
}

/**
 * Les plafonds pour une surface habitable (en centièmes de m²), une zone et un loyer hors charges : rejouable, sans
 * écriture. Euros par m² × centièmes de m² = centimes, sans arrondi [R102].
 */
export function feeCeilings(livingAreaHundredths: number, zone: RentalZone | 'inconnue', rentCents: number, furnished: boolean): FeeCeilings {
  const rate = TENANT_CEILING_EUR_PER_M2[zone === 'inconnue' ? 'autre' : zone];
  return {
    zone,
    tenantCeilingCents: rate * livingAreaHundredths,
    inventoryCeilingCents: INVENTORY_CEILING_EUR_PER_M2 * livingAreaHundredths,
    depositCeilingCents: (furnished ? 2 : 1) * rentCents,
  };
}

export interface FeeInput {
  tenantCents: number;
  tenantInventoryCents: number;
  landlordCents: number;
  depositCents: number;
}

export type FeeProblem = 'tenant_ceiling' | 'inventory_ceiling' | 'over_landlord' | 'deposit_ceiling';

/** Les dépassements d'un barème, dans l'ordre de la loi ; une liste vide : le barème est permis [R102]. */
export function feeProblems(input: FeeInput, c: FeeCeilings): FeeProblem[] {
  const out: FeeProblem[] = [];
  if (input.tenantCents > c.tenantCeilingCents) out.push('tenant_ceiling');
  if (input.tenantInventoryCents > c.inventoryCeilingCents) out.push('inventory_ceiling');
  if (input.tenantCents + input.tenantInventoryCents > input.landlordCents) out.push('over_landlord');
  if (input.depositCents > c.depositCeilingCents) out.push('deposit_ceiling');
  return out;
}

export interface RentalFees extends FeeInput, FeeCeilings {
  listingId: string;
  version: number;
  factsVersion: number;
  inseeCode: string;
}

const cents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000;

export interface HonorairesOptions {
  now?: () => Date;
}

export class HonorairesLocation {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly journal: JournalStore,
    options: HonorairesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /**
   * Range la zone d'une commune, avec sa source et sa date d'effet ; la direction seule. Une zone rangée ne change
   * plus : une nouvelle date d'effet s'ajoute [R17].
   */
  async recordZone(viewer: Viewer, input: { inseeCode: unknown; zone: unknown; effectiveFrom: unknown; source: unknown }): Promise<LocationResult<true>> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: 'rental_zones', data: { rule: 'R16', role: String(viewer.role), kind: 'rental_zone', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof input.inseeCode !== 'string' || !INSEE.test(input.inseeCode)) return { ok: false, rule: null, code: 'bad_insee' };
    if (typeof input.zone !== 'string' || !(RENTAL_ZONES as readonly string[]).includes(input.zone)) return { ok: false, rule: null, code: 'bad_zone' };
    if (!validDay(input.effectiveFrom)) return { ok: false, rule: null, code: 'bad_date' };
    if (typeof input.source !== 'string' || input.source.trim().length < 3 || input.source.length > 200) return { ok: false, rule: null, code: 'bad_source' };
    try {
      await this.db.run('INSERT INTO rental_zones (insee_code, zone, effective_from, source, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)', [
        input.inseeCode,
        input.zone,
        input.effectiveFrom,
        input.source.trim(),
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'already_recorded' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'location.zone', actor: this.actor(viewer), subject: `commune:${input.inseeCode}`, data: { zone: input.zone, effectiveFrom: input.effectiveFrom } }, this.now);
    return { ok: true, value: true };
  }

  /** La zone d'une commune à une date : la dernière rangée dont l'effet a commencé ; `inconnue` sinon. */
  async zoneOn(inseeCode: string, day: string): Promise<RentalZone | 'inconnue'> {
    const r = await this.db.first<{ zone: RentalZone }>('SELECT zone FROM rental_zones WHERE insee_code = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1', [inseeCode, day]);
    return r?.zone ?? 'inconnue';
  }

  /** Les plafonds de cette mise en location, sur ses derniers faits et la zone de la commune au début du bail. */
  async ceilings(viewer: Viewer, listingId: unknown, inseeCode: unknown): Promise<LocationResult<FeeCeilings & { factsVersion: number }>> {
    const listing = await this.listings.listing(viewer, listingId, false);
    if ('ok' in listing) return listing;
    if (typeof inseeCode !== 'string' || !INSEE.test(inseeCode)) return { ok: false, rule: null, code: 'bad_insee' };
    const facts = await this.listings.currentFacts(listing.id);
    if (!facts) return { ok: false, rule: null, code: 'no_facts' };
    const zone = await this.zoneOn(inseeCode, this.judgedOn(facts.leaseStart));
    return { ok: true, value: { ...feeCeilings(facts.livingAreaHundredths, zone, facts.rentCents, facts.furnished), factsVersion: facts.version } };
  }

  /** La zone est lue au plus tard du début du bail et du jour : jamais une zone d'avant pour un bail d'aujourd'hui. */
  private judgedOn(leaseStart: string): string {
    const today = localTime(this.now(), TIME_ZONE).date;
    return leaseStart > today ? leaseStart : today;
  }

  /** Range le barème, refusé au-delà d'un plafond, avec la raison [R102]. */
  async record(viewer: Viewer, listingId: unknown, input: { inseeCode: unknown } & Record<keyof FeeInput, unknown>): Promise<LocationResult<RentalFees>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    for (const k of ['tenantCents', 'tenantInventoryCents', 'landlordCents', 'depositCents'] as const) {
      if (!cents(input[k])) return { ok: false, rule: null, code: 'invalid', field: k };
    }
    const c = await this.ceilings(viewer, listing.id, input.inseeCode);
    if (!c.ok) return c;
    const fees: FeeInput = { tenantCents: input.tenantCents as number, tenantInventoryCents: input.tenantInventoryCents as number, landlordCents: input.landlordCents as number, depositCents: input.depositCents as number };
    const problems = feeProblems(fees, c.value);
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'location.bareme_refuse', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R102', problems } }, this.now);
      return { ok: false, rule: 'R102', code: problems[0]! } satisfies LocationRefusal;
    }
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM rental_fees WHERE listing_id = ?', [listing.id]);
    const version = Number(last?.v ?? 0) + 1;
    try {
      await this.db.run(
        `INSERT INTO rental_fees (listing_id, version, facts_version, insee_code, zone, tenant_cents, tenant_inventory_cents, landlord_cents, deposit_cents, tenant_ceiling_cents, inventory_ceiling_cents, deposit_ceiling_cents, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          listing.id,
          version,
          c.value.factsVersion,
          input.inseeCode as string,
          c.value.zone,
          fees.tenantCents,
          fees.tenantInventoryCents,
          fees.landlordCents,
          fees.depositCents,
          c.value.tenantCeilingCents,
          c.value.inventoryCeilingCents,
          c.value.depositCeilingCents,
          this.actor(viewer),
          this.now().toISOString(),
        ],
      );
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'location.bareme', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R102', version, zone: c.value.zone } }, this.now);
    const { factsVersion, ...ceil } = c.value;
    return { ok: true, value: { listingId: listing.id, version, factsVersion, inseeCode: input.inseeCode as string, ...fees, ...ceil } };
  }

  /**
   * Le barème en vigueur, s'il vaut encore pour les derniers faits (une surface, un loyer ou un meublé changés le
   * rendent caduc) et sous les plafonds d'aujourd'hui ; `null` sinon. Pour W03 et W06 [R102].
   */
  async current(networkId: string, listingId: string): Promise<RentalFees | null> {
    const r = await this.db.first<{
      version: number;
      facts_version: number;
      insee_code: string;
      tenant_cents: number;
      tenant_inventory_cents: number;
      landlord_cents: number;
      deposit_cents: number;
    }>(
      `SELECT f.version, f.facts_version, f.insee_code, f.tenant_cents, f.tenant_inventory_cents, f.landlord_cents, f.deposit_cents
       FROM rental_fees f JOIN rental_listings l ON l.id = f.listing_id WHERE f.listing_id = ? AND l.network_id = ? ORDER BY f.version DESC LIMIT 1`,
      [listingId, networkId],
    );
    if (!r) return null;
    const facts = await this.listings.currentFacts(listingId);
    if (!facts || facts.version !== Number(r.facts_version)) return null;
    const zone = await this.zoneOn(r.insee_code, this.judgedOn(facts.leaseStart));
    const c = feeCeilings(facts.livingAreaHundredths, zone, facts.rentCents, facts.furnished);
    const fees: FeeInput = { tenantCents: Number(r.tenant_cents), tenantInventoryCents: Number(r.tenant_inventory_cents), landlordCents: Number(r.landlord_cents), depositCents: Number(r.deposit_cents) };
    if (feeProblems(fees, c).length > 0) return null;
    return { listingId, version: Number(r.version), factsVersion: Number(r.facts_version), inseeCode: r.insee_code, ...fees, ...c };
  }
}
