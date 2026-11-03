/**
 * Les indicateurs du réseau (IN04) [R215, R14, R16, R68].
 *
 * Pour la direction, un mois fini : les agents ayant signé au moins un mandat qui compte (R210), et la part des agents
 * entrés 12 mois plus tôt et toujours en activité. Jamais de liste d'agents, jamais de rang [R14].
 *
 * Les contacts transmis par zone sont publiés chaque mois aux agents. Décidé, lecture prudente : un agent ne doit pouvoir
 * retrouver le chiffre d'aucun autre [R68], ni par soustraction, ni parce qu'une zone a changé depuis. Tout se juge donc
 * sur les agents qui ont reçu des contacts ce mois-là, jamais sur les agents d'aujourd'hui. Une zone se montre à partir
 * de 3 agents ayant reçu des contacts, si ce que le lecteur n'a pas reçu lui-même dépasse le nombre des autres (sinon
 * chacun en a forcément un) ; ou à son unique agent, quand aucun autre n'y travaille : ce n'est que son chiffre. Le reste
 * se regroupe, seulement s'il réunit 2 zones et 2 agents autres que le lecteur, à la même condition. Aucun total n'est
 * donné à un agent. La direction voit tout.
 *
 * Un contact est daté par la première ligne de sa suite d'attributions et compté chez qui le tenait à la fin du mois :
 * un mois fini ne bouge pas quand un contact est réattribué après. Un client que l'agent suivait déjà n'a pas été
 * transmis. « Toujours actif » se juge à la fin du mois demandé, pas au jour de la lecture.
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
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
export const monthBounds = (month: string) => [parisDayStart(`${month}-01`).toISOString(), parisDayStart(`${nextMonth(month)}-01`).toISOString()] as const;

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
    const afterMonth = `${nextMonth(m)}-01`;
    // L'entrée : le dossier d'agent de M14, à défaut la création de l'agent (les agents de l'agence, hors M14).
    const cohort = await this.db.first<{ total: number; retained: number | null }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM agent_departures d WHERE d.agent_id = a.id AND d.cancelled_at IS NULL AND d.leaves_on < ?)
                         AND (a.status = 'active' OR EXISTS (SELECT 1 FROM agent_departures d WHERE d.agent_id = a.id AND d.cancelled_at IS NULL AND d.leaves_on >= ?)) THEN 1 ELSE 0 END) AS retained
         FROM agents a LEFT JOIN agent_onboardings o ON o.agent_id = a.id
        WHERE a.network_id = ? AND COALESCE(o.created_at, a.created_at) >= ? AND COALESCE(o.created_at, a.created_at) < ?`,
      [afterMonth, afterMonth, net, cohortStart, cohortEnd],
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
    // Une ligne par contact : la dernière de sa suite à la fin du mois, datée par la première.
    const lines = await this.db.all<{ root_id: string; agent_id: string | null; depth: number; zone: string | null }>(
      `WITH RECURSIVE chain (root_id, id, agent_id, depth) AS (
         SELECT a.id, a.id, a.agent_id, 0 FROM attributions a
          WHERE a.network_id = ? AND a.replaces_id IS NULL AND a.reason <> 'already_followed' AND a.created_at >= ? AND a.created_at < ?
         UNION ALL
         SELECT c.root_id, b.id, b.agent_id, c.depth + 1 FROM chain c JOIN attributions b ON b.replaces_id = c.id AND b.created_at < ?
       )
       SELECT c.root_id, c.agent_id, c.depth, g.zone FROM chain c LEFT JOIN agents g ON g.id = c.agent_id`,
      [net, start, end, end],
    );
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${net}`, data: { kind: 'zone_contacts', month: m } }, this.now);
    const held = new Map<string, (typeof lines)[number]>();
    for (const line of lines) {
      const known = held.get(line.root_id);
      if (!known || Number(line.depth) > Number(known.depth)) held.set(line.root_id, line);
    }
    /** Par zone : les contacts de chaque agent. */
    const zones = new Map<string | null, Map<string, number>>();
    for (const line of held.values()) {
      if (line.agent_id === null) continue;
      const perAgent = zones.get(line.zone) ?? new Map<string, number>();
      perAgent.set(line.agent_id, (perAgent.get(line.agent_id) ?? 0) + 1);
      zones.set(line.zone, perAgent);
    }
    const sum = (perAgent: ReadonlyMap<string, number>): number => [...perAgent.values()].reduce((a, b) => a + b, 0);
    const byName = (a: { zone: string | null }, b: { zone: string | null }): number => (a.zone ?? '').localeCompare(b.zone ?? '', 'fr');
    if (isDirection) return { ok: true, value: { month: m, zones: [...zones.entries()].map(([zone, perAgent]) => ({ zone, contacts: sum(perAgent) })).sort(byName), otherZones: null } };

    const colleagues = await this.db.all<{ id: string; zone: string | null }>("SELECT id, zone FROM agents WHERE network_id = ? AND status = 'active' AND zone IS NOT NULL AND id <> ?", [net, viewer.userId]);
    const worked = new Set(colleagues.map((a) => a.zone));
    const mine = (perAgent: ReadonlyMap<string, number>): number => perAgent.get(viewer.userId) ?? 0;
    /** Ce qui reste, une fois retiré ce que le lecteur a reçu, ne doit dire le chiffre de personne. */
    const safe = (others: number, rest: number): boolean => others >= 2 && rest > others;
    const shown: ZoneContacts['zones'] = [];
    const pooled = { zones: 0, contacts: 0, own: 0, others: new Set<string>() };
    for (const [zone, perAgent] of zones) {
      if (zone === null) continue; // Des contacts sans zone ne se publient pas : ils ne disent rien d'une zone.
      const total = sum(perAgent);
      const others = [...perAgent.keys()].filter((id) => id !== viewer.userId);
      const aloneHere = others.length === 0 && !worked.has(zone);
      if (aloneHere || (perAgent.size >= ZONE_MIN_AGENTS && safe(others.length, total - mine(perAgent)))) {
        shown.push({ zone, contacts: total });
        continue;
      }
      pooled.zones += 1;
      pooled.contacts += total;
      pooled.own += mine(perAgent);
      for (const id of others) pooled.others.add(id);
    }
    const pool = pooled.zones >= 2 && safe(pooled.others.size, pooled.contacts - pooled.own);
    return { ok: true, value: { month: m, zones: shown.sort(byName), otherZones: pool ? { zones: pooled.zones, contacts: pooled.contacts } : null } };
  }
}
