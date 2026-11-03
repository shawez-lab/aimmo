/**
 * Les indicateurs du réseau (IN04) [R215, R14, R16, R68].
 *
 * Pour la direction, un mois fini : les agents ayant signé au moins un mandat qui compte (R210), et la part des agents
 * entrés 12 mois plus tôt et toujours en activité. Jamais de liste d'agents, jamais de rang [R14].
 *
 * Les contacts transmis par zone sont publiés chaque mois aux agents. Décidé, lecture prudente : un agent ne doit pas
 * retrouver le chiffre d'un autre [R68]. Une zone ne se montre donc qu'à partir de 3 agents en activité, car à 2 l'agent
 * retrouve l'autre en retirant le sien ; il voit aussi la sienne quand il y est seul, ce n'est que son chiffre. Le reste
 * se regroupe, et le regroupement n'est rendu que s'il réunit au moins 2 zones. Aucun total n'est donné à un agent : il
 * permettrait de retrouver par différence ce qui est retenu. La direction voit tout.
 *
 * Un contact compte à la dernière ligne de sa suite d'attributions, chez l'agent qui le tient ; un client que l'agent
 * suivait déjà n'a pas été transmis. La zone est celle de l'agent aujourd'hui, comme le tableau de bord (K05).
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { LIVE_REGISTERED_MANDATES, ratio, type Ratio } from './parcours.ts';
import { parisMonth } from './preuve.ts';
import { parisDayStart } from './tableau-agent.ts';

export const ZONE_MIN_AGENTS = 3;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface NetworkPeople {
  month: string;
  activeSigners: number;
  /** Agents entrés le même mois, un an plus tôt, et toujours là ; `bp` nul sans personne entrée ce mois-là. */
  retainedAfterYear: Ratio & { cohortMonth: string };
}

export interface ZoneContacts {
  month: string;
  zones: { zone: string | null; contacts: number }[];
  /** Les contacts des zones non montrées, réunies ; `null` quand ce regroupement dirait le chiffre d'une seule zone. */
  otherZones: { zones: number; contacts: number } | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_month' } | { ok: false; rule: 'R215'; code: 'month_not_finished' };

const shiftYear = (month: string, years: number): string => `${Number(month.slice(0, 4)) + years}${month.slice(4)}`;
const nextMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const monthBounds = (month: string) => [parisDayStart(`${month}-01`).toISOString(), parisDayStart(`${nextMonth(month)}-01`).toISOString()] as const;

export class IndicateursReseau {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async refuse(viewer: Viewer, kind: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private checkMonth(month: unknown): Problem | null {
    if (typeof month !== 'string' || !MONTH.test(month)) return { ok: false, rule: null, code: 'bad_month' };
    return month >= parisMonth(this.now()) ? { ok: false, rule: 'R215', code: 'month_not_finished' } : null;
  }

  /** La direction seule [R16]. */
  async people(viewer: Viewer, month: unknown): Promise<{ ok: true; value: NetworkPeople } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'network_people', 'role');
    const problem = this.checkMonth(month);
    if (problem) return problem;
    const m = month as string;
    const net = viewer.networkId;
    const [start, end] = monthBounds(m);
    const signers = await this.db.first<{ n: number }>(`SELECT COUNT(DISTINCT agent_id) AS n FROM (${LIVE_REGISTERED_MANDATES}) WHERE network_id = ? AND signed_at >= ? AND signed_at < ?`, [net, start, end]);

    const cohortMonth = shiftYear(m, -1);
    const [cohortStart, cohortEnd] = monthBounds(cohortMonth);
    const today = localTime(this.now(), 'Europe/Paris').date;
    // L'entrée : le dossier d'agent de M14, à défaut la création de l'agent (les agents de l'agence, hors M14).
    const cohort = await this.db.first<{ total: number; retained: number | null }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN a.status = 'active' AND NOT EXISTS (SELECT 1 FROM agent_departures d WHERE d.agent_id = a.id AND d.cancelled_at IS NULL AND d.leaves_on <= ?) THEN 1 ELSE 0 END) AS retained
         FROM agents a LEFT JOIN agent_onboardings o ON o.agent_id = a.id
        WHERE a.network_id = ? AND COALESCE(o.created_at, a.created_at) >= ? AND COALESCE(o.created_at, a.created_at) < ?`,
      [today, net, cohortStart, cohortEnd],
    );
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${net}`, data: { kind: 'network_people', month: m } }, this.now);
    return {
      ok: true,
      value: { month: m, activeSigners: Number(signers?.n ?? 0), retainedAfterYear: { ...ratio(Number(cohort?.retained ?? 0), Number(cohort?.total ?? 0)), cohortMonth } },
    };
  }

  /** Les contacts transmis par zone : la direction voit tout, un agent ce qui ne dit le chiffre de personne d'autre [R68]. */
  async contactsByZone(viewer: Viewer, month: unknown): Promise<{ ok: true; value: ZoneContacts } | Refusal | Problem> {
    const isDirection = viewer.role === 'direction';
    if (!isDirection) {
      const d = decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId });
      if (!d.allowed) return this.refuse(viewer, 'zone_contacts', d.code);
    }
    const problem = this.checkMonth(month);
    if (problem) return problem;
    const m = month as string;
    const net = viewer.networkId;
    const [start, end] = monthBounds(m);
    const rows = await this.db.all<{ zone: string | null; n: number }>(
      `SELECT g.zone, COUNT(*) AS n FROM attributions a JOIN agents g ON g.id = a.agent_id
        WHERE a.network_id = ? AND a.created_at >= ? AND a.created_at < ? AND a.reason <> 'already_followed'
          AND NOT EXISTS (SELECT 1 FROM attributions b WHERE b.replaces_id = a.id)
        GROUP BY g.zone`,
      [net, start, end],
    );
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${net}`, data: { kind: 'zone_contacts', month: m } }, this.now);
    const sorted = rows.map((r) => ({ zone: r.zone, contacts: Number(r.n) })).sort((a, b) => (a.zone ?? '').localeCompare(b.zone ?? '', 'fr'));
    if (isDirection) return { ok: true, value: { month: m, zones: sorted, otherZones: null } };

    const agents = await this.db.all<{ id: string; zone: string | null }>("SELECT id, zone FROM agents WHERE network_id = ? AND status = 'active'", [net]);
    const size = new Map<string, number>();
    for (const a of agents) if (a.zone !== null) size.set(a.zone, (size.get(a.zone) ?? 0) + 1);
    const mine = agents.find((a) => a.id === viewer.userId)?.zone ?? null;
    const shown: ZoneContacts['zones'] = [];
    const pooled: number[] = [];
    for (const row of sorted) {
      if (row.zone === null) continue; // Des contacts sans zone ne se publient pas : ils ne disent rien d'une zone.
      const n = size.get(row.zone) ?? 0;
      if (n >= ZONE_MIN_AGENTS || (row.zone === mine && n === 1)) shown.push(row);
      else pooled.push(row.contacts);
    }
    return { ok: true, value: { month: m, zones: shown, otherZones: pooled.length >= 2 ? { zones: pooled.length, contacts: pooled.reduce((a, b) => a + b, 0) } : null } };
  }
}
