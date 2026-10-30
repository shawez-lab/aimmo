/**
 * Le plan simple du logement (M19, X04) [R135].
 *
 * L'agent saisit sur place des pièces rectangulaires : la sorte de pièce, prise dans une liste fermée (aucun texte
 * libre, donc ni adresse ni nom sur le plan [R46]), sa position et ses cotes en centimètres entiers. Le code refuse
 * une cote absente ou impossible, et deux pièces qui se chevauchent [R10]. Il calcule les surfaces, au cm² près, et
 * dessine le plan en SVG, avec toujours la mention « Plan indicatif, non contractuel ». Rien n'est saisi en surface.
 *
 * Les saisies sont versionnées. Lecture sous les droits du bien, saisie par l'agent du bien ou la direction [R16].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { PALETTE, POLICES } from '../design/systeme.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const PLAN_MENTION = 'Plan indicatif, non contractuel';

/** Les sortes de pièces, liste fermée. `inside` : comptée dans la surface des pièces ; sinon, annexe. */
export const ROOM_KINDS = Object.freeze({
  entree: { label: 'Entrée', inside: true },
  sejour: { label: 'Séjour', inside: true },
  cuisine: { label: 'Cuisine', inside: true },
  chambre: { label: 'Chambre', inside: true },
  salle_d_eau: { label: 'Salle d’eau', inside: true },
  salle_de_bains: { label: 'Salle de bains', inside: true },
  wc: { label: 'WC', inside: true },
  bureau: { label: 'Bureau', inside: true },
  degagement: { label: 'Dégagement', inside: true },
  dressing: { label: 'Dressing', inside: true },
  cellier: { label: 'Cellier', inside: true },
  buanderie: { label: 'Buanderie', inside: true },
  balcon: { label: 'Balcon', inside: false },
  terrasse: { label: 'Terrasse', inside: false },
  garage: { label: 'Garage', inside: false },
  cave: { label: 'Cave', inside: false },
} as const);
export type RoomKind = keyof typeof ROOM_KINDS;

export interface PlanRoom {
  kind: RoomKind;
  xCm: number;
  yCm: number;
  widthCm: number;
  depthCm: number;
}

export interface PlanRoomOut extends PlanRoom {
  label: string;
  inside: boolean;
  areaCm2: number;
  /** La surface dite en m², arrondie au centième, en français : `12,35 m²`. */
  area: string;
}

export interface FloorPlan {
  propertyId: string;
  version: number;
  rooms: PlanRoomOut[];
  /** La somme des pièces, annexes à part. */
  insideCm2: number;
  annexCm2: number;
  inside: string;
  annex: string;
  /** L'écart avec la surface de la fiche du bien, en points de pourcentage, quand elle est connue. */
  gapWithSheet: { sheetM2: number; percent: number; warn: boolean } | null;
  mention: typeof PLAN_MENTION;
  svg: string;
  createdAt: string;
}

export type PlanCheck = { ok: true; value: PlanRoom[] } | { ok: false; code: 'pieces_invalides' | 'sorte_inconnue' | 'cote_absente' | 'cote_impossible' | 'chevauchement'; index: number | null };

const MIN_SIDE = 50;
const MAX_SIDE = 3000;
const MAX_POS = 10_000;
const MAX_ROOMS = 40;
const KEYS = ['kind', 'xCm', 'yCm', 'widthCm', 'depthCm'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Contrôle la saisie : sortes connues, cotes entières et possibles, aucun chevauchement [R10]. */
export function checkRooms(input: unknown): PlanCheck {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ROOMS) return { ok: false, code: 'pieces_invalides', index: null };
  const rooms: PlanRoom[] = [];
  for (const [i, r] of input.entries()) {
    if (!isRecord(r) || Object.keys(r).some((k) => !KEYS.includes(k))) return { ok: false, code: 'pieces_invalides', index: i };
    if (typeof r.kind !== 'string' || !Object.hasOwn(ROOM_KINDS, r.kind)) return { ok: false, code: 'sorte_inconnue', index: i };
    for (const k of ['xCm', 'yCm', 'widthCm', 'depthCm']) if (r[k] === undefined || r[k] === null || r[k] === '') return { ok: false, code: 'cote_absente', index: i };
    const [x, y, w, d] = [r.xCm, r.yCm, r.widthCm, r.depthCm];
    const int = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
    if (!int(x, 0, MAX_POS) || !int(y, 0, MAX_POS) || !int(w, MIN_SIDE, MAX_SIDE) || !int(d, MIN_SIDE, MAX_SIDE)) return { ok: false, code: 'cote_impossible', index: i };
    rooms.push({ kind: r.kind as RoomKind, xCm: x as number, yCm: y as number, widthCm: w as number, depthCm: d as number });
  }
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const a = rooms[i]!;
      const b = rooms[j]!;
      // Des pièces qui se touchent par un mur sont admises ; qui se recouvrent, non.
      if (a.xCm < b.xCm + b.widthCm && b.xCm < a.xCm + a.widthCm && a.yCm < b.yCm + b.depthCm && b.yCm < a.yCm + a.depthCm) return { ok: false, code: 'chevauchement', index: i };
    }
  }
  return { ok: true, value: rooms };
}

/** Des cm² en m², au centième, en français, sans passer par un nombre à virgule. */
export function formatM2(cm2: number): string {
  const hundredths = Math.round(cm2 / 100);
  const units = Math.floor(hundredths / 100);
  const rest = hundredths % 100;
  return `${units.toLocaleString('fr-FR').replace(/[  ]/g, ' ')},${String(rest).padStart(2, '0')} m²`;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Les pièces avec leurs libellés numérotés et leurs surfaces, calculées par le code [R135]. */
export function describeRooms(rooms: readonly PlanRoom[]): PlanRoomOut[] {
  const counts = new Map<RoomKind, number>();
  for (const r of rooms) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const seen = new Map<RoomKind, number>();
  return rooms.map((r) => {
    const n = (seen.get(r.kind) ?? 0) + 1;
    seen.set(r.kind, n);
    const areaCm2 = r.widthCm * r.depthCm;
    const spec = ROOM_KINDS[r.kind];
    return { ...r, label: (counts.get(r.kind) ?? 0) > 1 ? `${spec.label} ${n}` : spec.label, inside: spec.inside, areaCm2, area: formatM2(areaCm2) };
  });
}

/** Le plan dessiné : une pièce par rectangle, son nom et sa surface, l'échelle, et toujours la mention [R135]. */
export function drawPlan(rooms: readonly PlanRoomOut[], totals: { inside: string; annex: string; annexCm2: number }): string {
  const c = PALETTE.clair;
  const minX = Math.min(...rooms.map((r) => r.xCm));
  const minY = Math.min(...rooms.map((r) => r.yCm));
  const maxX = Math.max(...rooms.map((r) => r.xCm + r.widthCm));
  const maxY = Math.max(...rooms.map((r) => r.yCm + r.depthCm));
  const pad = 40;
  // 1 cm saisi = 0,5 unité de dessin : un logement de 15 m tient en 750 unités, lisible sur téléphone par le viewBox.
  const k = 0.5;
  const drawnW = Math.round((maxX - minX) * k);
  const drawnH = Math.round((maxY - minY) * k);
  const w = Math.max(drawnW + pad * 2, 480);
  // Sous le dessin : l'échelle, la liste des pièces et leurs surfaces (lisible même quand une pièce est petite), les
  // totaux et la mention.
  const lineH = 26;
  const footer = 40 + rooms.length * lineH + 16 + 3 * lineH + 8;
  const h = drawnH + pad * 2 + footer;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="plan-titre plan-desc" font-family="${esc(POLICES.texte)}">`);
  parts.push(`<title id="plan-titre">${esc(PLAN_MENTION)}</title>`);
  parts.push(`<desc id="plan-desc">${esc(`${rooms.length} pièce${rooms.length > 1 ? 's' : ''} : ${rooms.map((r) => `${r.label}, ${r.area}`).join(' ; ')}. Surface des pièces : ${totals.inside}.`)}</desc>`);
  parts.push(`<rect width="${w}" height="${h}" fill="${c.surface}"/>`);
  const ox = Math.round((w - drawnW) / 2);
  for (const r of rooms) {
    const x = Math.round((r.xCm - minX) * k) + ox;
    const y = Math.round((r.yCm - minY) * k) + pad;
    const rw = Math.round(r.widthCm * k);
    const rh = Math.round(r.depthCm * k);
    const fill = r.inside ? c.papier : c.surface;
    const dash = r.inside ? '' : ' stroke-dasharray="8 6"';
    parts.push(`<g><rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${fill}" stroke="${c.encre}" stroke-width="${r.inside ? 5 : 3}"${dash}/>`);
    const cx = x + rw / 2;
    const cy = y + rh / 2;
    // Le nom, puis la surface, seulement s'ils tiennent dans la pièce ; la liste sous le plan dit tout de toute façon.
    const size = Math.min(22, Math.floor((rw - 12) / (r.label.length * 0.62)), Math.floor(rh / 2.8));
    if (size >= 12) {
      const small = size - 4;
      const areaFits = small >= 11 && r.area.length * 0.6 * small <= rw - 12 && rh >= size * 2.8;
      parts.push(`<text x="${cx}" y="${areaFits ? cy - size * 0.2 : cy + size * 0.35}" text-anchor="middle" font-size="${size}" font-weight="600" fill="${c.encre}">${esc(r.label)}</text>`);
      if (areaFits) parts.push(`<text x="${cx}" y="${cy + size * 1.1}" text-anchor="middle" font-size="${small}" fill="${c.doux}">${esc(r.area)}</text>`);
    }
    parts.push('</g>');
  }
  let y = drawnH + pad * 2 + 4;
  // L'échelle : un trait d'un mètre.
  parts.push(`<g fill="${c.encre}" stroke="${c.encre}"><line x1="${pad}" y1="${y}" x2="${pad + 100 * k}" y2="${y}" stroke-width="3"/><text x="${pad + 100 * k + 8}" y="${y + 5}" font-size="14" stroke="none">1 m</text></g>`);
  y += 36;
  for (const r of rooms) {
    parts.push(`<text x="${pad}" y="${y}" font-size="16" fill="${c.encre}">${esc(r.label)}${r.inside ? '' : ' (annexe)'}</text><text x="${w - pad}" y="${y}" font-size="16" text-anchor="end" fill="${c.encre}">${esc(r.area)}</text>`);
    y += lineH;
  }
  parts.push(`<line x1="${pad}" y1="${y - 14}" x2="${w - pad}" y2="${y - 14}" stroke="${c.trait}" stroke-width="2"/>`);
  y += 6;
  parts.push(`<text x="${pad}" y="${y}" font-size="16" font-weight="700" fill="${c.encre}">Surface des pièces</text><text x="${w - pad}" y="${y}" font-size="16" font-weight="700" text-anchor="end" fill="${c.encre}">${esc(totals.inside)}</text>`);
  y += lineH;
  const annex = totals.annexCm2 > 0 ? `Annexes ${totals.annex} · calculées depuis les cotes saisies` : 'Calculée depuis les cotes saisies';
  parts.push(`<text x="${pad}" y="${y}" font-size="14" fill="${c.doux}">${esc(annex)}</text>`);
  y += lineH;
  parts.push(`<text x="${pad}" y="${y}" font-size="16" font-weight="700" fill="${c.accent}">${esc(PLAN_MENTION)}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

export type PlanResult<T> = { ok: true; value: T } | { ok: false; rule: 'R16' | 'R10'; code: string; index?: number | null };

export interface PlanLogementOptions {
  now?: () => Date;
  newId?: () => string;
}

interface PlanRow {
  version: number;
  rooms: string;
  created_at: string;
}

export class PlanLogement {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: PlanLogementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Le dernier plan du bien, pour qui voit le bien en entier [R16] ; null s'il n'y en a pas encore. */
  async current(viewer: Viewer, propertyId: string): Promise<PlanResult<FloorPlan | null>> {
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    const row = await this.db.first<PlanRow>('SELECT version, rooms, created_at FROM floor_plans WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    return { ok: true, value: row ? this.build(propertyId, row, seen.value.surfaceM2) : null };
  }

  /** L'agent du bien, ou la direction, range une saisie : elle devient une nouvelle version. */
  async save(viewer: Viewer, propertyId: string, input: { rooms: unknown }): Promise<PlanResult<FloorPlan>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    const actor = `${viewer.role}:${viewer.userId}`;
    const checked = checkRooms(isRecord(input) ? input.rooms : undefined);
    if (!checked.ok) {
      await appendEvent(this.journal, { type: 'studio.plan.refuse', actor, subject: `property:${propertyId}`, data: { rule: 'R10', code: checked.code } }, this.now);
      return { ok: false, rule: 'R10', code: checked.code, index: checked.index };
    }
    const rooms = JSON.stringify(checked.value);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM floor_plans WHERE property_id = ?', [propertyId]);
      const version = (last?.v ?? 0) + 1;
      const at = this.now().toISOString();
      const { changes } = await this.db.run(
        'INSERT INTO floor_plans (id, property_id, network_id, version, rooms, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [this.newId(), propertyId, seen.value.networkId, version, rooms, actor, at],
      );
      if (changes === 1) {
        await appendEvent(this.journal, { type: 'studio.plan.version', actor, subject: `property:${propertyId}`, data: { version, rooms: checked.value.length } }, this.now);
        return { ok: true, value: this.build(propertyId, { version, rooms, created_at: at }, seen.value.surfaceM2) };
      }
    }
    return { ok: false, rule: 'R10', code: 'conflit_de_version' };
  }

  private build(propertyId: string, row: PlanRow, sheetM2: number | null): FloorPlan {
    const rooms = describeRooms(JSON.parse(row.rooms) as PlanRoom[]);
    const insideCm2 = rooms.filter((r) => r.inside).reduce((s, r) => s + r.areaCm2, 0);
    const annexCm2 = rooms.filter((r) => !r.inside).reduce((s, r) => s + r.areaCm2, 0);
    const inside = formatM2(insideCm2);
    const annex = formatM2(annexCm2);
    let gapWithSheet: FloorPlan['gapWithSheet'] = null;
    if (sheetM2 !== null && sheetM2 > 0 && insideCm2 > 0) {
      // En dixièmes de point, par des entiers : 1 m² = 10 000 cm².
      const tenths = Math.round(((insideCm2 - sheetM2 * 10_000) * 1000) / (sheetM2 * 10_000));
      gapWithSheet = { sheetM2, percent: tenths / 10, warn: Math.abs(tenths) > 50 };
    }
    return { propertyId, version: row.version, rooms, insideCm2, annexCm2, inside, annex, gapWithSheet, mention: PLAN_MENTION, svg: drawPlan(rooms, { inside, annex, annexCm2 }), createdAt: row.created_at };
  }

  private async full(viewer: Viewer, propertyId: string): Promise<PlanResult<{ networkId: string; surfaceM2: number | null }>> {
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    return { ok: true, value: { networkId: read.value.network_id, surfaceM2: read.value.surface_m2 } };
  }

  private async refused<T>(viewer: Viewer, propertyId: string, code: string): Promise<PlanResult<T>> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'floor_plan', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
