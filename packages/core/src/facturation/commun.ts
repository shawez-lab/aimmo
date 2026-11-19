/** Ce que partagent les trois parties de HX49 : l'accès de la direction seule, les jours de Paris, l'empreinte. */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const TIME_ZONE = 'Europe/Paris';
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type Refusal = { ok: false; rule: 'R16'; code: string };

/**
 * Le numéro d'une facture d'honoraires du réseau, comme K02 l'écrit (`F-2027-00001`) : il n'est pas dans le contenu
 * figé, il se lit dans la ligne (année et numéro). Seules les factures d'honoraires du réseau sont rapprochées.
 */
/**
 * Le numéro d'une facture d'honoraires, comme `Factures` l'écrit : `FAC-` et son numéro officiel pour une facture
 * réelle (AU013), `F-` et le numéro d'essai sinon.
 */
export const LABEL_SQL = (alias = ''): string => {
  const a = alias ? `${alias}.` : 'invoices.';
  return `COALESCE((SELECT 'FAC-' || rn.year || '-' || substr('00000' || rn.number, -5) FROM invoice_real_numbers rn WHERE rn.invoice_id = ${a}id), 'F-' || ${a}year || '-' || substr('00000' || ${a}number, -5))`;
};

export const actorOf = (viewer: Viewer): string => `${String(viewer.role)}:${viewer.userId}`;

/** La direction seule lit et range les chiffres du réseau : factures, banque, relances [R16]. */
export async function directionRefusal(journal: JournalStore, now: () => Date, viewer: Viewer, kind: string): Promise<Refusal | null> {
  let code: string | null = null;
  if (viewer.role !== 'direction') code = 'role';
  else {
    const d = decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId });
    if (!d.allowed) code = d.code;
  }
  if (code === null) return null;
  await appendEvent(journal, { type: 'acces.refuse', actor: actorOf(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, now);
  return { ok: false, rule: 'R16', code };
}

/** Un jour qui existe au calendrier. */
export function validDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY.test(day)) return false;
  const d = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

export const todayInParis = (now: Date): string => localTime(now, TIME_ZONE).date;

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Minuit à Paris, le jour donné, changement d'heure compris. */
export function parisMidnight(day: string): Date {
  for (const offset of [1, 2]) {
    const at = new Date(Date.parse(`${day}T00:00:00Z`) - offset * 3_600_000);
    const l = localTime(at, TIME_ZONE);
    if (l.date === day && l.minutes === 0) return at;
  }
  throw new Error('Minuit introuvable.');
}

export async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Un montant en euros, à la française : « 10 000,00 ». */
export function euros(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  const units = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${units},${String(a % 100).padStart(2, '0')}`;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** « 11 juillet 2027 ». */
export function frenchDay(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}
