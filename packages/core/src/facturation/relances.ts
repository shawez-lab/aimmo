/**
 * Relances des factures d'honoraires impayées, en mode essai (M13, HX49) [R01, R03, R05, R13, R16, R62, R553].
 *
 * Chaque jour, pour chaque facture d'honoraires échue que la banque ne prouve pas encore payée (aucun rapprochement) et
 * qu'aucun avoir n'a corrigée, le code prépare une relance au client qui paie les honoraires, écrite sans IA depuis la
 * seule facture : son numéro, son montant, son jour et son échéance. La direction lit le texte et le valide d'un geste ;
 * rien n'est validé à sa place, et la base refuse de marquer envoyée une relance non validée. Validée, elle passe par le
 * contrôle central, comme tout envoi (heures, exclusions, accord pour le suivi de la vente, anti-doublon), dans la boîte
 * d'essai : rien ne part [R26]. Une facture rapprochée ou corrigée avant l'envoi ferme sa relance.
 *
 * Décidé, lecture prudente :
 * - échéance : 30 jours après le jour de la facture (réglage), faute de conditions de paiement rangées ;
 * - trois relances au plus par facture, la suivante 15 jours (réglage) après l'envoi ou le refus de la précédente, et
 *   jamais tant qu'une relance attend la validation ou l'envoi ;
 * - le texte ne demande aucun paiement et ne porte aucune coordonnée bancaire [R62] : il dit que la facture n'apparaît
 *   pas dans les encaissements, et qu'une réponse suffit si elle a été réglée, par le client ou par le notaire ;
 * - finalité : le suivi de la vente, dont l'accord est exigé [R03] ; canal : le mail.
 */
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { fundsInOutgoing } from '../dossiers/bouclier.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { SELLER_UPDATE_PURPOSE } from '../visites/compte-rendu.ts';
import { LABEL_SQL, actorOf, addDays, directionRefusal, euros, frenchDay, todayInParis, type Refusal } from './commun.ts';

export const DEFAULT_PAYMENT_DAYS = 30;
export const DEFAULT_REMINDER_GAP_DAYS = 15;
export const MAX_REMINDERS = 3;

export type ReminderStatus = 'a_valider' | 'validee' | 'envoyee' | 'refusee' | 'close';

export interface UnpaidReminder {
  id: string;
  invoiceId: string;
  label: string;
  rank: number;
  text: string;
  status: ReminderStatus;
  rule: string | null;
  preparedAt: string;
  validatedBy: string | null;
}

export interface ReminderFacts {
  firstName: string | null;
  /** Le nombre de relances déjà parties pour cette facture : chaque relance a ainsi son propre texte [R05]. */
  alreadySent?: number;
  label: string;
  amountCents: number;
  /** AU094 · ce qui en est déjà reçu par des parts de lignes de banque. */
  receivedCents?: number;
  issuedOn: string;
  dueOn: string;
}

const ORDINALS = ['premier', 'deuxième', 'troisième'];

/** Le texte de la relance, écrit par le code depuis la seule facture : aucune demande de paiement [R62, R553]. */
export function unpaidReminderText(f: ReminderFacts): string {
  const hello = f.firstName ? `Bonjour ${f.firstName},` : 'Bonjour,';
  return [
    hello,
    '',
    f.receivedCents && f.receivedCents > 0
      ? `la facture ${f.label} de ${euros(f.amountCents)} €, émise le ${frenchDay(f.issuedOn)}, arrivait à échéance le ${frenchDay(f.dueOn)}. Nous en avons reçu ${euros(f.receivedCents)} € ; ${euros(f.amountCents - f.receivedCents)} € n'apparaissent pas encore dans nos encaissements.`
      : `la facture ${f.label} de ${euros(f.amountCents)} €, émise le ${frenchDay(f.issuedOn)}, arrivait à échéance le ${frenchDay(f.dueOn)}. Elle n'apparaît pas encore dans nos encaissements.`,
    ...(f.alreadySent ? ['', `C'est notre ${ORDINALS[Math.min(f.alreadySent, ORDINALS.length - 1)]} message à ce sujet.`] : []),
    '',
    'Si elle a déjà été réglée, par vous ou par l’étude du notaire, une simple réponse à ce message nous permet de mettre nos comptes à jour.',
  ].join('\n');
}

/** Les chiffres permis dans le texte : ceux de la facture, tels que le texte les écrit [R10]. */
function figuresOf(f: ReminderFacts): string[] {
  // Passés tels que le texte les écrit : le contrôle en tire lui-même les nombres (« 10 000,00 » reste 10000.00).
  const received = f.receivedCents && f.receivedCents > 0 ? [`${euros(f.receivedCents)} €`, `${euros(f.amountCents - f.receivedCents)} €`] : [];
  return [f.label, `${euros(f.amountCents)} €`, ...received, frenchDay(f.issuedOn), frenchDay(f.dueOn)];
}

type Problem = { ok: false; rule: null | 'R553'; code: 'unknown' | 'not_pending' };

export class RelancesImpayes {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly paymentDays: number;
  private readonly gapDays: number;
  private readonly controle: ControleEnvois;
  private readonly unique: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; paymentDays?: number; gapDays?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.paymentDays = options.paymentDays ?? DEFAULT_PAYMENT_DAYS;
    this.gapDays = options.gapDays ?? DEFAULT_REMINDER_GAP_DAYS;
    if (!Number.isInteger(this.paymentDays) || this.paymentDays < 1 || this.paymentDays > 120) throw new Error('Échéance des factures : de 1 à 120 jours.');
    if (!Number.isInteger(this.gapDays) || this.gapDays < 7 || this.gapDays > 60) throw new Error('Écart entre deux relances : de 7 à 60 jours.');
    const fiches = new FicheClient(db, { now: this.now });
    this.unique = new FicheUnique(db, fiches, { now: this.now });
    this.controle = new ControleEnvois(db, this.unique, new DecisionEnvoi(db, fiches, this.unique, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  /** Ferme les relances en attente d'une facture rapprochée ou corrigée par un avoir. */
  private async closeSettled(networkId: string): Promise<void> {
    const at = this.now().toISOString();
    await this.db.run(
      `UPDATE invoice_reminders SET status = 'close', rule = 'rapprochee', updated_at = ? WHERE network_id = ? AND status IN ('a_valider', 'validee')
         AND (EXISTS (SELECT 1 FROM bank_reconciliations r WHERE r.invoice_id = invoice_reminders.invoice_id)
           OR (SELECT COALESCE(SUM(a.amount_cents), 0) FROM bank_allocations a WHERE a.invoice_id = invoice_reminders.invoice_id)
              >= (SELECT i.amount_cents FROM invoices i WHERE i.id = invoice_reminders.invoice_id))`,
      [at, networkId],
    );
    await this.db.run(
      `UPDATE invoice_reminders SET status = 'close', rule = 'avoir', updated_at = ? WHERE network_id = ? AND status IN ('a_valider', 'validee')
         AND EXISTS (SELECT 1 FROM invoices a WHERE a.corrects_invoice_id = invoice_reminders.invoice_id)`,
      [at, networkId],
    );
    // Un encaissement rangé par K03, même sans ligne de banque : la facture n'est plus impayée.
    await this.db.run(
      `UPDATE invoice_reminders SET status = 'close', rule = 'encaissee', updated_at = ? WHERE network_id = ? AND status IN ('a_valider', 'validee')
         AND EXISTS (SELECT 1 FROM invoices i JOIN commission_receipts cr ON cr.file_id = i.file_id WHERE i.id = invoice_reminders.invoice_id)`,
      [at, networkId],
    );
  }

  /**
   * Ferme les relances en attente des factures qui ne sont plus impayées (rapprochées, corrigées, encaissées), sans
   * rien préparer ni envoyer : le passage le fait même quand le relevé de banque est trop ancien pour relancer [R553].
   */
  async closeSettledReminders(networkId: string): Promise<void> {
    await this.closeSettled(networkId);
  }

  /** AU094 · ce qu'une facture a déjà reçu par des parts de lignes de banque. */
  private async receivedOf(invoiceId: string): Promise<number> {
    return Number((await this.db.first<{ n: number | null }>('SELECT SUM(amount_cents) AS n FROM bank_allocations WHERE invoice_id = ?', [invoiceId]))?.n ?? 0);
  }

  /** Pourquoi une facture n'est plus impayée : rapprochée, corrigée par un avoir, encaissée ; `null` si elle l'est encore. */
  private async settled(invoiceId: string): Promise<'rapprochee' | 'avoir' | 'encaissee' | null> {
    if (await this.db.first('SELECT 1 FROM bank_reconciliations WHERE invoice_id = ?', [invoiceId])) return 'rapprochee';
    // AU094 · soldée par des parts de lignes de banque, au centime.
    if (await this.db.first('SELECT 1 FROM invoices i WHERE i.id = ? AND (SELECT COALESCE(SUM(a.amount_cents), 0) FROM bank_allocations a WHERE a.invoice_id = i.id) >= i.amount_cents', [invoiceId])) return 'rapprochee';
    if (await this.db.first('SELECT 1 FROM invoices WHERE corrects_invoice_id = ?', [invoiceId])) return 'avoir';
    if (await this.db.first('SELECT 1 FROM invoices i JOIN commission_receipts cr ON cr.file_id = i.file_id WHERE i.id = ?', [invoiceId])) return 'encaissee';
    return null;
  }

  /** Le passage : prépare les relances dues, à valider par la direction. Rend le nombre de relances préparées. */
  async prepare(networkId: string): Promise<number> {
    await this.closeSettled(networkId);
    const today = todayInParis(this.now());
    const latestIssue = addDays(today, -this.paymentDays - 1);
    const invoices = await this.db.all<{ id: string; file_id: string; amount_cents: number; issued_on: string; label: string; person_id: string | null }>(
      `SELECT i.id, i.file_id, i.amount_cents, i.issued_on, ${LABEL_SQL('i')} AS label, d.recipient_person_id AS person_id
       FROM invoices i JOIN invoice_drafts d ON d.id = i.draft_id
       WHERE i.network_id = ? AND i.kind = 'honoraires' AND i.issued_on <= ?
         AND NOT EXISTS (SELECT 1 FROM bank_reconciliations r WHERE r.invoice_id = i.id)
         AND (SELECT COALESCE(SUM(p.amount_cents), 0) FROM bank_allocations p WHERE p.invoice_id = i.id) < i.amount_cents
         AND NOT EXISTS (SELECT 1 FROM invoices a WHERE a.corrects_invoice_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM commission_receipts cr WHERE cr.file_id = i.file_id)
       ORDER BY i.issued_on, i.number`,
      [networkId, latestIssue],
    );
    let made = 0;
    for (const inv of invoices) {
      if (!inv.person_id) continue;
      const last = await this.db.first<{ rank: number; status: ReminderStatus; updated_at: string }>('SELECT rank, status, updated_at FROM invoice_reminders WHERE invoice_id = ? ORDER BY rank DESC LIMIT 1', [inv.id]);
      if (last) {
        if (last.status === 'a_valider' || last.status === 'validee' || last.status === 'close') continue;
        if (last.rank >= MAX_REMINDERS) continue;
        if (today < addDays(todayInParis(new Date(last.updated_at)), this.gapDays)) continue;
      }
      const rank = (last?.rank ?? 0) + 1;
      const sentBefore = await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM invoice_reminders WHERE invoice_id = ? AND status = 'envoyee'", [inv.id]);
      const facts: ReminderFacts = {
        firstName: await ficheFirstName(this.db, await this.unique.membersOf(inv.person_id)),
        alreadySent: sentBefore?.n ?? 0,
        label: inv.label,
        amountCents: inv.amount_cents,
        receivedCents: await this.receivedOf(inv.id),
        issuedOn: inv.issued_on,
        dueOn: addDays(inv.issued_on, this.paymentDays),
      };
      const text = unpaidReminderText(facts);
      // Écrit par le code, le texte ne demande rien ; vérifié quand même, à chaque relance [R62].
      const refused = fundsInOutgoing(text);
      const at = this.now().toISOString();
      const { changes } = await this.db.run(
        `INSERT INTO invoice_reminders (id, network_id, invoice_id, rank, person_id, text, status, rule, message_id, prepared_at, validated_by, validated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?) ON CONFLICT DO NOTHING`,
        [this.newId(), networkId, inv.id, rank, inv.person_id, text, refused ? 'refusee' : 'a_valider', refused ? 'R62' : null, at, at],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'facture.relance', actor: 'system:facturation', subject: `sale_file:${inv.file_id}`, data: { rule: refused ? 'R62' : 'R553', client: `person:${inv.person_id}`, invoice: inv.id, rank, status: refused ? 'refusee' : 'a_valider' } }, this.now);
      if (!refused) made += 1;
    }
    return made;
  }

  /** Les relances du réseau, avec leur texte : la direction seule [R16]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: UnpaidReminder[] } | Refusal> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'invoice_reminders');
    if (refusal) return refusal;
    const rows = await this.db.all<{ id: string; invoice_id: string; label: string; rank: number; text: string; status: ReminderStatus; rule: string | null; prepared_at: string; validated_by: string | null }>(
      `SELECT r.id, r.invoice_id, ${LABEL_SQL('i')} AS label, r.rank, r.text, r.status, r.rule, r.prepared_at, r.validated_by
       FROM invoice_reminders r JOIN invoices i ON i.id = r.invoice_id WHERE r.network_id = ? ORDER BY r.prepared_at, i.number, r.rank`,
      [viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => ({ id: r.id, invoiceId: r.invoice_id, label: r.label, rank: r.rank, text: r.text, status: r.status, rule: r.rule, preparedAt: r.prepared_at, validatedBy: r.validated_by })) };
  }

  /** La direction valide le texte préparé, tel quel : il partira au passage suivant [R553]. */
  async validate(viewer: Viewer, reminderId: string): Promise<{ ok: true } | Refusal | Problem> {
    const refusal = await directionRefusal(this.journal, this.now, viewer, 'invoice_reminder');
    if (refusal) return refusal;
    await this.closeSettled(viewer.networkId);
    const row = await this.db.first<{ network_id: string; invoice_id: string; person_id: string }>('SELECT network_id, invoice_id, person_id FROM invoice_reminders WHERE id = ?', [reminderId]);
    if (!row || row.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      "UPDATE invoice_reminders SET status = 'validee', validated_by = ?, validated_at = ?, updated_at = ? WHERE id = ? AND status = 'a_valider'",
      [actorOf(viewer), at, at, reminderId],
    );
    if (changes !== 1) return { ok: false, rule: 'R553', code: 'not_pending' };
    const file = await this.db.first<{ file_id: string }>('SELECT file_id FROM invoices WHERE id = ?', [row.invoice_id]);
    await appendEvent(this.journal, { type: 'facture.relance', actor: actorOf(viewer), subject: `sale_file:${file?.file_id ?? ''}`, data: { rule: 'R553', client: `person:${row.person_id}`, invoice: row.invoice_id, status: 'validee' } }, this.now);
    return { ok: true };
  }

  /**
   * Le passage d'envoi : chaque relance validée passe par le contrôle central, dans la boîte d'essai [R26]. Une relance
   * refusée pour l'heure attend le passage suivant [R01]. Rend le nombre de relances parties en essai.
   */
  async send(networkId: string): Promise<number> {
    await this.closeSettled(networkId);
    const rows = await this.db.all<{ id: string; invoice_id: string; rank: number; person_id: string; text: string; validated_by: string; file_id: string; agent_id: string | null }>(
      `SELECT r.id, r.invoice_id, r.rank, r.person_id, r.text, r.validated_by, i.file_id, c.agent_id FROM invoice_reminders r
         JOIN invoices i ON i.id = r.invoice_id LEFT JOIN commissions c ON c.file_id = i.file_id
       WHERE r.network_id = ? AND r.status = 'validee' AND r.validated_by IS NOT NULL ORDER BY r.validated_at, r.id`,
      [networkId],
    );
    let sent = 0;
    for (const r of rows) {
      // Réservée d'une seule écriture : deux passages qui se chevauchent n'envoient et ne rangent la relance qu'une fois.
      // Une réservation de plus de 10 minutes est celle d'un passage coupé : elle se reprend.
      const stale = new Date(this.now().getTime() - 10 * 60_000).toISOString();
      const claim = await this.db.run("UPDATE invoice_reminders SET sending_at = ? WHERE id = ? AND status = 'validee' AND (sending_at IS NULL OR sending_at < ?)", [this.now().toISOString(), r.id, stale]);
      if (claim.changes !== 1) continue;
      const inv = await this.db.first<{ amount_cents: number; issued_on: string; label: string }>(`SELECT amount_cents, issued_on, ${LABEL_SQL()} AS label FROM invoices WHERE id = ?`, [r.invoice_id]);
      if (!inv) continue;
      const facts: ReminderFacts = { firstName: null, label: inv.label, amountCents: inv.amount_cents, receivedCents: await this.receivedOf(r.invoice_id), issuedOn: inv.issued_on, dueOn: addDays(inv.issued_on, this.paymentDays) };
      const result = await this.controle.send({
        networkId,
        agentId: r.agent_id,
        personId: r.person_id,
        channel: 'email',
        kind: 'follow_up',
        purpose: SELLER_UPDATE_PURPOSE,
        subject: `relance_facture:${r.invoice_id}:${r.rank}`,
        fallbackTexts: [r.text],
        figures: figuresOf(facts),
        // Revérifié juste avant l'enregistrement : une facture rapprochée, corrigée ou encaissée pendant le passage
        // ne reçoit pas sa relance [R553].
        stillAllowed: async () => {
          const settled = await this.settled(r.invoice_id);
          return settled ? { allowed: false, rule: 'R553', reason: 'La facture n’est plus impayée.' } : { allowed: true, rule: 'R553', reason: '' };
        },
      });
      const closed = result.status !== 'sent' && result.rule === 'R553';
      const status: ReminderStatus = result.status === 'sent' ? 'envoyee' : closed ? 'close' : result.status === 'failed' || result.rule === 'R01' ? 'validee' : 'refusee';
      const rule = result.status === 'sent' ? null : closed ? ((await this.settled(r.invoice_id)) ?? 'R553') : result.rule;
      await this.db.run(
        "UPDATE invoice_reminders SET status = ?, rule = ?, message_id = COALESCE(?, message_id), sending_at = NULL, updated_at = ? WHERE id = ? AND status = 'validee'",
        [status, rule, result.messageId, this.now().toISOString(), r.id],
      );
      await appendEvent(this.journal, { type: 'facture.relance', actor: 'system:facturation', subject: `sale_file:${r.file_id}`, data: { rule: rule ?? 'R553', client: `person:${r.person_id}`, invoice: r.invoice_id, rank: r.rank, status, mode: 'essai' } }, this.now);
      if (status === 'envoyee') sent += 1;
    }
    return sent;
  }
}
