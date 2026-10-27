/**
 * La tâche « rappeler » de chaque contact chaud, et la liste des contacts chauds du matin et du soir (M03, Q04).
 * La tâche suit la fiche : elle est chez l'agent qui suit la personne, et la liste ne montre à chacun que les fiches
 * qu'il a le droit de voir [R16]. Une personne exclue ou qui a demandé l'arrêt n'y figure jamais [R25].
 * Rien n'est envoyé ici : l'application de l'agent viendra en janvier.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Temperature } from './note.ts';

export interface CallbackTaskRow {
  id: string;
  network_id: string;
  person_id: string;
  project_id: string | null;
  qualification_id: string;
  dedup_key: string;
  reason: string;
  due_at: string;
  created_at: string;
  done_at: string | null;
}

export interface HotContact {
  taskId: string;
  personId: string;
  firstName: string | null;
  reason: string;
  dueAt: string;
  overdue: boolean;
}

export interface HotList {
  /** Matin avant 14 h, heure de Paris ; soir ensuite. */
  slot: 'morning' | 'evening';
  contacts: HotContact[];
}

export interface RappelOptions {
  timeZone?: string;
  now?: () => Date;
  newId?: () => string;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export class Rappels {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly timeZone: string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly fiche: FicheUnique,
    private readonly journal: JournalStore,
    options: RappelOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.timeZone = options.timeZone ?? 'Europe/Paris';
  }

  /**
   * La tâche « rappeler » d'une qualification chaude et attribuée ; une seule par contact et par projet [R18] ;
   * aucune pour une personne exclue [R25]. Rend la tâche, ou null.
   */
  async forQualification(qualificationId: string): Promise<CallbackTaskRow | null> {
    const q = await this.db.first<{ network_id: string; person_id: string; project_id: string | null }>(
      'SELECT network_id, person_id, project_id FROM qualifications WHERE id = ?',
      [qualificationId],
    );
    if (!q) return null;
    const score = await this.db.first<{ temperature: Temperature; reason: string }>('SELECT temperature, reason FROM contact_scores WHERE qualification_id = ?', [
      qualificationId,
    ]);
    if (score?.temperature !== 'hot') return null;
    const attribution = await this.db.first<{ callback_hours: number; created_at: string }>(
      'SELECT callback_hours, created_at FROM attributions WHERE qualification_id = ?',
      [qualificationId],
    );
    if (!attribution) return null;
    const view = await this.fiche.view(q.person_id);
    const ids = view.members.map((m) => m.id);
    if (await this.excluded(ids)) return null;

    const root = view.person.id;
    const key = `callback:${root}:${q.project_id ?? 'none'}`;
    const at = this.now();
    const due = new Date(Date.parse(attribution.created_at) + attribution.callback_hours * 3_600_000);
    const { changes } = await this.db.run(
      `INSERT INTO callback_tasks (id, network_id, person_id, project_id, qualification_id, dedup_key, reason, due_at, created_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (dedup_key) DO NOTHING`,
      [this.newId(), q.network_id, root, q.project_id, qualificationId, key, score.reason, due.toISOString(), at.toISOString()],
    );
    const task = await this.db.first<CallbackTaskRow>('SELECT * FROM callback_tasks WHERE dedup_key = ?', [key]);
    if (changes === 1 && task) {
      await appendEvent(this.journal, { type: 'rappel.cree', actor: 'system:rappel', subject: `person:${root}`, data: { task: task.id } }, this.now);
    }
    return task;
  }

  /** La tâche est faite : elle garde sa ligne [R17]. Seul celui qui voit la fiche en entier la marque [R16]. */
  async done(acces: Acces, viewer: Viewer, taskId: string): Promise<boolean> {
    const task = await this.db.first<CallbackTaskRow>('SELECT * FROM callback_tasks WHERE id = ? AND network_id = ?', [taskId, viewer.networkId]);
    if (!task) return false;
    const read = await acces.readFiche(viewer, task.person_id);
    if (!read.ok || read.view !== 'full') return false;
    await this.db.run('UPDATE callback_tasks SET done_at = ? WHERE id = ? AND done_at IS NULL', [this.now().toISOString(), taskId]);
    return true;
  }

  /**
   * Les contacts chauds à rappeler : pour un agent, seulement les fiches qu'il suit ; pour la direction, tout le
   * réseau [R16]. Jamais une personne exclue [R25]. La lecture est écrite au journal par les droits d'accès.
   */
  async hotList(acces: Acces, viewer: Viewer): Promise<{ ok: true; value: HotList } | { ok: false; rule: 'R16'; code: string }> {
    const visible = await acces.listPersons(viewer);
    if (!visible.ok) return visible;
    const at = this.now();
    const slot = localTime(at, this.timeZone).minutes < 14 * 60 ? 'morning' : 'evening';
    const ids = visible.value.map((p) => p.id);
    if (ids.length === 0) return { ok: true, value: { slot, contacts: [] } };
    const tasks = await this.db.all<CallbackTaskRow>(
      `SELECT * FROM callback_tasks WHERE network_id = ? AND done_at IS NULL AND person_id IN (${placeholders(ids.length)}) ORDER BY due_at, created_at`,
      [viewer.networkId, ...ids],
    );
    const contacts: HotContact[] = [];
    for (const task of tasks) {
      const view = await this.fiche.view(task.person_id);
      if (await this.excluded(view.members.map((m) => m.id))) continue;
      contacts.push({
        taskId: task.id,
        personId: view.person.id,
        firstName: view.members.map((m) => m.first_name).find((n) => n) ?? null,
        reason: task.reason,
        dueAt: task.due_at,
        overdue: Date.parse(task.due_at) <= at.getTime(),
      });
    }
    return { ok: true, value: { slot, contacts } };
  }

  private async excluded(ids: readonly string[]): Promise<boolean> {
    const at = this.now().toISOString();
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${placeholders(ids.length)}) AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?)`,
      [...ids, at, at],
    );
    return Number(row?.n ?? 0) > 0;
  }
}
