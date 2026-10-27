/**
 * Rétractation et diffusion bloquée (M06, D05) [R42].
 *
 * Un mandat signé hors de l'agence ou à distance ouvre au vendeur un délai de rétractation de 14 jours, compté à
 * l'heure de Paris à partir du lendemain de la signature ; un délai qui finit un samedi, un dimanche ou un jour férié
 * est prolongé jusqu'au jour ouvrable suivant. Un mandat signé à l'agence n'en a pas.
 *
 * Une seule fonction dit si un bien peut être diffusé, et tout ce qui publie doit passer par elle : il faut un mandat
 * signé, numéroté au registre et non annulé, en cours (sa durée n'est pas écoulée), non rétracté, et hors délai de
 * rétractation, sauf demande écrite du vendeur rangée avec sa preuve. Une rétractation reçue dans le délai arrête le
 * mandat : son inscription au registre est annulée, la diffusion s'arrête.
 *
 * Décidé, lecture prudente : un mandat dont la durée n'est pas connue ne se diffuse pas. Le formulaire de
 * rétractation fait partie du modèle validé par Marion Gravelin et l'avocat (H08).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { frenchHolidays, localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { RegistreMandats } from '../mandats/registre.ts';
import type { DocumentFacts } from './modeles.ts';

const TIME_ZONE = 'Europe/Paris';
export const WITHDRAWAL_DAYS = 14;

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();

const isWorkingDay = (day: string): boolean => {
  const w = weekday(day);
  return w !== 0 && w !== 6 && !frenchHolidays(Number(day.slice(0, 4))).has(day);
};

/** Le dernier jour du délai de rétractation (inclus), `AAAA-MM-JJ`, ou null sans délai. */
export function withdrawalLastDay(signedAt: Date, place: string): string | null {
  if (place === 'agence') return null;
  let last = addDays(localTime(signedAt, TIME_ZONE).date, WITHDRAWAL_DAYS);
  while (!isWorkingDay(last)) last = addDays(last, 1);
  return last;
}

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

export type DiffusionReason =
  | 'no_mandate'
  | 'cancelled'
  | 'withdrawn'
  | 'expired'
  | 'duration_unknown'
  | 'withdrawal_period'
  | 'allowed'
  | 'allowed_early_start';

export interface DiffusionDecision {
  allowed: boolean;
  reason: DiffusionReason;
  mandateId: string | null;
  /** Dernier jour du délai de rétractation, s'il y en a un. */
  withdrawalLastDay: string | null;
}

interface SignedMandateRow {
  mandate_id: string;
  network_id: string;
  signed_at: string;
  place: string;
  number: string | null;
  facts: string | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R42' | null; code: 'bad_proof' | 'bad_date' | 'unknown_mandate' | 'no_withdrawal_period' | 'delay_over' | 'already_recorded' | 'withdrawn' | 'not_inscribed' };

export class Diffusion {
  private readonly now: () => Date;
  private readonly registre: RegistreMandats;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.registre = new RegistreMandats(db, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La décision pour un mandat signé : en cours, rétracté, en délai, etc. */
  private async decideMandate(row: SignedMandateRow, at: Date): Promise<DiffusionDecision> {
    const decision = (allowed: boolean, reason: DiffusionReason, last: string | null = null): DiffusionDecision => ({ allowed, reason, mandateId: row.mandate_id, withdrawalLastDay: last });
    const inscription = await this.db.first<{ seq: number }>(`SELECT seq FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'`, [row.mandate_id]);
    if (!inscription || row.number === null) return decision(false, 'no_mandate');
    if (await this.db.first('SELECT mandate_id FROM mandate_withdrawals WHERE mandate_id = ?', [row.mandate_id])) return decision(false, 'withdrawn');
    if (await this.db.first(`SELECT seq FROM mandate_register WHERE network_id = ? AND kind = 'annulation' AND cancels_seq = ?`, [row.network_id, Number(inscription.seq)])) return decision(false, 'cancelled');
    let facts: DocumentFacts | null = null;
    try {
      facts = row.facts ? (JSON.parse(row.facts) as DocumentFacts) : null;
    } catch {
      facts = null;
    }
    const signedAt = new Date(row.signed_at);
    if (!facts || facts.durationMonths === null) return decision(false, 'duration_unknown');
    // La fin du mandat se compte en jours de Paris ; un 31 sans équivalent devient le dernier jour du mois [R42].
    if (localTime(at, TIME_ZONE).date >= mandateEndDay(signedAt, facts.durationMonths)) return decision(false, 'expired');
    const last = withdrawalLastDay(signedAt, row.place);
    if (last !== null && localTime(at, TIME_ZONE).date <= last) {
      if (await this.db.first('SELECT mandate_id FROM mandate_early_starts WHERE mandate_id = ?', [row.mandate_id])) return decision(true, 'allowed_early_start', last);
      return decision(false, 'withdrawal_period', last);
    }
    return decision(true, 'allowed', last);
  }

  /**
   * Le bien peut-il être diffusé maintenant ? La seule porte de toute publication [R42]. Sans droits : c'est le
   * système qui la consulte avant de publier ; la décision ne porte aucune donnée personnelle.
   */
  async canDiffuse(networkId: string, propertyId: string, at: Date = this.now()): Promise<DiffusionDecision> {
    const rows = await this.db.all<SignedMandateRow>(
      `SELECT s.mandate_id, s.network_id, s.signed_at, s.place, s.number, d.facts FROM signed_documents s
       JOIN documents d ON d.id = s.document_id JOIN mandates m ON m.id = s.mandate_id
       WHERE s.network_id = ? AND m.property_id = ? AND s.mandate_id IS NOT NULL AND s.copy_content IS NOT NULL
       ORDER BY s.signed_at DESC`,
      [networkId, propertyId],
    );
    let first: DiffusionDecision | null = null;
    for (const row of rows) {
      const d = await this.decideMandate(row, at);
      if (d.allowed) return d;
      first ??= d;
    }
    return first ?? { allowed: false, reason: 'no_mandate', mandateId: null, withdrawalLastDay: null };
  }

  /** La décision, demandée par quelqu'un qui voit le bien en entier [R16]. */
  async read(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: DiffusionDecision } | Refusal> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p;
    if (p.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'diffusion', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    return { ok: true, value: await this.canDiffuse(viewer.networkId, propertyId) };
  }

  /** Le mandat signé, si on voit sa fiche en entier : l'agent de la fiche ou la direction. */
  private async mandateFor(viewer: Viewer, mandateId: string): Promise<{ ok: true; row: SignedMandateRow } | Refusal | Problem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const m = await this.db.first<{ person_id: string; network_id: string; agent_id: string }>('SELECT person_id, network_id, agent_id FROM mandates WHERE id = ?', [mandateId]);
    if (!m || m.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_mandate' };
    // Les mêmes droits que le registre : l'agent du mandat lui-même, ou la direction.
    if (viewer.role === 'agent' && m.agent_id !== viewer.userId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R16', role: 'agent', kind: 'mandate', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const read = await this.acces.readFiche(viewer, m.person_id);
    if (!read.ok) return read;
    if (read.view !== 'full') return { ok: false, rule: 'R16', code: 'not_assigned' };
    const row = await this.db.first<SignedMandateRow>(
      `SELECT s.mandate_id, s.network_id, s.signed_at, s.place, s.number, d.facts FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ?`,
      [mandateId],
    );
    if (!row) return { ok: false, rule: null, code: 'unknown_mandate' };
    return { ok: true, row };
  }

  /** La demande écrite du vendeur de diffuser avant la fin du délai, avec sa preuve. */
  async recordEarlyStart(viewer: Viewer, mandateId: string, input: { proof: string; receivedAt: Date }): Promise<{ ok: true } | Refusal | Problem> {
    if (typeof input.proof !== 'string' || input.proof.trim() === '' || input.proof.length > 300) return { ok: false, rule: null, code: 'bad_proof' };
    if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime()) || input.receivedAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    const found = await this.mandateFor(viewer, mandateId);
    if (!found.ok) return found;
    if (withdrawalLastDay(new Date(found.row.signed_at), found.row.place) === null) return { ok: false, rule: 'R42', code: 'no_withdrawal_period' };
    // La demande doit suivre la signature : une date d'avant est refusée.
    if (input.receivedAt.getTime() < Date.parse(found.row.signed_at)) return { ok: false, rule: null, code: 'bad_date' };
    if (await this.db.first('SELECT mandate_id FROM mandate_withdrawals WHERE mandate_id = ?', [mandateId])) return { ok: false, rule: 'R42', code: 'withdrawn' };
    const { changes } = await this.db.run(
      'INSERT INTO mandate_early_starts (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (mandate_id) DO NOTHING',
      [mandateId, viewer.networkId, input.proof.trim(), input.receivedAt.toISOString(), this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_recorded' };
    await appendEvent(this.journal, { type: 'mandat.debut_anticipe', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R42' } }, this.now);
    return { ok: true };
  }

  /** La rétractation reçue dans le délai : le mandat s'arrête, son inscription est annulée, la diffusion cesse. */
  async recordWithdrawal(viewer: Viewer, mandateId: string, input: { proof: string; receivedAt: Date }): Promise<{ ok: true } | Refusal | Problem> {
    if (typeof input.proof !== 'string' || input.proof.trim() === '' || input.proof.length > 300) return { ok: false, rule: null, code: 'bad_proof' };
    if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime()) || input.receivedAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    const found = await this.mandateFor(viewer, mandateId);
    if (!found.ok) return found;
    const last = withdrawalLastDay(new Date(found.row.signed_at), found.row.place);
    if (last === null) return { ok: false, rule: 'R42', code: 'no_withdrawal_period' };
    if (input.receivedAt.getTime() < Date.parse(found.row.signed_at)) return { ok: false, rule: null, code: 'bad_date' };
    if (localTime(input.receivedAt, TIME_ZONE).date > last) return { ok: false, rule: 'R42', code: 'delay_over' };
    // Un mandat pas encore numéroté ne s'annule pas au registre : la signature (D04) doit d'abord être reprise.
    if (found.row.number === null) return { ok: false, rule: null, code: 'not_inscribed' };
    const { changes } = await this.db.run(
      'INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (mandate_id) DO NOTHING',
      [mandateId, viewer.networkId, input.proof.trim(), input.receivedAt.toISOString(), this.actor(viewer), this.now().toISOString()],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'mandat.retracte', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R42' } }, this.now);
    // L'inscription au registre est annulée ; une reprise après coupure le fait si ce n'est pas déjà fait.
    const cancelled = await this.registre.cancel(viewer, mandateId, 'withdrawal');
    if (!cancelled.ok && cancelled.code !== 'already_cancelled') return cancelled as Refusal | Problem;
    // Une reprise qui vient de faire l'annulation manquante réussit ; une rétractation déjà complète est signalée.
    return changes === 1 || cancelled.ok ? { ok: true } : { ok: false, rule: null, code: 'already_recorded' };
  }
}
