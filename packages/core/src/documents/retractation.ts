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
import { parisDayStart } from '../pilotage/tableau-agent.ts';
import { mandateEndDay, mandateTerms } from './conditions.ts';

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
type Problem = { ok: false; rule: 'R42' | null; code: 'bad_proof' | 'bad_date' | 'unknown_mandate' | 'no_withdrawal_period' | 'delay_over' | 'already_recorded' | 'withdrawn' | 'not_inscribed' | 'not_withdrawn' };

/** Un vrai jour `AAAA-MM-JJ`, pas seulement sa forme. */
const isRealDay = (day: unknown): day is string =>
  typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T12:00:00Z`)) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day;

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
    // La durée en vigueur à cette date : celle du mandat, ou du dernier avenant signé alors qui la change (D07, D10).
    const terms = await mandateTerms(this.db, row.mandate_id, at);
    const duration = terms?.durationMonths ?? facts?.durationMonths ?? null;
    if (duration === null) return decision(false, 'duration_unknown');
    // La fin du mandat se compte en jours de Paris ; un 31 sans équivalent devient le dernier jour du mois [R42].
    if (localTime(at, TIME_ZONE).date >= mandateEndDay(signedAt, duration)) return decision(false, 'expired');
    const last = withdrawalLastDay(signedAt, row.place);
    if (last !== null && localTime(at, TIME_ZONE).date <= last) {
      // La demande écrite du vendeur ne compte qu'à partir du jour où elle est reçue (D10).
      const early = await this.db.first<{ received_at: string }>('SELECT received_at FROM mandate_early_starts WHERE mandate_id = ?', [row.mandate_id]);
      if (early && localTime(new Date(early.received_at), TIME_ZONE).date <= localTime(at, TIME_ZONE).date) return decision(true, 'allowed_early_start', last);
      return decision(false, 'withdrawal_period', last);
    }
    return decision(true, 'allowed', last);
  }

  /**
   * Le bien peut-il être diffusé maintenant ? La seule porte de toute publication [R42]. Sans droits : c'est le
   * système qui la consulte avant de publier ; la décision ne porte aucune donnée personnelle.
   */
  /**
   * AU106 · les biens qui ont au moins un exemplaire signé d'un mandat complet : hors d'eux, `canDiffuse` répond
   * toujours « pas de mandat ». Une requête pour tout le réseau, au lieu d'une par bien.
   */
  async diffusionCandidates(networkId: string): Promise<Set<string>> {
    const rows = await this.db.all<{ property_id: string }>(
      `SELECT DISTINCT m.property_id FROM signed_documents s
       JOIN documents d ON d.id = s.document_id JOIN mandates m ON m.id = s.mandate_id
       WHERE s.network_id = ? AND m.property_id IS NOT NULL AND s.mandate_id IS NOT NULL AND s.copy_content IS NOT NULL`,
      [networkId],
    );
    return new Set(rows.map((r) => r.property_id));
  }

  async canDiffuse(networkId: string, propertyId: string, at: Date = this.now()): Promise<DiffusionDecision> {
    const rows = await this.db.all<SignedMandateRow>(
      `SELECT s.mandate_id, s.network_id, s.signed_at, s.place, s.number, d.facts FROM signed_documents s
       JOIN documents d ON d.id = s.document_id JOIN mandates m ON m.id = s.mandate_id
       WHERE s.network_id = ? AND m.property_id = ? AND s.mandate_id IS NOT NULL AND s.copy_content IS NOT NULL
       ORDER BY s.signed_at DESC`,
      [networkId, propertyId],
    );
    let first: DiffusionDecision | null = null;
    const day = localTime(at, TIME_ZONE).date;
    for (const row of rows) {
      // Un mandat signé après cette date n'existait pas encore (D10).
      if (localTime(new Date(row.signed_at), TIME_ZONE).date > day) continue;
      const d = await this.decideMandate(row, at);
      if (d.allowed) return d;
      first ??= d;
    }
    return first ?? { allowed: false, reason: 'no_mandate', mandateId: null, withdrawalLastDay: null };
  }

  /**
   * Depuis quand la porte est ouverte pour ce bien, sur le mandat qu'elle retient (IN11) [R222] : le dernier des faits
   * sans lesquels elle resterait fermée, signature complète, inscription au registre, et fin du délai de rétractation ou
   * demande écrite du vendeur, comptée du moment où AIMMO l'a notée. Null si elle est fermée.
   */
  async diffusableSince(networkId: string, propertyId: string, at: Date = this.now()): Promise<{ mandateId: string; since: string } | null> {
    const gate = await this.canDiffuse(networkId, propertyId, at);
    if (!gate.allowed || gate.mandateId === null) return null;
    const signed = await this.db.first<{ signed_at: string; place: string; created_at: string; completed_at: string | null }>('SELECT signed_at, place, created_at, completed_at FROM signed_documents WHERE mandate_id = ?', [gate.mandateId]);
    const line = await this.db.first<{ at: string }>(`SELECT at FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'`, [gate.mandateId]);
    if (!signed || !line) return null;
    const moments = [Date.parse(signed.signed_at), Date.parse(signed.created_at), Date.parse(line.at)];
    if (signed.completed_at !== null) moments.push(Date.parse(signed.completed_at));
    const last = withdrawalLastDay(new Date(signed.signed_at), signed.place);
    if (last !== null) {
      const delayOver = parisDayStart(addDays(last, 1)).getTime();
      const early = await this.db.first<{ created_at: string }>('SELECT created_at FROM mandate_early_starts WHERE mandate_id = ?', [gate.mandateId]);
      moments.push(early ? Math.min(delayOver, Date.parse(early.created_at)) : delayOver);
    }
    return { mandateId: gate.mandateId, since: new Date(Math.max(...moments)).toISOString() };
  }

  /**
   * Un autre mandat vivant sur ce bien (D15) : toute inscription au registre compte, même sans exemplaire après une coupure,
   * et une seule suffit. Seuls l'annulation, la rétractation et l'échéance rendent le bien. Différent de `canDiffuse`, qui
   * cherche un mandat diffusable et ne voit que les mandats complets.
   */
  async otherLiveMandate(networkId: string, propertyId: string, exceptMandateId: string, at: Date = this.now()): Promise<string | null> {
    const lines = await this.db.all<{ seq: number; mandate_id: string; number: string }>(
      `SELECT seq, mandate_id, number FROM mandate_register WHERE network_id = ? AND property_id = ? AND kind = 'inscription' AND mandate_id <> ?`,
      [networkId, propertyId, exceptMandateId],
    );
    for (const line of lines) {
      const row = await this.db.first<SignedMandateRow>(
        `SELECT s.mandate_id, s.network_id, s.signed_at, s.place, s.number, d.facts FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ?`,
        [line.mandate_id],
      );
      if (row) {
        // Une coupure peut laisser le numéro au registre sans qu'il soit encore recopié sur la signature.
        const { reason } = await this.decideMandate({ ...row, number: row.number ?? line.number }, at);
        if (reason !== 'cancelled' && reason !== 'withdrawn' && reason !== 'expired') return line.mandate_id;
      } else if (!(await this.db.first(`SELECT seq FROM mandate_register WHERE network_id = ? AND kind = 'annulation' AND cancels_seq = ?`, [networkId, Number(line.seq)]))) {
        return line.mandate_id;
      }
    }
    return null;
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
    if (!m || m.network_id !== viewer.networkId) {
      // Inconnu ou d'un autre réseau : refusé sans dire s'il existe, et le refus est au journal [R16].
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_mandate' };
    }
    // Les mêmes droits que le registre : l'agent du mandat lui-même, ou la direction.
    if (viewer.role === 'agent' && m.agent_id !== viewer.userId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R16', role: 'agent', kind: 'mandate', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const read = await this.acces.readFiche(viewer, m.person_id);
    if (!read.ok) return read;
    if (read.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const row = await this.db.first<SignedMandateRow>(
      `SELECT s.mandate_id, s.network_id, s.signed_at, s.place, s.number, d.facts FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ?`,
      [mandateId],
    );
    if (!row) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_mandate' };
    }
    return { ok: true, row };
  }

  /**
   * L'instant d'un jour donné par l'écran : l'heure du téléphone ne compte pas, seul le jour de Paris compte (D16).
   * Aujourd'hui vaut l'instant du serveur ; un jour passé, 21 h UTC, encore ce jour-là à Paris été comme hiver, et jamais
   * avant une signature du même jour. Nul si le jour est à venir ou d'avant la signature.
   */
  private instantOfDay(day: string, signedAt: Date): Date | null {
    const today = localTime(this.now(), TIME_ZONE).date;
    if (day > today || day < localTime(signedAt, TIME_ZONE).date) return null;
    if (day === today) return this.now();
    const late = new Date(`${day}T21:00:00.000Z`);
    return late.getTime() < signedAt.getTime() ? signedAt : late;
  }

  /** La demande écrite du vendeur de diffuser avant la fin du délai, avec sa preuve. `receivedOn` : le jour, à la place de l'instant. */
  async recordEarlyStart(viewer: Viewer, mandateId: string, input: { proof: string; receivedAt?: Date; receivedOn?: string }): Promise<{ ok: true } | Refusal | Problem> {
    if (typeof input.proof !== 'string' || input.proof.trim() === '' || input.proof.length > 300) return { ok: false, rule: null, code: 'bad_proof' };
    if (input.receivedOn !== undefined ? !isRealDay(input.receivedOn) : !(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime()) || input.receivedAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    const found = await this.mandateFor(viewer, mandateId);
    if (!found.ok) return found;
    if (withdrawalLastDay(new Date(found.row.signed_at), found.row.place) === null) return { ok: false, rule: 'R42', code: 'no_withdrawal_period' };
    const receivedAt = input.receivedOn !== undefined ? this.instantOfDay(input.receivedOn, new Date(found.row.signed_at)) : (input.receivedAt as Date);
    // La demande doit suivre la signature : une date d'avant est refusée.
    if (receivedAt === null || receivedAt.getTime() < Date.parse(found.row.signed_at)) return { ok: false, rule: null, code: 'bad_date' };
    if (await this.db.first('SELECT mandate_id FROM mandate_withdrawals WHERE mandate_id = ?', [mandateId])) return { ok: false, rule: 'R42', code: 'withdrawn' };
    const { changes } = await this.db.run(
      'INSERT INTO mandate_early_starts (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (mandate_id) DO NOTHING',
      [mandateId, viewer.networkId, input.proof.trim(), receivedAt.toISOString(), this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_recorded' };
    await appendEvent(this.journal, { type: 'mandat.debut_anticipe', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R42' } }, this.now);
    return { ok: true };
  }

  /**
   * La rétractation envoyée dans le délai : le mandat s'arrête, son inscription est annulée, la diffusion cesse.
   *
   * Décidé (D16), lecture prudente : c'est l'envoi qui compte, pas la réception (code de la consommation, L221-21 ; à faire
   * confirmer, H44). `sentOn` dit ce jour, et la rétractation est alors reçue à l'instant. Sans `sentOn`, `receivedAt` vaut
   * pour les deux.
   */
  async recordWithdrawal(viewer: Viewer, mandateId: string, input: { proof: string; receivedAt?: Date; sentOn?: string }): Promise<{ ok: true } | Refusal | Problem> {
    if (typeof input.proof !== 'string' || input.proof.trim() === '' || input.proof.length > 300) return { ok: false, rule: null, code: 'bad_proof' };
    if (input.sentOn !== undefined ? !isRealDay(input.sentOn) : !(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime()) || input.receivedAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    const found = await this.mandateFor(viewer, mandateId);
    if (!found.ok) return found;
    const signedAt = new Date(found.row.signed_at);
    const last = withdrawalLastDay(signedAt, found.row.place);
    if (last === null) return { ok: false, rule: 'R42', code: 'no_withdrawal_period' };
    const receivedAt = input.sentOn !== undefined ? this.now() : (input.receivedAt as Date);
    const sentOn = input.sentOn ?? localTime(receivedAt, TIME_ZONE).date;
    if (input.sentOn !== undefined ? this.instantOfDay(input.sentOn, signedAt) === null : receivedAt.getTime() < signedAt.getTime()) return { ok: false, rule: null, code: 'bad_date' };
    if (sentOn > last) return { ok: false, rule: 'R42', code: 'delay_over' };
    // Un mandat pas encore numéroté ne s'annule pas au registre : la signature (D04) doit d'abord être reprise.
    if (found.row.number === null) return { ok: false, rule: null, code: 'not_inscribed' };
    const { changes } = await this.db.run(
      'INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, sent_on, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (mandate_id) DO NOTHING',
      [mandateId, viewer.networkId, input.proof.trim(), receivedAt.toISOString(), sentOn, this.actor(viewer), this.now().toISOString()],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'mandat.retracte', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R42' } }, this.now);
    // L'inscription au registre est annulée ; une reprise après coupure le fait si ce n'est pas déjà fait.
    const cancelled = await this.registre.cancel(viewer, mandateId, 'withdrawal');
    if (!cancelled.ok && cancelled.code !== 'already_cancelled') return cancelled as Refusal | Problem;
    // Une reprise qui vient de faire l'annulation manquante réussit ; une rétractation déjà complète est signalée.
    return changes === 1 || cancelled.ok ? { ok: true } : { ok: false, rule: null, code: 'already_recorded' };
  }

  /** La rétractation notée dont l'annulation au registre n'a pas abouti, qui se reprend depuis l'écran (D16). */
  async withdrawalUnfinished(networkId: string, mandateId: string): Promise<boolean> {
    if (!(await this.db.first('SELECT mandate_id FROM mandate_withdrawals WHERE mandate_id = ?', [mandateId]))) return false;
    const inscription = await this.db.first<{ seq: number }>(`SELECT seq FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'`, [mandateId]);
    if (!inscription) return false;
    return !(await this.db.first(`SELECT seq FROM mandate_register WHERE network_id = ? AND kind = 'annulation' AND cancels_seq = ?`, [networkId, Number(inscription.seq)]));
  }

  /** Finit une rétractation déjà notée : rien de neuf n'est saisi, seule l'annulation manquante se fait. */
  async resumeWithdrawal(viewer: Viewer, mandateId: string): Promise<{ ok: true } | Refusal | Problem> {
    const found = await this.mandateFor(viewer, mandateId);
    if (!found.ok) return found;
    if (!(await this.db.first('SELECT mandate_id FROM mandate_withdrawals WHERE mandate_id = ?', [mandateId]))) return { ok: false, rule: null, code: 'not_withdrawn' };
    const cancelled = await this.registre.cancel(viewer, mandateId, 'withdrawal');
    if (cancelled.ok) return { ok: true };
    return cancelled.code === 'already_cancelled' ? { ok: false, rule: null, code: 'already_recorded' } : (cancelled as Refusal | Problem);
  }
}
