/**
 * Alertes de pilotage (M13, K07) [R13, R14, R16, R17, R18, R25].
 *
 * Chaque jour, pour la direction de chaque réseau :
 * - budget de l'IA : quand le coût de l'IA du mois (rangé avec chaque message écrit par l'IA) atteint la part réglée du
 *   budget mensuel (70 % par défaut) ; une alerte par mois ;
 * - baisse d'un indicateur du réseau (contacts, rendez-vous tenus, mandats signés, ventes) : quand la moyenne par jour
 *   des 7 derniers jours est inférieure de plus du seuil réglé (30 % par défaut) à celle des 28 jours précédents ; une
 *   alerte par indicateur et par semaine ;
 * - échéance d'un document d'agent (lue par une interface de M14) : dans le délai réglé avant sa fin de validité ; une
 *   alerte par document et par échéance.
 * Les seuils sont des réglages du réseau, versionnés, les mêmes pour tous [R25]. Une alerte porte des chiffres et des
 * échéances, jamais une note ni un jugement sur un agent [R14] ; au journal, sans montant ni nom [R13].
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { parisDayStart } from './tableau-agent.ts';

const TIME_ZONE = 'Europe/Paris';
export const PILOTAGE_ALERTS_JOB = 'pilotage.alertes';
export const DEFAULT_PILOTAGE_SETTINGS = { aiMonthlyBudgetCents: null as number | null, aiAlertBp: 7000, dropAlertBp: 3000, documentNoticeDays: 30 };
export type PilotageSettings = typeof DEFAULT_PILOTAGE_SETTINGS;
export const INDICATORS = ['contacts', 'appointments', 'mandates', 'sales'] as const;
export type Indicator = (typeof INDICATORS)[number];

/** Les documents d'agent et leur fin de validité (M14, dossier d'agent) : seulement ceux qui finissent avant `untilDay`. */
export interface EcheancesDocumentsAgent {
  dueBy(networkId: string, untilDay: string): Promise<readonly { agentId: string; document: string; validUntil: string }[]>;
}

export interface PilotageAlert {
  key: string;
  kind: 'budget_ia' | 'baisse_indicateur' | 'document_agent';
  data: Record<string, unknown>;
  createdAt: string;
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (day: string): number => {
  const w = new Date(`${day}T12:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
};
const validBp = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000;

/** La baisse d'un indicateur : vrai si la moyenne des 7 jours est sous celle des 28 précédents de plus du seuil. */
export function isDrop(last7: number, previous28: number, thresholdBp: number): boolean {
  if (previous28 <= 0) return false;
  // Comparaison en entiers : last7/7 < previous28/28 × (1 − seuil), soit 4 × last7 × 10 000 < previous28 × (10 000 − seuil).
  return 4 * last7 * 10_000 < previous28 * (10_000 - thresholdBp);
}

export class AlertesPilotage {
  private readonly now: () => Date;
  private readonly documents: EcheancesDocumentsAgent | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; documents?: EcheancesDocumentsAgent | null } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.documents = options.documents ?? null;
  }

  private async refusal(viewer: Viewer, kind: string): Promise<{ ok: false; rule: 'R16'; code: string } | null> {
    const d = viewer.role === 'direction' ? decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId }) : null;
    if (d?.allowed) return null;
    const code = d && !d.allowed ? d.code : 'role';
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  async settingsOf(networkId: string): Promise<PilotageSettings> {
    const r = await this.db.first<{ ai_monthly_budget_cents: number | null; ai_alert_bp: number; drop_alert_bp: number; document_notice_days: number }>(
      'SELECT ai_monthly_budget_cents, ai_alert_bp, drop_alert_bp, document_notice_days FROM pilotage_settings WHERE network_id = ? ORDER BY version DESC LIMIT 1',
      [networkId],
    );
    return r ? { aiMonthlyBudgetCents: r.ai_monthly_budget_cents, aiAlertBp: r.ai_alert_bp, dropAlertBp: r.drop_alert_bp, documentNoticeDays: r.document_notice_days } : { ...DEFAULT_PILOTAGE_SETTINGS };
  }

  /** Les réglages en vigueur, à lire : la direction seule [R16]. */
  async readSettings(viewer: Viewer): Promise<{ ok: true; value: PilotageSettings } | { ok: false; rule: 'R16' | null; code: string }> {
    const refusal = await this.refusal(viewer, 'pilotage_settings_read');
    if (refusal) return refusal;
    return { ok: true, value: await this.settingsOf(viewer.networkId) };
  }

  /** Les réglages : la direction seule ; une nouvelle version s'ajoute [R16, R17]. */
  async setSettings(viewer: Viewer, input: Partial<PilotageSettings>): Promise<{ ok: true; version: number } | { ok: false; rule: 'R16' | null; code: string }> {
    const refusal = await this.refusal(viewer, 'pilotage_settings');
    if (refusal) return refusal;
    const next = { ...(await this.settingsOf(viewer.networkId)), ...input };
    if (next.aiMonthlyBudgetCents !== null && !(Number.isInteger(next.aiMonthlyBudgetCents) && next.aiMonthlyBudgetCents > 0)) return { ok: false, rule: null, code: 'bad_budget' };
    if (!validBp(next.aiAlertBp) || !validBp(next.dropAlertBp)) return { ok: false, rule: null, code: 'bad_threshold' };
    if (!Number.isInteger(next.documentNoticeDays) || next.documentNoticeDays < 1 || next.documentNoticeDays > 365) return { ok: false, rule: null, code: 'bad_notice' };
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM pilotage_settings WHERE network_id = ?', [viewer.networkId]);
    const version = (last?.v ?? 0) + 1;
    await this.db.run(
      'INSERT INTO pilotage_settings (network_id, version, ai_monthly_budget_cents, ai_alert_bp, drop_alert_bp, document_notice_days, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [viewer.networkId, version, next.aiMonthlyBudgetCents, next.aiAlertBp, next.dropAlertBp, next.documentNoticeDays, `${String(viewer.role)}:${viewer.userId}`, this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'pilotage.reglages', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { version } }, this.now);
    return { ok: true, version };
  }

  private async raise(networkId: string, key: string, kind: PilotageAlert['kind'], data: Record<string, unknown>): Promise<boolean> {
    const { changes } = await this.db.run('INSERT INTO pilotage_alerts (network_id, key, kind, data, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      networkId,
      key,
      kind,
      JSON.stringify(data),
      this.now().toISOString(),
    ]);
    if (changes === 1) await appendEvent(this.journal, { type: 'pilotage.alerte', actor: 'system:pilotage', subject: `network:${networkId}`, data: { kind, key } }, this.now);
    return changes === 1;
  }

  private async countBetween(networkId: string, indicator: Indicator, fromDay: string, toDayExcl: string): Promise<number> {
    const start = parisDayStart(fromDay).toISOString();
    const end = parisDayStart(toDayExcl).toISOString();
    const q: Record<Indicator, [string, string[]]> = {
      contacts: ['SELECT COUNT(*) AS n FROM attributions WHERE network_id = ? AND created_at >= ? AND created_at < ?', [networkId, start, end]],
      appointments: ["SELECT COUNT(*) AS n FROM appointments WHERE network_id = ? AND status = 'honored' AND start_at >= ? AND start_at < ?", [networkId, start, end]],
      mandates: ['SELECT COUNT(*) AS n FROM mandates WHERE network_id = ? AND signed_at >= ? AND signed_at < ?', [networkId, start, end]],
      sales: ['SELECT COUNT(*) AS n FROM sale_commissions WHERE network_id = ? AND due_on >= ? AND due_on < ?', [networkId, fromDay, toDayExcl]],
    };
    const [sql, params] = q[indicator];
    return (await this.db.first<{ n: number }>(sql, params))?.n ?? 0;
  }

  /** Le passage d'un réseau : rend le nombre d'alertes nouvelles. Rejoué, il n'ajoute rien [R18]. */
  async run(networkId: string): Promise<number> {
    const s = await this.settingsOf(networkId);
    const today = localTime(this.now(), TIME_ZONE).date;
    let made = 0;
    // Budget de l'IA, sur le mois de Paris en cours.
    if (s.aiMonthlyBudgetCents !== null) {
      const month = today.slice(0, 7);
      const spent =
        (
          await this.db.first<{ n: number | null }>("SELECT SUM(cost_cents) AS n FROM messages WHERE network_id = ? AND author_kind = 'ai' AND occurred_at >= ? AND occurred_at < ?", [
            networkId,
            parisDayStart(`${month}-01`).toISOString(),
            this.now().toISOString(),
          ])
        )?.n ?? 0;
      if (spent * 10_000 >= s.aiMonthlyBudgetCents * s.aiAlertBp && (await this.raise(networkId, `budget_ia:${month}`, 'budget_ia', { month, thresholdBp: s.aiAlertBp }))) made += 1;
    }
    // Baisse d'un indicateur : 7 derniers jours (jusqu'à la veille) contre les 28 précédents ; une fois par semaine.
    const week = addDays(today, 1 - weekdayOf(today));
    for (const indicator of INDICATORS) {
      const last7 = await this.countBetween(networkId, indicator, addDays(today, -7), today);
      const previous28 = await this.countBetween(networkId, indicator, addDays(today, -35), addDays(today, -7));
      if (isDrop(last7, previous28, s.dropAlertBp) && (await this.raise(networkId, `baisse:${indicator}:${week}`, 'baisse_indicateur', { indicator, last7, previous28, thresholdBp: s.dropAlertBp }))) made += 1;
    }
    // Échéance d'un document d'agent.
    if (this.documents) {
      for (const d of await this.documents.dueBy(networkId, addDays(today, s.documentNoticeDays))) {
        if (await this.raise(networkId, `document:${d.agentId}:${d.document}:${d.validUntil}`, 'document_agent', { agentId: d.agentId, document: d.document, validUntil: d.validUntil })) made += 1;
      }
    }
    return made;
  }

  /** Les alertes du réseau, des plus récentes aux plus anciennes : la direction seule [R16]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: PilotageAlert[] } | { ok: false; rule: 'R16'; code: string }> {
    const refusal = await this.refusal(viewer, 'pilotage_alerts');
    if (refusal) return refusal;
    const rows = await this.db.all<{ key: string; kind: PilotageAlert['kind']; data: string; created_at: string }>('SELECT key, kind, data, created_at FROM pilotage_alerts WHERE network_id = ? ORDER BY created_at DESC, key', [viewer.networkId]);
    return { ok: true, value: rows.map((r) => ({ key: r.key, kind: r.kind, data: JSON.parse(r.data) as Record<string, unknown>, createdAt: r.created_at })) };
  }
}

/** Le passage du planificateur : chaque jour à 6 h, heure de Paris. */
export function pilotageAlertsJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date; documents?: EcheancesDocumentsAgent | null } = {}): ScheduledJob {
  return {
    name: PILOTAGE_ALERTS_JOB,
    hours: [6],
    run: async () => {
      const a = new AlertesPilotage(db, journal, options);
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id')) await a.run(n.id);
    },
  };
}
