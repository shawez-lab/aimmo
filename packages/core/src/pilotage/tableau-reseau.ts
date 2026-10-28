/**
 * Tableau de bord du réseau (M13, K05) [R13, R14, R16, R69].
 *
 * Pour la direction et une période (jours de Paris) : contacts attribués, rendez-vous tenus, mandats signés et ventes,
 * au total, par agent, par zone d'agent et par source ; les coûts de l'IA par canal et par mandat signé. Tout vient de
 * la base par des requêtes écrites : chaque total est aussi la somme de chaque découpage, ce que les tests vérifient.
 *
 * Aucune note, aucun score, aucun rang d'agent : les agents sont listés par leur identifiant, jamais triés par un
 * chiffre [R14]. La direction seule le lit ; la conformité n'a pas les chiffres (droits du socle) [R16].
 *
 * Décidé, lecture prudente : un contact sans agent (gardé par la direction) compte sous « direction » ; un agent sans
 * zone sous « sans zone » ; la source d'un contact est le canal du message qui l'a fait naître, celle d'un mandat sa
 * source rangée (R37) ; le coût de l'IA est celui rangé avec chaque message écrit par l'IA dans la période.
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { MAX_PERIOD_DAYS, parisDayStart } from './tableau-agent.ts';

export interface Counts {
  contacts: number;
  appointments: number;
  mandates: number;
  sales: number;
}

export interface NetworkDashboard {
  from: string;
  to: string;
  totals: Counts;
  /** `agentId` null : ce que garde la direction. Dans l'ordre des identifiants, jamais d'un chiffre [R14]. */
  byAgent: ({ agentId: string | null } & Counts)[];
  byZone: ({ zone: string | null } & Counts)[];
  bySource: { contacts: { channel: string; count: number }[]; mandates: { source: string; count: number }[] };
  aiCosts: { totalCents: number; byChannel: { channel: string; cents: number }[]; perSignedMandateCents: number | null };
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_period' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const nextDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const empty = (): Counts => ({ contacts: 0, appointments: 0, mandates: 0, sales: 0 });

export class TableauReseau {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async of(viewer: Viewer, input: { from: unknown; to: unknown }): Promise<{ ok: true; value: NetworkDashboard } | Refusal | Problem> {
    const d = viewer.role === 'direction' ? decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId }) : null;
    if (!d || !d.allowed) {
      const code = d && !d.allowed ? d.code : 'role';
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'network_dashboard', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    }
    if (!validDay(input.from) || !validDay(input.to) || input.from > input.to) return { ok: false, rule: null, code: 'bad_period' };
    if ((Date.parse(`${input.to}T12:00:00Z`) - Date.parse(`${input.from}T12:00:00Z`)) / 86_400_000 >= MAX_PERIOD_DAYS) return { ok: false, rule: null, code: 'bad_period' };
    const net = viewer.networkId;
    const start = parisDayStart(input.from).toISOString();
    const end = parisDayStart(nextDay(input.to)).toISOString();

    // Une ligne par fait, avec l'agent ; les découpages et les totaux sont faits sur ces mêmes lignes et par SQL.
    const contactRows = await this.db.all<{ agent_id: string | null; channel: string | null }>(
      `SELECT a.agent_id, m.channel FROM attributions a
         LEFT JOIN qualifications q ON q.id = a.qualification_id
         LEFT JOIN inbound_messages m ON m.id = q.inbound_id
       WHERE a.network_id = ? AND a.created_at >= ? AND a.created_at < ?`,
      [net, start, end],
    );
    const appointmentRows = await this.db.all<{ agent_id: string }>("SELECT agent_id FROM appointments WHERE network_id = ? AND status = 'honored' AND start_at >= ? AND start_at < ?", [net, start, end]);
    const mandateRows = await this.db.all<{ agent_id: string; source_kind: string }>('SELECT agent_id, source_kind FROM mandates WHERE network_id = ? AND signed_at >= ? AND signed_at < ?', [net, start, end]);
    const saleRows = await this.db.all<{ agent_id: string }>('SELECT agent_id FROM sale_commissions WHERE network_id = ? AND due_on >= ? AND due_on <= ?', [net, input.from, input.to]);
    const totalOf = async (sql: string, params: string[]) => (await this.db.first<{ n: number }>(sql, params))?.n ?? 0;
    const totals: Counts = {
      contacts: await totalOf('SELECT COUNT(*) AS n FROM attributions WHERE network_id = ? AND created_at >= ? AND created_at < ?', [net, start, end]),
      appointments: await totalOf("SELECT COUNT(*) AS n FROM appointments WHERE network_id = ? AND status = 'honored' AND start_at >= ? AND start_at < ?", [net, start, end]),
      mandates: await totalOf('SELECT COUNT(*) AS n FROM mandates WHERE network_id = ? AND signed_at >= ? AND signed_at < ?', [net, start, end]),
      sales: await totalOf('SELECT COUNT(*) AS n FROM sale_commissions WHERE network_id = ? AND due_on >= ? AND due_on <= ?', [net, input.from, input.to]),
    };

    const zones = new Map((await this.db.all<{ id: string; zone: string | null }>('SELECT id, zone FROM agents WHERE network_id = ?', [net])).map((a) => [a.id, a.zone]));
    const byAgent = new Map<string | null, Counts>();
    const byZone = new Map<string | null, Counts>();
    const add = (agentId: string | null, key: keyof Counts) => {
      for (const [map, k] of [[byAgent, agentId], [byZone, agentId === null ? null : (zones.get(agentId) ?? null)]] as const) {
        const c = map.get(k) ?? empty();
        c[key] += 1;
        map.set(k, c);
      }
    };
    for (const r of contactRows) add(r.agent_id, 'contacts');
    for (const r of appointmentRows) add(r.agent_id, 'appointments');
    for (const r of mandateRows) add(r.agent_id, 'mandates');
    for (const r of saleRows) add(r.agent_id, 'sales');
    const order = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b));

    const count = <T extends string>(values: T[]) => {
      const m = new Map<T, number>();
      for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    };
    const costs = await this.db.all<{ channel: string; cents: number }>(
      "SELECT channel, SUM(cost_cents) AS cents FROM messages WHERE network_id = ? AND author_kind = 'ai' AND cost_cents > 0 AND occurred_at >= ? AND occurred_at < ? GROUP BY channel ORDER BY channel",
      [net, start, end],
    );
    const totalCents = costs.reduce((a, c) => a + c.cents, 0);
    const value: NetworkDashboard = {
      from: input.from,
      to: input.to,
      totals,
      byAgent: [...byAgent.entries()].sort((a, b) => order(a[0], b[0])).map(([agentId, c]) => ({ agentId, ...c })),
      byZone: [...byZone.entries()].sort((a, b) => order(a[0], b[0])).map(([zone, c]) => ({ zone, ...c })),
      bySource: {
        contacts: count(contactRows.map((r) => r.channel ?? 'autre')).map(([channel, n]) => ({ channel, count: n })),
        mandates: count(mandateRows.map((r) => r.source_kind)).map(([source, n]) => ({ source, count: n })),
      },
      aiCosts: { totalCents, byChannel: costs.map((c) => ({ channel: c.channel, cents: c.cents })), perSignedMandateCents: totals.mandates > 0 ? Math.round(totalCents / totals.mandates) : null },
    };
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${net}`, data: { kind: 'network_dashboard', from: input.from, to: input.to } }, this.now);
    return { ok: true, value };
  }
}
