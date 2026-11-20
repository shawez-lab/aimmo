/**
 * Les échéances des mandats (M06, D06).
 *
 * Chaque jour, le planificateur range pour l'agent une tâche avant la fin d'un mandat (renouvellement à proposer à
 * temps) et avant la fin de la période de 3 mois d'un mandat exclusif. Les délais sont des réglages. Une seule tâche
 * par échéance, même si le passage est rejoué ou doublé [R18]. Rien n'est envoyé au vendeur. Un mandat rétracté ou
 * annulé au registre n'a plus d'échéance. Les jours se comptent à Paris.
 */
import type { Viewer } from '../acces/droits.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { DocumentFacts } from './modeles.ts';
import { mandateEndDay, mandateTerms } from './conditions.ts';

const TIME_ZONE = 'Europe/Paris';
export const MANDATE_DEADLINES_JOB = 'mandats.echeances';
/** La période d'un mandat exclusif, en mois. */
export const EXCLUSIVE_PERIOD_MONTHS = 3;

export interface DeadlineSettings {
  /** Jours avant la fin du mandat où la tâche de renouvellement est rangée. */
  endLeadDays: number;
  /** Jours avant la fin de la période exclusive où la tâche est rangée. */
  exclusiveLeadDays: number;
}
export const DEFAULT_DEADLINE_SETTINGS: DeadlineSettings = Object.freeze({ endLeadDays: 30, exclusiveLeadDays: 15 });

export interface MandateTask {
  id: string;
  mandateId: string;
  kind: 'fin_mandat' | 'fin_periode_exclusive';
  dueDay: string;
  /** La raison, en une ligne, sans donnée personnelle. */
  reason: string;
  doneAt: string | null;
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const REASON: Record<MandateTask['kind'], string> = {
  fin_mandat: 'Fin du mandat : proposer le renouvellement au vendeur.',
  fin_periode_exclusive: 'Fin de la période de 3 mois du mandat exclusif : faire le point avec le vendeur.',
};

export class EcheancesMandats {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: DeadlineSettings;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; settings?: DeadlineSettings } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? DEFAULT_DEADLINE_SETTINGS;
  }

  /** Un passage : range les tâches dont le délai est atteint. Rend le nombre de tâches nouvelles. */
  async run(): Promise<number> {
    const today = localTime(this.now(), TIME_ZONE).date;
    const rows = await this.db.all<{ mandate_id: string; network_id: string; agent_id: string; signed_at: string; kind: string; facts: string | null; seq: number }>(
      `SELECT s.mandate_id, s.network_id, m.agent_id, s.signed_at, d.kind, d.facts, r.seq FROM signed_documents s
       JOIN documents d ON d.id = s.document_id JOIN mandates m ON m.id = s.mandate_id
       JOIN mandate_register r ON r.mandate_id = s.mandate_id AND r.kind = 'inscription'
       WHERE s.copy_content IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM mandate_withdrawals w WHERE w.mandate_id = s.mandate_id)
       AND NOT EXISTS (SELECT 1 FROM mandate_register c WHERE c.network_id = r.network_id AND c.kind = 'annulation' AND c.cancels_seq = r.seq)
       ORDER BY s.signed_at, s.mandate_id`,
    );
    let created = 0;
    let failure: unknown = null;
    for (const row of rows) {
      try {
        const signedAt = new Date(row.signed_at);
        let facts: DocumentFacts | null = null;
        try {
          facts = row.facts ? (JSON.parse(row.facts) as DocumentFacts) : null;
        } catch {
          facts = null;
        }
        const due: { kind: MandateTask['kind']; day: string; lead: number }[] = [];

        // La période exclusive ne compte que si le mandat dure au-delà ; un mandat plus court n'y arrive jamais.
        // La durée en vigueur, avenants signés compris (D07).
        // Celles de ce jour : un avenant dont la date d'effet n'est pas venue ne déplace pas encore l'échéance (AU057).
        const terms = await mandateTerms(this.db, row.mandate_id, this.now());
        const duration = terms?.durationMonths ?? facts?.durationMonths ?? null;
        const end = duration !== null ? mandateEndDay(signedAt, duration) : null;
        if (end !== null) due.push({ kind: 'fin_mandat', day: end, lead: this.settings.endLeadDays });
        if (row.kind === 'mandat_vente_exclusif' && end !== null && mandateEndDay(signedAt, EXCLUSIVE_PERIOD_MONTHS) < end) due.push({ kind: 'fin_periode_exclusive', day: mandateEndDay(signedAt, EXCLUSIVE_PERIOD_MONTHS), lead: this.settings.exclusiveLeadDays });
        for (const d of due) {
          // La tâche est rangée dès que le délai est atteint, jusqu'au jour de l'échéance compris.
          if (today < addDays(d.day, -d.lead) || today > d.day) continue;
          const { changes } = await this.db.run(
            `INSERT INTO mandate_tasks (id, network_id, agent_id, mandate_id, kind, due_day, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedup_key) DO NOTHING`,
            [this.newId(), row.network_id, row.agent_id, row.mandate_id, d.kind, d.day, `${d.kind}:${row.mandate_id}:${d.day}`, this.now().toISOString()],
          );
          if (changes === 1) {
            created += 1;
            await appendEvent(this.journal, { type: 'mandat.echeance', actor: 'system:planificateur', subject: `mandate:${row.mandate_id}`, data: { kind: d.kind, dueDay: d.day } }, this.now);
          }
        }
      } catch (error) {
        // Une panne sur un mandat n'arrête pas les autres ; elle remonte ensuite au planificateur [R13].
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return created;
  }

  /** Les tâches d'échéance de l'agent lui-même, ouvertes d'abord [R16]. */
  async list(viewer: Viewer): Promise<{ ok: true; tasks: MandateTask[] } | { ok: false; rule: 'R16'; code: 'not_agent' | 'agent_inactive' }> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const refuse = async (code: 'not_agent' | 'agent_inactive') => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate_tasks', code } }, this.now);
      return { ok: false as const, rule: 'R16' as const, code };
    };
    if (viewer.role !== 'agent') return refuse('not_agent');
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');
    const rows = await this.db.all<{ id: string; mandate_id: string; kind: MandateTask['kind']; due_day: string; done_at: string | null }>(
      // Un mandat rétracté ou annulé au registre n'a plus d'échéance à montrer ; ses tâches restent gardées.
      `SELECT t.id, t.mandate_id, t.kind, t.due_day, t.done_at FROM mandate_tasks t WHERE t.network_id = ? AND t.agent_id = ?
       AND NOT EXISTS (SELECT 1 FROM mandate_withdrawals w WHERE w.mandate_id = t.mandate_id)
       AND NOT EXISTS (SELECT 1 FROM mandate_register r JOIN mandate_register c ON c.network_id = r.network_id AND c.kind = 'annulation' AND c.cancels_seq = r.seq
                       WHERE r.mandate_id = t.mandate_id AND r.kind = 'inscription')
       ORDER BY CASE WHEN t.done_at IS NULL THEN 0 ELSE 1 END, t.due_day, t.id`,
      [viewer.networkId, viewer.userId],
    );
    // Une échéance déplacée par un avenant signé n'est plus à faire : la tâche reste gardée, plus montrée.
    const current: MandateTask[] = [];
    for (const r of rows) {
      const signed = await this.db.first<{ signed_at: string }>('SELECT signed_at FROM signed_documents WHERE mandate_id = ?', [r.mandate_id]);
      const terms = await mandateTerms(this.db, r.mandate_id, this.now());
      if (signed && terms && terms.durationMonths !== null) {
        const end = mandateEndDay(new Date(signed.signed_at), terms.durationMonths);
        if (r.kind === 'fin_mandat' && r.due_day !== end) continue;
        if (r.kind === 'fin_periode_exclusive' && r.due_day >= end) continue;
      }
      current.push({ id: r.id, mandateId: r.mandate_id, kind: r.kind, dueDay: r.due_day, reason: REASON[r.kind], doneAt: r.done_at });
    }
    return { ok: true, tasks: current };
  }
}

/** La tâche du planificateur : les échéances des mandats, chaque jour à 6 h, heure de Paris. */
export function mandateDeadlinesJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date; settings?: DeadlineSettings } = {}): ScheduledJob {
  return {
    name: MANDATE_DEADLINES_JOB,
    hours: [6],
    run: async () => {
      await new EcheancesMandats(db, journal, options).run();
    },
  };
}
