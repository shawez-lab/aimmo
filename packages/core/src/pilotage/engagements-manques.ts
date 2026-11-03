/**
 * Un engagement manqué : noté, et le client rappelé par un responsable (IN12) [R228, R216, R16, R17, R02].
 *
 * Le cahier promet qu'un engagement de service manqué « est noté, et le client est rappelé par un responsable ». Chaque cas
 * manqué que voit la mesure de IN07 donne une seule tâche ; la machine n'envoie rien : c'est un humain qui appelle.
 *
 * Décidé, lecture prudente : le responsable est la direction du réseau. Le passage, à 7 h de Paris, lit le mois en cours et
 * le mois passé, car un délai peut finir après son mois. Le journal note le code et le jour, jamais qui. Une personne exclue
 * au moment de la lecture se dit « ne pas appeler », et son rappel ne peut pas se noter fait [R02] : seul « sans appel » le
 * ferme. La reprise de liberté du vendeur attend l'avocat (H49) : rien ne la promet ici.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { EngagementsTenus, SERVICE_PROMISES } from './engagements-tenus.ts';
import { parisMonth } from './preuve.ts';

export const MISSED_PROMISE_OUTCOMES = ['rappele', 'injoignable', 'sans_appel'] as const;
export type MissedPromiseOutcome = (typeof MISSED_PROMISE_OUTCOMES)[number];
/** Les tâches rendues en une lecture : les plus anciennes d'abord, le total est dit à côté. */
export const MISSED_PROMISE_PAGE = 200;
const SYNC_HOUR_MINUTES = 7 * 60;

export interface MissedPromiseTask {
  id: string;
  code: string;
  label: string;
  day: string;
  personId: string | null;
  agentId: string | null;
  /** Le nom de l'agent à rappeler, pour un engagement envers l'agent : sa fiche n'est pas une fiche de client. */
  agentName: string | null;
  /** Une exclusion est en cours : on n'appelle pas [R02]. */
  doNotCall: boolean;
}

type Refusal = { ok: false; rule: 'R16'; code: string };

const previousMonth = (month: string): string => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export class EngagementsManques {
  private readonly now: () => Date;
  private readonly tenus: EngagementsTenus;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.tenus = new EngagementsTenus(db, journal, { now: this.now });
  }

  /** Une fois par jour, depuis le passage de chaque heure. */
  async syncIfDue(networkId: string): Promise<number> {
    const minutes = localTime(this.now(), 'Europe/Paris').minutes;
    return minutes >= SYNC_HOUR_MINUTES && minutes < SYNC_HOUR_MINUTES + 60 ? this.sync(networkId) : 0;
  }

  /** Rejoué, il n'ajoute rien [R18]. Rend le nombre de tâches nées. */
  async sync(networkId: string): Promise<number> {
    const month = parisMonth(this.now());
    let created = 0;
    for (const m of [previousMonth(month), month]) {
      for (const c of await this.tenus.missedCases(networkId, m)) {
        const { changes } = await this.db.run(
          'INSERT INTO missed_promise_tasks (id, network_id, promise_code, case_key, day, person_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          [crypto.randomUUID(), networkId, c.code, c.key, c.day, c.personId, c.agentId, this.now().toISOString()],
        );
        if (changes !== 1) continue;
        created += 1;
        await appendEvent(this.journal, { type: 'pilotage.engagement_manque', actor: 'system:pilotage', subject: `network:${networkId}`, data: { rule: 'R228', code: c.code, day: c.day } }, this.now);
      }
    }
    return created;
  }

  private async refuse(viewer: Viewer): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'missed_promises', code: 'role' } }, this.now);
    return { ok: false, rule: 'R16', code: 'role' };
  }

  /**
   * Toute la famille d'une fiche : la fusion ne déplace pas les exclusions, et la fiche de la tâche a pu être réunie
   * après sa naissance. Rend la fiche gardée, et si une exclusion est en cours sur l'une des fiches [R02].
   */
  private async families(networkId: string): Promise<(personId: string) => { root: string; doNotCall: boolean }> {
    const merges = await this.db.all<{ survivor_id: string; merged_id: string }>('SELECT survivor_id, merged_id FROM person_merges WHERE network_id = ? AND undone_at IS NULL', [networkId]);
    const parent = new Map(merges.map((m) => [m.merged_id, m.survivor_id]));
    const rootOf = (id: string): string => {
      const seen = new Set<string>();
      let at = id;
      while (parent.has(at) && !seen.has(at)) {
        seen.add(at);
        at = parent.get(at)!;
      }
      return at;
    };
    const at = this.now().toISOString();
    const rows = await this.db.all<{ person_id: string }>('SELECT person_id FROM exclusions WHERE network_id = ? AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?)', [networkId, at, at]);
    const shut = new Set(rows.map((r) => rootOf(r.person_id)));
    return (personId) => {
      const root = rootOf(personId);
      return { root, doNotCall: shut.has(root) };
    };
  }

  /** Les rappels à faire, la direction seule [R16]. */
  async open(viewer: Viewer): Promise<{ ok: true; value: { total: number; tasks: MissedPromiseTask[] } } | Refusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer);
    const net = viewer.networkId;
    const count = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM missed_promise_tasks WHERE network_id = ? AND done_at IS NULL', [net]);
    const rows = await this.db.all<{ id: string; promise_code: string; day: string; person_id: string | null; agent_id: string | null; first_name: string | null; last_name: string | null }>(
      'SELECT t.id, t.promise_code, t.day, t.person_id, t.agent_id, a.first_name, a.last_name FROM missed_promise_tasks t LEFT JOIN agents a ON a.id = t.agent_id AND a.network_id = t.network_id WHERE t.network_id = ? AND t.done_at IS NULL ORDER BY t.day, t.id LIMIT ?',
      [net, MISSED_PROMISE_PAGE],
    );
    const family = await this.families(net);
    const tasks: MissedPromiseTask[] = rows.map((r) => {
      const who = r.person_id === null ? null : family(r.person_id);
      return {
        id: r.id,
        code: r.promise_code,
        label: SERVICE_PROMISES.find((p) => p.code === r.promise_code)?.label ?? r.promise_code,
        day: r.day,
        personId: who?.root ?? null,
        agentId: r.agent_id,
        agentName: r.first_name === null ? null : `${r.first_name} ${r.last_name}`,
        doNotCall: who?.doNotCall ?? false,
      };
    });
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `direction:${viewer.userId}`, subject: `network:${net}`, data: { kind: 'missed_promises' } }, this.now);
    return { ok: true, value: { total: Number(count?.n ?? 0), tasks } };
  }

  /** La direction dit ce qui a été fait, une fois. Refaire le même geste n'ajoute rien [R18]. */
  async close(viewer: Viewer, taskId: string, outcome: unknown): Promise<{ ok: true; value: { id: string; outcome: MissedPromiseOutcome } } | Refusal | { ok: false; rule: null; code: 'bad_outcome' | 'unknown_task' } | { ok: false; rule: 'R02'; code: 'do_not_call' } | { ok: false; rule: 'R228'; code: 'already_done' }> {
    if (viewer.role !== 'direction') return this.refuse(viewer);
    if (typeof outcome !== 'string' || !(MISSED_PROMISE_OUTCOMES as readonly string[]).includes(outcome)) return { ok: false, rule: null, code: 'bad_outcome' };
    const chosen = outcome as MissedPromiseOutcome;
    const net = viewer.networkId;
    const task = await this.db.first<{ id: string; person_id: string | null; outcome: string | null; done_at: string | null }>('SELECT id, person_id, outcome, done_at FROM missed_promise_tasks WHERE id = ? AND network_id = ?', [taskId, net]);
    if (!task) return { ok: false, rule: null, code: 'unknown_task' };
    if (task.done_at !== null) return task.outcome === chosen ? { ok: true, value: { id: task.id, outcome: chosen } } : { ok: false, rule: 'R228', code: 'already_done' };
    if (chosen !== 'sans_appel' && task.person_id !== null && (await this.families(net))(task.person_id).doNotCall) return { ok: false, rule: 'R02', code: 'do_not_call' };
    const { changes } = await this.db.run('UPDATE missed_promise_tasks SET done_at = ?, done_by = ?, outcome = ? WHERE id = ? AND done_at IS NULL', [this.now().toISOString(), viewer.userId, chosen, task.id]);
    if (changes !== 1) return { ok: false, rule: 'R228', code: 'already_done' };
    await appendEvent(this.journal, { type: 'pilotage.engagement_manque_fait', actor: `direction:${viewer.userId}`, subject: `network:${net}`, data: { rule: 'R228', outcome: chosen } }, this.now);
    return { ok: true, value: { id: task.id, outcome: chosen } };
  }
}
