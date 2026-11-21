/**
 * Le calendrier des jours fériés d'un dossier de vente (AU085) [R61].
 *
 * En Moselle, dans le Bas-Rhin et le Haut-Rhin, deux jours sont fériés en plus du calendrier national : le Vendredi
 * saint et le 26 décembre, la Saint-Étienne (code du travail, art. L3134-13). Un délai qui y finit un de ces jours est
 * prolongé au jour ouvrable suivant, comme un samedi, un dimanche ou un jour férié national.
 *
 * Décidé, lecture prudente : le calendrier d'Alsace-Moselle s'applique
 * - au délai de la commune quand le bien y est : c'est sa mairie qui répond ;
 * - au délai de rétractation d'un acquéreur quand le bien y est, ou quand le domicile de cet acquéreur y est ;
 * - à tout délai du dossier quand le lieu du bien n'est pas connu : un jour férié de plus ne fait jamais annoncer trop
 *   tôt la fin d'un délai.
 * Le département se lit sur les deux premiers chiffres du code postal (57, 67, 68) ; la dernière désignation du bien
 * prime sur le code postal de sa fiche (AU002). Un domicile hors de France n'est jamais en Alsace-Moselle.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { latestDomicile } from '../documents/designation.ts';
import { frenchHolidays } from '../envoi/horaires.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';

export const CALENDARS = ['national', 'alsace_moselle'] as const;
export type Calendar = (typeof CALENDARS)[number];

/** Pourquoi un délai suit le calendrier d'Alsace-Moselle ; null pour le calendrier national. */
export type CalendarReason = 'bien' | 'domicile_acquereur' | 'lieu_inconnu' | null;

export const ALSACE_MOSELLE_DEPARTMENTS = ['57', '67', '68'] as const;

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Le dimanche de Pâques, calendrier grégorien (méthode de Meeus). */
function easterSunday(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day, 12);
}

/** Les jours fériés propres à l'Alsace-Moselle : le Vendredi saint et la Saint-Étienne. */
export function alsaceMoselleHolidays(year: number): Set<string> {
  return new Set([iso(easterSunday(year) - 2 * 86_400_000), `${year}-12-26`]);
}

const cache = new Map<string, Set<string>>();

/** Tous les jours fériés d'une année dans un calendrier. */
export function holidaysOf(year: number, calendar: Calendar): Set<string> {
  const key = `${calendar}:${year}`;
  let set = cache.get(key);
  if (!set) {
    set = new Set(frenchHolidays(year));
    if (calendar === 'alsace_moselle') for (const d of alsaceMoselleHolidays(year)) set.add(d);
    cache.set(key, set);
  }
  return set;
}

/** Un jour ouvrable : ni samedi, ni dimanche, ni férié dans ce calendrier. */
export function isWorkingDayIn(day: string, calendar: Calendar): boolean {
  const w = new Date(`${day}T12:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6 && !holidaysOf(Number(day.slice(0, 4)), calendar).has(day);
}

/** Un code postal français de Moselle, du Bas-Rhin ou du Haut-Rhin. */
export function inAlsaceMoselle(postalCode: string | null | undefined): boolean {
  return typeof postalCode === 'string' && /^\d{5}$/.test(postalCode.trim()) && (ALSACE_MOSELLE_DEPARTMENTS as readonly string[]).includes(postalCode.trim().slice(0, 2));
}

const FRANCE = /^(fr|fra|france)$/i;

/** Un domicile en Alsace-Moselle : en France (pays vide ou France) et un code postal de ses départements. */
export function domicileInAlsaceMoselle(d: { postalCode: string | null; country: string | null } | null): boolean {
  if (!d) return false;
  if (d.country !== null && d.country.trim() !== '' && !FRANCE.test(d.country.trim())) return false;
  return inAlsaceMoselle(d.postalCode);
}

/** Le lieu du bien : `alsace_moselle`, `ailleurs`, ou `inconnu` sans code postal valable. */
export function propertyPlace(postalCode: string | null | undefined): 'alsace_moselle' | 'ailleurs' | 'inconnu' {
  if (typeof postalCode !== 'string' || !/^\d{5}$/.test(postalCode.trim())) return 'inconnu';
  return inAlsaceMoselle(postalCode) ? 'alsace_moselle' : 'ailleurs';
}

/** Le calendrier d'un délai, depuis le lieu du bien et, pour la rétractation, le domicile de l'acquéreur. */
export function calendarFor(place: 'alsace_moselle' | 'ailleurs' | 'inconnu', buyerInAlsaceMoselle = false): { calendar: Calendar; reason: CalendarReason } {
  if (place === 'alsace_moselle') return { calendar: 'alsace_moselle', reason: 'bien' };
  if (place === 'inconnu') return { calendar: 'alsace_moselle', reason: 'lieu_inconnu' };
  if (buyerInAlsaceMoselle) return { calendar: 'alsace_moselle', reason: 'domicile_acquereur' };
  return { calendar: 'national', reason: null };
}

/** Le lieu du bien d'un dossier, par sa dernière désignation, sinon le code postal de sa fiche. */
export async function propertyPlaceOf(db: SqlDatabase, propertyId: string): Promise<'alsace_moselle' | 'ailleurs' | 'inconnu'> {
  const row = await db.first<{ postal_code: string | null }>(
    `SELECT COALESCE((SELECT postal_code FROM property_designations d WHERE d.property_id = p.id ORDER BY version DESC LIMIT 1), p.postal_code) AS postal_code
     FROM properties p WHERE p.id = ?`,
    [propertyId],
  );
  return propertyPlace(row?.postal_code ?? null);
}

/**
 * Les acquéreurs dont le dernier domicile saisi est en Alsace-Moselle. Le domicile est cherché sur toutes les fiches
 * réunies en la sienne, comme pour un mandant (AU002) : une saisie faite sur la fiche gardée compte pour l'acquéreur
 * d'une fiche fusionnée, et l'inverse.
 */
export async function buyersInAlsaceMoselle(db: SqlDatabase, personIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = new FicheUnique(db, new FicheClient(db));
  for (const id of personIds) {
    if (!id) continue;
    const person = await db.first<{ network_id: string }>('SELECT network_id FROM persons WHERE id = ?', [id]);
    if (!person) continue;
    const d = await latestDomicile(db, person.network_id, await unique.membersOf(id));
    if (d && domicileInAlsaceMoselle({ postalCode: d.postalCode, country: d.country ?? null })) out.add(id);
  }
  return out;
}
