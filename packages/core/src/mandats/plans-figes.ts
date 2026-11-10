/**
 * Le plan du jour figé à 7 h 30, heure de Paris (M20, G02) : le planificateur calcule le plan de chaque agent en
 * activité, une fois par agent et par jour, et le range ; l'agent seul le lit ensuite [R16]. Un plan figé ne change
 * plus. Le journal note le passage et chaque lecture, sans donnée personnelle [R13]. Rien n'est envoyé.
 */
import type { Viewer } from '../acces/droits.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { Acces } from '../acces/acces.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { localDay, PlanDuJour, type DailyPlan, type PlanSequenceSource, type PlanSettings } from './plan-du-jour.ts';

export const DAILY_PLAN_JOB = 'mandats.plan_du_jour';
/** 7 h 30, heure de Paris, tous les jours : le cahier ne prévoit pas de repos pour le plan. */
export const DAILY_PLAN_HOUR = 7;
export const DAILY_PLAN_MINUTE = 30;
const TIME_ZONE = 'Europe/Paris';
const ACTOR = 'system:planificateur';

export interface PlansOptions {
  now?: () => Date;
  settings?: PlanSettings;
  /**
   * Les étapes du jour des séquences de prospection (HX20, BR32), lues à chaque lecture, jamais rangées dans le plan
   * figé : une réponse ou une opposition depuis 7 h 30 les retire [R301, R302].
   */
  sequences?: PlanSequenceSource;
}

/**
 * Le plan figé tel qu'il est lu : les lignes que l'agent peut encore voir maintenant. Une personne rattachée depuis à
 * un autre agent [R16], exclue, arrêtée ou dont l'accord a été retiré depuis 7 h 30 [R36] n'y est plus ; elle est
 * seulement comptée, sans donnée personnelle. Le plan rangé, lui, ne change pas.
 */
export interface FrozenPlan extends DailyPlan {
  hiddenSinceFrozen: number;
}

export type FrozenPlanRead =
  | { ok: true; value: FrozenPlan | null }
  | { ok: false; rule: 'R16'; code: 'not_agent' | 'agent_inactive' };

type StoredItem = DailyPlan['items'][number] & { memberIds?: string[] };

interface DailyPlanRow {
  agent_id: string;
  day: string;
  items: string;
  removed: string;
  computed_at: string;
}

export class PlansDuJour {
  private readonly now: () => Date;
  private readonly plan: PlanDuJour;
  private readonly acces: Acces;
  private readonly unique: FicheUnique;
  private readonly sequences: PlanSequenceSource | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: PlansOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const store = new FicheClient(db, { now: this.now });
    const unique = new FicheUnique(db, store, { now: this.now });
    this.acces = new Acces(db, store, unique, journal, { now: this.now });
    this.unique = unique;
    this.sequences = options.sequences ?? null;
    this.plan = new PlanDuJour(db, unique, { now: this.now, ...(options.settings ? { settings: options.settings } : {}) });
  }

  /**
   * Fige le plan du jour de chaque agent en activité, une fois par agent et par jour. Une panne sur un agent
   * n'arrête pas les autres ; elle remonte ensuite au planificateur, jamais avalée [R13].
   */
  async freezeAll(): Promise<{ frozen: number; already: number }> {
    const day = localDay(this.now(), TIME_ZONE);
    const agents = await this.db.all<{ id: string; network_id: string }>(`SELECT id, network_id FROM agents WHERE status = 'active' ORDER BY network_id, id`);
    let frozen = 0;
    let already = 0;
    let failure: unknown = null;
    for (const agent of agents) {
      try {
        const known = await this.db.first<{ day: string }>('SELECT day FROM daily_plans WHERE agent_id = ? AND day = ?', [agent.id, day]);
        if (known) {
          already += 1;
          continue;
        }
        const viewer: Viewer = { role: 'agent', userId: agent.id, networkId: agent.network_id };
        const result = await this.plan.compute(this.acces, viewer, ACTOR);
        if (!result.ok) continue;
        const plan = result.value;
        // Chaque ligne garde les fiches réunies d'où viennent ses données : une défusion ensuite la masque à la lecture.
        const stored: StoredItem[] = [];
        for (const item of plan.items) stored.push({ ...item, memberIds: [...(await this.unique.membersOf(item.personId))].sort() });
        const { changes } = await this.db.run(
          `INSERT INTO daily_plans (agent_id, day, network_id, items, removed, computed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          [agent.id, day, agent.network_id, JSON.stringify(stored), JSON.stringify(plan.removed), plan.computedAt],
        );
        if (changes !== 1) {
          already += 1;
          continue;
        }
        frozen += 1;
        await appendEvent(
          this.journal,
          {
            type: 'plan_du_jour.fige',
            actor: ACTOR,
            subject: `agent:${agent.id}`,
            data: { day, items: plan.items.length, excluded: plan.removed.excluded, withdrawn: plan.removed.withdrawn, noBasis: plan.removed.noBasis },
          },
          this.now,
        );
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return { frozen, already };
  }

  /** Le plan figé du jour, pour l'agent lui-même seulement [R16] ; null tant qu'il n'est pas encore figé. */
  async read(viewer: Viewer): Promise<FrozenPlanRead> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const refuse = async (code: 'not_agent' | 'agent_inactive'): Promise<FrozenPlanRead> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'daily_plan', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'agent') return refuse('not_agent');
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');
    const day = localDay(this.now(), TIME_ZONE);
    const row = await this.db.first<DailyPlanRow>('SELECT * FROM daily_plans WHERE agent_id = ? AND day = ? AND network_id = ?', [viewer.userId, day, viewer.networkId]);
    await appendEvent(this.journal, { type: 'plan_du_jour.lu', actor, subject: `agent:${viewer.userId}`, data: { rule: 'R16', day, ready: row !== null } }, this.now);
    if (!row) return { ok: true, value: null };
    // Les droits et l'éligibilité de maintenant, pas ceux de 7 h 30.
    const visible = await this.acces.listPersons(viewer);
    if (!visible.ok) return refuse(visible.code === 'agent_inactive' ? 'agent_inactive' : 'not_agent');
    const roots = new Set<string>();
    for (const person of visible.value) roots.add(await this.unique.rootOf(person.id));
    const at = this.now();
    const stored = JSON.parse(row.items) as StoredItem[];
    const items: DailyPlan['items'] = [];
    for (const { memberIds, ...item } of stored) {
      const root = await this.unique.rootOf(item.personId);
      if (!roots.has(root)) continue;
      const ids = await this.unique.membersOf(root);
      // Les fiches réunies ont changé depuis 7 h 30 (fusion ou défusion) : la ligne peut porter des données d'une
      // fiche qui n'est plus celle-ci. Dans le doute, elle n'est pas rendue [R16].
      if (memberIds === undefined || [...ids].sort().join('|') !== memberIds.join('|')) continue;
      // Chaque ligne sous sa propre base légale : une recommandation rappelée ou une relance décidée depuis n'y est plus.
      if (!(await this.plan.eligibility(ids, at, item)).ok) continue;
      items.push(item);
    }
    // Les étapes des séquences se lisent maintenant, revérifiées par leur module ; une source qui refuse n'en donne aucune.
    const steps = this.sequences ? await this.sequences.today(viewer) : null;
    return {
      ok: true,
      value: {
        agentId: row.agent_id,
        day: row.day,
        computedAt: row.computed_at,
        items,
        removed: JSON.parse(row.removed) as DailyPlan['removed'],
        // Les lettres à déposer se lisent maintenant : une lettre déposée depuis 7 h 30 n'y est plus. Aucun nom [R140].
        letters: await this.plan.lettersOf(viewer),
        ...(steps?.ok ? { sequenceSteps: steps.value.steps } : {}),
        hiddenSinceFrozen: stored.length - items.length,
      },
    };
  }
}

/** La tâche du planificateur : le plan du jour de chaque agent, figé à 7 h 30, heure de Paris. */
export function dailyPlanJob(db: SqlDatabase, journal: JournalStore, options: PlansOptions = {}): ScheduledJob {
  return {
    name: DAILY_PLAN_JOB,
    hours: [DAILY_PLAN_HOUR],
    minute: DAILY_PLAN_MINUTE,
    run: async () => {
      await new PlansDuJour(db, journal, options).freezeAll();
    },
  };
}
