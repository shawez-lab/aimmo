/**
 * La disponibilité du service, derrière une interface de supervision (IN09) [R223, R16].
 *
 * Pour un mois fini de Paris, la direction lit la part du temps où le site, l'API et l'application ont répondu ; la
 * cible du cahier est 99,9 % par mois. Aucune supervision n'est branchée aujourd'hui (H48) : le service dit alors
 * « non mesuré », jamais 100 %.
 *
 * Décidé, lecture prudente :
 * - le temps dont la supervision ne dit rien n'est ni répondu ni coupé. La part se calcule sur le temps connu : ce qui
 *   est observé, plus toute coupure rapportée, même hors de l'observé, car une coupure connue n'est jamais écartée. Un
 *   mois connu en partie le dit, et la cible n'y est jamais dite atteinte. Elle y est dite manquée dès que les coupures
 *   dépassent à elles seules le dixième de pour cent du mois entier ;
 * - une donnée incohérente rend tout le service « non mesuré » : écarter une seule coupure embellirait le chiffre ;
 * - la part s'arrondit vers le bas : une coupure, même d'une milliseconde, n'affiche jamais 100 % ;
 * - la supervision vaut pour tout le logiciel, pas pour un réseau ; aucun client, aucun agent n'y figure.
 */
import type { Viewer } from '../acces/droits.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { monthBounds } from './indicateurs-reseau.ts';
import { parisMonth } from './preuve.ts';

export const SUPERVISED_SERVICES = ['site', 'api', 'application'] as const;
export type SupervisedService = (typeof SUPERVISED_SERVICES)[number];
/** La cible, en pour mille : 99,9 %. */
export const AVAILABILITY_TARGET_PER_MILLE = 999;

/** `to` à `null` : la coupure n'est pas finie, elle court jusqu'à la fin du mois lu. */
export interface OutagePeriod {
  from: Date;
  to: Date | null;
}

export interface ObservedPeriod {
  from: Date;
  to: Date;
}

export interface SupervisionReport {
  /** Les périodes où la supervision regardait vraiment le service. */
  observed: readonly ObservedPeriod[];
  outages: readonly OutagePeriod[];
}

/** Ce qu'une supervision doit rendre. Une vraie supervision borne elle-même le temps de ses appels. */
export interface SupervisionProvider {
  report(service: SupervisedService, from: Date, to: Date): Promise<SupervisionReport>;
}

/** Fausse supervision, en mémoire : pour les tests. Peut simuler une panne. */
export class FakeSupervision implements SupervisionProvider {
  readonly reports = new Map<SupervisedService, SupervisionReport>();
  readonly asked: { service: SupervisedService; from: Date; to: Date }[] = [];
  failWith: Error | null = null;

  async report(service: SupervisedService, from: Date, to: Date): Promise<SupervisionReport> {
    this.asked.push({ service, from, to });
    if (this.failWith) throw this.failWith;
    return this.reports.get(service) ?? { observed: [], outages: [] };
  }
}

export type NotMeasuredReason = 'not_connected' | 'supervision_failed' | 'bad_data' | 'nothing_observed';

export type ServiceAvailability =
  | { service: SupervisedService; measured: false; reason: NotMeasuredReason }
  | {
      service: SupervisedService;
      measured: true;
      monthMs: number;
      observedMs: number;
      answeredMs: number;
      downMs: number;
      /** Le mois entier a-t-il été observé ? */
      complete: boolean;
      /** Part du temps observé où le service a répondu, arrondie vers le bas au millième. */
      percent: number;
      /** `null` : on ne peut pas le dire, le mois n'a pas été observé en entier. */
      targetMet: boolean | null;
    };

export interface MonthAvailability {
  month: string;
  connected: boolean;
  targetPercent: number;
  services: readonly ServiceAvailability[];
}

type Span = readonly [number, number];
type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_month' } | { ok: false; rule: 'R223'; code: 'month_not_finished' };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const isDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

/** Les périodes triées et réunies : deux coupures qui se chevauchent ne comptent pas deux fois. */
function merged(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) out[out.length - 1] = [last[0], Math.max(last[1], to)];
    else out.push([from, to]);
  }
  return out;
}

const total = (spans: readonly Span[]): number => spans.reduce((sum, [from, to]) => sum + (to - from), 0);

/** Ce que deux listes réunies ont en commun. */
function overlap(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const [af, at] of a) {
    for (const [bf, bt] of b) {
      const from = Math.max(af, bf);
      const to = Math.min(at, bt);
      if (from < to) out.push([from, to]);
    }
  }
  return out;
}

/** Le calcul d'un service sur un mois `[start, end[`. `null` : une donnée incohérente. */
export function computeAvailability(report: SupervisionReport, start: number, end: number): { observedMs: number; downMs: number } | null {
  if (!Array.isArray(report?.observed) || !Array.isArray(report?.outages)) return null;
  const observedSpans: Span[] = [];
  for (const p of report.observed as readonly ObservedPeriod[]) {
    if (!isDate(p?.from) || !isDate(p?.to) || p.from.getTime() >= p.to.getTime()) return null;
    observedSpans.push([p.from.getTime(), p.to.getTime()]);
  }
  const outageSpans: Span[] = [];
  for (const o of report.outages as readonly OutagePeriod[]) {
    if (!isDate(o?.from)) return null;
    if (o.to === null) outageSpans.push([o.from.getTime(), end]);
    else if (!isDate(o.to) || o.from.getTime() >= o.to.getTime()) return null;
    else outageSpans.push([o.from.getTime(), o.to.getTime()]);
  }
  const outages = outageSpans.filter(([from, to]) => from < to);
  const month: Span[] = [[start, end]];
  // Une coupure rapportée est du temps connu : hors de l'observé, elle compte quand même [R223].
  const observed = merged(overlap(merged([...observedSpans, ...outages]), month));
  const down = merged(overlap(merged(outages), month));
  return { observedMs: total(observed), downMs: total(down) };
}

export class DisponibiliteService {
  private readonly supervision: SupervisionProvider | null;
  private readonly now: () => Date;

  constructor(
    private readonly journal: JournalStore,
    options: { supervision?: SupervisionProvider | null; now?: () => Date } = {},
  ) {
    this.supervision = options.supervision ?? null;
    this.now = options.now ?? (() => new Date());
  }

  private async one(service: SupervisedService, start: Date, end: Date): Promise<ServiceAvailability> {
    if (!this.supervision) return { service, measured: false, reason: 'not_connected' };
    let report: SupervisionReport;
    try {
      report = await this.supervision.report(service, start, end);
    } catch {
      // Le message d'une panne peut porter une adresse ou une clé : il n'est ni rendu ni écrit au journal.
      return { service, measured: false, reason: 'supervision_failed' };
    }
    const monthMs = end.getTime() - start.getTime();
    const computed = computeAvailability(report, start.getTime(), end.getTime());
    if (!computed) return { service, measured: false, reason: 'bad_data' };
    const { observedMs, downMs } = computed;
    if (observedMs === 0) return { service, measured: false, reason: 'nothing_observed' };
    const answeredMs = observedMs - downMs;
    const complete = observedMs === monthMs;
    const missed = downMs * 1000 > monthMs * (1000 - AVAILABILITY_TARGET_PER_MILLE);
    return {
      service,
      measured: true,
      monthMs,
      observedMs,
      answeredMs,
      downMs,
      complete,
      percent: Math.floor((answeredMs * 100_000) / observedMs) / 1000,
      targetMet: missed ? false : complete ? true : null,
    };
  }

  /** La direction seule, pour un mois fini [R16, R223]. */
  async ofMonth(viewer: Viewer, month: unknown): Promise<{ ok: true; value: MonthAvailability } | Refusal | Problem> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const subject = `network:${viewer.networkId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'availability', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof month !== 'string' || !MONTH.test(month)) return { ok: false, rule: null, code: 'bad_month' };
    if (month >= parisMonth(this.now())) return { ok: false, rule: 'R223', code: 'month_not_finished' };
    const [start, end] = monthBounds(month);
    const services = await Promise.all(SUPERVISED_SERVICES.map((s) => this.one(s, new Date(start), new Date(end))));
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor, subject, data: { kind: 'availability', month } }, this.now);
    return { ok: true, value: { month, connected: this.supervision !== null, targetPercent: AVAILABILITY_TARGET_PER_MILLE / 10, services } };
  }
}
