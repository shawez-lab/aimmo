/**
 * Les calculs et les notes rangés d'un projet d'investisseur (M17, Y14) [R16, R17, R122].
 *
 * L'écran disait « calcul rangé », mais une fois quitté, rien ne se retrouvait. Cette lecture liste les derniers, sans
 * rien recalculer ni réécrire : les chiffres sont ceux rangés ce jour-là. Elle suit les droits de la note : la fiche de
 * l'investisseur en entier ; et le bien de chaque ligne se recontrôle : une ligne dont le bien n'est plus visible sort
 * de la liste, et le nombre sorti est dit, pour qu'une liste réduite ne se lise jamais comme la liste entière [R10].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Le nombre de lignes rendues de chaque sorte, les plus récentes. */
export const PROJECT_HISTORY_LIMIT = 20;

export interface CalculationLine {
  id: string;
  createdAt: string;
  status: 'complet' | 'incomplet';
  /** La référence d'agence du bien ; null pour un calcul sans bien. */
  reference: string | null;
  /** Le rendement brut central et le net central rangés ; null pour un calcul incomplet. */
  grossYieldBp: number | null;
  netYieldBp: number | null;
}

export interface NoteLine {
  id: string;
  calculationId: string;
  createdAt: string;
  status: 'a_valider' | 'validee';
  validatedAt: string | null;
  reference: string | null;
}

export interface ProjectHistory {
  calculs: CalculationLine[];
  notes: NoteLine[];
  /** D'autres lignes, plus anciennes, ne sont pas rendues. */
  more: boolean;
  /** Des lignes dont le bien n'est plus visible par ce lecteur. */
  hidden: number;
}

export type ProjectHistoryResult = { ok: true; value: ProjectHistory } | { ok: false; rule: 'R16'; code: string };

export class HistoriqueProjet {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async of(acces: Acces, viewer: Viewer, projectId: string): Promise<ProjectHistoryResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const refused = async (code: string): Promise<ProjectHistoryResult> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: `project:${projectId}`, data: { rule: 'R16', code, kind: 'investment_history', role: String(viewer.role) } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return refused('role');
    const project = await this.db.first<{ person_id: string }>("SELECT person_id FROM projects WHERE id = ? AND network_id = ? AND kind = 'invest'", [projectId, viewer.networkId]);
    if (!project) return refused('unknown');
    const read = await acces.readFiche(viewer, project.person_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return refused('not_assigned');

    // Une ligne de plus que la limite : elle dit seulement qu'il y en a d'autres.
    const calcs = await this.db.all<{ id: string; property_id: string | null; status: 'complet' | 'incomplet'; result: string; created_at: string }>(
      'SELECT id, property_id, status, result, created_at FROM investment_calculations WHERE network_id = ? AND project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      [viewer.networkId, projectId, PROJECT_HISTORY_LIMIT + 1],
    );
    const notes = await this.db.all<{ id: string; calculation_id: string; status: 'a_valider' | 'validee'; created_at: string; validated_at: string | null; property_id: string | null }>(
      `SELECT n.id, n.calculation_id, n.status, n.created_at, n.validated_at, c.property_id FROM investment_notes n
       JOIN investment_calculations c ON c.id = n.calculation_id
       WHERE n.network_id = ? AND n.project_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
      [viewer.networkId, projectId, PROJECT_HISTORY_LIMIT + 1],
    );
    const more = calcs.length > PROJECT_HISTORY_LIMIT || notes.length > PROJECT_HISTORY_LIMIT;
    const keptCalcs = calcs.slice(0, PROJECT_HISTORY_LIMIT);
    const keptNotes = notes.slice(0, PROJECT_HISTORY_LIMIT);

    // Chaque bien se contrôle une fois : un bien sorti du fichier commun ne se relit plus [R16].
    const seen = new Map<string, string | null>();
    const referenceOf = async (propertyId: string): Promise<string | null> => {
      if (!seen.has(propertyId)) {
        const p = await acces.readProperty(viewer, propertyId);
        seen.set(propertyId, p.ok ? p.value.reference : null);
      }
      return seen.get(propertyId)!;
    };

    let hidden = 0;
    const calculs: CalculationLine[] = [];
    for (const c of keptCalcs) {
      const reference = c.property_id === null ? null : await referenceOf(c.property_id);
      if (c.property_id !== null && reference === null) {
        hidden += 1;
        continue;
      }
      const r = JSON.parse(c.result) as { grossYieldBp?: { central?: number }; netYieldBp?: { central?: number } };
      calculs.push({ id: c.id, createdAt: c.created_at, status: c.status, reference, grossYieldBp: r.grossYieldBp?.central ?? null, netYieldBp: r.netYieldBp?.central ?? null });
    }
    const lines: NoteLine[] = [];
    for (const n of keptNotes) {
      const reference = n.property_id === null ? null : await referenceOf(n.property_id);
      if (n.property_id !== null && reference === null) {
        hidden += 1;
        continue;
      }
      lines.push({ id: n.id, calculationId: n.calculation_id, createdAt: n.created_at, status: n.status, validatedAt: n.validated_at, reference });
    }
    await appendEvent(this.journal, { type: 'investir.historique_lu', actor, subject: `project:${projectId}`, data: { rule: 'R16', calculs: calculs.length, notes: lines.length } }, this.now);
    return { ok: true, value: { calculs, notes: lines, more, hidden } };
  }
}
