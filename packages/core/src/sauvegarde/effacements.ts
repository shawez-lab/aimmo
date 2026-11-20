/**
 * Le registre des effacements, et leur rejeu après une restauration (SV02) [R231, R17].
 *
 * Une copie garde ce qui a été effacé après elle. Restaurer sans rien de plus ferait revenir des personnes effacées. Le
 * registre vit donc hors de la base, à côté des copies : perdre la base ne le perd pas.
 *
 * Décidé, lecture prudente :
 * - une entrée ne porte que des identifiants et une date, chiffrés et liés à leur place ; aucun nom, aucune coordonnée ;
 * - sont refaits les effacements datés depuis l'instant de la copie, moins une heure : l'horloge du travail et celle du
 *   Worker peuvent différer, et refaire un effacement déjà fait ne change rien, alors qu'en oublier un est grave ;
 * - une entrée illisible refuse tout, avant le premier effacement : le registre ne se lit pas à moitié ;
 * - une restauration n'est dite finie qu'après le rejeu.
 *
 * L'effacement réel (AU020, `conformite/effacement-reel.ts`) écrit ce registre avant d'effacer, et `SqlPersonEraser` est
 * l'effaceur du rejeu ; il reste fermé tant que le Worker n'a pas le mode `reel` (H29). Son branchement au rejeu après
 * une restauration réelle est AU021.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import { SqlJournalStore } from '../journal/sql-store.ts';
import { openAt, restoreCopy, sealAt, type CopyKey, type CopyStore, type RestoreOutcome } from './copie.ts';

export const ERASURE_REPLAY_MARGIN_MS = 3_600_000;
const PREFIX = 'effacements/';

/** Le stockage du registre : celui des copies, qui sait en plus lister. */
export interface ErasureLedgerStore extends CopyStore {
  list(prefix: string): Promise<string[]>;
}

export interface ErasureEntry {
  requestId: string;
  networkId: string;
  personId: string;
  erasedAt: string;
  /**
   * Les fiches réunies de la personne au moment de l'effacement (AU020) : le rejeu efface ce périmètre, jamais celui
   * qu'une fusion défaite depuis et revenue avec la copie dirait. Absent dans les entrées d'avant : la fiche seule.
   */
  members?: string[];
}

/** La procédure réelle d'effacement, sans effet si tout est déjà effacé. Rend le nombre de lignes effacées. */
export interface PersonEraser {
  erase(db: SqlDatabase, entry: ErasureEntry): Promise<number>;
}

const validEntry = (e: Partial<ErasureEntry> | null): e is ErasureEntry =>
  !!e && [e.requestId, e.networkId, e.personId].every((v) => typeof v === 'string' && v !== '') && typeof e.erasedAt === 'string' && !Number.isNaN(Date.parse(e.erasedAt)) &&
  (e.members === undefined || (Array.isArray(e.members) && e.members.length > 0 && e.members.every((m) => typeof m === 'string' && m !== '') && e.members.includes(e.personId!)));

/** Note un effacement fait, au plus tôt : tant qu'il n'est pas noté, il n'est pas dit fait. */
export async function recordErasure(store: ErasureLedgerStore, key: CopyKey, entry: ErasureEntry): Promise<void> {
  if (!validEntry(entry)) throw new Error('Effacement mal décrit.');
  const stamp = new Date(entry.erasedAt).toISOString().replace(/[-:.]/g, '');
  const random = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const place = `${PREFIX}${stamp}-${random}`;
  await store.put(place, await sealAt(key, place, JSON.stringify(entry)));
}

export type ReplayOutcome = { ok: true; replayed: number; erasedRows: number } | { ok: false; code: 'ledger_unreadable' | 'erase_failed'; replayed: number };

/** Refait, dans une base restaurée, chaque effacement daté depuis la copie, du plus ancien au plus récent. */
export async function replayErasures(target: SqlDatabase, store: ErasureLedgerStore, key: CopyKey, eraser: PersonEraser, options: { copyTakenAt: string; now?: () => Date }): Promise<ReplayOutcome> {
  const entries: ErasureEntry[] = [];
  try {
    for (const place of await store.list(PREFIX)) {
      const bytes = await store.get(place);
      const text = bytes && (await openAt(key, place, bytes));
      if (!text) return { ok: false, code: 'ledger_unreadable', replayed: 0 };
      const entry = JSON.parse(text) as Partial<ErasureEntry>;
      if (!validEntry(entry)) return { ok: false, code: 'ledger_unreadable', replayed: 0 };
      entries.push(entry);
    }
  } catch {
    return { ok: false, code: 'ledger_unreadable', replayed: 0 };
  }
  const since = Date.parse(options.copyTakenAt) - ERASURE_REPLAY_MARGIN_MS;
  const due = entries.filter((e) => Date.parse(e.erasedAt) >= since).sort((a, b) => Date.parse(a.erasedAt) - Date.parse(b.erasedAt));
  const journal = new SqlJournalStore(target);
  const now = options.now ?? (() => new Date());
  let erasedRows = 0;
  let replayed = 0;
  for (const entry of due) {
    try {
      erasedRows += await eraser.erase(target, entry);
      await appendEvent(journal, { type: 'rgpd.effacement_rejoue', actor: 'system:sauvegarde', subject: `person:${entry.personId}`, data: { rule: 'R231', requestId: entry.requestId } }, now);
    } catch {
      // L'erreur peut citer une ligne : elle ne sort pas.
      return { ok: false, code: 'erase_failed', replayed };
    }
    replayed += 1;
  }
  return { ok: true, replayed, erasedRows };
}

export type FullRestoreOutcome =
  | (Extract<RestoreOutcome, { ok: true }> & { erasuresReplayed: number })
  | Extract<RestoreOutcome, { ok: false }>
  | { ok: false; code: 'erasures_not_replayed'; cause: 'ledger_unreadable' | 'erase_failed'; replayed: number };

/** La restauration entière : la copie, sa preuve, puis les effacements. Sans le rejeu, elle n'est pas dite finie. */
export async function restoreWithErasures(target: SqlDatabase, store: ErasureLedgerStore, key: CopyKey, copyId: string, eraser: PersonEraser, options: { clock?: () => number; now?: () => Date } = {}): Promise<FullRestoreOutcome> {
  const restored = await restoreCopy(target, store, key, copyId, options.clock ? { clock: options.clock } : {});
  if (!restored.ok) return restored;
  const replay = await replayErasures(target, store, key, eraser, { copyTakenAt: restored.takenAt, ...(options.now ? { now: options.now } : {}) });
  if (!replay.ok) return { ok: false, code: 'erasures_not_replayed', cause: replay.code, replayed: replay.replayed };
  return { ...restored, erasuresReplayed: replay.replayed };
}
