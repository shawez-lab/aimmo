/**
 * Le temps gagné, déclaré par l'agent et contrôlé sur le journal (IN08) [R217, R14, R16, R17, R68].
 *
 * L'agent déclare les minutes gagnées d'une semaine finie, du lundi au dimanche à Paris ; il lit sa déclaration et ses
 * gestes de cette semaine. La direction lit les comptes du réseau, jamais une ligne par agent : ni liste, ni rang.
 *
 * Décidé, lecture prudente : le contrôle compte les gestes écrits au journal au nom de l'agent, hors lectures, refus et
 * déclarations de temps ; il ne dit qu'une chose, combien de déclarations de temps gagné n'ont aucun geste en face, et il
 * ne note personne : un compte, sans nom. Une déclaration à zéro n'a rien à contrôler. Sans déclaration : `null`, jamais
 * zéro. Une nouvelle déclaration ajoute une version ; la dernière compte. Plafond : 80 heures par semaine.
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import { mondayOf } from '../annonces/mesure.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { agentBlocked } from '../mandats/gagner/etat-agent.ts';
import { parisDayStart } from './tableau-agent.ts';

export const MAX_MINUTES_SAVED = 4800;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DECLARED = 'pilotage.temps_gagne';
/** Ce qui n'est pas un geste de travail. */
const GESTURE = `actor = ? AND at >= ? AND at < ? AND type <> '${DECLARED}' AND type <> 'acces.refuse' AND type NOT LIKE '%.lecture' AND type NOT LIKE '%_lus' AND type NOT LIKE '%_lu'`;

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface MyTimeSaved {
  week: string;
  /** `null` : pas de déclaration pour cette semaine. */
  minutes: number | null;
  version: number | null;
  gestures: number;
}

export interface NetworkTimeSaved {
  week: string;
  /** Agents qui ont déclaré, et ceux en activité cette semaine-là qui ne l'ont pas fait. */
  declared: number;
  notDeclared: number;
  /** La somme des dernières déclarations ; `null` sans aucune déclaration. */
  minutes: number | null;
  /** Déclarations de temps gagné sans aucun geste au journal cette semaine-là : un compte, sans nom. */
  withoutGesture: number;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_week' | 'bad_minutes' | 'conflict' } | { ok: false; rule: 'R217'; code: 'week_not_finished' };

export class TempsGagne {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async refuse(viewer: Viewer, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'time_saved', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Un lundi réel, et sa semaine finie à Paris. */
  private checkWeek(week: unknown): Problem | null {
    if (typeof week !== 'string' || !DAY.test(week) || Number.isNaN(Date.parse(`${week}T12:00:00Z`))) return { ok: false, rule: null, code: 'bad_week' };
    // Un 31 février devient un autre jour : il ne repasse pas au même texte.
    if (new Date(`${week}T12:00:00Z`).toISOString().slice(0, 10) !== week || new Date(`${week}T12:00:00Z`).getUTCDay() !== 1) return { ok: false, rule: null, code: 'bad_week' };
    return week >= mondayOf(this.now()) ? { ok: false, rule: 'R217', code: 'week_not_finished' } : null;
  }

  private async agentOnly(viewer: Viewer): Promise<Refusal | null> {
    if (viewer.role !== 'agent') return this.refuse(viewer, 'role');
    const decision = decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId });
    if (!decision.allowed) return this.refuse(viewer, decision.code);
    const blocked = await agentBlocked(this.db, viewer, this.now());
    return blocked ? this.refuse(viewer, blocked) : null;
  }

  private gestures(actor: string, week: string): Promise<{ n: number } | null> {
    return this.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE ${GESTURE}`, [actor, parisDayStart(week).toISOString(), parisDayStart(addDays(week, 7)).toISOString()]);
  }

  /** L'agent déclare pour lui-même : le même chiffre n'ajoute pas de version. */
  async declare(viewer: Viewer, input: { week?: unknown; minutes?: unknown }): Promise<{ ok: true; value: MyTimeSaved } | Refusal | Problem> {
    const refused = await this.agentOnly(viewer);
    if (refused) return refused;
    const problem = this.checkWeek(input.week);
    if (problem) return problem;
    const { minutes } = input;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_MINUTES_SAVED) return { ok: false, rule: null, code: 'bad_minutes' };
    const week = input.week as string;
    const last = await this.latest(viewer.userId, week);
    if (last?.minutes !== minutes) {
      const version = (last?.version ?? 0) + 1;
      const { changes } = await this.db.run('INSERT INTO agent_time_saved (network_id, agent_id, week, version, minutes, declared_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [viewer.networkId, viewer.userId, week, version, minutes, this.now().toISOString()]);
      if (changes !== 1) return { ok: false, rule: null, code: 'conflict' };
      await appendEvent(this.journal, { type: DECLARED, actor: `agent:${viewer.userId}`, subject: `agent:${viewer.userId}`, data: { rule: 'R217', week, version } }, this.now);
    }
    return this.value(viewer, week);
  }

  private latest(agentId: string, week: string): Promise<{ minutes: number; version: number } | null> {
    return this.db.first<{ minutes: number; version: number }>('SELECT minutes, version FROM agent_time_saved WHERE agent_id = ? AND week = ? ORDER BY version DESC LIMIT 1', [agentId, week]);
  }

  private async value(viewer: Viewer, week: string): Promise<{ ok: true; value: MyTimeSaved }> {
    const last = await this.latest(viewer.userId, week);
    const gestures = await this.gestures(`agent:${viewer.userId}`, week);
    return { ok: true, value: { week, minutes: last ? Number(last.minutes) : null, version: last ? Number(last.version) : null, gestures: Number(gestures?.n ?? 0) } };
  }

  /** L'agent lit sa semaine, jamais celle d'un autre [R68]. */
  async mine(viewer: Viewer, week: unknown): Promise<{ ok: true; value: MyTimeSaved } | Refusal | Problem> {
    const refused = await this.agentOnly(viewer);
    if (refused) return refused;
    const problem = this.checkWeek(week);
    if (problem) return problem;
    return this.value(viewer, week as string);
  }

  /** La direction seule : des comptes, aucun agent [R16, R14]. */
  async network(viewer: Viewer, week: unknown): Promise<{ ok: true; value: NetworkTimeSaved } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'role');
    const problem = this.checkWeek(week);
    if (problem) return problem;
    const w = week as string;
    const net = viewer.networkId;
    const rows = await this.db.all<{ agent_id: string; minutes: number }>(
      `SELECT t.agent_id, t.minutes FROM agent_time_saved t
        WHERE t.network_id = ? AND t.week = ? AND t.version = (SELECT MAX(v.version) FROM agent_time_saved v WHERE v.agent_id = t.agent_id AND v.week = t.week)`,
      [net, w],
    );
    const start = parisDayStart(w).toISOString();
    const end = parisDayStart(addDays(w, 7)).toISOString();
    // En activité cette semaine-là : entré avant sa fin, et pas parti avant son début ; sans date de départ, son état.
    const present = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agents a WHERE a.network_id = ? AND a.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM agent_departures d WHERE d.agent_id = a.id AND d.cancelled_at IS NULL AND d.leaves_on < ?)
          AND (a.status = 'active' OR EXISTS (SELECT 1 FROM agent_departures d WHERE d.agent_id = a.id AND d.cancelled_at IS NULL AND d.leaves_on >= ?))`,
      [net, end, w, w],
    );
    let withoutGesture = 0;
    for (const r of rows) {
      if (Number(r.minutes) === 0) continue;
      if (Number((await this.gestures(`agent:${r.agent_id}`, w))?.n ?? 0) === 0) withoutGesture += 1;
    }
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${net}`, data: { kind: 'time_saved', week: w } }, this.now);
    return {
      ok: true,
      value: {
        week: w,
        declared: rows.length,
        notDeclared: Math.max(0, Number(present?.n ?? 0) - rows.length),
        minutes: rows.length > 0 ? rows.reduce((sum, r) => sum + Number(r.minutes), 0) : null,
        withoutGesture,
      },
    };
  }
}
