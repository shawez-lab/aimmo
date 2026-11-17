// RC76 · La direction voit les fusions d'une fiche et défait celle faite à tort. Les fiches se réunissent seules (identifiant
// commun à la réception, à la reprise) : une fusion faite à tort, un couple qui partage un numéro, se défait ici, par la
// direction du réseau seule, avec un motif en liste fermée. Le geste passe par `FicheUnique.undoMerge` : rien n'est effacé
// [R17], les accords donnés pendant la réunion sont fermés [R03]. Au journal, le motif et des identifiants, aucun nom [R13].
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PersonMerge } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { FicheUnique } from './fusion.ts';

export const UNDO_MERGE_REASONS = ['personnes_differentes', 'identifiant_partage', 'erreur_de_saisie'] as const;
export type UndoMergeReason = (typeof UNDO_MERGE_REASONS)[number];

export interface MergeSide {
  personId: string;
  firstName: string | null;
  lastName: string | null;
}

export interface MergeLine {
  id: string;
  /** La fiche gardée et la fiche qui y a été réunie. */
  survivor: MergeSide;
  merged: MergeSide;
  reason: string;
  /** Réunies par le code (identifiant commun) ou par un geste d'agent. */
  automatic: boolean;
  mergedAt: string;
  undoneAt: string | null;
}

export interface UndoPreview {
  merge: string;
  /** Accords donnés pendant la réunion, encore en vigueur : la fusion défaite les ferme [R03]. */
  consentsToClose: number;
}

export interface UndoDone {
  merge: string;
  undoneAt: string;
  /** Faux si la fusion était déjà défaite : rien de plus n'a changé. */
  changed: boolean;
  consentsClosed: number;
  exclusionsCopied: number;
  callsCopied: number;
}

export type MergeRefusal = { ok: false; rule: 'R16' | null; code: string };
type Result<T> = { ok: true; value: T } | MergeRefusal;

const FIELDS: readonly string[] = ['reason'];
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export class DefaireFusion {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly unique: FicheUnique,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async guard(viewer: Viewer, personId: string) {
    if (viewer.role !== 'direction') {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `person:${personId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'merge_undo', code: 'role' } },
        this.now,
      );
      return { ok: false as const, rule: 'R16' as const, code: 'role' };
    }
    const fiche = await this.acces.readFiche(viewer, personId);
    if (!fiche.ok) return { ok: false as const, rule: fiche.code === 'unknown' ? null : ('R16' as const), code: fiche.code };
    return fiche;
  }

  /** La fusion demandée, seulement si elle touche cette fiche et ce réseau. */
  private async mergeOf(viewer: Viewer, personId: string, mergeId: unknown): Promise<Result<PersonMerge>> {
    const fiche = await this.guard(viewer, personId);
    if (!fiche.ok) return fiche;
    const merge = typeof mergeId === 'string' ? fiche.value.merges.find((m) => m.id === mergeId && m.network_id === viewer.networkId) : undefined;
    if (!merge) return { ok: false, rule: null, code: 'unknown_merge' };
    return { ok: true, value: merge };
  }

  /** Les fusions qui touchent la fiche, fiches réunies comprises, de la plus récente à la plus ancienne. */
  async list(viewer: Viewer, personId: string): Promise<Result<MergeLine[]>> {
    const fiche = await this.guard(viewer, personId);
    if (!fiche.ok) return fiche;
    const merges = fiche.value.merges.filter((m) => m.network_id === viewer.networkId);
    const ids = [...new Set(merges.flatMap((m) => [m.survivor_id, m.merged_id]))];
    const people = ids.length === 0
      ? []
      : await this.db.all<{ id: string; first_name: string | null; last_name: string | null }>(
          `SELECT id, first_name, last_name FROM persons WHERE network_id = ? AND id IN (${placeholders(ids.length)})`,
          [viewer.networkId, ...ids],
        );
    const side = (id: string): MergeSide => {
      const p = people.find((x) => x.id === id);
      return { personId: id, firstName: p?.first_name ?? null, lastName: p?.last_name ?? null };
    };
    const lines = merges.map((m) => ({
      id: m.id,
      survivor: side(m.survivor_id),
      merged: side(m.merged_id),
      reason: m.reason,
      automatic: m.agent_id === null,
      mergedAt: m.merged_at,
      undoneAt: m.undone_at,
    }));
    lines.sort((a, b) => (a.mergedAt === b.mergedAt ? b.id.localeCompare(a.id) : b.mergedAt.localeCompare(a.mergedAt)));
    return { ok: true, value: lines };
  }

  /** Ce que le geste fermera, dit avant : les accords donnés pendant la réunion, encore en vigueur [R03]. */
  async preview(viewer: Viewer, personId: string, mergeId: unknown): Promise<Result<UndoPreview>> {
    const found = await this.mergeOf(viewer, personId, mergeId);
    if (!found.ok) return found;
    const merge = found.value;
    if (merge.undone_at !== null) return { ok: true, value: { merge: merge.id, consentsToClose: 0 } };
    // Les mêmes fiches et la même condition que le lot de `undoMerge`.
    const ids = await this.unique.membersOf(merge.survivor_id);
    const row = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM consents WHERE person_id IN (${placeholders(ids.length)}) AND created_at >= ? AND withdrawn_at IS NULL`,
      [...ids, merge.merged_at],
    );
    return { ok: true, value: { merge: merge.id, consentsToClose: Number(row?.n ?? 0) } };
  }

  /**
   * Défait la fusion, avec un motif de la liste. `input` nul : un corps illisible, dit seulement après le contrôle des droits.
   * Rejouée sur une fusion déjà défaite : rien ne change de plus, la ligne du journal manquée s'écrit.
   */
  async undo(viewer: Viewer, personId: string, mergeId: unknown, input: Record<string, unknown> | null): Promise<Result<UndoDone>> {
    const found = await this.mergeOf(viewer, personId, mergeId);
    if (!found.ok) return found;
    if (!input) return { ok: false, rule: null, code: 'invalid_body' };
    if (Object.keys(input).some((k) => !FIELDS.includes(k))) return { ok: false, rule: null, code: 'unexpected_field' };
    const reason = input.reason as UndoMergeReason;
    if (!UNDO_MERGE_REASONS.includes(reason)) return { ok: false, rule: null, code: 'bad_reason' };

    const merge = found.value;
    const actor = `direction:${viewer.userId}`;
    const undoneAt = await this.unique.undoMerge(merge.id, { journal: this.journal, actor });
    const subject = `person:${merge.survivor_id}`;
    const lines = await this.journal.bySubject(subject);
    const done = lines.find((e) => e.type === 'fiche.fusion_defaite' && e.data.merge === merge.id);
    const count = (key: string): number => (Array.isArray(done?.data[key]) ? (done.data[key] as unknown[]).length : 0);
    const said = lines.some((e) => e.type === 'fiche.fusion_defaite_motif' && e.data.merge === merge.id);
    // Le motif de la direction, une seule fois : le premier geste compte, comme pour la fusion défaite.
    if (!said) {
      await appendEvent(this.journal, { type: 'fiche.fusion_defaite_motif', actor, subject, data: { rule: 'R16', merge: merge.id, reason } }, this.now);
    }
    return {
      ok: true,
      value: {
        merge: merge.id,
        undoneAt,
        changed: merge.undone_at === null,
        consentsClosed: count('consents'),
        exclusionsCopied: count('exclusions'),
        callsCopied: count('calls'),
      },
    };
  }
}
