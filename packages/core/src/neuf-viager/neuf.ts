/**
 * Les programmes neufs (HX48, M16, M18) : la grille des lots d'un promoteur partenaire, tenue à jour par l'agent du
 * programme, et les frais réduits du neuf calculés par le code.
 *
 * - Chaque lot change par versions qui s'ajoutent ; un lot vendu ne revient jamais, gardé par le code et la base ; la
 *   grille publiée ne montre que les lots disponibles dont la disponibilité a été confirmée depuis 14 jours au plus :
 *   un lot vendu, réservé, sous option ou dont on ne sait plus s'il est libre n'y figure pas. Elle ne porte aucune
 *   donnée personnelle [R533].
 * - Les frais d'acquisition du neuf et de l'ancien viennent du barème rangé par la direction, avec sa source et son
 *   premier jour ; le code calcule les frais du lot et l'écart avec l'ancien, chaque chiffre avec sa source, sa date et
 *   son hypothèse ; sans barème, aucun chiffre [R534].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Au-delà, la disponibilité d'un lot n'est plus sûre : il sort de la grille publiée jusqu'à la prochaine confirmation. */
export const LOT_CONFIRMATION_DAYS = 14;

export const LOT_TYPOLOGIES = ['studio', 't1', 't2', 't3', 't4', 't5', 't6', 'maison', 'local'] as const;
export type LotTypology = (typeof LOT_TYPOLOGIES)[number];
export const LOT_STATUSES = ['disponible', 'option', 'reserve', 'vendu'] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];
export type FeeKind = 'neuf' | 'ancien';

export interface Sourced<T> {
  value: T;
  source: string;
  asOf: string;
  hypothesis: string;
}

export interface LotVersion {
  lotRef: string;
  version: number;
  typology: LotTypology;
  livingAreaHundredths: number;
  floor: number;
  priceCents: number;
  status: LotStatus;
  confirmedOn: string;
}

export interface LotFees {
  newFees: Sourced<number>;
  oldFees: Sourced<number>;
  saving: Sourced<number>;
}

export interface PublishedLot {
  lotRef: string;
  typology: LotTypology;
  livingAreaHundredths: number;
  floor: number;
  priceCents: number;
  confirmedOn: string;
  /** `null` quand le barème manque : jamais un chiffre inventé [R534]. */
  fees: LotFees | null;
}

export interface PublishedGrid {
  programId: string;
  name: string;
  city: string;
  postalCode: string;
  promoter: string;
  day: string;
  lots: PublishedLot[];
}

export interface AgentGrid extends PublishedGrid {
  all: LotVersion[];
  /** Les lots disponibles dont la confirmation est trop ancienne : ils ne sont plus publiés tant qu'on ne les confirme pas. */
  toConfirm: string[];
}

export type NeufRefusal = { ok: false; rule: 'R16' | 'R533' | 'R534' | null; code: string };
export type NeufOutcome<T> = { ok: true; value: T } | NeufRefusal;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const parisDay = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);
const LOT_REF = /^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/;
const divRound = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

/** Frais d'un prix à un taux en points de base, en centimes, arrondis au plus proche. */
export const feesOf = (priceCents: number, rateBp: number): number => Number(divRound(BigInt(priceCents) * BigInt(rateBp), 10_000n));

interface ProgramRow {
  id: string;
  network_id: string;
  agent_id: string;
  name: string;
  city: string;
  postal_code: string;
  promoter: string;
}

interface LotRow {
  lot_ref: string;
  version: number;
  typology: LotTypology;
  living_area_hundredths: number;
  floor: number;
  price_cents: number;
  status: LotStatus;
  confirmed_on: string;
}

interface ScaleRow {
  id: string;
  rate_bp: number;
  source: string;
  valid_from: string;
}

export interface ProgrammesNeufsOptions {
  now?: () => Date;
  newId?: () => string;
}

export class ProgrammesNeufs {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ProgrammesNeufsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private async refuse(viewer: Viewer, rule: NeufRefusal['rule'], code: string): Promise<NeufRefusal> {
    await appendEvent(
      this.journal,
      {
        type: rule === 'R16' ? 'acces.refuse' : 'neuf.refuse',
        actor: `${String(viewer.role)}:${viewer.userId}`,
        subject: `network:${viewer.networkId}`,
        data: { rule, code, kind: 'new_program', role: String(viewer.role) },
      },
      this.now,
    );
    return { ok: false, rule, code };
  }

  /** La direction range un barème des frais d'acquisition, neuf ou ancien, avec sa source et son premier jour [R534]. */
  async setFeeScale(viewer: Viewer, input: { kind: unknown; rateBp: unknown; source: unknown; validFrom: unknown }): Promise<NeufOutcome<{ id: string }>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    if (input.kind !== 'neuf' && input.kind !== 'ancien') return this.refuse(viewer, 'R534', 'kind');
    if (!isInt(input.rateBp, 1, 2000)) return this.refuse(viewer, 'R534', 'rate');
    if (typeof input.source !== 'string' || input.source.trim().length < 5 || input.source.length > 300) return this.refuse(viewer, 'R534', 'source');
    if (!validDay(input.validFrom)) return this.refuse(viewer, 'R534', 'valid_from');
    const id = this.newId();
    await this.db.run(
      'INSERT INTO acquisition_fee_scales (id, network_id, kind, rate_bp, source, valid_from, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, input.kind, input.rateBp, input.source.trim(), input.validFrom, `direction:${viewer.userId}`, this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'neuf.bareme', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { scale: id, kind: input.kind, rateBp: input.rateBp } },
      this.now,
    );
    return { ok: true, value: { id } };
  }

  /** Le barème qui fait foi ce jour : le dernier commencé, et pour un même premier jour, le dernier rangé. */
  private async scaleOn(networkId: string, kind: FeeKind, day: string): Promise<ScaleRow | null> {
    return this.db.first<ScaleRow>(
      'SELECT id, rate_bp, source, valid_from FROM acquisition_fee_scales WHERE network_id = ? AND kind = ? AND valid_from <= ? ORDER BY valid_from DESC, set_at DESC, id DESC LIMIT 1',
      [networkId, kind, day],
    );
  }

  /** Frais du neuf, frais de l'ancien au même prix, et l'écart : calculés par le code, chacun sourcé [R534]. */
  async feesFor(networkId: string, priceCents: number, day: string): Promise<LotFees | null> {
    const neuf = await this.scaleOn(networkId, 'neuf', day);
    const ancien = await this.scaleOn(networkId, 'ancien', day);
    if (!neuf || !ancien) return null;
    const src = (s: ScaleRow) => `bareme:${s.id} · ${s.source}`;
    const newFees = feesOf(priceCents, neuf.rate_bp);
    const oldFees = feesOf(priceCents, ancien.rate_bp);
    return {
      newFees: { value: newFees, source: src(neuf), asOf: neuf.valid_from, hypothesis: `prix TTC du lot × ${neuf.rate_bp} points de base (barème du neuf)` },
      oldFees: { value: oldFees, source: src(ancien), asOf: ancien.valid_from, hypothesis: `même prix × ${ancien.rate_bp} points de base (barème de l’ancien)` },
      saving: {
        value: oldFees - newFees,
        source: `calcul:neuf · ${src(neuf)} · ${src(ancien)}`,
        asOf: day,
        hypothesis: 'frais de l’ancien − frais du neuf, au même prix',
      },
    };
  }

  /**
   * La direction ouvre un programme d'un promoteur partenaire (M18) et le confie à un agent en activité du réseau.
   */
  async createProgram(
    viewer: Viewer,
    input: { promoterPartnerId: unknown; agentId: unknown; name: unknown; city: unknown; postalCode: unknown },
  ): Promise<NeufOutcome<{ programId: string }>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    const { promoterPartnerId, agentId, name, city, postalCode } = input;
    if (typeof promoterPartnerId !== 'string' || typeof agentId !== 'string') return this.refuse(viewer, null, 'unknown');
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 120) return this.refuse(viewer, null, 'name');
    if (typeof city !== 'string' || city.trim().length < 2 || city.length > 80) return this.refuse(viewer, null, 'city');
    if (typeof postalCode !== 'string' || !/^\d{5}$/.test(postalCode)) return this.refuse(viewer, null, 'postal_code');
    const partner = await this.db.first<{ trade: string }>('SELECT trade FROM partners WHERE id = ? AND network_id = ?', [promoterPartnerId, viewer.networkId]);
    if (!partner || partner.trade !== 'promoteur') return this.refuse(viewer, null, 'not_promoter');
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [agentId, viewer.networkId]);
    if (!agent || agent.status !== 'active') return this.refuse(viewer, null, 'agent');
    const id = this.newId();
    await this.db.run(
      'INSERT INTO new_programs (id, network_id, promoter_partner_id, agent_id, name, city, postal_code, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, promoterPartnerId, agentId, name.trim(), city.trim(), postalCode, `direction:${viewer.userId}`, this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'neuf.programme', actor: `direction:${viewer.userId}`, subject: `new_program:${id}`, data: { program: id } }, this.now);
    return { ok: true, value: { programId: id } };
  }

  private async program(networkId: string, programId: unknown): Promise<ProgramRow | null> {
    if (typeof programId !== 'string') return null;
    return this.db.first<ProgramRow>(
      `SELECT g.id, g.network_id, g.agent_id, g.name, g.city, g.postal_code, p.business_name AS promoter
       FROM new_programs g JOIN partners p ON p.id = g.promoter_partner_id AND p.network_id = g.network_id
       WHERE g.id = ? AND g.network_id = ?`,
      [programId, networkId],
    );
  }

  /** L'agent du programme, en activité, ou la direction. */
  private async gate(viewer: Viewer, programId: unknown): Promise<ProgramRow | NeufRefusal> {
    const program = await this.program(viewer.networkId, programId);
    if (!program) return this.refuse(viewer, 'R16', 'unknown');
    if (viewer.role === 'direction') return program;
    if (viewer.role !== 'agent' || viewer.userId !== program.agent_id) return this.refuse(viewer, 'R16', 'not_assigned');
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!agent || agent.status !== 'active') return this.refuse(viewer, 'R16', 'agent_left');
    return program;
  }

  private async latestLots(programId: string): Promise<LotVersion[]> {
    const rows = await this.db.all<LotRow>(
      `SELECT v.lot_ref, v.version, v.typology, v.living_area_hundredths, v.floor, v.price_cents, v.status, v.confirmed_on
       FROM new_program_lot_versions v
       WHERE v.program_id = ? AND v.version = (SELECT max(x.version) FROM new_program_lot_versions x WHERE x.program_id = v.program_id AND x.lot_ref = v.lot_ref)
       ORDER BY v.lot_ref`,
      [programId],
    );
    return rows.map((r) => ({
      lotRef: r.lot_ref,
      version: r.version,
      typology: r.typology,
      livingAreaHundredths: r.living_area_hundredths,
      floor: r.floor,
      priceCents: r.price_cents,
      status: r.status,
      confirmedOn: r.confirmed_on,
    }));
  }

  /**
   * L'agent du programme ou la direction range l'état d'un lot tel que le promoteur l'a confirmé, en nouvelle version.
   * Un lot vendu ne revient jamais [R533].
   */
  async recordLot(
    viewer: Viewer,
    programId: unknown,
    input: { lotRef: unknown; typology: unknown; livingAreaHundredths: unknown; floor: unknown; priceCents: unknown; status: unknown; confirmedOn: unknown },
  ): Promise<NeufOutcome<LotVersion>> {
    const program = await this.gate(viewer, programId);
    if ('ok' in program) return program;
    const { lotRef, typology, livingAreaHundredths, floor, priceCents, status, confirmedOn } = input;
    if (typeof lotRef !== 'string' || !LOT_REF.test(lotRef)) return this.refuse(viewer, null, 'lot_ref');
    if (typeof typology !== 'string' || !(LOT_TYPOLOGIES as readonly string[]).includes(typology)) return this.refuse(viewer, null, 'typology');
    if (!isInt(livingAreaHundredths, 1000, 100_000)) return this.refuse(viewer, null, 'area');
    if (!isInt(floor, -2, 60)) return this.refuse(viewer, null, 'floor');
    if (!isInt(priceCents, 1_000_000, 10_000_000_000)) return this.refuse(viewer, null, 'price');
    if (typeof status !== 'string' || !(LOT_STATUSES as readonly string[]).includes(status)) return this.refuse(viewer, null, 'status');
    const today = parisDay(this.now());
    if (!validDay(confirmedOn) || confirmedOn > today) return this.refuse(viewer, null, 'confirmed_on');
    const previous = (await this.latestLots(program.id)).find((l) => l.lotRef === lotRef);
    if (previous?.status === 'vendu') return this.refuse(viewer, 'R533', 'vendu');
    if (previous && confirmedOn < previous.confirmedOn) return this.refuse(viewer, null, 'confirmed_on');
    const version = (previous?.version ?? 0) + 1;
    await this.db.run(
      `INSERT INTO new_program_lot_versions (program_id, lot_ref, version, typology, living_area_hundredths, floor, price_cents, status, confirmed_on, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [program.id, lotRef, version, typology, livingAreaHundredths, floor, priceCents, status, confirmedOn, `${String(viewer.role)}:${viewer.userId}`, this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'neuf.lot', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `new_program:${program.id}`, data: { lot: lotRef, version, status } },
      this.now,
    );
    return {
      ok: true,
      value: { lotRef, version, typology: typology as LotTypology, livingAreaHundredths, floor, priceCents, status: status as LotStatus, confirmedOn },
    };
  }

  private async publishedFrom(program: ProgramRow, lots: LotVersion[], day: string): Promise<PublishedGrid> {
    const oldest = addDays(day, -LOT_CONFIRMATION_DAYS);
    const published: PublishedLot[] = [];
    for (const l of lots) {
      if (l.status !== 'disponible' || l.confirmedOn < oldest || l.confirmedOn > day) continue;
      published.push({
        lotRef: l.lotRef,
        typology: l.typology,
        livingAreaHundredths: l.livingAreaHundredths,
        floor: l.floor,
        priceCents: l.priceCents,
        confirmedOn: l.confirmedOn,
        fees: await this.feesFor(program.network_id, l.priceCents, day),
      });
    }
    return { programId: program.id, name: program.name, city: program.city, postalCode: program.postal_code, promoter: program.promoter, day, lots: published };
  }

  /**
   * La grille publiée d'un programme, pour le site et les annonces : les seuls lots disponibles confirmés depuis 14
   * jours au plus, sans aucune donnée personnelle (ni agent, ni client, ni auteur des versions) [R533].
   */
  async publishedGrid(networkId: string, programId: unknown): Promise<PublishedGrid | null> {
    const program = await this.program(networkId, programId);
    if (!program) return null;
    return this.publishedFrom(program, await this.latestLots(program.id), parisDay(this.now()));
  }

  /** La grille entière pour l'agent du programme ou la direction, avec les lots à reconfirmer. */
  async agentGrid(viewer: Viewer, programId: unknown): Promise<NeufOutcome<AgentGrid>> {
    const program = await this.gate(viewer, programId);
    if ('ok' in program) return program;
    const day = parisDay(this.now());
    const lots = await this.latestLots(program.id);
    const oldest = addDays(day, -LOT_CONFIRMATION_DAYS);
    const toConfirm = lots.filter((l) => l.status === 'disponible' && l.confirmedOn < oldest).map((l) => l.lotRef);
    return { ok: true, value: { ...(await this.publishedFrom(program, lots, day)), all: lots, toConfirm } };
  }
}
