/**
 * Le compteur de la preuve à Dijon (IN01) [R210, R211, R14, R16].
 *
 * La condition de la phase 2 de la Feuille de route : 10 mandats de vente signés par mois, six mois de suite, comptés à
 * partir de janvier 2027. Le compteur part du registre des mandats (R39), jamais d'une saisie ni de la table des
 * mandats : ce qui compte est signé ET inscrit, sur le mois de Paris de la signature figée à l'inscription.
 *
 * Décidé, lecture prudente : une annulation pour erreur et une rétractation retirent le mandat ; une résiliation le
 * laisse compter, il a bien été signé, et elle se voit à part. Le mois en cours ne compte jamais dans la série. Tout se
 * recalcule à chaque lecture : rien n'est gardé, donc une annulation tardive défait la condition. Un registre abîmé
 * empêche de dire la condition remplie. Aucun chiffre par agent [R14] ; la direction seule lit [R16].
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { RegistreMandats } from '../mandats/registre.ts';

export const PROOF_START_MONTH = '2027-01';
export const PROOF_MONTHLY_TARGET = 10;
export const PROOF_REQUIRED_MONTHS = 6;

export interface ProofMonth {
  /** `AAAA-MM`, mois de Paris. */
  month: string;
  /** Faux pour le mois en cours : il se lit, il ne compte jamais dans la série. */
  complete: boolean;
  /** Mandats de vente qui comptent : `simple + exclusive + untyped`. */
  counted: number;
  simple: number;
  exclusive: number;
  /** Inscrits sans document signé qui dise leur type : ils comptent, et se voient. */
  untyped: number;
  /** Retirés du compte. */
  cancelledError: number;
  withdrawn: number;
  /** Résiliés depuis : ils comptent, et se voient. */
  terminated: number;
  /** Signés, jamais inscrits : ils ne comptent pas tant qu'ils ne sont pas inscrits. */
  notInscribed: number;
  targetMet: boolean;
}

export interface ProofRun {
  length: number;
  from: string | null;
  to: string | null;
}

export interface ProofCounter {
  startMonth: string;
  target: number;
  requiredMonths: number;
  currentMonth: string;
  months: ProofMonth[];
  /** La série qui se termine au dernier mois fini. */
  currentRun: ProofRun;
  bestRun: ProofRun;
  condition: { met: boolean; metOn: string | null };
  registerSound: boolean;
}

type Refusal = { ok: false; rule: 'R16'; code: string };

const parisMonthFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' });
/** Le mois de Paris d'un instant : le 31 janvier à 23 h 30 UTC est déjà février à Paris. */
export function parisMonth(at: Date): string {
  const parts = parisMonthFormat.formatToParts(at);
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}

const nextMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

const emptyMonth = (month: string, complete: boolean): ProofMonth => ({ month, complete, counted: 0, simple: 0, exclusive: 0, untyped: 0, cancelledError: 0, withdrawn: 0, terminated: 0, notInscribed: 0, targetMet: false });

/** Les séries de mois finis à la cible ; `met` à partir du mois qui complète la première série assez longue. */
export function proofRuns(months: readonly Pick<ProofMonth, 'month' | 'complete' | 'targetMet'>[], required: number = PROOF_REQUIRED_MONTHS): { currentRun: ProofRun; bestRun: ProofRun; condition: { met: boolean; metOn: string | null } } {
  let run: ProofRun = { length: 0, from: null, to: null };
  let bestRun = run;
  let metOn: string | null = null;
  for (const m of months) {
    if (!m.complete) continue;
    run = m.targetMet ? { length: run.length + 1, from: run.from ?? m.month, to: m.month } : { length: 0, from: null, to: null };
    if (run.length > bestRun.length) bestRun = run;
    if (run.length >= required && metOn === null) metOn = m.month;
  }
  return { currentRun: run, bestRun, condition: { met: metOn !== null, metOn } };
}

interface LineRow {
  mandate_id: string;
  number: string;
  hash: string;
  signed_at: string;
  document_kind: string | null;
  cancel_reason: string | null;
}

export class CompteurPreuve {
  private readonly now: () => Date;
  private readonly registre: RegistreMandats;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.registre = new RegistreMandats(db, journal, { now: this.now });
  }

  async read(viewer: Viewer): Promise<{ ok: true; value: ProofCounter } | Refusal> {
    const d = viewer.role === 'direction' ? decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId }) : null;
    if (!d || !d.allowed) {
      const code = d && !d.allowed ? d.code : 'role';
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'proof_counter', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    }
    const value = await this.compute(viewer.networkId);
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { kind: 'proof_counter' } }, this.now);
    return { ok: true, value };
  }

  /** Les lignes qui comptent pour un mois : le numéro et l'empreinte de chacune, triés par numéro [R212]. */
  async countedLines(networkId: string, month: string): Promise<{ number: string; hash: string }[]> {
    const lines = await this.registerLines(networkId);
    return lines
      .filter((l) => parisMonth(new Date(l.signed_at)) === month && l.cancel_reason !== 'error' && l.cancel_reason !== 'withdrawal')
      .map((l) => ({ number: l.number, hash: l.hash }))
      .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
  }

  private registerLines(networkId: string): Promise<LineRow[]> {
    // La date de signature est celle figée par la ligne du registre ; une ligne n'a qu'une annulation. Une rétractation
    // rangée vaut retrait même si la ligne d'annulation n'a pas pu s'écrire : le compte ne penche jamais vers le haut.
    return this.db.all<LineRow>(
      `SELECT r.mandate_id, r.number, r.hash, r.signed_at, d.kind AS document_kind, CASE WHEN w.mandate_id IS NOT NULL THEN 'withdrawal' ELSE c.reason END AS cancel_reason
         FROM mandate_register r
         LEFT JOIN mandate_register c ON c.network_id = r.network_id AND c.kind = 'annulation' AND c.cancels_seq = r.seq
         LEFT JOIN mandate_withdrawals w ON w.mandate_id = r.mandate_id
         LEFT JOIN signed_documents s ON s.mandate_id = r.mandate_id
         LEFT JOIN documents d ON d.id = s.document_id
        WHERE r.network_id = ? AND r.kind = 'inscription'`,
      [networkId],
    );
  }

  /** Le calcul, sans droits : pour le sceau d'un mois et les tests. */
  async compute(networkId: string): Promise<ProofCounter> {
    const currentMonth = parisMonth(this.now());
    const months = new Map<string, ProofMonth>();
    for (let m = PROOF_START_MONTH; m <= currentMonth; m = nextMonth(m)) months.set(m, emptyMonth(m, m < currentMonth));

    const lines = await this.registerLines(networkId);
    for (const line of lines) {
      const month = months.get(parisMonth(new Date(line.signed_at)));
      if (!month) continue;
      if (line.cancel_reason === 'error') {
        month.cancelledError += 1;
        continue;
      }
      if (line.cancel_reason === 'withdrawal') {
        month.withdrawn += 1;
        continue;
      }
      if (line.cancel_reason === 'termination') month.terminated += 1;
      month.counted += 1;
      if (line.document_kind === 'mandat_vente_simple') month.simple += 1;
      else if (line.document_kind === 'mandat_vente_exclusif') month.exclusive += 1;
      else month.untyped += 1;
    }

    // Une rétractation rangée sans inscription n'est pas un mandat à inscrire : elle ne se compte nulle part ici.
    const missing = await this.db.all<{ signed_at: string }>(
      `SELECT m.signed_at FROM mandates m
        WHERE m.network_id = ?
          AND NOT EXISTS (SELECT 1 FROM mandate_register r WHERE r.mandate_id = m.id AND r.kind = 'inscription')
          AND NOT EXISTS (SELECT 1 FROM mandate_withdrawals w WHERE w.mandate_id = m.id)`,
      [networkId],
    );
    for (const row of missing) {
      const month = months.get(parisMonth(new Date(row.signed_at)));
      if (month) month.notInscribed += 1;
    }

    const list = [...months.values()].map((m) => ({ ...m, targetMet: m.counted >= PROOF_MONTHLY_TARGET }));
    const runs = proofRuns(list);
    const registerSound = (await this.registre.check(networkId)).ok;
    return {
      startMonth: PROOF_START_MONTH,
      target: PROOF_MONTHLY_TARGET,
      requiredMonths: PROOF_REQUIRED_MONTHS,
      currentMonth,
      months: list,
      currentRun: runs.currentRun,
      bestRun: runs.bestRun,
      condition: registerSound ? runs.condition : { met: false, metOn: null },
      registerSound,
    };
  }
}
