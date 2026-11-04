/**
 * Accès à un dossier de vente (M10) [R16].
 *
 * Un dossier se voit en entier quand son bien se voit en entier : l'agent du bien, la direction, la conformité. Seul
 * l'agent du bien y écrit. Chaque refus est écrit au journal sous le dossier, en plus de ce que le contrôle d'accès
 * écrit sous le bien.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export type PropertyKind = 'home' | 'land' | 'building' | 'commercial' | 'business_walls' | 'business';

export interface SaleFileRow {
  id: string;
  network_id: string;
  property_id: string;
  offer_id: string;
  buyer_person_id: string;
}

export type FileRefusal = { ok: false; rule: 'R16'; code: string };
export type FileUnknown = { ok: false; rule: null; code: 'unknown_file' | 'file_stopped' };
export type FileGate = { ok: true; file: SaleFileRow; kind: PropertyKind; agentId: string | null } | FileRefusal | FileUnknown;

/** La condition SQL d'un dossier encore ouvert : il n'a pas d'arrêt [R233]. `f` est l'alias de `sale_files`. */
export const openFile = (f: string): string => `NOT EXISTS (SELECT 1 FROM sale_file_stops stop_ WHERE stop_.file_id = ${f}.id)`;

export const actorOf = (viewer: Viewer): string => `${String(viewer.role)}:${viewer.userId}`;

export async function refuseFile(journal: JournalStore, now: () => Date, viewer: Viewer, fileId: string, kind: string, code: string): Promise<FileRefusal> {
  await appendEvent(journal, { type: 'acces.refuse', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, now);
  return { ok: false, rule: 'R16', code };
}

/** Le dossier, s'il est visible en entier ; `write` : seul l'agent du bien. `kind` nomme ce qui est demandé, au journal. */
export async function gateSaleFile(
  deps: { db: SqlDatabase; acces: Acces; journal: JournalStore; now: () => Date },
  viewer: Viewer,
  fileId: string,
  write: boolean,
  kind: string,
): Promise<FileGate> {
  const file = await deps.db.first<SaleFileRow>('SELECT id, network_id, property_id, offer_id, buyer_person_id FROM sale_files WHERE id = ?', [fileId]);
  if (!file || file.network_id !== viewer.networkId) {
    await refuseFile(deps.journal, deps.now, viewer, fileId, kind, 'unknown');
    return { ok: false, rule: null, code: 'unknown_file' };
  }
  const p = await deps.acces.readProperty(viewer, file.property_id);
  if (!p.ok) {
    await refuseFile(deps.journal, deps.now, viewer, fileId, kind, p.code);
    return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_file' } : { ok: false, rule: 'R16', code: p.code };
  }
  if (p.view !== 'full') return refuseFile(deps.journal, deps.now, viewer, fileId, kind, 'not_assigned');
  if (write && (viewer.role !== 'agent' || viewer.userId !== p.value.agent_id)) return refuseFile(deps.journal, deps.now, viewer, fileId, kind, 'role');
  // Un dossier arrêté reste lisible et ne reçoit plus rien [R233].
  if (write && (await deps.db.first('SELECT 1 FROM sale_file_stops WHERE file_id = ?', [fileId]))) return { ok: false, rule: null, code: 'file_stopped' };
  return { ok: true, file, kind: p.value.kind as PropertyKind, agentId: p.value.agent_id };
}
