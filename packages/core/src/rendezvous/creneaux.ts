/**
 * Les créneaux libres d'un agent (M05, V01).
 *
 * L'agent fixe ses disponibilités : des plages par jour de la semaine, heure de Paris, et des exceptions datées qui
 * remplacent la journée (fermée, ou d'autres plages). Son agenda donne les événements occupés, derrière une interface
 * (V03). Un créneau est proposé seulement s'il tient entier dans une plage [R33], ne touche aucun événement occupé
 * [R33] et ne chevauche aucun rendez-vous, temps de trajet compris entre deux rendez-vous sur place [R32].
 * Un appel se fait à distance : il ne demande pas de trajet. Tout se calcule en heure de Paris, changement d'heure compris.
 */
import { localTime } from '../envoi/horaires.ts';

export const APPOINTMENT_KINDS = ['estimation', 'visite', 'signature', 'appel'] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number];

export const AGENDA_TIME_ZONE = 'Europe/Paris';

/** Une plage d'une journée, `HH:MM` à `HH:MM`, heure de Paris. */
export interface DayRange {
  from: string;
  to: string;
}

export interface Availability {
  /** Plages par jour : 1 = lundi … 7 = dimanche. */
  weekly: readonly ({ weekday: number } & DayRange)[];
  /** Une exception remplace toute la journée : sans plage, la journée est fermée. */
  exceptions?: readonly { date: string; ranges: readonly DayRange[] }[];
}

export interface Interval {
  start: Date;
  end: Date;
}

/** Un rendez-vous déjà pris, sur place ou à distance. */
export interface BookedInterval extends Interval {
  kind: AppointmentKind;
}

/** Les événements occupés de l'agenda de l'agent, entre deux instants (V03). */
export interface BusySource {
  busy(agentId: string, from: Date, to: Date): Promise<Interval[]>;
}

export interface SlotSettings {
  /** Durée de chaque type, en minutes. */
  durations: Record<AppointmentKind, number>;
  /** Temps de trajet laissé avant et après un rendez-vous sur place, en minutes [R32]. */
  travelMinutes: number;
  /** Les créneaux commencent toutes les `stepMinutes` à partir du début de la plage. */
  stepMinutes: number;
  /** Délai minimal entre maintenant et le début d'un créneau, en minutes. */
  minNoticeMinutes: number;
  /** Laisser aussi le trajet autour des événements occupés de l'agenda, dont on ne sait pas où ils ont lieu. */
  travelAroundBusy: boolean;
}

export const DEFAULT_SLOT_SETTINGS: SlotSettings = Object.freeze({
  durations: Object.freeze({ estimation: 60, visite: 45, signature: 60, appel: 20 }),
  travelMinutes: 30,
  stepMinutes: 15,
  minNoticeMinutes: 120,
  travelAroundBusy: true,
});

export interface Slot extends Interval {
  kind: AppointmentKind;
}

export const isOnSite = (kind: AppointmentKind): boolean => kind !== 'appel';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = 60_000;

function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error('Heure non valable : HH:MM attendu.');
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Vérifie les disponibilités ; une erreur dit ce qui ne va pas. */
export function checkAvailability(a: Availability): void {
  const ranges = [...a.weekly, ...(a.exceptions ?? []).flatMap((e) => e.ranges)];
  for (const w of a.weekly) {
    if (!Number.isInteger(w.weekday) || w.weekday < 1 || w.weekday > 7) throw new Error('Jour non valable : 1 à 7.');
  }
  for (const e of a.exceptions ?? []) {
    if (!DATE.test(e.date)) throw new Error('Date d’exception non valable : AAAA-MM-JJ.');
  }
  for (const r of ranges) {
    if (minutesOf(r.from) >= minutesOf(r.to)) throw new Error('Une plage finit après son début.');
  }
}

/** Les plages d'une journée, exceptions comprises, en minutes depuis minuit. */
function rangesOn(a: Availability, date: string, weekday: number): [number, number][] {
  const exception = (a.exceptions ?? []).find((e) => e.date === date);
  const ranges = exception ? exception.ranges : a.weekly.filter((w) => w.weekday === weekday);
  return ranges.map((r) => [minutesOf(r.from), minutesOf(r.to)] as [number, number]).sort((x, y) => x[0] - y[0]);
}

/**
 * L'instant d'une heure de Paris. Une heure qui n'existe pas (passage à l'heure d'été) rend `null` ; une heure qui
 * existe deux fois (passage à l'heure d'hiver) rend la première.
 */
export function parisInstant(date: string, minutes: number, timeZone = AGENDA_TIME_ZONE): Date | null {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const found: number[] = [];
  // Paris est à UTC+1 ou UTC+2 : on essaie les décalages possibles.
  for (const offset of [120, 60]) {
    const t = wall - offset * MINUTE;
    const local = localTime(new Date(t), timeZone);
    if (local.date === date && local.minutes === minutes) found.push(t);
  }
  return found.length === 0 ? null : new Date(Math.min(...found));
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const overlaps = (a: Interval, b: Interval, gapMs: number): boolean => a.start.getTime() < b.end.getTime() + gapMs && b.start.getTime() < a.end.getTime() + gapMs;

/** Le créneau tient-il entier dans une plage de l'agent, le même jour [R33] ? */
export function withinAvailability(slot: Interval, a: Availability, timeZone = AGENDA_TIME_ZONE): boolean {
  const s = localTime(slot.start, timeZone);
  const e = localTime(new Date(slot.end.getTime() - MINUTE), timeZone);
  if (s.date !== e.date) return false;
  const length = (slot.end.getTime() - slot.start.getTime()) / MINUTE;
  return rangesOn(a, s.date, s.weekday).some(([from, to]) => {
    if (s.minutes < from) return false;
    const rangeEnd = parisInstant(s.date, to, timeZone);
    const rangeStart = parisInstant(s.date, from, timeZone);
    if (!rangeEnd || !rangeStart) return s.minutes + length <= to;
    return slot.start.getTime() >= rangeStart.getTime() && slot.end.getTime() <= rangeEnd.getTime();
  });
}

/**
 * Ce qui empêche un créneau : `R33` sur un événement occupé, `R32` sur un rendez-vous ou son temps de trajet ;
 * `null` s'il est libre. Sert à la recherche des créneaux et, au moment de réserver, à la vérification (V02).
 */
export function conflictOf(
  slot: Slot,
  booked: readonly BookedInterval[],
  busy: readonly Interval[],
  settings: SlotSettings = DEFAULT_SLOT_SETTINGS,
): 'R32' | 'R33' | null {
  const travel = settings.travelMinutes * MINUTE;
  for (const b of booked) {
    const gap = isOnSite(slot.kind) && isOnSite(b.kind) ? travel : 0;
    if (overlaps(slot, b, gap)) return 'R32';
  }
  const busyGap = isOnSite(slot.kind) && settings.travelAroundBusy ? travel : 0;
  for (const b of busy) {
    if (overlaps(slot, b, busyGap)) return 'R33';
  }
  return null;
}

export interface FreeSlotsInput {
  availability: Availability;
  kind: AppointmentKind;
  from: Date;
  to: Date;
  now: Date;
  booked: readonly BookedInterval[];
  busy: readonly Interval[];
  settings?: SlotSettings;
  timeZone?: string;
}

/** Les créneaux libres d'un type, entre deux instants, dans l'ordre. */
export function freeSlots(input: FreeSlotsInput): Slot[] {
  const settings = input.settings ?? DEFAULT_SLOT_SETTINGS;
  const timeZone = input.timeZone ?? AGENDA_TIME_ZONE;
  checkAvailability(input.availability);
  if (!APPOINTMENT_KINDS.includes(input.kind)) throw new Error('Type de rendez-vous inconnu.');
  const duration = settings.durations[input.kind];
  if (!(duration > 0) || !(settings.stepMinutes > 0)) throw new Error('Durée ou pas non valable.');
  const earliest = Math.max(input.from.getTime(), input.now.getTime() + settings.minNoticeMinutes * MINUTE);
  const slots: Slot[] = [];
  const last = localTime(input.to, timeZone).date;
  for (let date = localTime(new Date(earliest), timeZone).date; date <= last; date = addDays(date, 1)) {
    const weekday = localTime(parisInstant(date, 12 * 60, timeZone)!, timeZone).weekday;
    for (const [from, to] of rangesOn(input.availability, date, weekday)) {
      for (let m = from; m + duration <= to; m += settings.stepMinutes) {
        const start = parisInstant(date, m, timeZone);
        if (!start) continue;
        const slot: Slot = { kind: input.kind, start, end: new Date(start.getTime() + duration * MINUTE) };
        if (start.getTime() < earliest || slot.end.getTime() > input.to.getTime()) continue;
        if (!withinAvailability(slot, input.availability, timeZone)) continue;
        if (conflictOf(slot, input.booked, input.busy, settings) !== null) continue;
        slots.push(slot);
      }
    }
  }
  return slots;
}

/** Les créneaux libres d'un agent, avec les événements occupés de son agenda (V03). */
export async function agentFreeSlots(
  source: BusySource,
  agentId: string,
  input: Omit<FreeSlotsInput, 'busy'>,
): Promise<Slot[]> {
  const travel = (input.settings ?? DEFAULT_SLOT_SETTINGS).travelMinutes * MINUTE;
  const busy = await source.busy(agentId, new Date(input.from.getTime() - travel), new Date(input.to.getTime() + travel));
  return freeSlots({ ...input, busy });
}
