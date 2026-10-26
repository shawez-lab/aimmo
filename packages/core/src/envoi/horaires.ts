/**
 * Heure locale du réseau, à partir d'un instant en temps universel.
 * Le fuseau est un réglage ; Paris par défaut. Les changements d'heure sont gérés par Intl.
 */

export interface LocalTime {
  /** AAAA-MM-JJ dans le fuseau. */
  date: string;
  /** 1 = lundi … 7 = dimanche. */
  weekday: number;
  /** Minutes depuis minuit, 0 à 1439. */
  minutes: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localTime(at: Date, timeZone: string): LocalTime {
  if (Number.isNaN(at.getTime())) throw new Error('Date non valable.');
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(at)) parts[part.type] = part.value;
  const weekday = WEEKDAYS[parts['weekday'] ?? ''];
  if (!weekday) throw new Error(`Jour inconnu pour le fuseau ${timeZone}.`);
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    weekday,
    minutes: Number(parts['hour']) * 60 + Number(parts['minute']),
  };
}

/** Date de Pâques, calendrier grégorien (algorithme anonyme dit de Meeus). */
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const plusDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);

/** Jours fériés de France métropolitaine, lundi de Pentecôte compris, au format AAAA-MM-JJ. */
export function frenchHolidays(year: number): Set<string> {
  const e = easter(year);
  const fixed = ['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25'].map((md) => `${year}-${md}`);
  return new Set([...fixed, iso(plusDays(e, 1)), iso(plusDays(e, 39)), iso(plusDays(e, 50))]);
}

/** Jour ouvré : du lundi au vendredi, hors jour férié. */
export function isWorkingDay(local: LocalTime): boolean {
  if (local.weekday > 5) return false;
  return !frenchHolidays(Number(local.date.slice(0, 4))).has(local.date);
}
