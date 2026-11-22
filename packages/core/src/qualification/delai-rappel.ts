/**
 * L'heure limite du rappel d'un contact (M03, AU042) [R682]. Le délai de la charte ne court que pendant le service :
 * il part de la première heure d'ouverture qui suit l'arrivée du contact, il ne court pas les jours fermés (le dimanche
 * et les jours fériés, par défaut), et une limite qui tombe hors des heures d'ouverture passe à l'ouverture suivante.
 * Un contact du samedi soir n'est donc jamais retiré à son agent pendant que le rappel est fermé.
 *
 * Lecture prudente (le cahier dit seulement « dans le délai de la charte de service ») : la nuit d'un jour ouvert
 * compte, pour qu'un contact du mardi matin ne passe pas plus de deux jours sans rappel ; seule la limite est repoussée
 * au matin. Les heures et les jours sont des réglages, pas des règles.
 */
import { frenchHolidays, localTime, type LocalTime } from '../envoi/horaires.ts';

/** Les heures du service de rappel : minutes depuis minuit, début inclus, fin exclue ; jours 1 = lundi … 7 = dimanche. */
export interface CallbackWindow {
  timeZone: string;
  from: number;
  until: number;
  days: readonly number[];
  /** Les jours fériés de France métropolitaine sont fermés. */
  closedOnHolidays: boolean;
}

/** Du lundi au samedi, de 8 h à 20 h, heure de Paris, hors jours fériés : les heures où l'agent peut rappeler [R01]. */
export const DEFAULT_CALLBACK_WINDOW: CallbackWindow = Object.freeze({
  timeZone: 'Europe/Paris',
  from: 8 * 60,
  until: 20 * 60,
  days: Object.freeze([1, 2, 3, 4, 5, 6]),
  closedOnHolidays: true,
});

const MINUTE = 60_000;

function openDay(local: LocalTime, window: CallbackWindow): boolean {
  if (!window.days.includes(local.weekday)) return false;
  return !(window.closedOnHolidays && frenchHolidays(Number(local.date.slice(0, 4))).has(local.date));
}

/** Le prochain minuit local après `cursor`, changements d'heure compris. */
function nextMidnight(cursor: number, timeZone: string): number {
  const local = localTime(new Date(cursor), timeZone);
  const sinceMinute = ((cursor % MINUTE) + MINUTE) % MINUTE;
  let target = cursor + (1440 - local.minutes) * MINUTE - sinceMinute;
  const after = localTime(new Date(target), timeZone);
  if (after.date === local.date) target += (1440 - after.minutes) * MINUTE;
  else if (after.minutes !== 0) target -= after.minutes * MINUTE;
  return target;
}

/** Le premier instant, à partir de `at`, où le service de rappel est ouvert. */
export function nextCallbackOpening(at: number, window: CallbackWindow = DEFAULT_CALLBACK_WINDOW): number {
  let cursor = at;
  for (let step = 0; step < 800; step += 1) {
    const local = localTime(new Date(cursor), window.timeZone);
    const sinceMinute = ((cursor % MINUTE) + MINUTE) % MINUTE;
    if (openDay(local, window) && local.minutes >= window.from && local.minutes < window.until) return cursor;
    if (openDay(local, window) && local.minutes < window.from) {
      // Vers l'ouverture en heure locale : un changement d'heure en chemin ferait dépasser l'heure d'ouverture, on
      // revient alors juste dessus ; s'il fait tomber trop tôt, le tour suivant avance de nouveau.
      cursor += (window.from - local.minutes) * MINUTE - sinceMinute;
      const after = localTime(new Date(cursor), window.timeZone);
      if (after.date === local.date && after.minutes > window.from) cursor -= (after.minutes - window.from) * MINUTE;
    } else cursor = nextMidnight(cursor, window.timeZone);
  }
  throw new Error('Service de rappel sans ouverture.');
}

/**
 * L'heure limite du rappel d'un contact arrivé à `createdAt` avec un délai de `hours` heures : le délai part de la
 * première ouverture, ne court que les jours ouverts, et une limite hors des heures d'ouverture passe à l'ouverture
 * suivante [R682]. Jamais plus tôt que l'heure écoulée.
 */
export function callbackDeadline(createdAt: number, hours: number, window: CallbackWindow = DEFAULT_CALLBACK_WINDOW): number {
  if (!Number.isFinite(createdAt) || !(hours >= 0)) throw new Error('Délai de rappel non valable.');
  let cursor = nextCallbackOpening(createdAt, window);
  let left = hours * 3_600_000;
  for (let step = 0; left > 0; step += 1) {
    if (step > 2000) throw new Error('Service de rappel sans ouverture.');
    const local = localTime(new Date(cursor), window.timeZone);
    const midnight = nextMidnight(cursor, window.timeZone);
    if (!openDay(local, window)) {
      cursor = midnight;
      continue;
    }
    const room = midnight - cursor;
    if (room >= left) {
      cursor += left;
      left = 0;
    } else {
      left -= room;
      cursor = midnight;
    }
  }
  return nextCallbackOpening(cursor, window);
}

/**
 * L'heure limite d'une tâche « rappeler » telle qu'elle se lit : celle de son attribution par le service de rappel
 * [R682], jamais plus tôt que celle rangée. Une tâche rangée avant R682, en heures écoulées, suit donc la même limite
 * que la réattribution, sans rien réécrire.
 */
export function callbackTaskDue(
  storedDueAt: string,
  attribution: { created_at: string | null; callback_hours: number | null } | null,
  window: CallbackWindow = DEFAULT_CALLBACK_WINDOW,
): string {
  const stored = Date.parse(storedDueAt);
  if (!attribution || attribution.created_at === null || attribution.callback_hours === null) return storedDueAt;
  const computed = callbackDeadline(Date.parse(attribution.created_at), attribution.callback_hours, window);
  return computed > stored ? new Date(computed).toISOString() : storedDueAt;
}
