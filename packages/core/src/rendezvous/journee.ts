/**
 * Les rendez-vous du jour de l'agent, avec leur brief rangé (A02), pour l'écran « Ma journée » de son application.
 *
 * Seul l'agent lui-même, en activité, lit ses rendez-vous [R16] ; la lecture est écrite au journal avant que la
 * donnée soit rendue, avec le seul nombre de rendez-vous [R13]. Le jour est celui de Paris. Un rendez-vous annulé
 * n'est pas rendu. Rien n'est envoyé.
 *
 * Décidé, lecture prudente : le prénom du client et le brief ne sont rendus que si l'agent a encore, maintenant, le
 * droit de voir la fiche du client, fusions comprises. Le brief rangé avant une fusion ou une défusion de la fiche peut
 * porter des données d'une fiche qui n'est plus celle-ci : dans le doute, il n'est pas rendu. Dans ces deux cas, la
 * ligne dit seulement pourquoi, sans donnée.
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { localDay } from '../mandats/plan-du-jour.ts';
import type { Brief } from './brief.ts';
import { AGENDA_TIME_ZONE, parisInstant, type AppointmentKind } from './creneaux.ts';

export interface DayAppointment {
  id: string;
  kind: AppointmentKind;
  start: string;
  end: string;
  status: 'booked' | 'honored' | 'absent';
  /** Prénom du client, seulement si l'agent voit sa fiche maintenant. */
  firstName: string | null;
  brief: Brief | null;
  /** Pourquoi le brief manque : pas encore prêt, fiche hors des droits de l'agent, ou fiche changée depuis. */
  briefMissing: 'not_ready' | 'no_access' | 'changed' | null;
}

export interface DayAppointments {
  /** Jour, `AAAA-MM-JJ`, heure de Paris. */
  day: string;
  appointments: DayAppointment[];
}

export type DayAppointmentsRead = { ok: true; value: DayAppointments } | { ok: false; rule: 'R16'; code: 'not_agent' | 'agent_inactive' };

interface Row {
  id: string;
  network_id: string;
  agent_id: string;
  person_id: string;
  kind: AppointmentKind;
  start_at: string;
  end_at: string;
  status: DayAppointment['status'];
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Le jour suivant, `AAAA-MM-JJ`. */
const nextDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export class JourneeRendezVous {
  private readonly now: () => Date;
  private readonly unique: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.unique = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  async read(viewer: Viewer): Promise<DayAppointmentsRead> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const refuse = async (code: 'not_agent' | 'agent_inactive'): Promise<DayAppointmentsRead> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'day_appointments', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'agent') return refuse('not_agent');
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');

    const day = localDay(this.now(), AGENDA_TIME_ZONE);
    const from = parisInstant(day, 0);
    const to = parisInstant(nextDay(day), 0);
    if (!from || !to) throw new Error('day_bounds');
    const rows = await this.db.all<Row>(
      `SELECT id, network_id, agent_id, person_id, kind, start_at, end_at, status FROM appointments
       WHERE network_id = ? AND agent_id = ? AND status <> 'cancelled' AND start_at >= ? AND start_at < ?
       ORDER BY start_at, id`,
      [viewer.networkId, viewer.userId, from.toISOString(), to.toISOString()],
    );

    const appointments: DayAppointment[] = [];
    for (const row of rows) {
      const ids = await this.unique.membersOf(row.person_id);
      const members = await this.db.all<{ agent_id: string | null; network_id: string }>(`SELECT agent_id, network_id FROM persons WHERE id IN (${placeholders(ids.length)})`, ids);
      const allowed =
        members.length === ids.length &&
        members.every((m) => m.network_id === viewer.networkId) &&
        decideAccess(viewer, { kind: 'person', networkId: viewer.networkId, agentIds: members.map((m) => m.agent_id) }).allowed;
      let firstName: string | null = null;
      let brief: Brief | null = null;
      let briefMissing: DayAppointment['briefMissing'] = null;
      if (!allowed) {
        briefMissing = 'no_access';
      } else {
        const root = await this.unique.rootOf(row.person_id);
        const person = await this.db.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ?', [root]);
        firstName = person?.first_name ?? null;
        const stored = await this.db.first<{ content: string; agent_id: string; prepared_at: string }>(
          'SELECT content, agent_id, prepared_at FROM appointment_briefs WHERE appointment_id = ? AND network_id = ?',
          [row.id, viewer.networkId],
        );
        // Le brief suit l'agent qui l'a reçu : un rendez-vous passé à un autre agent ne lui ouvre pas l'ancien brief.
        if (!stored || stored.agent_id !== viewer.userId) {
          briefMissing = 'not_ready';
        } else {
          const touched = [...new Set([...ids, row.person_id])];
          const list = placeholders(touched.length);
          const changed = await this.db.first<{ id: string }>(
            `SELECT id FROM person_merges WHERE network_id = ? AND (survivor_id IN (${list}) OR merged_id IN (${list}))
             AND (merged_at > ? OR (undone_at IS NOT NULL AND undone_at > ?)) LIMIT 1`,
            [viewer.networkId, ...touched, ...touched, stored.prepared_at, stored.prepared_at],
          );
          if (changed) briefMissing = 'changed';
          else brief = JSON.parse(stored.content) as Brief;
        }
      }
      appointments.push({ id: row.id, kind: row.kind, start: row.start_at, end: row.end_at, status: row.status, firstName, brief, briefMissing });
    }
    await appendEvent(
      this.journal,
      { type: 'rdv.jour.lu', actor, subject: `agent:${viewer.userId}`, data: { rule: 'R16', day, appointments: appointments.length, briefs: appointments.filter((a) => a.brief).length } },
      this.now,
    );
    return { ok: true, value: { day, appointments } };
  }
}
