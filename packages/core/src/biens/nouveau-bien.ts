// SV06 · L'agent crée le bien de son client et le lie à son projet de vente : sans ce lien, aucun mandat ne se signe [R41].
// La référence est tirée au hasard : elle ne dit ni le nom du vendeur ni l'adresse [R19]. Aucun envoi.
import type { Acces } from '../acces/acces.ts';
import type { JournalStore } from '../journal/types.ts';
import { appendEvent } from '../journal/journal.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import type { PropertyKind } from '../db/types.ts';
import type { Viewer } from '../acces/droits.ts';

export const NEW_PROPERTY_KINDS: readonly PropertyKind[] = Object.freeze(['home', 'building', 'land', 'commercial', 'business_walls', 'business']);

export interface OwnedProperty {
  propertyId: string;
  reference: string;
  kind: PropertyKind;
  postalCode: string | null;
  city: string | null;
  surfaceM2: number | null;
  rooms: number | null;
  priceEur: number | null;
  status: string;
}

export type NewPropertyRefusal = { ok: false; rule: 'R16' | null; code: string };

const isCount = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;

interface Clean {
  kind: PropertyKind;
  postalCode: string;
  city: string;
  surfaceM2: number;
  rooms: number | null;
  priceEur: number | null;
}

function validate(input: Record<string, unknown>): Clean | string {
  const { kind, postalCode, city, surfaceM2, rooms, priceEur } = input;
  if (typeof kind !== 'string' || !(NEW_PROPERTY_KINDS as readonly string[]).includes(kind)) return 'bad_kind';
  if (typeof postalCode !== 'string' || !/^\d{5}$/.test(postalCode)) return 'bad_postal_code';
  const town = typeof city === 'string' ? city.trim() : '';
  if (town.length < 1 || town.length > 80 || /\d/.test(town)) return 'bad_city';
  if (!isCount(surfaceM2, 1_000_000)) return 'bad_surface';
  if (rooms !== undefined && rooms !== null && !isCount(rooms, 200)) return 'bad_rooms';
  if (priceEur !== undefined && priceEur !== null && !isCount(priceEur, 1_000_000_000)) return 'bad_price';
  return { kind: kind as PropertyKind, postalCode, city: town, surfaceM2, rooms: (rooms as number | null | undefined) ?? null, priceEur: (priceEur as number | null | undefined) ?? null };
}

export class NouveauBien {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newReference: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; newReference?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newReference = options.newReference ?? (() => `B-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`);
  }

  /** La fiche, lue selon les droits de ce lecteur [R16] ; seuls l'agent de la fiche et la direction créent un bien. */
  private async gate(viewer: Viewer, personId: string): Promise<{ ok: true; personId: string; members: string[]; agentId: string | null } | NewPropertyRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `person:${personId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'new_property', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const fiche = await this.acces.readFiche(viewer, personId);
    if (!fiche.ok) return { ok: false, rule: fiche.code === 'unknown' ? null : 'R16', code: fiche.code };
    if (fiche.view !== 'full') return { ok: false, rule: 'R16', code: 'not_assigned' };
    return { ok: true, personId: fiche.value.person.id, members: fiche.value.members.map((m) => m.id), agentId: fiche.value.person.agent_id };
  }

  private owned(members: readonly string[]): Promise<(OwnedProperty & { projectId: string })[]> {
    return this.db
      .all<{ project_id: string; id: string; reference: string; kind: PropertyKind; postal_code: string | null; city: string | null; surface_m2: number | null; rooms: number | null; price_eur: number | null; status: string }>(
        `SELECT pp.project_id, b.id, b.reference, b.kind, b.postal_code, b.city, b.surface_m2, b.rooms, b.price_eur, b.status
           FROM projects p JOIN project_properties pp ON pp.project_id = p.id AND pp.role = 'owned' JOIN properties b ON b.id = pp.property_id
          WHERE p.person_id IN (${members.map(() => '?').join(', ')}) ORDER BY b.created_at, b.id`,
        [...members],
      )
      .then((rows) => rows.map((r) => ({ projectId: r.project_id, propertyId: r.id, reference: r.reference, kind: r.kind, postalCode: r.postal_code, city: r.city, surfaceM2: r.surface_m2, rooms: r.rooms, priceEur: r.price_eur, status: r.status })));
  }

  async list(viewer: Viewer, personId: string): Promise<{ ok: true; value: OwnedProperty[] } | NewPropertyRefusal> {
    const g = await this.gate(viewer, personId);
    if (!g.ok) return g;
    return { ok: true, value: (await this.owned(g.members)).map(({ projectId: _p, ...b }) => b) };
  }

  /**
   * Crée le bien et le lie au projet de vente de la personne, ouvert s'il n'existe pas, le tout d'un seul geste. Le même
   * bien redemandé, par exemple après une réponse perdue, rend le premier : il n'est pas créé deux fois.
   */
  async create(viewer: Viewer, personId: string, input: Record<string, unknown>): Promise<{ ok: true; value: OwnedProperty & { already: boolean } } | NewPropertyRefusal> {
    const g = await this.gate(viewer, personId);
    if (!g.ok) return g;
    if (g.agentId === null) return { ok: false, rule: null, code: 'no_agent' };
    const clean = validate(input);
    if (typeof clean === 'string') return { ok: false, rule: null, code: clean };

    const twin = (await this.owned(g.members)).find((b) => b.kind === clean.kind && b.postalCode === clean.postalCode && b.city === clean.city && b.surfaceM2 === clean.surfaceM2);
    if (twin) {
      const { projectId: _p, ...found } = twin;
      return { ok: true, value: { ...found, already: true } };
    }

    const at = this.now().toISOString();
    const project = await this.db.first<{ id: string }>(`SELECT id FROM projects WHERE person_id IN (${g.members.map(() => '?').join(', ')}) AND kind = 'sell' ORDER BY created_at DESC, id LIMIT 1`, g.members);
    const projectId = project?.id ?? this.newId();
    const propertyId = this.newId();
    const statements = (reference: string) => [
      ...(project
        ? []
        : [{ sql: "INSERT INTO projects (id, network_id, agent_id, person_id, kind, stage, created_at, updated_at) VALUES (?, ?, ?, ?, 'sell', 'new', ?, ?)", params: [projectId, viewer.networkId, g.agentId, g.personId, at, at] }]),
      {
        sql: "INSERT INTO properties (id, network_id, agent_id, reference, kind, postal_code, city, surface_m2, rooms, price_eur, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
        params: [propertyId, viewer.networkId, g.agentId, reference, clean.kind, clean.postalCode, clean.city, clean.surfaceM2, clean.rooms, clean.priceEur, at, at],
      },
      { sql: "INSERT INTO project_properties (project_id, property_id, network_id, agent_id, role, created_at) VALUES (?, ?, ?, ?, 'owned', ?)", params: [projectId, propertyId, viewer.networkId, g.agentId, at] },
    ];

    // Une référence déjà prise est tirée de nouveau ; toute autre panne remonte.
    let reference = this.newReference();
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runBatch(this.db, statements(reference));
        break;
      } catch (error) {
        if (attempt >= 3 || !/UNIQUE/i.test(String(error))) throw error;
        reference = this.newReference();
      }
    }
    await appendEvent(this.journal, { type: 'bien.cree', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', kind: clean.kind } }, this.now);
    return { ok: true, value: { propertyId, reference, kind: clean.kind, postalCode: clean.postalCode, city: clean.city, surfaceM2: clean.surfaceM2, rooms: clean.rooms, priceEur: clean.priceEur, status: 'draft', already: false } };
  }
}
