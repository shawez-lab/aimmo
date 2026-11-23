/**
 * Honoraires du locataire et dépôt de garantie sous le plafond (M15, W02) [R102].
 *
 * Loi du 6 juillet 1989, article 5, et son décret d'application : la part du locataire pour la visite, la constitution
 * du dossier et la rédaction du bail ne dépasse pas un plafond par m² habitable selon la zone ; celle de l'état des
 * lieux d'entrée, un plafond par m². Les plafonds sont révisés : chaque millésime est rangé dans `FEE_SCALES` avec sa
 * date d'effet et sa source, et le plafond appliqué est celui du jour où le barème est jugé (AU095). Depuis le
 * 1er janvier 2026 (arrêté du 13 novembre 2025, NOR VLOL2530987A) : 12,10 €, 10,09 € et 8,07 €, et 3,03 € pour
 * l'état des lieux. Le plafond en centimes est arrondi vers le bas, jamais au-dessus du texte. Chacune ne dépasse jamais la part du bailleur pour
 * les mêmes prestations. Article 22 et 25-6 : le dépôt de garantie d'un logement vide ne dépasse pas un mois de loyer hors charges,
 * celui d'un meublé deux mois.
 *
 * Les montants sont en centimes, calculés par le code, jamais par l'IA. La zone d'une commune est une donnée publique
 * rangée avec sa source et sa date d'effet (`rental_zones`), jamais écrite dans le code ; une commune sans zone connue
 * prend le plafond le plus bas. La commune du logement est fixée une fois pour sa mise en location, contrôlée contre le
 * département du code postal du bien ; le barème n'en reçoit jamais d'autre. Un barème au-delà d'un plafond est refusé à l'enregistrement, et la base le refuse aussi.
 * Chaque barème est une version rangée avec ses plafonds ; la précédente reste [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { rentalMandateGate, rentalMandateInForce, type RentalMandateGate } from './mandat-location.ts';
import { validDay, type LocationRefusal, type LocationResult, type MisesEnLocation } from './logement.ts';

const TIME_ZONE = 'Europe/Paris';

export const RENTAL_ZONES = ['tres_tendue', 'tendue', 'autre'] as const;
export type RentalZone = (typeof RENTAL_ZONES)[number];

/** Un millésime des plafonds, en centimes par m² habitable, avec sa date d'effet (AAAA-MM-JJ) et son texte. */
export interface FeeScale {
  from: string;
  tenantCentsPerM2: Readonly<Record<RentalZone, number>>;
  inventoryCentsPerM2: number;
  source: string;
}

/** Les plafonds successifs, du plus ancien au plus récent ; écrits par la loi, jamais calculés. */
export const FEE_SCALES: readonly FeeScale[] = Object.freeze([
  Object.freeze({
    from: '2014-09-15',
    tenantCentsPerM2: Object.freeze({ tres_tendue: 1200, tendue: 1000, autre: 800 }),
    inventoryCentsPerM2: 300,
    source: 'décret n° 2014-890 du 1er août 2014',
  }),
  Object.freeze({
    from: '2026-01-01',
    tenantCentsPerM2: Object.freeze({ tres_tendue: 1210, tendue: 1009, autre: 807 }),
    inventoryCentsPerM2: 303,
    source: 'arrêté du 13 novembre 2025 modifiant l\'arrêté du 17 juillet 2025, NOR VLOL2530987A',
  }),
]);

/** Le millésime en vigueur un jour donné (AAAA-MM-JJ) : le plus récent dont la date d'effet est passée. */
export function feeScaleOn(day: string): FeeScale {
  let scale = FEE_SCALES[0]!;
  for (const s of FEE_SCALES) if (s.from <= day) scale = s;
  return scale;
}

const INSEE = /^(?:\d{5}|2[AB]\d{3})$/;

export interface FeeCeilings {
  zone: RentalZone | 'inconnue';
  tenantCeilingCents: number;
  inventoryCeilingCents: number;
  depositCeilingCents: number;
}

/**
 * Les plafonds pour une surface habitable (en centièmes de m²), une zone, un loyer hors charges et le jour où le barème
 * est jugé : rejouable, sans écriture. Centimes par m² × centièmes de m² / 100, arrondi vers le bas [R102].
 */
export function feeCeilings(livingAreaHundredths: number, zone: RentalZone | 'inconnue', rentCents: number, furnished: boolean, day: string): FeeCeilings {
  const scale = feeScaleOn(day);
  const rate = scale.tenantCentsPerM2[zone === 'inconnue' ? 'autre' : zone];
  return {
    zone,
    tenantCeilingCents: Math.floor((rate * livingAreaHundredths) / 100),
    inventoryCeilingCents: Math.floor((scale.inventoryCentsPerM2 * livingAreaHundredths) / 100),
    depositCeilingCents: (furnished ? 2 : 1) * rentCents,
  };
}

export interface FeeInput {
  tenantCents: number;
  tenantInventoryCents: number;
  /** La part du bailleur pour visite, dossier et bail. */
  landlordCents: number;
  /** La part du bailleur pour l'état des lieux d'entrée. */
  landlordInventoryCents: number;
  depositCents: number;
}

export type FeeProblem = 'tenant_ceiling' | 'inventory_ceiling' | 'over_landlord' | 'inventory_over_landlord' | 'deposit_ceiling';

/** Les dépassements d'un barème, dans l'ordre de la loi ; une liste vide : le barème est permis [R102]. */
export function feeProblems(input: FeeInput, c: FeeCeilings): FeeProblem[] {
  const out: FeeProblem[] = [];
  if (input.tenantCents > c.tenantCeilingCents) out.push('tenant_ceiling');
  if (input.tenantInventoryCents > c.inventoryCeilingCents) out.push('inventory_ceiling');
  if (input.tenantCents > input.landlordCents) out.push('over_landlord');
  if (input.tenantInventoryCents > input.landlordInventoryCents) out.push('inventory_over_landlord');
  if (input.depositCents > c.depositCeilingCents) out.push('deposit_ceiling');
  return out;
}

export interface RentalFees extends FeeInput, FeeCeilings {
  listingId: string;
  version: number;
  factsVersion: number;
  inseeCode: string;
}

const FEE_KEYS: readonly (keyof FeeInput)[] = ['tenantCents', 'tenantInventoryCents', 'landlordCents', 'landlordInventoryCents', 'depositCents'];
const cents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000;

export interface HonorairesOptions {
  now?: () => Date;
  /** AU014 : la porte du mandat de location ; par défaut, celle de la diffusion, sur la même base. */
  rentalMandate?: RentalMandateGate;
}

export class HonorairesLocation {
  private readonly now: () => Date;
  private readonly gate: RentalMandateGate;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly journal: JournalStore,
    options: HonorairesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.gate = options.rentalMandate ?? rentalMandateGate(db, journal, this.now);
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

  /** Les zones rangées d'une commune, la date d'effet la plus récente d'abord (X21) : direction seule [R16]. */
  async zonesOf(viewer: Viewer, inseeCode: unknown): Promise<LocationResult<{ zone: string; effectiveFrom: string; source: string }[]>> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: 'rental_zones', data: { rule: 'R16', role: String(viewer.role) } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof inseeCode !== 'string' || !INSEE.test(inseeCode)) return { ok: false, rule: null, code: 'bad_insee' };
    const rows = await this.db.all<{ zone: string; effective_from: string; source: string }>('SELECT zone, effective_from, source FROM rental_zones WHERE insee_code = ? ORDER BY effective_from DESC', [inseeCode]);
    return { ok: true, value: rows.map((r) => ({ zone: r.zone, effectiveFrom: r.effective_from, source: r.source })) };
  }

  /** La zone d'une commune à une date : la dernière rangée dont l'effet a commencé ; `inconnue` sinon. */
  async zoneOn(inseeCode: string, day: string): Promise<RentalZone | 'inconnue'> {
    const r = await this.db.first<{ zone: RentalZone }>('SELECT zone FROM rental_zones WHERE insee_code = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1', [inseeCode, day]);
    return r?.zone ?? 'inconnue';
  }

  /**
   * Fixe la commune du logement, une seule fois : son département doit être celui du code postal du bien (20 pour la
   * Corse, 2A ou 2B) [R102].
   */
  async setCommune(viewer: Viewer, listingId: unknown, inseeCode: unknown): Promise<LocationResult<{ inseeCode: string }>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    if (typeof inseeCode !== 'string' || !INSEE.test(inseeCode)) return { ok: false, rule: null, code: 'bad_insee' };
    const p = await this.db.first<{ postal_code: string | null }>('SELECT postal_code FROM properties WHERE id = ?', [listing.propertyId]);
    const dept = (code: string) => (/^2[AB]/.test(code) ? '20' : code.slice(0, 2));
    if (!p?.postal_code || !/^\d{5}$/.test(p.postal_code) || dept(p.postal_code) !== dept(inseeCode)) return { ok: false, rule: 'R102', code: 'commune_mismatch' };
    try {
      await this.db.run('INSERT INTO rental_listing_communes (listing_id, insee_code, recorded_by, recorded_at) VALUES (?, ?, ?, ?)', [listing.id, inseeCode, this.actor(viewer), this.now().toISOString()]);
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: 'R102', code: 'commune_set' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'location.commune', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { inseeCode } }, this.now);
    return { ok: true, value: { inseeCode } };
  }

  private async communeOf(listingId: string): Promise<string | null> {
    return (await this.db.first<{ insee_code: string }>('SELECT insee_code FROM rental_listing_communes WHERE listing_id = ?', [listingId]))?.insee_code ?? null;
  }

  /** Les plafonds de cette mise en location, sur ses derniers faits et la zone de sa commune au début du bail. */
  async ceilings(viewer: Viewer, listingId: unknown): Promise<LocationResult<FeeCeilings & { factsVersion: number; inseeCode: string }>> {
    const listing = await this.listings.listing(viewer, listingId, false);
    if ('ok' in listing) return listing;
    // La lecture est écrite au journal avant que la donnée soit rendue [R16, R13].
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R16', what: 'ceilings' } }, this.now);
    return this.compute(listing.id);
  }

  private async compute(listingId: string): Promise<LocationResult<FeeCeilings & { factsVersion: number; inseeCode: string }>> {
    const listing = { id: listingId };
    const inseeCode = await this.communeOf(listing.id);
    if (!inseeCode) return { ok: false, rule: null, code: 'no_commune' };
    const facts = await this.listings.currentFacts(listing.id);
    if (!facts) return { ok: false, rule: null, code: 'no_facts' };
    const day = this.judgedOn(facts.leaseStart);
    const zone = await this.zoneOn(inseeCode, day);
    return { ok: true, value: { ...feeCeilings(facts.livingAreaHundredths, zone, facts.rentCents, facts.furnished, day), factsVersion: facts.version, inseeCode } };
  }

  /** La zone est lue au plus tard du début du bail et du jour : jamais une zone d'avant pour un bail d'aujourd'hui. */
  private judgedOn(leaseStart: string): string {
    const today = localTime(this.now(), TIME_ZONE).date;
    return leaseStart > today ? leaseStart : today;
  }

  /** Range le barème, refusé au-delà d'un plafond, avec la raison [R102]. */
  async record(viewer: Viewer, listingId: unknown, input: Record<keyof FeeInput, unknown>): Promise<LocationResult<RentalFees>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    for (const k of Object.keys(input)) if (!FEE_KEYS.includes(k as keyof FeeInput)) return { ok: false, rule: null, code: 'invalid', field: k };
    for (const k of FEE_KEYS) {
      if (!cents(input[k])) return { ok: false, rule: null, code: 'invalid', field: k };
    }
    // AU014 : un barème d'honoraires ne se range que sous un mandat de location en cours [R42, R100].
    if (!(await rentalMandateInForce(this.gate, listing.networkId, listing.propertyId, this.now()))) {
      await appendEvent(this.journal, { type: 'location.bareme_refuse', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R100', problems: ['no_rental_mandate'] } }, this.now);
      return { ok: false, rule: 'R100', code: 'no_rental_mandate' } as LocationRefusal;
    }
    const c = await this.compute(listing.id);
    if (!c.ok) return c;
    const fees: FeeInput = {
      tenantCents: input.tenantCents as number,
      tenantInventoryCents: input.tenantInventoryCents as number,
      landlordCents: input.landlordCents as number,
      landlordInventoryCents: input.landlordInventoryCents as number,
      depositCents: input.depositCents as number,
    };
    const problems = feeProblems(fees, c.value);
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'location.bareme_refuse', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R102', problems } }, this.now);
      return { ok: false, rule: 'R102', code: problems[0]! } satisfies LocationRefusal;
    }
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM rental_fees WHERE listing_id = ?', [listing.id]);
    const version = Number(last?.v ?? 0) + 1;
    try {
      await this.db.run(
        `INSERT INTO rental_fees (listing_id, version, facts_version, insee_code, zone, tenant_cents, tenant_inventory_cents, landlord_cents, landlord_inventory_cents, deposit_cents, tenant_ceiling_cents, inventory_ceiling_cents, deposit_ceiling_cents, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          listing.id,
          version,
          c.value.factsVersion,
          c.value.inseeCode,
          c.value.zone,
          fees.tenantCents,
          fees.tenantInventoryCents,
          fees.landlordCents,
          fees.landlordInventoryCents,
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
    const { factsVersion, inseeCode, ...ceil } = c.value;
    return { ok: true, value: { listingId: listing.id, version, factsVersion, inseeCode, ...fees, ...ceil } };
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
      landlord_inventory_cents: number;
      deposit_cents: number;
    }>(
      `SELECT f.version, f.facts_version, f.insee_code, f.tenant_cents, f.tenant_inventory_cents, f.landlord_cents, f.landlord_inventory_cents, f.deposit_cents
       FROM rental_fees f JOIN rental_listings l ON l.id = f.listing_id WHERE f.listing_id = ? AND l.network_id = ? ORDER BY f.version DESC LIMIT 1`,
      [listingId, networkId],
    );
    if (!r) return null;
    const facts = await this.listings.currentFacts(listingId);
    if (!facts || facts.version !== Number(r.facts_version)) return null;
    const day = this.judgedOn(facts.leaseStart);
    const zone = await this.zoneOn(r.insee_code, day);
    const c = feeCeilings(facts.livingAreaHundredths, zone, facts.rentCents, facts.furnished, day);
    const fees: FeeInput = {
      tenantCents: Number(r.tenant_cents),
      tenantInventoryCents: Number(r.tenant_inventory_cents),
      landlordCents: Number(r.landlord_cents),
      landlordInventoryCents: Number(r.landlord_inventory_cents),
      depositCents: Number(r.deposit_cents),
    };
    if (feeProblems(fees, c).length > 0) return null;
    return { listingId, version: Number(r.version), factsVersion: Number(r.facts_version), inseeCode: r.insee_code, ...fees, ...c };
  }
}
