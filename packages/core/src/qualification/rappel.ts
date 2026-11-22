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
import { callbackDeadline, DEFAULT_CALLBACK_WINDOW, type CallbackWindow } from './delai-rappel.ts';
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
  /** Les heures du service de rappel, les mêmes que celles de l'attribution [R682]. */
  callbackWindow?: CallbackWindow;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export class Rappels {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly timeZone: string;
  private readonly callbackWindow: CallbackWindow;

  constructor(
    private readonly db: SqlDatabase,
    private readonly fiche: FicheUnique,
    private readonly journal: JournalStore,
    options: RappelOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.timeZone = options.timeZone ?? 'Europe/Paris';
    this.callbackWindow = options.callbackWindow ?? DEFAULT_CALLBACK_WINDOW;
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
    // Un projet n'appartient qu'à une personne : il suffit à la clé, même après une fusion de fiches. Sans projet,
    // une tâche ouverte sur l'une des fiches réunies vaut pour toutes.
    if (q.project_id === null) {
      const open = await this.db.first<CallbackTaskRow>(
        `SELECT * FROM callback_tasks WHERE person_id IN (${placeholders(ids.length)}) AND project_id IS NULL AND done_at IS NULL ORDER BY created_at LIMIT 1`,
        ids,
      );
      if (open) return open;
    }
    const key = q.project_id === null ? `callback:${root}:none` : `callback:project:${q.project_id}`;
    const at = this.now();
    const due = new Date(callbackDeadline(Date.parse(attribution.created_at), attribution.callback_hours, this.callbackWindow));
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
    if (!task) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'callback_task', code: 'unknown' } }, this.now);
      return false;
    }
    const read = await acces.readFiche(viewer, task.person_id);
    if (!read.ok || read.view !== 'full') return false;
    const { changes } = await this.db.run('UPDATE callback_tasks SET done_at = ? WHERE id = ? AND done_at IS NULL', [this.now().toISOString(), taskId]);
    // Le geste est écrit au journal, une fois, sans donnée personnelle [R13].
    if (changes === 1) await appendEvent(this.journal, { type: 'rappel.fait', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `person:${task.person_id}`, data: { task: taskId } }, this.now);
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
    // Une fiche visible l'est avec ses fiches réunies : la tâche peut être sur la fiche gardée, sans agent, alors que
    // l'agent suit la fiche réunie. `listPersons` a déjà décidé pour la fiche entière [R16].
    const allowed = new Set<string>();
    for (const person of visible.value) {
      for (const id of await this.fiche.membersOf(person.id)) allowed.add(id);
    }
    if (allowed.size === 0) return { ok: true, value: { slot, contacts: [] } };
    const open = await this.db.all<CallbackTaskRow>('SELECT * FROM callback_tasks WHERE network_id = ? AND done_at IS NULL ORDER BY due_at, created_at', [viewer.networkId]);
    const tasks = open.filter((task) => allowed.has(task.person_id));
    const contacts: HotContact[] = [];
    // Une ligne par personne et par projet, même si deux fiches réunies portaient chacune leur tâche.
    const seen = new Set<string>();
    for (const task of tasks) {
      const view = await this.fiche.view(task.person_id);
      const key = `${view.person.id}:${task.project_id ?? 'none'}`;
      if (seen.has(key)) continue;
      seen.add(key);
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
