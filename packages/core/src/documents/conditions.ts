/**
 * Les conditions en vigueur d'un mandat signé (D05, D07) : sa durée et son prix, avenants signés compris, et le jour
 * où il n'est plus en cours. Partagé par la diffusion, les échéances, les avenants et les contrôles.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import type { DocumentFacts, MandateType } from './modeles.ts';

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
  /** Les honoraires en vigueur et qui les paie, avenants compris (AU057). */
  feeEur: number | null;
  feeCharge: 'vendeur' | 'acquereur' | null;
  /** Le type du mandat en vigueur : celui du mandat signé, ou celui qu'un avenant lui a donné (AU057). */
  mandateType: MandateType;
  /** Les avenants signés, dans l'ordre de leur signature, chacun avec le jour où il prend effet (AU057). */
  amendments: {
    documentId: string;
    signedAt: string;
    effectiveOn: string;
    priceEur: number | null;
    durationMonths: number | null;
    feeEur: number | null;
    feeCharge: 'vendeur' | 'acquereur' | null;
    mandateType: MandateType | null;
  }[];
}

const readFacts = (raw: string | null): DocumentFacts | null => {
  try {
    return raw ? (JSON.parse(raw) as DocumentFacts) : null;
  } catch {
    return null;
  }
};

/**
 * Les conditions en vigueur d'un mandat : celles du mandat signé, modifiées par ses avenants signés, dans l'ordre.
 * Avec `asOf`, celles de ce jour-là, à Paris : un avenant signé plus tard, ou dont la date d'effet n'est pas encore
 * venue, ne compte pas encore (D10, AU057). Un avenant ne change les honoraires ou leur charge que s'il le dit.
 */
export async function mandateTerms(
  db: SqlDatabase,
  mandateId: string,
  asOf?: Date,
  /** Un avenant pas encore enregistré, placé à sa date de signature parmi les signés : pour le contrôler (AU057). */
  candidate?: { documentId: string; signedAt: string; facts: DocumentFacts },
): Promise<MandateTerms | null> {
  const base = await db.first<{ facts: string | null; kind: string }>(
    'SELECT d.facts, d.kind FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ? AND s.copy_content IS NOT NULL',
    [mandateId],
  );
  if (!base) return null;
  const facts = readFacts(base.facts);
  let priceEur = facts?.priceEur ?? null;
  let durationMonths = facts?.durationMonths ?? null;
  let feeEur = facts?.feeEur ?? null;
  let feeCharge = facts?.feeCharge ?? null;
  let mandateType: MandateType = base.kind === 'mandat_vente_exclusif' ? 'exclusif' : 'simple';
  const rows = await db.all<{ document_id: string; signed_at: string; facts: string | null }>(
    'SELECT a.document_id, a.signed_at, d.facts FROM signed_amendments a JOIN documents d ON d.id = a.document_id WHERE a.mandate_id = ? ORDER BY a.signed_at, a.created_at, a.document_id',
    [mandateId],
  );
  if (candidate && !rows.some((r) => r.document_id === candidate.documentId)) {
    // Après les avenants signés au même instant : il est enregistré le dernier.
    const at = rows.findIndex((r) => r.signed_at > candidate.signedAt);
    rows.splice(at === -1 ? rows.length : at, 0, { document_id: candidate.documentId, signed_at: candidate.signedAt, facts: JSON.stringify(candidate.facts) });
  }
  const amendments: MandateTerms['amendments'] = [];
  const lastDay = asOf ? localTime(asOf, TIME_ZONE).date : null;
  for (const row of rows) {
    const f = readFacts(row.facts);
    const signedDay = localTime(new Date(row.signed_at), TIME_ZONE).date;
    // Il prend effet à sa signature, ou plus tard au jour qu'il dit ; jamais avant d'être signé.
    const effectiveOn = typeof f?.effectiveOn === 'string' && f.effectiveOn > signedDay ? f.effectiveOn : signedDay;
    if (lastDay !== null && effectiveOn > lastDay) continue;
    if (f?.priceEur !== null && f?.priceEur !== undefined) priceEur = f.priceEur;
    if (f?.durationMonths !== null && f?.durationMonths !== undefined) durationMonths = f.durationMonths;
    if (f?.feeChanged === true) feeEur = f.feeEur ?? null;
    if (f?.feeChargeChanged === true) feeCharge = f.feeCharge ?? null;
    if (f?.mandateType === 'simple' || f?.mandateType === 'exclusif') mandateType = f.mandateType;
    amendments.push({
      documentId: row.document_id,
      signedAt: row.signed_at,
      effectiveOn,
      priceEur: f?.priceEur ?? null,
      durationMonths: f?.durationMonths ?? null,
      feeEur: f?.feeChanged === true ? (f.feeEur ?? null) : null,
      feeCharge: f?.feeChargeChanged === true ? (f.feeCharge ?? null) : null,
      mandateType: f?.mandateType ?? null,
    });
  }
  return { priceEur, durationMonths, feeEur, feeCharge, mandateType, amendments };
}

/** Le mandat est-il échu à cette date (jour de Paris), selon sa durée en vigueur ? Inconnue : échu, par prudence. */
export async function mandateExpired(db: SqlDatabase, mandateId: string, at: Date): Promise<boolean> {
  const signed = await db.first<{ signed_at: string }>('SELECT signed_at FROM signed_documents WHERE mandate_id = ? AND copy_content IS NOT NULL', [mandateId]);
  const terms = await mandateTerms(db, mandateId, at);
  if (!signed || !terms || terms.durationMonths === null) return true;
  return localTime(at, TIME_ZONE).date >= mandateEndDay(new Date(signed.signed_at), terms.durationMonths);
}
