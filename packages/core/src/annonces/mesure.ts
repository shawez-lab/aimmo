/**
 * Mesure par bien : vues, contacts, visites (M07, P08).
 *
 * Pour une semaine de Paris (lundi au dimanche) : les vues de l'annonce par canal, telles que chaque canal les
 * rapporte ; les contacts reçus pour ce bien (personnes différentes dont un message a été rattaché au bien, C03 et Q01) ;
 * les visites du bien (M05), faites et prévues. Des nombres seulement, aucune donnée sur les personnes. Lue par l'agent
 * du bien et la direction [R16], elle servira le point hebdomadaire au vendeur que fera M08.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { CHANNELS, type Channel } from './publication.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface WeeklyReport {
  /** Le lundi de la semaine, `AAAA-MM-JJ`. */
  week: string;
  views: Record<Channel, number>;
  totalViews: number;
  contacts: number;
  visits: { done: number; planned: number };
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const validDay = (d: string): boolean => {
  if (!DAY.test(d)) return false;
  const t = Date.parse(`${d}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/** Le lundi de la semaine de Paris d'un instant. */
export function mondayOf(at: Date): string {
  const day = localTime(at, TIME_ZONE).date;
  const w = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((w + 6) % 7));
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'unknown_property' | 'bad_day' | 'bad_views' | 'bad_channel' | 'already_recorded' | 'not_monday' };

export class MesureBiens {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Le relevé d'un canal pour un jour passé ou du jour, rangé par le système qui lit les chiffres du canal. */
  async recordViews(networkId: string, propertyId: string, channel: Channel, day: string, views: number): Promise<{ ok: true } | Problem> {
    if (!(CHANNELS as readonly string[]).includes(channel)) return { ok: false, rule: null, code: 'bad_channel' };
    if (typeof day !== 'string' || !validDay(day) || day > localTime(this.now(), TIME_ZONE).date) return { ok: false, rule: null, code: 'bad_day' };
    if (!Number.isInteger(views) || views < 0 || views > 10_000_000) return { ok: false, rule: null, code: 'bad_views' };
    const p = await this.db.first<{ network_id: string }>('SELECT network_id FROM properties WHERE id = ?', [propertyId]);
    if (!p || p.network_id !== networkId) return { ok: false, rule: null, code: 'unknown_property' };
    const { changes } = await this.db.run(
      'INSERT INTO listing_views (id, property_id, network_id, channel, day, views, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (property_id, channel, day) DO NOTHING',
      [this.newId(), propertyId, networkId, channel, day, views, this.now().toISOString()],
    );
    return changes === 1 ? { ok: true } : { ok: false, rule: null, code: 'already_recorded' };
  }

  /** La fiche gardée au bout des fusions actives. */
  private async rootOf(personId: string): Promise<string> {
    let current = personId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const merge = await this.db.first<{ survivor_id: string }>('SELECT survivor_id FROM person_merges WHERE merged_id = ? AND undone_at IS NULL', [current]);
      if (!merge) return current;
      current = merge.survivor_id;
    }
    return current;
  }

  /** La semaine d'un bien, lue par l'agent du bien ou la direction [R16]. */
  async weekly(viewer: Viewer, propertyId: string, monday: string): Promise<{ ok: true; value: WeeklyReport } | Refusal | Problem> {
    if (typeof monday !== 'string' || !validDay(monday)) return { ok: false, rule: null, code: 'bad_day' };
    if (new Date(`${monday}T12:00:00Z`).getUTCDay() !== 1) return { ok: false, rule: null, code: 'not_monday' };
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full' || (viewer.role !== 'agent' && viewer.role !== 'direction')) {
      const code = p.view !== 'full' ? 'not_assigned' : 'role';
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'listing_figures', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    }
    const sunday = addDays(monday, 6);
    const inWeek = (iso: string): boolean => {
      const d = localTime(new Date(iso), TIME_ZONE).date;
      return d >= monday && d <= sunday;
    };
    const views = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;
    for (const r of await this.db.all<{ channel: Channel; views: number }>('SELECT channel, views FROM listing_views WHERE property_id = ? AND day >= ? AND day <= ?', [propertyId, monday, sunday])) {
      views[r.channel] += Number(r.views);
    }
    // Les dates sont en UTC dans la base : on lit une marge d'un jour de chaque côté, puis on garde la semaine de Paris.
    const from = `${addDays(monday, -1)}T00:00:00.000Z`;
    const to = `${addDays(sunday, 2)}T00:00:00.000Z`;
    // Un contact compte à l'heure où son message est arrivé, et une fois par personne : deux fiches réunies sont une
    // seule personne (fusions actives, S04).
    const contactRows = await this.db.all<{ person_id: string; received_at: string }>(
      `SELECT q.person_id, i.received_at FROM qualifications q JOIN inbound_messages i ON i.id = q.inbound_id
       WHERE q.property_id = ? AND i.received_at >= ? AND i.received_at < ?`,
      [propertyId, from, to],
    );
    const roots = new Set<string>();
    for (const r of contactRows.filter((row) => inWeek(row.received_at))) roots.add(await this.rootOf(r.person_id));
    const contacts = roots.size;
    const visitRows = await this.db.all<{ status: string; start_at: string }>(
      "SELECT status, start_at FROM appointments WHERE property_id = ? AND kind = 'visite' AND status IN ('booked', 'honored') AND start_at >= ? AND start_at < ?",
      [propertyId, from, to],
    );
    const week = visitRows.filter((r) => inWeek(r.start_at));
    const value: WeeklyReport = {
      week: monday,
      views,
      totalViews: CHANNELS.reduce((n, c) => n + views[c], 0),
      contacts,
      visits: { done: week.filter((r) => r.status === 'honored').length, planned: week.filter((r) => r.status === 'booked').length },
    };
    return { ok: true, value };
  }
}
