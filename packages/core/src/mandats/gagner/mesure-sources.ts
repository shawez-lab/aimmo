/**
 * Mesure mensuelle : garder ce qui rapporte des mandats (M20 complet, G10).
 *
 * Chaque mois, par source : les mandats signés (G03, `mandates.source_kind`), les rendez-vous d'estimation tenus, rangés
 * sous la source de la fiche de la personne, le coût saisi par la direction avec sa preuve, et le coût par mandat.
 * Chaque nombre vient de la base et se recalcule [R144]. Le compte rendu ne porte que des nombres, aucune donnée
 * personnelle [R13]. Seule la direction le lit et décide de garder ou d'arrêter une source ; le code ne propose ni ne
 * prend aucune décision [R144, R16]. Rien ne s'efface : une correction s'ajoute en version, une décision nouvelle
 * s'ajoute à la suite [R17].
 */
import type { Viewer } from '../../acces/droits.ts';
import { FicheClient } from '../../db/fiche-client.ts';
import type { SqlDatabase } from '../../db/sql.ts';
import { FicheUnique } from '../../fiche/fusion.ts';
import { localTime } from '../../envoi/horaires.ts';
import { appendEvent } from '../../journal/journal.ts';
import type { JournalStore } from '../../journal/types.ts';
import { CHANNEL_SOURCES, MANDATE_SOURCES, MANDATE_SOURCE_LABELS, type MandateSource } from '../source.ts';

/** Les rendez-vous d'une fiche dont la source n'est pas connue. */
export const UNKNOWN_SOURCE = 'inconnue';
export type MeasuredSource = MandateSource | typeof UNKNOWN_SOURCE;
export const SOURCE_DECISIONS = ['garder', 'arreter'] as const;
export type SourceDecision = (typeof SOURCE_DECISIONS)[number];

/** Le stockage des preuves de coût : une facture, un relevé ; seule sa référence est rangée ici. */
export interface CostProofStore {
  has(ref: string): Promise<boolean>;
}

export interface SourceLine {
  source: MeasuredSource;
  label: string;
  mandates: number;
  appointments: number;
  /** Le coût du mois en centimes, dernière version saisie ; `null` s'il n'a pas été saisi. */
  costCents: number | null;
  /** Coût par mandat en centimes, arrondi à l'entier le plus proche ; `null` sans coût ou sans mandat. */
  costPerMandateCents: number | null;
  /** La dernière décision de la direction sur cette source, quel que soit le mois, ou `null`. */
  decision: { decision: SourceDecision; month: string; decidedAt: string } | null;
}

export interface SourceReport {
  month: string;
  lines: SourceLine[];
  totals: { mandates: number; appointments: number; costCents: number };
}

export type SourceMeasureRefusal = { ok: false; rule: 'R16' | 'R144' | null; code: string };
export type SourceMeasureResult<T> = { ok: true; value: T } | SourceMeasureRefusal;

export interface MesureSourcesOptions {
  now?: () => Date;
  newId?: () => string;
  timeZone?: string;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = 86_400_000;
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export class MesureSources {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly timeZone: string;
  private readonly fiche: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly proofs: CostProofStore,
    private readonly journal: JournalStore,
    options: MesureSourcesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.timeZone = options.timeZone ?? 'Europe/Paris';
    this.fiche = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La direction seulement ; tout autre rôle est refusé et le refus est au journal [R16]. */
  private async gate(viewer: Viewer, kind: string): Promise<SourceMeasureRefusal | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } }, this.now);
    return { ok: false, rule: 'R16', code: 'role' };
  }

  private local(at: string): string {
    return localTime(new Date(at), this.timeZone).date.slice(0, 7);
  }

  /** Les bornes larges d'un mois en temps universel ; le mois de Paris exact est gardé ensuite. */
  private bounds(month: string): [string, string] {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return [new Date(Date.UTC(y, m - 1, 1) - DAY).toISOString(), new Date(Date.UTC(y, m, 1) + DAY).toISOString()];
  }

  /** La direction saisit le coût d'une source pour un mois, avec la référence de sa preuve déposée. */
  async enterCost(viewer: Viewer, input: { month?: unknown; source?: unknown; amountCents?: unknown; proofRef?: unknown }): Promise<SourceMeasureResult<{ version: number }>> {
    const denied = await this.gate(viewer, 'source_cost');
    if (denied) return denied;
    const { month, source, amountCents, proofRef } = input;
    if (typeof month !== 'string' || !MONTH.test(month)) return { ok: false, rule: null, code: 'bad_month' };
    if (typeof source !== 'string' || !(MANDATE_SOURCES as readonly string[]).includes(source)) return { ok: false, rule: null, code: 'bad_source' };
    if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents < 0) return { ok: false, rule: null, code: 'bad_amount' };
    // Un coût sans preuve n'est pas un chiffre de la base : refusé [R144].
    if (typeof proofRef !== 'string' || proofRef.length < 3 || proofRef.length > 300 || !(await this.proofs.has(proofRef))) return { ok: false, rule: 'R144', code: 'no_proof' };
    const last = await this.db.first<{ v: number | null }>('SELECT max(version) AS v FROM mandate_source_costs WHERE network_id = ? AND month = ? AND source = ?', [viewer.networkId, month, source]);
    const version = Number(last?.v ?? 0) + 1;
    const { changes } = await this.db.run(
      `INSERT INTO mandate_source_costs (id, network_id, month, source, version, amount_cents, proof_ref, entered_by, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [this.newId(), viewer.networkId, month, source, version, amountCents, proofRef, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'conflict' };
    await appendEvent(this.journal, { type: 'mesure_sources.cout', actor: this.actor(viewer), subject: null, data: { rule: 'R144', month, source, version, amountCents } }, this.now);
    return { ok: true, value: { version } };
  }

  /** La source d'une fiche, par le canal de sa première source connue ; sinon « inconnue ». */
  private async ficheSource(personId: string): Promise<MeasuredSource> {
    const members = await this.fiche.membersOf(await this.fiche.rootOf(personId));
    const first = await this.db.first<{ channel: string }>(`SELECT channel FROM sources WHERE person_id IN (${marks(members.length)}) ORDER BY occurred_at, created_at, id LIMIT 1`, members);
    return (first ? CHANNEL_SOURCES[first.channel]?.kind : undefined) ?? UNKNOWN_SOURCE;
  }

  /**
   * Le compte rendu du mois pour la direction : par source, mandats, rendez-vous d'estimation tenus, coût et coût par
   * mandat ; la dernière décision de la direction. Aucune recommandation du code, aucune donnée personnelle [R144, R13].
   */
  async report(viewer: Viewer, month: unknown): Promise<SourceMeasureResult<SourceReport>> {
    const denied = await this.gate(viewer, 'source_report');
    if (denied) return denied;
    if (typeof month !== 'string' || !MONTH.test(month)) return { ok: false, rule: null, code: 'bad_month' };
    const [from, to] = this.bounds(month);
    const sources: MeasuredSource[] = [...MANDATE_SOURCES, UNKNOWN_SOURCE];
    const mandates = new Map<MeasuredSource, number>(sources.map((s) => [s, 0]));
    const appointments = new Map<MeasuredSource, number>(sources.map((s) => [s, 0]));
    const mrows = await this.db.all<{ signed_at: string; source_kind: MandateSource }>('SELECT signed_at, source_kind FROM mandates WHERE network_id = ? AND signed_at >= ? AND signed_at < ?', [viewer.networkId, from, to]);
    for (const r of mrows) if (this.local(r.signed_at) === month) mandates.set(r.source_kind, (mandates.get(r.source_kind) ?? 0) + 1);
    const arows = await this.db.all<{ person_id: string; start_at: string }>(
      "SELECT person_id, start_at FROM appointments WHERE network_id = ? AND kind = 'estimation' AND status = 'honored' AND start_at >= ? AND start_at < ? ORDER BY start_at, id",
      [viewer.networkId, from, to],
    );
    for (const r of arows) {
      if (this.local(r.start_at) !== month) continue;
      const s = await this.ficheSource(r.person_id);
      appointments.set(s, (appointments.get(s) ?? 0) + 1);
    }
    const costs = await this.db.all<{ source: string; amount_cents: number }>(
      `SELECT c.source, c.amount_cents FROM mandate_source_costs c WHERE c.network_id = ? AND c.month = ?
       AND c.version = (SELECT max(version) FROM mandate_source_costs d WHERE d.network_id = c.network_id AND d.month = c.month AND d.source = c.source)`,
      [viewer.networkId, month],
    );
    const cost = new Map(costs.map((c) => [c.source, Number(c.amount_cents)]));
    const decisions = await this.db.all<{ source: string; decision: SourceDecision; month: string; decided_at: string }>(
      'SELECT source, decision, month, decided_at FROM mandate_source_decisions WHERE network_id = ? ORDER BY decided_at, id',
      [viewer.networkId],
    );
    const lastDecision = new Map<string, SourceLine['decision']>();
    for (const d of decisions) lastDecision.set(d.source, { decision: d.decision, month: d.month, decidedAt: d.decided_at });
    const lines: SourceLine[] = sources.map((source) => {
      const m = mandates.get(source) ?? 0;
      const c = cost.get(source) ?? null;
      return {
        source,
        label: source === UNKNOWN_SOURCE ? 'Source inconnue' : MANDATE_SOURCE_LABELS[source],
        mandates: m,
        appointments: appointments.get(source) ?? 0,
        costCents: c,
        costPerMandateCents: c === null || m === 0 ? null : Math.round(c / m),
        decision: lastDecision.get(source) ?? null,
      };
    });
    const totals = { mandates: lines.reduce((a, l) => a + l.mandates, 0), appointments: lines.reduce((a, l) => a + l.appointments, 0), costCents: lines.reduce((a, l) => a + (l.costCents ?? 0), 0) };
    await appendEvent(this.journal, { type: 'mesure_sources.lue', actor: this.actor(viewer), subject: null, data: { rule: 'R16', month, mandates: totals.mandates } }, this.now);
    return { ok: true, value: { month, lines, totals } };
  }

  /** La direction décide de garder ou d'arrêter une source, avec sa raison ; la décision est rangée telle quelle [R144]. */
  async decide(viewer: Viewer, input: { month?: unknown; source?: unknown; decision?: unknown; reason?: unknown }): Promise<SourceMeasureResult<{ id: string }>> {
    const denied = await this.gate(viewer, 'source_decision');
    if (denied) return denied;
    const { month, source, decision, reason } = input;
    if (typeof month !== 'string' || !MONTH.test(month)) return { ok: false, rule: null, code: 'bad_month' };
    if (typeof source !== 'string' || !(MANDATE_SOURCES as readonly string[]).includes(source)) return { ok: false, rule: null, code: 'bad_source' };
    if (typeof decision !== 'string' || !(SOURCE_DECISIONS as readonly string[]).includes(decision)) return { ok: false, rule: null, code: 'bad_decision' };
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 200) return { ok: false, rule: null, code: 'bad_reason' };
    const id = this.newId();
    await this.db.run('INSERT INTO mandate_source_decisions (id, network_id, month, source, decision, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      month,
      source,
      decision,
      reason.trim(),
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'mesure_sources.decision', actor: this.actor(viewer), subject: null, data: { rule: 'R144', month, source, decision } }, this.now);
    return { ok: true, value: { id } };
  }
}
