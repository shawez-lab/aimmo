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
export const CREDIT_REASONS = ['erreur_montant', 'erreur_destinataire', 'vente_annulee', 'autre'] as const;
const REASONS = CREDIT_REASONS;

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
  /** Le jour de l'acte de la vente facturée. */
  saleDay: string | null;
  /** La raison d'un avoir. */
  reason: (typeof REASONS)[number] | null;
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
    return { ref: `essai:${invoice.id}` };
  }
}

export type InvoiceRefusal = { ok: false; rule: 'R16'; code: string };
type InvoiceProblem = { ok: false; rule: null | 'R71'; code: 'unknown' | 'already' | 'bad_reason' | 'not_creditable' | 'bad_day' | 'busy' | 'sale_cancelled' };

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
    // Une vente annulée ne se refacture jamais d'elle-même.
    const cancelled = await this.db.first("SELECT 1 FROM invoices WHERE file_id = ? AND kind = 'avoir' AND json_extract(content, '$.reason') = 'vente_annulee'", [fileId]);
    if (cancelled) return null;
    const last = await this.db.first<{ r: number | null }>('SELECT MAX(round) AS r FROM invoice_drafts WHERE file_id = ? AND kind = ? AND issuer = ?', [fileId, kind, issuer]);
    return (last?.r ?? 0) + 1;
  }

  /**
   * Le passage : un brouillon d'honoraires et un brouillon de reversement par agent pour chaque commission due, une
   * seule fois [R18]. Rend le nombre de brouillons préparés.
   */
  async prepare(networkId: string): Promise<number> {
    await this.reconcile(networkId);
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

  /** Le code d'un émetteur dans le numéro : rien pour le réseau, l'agent sinon, pour qu'un numéro soit unique. */
  private issuerCode(issuer: string): string {
    // Les tirets de l'identifiant sont gardés : collés, les chiffres d'un UUID peuvent former un faux numéro de
    // téléphone, que le journal refuse ; un UUID entier est reconnu comme identifiant interne [R13].
    return issuer === 'reseau' ? '' : `${issuer.slice(6).toUpperCase().replace(/[^A-Z0-9-]/g, '')}-`;
  }

  private label(kind: InvoiceKind, issuer: string, year: number, number: number): string {
    const prefix = kind === 'honoraires' ? 'F' : kind === 'reversement' ? 'RV' : 'AV';
    return `${prefix}-${this.issuerCode(issuer)}${year}-${String(number).padStart(5, '0')}`;
  }

  /**
   * Numérote et range une facture en une seule écriture : le numéro est le suivant de l'émetteur pour l'année, calculé
   * dans l'écriture même, atomique ; le numéro n'est pas dans le contenu figé, il se lit dans la ligne. Deux validations
   * simultanées prennent deux numéros qui se suivent. Rend l'identifiant, `null` si le brouillon ou la facture corrigée
   * l'ont déjà été, `busy` si l'ordre des jours n'a pas pu être tenu (passage de minuit).
   */
  private async insert(networkId: string, issuer: string, kind: InvoiceKind, fileId: string, draftId: string | null, correctsId: string | null, content: Omit<InvoiceContent, 'label' | 'issuedOn'>, by: string): Promise<string | null | 'busy'> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const issuedOn = localTime(this.now(), TIME_ZONE).date;
      const year = Number(issuedOn.slice(0, 4));
      const id = this.newId();
      try {
        const { changes } = await this.db.run(
          `INSERT INTO invoices (id, network_id, issuer, year, number, kind, file_id, draft_id, corrects_invoice_id, content, amount_cents, issued_on, validated_by, created_at)
           SELECT ?, ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM invoices WHERE network_id = ? AND issuer = ? AND year = ?
           ON CONFLICT (draft_id) DO NOTHING`,
          [id, networkId, issuer, year, kind, fileId, draftId, correctsId, JSON.stringify({ ...content, issuedOn }), content.ttcCents, issuedOn, by, this.now().toISOString(), networkId, issuer, year],
        );
        return changes === 1 ? id : null;
      } catch (error) {
        if (correctsId && (await this.db.first('SELECT 1 FROM invoices WHERE corrects_invoice_id = ?', [correctsId]))) return null;
        if (draftId && (await this.db.first('SELECT 1 FROM invoices WHERE draft_id = ?', [draftId]))) return null;
        // Seul un conflit de suite (numéro pris, jour passé) se reprend ; toute autre panne va au journal et remonte.
        const message = error instanceof Error ? error.message : '';
        if (!/hors suite|UNIQUE constraint/i.test(message)) {
          await appendEvent(this.journal, { type: 'facture.erreur', actor: by, subject: `sale_file:${fileId}`, data: { kind, error: error instanceof Error ? error.name : 'unknown' } }, this.now);
          throw error;
        }
        if (attempt === 2) return 'busy';
      }
    }
    return 'busy';
  }

  /**
   * Ce qui suit une facture rangée, repris tant qu'il manque : l'envoi à la plateforme d'essai, la ligne du journal, et
   * pour une facture d'honoraires non annulée, la commission « facturée » [R67]. Une panne de la plateforme laisse la
   * facture rangée, sans envoi, reprise au passage suivant ; elle va au journal, sans donnée [R13].
   */
  private async follow(invoiceId: string, actor: string): Promise<void> {
    const v = (await this.byId(invoiceId))!;
    const row = (await this.db.first<{ network_id: string; kind: InvoiceKind }>('SELECT network_id, kind FROM invoices WHERE id = ?', [invoiceId]))!;
    if (!v.transmitted) {
      try {
        const r = await this.plateforme.transmit({ id: invoiceId, content: v.content });
        await this.db.run("INSERT INTO invoice_transmissions (invoice_id, mode, platform_ref, at) VALUES (?, 'essai', ?, ?) ON CONFLICT DO NOTHING", [invoiceId, r.ref, this.now().toISOString()]);
      } catch (error) {
        await appendEvent(this.journal, { type: 'facture.envoi_en_panne', actor: 'system:pilotage', subject: `sale_file:${v.fileId}`, data: { label: v.content.label, error: error instanceof Error ? error.name : 'unknown' } }, this.now);
      }
    }
    const type = row.kind === 'avoir' ? 'facture.avoir' : 'facture.emise';
    if (!(await this.journal.bySubject(`sale_file:${v.fileId}`)).some((e) => e.type === type && e.data.label === v.content.label)) {
      // Au journal : la sorte et le numéro, jamais un montant ni un nom [R13].
      await appendEvent(this.journal, { type, actor, subject: `sale_file:${v.fileId}`, data: { rule: 'R71', kind: row.kind, label: v.content.label, mode: 'essai', ...(v.content.corrects ? { corrects: v.content.corrects } : {}) } }, this.now);
    }
    if (row.kind === 'honoraires' && !(await this.db.first('SELECT 1 FROM invoices WHERE corrects_invoice_id = ?', [invoiceId]))) {
      const step = await this.commissions.recordStep(row.network_id, v.fileId, 'facturee', `facture:${v.content.label}`, actor);
      if (!step.ok && step.code !== 'already') {
        await this.waiting(v.fileId, `etape_${step.code}`);
      } else if (!step.ok) {
        // Déjà facturée par une facture depuis annulée par un avoir : la nouvelle facture le dit au journal, une fois.
        const proof = await this.db.first<{ proof_ref: string }>("SELECT proof_ref FROM commission_steps WHERE file_id = ? AND status = 'facturee'", [v.fileId]);
        if (proof && proof.proof_ref !== `facture:${v.content.label}`) await this.waiting(v.fileId, `remplace:${v.content.label}`);
      }
    }
  }

  private mentions(vatBp: number): string[] {
    return [
      TRIAL_NOTICE,
      ...(vatBp === 0 ? ['TVA non appliquée en mode essai, en attente de la validation de l’expert-comptable.'] : []),
      // Aucune mention inventée : les identifiants de l'émetteur viennent de la société et de la plateforme réelles.
      'Identifiants de l’émetteur, adresse du destinataire et conditions de paiement : à compléter à la création de la société (H09) et à la mise en service de la plateforme agréée (H26).',
    ];
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
    const done = await this.db.first<{ id: string }>('SELECT id FROM invoices WHERE draft_id = ?', [draftId]);
    if (done) {
      // Déjà numérotée : ce qui aurait manqué après une coupure est repris.
      await this.follow(done.id, this.actor(viewer));
      return { ok: false, rule: null, code: 'already' };
    }
    // Une vente annulée par un avoir n'émet plus aucune facture, même d'un brouillon préparé avant.
    if (await this.db.first("SELECT 1 FROM invoices WHERE file_id = ? AND kind = 'avoir' AND json_extract(content, '$.reason') = 'vente_annulee'", [d.file_id])) {
      return { ok: false, rule: 'R71', code: 'sale_cancelled' };
    }
    const reference = (await this.db.first<{ reference: string }>('SELECT p.reference FROM sale_files f JOIN properties p ON p.id = f.property_id WHERE f.id = ?', [d.file_id]))?.reference ?? '';
    const saleDay = (await this.db.first<{ signed_on: string }>('SELECT signed_on FROM sale_file_closings WHERE file_id = ?', [d.file_id]))?.signed_on ?? null;
    const { htCents, vatCents } = splitVat(d.amount_cents, d.vat_bp);
    const id = await this.insert(
      d.network_id,
      d.issuer,
      d.kind,
      d.file_id,
      d.id,
      null,
      {
        kind: d.kind,
        issuer: await this.nameOf(d.network_id, d.issuer),
        recipient: d.kind === 'honoraires' ? await this.nameOf(d.network_id, `person:${d.recipient_person_id}`) : await this.nameOf(d.network_id, 'reseau'),
        designation: d.kind === 'honoraires' ? `Honoraires de transaction, bien ${reference}` : `Reversement de commission, vente du bien ${reference}`,
        saleDay,
        htCents,
        vatBp: d.vat_bp,
        vatCents,
        ttcCents: d.amount_cents,
        mentions: this.mentions(d.vat_bp),
        corrects: null,
        reason: null,
      },
      this.actor(viewer),
    );
    if (id === 'busy') return { ok: false, rule: null, code: 'busy' };
    if (!id) return { ok: false, rule: null, code: 'already' };
    await this.follow(id, this.actor(viewer));
    return { ok: true, value: (await this.byId(id))! };
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
    const done = await this.db.first<{ id: string }>('SELECT id FROM invoices WHERE corrects_invoice_id = ?', [invoiceId]);
    if (done) {
      await this.follow(done.id, this.actor(viewer));
      return { ok: false, rule: null, code: 'already' };
    }
    const o = original.content;
    const id = await this.insert(
      row.network_id,
      row.issuer,
      'avoir',
      row.file_id,
      null,
      invoiceId,
      {
        kind: 'avoir',
        issuer: o.issuer,
        recipient: o.recipient,
        designation: `Avoir sur la facture ${o.label}`,
        saleDay: o.saleDay,
        htCents: -o.htCents,
        vatBp: o.vatBp,
        vatCents: -o.vatCents,
        ttcCents: -o.ttcCents,
        mentions: [...this.mentions(o.vatBp), `Annule la facture ${o.label}.`],
        corrects: o.label,
        reason: reason as (typeof REASONS)[number],
      },
      this.actor(viewer),
    );
    if (id === 'busy') return { ok: false, rule: null, code: 'busy' };
    if (!id) return { ok: false, rule: null, code: 'already' };
    await this.follow(id, this.actor(viewer));
    if (reason === 'vente_annulee') await this.waiting(row.file_id, 'vente_annulee');
    return { ok: true, value: (await this.byId(id))! };
  }

  /** Reprend, pour chaque facture du réseau, ce qui aurait manqué après une coupure ou une panne de la plateforme. */
  async reconcile(networkId: string): Promise<number> {
    const rows = await this.db.all<{ id: string; validated_by: string }>('SELECT id, validated_by FROM invoices WHERE network_id = ? ORDER BY created_at, id', [networkId]);
    for (const r of rows) await this.follow(r.id, r.validated_by);
    return rows.length;
  }

  private async byId(id: string): Promise<InvoiceView | null> {
    const r = await this.db.first<{ id: string; file_id: string; issuer: string; kind: InvoiceKind; year: number; number: number; content: string; platform_ref: string | null }>(
      'SELECT i.id, i.file_id, i.issuer, i.kind, i.year, i.number, i.content, t.platform_ref FROM invoices i LEFT JOIN invoice_transmissions t ON t.invoice_id = i.id WHERE i.id = ?',
      [id],
    );
    if (!r) return null;
    const content = { ...(JSON.parse(r.content) as Omit<InvoiceContent, 'label'>), label: this.label(r.kind, r.issuer, r.year, r.number) };
    return { id: r.id, fileId: r.file_id, issuer: r.issuer, content, transmitted: r.platform_ref ? { mode: 'essai', platformRef: r.platform_ref } : null };
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
    const rows = await this.db.all<{ id: string }>(
      "SELECT id FROM invoices WHERE network_id = ? AND issued_on >= ? AND issued_on <= ? ORDER BY CASE issuer WHEN 'reseau' THEN 0 ELSE 1 END, issuer, year, number",
      [viewer.networkId, fromDay, toDay],
    );
    // Un texte qui commence comme une formule de tableur est neutralisé ; les montants ne passent pas par là.
    const text = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const cell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = ['numero;date;sorte;emetteur;destinataire;designation;ht;tva;ttc;facture_corrigee'];
    let ht = 0;
    let vat = 0;
    let ttc = 0;
    for (const r of rows) {
      const c = (await this.byId(r.id))!.content;
      ht += c.htCents;
      vat += c.vatCents;
      ttc += c.ttcCents;
      lines.push([text(c.label), c.issuedOn, c.kind, text(c.issuer), text(c.recipient), text(c.designation), euros(c.htCents), euros(c.vatCents), euros(c.ttcCents), text(c.corrects ?? '')].map(cell).join(';'));
    }
    lines.push(['total', '', '', '', '', '', euros(ht), euros(vat), euros(ttc), ''].join(';'));
    await appendEvent(this.journal, { type: 'facture.export', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { from: fromDay, to: toDay, count: rows.length } }, this.now);
    return { ok: true, value: `${lines.join('\r\n')}\r\n` };
  }
}
