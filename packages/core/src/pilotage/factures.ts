/**
 * Factures d'honoraires et de reversement, en mode essai (M13, K02) [R13, R15, R16, R17, R18, R26, R67, R71].
 *
 * À la commission due (K01), le code prépare :
 * - la facture d'honoraires du réseau au client qui les paie (le vendeur du mandat ou l'acquéreur, selon le mandat) ;
 * - une facture de reversement par agent qui a une part (l'agent de la vente, l'agent qui partage), émise au nom de
 *   l'agent au réseau.
 * La direction valide chaque brouillon : la facture reçoit le numéro suivant de son émetteur pour l'année, sans trou ni
 * doublon, dans l'ordre des jours, même en deux validations simultanées ; son contenu est figé ; elle part à la
 * plateforme agréée de facturation électronique par une interface, en mode essai seulement tant que H26 n'est pas
 * fait. Une facture ne change ni ne s'efface : un avoir, numéroté dans la même suite, la corrige, et un nouveau
 * brouillon peut alors être préparé. La facture d'honoraires validée passe la commission à « facturée ». L'export
 * comptable, au format tableur, recompte les montants au centime.
 *
 * Décidé, lecture prudente : TVA de 20 % sur les honoraires du réseau ; aucune TVA sur les reversements tant que
 * l'expert-comptable n'a pas validé leurs modalités (H26), ce que la facture dit ; chaque facture porte « facture
 * d'essai, sans valeur comptable » ; la prime de parrainage n'est facturée qu'après l'encaissement (K03, R83) ; une
 * part nulle ne donne pas de facture ; aucune coordonnée bancaire nulle part [R15].
 */
import { ROLES, decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Acces } from '../acces/acces.ts';
import { Commissions } from './commissions.ts';

const TIME_ZONE = 'Europe/Paris';
export const TRIAL_NOTICE = 'Facture d’essai, sans valeur comptable.';
export const DEFAULT_VAT_BP = { honoraires: 2000, reversement: 0 } as const;

export type InvoiceKind = 'honoraires' | 'reversement' | 'avoir';

export interface InvoiceContent {
  label: string;
  kind: InvoiceKind;
  issuedOn: string;
  issuer: string;
  recipient: string;
  designation: string;
  htCents: number;
  vatBp: number;
  vatCents: number;
  ttcCents: number;
  mentions: string[];
  corrects: string | null;
}

export interface InvoiceView {
  id: string;
  fileId: string;
  issuer: string;
  content: InvoiceContent;
  transmitted: { mode: 'essai'; platformRef: string } | null;
}

export interface DraftView {
  id: string;
  fileId: string;
  kind: 'honoraires' | 'reversement';
  issuer: string;
  amountCents: number;
  vatBp: number;
  createdAt: string;
}

/** La plateforme agréée de facturation électronique, derrière une interface ; seule celle d'essai existe [R26]. */
export interface PlateformeFacturation {
  readonly mode: 'essai';
  transmit(invoice: { id: string; content: InvoiceContent }): Promise<{ ref: string }>;
}

/** La plateforme d'essai : elle reçoit, ne transmet rien à personne. */
export class PlateformeEssai implements PlateformeFacturation {
  readonly mode = 'essai' as const;
  readonly received: string[] = [];
  async transmit(invoice: { id: string; content: InvoiceContent }): Promise<{ ref: string }> {
    this.received.push(invoice.content.label);
    return { ref: `essai:${invoice.content.label}` };
  }
}

export type InvoiceRefusal = { ok: false; rule: 'R16'; code: string };
type InvoiceProblem = { ok: false; rule: null | 'R71'; code: 'unknown' | 'already' | 'bad_reason' | 'not_creditable' | 'bad_day' | 'busy' };

/** Hors taxe et TVA d'un montant toutes taxes, au centime ; la TVA est le reste, pour que tout se recompte. */
export function splitVat(ttcCents: number, vatBp: number): { htCents: number; vatCents: number } {
  const htCents = Math.round((ttcCents * 10_000) / (10_000 + vatBp));
  return { htCents, vatCents: ttcCents - htCents };
}

const euros = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)},${String(a % 100).padStart(2, '0')}`;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REASONS = ['erreur_montant', 'erreur_destinataire', 'vente_annulee', 'autre'] as const;

export class Factures {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly plateforme: PlateformeFacturation;
  private readonly vat: { honoraires: number; reversement: number };
  private readonly commissions: Commissions;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; plateforme?: PlateformeFacturation; vatBp?: { honoraires: number; reversement: number } } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.plateforme = options.plateforme ?? new PlateformeEssai();
    if (this.plateforme.mode !== 'essai') throw new Error('Aucune facture réelle tant que H26 n’est pas fait [R26].');
    this.vat = options.vatBp ?? { ...DEFAULT_VAT_BP };
    this.commissions = new Commissions(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, kind: string, code: string): Promise<InvoiceRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** La direction seule valide, corrige et exporte (droits du socle : les chiffres) [R16]. */
  private async directionRefusal(viewer: Viewer, kind: string): Promise<InvoiceRefusal | null> {
    if (viewer.role !== 'direction') return this.refuse(viewer, kind, 'role');
    const d = decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId });
    return d.allowed ? null : this.refuse(viewer, kind, d.code);
  }

  private async waiting(fileId: string, code: string): Promise<void> {
    const seen = (await this.journal.bySubject(`sale_file:${fileId}`)).some((e) => e.type === 'facture.attente' && e.data.code === code);
    if (!seen) await appendEvent(this.journal, { type: 'facture.attente', actor: 'system:pilotage', subject: `sale_file:${fileId}`, data: { rule: 'R71', code } }, this.now);
  }

  /** Ce qui reste à facturer pour ce dossier, cette sorte et cet émetteur : rien d'émis net, aucun brouillon ouvert. */
  private async nextRound(fileId: string, kind: 'honoraires' | 'reversement', issuer: string): Promise<number | null> {
    const open = await this.db.first('SELECT 1 FROM invoice_drafts d WHERE d.file_id = ? AND d.kind = ? AND d.issuer = ? AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.draft_id = d.id)', [fileId, kind, issuer]);
    if (open) return null;
    const net = await this.db.first<{ n: number | null }>(
      `SELECT SUM(i.amount_cents) AS n FROM invoices i WHERE i.file_id = ? AND i.issuer = ?
         AND (i.kind = ? OR (i.kind = 'avoir' AND (SELECT o.kind FROM invoices o WHERE o.id = i.corrects_invoice_id) = ?))`,
      [fileId, issuer, kind, kind],
    );
    const issued = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM invoices WHERE file_id = ? AND issuer = ? AND kind = ?', [fileId, issuer, kind]);
    if ((issued?.n ?? 0) > 0 && (net?.n ?? 0) !== 0) return null;
    const last = await this.db.first<{ r: number | null }>('SELECT MAX(round) AS r FROM invoice_drafts WHERE file_id = ? AND kind = ? AND issuer = ?', [fileId, kind, issuer]);
    return (last?.r ?? 0) + 1;
  }

  /**
   * Le passage : un brouillon d'honoraires et un brouillon de reversement par agent pour chaque commission due, une
   * seule fois [R18]. Rend le nombre de brouillons préparés.
   */
  async prepare(networkId: string): Promise<number> {
    let made = 0;
    const files = await this.db.all<{ file_id: string; fee_cents: number; fee_charge: 'vendeur' | 'acquereur' | null; mandate_id: string }>(
      `SELECT c.file_id, c.fee_cents, c.fee_charge, c.mandate_id FROM commissions c
       WHERE c.network_id = ? AND EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = c.file_id AND s.status = 'due')
       ORDER BY c.compromis_on, c.file_id`,
      [networkId],
    );
    const at = this.now().toISOString();
    const add = async (fileId: string, kind: 'honoraires' | 'reversement', issuer: string, recipient: string | null, amount: number, vatBp: number) => {
      const round = await this.nextRound(fileId, kind, issuer);
      if (round === null) return;
      const { changes } = await this.db.run(
        'INSERT INTO invoice_drafts (id, network_id, file_id, kind, issuer, recipient_person_id, amount_cents, vat_bp, round, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [this.newId(), networkId, fileId, kind, issuer, recipient, amount, vatBp, round, at],
      );
      if (changes === 1) made += 1;
    };
    for (const f of files) {
      if (f.fee_charge === null) {
        await this.waiting(f.file_id, 'payeur_inconnu');
      } else if (f.fee_cents > 0) {
        const payer =
          f.fee_charge === 'vendeur'
            ? (await this.db.first<{ person_id: string }>('SELECT person_id FROM mandates WHERE id = ?', [f.mandate_id]))?.person_id
            : (await this.db.first<{ buyer_person_id: string }>('SELECT buyer_person_id FROM sale_files WHERE id = ?', [f.file_id]))?.buyer_person_id;
        if (payer) await add(f.file_id, 'honoraires', 'reseau', payer, f.fee_cents, this.vat.honoraires);
        else await this.waiting(f.file_id, 'payeur_inconnu');
      }
      const shares = await this.db.all<{ beneficiary_id: string; amount_cents: number }>(
        "SELECT beneficiary_id, SUM(amount_cents) AS amount_cents FROM commission_shares WHERE file_id = ? AND kind IN ('agent', 'partage') GROUP BY beneficiary_id ORDER BY beneficiary_id",
        [f.file_id],
      );
      for (const s of shares) if (s.amount_cents > 0) await add(f.file_id, 'reversement', `agent:${s.beneficiary_id}`, null, s.amount_cents, this.vat.reversement);
    }
    return made;
  }

  /** Les brouillons à valider : la direction seule [R16]. */
  async drafts(viewer: Viewer): Promise<{ ok: true; value: DraftView[] } | InvoiceRefusal> {
    const refusal = await this.directionRefusal(viewer, 'invoice_drafts');
    if (refusal) return refusal;
    const rows = await this.db.all<{ id: string; file_id: string; kind: 'honoraires' | 'reversement'; issuer: string; amount_cents: number; vat_bp: number; created_at: string }>(
      "SELECT d.id, d.file_id, d.kind, d.issuer, d.amount_cents, d.vat_bp, d.created_at FROM invoice_drafts d WHERE d.network_id = ? AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.draft_id = d.id) ORDER BY d.created_at, CASE d.kind WHEN 'honoraires' THEN 0 ELSE 1 END, d.issuer, d.round",
      [viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => ({ id: r.id, fileId: r.file_id, kind: r.kind, issuer: r.issuer, amountCents: r.amount_cents, vatBp: r.vat_bp, createdAt: r.created_at })) };
  }

  private async nameOf(networkId: string, party: string): Promise<string> {
    if (party === 'reseau') return (await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [networkId]))?.name ?? 'Réseau';
    if (party.startsWith('agent:')) {
      const a = await this.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ?', [party.slice(6)]);
      return a ? `${a.first_name} ${a.last_name}` : 'Agent';
    }
    const p = await this.db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [party.slice(7)]);
    return [p?.first_name, p?.last_name].filter((x) => x).join(' ') || 'Client';
  }

  /**
   * Numérote et range une facture en une seule écriture : le numéro est le suivant de l'émetteur pour l'année, calculé
   * dans l'écriture même ; deux validations simultanées ne prennent jamais le même numéro, la seconde reprend le suivant.
   */
  private async insert(networkId: string, issuer: string, kind: InvoiceKind, fileId: string, draftId: string | null, corrects: { id: string; label: string } | null, build: (number: number, year: number, issuedOn: string) => InvoiceContent, by: string): Promise<string | null> {
    const issuedOn = localTime(this.now(), TIME_ZONE).date;
    const year = Number(issuedOn.slice(0, 4));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.db.first<{ n: number | null }>('SELECT MAX(number) AS n FROM invoices WHERE network_id = ? AND issuer = ? AND year = ?', [networkId, issuer, year]);
      const number = (last?.n ?? 0) + 1;
      const content = build(number, year, issuedOn);
      const id = this.newId();
      try {
        const { changes } = await this.db.run(
          `INSERT INTO invoices (id, network_id, issuer, year, number, kind, file_id, draft_id, corrects_invoice_id, content, amount_cents, issued_on, validated_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (draft_id) DO NOTHING`,
          [id, networkId, issuer, year, number, kind, fileId, draftId, corrects?.id ?? null, JSON.stringify(content), content.ttcCents, issuedOn, by, this.now().toISOString()],
        );
        return changes === 1 ? id : null;
      } catch (error) {
        // Un numéro pris entre-temps, ou un avoir déjà fait : on relit et on reprend, jamais un trou ni un doublon.
        if (corrects && (await this.db.first('SELECT 1 FROM invoices WHERE corrects_invoice_id = ?', [corrects.id]))) return null;
        if (draftId && (await this.db.first('SELECT 1 FROM invoices WHERE draft_id = ?', [draftId]))) return null;
        if (attempt === 4) throw error;
      }
    }
    return null;
  }

  private async transmit(invoiceId: string): Promise<void> {
    if (await this.db.first('SELECT 1 FROM invoice_transmissions WHERE invoice_id = ?', [invoiceId])) return;
    const row = (await this.db.first<{ content: string }>('SELECT content FROM invoices WHERE id = ?', [invoiceId]))!;
    const r = await this.plateforme.transmit({ id: invoiceId, content: JSON.parse(row.content) as InvoiceContent });
    await this.db.run("INSERT INTO invoice_transmissions (invoice_id, mode, platform_ref, at) VALUES (?, 'essai', ?, ?) ON CONFLICT DO NOTHING", [invoiceId, r.ref, this.now().toISOString()]);
  }

  private mentions(vatBp: number): string[] {
    return [TRIAL_NOTICE, ...(vatBp === 0 ? ['TVA non appliquée en mode essai, en attente de la validation de l’expert-comptable.'] : [])];
  }

  /** La direction valide un brouillon : la facture est numérotée, figée, transmise en mode essai [R71, R26]. */
  async validate(viewer: Viewer, draftId: string): Promise<{ ok: true; value: InvoiceView } | InvoiceRefusal | InvoiceProblem> {
    const refusal = await this.directionRefusal(viewer, 'invoice');
    if (refusal) return refusal;
    const d = await this.db.first<{ id: string; network_id: string; file_id: string; kind: 'honoraires' | 'reversement'; issuer: string; recipient_person_id: string | null; amount_cents: number; vat_bp: number }>(
      'SELECT id, network_id, file_id, kind, issuer, recipient_person_id, amount_cents, vat_bp FROM invoice_drafts WHERE id = ?',
      [draftId],
    );
    if (!d || d.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    if (await this.db.first('SELECT 1 FROM invoices WHERE draft_id = ?', [draftId])) return { ok: false, rule: null, code: 'already' };
    const reference = (await this.db.first<{ reference: string }>('SELECT p.reference FROM sale_files f JOIN properties p ON p.id = f.property_id WHERE f.id = ?', [d.file_id]))?.reference ?? '';
    const issuerName = await this.nameOf(d.network_id, d.issuer);
    const recipientName = d.kind === 'honoraires' ? await this.nameOf(d.network_id, `person:${d.recipient_person_id}`) : await this.nameOf(d.network_id, 'reseau');
    const { htCents, vatCents } = splitVat(d.amount_cents, d.vat_bp);
    const prefix = d.kind === 'honoraires' ? 'F' : 'RV';
    const id = await this.insert(
      d.network_id,
      d.issuer,
      d.kind,
      d.file_id,
      d.id,
      null,
      (number, year, issuedOn) => ({
        label: `${prefix}-${year}-${String(number).padStart(5, '0')}`,
        kind: d.kind,
        issuedOn,
        issuer: issuerName,
        recipient: recipientName,
        designation: d.kind === 'honoraires' ? `Honoraires de transaction, bien ${reference}` : `Reversement de commission, vente du bien ${reference}`,
        htCents,
        vatBp: d.vat_bp,
        vatCents,
        ttcCents: d.amount_cents,
        mentions: this.mentions(d.vat_bp),
        corrects: null,
      }),
      this.actor(viewer),
    );
    if (!id) return { ok: false, rule: null, code: 'already' };
    await this.transmit(id);
    const view = (await this.byId(id))!;
    // Au journal : la sorte et le numéro, jamais un montant ni un nom [R13].
    await appendEvent(this.journal, { type: 'facture.emise', actor: this.actor(viewer), subject: `sale_file:${d.file_id}`, data: { rule: 'R71', kind: d.kind, label: view.content.label, mode: 'essai' } }, this.now);
    if (d.kind === 'honoraires') await this.commissions.recordStep(d.network_id, d.file_id, 'facturee', `facture:${view.content.label}`, this.actor(viewer));
    return { ok: true, value: view };
  }

  /** Un avoir corrige une facture émise, une seule fois, dans la même suite de numéros [R71, R17]. */
  async credit(viewer: Viewer, invoiceId: string, reason: string): Promise<{ ok: true; value: InvoiceView } | InvoiceRefusal | InvoiceProblem> {
    const refusal = await this.directionRefusal(viewer, 'invoice_credit');
    if (refusal) return refusal;
    if (!(REASONS as readonly string[]).includes(reason)) return { ok: false, rule: null, code: 'bad_reason' };
    const original = await this.byId(invoiceId);
    const row = await this.db.first<{ network_id: string; file_id: string; issuer: string; kind: InvoiceKind }>('SELECT network_id, file_id, issuer, kind FROM invoices WHERE id = ?', [invoiceId]);
    if (!original || !row || row.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    if (row.kind === 'avoir') return { ok: false, rule: 'R71', code: 'not_creditable' };
    if (await this.db.first('SELECT 1 FROM invoices WHERE corrects_invoice_id = ?', [invoiceId])) return { ok: false, rule: null, code: 'already' };
    const o = original.content;
    const id = await this.insert(
      row.network_id,
      row.issuer,
      'avoir',
      row.file_id,
      null,
      { id: invoiceId, label: o.label },
      (number, year, issuedOn) => ({
        label: `AV-${year}-${String(number).padStart(5, '0')}`,
        kind: 'avoir',
        issuedOn,
        issuer: o.issuer,
        recipient: o.recipient,
        designation: `Avoir sur la facture ${o.label}`,
        htCents: -o.htCents,
        vatBp: o.vatBp,
        vatCents: -o.vatCents,
        ttcCents: -o.ttcCents,
        mentions: [...this.mentions(o.vatBp), `Annule la facture ${o.label}.`],
        corrects: o.label,
      }),
      this.actor(viewer),
    );
    if (!id) return { ok: false, rule: null, code: 'already' };
    await this.transmit(id);
    const view = (await this.byId(id))!;
    await appendEvent(this.journal, { type: 'facture.avoir', actor: this.actor(viewer), subject: `sale_file:${row.file_id}`, data: { rule: 'R71', label: view.content.label, corrects: o.label, reason } }, this.now);
    return { ok: true, value: view };
  }

  /** Reprend l'envoi à la plateforme des factures numérotées restées sans transmission (coupure). */
  async retryTransmissions(networkId: string): Promise<number> {
    const rows = await this.db.all<{ id: string }>('SELECT i.id FROM invoices i WHERE i.network_id = ? AND NOT EXISTS (SELECT 1 FROM invoice_transmissions t WHERE t.invoice_id = i.id) ORDER BY i.created_at', [networkId]);
    for (const r of rows) await this.transmit(r.id);
    return rows.length;
  }

  private async byId(id: string): Promise<InvoiceView | null> {
    const r = await this.db.first<{ id: string; file_id: string; issuer: string; content: string; platform_ref: string | null }>(
      'SELECT i.id, i.file_id, i.issuer, i.content, t.platform_ref FROM invoices i LEFT JOIN invoice_transmissions t ON t.invoice_id = i.id WHERE i.id = ?',
      [id],
    );
    if (!r) return null;
    return { id: r.id, fileId: r.file_id, issuer: r.issuer, content: JSON.parse(r.content) as InvoiceContent, transmitted: r.platform_ref ? { mode: 'essai', platformRef: r.platform_ref } : null };
  }

  /** Les factures : la direction voit le réseau ; un agent, seulement les reversements émis à son nom [R16, R68]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: InvoiceView[] } | InvoiceRefusal> {
    if (!(ROLES as readonly string[]).includes(viewer.role)) return this.refuse(viewer, 'invoices', 'role');
    if (viewer.role === 'agent') {
      const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
      if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return this.refuse(viewer, 'invoices', 'agent_inactive');
    } else {
      const refusal = await this.directionRefusal(viewer, 'invoices');
      if (refusal) return refusal;
    }
    const own = viewer.role === 'agent';
    const rows = await this.db.all<{ id: string }>(
      `SELECT id FROM invoices WHERE network_id = ?${own ? ' AND issuer = ?' : ''} ORDER BY CASE issuer WHEN 'reseau' THEN 0 ELSE 1 END, issuer, year, number`,
      own ? [viewer.networkId, `agent:${viewer.userId}`] : [viewer.networkId],
    );
    const value: InvoiceView[] = [];
    for (const r of rows) value.push((await this.byId(r.id))!);
    return { ok: true, value };
  }

  /**
   * L'export comptable d'une période, au format tableur (séparateur « ; », montants en euros à la virgule) : une ligne
   * par facture et avoir, dans l'ordre des suites ; la dernière ligne totalise, au centime [R69].
   */
  async exportCsv(viewer: Viewer, fromDay: string, toDay: string): Promise<{ ok: true; value: string } | InvoiceRefusal | InvoiceProblem> {
    const refusal = await this.directionRefusal(viewer, 'invoice_export');
    if (refusal) return refusal;
    if (!DAY.test(fromDay) || !DAY.test(toDay) || fromDay > toDay) return { ok: false, rule: null, code: 'bad_day' };
    const rows = await this.db.all<{ content: string; file_id: string }>(
      "SELECT content, file_id FROM invoices WHERE network_id = ? AND issued_on >= ? AND issued_on <= ? ORDER BY CASE issuer WHEN 'reseau' THEN 0 ELSE 1 END, issuer, year, number",
      [viewer.networkId, fromDay, toDay],
    );
    const cell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = ['numero;date;sorte;emetteur;destinataire;designation;ht;tva;ttc;facture_corrigee'];
    let ht = 0;
    let vat = 0;
    let ttc = 0;
    for (const r of rows) {
      const c = JSON.parse(r.content) as InvoiceContent;
      ht += c.htCents;
      vat += c.vatCents;
      ttc += c.ttcCents;
      lines.push([c.label, c.issuedOn, c.kind, c.issuer, c.recipient, c.designation, euros(c.htCents), euros(c.vatCents), euros(c.ttcCents), c.corrects ?? ''].map(cell).join(';'));
    }
    lines.push(['total', '', '', '', '', '', euros(ht), euros(vat), euros(ttc), ''].join(';'));
    await appendEvent(this.journal, { type: 'facture.export', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { from: fromDay, to: toDay, count: rows.length } }, this.now);
    return { ok: true, value: `${lines.join('\r\n')}\r\n` };
  }
}
