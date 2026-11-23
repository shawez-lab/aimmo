/**
 * Les créneaux libres d'un agent (M05, V01).
 *
 * L'agent fixe ses disponibilités : des plages par jour de la semaine, heure de Paris, et des exceptions datées qui
 * remplacent la journée (fermée, ou d'autres plages). Son agenda donne les événements occupés, derrière une interface
 * (V03). Un créneau est proposé seulement s'il tient entier dans une plage [R33], ne touche aucun événement occupé
 * [R33] et ne chevauche aucun rendez-vous, temps de trajet compris entre deux rendez-vous sur place [R32]. Deux
 * rendez-vous sur place au même bien s'enchaînent avec la marge du même lieu, plus courte, réglée à part (AU055) : le
 * trajet entre deux lieux différents ne change pas.
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

/** Un rendez-vous déjà pris, sur place ou à distance, et son bien s'il est connu (AU055). */
export interface BookedInterval extends Interval {
  kind: AppointmentKind;
  propertyId?: string | null;
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
  /**
   * Marge laissée entre deux rendez-vous sur place au même bien, en minutes (AU055) : de 0 au trajet réglé, par pas de
   * 5. Absente, le trajet réglé s'applique aussi au même bien.
   */
  samePlaceMinutes?: number;
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
  samePlaceMinutes: 10,
  stepMinutes: 15,
  minNoticeMinutes: 120,
  travelAroundBusy: true,
});

export interface Slot extends Interval {
  kind: AppointmentKind;
  /** Le bien du rendez-vous, s'il est connu : seul un même bien connu ouvre la marge du même lieu (AU055). */
  propertyId?: string | null;
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
    // Les rendez-vous se réservent par tranches de 5 minutes : une plage commence et finit sur l'une d'elles.
    if (minutesOf(r.from) % 5 !== 0 || minutesOf(r.to) % 5 !== 0) throw new Error('Une plage commence et finit sur un multiple de 5 minutes.');
  }
}

/** Les plages d'une journée, exceptions comprises, en minutes depuis minuit. */
function rangesOn(a: Availability, date: string, weekday: number): [number, number][] {
  const exception = (a.exceptions ?? []).find((e) => e.date === date);
  const ranges = exception ? exception.ranges : a.weekly.filter((w) => w.weekday === weekday);
  const sorted = ranges.map((r) => [minutesOf(r.from), minutesOf(r.to)] as [number, number]).sort((x, y) => x[0] - y[0]);
  // Deux plages qui se chevauchent ou se touchent n'en font qu'une : ni créneau en double, ni créneau perdu à la jointure.
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
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

/** La marge du même lieu réglée, ou le trajet s'il n'y en a pas (AU055). */
export const samePlaceMinutesOf = (settings: SlotSettings): number => settings.samePlaceMinutes ?? settings.travelMinutes;

/** Vérifie la marge du même lieu : un multiple de 5 minutes, de 0 au trajet réglé (AU055). */
export function checkSamePlace(settings: SlotSettings): void {
  const m = samePlaceMinutesOf(settings);
  if (!Number.isInteger(m) || m < 0 || m % 5 !== 0 || m > settings.travelMinutes) {
    throw new Error('Marge du même lieu non valable : un multiple de 5 minutes, de 0 au temps de trajet.');
  }
}

/** Deux rendez-vous au même bien connu (AU055). Un bien inconnu d'un côté ne l'est jamais. */
export const samePlace = (a: { propertyId?: string | null }, b: { propertyId?: string | null }): boolean =>
  typeof a.propertyId === 'string' && a.propertyId !== '' && a.propertyId === b.propertyId;

/** L'écart à laisser entre deux rendez-vous, en minutes : rien autour d'un appel, la marge au même bien, sinon le trajet [R32]. */
export function gapMinutes(a: { kind: AppointmentKind; propertyId?: string | null }, b: { kind: AppointmentKind; propertyId?: string | null }, settings: SlotSettings): number {
  if (!isOnSite(a.kind) || !isOnSite(b.kind)) return 0;
  return samePlace(a, b) ? samePlaceMinutesOf(settings) : settings.travelMinutes;
}

const overlaps = (a: Interval, b: Interval, gapMs: number): boolean => a.start.getTime() < b.end.getTime() + gapMs && b.start.getTime() < a.end.getTime() + gapMs;

/**
 * L'instant d'une borne de plage. Une borne dans l'heure qui n'existe pas (passage à l'heure d'été) est ramenée à
 * l'instant du saut, la première minute qui existe après elle : la plage ne s'allonge jamais.
 */
function boundaryInstant(date: string, minutes: number, timeZone: string): Date {
  for (let m = minutes; m <= minutes + 120 && m < 24 * 60; m++) {
    const at = parisInstant(date, m, timeZone);
    if (at) return at;
  }
  // 24:00 ou au-delà : minuit du lendemain.
  return parisInstant(addDays(date, 1), 0, timeZone) ?? new Date(NaN);
}

/** Le créneau tient-il entier dans une plage de l'agent, le même jour [R33] ? Comparé en instants réels. */
export function withinAvailability(slot: Interval, a: Availability, timeZone = AGENDA_TIME_ZONE): boolean {
  const s = localTime(slot.start, timeZone);
  return rangesOn(a, s.date, s.weekday).some(([from, to]) => {
    const rangeStart = boundaryInstant(s.date, from, timeZone);
    const rangeEnd = boundaryInstant(s.date, to, timeZone);
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
    if (overlaps(slot, b, gapMinutes(slot, b, settings) * MINUTE)) return 'R32';
  }
  const busyGap = isOnSite(slot.kind) && settings.travelAroundBusy ? travel : 0;
  for (const b of busy) {
    if (overlaps(slot, b, busyGap)) return 'R33';
  }
  return null;
}

/**
 * La durée propre d'un rendez-vous, choisie par l'agent (AU056) : une contre-visite de 20 minutes, un rendez-vous
 * chez le notaire de 90 minutes. En minutes entières, par pas de 5 (la tranche tenue), de 10 minutes à 8 heures.
 */
export const CUSTOM_DURATION = Object.freeze({ min: 10, max: 480, step: 5 });

/** Vrai si la durée choisie est recevable. */
export function validDuration(minutes: unknown): minutes is number {
  return (
    typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes >= CUSTOM_DURATION.min &&
    minutes <= CUSTOM_DURATION.max &&
    minutes % CUSTOM_DURATION.step === 0
  );
}

export interface FreeSlotsInput {
  availability: Availability;
  kind: AppointmentKind;
  /** La durée propre de ce rendez-vous (AU056) ; absente, celle du type dans les réglages. */
  durationMinutes?: number;
  /** Le bien du rendez-vous à placer, s'il est connu (AU055). */
  propertyId?: string | null;
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
  checkSamePlace(settings);
  if (!APPOINTMENT_KINDS.includes(input.kind)) throw new Error('Type de rendez-vous inconnu.');
  if (input.durationMinutes !== undefined && !validDuration(input.durationMinutes)) throw new Error('Durée non valable.');
  const duration = input.durationMinutes ?? settings.durations[input.kind];
  if (!(duration > 0) || !(settings.stepMinutes > 0)) throw new Error('Durée ou pas non valable.');
  const earliest = Math.max(input.from.getTime(), input.now.getTime() + settings.minNoticeMinutes * MINUTE);
  const slots: Slot[] = [];
  const last = localTime(input.to, timeZone).date;
  for (let date = localTime(new Date(earliest), timeZone).date; date <= last; date = addDays(date, 1)) {
    const weekday = localTime(parisInstant(date, 12 * 60, timeZone)!, timeZone).weekday;
    for (const [from, to] of rangesOn(input.availability, date, weekday)) {
      // Toutes les heures de début de la plage ; la durée se vérifie sur l'intervalle réel, changement d'heure compris.
      for (let m = from; m < to; m += settings.stepMinutes) {
        const start = parisInstant(date, m, timeZone);
        if (!start) continue;
        const slot: Slot = { kind: input.kind, start, end: new Date(start.getTime() + duration * MINUTE), ...(input.propertyId ? { propertyId: input.propertyId } : {}) };
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
