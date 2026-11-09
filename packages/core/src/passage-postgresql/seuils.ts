/**
 * Les seuils du passage à PostgreSQL (HX66 ; Architecture technique, « Données » : « Le passage à PostgreSQL en Europe
 * se décide dès qu'un seuil est atteint » ; « Exigences de service », capacité ; Feuille de route, phase 4)
 * [R630, R631, R632].
 *
 * Un relevé lit trois mesures : les agents actifs (plus de 50), la taille de la base (plus de 5 Go) et le temps d'un
 * rapport du réseau (plus de 5 secondes). Chaque relevé est rangé et ne change plus ; une mesure absente ou en échec
 * est « inconnue », jamais « sous le seuil » [R630].
 *
 * Un seuil franchi rend l'état « à décider » et donne une seule alerte par seuil, lue par la direction à l'écran : rien
 * n'est envoyé. La direction dit « passer » ou « attendre » ; « attendre » vaut 90 jours, et un seuil franchi après la
 * décision la rend caduque. Rien ne bascule seul : le passage lui-même reste un geste de Shawez [R631].
 *
 * Jamais vu : pour chaque seuil pas encore franchi, le jour estimé où il le sera, tiré par moindres carrés des relevés
 * des 90 derniers jours ; dit « estimation », jamais une promesse [R632].
 *
 * Lecture prudente : la base est une seule pour tout le système, donc les mesures comptent toute la base (tous les
 * réseaux), pour avertir plus tôt et jamais plus tard ; aucune ligne d'un autre réseau n'en sort. Ces nombres couvrent
 * tous les réseaux : la direction du réseau qui exploite la plateforme, seule, relève, lit et décide ; la lecture est écrite au journal avant d'être rendue [R16]. Qui a relevé ou
 * décidé n'est qu'au journal : les tables ne portent aucune donnée personnelle.
 */
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const POSTGRES_THRESHOLDS = ['agents', 'taille', 'rapport'] as const;
export type PostgresThreshold = (typeof POSTGRES_THRESHOLDS)[number];

/** Les seuils du cahier : franchis quand la mesure les dépasse (« plus de »). 5 Go comptés en octets décimaux, le plus bas. */
export const POSTGRES_LIMITS: Readonly<Record<PostgresThreshold, number>> = { agents: 50, taille: 5_000_000_000, rapport: 5_000 };

/** Un relevé plus vieux que cela ne dit plus rien de la base : l'état n'est jamais « sous les seuils » sans relevé récent [R630]. */
export const POSTGRES_READING_FRESH_DAYS = 8;
/** « Attendre » vaut ce nombre de jours, puis l'état redevient « à décider » [R631]. */
export const POSTGRES_WAIT_DAYS = 90;
/** La prévision lit les relevés de cette fenêtre, en jours [R632]. */
export const POSTGRES_FORECAST_WINDOW_DAYS = 90;
/** Au moins tant de relevés, sur au moins tant de jours, pour une prévision [R632]. */
export const POSTGRES_FORECAST_MIN_POINTS = 3;
export const POSTGRES_FORECAST_MIN_SPAN_DAYS = 7;
/** Au-delà, la prévision ne donne pas de jour. */
export const POSTGRES_FORECAST_HORIZON_DAYS = 3650;

export const POSTGRES_CHOICES = ['passer', 'attendre'] as const;
export type PostgresChoice = (typeof POSTGRES_CHOICES)[number];

const DAY_MS = 86_400_000;

export type PassagePostgresqlRefusal = { ok: false; rule: 'R16'; code: 'role' | 'autre_reseau' } | { ok: false; rule: 'R631' | null; code: string };

export interface PostgresReading {
  id: string;
  measuredAt: string;
  source: 'direction' | 'passage';
  values: Record<PostgresThreshold, number | null>;
}

export interface PostgresForecast {
  /** Le jour de Paris estimé où la mesure dépassera le seuil ; nul quand aucune estimation honnête n'est possible. */
  date: string | null;
  /** La hausse estimée par jour ; nulle sans estimation. */
  perDay: number | null;
  points: number;
  /** Pourquoi il n'y a pas de jour : trop peu de relevés, pas de hausse, déjà franchi, ou au-delà de 10 ans. */
  reason: 'trop_peu' | 'sans_hausse' | 'franchi' | 'au_dela' | null;
}

export interface PostgresThresholdState {
  threshold: PostgresThreshold;
  limit: number;
  /** La mesure du dernier relevé ; nulle quand elle est inconnue. */
  value: number | null;
  /** Vrai au-delà du seuil, faux en deçà, nul quand la mesure est inconnue : jamais « sous le seuil » par défaut. */
  crossed: boolean | null;
  /** La première fois que ce seuil a été franchi ; nulle s'il ne l'a jamais été. */
  alertedAt: string | null;
  forecast: PostgresForecast;
}

export type PostgresStatus = 'inconnu' | 'sous_les_seuils' | 'a_decider' | 'attendre' | 'passage_decide';

export interface PostgresState {
  status: PostgresStatus;
  /** Pourquoi l'état est inconnu : aucun relevé, relevé trop vieux, ou une mesure inconnue. */
  unknownBecause: ('aucun_releve' | 'releve_ancien' | 'mesure_inconnue')[];
  lastReading: PostgresReading | null;
  thresholds: PostgresThresholdState[];
  decision: { version: number; choice: PostgresChoice; decidedAt: string; validUntil: string | null } | null;
}

interface Options {
  now?: () => Date;
  /** La taille de la base en octets ; sans elle, la taille est lue par `PRAGMA`, et inconnue si la base le refuse. */
  databaseBytes?: () => Promise<number | null>;
  /** Un rapport du réseau à chronométrer ; sans lui, le temps est inconnu. */
  networkReport?: () => Promise<unknown>;
  /** L'horloge du chronomètre, en millisecondes. */
  clockMs?: () => number;
  newId?: () => string;
  /**
   * Le réseau qui exploite la plateforme : la base est une pour tous les réseaux, donc seule sa direction relève, lit
   * des nombres de toute la base et décide du passage [R16]. Sans lui, tout est refusé.
   */
  platformNetworkId?: string;
}

/** Une mesure, ou pourquoi elle manque : en échec, ou pas branchée. */
type Measured = { value: number; cause: null } | { value: null; cause: 'echec' | 'non_branche' };

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;

/**
 * La tendance par moindres carrés des relevés d'un seuil, et le jour où elle dépasse la limite [R632]. Les points sont
 * des instants (ms) et des valeurs ; le jour rendu est celui de Paris. Nul avec moins de 3 points, sur moins de 7
 * jours, sans hausse, ou au-delà de 10 ans ; « franchi » quand le dernier point dépasse déjà la limite. Le jour n'est
 * jamais avant `nowMs` : une droite qui a déjà passé la limite sans relevé au-delà dit « aujourd'hui ».
 */
export function forecastCrossing(points: readonly { atMs: number; value: number }[], limit: number, nowMs: number): PostgresForecast {
  const sorted = [...points].sort((a, b) => a.atMs - b.atMs);
  const n = sorted.length;
  const last = sorted[n - 1];
  if (last && last.value > limit) return { date: null, perDay: null, points: n, reason: 'franchi' };
  if (n < POSTGRES_FORECAST_MIN_POINTS || !last) return { date: null, perDay: null, points: n, reason: 'trop_peu' };
  const t0 = sorted[0]!.atMs;
  const xs = sorted.map((p) => (p.atMs - t0) / DAY_MS);
  const xLast = xs[n - 1]!;
  if (xLast < POSTGRES_FORECAST_MIN_SPAN_DAYS) return { date: null, perDay: null, points: n, reason: 'trop_peu' };
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = sorted.reduce((a, p) => a + p.value, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i]! - meanX) * (sorted[i]!.value - meanY);
    sxx += (xs[i]! - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  if (!(slope > 0)) return { date: null, perDay: null, points: n, reason: 'sans_hausse' };
  const intercept = meanY - slope * meanX;
  // Le jour où la droite atteint la limite ; s'il est déjà passé alors que le dernier relevé est en deçà, c'est le jour
  // du dernier relevé : la tendance dit « maintenant », jamais une date dans le passé.
  const xNow = Math.max((nowMs - t0) / DAY_MS, xLast);
  const at = Math.max((limit - intercept) / slope, xNow);
  if (at - xNow > POSTGRES_FORECAST_HORIZON_DAYS) return { date: null, perDay: slope, points: n, reason: 'au_dela' };
  return { date: localTime(new Date(t0 + Math.ceil(at * DAY_MS)), 'Europe/Paris').date, perDay: slope, points: n, reason: null };
}

export class PassagePostgresql {
  private readonly now: () => Date;
  private readonly clockMs: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly options: Options = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.clockMs = options.clockMs ?? (() => performance.now());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /**
   * La direction du réseau qui exploite la plateforme, seule ; tout autre rôle, et la direction d'un autre réseau de la
   * même base, sont refusés et le refus écrit au journal [R16]. Sans réseau de la plateforme réglé, tout est refusé.
   */
  private async direction(viewer: Viewer, kind: string): Promise<PassagePostgresqlRefusal | null> {
    const code = viewer.role !== 'direction' ? 'role' : this.options.platformNetworkId && viewer.networkId === this.options.platformNetworkId ? null : 'autre_reseau';
    if (code === null) return null;
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  private async refuse(viewer: Viewer, refusal: PassagePostgresqlRefusal): Promise<PassagePostgresqlRefusal> {
    await appendEvent(this.journal, { type: 'postgresql.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: refusal.rule, code: refusal.code } }, this.now);
    return refusal;
  }

  /** Les agents actifs de toute la base : actifs, sans départ maintenu déjà arrivé. Nul si la lecture échoue [R630]. */
  private async agentsActive(): Promise<Measured> {
    try {
      const today = localTime(this.now(), 'Europe/Paris').date;
      const row = await this.db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM agents a
          WHERE a.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM agent_departures d WHERE d.agent_id = a.id AND d.cancelled_at IS NULL AND d.leaves_on <= ?)`,
        [today],
      );
      const n = Number(row?.n);
      return isCount(n) ? { value: n, cause: null } : { value: null, cause: 'echec' };
    } catch {
      return { value: null, cause: 'echec' };
    }
  }

  private async databaseBytes(): Promise<Measured> {
    try {
      const bytes = this.options.databaseBytes
        ? await this.options.databaseBytes()
        : Number((await this.db.first<{ bytes: number }>('SELECT c.page_count * s.page_size AS bytes FROM pragma_page_count() c, pragma_page_size() s'))?.bytes);
      return isCount(bytes) ? { value: bytes, cause: null } : { value: null, cause: 'echec' };
    } catch {
      return { value: null, cause: 'echec' };
    }
  }

  private async reportMs(): Promise<Measured> {
    const report = this.options.networkReport;
    if (!report) return { value: null, cause: 'non_branche' };
    try {
      const start = this.clockMs();
      await report();
      const ms = Math.ceil(this.clockMs() - start);
      return isCount(ms) ? { value: ms, cause: null } : { value: null, cause: 'echec' };
    } catch {
      // Un rapport en échec ne dit pas qu'il est rapide : la mesure est inconnue [R630], et la cause est au journal.
      return { value: null, cause: 'echec' };
    }
  }

  private async measure(source: 'direction' | 'passage', actor: string, subject: string): Promise<PostgresReading> {
    const measured: Record<PostgresThreshold, Measured> = { agents: await this.agentsActive(), taille: await this.databaseBytes(), rapport: await this.reportMs() };
    const values: Record<PostgresThreshold, number | null> = { agents: measured.agents.value, taille: measured.taille.value, rapport: measured.rapport.value };
    const unknown = Object.fromEntries(POSTGRES_THRESHOLDS.filter((t) => measured[t].cause !== null).map((t) => [t, measured[t].cause as string]));
    const reading: PostgresReading = { id: this.newId(), measuredAt: this.now().toISOString(), source, values };
    const statements: SqlStatement[] = [
      {
        // L'ordre est pris dans la même instruction : deux relevés du même instant restent dans leur ordre [R630].
        sql: 'INSERT INTO postgres_threshold_readings (id, seq, measured_at, agents_active, db_bytes, elapsed_ms, source) SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ? FROM postgres_threshold_readings',
        params: [reading.id, reading.measuredAt, values.agents, values.taille, values.rapport, source],
      },
    ];
    const crossed = POSTGRES_THRESHOLDS.filter((t) => values[t] !== null && (values[t] as number) > POSTGRES_LIMITS[t]);
    // Une seule alerte par seuil : la première fois seulement, en SQL que PostgreSQL lit tel quel [R631].
    for (const t of crossed) {
      statements.push({ sql: 'INSERT INTO postgres_threshold_alerts (threshold, reading_id, created_at) VALUES (?, ?, ?) ON CONFLICT (threshold) DO NOTHING', params: [t, reading.id, reading.measuredAt] });
    }
    const results = await runBatch(this.db, statements);
    const alerted = crossed.filter((_, i) => (results[i + 1]?.changes ?? 0) > 0);
    await appendEvent(
      this.journal,
      { type: 'postgresql.releve', actor, subject, data: { readingId: reading.id, source, agents: values.agents, taille: values.taille, rapport: values.rapport, unknown, crossed, alerted } },
      this.now,
    );
    return reading;
  }

  /** Un relevé demandé par la direction [R630, R16]. */
  async measureNow(viewer: Viewer): Promise<{ ok: true; value: PostgresReading } | PassagePostgresqlRefusal> {
    const denied = await this.direction(viewer, 'postgres_measure');
    if (denied) return denied;
    return { ok: true, value: await this.measure('direction', this.actor(viewer), `network:${viewer.networkId}`) };
  }

  /** Le relevé du passage planifié, sans personne ; son branchement au planificateur est une tâche de la voie 1. */
  async measureScheduled(): Promise<PostgresReading> {
    return this.measure('passage', 'systeme:passage', 'base');
  }

  /** La direction dit « passer » ou « attendre », seulement quand un seuil a été franchi ; rien ne bascule seul [R631]. */
  async decide(viewer: Viewer, choice: unknown): Promise<{ ok: true; value: { version: number; choice: PostgresChoice; decidedAt: string } } | PassagePostgresqlRefusal> {
    const denied = await this.direction(viewer, 'postgres_decision');
    if (denied) return denied;
    if (typeof choice !== 'string' || !(POSTGRES_CHOICES as readonly string[]).includes(choice)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_choice' });
    const alert = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM postgres_threshold_alerts');
    const alertsSeen = Number(alert?.n ?? 0);
    if (alertsSeen === 0) return this.refuse(viewer, { ok: false, rule: 'R631', code: 'aucun_seuil' });
    const last = await this.db.first<{ version: number | null }>('SELECT MAX(version) AS version FROM postgres_decisions');
    const version = Number(last?.version ?? 0) + 1;
    const decidedAt = this.now().toISOString();
    try {
      // La décision porte le nombre d'alertes vues : la base la refuse si un seuil a été franchi entre-temps [R631].
      await this.db.run('INSERT INTO postgres_decisions (version, choice, decided_at, alerts_seen) VALUES (?, ?, ?, ?)', [version, choice, decidedAt, alertsSeen]);
    } catch (error) {
      // Une autre décision est passée entre la lecture et l'écriture : rien n'est rangé. Toute autre erreur est écrite
      // au journal et remonte, jamais déguisée en conflit.
      const now = await this.db.first<{ version: number | null }>('SELECT MAX(version) AS version FROM postgres_decisions');
      if (Number(now?.version ?? 0) >= version) return this.refuse(viewer, { ok: false, rule: 'R631', code: 'conflit' });
      const alertsNow = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM postgres_threshold_alerts');
      if (Number(alertsNow?.n ?? 0) !== alertsSeen) return this.refuse(viewer, { ok: false, rule: 'R631', code: 'nouveau_seuil' });
      await appendEvent(this.journal, { type: 'postgresql.erreur', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { kind: 'postgres_decision', code: 'ecriture' } }, this.now);
      throw error;
    }
    await appendEvent(this.journal, { type: 'postgresql.decision', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { version, choice } }, this.now);
    return { ok: true, value: { version, choice: choice as PostgresChoice, decidedAt } };
  }

  /** L'état des seuils, leurs alertes, la décision en cours et la prévision de chaque seuil, pour la direction seule. */
  async state(viewer: Viewer): Promise<{ ok: true; value: PostgresState } | PassagePostgresqlRefusal> {
    const denied = await this.direction(viewer, 'postgres_state');
    if (denied) return denied;
    const now = this.now();
    const rows = await this.db.all<{ id: string; measured_at: string; agents_active: number | null; db_bytes: number | null; elapsed_ms: number | null; source: 'direction' | 'passage' }>(
      'SELECT id, measured_at, agents_active, db_bytes, elapsed_ms, source FROM postgres_threshold_readings WHERE measured_at >= ? ORDER BY seq',
      [new Date(now.getTime() - POSTGRES_FORECAST_WINDOW_DAYS * DAY_MS).toISOString()],
    );
    const lastRow = await this.db.first<{ id: string; measured_at: string; agents_active: number | null; db_bytes: number | null; elapsed_ms: number | null; source: 'direction' | 'passage' }>(
      'SELECT id, measured_at, agents_active, db_bytes, elapsed_ms, source FROM postgres_threshold_readings ORDER BY seq DESC LIMIT 1',
    );
    const num = (v: number | null): number | null => (v === null ? null : Number(v));
    const lastReading: PostgresReading | null = lastRow
      ? { id: lastRow.id, measuredAt: lastRow.measured_at, source: lastRow.source, values: { agents: num(lastRow.agents_active), taille: num(lastRow.db_bytes), rapport: num(lastRow.elapsed_ms) } }
      : null;
    const alerts = await this.db.all<{ threshold: PostgresThreshold; created_at: string }>('SELECT threshold, created_at FROM postgres_threshold_alerts ORDER BY created_at');
    const column: Record<PostgresThreshold, 'agents_active' | 'db_bytes' | 'elapsed_ms'> = { agents: 'agents_active', taille: 'db_bytes', rapport: 'elapsed_ms' };

    const thresholds: PostgresThresholdState[] = POSTGRES_THRESHOLDS.map((t) => {
      const value = lastReading ? lastReading.values[t] : null;
      const alertedAt = alerts.find((a) => a.threshold === t)?.created_at ?? null;
      const points = rows.filter((r) => r[column[t]] !== null).map((r) => ({ atMs: Date.parse(r.measured_at), value: Number(r[column[t]]) }));
      return {
        threshold: t,
        limit: POSTGRES_LIMITS[t],
        value,
        crossed: value === null ? null : value > POSTGRES_LIMITS[t],
        alertedAt,
        // Un seuil déjà franchi une fois attend une décision : il n'a plus de jour à prévoir [R632].
        forecast: alertedAt !== null ? { date: null, perDay: null, points: points.length, reason: 'franchi' } : forecastCrossing(points, POSTGRES_LIMITS[t], now.getTime()),
      };
    });

    const d = await this.db.first<{ version: number; choice: PostgresChoice; decided_at: string; alerts_seen: number }>('SELECT version, choice, decided_at, alerts_seen FROM postgres_decisions ORDER BY version DESC LIMIT 1');
    const decision = d
      ? {
          version: Number(d.version),
          choice: d.choice,
          decidedAt: d.decided_at,
          validUntil: d.choice === 'attendre' ? new Date(Date.parse(d.decided_at) + POSTGRES_WAIT_DAYS * DAY_MS).toISOString() : null,
        }
      : null;

    const unknownBecause: PostgresState['unknownBecause'] = [];
    if (!lastReading) unknownBecause.push('aucun_releve');
    else {
      if (now.getTime() - Date.parse(lastReading.measuredAt) > POSTGRES_READING_FRESH_DAYS * DAY_MS) unknownBecause.push('releve_ancien');
      if (POSTGRES_THRESHOLDS.some((t) => lastReading.values[t] === null)) unknownBecause.push('mesure_inconnue');
    }
    const lastAlertAt = alerts.reduce<string | null>((acc, a) => (acc === null || a.created_at > acc ? a.created_at : acc), null);
    let status: PostgresStatus;
    if (decision?.choice === 'passer') status = 'passage_decide';
    else if (lastAlertAt !== null) {
      // « Attendre » ne vaut que pour les seuils déjà franchis quand il a été dit, et 90 jours au plus [R631].
      // Elle couvre les alertes qu'elle a vues, comptées dans la base, jamais devinées par l'instant.
      const waiting = decision?.choice === 'attendre' && Number(d?.alerts_seen) === alerts.length && decision.validUntil !== null && now.toISOString() < decision.validUntil;
      status = waiting ? 'attendre' : 'a_decider';
    } else status = unknownBecause.length > 0 ? 'inconnu' : 'sous_les_seuils';

    const value: PostgresState = { status, unknownBecause, lastReading, thresholds, decision };
    // La lecture est écrite au journal avant d'être rendue [R16].
    await appendEvent(this.journal, { type: 'postgresql.etat_lu', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', status } }, this.now);
    return { ok: true, value };
  }
}
