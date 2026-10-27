/**
 * Le plan du jour de l'agent (M20, G01) : ses meilleures occasions de rentrer un mandat, par des moyens autorisés.
 *
 * Trois raisons de figurer au plan : un propriétaire a demandé à être rappelé (tâche « rappeler » ouverte, Q04), un
 * avis de valeur envoyé reste sans suite (E06), un projet de vente ou d'estimation n'a pas encore de rendez-vous.
 * L'ordre suit des règles écrites ici, les mêmes pour tous, chaque ligne avec sa raison ; aucune IA, aucune note sur
 * les personnes [R35]. Le plan ne porte que les clients de l'agent [R16], et seulement des personnes qui ont une base
 * légale, une demande récente ou un accord en cours ; jamais une personne exclue ou qui a demandé l'arrêt [R36].
 * Les personnes écartées sont comptées, sans donnée personnelle. Rien n'est envoyé ici.
 */
import type { Acces } from '../acces/acces.ts';
import type { RefusalCode, Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { DEADLINES, type Deadline } from '../qualification/regles.ts';
import { INBOUND_CHANNELS } from '../reception/entrant.ts';

export interface PlanSettings {
  /** Jours pendant lesquels une demande de la personne vaut base légale. Réglage de départ : 13 mois. */
  requestDays: number;
  /** Jours sans échange après l'envoi d'un avis de valeur avant de le relancer au plan. Réglage de départ : 30 jours. */
  valuationFollowUpDays: number;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = Object.freeze({ requestDays: 395, valuationFollowUpDays: 30 });

/** Finalités d'accord qui permettent à l'agent de recontacter un propriétaire. */
export const PLAN_CONSENT_PURPOSES: readonly string[] = Object.freeze(['valuation_follow_up', 'value_tracking', 'prospecting']);

/** Étapes d'un projet avant tout mandat, où un rendez-vous reste à proposer. */
/**
 * Sources qui sont une demande de la personne : elle a écrit ou rempli un formulaire. Une reprise d'outil
 * (GoHighLevel, ManyChat) ou une saisie de l'agent n'en est pas une [R36].
 */
export const REQUEST_SOURCE_CHANNELS: readonly string[] = Object.freeze([...INBOUND_CHANNELS]);

export const OPEN_STAGES: readonly string[] = Object.freeze(['new', 'recue', 'appele']);

export type PlanItemKind = 'callback' | 'appointment' | 'valuation';

/** La base légale d'une ligne : une demande de la personne, ou un accord en cours. */
export interface LegalBasis {
  kind: 'request' | 'consent';
  /** Date de la demande la plus récente, ou de l'accord. */
  since: string;
  /** Finalité de l'accord, pour une base `consent`. */
  purpose: string | null;
}

export interface PlanItem {
  rank: number;
  personId: string;
  firstName: string | null;
  kind: PlanItemKind;
  /** La raison de la ligne, en une ligne, sans IA. */
  reason: string;
  /** Pourquoi cette place : les règles écrites appliquées, dans l'ordre. */
  order: string;
  basis: LegalBasis;
  projectId: string | null;
  taskId: string | null;
  reportId: string | null;
}

export interface DailyPlan {
  agentId: string;
  /** Jour du plan, `AAAA-MM-JJ`, heure de Paris. */
  day: string;
  computedAt: string;
  items: PlanItem[];
  /** Personnes qui avaient une raison d'y être mais n'y sont pas, comptées sans donnée personnelle [R36]. */
  removed: { excluded: number; withdrawn: number; noBasis: number };
}

export type PlanResult = { ok: true; value: DailyPlan } | { ok: false; rule: 'R16'; code: RefusalCode | 'not_agent' };

export interface PlanOptions {
  now?: () => Date;
  settings?: PlanSettings;
  timeZone?: string;
}

const DAY = 86_400_000;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Le délai annoncé, en jours à partir de la qualification ; « plus tard » vient après tous les délais chiffrés. */
const DEADLINE_DAYS: Readonly<Record<Deadline, number>> = Object.freeze({
  now: 0,
  within_3_months: 90,
  within_6_months: 180,
  within_1_year: 365,
  later: 730,
});
const DEADLINE_LABEL: Readonly<Record<Deadline, string>> = Object.freeze({
  now: 'tout de suite',
  within_3_months: 'sous 3 mois',
  within_6_months: 'sous 6 mois',
  within_1_year: 'sous un an',
  later: 'plus tard',
});
const KIND_STRENGTH: Readonly<Record<PlanItemKind, number>> = Object.freeze({ callback: 0, appointment: 1, valuation: 2 });

const day = (iso: string): string => iso.slice(0, 10);

interface Candidate {
  personId: string;
  firstName: string | null;
  kind: PlanItemKind;
  reason: string;
  basis: LegalBasis;
  projectId: string | null;
  taskId: string | null;
  reportId: string | null;
  /** Échéance annoncée par le propriétaire, ISO ; null si inconnue. */
  horizon: string | null;
  horizonLabel: string | null;
  /** Envoi de l'avis de valeur le plus ancien encore sans suite. */
  valuationSentAt: string | null;
  /** Demande la plus ancienne qui justifie la ligne. */
  requestedAt: string;
}

/**
 * L'ordre écrit du plan [R35] : 1. demande de rappel d'abord ; 2. délai annoncé par le propriétaire le plus proche ;
 * 3. avis de valeur le plus ancien ; 4. demande la plus ancienne ; 5. identifiant de la fiche, pour que le même jeu
 * de données donne toujours le même plan.
 */
function comparePlanCandidates(a: Candidate, b: Candidate): number {
  const callback = Number(b.kind === 'callback') - Number(a.kind === 'callback');
  if (callback !== 0) return callback;
  const byDate = (x: string | null, y: string | null): number => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1);
  return (
    byDate(a.horizon, b.horizon) ||
    byDate(a.valuationSentAt, b.valuationSentAt) ||
    byDate(a.requestedAt, b.requestedAt) ||
    (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0)
  );
}

function explain(c: Candidate): string {
  const parts = [c.kind === 'callback' ? '1. rappel demandé' : '1. pas de rappel demandé'];
  parts.push(c.horizonLabel ? `2. délai annoncé : ${c.horizonLabel}` : '2. délai non annoncé');
  parts.push(c.valuationSentAt ? `3. avis de valeur envoyé le ${day(c.valuationSentAt)}` : '3. pas d’avis de valeur envoyé');
  parts.push(`4. demande du ${day(c.requestedAt)}`);
  return parts.join(' ; ');
}

export class PlanDuJour {
  private readonly now: () => Date;
  private readonly settings: PlanSettings;
  private readonly timeZone: string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly fiche: FicheUnique,
    options: PlanOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.settings = options.settings ?? DEFAULT_PLAN_SETTINGS;
    this.timeZone = options.timeZone ?? 'Europe/Paris';
  }

  /** Le plan du jour d'un agent, calculé maintenant, sur ses seuls clients [R16]. */
  async compute(acces: Acces, viewer: Viewer, via?: string): Promise<PlanResult> {
    if (viewer.role !== 'agent') return { ok: false, rule: 'R16', code: 'not_agent' };
    const visible = await acces.listPersons(viewer, via);
    if (!visible.ok) return visible;
    const at = this.now();
    const stamp = at.toISOString();
    const removed = { excluded: 0, withdrawn: 0, noBasis: 0 };
    const items: Candidate[] = [];
    const seen = new Set<string>();
    for (const listed of visible.value) {
      const view = await this.fiche.view(listed.id);
      const root = view.person.id;
      if (seen.has(root)) continue;
      seen.add(root);
      const ids = view.members.map((m) => m.id);
      const candidates = await this.candidatesOf(root, ids, at);
      if (candidates.length === 0) continue;
      const eligibility = await this.eligibility(ids, at);
      if (!eligibility.ok) {
        removed[eligibility.reason] += 1;
        continue;
      }
      const basis = eligibility.basis;
      // Une ligne par personne, sous sa raison la plus forte.
      candidates.sort((a, b) => KIND_STRENGTH[a.kind] - KIND_STRENGTH[b.kind] || comparePlanCandidates(a, b));
      const best = candidates[0] as Candidate;
      const firstName = view.members.map((m) => m.first_name).find((n) => n) ?? null;
      items.push({ ...best, firstName, basis });
    }
    items.sort(comparePlanCandidates);
    return {
      ok: true,
      value: {
        agentId: viewer.userId,
        day: localDay(at, this.timeZone),
        computedAt: stamp,
        removed,
        items: items.map((c, i) => ({
          rank: i + 1,
          personId: c.personId,
          firstName: c.firstName,
          kind: c.kind,
          reason: c.reason,
          order: explain(c),
          basis: c.basis,
          projectId: c.projectId,
          taskId: c.taskId,
          reportId: c.reportId,
        })),
      },
    };
  }

  /**
   * Peut-elle figurer au plan maintenant ? Une personne exclue ou qui a demandé l'arrêt, sur n'importe quel canal,
   * jamais [R36] ; un accord de recontact retiré l'emporte sur toute demande, la personne a dit non [R03, R36] ;
   * sinon il faut une base légale. Sert au calcul et à chaque lecture d'un plan figé.
   */
  async eligibility(ids: readonly string[], at: Date): Promise<{ ok: true; basis: LegalBasis } | { ok: false; reason: 'excluded' | 'withdrawn' | 'noBasis' }> {
    const stamp = at.toISOString();
    if (await this.excluded(ids, stamp)) return { ok: false, reason: 'excluded' };
    if (await this.withdrawn(ids, stamp)) return { ok: false, reason: 'withdrawn' };
    const basis = await this.basisOf(ids, at);
    return basis === null ? { ok: false, reason: 'noBasis' } : { ok: true, basis };
  }

  /** Les raisons d'une personne de figurer au plan, avant la base légale et les exclusions. */
  private async candidatesOf(root: string, ids: readonly string[], at: Date): Promise<Candidate[]> {
    const inIds = placeholders(ids.length);
    const stamp = at.toISOString();
    const deadline = await this.deadlineOf(ids);
    const base = { personId: root, firstName: null, basis: { kind: 'request' as const, since: stamp, purpose: null }, ...deadline };
    const out: Candidate[] = [];

    // 1. Rappel demandé : la tâche « rappeler » encore ouverte.
    const tasks = await this.db.all<{ id: string; project_id: string | null; reason: string; created_at: string }>(
      `SELECT id, project_id, reason, created_at FROM callback_tasks WHERE person_id IN (${inIds}) AND done_at IS NULL ORDER BY created_at, id`,
      [...ids],
    );
    for (const t of tasks) {
      out.push({ ...base, kind: 'callback', reason: `Rappel demandé. ${t.reason}`, projectId: t.project_id, taskId: t.id, reportId: null, valuationSentAt: null, requestedAt: t.created_at });
    }

    // 2. Avis de valeur envoyé, sans échange ni rendez-vous depuis le délai réglé.
    const cutoff = new Date(at.getTime() - this.settings.valuationFollowUpDays * DAY).toISOString();
    const deliveries = await this.db.all<{ report_id: string; sent_at: string }>(
      `SELECT report_id, sent_at FROM valuation_deliveries WHERE person_id IN (${inIds}) AND sent_at <= ? ORDER BY sent_at, report_id`,
      [...ids, cutoff],
    );
    for (const d of deliveries) {
      // Un échange dans le délai, ou un rendez-vous pris depuis l'avis : l'avis a eu sa suite.
      const touched = await this.db.first<{ n: number }>(
        `SELECT (SELECT count(*) FROM messages WHERE person_id IN (${inIds}) AND occurred_at > ? AND (direction = 'in' OR author_kind = 'agent'))
              + (SELECT count(*) FROM appointments WHERE person_id IN (${inIds}) AND (created_at > ? OR (status = 'booked' AND start_at >= ?))) AS n`,
        [...ids, cutoff, ...ids, d.sent_at, stamp],
      );
      if (Number(touched?.n ?? 0) > 0) continue;
      out.push({
        ...base,
        kind: 'valuation',
        reason: `Avis de valeur envoyé le ${day(d.sent_at)}, sans réponse depuis ${this.settings.valuationFollowUpDays} jours : à relancer.`,
        projectId: null,
        taskId: null,
        reportId: d.report_id,
        valuationSentAt: d.sent_at,
        requestedAt: d.sent_at,
      });
    }

    // 3. Projet de vente ou d'estimation avant mandat, sans rendez-vous à venir ni estimation déjà faite.
    const projects = await this.db.all<{ id: string; kind: string; created_at: string }>(
      `SELECT id, kind, created_at FROM projects WHERE person_id IN (${inIds}) AND kind IN ('sell', 'valuation')
       AND stage IN (${placeholders(OPEN_STAGES.length)}) ORDER BY created_at, id`,
      [...ids, ...OPEN_STAGES],
    );
    if (projects.length > 0) {
      const booked = await this.db.first<{ n: number }>(
        `SELECT count(*) AS n FROM appointments WHERE person_id IN (${inIds})
         AND ((status = 'booked' AND start_at >= ?) OR (kind = 'estimation' AND status = 'honored'))`,
        [...ids, stamp],
      );
      if (Number(booked?.n ?? 0) === 0) {
        const p = projects[0] as { id: string; kind: string; created_at: string };
        out.push({
          ...base,
          kind: 'appointment',
          reason: p.kind === 'sell' ? 'Projet de vente sans rendez-vous : rendez-vous à proposer.' : 'Demande d’estimation sans rendez-vous : rendez-vous à proposer.',
          projectId: p.id,
          taskId: null,
          reportId: null,
          valuationSentAt: null,
          requestedAt: p.created_at,
        });
      }
    }
    // L'avis le plus ancien sert à l'ordre de toutes les lignes de la personne.
    const oldest = out.find((c) => c.kind === 'valuation')?.valuationSentAt ?? null;
    return out.map((c) => ({ ...c, valuationSentAt: c.valuationSentAt ?? oldest }));
  }

  /** Le délai annoncé le plus proche : échéance du projet, ou délai de la qualification compté depuis sa date. */
  private async deadlineOf(ids: readonly string[]): Promise<{ horizon: string | null; horizonLabel: string | null }> {
    const inIds = placeholders(ids.length);
    let horizon: string | null = null;
    let horizonLabel: string | null = null;
    const consider = (iso: string, label: string): void => {
      if (horizon === null || iso < horizon) {
        horizon = iso;
        horizonLabel = label;
      }
    };
    const projects = await this.db.all<{ deadline: string }>(
      `SELECT deadline FROM projects WHERE person_id IN (${inIds}) AND deadline IS NOT NULL AND kind IN ('sell', 'valuation')`,
      [...ids],
    );
    for (const p of projects) {
      const t = Date.parse(p.deadline);
      if (Number.isFinite(t)) consider(new Date(t).toISOString(), `échéance le ${day(new Date(t).toISOString())}`);
    }
    const quals = await this.db.all<{ deadline: string; created_at: string }>(
      `SELECT deadline, created_at FROM qualifications WHERE person_id IN (${inIds}) AND deadline IS NOT NULL`,
      [...ids],
    );
    for (const q of quals) {
      if (!(DEADLINES as readonly string[]).includes(q.deadline)) continue;
      const d = q.deadline as Deadline;
      consider(new Date(Date.parse(q.created_at) + DEADLINE_DAYS[d] * DAY).toISOString(), DEADLINE_LABEL[d]);
    }
    return { horizon, horizonLabel };
  }

  /**
   * La base légale [R36] : un accord en cours pour recontacter le propriétaire, sinon une demande de la personne
   * (message reçu, source, tâche de rappel) dans le délai réglé. Sans l'une ni l'autre : pas de plan.
   */
  private async basisOf(ids: readonly string[], at: Date): Promise<LegalBasis | null> {
    const inIds = placeholders(ids.length);
    const stamp = at.toISOString();
    const consent = await this.db.first<{ purpose: string; given_at: string }>(
      `SELECT purpose, given_at FROM consents WHERE person_id IN (${inIds}) AND purpose IN (${placeholders(PLAN_CONSENT_PURPOSES.length)})
       AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?) ORDER BY given_at DESC, id LIMIT 1`,
      [...ids, ...PLAN_CONSENT_PURPOSES, stamp, stamp],
    );
    if (consent) return { kind: 'consent', since: consent.given_at, purpose: consent.purpose };
    const from = new Date(at.getTime() - this.settings.requestDays * DAY).toISOString();
    const request = await this.db.first<{ at: string | null }>(
      `SELECT max(at) AS at FROM (
         SELECT occurred_at AS at FROM messages WHERE person_id IN (${inIds}) AND direction = 'in'
         UNION ALL SELECT occurred_at AS at FROM sources WHERE person_id IN (${inIds}) AND channel IN (${placeholders(REQUEST_SOURCE_CHANNELS.length)})
         UNION ALL SELECT created_at AS at FROM callback_tasks WHERE person_id IN (${inIds})
       ) WHERE at <= ?`,
      [...ids, ...ids, ...REQUEST_SOURCE_CHANNELS, ...ids, stamp],
    );
    if (request?.at && request.at >= from) return { kind: 'request', since: request.at, purpose: null };
    return null;
  }

  /** Un accord pour une finalité du plan, retiré, sans nouvel accord donné depuis pour la même finalité. */
  private async withdrawn(ids: readonly string[], at: string): Promise<boolean> {
    const inIds = placeholders(ids.length);
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM consents w WHERE w.person_id IN (${inIds}) AND w.purpose IN (${placeholders(PLAN_CONSENT_PURPOSES.length)})
       AND w.withdrawn_at IS NOT NULL AND w.withdrawn_at <= ?
       AND NOT EXISTS (SELECT 1 FROM consents c WHERE c.person_id IN (${inIds}) AND c.purpose = w.purpose
         AND c.given_at >= w.withdrawn_at AND c.given_at <= ? AND (c.withdrawn_at IS NULL OR c.withdrawn_at > ?))`,
      [...ids, ...PLAN_CONSENT_PURPOSES, at, ...ids, at, at],
    );
    return Number(row?.n ?? 0) > 0;
  }

  private async excluded(ids: readonly string[], at: string): Promise<boolean> {
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${placeholders(ids.length)}) AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?)`,
      [...ids, at, at],
    );
    return Number(row?.n ?? 0) > 0;
  }
}

/** Le jour `AAAA-MM-JJ` d'un instant, dans le fuseau donné. */
export function localDay(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
