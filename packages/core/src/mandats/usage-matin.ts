/**
 * La mesure de l'usage du matin (A04) : la Feuille de route de janvier 2027 attend « application et plan du jour
 * utilisés chaque matin pendant une semaine ».
 *
 * Un jour compte quand l'agent a ouvert son plan du jour, déjà figé, avant midi, heure de Paris. La mesure se lit dans
 * le journal (lectures `plan_du_jour.lu`), sur les 7 derniers jours, aujourd'hui compris.
 *
 * Chaque agent ne voit que ses propres jours. La direction ne voit que des nombres pour tout le réseau : par jour,
 * combien d'agents ont ouvert leur plan, jamais lesquels ; aucun classement ni note d'agent [R14]. Aucune donnée de
 * client n'est lue ni rendue.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { parisInstant } from '../rendezvous/creneaux.ts';
import { localDay } from './plan-du-jour.ts';

const TIME_ZONE = 'Europe/Paris';
export const MORNING_DAYS = 7;
/** Midi, en minutes depuis minuit, heure de Paris. */
export const MORNING_END_MINUTES = 12 * 60;

export interface AgentMorningUsage {
  scope: 'agent';
  /** Les 7 jours, du plus ancien à aujourd'hui, `AAAA-MM-JJ`. */
  days: { day: string; opened: boolean }[];
  openedDays: number;
}

export interface NetworkMorningUsage {
  scope: 'network';
  /** Par jour : le nombre d'agents en activité qui ont ouvert leur plan avant midi ; aucun nom. */
  days: { day: string; agents: number }[];
  /** Jours où au moins un agent a ouvert son plan avant midi. */
  daysUsed: number;
  activeAgents: number;
}

export type MorningUsageRead =
  | { ok: true; value: AgentMorningUsage | NetworkMorningUsage }
  | { ok: false; rule: 'R16'; code: 'role' | 'agent_inactive' };

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export class UsageMatin {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Les 7 jours de la mesure, du plus ancien à aujourd'hui. */
  private window(): string[] {
    const today = localDay(this.now(), TIME_ZONE);
    return Array.from({ length: MORNING_DAYS }, (_, i) => addDays(today, i - (MORNING_DAYS - 1)));
  }

  /** Pour chaque agent lu, les jours de la fenêtre où il a ouvert son plan figé avant midi. */
  private async opened(days: string[], agentIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const from = parisInstant(days[0]!, 0);
    const to = parisInstant(addDays(days[days.length - 1]!, 1), 0);
    if (!from || !to) throw new Error('day_bounds');
    const wanted = new Set(agentIds.map((id) => `agent:${id}`));
    const rows = await this.db.all<{ at: string; actor: string; data: string }>(
      `SELECT at, actor, data FROM journal WHERE type = 'plan_du_jour.lu' AND at >= ? AND at < ? ORDER BY seq`,
      [from.toISOString(), to.toISOString()],
    );
    const inWindow = new Set(days);
    const result = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!wanted.has(row.actor)) continue;
      let data: { day?: unknown; ready?: unknown };
      try {
        data = JSON.parse(row.data) as { day?: unknown; ready?: unknown };
      } catch {
        continue;
      }
      // Un plan pas encore figé n'a rien montré : la lecture ne compte pas.
      if (data.ready !== true || typeof data.day !== 'string') continue;
      const local = localTime(new Date(row.at), TIME_ZONE);
      if (local.date !== data.day || !inWindow.has(local.date) || local.minutes >= MORNING_END_MINUTES) continue;
      const agent = row.actor.slice('agent:'.length);
      if (!result.has(agent)) result.set(agent, new Set());
      result.get(agent)!.add(local.date);
    }
    return result;
  }

  async read(viewer: Viewer): Promise<MorningUsageRead> {
    const days = this.window();
    const refuse = async (code: 'role' | 'agent_inactive'): Promise<MorningUsageRead> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'morning_usage', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role === 'agent') {
      const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
      if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');
      const mine = (await this.opened(days, [viewer.userId])).get(viewer.userId) ?? new Set<string>();
      return { ok: true, value: { scope: 'agent', days: days.map((day) => ({ day, opened: mine.has(day) })), openedDays: mine.size } };
    }
    if (viewer.role !== 'direction') return refuse('role');
    const agents = await this.db.all<{ id: string }>(`SELECT id FROM agents WHERE network_id = ? AND status = 'active' ORDER BY id`, [viewer.networkId]);
    const opened = await this.opened(
      days,
      agents.map((a) => a.id),
    );
    const perDay = days.map((day) => ({ day, agents: [...opened.values()].filter((set) => set.has(day)).length }));
    return { ok: true, value: { scope: 'network', days: perDay, daysUsed: perDay.filter((d) => d.agents > 0).length, activeAgents: agents.length } };
  }
}
