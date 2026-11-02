/**
 * Les paliers de la bascule des automatisations du site (S11, B04a) [R26].
 *
 * Chaque automatisation est en ombre (le site décide seul), à 10 % (le socle décide pour un envoi sur dix, tiré une fois
 * pour toutes d'après l'envoi), ou partout. Le socle n'envoie jamais rien lui-même : il dit au site si sa décision vaut.
 *
 * - Ombre vers 10 % : un geste de la direction, jamais avant 7 jours sans incident et assez de demandes, et seulement
 *   une fois le passage ouvert (`open`) : fermé par défaut, tant que le site ne lit pas la réponse et que la mention R06
 *   n'est pas alignée (B04).
 * - 10 % vers partout : de lui-même, après 7 jours sans incident et assez de décisions réellement prises par le socle.
 * - Retour en ombre : de lui-même, au premier écart non expliqué ou à la première panne ; le compte des 7 jours repart.
 *
 * Le journal ne porte que l'automatisation, les paliers et la nature de l'incident [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { Viewer } from '../acces/droits.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export type RolloutStage = 'shadow' | 'ten_percent' | 'everywhere';
export type RolloutIncident = 'unexplained_gap' | 'failure';
export const ROLLOUT_INCIDENTS: readonly RolloutIncident[] = ['unexplained_gap', 'failure'];

/** Durée de chaque palier. */
export const ROLLOUT_STAGE_DAYS = 7;
/** Sous ce nombre de demandes comptées, l'ombre ne prouve rien : on y reste. Réglage, décidé le 2026-11-02. */
export const ROLLOUT_MIN_REQUESTS = 20;
/** À 10 %, seuls les envois où le socle décide comptent ; sous ce nombre, on y reste. Réglage, décidé le 2026-11-02. */
export const ROLLOUT_MIN_DECISIONS = 5;
const TEN_PERCENT = 10;
const DAY_MS = 86_400_000;

export const ROLLOUT_STAGE_JOURNAL_TYPE = 'bascule.palier';
export const ROLLOUT_INCIDENT_JOURNAL_TYPE = 'bascule.retour_arriere';

interface RolloutRow {
  automation: string;
  stage: RolloutStage;
  stage_since: string;
  requests: number;
  last_incident_at: string | null;
  last_incident_kind: RolloutIncident | null;
}

export interface RolloutDecision {
  stage: RolloutStage;
  /** La décision du socle vaut-elle pour cet envoi ? Faux en ombre, toujours : le site reste seul maître [R26]. */
  decides: boolean;
  /** Le moment du palier, pour ne compter une demande que dans le palier où elle a été faite. */
  stageSince: string;
}

export interface RolloutView {
  automation: string;
  stage: RolloutStage;
  since: string | null;
  requests: number;
  /** Jours pleins restants avant que le palier puisse être quitté ; 0 sinon. */
  daysLeft: number;
  lastIncidentAt: string | null;
  lastIncidentKind: RolloutIncident | null;
}

export type AdvanceResult = { ok: true; stage: 'ten_percent' } | { ok: false; rule: 'R16' | 'R26'; code: string };

/** Le rang d'un envoi de 0 à 99, fixe : la même automatisation et la même référence donnent toujours le même rang. */
export async function rolloutBucket(automation: string, ref: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${automation}\n${ref}`));
  return new DataView(digest).getUint32(0) % 100;
}

export class PaliersBascule {
  private readonly now: () => Date;
  private readonly open: boolean;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; open?: boolean } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.open = options.open ?? false;
  }

  /** Le palier en vigueur pour cet envoi. La première demande ouvre l'ombre ; un palier de 10 % arrivé à terme passe partout. */
  async decide(networkId: string, automation: string, ref: string): Promise<RolloutDecision> {
    const row = await this.promoteIfDue(networkId, await this.ensure(networkId, automation));
    const decides = row.stage === 'everywhere' || (row.stage === 'ten_percent' && (await rolloutBucket(automation, ref)) < TEN_PERCENT);
    return { stage: row.stage, decides, stageSince: row.stage_since };
  }

  /** Compte une demande dans son palier ; sans effet si le palier a changé entre-temps. */
  async countRequest(networkId: string, automation: string, stageSince: string): Promise<void> {
    await this.db.run('UPDATE automation_rollouts SET requests = requests + 1 WHERE network_id = ? AND automation = ? AND stage_since = ?', [networkId, automation, stageSince]);
  }

  /** Un écart non expliqué ou une panne : retour en ombre, et le compte des 7 jours repart. Ne fait jamais monter. */
  async incident(networkId: string, automation: string, kind: RolloutIncident, rule: string | null, actor: string): Promise<RolloutStage> {
    const before = await this.ensure(networkId, automation);
    const at = this.now().toISOString();
    await this.db.run(
      `UPDATE automation_rollouts SET stage = 'shadow', stage_since = ?, requests = 0, last_incident_at = ?, last_incident_kind = ?
       WHERE network_id = ? AND automation = ?`,
      [at, at, kind, networkId, automation],
    );
    await appendEvent(
      this.journal,
      { type: ROLLOUT_INCIDENT_JOURNAL_TYPE, actor, subject: `network:${networkId}`, data: { automation, from: before.stage, to: 'shadow', kind, rule } },
      this.now,
    );
    return 'shadow';
  }

  /** Le geste de la direction : de l'ombre à 10 %, seulement si l'ombre a tenu [R26]. */
  async advance(viewer: Viewer, automation: string): Promise<AdvanceResult> {
    const denied = await this.denied(viewer, 'bascule.avancer', ['direction']);
    if (denied) return { ok: false, rule: 'R16', code: denied };
    if (!this.open) return { ok: false, rule: 'R26', code: 'not_open' };
    const row = await this.ensure(viewer.networkId, automation);
    if (row.stage !== 'shadow') return { ok: false, rule: 'R26', code: 'not_in_shadow' };
    if (!this.isDue(row)) return { ok: false, rule: 'R26', code: this.elapsed(row) ? 'not_enough_requests' : 'too_early' };
    const moved = await this.move(viewer.networkId, row, 'ten_percent', `${String(viewer.role)}:${viewer.userId}`);
    return moved ? { ok: true, stage: 'ten_percent' } : { ok: false, rule: 'R26', code: 'not_in_shadow' };
  }

  /** L'état des automatisations pour la direction et la conformité : des nombres et des dates, jamais une fiche. */
  async list(viewer: Viewer, automations: readonly string[]): Promise<{ ok: true; value: RolloutView[] } | { ok: false; rule: 'R16'; code: string }> {
    const denied = await this.denied(viewer, 'bascule.paliers', ['direction', 'compliance']);
    if (denied) return { ok: false, rule: 'R16', code: denied };
    const value: RolloutView[] = [];
    for (const automation of automations) {
      const row = await this.db.first<RolloutRow>('SELECT * FROM automation_rollouts WHERE network_id = ? AND automation = ?', [viewer.networkId, automation]);
      if (!row) {
        value.push({ automation, stage: 'shadow', since: null, requests: 0, daysLeft: ROLLOUT_STAGE_DAYS, lastIncidentAt: null, lastIncidentKind: null });
        continue;
      }
      const left = Date.parse(row.stage_since) + ROLLOUT_STAGE_DAYS * DAY_MS - this.now().getTime();
      value.push({
        automation,
        stage: row.stage,
        since: row.stage_since,
        requests: row.requests,
        daysLeft: row.stage === 'everywhere' ? 0 : Math.max(0, Math.ceil(left / DAY_MS)),
        lastIncidentAt: row.last_incident_at,
        lastIncidentKind: row.last_incident_kind,
      });
    }
    return { ok: true, value };
  }

  private async denied(viewer: Viewer, kind: string, roles: readonly string[]): Promise<string | null> {
    if (roles.includes(String(viewer.role))) return null;
    const code = 'role';
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return code;
  }

  private async ensure(networkId: string, automation: string): Promise<RolloutRow> {
    await this.db.run("INSERT OR IGNORE INTO automation_rollouts (network_id, automation, stage, stage_since, requests) VALUES (?, ?, 'shadow', ?, 0)", [networkId, automation, this.now().toISOString()]);
    const row = await this.db.first<RolloutRow>('SELECT * FROM automation_rollouts WHERE network_id = ? AND automation = ?', [networkId, automation]);
    if (!row) throw new Error('Palier introuvable.');
    return row;
  }

  private elapsed(row: RolloutRow): boolean {
    return this.now().getTime() - Date.parse(row.stage_since) >= ROLLOUT_STAGE_DAYS * DAY_MS;
  }

  private isDue(row: RolloutRow): boolean {
    return this.elapsed(row) && row.requests >= (row.stage === 'ten_percent' ? ROLLOUT_MIN_DECISIONS : ROLLOUT_MIN_REQUESTS);
  }

  private async promoteIfDue(networkId: string, row: RolloutRow): Promise<RolloutRow> {
    if (row.stage !== 'ten_percent' || !this.isDue(row)) return row;
    await this.move(networkId, row, 'everywhere', 'system:bascule');
    return this.ensure(networkId, row.automation);
  }

  /** Change de palier seulement si le palier lu est toujours celui en vigueur : un retour en ombre simultané l'emporte. */
  private async move(networkId: string, row: RolloutRow, to: RolloutStage, actor: string): Promise<boolean> {
    const { changes } = await this.db.run(
      'UPDATE automation_rollouts SET stage = ?, stage_since = ?, requests = 0 WHERE network_id = ? AND automation = ? AND stage = ? AND stage_since = ?',
      [to, this.now().toISOString(), networkId, row.automation, row.stage, row.stage_since],
    );
    if (changes !== 1) return false;
    await appendEvent(this.journal, { type: ROLLOUT_STAGE_JOURNAL_TYPE, actor, subject: `network:${networkId}`, data: { automation: row.automation, from: row.stage, to } }, this.now);
    return true;
  }
}
