/**
 * Les conditions en vigueur d'un mandat signé (D05, D07) : sa durée et son prix, avenants signés compris, et le jour
 * où il n'est plus en cours. Partagé par la diffusion, les échéances, les avenants et les contrôles.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import type { DocumentFacts } from './modeles.ts';

const TIME_ZONE = 'Europe/Paris';

/** Le jour, `AAAA-MM-JJ` à Paris, où le mandat n'est plus en cours : même quantième, N mois plus tard. */
export function mandateEndDay(signedAt: Date, months: number): string {
  const start = localTime(signedAt, TIME_ZONE).date;
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7)) - 1 + months;
  const year = y + Math.floor(m / 12);
  const month = (m % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Number(start.slice(8, 10)), lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface MandateTerms {
  priceEur: number | null;
  durationMonths: number | null;
  /** Les avenants signés, dans l'ordre de leur signature. */
  amendments: { documentId: string; signedAt: string; priceEur: number | null; durationMonths: number | null }[];
}

const readFacts = (raw: string | null): DocumentFacts | null => {
  try {
    return raw ? (JSON.parse(raw) as DocumentFacts) : null;
  } catch {
    return null;
  }
};

/** Les conditions en vigueur d'un mandat : celles du mandat signé, modifiées par ses avenants signés, dans l'ordre. */
export async function mandateTerms(db: SqlDatabase, mandateId: string): Promise<MandateTerms | null> {
  const base = await db.first<{ facts: string | null }>(
    'SELECT d.facts FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ? AND s.copy_content IS NOT NULL',
    [mandateId],
  );
  if (!base) return null;
  const facts = readFacts(base.facts);
  let priceEur = facts?.priceEur ?? null;
  let durationMonths = facts?.durationMonths ?? null;
  const rows = await db.all<{ document_id: string; signed_at: string; facts: string | null }>(
    'SELECT a.document_id, a.signed_at, d.facts FROM signed_amendments a JOIN documents d ON d.id = a.document_id WHERE a.mandate_id = ? ORDER BY a.signed_at, a.created_at, a.document_id',
    [mandateId],
  );
  const amendments: MandateTerms['amendments'] = [];
  for (const row of rows) {
    const f = readFacts(row.facts);
    if (f?.priceEur !== null && f?.priceEur !== undefined) priceEur = f.priceEur;
    if (f?.durationMonths !== null && f?.durationMonths !== undefined) durationMonths = f.durationMonths;
    amendments.push({ documentId: row.document_id, signedAt: row.signed_at, priceEur: f?.priceEur ?? null, durationMonths: f?.durationMonths ?? null });
  }
  return { priceEur, durationMonths, amendments };
}

/** Le mandat est-il échu à cette date (jour de Paris), selon sa durée en vigueur ? Inconnue : échu, par prudence. */
export async function mandateExpired(db: SqlDatabase, mandateId: string, at: Date): Promise<boolean> {
  const signed = await db.first<{ signed_at: string }>('SELECT signed_at FROM signed_documents WHERE mandate_id = ? AND copy_content IS NOT NULL', [mandateId]);
  const terms = await mandateTerms(db, mandateId);
  if (!signed || !terms || terms.durationMonths === null) return true;
  return localTime(at, TIME_ZONE).date >= mandateEndDay(new Date(signed.signed_at), terms.durationMonths);
}
