/**
 * Le contrôle de la base légale sur 30 jours (M20, G05) : « aucun contact sans base légale dans le plan, sur 30 jours ».
 * Chaque passage relit les plans du jour figés des 30 derniers jours et vérifie, ligne par ligne, qu'au moment où le
 * plan a été figé la personne avait une base légale et n'était ni exclue, ni arrêtée, ni sans accord [R36]. Les
 * exclusions, accords et demandes sont datés : le contrôle les relit à la date du plan, avec les fiches réunies
 * gardées au moment du plan. Le rapport ne porte que des nombres [R13] ; un écart est une alerte pour la direction.
 */
import type { Viewer } from '../acces/droits.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { localDay, PlanDuJour, type PlanSettings } from './plan-du-jour.ts';

export const LEGAL_BASIS_JOB = 'mandats.controle_base_legale';
/** Chaque jour à 8 h, heure de Paris, après le plan de 7 h 30. */
export const LEGAL_BASIS_HOUR = 8;
export const LEGAL_BASIS_WINDOW_DAYS = 30;
const TIME_ZONE = 'Europe/Paris';
const ACTOR = 'system:planificateur';
const DAY = 86_400_000;

export interface LegalBasisReport {
  networkId: string;
  ranAt: string;
  fromDay: string;
  toDay: string;
  plans: number;
  items: number;
  gaps: number;
  byReason: { excluded: number; withdrawn: number; noBasis: number; unreadable: number };
  /** Jours où un écart a été trouvé, avec leur nombre. */
  byDay: Record<string, number>;
}

export interface LegalBasisOptions {
  now?: () => Date;
  newId?: () => string;
  settings?: PlanSettings;
}

interface StoredItem {
  personId?: unknown;
  memberIds?: unknown;
}

export class ControleBaseLegale {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly plan: PlanDuJour;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: LegalBasisOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    const store = new FicheClient(db, { now: this.now });
    const unique = new FicheUnique(db, store, { now: this.now });
    this.plan = new PlanDuJour(db, unique, { now: this.now, ...(options.settings ? { settings: options.settings } : {}) });
  }

  /** Contrôle chaque réseau qui a des plans dans la fenêtre ; rend un rapport par réseau, rangé. */
  async runAll(): Promise<LegalBasisReport[]> {
    const { fromDay, toDay } = this.window();
    const networks = await this.db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM daily_plans WHERE day >= ? AND day <= ? ORDER BY network_id', [fromDay, toDay]);
    const reports: LegalBasisReport[] = [];
    for (const { network_id } of networks) reports.push(await this.run(network_id));
    return reports;
  }

  /** Contrôle les plans figés d'un réseau sur les 30 derniers jours, aujourd'hui compris. */
  async run(networkId: string): Promise<LegalBasisReport> {
    const { fromDay, toDay } = this.window();
    const rows = await this.db.all<{ day: string; items: string; computed_at: string }>(
      'SELECT day, items, computed_at FROM daily_plans WHERE network_id = ? AND day >= ? AND day <= ? ORDER BY day, agent_id',
      [networkId, fromDay, toDay],
    );
    const report: LegalBasisReport = {
      networkId,
      ranAt: this.now().toISOString(),
      fromDay,
      toDay,
      plans: rows.length,
      items: 0,
      gaps: 0,
      byReason: { excluded: 0, withdrawn: 0, noBasis: 0, unreadable: 0 },
      byDay: {},
    };
    const gap = (day: string, reason: keyof LegalBasisReport['byReason']): void => {
      report.gaps += 1;
      report.byReason[reason] += 1;
      report.byDay[day] = (report.byDay[day] ?? 0) + 1;
    };
    for (const row of rows) {
      let items: unknown[];
      try {
        const parsed: unknown = JSON.parse(row.items);
        items = Array.isArray(parsed) ? (parsed as unknown[]) : [];
        if (!Array.isArray(parsed)) gap(row.day, 'unreadable');
      } catch {
        gap(row.day, 'unreadable');
        continue;
      }
      const at = new Date(row.computed_at);
      for (const raw of items) {
        report.items += 1;
        if (raw === null || typeof raw !== 'object') {
          gap(row.day, 'unreadable');
          continue;
        }
        const item = raw as StoredItem;
        // Les fiches réunies au moment du plan ; sans elles, la ligne ne peut pas être vérifiée : c'est un écart.
        const members = Array.isArray(item.memberIds) ? item.memberIds.filter((m): m is string => typeof m === 'string') : [];
        if (members.length === 0 || typeof item.personId !== 'string' || !members.includes(item.personId)) {
          gap(row.day, 'unreadable');
          continue;
        }
        const verdict = await this.plan.eligibility(members, at);
        if (!verdict.ok) gap(row.day, verdict.reason);
      }
    }
    await this.db.run(
      `INSERT INTO legal_basis_checks (id, network_id, ran_at, from_day, to_day, plans, items, gaps, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.newId(), networkId, report.ranAt, fromDay, toDay, report.plans, report.items, report.gaps, JSON.stringify({ byReason: report.byReason, byDay: report.byDay })],
    );
    await appendEvent(
      this.journal,
      {
        type: report.gaps > 0 ? 'plan_du_jour.controle.ecart' : 'plan_du_jour.controle',
        actor: ACTOR,
        subject: null,
        data: { rule: 'R36', network: networkId, fromDay, toDay, plans: report.plans, items: report.items, gaps: report.gaps },
      },
      this.now,
    );
    return report;
  }

  /**
   * Les alertes de la direction : les rapports avec un écart, non encore vus. Direction et conformité seulement [R16] ;
   * un refus est écrit au journal.
   */
  async alerts(viewer: Viewer): Promise<{ ok: true; value: LegalBasisReport[] } | { ok: false; rule: 'R16'; code: 'role' }> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction' && viewer.role !== 'compliance') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'legal_basis_check', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const rows = await this.db.all<{ network_id: string; ran_at: string; from_day: string; to_day: string; plans: number; items: number; gaps: number; report: string }>(
      'SELECT * FROM legal_basis_checks WHERE network_id = ? AND gaps > 0 AND seen_at IS NULL ORDER BY ran_at',
      [viewer.networkId],
    );
    await appendEvent(this.journal, { type: 'plan_du_jour.controle.lu', actor, subject: null, data: { rule: 'R16', alerts: rows.length } }, this.now);
    return {
      ok: true,
      value: rows.map((r) => {
        const detail = JSON.parse(r.report) as Pick<LegalBasisReport, 'byReason' | 'byDay'>;
        return { networkId: r.network_id, ranAt: r.ran_at, fromDay: r.from_day, toDay: r.to_day, plans: Number(r.plans), items: Number(r.items), gaps: Number(r.gaps), ...detail };
      }),
    };
  }

  private window(): { fromDay: string; toDay: string } {
    const at = this.now();
    return { fromDay: localDay(new Date(at.getTime() - (LEGAL_BASIS_WINDOW_DAYS - 1) * DAY), TIME_ZONE), toDay: localDay(at, TIME_ZONE) };
  }
}

/** La tâche du planificateur : le contrôle de la base légale, chaque jour à 8 h, heure de Paris. */
export function legalBasisJob(db: SqlDatabase, journal: JournalStore, options: LegalBasisOptions = {}): ScheduledJob {
  return {
    name: LEGAL_BASIS_JOB,
    hours: [LEGAL_BASIS_HOUR],
    run: async () => {
      await new ControleBaseLegale(db, journal, options).runAll();
    },
  };
}
