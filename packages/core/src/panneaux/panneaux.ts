/**
 * Le stock de panneaux (HX14) [R282, R283, R284].
 *
 * - Chaque panneau du stock du réseau a un numéro donné par le code, unique dans le réseau, et un format d'une liste
 *   fermée ; seule la direction en ajoute [R282].
 * - Un panneau n'est posé que sur un bien : par l'agent du bien en activité ou par la direction, quand le bien peut être
 *   diffusé à ce moment (un panneau est une publicité, la porte de diffusion de D05 décide) [R42], à une adresse dont le
 *   code postal et la commune sont ceux du bien. Un panneau n'est posé qu'à un endroit à la fois, même demandé deux fois
 *   en même temps ; un panneau perdu ne se pose plus [R282]. Rien ne change ni ne s'efface [R17].
 * - Jamais vu : chaque jour, un panneau posé sur un bien vendu (fiche, dernière annonce ou acte signé) ou qui ne peut
 *   plus être diffusé (mandat échu, rétracté, annulé) reçoit tout seul sa tâche « récupérer le panneau » pour l'agent de
 *   la pose, une seule par pose, avec l'adresse de la pose rendue comme un arrêt de la tournée [R283].
 * - Combien en stock, posés, à récupérer, perdus : la direction voit tout le réseau ; l'agent voit les comptes et les
 *   seules poses qu'il tient, avec leur adresse [R284].
 * - Au journal : des identifiants, des numéros et des raisons, jamais une adresse [R13]. Rien n'est envoyé.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { DiffusionDecision } from '../documents/retractation.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
export const SIGN_PICKUPS_JOB = 'panneaux.recuperer';

export const SIGN_SIZES = ['grand', 'moyen', 'petit'] as const;
export type SignSize = (typeof SIGN_SIZES)[number];

export const PICKUP_REASONS = ['vendu', 'fin_mandat'] as const;
export type PickupReason = (typeof PICKUP_REASONS)[number];

export const PICKUP_TEXT: Record<PickupReason, string> = {
  vendu: 'Bien vendu : récupérer le panneau.',
  fin_mandat: 'Mandat terminé : récupérer le panneau.',
};

/** La porte de diffusion de D05 : un panneau ne se pose que si le bien peut être diffusé [R42]. */
export interface SignGate {
  canDiffuse(networkId: string, propertyId: string, at?: Date): Promise<DiffusionDecision>;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R282' | 'R283' | 'R42' | null; code: string };

export interface SignAddress {
  streetNumber: string;
  street: string;
  postcode: string;
  city: string;
}

/** Un arrêt de tournée : de quoi la tournée de HX19 a besoin, sans aucune donnée d'un client. */
export interface PickupStop {
  kind: 'panneau';
  placementId: string;
  signNumber: number;
  propertyId: string;
  reference: string;
  reason: PickupReason;
  text: string;
  dueDay: string;
  address: SignAddress;
}

export interface PlacedSign {
  placementId: string;
  signNumber: number;
  size: SignSize;
  propertyId: string;
  reference: string;
  agentId: string;
  placedAt: string;
  address: SignAddress;
  /** La tâche « récupérer le panneau », si elle est rangée. */
  pickup: { reason: PickupReason; dueDay: string } | null;
}

export interface SignCounts {
  total: number;
  enStock: number;
  poses: number;
  aRecuperer: number;
  perdus: number;
  bySize: Record<SignSize, { enStock: number; poses: number }>;
}

/** Les mots d'une adresse : chiffres et lettres, sans retour à la ligne ni signe étrange. */
const STREET_NUMBER = /^\d{1,4}(?: ?(?:bis|ter|quater|[a-z]))?$/iu;
const STREET = /^[\p{L}\d][\p{L}\d '’.-]{1,78}[\p{L}\d.]$/u;
const POSTCODE = /^\d{5}$/;

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[-’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** L'adresse d'une pose, remise en forme, ou nulle si elle n'en est pas une [R282]. */
export function cleanAddress(input: unknown): SignAddress | null {
  if (!input || typeof input !== 'object') return null;
  const a = input as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && !/[\r\n\t]/.test(v) ? v.trim().replace(/\s+/g, ' ') : null);
  const streetNumber = str(a.streetNumber);
  const street = str(a.street);
  const postcode = str(a.postcode);
  const city = str(a.city);
  if (!streetNumber || !STREET_NUMBER.test(streetNumber)) return null;
  if (!street || !STREET.test(street) || !/\p{L}{2}/u.test(street)) return null;
  if (!postcode || !POSTCODE.test(postcode)) return null;
  if (!city || city.length > 80 || !/\p{L}/u.test(city)) return null;
  return { streetNumber, street, postcode, city };
}

interface PlacementRow {
  id: string;
  network_id: string;
  sign_id: string;
  number: number;
  size: SignSize;
  property_id: string;
  reference: string;
  agent_id: string;
  street_number: string;
  street: string;
  postcode: string;
  city: string;
  placed_at: string;
  reason: PickupReason | null;
  due_day: string | null;
}

const PLACEMENT_SELECT = `
  SELECT p.id, p.network_id, p.sign_id, s.number, s.size, p.property_id, pr.reference, p.agent_id, p.street_number, p.street,
         p.postcode, p.city, p.placed_at, t.reason, t.due_day
    FROM sign_placements p
    JOIN signs s ON s.id = p.sign_id
    JOIN properties pr ON pr.id = p.property_id
    LEFT JOIN sign_pickup_tasks t ON t.placement_id = p.id
   WHERE NOT EXISTS (SELECT 1 FROM sign_removals r WHERE r.placement_id = p.id)`;

const addressOf = (r: PlacementRow): SignAddress => ({ streetNumber: r.street_number, street: r.street, postcode: r.postcode, city: r.city });

export interface PanneauxOptions {
  now?: () => Date;
  newId?: () => string;
}

export class Panneaux {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly gate: SignGate,
    private readonly journal: JournalStore,
    options: PanneauxOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'panneaux', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async activeAgent(networkId: string, agentId: string): Promise<boolean> {
    const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [agentId, networkId]);
    if (!a) return false;
    return (await agentState(this.db, networkId, agentId, this.now())) === 'actif';
  }

  /** La direction, ou un agent du réseau en activité ; les autres ne voient rien du stock [R284]. */
  private async member(viewer: Viewer): Promise<Refusal | null> {
    if (viewer.role === 'direction') return null;
    if (viewer.role !== 'agent') return this.refuse(viewer, null, 'role');
    if (!(await this.activeAgent(viewer.networkId, viewer.userId))) return this.refuse(viewer, null, 'agent_inactive');
    return null;
  }

  /** Ajouter des panneaux au stock : la direction seule ; les numéros sont donnés par le code [R282]. */
  async addToStock(viewer: Viewer, sizeInput: unknown, countInput: unknown = 1): Promise<{ ok: true; numbers: number[] } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'not_direction');
    if (typeof sizeInput !== 'string' || !(SIGN_SIZES as readonly string[]).includes(sizeInput)) return { ok: false, rule: 'R282', code: 'bad_size' };
    if (typeof countInput !== 'number' || !Number.isInteger(countInput) || countInput < 1 || countInput > 50) return { ok: false, rule: 'R282', code: 'bad_count' };
    const numbers: number[] = [];
    for (let i = 0; i < countInput; i += 1) {
      const id = this.newId();
      // Le numéro et l'écriture en une seule instruction : deux panneaux ajoutés en même temps n'ont jamais le même.
      await this.db.run(
        `INSERT INTO signs (id, network_id, number, size, created_by, created_at)
         SELECT ?, ?, coalesce(max(number), 0) + 1, ?, ?, ? FROM signs WHERE network_id = ?`,
        [id, viewer.networkId, sizeInput, this.actor(viewer), this.now().toISOString(), viewer.networkId],
      );
      const row = await this.db.first<{ number: number }>('SELECT number FROM signs WHERE id = ?', [id]);
      if (!row) return { ok: false, rule: null, code: 'non_range' };
      numbers.push(row.number);
      await appendEvent(this.journal, { type: 'panneau.ajoute', actor: this.actor(viewer), subject: `sign:${id}`, data: { rule: 'R282', number: row.number, size: sizeInput } }, this.now);
    }
    return { ok: true, numbers };
  }

  /**
   * Poser un panneau sur un bien. L'agent du bien en activité ou la direction ; le bien peut être diffusé maintenant
   * [R42] ; l'adresse est au code postal et à la commune du bien ; le panneau est au stock [R282].
   */
  async place(viewer: Viewer, input: { signNumber: unknown; propertyId: unknown; address: unknown }): Promise<{ ok: true; placementId: string } | Refusal | Problem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, null, 'role');
    if (typeof input.propertyId !== 'string') return { ok: false, rule: 'R282', code: 'sans_bien' };
    const propertyId = input.propertyId;
    if (viewer.role === 'agent' && !(await this.activeAgent(viewer.networkId, viewer.userId))) return this.refuse(viewer, `property:${propertyId}`, 'agent_inactive');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    const property = read.value;
    if (property.network_id !== viewer.networkId) return this.refuse(viewer, `property:${propertyId}`, 'network');
    if (viewer.role === 'agent' && (read.view !== 'full' || property.agent_id !== viewer.userId)) return this.refuse(viewer, `property:${propertyId}`, 'pas_son_bien');
    if (!property.agent_id) return { ok: false, rule: 'R282', code: 'bien_sans_agent' };
    if (typeof input.signNumber !== 'number' || !Number.isInteger(input.signNumber)) return { ok: false, rule: 'R282', code: 'unknown_sign' };
    const sign = await this.db.first<{ id: string }>('SELECT id FROM signs WHERE network_id = ? AND number = ?', [viewer.networkId, input.signNumber]);
    if (!sign) return { ok: false, rule: 'R282', code: 'unknown_sign' };
    const address = cleanAddress(input.address);
    if (!address) return { ok: false, rule: 'R282', code: 'bad_address' };
    if (!property.postal_code || !property.city) return { ok: false, rule: 'R282', code: 'bien_sans_commune' };
    if (address.postcode !== property.postal_code || fold(address.city) !== fold(property.city)) return { ok: false, rule: 'R282', code: 'hors_du_bien' };
    if (await this.sold(viewer.networkId, propertyId)) return { ok: false, rule: 'R282', code: 'bien_vendu' };
    const decision = await this.gate.canDiffuse(viewer.networkId, propertyId, this.now());
    if (!decision.allowed || !decision.mandateId) return { ok: false, rule: 'R42', code: decision.reason };
    const id = this.newId();
    // Posé seulement s'il est au stock : relu dans la même instruction, et gardé par la base [R282].
    const { changes } = await this.db.run(
      `INSERT INTO sign_placements (id, network_id, sign_id, property_id, agent_id, mandate_id, street_number, street, postcode, city, placed_by, placed_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM sign_placements p WHERE p.sign_id = ? AND NOT EXISTS (SELECT 1 FROM sign_removals r WHERE r.placement_id = p.id))
          AND NOT EXISTS (SELECT 1 FROM sign_placements p JOIN sign_removals r ON r.placement_id = p.id WHERE p.sign_id = ? AND r.outcome = 'perdu')`,
      [id, viewer.networkId, sign.id, propertyId, property.agent_id, decision.mandateId, address.streetNumber, address.street, address.postcode, address.city, this.actor(viewer), this.now().toISOString(), sign.id, sign.id],
    );
    if (changes !== 1) return { ok: false, rule: 'R282', code: 'pas_au_stock' };
    await appendEvent(this.journal, { type: 'panneau.pose', actor: this.actor(viewer), subject: `sign:${sign.id}`, data: { rule: 'R282', number: input.signNumber, property: propertyId, placement: id } }, this.now);
    return { ok: true, placementId: id };
  }

  /** Dire le panneau récupéré (il revient au stock) ou perdu (il n'en sort plus) : l'agent de la pose ou la direction. */
  async remove(viewer: Viewer, placementId: string, outcomeInput: unknown): Promise<{ ok: true } | Refusal | Problem> {
    const blocked = await this.member(viewer);
    if (blocked) return blocked;
    if (outcomeInput !== 'recupere' && outcomeInput !== 'perdu') return { ok: false, rule: 'R283', code: 'bad_outcome' };
    const p = await this.db.first<{ id: string; agent_id: string; sign_id: string }>('SELECT id, agent_id, sign_id FROM sign_placements WHERE id = ? AND network_id = ?', [placementId, viewer.networkId]);
    if (!p) return { ok: false, rule: null, code: 'unknown_placement' };
    if (viewer.role === 'agent' && p.agent_id !== viewer.userId) return this.refuse(viewer, `sign:${p.sign_id}`, 'pas_sa_pose');
    const { changes } = await this.db.run(
      'INSERT INTO sign_removals (placement_id, network_id, outcome, removed_by, removed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (placement_id) DO NOTHING',
      [placementId, viewer.networkId, outcomeInput, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: 'R283', code: 'deja_retire' };
    await appendEvent(this.journal, { type: 'panneau.retire', actor: this.actor(viewer), subject: `sign:${p.sign_id}`, data: { rule: 'R283', placement: placementId, outcome: outcomeInput } }, this.now);
    return { ok: true };
  }

  /** Le bien est-il vendu : fiche, dernière annonce, ou acte signé d'un dossier qui n'est pas arrêté. */
  private async sold(networkId: string, propertyId: string): Promise<boolean> {
    const p = await this.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ? AND network_id = ?', [propertyId, networkId]);
    if (p?.status === 'sold') return true;
    const listing = await this.db.first<{ state: string }>('SELECT state FROM listing_versions WHERE property_id = ? AND network_id = ? ORDER BY seq DESC LIMIT 1', [propertyId, networkId]);
    if (listing?.state === 'vendu') return true;
    const deed = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sale_files f JOIN sale_file_closings c ON c.file_id = f.id
        WHERE f.property_id = ? AND f.network_id = ? AND NOT EXISTS (SELECT 1 FROM sale_file_stops s WHERE s.file_id = f.id)`,
      [propertyId, networkId],
    );
    return (deed?.n ?? 0) > 0;
  }

  /**
   * Un passage : pour chaque panneau posé sans tâche, range « récupérer le panneau » si le bien est vendu ou ne peut plus
   * être diffusé. Une seule tâche par pose, même rejoué ou doublé [R283, R18]. Rend le nombre de tâches nouvelles.
   */
  async run(): Promise<number> {
    const now = this.now();
    const today = localTime(now, TIME_ZONE).date;
    const rows = await this.db.all<{ id: string; network_id: string; property_id: string; agent_id: string; sign_id: string }>(
      `SELECT p.id, p.network_id, p.property_id, p.agent_id, p.sign_id FROM sign_placements p
        WHERE NOT EXISTS (SELECT 1 FROM sign_removals r WHERE r.placement_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM sign_pickup_tasks t WHERE t.placement_id = p.id)
        ORDER BY p.placed_at, p.id`,
    );
    let created = 0;
    let failure: unknown = null;
    for (const row of rows) {
      try {
        let reason: PickupReason | null = null;
        let detail: string | null = null;
        if (await this.sold(row.network_id, row.property_id)) reason = 'vendu';
        else {
          const decision = await this.gate.canDiffuse(row.network_id, row.property_id, now);
          if (!decision.allowed) {
            reason = 'fin_mandat';
            detail = decision.reason;
          }
        }
        if (reason === null) continue;
        const { changes } = await this.db.run(
          'INSERT INTO sign_pickup_tasks (placement_id, network_id, agent_id, reason, detail, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (placement_id) DO NOTHING',
          [row.id, row.network_id, row.agent_id, reason, detail, today, now.toISOString()],
        );
        if (changes === 1) {
          created += 1;
          await appendEvent(this.journal, { type: 'panneau.a_recuperer', actor: 'system:planificateur', subject: `sign:${row.sign_id}`, data: { rule: 'R283', placement: row.id, reason, detail } }, this.now);
        }
      } catch (error) {
        // Une panne sur une pose n'arrête pas les autres ; elle remonte ensuite au planificateur [R13].
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return created;
  }

  /**
   * Les panneaux à récupérer de l'agent, comme arrêts de sa tournée, avec l'adresse de la pose [R283, R284]. La direction
   * voit ceux de tout le réseau.
   */
  async pickups(viewer: Viewer): Promise<{ ok: true; stops: PickupStop[] } | Refusal> {
    const blocked = await this.member(viewer);
    if (blocked) return blocked;
    const mine = viewer.role === 'agent';
    const rows = await this.db.all<PlacementRow>(
      `${PLACEMENT_SELECT} AND p.network_id = ? AND t.placement_id IS NOT NULL ${mine ? 'AND p.agent_id = ?' : ''} ORDER BY t.due_day, s.number`,
      mine ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    return {
      ok: true,
      stops: rows.map((r) => ({
        kind: 'panneau',
        placementId: r.id,
        signNumber: r.number,
        propertyId: r.property_id,
        reference: r.reference,
        reason: r.reason!,
        text: PICKUP_TEXT[r.reason!],
        dueDay: r.due_day!,
        address: addressOf(r),
      })),
    };
  }

  /** Le stock : les comptes pour tous ; les poses de tout le réseau pour la direction, les siennes seules pour l'agent [R284]. */
  async stock(viewer: Viewer): Promise<{ ok: true; counts: SignCounts; placed: PlacedSign[] } | Refusal> {
    const blocked = await this.member(viewer);
    if (blocked) return blocked;
    const signs = await this.db.all<{ size: SignSize; state: 'stock' | 'pose' | 'a_recuperer' | 'perdu' }>(
      `SELECT s.size,
              CASE
                WHEN EXISTS (SELECT 1 FROM sign_placements p JOIN sign_removals r ON r.placement_id = p.id WHERE p.sign_id = s.id AND r.outcome = 'perdu') THEN 'perdu'
                WHEN EXISTS (SELECT 1 FROM sign_placements p JOIN sign_pickup_tasks t ON t.placement_id = p.id
                              WHERE p.sign_id = s.id AND NOT EXISTS (SELECT 1 FROM sign_removals r WHERE r.placement_id = p.id)) THEN 'a_recuperer'
                WHEN EXISTS (SELECT 1 FROM sign_placements p WHERE p.sign_id = s.id AND NOT EXISTS (SELECT 1 FROM sign_removals r WHERE r.placement_id = p.id)) THEN 'pose'
                ELSE 'stock'
              END AS state
         FROM signs s WHERE s.network_id = ?`,
      [viewer.networkId],
    );
    const bySize = Object.fromEntries(SIGN_SIZES.map((z) => [z, { enStock: 0, poses: 0 }])) as Record<SignSize, { enStock: number; poses: number }>;
    const counts: SignCounts = { total: signs.length, enStock: 0, poses: 0, aRecuperer: 0, perdus: 0, bySize };
    for (const s of signs) {
      if (s.state === 'stock') {
        counts.enStock += 1;
        bySize[s.size].enStock += 1;
      } else if (s.state === 'perdu') counts.perdus += 1;
      else {
        // Un panneau à récupérer est encore posé.
        counts.poses += 1;
        bySize[s.size].poses += 1;
        if (s.state === 'a_recuperer') counts.aRecuperer += 1;
      }
    }
    const mine = viewer.role === 'agent';
    const rows = await this.db.all<PlacementRow>(
      `${PLACEMENT_SELECT} AND p.network_id = ? ${mine ? 'AND p.agent_id = ?' : ''} ORDER BY s.number`,
      mine ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    const placed = rows.map((r) => ({
      placementId: r.id,
      signNumber: r.number,
      size: r.size,
      propertyId: r.property_id,
      reference: r.reference,
      agentId: r.agent_id,
      placedAt: r.placed_at,
      address: addressOf(r),
      pickup: r.reason ? { reason: r.reason, dueDay: r.due_day! } : null,
    }));
    return { ok: true, counts, placed };
  }
}

/** La tâche du planificateur : les panneaux à récupérer, chaque jour à 6 h, 13 h et 19 h, heure de Paris [R283]. */
export function signPickupsJob(db: SqlDatabase, acces: Acces, gate: SignGate, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob {
  return {
    name: SIGN_PICKUPS_JOB,
    hours: [6, 13, 19],
    run: async () => {
      await new Panneaux(db, acces, gate, journal, options).run();
    },
  };
}
