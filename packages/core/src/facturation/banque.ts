/**
 * Rapprochement bancaire des factures d'honoraires (M13, HX49) [R15, R16, R17, R551, R552].
 *
 * La direction dépose le relevé de la banque du réseau (CSV : jour ; libellé ; montant). Le code n'en garde, ligne par
 * ligne, que le jour, le montant, l'empreinte de la ligne et les numéros de facture du réseau que le libellé cite : ni
 * le libellé, ni un nom, ni une coordonnée bancaire [R15]. Le même relevé déposé deux fois ne double rien.
 *
 * Le passage rapproche seul une ligne de crédit d'une facture d'honoraires quand il n'y a qu'un choix : la ligne cite
 * le numéro de la facture, le montant est le même au centime, la facture n'est ni rapprochée ni corrigée par un avoir,
 * et aucune autre ligne libre ne cite cette facture au même montant. Sinon, la direction choisit parmi les factures du
 * même montant. Une ligne n'est rapprochée qu'à une seule facture, une facture qu'à une seule ligne : la base le tient,
 * et refuse un autre montant [R551].
 *
 * Jamais vu : l'encaissement des honoraires (K03) se range depuis la facture rapprochée, avec pour preuve la ligne de
 * banque elle-même ; chaque encaissement est ainsi relié à sa facture et à la ligne qui le prouve [R552].
 *
 * Décidé, lecture prudente : pas de paiement partiel ni groupé (un autre montant reste à la direction, qui ne peut pas
 * rapprocher) ; une ligne antérieure au jour de la facture n'est pas rapprochée ; l'instant de l'encaissement est le
 * début du jour de la ligne, à Paris, ou la validation de la facture si elle est du même jour. AIMMO ne reçoit aucun
 * fonds [R62] : le relevé est celui du compte du réseau, lu, jamais touché.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Encaissements } from '../pilotage/encaissements.ts';
import { LABEL_SQL, actorOf, directionRefusal, parisMidnight, sha256, todayInParis, validDay, type Refusal } from './commun.ts';

export const MAX_STATEMENT_LINES = 5000;
/** Un numéro de facture d'honoraires du réseau, tel que K02 les écrit. */
const INVOICE_REF = /\b(?:FAC|F)-\d{4}-\d{5}\b/g;

export interface StatementLine {
  day: string;
  amountCents: number;
  /** Les numéros de facture cités, sans doublon, dans l'ordre. */
  refs: string[];
  /** La ligne, réduite (espaces, majuscules) : seulement pour l'empreinte, jamais rangée. */
  normalized: string;
}

function parseDayCell(cell: string): string | null {
  const iso = cell.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const fr = cell.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const day = iso ? cell : fr ? `${fr[3]}-${fr[2]}-${fr[1]}` : null;
  return day && validDay(day) ? day : null;
}

function parseAmountCell(cell: string): number | null {
  const c = cell.replace(/[\s  ]/g, '').replace(/€$/, '');
  const m = c.match(/^([+-]?)(\d{1,9})(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  const n = Number(m[2]) * 100 + Number((m[3] ?? '0').padEnd(2, '0'));
  return m[1] === '-' ? -n : n;
}

/**
 * Lit un relevé CSV (séparateur `;`, en-tête facultatif). Une ligne illisible arrête tout : rien n'est rangé d'un
 * relevé à moitié lu. Fonction pure.
 */
export function parseStatement(csv: string): { ok: true; value: StatementLine[] } | { ok: false; line: number } {
  const rows = csv.replace(/^﻿/, '').split(/\r?\n/);
  const out: StatementLine[] = [];
  let first = true;
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i]!.trim();
    if (raw === '') continue;
    const cells = raw.split(';').map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
    const header = first && /^(date|jour)$/i.test(cells[0] ?? '');
    first = false;
    if (header) continue;
    if (cells.length !== 3) return { ok: false, line: i + 1 };
    const day = parseDayCell(cells[0]!);
    const amount = parseAmountCell(cells[2]!);
    if (!day || amount === null || amount === 0) return { ok: false, line: i + 1 };
    const label = cells[1]!.toUpperCase();
    const refs = [...new Set(label.match(INVOICE_REF) ?? [])];
    out.push({ day, amountCents: amount, refs, normalized: `${day};${label.replace(/\s+/g, ' ')};${amount}` });
    if (out.length > MAX_STATEMENT_LINES) return { ok: false, line: i + 1 };
  }
  return { ok: true, value: out };
}

export interface Candidate {
  invoiceId: string;
  label: string;
}

export interface Proposal {
  lineId: string;
  day: string;
  amountCents: number;
  cited: string[];
  /** Les factures d'honoraires libres du même montant, du même jour ou d'avant. */
  candidates: Candidate[];
}

export interface Reconciliation {
  lineId: string;
  invoiceId: string;
  label: string;
  day: string;
  amountCents: number;
  mode: 'auto' | 'direction';
  /**
   * L'encaissement des honoraires de la vente, s'il est rangé (BR93) : son jour, l'échéance du versement à l'agent, et
   * si sa preuve est cette ligne de banque ou une autre (rangé par K11). Rendu par `list` seulement.
   */
  receipt?: { receivedAt: string; payoutDueAt: string; proof: 'ligne' | 'autre' } | null;
}

type Problem = { ok: false; rule: null | 'R551' | 'R552'; code: 'bad_statement' | 'unknown_line' | 'unknown_invoice' | 'not_credit' | 'amount' | 'before_invoice' | 'credited' | 'already' | 'not_reconciled' | 'partial' | 'bad_parts' | 'line_exceeded' | 'invoice_exceeded'; line?: number };

/** AU094 · une part d'une ligne de banque rapprochée d'une facture, au centime. */
export interface AllocationPart {
  invoiceId: string;
  amountCents: number;
}

/** AU094 · le solde de chaque ligne partagée et de chaque facture réglée par parts, au centime. */
export interface AllocationBalances {
  lines: { lineId: string; day: string; amountCents: number; allocatedCents: number; remainingCents: number; parts: { invoiceId: string; label: string; amountCents: number }[] }[];
  invoices: { invoiceId: string; label: string; amountCents: number; paidCents: number; remainingCents: number; settled: boolean; lines: { lineId: string; day: string; amountCents: number }[] }[];
}

/** Une facture d'honoraires du réseau qui peut encore être rapprochée : ni rapprochée, ni corrigée par un avoir. */
const FREE_INVOICE = `i.kind = 'honoraires'
  AND NOT EXISTS (SELECT 1 FROM bank_reconciliations r WHERE r.invoice_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM invoices a WHERE a.corrects_invoice_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM bank_allocations p WHERE p.invoice_id = i.id)`;
const FREE_LINE = 'NOT EXISTS (SELECT 1 FROM bank_reconciliations r WHERE r.line_id = l.id) AND NOT EXISTS (SELECT 1 FROM bank_allocations p WHERE p.line_id = l.id)';

export class Rapprochements {
  private readonly now: () => Date;
  private readonly encaissements: Encaissements;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.encaissements = new Encaissements(db, acces, journal, { now: this.now });
  }

  /** Dépose un relevé de la banque du réseau : seules les lignes nouvelles sont rangées [R15, R551]. */
  async importStatement(viewer: Viewer, csv: string): Promise<{ ok: true; added: number; already: number } | Refusal | Problem> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'bank_lines');
    if (refusal) return refusal;
    const parsed = typeof csv === 'string' ? parseStatement(csv) : ({ ok: false, line: 0 } as const);
    if (!parsed.ok) return { ok: false, rule: null, code: 'bad_statement', line: parsed.line };
    const today = todayInParis(this.now());
    if (parsed.value.some((l) => l.day > today)) return { ok: false, rule: null, code: 'bad_statement', line: 0 };
    // Deux lignes identiques d'un même relevé sont deux opérations : leur rang les distingue.
    const seen = new Map<string, number>();
    let added = 0;
    for (const l of parsed.value) {
      const rank = (seen.get(l.normalized) ?? 0) + 1;
      seen.set(l.normalized, rank);
      const id = await sha256(`${viewer.networkId}\n${l.normalized}\n${rank}`);
      const { changes } = await this.db.run(
        'INSERT INTO bank_lines (id, network_id, day, amount_cents, invoice_refs, imported_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [id, viewer.networkId, l.day, l.amountCents, JSON.stringify(l.refs), actorOf(viewer), this.now().toISOString()],
      );
      added += changes;
    }
    await appendEvent(this.journal, { type: 'banque.releve', actor: actorOf(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R551', added, already: parsed.value.length - added } }, this.now);
    return { ok: true, added, already: parsed.value.length - added };
  }

  private async insert(networkId: string, lineId: string, invoiceId: string, mode: 'auto' | 'direction', by: string): Promise<boolean> {
    try {
      const { changes } = await this.db.run(
        'INSERT INTO bank_reconciliations (line_id, invoice_id, network_id, mode, by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [lineId, invoiceId, networkId, mode, by, this.now().toISOString()],
      );
      return changes === 1;
    } catch (error) {
      // La base refuse ce rapprochement (un avoir vient d'être émis, par exemple) : rien n'est rapproché.
      if (error instanceof Error && error.message.includes('bank_reconciliations :')) return false;
      // Toute autre panne va au journal, sans montant, puis remonte [R13].
      await appendEvent(this.journal, { type: 'banque.erreur', actor: 'system:rapprochement', subject: `network:${networkId}`, data: { rule: 'R551', error: error instanceof Error ? error.name : 'unknown' } }, this.now);
      throw error;
    }
  }

  /** Le passage : rapproche seul ce qui ne laisse qu'un choix [R551]. Rend le nombre de rapprochements. */
  async run(networkId: string): Promise<number> {
    const pairs = await this.db.all<{ line_id: string; invoice_id: string; file_id: string }>(
      `SELECT l.id AS line_id, i.id AS invoice_id, i.file_id FROM bank_lines l JOIN invoices i
         ON i.network_id = l.network_id AND i.amount_cents = l.amount_cents AND l.day >= i.issued_on
         AND EXISTS (SELECT 1 FROM json_each(l.invoice_refs) j WHERE j.value = ${LABEL_SQL('i')})
       WHERE l.network_id = ? AND l.amount_cents > 0 AND ${FREE_LINE} AND ${FREE_INVOICE}
       ORDER BY l.day, l.id`,
      [networkId],
    );
    const byLine = new Map<string, number>();
    const byInvoice = new Map<string, number>();
    for (const p of pairs) {
      byLine.set(p.line_id, (byLine.get(p.line_id) ?? 0) + 1);
      byInvoice.set(p.invoice_id, (byInvoice.get(p.invoice_id) ?? 0) + 1);
    }
    let made = 0;
    for (const p of pairs) {
      if (byLine.get(p.line_id) !== 1 || byInvoice.get(p.invoice_id) !== 1) continue;
      if (!(await this.insert(networkId, p.line_id, p.invoice_id, 'auto', 'system:rapprochement'))) continue;
      made += 1;
      await appendEvent(this.journal, { type: 'banque.rapprochement', actor: 'system:rapprochement', subject: `sale_file:${p.file_id}`, data: { rule: 'R551', mode: 'auto', invoice: p.invoice_id, line: p.line_id } }, this.now);
    }
    return made;
  }

  /** Les lignes de crédit encore libres, chacune avec les factures qu'elle pourrait solder : la direction seule [R16]. */
  async proposals(viewer: Viewer): Promise<{ ok: true; value: Proposal[] } | Refusal> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'bank_proposals');
    if (refusal) return refusal;
    const lines = await this.db.all<{ id: string; day: string; amount_cents: number; invoice_refs: string }>(
      `SELECT l.id, l.day, l.amount_cents, l.invoice_refs FROM bank_lines l WHERE l.network_id = ? AND l.amount_cents > 0 AND ${FREE_LINE} ORDER BY l.day, l.id`,
      [viewer.networkId],
    );
    const value: Proposal[] = [];
    for (const l of lines) {
      const candidates = await this.db.all<{ id: string; label: string }>(
        `SELECT i.id, ${LABEL_SQL('i')} AS label FROM invoices i WHERE i.network_id = ? AND i.amount_cents = ? AND i.issued_on <= ? AND ${FREE_INVOICE} ORDER BY i.issued_on, i.number`,
        [viewer.networkId, l.amount_cents, l.day],
      );
      value.push({ lineId: l.id, day: l.day, amountCents: l.amount_cents, cited: JSON.parse(l.invoice_refs) as string[], candidates: candidates.map((c) => ({ invoiceId: c.id, label: c.label })) });
    }
    return { ok: true, value };
  }

  /** La direction rapproche une ligne d'une facture : même montant, chacune libre [R551]. */
  async confirm(viewer: Viewer, lineId: string, invoiceId: string): Promise<{ ok: true; value: Reconciliation } | Refusal | Problem> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'bank_reconciliation');
    if (refusal) return refusal;
    const line = await this.db.first<{ day: string; amount_cents: number }>('SELECT day, amount_cents FROM bank_lines WHERE id = ? AND network_id = ?', [lineId, viewer.networkId]);
    if (!line) return { ok: false, rule: null, code: 'unknown_line' };
    const invoice = await this.db.first<{ kind: string; amount_cents: number; issued_on: string; file_id: string; label: string }>(
      `SELECT kind, amount_cents, issued_on, file_id, ${LABEL_SQL()} AS label FROM invoices WHERE id = ? AND network_id = ?`,
      [invoiceId, viewer.networkId],
    );
    if (!invoice || invoice.kind !== 'honoraires') return { ok: false, rule: null, code: 'unknown_invoice' };
    if (line.amount_cents <= 0) return { ok: false, rule: 'R551', code: 'not_credit' };
    if (line.amount_cents !== invoice.amount_cents) return { ok: false, rule: 'R551', code: 'amount' };
    if (line.day < invoice.issued_on) return { ok: false, rule: 'R551', code: 'before_invoice' };
    if (await this.db.first('SELECT 1 FROM invoices WHERE corrects_invoice_id = ?', [invoiceId])) return { ok: false, rule: 'R551', code: 'credited' };
    if (!(await this.insert(viewer.networkId, lineId, invoiceId, 'direction', actorOf(viewer)))) return { ok: false, rule: 'R551', code: 'already' };
    await appendEvent(this.journal, { type: 'banque.rapprochement', actor: actorOf(viewer), subject: `sale_file:${invoice.file_id}`, data: { rule: 'R551', mode: 'direction', invoice: invoiceId, line: lineId } }, this.now);
    return { ok: true, value: { lineId, invoiceId, label: invoice.label, day: line.day, amountCents: line.amount_cents, mode: 'direction' } };
  }

  /**
   * AU094 · la direction partage une ligne de crédit entre une ou plusieurs factures d'honoraires, au centime : un
   * virement groupé solde plusieurs factures, plusieurs règlements partiels en soldent une. Jamais plus que ce que la
   * ligne apporte, ni que ce que chaque facture demande encore ; une ligne ou une facture déjà rapprochée un à un, ou
   * une facture corrigée par un avoir, n'en prend pas. Tout en une écriture [R551].
   */
  async allocate(viewer: Viewer, lineId: string, parts: unknown): Promise<{ ok: true; value: AllocationBalances } | Refusal | Problem> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'bank_allocation');
    if (refusal) return refusal;
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > 20) return { ok: false, rule: null, code: 'bad_parts' };
    const list: AllocationPart[] = [];
    for (const p of parts as unknown[]) {
      const x = p as Record<string, unknown> | null;
      if (!x || typeof x.invoiceId !== 'string' || !Number.isInteger(x.amountCents) || (x.amountCents as number) <= 0) return { ok: false, rule: null, code: 'bad_parts' };
      if (list.some((y) => y.invoiceId === x.invoiceId)) return { ok: false, rule: null, code: 'bad_parts' };
      list.push({ invoiceId: x.invoiceId, amountCents: x.amountCents as number });
    }
    const line = await this.db.first<{ day: string; amount_cents: number }>('SELECT day, amount_cents FROM bank_lines WHERE id = ? AND network_id = ?', [lineId, viewer.networkId]);
    if (!line) return { ok: false, rule: null, code: 'unknown_line' };
    if (line.amount_cents <= 0) return { ok: false, rule: 'R551', code: 'not_credit' };
    if (await this.db.first('SELECT 1 FROM bank_reconciliations WHERE line_id = ?', [lineId])) return { ok: false, rule: 'R551', code: 'already' };
    const used = await this.db.first<{ n: number | null }>('SELECT SUM(amount_cents) AS n FROM bank_allocations WHERE line_id = ?', [lineId]);
    if (Number(used?.n ?? 0) + list.reduce((a, p) => a + p.amountCents, 0) > line.amount_cents) return { ok: false, rule: 'R551', code: 'line_exceeded' };
    const files: string[] = [];
    for (const p of list) {
      const invoice = await this.db.first<{ kind: string; amount_cents: number; issued_on: string; file_id: string }>('SELECT kind, amount_cents, issued_on, file_id FROM invoices WHERE id = ? AND network_id = ?', [p.invoiceId, viewer.networkId]);
      if (!invoice || invoice.kind !== 'honoraires') return { ok: false, rule: null, code: 'unknown_invoice' };
      if (line.day < invoice.issued_on) return { ok: false, rule: 'R551', code: 'before_invoice' };
      if (await this.db.first('SELECT 1 FROM invoices WHERE corrects_invoice_id = ?', [p.invoiceId])) return { ok: false, rule: 'R551', code: 'credited' };
      if (await this.db.first('SELECT 1 FROM bank_reconciliations WHERE invoice_id = ?', [p.invoiceId])) return { ok: false, rule: 'R551', code: 'already' };
      if (await this.db.first('SELECT 1 FROM bank_allocations WHERE line_id = ? AND invoice_id = ?', [lineId, p.invoiceId])) return { ok: false, rule: 'R551', code: 'already' };
      const paid = await this.db.first<{ n: number | null }>('SELECT SUM(amount_cents) AS n FROM bank_allocations WHERE invoice_id = ?', [p.invoiceId]);
      if (Number(paid?.n ?? 0) + p.amountCents > invoice.amount_cents) return { ok: false, rule: 'R551', code: 'invoice_exceeded' };
      files.push(invoice.file_id);
    }
    const at = this.now().toISOString();
    try {
      await runBatch(
        this.db,
        list.map((p) => ({ sql: 'INSERT INTO bank_allocations (line_id, invoice_id, network_id, amount_cents, by, created_at) VALUES (?, ?, ?, ?, ?, ?)', params: [lineId, p.invoiceId, viewer.networkId, p.amountCents, actorOf(viewer), at] })),
      );
    } catch (error) {
      // Un autre geste est passé entre-temps : la base refuse tout, rien n'est partagé.
      if (error instanceof Error && /bank_allocations :|UNIQUE|PRIMARY/.test(error.message)) return { ok: false, rule: 'R551', code: 'already' };
      throw error;
    }
    for (const [i, p] of list.entries()) {
      await appendEvent(this.journal, { type: 'banque.part', actor: actorOf(viewer), subject: `sale_file:${files[i]}`, data: { rule: 'R551', invoice: p.invoiceId, line: lineId } }, this.now);
    }
    return { ok: true, value: await this.balancesOf(viewer.networkId) };
  }

  /** AU094 · les soldes des lignes partagées et des factures réglées par parts : la direction et le comptable [R16]. */
  async balances(viewer: Viewer): Promise<{ ok: true; value: AllocationBalances } | Refusal> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'bank_allocations', { accountantReads: true });
    if (refusal) return refusal;
    return { ok: true, value: await this.balancesOf(viewer.networkId) };
  }

  private async balancesOf(networkId: string): Promise<AllocationBalances> {
    const rows = await this.db.all<{ line_id: string; invoice_id: string; amount_cents: number; line_day: string; line_amount: number; invoice_amount: number; label: string }>(
      `SELECT a.line_id, a.invoice_id, a.amount_cents, l.day AS line_day, l.amount_cents AS line_amount, i.amount_cents AS invoice_amount, ${LABEL_SQL('i')} AS label
         FROM bank_allocations a JOIN bank_lines l ON l.id = a.line_id JOIN invoices i ON i.id = a.invoice_id
        WHERE a.network_id = ? ORDER BY l.day, a.line_id, i.issued_on, i.number`,
      [networkId],
    );
    const lines = new Map<string, AllocationBalances['lines'][number]>();
    const invoices = new Map<string, AllocationBalances['invoices'][number]>();
    for (const r of rows) {
      const amount = Number(r.amount_cents);
      const l = lines.get(r.line_id) ?? { lineId: r.line_id, day: r.line_day, amountCents: Number(r.line_amount), allocatedCents: 0, remainingCents: Number(r.line_amount), parts: [] };
      l.allocatedCents += amount;
      l.remainingCents = l.amountCents - l.allocatedCents;
      l.parts.push({ invoiceId: r.invoice_id, label: r.label, amountCents: amount });
      lines.set(r.line_id, l);
      const i = invoices.get(r.invoice_id) ?? { invoiceId: r.invoice_id, label: r.label, amountCents: Number(r.invoice_amount), paidCents: 0, remainingCents: Number(r.invoice_amount), settled: false, lines: [] };
      i.paidCents += amount;
      i.remainingCents = i.amountCents - i.paidCents;
      i.settled = i.remainingCents === 0;
      i.lines.push({ lineId: r.line_id, day: r.line_day, amountCents: amount });
      invoices.set(r.invoice_id, i);
    }
    return { lines: [...lines.values()], invoices: [...invoices.values()] };
  }

  /** Les rapprochements du réseau : la direction seule [R16]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: Reconciliation[] } | Refusal> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'bank_reconciliations', { accountantReads: true });
    if (refusal) return refusal;
    const rows = await this.db.all<{ line_id: string; invoice_id: string; label: string; day: string; amount_cents: number; mode: 'auto' | 'direction'; received_at: string | null; payout_due_at: string | null; proof_ref: string | null }>(
      `SELECT r.line_id, r.invoice_id, ${LABEL_SQL('i')} AS label, l.day, l.amount_cents, r.mode, c.received_at, c.payout_due_at, c.proof_ref FROM bank_reconciliations r
         JOIN bank_lines l ON l.id = r.line_id JOIN invoices i ON i.id = r.invoice_id
         LEFT JOIN commission_receipts c ON c.file_id = i.file_id AND c.network_id = r.network_id
       WHERE r.network_id = ? ORDER BY l.day, i.number`,
      [viewer.networkId],
    );
    return {
      ok: true,
      value: rows.map((r) => ({
        lineId: r.line_id,
        invoiceId: r.invoice_id,
        label: r.label,
        day: r.day,
        amountCents: r.amount_cents,
        mode: r.mode,
        // Aucune preuve n'est rendue telle quelle : seulement si c'est cette ligne [R13].
        receipt: r.received_at && r.payout_due_at ? { receivedAt: r.received_at, payoutDueAt: r.payout_due_at, proof: r.proof_ref === `banque:${r.line_id}` ? ('ligne' as const) : ('autre' as const) } : null,
      })),
    };
  }

  /**
   * L'encaissement des honoraires (K03), rangé depuis la facture rapprochée : sa preuve est la ligne de banque [R552].
   * Sans rapprochement, aucun encaissement par ce chemin.
   */
  async recordReceipt(viewer: Viewer, invoiceId: string): Promise<Awaited<ReturnType<Encaissements['recordReceipt']>> | Problem> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'commission_receipt');
    if (refusal) return refusal;
    const r = await this.db.first<{ line_id: string; day: string; file_id: string; invoiced_at: string | null }>(
      `SELECT r.line_id, l.day, i.file_id, (SELECT s.at FROM commission_steps s WHERE s.file_id = i.file_id AND s.status = 'facturee') AS invoiced_at FROM bank_reconciliations r JOIN bank_lines l ON l.id = r.line_id JOIN invoices i ON i.id = r.invoice_id
       WHERE r.invoice_id = ? AND r.network_id = ?`,
      [invoiceId, viewer.networkId],
    );
    if (!r) {
      // AU094 · réglée par parts : soldée au centime, elle s'encaisse au jour de sa dernière part, qui en fait la preuve.
      const parts = await this.db.all<{ line_id: string; day: string; amount_cents: number; file_id: string; invoice_amount: number; invoiced_at: string | null }>(
        `SELECT a.line_id, l.day, a.amount_cents, i.file_id, i.amount_cents AS invoice_amount,
                (SELECT s.at FROM commission_steps s WHERE s.file_id = i.file_id AND s.status = 'facturee') AS invoiced_at
           FROM bank_allocations a JOIN bank_lines l ON l.id = a.line_id JOIN invoices i ON i.id = a.invoice_id
          WHERE a.invoice_id = ? AND a.network_id = ? ORDER BY l.day, a.line_id`,
        [invoiceId, viewer.networkId],
      );
      if (parts.length === 0) return { ok: false, rule: 'R552', code: 'not_reconciled' };
      if (parts.reduce((n, p) => n + Number(p.amount_cents), 0) !== Number(parts[0]!.invoice_amount)) return { ok: false, rule: 'R552', code: 'partial' };
      const last = parts.at(-1)!;
      const begin = parisMidnight(last.day);
      const billed = last.invoiced_at ? new Date(last.invoiced_at) : begin;
      const at = begin.getTime() < billed.getTime() ? billed : begin;
      return this.encaissements.recordReceipt(viewer, last.file_id, { receivedAt: at.toISOString(), proofRef: `banque:${last.line_id}` });
    }
    const start = parisMidnight(r.day);
    // Le début du jour de la ligne ; si la facture a été validée ce jour-là, l'instant de sa validation.
    const invoiced = r.invoiced_at ? new Date(r.invoiced_at) : start;
    const receivedAt = start.getTime() < invoiced.getTime() ? invoiced : start;
    return this.encaissements.recordReceipt(viewer, r.file_id, { receivedAt: receivedAt.toISOString(), proofRef: `banque:${r.line_id}` });
  }
}
