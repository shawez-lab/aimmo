/**
 * Tableau de bord de l'agent, chaque chiffre prouvé (M13, K04, « Jamais vu ») [R13, R14, R16, R68, R69].
 *
 * Pour un agent et une période (jours de Paris, bornes comprises) : contacts attribués, rendez-vous tenus, mandats
 * signés, ventes conclues, et ses honoraires à venir (ses parts des commissions prévues, dues ou facturées, pas encore
 * payées). Chaque chiffre est calculé par une requête écrite, sans IA, et vient avec la liste exacte des lignes qui le
 * font : l'agent peut le recompter, ligne par ligne. Aucun logiciel ne donne cela à un agent.
 *
 * Un agent ne lit que son tableau ; la direction lit celui de chaque agent de son réseau (droits du socle : les
 * chiffres) ; la conformité ne lit aucun chiffre [R16, R68]. Aucune comparaison avec d'autres agents, aucun rang [R14].
 * Les lignes ne portent que des identifiants, des dates et des montants : la fiche se lit à part, sous ses droits.
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { CommissionStatus } from './commissions.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Une période d'un an au plus : un tableau, pas un export. */
export const MAX_PERIOD_DAYS = 366;

export interface ProvedFigure<L> {
  /** Le nombre de lignes, ou la somme de leurs montants pour les honoraires. */
  value: number;
  lines: L[];
}

export interface AgentDashboard {
  agentId: string;
  from: string;
  to: string;
  contacts: ProvedFigure<{ attributionId: string; personId: string; at: string }>;
  appointments: ProvedFigure<{ appointmentId: string; kind: string; at: string }>;
  mandates: ProvedFigure<{ mandateId: string; at: string }>;
  sales: ProvedFigure<{ fileId: string; signedOn: string }>;
  /** Somme, en centimes, des parts de l'agent non encore payées, quelle que soit la période. */
  upcomingFees: ProvedFigure<{ fileId: string; status: CommissionStatus; amountCents: number }>;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_period' };

const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Le premier instant d'un jour de Paris, heure d'été ou d'hiver. */
export function parisDayStart(day: string): Date {
  const base = Date.parse(`${day}T00:00:00Z`);
  for (const offsetHours of [1, 2, 0]) {
    const candidate = new Date(base - offsetHours * 3_600_000);
    const l = localTime(candidate, TIME_ZONE);
    if (l.date === day && l.minutes === 0) return candidate;
  }
  throw new Error('Jour introuvable à Paris.');
}

const nextDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export class TableauAgent {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async refuse(viewer: Viewer, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_dashboard', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Le tableau d'un agent sur une période ; `agentId` absent : celui du lecteur. */
  async of(viewer: Viewer, input: { from: unknown; to: unknown; agentId?: string }): Promise<{ ok: true; value: AgentDashboard } | Refusal | Problem> {
    const agentId = input.agentId ?? viewer.userId;
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [agentId]);
    if (viewer.role === 'agent') {
      const me = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
      if (!me || me.network_id !== viewer.networkId || me.status !== 'active') return this.refuse(viewer, 'agent_inactive');
    }
    const decision = decideAccess(viewer, { kind: 'figures', networkId: agent?.network_id ?? '', agentId });
    if (!agent || !decision.allowed) return this.refuse(viewer, agent ? (decision.allowed ? 'role' : decision.code) : 'unknown');
    if (!validDay(input.from) || !validDay(input.to) || input.from > input.to) return { ok: false, rule: null, code: 'bad_period' };
    if ((Date.parse(`${input.to}T12:00:00Z`) - Date.parse(`${input.from}T12:00:00Z`)) / 86_400_000 >= MAX_PERIOD_DAYS) return { ok: false, rule: null, code: 'bad_period' };
    const start = parisDayStart(input.from).toISOString();
    const end = parisDayStart(nextDay(input.to)).toISOString();
    const net = agent.network_id;

    const contacts = await this.db.all<{ id: string; person_id: string; created_at: string }>(
      'SELECT id, person_id, created_at FROM attributions WHERE network_id = ? AND agent_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at, id',
      [net, agentId, start, end],
    );
    const appointments = await this.db.all<{ id: string; kind: string; start_at: string }>(
      "SELECT id, kind, start_at FROM appointments WHERE network_id = ? AND agent_id = ? AND status = 'honored' AND start_at >= ? AND start_at < ? ORDER BY start_at, id",
      [net, agentId, start, end],
    );
    const mandates = await this.db.all<{ id: string; signed_at: string }>('SELECT id, signed_at FROM mandates WHERE network_id = ? AND agent_id = ? AND signed_at >= ? AND signed_at < ? ORDER BY signed_at, id', [
      net,
      agentId,
      start,
      end,
    ]);
    // Une vente : un acte signé ce jour-là (jour de Paris), dont la commission revient à l'agent.
    const sales = await this.db.all<{ file_id: string; due_on: string }>('SELECT file_id, due_on FROM sale_commissions WHERE network_id = ? AND agent_id = ? AND due_on >= ? AND due_on <= ? ORDER BY due_on, file_id', [
      net,
      agentId,
      input.from,
      input.to,
    ]);
    const fees = await this.db.all<{ file_id: string; amount_cents: number; status: CommissionStatus }>(
      `SELECT s.file_id, SUM(s.amount_cents) AS amount_cents,
         (SELECT st.status FROM commission_steps st WHERE st.file_id = s.file_id
           ORDER BY CASE st.status WHEN 'prevue' THEN 1 WHEN 'due' THEN 2 WHEN 'facturee' THEN 3 ELSE 4 END DESC LIMIT 1) AS status
       FROM commission_shares s JOIN commissions c ON c.file_id = s.file_id
       WHERE c.network_id = ? AND s.beneficiary_id = ? AND s.kind IN ('agent', 'partage')
         AND NOT EXISTS (SELECT 1 FROM sale_file_stops stop_ WHERE stop_.file_id = s.file_id)
         AND EXISTS (SELECT 1 FROM commission_steps st WHERE st.file_id = s.file_id)
         AND NOT EXISTS (SELECT 1 FROM commission_steps st WHERE st.file_id = s.file_id AND st.status = 'payee')
       GROUP BY s.file_id ORDER BY s.file_id`,
      [net, agentId],
    );
    const value: AgentDashboard = {
      agentId,
      from: input.from,
      to: input.to,
      contacts: { value: contacts.length, lines: contacts.map((r) => ({ attributionId: r.id, personId: r.person_id, at: r.created_at })) },
      appointments: { value: appointments.length, lines: appointments.map((r) => ({ appointmentId: r.id, kind: r.kind, at: r.start_at })) },
      mandates: { value: mandates.length, lines: mandates.map((r) => ({ mandateId: r.id, at: r.signed_at })) },
      sales: { value: sales.length, lines: sales.map((r) => ({ fileId: r.file_id, signedOn: r.due_on })) },
      upcomingFees: { value: fees.reduce((a, r) => a + r.amount_cents, 0), lines: fees.map((r) => ({ fileId: r.file_id, status: r.status, amountCents: r.amount_cents })) },
    };
    // Au journal : qui a lu quel tableau, jamais un chiffre [R13].
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `agent:${agentId}`, data: { kind: 'agent_dashboard', from: input.from, to: input.to } }, this.now);
    return { ok: true, value };
  }
}
