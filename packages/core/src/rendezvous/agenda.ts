/**
 * L'agenda de l'agent, dans les deux sens (M05, V03), derrière une interface : Google Agenda plus tard (H21), un faux
 * agenda dans les tests.
 *
 *   - Lire : les événements occupés de l'agenda, sans ceux qu'AIMMO y a écrits (ils sont déjà des rendez-vous).
 *   - Écrire : chaque rendez-vous une fois, retrouvé par sa clé ; annulé, son événement est marqué annulé, jamais effacé.
 *     L'agenda ne reçoit que l'heure, le type et un intitulé sans nom ni coordonnée.
 *   - Revenir : un événement déplacé ou annulé dans l'agenda revient sur le rendez-vous, par les mêmes règles qu'un
 *     décalage [R32, R33] ; refusé, le rendez-vous reste où il était, l'événement y est remis et c'est noté.
 * Une panne de l'agenda ne perd aucune réservation : la ligne passe en erreur, est notée, et sera reprise [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import type { AppointmentKind, BusySource, Interval } from './creneaux.ts';
import type { Appointment, RendezVous } from './reservation.ts';

export interface AgendaEvent {
  id: string;
  start: Date;
  end: Date;
  cancelled: boolean;
  /** La clé posée par AIMMO à l'écriture (`aimmo:<rendez-vous>`) ; `null` pour les événements de l'agent. */
  key: string | null;
}

export interface AgendaWrite {
  key: string;
  start: Date;
  end: Date;
  title: string;
  cancelled: boolean;
}

export interface AgendaProvider {
  /** Les événements entre deux instants. */
  events(agentId: string, from: Date, to: Date): Promise<AgendaEvent[]>;
  /** Écrit l'événement de la clé : le crée s'il n'existe pas, sinon le met à jour. Rend son identifiant. */
  write(agentId: string, eventId: string | null, event: AgendaWrite): Promise<{ eventId: string }>;
  /**
   * Les événements changés depuis le curseur (tous au premier appel), et le curseur suivant. Une lecture complète
   * (premier appel, curseur périmé) le dit par `complete`, avec la fenêtre lue (`null` : sans limite) : un événement
   * d'AIMMO absent de cette fenêtre a disparu sans que la suppression soit connue.
   */
  changes(agentId: string, cursor: string | null): Promise<AgendaChanges>;
}

export interface AgendaChanges {
  events: AgendaEvent[];
  cursor: string;
  complete?: { from: Date | null; to: Date | null };
}

export const AGENDA_KEY_PREFIX = 'aimmo:';
const TITLES: Record<AppointmentKind, string> = { estimation: 'Estimation', visite: 'Visite', signature: 'Signature', appel: 'Appel' };
/** L'intitulé de l'événement : le type seul, jamais un nom, un numéro ou une adresse. */
export const agendaTitle = (kind: AppointmentKind): string => `${TITLES[kind]} · AIMMO`;

/** Faux agenda, en mémoire : pour les tests et le mode essai. Peut simuler une panne. */
export class FakeAgenda implements AgendaProvider {
  readonly calendars = new Map<string, Map<string, AgendaEvent & { title: string | null; version: number }>>();
  readonly writes: { agentId: string; event: AgendaWrite }[] = [];
  failWith: Error | null = null;
  private version = 0;
  private next = 0;

  private cal(agentId: string) {
    let c = this.calendars.get(agentId);
    if (!c) this.calendars.set(agentId, (c = new Map()));
    return c;
  }

  /** L'agent ajoute, déplace ou annule un événement lui-même. */
  agentEdit(agentId: string, event: Partial<AgendaEvent> & { id?: string }): string {
    const c = this.cal(agentId);
    const id = event.id ?? `evt-${++this.next}`;
    const before = c.get(id);
    c.set(id, {
      id,
      start: event.start ?? before?.start ?? new Date(0),
      end: event.end ?? before?.end ?? new Date(0),
      cancelled: event.cancelled ?? before?.cancelled ?? false,
      key: before?.key ?? null,
      title: before?.title ?? null,
      version: ++this.version,
    });
    return id;
  }

  async events(agentId: string, from: Date, to: Date): Promise<AgendaEvent[]> {
    if (this.failWith) throw this.failWith;
    return [...this.cal(agentId).values()].filter((e) => e.start < to && e.end > from).map(({ id, start, end, cancelled, key }) => ({ id, start, end, cancelled, key }));
  }

  async write(agentId: string, eventId: string | null, event: AgendaWrite): Promise<{ eventId: string }> {
    if (this.failWith) throw this.failWith;
    const c = this.cal(agentId);
    const existing = eventId ? c.get(eventId) : [...c.values()].find((e) => e.key === event.key);
    const id = existing?.id ?? `evt-${++this.next}`;
    c.set(id, { id, start: event.start, end: event.end, cancelled: event.cancelled, key: existing?.key ?? event.key, title: event.title, version: ++this.version });
    this.writes.push({ agentId, event });
    return { eventId: id };
  }

  async changes(agentId: string, cursor: string | null): Promise<{ events: AgendaEvent[]; cursor: string }> {
    if (this.failWith) throw this.failWith;
    const since = cursor ? Number(cursor) : 0;
    const events = [...this.cal(agentId).values()].filter((e) => e.version > since).map(({ id, start, end, cancelled, key }) => ({ id, start, end, cancelled, key }));
    return { events, cursor: String(this.version) };
  }
}

export interface AgendaSyncResult {
  written: number;
  failed: number;
  moved: number;
  cancelled: number;
  conflicts: number;
}

interface CalendarRow {
  appointment_id: string;
  agent_id: string;
  event_id: string | null;
  synced_status: 'booked' | 'cancelled' | 'replaced' | null;
  synced_start: string | null;
  state: 'pending' | 'synced' | 'error' | 'conflict';
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

export class AgendaSync {
  private readonly now: () => Date;
  /** Les événements dont le déplacement est en train d'être repris : ils ne bloquent pas leur propre rendez-vous. */
  private readonly moving = new Set<string>();
  /** Les seuls agents dont l'agenda est relié (AU053) ; absent, chaque agent qui a des disponibilités. */
  private readonly agents: (() => readonly string[]) | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly provider: AgendaProvider,
    private readonly rdv: RendezVous,
    options: { now?: () => Date; agents?: () => readonly string[] } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.agents = options.agents ?? null;
  }

  /**
   * Les événements occupés de l'agent, pour les créneaux : sans les annulés. Un événement écrit par AIMMO n'est écarté
   * que s'il montre exactement son rendez-vous tenu ; déplacé, allongé ou orphelin, il reste occupé tant qu'il n'est
   * pas réconcilié [R33].
   */
  busySource(): BusySource {
    return {
      busy: async (agentId: string, from: Date, to: Date): Promise<Interval[]> => {
        const out: Interval[] = [];
        for (const e of await this.provider.events(agentId, from, to)) {
          if (e.cancelled || this.moving.has(e.id)) continue;
          if (e.key?.startsWith(AGENDA_KEY_PREFIX)) {
            const a = await this.db.first<{ start_at: string; end_at: string }>(
              "SELECT a.start_at, a.end_at FROM appointment_calendar c JOIN appointments a ON a.id = c.appointment_id WHERE c.agent_id = ? AND c.event_id = ? AND a.status = 'booked'",
              [agentId, e.id],
            );
            if (a && new Date(a.start_at).getTime() === e.start.getTime() && new Date(a.end_at).getTime() === e.end.getTime()) continue;
          }
          out.push({ start: e.start, end: e.end });
        }
        return out;
      },
    };
  }

  private async row(appointmentId: string): Promise<CalendarRow | null> {
    return this.db.first<CalendarRow>('SELECT appointment_id, agent_id, event_id, synced_status, synced_start, state FROM appointment_calendar WHERE appointment_id = ?', [appointmentId]);
  }

  private async setRow(appointmentId: string, agentId: string, fields: Partial<Omit<CalendarRow, 'appointment_id' | 'agent_id'>> & { last_error?: string | null }): Promise<void> {
    const at = this.now().toISOString();
    await this.db.run(`INSERT INTO appointment_calendar (appointment_id, agent_id, state, updated_at) VALUES (?, ?, 'pending', ?) ON CONFLICT DO NOTHING`, [appointmentId, agentId, at]);
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    await this.db.run(`UPDATE appointment_calendar SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE appointment_id = ?`, [
      ...keys.map((k) => (fields[k] ?? null) as string | null),
      at,
      appointmentId,
    ]);
  }

  private async log(type: string, a: Pick<Appointment, 'id' | 'agent_id'>, data: Record<string, string | number | boolean | null>): Promise<void> {
    await appendEvent(this.journal, { type, actor: 'system:agenda', subject: `appointment:${a.id}`, data: { agent: a.agent_id, ...data } }, this.now);
  }

  /** Écrit dans l'agenda chaque rendez-vous qui n'y est pas, ou plus, à jour. */
  async push(agentId?: string): Promise<Pick<AgendaSyncResult, 'written' | 'failed'>> {
    const rows = await this.db.all<Appointment & { c_state: string | null; c_status: string | null; c_start: string | null }>(
      `SELECT a.*, c.state AS c_state, c.synced_status AS c_status, c.synced_start AS c_start
       FROM appointments a LEFT JOIN appointment_calendar c ON c.appointment_id = a.id
       WHERE (? IS NULL OR a.agent_id = ?)
         AND (c.appointment_id IS NULL OR c.state <> 'synced'
              OR (c.synced_status <> 'replaced' AND (c.synced_status <> CASE WHEN a.status = 'cancelled' THEN 'cancelled' ELSE 'booked' END OR c.synced_start <> a.start_at)))
       ORDER BY a.created_at, a.id`,
      [agentId ?? null, agentId ?? null],
    );
    const result = { written: 0, failed: 0 };
    for (const a of rows) {
      if (a.c_status === 'replaced') continue;
      // Un rendez-vous décalé : son événement passe à celui qui le remplace, il n'est jamais montré annulé entre-temps.
      if (a.status === 'cancelled' && (await this.db.first<{ id: string }>('SELECT id FROM appointments WHERE replaces_id = ? LIMIT 1', [a.id]))) {
        const own = await this.row(a.id);
        if (!own?.event_id) await this.setRow(a.id, a.agent_id, { synced_status: 'cancelled', synced_start: a.start_at, state: 'synced', last_error: null });
        continue;
      }
      let current = await this.row(a.id);
      // Un rendez-vous décalé reprend l'événement de celui qu'il remplace : l'agenda n'a jamais deux événements pour lui.
      // La chaîne des décalages est suivie jusqu'au rendez-vous qui tient encore l'événement.
      if (!current?.event_id && a.replaces_id) {
        const chain: string[] = [];
        let back: string | null = a.replaces_id;
        let owner: CalendarRow | null = null;
        while (back && chain.length < 50) {
          chain.push(back);
          owner = await this.row(back);
          if (owner?.event_id) break;
          back = (await this.db.first<{ replaces_id: string | null }>('SELECT replaces_id FROM appointments WHERE id = ?', [back]))?.replaces_id ?? null;
        }
        if (owner?.event_id) {
          for (const id of chain) await this.setRow(id, a.agent_id, { synced_status: 'replaced', state: 'synced' });
          await this.setRow(a.id, a.agent_id, { event_id: owner.event_id });
          current = await this.row(a.id);
        }
      }
      // Un rendez-vous annulé avant d'avoir été écrit n'a rien à montrer dans l'agenda.
      if (!current?.event_id && a.status === 'cancelled') {
        await this.setRow(a.id, a.agent_id, { synced_status: 'cancelled', synced_start: a.start_at, state: 'synced', last_error: null });
        continue;
      }
      const cancelled = a.status === 'cancelled';
      try {
        const { eventId } = await this.provider.write(a.agent_id, current?.event_id ?? null, {
          key: `${AGENDA_KEY_PREFIX}${a.id}`,
          start: new Date(a.start_at),
          end: new Date(a.end_at),
          title: agendaTitle(a.kind),
          cancelled,
        });
        await this.setRow(a.id, a.agent_id, { event_id: eventId, synced_status: cancelled ? 'cancelled' : 'booked', synced_start: a.start_at, state: 'synced', last_error: null });
        result.written++;
      } catch (error) {
        // La réservation reste ; la ligne est reprise au passage suivant.
        await this.setRow(a.id, a.agent_id, { state: 'error', last_error: errorName(error) });
        await this.log('rdv.agenda.panne', a, { step: 'write', error: errorName(error) });
        result.failed++;
      }
    }
    return result;
  }

  /** Ramène sur les rendez-vous ce que l'agent a changé dans son agenda. */
  async pull(agentId: string): Promise<Omit<AgendaSyncResult, 'written' | 'failed'>> {
    const result = { moved: 0, cancelled: 0, conflicts: 0 };
    const cursorRow = await this.db.first<{ cursor: string }>('SELECT cursor FROM agenda_cursors WHERE agent_id = ?', [agentId]);
    let page: AgendaChanges;
    try {
      page = await this.provider.changes(agentId, cursorRow?.cursor ?? null);
    } catch (error) {
      await appendEvent(this.journal, { type: 'rdv.agenda.panne', actor: 'system:agenda', subject: `agent:${agentId}`, data: { step: 'changes', error: errorName(error) } }, this.now);
      throw error;
    }
    for (const event of page.events) {
      // Un événement supprimé peut revenir sans sa clé (Outlook, Apple) : il est retrouvé par son identifiant.
      if (event.key !== null && !event.key.startsWith(AGENDA_KEY_PREFIX)) continue;
      // L'événement peut avoir été repris par un décalage : on suit la chaîne jusqu'au rendez-vous qui le tient.
      const row = await this.db.first<CalendarRow>(
        "SELECT appointment_id, agent_id, event_id, synced_status, synced_start, state FROM appointment_calendar WHERE agent_id = ? AND event_id = ? AND (synced_status IS NULL OR synced_status <> 'replaced') ORDER BY updated_at DESC LIMIT 1",
        [agentId, event.id],
      );
      if (!row) continue;
      const a = await this.rdv.get(row.appointment_id);
      if (!a || a.status !== 'booked') continue;
      if (event.cancelled) {
        await this.rdv.cancelFromAgenda(a.id);
        await this.setRow(a.id, a.agent_id, { synced_status: 'cancelled', synced_start: a.start_at, state: 'synced' });
        result.cancelled++;
        continue;
      }
      if (event.start.getTime() === new Date(a.start_at).getTime()) {
        if (event.end.getTime() === new Date(a.end_at).getTime()) continue;
        // Seule la fin a changé : la durée du type est la règle, l'événement y est remis et c'est noté.
        await this.setRow(a.id, a.agent_id, { state: 'conflict', synced_start: null });
        await this.log('rdv.agenda.conflit', a, { rule: null, code: 'duration' });
        result.conflicts++;
        continue;
      }
      this.moving.add(event.id);
      let moved: Awaited<ReturnType<RendezVous['moveFromAgenda']>>;
      try {
        moved = await this.rdv.moveFromAgenda(a.id, event.start);
      } finally {
        this.moving.delete(event.id);
      }
      if (moved.ok) {
        await this.setRow(a.id, a.agent_id, { synced_status: 'replaced', state: 'synced' });
        // Le nouveau rendez-vous tient le même événement ; il est réécrit au passage pour reprendre la durée du type.
        await this.setRow(moved.appointment.id, a.agent_id, { event_id: event.id, synced_status: 'booked', synced_start: moved.appointment.start_at, state: 'pending' });
        result.moved++;
      } else {
        // Refusé par les règles : le rendez-vous reste où il était, l'événement y sera remis, l'agent le saura.
        await this.setRow(a.id, a.agent_id, { state: 'conflict', synced_start: null });
        await this.log('rdv.agenda.conflit', a, { rule: moved.rule, code: moved.code });
        result.conflicts++;
      }
    }
    if (page.complete) {
      // Lecture complète : un rendez-vous tenu dont l'événement n'y est plus n'est jamais annulé sur ce seul silence.
      // Il reste, son événement est remis au passage suivant, et c'est noté.
      const seen = new Set(page.events.filter((e) => !e.cancelled).map((e) => e.id));
      const now = this.now().toISOString();
      const rows = await this.db.all<{ appointment_id: string; event_id: string; start_at: string }>(
        `SELECT c.appointment_id, c.event_id, a.start_at FROM appointment_calendar c JOIN appointments a ON a.id = c.appointment_id
         WHERE c.agent_id = ? AND c.state = 'synced' AND c.synced_status = 'booked' AND c.event_id IS NOT NULL AND a.status = 'booked' AND a.end_at > ?`,
        [agentId, now],
      );
      const { from, to } = page.complete;
      for (const r of rows) {
        const start = new Date(r.start_at);
        if (seen.has(r.event_id) || (from && start < from) || (to && start >= to)) continue;
        await this.setRow(r.appointment_id, agentId, { state: 'pending', synced_start: null });
        await this.log('rdv.agenda.manquant', { id: r.appointment_id, agent_id: agentId }, {});
      }
    }
    await this.db.run(
      'INSERT INTO agenda_cursors (agent_id, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at',
      [agentId, page.cursor, this.now().toISOString()],
    );
    return result;
  }

  /** Un passage complet : ramener les changements de chaque agent, puis écrire ce qui doit l'être. */
  async run(): Promise<AgendaSyncResult> {
    // Avec des agendas reliés (AU053), seuls leurs agents sont lus et écrits : un agent sans agenda n'est jamais appelé.
    const agents = this.agents
      ? [...new Set(this.agents())].sort().map((agent_id) => ({ agent_id }))
      : await this.db.all<{ agent_id: string }>('SELECT agent_id FROM agent_availabilities ORDER BY agent_id');
    const total: AgendaSyncResult = { written: 0, failed: 0, moved: 0, cancelled: 0, conflicts: 0 };
    let failure: unknown = null;
    for (const { agent_id } of agents) {
      try {
        const r = await this.pull(agent_id);
        total.moved += r.moved;
        total.cancelled += r.cancelled;
        total.conflicts += r.conflicts;
      } catch (error) {
        failure ??= error;
      }
    }
    for (const agentId of this.agents ? agents.map((a) => a.agent_id) : [undefined]) {
      const w = await this.push(agentId);
      total.written += w.written;
      total.failed += w.failed;
    }
    // Une panne n'arrête pas les autres agents ; elle remonte ensuite au planificateur, notée [R13].
    if (failure !== null) throw failure;
    return total;
  }
}

export const AGENDA_JOB = 'rdv.agenda';

/** La tâche du planificateur : l'agenda de chaque agent, chaque heure. */
export function agendaSyncJob(sync: AgendaSync): ScheduledJob {
  return { name: AGENDA_JOB, hours: Array.from({ length: 24 }, (_, h) => h), run: async () => void (await sync.run()) };
}
