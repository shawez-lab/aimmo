/**
 * Factures fournisseurs lues, puis recomptées par le code (M13, HX49) [R16, R17, R550].
 *
 * Le lecteur (l'IA, derrière une interface) lit la facture déposée : fournisseur, numéro, date, lignes de TVA (base,
 * taux, taxe), totaux hors taxe, TVA et toutes taxes, chaque champ avec sa page. Le code ne croit aucun montant lu : il
 * recompte chaque ligne (base × taux, au centime près), la somme des bases contre le hors taxe, la somme des taxes
 * contre la TVA, le hors taxe et la TVA contre le toutes taxes, et vérifie que chaque taux est un taux français en
 * vigueur. La lecture et ses écarts sont rangés ; la direction range ensuite la facture, telle que lue ou en corrigeant
 * des champs nommés un à un, et seulement si elle se recompte au centime : la base le vérifie à son tour.
 *
 * Décidé, lecture prudente : taux admis 0 %, 2,1 %, 5,5 %, 10 % et 20 % ; la taxe d'une ligne peut s'écarter d'un
 * centime au plus de base × taux (arrondi du fournisseur) ; les totaux, eux, se recomptent exactement ; une date dans le
 * futur est un écart ; une facture déjà rangée (même fournisseur, même numéro) ne se range pas deux fois. Le
 * fournisseur est une entreprise : rien d'un client ne passe au lecteur. Au journal : des identifiants et des codes
 * d'écart, jamais un montant ni un nom [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { actorOf, directionRefusal, todayInParis, validDay, type Refusal } from './commun.ts';

export const VAT_RATES_BP = [0, 210, 550, 1000, 2000] as const;
/** L'écart d'arrondi admis sur la taxe d'une ligne, en centimes. */
export const LINE_ROUNDING_CENTS = 1;
const DOCUMENT_REF = /^[A-Za-z0-9_:./-]{1,200}$/;

export interface Field<T> {
  value: T;
  /** La page de la facture où le champ a été lu. */
  page: number;
}

export interface VatLine {
  baseCents: number;
  rateBp: number;
  vatCents: number;
}

/** Ce que le lecteur rend d'une facture fournisseur, champ par champ. */
export interface SupplierInvoiceRead {
  supplier: Field<string>;
  number: Field<string>;
  issuedOn: Field<string>;
  vatLines: Field<VatLine>[];
  htCents: Field<number>;
  vatCents: Field<number>;
  ttcCents: Field<number>;
}

/** Le lecteur des factures fournisseurs (l'IA) ; `null` s'il n'a rien pu lire. */
export interface LecteurFactures {
  read(documentRef: string): Promise<SupplierInvoiceRead | null>;
}

export type ProblemCode = 'champ' | 'taux' | 'tva_ligne' | 'total_ht' | 'total_tva' | 'total_ttc';

export interface SupplierProblem {
  code: ProblemCode;
  /** Le champ ou la ligne en cause : `supplier`, `vatLines.0`… */
  field: string;
}

const cents = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const pageOk = (p: unknown): boolean => typeof p === 'number' && Number.isSafeInteger(p) && p >= 1 && p <= 500;
const textOk = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length >= 1 && s.length <= max && !/[\u0000-\u001f]/.test(s);

/** Les écarts d'une facture lue ; une liste vide si elle se recompte au centime [R550]. Fonction pure. */
export function checkSupplierInvoice(read: SupplierInvoiceRead, today: string): SupplierProblem[] {
  const problems: SupplierProblem[] = [];
  const field = (name: string, f: Field<unknown> | undefined, ok: boolean) => {
    if (!f || !pageOk(f.page) || !ok) problems.push({ code: 'champ', field: name });
  };
  field('supplier', read.supplier, textOk(read.supplier?.value, 120));
  field('number', read.number, textOk(read.number?.value, 60));
  field('issuedOn', read.issuedOn, validDay(read.issuedOn?.value) && read.issuedOn.value <= today);
  field('htCents', read.htCents, cents(read.htCents?.value));
  field('vatCents', read.vatCents, cents(read.vatCents?.value));
  field('ttcCents', read.ttcCents, cents(read.ttcCents?.value) && read.ttcCents.value > 0);
  const lines = Array.isArray(read.vatLines) ? read.vatLines : [];
  if (lines.length === 0 || lines.length > 20) problems.push({ code: 'champ', field: 'vatLines' });
  let bases = 0;
  let taxes = 0;
  let linesOk = lines.length > 0;
  lines.forEach((l, i) => {
    const v = l?.value;
    if (!l || !pageOk(l.page) || !v || !cents(v.baseCents) || !cents(v.vatCents) || typeof v.rateBp !== 'number') {
      problems.push({ code: 'champ', field: `vatLines.${i}` });
      linesOk = false;
      return;
    }
    if (!(VAT_RATES_BP as readonly number[]).includes(v.rateBp)) {
      problems.push({ code: 'taux', field: `vatLines.${i}` });
    } else if (Math.abs(v.vatCents * 10_000 - v.baseCents * v.rateBp) > LINE_ROUNDING_CENTS * 10_000) {
      // Comparé en entiers : |taxe − base × taux| ≤ 1 centime.
      problems.push({ code: 'tva_ligne', field: `vatLines.${i}` });
    }
    bases += v.baseCents;
    taxes += v.vatCents;
  });
  const ht = read.htCents?.value;
  const vat = read.vatCents?.value;
  const ttc = read.ttcCents?.value;
  if (linesOk && cents(ht) && bases !== ht) problems.push({ code: 'total_ht', field: 'htCents' });
  if (linesOk && cents(vat) && taxes !== vat) problems.push({ code: 'total_tva', field: 'vatCents' });
  if (cents(ht) && cents(vat) && cents(ttc) && ht + vat !== ttc) problems.push({ code: 'total_ttc', field: 'ttcCents' });
  return problems;
}

/** Les champs que la direction peut corriger après la lecture : chacun est nommé, et la facture est recomptée. */
export interface Corrections {
  supplier?: string;
  number?: string;
  issuedOn?: string;
  vatLines?: VatLine[];
  htCents?: number;
  vatCents?: number;
  ttcCents?: number;
}
const CORRECTABLE = ['supplier', 'number', 'issuedOn', 'vatLines', 'htCents', 'vatCents', 'ttcCents'] as const;

export interface ReadView {
  id: string;
  documentRef: string;
  read: SupplierInvoiceRead;
  problems: SupplierProblem[];
  recorded: boolean;
}

export interface SupplierInvoiceView {
  id: string;
  readId: string;
  supplier: string;
  number: string;
  issuedOn: string;
  htCents: number;
  vatCents: number;
  ttcCents: number;
  vatLines: VatLine[];
  corrected: string[];
}

type Problem =
  | { ok: false; rule: null; code: 'bad_document' | 'unreadable' | 'unknown' | 'bad_corrections' | 'already' }
  | { ok: false; rule: 'R550'; code: 'ecart'; problems: SupplierProblem[] };

export class FacturesFournisseurs {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly lecteur: LecteurFactures,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Lit une facture déposée, la recompte et range la lecture avec ses écarts : la direction seule [R16, R550]. */
  async read(viewer: Viewer, documentRef: string): Promise<{ ok: true; value: ReadView } | Refusal | Problem> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'supplier_invoice_read');
    if (refusal) return refusal;
    if (typeof documentRef !== 'string' || !DOCUMENT_REF.test(documentRef)) return { ok: false, rule: null, code: 'bad_document' };
    const read = await this.lecteur.read(documentRef);
    if (!read) {
      await appendEvent(this.journal, { type: 'facture_fournisseur.illisible', actor: actorOf(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R550' } }, this.now);
      return { ok: false, rule: null, code: 'unreadable' };
    }
    const problems = checkSupplierInvoice(read, todayInParis(this.now()));
    const id = this.newId();
    await this.db.run(
      'INSERT INTO supplier_invoice_reads (id, network_id, document_ref, read, problems, read_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, documentRef, JSON.stringify(read), JSON.stringify(problems), actorOf(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'facture_fournisseur.lue', actor: actorOf(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R550', read: id, problems: problems.map((p) => p.code) } }, this.now);
    return { ok: true, value: { id, documentRef, read, problems, recorded: false } };
  }

  /**
   * Range la facture lue, telle que lue ou avec des champs corrigés et nommés : seulement si elle se recompte au
   * centime [R550]. Une seule fois par lecture, et une seule fois par fournisseur et numéro.
   */
  async record(viewer: Viewer, readId: string, corrections: Corrections = {}): Promise<{ ok: true; value: SupplierInvoiceView } | Refusal | Problem> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'supplier_invoice');
    if (refusal) return refusal;
    const row = await this.db.first<{ read: string; network_id: string }>('SELECT read, network_id FROM supplier_invoice_reads WHERE id = ?', [readId]);
    if (!row || row.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    if (typeof corrections !== 'object' || corrections === null || Object.keys(corrections).some((k) => !(CORRECTABLE as readonly string[]).includes(k))) {
      return { ok: false, rule: null, code: 'bad_corrections' };
    }
    const read = JSON.parse(row.read) as SupplierInvoiceRead;
    const corrected = CORRECTABLE.filter((k) => corrections[k] !== undefined);
    // La correction garde la page de la lecture : elle dit quel champ lu la direction a remplacé, pas d'où vient la valeur.
    const merged: SupplierInvoiceRead = {
      supplier: corrections.supplier !== undefined ? { value: corrections.supplier, page: read.supplier?.page ?? 1 } : read.supplier,
      number: corrections.number !== undefined ? { value: corrections.number, page: read.number?.page ?? 1 } : read.number,
      issuedOn: corrections.issuedOn !== undefined ? { value: corrections.issuedOn, page: read.issuedOn?.page ?? 1 } : read.issuedOn,
      vatLines: corrections.vatLines !== undefined ? (Array.isArray(corrections.vatLines) ? corrections.vatLines : []).map((value, i) => ({ value, page: read.vatLines?.[i]?.page ?? 1 })) : read.vatLines,
      htCents: corrections.htCents !== undefined ? { value: corrections.htCents, page: read.htCents?.page ?? 1 } : read.htCents,
      vatCents: corrections.vatCents !== undefined ? { value: corrections.vatCents, page: read.vatCents?.page ?? 1 } : read.vatCents,
      ttcCents: corrections.ttcCents !== undefined ? { value: corrections.ttcCents, page: read.ttcCents?.page ?? 1 } : read.ttcCents,
    };
    const problems = checkSupplierInvoice(merged, todayInParis(this.now()));
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'facture_fournisseur.refusee', actor: actorOf(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R550', read: readId, problems: problems.map((p) => p.code) } }, this.now);
      return { ok: false, rule: 'R550', code: 'ecart', problems };
    }
    const id = this.newId();
    const lines = merged.vatLines.map((l) => ({ baseCents: l.value.baseCents, rateBp: l.value.rateBp, vatCents: l.value.vatCents }));
    const { changes } = await this.db.run(
      `INSERT INTO supplier_invoices (id, network_id, read_id, supplier, number, issued_on, ht_cents, vat_cents, ttc_cents, vat_lines, corrected, recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [id, viewer.networkId, readId, merged.supplier.value.trim(), merged.number.value.trim(), merged.issuedOn.value, merged.htCents.value, merged.vatCents.value, merged.ttcCents.value, JSON.stringify(lines), JSON.stringify(corrected), actorOf(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already' };
    await appendEvent(this.journal, { type: 'facture_fournisseur.rangee', actor: actorOf(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R550', invoice: id, corrected: [...corrected] } }, this.now);
    return {
      ok: true,
      value: { id, readId, supplier: merged.supplier.value.trim(), number: merged.number.value.trim(), issuedOn: merged.issuedOn.value, htCents: merged.htCents.value, vatCents: merged.vatCents.value, ttcCents: merged.ttcCents.value, vatLines: lines, corrected: [...corrected] },
    };
  }

  /** Les factures fournisseurs rangées du réseau, de la plus ancienne à la plus récente : la direction seule [R16]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: SupplierInvoiceView[] } | Refusal> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'supplier_invoices', { accountantReads: true });
    if (refusal) return refusal;
    const rows = await this.db.all<{ id: string; read_id: string; supplier: string; number: string; issued_on: string; ht_cents: number; vat_cents: number; ttc_cents: number; vat_lines: string; corrected: string }>(
      'SELECT id, read_id, supplier, number, issued_on, ht_cents, vat_cents, ttc_cents, vat_lines, corrected FROM supplier_invoices WHERE network_id = ? ORDER BY issued_on, created_at, id',
      [viewer.networkId],
    );
    return {
      ok: true,
      value: rows.map((r) => ({ id: r.id, readId: r.read_id, supplier: r.supplier, number: r.number, issuedOn: r.issued_on, htCents: r.ht_cents, vatCents: r.vat_cents, ttcCents: r.ttc_cents, vatLines: JSON.parse(r.vat_lines) as VatLine[], corrected: JSON.parse(r.corrected) as string[] })),
    };
  }
}
