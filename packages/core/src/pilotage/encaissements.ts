/**
 * Encaissement des honoraires et reversement aux agents sous 24 h ouvrées (M13, K03) [R16, R17, R18, R62, R67, R70].
 *
 * La direction rapporte l'encaissement des honoraires d'une commission facturée, avec sa preuve et son heure : le
 * reversement des parts des agents devient exigible 24 h ouvrées plus tard, calculées par le code (heures des jours
 * ouvrés, à Paris : du lundi au vendredi, hors jours fériés). Le passage alerte la direction une fois quand l'échéance
 * approche, une fois quand elle est passée. Le versement rapporté avec sa preuve passe la commission à « payée ».
 * AIMMO ne reçoit, ne verse ni ne suit aucun fonds : seuls le fait rapporté, sa preuve et l'échéance sont rangés [R62].
 *
 * Décidé, lecture prudente : « 24 h ouvrées » se comptent heure par heure sur les seuls jours ouvrés, changement
 * d'heure compris (un encaissement du vendredi à 18 h est à reverser le lundi à 18 h) ; l'alerte part quand il reste
 * 4 heures ou moins avant l'échéance (réglage) ; un encaissement ne se rapporte ni dans le futur ni avant la facture.
 */
import type { Acces } from '../acces/acces.ts';
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { isWorkingDay, localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Commissions } from './commissions.ts';

const TIME_ZONE = 'Europe/Paris';
export const PAYOUT_WORKING_HOURS = 24;
export const PAYOUT_ALERT_HOURS = 4;
const PROOF = /^[A-Za-z0-9_:./-]{1,200}$/;

/** Le premier instant du jour suivant, à Paris, changement d'heure compris. */
function nextLocalMidnight(at: Date): Date {
  const local = localTime(at, TIME_ZONE);
  let c = new Date(at.getTime() + (1440 - local.minutes) * 60_000 - at.getUTCSeconds() * 1000 - at.getUTCMilliseconds());
  const l = localTime(c, TIME_ZONE);
  // Un jour de 23 h ou de 25 h : on corrige d'une heure vers minuit.
  if (l.minutes !== 0) c = new Date(c.getTime() + (l.minutes > 720 ? 1440 - l.minutes : -l.minutes) * 60_000);
  return c;
}

/** L'échéance du reversement : `hours` heures comptées sur les seuls jours ouvrés, à partir de `receivedAt`. */
export function payoutDueAt(receivedAt: Date, hours: number = PAYOUT_WORKING_HOURS): Date {
  let remaining = hours * 3_600_000;
  let cursor = receivedAt;
  for (let guard = 0; guard < 400; guard += 1) {
    const midnight = nextLocalMidnight(cursor);
    if (isWorkingDay(localTime(cursor, TIME_ZONE))) {
      const left = midnight.getTime() - cursor.getTime();
      if (remaining <= left) return new Date(cursor.getTime() + remaining);
      remaining -= left;
    }
    cursor = midnight;
  }
  throw new Error('Échéance introuvable.');
}

export interface PayoutTask {
  fileId: string;
  receivedAt: string;
  payoutDueAt: string;
  alerts: ('avant_echeance' | 'echeance_depassee')[];
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null | 'R67'; code: 'unknown' | 'bad_proof' | 'bad_time' | 'future_time' | 'not_invoiced' | 'already' | 'not_received' | 'before_receipt' };

export class Encaissements {
  private readonly now: () => Date;
  private readonly alertHours: number;
  private readonly commissions: Commissions;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; alertHours?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.alertHours = options.alertHours ?? PAYOUT_ALERT_HOURS;
    this.commissions = new Commissions(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La direction seule rapporte et lit (droits du socle : les chiffres) [R16]. */
  private async refusal(viewer: Viewer, kind: string): Promise<Refusal | null> {
    const code = viewer.role !== 'direction' ? 'role' : (() => {
      const d = decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId });
      return d.allowed ? null : d.code;
    })();
    if (!code) return null;
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private parseTime(v: unknown): Date | null {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(v)) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** L'encaissement des honoraires d'une commission facturée, une seule fois, avec sa preuve [R70]. */
  async recordReceipt(viewer: Viewer, fileId: string, input: { receivedAt: unknown; proofRef: unknown }): Promise<{ ok: true; payoutDueAt: string } | Refusal | Problem> {
    const refusal = await this.refusal(viewer, 'commission_receipt');
    if (refusal) return refusal;
    const c = await this.db.first<{ network_id: string }>('SELECT network_id FROM commissions WHERE file_id = ?', [fileId]);
    if (!c || c.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    if (typeof input.proofRef !== 'string' || !PROOF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    const receivedAt = this.parseTime(input.receivedAt);
    if (!receivedAt) return { ok: false, rule: null, code: 'bad_time' };
    if (receivedAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'future_time' };
    const invoiced = await this.db.first<{ at: string }>("SELECT at FROM commission_steps WHERE file_id = ? AND status = 'facturee'", [fileId]);
    if (!invoiced) return { ok: false, rule: 'R67', code: 'not_invoiced' };
    if (receivedAt.getTime() < Date.parse(invoiced.at)) return { ok: false, rule: null, code: 'bad_time' };
    const due = payoutDueAt(receivedAt).toISOString();
    const { changes } = await this.db.run(
      'INSERT INTO commission_receipts (file_id, network_id, received_at, proof_ref, payout_due_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [fileId, viewer.networkId, receivedAt.toISOString(), input.proofRef, due, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already' };
    // Au journal : le dossier et l'échéance, jamais un montant [R13].
    await appendEvent(this.journal, { type: 'commission.encaissement', actor: this.actor(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R70', payoutDueAt: due } }, this.now);
    return { ok: true, payoutDueAt: due };
  }

  /** Le versement des parts aux agents, rapporté avec sa preuve : la commission passe à « payée » [R67]. */
  async recordPayout(viewer: Viewer, fileId: string, input: { paidAt: unknown; proofRef: unknown }): Promise<{ ok: true; late: boolean } | Refusal | Problem> {
    const refusal = await this.refusal(viewer, 'commission_payout');
    if (refusal) return refusal;
    const r = await this.db.first<{ network_id: string; received_at: string; payout_due_at: string }>('SELECT network_id, received_at, payout_due_at FROM commission_receipts WHERE file_id = ?', [fileId]);
    if (!r) {
      const c = await this.db.first<{ network_id: string }>('SELECT network_id FROM commissions WHERE file_id = ?', [fileId]);
      return c && c.network_id === viewer.networkId ? { ok: false, rule: null, code: 'not_received' } : { ok: false, rule: null, code: 'unknown' };
    }
    if (r.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    if (typeof input.proofRef !== 'string' || !PROOF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    const paidAt = this.parseTime(input.paidAt);
    if (!paidAt) return { ok: false, rule: null, code: 'bad_time' };
    if (paidAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'future_time' };
    if (paidAt.getTime() < Date.parse(r.received_at)) return { ok: false, rule: null, code: 'before_receipt' };
    const { changes } = await this.db.run('INSERT INTO commission_payouts (file_id, network_id, paid_at, proof_ref, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      fileId,
      viewer.networkId,
      paidAt.toISOString(),
      input.proofRef,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    const late = paidAt.getTime() > Date.parse(r.payout_due_at);
    if (changes === 1) await appendEvent(this.journal, { type: 'commission.reversement', actor: this.actor(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R70', late } }, this.now);
    // Repris même si le versement était déjà rangé : une coupure avant l'étape ne la perd jamais.
    const step = await this.commissions.recordStep(viewer.networkId, fileId, 'payee', `versement:${input.proofRef}`.slice(0, 200), this.actor(viewer));
    if (changes !== 1 && (!step.ok && step.code === 'already')) return { ok: false, rule: null, code: 'already' };
    return { ok: true, late };
  }

  /**
   * Le passage : pour chaque reversement non rapporté, une alerte à la direction quand l'échéance approche, une autre
   * quand elle est passée ; chacune une seule fois [R18, R70]. Rend le nombre d'alertes nouvelles.
   */
  async run(networkId: string): Promise<number> {
    const now = this.now();
    let made = 0;
    const rows = await this.db.all<{ file_id: string; payout_due_at: string }>(
      'SELECT r.file_id, r.payout_due_at FROM commission_receipts r WHERE r.network_id = ? AND NOT EXISTS (SELECT 1 FROM commission_payouts p WHERE p.file_id = r.file_id) ORDER BY r.payout_due_at, r.file_id',
      [networkId],
    );
    for (const r of rows) {
      const due = Date.parse(r.payout_due_at);
      const kinds: ('avant_echeance' | 'echeance_depassee')[] = [];
      if (now.getTime() >= due - this.alertHours * 3_600_000 && now.getTime() < due) kinds.push('avant_echeance');
      if (now.getTime() >= due) kinds.push('echeance_depassee');
      for (const kind of kinds) {
        const { changes } = await this.db.run('INSERT INTO commission_payout_alerts (file_id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [r.file_id, kind, now.toISOString()]);
        if (changes === 1) {
          made += 1;
          await appendEvent(this.journal, { type: 'commission.alerte_reversement', actor: 'system:pilotage', subject: `sale_file:${r.file_id}`, data: { rule: 'R70', kind } }, this.now);
        }
      }
    }
    return made;
  }

  /** Les reversements à faire, avec leur échéance et leurs alertes : la direction seule [R16]. */
  async tasks(viewer: Viewer): Promise<{ ok: true; value: PayoutTask[] } | Refusal> {
    const refusal = await this.refusal(viewer, 'commission_payout_tasks');
    if (refusal) return refusal;
    const rows = await this.db.all<{ file_id: string; received_at: string; payout_due_at: string }>(
      'SELECT r.file_id, r.received_at, r.payout_due_at FROM commission_receipts r WHERE r.network_id = ? AND NOT EXISTS (SELECT 1 FROM commission_payouts p WHERE p.file_id = r.file_id) ORDER BY r.payout_due_at, r.file_id',
      [viewer.networkId],
    );
    const value: PayoutTask[] = [];
    for (const r of rows) {
      const alerts = (await this.db.all<{ kind: 'avant_echeance' | 'echeance_depassee' }>("SELECT kind FROM commission_payout_alerts WHERE file_id = ? ORDER BY CASE kind WHEN 'avant_echeance' THEN 0 ELSE 1 END", [r.file_id])).map((a) => a.kind);
      value.push({ fileId: r.file_id, receivedAt: r.received_at, payoutDueAt: r.payout_due_at, alerts });
    }
    return { ok: true, value };
  }
}
