/**
 * La condition de la phase 1, comptée (HX70 ; Feuille de route, « Les phases et leurs conditions », phase 1 :
 * « 30 jours sans aucun envoi hors règles, et plus aucune tâche du système planifiée dans les applications »)
 * [R643, R644, R645, R16].
 *
 * Ce que la base sait déjà : le contrôle central (S06) écrit chaque envoi et chaque refus dans `send_log`, avec le
 * message parti ; le site demande au socle avant chaque envoi de ses automatisations et signale ses écarts et ses pannes
 * (`bascule.retour_arriere`) ; le planificateur du socle écrit chaque passage (`planificateur.passage`). Ce qu'elle ne
 * sait pas : ce qu'une application (GoHighLevel, ManyChat…) envoie encore seule, et les tâches qui y restent
 * planifiées. La direction les range, avec la référence de leur preuve.
 *
 * Un jour de Paris est « hors règles » dès qu'un de ces cas y tombe [R643] :
 *   - un message automatique (de l'assistant ou du système) rangé comme parti sans aucune ligne « parti » du contrôle
 *     central : il est sorti sans passer par lui ;
 *   - une ligne « parti » du contrôle vers une personne qui avait, à cet instant, une exclusion en cours et déjà connue,
 *     sur sa fiche ou une fiche réunie à elle à cet instant : la base recompte elle-même, sans croire le contrôle ;
 *   - un écart non expliqué ou une panne signalés par le site sur une de ses automatisations : il a décidé seul ;
 *   - un envoi hors règles constaté hors d'AIMMO, rangé par la direction.
 * Les heures, les plafonds et les accords restent jugés par le contrôle lui-même (R01, R03, R11) : les recompter ici
 * doublerait ses règles et leurs exceptions. Un refus du contrôle n'est pas un envoi : il se voit, il ne salit rien.
 *
 * Jamais vu : la série ne peut pas être arrangée après coup. Chaque jour fini est figé dans un relevé, puis recompté à
 * chaque lecture ; le pire des deux l'emporte, un jour ne redevient jamais propre. Un jour sans relevé, ou sans aucun
 * passage du planificateur du socle, est « sans donnée » : jamais propre. Seuls comptent les jours qui suivent le jour
 * où la direction a rangé un inventaire à zéro, et toute version suivante non nulle remet le compte à rien.
 *
 * Passer à la phase suivante reste une décision de Shawez : rien ne bascule seul. La direction seule range et lit ; la
 * lecture est écrite au journal avant d'être rendue [R16]. Le relevé d'un jour est un geste du système, appelé par le
 * planificateur (branché par la voie 1).
 */
import type { Viewer } from '../acces/droits.ts';
import { AUTOMATION_NAMES } from '../bascule/automatisations.ts';
import { ROLLOUT_INCIDENT_JOURNAL_TYPE } from '../bascule/paliers.ts';
import { SCHEDULER_JOURNAL_TYPE } from '../bascule/planificateur.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { addDays, parisMidnight } from '../facturation/commun.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Le nombre de jours propres de suite qu'il faut [R645]. */
export const PHASE1_DAYS = 30;
/** Les jours relus à chaque lecture, en remontant depuis hier. */
export const PHASE1_WINDOW_DAYS = 120;
/** Le premier jour qu'on puisse relever ou déclarer. */
export const PHASE1_FIRST_DAY = '2026-01-01';
/** Le plus grand nombre de tâches déclarable pour une application. */
export const PHASE1_TASKS_MAX = 1000;

export const PHASE1_APPLICATIONS = ['gohighlevel', 'manychat', 'site', 'github_actions', 'autre'] as const;
export type Phase1Application = (typeof PHASE1_APPLICATIONS)[number];

export const PHASE1_OUTSIDE_FIELDS = ['day', 'application', 'proofRef'] as const;
export const PHASE1_INVENTORY_FIELDS = ['tasks', 'proofRef'] as const;

export const PHASE1_READING_JOURNAL_TYPE = 'condition_phase1.releve';

/** Une référence de stockage : lettres, chiffres et `/ _ . : -`, sans espace, sans `..`. */
const PROOF_REF = /^[A-Za-z0-9][A-Za-z0-9/_.:-]{2,199}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Europe/Paris';

export type Phase1Refusal = { ok: false; rule: 'R16'; code: 'role' } | { ok: false; rule: 'R643' | 'R644' | null; code: string };

/** Ce qui est compté pour un jour. Seuls les quatre derniers rendent le jour hors règles. */
export interface Phase1Counts {
  /** Lignes « parti » du contrôle central (essai compris). */
  sent: number;
  /** Refus du contrôle central : ils se voient, ils ne salissent rien. */
  refused: number;
  /** Messages automatiques partis sans aucune ligne « parti » du contrôle. */
  withoutControl: number;
  /** Lignes « parti » vers une personne exclue à cet instant, exclusion déjà connue. */
  whileExcluded: number;
  /** Écarts non expliqués signalés par le site. */
  siteGaps: number;
  /** Pannes du contrôle sur une automatisation du site : il a décidé seul. */
  siteFailures: number;
  /** Envois hors règles constatés hors d'AIMMO, rangés par la direction. */
  outside: number;
}

export interface Phase1Reading extends Phase1Counts {
  day: string;
  takenAt: string;
  plannerRuns: number;
}

export type Phase1DayStatus = 'propre' | 'hors_regles' | 'sans_donnee';

export interface Phase1Day {
  day: string;
  status: Phase1DayStatus;
  /** Le relevé figé, `null` s'il n'a pas été pris. */
  reading: Phase1Reading | null;
  /** Le recompte de cette lecture. */
  live: Phase1Counts;
  /** Le recompte trouve plus d'envois hors règles que le relevé : quelque chose est arrivé après coup. */
  recountWorse: boolean;
}

export interface Phase1Inventory {
  version: number;
  tasks: Record<Phase1Application, number>;
  total: number;
  proofRef: string;
  declaredAt: string;
}

export type Phase1ConditionReason = 'inventaire_absent' | 'taches_planifiees' | 'serie_trop_courte';

export interface Phase1Report {
  today: string;
  /** Le dernier jour fini : hier, à Paris. */
  lastDay: string;
  required: number;
  days: Phase1Day[];
  inventories: Phase1Inventory[];
  /** Le premier jour qui peut compter : le lendemain du jour où l'inventaire est passé à zéro ; `null` sinon. */
  countFrom: string | null;
  /** Les jours propres de suite jusqu'à hier, et ceux d'entre eux qui comptent (à partir de `countFrom`). */
  currentSeries: number;
  countedSeries: number;
  bestSeries: number;
  condition: { met: boolean; reasons: Phase1ConditionReason[] };
}

const ZERO: Phase1Counts = Object.freeze({ sent: 0, refused: 0, withoutControl: 0, whileExcluded: 0, siteGaps: 0, siteFailures: 0, outside: 0 });

/** Le nombre d'envois hors règles d'un compte [R643]. */
export const outOfRules = (c: Phase1Counts): number => c.withoutControl + c.whileExcluded + c.siteGaps + c.siteFailures + c.outside;

/** Le statut d'un jour : sans donnée sans relevé ni passage du planificateur ; hors règles si le relevé ou le recompte en voit un [R643]. */
export function phase1DayStatus(reading: Pick<Phase1Reading, 'plannerRuns' | keyof Phase1Counts> | null, live: Phase1Counts): Phase1DayStatus {
  if (reading === null || reading.plannerRuns <= 0) return 'sans_donnee';
  if (outOfRules(reading) > 0 || outOfRules(live) > 0) return 'hors_regles';
  return 'propre';
}

/** La condition de la phase 1 : inventaire à zéro et au moins 30 jours propres de suite comptés [R645]. */
export function phase1Condition(inventory: Phase1Inventory | null, countedSeries: number): { met: boolean; reasons: Phase1ConditionReason[] } {
  const reasons: Phase1ConditionReason[] = [];
  if (inventory === null) reasons.push('inventaire_absent');
  else if (inventory.total > 0) reasons.push('taches_planifiees');
  if (countedSeries < PHASE1_DAYS) reasons.push('serie_trop_courte');
  return { met: reasons.length === 0, reasons };
}

const parisDay = (iso: string): string => localTime(new Date(iso), TZ).date;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && new Date(`${v}T12:00:00.000Z`).toISOString().slice(0, 10) === v;
const isProof = (v: unknown): v is string => typeof v === 'string' && PROOF_REF.test(v) && !v.includes('..');

interface ReadingRow {
  day: string;
  taken_at: string;
  planner_runs: number;
  sent: number;
  refused: number;
  without_control: number;
  while_excluded: number;
  site_gaps: number;
  site_failures: number;
  outside: number;
}

interface InventoryRow {
  version: number;
  gohighlevel: number;
  manychat: number;
  site: number;
  github_actions: number;
  autre: number;
  proof_ref: string;
  declared_at: string;
}

const toReading = (r: ReadingRow): Phase1Reading => ({
  day: r.day,
  takenAt: r.taken_at,
  plannerRuns: Number(r.planner_runs),
  sent: Number(r.sent),
  refused: Number(r.refused),
  withoutControl: Number(r.without_control),
  whileExcluded: Number(r.while_excluded),
  siteGaps: Number(r.site_gaps),
  siteFailures: Number(r.site_failures),
  outside: Number(r.outside),
});

const toInventory = (r: InventoryRow): Phase1Inventory => {
  const tasks = Object.fromEntries(PHASE1_APPLICATIONS.map((a) => [a, Number(r[a])])) as Record<Phase1Application, number>;
  return { version: Number(r.version), tasks, total: PHASE1_APPLICATIONS.reduce((s, a) => s + tasks[a], 0), proofRef: r.proof_ref, declaredAt: r.declared_at };
};

interface Options {
  now?: () => Date;
  newId?: () => string;
}

export class ConditionPhase1 {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: Options = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return localTime(this.now(), TZ).date;
  }

  /** La direction seule ; tout autre rôle est refusé et le refus écrit au journal [R16]. */
  private async direction(viewer: Viewer, kind: string): Promise<Phase1Refusal | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }

  private async refuse(viewer: Viewer, refusal: Phase1Refusal): Promise<Phase1Refusal> {
    await appendEvent(this.journal, { type: 'condition_phase1.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: refusal.rule, code: refusal.code } }, this.now);
    return refusal;
  }

  private static shape(input: unknown, fields: readonly string[]): Record<string, unknown> | 'bad_shape' | 'unknown_field' {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'bad_shape';
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !fields.includes(k))) return 'unknown_field';
    return raw;
  }

  /** Range un envoi hors règles constaté hors d'AIMMO, un jour déjà commencé, avec sa preuve. Jamais retiré [R644]. */
  async declareOutsideSend(viewer: Viewer, input: unknown): Promise<{ ok: true; value: { id: string; day: string } } | Phase1Refusal> {
    const denied = await this.direction(viewer, 'phase1_outside_send');
    if (denied) return denied;
    const raw = ConditionPhase1.shape(input, PHASE1_OUTSIDE_FIELDS);
    if (typeof raw === 'string') return this.refuse(viewer, { ok: false, rule: null, code: raw });
    if (!isDay(raw.day) || raw.day < PHASE1_FIRST_DAY || raw.day > this.today()) return this.refuse(viewer, { ok: false, rule: 'R644', code: 'bad_day' });
    if (typeof raw.application !== 'string' || !(PHASE1_APPLICATIONS as readonly string[]).includes(raw.application)) return this.refuse(viewer, { ok: false, rule: 'R644', code: 'bad_application' });
    if (!isProof(raw.proofRef)) return this.refuse(viewer, { ok: false, rule: 'R644', code: 'bad_proof' });
    const id = this.newId();
    await this.db.run('INSERT INTO phase1_outside_sends (id, network_id, day, application, proof_ref, declared_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      raw.day,
      raw.application,
      raw.proofRef,
      this.now().toISOString(),
    ]);
    // La preuve reste dans la table : le journal ne dit que le jour et l'application.
    await appendEvent(this.journal, { type: 'condition_phase1.envoi_hors_aimmo', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { day: raw.day, application: raw.application } }, this.now);
    return { ok: true, value: { id, day: raw.day } };
  }

  /** Range les tâches du système encore planifiées dans chaque application, avec la preuve ; une version s'ajoute [R644]. */
  async declareInventory(viewer: Viewer, input: unknown): Promise<{ ok: true; value: { version: number; total: number } } | Phase1Refusal> {
    const denied = await this.direction(viewer, 'phase1_inventory');
    if (denied) return denied;
    const raw = ConditionPhase1.shape(input, PHASE1_INVENTORY_FIELDS);
    if (typeof raw === 'string') return this.refuse(viewer, { ok: false, rule: null, code: raw });
    const tasks = raw.tasks;
    if (tasks === null || typeof tasks !== 'object' || Array.isArray(tasks)) return this.refuse(viewer, { ok: false, rule: 'R644', code: 'bad_tasks' });
    const t = tasks as Record<string, unknown>;
    const keys = Object.keys(t);
    // Chaque application est dite, même à zéro : une application oubliée n'est jamais comptée vide.
    if (keys.length !== PHASE1_APPLICATIONS.length || !PHASE1_APPLICATIONS.every((a) => Number.isSafeInteger(t[a]) && (t[a] as number) >= 0 && (t[a] as number) <= PHASE1_TASKS_MAX)) {
      return this.refuse(viewer, { ok: false, rule: 'R644', code: 'bad_tasks' });
    }
    if (!isProof(raw.proofRef)) return this.refuse(viewer, { ok: false, rule: 'R644', code: 'bad_proof' });
    const last = await this.db.first<{ version: number | null }>('SELECT MAX(version) AS version FROM phase1_app_inventories WHERE network_id = ?', [viewer.networkId]);
    const version = Number(last?.version ?? 0) + 1;
    try {
      await this.db.run(
        'INSERT INTO phase1_app_inventories (network_id, version, gohighlevel, manychat, site, github_actions, autre, proof_ref, declared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [viewer.networkId, version, ...PHASE1_APPLICATIONS.map((a) => t[a] as number), raw.proofRef, this.now().toISOString()],
      );
    } catch {
      // Une autre version est passée entre la lecture et l'écriture : rien n'est rangé.
      return this.refuse(viewer, { ok: false, rule: 'R644', code: 'conflit' });
    }
    const total = PHASE1_APPLICATIONS.reduce((s, a) => s + (t[a] as number), 0);
    await appendEvent(this.journal, { type: 'condition_phase1.inventaire', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { version, total } }, this.now);
    return { ok: true, value: { version, total } };
  }

  /**
   * Fige le relevé d'un jour de Paris fini, une seule fois. Geste du système, appelé par le planificateur ; un second
   * appel rend le relevé déjà pris, sans rien changer [R643, R17].
   */
  async takeReading(networkId: string, day: string): Promise<{ ok: true; value: Phase1Reading; already: boolean } | { ok: false; rule: 'R643'; code: string }> {
    if (!isDay(day) || day < PHASE1_FIRST_DAY) return { ok: false, rule: 'R643', code: 'bad_day' };
    if (day >= this.today()) return { ok: false, rule: 'R643', code: 'jour_pas_fini' };
    const existing = await this.reading(networkId, day);
    if (existing) return { ok: true, value: existing, already: true };
    const counts = (await this.count(networkId, day, day)).get(day) ?? { ...ZERO };
    const plannerRuns = await this.plannerRuns(day);
    const takenAt = this.now().toISOString();
    try {
      await this.db.run(
        `INSERT INTO phase1_day_readings (network_id, day, taken_at, planner_runs, sent, refused, without_control, while_excluded, site_gaps, site_failures, outside)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [networkId, day, takenAt, plannerRuns, counts.sent, counts.refused, counts.withoutControl, counts.whileExcluded, counts.siteGaps, counts.siteFailures, counts.outside],
      );
    } catch {
      // Deux passages au même moment : le premier relevé reste, le second le rend.
      const first = await this.reading(networkId, day);
      if (first) return { ok: true, value: first, already: true };
      throw new Error('Relevé du jour non écrit.');
    }
    await appendEvent(
      this.journal,
      { type: PHASE1_READING_JOURNAL_TYPE, actor: 'system:condition_phase1', subject: `network:${networkId}`, data: { day, plannerRuns, outOfRules: outOfRules(counts), sent: counts.sent, refused: counts.refused } },
      this.now,
    );
    return { ok: true, value: { day, takenAt, plannerRuns, ...counts }, already: false };
  }

  private async reading(networkId: string, day: string): Promise<Phase1Reading | null> {
    const row = await this.db.first<ReadingRow>('SELECT * FROM phase1_day_readings WHERE network_id = ? AND day = ?', [networkId, day]);
    return row ? toReading(row) : null;
  }

  /** Les passages du planificateur du socle dans un jour de Paris, quelle que soit leur issue : le socle a regardé. */
  private async plannerRuns(day: string): Promise<number> {
    const row = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM journal WHERE type = ? AND at >= ? AND at < ?', [
      SCHEDULER_JOURNAL_TYPE,
      parisMidnight(day).toISOString(),
      parisMidnight(addDays(day, 1)).toISOString(),
    ]);
    return Number(row?.n ?? 0);
  }

  /** Le compte, jour de Paris par jour, de `from` à `to` compris, lu dans la base sans croire le contrôle [R643]. */
  async count(networkId: string, from: string, to: string): Promise<Map<string, Phase1Counts>> {
    const start = parisMidnight(from).toISOString();
    const end = parisMidnight(addDays(to, 1)).toISOString();
    const days = new Map<string, Phase1Counts>();
    const slot = (iso: string): Phase1Counts => {
      const d = parisDay(iso);
      let c = days.get(d);
      if (!c) days.set(d, (c = { ...ZERO }));
      return c;
    };

    const log = await this.db.all<{ person_id: string; outcome: string; occurred_at: string }>(
      "SELECT person_id, outcome, occurred_at FROM send_log WHERE network_id = ? AND outcome IN ('sent', 'refused') AND occurred_at >= ? AND occurred_at < ?",
      [networkId, start, end],
    );
    for (const l of log) {
      if (l.outcome === 'sent') slot(l.occurred_at).sent += 1;
      else slot(l.occurred_at).refused += 1;
    }

    // Un message automatique rangé comme parti sans aucune ligne « parti » du contrôle : il est sorti sans lui.
    const bypass = await this.db.all<{ occurred_at: string }>(
      `SELECT m.occurred_at FROM messages m
        WHERE m.network_id = ? AND m.direction = 'out' AND m.author_kind IN ('ai', 'system') AND m.occurred_at >= ? AND m.occurred_at < ?
          AND NOT EXISTS (SELECT 1 FROM send_log l WHERE l.message_id = m.id AND l.outcome = 'sent')`,
      [networkId, start, end],
    );
    for (const m of bypass) slot(m.occurred_at).withoutControl += 1;

    // Une ligne « parti » vers une personne exclue à cet instant, sur sa fiche ou une fiche réunie à elle à cet instant.
    const sent = log.filter((l) => l.outcome === 'sent');
    if (sent.length > 0) {
      const exclusions = await this.db.all<{ person_id: string; noted_at: string; lifted_at: string | null; created_at: string }>(
        'SELECT person_id, noted_at, lifted_at, created_at FROM exclusions WHERE network_id = ? AND noted_at < ? AND created_at < ?',
        [networkId, end, end],
      );
      if (exclusions.length > 0) {
        const merges = await this.db.all<{ survivor_id: string; merged_id: string; merged_at: string; undone_at: string | null }>(
          'SELECT survivor_id, merged_id, merged_at, undone_at FROM person_merges WHERE network_id = ? AND merged_at < ?',
          [networkId, end],
        );
        for (const l of sent) {
          const at = l.occurred_at;
          const group = new Set([l.person_id]);
          for (let grew = true; grew; ) {
            grew = false;
            for (const m of merges) {
              if (m.merged_at > at || (m.undone_at !== null && m.undone_at <= at)) continue;
              if (group.has(m.survivor_id) !== group.has(m.merged_id)) {
                group.add(m.survivor_id);
                group.add(m.merged_id);
                grew = true;
              }
            }
          }
          // L'exclusion était en cours et déjà rangée : le contrôle pouvait la voir [R02, R04].
          if (exclusions.some((e) => group.has(e.person_id) && e.noted_at <= at && e.created_at <= at && (e.lifted_at === null || e.lifted_at > at))) slot(at).whileExcluded += 1;
        }
      }
    }

    // Les écarts et pannes signalés sur les automatisations du site : il a décidé seul.
    const incidents = await this.db.all<{ at: string; data: string }>('SELECT at, data FROM journal WHERE type = ? AND subject = ? AND at >= ? AND at < ? ORDER BY seq', [
      ROLLOUT_INCIDENT_JOURNAL_TYPE,
      `network:${networkId}`,
      start,
      end,
    ]);
    for (const e of incidents) {
      let data: { automation?: unknown; kind?: unknown };
      try {
        data = JSON.parse(e.data) as typeof data;
      } catch {
        // Une ligne illisible ne passe jamais pour rien : elle compte comme un écart.
        slot(e.at).siteGaps += 1;
        continue;
      }
      if (!(AUTOMATION_NAMES as readonly unknown[]).includes(data.automation)) continue;
      if (data.kind === 'failure') slot(e.at).siteFailures += 1;
      else slot(e.at).siteGaps += 1;
    }

    const outside = await this.db.all<{ day: string; n: number }>('SELECT day, COUNT(*) AS n FROM phase1_outside_sends WHERE network_id = ? AND day >= ? AND day <= ? GROUP BY day', [
      networkId,
      from,
      to,
    ]);
    for (const o of outside) {
      let c = days.get(o.day);
      if (!c) days.set(o.day, (c = { ...ZERO }));
      c.outside += Number(o.n);
    }
    return days;
  }

  /** Les jours, l'inventaire et la condition de la phase 1, recomptés à chaque lecture [R643, R644, R645]. */
  async report(viewer: Viewer): Promise<{ ok: true; value: Phase1Report } | Phase1Refusal> {
    const denied = await this.direction(viewer, 'phase1_report');
    if (denied) return denied;
    const value = await this.compute(viewer.networkId);
    await appendEvent(
      this.journal,
      { type: 'condition_phase1.lecture', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', counted: value.countedSeries, met: value.condition.met } },
      this.now,
    );
    return { ok: true, value };
  }

  /** Le calcul, sans droits. */
  async compute(networkId: string): Promise<Phase1Report> {
    const today = this.today();
    const lastDay = addDays(today, -1);
    const windowStart = addDays(lastDay, -(PHASE1_WINDOW_DAYS - 1));
    const rows = await this.db.all<ReadingRow>('SELECT * FROM phase1_day_readings WHERE network_id = ? AND day >= ? AND day <= ? ORDER BY day', [networkId, windowStart, lastDay]);
    const readings = new Map(rows.map((r) => [r.day, toReading(r)]));
    const first = await this.db.first<{ day: string | null }>('SELECT MIN(day) AS day FROM phase1_day_readings WHERE network_id = ?', [networkId]);

    const days: Phase1Day[] = [];
    if (first?.day && first.day <= lastDay) {
      const from = first.day > windowStart ? first.day : windowStart;
      const live = await this.count(networkId, from, lastDay);
      for (let d = from; d <= lastDay; d = addDays(d, 1)) {
        const reading = readings.get(d) ?? null;
        const counts = live.get(d) ?? { ...ZERO };
        days.push({ day: d, status: phase1DayStatus(reading, counts), reading, live: counts, recountWorse: reading !== null && outOfRules(counts) > outOfRules(reading) });
      }
    }

    const inventories = (await this.db.all<InventoryRow>('SELECT * FROM phase1_app_inventories WHERE network_id = ? ORDER BY version', [networkId])).map(toInventory);
    const current = inventories.length > 0 ? inventories[inventories.length - 1]! : null;
    // Le premier jour qui compte : le lendemain du jour de Paris de la première version d'une suite de versions à zéro
    // qui va jusqu'à la dernière. Une version non nulle ensuite remet le compte à rien [R645].
    let countFrom: string | null = null;
    if (current !== null && current.total === 0) {
      let i = inventories.length - 1;
      while (i > 0 && inventories[i - 1]!.total === 0) i -= 1;
      countFrom = addDays(parisDay(inventories[i]!.declaredAt), 1);
    }

    let currentSeries = 0;
    let countedSeries = 0;
    for (let i = days.length - 1; i >= 0 && days[i]!.status === 'propre'; i--) {
      currentSeries += 1;
      if (countFrom !== null && days[i]!.day >= countFrom) countedSeries += 1;
    }
    let bestSeries = 0;
    for (let i = 0, run = 0; i < days.length; i++) {
      run = days[i]!.status === 'propre' ? run + 1 : 0;
      if (run > bestSeries) bestSeries = run;
    }

    return {
      today,
      lastDay,
      required: PHASE1_DAYS,
      days,
      inventories,
      countFrom,
      currentSeries,
      countedSeries,
      bestSeries,
      condition: phase1Condition(current, countedSeries),
    };
  }
}
