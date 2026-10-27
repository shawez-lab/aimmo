/**
 * Le statut et le compte rendu des rendez-vous (M05, V06).
 *
 * Seul l'agent du rendez-vous le marque honoré, absent ou annulé. Honoré ou absent se marque une fois le rendez-vous
 * commencé, et ne change plus : la base le garantit. Annulé passe par l'annulation de V02, qui libère le créneau. Un
 * absent ouvre une tâche de suivi chez l'agent, une seule par rendez-vous. L'agent range ensuite son compte rendu, texte
 * dicté ou écrit ; un compte rendu ne change plus, un nouveau peut s'ajouter. Le journal ne porte jamais le texte du
 * compte rendu [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { Viewer } from '../acces/droits.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { RendezVous, type Appointment, type RendezVousOptions } from './reservation.ts';

export type FinalStatus = 'honored' | 'absent' | 'cancelled';
export const FINAL_STATUSES: readonly FinalStatus[] = ['honored', 'absent', 'cancelled'];
export type ReportOrigin = 'dictated' | 'typed';

export type StatusRefusal = 'unknown' | 'not_agent' | 'bad_status' | 'not_booked' | 'too_early';
export type StatusResult = { ok: true; appointment: Appointment; taskId: string | null } | { ok: false; code: StatusRefusal };
export type ReportRefusal = 'unknown' | 'not_agent' | 'not_done' | 'empty' | 'too_long' | 'bad_origin';
export type ReportResult = { ok: true; id: string } | { ok: false; code: ReportRefusal };

export interface AppointmentReport {
  id: string;
  appointment_id: string;
  agent_id: string;
  origin: ReportOrigin;
  text: string;
  created_at: string;
}

export interface AppointmentTask {
  id: string;
  appointment_id: string;
  agent_id: string;
  person_id: string;
  kind: 'follow_absent';
  due_at: string;
  created_at: string;
  done_at: string | null;
}

export interface StatutOptions extends Pick<RendezVousOptions, 'now' | 'newId'> {
  /** Longueur maximale d'un compte rendu, en caractères. */
  maxReportLength?: number;
}

export class StatutRendezVous {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly maxReportLength: number;
  private readonly rdv: RendezVous;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: StatutOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.maxReportLength = options.maxReportLength ?? 20_000;
    this.rdv = new RendezVous(db, journal, { now: this.now });
  }

  /** Le rendez-vous, s'il est celui de cet agent, dans son réseau. */
  private async mine(viewer: Viewer, id: string): Promise<{ ok: true; appointment: Appointment } | { ok: false; code: 'unknown' | 'not_agent' }> {
    const appointment = await this.rdv.get(id);
    if (!appointment || appointment.network_id !== viewer.networkId) return { ok: false, code: 'unknown' };
    if (viewer.role !== 'agent' || viewer.userId !== appointment.agent_id) return { ok: false, code: 'not_agent' };
    return { ok: true, appointment };
  }

  /** L'agent du rendez-vous, lui seul, le marque honoré, absent ou annulé ; un statut final ne change plus. */
  async mark(viewer: Viewer, id: string, status: FinalStatus): Promise<StatusResult> {
    if (!FINAL_STATUSES.includes(status)) return { ok: false, code: 'bad_status' };
    const found = await this.mine(viewer, id);
    if (!found.ok) return found;
    if (status === 'cancelled') {
      const cancelled = await this.rdv.cancelAsAgent(viewer, id);
      return cancelled.ok ? { ok: true, appointment: cancelled.appointment, taskId: null } : { ok: false, code: cancelled.code };
    }
    const now = this.now();
    if (found.appointment.status !== 'booked') return { ok: false, code: 'not_booked' };
    if (now.getTime() < new Date(found.appointment.start_at).getTime()) return { ok: false, code: 'too_early' };
    const at = now.toISOString();
    // Une seule instruction : deux marques en même temps, une seule passe.
    const done = await this.db.run("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ? AND status = 'booked'", [status, at, id]);
    if (done.changes !== 1) return { ok: false, code: 'not_booked' };
    let taskId: string | null = null;
    if (status === 'absent') {
      taskId = this.newId();
      const inserted = await this.db.run(
        `INSERT INTO appointment_tasks (id, appointment_id, network_id, agent_id, person_id, kind, due_at, created_at) VALUES (?, ?, ?, ?, ?, 'follow_absent', ?, ?) ON CONFLICT DO NOTHING`,
        [taskId, id, found.appointment.network_id, found.appointment.agent_id, found.appointment.person_id, at, at],
      );
      if (inserted.changes !== 1) taskId = (await this.db.first<{ id: string }>('SELECT id FROM appointment_tasks WHERE appointment_id = ?', [id]))?.id ?? null;
    }
    const appointment = (await this.rdv.get(id))!;
    await appendEvent(
      this.journal,
      { type: 'rdv.statut', actor: `agent:${viewer.userId}`, subject: `appointment:${id}`, data: { agent: appointment.agent_id, kind: appointment.kind, status, task: taskId !== null } },
      this.now,
    );
    return { ok: true, appointment, taskId };
  }

  /** L'agent du rendez-vous range son compte rendu, une fois le rendez-vous honoré ou absent. */
  async report(viewer: Viewer, id: string, input: { text: string; origin: ReportOrigin }): Promise<ReportResult> {
    if (input.origin !== 'dictated' && input.origin !== 'typed') return { ok: false, code: 'bad_origin' };
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text === '') return { ok: false, code: 'empty' };
    if (text.length > this.maxReportLength) return { ok: false, code: 'too_long' };
    const found = await this.mine(viewer, id);
    if (!found.ok) return found;
    if (found.appointment.status !== 'honored' && found.appointment.status !== 'absent') return { ok: false, code: 'not_done' };
    const reportId = this.newId();
    await this.db.run('INSERT INTO appointment_reports (id, appointment_id, network_id, agent_id, origin, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      reportId,
      id,
      found.appointment.network_id,
      viewer.userId,
      input.origin,
      text,
      this.now().toISOString(),
    ]);
    // Le journal ne porte jamais le texte du compte rendu, ni sa longueur exacte [R13].
    await appendEvent(
      this.journal,
      { type: 'rdv.compte_rendu', actor: `agent:${viewer.userId}`, subject: `appointment:${id}`, data: { agent: viewer.userId, origin: input.origin } },
      this.now,
    );
    return { ok: true, id: reportId };
  }

  /** Les comptes rendus d'un rendez-vous, pour son seul agent. */
  async reports(viewer: Viewer, id: string): Promise<{ ok: true; reports: AppointmentReport[] } | { ok: false; code: 'unknown' | 'not_agent' }> {
    const found = await this.mine(viewer, id);
    if (!found.ok) return found;
    const reports = await this.db.all<AppointmentReport>(
      'SELECT id, appointment_id, agent_id, origin, text, created_at FROM appointment_reports WHERE appointment_id = ? ORDER BY created_at, rowid',
      [id],
    );
    return { ok: true, reports };
  }

  /** Les tâches ouvertes de l'agent. */
  async openTasks(viewer: Viewer): Promise<AppointmentTask[]> {
    if (viewer.role !== 'agent') return [];
    return this.db.all<AppointmentTask>(
      'SELECT id, appointment_id, agent_id, person_id, kind, due_at, created_at, done_at FROM appointment_tasks WHERE agent_id = ? AND network_id = ? AND done_at IS NULL ORDER BY due_at, id',
      [viewer.userId, viewer.networkId],
    );
  }

  /** L'agent marque sa tâche faite ; la ligne reste. */
  async taskDone(viewer: Viewer, taskId: string): Promise<{ ok: true } | { ok: false; code: 'unknown' | 'not_agent' | 'already_done' }> {
    const task = await this.db.first<{ agent_id: string; network_id: string; done_at: string | null }>('SELECT agent_id, network_id, done_at FROM appointment_tasks WHERE id = ?', [taskId]);
    if (!task || task.network_id !== viewer.networkId) return { ok: false, code: 'unknown' };
    if (viewer.role !== 'agent' || viewer.userId !== task.agent_id) return { ok: false, code: 'not_agent' };
    const done = await this.db.run('UPDATE appointment_tasks SET done_at = ? WHERE id = ? AND done_at IS NULL', [this.now().toISOString(), taskId]);
    if (done.changes !== 1) return { ok: false, code: 'already_done' };
    await appendEvent(this.journal, { type: 'rdv.tache_faite', actor: `agent:${viewer.userId}`, subject: `task:${taskId}`, data: {} }, this.now);
    return { ok: true };
  }
}
