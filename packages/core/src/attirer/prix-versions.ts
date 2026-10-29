/**
 * Les versions des prix publics (AT01) : zones tracées par la direction, une version calculée à chaque publication
 * DVF (ou à chaque nouveau jeu de zones), rangée et jamais réécrite ; la précédente reste lisible [R150, R151, R17].
 *
 * La source des ventes est celle de l'estimation (E02, `SalesSource`). Une vente est reconnue d'une publication à
 * l'autre par son empreinte (type, position, surface, prix au m², mois), jamais par sa place dans un fichier, qui
 * change à chaque publication. Les empreintes ne sont jamais montrées : elles servent seulement au contrôle
 * anti-différence de la version suivante.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { EstimatedKind, Sale, SalesSource } from '../estimation/fourchette.ts';

/** La source des ventes ; `scan` (celle de E02 l'a) dit aussi les tuiles ou lignes illisibles. */
export type PriceSalesSource = SalesSource & {
  scan?(kind: EstimatedKind, lat: number, lon: number, radius: number): Promise<{ sales: Sale[]; issues: number }>;
};
import { distance } from '../estimation/fourchette.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import {
  DEFAULT_PRICE_SETTINGS,
  PRICE_KINDS,
  decideBlock,
  insideRing,
  ringsOverlap,
  windowOf,
  type CellDecision,
  type CellFigures,
  type CellSale,
  type CellStatus,
  type HoldReason,
  type LatLon,
  type PriceSettings,
  type ShownCell,
} from './prix.ts';

export type ZoneLevel = 'commune' | 'quartier';

export interface ZoneInput {
  level: unknown;
  /** Pour un quartier : l'identifiant de sa commune. */
  parentId?: unknown;
  slug: unknown;
  name: unknown;
  inseeCode?: unknown;
  ring: unknown;
  ringSource: unknown;
}

export type ZoneResult = { ok: true; id: string } | { ok: false; rule: 'R16' | 'R150'; code: string };

export type RecomputeResult =
  | { ran: false; reason: 'dvf_non_couvert' | 'aucune_zone' | 'deja_fait' | 'source_incomplete'; versionId?: string }
  | { ran: true; versionId: string; published: number; carried: number; held: number };

/** Une case montrée au public : chiffres regroupés, source et date [R150, R151]. Rien d'autre. */
export interface PublicCell {
  zone: { slug: string; name: string; level: ZoneLevel };
  kind: EstimatedKind;
  status: Exclude<CellStatus, 'retenue'>;
  sales: number;
  median: number;
  q1: number;
  q3: number;
  /** Source des chiffres et date de la dernière vente de leur publication DVF. */
  source: string;
  dvfLastSale: string;
  period: { from: string; to: string };
}

/** Une case non montrée : seulement sa raison, sans aucun chiffre. */
export interface HeldCell {
  zone: { slug: string; name: string; level: ZoneLevel };
  kind: EstimatedKind;
  reason: HoldReason;
}

export interface CommunePrices {
  versionId: string;
  computedAt: string;
  cells: PublicCell[];
  held: HeldCell[];
}

export interface PrixRegroupesOptions {
  now?: () => Date;
  settings?: Partial<PriceSettings>;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RING = 2000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** L'empreinte d'une vente, stable d'une publication DVF à l'autre. */
export function saleFingerprint(sale: Sale): Promise<string> {
  return sha256Hex([sale.kind, sale.lat.toFixed(6), sale.lon.toFixed(6), sale.surface, sale.pricePerM2, sale.month].join('|'));
}

function parseRing(value: unknown): LatLon[] | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_RING) return null;
  const out: LatLon[] = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [lat, lon] = p as unknown[];
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    out.push([lat, lon]);
  }
  return out;
}

interface ZoneRow {
  id: string;
  level: ZoneLevel;
  parent_id: string | null;
  slug: string;
  name: string;
  ring_json: string;
}

export class PrixRegroupes {
  private readonly now: () => Date;
  private readonly settings: PriceSettings;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly sales: PriceSalesSource,
    options: PrixRegroupesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.settings = { ...DEFAULT_PRICE_SETTINGS, ...options.settings };
    if (!Number.isInteger(this.settings.minSales) || this.settings.minSales < 2) throw new Error('minSales : 2 au moins');
    if (!Number.isInteger(this.settings.roundTo) || this.settings.roundTo < 1) throw new Error('roundTo : 1 au moins');
    if (!Number.isInteger(this.settings.windowMonths) || this.settings.windowMonths < 1) throw new Error('windowMonths : 1 au moins');
  }

  /** Une zone tracée par la direction, avec la source de son contour. Rien ne se réécrit : une erreur se corrige par une nouvelle zone. */
  async defineZone(viewer: Viewer, input: ZoneInput): Promise<ZoneResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'price_zones', code: 'role' } },
        this.now,
      );
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const refuse = async (code: string): Promise<ZoneResult> => {
      await appendEvent(this.journal, { type: 'attirer.zone.refuse', actor, subject: `network:${viewer.networkId}`, data: { rule: 'R150', code } }, this.now);
      return { ok: false, rule: 'R150', code };
    };
    if (input.level !== 'commune' && input.level !== 'quartier') return refuse('niveau');
    if (typeof input.slug !== 'string' || input.slug.length > 80 || !SLUG.test(input.slug)) return refuse('slug');
    if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 120) return refuse('nom');
    if (typeof input.ringSource !== 'string' || input.ringSource.trim().length === 0 || input.ringSource.length > 200) return refuse('source');
    const ring = parseRing(input.ring);
    if (!ring) return refuse('contour');
    let parentId: string | null = null;
    let insee: string | null = null;
    if (input.level === 'commune') {
      if (input.parentId !== undefined && input.parentId !== null) return refuse('parent');
      if (typeof input.inseeCode !== 'string' || !/^(\d{5}|2[AB]\d{3})$/.test(input.inseeCode)) return refuse('insee');
      insee = input.inseeCode;
    } else {
      if (input.inseeCode !== undefined && input.inseeCode !== null) return refuse('insee');
      if (typeof input.parentId !== 'string') return refuse('parent');
      const parent = await this.db.first<{ id: string }>(
        "SELECT id FROM price_zones WHERE id = ? AND network_id = ? AND level = 'commune'",
        [input.parentId, viewer.networkId],
      );
      if (!parent) return refuse('parent');
      parentId = parent.id;
    }
    // Parmi les zones en service : une commune contre les autres communes, un quartier contre ceux de sa commune.
    const siblings = (await this.activeZones(viewer.networkId)).filter((z) => (parentId === null ? z.level === 'commune' : z.parent_id === parentId));
    if (siblings.some((z) => z.slug === input.slug)) return refuse('slug_pris');
    // Deux zones qui se recouvrent compteraient deux fois les mêmes ventes, sans le dire [R150].
    if (siblings.some((z) => ringsOverlap(ring, JSON.parse(z.ring_json) as LatLon[]))) return refuse('chevauchement');
    const id = crypto.randomUUID();
    await this.db.run(
      'INSERT INTO price_zones (id, network_id, level, parent_id, slug, label, insee_code, ring_json, ring_source, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, input.level, parentId, input.slug, input.name.trim(), insee, JSON.stringify(ring), input.ringSource.trim(), actor, this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'attirer.zone.tracee', actor, subject: `price_zone:${id}`, data: { level: input.level } }, this.now);
    return { ok: true, id };
  }

  /** Retire une zone (et, pour une commune, ses quartiers) des versions suivantes ; rien ne s'efface. */
  async retireZone(viewer: Viewer, zoneId: unknown): Promise<ZoneResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'price_zones', code: 'role' } },
        this.now,
      );
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const zone = typeof zoneId === 'string' ? await this.db.first<{ id: string }>('SELECT id FROM price_zones WHERE id = ? AND network_id = ?', [zoneId, viewer.networkId]) : null;
    if (!zone) return { ok: false, rule: 'R150', code: 'zone' };
    await this.db.run('INSERT OR IGNORE INTO price_zone_retirements (area_id, retired_by, retired_at) VALUES (?, ?, ?)', [zone.id, actor, this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'attirer.zone.retiree', actor, subject: `price_zone:${zone.id}`, data: { rule: 'R150' } }, this.now);
    return { ok: true, id: zone.id };
  }

  /** Les zones en service : ni retirées, ni quartiers d'une commune retirée. */
  private async activeZones(networkId: string): Promise<ZoneRow[]> {
    return this.db.all<ZoneRow>(
      `SELECT z.id, z.level, z.parent_id, z.slug, z.label AS name, z.ring_json FROM price_zones z
        WHERE z.network_id = ?
          AND z.id NOT IN (SELECT area_id FROM price_zone_retirements)
          AND (z.parent_id IS NULL OR z.parent_id NOT IN (SELECT area_id FROM price_zone_retirements))
        ORDER BY z.id`,
      [networkId],
    );
  }

  /**
   * Calcule la version de la publication DVF en cours, si elle n'existe pas encore : à lancer par le planificateur,
   * autant de fois qu'on veut. Tout est lu et décidé avant d'écrire : une lecture incomplète de la source n'écrit rien
   * et le dit au journal ; une version coupée en route est refaite à l'identique (même lecture, même identifiant),
   * une lecture différente donne une autre version.
   */
  async recompute(networkId: string): Promise<RecomputeResult> {
    const coverage = await this.sales.coverage();
    if (!coverage || !/^\d{4}-\d{2}-\d{2}$/.test(coverage.lastSale)) return { ran: false, reason: 'dvf_non_couvert' };
    const zones = await this.activeZones(networkId);
    const communes = zones.filter((z) => z.level === 'commune');
    if (communes.length === 0) return { ran: false, reason: 'aucune_zone' };
    const zonesHash = await sha256Hex(JSON.stringify(zones.map((z) => [z.id, z.parent_id, z.ring_json])));
    const window = windowOf(coverage.lastSale, this.settings.windowMonths);
    // Tout réglage qui change les chiffres fait partie de l'identité d'une version : période, seuil, arrondi.
    const done = await this.db.first<{ id: string }>(
      "SELECT id FROM price_versions WHERE network_id = ? AND source = ? AND dvf_last_sale = ? AND areas_digest = ? AND window_from = ? AND min_sales = ? AND round_to = ? AND status = 'complet' ORDER BY completed_at DESC LIMIT 1",
      [networkId, coverage.source, coverage.lastSale, zonesHash, window.from, this.settings.minSales, this.settings.roundTo],
    );
    if (done) return { ran: false, reason: 'deja_fait', versionId: done.id };

    // 1. Lire toutes les ventes, chacune dans une seule commune (la première qui la contient) et un seul quartier.
    const blocks: { communeId: string; kind: EstimatedKind; communeSales: CellSale[]; quarters: { zoneId: string; sales: CellSale[] }[] }[] = [];
    let issues = 0;
    const fingerprints: string[] = [];
    for (const kind of PRICE_KINDS) {
      const taken = new Set<string>();
      for (const commune of communes) {
        const ring = JSON.parse(commune.ring_json) as LatLon[];
        const quarterZones = zones.filter((z) => z.parent_id === commune.id).map((z) => ({ id: z.id, ring: JSON.parse(z.ring_json) as LatLon[] }));
        const lat = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
        const lon = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
        const radius = Math.max(...ring.map((p) => distance(lat, lon, p[0], p[1]))) + 1;
        const read = this.sales.scan ? await this.sales.scan(kind, lat, lon, radius) : { sales: await this.sales.within(kind, lat, lon, radius), issues: 0 };
        issues += read.issues;
        const found = read.sales.filter(
          (x) => x.kind === kind && !taken.has(x.id) && x.month >= window.from && x.month <= window.to && insideRing([x.lat, x.lon], ring),
        );
        const communeSales: CellSale[] = [];
        const quarters = quarterZones.map((q) => ({ zoneId: q.id, sales: [] as CellSale[] }));
        for (const x of found) {
          taken.add(x.id);
          const sale = { fingerprint: await saleFingerprint(x), pricePerM2: x.pricePerM2 };
          fingerprints.push(`${kind}:${commune.id}:${sale.fingerprint}`);
          communeSales.push(sale);
          // Une vente va au premier quartier qui la contient : les quartiers publiés ne se recouvrent jamais.
          const at = quarterZones.findIndex((z) => insideRing([x.lat, x.lon], z.ring));
          if (at >= 0) quarters[at]!.sales.push(sale);
        }
        blocks.push({ communeId: commune.id, kind, communeSales, quarters });
      }
    }
    if (issues > 0) {
      await appendEvent(
        this.journal,
        { type: 'attirer.prix.incomplet', actor: 'system:prix', subject: `network:${networkId}`, data: { rule: 'R150', dvfLastSale: coverage.lastSale, issues } },
        this.now,
      );
      return { ran: false, reason: 'source_incomplete' };
    }
    const salesDigest = await sha256Hex(fingerprints.sort().join('\n'));
    // En lettres seulement : une suite de chiffres dans un identifiant passerait pour un numéro au journal.
    const versionId = (await sha256Hex(['price', networkId, coverage.source, coverage.lastSale, zonesHash, salesDigest, window.from, this.settings.minSales, this.settings.roundTo].join('|')))
      .slice(0, 32)
      .replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]!);

    // 2. Décider, contre toutes les cases montrées par la version précédente.
    const previousId = (
      await this.db.first<{ id: string }>(
        "SELECT id FROM price_versions WHERE network_id = ? AND status = 'complet' AND id <> ? ORDER BY completed_at DESC, id DESC LIMIT 1",
        [networkId, versionId],
      )
    )?.id ?? null;
    const previousCells = previousId ? await this.shownCells(previousId) : [];
    const decided: { kind: EstimatedKind; d: CellDecision }[] = [];
    for (const block of blocks) {
      const ids = new Set([block.communeId, ...block.quarters.map((q) => q.zoneId)]);
      const sameKind = previousCells.filter((p) => p.kind === block.kind);
      const prints = new Set(block.communeSales.map((x) => x.fingerprint));
      const previous = sameKind.filter((p) => ids.has(p.cell.zoneId)).map((p) => p.cell);
      const related = sameKind.filter((p) => !ids.has(p.cell.zoneId) && [...p.cell.set.keys()].some((f) => prints.has(f))).map((p) => p.cell);
      for (const d of decideBlock({ communeId: block.communeId, communeSales: block.communeSales, quarters: block.quarters, previous, related }, versionId, this.settings)) {
        decided.push({ kind: block.kind, d });
      }
    }

    // 3. Écrire ; une reprise après coupure réécrit exactement les mêmes lignes.
    const existing = await this.db.first<{ status: string }>('SELECT status FROM price_versions WHERE id = ?', [versionId]);
    if (!existing) {
      await this.db.run(
        "INSERT INTO price_versions (id, network_id, source, dvf_last_sale, window_from, window_to, areas_digest, sales_digest, min_sales, round_to, status, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'en_cours', ?)",
        [versionId, networkId, coverage.source, coverage.lastSale, window.from, window.to, zonesHash, salesDigest, this.settings.minSales, this.settings.roundTo, this.now().toISOString()],
      );
    }
    let published = 0;
    let carried = 0;
    let held = 0;
    for (const { kind, d } of decided) {
      const f = d.figures;
      await this.db.run(
        'INSERT OR IGNORE INTO price_cells (version_id, area_id, kind, status, hold_code, sales_count, median_m2, q1_m2, q3_m2, from_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [versionId, d.zoneId, kind, d.status, d.reason, f?.sales ?? null, f?.median ?? null, f?.q1 ?? null, f?.q3 ?? null, d.fromVersion],
      );
      if (d.status === 'publiee' && d.set) {
        for (const [fp, n] of d.set) {
          await this.db.run('INSERT OR IGNORE INTO price_cell_sales (version_id, area_id, kind, fingerprint, n) VALUES (?, ?, ?, ?, ?)', [versionId, d.zoneId, kind, fp, n]);
        }
      }
      if (d.status === 'publiee') published++;
      else if (d.status === 'reprise') carried++;
      else held++;
    }
    await this.db.run("UPDATE price_versions SET status = 'complet', completed_at = ? WHERE id = ? AND status = 'en_cours'", [this.now().toISOString(), versionId]);
    await appendEvent(
      this.journal,
      {
        type: 'attirer.prix.version',
        actor: 'system:prix',
        subject: `price_version:${versionId}`,
        data: { rule: 'R150', dvfLastSale: coverage.lastSale, previous: previousId, published, carried, held },
      },
      this.now,
    );
    return { ran: true, versionId, published, carried, held };
  }

  /** Les cases montrées par une version, avec leur ensemble de ventes (celui de la version d'origine pour une reprise). */
  private async shownCells(versionId: string): Promise<{ kind: EstimatedKind; cell: ShownCell }[]> {
    const cells = await this.db.all<{ area_id: string; kind: EstimatedKind; sales_count: number; median_m2: number; q1_m2: number; q3_m2: number; from_version_id: string }>(
      "SELECT area_id, kind, sales_count, median_m2, q1_m2, q3_m2, from_version_id FROM price_cells WHERE version_id = ? AND status <> 'retenue' ORDER BY area_id, kind",
      [versionId],
    );
    const out: { kind: EstimatedKind; cell: ShownCell }[] = [];
    for (const c of cells) {
      const rows = await this.db.all<{ fingerprint: string; n: number }>(
        'SELECT fingerprint, n FROM price_cell_sales WHERE version_id = ? AND area_id = ? AND kind = ?',
        [c.from_version_id, c.area_id, c.kind],
      );
      const figures: CellFigures = { sales: c.sales_count, median: c.median_m2, q1: c.q1_m2, q3: c.q3_m2 };
      out.push({ kind: c.kind, cell: { zoneId: c.area_id, set: new Map(rows.map((r) => [r.fingerprint, r.n])), figures, fromVersion: c.from_version_id } });
    }
    return out;
  }

  /** Les versions complètes d'un réseau, de la plus récente à la plus ancienne. */
  async versions(networkId: string): Promise<{ id: string; dvfLastSale: string; source: string; completedAt: string }[]> {
    const rows = await this.db.all<{ id: string; dvf_last_sale: string; source: string; completed_at: string }>(
      "SELECT id, dvf_last_sale, source, completed_at FROM price_versions WHERE network_id = ? AND status = 'complet' ORDER BY completed_at DESC, id DESC",
      [networkId],
    );
    return rows.map((r) => ({ id: r.id, dvfLastSale: r.dvf_last_sale, source: r.source, completedAt: r.completed_at }));
  }

  /**
   * Les prix publics d'une commune et de ses quartiers, pour une version (la dernière complète par défaut) : seulement
   * des cases montrables, chacune avec sa source et sa date [R150, R151]. `null` si la commune ou la version manque.
   */
  async communePrices(networkId: string, communeSlug: string, versionId?: string): Promise<CommunePrices | null> {
    const version = await this.db.first<{ id: string; completed_at: string }>(
      versionId === undefined
        ? "SELECT id, completed_at FROM price_versions WHERE network_id = ? AND status = 'complet' ORDER BY completed_at DESC, id DESC LIMIT 1"
        : "SELECT id, completed_at FROM price_versions WHERE network_id = ? AND status = 'complet' AND id = ?",
      versionId === undefined ? [networkId] : [networkId, versionId],
    );
    if (!version) return null;
    // La commune de ce nom calculée par cette version (une commune retirée garde ses versions passées).
    const commune = await this.db.first<{ id: string }>(
      `SELECT z.id FROM price_zones z JOIN price_cells c ON c.area_id = z.id AND c.version_id = ?
        WHERE z.network_id = ? AND z.level = 'commune' AND z.slug = ? LIMIT 1`,
      [version.id, networkId, communeSlug],
    );
    if (!commune) return null;
    const rows = await this.db.all<{
      slug: string;
      name: string;
      level: ZoneLevel;
      kind: EstimatedKind;
      status: CellStatus;
      reason: HoldReason | null;
      sales_count: number | null;
      median_m2: number | null;
      q1_m2: number | null;
      q3_m2: number | null;
      source: string | null;
      dvf_last_sale: string | null;
      window_from: string | null;
      window_to: string | null;
    }>(
      `SELECT z.slug, z.label AS name, z.level, c.kind, c.status, c.hold_code AS reason, c.sales_count, c.median_m2, c.q1_m2, c.q3_m2,
              o.source, o.dvf_last_sale, o.window_from, o.window_to
         FROM price_cells c
         JOIN price_zones z ON z.id = c.area_id
         LEFT JOIN price_versions o ON o.id = c.from_version_id
        WHERE c.version_id = ? AND (z.id = ? OR z.parent_id = ?)
        ORDER BY z.level, z.slug, c.kind`,
      [version.id, commune.id, commune.id],
    );
    const cells: PublicCell[] = [];
    const held: HeldCell[] = [];
    for (const r of rows) {
      const zone = { slug: r.slug, name: r.name, level: r.level };
      if (r.status === 'retenue') {
        held.push({ zone, kind: r.kind, reason: r.reason! });
        continue;
      }
      // Une case montrée a toujours au moins le seuil de sa version : contrôlé encore ici, au cas où [R150].
      if (r.sales_count === null || r.sales_count < this.settings.minSales || r.source === null) {
        held.push({ zone, kind: r.kind, reason: 'seuil' });
        continue;
      }
      cells.push({
        zone,
        kind: r.kind,
        status: r.status,
        sales: r.sales_count,
        median: r.median_m2!,
        q1: r.q1_m2!,
        q3: r.q3_m2!,
        source: r.source,
        dvfLastSale: r.dvf_last_sale!,
        period: { from: r.window_from!, to: r.window_to! },
      });
    }
    return { versionId: version.id, computedAt: version.completed_at, cells, held };
  }
}
